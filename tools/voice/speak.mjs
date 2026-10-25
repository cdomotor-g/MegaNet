// tools/voice/speak.mjs — the Droggies' own voices for a network bulletin.
//
// Turns a published bulletin (data/bulletins/<kind>/<date>.json) into one MP3
// and a voice file beside it in data/bulletins/voice/<kind>/: every scene said
// by its presenter in the voice the Droggies' cast file gives them, with the
// time each word starts, so the player (health-bulletin.js) can reveal the
// narration as it is said.
//
// The cast lives with the characters, in github.com/cdomotor-g/thedroggies
// (voices/cast.json), and is read from that repository's published site each
// run — recasting a Droggie there recasts the next bulletin here. Speech comes
// from the ElevenLabs API with the key held as the ELEVENLABS_API_KEY secret
// of .github/workflows/bulletin-voice.yml, which runs this after every push of
// a bulletin; nothing here runs in the browser.
//
//   node tools/voice/speak.mjs --pending          voice every bulletin whose voice is missing or out of
//                                                 date, and let go of voices whose bulletin has gone
//   node tools/voice/speak.mjs FILE.json          voice one bulletin (--force: even if up to date)
//   node tools/voice/speak.mjs --sample LINES.json --out DIR
//                                                 say casting test lines: [{ name, voice_id, model, text, settings }]
//   --cast PATH|URL   the cast file (default: the published thedroggies one)
//   --lexicon PATH    Flood-Net's own pronunciations, added to the cast's (default: tools/voice/lexicon.json)
//   --dry-run         say what would be voiced and about what it costs; call nothing
//
// Each run says how many ElevenLabs credits it used and how many are left this
// month (the account the key belongs to). Exits 1 if any bulletin could not be
// voiced; the others are still written.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VOICE_FORMAT, voicePathFor } from '../bulletin/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
export const CAST_URL = 'https://cdomotor-g.github.io/thedroggies/voices/cast.json';
const LEXICON = path.join(HERE, 'lexicon.json');
const API = 'https://api.elevenlabs.io/v1';
const RATE = 44100;                 // samples a second, mono, throughout
const GAP = 0.45;                   // seconds of quiet between scenes
const BITRATE = '48k';              // speech, mono: about 0.36 MB a minute
// Every scene as loud as every other, whoever says it — the voices come out of
// ElevenLabs up to 3 LU apart — at the podcast standard, peaks under -1.5 dBTP.
const LOUD = { I: -16, TP: -1.5, LRA: 11 };
// Models that act out bracketed directions ("[slowly]"); on the others a
// direction would be read aloud, so it is left off.
const TAG_MODELS = new Set(['eleven_v4', 'eleven_v4_turbo', 'eleven_v3']);
// Credits a character of text costs on each model, as the API charged them in
// October 2026 (its character-cost header): the Turbo and Flash models half
// the rest. For --dry-run only; a real run logs what it actually used.
const RATE_OF = model => /turbo|flash|conversational/.test(model) ? 0.2 : 0.4;
let spent = 0;                      // credits this run, by ElevenLabs' count for each request

// ── the cast ────────────────────────────────────────────────────────────────

export async function readCast(src = CAST_URL) {
  const cast = /^https?:/.test(src)
    ? await (async () => { const r = await fetch(src, { cache: 'no-store' }); if (!r.ok) throw new Error(`${src} answered ${r.status}`); return r.json(); })()
    : JSON.parse(fs.readFileSync(src, 'utf8'));
  if (!cast || typeof cast.voices !== 'object') throw new Error('the cast file has no voices');
  for (const [id, v] of Object.entries(cast.voices)) {
    if (!v.voice_id || !v.model) throw new Error(`the cast file's ${id} has no voice_id or model`);
  }
  return cast;
}

// Flood-Net's own words said differently from how they are spelt — station
// names above all, which are Flood-Net's, not the Droggies' — added to the
// cast's lexicon, a word in both taking Flood-Net's.
export function withLexicon(cast, file = LEXICON) {
  const own = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  if (!Array.isArray(own)) throw new Error(`${file} is not a list of { word, say }`);
  const words = new Set(own.map(e => String(e.word || '').toLowerCase()));
  return { ...cast, lexicon: [...(cast.lexicon || []).filter(e => !words.has(String(e.word || '').toLowerCase())), ...own] };
}

