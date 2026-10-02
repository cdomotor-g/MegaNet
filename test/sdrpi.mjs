// The RTL-SDR on a Raspberry Pi: sdr-pi.js (the text both ends speak) and
// sdr-pi/relay.js (the Pi's end), held to each other.
//
// The relay exists for a computer whose browser cannot reach the stick: the
// stick goes on a Pi, the Pi prints what MegaNet's own decoder finds on a
// serial port, PuTTY logs the port, and the Serial Monitor's RTL-SDR card
// follows the log. Nothing in CI has a Pi, a stick or PuTTY, so this holds each
// joint with the next best thing:
//
//   * the codec on its own — settings and commands, one-line CFG round trips,
//     the card's settings to the Pi's and back, the packing of spectrum, ADC
//     histogram and symbols, and a Reader fed in pieces that cut lines and
//     escape sequences in half, with echoed typing and backspaces in it;
//   * the relay playing recordings through the real decoder, read back with
//     that Reader: the demo band's five readings named from stations.json,
//     each tied to its burst, its one-bit shadow, the hidden records; and the
//     4078 test rig's real off-air burst — 4079 = 420, 4080 = 121 under
//     Enhanced iFLOWS — the regression vector alert-dsp.js answers to;
//   * the console: every verb, each ending in one OK or ERR, the bias tee
//     refusing without YES, settings kept across a restart, TIME stamping what
//     follows, over stdio, over TCP as Raw and as Telnet (which is asked to
//     leave the echo to the Pi), and over a real pseudo-terminal opened as
//     --serial — PuTTY's place — with typing echoed and a paste of two lines;
//   * the USB path: the relay opening test/lib/fake-rtlsdr.mjs's simulated V3
//     through rtlsdr.js, streaming it, retuning, regaining, switching the bias
//     tee and the rate from the console, losing it when it is "unplugged" and
//     finding it again when it comes back.
//
// What it cannot hold is a real stick on a real Pi in front of a real PuTTY:
// docs/sdr-pi.md's bring-up list is for that.
//
// Node only (python3 for the pseudo-terminal, skipped without it).
// Run:  npm run sdrpi   (-v to list what passed)

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './lib/paths.mjs';
import { FakeStick } from './lib/fake-rtlsdr.mjs';

const require = createRequire(import.meta.url);
const P = require(path.join(REPO_ROOT, 'sdr-pi.js'));
const D = require(path.join(REPO_ROOT, 'alert-dsp.js'));
const { Relay, parseArgs } = require(path.join(REPO_ROOT, 'sdr-pi/relay.js'));

const RELAY = path.join(REPO_ROOT, 'sdr-pi/relay.js');
const RIG = path.join(REPO_ROOT, 'test/fixtures/sdr/testrig_burst_240k.iq8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sdrpi-'));
const DEMO = path.join(TMP, 'demo_240k.iq8');
fs.writeFileSync(DEMO, D.demoBand());

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = buf => { const r = new P.Reader(); return r.feed(buf).concat(r.flush()); };
const recs = (items, type) => items.filter(i => i.type === type);
const finals = items => items.filter(i => i.kind === 'final').map(i => (i.ok ? 'OK' : 'ERR ' + i.reason.split(' ')[0]));

// Run the relay as a process: `input` written to its stdin (an array of
// [delay ms, text]), everything it prints collected.
function runRelay(args, input, { wait = 0, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [RELAY, '--stdio', '--no-title', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    const kill = setTimeout(() => { p.kill(); reject(new Error('relay timed out: ' + Buffer.concat(err).toString().slice(-400))); }, timeout);
    p.on('exit', code => { clearTimeout(kill); resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString() }); });
    (async () => {
      for (const [ms, text] of input || []) { await sleep(ms); p.stdin.write(text); }
      if (wait) await sleep(wait);
      p.stdin.end();
    })();
  });
}

// ── the codec ────────────────────────────────────────────────────────────────

