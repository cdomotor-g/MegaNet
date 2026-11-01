// worker/radio-path.js — a station's radio path to the base stations, for the
// agent API (worker/api.js): the repeaters that pass its ALERT addresses, the
// ways on from each along the backbone to a base station, and for every hop
// the fade margin Flood-Net saved — with whether that figure still describes
// the network as it is.
//
// Asked for by the owner's SoRT scope builder, whose "Fade Margin >20 dB" row
// wants Flood-Net's own figures from a station to its repeaters and on to the
// base stations. The dossier's networks_and_radio.link_margins gives only a
// station's own saved links, and repeaters_listening the repeaters whose pass
// ranges cover its addresses; nothing walked the path on to a base.
//
// ── The routes: the Stations map's own rules, walked ─────────────────────────
// Nothing new is decided here about who hears whom:
//
//   first hop   a repeater whose pass ranges carry one of the station's ALERT
//               addresses, exclusions honoured (passRelationIndex, app.js) —
//               the nearest few within 150 km, as relayed_by lists them.
//   on          a repeater within the Stations map's Max TX distance (100 km,
//               core.js mapMaxLinkKm) whose open windows take one of the same
//               addresses — the map's backbone path (map-backbone.js
//               backboneIndex), narrowed to the addresses this station's
//               readings use — or any base station within that distance,
//               which opens no window of its own (the map's repeater–base
//               path). A base ends a route: what reaches it has arrived.
//   a repeater  starts from itself, and goes on to repeaters whose open
//               windows take some of what it relays: the backbone rule as the
//               map draws it, carried along — each repeater after it must
//               take some of what the one before passed on, as a field
//               station's addresses must be taken at every hop.
//
// A route never visits a station twice and carries at most four repeaters,
// the first included — delay-plan.js's maxHops, the delay plan's own idea of
// how far a reading is passed on — and from each first repeater the walk goes
// one repeater past the fewest that reach a base (walkRoutes says why).
// Frequencies are not matched, because the map does not match them; each hop
// says the one its figure was worked out at.
//
// ── The figures: what map-fade.js saved, and whether it still holds ─────────
// meganet.link_fade_margin (0025) keeps one row per pair of stations, worked
// out in the browser and saved by an editor: margin_ab_db and margin_ba_db each
// way in pair order, margin_db the way the line was drawn, the thresholds it was
// banded against, and a signature of every input. The map paints a row only
// while that signature is the one it would build today (map-fade.js sigFor),
// so a moved pin, a new ground height, a retuned repeater or a new model each
// stop a figure being shown. This builds the same signature, at the app's
// default settings, and says in words which part no longer matches: the model,
// its settings, either end (position, ground height, antenna height, radio) or
// the frequency. test/agent-api.mjs runs the app's own sigFor against this one,
// so the two cannot drift apart unnoticed. A stale figure is still given — it
// is evidence, and it says why it is stale — where the map shows none.
//
// Pure: the reads are worker/api.js's, so the tests can drive this directly.

// ── What the app models with — mirrored, and held to the app by the tests ────

export const FADE_MODEL = 'itm-p2p/3';                 // map-fade.js MODEL
export const FADE_SAMPLES = 256;                       // map-fade.js SAMPLES
export const FADE_DEFAULT_MHZ = 151.5;                 // path-profile.js PATH_DEFAULT_MHZ
export const FADE_DEFAULT_AGL_M = 4;                   // path-profile.js PATH_DEFAULT_AGL
// core.js FN_MODEL_DEFAULTS: the model, its ground, the field allowance (dB)
// and the least height a repeater or base antenna is modelled at (m).
export const FADE_SETTINGS = Object.freeze({ model: 'field', ground: '30m', allowance: 12, mastAgl: 10 });
// core.js RM_NET_DEFAULTS, as pathPropOf (path-profile.js) reads them.
export const FADE_PROPAGATION = Object.freeze({
  climate: 2, N0: 301, epsilon: 15, sigma: 0.005, pol: 1, mdvar: 0, time: 50, location: 50, situation: 70,
});
export const BACKBONE_KM = 100;                        // core.js mapMaxLinkKm, the map's Max TX distance
export const MAX_REPEATERS = 4;                        // delay-plan.js DEFAULTS.maxHops

