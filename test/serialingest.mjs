// A Serial Monitor receiver as a base station (serial-ingest.js, 0045): what
// the Quansheng and ERT-A2 cards post into MegaNet, and what they never post.
//
// The database is stood in for by two routes — /rpc/ingest_http and
// /rpc/report_ingest_point — which record every request and answer as the
// real functions do (tools/check_ingest_points.sql holds the real functions to
// the same contract against Postgres). Readings come in the way an operator's
// would: a log file dropped through CDP and grown on disk.
//
//   * the receiver describes itself: its own id, its name, what it is, and a
//     location stated as approximate with no GPS — typed in, from a station,
//     and from the browser's geolocation
//   * a live reading goes with source serial, the card's protocol, the
//     receiver's path, and the time it arrived
//   * out of a followed log's history, a reading goes only with its own time:
//     the radio's clock, or the ERT-A2 frame's time of day on the receiver's
//     date — one with neither is counted and skipped, never stamped "now"
//   * the same receiver keeps its id across cards, and sending resumes
//   * a refused token stops sending, says so, and keeps what was waiting
//   * a demo card never sends
//   * the token travels in X-Ingest-Token, never in Authorization
//   * the Admin tab's token panel (0046): mint, shown once, "Use in this
//     browser", listed, revoked after asking
//   * asking an administrator for the token (0048), from a card: a token the
//     browser made, asked with in X-Ingest-Token, kept only once approved —
//     and the card that asked then sends by itself; Stop asking withdraws it
//   * the other side, on the Admin tab: a request appearing by itself within a
//     poll, the code to check, a taken name offered as a replacement (and not
//     sent until that is ticked), approve and deny, and the Pi's QR link
//     (#pair=CODE) opening that request — before sign-in and after
//
// Run:  npm run serialingest
//       npm run serialingest -- -v    also print what passed

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const WAIT = 12_000;

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ingest-'));
const file = name => path.join(DIR, name);
const HDR = [
  'HDR,fw,4d06107f,schema,2',
  'HDR,DEC,seq,epoch,uptime_ms,boot,id,name,kind,value,eng,unit,fmt,pol,inv,frame,rssi,nf,sens,fade,burst_ms,payload_hex,payload_bin',
];
const now = () => Math.floor(Date.now() / 1000);
const dec = (seq, epoch, id, value) =>
  `DEC,${seq},${epoch == null ? '' : epoch},${187340 + seq},12,${id},MARBURG,BATT,${value},${value / 10},V,ABF,STD,1,0,-20,-121,-109,89,412,16067B23,00010110000001100111101100100011`;