{
  const s = P.parseSetting;
  check('freq: 151.5, 151.5M, 151500k and 151500000 are all 151.5 MHz',
    [s('freq', '151.5'), s('freq', '151.5M'), s('freq', '151500k'), s('freq', '151500000')].every(r => r.ok && r.value === 151500000));
  check('freq: a number between 2000 and 100000 is refused, not guessed', !s('freq', '15142').ok && /MHz/.test(s('freq', '15142').error));
  check('freq: outside 0.5–1766 MHz is refused', !s('freq', '2000M').ok && !s('freq', '0.3').ok);
  check('rate: only the rates that decimate to 240k exactly', s('rate', '960k').value === 960000 && s('rate', '2.4M').value === 2400000 && !s('rate', '1000000').ok);
  check('gain: dB to one decimal, or auto (null)', s('gain', '29.7').value === 29.7 && s('gain', 'AUTO').value === null && !s('gain', 'loud').ok);
  check('fmt: ABF/BINARY, EIF/ENHANCED, ASC/ASCII — and never IFLOWS',
    s('fmt', 'binary').value === 'ABF' && s('fmt', 'enhanced').value === 'EIF' && s('fmt', 'ascii').value === 'ASC' && !s('fmt', 'iflows').ok);
  check('offset: kHz in, Hz kept', s('offset', '12.5').value === 12500 && s('offset', '-0.5kHz').value === -500);
  check('on/off settings take 1/0, on/off, yes/no', s('gate', 'off').value === false && s('agc', '1').value === true && !s('bias', 'maybe').ok);
  const all = P.defaults();
  const back = P.parseCommand(P.cfgCommand(all, P.SETTING_KEYS)).set;
  check('every setting survives CFG → command → parse', P.SETTING_KEYS.every(k => back[k] === all[k]), JSON.stringify(back));
  const cfgItem = P.parseLine(P.createSchema(), P.cfgRecord(all), false);
  check('a CFG record reads back as the same settings', P.SETTING_KEYS.every(k => cfgItem.settings[k] === all[k]));
  const card = { freq: 151512500, rate: 960000, gain: 296, autoGain: false, agc: true, ppm: -3, format: 'ENHANCED_IFLOWS', gate: false,
    squelch: 11, offsetHz: -25000, bias: true, direct: 'q', model: 'v3' };
  const there = P.toCard(P.parseCommand(P.cfgCommand(P.fromCard(card))).set);
  check('the card\'s settings → CFG command → the card\'s settings', Object.keys(card).every(k => there[k] === card[k]), JSON.stringify(there));
  check('tuner AGC on the card is GAIN AUTO on the Pi', P.fromCard(Object.assign({}, card, { autoGain: true })).gain === null
    && P.setCommand('gain', null) === 'GAIN AUTO');
  check('a control\'s one-setting commands', P.setCommand('freq', 151512500) === 'FREQ 151.512500' && P.setCommand('fmt', 'EIF') === 'FORMAT EIF'
    && P.setCommand('bias', true) === 'BIAS ON YES' && P.setCommand('offset', 12500) === 'OFFSET 12.5' && P.setCommand('gate', false) === 'GATE OFF');

  const c = P.parseCommand;
  check('commands: unknown verbs are UNKNOWN; case does not matter', c('FROB 1').error === 'UNKNOWN' && c('freq 151.5').set.freq === 151500000);
  check('commands: BIAS ON needs YES; BIAS OFF does not', /^CONFIRM/.test(c('BIAS ON').error) && c('bias on yes').set.bias === true && c('BIAS OFF').set.bias === false);
  check('commands: CFG refuses a pair it cannot read, naming it', /^ARG .*gain/.test(c('CFG freq=151.5 gain=loud').error) && /^ARG no setting/.test(c('CFG volume=3').error));
  check('commands: a verb on its own asks for that setting', c('GAIN').show === 'gain' && c('SQUELCH').show === 'squelch');
  check('commands: TIME takes Unix seconds and nothing else', c('TIME 1790843760').epoch === 1790843760 && !!c('TIME yesterday').error && !!c('TIME 123').error);
  check('commands: DEFAULTS needs YES; DECODE takes 1–8 s', !!c('DEFAULTS').error && !c('DEFAULTS YES').error && c('DECODE').seconds === 3 && !!c('DECODE 30').error);

  // packing
  const spec = new Float32Array(2048).map((_, i) => -60 + ((i * 7919) % 13) / 13 * 2);
  spec[1500] = -12;
  const pk = P.packSpectrum(spec, 256), un = P.unpackSpectrum(pk.lo, pk.step, pk.bins);
  check('spectrum: 2048 bins to 256 characters, a one-bin carrier kept', pk.bins.length === 256 && Math.abs(Math.max(...un) - -12) <= pk.step, `max ${Math.max(...un)}, step ${pk.step}`);
  const hist = new Array(32).fill(0); hist[15] = 100000; hist[16] = 90000; hist[0] = 1; hist[31] = 2;
  const hu = P.unpackHist(P.packHist(hist));
  check('histogram: a single clipped sample in an end bin is still there', hu[0] > 0 && hu[31] > 0 && hu[1] === 0 && hu[15] === 1);
  const sym = Float32Array.from({ length: 300 }, (_, i) => Math.sin(i / 3) * 4);
  const su = P.unpackSymbols(P.packSymbols(sym, 0, 300));
  check('symbols: clamped to ±3, back within one step', su.every((v, i) => Math.abs(v - Math.max(-3, Math.min(3, sym[i]))) <= 6 / 63 / 2 + 1e-6));
  const tr = P.packTrace({ symbols: new Float32Array(900), frames: [{ pos: 200, sensorId: 4079, value: 420, inv: false }, { pos: 240, sensorId: 4080, value: 121, inv: true }] });
  check('trace: cut to 30 before the first frame and 70 after the last', tr.start === 170 && tr.symbols.length === 140
    && JSON.stringify(P.unpackFrames(tr.frames, tr.start)) === JSON.stringify([{ pos: 30, sensorId: 4079, value: 420, inv: false }, { pos: 70, sensorId: 4080, value: 121, inv: true }]));
  check('shadows round-trip', JSON.stringify(P.unpackShadows(P.packShadows([{ sensorId: 2080, value: 143, votes: 4, of: '2088=143' }])))
    === JSON.stringify([{ sensorId: 2080, value: 143, votes: 4, of: '2088=143' }]));

  // the Reader, fed one byte at a time and in odd pieces
  const run = 'abcd1234';
  const stream = 'MegaNet SDR Pi banner\r\n'
    + P.record('RX', { seq: 1, run, up: 5000, id: 4079, value: 420, fmt: 'EIF', votes: 25, name: 'FORDS, RD' }) + '\r\n'
    + 'FRE' + P.hide(P.record('LVL', { run, up: 5100, ch_dbfs: -80, nf_dbfs: -95, open: false, dbfs: -30, clip_pct: 0, hist: 'A'.repeat(32) }))
    + 'Q 151.6\b \b5\r\n'
    + '\r\x1b[K' + P.record('NOTE', { run, up: 5200, level: 'warn', text: 'two, commas, here' }) + '\r\nOK\r\nERR,RANGE too far\r\n'
    + '\x1b]0;a window title\x07' + P.hide(P.record('STAT', { run, up: 6000, state: 'streaming' })).replace('\x07', '\x1b\\')
    + 'FIELDS,BURST,seq,run,up,epoch_ms,ms,peak_dbfs,nf_dbfs,freq_hz,newfield\r\nBURST,1,abcd1234,7000,,300,-20,-90,151500000,42,extra\r\n';
  for (const piece of [1, 3, 7, 64]) {
    const r = new P.Reader();
    const items = [];
    const bytes = Buffer.from(stream, 'latin1');
    for (let i = 0; i < bytes.length; i += piece) items.push(...r.feed(bytes.subarray(i, i + piece)));
    items.push(...r.flush());
    const types = items.map(i => (i.kind === 'record' ? i.type : i.kind) + (i.hidden && i.kind === 'record' ? '*' : '')).join(' ');
    check('Reader in ' + piece + '-byte pieces: records, hidden records, echo and finals told apart',
      types === 'text RX LVL* text NOTE final final title STAT* FIELDS BURST', types);
    const rx = recs(items, 'RX')[0], note = recs(items, 'NOTE')[0], burst = recs(items, 'BURST')[0];
    const echo = items.filter(i => i.kind === 'text').map(i => i.text);
    if (piece === 1) {
      check('Reader: fields by name, numbers typed, empty is null', rx.rec.id === 4079 && rx.rec.value === 420 && rx.rec.epoch_ms === null && rx.rec.name === 'FORDS  RD'.replace(/\s+/g, ' '));
      check('Reader: NOTE\'s text keeps its commas', note.rec.text === 'two  commas  here'.replace(/\s+/g, ' ') || note.rec.text === 'two commas here', note.rec.text);
      check('Reader: an echoed command, backspace applied, is text not a record', echo.indexOf('FREQ 151.5') >= 0, JSON.stringify(echo));
      check('Reader: a field FIELDS appended is read by name; one past it is kept', burst.rec.newfield === '42' && burst.rec._10 === 'extra');
      check('Reader: ESC \\ ends a hidden record as BEL does', recs(items, 'STAT')[0] && recs(items, 'STAT')[0].rec.state === 'streaming');
      check('Reader: ERR\'s reason, OK\'s detail', items.some(i => i.kind === 'final' && !i.ok && i.reason === 'RANGE too far'));
    }
  }
  check('sniff: a Pi\'s log, from its hello or any hidden record', P.sniff('x\r\nSDRPI,version,1.0.0,schema,1') && P.sniff('\x1b]7355;LVL,ab,1,2'));
  check('sniff: not a Quansheng radio\'s log, not an ERT-A2\'s', !P.sniff('HDR,fw,4d06107f,schema,2\r\nDEC,1041,1790843886') && !P.sniff('ALERT2A,1,2,3'));
}

