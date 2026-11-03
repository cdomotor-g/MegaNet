// tools/explainers/validate.mjs — what a 🎬 Videos file may hold (EPIC #262).
//
// A video (explainers.js) is drawn in the browser from data/explainers/<id>.json
// and played on the Network Bulletin's player. The player draws whatever it is
// given and draws a bad scene as a note rather than failing; this is where a
// bad file is caught first — by the author before pushing, by
// tools/voice/speak.mjs before it spends a credit on one, and by
// test/explainers.mjs on every file in data/explainers/ and on its fixture.
//
//   validate(x, { stationIds, tabIds, tabLabels, shots })  → { errors, warnings, words, secs }
//   validateIndex(ix)                               → { errors, warnings }
//   voicePathFor(file)        → { json, audio }    where a video's voice lives
//   clipPathFor(key)          → { audio, json }    where one scene's voice is kept
//   validateVoice(v, x)       → { errors, warnings }
//   buildIndex(repo)          → the index, from the files on disk
//
//   node tools/explainers/validate.mjs [FILE.json …]   check them (default: every video)
//   node tools/explainers/validate.mjs --write-index   check every video and write the index
//
// The brief that says how a video is written is tools/explainers/README.md;
// keep the two in step.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESENTERS } from '../bulletin/validate.mjs';

export { PRESENTERS };
export const FORMAT = 'floodnet-explainer/1';
export const INDEX_FORMAT = 'floodnet-explainer-index/1';
export const VOICE_FORMAT = 'floodnet-explainer-voice/1';
export const KINDS = ['welcome', 'howto'];
export const VOICES = ['draft', 'final'];
// The scenes a video may have, and what each must carry. `cover`, `feature`,
// `figure` and `signoff` are the videos' own (explainers.js); `map` and `list`
// are the bulletin's, drawn by the same hand.
export const SCENES = {
  cover:   { fields: [] },
  shot:    { fields: ['shot'] },
  feature: { fields: ['tab'] },
  figure:  { fields: ['figures'] },
  tally:   { fields: ['items'] },
  map:     { fields: [] },
  list:    { fields: ['items'] },
  signoff: { fields: [] },
};
export const SKETCHES = ['map', 'card', 'chart', 'list', 'table', 'player', 'form', 'tiles'];
export const PARTS = ['rail', 'search', 'head', 'main', 'side'];
// What a `figure` may count live (explainers.js liveCount).
export const SOURCES = ['stations', 'rain', 'level', 'repeaters', 'tabs'];
const MARKS = ['silent', 'battery', 'flip', 'carrier', 'receiver', 'repeater', 'sensor', 'signal', 'ok', 'note'];

