// MegaNet — serial-radio.js
//
//   SerialRadio   the Serial Monitor's dashboard for a Quansheng UV-K5 V3 /
//                 UV-K1 running the ALERT receiver firmware
//                 (cdomotor-g/quansheng_alert_v3): its readings, bursts, noise
//                 floor and battery drawn as they arrive, and every control the
//                 firmware's console offers — the clock, the settings, the
//                 flash log, the station table, the screen, a reboot.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, announce, dlText and state; across to
// serial.js for the port (Serial.writeText, Serial.toggleDtr, Serial.logLine),
// to quansheng.js for the protocol, to serial-viz.js for the drawing, to
// packets.js for MegaNet's station names and the Packets tab, and to
// alert-dsp.js for the demo's frames — all from inside functions, none at
// load, so the order among those files is free.
//
// serial.js owns the port: opening it, the read loop, the raw log. A
// connection whose kind is 'quansheng' hands its bytes here (feed), and its
// live body is built here (body, mount). Everything the radio says is a line
// in the raw log as well, so the dashboard never hides what came off the wire.
//
// A card can also be following the log file PuTTY writes from the radio's port
// (c.follow — see serial.js and log-follow.js). Then there is no port to send
// on: no handshake, no DTR watchdog, and the controls that need the console
// copy their command for pasting into PuTTY instead. The radio's replies come
// back through the log like everything else, and the ones that carry state
// (INFO, GET, LOG STAT, STN INFO) are read into the dashboard as they pass.
//
// The protocol rules this leans on are quansheng.js's header; the two that
// shape this file are DTR (re-asserted after 25 s of silence — the radio goes
// quiet for good otherwise) and one console command at a time (a queue, each
// command ending on its OK or ERR, records arriving in the middle routed to
// the stream).

