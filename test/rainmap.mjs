// The rainfall heat map on the Stations map (map-rain.js): the rain the
// network's own gauges measured, out of the datastore, painted between them.
//
// In two halves.
//
// **Under Node**, the arithmetic, where a wrong answer is still a pretty
// picture: the twelve steps and where each starts (under 0.2 mm is dry); the
// Bureau's rain day on Brisbane's clock (9 am is 23:00 UTC, the day before);
// the windows' spans; a gauge's tips in a window, all of them and the most in
// any hour; a counter that wraps past 2,047 and a corrupted frame, counted as
// Station Health counts them; the weighting — a lone gauge is its own value
// out to its reach and nothing past it, two gauges meet between them, closer
// counts for more, and the colour fades over the last 40% of the reach; the
// time-lapse's 24 frames on the clock's hours, the last one the hour so far;
// and the load reaching back a day before the window and 48 hours at least.
//
// **In Chromium**, the real app and the real register, with the datastore
// stood in for at dbSelect: the gauges within 200 km of Loudoun Br AL report
// every six hours, dry, and the rest are silent; Loudoun's own gauge has a
// storm three hours ago (60 tips in an hour, 12 mm at its bucket), a gauge
// 60 km off had 5 tips 30 hours ago, and one 100 km off wraps its counter
// past 2,047 in the last six. What matters: off until switched on, and nothing
// read until then; every request a reading request naming at most 150
// addresses and reaching back 48 hours; a silent gauge left out, not dry;
// Loudoun's 10 mm, the wrapped gauge's tips, the 60 km gauge's rain only in
// the 3-day window; the surface painted in Loudoun's colour over Loudoun and
// clear far from anything wet; the peak the most in an hour; the opacity on
// the image and remembered; a shorter reach paints less; figures from zoom 9,
// the heaviest first, and one pressed opens its station; the five heaviest
// named; the legend's key while on and the layer in "also available" while
// off; the last 24 hours played and stepped to the storm's hour; a datastore
// that will not answer said so, with Try again; and no sideways scroll at
// 375 px.
//
// Run:  npm run rainmap
//       npm run rainmap -- -v    also print what passed

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const HOUR = 3600000, DAY = 86400000, MINUTE = 60000;

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}
const J = v => JSON.stringify(v);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ════════════════════════════════════════════════════════════════════════════
// Under Node: the arithmetic
// ════════════════════════════════════════════════════════════════════════════

function loadModule() {
  const store = new Map();
  const ctx = {
    console,
    state: { data: null, mapRain: false },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    bucketSizeMm: s => (s && s.TBRGbucketSize > 0 ? { mm: s.TBRGbucketSize, recorded: true } : { mm: 0.2, recorded: false }),
  };
  vm.createContext(ctx);
  const src = ['health-analysis.js', 'map-rain.js'].map(f => fs.readFileSync(path.join(REPO, f), 'utf8')).join('\n;\n');
  vm.runInContext(`${src}\n;this.MapRain = MapRain; this.HealthAnalysis = HealthAnalysis;`, ctx);
  return ctx;
}

