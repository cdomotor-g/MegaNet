// MegaNet — sensor-values.js
//
//   SensorValues   what an ALERT reading means: which station and which sensor
//                  an address is, and what its raw count is in engineering
//                  units — when that can be said honestly, and a sentence
//                  saying why not when it cannot.
//
// After core.js (state, stationSensors, bucketSizeMm) and app.js
// (stationAlertIds); before message-log.js and the Station Health tab
// (health-analysis.js, health.js), which read it. Nothing here runs at load.
//
// ── Why this is a file of its own ────────────────────────────────────────────
// The datastore keeps the raw count and, when the adapter sent one, a
// converted value (0006's point 5: raw values are the truth). Every reading an
// RTL-SDR or a radio hears off the air arrives with the count alone — a
// battery as 133, a rain gauge as 43 — so the Message Log's Value column was
// empty for exactly the traffic it is now mostly made of. The rules for
// turning a count into a value were already written once, on the ALERT2 /
// ERT-A2 tab (alert2.js, kindOf and engValue), against the reference capture:
//
//   battery   raw ÷ 10 = volts. 213 readings cluster at 130–142, which is
//             13.0–14.2 V and nothing else, and the network's own traffic
//             agrees — 2,453 of the battery readings heard in the first four
//             days of the Raspberry Pi feed sit between 128 and 158.
//   rainfall  raw × the bucket = millimetres, cumulative. The bucket is the
//             station's recorded TBRGbucketSize when it has one, 0.2 mm/tip
//             assumed when it does not, and the rule says which.
//   level     no conversion. Its scale is set per site and nothing in MegaNet
//             records it, so a number invented here would read like a
//             measurement — the count is the reading, and the cell says so.
//
// Those rules are restated here rather than reached into, because alert2.js
// keeps them inside its module (and lets its battery divisor be changed per
// capture); this file is where the rest of the app gets them. The ALERT2 tab's
// copy is the one with a box beside it, and the two say the same thing.
//
// ── Which station, when an address is shared ─────────────────────────────────
// 604 of 5,122 ALERT addresses belong to more than one station, and a shared
// address is usually shared across the country: the sensor rows for 4801 say
// Battery at Alice Gap repeater and at Mount Useful, and Water Level at
// Karalee — and only one of those is anywhere near a receiver in south-east
// Queensland. The kind decides the conversion, so it cannot be "the first
// station on file". The ALERT2 tab settled this for a capture (alert2.js,
// resolve()) and the same two pieces of evidence carry over to the datastore:
//
//   where the receiver hears   every reading that came in through one ingress
//                              path came off one receiver. Addresses that match
//                              exactly one station fix where that receiver
//                              listens (the median, so one stray does not drag
//                              it), and a shared address resolves to the
//                              candidate near it — when the next nearest is at
//                              least GAP_KM further away.
//   what else it heard         a candidate whose *other* addresses were heard
//                              on the same path is the likelier owner.
//
// Noise lands on every address in time. A week of the Raspberry Pi feed in
// Nov 2026 held readings on 7,104 addresses, most of the register, 1,823 of
// them heard once: decoder noise and corrupted copies, not stations. Counted
// one an address, they pulled the median 170 km west of the receiver, onto the
// register's own middle. So each address counts for the separate hours it was
// heard in: a station's checks land on its address every few hours, all week,
// and a stray lands once or twice. And a candidate further than FAR_KM from
// where the receiver hears is never the owner, however many of its other
// addresses were "heard" too: that is the noise again. Saddle Mtn AL, 1,350 km
// from a Brisbane Pi, won address 5199 from Crafers West, further still, on
// strays like that, and showed in Station Health as heard.
//
// What this does not do is force a winner. Two stations 6 km apart sharing
// addresses stay ambiguous, and an address whose only owner on file is a
// thousand kilometres from everything else this receiver hears is reported as
// far — the strongest hint there is that an unregistered station nearby is
// using it, which is a register problem, not a reading problem.

