// The Digital Twin's flood water (flood-stages.js, and its drawing in
// digital-twin.js): a station's flood levels put on the ground as water that
// rises from 0 m on the gauge to the highest level, coloured by the furthest
// level it has passed.
//
// Why a check of its own. `twin` holds the ground the water stands on; it
// says nothing about where the water goes. A water plane a sample too high, a
// class hung from an assumed datum, a hollow behind a bank that fills because
// it is low rather than because the river reaches it, a colour that goes back
// from magenta to red as the water rises past a major class set above the 1%
// AEP level — every one of those is a twin that draws, with a clean console.
//
// Two halves.
//
//   1. flood-stages.js under Node, against real station records: the classes
//      through the gauge zero in force (and only an AHD one), the AEP row the
//      card reads, the peaks when a station carries them, the order, the
//      colours (the AEP ramp shared out for one to four levels), the colour
//      that never goes back down, where 0 m is and why, and the cycle.
//
//   2. The twin in Chromium (skipped without WebGL), standing the real Gatton
//      record — minor 7, moderate 10, major 15 m on a gauge zero of 87.54 m
//      AHD, and four AEP levels from 102.69 to 103.75 m AHD — on a valley the
//      check makes: a channel with its bed at 89 m, a floodplain at 98 m, a
//      hollow 96 m deep inside a bank whose crest is 103 m, and rising ground
//      to the east. The State's elevation service is answered with a GeoTIFF of
//      that surface (lib/geotiff.mjs), so where the water should be is
//      arithmetic. What is asserted: the ladder the twin drew is the module's;
//      the water plane stands at the level, exaggeration and all; below
//      moderate only the channel is wet, at major the floodplain is and the
//      hollow is not, past the bank's crest the hollow is too; the water as
//      drawn — the mask read through the plane's own UVs — agreeing with the
//      water computed; the focus kept on a level pressed; each band's
//      colour; the staff and its rings; every level passed in order, in its
//      colour, a step at a time on the slider; the rise, each frame's water
//      where the cycle puts it for that moment (from 0 m to the top, held, let
//      out, again — frames come when they come, so the clock is what is read),
//      paused from the line and held, a level chosen from the line; hidden and
//      shown; remembered; a browser asking for reduced motion getting still
//      water; the same line inside the Stations map; nothing of it in the
//      .glb; and a station whose zero is on an assumed datum keeping its AEP
//      water and saying why its classes are not drawn.
//
// Run:  npm run flood
//       npm run flood -- -v    also print what passed, and the rise's frames

import fs from 'node:fs';
import vm from 'node:vm';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { auditHandlers } from './lib/controls.mjs';
import { tiffF32, snapExtent } from './lib/geotiff.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT  = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const BUILD_TIMEOUT = Number(process.env.TWIN_TIMEOUT || 90_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b, tol) => a != null && b != null && isFinite(a) && isFinite(b) && Math.abs(a - b) <= tol;
const section = t => console.log(`\n${t}\n`);
const J = v => JSON.stringify(v);

const STATIONS = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;
const GATTON = STATIONS.find(s => s.id === 'gatton');

