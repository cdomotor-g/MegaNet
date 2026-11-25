// 📇 Station cards — Station Health's card for every station in a maintenance
// hub (health-cards.js).
//
// Two parts:
//
//   * The rules, in Node: the magnifier's weights (3×, 2×, 1¼× round the
//     focus, summing to the row, the focus centred where its cell was, nothing
//     below 0.3); north-to-south rows that run west to east; the fit at Fit
//     all and whole columns past it; a station's signal as the strongest copy
//     of each transmission; and the bands — a critical power finding act on
//     with the battery drawn red, a warning watch, a silent finding silent, a
//     median weaker than −105 dBm act on with the signal drawn red, dBFS never
//     banded, notes and other kinds of finding never counting.
//   * The cards in Chromium, on the demo week: a card per station of the hub
//     picked, every one placed by custom properties only; the card under the
//     pointer grown to about 3× and still under it, with its chip and why;
//     the magnifier turned off leaving every card the same size; − and + and
//     Ctrl + scroll changing the columns; a click opening the chart, its
//     callout naming the time and the battery under the pointer, Escape
//     closing it and focus back on the card; a clean console.
//
// Run:  npm run healthcards

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VERBOSE = process.argv.includes('-v');
let failed = 0, passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; if (VERBOSE) console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ── 1. the rules, in Node ────────────────────────────────────────────────────

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const ctx = {
  console, Intl, Date, Math, Number, String, Object, Array, Map, Set, JSON, Promise, Error, isFinite,
  esc, escAttr: esc, termHtml: (t, m) => `<span class="term" title="${esc(m)}">${esc(t)}</span>`,
  announce: () => {}, localStorage: { getItem: () => null, setItem: () => {} },
  state: { data: { hubs: [{ id: 'brisbane', name: 'Brisbane Hub' }, { id: 'cairns', name: 'Cairns Hub' }], stations: [] } },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(REPO, 'health-cards.js'), 'utf8') + '\n;this.HealthCards = HealthCards;', ctx);
const HC = ctx.HealthCards;
const NEAR = [3, 2, 1.25];

