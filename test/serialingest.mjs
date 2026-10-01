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
  ok('the card offers to send to MegaNet', await page.evaluate(i => !!document.getElementById('ing-' + i), id));
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
  ok('the card names the ingest point it posts as', await page.evaluate(i => /Check laptop/.test(document.getElementById('ing-status-' + i).textContent), id));

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
  ok('…and a receiver that gave no location reports none', reports.some(r => r.body.payload.point_id === 'ert-check01' && r.body.payload.location_source === 'none' && r.body.payload.lat === undefined));

  // ── a demo ─────────────────────────────────────────────────────────────────
  const nD = posts.length;
  await page.evaluate(() => Serial.addDemo('quansheng'));
  await page.waitForTimeout(1500);
  const demo = await page.evaluate(() => { const c = Serial.list().find(c => c.phase === 'demo'); const el = document.getElementById('ing-' + c.id);
    return { text: el ? el.textContent : '', box: !!(el && el.querySelector('input[type=checkbox]')), ingest: !!c.ingest }; });
  ok('a demo card says it never sends, offers no switch, and sends nothing', /never/.test(demo.text) && !demo.box && !demo.ingest && posts.length === nD, JSON.stringify(demo));

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(DIR, { recursive: true, force: true });
}

if (failures) { console.log(`\nFAIL — ${failures} check(s) failed.`); process.exit(1); }
console.log('PASS — a receiver card posts what it hears as a tagged base station, approximate location said as such, and never a reading it cannot time.');