function loadModule() {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(repo('flood-velocity.js'), 'utf8')}\n${fs.readFileSync(repo('flood-stages.js'), 'utf8')}\n;this.FloodStages = FloodStages;`, ctx);
  return ctx.FloodStages;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. flood-stages.js
// ═════════════════════════════════════════════════════════════════════════════

function nodeHalf(FS) {
  section('The ladder — classes through the gauge zero, the AEP levels, the peaks');

  const L = FS.ladder(GATTON);
  const want = [
    ['minor_m', 94.54, 7], ['moderate_m', 97.54, 10], ['major_m', 102.54, 15],
    ['aep_1_m', 102.69], ['aep_0_5_m', 103.11], ['aep_0_2_m', 103.47], ['aep_0_066_m', 103.75],
  ];
  ok('Gatton: seven levels, lowest first, the classes 87.54 m above their heights on the gauge',
    L.levels.length === 7 && want.every(([k, ahd, g], i) => L.levels[i].key === k && near(L.levels[i].ahd, ahd, 1e-9)
      && (g == null || near(L.levels[i].gauge, g, 1e-9))), L.levels.map(l => `${l.key} ${l.ahd}`).join(', '));
  ok('…the AEP levels as the sheet gives them, AHD, and on the gauge as well since the zero is AHD',
    near(L.levels[3].gauge, 102.69 - 87.54, 1e-9) && L.levels[3].label === '1% AEP' && L.levels[6].oneIn === 1500);
  ok('…the top is the rarest AEP level, and nothing needed saying', near(L.top, 103.75, 1e-9) && L.notes.length === 0, J(L.notes));
  ok('…the zero is the one in force, dated', L.zero && L.zero.m === 87.54 && L.zero.datum === 'AHD' && L.zero.from === '1929-09-01', J(L.zero));

  // The newest edition of the classes wins, and the newest open gauge zero.
  const moved = { ...GATTON,
    flood_classes: [{ as_at: '2001-01-01', minor_m: 1, moderate_m: 2, major_m: 3 }, ...GATTON.flood_classes],
    gauge_survey: [{ valid_from: '1900-01-01', valid_to: '1929-08-31', gauge_zero_m: 80, datum: 'AHD' }, ...GATTON.gauge_survey],
  };
  const LM = FS.ladder(moved);
  ok('the newest edition of the classes, on the zero still in force — not an older one', near(LM.levels[0].ahd, 94.54, 1e-9), J(LM.levels[0]));

  const assumed = { ...GATTON, gauge_survey: [{ valid_from: '1929-09-01', gauge_zero_m: 10, datum: 'ASSUM' }] };
  const LA = FS.ladder(assumed);
  ok('a zero on an assumed datum: the classes are left off, and the notes say which and why',
    LA.levels.every(l => l.kind === 'aep') && LA.levels.length === 4 && LA.notes.length === 1
      && /assumed datum rather than AHD/.test(LA.notes[0]) && /minor 7 m, moderate 10 m, major 15 m/.test(LA.notes[0]), J(LA.notes));
  const noZero = FS.ladder({ ...GATTON, gauge_survey: [] });
  ok('…and no surveyed zero at all, the same', noZero.levels.length === 4 && /no surveyed zero/.test(noZero.notes[0]), J(noZero.notes));
  const LClassesOnly = FS.ladder({ ...GATTON, aep_levels: [] });
  ok('classes and no AEP row: three levels, the top is major', LClassesOnly.levels.length === 3 && near(LClassesOnly.top, 102.54, 1e-9));
  const nothing = FS.ladder({ id: 'x', name: 'Nowhere' });
  ok('a station with none of it: no levels, no top', nothing.levels.length === 0 && nothing.top === null);

  // Peaks: the HDB extract's, when they land.
  const peaks = FS.ladder({ ...GATTON, flood_peaks: [
    { date: '2011-01-10', height_m: 18.92 }, { date: '2013-01-28', height_m: 15.2 }, { date: '1974-01-26', level_m_ahd: 105.1 },
  ] });
  const pk = peaks.levels.filter(l => l.kind === 'peak');
  ok('peaks are levels: on the gauge through the zero, or AHD as given; the highest is named so, with its date',
    pk.length === 3 && near(pk.find(p => p.date === '2011-01-10').ahd, 87.54 + 18.92, 1e-9)
      && near(pk.find(p => p.date === '1974-01-26').ahd, 105.1, 1e-9)
      && pk.find(p => p.highest).label === 'Highest recorded (2011-01-10)', J(pk));
  ok('…the top rises to the highest of them', near(peaks.top, 87.54 + 18.92, 1e-9));
  ok('…and a peak never colours the water', pk.every(p => p.rank === null)
    && FS.passed(peaks, 106.9).key === 'aep_0_066_m', J(FS.passed(peaks, 106.9)));

  section('The colours');

  const C = Object.fromEntries(Object.entries(FS.COLOURS).map(([k, v]) => [k, v.hex]));
  const at = h => { const p = FS.passed(L, h); return { key: p ? p.key : 'below', colour: FS.colourOf(p) }; };
  const bands = [
    [90, 'below', C.below], [95, 'minor_m', C.minor], [98, 'moderate_m', C.moderate], [102.6, 'major_m', C.major],
    [102.8, 'aep_1_m', C.aepFirst], [103.2, 'aep_0_5_m', FS.mix(C.aepFirst, C.aepLast, 1 / 3)],
    [103.5, 'aep_0_2_m', FS.mix(C.aepFirst, C.aepLast, 2 / 3)], [103.75, 'aep_0_066_m', C.aepLast],
  ];
  const wrongBands = bands.filter(([h, k, c]) => at(h).key !== k || at(h).colour !== c);
  ok('clear blue below minor, then green, yellow, red, and magenta through to dark blue across the four AEP floods',
    wrongBands.length === 0, wrongBands.map(([h]) => `${h}: ${J(at(h))}`).join('; '));
  ok('two AEP levels are magenta and dark blue; one is magenta',
    FS.colourOf({ kind: 'aep', aepIndex: 0, aepCount: 2 }) === C.aepFirst && FS.colourOf({ kind: 'aep', aepIndex: 1, aepCount: 2 }) === C.aepLast
      && FS.colourOf({ kind: 'aep', aepIndex: 0, aepCount: 1 }) === C.aepFirst);
  ok('three share the ramp: magenta, the midpoint, dark blue',
    FS.colourOf({ kind: 'aep', aepIndex: 1, aepCount: 3 }) === FS.mix(C.aepFirst, C.aepLast, 0.5));

  // Major above the 1% AEP — 44 of the 115 stations that have both. Here 16 m
  // on the gauge, 103.54 m AHD: between the 0.2% (103.47) and the 0.066%
  // (103.75). Past it, at 103.6, the water keeps the 0.2% AEP's colour.
  const inter = FS.ladder({ ...GATTON, flood_classes: [{ as_at: '2026-09-25', minor_m: 7, moderate_m: 10, major_m: 16 }] });
  const seq = [102.7, 103.2, 103.5, 103.6, 103.75].map(h => FS.passed(inter, h).key);
  ok('a major class above the 1% AEP level: magenta at the 1% AEP, and still AEP colours past major — the colour never goes back down',
    J(seq) === J(['aep_1_m', 'aep_0_5_m', 'aep_0_2_m', 'aep_0_2_m', 'aep_0_066_m']) && inter.levels.map(l => l.key).indexOf('major_m') === 5
      && FS.colourOf(FS.passed(inter, 103.6)) !== C.major, `${J(seq)} ${inter.levels.map(l => l.key)}`);

  section('Where 0 m is, and the cycle');

  const s1 = FS.start(L, 89);
  ok('0 m is the gauge zero when it sits at the channel the ground shows', s1.m === 87.54 && s1.basis === 'the gauge zero', J(s1));
  const s2 = FS.start(L, 125);
  ok('…not when it is 30 m under it: then the channel is 0 m, and it says why', s2.m === 125 - 0 || /not at the channel/.test(s2.basis), J(s2));
  const s3 = FS.start(FS.ladder({ ...GATTON, name: 'Somerset Dam HW' }), 95);
  ok('…nor at a storage, whose zero is not its bed', s3.m === 95 && /storage/.test(s3.basis), J(s3));
  const s4 = FS.start(LA, 91);
  ok('…nor with no zero in AHD', s4.m === 91 && /no gauge zero in AHD/.test(s4.basis), J(s4));
  const s5 = FS.start(L, 110);
  ok('…and never at or over the top', s5.m < L.top, J(s5));

  const R = FS.RISE_S, H = FS.HOLD_S, D = FS.DRAIN_S;
  ok(`the cycle: a ${R} s rise, ${H} s held at the top, ${D} s let out, and round again`,
    FS.cycle(0) === 0 && near(FS.cycle(R / 2), 0.5, 1e-12) && FS.cycle(R) === 1 && FS.cycle(R + H - 0.01) === 1
      && near(FS.cycle(R + H + D / 2), 0.5, 1e-12) && near(FS.cycle(R + H + D), 0, 1e-12) && near(FS.cycle(R + H + D + R / 4), 0.25, 1e-12));
  ok('how a level is said', FS.levelText(L.levels[0]) === 'Minor 7.0 m' && FS.levelText(L.levels[3]) === '1% AEP 102.69 m AHD'
    && FS.gaugeText(7) === '7.0 m on the gauge' && FS.ahdText(94.54) === '94.54 m AHD');
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. The twin
// ═════════════════════════════════════════════════════════════════════════════

// The valley, in the twin's own metres about the station: x east, z south.
const ST = { lat: GATTON.lat, lon: GATTON.lon };
const M_LAT = 110574, M_LON = 111320 * Math.cos(ST.lat * Math.PI / 180);
function valley(x, z) {
  let h = 98;                                                  // the floodplain
  h -= 9 * Math.exp(-(((x + 30) / 9) ** 2));                   // the channel: bed 89 m at x = −30, north to south
  const d = Math.hypot(x - 80, z - 40);                        // a hollow behind a bank
  if (d < 24) h -= 2 * (1 - (d / 24) ** 2);                    //   its floor 96 m at the middle
  h += 5 * Math.exp(-(((d - 28) / 5) ** 4));                   //   its bank, crest 103 m at 28 m out, flat-topped
                                                               //   so no step between samples slips under it
  h += Math.min(12, Math.max(0, (x - 150) * 0.12));            // rising ground to the east, to 110 m
  return h;
}
const groundAt = (lat, lon) => valley((lon - ST.lon) * M_LON, -(lat - ST.lat) * M_LAT);

async function browserHalf(FS) {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    await page.route(/QldDem\/ImageServer\/exportImage/, route => {
      const u = new URL(route.request().url());
      const bbox = (u.searchParams.get('bbox') || '').split(',').map(Number);
      const [W, H] = (u.searchParams.get('size') || '0,0').split(',').map(Number);
      const extent = snapExtent(bbox, W, H, u.searchParams.get('adjustAspectRatio'));
      const pw = (extent[2] - extent[0]) / W, ph = (extent[3] - extent[1]) / H;
      const body = tiffF32(W, H, extent, (x, y) => groundAt(extent[3] - (y + 0.5) * ph, extent[0] + (x + 0.5) * pw));
      return route.fulfill({ status: 200, contentType: 'image/tiff', body, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    page.on('pageerror', e => errors.push(e.stack || e.message));

    await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
    const gl = await page.evaluate(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); });
    if (!gl) { console.log('\n  SKIP — this Chromium has no WebGL; the twin\'s water cannot be exercised here.'); return; }

    const settled = () => page.waitForFunction(() => {
      const d = DigitalTwin.debug();
      return d.built && !d.status.endsWith('…') && d.flood && !d.flood.none && d.flood.level != null;
    }, null, { timeout: BUILD_TIMEOUT });
    const fl = () => page.evaluate(() => DigitalTwin.debug().flood);
    const wet = (x, z) => page.evaluate(([x, z]) => DigitalTwin._floodWet(x, z), [x, z]);
    const text = sel => page.evaluate(s => { const el = document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
    const pal = await page.evaluate(() => Object.fromEntries(Object.entries(FloodStages.COLOURS).map(([k, v]) => [k, cssVar(v.token, v.hex)])));
    // The pill on the stage, and whether it sits inside the stage.
    const pill = (scope = '') => page.evaluate(sc => {
      const el = document.querySelector(`${sc} #twin-flood-pill`), stage = document.querySelector(`${sc} #twin-stage`);
      if (!el || !stage) return null;
      const b = el.getBoundingClientRect(), st = stage.getBoundingClientRect();
      const sw = el.querySelector('.twin-flood-sw');
      return { hidden: el.hidden || getComputedStyle(el).display === 'none', text: el.textContent.replace(/\s+/g, ' ').trim(), title: el.title,
               sw: sw ? sw.style.getPropertyValue('--sw') : null, inside: b.left >= st.left && b.top >= st.top && b.right <= st.right && b.bottom <= st.bottom,
               width: b.width, stage: { w: st.width, h: st.height } };
    }, scope);

    section('The twin, on a valley the check made, under Gatton\'s levels');
    await page.evaluate(() => DigitalTwin.openStation('gatton'));
    await settled();
    let F = await fl();
    const h0 = await page.evaluate(() => DigitalTwin.debug().h0);
    ok('the ground came from the State\'s service — the valley', (await page.evaluate(() => DigitalTwin.debug().source)) === 'qld' && near(h0, 98, 0.01), `h0 ${h0}`);
    const L = FS.ladder(GATTON);
    ok('the twin drew the module\'s ladder, all seven levels', F.levels.length === 7 && F.levels.every((l, i) => l.key === L.levels[i].key && near(l.ahd, L.levels[i].ahd, 1e-9)),
      F.levels.map(l => `${l.key} ${l.ahd}`).join(', '));
    ok('0 m is the gauge zero, which sits under the channel\'s bed', F.start === 87.54 && F.startBasis === 'the gauge zero' && near(F.top, 103.75, 1e-9), `${F.start} ${F.startBasis}`);
    ok('the channel is found by the gauge: the lowest ground within 60 m, 30 m west', F.seed && near(F.seed.x, -30, 1e-6) && near(F.seed.elev, 89, 1e-3), J(F.seed));
    ok('by default, with nothing asked for, the water rises', F.on && F.animating);
    let P = await pill();
    ok('on the stage, a pill: ⏸ while it rises, and how high', P && !P.hidden && /^⏸ ?Pause the rise: \d+\.\d m · /.test(P.text) && P.inside, J(P));

    // Held at each level from the line, with a real click.
    const hold = async label => {
      await page.click(`#twin-flood .twin-flood-level:has-text("${label}")`);
      await page.waitForFunction(() => !DigitalTwin.debug().flood.animating, null, { timeout: LOAD_TIMEOUT });
      return fl();
    };
    F = await hold('Moderate');
    ok('"Moderate" on the line holds the water at 97.54 m AHD, stops the rise, and says so on the line',
      near(F.level, 97.54, 1e-9) && !F.animating && F.band === 'moderate_m' && /water 10\.0 m on the gauge, 97\.54 m AHD — past moderate/.test(await text('#twin-flood-now')),
      `${F.level} ${F.band} ${await text('#twin-flood-now')}`);
    ok('…the plane at that height over the station\'s ground', near(F.y, 97.54 - h0, 1e-4), `${F.y}`);
    ok('…yellow, and as opaque as a class', F.colour === pal.moderate && near(F.opacity, 0.62, 1e-9), `${F.colour} ${F.opacity}`);
    P = await pill();
    ok('…and the pill says so in a few words, in the water\'s colour, and offers to play', /^▶ ?Play the rise: 10\.0 m · moderate$/.test(P.text) && P.sw === pal.moderate
      && /water 10\.0 m on the gauge, 97\.54 m AHD — past moderate/.test(P.title), J(P));
    ok('at moderate the channel is wet and the floodplain, a metre over it, is not',
      await wet(-30, 0) && await wet(-30, -150) && !(await wet(0, 50)) && !(await wet(80, 40)), '');

    ok('…and the focus is still on the level pressed, though the line was drawn again under it',
      await page.evaluate(() => document.activeElement && document.activeElement.dataset.flood) === 'moderate_m');

    // Major by the keyboard: Tab onto it and Enter, as someone without a mouse.
    await page.focus('#twin-flood .twin-flood-level[data-flood="major_m"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => DigitalTwin.debug().flood.band === 'major_m', null, { timeout: LOAD_TIMEOUT });
    F = await fl();
    ok('Enter on "Major" holds the water there, and the focus stays on it',
      near(F.level, 102.54, 1e-9) && await page.evaluate(() => document.activeElement && document.activeElement.dataset.flood) === 'major_m');
    ok('at major the floodplain is under water, joined to the channel', near(F.level, 102.54, 1e-9) && await wet(0, 50) && await wet(150, -150));
    // The water as drawn: the texel of the mask the plane samples, through its
    // own UVs, against the ground's fill levels — over a grid across the whole
    // patch, at the level where the dry ground is the hollow 80 m east and 40 m
    // south and the rise at the east edge: off every axis, so a mask turned,
    // flipped or transposed against the ground cannot agree.
    const maskGrid = await page.evaluate(() => {
      const out = { n: 0, wet: 0, bad: [] };
      for (let x = -190; x <= 190; x += 10) for (let z = -190; z <= 190; z += 10) {
        const m = DigitalTwin._floodMaskAt(x, z), w = DigitalTwin._floodWet(x, z);
        out.n++; if (w) out.wet++;
        if (m !== w) out.bad.push([x, z, m, w]);
      }
      return out;
    });
    ok('…and the water drawn is the water computed: at every point of a grid across the patch, the mask the plane samples agrees with the ground',
      maskGrid.bad.length === 0 && maskGrid.wet > 1000 && maskGrid.n - maskGrid.wet > 40, `${maskGrid.wet} wet of ${maskGrid.n}; disagreeing: ${J(maskGrid.bad.slice(0, 5))}`);
    ok('…and the hollow behind the bank is dry, though its floor is 6 m under the water: the bank holds',
      !(await wet(80, 40)) && near(await page.evaluate(() => DigitalTwin._floodFill(80, 40)), 103, 0.1),
      `fills at ${await page.evaluate(() => DigitalTwin._floodFill(80, 40))}`);
    ok('…the rising ground to the east is dry, and the water is red', !(await wet(250, 0)) && F.colour === pal.major, F.colour);

    F = await hold('0.5% AEP');
    ok('past the bank\'s crest, at the 0.5% AEP flood, the hollow fills', near(F.level, 103.11, 1e-9) && await wet(80, 40));
    ok('…and the water is the second of the four AEP colours', F.colour === FS.mix(pal.aepFirst, pal.aepLast, 1 / 3), F.colour);
    F = await hold('0.066% AEP');
    ok('at the rarest, dark blue', near(F.level, 103.75, 1e-9) && F.colour === pal.aepLast, F.colour);
    const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem('mn-twin') || '{}'));
    ok('the choice is remembered: still water, at that level', remembered.floodAnim === false && remembered.floodHold === 'aep_0_066_m', J(remembered));

    // The slider.
    await page.evaluate(() => { const r = document.getElementById('twin-flood-level'); r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    F = await fl();
    ok('the slider at nought: 0 m on the gauge, clear blue, nothing wet — the channel\'s bed is a metre and a half up',
      near(F.level, 87.54, 1e-9) && F.band === null && F.colour === pal.below && near(F.opacity, 0.45, 1e-9) && F.flooded === 0, J({ l: F.level, c: F.colour, n: F.flooded }));
    ok('…and below the first level the water is named by the level it has yet to reach', /0\.0 m on the gauge, 87\.54 m AHD — below minor$/.test(await text('#twin-flood-now'))
      && /0\.0 m · below minor$/.test((await pill()).text), `${await text('#twin-flood-now')} | ${(await pill()).text}`);
    await page.evaluate(() => { const r = document.getElementById('twin-flood-level'); r.value = '100'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    F = await fl();
    ok('a tenth of the way up the channel is wet and nothing else, still blue', near(F.level, 87.54 + 0.1 * (103.75 - 87.54), 1e-9)
      && await wet(-30, 0) && !(await wet(-12, 0)) && F.colour === pal.below && F.flooded > 0, `${F.level} ${F.flooded}`);

    // The staff.
    ok('the staff stands in the channel, from 0 m to the top, a ring at each level in its colour',
      F.staff && near(F.staff.x, -30, 1e-6) && near(F.staff.post.bottom, 87.54 - h0, 1e-4) && near(F.staff.post.top, 103.75 - h0 + 0.4, 1e-4)
        && F.staff.rings.length === 7 && F.staff.rings.every(r => { const l = F.levels.find(x => x.key === r.key); return near(r.y, l.ahd - h0, 1e-4) && r.colour === l.colour; }),
      J(F.staff));

    // Exaggeration.
    await page.evaluate(() => DigitalTwin.setExag(2));
    F = await fl();
    ok('at 2× the water and the rings stretch with the ground', near(F.y, 2 * (F.level - h0), 1e-4)
      && F.staff.rings.every(r => near(r.y, 2 * (F.levels.find(x => x.key === r.key).ahd - h0), 1e-4)), `${F.y}`);
    await page.evaluate(() => DigitalTwin.setExag(1));

    // Every level in turn, a step at a time: the slider through the whole
    // range. This is the order and the colours, frame rate aside.
    const sweep = await page.evaluate(() => {
      const out = [];
      for (let i = 0; i <= 400; i++) {
        DigitalTwin.setFloodFraction(i / 400);
        const d = DigitalTwin.debug().flood;
        out.push({ level: d.level, band: d.band, colour: d.colour });
      }
      return out;
    });
    const passedInTurn = sweep.filter((x, i) => i === 0 || x.band !== sweep[i - 1].band);
    const colourOfBand = k => (k == null ? pal.below : F.levels.find(l => l.key === k).colour);
    ok('the slider from nought to the top passes every level in order, each in its colour, and never goes back',
      J(passedInTurn.map(x => x.band)) === J([null, 'minor_m', 'moderate_m', 'major_m', 'aep_1_m', 'aep_0_5_m', 'aep_0_2_m', 'aep_0_066_m'])
        && sweep.every(x => x.colour === colourOfBand(x.band)) && near(sweep[400].level, 103.75, 1e-9),
      passedInTurn.map(x => `${x.level.toFixed(2)} ${x.band} ${x.colour}`).join(', '));
    ok('…and the band changes exactly at each level', passedInTurn.slice(1).every(x => {
      const l = F.levels.find(y => y.key === x.band);
      const before = sweep[sweep.indexOf(x) - 1];
      return x.level >= l.ahd && before.level < l.ahd;
    }));
    await page.evaluate(() => DigitalTwin.setFloodFraction(0.1));

    // The rise, on a short clock (2 s up, 1.2 s held, 0.3 s let out). Frames
    // come when they come — software rendering draws a handful a second — so
    // what is asserted is that each one puts the water where the cycle says
    // for the moment it was drawn, and that over four seconds that went up,
    // held, came down and started again.
    section('The rise');
    const CLOCK = { rise: 2, hold: 1.2, drain: 0.3 };
    await page.click('#twin-flood .twin-flood-play');
    const samples = await page.evaluate(async ({ rise, hold, drain }) => {
      const out = [];
      const take = () => { const d = DigitalTwin.debug().flood; out.push({ t: d.clock, level: d.level, band: d.band, animating: d.animating }); };
      DigitalTwin._floodClock(rise, hold, drain);
      take();
      const t0 = performance.now();
      while (performance.now() - t0 < 4200) { await new Promise(r => requestAnimationFrame(r)); take(); }
      return out;
    }, CLOCK);
    if (VERBOSE) {
      const drawn = samples.filter((x, i) => i === 0 || x.t !== samples[i - 1].t);
      console.log(`       the frames, as seconds into the cycle : m AHD — ${drawn.map(x => `${x.t == null ? '-' : x.t.toFixed(2)}:${x.level.toFixed(2)}`).join(' ')}`);
    }
    const onClock = samples.filter(x => x.t != null);
    const expect = t => 87.54 + FS.cycle(t, CLOCK) * (103.75 - 87.54);
    const offClock = onClock.filter(x => !near(x.level, expect(x.t), 1e-3));
    const firstTop = samples.findIndex(x => near(x.level, 103.75, 1e-9));
    const up = firstTop > 0 ? samples.slice(0, firstTop + 1) : [];
    ok('▶ on the line starts it again, and every frame puts the water where the cycle says for that moment',
      samples.every(x => x.animating) && onClock.length === samples.length && offClock.length === 0,
      `${onClock.length}/${samples.length} on the clock; off it: ${offClock.slice(0, 3).map(x => `${x.t.toFixed(3)} ${x.level}`).join(', ')}`);
    ok('…from 0 m, climbing without once going down…', samples[0].t === 0 && near(samples[0].level, 87.54, 1e-9)
      && up.length > 2 && up.every((x, i) => i === 0 || x.level >= up[i - 1].level), up.map(x => x.level.toFixed(2)).join(' '));
    ok('…to the top, held there…', firstTop > 0 && samples.some(x => x.t >= CLOCK.rise && x.t < CLOCK.rise + CLOCK.hold && near(x.level, 103.75, 1e-9)),
      samples.map(x => `${x.t.toFixed(2)}:${x.level.toFixed(2)}`).join(' '));
    const cycle = CLOCK.rise + CLOCK.hold + CLOCK.drain;
    ok('…let out, and round again from the bottom', samples.some(x => x.t > cycle && x.t < cycle + CLOCK.rise && x.level < 95)
      && samples.slice(firstTop).some(x => x.level < 95), samples.filter(x => x.t > CLOCK.rise).map(x => `${x.t.toFixed(2)}:${x.level.toFixed(2)}`).join(' '));
    const rank = k => (k == null ? -1 : F.levels.find(l => l.key === k).rank);
    ok('…in the colours of the levels it passes, in order on the way up', up.every((x, i) => i === 0 || rank(x.band) >= rank(up[i - 1].band))
      && up[0].band === null && up[up.length - 1].band === 'aep_0_066_m', J(up.map(x => x.band)));
    ok('the line says what it is doing', /Pause the rise/.test(await text('#twin-flood .twin-flood-play')));

    // Paused: still water, and a still scene draws nothing. The pause settles
    // the water and asks for one last frame, which is right; what must not
    // follow is another. Three animation frames let that one land first (under
    // SwiftShader it can take longer than the click's own round trip), as
    // twin.mjs waits before it counts.
    await page.click('#twin-flood .twin-flood-play');
    await page.evaluate(() => new Promise(r => { let k = 0; const f = () => (++k >= 3 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
    const a = await fl();
    const framesA = await page.evaluate(() => DigitalTwin.debug().frames);
    await page.waitForTimeout(600);
    const b = await fl();
    const framesB = await page.evaluate(() => DigitalTwin.debug().frames);
    ok('⏸ holds the water where it was caught, and a still scene stops drawing', !b.animating && a.level === b.level && framesA === framesB,
      `${a.level} ${b.level} frames ${framesA}→${framesB}`);
    ok('…and the choice is remembered as a place on the way up', await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('mn-twin')); return s.floodAnim === false && typeof s.floodHold === 'number'; }));

    // The pill does the same, from the stage.
    await page.click('#twin-flood-pill');
    F = await fl();
    P = await pill();
    ok('▶ on the pill plays the rise again, and both it and the line then offer ⏸', F.animating && /^⏸/.test(P.text) && /Pause the rise/.test(await text('#twin-flood .twin-flood-play')), J(P));
    await page.click('#twin-flood-pill');
    F = await fl();
    ok('…and ⏸ on it holds the water again', !F.animating && /^▶/.test((await pill()).text));

    // Hidden, and shown.
    await page.click('#twin-flood button:has-text("Hide the water")');
    F = await fl();
    ok('"Hide the water": no water, no staff, no pill, and the line offers it back — with the focus on the offer', !F.on && F.visible === false && F.staff.visible === false
      && (await pill()).hidden && /the water is hidden/.test(await text('#twin-flood'))
      && await page.evaluate(() => document.activeElement && document.activeElement.dataset.flood) === 'show', await text('#twin-flood'));
    ok('…the panel\'s box agrees', await page.evaluate(() => !document.getElementById('twin-flood-on').checked && document.getElementById('twin-flood-anim').disabled));
    await page.click('#twin-flood button:has-text("Show it")');
    F = await fl();
    ok('"Show it" brings it back, and the pill', F.on && F.visible && F.staff.visible && !(await pill()).hidden);

    // Not in the .glb.
    const meshes = await page.evaluate(async () => {
      const buf = await DigitalTwin.buildGlb();
      const dv = new DataView(buf);
      const jsonLen = dv.getUint32(12, true);
      const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
      return json.meshes.map(m => m.name);
    });
    ok('none of it goes into the .glb: the scene there is the site', meshes.includes('ground') && !meshes.some(n => /flood|staff|^level /.test(n)) && F.exported === false,
      meshes.filter(n => /flood|staff|level/.test(n)).join(', '));

    const audit = await auditHandlers(page);
    ok(`the tab's controls: all ${audit.checked} handler(s) resolve`, audit.unresolved.length === 0, audit.unresolved.map(u => u.path).join(', '));
    ok('the canvas\'s name says there is water, and how high it goes', /water at its flood levels, up to 103\.75 m AHD/.test(await page.evaluate(() => document.getElementById('twin-canvas').getAttribute('aria-label'))));

    // An assumed datum: the AEP water stands; the classes are named, not drawn.
    section('A zero on an assumed datum');
    await page.evaluate(() => {
      const s = state.data.stations.find(x => x.id === 'gatton');
      window.__zero = s.gauge_survey;
      s.gauge_survey = [{ valid_from: '1929-09-01', gauge_zero_m: 10, datum: 'ASSUM' }];
      DigitalTwin.rebuild();
    });
    await settled();
    F = await fl();
    ok('the AEP levels still stand, and 0 m is the channel since no zero is AHD', F.levels.length === 4 && F.levels.every(l => l.kind === 'aep')
      && near(F.start, 89, 1e-3) && /no gauge zero in AHD/.test(F.startBasis), `${F.levels.length} ${F.start} ${F.startBasis}`);
    const notes = await page.evaluate(() => DigitalTwin.debug().notes);
    ok('…and the notes say why the classes are not drawn', notes.some(n => /assumed datum rather than AHD/.test(n)), notes.join(' | '));
    await page.evaluate(() => { state.data.stations.find(x => x.id === 'gatton').gauge_survey = window.__zero; });

    // The same line in the Stations map's twin.
    section('Inside the Stations map');
    await page.evaluate(() => { DigitalTwin.floodAt('major_m'); switchTab('stations'); });
    await page.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => { state.selectedId = 'gatton'; state.map.setView([-27.555, 152.275], 18, { animate: false }); });
    await page.waitForFunction(() => { const el = document.querySelector('#map-twin.is-on #twin-flood'); return !!el && !el.hidden; }, null, { timeout: BUILD_TIMEOUT });
    F = await fl();
    ok('at zoom 18 the map hands over to the twin, and its one line carries the water and the controls',
      near(F.level, 102.54, 1e-9) && /Flood levels:/.test(await text('#map-twin #twin-flood')) && (await page.$$('#map-twin #twin-flood .twin-flood-level')).length === 7,
      await text('#map-twin #twin-flood'));
    P = await pill('#map-twin');
    ok('…and the pill is on its stage too', P && !P.hidden && P.inside && /15\.0 m · major$/.test(P.text), J(P));

    // A phone: the map has no row to spare, so the line stands down and the
    // pill is the water's control — still there, still inside the stage.
    await page.setViewportSize({ width: 375, height: 800 });
    // The nav is a drawer at this width, and one left open lays its backdrop
    // over the map: shut, as a phone has it.
    await page.evaluate(() => { if (typeof setNavCollapsed === 'function') setNavCollapsed(true); });
    await page.waitForFunction(() => { const el = document.querySelector('#map-twin #twin-flood'); return !!el && getComputedStyle(el).display === 'none'; }, null, { timeout: LOAD_TIMEOUT });
    P = await pill('#map-twin');
    ok('on a phone the line above the stage stands down, and the pill on the stage stays, inside it', P && !P.hidden && P.inside && P.width > 60 && P.stage.h >= 160, J(P));
    await page.click('#map-twin #twin-flood-pill');
    ok('…and it still starts and stops the rise', (await fl()).animating);
    await page.click('#map-twin #twin-flood-pill');
    ok('…both ways', !(await fl()).animating);
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.evaluate(() => MapTwin.leave());

    ok('nothing threw', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();

    // A browser that asks for reduced motion gets still water, at the top.
    section('Reduced motion');
    const quiet = await browser.newContext({ viewport: { width: 1360, height: 900 }, reducedMotion: 'reduce' });
    const qp = await quiet.newPage();
    await applyNetworkPolicy(qp, server.origin);
    await qp.route(/QldDem\/ImageServer\/exportImage/, route => {
      const u = new URL(route.request().url());
      const bbox = (u.searchParams.get('bbox') || '').split(',').map(Number);
      const [W, H] = (u.searchParams.get('size') || '0,0').split(',').map(Number);
      const extent = snapExtent(bbox, W, H, u.searchParams.get('adjustAspectRatio'));
      const pw = (extent[2] - extent[0]) / W, ph = (extent[3] - extent[1]) / H;
      return route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'Access-Control-Allow-Origin': '*' },
        body: tiffF32(W, H, extent, (x, y) => groundAt(extent[3] - (y + 0.5) * ph, extent[0] + (x + 0.5) * pw)) });
    });
    await qp.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
    await qp.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
    await qp.evaluate(() => DigitalTwin.openStation('gatton'));
    await qp.waitForFunction(() => { const d = DigitalTwin.debug(); return d.built && d.flood && !d.flood.none && d.flood.level != null; }, null, { timeout: BUILD_TIMEOUT });
    const q = await qp.evaluate(() => DigitalTwin.debug().flood);
    ok('reduced motion: the water stands still at the highest level, and the line offers to play it', !q.animating && near(q.level, 103.75, 1e-9)
      && /Play the rise/.test(await qp.evaluate(() => document.querySelector('#twin-flood .twin-flood-play').textContent)), `${q.animating} ${q.level}`);
    await quiet.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
try {
  const FS = loadModule();
  nodeHalf(FS);
  await browserHalf(FS);
} catch (err) {
  failures++;
  console.log(`\nThe flood check could not finish:\n${err.stack || err}`);
}
console.log(`\n  ${passes + failures} assertion(s).`);
if (failures) {
  console.log(`\nFAIL — ${failures} of ${passes + failures}.`);
  process.exitCode = 1;
} else {
  console.log('\nPASS — the water rises to the station\'s levels, where the river would put it, in the colours of the levels it passes.');
}
