// The Reception Map (reception.js), the reception log every receiver card
// writes (reception-log.js), and the GPS card that places it (serial-gps.js).
//
// The method's oracle is a drive whose answer is known: Reception.demoDrive()
// builds one against the real registry — two real repeaters that relay the
// same stations, one of them made to flip a bit in a third of what it relays —
// and the check holds the analysis to naming that one, by pass ranges alone
// (positions stripped) and with positions (the bad copies loudest near it).
// Then the pieces an operator touches:
//
//   * NMEA: GGA and RMC from any talker, checksums enforced, hemispheres signed
//   * a GPS card fed a real NMEA stream: its fix, its accuracy, and that fix
//     stamped on what a receiver card hears — as 'gps', exact
//   * a receiver card's receptions logged, good and bad (an ERT-A2 status byte)
//   * the log exported as CSV and loaded back as a file, the same analysis out
//   * the tab drawing its map, a suspect picked, no page errors
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
    // two ERT-A2 frames: one clean, one with a status byte set
    Serial.feed(ec, new TextEncoder().encode('ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00\r\n'
      + 'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,42.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,01\r\n'));
  }, [gpsId, ertId]);
  const rx = await page.evaluate(() => RxLog.all().map(e => ({ src: e.location_source, approx: e.location_approx, lat: e.lat, acc: e.accuracy_m, ok: e.ok, fault: e.fault, rc: e.receiver })));
  ok('the GPS card has a fix, with accuracy from HDOP', await page.evaluate(g => { const f = SerialGps.fix(false); return f && Math.abs(f.lat + 27.5606) < 1e-3 && f.accuracy_m === 6; }, gpsId));
  ok('a receiver\'s receptions are logged, the bad one too', rx.length === 2 && rx.filter(e => e.ok).length === 1 && rx.some(e => e.fault === 'status'), JSON.stringify(rx));
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
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

if (failures) { console.log(`\nFAIL — ${failures} check(s) failed.`); process.exit(1); }
console.log('PASS — the Reception Map names the repeater a drive was built to blame, by pass ranges and by where its bad copies were loud.');
