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
//      card reads, the peaks — each at the level the database gives it, and a
//      height with none never hung from today's zero — the order, the colours
//      (the AEP ramp shared out for one to four levels), the colour that never
//      goes back down, where 0 m is and why, the cycle, and the scale's
//      layout: every mark to scale, no label on another, the least of them
//      giving way first when the stage is short; and the scale's two
//      measures — linear, and logarithmic in the depth below the top — with
//      the bend a station's levels are fitted with and whether they warrant
//      it (Gatton's twelve do, three classes metres apart do not). Then the
//      datum under the water: every ladder in AHD and stood only on a ground
//      in AHD, and geoid.js — the grid that puts the tiles' EGM96 into AHD —
//      read from data/ as the app reads it: the shape, the numbers at places
//      whose separation is known, no value out at sea, and the accuracy the
//      file claims for itself.
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
//      paused from the line and held, a level chosen from the line; the scale
//      on the stage — its marks where the levels are, its names never on one
//      another and inside the stage, a name pressed, the track dragged and
//      taking hold of a level near its mark, the keys, a short stage giving
//      the least names away; hidden and shown; remembered; a browser asking
//      for reduced motion getting still water; the same inside the Stations
//      map and on a phone; a phone in the hand, whose scale names and hint
//      stand down after five seconds and come back when asked (a tap on the
//      track for the names, the "?" for the hint), with ⏸'s pill a line and a
//      bit tall; nothing of it in the .glb; a station whose zero is
//      on an assumed datum keeping its AEP water and saying why its classes
//      are not drawn; and Gatton's own floods from HDB — 1893 over the rarest
//      AEP level, so the water rises to it, a ring and a name each — and on
//      them the scale's measure: linear when the twin opens, logarithmic by
//      itself a moment later, Log lit, the names beside their marks rather
//      than fanned out from the head, the water not moved, the rise and a
//      press and the keys along the bent track, Log pressed off and kept for
//      the station through a rebuild, and a station whose levels do not
//      warrant it left linear.
//
// Gatton's record carries its five largest floods since 0037. The sections
// about the classes and the AEP levels set them aside, so what they assert
// is those alone, and the floods have a section of their own.
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
// Gatton's classes and AEP levels, its floods set aside (they have a section
// of their own, with the five HDB gives it — GATTON_PEAKS, as 0037 emits them).
const GATTON = (({ flood_peaks, ...rest }) => rest)(STATIONS.find(s => s.id === 'gatton'));
const GATTON_PEAKS = [
  { date: '1893-02-04', height_m: 16.33, level_m_ahd: 103.87 },
  { date: '2011-01-11', height_m: 15.38, level_m_ahd: 102.92 },
  { date: '1974-01-27', height_m: 14.63, level_m_ahd: 102.17 },
  { date: '1959-02-18', height_m: 12.80, level_m_ahd: 100.34 },
  { date: '1983-06',    height_m: 11.58, level_m_ahd: 99.12 },
];

function loadGeoid() {
  const ctx = { console, atob };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(repo('geoid.js'), 'utf8')}\n;this.Geoid = Geoid;`, ctx);
  return ctx.Geoid;
}

function loadModule() {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(repo('flood-velocity.js'), 'utf8')}\n${fs.readFileSync(repo('flood-stages.js'), 'utf8')}\n;this.FloodStages = FloodStages;`, ctx);
  return ctx.FloodStages;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. flood-stages.js
// ═════════════════════════════════════════════════════════════════════════════