// The models a saved row may name, in words. Only the antenna rule matters to
// a figure's freshness: before the field calibration (itm-p2p/3) every antenna
// was modelled at its radio system's height; since, a repeater or base stands
// on at least FADE_SETTINGS.mastAgl.
const MODELS = {
  'itm-p2p/1': { words: 'the first fade-margin model (64 points over bare ground)', mast: false },
  'itm-p2p/2': { words: 'the land-cover model', mast: false },
  'itm-p2p/3': { words: 'the field model', mast: true },
};
export const modelWords = m => (MODELS[m] ? MODELS[m].words : 'a model Flood-Net no longer names');

// ── Small helpers ────────────────────────────────────────────────────────────

const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const located = n => n && n.lat != null && n.lon != null;
const kmBetween = (a, b) => (located(a) && located(b) ? haversineKm(a.lat, a.lon, b.lat, b.lon) : null);

// ── Stations, as the walk needs them ─────────────────────────────────────────

// A repeater's open windows as [lo, hi] spans: its pass ranges less its
// exclusions. An inverted range matches no address in the app's test
// (passRangeCoversId), so it is dropped as the empty span it is, never swapped
// — map-backbone.js repeaterOpenWindows, whose rule this is.
export function openWindows(ranges) {
  let spans = (ranges || []).filter(r => r.kind === 'pass' && r.lo != null && r.hi != null && r.hi >= r.lo).map(r => [r.lo, r.hi]);
  for (const e of (ranges || []).filter(r => r.kind === 'exclusion' && r.lo != null && r.hi != null && r.hi >= r.lo)) {
    const next = [];
    for (const [lo, hi] of spans) {
      if (e.hi < lo || e.lo > hi) { next.push([lo, hi]); continue; }
      if (lo < e.lo) next.push([lo, e.lo - 1]);
      if (hi > e.hi) next.push([e.hi + 1, hi]);
    }
    spans = next;
  }
  return spans;
}

export const covers = (node, a) => !!node && node.windows.some(([lo, hi]) => lo <= a && a <= hi);
export const windowsOverlap = (a, b) => a.windows.some(([alo, ahi]) => b.windows.some(([blo, bhi]) => Math.max(alo, blo) <= Math.min(ahi, bhi)));

// What of `spans` a repeater's windows take: the spans both hold.
export function takenBy(spans, node) {
  const out = [];
  for (const [alo, ahi] of spans) {
    for (const [blo, bhi] of node.windows) {
      const lo = Math.max(alo, blo), hi = Math.min(ahi, bhi);
      if (lo <= hi) out.push([lo, hi]);
    }
  }
  return out;
}

// One station as the walk and the freshness check need it, from a row of the
// topology read (repeater embedded, pass_range inside it — an object, or an
// array from a PostgREST that does not know the two are one-to-one) or from a
// station document (repeater.pass_ranges / exclusions with low and high).
export function stationNode(r, repeaterRec) {
  if (!r || !r.id) return null;
  const rep = Array.isArray(repeaterRec) ? (repeaterRec[0] || null) : (repeaterRec || null);
  const roles = Array.isArray(r.roles) ? r.roles : [];
  let ranges = [];
  if (rep && Array.isArray(rep.pass_range)) {
    ranges = rep.pass_range.map(p => ({ kind: p.kind, lo: num(p.lo), hi: num(p.hi) }));
  } else if (rep) {
    ranges = [
      ...(Array.isArray(rep.pass_ranges) ? rep.pass_ranges : []).map(p => ({ kind: 'pass', lo: num(p.low), hi: num(p.high) })),
      ...(Array.isArray(rep.exclusions) ? rep.exclusions : []).map(p => ({ kind: 'exclusion', lo: num(p.low), hi: num(p.high) })),
    ];
  }
  return {
    id: r.id,
    name: r.name || r.id,
    station_number: r.station_number || null,
    lat: num(r.lat),
    lon: num(r.lon),
    elevation_ahd: num(r.elevation_ahd),
    roles,
    rm_system_id: r.rm_system_id ?? null,
    rx_mhz: rep ? num(rep.rx_mhz) : null,
    tx_mhz: rep ? num(rep.tx_mhz) : null,
    // The app's repeaterList: the role and a repeater record both.
    isRepeater: roles.includes('repeater') && !!rep,
    isBase: roles.includes('base'),
    windows: openWindows(ranges),
  };
}