const LIMITS = {
  scenes: [3, 16], secs: [3, 30],
  title: 70, summary: 160, say: 420, sub: 90, headline: 90, line: 160, kicker: 40, next: 60, point: 70, label: 40, unit: 12, note: 120, text: 160,
  callout: 60, item: 44, icon: 8,
  // Every word is said aloud, and how long it takes is who says it: Graham
  // slowly, Turbo flat out. A welcome runs at most about two and a half
  // minutes said; a how-to about a minute and a quarter (EPIC #262, rule 5;
  // the owner, 3 Nov 2026: Turbo rattles off the rest, so it does not drag).
  said: { welcome: 160, howto: 75 },
  // …and a backstop on words, for a run so quick the time would not catch it.
  words: { welcome: 400, howto: 190 },
};
// Words a second as each Droggie says them, measured off their own voices in
// the bulletins' voice files (3 Nov 2026: Graham 1,047 words in 476 s, Turbo
// 353 in 119): for the length a video will run, before a credit is spent on it.
export const PACE_OF = { 'seasoned-hydrographer': 2.2, turbo: 3.0, 'new-recruit': 2.74, 'tech-wizard': 2.44, 'know-it-all': 2.6, 'bean-counter': 2.32, nitwit: 2.46 };
const GAP = 0.45;                       // seconds of quiet between scenes (speak.mjs)
const wordsNorm = t => String(t || '').split(/\s+/).filter(Boolean).map(w => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
// The word a cue starts at, from `from` on (explainers.js cueIndex): -1 if it is not there.
export function cueIndex(say, cue, from = 0) {
  const words = wordsNorm(say), want = wordsNorm(cue).filter(Boolean);
  if (!want.length) return -1;
  for (let i = Math.max(0, from); i + want.length <= words.length; i++) if (want.every((w, k) => words[i + k] === w)) return i;
  return -1;
}
// Words a second, said: the voices run about 2.4; a scene's own seconds are
// what it plays for without them.
const PACE = 3.2;

const wordsOf = t => String(t || '').split(/\s+/).filter(Boolean);

export function validate(x, { stationIds = null, tabIds = null, tabLabels = null, file = null, shots = null } = {}) {
  const errors = [], warnings = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const warn = (where, msg) => warnings.push(`${where}: ${msg}`);
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const str = (where, v, max, { req = true } = {}) => {
    if (v == null || v === '') { if (req) err(where, 'missing'); return false; }
    if (typeof v !== 'string') { err(where, 'not text'); return false; }
    if (v.length > max) err(where, `${v.length} characters, more than ${max}`);
    if (/<[a-z/!]/i.test(v)) err(where, 'holds markup — the player writes text, not HTML');
    if (/meganet/i.test(v)) err(where, 'says MegaNet — the app is Flood-Net to anybody who reads or hears it');
    return true;
  };
  const num = (where, v, lo, hi, { req = true } = {}) => {
    if (v == null) { if (req) err(where, 'missing'); return false; }
    if (typeof v !== 'number' || !Number.isFinite(v)) { err(where, 'not a number'); return false; }
    if (v < lo || v > hi) err(where, `${v} outside ${lo}…${hi}`);
    return true;
  };
  const oneOf = (where, v, list, { req = true } = {}) => {
    if (v == null) { if (req) err(where, 'missing'); return; }
    if (!list.includes(v)) err(where, `"${v}" is not one of ${list.join(', ')}`);
  };
  const list = (where, v, lo, hi, { req = true } = {}) => {
    if (v == null && !req) return [];
    if (!Array.isArray(v)) { err(where, 'not a list'); return []; }
    if (v.length < lo || v.length > hi) err(where, `${v.length} items, not ${lo}…${hi}`);
    return v.slice(0, Math.max(hi, 0));
  };
  const sid = (where, v) => {
    if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9_.-]{1,80}$/.test(v)) { err(where, `"${v}" is not a station id`); return; }
    if (stationIds && !stationIds.has(v)) err(where, `"${v}" is no station in the register`);
  };
  const tab = (where, v, { req = true } = {}) => {
    if (v == null) { if (req) err(where, 'missing'); return; }
    if (typeof v !== 'string') { err(where, 'not a tab id'); return; }
    if (tabIds && !tabIds.has(v)) err(where, `"${v}" is no tab in TABS (core.js)`);
  };

  if (!isObj(x)) return { errors: ['the video is not a JSON object'], warnings };
  if (x.format !== FORMAT) err('format', `"${x.format}", not "${FORMAT}"`);
  if (typeof x.id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(x.id)) err('id', `"${x.id}" is not a video's id (lower case, digits and hyphens)`);
  else if (x.id === 'index') err('id', '"index" is the list of videos, not a video');
  if (file && x.id && file !== `data/explainers/${x.id}.json`) err('id', `"${x.id}" is not the file's own name (${file})`);
  oneOf('kind', x.kind, KINDS);
  str('title', x.title, LIMITS.title);
  str('summary', x.summary, LIMITS.summary);
  oneOf('presenter', x.presenter, PRESENTERS);
  oneOf('voice', x.voice, VOICES);
  if (typeof x.updated !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.updated)) err('updated', 'not a date (YYYY-MM-DD)');

  const scenes = list('scenes', x.scenes, LIMITS.scenes[0], LIMITS.scenes[1]);
  if (scenes.length) {
    if (scenes[0] && scenes[0].type !== 'cover') err('scenes[0]', 'the first scene is the cover');
    if (scenes[scenes.length - 1] && scenes[scenes.length - 1].type !== 'signoff') err(`scenes[${scenes.length - 1}]`, 'the last scene is the signoff');
  }
  let words = 0, said = 0;
  scenes.forEach((s, i) => {
    const W = `scenes[${i}]`;
    if (!isObj(s)) { err(W, 'not an object'); return; }
    const spec = SCENES[s.type];
    if (!spec) { err(W + '.type', `"${s.type}" is not one of ${Object.keys(SCENES).join(', ')}`); return; }
    for (const f of spec.fields) if (s[f] == null) err(`${W}.${f}`, 'missing');
    str(W + '.title', s.title, LIMITS.title);
    str(W + '.sub', s.sub, LIMITS.sub, { req: false });
    if (str(W + '.say', s.say, LIMITS.say)) {
      const n = wordsOf(s.say).length;
      words += n;
      said += n / (PACE_OF[s.presenter || x.presenter] || 2.4) + (i ? GAP : 0);
      // Rule 4: said once, a number or a date goes stale — draw it instead.
      if (/\d/.test(s.say)) warn(W + '.say', 'says a number — draw it (a figure counts live) so the voice, said once, does not go stale');
      if (/\bwarn(s|ing|ings)?\b[^.]*\bflood|\bflood[^.]*\bwarn/i.test(s.say)) warn(W + '.say', 'speaks of flood warnings — Flood-Net is not a flood warning service; say what it does');
      for (const label of tabLabels || []) {
        if (label.length >= 10 && s.say.includes(label)) warn(W + '.say', `names the tab "${label}" — a renamed tab would leave the voice saying the old name; point at it (a feature scene draws its name)`);
      }
      if (num(W + '.secs', s.secs, LIMITS.secs[0], LIMITS.secs[1]) && n / s.secs > PACE) warn(W + '.secs', `${n} words in ${s.secs} s is more than ${PACE} a second — it would rush when played without its voices`);
    } else num(W + '.secs', s.secs, LIMITS.secs[0], LIMITS.secs[1]);
    if (s.presenter != null) oneOf(W + '.presenter', s.presenter, PRESENTERS);
    list(W + '.stations', s.stations, 0, 8, { req: false }).forEach((id, k) => sid(`${W}.stations[${k}]`, id));

    // Cues — the word a callout or an item appears on — are in the words, in order.
    const cues = (whereList, list) => {
      let from = 0;
      list.forEach((it, k) => {
        if (!it || it.cue == null) return;
        if (typeof it.cue !== 'string' || !it.cue.trim()) { err(`${W}.${whereList}[${k}].cue`, 'not text'); return; }
        const at = cueIndex(s.say, it.cue, from);
        if (at < 0) err(`${W}.${whereList}[${k}].cue`, `"${it.cue}" is not in the words${from ? ' after the cue before it' : ''}`);
        else from = at + 1;
      });
    };
    switch (s.type) {
      case 'shot': {
        const meta = shots && typeof s.shot === 'string' ? shots[s.shot] : null;
        if (typeof s.shot !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(s.shot)) err(W + '.shot', `"${s.shot}" is not a shot's name`);
        else if (shots && !meta) err(W + '.shot', `"${s.shot}" is no shot in data/explainers/shots/index.json — add it to tools/explainers/shots.json and take it (node tools/explainers/shoot.mjs ${s.shot})`);
        if (s.focus != null && meta && !meta.targets[s.focus]) err(W + '.focus', `"${s.focus}" is not one of the shot's parts (${Object.keys(meta.targets).join(', ')})`);
        if (s.zoom != null) num(W + '.zoom', s.zoom, 1, 4);
        const cl = list(W + '.callouts', s.callouts, 0, 4, { req: false });
        cl.forEach((c, k) => {
          const C = `${W}.callouts[${k}]`;
          if (!isObj(c)) { err(C, 'not an object'); return; }
          str(C + '.text', c.text, LIMITS.callout);
          if (typeof c.target !== 'string') err(C + '.target', 'missing');
          else if (meta && !meta.targets[c.target]) err(C + '.target', `"${c.target}" is not one of the shot's parts (${Object.keys(meta.targets).join(', ')})`);
        });
        cues('callouts', cl);
        break;
      }
      case 'tally': {
        const it = list(W + '.items', s.items, 2, 16);
        it.forEach((t, k) => {
          const I = `${W}.items[${k}]`;
          if (!isObj(t)) { err(I, 'not an object'); return; }
          str(I + '.text', t.text, LIMITS.item);
          str(I + '.icon', t.icon, LIMITS.icon, { req: false });
        });
        cues('items', it);
        break;
      }
      case 'cover':
        str(W + '.headline', s.headline, LIMITS.headline, { req: false });
        str(W + '.line', s.line, LIMITS.line, { req: false });
        str(W + '.kicker', s.kicker, LIMITS.kicker, { req: false });
        break;
      case 'feature':
        tab(W + '.tab', s.tab);
        oneOf(W + '.sketch', s.sketch, SKETCHES, { req: false });
        oneOf(W + '.lit', s.lit, PARTS, { req: false });
        if (s.side != null && typeof s.side !== 'boolean') err(W + '.side', 'not true or false');
        list(W + '.points', s.points, 0, 3, { req: false }).forEach((p, k) => str(`${W}.points[${k}]`, p, LIMITS.point));
        break;
      case 'figure':
        list(W + '.figures', s.figures, 1, 3).forEach((f, k) => {
          const F = `${W}.figures[${k}]`;
          if (!isObj(f)) { err(F, 'not an object'); return; }
          oneOf(F + '.of', f.of, SOURCES, { req: false });
          num(F + '.value', f.value, 0, 1e7);
          str(F + '.label', f.label, LIMITS.label);
          str(F + '.unit', f.unit, LIMITS.unit, { req: false });
        });
        str(W + '.note', s.note, LIMITS.note, { req: false });
        break;
      case 'map':
        list(W + '.marks', s.marks, 0, 40, { req: false }).forEach((m, k) => {
          const M = `${W}.marks[${k}]`;
          if (!isObj(m)) { err(M, 'not an object'); return; }
          if (m.id != null) sid(M + '.id', m.id);
          else { num(M + '.lat', m.lat, -45, -5); num(M + '.lon', m.lon, 110, 160); }
          oneOf(M + '.kind', m.kind, MARKS, { req: false });
          str(M + '.label', m.label, LIMITS.label, { req: false });
        });
        list(W + '.areas', s.areas, 0, 12, { req: false }).forEach((a, k) => {
          const A = `${W}.areas[${k}]`;
          num(A + '.lat', a.lat, -45, -5); num(A + '.lon', a.lon, 110, 160); num(A + '.km', a.km, 1, 800);
          oneOf(A + '.sev', a.sev, ['info', 'ok'], { req: false });
          str(A + '.label', a.label, LIMITS.label, { req: false });
        });
        if (s.focus != null) { num(W + '.focus.lat', s.focus.lat, -45, -5); num(W + '.focus.lon', s.focus.lon, 110, 160); num(W + '.focus.km', s.focus.km, 5, 2500); }
        break;
      case 'list':
        list(W + '.items', s.items, 1, 6).forEach((it, k) => {
          const I = `${W}.items[${k}]`;
          if (!isObj(it)) { err(I, 'not an object'); return; }
          // A video is not news of the network: no warnings or criticals.
          oneOf(I + '.sev', it.sev, ['info', 'ok']);
          str(I + '.text', it.text, LIMITS.text);
          if (it.id != null) sid(I + '.id', it.id);
        });
        break;
      case 'signoff':
        str(W + '.line', s.line, LIMITS.line, { req: false });
        str(W + '.next', s.next, LIMITS.next, { req: false });
        tab(W + '.tab', s.tab, { req: false });
        break;
    }
  });
  const what = x.kind === 'howto' ? 'how-to' : 'welcome';
  const cap = LIMITS.words[x.kind], secsCap = LIMITS.said[x.kind];
  if (cap && words > cap) err('scenes', `${words} words said, more than ${cap} for a ${what} — cut a scene before thinning them all`);
  if (secsCap && said > secsCap) err('scenes', `about ${Math.round(said)} s said, more than ${secsCap} for a ${what} — cut a scene, or hand a run of names to a quicker voice`);
  return { errors, warnings, words, secs: Math.round(said) };
}