function datumHalf(FS) {
  section('The datum under the water');

  const L = FS.ladder(GATTON);
  ok('a station\'s own ladder is in AHD', L.datum === 'AHD' && L.levels.length === 7);
  ok('…stood on a ground in AHD, unchanged', FS.onGround(L, 'AHD') === L);
  const off = FS.onGround(L, 'EGM96');
  ok('…and on a ground in EGM96, no levels at all and a note that says why',
    off.levels.length === 0 && off.top === null && off.offGround === 'EGM96'
      && /in EGM96/.test(off.notes[off.notes.length - 1]) && /could not be put into AHD/.test(off.notes[off.notes.length - 1]), J(off.notes));
  const bg = FS.borrowed(GATTON, 'gauge', 85, { km: 3 });
  const ba = FS.borrowed(GATTON, 'ahd', 85, { km: 3 });
  ok('a borrowed ladder is in AHD either way it is carried', bg.datum === 'AHD' && ba.datum === 'AHD');
  ok('…and onGround holds it to the same rule', FS.onGround(bg, 'EGM96').levels.length === 0 && FS.onGround(ba, 'AHD') === ba);

  // Geoid: the grid as the app fetches it, decoded by the app's own code.
  const G = loadGeoid();
  ok('before the grid is read, nothing is guessed', G.ahdLessEgm96(-27.55, 152.27) === null && !G.loaded());
  const file = JSON.parse(fs.readFileSync(repo('data/geoid-ahd-egm96.json'), 'utf8'));
  G.seed(file);
  ok('the grid reads: 351 × 421 nodes every 0.1° from 9° S, 112° E', G.loaded() && file.rows === 351 && file.cols === 421 && file.step === 0.1
    && file.lat0 === -9 && file.lon0 === 112);
  // AHD less EGM96 where the build measured it — Gatton, the Barossa (the
  // lowest at any station) and the upper Hunter (the highest), against the
  // models it was made from, to the 2 cm the grid is stored to and the
  // interpolation the file's meta says it costs.
  const at = (lat, lon) => G.ahdLessEgm96(lat, lon);
  ok('Gatton: AHD = EGM96 − 0.34 m', near(at(-27.554471, 152.274671), -0.34, 0.03), at(-27.554471, 152.274671));
  ok('Nuriootpa: AHD = EGM96 − 2.07 m, the most of any station', near(at(-34.47, 138.999), -2.07, 0.05), at(-34.47, 138.999));
  ok('Scone (Kingdon Ponds): AHD = EGM96 + 0.58 m, the most the other way', near(at(-32.05, 150.8528), 0.58, 0.05), at(-32.05, 150.8528));
  ok('no value out at sea, past where AUSGeoid2020 holds any (Willis Island), nor off the grid (New Zealand)',
    at(-16.288, 149.965) === null && at(-41.29, 174.78) === null && at(NaN, 150) === null);
  const acc = file.meta && file.meta.accuracy && file.meta.accuracy.stations;
  ok('the file says what the 0.1° grid costs at the stations, and it is inside a quarter of a metre',
    acc && acc.points > 4000 && acc.max_m < 0.25 && acc.p99_m < 0.1 && acc.separation_min_m < -2 && acc.separation_max_m > 0.5, J(acc));
  ok('a grid of the wrong size is refused, not read as zeros', (() => { try { G.seed({ ...file, rows: 350 }); return false; } catch (_) { return true; } })());
  G.seed(file);
  let every = 0, none = 0;
  for (const s of STATIONS) {
    if (s.lat == null || s.lon == null || !isFinite(s.lat) || !isFinite(s.lon)) continue;
    if (at(s.lat, s.lon) == null) none++; else every++;
  }
  ok('every station but the three island gauges has a value', none <= 3 && every > 4800, `${every} with, ${none} without`);
}

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

  // Peaks: HDB's, as 0037 puts them on the station — the level each reached
  // through the zero in force that day, and none where that cannot be had.
  const peaks = FS.ladder({ ...GATTON, flood_peaks: [...GATTON_PEAKS, { date: '1990', height_m: 3.1 }] });
  const pk = peaks.levels.filter(l => l.kind === 'peak');
  ok('peaks are levels at the level the database gives; the highest is named so, with its date',
    pk.length === 5 && GATTON_PEAKS.every(g => near(pk.find(p => p.date === g.date).ahd, g.level_m_ahd, 1e-9))
      && pk.find(p => p.highest).label === 'Highest recorded (1893-02-04)' && pk.filter(p => p.highest).length === 1, J(pk));
  ok('…on today\'s gauge through today\'s zero, the height HDB recorded kept beside it, and a month and a year to name it by',
    near(pk.find(p => p.date === '1974-01-27').gauge, 102.17 - 87.54, 1e-9) && pk.find(p => p.date === '1974-01-27').recorded === 14.63
      && pk.find(p => p.date === '1893-02-04').short === 'Feb 1893' && pk.find(p => p.date === '1983-06').short === 'Jun 1983', J(pk));
  ok('…the top rises to the highest of them, the 1893 flood over the rarest AEP level', near(peaks.top, 103.87, 1e-9) && peaks.top > 103.75);
  ok('…and a peak never colours the water', pk.every(p => p.rank === null)
    && FS.passed(peaks, 103.8).key === 'aep_0_066_m', J(FS.passed(peaks, 103.8)));
  ok('a height with no level is not drawn — never hung from today\'s zero — and the notes say so, height and date',
    !peaks.levels.some(l => l.date === '1990') && peaks.notes.length === 1 && /One of the floods HDB records here cannot be put on the ground/.test(peaks.notes[0])
      && /3\.1 m \(1990\) on the gauge/.test(peaks.notes[0]), J(peaks.notes));
  // Another station's floods (0041): a station taking its flood history from
  // Gatton says whose they are; its own floods say nothing of the kind.
  const borrowedPeaks = FS.ladder({ ...GATTON, id: 'beside', flood_peaks: GATTON_PEAKS, flood_peaks_from: 'gatton', flood_peaks_gauge: '40444' });
  ok('a station taking Gatton\'s flood history draws its floods and says they are the Bureau\'s record at gauge 40444',
    borrowedPeaks.levels.filter(l => l.kind === 'peak').length === GATTON_PEAKS.length
      && borrowedPeaks.notes.some(n => /Bureau's record at .*40444.*takes its flood history from/.test(n))
      && !peaks.notes.some(n => /takes its flood history/.test(n)), J(borrowedPeaks.notes));
  const onlyHeights = FS.ladder({ ...GATTON, flood_peaks: [{ date: '2011-01-10', height_m: 18.92 }] });
  ok('…and a station whose floods all lack one draws none, and says why',
    !onlyHeights.levels.some(l => l.kind === 'peak') && near(onlyHeights.top, 103.75, 1e-9)
      && /^HDB records floods here, but none can be put on the ground/.test(onlyHeights.notes[0]), J(onlyHeights.notes));

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

  section('The scale beside the water');

  // Gatton with its floods: twelve levels, seven of them in the top 1.7 m of
  // a 16 m range — the crowd the spreading is for.
  const G = peaks.levels, lo = 87.54, hi = peaks.top, GAP = 18;
  const layoutOk = (pos, px, gap) => {
    const shown = pos.filter(p => p.shown).sort((a, b) => a.at - b.at);
    return shown.every((p, i) => p.at >= -1e-9 && p.at <= px + 1e-9 && (i === 0 || p.at - shown[i - 1].at >= gap - 1e-9))
      && shown.every((p, i) => i === 0 || p.mark >= shown[i - 1].mark - 1e-9);
  };
  const big = FS.scale(G, { lo, hi, px: 400, gap: GAP });
  ok('every level\'s mark is to scale: the top at the head, 0 m at the foot, the rest in proportion',
    big.every((p, i) => near(p.mark, 400 * (hi - G[i].ahd) / (hi - lo), 1e-9)) && near(big.find(p => p.key === 'peak 1893-02-04').mark, 0, 1e-9),
    J(big.map(p => [p.key, +p.mark.toFixed(1)])));
  ok('with room for them all, every name is shown, none nearer another than a line, all on the track, in the marks\' order',
    big.every(p => p.shown) && layoutOk(big, 400, GAP), J(big.map(p => [p.key, +p.at.toFixed(1)])));
  ok('…a name on its own sits on its mark', near(big.find(p => p.key === 'minor_m').at, big.find(p => p.key === 'minor_m').mark, 1e-9), J(big[0]));
  const head = big.filter(p => p.mark < 40).sort((a, b) => a.at - b.at);
  ok('…a crowd against the head runs down from it a line apart — Gatton\'s seven levels in its top 1.7 m',
    head.length === 7 && head.every((p, i) => near(p.at, i * GAP, 1e-9)), J(head.map(p => [p.key, +p.mark.toFixed(1), +p.at.toFixed(1)])));
  ok('…and one clear of the ends is spread evenly about the middle of its marks, which moves it least',
    J(FS.spread([100, 101, 102], 18, 0, 400)) === J([83, 101, 119]) && J(FS.spread([100, 101, 150], 18, 0, 400)) === J([91.5, 109.5, 150]));
  const small = FS.scale(G, { lo, hi, px: 100, gap: GAP });
  const kept = small.filter(p => p.shown).map(p => p.key).sort();
  ok('a short track shows as many names as a line each allows, and the least give way first: the classes, the record flood, the AEP levels from the 1%',
    kept.length === 6 && J(kept) === J(['aep_0_5_m', 'aep_1_m', 'major_m', 'minor_m', 'moderate_m', 'peak 1893-02-04'])
      && layoutOk(small, 100, GAP) && small.every(p => p.mark >= 0 && p.mark <= 100), J(kept));
  ok('…and a name that gives way keeps its mark', small.filter(p => !p.shown).length === 6 && small.every(p => p.shown || p.at === null));
  ok('the spreading itself: overlapping names run a line apart, pushed back inside the ends',
    J(FS.spread([0, 5, 10, 100], 18, 0, 200)) === J([0, 18, 36, 100]) && J(FS.spread([195, 198, 200], 18, 0, 200)) === J([164, 182, 200]));
  ok('a name on the scale: a class, an AEP level, a flood by month and year, the record starred — on the gauge, else in m AHD',
    FS.scaleText(G.find(l => l.key === 'major_m'), true) === 'Major 15.0 m' && FS.scaleText(G.find(l => l.key === 'aep_1_m'), true) === '1% AEP 15.1 m'
      && FS.scaleText(G.find(l => l.date === '1893-02-04'), true) === 'Feb 1893 ★ 16.3 m' && FS.scaleText(G.find(l => l.date === '1974-01-27'), true) === 'Jan 1974 14.6 m'
      && FS.scaleText(G.find(l => l.key === 'aep_1_m'), false) === '1% AEP 102.69 m', G.map(l => FS.scaleText(l, true)).join(' · '));

  section('Linear or logarithmic');

  // The track's two measures: the linear one, and the logarithm of the depth
  // below the top with a bend of k metres.
  const lin = FS.curve(lo, hi), bend = FS.curve(lo, hi, 0.8);
  ok('the linear track: 0 at 0 m, 1 at the top, in proportion, and back',
    lin.k === null && lin.at(lo) === 0 && lin.at(hi) === 1 && near(lin.at(lo + 0.25 * (hi - lo)), 0.25, 1e-12) && near(lin.of(0.4), lo + 0.4 * (hi - lo), 1e-9));
  ok('the logarithmic one: the same ends, the depth below the top on a logarithm, and back again to the micrometre',
    near(bend.at(lo), 0, 1e-12) && near(bend.at(hi), 1, 1e-12)
      && near(bend.at(hi - 0.8), 1 - Math.log(2) / Math.log1p((hi - lo) / 0.8), 1e-12)
      && [lo, 94.54, 100, 102.54, 103.5, hi].every(h => near(bend.of(bend.at(h)), h, 1e-6)));
  ok('…and it gives the top the room: its top metre over a quarter of the track, where the linear one\'s is a sixteenth',
    near(lin.at(hi) - lin.at(hi - 1), 1 / (hi - lo), 1e-12) && bend.at(hi) - bend.at(hi - 1) > 0.25, `${(bend.at(hi) - bend.at(hi - 1)).toFixed(3)}`);
  const fit = FS.logFit(G, lo, hi);
  const logPos = FS.scale(G, { lo, hi, px: 400, gap: GAP, k: fit.k });
  ok('Gatton\'s twelve levels warrant it: on a linear track their names are pushed off their marks by 49 px on average, on the bent one by 4',
    fit.warrant && near(fit.linear, 49.4, 0.1) && fit.log < 5 && fit.k > 0.5 && fit.k < 1, J(fit));
  ok('…every mark where the bend puts it, every name shown, none on another',
    logPos.every((p, i) => near(p.mark, 400 * (1 - FS.curve(lo, hi, fit.k).at(G[i].ahd)), 1e-9)) && logPos.every(p => p.shown) && layoutOk(logPos, 400, GAP));
  const tried = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5].map(f => Math.max(0.02, f * (hi - lo))).map(k => ({ k, c: FS.crowding(G, lo, hi, k) }));
  const least = Math.min(...tried.map(t => t.c));
  ok('…the gentlest bend that does about as well as the best of them — not the top few centimetres given the whole track',
    near(fit.k, Math.max(...tried.filter(t => t.c <= least + 3).map(t => t.k)), 1e-12) && fit.k > tried.find(t => t.c === least).k,
    J(tried.map(t => [+t.k.toFixed(3), +t.c.toFixed(1)])));
  const classesOnly = FS.ladder({ ...GATTON, aep_levels: [] });
  const cf = FS.logFit(classesOnly.levels, 87.54, classesOnly.top);
  ok('three classes metres apart do not warrant it: the linear scale stays', !cf.warrant && cf.linear < 1, J(cf));
  const one = FS.logFit(classesOnly.levels.slice(2), 87.54, classesOnly.top);
  ok('…nor does one level, which still has a bend for when Log is pressed', !one.warrant && one.k > 0, J(one));
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
    // The lines over the stage stay open: this check presses the buttons in
    // them, and must not race the fold (twinsite holds the fold itself). Nor
    // does the scale turn itself logarithmic, which Gatton's levels warrant,
    // except in the section about that.
    await page.evaluate(() => { DigitalTwin._infoFold(null); DigitalTwin._floodScaleAuto(null); });
    // Gatton's floods wait for their own section (see the head).
    await page.evaluate(() => { delete state.data.stations.find(x => x.id === 'gatton').flood_peaks; });
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
    // The scale on the stage: its head, its track, its marks and names, and
    // whether all of it sits inside the stage.
    const scale = (scope = '') => page.evaluate(sc => {
      const box = document.querySelector(`${sc} #twin-flood-scale`), stage = document.querySelector(`${sc} #twin-stage`);
      if (!box || !stage) return null;
      const r = el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
      const st = r(stage), track = box.querySelector('.twin-scale-track'), play = box.querySelector('.twin-scale-play');
      const inside = b => b.left >= st.left - 0.5 && b.top >= st.top - 0.5 && b.right <= st.right + 0.5 && b.bottom <= st.bottom + 0.5;
      const labels = [...box.querySelectorAll('.twin-scale-label')].map(b => ({ key: b.dataset.flood, text: b.textContent.trim(),
        pressed: b.getAttribute('aria-pressed') === 'true', band: b.classList.contains('is-band'), ...r(b) }));
      const marks = [...box.querySelectorAll('.twin-scale-mark')].map(m => ({ key: m.dataset.level, colour: m.style.getPropertyValue('--sw'), ...r(m) }));
      const hidden = box.hidden || getComputedStyle(box).display === 'none';
      return { hidden, play: play.textContent.trim(), playTitle: play.title, now: box.querySelector('.twin-scale-now').textContent,
               fill: Number(track.style.getPropertyValue('--level')), water: track.style.getPropertyValue('--sw'),
               valuenow: Number(track.getAttribute('aria-valuenow')), valuetext: track.getAttribute('aria-valuetext'),
               track: r(track), head: r(box.querySelector('.twin-scale-head')), labels, marks,
               leaders: box.querySelectorAll('.twin-scale-leaders polyline').length,
               inside: !hidden && inside(r(box)) && inside(r(box.querySelector('.twin-scale-head'))) && labels.every(inside), stage: st };
    }, scope);
    // Where a level's mark should be on the track: to scale from the foot.
    const markY = (T, F, ahd) => T.track.top + T.track.height * (F.top - ahd) / (F.top - F.start);
    const noOverlap = T => T.labels.slice().sort((a, b) => a.top - b.top).every((l, i, a) => i === 0 || l.top >= a[i - 1].bottom - 0.5);

    section('The twin, on a valley the check made, under Gatton\'s levels');
    // The twin in the Stations map, and the 🧊 pane beside it: the flood
    // line whole, every button on it in reach (over the stage it is one
    // line, cut short).
    await page.evaluate(() => { DigitalTwin.openStation('gatton'); setDockTab('twin'); });
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
    let T = await scale();
    ok('on the stage, the scale: ⏸ at its head while the water rises, how high beside it, and all of it inside the stage',
      T && !T.hidden && /^⏸/.test(T.play) && /Pause the rise/.test(T.play) && /^\d+\.\d m · /.test(T.now) && T.inside, J(T && { play: T.play, now: T.now, inside: T.inside }));

    // Held at each level from the line, with a real click.
    const hold = async label => {
      await page.click(`#twin-pane-flood .twin-flood-level:has-text("${label}")`);
      await page.waitForFunction(() => !DigitalTwin.debug().flood.animating, null, { timeout: LOAD_TIMEOUT });
      return fl();
    };
    F = await hold('Moderate');
    ok('"Moderate" on the line holds the water at 97.54 m AHD, stops the rise, and says so on the line',
      near(F.level, 97.54, 1e-9) && !F.animating && F.band === 'moderate_m' && /water 10\.0 m on the gauge, 97\.54 m AHD — past moderate/.test(await text('#twin-pane-flood-now')),
      `${F.level} ${F.band} ${await text('#twin-pane-flood-now')}`);
    ok('…the plane at that height over the station\'s ground', near(F.y, 97.54 - h0, 1e-4), `${F.y}`);
    ok('…yellow, and as opaque as a class', F.colour === pal.moderate && near(F.opacity, 0.62, 1e-9), `${F.colour} ${F.opacity}`);
    T = await scale();
    ok('…and the scale says so: ▶ at its head, 10.0 m · moderate, the track half full in yellow, and Moderate pressed',
      /^▶/.test(T.play) && /Play the rise/.test(T.play) && T.now === '10.0 m · moderate' && T.water === pal.moderate
        && near(T.fill, (97.54 - 87.54) / (103.75 - 87.54), 1e-4) && /water 10\.0 m on the gauge, 97\.54 m AHD — past moderate/.test(T.playTitle)
        && T.labels.find(l => l.key === 'moderate_m').pressed && T.labels.filter(l => l.pressed).length === 1
        && T.valuetext === 'water 10.0 m on the gauge, 97.54 m AHD — past moderate', J({ play: T.play, now: T.now, water: T.water, fill: T.fill, labels: T.labels.map(l => [l.key, l.pressed]) }));
    ok('at moderate the channel is wet and the floodplain, a metre over it, is not',
      await wet(-30, 0) && await wet(-30, -150) && !(await wet(0, 50)) && !(await wet(80, 40)), '');

    ok('…and the focus is still on the level pressed, though the line was drawn again under it',
      await page.evaluate(() => document.activeElement && document.activeElement.dataset.flood) === 'moderate_m');

    // Major by the keyboard: Tab onto it and Enter, as someone without a mouse.
    await page.focus('#twin-pane-flood .twin-flood-level[data-flood="major_m"]');
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
    ok('…and below the first level the water is named by the level it has yet to reach', /0\.0 m on the gauge, 87\.54 m AHD — below minor$/.test(await text('#twin-pane-flood-now'))
      && (await scale()).now === '0.0 m · below minor' && (await scale()).fill === 0, `${await text('#twin-pane-flood-now')} | ${(await scale()).now}`);
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

    // The scale on the stage, at full size: every mark where its level is,
    // every name clear of the others, and each of the ways to move the water.
    section('The scale on the stage');
    T = await scale();
    F = await fl();
    ok('a mark for every level, in its colour, each at its height on the track to scale — 0 m at the foot, the top at the head',
      T.marks.length === 7 && T.marks.every(m => { const l = F.levels.find(x => x.key === m.key); return near(m.top + m.height / 2, markY(T, F, l.ahd), 1.5) && m.colour === l.colour; }),
      J(T.marks.map(m => [m.key, +(m.top + m.height / 2 - markY(T, F, F.levels.find(x => x.key === m.key).ahd)).toFixed(2)])));
    ok('…a name for each, none on another, each joined to its mark, and every one inside the stage',
      T.labels.length === 7 && noOverlap(T) && T.leaders === 7 && T.inside
        && J(T.labels.map(l => l.text)) === J(['Minor 7.0 m', 'Moderate 10.0 m', 'Major 15.0 m', '1% AEP 15.1 m', '0.5% AEP 15.6 m', '0.2% AEP 15.9 m', '0.066% AEP 16.2 m']),
      J(T.labels.map(l => [l.text, +l.top.toFixed(1), +l.bottom.toFixed(1)])));
    ok('…in the order of their marks, top to bottom: no two lines cross',
      J(T.labels.slice().sort((a, b) => a.top - b.top).map(l => l.key)) === J(T.marks.slice().sort((a, b) => a.top - b.top || F.levels.findIndex(x => x.key === b.key) - F.levels.findIndex(x => x.key === a.key)).map(m => m.key)),
      J(T.labels.slice().sort((a, b) => a.top - b.top).map(l => l.key)));
    // A name pressed.
    await page.click('#twin-flood-scale .twin-scale-label[data-flood="aep_1_m"]');
    F = await fl();
    T = await scale();
    ok('a name pressed holds the water at its level, and says it is the one held',
      near(F.level, 102.69, 1e-9) && !F.animating && T.labels.find(l => l.key === 'aep_1_m').pressed && T.now === '15.1 m · 1% AEP'
        && await page.evaluate(() => document.activeElement && document.activeElement.dataset.flood) === 'aep_1_m', `${F.level} ${T.now}`);
    // The track, dragged: from its foot to a quarter of the way up, and let go
    // — the water follows and stays; then onto the moderate mark, give or take
    // a few pixels, and it takes hold of the level itself. The mouse goes where
    // it is told, and the stage is taller than what is left of the window
    // under the lines over it: brought into view first.
    // The map, not the stage: the stage is inside Leaflet's container, which
    // a scrollIntoView would scroll and Leaflet then snaps back, after the
    // track has been measured.
    const stageInView = () => page.evaluate(() => new Promise(r => {
      const st = document.getElementById('twin-stage');
      (st.closest('.leaflet-container') || st).scrollIntoView({ block: 'center' });
      requestAnimationFrame(() => requestAnimationFrame(r));
    }));
    await stageInView();
    T = await scale();
    const tr = T.track, midX = tr.left + tr.width / 2;
    await page.mouse.move(midX, tr.bottom - 1);
    await page.mouse.down();
    const drag = [];
    for (const f of [0.1, 0.2, 0.25]) { await page.mouse.move(midX, tr.bottom - f * tr.height); drag.push((await fl()).level); }
    await page.mouse.up();
    F = await fl();
    const qtr = 87.54 + 0.25 * (103.75 - 87.54);
    ok('the track dragged: the water follows the pointer up it, and stays where it is let go', near(F.level, qtr, 0.2) && !F.animating
      && drag.every((x, i) => i === 0 || x > drag[i - 1]) && await page.evaluate(() => typeof JSON.parse(localStorage.getItem('mn-twin')).floodHold === 'number'),
      `${J(drag)} → ${F.level} (wanted ${qtr.toFixed(2)})`);
    const modY = markY(T, F, 97.54);
    await page.mouse.move(midX, modY + 4);
    await page.mouse.down();
    await page.mouse.up();
    F = await fl();
    ok('…and let go within a few pixels of a mark, it takes hold of that level exactly', near(F.level, 97.54, 1e-9) && F.band === 'moderate_m'
      && await page.evaluate(() => JSON.parse(localStorage.getItem('mn-twin')).floodHold) === 'moderate_m', `${F.level}`);
    // The keys, on the track: Page Up to the next level, Home to 0 m, End to the top.
    await page.focus('#twin-flood-scale .twin-scale-track');
    await page.keyboard.press('PageUp');
    const k1 = (await fl()).level;
    await page.keyboard.press('ArrowUp');
    const k2 = (await fl()).level;
    await page.keyboard.press('Home');
    const k3 = (await fl()).level;
    await page.keyboard.press('End');
    const k4 = (await fl()).level;
    await page.keyboard.press('PageDown');
    const k5 = (await fl()).level;
    ok('the keys on the track: Page Up to the next level, an arrow a hundredth of the way, Home 0 m, End the top, Page Down the level below',
      near(k1, 102.54, 1e-9) && near(k2, 102.54 + 0.01 * (103.75 - 87.54), 1e-6) && near(k3, 87.54, 1e-9) && near(k4, 103.75, 1e-9) && near(k5, 103.47, 1e-9),
      J([k1, k2, k3, k4, k5]));
    ok('…and the track says where the water is, in words, as a slider',
      (await scale()).valuenow === Math.round(100 * (103.47 - 87.54) / (103.75 - 87.54)) && (await scale()).valuetext === 'water 15.9 m on the gauge, 103.47 m AHD — past the 0.2% AEP',
      `${(await scale()).valuenow} ${(await scale()).valuetext}`);
    // A short stage: the names give way, the least of them first. Squeezed
    // here to a little more than the map's overlay can leave it on a phone
    // (its bar, the pill and the caveat stand on it too), and let go
    // again after. The overlay's stage is a flex item that grows to fill the
    // map, so its basis is what is squeezed.
    await page.addStyleTag({ content: '#twin-stage.is-squeezed { flex: 0 0 250px !important; height: 250px !important; }' });
    await page.evaluate(() => document.getElementById('twin-stage').classList.add('is-squeezed'));
    await page.waitForFunction(() => { const s = DigitalTwin.debug().flood.scale; return s && s.labels.length < 7; }, null, { timeout: LOAD_TIMEOUT });
    T = await scale();
    ok('on a short stage fewer names fit: the classes keep theirs, none sits on another, all inside the stage, and every level keeps its mark',
      T.labels.length < 7 && T.labels.length >= 3 && ['minor_m', 'moderate_m', 'major_m'].every(k => T.labels.some(l => l.key === k))
        && noOverlap(T) && T.inside && T.marks.length === 7 && T.leaders === T.labels.length,
      J({ h: T.track.height, labels: T.labels.map(l => [l.key, +l.top.toFixed(1), +l.bottom.toFixed(1)]) }));
    await page.evaluate(() => document.getElementById('twin-stage').classList.remove('is-squeezed'));
    await page.waitForFunction(() => { const s = DigitalTwin.debug().flood.scale; return s && s.labels.length === 7; }, null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => DigitalTwin.setFloodFraction(0.1));

    // The rise, on a short clock (2 s up, 1.2 s held, 0.3 s let out). Frames
    // come when they come — software rendering draws a handful a second — so
    // what is asserted is that each one puts the water where the cycle says
    // for the moment it was drawn, and that over four seconds that went up,
    // held, came down and started again.
    section('The rise');
    const CLOCK = { rise: 2, hold: 1.2, drain: 0.3 };
    await page.click('#twin-pane-flood .twin-flood-play');
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
    ok('the line says what it is doing', /Pause the rise/.test(await text('#twin-pane-flood .twin-flood-play')));

    // Paused: still water, and a still scene draws nothing. The pause settles
    // the water and asks for one last frame, which is right; what must not
    // follow is another. Three animation frames let that one land first (under
    // SwiftShader it can take longer than the click's own round trip), as
    // twin.mjs waits before it counts.
    await page.click('#twin-pane-flood .twin-flood-play');
    await page.evaluate(() => new Promise(r => { let k = 0; const f = () => (++k >= 3 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
    const a = await fl();
    const framesA = await page.evaluate(() => DigitalTwin.debug().frames);
    await page.waitForTimeout(600);
    const b = await fl();
    const framesB = await page.evaluate(() => DigitalTwin.debug().frames);
    ok('⏸ holds the water where it was caught, and a still scene stops drawing', !b.animating && a.level === b.level && framesA === framesB,
      `${a.level} ${b.level} frames ${framesA}→${framesB}`);
    ok('…and the choice is remembered as a place on the way up', await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('mn-twin')); return s.floodAnim === false && typeof s.floodHold === 'number'; }));

    // The scale's head does the same, from the stage.
    await page.click('#twin-flood-scale .twin-scale-play');
    F = await fl();
    T = await scale();
    ok('▶ at the scale\'s head plays the rise again, and both it and the line then offer ⏸', F.animating && /^⏸/.test(T.play) && /Pause the rise/.test(await text('#twin-pane-flood .twin-flood-play')), J(T.play));
    await page.click('#twin-flood-scale .twin-scale-play');
    F = await fl();
    ok('…and ⏸ on it holds the water again, where it was caught', !F.animating && /^▶/.test((await scale()).play));

    // Hidden, and shown.
    await page.click('#twin-pane-flood button:has-text("Hide the water")');
    F = await fl();
    ok('"Hide the water": no water, no staff, no scale, and the line offers it back — with the focus on the offer', !F.on && F.visible === false && F.staff.visible === false
      && (await scale()).hidden && /the water is hidden/.test(await text('#twin-pane-flood'))
      && await page.evaluate(() => document.activeElement && document.activeElement.dataset.flood) === 'show', await text('#twin-pane-flood'));
    ok('…the panel\'s box agrees', await page.evaluate(() => !document.getElementById('twin-flood-on').checked && document.getElementById('twin-flood-anim').disabled));
    await page.click('#twin-pane-flood button:has-text("Show it")');
    F = await fl();
    ok('"Show it" brings it back, and the scale', F.on && F.visible && F.staff.visible && !(await scale()).hidden);

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

    // Gatton's own floods, as HDB records them and 0037 puts them on the
    // station: 1893 is over the rarest AEP level, so the water rises to it.
    section('The floods Gatton has seen');
    await page.evaluate(pk => {
      state.data.stations.find(x => x.id === 'gatton').flood_peaks = [...pk, { date: '1990', height_m: 3.1 }];
      DigitalTwin.setFloodAnim(true);
      DigitalTwin.rebuild();
    }, GATTON_PEAKS);
    await settled();
    F = await fl();
    ok('twelve levels now, and the top is the 1893 flood — 16.3 m on the gauge, over the rarest AEP level — so the rise goes up to it',
      F.levels.length === 12 && near(F.top, 103.87, 1e-9) && F.levels[11].label === 'Highest recorded (1893-02-04)' && F.animating, F.levels.map(l => `${l.key} ${l.ahd}`).join(', '));
    ok('…a ring on the staff for each flood, smaller than a class\'s, in the colour a flood has', F.staff.rings.length === 12
      && F.staff.rings.filter(r => /^peak /.test(r.key)).every(r => r.colour === pal.peak && near(r.y, F.levels.find(l => l.key === r.key).ahd - h0, 1e-4)), J(F.staff.rings));
    ok('…the flood with no level is not drawn, and the notes say so', !F.levels.some(l => l.key === 'peak 1990')
      && (await page.evaluate(() => DigitalTwin.debug().notes)).some(n => /3\.1 m \(1990\) on the gauge/.test(n)));
    await page.evaluate(() => DigitalTwin.floodAt('peak 1893-02-04'));
    F = await fl();
    ok('past the rarest AEP level the water keeps its colour: a flood colours nothing', near(F.level, 103.87, 1e-9) && F.band === 'aep_0_066_m' && F.colour === pal.aepLast, `${F.band} ${F.colour}`);
    T = await scale();
    ok('the scale names the floods by month and year, the record starred at the head, none on another, inside the stage',
      T.labels.some(l => l.text === 'Feb 1893 ★ 16.3 m') && T.labels.some(l => l.text === 'Jan 1974 14.6 m') && noOverlap(T) && T.inside && T.marks.length === 12
        && T.labels.find(l => l.key === 'peak 1893-02-04').top <= Math.min(...T.labels.map(l => l.top)) + 0.5,
      J(T.labels.map(l => [l.text, +l.top.toFixed(1)])));
    ok('…and its marks are where the floods reached, to scale', T.marks.every(m => near(m.top + m.height / 2, markY(T, F, F.levels.find(l => l.key === m.key).ahd), 1.5)));
    await page.click('#twin-flood-scale .twin-scale-label[data-flood="peak 1974-01-27"]');
    F = await fl();
    ok('a flood\'s name pressed holds the water at the level it reached', near(F.level, 102.17, 1e-9) && !F.animating, `${F.level}`);

    // The scale's measure, on Gatton with its floods — the crowd at the head
    // the logarithmic track is for. Linear to begin with; logarithmic by itself
    // a little later (the seam's 300 ms rather than four seconds), Log lit;
    // the water never moved by either; the rise and a drag along the bent
    // track; Log pressed off, and the operator's choice kept for the station;
    // and a station whose levels do not warrant it left linear.
    section('Linear or logarithmic');
    // The Log toggle beside the scale's head: pressed for the bent track.
    const modes = () => page.evaluate(() => `log:${document.getElementById('twin-scale-log').getAttribute('aria-pressed')}`);
    // How far on average a name is pushed off its mark, as drawn.
    const pushed = T => {
      const at = new Map(T.marks.map(m => [m.key, m.top + m.height / 2]));
      const ls = T.labels.filter(l => at.has(l.key));
      return ls.reduce((a, l) => a + Math.abs((l.top + l.bottom) / 2 - at.get(l.key)), 0) / ls.length;
    };
    const want = FS.logFit(FS.ladder({ ...GATTON, flood_peaks: GATTON_PEAKS }).levels, 87.54, 103.87);
    const bendY = (T, k, ahd) => T.track.top + T.track.height * (1 - FS.curve(87.54, 103.87, k).at(ahd));
    await page.evaluate(() => DigitalTwin.floodAt('major_m'));
    F = await fl();
    T = await scale();
    const linPushed = pushed(T);
    ok('the scale opens linear, Log not pressed, though Gatton\'s levels warrant the other: its names fanned out from the head',
      F.measure === 'lin' && F.fit.warrant && near(F.fit.k, want.k, 1e-9) && !F.chosen && !F.autoDone && !F.autoArmed
        && (await modes()) === 'log:false' && linPushed > 30, J({ measure: F.measure, fit: F.fit, modes: await modes(), linPushed }));
    await page.evaluate(() => DigitalTwin._floodScaleAuto(300));
    await page.waitForFunction(() => DigitalTwin.debug().flood.measure === 'log', null, { timeout: 10_000 });
    await page.waitForTimeout(700);    // the marks and names gliding to their places
    F = await fl();
    T = await scale();
    ok('a moment on it turns logarithmic by itself — Log lit — with the bend its levels were fitted with, nobody having chosen',
      F.measure === 'log' && near(F.logK, want.k, 1e-9) && F.autoDone && !F.chosen && (await modes()) === 'log:true',
      J({ measure: F.measure, k: F.logK, want: want.k, modes: await modes() }));
    ok('…the water where it was, at major, and the track filled to major on the bent track',
      near(F.level, 102.54, 1e-9) && !F.animating && near(T.fill, FS.curve(87.54, 103.87, F.logK).at(102.54), 1e-3), `${F.level} ${T.fill}`);
    ok('…every mark where the bend puts it, every name beside its mark rather than fanned out from the head, none on another',
      T.marks.length === 12 && T.marks.every(m => near(m.top + m.height / 2, bendY(T, F.logK, F.levels.find(l => l.key === m.key).ahd), 1.5))
        && T.labels.length === 12 && noOverlap(T) && T.inside && pushed(T) < linPushed / 3,
      `pushed ${pushed(T).toFixed(1)} px on average, against ${linPushed.toFixed(1)} linear`);
    ok('…and it does it once: the auto clock is spent', !F.autoArmed);
    // The rise along the bent track, on a short clock: each frame's water
    // where the cycle puts it *on the track*, so it reaches major two-thirds
    // of the way through the rise rather than in its last tenth.
    const bent = FS.curve(87.54, 103.87, F.logK), RISE = { rise: 2, hold: 0.5, drain: 0.3 };
    const risen = await page.evaluate(async c => {
      DigitalTwin.setFloodAnim(true);
      DigitalTwin._floodClock(c.rise, c.hold, c.drain);
      const out = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 1800) { await new Promise(r => requestAnimationFrame(r)); const d = DigitalTwin.debug().flood; out.push({ t: d.clock, level: d.level, animating: d.animating }); }
      return out;
    }, RISE);
    const offTrack = risen.filter(x => x.t == null || !near(x.level, bent.of(FS.cycle(x.t, RISE)), 1e-3));
    ok('the rise runs along the bent track: every frame\'s water where the cycle puts it on the track, reaching major two-thirds of the way up rather than in the last tenth',
      risen.length > 3 && risen.every(x => x.animating) && offTrack.length === 0 && bent.at(102.54) < 0.75 && FS.curve(87.54, 103.87).at(102.54) > 0.9,
      `${offTrack.length} off; major at ${bent.at(102.54).toFixed(2)} of the rise`);
    await page.evaluate(() => { DigitalTwin._floodClock(null); DigitalTwin.floodAt('major_m'); });
    await stageInView();
    // A press on the bent track, clear of every mark: the water goes where
    // that place on the track stands, not that fraction of the metres.
    T = await scale();
    const trk = T.track, ys = T.marks.map(m => m.top + m.height / 2);
    const tAt = [0.5, 0.45, 0.55, 0.4, 0.6].find(t => ys.every(y => Math.abs(y - (trk.bottom - t * trk.height)) > 9));
    await page.mouse.move(trk.left + trk.width / 2, trk.bottom - tAt * trk.height);
    await page.mouse.down();
    await page.mouse.up();
    F = await fl();
    ok('the bent track pressed holds the water where that place on it stands, not at that fraction of the metres',
      near(F.level, bent.of(tAt), 0.1) && Math.abs(F.level - (87.54 + tAt * (103.87 - 87.54))) > 1 && !F.animating,
      `${F.level.toFixed(2)} at ${tAt} of the track; ${bent.of(tAt).toFixed(2)} wanted`);
    // The keys step along the track, a hundredth of it.
    await page.focus('#twin-flood-scale .twin-scale-track');
    const beforeKey = (await fl()).level;
    await page.keyboard.press('ArrowUp');
    ok('…an arrow a hundredth of the bent track', near((await fl()).level, bent.of(bent.at(beforeKey) + 0.01), 1e-6), `${(await fl()).level}`);
    // Log pressed off: the water stays, and the choice is the operator's.
    await page.evaluate(() => DigitalTwin.floodAt('major_m'));
    await page.click('#twin-flood-scale #twin-scale-log');
    await page.waitForTimeout(700);
    F = await fl();
    T = await scale();
    ok('Log pressed off: the linear track again — every mark to scale — the water where it was, and the choice the operator\'s now',
      F.measure === 'lin' && F.logK === null && F.chosen && near(F.level, 102.54, 1e-9) && (await modes()) === 'log:false'
        && T.marks.every(m => near(m.top + m.height / 2, markY(T, F, F.levels.find(l => l.key === m.key).ahd), 1.5)),
      J({ measure: F.measure, chosen: F.chosen, level: F.level, modes: await modes() }));
    await page.evaluate(() => DigitalTwin.rebuild());
    await settled();
    await page.waitForTimeout(700);    // past the seam's 300 ms
    F = await fl();
    ok('…kept for the station: rebuilt, it opens linear and nothing turns it', F.measure === 'lin' && F.chosen && !F.autoArmed && !F.autoDone, J(F));
    // Log from the keyboard, then back.
    await page.focus('#twin-flood-scale #twin-scale-log');
    await page.keyboard.press('Enter');
    F = await fl();
    ok('Log from the keyboard: the bent track, kept as the choice, the focus still on Log',
      F.measure === 'log' && F.chosen && (await modes()) === 'log:true'
        && await page.evaluate(() => document.activeElement && document.activeElement.id) === 'twin-scale-log');
    await page.click('#twin-flood-scale #twin-scale-log');
    // A station whose levels do not warrant it — Gatton's three classes on
    // their own, in a session that has chosen nothing — stays linear.
    await page.evaluate(() => {
      const s = state.data.stations.find(x => x.id === 'gatton');
      window.__aep = s.aep_levels; window.__pk = s.flood_peaks;
      s.aep_levels = []; delete s.flood_peaks;
      DigitalTwin._floodScaleAuto(300, true);
      DigitalTwin.rebuild();
    });
    await settled();
    await page.waitForTimeout(800);
    F = await fl();
    ok('three classes metres apart: the scale stays linear, nothing armed, nothing chosen', F.levels.length === 3 && F.measure === 'lin'
      && !F.fit.warrant && !F.autoArmed && !F.autoDone && !F.chosen, J({ levels: F.levels.length, measure: F.measure, fit: F.fit }));
    await page.evaluate(() => {
      const s = state.data.stations.find(x => x.id === 'gatton');
      s.aep_levels = window.__aep; s.flood_peaks = window.__pk;
      DigitalTwin._floodScaleAuto(null, true);
    });

    // Gatton drawn as a telemetered river tower (its name ending AL, the SLS
    // set aside): every level that falls on the tower is banded on it, in the
    // colour the scale gives it, with a call-out; its staff reads the gauge.
    section('The levels on a tower');
    await page.evaluate(() => {
      const s = state.data.stations.find(x => x.id === 'gatton');
      window.__gattonName = s.name; s.name = `${s.name} AL`;
      // Recorded on the station (0040): the 4.5 m tower, tall enough for its
      // major class and 1% AEP level to fall on it.
      s.tower_height = 4.5;
      if (typeof SLS !== 'undefined') { window.__slsFor = SLS.forStation; SLS.forStation = (...a) => (a[0] && a[0].id === 'gatton' ? null : window.__slsFor(...a)); }
      DigitalTwin.rebuild();
    });
    await settled();
    const TWR = await page.evaluate(() => { const d = DigitalTwin.debug(); return { deck: d.model.deck && d.model.deck.top, structure: d.model.structure, staff: d.model.towerStaff, parts: d.model.parts, marks: d.flood.towerMarks, levels: d.flood.levels }; });
    const onTower = TWR.levels.filter(l => l.ahd - h0 > 0.1 && l.ahd - h0 <= 4.55 + 1.1).map(l => l.key);
    ok('a tower: on a slab 100 mm proud, its staff up the mast reading the gauge — 10.56 m at the slab, over a zero at 87.54 m AHD',
      TWR.structure === 'tower' && near(TWR.deck, 4.55, 1e-9) && TWR.parts.includes('foundation slab') && TWR.staff && TWR.staff.onGauge && near(TWR.staff.base, h0 + 0.1 - 87.54, 1e-3), J({ structure: TWR.structure, staff: TWR.staff }));
    ok('…every level between the slab and the handrail\'s top is marked on it — floods, classes and AEP levels alike — at its height, a call-out each, none on another',
      TWR.marks && J(TWR.marks.marks.map(m => m.key)) === J(onTower) && onTower.includes('major_m') && onTower.includes('aep_1_m') && onTower.some(k => /^peak /.test(k))
        && TWR.marks.marks.every(m => near(m.y, TWR.levels.find(l => l.key === m.key).ahd - h0, 1e-6))
        && TWR.marks.callouts.length === onTower.length && TWR.marks.callouts.every((c, i, a) => i === 0 || c.y - a[i - 1].y >= 0.45 - 1e-6)
        && TWR.marks.visible && !TWR.marks.exported, J(TWR.marks));
    ok('…its bands in the scale\'s colours', TWR.parts.filter(n => n === 'flood level band').length > 0);
    await page.evaluate(() => {
      const s = state.data.stations.find(x => x.id === 'gatton');
      s.name = window.__gattonName; delete s.flood_peaks; delete s.tower_height;
      if (window.__slsFor) SLS.forStation = window.__slsFor;
      DigitalTwin.rebuild();
    });
    await settled();

    // The same line in the Stations map's twin.
    section('Inside the Stations map');
    await page.evaluate(() => { DigitalTwin.floodAt('major_m'); switchTab('stations'); });
    await page.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => { state.selectedId = 'gatton'; state.map.setView([-27.555, 152.275], 18, { animate: false }); });
    // Zoom 18 offers the twin; pressing the offer hands the map over.
    await page.waitForFunction(() => { const el = document.getElementById('map-twin-offer'); return !!el && !el.hidden; }, null, { timeout: LOAD_TIMEOUT });
    await page.click('#map-twin-offer .map-twin-offer-open');
    await page.waitForFunction(() => { const el = document.querySelector('#map-twin.is-on #twin-flood'); return !!el && !el.hidden; }, null, { timeout: BUILD_TIMEOUT });
    F = await fl();
    ok('at zoom 18 the map offers the twin, pressed it hands over, and its one line carries the water and the controls',
      near(F.level, 102.54, 1e-9) && /Flood levels:/.test(await text('#map-twin #twin-flood')) && (await page.$$('#map-twin #twin-flood .twin-flood-level')).length === 7,
      await text('#map-twin #twin-flood'));
    T = await scale('#map-twin');
    ok('…and the scale is on its stage too, inside it', T && !T.hidden && T.inside && T.now === '15.0 m · major' && noOverlap(T), J(T && { now: T.now, inside: T.inside }));

    // A phone: the map has no row to spare, so the line stands down and the
    // scale is the water's control — still there, still inside the stage.
    await page.setViewportSize({ width: 375, height: 800 });
    // The nav is a drawer at this width, and one left open lays its backdrop
    // over the map: shut, as a phone has it.
    await page.evaluate(() => { if (typeof setNavCollapsed === 'function') setNavCollapsed(true); });
    await page.waitForFunction(() => { const el = document.querySelector('#map-twin #twin-flood'); return !!el && getComputedStyle(el).display === 'none'; }, null, { timeout: LOAD_TIMEOUT });
    T = await scale('#map-twin');
    ok('on a phone the line above the stage stands down, and the scale on the stage stays, inside it, its names clear of one another',
      T && !T.hidden && T.inside && noOverlap(T) && T.labels.length >= 1 && T.stage.height >= 160,
      J(T && { inside: T.inside, labels: T.labels.map(l => [l.key, +l.top.toFixed(1), +l.bottom.toFixed(1)]), track: T.track, head: T.head, stage: T.stage }));
    // A phone's width with a mouse is a narrow window, not a phone: nothing
    // folds there (the phone in the hand is its own section, below).
    const mouseStage = await page.evaluate(() => DigitalTwin.debug().compact);
    ok('…and driven by a mouse, a phone\'s width keeps the names and the hint up, with no "?" and no clock',
      !mouseStage.on && !mouseStage.staged && !mouseStage.q && !mouseStage.namesQuiet && !mouseStage.hudFolded
        && !mouseStage.hudTimer && !mouseStage.scaleTimer, J(mouseStage));
    await page.click('#map-twin .twin-scale-play');
    ok('…and it still starts and stops the rise', (await fl()).animating);
    await page.click('#map-twin .twin-scale-play');
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
    await qp.evaluate(() => { DigitalTwin._infoFold(null); DigitalTwin._floodScaleAuto(null); });
    await qp.evaluate(() => { delete state.data.stations.find(x => x.id === 'gatton').flood_peaks; });
    await qp.evaluate(() => DigitalTwin.openStation('gatton'));
    await qp.waitForFunction(() => { const d = DigitalTwin.debug(); return d.built && d.flood && !d.flood.none && d.flood.level != null; }, null, { timeout: BUILD_TIMEOUT });
    const q = await qp.evaluate(() => DigitalTwin.debug().flood);
    ok('reduced motion: the water stands still at the highest level, and the line offers to play it', !q.animating && near(q.level, 103.75, 1e-9)
      && /Play the rise/.test(await qp.evaluate(() => document.querySelector('#twin-pane-flood .twin-flood-play').textContent)), `${q.animating} ${q.level}`);
    await quiet.close();

    // A phone in the hand — a finger and a phone's screen, the twin opened
    // from the map the way a phone opens it. The stage is the map's size and
    // little of it, so the scale's names and the hint along the foot stand
    // down after five seconds: the names to the marks on the track, which a
    // tap brings them back from (and a tap is for the names, not the water),
    // the hint to its "?", which brings it back. ⏸'s pill is a line and a bit
    // tall, and the whole pill starts and stops the rise. The clock is the
    // seam's while this runs — off for the opening, so what is up can be
    // read, then short — rather than five seconds of waiting each time.
    section('A phone in the hand');
    const hand = await browser.newContext({ viewport: { width: 393, height: 760 }, hasTouch: true, isMobile: true });
    const hp = await hand.newPage();
    const handErrors = [];
    hp.on('pageerror', e => handErrors.push(e.stack || e.message));
    await applyNetworkPolicy(hp, server.origin);
    await hp.route(/QldDem\/ImageServer\/exportImage/, route => {
      const u = new URL(route.request().url());
      const bbox = (u.searchParams.get('bbox') || '').split(',').map(Number);
      const [W, H] = (u.searchParams.get('size') || '0,0').split(',').map(Number);
      const extent = snapExtent(bbox, W, H, u.searchParams.get('adjustAspectRatio'));
      const pw = (extent[2] - extent[0]) / W, ph = (extent[3] - extent[1]) / H;
      return route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'Access-Control-Allow-Origin': '*' },
        body: tiffF32(W, H, extent, (x, y) => groundAt(extent[3] - (y + 0.5) * ph, extent[0] + (x + 0.5) * pw)) });
    });
    await hp.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
    await hp.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
    const clock = await hp.evaluate(() => DigitalTwin.debug().compact);
    ok('on a phone the names and the hint stand down five seconds after they come up', clock.on && clock.ms === 5000, J(clock));
    await hp.evaluate(() => {
      DigitalTwin._infoFold(null);
      DigitalTwin._compact(null);
      DigitalTwin._floodScaleAuto(null);
      delete state.data.stations.find(x => x.id === 'gatton').flood_peaks;
      switchTab('stations');
    });
    await hp.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
    await hp.evaluate(() => { state.selectedId = 'gatton'; state.map.setView([-27.555, 152.275], 18, { animate: false }); });
    await hp.waitForFunction(() => { const el = document.getElementById('map-twin-offer'); return !!el && !el.hidden; }, null, { timeout: LOAD_TIMEOUT });
    await hp.tap('#map-twin-offer .map-twin-offer-open');
    await hp.waitForFunction(() => {
      const d = DigitalTwin.debug();
      return MapTwin.active() && d.built && d.flood && !d.flood.none && d.flood.level != null && !d.status.endsWith('…');
    }, null, { timeout: BUILD_TIMEOUT });
    // What is on the stage for a finger: the hint, its "?", the scale's head,
    // names and marks — boxes, what they look like, and what is under a point.
    const stageNow = () => hp.evaluate(() => {
      const r = el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
      const $ = s => document.querySelector(s);
      const box = $('#twin-flood-scale'), hud = $('#twin-hud'), q = $('#twin-hud-q'), head = $('#twin-flood-scale .twin-scale-head');
      const play = $('#twin-scale-play'), now = $('#twin-scale-now');
      const labels = [...document.querySelectorAll('#twin-scale-labels .twin-scale-label')];
      const nb = r(now), hit = document.elementFromPoint(nb.left + nb.width / 2, nb.top + nb.height / 2);
      const d = DigitalTwin.debug();
      return {
        compact: d.compact, level: d.flood.level, animating: d.flood.animating,
        stage: r($('#twin-stage')), box: r(box), head: r(head), play: r(play), q: r(q),
        qShown: !q.hidden && getComputedStyle(q).display !== 'none', qExpanded: q.getAttribute('aria-expanded'),
        hudShown: getComputedStyle(hud).visibility !== 'hidden', hudText: hud.textContent,
        namesOpacity: Number(getComputedStyle($('#twin-scale-labels')).opacity),
        leadersOpacity: Number(getComputedStyle($('#twin-scale-leaders')).opacity),
        namesTouchable: labels.length > 0 && labels.every(b => getComputedStyle(b).pointerEvents !== 'none'),
        labels: labels.map(b => r(b)),
        marks: [...document.querySelectorAll('#twin-scale-marks .twin-scale-mark')].filter(m => m.getClientRects().length).length,
        readingIsPlay: !!hit && (hit === play || play.contains(hit)),
      };
    });
    let P = await stageNow();
    // The words the 3-D map's hint says for a finger too (core.js): the two views move alike.
    const viewWords = await hp.evaluate(() => viewMoveWords(true));
    ok('in the map\'s twin on a phone the stage says it is one: the "?" at its foot, and the hint beside it in a finger\'s words',
      P.compact.on && P.compact.staged && P.qShown && P.qExpanded === 'true' && P.hudShown
        && P.hudText.startsWith(viewWords) && /pinch to zoom, twist to turn/.test(P.hudText) && !/wheel/.test(P.hudText)
        && P.q.left >= P.stage.left && P.q.bottom <= P.stage.bottom, J({ compact: P.compact, q: P.q, hud: P.hudText }));
    ok('…and the scale up beside it, every name a line tall and none on another, its foot above the "?"',
      P.namesOpacity === 1 && P.namesTouchable && P.labels.length === 7 && P.labels.every(l => l.height <= 18)
        && P.labels.slice().sort((a, b) => a.top - b.top).every((l, i, a) => i === 0 || l.top >= a[i - 1].bottom - 0.5)
        && P.box.bottom <= P.q.top, J({ labels: P.labels.map(l => [+l.top.toFixed(1), +l.height.toFixed(1)]), box: P.box.bottom, q: P.q.top }));
    ok('⏸\'s pill is a line and a bit tall — 36 px at most, where a finger\'s 44 px button made it 49 — and the whole pill, its reading too, is the button',
      P.head.height <= 36 && P.play.height <= 30 && P.readingIsPlay, J({ head: P.head.height, play: P.play.height, readingIsPlay: P.readingIsPlay }));
    // Where a finger lands on the reading — by its place on the screen, since
    // the reading is under ⏸'s reach by design (a tap aimed at the element
    // would be refused as covered).
    const nb = await (await hp.$('#twin-scale-now')).boundingBox();
    const before = (await stageNow()).animating;
    await hp.touchscreen.tap(nb.x + nb.width / 2, nb.y + nb.height / 2);
    const played = (await stageNow()).animating;
    await hp.touchscreen.tap(nb.x + nb.width / 2, nb.y + nb.height / 2);
    ok('…a tap on the reading pauses and plays the rise, both ways', played !== before && (await stageNow()).animating === before,
      `${before} → ${played}`);
    // The clock, short, and the water held so that nothing else moves it.
    // Short enough to wait out, long enough that a check made just after a
    // tap — the fade in (.3 s) done — is well inside it.
    const HAND_MS = 900, HAND_FADE = 450, HAND_PAST = HAND_MS + 600;
    await hp.evaluate(ms => { DigitalTwin.floodAt('moderate_m'); DigitalTwin._compact(ms); }, HAND_MS);
    await hp.waitForTimeout(HAND_PAST);
    P = await stageNow();
    const held = P.level;
    ok('its few seconds up, the hint goes back to its "?", which says so',
      !P.hudShown && P.compact.hudFolded && P.qShown && P.qExpanded === 'false', J({ hud: P.hudShown, q: P.qExpanded }));
    ok('…and the names and their lines go, the marks staying on the track in their colours, and a tap where a name was is not a name\'s',
      P.namesOpacity === 0 && P.leadersOpacity === 0 && !P.namesTouchable && P.marks === 7 && P.compact.namesQuiet,
      J({ names: P.namesOpacity, leaders: P.leadersOpacity, touchable: P.namesTouchable, marks: P.marks }));
    const tb = await (await hp.$('#twin-scale-track')).boundingBox();
    await hp.touchscreen.tap(tb.x + tb.width / 2, tb.y + tb.height * 0.2);
    await hp.waitForTimeout(HAND_FADE);
    P = await stageNow();
    ok('a tap on the track brings the names back — and leaves the water where it was, the tap having been for them',
      P.namesOpacity === 1 && P.namesTouchable && !P.compact.namesQuiet && P.level === held && !P.animating,
      J({ names: P.namesOpacity, level: P.level, held }));
    await hp.waitForTimeout(HAND_PAST);
    P = await stageNow();
    ok('…for its few seconds, after which they go again', P.namesOpacity === 0 && P.compact.namesQuiet, `${P.namesOpacity}`);
    // A drag, with the names down: the water follows it, as ever.
    await hp.mouse.move(tb.x + tb.width / 2, tb.y + tb.height * 0.5);
    await hp.mouse.down();
    await hp.mouse.move(tb.x + tb.width / 2, tb.y + tb.height * 0.3, { steps: 6 });
    await hp.mouse.up();
    await hp.waitForTimeout(HAND_FADE);
    P = await stageNow();
    ok('a drag on the track with the names down moves the water, and brings them back', P.level > held + 0.5 && P.namesOpacity === 1,
      J({ level: P.level, held, names: P.namesOpacity }));
    await hp.tap('#twin-hud-q');
    await hp.waitForTimeout(HAND_FADE);
    P = await stageNow();
    ok('the "?" brings the hint back', P.hudShown && !P.compact.hudFolded && P.qExpanded === 'true', J({ hud: P.hudShown, q: P.qExpanded }));
    await hp.waitForTimeout(HAND_PAST);
    const refolded = await stageNow();
    await hp.tap('#twin-hud-q');
    await hp.tap('#twin-hud-q');
    await hp.waitForTimeout(HAND_FADE);
    P = await stageNow();
    ok('…for its few seconds, and pressed again while it is up it goes at once',
      !refolded.hudShown && refolded.qExpanded === 'false' && !P.hudShown && P.qExpanded === 'false', J({ refolded: refolded.hudShown, after: P.hudShown }));
    ok('nothing threw on the phone', handErrors.length === 0, handErrors.slice(0, 3).join(' | '));
    await hand.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
try {
  const FS = loadModule();
  nodeHalf(FS);
  datumHalf(FS);
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
