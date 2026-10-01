// Following the log file PuTTY writes, instead of a COM port (log-follow.js) —
// the Serial Monitor's log-file source, its ERT-A2 card, and the ALERT2 tab's
// Watch.
//
// Written because the first attempt at this failed in a way nothing caught: a
// log picked with <input type=file> reads once, and the second read throws
// NotReadableError the moment PuTTY has written another line. And because the
// machine this exists for is the one where the obvious fix is switched off —
// a managed Chrome or Edge with DefaultFileSystemReadGuardSetting = 2, where
// showOpenFilePicker() and FileSystemFileHandle.getFile() both answer
// NotAllowedError.
//
// So the whole check runs under that policy, emulated by an init script that
// makes both reject exactly as Chromium does (measured on Chromium 141 with the
// real policy installed; the numbers are in log-follow.js's header). Every file
// goes in the way an operator's would: a real file on disk, dropped onto the
// page through CDP's Input.dispatchDragEvent — a real drag, with a real
// isolated file system behind it, not a synthetic DataTransfer — and then
// grown, truncated and replaced on disk while the page watches.
//
//   * the premise: a picked File cannot be read again once the file changes
//     (printed, not asserted — it is Chromium's behaviour, not ours)
//   * a generic card: the source choice, a drop onto the card, lines arriving
//     as the file grows, Stop following / Follow again resuming without a line
//     read twice, PuTTY's "overwrite" (the file getting shorter) read from the top
//   * a Quansheng radio's log dropped anywhere on the tab: recognised from its
//     contents, the dashboard filled, nothing ever written to a port, the
//     console copying instead of sending, and a reply typed in PuTTY (GET)
//     read into the settings as it passes through the log
//   * an ERT-A2's RS232 log: recognised, every reading decoded and matched to
//     a station, a new line arriving as a new reading, and "Open in the ALERT2
//     tab" handing over exactly the frames heard
//   * an ERT-A2's USB port logged raw ("All session output"): the binary
//     framing, with RSSI
//   * a dropped folder: the newest log in it followed, and a new session's
//     file taken up by itself
//   * "Read it once": only the bytes added since the last pick
//   * the picker refused by policy, and saying so with the way round it
//   * the ALERT2 tab watching a dropped log as it grows
//   * a file dropped beside the target does not navigate the page away, and
//     goes to the card waiting for a log
//
// Run:  npm run logfollow
//       npm run logfollow -- -v    also print what passed

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const WAIT = 10_000;

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-follow-'));
const file = name => path.join(DIR, name);
const BANNER = '=~=~=~=~=~=~=~=~=~=~=~= PuTTY log 2026.10.01 09:00:00 =~=~=~=~=~=~=~=~=~=~=~=\r\n';

// What Chromium does under DefaultFileSystemReadGuardSetting = 2.
const POLICY = `(() => {
  const refuse = () => Promise.reject(new DOMException(
    'The request is not allowed by the user agent or the platform in the current context.', 'NotAllowedError'));
  window.showOpenFilePicker = function showOpenFilePicker() { return refuse(); };
  if (window.FileSystemFileHandle) FileSystemFileHandle.prototype.getFile = function getFile() { return refuse(); };
})();`;

const RADIO = [
  'HDR,fw,4d06107f,schema,2',
  'HDR,DEC,seq,epoch,uptime_ms,boot,id,name,kind,value,eng,unit,fmt,pol,inv,frame,rssi,nf,sens,fade,burst_ms,payload_hex,payload_bin',
  'HDR,STA,epoch,uptime_ms,nf,rssi,sq,batt_mv,batt_pct,bursts,decodes,min_ok,log_state,log_count,log_cap,stn_src',
  'DEC,1041,1790843886,187340,12,2088,MARBURG,BATT,143,14.3,V,ABF,STD,1,0,-20,-121,-109,89,412,16067B23,00010110000001100111101100100011',
  'DEC,1042,1790843919,220510,12,2443,KINGSHOLME MO,BATT,142,14.2,V,ABF,STD,1,0,-47,-121,-109,62,530,D2663B23,11010010011001100011101100100011',
  'STA,1790843970,270000,-121,-124,0,7890,78,16,18,-104,OK,1045,5969,BUILTIN MegaNet:95f6f8d',
];
const RADIO_MORE = 'DEC,1044,1790843962,263880,12,4109,ROTHWELL,RAIN,1290,1290,tips,ABF,STD,1,0,-88,-121,-109,21,455,B202AB17,10110010000000101010101100010111';