// Every repeater and base station, indexed. `near` is filled as the walk asks
// for it and lives as long as the topology does (a few minutes, in api.js's
// memo), so the distances are worked out once per isolate, not per request.
export function buildTopology(rows) {
  const nodes = new Map();
  for (const r of rows || []) {
    const n = stationNode(r, r.repeater);
    if (n) nodes.set(n.id, n);
  }
  const placed = [...nodes.values()].filter(located);
  return {
    nodes,
    repeaters: placed.filter(n => n.isRepeater && !n.isBase),
    bases: placed.filter(n => n.isBase),
    near: new Map(),
  };
}

// The bases and the repeaters within linkKm of a station, nearest first.
function nearOf(topo, node, linkKm) {
  const key = `${node.id}@${linkKm}`;
  if (topo.near.has(key)) return topo.near.get(key);
  const within = list => list.filter(n => n.id !== node.id)
    .map(n => ({ node: n, km: kmBetween(node, n) }))
    .filter(x => x.km != null && x.km <= linkKm)
    .sort((a, b) => a.km - b.km || (a.node.id < b.node.id ? -1 : 1));
  const out = { bases: within(topo.bases), repeaters: within(topo.repeaters) };
  topo.near.set(key, out);
  return out;
}

// The repeaters whose open windows carry one of `addrs`, nearest first: the
// first hops a field station's readings can take.
export function carriersOf(topo, station, addrs) {
  const out = [];
  for (const r of topo.repeaters.concat(topo.bases.filter(b => b.isRepeater))) {
    if (r.id === station.id) continue;
    const passes = addrs.filter(a => covers(r, a));
    if (passes.length) out.push({ node: r, passes, km: kmBetween(station, r) });
  }
  return out.sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9) || (a.node.id < b.node.id ? -1 : 1));
}

// ── The walk ─────────────────────────────────────────────────────────────────

// Every route from each start to a base station, shortest first, up to `cap`
// routes and `nodeCap` stations in all — the stations are what the margins
// are read for, in one in.(…) list.
//
//   starts   [{ node, carried }] — carried: what the start relays, as [lo, hi]
//            spans of ALERT addresses: the station's addresses this repeater
//            passes (a field station's walk; [a, a] each), or null for the
//            repeater's own windows (a repeater's). A repeater after it must
//            take some of what the one before passed on, and passes on only that.
//   → { routes: [{ start, path: [ids, start first] }], nodes: Set of ids,
//       truncated }
//
// A level at a time — every route through k repeaters before any through
// k + 1 — and each partial route's ways to a base taken as soon as it is
// made, so a walk that reaches `cap` stops there rather than after building a
// level it would never finish: a Worker's CPU is counted in milliseconds.
//
// And from each start, only `beyond` repeaters further than the fewest that
// reach a base from it. Where repeaters stand thick, as round the Tweed, a
// dozen stations make two thousand routes within four repeaters — the same
// few in every order — and none of the longer orders is the way a reading
// would be expected home; where they stand thin, the fewest is three or four,
// and those are still walked.
export function walkRoutes(topo, starts, { linkKm = BACKBONE_KM, maxRepeaters = MAX_REPEATERS, cap = 1000,
  nodeCap = 100, levelCap = 20000, beyond = 1 } = {}) {
  const routes = [];
  const nodes = new Set();
  const fewest = new Map();        // start → repeaters on its shortest route
  let truncated = false;
  const take = ids => {
    let fresh = 0;
    for (const i of ids) if (!nodes.has(i)) fresh++;
    if (nodes.size + fresh > nodeCap) return false;
    for (const i of ids) nodes.add(i);
    return true;
  };
  // The routes on from a partial route to every base in reach. A base is
  // never on a partial route (it ends one), so cannot be on this one already.
  // false once the cap is reached.
  const toBases = (q, nb) => {
    for (const { node: b } of nb.bases) {
      if (routes.length >= cap) return false;
      const path = q.path.concat(b.id);
      if (!take(path)) { truncated = true; continue; }
      routes.push({ start: q.start, path });
      if (!fewest.has(q.start)) fewest.set(q.start, q.path.length);
    }
    return true;
  };
  const deeper = q => q.path.length < maxRepeaters
    && (!fewest.has(q.start) || q.path.length < fewest.get(q.start) + beyond);
  let level = [];
  for (const s of starts) {
    if (!take([s.node.id])) { truncated = true; continue; }
    // A first repeater that is a base station too is where the route ends.
    if (s.node.isBase) { routes.push({ start: s.node.id, path: [s.node.id] }); continue; }
    const q = { start: s.node.id, path: [s.node.id], carried: s.carried || s.node.windows };
    if (!toBases(q, nearOf(topo, s.node, linkKm))) return { routes, nodes, truncated: true };
    level.push(q);
  }
  while (level.length) {
    const next = [];
    for (const q of level) {
      if (!deeper(q)) continue;
      for (const { node: r } of nearOf(topo, topo.nodes.get(q.path[q.path.length - 1]), linkKm).repeaters) {
        if (q.path.includes(r.id)) continue;
        const carried = takenBy(q.carried, r);
        if (!carried.length) continue;
        const c = { start: q.start, path: q.path.concat(r.id), carried };
        if (!toBases(c, nearOf(topo, r, linkKm))) return { routes, nodes, truncated: true };
        if (deeper(c)) {
          if (next.length >= levelCap) { truncated = true; continue; }
          next.push(c);
        }
      }
    }
    level = next;
  }
  return { routes, nodes, truncated };
}

