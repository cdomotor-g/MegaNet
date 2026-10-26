// The Signal Routes tab (signal-routes.js), driven in Chromium. The receptions
// are stood in for by a fixture built on the real station file — a repeater
// whose pass ranges are the only ones to hold eight stations' addresses, so
// its carrier is found and nothing else's is:
//
//   1. **Signed out** — the tab says the receptions are for editors, offers the
//      demo, and asks the database nothing.
//   2. **The demo** — every panel drawn from made-up receptions: the flow, the
//      map, a repeater found on its carrier, and the iFLOWS test rig named.
//   3. **Read, signed in** — the receptions asked for in six-hour chunks and
//      paged; legacy ALERT only, ALERT2 from the rollups and a twelve-hour
//      sample; the eight stations put down to the repeater's carrier, one in
//      its range only ever heard direct, one relayed though no range on record
//      holds it (its copies give it away), four copies gathered on a carrier
//      nobody was found on, one Enhanced iFLOWS frame, and the stations that
//      arrive both ways.
//   4. **Picking** — a chip, a node of the drawing and a repeater in Pass
//      ranges each narrow what is shown, and pressed again let go.
//   5. **ALERT2** — the drawing by path.
//   6. **The exports** — floodnet-named CSVs of the routes and the pass ranges.
//   7. **A phone** — nothing wider than a 375 px screen.
//
// Run:  npm run signalroutes

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

// PostgREST, stood in for: each relation answers its rows, filtered by the
// query's protocol and heard_at range and paged by limit and offset, so the
// tab's chunking and paging are what is exercised.
let FIX = null;
const asked = [];
async function standIn(page) {
  await page.route(u => /\/rest\/v1\/(reception|reception_daily|ingest_point_latest)$/.test(u.pathname), route => {
    const url = new URL(route.request().url());
    const rel = url.pathname.split('/').pop();
    asked.push(rel + url.search);
    const q = url.searchParams;
    let rows = rel === 'ingest_point_latest' ? FIX.points : rel === 'reception_daily' ? FIX.a2daily
      : q.get('protocol') === 'eq.alert2' ? FIX.a2conc : FIX.legacy;
    const heard = q.getAll('heard_at');
    const gte = heard.find(h => h.startsWith('gte.')), lt = heard.find(h => h.startsWith('lt.'));
    if (gte) rows = rows.filter(r => r.heard_at >= new Date(gte.slice(4)).toISOString());
    if (lt) rows = rows.filter(r => r.heard_at < new Date(lt.slice(3)).toISOString());
    const off = Number(q.get('offset') || 0), lim = Number(q.get('limit') || 1000);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows.slice(off, off + lim)) });
  });
}

