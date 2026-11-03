// 🎬 Videos — the Videos tab (explainers.js), the player it shares with the
// Network Bulletin (makeShowPlayer, health-bulletin.js), what a video may
// hold (tools/explainers/validate.mjs) and how one is voiced
// (tools/voice/speak.mjs) — EPIC #262, #263.
//
// Node first, no network:
//
//   * every video published in data/explainers/ is one the page can play:
//     valid, its tabs in TABS and its stations on file, the index exactly what
//     the files make it, every voice file its video's scene for scene and word
//     for word with its MP3 and its kept scenes beside it, and nothing kept
//     that no video uses
//   * the validator: the fixture (one of every scene) clean; a cover first and
//     a signoff last; a tab that is not in TABS, a list that warns, markup,
//     the repository's name and a welcome too long refused; a number said, a
//     flood warning, a long tab label said aloud and a rushed scene warned of
//   * voicing that spends credits once: a scene's key is its speaker and its
//     words as said — a recast, a direction or a model changed is not a change
//     of key, a respelling of one of its words is; a draft is never pending
//     and refused if asked for; a video marked final is pending until its
//     voice is of these words, and then not; a voice or a kept scene nobody
//     uses is let go of; with every scene kept but one, voicing it says one
//     scene and estimates the credits of one — and, with ffmpeg, voicing it
//     for real says every scene once, and again after one scene's words
//     change says that scene and no other, the voice file valid both times
//
// Then Chromium:
//
//   * ?watch=<id> opens the tab on that video, armed to go full screen on its
//     first ▶, and takes itself out of the address; no page errors
//   * the cards, the Draft chip on a draft; every scene drawn wide and tall as
//     SVG; a map that names nothing draws the whole network; a feature names
//     its tab as TABS has it now; a figure counts the stations this page has
//     loaded
//   * Play runs it; Page Down and Page Up move a scene; F fills the screen and
//     Esc leaves; at the end, full screen, the stage stays (a meeting is not
//     thrown out of full screen by the last scene)
//   * voiced: 🔊 and the length as said; a voice file that is not this
//     video's is not played
//   * Copy link gives ?watch=<id>; Keep for no signal says what it needs with
//     no saved copy; no videos yet says so; the bulletin still plays on
//     Station Health; a phone has no sideways scroll
//
// Run:  npm run explainers

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate, validateIndex, validateVoice, voicePathFor, clipPathFor, buildIndex, listFiles, VOICE_FORMAT } from '../tools/explainers/validate.mjs';
import { sceneKey, explainerKeys, explainerHash, pendingExplainers, voiceExplainer, withLexicon } from '../tools/voice/speak.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VERBOSE = process.argv.includes('-v');
let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { if (VERBOSE) console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${String(detail).slice(0, 900)}` : ''}`);
};
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));
const wordsOf = s => String(s.say || '').split(/\s+/).filter(Boolean);
const stationIds = new Set(readJson(path.join(REPO, 'stations.json')).stations.map(s => s.id));
// The tabs as core.js has them: id and label.
const CORE = fs.readFileSync(path.join(REPO, 'core.js'), 'utf8');
const TABS = [...CORE.matchAll(/\{ id: '([a-z0-9]+)',\s+label: '([^']+)'/g)].map(m => ({ id: m[1], label: m[2] }));
const tabIds = new Set(TABS.map(t => t.id)), tabLabels = TABS.map(t => t.label);
const FIXTURE = readJson(path.join(HERE, 'fixtures', 'explainer-all-scenes.json'));
const CAST = withLexicon({ voices: {
  'seasoned-hydrographer': { voice_id: 'g', voice_name: 'Test Graham', model: 'eleven_v4', direction: '[slowly]' },
  'new-recruit': { voice_id: 'r', voice_name: 'Test Recruit', model: 'eleven_v4', direction: '[eager]' },
}, lexicon: [] });

// A voice file for a video, as speak.mjs writes one: each scene in `per`
// seconds, its words over the first nine-tenths, a pause between.
function voiceFor(x, file, { per = 2, gap = 0.45 } = {}) {
  let at = 0;
  const keys = explainerKeys(x, CAST);
  const scenes = x.scenes.map((s, i) => {
    const w = wordsOf(s), start = at, end = at + per;
    at = end + (i < x.scenes.length - 1 ? gap : 0);
    return { key: keys[i], clip: clipPathFor(keys[i]).audio, speaker: s.presenter || x.presenter, voice: 'Test', model: 'eleven_v4',
      start: +start.toFixed(2), end: +end.toFixed(2), words: w.map((_, k) => +(start + per * 0.9 * k / w.length).toFixed(2)) };
  });
  return { format: VOICE_FORMAT, explainer: x.id, file, audio: voicePathFor(file).audio, bytes: 1000, duration: +at.toFixed(2),
    hash: explainerHash(keys), generated_at: '2026-11-03T00:00:00Z', cast: { source: 'test', updated: null }, scenes };
}

// ── 1. what is published ────────────────────────────────────────────────────
console.log('Published videos');
{
  const ixPath = path.join(REPO, 'data', 'explainers', 'index.json');
  ok('data/explainers/index.json is there', fs.existsSync(ixPath));
  const ix = readJson(ixPath);
  const v = validateIndex(ix);
  ok('the index is valid', !v.errors.length, v.errors.join('; '));
  ok('the index is what the files make it (node tools/explainers/validate.mjs --write-index)',
    JSON.stringify(ix.explainers) === JSON.stringify(buildIndex(REPO).explainers), JSON.stringify({ index: ix.explainers, files: buildIndex(REPO).explainers }));
  for (const file of listFiles(REPO)) {
    const x = readJson(path.join(REPO, file));
    const r = validate(x, { stationIds, tabIds, tabLabels, file });
    ok(`${file} is valid`, !r.errors.length, r.errors.join('; '));
    if (VERBOSE && r.warnings.length) console.log(`       warnings: ${r.warnings.join('; ')}`);
    const vp = path.join(REPO, voicePathFor(file).json);
    if (!fs.existsSync(vp)) continue;
    const voice = readJson(vp);
    const vv = validateVoice(voice, x);
    ok(`${voicePathFor(file).json} is its video's, scene for scene and word for word`, !vv.errors.length || x.voice !== 'final', vv.errors.join('; '));
    ok(`…its MP3 is beside it`, fs.existsSync(path.join(REPO, voice.audio || '')));
    ok(`…and every scene it joined is kept`, (voice.scenes || []).every(s => fs.existsSync(path.join(REPO, s.clip || ''))));
  }
  const { orphans } = pendingExplainers(withLexicon({ voices: {}, lexicon: [] }), { repo: REPO });
  ok('nothing in data/explainers/voice/ that no video uses', !orphans.length, orphans.join(', '));
}

// ── 2. the validator ────────────────────────────────────────────────────────
console.log('The validator');
{
  const file = 'data/explainers/fixture-all.json';
  const r = validate(FIXTURE, { stationIds, tabIds, tabLabels, file });
  ok('the fixture — one of every scene — is valid', !r.errors.length, r.errors.join('; '));
  ok('…and draws no warning', !r.warnings.length, r.warnings.join('; '));
  ok('…every scene type is in it', ['cover', 'feature', 'figure', 'map', 'list', 'signoff'].every(t => FIXTURE.scenes.some(s => s.type === t)));
  const bad = (name, change, pattern, { warning = false } = {}) => {
    const x = clone(FIXTURE); change(x);
    const got = validate(x, { stationIds, tabIds, tabLabels, file });
    const list = warning ? got.warnings : got.errors;
    ok(name, list.some(e => pattern.test(e)), JSON.stringify(got));
  };
  bad('the first scene must be the cover', x => x.scenes.reverse(), /first scene is the cover/);
  bad('the last must be the signoff', x => x.scenes.pop(), /last scene is the signoff/);
  bad('a feature\'s tab must be in TABS', x => { x.scenes[3].tab = 'nosuchtab'; }, /no tab in TABS/);
  bad('a list does not warn — a video is not news of the network', x => { x.scenes[5].items[0].sev = 'warn'; }, /items\[0\]\.sev/);
  bad('markup in the words is refused', x => { x.scenes[1].say = 'Look <b>here</b>.'; }, /markup/);
  bad('the repository\'s name is refused', x => { x.scenes[1].say = 'Welcome to Mega' + 'Net.'; }, /Flood-Net/);
  bad('a welcome of more than 180 words is refused', x => { x.scenes[2].say = Array(160).fill('word').join(' '); x.scenes[2].secs = 30; }, /more than 180/);
  bad('a file not named for its id is refused', x => { x.id = 'other'; }, /not the file's own name/);
  bad('a number said is warned of', x => { x.scenes[1].say = 'There are 900 stations on file.'; }, /says a number/, { warning: true });
  bad('a flood warning is warned of', x => { x.scenes[1].say = 'It warns you of a flood before it comes.'; }, /not a flood warning service/, { warning: true });
  bad('a long tab label said aloud is warned of', x => { x.scenes[3].say = 'Open Station Health every morning.'; }, /names the tab "Station Health"/, { warning: true });
  bad('a rushed scene is warned of', x => { x.scenes[2].secs = 3; }, /more than 3\.2 a second/, { warning: true });
  const ix = { format: 'floodnet-explainer-index/1', explainers: [
    { id: 'a', file: 'data/explainers/va.json', title: 't', summary: 's', kind: 'welcome', presenter: 'seasoned-hydrographer', voice: 'draft', secs: 9 },
    { id: 'a', file: 'data/explainers/vb.json', title: 't', summary: 's', kind: 'howto', presenter: 'seasoned-hydrographer', voice: 'draft', secs: 9 }] };
  const vi = validateIndex(ix);
  ok('the index refuses an id twice and a file not its id\'s', vi.errors.some(e => /twice/.test(e)) && vi.errors.some(e => /is not data\/explainers\/a\.json/.test(e)), vi.errors.join('; '));
  ok('voicePathFor and clipPathFor say where a voice lives', voicePathFor('data/explainers/welcome.json').audio === 'data/explainers/voice/welcome.mp3'
    && clipPathFor('0123456789abcdef01234567').json === 'data/explainers/voice/clips/0123456789abcdef01234567.json');
  let threw = false; try { voicePathFor('data/explainers/index.json'); } catch (_) { threw = true; }
  ok('…and the index is no video', threw);
  const vf = voiceFor(FIXTURE, file);
  ok('a voice file of the fixture is valid', !validateVoice(vf, FIXTURE).errors.length, validateVoice(vf, FIXTURE).errors.join('; '));
  const short = clone(vf); short.scenes[2].words.pop();
  ok('…one a word short is not', validateVoice(short, FIXTURE).errors.some(e => /times for/.test(e)));
}

// ── 3. voicing that spends credits once ─────────────────────────────────────
console.log('Voicing');
{
  const k = (who, say, cast = CAST) => sceneKey(who, say, cast);
  const say = 'Here is how many stations are on file today.';
  ok('a scene\'s key is the same for the same words and speaker', k('seasoned-hydrographer', say) === k('seasoned-hydrographer', say));
  ok('…and not for other words', k('seasoned-hydrographer', say) !== k('seasoned-hydrographer', say + ' Yes.'));
  ok('…nor another speaker', k('seasoned-hydrographer', say) !== k('new-recruit', say));
  const recast = withLexicon({ voices: { 'seasoned-hydrographer': { voice_id: 'other', model: 'eleven_multilingual_v2', direction: '[quickly]' } }, lexicon: [] });
  ok('a recast — another voice, model or direction — is not a change of key', k('seasoned-hydrographer', say) === k('seasoned-hydrographer', say, recast));
  const respelt = { ...CAST, lexicon: [...CAST.lexicon, { word: 'stations', say: 'stay-shuns' }] };
  const unrelated = { ...CAST, lexicon: [...CAST.lexicon, { word: 'Goomburra', say: 'Goom-burra' }] };
  ok('a word of the scene respelt is a change of key', k('seasoned-hydrographer', say) !== k('seasoned-hydrographer', say, respelt));
  ok('…a word not in it respelt is not', k('seasoned-hydrographer', say) === k('seasoned-hydrographer', say, unrelated));

  // A scratch copy of the repository's videos.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-'));
  const dir = path.join(repo, 'data', 'explainers'), vdir = path.join(dir, 'voice'), cdir = path.join(vdir, 'clips');
  fs.mkdirSync(cdir, { recursive: true });
  const put = (rel, obj) => fs.writeFileSync(path.join(repo, rel), typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj, null, 1));
  const a = clone(FIXTURE); a.id = 'va';
  const b = clone(FIXTURE); b.id = 'vb'; b.voice = 'draft';
  put('data/explainers/va.json', a); put('data/explainers/vb.json', b);
  let p = pendingExplainers(CAST, { repo });
  ok('a video marked final with no voice is pending', p.todo.some(t => t.file === 'data/explainers/va.json'), JSON.stringify(p));
  ok('…a draft never is', !p.todo.some(t => t.file === 'data/explainers/vb.json'));
  let refused = '';
  try { await voiceExplainer('data/explainers/vb.json', CAST, { repo, dry: true, log: () => {} }); } catch (e) { refused = e.message; }
  ok('…and a draft asked for by name is refused', /draft/.test(refused), refused);
  put('data/explainers/voice/va.json', voiceFor(a, 'data/explainers/va.json')); put('data/explainers/voice/va.mp3', 'x');
  p = pendingExplainers(CAST, { repo });
  ok('a video whose voice is of these words is not pending', !p.todo.length, JSON.stringify(p));
  ok('…its forced re-voice is', pendingExplainers(CAST, { repo, force: ['data/explainers/va.json'] }).todo.some(t => t.force));
  const a2 = clone(a); a2.scenes[3].say = 'Every morning the network checks itself, and what needs a look comes first.';
  put('data/explainers/va.json', a2);
  ok('…one scene\'s words changed, it is pending again', pendingExplainers(CAST, { repo }).todo.some(t => t.file === 'data/explainers/va.json'));
  put('data/explainers/voice/gone.json', '{}'); put('data/explainers/voice/clips/ffffffffffffffffffffffff.mp3', 'x');
  p = pendingExplainers(CAST, { repo });
  ok('a voice whose video has gone, and a kept scene nobody uses, are let go of',
    p.orphans.includes('data/explainers/voice/gone.json') && p.orphans.includes('data/explainers/voice/clips/ffffffffffffffffffffffff.mp3'), JSON.stringify(p.orphans));
  // Every scene kept but the changed one: voicing it says one.
  explainerKeys(a2, CAST).forEach((key, i) => { if (i !== 3) { put(clipPathFor(key).audio, 'x'); put(clipPathFor(key).json, '{}'); } });
  const logs = [];
  const dry = await voiceExplainer('data/explainers/va.json', CAST, { repo, dry: true, log: l => logs.push(l) });
  const one = a2.scenes[3].say.length + '[slowly] '.length;
  ok('with every scene kept but one, voicing it says one scene', dry.said === 1 && dry.kept === a2.scenes.length - 1, JSON.stringify(dry));
  ok('…and estimates the credits of that one', Math.abs(dry.credits - one * 0.4) < 2, `${dry.credits} for ${one} characters`);
  ok('…saying so before spending', /1 to say/.test(logs.join('\n')), logs.join('\n'));
  fs.rmSync(repo, { recursive: true, force: true });

  // For real, with ffmpeg: a stand-in for ElevenLabs that hums for as long as
  // the words would take, and counts what it was asked to say.
  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  if (!hasFfmpeg) console.log('  (no ffmpeg here — the real voicing is checked where there is)');
  else {
    const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-'));
    fs.mkdirSync(path.join(repo2, 'data', 'explainers'), { recursive: true });
    const said = [];
    const fake = async (voice, text) => {
      said.push(text);
      const secs = Math.max(0.6, text.split(/\s+/).length * 0.32);
      const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${secs}`, '-ac', '1', '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
      const n = text.length;
      return { audio: r.stdout, alignment: { character_start_times_seconds: Array.from({ length: n }, (_, i) => +(secs * 0.9 * i / n).toFixed(3)) }, cost: n };
    };
    const c = clone(FIXTURE); c.id = 'vc';
    fs.writeFileSync(path.join(repo2, 'data/explainers/vc.json'), JSON.stringify(c));
    const first = await voiceExplainer('data/explainers/vc.json', CAST, { repo: repo2, log: () => {}, say: fake });
    const v1 = readJson(path.join(repo2, 'data/explainers/voice/vc.json'));
    ok('voiced for real, every scene is said once', said.length === c.scenes.length && first.said === c.scenes.length, `${said.length} said`);
    ok('…the voice file is the video\'s, scene for scene and word for word', !validateVoice(v1, c).errors.length, validateVoice(v1, c).errors.join('; '));
    ok('…with its MP3 and every scene kept', fs.existsSync(path.join(repo2, v1.audio)) && v1.scenes.every(s => fs.existsSync(path.join(repo2, s.clip))));
    ok('…and nothing is pending after it', !pendingExplainers(CAST, { repo: repo2 }).todo.length);
    said.length = 0;
    c.scenes[3].say = 'Every morning the network checks itself, and the worst comes first.';
    fs.writeFileSync(path.join(repo2, 'data/explainers/vc.json'), JSON.stringify(c));
    const again = await voiceExplainer('data/explainers/vc.json', CAST, { repo: repo2, log: () => {}, say: fake });
    const v2 = readJson(path.join(repo2, 'data/explainers/voice/vc.json'));
    ok('one scene\'s words changed, voicing it again says that scene and no other', said.length === 1 && /the worst comes first/.test(said[0]) && again.kept === c.scenes.length - 1, `${said.length} said: ${said.join(' | ')}`);
    ok('…the voice file valid again', !validateVoice(v2, c).errors.length, validateVoice(v2, c).errors.join('; '));
    ok('…the scenes kept are the same as before', v2.scenes.filter((s, i) => i !== 3).every((s, j) => s.key === v1.scenes.filter((_, i) => i !== 3)[j].key));
    ok('…and the old scene, now unused, is let go of on the next run', pendingExplainers(CAST, { repo: repo2 }).orphans.some(o => o.includes(v1.scenes[3].key)));
    fs.rmSync(repo2, { recursive: true, force: true });
  }
}

// ── 4. in Chromium ──────────────────────────────────────────────────────────
console.log('In Chromium');
const { startServer } = await import('./lib/server.mjs');
const { launchBrowser } = await import('./lib/browser.mjs');
const { applyNetworkPolicy } = await import('./lib/network.mjs');
const server = await startServer();
const browser = await launchBrowser();
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const fixFile = 'data/explainers/fixture-all.json';
const draft = Object.assign(clone(FIXTURE), { id: 'fixture-draft', kind: 'howto', voice: 'draft', title: 'A draft how-to', summary: 'Plays silent until its words are approved.' });
const draftFile = 'data/explainers/fixture-draft.json';
const entry = (x, file) => ({ id: x.id, file, title: x.title, summary: x.summary, kind: x.kind, presenter: x.presenter, voice: x.voice, secs: x.scenes.reduce((n, s) => n + s.secs, 0), updated: x.updated });
const fixIndex = { format: 'floodnet-explainer-index/1', updated_at: '2026-11-03T00:00:00Z', explainers: [entry(FIXTURE, fixFile), entry(draft, draftFile)] };
function wav(secs, rate = 8000) {
  const n = Math.round(secs * rate), w = Buffer.alloc(44 + n);
  w.write('RIFF', 0); w.writeUInt32LE(36 + n, 4); w.write('WAVE', 8); w.write('fmt ', 12);
  w.writeUInt32LE(16, 16); w.writeUInt16LE(1, 20); w.writeUInt16LE(1, 22); w.writeUInt32LE(rate, 24); w.writeUInt32LE(rate, 28);
  w.writeUInt16LE(1, 32); w.writeUInt16LE(8, 34); w.write('data', 36); w.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) w[44 + i] = 128 + Math.round(16 * Math.sin(2 * Math.PI * 220 * i / rate));
  return w;
}
const fixVoice = voiceFor(FIXTURE, fixFile);
async function page(opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 1000 }, timezoneId: 'Australia/Brisbane' });
  const pg = await context.newPage();
  const errors = [];
  pg.on('pageerror', e => errors.push(e.message));
  await applyNetworkPolicy(pg, server.origin);
  await pg.route('**/data/explainers/index.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.index || fixIndex) }));
  await pg.route('**/' + fixFile, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE) }));
  await pg.route('**/' + draftFile, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(draft) }));
  await pg.route('**/data/explainers/voice/**', r => {
    const u = new URL(r.request().url());
    if (opts.voice && u.pathname.endsWith(voicePathFor(fixFile).json)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.voice) });
    if (opts.voice && u.pathname.endsWith(voicePathFor(fixFile).audio)) return r.fulfill({ status: 200, contentType: 'audio/wav', body: wav(opts.voice.duration) });
    return r.fulfill({ status: 404, body: 'not found' });
  });
  await pg.goto(server.origin + '/index.html' + (opts.query || ''), { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof state !== 'undefined' && state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
  if (!opts.query) await pg.evaluate(() => switchTab('videos'));
  return { pg, context, errors };
}
const until = (pg, fn, arg, timeout = 20_000) => pg.waitForFunction(fn, arg, { timeout });
try {
  // ── opened from a link ──
  const { pg, context, errors } = await page({ query: '?watch=fixture-all' });
  await until(pg, () => !!document.querySelector('#xp-stage svg'));
  const opened = await pg.evaluate(() => ({ tab: state.activeTab, file: Explainers._state().file, armed: Explainers._x().armed, note: !!document.querySelector('.xp-armed'),
    search: location.search, heading: (document.getElementById('xp-h') || {}).textContent || '' }));
  ok('?watch=<id> opens the Videos tab on that video', opened.tab === 'videos' && opened.file === fixFile && /Videos/.test(opened.heading), JSON.stringify(opened));
  ok('…armed to go full screen on its first ▶, and says so', opened.armed && opened.note, JSON.stringify(opened));
  ok('…and the address no longer carries it', !/watch=/.test(opened.search), opened.search);
  const cards = await pg.evaluate(() => [...document.querySelectorAll('.xp-card')].map(c => ({ on: c.classList.contains('is-on'), text: c.textContent.replace(/\s+/g, ' ').trim(), draft: !!c.querySelector('.term-chip[title]') })));
  ok('a card for each video, the one showing pressed', cards.length === 2 && cards[0].on && !cards[1].on, JSON.stringify(cards));
  ok('…a draft marked Draft, with what that means on hover', !cards[0].draft && cards[1].draft, JSON.stringify(cards));
  const draws = await pg.evaluate(fx => fx.scenes.map((s, i) => {
    const one = n => { const svg = Explainers._draw(s, fx, n); const d = new DOMParser().parseFromString(svg, 'image/svg+xml'); return { bad: !!d.querySelector('parsererror'), text: d.documentElement.textContent }; };
    return { i, type: s.type, wide: one(false), tall: one(true) };
  }), FIXTURE);
  ok('every scene is drawn as SVG, wide and tall', draws.every(d => !d.wide.bad && !d.tall.bad && !/could not be drawn|does not know how/.test(d.wide.text + d.tall.text)), JSON.stringify(draws.filter(d => d.wide.bad || d.tall.bad || /could not|does not know/.test(d.wide.text + d.tall.text)).map(d => d.type)));
  const net = await pg.evaluate(fx => { const svg = Explainers._draw(fx.scenes[2], fx, false); return { dots: (svg.match(/<circle /g) || []).length, stations: state.data.stations.length }; }, FIXTURE);
  ok('a map scene that names nothing draws the whole network', net.dots > net.stations * 0.8, JSON.stringify(net));
  const label = await pg.evaluate(() => TAB_LIST.find(t => t.id === 'health').label);
  ok('a feature names its tab as TABS has it now', draws[3].wide.text.includes(label), `${label} not in: ${draws[3].wide.text.slice(0, 200)}`);
  const counted = await pg.evaluate(fx => { const svg = Explainers._draw(fx.scenes[1], fx, false); const m = /data-count="(\d+)"/.exec(svg); return { n: m && +m[1], stations: state.data.stations.length }; }, FIXTURE);
  ok('a figure counts the stations this page has loaded', counted.n === counted.stations, JSON.stringify(counted));
  // Play, and the clicker.
  await pg.evaluate(() => Explainers.play());
  await pg.waitForTimeout(500);
  const playing = await pg.evaluate(() => ({ st: Explainers._state(), said: document.querySelectorAll('#xp-caption .hb-w.is-said').length }));
  ok('Play runs it, the words revealed', playing.st.playing && playing.said > 0, JSON.stringify(playing));
  await pg.focus('#xp-stage');
  await pg.keyboard.press('PageDown');
  const down = await pg.evaluate(() => Explainers._state().scene);
  await pg.keyboard.press('PageDown');
  await pg.keyboard.press('PageUp');
  const up = await pg.evaluate(() => Explainers._state().scene);
  ok('a clicker\'s Page Down moves a scene on, Page Up back', down === 1 && up === 1, JSON.stringify({ down, up }));
  await pg.keyboard.press('f');
  const full = await pg.evaluate(() => ({ x: Explainers._x().meeting, cls: document.getElementById('xp-show').classList.contains('is-meeting'),
    r: document.getElementById('xp-show').getBoundingClientRect().toJSON(), w: innerWidth, h: innerHeight, pressed: document.getElementById('xp-full').getAttribute('aria-pressed') }));
  ok('F fills the screen with the show', full.x && full.cls && full.r.width >= full.w - 1 && full.r.height >= full.h - 1 && full.pressed === 'true', JSON.stringify(full));
  const fit = await pg.evaluate(() => { const st = document.getElementById('xp-stage').getBoundingClientRect(), say = document.querySelector('#xp-show .hb-say'); return { stageH: st.height, stageW: st.width, h: innerHeight, font: parseFloat(getComputedStyle(say).fontSize) }; });
  ok('…the picture as big as it can be with the words under it, and the words large', fit.stageW > 1000 && fit.stageH < fit.h * 0.8 && fit.font >= 24, JSON.stringify(fit));
  // To the end, full screen: the stage stays.
  const stage = await pg.evaluateHandle(() => document.getElementById('xp-stage'));
  await pg.evaluate(() => { const n = Explainers._api.current().scenes.length; Explainers.seekTo(n - 1, 1e9); Explainers.play(); });
  await until(pg, () => Explainers._state().ended);
  const end = await pg.evaluate(el => ({ same: document.getElementById('xp-stage') === el, meeting: Explainers._x().meeting, again: !!document.querySelector('#xp-stage .hb-bigplay') }), stage);
  ok('at the end, full screen, the stage stays and offers Watch again', end.same && end.meeting && end.again, JSON.stringify(end));
  await pg.keyboard.press('Escape');
  const left = await pg.evaluate(() => ({ x: Explainers._x().meeting, cls: document.getElementById('xp-show').classList.contains('is-meeting'), html: document.documentElement.classList.contains('xp-meeting-on') }));
  ok('Esc leaves full screen', !left.x && !left.cls && !left.html, JSON.stringify(left));
  // The link, and keeping it.
  await pg.evaluate(() => Explainers.copyLink());
  await pg.waitForTimeout(300);
  const toast = await pg.evaluate(() => [...document.querySelectorAll('.toast, [class*="toast"]')].map(t => t.textContent).join(' '));
  ok('Copy link gives the address that opens it', /\?watch=fixture-all/.test(toast), toast);
  await pg.evaluate(() => Explainers.keepIt());
  await until(pg, () => /Offline & Install|Kept on this device|Not kept/.test((document.querySelector('.xp-kept') || {}).textContent || ''));
  const kept = await pg.evaluate(() => document.querySelector('.xp-kept').textContent);
  ok('Keep for no signal says what it did, or what it needs', kept.length > 10, kept);
  const words = await pg.evaluate(() => ({ terms: [...document.querySelectorAll('#xp-panel .term[title], #xp-panel .term-chip[title]')].map(t => t.textContent), fold: !!document.querySelector('.xp-fold dl dt') }));
  ok('the words that need it have their meaning on hover, and in a fold', words.terms.includes('Full screen') && words.terms.includes('Keep for no signal') && words.fold, JSON.stringify(words));
  // The draft: silent, by the clock.
  await pg.evaluate(f => Explainers.pick(f), draftFile);
  await until(pg, () => Explainers._state().file === 'data/explainers/fixture-draft.json' && !!document.querySelector('#xp-stage svg'));
  const dr = await pg.evaluate(() => ({ st: Explainers._state(), says: (document.querySelector('#xp-panel .hb-issued') || {}).textContent || '' }));
  ok('a draft plays silent, and says why', !dr.st.voiced && /Draft/.test(dr.says), JSON.stringify(dr));
  ok('no page errors', !errors.length, errors.join('\n'));
  // The bulletin, on its own tab, still the bulletin.
  await pg.evaluate(() => switchTab('health'));
  await until(pg, () => !!document.getElementById('hb-panel'));
  const hb = await pg.evaluate(() => ({ panel: !!document.getElementById('hb-panel'), xp: !!document.getElementById('xp-panel'), heading: (document.getElementById('hb-h') || {}).textContent || '' }));
  ok('the Network Bulletin still has its own panel on Station Health', hb.panel && !hb.xp && /Network Bulletin/.test(hb.heading), JSON.stringify(hb));
  ok('no page errors after it', !errors.length, errors.join('\n'));
  await context.close();

  {
    // Voiced: 🔊, the length as said, the voices followed.
    const { pg, context, errors } = await page({ voice: fixVoice });
    await until(pg, () => !!document.querySelector('#xp-stage svg') && !!document.getElementById('xp-sound'));
    const v = await pg.evaluate(() => ({ st: Explainers._state(), clock: document.getElementById('xp-clock').textContent, says: document.querySelector('#xp-panel .hb-issued').textContent }));
    ok('voiced: 🔊 on the bar, the length as said, and it says it is voiced', v.st.voiced && /\/ 0:\d\d/.test(v.clock) && /Voiced/.test(v.says), JSON.stringify(v));
    await pg.click('#xp-play');
    await until(pg, () => Explainers._state().audio === 'ready' || Explainers._state().audio === 'failed');
    const a = await pg.evaluate(() => Explainers._state());
    ok('…Play fetches its voices', a.audio === 'ready', JSON.stringify(a));
    ok('no page errors, voiced', !errors.length, errors.join('\n'));
    await context.close();
  }
  {
    // A voice file that is not this video's — a scene short — is not played.
    const wrong = clone(fixVoice); wrong.scenes.pop();
    const { pg, context, errors } = await page({ voice: wrong });
    await until(pg, () => !!document.querySelector('#xp-stage svg'));
    await pg.waitForTimeout(300);
    const st = await pg.evaluate(() => ({ st: Explainers._state(), button: !!document.getElementById('xp-sound') }));
    ok('a voice file that is not this video\'s is not played', !st.st.voiced && !st.button, JSON.stringify(st));
    ok('…and nothing breaks', !errors.length, errors.join('\n'));
    await context.close();
  }
  {
    // None yet.
    const { pg, context, errors } = await page({ index: { format: 'floodnet-explainer-index/1', updated_at: '2026-11-03T00:00:00Z', explainers: [] } });
    await until(pg, () => !!document.querySelector('.xp-empty'));
    ok('no videos yet says so', true);
    ok('…with no page errors', !errors.length, errors.join('\n'));
    await context.close();
  }
  {
    // An id that is not there.
    const { pg, context, errors } = await page({ query: '?watch=nothing-here' });
    await until(pg, () => state.activeTab === 'videos' && !!document.querySelector('#xp-stage svg'));
    const m = await pg.evaluate(() => ({ note: (document.querySelector('#xp-panel .txt-warn') || {}).textContent || '', armed: Explainers._x().armed }));
    ok('a link to a video that is not there says so, and shows the ones there are', /no video called/.test(m.note) && !m.armed, JSON.stringify(m));
    ok('…with no page errors', !errors.length, errors.join('\n'));
    await context.close();
  }
  {
    // A phone.
    const { pg, context, errors } = await page({ viewport: { width: 390, height: 844 } });
    await until(pg, () => !!document.querySelector('#xp-stage svg'));
    await pg.waitForTimeout(400);
    const phone = await pg.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, vb: document.querySelector('#xp-stage svg').getAttribute('viewBox') }));
    ok('a phone: drawn tall, and no sideways scroll', phone.sw <= phone.w && /720 900/.test(phone.vb), JSON.stringify(phone));
    ok('…with no page errors', !errors.length, errors.join('\n'));
    await context.close();
  }
} catch (err) {
  failures++;
  console.log(`  FAIL ${err.stack || err.message}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures) { console.log(`\n${failures} check${failures === 1 ? '' : 's'} failed.`); process.exit(1); }
console.log('\nVideos: all checks passed.');