// ── A saved figure, and whether it still holds ───────────────────────────────

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export { pairKey };

// The antenna height a station is modelled at under `model` — path-profile.js
// stationAntenna at the default mast height for the field model, the radio
// system's own height before it. null for a model whose rule is not known.
export function antennaAgl(node, sys, model = FADE_MODEL) {
  const own = sys && sys.antenna_height_m != null ? Number(sys.antenna_height_m) : FADE_DEFAULT_AGL_M;
  const m = MODELS[model];
  if (!m) return null;
  if (!m.mast) return own;
  const mast = node.roles.includes('repeater') || node.roles.includes('base') ? FADE_SETTINGS.mastAgl : 0;
  return mast > own ? mast : own;
}

// One end of the signature: map-fade.js sigFor's `end`, at the app's defaults.
function endParts(node, sys, model = FADE_MODEL) {
  return [
    node.lat.toFixed(5), node.lon.toFixed(5), node.elevation_ahd == null ? '' : node.elevation_ahd,
    antennaAgl(node, sys, model),
    sys && sys.tx_power_w != null ? sys.tx_power_w : '',
    sys && sys.antenna_gain_dbi != null ? sys.antenna_gain_dbi : '',
    sys && sys.line_loss_db != null ? sys.line_loss_db : '',
    sys && sys.rx_threshold_dbm != null ? sys.rx_threshold_dbm : '',
  ];
}

// The frequency a line is priced at: the first end, in the order the line is
// handed over, whose repeater receives on one — map-fade.js freqFor.
export function freqFor(a, b) {
  for (const s of [a, b]) if (s && s.rx_mhz > 0) return s.rx_mhz;
  return FADE_DEFAULT_MHZ;
}

// What follows the frequency in a signature: the sample count, the model and
// its allowance, the ground when it is LiDAR, and the propagation settings.
export function settingsParts() {
  const s = FADE_SETTINGS, p = FADE_PROPAGATION;
  return [FADE_SAMPLES, s.model === 'cover' ? 'cover' : `field-${s.allowance}`, ...(s.ground === 'lidar' ? ['lidar'] : []),
    p.climate, p.N0, p.epsilon, p.sigma, p.pol, p.mdvar, p.time, p.location, p.situation];
}

// The signature the app would save for the line `a` → `b` today, at its
// default settings: map-fade.js sigFor. sysById: rm_system id → row.
export function fadeSignature(a, b, sysById) {
  const sysOf = n => (sysById && n.rm_system_id != null ? sysById.get(n.rm_system_id) || null : null);
  const [x, y] = a.id < b.id ? [a, b] : [b, a];
  return [FADE_MODEL, endParts(x, sysOf(x)).join(','), endParts(y, sysOf(y)).join(','), freqFor(a, b), ...settingsParts()].join('|');
}

export function parseSignature(sig) {
  const parts = String(sig || '').split('|');
  if (parts.length < 6) return null;
  const ends = [parts[1].split(','), parts[2].split(',')];
  if (ends.some(e => e.length !== 8)) return null;
  return { model: parts[0], ends, freq: parts[3], settings: parts.slice(4).join('|') };
}

