// The Data Quality codes an export arrives with, and the control that acts on
// them (revision 92).
//
// This exists because of a defect that was invisible to every check in `test/`
// and plainly visible to anyone looking at a chart: **a reading the exporting
// system had already flagged was filtered exactly as though it had not been.**
// `parseCsv()` has read the Data Quality column since the first import — it is
// in the readings table, in the callout, in both export CSVs and editable by
// hand — and `runFilter()` read `s.t` and `s.v` and nothing else. Six letters of
// the telemetry's own verdict, carried the whole way through the app, deciding
// nothing.
//
// Nothing throws. The tab renders, the axis is drawn, every handler resolves,
// the console is clean. `smoke` cannot see it, `tabs` cannot see it, and the
// chart is simply wrong about which readings survived — the class of failure
// this repository has decided grows a check of its own (roadmap constraint 1).
//
// What is checked, in the order it matters:
//
//   the gate is off until it is asked for   — the switch off, or no code ticked,
//                                             has to produce the byte-identical
//                                             verdict the tab gave before this.
//                                             A filter that changed an existing
//                                             import's chart on upgrade would be
//                                             a silent rewrite of somebody's
//                                             record
//   it removes what it says and nothing else — every excluded reading carries
//                                             the ticked code, every kept one
//                                             does not
//   it runs BEFORE the 357 walk             — the point of the whole change: a
//                                             flagged reading must get no vote
//                                             on whether its neighbours are
//                                             continuous, which is only
//                                             observable as a *neighbour's*
//                                             verdict changing
//   the codes are per-series                — qcodes is first-seen order, so two
//                                             imports that met their codes in a
//                                             different order have different
//                                             indices for the same letters. One
//                                             panel governs both
//   the cache key moves with the ticks      — `runFilter` caches on cfgKey, so a
//                                             tick that did not reach the key
//                                             would leave the chart showing the
//                                             previous answer
//   the control is on screen and operable   — every code in the file listed with
//                                             its count, ticks that reach the
//                                             filter, and the counts legible
//                                             while the switch is still off,
//                                             which is when they are read
//
//   node --run adqual      (or: npm run adqual)

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const LOAD_TIMEOUT = 60000;

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