const SensorValues = (() => {

  const GAP_KM = 100;       // how much closer the winner must be to be called resolved (alert2.js agrees)
  const FAR_KM = 400;       // further than this from where the receiver hears is not "heard here"
  const MIN_ANCHORS = 3;    // fewer uniquely-owned addresses than this do not fix a receiver's area

  // A battery outside this band is not a 12 V station battery reading. The
  // floor is a flat lead-acid well past where the radio stops; the ceiling is
  // above any charger's equalising voltage.
  const BATT_MIN_V = 9.0;
  const BATT_MAX_V = 16.5;

  // ── the kind of an address ──────────────────────────────────────────────────

  // The register's sensor types, as one word the rest of the app can switch
  // on. "Rainfall" and "Rainfall Increment" are the same address in ARRO's
  // export — the accumulator and the increments derived from it — so both are
  // rain. Order matters: "Repeater" is checked before anything that might
  // match its free text.
  function kindOf(types) {
    const t = (Array.isArray(types) ? types : [types]).join(' ').toLowerCase();
    if (!t.trim()) return null;
    if (/batt/.test(t)) return 'battery';
    if (/repeater/.test(t)) return 'repeater';
    if (/rain|precip/.test(t)) return 'rain';
    if (/level|stage|ahd|height|lgh/.test(t)) return 'level';
    return 'other';
  }

  const KIND_LABEL = {
    battery: 'Battery', rain: 'Rainfall', level: 'Water level', repeater: 'Repeater', other: 'Other sensor',
  };
  function kindLabel(kind) { return KIND_LABEL[kind] || ''; }

  // ── the register, indexed ────────────────────────────────────────────────────

  let _idx = null, _idxFor = null;

  // alert id -> [{ station, types, kind }], one entry per station carrying it.
  // Rebuilt when the station file changes, never per row.
  function index() {
    const data = typeof state !== 'undefined' ? state.data : null;
    if (_idx && _idxFor === data) return _idx;
    const byId = new Map();
    for (const s of (data && data.stations) || []) {
      const types = new Map();
      for (const se of stationSensors(s)) {
        if (!se || se.alert_id == null) continue;
        if (!types.has(se.alert_id)) types.set(se.alert_id, new Set());
        if (se.type) types.get(se.alert_id).add(se.type);
      }
      types.forEach((set, aid) => {
        if (!byId.has(aid)) byId.set(aid, []);
        const list = [...set];
        byId.get(aid).push({ station: s, types: list, kind: kindOf(list) });
      });
    }
    _idx = byId; _idxFor = data;
    return byId;
  }

  // A station's sensors were edited in place (the Message Log's claim puts
  // the claimed address on the station it names): the index is stale even
  // though the station file is the same object.
  function invalidate() { _idx = null; _idxFor = null; }

  function stationsById() {
    const m = new Map();
    for (const s of (typeof state !== 'undefined' && state.data && state.data.stations) || []) m.set(s.id, s);
    return m;
  }

  // ── geometry ──────────────────────────────────────────────────────────────

  function km(aLat, aLon, bLat, bLon) {
    const dLat = (aLat - bLat) * 111.32;
    const dLon = (aLon - bLon) * 111.32 * Math.cos((aLat + bLat) / 2 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }
  function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    const n = s.length;
    return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
  }
  // The UTC hour a timestamp falls in, as "2026-11-04T23". The datastore writes
  // UTC, so that is the string's own start; anything else is parsed.
  function hourKey(ts) {
    const s = String(ts || '');
    if (s.length >= 13 && s[10] === 'T' && (s.endsWith('Z') || s.endsWith('+00:00'))) return s.slice(0, 13);
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 13) : '';
  }
  // The median of [value, weight] pairs: the value half the weight lies either
  // side of. With every weight 1 it is median() exactly.
  function wmedian(xs) {
    const s = xs.filter(x => x[1] > 0).sort((a, b) => a[0] - b[0]);
    const half = s.reduce((n, x) => n + x[1], 0) / 2;
    let acc = 0;
    for (let i = 0; i < s.length; i++) {
      acc += s[i][1];
      if (acc > half) return s[i][0];
      if (acc === half) return i + 1 < s.length ? (s[i][0] + s[i + 1][0]) / 2 : s[i][0];
    }
    return null;
  }
  const placed = s => s && s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon);

  // The ingress point a reading came in through, as the host it names.
  // "serial-monitor/rpi-6dfef7f4-sdr1-152.400" is the Pi rpi-6dfef7f4's first
  // stick on 152.400 MHz; the host is the thing that is in one place, and so
  // the thing whose hearing has an area.
  function hostOf(path) {
    const p = String(path || '');
    if (!p) return '';
    const m = p.match(/^(.*?)-sdr\d+(?:-[\d.]+)?$/);
    return m ? m[1] : p;
  }

  // ── base stations by name ───────────────────────────────────────────────────
  // A host is a code — "serial-monitor/rpi-83071968" — which nobody says
  // aloud. Each receiver says whose it is, and the base station's name is
  // public (meganet.base_station_name, 0115): "18 Bateson". Wherever the app
  // shows or asks for a receiver it says the name, and keeps the code for the
  // hover. One base station can have several hosts: a Pi that was replaced
  // keeps the readings it took in. Until 0115 is applied the editors' own
  // list (ingest_point_latest, 0045) stands in, and anybody else gets none —
  // the codes are simply shown as they are kept.
  let baseRows = [];          // { name, host, stationId }
  let baseAsk = null;
  const baseByHost = new Map();
  async function loadBases() {
    if (baseAsk) return baseAsk;
    baseAsk = (async () => {
      let rows = [];
      try {
        const got = await dbSelect('base_station_name?select=name,receiver,station_id&order=name.asc,receiver.asc&limit=1000');
        rows = (got || []).map(r => ({ name: String(r.name || '').trim(), host: String(r.receiver || ''), stationId: r.station_id || null }));
      } catch (_) { rows = []; }
      if (!rows.length) {
        try {
          const got = await dbSelect('ingest_point_latest?select=token_label,point_id,host_station_id&order=point_id.asc&limit=1000');
          const seen = new Set();
          for (const p of got || []) {
            const host = 'serial-monitor/' + hostOf(p.point_id);
            if (!p.point_id || seen.has(host)) continue;
            seen.add(host);
            rows.push({ name: String(p.token_label || '').trim(), host, stationId: p.host_station_id || null });
          }
        } catch (_) { /* not an editor: no names */ }
      }
      baseRows = rows.filter(r => r.name && r.host);
      baseByHost.clear();
      for (const r of baseRows) baseByHost.set(r.host, r);
      if (!baseRows.length) baseAsk = null;      // nothing yet: ask again next time
      return baseRows;
    })();
    return baseAsk;
  }
  // Each base station once: its name, its hosts, the station it stands at.
  function bases() {
    const by = new Map();
    for (const r of baseRows) {
      if (!by.has(r.name)) by.set(r.name, { name: r.name, hosts: [], stationId: null });
      const b = by.get(r.name);
      b.hosts.push(r.host);
      if (r.stationId && !b.stationId) b.stationId = r.stationId;
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  // The base station a path came in at — its name, and what is left of the
  // path (the stick and frequency) — or null when nobody has named its host.
  function baseOf(path) {
    const p = String(path || '');
    const host = hostOf(p);
    const hit = host && baseByHost.get(host);
    return hit ? { name: hit.name, host, rest: p.slice(host.length).replace(/^-/, ''), stationId: hit.stationId } : null;
  }
  // A path as a person reads it: "18 Bateson sdr1-151.550", or the path as kept.
  function pathLabel(path) {
    const at = baseOf(path);
    return at ? at.name + (at.rest ? ' ' + at.rest : '') : String(path || '');
  }
  // The base station of that name, whatever the capitals; or null.
  function baseNamed(name) {
    const want = String(name || '').trim().toLowerCase();
    return (want && bases().find(b => b.name.toLowerCase() === want)) || null;
  }

  // ── resolving rows ──────────────────────────────────────────────────────────

  // A resolver over a set of rows in meganet.reading's shape. The rows are the
  // evidence: which addresses each ingress path heard, and so where each one
  // listens. Returns resolve(row) -> {
  //   st      the station, or null
  //   kind    battery | rain | level | repeater | other | null
  //   types   the register's sensor types for this address at that station
  //   conf    datastore | a2 | sole | resolved | likely | ambiguous | far | number | unknown
  //   how     a sentence for a title or a drawer
  //   others  how many more stations carry the address
  //   distKm  from where this path hears, when that is known
  // }
  function resolver(rows) {
    const idx = index();
    const byId = stationsById();
    const list = Array.isArray(rows) ? rows : [];

    // Which addresses each path heard, and in which hours.
    const heardOn = new Map();         // host -> Set(alert ids)
    const hoursOn = new Map();         // host -> Map(alert id -> Set(hour))
    const hoursAll = new Map();        // alert id -> Set(hour), every path's
    const addHour = (m, aid, hr) => { let s = m.get(aid); if (!s) m.set(aid, s = new Set()); s.add(hr); };
    for (const r of list) {
      if (r.alert_id == null) continue;
      // Every receiver that heard it: the kept copy's, and the ones whose
      // copies were counted on it (dup_paths) — since 0096 all of one ALERT
      // burst's copies within 8 s, so a receiver whose copies land second
      // still says where it listens (#232).
      const hostsHeard = new Set([hostOf(r.path), ...(Array.isArray(r.dup_paths) ? r.dup_paths.map(hostOf) : [])]);
      const hr = hourKey(r.reading_ts || r.received_at);
      addHour(hoursAll, r.alert_id, hr);
      for (const h of hostsHeard) {
        if (!heardOn.has(h)) { heardOn.set(h, new Set()); hoursOn.set(h, new Map()); }
        heardOn.get(h).add(r.alert_id);
        addHour(hoursOn.get(h), r.alert_id, hr);
      }
    }
    // The anchors: the uniquely-owned addresses heard, each with its station
    // and the separate hours it was heard in — the weight it pulls with.
    const anchorsOf = hm => {
      const out = [];
      hm.forEach((hrs, aid) => {
        const c = idx.get(aid);
        if (c && c.length === 1 && placed(c[0].station)) out.push({ st: c[0].station, w: hrs.size });
      });
      return out;
    };
    const centreOf = as => as.length >= MIN_ANCHORS
      ? { lat: wmedian(as.map(a => [a.st.lat, a.w])), lon: wmedian(as.map(a => [a.st.lon, a.w])), n: as.length } : null;
    const centres = new Map();
    hoursOn.forEach((hm, h) => centres.set(h, centreOf(anchorsOf(hm))));
    const centreAll = centreOf(anchorsOf(hoursAll));
    // A path with too few anchors of its own borrows everybody's: one network,
    // one corner of the country, is the usual case.
    const centreFor = h => centres.get(h) || centreAll;

    const memo = new Map();

    function fromCandidates(r) {
      const cands0 = idx.get(r.alert_id) || [];
      if (!cands0.length) return null;
      const h = hostOf(r.path);
      const key = r.alert_id + '|' + h;
      if (memo.has(key)) return memo.get(key);
      const centre = centreFor(h);
      const heard = heardOn.get(h) || new Set();
      const cands = cands0.map(c => {
        const others = stationAlertIds(c.station).filter(x => x !== r.alert_id);
        return Object.assign({}, c, {
          distKm: centre && placed(c.station) ? km(centre.lat, centre.lon, c.station.lat, c.station.lon) : null,
          siblings: others.filter(x => heard.has(x)).length,
        });
      });
      cands.sort((a, b) => ((a.distKm == null ? Infinity : a.distKm) - (b.distKm == null ? Infinity : b.distKm))
                        || (b.siblings - a.siblings));
      // Only a station within FAR_KM of where this receiver hears can be what
      // it heard; the rest are out of the running, siblings or not.
      const near = cands.filter(c => c.distKm == null || c.distKm <= FAR_KM);
      const a = near[0] || cands[0], b = near[1];
      let conf, how;
      if (!near.length) {
        conf = 'far';
        how = cands.length === 1
          ? `the only station on file with this address, but ${Math.round(a.distKm).toLocaleString()} km from where this receiver hears — an unregistered station nearby is probably using it`
          : `the nearest of ${cands.length} stations sharing this address, and still ${Math.round(a.distKm).toLocaleString()} km from where this receiver hears`;
      } else if (cands.length === 1) {
        conf = 'sole';
        how = 'the only station on file with this address';
      } else if (near.length === 1) {
        conf = 'resolved';
        how = `the only one of ${cands.length} stations sharing this address within ${FAR_KM} km of where this receiver hears`;
      } else if (a.distKm != null && b.distKm != null && b.distKm - a.distKm >= GAP_KM) {
        conf = 'resolved';
        how = `the nearest of ${cands.length} stations sharing this address to where this receiver hears — the next is ${Math.round(b.distKm - a.distKm).toLocaleString()} km further`;
      } else if (a.siblings > b.siblings) {
        conf = 'likely';
        how = `${cands.length} stations share this address; this one's other addresses were heard on the same path`;
      } else {
        conf = 'ambiguous';
        how = `${cands.length} stations share this address and nothing heard here tells them apart`;
      }
      // When every candidate agrees on what the address measures, the kind is
      // known even when the station is not.
      const kinds = new Set(near.map(c => c.kind));
      const kind = conf === 'ambiguous' ? (kinds.size === 1 ? a.kind : null) : a.kind;
      const out = { st: a.station, types: a.types, kind, conf, how, others: cands.length - 1, distKm: a.distKm };
      memo.set(key, out);
      return out;
    }

    function resolve(r) {
      if (!r) return { st: null, kind: null, types: [], conf: 'unknown', how: '', others: 0, distKm: null };
      // The datastore's own resolution first: it only ever writes a unique one.
      if (r.station_id && byId.has(r.station_id)) {
        const st = byId.get(r.station_id);
        const c = r.alert_id != null ? (idx.get(r.alert_id) || []) : [];
        const mine = c.find(x => x.station === st);
        const centre = centreFor(hostOf(r.path));
        const distKm = centre && placed(st) ? km(centre.lat, centre.lon, st.lat, st.lon) : null;
        const far = distKm != null && distKm > FAR_KM;
        return {
          st, types: mine ? mine.types : [], kind: mine ? mine.kind : null,
          conf: far ? 'far' : 'datastore',
          how: far ? `resolved by the datastore, but ${Math.round(distKm).toLocaleString()} km from where this receiver hears — an unregistered station nearby is probably using the address`
                   : 'resolved by the datastore',
          others: Math.max(0, c.length - 1), distKm,
        };
      }
      // A relayed ALERT2 pair: its identity is the station address and the slot.
      // The slot's type is the register's, when a sensor row carries the slot
      // number (0024's alert2_sensor_id).
      if (r.a2_station != null) {
        const st = ((state.data && state.data.stations) || []).find(x => x.alert2_station_id === r.a2_station);
        if (st) {
          const se = stationSensors(st).find(x => x && x.alert2_sensor_id === r.a2_sensor);
          const types = se && se.type ? [se.type] : [];
          return { st, types, kind: kindOf(types), conf: 'a2', how: 'matched on the relayed ALERT2 station address', others: 0, distKm: null };
        }
      }
      if (r.alert_id != null) {
        const got = fromCandidates(r);
        if (got) return got;
      }
      if (r.station_number) {
        const sts = ((state.data && state.data.stations) || [])
          .filter(s => String(s.station_number) === String(r.station_number) || String(s.site && s.site.number) === String(r.station_number));
        if (sts.length) {
          const kind = kindOf(r.channel || '');
          return { st: sts[0], types: [], kind: kind === 'other' ? null : kind, conf: 'number',
                   how: 'matched on the station number', others: sts.length - 1, distKm: null };
        }
      }
      return { st: null, kind: null, types: [], conf: 'unknown', how: 'no station on file carries this address', others: 0, distKm: null };
    }

    resolve.centres = centres;
    resolve.centreAll = centreAll;
    resolve.centreFor = centreFor;
    return resolve;
  }

  // ── what a count is worth ────────────────────────────────────────────────────

  function round(v, dp) { const k = Math.pow(10, dp); return Math.round(v * k) / k; }

  // A raw count in engineering units, or why not. Never null for a known kind:
  // a level gets { value: null, rule } so the cell can say "raw count" and the
  // drawer can say why, rather than both saying nothing.
  //
  //   value      the number, or null
  //   unit       'V', 'mm', or null
  //   text       what a cell shows
  //   rule       the sentence for a title or a drawer
  //   plausible  false when the number cannot be what the kind says it is
  //   note       why not, when it is not
  //   cumulative a rain gauge's count is a running total, not a fall
  function convert(kind, raw, st) {
    const n = Number(raw);
    if (!isFinite(n) || !kind) return null;
    if (kind === 'battery') {
      const v = round(n / 10, 1);
      const ok = v >= BATT_MIN_V && v <= BATT_MAX_V;
      return {
        value: v, unit: 'V', text: v.toFixed(1) + ' V', plausible: ok,
        rule: 'raw ÷ 10 — the ALERT battery convention; inferred here, not recorded by the datastore',
        note: ok ? '' : `${v.toFixed(1)} V is not a 12 V station battery — this address is probably another kind of sensor at another site`,
      };
    }
    if (kind === 'rain') {
      const b = typeof bucketSizeMm === 'function' ? bucketSizeMm(st) : { mm: 0.2, recorded: false };
      const v = round(n * b.mm, 2);
      const src = b.recorded ? `recorded for ${st.name}` : st ? `assumed — no bucket size is recorded for ${st.name}` : 'assumed — no station resolved';
      return {
        value: v, unit: 'mm', text: v + ' mm', plausible: n >= 0, cumulative: true,
        rule: `raw × ${b.mm} mm per tip (${src}); the gauge's running total, not a fall — the difference between two readings is the rain`,
        note: '',
      };
    }
    if (kind === 'level') {
      return {
        value: null, unit: null, text: 'raw count', plausible: true,
        rule: 'water level — its scale is set per site and Flood-Net records none, so the raw count is the reading',
        note: '',
      };
    }
    if (kind === 'repeater') {
      return {
        value: null, unit: null, text: 'raw count', plausible: true,
        rule: 'a repeater\'s own report — what its count means depends on the repeater',
        note: '',
      };
    }
    return {
      value: null, unit: null, text: 'raw count', plausible: true,
      rule: 'no conversion is known for this sensor type', note: '',
    };
  }

  // What a row is worth: the datastore's own conversion when it recorded one,
  // otherwise the inferred one. `inferred` says which, because a value nobody
  // recorded must never be mistaken for one somebody did.
  function rowValue(r, res) {
    if (r && r.value != null && isFinite(Number(r.value))) {
      return {
        value: Number(r.value), unit: r.unit || '', text: `${r.value}${r.unit ? ' ' + r.unit : ''}`,
        rule: r.conversion || 'converted at ingest; rule not recorded', plausible: true, note: '', inferred: false,
      };
    }
    if (r && r.unit && r.unit !== 'count' && r.alert_id == null) {
      // A station-number reading that arrived as an engineering value: value_raw
      // *is* the value (0006 — a source with no counts sends the value itself).
      return {
        value: Number(r.value_raw), unit: r.unit, text: `${r.value_raw} ${r.unit}`,
        rule: 'sent as an engineering value — the raw column is the value', plausible: true, note: '', inferred: false,
      };
    }
    const got = convert(res && res.kind, r && r.value_raw, res && res.st);
    return got ? Object.assign({ inferred: true }, got) : null;
  }

  return {
    GAP_KM, FAR_KM, BATT_MIN_V, BATT_MAX_V,
    kindOf, kindLabel, index, invalidate, resolver, convert, rowValue, hostOf, km, median,
    loadBases, bases, baseOf, baseNamed, pathLabel,
  };
})();

if (typeof window !== 'undefined') window.SensorValues = SensorValues;
