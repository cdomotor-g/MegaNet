// MegaNet — tdma-planner.js
//
//   TdmaPlanner  the ⏱️ TDMA Planner tab, public: an ALERT2 time-slot plan
//                for one radio channel — a valid frame length, a slot (or a
//                run of slots) for every field station and repeater, the
//                repeaters' runs placed after every slot they forward and
//                sized to the traffic at the storm peak, the bytes each run
//                can carry against the bytes it must, the worst-case time a
//                report takes to reach the base, and a configuration sheet
//                that says, device by device, what to set — in the IND API's
//                names and the ERT-A2's words, honest about what the ERT-A2
//                manuals do not show.
//
// After core.js, app.js, path-profile.js and map-backbone.js; before init.js.
// Nothing runs at load: renderMain() calls render() and init(). Reaches back
// to core.js for state, esc, escAttr, announce, dlText, csvEscape,
// registerTabTeardown, acmaHaversineKm and stationSensors; across to app.js
// for stationAlertIds, primaryRole, passRelationIndex, passRangeCoversId and
// goToStation; to path-profile.js for stationIsMast; to
// map-backbone.js for backboneIndex. Every one of those is read at call time
// from the page's functions only, so test/tdma.mjs can load this file alone in
// a Node vm — no window, document, state or localStorage — and hold the
// arithmetic to the sources' figures.
//
// ── The layers ───────────────────────────────────────────────────────────────
// Kept apart so each can be read and checked on its own:
//
//   PROTO + the pure functions   the AirLink v1.1 blocking and FEC tables and
//                the Telos planning values: frameBytes, rfMs, airtimeMs,
//                windowMs, capacityBytes, unitsFor, validFrames, validate. No
//                DOM, no state.
//   the traffic model   what a report costs in MANT bytes (reportBytes,
//                concentrationBytes), per PDU, because a PDU is what a slot
//                carries and what a repeater re-sends with its own header.
//   the network model   who is under whom and how deep: sketchNetwork (pure,
//                from five counts) or registerNetwork (reads the register,
//                its pass ranges and the backbone pairs at call time).
//   allocate     pure: network and settings in, plan out — the order, the
//                runs sized to the peak, the placement, the latency walked
//                around the frame, the warnings, the summary. suggestFrame
//                runs it over every valid frame for the shortest that fits.
//   the page     the tiles, the picker, the card, the frame timeline, the
//                circle, one report's journey, the slot plan and the sheet;
//                the exports; one cheap playhead under requestAnimationFrame.
//
// The plan is a planner's model, not a measurement: the air time is the
// protocol's arithmetic, but the latency walk — a report ready just after its
// slot has started waits a whole frame, then every hop's wait to that
// repeater's next run — is this planner's own definition and the page says so.

