// MegaNet — a2-terminal.js
//
//   A2Terminal   the ELPRO ERT-A2's console over its USB B port, simulated:
//                the login, the header, every menu the logs in
//                archive/ERTA2_logs/ show, the value prompts with the current
//                value already in them, the choice lists with the current one
//                starred, the y/n questions and "Press any key..", the quick
//                set-ups, and the firmware loads that take the USB link
//                off-line. Pure: no DOM, no clock — a state and the keys
//                pressed into it, so the A2 tab's walkthrough, its demos and
//                its interactive terminal all print the same screens, and
//                test/a2firmware.mjs holds them to the logs.
//
// Written from PuTTY logs of real units (Nov 2025 – Oct 2026, firmware v1.7,
// hardware Rev3.B, Rev3.C and Rev4.A, the "current" build): the words, the
// letters, the tabs, the blank lines and the punctuation are theirs. Where the
// logs never show an option used — Change Password, Set Date & Time, the
// analog inputs, a Technician login that works — the option is listed and
// says so when picked (NOT_LOGGED) rather than inventing what the unit prints.
//
// After nothing; read by a2-firmware.js at call time. Nothing runs at load.
//
// The state is plain data (JSON-clonable). `lines` is the scroll-back, a line
// { t, c } — its text and a kind for colour — with { clear: true } where the
// unit clears the screen (it sends ~50 blank lines; screen() shows only what
// follows the last clear); the last line is open while the unit waits for a
// key. `at` is what it is waiting for; `cfg` the settings and `saved` them as
// last saved; `dirty` the unit's own "Config NOT Saved" flag; `fw` the
// versions; `link` whether the USB connection is up; `events` what happened on
// the unit itself (a load, a restart) for the drawing of the board.
//
// Exposes: create, key, keys, type, reconnect, reset, timeout, test, unplug,
//          plug, note, screen, clone, takeEvents, FW, PROFILES, NOT_LOGGED.

