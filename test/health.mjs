// The Station Health tab (health.js, health-analysis.js, health-agent.js), the
// values the Message Log works out for raw counts (sensor-values.js), and the
// door from Station Health to the Reception Map.
//
// The oracle is a week whose answer is known: HealthAnalysis.demoWorld() builds
// one against the real register — twelve real stations side by side, one of
// every fault planted once — and the check holds the analysis to finding each
// where it was planted, and nothing at the stations left alone. Then the rules
// that are easy to get wrong, each on a few readings built for it, and the tab
// as an operator uses it:
//
//   * a raw count shown as what it is worth: 133 on a battery address is
//     13.3 V, marked as worked out; an address whose only owner is across the
//     country from everything else the receiver hears is called far
//   * every planted fault found at its station, and the stations left alone
//     clean
//   * a schedule read off the gaps: a 3-hour station that misses every fourth
//     check and went silent for two days is still 3-hourly
//   * a rain gauge tipping through a storm is reporting, not being corrupted;
//     a battery copy with a bit flipped two seconds later is a corrupted copy
//   * a ghost on a station's own address — out of line with what that address
//     reports, beside a twin in line with its own — is set aside; two
//     stations' frames that only look alike are both kept
//   * the tab fetching page by page from the datastore (stood in for here),
//     findings worst first, a filter, a station opened and a missed check
//     put in its context
//   * the Airtime panel: the demo week's one planted clash found, said to
//     hurt, the station coming off worse moved somewhere clear — and nothing
//     else (airtime.mjs holds the rules themselves, in Node)
//   * the door to the Reception Map carrying the same readings over
//   * Claude's briefing, its tool loop run against a scripted client: tools
//     answered, a tool that does not exist refused, the briefing drawn with
//     its station links
//   * …or another AI, from the briefing pack: Anthropic out of reach said so
//     and pointed to it; the pack holding each station with a warning in
//     full, under Claude's own instructions with the tools taken out;
//     downloaded as floodnet-…; and the other AI's answer pasted back drawn
//     as the briefing, its stations links
//   * …on Flood-Net's key (#229), the route stood in for: a signed-in editor
//     offered it with today's spend and no key field, nothing announced for
//     asking; the call sent to the route with the session as it is now, a key
//     planted in it dropped, and a body the Worker's own check accepts; the
//     day spent turning the panel to the person's own key, which then runs
//     on that key alone; a viewer, and the signed-out, offered their own key
//     with the route not asked — and only there a box to remember it, about
//     the device, unticked, honoured only when ticked
//   * the server's own last look (#215, 0059): while the week arrives, what it
//     found, worst first and notes left out; after, how fresh it is — and a
//     server that has stopped looking said to have
//   * no sideways scroll at 375 px; no page errors
//
// Run:  npm run health
//       npm run health -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { requestProblem } from '../worker/briefing.js';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

// The datastore, stood in for: meganet.reading answered from the demo week the
// way PostgREST answers it — the reading_ts window, alert_id=not.is.null, the
// primary-key order, and pages of at most 1,000.
let WORLD = null;
const asked = [];
async function standIn(page) {
  await page.route('**/rest/v1/reading?*', route => {
    const u = new URL(route.request().url());
    const q = u.searchParams;
    asked.push(u.search);
    const ts = q.getAll('reading_ts');
    const gte = Date.parse((ts.find(x => x.startsWith('gte.')) || 'gte.1970-01-01').slice(4));
    const lt = Date.parse((ts.find(x => x.startsWith('lt.')) || 'lt.2999-01-01').slice(3));
    let rows = (WORLD ? WORLD.rows : []).filter(r => { const t = Date.parse(r.reading_ts); return t >= gte && t < lt; });
    if (q.get('alert_id') === 'not.is.null') rows = rows.filter(r => r.alert_id != null);
    rows.sort((a, b) => Date.parse(a.reading_ts) - Date.parse(b.reading_ts) || a.addr.localeCompare(b.addr) || a.value_raw - b.value_raw);
    const off = Number(q.get('offset')) || 0, lim = Math.min(1000, Number(q.get('limit')) || 1000);
    const cols = (q.get('select') || '').split(',').filter(Boolean);
    const body = rows.slice(off, off + lim).map(r => Object.fromEntries(cols.map(k => [k, r[k] === undefined ? null : r[k]])));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  // The server's own last look (0059): when the station analysis last ran
  // unattended, and what it found that is still open.
  await page.route('**/rest/v1/health_refresh?*', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify([{ at: new Date(Date.now() - SERVER_AGO).toISOString() }]) }));
  await page.route('**/rest/v1/health_finding?*', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(WORLD ? [
      { kind: 'silent', subject: 'silent:' + WORLD.roles.silent, station_id: WORLD.roles.silent, severity: 'critical',
        title: 'Silent — missed its last 4 checks', first_seen: new Date(Date.now() - 3600e3).toISOString() },
      { kind: 'battery-low', subject: 'battery-low:' + WORLD.roles.fading, station_id: WORLD.roles.fading, severity: 'warn',
        title: 'Battery low — 12.1 V', first_seen: new Date(Date.now() - 7200e3).toISOString() },
      { kind: 'receiver-silent', subject: 'receiver-silent:x', station_id: null, severity: 'info', title: 'a session', first_seen: null },
    ] : []) }));
}
let SERVER_AGO = 6 * 60e3;