const sameNum = (saved, now) => (saved === '' ? now == null : now != null && Math.abs(Number(saved) - Number(now)) < 1e-9);
const metresWords = m => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.max(1, Math.round(m))} m`);
const mhzWords = f => `${Number(f)} MHz`;

function settingsWords(settings) {
  const p = String(settings).split('|');
  const model = p[1] || '';
  const bits = [model === 'cover' ? 'the land-cover model' : /^field-/.test(model) ? `a ${model.slice(6)} dB field allowance` : 'other model settings'];
  if (p.includes('lidar')) bits.push('LiDAR ground');
  return bits.join(' and ');
}

// Why a saved figure is not the one the map would show today, in words:
// [{ reason, detail }], empty when it still holds. nodeA and nodeB are the
// row's station_a and station_b as the register has them now (null when one is
// gone); sysById the radio systems.
//
//   model      worked out with another version of the model
//   settings   the same model, other settings (the field allowance, LiDAR…)
//   moved      an end's recorded position is not the one it was worked out at
//   height     an end's ground height (m AHD) has changed
//   antenna    an end's antenna height has changed (its radio system's)
//   radio      an end's transmit power, antenna gain, line loss or receive
//              threshold has changed
//   frequency  the line's frequency (its repeater's receive frequency) has changed
//   unreadable the saved signature is not one this can read
export function staleReasons(row, nodeA, nodeB, sysById) {
  const out = [];
  const sig = parseSignature(row && row.signature);
  if (!sig) return [{ reason: 'unreadable', detail: 'The inputs it was worked out from were not saved in a form this can read, so it cannot be checked against the register.' }];
  if (sig.model !== FADE_MODEL) {
    out.push({ reason: 'model', detail: `Worked out with ${modelWords(sig.model)} (${sig.model}); Flood-Net now works margins out with ${modelWords(FADE_MODEL)} (${FADE_MODEL}).` });
  } else {
    const want = settingsParts().join('|');
    if (sig.settings !== want) {
      out.push({ reason: 'settings', detail: `Worked out with ${settingsWords(sig.settings)}; Flood-Net's defaults are now ${settingsWords(want)}.` });
    }
  }
  const sysOf = n => (sysById && n && n.rm_system_id != null ? sysById.get(n.rm_system_id) || null : null);
  [nodeA, nodeB].forEach((node, i) => {
    const e = sig.ends[i];
    const who = node ? node.name : (i === 0 ? row.station_a_id : row.station_b_id);
    if (!node || !located(node)) {
      out.push({ reason: 'moved', detail: `${who} has no recorded position now.` });
      return;
    }
    if (node.lat.toFixed(5) !== e[0] || node.lon.toFixed(5) !== e[1]) {
      const was = [Number(e[0]), Number(e[1])];
      const m = Number.isFinite(was[0]) && Number.isFinite(was[1]) ? haversineKm(was[0], was[1], node.lat, node.lon) * 1000 : null;
      out.push({ reason: 'moved', detail: `${who} has moved${m != null ? ` ${metresWords(m)}` : ''} since: its recorded position is not the one this was worked out at.` });
    }
    if (!sameNum(e[2], node.elevation_ahd)) {
      out.push({ reason: 'height', detail: e[2] === ''
        ? `${who} had no recorded ground height then; it has ${node.elevation_ahd} m AHD now.`
        : node.elevation_ahd == null ? `${who} had a ground height of ${e[2]} m AHD then; none is recorded now.`
          : `${who}'s ground height was ${e[2]} m AHD then, ${node.elevation_ahd} m AHD now.` });
    }
    const sys = sysOf(node);
    const agl = antennaAgl(node, sys, sig.model);
    if (agl != null && !sameNum(e[3], agl)) {
      out.push({ reason: 'antenna', detail: `${who}'s antenna was modelled at ${e[3]} m then; it would be at ${agl} m now.` });
    }
    const radio = [['transmit power', 4, sys && sys.tx_power_w, 'W'], ['antenna gain', 5, sys && sys.antenna_gain_dbi, 'dBi'],
      ['line loss', 6, sys && sys.line_loss_db, 'dB'], ['receive threshold', 7, sys && sys.rx_threshold_dbm, 'dBm']]
      .filter(([, k, now]) => !sameNum(e[k], now ?? null))
      .map(([what, k, now, unit]) => `${what} ${e[k] === '' ? 'not set' : `${e[k]} ${unit}`} then, ${now == null ? 'not set' : `${now} ${unit}`} now`);
    if (radio.length) out.push({ reason: 'radio', detail: `${who}'s radio has changed since: ${radio.join('; ')}.` });
  });
  // Either order: a line between two repeaters is priced at whichever end the
  // map handed over first, and either is the same line.
  const freqs = [freqFor(nodeA, nodeB), freqFor(nodeB, nodeA)];
  if (nodeA && nodeB && !freqs.some(f => sameNum(sig.freq, f))) {
    out.push({ reason: 'frequency', detail: `Worked out at ${mhzWords(sig.freq)}; the line's frequency is ${mhzWords(freqs[0])} now.` });
  }
  return out;
}