// Built in the page, on the file it loaded: a repeater with nine addresses no
// other repeater passes (eight relayed, one heard only direct), an address no
// repeater passes for the off-record relay, and four more for the copies on a
// carrier nobody is found on.
function buildFixture() {
  const reps = repeaterList(state.data.stations);
  const passers = a => reps.filter(r => passRangeCoversId(r.repeater, a) || stationAlertIds(r).includes(a));
  const field = state.data.stations.filter(s => (s.roles || []).includes('field') && !(s.roles || []).includes('repeater') && stationAlertIds(s).length);
  let R = null, mine = [];
  for (const r of reps) {
    const only = [];
    for (const s of field) {
      const a = stationAlertIds(s).find(x => { const p = passers(x); return p.length === 1 && p[0].id === r.id; });
      if (a != null && stationAlertIds(s).every(x => passers(x).every(p => p.id === r.id))) only.push({ s, a });
      if (only.length >= 9) break;
    }
    if (only.length >= 9) { R = r; mine = only; break; }
  }
  const free = field.map(s => ({ s, a: stationAlertIds(s)[0] }))
    .filter(x => stationAlertIds(x.s).every(a => !passers(a).length) && !mine.some(m => m.s.id === x.s.id)).slice(0, 7);
  const now = Date.now(), day0 = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  let i = 0;
  const at = () => new Date(Math.min(now - 1000, day0 + 60_000 + (i++) * 7_000)).toISOString();
  const legacy = [];
  const b = (pt, a, cfo, o) => legacy.push({ heard_at: at(), point_id: pt, alert_id: a, ok: true, fault: null, fmt: 'ABF', cfo_hz: cfo, a2_duplicate: false, freq_mhz: 151.525, ...o });
  const P1 = 'rpi-test-sdr1-151.525', P2 = 'rpi-test-sdr2-152.400', P3 = 'rpi-test-sdr2-151.5375';
  mine.slice(0, 8).forEach((m, k) => { for (let j = 0; j < 5; j++) b(P1, m.a, 300 + ((j + k) % 5) * 2 - 4); });
  for (let j = 0; j < 5; j++) b(P1, mine[8].a, -200 + j);                                   // in its range, heard direct
  const off = free[0];
  for (let j = 0; j < 4; j++) { b(P1, off.a, 520 + j); b(P1, off.a, 301 + j, { a2_duplicate: true }); }  // relayed, off its record
  free.slice(1, 5).forEach(x => { for (let j = 0; j < 2; j++) b(P1, x.a, -640 + j * 3, { a2_duplicate: true }); });  // a carrier nobody is found on
  b(P1, mine[0].a, null);                                                                    // no carrier measured
  b(P2, 4078, 120, { fmt: 'EIF', freq_mhz: 152.4 });                                         // an Enhanced iFLOWS frame
  for (let j = 0; j < 2; j++) legacy.push({ heard_at: at(), point_id: P1, alert_id: null, ok: false, fault: 'undecoded', fmt: 'ABF', cfo_hz: null, a2_duplicate: false, freq_mhz: 151.525 });
  legacy.sort((x, y) => x.heard_at.localeCompare(y.heard_at));
  const bucket = new Date(day0).toISOString().slice(0, 10);
  const a2daily = [{ bucket, point_id: P3, station: 11762, path: [11056, 10019], n: 50, n_ok: 48, n_dup: 10, freq_min: 151.5375 }];
  const a2conc = [mine[0].a, mine[1].a, mine[2].a, free[5].a, free[6].a].map(a => ({ heard_at: new Date(now - 60_000).toISOString(), point_id: P3, alert_id: a, a2_source: 11762, a2_path: [11056, 10019] }));
  const points = [P1, P2, P3].map(p => ({ ingest_token_id: 1, token_label: 'Test base', point_id: p, name: `Test base — RTL-SDR · ${p.split('-').pop()}`, receiver: 'rtl-sdr', host_station_id: null }));
  return { R: { id: R.id, name: R.name }, mine: mine.map(m => ({ a: m.a, name: m.s.name })), off: { a: off.a, name: off.s.name }, free: free.map(x => x.a),
    legacy, a2daily, a2conc, points };
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Australia/Brisbane', acceptDownloads: true });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await standIn(page);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await until(page, () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, LOAD_TIMEOUT);
  FIX = await page.evaluate(buildFixture);
  ok('the fixture found a repeater with nine addresses of its own', !!FIX.R && FIX.mine.length === 9 && FIX.free.length === 7, JSON.stringify(FIX.R));

  // ── 1. signed out ─────────────────────────────────────────────────────────
  await page.evaluate(() => switchTab('signalroutes'));
  await until(page, () => !!document.querySelector('.sr-page'));
  const out = await page.evaluate(() => document.getElementById('main-content').textContent.replace(/\s+/g, ' '));
  ok('signed out, it says the receptions are for editors and offers the demo', /for editors/.test(out) && /Show a demo/.test(out), out.slice(0, 300));
  ok('…and asks the database nothing', asked.length === 0, asked.join(' '));

  // ── 2. the demo ───────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Show a demo' }).click();
  await until(page, () => !!document.querySelector('.sr-flow'));
  const demo = await page.evaluate(() => {
    const A = SignalRoutes.state().A;
    return { reps: A.reps.length, nodes: document.querySelectorAll('.sr-flow .sr-node').length, links: document.querySelectorAll('.sr-flow .sr-link').length,
      lines: document.querySelectorAll('#sr-map path.leaflet-interactive').length, proto: document.querySelector('#sr-h-proto').closest('.panel').textContent.replace(/\s+/g, ' '),
      label: document.querySelector('.sr-flow').getAttribute('aria-label') || '', demo: /Demo — made-up receptions/.test(document.getElementById('main-content').textContent) };
  });
  ok('the demo draws the flow, the map and a repeater found on its carrier', demo.demo && demo.reps >= 1 && demo.nodes >= 6 && demo.links >= 6 && demo.lines >= 4, JSON.stringify({ ...demo, proto: undefined }));
  ok('…its drawing named with the headline numbers', /Legacy ALERT routes: [\d,]+ bursts from \d+ stations/.test(demo.label), demo.label);
  ok('…and the iFLOWS test rig named in Protocols', /12 legacy frames decoded as Enhanced iFLOWS/.test(demo.proto), demo.proto.slice(0, 300));
  ok('the demo asked the database nothing', asked.length === 0, asked.join(' '));

  // ── 3. read, signed in ────────────────────────────────────────────────────
  await page.evaluate(() => SignalRoutes.setDays(1));
  ok('signed out, a period picked over the demo asks nothing', asked.length === 0 && await page.evaluate(() => SignalRoutes.state().demo), asked.join(' '));
  await page.evaluate(() => { Auth.isSignedIn = () => true; SignalRoutes.authChanged(); });
  await until(page, () => SignalRoutes.state().phase === 'ready' && !SignalRoutes.state().demo);
  const legacyAsks = asked.filter(a => a.startsWith('reception?') && /protocol=eq\.alert(&|$)/.test(a));
  const concAsks = asked.filter(a => a.startsWith('reception?') && /protocol=eq\.alert2/.test(a));
  ok('legacy receptions asked for in six-hour chunks, each with its range, newest data included', legacyAsks.length >= 1 && legacyAsks.length <= 4
    && legacyAsks.every(a => /heard_at=gte\./.test(a) && /heard_at=lt\./.test(a) && /order=heard_at\.asc,id\.asc/.test(a) && /select=heard_at,point_id,alert_id,ok,fault,fmt,cfo_hz,a2_duplicate,freq_mhz/.test(a)),
    legacyAsks.join('\n         '));
  ok('ALERT2 from the rollups and a twelve-hour sample of its PDUs, originals only', asked.some(a => a.startsWith('reception_daily?') && /protocol=eq\.alert2/.test(a))
    && concAsks.length >= 1 && concAsks.every(a => /a2_duplicate=not\.is\.true/.test(a) && /alert_id=not\.is\.null/.test(a)), concAsks.join(' '));
  const R = await page.evaluate(F => {
    const A = SignalRoutes.state().A;
    const r = A.reps.find(x => x.rid === F.R.id);
    return { reps: A.reps.map(x => x.rid), confirmed: r ? [...r.confirmed.keys()].sort((a, b) => a - b) : [], elsewhere: r ? [...r.elsewhere.keys()] : [],
      offrec: r ? r.offrec.map(o => [o.a, o.evidence, o.dup]) : [], relays: A.relays.map(m => ({ addrs: [...m.addrs.keys()].sort((a, b) => a - b), likely: m.likely && m.likely.rid, centre: Math.round(m.centre) })),
      how: A.legacy.how, eif: A.legacy.fmts.EIF || 0, mix: A.mix, bad: A.legacy.bad };
  }, FIX);
  ok('the repeater\'s carrier found, and nothing else\'s', R.reps.length === 1 && R.reps[0] === FIX.R.id, JSON.stringify(R.reps));
  ok('…the eight stations it relays put down to it', JSON.stringify(R.confirmed) === JSON.stringify(FIX.mine.slice(0, 8).map(m => m.a).sort((a, b) => a - b)), JSON.stringify(R.confirmed));
  ok('…the one in its range heard only direct is "heard another way"', JSON.stringify(R.elsewhere) === JSON.stringify([FIX.mine[8].a]), JSON.stringify(R.elsewhere));
  ok('…the one whose copies sit on its carrier, in no range of its, is off its record with copies', JSON.stringify(R.offrec) === JSON.stringify([[FIX.off.a, 'copies', 4]]), JSON.stringify(R.offrec));
  ok('four copies on a carrier nobody was found on are one relay, with no repeater to name', R.relays.length === 1
    && JSON.stringify(R.relays[0].addrs) === JSON.stringify(FIX.free.slice(1, 5).slice().sort((a, b) => a - b)) && R.relays[0].likely === null && Math.abs(R.relays[0].centre + 638.5) <= 1,
    JSON.stringify(R.relays));
  // own: the five heard direct, the off-record station's four and the iFLOWS frame.
  ok('the burst with no carrier is "not measured", the failures counted', R.how.unmeasured === 1 && R.bad === 2 && R.how.repeater === 40 && R.how.own === 10
    && R.how.unexplained === 12, JSON.stringify(R.how));
  ok('one Enhanced iFLOWS frame, and three stations both ways, two on ALERT2 only', R.eif === 1 && R.mix.both === 3 && R.mix.a2Only === 2, JSON.stringify({ eif: R.eif, mix: R.mix }));
  const text = await page.evaluate(() => document.getElementById('main-content').textContent.replace(/\s+/g, ' '));
  ok('the lead says it: relayed outside its ranges, heard another way, a relay nobody explains',
    /1 address relayed by a repeater whose ranges do not include it/.test(text) && /1 address in a found repeater's range was only ever heard another way/.test(text) && /1 relay no repeater on record explains/.test(text), text.slice(0, 900));
  ok('Protocols names the iFLOWS frame and its receiver', /1 legacy frame decoded as Enhanced iFLOWS, on Test base — RTL-SDR · 152\.400/.test(text), text.match(/Enhanced iFLOWS[^.]*\./)?.[0] || '');
  const ruler = await page.evaluate(F => {
    const fig = [...document.querySelectorAll('.sr-ruler')].find(f => f.textContent.includes(F.R.name));
    return fig ? { bands: fig.querySelectorAll('rect.sr-c-range').length, relay: fig.querySelectorAll('line.sr-c-relay').length, els: fig.querySelectorAll('line.sr-c-elsewhere').length,
      off: fig.querySelectorAll('line.sr-c-unexplained').length, label: fig.querySelector('svg').getAttribute('aria-label') } : null;
  }, FIX);
  ok('its address space drawn: its ranges, eight on its carrier, one heard another way, one off its record', ruler && ruler.bands >= 1 && ruler.relay === 8 && ruler.els === 1 && ruler.off === 1, JSON.stringify(ruler));

  // ── 4. picking ────────────────────────────────────────────────────────────
  await page.locator('.sr-chips button', { hasText: FIX.R.name }).first().click();
  await until(page, () => !!SignalRoutes.state().pick);
  const picked = await page.evaluate(F => ({
    pick: SignalRoutes.state().pick, rows: document.querySelectorAll('.sr-routes tbody tr').length, faded: document.querySelectorAll('.sr-flow .sr-link.is-faded').length,
    pressed: [...document.querySelectorAll('.sr-chips button')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent.trim()),
    rep: SignalRoutes.state().rep, detail: !!document.querySelector('.sr-detail') }), FIX);
  ok('a chip picks the repeater: its eight stations listed, the rest of the drawing faded', picked.pick && picked.pick.id === 'rep:' + FIX.R.id && picked.rows === 8 && picked.faded > 0
    && picked.pressed.length === 1, JSON.stringify(picked));
  ok('…and Pass ranges opens on it', picked.rep === FIX.R.id && picked.detail, JSON.stringify(picked));
  await page.locator('.sr-chips button', { hasText: FIX.R.name }).first().click();
  ok('pressed again, let go', await page.evaluate(() => SignalRoutes.state().pick === null));
  await page.evaluate(() => { const n = SignalRoutes.state(); return n; });
  await page.locator('.sr-flow .sr-node', { hasText: 'Direct' }).first().dispatchEvent('click');
  ok('a node of the drawing picks what it stands for', await page.evaluate(() => (SignalRoutes.state().pick || {}).id === 'own'));
  await page.evaluate(() => SignalRoutes.pick(null));

  // ── 5. ALERT2 ─────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'ALERT2 — by path' }).click();
  await until(page, () => SignalRoutes.state().mode === 'alert2');
  const a2 = await page.evaluate(() => ({ label: document.querySelector('.sr-flow').getAttribute('aria-label'), nodes: [...document.querySelectorAll('.sr-flow .sr-node')].map(n => n.textContent.replace(/\s+/g, ' ').trim()) }));
  ok('ALERT2 drawn by path: the source, its two hops, the receiver', /ALERT2 routes: 48 records/.test(a2.label) && a2.nodes.some(n => /ALERT2 11762/.test(n)) && a2.nodes.some(n => /via 11056 → 10019/.test(n)), JSON.stringify(a2));
  await page.getByRole('button', { name: 'Legacy ALERT — by carrier' }).click();

  // ── 6. the exports ────────────────────────────────────────────────────────
  for (const [fn, name, head] of [['exportRoutesCsv', 'floodnet-signal-routes-1d.csv', 'protocol,station,station_id,address,came_in'],
    ['exportPassCsv', 'floodnet-signal-routes-pass-ranges-1d.csv', 'repeater,repeater_id,pass_ranges,carrier_hz']]) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(f => SignalRoutes[f](), fn)]);
    const body = await (await dl.createReadStream()).toArray().then(b => Buffer.concat(b).toString());
    ok(`${fn} downloads ${name}`, dl.suggestedFilename() === name && body.startsWith(head) && body.trim().split('\n').length >= 4, `${dl.suggestedFilename()} ${body.slice(0, 160)}`);
  }
  const offers = await page.evaluate(() => ExportMenu.offers('signalroutes').map(o => ({ label: o.label, why: o.why })));
  ok('📤 Export offers both, ready', offers.length === 2 && offers.every(o => !o.why), JSON.stringify(offers));

  // ── 7. a phone ────────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  ok('nothing wider than a 375 px phone', wide <= 376, String(wide));
  await context.close();

  ok('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`  FAIL ${e.stack || e}`);
}
await browser.close();
await server.close();
if (failures) { console.log(`\nFAIL — ${failures} check(s) failed.`); process.exit(1); }
console.log('\nPASS — the Signal Routes tab.');