export function validateIndex(ix) {
  const errors = [], warnings = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  if (!ix || typeof ix !== 'object') return { errors: ['the index is not a JSON object'], warnings };
  if (ix.format !== INDEX_FORMAT) err('format', `"${ix.format}", not "${INDEX_FORMAT}"`);
  if (!Array.isArray(ix.explainers)) { err('explainers', 'not a list'); return { errors, warnings }; }
  const seen = new Set();
  ix.explainers.forEach((e, i) => {
    const W = `explainers[${i}]`;
    if (!e || typeof e !== 'object') { err(W, 'not an object'); return; }
    if (seen.has(e.id)) err(W + '.id', `"${e.id}" twice`);
    seen.add(e.id);
    if (e.file !== `data/explainers/${e.id}.json`) err(W + '.file', `"${e.file}" is not data/explainers/${e.id}.json`);
    for (const f of ['title', 'summary', 'kind', 'presenter', 'voice']) if (e[f] == null) err(`${W}.${f}`, 'missing');
    if (!(e.secs > 0)) err(W + '.secs', 'missing');
  });
  return { errors, warnings };
}

// data/explainers/welcome.json → data/explainers/voice/welcome.{json,mp3}
export function voicePathFor(file) {
  const m = /^data\/explainers\/([a-z0-9][a-z0-9-]*)\.json$/.exec(String(file || ''));
  if (!m || m[1] === 'index') throw new Error(`"${file}" is not a video's file`);
  const base = `data/explainers/voice/${m[1]}`;
  return { json: `${base}.json`, audio: `${base}.mp3` };
}
// One scene as said, kept by what it says (tools/voice/speak.mjs sceneKey):
// a scene whose words have not changed is never said twice.
export function clipPathFor(key) {
  if (!/^[0-9a-f]{24}$/.test(String(key || ''))) throw new Error(`"${key}" is not a scene's key`);
  return { audio: `data/explainers/voice/clips/${key}.mp3`, json: `data/explainers/voice/clips/${key}.json` };
}