// A radio frequency as a technician says it, not as a number: 152.400 is
// "one fifty-two point four", never "one hundred and fifty-two point four
// hundred". Only the register's form, three digits and three decimals.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
export function frequencyWords(f) {
  const m = /^([1-9])(\d\d)\.(\d{3})$/.exec(f);
  if (!m) return null;
  const r = +m[2];
  const whole = `${ONES[+m[1]]} ${r === 0 ? 'hundred' : r < 10 ? `oh ${ONES[r]}` : r < 20 ? TEENS[r - 10] : TENS[Math.floor(r / 10)] + (r % 10 ? `-${ONES[r % 10]}` : '')}`;
  const dec = m[3].replace(/0+$/, '');
  return dec ? `${whole} point ${[...dec].map(d => (d === '0' ? 'oh' : ONES[+d])).join(' ')}` : whole;
}

// What a voice says for a scene: its direction (on models that act it), then
// the narration word by word, each word swapped for the lexicon's respelling
// of it where it has one ({ word, say }: "Goomburra" said as written in
// "say") and a frequency for the way it is said. Keeps where each of the
// narration's words starts in the text sent, so the API's per-character
// timing can be read back per word.
export function scriptFor(say, voice, cast) {
  const words = String(say || '').split(/\s+/).filter(Boolean);
  const tags = TAG_MODELS.has(voice.model);
  const lex = new Map((cast.lexicon || []).filter(e => e && e.word && e.say).map(e => [String(e.word).toLowerCase(), e.say]));
  let text = tags && voice.direction ? voice.direction.trim() + ' ' : '';
  const offsets = [];
  for (const w of words) {
    const m = /^([^\p{L}\p{N}]*)([\p{L}\p{N}'’-]+(?:\.\p{N}+)*)([^\p{L}\p{N}]*)$/u.exec(w);
    const core = m && (lex.get(m[2].toLowerCase()) || frequencyWords(m[2]));
    const said = core ? m[1] + core + m[3] : w;
    offsets.push(text.length);
    text += said + ' ';
  }
  return { text: text.trimEnd(), words, offsets };
}

const speakerOf = (b, s) => (s && s.presenter) || b.presenter;

// Everything that changes what a bulletin sounds like: the words, who says
// them, and the voices as cast. A voice file whose hash still matches is left.
export function hashFor(b, cast) {
  const used = [...new Set((b.scenes || []).map(s => speakerOf(b, s)))].sort();
  const voices = Object.fromEntries(used.map(id => [id, cast.voices[id] || null]));
  const body = JSON.stringify({ f: VOICE_FORMAT, scenes: (b.scenes || []).map(s => [speakerOf(b, s), s.say]),
    voices, lexicon: cast.lexicon || [], defaults: cast.defaults || {} });
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
}

// ── ElevenLabs ──────────────────────────────────────────────────────────────

async function tts(voice, text, cast, { key, prevText, nextText }) {
  const fmt = (cast.defaults && cast.defaults.output_format) || 'mp3_44100_64';
  const settings = Object.assign({}, (cast.defaults && cast.defaults.settings) || {}, voice.settings || {});
  // No settings: the voice's own, which is what the cast was auditioned on.
  const body = { text, model_id: voice.model };
  if (Object.keys(settings).length) body.voice_settings = settings;
  if (Number.isInteger(voice.seed)) body.seed = voice.seed;
  if (prevText) body.previous_text = prevText;
  if (nextText) body.next_text = nextText;
  const url = `${API}/text-to-speech/${encodeURIComponent(voice.voice_id)}/with-timestamps?output_format=${encodeURIComponent(fmt)}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) {
      const j = await res.json();
      const cost = +(res.headers.get('character-cost') || res.headers.get('x-character-count') || 0) || null;
      spent += cost || text.length * RATE_OF(voice.model);
      return { audio: Buffer.from(j.audio_base64, 'base64'), alignment: j.alignment || j.normalized_alignment, cost, request: res.headers.get('request-id') };
    }
    const detail = (await res.text()).slice(0, 400);
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await new Promise(r => setTimeout(r, 2000 * 2 ** (attempt - 1))); continue; }
    throw new Error(`ElevenLabs answered ${res.status} for ${voice.voice_name || voice.voice_id}: ${detail}`);
  }
}

// The account's credits this month: used, allowed, and when they start again.
// Null if the key may not see them; nothing depends on it.
export async function credits(key) {
  try {
    const res = await fetch(`${API}/user/subscription`, { headers: { 'xi-api-key': key, accept: 'application/json' } });
    if (!res.ok) return null;
    const j = await res.json();
    return Number.isFinite(j.character_count) ? { used: j.character_count, limit: j.character_limit, tier: j.tier,
      resets: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString().slice(0, 10) : null } : null;
  } catch (_) { return null; }
}

// ── audio ───────────────────────────────────────────────────────────────────

function ffmpeg(args, input) {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { input, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${String(r.stderr || '').slice(0, 300)}`);
  return r.stdout;
}
const toPcm = mp3 => ffmpeg(['-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(RATE), 'pipe:1'], mp3);
const toMp3 = pcm => ffmpeg(['-f', 's16le', '-ac', '1', '-ar', String(RATE), '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-b:a', BITRATE, '-f', 'mp3', 'pipe:1'], pcm);
// A voice the cast plays faster or slower ("tempo": 1.1 is a tenth faster),
// stretched after it is said with its pitch kept — the model's own speed
// setting changes the voice as well as the pace.
export const tempoOf = voice => (Number.isFinite(voice && voice.tempo) && voice.tempo >= 0.5 && voice.tempo <= 2 ? voice.tempo : 1);
const stretch = (pcm, tempo) => (tempo === 1 ? pcm
  : ffmpeg(['-f', 's16le', '-ac', '1', '-ar', String(RATE), '-i', 'pipe:0', '-filter:a', `atempo=${tempo}`, '-f', 's16le', '-ac', '1', '-ar', String(RATE), 'pipe:1'], pcm));
// A scene brought to LOUD: measured, then one gain for all of it (loudnorm's
// linear mode), so the voice keeps its own rise and fall. The same length out
// as in — loudnorm works at 192 kHz, and the way back can be a sample out.
export function level(pcm) {
  const input = ['-f', 's16le', '-ac', '1', '-ar', String(RATE), '-i', 'pipe:0'];
  const target = `I=${LOUD.I}:TP=${LOUD.TP}:LRA=${LOUD.LRA}`;
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...input, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'],
    { input: pcm, maxBuffer: 64 * 1024 * 1024 });
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(String(probe.stderr || ''));
  const j = probe.status === 0 && m ? JSON.parse(m[0]) : null;
  if (!j || !(+j.input_i > -70)) return pcm;          // silence, or unmeasurable: as it is
  const out = ffmpeg([...input, '-af', `loudnorm=${target}:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}`
    + `:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`, '-f', 's16le', '-ac', '1', '-ar', String(RATE), 'pipe:1'], pcm);
  return out.length === pcm.length ? out : out.length > pcm.length ? out.subarray(0, pcm.length) : Buffer.concat([out, Buffer.alloc(pcm.length - out.length)]);
}
const round = t => Math.round(t * 100) / 100;

// The time each of the narration's words starts, read off the API's timing of
// every character it was sent (and a stretched voice's timing stretched too).
export function wordTimes(script, alignment, offset, tempo = 1) {
  const starts = (alignment && alignment.character_start_times_seconds) || [];
  return script.offsets.map((o, k) => {
    let t = starts[o];
    for (let j = o; t == null && j < starts.length; j++) t = starts[j];
    if (t == null) t = starts.length ? starts[starts.length - 1] : k * 0.3;
    return round(offset + t / tempo);
  });
}

// ── one bulletin ────────────────────────────────────────────────────────────

export async function voiceBulletin(file, cast, { key, castSrc, repo = REPO, dry = false, log = console.log } = {}) {
  const b = JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
  const scenes = b.scenes || [];
  const missing = [...new Set(scenes.map(s => speakerOf(b, s)))].filter(id => !cast.voices[id]);
  if (missing.length) throw new Error(`${file}: no voice cast for ${missing.join(', ')}`);
  const scripts = scenes.map(s => { const v = cast.voices[speakerOf(b, s)]; return { v, ...scriptFor(s.say, v, cast) }; });
  if (dry) {
    const by = {};
    scripts.forEach(x => { by[x.v.model] = (by[x.v.model] || 0) + x.text.length; });
    const est = Object.entries(by).reduce((n, [m, c]) => n + c * RATE_OF(m), 0);
    log(`  ${file}: ${scripts.length} scenes, ${Object.entries(by).map(([m, c]) => `${c} characters on ${m}`).join(', ')} — about ${Math.round(est)} credits`);
    return { file, dry: true, credits: est };
  }
  const pcm = [], out = [];
  let at = 0, cost = 0;
  for (let i = 0; i < scripts.length; i++) {
    const x = scripts[i], s = scenes[i];
    const prev = scenes[i - 1] && speakerOf(b, scenes[i - 1]) === speakerOf(b, s) ? scenes[i - 1].say : null;
    const next = scenes[i + 1] && speakerOf(b, scenes[i + 1]) === speakerOf(b, s) ? scenes[i + 1].say : null;
    const r = await tts(x.v, x.text, cast, { key, prevText: prev, nextText: next });
    const tempo = tempoOf(x.v);
    const p = level(stretch(toPcm(r.audio), tempo));
    const secs = p.length / 2 / RATE;
    // Never a word after its scene ends: the stretch rounds, the timing does not.
    out.push({ speaker: speakerOf(b, s), voice: x.v.voice_name || x.v.voice_id, model: x.v.model,
      start: round(at), end: round(at + secs), words: wordTimes(x, r.alignment, at, tempo).map(t => Math.min(t, round(at + secs))) });
    pcm.push(p);
    at += secs;
    if (i < scripts.length - 1) { pcm.push(Buffer.alloc(Math.round(GAP * RATE) * 2)); at += GAP; }
    cost += r.cost || x.text.length;
    log(`    scene ${i + 1}/${scripts.length}: ${out[i].voice}, ${secs.toFixed(1)} s${r.cost ? `, ${r.cost} characters` : ''}`);
  }
  const mp3 = toMp3(Buffer.concat(pcm));
  const { json: vRel, audio: aRel } = voicePathFor(file);
  fs.mkdirSync(path.join(repo, path.dirname(vRel)), { recursive: true });
  fs.writeFileSync(path.join(repo, aRel), mp3);
  const doc = { format: VOICE_FORMAT, bulletin: b.id, file, audio: aRel, bytes: mp3.length, duration: round(at),
    hash: hashFor(b, cast), generated_at: new Date().toISOString(),
    cast: { source: castSrc || CAST_URL, updated: cast.updated || null }, scenes: out };
  fs.writeFileSync(path.join(repo, vRel), JSON.stringify(doc, null, 1) + '\n');
  log(`  ${file} → ${aRel}: ${doc.duration} s, ${(mp3.length / 1e6).toFixed(2)} MB, about ${Math.round(cost)} characters`);
  return { file, voice: vRel, audio: aRel, cost };
}

// Which bulletins need voicing, and which voices have lost their bulletin
// (publish.mjs lets the oldest bulletins go; their voices go with them).
export function pending(cast, { repo = REPO, force = [] } = {}) {
  const todo = [], orphans = [];
  for (const kind of ['daily', 'weekly']) {
    const dir = path.join(repo, 'data', 'bulletins', kind);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
    for (const f of files) {
      const rel = `data/bulletins/${kind}/${f}`;
      const vp = path.join(repo, voicePathFor(rel).json);
      let stale = !fs.existsSync(vp) || force.includes('all') || force.includes(rel);
      if (!stale) {
        try { const v = JSON.parse(fs.readFileSync(vp, 'utf8')); stale = v.hash !== hashFor(JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8')), cast); }
        catch (_) { stale = true; }
      }
      if (stale) todo.push(rel);
    }
    const vdir = path.join(repo, 'data', 'bulletins', 'voice', kind);
    for (const f of fs.existsSync(vdir) ? fs.readdirSync(vdir) : []) {
      const date = f.replace(/\.(json|mp3)$/, '');
      if (!files.includes(`${date}.json`)) orphans.push(`data/bulletins/voice/${kind}/${f}`);
    }
  }
  return { todo, orphans };
}

// ── casting test lines ──────────────────────────────────────────────────────

async function sample(linesFile, outDir, { key, log = console.log }) {
  const lines = JSON.parse(fs.readFileSync(linesFile, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  for (const l of lines) {
    const voice = { voice_id: l.voice_id, model: l.model, settings: l.settings, voice_name: l.name, tempo: l.tempo };
    const r = await tts(voice, l.text, { defaults: {} }, { key });
    const tempo = tempoOf(voice), pcm = level(stretch(toPcm(r.audio), tempo));
    fs.writeFileSync(path.join(outDir, `${l.name}.mp3`), toMp3(pcm));
    fs.writeFileSync(path.join(outDir, `${l.name}.json`), JSON.stringify({ ...l, cost: r.cost, request: r.request, alignment: r.alignment }, null, 1));
    log(`  ${l.name}: ${l.model}${tempo === 1 ? '' : ` at ${tempo}×`}, ${(pcm.length / 2 / RATE).toFixed(1)} s${r.cost ? `, ${r.cost} characters` : ''}`);
  }
}

// ── command line ────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const dry = argv.includes('--dry-run');
  const key = process.env.ELEVENLABS_API_KEY || '';
  if (!dry && !key) { console.error('ELEVENLABS_API_KEY is not set — the workflow passes it from the repository secret.'); process.exit(2); }
  // What the run spent and what is left, from the account's total as the run
  // began and the count ElevenLabs gives each request: the account's own total
  // catches up only a minute or so after the last request.
  const before = dry ? null : await credits(key);
  const tally = async () => {
    if (!before) return;
    const n = v => Math.round(v).toLocaleString('en-AU'), left = before.limit - before.used - spent;
    console.log(`ElevenLabs (${before.tier}): this run used ${n(spent)} credits; about ${n(left)} of ${n(before.limit)} left this month${before.resets ? `, until ${before.resets}` : ''}.`);
    if (left < 6000) console.log(`::warning title=ElevenLabs credits::About ${n(left)} credits left this month, and a bulletin takes about 1,200. Once they run out the bulletins play silent — upgrade or top up at elevenlabs.io.`);
  };
  try {
    if (arg('--sample')) { await sample(arg('--sample'), arg('--out') || 'voice-samples', { key }); await tally(); process.exit(0); }
    const castSrc = arg('--cast') || CAST_URL;
    const cast = withLexicon(await readCast(castSrc), arg('--lexicon') || LEXICON);
    console.log(`Cast: ${castSrc} (updated ${cast.updated || 'unknown'}), ${Object.keys(cast.voices).length} voices.`);
    let files;
    if (argv.includes('--pending')) {
      const force = (arg('--force') || '').split(',').map(s => s.trim()).filter(Boolean);
      const { todo, orphans } = pending(cast, { force });
      for (const o of orphans) { if (!dry) fs.unlinkSync(path.join(REPO, o)); console.log(`  ${dry ? 'would let go of' : 'let go of'} ${o}`); }
      files = todo;
      if (!files.length) console.log('Every bulletin is voiced and up to date.');
    } else {
      files = argv.filter(a => a.endsWith('.json') && a !== arg('--cast') && a !== arg('--lexicon'));
      if (!files.length) { console.error('node tools/voice/speak.mjs (--pending | FILE.json) [--cast PATH|URL] [--dry-run] [--force]'); process.exit(2); }
    }
    let failed = 0;
    for (const f of files) {
      const rel = argv.includes('--pending') ? f : path.relative(REPO, path.resolve(f));
      try { await voiceBulletin(rel, cast, { key, castSrc, dry }); }
      catch (err) { failed++; console.error(`  ${f}: not voiced — ${err.message}`); }
    }
    if (files.length) await tally();
    process.exit(failed ? 1 : 0);
  } catch (err) { console.error(err.message); process.exit(1); }
}
