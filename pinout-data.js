// MegaNet — pinout-data.js
//
//   PinoutData   the 🪛 Pinouts tab's library: every connector a field visit
//                meets — the RS-232 standards, the radios and modems, the
//                loggers and ALERT stations, the sensors — as pins, signals and
//                where each pinout came from; the cables made of them; where a
//                pin sits on a connector's face; and the 4–20 mA arithmetic.
//                Pure: no DOM, nothing runs at load.
//
// After nothing; read by pinouts.js at call time. test/pinouts.mjs holds the
// data to itself (every pin once, every cable's wires to pins that exist, a
// face for every connector) and the arithmetic to figures worked by hand.
//
// ── Where a pinout comes from ────────────────────────────────────────────────
// A wrong pin can put 12 V into a serial port, so every connector says how sure
// it is and why (SURE): a published standard, the maker's own document, a
// second-hand source such as a cable maker's listing, or not verified at all.
// Nothing here is a guess dressed as a fact: a pin nobody could source is
// written as unknown, and the connector says so.
//
// ── Which way round ──────────────────────────────────────────────────────────
// Every face is laid out as the front of the pin (male) insert, which is how
// the standards draw them. A socket (female) insert, seen from its front, is the
// mirror image; so is either seen from the back, where the wires go in. So a
// face is mirrored when exactly one of "it is a socket" and "seen from the
// back" is true (mirrored(), below) — a male plug's solder cups and a female
// socket's face both read with pin 1 on the right.
//
// A signal's direction is the unit's own: "out" leaves the unit on that pin.
// RS-232's names are the computer's (DTE's) — TXD is what the computer sends —
// so on a modem (DCE) TXD is an input. The tables say both: the name, and which
// way it goes at this unit.