const A2Terminal = (function () {
  const T = '\t';
  const NOT_LOGGED = 'Simulator: no log shows this option used, so there is nothing true to show here.';

  // ── The versions ───────────────────────────────────────────────────────────
  // As Show Firmware Version prints them: ELPRO's examples for an old host,
  // the logs' units on v1.7 : 10366, and Release G's radio application.
  const FW = {
    host:  { old: 'v1.6 Aug 25 2022 14:43:29 : 9814', new: 'v1.7 Sep 20 2024 17:32:50 : 10366' },
    boot:  { old: 'v1.1 - 8708:261:33:0:0', new: 'v1.3 - 9967:0:0:1:0' },
    radio: { old: '1.0,ELPRO,ERT-A2,FW1.4,9869', mid: 'v1.4 [Jul 26 2024 17:27:44] (10301)', new: 'v1.4 [Apr 24 2026 11:52:00] (10848)' },
  };

  // ── The unit's settings ────────────────────────────────────────────────────
  const inp = (mode, raw, id, fmt, scale, offset, sens, value) => ({ mode, raw, id, fmt, scale, offset, sens, display: '', value });
  const BASE = {
    address: 1000, updateMin: 180, paralysisSec: 10,
    logFormat: 'CSV on Change', battery: 'Built-in LiFePO4',
    commMode: 'Integrated Radio Reporting', unitType: 'Field Station',
    txMHz: '151.500000', rxMHz: '151.500000', txPower: '5W', reportFormat: 'ALERT Binary',
    gpsUpdate: 1440, gpsMaxOn: 2, supplyMode: 'On Demand', supplyStart: 0, supplyRepeat: 0, supplyOn: 0,
    repDelayMs: 543, addrList: 'List 1',
    lists: [{ action: 'Pass', entries: [[0, 9999]] }, null, null, null],
    agency: 'ELPRO', secondary: 'None', baud: 9600, protocol: 'ALERT2 ASCII Protocol',
    debug: false, rxInd: false, maint: false, supplyForce: false, tones: false,
    hw: 'Rev4.A', serial: '00000000', rssiDbm: 0, sdiMode: 'Disabled', sdiSampleMin: 1, sdiWarmSec: 10,
    sdiCmd: 'Start Measurement (M!)', dinMode: 'Encoder DI1 Incr, DI2 Quad',
    analogSampleMin: 15, analogWarmSec: 10,
    clock: Date.UTC(2026, 4, 1, 9, 14, 5) / 1000,
    // The inputs as the I/O tables print them; an ID of '-' is switched off.
    inputs: {
      DI1: inp('Incr', '0', '-', 'U-2', '1', '0', '1', '0'),
      DI2: inp('Quad', '100', '-', 'U-2', '1', '0', '1', '100'),
      DI3: inp('Pulse', '924', '848', 'U-2', '0.2', '0mm', '1mm', '185mm'),
      DI4: inp('Off', 'Off', '-', 'U-2', '1', '0', '1', '0'),
      AI1: inp('4-20mA', '0.000 mA', '-', 'S-3', '5000', '0mm', '10mm', '-25%'),
      AI2: inp('4-20mA', '0.000 mA', '-', 'S-3', '5000', '0mm', '10mm', '-25%'),
    },
    internal: {
      Battery: { id: '850', fmt: 'U-2', value: '13.8 V' },
      Supply: { id: '-', fmt: 'U-1', value: '0 V' },
      RSSI: { id: '-', fmt: 'S-1', value: '0dBm' },
      'Int Tmp': { id: '-', fmt: 'S-2', value: '23 C' },
      Status: { id: '-', fmt: 'U-2', value: 'All OK' },
    },
    // Stations a listening unit has heard, for Show RSSI List.
    heard: [],
  };
  const PROFILES = {
    field:    { label: 'Field station', cfg: {} },
    repeater: { label: 'Repeater', cfg: {
      address: 9999, unitType: 'Repeater Station', txPower: '1W', updateMin: 90, paralysisSec: 60, secondary: 'RS232 Reporting',
      protocol: 'ALERT2 Binary Protocol', supplyMode: 'Always On', rssiDbm: -89, analogSampleMin: 1, analogWarmSec: 5,
      heard: [[4111, -107, '00:01:37'], [4110, -109, '00:01:38'], [2444, -107, '00:03:21'], [6445, -116, '00:04:22'], [2049, -94, '00:05:47']],
    } },
    base:     { label: 'Base station receiver', cfg: {
      address: 9999, unitType: 'Base Station Rcvr', updateMin: 90, paralysisSec: 60, secondary: 'RS232 Reporting', supplyMode: 'Always On', rssiDbm: -104,
      heard: [[2215, -110, '00:00:42'], [2216, -109, '00:00:42'], [5378, -107, '00:02:10'], [6128, -113, '00:04:05']],
    } },
  };

  function create(opts = {}) {
    fill();
    const prof = PROFILES[opts.profile] || PROFILES.field;
    const cfg = JSON.parse(JSON.stringify({ ...BASE, ...prof.cfg, ...(opts.cfg || {}) }));
    if (opts.profile === 'repeater') {
      Object.assign(cfg.inputs.DI3, { raw: '1', id: '1', value: '1mm', scale: '1' });
      Object.assign(cfg.inputs.AI1, { raw: '0.010 mA', id: '2', fmt: 'U-2', scale: '300', offset: '0(0mm)', sens: '1(50mm)', value: '0mm' });
      Object.assign(cfg.internal.Battery, { id: '3', value: '12.9 V' });
    }
    const fw = { host: 'new', boot: 'new', radio: 'new', fi: '6015', fsk: '2044', ...(opts.fw || {}) };
    const st = {
      lines: [], at: { k: 'asleep' }, cfg, saved: JSON.stringify(cfg), dirty: false, formatAtSave: cfg.reportFormat,
      fw, link: true, stick: opts.stick !== false, user: null, events: [], pick: 0,
      ed: null, fv: {}, ms: 32700694, keepAll: !!opts.keepAll,
    };
    if (opts.awake) showLogin(st);
    return st;
  }
  const clone = st => JSON.parse(JSON.stringify(st));

  // ── The screen ─────────────────────────────────────────────────────────────

  const KEEP = 220;                         // lines kept: the terminal's scroll-back
  function trim(st) { if (!st.keepAll && st.lines.length > KEEP) st.lines.splice(0, st.lines.length - KEEP); }
  function open(st) { const l = st.lines[st.lines.length - 1]; return l && l.open ? l : null; }
  function close(st) { const o = open(st); if (o) { delete o.open; delete o.cur; } }
  function say(st, t = '', c = '') { close(st); st.lines.push({ t, c }); trim(st); }
  function blank(st, n = 1) { for (let i = 0; i < n; i++) say(st, ''); }
  // The unit's "clear": a run of blank lines, here a marker the screen starts after.
  function clear(st) { close(st); st.lines.push({ t: '', clear: true }); trim(st); }
  function ask(st, t, c = 'tm-p') { close(st); st.lines.push({ t, c, open: true }); trim(st); }
  // A key echoed where the unit is waiting — or, after something printed over
  // the prompt (a transmit trace), at the start of a line of its own.
  function echo(st, s) {
    const o = open(st);
    if (o) o.t += s;
    else st.lines.push({ t: s, c: 'tm-p', open: true });
  }
  // A note from the simulator rather than the unit: what Tera Term does, or why.
  function note(st, t) { say(st, `[ ${t} ]`, 'tm-dim'); }
  // What the terminal shows: the last rows, from the last clear on.
  function screen(st, rows = 24) {
    let from = 0;
    for (let i = st.lines.length - 1; i >= 0; i--) if (st.lines[i].clear) { from = i + 1; break; }
    return st.lines.slice(Math.max(from, st.lines.length - rows));
  }
  function takeEvents(st) { const e = st.events; st.events = []; return e; }

  // ── Menus ──────────────────────────────────────────────────────────────────
  // A title, a blank line, the items (letters given in order, so a menu whose
  // items follow the settings re-letters itself as the unit does), a blank
  // line and the prompt. Main Menu and Address List Entries ask "Selection: ".
  const L = i => String.fromCharCode(97 + i);
  const MENUS = {};
  const PARENT = {};   // where Enter at a menu goes
  const DONE = {};     // what a pick, a y/n, a value accepted does next
  const item = (label, run) => ({ label, run });
  const notLogged = back => st => { note(st, NOT_LOGGED); go(st, back); };

  function showMenu(st, id) {
    const m = MENUS[id](st);
    say(st, `${m.title}:`, 'tm-h');
    blank(st);
    m.items.forEach((it, i) => say(st, `${T}${L(i)})${T}${it.label}`, 'tm-m'));
    blank(st);
    ask(st, `${T}${T}${m.prompt || 'Select'}: `);
    st.at = { k: 'menu', id };
  }
  // A menu reached after the unit clears its screen: the clear, the "Config
  // NOT Saved" line where the unit prints one, and a blank line.
  function clearTo(st, id, dirtyLine = false) {
    clear(st);
    if (dirtyLine && st.dirty) say(st, `${T}Config NOT Saved`, 'tm-warn');
    blank(st);
    showMenu(st, id);
  }
  function go(st, then) {
    if (!then) return;
    if (THEN[then]) THEN[then](st);
    else if (MENUS[then]) showMenu(st, then);
  }

  // The header above every Main Menu, after a clear.
  function header(st) {
    clear(st);
    say(st, `${T}${stamp(st.cfg.clock)} UTC; Station Address: ${st.cfg.address}`, 'tm-dim');
    say(st, `${T}Firmware: ${st.fw.host === 'new' ? 'v1.7' : 'v1.6'}${T}Hardware: ${st.cfg.hw}`, 'tm-dim');
    // A unit that has heard a packet since it started says how strong.
    if (st.cfg.rssiDbm) say(st, `${T}RSSI: ${st.cfg.rssiDbm}dBm`, 'tm-dim');
    if (st.dirty) say(st, `${T}Config NOT Saved`, 'tm-warn');
    blank(st);
    showMenu(st, 'main');
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function stamp(s) {
    const d = new Date(s * 1000), p = n => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }

  // A choice list: the current one starred, the others with a space, Cancel
  // last. Unit Config's and I/O Setup's ask "Select: "; the Communication
  // Menu's "Selection:" (no space), the SDI lists' "Mode:".
  function choose(st, title, opts, cur, then, back, prompt = 'Select: ') {
    say(st, `${T}${T}${title} Selection:`, 'tm-q');
    opts.forEach((o, i) => say(st, `${T}${T}${L(i)})${o === cur ? '*' : ' '}${T}${o}`, 'tm-m'));
    say(st, `${T}${T}${L(opts.length)})${T}Cancel`, 'tm-m');
    ask(st, `${T}${T}${T}${prompt}`);
    st.at = { k: 'choose', opts, then, back, prompt };
  }
  // A value prompt, the current value already in it and the cursor at its end
  // — so Enter on its own keeps it, and changing it starts with Backspace. A
  // placeholder ('-', '?') sits under the cursor for the first key to replace.
  function askValue(st, text, value, then, opt = {}) {
    const v = String(value);
    const ph = v === '-' || v === '?';
    ask(st, `${text}${v}`);
    st.ed = { base: text.length, buf: v, cur: ph ? 0 : v.length, ph, max: opt.max || 40 };
    open(st).cur = st.ed.base + st.ed.cur;
    st.at = { k: 'value', then };
  }
  function yesno(st, text, yes, no, opt = {}) {
    ask(st, `${text} (y/n):`);
    st.at = { k: 'yn', yes, no, strict: !!opt.strict, text };
  }
  function anyKey(st, then) { ask(st, 'Press any key..'); st.at = { k: 'any', then }; }
  // A setting changed: the unit's dirty flag goes up only if it really changed.
  function set(st, field, v) { if (st.cfg[field] !== v) { st.cfg[field] = v; st.dirty = true; } }

  const THEN = {
    main: st => header(st),
    login: st => { clear(st); showLogin(st); },
  };

  // ── The login ──────────────────────────────────────────────────────────────
  function showLogin(st) {
    say(st, 'User Type: Menu:', 'tm-h');
    blank(st);
    say(st, `${T}a)${T}Engineer`, 'tm-m');
    say(st, `${T}b)${T}Technician`, 'tm-m');
    blank(st);
    ask(st, `${T}${T}Select: `);
    st.at = { k: 'login' };
  }

  // ── Keys ───────────────────────────────────────────────────────────────────
  // One key: a printable character, or 'Enter', 'Backspace', 'Delete',
  // 'Escape', 'ArrowLeft'. A digit at a menu picks by position: 1 is a).
  function key(st, k) {
    if (!st.link) return st;
    const a = st.at;
    if (a.k === 'asleep') { clear(st); showLogin(st); return st; }
    if (a.k === 'login') {
      if (k.length === 1) echo(st, k);
      const v = k.toLowerCase();
      if (v === 'a' || v === 'b') {
        st.user = v === 'a' ? 'engineer' : 'technician';
        blank(st);
        ask(st, `${T}${T}Password:`);
        st.ed = { buf: '' };
        st.at = { k: 'password' };
      } else { clear(st); showLogin(st); }
      return st;
    }
    if (a.k === 'password') {
      if (k === 'Enter') {
        close(st);
        blank(st);
        // Every Technician login in the logs fails, so no one knows what it
        // may do; the simulator takes any Engineer password but an empty one.
        if (!st.ed.buf || st.user !== 'engineer') {
          say(st, `${T}${T}Invalid Password:`, 'tm-err');
          if (st.user !== 'engineer') note(st, 'Simulator: no log shows a Technician login succeed — log in as a) Engineer');
          clear(st);
          showLogin(st);
        } else { say(st, `${T}${T}Login Successful!`, 'tm-ok'); header(st); }
      } else if (k === 'Backspace') { if (st.ed.buf) { st.ed.buf = st.ed.buf.slice(0, -1); const o = open(st); if (o) o.t = o.t.slice(0, -1); } }
      else if (k.length === 1) { st.ed.buf += k; echo(st, '*'); }
      return st;
    }
    if (a.k === 'menu') {
      const m = MENUS[a.id](st);
      let i = -1;
      if (k.length === 1) {
        echo(st, k);
        i = /[1-9]/.test(k) ? +k - 1 : k.toLowerCase().charCodeAt(0) - 97;
      }
      const it = m.items[i];
      close(st);
      if (!it) { up(st, a.id); return st; }
      st.pick++;
      markPick(st, `${T}${L(i)})${T}${it.label}`);
      it.run(st);
      return st;
    }
    if (a.k === 'choose') {
      // Enter keeps the current value and leaves, quietly.
      if (k === 'Enter') { close(st); backOut(st, a.back); return st; }
      if (k.length !== 1) { close(st); say(st, `${T}Invalid Selection - Try Again${T}${T}`, 'tm-err'); ask(st, `${T}${T}${T}${a.prompt}`); return st; }
      echo(st, k);
      const i = k.toLowerCase().charCodeAt(0) - 97;
      close(st);
      if (i === a.opts.length) { backOut(st, a.back, true); return st; }
      const pick = a.opts[i];
      if (pick == null) { say(st, `${T}Invalid Selection - Try Again${T}${T}`, 'tm-err'); ask(st, `${T}${T}${T}${a.prompt}`); return st; }
      DONE[a.then](st, pick);
      return st;
    }
    if (a.k === 'value') return edit(st, k);
    if (a.k === 'yn') {
      if (k.length !== 1 && !a.strict) return st;
      if (k.length === 1) echo(st, k);
      close(st);
      const y = k.toLowerCase();
      if (y === 'y' || y === 'n') { DONE[y === 'y' ? a.yes : a.no](st); return st; }
      if (a.strict) { say(st, 'Please Respond Y or N', 'tm-err'); ask(st, `${a.text} (y/n):`); return st; }
      DONE[a.no](st);
      return st;
    }
    if (a.k === 'any') {
      if (k.length === 1) echo(st, k);
      close(st);
      go(st, a.then);
      return st;
    }
    if (a.k === 'stream') {
      // Show I/O Values: its Raw row is redrawn in place until a key.
      close(st);
      blank(st);
      showMenu(st, 'diag');
      return st;
    }
    if (a.k === 'offline-wait') {
      // Back from a load: the console resumes where the unit said it would.
      close(st);
      DONE[a.then](st);
      return st;
    }
    if (a.k === 'onekey') {
      // Tx Power: one key over the 5 of "5W".
      if (k === 'Enter') { close(st); DONE[a.then](st, null); return st; }
      if (k === '1' || k === '5') { const o = open(st); if (o) o.t = o.t.slice(0, -2) + `${k}W`; close(st); DONE[a.then](st, `${k}W`); }
      return st;
    }
    return st;
  }
  // Leaving a list without a pick: its own way back (a DONE that knows it was
  // a Cancel), or the menu it came from.
  function backOut(st, back, cancel = false) {
    if (DONE[back]) DONE[back](st, cancel ? null : undefined);
    else go(st, back);
  }
  function keys(st, list) { for (const k of list) key(st, k); return st; }
  // A value typed over what is there (Backspace to the start first), and Enter.
  function type(st, s, enter = true) {
    if (st.at.k === 'value') { const n = st.ed.ph ? 0 : st.ed.buf.length; for (let i = 0; i < n; i++) key(st, 'Backspace'); }
    for (const ch of String(s)) key(st, ch);
    if (enter) key(st, 'Enter');
    return st;
  }

  // The line editor: Backspace, Delete, the left arrow, typing (over a
  // placeholder or the character under the cursor), Enter — the keys the logs
  // show used at a value prompt.
  function edit(st, k) {
    const e = st.ed, o = open(st);
    if (k === 'Enter') { close(st); const v = e.buf; st.ed = null; DONE[st.at.then](st, v); return st; }
    if (k === 'Backspace') { if (e.cur > 0) { e.buf = e.buf.slice(0, e.cur - 1) + e.buf.slice(e.cur); e.cur--; } e.ph = false; }
    else if (k === 'Delete') { e.buf = e.buf.slice(0, e.cur) + e.buf.slice(e.cur + 1); e.ph = false; }
    else if (k === 'ArrowLeft') { if (e.cur > 0) e.cur--; }
    else if (k.length === 1) {
      if (e.ph) { e.buf = ''; e.cur = 0; e.ph = false; }
      if (e.cur < e.buf.length) e.buf = e.buf.slice(0, e.cur) + k + e.buf.slice(e.cur + 1);
      else if (e.buf.length < e.max) e.buf += k;
      else return st;
      e.cur++;
    } else return st;
    if (o) { o.t = o.t.slice(0, e.base) + e.buf; o.cur = e.base + e.cur; }
    return st;
  }

  // Marks the line of the option just picked, so a picture can light it.
  function markPick(st, label) {
    for (let j = st.lines.length - 1; j >= 0 && j > st.lines.length - 60; j--) {
      if (st.lines[j].t === label) { st.lines[j].pick = st.pick; break; }
    }
  }
  // Enter, or a key that matches nothing, at a menu: up a level.
  function up(st, id) {
    const p = PARENT[id];
    if (!p || p === 'main') header(st);
    else go(st, p);
  }

  // ── The USB link ───────────────────────────────────────────────────────────
  // A load takes the link down; the terminal hears nothing until reconnect().
  function offline(st, job, then) {
    st.link = false;
    st.at = { k: 'offline-wait', then, job };
    st.events.push({ k: 'load', job, stick: st.stick });
  }
  function reconnect(st) { st.link = true; return st; }
  // The unit restarting: the link goes, and it comes back at the login.
  function reset(st) {
    close(st);
    st.link = false;
    st.user = null;
    st.at = { k: 'asleep' };
    st.events.push({ k: 'reboot' });
    return st;
  }
  // Left idle about three and a half minutes, the unit logs itself out —
  // with a word at the Main Menu, silently anywhere else.
  function timeout(st) {
    const atMain = st.at.k === 'menu' && st.at.id === 'main';
    close(st);
    if (atMain) {
      blank(st);
      say(st, `${T}Timed out - Exiting`, 'tm-warn');
      if (st.dirty) { say(st, `${T}${T}Discarding Unsaved Config Changes...`, 'tm-warn'); st.cfg = JSON.parse(st.saved); st.dirty = false; }
      say(st, `${T}${T}Exiting ...`);
    }
    st.user = null;
    clear(st);
    showLogin(st);
    return st;
  }
  function unplug(st) { st.stick = false; st.events.push({ k: 'stick', in: false }); return st; }
  function plug(st) { st.stick = true; st.events.push({ k: 'stick', in: true }); return st; }

  // ── The transmit trace ─────────────────────────────────────────────────────
  // What the unit prints as it sends an update — at any prompt, logged in or
  // not; Force Update Message prints the same. One line per sensor switched on.
  const hex2 = n => (n & 255).toString(16).toUpperCase().padStart(2, '0');
  function trace(st) {
    close(st);
    say(st, `${T}Sending Update...`, 'tm-dim');
    const t = () => (st.ms += 2);
    say(st, `${t()}:Generate ALERT2 frames:`, 'tm-dim');
    const c = st.cfg;
    const on = [...Object.values(c.inputs), ...Object.values(c.internal)].filter(s => s.id !== '-');
    if (on.length) {
      say(st, `${t()}:`, 'tm-dim');
      say(st, `================= GENERAL SENSOR REPORT ====================${t()}:`, 'tm-dim');
      on.forEach((s, i) => {
        say(st, `  |==> ID=${s.id}; val=${parseInt(String(s.raw != null ? s.raw : s.value).replace(/[^\d-]/g, ''), 10) || 0}`, 'tm-dim');
        if (i < on.length - 1) say(st, `${t()}:`, 'tm-dim');
      });
      if (c.commMode === 'Integrated Radio Reporting') {
        // ALERT2 framing: "ALERT2", a header, then the sensors.
        const bytes = [0x41, 0x4C, 0x45, 0x52, 0x54, 0x32, 0x11, 0x01, 0x0F, 0x74, (st.ms >> 8) & 255, st.ms & 255];
        on.forEach(s => bytes.push(+s.id >> 8, +s.id, 0x81, 0x00));
        say(st, `${st.ms += 3}:sent - errts_send_to_radio: ALERT2B: ${bytes.map(hex2).join('')}`, 'tm-dim');
      }
    }
    say(st, `${st.ms += 22}:ALERT2 transmission finished after 0 seconds awake`, 'tm-dim');
    blank(st);
  }
  // TEST pressed on the unit: an update sent, the trace printed over whatever
  // prompt was showing (the unit does not print it again).
  function test(st) { if (st.link) trace(st); return st; }

  // ── Tables ─────────────────────────────────────────────────────────────────
  // A space and a tab, then 12-character columns; rows a label and a tab.
  const col = v => String(v).padEnd(12);
  function table(st, names, rows, c = '') {
    say(st, ` ${T}${names.map(col).join('')}`, c);
    for (const [label, f] of rows) say(st, `${label}${T}${names.map(n => col(f(n))).join('')}`, c);
  }
  // Above the I/O Setup Menu: every input, on or not.
  function ioTables(st) {
    const c = st.cfg, ins = c.inputs, it = c.internal;
    clear(st);
    table(st, Object.keys(ins), [['Raw', n => ins[n].raw], ['ID', n => ins[n].id], ['Value', n => ins[n].value]]);
    blank(st, 2);
    table(st, Object.keys(it), [['ID', n => it[n].id], ['Value', n => it[n].value]]);
    if (st.dirty) { blank(st); say(st, `${T}Config NOT Saved`, 'tm-warn'); blank(st); }
    else blank(st, 2);
    showMenu(st, 'io');
  }

  // ── Main Menu ──────────────────────────────────────────────────────────────

  function exit(st) {
    if (st.dirty) {
      const opts = ['Save Changes', 'Keep but don\'t save', 'Discard Changes'];
      say(st, `${T}${T}Unsaved Changes Selection:`, 'tm-q');
      opts.forEach((o, i) => say(st, `${T}${T}${L(i)})${i ? ' ' : '*'}${T}${o}`, 'tm-m'));
      say(st, `${T}${T}d)${T}Cancel`, 'tm-m');
      ask(st, `${T}${T}${T}Option:`);
      st.at = { k: 'choose', opts, then: 'exitPick', back: 'exitEnter', prompt: 'Option:' };
      return;
    }
    say(st, `${T}${T}Exiting ...`);
    st.user = null;
    clear(st);
    showLogin(st);
  }
  function saveNow(st) {
    const changed = st.cfg.reportFormat !== st.formatAtSave;
    st.saved = JSON.stringify(st.cfg);
    st.dirty = false;
    st.formatAtSave = st.cfg.reportFormat;
    return changed;
  }

  // Main Menu's entries in the tables: see fill().
  function mainEntries() {
    MENUS.main = () => ({ title: 'Main Menu', prompt: 'Selection', items: [
      item('Unit Config', st => clearTo(st, 'unitcfg', true)),
      item('I/O Setup', st => ioTables(st)),
      item('Communication', st => showMenu(st, 'comm')),
      item('Unit Diagnostic', st => clearTo(st, 'diag')),
      item('Change Password', notLogged('main')),
      item('Set Date & Time', notLogged('main')),
      item('Show/Save Configuration', st => configDump(st)),
      item('Set Accumulators', st => { clear(st); accumTables(st); showMenu(st, 'accum'); }),
      item('Exit', st => exit(st)),
    ] });
    PARENT.main = 'main';
    // Enter takes the starred one, Save Changes; Cancel goes back to the menu.
    DONE.exitEnter = (st, cancel) => (cancel === null ? header(st) : DONE.exitPick(st, 'Save Changes'));
    DONE.exitPick = (st, pick) => {
      if (pick === 'Save Changes') { blank(st); say(st, `${T}${T}Configuration Saved!!`, 'tm-ok'); saveNow(st); }
      else if (pick === 'Discard Changes') { st.cfg = JSON.parse(st.saved); st.dirty = false; }
      say(st, `${T}${T}Exiting ...`);
      st.user = null;
      clear(st);
      showLogin(st);
    };
  }

  // ── Unit Config ────────────────────────────────────────────────────────────
  const isInt = v => /^\d+$/.test(v);
  const ucNum = field => (st, v) => {
    if (v === '') { DONE.toUnitcfg(st); return; }
    if (!isInt(v)) { blank(st); say(st, `${T}${T}Invalid Format!`, 'tm-err'); DONE.toUnitcfg(st); return; }
    set(st, field, +v);
    DONE.toUnitcfg(st);
  };
  // Restore Default: address 1, the internal sensors on IDs 8–12, the
  // external inputs off; the communication settings are kept.
  function defaultIds(st) {
    const c = st.cfg;
    for (const n of Object.keys(c.inputs)) c.inputs[n].id = '-';
    [['Battery', '8', 'U-1'], ['Supply', '9', 'U-1'], ['RSSI', '10', 'S-1'], ['Int Tmp', '11', 'S-2'], ['Status', '12', 'U-2']]
      .forEach(([n, id, fmt]) => Object.assign(c.internal[n], { id, fmt }));
  }

  // The quick set-ups: a flow of prompts, each with its default in it.
  function units(st, next) {
    st.fv = { next };
    choose(st, 'Units', ['Metric', 'US Customary'], 'Metric', 'qsUnits', 'qsUnitsOut');
  }
  const num = (v, d) => (/^-?\d+(\.\d+)?$/.test(v) ? +v : d);
  // ALERT2: rain on DI3 as ID 0, river on AI1 as ID 7, battery ID 8.
  function qs2(st) { say(st, `${T}ALERT2 I/O Quick Setup`); units(st, 'qs2Go'); }
  // ALERT (version 1): rain, river and battery IDs from the station's address.
  function qs1(st) {
    say(st, `${T}ALERT(version 1) I/O Quick Setup`);
    say(st, `${T}${T}Setting Up Radio for ALERT v1`);
    units(st, 'qs1Go');
  }
  const sensorId = v => (v === '-' ? '-' : isInt(v) && +v <= 8191 ? String(+v) : null);
  const RETRY = `${T}${T}${T}Enter a value between 0 and 8191 or '-' to disable: `;

  // Unit Config's entries in the tables: see fill().
  function unitConfigEntries() {
    MENUS.unitcfg = () => ({ title: 'Unit Config Menu', items: [
      item('Station Address', st => askValue(st, `${T}${T}Station Address: `, st.cfg.address, 'ucAddr')),
      item('Update Time', st => askValue(st, `${T}${T}Update Time: (min) `, st.cfg.updateMin, 'ucUpd')),
      item('Paralysis Time', st => askValue(st, `${T}${T}Paralysis Time: (sec) `, st.cfg.paralysisSec, 'ucPar')),
      item('Data Log Format', st => choose(st, 'Logging Format', ['ALERT2 ASCII', 'CSV on Change', 'CSV on Sample'], st.cfg.logFormat, 'ucLog', 'toUnitcfg')),
      item('Battery Type', st => choose(st, 'Battery Type', ['Built-in LiFePO4', 'External Lead-Acid'], st.cfg.battery, 'ucBatt', 'toUnitcfg')),
      item('ALERT2 I/O Quick Setup', st => qs2(st)),
      item('ALERT(version 1) I/O Quick Setup', st => qs1(st)),
      item('Restore Default Configuration', st => yesno(st, `${T}${T}This will replace the current configuration. Continue?`, 'restore', 'toUnitcfg')),
    ] });
    PARENT.unitcfg = 'main';
    DONE.toUnitcfg = st => clearTo(st, 'unitcfg', true);
    THEN.toUnitcfg = DONE.toUnitcfg;
    DONE.ucAddr = ucNum('address');
    DONE.ucUpd = ucNum('updateMin');
    DONE.ucPar = ucNum('paralysisSec');
    DONE.ucLog = (st, v) => { set(st, 'logFormat', v); DONE.toUnitcfg(st); };
    DONE.ucBatt = (st, v) => { set(st, 'battery', v); DONE.toUnitcfg(st); };
    DONE.restore = st => { st.cfg.address = 1; defaultIds(st); st.dirty = true; DONE.toUnitcfg(st); };
    DONE.qsUnits = (st, v) => {
      if (v !== 'Metric') { note(st, NOT_LOGGED); DONE.toUnitcfg(st); return; }
      DONE[st.fv.next](st);
    };
    DONE.qsUnitsOut = (st, cancel) => {
      if (cancel === null) { say(st, `${T}Cancelled`); DONE.toUnitcfg(st); return; }
      DONE[st.fv.next](st);
    };
    DONE.qs2Go = st => {
      say(st, `${T}${T}Configuring Rain ID 0`);
      say(st, `${T}${T}Configuring River Analog ID 7`);
      st.fv = {};
      askValue(st, `${T}${T}${T}Transducer Full Range (mm) `, 5000, 'qs2Range');
    };
    DONE.qs2Range = (st, v) => { st.fv.range = num(v, 5000); askValue(st, `${T}${T}${T}Analog Sample Time: (min) `, 15, 'qs2Samp'); };
    DONE.qs2Samp = (st, v) => { st.fv.samp = num(v, 15); askValue(st, `${T}${T}${T}Analog Warmup Time: (sec) `, 10, 'qs2Warm'); };
    DONE.qs2Warm = (st, v) => { st.fv.warm = num(v, 10); askValue(st, `${T}${T}${T}River Sensitivity (mm) `, 10, 'qs2Sens'); };
    DONE.qs2Sens = (st, v) => { st.fv.sens = num(v, 10); askValue(st, `${T}${T}${T}River Offset (mm) `, 0, 'qs2Off'); };
    DONE.qs2Off = (st, v) => {
      const f = st.fv, c = st.cfg;
      f.off = num(v, 0);
      say(st, `${T}${T}Configuring Battery Voltage ID 8`);
      Object.assign(c.inputs.DI3, { id: '0', fmt: 'U-4', scale: '1', offset: '0mm', sens: '1mm' });
      Object.assign(c.inputs.AI1, { id: '7', fmt: 'S-3', scale: String(f.range), offset: `${f.off}mm`, sens: `${f.sens}mm` });
      Object.assign(c.internal.Battery, { id: '8', fmt: 'U-1' });
      c.analogSampleMin = f.samp; c.analogWarmSec = f.warm;
      st.dirty = true;
      say(st, `${T}Configuration Change Complete`);
      blank(st);
      anyKey(st, 'toUnitcfg');
    };
    DONE.qs1Go = st => { st.fv = {}; blank(st); askValue(st, `${T}Rain Sensor ID: `, st.cfg.address, 'qs1Rain'); };
    DONE.qs1Rain = (st, v) => {
      const id = v === '' ? String(st.cfg.address) : sensorId(v);
      if (id === null) { blank(st); askValue(st, RETRY, st.cfg.address, 'qs1Rain'); return; }
      st.fv.rain = id;
      say(st, `${T}${T}Configuring Rain ID ${id === '-' ? 8192 : id}. Increment 1 mm`);
      askValue(st, `${T}River Sensor ID ('-' to disable): `, st.cfg.address + 1, 'qs1River');
    };
    DONE.qs1River = (st, v) => {
      const id = v === '' ? String(st.cfg.address + 1) : sensorId(v);
      if (id === null) { blank(st); askValue(st, RETRY, st.cfg.address + 1, 'qs1River'); return; }
      st.fv.river = id;
      if (id === '-') { DONE.qs1BattAsk(st); return; }
      choose(st, 'River Level Input', ['Analogue', 'Incremental', 'Quadrature'], 'Analogue', 'qs1Input', 'qs1InputOut');
    };
    DONE.qs1InputOut = (st, cancel) => (cancel === null ? DONE.qs1BattAsk(st) : DONE.qs1Input(st, 'Analogue'));
    DONE.qs1Input = (st, v) => {
      if (v !== 'Analogue') { note(st, NOT_LOGGED); st.fv.river = '-'; DONE.qs1BattAsk(st); return; }
      askValue(st, `${T}${T}${T}Transducer Full Range  (mm) `, 5000, 'qs1Range');
    };
    DONE.qs1Range = (st, v) => { st.fv.range = num(v, 5000); askValue(st, `${T}${T}${T}Analog Sample Time: (min) `, 1, 'qs1Samp'); };
    DONE.qs1Samp = (st, v) => { st.fv.samp = num(v, 1); askValue(st, `${T}${T}${T}Analog Warmup Time: (sec) `, 5, 'qs1Warm'); };
    DONE.qs1Warm = (st, v) => { st.fv.warm = num(v, 5); askValue(st, `${T}${T}${T}River Increment  (mm) `, 10, 'qs1Inc'); };
    DONE.qs1Inc = (st, v) => { st.fv.inc = num(v, 10) || 10; askValue(st, `${T}${T}${T}River Offset  (mm) `, 0, 'qs1Off'); };
    DONE.qs1Off = (st, v) => {
      st.fv.off = num(v, 0);
      say(st, `${T}${T}Configuring River Analog: ID ${st.fv.river}. Increment ${st.fv.inc} mm`);
      DONE.qs1BattAsk(st);
    };
    DONE.qs1BattAsk = st => askValue(st, `${T}Battery Sensor ID: `, st.cfg.address + 2, 'qs1Batt');
    DONE.qs1Batt = (st, v) => {
      const id = v === '' ? String(st.cfg.address + 2) : sensorId(v);
      if (id === null) { blank(st); askValue(st, RETRY, st.cfg.address + 2, 'qs1Batt'); return; }
      const f = st.fv, c = st.cfg;
      say(st, `${T}${T}Configuring Battery: ID ${id === '-' ? 8192 : id}. Increment 0.1  V`);
      Object.assign(c.inputs.DI3, { id: f.rain, fmt: 'U-2', scale: '1', offset: '0mm', sens: '1mm' });
      if (f.river && f.river !== '-' && f.range) {
        Object.assign(c.inputs.AI1, { id: f.river, fmt: 'U-2', scale: String(Math.round(f.range / f.inc)), offset: `${f.off}(${f.off}mm)`, sens: `1(${f.inc}mm)` });
        c.analogSampleMin = f.samp; c.analogWarmSec = f.warm;
      } else c.inputs.AI1.id = '-';
      Object.assign(c.internal.Battery, { id, fmt: 'U-2' });
      st.dirty = true;
      blank(st);
      say(st, `${T}Configuration Change Complete`);
      blank(st);
      anyKey(st, 'toUnitcfg');
    };
  }

  // ── I/O Setup ──────────────────────────────────────────────────────────────
  const DIG = ['DI1', 'DI2', 'DI3', 'DI4'];
  const INTERNAL = { batt: ['Battery', 'Battery Voltage'], supply: ['Supply', 'Supply Voltage'], rssi: ['RSSI', 'RSSI'], status: ['Status', 'Status Sensor'] };
  const DIN = ['DI1 Pulse, DI2 On-Off', 'Both On-Off', 'Encoder DI1 Incr, DI2 Quad', 'Both Pulse'];

  // One digital input: its mini-table, then its menu.
  function digital(st, i) {
    st.fv = { dig: i };
    clear(st);
    if (st.dirty) { say(st, `${T}Config NOT Saved`, 'tm-warn'); blank(st); }
    const n = DIG[i], d = st.cfg.inputs[n];
    table(st, [n], [['Mode', () => d.mode], ['ID', () => d.id], ['Format', () => d.fmt], ['Scale', () => d.scale], ['Offset', () => d.offset],
      ['Sens', () => d.sens], ['Display', () => d.display], ['Value', () => d.value]]);
    blank(st);
    showMenu(st, 'dig');
  }
  // A sensor ID: 0–8191, or '-' to switch it off.
  function idInto(st, v, obj, again, back) {
    if (v === '') { go(st, back); return; }
    const id = sensorId(v);
    if (id === null) { blank(st); askValue(st, RETRY, obj.id, again); return; }
    if (obj.id !== id) { obj.id = id; st.dirty = true; }
    go(st, back);
  }

  // An internal sensor — battery, supply, RSSI, status: its ID and its format.
  function internal(st, k) {
    st.fv = { int: k };
    clear(st);
    if (st.dirty) { say(st, `${T}Config NOT Saved`, 'tm-warn'); blank(st); }
    const [n] = INTERNAL[k], s = st.cfg.internal[n];
    table(st, [n], [['ID', () => s.id], ['Format', () => s.fmt], ['Value', () => s.value]]);
    blank(st);
    showMenu(st, 'int');
  }
  const DEFAULT_FMT = { Battery: 'U-1', Supply: 'U-1', RSSI: 'S-1', 'Int Tmp': 'S-2', Status: 'U-2' };
  const KIND = { U: 'Unsigned Integer', S: 'Signed Integer', F: 'Floating Point' };
  const fmtWords = f => `${f.slice(2)}-Byte ${KIND[f[0]]}`;
  function fmtInto(st, f) {
    const s = st.cfg.internal[INTERNAL[st.fv.int][0]];
    say(st, `${T}Report Type: ${fmtWords(f)}`);
    if (s.fmt !== f) { s.fmt = f; st.dirty = true; }
    THEN.int(st);
  }

  // I/O Setup's entries in the tables: see fill().
  function ioEntries() {
    THEN.io = st => ioTables(st);
    MENUS.io = st => {
      const c = st.cfg;
      const items = [
        ...DIG.map((n, i) => item(`Digital ${i + 1}`, s => digital(s, i))),
        item('Analog 1', notLogged('io')),
        item('Analog 2', notLogged('io')),
        item('Battery Voltage', s => internal(s, 'batt')),
        item('Supply Voltage', s => internal(s, 'supply')),
        item('RSSI', s => internal(s, 'rssi')),
        item('Internal Temp', notLogged('io')),
        item('Status Sensor', s => internal(s, 'status')),
        item('Input mode Din1/Din2', s => choose(s, 'Input mode Din1/Din2', DIN, s.cfg.dinMode, 'ioDin', 'io')),
        item('SDI-12 Device config', s => { clear(s); showMenu(s, 'sdi'); }),
      ];
      // Analog Sampling only once an analog input has an ID.
      if (c.inputs.AI1.id !== '-' || c.inputs.AI2.id !== '-') items.push(item('Analog Sampling', s => askValue(s, `${T}${T}Analog Sample Time: (min) `, s.cfg.analogSampleMin, 'ioSamp')));
      return { title: 'I/O Setup Menu', items };
    };
    PARENT.io = 'main';
    DONE.ioDin = (st, v) => {
      set(st, 'dinMode', v);
      const modes = { 'DI1 Pulse, DI2 On-Off': ['Pulse', 'On-Off'], 'Both On-Off': ['On-Off', 'On-Off'], 'Encoder DI1 Incr, DI2 Quad': ['Incr', 'Quad'], 'Both Pulse': ['Pulse', 'Pulse'] }[v];
      st.cfg.inputs.DI1.mode = modes[0]; st.cfg.inputs.DI2.mode = modes[1];
      ioTables(st);
    };
    DONE.ioSamp = (st, v) => { if (isInt(v)) set(st, 'analogSampleMin', +v); askValue(st, `${T}${T}Analog Warmup Time: (sec) `, st.cfg.analogWarmSec, 'ioWarm'); };
    DONE.ioWarm = (st, v) => { if (isInt(v)) set(st, 'analogWarmSec', +v); ioTables(st); };
    THEN.dig = st => digital(st, st.fv.dig);
    MENUS.dig = st => ({ title: `Digital ${st.fv.dig + 1} Menu`, items: [
      item('Sensor ID \'-\' to disable', s => { blank(s); askValue(s, `${T}${T}Sensor ID '-' to disable: `, s.cfg.inputs[DIG[s.fv.dig]].id, 'digId'); }),
      item('Report Format', notLogged('dig')),
      item('Scaling (per count)', s => { blank(s); askValue(s, `${T}${T}Scaling (per count): `, s.cfg.inputs[DIG[s.fv.dig]].scale, 'digScale'); }),
      item('Zero / Offset', notLogged('dig')),
      item('Display Units', notLogged('dig')),
      item('Display Scaling', notLogged('dig')),
      item('Report Sensitivity', notLogged('dig')),
    ] });
    PARENT.dig = 'io';
    DONE.digId = (st, v) => idInto(st, v, st.cfg.inputs[DIG[st.fv.dig]], 'digId', 'dig');
    DONE.digScale = (st, v) => {
      const d = st.cfg.inputs[DIG[st.fv.dig]];
      if (/^\d+(\.\d+)?$/.test(v) && d.scale !== v) { d.scale = v; st.dirty = true; }
      THEN.dig(st);
    };
    THEN.int = st => internal(st, st.fv.int);
    MENUS.int = st => ({ title: `${INTERNAL[st.fv.int][1]} Menu`, items: [
      item('Sensor ID \'-\' to disable', s => { blank(s); askValue(s, `${T}${T}Sensor ID '-' to disable : `, s.cfg.internal[INTERNAL[s.fv.int][0]].id, 'intId'); }),
      item('Report Format', s => choose(s, INTERNAL[s.fv.int][1], ['ALERT2 Default', 'ALERT2 Type & Length'], null, 'intFmt', 'int', 'Sensor Type: ')),
    ] });
    PARENT.int = 'io';
    DONE.intId = (st, v) => idInto(st, v, st.cfg.internal[INTERNAL[st.fv.int][0]], 'intId', 'int');
    DONE.intFmt = (st, v) => {
      if (v === 'ALERT2 Default') { fmtInto(st, DEFAULT_FMT[INTERNAL[st.fv.int][0]]); return; }
      choose(st, 'Report Data Format', ['Unsigned Integer', 'Signed Integer', 'Floating Point'], null, 'intKind', 'int');
    };
    DONE.intKind = (st, v) => { st.fv.kind = v; choose(st, 'Report Data Length', ['1-Byte ', '2-Byte ', '3-Byte ', '4-Byte '], null, 'intLen', 'int'); };
    DONE.intLen = (st, v) => fmtInto(st, `${{ 'Unsigned Integer': 'U', 'Signed Integer': 'S', 'Floating Point': 'F' }[st.fv.kind]}-${v[0]}`);
    // SDI-12: the bus, its timing and its default command. The simulated unit
    // has no sensor on it.
    MENUS.sdi = () => ({ title: 'SDI-12 config Menu', items: [
      item('Scan for Device', s => { note(s, 'Simulator: this unit has no SDI-12 sensor on its bus to find'); showMenu(s, 'sdi'); }),
      item('Manually add Device', s => yesno(s, `${T}${T}Please connect the sensor to the data bus and power supply. Are you Ready to proceed??`, 'sdiAdd', 'sdiM')),
      item('Send manual command ', notLogged('sdi')),
      item('SDI Sampling Time', s => askValue(s, `${T}${T}SDI Sample Time: (min) `, s.cfg.sdiSampleMin, 'sdiSamp')),
      item('Default SDI Measurement CMD', s => choose(s, 'Default SDI Measurement CMD', ['Start Measurement (M!)', 'Start Measurement and Req CRC (MC!)', 'Continuous Measurements (R!)',
        'Continuous Measurements Req CRC (RC!)', 'Concurrent Measurement (C!)', 'Concurrent Measurement and Req CRC (CC!)'], s.cfg.sdiCmd, 'sdiCmd', 'sdiM', 'Mode:')),
      item('SDI Sampling Mode', s => choose(s, 'SDI Sampling Mode', ['Controller', 'Listener', 'Disabled'], s.cfg.sdiMode, 'sdiMode', 'sdiM', 'Mode:')),
    ] });
    PARENT.sdi = 'io';
    DONE.sdiM = st => showMenu(st, 'sdi');
    DONE.sdiAdd = st => { blank(st); askValue(st, `${T}${T}Enter the Address (0-9): `, 0, 'sdiAddr'); };
    DONE.sdiAddr = st => { blank(st); say(st, `${T}${T}Sensor Not Added`); showMenu(st, 'sdi'); };
    DONE.sdiSamp = (st, v) => { if (isInt(v)) set(st, 'sdiSampleMin', +v); askValue(st, `${T}${T}SDI Warmup Time: (sec) `, st.cfg.sdiWarmSec, 'sdiWarm'); };
    DONE.sdiWarm = (st, v) => { if (isInt(v)) set(st, 'sdiWarmSec', +v); showMenu(st, 'sdi'); };
    DONE.sdiCmd = (st, v) => { set(st, 'sdiCmd', v); showMenu(st, 'sdi'); };
    DONE.sdiMode = (st, v) => { set(st, 'sdiMode', v); showMenu(st, 'sdi'); };
  }

  // ── Communication ──────────────────────────────────────────────────────────
  // Printed without a clear. Its items follow the settings, as the logs'
  // sixty-odd variants of it do: a repeater gets its delay and its address
  // lists, a repeater or a base its agency and secondary link, RS-232 its baud
  // rate and protocol, a timed comms supply its times. Each shows its value
  // after "=>"; a change prints the whole menu again on the next line.
  const LISTS = {
    commMode: ['Communication Mode', ['4G Modem Reporting', 'RS232 Reporting', 'RS232 Serial Menu', 'Integrated Radio Reporting', 'Satellite Modem']],
    unitType: ['Unit Type', ['Field Station', 'Base Station Rcvr', 'Repeater Station']],
    reportFormat: ['Report Format', ['ALERT2 Format', 'ALERT Binary', 'ALERT IFLOWS']],
    supplyMode: ['Comms Supply Mode', ['On Demand', 'Always On', 'Timed']],
    addrList: ['Address List', ['List 1', 'List 2', 'List 3', 'List 4']],
    addrStatus: ['Address List Status', ['Disable', 'Enable']],
    addrAction: ['Address List Action', ['Pass', 'Reject']],
    secondary: ['Secondary Communication', ['None', '4G Modem Reporting', 'RS232 Reporting', 'Satellite Modem']],
    protocol: ['Communication Protocol', ['ALERT2 ASCII Protocol', 'ALERT2 Binary Protocol']],
  };
  // Modes and links the logs never show set up stay as they were.
  const UNSEEN = new Set(['4G Modem Reporting', 'Satellite Modem']);
  const listOf = st => st.cfg.lists[+st.cfg.addrList.slice(-1) - 1];
  // The list's own fields come from the list picked.
  const listField = (st, field) => (field === 'addrStatus' ? (listOf(st) ? 'Enable' : 'Disable') : field === 'addrAction' ? (listOf(st) || {}).action : st.cfg[field]);
  const COMM_VALUE = {
    txMHz: 'Tx Frequency MHz', rxMHz: 'Rx Frequency MHz', gpsUpdate: 'GPS Update', gpsMaxOn: 'GPS Maximum On',
    repDelayMs: 'Repeater Delay (mSec)', agency: 'Agency ID', baud: 'Serial Baud Rate',
    supplyStart: 'Comms Supply Start (24-hour)', supplyRepeat: 'Comms Supply Repeat (hours)', supplyOn: 'Comms Supply On Time (mins)',
  };

  // Communication's entries in the tables: see fill().
  function commEntries() {
    MENUS.comm = st => {
      const c = st.cfg;
      const v = (label, val) => `${label} => ${val}`;
      const ch = field => item(v(LISTS[field][0], listField(st, field)),
        s => choose(s, LISTS[field][0], LISTS[field][1], listField(s, field), `pick_${field}`, 'commBack', 'Selection:'));
      const val = field => item(v(COMM_VALUE[field], c[field]), s => { s.fv = { field }; askValue(s, `${T}${T}${COMM_VALUE[field]} `, s.cfg[field], 'commVal'); });
      const items = [ch('commMode')];
      if (c.commMode === 'RS232 Reporting') {
        items.push(val('baud'), ch('protocol'), ch('unitType'));
        return { title: 'Communication Menu', items };
      }
      if (c.commMode !== 'Integrated Radio Reporting') return { title: 'Communication Menu', items };
      const rpt = c.unitType === 'Repeater Station', base = c.unitType === 'Base Station Rcvr';
      items.push(ch('unitType'), val('txMHz'), val('rxMHz'),
        item(v('Tx Power', c.txPower), s => { ask(s, `${T}${T}Tx Power ${s.cfg.txPower}`); open(s).cur = open(s).t.length - 2; s.at = { k: 'onekey', then: 'commPower' }; }),
        ch('reportFormat'), val('gpsUpdate'), val('gpsMaxOn'));
      if (rpt) {
        items.push(val('repDelayMs'), ch('addrList'), ch('addrStatus'));
        if (listOf(st)) items.push(ch('addrAction'), item('Address List Entries', s => showMenu(s, 'entries')));
      }
      if (rpt || base) {
        items.push(val('agency'), ch('secondary'));
        if (c.secondary === 'RS232 Reporting') items.push(val('baud'), ch('protocol'));
      }
      items.push(ch('supplyMode'));
      if (c.supplyMode === 'Timed') items.push(val('supplyStart'), val('supplyRepeat'), val('supplyOn'));
      return { title: 'Communication Menu', items };
    };
    PARENT.comm = 'main';
    THEN.comm = st => showMenu(st, 'comm');
    DONE.commBack = st => showMenu(st, 'comm');
    DONE.commPower = (st, v) => { if (v) set(st, 'txPower', v); showMenu(st, 'comm'); };
    DONE.commVal = (st, v) => {
      const f = st.fv.field;
      const bad = () => { blank(st); say(st, `${T}${T}${T}Invalid value!`, 'tm-err'); showMenu(st, 'comm'); };
      if (f === 'txMHz' || f === 'rxMHz') {
        // Written to six places. The logs show 151.5 to 151.95 taken and 135,
        // 152 and an emptied one refused — the two numbers both typed without a
        // point, so which rule refused 152 is not known: here a point is needed,
        // and the VHF band, 136–174 MHz.
        if (!/^\d{3}\.\d{1,6}$/.test(v) || +v < 136 || +v > 174) { bad(); return; }
        set(st, f, (+v).toFixed(6));
      } else if (f === 'agency') {
        if (!/^[A-Za-z0-9]{1,8}$/.test(v)) { bad(); return; }
        set(st, f, v.toUpperCase());
      } else {
        // An emptied one keeps its value; the delay is 16-bit and wraps without a word.
        if (v === '') { showMenu(st, 'comm'); return; }
        if (!isInt(v)) { bad(); return; }
        set(st, f, f === 'repDelayMs' ? +v % 65536 : +v);
      }
      showMenu(st, 'comm');
    };
    for (const field of Object.keys(LISTS)) {
      DONE[`pick_${field}`] = (st, pick) => {
        if (UNSEEN.has(pick)) { note(st, NOT_LOGGED); showMenu(st, 'comm'); return; }
        if (field === 'addrStatus') {
          const n = +st.cfg.addrList.slice(-1) - 1;
          const on = pick === 'Enable';
          if (!!st.cfg.lists[n] !== on) { st.cfg.lists[n] = on ? { action: 'Pass', entries: [] } : null; st.dirty = true; }
        } else if (field === 'addrAction') {
          const l = listOf(st);
          if (l && l.action !== pick) { l.action = pick; st.dirty = true; }
        } else set(st, field, pick);
        showMenu(st, 'comm');
      };
    }
    // The list picked's address ranges: Add Entry, or one picked to delete.
    MENUS.entries = st => {
      const l = listOf(st);
      const ents = (l && l.entries) || [];
      return { title: 'Address List Entries Menu', prompt: 'Selection', items: [
        item('Add Entry', s => askValue(s, `${T}${T}Enter low address:`, 0, 'entLow')),
        ...ents.map(([a, b], i) => item(`${String(a).padEnd(6)}to  ${b}`, s => {
          s.fv = { del: i };
          yesno(s, `${T}${T}Delete Entry ${L(i + 1)}) ${String(a).padEnd(6)}to  ${b}?`, 'entDel', 'entries');
        })),
      ] };
    };
    PARENT.entries = 'comm';
    DONE.entries = st => showMenu(st, 'entries');
    DONE.entDel = st => { const l = listOf(st); if (l) { l.entries.splice(st.fv.del, 1); st.dirty = true; } showMenu(st, 'entries'); };
    DONE.entLow = (st, v) => { st.fv = { low: isInt(v) ? +v : 0 }; askValue(st, `${T}${T}Enter high address:`, st.fv.low, 'entHigh'); };
    DONE.entHigh = (st, v) => {
      const hi = isInt(v) ? +v : st.fv.low;
      if (hi > 65535) { blank(st); askValue(st, `${T}${T}${T}Enter a value between 0 and 65535: `, st.fv.low, 'entHigh'); return; }
      if (hi < st.fv.low) { say(st, `${T}${T}Error: High address must be greater than Low!`, 'tm-err'); showMenu(st, 'entries'); return; }
      const l = listOf(st);
      if (l) { l.entries.push([st.fv.low, hi]); st.dirty = true; }
      showMenu(st, 'entries');
    };
  }

  // ── Unit Diagnostic ────────────────────────────────────────────────────────

  // SDI-12 manual commands: with no sensor on the bus, none answers.
  const SDI_CMDS = ['Set Sensor Address to Use', 'Query single attached Sensor Address - ?! ', 'Acknowledge Active - a! ', 'Get Sensor Identification - aI!',
    'Change Sensor Address - aAb!', 'Start Measurement - aM!', 'Start Measurement with CRC - aMC!', 'Continuous Measurements - aR0!',
    'Continuous Measurements with CRC - aRC0! ', 'Concurrent Measurements - aC!', 'Concurrent Measurements with CRC - aCC! '];

  // The version screen. An old radio under a new bootloader says so, as in
  // ELPRO's sheet; the radio runs the function image its report format needs
  // — FSK for ALERT2 (FI:2044), V.23 otherwise.
  function versionLines(st) {
    const f = st.fw;
    const out = [
      { t: `${T}${T}Firmware: ${FW.host[f.host] || FW.host.new}`, c: 'tm-host' },
      { t: `${T}${T}Host Bootloader: ${FW.boot[f.boot] || FW.boot.new}`, c: 'tm-boot' },
    ];
    const radio = FW.radio[f.radio] || FW.radio.new;
    if (f.radio === 'old' && f.boot === 'new') {
      out.push({ t: `${T}${T}ERROR: Could not read parameter value`, c: 'tm-err' });
      out.push({ t: `${T}${T}Radio Firmware: ${radio}`, c: 'tm-radio' });
      out.push({ t: `${T}${T}        ** Old version - Update Recommended **`, c: 'tm-err' });
    } else {
      const fi = f.radio === 'old' ? '' : st.cfg.reportFormat === 'ALERT2 Format' ? f.fsk : f.fi;
      out.push({ t: `${T}${T}Radio Firmware: ${radio}${fi ? ` FI:${fi}` : ''}`, c: 'tm-radio', fi: fi ? `FI:${fi}` : '' });
    }
    return out;
  }

  // Unit Diagnostic's entries in the tables: see fill().
  function diagEntries() {
    // Its toggles say what picking them would do: Enable … becomes Stop … (or
    // Exit …, or … Normal) once it is on. Radio Tone Reversals is there only
    // while the radio is the unit's link.
    MENUS.diag = st => {
      const c = st.cfg;
      const back = s => { blank(s); showMenu(s, 'diag'); };
      const toggle = (field, run) => s => { s.cfg[field] = !s.cfg[field]; if (run) run(s); back(s); };
      const items = [
        item('Show I/O Values', s => {
          blank(s);
          say(s, `${T}${T}Warming up Analog. Press a key to skip. ..........`);
          const ins = s.cfg.inputs, cols = ['DI1', 'DI2', 'DI3', 'DI4', 'AI1'];
          say(s, ` ${T}${cols.map(col).join('')}`);
          ask(s, `Raw${T}${cols.map(n => col(ins[n].raw)).join('')}`, '');
          s.at = { k: 'stream' };
        }),
        item('Show RSSI List', s => {
          blank(s);
          say(s, `Station${T}${T}RSSI${T}${T}Last Heard (hh:mm:ss)`, 'tm-h');
          for (const [id, rssi, ago] of s.cfg.heard) say(s, `${id}${T}${T}${rssi}dBm${T}${T}${ago}`);
          blank(s);
          anyKey(s, 'diagB');
        }),
        item('SDI-12 value & Test', s => { say(s, 'SDI Sensors Status'); s.fv = { sdiAddr: null }; showMenu(s, 'sdicmd'); }),
        item('Show Internal I/O', notLogged('diag')),
        item('Force Update Message', s => { trace(s); blank(s); showMenu(s, 'diag'); }),
        item('Show Firmware Version', s => {
          blank(s);
          for (const l of versionLines(s)) { close(s); s.lines.push(l); }
          blank(s);
          anyKey(s, 'diagB');
        }),
        item('Show Hardware Version', s => { blank(s); say(s, `${T}${T}Hardware: ${s.cfg.hw} ${T}Serial Number: ${s.cfg.serial}`); back(s); }),
        item('Update Device Firmware', s => { blank(s); showMenu(s, 'update'); }),
        item('Calibrate Analog Input 1', notLogged('diag')),
        item('Calibrate Analog Input 2', notLogged('diag')),
        item('Set Analog Default Calibration', notLogged('diag')),
        item('Upload Log to USB', s => {
          say(s, `${T}This USB connection will go off-line to connect to the USB drive.`);
          say(s, `${T}Observe the DIO LEDs to monitor upload progress. Wait for LEDs to`);
          ask(s, `${T}complete, then reconnect and press a key`, '');
          offline(s, 'log', 'logBack');
        }),
        item('Erase Log Memory', s => yesno(s, `${T}${T}Erase Log files?`, 'erase', 'diagB')),
        item('Factory Default Erase All', s => yesno(s, `${T}${T}Erase ALL Log files and Configuration?`, 'factory', 'diagB')),
        item(`${c.debug ? 'Disable' : 'Enable'} Debug Console Output`, toggle('debug')),
        item(`${c.rxInd ? 'Stop' : 'Enable'} Rx Indication DO4`, toggle('rxInd')),
        item(`${c.maint ? 'Exit' : 'Enable'} Maintenance Mode`, toggle('maint', s => { if (s.cfg.maint) say(s, `${T}MAINT Mode`); })),
        item(`Communications Supply ${c.supplyForce ? 'Normal' : 'Force On'}`, toggle('supplyForce')),
      ];
      if (c.commMode === 'Integrated Radio Reporting') items.push(item(c.tones ? 'Stop Radio Tones' : 'Radio Tone Reversals', toggle('tones')));
      return { title: 'Unit Diagnostic Menu', items };
    };
    PARENT.diag = 'main';
    THEN.diagB = st => { blank(st); showMenu(st, 'diag'); };
    DONE.diagB = THEN.diagB;
    DONE.erase = st => { say(st, `Erasing Log Memory${'.'.repeat(64)}${T}..Done`); blank(st); showMenu(st, 'diag'); };
    DONE.factory = st => {
      say(st, 'Erasing Flash Memory..');
      for (let i = 0; i < 20; i++) { say(st, `${T}${T}Bad config length - retrying!`); blank(st); }
      blank(st);
      say(st, `${T}${T}Configuration corrupted - setting to defaults!`);
      blank(st, 2);
      const keep = { commMode: st.cfg.commMode, hw: st.cfg.hw, serial: st.cfg.serial, clock: st.cfg.clock, heard: st.cfg.heard, rssiDbm: st.cfg.rssiDbm };
      st.cfg = { ...JSON.parse(JSON.stringify(BASE)), ...keep, address: 1, logFormat: 'ALERT2 ASCII' };
      defaultIds(st);
      saveNow(st);
      say(st, `${T}${T}Configuration Saved!!${T}..Done`, 'tm-ok');
      blank(st);
      showMenu(st, 'diag');
    };
    // Back from Upload Log to USB: a line holding a tab, then the Main Menu.
    DONE.logBack = st => { say(st, T); header(st); };
    MENUS.sdicmd = st => ({ title: st.fv.sdiAddr == null ? 'SDI-12 Manual Command Menu' : `SDI-12 Manual Command for sensor ${st.fv.sdiAddr} Menu`,
      items: SDI_CMDS.map((label, i) => item(label, s => {
        if (i === 0) { blank(s); askValue(s, `${T}${T}Enter the Address (0-9 or ?): `, s.fv.sdiAddr == null ? '?' : s.fv.sdiAddr, 'sdiSet'); return; }
        say(s, `${T}${T}Warming up the Sensor (any key to skip) ....................`);
        blank(s);
        say(s, `${T}${T}No response from sensor`);
        showMenu(s, 'sdicmd');
      })) });
    PARENT.sdicmd = 'diagB';
    DONE.sdiSet = (st, v) => { if (/^[0-9?]$/.test(v)) st.fv.sdiAddr = v; showMenu(st, 'sdicmd'); };
  }

  // ── Update Device Firmware ─────────────────────────────────────────────────
  function loadRadio(st, job) {
    say(st, `${T}This USB connection will go off-line for approximately 1 minute to `);
    say(st, `${T}connect to the USB drive. DIO4 LED indicates loading is complete.`);
    say(st, `${T}Wait for DIO4 LED to come on, then reconnect and press a key`);
    offline(st, job, 'loginBack');
    if (st.stick) {
      if (job === 'radio') { st.fw.radio = 'new'; if (!st.fw.fi) st.fw.fi = '6013'; }
      if (job === 'fi') st.fw.fi = '6015';
      if (job === 'fsk') st.fw.fsk = '2044';
    }
  }

  // Update Device Firmware's entries in the tables: see fill().
  function updateEntries() {
    // The five loads, as a v1.7 host words them (the log of 28 Oct 2026). Each
    // takes the USB link down; the board shows what the unit does meanwhile.
    MENUS.update = () => ({ title: 'Update Device Firmware Menu', items: [
      item('Update Bootloader (ERTA2-B)', s => {
        blank(s);
        say(s, `${T}This action will update the Boot-Loader with the file on USB`);
        yesno(s, `${T}${T}Continue?`, 'bootGo', 'diagB');
      }),
      item('Update Main Firmware (ERTA2_)', s => {
        blank(s);
        say(s, `${T}This action will update the main firmware with the file on USB`);
        yesno(s, `${T}${T}Continue?`, 'hostGo', 'diagB');
      }),
      item('Load Firmware to Radio (ERTA2-R_app)', s => loadRadio(s, 'radio')),
      item('Load FSK Image to radio (ERTA2-R_fi2)', s => loadRadio(s, 'fsk')),
      item('Load V23 Image to radio (ERTA2-R_fi6)', s => loadRadio(s, 'fi')),
    ] });
    PARENT.update = 'diagB';
    DONE.bootGo = st => {
      say(st, `${T}This USB connection will go off-line for approximately 1 minute to `);
      say(st, `${T}connect to the USB drive. DIO4 LED indicates update is complete.`);
      say(st, `${T}Wait for DIO4 LED to come on, then reconnect and press a key`);
      offline(st, 'boot', 'bootBack');
      if (st.stick) st.fw.boot = 'new';
    };
    DONE.bootBack = st => { blank(st, 2); showMenu(st, 'diag'); };
    DONE.hostGo = st => {
      say(st, `${T}When all four DIO LEDs are on, remove the USB to restart the unit.`);
      offline(st, 'host', 'loginBack');
      if (st.stick) st.fw.host = 'new';
    };
    DONE.loginBack = st => { st.user = null; clear(st); showLogin(st); };
  }

  // ── Show/Save Configuration ────────────────────────────────────────────────
  // The whole set-up, as the logs print it for a field station, a repeater
  // with RS-232 backhaul and a base station's receiver. With nothing unsaved
  // it ends "Press any key.."; with something unsaved it asks to save.
  function configDump(st) {
    const c = st.cfg, rpt = c.unitType === 'Repeater Station', base = c.unitType === 'Base Station Rcvr';
    const radio = c.commMode === 'Integrated Radio Reporting';
    const rf = c.reportFormat === 'ALERT2 Format' ? 'ALERT2' : 'Binary/IFLOWS';
    clear(st);
    say(st, 'Current Configuration:', 'tm-h');
    say(st, '======================', 'tm-h');
    blank(st);
    say(st, `Communication Mode: ${c.commMode}`);
    if ((radio && c.secondary === 'RS232 Reporting') || c.commMode === 'RS232 Serial Menu' || c.commMode === 'RS232 Reporting') {
      say(st, radio ? `Backhaul Mode : RS232 Reporting - ${c.protocol}` : `ALERT Protocol Mode: ${c.protocol}`);
      say(st, `${T}Baud${T}Bits${T}Parity${T}Stop`);
      say(st, `${T}${c.baud}${T}8${T}N${T}1`);
    }
    say(st, `Unit Type: ${c.unitType}${T}Station Address: ${c.address}`);
    if (radio) {
      if (base) {
        say(st, `Rx Frequency MHz: ${c.rxMHz}${T}Receive Format: ${rf}`);
        say(st, `Agency ID: ${c.agency}`);
      } else if (rpt) {
        say(st, `Tx Frequency MHz: ${c.txMHz}${T}Rx Frequency MHz: ${c.rxMHz}`);
        say(st, `Tx Power: ${c.txPower}${T}${T}${T}Agency ID: ${c.agency}`);
        say(st, `Report Format: ${c.reportFormat}${T}Receive Format: ${rf}`);
      } else {
        say(st, `Tx Frequency MHz: ${c.txMHz}${T}Tx Power: ${c.txPower}`);
        say(st, `Report Format: ${c.reportFormat}`);
      }
      say(st, `GPS Update: ${c.gpsUpdate}${T}${T}${T}GPS Maximum On: ${c.gpsMaxOn}`);
    }
    say(st, `Update Time: ${c.updateMin}min${T}${T}Paralysis Time: ${c.paralysisSec}sec`);
    const on = Object.keys(c.inputs).filter(n => c.inputs[n].id !== '-');
    if (on.some(n => n[0] === 'A')) say(st, `Analog Sample Time: ${c.analogSampleMin}min${T}Analog Warmup Time: ${c.analogWarmSec}sec`);
    say(st, `Data Log Format: ${c.logFormat}${T}Comms Supply: ${c.supplyMode}`);
    if (rpt && radio) {
      blank(st);
      say(st, 'Repeater Pass/Reject Lists: ');
      say(st, [1, 2, 3, 4].map(n => `Address List ${n}`.padEnd(16)).join(''));
      say(st, c.lists.map(l => (l ? l.action : 'Disabled').padEnd(16)).join(''));
      const most = Math.max(...c.lists.map(l => (l ? l.entries.length : 0)));
      for (let r = 0; r < most; r++) say(st, c.lists.map(l => (l && l.entries[r] ? `${String(l.entries[r][0]).padEnd(6)}to  ${l.entries[r][1]}` : '').padEnd(16)).join(''));
    }
    if (on.length) {
      blank(st);
      say(st, 'External Inputs:');
      const ins = c.inputs;
      table(st, on, [['Mode', n => ins[n].mode], ['Raw', n => ins[n].raw], ['ID', n => ins[n].id], ['Format', n => ins[n].fmt],
        ['Scale', n => ins[n].scale], ['Offset', n => ins[n].offset], ['Sens', n => ins[n].sens], ['Value', n => ins[n].value]]);
    }
    const it = c.internal;
    const ion = Object.keys(it).filter(n => it[n].id !== '-');
    if (ion.length) {
      blank(st);
      say(st, 'Internal Status:');
      table(st, ion, [['ID', n => it[n].id], ['Format', n => it[n].fmt], ['Value', n => it[n].value]]);
    }
    blank(st);
    say(st, `SDI-12 Operating Mode: ${c.sdiMode}`);
    if (c.sdiMode !== 'Disabled') {
      say(st, `SDI Sample Time: ${c.sdiSampleMin}min${T}SDI Warmup Time: ${c.sdiWarmSec}sec`);
      say(st, `SDI Measurement CMD: ${c.sdiCmd}`);
      blank(st);
      say(st, 'SDI Sensors Status');
    }
    if (st.dirty) yesno(st, 'Save Current Config?', 'saveYes', 'saveNo', { strict: true });
    else { blank(st); anyKey(st, 'main'); }
  }

  // Show/Save Configuration's entries in the tables: see fill().
  function saveEntries() {
    DONE.saveYes = st => {
      blank(st);
      say(st, `${T}${T}Configuration Saved!!`, 'tm-ok');
      if (saveNow(st)) say(st, `${T}${T}ALERT Report Format changed. Restarting Radio....`, 'tm-warn');
      header(st);
    };
    DONE.saveNo = st => header(st);
  }

  // ── Set Accumulators ───────────────────────────────────────────────────────
  function accumTables(st) {
    const ins = st.cfg.inputs;
    say(st, 'Current:');
    table(st, ['DI1', 'DI2', 'DI3'], [['Mode', n => ins[n].mode], ['Raw', n => ins[n].raw]]);
    blank(st);
    table(st, ['AI1', 'AI2'], [['Value', n => ins[n].value]]);
    blank(st);
  }
  const ACC = [['Digital 1', 'DI1'], ['Digital 2', 'DI2'], ['Digital 3', 'DI3'], ['Analog 1', 'AI1'], ['Analog 2', 'AI2']];

  // Set Accumulators's entries in the tables: see fill().
  function accumEntries() {
    MENUS.accum = () => ({ title: 'Set Accumulator Menu', items: ACC.map(([label, n]) => item(label, s => {
      if (n[0] === 'A') { note(s, NOT_LOGGED); accumTables(s); showMenu(s, 'accum'); return; }
      s.fv = { acc: n };
      askValue(s, `${T}${T}Enter value for ${label} : `, s.cfg.inputs[n].raw, 'accSet');
    })) });
    PARENT.accum = 'main';
    // An accumulator set is a count, not a configuration change: no "Config NOT Saved".
    DONE.accSet = (st, v) => {
      const d = st.cfg.inputs[st.fv.acc];
      if (isInt(v)) {
        d.raw = String(+v);
        const sc = parseFloat(d.scale) || 1;
        d.value = `${Math.round(+v * sc)}${/mm/.test(d.offset) ? 'mm' : ''}`;
        const saved = JSON.parse(st.saved);
        saved.inputs[st.fv.acc] = { ...saved.inputs[st.fv.acc], raw: d.raw, value: d.value };
        st.saved = JSON.stringify(saved);
      }
      accumTables(st);
      showMenu(st, 'accum');
    };
  }

  // ── The tables, filled ───────────────────────────────────────────────────
  // Each section's entries go into MENUS, PARENT, DONE and THEN the first
  // time a unit is made, so that nothing in this file runs at load.
  let filled = false;
  function fill() {
    if (filled) return;
    filled = true;
    mainEntries(); unitConfigEntries(); ioEntries(); commEntries(); diagEntries(); updateEntries(); saveEntries(); accumEntries();
  }

  return {
    create, key, keys, type, reconnect, reset, timeout, test, unplug, plug, note, screen, clone, takeEvents,
    FW, PROFILES, NOT_LOGGED,
  };
})();

if (typeof window !== 'undefined') window.A2Terminal = A2Terminal;