function nodeHalf() {
  console.log('\nUnder Node — the arithmetic\n');
  const { MapRain } = loadModule();
  const P = MapRain._pure;

  // The steps.
  check('twelve colours, and twelve steps on each scale',
    P.PALETTE.length === 12 && P.SCALES.total.steps.length === 12 && P.SCALES.rate.steps.length === 12);
  check('under 0.2 mm is dry, and 0.2 is the first step (with a tip’s floating-point shortfall forgiven)',
    P.binOf(0.19, 'total') === -1 && P.binOf(0.2, 'total') === 0 && P.binOf(0.2 - 1e-12, 'total') === 0
      && P.colourOf(0.1, 'total') === null && P.colourOf(0.2, 'total') === P.PALETTE[0]);
  check('each step starts where the key says it does',
    P.SCALES.total.steps.every((s, i) => P.binOf(s, 'total') === i && (i === 0 || P.binOf(s - 0.01, 'total') === i - 1)),
    J(P.SCALES.total.steps.map(s => P.binOf(s, 'total'))));
  check('10 mm is the fifth step on the totals, 300 mm and over the last',
    P.binOf(10, 'total') === 4 && P.binOf(14.9, 'total') === 4 && P.binOf(300, 'total') === 11 && P.binOf(5000, 'total') === 11);
  check('the rate scale: 10 mm/h is the sixth step, 100 mm/h and over the last',
    P.binOf(10, 'rate') === 5 && P.binOf(100, 'rate') === 11 && P.binOf(0.5, 'rate') === 1);

  // The rain day.
  const at = s => Date.parse(s);
  check('the last 9 am in Brisbane is 23:00 UTC the day before',
    P.last9am(at('2026-10-27T05:25:00Z')) === at('2026-10-26T23:00:00Z'),
    new Date(P.last9am(at('2026-10-27T05:25:00Z'))).toISOString());
  check('…and at 8:59 am in Brisbane it is still yesterday’s 9 am',
    P.last9am(at('2026-10-26T22:59:00Z')) === at('2026-10-25T23:00:00Z'));
  check('…and at 9 am exactly it is that 9 am',
    P.last9am(at('2026-10-26T23:00:00Z')) === at('2026-10-26T23:00:00Z'));
  const now = at('2026-10-27T05:25:00Z');
  const s9 = P.windowSpan('since9', now), t9 = P.windowSpan('to9', now), d1 = P.windowSpan('24h', now);
  check('“since 9 am” runs from this morning’s 9 am to now',
    s9.t0 === at('2026-10-26T23:00:00Z') && s9.t1 === now);
  check('“24 hours to 9 am” is the whole rain day that ended this morning',
    t9.t0 === at('2026-10-25T23:00:00Z') && t9.t1 === at('2026-10-26T23:00:00Z'));
  check('“last 24 hours” is the 24 hours to now, and an unknown window is that too',
    d1.t0 === now - DAY && d1.t1 === now && J(P.windowSpan('nonsense', now)) === J(d1));
  check('the windows’ words say which rain day',
    P.windowWords('since9', now) === 'since 9 am today' && P.windowWords('to9', now) === 'in the 24 hours to 9 am today'
      && P.windowWords('1h', now) === 'in the last hour' && P.windowWords('72h', now) === 'in the last 3 days',
    [P.windowWords('since9', now), P.windowWords('to9', now), P.windowWords('72h', now)].join(' | '));

  // A gauge's tips.
  const s = { t: [now - 5 * HOUR, now - 3 * HOUR, now - 2.9 * HOUR, now - 2.5 * HOUR, now - 1.9 * HOUR, now - 10 * MINUTE],
              tips: [7, 3, 4, 5, 6, 1] };
  check('the tips in a window are the steps after it opens and up to its end',
    P.tipsIn(s, now - 6 * HOUR, now, 'total') === 26 && P.tipsIn(s, now - 3 * HOUR, now, 'total') === 16
      && P.tipsIn(s, now - DAY, now - 4 * HOUR, 'total') === 7 && P.tipsIn(s, now, now + HOUR, 'total') === 0);
  check('the peak is the most tips in any 60 minutes inside the window',
    P.tipsIn(s, now - 6 * HOUR, now, 'peak') === 12 && P.tipsIn(s, now - 2.95 * HOUR, now, 'peak') === 11
      && P.tipsIn({ t: [now - 2 * HOUR, now - HOUR], tips: [4, 5] }, now - DAY, now, 'peak') === 5,
    `${P.tipsIn(s, now - 6 * HOUR, now, 'peak')} ${P.tipsIn(s, now - 2.95 * HOUR, now, 'peak')}`);

  // Counted as Station Health counts them: a wrap is rain, a corrupted frame is not.
  const pts = [2040, 2044, 2047, 1, 5, 1824, 6, 7].map((v, i) => ({ t: now - (8 - i) * HOUR, v }));
  const ser = P.seriesOf(pts, { st: {} });
  const tips = ser.tips.reduce((a, b) => a + b, 0);
  check('a counter that wraps past 2,047 counts the tips across the wrap, and a corrupted 1,824 is not rain',
    tips === 15 && ser.heard === now - HOUR && ser.left >= 1, `tips ${tips}, left ${ser.left}, ${J(ser.tips)}`);

  // The weighting.
  const ix1 = P.buildIndex([{ lat: -27, lon: 151, v: 10 }], 30);
  const at0 = P.sampleAt(ix1, -27, 151);
  const at20 = P.sampleAt(ix1, -27 - 20 / 110.574, 151);
  const at35 = P.sampleAt(ix1, -27 - 35 / 110.574, 151);
  check('a lone gauge is its own value at its station and out to its reach',
    at0 && near(at0.v, 10) && at0.n === 1 && at20 && near(at20.v, 10) && near(at20.near, 20, 0.01),
    J({ at0, at20 }));
  check('…and nothing past its reach', at35 === null, J(at35));
  const ix2 = P.buildIndex([{ lat: -27, lon: 151, v: 10 }, { lat: -27, lon: 151.2, v: 0 }], 30);
  const mid = P.sampleAt(ix2, -27, 151.1), nearWet = P.sampleAt(ix2, -27, 151.03), nearDry = P.sampleAt(ix2, -27, 151.17);
  check('two gauges meet half way between them, and the closer one counts for more',
    near(mid.v, 5, 1e-6) && nearWet.v > 5 && nearDry.v < 5 && mid.n === 2, J({ mid: mid.v, nearWet: nearWet.v, nearDry: nearDry.v }));
  const dry = P.buildIndex([{ lat: -27, lon: 151, v: 0 }, { lat: -27.1, lon: 151, v: 0.1 }], 30);
  // Tasmania and Cape York on one map: a gauge 29 km due east of a cell in
  // Hobart is in its reach, however far north the rest of the network runs.
  const wide = P.buildIndex([{ lat: -42.88, lon: 147.33 + 29 / (111.32 * Math.cos(42.88 * Math.PI / 180)), v: 10 },
                             { lat: -10.6, lon: 142.2, v: 0 }], 30);
  const hobart = P.sampleAt(wide, -42.88, 147.33);
  check('a gauge just inside the reach is found wherever it is on the map, Hobart as well as Cape York',
    hobart && near(hobart.v, 10) && near(hobart.near, 29, 0.05), J(hobart));
  check('where every gauge in reach is dry the painter does not weigh at all',
    P.sampleAt(dry, -27.05, 151, true) === null && P.sampleAt(dry, -27.05, 151, false) !== null);
  check('the colour is whole to 60% of the reach and fades to nothing at it',
    P.fadeAt(10, 30) === 1 && P.fadeAt(18, 30) === 1 && near(P.fadeAt(24, 30), 0.5) && P.fadeAt(30, 30) === 0 && P.fadeAt(40, 30) === 0);

  // The time-lapse.
  const fr = P.lapseFrames(now);
  check('24 frames, an hour each on the clock’s hours, the last one the hour so far',
    fr.length === 24 && fr.every((f, i) => f.t0 % HOUR === 0 && (i === 23 || f.t1 - f.t0 === HOUR))
      && fr[23].t1 === now && fr[23].t0 === Math.floor(now / HOUR) * HOUR && fr[0].t0 === fr[23].t0 - 23 * HOUR,
    J(fr.slice(-2)));

  // How far back a load reaches.
  check('a load reaches back a day before the window, and 48 hours at the least, on the hour',
    P.needFrom(now) === Math.floor((now - 2 * DAY) / HOUR) * HOUR && P.needFrom(now) % HOUR === 0);
  check('the figures are said to a tenth of a millimetre, whole from 100',
    P.fmtMm(0.2) === '0.2' && P.fmtMm(10) === '10.0' && P.fmtMm(12.34) === '12.3' && P.fmtMm(123.4) === '123');
}