// Real lines off a test ERT-A2's RS232 port (the ALERT2 tab's own sample, less
// the terminal-wrapped one, which a log never holds).
const ERT = [
  'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,10,41.296,0,0,0,0,0,1,0,0,0,7,7,9999,74,64,F0,7E,18,15,00',
  'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,19,28,32.582,0,0,0,0,0,1,0,0,0,7,11,9999,74,69,20,2D,13,8A,00,2C,13,0C,00',
  'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,20,19,13.761,0,0,0,0,0,1,0,0,0,7,11,9999,74,75,00,B5,08,84,00,24,08,08,00',
];
const ERT_MORE = 'ALERT2A,1,9999,ELPRO,N,1,2026,6,8,21,14,57.981,0,0,0,0,0,1,0,0,0,7,7,9999,74,86,1C,0E,10,0A,00';

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(POLICY);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));
  const cdp = await context.newCDPSession(page);

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  // A real drag of real files from the OS, dropped on the middle of `sel`.
  async function dropFiles(sel, files) {
    const loc = page.locator(sel).first();
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    const x = b.x + Math.min(b.width / 2, 200), y = b.y + Math.min(b.height / 2, 30);
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
  }
  const waitFor = (fn, arg, what) => page.waitForFunction(fn, arg, { timeout: WAIT }).then(() => true, () => {
    ok(what, false, 'timed out after ' + WAIT / 1000 + ' s');
    return false;
  });
  const card = () => page.evaluate(() => Serial.list().map(c => ({ id: c.id, kind: c.kind, phase: c.phase, source: c.source,
    lines: c.entries.filter(e => !e.sys).map(e => e.raw), sys: c.entries.filter(e => e.sys).map(e => e.raw), label: c.portLabel })));

  // ── the premise ────────────────────────────────────────────────────────────
  fs.writeFileSync(file('premise.log'), 'one\r\n');
  await page.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'lf-premise'; i.hidden = true; document.body.appendChild(i); });
  await page.setInputFiles('#lf-premise', file('premise.log'));
  const first = await page.evaluate(() => document.getElementById('lf-premise').files[0].text().then(t => t, e => e.name));
  fs.appendFileSync(file('premise.log'), 'two\r\n');
  const second = await page.evaluate(() => document.getElementById('lf-premise').files[0].text().then(t => 'read: ' + JSON.stringify(t), e => e.name));
  console.log(`  note a picked File after the file grew: ${second} (first read ${JSON.stringify(first)}) — why a dropped file is followed instead`);

  // ── a generic card ─────────────────────────────────────────────────────────
  await page.evaluate(() => { switchTab('serial'); Serial.addConnection(); });
  let cid = await page.evaluate(() => Serial.list()[0].id);
  await page.click(`#ser-card-${cid} input[name="ser-src-${cid}"][value="file"]`);
  ok('choosing "a log file" swaps the port settings for the drop zone',
    await page.evaluate(id => !!document.getElementById('ser-drop-' + id) && !document.getElementById('ser-port-status-' + id), cid));
  fs.writeFileSync(file('generic.log'), BANNER + 'stage=1.21 batt=13.4\r\nstage=1.22 batt=13.4\r\n');
  await dropFiles(`#ser-card-${cid}`, [file('generic.log')]);
  await waitFor(id => { const c = Serial.findConn(id); return c && c.phase === 'follow' && c.entries.some(e => e.raw === 'stage=1.22 batt=13.4'); }, cid,
    'a log dropped on the card is followed and its history read');
  let c = (await card())[0];
  ok('the card says what it follows', /generic\.log/.test(c.label) && await page.evaluate(id => /following/.test(document.getElementById('ser-card-' + id).textContent), cid), c.label);
  fs.appendFileSync(file('generic.log'), 'stage=1.23 batt=13.3\r\n');
  await waitFor(id => Serial.findConn(id).entries.some(e => e.raw === 'stage=1.23 batt=13.3'), cid, 'a line PuTTY appends arrives');
  await page.evaluate(id => Serial.stopFollow(id), cid);
  fs.appendFileSync(file('generic.log'), 'stage=1.24 batt=13.3\r\n');
  await page.waitForTimeout(1500);
  ok('nothing is read after Stop following', !(await card())[0].lines.includes('stage=1.24 batt=13.3'));
  ok('Follow again is offered', await page.evaluate(id => /Follow again/.test(document.getElementById('ser-card-' + id).textContent), cid));
  await page.evaluate(id => Serial.followAgain(id), cid);
  await waitFor(id => Serial.findConn(id).entries.some(e => e.raw === 'stage=1.24 batt=13.3'), cid, 'Follow again reads what was written meanwhile');
  c = (await card())[0];
  ok('…and reads nothing twice', c.lines.filter(l => l === 'stage=1.23 batt=13.3').length === 1, JSON.stringify(c.lines));
  fs.writeFileSync(file('generic.log'), BANNER + 'fresh=1\r\n');
  await waitFor(id => Serial.findConn(id).entries.some(e => e.raw === 'fresh=1'), cid, 'a log PuTTY started again is read from the top');
  c = (await card())[0];
  ok('…and says so', c.sys.some(t => /got shorter/.test(t)), c.sys.slice(-3).join(' | '));

  // ── a Quansheng radio's log, dropped anywhere on the tab ───────────────────
  await page.evaluate(() => { window.__tx = 0; Serial.writeText = () => { window.__tx++; return Promise.reject(new Error('no port')); }; });
  fs.writeFileSync(file('radio.log'), BANNER + RADIO.join('\r\n') + '\r\n');
  await dropFiles('.serial .panel-header h2', [file('radio.log')]);
  await waitFor(() => Serial.list().some(c => c.kind === 'quansheng' && c.phase === 'follow' && c.radio && c.radio.decs.length === 2), null,
    'a radio\'s log dropped on the tab becomes a followed Quansheng card with its readings');
  const rid = await page.evaluate(() => (Serial.list().find(c => c.kind === 'quansheng') || {}).id);
  if (rid) {
    ok('the card was recognised from the log\'s contents', await page.evaluate(id => Serial.findConn(id).recognised === 'contents', rid));
    ok('the readings table is drawn', await page.evaluate(id => document.querySelectorAll('#qs-dec-' + id + ' tr').length >= 2, rid));
    fs.appendFileSync(file('radio.log'), RADIO_MORE + '\r\nGET,LOG,OFF\r\n');
    await waitFor(id => Serial.findConn(id).radio.decs.length === 3, rid, 'a reading the radio logs later arrives');
    await waitFor(id => Serial.findConn(id).radio.settings.LOG === 'OFF', rid, 'a reply typed for in PuTTY is read into the settings');
    const ui = await page.evaluate(id => {
      const el = document.getElementById('ser-card-' + id);
      return { text: el.textContent, send: [...el.querySelectorAll('.qs-quick button')].every(b => !b.disabled) };
    }, rid);
    ok('the console copies for PuTTY instead of sending', /Copy for PuTTY/.test(ui.text) && /Copy clock command/.test(ui.text) && !/Sync clock/.test(ui.text) && ui.send);
    await page.evaluate(id => SerialRadio.quick(id, 'INFO'), rid);
    await page.waitForTimeout(200);
    ok('nothing is ever written to a port while following', await page.evaluate(() => window.__tx === 0), 'writes: ' + await page.evaluate(() => window.__tx));
    ok('pressing a console button says what to paste', await page.evaluate(id => Serial.findConn(id).radio.notes.some(n => /INFO/.test(n.text)), rid));
  }

  // ── an ERT-A2's RS232 log ──────────────────────────────────────────────────
  fs.writeFileSync(file('ert.log'), BANNER + ERT.join('\r\n') + '\r\n');
  await dropFiles('.serial .panel-header h2', [file('ert.log')]);
  await waitFor(() => Serial.list().some(c => c.kind === 'ert' && c.ert && c.ert.frames === 3), null,
    'an ERT-A2\'s log dropped on the tab becomes a followed ERT-A2 card');
  const eid = await page.evaluate(() => (Serial.list().find(c => c.kind === 'ert' && c.ert && c.ert.fmt === 'ascii') || {}).id);
  if (eid) {
    const e1 = await page.evaluate(id => {
      const c = Serial.findConn(id);
      return { recs: c.ert.recs.length, rows: document.querySelectorAll('#ert-dec-' + id + ' tr').length,
        named: document.querySelectorAll('#ert-dec-' + id + ' .a2-stlink').length, fmt: c.ert.fmt,
        status: document.getElementById('ert-status-' + id).textContent };
    }, eid);
    ok('every reading decoded and drawn', e1.recs === 5 && e1.rows === 5, JSON.stringify(e1));
    ok('readings matched to stations', e1.named > 0, 'named rows: ' + e1.named);
    ok('read as the RS232 protocol, receiver clock reported', e1.fmt === 'ascii' && /RS232/.test(e1.status) && /Receiver clock/.test(e1.status), e1.status);
    fs.appendFileSync(file('ert.log'), ERT_MORE + '\r\n');
    await waitFor(id => Serial.findConn(id).ert.recs.length === 6, eid, 'a frame the unit logs later arrives as a reading');
    await page.evaluate(id => SerialErt.openInTab(id), eid);
    const handed = await page.evaluate(() => ({ tab: state.activeTab, frames: (Alert2.parse(state.a2.text, 'auto').frames || []).length }));
    ok('Open in the ALERT2 tab hands over exactly the frames heard', handed.tab === 'alert2' && handed.frames === 4, JSON.stringify(handed));
    await page.evaluate(() => switchTab('serial'));
  }

  // ── an ERT-A2's USB port, logged raw ───────────────────────────────────────
  const usb = await page.evaluate(() => Alert2.hexStream(Alert2.samples().bin).bytes);
  fs.writeFileSync(file('ert-usb.log'), Buffer.from(usb));
  await dropFiles('.serial .panel-header h2', [file('ert-usb.log')]);
  await waitFor(() => Serial.list().some(c => c.kind === 'ert' && c.ert && c.ert.fmt === 'bin' && c.ert.frames >= 8), null,
    'a raw USB log is read as the binary framing');
  const bin = await page.evaluate(() => {
    const c = Serial.list().find(c => c.kind === 'ert' && c.ert && c.ert.fmt === 'bin');
    return c ? { rssi: c.ert.recs.filter(r => r.rssi != null).length, recs: c.ert.recs.length, bad: c.ert.bad,
      cells: document.querySelectorAll('#ert-dec-' + c.id + ' .a2-rssi').length } : null;
  });
  ok('…with RSSI on every reading', bin && bin.recs > 0 && bin.rssi === bin.recs && bin.cells > 0 && bin.bad === 0, JSON.stringify(bin));

  // ── a dropped folder ───────────────────────────────────────────────────────
  const logs = path.join(DIR, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'putty-0900.log'), BANNER + 'session=1\r\n');
  fs.utimesSync(path.join(logs, 'putty-0900.log'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  fs.writeFileSync(path.join(logs, 'notes.ini'), 'not a log');
  await page.evaluate(() => Serial.addConnection());
  cid = await page.evaluate(() => Serial.list()[Serial.list().length - 1].id);
  await page.evaluate(id => Serial.setSource(id, 'file'), cid);
  await dropFiles(`#ser-card-${cid}`, [logs]);
  await waitFor(id => Serial.findConn(id).entries.some(e => e.raw === 'session=1'), cid, 'a dropped folder follows the log in it');
  fs.writeFileSync(path.join(logs, 'putty-1000.log'), BANNER + 'session=2\r\n');
  await waitFor(id => Serial.findConn(id).entries.some(e => e.raw === 'session=2'), cid, 'a new session\'s log in the folder is taken up by itself');
  c = (await card()).find(x => x.id === cid);
  ok('…and the card says it moved on', c && /putty-1000\.log/.test(c.label) && c.sys.some(t => /Now following putty-1000\.log/.test(t)), c && c.label);

  // ── "Read it once" ─────────────────────────────────────────────────────────
  await page.evaluate(() => Serial.addConnection());
  cid = await page.evaluate(() => Serial.list()[Serial.list().length - 1].id);
  await page.evaluate(id => Serial.setSource(id, 'file'), cid);
  fs.writeFileSync(file('manual.log'), 'm1\r\nm2\r\n');
  await page.setInputFiles(`#ser-file-${cid}`, file('manual.log'));
  await waitFor(id => Serial.findConn(id).entries.some(e => e.raw === 'm2'), cid, 'Read it once reads the file');
  fs.appendFileSync(file('manual.log'), 'm3\r\n');
  await page.setInputFiles(`#ser-file-${cid}`, file('manual.log'));
  await waitFor(id => Serial.findConn(id).entries.some(e => e.raw === 'm3'), cid, 'picking it again reads what was added');
  c = (await card()).find(x => x.id === cid);
  ok('…and only that', c && c.lines.filter(l => /^m\d$/.test(l)).join(',') === 'm1,m2,m3', c && c.lines.join(','));
  ok('the card says it reads on request', await page.evaluate(id => /read on request/.test(document.getElementById('ser-card-' + id).textContent), cid));

  // ── the picker, refused by policy ──────────────────────────────────────────
  await page.evaluate(() => Serial.addConnection());
  cid = await page.evaluate(() => Serial.list()[Serial.list().length - 1].id);
  await page.evaluate(id => Serial.setSource(id, 'file'), cid);
  await page.click(`#ser-card-${cid} button:has-text("Pick the log file")`);
  await waitFor(id => /switched off/.test(document.getElementById('ser-follow-status-' + id).textContent), cid, 'a picker refused by policy says so');
  ok('…and says to drag the file instead', await page.evaluate(id => /Drag the log file/.test(document.getElementById('ser-follow-status-' + id).textContent), cid));

  // ── a file let fall beside the target ──────────────────────────────────────
  // The card left waiting for a log above is where it goes.
  const before = page.url();
  await dropFiles('#app-nav, nav, header', [file('generic.log')]);
  await page.waitForTimeout(500);
  ok('a file dropped off the tab does not navigate the page away', page.url() === before && await page.evaluate(() => typeof Serial !== 'undefined'), page.url());
  await waitFor(id => Serial.findConn(id).phase === 'follow' && /generic\.log/.test(Serial.findConn(id).portLabel), cid,
    '…and is followed on the card waiting for a log');

  // ── the ALERT2 tab ─────────────────────────────────────────────────────────
  await page.evaluate(() => switchTab('alert2'));
  await page.click('button:has-text("Watch a log file")');
  await waitFor(() => /switched off/.test(document.body.textContent), null, 'the ALERT2 tab says the picker is switched off');
  fs.writeFileSync(file('a2.log'), BANNER + ERT.join('\r\n') + '\r\n');
  await dropFiles('.a2.page .panel-header h2', [file('a2.log')]);
  await waitFor(() => state.a2.watch && Alert2.parse(state.a2.text, 'auto').frames.length === 3, null, 'a log dropped on the ALERT2 tab is watched');
  fs.appendFileSync(file('a2.log'), ERT_MORE + '\r\n');
  await waitFor(() => Alert2.parse(state.a2.text, 'auto').frames.length === 4, null, '…and decoded as it grows');
  ok('…with the watch named on the tab', await page.evaluate(() => /Stop watching a2\.log/.test(document.body.textContent)));
  await page.evaluate(() => Alert2.stopWatching());

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(DIR, { recursive: true, force: true });
}

if (failures) { console.log(`\nFAIL — ${failures} check(s) failed.`); process.exit(1); }
console.log('PASS — a log PuTTY writes is followed as it grows, by drop where the picker is blocked, on every serial card and on the ALERT2 tab.');
