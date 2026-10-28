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
    set:   { name: 'Settings', short: 'Settings', icon: '⚙️' },
  };

  // ── What the laptop shows ──────────────────────────────────────────────────
  // The terminal is A2Terminal (a2-terminal.js): the unit's own menus, from
  // PuTTY logs of real ERT-A2s, driven by the keys each step presses. So the
  // walkthrough, the demos and the interactive terminal print one set of
  // screens, the real one.
  const MENU_NOTE = 'The menus, their letters and their messages are the unit\'s own, from PuTTY logs of real ERT-A2s on host v1.7. The dates, station addresses and build numbers on the simulated screens are illustrations.';

  // Where each path starts the unit's versions (A2Terminal.FW names them).
  const START = {
    all:   { host: 'old', boot: 'old', radio: 'old', fi: '' },
    host:  { host: 'old', boot: 'old', radio: 'old', fi: '' },
    hostmenu: { host: 'new', boot: 'new', radio: 'mid', fi: '6015' },
    check: { host: 'old', boot: 'old', radio: 'old', fi: '' },
    boot:  { host: 'new', boot: 'old', radio: 'old', fi: '' },
    radio: { host: 'new', boot: 'new', radio: 'mid', fi: '6015' },
    fi:    { host: 'new', boot: 'new', radio: 'new', fi: '6013' },
    usb:   { host: 'old', boot: 'old', radio: 'old', fi: '' },
    set:   { host: 'new', boot: 'new', radio: 'mid', fi: '6015' },
  };

  // ── The steps ──────────────────────────────────────────────────────────────
  //
  // side: where the hands are — 'unit' (the A2 itself) or 'pc' (the laptop).
  // dur: seconds at 1×. still: the telling moment a still picture shows.
  // unit: what happens to the unit, as timed events (applyUnit). pc: the
  // laptop's window — a folder, the format dialog, or the terminal and the
  // keys pressed into it (keys). eng: what the unit does that the terminal
  // hears of (a restart, a reconnect). fw: the version this step leaves a part
  // at. do/watch/warn/tip: the words, the same in the walkthrough and the
  // written list.

  const tw = (k, at, dur, to) => ({ e: 'tw', k, at, dur, to });
  const lights = (at, dur, from = 0) => ({ e: 'leds', at, dur, from });
  const led = (i, at) => ({ e: 'led', i, at });
  const dark = at => ({ e: 'off', at });
  const tap = (k, at, dur = 0.45) => ({ e: 'tap', k, at, dur });
  const hold = (at, dur) => ({ e: 'hold', at, dur });
  const blink = (at, dur) => ({ e: 'blink', at, dur });
  const reboot = at => ({ e: 'reboot', at, dur: 1.6 });

  // Keys for the terminal: one at `at`; a string typed a key at a time; a
  // password, shown as stars; and what the unit or PuTTY does meanwhile.
  const K = (at, key) => ({ at, key });
  const W = (at, s, gap = 0.09) => [...String(s)].map((ch, i) => ({ at: at + i * gap, key: ch }));
  // A key n times — Backspace over the value a prompt already holds, say.
  const N = (at, key, n, gap = 0.07) => Array.from({ length: n }, (_, i) => ({ at: at + i * gap, key }));
  const PW = at => W(at, 'password', 0.07).map(k => ({ ...k, mask: true }));
  const O = (at, op, text = '') => ({ at, op, text });
  const login = at => [K(at, 'a'), ...PW(at + 0.5), K(at + 1.2, 'Enter')];
  const TT = 'COM16 - PuTTY';

  const FW_STEPS = {
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
      part: 'check', side: 'pc', dur: 5.5, still: 5.5,
      title: 'Open the terminal at 9600 8N1, and log in',
      do: `Windows sees the A2 as a <strong>USB Serial Device (COM<em>n</em>)</strong> — Device Manager lists it under Ports (COM &amp; LPT); the first time,
        give it a minute or two to install its driver. In PuTTY pick <strong>Serial</strong>, put that port in <strong>Serial line</strong> and
        <strong>9600</strong> in <strong>Speed</strong>; under <strong>Connection → Serial</strong>, <strong>8 data bits, 1 stop bit, parity None,
        flow control None</strong> (PuTTY's own default is XON/XOFF). <strong>Open</strong> it and press <strong>Enter</strong>. At <strong>User Type</strong> press <strong>a</strong> for Engineer and give
        your network's password: the Technician login is for viewing and basic diagnostics.`,
      watch: '"Login Successful!", then the date, the station\'s address, the host\'s version and the Main Menu.',
      pc: { win: 'term', title: TT, keys: [
        O(0.3, 'note', 'PuTTY: Serial, COM16, 9600, 8 N 1, flow control None'),
        K(1.0, 'Enter'),
        ...login(1.7),
      ] },
    },
    ver: {
      part: 'check', side: 'pc', dur: 5, still: 5,
      title: 'Unit Diagnostic → Show Firmware Version: note the three lines',
      do: `Press <strong>d</strong> for <strong>Unit Diagnostic</strong>, then <strong>f</strong> for <strong>Show Firmware Version</strong>.
        Write down all three lines — <span class="fw-c fw-c--host">Firmware</span> (the host),
        <span class="fw-c fw-c--boot">Host Bootloader</span> and <span class="fw-c fw-c--radio">Radio Firmware</span> — so that at the end
        you can tell the upgrade took. The checker below reads them, and says which parts this unit needs.`,
      warn: 'Radio Firmware V1.2 or lower? Stop here: this procedure cannot update that radio. Contact ELPRO Technologies for the options.',
      pc: { win: 'term', title: TT, keys: [K(0.8, 'd'), K(2.4, 'f')] },
    },
    save: {
      part: 'check', side: 'pc', dur: 5, still: 5, opt: 'Flood-Net\'s advice: ELPRO\'s documents do not say whether the configuration survives an upgrade',
      title: 'Keep a copy of the configuration',
      do: `Turn on PuTTY's log to a file — right-click its title bar, <strong>Change Settings…</strong>, <strong>Session → Logging</strong>,
        <strong>All session output</strong>, a file name, <strong>Apply</strong> — go back to the
        Main Menu (a key, then Enter) and press <strong>g</strong> for <strong>Show/Save Configuration</strong>, which prints the whole configuration.
        Then the unit can be put back as it was, whatever the upgrade does to it.`,
      pc: { win: 'term', title: TT, keys: [
        O(0.2, 'note', 'PuTTY: logging all session output to A2-config-before.log'),
        K(0.8, 'Enter'), K(1.5, 'Enter'), K(2.4, 'g'),
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
      tip: 'On a unit whose host is already v1.7, the host can be loaded from the menu instead — Update Main Firmware (ERTA2_) — with no RESET or TEST: the "Host, from the menu" walkthrough.',
      unit: [tw('drv', 0.2, 0.9, 1), tap('drv', 1.2, 0.4), tw('drv', 1.65, 0.6, 0), tw('fin', 1.45, 0.55, 1), hold(2.0, 2.45), led(0, 4.45), tw('fin', 4.8, 0.7, 0)],
      eng: [O(1.3, 'reset')],
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
      part: 'host', side: 'pc', dur: 7.5, still: 7.5,
      title: 'Reconnect, log in, and check: host v1.7',
      do: `The A2 restarted, so PuTTY has lost its port — its title bar says <strong>(inactive)</strong>. Right-click the title bar and pick
        <strong>Restart Session</strong>, press <strong>Enter</strong> and log in.
        Then <strong>d</strong> Unit Diagnostic, <strong>f</strong> Show Firmware Version: the first line should now read <strong>v1.7</strong>
        (with Release G, <strong>: 10366</strong> at its end).`,
      pc: { win: 'term', title: TT, keys: [
        O(0.2, 'reconnect'), O(0.25, 'note', 'PuTTY: Restart Session — COM16 open again'),
        K(0.8, 'Enter'), ...login(1.5), K(4.2, 'd'), K(5.6, 'f'),
      ] },
    },

    // ── Host firmware, from the menu (a host already at v1.7) ──
    'm-in': {
      part: 'host', side: 'unit', dur: 2.8, still: 2.8,
      title: 'Plug the stick into the USB A socket',
      do: 'Plug the USB stick holding the files into the A2\'s <strong>USB A</strong> socket.',
      unit: [tw('stick', 0.4, 1.2, 1)],
    },
    'm-menu': {
      part: 'host', side: 'pc', dur: 6, still: 6,
      title: 'Update Device Firmware → b) Update Main Firmware, then y',
      do: `From Show Firmware Version press a key for the <strong>Unit Diagnostic</strong> menu, <strong>h</strong> for <strong>Update Device Firmware</strong>,
        <strong>b</strong> for <strong>Update Main Firmware (ERTA2_)</strong>, and <strong>y</strong> to continue. The unit says what to do next.`,
      watch: '"When all four DIO LEDs are on, remove the USB to restart the unit."',
      pc: { win: 'term', title: TT, keys: [K(0.4, 'Enter'), K(1.6, 'h'), K(2.9, 'b'), K(3.9, 'y')] },
    },
    'm-leds': {
      part: 'host', side: 'unit', dur: 6, still: 6, job: 'host',
      title: 'D1, D2, D3, D4 light in turn',
      do: 'The four DIO LEDs light one after another as the host firmware loads. Leave it alone until all four are on.',
      watch: 'All four LEDs on.',
      unit: [lights(0.4, 4.6)],
    },
    'm-out': {
      part: 'host', side: 'unit', dur: 4.5, still: 2.4, fw: { host: 'new' },
      title: 'All four on: pull the stick out',
      do: 'With all four on, take the stick out, as the unit said: it restarts on the new host firmware.',
      unit: [tw('stick', 0.5, 1.1, 0), reboot(1.8)],
      eng: [O(1.8, 'reset')],
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
      title: 'Update Device Firmware → a) Update Bootloader, then y',
      do: `Press a key for the <strong>Unit Diagnostic</strong> menu, <strong>h</strong> for <strong>Update Device Firmware</strong>, <strong>a</strong> for
        <strong>Update Bootloader (ERTA2-B)</strong>, and <strong>y</strong> to continue. The USB link goes off-line for about a minute.`,
      warn: 'From here until DIO4 lights, do not pull the stick or the power. Interrupting the bootloader can leave the A2 unable to start.',
      pc: { win: 'term', title: TT, keys: [K(0.4, 'Enter'), K(1.6, 'h'), K(2.9, 'a'), K(4.1, 'y')] },
    },
    'b-leds': {
      part: 'boot', side: 'unit', dur: 6.2, still: 6.2, fw: { boot: 'new' }, job: 'boot',
      title: 'D1 to D4 light in turn — wait for DIO4',
      do: 'D1, D2, D3 and D4 light one after another as the bootloader goes in; <strong>DIO4</strong> coming on says it is done. Touch nothing — not the stick, not the power — until then.',
      warn: 'Never interrupt the bootloader.',
      unit: [lights(0.4, 5)],
    },
    'b-ver': {
      part: 'boot', side: 'pc', dur: 5.5, still: 5.5,
      title: 'Reconnect, press a key, and check: bootloader v1.3',
      do: `Restart PuTTY's session — right-click its title bar, <strong>Restart Session</strong> — and press a key: the A2 comes back at the <strong>Unit Diagnostic</strong> menu. <strong>f</strong> Show Firmware Version:
        <strong>Host Bootloader</strong> should read <strong>v1.3 - 9967</strong>. On a unit whose radio is still old, an
        <strong>ERROR: Could not read parameter value</strong> above the radio's line and <strong>Old version - Update Recommended</strong> under it
        are expected — they go when the radio is done.`,
      pc: { win: 'term', title: TT, keys: [
        O(0.2, 'reconnect'), O(0.25, 'note', 'PuTTY: Restart Session — COM16 open again'), K(0.9, 'Enter'), K(2.3, 'f'),
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
      title: 'Update Device Firmware → c) Load Firmware to Radio',
      do: `Press a key for the <strong>Unit Diagnostic</strong> menu, <strong>h</strong> for <strong>Update Device Firmware</strong>, and <strong>c</strong> for
        <strong>Load Firmware to Radio (ERTA2-R_app)</strong>. It does not ask: the USB link goes off-line straight away.`,
      pc: { win: 'term', title: TT, keys: [K(0.4, 'Enter'), K(1.6, 'h'), K(2.9, 'c')] },
    },
    'r-leds': {
      part: 'radio', side: 'unit', dur: 7, still: 6.3, job: 'radio',
      title: 'The stick\'s light flashes; D1 to D4 light in turn',
      do: 'The USB stick\'s own light flashes (if it is an ELPRO stick), and D1, D2, D3 and D4 light one after another as the radio\'s firmware loads. <strong>DIO4</strong> says it is done.',
      watch: 'It should take no more than a minute.',
      tip: 'Slow, or not answering? Press RESET, take the stick out and put it back, and try again. Still no good: format the stick (Get the USB stick ready), and call ELPRO.',
      unit: [blink(0.2, 5.8), lights(0.6, 5)],
    },
    'r-back': {
      part: 'radio', side: 'pc', dur: 5, still: 5, fw: { radio: 'new' },
      title: 'DIO4 on: reconnect, press a key, log in',
      do: 'Restart PuTTY\'s session (right-click its title bar, <strong>Restart Session</strong>) and press a key: the A2 starts again at the <strong>User Type</strong> login. Log in as Engineer.',
      tip: 'An older host instead prints "Firmware Loaded to Radio … Activating Radio Firmware … applying …" (ELPRO\'s sheet): press Enter a few times to step through it.',
      pc: { win: 'term', title: TT, keys: [
        O(0.2, 'reconnect'), O(0.25, 'note', 'PuTTY: Restart Session — COM16 open again'), K(0.9, 'Enter'), ...login(1.6),
      ] },
    },
    'r-ver': {
      part: 'radio', side: 'pc', dur: 4.5, still: 4.5,
      title: 'Check: the radio line now ends with FI:',
      do: `<strong>d</strong> Unit Diagnostic, <strong>f</strong> Show Firmware Version. The radio line now reads <strong>v1.4</strong> with its build in brackets, and ends with an
        <span class="fw-c fw-c--fi">FI:</span> number: the version of the radio's <em>function image</em>, which is next.`,
      pc: { win: 'term', title: TT, keys: [K(0.6, 'd'), K(2.0, 'f')] },
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
      title: 'Update Device Firmware → e) Load V23 Image to radio',
      do: `Press a key for the <strong>Unit Diagnostic</strong> menu, <strong>h</strong> for <strong>Update Device Firmware</strong>, and <strong>e</strong> for
        <strong>Load V23 Image to radio (ERTA2-R_fi6)</strong> — Release G's <code>…fi6015…</code> file. Leave <strong>d) Load FSK Image to radio (ERTA2-R_fi2)</strong>
        alone: Release G has no fi2 file.`,
      pc: { win: 'term', title: TT, keys: [K(0.4, 'Enter'), K(1.6, 'h'), K(2.9, 'e')] },
    },
    'f-leds': {
      part: 'fi', side: 'unit', dur: 6.4, still: 6, job: 'fi',
      title: 'The stick\'s light flashes; D1 to D4 light in turn',
      do: 'Again the stick\'s light flashes and D1 to D4 light one after another, as the function image goes in. <strong>DIO4</strong> says it is done.',
      watch: 'All four LEDs on.',
      unit: [blink(0.2, 5.4), lights(0.5, 4.8)],
    },
    'f-back': {
      part: 'fi', side: 'pc', dur: 5, still: 5, fw: { fi: '6015' },
      title: 'DIO4 on: reconnect, press a key, log in',
      do: 'Restart PuTTY\'s session, press a key and log in as Engineer again.',
      pc: { win: 'term', title: TT, keys: [
        O(0.2, 'reconnect'), O(0.25, 'note', 'PuTTY: Restart Session — COM16 open again'), K(0.9, 'Enter'), ...login(1.6),
      ] },
    },
    'f-out': {
      part: 'fi', side: 'unit', dur: 2.6, still: 2.6,
      title: 'Take the stick out',
      do: 'That was the last file: take the USB stick out.',
      unit: [dark(0.3), tw('stick', 0.5, 1.1, 0)],
    },
    'f-ver': {
      part: 'fi', side: 'pc', dur: 4.5, still: 4.5,
      title: 'Check: FI:6015 (FI:2044 on ALERT2 report format)',
      do: `<strong>d</strong> Unit Diagnostic, <strong>f</strong> Show Firmware Version once more. The function image's number should now be the latest,
        <span class="fw-c fw-c--fi">FI:6015</span> — the first number in its file's name, <code>ERT-A2-R_fi<strong>6015</strong>_v1-4_10252.wrap</code>.`,
      watch: 'A unit set for the ALERT2 report format shows FI:2044 instead. That is right for it, not a failure.',
      pc: { win: 'term', title: TT, keys: [K(0.6, 'd'), K(2.0, 'f')] },
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
    hostmenu: ['m-in', 'm-menu', 'm-leds', 'm-out', 'h-ver'],
    boot: ['b-in', 'b-menu', 'b-leds', 'b-ver'],
    radio: ['r-in', 'r-menu', 'r-leds', 'r-back', 'r-ver'],
    fi: ['f-in', 'f-menu', 'f-leds', 'f-back', 'f-out', 'f-ver'],
  };
  const FW_PATHS = {
    all:   { label: 'The whole upgrade', icon: '⭐', about: 'Stick, host, bootloader, radio and function image, in ELPRO\'s order.',
      steps: [...PREP, ...CHECK, 'save', ...SEQ.host, ...SEQ.boot, ...SEQ.radio, ...SEQ.fi, 'done'] },
    host:  { label: 'Host firmware', icon: '🧠', about: 'The USB stick, RESET and TEST — from any host. Always first: it is what lets the USB take more than one file.',
      steps: [...CHECK, 'save', ...SEQ.host, 'done'] },
    hostmenu: { label: 'Host, from the menu', icon: '📟', about: 'On a host already at v1.7: Update Main Firmware (ERTA2_), no RESET or TEST.',
      steps: [...CHECK, ...SEQ.hostmenu, 'done'] },
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

  // ── The settings demos ─────────────────────────────────────────────────────
  // Each logs in (cable, term), changes one thing from the menus, and saves —
  // the keys pressed into A2Terminal, so every screen is the unit's own.
  const SAVE = at => [K(at, 'Enter'), K(at + 1.2, 'g'), K(at + 3.6, 'y')];
  const SET_STEPS = {
    's-cfg': {
      part: 'set', side: 'pc', dur: 2.6, still: 2.6,
      title: 'a) Unit Config',
      do: 'From the Main Menu press <strong>a</strong> for <strong>Unit Config</strong>: the station itself — its address, its timings, how it logs.',
      pc: { win: 'term', title: TT, keys: [K(0.8, 'a')] },
    },
    's-addr': {
      part: 'set', side: 'pc', dur: 5.4, still: 3.2,
      title: 'a) Station Address: Backspace, type it, Enter',
      do: `<strong>a</strong> for <strong>Station Address</strong>. The prompt holds the address now, with the cursor after it: <strong>Backspace</strong> it away,
        type the new one and press <strong>Enter</strong> (Enter on its own keeps it). A letter in it is an <strong>Invalid Format!</strong>
        Back at the menu, the unit says <strong>Config NOT Saved</strong> — true until it is saved.`,
      pc: { win: 'term', title: TT, keys: [K(0.6, 'a'), ...N(1.4, 'Backspace', 4), ...W(2.0, '2205', 0.18), K(3.4, 'Enter')] },
    },
    's-times': {
      part: 'set', side: 'pc', dur: 7, still: 5.1,
      title: 'b) Update Time and c) Paralysis Time',
      do: `<strong>b</strong> for <strong>Update Time (min)</strong> — how often the station sends its readings even when nothing has changed — then
        <strong>c</strong> for <strong>Paralysis Time (sec)</strong>, how long it waits after sending before it may send again. Each prompt holds the
        time now: Backspace it, type the new one, Enter.`,
      pc: { win: 'term', title: TT, keys: [K(0.6, 'b'), ...N(1.3, 'Backspace', 3), ...W(1.7, '60', 0.2), K(2.4, 'Enter'),
        K(3.4, 'c'), ...N(4.1, 'Backspace', 2), ...W(4.4, '30', 0.2), K(5.3, 'Enter')] },
    },
    's-save': {
      part: 'set', side: 'pc', dur: 7, still: 3.9,
      title: 'Back to the Main Menu: g) Show/Save Configuration, then y',
      do: `Enter goes back up to the <strong>Main Menu</strong>. <strong>g</strong> prints the whole configuration — on a real terminal, scroll back up it to check the change is there — and,
        with something unsaved, asks <strong>Save Current Config? (y/n)</strong>. <strong>y</strong>: the unit says <strong>Configuration Saved!!</strong>
        and clears to the Main Menu, its <strong>Config NOT Saved</strong> line gone. (With nothing unsaved it just ends <strong>Press any key..</strong>)`,
      warn: 'Not saved, a change is lost when the console times out ("Discarding Unsaved Config Changes...").',
      pc: { win: 'term', title: TT, keys: SAVE(0.5) },
    },
    's-comm': {
      part: 'set', side: 'pc', dur: 2.6, still: 2.6,
      title: 'c) Communication',
      do: 'From the Main Menu press <strong>c</strong> for <strong>Communication</strong>: the radio. Each item shows its setting after <strong>=&gt;</strong>.',
      pc: { win: 'term', title: TT, keys: [K(0.8, 'c')] },
    },
    's-freq': {
      part: 'set', side: 'pc', dur: 7.6, still: 7.6,
      title: 'c) Tx Frequency and d) Rx Frequency, in MHz',
      do: `<strong>c</strong> for <strong>Tx Frequency MHz</strong>. The prompt holds the channel now, <code>151.500000</code>, the cursor at its end:
        <strong>←</strong> five times to put it after <code>151.5</code>, type <code>25</code> over the zeros, and Enter — <code>151.525000</code>.
        (Backspacing it all and typing <code>151.525</code> does the same.) Then <strong>d</strong> for <strong>Rx Frequency MHz</strong>.
        A frequency the radio will not take — 135 and 152 in the logs — or an emptied one is an <strong>Invalid value!</strong>`,
      pc: { win: 'term', title: TT, keys: [K(0.6, 'c'), ...N(1.3, 'ArrowLeft', 5, 0.12), ...W(2.1, '25', 0.25), K(2.9, 'Enter'),
        K(4.0, 'd'), ...N(4.7, 'ArrowLeft', 5, 0.12), ...W(5.5, '25', 0.25), K(6.3, 'Enter')] },
    },
    's-power': {
      part: 'set', side: 'pc', dur: 3.6, still: 3.6,
      title: 'e) Tx Power: 1 or 5 (watts)',
      do: '<strong>e</strong> for <strong>Tx Power</strong>, then one key, <strong>1</strong> or <strong>5</strong> — no Enter: it goes over the 5 of 5W and the menu comes straight back, showing 1W.',
      pc: { win: 'term', title: TT, keys: [K(0.6, 'e'), K(1.8, '1')] },
    },
    's-type': {
      part: 'set', side: 'pc', dur: 4.4, still: 4.4,
      title: 'b) Unit Type → c) Repeater Station',
      do: `<strong>b</strong> for <strong>Unit Type</strong>: a list with the current one starred. <strong>c</strong> for <strong>Repeater Station</strong> — and
        the menu grows: a repeater has a delay, address lists, an agency and a secondary link. The letters after Unit Type move to make room.`,
      pc: { win: 'term', title: TT, keys: [K(0.6, 'b'), K(2.0, 'c')] },
    },
    's-delay': {
      part: 'set', side: 'pc', dur: 4.8, still: 4.8,
      title: 'i) Repeater Delay (mSec)',
      do: `<strong>i</strong> for <strong>Repeater Delay (mSec)</strong>: how long the repeater waits, in milliseconds, before sending on what it heard.
        Backspace the delay there now, type the new one and Enter. Keep it under 65536: the unit takes a bigger number without a word and wraps it round.
        (⏳ Repeater Delays, in Flood-Net, works out what each repeater should wait.)`,
      pc: { win: 'term', title: TT, keys: [K(0.6, 'i'), ...N(1.3, 'Backspace', 3), ...W(1.7, '400', 0.2), K(2.6, 'Enter')] },
    },
    's-format': {
      part: 'set', side: 'pc', dur: 4.4, still: 4.4,
      title: 'f) Report Format → a) ALERT2 Format',
      do: `<strong>f</strong> for <strong>Report Format</strong> — <strong>ALERT2 Format</strong>, <strong>ALERT Binary</strong> or <strong>ALERT IFLOWS</strong> —
        and <strong>a</strong> for ALERT2.`,
      pc: { win: 'term', title: TT, keys: [K(0.6, 'f'), K(2.0, 'a')] },
    },
    's-fi': {
      part: 'set', side: 'pc', dur: 6, still: 6,
      title: 'Show Firmware Version: now FI:2044',
      do: `Up to the Main Menu (Enter), <strong>d</strong> Unit Diagnostic, <strong>f</strong> Show Firmware Version: on ALERT2 format the radio runs its FSK
        function image, and the line ends <span class="fw-c fw-c--fi">FI:2044</span> in place of FI:6015 — as ELPRO's sheet says.`,
      pc: { win: 'term', title: TT, keys: [K(0.5, 'Enter'), K(1.8, 'd'), K(3.2, 'f')] },
    },
    's-exit': {
      part: 'set', side: 'pc', dur: 6.5, still: 3.4,
      title: 'Or: i) Exit, and a) Save Changes',
      do: `Leaving with a change not saved, <strong>i) Exit</strong> asks first: <strong>a) Save Changes</strong>, <strong>b) Keep but don't save</strong>,
        <strong>c) Discard Changes</strong> or <strong>d) Cancel</strong>, at <strong>Option:</strong>. <strong>a</strong>, and it saves, exits and goes back to the login.`,
      pc: { win: 'term', title: TT, keys: [K(0.4, 'Enter'), K(1.2, 'Enter'), K(2.4, 'i'), K(4.0, 'a')] },
    },
    's-stick': {
      part: 'set', side: 'unit', dur: 2.8, still: 2.8,
      title: 'Plug a stick into USB A',
      do: 'Plug an empty USB stick into the <strong>USB A</strong> socket.',
      unit: [tw('stick', 0.4, 1.2, 1)],
    },
    's-log': {
      part: 'set', side: 'pc', dur: 5, still: 5,
      title: 'd) Unit Diagnostic → l) Upload Log to USB',
      do: `<strong>d</strong> for <strong>Unit Diagnostic</strong>, <strong>l</strong> for <strong>Upload Log to USB</strong>. The USB link goes off-line while the unit
        writes its log to the stick; the DIO LEDs show the progress.`,
      tip: 'Holding TEST for 5 seconds with a stick in does the same, without the laptop.',
      pc: { win: 'term', title: TT, keys: [K(0.6, 'd'), K(2.2, 'l')] },
    },
    's-logleds': {
      part: 'set', side: 'unit', dur: 6, still: 6,
      title: 'Watch the DIO LEDs until they are done',
      do: 'The LEDs light in turn as the log is written. When they are done, restart PuTTY\'s session and press a key, and take the stick out.',
      unit: [blink(0.2, 5), lights(0.4, 4.6)],
    },
    's-logback': {
      part: 'set', side: 'pc', dur: 3, still: 3,
      title: 'Reconnect and press a key',
      do: 'Restart PuTTY\'s session (right-click its title bar, <strong>Restart Session</strong>) and press a key: the unit comes back at the Main Menu, still logged in.',
      pc: { win: 'term', title: TT, keys: [O(0.2, 'reconnect'), O(0.25, 'note', 'PuTTY: Restart Session — COM16 open again'), K(0.9, 'Enter')] },
    },
  };
  const STEPS = { ...FW_STEPS, ...SET_STEPS };
  const LOGIN = ['cable', 'term'];
  const SET_PATHS = {
    'set-addr': { group: 'set', label: 'Change the station address', icon: '🏷️', about: 'Unit Config → Station Address, then save.',
      steps: [...LOGIN, 's-cfg', 's-addr', 's-save', 'done'] },
    'set-times': { group: 'set', label: 'Set the update and paralysis times', icon: '⏱️', about: 'Unit Config → Update Time and Paralysis Time, then save.',
      steps: [...LOGIN, 's-cfg', 's-times', 's-save', 'done'] },
    'set-radio': { group: 'set', label: 'Set the channel and the power', icon: '📡', about: 'Communication → Tx and Rx Frequency, Tx Power, then save.',
      steps: [...LOGIN, 's-comm', 's-freq', 's-power', 's-save', 'done'] },
    'set-repeater': { group: 'set', label: 'Make it a repeater, with its delay', icon: '🔁', about: 'Communication → Unit Type → Repeater Station, Repeater Delay, then save.',
      steps: [...LOGIN, 's-comm', 's-type', 's-delay', 's-save', 'done'] },
    'set-format': { group: 'set', label: 'Switch it to ALERT2', icon: '🔀', about: 'Communication → Report Format → ALERT2 Format; the function image says FI:2044.',
      steps: [...LOGIN, 's-comm', 's-format', 's-fi', 's-exit', 'done'] },
    'set-log': { group: 'set', label: 'Copy the log to a USB stick', icon: '🗃️', about: 'Unit Diagnostic → Upload Log to USB, the LEDs, reconnect.',
      steps: [...LOGIN, 's-stick', 's-log', 's-logleds', 's-logback', 'done'] },
  };
  const PATHS = { ...FW_PATHS, ...SET_PATHS };

  // ── The session ────────────────────────────────────────────────────────────
  const S = {
    path: 'all', i: 0, t: 0, playing: true, speed: 1, fresh: true,
    mode: 'demo',               // 'demo' (the walkthroughs) | 'live' (the terminal, interactive)
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
  const startOf = id => START[id === 'mine' ? (S.mine && S.mine.start) || 'all' : id] || (pathDef(id).group === 'set' ? START.set : START.all);

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

  // The unit's console at time t in a step: the console as the steps before
  // left it, with this step's keys and the unit's own doings (a restart, the
  // terminal reconnected, a note) applied in time order.
  function engAt(e0, step, t) {
    const e = A2Terminal.clone(e0);
    const evs = [...(step.eng || []), ...((step.pc && step.pc.keys) || [])].filter(x => x.at <= t).sort((a, b) => a.at - b.at);
    for (const x of evs) apply(e, x);
    return e;
  }
  function apply(e, x) {
    if (x.op === 'reconnect') A2Terminal.reconnect(e);
    else if (x.op === 'reset') A2Terminal.reset(e);
    else if (x.op === 'note') A2Terminal.note(e, x.text);
    else if (x.key) A2Terminal.key(e, x.key);
  }

  // The window a pc step shows at time t. A unit step shows the last pc
  // step's screen, set aside.
  function pcAt(prev, step, t, s0) {
    const pc = step.pc;
    if (!pc) return prev ? { ...prev, keys: [], pickNow: 0 } : null;
    if (pc.win !== 'term') return { win: pc.win, title: pc.title, pc, t, keys: [] };
    const e = engAt(s0.eng, step, t);
    const keys = (pc.keys || []).filter(k => k.key && t >= k.at && t < k.at + 0.75).map(k => (k.mask ? '•' : keyCap(k.key)));
    return { win: 'term', title: pc.title, lines: A2Terminal.screen(e, TERM_ROWS), keys, t,
      pickNow: e.pick > s0.eng.pick ? e.pick : 0, offline: !e.link };
  }
  const TERM_ROWS = 24;
  // A key as its keycap shows it.
  const CAPS = { Backspace: '⌫', ArrowLeft: '←', Delete: 'Del', Escape: 'Esc' };
  const keyCap = k => CAPS[k] || k;

  // Every step's start on a path: the unit, the laptop's screen, the unit's
  // console and its versions, carried from the steps before. Kept per path.
  const memo = new Map();
  function starts(id = S.path) {
    const key = id === 'mine' ? `mine:${(S.mine && S.mine.steps.join(',')) || ''}` : id;
    if (memo.has(key)) return memo.get(key);
    const list = [];
    let u = unitZero(), pc = null;
    let e = A2Terminal.create({ fw: { ...startOf(id) }, profile: pathDef(id).profile || 'field' });
    for (const sid of stepsOf(id)) {
      const st = STEPS[sid];
      const s0 = { unit: cloneUnit(u), pc, eng: e };
      list.push(s0);
      u = settleUnit(unitAt(u, st, Infinity));
      if (st.pc) pc = pcAt(pc, st, Infinity, s0);
      e = engAt(e, st, Infinity);
      if (st.fw) Object.assign(e.fw, st.fw);
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
    return { id: ids[k], step: st, unit: unitAt(s0.unit, st, t), pc: pcAt(s0.pc, st, t, s0), fw: s0.eng.fw };
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

  // A title bar's icon: PuTTY's two terminals and the bolt between them, File
  // Explorer's folder, a drive for the Format dialog.
  const ICONS = {
    putty: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1" y="1.5" width="8" height="6.5" rx=".6" fill="#d8dde3" stroke="#56606b"/><rect x="2.2" y="2.7" width="5.6" height="4.1" fill="#123a73"/>'
      + '<rect x="7" y="8" width="8" height="6.5" rx=".6" fill="#d8dde3" stroke="#56606b"/><rect x="8.2" y="9.2" width="5.6" height="4.1" fill="#123a73"/>'
      + '<path d="M10.6 1.2 7.4 6.3h2.2L6.2 11.8l5.6-6.6H9.5l2.4-4z" fill="#ffd60a" stroke="#8a6d00" stroke-width=".5"/></svg>',
    folder: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M1 3.5h5l1.4 1.5H15v8.5H1z" fill="#f4b73d"/><path d="M1 6h14v7.5H1z" fill="#ffd66b"/></svg>',
    drive: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1.5" y="5" width="13" height="6" rx="1" fill="#c7ced6" stroke="#56606b"/><circle cx="12" cy="8" r=".9" fill="#2f9e44"/></svg>',
    none: '',
  };

  function pcHtml(w) {
    // Windows 11's title bar: the program's icon and name, its buttons on the right.
    const bar = (title, ico = 'folder', ctl = 'all') => `<div class="fw-win-bar"><span class="fw-win-ico" aria-hidden="true">${ICONS[ico]}</span>
      <span class="fw-win-title">${esc(title)}</span>${ico === 'none' ? '' : '<span class="fw-sim">Simulated</span>'}
      <span class="fw-win-ctl" aria-hidden="true">${ctl === 'all' ? '<span>&#x2500;</span><span>&#x2610;</span>' : ''}<span class="fw-win-x">&#x2715;</span></span></div>`;
    if (!w) return `<div class="fw-win fw-win--idle">${bar('Laptop', 'none')}<div class="fw-win-idle">Nothing to do on the laptop yet.</div></div>`;
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
      return `<div class="fw-win fw-win--format">${bar('Format FIRMWARE (D:)', 'drive', 'close')}
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
    const spans = w.lines.map((ln, i) => {
      let body = esc(ln.t);
      // At a value prompt the cursor can sit on a character (after ←): drawn over it.
      const on = i === w.lines.length - 1 && !w.offline && ln.open && ln.cur != null && ln.cur < ln.t.length;
      if (on) body = `${esc(ln.t.slice(0, ln.cur))}<span class="tm-cur-on">${esc(ln.t[ln.cur])}</span>${esc(ln.t.slice(ln.cur + 1))}`;
      // The function image's number, boxed as ELPRO boxes it.
      if (ln.fi && ln.t.endsWith(ln.fi)) body = `${esc(ln.t.slice(0, -ln.fi.length))}<span class="tm-fi">${esc(ln.fi)}</span>`;
      const picked = w.pickNow && ln.pick === w.pickNow;
      return `<span class="tm ${ln.c || ''}${picked ? ' is-picked' : ''}">${picked ? `<mark class="tm-pick">${body}</mark>` : body}`;
    });
    const cursor = '<span class="tm-cur" aria-hidden="true">█</span>';
    // The cursor sits where the unit is waiting: at the end of the last line,
    // unless it is on a character of it.
    const last = w.lines[w.lines.length - 1];
    const atEnd = !w.offline && !(last && last.open && last.cur != null && last.cur < last.t.length);
    const lines = spans.map((sp, i) => `${sp}${i === spans.length - 1 && atEnd ? cursor : ''}</span>`).join('\n');
    // PuTTY: its title says "(inactive)" once the port has gone; the scroll
    // bar sits at the bottom of the scroll-back, as it does while a unit talks.
    return `<div class="fw-win fw-win--term${w.offline ? ' is-offline' : ''}">${bar(w.offline ? `${w.title} (inactive)` : w.title, 'putty')}
      <div class="fw-putty"><pre class="fw-term">${lines || (w.offline ? '' : cursor)}</pre>
        <span class="fw-sb" aria-hidden="true"><span class="fw-sb-up">&#x25B4;</span><span class="fw-sb-thumb"></span><span class="fw-sb-dn">&#x25BE;</span></span></div>
      ${w.offline ? '<div class="fw-offline" aria-hidden="true">USB link off-line — the unit is busy</div>' : ''}
      <div class="fw-keys" aria-hidden="true">${(w.keys || []).map(k => `<kbd class="fw-key">${esc(k)}</kbd>`).join('')}</div>
    </div>`;
  }

  // ── The walkthrough ────────────────────────────────────────────────────────

  // The demos to pick from, in two groups: the firmware, and the settings
  // changed from the menus.
  const GROUPS = [
    ['fw', 'Firmware'],
    ['set', 'Settings, from the menus'],
  ];
  function pathsHtml() {
    const btn = (id, p) => `<button type="button" class="fw-path${S.path === id ? ' is-on' : ''}" aria-pressed="${S.path === id}" title="${escAttr(p.about)}" onclick="A2Firmware.path('${id}')">
        <span class="fw-path-i" aria-hidden="true">${p.icon}</span><span class="fw-path-n">${esc(p.label)}</span></button>`;
    const mine = S.mine ? btn('mine', { icon: '🎯', label: 'What this unit needs', about: S.mine.about }) : '';
    return `<div class="fw-pathset">${GROUPS.map(([g, name]) => {
      const ids = Object.keys(PATHS).filter(id => (PATHS[id].group || 'fw') === g);
      if (!ids.length) return '';
      return `<div class="fw-paths-g"><h4 class="fw-paths-h" id="fw-paths-${g}">${esc(name)}</h4>
        <div class="fw-paths" role="group" aria-labelledby="fw-paths-${g}">${ids.map(id => btn(id, PATHS[id])).join('')}${g === 'fw' ? mine : ''}</div></div>`;
    }).join('')}<p class="fw-path-about" id="fw-path-about">${aboutLine()}</p></div>`;
  }
  const aboutLine = () => { const p = pathDef(); return `<strong>${esc(p.label)}:</strong> ${esc(p.about)} <span class="fw-muted">${stepsOf().length} steps.</span>`; };

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

  function modesHtml() {
    const b = (m, icon, name, sub) => `<button type="button" class="fw-mode${S.mode === m ? ' is-on' : ''}" aria-pressed="${S.mode === m}" onclick="A2Firmware.mode('${m}')">
      <span class="fw-mode-i" aria-hidden="true">${icon}</span><span class="fw-mode-n">${name}</span><span class="fw-mode-a">${sub}</span></button>`;
    return `<div class="fw-modes" role="group" aria-label="Watch, or try it yourself">
      ${b('demo', '▶️', 'Demo', 'Watch it done, a step at a time: the firmware, or a setting changed.')}
      ${b('live', '⌨️', 'Interactive', 'The A2\'s own menus, yours to explore. Type, or tap a menu line.')}
    </div>`;
  }

  function playerHtml() {
    const ids = stepsOf();
    const st = STEPS[ids[S.i]];
    const live = S.mode === 'live';
    const side = live ? liveSide() : st.side;
    return `<div class="fw-player" id="fw-player" data-side="${side}" data-mode="${S.mode}">
      ${modesHtml()}
      <div id="fw-demo-top"${live ? ' hidden' : ''}>${pathsHtml()}</div>
      <div id="fw-live-top"${live ? '' : ' hidden'}>${liveTopHtml()}</div>
      <div class="fw-stage" id="fw-stage" role="region" aria-label="The unit and the laptop" tabindex="0" onkeydown="A2Firmware.key(event)">
        <figure class="fw-pane fw-pane--unit${side === 'unit' ? ' is-active' : ''}" id="fw-pane-unit">
          <figcaption class="fw-pane-tag"><span aria-hidden="true">✋</span> On the unit<span class="fw-now">${side === 'unit' ? ' — now' : ''}</span></figcaption>
          <div class="fw-unit-wrap" id="fw-unit-wrap" onclick="A2Firmware.board(event)">${unitSvg()}</div>
        </figure>
        <figure class="fw-pane fw-pane--pc${side === 'pc' ? ' is-active' : ''}" id="fw-pane-pc">
          <figcaption class="fw-pane-tag"><span aria-hidden="true">⌨️</span> On the laptop<span class="fw-now">${side === 'pc' ? ' — now' : ''}</span></figcaption>
          <div class="fw-pc-wrap" id="fw-pc" onclick="A2Firmware.tapLine(event)"></div>
        </figure>
      </div>
      <div id="fw-demo-foot"${live ? ' hidden' : ''}>
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
      </div>
      <div id="fw-live-foot"${live ? '' : ' hidden'}>${liveFootHtml()}</div>
    </div>`;
  }

  // ── Interactive: the A2's console, live ────────────────────────────────────
  //
  // The same A2Terminal as the demos, fed the keys typed (or a menu line
  // tapped), with the board answering what the unit does: a load lights D1 to
  // D4 (quicker than the real minute), the host's asks for the stick out, a
  // restart drops the USB link, and Reconnect brings the terminal back.
  // Nothing here reaches a real unit; the settings changed last only while the
  // tab is open.

  const LOAD_SECS = 5;
  const LIVE_FW = { host: 'new', boot: 'new', radio: 'mid', fi: '6015' };
  let LV = null;           // { e, u0, anim, wait, profile, keys, keysAt }

  function liveStart(profile = 'field') {
    const e = A2Terminal.create({ profile, fw: { ...LIVE_FW }, stick: false });
    A2Terminal.note(e, 'PuTTY: Serial, COM16, 9600, 8 N 1, flow control None — press Enter');
    LV = { e, u0: { ...unitZero(), cable: 1 }, anim: null, wait: '', profile, keys: [], keysAt: 0 };
  }

  // Which pane wants the hands: the unit while it is loading, restarting or
  // waiting for the stick to come out; the laptop the rest of the time.
  function liveSide() {
    if (!LV) return 'pc';
    return LV.anim || LV.wait === 'pull' ? 'unit' : 'pc';
  }

  function liveTopHtml() {
    const prof = LV ? LV.profile : 'field';
    return `<div class="fw-live-ctl" role="group" aria-label="The simulated unit">
      <label class="fw-speed">Unit <select id="fw-live-prof" onchange="A2Firmware.liveReset(this.value)">
        ${Object.entries(A2Terminal.PROFILES).map(([k, p]) => `<option value="${k}"${k === prof ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
      </select></label>
      <button type="button" class="btn" onclick="A2Firmware.liveReset()">↺ Start over</button>
      <button type="button" class="btn" id="fw-live-stick" onclick="A2Firmware.liveStick()"></button>
      <button type="button" class="btn" id="fw-live-reset" onclick="A2Firmware.liveRestart()">Press RESET</button>
      <button type="button" class="btn btn-primary" id="fw-live-recon" onclick="A2Firmware.liveReconnect()">🔌 Restart Session (reconnect)</button>
    </div>`;
  }

  function liveFootHtml() {
    return `<form class="fw-live-in" onsubmit="A2Firmware.send(event)">
        <label class="fw-lbl" for="fw-live-text">Type into the terminal</label>
        <span class="fw-live-row">
          <input type="text" id="fw-live-text" class="fw-live-text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="a letter, or a value then Send">
          <button type="submit" class="btn btn-primary">Send ⏎</button>
          <button type="button" class="btn" onclick="A2Firmware.press('Enter')">Enter</button>
          <button type="button" class="btn" onclick="A2Firmware.press('y')">y</button>
          <button type="button" class="btn" onclick="A2Firmware.press('n')">n</button>
          <button type="button" class="btn" onclick="A2Firmware.press('Backspace')" aria-label="Backspace">⌫</button>
        </span>
      </form>
      <div class="fw-cap fw-cap--pc fw-live-help" id="fw-live-help" aria-live="polite"></div>`;
  }

  // What the unit is waiting for, in words, and what this menu is for.
  const ABOUT = {
    main: 'The top of the A2\'s menus. Unit Config is the station: its address, timings and logging. I/O Setup is the sensors on its inputs. Communication is the radio: channel, power, report format, and a repeater\'s delay and lists. Unit Diagnostic is the checks, the versions and the firmware loads. i) Exit asks about unsaved changes.',
    unitcfg: 'The station itself: its ALERT address, how often it sends an update, the paralysis time, how it logs, its battery, and the quick set-ups that configure a rain gauge, a river sensor and the battery in one go.',
    io: 'Each input on the board. The table above the menu is what each one reads now; pick one to give it an ALERT sensor ID ("-" turns it off), a report format and its scaling.',
    comm: 'The radio. Its items change with the Unit Type: a repeater gets its delay and its pass/reject address lists; RS-232 reporting adds the serial port\'s baud rate and protocol.',
    diag: 'Checks and maintenance: what the inputs read, the stations heard (RSSI list), a forced update, the firmware and hardware versions, the firmware loads, the log to a USB stick, and the toggles — each says what picking it would do.',
    update: 'The firmware loads. Each takes the USB link off-line while the unit reads the stick: watch D1 to D4 on the board, then reconnect and press a key.',
    accum: 'Set an accumulator — a rain gauge\'s running total, say — to a value.',
  };
  function liveHelpHtml() {
    const e = LV.e;
    const a = e.at;
    let now;
    if (!e.link) {
      now = LV.anim ? 'The unit is busy: watch the board. The terminal is off-line until it is done.'
        : LV.wait === 'pull' ? 'All four DIO LEDs are on: take the stick out (the button above, or the stick on the board) to restart the unit.'
          : 'The USB link is off-line and PuTTY says (inactive). Press <strong>🔌 Restart Session</strong>, then a key.';
    } else if (a.k === 'asleep') now = 'Press <strong>Enter</strong> (or Send) to wake the console.';
    else if (a.k === 'login') now = 'Log in: <strong>a</strong> for Engineer.';
    else if (a.k === 'password') now = 'Type a password and Enter. The simulator takes any but an empty one; a real unit takes your network\'s.';
    else if (a.k === 'menu') now = `${ABOUT[a.id] || ''} Press a letter, or tap a line in the terminal; Enter goes back up a menu.`;
    else if (a.k === 'choose') now = 'A choice: the one starred is the current setting. Press its letter, or the last one to cancel.';
    else if (a.k === 'value') now = 'The prompt holds the value now. Type the new one in the box and Send: it replaces it. Or edit it at the terminal as on the unit — Backspace, Delete, ← — and Enter; Enter on its own keeps it.';
    else if (a.k === 'onekey') now = 'One key, no Enter: <strong>1</strong> for 1 W, <strong>5</strong> for 5 W.';
    else if (a.k === 'stream') now = 'The inputs as they read now. Press a key to stop and go back to the menu.';
    else if (a.k === 'offline-wait') now = 'Reconnected. Press a key: the unit carries on where it said it would.';
    else if (a.k === 'yn') now = 'Answer <strong>y</strong> or <strong>n</strong>.';
    else if (a.k === 'any') now = 'Press any key to carry on.';
    else now = '';
    const dirty = e.dirty ? '<p class="fw-cap-warn"><span aria-hidden="true">💾</span> Changed and not saved: the unit asks about it at <strong>i) Exit</strong> from the Main Menu.</p>' : '';
    return `<p class="fw-cap-meta"><span class="fw-side fw-side--${liveSide()}"><span aria-hidden="true">${sideIcon(liveSide())}</span> ${sideWord(liveSide())}</span>
        <span class="fw-cap-n">Interactive — a simulated ${esc(A2Terminal.PROFILES[LV.profile].label.toLowerCase())}; nothing here reaches a real unit</span></p>
      <p class="fw-cap-do">${now}</p>${dirty}`;
  }

  function paintLive() {
    if (!LV || S.mode !== 'live') return;
    const e = LV.e;
    const recent = LV.keys.filter(k => k.at > performance.now() / 1000 - 0.75).map(k => k.k);
    const html = pcHtml({ win: 'term', title: TT, lines: A2Terminal.screen(e, TERM_ROWS), keys: recent, pickNow: e.pick, offline: !e.link, live: true });
    if (html !== lastPc) { const el = $('fw-pc'); if (el) el.innerHTML = html; lastPc = html; }
    if (!LV.anim) paintUnit(LV.u0, null);
    const side = liveSide();
    sidePanes(side);
    const help = $('fw-live-help');
    if (help) help.innerHTML = liveHelpHtml();
    const stick = $('fw-live-stick');
    if (stick) stick.textContent = LV.u0.stick > 0.5 ? '⏏ Take the stick out' : '💾 Plug the stick in';
    const recon = $('fw-live-recon');
    if (recon) { recon.disabled = e.link || !!LV.anim || LV.wait === 'pull'; recon.classList.toggle('is-due', !e.link && !LV.anim && LV.wait !== 'pull'); }
  }
  function sidePanes(side) {
    const pl = $('fw-player');
    if (pl) pl.dataset.side = side;
    for (const sd of ['unit', 'pc']) {
      const pane = $(`fw-pane-${sd}`);
      if (!pane) continue;
      pane.classList.toggle('is-active', side === sd);
      const now = pane.querySelector('.fw-now');
      if (now) now.textContent = side === sd ? ' — now' : '';
    }
  }

  // The board answering the unit: a load's LEDs, a restart's flash.
  function liveAnim(kind, stickIn) {
    const evs = [];
    let dur = 2;
    if (kind === 'reboot') { evs.push(reboot(0)); dur = 1.8; }
    else if (stickIn) {
      if (kind === 'radio' || kind === 'fi' || kind === 'fsk' || kind === 'log') evs.push(blink(0.1, LOAD_SECS));
      evs.push(dark(0), lights(0.4, LOAD_SECS - 0.6));
      dur = LOAD_SECS + 0.3;
    } else {
      A2Terminal.note(LV.e, 'Simulator: there is no stick in USB A, so nothing loads');
      dur = 1.5;
    }
    const job = kind === 'fsk' ? 'fi' : kind === 'log' ? '' : kind === 'reboot' ? '' : kind;
    LV.anim = { t0: performance.now() / 1000, step: { unit: evs, dur, job }, kind, stickIn };
    LV.wait = '';
    scheduleLive();
  }
  function liveEvents() {
    for (const ev of A2Terminal.takeEvents(LV.e)) {
      if (ev.k === 'load') liveAnim(ev.job, ev.stick);
      else if (ev.k === 'reboot') liveAnim('reboot', true);
    }
  }
  function liveTick() {
    if (!LV || !LV.anim) return;
    const a = LV.anim;
    const t = performance.now() / 1000 - a.t0;
    paintUnit(unitAt(LV.u0, a.step, t), a.step);
    if (t >= a.step.dur) {
      LV.u0 = settleUnit(unitAt(LV.u0, a.step, Infinity));
      if (a.kind === 'reboot') LV.u0.d = [0, 0, 0, 0];
      LV.anim = null;
      LV.wait = a.kind === 'host' && a.stickIn ? 'pull' : 'reconnect';
      paintLive();
    }
  }
  function scheduleLive() {
    if (!live || !LV) return;
    if (!live.raf) live.raf = requestAnimationFrame(loop);
  }

  // The controls.
  function liveKey(k) {
    if (!LV) return;
    if (!LV.e.link) { paintLive(); return; }
    // A password's keys show as dots: decided before the key moves the unit on.
    const cap = LV.e.at.k === 'password' && k.length === 1 ? '•' : keyCap(k);
    A2Terminal.key(LV.e, k);
    LV.keys.push({ k: cap, at: performance.now() / 1000 });
    LV.keys = LV.keys.slice(-6);
    liveEvents();
    paintLive();
    scheduleLive();
  }
  function press(k) { liveKey(k); focusStage(); }
  // The text box: each character as a key; a password then Enter. At a value
  // prompt the box's text replaces the value the prompt holds, then Enter.
  function send(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const box = $('fw-live-text');
    const text = box ? box.value : '';
    if (box) box.value = '';
    if (!LV) return;
    if (!text) { liveKey('Enter'); return; }
    if (LV.e.link && LV.e.at.k === 'value') {
      A2Terminal.type(LV.e, text);
      LV.keys.push({ k: `${text} ⏎`, at: performance.now() / 1000 });
      liveEvents();
      paintLive();
      scheduleLive();
    } else {
      for (const ch of text) liveKey(ch);
      if (LV.e.link && LV.e.at.k === 'password') liveKey('Enter');
    }
    if (box) box.focus();
  }
  // A menu line tapped: its letter, as if typed.
  function tapLine(ev) {
    if (S.mode !== 'live' || !LV) return;
    const line = ev.target && ev.target.closest && ev.target.closest('.tm-m');
    if (!line) return;
    const m = /^\s*([a-z])\)/.exec(line.textContent || '');
    if (m && (LV.e.at.k === 'menu' || LV.e.at.k === 'choose' || LV.e.at.k === 'login')) liveKey(m[1]);
  }
  // The stick on the drawing, tapped.
  function board(ev) {
    if (S.mode !== 'live') return;
    const hit = ev.target && ev.target.closest && ev.target.closest('#fw-stick, #fw-reset-cap');
    if (!hit) return;
    if (hit.id === 'fw-stick') liveStick();
    else liveRestart();
  }
  function liveStick() {
    if (!LV || LV.anim) return;
    const out = LV.u0.stick > 0.5;
    if (out) A2Terminal.unplug(LV.e); else A2Terminal.plug(LV.e);
    A2Terminal.takeEvents(LV.e);
    LV.u0.stick = out ? 0 : 1;
    if (out && LV.wait === 'pull') { A2Terminal.reset(LV.e); liveEvents(); }
    paintLive();
  }
  function liveRestart() {
    if (!LV || LV.anim) return;
    A2Terminal.reset(LV.e);
    liveEvents();
    paintLive();
  }
  function liveReconnect() {
    if (!LV || LV.e.link || LV.anim) return;
    A2Terminal.reconnect(LV.e);
    A2Terminal.note(LV.e, 'PuTTY: Restart Session — COM16 open again; press a key');
    LV.wait = '';
    paintLive();
    focusStage();
  }
  function liveReset(profile) {
    liveStart(profile || (LV ? LV.profile : 'field'));
    lastPc = '';
    paintLive();
    announce(`A fresh ${A2Terminal.PROFILES[LV.profile].label.toLowerCase()}: press Enter to wake its console.`);
  }
  function focusStage() { const s = $('fw-stage'); if (s) s.focus({ preventScroll: true }); }

  function mode(m) {
    if (m !== 'demo' && m !== 'live') return;
    S.mode = m;
    if (m === 'live' && !LV) liveStart('field');
    if (m === 'live' && S.playing) { S.playing = false; paintPlay(); }
    for (const [id, show] of [['fw-demo-top', m === 'demo'], ['fw-demo-foot', m === 'demo'], ['fw-live-top', m === 'live'], ['fw-live-foot', m === 'live']]) {
      const el = $(id); if (el) el.hidden = !show;
    }
    document.querySelectorAll('.fw-mode').forEach(b => {
      const on = b.getAttribute('onclick').includes(`'${m}'`);
      b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on));
    });
    const pl = $('fw-player'); if (pl) pl.dataset.mode = m;
    lastPc = '';
    if (m === 'live') { paintLive(); focusStage(); announce('Interactive: the A2\'s console. Press Enter to wake it, then type or tap the menu lines.'); }
    else { paintStep(false); paint(); }
    schedule();
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
            <li><span aria-hidden="true">⌨️</span> <strong>A terminal program</strong> — PuTTY (what the logs behind this simulator come from), Tera Term (what ELPRO's sheet shows), RealTerm or the like — at 9600 baud, 8N1, flow control None, to reach the A2's menus and check each part took.</li>
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
    ['The terminal went quiet after a load', 'Expected: every load takes the USB link off-line while the unit reads the stick ("This USB connection will go off-line for approximately 1 minute"). Wait for DIO4, reconnect the terminal (PuTTY: right-click the title bar, Restart Session) and press a key. After the bootloader it comes back at the Unit Diagnostic menu; after the host, the radio or an image, at the User Type login.'],
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
        <li>PuTTY logs of ERT-A2s in the field, November 2025 to October 2026 (firmware v1.7, hardware Rev3.B and Rev4.A), kept in Flood-Net's repository —
          the menus, their letters and their messages, word for word, and the loads from the Update Device Firmware menu (28 Oct 2026).</li>
        <li>ELPRO's <a href="https://elprotech.com/resourcehub-category/firmware/" target="_blank" rel="noopener">firmware downloads</a>, for a release newer than G.</li>
      </ul>
      <p class="fw-aside">Rewritten for Flood-Net: ELPRO's steps split one action to a step, put in the order they are done, and drawn — the board after the one
        in ELPRO's sheet, not a photograph of it, and the terminal's screens the unit's own, from the logs. ELPRO's sheet and ELPRO Technical Support are the authority; where this page and the unit
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
      ['⌨️', 'd → h', 'the firmware menu', 'Unit Diagnostic → Update Device Firmware: a) bootloader, b) host, c) radio, e) V23 image.'],
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
        <h2 class="fw-title" id="fw-h"><span aria-hidden="true">💾</span> The ERT-A2 simulator: firmware and settings</h2>
        <p class="fw-lede">An ELPRO ERT-A2 on the bench, simulated from the PuTTY logs of real units. <strong>Demo</strong> shows a job done: the four parts
          of its firmware loaded from a USB stick (ELPRO's Release G procedure), or a setting changed from its menus — the unit on the left, the laptop's
          terminal on the right, and a ring round whichever one your hands are on. <strong>Interactive</strong> hands you its console: log in and
          explore every menu, change things, load firmware and watch the board answer.</p>
        ${factsHtml()}
        ${tocHtml()}
      </div>
      ${sec('fw-walk', `${head('fw-walk', 1, '▶️', 'The simulator', '<strong>Demo</strong> plays a job done — the firmware, or a setting changed from the menus: ▶ plays it, ◀ and ▶ step, the dots jump. <strong>Interactive</strong> hands you the A2\'s console to explore.')}${playerHtml()}`)}
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
    if (!live || S.mode === 'live') return;
    const f = frame();
    paintUnit(f.unit, f.step);
    const html = pcHtml(f.pc);
    if (html !== lastPc) { const el = $('fw-pc'); if (el) el.innerHTML = html; lastPc = html; }
    const seek = $('fw-seek');
    if (seek && document.activeElement !== seek) seek.value = String(Math.round(1000 * clamp(S.t / f.step.dur)));
  }

  // Everything that says which step it is: the rings, the caption, the dots.
  function paintStep(say) {
    if (S.mode === 'live') return;
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
    if (S.mode === 'live') { liveTick(); if (LV && LV.anim) live.raf = requestAnimationFrame(loop); return; }
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
    const want = S.mode === 'live' ? !!(LV && LV.anim) : S.playing && live.vis && !!$('fw-page');
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
    if (S.mode === 'live') { lastPc = ''; paintLive(); }
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
    if (S.mode !== 'demo') mode('demo');
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
    const ab = $('fw-path-about');
    if (ab) ab.innerHTML = aboutLine();
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
    if (S.mode === 'live') {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = ['Enter', 'Backspace', 'Delete', 'Escape', 'ArrowLeft'].includes(e.key) ? e.key : e.key && e.key.length === 1 ? e.key : '';
      if (!k) return;
      e.preventDefault();
      liveKey(k);
      return;
    }
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
      step: stepsOf()[S.i], side: STEPS[stepsOf()[S.i]].side, mine: S.mine && { ...S.mine }, running: !!(live && live.raf), mode: S.mode,
      live: LV && { at: LV.e.at.k, menu: LV.e.at.id || '', link: LV.e.link, wait: LV.wait, busy: !!LV.anim, dirty: LV.e.dirty, cfg: { ...LV.e.cfg },
        text: A2Terminal.screen(LV.e, 40).map(l => l.t).join('\n'), log: LV.e.lines.slice(-80).map(l => l.t).join('\n') } };
  }

  return {
    render, init, path, mine, step, show, next, back, play, replay, seek, speed, go, key, tab, tick,
    mode, send, press, tapLine, board, liveReset, liveStick, liveRestart, liveReconnect,
    check, example, parse, advise, exportTxt, checklistText, frame, state, PATHS, STEPS, PARTS, TARGET,
  };
})();

if (typeof window !== 'undefined') window.A2Firmware = A2Firmware;
