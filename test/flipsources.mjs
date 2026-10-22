// The Bit-Flip Sources tab (flip-sources.js, 0079), driven in Chromium with
// meganet.flip_sources stood in for by a fixture built on the real station
// file's ids:
//
//   1. **One request** — entering the tab asks for both periods at once; a
//      period switch, a repeater picked and the tab re-entered ask nothing more.
//   2. **The ranking** — a repeater caught by its carrier comes before one
//      that only carries a big pass-range share; a broad repeater whose share
//      is big but whose rate is the network's is "within the usual"; each
//      verdict says what it means in its title, and a key under the table.
//   3. **A repeater picked** — its corrupted stations listed, joined to it on
//      the map, and picked again, let go.
//   4. **The exports** — floodnet-named CSVs with the suspects and the readings.
//   5. **No table** — a database without 0079 says so, with Try again.
//   6. **A phone** — nothing wider than a 375 px screen.
//
// Run:  npm run flipsources

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];
const until = async (page, fn, arg, timeout = 20_000) => page.waitForFunction(fn, arg, { timeout });

let FIX = null, MISSING = false;
const asked = [];
async function standIn(page) {
  await page.route('**/rest/v1/flip_sources?*', route => {
    asked.push(route.request().url());
    if (MISSING) return route.fulfill({ status: 404, contentType: 'application/json',
      body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'meganet.flip_sources' in the schema cache" }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX) });
  });
}

// Three repeaters from the file and five sensor addresses: R1 caught by its
// carrier on 8 clear copies; R2 a broad one with the biggest share but the
// network's rate; R3 above it.
function fixture(st) {
  const [r1, r2, r3] = st.reps, a = st.addrs;
  const cand = (r, o) => ({ rid: r.id, name: r.name, lat: r.lat, lon: r.lon, only_it: 0, stations: 2, clear: 0, by_carrier: 0, ...o });
  const station = (addr, n, o) => ({ addr, station_id: null, n, addr_flips: 1, no_carrier: n, first_at: '2026-10-15T01:00:00Z', last_at: '2026-10-20T13:00:00Z',
    targets: [{ addr: addr ^ 4, n }], senders: {}, candidates: [r1.id, r2.id], ...o });
  const d7 = {
    days: 7, built_at: '2026-10-21T01:14:00Z', corrupted: 60, heard: 6000, network_rate: 0.01,
    by_how: { carrier: 10, 'no-carrier': 50 },
    candidates: [
      cand(r2, { blame: 30, carried: 3000, rate: 0.01, stations: 5 }),
      cand(r3, { blame: 12, carried: 500, rate: 0.024, only_it: 4 }),
      cand(r1, { blame: 18, carried: 1500, rate: 0.012, by_carrier: 10, clear: 8 }),
    ],
    stations: [
      station(a[0], 20, { senders: { ['st:' + r1.id]: 8 }, no_carrier: 12 }),
      station(a[1], 15),
      station(a[2], 12, { candidates: [r3.id] }),
      station(a[3], 8, { candidates: [r2.id, r3.id] }),
      station(a[4], 5, { candidates: [] }),
    ],
    hours: Array.from({ length: 24 }, (_, h) => (h >= 19 || h < 4 ? 5 : 0)).map((v, h) => (h === 4 ? 5 : v)),
    per_day: [{ day: '2026-10-15', n: 10 }, { day: '2026-10-16', n: 20 }, { day: '2026-10-17', n: 30 }],
  };
  const d30 = { ...d7, days: 30, corrupted: 240, heard: 24000 };
  return [{ period_days: 7, data: d7, built_at: d7.built_at }, { period_days: 30, data: d30, built_at: d7.built_at }];
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Australia/Brisbane', acceptDownloads: true });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await standIn(page);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await until(page, () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, LOAD_TIMEOUT);

  const st = await page.evaluate(() => {
    const placed = state.data.stations.filter(s => s.lat != null && s.lon != null);
    const reps = placed.slice(0, 3).map(s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon }));
    const addrs = [...new Set(placed.slice(3).flatMap(s => (s.sensors || []).map(x => Number(x.alert_id)))
      .filter(a => Number.isInteger(a) && a > 0 && a < 8192))].slice(0, 5);
    return { reps, addrs };
  });
  FIX = fixture(st);

  // ── 1. one request ────────────────────────────────────────────────────────
  await page.evaluate(() => switchTab('flipsources'));
  await until(page, () => !!document.querySelector('.fs-suspects'));
  ok('entering the tab asks for flip_sources once', asked.length === 1, asked.join(' '));
  const lead = await page.evaluate(() => document.getElementById('main-content').textContent.replace(/\s+/g, ' '));
  ok('the lead counts the corrupted copies and the network rate', /60 corrupted copies/.test(lead) && /6,000 legacy bursts/.test(lead) && /1\.0%/.test(lead), lead.slice(0, 300));
  ok('…and names who to look at first', new RegExp(`Look first at: ${st.reps[0].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(lead), lead.slice(0, 400));

  // ── 2. the ranking ────────────────────────────────────────────────────────
  const rows = await page.evaluate(() => [...document.querySelectorAll('.fs-suspects tbody tr')].map(tr => ({
    name: tr.querySelector('th').textContent.trim(), verdict: tr.lastElementChild.textContent.trim() })));
  ok('caught by its carrier comes first', rows[0] && rows[0].name === st.reps[0].name && rows[0].verdict === 'Caught by its carrier', JSON.stringify(rows));
  ok('twice the network\'s rate comes next', rows[1] && rows[1].name === st.reps[2].name && /2\.4× the network/.test(rows[1].verdict), JSON.stringify(rows));
  ok('the biggest share at the network\'s rate is within the usual', rows[2] && rows[2].name === st.reps[1].name && rows[2].verdict === 'Within the usual', JSON.stringify(rows));
  const meant = await page.evaluate(() => ({
    tips: [...document.querySelectorAll('.fs-suspects tbody td:last-child .fs-verdict')].map(s => s.getAttribute('title') || ''),
    key: [...document.querySelectorAll('.fs-key dt')].map(dt => dt.textContent.trim()),
    keyText: (document.querySelector('.fs-key') || {}).textContent || '',
  }));
  ok('each verdict says what it means when pointed at', meant.tips.length === rows.length && /as strong as the clean copy/.test(meant.tips[0])
    && /twice the network's 1\.0%/.test(meant.tips[1]) && /broad pass range/.test(meant.tips[2]) && !meant.tips.some(t => /\\/.test(t)), JSON.stringify(meant.tips));
  ok('…and the key under the table says it for a finger', meant.key.length === 5 && meant.key[0] === 'Caught by its carrier' && meant.key[4] === 'Within the usual'
    && /What the verdicts mean/.test(meant.keyText), JSON.stringify(meant.key));

  // ── 3. a repeater picked ──────────────────────────────────────────────────
  await page.locator('.fs-suspects tbody tr').first().locator('th button').click();
  await until(page, () => /by its carrier/.test((document.getElementById('fs-selected') || {}).textContent || ''));
  const sel = await page.evaluate(() => ({
    items: document.querySelectorAll('#fs-selected li').length,
    text: document.getElementById('fs-selected').textContent.replace(/\s+/g, ' '),
    lines: document.querySelectorAll('#fs-map path.leaflet-interactive').length,
    pressed: document.querySelector('.fs-suspects tbody tr th button').getAttribute('aria-pressed'),
  }));
  ok('a repeater picked lists the corrupted addresses it passes', sel.items === 2 && /8 by its carrier/.test(sel.text), sel.text.slice(0, 300));
  ok('…pressed, and joined to them on the map', sel.pressed === 'true' && sel.lines >= 2 + 5, JSON.stringify(sel));
  await page.locator('.fs-suspects tbody tr').first().locator('th button').click();
  ok('picked again, let go', await page.evaluate(() => /Pick a repeater/.test(document.getElementById('fs-selected').textContent)));

  await page.getByRole('button', { name: 'Last 30 days' }).click();
  await until(page, () => /240 corrupted copies/.test(document.getElementById('main-content').textContent));
  ok('the 30-day period shows its own counts', true);
  await page.evaluate(() => switchTab('health'));
  await page.evaluate(() => switchTab('flipsources'));
  await until(page, () => !!document.querySelector('.fs-suspects'));
  ok('a period switch, a pick and re-entering ask nothing more', asked.length === 1, String(asked.length));

  const when = await page.evaluate(() => ({ bars: document.querySelectorAll('.fs-bars rect').length, text: document.querySelector('.fs-when').textContent }));
  ok('the hours and the days are drawn, and the night share said', when.bars === 27 && /100% of them between 18:00 and 06:00/.test(when.text), JSON.stringify(when).slice(0, 200));

  // ── 4. the exports ────────────────────────────────────────────────────────
  for (const [fn, name, head] of [['exportCsv', 'floodnet-bit-flip-suspects-30d.csv', 'repeater,station_id,verdict'],
    ['exportStationsCsv', 'floodnet-bit-flip-stations-30d.csv', 'address,station,corrupted']]) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(f => FlipSources[f](), fn)]);
    const body = await (await dl.createReadStream()).toArray().then(b => Buffer.concat(b).toString());
    ok(`${fn} downloads ${name}`, dl.suggestedFilename() === name && body.startsWith(head) && body.trim().split('\n').length >= 4,
      `${dl.suggestedFilename()} ${body.slice(0, 120)}`);
  }

  // ── 6. a phone ────────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  ok('nothing wider than a 375 px phone', wide <= 376, String(wide));
  await context.close();

  // ── 5. no table ───────────────────────────────────────────────────────────
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await c2.newPage();
  await applyNetworkPolicy(p2, server.origin);
  await standIn(p2);
  p2.on('pageerror', e => errors.push(e.message));
  MISSING = true;
  await p2.goto(server.origin + '/index.html?tab=flipsources', { waitUntil: 'domcontentloaded' });
  await until(p2, () => typeof state !== 'undefined' && !!state.data, null, LOAD_TIMEOUT);
  await p2.evaluate(() => { if (state.activeTab !== 'flipsources') switchTab('flipsources'); });
  await until(p2, () => /migration 0079/.test(document.getElementById('main-content').textContent));
  ok('a database without 0079 says so, with Try again', await p2.evaluate(() => !!document.querySelector('#main-content [role=alert]')
    && [...document.querySelectorAll('#main-content button')].some(b => b.textContent.trim() === 'Try again')));
  MISSING = false;
  await p2.getByRole('button', { name: 'Try again' }).click();
  await until(p2, () => !!document.querySelector('.fs-suspects'));
  ok('…and Try again, answered, draws it', true);
  await c2.close();

  ok('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`  FAIL ${e.stack || e}`);
}
await browser.close();
await server.close();
if (failures) { console.log(`\nFAIL — ${failures} check(s) failed.`); process.exit(1); }
console.log('\nPASS — the Bit-Flip Sources tab.');