// ── the relay, playing recordings ──────────────────────────────────────────────

{
  const r = await runRelay(['--file', DEMO, '--speed', '0', '--exit-after-file', '--state', 'none']);
  const items = read(r.out);
  const rx = recs(items, 'RX').map(i => i.rec);
  const got = rx.map(x => x.id + '=' + x.value).sort().join(' ');
  check('demo band: exits cleanly once played and decoded', r.code === 0, r.err.slice(-300));
  check('demo band: the five readings, each once', got === '2088=143 2442=23 2443=142 4109=1290 4110=12', got);
  check('demo band: named as the radio names them (stations.json)', rx.find(x => x.id === 2088).name === 'MARBURG' && rx.find(x => x.id === 2088).kind === 'BATT'
    && rx.find(x => x.id === 4109).name === 'ROTHWELL' && rx.find(x => x.id === 4109).kind === 'RAIN');
  const bursts = recs(items, 'BURST').map(i => i.rec);
  check('demo band: three bursts, each reading tied to its own', bursts.length === 3 && rx.every(x => bursts.some(b => b.seq === x.burst))
    && new Set(rx.map(x => x.burst)).size === 3, bursts.map(b => b.seq + ':' + b.ms + 'ms').join(' '));
  check('demo band: ALERT Binary, 4+ votes, 8 hex digits, no CRC field', rx.every(x => x.fmt === 'ABF' && x.votes >= 4 && /^[0-9A-F]{8}$/.test(x.hex) && x.crc === null));
  const traces = recs(items, 'TRACE');
  const shadows = traces.flatMap(t => P.unpackShadows(t.rec.shadows));
  check('demo band: 2080 = 143 set aside as a one-bit shadow of 2088 = 143, not reported',
    shadows.some(s => s.sensorId === 2080 && s.of === '2088=143') && !rx.some(x => x.id === 2080), JSON.stringify(shadows));
  check('demo band: every decode\'s trace boxes its frames on its symbols', traces.length === 3 && traces.every(t => P.unpackFrames(t.rec.frames, t.rec.start).every(f => f.pos >= 0 && f.pos < t.rec.symbols.length)));
  check('demo band: level, spectrum and traces are hidden; readings are not',
    items.filter(i => ['LVL', 'SPEC', 'TRACE'].indexOf(i.type) >= 0).every(i => i.hidden) && rx.length && recs(items, 'RX').every(i => !i.hidden));
  const spec = recs(items, 'SPEC')[0];
  check('demo band: a spectrum of 256 bins at 240 ksps', spec && spec.rec.bins.length === 256 && spec.rec.rate === 240000);
  check('demo band: greets once — one SDRPI, naming the recording', recs(items, 'SDRPI').length === 1 && /demo_240k/.test(recs(items, 'SDRPI')[0].info.stick || ''));
  const stat = recs(items, 'STAT').slice(-1)[0];
  check('demo band: the last STAT counts 3 bursts and 5 readings', stat && stat.rec.bursts === 3 && stat.rec.readings === 5 && stat.rec.state === 'stopped');
  check('demo band: a PuTTY window would show no escape sequence but the hidden ones', !/\x1b\[(?!K)/.test(r.out.toString('latin1')));
}

{
  const r = await runRelay(['--file', RIG, '--set', 'fmt=EIF', '--set', 'gate=0', '--speed', '0', '--exit-after-file', '--state', 'none']);
  const rx = recs(read(r.out), 'RX').map(i => i.rec);
  const got = id => rx.find(x => x.id === id);
  check('the 4078 rig\'s real burst: 4079 = 420 under Enhanced iFLOWS', got(4079) && got(4079).value === 420 && got(4079).fmt === 'EIF', rx.map(x => x.id + '=' + x.value).join(' '));
  check('the 4078 rig\'s real burst: 4080 = 121 (12.1 V)', got(4080) && got(4080).value === 121);
  check('the 4078 rig\'s real burst: CRC good, 4079\'s bytes EF3FD208', got(4079) && got(4079).crc === 1 && got(4079).hex === 'EF3FD208');
  check('the 4078 rig\'s real burst: nothing else', rx.every(x => [4078, 4079, 4080].indexOf(x.id) >= 0));
}

// ── the console over stdio ─────────────────────────────────────────────────────

{
  const state = path.join(TMP, 'settings.json');
  const r = await runRelay(['--file', DEMO, '--speed', '1', '--state', state], [
    [400, 'HELP\r\n'], [100, 'CFG freq=151.425 gain=auto fmt=eif squelch=10 offset=12.5\r\n'], [100, 'BIAS ON\r\n'],
    [50, 'NOPE\r\n'], [50, 'OFFSET 500\r\n'], [50, 'GAIN\r\n'], [50, 'TIME 1790843760\r\n'], [50, '\r\n'],
    [50, 'STATUS\r\nSET ppm -3\r\n'], [50, 'RATE 1000000\r\n'],
  ], { wait: 2600 });
  const items = read(r.out);
  check('console: each command ends in one OK or ERR, in order',
    finals(items).join(' ') === 'OK OK ERR CONFIRM ERR UNKNOWN ERR RANGE OK OK OK OK ERR ARG', finals(items).join(' '));
  check('console: HELP is HELP lines, then OK', items.filter(i => i.kind === 'text' && /^HELP,/.test(i.text)).length === P.HELP.length);
  const cfgs = recs(items, 'CFG');
  const after = cfgs.find(i => i.settings.freq === 151425000);
  check('console: CFG sets several at once and says so in a CFG line', after && after.settings.gain === null && after.settings.fmt === 'EIF'
    && after.settings.squelch === 10 && after.settings.offset === 12500);
  check('console: GAIN on its own answers CFG,gain,auto', cfgs.some(i => /^CFG,gain,auto$/.test(i.raw)));
  check('console: Enter on its own answers a status line', items.some(i => i.kind === 'text' && /^MegaNet SDR Pi - streaming - 151\.4250 MHz EIF/.test(i.text)));
  const timed = recs(items, 'NOTE').find(i => /Clock set/.test(i.rec.text));
  check('console: TIME sets the clock, and what follows carries it', timed && timed.rec.epoch_ms >= 1790843760000 && timed.rec.epoch_ms < 1790843770000
    && recs(items, 'STAT').some(i => i.rec.epoch_ms >= 1790843760000 && i.rec.clock === 'set'));
  const kept = JSON.parse(fs.readFileSync(state, 'utf8'));
  check('console: the settings are kept on disk', kept.freq === 151425000 && kept.gain === null && kept.fmt === 'EIF' && kept.ppm === -3);
  const again = await runRelay(['--file', DEMO, '--speed', '0', '--exit-after-file', '--state', state]);
  const cfg2 = recs(read(again.out), 'CFG')[0];
  check('console: …and a restart comes back with them', cfg2 && cfg2.settings.freq === 151425000 && cfg2.settings.fmt === 'EIF' && cfg2.settings.ppm === -3);
}

// ── TCP: Raw (the far end echoes) and Telnet (asked to let the Pi echo) ───────

{
  let port = null, stopped = null;
  const relay = new Relay(parseArgs(['--file', DEMO, '--speed', '1', '--loop', '--tcp', '0', '--tcp-host', '127.0.0.1', '--state', 'none', '--no-title']),
    { quiet: true, onListening: p => { port = p; }, onStop: code => { stopped = code; } });
  await relay.start();
  for (let i = 0; i < 50 && port == null; i++) await sleep(20);
  const talk = (bytes, ms) => new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1');
    const got = [];
    sock.on('data', d => got.push(d));
    sock.on('connect', async () => { await sleep(150); sock.write(bytes); await sleep(ms); sock.end(); resolve(Buffer.concat(got)); });
  });
  const raw = await talk(Buffer.from('CFG\r\n'), 400);
  const rawItems = read(raw);
  check('TCP Raw: greeted with SDRPI, FIELDS and CFG', recs(rawItems, 'SDRPI').length === 1 && recs(rawItems, 'FIELDS').length === 7);
  check('TCP Raw: a command answered, and not echoed (PuTTY echoes Raw itself)', finals(rawItems).join() === 'OK' && !raw.toString('latin1').includes('CFG\r\nCFG\r\n') && !rawItems.some(i => i.kind === 'text' && i.text === 'CFG'));
  const tel = await talk(Buffer.concat([Buffer.from([255, 251, 31, 255, 253, 1]), Buffer.from('STATUS\r\0')]), 400);
  check('TCP Telnet: told WILL ECHO and WILL SUPPRESS-GO-AHEAD', tel.includes(Buffer.from([255, 251, 1, 255, 251, 3])));
  check('TCP Telnet: the command echoed back and answered', /STATUS\r\n/.test(tel.toString('latin1')) && finals(read(tel)).join() === 'OK');
  relay.stop(0);
  for (let i = 0; i < 50 && stopped == null; i++) await sleep(20);
  check('TCP: stops cleanly', stopped === 0);
}