const TdmaPlanner = (function () {
  const LS_KEY = 'meganet.tdma.scenario';
  const LONG_LINK_KM = 150;          // a pass-range "link" longer than this is an address collision (network-review.js)

  // ── 1. the protocol ───────────────────────────────────────────────────────
  // Every constant with its source, in one place. BIT_SYNC and FRAME_SYNC are
  // written as the bit counts over the bit rate, never as rounded literals:
  // with them exact, airtimeMs(25) is exactly 300.000 ms and the capacity of
  // a 300 ms window is the 25-byte river report, as the capture says.
  const PROTO = {
    BPS: 4800,                                   // AirLink v1.1 §3.1; the ERT-A2's 2-FSK
    MS_PER_BYTE: 8000 / 4800,                    // 1.6667 ms a byte
    BIT_SYNC_MS: 48 * 1000 / 4800,               // 48 bits = 10 ms
    FRAME_SYNC_MS: 32 * 1000 / 4800,             // 32 bits = 6.667 ms
    TAIL_MS: 5,                                  // RF tail: "typically 5 ms"; the IND API's default
    CARRIER_MS: 60, AGC_MS: 15,                  // Telos's planning values; the IND API's own defaults are 10 and 55
    FIRST_DATA: 22,                              // payload bytes in the first block (24 less the 2-byte AirLink header)
    FIRST_BYTES: 82,                             // the first block after Reed–Solomon and the convolutional code
    FOLLOW_DATA: 32,                             // data bytes in a full follow-on block
    MAX_PAYLOAD: 1023,                           // the AirLink's 10-bit LEN
    SLOT_MIN_MS: 500, SLOT_MAX_MS: 10000, SLOT_STEP_MS: 250,
    BUFFER_MIN_MS: 25, BUFFER_MAX_MS: 250,
    FRAME_MIN_MS: 5000, FRAME_MAX_MS: 3600000, FRAME_STEP_MS: 500,
    HALF_DAY_MS: 43200000,                       // a frame divides 12 hours evenly (IND API; AL200)
    HOUR_MS: 3600000,
    MANT_HDR: 6, APDU_HDR: 3,                    // MANT header; application control byte + 2-byte timestamp
    GSR_HDR: 2,                                  // general sensor report: type + length
    CONC_HDR: 9, CONC_REC: 4, CONC_MAX: 253,     // a concentration PDU: 6 + 1 + 2, then 4 bytes a legacy record
    CONC_WAIT_MS: 255000,                        // a record's time offset is one byte of seconds
    HOP_MAX: 6,                                  // Hop Limit 0–6; 7 = not enabled
  };

  // The ERT-A2's sensor widths, by its ID table.
  const WIDTHS = { rain: 4, stage: 3, battery: 1, rssi: 1, airTemp: 2, rh: 1, baro: 2, windSpeed: 2, windDir: 2, peakWind: 2 };
  const KINDS = {
    rain:         ['rain', 'battery'],
    river:        ['stage', 'rain', 'battery'],
    quick:        ['rain', 'stage', 'battery', 'rssi'],
    weather:      ['rain', 'airTemp', 'rh', 'baro', 'windSpeed', 'windDir', 'peakWind', 'battery'],
    housekeeping: ['battery', 'rssi'],
  };
  const KIND_LABEL = {
    rain: 'rain + battery (20 B)', river: 'river + rain + battery (25 B)', quick: 'ERT-A2 quick start, 4 sensors (28 B)',
    weather: 'weather station, 8 sensors (43 B)', auto: 'from the register\'s sensors',
  };
  // The register's sensor types, as stationSensors() names them, to a width.
  // A type not here (the register's "Repeater", an unknown) is not a reading
  // and counts for nothing.
  const SENSOR_WIDTH = { 'Rainfall': 4, 'Rainfall Increment': 4, 'Water Level': 3, 'Battery': 1, 'Primary': 3 };

  const radio = o => ({ carrierMs: o && isFinite(o.carrierMs) ? Number(o.carrierMs) : PROTO.CARRIER_MS,
                        agcMs: o && isFinite(o.agcMs) ? Number(o.agcMs) : PROTO.AGC_MS });

  // Frame-payload bytes after the FEC for P MANT-PDU bytes: a padded first
  // block, then full and partial follow-on blocks, and a 2-byte tail once
  // when there is any follow-on block at all.
  function frameBytes(P) {
    const D = Math.max(0, Math.floor(P) - PROTO.FIRST_DATA);
    const nf = Math.ceil(D / PROTO.FOLLOW_DATA);
    return PROTO.FIRST_BYTES + (D > 0 ? 2 * (D + 16 * nf) + 2 : 0);
  }
  function rfMs(P, o) {
    const r = radio(o);
    return r.carrierMs + r.agcMs + PROTO.BIT_SYNC_MS + PROTO.FRAME_SYNC_MS + frameBytes(P) * PROTO.MS_PER_BYTE;
  }
  // On air, tail included: the tail counts toward the slot.
  function airtimeMs(P, o) { return rfMs(P, o) + PROTO.TAIL_MS; }
  // The usable window of a run of n slot units: a clock buffer either side.
  function windowMs(slotMs, n, bufferMs) { return n * slotMs - 2 * bufferMs; }
  // The largest payload a window carries; −1 when not even an empty frame
  // fits. The 1e-6 absorbs floating point at the edges.
  function capacityBytes(win, o) {
    let lo = 0, hi = PROTO.MAX_PAYLOAD;
    if (airtimeMs(0, o) > win + 1e-6) return -1;
    while (lo < hi) {               // airtime is monotonic in P
      const mid = Math.ceil((lo + hi) / 2);
      if (airtimeMs(mid, o) <= win + 1e-6) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  // The fewest slot units a load needs, up to the IND API's 10 s slot.
  function unitsFor(bytes, slotMs, bufferMs, o) {
    const need = Math.min(Math.max(0, bytes), PROTO.MAX_PAYLOAD);
    const maxN = Math.max(1, Math.floor(PROTO.SLOT_MAX_MS / slotMs));
    for (let n = 1; n <= maxN; n++) if (capacityBytes(windowMs(slotMs, n, bufferMs), o) >= need) return n;
    return null;
  }
  let VALID = null;
  function validFrames() {
    if (!VALID) {
      VALID = [];
      for (let f = PROTO.FRAME_MIN_MS; f <= PROTO.FRAME_MAX_MS; f += PROTO.FRAME_STEP_MS) if (PROTO.HALF_DAY_MS % f === 0) VALID.push(f);
    }
    return VALID.slice();
  }

  // ── the warnings and errors, by stable code ──
  const TEXT = {
    E_FRAME_INVALID: 'Frame must be 5 s–3600 s, a multiple of 500 ms, dividing 12 hours evenly',
    E_FRAME_SLOT:    'Frame is not a whole number of slots (a planner rule: the IND API only asks for a multiple of its minimum slot, the AL200 for 500 ms steps)',
    E_SLOT_RANGE:    'Slot 500 ms–10 s in 250 ms steps',
    E_BUFFER:        'Buffer 25–250 ms',
    E_FRAME_START:   'Frame start offset must leave room for one frame in the hour',
    E_OVERFLOW:      n => `${n} transmitter${n === 1 ? ' has' : 's have'} no slot: lengthen the frame or shorten the slots`,
    E_CONC_WAIT:     'A legacy reading cannot wait more than 255 s for a repeater slot (a planner rule: a concentration record\'s time offset is one byte of seconds)',
    W_SLOT_250:      'AL200 offsets are in 500 ms steps; odd 250 ms slots misalign them',
    W_OVER_CAPACITY: k => `Over capacity: this run cannot carry its peak — needs ${k} runs of ≤ 1023 bytes: raise Repeater slots per frame to ${k}, or split its stations`,
    W_NEAR_CAPACITY: 'Within 10 % of capacity',
    W_TIGHT:         'Fits with under 10 ms to spare — the clock buffer is doing all the work',
    W_WRAP:          r => `Waits a frame at ${r}: its slot comes before this one's`,
    W_HOPS:          'More than 6 repeater hops cannot be expressed in Hop Limit',
    W_NO_PATH:       'No backbone link to a base — assumed direct',
    W_NO_BASE:       'No base picked',
    W_NOT_IN_PASS:   'Not in any picked repeater\'s pass range',
    W_LONG_LINK:     n => `${n} station${n === 1 ? '' : 's'} more than ${LONG_LINK_KM} km from their hub left out of the plan`,
    W_SPARE:         n => `Fewer spare slots than the ${n} % you asked to keep`,
    W_SHARED:        'Mixing ALOHA on the channel reduces TDMA\'s benefit',
    W_IND_DEFAULTS:  'Carrier/AGC differ from the Telos planning values (60 + 15 ms); the IND API\'s own defaults are 10 + 55 ms',
    I_BASE_REPEATER: 'Base + repeater: its stations land here; its repeater role forwards only to an upstream base that is picked',
  };
  const note = (code, arg) => ({ code, text: typeof TEXT[code] === 'function' ? TEXT[code](arg) : TEXT[code] });
  const has = (list, code) => (list || []).some(w => w.code === code);

  // What the settings alone say, before any network is looked at.
  function validate(set) {
    const errors = [], warnings = [];
    const frame = Number(set.frameMs), slot = Number(set.slotMs), buf = Number(set.bufferMs);
    if (!validFrames().includes(frame)) errors.push(note('E_FRAME_INVALID'));
    if (!(slot > 0) || frame % slot !== 0) errors.push(note('E_FRAME_SLOT'));
    if (!(slot >= PROTO.SLOT_MIN_MS) || slot > PROTO.SLOT_MAX_MS || slot % PROTO.SLOT_STEP_MS !== 0) errors.push(note('E_SLOT_RANGE'));
    if (!(buf >= PROTO.BUFFER_MIN_MS) || buf > PROTO.BUFFER_MAX_MS) errors.push(note('E_BUFFER'));
    if (Number(set.frameStartS || 0) * 1000 > PROTO.HOUR_MS - frame) errors.push(note('E_FRAME_START'));
    if (slot > 0 && slot % 500 !== 0) warnings.push(note('W_SLOT_250'));
    const r = radio(set);
    if (r.carrierMs !== PROTO.CARRIER_MS || r.agcMs !== PROTO.AGC_MS) warnings.push(note('W_IND_DEFAULTS'));
    return { errors, warnings };
  }

  // ── 2. the traffic ────────────────────────────────────────────────────────
  // A report in MANT bytes: the 6-byte MANT header, the application control
  // byte and 2-byte timestamp, then one general sensor report — type, length,
  // and 2 + width bytes a sensor — plus 4 for every extra 2-byte sensor, and
  // one path-count byte at the origin when path service is on. With
  // perSensor each sensor is its own PDU (as the only ERT-A2 capture on file
  // sent them): every one pays the two headers again, and its own path byte.
  const widthsOf = kind => (Array.isArray(kind) ? kind.map(w => Number(w) || 2)
    : (KINDS[kind] || KINDS.quick).map(k => WIDTHS[k]));
  function reportPdus(kind, extra, path, opts) {
    const ws = widthsOf(kind), n = Math.max(0, Math.round(extra || 0)), p = path ? 1 : 0;
    if (opts && opts.perSensor) {
      const one = w => PROTO.MANT_HDR + PROTO.APDU_HDR + PROTO.GSR_HDR + 2 + w + p;
      return ws.map(one).concat(Array.from({ length: n }, () => one(2)));
    }
    const gsr = PROTO.GSR_HDR + ws.reduce((a, w) => a + 2 + w, 0) + 4 * n;
    return [PROTO.MANT_HDR + PROTO.APDU_HDR + gsr + p];
  }
  function reportBytes(kind, extra, path, opts) { return reportPdus(kind, extra, path, opts).reduce((a, b) => a + b, 0); }
  // A repeater re-sends a PDU with its own address appended: 2 bytes a hop
  // when path service is on.
  const forwarded = (bytes, path) => bytes + (path ? 2 : 0);
  // m legacy ALERT readings concentrated into one PDU.
  function concentrationBytes(m, path) { return PROTO.CONC_HDR + PROTO.CONC_REC * Math.max(0, Math.round(m)) + (path ? 1 : 0); }

  // ── 3. the network ────────────────────────────────────────────────────────
  const byNameNum = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
  const pad2 = k => String(k).padStart(2, '0');

  // A network from five counts: a base, R repeaters in a chain C deep (each
  // level's repeaters under the one directly above), F field stations and L
  // legacy gauges under each, and D field stations heard straight by the base.
  function sketchNetwork(sk) {
    const R = Math.max(0, Math.round(sk.skRepeaters || 0)), C = Math.max(1, Math.round(sk.skDepth || 1));
    const F = Math.max(0, Math.round(sk.skFieldPer || 0)), D = Math.max(0, Math.round(sk.skDirect || 0)), L = Math.max(0, Math.round(sk.skLegacyPer || 0));
    const dev = (d) => ({ sensors: [], flags: [], children: [], ...d });
    const devices = [dev({ id: 'base', name: 'Base', role: 'base', depth: 0, parents: [], address: 1 })];
    const byId = new Map(devices.map(d => [d.id, d]));
    const add = d => { devices.push(dev(d)); byId.set(d.id, devices[devices.length - 1]); byId.get(d.parents[0]).children.push(d.id); };
    const perLevel = Math.ceil(R / C) || 1;
    for (let i = 0; i < R; i++) {
      const level = Math.floor(i / perLevel);
      add({ id: `r${i + 1}`, name: `Repeater ${i + 1}`, role: 'repeater', depth: level + 1,
            parents: [level === 0 ? 'base' : `r${i - perLevel + 1}`], address: 100 + i + 1 });
    }
    let nf = 0, nl = 0;
    for (let i = 0; i < R; i++) {
      const r = byId.get(`r${i + 1}`);
      for (let k = 1; k <= F; k++) add({ id: `${r.id}-f${pad2(k)}`, name: `Repeater ${i + 1} · station ${k}`, role: 'field', depth: r.depth + 1, parents: [r.id], address: 1000 + (++nf) });
      for (let k = 1; k <= L; k++) add({ id: `${r.id}-l${pad2(k)}`, name: `Repeater ${i + 1} · legacy gauge ${k}`, role: 'field', depth: r.depth + 1, parents: [r.id], legacyAloha: true, address: 2000 + (++nl) });
    }
    for (let k = 1; k <= D; k++) add({ id: `f${pad2(k)}`, name: `Station ${k}`, role: 'field', depth: 1, parents: ['base'], address: 1000 + (++nf) });
    return { source: 'sketch', devices, bases: ['base'], maxDepth: Math.max(0, ...devices.map(d => d.depth)), notes: [] };
  }

  // A network from the register: the hubs picked (repeaters and bases), the
  // backbone pairs between them within the link length, the field stations
  // their pass ranges carry (and any within the radius), each under the
  // nearest hub whose pass ranges cover it. Rebuilt on every call; only the
  // hub ids are kept. Needs state.data; without it, an empty network.
  const repeats = s => !!(s.roles && s.roles.includes('repeater') && s.repeater);
  function registerNetwork(reg) {
    const empty = { source: 'register', devices: [], bases: [], maxDepth: 0, notes: [] };
    if (typeof state === 'undefined' || !state || !state.data) return empty;
    const all = state.data.stations.filter(s => !s.deleted_at);
    const located = all.filter(s => s.lat != null && s.lon != null);
    const stById = new Map(all.map(s => [s.id, s]));
    const picked = (reg.regHubs || []).map(id => stById.get(id)).filter(s => s && s.lat != null && s.lon != null);
    if (!picked.length) return empty;
    const km = (a, b) => (a.lat != null && b.lat != null ? acmaHaversineKm(a.lat, a.lon, b.lat, b.lon) : null);
    const notes = [], flags = { W_NO_PATH: 0, W_NOT_IN_PASS: 0 };
    // A base that does not repeat is a base: it receives and the plan imposes
    // nothing on it. A station that repeats is a repeater — it has a
    // transmitter that needs a run — unless no pure base is picked: then a
    // picked station carrying the base role is the root, its stations land on
    // it, and its repeater role has nothing picked upstream to forward to.
    const hasBase = s => !!(s.roles && s.roles.includes('base'));
    const pureBaseSt = picked.filter(s => !repeats(s) && primaryRole(s) === 'base');
    const baseSt = pureBaseSt.length ? pureBaseSt : picked.filter(hasBase);
    const repSt = picked.filter(s => repeats(s) && !baseSt.includes(s));
    const pickedIds = new Set(picked.map(s => s.id));
    const maxKm = Number(reg.regBackboneKm) || 100;
    const pairs = backboneIndex().pairs.filter(p => p.km <= maxKm);
    const devices = [], byId = new Map();
    const mk = (d) => { const x = { sensors: [], flags: [], children: [], ...d }; devices.push(x); byId.set(x.id, x); return x; };
    const sensorsOf = s => stationSensors(s).map(se => ({ type: se.type || '', width: SENSOR_WIDTH[se.type] || 0 })).filter(x => x.width > 0);
    const addrOf = s => (s.alert_ids && s.alert_ids.primary != null ? Number(s.alert_ids.primary) : (stationAlertIds(s)[0] ?? null));
    const link = (d, parentId, depth) => { d.parents = [parentId]; d.depth = depth; byId.get(parentId).children.push(d.id); };
    // The roots: the bases picked (a base + repeater among them only when no
    // pure base is), or — nobody with the base role picked — the repeaters
    // that have a backbone pair to any base in the register, under a virtual
    // base named for the nearest base the register knows, and said so.
    let roots;
    if (baseSt.length) {
      for (const b of baseSt) {
        const d = mk({ id: b.id, name: b.name, role: 'base', depth: 0, parents: [], address: addrOf(b), register: true, lat: b.lat, lon: b.lon, station: b });
        if (repeats(b)) { d.flags.push('I_BASE_REPEATER'); d.passRanges = Array.isArray(b.repeater.pass_ranges) ? b.repeater.pass_ranges : []; }
      }
      roots = devices.slice();
    } else {
      const regBases = located.filter(s => hasBase(s) && !pickedIds.has(s.id));
      let nearest = null;
      for (const r of repSt) for (const b of regBases) { const k = km(r, b); if (k != null && (!nearest || k < nearest.km)) nearest = { b, km: k }; }
      const vb = mk({ id: 'base:virtual', name: nearest ? `Base (not picked — assumed ${nearest.b.name}, ${Math.round(nearest.km)} km)` : 'Base (not picked)',
                      role: 'base', depth: 0, parents: [], address: null });
      vb.flags.push('W_NO_BASE'); notes.push(note('W_NO_BASE'));
      const reach = repSt.filter(r => pairs.some(p => p.kind === 'base' && p.a.id === r.id));
      roots = reach.length ? reach : repSt;
      for (const r of roots) {
        const d = mk({ id: r.id, name: r.name, role: 'repeater', depth: 1, parents: [], address: addrOf(r), register: true, lat: r.lat, lon: r.lon, station: r,
                       passRanges: Array.isArray(r.repeater.pass_ranges) ? r.repeater.pass_ranges : [] });
        link(d, 'base:virtual', 1);
      }
    }
    // Breadth-first over the repeater pairs from the roots: depth, and the
    // discovering node as parent, the nearer one on a tie.
    const repDev = r => byId.get(r.id) || mk({ id: r.id, name: r.name, role: 'repeater', depth: 1, parents: [], address: addrOf(r), register: true, lat: r.lat, lon: r.lon, station: r,
                                               passRanges: Array.isArray(r.repeater.pass_ranges) ? r.repeater.pass_ranges : [] });
    const placed = new Set(devices.map(d => d.id));
    let frontier = devices.slice();
    while (frontier.length) {
      const found = new Map();                       // id → { from, km }
      for (const n of frontier) {
        for (const p of pairs) {
          if (p.kind === 'repeater' ? !(p.a.id === n.id || p.b.id === n.id) : !(p.b.id === n.id)) continue;
          const other = p.kind === 'repeater' ? (p.a.id === n.id ? p.b : p.a) : p.a;
          if (!pickedIds.has(other.id) || placed.has(other.id) || !repSt.some(r => r.id === other.id)) continue;
          const got = found.get(other.id);
          if (!got || p.km < got.km) found.set(other.id, { from: n, km: p.km, st: other });
        }
      }
      frontier = [];
      for (const [, f] of found) {
        const d = repDev(f.st); d.km = f.km;
        link(d, f.from.id, f.from.depth + 1); placed.add(d.id); frontier.push(d);
      }
    }
    // A picked repeater no pair reaches: assumed to be heard by a base.
    const baseDevs = devices.filter(d => d.role === 'base');
    for (const r of repSt) {
      if (placed.has(r.id)) continue;
      const d = repDev(r);
      const nearest = baseDevs.map(b => ({ b, km: b.lat != null ? km(b, r) : Infinity })).sort((x, y) => x.km - y.km)[0];
      link(d, nearest.b.id, 1); d.km = isFinite(nearest.km) ? nearest.km : null;
      d.flags.push('W_NO_PATH'); flags.W_NO_PATH++; placed.add(r.id);
    }
    // The field stations: what the picked hubs' pass ranges carry, within a
    // long-link sanity limit, and anything within the radius of a hub. A
    // station too far from every hub whose ranges hold it is left out, and
    // counted once however many hubs it was far from.
    const hubs = devices.filter(d => d.station);
    const idx = passRelationIndex();
    const cands = new Map(), far = new Set();
    for (const h of hubs) {
      for (const s of idx.byRepeater.get(h.id) || []) {
        if (s.deleted_at || pickedIds.has(s.id)) continue;
        const d = km(h.station, s);
        if (d != null && d > LONG_LINK_KM) { far.add(s.id); continue; }
        cands.set(s.id, s);
      }
    }
    const radius = Number(reg.regRadiusKm) || 0;
    if (radius > 0) {
      for (const s of located) {
        if (pickedIds.has(s.id) || !s.roles || !s.roles.includes('field')) continue;
        if (hubs.some(h => km(h.station, s) <= radius)) cands.set(s.id, s);
      }
    }
    for (const s of [...cands.values()].sort(byNameNum)) {
      const ids = stationAlertIds(s);
      const covering = hubs.filter(h => h.station.repeater && ids.some(id => passRangeCoversId(h.station.repeater, id)));
      let parent, flag = null;
      const nearer = (a, b) => (km(a.station, s) ?? Infinity) - (km(b.station, s) ?? Infinity);
      if (covering.length) parent = covering.slice().sort((a, b) => (a.depth - b.depth) || nearer(a, b))[0];
      else { parent = hubs.slice().sort(nearer)[0]; flag = 'W_NOT_IN_PASS'; flags.W_NOT_IN_PASS++; }
      const d = mk({ id: s.id, name: s.name, role: 'field', depth: parent.depth + 1, parents: [], address: addrOf(s), register: true,
                     lat: s.lat, lon: s.lon, km: km(parent.station, s), sensors: sensorsOf(s), legacyAloha: !!reg.regLegacy || undefined });
      if (flag) d.flags.push(flag);
      link(d, parent.id, parent.depth + 1);
    }
    for (const k of Object.keys(flags)) if (flags[k]) notes.push({ ...note(k), count: flags[k] });
    const dropped = [...far].filter(id => !cands.has(id)).length;
    if (dropped) notes.push(note('W_LONG_LINK', dropped));
    return { source: 'register', devices, bases: baseDevs.map(b => b.id), maxDepth: Math.max(0, ...devices.map(d => d.depth)), notes };
  }

  // ── 4. the allocation ─────────────────────────────────────────────────────
  // The order the slots go in. Hop order is a post-order walk from each base:
  // a node's child repeaters first (by name), each recursively, then its
  // child field stations (by name), then the node itself — so every
  // repeater's run comes after every slot it forwards, and a report crosses
  // every hop within one frame. Name order ignores roles and is there to
  // show what that costs.
  function postOrder(net, rows) {
    const byId = new Map(rows.map(d => [d.id, d]));
    const kids = id => rows.filter(d => d.parentId === id && !d.legacyAloha);
    const out = [];
    const walk = n => {
      kids(n.id).filter(d => d.role === 'repeater').sort(byNameNum).forEach(walk);
      kids(n.id).filter(d => d.role === 'field').sort(byNameNum).forEach(d => out.push(d));
      if (n.role !== 'base') out.push(n);
    };
    rows.filter(d => d.role === 'base').forEach(walk);
    // Anything not under a base at all (a sketch cannot make one; a register
    // network always roots its repeaters) still gets a slot, by name.
    const seen = new Set(out.map(d => d.id));
    for (const d of rows.slice().sort(byNameNum)) if (!seen.has(d.id) && d.role !== 'base' && !d.legacyAloha && !byId.get(d.parentId)) out.push(d);
    return out;
  }

  // The fewest AirLink frames — runs — a list of PDUs packs into, in order,
  // none past the 1023-byte maximum: what "Repeater slots per frame" must be
  // for a repeater whose load one run cannot carry.
  function packRuns(pdus) {
    let runs = 0, fill = 0;
    for (const b of pdus) {
      if (!runs || fill + b > PROTO.MAX_PAYLOAD) { runs++; fill = 0; }
      fill += b;
    }
    return runs;
  }

  function allocate(net, set) {
    const V = validate(set);
    const base = { valid: V.errors.length === 0, errors: V.errors.slice(), warnings: V.warnings.slice() };
    if (V.errors.length) return { ...base, devices: [], summary: null };
    const o = radio(set);
    const slot = Number(set.slotMs), buf = Number(set.bufferMs), frameMs = Number(set.frameMs), path = !!set.path;
    const U = Math.round(frameMs / slot);
    const alohaU = Math.round(U * (Number(set.alohaShare) || 0) / 100);
    const resU = Math.max(0, Math.min(Math.round(Number(set.reservedSlots) || 0), U - alohaU - 1));
    const Ualloc = U - alohaU - resU;
    const S = Math.max(1, Math.round(Number(set.sectors) || 1)), f = set.fieldEvery ? S : 1;
    const perSensor = !!set.pduPerSensor;
    const extra = Number(set.extraSensors) || 0;
    const perSlot = Math.max(1, Math.ceil((Number(set.reportsPerFrame) || 1) / f));
    const legacyPerMin = Number(set.legacyPerMin) || 0;

    const rows = net.devices.map(d => ({
      id: d.id, name: d.name, role: d.role, depth: d.depth, hops: Math.max(0, d.depth - 1), parentId: (d.parents && d.parents[0]) || null,
      legacyAloha: !!d.legacyAloha, address: d.address ?? null, register: !!d.register, km: d.km ?? null, flags: (d.flags || []).slice(),
      sensors: d.sensors || [], passRanges: d.passRanges || null, slots: [], pdus: {}, warnings: [], unplaced: false, latencyS: null,
    }));
    const byId = new Map(rows.map(d => [d.id, d]));
    const kindFor = d => (set.kind === 'auto' ? (d.sensors.length ? d.sensors.map(s => s.width) : 'quick') : set.kind);
    const pdusOf = d => reportPdus(kindFor(d), extra, path, { perSensor });
    const ownPdus = r => (set.repeaterOwn === 'none' ? [] : set.repeaterOwn === 'field' ? pdusOf(r) : [reportBytes('housekeeping', 0, path)]);
    const M = reportBytes(set.kind === 'auto' ? 'quick' : set.kind, extra, path);   // a typical station, for the headroom

    const order = set.order === 'name'
      ? rows.filter(d => d.role !== 'base' && !d.legacyAloha).sort(byNameNum)
      : postOrder(net, rows);
    const fields = order.filter(d => d.role === 'field');
    const reps = order.filter(d => d.role === 'repeater');
    const sectorsOf = i => { const s = new Set(); for (let j = 0; j < f; j++) s.add((i + Math.floor(j * S / f)) % S); return [...s]; };
    fields.forEach((d, i) => { const p = pdusOf(d); for (const s of sectorsOf(i)) d.pdus[s] = Array.from({ length: perSlot }, () => p).flat(); });
    // Repeaters deepest first, so a repeater's run carries its child
    // repeaters' runs already sized.
    const legacyOf = r => rows.filter(d => d.parentId === r.id && d.legacyAloha);
    for (const r of reps.slice().sort((a, b) => b.depth - a.depth)) {
      const kids = rows.filter(d => d.parentId === r.id && !d.legacyAloha);
      const nLeg = legacyOf(r).length;
      for (let s = 0; s < S; s++) {
        const list = [];
        for (const c of kids) if (c.pdus[s]) list.push(...c.pdus[s].map(b => forwarded(b, path)));
        let m = Math.ceil(nLeg * legacyPerMin * frameMs / 60000 / S);
        while (m > 0) { const k = Math.min(m, PROTO.CONC_MAX); list.push(concentrationBytes(k, path)); m -= k; }
        if (s === 0) list.push(...ownPdus(r));
        if (list.length) r.pdus[s] = list;
      }
    }
    // Placement: sector by sector, each starting at its share of the frame,
    // every transmitter with something to send in that sector in order.
    let cursor = 0, overflow = false;
    const maxN = Math.max(1, Math.floor(PROTO.SLOT_MAX_MS / slot));
    for (let s = 0; s < S; s++) {
      cursor = Math.max(cursor, Math.floor(s * Ualloc / S));
      for (const d of order) {
        if (!d.pdus[s]) continue;
        const bytes = d.pdus[s].reduce((a, b) => a + b, 0);
        const n = unitsFor(bytes, slot, buf, o) ?? maxN;
        if (overflow || cursor + n > Ualloc) { d.unplaced = true; overflow = true; continue; }
        const w = windowMs(slot, n, buf), cap = capacityBytes(w, o);
        d.slots.push({ sector: s, unit: cursor, units: n, offsetMs: cursor * slot, lengthMs: n * slot, windowMs: w, capacityBytes: cap,
                       peakBytes: bytes, pdus: d.pdus[s].length, airMs: airtimeMs(Math.min(bytes, PROTO.MAX_PAYLOAD), o), utilisation: cap > 0 ? bytes / cap : Infinity });
        cursor += n;
      }
    }
    // The latency: a report ready just after its slot has started waits a
    // whole frame (or, with several slots, the gap to the next) for its slot,
    // then at every hop for that repeater's next run; a run that has already
    // gone this frame means the first run of the next. A hop to a repeater
    // with no slot is where the journey stops: the latency is unknown.
    for (const d of order) {
      if (!d.slots.length) continue;
      let best = null, deadEnd = null;
      d.slots.forEach((sl, k) => {
        const prev = k === 0 ? d.slots[d.slots.length - 1] : d.slots[k - 1];
        const gap = k === 0 ? frameMs - prev.offsetMs + sl.offsetMs : sl.offsetMs - prev.offsetMs;
        let t = sl.offsetMs + sl.lengthMs, carry = 0, cur = d, wraps = 0, wrapAt = null, dead = null;
        const hops = [];
        for (;;) {
          const p = cur.parentId ? byId.get(cur.parentId) : null;
          if (!p || p.role !== 'repeater') break;
          if (!p.slots.length) { dead = p; break; }
          let run = p.slots.find(x => carry + x.offsetMs >= t);
          if (!run) { carry += frameMs; run = p.slots[0]; wraps++; if (!wrapAt) wrapAt = p.name; }
          hops.push({ id: p.id, name: p.name, role: p.role, readyMs: t, startMs: carry + run.offsetMs, endMs: carry + run.offsetMs + run.lengthMs });
          t = carry + run.offsetMs + run.lengthMs; cur = p;
        }
        const F0 = gap - sl.offsetMs;
        const own = { id: d.id, name: d.name, role: d.role, readyMs: 0, startMs: gap, endMs: gap + sl.lengthMs };
        const shifted = hops.map(h => ({ ...h, readyMs: h.readyMs + F0, startMs: h.startMs + F0, endMs: h.endMs + F0 }));
        if (dead) {
          if (!deadEnd) deadEnd = { at: dead.name, F0, trace: [own, ...shifted, { id: dead.id, name: dead.name, role: 'repeater', noSlot: true }] };
          return;
        }
        const total = gap + (t - sl.offsetMs);
        if (!best || total > best.total) {
          best = { total, wraps, wrapAt, slot: sl, F0, trace: [own, ...shifted,
            { id: cur.parentId, name: (byId.get(cur.parentId) || { name: 'Base' }).name, role: 'base', arriveMs: total }] };
        }
      });
      if (best) {
        d.latencyS = best.total / 1000; d.trace = best.trace; d.F0 = best.F0;
        if (best.wraps) d.warnings.push(note('W_WRAP', best.wrapAt));
      } else if (deadEnd) {
        d.noSlotAt = deadEnd.at; d.trace = deadEnd.trace; d.F0 = deadEnd.F0;
      }
    }
    // What each transmitter's row says of itself. A run over capacity is one
    // whose load passes 1023 bytes — a fact of the load, placed or not, since
    // no frame length changes it; the remedy is the fewest runs its PDUs pack
    // into, and more than the sectors it has now whatever the packing says.
    for (const d of order) {
      d.hopLimit = d.hops;
      d.peakBytes = d.slots.reduce((a, s) => a + s.peakBytes, 0);
      d.capacityBytes = d.slots.reduce((a, s) => a + s.capacityBytes, 0);
      d.utilisation = d.slots.length ? Math.max(...d.slots.map(s => s.utilisation)) : 0;
      const over = d.slots.some(s => s.peakBytes > s.capacityBytes);
      const sectors = Object.keys(d.pdus).sort((a, b) => a - b);
      d.overLoad = sectors.some(s => d.pdus[s].reduce((a, b) => a + b, 0) > PROTO.MAX_PAYLOAD);
      const packed = packRuns(sectors.flatMap(s => d.pdus[s]));
      d.runsNeeded = d.overLoad ? Math.max(packed, S + 1) : packed;
      if (over) d.warnings.push(note('W_OVER_CAPACITY', d.runsNeeded));
      else if (d.utilisation > 0.9) d.warnings.push(note('W_NEAR_CAPACITY'));
      if (!over && d.slots.some(s => s.windowMs - s.airMs < 10)) d.warnings.push(note('W_TIGHT'));
      if (d.hops > PROTO.HOP_MAX) d.warnings.push(note('W_HOPS'));
      for (const fl of d.flags) if (TEXT[fl]) d.warnings.push(note(fl));
    }
    for (const d of rows) if (d.role === 'base' || d.legacyAloha) for (const fl of d.flags) if (TEXT[fl]) d.warnings.push(note(fl));
    // The frame as a whole.
    const placed = order.filter(d => d.slots.length);
    const used = placed.reduce((a, d) => a + d.slots.reduce((x, s) => x + s.units, 0), 0);
    const spare = Ualloc - used, sparePct = Ualloc > 0 ? 100 * spare / Ualloc : 0;
    const sumPeak = placed.reduce((a, d) => a + d.peakBytes, 0), sumCap = placed.reduce((a, d) => a + d.capacityBytes, 0);
    const worst = placed.filter(d => d.latencyS != null).reduce((w, d) => (!w || d.latencyS > w.latencyS ? d : w), null);
    const unknown = placed.find(d => d.noSlotAt);
    const overs = placed.filter(d => has(d.warnings, 'W_OVER_CAPACITY'));
    const overMost = order.filter(d => d.overLoad).reduce((w, d) => (!w || d.runsNeeded > w.runsNeeded ? d : w), null);
    const perStation = M + (path ? 2 : 0);
    const repRoom = placed.filter(d => d.role === 'repeater').map(d => Math.floor((d.capacityBytes - d.peakBytes) / perStation));
    const headroom = Math.max(0, Math.min(Math.floor(spare / f), ...repRoom));
    const unplaced = order.filter(d => d.unplaced).length;
    const errors = base.errors.slice(), fw = base.warnings.slice();
    if (unplaced) errors.push(note('E_OVERFLOW', unplaced));
    if (rows.some(d => d.legacyAloha) && frameMs / S > PROTO.CONC_WAIT_MS) errors.push(note('E_CONC_WAIT'));
    if (sparePct < (Number(set.spareTarget) || 0) - 1e-9) fw.push(note('W_SPARE', Number(set.spareTarget)));
    if (alohaU > 0) fw.push(note('W_SHARED'));
    const busiest = placed.reduce((w, d) => (!w || d.utilisation > w.utilisation ? d : w), null);
    const summary = {
      frameMs, slotMs: slot, bufferMs: buf, frameStartS: Number(set.frameStartS) || 0, units: U, allocUnits: Ualloc, used, spare, sparePct,
      reservedUnits: resU, alohaUnits: alohaU, sectors: S,
      slotUtilPct: Ualloc > 0 ? 100 * used / Ualloc : 0, byteUtilPct: sumCap > 0 ? 100 * sumPeak / sumCap : 0,
      maxDepth: net.maxDepth, maxHops: Math.max(0, ...placed.map(d => d.hops)),
      worstLatencyS: worst ? worst.latencyS : null, worstDeviceId: worst ? worst.id : null,
      latencyUnknownAt: unknown ? unknown.noSlotAt : null,
      busiestDeviceId: busiest ? busiest.id : null, busiestPct: busiest ? 100 * busiest.utilisation : 0,
      overCapacity: overs.length, runsNeeded: overMost ? overMost.runsNeeded : null, overDeviceId: overMost ? overMost.id : null,
      headroomStations: isFinite(headroom) ? headroom : Math.floor(spare / f), headroomBy: repRoom.length && Math.min(...repRoom) < Math.floor(spare / f) ? 'repeater' : 'slots',
      transmitters: order.length, unplaced, validFrame: true, warnings: fw,
    };
    for (const d of rows) delete d.pdus;
    return { valid: true, errors, warnings: base.warnings, devices: rows, order: order.map(d => d.id), summary };
  }

  // The shortest valid frame that fits the network with the spare asked for:
  // no error, nothing unplaced, no run over capacity. A frame with fewer slot
  // units than there are transmitters is not even tried.
  function suggestFrame(net, set) {
    const n = net.devices.filter(d => d.role !== 'base' && !d.legacyAloha).length;
    const slot = Number(set.slotMs) || PROTO.SLOT_MIN_MS;
    for (const f of validFrames()) {
      if (f / slot < n) continue;
      const p = allocate(net, { ...set, frameMs: f });
      if (!p.summary || p.errors.length) continue;
      if (p.summary.unplaced === 0 && p.summary.overCapacity === 0 && p.summary.sparePct >= (Number(set.spareTarget) || 0) - 1e-9) return f;
    }
    return null;
  }

  // ── 5. the scenario ───────────────────────────────────────────────────────
  const DEFAULTS = {
    source: 'sketch',
    skRepeaters: 2, skDepth: 2, skFieldPer: 12, skDirect: 0, skLegacyPer: 0,
    regHubs: [], regRadiusKm: 0, regBackboneKm: 100, regLegacy: false,
    frameMs: 120000, frameStartS: 0, slotMs: 500, bufferMs: 50, carrierMs: 60, agcMs: 15,
    sectors: 1, fieldEvery: false, order: 'hops',
    kind: 'quick', extraSensors: 0, reportsPerFrame: 1, repeaterOwn: 'housekeeping', path: true, pduPerSensor: false, legacyPerMin: 1,
    spareTarget: 20, reservedSlots: 0, alohaShare: 0,
    follow: '',
  };
  const PRESETS = [
    { id: 'review', label: 'Network Review default', set: {} },
    { id: 'telos',  label: 'Telos textbook', set: { frameMs: 20000, skRepeaters: 1, skDepth: 1, skFieldPer: 30, spareTarget: 0 } },
    { id: 'chain',  label: 'Backbone chain', set: { frameMs: 60000 } },
    { id: 'sparse', label: 'Sparse rural', set: { frameMs: 120000, skRepeaters: 3, skDepth: 1, skFieldPer: 8, skDirect: 4, kind: 'river' } },
    { id: 'dense',  label: 'Dense / flash flood', set: { frameMs: 30000, sectors: 2, skRepeaters: 2, skDepth: 1, skFieldPer: 10, reportsPerFrame: 2 } },
    { id: 'legacy', label: 'Legacy migration', set: { frameMs: 60000, skRepeaters: 2, skDepth: 1, skFieldPer: 0, skLegacyPer: 15, legacyPerMin: 1, alohaShare: 25 } },
  ];
  const frameOptions = () => validFrames().filter(f => f <= 600000).concat([900000, 1800000, 3600000]);
  const secs = ms => `${+(ms / 1000).toFixed(3)} s`;
  const frameLabel = f => (f >= 60000 && f % 60000 === 0 ? `${f / 1000} s · ${f / 60000} min` : secs(f));

  // The controls, by group: the picker's two halves and the card's four
  // fieldsets. `k` is the scenario key; a range has min/max/step and a unit, a
  // switch has none, a select has options (or a function of the scenario).
  const SKETCH_CONTROLS = [
    { k: 'skRepeaters', kind: 'range', label: 'Repeaters', min: 0, max: 12, step: 1, unit: '' },
    { k: 'skDepth', kind: 'range', label: 'Chain depth (repeater hops)', min: 1, max: 6, step: 1, unit: '' },
    { k: 'skFieldPer', kind: 'range', label: 'Field stations per repeater', min: 0, max: 60, step: 1, unit: '' },
    { k: 'skDirect', kind: 'range', label: 'Field stations heard straight by the base', min: 0, max: 60, step: 1, unit: '' },
    { k: 'skLegacyPer', kind: 'range', label: 'Legacy ALERT gauges per repeater', min: 0, max: 60, step: 1, unit: '' },
  ];
  const REGISTER_CONTROLS = [
    { k: 'regRadiusKm', kind: 'range', label: 'Also stations within (km)', min: 0, max: 150, step: 5, unit: ' km', zero: 'pass ranges only' },
    { k: 'regBackboneKm', kind: 'range', label: 'Repeater links up to (km)', min: 30, max: 150, step: 5, unit: ' km' },
    { k: 'regLegacy', kind: 'switch', label: 'Field stations are still legacy ALERT (concentrated by their repeater)' },
  ];
  const CONTROLS = [
    { group: 'Frame and slots', items: [
      { k: 'frameMs', kind: 'select', label: 'Frame length', options: () => frameOptions().map(f => [String(f), frameLabel(f)]) },
      { k: 'slotMs', kind: 'range', label: 'Slot unit (ms)', min: 500, max: 2000, step: 250, unit: ' ms' },
      { k: 'bufferMs', kind: 'range', label: 'Clock buffer each side (ms)', min: 25, max: 250, step: 5, unit: ' ms' },
      { k: 'sectors', kind: 'range', label: 'Repeater slots per frame (spread through it)', min: 1, max: 6, step: 1, unit: '' },
      { k: 'fieldEvery', kind: 'switch', label: 'Field stations transmit in every one of those' },
      { k: 'order', kind: 'select', label: 'Order slots by', options: [['hops', 'hop depth, deepest first'], ['name', 'station name']] },
      { k: 'frameStartS', kind: 'number', label: 'Frame start offset (s after the hour)', min: 0, max: 3600, step: 1, unit: ' s' },
    ] },
    { group: 'Traffic at the storm peak', items: [
      { k: 'kind', kind: 'select', label: 'Report', options: sc => ['rain', 'river', 'quick', 'weather'].concat(sc.source === 'register' ? ['auto'] : []).map(k => [k, KIND_LABEL[k]]) },
      { k: 'extraSensors', kind: 'range', label: 'Extra 2-byte sensors per report', min: 0, max: 8, step: 1, unit: '' },
      { k: 'reportsPerFrame', kind: 'range', label: 'Reports per station per frame', min: 1, max: 6, step: 1, unit: '' },
      { k: 'repeaterOwn', kind: 'select', label: 'Repeaters’ own report', options: [['none', 'none'], ['housekeeping', 'battery + RSSI (17 B)'], ['field', 'same as a field station']] },
      { k: 'path', kind: 'switch', label: 'Path service (each repeater appends its address)' },
      { k: 'pduPerSensor', kind: 'switch', label: 'Each sensor as its own PDU — as the ERT-A2 capture reported' },
      { k: 'legacyPerMin', kind: 'range', label: 'Legacy readings per gauge per minute', min: 0.25, max: 5, step: 0.25, unit: ' per minute' },
    ] },
    { group: 'Keep clear', items: [
      { k: 'spareTarget', kind: 'range', label: 'Spare slots to keep for stations not yet built (%)', min: 0, max: 50, step: 5, unit: '%' },
      { k: 'reservedSlots', kind: 'range', label: 'Reserved slots at the frame’s end (neighbour network, maintenance)', min: 0, max: 20, step: 1, unit: '' },
      { k: 'alohaShare', kind: 'range', label: 'ALOHA share of the frame (%)', min: 0, max: 50, step: 5, unit: '%' },
    ] },
    { group: 'Radio timing', items: [
      { k: 'carrierMs', kind: 'range', label: 'Carrier-only preamble (ms)', min: 20, max: 100, step: 5, unit: ' ms' },
      { k: 'agcMs', kind: 'range', label: 'AGC tone (ms)', min: 5, max: 100, step: 5, unit: ' ms' },
    ], note: 'Telos planned with 60 + 15 ms; the IND API’s defaults are 10 + 55 and it allows a carrier of 5 ms (the AirLink asks for 20); the RF tail is 5 ms (fixed).' },
  ];
  const ALL_CONTROLS = SKETCH_CONTROLS.concat(REGISTER_CONTROLS, CONTROLS.flatMap(g => g.items));
  const CTL = new Map(ALL_CONTROLS.map(c => [c.k, c]));
  const ENUMS = { source: ['sketch', 'register'], order: ['hops', 'name'], kind: ['rain', 'river', 'quick', 'weather', 'auto'], repeaterOwn: ['none', 'housekeeping', 'field'] };

  // ── the scenario, kept on this device ──
  // Read lazily — the first time the page or a public function asks — so the
  // file evaluates in a vm with no localStorage at all.
  let sc = null;
  const ensure = () => sc || (sc = loadScenario());
  function loadScenario() {
    let got = null;
    try { got = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { got = null; }
    return sanitize(got);
  }
  function sanitize(raw) {
    const out = { ...DEFAULTS, regHubs: [] };
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(DEFAULTS)) {
        const d = DEFAULTS[k], v = raw[k];
        if (v == null) continue;
        if (typeof d === 'boolean') out[k] = !!v;
        else if (typeof d === 'number') {
          const n = Number(v);
          if (!isFinite(n) || n < 0) continue;
          const c = CTL.get(k);
          if (k === 'frameMs') { if (validFrames().includes(n)) out[k] = n; }
          else if (c && c.kind !== 'select') out[k] = Math.min(c.max, Math.max(c.min, n));
          else out[k] = n;
        }
        else if (Array.isArray(d)) { if (Array.isArray(v)) out[k] = [...new Set(v.filter(x => typeof x === 'string' && x.length <= 80))].slice(0, 60); }
        else if (ENUMS[k]) { if (ENUMS[k].includes(v)) out[k] = v; }
        else if (typeof v === 'string' && v.length <= 120) out[k] = v;
      }
    }
    return out;
  }
  function saveScenario() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(sc)); } catch (_) { /* a private window: it still works, unremembered */ }
  }

  // Worked once per scenario: a repaint reads the plan a dozen times, and the
  // register's devices are rebuilt whenever the file changes under it.
  let memo = null, memoKey = '';
  function cur() {
    ensure();
    const data = typeof state !== 'undefined' && state ? state.data : null;
    const k = JSON.stringify(sc);
    if (!memo || memoKey !== k || memo.data !== data) {
      const network = sc.source === 'register' ? registerNetwork(sc) : sketchNetwork(sc);
      memo = { network, plan: allocate(network, sc), data };
      memoKey = k;
    }
    return memo;
  }
  // The shortest frame that fits is up to 79 allocations, so it is worked
  // once per scenario *apart from* the frame length and the followed device
  // — the two things a change to which cannot move it — and, on the page,
  // after the live repaint has painted rather than before.
  let sug = null, sugKey = '', sugTimer = 0;
  const sugKeyOf = () => { const { frameMs, follow, ...rest } = sc; return JSON.stringify(rest); };
  function suggestedCached() {
    const C = cur();
    return sug && sugKey === sugKeyOf() && sug.data === C.data ? sug : null;
  }
  function suggested() {
    const got = suggestedCached();
    if (got) return got.value;
    const C = cur();
    sug = { value: suggestFrame(C.network, sc), data: C.data }; sugKey = sugKeyOf();
    return sug.value;
  }
  function scheduleSuggestion() {
    if (sugTimer || typeof setTimeout !== 'function' || typeof document === 'undefined') return;
    sugTimer = setTimeout(() => {
      sugTimer = 0;
      if (!onTab()) return;
      const el = document.getElementById('tdp-sug');
      if (!el) return;
      suggested();
      const { plan: P } = cur();
      if (P.summary) el.outerHTML = sugTileHtml(P.summary);
    }, 0);
  }
  // The device followed through the frame and the journey: the one chosen,
  // or the worst-latency one — or, when no latency is known, the busiest.
  function followed(P) {
    if (!P || !P.summary) return null;
    const pick = sc.follow && P.devices.find(d => d.id === sc.follow && d.slots.length);
    return pick || P.devices.find(d => d.id === P.summary.worstDeviceId) || P.devices.find(d => d.id === P.summary.busiestDeviceId)
      || P.devices.find(d => d.slots.length) || null;
  }

  // ── formatting ──
  const nf = n => Math.round(n).toLocaleString('en-AU');
  const nfd = (n, d) => (Math.round(n * 10 ** d) / 10 ** d).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: d });
  const pct = n => `${nfd(n, 1)}%`;
  const slotsText = s => (s.units === 1 ? `${s.unit}` : `${s.unit}–${s.unit + s.units - 1}`);
  const roleWord = { field: 'field station', repeater: 'repeater', base: 'base' };
  function ctlValue(c, v) {
    if (c.kind === 'switch') return v ? 'yes' : 'no';
    if (c.kind === 'select') { const opts = typeof c.options === 'function' ? c.options(sc) : c.options; return (opts.find(x => x[0] === String(v)) || ['', String(v)])[1]; }
    if (c.zero && Number(v) === 0) return c.zero;
    return `${Number.isInteger(c.step) ? nf(v) : nfd(v, 2)}${c.unit || ''}`;
  }
  const htmlId = id => `tdp-sheet-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;

  // ── 6. the page ───────────────────────────────────────────────────────────

  function render() {
    ensure();
    return `<div class="page tdp-page" style="--page-max:1200px"><h2 class="sr-only">TDMA Planner</h2><div class="stack" id="tdp-page">
      ${headHtml()}
      <div id="tdp-kpis">${kpisHtml()}</div>
      ${networkHtml()}
      ${controlsHtml()}
      <div id="tdp-out" class="stack">${outHtml()}</div>
    </div></div>`;
  }

  function headHtml() {
    return `<div class="panel tdp-head">
      <div class="panel-header">
        <h2>⏱️ TDMA Planner</h2>
        <div class="button-group">
          <button type="button" onclick="TdmaPlanner.exportCsv()">⤓ Slot plan CSV</button>
          <button type="button" onclick="TdmaPlanner.exportSheetCsv()">⤓ Configuration sheet CSV</button>
          <button type="button" onclick="TdmaPlanner.print()">🖨️ Print</button>
        </div>
      </div>
      <p class="small">An ALERT2 time-slot plan for one radio channel: a valid frame, a slot for every field station and repeater — the
        repeaters' after the slots they forward and sized to the storm peak — the bytes each slot carries against what it must, how long
        the slowest report takes to reach the base, and what to configure on each unit.</p>
      <p class="small txt-muted">Worked from the AirLink v1.1, Telos and IND API documents; the ERT-A2 manuals do not show where slots are set — see the sheet.</p>
    </div>`;
  }

  const tile = (label, value, sub, cls = '', id = '') => `<div class="adm-kpi tdp-kpi${cls ? ` ${cls}` : ''}"${id ? ` id="${id}"` : ''}>
      <div class="adm-kpi-label">${label}</div><div class="adm-kpi-value">${value}</div><div class="adm-kpi-sub">${sub}</div></div>`;
  // The seventh tile. Until the suggestion is worked it says so; when no frame
  // fits because a run is over capacity it names the remedy instead of a
  // button, since no frame length would help.
  function sugTileHtml(S) {
    const got = suggestedCached();
    const T_ = (v, sub, cls = '') => tile('Shortest frame that fits', v, sub, cls, 'tdp-sug');
    if (!got) return T_('…', 'being worked out');
    const f = got.value;
    if (f == null) {
      return T_('none', S.runsNeeded ? `No frame fits at ${nf(S.sectors)} repeater slot${S.sectors === 1 ? '' : 's'} per frame — needs ${nf(S.runsNeeded)}`
        : 'no valid frame up to an hour holds this network with the spare asked for', 'adm-kpi--warn');
    }
    if (f === S.frameMs) return T_(secs(f), 'already the shortest');
    return T_(secs(f), `with ${nf(sc.spareTarget)}% spare · <button type="button" class="exp-btn-sm" onclick="TdmaPlanner.useSuggested()">Use it</button>`);
  }
  const remedy = (S, name) => `${name} — over capacity: no run can carry its peak — needs ${nf(S.runsNeeded)} runs of ≤ 1023 bytes: raise Repeater slots per frame to ${nf(S.runsNeeded)}, or split its stations`;
  function kpisHtml() {
    const { plan: P } = cur();
    if (!P.summary) {
      return `<div class="adm-kpis tdp-kpis" role="group" aria-label="The plan">
        ${tile('Frame', 'invalid', P.errors.map(e => esc(e.text)).join(' · '), 'adm-kpi--warn')}</div>`;
    }
    const S = P.summary, name = id => { const d = P.devices.find(x => x.id === id); return d ? esc(d.name) : '—'; };
    const spareWarn = has(S.warnings, 'W_SPARE');
    const busiest = P.devices.find(d => d.id === S.busiestDeviceId);
    const over = busiest && busiest.utilisation > 1;
    if (!suggestedCached()) scheduleSuggestion();
    const clear = S.reservedUnits || S.alohaUnits ? ` · ${S.reservedUnits ? `${S.reservedUnits} reserved` : ''}${S.reservedUnits && S.alohaUnits ? ', ' : ''}${S.alohaUnits ? `${S.alohaUnits} ALOHA` : ''}` : '';
    return `<div class="adm-kpis tdp-kpis" role="group" aria-label="The plan in seven figures">
      ${tile('Frame', secs(S.frameMs), `${nf(S.units)} slots of ${nf(S.slotMs)} ms${S.frameStartS ? ` · starts ${nf(S.frameStartS)} s after the hour` : ''}`)}
      ${tile('Slots used', `${nf(S.used)} <small>of ${nf(S.allocUnits)}</small>`, `${pct(S.slotUtilPct)} of the slots${clear}${S.unplaced ? ` · <span class="txt-bad">${nf(S.unplaced)} unplaced</span>` : ''}`, spareWarn || S.unplaced ? 'adm-kpi--warn' : 'adm-kpi--ok')}
      ${tile('Spare slots', nf(S.spare), `${pct(S.sparePct)} · ${nf(sc.spareTarget)}% asked for${spareWarn ? ' — <span class="txt-warn">short</span>' : ''}`)}
      ${S.latencyUnknownAt ? tile('Worst latency', 'unknown', `${esc(S.latencyUnknownAt)} has no slot`, 'adm-kpi--warn')
        : tile('Worst latency', S.worstLatencyS != null ? secs(S.worstLatencyS * 1000) : '—', S.worstDeviceId ? `${name(S.worstDeviceId)} · ${nf(S.maxHops)} hop${S.maxHops === 1 ? '' : 's'}` : 'nothing placed')}
      ${tile('Busiest slot', busiest ? `<span${over ? ' class="txt-bad"' : ''}>${pct(S.busiestPct)}</span>` : '—', busiest ? `${esc(busiest.name)} · ${nf(busiest.peakBytes)} of ${nf(busiest.capacityBytes)} bytes${over ? ' — over' : ''}` : 'nothing placed', !over && S.busiestPct >= 90 ? 'adm-kpi--warn' : '')}
      ${tile('Room for', `≈ ${nf(S.headroomStations)} <small>more station${S.headroomStations === 1 ? '' : 's'}</small>`,
        S.runsNeeded ? remedy(S, name(S.overDeviceId)) : S.headroomBy === 'repeater' ? 'limited by the tightest repeater’s run' : 'limited by the spare slots', S.runsNeeded ? 'adm-kpi--warn' : '')}
      ${sugTileHtml(S)}
    </div>`;
  }

  // ── the network picker ──
  const hubKind = s => (repeats(s) ? (s.roles.includes('base') ? 'base + repeater' : 'repeater') : 'base');
  function hubCandidates() {
    if (typeof state === 'undefined' || !state || !state.data) return [];
    return state.data.stations
      .filter(s => !s.deleted_at && s.lat != null && s.lon != null && stationIsMast(s))
      .sort(byNameNum);
  }
  function hubChipsHtml() {
    const { network: N } = cur();
    const cands = hubCandidates();
    return sc.regHubs.map(id => {
      const s = cands.find(x => x.id === id);
      if (!s) return '';
      const n = N.devices.filter(d => d.parents && d.parents[0] === id && d.role === 'field').length;
      return `<li>${esc(s.name)} <span class="txt-muted">· ${hubKind(s)} · ${n} station${n === 1 ? '' : 's'}</span>
        <button type="button" class="link-btn" aria-label="Remove ${esc(s.name)}" onclick="TdmaPlanner.unpickHub('${escAttr(id)}')">✕</button></li>`;
    }).join('');
  }
  function netSumHtml() {
    const { network: N } = cur();
    const n = r => N.devices.filter(d => d.role === r && !d.legacyAloha).length;
    const leg = N.devices.filter(d => d.legacyAloha).length;
    const deepest = Math.max(0, ...N.devices.filter(d => d.role === 'field' && !d.legacyAloha).map(d => d.depth - 1));
    const main = N.devices.length
      ? `${nf(n('field'))} field station${n('field') === 1 ? '' : 's'}, ${nf(n('repeater'))} repeater${n('repeater') === 1 ? '' : 's'}, ${nf(n('base'))} base${n('base') === 1 ? '' : 's'}; deepest station ${nf(deepest)} hop${deepest === 1 ? '' : 's'}${leg ? `; ${nf(leg)} legacy ALERT gauge${leg === 1 ? '' : 's'} concentrated` : ''}.`
      : (sc.source === 'register' ? 'No hub picked yet — choose a repeater or a base above.' : 'Nothing in the sketch yet.');
    return `<p class="small tdp-net-sum">${main}</p>${N.notes.map(x => `<p class="small txt-warn">${esc(x.text)}${x.count ? ` (${nf(x.count)})` : ''}</p>`).join('')}`;
  }
  function networkHtml() {
    const reg = sc.source === 'register';
    const radio_ = (v, label) => `<label class="check-label"><input type="radio" name="tdp-source" value="${v}" ${sc.source === v ? 'checked' : ''}
        onchange="TdmaPlanner.source('${v}')"><span>${label}</span></label>`;
    let body;
    if (!reg) body = `<div class="tdp-ctl-grid tdp-sketch">${SKETCH_CONTROLS.map(ctlHtml).join('')}</div>`;
    else if (typeof state === 'undefined' || !state || !state.data) body = '<p class="small">The station register is still loading — sketch a network meanwhile.</p>';
    else {
      const cands = hubCandidates(), picked = new Set(sc.regHubs);
      const idx = passRelationIndex();
      body = `<div class="tdp-reg">
        <label class="tdp-ctl" for="tdp-hubs"><span>Hubs: repeaters and bases from the register <span class="tdp-out-v" id="tdp-hubs-n">${nf(picked.size)} picked</span></span>
          <select multiple id="tdp-hubs" size="8" aria-label="Hubs: repeaters and bases from the register" onchange="TdmaPlanner.hubs(this)">
            ${cands.map(s => `<option value="${esc(s.id)}"${picked.has(s.id) ? ' selected' : ''}>${esc(s.name)} · ${hubKind(s)}${
              (idx.byRepeater.get(s.id) || []).length ? ` · ${nf((idx.byRepeater.get(s.id) || []).length)} in its pass ranges` : ''}</option>`).join('')}
          </select></label>
        <ul class="tdp-hub-list" id="tdp-hub-list" aria-label="Picked hubs">${hubChipsHtml()}</ul>
        <div class="tdp-ctl-grid">${REGISTER_CONTROLS.map(ctlHtml).join('')}</div>
      </div>`;
    }
    return `<section class="panel tdp-sec tdp-network" aria-labelledby="tdp-net-h">
      <h3 id="tdp-net-h">1. The network</h3>
      <div class="tdp-source" role="radiogroup" aria-label="Where the network comes from">${radio_('sketch', 'Sketch')}${radio_('register', 'From the register')}</div>
      ${body}
      <div id="tdp-net-sum">${netSumHtml()}</div>
    </section>`;
  }

  // ── the card ──
  function ctlHtml(c) {
    const id = `tdp-c-${c.k}`, v = sc[c.k];
    if (c.kind === 'switch') {
      return `<label class="check-label tdp-switch"><input type="checkbox" id="${id}" data-k="${c.k}" ${v ? 'checked' : ''}
        onchange="TdmaPlanner.set('${c.k}', this.checked)"><span>${esc(c.label)}</span></label>`;
    }
    if (c.kind === 'select') {
      const opts = typeof c.options === 'function' ? c.options(sc) : c.options;
      return `<label class="tdp-ctl" for="${id}"><span>${esc(c.label)}</span>
        <select id="${id}" data-k="${c.k}" onchange="TdmaPlanner.set('${c.k}', this.value)">
          ${opts.map(([val, txt]) => `<option value="${esc(val)}"${String(v) === String(val) ? ' selected' : ''}>${esc(txt)}</option>`).join('')}
        </select></label>`;
    }
    if (c.kind === 'number') {
      return `<label class="tdp-ctl" for="${id}"><span>${esc(c.label)}</span>
        <input type="number" id="${id}" data-k="${c.k}" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}" inputmode="numeric"
               onchange="TdmaPlanner.set('${c.k}', this.value)"></label>`;
    }
    // The slider's name is the label's words alone: the live value beside
    // them is its aria-valuetext, not part of its name.
    return `<label class="tdp-ctl" for="${id}"><span><span id="${id}-l">${esc(c.label)}</span> <output id="${id}-o" class="tdp-out-v" for="${id}">${esc(ctlValue(c, v))}</output></span>
      <input type="range" id="${id}" data-k="${c.k}" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}" aria-labelledby="${id}-l"
             oninput="TdmaPlanner.set('${c.k}', this.value)" aria-valuetext="${esc(ctlValue(c, v))}"></label>`;
  }
  function controlsHtml() {
    return `<section class="panel tdp-controls" aria-labelledby="tdp-ctl-h">
      <div class="panel-header"><h3 id="tdp-ctl-h">🎛️ Frame, slots and traffic</h3>
        <div class="button-group tdp-presets">
          ${PRESETS.map(p => `<button type="button" class="exp-btn-sm" onclick="TdmaPlanner.preset('${p.id}')">${esc(p.label)}</button>`).join('')}
        </div></div>
      <p class="small">Every slider works the plan again at once; the plan is kept on this device only.</p>
      <div class="tdp-ctl-grid">
        ${CONTROLS.map(g => `<fieldset class="tdp-fs"><legend>${esc(g.group)}</legend>${g.items.map(ctlHtml).join('')}${g.note ? `<p class="small">${esc(g.note)}</p>` : ''}</fieldset>`).join('')}
      </div>
    </section>`;
  }

  // ── the frame ──
  const X0 = 20, X1 = 960, TW = X1 - X0;   // the track
  const Y0 = 28, Y1 = 84, TH = Y1 - Y0;
  const fmt1 = n => Math.round(n * 100) / 100;
  // A nice axis step for a frame: about a dozen labels at most.
  function axisStep(frameMs) {
    for (const s of [500, 1000, 2000, 2500, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000]) if (frameMs / s <= 12) return s;
    return 1800000;
  }
  // The runs as drawn: a device's own run, or — where one is narrower than
  // 4 px — a group of contiguous runs of the same role under the same parent.
  function timelineGroups(P, pxPerMs) {
    const runs = [];
    for (const d of P.devices) for (const sl of d.slots) runs.push({ d, sl });
    runs.sort((a, b) => a.sl.unit - b.sl.unit);
    const out = [];
    for (const r of runs) {
      const narrow = r.sl.lengthMs * pxPerMs < 4;
      const last = out[out.length - 1];
      if (narrow && last && last.group && last.role === r.d.role && last.parentId === r.d.parentId && last.end === r.sl.unit) {
        last.end = r.sl.unit + r.sl.units; last.members.push(r); continue;
      }
      out.push({ group: narrow, role: r.d.role, parentId: r.d.parentId, start: r.sl.unit, end: r.sl.unit + r.sl.units, members: [r] });
    }
    return out;
  }
  function groupTitle(g, P, slotMs) {
    const parent = P.devices.find(d => d.id === g.parentId);
    if (g.members.length === 1) {
      const { d, sl } = g.members[0];
      return `${d.name}: slot${sl.units === 1 ? '' : 's'} ${slotsText(sl)}, ${secs(sl.offsetMs)} in, ${nf(sl.peakBytes)} of ${nf(sl.capacityBytes)} bytes`;
    }
    return `${g.members.length} ${roleWord[g.role]}s${parent ? ` under ${parent.name}` : ''}: slots ${g.start}–${g.end - 1}, ${secs(g.start * slotMs)} in`;
  }
  function timelineSvg(P, F) {
    const S = P.summary, px = TW / S.frameMs, slotMs = S.slotMs;
    const x = ms => X0 + ms * px;
    const still = stillPreferred();
    let marks = '';
    for (const g of timelineGroups(P, px)) {
      const w = (g.end - g.start) * slotMs * px, left = x(g.start * slotMs);
      const rep = g.role === 'repeater';
      const h = rep ? TH : TH * 0.7, y = Y1 - h;
      const ids = g.members.map(m => m.d.id);
      const label = g.members.length > 1 ? `${g.members.length} ${roleWord[g.role]}s` : g.members[0].d.name;
      marks += `<rect class="tdp-slot tdp-slot-${rep ? 'rep' : 'field'}${g.members.some(m => m.sl.peakBytes > m.sl.capacityBytes) ? ' tdp-slot-over' : ''}" x="${fmt1(left)}" y="${fmt1(y)}" width="${fmt1(Math.max(0.5, w))}" height="${fmt1(h)}" ${ids.length === 1 ? `data-id="${esc(ids[0])}"` : `data-ids="${esc(ids.join(' '))}"`}><title>${esc(groupTitle(g, P, slotMs))}</title></rect>`;
      if (w >= 60) marks += `<text class="tdp-slot-ink${rep ? ' tdp-slot-ink-rep' : ''}" x="${fmt1(left + 4)}" y="${fmt1(y + h / 2)}">${esc(label.length > w / 7 ? label.slice(0, Math.max(1, Math.floor(w / 7) - 1)) + '…' : label)}</text>`;
      else if (rep && w >= 14) marks += `<text class="tdp-slot-ink tdp-slot-ink-rep" x="${fmt1(left + w / 2 - 4)}" y="${fmt1(y + h / 2)}">R</text>`;
    }
    // What is kept clear: reserved and the ALOHA share at the end — hatched
    // one way and the other, so the two read apart without their colour —
    // spare as a dashed outline over each sector's remainder.
    const extras = [];
    if (S.reservedUnits) extras.push({ cls: 'tdp-slot-reserved', hatch: 'tdp-hatch', a: S.allocUnits, b: S.allocUnits + S.reservedUnits, t: `${S.reservedUnits} reserved slot${S.reservedUnits === 1 ? '' : 's'}` });
    if (S.alohaUnits) extras.push({ cls: 'tdp-slot-aloha', hatch: 'tdp-hatch2', a: S.allocUnits + S.reservedUnits, b: S.units, t: `ALOHA share: ${S.alohaUnits} slots` });
    for (const e of extras) {
      const left = x(e.a * slotMs), w = (e.b - e.a) * slotMs * px;
      marks += `<rect class="tdp-slot ${e.cls}" x="${fmt1(left)}" y="${Y0}" width="${fmt1(w)}" height="${TH}"><title>${esc(e.t)}</title></rect>
        <rect class="tdp-slot-hatch" x="${fmt1(left)}" y="${Y0}" width="${fmt1(w)}" height="${TH}" fill="url(#${e.hatch})"></rect>`;
    }
    const usedTo = new Array(S.sectors).fill(0);
    for (const d of P.devices) for (const sl of d.slots) usedTo[sl.sector] = Math.max(usedTo[sl.sector], sl.unit + sl.units);
    for (let s = 0; s < S.sectors; s++) {
      const start = Math.max(usedTo[s], Math.floor(s * S.allocUnits / S.sectors)), end = s + 1 < S.sectors ? Math.floor((s + 1) * S.allocUnits / S.sectors) : S.allocUnits;
      if (end > start) marks += `<rect class="tdp-slot-spare" x="${fmt1(x(start * slotMs) + 0.5)}" y="${Y0 + 0.5}" width="${fmt1(Math.max(0, (end - start) * slotMs * px - 1))}" height="${TH - 1}"><title>${esc(`${end - start} spare slot${end - start === 1 ? '' : 's'}`)}</title></rect>`;
      if (s > 0) marks += `<line class="tdp-grid" x1="${fmt1(x(Math.floor(s * S.allocUnits / S.sectors) * slotMs))}" x2="${fmt1(x(Math.floor(s * S.allocUnits / S.sectors) * slotMs))}" y1="${Y0 - 6}" y2="${Y1 + 6}"/>`;
    }
    let axis = '';
    for (let t = 0; t <= S.frameMs; t += axisStep(S.frameMs)) {
      axis += `<line class="tdp-grid-minor" x1="${fmt1(x(t))}" x2="${fmt1(x(t))}" y1="${Y1}" y2="${Y1 + 5}"/><text class="tdp-axis" x="${fmt1(x(t))}" y="${Y1 + 14}" text-anchor="${t === 0 ? 'start' : t >= S.frameMs ? 'end' : 'middle'}">${secs(t)}</text>`;
    }
    const headX = fmt1(x(still && F ? F.slots[0].offsetMs : 0));
    return `<figure class="tdp-fig">
      <svg class="tdp-anim" viewBox="0 0 980 108" role="img" aria-labelledby="tdp-tl-t tdp-tl-d">
        <title id="tdp-tl-t">Frame of ${secs(S.frameMs)}: ${nf(S.used)} of ${nf(S.allocUnits)} slots used${S.worstLatencyS != null ? `, worst latency ${secs(S.worstLatencyS * 1000)}` : ''}</title>
        <desc id="tdp-tl-d">One bar per transmitter in slot order; field stations green at 70% height, repeaters blue at full height with an edge, reserved hatched one way, the ALOHA share hatched the other way in amber, spare a dashed outline.</desc>
        <defs>${hatchDefs('')}</defs>
        <rect class="tdp-frame" x="${X0}" y="${Y0}" width="${TW}" height="${TH}"/>
        ${marks}${axis}
        <line id="tdp-playhead" class="tdp-playhead" x1="${headX}" x2="${headX}" y1="${Y0 - 8}" y2="${Y1 + 8}"/>
      </svg>
      <figcaption class="small txt-muted">${nf(S.units)} slots of ${nf(S.slotMs)} ms; ${S.sectors > 1 ? `${S.sectors} sectors, a repeater run in each; ` : ''}every repeater's run after the slots it forwards.</figcaption>
    </figure>`;
  }
  // Two hatch patterns, one a mirror of the other: reserved slots and the
  // ALOHA share. A suffix keeps the circle's ids apart from the timeline's.
  const hatchDefs = sfx => ['tdp-hatch', 'tdp-hatch2'].map((id, i) =>
    `<pattern id="${id}${sfx}" class="tdp-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(${i ? -45 : 45})"><line x1="0" y1="0" x2="0" y2="6"/></pattern>`).join('');
  function legendHtml() {
    return `<ul class="tdp-legend" aria-label="Legend">
      <li><span class="tdp-swatch tdp-sw-field"></span>field station</li>
      <li><span class="tdp-swatch tdp-sw-rep"></span>repeater run</li>
      <li><span class="tdp-swatch tdp-sw-reserved"></span>reserved</li>
      <li><span class="tdp-swatch tdp-sw-aloha"></span>ALOHA share</li>
      <li><span class="tdp-swatch tdp-sw-spare"></span>spare</li>
    </ul>`;
  }
  function stripHtml(P, F) {
    if (!F) return '';
    const sl = F.slots[0], S = P.summary, k = 980 / sl.lengthMs;
    const air = Math.min(sl.airMs, sl.windowMs), airX = (sl.lengthMs - air) / 2 * k;
    return `<figure class="tdp-fig tdp-detail">
      <svg class="tdp-strip" viewBox="0 0 980 26" preserveAspectRatio="none" role="img" aria-labelledby="tdp-strip-t">
        <title id="tdp-strip-t">One slot of ${esc(F.name)}: buffers, window and air time</title>
        <rect class="tdp-frame" x="0" y="0" width="980" height="26"/>
        <rect class="tdp-window" x="${fmt1(S.bufferMs * k)}" y="0" width="${fmt1(sl.windowMs * k)}" height="26"/>
        <rect class="tdp-buffer" x="0" y="0" width="${fmt1(S.bufferMs * k)}" height="26"/>
        <rect class="tdp-buffer" x="${fmt1(980 - S.bufferMs * k)}" y="0" width="${fmt1(S.bufferMs * k)}" height="26"/>
        <rect class="tdp-air" x="${fmt1(airX)}" y="6" width="${fmt1(air * k)}" height="14"/>
      </svg>
      <figcaption class="small">${esc(F.name)}, slot${sl.units === 1 ? '' : 's'} ${slotsText(sl)}: ${nf(sl.lengthMs)} ms with ${nf(S.bufferMs)} ms buffers, a ${nf(sl.windowMs)} ms window,
        ${nfd(sl.airMs, 2)} ms on air for ${nf(sl.peakBytes)} bytes (capacity ${nf(sl.capacityBytes)}${sl.peakBytes > sl.capacityBytes ? ' — <span class="txt-bad">over</span>' : ''}).</figcaption>
    </figure>`;
  }
  function playRowHtml() {
    if (stillPreferred()) return '<p class="small txt-muted">Animation is off because your system asks for reduced motion.</p>';
    return `<div class="button-group tdp-play-row" role="group" aria-label="Playback">
      <button type="button" id="tdp-play" class="tdp-play" onclick="TdmaPlanner.toggle()">${S_ && S_.playing ? '⏸ Pause' : '▶ Play'}</button>
      <button type="button" onclick="TdmaPlanner.replay()">↺ From the start</button>
    </div>`;
  }
  // The frame as a circle: the same groups as the timeline as arcs of a ring,
  // 12 o'clock the frame's start, repeaters the full ring and field stations
  // the inner 70% of it.
  function ringHtml(P) {
    const S = P.summary, cx = 160, cy = 160, RO = 140, RI = 104, F = S.frameMs, slotMs = S.slotMs;
    const pt = (r, t) => { const a = 2 * Math.PI * t / F - Math.PI / 2; return `${fmt1(cx + r * Math.cos(a))} ${fmt1(cy + r * Math.sin(a))}`; };
    const arc = (ro, ri, t0, t1, cls, title, hatch) => {
      const span = Math.min(t1 - t0, F * 0.99999), big = span > F / 2 ? 1 : 0, te = t0 + span;
      const d = `M ${pt(ro, t0)} A ${ro} ${ro} 0 ${big} 1 ${pt(ro, te)} L ${pt(ri, te)} A ${ri} ${ri} 0 ${big} 0 ${pt(ri, t0)} Z`;
      return `<path class="${cls}" d="${d}"><title>${esc(title)}</title></path>${hatch ? `<path class="tdp-slot-hatch" d="${d}" fill="url(#${hatch}-c)"/>` : ''}`;
    };
    let paths = '';
    for (const g of timelineGroups(P, TW / F)) {
      const rep = g.role === 'repeater';
      paths += arc(rep ? RO : RI + (RO - RI) * 0.7, RI, g.start * slotMs, g.end * slotMs, `tdp-slot tdp-slot-${rep ? 'rep' : 'field'}`, groupTitle(g, P, slotMs));
    }
    if (S.reservedUnits) paths += arc(RO, RI, S.allocUnits * slotMs, (S.allocUnits + S.reservedUnits) * slotMs, 'tdp-slot tdp-slot-reserved', `${S.reservedUnits} reserved slots`, 'tdp-hatch');
    if (S.alohaUnits) paths += arc(RO, RI, (S.allocUnits + S.reservedUnits) * slotMs, S.units * slotMs, 'tdp-slot tdp-slot-aloha', `ALOHA share: ${S.alohaUnits} slots`, 'tdp-hatch2');
    const usedTo = new Array(S.sectors).fill(0);
    for (const d of P.devices) for (const sl of d.slots) usedTo[sl.sector] = Math.max(usedTo[sl.sector], sl.unit + sl.units);
    for (let s = 0; s < S.sectors; s++) {
      const a = Math.max(usedTo[s], Math.floor(s * S.allocUnits / S.sectors)), b = s + 1 < S.sectors ? Math.floor((s + 1) * S.allocUnits / S.sectors) : S.allocUnits;
      if (b > a) paths += arc(RO, RI, a * slotMs, b * slotMs, 'tdp-slot-spare', `${b - a} spare slots`);
    }
    let ticks = '';
    for (let t = 0; t < F; t += axisStep(F)) ticks += `<line class="tdp-grid" x1="${pt(RO + 2, t).replace(' ', '" y1="')}" x2="${pt(RO + 8, t).replace(' ', '" y2="')}"/>`;
    return `<details class="tdp-more" id="tdp-circle" open><summary>The frame as a circle</summary>
      <figure class="tdp-fig tdp-ring">
        <svg viewBox="0 0 320 320" role="img" aria-labelledby="tdp-ring-t">
          <title id="tdp-ring-t">The ${secs(F)} frame as a clock face, starting at 12 o'clock: the same slots as the timeline — ${nf(S.used)} of ${nf(S.allocUnits)} slots used</title>
          <defs>${hatchDefs('-c')}</defs>
          <circle class="tdp-frame" cx="${cx}" cy="${cy}" r="${RO}"/><circle class="tdp-frame" cx="${cx}" cy="${cy}" r="${RI}"/>
          ${paths}${ticks}
          <text class="tdp-axis" x="${cx}" y="${cy - RO - 10}" text-anchor="middle">0 s</text>
          <text class="tdp-lab" x="${cx}" y="${cy}" text-anchor="middle">${secs(F)}</text>
          <text class="tdp-axis" x="${cx}" y="${cy + 16}" text-anchor="middle">${nf(S.used)} of ${nf(S.allocUnits)} slots</text>
        </svg>
        <figcaption class="small txt-muted">The frame repeats every ${secs(F)}: a report ready as the hand passes its slot waits a full turn.</figcaption>
      </figure></details>`;
  }
  function timelineSection(P) {
    const F = followed(P);
    return `<section class="panel tdp-sec" aria-labelledby="tdp-tl-h">
      <h3 id="tdp-tl-h">2. The frame</h3>
      ${timelineSvg(P, F)}
      ${legendHtml()}
      <p class="small">Each transmitter owns the slots shown; the air time sits centred in a slot with a clock buffer either side (AirLink §4.4).
        A repeater's slots come after every slot it forwards, so a report crosses every hop within one frame.</p>
      ${stripHtml(P, F)}
      ${playRowHtml()}
      ${ringHtml(P)}
    </section>`;
  }

  // ── one report's journey ──
  function journeySvg(P, F) {
    const tr = F.trace, S = P.summary, last = tr[tr.length - 1], dead = !!last.noSlot;
    // The axis runs to the base, or — the journey stopped at a repeater with
    // no slot — a slot past the last hop that was drawn.
    const L = Math.max(1, dead ? Math.max(...tr.filter(h => h.endMs != null).map(h => h.endMs)) + S.slotMs : last.arriveMs);
    const JX0 = 170, JX1 = 960, k = (JX1 - JX0) / L, x = ms => JX0 + ms * k;
    const rowH = 28, top = 24, H = rowH * tr.length + 40;
    let marks = '';
    tr.forEach((h, i) => {
      const y = top + i * rowH + rowH / 2;
      marks += `<text class="tdp-rowlab" x="20" y="${fmt1(y + 4)}">${esc(h.name.length > 22 ? h.name.slice(0, 21) + '…' : h.name)}</text>`;
      if (h.noSlot) { marks += `<text class="tdp-rowlab tdp-rowlab-bad" x="${fmt1(x(L))}" y="${fmt1(y + 4)}" text-anchor="end">no slot — latency unknown</text>`; return; }
      if (h.role === 'base') { marks += `<circle class="tdp-base-mark" cx="${fmt1(x(h.arriveMs))}" cy="${fmt1(y)}" r="6"><title>${esc(`Home at ${secs(h.arriveMs)}`)}</title></circle>`; return; }
      const rep = h.role === 'repeater', hh = rep ? 20 : 16;
      marks += `<line class="tdp-hop" x1="${fmt1(x(h.readyMs))}" x2="${fmt1(x(h.startMs))}" y1="${fmt1(y)}" y2="${fmt1(y)}"/>
        <rect class="tdp-slot tdp-slot-${rep ? 'rep' : 'field'}" x="${fmt1(x(h.startMs))}" y="${fmt1(y - hh / 2)}" width="${fmt1(Math.max(1.5, (h.endMs - h.startMs) * k))}" height="${hh}"><title>${esc(`${h.name} transmits ${secs(h.startMs)}–${secs(h.endMs)} after the report is ready`)}</title></rect>
        <circle class="tdp-report" cx="${fmt1(x(h.endMs))}" cy="${fmt1(y)}" r="4"/>`;
      if (i + 1 < tr.length && tr[i + 1].role !== 'base') marks += `<line class="tdp-hop" x1="${fmt1(x(h.endMs))}" x2="${fmt1(x(h.endMs))}" y1="${fmt1(y)}" y2="${fmt1(y + rowH)}"/>`;
    });
    let axis = '';
    const step = axisStep(L);
    for (let t = 0; t <= L; t += step) axis += `<line class="tdp-grid-minor" x1="${fmt1(x(t))}" x2="${fmt1(x(t))}" y1="${top - 4}" y2="${H - 22}"/><text class="tdp-axis" x="${fmt1(x(t))}" y="${H - 10}" text-anchor="${t === 0 ? 'start' : 'middle'}">${secs(t)}</text>`;
    const nowX = fmt1(x(stillPreferred() ? tr[0].startMs : Math.min(L, F.F0 || 0)));
    const verdict = dead
      ? `<p class="small txt-warn">Latency unknown: ${esc(last.name)} has no slot, so ${esc(F.name)}'s report gets no further — lengthen the frame or shorten the slots.</p>`
      : `<p class="small">Worst case ${secs(L)}: a report ready just after ${esc(F.name)}'s slot has started waits up to ${secs(S.frameMs)} for its next slot,
      then at every hop for that repeater's next run; typical about ${secs(Math.max(0, L - S.frameMs / 2))}.${has(F.warnings, 'W_WRAP') ? ' <span class="txt-warn">It waits a frame at a repeater whose slot comes before its own.</span>' : ''}</p>`;
    return `<svg viewBox="0 0 980 ${H}" role="img" aria-labelledby="tdp-j-t tdp-j-d">
      <title id="tdp-j-t">${esc(F.name)}'s report: ${dead ? `latency unknown — ${esc(last.name)} has no slot` : `home in ${secs(L)} over ${nf(F.hops)} hop${F.hops === 1 ? '' : 's'}`}</title>
      <desc id="tdp-j-d">One row per hop from the station to the base; a dashed line while a report waits for the next slot, a bar while it is on air, a dot where it is handed on.</desc>
      ${marks}${axis}
      <line id="tdp-now" class="tdp-playhead" x1="${nowX}" x2="${nowX}" y1="${top - 8}" y2="${H - 22}"/>
    </svg>
    ${verdict}`;
  }
  function journeySection(P) {
    const F = followed(P), S = P.summary;
    const tx = P.devices.filter(d => d.slots.length);
    const dflt = S.worstDeviceId ? `the slowest: ${(P.devices.find(d => d.id === S.worstDeviceId) || { name: '—' }).name}`
      : S.busiestDeviceId ? `the busiest: ${(P.devices.find(d => d.id === S.busiestDeviceId) || { name: '—' }).name}` : '—';
    return `<section class="panel tdp-sec tdp-journey" aria-labelledby="tdp-j-h">
      <h3 id="tdp-j-h">3. One report's journey</h3>
      <label class="tdp-ctl tdp-follow" for="tdp-follow"><span>Follow a report from</span>
        <select id="tdp-follow" onchange="TdmaPlanner.follow(this.value)">
          <option value=""${sc.follow ? '' : ' selected'}>${esc(dflt)}</option>
          ${tx.map(d => `<option value="${esc(d.id)}"${sc.follow === d.id ? ' selected' : ''}>${esc(d.name)} · ${roleWord[d.role]}${d.latencyS != null ? ` · ${secs(d.latencyS * 1000)}` : d.noSlotAt ? ' · latency unknown' : ''}</option>`).join('')}
        </select></label>
      ${F && F.trace ? `<figure class="tdp-fig">${journeySvg(P, F)}</figure>` : '<p class="small">Nothing is placed yet.</p>'}
    </section>`;
  }

  // ── the slot plan ──
  const warnHtml = w => w.map(x => `<span class="${/^I_/.test(x.code) ? 'txt-muted' : /^E_|W_OVER|W_HOPS/.test(x.code) ? 'txt-bad' : 'txt-warn'}">${esc(x.text)}</span>`).join('; ');
  // The slot plan's twelve columns and their share of the table, so the
  // headers read in full at every width (the table scrolls in its wrapper
  // below 64rem rather than clipping a word).
  const PLAN_COLS = [['Device', 13.5], ['Role', 7.5], ['Hops', 5.5], ['Slots', 8], ['Offset (s)', 7], ['Length (ms)', 7.5], ['Window (ms)', 7.5],
                     ['Capacity (B)', 8.5], ['Peak (B)', 6], ['Use', 6.5], ['Latency (s)', 7.5], ['Notes', 15]];
  const PLAN_NUM = new Set(['Hops', 'Offset (s)', 'Length (ms)', 'Window (ms)', 'Capacity (B)', 'Peak (B)', 'Use', 'Latency (s)']);
  function planTableSection(P) {
    const S = P.summary, N = cur().network;
    const nameCell = d => (d.register && d.id !== 'base:virtual' ? `<button type="button" class="link-btn" onclick="goToStation('${escAttr(d.id)}')">${esc(d.name)}</button>` : esc(d.name));
    const order = P.order.map(id => P.devices.find(d => d.id === id));
    const rows = [];
    for (const b of P.devices.filter(d => d.role === 'base')) {
      rows.push(`<tr><th scope="row">${nameCell(b)}</th><td>base</td><td class="tdp-num">—</td><td>receives</td><td class="tdp-num">—</td><td class="tdp-num">—</td><td class="tdp-num">—</td><td class="tdp-num">—</td><td class="tdp-num">—</td><td class="tdp-num">—</td><td class="tdp-num">—</td><td>${warnHtml(b.warnings)}</td></tr>`);
    }
    for (const d of order) {
      const sl = d.slots;
      rows.push(`<tr><th scope="row">${nameCell(d)}</th><td>${roleWord[d.role]}</td><td class="tdp-num">${nf(d.hops)}</td>
        <td>${d.unplaced && !sl.length ? '<span class="txt-bad">none</span>' : sl.map(slotsText).join('; ')}</td>
        <td class="tdp-num">${sl.map(s => nfd(s.offsetMs / 1000, 2)).join('; ') || '—'}</td>
        <td class="tdp-num">${sl.map(s => nf(s.lengthMs)).join('; ') || '—'}</td>
        <td class="tdp-num">${sl.map(s => nf(s.windowMs)).join('; ') || '—'}</td>
        <td class="tdp-num">${sl.length ? nf(d.capacityBytes) : '—'}</td>
        <td class="tdp-num">${sl.length ? nf(d.peakBytes) : '—'}</td>
        <td class="tdp-num">${sl.length ? pct(100 * d.utilisation) : '—'}</td>
        <td class="tdp-num">${d.latencyS != null ? nfd(d.latencyS, 1) : d.noSlotAt ? '<span class="txt-warn">—, repeater has no slot</span>' : '—'}</td>
        <td>${warnHtml(d.warnings)}${d.unplaced ? `${d.warnings.length ? '; ' : ''}<span class="txt-bad">no slot — the frame is full</span>` : ''}</td></tr>`);
      if (d.role === 'repeater') {
        const leg = P.devices.filter(x => x.parentId === d.id && x.legacyAloha).length;
        if (leg) {
          const m = Math.ceil(leg * sc.legacyPerMin * S.frameMs / 60000);
          rows.push(`<tr class="tdp-sub"><td></td><td colspan="11" class="small">${nf(leg)} legacy ALERT gauge${leg === 1 ? '' : 's'} concentrated here: ${nf(m)} record${m === 1 ? '' : 's'} per frame, ${nf(Math.ceil(m / S.sectors))} a run</td></tr>`);
        }
      }
    }
    const placed = order.filter(d => d.slots.length);
    rows.push(`<tr class="tdp-total"><th scope="row">${nf(placed.length)} transmitters</th><td></td><td class="tdp-num">${nf(S.maxHops)} max</td><td>${nf(S.used)} of ${nf(S.allocUnits)}</td><td class="tdp-num"></td>
      <td class="tdp-num">${nf(S.used * S.slotMs)}</td><td class="tdp-num"></td><td class="tdp-num">${nf(placed.reduce((a, d) => a + d.capacityBytes, 0))}</td>
      <td class="tdp-num">${nf(placed.reduce((a, d) => a + d.peakBytes, 0))}</td><td class="tdp-num">${pct(S.byteUtilPct)}</td><td class="tdp-num">${S.worstLatencyS != null ? nfd(S.worstLatencyS, 1) : '—'}</td>
      <td>${warnHtml(S.warnings.concat(P.errors))}</td></tr>`);
    return `<section class="panel tdp-sec" aria-labelledby="tdp-plan-h">
      <h3 id="tdp-plan-h">4. The slot plan</h3>
      <div class="table-wrap tall" role="region" tabindex="0" aria-labelledby="tdp-plan-h"><table class="tdp-table tdp-plan-table">
        <caption class="sr-only">Slot plan: one row per transmitter</caption>
        <colgroup>${PLAN_COLS.map(([, w]) => `<col style="--w:${w}%">`).join('')}</colgroup>
        <thead><tr>${PLAN_COLS.map(([h]) => `<th scope="col"${PLAN_NUM.has(h) ? ' class="tdp-num"' : ''}>${h}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('')}</tbody></table></div>
      <p class="small txt-muted">${N.source === 'register' ? 'Addresses and sensors are the register’s; a station’s name opens it on the Stations tab.' : 'A sketch: addresses are made up in blocks (repeaters from 101, stations from 1001).'}
        Peak bytes are MANT PDUs at the storm peak; capacity is the largest payload the run’s window carries after the clock buffers.${sc.fieldEvery && S.sectors > 1
          ? ` With field stations transmitting in every one of the ${nf(S.sectors)} repeater slots, each run is sized for a full report from every station — a worst case per run — so a device’s peak bytes and the totals are ${nf(S.sectors)} × one report.` : ''}</p>
    </section>`;
  }

  // ── the configuration sheet ──
  const NOT_IN_MENUS = 'not in the documented menus';
  const ONE_SLOT = 'IND API v1.0 and the AL200 take one Slot Length and one Slot Start Offset per device; the AirLink allows several — confirm your IND accepts several slots, or split the repeater';
  const ranges = addrs => {
    const a = [...new Set(addrs.filter(x => x != null))].sort((x, y) => x - y);
    const out = [];
    for (const v of a) { const last = out[out.length - 1]; if (last && last[1] === v - 1) last[1] = v; else out.push([v, v]); }
    return out.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}–${hi}`)).join(', ');
  };
  function sheetRows(d, P) {
    const S = P.summary, s = sc, path = s.path ? 1 : 0;
    const R = (setting, ind, ert, value, noteTxt) => ({ setting, ind, ert, value, note: noteTxt || '' });
    if (d.role === 'base') {
      return [R('Role', '—', 'Unit Type (Communications)', 'Receiver Base', 'receives only; no radio transmission, so the plan imposes no timing on it'),
              R('Output', '—', 'RS-485 to the 115E-2 (ALERT2 In, 9600 8N1)', '—', 'the ERRTS IO Gateway carries the decoded reports on')];
    }
    const rows = [
      R('Role', '—', 'Unit Type (Communications)', d.role === 'repeater' ? 'Repeater (store and forward)' : 'Field Station', ''),
      R('Address', 'Source Address (24), 1–65534', 'Station Address (Unit Config), 1–65534', d.address != null ? String(d.address) : 'assign', d.register ? 'the register’s primary ALERT id' : 'made up for the sketch'),
      R('Destination', 'Destination Address (25); Add DA in Header (27)', '—', '1 / off', 'not stated in the ERT-A2 manuals'),
      R('Frame', 'TDMA Frame Length (72)', NOT_IN_MENUS, `${nf(S.frameMs)} ms`, 'confirm with ELPRO where it is set and in what units'),
      R('Frame start', 'TDMA Frame Start Offset (73)', NOT_IN_MENUS, `${nf(S.frameStartS * 1000)} ms`, ''),
    ];
    if (d.slots.length) d.slots.forEach((sl, i) => rows.push(R(`Slot${d.slots.length > 1 ? ` (sector ${sl.sector + 1})` : ''}`, 'TDMA Slot Length (74); TDMA Slot Start Offset (75)', NOT_IN_MENUS,
      `${nf(sl.lengthMs)} ms at ${nf(sl.offsetMs)} ms${S.frameStartS ? ' + the frame start' : ''}`, `slot${sl.units === 1 ? '' : 's'} ${slotsText(sl)}; AL200: offsets in 500 ms steps, at most frame − 500 ms${i > 0 ? `. ${ONE_SLOT}` : ''}`)));
    else rows.push(R('Slot', 'TDMA Slot Length (74); TDMA Slot Start Offset (75)', NOT_IN_MENUS, 'none — the frame is full', 'lengthen the frame or shorten the slots'));
    rows.push(
      R('Buffer', 'Transmission Delay into Slot (78), 25–250 ms; Center Transmission in Slot (79)', NOT_IN_MENUS, `${nf(S.bufferMs)} ms / on (1)`, 'the clock buffer either side of the air time'),
      R('TDMA', 'enable TDMA (80)', '—', '1', 'the GPS option is required for ALERT2 TDMA operation'),
      R('Hop limit', 'Hop Limit (64), 0–6; 7 = not enabled', NOT_IN_MENUS, String(Math.min(d.hopLimit ?? d.hops, 7)), d.hops > PROTO.HOP_MAX ? 'more than 6 hops cannot be expressed' : 'the ERT-A2 capture showed 1; configurability not stated'),
      R('Path', `enable Add Path Service (26)${d.role === 'repeater' ? '; Echo Suppression (63, forces path on)' : ''}`, NOT_IN_MENUS, d.role === 'repeater' ? `${path} / ${path}` : String(path), 'recommended with echo suppression on multi-repeater networks'),
      R('Timestamp', 'enable IND time stamp service (40)', '— (the unit stamps when it has time)', '1', 'not a menu setting'),
      R('Radio timing', 'Carrier Only time (96); AGC time (97); RF Tail time (98)', '—', `${nf(s.carrierMs)} / ${nf(s.agcMs)} / 5 ms`, 'the IND API’s defaults are 10 / 55 / 5 ms; Telos planned with 60 / 15'),
      R('Clock', 'GPS clock Turn On period (76); Maximum On time (77)', 'GPS Update; GPS Maximum On', '60 min / 5 min (IND defaults)', 'GPS Update — units not stated; GPS Maximum On — minutes'),
      R('Power-up', 'Radio Transceiver Power-up (102); Audio Preload (103)', '—', '750 ms / 100 ms', 'IND defaults'),
    );
    if (d.role === 'repeater') {
      const kids = P.devices.filter(x => x.parentId === d.id);
      const list = d.passRanges && d.passRanges.length ? d.passRanges.map(r => `${r.low}–${r.high}`).join(', ') : ranges(kids.map(x => x.address));
      rows.push(R('Pass list', 'Address lists (49–56): list 0, Pass, Source Address, ranges', 'Address List 1 of 4 (32 ranges): Status Enable, Action Pass, Entries', list || 'none', d.passRanges ? 'the register’s pass ranges' : `the ${nf(kids.length)} devices under it; 1 pass list and up to 3 reject lists`));
      rows.push(R('Repeater delay', '—', 'Repeater Delay', '0 — planner’s assumption: the slots do the staggering', 'the manual asks for > 200 ms with multiple repeaters (Sept 2025 manual, lines 1250–1252); TDMA behaviour not stated'));
      const leg = kids.filter(x => x.legacyAloha).length;
      if (leg) rows.push(R('Concentration', '—', 'a linked receiver in ALERT mode on RS-485', `${nf(leg)} legacy gauges, ${nf(Math.ceil(leg * s.legacyPerMin * S.frameMs / 60000))} records a frame`,
        'the manual’s mechanism: a second unit receiving legacy ALERT, linked on RS-485, whose readings the repeater sends on as ALERT2 concentration frames (Sept 2025 manual, lines 742–748, 1369–1370); a reading waits at most 255 s for the run'));
    } else {
      rows.push(R('Report cadence', '—', 'Update Time (min); Paralysis Time (s); Report Sensitivity', `${nf(s.reportsPerFrame)} report${s.reportsPerFrame === 1 ? '' : 's'} a frame assumed`, 'defaults 180 min; 10 s or 600 s (the manuals disagree); 10 sensor-value changes (10 mm on a river)'));
    }
    rows.push(R('Format', '—', 'Report Format; Agency ID', 'ALERT2 / —', 'the Agency ID’s format is not stated'));
    return rows;
  }
  // A device's sheet is a table of a dozen rows; with hundreds of devices
  // that is most of the page. So each fold holds its summary alone until it
  // is opened — the first one open is filled at once, the rest on their
  // toggle — and print() fills every one before the paper sees them.
  function sheetTableHtml(d, P) {
    return `<div class="table-wrap"><table class="tdp-table"><caption class="sr-only">Configuration for ${esc(d.name)}</caption>
          <thead><tr><th scope="col">Setting</th><th scope="col">IND API name</th><th scope="col">ERT-A2 name</th><th scope="col">Value</th><th scope="col">Note</th></tr></thead>
          <tbody>${sheetRows(d, P).map(r => `<tr><th scope="row">${esc(r.setting)}</th><td>${esc(r.ind)}</td><td>${esc(r.ert)}</td><td>${esc(r.value)}</td><td class="small">${esc(r.note)}</td></tr>`).join('')}</tbody>
        </table></div>`;
  }
  function sheetToggle(el) {
    if (!el || !el.open) return;
    const body = el.querySelector('.tdp-sheet-body');
    if (!body || body.firstElementChild) return;
    const { plan: P } = cur();
    const d = P.summary ? P.devices.find(x => x.id === el.getAttribute('data-dev')) : null;
    if (d) body.innerHTML = sheetTableHtml(d, P);
  }
  function fillOpenSheets(root) { for (const el of root.querySelectorAll('details.tdp-sheet-d[open]')) sheetToggle(el); }
  function sheetSection(P) {
    const order = P.order.map(id => P.devices.find(d => d.id === id));
    const all = P.devices.filter(d => d.role === 'base').concat(order);
    let first = true;
    const blocks = all.map(d => {
      const open = first && d.role !== 'base'; if (open) first = false;
      return `<details class="tdp-more tdp-sheet-d" id="${htmlId(d.id)}" data-dev="${esc(d.id)}"${open ? ' open' : ''} ontoggle="TdmaPlanner.sheetToggle(this)"><summary>${esc(d.name)} — ${roleWord[d.role]}${d.slots.length ? `, slot${d.slots.length > 1 || d.slots[0].units > 1 ? 's' : ''} ${d.slots.map(slotsText).join('; ')}` : ''}</summary>
        <div class="tdp-sheet-body">${open ? sheetTableHtml(d, P) : ''}</div></details>`;
    }).join('');
    return `<section class="panel tdp-sec tdp-sheet" aria-labelledby="tdp-sheet-h">
      <h3 id="tdp-sheet-h">5. What to configure</h3>
      <p class="small">Two names for every setting: the <strong>IND API</strong> field an ALERT2 encoder is configured with (its TLV type in brackets) and the
        <strong>ERT-A2</strong> menu item. The ERT-A2 manuals do not expose any frame, slot, offset, hop-limit or path field — the only TDMA mention is that the
        GPS option is required — so those rows say <em>${NOT_IN_MENUS}</em>: confirm with ELPRO where they are set.</p>
      ${blocks}
      <h4>Questions only ELPRO can answer</h4>
      <ul class="small">
        <li>Where the frame length, slot length and slot offset are set on an ERT-A2, and in what units.</li>
        <li>The units of GPS Update, and Repeater Delay’s behaviour under TDMA.</li>
        <li>Whether hop limit, path service and the APDU IDs are configurable.</li>
        <li>Whether a repeater aggregates every PDU it holds into one AirLink frame per slot, as the protocol allows.</li>
        <li>Whether a linked receiver and repeater share one Station Address, and the Agency ID’s format.</li>
      </ul>
      <p class="small txt-muted">The settings, restated for paper: ${esc(sc.source === 'register' ? `the register, ${nf(sc.regHubs.length)} hub${sc.regHubs.length === 1 ? '' : 's'} picked` : 'a sketch')} · ${ALL_CONTROLS.map(c => `${esc(c.label)} ${esc(ctlValue(c, sc[c.k]))}`).join(' · ')}.</p>
    </section>`;
  }

  function outHtml() {
    const { plan: P } = cur();
    if (!P.summary) {
      return `<section class="panel tdp-sec" aria-labelledby="tdp-tl-h"><h3 id="tdp-tl-h">2. The frame</h3>
        <p class="small txt-warn">The settings do not make a valid frame: ${P.errors.map(e => esc(e.text)).join('; ')}. Fix them on the card and the plan is worked again.</p></section>`;
    }
    return timelineSection(P) + journeySection(P) + planTableSection(P) + sheetSection(P);
  }

  // ── painting ──
  function onTab() { return typeof state !== 'undefined' && state && state.activeTab === 'tdma' && typeof document !== 'undefined'; }
  let liveRaf = 0;
  function repaint() {
    if (!onTab()) return;
    const el = document.getElementById('main-content');
    if (!el) return;
    stop();
    if (liveRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(liveRaf);
    liveRaf = 0;
    el.innerHTML = render();
    init();
  }
  // Only what the plan moves is rewritten: the tiles and everything under the
  // card. The picker and the card stay, so the slider being dragged keeps its
  // focus and its place; a fold somebody opened or shut stays as it was. A
  // burst of slider ticks paints once, on the next animation frame.
  function repaintLive() {
    if (!onTab()) return;
    if (typeof requestAnimationFrame !== 'function') { repaintLiveNow(); return; }
    if (!liveRaf) liveRaf = requestAnimationFrame(() => { liveRaf = 0; repaintLiveNow(); });
  }
  function repaintLiveNow() {
    if (!onTab()) return;
    const k = document.getElementById('tdp-kpis'), o = document.getElementById('tdp-out');
    if (!k || !o) { repaint(); return; }
    const open = new Set([...o.querySelectorAll('details[id][open]')].map(d => d.id));
    const shut = new Set([...o.querySelectorAll('details[id]:not([open])')].map(d => d.id));
    const focus = document.activeElement && o.contains(document.activeElement) ? document.activeElement.id : null;
    k.innerHTML = kpisHtml();
    o.innerHTML = outHtml();
    for (const id of open) { const d = document.getElementById(id); if (d && o.contains(d)) d.open = true; }
    for (const id of shut) { const d = document.getElementById(id); if (d && o.contains(d)) d.open = false; }
    fillOpenSheets(o);
    if (focus) { const el = document.getElementById(focus); if (el) el.focus(); }
    const sum = document.getElementById('tdp-net-sum');
    if (sum) sum.innerHTML = netSumHtml();
    const chips = document.getElementById('tdp-hub-list');
    if (chips) chips.innerHTML = hubChipsHtml();
    const picked = document.getElementById('tdp-hubs-n');
    if (picked) picked.textContent = `${nf(sc.regHubs.length)} picked`;
    bindAnim();
  }
  function syncOutputs() {
    for (const c of ALL_CONTROLS) {
      if (c.kind !== 'range') continue;
      const out = document.getElementById(`tdp-c-${c.k}-o`);
      const txt = ctlValue(c, sc[c.k]);
      if (out && out.textContent !== txt) out.textContent = txt;
      const inp = document.getElementById(`tdp-c-${c.k}`);
      if (inp) inp.setAttribute('aria-valuetext', txt);
    }
  }

  function set(k, v) {
    ensure();
    if (!(k in DEFAULTS)) return;
    const d = DEFAULTS[k];
    if (typeof d === 'boolean') sc[k] = !!v;
    else if (typeof d === 'number') { const n = Number(v); if (!isFinite(n)) return; sc[k] = n; }
    else if (Array.isArray(d)) { if (!Array.isArray(v)) return; sc[k] = v.map(String); }
    else sc[k] = String(v);
    sc = sanitize(sc);
    saveScenario();
    if (typeof document !== 'undefined') syncOutputs();
    repaintLive();
  }
  function preset(id) {
    ensure();
    const p = PRESETS.find(x => x.id === id);
    if (!p) return;
    // A preset describes a sketch, so it is one: the register's hubs are kept
    // for when the source is switched back.
    sc = sanitize({ ...DEFAULTS, ...p.set, source: 'sketch', regHubs: sc.regHubs, follow: '' });
    saveScenario();
    repaint();
    if (typeof announce === 'function') announce(`${p.label}: a sketch — the plan is worked again.`);
  }
  function source(v) {
    ensure();
    if (!ENUMS.source.includes(v)) return;
    sc.source = v; sc = sanitize(sc); saveScenario(); repaint();
  }
  function hubs(el) {
    ensure();
    if (!el || !el.selectedOptions) return;
    sc.regHubs = [...el.selectedOptions].map(o => o.value);
    sc = sanitize(sc); saveScenario(); repaintLive();
  }
  function pickHub(id) {
    ensure();
    if (typeof id !== 'string' || !id) return;
    if (!sc.regHubs.includes(id)) sc.regHubs = sc.regHubs.concat(id);
    sc = sanitize(sc); saveScenario();
    const sel = typeof document !== 'undefined' ? document.getElementById('tdp-hubs') : null;
    if (sel) for (const o of sel.options) if (o.value === id) o.selected = true;
    repaintLive();
    const N = cur().network, h = N.devices.find(d => d.id === id);
    const n = N.devices.filter(d => d.parents && d.parents[0] === id && d.role === 'field').length;
    if (typeof announce === 'function') announce(`${h ? h.name : id} added: ${n} station${n === 1 ? '' : 's'}.`);
  }
  function unpickHub(id) {
    ensure();
    sc.regHubs = sc.regHubs.filter(x => x !== id);
    sc = sanitize(sc); saveScenario();
    const sel = typeof document !== 'undefined' ? document.getElementById('tdp-hubs') : null;
    if (sel) { for (const o of sel.options) if (o.value === id) o.selected = false; sel.focus(); }
    repaintLive();
  }
  function follow(id) {
    ensure();
    sc.follow = String(id || ''); sc = sanitize(sc); saveScenario(); repaintLive();
  }
  function useSuggested() {
    ensure();
    const f = suggested();
    if (f == null) return;
    set('frameMs', f);
    // The button that was pressed is about to be repainted away: focus goes
    // to the control that took its value.
    const sel = typeof document !== 'undefined' ? document.getElementById('tdp-c-frameMs') : null;
    if (sel) { sel.value = String(f); sel.focus(); }
  }

  // ── 7. the animation ─────────────────────────────────────────────────────
  // One playhead over the frame timeline and one over the journey, driven by
  // one clock in frame-ms that sweeps a frame in 8 s of real time. Nothing is
  // rebuilt per frame: two lines move and one class toggles.
  let S_ = null;
  const stillPreferred = () => {
    try { return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (_) { return false; }
  };
  function bindAnim() {
    if (!S_) return;
    const { plan: P } = cur();
    const F = P.summary ? followed(P) : null;
    S_.frameMs = P.summary ? P.summary.frameMs : 0;
    S_.speed = S_.frameMs / 8000;
    if (S_.frameMs) S_.clock = S_.clock % S_.frameMs;
    S_.head = document.getElementById('tdp-playhead');
    S_.now = document.getElementById('tdp-now');
    S_.follow = F;
    S_.sel = F ? [...document.querySelectorAll('svg.tdp-anim [data-id], svg.tdp-anim [data-ids]')]
      .filter(el => el.getAttribute('data-id') === F.id || (el.getAttribute('data-ids') || '').split(' ').includes(F.id)) : [];
    S_.L = F && F.trace ? F.trace[F.trace.length - 1].arriveMs : 0;
    const svg = document.querySelector('svg.tdp-anim');
    if (S_.io) { S_.io.disconnect(); if (svg) S_.io.observe(svg); }
    paint();
  }
  function paint() {
    if (!S_ || !S_.frameMs) return;
    const c = S_.clock;
    if (S_.head) { const x = fmt1(X0 + c * TW / S_.frameMs); S_.head.setAttribute('x1', x); S_.head.setAttribute('x2', x); }
    const F = S_.follow;
    if (S_.now && F && F.trace) {
      let j = (F.F0 || 0) + c;
      if (j > S_.L) j -= S_.frameMs;
      const x = fmt1(170 + Math.max(0, j) * (790 / Math.max(1, S_.L)));
      S_.now.setAttribute('x1', x); S_.now.setAttribute('x2', x);
    }
    if (F) {
      const inside = F.slots.some(s => c >= s.offsetMs && c < s.offsetMs + s.lengthMs);
      for (const el of S_.sel) el.classList.toggle('tdp-slot-sel', inside);
    }
    const btn = document.getElementById('tdp-play');
    const want = S_.playing ? '⏸ Pause' : '▶ Play';
    if (btn && btn.textContent !== want) btn.textContent = want;
  }
  function frame(ts) {
    if (!S_) return;
    S_.raf = 0;
    const dt = S_.lastTs ? Math.min(100, ts - S_.lastTs) : 0;
    S_.lastTs = ts;
    if (S_.playing && S_.onScreen && S_.frameMs) S_.clock = (S_.clock + dt * S_.speed) % S_.frameMs;
    paint();
    if (S_.playing) S_.raf = requestAnimationFrame(frame);
  }
  function kick() { if (S_ && !S_.raf && typeof requestAnimationFrame === 'function') S_.raf = requestAnimationFrame(frame); }
  function play() { if (!S_) return; S_.playing = true; S_.lastTs = 0; kick(); }
  function pause() { if (!S_) return; S_.playing = false; paint(); }
  function toggle() { if (!S_) return; if (S_.playing) pause(); else play(); }
  function replay() { if (!S_) return; S_.clock = 0; play(); }
  function playing() { return !!(S_ && S_.playing); }
  function stop() {
    if (!S_) return;
    if (S_.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(S_.raf);
    if (S_.io) S_.io.disconnect();
    S_ = null;
  }
  function init() {
    ensure();
    if (typeof registerTabTeardown === 'function') registerTabTeardown('TdmaPlanner', stop);
    if (stillPreferred()) return;
    stop();
    S_ = { raf: 0, clock: 0, lastTs: 0, playing: false, onScreen: true, io: null, speed: 0, frameMs: 0, head: null, now: null, follow: null, sel: [], L: 0 };
    S_.io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(es => { if (!S_) return; S_.onScreen = es.some(x => x.isIntersecting); if (S_.onScreen) kick(); })
      : null;
    bindAnim();
  }

  // ── 8. the exports ────────────────────────────────────────────────────────
  function settingRows() {
    return ALL_CONTROLS.map(c => [c.label, ctlValue(c, sc[c.k])]).concat([['Network source', sc.source === 'register' ? `the register: ${sc.regHubs.length} hubs picked` : 'a sketch']]);
  }
  function exportCsv() {
    ensure();
    const { plan: P } = cur();
    if (!P.summary) { if (typeof announce === 'function') announce('The settings do not make a valid frame; nothing to save.'); return; }
    const head = ['Device', 'Role', 'Hops', 'Slots', 'Offset ms', 'Length ms', 'Window ms', 'Capacity bytes', 'Peak bytes', 'Use %', 'Latency s', 'Hop limit', 'Notes'];
    const rows = [head];
    for (const id of P.order) {
      const d = P.devices.find(x => x.id === id), sl = d.slots;
      rows.push([d.name, d.role, d.hops, sl.map(slotsText).join('; ') || (d.unplaced ? 'none' : ''), sl.map(s => s.offsetMs).join('; '), sl.map(s => s.lengthMs).join('; '),
        sl.map(s => s.windowMs).join('; '), sl.length ? d.capacityBytes : '', sl.length ? d.peakBytes : '', sl.length ? Math.round(1000 * d.utilisation) / 10 : '',
        d.latencyS != null ? d.latencyS : '', d.hopLimit ?? '',
        d.warnings.map(w => w.text).concat(d.unplaced ? ['no slot — the frame is full'] : [], d.noSlotAt ? [`latency unknown: ${d.noSlotAt} has no slot`] : []).join('; ')]);
    }
    const lines = rows.map(r => r.map(csvEscape).join(','));
    lines.push('', 'Setting,Value');
    for (const [k, v] of settingRows()) lines.push(`${csvEscape(k)},${csvEscape(v)}`);
    for (const w of P.summary.warnings.concat(P.errors)) lines.push(`${csvEscape('Note')},${csvEscape(w.text)}`);
    dlText(`tdma-plan-${Math.round(P.summary.frameMs / 1000)}s.csv`, lines.join('\r\n') + '\r\n');
    if (typeof announce === 'function') announce('Saved the slot plan as CSV.');
  }
  function exportSheetCsv() {
    ensure();
    const { plan: P } = cur();
    if (!P.summary) { if (typeof announce === 'function') announce('The settings do not make a valid frame; nothing to save.'); return; }
    const rows = [['Device', 'Role', 'Address', 'Field', 'IND name', 'ERT-A2 name', 'Value', 'Note']];
    const all = P.devices.filter(d => d.role === 'base').concat(P.order.map(id => P.devices.find(d => d.id === id)));
    for (const d of all) for (const r of sheetRows(d, P)) rows.push([d.name, d.role, d.address ?? '', r.setting, r.ind, r.ert, r.value, r.note]);
    dlText(`tdma-config-sheet-${Math.round(P.summary.frameMs / 1000)}s.csv`, rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n');
    if (typeof announce === 'function') announce('Saved the configuration sheet as CSV.');
  }
  // The folded sheets go on paper too: opened for the print and folded again
  // after, so the screen is left as it was.
  function print() {
    if (typeof window === 'undefined' || !window.print) return;
    const shut = [...document.querySelectorAll('#tdp-out details.tdp-more:not([open])')];
    shut.forEach(d => { d.open = true; });
    fillOpenSheets(document);
    try { window.print(); } finally { shut.forEach(d => { d.open = false; }); }
  }

  return {
    render, init, set, preset, source, hubs, pickHub, unpickHub, follow, useSuggested, sheetToggle,
    toggle, play, pause, replay, playing,
    exportCsv, exportSheetCsv, print,
    reset() { ensure(); sc = sanitize({}); saveScenario(); repaint(); },
    // Pure, for the tests and for anyone else who wants the arithmetic.
    PROTO, frameBytes, rfMs, airtimeMs, windowMs, capacityBytes, unitsFor, validFrames, validate,
    reportBytes, concentrationBytes, sketchNetwork, registerNetwork, allocate, suggestFrame,
    // The scenario, the network and the plan as they stand.
    scenario: () => ({ ...ensure(), regHubs: ensure().regHubs.slice() }),
    defaults: () => ({ ...DEFAULTS, regHubs: [] }),
    network: () => cur().network,
    plan: () => cur().plan,
  };
})();
if (typeof window !== 'undefined') window.TdmaPlanner = TdmaPlanner;