{
  const w = HC.weights(20, 10, NEAR);
  ok('weights: sum to the line', near(w.reduce((a, b) => a + b, 0), 20, 1e-9));
  ok('weights: 3× at the focus, 2× and 1¼× either side', near(w[9], w[11], 0.2) && w[10] > w[9] && w[9] > w[8] && w[8] > w[7],
    w.map(x => x.toFixed(2)).join(' '));
  const before = w.slice(0, 10).reduce((a, b) => a + b, 0);
  ok('weights: the focus stays centred where its cell was', near(before + w[10] / 2, 10.5, 1e-6), (before + w[10] / 2).toFixed(3));
  ok('weights: the ratio between focus and neighbours is 3 : 2 : 1¼', near(w[10] / w[9], 1.5, 1e-9) && near(w[9] / w[8], 1.6, 1e-9));
  ok('weights: no focus, every cell 1', HC.weights(7, null, NEAR).every(x => x === 1));
  for (const [n, f] of [[20, 0], [20, 1], [20, 3], [15, 14], [4, 1], [1, 0], [3, 2]]) {
    const v = HC.weights(n, f, NEAR);
    let a = 0; for (let i = 0; i < f; i++) a += v[i];
    ok(`weights ${n}/${f}: the focus covers its own cell, nothing below 0.3, sums to n`,
      a <= f + 0.5 + 1e-9 && a + v[f] >= f + 0.5 - 1e-9 && v.every(x => x >= 0.3) && near(v.reduce((p, q) => p + q, 0), n, 1e-9),
      v.map(x => x.toFixed(2)).join(' '));
  }
}
{
  const items = [{ lat: -27, lon: 153 }, { lat: -16, lon: 145 }, { lat: -27, lon: 151 }, { lat: -20, lon: 148 }, { lat: -28, lon: 152 }, { lat: NaN, lon: NaN }];
  const rows = HC.geoRows(items, 2);
  ok('geoRows: north first', rows[0].includes(1) && rows[0].includes(3), JSON.stringify(rows));
  ok('geoRows: each row west to east', rows.every(r => r.every((i, k) => k === 0 || (items[r[k - 1]].lon || 0) <= (items[i].lon || 0))), JSON.stringify(rows));
  ok('geoRows: a station with no place goes last, every station once', rows[rows.length - 1].includes(5) && rows.flat().length === 6 && new Set(rows.flat()).size === 6);
}
{
  const g = HC.fitGrid(280, 1400, 800, 1);
  ok('fitGrid: Fit all fits', g.rows * g.rh <= 800 + 1e-6 && g.cols * g.cw <= 1400 + 1e-6, JSON.stringify(g));
  ok('fitGrid: cards about 1.35 wide to high', g.cw / g.rh > 1.0 && g.cw / g.rh < 1.8, (g.cw / g.rh).toFixed(2));
  const z = HC.fitGrid(280, 1400, 800, 2);
  ok('fitGrid: 2× is half the columns, whole ones, and runs past the height', z.cols <= Math.ceil(g.cols / 2) && Number.isInteger(z.cols) && z.rows * z.rh > 800, JSON.stringify(z));
  ok('fitGrid: one station, one card the width', HC.fitGrid(1, 600, 400, 1).cols === 1);
}
{
  const txs = [
    { t: 5, copies: [{ lvl: -98, lvlUnit: 'dBm' }, { lvl: -91, lvlUnit: 'dBm' }] },
    { t: 1, copies: [{ lvl: -104, lvlUnit: 'dBm' }] },
    { t: 3, copies: [{ lvl: null }] },
    { t: 99, copies: [{ lvl: -50, lvlUnit: 'dBm' }] },
  ];
  const s = HC.signalOf(txs, 0, 10);
  ok('signalOf: the strongest copy of each, in time order, inside the span', JSON.stringify(s.pts) === JSON.stringify([{ t: 1, v: -104 }, { t: 5, v: -91 }]), JSON.stringify(s.pts));
  ok('signalOf: its unit and median', s.unit === 'dBm' && s.med === -91);
  ok('signalOf: nothing heard, nothing', HC.signalOf([], 0, 10).med === null);
}
{
  const F = (kind, category, severity, title) => ({ kind, category, severity, title: title || kind });
  const quiet = { med: -80, unit: 'dBm' };
  let b = HC.bandsOf([], quiet, false);
  ok('bands: no findings, a good signal — nominal', b.band === 'ok' && !b.battRed && !b.sigRed && b.reasons.length === 0);
  b = HC.bandsOf([F('battery-critical', 'power', 'critical', 'Battery at 11.6 V')], quiet, false);
  ok('bands: a critical power finding is act on, battery drawn red, its title the reason', b.band === 'act' && b.battRed && b.reasons[0].k === 'Battery' && b.reasons[0].t === 'Battery at 11.6 V');
  b = HC.bandsOf([F('battery-falling', 'power', 'warn')], quiet, false);
  ok('bands: a power warning is watch, battery not red', b.band === 'watch' && !b.battRed);
  b = HC.bandsOf([F('missed-checks', 'comms', 'warn')], quiet, false);
  ok('bands: a check-signal warning is watch, under Checks', b.band === 'watch' && b.reasons[0].k === 'Checks');
  b = HC.bandsOf([F('silent', 'comms', 'critical')], quiet, false);
  ok('bands: a silent finding is silent', b.band === 'silent');
  b = HC.bandsOf([], null, true);
  ok('bands: expected and not heard is silent, and says so', b.band === 'silent' && /not heard/i.test(b.reasons[0].t));
  b = HC.bandsOf([], { med: -107, unit: 'dBm' }, false);
  ok('bands: a median weaker than −105 dBm is act on, signal drawn red', b.band === 'act' && b.sigRed && b.reasons[0].k === 'Signal');
  b = HC.bandsOf([], { med: -102, unit: 'dBm' }, false);
  ok('bands: weaker than −100 dBm is watch', b.band === 'watch' && !b.sigRed);
  b = HC.bandsOf([], { med: -40, unit: 'dBFS' }, false);
  ok('bands: a level in dBFS is never banded', b.band === 'ok');
  b = HC.bandsOf([F('value-spikes', 'data', 'warn'), F('rain-blocked', 'sensor', 'critical'), F('battery-low', 'power', 'info')], quiet, false);
  ok('bands: data and sensor findings, and notes, do not count', b.band === 'ok', JSON.stringify(b));
  b = HC.bandsOf([F('battery-falling', 'power', 'warn'), F('missed-checks', 'comms', 'critical')], quiet, false);
  ok('bands: act on first among the reasons', b.band === 'act' && b.reasons[0].b === 'act' && !b.battRed);
}
{
  const H = 3600000, a = Date.UTC(2026, 10, 1), P = 3 * H;
  const byBase = new Map([['A', new Map([[a, 10], [a + H, 20], [a + 2 * H, 30], [a + 3 * H, 40]])], ['B', new Map([[a, 5]])]]);
  const slots = [{ t: a + 1.5 * H }, { t: a + 4.5 * H }];
  let tb = HC.trafficBins(byBase, ['A', 'B'], slots, P, a, a + 12 * H);
  ok('traffic: a slot\'s bar adds the hours of its period, both base stations', tb.bins.length === 2 && tb.bins[0].t0 === a && tb.bins[0].n === 65 && !tb.hourly, JSON.stringify(tb.bins));
  ok('traffic: the next slot adds its own hours only', tb.bins[1].n === 40, JSON.stringify(tb.bins[1]));
  tb = HC.trafficBins(byBase, ['A'], slots, H, a, a + 4 * H);
  ok('traffic: a check every hour or faster is drawn by the hour', tb.hourly && tb.bins.length === 4 && tb.bins[1].n === 20);
  ok('traffic: the right axis tops out on a round number above the tallest bar', HC.trafficBins(byBase, ['A'], slots, P, a, a + 12 * H).max === 100);
}
{
  ok('words: every glossary entry has a meaning', HC.GLOSSARY.every(([k]) => typeof HC.WORDS[k] === 'string' && HC.WORDS[k].length > 30));
  const night = HC.nightsOf(150, Date.UTC(2026, 10, 17), Date.UTC(2026, 10, 19));
  ok('nights: two days hold two nights or three part ones, each 12 h or less', night.length >= 2 && night.length <= 3 && night.every(([a, b]) => b > a && b - a <= 12 * 3600000 + 1));
}

