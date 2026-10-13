// The AEP flood levels (0033) and the indicative flood velocity worked out
// from them (flood-velocity.js), on the station card and in the station editor.
//
//   1. **The arithmetic**, off the page: Manning's equation against figures
//      worked by hand, the critical-flow cap, the channel bed (the gauge zero,
//      but not a storage's and not one 30 m down), the slope's sources and its
//      bounds, a recorded setting and an entered roughness — and the default
//      slopes flood-velocity.js carries against the ones the ingest wrote into
//      data/aep-levels.json, because two copies of a table drift.
//   2. **The copies agree**: every box the editor's AEP row has is a column of
//      meganet.station_aep_level, and the levels the maths reads are the ones
//      the table stores.
//   3. **The card**: a "Flood levels (AEP)" section flagged indicative, the
//      velocity line straight after the wind region carrying the same figure
//      the module computes, the far-off sheet position said out loud, and
//      nothing at all for a station neither sheet names.
//   4. **The editor**: the velocity beside the wind region, and the setting
//      picked on the AEP row going out in the save — only that list.
//
// Run:  npm run floodlevels
//       npm run floodlevels -- -v

import fs from 'node:fs';
import vm from 'node:vm';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const SQL      = fs.readFileSync(repo('db/migrations/0033_aep_levels_and_frequencies.sql'), 'utf8');
const AEP      = JSON.parse(fs.readFileSync(repo('data/aep-levels.json'), 'utf8'));
const STATIONS = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;