// ════════════════════════════════════════════════════════════════════════════
// In Chromium: the layer on the real app
// ════════════════════════════════════════════════════════════════════════════

async function browserHalf() {
  console.log('\nIn Chromium — the layer on the Stations map\n');
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations)
      && typeof MapRain !== 'undefined' && typeof GroupPlots !== 'undefined', null, { timeout: LOAD_TIMEOUT });

    // ── the datastore, stood in for ────────────────────────────────────────
    const plan = await page.evaluate(() => {
      const HOUR = 3600000, DAY = 86400000, MINUTE = 60000;
      const now = Date.now();
      const km = (a, b) => {
        const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2
          + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
        return 2 * 6371 * Math.asin(Math.sqrt(x));
      };
      const gauges = [];
      const seen = new Set();
      for (const st of state.data.stations) {
        if (st.lat == null || st.lon == null) continue;
        for (const g of GroupPlots.gaugesOf(st, 'rain')) {
          if (!g.addr || seen.has(g.addr)) continue;
          seen.add(g.addr);
          gauges.push({ addr: g.addr, id: st.id, name: st.name, lat: +st.lat, lon: +st.lon, mm: bucketSizeMm(st).mm });
        }
      }
      const A = gauges.find(g => g.id === 'loudoun_br_al');
      const heard = gauges.filter(g => km(A, g) <= 200);
      const B = heard.filter(g => km(A, g) > 60).sort((x, y) => km(A, x) - km(A, y))[0];
      const C = heard.filter(g => km(A, g) > 100).sort((x, y) => km(A, x) - km(A, y))[0];
      const silent = gauges.find(g => km(A, g) > 400);
      const heardSet = new Set(heard.map(g => g.addr));
      const series = new Map();
      const dry = (addr, base) => {
        const out = [];
        for (let t = Math.ceil((now - 9 * DAY) / (6 * HOUR)) * 6 * HOUR + 17 * MINUTE; t < now; t += 6 * HOUR) out.push({ t, v: base });
        series.set(addr, out);
        return out;
      };
      for (const g of heard) dry(g.addr, 300);
      // Loudoun: a storm three hours ago, 2 tips a reading for 30 readings, two
      // minutes apart — 60 tips inside the hour, off a step's edge on the key.
      const storm0 = now - 3 * HOUR;
      const a = series.get(A.addr).filter(p => p.t < storm0);
      for (let i = 1; i <= 30; i++) a.push({ t: storm0 + i * 2 * MINUTE, v: 300 + 2 * i });
      a.push({ t: now - 20 * MINUTE, v: 360 });
      series.set(A.addr, a);
      // B: five tips 30 hours ago.
      const b = series.get(B.addr).map(p => ({ ...p, v: p.t > now - 30 * HOUR ? 305 : 300 }));
      b.push({ t: now - 30 * HOUR, v: 305 });
      series.set(B.addr, b);
      // C: the counter wraps in the last six hours.
      const c = series.get(C.addr).map(p => ({ ...p, v: 2040 })).filter(p => p.t < now - 6 * HOUR);
      [[5.5, 2043], [4.5, 2047], [3.5, 2], [2.5, 6]].forEach(([h, v]) => c.push({ t: now - h * HOUR, v }));
      series.set(C.addr, c);
      series.forEach(pts => pts.sort((x, y) => x.t - y.t));

      const log = window.__rain = { queries: [], fail: false };
      const wanted = q => {
        const m = q.match(/addr=in\.\(([^)]*)\)/);
        return m ? decodeURIComponent(m[1]).split(',').map(x => x.replace(/"/g, '')) : [];
      };
      window.dbSelect = async q => {
        log.queries.push(q);
        if (log.fail) { const e = new Error('HTTP 503'); e.status = 503; throw e; }
        if (!/^reading\?/.test(q)) return [];
        const from = Date.parse(decodeURIComponent((q.match(/reading_ts=gte\.([^&]+)/) || [])[1] || ''));
        const lim = +(q.match(/limit=(\d+)/) || [])[1] || 1000, off = +(q.match(/offset=(\d+)/) || [])[1] || 0;
        const rows = wanted(q).sort().flatMap(addr => (series.get(addr) || []).filter(p => p.t >= from)
          .map(p => ({ addr, reading_ts: new Date(p.t).toISOString(), value_raw: p.v, unit: null })));
        return rows.slice(off, off + lim);
      };
      return { A, B, C, silent: silent.addr, heard: heard.length, gauges: gauges.length, now,
               expect: { A: Math.round(60 * A.mm * 100) / 100, B: Math.round(5 * B.mm * 100) / 100, C: Math.round(14 * C.mm * 100) / 100 } };
    });
    if (VERBOSE) console.log(`  (A ${plan.A.name}, B ${plan.B.name}, C ${plan.C.name}; ${plan.heard} of ${plan.gauges} gauges heard)`);

    // ── off until switched on ──────────────────────────────────────────────
    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(400);
    const mine = q => /^reading\?/.test(q) && /select=addr,reading_ts,value_raw,unit(&|$)/.test(q);
    const off0 = await page.evaluate(() => ({
      on: state.mapRain, q: window.__rain.queries.filter(q => /^reading\?/.test(q)).length,
      img: !!document.querySelector('img.mn-rain-surface'),
      alsoOff: (document.getElementById('map-legend')?.textContent || '').includes('Rainfall heat map'),
    }));
    check('off until switched on, and nothing read from the datastore until then',
      off0.on === false && off0.q === 0 && !off0.img, J(off0));
    check('the legend offers it among the layers that are off', off0.alsoOff);

    await page.click('#help-panel .dock-tab[data-dock="map-display"]');
    await page.waitForSelector('#dock-pane-map-display input[onchange^="MapRain.setEnabled"]', { timeout: 10000 });
    await page.click('#dock-pane-map-display input[onchange^="MapRain.setEnabled"]');
    await page.waitForFunction(() => MapRain._note().kind === 'ok' || MapRain._note().kind === 'fail', null, { timeout: 30000 });

    const all1 = await page.evaluate(() => window.__rain.queries.slice());
    const q1 = all1.filter(mine);
    check('the layer reads meganet.reading and nothing else',
      all1.filter(q => !mine(q) && /^reading/.test(q)).length === 0 && q1.length > 0, J(all1.filter(q => !mine(q)).slice(0, 3)));
    const shapes = q1.map(q => ({
      reading: /order=addr\.asc,reading_ts\.asc/.test(q),
      first: /[?&]offset=0(&|$)/.test(q),
      n: (decodeURIComponent((q.match(/addr=in\.\(([^)]*)\)/) || [])[1] || '').split(',').filter(Boolean)).length,
      sel: /select=addr,reading_ts,value_raw,unit(&|$)/.test(q),
      from: Date.parse(decodeURIComponent((q.match(/reading_ts=gte\.([^&]+)/) || [])[1] || '')),
    }));
    check('every request names at most 150 addresses, for the four columns it uses, oldest first by address',
      shapes.length > 0 && shapes.every(s => s.reading && s.n >= 1 && s.n <= 150 && s.sel), J(shapes.slice(0, 3)));
    check('every register gauge is asked about, once',
      shapes.filter(s => s.first).reduce((a, s) => a + s.n, 0) === plan.gauges,
      `${shapes.filter(s => s.first).reduce((a, s) => a + s.n, 0)} of ${plan.gauges}`);
    check('the load reaches back 48 hours for the 24-hour window and the time-lapse',
      shapes.every(s => s.from <= plan.now - 2 * DAY && s.from > plan.now - 2 * DAY - 2 * HOUR), J(shapes.map(s => s.from)[0]));
    const st1 = await page.evaluate(() => ({ on: state.mapRain, pref: localStorage.getItem('mn-rain'), note: MapRain._note(),
                                            figs: MapRain._figures(), painted: MapRain._painted() }));
    const fig = id => st1.figs.find(f => f.addr === id);
    check('switched on from Map display, and remembered', st1.on === true && st1.pref === 'on' && st1.note.kind === 'ok', J(st1.note));
    check('the gauges heard are on the map and the silent ones are not — not heard is not dry',
      st1.figs.length === plan.heard && !fig(plan.silent), `${st1.figs.length} of ${plan.heard}`);
    check('Loudoun’s storm is its tips at its bucket, the heaviest of the 24 hours',
      fig(plan.A.addr)?.mm === plan.expect.A && st1.figs[0].addr === plan.A.addr, J(fig(plan.A.addr)));
    check('a counter that wraps past 2,047 in the window counts the tips across the wrap',
      fig(plan.C.addr)?.mm === plan.expect.C, `${J(fig(plan.C.addr))}, want ${plan.expect.C}`);
    check('rain 30 hours ago is not in the last 24', fig(plan.B.addr)?.mm === 0, J(fig(plan.B.addr)));
    check('a dry gauge heard is on the map at nothing', st1.figs.filter(f => f.mm === 0).length >= plan.heard - 3);

    // ── the surface ────────────────────────────────────────────────────────
    const pixel = async (lat, lon) => page.evaluate(async ([la, lo]) => {
      const img = document.querySelector('img.mn-rain-surface');
      if (!img) return null;
      if (!img.complete) await new Promise(r => img.addEventListener('load', r, { once: true }));
      const rect = img.getBoundingClientRect(), mapRect = state.map.getContainer().getBoundingClientRect();
      const p = state.map.latLngToContainerPoint([la, lo]);
      const fx = (p.x + mapRect.left - rect.left) / rect.width, fy = (p.y + mapRect.top - rect.top) / rect.height;
      if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return { outside: true };
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(Math.floor(fx * c.width), Math.floor(fy * c.height), 1, 1).data;
      return { rgba: [d[0], d[1], d[2], d[3]] };
    }, [lat, lon]);
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    await page.evaluate(([la, lo]) => state.map.setView([la, lo], 9, { animate: false }), [plan.A.lat, plan.A.lon]);
    await page.waitForFunction(() => document.querySelector('img.mn-rain-surface'), null, { timeout: 10000 });
    await page.waitForTimeout(500);
    const pA = await pixel(plan.A.lat, plan.A.lon);
    const want = await page.evaluate(v => MapRain._pure.PALETTE[MapRain._pure.binOf(v, 'total')], plan.expect.A);
    check('over Loudoun the surface is painted in the colour of its fall, whole',
      pA && pA.rgba && pA.rgba[3] === 255 && J(pA.rgba.slice(0, 3)) === J(hex(want)), `${J(pA)} want ${want}`);
    const far = await pixel(plan.A.lat + 1.5, plan.A.lon);
    check('far from any wet gauge it is clear', far && (far.outside || far.rgba[3] === 0), J(far));
    const pImg = await page.evaluate(() => {
      const img = document.querySelector('img.mn-rain-surface');
      return { pane: img.parentElement.classList.contains('leaflet-mnRain-pane'),
               z: getComputedStyle(img.parentElement).zIndex, pe: getComputedStyle(img.parentElement).pointerEvents };
    });
    check('in its own pane at 249, under the place names, taking no pointer',
      pImg.pane && pImg.z === '249' && pImg.pe === 'none', J(pImg));

    // ── opacity and reach ──────────────────────────────────────────────────
    await page.evaluate(() => {
      const el = document.querySelector('#dock-pane-map-display input[aria-label="Rain heat map opacity"]');
      el.value = '0.4';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const op = await page.evaluate(() => ({ o: MapRain._painted().opacity, css: getComputedStyle(document.querySelector('img.mn-rain-surface')).opacity,
                                           pref: localStorage.getItem('mn-rain-op'),
                                           label: document.getElementById('rain-opacity-val')?.textContent }));
    check('the opacity slider sets the surface’s opacity, says it, and is remembered',
      near(op.o, 0.4) && near(+op.css, 0.4, 0.01) && op.pref === '0.4' && op.label === '40%', J(op));
    const cells = async km => {
      await page.evaluate(v => MapRain.setReach(v), km);
      await page.waitForTimeout(400);
      return page.evaluate(() => MapRain._painted().cells);
    };
    const wide = await cells(80), narrow = await cells(10);
    check('a shorter reach paints less of the map, and the reach is remembered',
      wide > narrow && narrow > 0 && (await page.evaluate(() => localStorage.getItem('mn-rain-reach'))) === '10', `${wide} vs ${narrow}`);
    await cells(30);

    // ── the figures ────────────────────────────────────────────────────────
    const figs9 = await page.evaluate(() => [...document.querySelectorAll('.mn-rain-fig')].map(e => e.textContent));
    check('from zoom 9 each wet gauge’s figure is beside its station, and no dry one',
      figs9.includes((Math.round(plan.expect.A * 10) / 10).toFixed(1)) && !figs9.includes('0.0'), J(figs9));
    await page.evaluate(() => state.map.setZoom(8, { animate: false }));
    await page.waitForTimeout(500);
    check('…and none further out than zoom 9', (await page.evaluate(() => document.querySelectorAll('.mn-rain-fig').length)) === 0);
    await page.evaluate(([la, lo]) => state.map.setView([la, lo], 11, { animate: false }), [plan.A.lat, plan.A.lon]);
    await page.waitForTimeout(500);
    const figs11 = await page.evaluate(() => [...document.querySelectorAll('.mn-rain-fig')].map(e => e.textContent));
    check('from zoom 11 the dry ones too', figs11.includes('0.0') || figs11.length === 1, J(figs11));
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('.mn-rain-fig')].sort((a, b) => parseFloat(b.textContent) - parseFloat(a.textContent))[0];
      el.closest('.leaflet-marker-icon').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    check('pressing a figure opens its station', (await page.evaluate(() => state.selectedId)) === plan.A.id,
      await page.evaluate(() => state.selectedId));
    // Opening a station draws the tab again; the Layers pane is opened again
    // if that left it shut.
    if (await page.evaluate(() => document.getElementById('dock-pane-map-display')?.hidden !== false)) {
      await page.click('#help-panel .dock-tab[data-dock="map-display"]');
      await page.waitForTimeout(300);
    }
    const noteTop = await page.evaluate(() => {
      const el = document.querySelector('#map-rain-note .mn-rain-top');
      return el ? [...el.querySelectorAll('button')].map(b => b.textContent) : null;
    });
    check('the note names the heaviest falls, Loudoun first, each a press from its station',
      noteTop && noteTop[0] === plan.A.name && noteTop.length <= 5, J(noteTop));
    const legend = await page.evaluate(() => {
      const el = document.querySelector('#map-legend .legend-rain');
      return el ? { text: el.textContent.replace(/\s+/g, ' '), steps: el.querySelectorAll('.mn-rain-ramp li').length } : null;
    });
    check('the legend carries the key while it is on', legend && legend.steps === 12 && /in the last 24 hours/.test(legend.text)
      && /not radar/.test(legend.text), J(legend));

    // ── windows and measures ───────────────────────────────────────────────
    const before = await page.evaluate(() => window.__rain.queries.filter(q => /^reading\?/.test(q)).length);
    await page.selectOption('#dock-pane-map-display select[aria-label="Rain window"]', '72h');
    await page.waitForFunction(n => window.__rain.queries.filter(q => /^reading\?/.test(q)).length > n
      && MapRain._note().kind === 'ok', before, { timeout: 30000 });
    await page.waitForTimeout(300);
    const w72 = await page.evaluate(() => ({ figs: MapRain._figures(), q: window.__rain.queries.filter(q => /^reading\?/.test(q)).slice(-1)[0],
                                             pref: localStorage.getItem('mn-rain-win') }));
    const from72 = Date.parse(decodeURIComponent((w72.q.match(/reading_ts=gte\.([^&]+)/) || [])[1] || ''));
    check('a longer window reads again, from a day before it opens',
      from72 <= plan.now - 4 * DAY && from72 > plan.now - 4 * DAY - 2 * HOUR && w72.pref === '72h', new Date(from72).toISOString());
    check('…and the rain 30 hours ago is in the 3 days', w72.figs.find(f => f.addr === plan.B.addr)?.mm === plan.expect.B,
      J(w72.figs.find(f => f.addr === plan.B.addr)));
    const n72 = await page.evaluate(() => window.__rain.queries.filter(q => /^reading\?/.test(q)).length);
    await page.selectOption('#dock-pane-map-display select[aria-label="Rain window"]', '24h');
    await page.waitForTimeout(400);
    check('a shorter window inside what was read reads nothing again',
      (await page.evaluate(() => window.__rain.queries.filter(q => /^reading\?/.test(q)).length)) === n72);
    await page.selectOption('#dock-pane-map-display select[aria-label="Rain measure"]', 'peak');
    await page.waitForTimeout(300);
    const pk = await page.evaluate(() => ({ figs: MapRain._figures(), ramp: [...document.querySelectorAll('#map-legend .legend-rain .mn-rain-ramp span')].map(s => s.textContent) }));
    check('the peak is the most that fell in any hour, on the mm-an-hour key',
      pk.figs.find(f => f.addr === plan.A.addr)?.mm === plan.expect.A && pk.ramp[pk.ramp.length - 1] === '100+',
      J({ a: pk.figs.find(f => f.addr === plan.A.addr), last: pk.ramp.slice(-1) }));
    await page.selectOption('#dock-pane-map-display select[aria-label="Rain measure"]', 'total');

    // ── the time-lapse ─────────────────────────────────────────────────────
    await page.click('#dock-pane-map-display .mn-rain-lapse button');
    await page.waitForTimeout(200);
    const lp = await page.evaluate(() => ({ lapse: MapRain._lapse(),
                                            win: document.querySelector('#dock-pane-map-display select[aria-label="Rain window"]')?.disabled,
                                            range: !!document.getElementById('rain-lapse-range') }));
    check('▶ plays the last 24 hours, with a slider for the hour and the window set aside',
      lp.lapse && lp.lapse.playing && lp.win === true && lp.range, J(lp));
    const stormFrame = await page.evaluate(now => {
      const fr = MapRain._pure.lapseFrames(Date.now());
      const t = Date.now() - 3 * 3600000 + 25 * 60000;
      return fr.findIndex(f => t > f.t0 && t <= f.t1);
    }, plan.now);
    await page.evaluate(i => {
      const el = document.getElementById('rain-lapse-range');
      el.value = String(i);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, stormFrame);
    await page.waitForTimeout(200);
    const fr = await page.evaluate(() => ({ lapse: MapRain._lapse(), figs: MapRain._figures(),
                                            when: document.getElementById('rain-lapse-when')?.textContent }));
    const aFrame = fr.figs.find(f => f.addr === plan.A.addr)?.mm;
    check('stepping to the storm’s hour stops the play and shows the rain in that hour',
      fr.lapse && !fr.lapse.playing && fr.lapse.i === stormFrame && aFrame > 0 && aFrame <= plan.expect.A && !!fr.when,
      J({ fr: fr.lapse, aFrame, when: fr.when }));
    await page.click('#dock-pane-map-display .mn-rain-lapse button:has-text("Back to the window")');
    await page.waitForTimeout(200);
    check('“Back to the window” puts the window back',
      (await page.evaluate(() => MapRain._lapse())) === null
        && (await page.evaluate(a => MapRain._figures().find(f => f.addr === a)?.mm, plan.A.addr)) === plan.expect.A);

    // ── a phone ────────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(500);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check('no sideways scroll at 375 px', sw <= 375, String(sw));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(300);

    // ── a datastore that will not answer ───────────────────────────────────
    await page.evaluate(() => { window.__rain.fail = true; MapRain.refresh(); });
    await page.waitForFunction(() => MapRain._note().kind === 'fail', null, { timeout: 10000 });
    const fl = await page.evaluate(() => ({ note: document.getElementById('map-rain-note')?.textContent || '',
                                            img: !!document.querySelector('img.mn-rain-surface') }));
    check('a read again that fails keeps the last good readings on the map and says how old they are',
      /could not be read again/.test(fl.note) && /as at/.test(fl.note) && /Try again/.test(fl.note) && fl.img, J(fl));
    await page.selectOption('#dock-pane-map-display select[aria-label="Rain window"]', '7d');
    await page.waitForFunction(() => MapRain._note().kind === 'fail', null, { timeout: 10000 });
    await page.waitForTimeout(300);
    const fl7 = await page.evaluate(() => ({ note: document.getElementById('map-rain-note')?.textContent || '',
      img: !!document.querySelector('img.mn-rain-surface'), legend: !!document.querySelector('#map-legend .legend-rain') }));
    check('…but a window those readings do not reach is not painted from them, and has no key',
      /could not be read —/.test(fl7.note) && !/as at/.test(fl7.note) && !fl7.img && !fl7.legend, J(fl7));
    await page.evaluate(() => { window.__rain.fail = false; });
    await page.click('#map-rain-note button');
    await page.waitForFunction(() => MapRain._note().kind === 'ok', null, { timeout: 10000 });
    check('…and Try again reads it', (await page.evaluate(() => !!document.querySelector('img.mn-rain-surface'))));
    await page.selectOption('#dock-pane-map-display select[aria-label="Rain window"]', '24h');

    // ── off ────────────────────────────────────────────────────────────────
    await page.click('#dock-pane-map-display input[onchange^="MapRain.setEnabled"]');
    await page.waitForTimeout(300);
    const off1 = await page.evaluate(() => ({ on: state.mapRain, pref: localStorage.getItem('mn-rain'),
      img: !!document.querySelector('img.mn-rain-surface'), figs: document.querySelectorAll('.mn-rain-fig').length,
      legend: !!document.querySelector('#map-legend .legend-rain') }));
    check('switched off: nothing on the map, no key, and remembered', !off1.on && off1.pref === 'off' && !off1.img && !off1.figs && !off1.legend, J(off1));

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }
}

nodeHalf();
await browserHalf();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
if (failed.length) { console.log(`FAIL — ${failed.length} check(s) failed`); process.exit(1); }
console.log('PASS — the rainfall heat map: its arithmetic, its layer and its controls.');