const ERT = [
  'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00',
  'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,28,32.582,0,0,0,0,0,1,0,0,0,7,11,9999,74,69,20,2D,13,8A,00,2C,13,0C,00',
];

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];
const posts = [], reports = [];
let answer = 200;

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -27.4698, longitude: 153.0251, accuracy: 1500 });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await page.route('**/rest/v1/rpc/ingest_http', async route => {
    const req = route.request();
    const body = JSON.parse(req.postData() || '{}');
    posts.push({ headers: req.headers(), body });
    if (answer !== 200) return route.fulfill({ status: answer, contentType: 'application/json', body: JSON.stringify({ message: 'invalid or revoked ingest token' }) });
    const n = (body.payload && body.payload.readings || []).length;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: n, duplicates: 0, rejected: [], raw_id: posts.length }) });
  });
  await page.route('**/rest/v1/rpc/report_ingest_point', async route => {
    const req = route.request();
    const body = JSON.parse(req.postData() || '{}');
    reports.push({ headers: req.headers(), body });
    const p = body.payload || {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: reports.length, label: 'Check laptop', point_id: p.point_id, path: 'serial-monitor/' + p.point_id,
      location_source: p.location_source, location_approx: p.location_source !== 'gps', repeat: false }) });
  });
  page.on('pageerror', e => errors.push(e.message));
  const cdp = await context.newCDPSession(page);

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => { localStorage.removeItem('mn-ingest'); switchTab('serial'); });

  async function dropFiles(sel, files) {
    const loc = page.locator(sel).first();
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    const x = b.x + Math.min(b.width / 2, 200), y = b.y + Math.min(b.height / 2, 30);
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
  }
  const until = async (fn, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < WAIT) { if (await fn()) return true; await page.waitForTimeout(200); }
    ok(what, false, 'timed out after ' + WAIT / 1000 + ' s');
    return false;
  };
  const cardOf = kind => page.evaluate(k => (Serial.list().find(c => c.kind === k && c.phase === 'follow') || {}).id, kind);

  // ── a radio, set up and switched on ────────────────────────────────────────
  fs.writeFileSync(file('radio.log'), HDR.join('\r\n') + '\r\n');
  await dropFiles('.serial .panel-header h2', [file('radio.log')]);
  await until(async () => !!(await cardOf('quansheng')), 'a radio log makes a followed Quansheng card');
  let id = await cardOf('quansheng');
  ok('the card offers to send to Flood-Net', await page.evaluate(i => !!document.getElementById('ing-' + i), id));
  await page.evaluate(i => {
    SerialIngest.setToken(i, 'mgn_check-token');
    SerialIngest.setLocSource(i, 'manual');
    SerialIngest.setManual(i, '153.0251, -27.4698');          // longitude first, as a map copy-out sometimes is
    SerialIngest.toggle(i, true);
  }, id);
  await until(() => reports.length >= 1, 'switching on reports the receiver');
  let rep = reports[reports.length - 1];
  const pointId = rep && rep.body.payload.point_id;
  ok('the receiver reports its own id, its kind and a location typed in, as approximate with no GPS',
    rep && /^qs-[0-9a-f]{8}$/.test(pointId) && rep.body.payload.receiver === 'quansheng'
      && rep.body.payload.location_source === 'manual' && rep.body.payload.lat === -27.4698 && rep.body.payload.lon === 153.0251
      && /Approximate/.test(rep.body.payload.location_note) && /No GPS/.test(rep.body.payload.location_note),
    rep && JSON.stringify(rep.body.payload));
  ok('the token goes in X-Ingest-Token, not Authorization',
    rep && rep.headers['x-ingest-token'] === 'mgn_check-token' && !rep.headers.authorization && rep.headers['content-profile'] === 'meganet');
  // The label is the report's answer, painted once the response is read: wait
  // for it, rather than reading the line the moment the request is recorded.
  await until(() => page.evaluate(i => /Check laptop/.test(document.getElementById('ing-status-' + i).textContent), id),
    'the card names the ingest point it posts as');

  // A live reading: timed by arrival.
  const before = Date.now();
  fs.appendFileSync(file('radio.log'), dec(1, null, 2088, 143) + '\r\n');
  await until(() => posts.length >= 1, 'a live reading is posted');
  let post = posts[posts.length - 1];
  let rd = post && post.body.payload.readings;
  ok('…as source serial, protocol alert, on the receiver\'s path',
    post && post.body.payload.source === 'serial' && post.body.payload.protocol === 'alert' && post.body.payload.path === 'serial-monitor/' + pointId,
    post && JSON.stringify(post.body.payload).slice(0, 300));
  ok('…with its address, its raw value, and the time it arrived',
    rd && rd.length === 1 && rd[0].alert_id === 2088 && rd[0].value_raw === 143 && rd[0].reading_ts >= before - 1000 && rd[0].reading_ts <= Date.now() + 1000,
    rd && JSON.stringify(rd));
  ok('…and the line it came from as the frame', post && /^DEC,1,/.test(post.body.payload.frame || ''));
  // The DEC's rssi and nf columns, -20 and -121 dBm: the RSSI as it is, and the
  // SNR as their difference (0050). A radio has no dBFS to give.
  ok('…and how it was heard: the radio\'s RSSI, and its SNR over its noise floor',
    rd && rd[0].rssi_dbm === -20 && rd[0].snr_db === 101 && !('level_dbfs' in rd[0]), rd && JSON.stringify(rd));

  // ── the same receiver again, out of a log's history ────────────────────────
  await page.evaluate(i => Serial.removeConn(i), id);
  const t1 = now() - 120;
  fs.writeFileSync(file('radio-old.log'), HDR.join('\r\n') + '\r\n' + dec(2, t1, 2443, 142) + '\r\n' + dec(3, null, 2442, 23) + '\r\n');
  const nPosts = posts.length;
  await dropFiles('.serial .panel-header h2', [file('radio-old.log')]);
  await until(() => posts.length > nPosts, 'a new card for the same radio resumes sending');
  id = await cardOf('quansheng');
  post = posts[posts.length - 1];
  rd = post && post.body.payload.readings;
  ok('…as the same receiver', post && post.body.payload.path === 'serial-monitor/' + pointId, post && post.body.payload.path);
  ok('a reading from the log\'s history goes with the radio\'s own time',
    rd && rd.length === 1 && rd[0].alert_id === 2443 && rd[0].reading_ts === t1 * 1000, rd && JSON.stringify(rd));
  ok('…and one with no time of its own is skipped and counted, never stamped "now"',
    rd && !rd.some(r => r.alert_id === 2442) && await page.evaluate(i => /1 reading from a log's history/.test(document.getElementById('ing-status-' + i).textContent), id));

  // ── a refused token ────────────────────────────────────────────────────────
  answer = 401;
  fs.appendFileSync(file('radio-old.log'), dec(4, null, 4109, 1290) + '\r\n');
  await until(() => page.evaluate(i => { const c = Serial.findConn(i); return c.ingest && !c.ingest.on; }, id), 'a refused token stops sending');
  const refused = await page.evaluate(i => ({ text: document.getElementById('ing-status-' + i).textContent,
    queue: Serial.findConn(i).ingest.queue.length, box: document.querySelector('#ing-' + i + ' input[type=checkbox]').checked }), id);
  ok('…says why, keeps what was waiting, and unticks the box', /refused the ingest token/.test(refused.text) && refused.queue === 1 && !refused.box, JSON.stringify(refused));
  answer = 200;
  await page.evaluate(i => SerialIngest.toggle(i, true), id);
  await until(() => posts.some(p => (p.body.payload.readings || []).some(r => r.alert_id === 4109) && answer === 200 && p.headers['x-ingest-token']),
    'switched back on, what was kept is sent');

  // ── the browser's location ─────────────────────────────────────────────────
  const nRep = reports.length;
  await page.evaluate(i => SerialIngest.setLocSource(i, 'browser'), id);
  await until(() => reports.length > nRep && reports[reports.length - 1].body.payload.location_source === 'browser', 'the browser\'s location is reported');
  rep = reports[reports.length - 1].body.payload;
  ok('…with the accuracy the browser gave, as approximate', rep.lat === -27.4698 && rep.accuracy_m === 1500 && /Wi-Fi or IP/.test(rep.location_note) && /No GPS/.test(rep.location_note), JSON.stringify(rep));

  // ── a station ──────────────────────────────────────────────────────────────
  const st = await page.evaluate(() => { const s = state.data.stations.find(s => s.lat != null && s.station_number); return { id: s.id, num: String(s.station_number), lat: +s.lat }; });
  await page.evaluate(([i, n]) => { SerialIngest.setLocSource(i, 'station'); SerialIngest.setStation(i, n); }, [id, st.num]);
  await until(() => reports[reports.length - 1].body.payload.location_source === 'station', 'a station chosen is reported');
  rep = reports[reports.length - 1].body.payload;
  ok('…as that station, with its coordinates', rep.host_station_id === st.id && rep.lat === st.lat, JSON.stringify(rep));

  // ── an ERT-A2, sending from the moment it is made ──────────────────────────
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('mn-ingest'));
    s.points.ert = { pointId: 'ert-check01', name: 'Check ERT-A2', loc: { source: 'none' }, on: true };
    localStorage.setItem('mn-ingest', JSON.stringify(s));
  });
  const nP = posts.length;
  fs.writeFileSync(file('ert.log'), ERT.join('\r\n') + '\r\n');
  await dropFiles('.serial .panel-header h2', [file('ert.log')]);
  await until(() => posts.length > nP && posts.slice(nP).some(p => p.body.payload.protocol === 'alert2'), 'an ERT-A2 log\'s readings are posted');
  const ep = posts.slice(nP).find(p => p.body.payload.protocol === 'alert2');
  const expect = await page.evaluate(() => {
    const at = (y, m, d, sod) => { let t = new Date(y, m - 1, d).getTime() + sod * 1000; if (t > Date.now() + 300000) t -= 86400000; return t; };
    return [at(2026, 6, 8, 0x64F0), at(2026, 6, 8, 0x6920)];
  });
  const ets = ep ? [...new Set(ep.body.payload.readings.map(r => r.reading_ts))].sort() : [];
  ok('…as ALERT2, every clean reading, on the receiver\'s path', ep && ep.body.payload.readings.length === 3 && ep.body.payload.path === 'serial-monitor/ert-check01', ep && JSON.stringify(ep.body.payload).slice(0, 300));
  ok('…timed by each frame\'s own time of day on the receiver\'s date', JSON.stringify(ets) === JSON.stringify(expect), JSON.stringify(ets) + ' vs ' + JSON.stringify(expect));
  ok('…with the signal the frame gave as a number, or none — never null or NaN on the wire',
    ep && ep.body.payload.readings.every(r => ['freq_mhz', 'rssi_dbm', 'level_dbfs', 'snr_db'].every(k => !(k in r) || Number.isFinite(r[k]))),
    ep && JSON.stringify(ep.body.payload.readings));
  ok('…and a receiver that gave no location reports none', reports.some(r => r.body.payload.point_id === 'ert-check01' && r.body.payload.location_source === 'none' && r.body.payload.lat === undefined));

  // ── a demo ─────────────────────────────────────────────────────────────────
  const nD = posts.length;
  await page.evaluate(() => Serial.addDemo('quansheng'));
  await page.waitForTimeout(1500);
  const demo = await page.evaluate(() => { const c = Serial.list().find(c => c.phase === 'demo'); const el = document.getElementById('ing-' + c.id);
    return { text: el ? el.textContent : '', box: !!(el && el.querySelector('input[type=checkbox]')), ingest: !!c.ingest }; });
  ok('a demo card says it never sends, offers no switch, and sends nothing', /never/.test(demo.text) && !demo.box && !demo.ingest && posts.length === nD, JSON.stringify(demo));

  // ── asking an administrator for the token (0048) ───────────────────────────
  // The three device calls answered as tools/check_ingest_token_requests.sql
  // holds the real ones to: pending with a code, then approved once `pair.status`
  // says so — which is the moment an administrator would press Approve.
  const pair = { requests: [], polls: [], withdrawals: [], status: 'pending' };
  await page.route('**/rest/v1/rpc/request_ingest_token', r => {
    const req = r.request();
    pair.requests.push({ headers: req.headers(), body: JSON.parse(req.postData() || '{}') });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'pending', id: 40 + pair.requests.length, code: 'BCDF-GHJK',
      label: 'Serial Monitor on a Linux PC', expires_at: new Date(Date.now() + 1800e3).toISOString(), expires_in: 1800, poll_s: 5 }) });
  });
  await page.route('**/rest/v1/rpc/ingest_token_request_status', r => {
    pair.polls.push(r.request().headers()['x-ingest-token']);
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pair.status === 'approved'
      ? { status: 'approved', label: 'Field laptop' } : { status: 'pending', code: 'BCDF-GHJK', expires_in: 1700 }) });
  });
  await page.route('**/rest/v1/rpc/withdraw_ingest_token_request', r => {
    pair.withdrawals.push(r.request().headers()['x-ingest-token']);
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'withdrawn' }) });
  });
  const ingText = i => page.evaluate(x => (document.getElementById('ing-' + x) || {}).textContent || '', i);

  await page.evaluate(i => { SerialIngest.toggle(i, false); SerialIngest.setToken(i, ''); }, id);
  ok('with no token, the card offers to ask an administrator for one', /Ask an administrator for one/.test(await ingText(id)));
  await page.click('#ing-' + id + ' button:has-text("Ask an administrator for one")');
  await until(async () => /BCDF-GHJK/.test(await ingText(id)) && /Waiting for an administrator/.test(await ingText(id)), 'asking shows the code the request carries');
  const ask = pair.requests[0];
  const asked = ask && ask.headers['x-ingest-token'];
  ok('…having asked with a token it made itself, in X-Ingest-Token — mgn_ and 64 hex — never Authorization',
    /^mgn_[0-9a-f]{64}$/.test(asked || '') && !ask.headers.authorization && ask.headers['content-profile'] === 'meganet', asked);
  ok('…saying what it is: a label, and the receivers on this computer',
    ask && /Serial Monitor/.test(ask.body.payload.label) && Array.isArray(ask.body.payload.detail.receivers) && ask.body.payload.detail.receivers.length >= 1,
    ask && JSON.stringify(ask.body));
  ok('…keeping no token to send with until it is approved', await page.evaluate(() => !JSON.parse(localStorage.getItem('mn-ingest')).token));
  await until(() => pair.polls.length >= 1, 'it asks how the request is going');
  ok('…holding the token it asked with', pair.polls[0] === asked);
  const nA = posts.length;
  pair.status = 'approved';
  await until(() => page.evaluate(t => JSON.parse(localStorage.getItem('mn-ingest')).token === t, asked), 'approved, the token it made is kept');
  await until(() => page.evaluate(i => Serial.findConn(i).ingest.on, id), '…and the card that asked starts sending by itself');
  ok('…and says so, under the name Flood-Net gave it', /Approved/.test(await ingText(id)) && /Field laptop/.test(await ingText(id)));
  fs.appendFileSync(file('radio-old.log'), dec(5, null, 4110, 77) + '\r\n');
  await until(() => posts.slice(nA).some(p => p.headers['x-ingest-token'] === asked && (p.body.payload.readings || []).some(r => r.alert_id === 4110)),
    'a reading is then posted with the approved token');

  pair.status = 'pending';
  await page.evaluate(i => { SerialIngest.toggle(i, false); SerialIngest.setToken(i, ''); }, id);
  await page.click('#ing-' + id + ' button:has-text("Ask an administrator for one")');
  await until(async () => /Stop asking/.test(await ingText(id)), 'asking again shows the code again');
  await page.click('#ing-' + id + ' button:has-text("Stop asking")');
  await until(() => pair.withdrawals.length === 1, 'Stop asking withdraws the request, so it leaves the Admin tab\'s list');
  ok('…with the token it asked with, and nothing is left waiting',
    pair.withdrawals[0] === pair.requests[1].headers['x-ingest-token'] && await page.evaluate(() => !JSON.parse(localStorage.getItem('mn-ingest')).pending));

  // ── the Admin tab's token panel (0046) ─────────────────────────────────────
  // Auth stood in for an administrator; the three calls answered as
  // tools/check_ingest_token_admin.sql holds the real ones to.
  const minted = 'mgn_' + 'a'.repeat(64);
  const tokens = [];
  const adminCalls = [];
  // …and the requests (0048), as tools/check_ingest_token_requests.sql holds
  // the real calls to. Empty until a base station asks, further down.
  const reqList = [], approveCalls = [], denyCalls = [];
  await page.route('**/rest/v1/rpc/admin_ingest_token_requests', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reqList) }));
  await page.route('**/rest/v1/rpc/admin_approve_ingest_token_request', r => {
    const a = JSON.parse(r.request().postData() || '{}');
    approveCalls.push(a);
    const q = reqList.find(x => x.id === a.p_id);
    const at = new Date().toISOString();
    Object.assign(q, { status: 'approved', decided_at: at, decided_by: 'admin@example.test', token_label: a.p_label || q.label, ingest_token_id: 30 + approveCalls.length });
    if (a.p_replace_token_id) { const old = tokens.find(t => t.id === a.p_replace_token_id); if (old) old.revoked_at = at; }
    tokens.unshift({ id: 30 + approveCalls.length, label: q.token_label, created_at: at, created_by: 'admin@example.test', receivers: [] });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 30 + approveCalls.length, label: q.token_label,
      request_id: q.id, code: q.code, host_station_id: null, replaced_token_id: a.p_replace_token_id || null }) });
  });
  await page.route('**/rest/v1/rpc/admin_deny_ingest_token_request', r => {
    const a = JSON.parse(r.request().postData() || '{}');
    denyCalls.push(a.p_id);
    const q = reqList.find(x => x.id === a.p_id);
    Object.assign(q, { status: 'denied', decided_at: new Date().toISOString(), decided_by: 'admin@example.test' });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: q.id, status: 'denied' }) });
  });
  await page.route('**/rest/v1/rpc/admin_ingest_tokens', r => { adminCalls.push('list'); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tokens) }); });
  await page.route('**/rest/v1/rpc/admin_create_ingest_token', r => {
    const a = JSON.parse(r.request().postData() || '{}');
    adminCalls.push('create:' + a.p_label);
    tokens.unshift({ id: 9, label: a.p_label, created_at: new Date().toISOString(), created_by: 'admin@example.test', receivers: [] });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 9, label: a.p_label, token: minted }) });
  });
  await page.route('**/rest/v1/rpc/admin_revoke_ingest_token', r => {
    adminCalls.push('revoke:' + JSON.parse(r.request().postData() || '{}').p_id);
    tokens[0].revoked_at = new Date().toISOString();
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 9, revoked_at: tokens[0].revoked_at }) });
  });
  await page.route('**/rest/v1/rpc/admin_users', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/rpc/admin_allowlist', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/rpc/admin_dashboard', r => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.evaluate(() => {
    localStorage.removeItem('mn-ingest');
    Auth.isSignedIn = () => true; Auth.isAdmin = () => true; Auth.role = () => 'admin';
    switchTab('admin');
  });
  await until(() => page.evaluate(() => !!document.querySelector('#adm-tokens .adm-tok-form')), 'the Admin tab shows the token panel to an administrator');
  await page.fill('#adm-tok-label', 'Check laptop');
  await page.click('#adm-tokens button:has-text("Create token")');
  await until(() => page.evaluate(t => (document.getElementById('adm-tok-value') || {}).textContent === t, minted), 'a minted token is shown once');
  ok('…asked for under its label', adminCalls.includes('create:Check laptop'), adminCalls.join(','));
  await page.click('#adm-tokens button:has-text("Use in this browser")');
  ok('"Use in this browser" hands it to the Serial Monitor\'s cards',
    await page.evaluate(t => JSON.parse(localStorage.getItem('mn-ingest') || '{}').token === t, minted));
  await page.click('#adm-tokens button:has-text("Done")');
  ok('Done takes the token off the screen', await page.evaluate(t => !document.body.textContent.includes(t), minted));
  ok('the new token is listed', await page.evaluate(() => /Check laptop/.test(document.querySelector('#adm-tokens table').textContent)));
  page.once('dialog', d => d.accept());
  await page.click('#adm-tokens button:has-text("Revoke")');
  await until(() => page.evaluate(() => /revoked/.test(document.querySelector('#adm-tokens table').textContent)), 'Revoke… revokes it, after asking');
  ok('…by its id', adminCalls.includes('revoke:9'), adminCalls.join(','));

  // ── base stations asking for a token, on the Admin tab (0048) ──────────────
  const reqsText = () => page.evaluate(() => (document.getElementById('adm-tok-reqs') || {}).textContent || '');
  ok('with nothing waiting, the panel says how a base station asks', /Nothing is waiting/.test(await reqsText()));
  // A live token already called what the Pi will ask as: a reflashed Pi.
  const ago = s => new Date(Date.now() - s * 1000).toISOString();
  tokens.unshift({ id: 12, label: 'Bench Pi', created_at: ago(86400 * 9), last_used_at: ago(86400 * 3), receivers: [] });
  await page.evaluate(() => AdminTokens.load());
  reqList.push({ id: 7, code: 'WDJB-MJHT', label: 'Bench Pi', status: 'pending', requested_at: ago(60), expires_at: new Date(Date.now() + 29 * 60e3).toISOString(),
    host_station_id: null, detail: { app: 'RPi ALERT', version: '0.2.0', board: 'Raspberry Pi 4 Model B', host: 'rpi-alert', receivers: [{ kind: 'rtl-sdr', name: 'RTL-SDR' }] } });
  await until(async () => /WDJB-MJHT/.test(await reqsText()), 'a request appears under Waiting for approval by itself, within a poll');
  const shown = await reqsText();
  ok('…with its code, its name and what it said about itself',
    /Bench Pi/.test(shown) && /RPi ALERT 0\.2\.0/.test(shown) && /Raspberry Pi 4 Model B/.test(shown) && /RTL-SDR/.test(shown), shown.slice(0, 300));
  await page.click('#adm-tok-reqs button:has-text("Approve…")');
  const form = await page.evaluate(() => ({ text: document.getElementById('adm-tok-reqs').textContent,
    label: (document.getElementById('adm-req-label') || {}).value, go: (document.getElementById('adm-req-go') || {}).textContent }));
  ok('Approve… asks for the code to be checked, the name filled in', /Check the device shows WDJB-MJHT/.test(form.text) && form.label === 'Bench Pi' && /WDJB-MJHT/.test(form.go || ''), JSON.stringify(form).slice(0, 300));
  ok('…and, a live token having that name, says so and offers to replace it',
    /already called “Bench Pi”/.test(form.text) && await page.evaluate(() => !!document.querySelector('#adm-req-clash input[type=checkbox]')));
  await page.click('#adm-req-go');
  ok('approving under a taken name without replacing it is stopped before anything is sent',
    approveCalls.length === 0 && /change the label, or tick Replace it/.test(await reqsText()));
  await page.check('#adm-req-clash input[type=checkbox]');
  await page.click('#adm-req-go');
  await until(() => approveCalls.length === 1, 'Approve sends the approval');
  ok('…for that request, under that name, replacing the live token, with no station',
    approveCalls[0] && approveCalls[0].p_id === 7 && approveCalls[0].p_label === 'Bench Pi' && approveCalls[0].p_replace_token_id === 12 && approveCalls[0].p_host_station_id === '',
    JSON.stringify(approveCalls[0]));
  await until(() => page.evaluate(() => /Approved “Bench Pi”/.test(document.getElementById('adm-tokens').textContent)), 'the panel says it is approved, and that nothing needs copying');
  ok('…and the request moves to the last day\'s list', await page.evaluate(() => /approved/.test((document.querySelector('.adm-req-recent') || {}).textContent || '')));

  reqList.push({ id: 8, code: 'KLMN-PQRS', label: 'Somebody', status: 'pending', requested_at: ago(30), expires_at: new Date(Date.now() + 29 * 60e3).toISOString(), detail: {} });
  await until(async () => /KLMN-PQRS/.test(await reqsText()), 'a second request appears');
  page.once('dialog', d => d.accept());
  await page.click('#adm-tok-reqs button:has-text("Deny")');
  await until(() => denyCalls.includes(8), 'Deny turns it down, after asking');

  // The QR code on the Pi's screen: #pair=CODE. Signed out first, then in.
  reqList.push({ id: 9, code: 'XZBC-DFGH', label: 'Hut Pi', status: 'pending', requested_at: ago(20), expires_at: new Date(Date.now() + 29 * 60e3).toISOString(), detail: { app: 'RPi ALERT' } });
  await page.evaluate(() => {
    Auth.isSignedIn = () => false; Auth.isAdmin = () => false; Auth.role = () => null;
    location.hash = '#pair=xzbc-dfgh';
    AdminTokens.restoreFromUrl();
  });
  ok('the Pi\'s QR link opens the Admin tab, asking an administrator to sign in to approve that code',
    await page.evaluate(() => state.activeTab === 'admin' && /Sign in as an administrator to approve it/.test(document.getElementById('adm-tokens').textContent)
      && /XZBC-DFGH/.test(document.getElementById('adm-tokens').textContent)));
  ok('…and takes the code out of the address bar', await page.evaluate(() => location.hash === ''));
  await page.evaluate(() => { Auth.isSignedIn = () => true; Auth.isAdmin = () => true; Auth.role = () => 'admin'; AdminTokens.authChanged(); });
  await until(() => page.evaluate(() => { const f = document.querySelector('.adm-req.is-focus'); return !!f && /XZBC-DFGH/.test(f.textContent) && !!document.getElementById('adm-req-go'); }),
    'signed in, that request is picked out with its approve form open');
  ok('…and nothing was approved by the link itself', approveCalls.length === 1);

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(DIR, { recursive: true, force: true });
}

if (failures) { console.log(`\nFAIL — ${failures} check(s) failed.`); process.exit(1); }
console.log('PASS — a receiver card posts what it hears as a tagged base station, approximate location said as such, and never a reading it cannot time; a base station asks for its token and an administrator approves it.');