function tableColumns(sql, table) {
  const m = new RegExp(`create table if not exists meganet\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  if (!m) return [];
  return m[1].split('\n').map(l => /^\s{2}([a-z_0-9]+)\s/.exec(l)).filter(Boolean).map(x => x[1])
    .filter(c => c !== 'primary' && c !== 'constraint');
}

function loadModule() {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(repo('flood-velocity.js'), 'utf8') + '\n;this.FloodVelocity = FloodVelocity;', ctx);
  return ctx.FloodVelocity;
}

function arithmetic(FV) {
  log('\nThe arithmetic\n');

  // V = (1/n) d^(2/3) S^(1/2): 2 m deep, 1:1,000, n 0.040.
  const want = (1 / 0.04) * Math.pow(2, 2 / 3) * Math.sqrt(0.001);
  const m = FV.manning(2, 0.001, 0.04);
  check('Manning, wide flow: 2 m deep at 1:1,000 with n 0.040 is 1.255 m/s',
    near(m.v, want) && near(m.v, 1.2549, 1e-3) && !m.capped, JSON.stringify(m));
  const c = FV.manning(0.5, 0.02, 0.01);
  check('…held to critical flow, √(g·d), where it would run faster',
    c.capped && near(c.v, Math.sqrt(9.81 * 0.5)), JSON.stringify(c));
  check('…and no depth is no velocity', FV.manning(0, 0.001, 0.04).v === 0 && FV.manning(-1, 0.001, 0.04).v === 0);

  const meta = AEP.meta.default_slopes.map(b => ({ below: b.below_m, slope: b.slope }));
  check('the default slopes are the ones the ingest wrote into data/aep-levels.json',
    JSON.stringify(meta) === JSON.stringify(FV.DEFAULT_SLOPES),
    JSON.stringify({ json: meta, js: FV.DEFAULT_SLOPES }));
  check('the four levels are the four the sheets give, most frequent first',
    JSON.stringify(FV.LEVELS.map(l => l.key)) === JSON.stringify(['aep_1_m', 'aep_0_5_m', 'aep_0_2_m', 'aep_0_066_m'])
      && FV.LEVELS.every(l => tableColumns(SQL, 'station_aep_level').includes(l.key)));

  const row = { as_at: '2026-09-26', ground_m: 20, aep_1_m: 22, aep_0_066_m: 23, slope: 0.001,
                slope_basis: 'a neighbour' };
  const base = { name: 'Test Creek AL', aep_levels: [row],
                 gauge_survey: [{ valid_from: '2000-01-01', gauge_zero_m: 17, datum: 'AHD' }] };
  const e = FV.estimate(base);
  const ch = e && e.settings.find(t => t.key === 'channel');
  const fp = e && e.settings.find(t => t.key === 'floodplain');
  check('with no setting recorded, both are worked out, the channel headlined',
    e && e.settings.length === 2 && e.chosen === 'channel' && e.recorded === null);
  check('the channel\'s bed is the gauge zero in force, and its depth is over that',
    ch && ch.bed === 17 && ch.bedBasis === 'the gauge zero' && near(ch.max.depth, 6)
      && near(ch.max.v, FV.manning(6, 0.001, 0.04).v), JSON.stringify(ch && ch.max));
  check('the floodplain\'s is the sheet\'s ground, at n 0.060',
    fp && fp.bed === 20 && near(fp.max.depth, 3) && near(fp.max.v, FV.manning(3, 0.001, 0.06).v));
  check('the fastest level is the rarest flood\'s',
    ch && ch.max.key === 'aep_0_066_m' && ch.levels.length === 2);

  const storage = FV.estimate({ ...base, name: 'Test Dam HW AL' });
  check('a storage\'s gauge zero is no bed',
    storage.storage && storage.settings.find(t => t.key === 'channel').bed === 20);
  const deep = FV.estimate({ ...base, gauge_survey: [{ gauge_zero_m: -15, datum: 'AHD' }] });
  check('…nor is one more than 30 m below the ground',
    deep.settings.find(t => t.key === 'channel').bed === 20);
  const assumed = FV.estimate({ ...base, gauge_survey: [{ gauge_zero_m: 17, datum: 'ASSUM' }] });
  check('…nor one in an assumed datum',
    assumed.settings.find(t => t.key === 'channel').bed === 20);

  const def = FV.estimate({ ...base, aep_levels: [{ ...row, slope: undefined, slope_basis: undefined }] });
  check('with no slope of its own, a station takes its ground height\'s default, and says so',
    def.slope.source === 'default' && def.slope.raw === FV.DEFAULT_SLOPES[1].slope
      && /median slope/.test(def.slope.basis), JSON.stringify(def.slope));
  const flat = FV.estimate({ ...base, aep_levels: [{ ...row, slope: 0.000008 }] });
  check('a slope flatter than 1:10,000 is read as 1:10,000, and flagged',
    flat.slope.used === FV.SLOPE_MIN && flat.slope.bounded && flat.slope.raw === 0.000008);

  const rec = FV.estimate({ ...base, aep_levels: [{ ...row, setting: 'floodplain', manning_n: 0.1 }] });
  check('a recorded setting is the only one worked out, with the roughness entered for it',
    rec.recorded === 'floodplain' && rec.settings.length === 1 && rec.settings[0].n === 0.1
      && rec.settings[0].nSource === 'entered');
  check('nothing to work from is no estimate: no row, no ground, or no level',
    FV.estimate({}) === null
      && FV.estimate({ aep_levels: [{ aep_1_m: 3 }] }) === null
      && FV.estimate({ aep_levels: [{ ground_m: 3 }] }) === null);
  check('the newest row is the one read, then the more confident',
    FV.pickRow({ aep_levels: [{ as_at: '2026-01-01', confidence: 9 }, { as_at: '2026-09-26', confidence: 2 },
                              { as_at: '2026-09-26', confidence: 6 }] }).confidence === 6);
  check('slopes and speeds are said the way a person says them',
    FV.slopeRatio(0.001) === '1:1,000' && FV.slopeRatio(0.00027) === '1:3,700'
      && FV.speed(2.449) === '2.4' && FV.speed(0.04) === '<0.1' && FV.speed(0) === '0');
}

// A patch of the twin's own shape (digital-twin.js): 201 × 201 samples over
// `size` m, row 0 the north edge, x east and z south of the station at the
// middle sample — the grid FloodVelocity.flowLine is handed there.
function patch(size, f) {
  const n = 201, step = size / (n - 1), half = size / 2, elev = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) elev[j * n + i] = f(-half + i * step, -half + j * step);
  return { elev, n, size };
}
// A channel 4 m deep and ~10 m wide whose middle is at x = c(z).
const channel = (x, z, c) => 4 * Math.exp(-(((x - c) / 5) ** 2));

function twinArithmetic(FV) {
  log('\nIn the digital twin: the flow line, the two figures, the bands\n');

  // A straight channel at x = −20 running north–south, its bed and the ground
  // either side falling 1:500 to the north.
  const straight = patch(400, (x, z) => 100 + 0.002 * z - channel(x, z, -20));
  const a = FV.flowLine(straight);
  const mid = a.ok ? a.points.slice(Math.floor(a.points.length * 0.05), Math.ceil(a.points.length * 0.95)) : [];
  check('a straight channel: traced along its bed, 4 m under the ground beside it, round the station',
    a.ok && a.stands && mid.every(p => Math.abs(p.x + 20) < 2.5) && Math.abs(a.start.x + 20) < 2.5,
    JSON.stringify(a.ok ? { start: a.start, worst: Math.max(...mid.map(p => Math.abs(p.x + 20))) } : a));
  check('…from its upstream end to its downstream one, north, as the bed falls',
    a.ok && a.points[0].z > 0 && a.points[a.points.length - 1].z < 0 && (a.bearing < 3 || a.bearing > 357) && a.falls,
    a.ok ? `bearing ${a.bearing.toFixed(1)}, heading ${a.heading.toFixed(1)}` : '');
  check('…to the ring 20 m in from the patch\'s edge, both ways: 358 m of it',
    a.ok && a.length > 340 && a.length < 370 && near(a.ring, 180), a.ok ? `${a.length.toFixed(1)} m` : '');
  check('…and its slope is the bed\'s, 1:500, to 2%',
    a.ok && near(a.slope, 0.002, 0.002 * 0.02) && FV.slopeRatio(a.slope) === '1:500', a.ok ? `${a.slope}` : '');

  // The same fall, but the channel meanders: x = 50 sin(2πz / 250). The slope
  // along the bed is the valley's over the sinuosity.
  const bend = z => 50 * Math.sin(2 * Math.PI * z / 250);
  const meander = patch(400, (x, z) => 100 + 0.002 * z - channel(x, z, bend(z)));
  const m = FV.flowLine(meander);
  const off = m.ok ? m.points.slice(Math.floor(m.points.length * 0.05), Math.ceil(m.points.length * 0.95)).map(p => Math.abs(p.x - bend(p.z))) : [];
  check('a meander: the line keeps to the bed round every bend, where a straight one would climb the banks',
    m.ok && m.stands && off.length && Math.max(...off) < 4 && m.sinuosity > 1.2, m.ok ? `worst ${Math.max(...off).toFixed(2)} m off, sinuosity ${m.sinuosity.toFixed(2)}` : JSON.stringify(m));
  const fallM = m.ok ? 0.002 * (m.points[0].z - m.points[m.points.length - 1].z) : 0;
  check('…and its slope is the fall along the bed over the length of the bed, not of the valley',
    m.ok && m.falls && near(m.slope, fallM / m.length, (fallM / m.length) * 0.05) && m.slope < 0.0018,
    m.ok ? `${m.slope} against ${fallM / m.length}` : '');

  // A weir: a metre-high sill across the channel at z = 60. Theil–Sen is the
  // median of the pairs' slopes, which a step moves little.
  const weir = patch(400, (x, z) => 100 + 0.002 * z - channel(x, z, -20) + (Math.abs(z - 60) < 3 && Math.abs(x + 20) < 12 ? 1 : 0));
  const w = FV.flowLine(weir);
  check('a metre-high weir across it moves the slope less than 5%', w.ok && near(w.slope, 0.002, 0.0001), w.ok ? `${w.slope}` : JSON.stringify(w));

  // A pool: the bed level from end to end, as LiDAR reads a pool's water.
  const pool = FV.flowLine(patch(400, (x, z) => 100 - channel(x, z, -20)));
  check('a pool, flat end to end: a channel, but one that falls too little to say which way',
    pool.ok && pool.stands && !pool.falls && !pool.clear && pool.slope < 1e-6, JSON.stringify(pool.ok ? { slope: pool.slope, agree: pool.agree } : pool));

  // No channel: a plane tilted 1:200 to the east.
  const plane = FV.flowLine(patch(400, (x, z) => 100 - 0.005 * x));
  check('a plane with no channel in it: traced, and said to have none standing out',
    plane.ok && !plane.stands && !plane.clear, JSON.stringify(plane.ok ? plane.contrast : plane));

  // Two channels: the gauge's 60 m reach a flat drain 1 m deep at x = 10, and
  // the river, 4 m deep and falling 1:500, is at x = −100. Traced from the
  // gauge the line follows the drain; from a point clicked on the river, the
  // river — the lowest ground within the 12 m the twin gives a click.
  const two = patch(400, (x, z) => 100 + 0.002 * z * (Math.abs(x + 100) < 30 ? 1 : 0) - channel(x, z, -100)
    - 1 * Math.exp(-(((x - 10) / 3) ** 2)));
  const drain = FV.flowLine(two), river = FV.flowLine(two, { from: { x: -97, z: 40 }, near: 12 });
  check('from the gauge, the drain its 60 m reach; from a point clicked on the river, the river and its fall',
    drain.ok && Math.abs(drain.start.cell.x - 10) < 3 && river.ok && Math.abs(river.start.cell.x + 100) < 3
      && river.stands && river.falls && near(river.slope, 0.002, 0.0002),
    JSON.stringify({ drain: drain.ok && drain.start.cell, river: river.ok && { start: river.start.cell, slope: river.slope } }));
  check('nothing to trace on is said, not guessed', FV.flowLine({ elev: new Float32Array(9), n: 3, size: 4 }).ok === false
    && FV.flowLine(patch(400, () => NaN)).ok === false);

  // The two figures at a level: each Manning over its own depth, the one slope.
  const at = FV.atLevel(102, { bed: 90, ground: 99, slope: 0.001, nChannel: 0.04, nPlain: 0.06 });
  check('the two figures at a station: the channel over its bed, the station\'s ground at the floodplain\'s roughness',
    near(at.channel.depth, 12) && near(at.channel.v, FV.manning(12, 0.001, 0.04).v) && near(at.ground.depth, 3)
      && near(at.ground.v, FV.manning(3, 0.001, 0.06).v) && at.ground.v < at.channel.v, JSON.stringify(at));
  check('…and the ground over the water is dry, not slow', FV.atLevel(98, { bed: 90, ground: 99, slope: 0.001, nChannel: 0.04, nPlain: 0.06 }).ground.v === 0);
  check('a slope is held between 1:10,000 and 1:50 wherever it came from',
    FV.bound(0.00001).used === FV.SLOPE_MIN && FV.bound(0.00001).bounded && FV.bound(0.1).used === FV.SLOPE_MAX && !FV.bound(0.001).bounded);

  // The bands, and the copies of their colours in styles.css.
  check('the speed bands: under 0.5, by halves to 2, 2–3, and 3 and over',
    JSON.stringify(FV.SPEEDS.map((_, i) => FV.speedBandWords(i))) === JSON.stringify(['under 0.5', '0.5–1', '1–1.5', '1.5–2', '2–3', '3 and over'])
      && FV.speedBand(0) === 0 && FV.speedBand(0.499) === 0 && FV.speedBand(0.5) === 1 && FV.speedBand(2.999) === 4 && FV.speedBand(3) === 5 && FV.speedBand(40) === 5);
  const css = fs.readFileSync(repo('styles.css'), 'utf8');
  const tokenOk = FV.SPEEDS.every(b => new RegExp(`${b.token}:\\s*${b.hex}\\b`, 'i').test(css));
  check('…their colours are the --flood-speed-* tokens in styles.css, one blue paling to deep',
    tokenOk && FV.SPEEDS.every((b, i) => i === 0 || parseInt(b.hex.slice(1), 16) !== parseInt(FV.SPEEDS[i - 1].hex.slice(1), 16)),
    FV.SPEEDS.map(b => `${b.token} ${b.hex}`).join(', '));

  // Chow's table: the card's two defaults are rows of it, in its words.
  const ch = FV.ROUGHNESS.channel, fp = FV.ROUGHNESS.floodplain;
  check('the roughness tables are Chow\'s, the card\'s defaults among them in its words',
    FV.roughnessWords('channel', 0.04) === 'clean and winding, some pools and shoals'
      && FV.roughnessWords('floodplain', 0.06) === 'light brush and trees'
      && FV.SETTINGS.every(t => FV.ROUGHNESS[t.key].some(r => r.n === t.n)) && FV.roughnessWords('channel', 0.0423) === null);
  check('…every n inside the bounds 0033 holds manning_n to, and in order',
    [ch, fp].every(t => t.every((r, i) => r.n >= FV.N_MIN && r.n <= FV.N_MAX && (i === 0 || r.n > t[i - 1].n)))
      && /manning_n between 0\.01 and 0\.3/.test(SQL) && FV.N_MIN === 0.01 && FV.N_MAX === 0.3);
}

async function openStations(browser, server, errors, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
    null, { timeout: LOAD_TIMEOUT });
  return { context, page };
}

async function main() {
  const FV = loadModule();
  arithmetic(FV);
  twinArithmetic(FV);

  // Picked from the file, so the checks follow the data: a station whose sheet
  // point is far from its own, one with a slope from a neighbour, one with an
  // AEP row and no level, and one neither sheet names.
  const far = STATIONS.find(s => s.id === 'loudoun_br_al');
  const sloped = STATIONS.find(s => (s.aep_levels || []).some(r => r.slope != null && r.aep_1_m != null)
    && s.lat != null && s.id !== 'loudoun_br_al');
  const bare = STATIONS.find(s => (s.aep_levels || []).length && FV.estimate(s) === null && s.lat != null);
  const none = STATIONS.find(s => !s.aep_levels && s.lat != null);

  log('\nThe copies agree\n');
  // 701 the ingest attaches, and since the snapshot of 2026-10-08 Proposed
  // Gatton Auto, the proposal beside Gatton, with Gatton's.
  const n = STATIONS.filter(s => s.aep_levels).length;
  check('stations.json carries the AEP rows the ingest attaches (701 stations), and the proposal beside Gatton its own copy',
    n === 702 && STATIONS.find(s => s.id === 'proposed_gatton_auto').aep_levels.length === 1, String(n));

  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const { context, page } = await openStations(browser, server, errors, { viewport: { width: 1440, height: 1000 } });

    // The editor's boxes, off a row added to it and taken away again.
    await page.evaluate(id => selectStation(id), sloped.id);
    await page.waitForSelector('#ef-rhs-aep_levels');
    const keys = await page.evaluate(() => {
      RiverDetails.addRow('aep_levels');
      const k = [...new Set([...document.querySelectorAll('#ef-rhs-aep_levels .rhs-row:first-child [data-f]')].map(e => e.dataset.f))];
      document.querySelector('#ef-rhs-aep_levels .rhs-row:first-child .rhs-del').click();
      return k;
    });
    const cols = tableColumns(SQL, 'station_aep_level');
    const stray = keys.filter(k => !cols.includes(k));
    check('every box on an AEP row has a column in meganet.station_aep_level',
      keys.length > 10 && !stray.length, stray.length ? `no column for ${stray.join(', ')}` : '');

    log('\nThe card\n');

    const read = async id => page.evaluate(id => {
      showStationCard(id);
      const card = document.getElementById('stn-card');
      const sect = card.querySelector('.stn-card-aep');
      const vel = card.querySelector('.stn-card-vel');
      // The rows round the velocity's own: the card has grown sections ahead
      // of this one (the owner's), so it is found by the row it holds.
      const top = vel ? [...vel.parentElement.children] : [];
      const wind = top.findIndex(e => e.textContent.trim().startsWith('Wind region'));
      return {
        section: !!sect,
        head: sect ? sect.querySelector('.stn-card-rhs-head').textContent.trim() : '',
        flag: sect ? sect.querySelector('.stn-card-rhs-snap').textContent.trim() : '',
        levels: sect ? [...sect.querySelectorAll(':scope > .acma-row')].map(r => r.children[0].textContent.trim()) : [],
        position: sect ? [...sect.querySelectorAll(':scope > .acma-row')].some(r => /The sheet places this station/.test(r.textContent)) : false,
        velLines: sect ? [...sect.querySelectorAll('.stn-card-aep-vel .mn-pop-line')].map(e => e.textContent.trim()) : [],
        how: sect ? !!sect.querySelector('.stn-card-aep-how') : false,
        vel: vel ? vel.children[1].textContent.replace(/\s+/g, ' ').trim() : null,
        velAfterWind: vel ? (wind >= 0 && top[wind + 1] === vel) : false,
      };
    }, id);

    const f = await read(far.id);
    const est = FV.estimate(far);
    check('a station the sheets name has a "Flood levels (AEP)" section, flagged modelled and indicative',
      f.section && f.head === 'Flood levels (AEP)' && /Modelled — indicative/.test(f.flag), JSON.stringify(f));
    check('…a line for each of the four floods, the ground and the sheet\'s confidence',
      ['1% AEP', '0.5% AEP', '0.2% AEP', '0.066% AEP', 'Ground', 'Confidence'].every(l => f.levels.includes(l)),
      JSON.stringify(f.levels));
    check('…the sheet\'s point, 29 km from the station\'s, said out loud', f.position);
    const ch = est.settings.find(t => t.key === 'channel'), fp = est.settings.find(t => t.key === 'floodplain');
    check('the velocity line comes straight after the wind region',
      f.velAfterWind, JSON.stringify(f.vel));
    check('…carrying the module\'s own figures for both settings, flagged indicative',
      f.vel && f.vel.includes(`≈ ${FV.speed(ch.max.v)} m/s channel`) && f.vel.includes(`${FV.speed(fp.max.v)} floodplain`)
        && /indicative/.test(f.vel), JSON.stringify({ card: f.vel, ch: ch.max.v, fp: fp.max.v }));
    check('the section gives a line per setting and the workings behind a disclosure',
      f.velLines.length === 2 && f.velLines[0].startsWith('Channel') && f.how, JSON.stringify(f.velLines));

    if (bare) {
      const b = await read(bare.id);
      check('a station the sheet gives no level for has the section, and no velocity line',
        b.section && b.vel === null && b.velLines.length === 0, `${bare.id} ${JSON.stringify(b)}`);
    }
    const o = await read(none.id);
    check('a station neither sheet names has neither the section nor the line',
      !o.section && o.vel === null, none.id);

    log('\nThe editor\n');

    await page.evaluate(id => {
      if (state.selectedId !== id) selectStation(id);
      dockReveal(document.getElementById('stations-editor-card'));
    }, sloped.id);
    await page.waitForSelector('#ef-flood-vel');
    const ed = await page.evaluate(() => ({
      vel: document.getElementById('ef-flood-vel').value,
      readonly: document.getElementById('ef-flood-vel').readOnly,
      afterWind: document.getElementById('ef-wind').closest('label').nextElementSibling
        === document.getElementById('ef-flood-vel').closest('label'),
      rows: document.querySelectorAll('#ef-rhs-aep_levels .rhs-row').length,
      untouched: !('aep_levels' in editorReadForm()),
    }));
    check('the editor has the velocity read-only, beside the wind region',
      ed.readonly && ed.afterWind && /indicative/.test(ed.vel), JSON.stringify(ed));
    check('…and the station\'s AEP rows, shut, with an untouched form sending none of them',
      ed.rows === sloped.aep_levels.length && ed.untouched, JSON.stringify(ed));

    await page.evaluate(() => { document.querySelector('#ef-rhs-aep_levels .rhs-row').open = true; });
    await page.selectOption('#ef-rhs-aep_levels .rhs-row [data-f="setting"]', 'channel');
    const sent = await page.evaluate(() => {
      const d = editorReadForm();
      return { keys: ['flood_classes', 'crossings', 'gauge_survey', 'aep_levels'].filter(k => k in d),
               row: d.aep_levels && d.aep_levels[0], sum: document.querySelector('#ef-rhs-aep_levels .rhs-sum').textContent };
    });
    check('picking a setting sends the AEP list and only it, the rest of the row as it was',
      JSON.stringify(sent.keys) === '["aep_levels"]' && sent.row && sent.row.setting === 'channel'
        && sent.row.aep_1_m === sloped.aep_levels[0].aep_1_m && sent.row.slope === sloped.aep_levels[0].slope,
      JSON.stringify(sent));
    check('…and the row\'s one line says so', /setting: channel/.test(sent.sum), sent.sum);

    await context.close();

    log('\nThe phone\n');
    const phone = await openStations(browser, server, errors, { viewport: { width: 375, height: 800 } });
    await phone.page.evaluate(id => { showStationCard(id); for (const d of document.querySelectorAll('#stn-card details')) d.open = true; }, far.id);
    const w = await phone.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    check('at 375 px, the card open with its workings, the page does not scroll sideways', w[0] <= w[1], JSON.stringify(w));
    await phone.context.close();

    check('nothing threw for the whole run', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).\n`);
  if (failed.length) {
    log(`FAIL — ${failed.length} of them.`);
    process.exit(1);
  }
  log('PASS — the AEP levels reach the card flagged indicative, the velocity beside the wind');
  log('       region is the arithmetic\'s, and the editor sends what changed.');
}

main().catch(e => { console.error(e); process.exit(1); });