export function validateVoice(v, x) {
  const errors = [], warnings = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  if (!v || typeof v !== 'object') return { errors: ['the voice file is not a JSON object'], warnings };
  if (v.format !== VOICE_FORMAT) err('format', `"${v.format}", not "${VOICE_FORMAT}"`);
  if (!x || v.explainer !== x.id) err('explainer', `"${v.explainer}" is not ${x ? `"${x.id}"` : 'a video'}`);
  let paths = null;
  try { paths = voicePathFor(v.file); } catch (e) { err('file', e.message); }
  if (paths && v.audio !== paths.audio) err('audio', `"${v.audio}", not "${paths.audio}"`);
  if (!(v.duration > 0)) err('duration', 'missing');
  if (!Number.isInteger(v.bytes) || v.bytes <= 0) err('bytes', 'missing');
  if (typeof v.hash !== 'string' || !v.hash) err('hash', 'missing');
  const scenes = (x && x.scenes) || [];
  if (!Array.isArray(v.scenes)) { err('scenes', 'not a list'); return { errors, warnings }; }
  if (v.scenes.length !== scenes.length) err('scenes', `${v.scenes.length}, but the video has ${scenes.length}`);
  let last = 0;
  v.scenes.forEach((s, i) => {
    const W = `scenes[${i}]`, xs = scenes[i];
    if (!s || typeof s !== 'object') { err(W, 'not an object'); return; }
    try { const c = clipPathFor(s.key); if (s.clip !== c.audio) err(W + '.clip', `"${s.clip}", not "${c.audio}"`); } catch (e) { err(W + '.key', e.message); }
    if (!(s.start >= last - 0.01) || !(s.end > s.start)) err(W, `${s.start}–${s.end} s does not follow the scene before it`);
    if (s.end > v.duration + 0.05) err(W, `ends at ${s.end} s, after the audio (${v.duration} s)`);
    last = s.end;
    if (!xs) return;
    const who = xs.presenter || x.presenter;
    if (s.speaker !== who) err(W + '.speaker', `"${s.speaker}", but the scene is ${who}'s`);
    const n = wordsOf(xs.say).length;
    if (!Array.isArray(s.words) || s.words.length !== n) { err(W + '.words', `${Array.isArray(s.words) ? s.words.length : 'no'} times for ${n} words`); return; }
    let t = s.start - 0.01;
    for (let k = 0; k < s.words.length; k++) {
      const w = s.words[k];
      if (!(w >= t) || w > s.end + 0.01) { err(W + `.words[${k}]`, `${w} s is out of order or outside the scene`); break; }
      t = w;
    }
  });
  return { errors, warnings };
}

