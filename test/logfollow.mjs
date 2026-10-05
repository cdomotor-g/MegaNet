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
//   * a Raspberry Pi's log (sdr-pi/relay.js, run here on the demo band)
//     dropped on the tab: recognised, an RTL-SDR card in the generic card's
//     place; the readings in its history shown with no time and never timed
//     "now"; live records timed by the Pi's uptime once two seconds of them
//     have settled it — a reading the Pi queued before PuTTY opened the port
//     timed when it was heard, not when it arrived; the controls copying
//     commands for PuTTY, three changes waiting as one CFG line, and the Pi's
//     CFG answer clearing them; several channels from its one stick — the
//     Channels box copying the tuning that hears them all, a chip, a band and
//     the readings' channel for each, a rate too low for them refused, and a
//     log joined after the Pi's last CFG reading its channels off STAT
//
// Run:  npm run logfollow
//       npm run logfollow -- -v    also print what passed

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

const require = createRequire(import.meta.url);
const SdrPi = require(path.join(REPO_ROOT, 'sdr-pi.js'));

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
  const card = () => page.evaluate(() => Serial.list().filter(c => c.entries).map(c => ({ id: c.id, kind: c.kind, phase: c.phase, source: c.source,
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

  // ── a Raspberry Pi's log ───────────────────────────────────────────────────
  // The relay itself, on the demo band, writes the log's history: what PuTTY
  // would have recorded before the log was dropped.
  fs.writeFileSync(file('demo_240k.iq8'), require(path.join(REPO_ROOT, 'alert-dsp.js')).demoBand());
  const relay = spawnSync(process.execPath, [path.join(REPO_ROOT, 'sdr-pi/relay.js'), '--stdio', '--no-title', '--state', 'none',
    '--file', file('demo_240k.iq8'), '--speed', '0', '--exit-after-file'], { input: '', timeout: 60000, maxBuffer: 1 << 24 });
  ok('the relay writes a log to follow', relay.status === 0 && relay.stdout.length > 1000, String(relay.stderr || '').slice(-300));
  fs.writeFileSync(file('sdr-pi.log'), Buffer.concat([Buffer.from(BANNER), relay.stdout]));
  await page.evaluate(() => Serial.addConnection());
  const gid = await page.evaluate(() => Serial.list()[Serial.list().length - 1].id);
  await page.evaluate(id => Serial.setSource(id, 'file'), gid);
  await dropFiles(`#ser-card-${gid}`, [file('sdr-pi.log')]);
  await waitFor(() => Serial.list().some(c => c.kind === 'sdr' && c.source === 'pi' && c.readings.length === 5), null,
    'a Pi\'s log becomes an RTL-SDR card with the five demo readings');
  const pid = await page.evaluate(() => (Serial.list().find(c => c.kind === 'sdr' && c.source === 'pi') || {}).id);
  if (pid) {
    const p1 = await page.evaluate(([id, gid]) => {
      const c = SerialSdr && Serial.findConn(id);
      return { replaced: !Serial.findConn(gid), phase: c.phase, untimed: c.readings.every(r => r.t == null),
        ids: c.readings.map(r => r.sensorId + '=' + r.value).sort().join(' '), name: (c.readings.find(r => r.sensorId === 2088) || {}).name,
        freq: c.cfg.freq, fmt: c.cfg.format, host: c.pi.info && c.pi.info.host, notes: c.notes.map(n => n.text).join(' | '),
        dash: document.getElementById('ser-card-' + id).textContent, rows: document.querySelectorAll('#sdr-read-' + id + ' tr').length };
    }, [pid, gid]);
    ok('…in the generic card\'s place, following, and saying it recognised the log', p1.replaced && p1.phase === 'follow' && /Recognised a Raspberry Pi/.test(p1.notes), p1.notes);
    ok('…every reading decoded on the Pi, named (MegaNet\'s name first, else the Pi\'s)', p1.ids === '2088=143 2442=23 2443=142 4109=1290 4110=12' && /marburg/i.test(p1.name || ''), p1.ids + ' / ' + p1.name);
    ok('…the history\'s readings untimed (the Pi\'s clock was not set), never "now"', p1.untimed && p1.rows === 5);
    ok('…the Pi\'s settings and identity read off its CFG and SDRPI lines', p1.freq === 151500000 && p1.fmt === 'BINARY' && !!p1.host);
    ok('…its chips say what the Pi is and how it is followed', /Pi clock/.test(p1.dash) && /following/.test(p1.dash));
    ok('…no FM audio or AFSK tones panel', await page.evaluate(id => !document.getElementById('sdr-scope-' + id) && !document.getElementById('sdr-tones-' + id), pid));

    // Live: a Pi that restarted (a new run), talking as PuTTY appends. The
    // first piece carries a reading the Pi queued 3.5 s before the burst after
    // it; nothing may be timed until two seconds of the Pi's uptime have been
    // seen against this computer's clock.
    const run = 'beefcafe';
    const rec = (t, o) => SdrPi.record(t, Object.assign({ run }, o));
    const hide = l => SdrPi.hide(l);
    const lvl = up => hide(rec('LVL', { up, ch_dbfs: -95, nf_dbfs: -101, open: false, dbfs: -30, clip_pct: 0, hist: 'AAAAAAAAAABBEHJb//bJHEBAAAAAAAAA' }));
    const append = parts => fs.appendFileSync(file('sdr-pi.log'), parts.join(''));
    append([SdrPi.kvRecord('SDRPI', { version: SdrPi.VERSION, schema: 1, run, host: 'meganet-pi', model: 'RTL-SDR Blog V4', tuner: 'R828D',
      min_hz: 500000, max_hz: 1766000000, bias_tee: true, direct: false, upconverter: true }) + '\r\n',
      rec('RX', { seq: 1, up: 500, id: 2088, value: 143, fmt: 'ABF', votes: 26, pol: 'STD', hex: '6860DEC4', peak_dbfs: -40, nf_dbfs: -101, burst_ms: 300, freq_hz: 151500000 }) + '\r\n',
      lvl(1000), hide(rec('STAT', { up: 1000, state: 'streaming', freq_hz: 151500000, offset_hz: 0, rate: 240000, in_rate: 240000, gain: '29.7',
        fmt: 'ABF', gate: 1, squelch: 8, clock: '', temp_c: 48.2, cpu_pct: 21, model: 'RTL-SDR Blog V4', tuner: 'R828D' }))]);
    await page.waitForTimeout(1500);
    ok('a live reading waits until the Pi\'s uptime is settled against this clock',
      await page.evaluate(id => { const c = Serial.findConn(id); return c.readings.length === 5 && c.pi.pending.length === 1; }, pid));
    await page.waitForTimeout(1200);
    append([lvl(3700)]);
    await page.waitForTimeout(1300);
    append([rec('BURST', { seq: 1, up: 4000, ms: 410, peak_dbfs: -61.5, nf_dbfs: -101, freq_hz: 151500000 }) + '\r\n',
      rec('RX', { seq: 2, up: 4000, id: 4079, value: 420, fmt: 'EIF', votes: 25, pol: 'STD', crc: 1, hex: 'EF3FD208', burst: 1, peak_dbfs: -61.5, nf_dbfs: -101, burst_ms: 410, freq_hz: 151500000 }) + '\r\n',
      hide(rec('TRACE', { up: 4600, burst: 1, ms: 380, combos: 45, seconds: 1.2, all: 1, carrier_hz: -300, start: 0, frames: '30:4079:420:0', shadows: '', symbols: 'yz0'.repeat(40) }))]);
    await waitFor(id => Serial.findConn(id).readings.some(r => r.sensorId === 4079), pid, 'a live reading arrives');
    const p2 = await page.evaluate(id => {
      const c = Serial.findConn(id), now = Date.now();
      const r = c.readings.find(x => x.sensorId === 4079), q = c.readings.filter(x => x.sensorId === 2088).find(x => x.t != null);
      const b = c.bursts.find(x => x.seq === 1 && x.run === 'beefcafe');
      return { t: r && r.t, now, queued: q && q.t, burst: b && b.decoded, trace: c.trace && c.trace.frames.length, pending: c.pi.pending.length,
        restarted: c.notes.some(n => /started again/.test(n.text)), tuner: c.info && c.info.tuner, chips: document.getElementById('sdr-chips-' + id).textContent };
    }, pid);
    ok('…timed by the Pi\'s uptime, within a few seconds of now', p2.t != null && Math.abs(p2.now - p2.t) < 6000, `${p2.now - p2.t} ms ago`);
    ok('…and the reading the Pi queued is timed when it was heard, 3.5 s earlier', p2.queued != null && Math.abs((p2.t - p2.queued) - 3500) < 600,
      `${p2.t - p2.queued} ms apart`);
    ok('…its burst marked decoded, its trace drawn, nothing left waiting', p2.burst === true && p2.trace === 1 && p2.pending === 0);
    ok('…the restart and the new stick noticed', p2.restarted && p2.tuner === 'R828D' && /meganet-pi/.test(p2.chips) && /not set/.test(p2.chips), p2.chips);

    // The controls copy commands; changes wait together; the Pi's CFG clears them.
    await page.evaluate(id => { document.getElementById('sdr-freq-' + id).value = '151.5125'; SerialSdr.setFreq(id); }, pid);
    await page.evaluate(id => SerialSdr.setFormat(id, 'ENHANCED_IFLOWS'), pid);
    await page.evaluate(id => SerialSdr.setSquelch(id, 10), pid);
    await page.waitForTimeout(300);
    const p3 = await page.evaluate(id => {
      const c = Serial.findConn(id), w = document.getElementById('sdr-want-' + id);
      return { notes: c.notes.map(n => n.text), want: Object.keys(c.pi.want).sort().join(','), banner: w && !w.hidden && w.textContent, freq: c.cfg.freq };
    }, pid);
    ok('a control copies its command for PuTTY', p3.notes.some(t => /Copied “FREQ 151\.512500”/.test(t)), p3.notes.slice(-3).join(' | '));
    ok('…three changes wait together and copy as one CFG line', p3.notes.some(t => /Copied “CFG freq=151\.512500 fmt=EIF squelch=10”/.test(t)) && p3.want === 'fmt,freq,squelch',
      p3.notes.slice(-1)[0]);
    ok('…shown as waiting, while the card still shows what the Pi has', /Waiting for the Pi/.test(p3.banner || '') && p3.freq === 151500000, p3.banner);
    append([SdrPi.cfgRecord(Object.assign(SdrPi.defaults(), { freq: 151512500, fmt: 'EIF', squelch: 10 })) + '\r\nOK\r\n']);
    await waitFor(id => { const c = Serial.findConn(id); return !Object.keys(c.pi.want).length && c.cfg.freq === 151512500 && c.cfg.format === 'ENHANCED_IFLOWS'; },
      pid, 'the Pi\'s CFG answer clears what was waiting, and the card follows the Pi');
    ok('…the waiting banner gone', await page.evaluate(id => document.getElementById('sdr-want-' + id).hidden, pid));
    append(['ERR,RANGE this stick tunes 0.5 to 1766 MHz\r\n']);
    await waitFor(id => Serial.findConn(id).notes.some(n => /refused a command: RANGE/.test(n.text)), pid, 'a command the Pi refuses is said on the card');

    // Several channels from the one stick: the Channels box works out the
    // tuning that hears them all, as the Pi's CHANNELS does, and copies it as
    // one CFG line; the Pi's answer gives each channel a chip, a band, and its
    // readings their channel; a change that would leave one outside the band
    // is refused on the card, as the Pi would refuse it.
    const typed = '151.5/ABF 151.525 151.95/EIF 152.4';
    const plan = SdrPi.planChannels(SdrPi.parseChannels(typed, SdrPi.MAX_CHANNELS).value).value;
    await page.evaluate(([id, v]) => { document.getElementById('sdr-chans-' + id).value = v; SerialSdr.setChannels(id); }, [pid, typed]);
    await page.waitForTimeout(300);
    const p4 = await page.evaluate(id => { const c = Serial.findConn(id); return { notes: c.notes.map(n => n.text), want: Object.keys(c.pi.want).join(',') }; }, pid);
    ok('the Channels box copies the tuning that hears them all, as one CFG line', p4.want === 'freq,rate,offset,more,fmt'
      && p4.notes.some(t => t.includes('Copied “CFG freq=151.850000 rate=1920000 offset=-350 more=151.525;151.950/EIF;152.400 fmt=ABF”')), p4.notes.slice(-2).join(' | '));
    ok('…saying where it tunes the stick, and why there', p4.notes.some(t => t.startsWith('For 4 channels the stick is tuned to 151.8500 MHz at 1.92 Msps: '
      + 'the nearest channel 100 kHz from its DC spike and 200 kHz from any mirror image')), p4.notes.join(' | '));
    const chans = SdrPi.packChans([{ hz: 151500000, fmt: 'ABF' }, { hz: 151525000, fmt: 'ABF', bursts: 1, readings: 1 },
      { hz: 151950000, fmt: 'EIF', bursts: 1, readings: 1 }, { hz: 152400000, fmt: 'ABF' }]);
    append([SdrPi.cfgRecord(Object.assign(SdrPi.defaults(), { squelch: 10, freq: plan.freq, rate: plan.rate, offset: plan.offset, fmt: 'ABF', more: plan.more })) + '\r\nOK\r\n',
      rec('RX', { seq: 3, up: 9000, id: 2443, value: 142, fmt: 'ABF', votes: 30, pol: 'STD', hex: '6860DEC4', peak_dbfs: -50, nf_dbfs: -100, burst_ms: 300, freq_hz: 151525000 }) + '\r\n',
      rec('RX', { seq: 4, up: 9100, id: 4079, value: 421, fmt: 'EIF', votes: 30, pol: 'STD', crc: 1, hex: 'EF3FD208', peak_dbfs: -55, nf_dbfs: -100, burst_ms: 400, freq_hz: 151950000 }) + '\r\n',
      hide(rec('STAT', { up: 9500, state: 'streaming', freq_hz: plan.freq, offset_hz: plan.offset, rate: plan.rate, in_rate: plan.rate, gain: '29.7',
        fmt: 'ABF', gate: 1, squelch: 10, clock: '', chans }))]);
    await waitFor(id => { const c = Serial.findConn(id); return !Object.keys(c.pi.want).length && c.cfg.more.length === 3 && c.readings.some(r => r.freqHz === 151950000); },
      pid, 'the Pi\'s answer: four channels, and a reading from two of them');
    await page.waitForTimeout(300);
    const p5 = await page.evaluate(id => {
      const c = Serial.findConn(id);
      return { chips: document.getElementById('sdr-chips-' + id).textContent, box: document.getElementById('sdr-chans-' + id).value,
        rows: [...document.querySelectorAll('#sdr-read-' + id + ' tr')].slice(0, 2).map(tr => tr.textContent),
        spec: document.getElementById('sdr-spec-' + id).getAttribute('aria-label') || '', chans: c.pi.chans.map(ch => ch.readings).join(',') };
    }, pid);
    ok('…a chip for each channel, with the readings heard on it', /Channel 1151\.500 MHz \(-350 kHz\) · \d+ readings/.test(p5.chips)
      && /Channel 2151\.525 MHz · 1 reading(?!s)/.test(p5.chips) && /Channel 3151\.950 MHz EIF · 1 reading(?!s)/.test(p5.chips)
      && /Channel 4152\.400 MHz · 0 readings/.test(p5.chips) && /Channel 1 power/.test(p5.chips), p5.chips);
    ok('…the Channels box showing them, each in its own format only where that is not the stick\'s', p5.box === '151.500 151.525 151.950/EIF 152.400', p5.box);
    ok('…each reading saying which channel it came in on', /151\.950 MHz/.test(p5.rows[0] || '') && /151\.525 MHz/.test(p5.rows[1] || ''), p5.rows.join(' | '));
    ok('…the spectrum naming them', /Decoding 4 channels: 151\.500, 151\.525, 151\.950, 152\.400 MHz/.test(p5.spec), p5.spec);
    ok('…and STAT\'s count for each read', p5.chans === '0,1,1,0', p5.chans);
    await page.evaluate(id => SerialSdr.setRate(id, 240000), pid);
    const p6 = await page.evaluate(id => { const c = Serial.findConn(id); return { notes: c.notes.map(n => n.text), want: Object.keys(c.pi.want).length }; }, pid);
    ok('a rate too low for the channels is refused on the card, pointing at the Channels box', p6.want === 0
      && p6.notes.some(t => /^151\.500 MHz would be 350 kHz from where the stick is tuned, and at 240 ksps a channel must be within 108 kHz of it\. Type every channel into the Channels box/.test(t)),
      p6.notes.slice(-1)[0]);
    await page.evaluate(id => { document.getElementById('sdr-chans-' + id).value = '151.5 151.525 151.95 EIF 152.4'; SerialSdr.setChannels(id); }, pid);
    ok('the same channels typed again change nothing', await page.evaluate(id => {
      const c = Serial.findConn(id);
      return !Object.keys(c.pi.want).length && /nothing to send/.test(c.notes[c.notes.length - 1].text);
    }, pid));

    // A log joined after the Pi's last CFG: its channels read off STAT.
    await page.evaluate(() => Serial.addConnection('sdr'));
    const mid = await page.evaluate(() => Serial.list()[Serial.list().length - 1].id);
    await page.evaluate(id => SerialSdr.setWhere(id, 'pi'), mid);
    fs.writeFileSync(file('sdr-pi-mid.log'), BANNER + SdrPi.kvRecord('SDRPI', { version: SdrPi.VERSION, schema: 1, run: 'feedf00d', host: 'meganet-pi-2' }) + '\r\n'
      + SdrPi.hide(SdrPi.record('STAT', { run: 'feedf00d', up: 5000, state: 'streaming', freq_hz: plan.freq, offset_hz: plan.offset, rate: plan.rate,
        fmt: 'ABF', gate: 1, squelch: 8, chans })) + 'MegaNet SDR Pi - streaming\r\n');
    await dropFiles(`#ser-card-${mid}`, [file('sdr-pi-mid.log')]);
    await waitFor(id => { const c = Serial.findConn(id); return c && c.pi && c.pi.stat && c.cfg.more.length === 3; }, mid,
      'a log joined after the Pi\'s last CFG: its channels read off STAT');
    ok('…each in its own format only where that is not the stick\'s', await page.evaluate(id => SdrPi.channelsText(Serial.findConn(id).cfg.more) === '151.525;151.950/EIF;152.400', mid));
    await page.evaluate(id => Serial.removeConn(id), mid);
  }

  // Dropped anywhere on the tab while an RTL-SDR card waits for a Pi's log: a
  // radio's log is not given to it; a Pi's log is, and no other card is made.
  await page.evaluate(() => Serial.addConnection('sdr'));
  const wid = await page.evaluate(() => Serial.list()[Serial.list().length - 1].id);
  await page.evaluate(id => SerialSdr.setWhere(id, 'pi'), wid);
  const radios = await page.evaluate(() => Serial.list().filter(c => c.kind === 'quansheng').length);
  fs.writeFileSync(file('radio-2.log'), BANNER + RADIO.join('\r\n') + '\r\n');
  await dropFiles('.serial .panel-header h2', [file('radio-2.log')]);
  await waitFor(n => Serial.list().filter(c => c.kind === 'quansheng').length === n + 1, radios,
    'a radio\'s log dropped on the tab, with an RTL-SDR card waiting for a Pi, still becomes a radio card');
  ok('…and the RTL-SDR card is still waiting', await page.evaluate(id => Serial.findConn(id).phase === 'setup', wid));
  const count = await page.evaluate(() => Serial.list().length);
  fs.writeFileSync(file('sdr-pi-2.log'), Buffer.concat([Buffer.from(BANNER), relay.stdout]));
  await dropFiles('.serial .panel-header h2', [file('sdr-pi-2.log')]);
  await waitFor(id => { const c = Serial.findConn(id); return c && c.phase === 'follow' && c.source === 'pi' && c.readings.length === 5; }, wid,
    'a Pi\'s log dropped on the tab goes to the RTL-SDR card waiting for one');
  ok('…and no other card is made for it', await page.evaluate(n => Serial.list().length === n, count), String(await page.evaluate(() => Serial.list().length)) + ' vs ' + count);

  // A log PuTTY has only just started — nothing from the Pi in it yet — dropped
  // beside an RTL-SDR card waiting for a Pi: the card takes it, and reads the Pi
  // as it starts talking.
  await page.evaluate(() => Serial.addConnection('sdr'));
  const nid = await page.evaluate(() => Serial.list()[Serial.list().length - 1].id);
  await page.evaluate(id => SerialSdr.setWhere(id, 'pi'), nid);
  fs.writeFileSync(file('sdr-pi-new.log'), BANNER);
  await dropFiles('.serial .panel-header h2', [file('sdr-pi-new.log')]);
  await waitFor(id => { const c = Serial.findConn(id); return c && c.phase === 'follow' && c.source === 'pi'; }, nid,
    'a still-empty log dropped beside a card waiting for a Pi goes to that card');
  ok('…which does not claim to have recognised it', await page.evaluate(id => !Serial.findConn(id).notes.some(n => /Recognised/.test(n.text)), nid));
  // What is in the file at the card's first look is history; the Pi starts
  // talking after it.
  await waitFor(id => Serial.findConn(id).pi.follow.follower.offset > 0, nid, '…and has read what is in it so far');
  fs.appendFileSync(file('sdr-pi-new.log'), relay.stdout);
  await waitFor(id => { const c = Serial.findConn(id); return c.pi.info && c.pi.info.version && c.pi.pending.length > 0; }, nid,
    '…and reads the Pi as it starts talking, its readings held until their time is settled');

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
console.log('PASS — a log PuTTY writes is followed as it grows, by drop where the picker is blocked, on every serial card, the RTL-SDR card following a Raspberry Pi, and the ALERT2 tab.');