export const END_REASONS = Object.freeze(['moved', 'height', 'antenna', 'radio', 'frequency']);

// ── A hop, in full and in brief ──────────────────────────────────────────────

export const NOT_MODELLED = 'Not modelled yet — Flood-Net computes fade margins on the Stations map (Layers → Link colour: By fade margin) '
  + 'and an editor saves them; none has been saved for this hop.';

export function bandOf(db, good, ok) {
  if (db == null) return null;
  return db >= good ? 'good' : db >= ok ? 'ok' : 'bad';
}

// One hop, from → to, with the saved figure for the pair (row) or without one.
// `ends` resolves an id to its station node; `kind` is 'field' (a field
// station to the repeater that carries it) or 'backbone'.
export function hopDetail(from, to, row, { kind, carries, sysById, ends }) {
  const km = kmBetween(from, to);
  const out = {
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name, role: to.isBase ? 'base' : 'repeater' },
    kind,
    distance_km: round(km, 2),
    ...(carries && carries.length ? { carries_addresses: carries } : {}),
  };
  if (!row) return { ...out, status: 'not modelled', detail: NOT_MODELLED };
  const fwd = from.id < to.id;
  const ab = num(row.margin_ab_db), ba = num(row.margin_ba_db);
  const there = (fwd ? ab : ba) ?? num(row.margin_db);
  const back = fwd ? ba : ab;
  const good = num(row.good_db) ?? 15, ok = num(row.ok_db) ?? 6;
  const reasons = staleReasons(row, ends(row.station_a_id), ends(row.station_b_id), sysById);
  return {
    ...out,
    status: 'ok',
    margin_db: there,
    margin_back_db: back,
    band: bandOf(there, good, ok),
    thresholds_db: { good, ok },
    freq_mhz: num(row.freq_mhz),
    verdict: row.verdict || null,
    model: row.model || null,
    computed_at: row.computed_at || null,
    stale: reasons.length > 0,
    ends_changed: reasons.some(r => END_REASONS.includes(r.reason)),
    stale_reasons: reasons,
  };
}

// The few fields a route repeats for each of its hops; the rest is in the
// answer's `hops`, once per hop.
export function hopBrief(h) {
  return h.status === 'ok'
    ? { from: h.from.id, to: h.to.id, status: 'ok', margin_db: h.margin_db, band: h.band, stale: h.stale }
    : { from: h.from.id, to: h.to.id, status: h.status };
}

// ── Routes, weighed ──────────────────────────────────────────────────────────

// A route's figures. hops: the full hop objects in order.
export function routeStats(stations, hops) {
  let weakest = null, unmodelled = 0, stale = 0, km = 0;
  for (const h of hops) {
    km += h.distance_km || 0;
    if (h.status !== 'ok') { unmodelled++; continue; }
    if (h.stale) stale++;
    if (h.margin_db != null && (!weakest || h.margin_db < weakest.margin_db)) weakest = h;
  }
  return { stations, hops, complete: unmodelled === 0 && hops.length > 0, unmodelled, stale, weakest, km, key: stations.join('>') };
}

