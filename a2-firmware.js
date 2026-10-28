// MegaNet — a2-firmware.js
//
//   A2Firmware   💾 the A2 Firmware tab, in the Knowledge base: upgrading an
//                ELPRO ERT-A2's firmware — the host, its bootloader, the radio's
//                application and the radio's function image — re-told from
//                ELPRO Technologies' own procedure (ERT-A2 Complete Firmware
//                Upgrade, Release G, 24-4-26) with the steps pulled apart and
//                shown happening.
//
//                 1  the walkthrough: the unit drawn on the left and the
//                    laptop's screen on the right, a step at a time, with the
//                    side you work on ringed — the USB stick going in, RESET
//                    and TEST pressed, D1 to D4 lighting, the terminal's menus
//                    picked. A path for the whole upgrade or one part of it;
//                    play, pause, step back and forward, or jump to a step
//                    2  before you start: the kit, the four files, the stick
//                    3  reading the version screen, and a checker that reads a
//                    pasted one and says which parts this unit needs — and
//                    makes a path of just those
//                    4  every step written out, in order, each with ▶ Show me
//                    5  what D1 to D4 are saying, and where it stopped if not
//                    6  when it goes wrong
//                    7  where this came from
//
// The written steps (4) and the walkthrough (1) are the same STEPS: one list,
// so what the animation shows and what the page says cannot drift apart.
//
// After core.js (esc, escAttr, announce, dlText, registerTabTeardown) and
// app.js (switchTab), read at call time. Nothing runs at load: renderMain()
// calls render() and init().
//
// The unit is drawn, not photographed: SVG after the board in ELPRO's sheet —
// the SERIAL DB9, D1 to D4 over the DIO terminals, RESET down its hole, the
// USB sockets and TEST — close to the real thing, not a copy of it. The
// laptop's screens are drawn after the ones in ELPRO's sheet and marked
// Simulated: their dates and build numbers are illustrations, and what to look
// for is said in words beside them.
//
// Every frame is a pure function of (path, step, time) — frame() — so a still
// picture, a step back and the test all see the same drawing. One animation
// loop, only while the player is on screen and playing; a device asking for
// reduced motion starts still, on each step's telling moment, with ▶ to run it.
//
// Nothing here is a record. The tab keeps the path picked on this device
// (KEY); the versions pasted into the checker stay only while it is open, and
// leave only in the text file ⤓ saves.
//
// Exposes: render, init, path, mine, step, show, next, back, play, replay,
//          seek, speed, go, key, check, example, parse, advise, exportTxt,
//          frame, state, PATHS, STEPS, TARGET.

