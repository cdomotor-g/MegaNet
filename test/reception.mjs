// The Reception Map (reception.js), the reception log every receiver card
// writes (reception-log.js), and the GPS card that places it (serial-gps.js).
//
// The method's oracle is a drive whose answer is known: Reception.demoDrive()
// builds one against the real registry — two real repeaters that relay the
// same stations, one of them made to flip a bit in a third of what it relays —
// and the check holds the analysis to naming that one, by pass ranges alone
// (positions stripped) and with positions (the bad copies loudest near it).
// Then the stored readings, which every base station's traffic lands in, on
// readings built for each rule:
//
//   * a row is a copy, and each further path that heard it another; anything
//     not an ALERT frame is left out
//   * a station's two sensors a bit apart, a second apart in its burst, are two
//     readings, not a flip
//   * a repeater's corrupted copy nine seconds after the clean one is found
//   * a frame landing on another station's address is a ghost of the one whose
//     own reports it is in line with; two stations that only look alike are both
//     kept
//   * a gauge tipping every few seconds through a storm is reporting
//   * the tab reads them from the datastore (stood in for) and finds the same
//
// Then the pieces an operator touches:
//
//   * NMEA: GGA and RMC from any talker, checksums enforced, hemispheres signed
//   * a GPS card fed a real NMEA stream: its fix, its accuracy, and that fix
//     stamped on what a receiver card hears — as 'gps', exact
//   * a receiver card's receptions logged, good and bad (an ERT-A2 frame that does not add up)
//   * the log exported as CSV and loaded back as a file, the same analysis out
//   * the tab drawing its map, a suspect picked, no page errors
//   * a site survey (0051, stood in for): the list, one opened — its receptions
//     the map's source, each station it heard with how much of what the network
//     received it caught, the ones it did not hear on request, a line from the
//     site to each, and the table as CSV
//
// Run:  npm run reception
//       npm run reception -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

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

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => { localStorage.removeItem('mn-rxlog'); RxLog.clear(); });

  // ── the method, against a drive whose answer is known ──────────────────────
  const m = await page.evaluate(() => {
    const drive = Reception.demoDrive(42);
    const truth = Reception._state.demoTruth;
    const withPos = Reception.analyse(drive);
    const noPos = Reception.analyse(drive.map(e => Object.assign({}, e, { lat: null, lon: null })));
    const top = a => a.suspects[0] && a.suspects[0].r.st.id;
    const s = withPos.suspects.find(x => x.r.st.id === truth.bad), g = withPos.suspects.find(x => x.r.st.id === truth.good);
    return { n: drive.length, truth, bad: withPos.bad.length, topPos: top(withPos), topNoPos: top(noPos),
      rBad: s && s.r_dist, rGood: g && g.r_dist, cen: withPos.centroid && withPos.centroid.nearest && withPos.centroid.nearest.s.r.st.id,
      flipsAll: withPos.bad.every(b => b.why === 'flipped' || b.why === 'ghost') };
  });
  ok('the demo drive is built against the real registry', m.n > 200 && m.truth && m.truth.bad && m.truth.good, JSON.stringify(m));
  ok('bad copies are found, each a flip or a ghost of what was sent', m.bad > 10 && m.flipsAll, 'bad copies: ' + m.bad);
  ok('by pass ranges alone — no positions — the flipping repeater is named first', m.topNoPos === m.truth.bad, m.topNoPos + ' vs ' + m.truth.bad);
  ok('with positions, still first', m.topPos === m.truth.bad, m.topPos + ' vs ' + m.truth.bad);
  ok('its bad copies get louder nearer it (strongly negative r), and not so for the innocent one',
    m.rBad != null && m.rBad < -0.5 && (m.rGood == null || m.rGood > m.rBad), 'r bad ' + m.rBad + ', r good ' + m.rGood);
  ok('where bad copies are loudest is nearest the flipping repeater', m.cen === m.truth.bad, m.cen);

  // ── NMEA ───────────────────────────────────────────────────────────────────
  const n = await page.evaluate(() => {
    const p = s => SerialGps.parse(s);
    return { gga: p('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47'),
      rmc: p('$GNRMC,092751.000,A,2733.6360,S,15157.0420,E,29.20,268.00,011026,,,A*53'),
      bad: p('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*00') };
  });
  ok('GGA reads position, fix, satellites, HDOP', n.gga && Math.abs(n.gga.lat - 48.1173) < 1e-4 && Math.abs(n.gga.lon - 11.516667) < 1e-4 && n.gga.sats === 8 && n.gga.hdop === 0.9, JSON.stringify(n.gga));
  ok('RMC reads a southern, eastern position, speed and course', n.rmc && n.rmc.valid && n.rmc.lat < -27.5 && n.rmc.lon > 151.9 && n.rmc.knots === 29.2, JSON.stringify(n.rmc));
  ok('a sentence failing its checksum is refused', n.bad && n.bad.type === 'bad');

  // ── a GPS card placing what a receiver hears ───────────────────────────────
  await page.evaluate(() => { switchTab('serial'); Serial.addConnection('gps'); Serial.addConnection('ert'); });
  const ids = await page.evaluate(() => Serial.list().map(c => ({ id: c.id, kind: c.kind })));
  const gpsId = ids.find(c => c.kind === 'gps').id, ertId = ids.find(c => c.kind === 'ert').id;
  await page.evaluate(([g, e]) => {
    const cs = s => { let x = 0; for (let i = 1; i < s.length; i++) x ^= s.charCodeAt(i); return s + '*' + x.toString(16).toUpperCase().padStart(2, '0'); };
    const gc = Serial.findConn(g), ec = Serial.findConn(e);
    gc.phase = 'open'; ec.phase = 'open';
    Serial.feed(gc, new TextEncoder().encode(cs('$GNGGA,092751.00,2733.6360,S,15157.0420,E,1,10,1.2,690.0,M,40.0,M,,') + '\r\n'));
    // two ERT-A2 frames: one clean, one whose payload runs a byte past its
    // last record. A record's fourth byte is a time offset, not a status (#209),
    // so what makes a reception bad now is a frame that does not add up.
    Serial.feed(ec, new TextEncoder().encode('ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00\r\n'
      + 'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,42.296,0,0,0,0,0,1,0,0,0,7,8,9999,74,64,F0,7E,18,15,01,FF\r\n'));
  }, [gpsId, ertId]);
  const rx = await page.evaluate(() => RxLog.all().map(e => ({ src: e.location_source, approx: e.location_approx, lat: e.lat, acc: e.accuracy_m, ok: e.ok, fault: e.fault, rc: e.receiver })));
  ok('the GPS card has a fix, with accuracy from HDOP', await page.evaluate(g => { const f = SerialGps.fix(false); return f && Math.abs(f.lat + 27.5606) < 1e-3 && f.accuracy_m === 6; }, gpsId));
  ok('a receiver\'s receptions are logged, the bad one too', rx.length === 2 && rx.filter(e => e.ok).length === 1 && rx.some(e => e.fault === 'frame'), JSON.stringify(rx));
  ok('…each placed by the GPS card, exact', rx.every(e => e.src === 'gps' && e.approx === false && Math.abs(e.lat + 27.5606) < 1e-3 && e.acc === 6), JSON.stringify(rx));
  await page.evaluate(() => Serial.renderList());
  ok('the card shows its reception log', await page.evaluate(e => /2 heard, 1 bad, 2 placed/.test((document.getElementById('rx-sum-' + e) || {}).textContent || ''), ertId));

  // ── round trip through a file ──────────────────────────────────────────────
  const rt = await page.evaluate(() => {
    const drive = Reception.demoDrive(42);
    const back = Reception.fromFile(RxLog.toCsv(drive), 'drive.csv');
    const a = Reception.analyse(drive), b = Reception.analyse(back);
    const geo = Reception.fromFile(RxLog.toGeoJson(drive), 'drive.geojson');
    return { n: drive.length, back: back.length, geo: geo.length, badA: a.bad.length, badB: b.bad.length,
      topA: a.suspects[0].r.st.id, topB: b.suspects[0].r.st.id, topG: Reception.analyse(geo).suspects[0].r.st.id };
  });
  ok('the log exported as CSV loads back to the same analysis', rt.back === rt.n && rt.badB === rt.badA && rt.topB === rt.topA, JSON.stringify(rt));
  ok('…and as GeoJSON', rt.geo === rt.n && rt.topG === rt.topA, JSON.stringify(rt));

  // ── the tab ────────────────────────────────────────────────────────────────
  await page.evaluate(() => switchTab('reception'));
  await page.click('button:has-text("Demo drive")');
  await page.waitForTimeout(500);
  const tab = await page.evaluate(() => ({
    markers: document.querySelectorAll('#rx-map .leaflet-interactive').length,
    rows: document.querySelectorAll('#rx-h-sus ~ .table-wrap tbody tr, .rx-page .table-wrap tbody tr').length,
    first: (document.querySelector('.rx-page tbody tr th button') || {}).textContent || '',
    truth: Reception._state.demoTruth && state.data.stations.find(s => s.id === Reception._state.demoTruth.bad).name,
  }));
  ok('the tab draws the drive on its map', tab.markers > 100, 'markers: ' + tab.markers);
  ok('…and ranks the flipping repeater first in its table', tab.first === tab.truth, tab.first + ' vs ' + tab.truth);
  await page.click('.rx-page tbody tr th button');
  await page.waitForTimeout(300);
  ok('picking a suspect draws its lines and marks the row', await page.evaluate(() => document.querySelectorAll('.rx-page tr.rx-sel').length === 1));
  // ── the stored readings ────────────────────────────────────────────────────
  const STORED = await page.evaluate(() => {
    const H = 3600e3;
    const idx = SensorValues.index();
    const own = new Map([...idx.entries()].filter(([, l]) => l.length === 1 && l[0].station.lat != null).map(([a, l]) => [a, l[0].station]));
    // A station with two addresses a bit apart, and two pairs of stations near
    // each other whose addresses are a bit apart.
    let sib = null;
    const pairs = [];
    for (const [a, sa] of own) {
      for (let k = 0; k < 13; k++) {
        const b = a ^ (1 << k), sb = own.get(b);
        if (!sb || b < a) continue;
        if (sb.id === sa.id) { if (!sib) sib = { a, b }; }
        else if (SensorValues.km(sa.lat, sa.lon, sb.lat, sb.lon) < 60 && !pairs.some(p => [p.a, p.b].some(x => x === a || x === b))) pairs.push({ a, b });
      }
    }
    const used = new Set([sib.a, sib.b, ...pairs.slice(0, 2).flatMap(p => [p.a, p.b])]);
    const r = [...own.keys()].find(x => !used.has(x));
    const [p, q] = pairs;
    const t0 = Math.floor((Date.now() - 3 * 86400e3) / 60e3) * 60e3 + 41e3;
    const row = (aid, t, v, dups) => ({ addr: 'a:' + aid, alert_id: aid, reading_ts: new Date(t).toISOString(), value_raw: v,
      path: 'serial-monitor/test-pi-sdr0', dup_count: (dups || []).length, dup_paths: dups || [], rssi_dbm: null, level_dbfs: -40, snr_db: 12 });
    const rows = [];
    for (let k = 0; k < 8; k++) {
      const t = t0 + k * 3 * H;
      rows.push(row(sib.a, t, 5), row(sib.b, t + 1000, 5));                       // one station's burst
      rows.push(row(p.a, t + 600e3, 133 + (k % 2)), row(p.b, t + 1800e3, 1200 + k));  // p.a 133-ish, p.b in the thousands
      rows.push(row(q.a, t + 2400e3, 130 + (k % 2)), row(q.b, t + 3000e3, 131 - (k % 2)));  // both 130-ish
    }
    rows.push(row(p.a, t0 + 24 * H + 600e3, 133), row(p.a, t0 + 24 * H + 609e3, 133 ^ 64));  // corrupted, 9 s on
    rows.push(row(p.a, t0 + 27 * H + 600e3, 134), row(p.b, t0 + 27 * H + 602e3, 134));        // p.a's frame on p.b's address
    rows.push(row(q.a, t0 + 27 * H + 2400e3, 131), row(q.b, t0 + 27 * H + 2401e3, 131));       // q's two just look alike
    for (let i = 0; i < 12; i++) rows.push(row(r, t0 + 40 * H + i * 7000, 400 + i));            // a storm, a tip every 7 s
    rows.push(row(p.a, t0 + 30 * H + 600e3, 133, ['serial-monitor/test-pi-sdr1']));            // heard twice
    rows.push({ addr: 's:541155/level', alert_id: null, reading_ts: new Date(t0).toISOString(), value_raw: 1.5, path: 'x', dup_count: 0, dup_paths: [] });
    rows.push(row(p.a, t0 + 31 * H, 4000));                                                     // not an ALERT value
    return { rows, sib, p, q, r };
  });
  const sr = await page.evaluate(W => {
    const ents = Reception.fromReadings(W.rows);
    const a = Reception.analyse(ents);
    const bad = a.bad.map(b => ({ heard: b.e.alert_id + '=' + b.e.value_raw, truth: b.truth.alert_id + '=' + b.truth.value_raw, why: b.why }));
    return { ents: ents.length, valid: W.rows.filter(r => r.alert_id != null && r.value_raw <= 2047).length, bad, rapid: a.rapid, own: a.own,
      twice: ents.filter(e => e.alert_id === W.p.a && e.value_raw === 133 && e.t === Date.parse(W.rows.find(r => r.dup_count === 1).reading_ts)).length };
  }, STORED);
  const has = (heard, truth) => sr.bad.some(b => b.heard === heard && b.truth === truth);
  ok('a stored reading is a copy, and each further path that heard it another; what is not an ALERT frame is left out',
    sr.ents === sr.valid + 1 && sr.twice === 2, JSON.stringify({ ents: sr.ents, valid: sr.valid, twice: sr.twice }));
  ok('a station\'s two sensors a bit apart, a second apart in its burst, are not a flip',
    !sr.bad.some(b => [STORED.sib.a, STORED.sib.b].some(x => b.heard.startsWith(x + '='))), JSON.stringify(sr.bad));
  ok('a repeater\'s corrupted copy nine seconds after the clean one is found', has(STORED.p.a + '=' + (133 ^ 64), STORED.p.a + '=133'), JSON.stringify(sr.bad));
  ok('a frame on another station\'s address is a ghost of the one whose own reports it is in line with',
    has(STORED.p.b + '=134', STORED.p.a + '=134'), JSON.stringify(sr.bad));
  ok('two stations that only look alike are both kept', sr.own >= 1 && !sr.bad.some(b => [STORED.q.a, STORED.q.b].some(x => b.heard.startsWith(x + '='))), JSON.stringify(sr));
  ok('a gauge tipping every 7 s through a storm is reporting, not corrupted', sr.rapid >= 5 && !sr.bad.some(b => b.heard.startsWith(STORED.r + '=')), JSON.stringify(sr));
  ok('…and that is all that is bad', sr.bad.length === 2, JSON.stringify(sr.bad));

  const readingAsks = [];
  await page.route('**/rest/v1/reading?*', route => {
    const u = new URL(route.request().url());
    readingAsks.push(u.search);
    const q = u.searchParams;
    const ts = q.getAll('reading_ts');
    const gte = Date.parse(ts.find(x => x.startsWith('gte.')).slice(4)), lt = Date.parse(ts.find(x => x.startsWith('lt.')).slice(3));
    let rows = STORED.rows.filter(r => { const t = Date.parse(r.reading_ts); return t >= gte && t < lt; });
    if (q.get('alert_id') === 'not.is.null') rows = rows.filter(r => r.alert_id != null);
    const off = Number(q.get('offset')) || 0, cols = q.get('select').split(',');
    const body = rows.slice(off, off + 1000).map(r => Object.fromEntries(cols.map(k => [k, r[k] === undefined ? null : r[k]])));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.evaluate(() => { Reception.clearLoaded(); Reception.setLocal(false); });
  await page.click('button:has-text("From the stored readings")');
  await page.waitForFunction(() => /copies of ALERT frames/.test((document.getElementById('rx-rd-note') || {}).textContent || ''), null, { timeout: 15_000 });
  const ui = await page.evaluate(() => ({ bad: Reception._state.last.bad.length, rows: document.querySelectorAll('[aria-labelledby="rx-h-bad"] tbody tr').length,
    hint: (document.querySelector('.rx-page .qs-hint') || {}).textContent || '' }));
  ok('the tab reads the stored readings from the datastore — ALERT frames only — and finds the same',
    readingAsks.length > 0 && readingAsks.every(s => /alert_id=not\.is\.null/.test(s)) && ui.bad === sr.bad.length && ui.rows === sr.bad.length,
    JSON.stringify({ asks: readingAsks.length, ui: { bad: ui.bad, rows: ui.rows } }));
  ok('…and says the stored readings carry no position', /Stored readings carry no position/.test(ui.hint), ui.hint.slice(0, 200));
  await page.evaluate(() => { Reception.clearLoaded(); Reception.setLocal(true); });

  // ── a site survey ─────────────────────────────────────────────────────────
  const SV = await page.evaluate(() => {
    const st = state.data.stations.filter(s => s.lat != null && s.lon != null && stationAlertIds(s).length).slice(0, 3);
    const site = { lat: st[0].lat + 0.05, lon: st[0].lon + 0.05 };
    const a = st.map(s => stationAlertIds(s)[0]);
    const t0 = Date.now() - 3 * 86400e3;
    const iso = (t) => new Date(t).toISOString();
    const summary = { id: 's-6dfef7f4-abc123', name: 'Mt Test candidate repeater', token_label: 'Survey Pi', first_heard: iso(t0), last_heard: iso(t0 + 72 * 3600e3),
      listening_h: 71.7, match_s: 10, frames: 40, ok: 30, bad: 2, undecoded: 8, lat: site.lat, lon: site.lon, gps: true, location_source: 'gps',
      points: [{ point_id: 'rpi-6dfef7f4-sdr1', receiver: 'rtl-sdr', freq_mhz: 151.5, ok: 30, bad: 2, undecoded: 8 }],
      stations: [
        { alert_id: a[0], ok: 20, bad: 2, first_heard: iso(t0), last_heard: iso(t0 + 70 * 3600e3), level_dbfs: [-40, -35, -30], rssi_dbm: null, snr_db: 24.5, freqs: [151.5], points: ['rpi-6dfef7f4-sdr1'], sent: 10, heard_of_sent: 9, only_here: 11 },
        { alert_id: a[1], ok: 10, bad: 0, first_heard: iso(t0), last_heard: iso(t0 + 60 * 3600e3), level_dbfs: [-60, -57, -52], rssi_dbm: null, snr_db: 8, freqs: [151.5], points: ['rpi-6dfef7f4-sdr1'], sent: 0, heard_of_sent: 0, only_here: 10 },
        { alert_id: a[2], ok: 0, bad: 0, first_heard: null, last_heard: null, level_dbfs: null, rssi_dbm: null, snr_db: null, freqs: null, points: null, sent: 5, heard_of_sent: 0, only_here: 0 },
      ] };
    const rx = Array.from({ length: 30 }, (_, i) => ({ heard_at: iso(t0 + i * 3600e3), receiver: 'rtl-sdr', point_id: 'rpi-6dfef7f4-sdr1', point_name: 'Survey Pi — RTL-SDR',
      protocol: 'alert', alert_id: a[i % 2], value_raw: i, ok: true, fault: null, rssi_dbm: null, level_dbfs: -40, lat: site.lat, lon: site.lon, location_source: 'gps', location_approx: false,
      detail: { survey: 's-6dfef7f4-abc123', survey_name: 'Mt Test candidate repeater' } }));
    const list = [{ id: summary.id, name: summary.name, token_label: 'Survey Pi', first_heard: summary.first_heard, last_heard: summary.last_heard, frames: 40, ok: 30, bad: 2, undecoded: 8,
      addresses: 2, lat: site.lat, lon: site.lon, gps: true, points: ['rpi-6dfef7f4-sdr1'] }];
    return { summary, rx, list, names: st.map(s => s.name) };
  });
  const svAsks = [];
  await page.route('**/rest/v1/rpc/survey_*', route => {
    const fn = new URL(route.request().url()).pathname.split('/').pop();
    svAsks.push(fn + ' ' + (route.request().postData() || ''));
    const body = fn === 'survey_list' ? SV.list : fn === 'survey_summary' ? SV.summary : fn === 'survey_receptions' ? SV.rx : null;
    return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.click('button:has-text("Site surveys (editors)")');
  await page.waitForSelector('[aria-labelledby="rx-h-sv"] tbody tr', { timeout: 15_000 });
  ok('the survey list is read and shown', await page.evaluate(() => /Mt Test candidate repeater/.test(document.querySelector('[aria-labelledby="rx-h-sv"]').textContent)));
  await page.click('[aria-labelledby="rx-h-sv"] tbody button');
  await page.waitForSelector('[aria-labelledby="rx-h-svs"] tbody tr', { timeout: 15_000 });
  const sv1 = await page.evaluate(() => ({
    rows: document.querySelectorAll('[aria-labelledby="rx-h-svs"] tbody tr').length,
    text: document.querySelector('.rx-page').textContent, db: Reception._state.db.length, local: Reception._state.useLocal,
    lines: document.querySelectorAll('#rx-map path.leaflet-interactive, #rx-map path').length,
  }));
  ok('opening a survey asks for its summary and its receptions', svAsks.some(x => /^survey_summary .*s-6dfef7f4-abc123/.test(x)) && svAsks.some(x => /^survey_receptions /.test(x)), svAsks.join(' | '));
  ok('its receptions are the map\'s source, without this browser\'s own log', sv1.db === 30 && sv1.local === false, JSON.stringify({ db: sv1.db, local: sv1.local }));
  ok('each station heard is a row; the one the site never heard is not, until asked', sv1.rows === 2, 'rows ' + sv1.rows);
  ok('how much of what the network received the site caught, and what only it heard', /Of all the network stored\s*9 of 15 \(60%\)/.test(sv1.text) && /9 \/ 10\s*90%/.test(sv1.text) && /Heard only here\s*21/.test(sv1.text), sv1.text.match(/Of all the network stored.{0,40}/) + ' / ' + (sv1.text.match(/Heard only here.{0,10}/) || ''));
  ok('a line from the site to each station heard', sv1.lines >= 3, 'paths ' + sv1.lines);
  await page.evaluate(() => Reception.setSurveyAll(true));
  ok('…and the station the site did not hear, when asked', await page.evaluate(() => document.querySelectorAll('[aria-labelledby="rx-h-svs"] tbody tr').length === 3));
  const csv = await page.evaluate(() => { let out = null; const keep = window.dlText; window.dlText = (n, c) => { out = { n, c }; }; try { Reception.exportSurveyCsv(); } finally { window.dlText = keep; } return out; });
  ok('the table exports as CSV', csv && /^site-survey-Mt-Test-candidate-repeater\.csv$/.test(csv.n) && csv.c.split('\n').filter(Boolean).length === 4 && /heard_pct/.test(csv.c), csv && csv.n);
  await page.evaluate(() => { Reception.closeSurvey(); Reception.setSurveyAll(false); Reception.setLocal(true); });
  ok('closing it clears the survey', await page.evaluate(() => !document.querySelector('[aria-labelledby="rx-h-svs"]') && Reception._state.db.length === 0));

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

if (failures) { console.log(`\nFAIL — ${failures} check(s) failed.`); process.exit(1); }
console.log('PASS — the Reception Map names the repeater a drive was built to blame, by pass ranges and by where its bad copies were loud, keeps its rules on the stored readings, and lays a site survey beside what the network received.');
