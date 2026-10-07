// Flood classes on the ARRO Data and Field Data charts (#226): a station's
// minor, moderate and major lines, and its AEP levels, drawn across a level
// series — each in that series' own datum.
//
// Why a check of its own. Everything that can go wrong here draws a tidy,
// labelled, plausible line. The flood classes are metres on the gauge and the
// AEP levels metres AHD, a level series is one or the other, and the two sit
// the gauge zero apart: 87.54 m at Gatton, 1.53 m at Alligator Creek. A line
// carried across the zero the wrong way, or not at all, or through a zero on
// an assumed datum, is a line in the wrong place with nothing on the chart to
// say so — and the chart is the thing somebody reads a rise off. `smoke`
// sees a tab that renders; `flood` holds the twin's ladder, which only ever
// stands in AHD. Neither can see a chart in the wrong datum.
//
// Two halves.
//
//   1. FloodStages.lines() under Node, against real station records: Gatton's
//      classes as they are on a series on the gauge and through the zero in
//      force (87.54 m AHD) on one in AHD, its AEP levels the other way round,
//      lowest first; a zero on an assumed or a State datum, and no surveyed
//      zero at all, leaving out exactly the lines that needed it and saying
//      which and why — while a series on the gauge keeps its own classes, which
//      need no zero; no datum, no lines; the words a line is labelled with,
//      the figure never rounded; readings that look like the other datum named
//      for what they look like, and not where the zero is too near 0 m AHD to
//      tell; and Bowen's gauge, re-levelled in 1990, saying so to a series that
//      reaches back past it.
//
//   2. The chart in Chromium. An ARRO export for a real "Water Level" sensor,
//      through the door the drop zone uses, on a station whose flood record is
//      set to Gatton's: nothing drawn until the box is ticked, and ticked from
//      the keyboard, the focus kept through the rail's rebuild; the lines at
//      the heights the chart's own axis gives their figures, read back off its
//      tick labels; the axis not moved by them, and the level beyond it named
//      along the top; the labels, the legend's keys and the chart's name; the
//      AEP levels carried down through the zero and, with the axis stretched
//      over them, drawn where 15.15 m is and nowhere near 102.69; the same
//      record in mAHD drawing its classes 87.54 m higher; a zero on an assumed
//      datum leaving out the lines that needed it — not one element drawn for
//      them — with the card saying why; the datum box, and readings that look
//      like the other datum warned of with a fix one press away; Increment
//      drawing none; a Field Data level in counts drawing none and saying why;
//      and **the PNG export carrying them**, read back pixel by pixel.
//
// Run:  npm run floodlines
//       npm run floodlines -- -v    also list what passed

import fs from 'node:fs';
import vm from 'node:vm';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { auditHandlers } from './lib/controls.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b, tol) => a != null && b != null && isFinite(a) && isFinite(b) && Math.abs(a - b) <= tol;
const section = t => console.log(`\n${t}\n`);
const J = v => JSON.stringify(v);
// Every one of `parts` in `text`, in that order — for a note that may have
// been broken across rows wherever the plot is too narrow for it.
const inOrder = (text, parts) => {
  let at = 0;
  for (const p of parts) { const i = String(text).indexOf(p, at); if (i < 0) return false; at = i + p.length; }
  return true;
};

const STATIONS = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;
const byId = id => STATIONS.find(s => s.id === id);
// Gatton's flood record, its floods set aside: classes minor 7, moderate 10
// and major 15 m on the gauge, a zero of 87.54 m AHD since 1929, and four AEP
// levels from 102.69 to 103.75 m AHD — the numbers flood.mjs holds the twin
// to. A zero that far from 0 m AHD is the point: a line in the wrong datum is
// 87 m out, not a plausible few.
const GATTON = (({ flood_peaks, ...rest }) => rest)(byId('gatton'));
const ZERO = 87.54;
const CLASSES = { minor_m: 7, moderate_m: 10, major_m: 15 };
const AEP = { aep_1_m: 102.69, aep_0_5_m: 103.11, aep_0_2_m: 103.47, aep_0_066_m: 103.75 };