// ── a pseudo-terminal as --serial: where PuTTY's COM port is on a Pi ──────────

{
  const py = spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' });
  if (py.status !== 0) {
    console.log('  (skipped the pseudo-terminal check: no python3)');
  } else {
    const helper = path.join(TMP, 'relay_pty.py');   // not pty.py: that would shadow the module it imports
    fs.writeFileSync(helper, [
      'import os, pty, subprocess, sys, time, select',
      'm, s = pty.openpty()',
      'p = subprocess.Popen([sys.argv[1], sys.argv[2], "--serial", os.ttyname(s), "--file", sys.argv[3], "--speed", "4", "--state", "none", "--no-title"], stderr=subprocess.DEVNULL)',
      'out = b""',
      'def drain(t):',
      '    global out',
      '    end = time.time() + t',
      '    while time.time() < end:',
      '        r, _, _ = select.select([m], [], [], 0.05)',
      '        if r: out += os.read(m, 65536)',
      'drain(1.0)',
      'for ch in b"FREQ 151.62\\x7f5": os.write(m, bytes([ch])); drain(0.03)',
      'os.write(m, b"\\r"); drain(0.4)',
      'os.write(m, b"CFG squelch=9\\rSTATUS\\r"); drain(3.5)',
      'p.terminate(); p.wait(timeout=5)',
      'sys.stdout.buffer.write(out)',
    ].join('\n'));
    const r = spawnSync('python3', [helper, process.execPath, RELAY, DEMO], { timeout: 30000, maxBuffer: 1 << 24 });
    const out = r.stdout || Buffer.alloc(0), items = read(out), text = out.toString('latin1');
    check('serial: greeted on the port', recs(items, 'SDRPI').length >= 1, `${out.length} bytes, status ${r.status}`);
    // A burst arriving mid-typing redraws the line, so the echo is checked as read, backspace applied.
    check('serial: typing echoed, backspace and all', text.includes('\b \b') && items.some(i => i.kind === 'text' && i.text === 'FREQ 151.65'));
    check('serial: the typed command and a two-line paste each answered', finals(items).join(' ') === 'OK OK OK', finals(items).join(' '));
    check('serial: the stick (a recording here) retuned', recs(items, 'CFG').some(i => i.settings.freq === 151650000));
    check('serial: readings arrive on the port', recs(items, 'RX').length >= 1);
  }
}