const SerialRadio = (function () {
  const MAX_DEC = 500, MAX_BST = 48, MAX_STA = 1100, MAX_EVT = 120;
  const SPANS = [[5, '5 min'], [15, '15 min'], [60, '1 h'], [180, '3 h']];
  const QUICK = ['HELP', 'INFO', 'TIME', 'LOG STAT', 'STN INFO', 'CSV HDR', 'GET'];
  const SILENCE_MS = 25000;

  function fresh() {
    return {
      schema: Quansheng.createSchema(), reader: new Quansheng.LineReader(),
      sta: [], bursts: [], decs: [], events: [], stations: new Map(),
      info: {}, settings: {}, logStat: null, stnInfo: null, clock: null,
      queue: [], busy: null, lastByte: Date.now(), watch: null,
      sel: null, span: 15, screen: null, screenAt: 0, screenAuto: false, screenTimer: null,
      upload: null, table: null, dump: null, notes: [], bootloader: false, hello: null,
      paintPending: {}, paintRaf: 0, demoTimer: null, demo: null,
    };
  }

  function conn(id) { return Serial.findConn(id); }
  function R(id) { const c = conn(id); return c && c.radio ? c.radio : null; }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  // The port is open (or the demo has started): watch for silence, and say
  // hello — the clock, the schema, the settings.
  function attach(c) {
    c.radio = c.radio || fresh();
    const r = c.radio;
    r.lastByte = Date.now();
    clearInterval(r.watch);
    if (c.follow) {
      note(c, 'Following ' + c.follow.src.name + ': the dashboard fills from what PuTTY records. PuTTY holds the port, so nothing is sent '
        + 'from here — the console buttons copy their command instead, to paste into PuTTY (right-click) and send with Enter. The reply '
        + 'comes back through the log and shows here. Readings from the log\'s history are timed by the radio\'s clock where it was set.', '');
    } else if (!c.demo) {
      r.watch = setInterval(() => watchdog(c), 5000);
      handshake(c);
    }
  }

  function detach(c) {
    const r = c && c.radio;
    if (!r) return;
    clearInterval(r.watch); r.watch = null;
    clearInterval(r.screenTimer); r.screenTimer = null; r.screenAuto = false;
    clearInterval(r.demoTimer); r.demoTimer = null;
    if (r.busy) { clearTimeout(r.busy.timer); r.busy.reject(new Error('port closed')); r.busy = null; }
    r.queue.splice(0).forEach(j => j.reject(new Error('port closed')));
    if (r.upload) r.upload.cancel = true;
  }

  // §2: a send the host does not collect clears the radio's DTR flag, and it
  // is silent from then on until DTR is asserted again. With CSV_OUT on an STA
  // arrives every 10 s, so 25 s of nothing means the flag was cleared.
  function watchdog(c) {
    const r = c.radio;
    if (!r || c.phase !== 'open') return;
    if (Date.now() - r.lastByte > SILENCE_MS) {
      r.lastByte = Date.now();
      Serial.logLine(c, 'No bytes for 25 s — re-asserting DTR (the radio stops sending when its DTR flag is cleared)', 'sys');
      Serial.toggleDtr(c);
    }
    mark(c, 'status');
  }

  async function handshake(c) {
    try {
      await syncClockFor(c, true);
      await cmd(c, 'CSV HDR');
      await refreshFor(c);
    } catch (e) {
      note(c, 'The radio has not answered the console (' + e.message + '). Records still show as they arrive; '
        + 'check the radio is on and running this firmware, then press Refresh.', 'warn');
    }
  }

  // ── the console queue (§7.1: one command at a time) ───────────────────────

  function cmd(c, text, opts) {
    const r = c.radio;
    opts = opts || {};
    return new Promise((resolve, reject) => {
      r.queue.push({ text, timeout: opts.timeout || Quansheng.timeoutFor(text), resolve, reject, lines: [], onLine: opts.onLine });
      pump(c);
    });
  }

  function pump(c) {
    const r = c.radio;
    if (!r || r.busy || !r.queue.length) return;
    const job = r.busy = r.queue.shift();
    mark(c, 'status');
    if (c.demo) { setTimeout(() => demoAnswer(c, job.text), 40 + Math.random() * 80); arm(c, job); return; }
    if (c.phase !== 'open') { finish(c, null, new Error('the port is not open')); return; }
    arm(c, job);
    Serial.writeText(c, job.text + '\n', job.text).catch(e => finish(c, null, e));
  }

  function arm(c, job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => finish(c, null, new Error('no reply to ' + job.text.split(' ').slice(0, 2).join(' ') + ' in ' + job.timeout / 1000 + ' s')), job.timeout);
  }

  function finish(c, final, err) {
    const r = c.radio, job = r && r.busy;
    if (!job) return;
    clearTimeout(job.timer);
    r.busy = null;
    if (err) job.reject(err);
    else if (!final.ok) {
      const e = new Error((final.reason || 'ERR') + (Quansheng.ERRORS[final.reason] ? ' — ' + Quansheng.ERRORS[final.reason] : ''));
      e.reason = final.reason;
      job.reject(e);
    } else job.resolve({ lines: job.lines, detail: final.detail });
    mark(c, 'status');
    setTimeout(() => pump(c), 0);
  }

  // ── bytes in ──────────────────────────────────────────────────────────────

  function feed(c, u8) {
    const r = c.radio || (c.radio = fresh());
    r.lastByte = Date.now();
    const out = r.reader.feed(u8);
    out.frames.forEach(f => onFrame(c, f));
    out.lines.forEach(l => onLine(c, l));
    if (r.reader.bootloader && !r.bootloader) {
      r.bootloader = true;
      note(c, 'The radio is in DFU (bootloader) mode — it is waiting to be flashed, not receiving. Power-cycle it to return to the firmware.', 'bad');
    }
  }

  function onFrame(c, f) {
    const id = '0x' + f.id.toString(16).toUpperCase().padStart(4, '0');
    Serial.logLine(c, '[binary frame ' + id + ', ' + f.data.length + ' data bytes]', 'qs-dbg');
    if (f.id === Quansheng.FRAME.HELLO_REPLY) {
      c.radio.hello = String.fromCharCode.apply(null, f.data.slice(0, 16).filter(b => b >= 32 && b < 127));
      mark(c, 'status');
    }
  }

  function onLine(c, line, t) {
    const r = c.radio;
    const cls = Quansheng.classify(line);
    Serial.logLine(c, line, cls === 'record' ? 'qs-rec' : cls === 'debug' ? 'qs-dbg' : cls === 'final' ? 'qs-fin' : 'qs-dat', t);
    if (cls === 'record') { onRecord(c, line, t); return; }
    if (cls === 'debug') return;
    if (c.follow && !r.busy) { absorb(c, line); return; }
    if (r.busy) {
      if (cls === 'final') finish(c, Quansheng.parseFinal(line));
      else {
        r.busy.lines.push(line);
        arm(c, r.busy);
        if (r.busy.onLine) r.busy.onLine(line);
      }
    }
  }

  // A reply someone typed for in PuTTY, read off the followed log: nothing
  // here asked for it, so nothing is waiting on it, but what it says is still
  // the radio's state and worth showing.
  function absorb(c, line) {
    const r = c.radio, d = Quansheng.parseData(r.schema, line);
    if (d.type === 'INFO') { r.info[d.key] = d.values; mark(c, 'status'); }
    else if (d.type === 'GET') { r.settings[d.name] = d.value; mark(c, 'settings'); }
    else if (d.type === 'LOG' && d.stat) { r.logStat = d; mark(c, 'log', 'status'); }
    else if (d.type === 'STN' && d.info) { r.stnInfo = d; mark(c, 'stations-table', 'status'); }
  }

  // When a record happened. Off a port, when it arrived. Off a followed log,
  // the radio's own clock if it was set: the log's history arrives all at once,
  // and stamping an hour of it "now" would draw it all at the right-hand edge.
  function recordTime(c, rec) {
    if (!c.follow || !rec || !rec.epoch) return Date.now();
    const ms = rec.epoch * 1000;
    return Math.abs(ms - Date.now()) < 30 * 86400000 ? Math.min(ms, Date.now()) : Date.now();
  }

  function onRecord(c, line, t) {
    const r = c.radio;
    const p = Quansheng.parseRecord(r.schema, line);
    t = t || recordTime(c, p.rec);
    if (p.type === 'HDR') {
      if (p.header && p.header.kind === 'fw' && p.header.schema !== Quansheng.SCHEMA) {
        note(c, 'The radio speaks schema ' + p.header.schema + '; this dashboard was written for schema ' + Quansheng.SCHEMA
          + '. Fields are mapped by name, so most of it will still read right.', 'warn');
      }
      mark(c, 'status');
    } else if (p.type === 'DEC') { addDec(c, p.rec, t); ingestDec(c, p.rec, line); }
    else if (p.type === 'BST') addBurst(c, p.rec, t);
    else if (p.type === 'STA') addSta(c, p.rec, t);
    else if (p.type === 'EVT') addEvt(c, p.rec, t);
  }

  // To MegaNet, when the card is set to send (serial-ingest.js). Off a port, a
  // reading is timed by when it arrived. Out of a followed log's history it is
  // timed by the radio's own clock, where that was set and is believable, and
  // otherwise not sent — history stamped "now" would be wrong data.
  function ingestDec(c, rec, line) {
    if (typeof SerialIngest === 'undefined' || rec.id == null || rec.value == null) return;
    let ts = SerialIngest.arrival(c);
    if (ts == null && rec.epoch) {
      const ms = rec.epoch * 1000;
      if (ms <= Date.now() + 5 * 60000 && ms >= Date.now() - 30 * 86400000) ts = ms;
    }
    SerialIngest.add(c, [{ alert_id: rec.id, value_raw: rec.value, ts, protocol: 'alert', line }]);
  }

  function meganetName(id) {
    if (typeof Packets === 'undefined' || !state || !state.data) return '';
    try { const s = Packets.stationName(id); return s && !s.none && s.source === 'meganet' ? s.text : ''; } catch (_) { return ''; }
  }

  function addDec(c, rec, t) {
    const r = c.radio;
    rec.t = t;
    rec.key = rec.seq + ':' + rec.uptime_ms + ':' + rec.frame;
    rec.mn = meganetName(rec.id);
    r.decs.push(rec);
    if (r.decs.length > MAX_DEC) r.decs.splice(0, r.decs.length - MAX_DEC);
    let s = r.stations.get(rec.id);
    if (!s) { s = { id: rec.id, count: 0, rssi: [], fade: [] }; r.stations.set(rec.id, s); }
    s.count++; s.last = rec; s.name = rec.name; s.mn = rec.mn; s.kind = rec.kind;
    s.rssi.push(rec.rssi); s.fade.push(rec.fade);
    if (s.rssi.length > 24) { s.rssi.shift(); s.fade.shift(); }
    // the burst it came from, if that has arrived first
    const b = r.bursts.find(x => x.uptime_ms === rec.uptime_ms);
    if (b) b.decs.push(rec);
    mark(c, 'readings', 'stations', 'signal', 'bursts', 'status');
  }

  function addBurst(c, rec, t) {
    const r = c.radio;
    rec.t = t;
    rec.bits = Quansheng.burstBits(rec.bits_hex || '', rec.nbits || 0);
    rec.found = Quansheng.scanBurst(rec.bits);
    rec.decs = r.decs.filter(d => d.uptime_ms === rec.uptime_ms);
    r.bursts.push(rec);
    if (r.bursts.length > MAX_BST) r.bursts.splice(0, r.bursts.length - MAX_BST);
    mark(c, 'bursts', 'signal', 'status');
  }

  function addSta(c, rec, t) {
    const r = c.radio;
    rec.t = t;
    r.sta.push(rec);
    if (r.sta.length > MAX_STA) r.sta.splice(0, r.sta.length - MAX_STA);
    mark(c, 'signal', 'status');
  }

  function addEvt(c, rec, t) {
    const r = c.radio;
    rec.t = t;
    r.events.push(rec);
    if (r.events.length > MAX_EVT) r.events.splice(0, r.events.length - MAX_EVT);
    if (rec.code === 'SET') {
      const m = /^([A-Z_]+)=(.*)$/.exec(rec.detail || '');
      if (m) { r.settings[m[1]] = m[2]; mark(c, 'settings'); }
    }
    if (rec.code === 'BOOT') note(c, 'The radio\'s ALERT app restarted (' + (rec.detail || 'reset') + '). Its clock is lost on every reboot — press Sync clock.', 'warn');
    mark(c, 'events', 'status');
  }

  function note(c, text, kind) {
    const r = c.radio;
    r.notes = r.notes.filter(n => n.text !== text);    // the same note again is one note, newer
    r.notes.push({ t: Date.now(), text, kind: kind || '' });
    if (r.notes.length > 4) r.notes.shift();
    mark(c, 'notes');
  }

  // ── actions (the buttons) ─────────────────────────────────────────────────

  function guard(id, fn) {
    const c = conn(id);
    if (!c || !c.radio) return Promise.resolve();
    return Promise.resolve().then(() => fn(c, c.radio)).catch(e => { note(c, e.message, 'bad'); });
  }

  // §6: the clock counts from the radio's 10 ms tick, lives in RAM, and is
  // lost on every reboot — so it is set on every connect. Read it first, to
  // say how far off it was.
  async function syncClockFor(c, quiet) {
    const r = c.radio;
    const before = await cmd(c, 'TIME');
    const t = before.lines.map(l => Quansheng.parseData(r.schema, l)).find(x => x.type === 'TIME');
    const now = Math.round(Date.now() / 1000);
    await cmd(c, 'TIME ' + now);
    r.clock = { setAt: Date.now(), drift: t && t.epoch ? t.epoch - now : null };
    mark(c, 'status');
    if (!quiet) {
      const d = r.clock.drift;
      announce((c.name || 'Radio') + ' — clock set' + (d == null ? ' (it was unset)' : d === 0 ? ' (it was right)' : ' (it was ' + Math.abs(d) + ' s ' + (d > 0 ? 'fast' : 'slow') + ')'));
    }
  }
  function syncClock(id) { return guard(id, c => syncClockFor(c, false)); }

  async function refreshFor(c) {
    const r = c.radio;
    const info = await cmd(c, 'INFO');
    info.lines.forEach(l => {
      const d = Quansheng.parseData(r.schema, l);
      if (d.type === 'INFO') r.info[d.key] = d.values;
      if (d.type === 'GET') r.settings[d.name] = d.value;
    });
    mark(c, 'settings', 'status');
    await logStatFor(c);
    await stnInfoFor(c);
  }
  function refresh(id) { return guard(id, c => refreshFor(c).then(() => announce((c.name || 'Radio') + ' — settings, log and station table read'))); }

  // Set, then read back: §7.4 sets in one go or not at all, and an EVT SET
  // arrives only when the value actually changed.
  async function setFor(c, name, value) {
    const r = c.radio;
    const why = Quansheng.checkSetting(name, value);
    if (why) throw new Error(name + ': ' + why);
    await cmd(c, Quansheng.setCommand(name, value));
    const back = await cmd(c, 'GET ' + name);
    back.lines.forEach(l => { const d = Quansheng.parseData(r.schema, l); if (d.type === 'GET') r.settings[d.name] = d.value; });
    mark(c, 'settings');
    announce(name.replace(/_/g, ' ') + ' is now ' + (r.settings[name] || value));
  }
  function applySetting(id, name, value) {
    return guard(id, c => setFor(c, name, value)).then(() => mark(conn(id), 'settings'));
  }
  function applyNumber(id, name) {
    const el = document.getElementById('qs-set-' + id + '-' + name);
    return applySetting(id, name, el ? el.value : '');
  }
  function step(id, name, dir) { return applySetting(id, name, dir); }

  async function logStatFor(c) {
    const r = c.radio;
    const res = await cmd(c, 'LOG STAT');
    res.lines.forEach(l => { const d = Quansheng.parseData(r.schema, l); if (d.type === 'LOG' && d.stat) r.logStat = d; });
    mark(c, 'log', 'status');
  }
  function logStat(id) { return guard(id, c => logStatFor(c)); }

  // LOG DUMP [n] → CSV, the header row the DEC field names (alertterm's
  // log-download). Idle timeout, so a long dump never times out while lines
  // keep coming.
  function logDownload(id) {
    return guard(id, async (c, r) => {
      const nEl = document.getElementById('qs-dump-n-' + id);
      const n = nEl && nEl.value ? Math.max(1, parseInt(nEl.value, 10) || 0) : 0;
      r.dump = { got: 0 };
      mark(c, 'log');
      const res = await cmd(c, 'LOG DUMP' + (n ? ' ' + n : ''), {
        onLine: () => { r.dump.got++; if (r.dump.got % 25 === 0) mark(c, 'log'); },
      });
      const recs = res.lines.map(l => Quansheng.parseData(r.schema, l)).filter(d => d.type === 'LOG' && d.record).map(d => d.record);
      r.dump = null;
      mark(c, 'log');
      dlText('radio-log-' + new Date().toISOString().slice(0, 10) + '.csv', Quansheng.toCsv(r.schema.fields.DEC, recs));
      announce('Radio log downloaded — ' + recs.length + ' record' + (recs.length === 1 ? '' : 's'));
    }).finally(() => { const r = R(id); if (r) { r.dump = null; mark(conn(id), 'log'); } });
  }

  function logClear(id) {
    if (!confirm('Erase the radio\'s flash log? Every stored reading is lost. Download it first if you need it.')) return Promise.resolve();
    return guard(id, async c => { await cmd(c, 'LOG CLEAR YES'); await logStatFor(c); announce('Radio log erased'); });
  }
  function logFormat(id) {
    if (!confirm('Take over the log region and format it? It holds data this firmware did not write (state FOREIGN) — whatever it is will be erased.')) return Promise.resolve();
    return guard(id, async c => { await cmd(c, 'LOG FORMAT FORCE'); await logStatFor(c); });
  }

  async function stnInfoFor(c) {
    const r = c.radio;
    const res = await cmd(c, 'STN INFO');
    res.lines.forEach(l => { const d = Quansheng.parseData(r.schema, l); if (d.type === 'STN' && d.info) r.stnInfo = d; });
    mark(c, 'stations-table', 'status');
  }
  function stnInfo(id) { return guard(id, c => stnInfoFor(c)); }

  function stnLookup(id) {
    return guard(id, async (c, r) => {
      const el = document.getElementById('qs-stn-id-' + id);
      const aid = el ? parseInt(el.value, 10) : NaN;
      if (!(aid >= 0 && aid <= 8191)) throw new Error('An ALERT address is 0–8191');
      const res = await cmd(c, 'STN GET ' + aid);
      const d = res.lines.map(l => Quansheng.parseData(r.schema, l)).find(x => x.type === 'STN' && x.lookup);
      const mn = meganetName(aid);
      r.lookup = { id: aid, name: d ? d.name : '', kind: d ? d.kind : '', mn };
      mark(c, 'stations-table');
    });
  }

  // The legacy address file, read as Packets reads it — the fallback below
  // stations.json, as gen_stations.py uses it.
  async function addressFile() {
    try {
      const res = await fetch(encodeURI('data/All 2021 Working 2.txt'));
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const u8 = new Uint8Array(buf);
      const enc = u8[0] === 0xFF && u8[1] === 0xFE ? 'utf-16le' : u8[0] === 0xFE && u8[1] === 0xFF ? 'utf-16be' : 'utf-8';
      const text = new TextDecoder(enc).decode(buf).replace(/^﻿/, '');
      const map = new Map();
      text.split(/\r?\n/).forEach(line => {
        if (!line.startsWith(' ')) return;
        const m = line.match(/^\s*(\d+)\s+(.*\S)/);
        if (m && !map.has(+m[1])) map.set(+m[1], m[2]);
      });
      return map;
    } catch (_) { return null; }
  }

  // Build MegaNet's table — the one quansheng_alert_v3's gen_stations.py
  // builds for the firmware, from the station database this app has loaded.
  function stnBuild(id) {
    return guard(id, async (c, r) => {
      if (!state || !state.data || !Array.isArray(state.data.stations) || !state.data.stations.length) {
        throw new Error('No station database is loaded in MegaNet yet — open the Stations tab once, then build again.');
      }
      const useFile = (document.getElementById('qs-stn-file-' + id) || {}).checked !== false;
      const file = useFile ? await addressFile() : null;
      r.table = Quansheng.buildStationTable(state.data.stations, file);
      r.table.withFile = !!file;
      mark(c, 'stations-table');
    });
  }

  function stnSaveBlob(id) {
    const r = R(id);
    if (!r || !r.table) return;
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([r.table.blob], { type: 'application/octet-stream' })),
      download: 'stations-' + r.table.source.replace(/[^A-Za-z0-9]+/g, '-') + '.bin',
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // §8: BEGIN (the radio erases: 30 s), a W per chunk in increasing order
  // waiting for each OK, END (it checks the CRC and activates). 64-byte
  // chunks; if any W or the END is refused, the whole upload starts over at
  // 32 — alertterm's rule, which also covers a build without the packing.
  function stnUpload(id) {
    const r0 = R(id);
    if (!r0 || !r0.table) return Promise.resolve();
    if (!confirm('Upload ' + r0.table.sites.length + ' sites (' + r0.table.blob.length + ' bytes) to the radio\'s station table? '
      + 'The region is erased first; if the upload is interrupted the radio falls back to its built-in table until you upload again.')) return Promise.resolve();
    return guard(id, async (c, r) => {
      const blob = r.table.blob;
      for (const chunk of [64, 32]) {
        const lines = Quansheng.uploadCommands(blob, chunk);
        r.upload = { i: 0, n: lines.length, chunk, cancel: false, t0: Date.now() };
        mark(c, 'stations-table');
        try {
          for (let i = 0; i < lines.length; i++) {
            if (r.upload.cancel) throw Object.assign(new Error('Upload cancelled — the radio is on its built-in table until a full upload'), { cancelled: true });
            r.upload.i = i;
            if (i % 8 === 0 || i === lines.length - 1) mark(c, 'stations-table');
            await cmd(c, lines[i]);
          }
          r.upload = null;
          await stnInfoFor(c);
          announce('Station table uploaded — ' + r.table.sites.length + ' sites');
          return;
        } catch (e) {
          if (e.cancelled || chunk === 32 || !(e.reason === 'STATE' || e.reason === 'TOOLONG' || e.reason === 'ARGS' || e.reason === 'CRC')) { r.upload = null; mark(c, 'stations-table'); throw e; }
          Serial.logLine(c, 'Upload refused at 64-byte chunks (' + e.message + ') — starting over at 32', 'sys');
        }
      }
    });
  }
  function stnCancel(id) { const r = R(id); if (r && r.upload) r.upload.cancel = true; }
  function stnClear(id) {
    if (!confirm('Erase the uploaded station table? The radio goes back to the table built into its firmware (13-character names).')) return Promise.resolve();
    return guard(id, async c => { await cmd(c, 'STN CLEAR YES'); await stnInfoFor(c); });
  }

  // §9: the display, 8 rows of 128 bytes.
  function screen(id) {
    return guard(id, async (c, r) => {
      const res = await cmd(c, 'SCREEN');
      const rows = [];
      res.lines.forEach(l => { const d = Quansheng.parseData(r.schema, l); if (d.type === 'SCR') rows[d.row] = d.hex; });
      r.screen = Quansheng.decodeScreen(rows);
      r.screenAt = Date.now();
      mark(c, 'screen');
    });
  }
  function screenAuto(id, on) {
    const r = R(id);
    if (!r) return;
    r.screenAuto = !!on;
    clearInterval(r.screenTimer);
    r.screenTimer = null;
    if (on) {
      // only when the console is idle — a mirror must not hold up a command
      r.screenTimer = setInterval(() => { const rr = R(id); if (rr && !rr.busy && !rr.queue.length) screen(id); }, 2500);
      screen(id);
    }
  }
  function screenSave(id) {
    const cv = document.getElementById('qs-screen-' + id);
    if (!cv || !cv.toBlob) return;
    cv.toBlob(b => {
      if (!b) return;
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(b), download: 'radio-screen.png' });
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  function reboot(id) {
    if (!confirm('Reboot the radio? It resets with the transmitter safely off; the USB port disappears and comes back once it has restarted.')) return Promise.resolve();
    return guard(id, async c => { await cmd(c, 'REBOOT').catch(() => {}); note(c, 'Reboot sent. The port will drop — Reopen it once the radio has restarted.', 'warn'); });
  }

  function sendCmd(id) {
    const el = document.getElementById('qs-cmd-' + id);
    if (!el || !el.value.trim()) return Promise.resolve();
    const text = el.value.trim();
    el.value = '';
    const c = conn(id);
    if (c && c.follow) return copyForPutty(c, text);
    return guard(id, c => cmd(c, text));
  }
  function quick(id, text) {
    const c = conn(id);
    if (c && c.follow) return copyForPutty(c, text);
    return guard(id, c => cmd(c, text));
  }

  // Following a log: the command goes to the clipboard, for PuTTY. The radio's
  // clock is the one worth setting this way — it is lost on every reboot, and
  // it is what times the log's history.
  function copyClock(id) {
    const c = conn(id);
    if (c) return copyForPutty(c, 'TIME ' + Math.round(Date.now() / 1000), ' It sets the clock to the second you copied it, so send it straight away.');
    return Promise.resolve();
  }
  async function copyForPutty(c, text, extra) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      // The async clipboard can be blocked by policy too; the old way often is not.
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'sr-only';
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (_) {}
    }
    note(c, ok ? 'Copied “' + text + '” — paste it into PuTTY (right-click), press Enter, and the reply shows here.' + (extra || '')
      : 'Could not copy to the clipboard. Type this into PuTTY and press Enter: ' + text, ok ? '' : 'warn');
    if (ok) announce('Copied ' + text + ' for PuTTY');
  }

  function select(id, key) {
    const c = conn(id);
    if (!c || !c.radio) return;
    c.radio.sel = c.radio.sel === key ? null : key;
    mark(c, 'readings', 'detail');
  }
  function setSpan(id, min) { const c = conn(id); if (c && c.radio) { c.radio.span = +min; mark(c, 'signal'); } }
  function clearData(id) {
    const c = conn(id);
    if (!c || !c.radio) return;
    const r = c.radio;
    r.decs = []; r.bursts = []; r.sta = []; r.events = []; r.stations = new Map(); r.sel = null;
    mark(c, 'readings', 'stations', 'signal', 'bursts', 'events', 'detail', 'status');
  }
  function exportReadings(id) {
    const r = R(id);
    if (!r) return;
    const fields = r.schema.fields.DEC.concat(['received', 'meganet_name']);
    const rows = r.decs.map(d => Object.assign({}, d, { received: new Date(d.t).toISOString(), meganet_name: d.mn || '' }));
    dlText('radio-readings-' + new Date().toISOString().slice(0, 10) + '.csv', Quansheng.toCsv(fields, rows));
  }
  function openPayload(id, hex) { Serial.openInPackets('0x' + hex); }

  // ── painting ──────────────────────────────────────────────────────────────

  function mark(c) {
    if (!c || !c.radio) return;
    const r = c.radio;
    for (let i = 1; i < arguments.length; i++) r.paintPending[arguments[i]] = true;
    if (r.paintRaf) return;
    const run = () => { r.paintRaf = 0; paint(c); };
    r.paintRaf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
  }

  function paint(c) {
    const r = c.radio, p = r.paintPending;
    r.paintPending = {};
    if (!document.getElementById('qs-dash-' + c.id)) return;
    if (p.status) paintStatus(c);
    if (p.notes) paintNotes(c);
    if (p.signal) paintSignal(c);
    if (p.bursts) paintBursts(c);
    if (p.readings) paintReadings(c);
    if (p.detail || p.readings) paintDetail(c);
    if (p.stations) paintStations(c);
    if (p.settings) paintSettings(c);
    if (p.log) paintLog(c);
    if (p['stations-table']) paintTable(c);
    if (p.screen) paintScreen(c);
    if (p.events) paintEvents(c);
  }

  function mountAll(c) {
    if (!c.radio) c.radio = fresh();
    ['status', 'notes', 'signal', 'bursts', 'readings', 'detail', 'stations', 'settings', 'log', 'stations-table', 'screen', 'events']
      .forEach(k => { c.radio.paintPending[k] = true; });
    paint(c);
  }

  function last(a) { return a.length ? a[a.length - 1] : null; }
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
  }
  function chip(label, value, cls, extra) {
    return '<div class="qs-chip' + (cls ? ' ' + cls : '') + '"><span class="qs-chip-k">' + esc(label) + '</span>'
      + '<span class="qs-chip-v">' + value + '</span>' + (extra || '') + '</div>';
  }
  function meter(frac, cls) {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    return '<span class="qs-meter' + (cls ? ' ' + cls : '') + '" style="--w: ' + pct + '%"><i></i></span>';
  }

  function paintStatus(c) {
    const el = document.getElementById('qs-status-' + c.id);
    if (!el) return;
    const r = c.radio, s = last(r.sta), sc = r.schema;
    const chips = [];
    chips.push(chip('Firmware', sc.fw ? esc(sc.fw) + ' · schema ' + esc(sc.schema) : '<span class="qs-dim">waiting for HDR</span>',
      sc.schema != null && sc.schema !== Quansheng.SCHEMA ? 'warn' : ''));
    const unset = s && s.epoch == null;
    chips.push(chip('Clock', r.clock ? 'set ' + SerialViz.hhmm(r.clock.setAt) + (r.clock.drift ? ' (was ' + (r.clock.drift > 0 ? '+' : '') + r.clock.drift + ' s)' : '')
      : unset ? 'not set' : '<span class="qs-dim">—</span>', unset && !r.clock ? 'warn' : ''));
    if (s && s.batt_mv != null) {
      const pct = s.batt_pct != null ? s.batt_pct : null;
      chips.push(chip('Battery', (s.batt_mv / 1000).toFixed(2) + ' V' + (pct != null ? ' · ' + pct + '%' : ''),
        pct != null && pct < 20 ? 'bad' : '', pct != null ? meter(pct / 100, pct < 20 ? 'm-weak' : pct < 40 ? 'm-marginal' : 'm-good') : ''));
    } else chips.push(chip('Battery', '<span class="qs-dim">—</span>'));
    chips.push(chip('Squelch', s ? (s.sq ? '<span class="qs-led on" aria-hidden="true"></span>open' : '<span class="qs-led" aria-hidden="true"></span>closed') : '<span class="qs-dim">—</span>'));
    chips.push(chip('Noise floor', s && s.nf != null ? s.nf + ' dBm' + (s.rssi != null ? ' · now ' + s.rssi : '') : '<span class="qs-dim">—</span>'));
    const ls = r.logStat || (s ? { state: s.log_state, count: s.log_count, cap: s.log_cap } : null);
    if (ls && ls.state) {
      chips.push(chip('Log', esc(ls.state) + (ls.cap ? ' · ' + ls.count + ' / ' + ls.cap : ''), ls.state !== 'OK' ? 'warn' : '',
        ls.cap ? meter(ls.count / ls.cap, ls.count / ls.cap > 0.9 ? 'm-marginal' : 'm-good') : ''));
    } else chips.push(chip('Log', '<span class="qs-dim">—</span>'));
    const src = r.stnInfo ? r.stnInfo.source + (r.stnInfo.count ? ' · ' + r.stnInfo.count + ' sites' : '') : s ? s.stn_src : '';
    chips.push(chip('Stations', src ? esc(src) : '<span class="qs-dim">—</span>', r.stnInfo && r.stnInfo.state === 'BAD' ? 'bad' : ''));
    chips.push(chip('Heard', (s ? (s.bursts || 0) + ' bursts · ' + (s.decodes || 0) + ' decodes' : r.bursts.length + ' bursts · ' + r.decs.length + ' decodes')
      + (s && s.min_ok != null ? ' · weakest ' + s.min_ok + ' dBm' : '')));
    const quiet = Date.now() - r.lastByte;
    const live = c.phase === 'open' || c.phase === 'follow';
    chips.push(chip('Link', c.demo ? 'demo' : !live ? 'closed' : r.busy ? 'busy: ' + esc(r.busy.text.split(' ').slice(0, 2).join(' '))
      : (c.phase === 'follow' ? 'log file · ' : '') + (quiet > 15000 ? 'quiet ' + Math.round(quiet / 1000) + ' s' : 'live'),
      live && quiet > 15000 ? 'warn' : ''));
    el.innerHTML = chips.join('');
  }

  function paintNotes(c) {
    const el = document.getElementById('qs-notes-' + c.id);
    if (!el) return;
    el.innerHTML = c.radio.notes.map(n => '<p class="qs-note ' + (n.kind === 'bad' ? 'txt-bad' : n.kind === 'warn' ? 'txt-warn' : '') + '">'
      + '<span class="ser-ts">' + SerialViz.hhmm(n.t, true) + '</span> ' + esc(n.text) + '</p>').join('');
  }

  // The signal chart: the noise floor as a line, the sensitivity it implies
  // (nf + SNR_REQ) dashed, the instantaneous RSSI as dots, and every burst as
  // a stem from the floor to its peak — green when it decoded, amber when the
  // radio heard it and could not.
  function paintSignal(c) {
    const cv = document.getElementById('qs-signal-' + c.id);
    const f = SerialViz.fit(cv, 210);
    if (!f) return;
    const { ctx, w, h, dpr } = f, col = SerialViz.colors(), r = c.radio;
    ctx.clearRect(0, 0, w, h);
    const now = Date.now(), t0 = now - r.span * 60000;
    const sta = r.sta.filter(s => s.t >= t0), bst = r.bursts.filter(b => b.t >= t0), dec = r.decs.filter(d => d.t >= t0);
    const top = 16 * dpr, gx = 44 * dpr, gy = 18 * dpr, pw = w - gx - 8 * dpr, ph = h - gy - top;
    let lo = -130, hi = -40;
    const vals = [];
    sta.forEach(s => { if (s.nf != null) vals.push(s.nf); if (s.rssi != null) vals.push(s.rssi); });
    bst.forEach(b => { if (b.peak != null) vals.push(b.peak); });
    if (vals.length) {
      lo = Math.max(-140, Math.floor((Math.min.apply(null, vals) - 6) / 10) * 10);
      hi = Math.min(0, Math.ceil((Math.max.apply(null, vals) + 4) / 10) * 10);
      if (hi - lo < 30) hi = lo + 30;
    }
    const X = t => gx + (t - t0) / (now - t0) * pw;
    const Y = v => top + ph - (v - lo) / (hi - lo) * ph;
    SerialViz.dbGrid(ctx, gx, top, pw, ph, lo, hi, 10, dpr, col);
    // time ticks
    ctx.fillStyle = col.muted;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tick = r.span <= 5 ? 60000 : r.span <= 15 ? 180000 : r.span <= 60 ? 600000 : 1800000;
    for (let t = Math.ceil(t0 / tick) * tick; t <= now; t += tick) ctx.fillText(SerialViz.hhmm(t), X(t), h - gy + 4 * dpr);
    // squelch-open shading from STA
    ctx.fillStyle = SerialViz.alpha(col.accent, 0.08);
    for (let i = 0; i < sta.length; i++) if (sta[i].sq) {
      const a = X(sta[i].t - 5000), b = X(sta[i].t + 5000);
      ctx.fillRect(a, top, b - a, ph);
    }
    // sensitivity (nf + SNR_REQ), dashed
    const snr = Number(r.settings.SNR_REQ) || 12;
    const line = (pts, color, width, dash) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = color; ctx.lineWidth = width * dpr; ctx.setLineDash(dash ? dash.map(x => x * dpr) : []);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const nfPts = sta.filter(s => s.nf != null).map(s => [X(s.t), Y(s.nf)]);
    line(sta.filter(s => s.nf != null).map(s => [X(s.t), Y(s.nf + snr)]), SerialViz.alpha(col.accent, 0.55), 1, [5, 4]);
    line(nfPts, col.muted, 2);
    ctx.fillStyle = SerialViz.alpha(col.text, 0.35);
    sta.forEach(s => { if (s.rssi != null) { ctx.beginPath(); ctx.arc(X(s.t), Y(s.rssi), 1.6 * dpr, 0, 7); ctx.fill(); } });
    // bursts: stems and heads
    bst.forEach(b => {
      if (b.peak == null) return;
      const x = X(b.t), ok = (b.nframes || 0) > 0;
      const color = ok ? col.ok : col.warn;
      ctx.strokeStyle = SerialViz.alpha(color, 0.7); ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.moveTo(x, Y(b.nf != null ? b.nf : lo)); ctx.lineTo(x, Y(b.peak)); ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, Y(b.peak), (2.5 + Math.min(3, b.nframes || 0)) * dpr, 0, 7); ctx.fill();
    });
    // decodes that arrived without their burst (BST off, or before it)
    ctx.strokeStyle = col.ok; ctx.lineWidth = 1.5 * dpr;
    dec.filter(d => !bst.some(b => b.uptime_ms === d.uptime_ms)).forEach(d => {
      if (d.rssi == null) return;
      ctx.beginPath(); ctx.arc(X(d.t), Y(d.rssi), 3.5 * dpr, 0, 7); ctx.stroke();
    });
    ctx.fillStyle = col.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('dBm', 4 * dpr, 2 * dpr);
    // the summary a screen reader gets instead of the picture
    const s = last(sta), decoded = bst.filter(b => b.nframes > 0).length;
    const peak = bst.length ? Math.max.apply(null, bst.map(b => b.peak)) : null;
    cv.setAttribute('aria-label', 'Signal, last ' + r.span + ' minutes: ' + (s && s.nf != null ? 'noise floor ' + s.nf + ' dBm, ' : '')
      + bst.length + ' burst' + (bst.length === 1 ? '' : 's') + ', ' + decoded + ' decoded' + (peak != null ? ', strongest ' + peak + ' dBm' : '') + '.');
  }

  // The burst raster: each burst's demodulated bits, one pixel column a bit,
  // newest on top — the 300-baud stream the radio's UART emulation reads. A
  // frame the radio decoded is boxed in green; one this re-decode finds in
  // the bits that the radio did not report, in amber.
  function paintBursts(c) {
    const cv = document.getElementById('qs-bursts-' + c.id);
    const r = c.radio, rows = r.bursts.slice(-16).reverse();
    const rowH = 12, f = SerialViz.fit(cv, Math.max(60, rows.length * (rowH + 3) + 8));
    if (!f) return;
    const { ctx, w, h, dpr } = f, col = SerialViz.colors();
    ctx.clearRect(0, 0, w, h);
    ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, Consolas, monospace';
    if (!rows.length) {
      ctx.fillStyle = col.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('No bursts yet — each one the radio hears is drawn here, bit by bit.', 8 * dpr, h / 2);
      cv.setAttribute('aria-label', 'Burst bits: none yet.');
      return;
    }
    // Scaled to the longest burst on show, with a column at the right for
    // what each burst carried.
    const gx = 64 * dpr, labelW = Math.min(170 * dpr, w * 0.3);
    const maxBits = Math.max(80, Math.max.apply(null, rows.map(b => b.bits.length)));
    const pw = w - gx - labelW - 8 * dpr, bw = pw / maxBits;
    rows.forEach((b, i) => {
      const y = (4 + i * (rowH + 3)) * dpr, rh = rowH * dpr;
      ctx.fillStyle = (b.nframes || 0) > 0 ? col.muted : col.warn;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(SerialViz.hhmm(b.t, true), gx - 6 * dpr, y + rh / 2);
      const nb = Math.min(b.bits.length, maxBits);
      ctx.fillStyle = SerialViz.alpha(col.border, 0.6);
      ctx.fillRect(gx, y, nb * bw, rh);
      ctx.fillStyle = SerialViz.alpha(col.accent, 0.85);
      for (let k = 0; k < nb; k++) if (b.bits[k]) ctx.fillRect(gx + k * bw, y, Math.max(1, bw - (bw > 3 * dpr ? dpr * 0.5 : 0)), rh);
      // the radio's frames are the re-decode's that match a DEC from this burst
      const reported = new Set(b.decs.map(d => d.id + '=' + d.value));
      const seen = new Set();
      let lx = gx + pw + 8 * dpr;
      ctx.textAlign = 'left';
      b.found.forEach(fr => {
        const key = fr.id + '=' + fr.value;
        if (seen.has(key)) return;
        seen.add(key);
        const mine = reported.has(key) || (!b.decs.length && (b.nframes || 0) > 0);
        ctx.strokeStyle = mine ? col.ok : col.warn;
        ctx.lineWidth = 2 * dpr;
        ctx.strokeRect(gx + fr.pos * bw, y - dpr, 40 * bw, rh + 2 * dpr);
        ctx.fillStyle = mine ? col.ok : col.warn;
        if (lx < w - 20 * dpr) { ctx.fillText(key, lx, y + rh / 2); lx += ctx.measureText(key + '  ').width; }
      });
      if (!b.found.length) { ctx.fillStyle = col.muted; ctx.fillText((b.nframes || 0) > 0 ? '(frames not in these bits)' : 'no frame', lx, y + rh / 2); }
    });
    const und = rows.filter(b => !(b.nframes > 0)).length;
    cv.setAttribute('aria-label', 'Burst bits: the last ' + rows.length + ' bursts as demodulated, ' + und + ' not decoded by the radio. '
      + 'The Readings table lists every frame that was.');
  }

  function valueText(d) {
    if (d.eng !== '' && d.eng != null) return esc(d.eng) + (d.unit ? ' ' + esc(d.unit) : '');
    return d.value === 2047 ? '<span class="qs-dim">full scale</span>' : esc(d.value);
  }
  function fadeBar(db) {
    if (db == null) return '<span class="qs-dim">—</span>';
    const frac = Math.max(0, Math.min(1, db / 40));
    return '<span class="qs-fade">' + meter(frac, SerialViz.marginClass(db)) + '<span>' + db + ' dB</span></span>';
  }

  function paintReadings(c) {
    const tb = document.getElementById('qs-dec-' + c.id);
    if (!tb) return;
    const r = c.radio, rows = r.decs.slice(-200).reverse();
    const cnt = document.getElementById('qs-dec-count-' + c.id);
    if (cnt) cnt.textContent = r.decs.length ? r.decs.length + ' reading' + (r.decs.length === 1 ? '' : 's') : '';
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="8" class="qs-dim">No readings yet. Each frame the radio decodes appears here as it arrives.</td></tr>'; return; }
    tb.innerHTML = rows.map(d => {
      const name = d.mn || d.name;
      const sel = r.sel === d.key;
      return '<tr' + (sel ? ' class="selected"' : '') + '>'
        + '<td><button type="button" class="link-btn qs-time" aria-pressed="' + sel + '" onclick="SerialRadio.select(\'' + c.id + '\',\'' + d.key + '\')">'
        + SerialViz.hhmm(d.t, true) + '</button></td>'
        + '<td class="qs-num">' + d.id + '</td>'
        + '<td>' + (name ? esc(name) : '<span class="qs-dim">not in table</span>') + (d.kind ? ' <span class="ser-badge">' + esc(Quansheng.KIND_LABEL[d.kind] || d.kind) + '</span>' : '') + '</td>'
        + '<td class="qs-num">' + valueText(d) + '</td>'
        + '<td class="col-optional">' + esc(d.fmt) + (d.pol === 'NEG' ? ' NEG' : '') + '</td>'
        + '<td class="qs-num">' + (d.rssi != null ? d.rssi + ' dBm' : '—') + '</td>'
        + '<td>' + fadeBar(d.fade) + '</td>'
        + '<td class="qs-num col-optional">' + (d.burst_ms != null ? d.burst_ms + ' ms' : '') + '</td></tr>';
    }).join('');
  }

  // The selected reading's 32 payload bits, coloured by what each one is —
  // the ALERT Packets tab's colours.
  function paintDetail(c) {
    const el = document.getElementById('qs-detail-' + c.id);
    if (!el) return;
    const r = c.radio, d = r.sel && r.decs.find(x => x.key === r.sel);
    if (!d) { el.innerHTML = '<p class="qs-dim qs-hint">Pick a reading\'s time to see its 32 bits.</p>'; return; }
    const bits = Quansheng.payloadBits(d.payload_hex || '0');
    const roles = Quansheng.payloadRoles(d.fmt);
    const dec = Quansheng.decodePayload32(d.payload_hex || '0');
    const ROLE = { A: 'address', D: 'data', K: 'marker', R: 'CRC' };
    el.innerHTML = '<div class="qs-detail-head"><strong>' + esc(d.payload_hex) + '</strong> · ' + esc(d.fmt) + ' · address ' + d.id + ' · value ' + d.value
      + (dec && (dec.id !== d.id || dec.value !== d.value) ? ' <span class="txt-bad">(re-decodes to ' + dec.id + ' = ' + dec.value + ')</span>' : '')
      + ' · <button type="button" class="link-btn" onclick="SerialRadio.openPayload(\'' + c.id + '\',\'' + esc(d.payload_hex) + '\')">open in ALERT Packets ▸</button></div>'
      + '<div class="qs-bits" role="img" aria-label="Payload ' + esc(d.payload_hex) + ' bit by bit: ' + esc(d.fmt) + ', address ' + d.id + ', value ' + d.value + '">'
      + bits.map((b, i) => '<span class="qs-bit f-' + roles[i] + '">' + b + '</span>').join('') + '</div>'
      + '<div class="qs-legend">' + ['A', 'D', 'K', 'R'].filter(k => roles.indexOf(k) >= 0)
        .map(k => '<span><i class="qs-sw f-' + k + '"></i>' + ROLE[k] + '</span>').join('') + '</div>'
      + '<p class="qs-hint">As transmitted, first bit left. RSSI ' + d.rssi + ' dBm against a ' + d.nf + ' dBm floor; '
      + 'sensitivity ' + d.sens + ' dBm, so ' + d.fade + ' dB of fade margin. Burst ' + d.burst_ms + ' ms, frame ' + d.frame
      + (d.inv ? ', decoded with the bits complemented' : '') + '.</p>';
  }

  function paintStations(c) {
    const tb = document.getElementById('qs-stn-' + c.id);
    if (!tb) return;
    const r = c.radio;
    const list = [...r.stations.values()].sort((a, b) => b.last.t - a.last.t);
    if (!list.length) { tb.innerHTML = '<tr><td colspan="6" class="qs-dim">No stations heard yet.</td></tr>'; return; }
    tb.innerHTML = list.map(s => {
      const fade = s.fade.filter(x => x != null);
      const avg = fade.length ? Math.round(fade.reduce((a, b) => a + b, 0) / fade.length) : null;
      const min = fade.length ? Math.min.apply(null, fade) : null;
      return '<tr><th scope="row" class="qs-num">' + s.id + '</th>'
        + '<td>' + esc(s.mn || s.name || '—') + '</td>'
        + '<td class="qs-num">' + valueText(s.last) + '</td>'
        + '<td class="qs-num">' + s.count + '</td>'
        + '<td>' + fadeBar(avg) + (min != null && min !== avg ? '<span class="qs-dim qs-small"> min ' + min + '</span>' : '') + '</td>'
        + '<td class="col-optional"><span class="qs-trend" aria-label="RSSI of the last ' + s.rssi.length + ' readings">'
        + s.rssi.map(v => '<i class="' + SerialViz.marginClass(v != null ? v + 120 : null) + '" style="--h: ' + Math.max(8, Math.min(100, (v + 125) * 1.4)) + '%"></i>').join('')
        + '</span> <span class="qs-small qs-dim">' + ago(s.last.t) + '</span></td></tr>';
    }).join('');
  }

  function paintSettings(c) {
    const r = c.radio;
    Quansheng.SETTINGS.forEach(s => {
      const v = r.settings[s.name];
      const el = document.getElementById('qs-set-' + c.id + '-' + s.name);
      if (el && document.activeElement !== el && v != null) el.value = s.values ? v : String(v).trim();
      const ro = document.getElementById('qs-cur-' + c.id + '-' + s.name);
      if (ro) ro.textContent = v != null ? v : '—';
    });
  }

  function paintLog(c) {
    const el = document.getElementById('qs-log-' + c.id);
    if (!el) return;
    const r = c.radio, ls = r.logStat;
    el.innerHTML = (ls ? '<p><strong>' + esc(ls.state) + '</strong> — ' + ls.count + ' of ' + ls.cap + ' records'
      + (ls.oldest != null ? ', sequence ' + ls.oldest + '–' + ls.newest : '') + '. '
      + (ls.state === 'FOREIGN' ? 'The log region holds data this firmware did not write; Format takes it over.' : ls.state === 'OFF' ? 'Logging is off (setting LOG).' : '') + '</p>'
      : '<p class="qs-dim">Log state not read yet.</p>')
      + (r.dump ? '<p class="txt-warn">Downloading… ' + r.dump.got + ' records so far</p>' : '');
  }

  function paintTable(c) {
    const el = document.getElementById('qs-table-' + c.id);
    if (!el) return;
    const r = c.radio, si = r.stnInfo, t = r.table, u = r.upload;
    let h = si ? '<p>In use: <strong>' + esc(si.source) + '</strong> · ' + si.count + ' sites · state <strong>' + esc(si.state) + '</strong>'
      + (si.crc ? ' · CRC ' + esc(si.crc) : '') + '. ' + (si.state === 'BAD' ? 'An upload did not finish — the built-in table is in use until one does.' : si.state === 'FOREIGN' ? 'The region holds data that is not this firmware\'s: Format takes it over.' : '') + '</p>'
      : '<p class="qs-dim">Table not read yet.</p>';
    if (r.lookup) {
      const l = r.lookup;
      h += '<p>Address ' + l.id + ': the radio calls it <strong>' + (l.name ? esc(l.name) + ' (' + esc(l.kind || 'no kind') + ')' : 'nothing') + '</strong>'
        + (l.mn ? '; MegaNet calls it <strong>' + esc(l.mn) + '</strong>' : '; MegaNet has no station at it') + '.</p>';
    }
    if (t) {
      h += '<p>Built from MegaNet: <strong>' + t.sites.length + ' sites</strong>, ' + t.addresses + ' addresses, ' + t.blob.length + ' of 65,504 bytes, '
        + 'source ' + esc(t.source) + ', CRC-32 ' + Quansheng.hex8(t.crc) + (t.withFile ? ' (address file as fallback)' : ' (stations only)') + '. '
        + (t.problems.length ? '<span class="txt-bad">' + esc(t.problems.join('; ')) + '</span>' : 'Every structural check passes.')
        + (t.collisions ? ' ' + t.collisions + ' addresses are claimed by more than one name; the first claimant wins, as in the firmware build.' : '') + '</p>';
    }
    if (u) {
      const pct = Math.round(100 * u.i / Math.max(1, u.n - 1));
      h += '<label class="qs-progress">Uploading at ' + u.chunk + '-byte chunks — ' + pct + '% <progress max="100" value="' + pct + '"></progress></label>';
    }
    el.innerHTML = h;
    const up = document.getElementById('qs-stn-up-' + c.id);
    if (up) up.disabled = !t || !!u || (t && t.problems.length > 0);
    const cancel = document.getElementById('qs-stn-cancel-' + c.id);
    if (cancel) cancel.hidden = !u;
  }

  function paintScreen(c) {
    const cv = document.getElementById('qs-screen-' + c.id);
    if (!cv) return;
    const r = c.radio;
    const sc = 3;
    if (cv.width !== 128 * sc) { cv.width = 128 * sc; cv.height = 64 * sc; }
    const ctx = cv.getContext('2d');
    // An LCD: dark pixels on a pale green-grey ground, theme-independent like
    // the real glass.
    ctx.fillStyle = '#b9c6a8';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const meta = document.getElementById('qs-screen-meta-' + c.id);
    if (!r.screen) {
      if (meta) meta.textContent = 'Not captured yet.';
      cv.setAttribute('aria-label', 'Radio screen: not captured yet.');
      return;
    }
    ctx.fillStyle = '#1e2a1a';
    for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) if (r.screen[y * 128 + x]) ctx.fillRect(x * sc, y * sc, sc - 0.5, sc - 0.5);
    if (meta) meta.textContent = 'Captured ' + SerialViz.hhmm(r.screenAt, true) + (r.screenAuto ? ' · mirroring every 2.5 s' : '') + '.';
    cv.setAttribute('aria-label', 'Radio screen, 128 by 64 pixels, captured at ' + SerialViz.hhmm(r.screenAt, true) + '.');
  }

  function paintEvents(c) {
    const el = document.getElementById('qs-events-' + c.id);
    if (!el) return;
    const ev = c.radio.events.slice(-8).reverse();
    el.innerHTML = ev.length ? ev.map(e => '<li><span class="ser-ts">' + SerialViz.hhmm(e.t, true) + '</span> <strong>' + esc(e.code) + '</strong> '
      + esc(e.detail || '') + '</li>').join('') : '<li class="qs-dim">No events yet.</li>';
  }

  // ── the body ──────────────────────────────────────────────────────────────

  function settingRow(c, s) {
    const id = c.id, key = 'qs-set-' + id + '-' + s.name, label = s.name.replace(/_/g, ' ');
    let ctl;
    if (s.readOnly) ctl = '<span class="qs-readout" id="qs-cur-' + id + '-' + s.name + '">—</span>';
    else if (s.rerun) {
      ctl = '<span class="qs-readout" id="qs-cur-' + id + '-' + s.name + '">—</span> '
        + '<button type="button" class="ghost" onclick="SerialRadio.step(\'' + id + '\',\'' + s.name + '\',\'+\')">Re-run census</button>';
    } else if (s.values) {
      ctl = '<select id="' + key + '" aria-label="' + esc(label) + '" onchange="SerialRadio.applySetting(\'' + id + '\',\'' + s.name + '\',this.value)">'
        + '<option value="" disabled selected>—</option>'
        + s.values.map(v => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('') + '</select>';
    } else {
      ctl = '<span class="qs-num-ctl">'
        + '<button type="button" class="ghost qs-step" aria-label="' + esc(label) + ' down one step" onclick="SerialRadio.step(\'' + id + '\',\'' + s.name + '\',\'-\')">−</button>'
        + '<input type="number" id="' + key + '" aria-label="' + esc(label) + (s.unit ? ' (' + s.unit + ')' : '') + '" min="' + s.min + '" max="' + s.max + '" step="' + s.step + '"'
        + ' onkeydown="if(event.key===\'Enter\')SerialRadio.applyNumber(\'' + id + '\',\'' + s.name + '\')">'
        + '<button type="button" class="ghost qs-step" aria-label="' + esc(label) + ' up one step" onclick="SerialRadio.step(\'' + id + '\',\'' + s.name + '\',\'+\')">+</button>'
        + '<button type="button" class="ghost" onclick="SerialRadio.applyNumber(\'' + id + '\',\'' + s.name + '\')">Set</button></span>';
    }
    return '<div class="qs-set"><div class="qs-set-name">' + esc(label) + (s.inApp ? ' <span class="ser-badge">in app</span>' : '') + '</div>'
      + '<div class="qs-set-ctl">' + ctl + '</div><div class="qs-set-note">' + esc(s.note) + '</div></div>';
  }

  // The live body of a Quansheng card. serial.js puts the head above it.
  function body(c) {
    const id = c.id, open = c.phase === 'open' || c.demo;
    const following = c.phase === 'follow';
    const btn = (label, fn, extra) => '<button type="button" class="ghost" onclick="SerialRadio.' + fn + '"' + (extra || '') + '>' + label + '</button>';
    const dis = open ? '' : ' disabled';
    // The console's own controls copy their command while following a log.
    const cdis = open || following ? '' : ' disabled';
    let tb = '<div class="ser-toolbar">';
    if (c.phase === 'open' || c.demo) tb += btn('Sync clock', 'syncClock(\'' + id + '\')') + btn('Refresh', 'refresh(\'' + id + '\')');
    if (following) tb += btn('Copy clock command', 'copyClock(\'' + id + '\')');
    tb += Serial.toolbarButtons(c);
    tb += '</div>' + Serial.followHtml(c);
    const spans = SPANS.map(([m, l]) => '<option value="' + m + '"' + (c.radio && c.radio.span === m ? ' selected' : '') + '>' + l + '</option>').join('');
    return '<div class="qs-dash" id="qs-dash-' + id + '">'
      + tb
      + '<div class="qs-status" id="qs-status-' + id + '"></div>'
      + '<div class="qs-notes" id="qs-notes-' + id + '" aria-live="off"></div>'
      + '<div class="qs-grid">'
      + '<section class="qs-panel" aria-labelledby="qs-h-sig-' + id + '"><div class="qs-panel-head"><h3 id="qs-h-sig-' + id + '">Signal</h3>'
      + '<label class="ser-check">span <select aria-label="Signal chart time span" onchange="SerialRadio.setSpan(\'' + id + '\',this.value)">' + spans + '</select></label></div>'
      + '<canvas class="qs-canvas qs-canvas-signal" id="qs-signal-' + id + '" role="img" aria-label="Signal chart"></canvas>'
      + '<div class="qs-legend"><span><i class="qs-sw sw-muted"></i>noise floor</span><span><i class="qs-sw sw-dash"></i>sensitivity (floor + SNR_REQ)</span>'
      + '<span><i class="qs-sw sw-dot"></i>RSSI now</span><span><i class="qs-sw sw-ok"></i>burst, decoded</span><span><i class="qs-sw sw-warn"></i>burst, not decoded</span></div></section>'
      + '<section class="qs-panel" aria-labelledby="qs-h-bst-' + id + '"><div class="qs-panel-head"><h3 id="qs-h-bst-' + id + '">Burst bits</h3></div>'
      + '<canvas class="qs-canvas" id="qs-bursts-' + id + '" role="img" aria-label="Burst bits"></canvas>'
      + '<p class="qs-hint">Each row is one burst as the radio demodulated it, one column per 300-baud bit, newest on top. '
      + '<span class="txt-ok">Green</span> boxes are frames the radio reported; <span class="txt-warn">amber</span> ones are frames a re-decode finds in the bits that it did not.</p></section>'
      + '</div>'
      + '<section class="qs-panel" aria-labelledby="qs-h-dec-' + id + '"><div class="qs-panel-head"><h3 id="qs-h-dec-' + id + '">Readings</h3>'
      + '<span class="qs-small qs-dim" id="qs-dec-count-' + id + '"></span>'
      + '<span class="qs-head-actions">' + btn('Export CSV', 'exportReadings(\'' + id + '\')') + btn('Clear', 'clearData(\'' + id + '\')') + '</span></div>'
      + '<div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="qs-h-dec-' + id + '"><table class="qs-table">'
      + '<caption class="sr-only">Readings decoded by the radio, newest first</caption>'
      + '<colgroup><col style="width: 10%"><col style="width: 7%"><col style="width: 25%"><col style="width: 11%"><col class="col-optional" style="width: 8%">'
      + '<col style="width: 11%"><col style="width: 18%"><col class="col-optional" style="width: 10%"></colgroup><thead><tr>'
      + '<th scope="col">Time</th><th scope="col">ID</th><th scope="col">Station</th><th scope="col">Value</th><th scope="col" class="col-optional">Format</th>'
      + '<th scope="col">RSSI</th><th scope="col">Fade margin</th><th scope="col" class="col-optional">Burst</th></tr></thead>'
      + '<tbody id="qs-dec-' + id + '"></tbody></table></div>'
      + '<div class="qs-detail" id="qs-detail-' + id + '"></div></section>'
      + '<section class="qs-panel" aria-labelledby="qs-h-stn-' + id + '"><div class="qs-panel-head"><h3 id="qs-h-stn-' + id + '">Stations heard</h3></div>'
      + '<div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="qs-h-stn-' + id + '"><table class="qs-table">'
      + '<caption class="sr-only">Stations heard, most recent first</caption>'
      + '<colgroup><col style="width: 8%"><col style="width: 30%"><col style="width: 14%"><col style="width: 9%"><col style="width: 22%">'
      + '<col class="col-optional" style="width: 17%"></colgroup><thead><tr>'
      + '<th scope="col">ID</th><th scope="col">Station</th><th scope="col">Last value</th><th scope="col">Heard</th><th scope="col">Fade margin (mean)</th>'
      + '<th scope="col" class="col-optional">RSSI trend</th></tr></thead><tbody id="qs-stn-' + id + '"></tbody></table></div></section>'
      + '<div class="qs-controls">'
      + '<details class="qs-ctl"><summary>Radio settings</summary>'
      + '<p class="qs-hint">Read from the radio with INFO; each change is sent with SET, saved to the radio\'s flash, and read back. '
      + '“In app” settings retune the receiver and only answer while the ALERT app is running.</p>'
      + '<div class="qs-settings">' + Quansheng.SETTINGS.map(s => settingRow(c, s)).join('') + '</div></details>'
      + '<details class="qs-ctl"><summary>Flash log</summary><div id="qs-log-' + id + '"></div>'
      + '<div class="ser-actions">' + btn('Read state', 'logStat(\'' + id + '\')', dis)
      + '<label class="qs-inline">newest <input type="number" min="1" id="qs-dump-n-' + id + '" placeholder="all" aria-label="How many of the newest records to download (blank for all)"></label>'
      + btn('Download CSV', 'logDownload(\'' + id + '\')', dis) + btn('Erase log…', 'logClear(\'' + id + '\')', dis) + btn('Format (FOREIGN only)…', 'logFormat(\'' + id + '\')', dis)
      + '</div></details>'
      + '<details class="qs-ctl"><summary>Station table</summary><div id="qs-table-' + id + '"></div>'
      + '<div class="ser-actions">' + btn('Read state', 'stnInfo(\'' + id + '\')', dis)
      + '<label class="qs-inline">address <input type="number" min="0" max="8191" id="qs-stn-id-' + id + '" aria-label="ALERT address to look up"></label>'
      + btn('Look up', 'stnLookup(\'' + id + '\')', dis) + '</div>'
      + '<div class="ser-actions"><label class="ser-check"><input type="checkbox" id="qs-stn-file-' + id + '" checked> address file as fallback</label>'
      + btn('Build from MegaNet', 'stnBuild(\'' + id + '\')') + btn('Save .bin', 'stnSaveBlob(\'' + id + '\')')
      + '<button type="button" class="ghost" id="qs-stn-up-' + id + '" onclick="SerialRadio.stnUpload(\'' + id + '\')" disabled>Upload to radio…</button>'
      + '<button type="button" class="ghost" id="qs-stn-cancel-' + id + '" onclick="SerialRadio.stnCancel(\'' + id + '\')" hidden>Cancel upload</button>'
      + btn('Erase uploaded table…', 'stnClear(\'' + id + '\')', dis) + '</div></details>'
      + '<details class="qs-ctl"><summary>Screen</summary>'
      + '<canvas class="qs-lcd" id="qs-screen-' + id + '" width="384" height="192" role="img" aria-label="Radio screen"></canvas>'
      + '<p class="qs-hint" id="qs-screen-meta-' + id + '"></p>'
      + '<div class="ser-actions">' + btn('Capture', 'screen(\'' + id + '\')', dis)
      + '<label class="ser-check"><input type="checkbox"' + (c.radio && c.radio.screenAuto ? ' checked' : '') + dis
      + ' onchange="SerialRadio.screenAuto(\'' + id + '\',this.checked)"> mirror</label>'
      + btn('Save PNG', 'screenSave(\'' + id + '\')') + btn('Reboot radio…', 'reboot(\'' + id + '\')', dis) + '</div></details>'
      + '<details class="qs-ctl"><summary>Events</summary><ul class="qs-events" id="qs-events-' + id + '"></ul></details>'
      + (typeof SerialIngest !== 'undefined' ? SerialIngest.panel(c) : '')
      + '<details class="qs-ctl"' + (c.radio && c.radio.consoleOpen || following ? ' open' : '') + '><summary>Console and raw stream</summary>'
      + (following ? '<p class="qs-hint">Following a log file: each command below is copied, for pasting into PuTTY.</p>' : '')
      + '<div class="ser-send"><input type="text" id="qs-cmd-' + id + '" placeholder="Console command, e.g. HELP" aria-label="Console command to '
      + (following ? 'copy for PuTTY' : 'send to the radio') + '"'
      + ' onkeydown="if(event.key===\'Enter\')SerialRadio.sendCmd(\'' + id + '\')"' + cdis + '>'
      + btn(following ? 'Copy for PuTTY' : 'Send', 'sendCmd(\'' + id + '\')', cdis) + '</div>'
      + '<div class="ser-actions qs-quick">' + QUICK.map(q => btn(esc(q), 'quick(\'' + id + '\',\'' + q + '\')', cdis)).join('') + '</div>'
      + Serial.statsHtml(c) + Serial.logHtml(c)
      + '</details>'
      + '</div></div>';
  }

  // ── the demo ──────────────────────────────────────────────────────────────
  //
  // A radio with nothing plugged in: the firmware's own example lines, a
  // quarter of an hour of history and a slow live trickle, and a console that
  // answers as §7 says the real one does. The lines go through feed() — the
  // same LineReader, classifier and record parser a real radio's bytes go
  // through — so what the demo shows is what a radio produces.

  const DEMO_STATIONS = [
    [2088, 'MARBURG', 'BATT', v => [v, (v / 10).toFixed(1), 'V'], 141, 145],
    [2442, 'KINGSHOLME MO', 'RAIN', v => [v, String(v), 'tips'], 23, 27],
    [2443, 'KINGSHOLME MO', 'BATT', v => [v, (v / 10).toFixed(1), 'V'], 140, 143],
    [4109, 'ROTHWELL', 'RAIN', v => [v, String(v), 'tips'], 1290, 1294],
    [4110, 'ROTHWELL', 'LVL', v => [v, String(v), ''], 11, 15],
  ];

  function demoPayload(id, value) {
    const w = AlertDsp.encodeFrame(AlertDsp.BINARY, id, value);
    let hex = '', bin = '';
    for (let k = 0; k < 4; k++) {
      let byte = 0;
      for (let i = 0; i < 8; i++) { const b = (w[k] >> i) & 1; byte = (byte << 1) | b; bin += b; }
      hex += byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return { hex, bin, words: w };
  }

  // The burst's bits as the radio's demodulator gives them: STD framing,
  // complemented (inv 1), idle before and between, MSB-first hex.
  function demoBurstHex(frames, noise) {
    const bits = [];
    for (let i = 0; i < 24; i++) bits.push(1);
    frames.forEach(w => { w.forEach(b => { bits.push(0); for (let i = 0; i < 8; i++) bits.push((b >> i) & 1); bits.push(1); }); bits.push(1, 1); });
    for (let i = 0; i < 10; i++) bits.push(1);
    // a burst too weak to decode does not hold clean frames: flip some bits
    const raw = bits.map(b => (b ^ 1) ^ (noise && Math.random() < noise ? 1 : 0));
    let hex = '';
    for (let i = 0; i < raw.length; i += 8) {
      let byte = 0;
      for (let k = 0; k < 8; k++) byte = (byte << 1) | (raw[i + k] || 0);
      hex += byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return { hex, nbits: raw.length };
  }

  function demoState(c) {
    const r = c.radio;
    if (r.demo) return r.demo;
    r.demo = {
      seq: 1040, uptime: 180000, bursts: 14, decodes: 16, nf: -121, batt: 7890, logCount: 1040,
      settings: { VOICE: 'OFF', SPEAKER: 'SQL', CSV_OUT: 'ON', LOG: 'ON', UNKNOWN: 'SHOW', CONFIRM: 'OFF', SQ_GATE: 'ON',
        SNR_REQ: '12', DEBUG: 'OFF', MDM_MODE: 'ADC', CENSUS: 'PA4B', FREQ_MHZ: '151.500', SQL_LEVEL: '3.0' },
      clock: null, stn: { source: 'BUILTIN MegaNet:95f6f8d', count: 443, crc: '', state: 'BUILTIN' }, log: [],
    };
    return r.demo;
  }

  function demoEpoch(d, t) { return d.clock ? d.clock + Math.round((t - d.clockAt) / 1000) : ''; }

  function demoBurst(c, t, pick) {
    const d = demoState(c);
    const st = pick || DEMO_STATIONS[Math.floor(Math.random() * DEMO_STATIONS.length)];
    const sib = st[0] === 2443 ? DEMO_STATIONS[1] : st[0] === 4109 ? DEMO_STATIONS[4] : null;
    const group = sib ? [st, sib] : [st];
    d.uptime += 20000 + Math.round(Math.random() * 30000);
    const rssi = -60 - Math.round(Math.random() * 50), ms = 380 + Math.round(Math.random() * 160);
    const nf = d.nf + Math.round(Math.random() * 2 - 1), sens = nf + Number(d.settings.SNR_REQ);
    const decode = rssi - sens >= 4;
    const frames = group.map(s => {
      const v = s[4] + Math.round(Math.random() * (s[5] - s[4]));
      return { s, v, p: demoPayload(s[0], v) };
    });
    const lines = [];
    if (decode) frames.forEach((f, i) => {
      d.seq++; d.decodes++; d.logCount++;
      const [raw, eng, unit] = f.s[3](f.v);
      const dec = ['DEC', d.seq, demoEpoch(d, t), d.uptime, 12, f.s[0], f.s[1], f.s[2], raw, eng, unit, 'ABF', 'STD', 1, i,
        rssi, nf, sens, rssi - sens, ms, f.p.hex, f.p.bin].join(',');
      lines.push(dec);
      d.log.push(dec.replace(/^DEC,/, 'LOG,'));
    });
    d.bursts++;
    const bh = demoBurstHex(frames.map(f => f.p.words), decode ? 0 : 0.2);
    lines.push(['BST', d.bursts, demoEpoch(d, t), d.uptime, rssi, nf, ms, decode ? frames.length : 0, bh.nbits, bh.hex].join(','));
    return lines;
  }

  function demoSta(c, t, sq) {
    const d = demoState(c);
    d.uptime += 1000;
    d.nf = Math.max(-124, Math.min(-112, d.nf + Math.round(Math.random() * 2 - 1)));
    d.batt = Math.max(7300, d.batt - (Math.random() < 0.2 ? 5 : 0));
    const rssi = d.nf - 3 + Math.round(Math.random() * 4);
    return ['STA', demoEpoch(d, t), d.uptime, d.nf, sq ? rssi + 40 : rssi, sq ? 1 : 0, d.batt, Math.round((d.batt - 7000) / 12), d.bursts, d.decodes,
      -104, 'OK', d.logCount, 5969, d.stn.state === 'SPI' ? 'SPI ' + d.stn.source : d.stn.source].join(',');
  }

  function demoFeed(c, lines, t) {
    lines.forEach(l => {
      const r = c.radio;
      r.lastByte = Date.now();
      onLine(c, l, t);
    });
  }

  // Start a demo radio on a connection serial.js has just made.
  function demo(c) {
    c.radio = fresh();
    c.demo = true;
    attach(c);
    const now = Date.now();
    const r = c.radio;
    const hdr = ['HDR,fw,4d06107f,schema,2'].concat(['DEC', 'BST', 'STA', 'EVT'].map(k => 'HDR,' + k + ',' + Quansheng.DEFAULT_FIELDS[k].join(',')));
    demoFeed(c, ['B ver=4d06107f rst=por n=0 bl=5a3c9e01', 'EVT,,5230,BOOT,POR 12', 'EVT,,12050,CENSUS,PA4B pa=0 ON'].concat(hdr), now - 16 * 60000);
    // fifteen minutes of history: an STA every 10 s, a burst every minute or so
    let nextBurst = now - 15 * 60000 + 40000;
    for (let t = now - 15 * 60000; t < now; t += 10000) {
      const sq = t <= nextBurst && t + 10000 > nextBurst;
      demoFeed(c, [demoSta(c, t, sq)], t);
      if (sq) { demoFeed(c, demoBurst(c, nextBurst), nextBurst); nextBurst += 45000 + Math.random() * 60000; }
    }
    r.settings = Object.assign({}, demoState(c).settings);
    r.logStat = { state: 'OK', count: demoState(c).logCount, cap: 5969, oldest: 1, newest: demoState(c).seq };
    r.stnInfo = { source: demoState(c).stn.source, count: 443, crc: '', state: 'BUILTIN' };
    const sel = last(r.decs);
    r.sel = sel ? sel.key : null;
    Serial.logLine(c, 'Demo radio — the firmware\'s own example lines and a simulated stream; no device attached', 'sys');
    // and a slow live trickle
    let tick = 0;
    r.demoTimer = setInterval(() => {
      if (!conn(c.id)) { clearInterval(r.demoTimer); return; }
      tick++;
      const t = Date.now();
      if (tick % 4 === 0) demoFeed(c, [demoSta(c, t, false)], t);
      if (Math.random() < 0.18) demoFeed(c, demoBurst(c, t), t);
    }, 2500);
    mark(c, 'status', 'signal', 'bursts', 'readings', 'stations', 'settings', 'log', 'stations-table', 'detail', 'events');
  }

  // §7, simulated: the replies the console document gives.
  function demoAnswer(c, text) {
    const r = c.radio;
    if (!r || !r.busy) return;
    const d = demoState(c);
    const send = (lines, final) => { Serial.logLine(c, '» ' + text, 'tx'); demoFeed(c, lines.concat([final || 'OK'])); };
    const parts = text.trim().split(/\s+/);
    const op = (parts[0] || '').toUpperCase(), arg = (parts[1] || '').toUpperCase();
    const t = Date.now();
    if (op === 'TIME' && parts[1]) {
      if (!/^\d+$/.test(parts[1])) return send([], 'ERR,ARGS');
      const first = !d.clock;
      d.clock = +parts[1]; d.clockAt = t;
      send([]);
      demoFeed(c, ['EVT,' + d.clock + ',' + d.uptime + ',CLOCK,' + (first ? 'SET' : 'STEP 0')]);
      return null;
    }
    if (op === 'TIME') return send(['TIME,' + demoEpoch(d, t)]);
    if (op === 'CSV' && arg === 'HDR') return send(['HDR,fw,4d06107f,schema,2'].concat(['DEC', 'BST', 'STA', 'EVT'].map(k => 'HDR,' + k + ',' + Quansheng.DEFAULT_FIELDS[k].join(','))));
    const gets = names => names.map(n => 'GET,' + n + ',' + d.settings[n]);
    if (op === 'INFO') {
      return send(['INFO,fw,4d06107f', 'INFO,uptime_ms,' + d.uptime, 'INFO,epoch,' + demoEpoch(d, t), 'INFO,batt_mv,' + d.batt,
        'INFO,batt_pct,' + Math.round((d.batt - 7000) / 12), 'INFO,nf,' + d.nf, 'INFO,log,OK,' + d.logCount + ',5969',
        'INFO,stn,' + d.stn.source + ',' + d.stn.count + ',' + d.stn.state].concat(gets(Object.keys(d.settings))));
    }
    if (op === 'GET') {
      if (!parts[1]) return send(gets(Object.keys(d.settings)));
      return d.settings[arg] != null ? send(gets([arg])) : send([], 'ERR,NAME');
    }
    if (op === 'SET') {
      const name = arg, val = (parts[2] || '').replace(/_/g, ' ');
      if (d.settings[name] == null) return send([], 'ERR,NAME');
      if (name === 'MDM_MODE') return send([], 'ERR,READONLY');
      const s = Quansheng.SETTINGS.find(x => x.name === name);
      let nv = val;
      if (val === '+' || val === '-') {
        if (s.values) { const i = s.values.indexOf(d.settings[name]); nv = s.values[(i + (val === '+' ? 1 : s.values.length - 1)) % s.values.length]; }
        else if (s.rerun) nv = 'PA4B';
        else nv = String(Math.max(s.min, Math.min(s.max, Number(d.settings[name]) + (val === '+' ? s.step : -s.step))));
      } else {
        const why = Quansheng.checkSetting(name, parts[2] || '');
        if (why) return send([], /Between/.test(why) ? 'ERR,RANGE' : 'ERR,ARGS');
      }
      if (name === 'FREQ_MHZ') nv = (Math.round(Number(nv) / 0.0125) * 0.0125).toFixed(3);
      if (name === 'SQL_LEVEL') nv = Number(nv).toFixed(1);
      const changed = d.settings[name] !== nv;
      d.settings[name] = nv;
      send([]);
      if (changed) demoFeed(c, ['EVT,' + demoEpoch(d, t) + ',' + d.uptime + ',SET,' + name + '=' + nv]);
      return null;
    }
    if (op === 'LOG') {
      if (arg === 'STAT') return send(['LOG,' + d.logCount + ',5969,1,' + d.seq + ',OK']);
      if (arg === 'DUMP') { const n = parseInt(parts[2], 10); return send(n ? d.log.slice(-n) : d.log.slice()); }
      if (arg === 'CLEAR') { if ((parts[2] || '').toUpperCase() !== 'YES') return send([], 'ERR,CONFIRM'); d.log = []; d.logCount = 0; return send([]); }
      if (arg === 'FORMAT') return send([], (parts[2] || '').toUpperCase() === 'FORCE' ? 'OK' : 'ERR,CONFIRM');
      return send([], 'ERR,ARGS');
    }
    if (op === 'STN') {
      if (arg === 'INFO') return send(['STN,' + d.stn.source + ',' + d.stn.count + ',' + d.stn.crc + ',' + d.stn.state]);
      if (arg === 'GET') {
        const aid = parseInt(parts[2], 10);
        const s = DEMO_STATIONS.find(x => x[0] === aid);
        return send(['STN,' + aid + ',' + (s ? s[1] + ',' + s[2] : ',')]);
      }
      if (arg === 'BEGIN') { d.up = { len: +parts[2], crc: parts[3] }; d.stn.state = 'BAD'; return send([]); }
      if (arg === 'W') return send([], d.up ? 'OK' : 'ERR,STATE');
      if (arg === 'END') {
        if (!d.up) return send([], 'ERR,STATE');
        const tb = r.table;
        d.stn = { source: tb ? tb.source : 'MegaNet:demo', count: tb ? tb.sites.length : 0, crc: tb ? Quansheng.hex8(tb.crc) : '', state: 'SPI' };
        d.up = null;
        return send([]);
      }
      if (arg === 'CLEAR') { d.stn = { source: 'BUILTIN MegaNet:95f6f8d', count: 443, crc: '', state: 'BUILTIN' }; return send([]); }
      if (arg === 'FORMAT') return send([]);
      return send([], 'ERR,ARGS');
    }
    if (op === 'SCREEN') return send(demoScreenRows(d).map((h, i) => 'SCR,' + i + ',' + h));
    if (op === 'HELP') return send(['HELP,HELP', 'HELP,INFO', 'HELP,TIME [epoch]', 'HELP,CSV HDR', 'HELP,GET [name]', 'HELP,SET name value',
      'HELP,LOG STAT|DUMP [n]|CLEAR YES|FORMAT FORCE', 'HELP,STN INFO|GET id|BEGIN len crc32|W off hex|END|CLEAR YES', 'HELP,SCREEN', 'HELP,SPI READ addr len', 'HELP,REBOOT']);
    if (op === 'REBOOT') { send([]); demoFeed(c, ['EVT,,5230,BOOT,SW ' + (++d.seq % 100)]); d.clock = null; return null; }
    if (op === 'SPI') return send(['SPI,1A0000,4153544201002C0A24C40000610A8F3E4D6567614E65743A3935663666386400']);
    return send([], 'ERR,UNKNOWN');
  }

  // A 3×5 pixel font, enough for the demo radio's screen.
  const FONT = {
    0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
    5: '111100111001111', 6: '111100111101111', 7: '111001001001001', 8: '111101111101111', 9: '111101111001111',
    '.': '000000000000010', '-': '000000111000000', ':': '000010000010000', ' ': '000000000000000', A: '010101111101101',
    B: '110101110101110', C: '111100100100111', D: '110101101101110', E: '111100110100111', F: '111100110100100',
    G: '111100101101111', H: '101101111101101', I: '111010010010111', K: '101101110101101', L: '100100100100111',
    M: '101111111101101', N: '110101101101101', O: '111101101101111', P: '111101111100100', Q: '111101101111001',
    R: '110101110101101', S: '111100111001111', T: '111010010010010', U: '101101101101111', V: '101101101101010',
    W: '101101111111101', X: '101101010101101', Y: '101101010010010', Z: '111001010100111', '%': '101001010100101', '/': '001001010100100',
  };

  function demoScreenRows(d) {
    const px = new Uint8Array(128 * 64);
    const set = (x, y) => { if (x >= 0 && x < 128 && y >= 0 && y < 64) px[y * 128 + x] = 1; };
    const text = (s, x, y, k) => {
      k = k || 1;
      for (const ch of s.toUpperCase()) {
        const g = FONT[ch] || FONT[' '];
        for (let i = 0; i < 15; i++) if (g[i] === '1') for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) set(x + (i % 3) * k + a, y + Math.floor(i / 3) * k + b);
        x += 4 * k;
      }
    };
    text('ALERT RX', 2, 1);
    text(Math.round((d.batt - 7000) / 12) + '%', 108, 1);
    for (let x = 0; x < 128; x++) set(x, 7);
    text(d.settings.FREQ_MHZ, 4, 12, 3);
    text('MHZ', 100, 18, 1);
    text('NF ' + d.nf + ' DBM', 4, 34);
    const lastDec = (d.log[d.log.length - 1] || '').split(',');
    if (lastDec.length > 9) text(lastDec[5] + ' ' + lastDec[6].slice(0, 9) + ' ' + lastDec[9] + lastDec[10], 4, 42);
    for (let x = 4; x < 124; x++) { set(x, 52); set(x, 58); }
    const s = Math.max(0, Math.min(120, (d.nf + 130) * 4));
    for (let x = 4; x < 4 + s; x++) for (let y = 53; y < 58; y++) set(x, y);
    const rows = [];
    for (let r = 0; r < 8; r++) {
      let h = '';
      for (let x = 0; x < 128; x++) {
        let b = 0;
        for (let bit = 0; bit < 8; bit++) if (px[(r * 8 + bit) * 128 + x]) b |= 1 << bit;
        h += b.toString(16).toUpperCase().padStart(2, '0');
      }
      rows.push(h);
    }
    return rows;
  }

  return {
    attach, detach, feed, body, mount: mountAll, demo,
    syncClock, refresh, applySetting, applyNumber, step, logStat, logDownload, logClear, logFormat,
    stnInfo, stnLookup, stnBuild, stnSaveBlob, stnUpload, stnCancel, stnClear,
    screen, screenAuto, screenSave, reboot, sendCmd, quick, copyClock, select, setSpan, clearData, exportReadings, openPayload,
  };
})();