const PinoutData = (function () {
  // What a pin is for — the colour on the drawing, and the legend's words.
  const KINDS = {
    power:  'Power',
    ground: 'Ground / common',
    tx:     'Data leaving this unit',
    rx:     'Data arriving at this unit',
    ctrl:   'Control or handshake',
    bus:    'Two-way data (a bus)',
    analog: 'Analogue, audio or current loop',
    shield: 'Shield or chassis',
    contact: 'A contact (no signal: a blank insert)',
    nc:     'Not connected / not used',
    unknown: 'Not yet sourced',
  };

  // How sure a pinout is, best first.
  const SURE = {
    standard:   { label: 'Published standard', short: 'Standard', blurb: 'From the standard that defines the connector — true of every unit that follows it.' },
    maker:      { label: 'Maker\'s document', short: 'Maker', blurb: 'From the manufacturer\'s own manual, datasheet or protocol document.' },
    general:    { label: 'General practice', short: 'Practice', blurb: 'True of the kind of device, not checked against this model\'s manual — confirm on the unit\'s label.' },
    second:     { label: 'Second-hand source', short: 'Second-hand', blurb: 'From a cable maker\'s listing, a reseller or a user group, not the maker\'s own manual — check it on the unit before wiring.' },
    unverified: { label: 'Not verified', short: 'Unverified', blurb: 'Nobody has confirmed this yet. Meter it out and check the unit\'s label before you wire to it.' },
  };

  const CATS = [
    ['serial', 'Serial standards'],
    ['alert',  'ALERT stations and radios'],
    ['logger', 'Loggers and modems'],
    ['sensor', 'Sensors'],
    ['mil',    'MIL-spec inserts'],
    ['power',  'Power'],
  ];

  // [n, signal, kind, dir, what it does, wire colour?]. dir: 'out' | 'in' |
  // 'both' | '' (power, ground, unused).
  const P = (n, sig, kind, dir, what, wire) => ({ n: String(n), sig, kind, dir, what, wire: wire || '' });
  // A terminal on a strip, where the printed label can repeat (a panel with six
  // G terminals): `n` keeps each one apart, `t` is what is printed on it.
  const T = (n, t, sig, kind, dir, what, wire) => ({ ...P(n, sig, kind, dir, what, wire), t });

  // RS-232 on a DE-9, by EIA/TIA-574. Names are the DTE's; `dce` turns the
  // directions round for the modem's end.
  function rs232de9(dce) {
    const d = (dte) => (dce ? (dte === 'out' ? 'in' : 'out') : dte);
    const k = (dte) => (d(dte) === 'out' ? 'tx' : 'rx');
    return [
      P(1, 'DCD', 'ctrl', d('in'),  'Data Carrier Detect — the modem says it has a link to the far end.'),
      P(2, 'RXD', k('in'),  d('in'),  dce ? 'Received Data — the modem sends the computer its data on this pin.' : 'Received Data — data arriving from the modem or instrument.'),
      P(3, 'TXD', k('out'), d('out'), dce ? 'Transmitted Data — the computer\'s data arrives on this pin.' : 'Transmitted Data — data leaving for the modem or instrument. Idles at −5 to −12 V.'),
      P(4, 'DTR', 'ctrl', d('out'), 'Data Terminal Ready — the computer end is switched on and ready. Some adapters power an isolated interface from it.'),
      P(5, 'GND', 'ground', '',     'Signal ground — the reference for every other pin. Always connect it.'),
      P(6, 'DSR', 'ctrl', d('in'),  'Data Set Ready — the modem end is switched on and ready.'),
      P(7, 'RTS', 'ctrl', d('out'), 'Request To Send — hardware flow control from the computer end.'),
      P(8, 'CTS', 'ctrl', d('in'),  'Clear To Send — hardware flow control from the modem end: go ahead.'),
      P(9, 'RI',  'ctrl', d('in'),  'Ring Indicator — the modem is being called.'),
    ];
  }

  // RS-232 on a DB-25, by EIA-232 — the asynchronous pins; the rest are unused.
  function rs232db25() {
    const used = {
      1:  P(1,  'FG',  'shield', '',    'Frame (protective) ground — the shell, not the signal reference.'),
      2:  P(2,  'TXD', 'tx',   'out', 'Transmitted Data — data leaving the computer end. Note: pin 2 here, pin 3 on a DE-9.'),
      3:  P(3,  'RXD', 'rx',   'in',  'Received Data — data arriving at the computer end. Pin 3 here, pin 2 on a DE-9.'),
      4:  P(4,  'RTS', 'ctrl', 'out', 'Request To Send.'),
      5:  P(5,  'CTS', 'ctrl', 'in',  'Clear To Send.'),
      6:  P(6,  'DSR', 'ctrl', 'in',  'Data Set Ready.'),
      7:  P(7,  'GND', 'ground', '',  'Signal ground — pin 7 here, pin 5 on a DE-9.'),
      8:  P(8,  'DCD', 'ctrl', 'in',  'Data Carrier Detect.'),
      20: P(20, 'DTR', 'ctrl', 'out', 'Data Terminal Ready.'),
      22: P(22, 'RI',  'ctrl', 'in',  'Ring Indicator.'),
    };
    const out = [];
    for (let n = 1; n <= 25; n++) out.push(used[n] || P(n, '—', 'nc', '', 'Not used by ordinary asynchronous RS-232.'));
    return out;
  }

  const SRC = {
    tia574:  { label: 'EIA/TIA-574, the 9-pin RS-232 interface (as used on every PC serial port since the IBM PC/AT)', href: 'https://en.wikipedia.org/wiki/RS-232#Connectors' },
    eia232:  { label: 'TIA-232-F (EIA RS-232), the 25-pin interface', href: 'https://en.wikipedia.org/wiki/RS-232#Connectors' },
    tia485:  { label: 'TIA-485-A — A is the inverting line, B the non-inverting', href: 'https://en.wikipedia.org/wiki/RS-485' },
    sdi12:   { label: 'SDI-12 Support Group, SDI-12 specification v1.4', href: 'https://www.sdi-12.org/specification' },
    vedirect: { label: 'Victron Energy, VE.Direct Protocol 3.32 — physical interface, serial port configuration, connector types', href: 'https://www.victronenergy.com/upload/documents/VE.Direct-Protocol-3.32.pdf' },
    al200x:  { label: 'Campbell Scientific, AL200X product manual (rev. 04/2026) — Tables B-1 to B-7, §6', href: 'https://s.campbellsci.com/documents/us/manuals/al200x.pdf' },
    al200:   { label: 'Campbell Scientific, AL200 manual (rev. 07/2025) — wiring tables, pp. 33–36', href: 'https://s.campbellsci.com/documents/us/manuals/al200.pdf' },
    al205e:  { label: 'Campbell Scientific, AL205E manual — Table 7-3, the TX header', href: 'https://s.campbellsci.com/documents/us/manuals/al205e.pdf' },
    cs42877: { label: 'Campbell Scientific, 42877 AL205-series transmit cable for Maxon radios — pinout', href: 'https://www.campbellsci.com/42877' },
    cs42875: { label: 'Campbell Scientific, 42875 AL205-series receive cable for Maxon radios — pinout', href: 'https://www.campbellsci.com/42875' },
    cs31924: { label: 'Campbell Scientific, 31924 cable — AL200/AL200X to a Maxon SD-125EL', href: 'https://www.campbellsci.com.au/31924' },
    sd125:   { label: 'Maxon SD-125 service manual — wiring diagram (Maxon Electronics Australia)', href: 'https://www.manualslib.com/manual/1344685/Maxon-Sd-125.html?page=45' },
    cs44566: { label: 'Campbell Scientific, 44566 Maxon SD-125E V2 radio — the same DB9 table', href: 'https://www.campbellsci.com/44566' },
    rf320:   { label: 'Campbell Scientific, RF320 (Ritron DTX-L) manual — Fig. 6-2, the DB-15', href: 'https://s.campbellsci.com/documents/us/manuals/rf320.pdf' },
    beam:    { label: 'Beam Communications, 9602N SBD Modem Installation & User Manual (USRMAN007502, rev. 02) — pp. 10, 16–21', href: 'https://www.satelliteworldstore.com.au/wp-content/uploads/2013/03/Pacific-Rim_Beam-Modem_9602N_UG.pdf' },
    cr300:   { label: 'Campbell Scientific, CR300 Series product manual (rev. 11/2023) — §5.3, §5.4.4, §18.2, §24', href: 'https://s.campbellsci.com/documents/au/manuals/cr300-au.pdf' },
    cr1000:  { label: 'Campbell Scientific, CR1000 operator\'s manual (rev. 2/18) — Appendix B, Tables 167 and 168', href: 'https://s.campbellsci.com/documents/us/manuals/cr1000.pdf' },
    cr1000x: { label: 'Campbell Scientific, CR1000X product manual (rev. 08/2023) — §5.4.4 and §5.4.5, Tables 5-7 and 5-8', href: 'https://s.campbellsci.com/documents/eu/manuals/cr1000x-eu.pdf' },
    cs18663: { label: 'Campbell Scientific, 18663 null modem cable (male to male) — pinout', href: 'https://www.campbellsci.com.au/18663' },
    cs31055: { label: 'Campbell Scientific, 31055 RJ45 to DB9 male (DTE) cable — pinout', href: 'https://www.campbellsci.com/31055' },
    com9602: { label: 'Campbell Scientific, COM9602 Iridium modem — "RS-232 with null modem" to a CR300', href: 'https://www.campbellsci.ca/com9602' },
    hs40s2:  { label: 'KISTERS, HS40 Series II user manual (06-2026) — §2.3 the sensor block, §2.4 the compressor block', href: 'https://hydromet-products.kisters-group.com/wp-content/uploads/HS40-Series-II_User-Manual_KISTERS_EN_2606.pdf' },
    hs40c:   { label: 'KISTERS, HS40C (Compact) user manual (06-2026) — §2.4', href: 'https://hydromet-products.kisters-group.com/wp-content/uploads/HS40C_User-Manual_KISTERS_EN_2606.pdf' },
    wl3100:  { label: 'KISTERS / HyQuest, WL3100 user manual (04-2023) — the 4–20 mA interface, §5, §7, Appendices A–C', href: 'https://hydromet-products.kisters-group.com/wp-content/uploads/WL3100_User-Manual_KISTERS_EN_2304.pdf' },
    wl3100old: { label: 'Hydrological Services, WL3100 instruction manual (issue 10, 2008) — §XV, the MIL connectors', href: 'https://envcoglobal.com/wp-content/uploads/2014/10/hs-wl3100-manual-2007.pdf' },
    curs100: { label: 'Campbell Scientific, CURS100 100 Ω current shunt — manual', href: 'https://s.campbellsci.com/documents/us/manuals/curs100.pdf' },
    erta2:   { label: 'ELPRO Technologies, ERT-A2 user manual (Sept 2025) — pp. 6, 10–13, 17', href: 'https://elprotech.com/wp-content/uploads/2024/11/EL-ERT-A2_Manual_Sept25.pdf' },
    erta2cfg: { label: 'ELPRO Technologies, ERT-A2 ALERT2 configuration manual (rev. 1.0, 2021) — Connections (Milspec), pp. 11–13, 48', href: 'https://elprotech.com/wp-content/uploads/2021/07/UserManual_ERT-A2_v1.1-2.pdf' },
    erta2deck: { label: 'ELPRO Technologies, Alert 2 introduction (July 2024) — External Connector Wiring', href: 'https://elprotech.com/wp-content/uploads/2024/12/Alert-2-Introduction-BH-V1.pdf' },
    e115:    { label: 'ELPRO Technologies, 115E-2 user manual (April 2026) — RS-232 port, Table 1', href: 'https://elprotech.com/wp-content/uploads/2024/06/EL-115E-2_User-Manual_April26.pdf' },
    amphenol97: { label: 'Amphenol Industrial, 97 Series (MIL-DTL-5015 type) catalogue 12-022 — insert arrangements, pp. 4–12', href: 'https://amphenol-industrial.com/wp-content/uploads/2024/04/97-series-12-022.pdf' },
    namur:   { label: 'NAMUR NE 43 — signal levels for failure information from digital transmitters (3.8–20.5 mA measuring, ≤3.6 or ≥21 mA failure)', href: 'https://en.wikipedia.org/wiki/Current_loop' },
  };

  // A circular insert's contacts, as [degrees clockwise from the key, fraction
  // of the insert's radius] → [x, y] with y down, the key at the top.
  function polar(o) {
    return Object.fromEntries(Object.entries(o).map(([n, [deg, r]]) => {
      const a = deg * Math.PI / 180;
      return [n, [+(r * Math.sin(a)).toFixed(4), +(-r * Math.cos(a)).toFixed(4)]];
    }));
  }

  // What ELPRO does not say about its MIL connectors.
  const MIL_SEX = 'ELPRO does not say which sex is on the unit: most likely pins on the canister and sockets in the cable plugs, as on Campbell\'s and High Sierra\'s canisters. The letters are moulded beside each contact on the insert — go by them.';

  // ── The library ────────────────────────────────────────────────────────────
  // face: how it is drawn — { type: 'dsub', shell } | { type: 'circular', … } |
  // { type: 'strip', rows } | { type: 'header' }. gender: the connector on the
  // unit — 'M' pins, 'F' sockets, '' where it does not apply (a terminal block).
  const CONNECTORS = [
    {
      id: 'rs232-de9-dte', cat: 'serial', name: 'RS-232 on a DE-9 (DB9) — male, computer end (DTE)',
      short: 'DE-9 male · DTE', unit: 'A computer, a USB-to-serial adapter, a logger\'s RS-232 port wired as a terminal',
      face: { type: 'dsub', shell: 'DE9' }, gender: 'M', sure: 'standard', sources: [SRC.tia574],
      pins: rs232de9(false),
      notes: [
        'Male (pins) on the unit is the convention for the computer end — a convention, not a rule; plenty of instruments break it. Go by the signals, not the shell.',
        'Which end is talking? Unit on and idle, meter pin 3 to pin 5: a computer end\'s TXD sits at −5 to −12 V. If pin 2 sits there instead, the unit is wired as a modem (DCE).',
        'For a three-wire link only 2, 3 and 5 matter. If nothing arrives, the unit may be waiting on CTS or DSR — loop 7 to 8 and 4 to 6 (and 1) at its end, or turn flow control off.',
      ],
      find: 'db9 de9 de-9 db-9 dte computer pc usb serial adapter male pins rs232 rs-232',
    },
    {
      id: 'rs232-de9-dce', cat: 'serial', name: 'RS-232 on a DE-9 (DB9) — female, modem end (DCE)',
      short: 'DE-9 female · DCE', unit: 'A modem, a satellite modem, many instruments\' configuration ports',
      face: { type: 'dsub', shell: 'DE9' }, gender: 'F', sure: 'standard', sources: [SRC.tia574],
      pins: rs232de9(true),
      notes: [
        'Same pin numbers and names as the computer end — the names are always the computer\'s — so TXD (3) is the modem\'s input and RXD (2) its output.',
        'A straight male-to-female cable joins a DTE to a DCE. Two DTEs (a laptop and a logger) need a null modem; two DCEs a null modem too.',
        'Unit on and idle, meter pin 2 to pin 5: a modem end\'s data out sits at −5 to −12 V.',
      ],
      find: 'db9 de9 de-9 db-9 dce modem female sockets rs232 rs-232',
    },
    {
      id: 'rs232-db25-dte', cat: 'serial', name: 'RS-232 on a DB-25 — male, computer end (DTE)',
      short: 'DB-25 male · DTE', unit: 'Older computers, printers, modems and test sets; the original RS-232 connector',
      face: { type: 'dsub', shell: 'DB25' }, gender: 'M', sure: 'standard', sources: [SRC.eia232],
      pins: rs232db25(),
      notes: [
        'TXD and RXD are on 2 and 3 here but 3 and 2 on a DE-9, and ground moves from 5 to 7 — the 9-to-25 adapter (Cables, below) does the swap.',
        'A modem\'s DB-25 (DCE) is usually female, with the same pin names and the directions turned round.',
      ],
      find: 'db25 db-25 25 pin 25-pin rs232 rs-232 older printer',
    },
    {
      id: 'rs485', cat: 'serial', name: 'RS-485 (two-wire) — terminals',
      short: 'RS-485 · A/B', unit: 'Modbus sensors, some loggers\' and gateways\' field buses (the ELPRO 115E offers RS-232 or RS-485)',
      face: { type: 'strip' }, gender: '', sure: 'standard', sources: [SRC.tia485],
      pins: [
        P('A', 'D− (A)', 'bus', 'both', 'The inverting line. Idle (a 1), A sits below B.'),
        P('B', 'D+ (B)', 'bus', 'both', 'The non-inverting line. Idle, B sits at least 0.2 V above A.'),
        P('C', 'Common', 'ground', '', 'Signal common. Two-wire RS-485 still needs a common reference between units that are not otherwise grounded together.'),
      ],
      notes: [
        'Makers disagree about which line is A: some print A for D+. If a bus will not talk and everything else checks out, swap A and B — nothing is damaged by trying.',
        'A daisy chain, not a star: terminate each end of the run with 120 Ω across A–B, and nowhere else.',
        'RS-485 and RS-232 are not compatible — different voltages and a differential pair. A converter goes between them.',
      ],
      find: 'rs485 rs-485 modbus two wire 2-wire half duplex a b d+ d- termination 120 ohm differential',
    },
    {
      id: 'sdi12', cat: 'sensor', name: 'SDI-12 sensor — three wires',
      short: 'SDI-12 · 3 wire', unit: 'Any SDI-12 sensor: pressure transducers, bubblers, shaft encoders, weather sensors',
      face: { type: 'strip' }, gender: '', sure: 'standard', sources: [SRC.sdi12],
      pins: [
        P('+12V', '+12 V', 'power', 'in', 'Sensor power from the logger: 9.6 to 16 V.'),
        P('GND', 'Ground', 'ground', '', 'Common for the power and the data line.'),
        P('DATA', 'SDI-12 data', 'bus', 'both', 'One wire, both directions, 1200 baud 7E1. A logic 1 is under 1 V and a 0 is 3.5 to 5 V. Every sensor on the bus shares it.'),
      ],
      notes: [
        'Each sensor on the line needs its own address (0–9, a–z, A–Z): two sensors left on address 0 answer at once and both readings come out garbled.',
        'Wire colours are the sensor maker\'s — red is usually +12 V, but the data and ground colours vary. Read the sensor\'s label or cable tag.',
        'Keep the whole bus to about 60 m of cable. The data line is not RS-232: never connect it to a serial port\'s TXD or RXD.',
      ],
      find: 'sdi12 sdi-12 sensor bus address 1200 baud three wire 3-wire data line',
    },
    {
      id: 'loop-2wire', cat: 'sensor', name: '4–20 mA — two-wire (loop-powered) transmitter',
      short: '4–20 mA · 2 wire', unit: 'Pressure transducers, level and flow transmitters that take their power from the loop',
      face: { type: 'strip' }, gender: '', sure: 'general', sources: [SRC.namur],
      pins: [
        P('+', 'Loop +', 'analog', 'in', 'From the loop supply (+12 or +24 V). The transmitter takes its power and sets the current through it.'),
        P('−', 'Loop −', 'analog', 'out', 'The current leaves here, 4 to 20 mA, through the logger\'s measuring resistor back to the supply\'s 0 V.'),
      ],
      notes: [
        'The signal is the current, not a voltage: a logger reads it as the voltage across a resistor — 250 Ω makes 1–5 V, 100 Ω makes 0.4–2 V.',
        'A transmitter needs a minimum voltage across it to work. Supply less loop resistance × 20 mA must still leave that — the calculator below works it out.',
        '0 mA is a broken wire; under 3.6 or over 21 mA is the transmitter flagging a fault (NAMUR NE 43). Live zero (4 mA) is why a dead loop never reads as an empty river.',
      ],
      find: '4-20 4-20ma 4 20 milliamp current loop two wire loop powered passive transmitter transducer shunt 250 ohm',
    },
    {
      id: 'loop-4wire', cat: 'sensor', name: '4–20 mA — active (sourcing) output',
      short: '4–20 mA · active', unit: 'Instruments with their own power that drive the loop current themselves',
      face: { type: 'strip' }, gender: '', sure: 'general', sources: [SRC.namur],
      pins: [
        P('V+', 'Power +', 'power', 'in', 'The instrument\'s own supply.'),
        P('0V', 'Power −', 'ground', '', 'Supply common.'),
        P('I+', 'Current out', 'analog', 'out', 'The instrument pushes 4–20 mA out of this terminal, through the logger\'s resistor, back to I− (or to 0 V).'),
        P('I−', 'Current return', 'analog', 'in', 'Return for the loop. On many instruments this is joined to 0 V inside.'),
      ],
      notes: [
        'An active output must not be wired into a loop that is also powered from the logger — two supplies fighting in one loop. One source of loop power, never two.',
        'If I− is joined to 0 V inside the instrument, the logger\'s measuring resistor goes from I+ to ground and the two share a common — check before wiring to an isolated input.',
      ],
      find: '4-20 4-20ma active sourcing four wire 4-wire self powered current output',
    },
    {
      id: 'tipping-bucket', cat: 'sensor', name: 'Tipping-bucket rain gauge — reed switch',
      short: 'Rain gauge · 2 wire', unit: 'Tipping-bucket rain gauges (the HS TB3 and others): a magnet on the bucket closes a reed switch each tip',
      face: { type: 'strip' }, gender: '', sure: 'general', sources: [],
      pins: [
        P('1', 'Switch', 'ctrl', 'out', 'One side of the reed switch.'),
        P('2', 'Switch', 'ctrl', 'out', 'The other side. A tip closes the two together for about 100 ms.'),
      ],
      notes: [
        'A dry contact: no polarity, either wire to either terminal — to the logger\'s or encoder\'s pulse (switch-closure) input and its ground.',
        'Set the input for switch closure with debounce. A count of two or three per tip is contact bounce; a steady count with no rain is a wire shorting or a stuck switch.',
        'Some gauges have two switches (a second for a backup logger) — four wires, two independent pairs.',
      ],
      find: 'tipping bucket rain gauge reed switch tb3 pulse counter switch closure tip',
    },

    // ── MIL-DTL-5015 inserts, blank: to tell an unknown connector by its face ─
    ...[
      ['10SL-3', 'Three contacts, one off the centre line — power connectors (the ERT-A2\'s Solar, Campbell\'s canister power).', { A: [41, 0.53], B: [180, 0.39], C: [319, 0.53] }, 'none listed'],
      ['14S-2', 'Four contacts in a square.', { A: [41, 0.42], B: [136, 0.42], C: [224, 0.42], D: [319, 0.42] }, 'X 120°, Y 240°'],
      ['14S-5', 'Five contacts in a ring.', { A: [10, 0.52], B: [82, 0.52], C: [152, 0.52], D: [222, 0.52], E: [295, 0.52] }, 'X 110°'],
      ['14S-6', 'Six contacts in a ring, A at the key.', { A: [0, 0.49], B: [60, 0.49], C: [120, 0.49], D: [180, 0.49], E: [240, 0.49], F: [300, 0.49] }, 'none listed'],
      ['14S-7', 'Three contacts, like the 10SL-3 in a 14 shell.', { A: [42, 0.44], B: [178, 0.38], C: [319, 0.43] }, 'W 90°, X 180°, Y 270°'],
      ['16S-1', 'Seven contacts: six in a ring and G at the centre.', { A: [33, 0.54], B: [91, 0.54], C: [150, 0.54], D: [213, 0.54], E: [270, 0.54], F: [327, 0.54], G: [0, 0] }, 'W 80°, Z 280°'],
      ['16S-8', 'Five contacts in a ring, E at the key.', { E: [0, 0.55], A: [72, 0.55], B: [143, 0.55], C: [217, 0.55], D: [288, 0.55] }, 'X 170°, Y 265°'],
      ['18-1', 'Ten contacts: eight in a ring, I and J inside.', { A: [22, 0.74], B: [67, 0.74], C: [112, 0.74], D: [156, 0.74], E: [204, 0.74], F: [249, 0.74], G: [290, 0.74], H: [334, 0.74], I: [0, 0.31], J: [180, 0.31] }, 'W 70°, X 145°, Y 215°, Z 290°'],
    ].map(([insert, what, at, alt]) => ({
      id: `mil-${insert.toLowerCase()}`, cat: 'mil', name: `MIL-DTL-5015 insert ${insert} — blank`,
      short: `MIL insert ${insert}`, unit: what,
      face: { type: 'circular', insert, at: polar(at) }, gender: 'M', sure: 'second', sources: [SRC.amphenol97],
      pins: Object.keys(at).sort().map(n => P(n, `Contact ${n}`, 'contact', '', 'A size 16 contact. What it carries is the equipment\'s, not the insert\'s.')),
      notes: [
        `Alternate insert positions (the whole insert turned, clockwise, so plugs with the same pattern cannot be swapped): ${alt}.`,
        'Positions are measured off Amphenol\'s catalogue drawings, which are not dimensioned — near enough to tell one pattern from another, not to drill a panel by.',
        'MS3102 is the box receptacle, MS3106 the straight cable plug; P after the insert means pins, S sockets — MS3106A-14S-5S is a 14S-5 cable plug with sockets.',
      ],
      find: `mil milspec mil-spec mil-dtl-5015 ms3102 ms3106 97 series amphenol circular insert ${insert.toLowerCase()}`,
    })),

    // ── Sensors: the HS40 bubbler ───────────────────────────────────────────
    {
      id: 'hs40-sensor', cat: 'sensor', name: 'KISTERS HS40 bubbler (WL3100 sensor) — 6-way output block',
      short: 'HS40 · 4–20 mA & SDI-12', unit: 'The HS40 Series II and HS40 Compact (HS40AFC/3100): the spring terminal block under the enclosure, from the WL3100 pressure sensor — the older HSA HS40V has the same labels',
      face: { type: 'strip' }, gender: '', sure: 'maker', sources: [SRC.hs40s2, SRC.hs40c, SRC.wl3100],
      pins: [
        P('12', '+12 V', 'power', 'in', 'Sensor power, 9.6–16 V. Needed even when only the 4–20 mA is used — the sensor cannot measure without it.'),
        P('Da', 'SDI-12 data', 'bus', 'both', 'SDI-12, up to 60 m. Set "Comms Type" to RS232 and the same line talks RS-232 through HSA\'s adapter.'),
        P('0V', '0 V', 'ground', '', 'Common for the 12 V and the SDI-12.'),
        P('+S', '4–20 mA +', 'analog', 'in', 'Loop +, 9 to 30 V. The loop is passive (two-wire) and optically isolated from 12 and 0V: the logger powers it.'),
        P('−S', '4–20 mA −', 'analog', 'out', 'Loop −: the current leaves here for the logger\'s measuring resistor.'),
        P('spare', '(unlabelled)', 'nc', '', 'Used only on the WL3100/S as a second SDI-12 port. Leave it empty.'),
      ],
      warn: 'The manuals give these labels, not their order on the block — read the labels on site. (On the WL3100\'s own plug, left to right, the order is −S, +S, blank, 0V, DA, 12.)',
      notes: [
        'The 4–20 mA scale is yours to set: the level that makes 4 mA and the level that makes 20 mA, from the LCD or over SDI-12 (aX2+…! for 4 mA, aX3+…! for 20 mA). The narrower the span, the finer the resolution.',
        'On a fault, or with the 12 V lost, the output goes to 24 mA. A logger input or a measuring resistor that clips below 24 mA hides the fault.',
        'No maximum loop resistance is published. With 9 V needed at the sensor, (loop volts − 9) ÷ 0.020 A is the most resistance the loop can hold — about 150 Ω on a 12 V loop, 750 Ω on 24 V; ÷ 0.024 A to keep the 24 mA fault readable. The calculator below works it out.',
        'SDI-12 and 4–20 mA can be connected at once — two loggers, for redundancy. Run the 12 V and 0V straight back to the battery, so the compressor\'s current doesn\'t pull the sensor\'s supply down.',
        'Warm-up: 1 s with Continuous Mode on, 15 s with it off. The compressor\'s 20–30 A surge can sag a shared battery during a purge.',
      ],
      find: 'kisters hs40 hs-40 hs40c hs40afc compact series ii bubbler compressor wl3100 wl3100a pressure sensor 4-20 sdi-12 +s -s da hydrological services hsa',
    },
    {
      id: 'hs40-diag', cat: 'sensor', name: 'KISTERS HS40 Series II — compressor diagnostic block (5-way)',
      short: 'HS40 · compressor outputs', unit: 'The HS40 Series II\'s second spring block, from the compressor controller (not on the Compact or the HS40V)',
      face: { type: 'strip' }, gender: '', sure: 'maker', sources: [SRC.hs40s2],
      pins: [
        P('Alm', 'Alarm', 'ctrl', 'out', 'Open-collector alarm output (a MOSFET with 470 Ω in series and an 18 V zener). The logger\'s pull-up: 18 V at most.'),
        P('CmprOn', 'Compressor running', 'ctrl', 'out', 'Open-collector: on while the compressor runs.'),
        T('0V-a', '0V', '0 V', 'ground', '', 'Common.'),
        P('SDI', 'SDI-12 (compressor)', 'bus', 'both', 'The compressor controller\'s own SDI-12 — address 9 by default. RS-232 by putting * before each command (1200 baud, 7E1).'),
        T('0V-b', '0V', '0 V', 'ground', '', 'Common.'),
      ],
      notes: ['Needs no 12 V of its own: the controller runs from the compressor\'s 6 mm² power cable, which goes straight to the battery, not the regulator\'s load terminals (38 Ah at least; about 30 A peaks; it stops below 10 V).'],
      find: 'kisters hs40 series ii compressor alarm cmpron diagnostic sdi',
    },
    {
      id: 'wl3100-mil', cat: 'sensor', name: 'WL3100 MIL-connector option (2008-era HSA) — two 4-pin plugs',
      short: 'WL3100 · MIL option', unit: 'The WL3100 pressure sensor as built by Hydrological Services around 2008 with round MIL connectors: one for SDI-12 (male), one for 4–20 mA (female)',
      face: { type: 'strip' }, gender: '', sure: 'maker', sources: [SRC.wl3100old],
      pins: [
        T('S-A', 'SDI A', 'SDI-12 data', 'bus', 'both', 'SDI-12 connector (4-pin male), pin A: data.', 'White'),
        T('S-B', 'SDI B', '+12 V', 'power', 'in', 'SDI-12 connector, pin B: +12 V (9.6–16 V).', 'Red'),
        T('S-C', 'SDI C', '0 V', 'ground', '', 'SDI-12 connector, pin C: ground.', 'Black'),
        T('S-D', 'SDI D', 'Not connected', 'nc', '', 'SDI-12 connector, pin D: not connected.'),
        T('L-A', 'mA A', 'Loop + (excitation)', 'analog', 'in', '4–20 mA connector (4-pin female), pin A: loop excitation, 9–30 V.'),
        T('L-B', 'mA B', 'Loop out', 'analog', 'out', '4–20 mA connector, pin B: the loop current, out to the measuring resistor.'),
        T('L-C', 'mA C', 'Linked to D', 'nc', '', '4–20 mA connector, pin C: linked to D inside.'),
        T('L-D', 'mA D', 'Linked to C', 'nc', '', '4–20 mA connector, pin D: linked to C inside.'),
      ],
      warn: 'From HSA\'s 2008 WL3100 manual. Today\'s datasheets still offer MIL-spec connectors but print no pinout, and none names the series or the insert — so the letters may differ on a newer unit, and where each letter sits on the face is not drawn here: read the letters moulded on the insert.',
      notes: [],
      find: 'wl3100 mil milspec mil-spec circular connector hs40 hydrological services sdi-12 4-20',
    },
    {
      id: 'vedirect', cat: 'power', name: 'Victron VE.Direct — JST PH 4-pin',
      short: 'VE.Direct · 4 pin', unit: 'Victron SmartSolar and BlueSolar MPPT chargers, BMV and SmartShunt battery monitors',
      face: { type: 'header' }, gender: 'M', sure: 'maker', sources: [SRC.vedirect],
      pins: [
        P(1, 'GND', 'ground', '', 'Ground.'),
        P(2, 'VE.Direct-RX', 'rx', 'in', 'Data into the charger. On an MPPT it can be set up instead as a remote on/off input.'),
        P(3, 'VE.Direct-TX', 'tx', 'out', 'Data out of the charger: the text protocol, 19200 baud 8N1, every second. On an MPPT it can be set up instead as a PWM (light dimming) output.'),
        P(4, 'Power +', 'power', 'out', 'A small supply for an interface cable — not for anything else.'),
      ],
      notes: [
        'The charger\'s TX goes to the reader\'s RX and RX to TX. Victron swapped RX and TX in the protocol document at version 3.22 (2016) — an older copy has them the other way round.',
        'These are logic levels, not RS-232: never connect a VE.Direct pin to a DE-9 serial port. Use Victron\'s VE.Direct-to-USB or VE.Direct-to-RS232 cable, which isolate it.',
        'The VE.Direct-to-RS232 cable takes its power from the serial port: DTR (pin 4) or RTS (pin 7) must be driven high, and it talks on 2, 3 and 5.',
      ],
      find: 'victron ve.direct vedirect mppt smartsolar bluesolar bmv smartshunt solar charger regulator jst ph',
    },

    // ── ELPRO: the ERT-A2, and the ERRTS canister it replaces ───────────────
    // Five MIL-spec receptacles on the -M (ERRTS standard) enclosure, drawn at
    // the angles ELPRO's own drawings put each letter (clockwise from the key).
    {
      id: 'erta2-rain', cat: 'alert', name: 'ELPRO ERT-A2 / ERRTS canister — Rain (5-pin MIL)',
      short: 'ERT-A2 · Rain', unit: 'The ELPRO ERT-A2 ALERT2 station\'s rain gauge connector — pin compatible, ELPRO says, with the legacy ERRTS canister\'s',
      face: { type: 'circular', insert: '14S-5', at: polar({ A: [1, 0.52], B: [73, 0.52], C: [144, 0.52], D: [216, 0.52], E: [287, 0.52] }) },
      gender: 'M', sure: 'maker', sources: [SRC.erta2, SRC.erta2cfg, SRC.erta2deck],
      pins: [
        P('A', 'Contact input (DIO3)', 'ctrl', 'in', 'The tipping-bucket switch. A closure to common counts one; 10 Hz at most.'),
        P('B', 'Common', 'ground', '', 'The tipping bucket\'s return.'),
        P('C', 'N/C', 'nc', '', 'Not connected.'),
        P('D', 'Common', 'ground', '', 'Common.'),
        P('E', 'Common', 'ground', '', 'Common.'),
      ],
      warn: MIL_SEX,
      notes: [
        'The gauge goes between B (common) and A (input). Inside, it is the DIO3 and GND terminals.',
        'Not High Sierra\'s layout: on a High Sierra 3206 or 3306 canister, PRECIP pin B is +12 V battery. A lead moved between the two brands unchecked puts 12 V where ELPRO expects common.',
        'Insert: 14S-5 by its pattern — our reading of ELPRO\'s drawing against Amphenol\'s catalogue; ELPRO gives no part number.',
      ],
      find: 'elpro ert-a2 erta2 errts canister rain tipping bucket mil milspec circular dio3',
    },
    {
      id: 'erta2-river-digital', cat: 'alert', name: 'ELPRO ERT-A2 / ERRTS canister — River Digital (5-pin MIL)',
      short: 'ERT-A2 · River Digital', unit: 'The ERT-A2\'s shaft encoder connector — SDI-12 too on a Rev 4.0 board, set by an internal socket',
      face: { type: 'circular', insert: '14S-5 (rotated)', at: polar({ A: [112, 0.52], B: [186, 0.52], C: [257, 0.52], D: [326, 0.52], E: [40, 0.52] }) },
      gender: 'M', sure: 'maker', sources: [SRC.erta2, SRC.erta2cfg],
      pins: [
        P('A', 'DIO1 · SDI-12 data', 'bus', 'both', 'Shaft encoder (incremental): digital DIO1. Quadrature: not connected. SDI-12 mode: SDI-12 data (A and C are listed alike — joined inside).'),
        P('B', 'N/C', 'nc', '', 'Not connected in any mode.'),
        P('C', 'DIO1 · SDI-12 data', 'bus', 'both', 'Shaft encoder: digital DIO1 (both kinds). SDI-12 mode: SDI-12 data — ELPRO\'s drawing wires the data here.'),
        P('D', 'Common · +12 V (SDI-12)', 'power', '', 'Shaft encoder: common. SDI-12 mode: +12 V for the sensor.'),
        P('E', 'DIO2 · Common (SDI-12)', 'ctrl', 'in', 'Incremental encoder: direction (DIO2). Quadrature: digital DIO2. SDI-12 mode: common.'),
      ],
      warn: '<strong>Pin D changes with the internal "River" socket.</strong> In position 1–4 (shaft encoder) D is common; in 3–6 (SDI-12) it carries +12 V. ELPRO changed the default to SDI-12 from late October 2024 — check the socket before plugging in a legacy shaft encoder. ' + MIL_SEX,
      notes: [
        'A legacy ERRTS canister\'s River Digital is a shaft-encoder input only: SDI-12 on this connector is the ERT-A2\'s addition.',
        'Insert: 14S-5 turned about 110° (Amphenol\'s alternate position X) — our reading; Campbell\'s ALERT205 canister uses the same, as its D2.',
      ],
      find: 'elpro ert-a2 erta2 errts canister river digital shaft encoder quadrature sdi-12 mil milspec circular',
    },
    {
      id: 'erta2-river-analog', cat: 'alert', name: 'ELPRO ERT-A2 / ERRTS canister — River Analog (4-pin MIL)',
      short: 'ERT-A2 · River Analog', unit: 'The ERT-A2\'s 4–20 mA water level connector',
      face: { type: 'circular', insert: '14S-2 (rotated)', at: polar({ C: [354, 0.42], D: [80, 0.42], A: [170, 0.42], B: [262, 0.42] }) },
      gender: 'M', sure: 'maker', sources: [SRC.erta2, SRC.erta2cfg],
      pins: [
        P('A', 'AIN1+ (signal loop)', 'analog', 'in', 'The loop into analogue input 1.'),
        P('B', 'AIN1− (signal loop)', 'analog', 'out', 'The loop\'s return from analogue input 1.'),
        P('C', 'Loop supply +24 V', 'power', 'out', 'Switched 24 V for a loop-powered sensor, 50 mA at most.'),
        P('D', 'Common', 'ground', '', 'Common.'),
      ],
      warn: MIL_SEX,
      notes: [
        'Sensor with its own power: its + to A, its − to B.',
        'Sensor powered by the ERT-A2 (two-wire): its + to C, its − to A, and a link from B to D. An HS40\'s WL3100 wired this way gets 24 V on its loop — plenty for its 9 V.',
        'Only AI1 comes out on this connector; AI2 is on the internal terminals.',
        'Insert: 14S-2 turned about 120° (Amphenol\'s X) — our reading; Campbell\'s ALERT205 canister uses the same, as its A1.',
      ],
      find: 'elpro ert-a2 erta2 errts canister river analog analogue 4-20 water level loop 24v mil milspec circular',
    },
    {
      id: 'erta2-solar', cat: 'alert', name: 'ELPRO ERT-A2 / ERRTS canister — Solar (3-pin MIL)',
      short: 'ERT-A2 · Solar', unit: 'The ERT-A2\'s solar panel and battery connector',
      face: { type: 'circular', insert: '10SL-3', at: polar({ A: [58, 0.53], B: [180, 0.39], C: [303, 0.53] }) },
      gender: 'M', sure: 'maker', sources: [SRC.erta2, SRC.erta2cfg],
      pins: [
        P('A', 'Solar input', 'power', 'in', 'From a 12 V nominal solar panel: 17–30 V (ELPRO\'s 2021 manual says 15–30 V), or a 24 W supply.'),
        P('B', 'Common', 'ground', '', 'Common.'),
        P('C', '+12 V battery', 'power', 'both', 'Battery output — and where an external 11–15 V battery\'s + goes.'),
      ],
      warn: '<strong>12 V panels only.</strong> A 24 V panel can make up to 44 V open circuit and damage the regulator. And no external battery on C (BAT) when an internal lithium battery is fitted. ' + MIL_SEX,
      notes: ['Insert: 10SL-3 by its pattern — our reading; Campbell\'s canister power connector is a 10SL-3 too.'],
      find: 'elpro ert-a2 erta2 errts canister solar panel battery power supply mil milspec circular 10sl-3',
    },
    {
      id: 'erta2-serial', cat: 'alert', name: 'ELPRO ERT-A2 / ERRTS canister — Serial (6-pin MIL)',
      short: 'ERT-A2 · Serial', unit: 'The ERT-A2\'s serial connector: RS-232 (or RS-485) and an SDI-12 bus',
      face: { type: 'circular', insert: '14S-6', at: polar({ A: [1, 0.49], B: [60, 0.49], C: [126, 0.49], D: [182, 0.49], E: [242, 0.49], F: [303, 0.49] }) },
      gender: 'M', sure: 'maker', sources: [SRC.erta2, SRC.erta2cfg, SRC.erta2deck],
      pins: [
        P('A', 'RX data · RS-485', 'rx', 'in', 'RS-232: data into the ERT-A2 — to a PC\'s DB9 pin 3. RS-485: A (+) by the 2025 manual, B (−) by the 2021 one.'),
        P('B', 'TX data · RS-485', 'tx', 'out', 'RS-232: data out of the ERT-A2 — to a PC\'s DB9 pin 2. RS-485: B (−) by the 2025 manual, A (+) by the 2021 one.'),
        P('C', 'GND', 'ground', '', 'Ground — DB9 pin 5.'),
        P('D', 'SDI-12 +12 V', 'power', 'out', '12 V for an SDI-12 sensor.'),
        P('E', 'SDI-12 data', 'bus', 'both', 'SDI-12 data.'),
        P('F', 'SDI-12 GND', 'ground', '', 'SDI-12 ground.'),
      ],
      warn: '<strong>RS-485\'s polarity is in doubt:</strong> ELPRO\'s 2025 and 2021 manuals give A and B the other way round. RS-485 also needs the internal MIL-spec socket moved from RS232 to RS485, and then shares the SDI-12 (which a base receiver does not offer). ' + MIL_SEX,
      notes: [
        'The legacy ERRTS canister\'s serial cable (CBLSERERT) fits: "use the standard serial cable that is used on the Legacy ERTS cannisters" (Cables, below). Unplug USB first — RS-232 does not work with USB connected.',
        'ELPRO\'s drawings of the PC end disagree on which DB9 pin is TX; the mapping (A to 3, B to 2, C to 5) is the same in all three. Meter the PC end if unsure.',
        'Insert: 14S-6 by its pattern — our reading.',
      ],
      find: 'elpro ert-a2 erta2 errts canister serial rs232 rs-232 rs485 sdi-12 cblserert mil milspec circular',
    },
    {
      id: 'erta2-terminals', cat: 'alert', name: 'ELPRO ERT-A2 — internal push-in terminals',
      short: 'ERT-A2 · terminals', unit: 'Inside the ERT-A2: the four push-in blocks the MIL connectors are wired from — digitals, analogue, sensor/RS-485 and supply',
      face: { type: 'strip', per: 6 }, gender: '', sure: 'maker', sources: [SRC.erta2, SRC.erta2deck],
      pins: [
        T('d-g1', 'GND', 'Ground', 'ground', '', 'Digitals block: ground.'),
        P('DIO1', 'DIO1', 'ctrl', 'both', 'Digital 1 — shaft encoder (River Digital A/C).'),
        P('DIO2', 'DIO2', 'ctrl', 'both', 'Digital 2 — encoder direction (River Digital E).'),
        P('DIO3', 'DIO3', 'ctrl', 'in', 'Digital 3 — the rain gauge (Rain A).'),
        P('DIO4', 'DIO4', 'ctrl', 'both', 'Digital 4.'),
        T('d-g2', 'GND', 'Ground', 'ground', '', 'Digitals block: ground.'),
        T('a-g', 'GND', 'Ground', 'ground', '', 'Analogue block: ground.'),
        P('AI1-', 'AI1−', 'analog', 'out', 'Analogue input 1, − (River Analog B).'),
        P('AI1+', 'AI1+', 'analog', 'in', 'Analogue input 1, + (River Analog A).'),
        P('AI2-', 'AI2−', 'analog', 'out', 'Analogue input 2, − (terminals only).'),
        P('AI2+', 'AI2+', 'analog', 'in', 'Analogue input 2, + (terminals only).'),
        P('+24LOOP', '+24 LOOP', 'power', 'out', 'Switched 24 V loop supply, 50 mA (River Analog C).'),
        P('+12COMS', '+12 COMS', 'power', 'out', 'Sensor block: 12 V for SDI-12 and comms.'),
        T('s-g1', 'GND', 'Ground', 'ground', '', 'Sensor block: ground.'),
        P('RS485-', 'RS485−', 'bus', 'both', 'RS-485 −.'),
        P('RS485+', 'RS485+', 'bus', 'both', 'RS-485 +.'),
        P('SDI-12', 'SDI-12', 'bus', 'both', 'SDI-12 data.'),
        T('s-g2', 'GND', 'Ground', 'ground', '', 'Sensor block: ground.'),
        P('1-HTR', '1 · HTR', 'power', 'out', 'Supply block 1: heater.'),
        P('2-SOL', '2 · SOL', 'power', 'in', 'Supply block 2: solar in.'),
        P('3-GND', '3 · GND', 'ground', '', 'Supply block 3: ground.'),
        P('4-BAT', '4 · BAT', 'power', 'both', 'Supply block 4: battery. Not with an internal lithium battery fitted.'),
      ],
      notes: ['Each row of the drawing is one block. The internal DB9 marked SERIAL carries the same RS-232 as the MIL Serial connector: pin 2 TX, 3 RX, 5 GND.'],
      find: 'elpro ert-a2 erta2 internal terminals push-in dio ai loop rs485 sdi-12 htr sol bat',
    },
    {
      id: 'elpro-115e2-rs232', cat: 'alert', name: 'ELPRO 115E-2 gateway — RS-232 (RJ45, DCE)',
      short: '115E-2 · RS-232', unit: 'The ELPRO 115E-2 flood-warning gateway at a base: its RS-232 port, an RJ45 wired as a DCE (EIA-562)',
      face: { type: 'header' }, gender: 'F', sure: 'maker', sources: [SRC.e115],
      pins: [
        P(1, 'RI', 'ctrl', 'out', 'Ring Indicator.'),
        P(2, 'DCD', 'ctrl', 'out', 'Data Carrier Detect.'),
        P(3, 'DTR', 'ctrl', 'in', 'Data Terminal Ready — ELPRO marks it required.'),
        P(4, 'GND', 'ground', '', 'Ground — required.'),
        P(5, 'RXD', 'tx', 'out', '"Rx Data (from unit)" — required.'),
        P(6, 'TXD', 'rx', 'in', '"Tx Data (to unit)" — required.'),
        P(7, 'CTS', 'ctrl', 'out', 'Clear To Send.'),
        P(8, 'RTS', 'ctrl', 'in', 'Request To Send.'),
      ],
      notes: [
        'ELPRO\'s CBLSER-RJ45 is RJ45 (male) to DB9 (female), straight through, for a PC.',
        'An ERT-A2 receiver joins it on RS-485 instead: + (A) to A, − (B) to B, with the termination link fitted on the last receiver only. Its supply terminals are GND, BAT+, SUP− and SUP+.',
      ],
      find: 'elpro 115e 115e-2 gateway base station rj45 rs232 rs-232 dce eia-562',
    },

    // ── Campbell Scientific ALERT stations ──────────────────────────────────
    {
      id: 'al200x-radio', cat: 'alert', name: 'Campbell AL200X — radio plug (6 terminals)',
      short: 'AL200X · radio', unit: 'The AL200X ALERT/ALERT2 modem and sensor interface: its pluggable radio terminal block',
      face: { type: 'strip' }, gender: '', sure: 'maker', sources: [SRC.al200x],
      pins: [
        P('G', 'Ground', 'ground', '', 'Power and signal ground, bonded to the enclosure\'s earth lug.', 'Black (to DB9 4)'),
        P('SW12V', 'Switched 12 V', 'power', 'out', 'Switched power for the radio: 1.8 A at most (current limit 3 A).', 'Red (to DB9 5)'),
        P('PTT', 'Push to talk', 'ctrl', 'out', 'Grounded while transmitting — an open-collector output, active low, 40 V at most.', 'White (to DB9 3)'),
        P('Tx', 'Transmit audio', 'analog', 'out', 'The modulation for the radio: 100–900 mV peak to peak into 20 kΩ, centred on +1.25 V.', 'Green (to DB9 1)'),
        P('Rx', 'Receive audio', 'analog', 'in', 'From the radio\'s discriminator — for future use. 50–3400 mV peak to peak, 75 kΩ.'),
        P('RxCD', 'Carrier detect / RSSI', 'ctrl', 'in', 'Carrier detect (0–6.8 V) or RSSI (0–5 V) from the radio — for future use.'),
      ],
      notes: [
        'Wire colours are Campbell\'s 31924 cable to a Maxon SD-125 — the DB9 pin each goes to is in brackets (Cables, below).',
        'Every radio terminal has a 17 V surge clamp. The radio is powered only from SW12V, and only when the AL200X has its 9–18 V supply: USB alone powers the AL200X for setting up, not the radio or the sensors.',
        'A Maxon at 5 W can draw up to 2.0 A on transmit by Maxon\'s figures, above SW12V\'s 1.8 A rating — worth checking on a 5 W station.',
        'Not plug-compatible with the older AL200: different pitch (0.20″ against 0.15″) and a different order.',
      ],
      find: 'campbell al200x al200 x alert alert2 modem encoder radio plug terminal ptt sw12v tx rx rxcd',
    },
    {
      id: 'al200x-sensor', cat: 'alert', name: 'Campbell AL200X — sensor plug (9 terminals)',
      short: 'AL200X · sensors', unit: 'The AL200X\'s pluggable sensor terminal block: one analogue input, a rain gauge counter, three digital or SDI-12',
      face: { type: 'strip' }, gender: '', sure: 'maker', sources: [SRC.al200x],
      pins: [
        P('SE1', 'Analogue in', 'analog', 'in', '0–5 V, or 4–20 mA in milliamp mode across its own precision 100 Ω to ground (40 mA at most). 16 V at most.'),
        T('G1', 'G', 'Ground', 'ground', '', 'Ground — the reference for an analogue measurement goes to one of these two.'),
        P('SW12A', 'Switched 12 V (A)', 'power', 'out', 'Sensor power, switched on its own: 0.9 A.'),
        T('G2', 'G', 'Ground', 'ground', '', 'Ground.'),
        P('SW12B', 'Switched 12 V (B)', 'power', 'out', 'Sensor power, switched on its own: 0.9 A.'),
        P('P1', 'Pulse counter', 'ctrl', 'in', 'The tipping-bucket input: a switch closing to G counts one. 100 kΩ pull-up to 5 V; 100 Hz, 5 ms closed and 5 ms open at least.'),
        P('C1', 'Digital I/O or SDI-12', 'bus', 'both', '0–5 V digital, or an SDI-12 bus of its own. 200 kΩ pull-down; 16 V at most.'),
        P('C2', 'Digital I/O or SDI-12', 'bus', 'both', 'As C1 — each C terminal is an independent SDI-12 bus.'),
        P('C3', 'Digital I/O or SDI-12', 'bus', 'both', 'As C1.'),
      ],
      notes: [
        'Rain gauge: across P1 and G. SDI-12 sensor: data to C1 (or C2, C3), +12 V from SW12A or SW12B, ground to G — up to about ten sensors a channel at 60 m.',
        '4–20 mA: set SE1 to milliamps and wire the loop from SW12A or SW12B to the sensor\'s +, and the sensor\'s − to SE1. The 100 Ω is inside: an external resistor as well would sit across it and read low. Campbell recommends at least 11 V on the loop — 9 V for the sensor and 2 V for the measurement.',
        'Surge clamps on every sensor terminal, and gas discharge tubes on P1 and C1–C3.',
      ],
      find: 'campbell al200x sensor plug se1 p1 c1 c2 c3 sw12a sw12b rain gauge sdi-12 4-20',
    },
    {
      id: 'al200x-power', cat: 'alert', name: 'Campbell AL200X — power plug (2 terminals)',
      short: 'AL200X · power', unit: 'The AL200X\'s pluggable power terminal block',
      face: { type: 'strip' }, gender: '', sure: 'maker', sources: [SRC.al200x],
      pins: [
        P('G', 'Ground', 'ground', '', 'Negative ground.'),
        P('9-18Vdc', '+9 to +18 V', 'power', 'in', 'Supply in. Shuts down at 8.6 V (±0.3 V); clamped above 18.9 V; resettable fuses on both legs.'),
      ],
      notes: ['The radio\'s own limit may be lower than 18 V. Check polarity with a meter before the plug goes in.'],
      find: 'campbell al200x power plug supply battery 12v',
    },
    {
      id: 'al200x-rs232', cat: 'alert', name: 'Campbell AL200X — RS-232 (COM1), DE-9 female, DCE',
      short: 'AL200X · RS-232', unit: 'The AL200X\'s serial port, to a logger or a laptop',
      face: { type: 'dsub', shell: 'DE9' }, gender: 'F', sure: 'maker', sources: [SRC.al200x],
      pins: [
        P(1, 'DCD', 'ctrl', 'out', 'Data Carrier Detect, pulled up to +5 V through 3.3 kΩ.'),
        P(2, 'RXD', 'tx', 'out', 'The AL200X sends on this pin (the name is the computer\'s).'),
        P(3, 'TXD', 'rx', 'in', 'The AL200X listens on this pin.'),
        P(4, 'N/C', 'nc', '', 'Not connected.'),
        P(5, 'GND', 'ground', '', 'Signal ground.'),
        P(6, 'DSR', 'ctrl', 'out', 'Data Set Ready, pulled up to +5 V through 3.3 kΩ.'),
        P(7, 'N/C', 'nc', '', 'Not connected.'),
        P(8, 'CTS', 'ctrl', 'out', 'Clear To Send, pulled up to +5 V through 3.3 kΩ.'),
        P(9, 'N/C', 'nc', '', 'Not connected.'),
      ],
      notes: [
        'A laptop\'s port (DTE) takes a straight cable. A Campbell logger\'s RS-232 is DCE too: Campbell says a male-to-male null modem cable.',
        'Setting up is easier over USB (Type-C, an FTDI virtual COM port), which leaves this port to the logger.',
      ],
      find: 'campbell al200x rs232 rs-232 com1 db9 dce serial',
    },
    {
      id: 'al200-radio', cat: 'alert', name: 'Campbell AL200 (older) — radio plug (5 terminals)',
      short: 'AL200 · radio', unit: 'The older AL200 ALERT encoder: its pluggable radio terminal block (0.15″ pitch)',
      face: { type: 'strip' }, gender: '', sure: 'maker', sources: [SRC.al200],
      pins: [
        P('FREQ SEL', 'Frequency select', 'nc', '', 'Unused.'),
        P('SW12V', 'Switched 12 V', 'power', 'out', 'Radio power: 1.8 A.', 'Red (to DB9 5)'),
        P('PTT', 'Push to talk', 'ctrl', 'out', 'Grounded while transmitting.', 'White (to DB9 3)'),
        P('G', 'Ground', 'ground', '', 'Ground.', 'Black (to DB9 4)'),
        P('TX', 'Transmit audio', 'analog', 'out', 'Modulation to the radio, 100–1000 mV peak to peak.', 'Green (to DB9 1)'),
      ],
      notes: [
        'The same Campbell 31924 cable as the AL200X runs it to a Maxon SD-125EL: G to 4, SW12V to 5, PTT to 3, TX to 1 — but the plug\'s terminal order differs from the AL200X\'s.',
        'Its power plug is G and 12V (9–18 V), and its sensor plug SE1, SW12V, P1, G, C1 (C1 is the SDI-12 terminal).',
      ],
      find: 'campbell al200 older alert encoder radio plug freq sel',
    },
    {
      id: 'al200-rs232', cat: 'alert', name: 'Campbell AL200 (older) — RS-232, DE-9 female, DCE',
      short: 'AL200 · RS-232', unit: 'The older AL200\'s serial port',
      face: { type: 'dsub', shell: 'DE9' }, gender: 'F', sure: 'maker', sources: [SRC.al200],
      pins: [
        P(1, 'N/C', 'nc', '', 'Not connected.'),
        P(2, 'TXD (its own)', 'tx', 'out', 'The AL200 sends here. Campbell names it from the AL200\'s side: the standard name at a DCE\'s pin 2 is RXD.'),
        P(3, 'RXD (its own)', 'rx', 'in', 'The AL200 listens here — standard TXD.'),
        P(4, 'N/C', 'nc', '', 'Not connected.'),
        P(5, 'GND', 'ground', '', 'Signal ground.'),
        P(6, 'N/C', 'nc', '', 'Not connected.'),
        P(7, 'CTS (its own)', 'ctrl', 'in', 'Flow control into the AL200 — standard RTS.'),
        P(8, 'RTS (its own)', 'ctrl', 'out', 'Flow control out of the AL200 — standard CTS.'),
        P(9, 'N/C', 'nc', '', 'Not connected.'),
      ],
      notes: ['The pins sit where a DCE\'s do, so a laptop takes a straight cable; only the manual\'s names are from the other side. Reading the two manuals as one wiring is our reading — Campbell does not say so.'],
      find: 'campbell al200 rs232 rs-232 db9 dce serial',
    },
    {
      id: 'al200-csio', cat: 'alert', name: 'Campbell AL200 (older) — CS I/O, DE-9 male',
      short: 'AL200 · CS I/O', unit: 'The older AL200\'s CS I/O port, to a Campbell logger\'s CS I/O',
      face: { type: 'dsub', shell: 'DE9' }, gender: 'M', sure: 'maker', sources: [SRC.al200],
      pins: [
        P(1, 'N/C', 'nc', '', 'Not connected — the AL200 is not powered over CS I/O.'),
        P(2, 'GND', 'ground', '', 'Ground.'),
        P(3, 'Ring', 'ctrl', 'out', 'Raised to wake the logger.'),
        P(4, 'TXD', 'tx', 'out', 'Data from the AL200 — to the logger\'s pin 4 (its RXD).'),
        P(5, 'ME', 'ctrl', 'in', 'Modem enable, from the logger.'),
        P(6, 'SDE', 'ctrl', 'in', 'Synchronous device enable, from the logger.'),
        P(7, 'CLK/HS', 'ctrl', 'both', 'Clock / handshake.'),
        P(8, 'N/C', 'nc', '', 'Not connected.'),
        P(9, 'RXD', 'rx', 'in', 'Data to the AL200 — from the logger\'s pin 9 (its TXD).'),
      ],
      notes: ['CS I/O is 0–5 V logic, not RS-232 — see the logger\'s CS I/O entry. Pin for pin, a straight cable joins the two.'],
      find: 'campbell al200 cs i/o csio cs-io',
    },
    {
      id: 'al205e-tx', cat: 'alert', name: 'Campbell AL205E — transmit header (5 pins)',
      short: 'AL205E · TX header', unit: 'The AL205-series ALERT encoder\'s radio header, numbered from the left facing the unit',
      face: { type: 'header' }, gender: 'M', sure: 'maker', sources: [SRC.al205e, SRC.cs42877],
      pins: [
        P(1, 'AO', 'analog', 'out', 'RF data out of the AL205E — the modulation to the radio.', 'Green'),
        P(2, 'G', 'ground', '', 'Ground.', 'Black'),
        P(3, 'PTT', 'ctrl', 'out', 'Push to talk.', 'White'),
        P(4, '12V', 'power', 'out', '12 V for the radio, from the AL205E (9–17 V supply).', 'Red'),
        P(5, 'CS', 'ctrl', 'out', 'Channel select — no connection on the Maxon cables, blue to DB15 pin 1 on the Ritron ones.', 'Blue (Ritron only)'),
      ],
      notes: ['Wire colours are Campbell\'s AL205-series radio cables (42877 / 35705 to a Maxon, 42878 / 35706 to a Ritron).'],
      find: 'campbell al205 al205e header transmit tx ao ptt cs',
    },
    {
      id: 'al205-rx', cat: 'alert', name: 'Campbell AL205B/R — receive header (4 pins)',
      short: 'AL205B/R · RX header', unit: 'The AL205B and AL205R\'s receive header, labelled 12V G AI CS',
      face: { type: 'header' }, gender: 'M', sure: 'second', sources: [SRC.cs42875],
      pins: [
        P(1, '12V', 'power', 'out', '12 V for the receive radio.', 'Red'),
        P(2, 'G', 'ground', '', 'Ground.', 'Black'),
        P(3, 'AI', 'analog', 'in', 'RF data in — the radio\'s receive audio.', 'Yellow'),
        P(4, 'CS', 'ctrl', 'out', 'Channel select — not connected on the cables.'),
      ],
      notes: [
        'From Campbell\'s cable listings only: no AL205B or AL205R manual could be found.',
        'Campbell\'s combined TX/RX cables leave this header\'s 12V and G unconnected and power the radio from the TX header; the receive-only cables power it from here. Don\'t mix the parts of the two.',
      ],
      find: 'campbell al205b al205r header receive rx ai',
    },

    // ── Radios ──────────────────────────────────────────────────────────────
    {
      id: 'maxon-sd125', cat: 'alert', name: 'Maxon SD-125 data radio — DE-9 male',
      short: 'Maxon SD-125 · DB9', unit: 'The Maxon SD-125 (SD-125E, SD-125EL; V2 148–174 MHz) ALERT data radio: its 9-pin accessory socket',
      face: { type: 'dsub', shell: 'DE9' }, gender: 'M', sure: 'maker', sources: [SRC.sd125, SRC.cs44566],
      pins: [
        P(1, 'Audio in', 'analog', 'in', 'Transmit modulation into the radio, from the encoder\'s Tx or AO. Maxon\'s label adds "(Data RX)" — go by "Audio in".', 'Green'),
        P(2, 'Audio out', 'analog', 'out', 'Receive audio (discriminator) out of the radio. Maxon adds "(Data TX)" — go by "Audio out".', 'Yellow'),
        P(3, 'PTT', 'ctrl', 'in', 'Ground it to transmit.', 'White'),
        P(4, 'GND', 'ground', '', 'Ground.', 'Black'),
        P(5, 'B+', 'power', 'in', 'Supply: Maxon\'s wiring diagram says 8–18 V; its specification 9–15 V at the extremes. 9–15 V suits every source.', 'Red'),
        P(6, 'Carrier detect', 'ctrl', 'out', 'Squelch / carrier detect. Its polarity and levels are not in any document found.'),
        P(7, 'N/C', 'nc', '', 'No connection.'),
        P(8, 'Switch', 'unknown', '', 'Labelled "Switch"; what it does is not documented. Leave it unconnected.'),
        P(9, 'Speaker', 'analog', 'out', 'Monitor speaker out.'),
      ],
      notes: [
        'Male (pins) on the radio; Campbell\'s cables end in a female DB9. The colour numbers on Campbell\'s listings ("Green 1, Yellow 2, White 3, Black 4, Red 5") are these DB9 pin numbers.',
        'RF: a BNC socket. 1 W or 5 W, programmable. Standby under 65 mA (Campbell measures 23 mA); transmit under 2.0 A at 5 W, under 1.0 A at 1 W.',
        'An encoder\'s audio is a few hundred millivolts: never put a 12 V or a logic signal on pin 1.',
      ],
      find: 'maxon sd125 sd-125 sd125e sd125el sd-125el data radio alert vhf uhf db9 audio ptt carrier',
    },
    {
      id: 'ritron-rf320', cat: 'alert', name: 'Ritron DTX radio (Campbell RF320) — DA-15 female',
      short: 'Ritron RF320 · DB15', unit: 'Campbell\'s RF320 (a Ritron DTX-L) ALERT radio: its 15-pin accessory socket',
      face: { type: 'dsub', shell: 'DA15' }, gender: 'F', sure: 'maker', sources: [SRC.rf320],
      pins: [
        P(1, 'CS0', 'ctrl', 'in', 'Channel select bit 0 — internal pull-up: ground for 0, open for 1.', 'Blue'),
        P(2, 'CS1', 'ctrl', 'in', 'Channel select bit 1.'),
        P(3, 'CS2', 'ctrl', 'in', 'Channel select bit 2.'),
        P(4, 'MIC IN', 'analog', 'in', 'Microphone in.'),
        P(5, 'HI/LO POWER', 'ctrl', 'in', 'Internal pull-up: ground for low power, open for high.'),
        P(6, '9–17 V IN', 'power', 'in', 'Supply in.', 'Red'),
        P(7, 'AUX IN', 'analog', 'in', 'Transmit data in, 0.1–5 V peak to peak — from the encoder\'s AO.', 'Green'),
        P(8, 'AUX OUT', 'analog', 'out', 'Receive data out, 0–3 V peak to peak — to a receiver\'s AI.', 'Yellow'),
        P(9, 'PC PGM PORT', 'bus', 'both', 'Programming port.'),
        P(10, 'VOLUME CNTL', 'analog', 'in', 'Volume control.'),
        P(11, 'AUX MON', 'analog', 'out', 'Auxiliary monitor.'),
        P(12, 'SPKR OUT', 'analog', 'out', 'Speaker out.'),
        P(13, 'CARRIER DET', 'ctrl', 'out', 'Carrier detect.'),
        P(14, 'PTT', 'ctrl', 'in', 'Push to talk (printed "PPT" in the manual).', 'White'),
        P(15, 'GND', 'ground', '', 'Ground.', 'Black'),
      ],
      notes: [
        'Female on the radio; Campbell\'s Ritron cables end in a male DB15. Check the supply between pin 6 (+) and pin 15 (−): 9 to 17 V.',
        'RF: a BNC socket. 2 W or 5 W; under 1.2 A at 5 W, 25 mA standing by.',
      ],
      find: 'ritron dtx dtx-l rf320 campbell radio db15 da15 15 pin alert',
    },

    // ── Loggers and modems ──────────────────────────────────────────────────
    {
      id: 'beam-9602n', cat: 'logger', name: 'Beam 9602N SBD modem — DE-9 female, DCE',
      short: 'Beam 9602N · DB9', unit: 'Beam Communications\' 9602N Iridium SBD modem: the serial socket on its Power & IO cable',
      face: { type: 'dsub', shell: 'DE9' }, gender: 'F', sure: 'maker', sources: [SRC.beam],
      pins: [
        P(1, 'DCD', 'ctrl', 'out', 'Data Carrier Detect. The manual contradicts itself — "driven ON at all times" in its table, "OFF at all times" in its text. Do not rely on it.'),
        P(2, 'RXD', 'tx', 'out', 'Data out of the modem.'),
        P(3, 'TXD', 'rx', 'in', 'Data into the modem.'),
        P(4, 'DTR', 'ctrl', 'in', 'Active low. Unless set AT&D0, DTR off for 10 s puts the port into a UART test mode and the modem stops answering AT commands.'),
        P(5, 'GND', 'ground', '', 'Signal ground.'),
        P(6, 'DSR', 'ctrl', 'out', 'On when the port is ready for AT commands.'),
        P(7, 'RTS', 'ctrl', 'in', 'Flow control in.'),
        P(8, 'CTS', 'ctrl', 'out', 'Flow control out, active low (the manual\'s table misprints its direction; its text has it right).'),
        P(9, 'RI', 'ctrl', 'out', 'Ring: on when a message for the station (mobile-terminated SBD) is waiting at the gateway; off after 5 s or when a session starts.'),
      ],
      notes: [
        'Default 19200 baud 8N1 with RTS/CTS flow control, and no autobaud (AT+IPR sets 600 to 115200). On three wires — TX, RX and ground — set AT&D0 (ignore DTR) and AT&K0 (no flow control), as the manual says, and store them.',
        'To a Campbell CR300: both ports are female DCE, so a male-to-male null modem goes between (Cables, below).',
        'The USB socket (mini-B) wins over this port: a laptop left plugged into USB cuts the logger off.',
        'Power: 9–32 V, 1 A, on the cable\'s 4-pin Molex (Beam modem · power, below). Antenna: an SMA socket, with a TNC adapter in the box; keep the cable to 2 dB of loss. Connect power before the antenna; take the antenna off before the power.',
        'The 14-pin connector on the modem itself has no published pinout — use Beam\'s Power & IO cable (CBLASY0146), and don\'t confuse the modem with NAL Research\'s 9602-NAL, which carries power on a 15-pin D-sub.',
      ],
      find: 'beam 9602n 9602 n sbd iridium satellite satcom modem db9 dce serial at commands',
    },
    {
      id: 'beam-power', cat: 'logger', name: 'Beam 9602N SBD modem — power (4-pin Molex)',
      short: 'Beam 9602N · power', unit: 'The DC power lead on the 9602N\'s Power & IO cable',
      face: { type: 'strip' }, gender: '', sure: 'maker', sources: [SRC.beam],
      pins: [
        P('Red', '+9 to +32 V', 'power', 'in', 'Positive. Fit a 1 A or 2 A fuse.', 'Red'),
        P('Black', '0 V', 'ground', '', 'Negative — and, by the quick start guide, to earth ground too.', 'Black'),
        P('Yellow', 'Not used', 'nc', '', 'Not used.', 'Yellow'),
      ],
      notes: ['Beam publishes the wire colours, not the Molex\'s pin numbers — go by colour. Idle about 30 mA, 125 mA peaks on transmit, at 12 V.'],
      find: 'beam 9602n power molex supply',
    },
    {
      id: 'cr300-rs232', cat: 'logger', name: 'Campbell CR300 / CR310 — RS-232, DE-9 female',
      short: 'CR300 · RS-232', unit: 'The CR300 and CR310 data loggers\' RS-232 port',
      face: { type: 'dsub', shell: 'DE9' }, gender: 'F', sure: 'second', sources: [SRC.cr300, SRC.cr1000],
      pins: [
        P(1, 'DTR', 'ctrl', 'out', 'Tied to pin 6 — not a standard DCE pin.'),
        P(2, 'TXD (its own)', 'tx', 'out', 'The logger sends here (a DCE\'s pin 2).'),
        P(3, 'RXD (its own)', 'rx', 'in', 'The logger listens here.'),
        P(4, 'N/A', 'nc', '', 'Not connected — not a standard DCE pin.'),
        P(5, 'GND', 'ground', '', 'Ground.'),
        P(6, 'DTR', 'ctrl', 'out', 'Logger ready — not a standard DCE pin.'),
        P(7, 'CTS (its own)', 'ctrl', 'in', 'Flow control into the logger.'),
        P(8, 'RTS (its own)', 'ctrl', 'out', 'Flow control out of the logger.'),
        P(9, 'RI', 'ctrl', 'in', 'Ring in — not a standard DCE pin.'),
      ],
      warn: '<strong>Pin by pin, this is the CR1000\'s table.</strong> The CR300 manual confirms a female DE-9 working as a DCE, with pins 1, 4, 6 and 9 "different from a standard DCE device", but prints no pin table; the CR1000\'s manual says the same words and prints this one. Meter it before trusting pins 1, 4, 6 and 9.',
      notes: [
        'Campbell names these pins from the logger\'s side (TXD is what it sends). A modem — Beam, Campbell COM9602 — needs the 18663 male-to-male null modem; a laptop takes a straight cable.',
        'The port sleeps between uses (a 40 s timeout); SerialOpen() keeps it awake. No autobaud on the CR300.',
      ],
      find: 'campbell cr300 cr310 logger datalogger rs232 rs-232 db9 serial dce null modem',
    },
    {
      id: 'cr300-top', cat: 'logger', name: 'Campbell CR300 / CR310 — upper terminals',
      short: 'CR300 · upper row', unit: 'The CR300 series wiring panel\'s upper row: excitation, counters, control ports, switched 12 V, power and charge',
      face: { type: 'strip' }, gender: '', sure: 'maker', sources: [SRC.cr300],
      pins: [
        P('VX1', 'Excitation 1', 'power', 'out', 'Voltage excitation for a bridge or a potentiometer.'),
        T('G1', 'G', 'Power ground', 'ground', '', 'Power ground (G) — one of six.'),
        P('VX2', 'Excitation 2', 'power', 'out', 'Voltage excitation.'),
        T('G2', 'G', 'Power ground', 'ground', '', 'Power ground.'),
        P('P_SW', 'Pulse (switch closure)', 'ctrl', 'in', 'A tipping-bucket rain gauge goes here and G.'),
        T('G3', 'G', 'Power ground', 'ground', '', 'Power ground.'),
        P('C1', 'Control port 1', 'bus', 'both', 'SDI-12, pulse counting, digital I/O, or the TX of a 0–5 V logic serial port (Com1). 5 V out; −10 to +15 V in.'),
        T('G4', 'G', 'Power ground', 'ground', '', 'Power ground.'),
        P('C2', 'Control port 2', 'bus', 'both', 'As C1 — the RX of Com1.'),
        T('G5', 'G', 'Power ground', 'ground', '', 'Power ground.'),
        P('SW12V', 'Switched 12 V', 'power', 'out', 'Battery voltage, switched by the program: 1.1 A thermal fuse. Off when the logger runs on USB alone.'),
        T('G6', 'G', 'Power ground', 'ground', '', 'Power ground.'),
        P('BAT−', 'Battery −', 'ground', '', 'Battery negative.'),
        P('BAT+', 'Battery +', 'power', 'in', '10 to 18 V in (a partial shutdown above 19 V).'),
        P('CHG−', 'Charge −', 'ground', '', 'Charger negative.'),
        P('CHG+', 'Charge +', 'power', 'in', '16 to 32 V from a solar panel or charger; limited to 0.9 A.'),
      ],
      warn: 'The order shown is read off the manual\'s drawing of a CR310 — check it against the labels on the panel.',
      notes: ['The C terminals are 0–5 V logic, not RS-232: a serial device on C1/C2 must use logic levels or go through an interface.'],
      find: 'campbell cr300 cr310 terminals wiring panel vx p_sw c1 c2 sw12v bat chg control port',
    },
    {
      id: 'cr300-analog', cat: 'logger', name: 'Campbell CR300 / CR310 — lower (analogue) terminals',
      short: 'CR300 · lower row', unit: 'The CR300 series wiring panel\'s lower row: six single-ended (three differential) analogue inputs',
      face: { type: 'strip' }, gender: '', sure: 'maker', sources: [SRC.cr300],
      pins: [
        T('SG1', '⏚', 'Signal ground', 'ground', '', 'Signal ground (⏚) — the reference for analogue sensors; one of five.'),
        P('P_LL', 'Pulse (low level)', 'analog', 'in', 'Low-level AC pulses — an anemometer\'s, say.'),
        T('SG2', '⏚', 'Signal ground', 'ground', '', 'Signal ground.'),
        P('3L', 'SE6 / Diff 3 low', 'analog', 'in', 'Single-ended 6, or the low side of differential 3.'),
        P('3H', 'SE5 / Diff 3 high', 'analog', 'in', 'Single-ended 5, or the high side of differential 3.'),
        T('SG3', '⏚', 'Signal ground', 'ground', '', 'Signal ground.'),
        P('2L', 'SE4 / Diff 2 low', 'analog', 'in', 'Single-ended 4.'),
        P('2H', 'SE3 / Diff 2 high', 'analog', 'in', 'Single-ended 3.'),
        T('SG4', '⏚', 'Signal ground', 'ground', '', 'Signal ground.'),
        P('1L', 'SE2 / Diff 1 low', 'analog', 'in', 'Single-ended 2 — one of the two terminals that measure 4–20 mA directly.'),
        P('1H', 'SE1 / Diff 1 high', 'analog', 'in', 'Single-ended 1 — measures 4–20 mA directly (CurrentSE).'),
        T('SG5', '⏚', 'Signal ground', 'ground', '', 'Signal ground.'),
      ],
      warn: 'The order shown is read off the manual\'s drawing of a CR310 — check it against the labels on the panel.',
      notes: [
        '4–20 mA: only SE1 and SE2, set up with CurrentSE(), across the logger\'s own 100 Ω (140 Ω in all to ground), 0–25 mA. No external resistor. A logger-powered two-wire loop: the sensor\'s + to 12 V, its − (signal) to SE1 or SE2. More than two loops need CURS100 modules.',
        'Analogue sensors reference ⏚; power returns go to G. Keeping the two apart keeps supply current out of the measurement.',
      ],
      find: 'campbell cr300 cr310 analogue analog se1 se2 single ended differential 4-20 current p_ll signal ground',
    },
    {
      id: 'campbell-csio', cat: 'logger', name: 'Campbell CS I/O — DE-9 male (CR1000X, CR1000, CR800, CR6)',
      short: 'Campbell CS I/O', unit: 'The CS I/O port on Campbell\'s larger loggers — a DE-9 that is not RS-232',
      face: { type: 'dsub', shell: 'DE9' }, gender: 'M', sure: 'maker', sources: [SRC.cr1000x, SRC.cr1000],
      pins: [
        P(1, '5 V', 'power', 'out', 'Sources 5 V to power peripherals (200 mA at most on a CR1000X).'),
        P(2, 'SG', 'ground', '', 'Signal ground — the return for pin 1 and the reference for the logic levels.'),
        P(3, 'RING', 'ctrl', 'in', 'Raised by a peripheral to wake the logger.'),
        P(4, 'RXD', 'rx', 'in', 'Serial data from a peripheral.'),
        P(5, 'ME', 'ctrl', 'out', 'Modem enable — raised when the logger answers a ring.'),
        P(6, 'SDE', 'ctrl', 'out', 'Synchronous device enable.'),
        P(7, 'CLK/HS', 'ctrl', 'both', 'Clock / handshake.'),
        P(8, '12 V', 'power', 'out', 'Nominal 12 V — whatever the logger\'s supply is: 16 V in means 16 V here.'),
        P(9, 'TXD', 'tx', 'out', 'Serial data to a peripheral: 0 V marking, 5 V spacing, 8N1.'),
      ],
      warn: '<strong>Not RS-232.</strong> It carries 5 V on pin 1 and 12 V on pin 8, and 0/5 V logic on the data pins. An RS-232 device plugged in here can be damaged, or damage the logger. Campbell\'s SC105 or SC932A goes between.',
      notes: ['The CR300 has no CS I/O port. The CR1000X\'s RS-232 is the RJ45 next to it (CR1000X · RS-232/CPI).'],
      find: 'campbell cs i/o csio cs-io cr1000x cr1000 cr800 cr6 logger db9 sc105 sc932a',
    },
    {
      id: 'cr1000x-cpi', cat: 'logger', name: 'Campbell CR1000X — RS-232/CPI (RJ45)',
      short: 'CR1000X · RS-232/CPI', unit: 'The CR1000X\'s RS-232 port, on an RJ45 jack shared with CPI',
      face: { type: 'header' }, gender: 'F', sure: 'maker', sources: [SRC.cr1000x, SRC.cs31055],
      pins: [
        P(1, 'RS-232 Tx', 'tx', 'out', 'Data out of the logger.'),
        P(2, 'RS-232 Rx', 'rx', 'in', 'Data into the logger.'),
        P(3, 'Ground', 'ground', '', 'Ground through 100 Ω.'),
        P(4, 'CPI data', 'bus', 'both', 'CPI only.'),
        P(5, 'CPI data', 'bus', 'both', 'CPI only.'),
        P(6, 'Ground', 'ground', '', 'Ground through 100 Ω.'),
        P(7, 'CTS / Sync', 'ctrl', 'in', 'RS-232 CTS, or CPI sync.'),
        P(8, 'DTR / Sync', 'ctrl', 'out', 'RS-232 DTR, or CPI sync.'),
      ],
      notes: [
        'Not the Cisco console (EIA/TIA-561) layout: a generic console cable will not work. Use Campbell\'s 31055 (DB9 male, DTE — for a modem) or 31056 (DB9 female — for a PC).',
        'Defaults to 115200 baud, autobaud, 8N1.',
      ],
      find: 'campbell cr1000x rs232 rs-232 cpi rj45 31055 31056',
    },
  ];

  // ── Cables ─────────────────────────────────────────────────────────────────
  // Each end names the connector it plugs into (so the pin names are that
  // unit's) and its own gender. wires: [a pin, b pin, note?]. loops: pins
  // joined at one end only.
  const CABLES = [
    {
      id: 'straight-de9', name: 'Straight-through DE-9 extension (male to female)', sure: 'standard', sources: [SRC.tia574],
      a: { conn: 'rs232-de9-dte', gender: 'F', label: 'Plugs into the computer (DTE)' },
      b: { conn: 'rs232-de9-dce', gender: 'M', label: 'Plugs into the modem (DCE)' },
      wires: [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9]],
      notes: ['Joins a computer to a modem: every pin to the same pin. Wrong for two computers — that needs a null modem.'],
    },
    {
      id: 'null-3', name: 'Null modem, three wires (female to female)', sure: 'standard', sources: [SRC.tia574],
      a: { conn: 'rs232-de9-dte', gender: 'F', label: 'Computer A' },
      b: { conn: 'rs232-de9-dte', gender: 'F', label: 'Computer B' },
      wires: [[2, 3, 'A hears what B sends'], [3, 2, 'B hears what A sends'], [5, 5, 'Ground to ground']],
      loops: { a: [[7, 8], [4, 6], [4, 1]], b: [[7, 8], [4, 6], [4, 1]] },
      notes: [
        'Laptop to logger, logger to logger: two DTEs. TX crosses to RX and ground runs straight.',
        'The loops at each end answer that end\'s own handshake, so a port waiting on CTS, DSR or DCD goes ahead. Leave them out when both ends have flow control off.',
      ],
    },
    {
      id: 'null-full', name: 'Null modem with full handshaking (female to female)', sure: 'standard', sources: [SRC.tia574],
      a: { conn: 'rs232-de9-dte', gender: 'F', label: 'Computer A' },
      b: { conn: 'rs232-de9-dte', gender: 'F', label: 'Computer B' },
      wires: [[2, 3], [3, 2], [5, 5], [4, 6, 'A ready → B\'s DSR (and DCD)'], [6, 4, 'B ready → A\'s DSR (and DCD)'], [7, 8, 'A asks → B clear'], [8, 7, 'B asks → A clear']],
      loops: { a: [[6, 1]], b: [[6, 1]] },
      notes: ['For two ends that both use hardware flow control: each end\'s RTS drives the other\'s CTS, and its DTR the other\'s DSR and DCD.'],
    },
    {
      id: 'loopback-de9', name: 'Loopback test plug (DE-9 female)', sure: 'standard', sources: [SRC.tia574],
      a: { conn: 'rs232-de9-dte', gender: 'F', label: 'Plugs into the port under test' },
      b: null,
      wires: [],
      loops: { a: [[2, 3], [7, 8], [4, 6], [4, 1]] },
      notes: [
        'The quickest test of a serial port or USB adapter: plug it in, open a terminal at any speed, and type. Every character echoed back means the port sends and receives.',
        'No echo with the plug in: wrong COM port, a dead adapter or driver, or a terminal set for flow control the plug does not answer.',
      ],
    },
    {
      id: 'de9-db25', name: 'DE-9 to DB-25 adapter (the AT mapping)', sure: 'standard', sources: [SRC.tia574, SRC.eia232],
      a: { conn: 'rs232-de9-dte', gender: 'F', label: 'DE-9 end' },
      b: { conn: 'rs232-db25-dte', gender: 'F', label: 'DB-25 end' },
      wires: [[1, 8], [2, 3], [3, 2], [4, 20], [5, 7], [6, 6], [7, 4], [8, 5], [9, 22]],
      notes: ['Same signals, different pins. This is wiring, not a null modem: a DTE stays a DTE.'],
    },
    {
      id: 'erta2-cblserert', name: 'ERT-A2 (or ERRTS canister) Serial to a PC — ELPRO CBLSERERT', sure: 'maker', sources: [SRC.erta2, SRC.erta2deck],
      a: { conn: 'erta2-serial', gender: 'F', label: 'Onto the 6-pin MIL Serial connector' },
      b: { conn: 'rs232-de9-dte', gender: 'F', label: 'DB9, onto the PC or USB adapter' },
      wires: [['A', 3, 'The PC sends → the ERT-A2 receives'], ['B', 2, 'The ERT-A2 sends → the PC receives'], ['C', 5, 'Ground']],
      notes: [
        'Three wires, RS-232 at the ERT-A2\'s default. ELPRO gives the mapping, not the DB9\'s sex; to a PC\'s male port it is female, as drawn.',
        'Unplug the ERT-A2\'s USB first — its RS-232 does not work with USB connected.',
      ],
    },
    {
      id: 'al200x-sd125', name: 'AL200X (or AL200) to a Maxon SD-125 — Campbell 31924', sure: 'maker', sources: [SRC.al200x, SRC.cs31924],
      a: { conn: 'al200x-radio', gender: '', label: 'Flying leads into the radio plug' },
      b: { conn: 'maxon-sd125', gender: 'F', label: 'DB9 female, onto the radio' },
      wires: [['G', 4, '', 'Black'], ['SW12V', 5, '', 'Red'], ['PTT', 3, '', 'White'], ['Tx', 1, 'Modulation to the radio\'s audio in', 'Green']],
      notes: [
        'Four wires: the AL200X does not use the radio\'s receive audio or carrier detect. On the older AL200 the same four colours go to G, SW12V, PTT and TX, which sit in a different order on its plug.',
        'Fit the radio\'s DB9 last, after checking SW12V is off or the station is powered down.',
      ],
    },
    {
      id: 'al205-maxon-tx', name: 'AL205E transmit header to a Maxon — Campbell 42877 / 35705', sure: 'maker', sources: [SRC.cs42877, SRC.al205e],
      a: { conn: 'al205e-tx', gender: 'F', label: 'Onto the AL205E\'s TX header' },
      b: { conn: 'maxon-sd125', gender: 'F', label: 'DB9 female, onto the radio' },
      wires: [[1, 1, 'RF data out → the radio\'s audio in', 'Green'], [2, 4, '', 'Black'], [3, 3, '', 'White'], [4, 5, '12 V for the radio', 'Red']],
      notes: ['Header pin 5 (CS) is not connected on the Maxon cables. The combined TX/RX cable (42879 / 35707) adds yellow from the RX header\'s AI to DB9 pin 2 — and its listing wrongly names pin 2 among the unconnected ones.'],
    },
    {
      id: 'al205-maxon-rx', name: 'AL205B/R receive header to a Maxon — Campbell 42875 / 35703', sure: 'second', sources: [SRC.cs42875],
      a: { conn: 'al205-rx', gender: 'F', label: 'Onto the receive header' },
      b: { conn: 'maxon-sd125', gender: 'F', label: 'DB9 female, onto the radio' },
      wires: [[1, 5, '12 V for the radio', 'Red'], [2, 4, '', 'Black'], [3, 2, 'The radio\'s receive audio → AI', 'Yellow']],
      notes: ['The receive-only cable powers the radio from this header; the combined TX/RX cable does not. Don\'t mix the parts.'],
    },
    {
      id: 'al205-ritron-tx', name: 'AL205E transmit header to a Ritron (RF320) — Campbell 42878 / 35706', sure: 'maker', sources: [SRC.al205e, SRC.rf320],
      a: { conn: 'al205e-tx', gender: 'F', label: 'Onto the AL205E\'s TX header' },
      b: { conn: 'ritron-rf320', gender: 'M', label: 'DB15 male, onto the radio' },
      wires: [[1, 7, 'RF data → AUX IN', 'Green'], [2, 15, '', 'Black'], [3, 14, '', 'White'], [4, 6, '12 V for the radio', 'Red'], [5, 1, 'Channel select → CS0', 'Blue']],
      notes: ['Campbell\'s listing for this cable names DB15 pin 14 among the unconnected pins, though white 14 is PTT — the radio\'s own manual agrees it is PTT.'],
    },
    {
      id: 'cr300-beam', name: 'CR300 to a Beam 9602N modem — null modem (Campbell 18663, male to male)', sure: 'second', sources: [SRC.cs18663, SRC.com9602, SRC.beam],
      a: { conn: 'cr300-rs232', gender: 'M', label: 'Into the CR300\'s RS-232' },
      b: { conn: 'beam-9602n', gender: 'M', label: 'Into the modem\'s DB9' },
      wires: [[2, 3, 'Logger sends → modem\'s data in'], [3, 2, 'Modem\'s data out → logger'], [5, 5, 'Ground'], [6, 4, 'Logger ready → modem\'s DTR'], [4, 6, 'Modem\'s DSR → logger pin 4 (unused there)'],
        [8, 7, 'Logger → modem\'s RTS'], [7, 8, 'Modem\'s CTS → logger']],
      loops: { a: [[1, 6]], b: [[1, 6]] },
      notes: [
        'Both ports are female DCE, so a standard full-handshake null modem joins them. Campbell specifies the 18663 for its own Iridium modems (COM9602, COM9522B) on a CR300; it names no cable for the Beam, which is the same kind of port — so this is our reading, not Campbell\'s or Beam\'s.',
        'If the logger lets its port sleep, DTR drops and the Beam goes into its UART test mode after 10 s: keep the port open with SerialOpen(), or set the modem AT&D0 and store it (AT&W0, AT&Y0). Unless the program handles RTS/CTS, set AT&K0 too.',
        'The modem\'s RI (pin 9) is not carried, so the logger cannot see a waiting message — it has to ask.',
      ],
    },
    {
      id: 'hs40-cr300', name: 'HS40 (WL3100) to a CR300 — 4–20 mA on SE1, SDI-12 on C1', sure: 'general', sources: [SRC.hs40s2, SRC.cr300],
      a: { conn: 'hs40-sensor', gender: '', label: 'The HS40\'s output block' },
      b: { conns: ['cr300-top', 'cr300-analog'], gender: '', label: 'The CR300\'s terminals' },
      wires: [['+S', 'cr300-top:BAT+', 'Loop power from the logger\'s 12 V (SW12V instead needs a warm-up)'], ['−S', 'cr300-analog:1H', 'The loop into SE1 — CurrentSE(), no resistor'],
        ['12', 'cr300-top:BAT+', 'Sensor power — or straight to the battery'], ['0V', 'cr300-top:G6', 'Sensor 0 V to a power ground (G)'], ['Da', 'cr300-top:C1', 'Optional: SDI-12 as well']],
      notes: [
        'Put together from KISTERS\' terminal table and Campbell\'s drawing of a logger-powered two-wire loop — neither maker draws this exact hook-up.',
        'The CR300\'s input is 140 Ω to ground. On a 12.0 V battery that leaves the sensor 9.2 V at 20 mA but 8.6 V at its 24 mA fault — short of the 9 V it needs, so a fault may read as something less. A flat battery takes the 20 mA end with it.',
      ],
    },
    {
      id: 'hs40-al200x', name: 'HS40 (WL3100) to an AL200X — 4–20 mA on SE1', sure: 'general', sources: [SRC.hs40s2, SRC.al200x],
      a: { conn: 'hs40-sensor', gender: '', label: 'The HS40\'s output block' },
      b: { conn: 'al200x-sensor', gender: '', label: 'The AL200X\'s sensor plug' },
      wires: [['+S', 'SW12A', 'Loop power, switched — set a warm-up'], ['−S', 'SE1', 'SE1 set to milliamps — 100 Ω inside, no resistor'],
        ['12', 'SW12B', 'Sensor power, switched with a warm-up (15 s unless Continuous Mode)'], ['0V', 'G1', 'Sensor 0 V'], ['Da', 'C1', 'Optional: SDI-12 instead of, or as well as, the loop']],
      notes: [
        'Put together from the two manuals — the AL200X manual draws no loop. It asks for at least 11 V on a 4–20 mA loop (9 V for the sensor, 2 V for the measurement), and warns against joining an AL200X power terminal to a sensor powered by something else: so here both the sensor and its loop are powered from the AL200X.',
        'The AL200X\'s range is 4.0–20.0 mA (40 mA without damage); whether it reads the WL3100\'s 24 mA fault, or clips it, is not stated.',
      ],
    },
  ];

  // ── Where pins sit ─────────────────────────────────────────────────────────
  // D-sub shells: pins in each row, front of the male insert, pin 1 top left.
  const DSUB = {
    DE9:  [5, 4],
    DA15: [8, 7],
    DB25: [13, 12],
  };

  const byId = id => CONNECTORS.find(c => c.id === id) || null;
  const cableById = id => CABLES.find(c => c.id === id) || null;

  // The connectors one end of a cable lands on: usually one, but a hook-up to a
  // logger's panel can span two rows of terminals (`conns`).
  const endConns = end => (end ? (end.conns || [end.conn]).map(byId).filter(Boolean) : []);
  // A wire's end, as written in CABLES — a pin number, or 'connector:pin' where
  // the end spans several — resolved to its connector and pin.
  function endPin(end, ref) {
    const r = String(ref);
    const list = endConns(end);
    const i = r.indexOf(':');
    if (i > 0) {
      const c = byId(r.slice(0, i));
      const p = c && list.includes(c) ? c.pins.find(x => x.n === r.slice(i + 1)) : null;
      return p ? { c, p, key: r } : null;
    }
    for (const c of list) {
      const p = c.pins.find(x => x.n === r);
      if (p) return { c, p, key: list.length > 1 ? `${c.id}:${r}` : r };
    }
    return null;
  }

  // Is the face drawn mirrored? Seen from the front, a socket insert is the pin
  // insert's mirror image; seen from the back, so is either.
  function mirrored(gender, back) { return (gender === 'F') !== !!back; }

  // Pin centres in pitch units, origin at the face's centre, y down; plus the
  // outline. `gender` and `back` decide the mirroring.
  function layout(conn, gender, back) {
    const f = conn.face, flip = mirrored(gender, back) && (f.type === 'dsub' || f.type === 'circular') ? -1 : 1;
    if (f.type === 'dsub') {
      const rows = DSUB[f.shell];
      const pts = [];
      let n = 1;
      rows.forEach((count, r) => {
        for (let i = 0; i < count; i++) {
          const x = (i - (count - 1) / 2);
          pts.push({ n: String(n++), x: x * flip || 0, y: r === 0 ? -0.55 : 0.55 });
        }
      });
      return { type: 'dsub', pts, flip };
    }
    if (f.type === 'circular') {
      const pts = Object.entries(f.at).map(([n, [x, y]]) => ({ n, x: x * flip || 0, y }));
      return { type: 'circular', pts, flip };
    }
    // A strip of terminals or a pin header: one row, in the order listed, as
    // printed on the unit. Never mirrored — it reads the same from either side.
    const pts = conn.pins.map((p, i) => ({ n: p.n, x: i, y: 0 }));
    return { type: f.type, pts, flip: 1 };
  }

  // ── 4–20 mA ────────────────────────────────────────────────────────────────
  // lo: the reading at 4 mA; hi: at 20 mA.
  const ma2val = (ma, lo, hi) => lo + (ma - 4) / 16 * (hi - lo);
  const val2ma = (v, lo, hi) => (hi === lo ? NaN : 4 + (v - lo) / (hi - lo) * 16);
  const volts = (ma, ohms) => ma / 1000 * ohms;

  // Where a current sits, by NAMUR NE 43.
  function band(ma) {
    if (!Number.isFinite(ma)) return null;
    if (ma < 0.5) return { k: 'bad', text: 'No current — a broken wire, no loop power, or the transmitter is dead.' };
    if (ma <= 3.6) return { k: 'bad', text: 'Fault, low (≤ 3.6 mA): the transmitter is flagging a failure, or the loop is starved of voltage.' };
    if (ma < 3.8) return { k: 'warn', text: 'Below range (3.6–3.8 mA): under the bottom of the scale — check the zero, or a fault starting.' };
    if (ma < 4) return { k: 'warn', text: 'Just under 4 mA: inside NE 43\'s measuring range, reading a little below the scale\'s zero.' };
    if (ma <= 20) return { k: 'ok', text: 'In range.' };
    if (ma <= 20.5) return { k: 'warn', text: 'Just over 20 mA: inside NE 43\'s measuring range, a little past full scale.' };
    if (ma < 21) return { k: 'warn', text: 'Above range (20.5–21 mA): past full scale — the river may be above the sensor\'s span.' };
    return { k: 'bad', text: 'Fault, high (≥ 21 mA): the transmitter is flagging a failure, or a short is bypassing it.' };
  }

  // Does the loop leave the transmitter enough voltage at 20 mA, and at the
  // current it signals a fault with (21 mA by NE 43; the WL3100 uses 24)?
  // supply, vmin in volts; ohms, everything in the loop but the transmitter.
  function budget(supply, ohms, vmin, faultMa = 21) {
    const at20 = supply - 0.020 * ohms;
    const atFault = supply - faultMa / 1000 * ohms;
    const maxOhms = (supply - vmin) / 0.020;
    const maxFault = (supply - vmin) / (faultMa / 1000);
    return { at20, atFault, maxOhms, maxFault, ok: at20 >= vmin, fault: atFault >= vmin, spare: at20 - vmin };
  }

  // ── Text out ───────────────────────────────────────────────────────────────
  const DIR = { out: 'out', in: 'in', both: 'both ways', '': '' };
  const csvCell = v => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  function csvRows(conn) {
    return conn.pins.map(p => [conn.name, conn.gender === 'M' ? 'male' : conn.gender === 'F' ? 'female' : '', p.n, p.sig, KINDS[p.kind] || p.kind,
      DIR[p.dir] || '', p.what, p.wire, SURE[conn.sure].label].map(csvCell).join(','));
  }
  const CSV_HEAD = 'connector,gender on the unit,pin,signal,kind,direction at the unit,what it does,wire colour,how sure';
  function csv(ids) {
    const list = (ids || CONNECTORS.map(c => c.id)).map(byId).filter(Boolean);
    return [CSV_HEAD, ...list.flatMap(csvRows)].join('\n') + '\n';
  }

  return { KINDS, SURE, CATS, CONNECTORS, CABLES, DSUB, byId, cableById, endConns, endPin, mirrored, layout, ma2val, val2ma, volts, band, budget, csv, CSV_HEAD };
})();

if (typeof window !== 'undefined') window.PinoutData = PinoutData;