// A fixture in the shape of the export that prompted the issue: a water level in
// metres, re-sent several times per observation, with a handful of readings the
// exporting system flagged and the rest graded good.
//
// The values are deliberately *plausible* — 0.60 to 0.75 m — apart from four
// flagged ones at 40.90 m. That is the whole point: 3/5/7 are counts-domain
// steps, so on a level in metres a flagged reading is comfortably "continuous"
// with its neighbours and the 357 test has no argument against it. If the
// fixture's bad readings were bad *enough* to fail the continuity test on their
// own, this check would pass against an app that ignored the codes entirely —
// the same shape as #118's finding that a uniform fixture cannot see a rule
// about the non-uniform case.
function fixture() {
  const rows = [['Reading', 'Receive', 'Value', 'Unit', 'Data Quality', 'Raw Value']];
  const at = i => {
    const d = new Date(Date.UTC(2026, 3, 1, 0, 0, 0) + i * 1000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  };
  let i = 0;
  const push = (v, q) => { const t = at(i++); rows.push([t, t, v.toFixed(2), 'm', q, Math.round(v * 20)]); };
  // Twenty good observations, three re-sends each, on a slowly rising level.
  for (let k = 0; k < 20; k++) {
    const v = 0.60 + k * 0.005;
    push(v, 'A'); push(v, 'A'); push(v, 'DD');
    i += 3600;                                   // an hour to the next observation
  }
  // Four flagged re-sends of one corrupt packet, mid-record, at a value no
  // 3 m step objects to being next to — and which four identical re-sends make
  // perfectly continuous with each other.
  for (let k = 0; k < 4; k++) push(40.90, 'MX');
  i += 3600;
  // …then the record carries on, good.
  for (let k = 0; k < 20; k++) {
    const v = 0.70 + k * 0.005;
    push(v, 'A'); push(v, 'DD'); push(v, 'DD');
    i += 3600;
  }
  return rows.map(r => r.join(',')).join('\n');
}

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  const out = await page.evaluate(async (CSV) => {
    const log = {};
    const A = window.ArroData;

    const parsed = A.parseCsv(CSV);
    log.parseError = parsed.error || null;
    if (parsed.error) return log;

    // The series as the tab holds one. `q` indexes `qcodes`, which is the
    // vocabulary in first-seen order.
    const mk = () => ({ ...parsed, kind: 'WL', filt: null, tracks: null });
    log.qcodes = [...parsed.qcodes];
    log.n = parsed.n;

    const CFG = { ...A.ad.cfg, qualOn: false, qualCut: [] };
    const run = cfg => { const s = mk(); const f = A.runFilter(s, cfg); return { s, f }; };

    // ── 1. off is off ────────────────────────────────────────────────────
    const off      = run(CFG);
    const armedNil = run({ ...CFG, qualOn: true, qualCut: [] });
    const tickedOff= run({ ...CFG, qualOn: false, qualCut: ['MX', 'DD'] });
    const absent   = run({ ...CFG, qualOn: true, qualCut: ['NOT_A_CODE'] });
    const same = (a, b) => {
      for (let i = 0; i < parsed.n; i++) if (a.f.status[i] !== b.f.status[i]) return i;
      return -1;
    };
    log.baseStats    = off.f.stats;
    log.armedNilSame = same(off, armedNil);
    log.tickedOffSame= same(off, tickedOff);
    log.absentSame   = same(off, absent);

    // ── 2. it removes what it says ───────────────────────────────────────
    const cutMx = run({ ...CFG, qualOn: true, qualCut: ['MX'] });
    log.mxStats = cutMx.f.stats;
    let wrongCode = 0, missedCode = 0;
    for (let i = 0; i < parsed.n; i++) {
      const code = parsed.qcodes[parsed.q[i]];
      const excluded = cutMx.f.status[i] === 8;          // AD_QUAL
      if (excluded && code !== 'MX') wrongCode++;
      // An MX reading the repeat filter already dropped is legitimately not
      // ours, so only readings that survived to the value gates are required.
      if (!excluded && code === 'MX' && off.f.status[i] !== 4) missedCode++;
    }
    log.wrongCode = wrongCode;
    log.missedCode = missedCode;

    log.keptByContinuityBefore = (() => {
      let k = 0;
      for (let i = 0; i < parsed.n; i++)
        if (parsed.qcodes[parsed.q[i]] === 'MX' && off.f.status[i] === 1) k++;   // AD_GOOD
      return k;
    })();
    log.qualCount = cutMx.f.stats.qual;
    log.everyMxGone = (() => {
      for (let i = 0; i < parsed.n; i++)
        if (parsed.qcodes[parsed.q[i]] === 'MX' && cutMx.f.status[i] === 1) return false;
      return true;
    })();

    // ── 3. it runs BEFORE the other filters, not over the top of them ────
    // The whole argument for where this gate sits is that a flagged reading
    // must not get a vote on its neighbours. A gate that merely overwrote
    // statuses at the end would remove the same readings and be indistinguishable
    // on them — so the claim can only be checked on a reading that is *not*
    // flagged and whose verdict moves anyway.
    //
    // Two fixtures, because the pipeline has two stages to be ahead of.
    const series = (rows) => {
      const codes = [...new Set(rows.map(r => r.q))];
      return { n: rows.length, kind: 'WL',
        t: Float64Array.from(rows.map((_, k) => Date.UTC(2026, 3, 1) + k * 60000)),
        tr: Float64Array.from(rows.map((_, k) => Date.UTC(2026, 3, 1) + k * 60000)),
        v: Float64Array.from(rows.map(r => r.v)),
        raw: Float64Array.from(rows.map(r => r.v)),
        q: Uint8Array.from(rows.map(r => codes.indexOf(r.q))),
        qcodes: codes, unit: 'm', filt: null, tracks: null };
    };
    const verdictsOf = (rows, cfg) => {
      const s = series(rows);
      const f = A.runFilter(s, cfg);
      return { st: Array.from({ length: s.n }, (_, i) => f.status[i]), stats: f.stats };
    };

    // (a) the 357 walk is handed a shorter list. Three readings that are not
    //     continuous with one another, plus a flagged burst. All seven together
    //     and the walk runs and rejects the three; the burst excluded first and
    //     only three readings reach the walk, which is fewer than continuity can
    //     be tested on at all — so they are kept and *said* to be untested.
    const walkRows = [
      { v: 0.70, q: 'A' }, { v: 12.0, q: 'A' }, { v: 30.0, q: 'A' },
      { v: 40.0, q: 'MX' }, { v: 41.0, q: 'MX' }, { v: 42.0, q: 'MX' }, { v: 43.0, q: 'MX' },
    ];
    const walkOff = verdictsOf(walkRows, CFG);
    const walkOn  = verdictsOf(walkRows, { ...CFG, qualOn: true, qualCut: ['MX'] });
    log.walkBefore = walkOff.st.slice(0, 3);
    log.walkAfter  = walkOn.st.slice(0, 3);

    // (b) the rate limits anchor on the previous *surviving* reading, so the
    //     reading after a spike is judged against the spike — unless the spike
    //     left `live` before the rate test ran. The reading after it is not
    //     flagged and its verdict is the one that moves.
    const rateRows = [];
    for (let k = 0; k < 6; k++) rateRows.push({ v: 0.70 + k * 0.01, q: 'A' });
    rateRows.push({ v: 40.90, q: 'MX' });
    for (let k = 0; k < 6; k++) rateRows.push({ v: 0.76 + k * 0.01, q: 'A' });
    const rateCfg = { ...CFG, rateOn: true, rateMax: 5, fallOn: true, fallMax: 5 };
    const rateOff = verdictsOf(rateRows, rateCfg);
    const rateOn  = verdictsOf(rateRows, { ...rateCfg, qualOn: true, qualCut: ['MX'] });
    log.afterSpikeBefore = rateOff.st[7];     // the good reading following the spike
    log.afterSpikeAfter  = rateOn.st[7];
    log.rateStatsBefore  = rateOff.stats;
    log.rateStatsAfter   = rateOn.stats;

    // ── 4. codes are matched by label, not by index ──────────────────────
    // The same readings with the vocabulary met in the opposite order. `q` is
    // remapped, `qcodes` is reversed, and one ticked label has to reach the same
    // readings in both.
    const flipped = (() => {
      const codes = [...parsed.qcodes].reverse();
      const q = new Uint8Array(parsed.n);
      for (let i = 0; i < parsed.n; i++) q[i] = codes.indexOf(parsed.qcodes[parsed.q[i]]);
      return { ...parsed, q, qcodes: codes, kind: 'WL', filt: null, tracks: null };
    })();
    const fFlip = A.runFilter(flipped, { ...CFG, qualOn: true, qualCut: ['MX'] });
    log.flipSame = (() => {
      for (let i = 0; i < parsed.n; i++) if (fFlip.status[i] !== cutMx.f.status[i]) return i;
      return -1;
    })();
    log.flipIndexDiffers = parsed.qcodes.indexOf('MX') !== flipped.qcodes.indexOf('MX');

    // ── 5. the cache key moves with the ticks ────────────────────────────
    const key = cfg => { const s = mk(); A.runFilter(s, cfg); return s.filt.key; };
    log.keyOffVsOn   = key(CFG) !== key({ ...CFG, qualOn: true, qualCut: ['MX'] });
    log.keyMxVsDd    = key({ ...CFG, qualOn: true, qualCut: ['MX'] })
                    !== key({ ...CFG, qualOn: true, qualCut: ['DD'] });
    log.keyOrderFree = key({ ...CFG, qualOn: true, qualCut: ['MX', 'DD'] })
                    === key({ ...CFG, qualOn: true, qualCut: ['DD', 'MX'] });

    // ── 6. the control, on screen ────────────────────────────────────────
    switchTab('arrodata');
    await new Promise(r => setTimeout(r, 60));
    // parseCsv() already returns series data — the shape adoptSeries() takes.
    // adoptSeries() pushes and does not draw — importFiles() renders for it — so
    // the render is this check's to ask for.
    A.adoptSeries(parsed, {
      label: 'Quality fixture', fileName: 'quality-fixture.csv', kind: 'WL',
    });
    renderMain();
    await new Promise(r => setTimeout(r, 120));
    log.adopted = A.ad.series.length;

    const codeBox = () => [...document.querySelectorAll('.ad-qual-row input[type="checkbox"]')];
    log.rowCount   = codeBox().length;
    log.rowValues  = codeBox().map(b => b.value).sort();
    // The counts are read while the switch is still off — that is when somebody
    // works out which code to tick — so the row text has to be there and the
    // box has to be disabled rather than absent.
    log.disabledWhileOff = codeBox().length > 0 && codeBox().every(b => b.disabled);
    const panelText = () => (document.getElementById('ad-side') || {}).textContent || '';
    log.showsCounts = /\bMX\b/.test(panelText()) && /\b4\b/.test(panelText());

    A.setCfg('qualOn', true);
    await new Promise(r => setTimeout(r, 60));
    log.enabledWhenOn = codeBox().length > 0 && codeBox().every(b => !b.disabled);

    const mx = codeBox().find(b => b.value === 'MX');
    log.foundMxBox = !!mx;
    if (mx) {
      mx.checked = true;
      mx.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
    }
    log.cfgAfterTick = [...(A.ad.cfg.qualCut || [])];
    log.statsAfterTick = A.runFilter(A.ad.series[0], A.ad.cfg).stats;
    log.tickPersists = (codeBox().find(b => b.value === 'MX') || {}).checked === true;

    // …and back off again, which has to restore the original verdict exactly.
    const mx2 = codeBox().find(b => b.value === 'MX');
    if (mx2) {
      mx2.checked = false;
      mx2.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
    }
    log.statsAfterUntick = A.runFilter(A.ad.series[0], A.ad.cfg).stats;

    // The defaults button has to clear the ticks too, and must not hand the
    // instance the array the defaults object holds.
    A.setCfg('qualOn', true);
    const mx3 = codeBox().find(b => b.value === 'MX');
    if (mx3) { mx3.checked = true; mx3.dispatchEvent(new Event('change', { bubbles: true })); }
    await new Promise(r => setTimeout(r, 60));
    log.beforeReset = [...(A.ad.cfg.qualCut || [])];
    A.resetCfg();
    await new Promise(r => setTimeout(r, 60));
    log.afterReset = [...(A.ad.cfg.qualCut || [])];
    log.resetAlsoOff = A.ad.cfg.qualOn === false;

    A.clearAll && A.clearAll();
    return log;
  }, fixture());

  console.log('\n  the fixture parses, codes and all');
  ok('no parse error', !out.parseError, String(out.parseError));
  ok('every code in the file is in the vocabulary',
     ['A', 'DD', 'MX'].every(c => (out.qcodes || []).includes(c)),
     JSON.stringify(out.qcodes));

  console.log('\n  off is off — an existing import charts exactly as it did');
  ok('the switch on with nothing ticked changes no verdict',
     out.armedNilSame === -1, `first difference at reading ${out.armedNilSame}`);
  ok('codes ticked with the switch off changes no verdict',
     out.tickedOffSame === -1, `first difference at reading ${out.tickedOffSame}`);
  ok('a code that is not in the file changes no verdict',
     out.absentSame === -1, `first difference at reading ${out.absentSame}`);

  console.log('\n  it removes what it says, and only that');
  ok('something was actually excluded — the assertions below are not vacuous',
     out.mxStats && out.mxStats.qual > 0, JSON.stringify(out.mxStats));
  ok('no reading without the ticked code was excluded by it',
     out.wrongCode === 0, `${out.wrongCode} reading(s) excluded carrying another code`);
  ok('no reading with the ticked code survived the gate',
     out.missedCode === 0, `${out.missedCode} MX reading(s) still in the series`);
  ok('and none of them is still marked good', out.everyMxGone);

  console.log('\n  it runs before the other filters, which is the point of the change');
  ok('the flagged readings passed the continuity test before it',
     out.keptByContinuityBefore > 0,
     'the fixture\'s flagged readings failed 357 on their own — this check would '
     + 'pass against an app that ignored the codes');
  // 3 = AD_BAD, 1 = AD_GOOD, 8 = AD_QUAL.
  ok('the 357 walk rejected the unflagged readings while the flagged ones were in the list',
     JSON.stringify(out.walkBefore) === '[3,3,3]', JSON.stringify(out.walkBefore));
  ok('…and keeps them once the flagged ones are taken out before it runs',
     JSON.stringify(out.walkAfter) === '[1,1,1]',
     JSON.stringify(out.walkAfter)
     + ' — the walk was handed the same list, so the gate is running after it');
  ok('the rate limit blamed the reading after a flagged spike on the spike',
     out.afterSpikeBefore === 7, `status ${out.afterSpikeBefore}, expected 7 (fell too fast)`);
  ok('…and stops once the spike is excluded before the rate test',
     out.afterSpikeAfter === 1,
     `status ${out.afterSpikeAfter}, expected 1 (good) — the rate gate still saw the spike`);
  ok('and that reading is not itself flagged, so this is a neighbour moving',
     out.rateStatsBefore.fall === 1 && out.rateStatsAfter.fall === 0
       && out.rateStatsAfter.qual === 1,
     `${JSON.stringify(out.rateStatsBefore)} → ${JSON.stringify(out.rateStatsAfter)}`);

  console.log('\n  codes are matched by label, so one panel governs every import');
  ok('the same code sits at a different index in the flipped series',
     out.flipIndexDiffers, 'the fixture did not actually test the remap');
  ok('and the same tick reaches the same readings in both',
     out.flipSame === -1, `first difference at reading ${out.flipSame}`);

  console.log('\n  the cache key moves with the ticks');
  ok('switching the gate on changes the key', out.keyOffVsOn);
  ok('ticking a different code changes the key', out.keyMxVsDd);
  ok('ticking the same two in either order does not', out.keyOrderFree);

  console.log('\n  the control is on screen and reaches the filter');
  ok('the series was adopted', out.adopted === 1, String(out.adopted));
  ok('one row per code in the file', out.rowCount === (out.qcodes || []).length,
     `${out.rowCount} rows for ${JSON.stringify(out.rowValues)}`);
  ok('each row carries its code', JSON.stringify(out.rowValues) === JSON.stringify(['A', 'DD', 'MX']),
     JSON.stringify(out.rowValues));
  ok('the counts are readable before the switch is flicked', out.showsCounts,
     'the panel does not state the codes and their counts');
  ok('the ticks are disabled while the filter is off', out.disabledWhileOff);
  ok('…and enabled once it is on', out.enabledWhenOn);
  ok('ticking a box reaches the config', JSON.stringify(out.cfgAfterTick) === '["MX"]',
     JSON.stringify(out.cfgAfterTick));
  ok('…and the tick survives the re-render it causes', out.tickPersists);
  ok('…and the filter ran on it', out.statsAfterTick && out.statsAfterTick.qual > 0,
     JSON.stringify(out.statsAfterTick));
  ok('unticking puts the readings back',
     out.statsAfterUntick && out.statsAfterUntick.qual === 0
       && out.statsAfterUntick.good === out.baseStats.good,
     `${JSON.stringify(out.statsAfterUntick)} vs ${JSON.stringify(out.baseStats)}`);

  console.log('\n  defaults clears it');
  ok('a code was ticked first', JSON.stringify(out.beforeReset) === '["MX"]',
     JSON.stringify(out.beforeReset));
  ok('defaults empties the list', JSON.stringify(out.afterReset) === '[]',
     JSON.stringify(out.afterReset)
     + ' — if this is ["MX"], resetCfg handed out AD_CFG_DEFAULT\'s own array');
  ok('…and puts the switch back off', out.resetAlsoOff);

  ok('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log('');
if (failures) { console.log(`FAIL — ${failures} assertion(s).`); process.exit(1); }
console.log('PASS — the exporting system\'s verdict is on screen, and it decides something.');