const A2Firmware = (function () {
  const KEY = 'mn-a2-firmware';
  const PAUSE_AFTER = 1.4;              // s held on a step's last frame before the next, when playing

  // ── Release G: what the four files bring the unit to ───────────────────────
  // From the file names in ELPRO's sheet, whose screenshots confirm the host
  // (": 10366") and the bootloader ("v1.3 - 9967"). The radio application's
  // build is its file's last number; the sheet's screenshots are of older
  // releases and do not show it.
  const TARGET = {
    host:  { v: [1, 7], build: 10366, file: 'ERT-A2_v1.7_10366.bin', date: '20/09/2024 5:35 PM', kb: 226 },
    boot:  { v: [1, 3], build: 9967,  file: 'ERT-A2-B_v1-3_9967.bin', date: '30/11/2022 4:57 PM', kb: 129 },
    radio: { v: [1, 4], build: 10848, file: 'ERT-A2-R_app_155_V1-4_10848.wrap', date: '24/04/2026 11:52 AM', kb: 171 },
    fi:    { n: 6015, alt: 2044, file: 'ERT-A2-R_fi6015_v1-4_10252.wrap', date: '3/07/2024 1:56 PM', kb: 49 },
  };
  const ZIP = 'https://elprotech.com/wp-content/uploads/2024/11/ELPRO-ERT-A2_USB_FW_Release-G.zip';
  const MANUAL = 'https://elprotech.com/wp-content/uploads/2024/11/EL-ERT-A2_Manual_Sept25.pdf';

  // The parts, in the order ELPRO says to do them. Each wears the colour its
  // line wears on the version screen (red host, yellow bootloader, cyan radio,
  // and the function image's box) — styles.css, --fw-<part>.
  const PARTS = {
    prep:  { name: 'Get the USB stick ready', short: 'USB stick', icon: '🗂️' },
    check: { name: 'Check the versions', short: 'Check', icon: '🔎' },
    host:  { name: 'Host firmware', short: 'Host', icon: '🧠' },
    boot:  { name: 'Bootloader', short: 'Bootloader', icon: '🥾' },
    radio: { name: 'Radio firmware', short: 'Radio', icon: '📻' },
    fi:    { name: 'Radio function image', short: 'Function image', icon: '🧩' },
    done:  { name: 'Finish', short: 'Finish', icon: '✅' },
  };

  // ── What the laptop shows ──────────────────────────────────────────────────
  // The login, the Main Menu and the Unit Diagnostic menu as the screenshots
  // in ELPRO's manual (Sept 2025, pp. 18–19 and 31) have them, letters and
  // all — set two to a line here so they fit. The Update Device Firmware menu
  // is in no screenshot: its three options are named in the text (pp. 32–33)
  // and its letters are drawn. MENU_NOTE says so on the page.
  const MENU = {
    login: { title: 'User Type: Menu:', prompt: 'Select: ', rows: [[['a', 'Engineer']], [['b', 'Technician']]] },
    main: { title: 'Main Menu:', prompt: 'Selection: ', head: true, rows: [
      [['a', 'Unit Config'], ['b', 'I/O Setup'], ['c', 'Communication'], ['d', 'Unit Diagnostic']],
      [['e', 'Change Password'], ['f', 'Set Date & Time'], ['g', 'Show/Save Configuration']],
      [['h', 'Set Accumulators'], ['i', 'Exit']],
    ] },
    diag: { title: 'Unit Diagnostic Menu:', prompt: 'Select: ', cols: 31, rows: [
      [['a', 'Show I/O Values'], ['b', 'Show RSSI List']],
      [['c', 'SDI-12 value & Test'], ['d', 'Show Internal I/O']],
      [['e', 'Force Update Message'], ['f', 'Show Firmware Version']],
      [['g', 'Show Hardware Version'], ['h', 'Update Device Firmware']],
      [['i', 'Calibrate Analog Input 1'], ['j', 'Calibrate Analog Input 2']],
      [['k', 'Set Analog Default Calibration'], ['l', 'Upload Log to USB']],
      [['m', 'Erase Log Memory'], ['n', 'Factory Default Erase All']],
      [['o', 'Enable Debug Console Output'], ['p', 'Enable Rx Indication DO4']],
      [['q', 'Enable Maintenance Mode'], ['r', 'Communications Supply Force On']],
      [['s', 'Radio Tone Reversals']],
    ] },
    update: { title: 'Update Device Firmware:', prompt: 'Select: ', rows: [
      [['a', 'Update Bootloader']],
      [['b', 'Load firmware to Radio (ERTA2-R_app)']],
      [['c', 'Load V23 Image to radio (ERTA2-R_fi6)']],
    ] },
  };
  const MENU_NOTE = 'The login, the Main Menu and the Unit Diagnostic menu are drawn after the screenshots in ELPRO\'s manual. The Update Device Firmware menu is in none of them: its options\' names are ELPRO\'s, but their letters here are drawn — pick them by name on the unit.';

  // The unit's versions as the walkthrough's laptop prints them: where each
  // path starts, and what each part leaves.
  const FW_OLD = {
    host: 'v1.6 Aug 25 2022 14:43:29 : 9814',
    boot: 'v1.1 - 8708:261:33:0:0',
    radio: '1.0,ELPRO,ERT-A2,FW1.4,9869',
  };
  const FW_NEW = {
    host: 'v1.7 Sep 20 2024 17:32:50 : 10366',
    boot: 'v1.3 - 9967:0:15:2:0',
    radio: 'v1.4 [Apr 24 2026 11:52:00] (10848)',
  };
  const START = {
    all:   { host: 'old', boot: 'old', radio: 'old', fi: '' },
    host:  { host: 'old', boot: 'old', radio: 'old', fi: '' },
    check: { host: 'old', boot: 'old', radio: 'old', fi: '' },
    boot:  { host: 'new', boot: 'old', radio: 'old', fi: '' },
    radio: { host: 'new', boot: 'new', radio: 'old', fi: '' },
    fi:    { host: 'new', boot: 'new', radio: 'new', fi: '6013' },
    usb:   { host: 'old', boot: 'old', radio: 'old', fi: '' },
  };

  // ── The steps ──────────────────────────────────────────────────────────────
  //
  // side: where the hands are — 'unit' (the A2 itself) or 'pc' (the laptop).
  // dur: seconds at 1×. still: the telling moment a still picture shows.
  // unit: what happens to the unit, as timed events (applyUnit). pc: the
  // laptop's window and what appears in it (pcFrame). fw: the version this
  // step leaves a part at. do/watch/warn/tip: the words, the same in the
  // walkthrough and the written list.

  const tw = (k, at, dur, to) => ({ e: 'tw', k, at, dur, to });
  const lights = (at, dur, from = 0) => ({ e: 'leds', at, dur, from });
  const led = (i, at) => ({ e: 'led', i, at });
  const dark = at => ({ e: 'off', at });
  const tap = (k, at, dur = 0.45) => ({ e: 'tap', k, at, dur });
  const hold = (at, dur) => ({ e: 'hold', at, dur });
  const blink = (at, dur) => ({ e: 'blink', at, dur });
  const reboot = at => ({ e: 'reboot', at, dur: 1.6 });

  // Terminal lines: { at, t, c (a class: what it is), type (seconds to type it
  // out), pk (the part of the line that is the option picked) and sel (when),
  // echo (a key the prompt shows typed, and when), dyn (a line written from
  // the unit's versions) }. key: a key pressed at `at`.
  const L = (at, t, c = '', more = {}) => ({ at, t, c, ...more });
  const K = (at, key) => ({ at, key });
  // A menu printed at `at`; with `pick` (an option's letter), that option lit
  // at pickAt and its letter typed just after.
  function menu(at, which, pick, pickAt) {
    const m = MENU[which];
    const out = [];
    let k = 0;
    const nextAt = () => at + 0.05 * k++;
    if (m.head) {
      out.push(L(nextAt(), '', 'tm-dim', { dyn: 'clock' }));
      out.push(L(nextAt(), '', 'tm-dim', { dyn: 'head' }));
    }
    out.push(L(nextAt(), m.title, 'tm-h'));
    for (const row of m.rows) {
      const cells = row.map(([key, label], j) => {
        const s = `${key}) ${label}`;
        return m.cols && j < row.length - 1 ? s.padEnd(m.cols) : s;
      });
      const hit = row.find(([key]) => key === pick);
      out.push(L(nextAt(), cells.join(m.cols ? ' ' : '  '), 'tm-m', hit ? { pk: `${hit[0]}) ${hit[1]}`, sel: pickAt } : {}));
    }
    out.push(L(nextAt(), m.prompt, 'tm-p', pick ? { echo: { at: pickAt + 0.3, ch: pick } } : {}));
    if (pick) out.push(K(pickAt + 0.3, pick));
    return out;
  }
  // The login: Engineer, and a password typed as stars.
  const login = at => [
    ...menu(at, 'login', 'a', at + 0.7),
    L(at + 1.3, 'Password: ', 'tm-p', { echo: { at: at + 1.6, ch: '********' } }),
    K(at + 2.2, 'Enter'),
  ];
  // The version screen, from the versions the path has the unit at.
  function versionLines(at, fw) {
    const out = [
      L(at, `Firmware: ${fw.host === 'new' ? FW_NEW.host : FW_OLD.host}`, 'tm-host'),
      L(at + 0.15, `Host Bootloader: ${fw.boot === 'new' ? FW_NEW.boot : FW_OLD.boot}`, 'tm-boot'),
    ];
    if (fw.radio === 'old' && fw.boot === 'new') {
      out.push(L(at + 0.3, 'ERROR: Could not read parameter value', 'tm-err'));
      out.push(L(at + 0.4, `Radio Firmware: ${FW_OLD.radio}`, 'tm-radio'));
      out.push(L(at + 0.5, '        ** Old version - Update Recommended **', 'tm-err'));
    } else if (fw.radio === 'old') {
      out.push(L(at + 0.3, `Radio Firmware: ${FW_OLD.radio}`, 'tm-radio'));
    } else {
      out.push(L(at + 0.3, `Radio Firmware: ${FW_NEW.radio}`, 'tm-radio', fw.fi ? { fi: `FI:${fw.fi}` } : {}));
    }
    return out;
  }
  // Back from whatever was on the screen to the Unit Diagnostic menu.
  const toDiag = at => [K(at, 'Enter'), ...menu(at + 0.25, 'diag')];
  const TT = 'COM16 - Tera Term VT';

  const STEPS = {
    // ── Get the USB stick ready (on the laptop) ──
    get: {
      part: 'prep', side: 'pc', dur: 5, still: 5,
      title: 'Download Release G and unzip it',
      do: `Download ELPRO's Release G firmware pack, <code>ELPRO-ERT-A2_USB_FW_Release-G.zip</code> — from ELPRO's resource link
        (in Sources, at the foot of this page) or from ELPRO Technical Support — and unzip it to a folder on the laptop.`,
      watch: 'Four firmware files (and ELPRO\'s procedure, as a PDF). The names should look like these; the numbers in them can be newer.',
      pc: { win: 'files', title: 'ELPRO-ERT-A2_USB_FW_Release-G', rows: [0.8, 1.6, 2.4, 3.2] },
    },
    format: {
      part: 'prep', side: 'pc', dur: 7, still: 4.6, opt: 'Only if the stick is new to this, or a part below will not start',
      title: 'Format the stick: FAT32, Quick Format off',
      do: `Plug the stick into the laptop, find it in File Explorer, right-click it and pick <strong>Format…</strong>.
        Set <strong>File system</strong> to <strong>FAT32</strong>, <strong>untick Quick Format</strong>, and press <strong>Start</strong>.`,
      watch: 'Use a USB 2.0 stick that has loaded firmware before and holds nothing else. Some sticks come formatted in a way the A2 cannot read; a full format (Quick Format off) puts that right, and takes longer.',
      tip: 'ELPRO\'s sheet shows the Quick Format box ticked in its screenshot; its words say to untick it. Untick it.',
      pc: { win: 'format', fs: 1.2, quick: 2.6, start: 4.0, fill: [4.4, 6.6] },
    },
    copy: {
      part: 'prep', side: 'pc', dur: 5.5, still: 5.5,
      title: 'Copy the four files to the stick, names unchanged',
      do: `Copy the four firmware files onto the stick — onto the stick itself, not into a folder on it — exactly as they came out of the zip.
        <strong>Do not rename them or change them in any way.</strong>`,
      watch: 'The stick holds those four files and nothing else.',
      pc: { win: 'files', title: 'FIRMWARE (D:)', rows: [0.9, 1.9, 2.9, 3.9], copy: true },
    },

    // ── Connect, and note the versions ──
    cable: {
      part: 'check', side: 'unit', dur: 3.2, still: 3.2,
      title: 'Plug the laptop into the A2\'s USB B socket',
      do: 'Run a USB A-to-B lead (a printer lead) from the laptop to the A2\'s <strong>USB B</strong> socket, on its right-hand edge under RESET. It is the A2\'s configuration and diagnostics port: every menu below is reached through it.',
      unit: [tw('cable', 0.5, 1.3, 1)],
    },
    term: {
      part: 'check', side: 'pc', dur: 7, still: 7,
      title: 'Open the terminal at 9600 8N1, and log in',
      do: `Windows sees the A2 as a <strong>USB Serial Device (COM<em>n</em>)</strong> — Device Manager lists it under Ports (COM &amp; LPT); the first time,
        give it a minute or two to install its driver. Open Tera Term, PuTTY or the like on that port at <strong>9600 baud, 8 data bits,
        no parity, 1 stop bit, no flow control</strong>, and press <strong>Enter</strong>. Log in as <strong>a) Engineer</strong>, with your network's password:
        the Technician login is for viewing and basic diagnostics.`,
      watch: 'The Main Menu, with the host\'s version under the date.',
      pc: { win: 'term', title: TT, clear: true, lines: [
        L(0.3, '[ Tera Term: COM16, 9600 8N1, no flow control ]', 'tm-dim'),
        K(1.1, 'Enter'),
        ...login(1.4),
        ...menu(4.0, 'main'),
      ] },
    },
    ver: {
      part: 'check', side: 'pc', dur: 7, still: 7,
      title: 'Unit Diagnostic → Show Firmware Version: note the three lines',
      do: `Press <strong>d</strong> for <strong>Unit Diagnostic</strong>, then <strong>f</strong> for <strong>Show Firmware Version</strong>.
        Write down all three lines — <span class="fw-c fw-c--host">Firmware</span> (the host),
        <span class="fw-c fw-c--boot">Host Bootloader</span> and <span class="fw-c fw-c--radio">Radio Firmware</span> — so that at the end
        you can tell the upgrade took. The checker below reads them, and says which parts this unit needs.`,
      warn: 'Radio Firmware V1.2 or lower? Stop here: this procedure cannot update that radio. Contact ELPRO Technologies for the options.',
      pc: { win: 'term', title: TT, versions: 3.4, lines: [
        ...menu(0, 'main', 'd', 0.8),
        ...menu(1.6, 'diag', 'f', 2.6),
      ] },
    },
    save: {
      part: 'check', side: 'pc', dur: 6, still: 6, opt: 'Flood-Net\'s advice: ELPRO\'s documents do not say whether the configuration survives an upgrade',
      title: 'Keep a copy of the configuration',
      do: `Turn on the terminal's log to a file (Tera Term: <strong>File → Log…</strong>; PuTTY: <strong>Session → Logging</strong>), go back to the
        Main Menu and press <strong>g</strong> for <strong>Show/Save Configuration</strong>, which prints the whole configuration. Then the unit
        can be put back as it was, whatever the upgrade does to it.`,
      pc: { win: 'term', title: TT, lines: [
        L(0.2, '[ Tera Term: logging to A2-config-before.log ]', 'tm-dim'),
        K(0.8, 'Enter'),
        ...menu(1.1, 'main', 'g', 2.1),
        L(2.9, '… the whole configuration prints here …', 'tm-dim', { type: 1.4 }),
        L(4.6, '[ log saved ]', 'tm-dim'),
      ] },
    },

    // ── Host firmware (on the unit) ──
    'h-in': {
      part: 'host', side: 'unit', dur: 3, still: 3,
      title: 'Plug the stick into the USB A socket',
      do: 'Plug the USB stick holding the four files into the A2\'s <strong>USB A</strong> socket — the narrow upright one, on the right-hand edge above TEST.',
      unit: [tw('stick', 0.5, 1.4, 1)],
    },
    'h-press': {
      part: 'host', side: 'unit', dur: 6.2, still: 4.55, job: 'host',
      title: 'Tap RESET; within a second, press and hold TEST',
      do: `Press <strong>RESET</strong> momentarily — it is down a small hole, so use something long and thin, like a small screwdriver —
        then <strong>within one second</strong> press and hold <strong>TEST</strong>, and keep holding it until <strong>D1</strong> lights.`,
      watch: 'D1 comes on: let go of TEST.',
      warn: 'Have the stick in first. RESET then TEST held for 5 seconds is also ELPRO\'s factory default, which wipes the I/O setup, the timings and the passwords — and ELPRO does not say how the A2 tells the two apart. If D1 has not lit within a few seconds, let go before five.',
      unit: [tw('drv', 0.2, 0.9, 1), tap('drv', 1.2, 0.4), tw('drv', 1.65, 0.6, 0), tw('fin', 1.45, 0.55, 1), hold(2.0, 2.45), led(0, 4.45), tw('fin', 4.8, 0.7, 0)],
    },
    'h-leds': {
      part: 'host', side: 'unit', dur: 6, still: 6, job: 'host',
      title: 'D1, D2, D3, D4 light in turn',
      do: 'The I/O LEDs light one after another — D1, D2, D3, D4 — as the host firmware loads. Leave it alone until all four are on: ELPRO says the host takes a few minutes at most.',
      watch: 'All four LEDs on.',
      unit: [lights(0.4, 4.6, 1)],
    },
    'h-out': {
      part: 'host', side: 'unit', dur: 4.5, still: 2.4, fw: { host: 'new' },
      title: 'All four on: pull the stick out',
      do: 'With all four LEDs on, pull the USB stick out. The A2 restarts on the new host firmware.',
      tip: 'If the LEDs will not all come on, take the stick out, plug it back in and start this part again from RESET.',
      unit: [tw('stick', 0.5, 1.1, 0), reboot(1.8)],
    },
    'h-ver': {
      part: 'host', side: 'pc', dur: 8.5, still: 8.5,
      title: 'Reconnect, log in, and check: host v1.7',
      do: `The A2 restarted, so the terminal has probably lost its port: close the connection and open it again, press <strong>Enter</strong> and log in.
        Then <strong>d</strong> Unit Diagnostic, <strong>f</strong> Show Firmware Version: the first line should now read <strong>v1.7</strong>
        (with Release G, <strong>: 10366</strong> at its end).`,
      pc: { win: 'term', title: TT, clear: true, versions: 5.6, lines: [
        L(0.2, '[ Tera Term: reconnected to COM16 ]', 'tm-dim'),
        K(0.7, 'Enter'),
        ...login(0.9),
        ...menu(3.3, 'main', 'd', 3.9),
        ...menu(4.3, 'diag', 'f', 5.1),
      ] },
    },

    // ── Bootloader (from the menu) ──
    'b-in': {
      part: 'boot', side: 'unit', dur: 2.8, still: 2.8,
      title: 'Plug the stick back in',
      do: 'Plug the USB stick back into the USB A socket: the bootloader loads from it.',
      unit: [tw('stick', 0.4, 1.2, 1)],
    },
    'b-menu': {
      part: 'boot', side: 'pc', dur: 6.5, still: 6.5,
      title: 'Update Device Firmware → Update Bootloader, then Y',
      do: `In <strong>Unit Diagnostic</strong>, press <strong>h</strong> for <strong>Update Device Firmware</strong>, then pick
        <strong>Update Bootloader</strong>. Press <strong>Y</strong> to continue.`,
      warn: 'From here until all four LEDs are on, do not pull the stick or the power. Interrupting the bootloader can leave the A2 unable to start.',
      pc: { win: 'term', title: TT, lines: [
        ...toDiag(0),
        ...menu(0.25, 'diag', 'h', 1.2),
        ...menu(1.8, 'update', 'a', 2.6),
        L(3.4, 'Update Bootloader - Continue (Y/N)? ', 'tm-q', { echo: { at: 4.1, ch: 'Y' } }),
        K(4.1, 'Y'),
        L(4.6, 'Updating bootloader ...', 'tm-ok', { type: 1.2 }),
      ] },
    },
    'b-leds': {
      part: 'boot', side: 'unit', dur: 6.2, still: 6.2, fw: { boot: 'new' }, job: 'boot',
      title: 'D1 to D4 light in turn — leave it alone',
      do: 'D1, D2, D3 and D4 light one after another as the bootloader goes in. Touch nothing — not the stick, not the power — until all four are on.',
      warn: 'Never interrupt the bootloader.',
      unit: [lights(0.4, 5)],
    },
    'b-ver': {
      part: 'boot', side: 'pc', dur: 5, still: 5,
      title: 'Check: bootloader v1.3 (an ERROR line is expected)',
      do: `<strong>f</strong> Show Firmware Version again. <strong>Host Bootloader</strong> should now read <strong>v1.3 - 9967</strong>.
        An <strong>ERROR: Could not read parameter value</strong> above the radio's line, and <strong>Old version - Update Recommended</strong> under it,
        are expected: the radio's firmware is still the old one. They go when the radio is done.`,
      pc: { win: 'term', title: TT, versions: 2.0, lines: [
        ...toDiag(0),
        ...menu(0.25, 'diag', 'f', 1.3),
      ] },
    },

    // ── Radio firmware (the radio's application) ──
    'r-in': {
      part: 'radio', side: 'unit', dur: 3.4, still: 3.4,
      title: 'Take the stick out and plug it back in',
      do: 'Take the USB stick out and plug it back in, so the A2 reads it afresh. (If it is out, just plug it in.)',
      unit: [dark(0.1), tw('stick', 0.3, 0.9, 0), tw('stick', 1.7, 0.9, 1)],
    },
    'r-menu': {
      part: 'radio', side: 'pc', dur: 5.5, still: 5.5,
      title: 'Update Device Firmware → Load firmware to Radio (ERTA2-R_app)',
      do: `In <strong>Unit Diagnostic</strong>, press <strong>h</strong> for <strong>Update Device Firmware</strong>, then pick
        <strong>Load firmware to Radio (ERTA2-R_app)</strong>.`,
      pc: { win: 'term', title: TT, lines: [
        ...toDiag(0),
        ...menu(0.25, 'diag', 'h', 1.2),
        ...menu(1.8, 'update', 'b', 2.7),
        L(3.6, 'Loading firmware to radio ...', 'tm-ok', { type: 1 }),
      ] },
    },
    'r-leds': {
      part: 'radio', side: 'unit', dur: 7, still: 6.3, job: 'radio',
      title: 'The stick\'s light flashes; D1 to D4 light in turn',
      do: 'The USB stick\'s own light flashes (if it is an ELPRO stick), and D1, D2, D3 and D4 light one after another as the radio\'s firmware loads. The terminal may go quiet meanwhile.',
      watch: 'It should take no more than a minute.',
      tip: 'Slow, or not answering? Press RESET, take the stick out and put it back, and try again. Still no good: format the stick (Get the USB stick ready), and call ELPRO.',
      unit: [blink(0.2, 5.8), lights(0.6, 5)],
    },
    'r-enter': {
      part: 'radio', side: 'pc', dur: 6, still: 6, fw: { radio: 'new', fi: '6013' },
      title: 'All four on: press Enter a few times',
      do: 'With all four LEDs on, press <strong>Enter</strong> a few times to step through and finish. The screen should end like this.',
      pc: { win: 'term', title: TT, lines: [
        K(0.4, 'Enter'),
        L(0.7, 'Firmware Loaded to Radio', 'tm-ok'),
        K(1.3, 'Enter'),
        L(1.6, 'Activating Radio Firmware', 'tm-ok'),
        L(2.1, 'Firmware Image: E2_155 radio application 1.4 10848 20260424', 'tm-ok', { type: 0.8 }),
        K(3.2, 'Enter'),
        L(3.5, 'applying ...', 'tm-ok', { type: 0.6 }),
        L(4.6, 'Firmware Loaded to Radio', 'tm-ok'),
      ] },
    },
    'r-ver': {
      part: 'radio', side: 'pc', dur: 5, still: 5,
      title: 'Check: the radio line now ends with FI:',
      do: `<strong>f</strong> Show Firmware Version. The radio line now reads <strong>v1.4</strong> with its build in brackets, and ends with an
        <span class="fw-c fw-c--fi">FI:</span> number not shown before: the version of the radio's <em>function image</em>, which is next.`,
      pc: { win: 'term', title: TT, versions: 2.0, lines: [
        ...toDiag(0),
        ...menu(0.25, 'diag', 'f', 1.3),
      ] },
    },

    // ── Radio function image ──
    'f-in': {
      part: 'fi', side: 'unit', dur: 3.4, still: 3.4,
      title: 'Take the stick out and plug it back in',
      do: 'Take the USB stick out and plug it back in. (If it is out, just plug it in.)',
      unit: [dark(0.1), tw('stick', 0.3, 0.9, 0), tw('stick', 1.7, 0.9, 1)],
    },
    'f-menu': {
      part: 'fi', side: 'pc', dur: 5.5, still: 5.5,
      title: 'Update Device Firmware → Load V23 Image to radio (ERTA2-R_fi6)',
      do: `In <strong>Unit Diagnostic</strong>, press <strong>h</strong> for <strong>Update Device Firmware</strong>, then pick
        <strong>Load V23 Image to radio (ERTA2-R_fi6)</strong>.`,
      pc: { win: 'term', title: TT, lines: [
        ...toDiag(0),
        ...menu(0.25, 'diag', 'h', 1.2),
        ...menu(1.8, 'update', 'c', 2.7),
        L(3.6, 'Loading image to radio ...', 'tm-ok', { type: 1 }),
      ] },
    },
    'f-leds': {
      part: 'fi', side: 'unit', dur: 6.4, still: 6, job: 'fi',
      title: 'The stick\'s light flashes; D1 to D4 light in turn',
      do: 'Again the stick\'s light flashes and D1 to D4 light one after another, as the function image goes in.',
      watch: 'All four LEDs on.',
      unit: [blink(0.2, 5.4), lights(0.5, 4.8)],
    },
    'f-enter': {
      part: 'fi', side: 'pc', dur: 6, still: 6, fw: { fi: '6015' },
      title: 'All four on: press Enter a few times',
      do: 'With all four LEDs on, press <strong>Enter</strong> a few times to step through and finish. The screen should end like this.',
      pc: { win: 'term', title: TT, lines: [
        K(0.4, 'Enter'),
        L(0.7, 'Firmware Loaded to Radio', 'tm-ok'),
        K(1.3, 'Enter'),
        L(1.6, 'Activating Radio Firmware', 'tm-ok'),
        L(2.1, 'Firmware Image: E2_155 FI6 for 1.4 10252 20240703', 'tm-ok', { type: 0.8 }),
        K(3.2, 'Enter'),
        L(3.5, 'applying ...', 'tm-ok', { type: 0.6 }),
        L(4.6, 'Firmware Loaded to Radio', 'tm-ok'),
      ] },
    },
    'f-out': {
      part: 'fi', side: 'unit', dur: 2.6, still: 2.6,
      title: 'Take the stick out',
      do: 'That was the last file: take the USB stick out.',
      unit: [dark(0.3), tw('stick', 0.5, 1.1, 0)],
    },
    'f-ver': {
      part: 'fi', side: 'pc', dur: 5, still: 5,
      title: 'Check: FI:6015 (FI:2044 on ALERT2 report format)',
      do: `<strong>f</strong> Show Firmware Version once more. The function image's number should now be the latest,
        <span class="fw-c fw-c--fi">FI:6015</span> — the first number in its file's name, <code>ERT-A2-R_fi<strong>6015</strong>_v1-4_10252.wrap</code>.`,
      watch: 'A unit set for the ALERT2 report format shows FI:2044 instead. That is right for it, not a failure.',
      pc: { win: 'term', title: TT, versions: 2.0, lines: [
        ...toDiag(0),
        ...menu(0.25, 'diag', 'f', 1.3),
      ] },
    },

    // ── Finish ──
    done: {
      part: 'done', side: 'unit', dur: 3.6, still: 3.6,
      title: 'Unplug, and note the new versions',
      do: 'Take out the stick (if it is still in) and the USB lead. Put the new versions in the visit\'s notes beside the ones you noted at the start.',
      tip: 'An A2 on Iridium satellite: check its Epoch setting. ELPRO says re-applying firmware the unit already has — or a factory default — puts it back to its original setting.',
      unit: [tw('stick', 0.3, 1, 0), tw('cable', 1.2, 1.2, 0)],
    },
  };

  const PREP = ['get', 'format', 'copy'];
  const CHECK = ['cable', 'term', 'ver'];
  const SEQ = {
    host: ['h-in', 'h-press', 'h-leds', 'h-out', 'h-ver'],
    boot: ['b-in', 'b-menu', 'b-leds', 'b-ver'],
    radio: ['r-in', 'r-menu', 'r-leds', 'r-enter', 'r-ver'],
    fi: ['f-in', 'f-menu', 'f-leds', 'f-enter', 'f-out', 'f-ver'],
  };
  const PATHS = {
    all:   { label: 'The whole upgrade', icon: '⭐', about: 'Stick, host, bootloader, radio and function image, in ELPRO\'s order.',
      steps: [...PREP, ...CHECK, 'save', ...SEQ.host, ...SEQ.boot, ...SEQ.radio, ...SEQ.fi, 'done'] },
    host:  { label: 'Host firmware', icon: '🧠', about: 'The USB stick, RESET and TEST. Always first: it is what lets the USB take more than one file.',
      steps: [...CHECK, 'save', ...SEQ.host, 'done'] },
    boot:  { label: 'Bootloader', icon: '🥾', about: 'From the menu. Only on a unit whose host is already v1.7.',
      steps: [...CHECK, ...SEQ.boot, 'done'] },
    radio: { label: 'Radio firmware', icon: '📻', about: 'The radio\'s application, from the menu. Host v1.7 and bootloader v1.3 first.',
      steps: [...CHECK, ...SEQ.radio, 'done'] },
    fi:    { label: 'Function image', icon: '🧩', about: 'The radio\'s function image, from the menu, after its application.',
      steps: [...CHECK, ...SEQ.fi, 'done'] },
    check: { label: 'Just check the versions', icon: '🔎', about: 'Plug in, log in, read the three lines, unplug.',
      steps: [...CHECK, 'done'] },
    usb:   { label: 'Get a USB stick ready', icon: '🗂️', about: 'Download, format and copy — at the desk, before the trip.',
      steps: [...PREP] },
  };

  // ── The session ────────────────────────────────────────────────────────────
  const S = {
    path: 'all', i: 0, t: 0, playing: true, speed: 1, fresh: true,
    mine: null,                 // { parts: [...], steps: [...] } — a path made by the checker
    before: '', after: '',
    ticks: {},
  };
  let live = null;              // the running page: loop, observers

  const $ = id => document.getElementById(id);
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const ease = p => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
  function still() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
  }
  function readLS() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  function writeLS() { try { localStorage.setItem(KEY, JSON.stringify({ path: S.path === 'mine' ? 'all' : S.path })); } catch (_) { /* private mode */ } }

  function pathDef(id = S.path) {
    if (id === 'mine' && S.mine) return { label: 'What this unit needs', icon: '🎯', about: S.mine.about, steps: S.mine.steps, start: 'all' };
    return PATHS[id] || PATHS.all;
  }
  const stepsOf = (id = S.path) => pathDef(id).steps;
  const startOf = id => START[id === 'mine' ? (S.mine && S.mine.start) || 'all' : id] || START.all;

  // ── A frame: the unit ──────────────────────────────────────────────────────

  function unitZero() {
    return { stick: 0, cable: 0, d: [0, 0, 0, 0], usb: 0, drv: 0, drvP: 0, fin: 0, finP: 0, hold: 0, rip: { drv: -1, fin: -1 }, boot: 0 };
  }
  function cloneUnit(u) { return { ...u, d: u.d.slice(), rip: { ...u.rip } }; }

  // One event's effect on the unit at time t (seconds into its step).
  function applyUnit(u, ev, t) {
    const p = ev.dur ? clamp((t - ev.at) / ev.dur) : (t >= ev.at ? 1 : 0);
    switch (ev.e) {
      case 'tw': u[ev.k] = u[ev.k] + (ev.to - u[ev.k]) * ease(p); break;
      case 'led': if (t >= ev.at) u.d[ev.i] = Math.max(u.d[ev.i], clamp((t - ev.at) / 0.2)); break;
      case 'leds': {
        const n = 4 - ev.from;
        for (let k = 0; k < n; k++) {
          const at = ev.at + (n > 1 ? ev.dur * k / (n - 1) : 0);
          if (t >= at) u.d[ev.from + k] = Math.max(u.d[ev.from + k], clamp((t - at) / 0.2));
        }
        break;
      }
      case 'off': if (t >= ev.at) u.d = [0, 0, 0, 0]; break;
      case 'tap': {
        const q = (t - ev.at) / ev.dur;
        if (q > 0 && q < 1) u[ev.k + 'P'] = Math.sin(Math.PI * q);
        const r = (t - ev.at - ev.dur * 0.4) / 0.9;
        if (r >= 0 && r <= 1) u.rip[ev.k] = r;
        break;
      }
      case 'hold': {
        if (t >= ev.at && t <= ev.at + ev.dur) {
          u.finP = Math.min(1, (t - ev.at) / 0.15);
          u.hold = (t - ev.at) / ev.dur;
          const r = ((t - ev.at) % 1.1) / 0.9;
          if (r <= 1) u.rip.fin = r;
        } else if (t > ev.at + ev.dur) {
          const q = (t - ev.at - ev.dur) / 0.25;
          if (q < 1) { u.finP = 1 - q; u.hold = 1; }
        }
        break;
      }
      case 'blink': if (t >= ev.at && t <= ev.at + ev.dur) u.usb = Math.floor((t - ev.at) * 7) % 2 ? 0.25 : 1; break;
      case 'reboot': {
        if (t < ev.at) break;
        const q = (t - ev.at) / ev.dur;
        if (q >= 1) { u.d = [0, 0, 0, 0]; u.boot = 0; break; }
        // Everything goes out, then the four flash together once as it starts.
        const on = q > 0.45 && q < 0.7 ? 1 : 0;
        u.d = [on, on, on, on];
        u.boot = q < 0.45 ? 1 - q / 0.45 : 0;
        break;
      }
      default: break;
    }
    return u;
  }
  // The transient parts of a step's end — a press, a ripple, the hold ring —
  // are not carried into the next step.
  function settleUnit(u) {
    u.drvP = 0; u.finP = 0; u.hold = 0; u.usb = 0; u.boot = 0; u.rip = { drv: -1, fin: -1 };
    return u;
  }
  function unitAt(start, step, t) {
    const u = cloneUnit(start);
    for (const ev of step.unit || []) applyUnit(u, ev, t);
    return u;
  }

  // ── A frame: the laptop ────────────────────────────────────────────────────

  // The window a pc step shows at time t, from the screen the steps before it
  // left. A unit step shows the last pc step's final screen, set aside.
  function pcAt(prev, step, t, fw) {
    const pc = step.pc;
    if (!pc) return prev ? { ...prev, keys: [] } : null;
    if (pc.win !== 'term') return { win: pc.win, title: pc.title, pc, t, keys: [] };
    // What was on the screen stays, its picks no longer lit.
    let lines = !pc.clear && prev && prev.win === 'term' ? prev.lines.map(ln => ({ ...ln, picked: false })) : [];
    const keys = [];
    for (const ln of pc.lines || []) {
      if (ln.key) { if (t >= ln.at && t < ln.at + 0.75) keys.push(ln.key); continue; }
      if (t < ln.at) continue;
      let text = ln.dyn ? dynLine(ln.dyn, fw) : ln.t;
      if (ln.type) text = text.slice(0, Math.max(1, Math.round(text.length * clamp((t - ln.at) / ln.type))));
      if (ln.echo && t >= ln.echo.at) text += ln.echo.ch;
      lines.push({ t: text, c: ln.c, pk: ln.pk, picked: ln.sel != null && t >= ln.sel, fi: ln.fi });
    }
    if (pc.versions != null && t >= pc.versions) {
      for (const ln of versionLines(pc.versions, fw)) if (t >= ln.at) lines.push({ t: ln.t, c: ln.c, fi: ln.fi });
    }
    if (lines.length > TERM_ROWS) lines = lines.slice(lines.length - TERM_ROWS);
    return { win: 'term', title: pc.title, lines, keys, t };
  }
  const TERM_ROWS = 18;
  // The Main Menu's two lines above its title, as the manual's screenshot has
  // them: the clock and the station's address, then the host's version.
  function dynLine(k, fw) {
    if (k === 'clock') return '01-May-2026 09:14:05 UTC; Station Address: 1000';
    if (k === 'head') return `Firmware: ${fw.host === 'new' ? 'v1.7' : 'v1.6'}  Hardware: Rev3.B`;
    return '';
  }

  // Every step's start on a path: the unit, the laptop's screen and the
  // versions, carried from the steps before. Kept per path.
  const memo = new Map();
  function starts(id = S.path) {
    const key = id === 'mine' ? `mine:${(S.mine && S.mine.steps.join(',')) || ''}` : id;
    if (memo.has(key)) return memo.get(key);
    const list = [];
    let u = unitZero(), pc = null;
    const fw = { ...startOf(id) };
    for (const sid of stepsOf(id)) {
      const st = STEPS[sid];
      list.push({ unit: cloneUnit(u), pc, fw: { ...fw } });
      u = settleUnit(unitAt(u, st, Infinity));
      if (st.pc) pc = pcAt(pc, st, Infinity, fw);
      if (st.fw) Object.assign(fw, st.fw);
    }
    memo.set(key, list);
    return list;
  }

  // The whole picture at step i, t seconds in: pure.
  function frame(id = S.path, i = S.i, t = S.t) {
    const ids = stepsOf(id);
    const k = Math.max(0, Math.min(ids.length - 1, i));
    const st = STEPS[ids[k]];
    const s0 = starts(id)[k];
    return { id: ids[k], step: st, unit: unitAt(s0.unit, st, t), pc: pcAt(s0.pc, st, t, s0.fw), fw: s0.fw };
  }

  // ── Drawing the unit ───────────────────────────────────────────────────────
  // A 640 × 400 drawing, after the board in ELPRO's sheet and the callouts on
  // its installation guide: the SERIAL DB9 at the top left, D1 to D4 in a row
  // under it (D1 the left-most) over the GND DIO1–DIO4 GND terminals, and down
  // the right-hand edge RESET (down its hole), the square USB B socket for the
  // laptop, the narrow upright USB A socket for the stick, and TEST. Drawn in
  // the board's own colours, which do not change with the theme.
  const B = {
    reset: [452, 66], usbB: [490, 134], usbA: [490, 236], test: [452, 326],
    led: [[84, 172], [124, 172], [164, 172], [204, 172]],
  };
  const STICK_OUT = 52;                 // how far an unplugged stick sits from its socket
  const JOB = { host: 'host firmware', boot: 'bootloader', radio: 'radio firmware', fi: 'function image' };

  function unitSvg() {
    const leds = B.led.map(([x, y], i) => `
      <g class="fw-led">
        <text class="fw-silk fw-silk--sm" x="${x}" y="${y - 20}" text-anchor="middle">D${i + 1}</text>
        <circle cx="${x}" cy="${y}" r="11" class="fw-led-ring"/>
        <circle cx="${x}" cy="${y}" r="8" class="fw-led-off"/>
        <circle id="fw-led-g${i}" cx="${x}" cy="${y}" r="20" class="fw-led-glow" opacity="0" filter="url(#fw-blur)"/>
        <circle id="fw-led-${i}" cx="${x}" cy="${y}" r="8" class="fw-led-on" opacity="0"/>
      </g>`).join('');
    const terms = ['GND', 'DIO1', 'DIO2', 'DIO3', 'DIO4', 'GND'].map((n, i) => {
      const x = 64 + i * 32;
      return `<rect x="${x - 13}" y="218" width="26" height="34" rx="3" class="fw-tb-cell"/>
        <circle cx="${x}" cy="230" r="7" class="fw-screw"/><path d="M${x - 4} 230h8" class="fw-slot"/>
        <text class="fw-silk fw-silk--xs" x="${x}" y="270" text-anchor="middle">${n}</text>`;
    }).join('');
    const db9 = [0, 1, 2, 3, 4].map(k => `<circle cx="${88 + k * 22}" cy="86" r="3.6" class="fw-db9-pin"/>`).join('')
      + [0, 1, 2, 3].map(k => `<circle cx="${99 + k * 22}" cy="102" r="3.6" class="fw-db9-pin"/>`).join('');
    const [rx, ry] = B.reset, [tx, ty] = B.test, [ax, ay] = B.usbA, [bx, by] = B.usbB;
    const label = (x, y, t, sub) => `<text class="fw-silk fw-silk--sm" x="${x}" y="${y}" text-anchor="end">${t}</text>
      ${sub ? `<text class="fw-silk fw-silk--xs" x="${x}" y="${y + 13}" text-anchor="end">${sub}</text>` : ''}`;
    return `<svg class="fw-unit" id="fw-unit" viewBox="0 0 640 400" role="img" aria-labelledby="fw-unit-t fw-unit-d" focusable="false">
      <title id="fw-unit-t">The ERT-A2's board</title>
      <desc id="fw-unit-d">The SERIAL DB9 at the top left, D1 to D4 in a row under it over the DIO terminals; down the right-hand edge RESET in its hole, the USB B socket for the laptop's lead, the USB A socket for the stick, and TEST.</desc>
      <defs>
        <filter id="fw-blur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="5"/></filter>
        <linearGradient id="fw-metal" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#eef1f4"/><stop offset="1" stop-color="#9aa4ae"/></linearGradient>
      </defs>
      <rect x="16" y="20" width="474" height="360" rx="16" class="fw-pcb"/>
      <rect x="16" y="20" width="474" height="360" rx="16" class="fw-pcb-edge"/>
      ${[[38, 42], [38, 358]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7" class="fw-hole"/>`).join('')}
      <text class="fw-silk fw-silk--lg" x="56" y="330">ERT-A2</text>
      <text class="fw-silk fw-silk--sm" x="56" y="350">ALERT2 transmitter</text>
      <text class="fw-silk fw-silk--sm" x="76" y="60">SERIAL</text>
      <path d="M68 70h134l-10 44H78z" class="fw-db9"/>
      ${db9}
      ${leds}
      <rect x="44" y="212" width="204" height="46" rx="5" class="fw-tb"/>
      ${terms}

      <g id="fw-badge" class="fw-badge" opacity="0">
        <rect x="228" y="158" width="192" height="30" rx="15" class="fw-badge-r"/>
        <text id="fw-badge-t" x="324" y="177.5" text-anchor="middle" class="fw-badge-t"></text>
      </g>

      ${label(rx - 24, ry + 4, 'RESET', 'reboot')}
      <circle cx="${rx}" cy="${ry}" r="17" class="fw-pad"/>
      <circle cx="${rx}" cy="${ry}" r="11" class="fw-pit"/>
      <circle id="fw-reset-cap" cx="${rx}" cy="${ry}" r="5.5" class="fw-reset"/>
      <circle id="fw-rip-drv" cx="${rx}" cy="${ry}" r="18" class="fw-rip" opacity="0"/>

      ${label(bx - 66, by + 2, 'USB B', 'laptop')}
      <rect x="${bx - 58}" y="${by - 28}" width="58" height="56" rx="3" class="fw-sock"/>
      <path d="M${bx - 48} ${by - 18}h40v36h-40l-0 -28z" class="fw-sock-in"/>
      <rect x="${bx - 40}" y="${by - 9}" width="30" height="18" rx="2" class="fw-tongue"/>

      ${label(ax - 64, ay + 2, 'USB A', 'stick')}
      <rect x="${ax - 56}" y="${ay - 38}" width="56" height="76" rx="3" class="fw-sock"/>
      <rect x="${ax - 50}" y="${ay - 30}" width="50" height="60" rx="2" class="fw-sock-in"/>
      <rect x="${ax - 50}" y="${ay - 4}" width="44" height="12" rx="1.5" class="fw-tongue"/>

      ${label(tx - 30, ty + 4, 'TEST')}
      <circle id="fw-hold" cx="${tx}" cy="${ty}" r="26" class="fw-holdring" stroke-dasharray="163.4" stroke-dashoffset="163.4" transform="rotate(-90 ${tx} ${ty})"/>
      <circle cx="${tx}" cy="${ty}" r="18" class="fw-btn-base"/>
      <circle id="fw-test-cap" cx="${tx}" cy="${ty}" r="13" class="fw-btn"/>
      <circle id="fw-rip-fin" cx="${tx}" cy="${ty}" r="20" class="fw-rip" opacity="0"/>

      <g id="fw-cable" class="fw-cable-g" opacity=".35" transform="translate(60 0)">
        <path d="M${bx + 52} ${by}C${bx + 90} ${by} ${bx + 100} ${by + 40} 640 ${by + 44}" class="fw-lead"/>
        <rect x="${bx - 44}" y="${by - 14}" width="46" height="28" rx="2" fill="url(#fw-metal)" class="fw-plug-m"/>
        <rect x="${bx + 2}" y="${by - 20}" width="52" height="40" rx="6" class="fw-plug-b"/>
        <text x="${bx + 66}" y="${by + 68}" class="fw-silk fw-silk--xs fw-lead-t">to the laptop ›</text>
      </g>

      <g id="fw-stick" class="fw-stick-g" opacity=".5" transform="translate(${STICK_OUT} 0)">
        <rect x="${ax - 48}" y="${ay - 25}" width="56" height="50" rx="2" fill="url(#fw-metal)" class="fw-stick-m"/>
        <rect x="${ax - 40}" y="${ay - 16}" width="10" height="8" class="fw-stick-hole"/><rect x="${ax - 40}" y="${ay + 8}" width="10" height="8" class="fw-stick-hole"/>
        <rect x="${ax + 6}" y="${ay - 30}" width="88" height="60" rx="10" class="fw-stick-body"/>
        <text x="${ax + 50}" y="${ay + 5}" text-anchor="middle" class="fw-stick-t">FIRMWARE</text>
        <circle id="fw-usbled" cx="${ax + 82}" cy="${ay - 18}" r="4" class="fw-usbled" opacity=".25"/>
      </g>

      <g id="fw-drv" class="fw-drv-g" opacity="0">
        <path d="M0 0l58 -58" class="fw-drv-shaft"/>
        <path d="M54 -54l40 -40" class="fw-drv-handle"/>
      </g>
      <g id="fw-fin" class="fw-fin-g" opacity="0">
        <path d="M-15 6C-17 -12 -8 -22 4 -21C16 -20 21 -10 19 6L30 74H-6z" class="fw-finger"/>
        <path d="M-8 -6C-8 -15 -1 -18 5 -17C11 -16 13 -10 12 -4C5 -1 -2 -1 -8 -6z" class="fw-nail"/>
      </g>
    </svg>`;
  }

  // What the badge in the middle of the board says: which part is going in,
  // while the LEDs are counting it in.
  function badgeText(st, u) {
    if (!st || !st.job) return '';
    const lit = u.d.filter(x => x > 0.5).length;
    if (u.hold > 0 && u.hold < 1 && !lit) return 'Hold TEST until D1 lights';
    if (!lit) return '';
    return lit >= 4 ? `✓ ${JOB[st.job]} in` : `Loading: ${JOB[st.job]}…`;
  }

  // Put a frame's unit onto the drawing.
  function paintUnit(u, st) {
    const set = (id, a, v) => { const el = $(id); if (el) el.setAttribute(a, v); };
    for (let i = 0; i < 4; i++) {
      set(`fw-led-${i}`, 'opacity', u.d[i].toFixed(3));
      set(`fw-led-g${i}`, 'opacity', (u.d[i] * 0.85).toFixed(3));
    }
    set('fw-stick', 'transform', `translate(${((1 - u.stick) * STICK_OUT).toFixed(1)} 0)`);
    set('fw-stick', 'opacity', (0.5 + 0.5 * u.stick).toFixed(3));
    set('fw-usbled', 'opacity', (u.usb || 0.25).toFixed(2));
    set('fw-cable', 'transform', `translate(${((1 - u.cable) * 60).toFixed(1)} 0)`);
    set('fw-cable', 'opacity', (0.35 + 0.65 * u.cable).toFixed(3));
    // The screwdriver comes in from the top right, down RESET's hole.
    const [rx, ry] = B.reset;
    const da = ease(u.drv);
    const dx = rx + (1 - da) * 150 - u.drvP * 5, dy = ry - (1 - da) * 150 + u.drvP * 5;
    set('fw-drv', 'transform', `translate(${dx.toFixed(1)} ${dy.toFixed(1)})`);
    set('fw-drv', 'opacity', u.drv > 0.01 ? '1' : '0');
    // The finger from below, onto TEST.
    const [tx, ty] = B.test;
    const fa = ease(u.fin);
    const fx = tx + 6 + (1 - fa) * 120, fy = ty + 4 + (1 - fa) * 130 + u.finP * 3;
    set('fw-fin', 'transform', `translate(${fx.toFixed(1)} ${fy.toFixed(1)}) rotate(-18)`);
    set('fw-fin', 'opacity', u.fin > 0.01 ? '1' : '0');
    set('fw-test-cap', 'r', (13 - u.finP * 2).toFixed(2));
    set('fw-reset-cap', 'r', (5.5 - u.drvP * 1.5).toFixed(2));
    set('fw-hold', 'stroke-dashoffset', (163.4 * (1 - (u.finP > 0 ? u.hold : 0))).toFixed(1));
    for (const k of ['drv', 'fin']) {
      const r = u.rip[k];
      set(`fw-rip-${k}`, 'opacity', r >= 0 ? (1 - r).toFixed(3) : '0');
      set(`fw-rip-${k}`, 'r', ((k === 'drv' ? 14 : 18) + (r >= 0 ? r : 0) * 22).toFixed(1));
    }
    const bt = badgeText(st, u);
    const tEl = $('fw-badge-t');
    if (tEl && tEl.textContent !== bt) tEl.textContent = bt;
    set('fw-badge', 'opacity', bt ? '1' : '0');
    const svg = $('fw-unit');
    if (svg) svg.classList.toggle('is-booting', u.boot > 0.05);
  }

  // ── Drawing the laptop ─────────────────────────────────────────────────────

  const FILES = [
    { n: TARGET.host.file, d: TARGET.host.date, ty: 'BIN File', kb: TARGET.host.kb },
    { n: TARGET.boot.file, d: TARGET.boot.date, ty: 'BIN File', kb: TARGET.boot.kb },
    { n: TARGET.radio.file, d: TARGET.radio.date, ty: 'WRAP File', kb: TARGET.radio.kb },
    { n: TARGET.fi.file, d: TARGET.fi.date, ty: 'WRAP File', kb: TARGET.fi.kb },
  ];

  function pcHtml(w) {
    if (!w) {
      return `<div class="fw-win fw-win--idle"><div class="fw-win-bar"><span class="fw-win-dots" aria-hidden="true"></span><span class="fw-win-title">Laptop</span></div>
        <div class="fw-win-idle">Nothing to do on the laptop yet.</div></div>`;
    }
    const bar = title => `<div class="fw-win-bar"><span class="fw-win-dots" aria-hidden="true"></span><span class="fw-win-title">${esc(title)}</span><span class="fw-sim">Simulated</span></div>`;
    if (w.win === 'files') {
      const pc = w.pc;
      const shown = pc.rows.filter(at => w.t >= at).length;
      const copying = pc.copy && shown < 4 && w.t >= pc.rows[0] - 0.6;
      return `<div class="fw-win fw-win--files">${bar(w.title)}
        <div class="fw-files" role="table" aria-label="${escAttr(w.title)}">
          <div class="fw-file fw-file--head" role="row"><span role="columnheader">Name</span><span role="columnheader">Date modified</span><span role="columnheader">Type</span><span role="columnheader">Size</span></div>
          ${FILES.map((f, k) => `<div class="fw-file${k < shown ? ' is-in' : ''}${k === shown - 1 && w.t - pc.rows[k] < 0.6 ? ' is-new' : ''}" role="row">
            <span role="cell"><span aria-hidden="true">${f.ty === 'BIN File' ? '📄' : '📦'}</span> ${esc(f.n)}</span><span role="cell">${esc(f.d)}</span><span role="cell">${f.ty}</span><span role="cell">${f.kb} KB</span></div>`).join('')}
        </div>
        ${copying ? `<div class="fw-copy"><span>Copying ${shown + 1} of 4 …</span><span class="fw-bar"><span class="fw-bar-in" style="--p:${Math.round(100 * clamp((w.t - (pc.rows[shown - 1] || pc.rows[0] - 0.6)) / 1))}%"></span></span></div>` : ''}
      </div>`;
    }
    if (w.win === 'format') {
      const pc = w.pc;
      const fsHot = w.t >= pc.fs && w.t < pc.fs + 1.3;
      const quickOff = w.t >= pc.quick;
      const quickHot = w.t >= pc.quick - 0.5 && w.t < pc.quick + 0.9;
      const startHot = w.t >= pc.start && w.t < pc.start + 0.5;
      const fill = clamp((w.t - pc.fill[0]) / (pc.fill[1] - pc.fill[0]));
      return `<div class="fw-win fw-win--format">${bar('Format FIRMWARE (D:)')}
        <div class="fw-form">
          <div class="fw-field"><span>Capacity:</span><span class="fw-sel">1.87 GB</span></div>
          <div class="fw-field${fsHot ? ' is-hot' : ''}"><span>File system:</span><span class="fw-sel">${w.t >= pc.fs + 0.4 ? 'FAT32' : 'exFAT'} ▾</span></div>
          <div class="fw-field"><span>Allocation unit size:</span><span class="fw-sel">4096 bytes ▾</span></div>
          <div class="fw-field"><span>Volume label:</span><span class="fw-sel">FIRMWARE</span></div>
          <div class="fw-field${quickHot ? ' is-hot' : ''}"><span>Format options:</span><span class="fw-check"><span class="fw-box" aria-hidden="true">${quickOff ? '' : '✓'}</span> Quick Format ${quickOff ? '<em>(off)</em>' : ''}</span></div>
          <div class="fw-progress"><span class="fw-bar"><span class="fw-bar-in" style="--p:${Math.round(fill * 100)}%"></span></span>${fill >= 1 ? '<span class="fw-ok">Format complete.</span>' : ''}</div>
          <div class="fw-form-btns"><span class="fw-fbtn${startHot ? ' is-hot' : ''}">Start</span><span class="fw-fbtn">Close</span></div>
        </div></div>`;
    }
    const lines = w.lines.map(ln => {
      const fi = ln.fi ? ` <span class="tm-fi">${esc(ln.fi)}</span>` : '';
      let body = esc(ln.t);
      // The option picked, lit within its line.
      if (ln.picked && ln.pk && ln.t.includes(ln.pk)) {
        const at = ln.t.indexOf(ln.pk);
        body = `${esc(ln.t.slice(0, at))}<mark class="tm-pick">${esc(ln.pk)}</mark>${esc(ln.t.slice(at + ln.pk.length))}`;
      }
      return `<span class="tm ${ln.c || ''}">${body}${fi}</span>`;
    }).join('\n');
    const cursor = '<span class="tm-cur" aria-hidden="true">▌</span>';
    return `<div class="fw-win fw-win--term">${bar(w.title)}
      <pre class="fw-term">${lines}${cursor}</pre>
      <div class="fw-keys" aria-hidden="true">${(w.keys || []).map(k => `<kbd class="fw-key">${esc(k)}</kbd>`).join('')}</div>
    </div>`;
  }

  // ── The walkthrough ────────────────────────────────────────────────────────

  function pathsHtml() {
    const ids = Object.keys(PATHS);
    const mine = S.mine ? `<button type="button" class="fw-path${S.path === 'mine' ? ' is-on' : ''}" aria-pressed="${S.path === 'mine'}" onclick="A2Firmware.path('mine')">
        <span class="fw-path-i" aria-hidden="true">🎯</span><span class="fw-path-n">What this unit needs</span><span class="fw-path-a">${esc(S.mine.about)}</span></button>` : '';
    return `<div class="fw-paths" role="group" aria-label="What to walk through">${ids.map(id => {
      const p = PATHS[id];
      return `<button type="button" class="fw-path${S.path === id ? ' is-on' : ''}" aria-pressed="${S.path === id}" onclick="A2Firmware.path('${id}')">
        <span class="fw-path-i" aria-hidden="true">${p.icon}</span><span class="fw-path-n">${esc(p.label)}</span><span class="fw-path-a">${esc(p.about)}</span></button>`;
    }).join('')}${mine}</div>`;
  }

  function dotsHtml() {
    const ids = stepsOf();
    let last = '';
    return `<ol class="fw-dots" aria-label="Steps">${ids.map((sid, k) => {
      const st = STEPS[sid];
      const gap = st.part !== last && k ? ' fw-dot--gap' : '';
      last = st.part;
      return `<li class="fw-dot-li${gap}"><button type="button" class="fw-dot fw-dot--${st.part}${k === S.i ? ' is-on' : ''}${k < S.i ? ' is-past' : ''}"
        ${k === S.i ? 'aria-current="step"' : ''} aria-label="Step ${k + 1}: ${escAttr(st.title)} (${escAttr(PARTS[st.part].short)})" title="${escAttr(`${k + 1} · ${st.title}`)}"
        onclick="A2Firmware.step(${k})"><span aria-hidden="true">${st.side === 'unit' ? '✋' : '⌨'}</span></button></li>`;
    }).join('')}</ol>`;
  }

  const sideWord = s => (s === 'unit' ? 'At the unit' : 'At the laptop');
  const sideIcon = s => (s === 'unit' ? '✋' : '⌨️');

  function captionHtml() {
    const ids = stepsOf();
    const st = STEPS[ids[S.i]];
    const part = PARTS[st.part];
    const nx = STEPS[ids[S.i + 1]];
    return `<div class="fw-cap fw-cap--${st.side}">
      <p class="fw-cap-meta">
        <span class="fw-chip fw-chip--${st.part}"><span aria-hidden="true">${part.icon}</span> ${esc(part.name)}</span>
        <span class="fw-side fw-side--${st.side}"><span aria-hidden="true">${sideIcon(st.side)}</span> ${sideWord(st.side)}</span>
        <span class="fw-cap-n">Step ${S.i + 1} of ${ids.length}</span>
        ${st.opt ? `<span class="fw-opt">Optional — ${esc(st.opt)}</span>` : ''}
      </p>
      <h4 class="fw-cap-title" id="fw-cap-title">${esc(st.title)}</h4>
      <p class="fw-cap-do">${st.do}</p>
      ${st.watch ? `<p class="fw-cap-watch"><span aria-hidden="true">👀</span> <strong>Look for:</strong> ${esc(st.watch)}</p>` : ''}
      ${st.warn ? `<p class="fw-cap-warn" role="note"><span aria-hidden="true">⚠️</span> ${esc(st.warn)}</p>` : ''}
      ${st.tip ? `<p class="fw-cap-tip"><span aria-hidden="true">💡</span> ${esc(st.tip)}</p>` : ''}
      ${nx ? `<p class="fw-cap-next">Next: <span aria-hidden="true">${sideIcon(nx.side)}</span> ${esc(nx.title)}</p>` : '<p class="fw-cap-next">That is the end of this path.</p>'}
    </div>`;
  }

  function playerHtml() {
    const ids = stepsOf();
    const st = STEPS[ids[S.i]];
    return `<div class="fw-player" id="fw-player" data-side="${st.side}">
      ${pathsHtml()}
      <div class="fw-stage" id="fw-stage" role="region" aria-label="Walkthrough: the unit and the laptop" tabindex="0" onkeydown="A2Firmware.key(event)">
        <figure class="fw-pane fw-pane--unit${st.side === 'unit' ? ' is-active' : ''}" id="fw-pane-unit">
          <figcaption class="fw-pane-tag"><span aria-hidden="true">✋</span> On the unit<span class="fw-now">${st.side === 'unit' ? ' — now' : ''}</span></figcaption>
          <div class="fw-unit-wrap" id="fw-unit-wrap">${unitSvg()}</div>
        </figure>
        <figure class="fw-pane fw-pane--pc${st.side === 'pc' ? ' is-active' : ''}" id="fw-pane-pc">
          <figcaption class="fw-pane-tag"><span aria-hidden="true">⌨️</span> On the laptop<span class="fw-now">${st.side === 'pc' ? ' — now' : ''}</span></figcaption>
          <div class="fw-pc-wrap" id="fw-pc"></div>
        </figure>
      </div>
      <div class="fw-transport" role="group" aria-label="Walkthrough controls">
        <button type="button" class="btn" onclick="A2Firmware.step(0)" aria-label="Back to the first step">⏮</button>
        <button type="button" class="btn" id="fw-back" onclick="A2Firmware.back()"${S.i === 0 ? ' disabled' : ''}>◀ Back</button>
        <button type="button" class="btn btn-primary fw-playbtn" id="fw-play" aria-pressed="${S.playing}" onclick="A2Firmware.play()">${S.playing ? '⏸ Pause' : '▶ Play'}</button>
        <button type="button" class="btn" id="fw-next" onclick="A2Firmware.next()"${S.i >= ids.length - 1 ? ' disabled' : ''}>Next ▶</button>
        <button type="button" class="btn" onclick="A2Firmware.replay()">↻ This step again</button>
        <label class="fw-speed">Speed <select id="fw-speed" onchange="A2Firmware.speed(this.value)">
          ${[[0.5, '½×'], [1, '1×'], [1.5, '1½×'], [2, '2×']].map(([v, t]) => `<option value="${v}"${S.speed === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select></label>
        <label class="fw-seek"><span class="fw-seek-l">Position in this step</span>
          <input type="range" id="fw-seek" min="0" max="1000" value="0" oninput="A2Firmware.seek(this.value / 1000)"></label>
      </div>
      <div id="fw-dots-wrap">${dotsHtml()}</div>
      <div id="fw-cap">${captionHtml()}</div>
      <p class="fw-keyhint">With the walkthrough focused: <kbd>←</kbd> <kbd>→</kbd> step, <kbd>Space</kbd> play or pause.</p>
    </div>`;
  }

  // ── 2 · Before you start ───────────────────────────────────────────────────

  function prepHtml() {
    return `
      <div class="fw-two">
        <div>
          <h4>What you need</h4>
          <ul class="fw-kit">
            <li><span aria-hidden="true">💾</span> <strong>A USB 2.0 stick</strong> known to have loaded firmware into an A2 before, with nothing else on it — ELPRO's 2021 manual says firmware wants USB 2.0, not USB 3.0. Some sticks come formatted in a way the A2 cannot read and need a full format first (below).</li>
            <li><span aria-hidden="true">📦</span> <strong>The firmware files</strong> — ELPRO's Release G pack, from <a href="${ZIP}" target="_blank" rel="noopener">ELPRO's resource link</a> or from ELPRO Technical Support.</li>
            <li><span aria-hidden="true">💻</span> <strong>A Windows laptop</strong>, to format the stick and copy the files onto it.</li>
            <li><span aria-hidden="true">⌨️</span> <strong>A terminal program</strong> — Tera Term (what ELPRO uses), PuTTY, RealTerm or HyperTerminal — at 9600 baud, 8N1, no flow control, to reach the A2's menus and check each part took.</li>
            <li><span aria-hidden="true">🔑</span> <strong>The Engineer password</strong> for the A2: the Technician login is for viewing and basic diagnostics.</li>
            <li><span aria-hidden="true">🔌</span> <strong>A USB A-to-B lead</strong> (a printer lead), laptop to the A2's USB B socket.</li>
            <li><span aria-hidden="true">🪛</span> <strong>Something long and thin</strong>, like a small screwdriver, for RESET down its hole.</li>
          </ul>
          <h4>The order, and why</h4>
          <ol class="fw-order">
            <li><span class="fw-c fw-c--host">Host firmware</span> first: it is what lets the A2's USB take more than one file.</li>
            <li>Then the <span class="fw-c fw-c--boot">bootloader</span>, if it needs it.</li>
            <li>Last, the radio: its <span class="fw-c fw-c--radio">firmware (application)</span>, then its <span class="fw-c fw-c--fi">function image</span>.</li>
          </ol>
          <p class="fw-note fw-note--warn"><span aria-hidden="true">⚠️</span> <strong>Do not pull the USB stick or cut the power while a part is loading — the bootloader above all.</strong> Doing so can leave the A2 unable to start.</p>
          <p class="fw-note"><span aria-hidden="true">📏</span> ELPRO's procedure takes a unit from <strong>host v1.4</strong> and <strong>radio v1.3</strong> or later. A radio at <strong>V1.2 or lower</strong> cannot be updated this way: contact ELPRO Technologies for the options.</p>
          <h4>The four parts</h4>
          <ul class="fw-read">
            <li><span class="fw-c fw-c--host">Host firmware</span> — the A2's main processor: the menus, the inputs, the logging, the ALERT2 messages.</li>
            <li><span class="fw-c fw-c--boot">Bootloader</span> — the host's start-up code, which loads the host's firmware. The one part whose loading must never be interrupted.</li>
            <li><span class="fw-c fw-c--radio">Radio firmware</span> — the application in the A2's own radio module (it calls itself "E2_155 radio application").</li>
            <li><span class="fw-c fw-c--fi">Radio function image</span> — the firmware of the radio's receive (RX) chip, which ELPRO's menu calls the V23 image: V.23 is the ALERT modulation, and a unit set for the ALERT2 report format shows a different number for it.</li>
          </ul>
        </div>
        <div>
          <h4>The four files</h4>
          <div class="table-wrap"><table class="fw-table">
            <caption>Release G's files — unzipped, copied to the stick as they are</caption>
            <thead><tr><th scope="col">File</th><th scope="col">What it is</th><th scope="col">Loaded by</th></tr></thead>
            <tbody>
              <tr><td><code>${TARGET.host.file}</code></td><td><span class="fw-c fw-c--host">Host firmware</span> v1.7, build 10366</td><td>RESET, then TEST</td></tr>
              <tr><td><code>${TARGET.boot.file}</code></td><td><span class="fw-c fw-c--boot">Bootloader</span> v1.3, build 9967</td><td>Update Bootloader</td></tr>
              <tr><td><code>${TARGET.radio.file}</code></td><td><span class="fw-c fw-c--radio">Radio firmware</span> (its application) v1.4, build 10848 — Release G's fix for a repeater's transmitter locking up</td><td>Load firmware to Radio (ERTA2-R_app)</td></tr>
              <tr><td><code>${TARGET.fi.file}</code></td><td><span class="fw-c fw-c--fi">Radio function image</span> 6015, for radio v1.4</td><td>Load V23 Image to radio (ERTA2-R_fi6)</td></tr>
            </tbody>
          </table></div>
          <p class="fw-aside">The names should look like these; the version numbers in them may be newer. <strong>Do not rename the files or change them in any way.</strong></p>
          <h4>Formatting the stick (if it needs it)</h4>
          <ol class="fw-order">
            <li>Plug the stick into the laptop and find it in File Explorer.</li>
            <li>Right-click it and pick <strong>Format…</strong>.</li>
            <li>Set <strong>File system</strong> to <strong>FAT32</strong>.</li>
            <li><strong>Untick Quick Format.</strong> (ELPRO's screenshot shows the box ticked; its words say to untick it.)</li>
            <li>Press <strong>Start</strong>, and wait: a full format takes longer than a quick one.</li>
          </ol>
          <p class="button-group"><button type="button" class="btn" onclick="A2Firmware.path('usb', true)">▶ Show me the stick getting ready</button></p>
        </div>
      </div>
      <h4>Know the unit</h4>
      <div class="table-wrap"><table class="fw-table">
        <caption>What the upgrade uses on the A2, down its right-hand edge and on the board (ELPRO's installation guide and manual)</caption>
        <thead><tr><th scope="col">Part</th><th scope="col">Where</th><th scope="col">What it does</th><th scope="col">In the upgrade</th></tr></thead>
        <tbody>
          <tr><th scope="row">RESET</th><td>Top of the right-hand edge, down a small hole</td><td>Reboots the unit (its I/O values kept)</td><td>Tapped with a small screwdriver to start the host's load</td></tr>
          <tr><th scope="row">USB B</th><td>Under RESET: the square socket</td><td>Configuration and diagnostics — the menus</td><td>The laptop's lead, for the whole upgrade</td></tr>
          <tr><th scope="row">USB A</th><td>Under USB B: the narrow upright socket</td><td>Logged data out, firmware in</td><td>The stick with the four files</td></tr>
          <tr><th scope="row">TEST</th><td>Bottom of the right-hand edge</td><td>A short press sends an input data message; a long one (5 s) puts the logged data on a stick</td><td>Held after RESET until D1 lights, to load the host</td></tr>
          <tr><th scope="row">D1–D4</th><td>In a row under the SERIAL DB9, D1 on the left</td><td>The digital inputs, while the menu is active (D3 flashes for a rain tip)</td><td>The progress bar: one more lit for each check passed</td></tr>
          <tr><th scope="row">SERIAL (DB9)</th><td>Top left of the board</td><td>RS-232</td><td>Optional: during an update the A2 writes what it is doing, and any error, here at 9600 8N1 — not over USB</td></tr>
        </tbody>
      </table></div>`;
  }

  // ── 3 · The version screen, and the checker ────────────────────────────────

  // What Show Firmware Version printed, read line by line. Two formats: the
  // older host's (V1.4–V1.6), whose radio line is a comma list ending
  // "FW1.4,9869", and V1.7's, "v1.4 [date] (10075)" with FI:nnnn once a
  // function image has been loaded.
  function parse(text) {
    const out = { host: null, boot: null, radio: null, fi: null, error: false, oldRadio: false, lines: 0 };
    for (const raw of String(text || '').split(/\r?\n/)) {
      const ln = raw.trim();
      if (!ln) continue;
      let m;
      if (/^ERROR\b/i.test(ln)) { out.error = true; continue; }
      if (/Old version\s*-\s*Update Recommended/i.test(ln)) { out.oldRadio = true; continue; }
      if ((m = /^Host\s+Bootloader:\s*v?(\d+)\.(\d+)\s*-\s*(\d+)/i.exec(ln))) {
        out.boot = { v: [+m[1], +m[2]], build: +m[3] }; out.lines++; continue;
      }
      if ((m = /^Radio\s+Firmware:\s*(.*)$/i.exec(ln))) {
        const rest = m[1];
        let r = null;
        const a = /\bFW\s*(\d+)\.(\d+)\s*,\s*(\d+)/i.exec(rest);
        const b = /^v?(\d+)\.(\d+)\b[^(]*\((\d+)\)/i.exec(rest);
        if (b) r = { v: [+b[1], +b[2]], build: +b[3], fmt: 'new' };
        else if (a) r = { v: [+a[1], +a[2]], build: +a[3], fmt: 'old' };
        else if ((m = /\bv?(\d+)\.(\d+)/.exec(rest))) r = { v: [+m[1], +m[2]], build: null, fmt: '?' };
        if (r) { out.radio = r; out.lines++; }
        const fi = /\bFI\s*:\s*(\d+)/i.exec(rest);
        if (fi) out.fi = +fi[1];
        continue;
      }
      if ((m = /^(?:Host\s+)?Firmware:\s*v?(\d+)\.(\d+)\b(?:.*?:\s*(\d+)\s*$)?/i.exec(ln))) {
        out.host = { v: [+m[1], +m[2]], build: m[3] != null ? +m[3] : null }; out.lines++; continue;
      }
    }
    return out;
  }

  const vcmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);
  const vs = v => `v${v[0]}.${v[1]}`;

  // What a parsed screen means against Release G: each part 'ok', 'update',
  // 'stop' (outside this procedure) or 'unknown', the words for it, and the
  // parts to walk through.
  function advise(p) {
    const r = { host: null, boot: null, radio: null, fi: null, parts: [], stop: false, notes: [] };
    const say = (k, state, words) => { r[k] = { state, words }; };
    if (!p || !p.lines) return { ...r, empty: true };
    // The host.
    if (!p.host) say('host', 'unknown', 'No host line (Firmware: …) found.');
    else if (vcmp(p.host.v, [1, 4]) < 0) { say('host', 'stop', `${vs(p.host.v)} — older than this procedure starts from (v1.4). Contact ELPRO Technologies.`); r.stop = true; }
    else if (vcmp(p.host.v, TARGET.host.v) < 0 || (vcmp(p.host.v, TARGET.host.v) === 0 && p.host.build != null && p.host.build < TARGET.host.build)) say('host', 'update', `${vs(p.host.v)}${p.host.build != null ? `, build ${p.host.build}` : ''} — Release G brings it to v1.7, build ${TARGET.host.build}.`);
    else say('host', 'ok', `${vs(p.host.v)}${p.host.build != null ? `, build ${p.host.build}` : ''} — up to date for Release G.`);
    // The bootloader.
    if (!p.boot) say('boot', 'unknown', 'No Host Bootloader line found.');
    else if (vcmp(p.boot.v, TARGET.boot.v) < 0) say('boot', 'update', `${vs(p.boot.v)} - ${p.boot.build} — Release G's is v1.3 - ${TARGET.boot.build}.`);
    else say('boot', 'ok', `${vs(p.boot.v)} - ${p.boot.build} — up to date.`);
    // The radio's application.
    if (!p.radio) say('radio', 'unknown', 'No Radio Firmware line found.');
    else if (vcmp(p.radio.v, [1, 2]) <= 0) { say('radio', 'stop', `${vs(p.radio.v)} — V1.2 or lower cannot be updated by this procedure. Contact ELPRO Technologies for the options.`); r.stop = true; }
    else if (vcmp(p.radio.v, TARGET.radio.v) < 0 || p.radio.build == null || p.radio.build < TARGET.radio.build) {
      say('radio', 'update', `${vs(p.radio.v)}${p.radio.build != null ? `, build ${p.radio.build}` : ''} — Release G's radio application is v1.4, build ${TARGET.radio.build}${p.radio.fmt === 'old' ? ' (and this older line format means the host is old too)' : ''}.`);
    } else say('radio', 'ok', `${vs(p.radio.v)}, build ${p.radio.build} — up to date for Release G.`);
    // The radio's function image.
    if (p.fi == null) {
      if (p.radio && r.radio.state !== 'stop') say('fi', 'update', 'No FI: on the radio line — it shows once the radio\'s application is new; load the function image after it.');
      else say('fi', 'unknown', 'No FI: number found.');
    } else if (p.fi === TARGET.fi.n) say('fi', 'ok', `FI:${p.fi} — the latest.`);
    else if (p.fi === TARGET.fi.alt) say('fi', 'ok', `FI:${p.fi} — the unit is set for the ALERT2 report format, which shows this number in place of ${TARGET.fi.n}.`);
    else say('fi', 'update', `FI:${p.fi} — the latest is FI:${TARGET.fi.n}.`);
    if (p.error || p.oldRadio) r.notes.push('The ERROR / Old version lines are what a new bootloader says about an old radio: they go once the radio is done.');
    // Only the parts behind Release G, in ELPRO's order — the host first,
    // because it is what lets the USB take more than one file. A part already
    // current is left alone: re-applying firmware a unit already has puts an
    // Iridium unit's Epoch setting back to its original.
    if (!r.stop) for (const k of ['host', 'boot', 'radio', 'fi']) if (r[k] && r[k].state === 'update') r.parts.push(k);
    return r;
  }

  const EXAMPLES = {
    v16: { label: 'Host V1.6 (ELPRO\'s first example)', text: 'Firmware: v1.6 Aug 25 2022 14:43:29 : 9814\nHost Bootloader: v1.1 - 8708:261:33:0:0\nRadio Firmware: 1.0,ELPRO,ERT-A2,FW1.4,9869' },
    v17: { label: 'Host V1.7 (ELPRO\'s second)', text: 'Firmware: v1.7 Dec 20 2023 11:33:41 : 10177\nHost Bootloader: v1.3 - 9967:24:31:0:0\nRadio Firmware: v1.4 [Jun 12 2023 13:16:43] (10075)' },
    err:  { label: 'After the bootloader, before the radio', text: 'Firmware: v1.7 Nov 30 2022 17:04:17 : 9972\nHost Bootloader: v1.3 - 9967:0:0:0:0\nERROR: Could not read parameter value\nRadio Firmware: 1.0,ELPRO,ERT-A2,FW1.3,9543\n        ** Old version - Update Recommended **' },
    relf: { label: 'Release F, finished', text: 'Firmware: v1.7 Sep 20 2024 17:32:50 : 10366\nHost Bootloader: v1.3 - 9967:0:15:2:0\nRadio Firmware: v1.4 [Jul 26 2024 17:27:44] (10301) FI:6015' },
    old:  { label: 'A radio too old for this', text: 'Firmware: v1.6 Aug 25 2022 14:43:29 : 9814\nHost Bootloader: v1.1 - 8708:261:33:0:0\nRadio Firmware: 1.0,ELPRO,ERT-A2,FW1.2,9001' },
  };

  function screensHtml() {
    const box = (c, t, label) => `<span class="fw-box-hl fw-box-hl--${c}">${esc(t)}<span class="fw-box-tag">${label}</span></span>`;
    return `
      <p>Every part's version is on one screen: <strong>Unit Diagnostic → Show Firmware Version</strong>. Read it before you start, and after
        each part. ELPRO marks the host in <span class="fw-c fw-c--host">red</span>, the bootloader in <span class="fw-c fw-c--boot">yellow</span>
        and the radio in <span class="fw-c fw-c--radio">cyan</span>; the function image's number, once there is one, is at the end of the radio's line.</p>
      <div class="fw-two">
        <figure class="fw-shot">
          <figcaption>Host V1.4 to V1.6 shows it like this</figcaption>
          <pre class="fw-term fw-term--shot">${box('host', 'Firmware: v1.6 Aug 25 2022 14:43:29 : 9814', 'host')}
${box('boot', 'Host Bootloader: v1.1 - 8708', 'bootloader')}:261:33:0:0
Radio Firmware: 1.0,ELPRO,ERT-A2,${box('radio', 'FW1.4,9869', 'radio')}</pre>
        </figure>
        <figure class="fw-shot">
          <figcaption>Host V1.7 shows it like this — the function image's FI: once it has one</figcaption>
          <pre class="fw-term fw-term--shot">${box('host', 'Firmware: v1.7 Sep 20 2024 17:32:50 : 10366', 'host')}
${box('boot', 'Host Bootloader: v1.3 - 9967', 'bootloader')}:0:15:2:0
${box('radio', 'Radio Firmware: v1.4 [Jul 26 2024 17:27:44] (10301)', 'radio')} ${box('fi', 'FI:6015', 'function image')}</pre>
        </figure>
      </div>
      <ul class="fw-read">
        <li><span class="fw-c fw-c--host">Host</span>: the version after <strong>Firmware: v</strong>, and its build after the last colon. Release G: <strong>v1.7 … : 10366</strong>.</li>
        <li><span class="fw-c fw-c--boot">Bootloader</span>: after <strong>Host Bootloader: v</strong>, then its build. Release G: <strong>v1.3 - 9967</strong>.</li>
        <li><span class="fw-c fw-c--radio">Radio</span>: on an older host, the <strong>FW1.x</strong> near the end of a comma list; on v1.7, the version first and its build in brackets. Release G's application is <strong>v1.4</strong>, build <strong>10848</strong> (its file's last number).</li>
        <li><span class="fw-c fw-c--fi">Function image</span>: <strong>FI:</strong> at the end of the radio's line — shown only once the radio's application is new. Release G: <strong>FI:6015</strong>, or <strong>FI:2044</strong> on a unit set for the ALERT2 report format.</li>
      </ul>

      <h4 id="fw-checker-h">What does this unit need?</h4>
      <p>Copy the three lines out of the terminal and paste them here, or pick one of ELPRO's examples, and the checker reads them against Release G.
        Nothing typed here leaves this page.</p>
      <div class="fw-checker">
        <div class="fw-checker-in">
          <label for="fw-before" class="fw-lbl">Show Firmware Version, as the unit printed it</label>
          <textarea id="fw-before" class="fw-ta" rows="5" spellcheck="false" placeholder="Firmware: v1.6 Aug 25 2022 14:43:29 : 9814&#10;Host Bootloader: v1.1 - 8708:261:33:0:0&#10;Radio Firmware: 1.0,ELPRO,ERT-A2,FW1.4,9869" oninput="A2Firmware.check('before', this.value)">${esc(S.before)}</textarea>
          <p class="fw-examples" role="group" aria-label="ELPRO's examples">${Object.entries(EXAMPLES).map(([k, e]) =>
            `<button type="button" class="btn fw-sm" onclick="A2Firmware.example('${k}')">${esc(e.label)}</button>`).join('')}</p>
          <label for="fw-after" class="fw-lbl">…and after the upgrade (for the record, if you like)</label>
          <textarea id="fw-after" class="fw-ta" rows="3" spellcheck="false" oninput="A2Firmware.check('after', this.value)">${esc(S.after)}</textarea>
        </div>
        <div class="fw-verdict" id="fw-verdict" aria-live="polite">${verdictHtml()}</div>
      </div>`;
  }

  function verdictHtml() {
    const a = advise(parse(S.before));
    if (a.empty) return '<p class="fw-muted">Paste a version screen, or pick an example, to see what the unit needs.</p>';
    const icon = { ok: '✅', update: '⬆️', stop: '⛔', unknown: '❔' };
    const word = { ok: 'Up to date', update: 'Needs it', stop: 'Stop', unknown: 'Not found' };
    const rows = ['host', 'boot', 'radio', 'fi'].map(k => {
      const x = a[k];
      return `<li class="fw-v fw-v--${x.state}"><span class="fw-v-i" aria-hidden="true">${icon[x.state]}</span>
        <span class="fw-v-p"><span class="fw-c fw-c--${k}">${esc(PARTS[k].name)}</span> <span class="fw-v-s">${word[x.state]}</span></span>
        <span class="fw-v-w">${esc(x.words)}</span></li>`;
    }).join('');
    let foot;
    if (a.stop) foot = '<p class="fw-note fw-note--bad"><span aria-hidden="true">⛔</span> <strong>Do not start.</strong> This unit is outside what ELPRO\'s procedure covers: contact ELPRO Technologies.</p>';
    else if (!a.parts.length) foot = '<p class="fw-note fw-note--ok"><span aria-hidden="true">✅</span> Nothing to load: this unit is on Release G.</p>';
    else {
      const names = a.parts.map(k => PARTS[k].short.toLowerCase());
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
      foot = `<p class="fw-note"><span aria-hidden="true">🎯</span> This unit needs its <strong>${esc(list)}</strong>${a.parts[0] === 'host' ? ' — the host first' : ''}.</p>
        <p class="button-group"><button type="button" class="btn btn-primary" onclick="A2Firmware.mine()">▶ Walk me through just that</button></p>`;
    }
    const after = S.after.trim() ? afterHtml() : '';
    return `<ul class="fw-vlist">${rows}</ul>${a.notes.map(n => `<p class="fw-aside">${esc(n)}</p>`).join('')}${foot}${after}`;
  }
  function afterHtml() {
    const a = advise(parse(S.after));
    if (a.empty) return '<p class="fw-aside">The "after" box holds no version lines yet.</p>';
    const left = ['host', 'boot', 'radio', 'fi'].filter(k => a[k] && a[k].state !== 'ok');
    return left.length
      ? `<p class="fw-note fw-note--warn"><span aria-hidden="true">🔁</span> After: still not on Release G — ${esc(left.map(k => PARTS[k].short.toLowerCase()).join(', '))}. Go back over that part.</p>`
      : '<p class="fw-note fw-note--ok"><span aria-hidden="true">🎉</span> After: every part is on Release G.</p>';
  }

  // ── 4 · Every step, written out ────────────────────────────────────────────

  function listHtml() {
    const order = PATHS.all.steps;
    const parts = [];
    for (const sid of order) {
      const st = STEPS[sid];
      let g = parts[parts.length - 1];
      if (!g || g.part !== st.part) { g = { part: st.part, steps: [] }; parts.push(g); }
      g.steps.push(sid);
    }
    let n = 0;
    return `<p>The whole upgrade, in ELPRO's order. The <span class="fw-side fw-side--unit"><span aria-hidden="true">✋</span> At the unit</span> steps are done
      with your hands on the A2; the <span class="fw-side fw-side--pc"><span aria-hidden="true">⌨️</span> At the laptop</span> steps in the terminal.
      <strong>▶ Show me</strong> plays a step in the walkthrough above.</p>
      ${parts.map(g => `<div class="fw-part fw-part--${g.part}">
        <h4 class="fw-part-h"><span aria-hidden="true">${PARTS[g.part].icon}</span> ${esc(PARTS[g.part].name)}</h4>
        <ol class="fw-steps" start="${n + 1}">${g.steps.map(sid => {
          const st = STEPS[sid];
          n++;
          const tick = !!S.ticks[sid];
          return `<li class="fw-step fw-step--${st.side}${tick ? ' is-ticked' : ''}" id="fw-li-${sid}" data-step="${sid}">
            <div class="fw-step-head">
              <span class="fw-side fw-side--${st.side}"><span aria-hidden="true">${sideIcon(st.side)}</span> ${sideWord(st.side)}</span>
              <span class="fw-step-t">${esc(st.title)}</span>
              ${st.opt ? `<span class="fw-opt">Optional — ${esc(st.opt)}</span>` : ''}
            </div>
            <p>${st.do}</p>
            ${st.watch ? `<p class="fw-cap-watch"><span aria-hidden="true">👀</span> <strong>Look for:</strong> ${esc(st.watch)}</p>` : ''}
            ${st.warn ? `<p class="fw-cap-warn" role="note"><span aria-hidden="true">⚠️</span> ${esc(st.warn)}</p>` : ''}
            ${st.tip ? `<p class="fw-cap-tip"><span aria-hidden="true">💡</span> ${esc(st.tip)}</p>` : ''}
            <div class="fw-step-act">
              <button type="button" class="btn fw-sm" onclick="A2Firmware.show('${sid}')">▶ Show me</button>
              <label class="fw-tick"><input type="checkbox"${tick ? ' checked' : ''} onchange="A2Firmware.tick('${sid}', this.checked)"> Done</label>
            </div>
          </li>`;
        }).join('')}</ol></div>`).join('')}
      <p class="fw-aside">The tick boxes are kept only while this tab is open. ${esc(MENU_NOTE)}</p>
      <p class="button-group"><button type="button" class="btn" onclick="A2Firmware.exportTxt()">⤓ Save these steps as a checklist — text</button></p>`;
  }

  // ── 5 · The LEDs ───────────────────────────────────────────────────────────

  const LED_MEANS = [
    ['D1', 'The file\'s header checks out: header verification started, and the product ID, offset, entry/destination address, firmware length, polynomial, CRC and signature length all matched.', 'Nothing lights: the A2 did not take the file. The stick is not being read, the file is not there, or it is the wrong one. Re-seat the stick and start again; then try the stick formatted, or another stick.'],
    ['D2', 'OK — the signature is valid.', 'Stopped at D1: the header matched but the signature did not. A damaged or changed file: copy it to the stick again, fresh out of the zip, and do not rename it.'],
    ['D3', 'Firmware updating … to 100%.', 'Stopped at D2: it began but did not finish writing. Do not pull anything during a bootloader; for the other parts, re-seat the stick and try again.'],
    ['D4', 'The firmware update has been successful.', 'Stopped at D3: the write did not complete. Try again; if it stops there again, call ELPRO.'],
  ];
  function ledsHtml() {
    return `<p>While a part loads, the A2 uses its four I/O LEDs as a progress bar. Each one that lights says a check passed; where they stop says what went wrong.
        (The rest of the time they show the digital inputs, while the menu is active.)</p>
      <div class="fw-ledrow" aria-hidden="true">${LED_MEANS.map(([d], i) => `<span class="fw-ledchip" data-n="${i}"><span class="fw-ledchip-dot"></span>${d}</span>`).join('')}</div>
      <div class="table-wrap"><table class="fw-table">
        <caption>The progress LEDs (ELPRO's table), and what it means if they stop before D4</caption>
        <thead><tr><th scope="col">LED</th><th scope="col">Lit means</th><th scope="col">If it stops short of this one</th></tr></thead>
        <tbody>${LED_MEANS.map(([d, m, s]) => `<tr><th scope="row">${d}</th><td>${esc(m)}</td><td>${esc(s)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="fw-aside">The first two columns are ELPRO's; the third is what follows from them — a guide, not ELPRO's words.</p>`;
  }

  // ── 6 · When it goes wrong ─────────────────────────────────────────────────

  const TROUBLE = [
    ['The LEDs will not all come on (the host)', 'Take the stick out, plug it back in and start the host again from RESET. Still no good: format the stick FAT32 with Quick Format off, copy the files again, or try another stick.'],
    ['Holding TEST does nothing', 'TEST has to be pressed within a second of RESET. Tap RESET again and go straight to TEST, and keep holding until D1 lights.'],
    ['The terminal stopped answering', 'The A2 restarts after the host loads, and the laptop\'s port can go with it: close the terminal\'s connection and open it again, and log in. Check the COM port in Device Manager (USB Serial Device), and the settings: 9600, 8N1, no flow control.'],
    ['No menu at all on the laptop', 'Press Enter. The first time, Windows takes a minute or two to install the A2\'s driver; then pick the USB Serial Device\'s COM port, not another one.'],
    ['TEST held a long while and D1 never lit', 'Let go. RESET then TEST held for 5 seconds is also the factory default, which wipes the I/O setup, timings and passwords. Check the stick is in and readable, and start again.'],
    ['You want to know why it stopped', 'Watch it on the SERIAL DB9 instead: during an update the A2 writes what it is doing, and any error, to its RS-232 port at 9600 8N1 — over USB it only lights the LEDs.'],
    ['A radio part is slow, or not answering', 'It should take no more than a minute. Press RESET, take the stick out and put it back, and try again. Then format the stick, and call ELPRO.'],
    ['ERROR: Could not read parameter value, Old version - Update Recommended', 'Expected after the bootloader while the radio is still old. It goes away once the radio is done.'],
    ['FI:2044, not FI:6015', 'Right for a unit set for the ALERT2 report format. Not a failure.'],
    ['Radio Firmware V1.2 or lower', 'This procedure cannot update it. Contact ELPRO Technologies for the options.'],
    ['The power went, or the stick came out, during the bootloader', 'Do not keep trying blind: call ELPRO Technical Support. This is the one interruption that can leave the A2 unable to start.'],
    ['An Iridium satellite A2, after the upgrade', 'Check its Epoch setting: ELPRO says re-applying firmware the unit already has, or a factory default, puts it back to its original setting. So load only the parts the unit needs.'],
  ];
  function troubleHtml() {
    return `<div class="table-wrap"><table class="fw-table">
      <caption>Symptoms, and what to do</caption>
      <thead><tr><th scope="col">What you see</th><th scope="col">What to do</th></tr></thead>
      <tbody>${TROUBLE.map(([a, b]) => `<tr><th scope="row">${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  // ── 7 · Sources ────────────────────────────────────────────────────────────

  function sourcesHtml() {
    return `<ul class="fw-src">
        <li>ELPRO Technologies, <cite>ERT-A2 Complete Firmware Upgrade</cite>, Release G (24-4-26, "Radio firmware update for Repeater TX Lockup") — the procedure this page re-tells. Ask ELPRO Technical Support for the current issue.</li>
        <li>ELPRO Technologies, <a href="${ZIP}" target="_blank" rel="noopener">ERT-A2 USB firmware, Release G</a> (the zip of the four files).</li>
        <li>ELPRO Technologies, <a href="${MANUAL}" target="_blank" rel="noopener">ERT-A2 user manual</a> (Sept 2025) — the terminal's settings and login (p. 18),
          the Main Menu (p. 19), the Unit Diagnostic menu and the version screen (p. 31), the upgrade (pp. 32–33) and the factory default (p. 33).</li>
        <li>ELPRO Technologies, <a href="https://elprotech.com/wp-content/uploads/2024/07/ELPRO-inst_ERTA2-CBL_1.5.pdf" target="_blank" rel="noopener">ERT-A2 installation guide</a>
          (v1.5) — what RESET, USB B, USB A and TEST are for.</li>
        <li>ELPRO Technologies, <a href="https://elprotech.com/wp-content/uploads/2021/07/UserManual_ERT-A2_v1.1-2.pdf" target="_blank" rel="noopener">ERT-A2 ALERT2 configuration manual</a>
          (rev. 1.0, 2021) — USB 2.0 sticks, the host's few minutes, and the RS-232 progress text (p. 43).</li>
        <li>ELPRO Technologies, <a href="https://elprotech.com/wp-content/uploads/2026/10/ERT-A2-ERT-A2_Iridium_Satellite-Epoch_Instruction_1.0-.pdf" target="_blank" rel="noopener">ERT-A2 Iridium satellite Epoch instruction</a>
          (1.0) — the Epoch setting put back by re-applied firmware.</li>
        <li>ELPRO's <a href="https://elprotech.com/resourcehub-category/firmware/" target="_blank" rel="noopener">firmware downloads</a>, for a release newer than G.</li>
      </ul>
      <p class="fw-aside">Rewritten for Flood-Net: ELPRO's steps split one action to a step, put in the order they are done, and drawn — the board and the screens
        after the ones in ELPRO's sheet, not photographs of them. ELPRO's sheet and ELPRO Technical Support are the authority; where this page and the unit
        disagree, believe the unit. ELPRO does not endorse Flood-Net.</p>
      <p class="fw-aside">The 🪛 <button type="button" class="btn-link" onclick="A2Firmware.tab('pinouts')">Pinouts</button> tab has the A2's connectors pin by pin; the
        📟 <button type="button" class="btn-link" onclick="A2Firmware.tab('swr')">SWR Meter</button> tab, its TEST button and the meters that read it.</p>`;
  }

  // ── The page ───────────────────────────────────────────────────────────────

  const TOC = [
    ['fw-walk', '1 · Walkthrough'], ['fw-prep', '2 · Before you start'], ['fw-ver', '3 · Versions, and what it needs'],
    ['fw-list', '4 · Every step'], ['fw-leds', '5 · The LEDs'], ['fw-trouble', '6 · When it goes wrong'], ['fw-src', '7 · Sources'],
  ];
  const tocHtml = () => `<nav class="fw-toc" aria-label="On this page">${TOC.map(([id, t]) =>
    `<button type="button" class="fw-toc-btn" onclick="A2Firmware.go('${id}')">${t}</button>`).join('')}</nav>`;
  function head(id, n, icon, title, short) {
    return `<h3 id="${id}-h" tabindex="-1"><span aria-hidden="true">${icon}</span> ${n} · ${esc(title)}</h3>
      ${short ? `<p class="fw-short">${short}</p>` : ''}`;
  }
  const sec = (id, html) => `<section class="panel fw-sec" id="${id}" aria-labelledby="${id}-h">${html}</section>`;

  function factsHtml() {
    const facts = [
      ['🧠', '4 parts', 'host, bootloader, radio, function image', 'In that order. The host first: it lets the USB take more than one file.'],
      ['✋', 'RESET + TEST', 'the host, on the unit', 'Tap RESET, and within a second press and hold TEST until D1 lights — not 5 s: that is a factory default.'],
      ['⌨️', 'the menu', 'everything after the host', 'Unit Diagnostic → Update Device Firmware, over the USB B lead.'],
      ['💡', 'D1 → D4', 'the progress bar', 'All four on: that part is in.'],
      ['⏱️', '≤ 1 min', 'a radio part', 'Longer, or not answering: RESET, re-seat the stick, try again.'],
      ['⛔', 'V1.2', 'radio at or below', 'Cannot be updated this way. Contact ELPRO.'],
    ];
    return `<ul class="fw-facts" aria-label="The upgrade at a glance">${facts.map(([i, big, what, why]) => `
      <li class="fw-fact"><span class="fw-fact-icon" aria-hidden="true">${i}</span>
        <span class="fw-fact-big">${big}</span><span class="fw-fact-what">${what}</span>
        <span class="fw-fact-why">${why}</span></li>`).join('')}</ul>`;
  }

  function render() {
    const saved = readLS();
    if (saved && PATHS[saved.path] && !live) S.path = saved.path;
    if (S.path === 'mine' && !S.mine) S.path = 'all';
    if (!live) { S.playing = !still(); S.fresh = true; }
    S.i = Math.min(S.i, stepsOf().length - 1);
    return `
    <div class="page fw-page" id="fw-page" style="--page-max:1240px">
      <div class="fw-hero">
        <h2 class="fw-title" id="fw-h"><span aria-hidden="true">💾</span> Upgrading an ERT-A2's firmware</h2>
        <p class="fw-lede">The four parts of an ELPRO ERT-A2's firmware — the host, its bootloader, the radio's application and the radio's function image —
          loaded from a USB stick, from ELPRO's Release G procedure. Pick the whole upgrade or one part, and watch it done: the unit on the left,
          the laptop on the right, and a ring round whichever one your hands are on.</p>
        ${factsHtml()}
        ${tocHtml()}
      </div>
      ${sec('fw-walk', `${head('fw-walk', 1, '▶️', 'The walkthrough', 'Pick what to do; ▶ plays it, ◀ and ▶ step through it, and the dots jump to any step.')}${playerHtml()}`)}
      ${sec('fw-prep', `${head('fw-prep', 2, '🧰', 'Before you start', 'The kit, the files, and the stick — mostly done at the desk, before the trip.')}${prepHtml()}`)}
      ${sec('fw-ver', `${head('fw-ver', 3, '🔎', 'Reading the versions, and what the unit needs', '')}${screensHtml()}`)}
      ${sec('fw-list', `${head('fw-list', 4, '📋', 'Every step, written out', '')}${listHtml()}`)}
      ${sec('fw-leds', `${head('fw-leds', 5, '💡', 'What D1 to D4 are saying', '')}${ledsHtml()}`)}
      ${sec('fw-trouble', `${head('fw-trouble', 6, '🧯', 'When it goes wrong', '')}${troubleHtml()}`)}
      ${sec('fw-src', `${head('fw-src', 7, '📚', 'Where this came from', '')}${sourcesHtml()}`)}
    </div>`;
  }

  // ── Running it ─────────────────────────────────────────────────────────────

  // The time a still picture shows: the step's telling moment.
  const stillAt = st => (st.still != null ? st.still : st.dur);

  let lastPc = '';
  function paint() {
    if (!live) return;
    const f = frame();
    paintUnit(f.unit, f.step);
    const html = pcHtml(f.pc);
    if (html !== lastPc) { const el = $('fw-pc'); if (el) el.innerHTML = html; lastPc = html; }
    const seek = $('fw-seek');
    if (seek && document.activeElement !== seek) seek.value = String(Math.round(1000 * clamp(S.t / f.step.dur)));
  }

  // Everything that says which step it is: the rings, the caption, the dots.
  function paintStep(say) {
    const ids = stepsOf();
    const st = STEPS[ids[S.i]];
    const pl = $('fw-player');
    if (pl) pl.dataset.side = st.side;
    for (const side of ['unit', 'pc']) {
      const pane = $(`fw-pane-${side}`);
      if (!pane) continue;
      pane.classList.toggle('is-active', st.side === side);
      const now = pane.querySelector('.fw-now');
      if (now) now.textContent = st.side === side ? ' — now' : '';
    }
    const cap = $('fw-cap');
    if (cap) cap.innerHTML = captionHtml();
    const dots = $('fw-dots-wrap');
    if (dots) {
      const had = dots.contains(document.activeElement) && document.activeElement.classList.contains('fw-dot');
      dots.innerHTML = dotsHtml();
      if (had) { const on = dots.querySelector('.fw-dot.is-on'); if (on) on.focus({ preventScroll: true }); }
    }
    const back = $('fw-back'), next = $('fw-next');
    if (back) back.disabled = S.i === 0;
    if (next) next.disabled = S.i >= ids.length - 1;
    document.querySelectorAll('.fw-step.is-now').forEach(el => el.classList.remove('is-now'));
    const li = $(`fw-li-${ids[S.i]}`);
    if (li) li.classList.add('is-now');
    if (say) announce(`Step ${S.i + 1} of ${ids.length}: ${st.title}. ${sideWord(st.side)}.`);
  }

  function paintPlay() {
    const b = $('fw-play');
    if (b) { b.setAttribute('aria-pressed', String(S.playing)); b.textContent = S.playing ? '⏸ Pause' : '▶ Play'; }
  }

  function loop(ts) {
    if (!live) return;
    live.raf = 0;
    const dt = live.last ? Math.min(0.1, (ts - live.last) / 1000) : 0;
    live.last = ts;
    const st = STEPS[stepsOf()[S.i]];
    S.t += dt * S.speed;
    if (S.t >= st.dur + PAUSE_AFTER) {
      if (S.i < stepsOf().length - 1) { S.i++; S.t = 0; paintStep(false); }
      else { S.t = st.dur; S.playing = false; paintPlay(); announce('That is the end of this path.'); }
    }
    paint();
    schedule();
  }
  function schedule() {
    if (!live) return;
    const want = S.playing && live.vis && !!$('fw-page');
    if (want && !live.raf) live.raf = requestAnimationFrame(loop);
    if (!want) { if (live.raf) cancelAnimationFrame(live.raf); live.raf = 0; live.last = 0; }
  }

  function unwire() {
    if (!live) return;
    if (live.raf) cancelAnimationFrame(live.raf);
    live.io && live.io.disconnect();
    live = null;
    lastPc = '';
  }

  function init() {
    unwire();
    registerTabTeardown('A2Firmware', unwire);
    if (!$('fw-page')) return;
    live = { raf: 0, last: 0, vis: true, io: null };
    if (!S.playing && S.fresh) S.t = stillAt(STEPS[stepsOf()[S.i]]);
    paintStep(false);
    paint();
    const stage = $('fw-stage');
    if (stage && typeof IntersectionObserver !== 'undefined') {
      live.io = new IntersectionObserver(es => { for (const e of es) live.vis = e.isIntersecting; schedule(); });
      live.io.observe(stage);
    }
    schedule();
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  // To step i. Playing, it runs from the start; paused, it shows the step's
  // telling moment, and ▶ then runs it from the start.
  function step(i, say = true) {
    const n = stepsOf().length;
    S.i = Math.max(0, Math.min(n - 1, Number(i) || 0));
    if (S.playing) { S.t = 0; S.fresh = false; }
    else { S.t = stillAt(STEPS[stepsOf()[S.i]]); S.fresh = true; }
    if (live) live.last = 0;
    paintStep(say);
    paint();
  }
  const next = () => step(S.i + 1);
  const back = () => step(S.i - 1);

  function play() {
    S.playing = !S.playing;
    if (S.playing) {
      const st = STEPS[stepsOf()[S.i]];
      if (S.fresh || S.t >= st.dur) {
        // At the end of the path, ▶ starts it again.
        if (S.t >= st.dur && !S.fresh && S.i >= stepsOf().length - 1) { S.i = 0; paintStep(true); }
        S.t = 0;
      }
      S.fresh = false;
    }
    paintPlay();
    if (live) { live.last = 0; paint(); schedule(); }
  }
  function replay() {
    S.t = 0; S.fresh = false;
    if (!S.playing) { S.playing = true; paintPlay(); }
    if (live) { live.last = 0; paint(); schedule(); }
  }
  // Scrub within the step: the picture follows, and the walkthrough pauses
  // there.
  function seek(frac) {
    const st = STEPS[stepsOf()[S.i]];
    S.t = clamp(Number(frac) || 0) * st.dur;
    if (S.playing) { S.playing = false; paintPlay(); }
    S.fresh = false;
    paint();
    schedule();
  }
  function speed(v) {
    const n = Number(v);
    if (![0.5, 1, 1.5, 2].includes(n)) return;
    S.speed = n;
  }

  function path(id, scroll) {
    if (id !== 'mine' && !PATHS[id]) return;
    if (id === 'mine' && !S.mine) return;
    S.path = id;
    writeLS();
    S.i = 0;
    S.playing = !still();
    S.t = S.playing ? 0 : stillAt(STEPS[stepsOf()[0]]);
    S.fresh = !S.playing;
    document.querySelectorAll('.fw-path').forEach(b => {
      const on = b.getAttribute('onclick').includes(`'${id}'`);
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    paintPlay();
    paintStep(false);
    paint();
    schedule();
    announce(`${pathDef().label}: ${stepsOf().length} steps.`);
    if (scroll) go('fw-walk');
  }

  // A path of just the parts the checker found this unit needs.
  function mine() {
    const a = advise(parse(S.before));
    if (a.stop || !a.parts.length) return;
    const steps = [...CHECK];
    for (const k of a.parts) steps.push(...SEQ[k]);
    steps.push('done');
    const start = a.parts.includes('host') ? 'all' : a.parts[0] === 'boot' ? 'boot' : a.parts[0] === 'radio' ? 'radio' : 'fi';
    S.mine = { parts: a.parts, steps, start, about: a.parts.map(k => PARTS[k].short).join(' → ') };
    const wrap = document.querySelector('.fw-paths');
    if (wrap) wrap.outerHTML = pathsHtml();
    path('mine', true);
  }

  // Open the walkthrough on one step: on the path picked if it has it, else on
  // the whole upgrade.
  function show(sid) {
    if (!STEPS[sid]) return;
    if (!stepsOf().includes(sid)) path('all');
    const i = stepsOf().indexOf(sid);
    S.playing = true;
    paintPlay();
    step(i);
    schedule();
    go('fw-walk');
  }

  function key(e) {
    if (!e || e.target !== e.currentTarget) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    else if (e.key === ' ' || e.key === 'k') { e.preventDefault(); play(); }
    else if (e.key === 'Home') { e.preventDefault(); step(0); }
    else if (e.key === 'End') { e.preventDefault(); step(stepsOf().length - 1); }
  }

  function check(which, text) {
    if (which !== 'before' && which !== 'after') return;
    S[which] = String(text == null ? '' : text);
    const v = $('fw-verdict');
    if (v) v.innerHTML = verdictHtml();
  }
  function example(k) {
    const e = EXAMPLES[k];
    if (!e) return;
    S.before = e.text;
    const ta = $('fw-before');
    if (ta) ta.value = e.text;
    check('before', e.text);
  }
  function tick(sid, on) {
    if (!STEPS[sid]) return;
    if (on) S.ticks[sid] = true; else delete S.ticks[sid];
    const li = $(`fw-li-${sid}`);
    if (li) li.classList.toggle('is-ticked', !!on);
  }

  function go(id) {
    const s = $(id);
    if (!s) return;
    const h = s.querySelector('h3');
    s.scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'start' });
    if (h) h.focus({ preventScroll: true });
  }
  function tab(t) { if (typeof switchTab === 'function') switchTab(t); }

  // ── The checklist, as text ─────────────────────────────────────────────────

  const plain = h => String(h).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  function checklistText() {
    const p = pathDef();
    const out = [
      `ERT-A2 firmware upgrade — ${p.label}`,
      'From ELPRO Technologies\' procedure, Release G (24-4-26). Flood-Net checklist.',
      '',
    ];
    if (S.before.trim()) {
      const a = advise(parse(S.before));
      out.push('Before:', ...S.before.trim().split(/\r?\n/).map(l => `  ${l.trim()}`));
      if (!a.empty) for (const k of ['host', 'boot', 'radio', 'fi']) out.push(`  ${PARTS[k].name}: ${a[k].words}`);
      out.push('');
    }
    let last = '', n = 0;
    for (const sid of p.steps) {
      const st = STEPS[sid];
      if (st.part !== last) { out.push(`${PARTS[st.part].name.toUpperCase()}`); last = st.part; }
      n++;
      out.push(`[${S.ticks[sid] ? 'x' : ' '}] ${n}. ${st.title} (${sideWord(st.side).toLowerCase()})${st.opt ? ' — optional' : ''}`);
      out.push(`      ${plain(st.do)}`);
      if (st.watch) out.push(`      Look for: ${plain(st.watch)}`);
      if (st.warn) out.push(`      WARNING: ${plain(st.warn)}`);
      if (st.tip) out.push(`      Tip: ${plain(st.tip)}`);
      if (st.part !== (STEPS[p.steps[p.steps.indexOf(sid) + 1]] || {}).part) out.push('');
    }
    if (S.after.trim()) out.push('After:', ...S.after.trim().split(/\r?\n/).map(l => `  ${l.trim()}`), '');
    out.push('Release G\'s versions: host v1.7 : 10366; bootloader v1.3 - 9967; radio application v1.4, build 10848; function image FI:6015 (FI:2044 on ALERT2 report format).');
    out.push('Never pull the stick or the power while a part is loading — the bootloader above all.');
    return out.join('\n') + '\n';
  }
  function exportTxt() {
    if (typeof dlText === 'function') dlText('erta2-firmware-checklist.txt', checklistText(), 'text/plain');
    if (typeof announce === 'function') announce('Saved the checklist as floodnet-erta2-firmware-checklist.txt.');
  }

  function state() {
    return { path: S.path, i: S.i, t: S.t, playing: S.playing, speed: S.speed, fresh: S.fresh, steps: stepsOf().slice(),
      step: stepsOf()[S.i], side: STEPS[stepsOf()[S.i]].side, mine: S.mine && { ...S.mine }, running: !!(live && live.raf) };
  }

  return {
    render, init, path, mine, step, show, next, back, play, replay, seek, speed, go, key, tab, tick,
    check, example, parse, advise, exportTxt, checklistText, frame, state, PATHS, STEPS, PARTS, TARGET,
  };
})();

if (typeof window !== 'undefined') window.A2Firmware = A2Firmware;
