// 📺 Network Weather — the bulletin at the top of Station Health
// (health-bulletin.js) and the tools the scheduled task writes it with
// (tools/bulletin/: gather.mjs, draft.mjs, validate.mjs, publish.mjs).
//
// Node first, no network:
//
//   * every bulletin published in data/bulletins/ is one the page can draw:
//     valid against validate.mjs, its stations on file, listed in the index
//     newest first, and every file in the index there (and none that is not)
//   * the validator says what is wrong where: markup in a narration, a station
//     not on file, a scene that cannot be said in its seconds, a weekly that
//     covers a day
//   * the crew: the player's ROSTER and the validator's PRESENTERS are the same
//     Droggies, and each has a portrait in assets/presenters/
//   * the pipeline on the demo week — the Station Health tab's own week with a
//     fault planted per station: its facts hold the planted silent station as
//     a regular silence and the sliding battery; its draft is valid; publishing
//     it into a scratch copy writes the file and the index and lets the oldest go
//   * every scene of every bulletin drawn, wide and tall, by the player itself
//
// Then Chromium:
//
//   * the tab opens with the bulletin first: its forecast, headline and Play;
//     no page errors; every scene's drawing parses as SVG
//   * Play runs it: the scene moves on, the caption is revealed, the bar fills;
//     pause freezes it; a scene picked from the bar is drawn finished
//   * the week's readings landing redraw the tab around it and leave a playing
//     bulletin where it is — the same stage, still playing
//   * a station named in the scene opens on the tab below
//   * Today and This week; Hide is remembered; no bulletin yet says so
//   * a phone: drawn tall, the presenter beside the words, no sideways scroll;
//     reduced motion: nothing moves and the scene stands complete
//
// Run:  npm run bulletin

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { validate, validateIndex, PRESENTERS, SCENES } from '../tools/bulletin/validate.mjs';
import { buildFacts } from '../tools/bulletin/gather.mjs';
import { draft } from '../tools/bulletin/draft.mjs';
import { publish } from '../tools/bulletin/publish.mjs';
import { loadAnalysis } from '../tools/health/report.mjs';

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
const doc = readJson(path.join(REPO, 'stations.json'));
const ids = new Set(doc.stations.map(s => s.id));
const FIXTURE = readJson(path.join(HERE, 'fixtures', 'bulletin-all-scenes.json'));

// ── 1. what is published ────────────────────────────────────────────────────
console.log('Published bulletins');
const DIR = path.join(REPO, 'data', 'bulletins');
const index = fs.existsSync(path.join(DIR, 'index.json')) ? readJson(path.join(DIR, 'index.json')) : null;
ok('data/bulletins/index.json is there', !!index);
const published = [];
if (index) {
  const v = validateIndex(index);
  ok('the index is valid, newest first', !v.errors.length, v.errors.join('; '));
  for (const kind of ['daily', 'weekly']) {
    for (const e of index[kind] || []) {
      const p = path.join(REPO, e.file);
      ok(`${e.file} is there`, fs.existsSync(p));
      if (!fs.existsSync(p)) continue;
      const b = readJson(p);
      const r = validate(b, { stationIds: ids });
      ok(`${e.file} is a bulletin the page can draw`, !r.errors.length, r.errors.join('; '));
      ok(`${e.file} is the one its index entry says`, b.id === e.id && b.kind === kind && b.issued_at === e.issued_at && b.headline === e.headline);
      published.push(b);
    }
    const listed = new Set((index[kind] || []).map(e => path.basename(e.file)));
    const onDisk = fs.existsSync(path.join(DIR, kind)) ? fs.readdirSync(path.join(DIR, kind)).filter(f => f.endsWith('.json')) : [];
    const stray = onDisk.filter(f => !listed.has(f));
    ok(`every ${kind} file is in the index`, !stray.length, stray.join(', '));
  }
}

