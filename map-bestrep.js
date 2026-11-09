// MegaNet — map-bestrep.js
//
//   MapBestRepeater   the best repeater finder: name a station — one in the
//                     register, or a new site nobody has set up yet, typed as
//                     a lat, lon or picked on the map — and it prices the path
//                     from there to every repeater and base station within
//                     reach, follows each repeater's best route on along the
//                     backbone to a base, and ranks them by the weaker of the
//                     two: the station's own hop, and the weakest hop on.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, fmtKm, acmaHaversineKm,
// bearingDeg, cssVar, slug, dlText, announce, termHtml, stationLatLonText,
// copyLatLonPillHtml and mapViewPills; across to path-profile.js for
// pathGround, pathAnalyse, pathPropOf, rmSystemOf, stationAntenna,
// stationIsMast, wattsToDbm, radioPlace and the PATH_DEFAULT_* constants, land-cover.js
// for LandCover.sample, map-fade.js for MapFade.known, work and ready,
// map-backbone.js for repeaterOpenWindows, map-draw.js for MapDraw,
// map-controls.js for MapChrome.panel, address-space.js for
// AddressSpace.figures and allocateIn, toast.js for Toast, and app.js for findRepeaterMatches,
// stationAlertIds, switchTab, setDockTab, rerenderMapLegend and mapNote. All of
// it from inside its own functions, so this file's position among the modules
// is free.
//
// ── The question this answers ────────────────────────────────────────────────
// The repeater site finder (map-sites.js) asks where a new mast should go; the
// relocation finder (map-relocate.js) where a station should move to stay
// heard by the repeaters it has. This is the question before either, and the
// commoner one: of the masts already standing, which should this station talk
// to? A new gauge has no repeater yet and somebody has to choose one before
// its addresses can be allocated; an existing one arrives badly, and the
// question is whether a repeater it does not use today would hear it better.
// The repeater that carries a station now is usually the nearest one with a
// window open to its address, which is not the same thing as the best one: a
// range in the way, a closer mast in a valley, a hop on to base that is the
// weak link even when the station's own is strong.
//
// ── How ──────────────────────────────────────────────────────────────────────
// One pass, and every figure the card's. With a few dozen candidates there is
// nothing to screen: each path is priced as the link budget card prices it —
// pathGround at 256 samples, the land cover on it under the land-cover model,
// pathAnalyse — one way, the station to the hub, MapFade's reading of a link.
// So a figure here is the figure the card gives when the path is opened in it,
// and for a repeater that carries the station today, the figure the fade
// margin layer paints on that link (the check holds the three together).
//
// On from each repeater: the agent API's rules (worker/radio-path.js), walked
// here over the station file in memory — a repeater within the map's Max TX
// distance whose open windows take some of what this one passes on, or a base
// within it, where the route ends; at most four repeaters a route, never the
// same station twice, and one repeater past the fewest that reach a base. What
// this one passes on is the station's own addresses where it carries them
// already, and its whole window where it does not — a station moved to it
// would be given an address there. Each hop's figure is the fade margin layer's
// (MapFade.known: the saved row while its signature holds, else this session's),
// never one invented here; a hop nobody has worked out is said to be, and
// "Work out the missing hops" works them out with the layer's own computeOne,
// so its Save can keep them. The best route is the agent API's best: every hop
// known first, then the strongest weakest hop, then the fewest hops, then the
// shortest.
//
// ── The ranking ──────────────────────────────────────────────────────────────
// A path is only as good as its weakest hop, so the default is the weaker of
// the two figures. Where the route on has a hop with no figure, the station's
// own hop stands alone and is marked ≈; a repeater with no route to a base at
// all goes below every one that has. "Its own hop only" ranks by the first
// figure and nothing else, for the question "who hears it best". Changing the
// ranking re-ranks and costs nothing; changing the station, the radio, the
// antenna or the distance takes the answer away (map-polar.js's rule).
//
// ── What it is not ───────────────────────────────────────────────────────────
// ~30 m terrain and omnidirectional antennas, the model the fade margin layer
// runs and nothing measured on the day. Frequencies are not matched, as the
// map does not match them: each row says what its repeater listens on. And a
// repeater a station is moved to still has to be given the address — the row
// says how much room its windows have, and hands over to the ALERT IDs tab's
// Allocate card.
const MapBestRepeater = (function () {
  // The lines over the network's own links (400) and their arrowheads (405),
  // under the cameras (415): they are the answer, and a station's twenty
  // candidate paths under the network's orange would be read through it. The
  // numbered pins over the other finders' (660, 662), under the popups (700).
  const LINE_PANE = 'mnBestLines', LINE_Z = 408;
  const PANE      = 'mnBest',      PANE_Z = 664;

  const MIN_KM = 5, MAX_KM = 150, DEF_KM = 60;
  const MAX_HUBS      = 30;          // priced, nearest first …
  const SAMPLES       = 256;         // the card's figure, PathProfile's own
  const CONCURRENCY   = 4;           // paths in flight, MapFade's figure
  const MAX_REPEATERS = 4;           // a route's repeaters — worker/radio-path.js MAX_REPEATERS
  const BEYOND        = 1;           // … and one past the fewest that reach a base
  const ROUTE_CAP     = 2000;        // routes weighed from one repeater
  const HIT_CAP       = 8;           // stations offered by the search box
  const SHOWN         = 8;           // results listed before "Show all"
  const STORE         = 'mn-bestrep-v1';

  const RANKS = {
    whole: 'The whole way — the weaker of its hop and the route on',
    first: 'Its own hop only',
  };

  const BAND = {
    good: ['--map-fade-good', '#00e676'], ok: ['--map-fade-ok', '#ffab00'],
    bad:  ['--map-fade-bad', '#e53935'],  none: ['--muted', '#888888'],
  };

  const cfg = load();

  let map = null, body = null, layer = null, lineLayer = null;
  let site = null;          // { kind: 'station', id } | { kind: 'point', lat, lon }
  let sysId = null;         // the radio picked for the station, or null for its own
  let aglSet = null;        // the antenna height typed, or null for its radio's
  let hitQ = '';
  let pointQ = '';
  let armed = false;        // the next click on the map is the new site
  let job = null;           // { cancelled } while a pass is in flight
  let found = null;         // everything worked out, for the site as it was asked
  let results = [];         // found.cands, ranked
  let selectedId = null;
  let showAll = false;
  let status = { kind: 'idle', text: '' };

  // ── Settings ────────────────────────────────────────────────────────────────

  function load() {
    const d = { km: DEF_KM, rank: 'whole' };
    try { return Object.assign(d, JSON.parse(localStorage.getItem(STORE) || '{}')); }
    catch (_) { return d; }
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(cfg)); }
    catch (_) { /* private browsing, a full quota — it still holds this session */ }
  }

  function km() {
    const v = +cfg.km;
    return Math.max(MIN_KM, Math.min(MAX_KM, isFinite(v) && v > 0 ? v : DEF_KM));
  }

  function rankMode() { return RANKS[cfg.rank] ? cfg.rank : 'whole'; }

  function goodDb() { return state.mapFadeGoodDb > 0 ? state.mapFadeGoodDb : 15; }
  function okDb()   { return isFinite(state.mapFadeOkDb) ? state.mapFadeOkDb : 6; }
  function linkKm() { return state.mapMaxLinkKm > 0 ? state.mapMaxLinkKm : 100; }

  // ── The words ───────────────────────────────────────────────────────────────
  // One list, read by the headings, the chips and the fold that says them
  // without a hover (docs/design-system.md, "Words that mean something here").

  function words() {
    const G = goodDb(), O = okDb(), K = linkKm();
    return {
      hop: 'The fade margin from the station to this repeater or base: how many decibels its signal arrives above what the '
        + 'receiver there needs, one way — the way the readings go. Worked out the link budget card\'s way, Longley–Rice over '
        + '~30 m terrain with both ends\' radios on file.',
      onward: `How what this repeater relays reaches a base station: the best route along the backbone — on to a repeater within ${K} km `
        + `whose pass ranges take some of the same addresses, or to a base within ${K} km — at most ${MAX_REPEATERS} repeaters, and `
        + 'the fade margin of its weakest hop as the Stations map worked it out.',
      whole: 'The weaker of the two: the station\'s own hop, and the weakest hop on the route on to a base. A path is only as good '
        + 'as its weakest hop. Marked ≈ when a hop on the route on has no figure yet, so the station\'s own hop stands alone.',
      good: `${G} dB or more to spare — the fade margin layer's green, set in Layers.`,
      ok: `${O} to ${G} dB to spare — enough for most days, not for the worst; the fade margin layer's yellow.`,
      bad: `Under ${O} dB to spare — likely to drop readings in a storm; the fade margin layer's red.`,
      clear: 'Line of sight: nothing reaches into 60% of the first Fresnel zone between the two antennas.',
      marginal: 'Line of sight: the ground or what stands on it reaches into 60% of the first Fresnel zone, but not across the straight line. It costs some signal, which the fade margin already counts; most long VHF paths are like this.',
      obstructed: 'Line of sight: the ground cuts the straight line between the two antennas, so the signal has to bend over it.',
      carries: 'This repeater\'s pass ranges already take one of the station\'s ALERT addresses, so it relays the station today.',
      free: 'ALERT addresses inside this repeater\'s pass ranges that no station in its hub holds and nobody has set aside — room '
        + 'for a new station\'s readings. Addresses set aside are counted once the ALERT IDs tab has been opened.',
      unworked: 'A hop on the route on with no fade margin on file: nobody has worked it out under the model in use, or its saved '
        + 'figure is stale because a radio or a position has changed since.',
    };
  }

  const GLOSSARY = [
    ['hop', 'Its hop'], ['onward', 'On to base'], ['whole', 'Whole way'],
    ['good', 'Good'], ['ok', 'Ok'], ['bad', 'Poor'],
    ['clear', 'Clear'], ['marginal', 'Partly clear'], ['obstructed', 'Obstructed'],
    ['carries', 'Carries it now'], ['free', 'Free addresses'], ['unworked', 'Not worked out'],
  ];

  function term(k, text) { return termHtml(text || (GLOSSARY.find(g => g[0] === k) || [k, k])[1], words()[k]); }
  function chip(k, text, cls) {
    return `<span class="term-chip bestrep-chip${cls ? ` ${cls}` : ''}" title="${escAttr(words()[k])}">${esc(text)}</span>`;
  }

  function glossaryHtml() {
    const w = words();
    return `<details class="bestrep-words"><summary>What the words on this panel mean</summary>
      <dl>${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(w[k])}</dd>`).join('')}</dl>
    </details>`;
  }

  // ── The station, and its radio ──────────────────────────────────────────────

  function stations() { return (state.data && state.data.stations) || []; }
  function stationById(id) { return stations().find(s => s.id === id) || null; }

  // The station the question is about, as one shape for a station in the
  // register and for a point with nothing there yet.
  function siteNow() {
    if (!site) return null;
    if (site.kind === 'station') {
      const st = stationById(site.id);
      if (!st) return null;
      let addrs = [];
      try { addrs = stationAlertIds(st); } catch (_) { addrs = []; }
      return { kind: 'station', st, id: st.id, name: st.name, number: st.station_number || '',
               lat: st.lat, lon: st.lon, elev: st.elevation_ahd != null ? st.elevation_ahd : null, addrs };
    }
    return { kind: 'point', st: null, id: null, name: 'The new site', number: '',
             lat: site.lat, lon: site.lon, elev: null, addrs: [] };
  }

  // The link budget card's rule, inherited: a term nobody supplied blanks the
  // figure rather than being read as nought.
  function complete(sys) {
    return !!sys && sys.tx_power_w != null && sys.antenna_gain_dbi != null
        && sys.line_loss_db != null && sys.rx_threshold_dbm != null;
  }

  function systems() { return ((state.data && state.data.rm_systems) || []).filter(complete); }

  // The radio most of the network runs — map-sites.js's fieldDefault, and for
  // its reason: a new site will most likely get what everything else has.
  function fieldDefault() {
    const list = systems();
    if (!list.length) return null;
    const n = new Map();
    for (const s of stations()) {
      const sys = rmSystemOf(s);
      if (complete(sys)) n.set(sys.id, (n.get(sys.id) || 0) + 1);
    }
    return list.reduce((best, r) => ((n.get(r.id) || 0) > (n.get(best.id) || 0) ? r : best), list[0]);
  }

  function radioOf(sys, agl) {
    return { sysId: sys.id, sysName: sys.name, txW: sys.tx_power_w, gain: sys.antenna_gain_dbi,
             loss: sys.line_loss_db, thr: sys.rx_threshold_dbm, agl };
  }

  // The station's end: the radio picked in the panel, else its own as filed,
  // else the network's commonest — on its own antenna height unless one was
  // typed. `own` says whether this is the radio it has on file.
  function hereRadio(s) {
    if (!s) return null;
    const picked = sysId != null ? systems().find(r => String(r.id) === String(sysId)) || null : null;
    const own = s.st ? rmSystemOf(s.st) : null;
    const sys = picked || (complete(own) ? own : fieldDefault());
    if (!sys) return null;
    const agl = aglSet > 0 ? +aglSet : stationAntenna(s.st || { roles: ['field'] }, sys).agl;
    return { ...radioOf(sys, agl), own: !!(s.st && complete(own) && sys.id === own.id),
             common: !picked && !(s.st && complete(own)), typedAgl: aglSet > 0 };
  }

  // A repeater or a base at the far end: its own radio and its own mast
  // (stationAntenna raises it to the propagation settings' mast height), the
  // frequency it listens on, and whether pathGround may stand it on its top.
  function isHub(s) {
    return !!s && Array.isArray(s.roles)
      && ((s.roles.includes('repeater') && !!s.repeater) || s.roles.includes('base'));
  }

  function hubOf(s) {
    const sys = rmSystemOf(s);
    return {
      id: s.id, s, name: s.name, number: s.station_number || '', lat: s.lat, lon: s.lon,
      elev: s.elevation_ahd != null ? s.elevation_ahd : null,
      rad: complete(sys) ? radioOf(sys, stationAntenna(s, sys).agl) : null, mast: stationIsMast(s),
      f: s.repeater && s.repeater.rx_mhz > 0 ? s.repeater.rx_mhz : PATH_DEFAULT_MHZ,
      isBase: s.roles.includes('base'), isRep: s.roles.includes('repeater') && !!s.repeater,
    };
  }

  // Every repeater and base within the distance, nearest first and at most
  // MAX_HUBS of them — and every repeater carrying the station today, however
  // far, because "better than now" needs now in the table.
  function hubChoices(s) {
    if (!s || s.lat == null || s.lon == null) return { list: [], over: 0 };
    let now = [];
    if (s.st) { try { now = findRepeaterMatches(s.st) || []; } catch (_) { now = []; } }
    const carries = new Set(now.map(r => r.id));
    const all = stations()
      .filter(x => isHub(x) && x.lat != null && x.lon != null && (!s.st || x.id !== s.st.id))
      .map(x => ({ s: x, km: acmaHaversineKm(s.lat, s.lon, x.lat, x.lon), carries: carries.has(x.id) }))
      .sort((a, b) => a.km - b.km);
    const within = all.filter(x => x.km <= km());
    const list = within.slice(0, MAX_HUBS);
    for (const x of all) if (x.carries && !list.includes(x)) list.push(x);
    return { list, over: Math.max(0, within.length - MAX_HUBS) };
  }

  // ── The station's own hop ───────────────────────────────────────────────────

  function oneWay(loss, from, to) {
    const tx = wattsToDbm(from.txW);
    if (tx == null || loss == null) return null;
    return tx + from.gain - from.loss - loss + to.gain - to.loss - to.thr;
  }

  // The card's own figure: pathGround's ground at the card's sample count, the
  // land cover on it under the land-cover model. A profile with holes, or
  // cover that cannot be had where the model needs it, is refused (MapFade's
  // rule) and said to be.
  async function firstHop(s, here, hub) {
    const dKm = acmaHaversineKm(s.lat, s.lon, hub.lat, hub.lon);
    if (!hub.rad) return { dKm, failed: 'no complete radio on file for it' };
    const got = await pathGround(
      { lat: s.lat, lon: s.lon, elev: s.elev, agl: here.agl, mast: s.st ? stationIsMast(s.st) : false },
      { lat: hub.lat, lon: hub.lon, elev: hub.elev, agl: hub.rad.agl, mast: hub.mast },
      { samples: SAMPLES, freqMhz: hub.f });
    if (!got || !got.ok) return { dKm, failed: 'the terrain could not be read' };
    if (got.prof.partial) return { dKm, failed: 'the terrain had gaps along it' };
    const coverModel = pathPropOf().model === 'cover';
    const res = coverModel ? await LandCover.sample(got.prof.lat, got.prof.lon) : null;
    if (coverModel && !(res && res.ok)) return { dKm, failed: 'the land cover could not be read' };
    const an = pathAnalyse(got.prof, {
      elevA: got.ends.a.elev, elevB: got.ends.b.elev, aglA: here.agl, aglB: hub.rad.agl, freqMhz: hub.f,
      cover: res ? res.cls : null, canopy: res && res.canopyOk ? res.canopy : null,
    });
    if (!an.ok) return { dKm, failed: 'the model refused the path' };
    return { dKm, verdict: an.verdict, margin: oneWay(an.pathLoss_db, here, hub.rad), src: 'card' };
  }

  // ── On to a base ────────────────────────────────────────────────────────────
  // worker/radio-path.js's walk, over the station file in memory.

  function topology() {
    const nodes = new Map();
    for (const x of stations()) {
      if (x.lat == null || x.lon == null || !Array.isArray(x.roles)) continue;
      const isBase = x.roles.includes('base'), isRep = x.roles.includes('repeater') && !!x.repeater;
      if (!isBase && !isRep) continue;
      nodes.set(x.id, { id: x.id, s: x, lat: x.lat, lon: x.lon, isBase, isRep,
                        windows: isRep ? repeaterOpenWindows(x.repeater) : [] });
    }
    const all = [...nodes.values()];
    // A base that is a repeater too is where a route ends, never a repeater
    // on the way — the agent API's topology, and for its reason.
    return { nodes, reps: all.filter(n => n.isRep && !n.isBase), bases: all.filter(n => n.isBase), near: new Map() };
  }

  function nearOf(T, n) {
    if (T.near.has(n.id)) return T.near.get(n.id);
    const K = linkKm();
    const within = list => list.filter(x => x.id !== n.id)
      .map(x => ({ node: x, km: acmaHaversineKm(n.lat, n.lon, x.lat, x.lon) }))
      .filter(x => x.km <= K)
      .sort((a, b) => a.km - b.km || (a.node.id < b.node.id ? -1 : 1));
    const out = { bases: within(T.bases), reps: within(T.reps) };
    T.near.set(n.id, out);
    return out;
  }

  // What of `spans` a repeater's windows take.
  function takenBy(spans, node) {
    const out = [];
    for (const [alo, ahi] of spans) {
      for (const [blo, bhi] of node.windows) {
        const lo = Math.max(alo, blo), hi = Math.min(ahi, bhi);
        if (lo <= hi) out.push([lo, hi]);
      }
    }
    return out;
  }

  // Every route from one repeater to a base, as station ids, the repeater
  // first and the base last: a level at a time, at most MAX_REPEATERS
  // repeaters, and one past the fewest that reach a base.
  function routesFrom(T, start, carried) {
    if (start.isBase) return { routes: [[start.id]], capped: false };
    const out = [];
    let fewest = null, capped = false;
    const toBases = q => {
      const last = T.nodes.get(q.path[q.path.length - 1]);
      for (const { node: b } of nearOf(T, last).bases) {
        if (out.length >= ROUTE_CAP) { capped = true; return false; }
        out.push(q.path.concat(b.id));
        if (fewest == null) fewest = q.path.length;
      }
      return true;
    };
    const deeper = q => q.path.length < MAX_REPEATERS && (fewest == null || q.path.length < fewest + BEYOND);
    const first = { path: [start.id], carried };
    if (!toBases(first)) return { routes: out, capped };
    let level = [first];
    while (level.length) {
      const next = [];
      for (const q of level) {
        if (!deeper(q)) continue;
        for (const { node: r } of nearOf(T, T.nodes.get(q.path[q.path.length - 1])).reps) {
          if (q.path.includes(r.id)) continue;
          const c2 = takenBy(q.carried, r);
          if (!c2.length) continue;
          const c = { path: q.path.concat(r.id), carried: c2 };
          if (!toBases(c)) return { routes: out, capped };
          if (deeper(c)) next.push(c);
        }
      }
      level = next;
    }
    return { routes: out, capped };
  }

  // What the hub passes on for this station: its own addresses where the hub
  // carries them already, the hub's whole window where it does not.
  function carriedFor(s, node) {
    const mine = s.addrs.filter(a => node.windows.some(([lo, hi]) => lo <= a && a <= hi));
    return mine.length ? mine.map(a => [a, a]) : node.windows;
  }

  // One hop's figure, as the fade margin layer has it — held for the run, so
  // a hop on a hundred routes is asked about once.
  function hopFig(cache, fromId, toId) {
    const k = `${fromId}>${toId}`;
    if (cache.has(k)) return cache.get(k);
    const a = stationById(fromId), b = stationById(toId);
    let fig = null;
    try { fig = typeof MapFade !== 'undefined' && a && b ? MapFade.known(a, b) : null; } catch (_) { fig = null; }
    const out = { from: fromId, to: toId, km: a && b ? acmaHaversineKm(a.lat, a.lon, b.lat, b.lon) : null,
                  margin: fig && fig.margin != null ? fig.margin : null, verdict: fig ? fig.verdict || null : null,
                  src: fig && fig.margin != null ? fig.from : null, stale: !!(fig && fig.stale) };
    cache.set(k, out);
    return out;
  }

  function routeStats(ids, hops) {
    let weakest = null, unmodelled = 0, stale = 0, dist = 0;
    for (const h of hops) {
      dist += h.km || 0;
      if (h.margin == null) { unmodelled++; if (h.stale) stale++; continue; }
      if (!weakest || h.margin < weakest.margin) weakest = h;
    }
    return { ids, hops, complete: unmodelled === 0, unmodelled, stale, weakest, km: dist, key: ids.join('>') };
  }

  // Best first: every hop known, then the fewest not, then the strongest
  // weakest hop, then the fewest hops, then the shortest — worker/radio-path.js
  // compareRoutes, so the app and the agent API pick the same route.
  function compareRoutes(a, b) {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    if (a.unmodelled !== b.unmodelled) return a.unmodelled - b.unmodelled;
    const wa = a.weakest ? a.weakest.margin : -Infinity, wb = b.weakest ? b.weakest.margin : -Infinity;
    if (wa !== wb) return wb - wa;
    if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
    if (a.km !== b.km) return a.km - b.km;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  }

  // The best route on from every candidate, from the figures in hand. Re-run,
  // with nothing fetched, when the missing hops have been worked out.
  function weighOnward() {
    if (!found) return;
    const cache = new Map();
    found.missing = new Map();
    for (const c of found.cands) {
      const node = found.T.nodes.get(c.hub.id);
      if (!node) { c.onward = { kind: 'none', routes: 0 }; continue; }
      if (node.isBase) { c.onward = { kind: 'base', routes: 1 }; continue; }
      const walk = routesFrom(found.T, node, carriedFor(found.site, node));
      if (!walk.routes.length) { c.onward = { kind: 'none', routes: 0 }; continue; }
      const weighed = walk.routes.map(ids => {
        const hops = [];
        for (let i = 0; i < ids.length - 1; i++) hops.push(hopFig(cache, ids[i], ids[i + 1]));
        return routeStats(ids, hops);
      }).sort(compareRoutes);
      // Every hop with no figure on any route weighed: what "Work out the
      // missing hops" would work out, so the best might change.
      for (const r of weighed) for (const h of r.hops) if (h.margin == null) found.missing.set(`${h.from}>${h.to}`, h);
      c.onward = { kind: 'route', best: weighed[0], routes: weighed.length, capped: walk.capped };
    }
  }

  // ── The ranking ─────────────────────────────────────────────────────────────

  // The weaker of the two, where the route on can be judged.
  function wholeOf(c) {
    const f = c.first && !c.first.failed ? c.first.margin : null;
    if (f == null) return { db: null, approx: false };
    if (!c.onward || c.onward.kind === 'none') return { db: null, approx: false, noRoute: true };
    if (c.onward.kind === 'base') return { db: f, approx: false };
    const r = c.onward.best;
    if (!r.complete) return { db: f, approx: true };
    return { db: Math.min(f, r.weakest.margin), approx: false };
  }

  // The one figure a candidate is ranked on and its pin carries.
  function headline(c) {
    if (rankMode() === 'first') return c.first && !c.first.failed ? c.first.margin : null;
    return wholeOf(c).db;
  }

  function sortKey(c) {
    const f = c.first && !c.first.failed ? c.first.margin : null;
    if (rankMode() === 'first') return { tier: f == null ? 2 : 0, v: f == null ? -Infinity : f };
    const w = wholeOf(c);
    if (f == null) return { tier: 3, v: -Infinity };
    if (w.noRoute) return { tier: 2, v: f };
    return { tier: 0, v: w.db };
  }

  const byRank = (a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    return (ka.tier - kb.tier) || (kb.v - ka.v)
      || ((b.first && b.first.margin != null ? b.first.margin : -Infinity) - (a.first && a.first.margin != null ? a.first.margin : -Infinity))
      || (a.km - b.km) || (a.hub.id < b.hub.id ? -1 : 1);
  };

  function rank() {
    if (!found) { results = []; return; }
    results = found.cands.slice().sort(byRank);
    results.forEach((c, i) => { c.rank = i + 1; });
    if (!results.some(c => c.hub.id === selectedId)) selectedId = results.length ? results[0].hub.id : null;
  }

  // ── Running it ──────────────────────────────────────────────────────────────

  function readiness() {
    if (!state.data) return { ok: false, why: 'No stations are loaded.' };
    const s = siteNow();
    if (!s) return { ok: false, why: 'Pick a station — on its card, by name or number — or give a new site: a lat, lon, or a point picked on the map.' };
    if (s.lat == null || s.lon == null) return { ok: false, why: `${s.name} has no position on file to work from.` };
    const here = hereRadio(s);
    if (!here) return { ok: false, why: 'No radio system on file carries all four of transmit power, antenna gain, line loss and receiver threshold — there is no margin to compute.' };
    const hubs = hubChoices(s);
    if (!hubs.list.length) return { ok: false, why: `No repeater or base station is within ${km()} km of ${s.kind === 'point' ? 'it' : s.name}.` };
    return { ok: true, s, here, hubs };
  }

  async function lanes(list, n, fn, mine) {
    let i = 0;
    const lane = async () => { while (i < list.length && !mine.cancelled) await fn(list[i++]); };
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, lane));
  }

  async function run() {
    const r = readiness();
    if (!r.ok) { setStatus('blocked', r.why); return false; }
    if (job) job.cancelled = true;
    const mine = job = { cancelled: false };
    const { s, here, hubs } = r;
    found = null; results = []; selectedId = null; showAll = false;
    disarm();
    const cands = hubs.list.map(x => ({ hub: hubOf(x.s), km: x.km, carries: x.carries,
                                        brg: bearingDeg(s.lat, s.lon, x.s.lat, x.s.lon), first: null, onward: null }));
    draw();
    render();
    // The saved figures for the hops on are read while the terrain comes in.
    const savedP = typeof MapFade !== 'undefined' && MapFade.ready ? MapFade.ready().catch(() => 'failed') : Promise.resolve('absent');
    let done = 0;
    const tell = () => setStatus('running', `Working out the path to ${cands.length} repeater${cands.length === 1 ? '' : 's'} and base${
      cands.length === 1 ? '' : 's'} the link budget card's way — ${done} of ${cands.length}`);
    tell();
    try {
      await lanes(cands, CONCURRENCY, async c => {
        let fig;
        try { fig = await firstHop(s, here, c.hub); } catch (_) { fig = { dKm: c.km, failed: 'it could not be computed' }; }
        if (mine.cancelled) return;
        c.first = fig;
        done++;
        tell();
      }, mine);
      if (mine.cancelled) return false;
      setStatus('running', 'Following each repeater on to a base…');
      const saved = await savedP;
      if (mine.cancelled) return false;
      found = { site: s, here, cands, over: hubs.over, km: km(), T: topology(), saved, missing: new Map() };
      weighOnward();
      rank();
      job = null;
      setStatus('done', '');
      draw();
      render();
      rerenderMapLegend();
      const best = results[0];
      if (best) announce(`Best repeater: ${best.hub.name}, ${dbText(headline(best))}.`);
      return true;
    } catch (e) {
      if (mine.cancelled) return false;
      job = null;
      setStatus('blocked', (e && e.message) || String(e));
      return false;
    }
  }

  // The hops on with no figure, worked out the fade margin layer's way and
  // kept in its session cache — then every route weighed again.
  async function workMissing() {
    if (!found || job || !found.missing.size) return false;
    const mine = job = { cancelled: false };
    const todo = [...found.missing.values()];
    let done = 0, failed = 0;
    const tell = () => setStatus('running', `Working out ${todo.length} hop${todo.length === 1 ? '' : 's'} on to a base — ${done} of ${todo.length}`);
    tell();
    render();
    await lanes(todo, CONCURRENCY, async h => {
      const a = stationById(h.from), b = stationById(h.to);
      let fig = null;
      try { fig = a && b ? await MapFade.work(a, b) : null; } catch (_) { fig = null; }
      if (mine.cancelled) return;
      if (!fig) failed++;
      done++;
      tell();
    }, mine);
    if (mine.cancelled) return false;
    job = null;
    weighOnward();
    rank();
    found.workFailed = failed;
    setStatus('done', '');
    draw();
    render();
    rerenderMapLegend();
    return true;
  }

  function invalidate() {
    if (job) job.cancelled = true;
    job = null;
    found = null; results = []; selectedId = null; showAll = false;
    status = { kind: 'idle', text: '' };
  }

  // ── Words for figures ───────────────────────────────────────────────────────

  function dbText(v) { return v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`; }

  function bandOfDb(v) { return v == null || !isFinite(v) ? 'none' : v >= goodDb() ? 'good' : v >= okDb() ? 'ok' : 'bad'; }
  function bandColour(b) { return cssVar(BAND[b][0], BAND[b][1]); }

  function bandHtml(v, approx) {
    const b = bandOfDb(v);
    const t = `${approx ? '≈ ' : ''}${dbText(v)}`;
    return b === 'none' ? `<span class="sites-band">${esc(t)}</span>`
      : `<span class="sites-band sites-band-${b} term-chip" title="${escAttr(words()[b])}">${esc(t)}</span>`;
  }

  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function compass(brg) { return COMPASS[Math.round(((brg % 360) + 360) % 360 / 45) % 8]; }

  function roleText(h) { return h.isBase && h.isRep ? 'repeater and base' : h.isBase ? 'base station' : 'repeater'; }

  function nameOf(id) { const s = stationById(id); return s ? s.name : id; }

  function verdictHtml(v) {
    if (!v) return '';
    const cls = v === 'obstructed' ? 'txt-bad' : v === 'marginal' ? 'txt-warn' : '';
    return `<span class="${cls}">${termHtml(pathVerdictWord(v), words()[v])}</span>`;
  }

  function onwardHtml(c) {
    const o = c.onward;
    if (!o) return '';
    if (o.kind === 'base') return 'It is a base station — the readings arrive here.';
    if (o.kind === 'none') return `<span class="txt-bad">No route on to a base — no base within ${linkKm()} km of it, and no repeater it could hand on to.</span>`;
    const r = o.best;
    const via = r.ids.slice(1, -1).map(nameOf);
    const base = nameOf(r.ids[r.ids.length - 1]);
    const path = `${via.length ? `via ${via.map(esc).join(' → ')} to ` : 'straight to '}<strong>${esc(base)}</strong>`;
    const n = r.hops.length;
    const fig = r.complete
      ? `weakest hop ${bandHtml(r.weakest.margin)}`
      : `<span class="txt-warn">${r.unmodelled} of ${n} hop${n === 1 ? '' : 's'} ${termHtml('not worked out', words().unworked)}</span>${
          r.weakest ? `, the rest no worse than ${dbText(r.weakest.margin)}` : ''}`;
    return `${path} · ${n} hop${n === 1 ? '' : 's'} · ${fig}`;
  }

  function roomOf(c) {
    if (!c.hub.isRep || typeof AddressSpace === 'undefined' || !AddressSpace.figures) return null;
    try { return AddressSpace.figures('rep:' + c.hub.id); } catch (_) { return null; }
  }

  function chipsHtml(c) {
    const bits = [];
    if (c.carries) bits.push(chip('carries', 'Carries it now', 'bestrep-now'));
    if (c.hub.isRep) bits.push(`<span class="small txt-muted">listens on ${c.hub.f.toFixed(3)} MHz</span>`);
    const room = roomOf(c);
    if (room && !c.carries) bits.push(chip('free', `${room.free} address${room.free === 1 ? '' : 'es'} free`, room.free ? '' : 'txt-bad'));
    return bits.join(' ');
  }

  // ── The panel ───────────────────────────────────────────────────────────────

  function setStatus(kind, text) {
    status = { kind, text: text || '' };
    const el = document.getElementById('bestrep-status');
    if (el) el.innerHTML = statusHtml();
    const btn = document.getElementById('bestrep-run');
    if (btn) btn.disabled = kind === 'running' || !readiness().ok;
    const cancel = document.getElementById('bestrep-cancel');
    if (cancel) cancel.hidden = kind !== 'running';
  }

  // Against the repeaters that carry it now: the first thing anybody asks of
  // the answer is whether it is better than what the station has.
  function verdictLine() {
    const best = results[0];
    if (!best) return '';
    const fig = headline;
    // ≈ where the whole way is the station's own hop standing alone, because
    // a hop on has no figure yet — said, so a lead it may lose is not read
    // as a lead it has.
    const approx = c => rankMode() === 'whole' && wholeOf(c).approx;
    const at = c => (fig(c) == null ? '' : ` at ${approx(c) ? '≈ ' : ''}${esc(dbText(fig(c)))}`);
    const hedge = cs => (cs.some(approx)
      ? ' <span class="txt-warn">≈: its route on to a base has hops with no figure yet, so the station\'s own hop stands alone — work them out to be sure.</span>' : '');
    if (found.site.kind === 'point' || !found.site.addrs.length) {
      return `<strong>${esc(best.hub.name)}</strong> is the best of ${found.cands.length}${at(best)}.${hedge([best])}`;
    }
    const now = results.filter(c => c.carries);
    if (!now.length) {
      return `<span class="txt-bad">No repeater carries ${esc(found.site.name)}'s addresses today.</span> The best of ${found.cands.length} is
        <strong>${esc(best.hub.name)}</strong>${at(best)}.${hedge([best])}`;
    }
    const top = now[0];
    if (best.carries) {
      return `<strong>${esc(best.hub.name)}</strong>, which carries it now, is already the best of ${found.cands.length}${at(best)}.${hedge([best])}`;
    }
    const bestW = fig(best), topW = fig(top);
    const gain = bestW != null && topW != null ? bestW - topW : null;
    const sign = approx(best) || approx(top) ? '≈ ' : '';
    return `<strong>${esc(best.hub.name)}</strong> would be better than ${esc(top.hub.name)}, the best that carries it now${
      gain != null ? ` — by <strong>${sign}${gain.toFixed(1)} dB</strong> (${at(best).replace(/^ at /, '')} against ${at(top).replace(/^ at /, '')})` : ''}.${hedge([best, top])}`;
  }

  function statusHtml() {
    switch (status.kind) {
      case 'running': return `<span class="sites-run">${esc(status.text)}</span>`;
      case 'blocked': return `<span class="txt-warn">${esc(status.text)}</span>`;
      case 'done': {
        if (!found) return '';
        const h = found.here;
        const failed = found.cands.filter(c => c.first && c.first.failed).length;
        const miss = found.missing.size;
        return `${verdictLine()}<br>
          Priced ${found.cands.length} repeater${found.cands.length === 1 ? '' : 's'} and base${found.cands.length === 1 ? '' : 's'}
          within ${found.km} km${found.over ? ` — the nearest ${MAX_HUBS}; ${found.over} more further out were left out` : ''},
          from ${esc(found.site.name)} on ${esc(h.sysName)}${h.own ? '' : !h.common ? ' (picked here)'
            : found.site.kind === 'point' ? ' (the network\'s commonest radio)' : ' (the network\'s commonest radio — none of its own on file)'},
          ${h.agl} m AGL.${failed ? ` <span class="txt-warn">${failed} could not be priced.</span>` : ''}
          ${found.saved === 'failed' ? '<br><span class="txt-warn">The datastore did not answer, so only the hops on worked out in this browser have figures.</span>' : ''}
          ${miss ? `<br><span class="txt-warn">${miss} hop${miss === 1 ? '' : 's'} on to a base ${miss === 1 ? 'has' : 'have'} no figure yet</span>
            <button type="button" class="link-btn" onclick="MapBestRepeater.workMissing()"
              title="Work them out the fade margin layer's way — a terrain profile each; its Save keeps them">Work out the missing hops</button>` : ''}
          ${found.workFailed ? `<br><span class="txt-warn">${found.workFailed} of them could not be worked out — terrain unreachable, or no complete radio on file at one end.</span>` : ''}`;
      }
      default: {
        const r = readiness();
        return r.ok ? '' : `<span class="txt-muted">${esc(r.why)}</span>`;
      }
    }
  }

  function hits() {
    const q = hitQ.trim().toLowerCase();
    if (!q) return [];
    return stations().filter(s => s.lat != null && s.lon != null
        && ((s.name || '').toLowerCase().includes(q) || String(s.station_number || '').toLowerCase().includes(q)))
      .slice(0, HIT_CAP);
  }

  function hitsHtml() {
    if (!hitQ.trim()) return '';
    const list = hits();
    return list.map(s => `
      <button type="button" class="polar-hit${site && site.kind === 'station' && s.id === site.id ? ' is-here' : ''}"
              onclick="MapBestRepeater.pickStation('${escAttr(s.id)}')">
        <span>${esc(s.name)}</span>
        <span class="small txt-muted">${esc(s.station_number || '')}</span>
      </button>`).join('') || '<p class="small txt-muted">No station by that name.</p>';
  }

  // "-27.1234, 151.5678" — a comma, spaces or both between; the two the
  // other way round (a longitude first) are turned back, since no latitude
  // passes 90.
  function parsePoint(text) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text || ''));
    if (!m) return null;
    let a = +m[1], b = +m[2];
    if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
    if (!(Math.abs(a) <= 90 && Math.abs(b) <= 180)) return null;
    return { lat: a, lon: b };
  }

  function pickedHtml(s) {
    if (!s) return 'No station picked yet.';
    if (s.kind === 'point') return `A new site at <strong>${esc(stationLatLonText(s))}</strong>`;
    const now = (() => { try { return findRepeaterMatches(s.st) || []; } catch (_) { return []; } })();
    return `<strong>${esc(s.name)}</strong>${s.number ? ` (${esc(s.number)})` : ''}${
      s.addrs.length ? ` · ALERT ${esc(s.addrs.join(', '))}` : ' · <span class="txt-muted">no ALERT address on file</span>'}${
      s.addrs.length ? (now.length ? ` · carried now by ${esc(now.map(r => r.name).join(', '))}`
                                   : ' · <span class="txt-bad">no repeater carries it</span>') : ''}`;
  }

  function radioHtml(s) {
    const here = hereRadio(s);
    const list = systems();
    const own = s && s.st ? rmSystemOf(s.st) : null;
    return `
      <label class="filter-field">
        <span>Radio at the station</span>
        <select id="bestrep-sys" onchange="MapBestRepeater.set('sys', this.value)">
          <option value="">${esc(s && s.st && complete(own) ? `Its own — ${own.name}` : `The network's commonest${here ? ` — ${here.sysName}` : ''}`)}</option>
          ${list.map(r => `<option value="${escAttr(String(r.id))}" ${sysId != null && String(sysId) === String(r.id) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select>
      </label>
      <label class="draw-field">
        <span>Antenna</span>
        <input type="number" id="bestrep-agl" value="${aglSet > 0 ? aglSet : ''}" step="0.5" min="0" max="60"
               placeholder="${escAttr(here ? String(here.agl) : String(PATH_DEFAULT_AGL))}"
               onchange="MapBestRepeater.set('agl', this.value)">
        <b class="lb-flag">m AGL</b>
      </label>`;
  }

  function resultHtml(c) {
    const on = selectedId === c.hub.id;
    const f = c.first;
    const w = wholeOf(c);
    const hopLine = !f ? '—' : f.failed ? `<span class="txt-warn">not priced — ${esc(f.failed)}</span>`
      : `${bandHtml(f.margin)}${f.verdict ? ` · ${verdictHtml(f.verdict)}` : ''}`;
    return `
      <li class="sites-result${on ? ' is-on' : ''}">
        <button type="button" class="sites-result-main" onclick="MapBestRepeater.select('${escAttr(c.hub.id)}')"
                aria-pressed="${on ? 'true' : 'false'}"
                title="Show this one's path and its route on to a base on the map">
          <span class="sites-head bestrep-head">
            <span class="sites-rank" aria-hidden="true">${c.rank}</span>
            <strong>${esc(c.hub.name)}</strong>
          </span>
          <span class="sites-result-text sites-body bestrep-body">
            <span class="small txt-muted">${esc(roleText(c.hub))}${c.hub.number ? ` ${esc(c.hub.number)}` : ''} · ${c.km.toFixed(1)} km ${compass(c.brg)}</span>
            <span class="small">${term('hop')} ${hopLine}</span>
            ${f && !f.failed ? `<span class="small">${term('onward')} ${onwardHtml(c)}</span>` : ''}
            ${f && !f.failed && c.hub.isRep && !c.hub.isBase ? `<span class="small">${term('whole')} ${
              w.db != null ? bandHtml(w.db, w.approx) : '<span class="txt-muted">—</span>'}</span>` : ''}
            <span class="small bestrep-chips">${chipsHtml(c)}</span>
          </span>
        </button>
        ${on ? detailHtml(c) : ''}
      </li>`;
  }

  function detailHtml(c) {
    const room = roomOf(c);
    const r = c.onward && c.onward.kind === 'route' ? c.onward.best : null;
    const hops = r ? r.hops : [];
    const first = c.first && !c.first.failed ? c.first : null;
    const srcText = h => (h.margin == null ? (h.stale ? 'stale' : 'not worked out') : h.src === 'saved' ? 'saved' : 'this browser');
    return `
      <div class="sites-detail">
        <div class="sites-actions">
          <button type="button" onclick="MapBestRepeater.flyTo('${escAttr(c.hub.id)}')">Go to it</button>
          ${first ? `<button type="button" onclick="MapBestRepeater.profile('${escAttr(c.hub.id)}')"
                  title="Open the station's path to it in the elevation profile and link budget">Profile its hop</button>` : ''}
          ${c.hub.isRep && !c.carries && room && room.free ? `<button type="button" onclick="MapBestRepeater.allocate('${escAttr(c.hub.id)}')"
                  title="The ALERT IDs tab's Allocate card, set to this repeater — set an address aside for the station there">Allocate an address here</button>` : ''}
        </div>
        <div class="table-wrap">
          <table class="sites-table">
            <caption class="sr-only">Every hop from ${esc(found.site.name)} through ${esc(c.hub.name)} to a base</caption>
            <thead><tr><th scope="col">Hop</th><th scope="col">km</th><th scope="col">${term('hop', 'Margin')}</th><th scope="col">Figure</th></tr></thead>
            <tbody>
              <tr>
                <td>${esc(found.site.name)} → ${esc(c.hub.name)}</td>
                <td>${c.km.toFixed(1)}</td>
                <td>${first ? bandHtml(first.margin) : '—'}</td>
                <td>${first ? 'worked out here' : esc(c.first ? c.first.failed : '')}</td>
              </tr>
              ${hops.map(h => `<tr>
                <td>${esc(nameOf(h.from))} → ${esc(nameOf(h.to))}</td>
                <td>${h.km != null ? h.km.toFixed(1) : '—'}</td>
                <td>${h.margin != null ? bandHtml(h.margin) : '—'}</td>
                <td>${h.margin == null ? termHtml(srcText(h), words().unworked) : esc(srcText(h))}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${r && c.onward.routes > 1 ? `<p class="small txt-muted">The best of ${c.onward.routes} routes on${c.onward.capped ? ` (the first ${ROUTE_CAP} weighed)` : ''}.</p>` : ''}
      </div>`;
  }

  function panelHtml() {
    if (!state.data) return '<p class="filter-note">No stations are loaded, so there is nothing to find a repeater for.</p>';
    const s = siteNow();
    const list = showAll ? results : results.slice(0, SHOWN);
    return `
      <div class="sites-panel bestrep-panel">
        <fieldset class="sites-fs">
          <legend>The station</legend>
          <div class="sites-row">
            <button type="button" onclick="MapBestRepeater.useCard()"
                    title="Use the station whose card is open on the map, or the one selected in the list or picked on the map">Use the selected station</button>
          </div>
          <input type="search" id="bestrep-find" class="polar-find" autocomplete="off" spellcheck="false"
                 value="${escAttr(hitQ)}" placeholder="Or find it — name or station #"
                 aria-label="Find the station" oninput="MapBestRepeater.setSearch(this.value)">
          <div class="polar-hits" id="bestrep-hits">${hitsHtml()}</div>
          <div class="sites-row bestrep-point">
            <input type="text" id="bestrep-point" class="polar-find" autocomplete="off" spellcheck="false"
                   value="${escAttr(pointQ)}" placeholder="Or a new site — lat, lon"
                   aria-label="A new site, as latitude and longitude"
                   onkeydown="if (event.key === 'Enter') MapBestRepeater.usePoint(this.value)">
            <button type="button" onclick="MapBestRepeater.usePoint(document.getElementById('bestrep-point').value)">Use</button>
            <button type="button" id="bestrep-arm" aria-pressed="${armed ? 'true' : 'false'}" class="${armed ? 'is-on' : ''}"
                    onclick="MapBestRepeater.arm()" title="Click the map where the new station would stand">📍 ${armed ? 'Click the map…' : 'Pick on the map'}</button>
          </div>
          <p class="small polar-picked" id="bestrep-picked">${pickedHtml(s)}</p>
        </fieldset>

        <fieldset class="sites-fs">
          <legend>Search</legend>
          <label class="draw-field">
            <span>Repeaters and bases within</span>
            <input type="number" id="bestrep-km" value="${km()}" step="5" min="${MIN_KM}" max="${MAX_KM}"
                   onchange="MapBestRepeater.set('km', this.value)">
            <b class="lb-flag">km</b>
          </label>
          ${radioHtml(s)}
          <label class="filter-field">
            <span>Rank by</span>
            <select id="bestrep-rank" onchange="MapBestRepeater.set('rank', this.value)">
              ${Object.entries(RANKS).map(([k, t]) => `<option value="${k}" ${rankMode() === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}
            </select>
          </label>
          <p class="small txt-muted">The nearest ${MAX_HUBS} are priced, and every repeater carrying the station now. Ranking is a re-sort, not a re-run.</p>
        </fieldset>

        <div class="sites-actions">
          <button type="button" id="bestrep-run" class="primary" onclick="MapBestRepeater.run()"
                  ${readiness().ok && status.kind !== 'running' ? '' : 'disabled'}>Find the best repeater</button>
          <button type="button" id="bestrep-cancel" onclick="MapBestRepeater.cancel()" ${status.kind === 'running' ? '' : 'hidden'}>Cancel</button>
          <button type="button" onclick="MapBestRepeater.clear()" ${s || found ? '' : 'disabled'}>Clear</button>
          <button type="button" onclick="MapBestRepeater.save()" ${results.length ? '' : 'disabled'}
                  title="Every repeater and base priced, with every figure, as rows">Save CSV</button>
          <button type="button" id="bestrep-copy" onclick="MapBestRepeater.copyReport()" ${results.length ? '' : 'disabled'}
                  title="Copy the repeaters and bases listed below — the best ${SHOWN}, or all of them after Show all — with every figure, the picked one's hops on to a base, how it was worked out and what the words mean, ready to paste into Word, an email or a spreadsheet">📋 Copy for a report</button>
        </div>
        <p class="filter-note" id="bestrep-status">${statusHtml()}</p>
        ${results.length ? `<ol class="sites-results bestrep-results">${list.map(resultHtml).join('')}</ol>` : ''}
        ${results.length > SHOWN ? `<button type="button" class="link-btn" onclick="MapBestRepeater.toggleAll()">${
          showAll ? `Show the best ${SHOWN} only` : `Show all ${results.length}`}</button>` : ''}
        ${glossaryHtml()}
        <p class="filter-note">${esc(CAVEAT)}</p>
      </div>`;
  }

  const CAVEAT = 'Indicative. ~30 m terrain and omnidirectional antennas, the fade margin layer\'s model, and nothing '
    + 'measured on the day. Frequencies are not matched — each repeater says what it listens on. Open a path in the '
    + 'elevation profile card, and look at the site, before a station is moved to a repeater.';

  function render() {
    if (!body) return;
    const focusId = document.activeElement && body.contains(document.activeElement) ? document.activeElement.id : null;
    body.innerHTML = panelHtml();
    if (focusId) { const el = document.getElementById(focusId); if (el) el.focus({ preventScroll: true }); }
  }

  function legendHtml() {
    if (!found) return '';
    return `
      <span class="legend-item">
        <span class="legend-site" aria-hidden="true">1</span>
        <span class="small">Best repeater — every repeater and base within ${found.km} km of ${esc(found.site.name)} (red dashed ring),
          its path coloured by fade margin: green ${goodDb()} dB or better, yellow ${okDb()}, red below, dashed where the
          ground cuts the line. The numbered pins are the best first; the one picked has its route on to a base drawn,
          grey where a hop has no figure.</span>
      </span>`;
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  function clearLayers() {
    if (layer) { layer.remove(); layer = null; }
    if (lineLayer) { lineLayer.remove(); lineLayer = null; }
  }

  function pinIcon(c) {
    const w = headline(c);
    return L.divIcon({
      className: 'mn-site-icon',
      html: `<span class="mn-site${selectedId === c.hub.id ? ' is-on' : ''}">`
          + `<b class="mn-site-h">${w == null ? '—' : `${w > 0 ? '+' : ''}${Math.round(w)}`}</b>`
          + `<i class="mn-site-mark" aria-hidden="true">${c.rank}</i></span>`,
      iconSize: [0, 0], iconAnchor: [0, 0],
    });
  }

  function draw() {
    clearLayers();
    const s = found ? found.site : siteNow();
    if (!map || !s || s.lat == null || s.lon == null) return;
    lineLayer = L.layerGroup([], { pane: LINE_PANE }).addTo(map);
    layer = L.layerGroup([], { pane: PANE }).addTo(map);
    const accent = cssVar('--accent', '#0b5cab');
    // The search ring: red and 3 px, because a thin blue one was lost over the
    // satellite photos. Its own token (--bestrep-ring), not --map-fade-bad.
    L.circle([s.lat, s.lon], {
      pane: LINE_PANE, radius: (found ? found.km : km()) * 1000, color: cssVar('--bestrep-ring', '#d50000'),
      weight: 3, opacity: 0.8, dashArray: '6 6', fill: false, interactive: false,
    }).addTo(lineLayer);
    L.circleMarker([s.lat, s.lon], {
      pane: LINE_PANE, radius: 9, color: accent, weight: 2.5, opacity: 0.95, fill: true, fillColor: accent,
      fillOpacity: 0.25, interactive: false,
    }).addTo(lineLayer);
    if (!found) return;
    // Every path priced, thin; the one picked over them, heavy, with its route on.
    const sel = results.find(c => c.hub.id === selectedId) || null;
    for (const c of results) {
      if (!c.first || c.first.failed || c === sel) continue;
      L.polyline([[s.lat, s.lon], [c.hub.lat, c.hub.lon]], {
        pane: LINE_PANE, color: bandColour(bandOfDb(c.first.margin)), weight: 2, opacity: 0.55,
        dashArray: c.first.verdict === 'obstructed' ? '6 5' : null, interactive: false,
      }).addTo(lineLayer);
    }
    if (sel && sel.first && !sel.first.failed) {
      if (sel.onward && sel.onward.kind === 'route') {
        for (const h of sel.onward.best.hops) {
          const a = stationById(h.from), b = stationById(h.to);
          if (!a || !b) continue;
          L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
            pane: LINE_PANE, color: h.margin == null ? bandColour('none') : bandColour(bandOfDb(h.margin)),
            weight: 3, opacity: 0.9, dashArray: h.margin == null ? '2 6' : null, interactive: false,
          }).addTo(lineLayer);
        }
      }
      L.polyline([[s.lat, s.lon], [sel.hub.lat, sel.hub.lon]], {
        pane: LINE_PANE, color: bandColour(bandOfDb(sel.first.margin)), weight: 4.5, opacity: 0.95,
        dashArray: sel.first.verdict === 'obstructed' ? '8 6' : null, interactive: false,
      }).addTo(lineLayer);
    }
    const pinned = showAll ? results : results.slice(0, SHOWN);
    for (const c of pinned) {
      const pin = L.marker([c.hub.lat, c.hub.lon], {
        icon: pinIcon(c), pane: PANE, riseOnHover: true,
        title: `#${c.rank} ${c.hub.name} — ${c.km.toFixed(1)} km`,
      }).bindPopup(() => popupHtml(c), { maxWidth: 320 })
        .on('click', () => select(c.hub.id, { keepPopup: true }));
      pin.mnBestId = c.hub.id;
      pin.addTo(layer);
    }
  }

  function popupHtml(c) {
    const f = c.first;
    return `
      <div class="mn-site-pop">
        <h4>#${c.rank} ${esc(c.hub.name)}</h4>
        <p class="small">${esc(roleText(c.hub))} · ${c.km.toFixed(1)} km ${compass(c.brg)} of ${esc(found.site.name)}<br>
          ${term('hop')} ${f && !f.failed ? `${bandHtml(f.margin)}${f.verdict ? ` · ${verdictHtml(f.verdict)}` : ''}` : '—'}<br>
          ${f && !f.failed ? `${term('onward')} ${onwardHtml(c)}` : ''}</p>
        <div class="pill-row pill-list">
          ${copyLatLonPillHtml({ lat: c.hub.lat, lon: c.hub.lon, name: c.hub.name })}
          ${mapViewPills({ lat: c.hub.lat, lon: c.hub.lon, name: c.hub.name }).join('\n          ')}
        </div>
      </div>`;
  }

  function select(id, opts) {
    const c = results.find(x => x.hub.id === id);
    if (!c) return;
    selectedId = id;
    draw();
    render();
    if (opts && opts.keepPopup && layer) layer.eachLayer(l => { if (l.mnBestId === id) l.openPopup(); });
  }

  // ── Picking a new site on the map ───────────────────────────────────────────
  // The next click on the 2-D map is the new site. Arming takes the other
  // click-takers off the map, as What is here does on the way in — two modes
  // armed at once is one click doing two things nobody asked for — and one of
  // them armed after this disarms it at the click.

  function othersArmed() {
    return (state.draw && state.draw.tool)
      || (state.link && state.link.picking)
      || (typeof MapHere !== 'undefined' && MapHere.armed && MapHere.armed())
      || (typeof Places !== 'undefined' && Places.dropping && Places.dropping())
      || (typeof MapMovePin !== 'undefined' && MapMovePin.armed && MapMovePin.armed());
  }

  function syncArm() {
    if (typeof MapMode !== 'undefined') MapMode.sync();   // the banner over the map
    if (map) map.getContainer().classList.toggle('mn-bestrep-picking', armed);
    const b = document.getElementById('bestrep-arm');
    if (b) {
      b.setAttribute('aria-pressed', String(armed));
      b.classList.toggle('is-on', armed);
      b.textContent = `📍 ${armed ? 'Click the map…' : 'Pick on the map'}`;
    }
  }

  function disarm() { if (armed) { armed = false; syncArm(); } }

  function onMapClick(e) {
    if (!armed || !e || !e.latlng) return;
    if (othersArmed()) { disarm(); return; }
    armed = false;
    syncArm();
    pickPoint(e.latlng.lat, e.latlng.lng);
  }

  // ── Choosing the station ────────────────────────────────────────────────────

  function settle(fit) {
    draw();
    render();
    rerenderMapLegend();
    if (fit) fitSite();
  }

  // The ring round the site, on screen.
  function fitSite() {
    const s = siteNow();
    if (!map || !s || s.lat == null || s.lon == null) return;
    map.fitBounds(L.latLng(s.lat, s.lon).toBounds(km() * 2000), { maxZoom: 12 });
  }

  function pickStation(id) {
    const st = stationById(id);
    if (!st) return;
    invalidate();
    site = { kind: 'station', id: st.id };
    sysId = null; aglSet = null;
    hitQ = '';
    settle(true);
  }

  function pickPoint(lat, lon) {
    if (!isFinite(lat) || !isFinite(lon)) return;
    invalidate();
    site = { kind: 'point', lat: +(+lat).toFixed(6), lon: +(+lon).toFixed(6) };
    sysId = null; aglSet = null;
    pointQ = `${site.lat}, ${site.lon}`;
    settle(false);
    announce(`New site at ${stationLatLonText(site)}.`);
  }

  // The panel opened from somewhere else (the station card's Repeaters
  // listening), on the Stations tab: its pane if the side panel holds it, its
  // corner flyout if not — capabilities.js's tryOpen.
  function openPanel() {
    const wrap = document.querySelector('.mn-mapctl[data-panel="bestrep"]');
    if (!wrap) return false;
    if (wrap.classList.contains('is-docked')) {
      if (typeof setDockTab === 'function') setDockTab('map-bestrep');
    } else if (!wrap.classList.contains('is-open') && !(state.mapPanelsPinned && state.mapPanelsPinned.has('bestrep'))) {
      const btn = wrap.querySelector('.mn-mapctl-btn');
      if (btn) btn.click();
    }
    return true;
  }

  // ── The CSV ─────────────────────────────────────────────────────────────────

  function csvText() {
    if (!found || !results.length) return '';
    const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const f1 = v => (v == null || !isFinite(v) ? '' : v.toFixed(1));
    const s = found.site, h = found.here;
    const rows = [
      '# Flood-Net best repeater finder',
      `# station,${q(s.name)},${q(s.number)},${s.lat},${s.lon},within ${found.km} km`,
      `# radio,${q(h.sysName)},${h.agl} m AGL`,
      `# rules,ranked by ${q(RANKS[rankMode()])},ok ${okDb()} dB,good ${goodDb()} dB,on to a base: ${linkKm()} km a hop and at most ${MAX_REPEATERS} repeaters`,
      ['rank', 'id', 'name', 'station_number', 'role', 'distance_km', 'bearing_deg', 'carries_now', 'rx_mhz',
       'hop_margin_db', 'hop_line_of_sight', 'hop_note', 'route_on', 'route_hops', 'route_weakest_db', 'route_hops_not_worked_out',
       'whole_way_db', 'whole_way_approx', 'free_addresses'].join(','),
    ];
    for (const c of results) {
      const f = c.first || {};
      const r = c.onward && c.onward.kind === 'route' ? c.onward.best : null;
      const w = wholeOf(c);
      const room = roomOf(c);
      rows.push([
        c.rank, q(c.hub.id), q(c.hub.name), q(c.hub.number), q(roleText(c.hub)), c.km.toFixed(2), Math.round(((c.brg % 360) + 360) % 360),
        c.carries ? 'yes' : '', c.hub.isRep ? c.hub.f : '', f.failed ? '' : f1(f.margin), f.failed ? '' : q(f.verdict ? pathVerdictWord(f.verdict) : ''), q(f.failed || ''),
        q(c.onward && c.onward.kind === 'base' ? 'is a base' : r ? r.ids.map(nameOf).join(' > ') : 'none'),
        r ? r.hops.length : '', r && r.weakest ? f1(r.weakest.margin) : '', r ? r.unmodelled : '',
        f1(w.db), w.approx ? 'yes' : '', room ? room.free : '',
      ].join(','));
    }
    return rows.join('\n') + '\n';
  }

  // ── Copy for a report ───────────────────────────────────────────────────────
  // The answer as somebody writing it up needs it: the repeaters and bases the
  // panel lists — the best eight, or all of them once Show all is pressed —
  // a row each with every figure, the picked one's hops on to a base, how it
  // was worked out, and what the words mean, since the hover does not travel.
  // One press puts it on the clipboard twice, as path-profile.js's Copy for a
  // report does: a document (inline styles only, all Word and the mail
  // programs keep of a pasted page) and plain text with a tab between columns,
  // so the table pasted into a spreadsheet lands in cells. Whatever it is
  // pasted into takes the richer one it can. Both are written from one list of
  // rows (reportOf), so they cannot say different things. Save CSV stays the
  // one with every hub priced, in columns for a program.

  const TONE = { good: '#107c10', ok: '#9e5e00', bad: '#c7401a', none: '#4f6478' };

  // HTML to the words a person reads in it — verdictLine is written for the panel.
  function plain(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent.replace(/\s+/g, ' ').trim();
  }

  function bandWord(v) {
    const b = bandOfDb(v);
    return b === 'none' ? '' : (GLOSSARY.find(g => g[0] === b) || [b, b])[1];
  }

  function onwardText(c) {
    const o = c.onward;
    if (!o) return '';
    if (o.kind === 'base') return 'It is a base station — the readings arrive here.';
    if (o.kind === 'none') return `No route on to a base — no base within ${linkKm()} km of it, and no repeater it could hand on to.`;
    const r = o.best, n = r.hops.length;
    const via = r.ids.slice(1, -1).map(nameOf);
    const path = `${via.length ? `via ${via.join(' → ')} to ` : 'straight to '}${nameOf(r.ids[r.ids.length - 1])}`;
    const fig = r.complete
      ? `weakest hop ${dbText(r.weakest.margin)} (${bandWord(r.weakest.margin)})`
      : `${r.unmodelled} of ${n} hop${n === 1 ? '' : 's'} not worked out${r.weakest ? `, the rest no worse than ${dbText(r.weakest.margin)}` : ''}`;
    return `${path} · ${n} hop${n === 1 ? '' : 's'} · ${fig}`;
  }

  function reportOf() {
    if (!found || !results.length) return null;
    const s = found.site, h = found.here;
    const listed = showAll ? results : results.slice(0, SHOWN);
    const who = s.kind === 'point' ? `a new site at ${stationLatLonText(s)}` : `${s.name}${s.number ? ` (${s.number})` : ''}`;
    const stamp = new Date().toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
    const rows = listed.map(c => {
      const f = c.first && !c.first.failed ? c.first : null;
      const w = f ? wholeOf(c) : { db: null, approx: false };
      const room = roomOf(c);
      const notes = [];
      if (c.carries) notes.push('carries it now');
      if (room && !c.carries) notes.push(`${room.free} address${room.free === 1 ? '' : 'es'} free`);
      if (c.hub.isRep) notes.push(`listens on ${c.hub.f.toFixed(3)} MHz`);
      return {
        rank: c.rank,
        name: `${c.hub.name}${c.hub.number ? ` (${c.hub.number})` : ''}`,
        role: roleText(c.hub),
        where: `${c.km.toFixed(1)} km ${compass(c.brg)}`,
        hop: f ? f.margin : null,
        hopText: f ? `${dbText(f.margin)}${bandWord(f.margin) ? ` (${bandWord(f.margin)})` : ''}`
          : `not priced — ${c.first ? c.first.failed : 'not worked out'}`,
        los: f && f.verdict ? pathVerdictWord(f.verdict, false) : '—',
        onward: f ? onwardText(c) : '—',
        whole: w.db,
        wholeText: w.db == null ? (w.noRoute ? '— no route on' : '—') : `${w.approx ? '≈ ' : ''}${dbText(w.db)}`,
        notes: notes.join('; '),
      };
    });
    // The picked one's hops, as the panel's table under its row: the picked
    // one, else the best.
    const pick = results.find(c => c.hub.id === selectedId) || results[0];
    const r = pick.onward && pick.onward.kind === 'route' ? pick.onward.best : null;
    const pf = pick.first && !pick.first.failed ? pick.first : null;
    const srcText = x => (x.margin == null ? (x.stale ? 'stale' : 'not worked out') : x.src === 'saved' ? 'saved' : 'worked out in this browser');
    const hops = [[`${s.name} → ${pick.hub.name}`, pick.km.toFixed(1), pf ? pf.margin : null,
                   pf ? 'worked out here' : (pick.first ? pick.first.failed : '')]]
      .concat(r ? r.hops.map(x => [`${nameOf(x.from)} → ${nameOf(x.to)}`, x.km != null ? x.km.toFixed(1) : '—', x.margin, srcText(x)]) : []);
    const failed = found.cands.filter(c => c.first && c.first.failed).length;
    const how = [
      ['Station', s.kind === 'point' ? `A new site at ${stationLatLonText(s)}` : `${who} at ${stationLatLonText(s)}`],
      ['Radio at the station', `${h.sysName}${h.own ? '' : !h.common ? ' (picked for this search)' : ' (the network\'s commonest radio)'}, antenna ${h.agl} m above the ground`],
      ['Searched', `Every repeater and base within ${found.km} km — ${found.cands.length} priced${found.over ? `, the nearest ${MAX_HUBS}; ${found.over} more further out were left out` : ''}${
        failed ? `; ${failed} could not be priced` : ''}`],
      ['Ranked by', RANKS[rankMode()]],
      ['Fade margin', `Good ${goodDb()} dB or more · Ok ${okDb()} to ${goodDb()} dB · Poor under ${okDb()} dB`],
      ['Route on to a base', `Hops of at most ${linkKm()} km, at most ${MAX_REPEATERS} repeaters, the best route the agent API would pick`],
    ];
    if (found.missing.size) how.push(['Hops with no figure', `${found.missing.size} hop${found.missing.size === 1 ? '' : 's'} on to a base had no fade margin worked out yet; a whole way marked ≈ is the station's own hop alone`]);
    const w = words();
    return {
      heading: `Best repeater for ${who}`,
      sub: `Flood-Net, ${stamp} · ${listed.length < results.length ? `the best ${listed.length} of ${results.length} priced` : `all ${results.length} priced`}`,
      answer: plain(verdictLine()),
      rows, hops, how,
      hopsHeading: pick.onward && pick.onward.kind === 'base' ? `The hop from ${s.name} to ${pick.hub.name}`
        : `Every hop from ${s.name} through ${pick.hub.name} to a base`,
      words: GLOSSARY.map(([k, label]) => [label, w[k]]),
      caveat: CAVEAT,
      file: `best-repeater-${slug(s.name)}-${found.km}km`,
    };
  }

  const COLS = ['Rank', 'Repeater or base', 'Role', 'Distance', 'Its hop', 'Line of sight', 'On to base', 'Whole way', 'Notes'];

  function reportHtml(rep) {
    const font = 'font-family:Calibri,Arial,Helvetica,sans-serif;';
    const cell = 'border:1px solid #c8d1db;padding:3pt 6pt;vertical-align:top;text-align:left;';
    const headCell = `${cell}background:#eef3f8;font-weight:bold;`;
    const table = 'border-collapse:collapse;' + font + 'font-size:9.5pt';
    const h = t => `<h3 style="${font}font-size:12pt;color:#0b5cab;margin:14pt 0 4pt">${esc(t)}</h3>`;
    const fig = (v, text) => `<b style="color:${TONE[bandOfDb(v)]}">${esc(text)}</b>`;
    const pairs = list => `<table style="${table}" width="100%">${
      list.map(([l, v]) => `<tr><th style="${headCell}width:28%">${esc(l)}</th><td style="${cell}">${esc(v)}</td></tr>`).join('')}</table>`;
    const main = `<table style="${table}" width="100%">
      <tr>${COLS.map(t => `<th style="${headCell}">${esc(t)}</th>`).join('')}</tr>
      ${rep.rows.map(x => `<tr>
        <td style="${cell}text-align:right">${x.rank}</td>
        <td style="${cell}"><b>${esc(x.name)}</b></td>
        <td style="${cell}">${esc(x.role)}</td>
        <td style="${cell}white-space:nowrap">${esc(x.where)}</td>
        <td style="${cell}white-space:nowrap">${x.hop != null ? fig(x.hop, x.hopText) : esc(x.hopText)}</td>
        <td style="${cell}">${esc(x.los)}</td>
        <td style="${cell}">${esc(x.onward)}</td>
        <td style="${cell}white-space:nowrap">${x.whole != null ? fig(x.whole, x.wholeText) : esc(x.wholeText)}</td>
        <td style="${cell}">${esc(x.notes)}</td>
      </tr>`).join('')}
    </table>`;
    const hops = `<table style="${table}" width="100%">
      <tr><th style="${headCell}">Hop</th><th style="${headCell}text-align:right">km</th><th style="${headCell}">Fade margin</th><th style="${headCell}">Figure</th></tr>
      ${rep.hops.map(([l, k, m, src]) => `<tr><td style="${cell}">${esc(l)}</td><td style="${cell}text-align:right">${esc(k)}</td>
        <td style="${cell}white-space:nowrap">${m != null ? fig(m, dbText(m)) : '—'}</td><td style="${cell}">${esc(src)}</td></tr>`).join('')}
    </table>`;
    return `<div style="${font}font-size:10.5pt;color:#16202a">
      <h2 style="${font}font-size:15pt;margin:0 0 2pt">${esc(rep.heading)}</h2>
      <p style="${font}font-size:9.5pt;color:#4f6478;margin:0 0 8pt">${esc(rep.sub)}</p>
      <p style="${font}font-size:11pt;margin:0 0 8pt">${esc(rep.answer)}</p>
      ${main}
      ${h(rep.hopsHeading)}${hops}
      ${h('How it was worked out')}${pairs(rep.how)}
      ${h('What the words mean')}${pairs(rep.words)}
      <p style="${font}font-size:9.5pt;margin:8pt 0 0">${esc(rep.caveat)}</p>
    </div>`;
  }

  function reportText(rep) {
    const L = [rep.heading, rep.sub, '', rep.answer, '', COLS.join('\t')];
    rep.rows.forEach(x => L.push([x.rank, x.name, x.role, x.where, x.hopText, x.los, x.onward, x.wholeText, x.notes].join('\t')));
    L.push('', rep.hopsHeading.toUpperCase(), 'Hop\tkm\tFade margin\tFigure');
    rep.hops.forEach(([l, k, m, src]) => L.push(`${l}\t${k}\t${m != null ? dbText(m) : '—'}\t${src}`));
    L.push('', 'HOW IT WAS WORKED OUT');
    rep.how.forEach(([l, v]) => L.push(`${l}\t${v}`));
    L.push('', 'WHAT THE WORDS MEAN');
    rep.words.forEach(([l, v]) => L.push(`${l}\t${v}`));
    L.push('', rep.caveat);
    return L.join('\n') + '\n';
  }

  // The clipboard, the old way: a copy event that writes what it is given —
  // for a browser without the asynchronous clipboard, or one that refused it.
  function copyByEvent(html, text) {
    const put = e => {
      e.clipboardData.setData('text/html', html);
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    document.addEventListener('copy', put, true);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.removeEventListener('copy', put, true);
    return ok;
  }

  function copyReport() {
    const rep = reportOf();
    if (!rep) { Toast.show('Nothing to copy yet — find the best repeater first.'); return; }
    const html = reportHtml(rep), text = reportText(rep);
    const n = rep.rows.length;
    const done = () => Toast.show(`Copied: ${n === 1 ? 'the one repeater' : `the ${n} repeaters and bases`} listed, with every figure. `
      + 'Paste it into Word or an email — or a spreadsheet, where the table lands in cells.', { kind: 'done' });
    const write = navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined'
      ? (() => {
          try {
            return navigator.clipboard.write([new ClipboardItem({
              'text/html': new Blob([html], { type: 'text/html' }),
              'text/plain': new Blob([text], { type: 'text/plain' }),
            })]);
          } catch (e) { return Promise.reject(e); }
        })()
      : Promise.reject(new Error('no asynchronous clipboard'));
    write.then(done, () => {
      if (copyByEvent(html, text)) { done(); return; }
      // Neither way was allowed: the same document, saved, opens in Word.
      dlText(`${rep.file}.html`, `<!doctype html><meta charset="utf-8"><title>${esc(rep.heading)}</title>${html}`, 'text/html');
      Toast.show('The browser would not copy, so the report was saved as a file instead — it opens in Word.', { kind: 'note' });
    });
  }

  // ── The API ─────────────────────────────────────────────────────────────────

  return {
    attach(m) {
      map = m;
      if (!m.getPane(LINE_PANE)) { const p = m.createPane(LINE_PANE); p.style.zIndex = LINE_Z; p.style.pointerEvents = 'none'; }
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      // After the two finders that place things: those say where a mast or a
      // station should go, this which mast already standing a station should
      // talk to.
      MapChrome.panel(m, {
        id: 'bestrep', icon: '🎯', dockIcon: Glyphs.rail('bestrep'), title: 'Best repeater',
        btnLabel: 'Best repeater — which repeater or base a station is best heard by',
        group: 'tools', order: 27,
        html: () => panelHtml(),
        onMount(el) { body = el; },
      });
      m.on('click', onMapClick);
      draw();
    },

    detach() {
      if (job) {
        job.cancelled = true;
        job = null;
        if (!results.length) found = null;
        status = { kind: found ? 'done' : 'idle', text: '' };
      }
      if (map) { map.off('click', onMapClick); map.getContainer().classList.remove('mn-bestrep-picking'); }
      armed = false;
      clearLayers();
      body = null;
      map = null;
    },

    active() { return !!found && results.length > 0; },
    legendHtml,
    run,
    workMissing,

    cancel() {
      if (job) job.cancelled = true;
      job = null;
      if (!results.length) found = null;
      setStatus(found ? 'done' : 'idle', '');
      render();
    },

    // Reset's half (#191) and the panel's Clear: the station, the answer, all of it.
    clear() {
      invalidate();
      site = null; sysId = null; aglSet = null;
      hitQ = ''; pointQ = '';
      disarm();
      draw();
      render();
      rerenderMapLegend();
    },

    pickStation,
    pickPoint,

    // The station selected wherever it was selected (selectedStationId,
    // app.js): its card, its row, or the one station picked on the map.
    useCard() {
      const id = typeof selectedStationId === 'function' ? selectedStationId() : (state.stnCard && state.stnCard.id);
      if (!id) { if (map) mapNote('Select a station first — open its card, pick its row, or click its pin — then press this.', 5000); return; }
      pickStation(id);
    },
    useSelected() { return this.useCard(); },

    usePoint(text) {
      const p = parsePoint(text);
      if (!p) {
        pointQ = String(text || '');
        setStatus('blocked', 'Give the new site as latitude, longitude in decimal degrees — for example -27.4698, 153.0251.');
        return;
      }
      pickPoint(p.lat, p.lon);
      fitSite();
    },

    arm(on) {
      armed = on == null ? !armed : !!on;
      if (armed) {
        if (state.draw && state.draw.tool && typeof MapDraw !== 'undefined') MapDraw.setTool('');
        if (typeof LinkBudget !== 'undefined' && LinkBudget.setPicking) LinkBudget.setPicking(false);
        if (typeof MapMovePin !== 'undefined' && MapMovePin.armed && MapMovePin.armed()) MapMovePin.cancel();
        if (typeof MapHere !== 'undefined' && MapHere.armed && MapHere.armed()) MapHere.arm(false);
        if (typeof Places !== 'undefined' && Places.dropping && Places.dropping()) Places.arm(false);
      }
      syncArm();
      if (armed) announce('Pick on the map is armed. Click the map where the new station would stand.');
    },

    armed() { return armed; },

    // From the station card's Repeaters listening: this station, this panel.
    openFor(id) {
      const go = () => { pickStation(id); openPanel(); };
      if (state.activeTab === 'stations' && map) { go(); return; }
      if (typeof switchTab === 'function') switchTab('stations');
      let tries = 0;
      const step = () => { if (map && document.querySelector('.mn-mapctl[data-panel="bestrep"]')) go(); else if (++tries < 40) setTimeout(step, 100); };
      setTimeout(step, 60);
    },

    setSearch(v) {
      hitQ = String(v || '');
      const el = document.getElementById('bestrep-hits');
      if (el) el.innerHTML = hitsHtml();
    },

    select,

    toggleAll() { showAll = !showAll; draw(); render(); },

    flyTo(id) {
      const c = results.find(x => x.hub.id === id);
      if (!c || !map) return;
      map.panTo([c.hub.lat, c.hub.lon]);
      mapNote(`${c.hub.name} — ${stationLatLonText(c.hub)}`, 6000);
    },

    // The station's hop into the elevation profile and the link budget, the
    // way the other finders hand theirs over: a two-point line in Draw &
    // measure, reused if it is already there — the station's own id at its
    // end when it is in the register, so the card stands it on its surveyed
    // height.
    profile(id) {
      const c = results.find(x => x.hub.id === id);
      if (!c || !found) return;
      const pa = [found.site.lat, found.site.lon], pb = [c.hub.lat, c.hub.lon];
      // A new site is a point with no radio of its own: the one it was priced
      // with goes with it (radioPlace, path-profile.js), so the card works out
      // the same margin rather than none.
      if (!found.site.st && found.here) {
        radioPlace(found.site.lat, found.site.lon, found.here, { name: 'New station', by: 'Best repeater', f: c.hub.f });
      }
      if (state.mapFullscreen && typeof toggleMapFullscreen === 'function') toggleMapFullscreen(false);
      state.path.open = true;
      const existing = MapDraw.findLine(pa, pb);
      if (existing) MapDraw.focus(existing.id);
      else MapDraw.addLine([pa, pb], [found.site.id, c.hub.id]);
      const el = document.getElementById('path-profile-panel');
      if (el) {
        if (typeof dockReveal === 'function') dockReveal(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      const where = typeof stationsCardsWhere === 'function' ? stationsCardsWhere() : 'with the station cards';
      mapNote(`Profiling ${found.site.name} → ${c.hub.name} — the card is ${where}.`, 5000);
    },

    // The ALERT IDs tab's Allocate card, set to this repeater.
    allocate(id) {
      if (typeof switchTab !== 'function' || typeof AddressSpace === 'undefined') return;
      switchTab('passranges');
      let tries = 0;
      const step = () => {
        if (document.getElementById('as-alloc')) { AddressSpace.allocateIn('rep:' + id); return; }
        if (++tries < 40) setTimeout(step, 100);
      };
      setTimeout(step, 60);
    },

    save() {
      const text = csvText();
      if (!text) return;
      dlText(`floodnet-best-repeater-${slug(found.site.name)}-${found.km}km.csv`, text);
    },

    csvText,
    copyReport,
    // The two the button puts on the clipboard, for the checks.
    reportText() { const rep = reportOf(); return rep ? reportText(rep) : ''; },
    reportHtml() { const rep = reportOf(); return rep ? reportHtml(rep) : ''; },

    // One setter for every other control on the panel. An empty box means
    // "follow the default", not nought.
    set(key, value) {
      const asNum = v => { const s = String(v).trim(); return s === '' ? null : (isFinite(+s) ? +s : null); };
      switch (key) {
        case 'rank':
          if (!RANKS[value]) return;
          cfg.rank = value; save();
          if (found) { rank(); draw(); render(); rerenderMapLegend(); }
          return;
        case 'km': { const v = asNum(value); cfg.km = v == null ? DEF_KM : Math.max(MIN_KM, Math.min(MAX_KM, v)); save(); break; }
        case 'sys': sysId = String(value || '') === '' ? null : value; break;
        case 'agl': { const v = asNum(value); aglSet = v != null && v > 0 ? Math.min(60, v) : null; break; }
        default: return;
      }
      invalidate();
      draw();
      render();
      rerenderMapLegend();
    },

    // For the checks, and for anybody at the console.
    site() { const s = siteNow(); return s ? { kind: s.kind, id: s.id, name: s.name, lat: s.lat, lon: s.lon } : null; },
    status() { return { ...status }; },
    radio() { const s = siteNow(), h = s ? hereRadio(s) : null; return h ? { ...h } : null; },
    choices() { const s = siteNow(); return s ? hubChoices(s).list.map(x => ({ id: x.s.id, km: x.km, carries: x.carries })) : []; },
    missing() { return found ? [...found.missing.values()].map(h => ({ from: h.from, to: h.to, stale: h.stale })) : []; },
    results() {
      return results.map(c => {
        const r = c.onward && c.onward.kind === 'route' ? c.onward.best : null;
        const w = wholeOf(c);
        return {
          rank: c.rank, id: c.hub.id, name: c.hub.name, km: c.km, carries: c.carries,
          isBase: c.hub.isBase, isRep: c.hub.isRep, f: c.hub.f, agl: c.hub.rad ? c.hub.rad.agl : null,
          first: c.first ? { ...c.first } : null,
          onward: !c.onward ? null : c.onward.kind !== 'route' ? { kind: c.onward.kind }
            : { kind: 'route', ids: r.ids.slice(), complete: r.complete, unmodelled: r.unmodelled,
                weakest: r.weakest ? r.weakest.margin : null, hops: r.hops.map(h => ({ ...h })), routes: c.onward.routes },
          whole: w.db, approx: w.approx, noRoute: !!w.noRoute,
        };
      });
    },
    selected() { return selectedId; },
    drawn() { return { lines: lineLayer, pins: layer }; },
  };
})();
if (typeof window !== 'undefined') window.MapBestRepeater = MapBestRepeater;