function loadModule() {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(repo('flood-velocity.js'), 'utf8')}\n${fs.readFileSync(repo('flood-stages.js'), 'utf8')}\n;this.FloodStages = FloodStages;`, ctx);
  return ctx.FloodStages;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. FloodStages.lines()
// ═════════════════════════════════════════════════════════════════════════════

function nodeHalf(FS) {
  section('The record this check reads');
  const fc = GATTON.flood_classes.slice().sort((a, b) => (a.as_at < b.as_at ? 1 : -1))[0];
  ok('Gatton still carries the classes, the zero and the AEP levels this check is written against',
    Object.entries(CLASSES).every(([k, v]) => fc[k] === v) && GATTON.gauge_survey.length === 1
      && GATTON.gauge_survey[0].gauge_zero_m === ZERO && GATTON.gauge_survey[0].datum === 'AHD'
      && Object.entries(AEP).every(([k, v]) => GATTON.aep_levels[0][k] === v),
    J({ fc, zero: GATTON.gauge_survey, aep: GATTON.aep_levels[0] }));

  section('A series on the gauge, and one in AHD');
  const G = FS.lines(GATTON, 'gauge');
  const want = (k, v, conv) => { const l = G.lines.find(x => x.key === k); return l && near(l.value, v, 1e-9) && l.converted === conv; };
  ok('on the gauge, the classes are where the list puts them: 7, 10 and 15 m, not carried across anything',
    Object.entries(CLASSES).every(([k, v]) => want(k, v, false)), J(G.lines));
  ok('…and the AEP levels come down through the zero in force: 102.69 − 87.54 = 15.15 m, and so on',
    Object.entries(AEP).every(([k, v]) => want(k, v - ZERO, true)), J(G.lines.map(l => [l.key, l.value])));
  ok('…lowest first, nothing left out and nothing to say', G.lines.length === 7 && G.notes.length === 0
    && G.lines.every((l, i) => i === 0 || l.value >= G.lines[i - 1].value) && G.datum === 'gauge', J(G.notes));
  const A = FS.lines(GATTON, 'AHD');
  const wantA = (k, v, conv) => { const l = A.lines.find(x => x.key === k); return l && near(l.value, v, 1e-9) && l.converted === conv; };
  ok('in AHD, the classes go up through the zero: 7 + 87.54 = 94.54 m AHD, 97.54, 102.54',
    Object.entries(CLASSES).every(([k, v]) => wantA(k, v + ZERO, true)), J(A.lines.map(l => [l.key, l.value])));
  ok('…and the AEP levels are as the sheet gives them', Object.entries(AEP).every(([k, v]) => wantA(k, v, false)));
  ok('…every line the same figure, carried across, as the other datum\'s: the two answers are one water level',
    A.lines.every(a => { const g = G.lines.find(x => x.key === a.key); return g && near(a.value - g.value, ZERO, 1e-9); }));
  ok('…and the record\'s own figure kept beside it for the words', A.lines.find(l => l.key === 'minor_m').own === 7
    && A.lines.find(l => l.key === 'minor_m').ownDatum === 'gauge' && G.lines.find(l => l.key === 'aep_1_m').own === 102.69);
  ok('the classes alone, or the AEP levels alone, when only one is asked for',
    FS.lines(GATTON, 'gauge', { aep: false }).lines.every(l => l.kind !== 'aep')
      && FS.lines(GATTON, 'gauge', { classes: false }).lines.every(l => l.kind === 'aep')
      && FS.lines(GATTON, 'gauge', { classes: false }).lines.length === 4);
  const none = FS.lines(GATTON, null);
  ok('no datum, no lines — and a sentence saying so', none.lines.length === 0 && none.notes.length === 1
    && /metres on the gauge or metres AHD/.test(none.notes[0]), J(none.notes));
  const bare = FS.lines({ id: 'x', name: 'Nowhere' }, 'gauge');
  ok('a station with none of it: nothing to draw, nothing to say, and `has` says so',
    bare.lines.length === 0 && bare.notes.length === 0 && !bare.has.classes && !bare.has.aep
      && G.has.classes && G.has.aep);
  const moved = FS.lines({ ...GATTON,
    flood_classes: [{ as_at: '2001-01-01', minor_m: 1, moderate_m: 2, major_m: 3 }, ...GATTON.flood_classes],
    gauge_survey: [{ valid_from: '1900-01-01', valid_to: '1929-08-31', gauge_zero_m: 80, datum: 'AHD' }, ...GATTON.gauge_survey] }, 'AHD');
  ok('the newest edition of the classes, through the zero still in force — not an older one of either',
    near(moved.lines.find(l => l.key === 'minor_m').value, 94.54, 1e-9), J(moved.lines[0]));

  section('A zero that cannot carry a figure across');
  const assumed = { ...GATTON, gauge_survey: [{ valid_from: '1929-09-01', gauge_zero_m: 10, datum: 'ASSUM' }] };
  const aG = FS.lines(assumed, 'gauge');
  ok('on an assumed datum, a series on the gauge keeps its classes — they need no zero —',
    Object.entries(CLASSES).every(([k, v]) => { const l = aG.lines.find(x => x.key === k); return l && l.value === v; }));
  ok('…and loses the AEP levels, which did, with a note naming each and why',
    !aG.lines.some(l => l.kind === 'aep') && aG.notes.length === 1
      && /AEP levels are metres AHD, and the gauge's zero is on the assumed datum rather than AHD, so they cannot be brought down to heights on the gauge: 1% 102\.69, 0\.5% 103\.11, 0\.2% 103\.47, 0\.066% 103\.75 m AHD\./.test(aG.notes[0]), J(aG.notes));
  const aA = FS.lines(assumed, 'AHD');
  ok('…and a series in AHD the other way round: the AEP levels as given, the classes left out and named',
    aA.lines.length === 4 && aA.lines.every(l => l.kind === 'aep' && !l.converted) && aA.notes.length === 1
      && /flood classes are heights on the gauge, and the gauge's zero is on the assumed datum rather than AHD, so they cannot be put in metres AHD: minor 7\.0 m, moderate 10\.0 m, major 15\.0 m\./.test(aA.notes[0]), J(aA.notes));
  ok('…never hung from that zero anyway: no line anywhere at 10 m over a class', ![...aG.lines, ...aA.lines].some(l => [17, 20, 25].includes(l.value)));
  const noZero = FS.lines({ ...GATTON, gauge_survey: [] }, 'AHD');
  ok('no surveyed zero at all: the same, in its own words', noZero.lines.every(l => l.kind === 'aep')
    && /the gauge has no surveyed zero, so they cannot be put in metres AHD/.test(noZero.notes[0]), J(noZero.notes));
  const beau = byId('beaudesert_al');
  const bz = (beau.gauge_survey || [])[0];
  ok('a real State datum — Beaudesert AL, 29.45 m on the State datum — leaves its AEP levels off a series on the gauge',
    bz && bz.datum === 'STATE' && (() => { const r = FS.lines(beau, 'gauge');
      return r.lines.length === 3 && !r.lines.some(l => l.kind === 'aep') && /on the State datum rather than AHD/.test(r.notes[0]); })(),
    J(bz));

  section('How a line is said');
  const lt = k => FS.lineText(G.lines.find(l => l.key === k), 'gauge');
  const ltA = k => FS.lineText(A.lines.find(l => l.key === k), 'AHD');
  ok('"Minor 7.0 m on the gauge", "1% AEP 15.15 m on the gauge", "Minor 94.54 m AHD", "1% AEP 102.69 m AHD"',
    lt('minor_m') === 'Minor 7.0 m on the gauge' && lt('aep_1_m') === '1% AEP 15.15 m on the gauge'
      && ltA('minor_m') === 'Minor 94.54 m AHD' && ltA('aep_1_m') === '1% AEP 102.69 m AHD',
    [lt('minor_m'), lt('aep_1_m'), ltA('minor_m'), ltA('aep_1_m')].join(' | '));
  const odd = FS.lines({ ...GATTON, flood_classes: [{ as_at: '2026-01-01', minor_m: 3.25 }] }, 'gauge');
  ok('a class is given as the list gives it — 3.25 m is 3.25, never rounded to 3.3',
    FS.lineText(odd.lines.find(l => l.key === 'minor_m'), 'gauge') === 'Minor 3.25 m on the gauge');
  ok('the line\'s title says where its figure came from, and through which zero',
    /^1% AEP 102\.69 m AHD, less the gauge zero, 87\.54 m AHD \(since 1929-09-01\): 15\.15 m on the gauge\. Modelled — indicative\.$/.test(FS.lineHow(G.lines.find(l => l.key === 'aep_1_m'), G))
      && /^Minor 7\.0 m on the gauge, plus the gauge zero, 87\.54 m AHD \(since 1929-09-01\): 94\.54 m AHD\.$/.test(FS.lineHow(A.lines.find(l => l.key === 'minor_m'), A)),
    FS.lineHow(G.lines.find(l => l.key === 'aep_1_m'), G));

  section('Readings that look like the other datum');
  const sus = FS.lines(GATTON, 'gauge', { typical: 95 });
  ok('taken as on the gauge but sitting around 95 m: they look like metres AHD, and the answer says so',
    sus.suspect && sus.suspect.datum === 'AHD' && /look like metres AHD/.test(sus.suspect.words), J(sus.suspect));
  const susA = FS.lines(GATTON, 'AHD', { typical: 3 });
  ok('taken as AHD but sitting around 3 m: they look like heights on the gauge', susA.suspect && susA.suspect.datum === 'gauge', J(susA.suspect));
  ok('readings where their own datum puts them raise nothing',
    FS.lines(GATTON, 'gauge', { typical: 6 }).suspect === null && FS.lines(GATTON, 'AHD', { typical: 96 }).suspect === null);
  const bohle = byId('bohle_river_al');
  ok('and where the zero is too near 0 m AHD for the two to be told apart — Bohle River, 6.50 m — nothing is guessed',
    bohle.gauge_survey[0].gauge_zero_m === 6.5 && FS.lines(bohle, 'gauge', { typical: 12 }).suspect === null
      && FS.lines(bohle, 'AHD', { typical: 3 }).suspect === null);

  section('A gauge re-levelled inside the series');
  const bowen = byId('bowen_pump_station_a');
  const rl = FS.lines(bowen, 'gauge', { since: '1985-01-01' });
  ok('Bowen, re-levelled on 1990-05-09 from 6.25 to 4.81 m AHD: a series from 1985 is told a reading then was 1.44 m lower',
    rl.relevelled && rl.relevelled.from === '1990-05-09' && rl.relevelled.was.m === 6.25 && rl.relevelled.now.m === 4.81
      && /re-levelled on 1990-05-09, from a zero of 6\.25 m AHD to 4\.81 m AHD: a reading before then is 1\.44 m lower than the same water reads on the gauge today/.test(rl.relevelled.words),
    J(rl.relevelled));
  ok('…and it is not a line left out: the lines are all there', rl.notes.length === 0 && rl.lines.length >= 3);
  ok('a series that starts after it, or one in AHD, is told nothing',
    FS.lines(bowen, 'gauge', { since: '1995-01-01' }).relevelled === null && FS.lines(bowen, 'AHD', { since: '1985-01-01' }).relevelled === null);
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. The chart
// ═════════════════════════════════════════════════════════════════════════════

// An ARRO export: a level rising from 5 to 12 m and back over a day and a bit,
// every fifteen minutes. Named the way ARRO names a file, so the import links
// itself to Bohle River AL's "Water Level" sensor by the sensor id in its tail.
const SENSOR = '532043_0_H_2722';
function exportCsv(unit, offset) {
  const rows = [['Reading', 'Receive', 'Value', 'Unit', 'Data Quality', 'Raw Value']];
  const t0 = Date.UTC(2026, 1, 1);
  for (let i = 0; i < 120; i++) {
    const v = offset + 5 + 7 * Math.sin(Math.PI * i / 119) ** 2;
    const t = new Date(t0 + i * 900000).toISOString().slice(0, 19).replace('T', ' ');
    rows.push([t, t, v.toFixed(3), unit, 'A', Math.round(v * 1000)]);
  }
  return rows.map(r => r.join(',')).join('\n');
}

async function browserHalf() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    page.on('pageerror', e => errors.push(e.stack || e.message));

    await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });

    // Bohle River AL is real, and so is its sensor; its flood record is set to
    // Gatton's here, as flood.mjs sets the records it stands the twin on, so
    // the figures below are this check's arithmetic rather than whatever the
    // station file holds today.
    const linked = await page.evaluate(G => {
      const st = state.data.stations.find(s => s.id === 'bohle_river_al');
      if (!st) return null;
      st.flood_classes = JSON.parse(JSON.stringify(G.flood_classes));
      st.gauge_survey = JSON.parse(JSON.stringify(G.gauge_survey));
      st.aep_levels = JSON.parse(JSON.stringify(G.aep_levels));
      delete st.flood_peaks;
      return (st.sensors || []).find(x => x.sensor_id === '532043.0.H.2722')?.type || null;
    }, GATTON);
    ok('the fixture station and its sensor are in the station file', linked === 'Water Level', String(linked));

    await page.evaluate(async ({ csv, name }) => {
      switchTab('arrodata');
      await new Promise(r => setTimeout(r, 60));
      ArroData.importFiles([new File([csv], name, { type: 'text/csv' })]);
    }, { csv: exportCsv('m', 0), name: `aem_Bohle_River_AL_532043_Water_Level_${SENSOR}.csv` });
    await page.waitForFunction(() => window.ArroData.ad.series.length === 1, null, { timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(150);
    const key = await page.evaluate(() => ArroData.ad.series[0].key);

    // What the chart has drawn, read back off the SVG: each flood line with its
    // figure and height, the labels and the beyond-the-chart notes, and the
    // vertical axis as its own tick labels state it — so "where 7.0 m is" is
    // the axis's answer, not this check's.
    const chart = () => page.evaluate(() => {
      const svg = document.getElementById('ad-svg');
      const ticks = [...svg.querySelectorAll(':scope > text')]
        .filter(t => t.getAttribute('text-anchor') === 'end' && t.getAttribute('x') === '58')
        .map(t => ({ v: parseFloat(t.textContent), y: parseFloat(t.getAttribute('y')) - 3.5 }));
      return {
        ticks,
        lines: [...svg.querySelectorAll('.ad-flood-line')].map(l => ({ series: l.dataset.series, key: l.dataset.key,
          value: parseFloat(l.dataset.value), y: parseFloat(l.getAttribute('y1')), y2: parseFloat(l.getAttribute('y2')),
          stroke: l.getAttribute('stroke'), dash: l.getAttribute('stroke-dasharray') })),
        labels: [...svg.querySelectorAll('.ad-flood-label')].map(l => ({ key: l.dataset.key, series: l.dataset.series,
          text: l.textContent, y: parseFloat(l.getAttribute('y')) })),
        offs: [...svg.querySelectorAll('.ad-flood-off')].map(t => ({ series: t.dataset.series, side: t.dataset.side,
          keys: (t.dataset.keys || '').split(' '),
          text: [...t.querySelectorAll('tspan')].map((x, i) => (i && x.hasAttribute('x') ? ' ' : '') + x.textContent).join('') })),
        name: svg.getAttribute('aria-label'),
        legend: [...document.querySelectorAll('#ad-readout .ad-flood-key [data-key]')].map(k => ({ key: k.dataset.key, text: k.textContent.replace(/\s+/g, ' ').trim() })),
        card: (document.querySelector('.ad-series')?.innerText || '').replace(/\s+/g, ' '),
      };
    });
    // The height the axis puts a figure at, from the two ticks furthest apart.
    const axisY = (c, v) => {
      const a = c.ticks[0], b = c.ticks[c.ticks.length - 1];
      return a.y + (v - a.v) * (b.y - a.y) / (b.v - a.v);
    };
    const cardOf = k => page.evaluate(k => (document.querySelector(`[data-flood="${k}:classes"]`)?.closest('.ad-series')?.innerText || '').replace(/\s+/g, ' '), k);

    section('Off until it is asked for');
    const before = await chart();
    const boxes = await page.evaluate(k => ['classes', 'aep', 'fit'].map(w => {
      const el = document.querySelector(`[data-flood="${k}:${w}"]`);
      return el && { type: el.type, checked: el.checked, disabled: el.disabled, name: el.getAttribute('aria-label'),
                     visible: el.closest('label')?.textContent.trim() };
    }), key);
    ok('the card offers three boxes — Flood classes, AEP levels, stretch the axis — native checkboxes, named for the series',
      boxes.every(b => b && b.type === 'checkbox' && !b.disabled) && boxes[0].visible === 'Flood classes'
        && boxes[1].visible === 'AEP levels' && boxes[2].visible === 'stretch the axis'
        && boxes.every(b => b.name.toLowerCase().startsWith(b.visible.toLowerCase()) && b.name.includes('Bohle River AL')), J(boxes));
    ok('…all off, and a chart nobody has touched draws no flood line, note, label or key',
      boxes.every(b => !b.checked) && !before.lines.length && !before.labels.length && !before.offs.length && !before.legend.length);
    ok('the axis reads 5 to 12 m with room either side — the readings, not the levels', before.ticks.length >= 4
      && before.ticks[0].v <= 5 && before.ticks[before.ticks.length - 1].v >= 12 && before.ticks[before.ticks.length - 1].v < 13, J(before.ticks));

    section('Flood classes, from the keyboard');
    await page.focus(`[data-flood="${key}:classes"]`);
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    const focus = await page.evaluate(k => {
      const el = document.activeElement;
      return { flood: el && el.dataset ? el.dataset.flood : null, checked: el && el.checked };
    }, key);
    ok('Space ticks it, and the focus is on it again after the rail is rebuilt under it',
      focus.flood === `${key}:classes` && focus.checked === true, J(focus));
    const cl = await chart();
    const line = k => cl.lines.find(l => l.key === k && l.series === key);
    ok('minor and moderate are drawn, across the whole plot', line('minor_m') && line('moderate_m')
      && cl.lines.every(l => l.y === l.y2), J(cl.lines));
    ok('…at their figures on the gauge, 7 and 10 m', near(line('minor_m')?.value, 7, 1e-9) && near(line('moderate_m')?.value, 10, 1e-9));
    ok('…and at the heights the chart\'s own axis puts 7.0 and 10.0 m',
      near(line('minor_m')?.y, axisY(cl, 7), 0.3) && near(line('moderate_m')?.y, axisY(cl, 10), 0.3),
      `minor at ${line('minor_m')?.y}, the axis says ${axisY(cl, 7).toFixed(2)}; moderate at ${line('moderate_m')?.y}, the axis says ${axisY(cl, 10).toFixed(2)}`);
    ok('the axis did not move for them', J(cl.ticks) === J(before.ticks), `${J(before.ticks)} → ${J(cl.ticks)}`);
    ok('major, 15 m, is beyond it: no line, and the note along the top names it, with its datum',
      !line('major_m') && cl.offs.length === 1 && cl.offs[0].side === 'above' && J(cl.offs[0].keys) === J(['major_m'])
        && /Above the chart:\s*Major 15\.0\s*m on the gauge/.test(cl.offs[0].text), J(cl.offs));
    ok('each line in its class colour and a dash of its own — colour is not the only thing telling them apart',
      line('minor_m') && line('moderate_m') && line('minor_m').stroke !== line('moderate_m').stroke
        && line('minor_m').dash && line('moderate_m').dash && line('minor_m').dash !== line('moderate_m').dash, J(cl.lines));
    ok('each labelled with its class and its datum', ['Minor 7.0 m on the gauge', 'Moderate 10.0 m on the gauge']
      .every(t => cl.labels.some(l => l.text === t)), J(cl.labels));
    ok('the legend has a key for each, the one beyond the chart saying so',
      J(cl.legend.map(k => k.key)) === J(['minor_m', 'moderate_m', 'major_m'])
        && /Major 15\.0 \(above the chart\)/.test(cl.legend[2].text) && /Minor 7\.0/.test(cl.legend[0].text), J(cl.legend));
    ok('the chart\'s name says them too', /Flood lines on .*m on the gauge: minor 7\.0, moderate 10\.0; above the chart, major 15\.0\./.test(cl.name), cl.name);
    ok('the card says which datum it took and why — the sensor\'s type — and what it drew',
      /readings in/.test(cl.card) && /auto — m on the gauge/.test(cl.card) && /“Water Level” sensor reads its height on the gauge/.test(cl.card)
        && /Drawn, m on the gauge: minor 7\.0 · moderate 10\.0 · major 15\.0/.test(cl.card), cl.card);

    section('AEP levels, carried down through the zero');
    await page.click(`[data-flood="${key}:aep"]`);
    await page.waitForTimeout(150);
    const ae = await chart();
    ok('all four are beyond the readings, and the note along the top names them on the gauge',
      ae.offs.length === 1 && J(ae.offs[0].keys) === J(['major_m', 'aep_1_m', 'aep_0_5_m', 'aep_0_2_m', 'aep_0_066_m'])
        && inOrder(ae.offs[0].text, ['Above the chart:', 'Major 15.0', '1% AEP 15.15', '0.5% AEP 15.57', '0.2% AEP 15.93', '0.066% AEP 16.21', 'm on the gauge']),
      J(ae.offs));
    ok('the card says they were carried across the zero', /the AEP levels carried across the gauge zero, 87\.54 m AHD/.test(ae.card), ae.card);
    await page.click(`[data-flood="${key}:fit"]`);
    await page.waitForTimeout(150);
    const st = await chart();
    const sl = k => st.lines.find(l => l.key === k && l.series === key);
    ok('stretched, the axis takes them all in, and nothing is beyond it',
      st.ticks[st.ticks.length - 1].v >= 16 && st.offs.length === 0 && st.lines.length === 7, J(st.ticks.map(t => t.v)));
    ok('a converted line lands where it should: 1% AEP at 15.15 m on the gauge, where the axis puts 15.15',
      near(sl('aep_1_m')?.value, 102.69 - 87.54, 1e-9) && near(sl('aep_1_m')?.y, axisY(st, 15.15), 0.3),
      `value ${sl('aep_1_m')?.value}, at ${sl('aep_1_m')?.y}, the axis says ${axisY(st, 15.15).toFixed(2)}`);
    ok('…and so do the other three, and no line anywhere stands at an AHD figure',
      Object.entries(AEP).every(([k, v]) => near(sl(k)?.value, v - ZERO, 1e-9) && near(sl(k)?.y, axisY(st, v - ZERO), 0.3))
        && !st.lines.some(l => l.value > 50), J(st.lines.map(l => [l.key, l.value])));
    ok('…the classes still where they were', near(sl('minor_m')?.y, axisY(st, 7), 0.3) && near(sl('major_m')?.y, axisY(st, 15), 0.3));
    ok('…and the AEP labels say 1% AEP 15.15 m on the gauge, not 102.69',
      st.labels.some(l => l.text === '1% AEP 15.15 m on the gauge') && !st.labels.some(l => /102\.69/.test(l.text)), J(st.labels.map(l => l.text)));
    const vov = await page.evaluate(() => [...document.querySelectorAll('#ad-vov text')].map(t => parseFloat(t.textContent)));
    ok('the vertical navigator\'s track reaches them too', Math.max(...vov) >= 16.21, J(vov));

    section('The PNG export carries them');
    // The download, read rather than saved: the blob the export hands to
    // createObjectURL, decoded in the page at the export's own 2× scale.
    const png = await page.evaluate(async () => {
      let blob = null;
      const real = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = b => { blob = b; return real.call(URL, b); };
      HTMLAnchorElement.prototype.click = function () {};
      try {
        ArroData.exportImg('png');
        for (let i = 0; i < 60 && !blob; i++) await new Promise(r => setTimeout(r, 100));
      } finally { URL.createObjectURL = real; HTMLAnchorElement.prototype.click = click; }
      if (!blob) return null;
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const svg = document.getElementById('ad-svg');
      const w = +svg.getAttribute('width');
      // The colour each line is meant to be, from the design system's own
      // tokens — not from the line's attribute, which is the thing on trial.
      const css = getComputedStyle(document.documentElement);
      const token = k => css.getPropertyValue({ minor_m: '--flood-minor', major_m: '--flood-major' }[k] || '--muted').trim();
      const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
      // The share of a run of pixels along a line's row that are that line's
      // colour, from well clear of its label to the plot's right edge.
      const run = (el) => {
        const y = Math.round(parseFloat(el.getAttribute('y1')) * 2);
        const want = hex(token(el.dataset.key));
        const x0 = 2 * 360, x1 = 2 * (w - 20);
        const px = ctx.getImageData(x0, y, x1 - x0, 1).data;
        let hit = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (Math.hypot(px[i] - want[0], px[i + 1] - want[1], px[i + 2] - want[2]) < 60) hit++;
        }
        return hit / (px.length / 4);
      };
      const label = (el) => {
        const want = hex(token(el.dataset.key));
        const y = Math.round(parseFloat(el.getAttribute('y')) * 2);
        const px = ctx.getImageData(2 * 64, y - 14, 2 * 150, 16).data;
        let hit = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (Math.hypot(px[i] - want[0], px[i + 1] - want[1], px[i + 2] - want[2]) < 80) hit++;
        }
        return hit;
      };
      const lineOf = k => svg.querySelector(`.ad-flood-line[data-key="${k}"]`);
      const labelOf = k => svg.querySelector(`.ad-flood-label[data-key="${k}"]`);
      return {
        size: [bmp.width, bmp.height], w,
        minor: run(lineOf('minor_m')), major: run(lineOf('major_m')), aep: run(lineOf('aep_1_m')),
        minorLabel: label(labelOf('minor_m')),
        tokens: ['minor_m', 'major_m', 'aep_1_m'].map(token),
      };
    });
    ok('a PNG came out, at twice the chart\'s size', png && png.size[0] === png.w * 2
      && png.tokens.every(t => /^#[0-9a-f]{6}$/i.test(t)), J(png && [png.size, png.tokens]));
    ok('minor\'s dotted line runs across it, in its colour', png && png.minor > 0.2, J(png));
    ok('…major\'s long dash', png && png.major > 0.3, J(png));
    ok('…the 1% AEP level\'s fine dots', png && png.aep > 0.12, J(png));
    ok('…and minor\'s label is written in it', png && png.minorLabel > 20, J(png));
    const svgText = await page.evaluate(async () => {
      let blob = null;
      const real = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = b => { blob = b; return real.call(URL, b); };
      HTMLAnchorElement.prototype.click = function () {};
      try { ArroData.exportImg('svg'); } finally { URL.createObjectURL = real; HTMLAnchorElement.prototype.click = click; }
      return blob ? blob.text() : '';
    });
    ok('the SVG export carries the lines, the labels and the plate behind them, in literal colours',
      /class="ad-flood-line"/.test(svgText) && />Minor 7\.0 m on the gauge</.test(svgText) && />1% AEP 15\.15 m on the gauge</.test(svgText)
        && /id="ad-flood-plate"/.test(svgText) && !/stroke="var\(/.test(svgText), svgText.length);

    section('The datum box, and readings that look like the other datum');
    await page.click(`[data-flood="${key}:fit"]`);                  // back to fitting the readings
    await page.waitForTimeout(100);
    await page.selectOption(`[data-flood="${key}:datum"]`, 'AHD');
    await page.waitForTimeout(150);
    const wrong = await chart();
    ok('set by hand to m AHD, every line goes up through the zero — off the top of readings of 5 to 12 m',
      wrong.lines.length === 0 && wrong.offs.length === 1 && /Minor 94\.54/.test(wrong.offs[0].text), J(wrong.offs));
    ok('…the card says it was set by hand, and that the readings look like heights on the gauge',
      /set by hand; auto would take them as m on the gauge/.test(wrong.card) && /They look like heights on the gauge\./.test(wrong.card), wrong.card);
    await page.click('.ad-flood-suspect button');
    await page.waitForTimeout(150);
    const fixed = await chart();
    ok('one press takes them as on the gauge again, and the lines come back to 7 and 10 m',
      fixed.lines.some(l => l.key === 'minor_m' && near(l.y, axisY(fixed, 7), 0.3)) && !/look like/.test(fixed.card)
        && await page.evaluate(() => ArroData.ad.series[0].flood.datum) === 'gauge', fixed.card);

    section('The same record in mAHD');
    await page.evaluate(async ({ csv, name }) => {
      ArroData.importFiles([new File([csv], name, { type: 'text/csv' })]);
    }, { csv: exportCsv('mAHD', ZERO), name: `aem_Bohle_River_AL_532043_Water_Level_AHD_${SENSOR}.csv` });
    await page.waitForFunction(() => window.ArroData.ad.series.length === 2, null, { timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(150);
    const ahd = await page.evaluate(() => ArroData.ad.series[1].key);
    await page.evaluate(k => { ArroData.solo(k); ArroData.setFlood(k, 'classes', true); }, ahd);
    await page.waitForTimeout(150);
    const ah = await chart();
    const al = k => ah.lines.find(l => l.key === k && l.series === ahd);
    ok('its unit decides: m AHD, said so, and no box to overrule it',
      /Readings in m AHD — their unit, mAHD, says so\./.test(await cardOf(ahd))
        && await page.evaluate(k => !document.querySelector(`[data-flood="${k}:datum"]`), ahd), await cardOf(ahd));
    ok('a converted line lands where it should: minor at 7 + 87.54 = 94.54 m AHD, where the axis puts it',
      near(al('minor_m')?.value, 94.54, 1e-9) && near(al('minor_m')?.y, axisY(ah, 94.54), 0.3), J(ah.lines));
    ok('…moderate at 97.54, and major, 102.54, beyond the top',
      near(al('moderate_m')?.value, 97.54, 1e-9) && !al('major_m') && ah.offs.some(o => /Major 102\.54\s*m AHD/.test(o.text)), J(ah.offs));
    ok('…labelled in m AHD', ah.labels.some(l => l.text === 'Minor 94.54 m AHD') && ah.labels.some(l => l.text === 'Moderate 97.54 m AHD'), J(ah.labels));

    section('A zero on an assumed datum: the lines that needed it are not drawn');
    await page.evaluate(k => {
      state.data.stations.find(s => s.id === 'bohle_river_al').gauge_survey = [{ valid_from: '1929-09-01', gauge_zero_m: 10, datum: 'ASSUM' }];
      ArroData.setFlood(k, 'aep', true);
    }, ahd);
    await page.waitForTimeout(150);
    const asA = await chart();
    ok('the series in AHD loses its classes — not one line, label or note drawn for them —',
      !asA.lines.some(l => ['minor_m', 'moderate_m', 'major_m'].includes(l.key))
        && !asA.labels.some(l => ['minor_m', 'moderate_m', 'major_m'].includes(l.key))
        && !asA.offs.some(o => o.keys.some(k => ['minor_m', 'moderate_m', 'major_m'].includes(k))), J(asA));
    ok('…keeps its AEP levels, which are AHD already', asA.offs.some(o => /1% AEP 102\.69/.test(o.text)), J(asA.offs));
    ok('…and the card says why, in words', /Not drawn — the flood classes are heights on the gauge, and the gauge's zero is on the assumed datum rather than AHD, so they cannot be put in metres AHD: minor 7\.0 m, moderate 10\.0 m, major 15\.0 m\./.test(await cardOf(ahd)), await cardOf(ahd));
    await page.evaluate(k => ArroData.solo(k), key);
    await page.waitForTimeout(150);
    const asG = await chart();
    ok('the series on the gauge keeps its classes — they need no zero — at 7 and 10 m',
      asG.lines.some(l => l.key === 'minor_m' && near(l.y, axisY(asG, 7), 0.3)) && asG.lines.some(l => l.key === 'moderate_m'), J(asG.lines));
    ok('…and loses its AEP levels, not one element drawn for them, and says why',
      !asG.lines.some(l => /^aep_/.test(l.key)) && !asG.labels.some(l => /^aep_/.test(l.key)) && !asG.offs.some(o => o.keys.some(k => /^aep_/.test(k)))
        && /Not drawn — the AEP levels are metres AHD, and the gauge's zero is on the assumed datum rather than AHD, so they cannot be brought down to heights on the gauge/.test(asG.card), asG.card);
    ok('…nor a key in the legend for them', !asG.legend.some(k => /^aep_/.test(k.key)) && asG.legend.some(k => k.key === 'minor_m'), J(asG.legend));

    section('Value only');
    await page.evaluate(() => ArroData.setTransform('increment'));
    await page.waitForTimeout(150);
    const inc = await chart();
    ok('on Increment there are no flood lines, and the card says why', !inc.lines.length && !inc.offs.length
      && /Drawn on Value only/.test(inc.card), inc.card);
    await page.evaluate(() => ArroData.setTransform('value'));
    await page.waitForTimeout(100);

    ok('every handler on the tab resolves', (await auditHandlers(page)).unresolved.length === 0,
      J((await auditHandlers(page)).unresolved));

    section('Field Data: a level drawn in counts');
    const field = await page.evaluate(async () => {
      const rows = [];
      for (let i = 0; i < 24; i++) {
        const m = 6 + Math.sin(i / 4);
        rows.push({ addr: 'a:2722', station_id: 'bohle_river_al', reading_ts: new Date(Date.now() - (24 - i) * 900000).toISOString(),
          received_at: new Date(Date.now() - (24 - i) * 900000).toISOString(),
          value_raw: Math.round(m * 1000), value: m, unit: 'm', quality: 0, path: 'test', dup_count: 0, dup_paths: [] });
      }
      window.dbSelect = async q => (/^quality\?/.test(q) ? [{ code: 0, key: 'good' }] : /reading/.test(q) ? rows : []);
      switchTab('field');
      await new Promise(r => setTimeout(r, 60));
      ArroData.fieldShow('a:2722', Date.now());
      for (let i = 0; i < 60 && !ArroData.ad.series.length; i++) await new Promise(r => setTimeout(r, 100));
      const s = ArroData.ad.series[0];
      if (!s) return null;
      ArroData.setFlood(s.key, 'classes', true);
      await new Promise(r => setTimeout(r, 100));
      return { unit: s.unit, eng: s.engUnit, lines: document.querySelectorAll('#ad-svg .ad-flood-line, #ad-svg .ad-flood-off').length,
               card: (document.querySelector('.ad-series')?.innerText || '').replace(/\s+/g, ' ') };
    });
    ok('a level in counts, its conversion to metres display-only, is offered the box',
      field && field.unit === 'count' && field.eng === 'm' && /Flood classes/.test(field.card), J(field));
    ok('…and draws nothing, saying it has nothing in metres to draw against', field && field.lines === 0
      && /Drawn in counts — the datastore’s conversion to m is shown beside each reading, not plotted/.test(field.card), field && field.card);

    ok('no page errors', errors.length === 0, errors.join('\n'));
  } finally {
    await browser.close();
    await server.close();
  }
}

// ═════════════════════════════════════════════════════════════════════════════

const FS = loadModule();
nodeHalf(FS);
await browserHalf();

console.log('');
if (failures) {
  console.log(`FAIL — ${failures} of ${failures + passes} assertion(s).`);
  process.exit(1);
}
console.log(`PASS — ${passes} assertion(s): every flood line in its series' datum, none where the datum cannot be crossed, and the PNG carrying them.`);