// ── 2. the validator ────────────────────────────────────────────────────────
console.log('The validator');
{
  const r = validate(FIXTURE, { stationIds: ids });
  ok('the fixture — one scene of every kind — is valid', !r.errors.length && !r.warnings.length, [...r.errors, ...r.warnings].join('; '));
  ok('…and holds every kind of scene', Object.keys(SCENES).every(t => FIXTURE.scenes.some(s => s.type === t)));
  const broken = JSON.parse(JSON.stringify(FIXTURE));
  broken.scenes[1].say = 'A <b>bold</b> claim';
  broken.scenes[1].marks[0].id = 'no_such_station_anywhere';
  broken.scenes[2].secs = 5;
  broken.scenes[2].say = Array.from({ length: 40 }, () => 'word').join(' ');
  broken.scenes.push({ type: 'hologram', title: 'x', say: 'y', secs: 6 });
  const e = validate(broken, { stationIds: ids });
  const has = (re, list = e.errors) => list.some(x => re.test(x));
  ok('markup in a narration is refused', has(/scenes\[1\].*say: holds markup/));
  ok('a station not on file is refused', has(/marks\[0\]\.id: "no_such_station_anywhere" is no station/));
  ok('a scene that cannot be said in its seconds is warned of', has(/scenes\[2\].*say: 40 words in 5 s/, e.warnings));
  ok('a kind of scene the page cannot draw is refused, and the last scene must be the sign-off', has(/scenes\[10\]\.type: "hologram"/) && has(/the last scene is the sign-off/));
  const wk = Object.assign({}, FIXTURE, { kind: 'weekly', id: 'weekly-2026-10-25' });
  ok('a weekly covering one day is refused', has(/period: 1\.0 days, not a weekly's/, validate(wk, { stationIds: ids }).errors));
}

// ── 3. the crew ─────────────────────────────────────────────────────────────
console.log('The crew');
const ctx = vm.createContext({
  console, state: { data: doc, activeTab: 'health' },
  esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  escAttr: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  performance: { now: () => Date.now() }, innerWidth: 1400,
});
vm.runInContext(fs.readFileSync(path.join(REPO, 'health-bulletin.js'), 'utf8') + '\nglobalThis.__HB = HealthBulletin;', ctx, { filename: 'health-bulletin.js' });
const HB = ctx.__HB;
{
  const roster = Object.keys(HB.ROSTER).sort(), list = PRESENTERS.slice().sort();
  ok('the player and the validator know the same presenters', JSON.stringify(roster) === JSON.stringify(list), `${roster} vs ${list}`);
  const missing = PRESENTERS.filter(id => !fs.existsSync(path.join(REPO, 'assets', 'presenters', `${id}.webp`)));
  ok('every presenter has a portrait', !missing.length, missing.join(', '));
  const big = PRESENTERS.filter(id => fs.existsSync(path.join(REPO, 'assets', 'presenters', `${id}.webp`)) && fs.statSync(path.join(REPO, 'assets', 'presenters', `${id}.webp`)).size > 60000);
  ok('…each small enough for a phone (under 60 KB)', !big.length, big.join(', '));
}

// ── 4. the pipeline, on the demo week ───────────────────────────────────────
console.log('The pipeline on the demo week');
let demoDraft = null;
{
  const NOW = Date.parse('2026-10-06T21:00:00Z');
  const api = loadAnalysis();
  api.setRegister(doc);
  const w = api.HealthAnalysis.demoWorld(20261006, { now: NOW, stations: doc.stations });
  const A = api.HealthAnalysis.run(w.rows, { t0: w.t0, t1: w.t1, now: w.now, stations: doc.stations });
  const p1 = w.now, p0 = p1 - 86400000;
  const facts = buildFacts({ kind: 'daily', A, rows: w.rows, doc, server: {}, now: p1, p0, p1, ctx0: w.t0 });
  const silent = A.findings.find(f => f.kind === 'silent' && f.severity !== 'info');
  ok('the demo week has its planted silent station', !!silent);
  ok('…which the facts hold as a regular silence, last heard on a receiver', silent && facts.silences.regular.some(x => x.station_id === silent.stationId && x.last_path),
    JSON.stringify(facts.silences.regular.map(x => x.station_id)));
  const falling = A.findings.find(f => f.kind === 'battery-falling');
  ok('…and its sliding battery among the batteries', falling && facts.batteries.some(b => b.station_id === falling.stationId), JSON.stringify(facts.batteries.map(b => b.station_id)));
  ok('the facts carry every day of the week, and a position for every station they name',
    facts.series.length >= 7 && Object.values(facts.stations).every(s => Number.isFinite(s.lat)), `${facts.series.length} days`);
  demoDraft = draft(facts);
  const r = validate(demoDraft, { stationIds: ids });
  ok('the draft from those facts is a valid bulletin', !r.errors.length, r.errors.join('; '));
  ok('…that opens with the title, names the silent station on its map, and signs off',
    demoDraft.scenes[0].type === 'title' && demoDraft.scenes.some(s => s.type === 'map' && s.marks.some(m => m.id === silent.stationId)) && demoDraft.scenes.at(-1).type === 'signoff',
    demoDraft.scenes.map(s => s.type).join(' '));

  // Publishing into a scratch copy: the file, the index, the oldest let go.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bulletin-'));
  fs.mkdirSync(path.join(tmp, 'data', 'bulletins', 'daily'), { recursive: true });
  const old = [];
  for (let k = 0; k < 15; k++) {
    const day = new Date(Date.parse('2026-09-01T00:00:00Z') + k * 86400000).toISOString().slice(0, 10);
    const b = Object.assign(JSON.parse(JSON.stringify(demoDraft)), { id: `daily-${day}`, issued_at: `${day}T19:00:00.000Z` });
    const out = publish(b, { repo: tmp, ids, log: () => {} });
    if (!out.ok) { ok('a draft publishes', false, out.errors.join('; ')); break; }
    old.push(day);
  }
  const ix = readJson(path.join(tmp, 'data', 'bulletins', 'index.json'));
  ok('publishing keeps the newest fourteen dailies, newest first', ix.daily.length === 14 && ix.daily[0].id === `daily-${old.at(-1)}` && !validateIndex(ix).errors.length);
  ok('…and lets the oldest file go', !fs.existsSync(path.join(tmp, 'data', 'bulletins', 'daily', `${old[0]}.json`)) && fs.existsSync(path.join(tmp, 'data', 'bulletins', 'daily', `${old[1]}.json`)));
  const again = publish(Object.assign(JSON.parse(JSON.stringify(demoDraft)), { id: `daily-${old.at(-1)}`, issued_at: `${old.at(-1)}T20:00:00.000Z` }), { repo: tmp, ids, log: () => {} });
  const ix2 = readJson(path.join(tmp, 'data', 'bulletins', 'index.json'));
  ok('a second bulletin the same day replaces the first', again.ok && ix2.daily.length === 14 && ix2.daily.filter(e => e.id === `daily-${old.at(-1)}`).length === 1);
  const bad = publish(Object.assign(JSON.parse(JSON.stringify(demoDraft)), { headline: '<script>x</script>' }), { repo: tmp, ids, log: () => {} });
  ok('a draft with a problem is not published, and says why', !bad.ok && bad.errors.some(x => /headline: holds markup/.test(x)));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 5. every scene drawn, by the player itself ─────────────────────────────
console.log('Every scene drawn');
{
  const all = [FIXTURE, ...published, ...(demoDraft ? [demoDraft] : [])];
  const bad = [];
  for (const b of all) for (const s of b.scenes) for (const narrow of [false, true]) {
    const svg = HB._draw(s, b, narrow);
    if (!/^<svg[\s\S]*<\/svg>$/.test(svg.trim()) || /could not be drawn|does not know how to draw/.test(svg) || /NaN|undefined/.test(svg))
      bad.push(`${b.id} ${s.type}${narrow ? ' (tall)' : ''}: ${(svg.match(/NaN|undefined|could not be drawn[^<]*/) || [''])[0]}`);
  }
  ok(`every scene of ${all.length} bulletins draws, wide and tall, with no NaN or undefined in it`, !bad.length, bad.join('\n         '));
}

// ── 6. in Chromium ──────────────────────────────────────────────────────────
console.log('In Chromium');
const { startServer } = await import('./lib/server.mjs');
const { launchBrowser } = await import('./lib/browser.mjs');
const { applyNetworkPolicy } = await import('./lib/network.mjs');
const server = await startServer();
const browser = await launchBrowser();
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const fixFile = 'data/bulletins/daily/2026-10-25.json';
const weekFile = 'data/bulletins/weekly/2026-10-25.json';
const week = Object.assign(JSON.parse(JSON.stringify(FIXTURE)), { kind: 'weekly', id: 'weekly-2026-10-25', presenter: 'seasoned-hydrographer',
  headline: 'A week of the Hillcrest repeater.', period: { from: '2026-10-17T19:00:00Z', to: '2026-10-24T19:00:00Z', label: 'The seven days 18 to 25 Oct' } });
const fixIndex = { format: 'floodnet-bulletin-index/1', updated_at: FIXTURE.issued_at,
  daily: [{ id: FIXTURE.id, file: fixFile, issued_at: FIXTURE.issued_at, headline: FIXTURE.headline, sky: FIXTURE.outlook.sky }],
  weekly: [{ id: week.id, file: weekFile, issued_at: week.issued_at, headline: week.headline, sky: week.outlook.sky }] };
async function page(opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 1000 }, timezoneId: 'Australia/Brisbane', reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
  const pg = await context.newPage();
  const errors = [];
  pg.on('pageerror', e => errors.push(e.message));
  await applyNetworkPolicy(pg, server.origin);
  await pg.route('**/data/bulletins/index.json', r => (opts.none ? r.fulfill({ status: 404, body: 'not found' })
    : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixIndex) })));
  await pg.route('**/' + fixFile, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE) }));
  await pg.route('**/' + weekFile, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(week) }));
  await pg.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof state !== 'undefined' && state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
  await pg.evaluate(() => switchTab('health'));
  return { pg, context, errors };
}
const until = (pg, fn, arg, timeout = 20_000) => pg.waitForFunction(fn, arg, { timeout });
try {
  // ── the bulletin first ──
  const { pg, context, errors } = await page();
  await until(pg, () => !!document.querySelector('#hb-stage svg'));
  const first = await pg.evaluate(() => {
    const panel = document.getElementById('hb-panel');
    const page = document.querySelector('.hl-page');
    return { firstChild: page && page.firstElementChild && page.firstElementChild.id, text: panel.textContent.replace(/\s+/g, ' '),
             play: !!document.querySelector('.hb-bigplay'), still: document.getElementById('hb-stage').classList.contains('is-still') };
  });
  ok('the tab opens with the bulletin, above everything else', first.firstChild === 'hb-slot');
  ok('…its forecast, headline and Play showing, drawn finished', /Patchy, clearing later/.test(first.text) && /Ten stations around Henderson Creek/.test(first.text) && first.play && first.still, first.text.slice(0, 300));
  const parse = await pg.evaluate(fx => fx.scenes.map((s, i) => {
    const svg = HealthBulletin._draw(s, fx, false);
    const d = new DOMParser().parseFromString(svg, 'image/svg+xml');
    return d.querySelector('parsererror') ? `${i} ${s.type}: ${d.querySelector('parsererror').textContent.slice(0, 160)}` : null;
  }).filter(Boolean), FIXTURE);
  ok('every scene\'s drawing parses as SVG', !parse.length, parse.join('\n'));

  // ── play, pause, pick ──
  await pg.click('#hb-play');
  await until(pg, () => HealthBulletin._state().playing && !document.querySelector('.hb-bigplay'));
  await pg.waitForTimeout(1300);
  const playing = await pg.evaluate(() => ({ said: document.querySelectorAll('#hb-caption .hb-w.is-said').length, all: document.querySelectorAll('#hb-caption .hb-w').length,
    fill: parseFloat(document.querySelector('.hb-seg.is-on .hb-seg-fill').style.getPropertyValue('--p')), talking: !!document.querySelector('#hb-presenter img.is-talking') }));
  ok('Play: the caption is said a word at a time, the bar fills, the presenter talks', playing.said > 0 && playing.said < playing.all && playing.fill > 0 && playing.talking, JSON.stringify(playing));
  const stage = await pg.$('#hb-stage');
  await pg.evaluate(() => Health.demo());
  await until(pg, () => !!document.querySelector('.hl-attn'));
  const kept = await pg.evaluate(el => ({ same: document.getElementById('hb-stage') === el, playing: HealthBulletin._state().playing }), stage);
  ok('the week landing redraws the tab around a playing bulletin and leaves it playing', kept.same && kept.playing, JSON.stringify(kept));
  await pg.evaluate(() => HealthBulletin.next());
  ok('⏭ moves to the next scene', await pg.evaluate(() => HealthBulletin._state().scene === 1 && /low over Logan/.test(document.getElementById('hb-lower').textContent)));
  await pg.click('#hb-play');
  ok('Pause freezes it', await pg.evaluate(() => !HealthBulletin._state().playing && document.getElementById('hb-stage').classList.contains('is-paused')));
  await pg.click('.hb-seg:nth-child(5)');
  const picked = await pg.evaluate(() => ({ scene: HealthBulletin._state().scene, still: document.getElementById('hb-stage').classList.contains('is-still'),
    who: document.querySelector('#hb-presenter figcaption b').textContent, chips: document.getElementById('hb-chips').textContent }));
  ok('a scene picked from the bar is drawn finished, with its own presenter and stations', picked.scene === 4 && picked.still && picked.who === 'Alex Chen' && /Ipswich AL/.test(picked.chips), JSON.stringify(picked));

  // ── a station opened ──
  await pg.evaluate(() => HealthBulletin.go(1));
  await pg.click('#hb-chips button');
  await pg.waitForTimeout(300);
  const opened = await pg.evaluate(() => Health.picked());
  ok('a station named in the scene opens on the tab below', opened === 'henderson_ck_al', String(opened));

  // ── today, this week, hide ──
  await pg.click('.hb-tools button:has-text("This week")');
  await until(pg, () => /A week of the Hillcrest repeater/.test(document.getElementById('hb-panel').textContent));
  ok('This week shows the weekly, presented by Graham', await pg.evaluate(() => HealthBulletin._state().kind === 'weekly' && /Graham Watts/.test(document.querySelector('#hb-presenter').textContent)));
  await pg.click('.hb-tools button:has-text("Hide")');
  const hidden = await pg.evaluate(() => ({ body: !!document.getElementById('hb-body'), kept: localStorage.getItem('mn-hb-hidden'), folded: (document.querySelector('.hb-folded') || {}).textContent || '' }));
  ok('Hide folds it to its headline, and the device remembers', !hidden.body && hidden.kept === '1' && /A week of the Hillcrest repeater/.test(hidden.folded), JSON.stringify(hidden));
  await pg.click('.hb-tools button:has-text("Show")');
  ok(`no page errors`, !errors.length, errors.join('\n'));
  await context.close();

  // ── no bulletin yet ──
  {
    const { pg, context, errors } = await page({ none: true });
    await until(pg, () => /No bulletin to show|No bulletin yet/.test((document.getElementById('hb-panel') || {}).textContent || ''));
    ok('with no bulletin yet, the panel says so and how one comes', await pg.evaluate(() => /scheduled task writes one every morning/.test(document.getElementById('hb-panel').textContent)));
    ok('…and nothing breaks', !errors.length, errors.join('\n'));
    await context.close();
  }

  // ── a phone, and reduced motion ──
  {
    const { pg, context, errors } = await page({ viewport: { width: 375, height: 800 }, reduced: true });
    await until(pg, () => !!document.querySelector('#hb-stage svg'));
    await pg.waitForTimeout(400);
    const phone = await pg.evaluate(() => {
      const svg = document.querySelector('#hb-stage svg'), vb = svg.getAttribute('viewBox').split(' ').map(Number);
      const av = document.querySelector('#hb-caption .hb-avatar');
      return { tall: vb[3] > vb[2], avatar: av && getComputedStyle(av).display !== 'none', rail: getComputedStyle(document.querySelector('.hb-presenter')).display,
               wide: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    ok('on a phone the scene is drawn tall and the presenter sits beside the words', phone.tall && phone.avatar && phone.rail === 'none', JSON.stringify(phone));
    ok('…with no sideways scroll', phone.wide <= 1, `${phone.wide}px wider than the screen`);
    await pg.evaluate(() => HealthBulletin.play());
    await pg.waitForTimeout(200);
    const still = await pg.evaluate(() => [...document.querySelectorAll('#hb-stage .hb-a-rise, #hb-stage .hb-a-pop')].every(el => getComputedStyle(el).animationName === 'none' && getComputedStyle(el).opacity === '1'));
    ok('reduced motion: nothing moves and the scene stands complete', still);
    ok('…and no page errors', !errors.length, errors.join('\n'));
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
console.log('\nNetwork Weather: all checks passed.');