// Best first: every hop modelled, then the fewest not modelled, then the
// strongest weakest hop, then the fewest hops, then the shortest, then by id.
export function compareRoutes(a, b) {
  if (a.complete !== b.complete) return a.complete ? -1 : 1;
  if (a.unmodelled !== b.unmodelled) return a.unmodelled - b.unmodelled;
  const wa = a.weakest ? a.weakest.margin_db : -Infinity, wb = b.weakest ? b.weakest.margin_db : -Infinity;
  if (wa !== wb) return wb - wa;
  if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
  if (a.km !== b.km) return a.km - b.km;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function routeOut(r, names) {
  const last = r.stations[r.stations.length - 1];
  return {
    route: r.stations.map(id => names(id)).join(' → '),
    stations: r.stations,
    base: { id: last, name: names(last) },
    hop_count: r.hops.length,
    distance_km: round(r.km, 2),
    complete: r.complete,
    unmodelled_hops: r.unmodelled,
    stale_hops: r.stale,
    weakest_hop: r.weakest ? { from: r.weakest.from.id, to: r.weakest.to.id, margin_db: r.weakest.margin_db,
      band: r.weakest.band, stale: r.weakest.stale } : null,
    hops: r.hops.map(hopBrief),
  };
}

// ── Plain words ──────────────────────────────────────────────────────────────

export const dbWords = v => `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} dB`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listWords = (items, max = 4) => (items.length <= max ? (items.length < 2 ? items.join('')
  : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)
  : `${items.slice(0, max).join(', ')} and ${items.length - max} more`);

export function dateWords(t) {
  if (!t) return 'an unknown date';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
  if (!Number.isFinite(d.getTime())) return 'an unknown date';
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Brisbane' });
}

// "on 3 September 2026", or "between 3 and 4 September 2026".
export function dateSpanWords(from, to) {
  const a = dateWords(from), b = dateWords(to);
  if (a === b) return `on ${a}`;
  const [da, ma, ya] = a.split(' '), [db, mb, yb] = b.split(' ');
  if (ya === yb && ma === mb) return `between ${da} and ${db} ${mb} ${yb}`;
  if (ya === yb) return `between ${da} ${ma} and ${db} ${mb} ${yb}`;
  return `between ${a} and ${b}`;
}

export function bandWords(band, t) {
  if (band === 'good') return `good (${t.good} dB or more)`;
  if (band === 'ok') return `ok (${t.ok} dB to under ${t.good} dB)`;
  return `bad (under ${t.ok} dB)`;
}

// A route as one line: each hop's figure after the station it reaches.
export function routeWords(r) {
  const parts = [r.hops[0] ? r.hops[0].from.name : ''];
  for (const h of r.hops) parts.push(`${h.to.name} (${h.status === 'ok' ? dbWords(h.margin_db) : 'not modelled yet'})`);
  return parts.join(' → ');
}

// The measured margin's step, the Network Review's reading of an attenuator:
// 30 or more is "at least 30", a reading on the 3 dB grid is a 3 dB step, any
// other a 1 dB one — so 24 means 24–27 dB and 19 means 19–20 dB.
export const ATTENUATOR = Object.freeze({ max: 30, step: 3, fine: 1 });
export function attenuatorRange(v) {
  if (v == null) return null;
  if (v >= ATTENUATOR.max) return [v, null];
  const step = Math.abs(v / ATTENUATOR.step - Math.round(v / ATTENUATOR.step)) < 1e-9 ? ATTENUATOR.step : ATTENUATOR.fine;
  return [v, v + step];
}
export const rangeWords = r => (!r ? null : r[1] == null ? `at least ${r[0]} dB` : `${r[0]}–${r[1]} dB`);

// What the answer's summary says. `p` is the parts api.js assembled.
export function summaryLines(p) {
  const lines = [];
  const who = p.name;
  if (p.proposed) lines.push(`${who} is proposed, not yet built: Flood-Net has no radio path for it until it has ALERT addresses and a place in the network.`);
  if (p.start === 'base') {
    lines.push(`${who} is a base station: readings that reach it have arrived, so there is no path on from it.`);
  } else if (p.start === 'repeater') {
    lines.push(`${who} is a repeater, so its routes to a base station start at itself: `
      + `${p.routesFound ? `${plural(p.routesFound, 'route')} reach ${plural(p.bases.length, 'base station')}` : 'no base station is within reach'}`
      + `${p.bases.length ? `, the nearest ${p.bases[0].name} (${p.bases[0].distance_km} km)` : ''}.`);
  } else if (p.repeaters && p.repeaters.length) {
    lines.push(`${who}'s ALERT ${p.addresses.length === 1 ? 'address' : 'addresses'} ${listWords(p.addresses.map(String))} `
      + `${p.addresses.length === 1 ? 'is' : 'are'} passed by ${plural(p.repeaters.length + (p.notListed || 0), 'repeater')} within ${p.firstHopKm} km`
      + `${p.notListed ? ` (the nearest ${p.repeaters.length} listed)` : ''}: `
      + `${listWords(p.repeaters.map(r => `${r.name} (${r.distance_km} km)`), 5)}.`);
  } else if (p.noPathWhy) {
    lines.push(p.noPathWhy);
  }
  const best = p.best;
  if (best) {
    const t = best.weakest ? best.weakest.thresholds_db : null;
    if (best.complete) {
      lines.push(`Best path to a base station, every hop modelled: ${routeWords(best)}. Its weakest hop is `
        + `${best.weakest.from.name} → ${best.weakest.to.name}, ${dbWords(best.weakest.margin_db)}, ${bandWords(best.weakest.band, t)}.`);
    } else if (best.weakest) {
      lines.push(`No route to a base station has every hop modelled yet. The best so far: ${routeWords(best)} — `
        + `its weakest modelled hop ${best.weakest.from.name} → ${best.weakest.to.name}, ${dbWords(best.weakest.margin_db)}.`);
    } else {
      lines.push(`No hop on any route to a base station is modelled yet. The shortest: ${routeWords(best)}.`);
    }
  } else if (p.start !== 'base' && p.repeaters && p.repeaters.length) {
    lines.push(`No base station is within reach of ${p.repeaters.length === 1 ? 'that repeater' : 'those repeaters'} along the backbone `
      + `(${p.linkKm} km a hop, ${p.maxRepeaters} repeaters a route).`);
  }
  const s = p.stale;
  if (s.modelled) {
    const when = dateSpanWords(s.from, s.to);
    if (s.stale === s.modelled && s.byModel === s.modelled && s.oldModels.length === 1) {
      lines.push(`Every saved figure on these routes is stale: worked out ${when} with ${modelWords(s.oldModels[0])} (${s.oldModels[0]}), `
        + `and Flood-Net now works fade margins out with ${modelWords(FADE_MODEL)} (${FADE_MODEL})${s.oldModels[0] === 'itm-p2p/2'
          ? ', calibrated against path margins measured on site. The land-cover model read about 41 dB below those measurements on average, '
            + 'so read these figures as much too low, not as the margin,'
          : ','} until the Stations map's fade-margin layer is worked out and saved again.`);
    } else if (s.stale) {
      lines.push(`${s.stale} of the ${plural(s.modelled, 'saved figure')} on these routes ${s.stale === 1 ? 'is' : 'are'} stale (worked out ${when}): `
        + 'the map would not show them until they are worked out and saved again — stale_reasons on each hop says why.');
    } else {
      lines.push(`The ${plural(s.modelled, 'saved figure')} on these routes still match${s.modelled === 1 ? 'es' : ''} the register (worked out ${when}).`);
    }
    if (s.endsChanged) {
      lines.push(`On ${plural(s.endsChanged, 'hop')} an end has also changed since — moved, or its ground height, antenna, radio or frequency — and stale_reasons says which.`);
    }
  }
  if (p.unmodelled) {
    lines.push(`${p.unmodelled} of the ${plural(p.hopCount, 'hop')} on these routes ${p.unmodelled === 1 ? 'has' : 'have'} no saved figure: `
      + 'not modelled yet — Flood-Net computes these on the Stations map and an editor saves them.');
  }
  const m = p.measured;
  if (m && m.status === 'ok' && m.tests.length) {
    const t0 = m.tests[0];
    const fig = t => (t.this_visit_db != null ? t.this_visit_db : t.original_db);
    const rest = m.tests.slice(1, 3).map(t => `${fig(t)} dB on ${dateWords(t.date)}`);
    lines.push(`Measured on site: the last attenuator test, on ${dateWords(t0.date)}, found ${who}'s reports still reaching base through `
      + `${fig(t0)} dB of added loss${t0.this_visit_range_db ? ` (read as ${rangeWords(t0.this_visit_range_db)})` : ''}`
      + `${rest.length ? `; before it, ${listWords(rest)}` : ''}.${p.hopCount ? ' That is the whole path, station to base; the figures above are each hop\'s.' : ''}`);
  } else if (m && m.status === 'not recorded' && p.start !== 'base') {
    lines.push(`No attenuator test of ${who}'s path margin is recorded at a site visit.`);
  }
  return lines;
}