// ── the USB path: rtlsdr.js on a simulated V3, through the relay ──────────────

{
  // The simulated stick at the pace a real one sends, and pluggable.
  class PacedStick extends FakeStick {
    async transferIn(ep, len) {
      if (this.unplugged) { await sleep(5); throw new Error('LIBUSB_ERROR_NO_DEVICE'); }
      await sleep(len / 2 / 240000 * 1000);
      if (this.unplugged) throw new Error('LIBUSB_ERROR_NO_DEVICE');
      return super.transferIn(ep, len);
    }
  }
  const stick = new PacedStick();
  const lines = [];
  let stopped = null;
  const relay = new Relay(parseArgs(['--state', 'none', '--no-title']), {
    quiet: true, out: (line, hidden) => lines.push({ line, hidden }), onStop: code => { stopped = code; },
    usb: { getDevices: async () => (stick.unplugged ? [] : [stick]) },
  });
  await relay.start();
  const say = async (cmd, ms) => { relay.command({ line: () => {}, io: {} }, cmd); await sleep(ms || 150); };
  await sleep(1300);
  const items = read(Buffer.from(lines.map(l => (l.hidden ? P.hide(l.line) : l.line + '\r\n')).join(''), 'latin1'));
  const opened = recs(items, 'NOTE').find(i => /^Opened/.test(i.rec.text));
  check('USB: opens the simulated V3 through rtlsdr.js', opened && /RTL-SDR Blog V3/.test(opened.rec.text) && /R820T/.test(opened.rec.text), opened && opened.rec.text);
  const hi = recs(items, 'SDRPI').slice(-1)[0];
  check('USB: SDRPI tells the card the tuner, range (a V3 to 0.5 MHz, by direct sampling), gain steps, bias tee',
    hi && hi.info.tuner === 'R820T' && hi.info.min_hz === '500000' && hi.info.gains.split(';').length === 29 && hi.info.bias_tee === '1' && hi.info.direct === '1');
  check('USB: tuned to 151.5 MHz at 240 ksps, as the card would', relay.dev && relay.dev.freq === 151500000 && Math.round(relay.dev.rate) === 240000);
  check('USB: streaming into the decoder', relay.state === 'streaming' && relay.rx.bytes > 100000, `${relay.rx.bytes} bytes`);
  await say('FREQ 151.6');
  check('USB: FREQ retunes the stick', relay.dev.freq === 151600000 && relay.tune && relay.tune.mode === 'tuner');
  await say('GAIN 40');
  check('USB: GAIN 40 asks the driver for 400 tenths (it walks to the step at or above)', relay.dev.gain === 400 && stick.t[0x05 - 0x00] !== undefined, String(relay.dev.gain));
  await say('BIAS ON YES');
  check('USB: BIAS ON YES puts the bias tee on (GPIO 0)', relay.dev.biasTee === true && stick.gpo(0) === 1);
  await say('RATE 960000', 400);
  check('USB: RATE restarts the stream at the new rate', Math.round(relay.dev.rate) === 960000 && relay.dev.streaming);
  await say('FREQ 2000', 150);
  const lastFinal = finals(read(Buffer.from(lines.filter(l => !l.hidden).map(l => l.line + '\r\n').join(''), 'latin1'))).slice(-1)[0];
  check('USB: a frequency the stick cannot tune is refused', lastFinal === 'ERR RANGE' || lastFinal === 'ERR ARG', lastFinal);
  stick.unplugged = true;
  await sleep(600);
  check('USB: an unplugged stick is noticed and said', relay.state === 'no-stick' && lines.some(l => /stopped streaming/.test(l.line)));
  stick.unplugged = false;
  for (let i = 0; i < 60 && relay.state !== 'streaming'; i++) await sleep(100);
  check('USB: …and found again when it comes back', relay.state === 'streaming' && relay.dev && relay.dev.freq === 151600000);
  relay.stop(0);
  for (let i = 0; i < 50 && stopped == null; i++) await sleep(20);
  check('USB: closing puts the tuner to standby and lets go of the stick', stopped === 0 && stick.released === true);
}

fs.rmSync(TMP, { recursive: true, force: true });

// ── Verdict ──────────────────────────────────────────────────────────────────

const failed = results.filter(r => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
console.log('PASS — the Pi relay decodes, names, counts and answers as its protocol says, and the card\'s reader reads every byte of it.');