// ── the index, from the files ───────────────────────────────────────────────
// Every video in data/explainers/, the welcome first and then the how-tos, in
// the order of each file's own `order` (then its title); how long each runs
// as said where it has been voiced, else as written.

export function listFiles(repo) {
  const dir = path.join(repo, 'data', 'explainers');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^[a-z0-9][a-z0-9-]*\.json$/.test(f) && f !== 'index.json').sort().map(f => `data/explainers/${f}`) : [];
}

export function buildIndex(repo, { now = new Date() } = {}) {
  const items = listFiles(repo).map(file => {
    const x = JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
    let secs = (x.scenes || []).reduce((n, s) => n + (+s.secs || 0), 0);
    try {
      const vp = path.join(repo, voicePathFor(file).json);
      if (fs.existsSync(vp)) { const v = JSON.parse(fs.readFileSync(vp, 'utf8')); if (!validateVoice(v, x).errors.length) secs = Math.round(v.duration); }
    } catch (_) { /* as written */ }
    return { id: x.id, file, title: x.title, summary: x.summary, kind: x.kind, presenter: x.presenter, voice: x.voice, secs, updated: x.updated, order: Number.isFinite(x.order) ? x.order : 50 };
  });
  items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'welcome' ? -1 : 1) || a.order - b.order || String(a.title).localeCompare(String(b.title)));
  return { format: INDEX_FORMAT, updated_at: now.toISOString().replace(/\.\d+Z$/, 'Z'), explainers: items.map(({ order, ...e }) => e) };
}