const until = async (page, fn, arg, timeout = 20_000) => page.waitForFunction(fn, arg, { timeout });
// The same, for something only this side of the page can see (a route's log).
const settles = async (fn, timeout = 10_000) => {
  for (const t0 = Date.now(); !fn(); await new Promise(r => setTimeout(r, 50))) if (Date.now() - t0 > timeout) return false;
  return true;
};

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Australia/Brisbane' });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await standIn(page);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await until(page, () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, LOAD_TIMEOUT);

  // ── what a raw count is worth ──────────────────────────────────────────────
  const sv = await page.evaluate(() => {
    const idx = SensorValues.index();
    const own = [...idx.entries()].filter(([, l]) => l.length === 1);
    const batt = own.find(([, l]) => l[0].kind === 'battery' && l[0].station.lat != null);
    const conv = SensorValues.convert('battery', 133);
    const wild = SensorValues.convert('battery', 1873);
    const rain = SensorValues.convert('rain', 43, null);
    const level = SensorValues.convert('level', 512);
    // Three stations near each other fix where a receiver hears; an address
    // whose only owner is far from them is called far.
    const placed = own.filter(([, l]) => l[0].station.lat != null);
    const a0 = placed[0][1][0].station;
    const near = placed.filter(([, l]) => SensorValues.km(a0.lat, a0.lon, l[0].station.lat, l[0].station.lon) < 40).slice(0, 4);
    const far = placed.find(([, l]) => SensorValues.km(a0.lat, a0.lon, l[0].station.lat, l[0].station.lon) > 1200);
    const row = (a, v) => ({ addr: 'a:' + a, alert_id: a, reading_ts: '2026-10-01T00:00:00Z', value_raw: v, path: 'serial-monitor/test-pi-sdr0', station_id: null });
    const rows = near.map(([a]) => row(a, 130)).concat(far ? [row(far[0], 130)] : []);
    const res = SensorValues.resolver(rows);
    return {
      conv, wild, rain, level, battAddr: batt && batt[0],
      nearConf: near.map(([a]) => res(row(a, 130)).conf), farConf: far ? res(row(far[0], 130)).conf : null, nNear: near.length,
    };
  });
  ok('a battery count of 133 is 13.3 V', sv.conv && sv.conv.text === '13.3 V' && sv.conv.plausible === true, JSON.stringify(sv.conv));
  ok('…and one of 1873 is not a station battery, and says so', sv.wild && sv.wild.plausible === false && /not a 12 V/.test(sv.wild.note), JSON.stringify(sv.wild));
  ok('a rain count is millimetres of running total, the bucket assumed and said to be', sv.rain && sv.rain.unit === 'mm' && /assumed/.test(sv.rain.rule) && sv.rain.cumulative, JSON.stringify(sv.rain));
  ok('a level count stays a count — no scale is on file', sv.level && sv.level.value == null && sv.level.text === 'raw count', JSON.stringify(sv.level));
  ok('an address whose only owner is across the country from where the receiver hears is far',
    sv.nNear >= 3 && sv.nearConf.every(c => c === 'sole') && sv.farConf === 'far', JSON.stringify(sv));

  const ml = await page.evaluate(async a => {
    switchTab('msglog');
    MessageLog.adoptRows([{ addr: 'a:' + a, alert_id: a, station_number: null, channel: '', station_id: null,
      reading_ts: new Date().toISOString(), received_at: new Date().toISOString(), value_raw: 133, value: null, unit: null,
      conversion: null, quality: 0, protocol: 1, source: 5, path: 'serial-monitor/test-pi-sdr0', dup_count: 0, dup_paths: [],
      last_dup_at: null, raw_id: null, freq_mhz: null, rssi_dbm: null, level_dbfs: -40, snr_db: 12 }]);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const cell = document.querySelector('.ml-inferred');
    return { text: cell ? cell.closest('td').textContent.trim() : null };
  }, sv.battAddr);
  ok('the Message Log shows 13.3 V for a battery heard as 133, marked as worked out', ml.text && /13\.3 V/.test(ml.text) && /worked out/.test(ml.text), JSON.stringify(ml));

  // ── the demo week: every planted fault, and nothing else ───────────────────
  WORLD = await page.evaluate(() => {
    const w = HealthAnalysis.demoWorld(undefined, { now: Date.now() });
    return { rows: w.rows, roles: w.roles, t0: w.t0, t1: w.t1, now: w.now, host: w.host };
  });
  ok('the demo week is built against the real register', WORLD.rows.length > 1000 && WORLD.roles.silent && WORLD.roles.corrupt, `${WORLD.rows.length} rows`);

  const dw = await page.evaluate(W => {
    const A = HealthAnalysis.run(W.rows, { t0: W.t0, t1: W.t1, now: W.now });
    const at = (kind, id) => A.findings.find(f => f.kind === kind && (id == null || f.stationId === id || (f.evidence && Array.isArray(f.evidence.stations) && f.evidence.stations.includes(id))));
    const r = W.roles;
    const quiet = ['steady', 'steady2'].map(k => ({ k, f: A.findings.filter(f => f.stationId === r[k] && f.severity !== 'info').map(f => f.kind) }));
    return {
      silent: !!at('silent', r.silent), falling: !!at('battery-falling', r.falling), flat: !!at('battery-no-charge', r.flatline),
      fading: !!at('missed-rising', r.fading), partial: !!at('partial-checks', r.partial), corrupt: !!at('corrupt-copies', r.corrupt),
      blocked: !!at('rain-blocked', r.blocked), outage: !!A.findings.find(f => f.kind === 'receiver-outage'),
      spell: !!(at('shared-spell', r.steady3) && at('shared-spell', r.steady4) && at('shared-spell', r.steady5)),
      ghosts: (A.findings.find(f => f.kind === 'ghosts') || { evidence: {} }).evidence.ghosts || 0,
      quiet, order: A.findings.map(f => f.severity),
      silentStatus: (A.stations.get(r.silent) || {}).status,
      period: [...A.stations.values()].filter(S => S.schedule).map(S => S.schedule.P / 60000),
    };
  }, WORLD);
  ok('the station that stopped is silent', dw.silent);
  ok('…and its pin takes the colour of its worst finding', dw.silentStatus === 'critical', dw.silentStatus);
  ok('the battery sliding 0.12 V a night is falling', dw.falling);
  ok('the battery held at 12.4 V day and night has no charge', dw.flat);
  ok('the station missing more checks each day is rising', dw.fading);
  ok('the station whose battery frame goes missing sends incomplete checks', dw.partial);
  ok('the station whose frames are relayed with bits flipped has corrupted copies', dw.corrupt);
  ok('the rain gauge dry through its neighbours\' storm is blocked', dw.blocked);
  ok('the receiver\'s three hours with nothing are an outage', dw.outage);
  ok('three neighbours gone overnight together are one shared spell', dw.spell);
  ok('the ghost is set aside', dw.ghosts >= 1, 'ghosts: ' + dw.ghosts);
  ok('the stations left alone have nothing worse than a note', dw.quiet.every(q => !q.f.length), JSON.stringify(dw.quiet));
  ok('worst first', dw.order.every((s, i) => i === 0 || ['critical', 'warn', 'info'].indexOf(dw.order[i - 1]) <= ['critical', 'warn', 'info'].indexOf(s)), dw.order.join(','));
  ok('every station\'s schedule is read as 3-hourly', dw.period.length >= 10 && dw.period.every(p => p === 180), JSON.stringify(dw.period));

  // ── the rules, each on readings built for it ───────────────────────────────
  const rules = await page.evaluate(() => {
    const H = 3600e3;
    // A 3-hour station that misses every fourth check, and went silent for
    // two days in the middle.
    const t0 = Date.UTC(2026, 8, 1);
    const times = [];
    for (let k = 0; k < 56; k++) if (k % 4 !== 0 && (k < 20 || k > 35)) times.push(t0 + k * 3 * H + 41000);
    const sch = HealthAnalysis._detectSchedule(times, () => true, t0, t0 + 56 * 3 * H, t0 + 56 * 3 * H);
    // Copies: a storm's tips seconds apart; a battery copy flipped 2 s later.
    const rec = (aid, t, v, path) => ({ addr: 'a:' + aid, alert_id: aid, reading_ts: new Date(t).toISOString(), received_at: new Date(t + 2000).toISOString(),
      value_raw: v, protocol: 1, path: path || 'serial-monitor/test-pi-sdr0', dup_count: 0, dup_paths: [] });
    const storm = [], s0 = t0 + 10 * H;
    for (let i = 0; i < 12; i++) storm.push(rec(7001, s0 + i * 7000, 400 + i));
    const sTx = HealthAnalysis._transmissions(HealthAnalysis._normalise(storm));
    const flip = [rec(7002, t0, 133), rec(7002, t0 + 2100, 133 ^ 8), rec(7002, t0 + 3 * H, 134), rec(7002, t0 + 6 * H, 133)];
    const fTx = HealthAnalysis._transmissions(HealthAnalysis._normalise(flip));
    return { P: sch && sch.P / 60000, stormBad: sTx.reduce((n, tx) => n + tx.bad.length, 0), stormTx: sTx.length,
      flipBad: fTx.reduce((n, tx) => n + tx.bad.length, 0), flipTruth: fTx[0] && fTx[0].v };
  });
  ok('a 3-hour station that misses every fourth check and went silent for two days is still 3-hourly', rules.P === 180, 'period ' + rules.P + ' min');
  ok('a rain gauge tipping every 7 s through a storm is reporting, not corrupted', rules.stormBad === 0 && rules.stormTx === 12, JSON.stringify(rules));
  ok('a battery copy with a bit flipped 2 s after the clean one is a corrupted copy of it', rules.flipBad === 1 && rules.flipTruth === 133, JSON.stringify(rules));

  // A ghost on a station's own address, and two stations that only look alike.
  const gh = await page.evaluate(() => {
    const H = 3600e3, pop = x => { let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; };
    const idx = SensorValues.index();
    const own = new Map([...idx.entries()].filter(([, l]) => l.length === 1 && l[0].station.lat != null).map(([a, l]) => [a, l[0].station]));
    // Two stations near each other whose addresses differ in one bit.
    let pair = null;
    for (const [a, sa] of own) {
      for (let k = 0; k < 13 && !pair; k++) {
        const b = a ^ (1 << k), sb = own.get(b);
        if (sb && sb.id !== sa.id && SensorValues.km(sa.lat, sa.lon, sb.lat, sb.lon) < 60) pair = { a, b, sa, sb };
      }
      if (pair) break;
    }
    if (!pair) return null;
    const t0 = Date.UTC(2026, 8, 1, 0, 0, 41);
    const rec = (aid, t, v) => ({ addr: 'a:' + aid, alert_id: aid, reading_ts: new Date(t).toISOString(), received_at: new Date(t + 2000).toISOString(),
      value_raw: v, protocol: 1, path: 'serial-monitor/test-pi-sdr0', dup_count: 0, dup_paths: [] });
    const rows = [];
    // a reads 50-odd every 3 h; b reads in the thousands every 3 h, 20 min later.
    for (let k = 0; k < 16; k++) { rows.push(rec(pair.a, t0 + k * 3 * H, 50 + (k % 3))); rows.push(rec(pair.b, t0 + k * 3 * H + 20 * 60e3, 1200 + (k % 4))); }
    // At 25 h: a = 51, and two seconds later b = 51 — a's frame with an address bit flipped.
    const tg = t0 + 25 * H;
    rows.push(rec(pair.a, tg, 51), rec(pair.b, tg + 2000, 51));
    const A = HealthAnalysis.run(rows, { t0: t0 - H, t1: t0 + 48 * H, now: t0 + 48 * H });
    const Sb = A.stations.get(pair.sb.id);
    const bVals = Sb ? Sb.txs.map(tx => tx.v) : [];
    const gf = A.findings.find(f => f.kind === 'ghosts');
    // Look-alikes: c and d both read 130-odd, and at one moment both read 131 a second apart.
    const rows2 = [];
    for (let k = 0; k < 16; k++) { rows2.push(rec(pair.a, t0 + k * 3 * H, 130 + (k % 2))); rows2.push(rec(pair.b, t0 + k * 3 * H + 20 * 60e3, 131 - (k % 2))); }
    rows2.push(rec(pair.a, tg, 131), rec(pair.b, tg + 1000, 131));
    const A2 = HealthAnalysis.run(rows2, { t0: t0 - H, t1: t0 + 48 * H, now: t0 + 48 * H });
    const Sb2 = A2.stations.get(pair.sb.id);
    return { pair: [pair.a, pair.b], bits: pop(pair.a ^ pair.b), bHas51: bVals.includes(51), bN: bVals.length,
      ghosts: gf ? gf.evidence : null, lookAlikeKept: Sb2 ? Sb2.txs.some(tx => tx.v === 131 && Math.abs(tx.t - tg - 1000) < 5) : false,
      lookAlikeGhosts: (A2.findings.find(f => f.kind === 'ghosts') || { evidence: { ghosts: 0 } }).evidence.ghosts };
  });
  ok('two stations near each other with addresses a bit apart exist to test with', gh && gh.bits === 1, JSON.stringify(gh && gh.pair));
  ok('a frame on a station\'s address, out of line with it and in line with a twin\'s, is a ghost and set aside',
    gh && !gh.bHas51 && gh.bN === 16 && gh.ghosts && gh.ghosts.onStationAddresses === 1, JSON.stringify(gh));
  ok('two stations\' frames that only look alike are both kept', gh && gh.lookAlikeKept && gh.lookAlikeGhosts === 0, JSON.stringify(gh));

  // ── the tab ────────────────────────────────────────────────────────────────
  // Every sentence the status line says, kept: what it said while the week was
  // still arriving is gone by the time the analysis is drawn.
  await page.evaluate(() => {
    window.__status = [];
    window.__statusWatch = new MutationObserver(() => { const el = document.getElementById('hl-status'); if (el) window.__status.push(el.textContent.replace(/\s+/g, ' ')); });
    window.__statusWatch.observe(document.getElementById('main-content') || document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.evaluate(() => { try { localStorage.setItem('mn-hl-win', '7d'); } catch (_) {} switchTab('health'); });
  await until(page, () => document.querySelector('.hl-ftable tbody tr') && Health.state().A, null, 60_000);
  const said = await page.evaluate(() => { window.__statusWatch.disconnect(); return { log: window.__status, now: document.getElementById('hl-status').textContent.replace(/\s+/g, ' ') }; });
  const silentName = await page.evaluate(id => (state.data.stations.find(s => s.id === id) || {}).name, WORLD.roles.silent);
  const meanwhile = said.log.find(t => /Meanwhile/.test(t)) || '';
  ok('while the week arrives, the server\'s last look says what it found — the worst first, notes left out',
    meanwhile.includes(`Meanwhile, the server's last look (6 min ago): 1 critical, 1 warning — ${silentName}: Silent — missed its last 4 checks;`)
      && /Battery low — 12\.1 V\./.test(meanwhile) && !/a session/.test(meanwhile), meanwhile || said.log.slice(-3).join(' | '));
  ok('…and once the tab has worked it out, how fresh the server\'s look is',
    /The server looks every fifteen minutes too; last 6 min ago\./.test(said.now), said.now);
  const tab = await page.evaluate(() => {
    const st = Health.state();
    return {
      rows: st.rows.length, t0: st.A.t0, t1: st.A.t1, findings: document.querySelectorAll('.hl-ftable tbody tr').length,
      first: (document.querySelector('.hl-ftable tbody tr') || {}).className || '',
      markers: document.querySelectorAll('.leaflet-container .leaflet-interactive').length,
    };
  });
  const pages = asked.filter(s => /offset=/.test(s));
  // Every row in the week the tab asked for — built seconds before the tab
  // asked, the demo week can have a frame in the seconds its window has
  // since moved past.
  const inWin = WORLD.rows.filter(r => { const t = Date.parse(r.reading_ts); return t >= tab.t0 && t < tab.t1; }).length;
  ok('the tab reads the week from the datastore, twelve hours at a time, every row', tab.rows === inWin && inWin >= WORLD.rows.length - 20 && pages.length >= 14,
    `${tab.rows} of ${inWin} rows in its window (${WORLD.rows.length} built) in ${pages.length} requests`);
  ok('…and lists what needs attention, worst first', tab.findings >= 5 && /hl-frow--critical/.test(tab.first), JSON.stringify(tab));
  ok('…and maps the stations', tab.markers >= 10, 'markers: ' + tab.markers);

  // A server whose schedule has stopped says so, rather than looking fresh.
  SERVER_AGO = 3 * 3600e3;
  await page.evaluate(() => Health.refresh());
  await until(page, () => /has not looked since/.test(document.getElementById('hl-status').textContent) && !Health.state().loading, null, 60_000)
    .catch(() => {});
  const late = await page.evaluate(() => document.getElementById('hl-status').textContent.replace(/\s+/g, ' '));
  ok('a server that has not looked for three hours is said to have stopped, and what that means',
    /The server has not looked since .+ — its every-fifteen-minutes check may have stopped, and nothing is being noticed while this tab is closed\./.test(late), late);
  SERVER_AGO = 6 * 60e3;

  // ── the Airtime panel ──────────────────────────────────────────────────────
  // The demo week plants one clash: steady2's check starts 0.9 s after the
  // partial station's battery frame, the frame that goes missing on a third of
  // its checks. The panel has to find that pair, say it hurts, and move the
  // one coming off worse. Any other clash has to be one the week really has:
  // the later stations' phases move with the window (roles.phases says so),
  // and two can land on one minute by chance — so every clash reported is
  // held to the phases the week was built with, and none may be missing.
  const air = await page.evaluate(W => {
    const R = HealthAirtime.state().R;
    const ids = [W.roles.partial, W.roles.steady2];
    const clash = R && R.clashes.find(c => ids.includes(c.a) && ids.includes(c.b));
    const moves = R ? R.suggestions.filter(s => s.kind === 'move-check') : [];
    const el = document.getElementById('hl-airtime');
    // The oracle: two roles whose checks were built within half a minute of
    // each other, every three hours, clash; any further apart do not.
    const P = 3 * 3600e3, idOf = r => W.roles[r];
    const roles = Object.keys(W.roles.phases).filter(r => idOf(r));
    const want = new Set();
    roles.forEach(a => roles.forEach(b => {
      if (a >= b) return;
      const d = ((W.roles.phases[a] - W.roles.phases[b]) % P + P) % P;
      if (Math.min(d, P - d) <= 30e3) want.add([idOf(a), idOf(b)].sort().join());
    }));
    const got = new Set(R ? R.clashes.map(c => [c.a, c.b].sort().join()) : []);
    const inClash = new Set(R ? R.clashes.flatMap(c => [c.a, c.b]) : []);
    return {
      clash: clash ? { hurts: clash.hurts, together: clash.together, damaged: clash.damaged, every: clash.everyMs / 3600e3 } : null,
      want: [...want].sort(), got: [...got].sort(),
      moves: moves.map(m => ({ id: m.stationId, sev: m.severity, toMs: m.evidence.toMs, clearMs: m.evidence.clearMs })),
      checks: R ? R.checks.length : 0,
      steadyClock: R ? R.checks.filter(c => c.behaviour === 'steady').length : 0,
      planted: R ? (R.pairs.find(p => [p.a, p.b].sort().join() === ids.slice().sort().join()) || { n: 0 }).n : 0,
      svg: !!(el && el.querySelector('svg.hl-air-svg rect.hl-air-bar--check')),
      rows: el ? el.querySelectorAll('.hl-airtable tbody tr').length : 0,
      ticks: el ? el.querySelectorAll('.hl-air-tick--clash').length : 0, inClash: inClash.size,
    };
  }, WORLD);
  ok('the Airtime panel finds the planted clash, every 3 hours, and that it hurts', air.clash && air.clash.hurts && air.clash.every === 3 && air.clash.together >= 40,
    JSON.stringify(air.clash));
  ok('…and every clash it reports is one the week was built with, and none is missing', air.want.join(' ') === air.got.join(' ') && air.want.length >= 1,
    JSON.stringify({ want: air.want, got: air.got }));
  const plantedMove = air.moves.find(m => m.id === WORLD.roles.partial);
  ok('…moves the station coming off worse, as a change to make, to somewhere clear by minutes',
    plantedMove && plantedMove.sev === 'warn' && plantedMove.clearMs >= 2 * 60e3 && !air.moves.some(m => m.id === WORLD.roles.steady2)
      && air.moves.length === air.got.length, JSON.stringify(air.moves));
  ok('…reads every station\'s check time, and the demo\'s clocks as kept', air.checks >= 10 && air.steadyClock === air.checks, `${air.steadyClock} of ${air.checks}`);
  // Seen together only when the partial station's battery frame arrived —
  // about two checks in three; the third time there was nothing to pile up
  // with, which is the collision's story too.
  ok('…counts the planted pair landing together whenever the frame they meet on arrived', air.planted >= 25 && air.planted <= 50, 'times: ' + air.planted);
  ok('…and draws it: the folded hour, a tick for each station in a clash, a suggestion for each move', air.svg && air.ticks === air.inClash && air.rows === air.moves.length,
    JSON.stringify(air));

  await page.evaluate(() => Health.setCat('power'));
  const power = await page.evaluate(() => [...document.querySelectorAll('.hl-ftable tbody tr .hl-fwhat b')].map(b => b.textContent));
  ok('a filter shows one kind of finding', power.length >= 2 && power.every(t => /batter/i.test(t)), JSON.stringify(power));
  await page.evaluate(() => Health.setCat('all'));

  // ── who owns each station, and the owner filter ────────────────────────────
  await until(page, () => SLS.loaded() && document.querySelector('#hl-ownpick-pop input[data-party]'), null);
  const own = await page.evaluate(async () => {
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const A = Health.state().A;
    const tally = new Map();
    A.stations.forEach(S => { const o = Health.owner(S.st); if (o) o.parties.forEach(p => tally.set(p, (tally.get(p) || 0) + 1)); });
    const pick = [...tally.entries()].sort((a, b) => b[1] - a[1]).find(([, n]) => n < A.stations.size);
    const before = {
      inHeader: !!document.querySelector('.panel-header .hl-tools #hl-ownpick summary'),
      options: [...document.querySelectorAll('#hl-ownpick-pop input[data-party]')].map(i => i.dataset.party),
      ownersShown: document.querySelectorAll('.hl-ftable .hl-fwhere .hl-owner').length,
      matrix: document.querySelectorAll('.hl-matrix tbody tr').length,
    };
    Health.setOwner(pick[0], true);
    await frame();
    const where = [...document.querySelectorAll('.hl-ftable .hl-fwhere')];
    const after = {
      pick: pick[0], n: pick[1],
      rows: where.length,
      rowsOwned: where.every(th => { const o = th.querySelector('.hl-owner'); return !!o && Health.owner({ owner: o.textContent }).parties.includes(pick[0]); }),
      heardKpi: document.querySelector('#hl-kpis .qs-chip-v').textContent,
      note: document.getElementById('hl-ownnote').textContent.replace(/\s+/g, ' '),
      summary: document.getElementById('hl-ownpick-sum').textContent,
      on: document.getElementById('hl-ownpick').classList.contains('hl-ownpick--on'),
      stored: localStorage.getItem('mn-hl-owners'),
    };
    const sid = [...A.stations.values()].find(S => { const o = Health.owner(S.st); return o && o.parties.includes(pick[0]); }).st.id;
    Health.select(sid);
    await frame();
    const fact = [...document.querySelectorAll('#hl-station .hl-facts div')].find(d => /Owner/.test(d.querySelector('dt').textContent));
    after.fact = fact ? fact.querySelector('dd').textContent.replace(/\s+/g, ' ') : null;
    Health.close();
    Health.clearOwners();
    await frame();
    after.cleared = { note: document.getElementById('hl-ownnote').textContent.trim(), stored: localStorage.getItem('mn-hl-owners'),
      heardKpi: document.querySelector('#hl-kpis .qs-chip-v').textContent };
    return { before, after, total: A.stations.size };
  });
  // The list open and stretched to reach down over the map, with something
  // in Leaflet's tile pane under it (the tiles themselves are not fetched
  // here): the list is on top.
  const over = await page.evaluate(async () => {
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const det = document.getElementById('hl-ownpick');
    const pop = document.getElementById('hl-ownpick-pop');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-5000px;top:-5000px;width:10000px;height:10000px;background:#888';
    document.querySelector('#hl-map .leaflet-tile-pane').appendChild(probe);
    det.open = true;
    pop.style.minHeight = '900px';
    await frame();
    const box = () => {
      const a = pop.getBoundingClientRect(), b = document.getElementById('hl-map').getBoundingClientRect();
      return { a, b, overlap: a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
        x: (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2, y: (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2 };
    };
    let o = box();
    if (o.overlap) { window.scrollBy(0, o.y - innerHeight / 2); await frame(); o = box(); }
    const el = o.overlap ? document.elementFromPoint(o.x, o.y) : null;
    const res = { overlap: o.overlap, top: el ? (el.closest('#hl-ownpick-pop') ? 'list' : el.closest('#hl-map') ? 'map' : el.tagName + '.' + el.className) : null };
    probe.remove();
    pop.style.minHeight = '';
    det.open = false;
    window.scrollTo(0, 0);
    return res;
  });
  ok('the owner list opens over the map, not under it', !over.overlap || over.top === 'list', JSON.stringify(over));
  ok('the station owner sits under the station\'s name in Needs attention and Check signals',
    own.before.ownersShown > 0 && own.before.options.length > 1, JSON.stringify(own.before).slice(0, 300));
  ok('an owner filter button sits in the header with Refresh and the rest', own.before.inHeader, JSON.stringify(own.before.inHeader));
  ok('…and picking an owner narrows the findings to that owner\'s stations, and says so',
    own.after.rows > 0 && own.after.rowsOwned && own.after.heardKpi === String(own.after.n) && own.after.on
      && own.after.note.includes(own.after.pick) && own.after.summary.includes(own.after.pick) && JSON.parse(own.after.stored)[0] === own.after.pick,
    JSON.stringify(own.after));
  ok('…the station opened says who owns it and where that came from', own.after.fact && own.after.fact.includes(own.after.pick) && /SLS|Service Level|recorded/.test(own.after.fact), own.after.fact);
  ok('…and All owners puts the whole network back', !own.after.cleared.note && own.after.cleared.stored === '[]' && own.after.cleared.heardKpi === own.total.toLocaleString(),
    JSON.stringify(own.after.cleared));

  const lens = await page.evaluate(async id => {
    Health.select(id);
    const S = Health.state().A.stations.get(id);
    const miss = S.slots.filter(sl => sl.outcome === 'miss').pop();
    Health.lensAt(id, miss.t, 'slot');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const box = document.getElementById('hl-lens');
    return { open: !!document.getElementById('hl-station') && /Silent|silent/.test(document.getElementById('hl-station').textContent),
      strip: !!document.querySelector('#hl-station svg rect[data-t]'), batt: !!document.querySelector('#hl-station svg path, #hl-station svg polyline'),
      lens: box ? box.textContent.replace(/\s+/g, ' ').slice(0, 400) : '' };
  }, WORLD.roles.silent);
  ok('a station opened shows its checks slot by slot and its battery', lens.open && lens.strip && lens.batt, JSON.stringify(lens).slice(0, 300));
  ok('a missed check put in context: what the receivers and the neighbours were doing then', /receiver/i.test(lens.lens) && /neighbour|nearby/i.test(lens.lens), lens.lens);

  // ── the door to the Reception Map ──────────────────────────────────────────
  await page.evaluate(() => { Health.close(); Health.setInfo(true); });
  await page.click('.hl-ftable button:has-text("Weigh the copies on the Reception Map")');
  await until(page, () => state.activeTab === 'reception' && document.querySelector('.rx-page'), null);
  const rx = await page.evaluate(id => {
    const a = Reception._state.last;
    const note = (document.getElementById('rx-rd-note') || {}).textContent || '';
    const st = state.data.stations.find(s => s.id === id);
    const badAt = a.bad.filter(b => b.event.station && b.event.station.id === id).length;
    return { note, receptions: a.receptions, bad: a.bad.length, badAt, name: st && st.name,
      table: [...document.querySelectorAll('.rx-page .table-wrap tbody tr')].length };
  }, WORLD.roles.corrupt);
  ok('the Reception Map is handed the same readings, and says where they came from',
    /Station Health/.test(rx.note) && rx.receptions >= WORLD.rows.filter(r => r.alert_id != null).length, JSON.stringify(rx));
  ok('…and finds the corrupted copies at the station they were planted at', rx.badAt >= 3 && rx.table > 0, JSON.stringify(rx));

  // ── Claude's briefing, with a scripted client ──────────────────────────────
  await page.evaluate(() => switchTab('health'));
  await until(page, () => document.getElementById('hl-agent'), null);
  const ag = await page.evaluate(async () => {
    const A = Health.state().A;
    const crit = A.findings.find(f => f.severity === 'critical' && f.stationId);
    const calls = [];
    const script = [
      { content: [{ type: 'tool_use', id: 't1', name: 'list_findings', input: { severity: 'critical' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'tool_use', id: 't2', name: 'station_detail', input: { station_id: crit.stationId } },
                  { type: 'tool_use', id: 't3', name: 'no_such_tool', input: {} }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: `## Headline\nOne station down.\n## Visit first\n1. [[${crit.stationId}]] — silent. Confidence: high\n## What I could not tell\n- why` }], stop_reason: 'end_turn' },
    ];
    let turn = 0;
    HealthAgent._useClient(() => ({ beta: { messages: { stream(params) {
      calls.push({ n: params.messages.length, tools: params.tools.map(t => t.name), last: params.messages[params.messages.length - 1] });
      const msg = Object.assign({ role: 'assistant', usage: { input_tokens: 1000, output_tokens: 100 } }, script[turn++]);
      const on = {};
      return { on(ev, cb) { on[ev] = cb; return this; }, abort() {},
        async finalMessage() { msg.content.forEach(b => { if (b.type === 'text' && on.text) on.text(b.text, b.text); }); return msg; } };
    } } } }));
    await HealthAgent.ask();
    const results = calls.slice(1).flatMap(c => (c.last.content || []).filter(b => b.type === 'tool_result'));
    const brief = document.querySelector('#hl-agent article.hl-brief');
    return {
      turns: calls.length, tools: calls[0] && calls[0].tools,
      answered: results.filter(r => !r.is_error).length, refused: results.filter(r => r.is_error).map(r => JSON.stringify(r.content)),
      link: brief ? !!brief.querySelector(`button[onclick*="${crit.stationId}"]`) : false,
      heading: brief ? [...brief.querySelectorAll('h4, h5')].map(h => h.textContent).join(' | ') : null,
    };
  });
  ok('the agent runs its tool loop to a briefing', ag.turns === 3 && ag.tools && ag.tools.includes('station_detail'), JSON.stringify(ag));
  ok('…answering each tool it asks for, and refusing one that does not exist, saying why', ag.answered === 2 && ag.refused.length === 1 && /No tool called no_such_tool/.test(ag.refused[0]), JSON.stringify(ag));
  ok('…and the briefing links the station it names', ag.link && /Headline/.test(ag.heading || ''), JSON.stringify(ag));

  // ── Another AI, from the briefing pack ─────────────────────────────────────
  // Anthropic out of reach: the status says so, and points to the pack.
  const blocked = await page.evaluate(async () => {
    HealthAgent._useClient(() => ({ beta: { messages: { stream() {
      return { on() { return this; }, abort() {},
        async finalMessage() { throw Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }); } };
    } } } }));
    await HealthAgent.ask();
    return document.getElementById('hl-agent-status').textContent.trim();
  });
  ok('Anthropic out of reach: the card says so, and points to the briefing pack', /Could not reach api\.anthropic\.com/.test(blocked)
    && /briefing pack under "With another AI"/.test(blocked), blocked);

  const pack = await page.evaluate(async () => {
    const A = Health.state().A;
    const want = [...new Set(A.findings.filter(f => f.severity !== 'info' && f.stationId).map(f => f.stationId))];
    const P = await HealthAgent._packText();
    const prompt = HealthAgent._packPrompt, sys = HealthAgent._system;
    const sections = s => s.split('\n\n').map(p => p.split('\n')[0]);
    return {
      stations: P.stations, want: Math.min(25, want.length), kb: Math.round(P.text.length / 1000),
      every: want.slice(0, 25).every(id => P.text.includes(`— [[${id}]]`)),
      detail: (P.text.match(/"last_site_visit"/g) || []).length, near: (P.text.match(/"nearby_within_30_km"/g) || []).length,
      promptIn: P.text.includes(prompt), sameSections: JSON.stringify(sections(prompt)) === JSON.stringify(sections(sys)),
      kept: prompt.split('\n\n').filter(p => sys.includes(p)).length, of: sys.split('\n\n').length,
      tools: HealthAgent._tools.map(t => t.name).filter(n => n.includes('_') && prompt.includes(n)),
      format: /## Visit first/.test(prompt) && /\[\[station_id\]\]/.test(prompt),
      overview: /## Overview\n\n```json\n\{"window"/.test(P.text), noKey: !/sk-ant-/.test(P.text),
    };
  });
  ok('the briefing pack holds each station with a warning or worse in full, with its last visit and its neighbours',
    pack.stations === pack.want && pack.stations > 3 && pack.every && pack.detail === pack.stations && pack.near === pack.stations, JSON.stringify(pack));
  ok('…its instructions Claude\'s own, the two paragraphs about tools swapped for what the file holds',
    pack.promptIn && pack.sameSections && pack.kept === pack.of - 2 && pack.tools.length === 0 && pack.format, JSON.stringify(pack));
  ok('…with the overview, and no key in it', pack.overview && pack.noKey, JSON.stringify(pack));

  const [packDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }).catch(() => null),
    page.click('#hl-pack-btn'),
  ]);
  let packBody = '';
  if (packDl) { const chunks = []; for await (const c of await packDl.createReadStream()) chunks.push(c); packBody = Buffer.concat(chunks).toString('utf8'); }
  await until(page, () => /^Downloaded/.test((document.getElementById('hl-pack-status') || {}).textContent || ''), null);
  const packSaid = await page.evaluate(() => document.getElementById('hl-pack-status').textContent.trim());
  ok('⤓ Download the briefing pack saves it as floodnet-health-briefing-pack-….txt, and says what it holds',
    !!packDl && /^floodnet-health-briefing-pack-\d{4}-\d\d-\d\d\.txt$/.test(packDl.suggestedFilename()) && /^# Flood-Net station health — briefing pack/.test(packBody)
      && new RegExp(`and ${pack.stations} stations in full`).test(packSaid), `${packDl && packDl.suggestedFilename()} — ${packSaid}`);

  // The other AI's answer pasted back: drawn as Claude's, its stations links.
  // What is pasted survives the card being drawn again before it is shown.
  await page.click('#hl-agent details.hl-paste summary');
  await page.fill('#hl-paste', `## Headline\nPasted from Copilot.\n## Visit first\n1. [[${WORLD.roles.falling}]] — battery sliding. Confidence: high`);
  await page.evaluate(() => { document.getElementById('hl-agent').innerHTML = HealthAgent.render(); });
  await page.click('#hl-agent button:has-text("Show it here")');
  const pasted = await page.evaluate(id => {
    const brief = document.querySelector('#hl-agent article.hl-brief');
    return { text: brief ? brief.textContent : '', link: brief ? !!brief.querySelector(`button[onclick*="${id}"]`) : false,
      meta: (document.querySelector('#hl-agent article.hl-brief .txt-muted') || {}).textContent || '',
      followUp: !!document.getElementById('hl-q'), box: (document.getElementById('hl-paste') || {}).value };
  }, WORLD.roles.falling);
  ok('another AI\'s answer pasted back is shown as the briefing, its station a link, and said to be pasted', /Pasted from Copilot/.test(pasted.text)
    && pasted.link && /pasted from another AI/.test(pasted.meta) && !pasted.followUp && pasted.box === '', JSON.stringify(pasted));

  // ── Flood-Net's key (#229): an editor with no key of their own ─────────────
  // The route (worker/briefing.js) is stood in for at its two paths, answering
  // as it answers — `npm run briefing` holds the Worker itself, with the real
  // SDK. The session is a signed-in editor's, adopted the way auth.js adopts
  // one, with the database's whoami stood in for. The stand-in client is handed
  // the options the SDK would get, and on the route sends its call through
  // them, as the SDK does.
  const WHO = { signed_in: true, email: 'editor@bom.gov.au', role: 'editor', may_write: true, is_admin: false, schema_version: '57' };
  const SPENT = { ok: true, model: 'claude-opus-5-5', email: WHO.email, role: 'editor', day: '2026-10-07', limit_usd: 20, spent_usd: 3.2,
    held_usd: 0, left_usd: 16.8, calls: 4, resets_at: '2026-10-07T14:00:00.000Z', calls_per_minute: 20 };
  const DAY_SPENT = { type: 'error', error: { type: 'daily_limit', message: 'x' }, code: 'daily_limit',
    message: 'Flood-Net\'s Anthropic allowance for today (US$20.00) is spent — it starts again at midnight, Brisbane time. Your own key works meanwhile.' };
  let routeDay = 'open';
  const looked = [], sent = [];
  // The first answer is held back until the check has looked at the panel
  // while it waits.
  let answerFirst;
  const firstHeld = new Promise(r => { answerFirst = r; });
  await page.route('**/rest/v1/rpc/whoami', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WHO) }));
  await page.route(u => new URL(u).pathname === '/api/briefing', async route => {
    looked.push(route.request().headers().authorization || '');
    if (looked.length === 1) await firstHeld;
    return route.fulfill(routeDay === 'open'
      ? { status: 200, contentType: 'application/json', body: JSON.stringify(SPENT) }
      : { status: 429, contentType: 'application/json', body: JSON.stringify(DAY_SPENT) });
  });
  await page.route(u => new URL(u).pathname === '/api/briefing/v1/messages', route => {
    const req = route.request();
    sent.push({ url: req.url(), headers: req.headers(), body: req.postData() });
    return route.fulfill(routeDay === 'open'
      ? { status: 200, contentType: 'application/json', body: JSON.stringify({ role: 'assistant', stop_reason: 'end_turn',
          content: [{ type: 'text', text: '## Headline\nWritten on Flood-Net\'s key.' }], usage: { input_tokens: 1200, output_tokens: 300 } }) }
      : { status: 429, contentType: 'application/json', body: JSON.stringify(DAY_SPENT) });
  });

  await page.evaluate(() => {
    window.__made = [];
    window.__said = [];
    const said = window.announce;
    window.announce = m => { window.__said.push(m); said(m); };
    HealthAgent._useClient((mode, opts) => {
      window.__made.push({ mode, baseURL: opts.baseURL || null, apiKey: opts.apiKey === undefined ? 'unset' : opts.apiKey,
        authToken: opts.authToken || null, fetch: typeof opts.fetch });
      return { beta: { messages: { stream(params) {
        const on = {};
        const run = (async () => {
          if (mode !== 'route') {
            return { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '## Headline\nWritten on your own key.' }],
              usage: { input_tokens: 10, output_tokens: 5 } };
          }
          // What the SDK does with a request: betas to a header, stream on,
          // the rest the body — and here a stale bearer and a key planted in
          // the headers, which the page's fetch must replace and drop.
          const { betas, ...body } = params;
          const res = await opts.fetch(`${opts.baseURL}/v1/messages?beta=true`, { method: 'POST',
            headers: { 'content-type': 'application/json', 'anthropic-beta': betas.join(','), authorization: 'Bearer stale', 'x-api-key': 'sk-must-not-leave' },
            body: JSON.stringify(Object.assign(body, { stream: true })) });
          const json = await res.json();
          if (!res.ok) throw Object.assign(new Error(`${res.status} ${json.message}`), { status: res.status, error: json });
          return json;
        })();
        return { on(ev, cb) { on[ev] = cb; return this; }, abort() {},
          async finalMessage() { const m = await run; m.content.forEach(b => { if (b.type === 'text' && on.text) on.text(b.text, b.text); }); return m; } };
      } } } };
    });
    localStorage.setItem('meganet.session', JSON.stringify({ access_token: 'editor-session-token', refresh_token: 'r',
      expires_at: Date.now() + 3600 * 1000, email: 'editor@bom.gov.au' }));
    Auth.start();
  });
  await until(page, () => Auth.role() === 'editor' && /Asking whether Flood-Net's key is on offer/.test((document.querySelector('#hl-agent .hl-agent-key') || {}).textContent || ''), null);
  const waiting = await page.evaluate(() => ({ remember: !!document.getElementById('hl-key-mine'),
    enabled: !![...document.querySelectorAll('#hl-agent button')].find(b => /Write the briefing/.test(b.textContent) && !b.disabled) }));
  ok('while the route has yet to answer an editor: no box to remember a key, and nothing to press yet', !waiting.remember && !waiting.enabled, JSON.stringify(waiting));
  answerFirst();
  await until(page, () => /Flood-Net's Anthropic key/.test((document.querySelector('#hl-agent .hl-agent-key') || {}).textContent || ''), null);
  const onKey = await page.evaluate(() => {
    const box = document.querySelector('#hl-agent .hl-agent-key');
    const field = document.getElementById('hl-key');
    const btn = [...document.querySelectorAll('#hl-agent button')].find(b => /Write the briefing/.test(b.textContent));
    return { text: box.textContent.replace(/\s+/g, ' ').trim(), fieldHidden: !!field && !!field.closest('details') && !field.closest('details').open,
      remember: !!document.getElementById('hl-key-mine'), enabled: !!btn && !btn.disabled, said: window.__said.slice() };
  });
  ok('a signed-in editor is offered Flood-Net\'s key, with today\'s spend, and asked for no key', /no key of your own is needed/.test(onKey.text)
    && /US\$3\.20 of US\$20\.00/.test(onKey.text) && onKey.fieldHidden && onKey.enabled, JSON.stringify(onKey));
  ok('…the route asked with the session, not a key', looked.length === 1 && looked[0] === 'Bearer editor-session-token', JSON.stringify(looked));
  ok('…no box to remember a key is offered where Flood-Net\'s is', !onKey.remember);
  ok('…and asking was not announced — nobody asked for it', onKey.said.length === 0, JSON.stringify(onKey.said));

  await page.click('#hl-agent button:has-text("Write the briefing")');
  await until(page, () => /Written on Flood-Net's key/.test((document.querySelector('#hl-agent article.hl-brief') || {}).textContent || ''), null);
  const brief = await page.evaluate(() => ({ made: window.__made.slice(), said: window.__said.slice(),
    meta: (document.querySelector('#hl-agent article.hl-brief .txt-muted') || {}).textContent || '',
    stored: localStorage.getItem('mn-hl-anthropic-key') }));
  const m0 = brief.made[0] || {};
  const call0 = sent[0] || { headers: {} };
  ok('the briefing ran on the route: the Worker for a base URL, the session for a token, no key', m0.mode === 'route'
    && m0.baseURL === `${server.origin}/api/briefing` && m0.apiKey === null && m0.authToken === 'editor-session-token' && m0.fetch === 'function', JSON.stringify(m0));
  ok('…its call carried the session as it is now, and the key planted in it never left the page', /\/api\/briefing\/v1\/messages\?beta=true$/.test(call0.url)
    && call0.headers.authorization === 'Bearer editor-session-token' && !('x-api-key' in call0.headers), JSON.stringify(call0.headers));
  const why = call0.body ? requestProblem(JSON.parse(call0.body)) : 'nothing sent';
  ok('…and is a request the Worker accepts as a briefing\'s', why === null, JSON.stringify(why));
  ok('…the briefing says whose key it ran on, and the page stored no key', /on Flood-Net's key/.test(brief.meta) && brief.stored === null, JSON.stringify(brief));
  ok('…the briefing was announced, as a result of pressing the button', brief.said.length === 1 && /briefing is ready/.test(brief.said[0]), JSON.stringify(brief.said));
  ok('…and today\'s spend was asked again after it', await settles(() => looked.length === 2), `${looked.length}`);

  // The day spent: the route refuses, and the panel turns to the person's own key.
  routeDay = 'spent';
  await page.click('#hl-agent button:has-text("Write the briefing")');
  await until(page, () => /allowance for today/.test((document.getElementById('hl-agent-status') || {}).textContent || ''), null);
  const spent = await page.evaluate(() => {
    const field = document.getElementById('hl-key');
    return { status: document.getElementById('hl-agent-status').textContent.trim(),
      box: document.querySelector('#hl-agent .hl-agent-key').textContent.replace(/\s+/g, ' ').trim(),
      fieldShown: !!field && !field.closest('details'), remember: !!document.getElementById('hl-key-mine') };
  });
  ok('the day spent: the panel says so, and why, and offers the person\'s own key', /starts again at midnight, Brisbane time/.test(spent.status)
    && /Your own key works meanwhile/.test(spent.box) && !/allowance for today/.test(spent.box) && spent.fieldShown, JSON.stringify(spent));
  ok('…without the box that remembers it: tomorrow Flood-Net\'s key is back', !spent.remember);

  await page.fill('#hl-key', 'sk-ant-test-own-1234');
  await page.click('#hl-agent button:has-text("Use this key")');
  const before = sent.length;
  await page.click('#hl-agent button:has-text("Write the briefing")');
  await until(page, () => /Written on your own key/.test((document.querySelector('#hl-agent article.hl-brief') || {}).textContent || ''), null);
  const ownKey = await page.evaluate(() => ({ made: window.__made[window.__made.length - 1], box: document.querySelector('#hl-agent .hl-agent-key').textContent.replace(/\s+/g, ' ').trim(),
    stored: localStorage.getItem('mn-hl-anthropic-key') }));
  ok('the fallback: the person\'s own key, for this visit only, and nothing through the route', ownKey.made.mode === 'own' && ownKey.made.apiKey === 'sk-ant-test-own-1234'
    && ownKey.made.baseURL === null && sent.length === before && /ending …1234, for this visit only/.test(ownKey.box) && ownKey.stored === null, JSON.stringify(ownKey));

  // A viewer: signed in, allowed to write, and still not somebody the route
  // serves — so it is not even asked.
  WHO.role = 'viewer';
  routeDay = 'open';
  await page.evaluate(() => { HealthAgent.forget(); Auth.start(); });
  // Whichever the panel settles on: the person's own key, or (wrongly) the
  // route's answer — anything but still asking.
  await until(page, () => Auth.role() === 'viewer' && (!!document.getElementById('hl-key-mine')
    || /Flood-Net's Anthropic key|allowance for today/.test((document.querySelector('#hl-agent .hl-agent-key') || {}).textContent || '')), null);
  const viewer = await page.evaluate(() => document.querySelector('#hl-agent .hl-agent-key').textContent.replace(/\s+/g, ' ').trim());
  ok('a viewer is offered the person\'s own key, and the route is not asked', /Editors and administrators signed in/.test(viewer) && looked.length === 2,
    `${looked.length} — ${viewer.slice(0, 120)}`);
  WHO.role = 'editor';

  // Signed out: nobody the route serves. The own key, and only here the box.
  await page.evaluate(async () => { HealthAgent.forget(); await Auth.signOut({ announce: false, suppressGate: false }); });
  await until(page, () => !Auth.isSignedIn() && !!document.getElementById('hl-key-mine'), null);
  const out = await page.evaluate(() => ({ box: document.querySelector('#hl-agent .hl-agent-key').textContent.replace(/\s+/g, ' ').trim(),
    ticked: document.getElementById('hl-key-mine').checked }));
  ok('signed out: the person\'s own key, a word on who gets Flood-Net\'s, and a box to remember it — about the device, unticked',
    /Editors and administrators signed in at floodwarning\.net/.test(out.box) && /This is my own device/.test(out.box) && out.ticked === false
      && looked.length === 2, JSON.stringify(out));
  const kept = await page.evaluate(() => {
    document.getElementById('hl-key').value = 'sk-ant-test-mine-5678';
    HealthAgent.setKey();
    const unticked = localStorage.getItem('mn-hl-anthropic-key');
    HealthAgent.forget();
    document.getElementById('hl-key').value = 'sk-ant-test-mine-5678';
    document.getElementById('hl-key-mine').checked = true;
    HealthAgent.setKey();
    const ticked = localStorage.getItem('mn-hl-anthropic-key');
    HealthAgent.forget();
    return { unticked, ticked, after: localStorage.getItem('mn-hl-anthropic-key') };
  });
  ok('…a key is remembered only when the box is ticked, and forgotten with it', kept.unticked === null && kept.ticked === 'sk-ant-test-mine-5678'
    && kept.after === null, JSON.stringify(kept));

  // ── narrow ─────────────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(300);
  const narrow = await page.evaluate(async id => {
    Health.select(id);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const d = document.documentElement;
    return { scroll: d.scrollWidth, client: d.clientWidth };
  }, WORLD.roles.falling);
  ok('no sideways scroll at 375 px, a station open', narrow.scroll <= narrow.client + 1, JSON.stringify(narrow));

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

if (failures) { console.log(`\nFAIL — ${failures} check(s) failed.`); process.exit(1); }
console.log('PASS — Station Health finds every fault planted in its demo week where it was planted, keeps its rules, and carries its readings to the Reception Map.');