// ── 2. the cards in Chromium, on the demo week ───────────────────────────────

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: 90000 });
  await page.evaluate(async () => {
    switchTab('health');
    Health.demo();
    for (let i = 0; i < 300 && !document.querySelector('.hc-card'); i++) await new Promise(r => setTimeout(r, 50));
  });
  const first = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.hc-card')];
    const styled = [...document.querySelectorAll('#hc-panel [style]')].filter(el =>
      !(el.getAttribute('style') || '').split(';').map(d => d.trim()).filter(Boolean).every(d => /^--[\w-]+\s*:/.test(d)));
    const hub = document.getElementById('hc-hub');
    return { n: cards.length, styled: styled.map(e => e.tagName + ' ' + e.getAttribute('style')).slice(0, 3),
      hub: hub && hub.value, options: hub ? hub.options.length : 0, count: (document.getElementById('hc-count') || {}).textContent || '',
      chips: cards.filter(c => c.querySelector('.hc-chip')).length };
  });
  ok('chromium: a card per station of the hub picked', first.n > 20 && first.hub && first.count.startsWith(first.n.toLocaleString('en-AU')), JSON.stringify(first));
  ok('chromium: every card a chip and a name', first.chips === first.n);
  ok('chromium: cards placed by custom properties only', first.styled.length === 0, first.styled.join(' · '));

  await page.evaluate(() => document.getElementById('hc-grid').scrollIntoView({ block: 'start' }));
  const gb = await (await page.$('#hc-grid')).boundingBox();
  const px = gb.x + gb.width * 0.5, py = gb.y + gb.height * 0.45;
  const sizeAt = () => page.evaluate(([x, y]) => {
    const all = [...document.querySelectorAll('.hc-card')];
    const box = el => el.getBoundingClientRect();
    const f = document.querySelector('.hc-card--focus');
    const under = document.elementFromPoint(x, y);
    const areas = all.map(el => box(el).width * box(el).height).sort((a, b) => a - b);
    return { focus: f ? { w: box(f).width, h: box(f).height, big: f.classList.contains('hc-card--big'), why: (f.querySelector('.hc-why') || {}).textContent || '' } : null,
      underIsFocus: !!(under && under.closest('.hc-card') && under.closest('.hc-card') === f),
      median: areas[Math.floor(areas.length / 2)], spread: areas[areas.length - 1] / areas[0] };
  }, [x0(px), x0(py)]);
  function x0(v) { return v; }
  const base = await page.evaluate(() => { const r = document.querySelector('.hc-card').getBoundingClientRect(); return { w: r.width, h: r.height }; });
  await page.mouse.move(px, py, { steps: 4 });
  await page.waitForTimeout(450);
  const mag = await sizeAt();
  ok('chromium: the card under the pointer about 3× and still under it', mag.focus && mag.underIsFocus && mag.focus.w > base.w * 2.3 && mag.focus.h > base.h * 2.3,
    JSON.stringify({ base, mag }));
  ok('chromium: the magnified card says why it is marked', mag.focus && mag.focus.big && mag.focus.why.length > 5, JSON.stringify(mag.focus));
  await page.mouse.move(px + 6, py + 4, { steps: 2 });
  await page.waitForTimeout(300);
  ok('chromium: a small move keeps the same card magnified', (await sizeAt()).underIsFocus);

  await page.evaluate(() => HealthCards.toggleMag());
  await page.waitForTimeout(300);
  const off = await sizeAt();
  ok('chromium: magnifier off, every card one size', !off.focus && off.spread < 1.05, JSON.stringify(off));
  ok('chromium: the magnifier button says off', await page.evaluate(() => document.getElementById('hc-mag').getAttribute('aria-pressed') === 'false'));
  await page.evaluate(() => HealthCards.toggleMag());

  const cw = () => page.evaluate(() => document.querySelector('.hc-card').getBoundingClientRect().width);
  const w1 = await cw();
  await page.evaluate(() => HealthCards.zoomBy(1));
  await page.waitForTimeout(250);
  const w2 = await cw();
  ok('chromium: + makes the cards bigger', w2 > w1 * 1.2, `${w1} → ${w2}`);
  await page.mouse.move(gb.x + 40, gb.y + 40);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 300);
  await page.keyboard.up('Control');
  await page.waitForTimeout(250);
  const w3 = await cw();
  ok('chromium: Ctrl + scroll down makes them smaller again', w3 < w2, `${w2} → ${w3}`);
  await page.evaluate(() => HealthCards.zoomBy(0));
  await page.waitForTimeout(250);
  ok('chromium: Fit all puts them back', near(await cw(), w1, 1.5));

  await page.mouse.move(px, py, { steps: 3 });
  await page.waitForTimeout(350);
  await page.mouse.click(px, py);
  await page.waitForSelector('#hc-dialog[open] #hc-chart', { timeout: 5000 });
  const sb = await (await page.$('#hc-chart')).boundingBox();
  await page.mouse.move(sb.x + sb.width * 0.5, sb.y + sb.height * 0.2, { steps: 3 });
  await page.waitForTimeout(200);
  const tip = await page.evaluate(() => { const t = document.getElementById('hc-tip'); return t && !t.hidden ? t.innerText : ''; });
  ok('chromium: the chart\'s callout names the time and the battery', /\d{1,2}:\d{2}/.test(tip) && /Battery/.test(tip) && /Check/.test(tip), tip);
  const dlg = await page.evaluate(() => ({ name: (document.querySelector('#hc-dialog h3') || {}).textContent || '', why: document.querySelectorAll('.hc-d-why li').length }));
  ok('chromium: the chart is named for its station and says why', dlg.name.length > 2 && dlg.why >= 1, JSON.stringify(dlg));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => ({ open: document.getElementById('hc-dialog').open, focus: !!(document.activeElement && document.activeElement.classList.contains('hc-card')) }));
  ok('chromium: Escape closes it, focus back on the card', !back.open && back.focus, JSON.stringify(back));
} finally {
  await browser.close();
  server.close();
}
ok('chromium: a clean console', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