export function writeIndex(repo, opts) {
  const ix = buildIndex(repo, opts);
  const p = path.join(repo, 'data', 'explainers', 'index.json');
  const old = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  // Rewritten only when what it lists has changed, so the time it was made
  // does not churn by itself.
  if (old && JSON.stringify(old.explainers) === JSON.stringify(ix.explainers)) return { changed: false, index: old };
  fs.writeFileSync(p, JSON.stringify(ix, null, 1) + '\n');
  return { changed: true, index: ix };
}

// ── command line ────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const argv = process.argv.slice(2);
  const files = argv.filter(a => a.endsWith('.json')).map(f => path.relative(REPO, path.resolve(f)));
  let failed = 0;
  for (const file of files.length ? files : listFiles(REPO)) {
    let x;
    try { x = JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8')); } catch (e) { console.log(`✗ ${file}: ${e.message}`); failed++; continue; }
    // A file outside data/explainers/ (a fixture, a draft elsewhere) is not held to its name.
    const shotsFile = path.join(REPO, 'data', 'explainers', 'shots', 'index.json');
    const shots = fs.existsSync(shotsFile) ? JSON.parse(fs.readFileSync(shotsFile, 'utf8')).shots : null;
    const r = validate(x, { file: file.startsWith('data/explainers/') ? file : null, shots });
    console.log(`${r.errors.length ? '✗' : '✓'} ${file}: ${(x.scenes || []).length} scenes, ${r.words} words, about ${r.secs} s said, ${x.voice}`);
    r.errors.forEach(e => console.log(`    error   ${e}`));
    r.warnings.forEach(w => console.log(`    warning ${w}`));
    if (r.errors.length) failed++;
  }
  if (argv.includes('--write-index') && !failed) {
    const { changed, index } = writeIndex(REPO);
    console.log(`${changed ? 'Wrote' : 'Unchanged:'} data/explainers/index.json — ${index.explainers.length} video${index.explainers.length === 1 ? '' : 's'}.`);
  }
  process.exit(failed ? 1 : 0);
}
