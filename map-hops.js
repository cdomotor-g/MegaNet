// MegaNet — map-hops.js
//
//   MapHops   🪜 Hops to base: the way one station's readings travel to the
//             base stations, hop by hop, lit on the Stations map. Pressed on
//             the station card, it draws the station, every repeater its
//             readings pass through and the base stations they end at, and
//             the radio paths between them — and fades everything else. A
//             card among the Stations cards (#hops-card) lists each route,
//             hop by hop, with what says so.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, fmtKm, acmaHaversineKm,
// cssVar, announce and termHtml; across to app.js for stationAlertIds,
// applyMapFocusStyles, applyMapLabels, rerenderMapLegend, repaintStnCard,
// mapNote, stationsCardsWhere, stationsCardsArrow and dockReveal; to
// map-backbone.js for repeaterOpenWindows; to map-fade.js for MapFade.known; to
// signal-routes.js for SignalRoutes.register and attribute (whose carrier); to
// datastore.js for dbSelect; and to auth.js for Auth. All of it from inside its
// own functions — the IIFE body only declares — so this file's position among
// the modules is free (`npm run toplevel`). initMap() attaches it,
// stopStationsMap() detaches it, applyMapFocusStyles() asks it which stations
// to keep lit, repaintStnCard() tells it which station the card is on, and ↺
// and 🧹 clear it.
//
// ── The question this answers ────────────────────────────────────────────────
// "How does this station get home?" The map already draws every pass-range
// link and every backbone path, and a station's way to a base is somewhere in
// that tangle — but it is three or four lines among three thousand, and which
// three or four is the question. So this picks them out, for the station the
// card is on, and says of each hop whether anything received backs it up.
//
// ── The routes: the map's own rules, walked ─────────────────────────────────
// worker/radio-path.js's walk, which map-bestrep.js walks too, over the station
// file in memory — nothing new is decided about who hears whom:
//
//   first hop   a repeater whose pass ranges carry one of the station's ALERT
//               addresses, exclusions honoured — the nearest MAX_FIRST within
//               FIRST_KM, and every one heard relaying it however far down
//               that list. A station that is a repeater starts from itself.
//   on          a repeater within the map's Max TX distance whose open windows
//               take some of what the one before passed on, or any base
//               station within it, where the route ends. At most four
//               repeaters, never a station twice, and only the fewest
//               repeaters that reach a base from each first hop: the longer
//               orders of the same masts are not the way a reading is expected
//               home, and drawn they are the spaghetti this exists to cut.
//
// From each first hop PER_START routes are kept, the best first: the most hops
// heard, the fewest not heard, then the agent API's best (every hop's fade
// margin known, the strongest weakest hop, the fewest hops, the shortest).
//
// ── Heard, assumed, not heard ────────────────────────────────────────────────
// Each hop is drawn by what is known of it — the words ⏱️ Latency's pulses use:
//
//   Heard      something received says the readings took it.
//                Into a repeater: relay_summary (0092, public) — the base
//                stations heard that repeater relay one of the station's
//                addresses on its own carrier in the last seven days, or put
//                that way by the receivers' copies below. The readings reached
//                it, so the hop drawn into it from the station is heard — or,
//                when there is none, the one from a repeater heard relaying it
//                too.
//                Into a base station: the receivers' copies of the station's
//                readings over the last HEARD_H hours (meganet.reception,
//                editors only, 0047), each put to its transmitter by 0077's
//                rule (SignalRoutes.register and attribute, step for step, as
//                ⏱️ Latency does): a copy on a repeater's carrier is that
//                repeater to that base station heard; one on no repeater's is
//                the station heard direct, unless its carrier is one many
//                addresses share there (a relay nobody could name, which proves
//                nothing); an ALERT2 path names every hop.
//   Assumed    from the pass ranges and backbone paths alone.
//   Not heard  a first hop into a repeater whose pass ranges carry the
//              address but which, where its carrier was found in the last
//              seven days, was heard bringing it in another way
//              (relay_summary's `elsewhere`) and never on its own carrier.
//
// A hop heard but not on any route walked — a base station hearing the
// station direct, a repeater whose carrier a base station heard it on with no
// backbone path between them — is added and drawn straight, pin to pin.
//
// ── What it is not ───────────────────────────────────────────────────────────
// A record of one reading's way. The relay week says a repeater carried the
// station's readings, not which ones or to whom; the copies say which base
// station heard which last transmitter, not the hops before it; and an assumed
// hop is the register's opinion. Frequencies are not matched, as the map does
// not match them.

const MapHops = (function () {
  // Over the network's links (400), their arrowheads (405) and 🎯's lines
  // (408), under the cameras (415) and the popups (700): the lit routes are the
  // answer, and the faded network has to be read through, not over, them.
  const LINE_PANE = 'mnHopLines', LINE_Z = 409;

  const FIRST_KM      = 150;   // worker/radio-path.js: relayed_by, the nearest within 150 km
  const MAX_FIRST     = 6;     // first repeaters walked on from, nearest first
  const PER_START     = 3;     // routes kept from each
  const MAX_REPEATERS = 4;     // delay-plan.js maxHops, worker/radio-path.js MAX_REPEATERS
  const ROUTE_CAP     = 600;   // routes weighed from one first hop
  const SHOWN         = 12;    // routes listed before "Show all"

  const MIN = 60e3, HOUR = 60 * MIN;
  const RELAY_TTL = 15 * MIN;  // relay_summary is rebuilt hourly
  const HEARD_H   = 12;        // the receivers' copies looked back over — ⏱️ Latency's CARRIER_H
  const COPIES_TTL = 5 * MIN;
  const PAGE = 1000, MAX_PAGES = 6, MAX_RX = 6, PARALLEL = 3;
  const RX_SELECT      = 'id,ingest_token_id,point_id,heard_at,protocol,alert_id,cfo_hz,a2_duplicate,a2_source,a2_path';
  const RX_WARM_SELECT = 'id,ingest_token_id,point_id,heard_at,alert_id,cfo_hz,a2_duplicate';
  // map-latency.js's SHARED_*, and for its reason: a burst no named repeater
  // claims is the station's own only off a carrier many addresses share there.
  const SHARED_HZ = 30, SHARED_MS = 90 * MIN, SHARED_MIN = 4, SHARED_SHARE = 0.3;

  // A hop by what is known of it: its word, the colour token it is drawn in
  // (with the literal a theme that lacks it falls back to) and its pattern, so
  // the colour is never the only thing that tells them apart — heard solid,
  // assumed dashed, not heard dotted. `rank` decides a hop two routes disagree
  // on.
  const KINDS = {
    heard:   { word: 'Heard',     token: '--map-hop-heard',   fallback: '#14b84a', dash: null,  weight: 5,   rank: 3 },
    assumed: { word: 'Assumed',   token: '--map-hop-assumed', fallback: '#2f7fe0', dash: '9 6', weight: 4,   rank: 2 },
    missed:  { word: 'Not heard', token: '--map-hop-missed',  fallback: '#e53935', dash: '2 7', weight: 3.5, rank: 1 },
  };
  const KIND_KEYS = ['heard', 'assumed', 'missed'];

  let map = null, lineLayer = null;
  let onId = null;           // the station the hops are lit for, or null
  let plan = null;           // what was worked out for it
  let planKey = '';
  let pickedRoute = null;    // a route's key, picked in the card
  let showAll = false;

  // relay_summary (0092): a row a repeater, the server's last seven days.
  const RL = { phase: 'idle', at: 0, err: '', missing: false, byId: new Map(), judged: null, seq: 0 };
  // The receivers' copies of one station's readings (editors).
  const RX = { phase: 'off', id: null, at: 0, err: '', seq: 0, copies: 0, receivers: 0, paths: [] };

  // ── Small things ────────────────────────────────────────────────────────────

  const stations = () => (state.data && state.data.stations) || [];
  const byId = id => stations().find(s => s.id === id) || null;
  const placed = s => !!s && s.lat != null && s.lon != null;
  const isRep = s => !!s && Array.isArray(s.roles) && s.roles.includes('repeater') && !!s.repeater;
  const isBase = s => !!s && Array.isArray(s.roles) && s.roles.includes('base');
  const kmOf = (a, b) => (placed(a) && placed(b) ? acmaHaversineKm(a.lat, a.lon, b.lat, b.lon) : null);
  const linkKm = () => (state.mapMaxLinkKm > 0 ? state.mapMaxLinkKm : 100);
  const now_ = () => Date.now();
  const iso = t => encodeURIComponent(new Date(t).toISOString());
  const errText = err => (err && err.message) || String(err || 'unknown error');
  const isDenied = err => !!err && (err.status === 401 || err.status === 403 || err.status === 404);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const colour = k => cssVar(KINDS[k].token, KINDS[k].fallback);
  // Worth asking for the copies: signed in, and not an account that may only
  // read. The database decides (reception is editors' only, 0047) — this only
  // spares a visitor the asking. ⏱️ Latency's rxMay.
  const rxMay = () => typeof Auth !== 'undefined' && Auth.isSignedIn() && (!Auth.mayWrite || Auth.mayWrite());

  function addrsOf(s) {
    try { return stationAlertIds(s) || []; } catch (_) { return []; }
  }

  // What a station has that a route could start from: a repeater starts from
  // itself, a field station from its ALERT addresses, and an ALERT2 station
  // has its paths, heard. A base is where routes end, and has none.
  function canShow(s) {
    if (!s || isBase(s)) return false;
    return isRep(s) || addrsOf(s).length > 0 || s.alert2_station_id != null;
  }

  // ── The words ───────────────────────────────────────────────────────────────
  // One list, read by the key, the headings, the hover on each hop and the fold
  // that says them without a hover (docs/design-system.md, "Words that mean
  // something here").

  function words() {
    const K = linkKm();
    return {
      heard: 'A hop something received says the readings took. Into a repeater: the base stations heard that repeater relay '
        + 'this station\'s address on its own carrier in the last seven days. Into a base station: one of its receivers heard '
        + `the readings on the carrier of the station or repeater at the other end in the last ${HEARD_H} hours, or an ALERT2 `
        + 'path names the hop — read from the receivers\' copies, which are for editors.',
      assumed: 'A hop the readings most likely take, from the register alone — nothing received says so either way: a repeater '
        + `whose pass ranges carry the station's address, then on along the backbone to a repeater within ${K} km whose pass `
        + `ranges take the same addresses, or to a base station within ${K} km.`,
      missed: 'A repeater whose pass ranges carry this station\'s address, but which was not heard relaying it: where its '
        + 'carrier was found in the last seven days, the address came in another way.',
      route: 'One way from the station to a base station: the station first, each repeater its readings pass through, and the '
        + 'base station whose receivers take them into Flood-Net last.',
      repeaters: 'How many repeaters the readings pass through on this route before a base station hears them. None means a '
        + 'base station hears the station itself.',
      distance: 'Under each route, its length over the ground, hop by hop, in a straight line between the antennas.',
      weakest: 'The fade margin of the route\'s weakest hop, one way, as the fade margin layer has it: how many decibels the '
        + 'signal arrives above what the receiver needs. A dash where a hop on it has not been worked out — Layers, Colour '
        + 'links by fade margin, works them out.',
      relay: 'The last seven days of what each repeater was heard relaying on its own carrier, put together every hour from '
        + 'every base station\'s receptions. Anybody may read it: it names no receiver.',
    };
  }

  const GLOSSARY = [
    ['heard', 'Heard'], ['assumed', 'Assumed'], ['missed', 'Not heard'],
    ['route', 'Route'], ['repeaters', 'Repeaters'], ['distance', 'Distance'], ['weakest', 'Weakest hop'],
    ['relay', 'Relay week'],
  ];

  function term(k, text) {
    return termHtml(text || (GLOSSARY.find(g => g[0] === k) || [k, k])[1], words()[k]);
  }

  function glossaryHtml() {
    const w = words();
    return `<details class="hops-words"><summary>What the words on this card mean</summary>
      <dl>${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(w[k])}</dd>`).join('')}</dl>
    </details>`;
  }

  // ── The register as the walk needs it ───────────────────────────────────────

  function topology() {
    const nodes = new Map();
    for (const x of stations()) {
      if (!placed(x) || !Array.isArray(x.roles)) continue;
      const b = isBase(x), r = isRep(x);
      if (!b && !r) continue;
      let windows = [];
      if (r) { try { windows = repeaterOpenWindows(x.repeater) || []; } catch (_) { windows = []; } }
      nodes.set(x.id, { id: x.id, s: x, lat: x.lat, lon: x.lon, isBase: b, isRep: r, windows });
    }
    const all = [...nodes.values()];
    // A base that is a repeater too is where a route ends, never a repeater on
    // the way — the agent API's topology, and for its reason.
    return { nodes, reps: all.filter(n => n.isRep && !n.isBase), bases: all.filter(n => n.isBase),
             firsts: all.filter(n => n.isRep), near: new Map() };
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

  const covers = (node, a) => node.windows.some(([lo, hi]) => lo <= a && a <= hi);

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

  // Every route from one first hop to a base, as station ids, the first hop
  // first and the base last: a level at a time, at most MAX_REPEATERS
  // repeaters, and none longer than the fewest that reach a base.
  function routesFrom(T, start, carried) {
    if (start.isBase) return [[start.id]];
    const out = [];
    let fewest = null;
    const toBases = q => {
      for (const { node: b } of nearOf(T, T.nodes.get(q.path[q.path.length - 1])).bases) {
        if (out.length >= ROUTE_CAP) return false;
        out.push(q.path.concat(b.id));
        if (fewest == null) fewest = q.path.length;
      }
      return true;
    };
    const deeper = q => q.path.length < MAX_REPEATERS && (fewest == null || q.path.length < fewest);
    const first = { path: [start.id], carried };
    if (!toBases(first)) return out;
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
          if (!toBases(c)) return out;
          if (deeper(c)) next.push(c);
        }
      }
      level = next;
    }
    return out;
  }

  // ── What was heard: the relay week (public) ─────────────────────────────────

  // relay_summary's row as Repeaters' relayX weighs it (repeaters.js): its
  // off-record addresses count as relayed on two copies or more on its
  // carrier, or one, or nearly every burst of it on its carrier; less is a
  // stray and says nothing.
  function relayOf(row) {
    const arr = k => (Array.isArray(row[k]) ? row[k].map(Number) : []);
    const relayed = new Set(arr('relayed'));
    const off = arr('off_record'), dup = arr('off_dup'), own = arr('off_own'), all = arr('off_all');
    const offrec = new Set();
    off.forEach((a, i) => {
      const d = dup[i] || 0, o = own[i] || 0, n = all[i] || 0;
      if (d >= 1 || (o >= 3 && o >= 0.8 * Math.max(1, n))) offrec.add(a);
    });
    return { relayed, offrec, elsewhere: new Set(arr('elsewhere')), days: Number(row.days) || 0 };
  }

  async function ensureRelay() {
    if (typeof dbSelect !== 'function') return;
    if (RL.phase === 'loading') return;
    if ((RL.phase === 'ok' || RL.phase === 'none') && now_() - RL.at < RELAY_TTL) return;
    if (RL.phase === 'error' && now_() - RL.at < MIN) return;
    const seq = ++RL.seq;
    RL.phase = 'loading';
    repaint();
    try {
      const rows = await dbSelect('relay_summary?select=station_id,days,relayed,off_record,off_dup,off_own,off_all,elsewhere,'
        + 'window_days,judged_at&order=station_id.asc&limit=1000');
      if (seq !== RL.seq) return;
      RL.byId = new Map((rows || []).filter(r => r && r.station_id).map(r => [r.station_id, relayOf(r)]));
      RL.judged = (rows || []).reduce((t, r) => (r.judged_at && (!t || r.judged_at > t) ? r.judged_at : t), null);
      Object.assign(RL, { phase: RL.byId.size ? 'ok' : 'none', at: now_(), err: '', missing: false });
    } catch (err) {
      if (seq !== RL.seq) return;
      // A database before 0092 has no such table; an answer that may not read
      // it is the same nothing.
      RL.byId = new Map();
      Object.assign(RL, { phase: isDenied(err) ? 'none' : 'error', at: now_(), err: errText(err), missing: isDenied(err) });
    }
    planKey = '';
    sync();
  }

  // The repeaters heard relaying any of `addrs`, and those heard bringing them
  // in another way and never relaying them.
  function relayEvidence(addrs) {
    const relayed = new Map(), elsewhere = new Set();
    if (!addrs.length) return { relayed, elsewhere };
    RL.byId.forEach((x, rid) => {
      const hit = addrs.filter(a => x.relayed.has(a) || x.offrec.has(a));
      if (hit.length) relayed.set(rid, { addrs: hit, off: hit.some(a => !x.relayed.has(a)) });
      else if (addrs.some(a => x.elsewhere.has(a))) elsewhere.add(rid);
    });
    return { relayed, elsewhere };
  }

  // ── What was heard: the receivers' copies (editors) ─────────────────────────

  async function pages(path, seq) {
    const out = [];
    for (let after = null, n = 0; n < MAX_PAGES; n++) {
      const page = await dbSelect(`${path}${after != null ? `&id=gt.${after}` : ''}&order=id.asc&limit=${PAGE}`);
      if (seq !== RX.seq) return out;
      out.push(...(page || []));
      if (!page || page.length < PAGE) break;
      after = page[page.length - 1].id;
    }
    return out;
  }

  async function inBatches(list, fn) {
    const out = [];
    for (let i = 0; i < list.length; i += PARALLEL) out.push(...await Promise.all(list.slice(i, i + PARALLEL).map(fn)));
    return out;
  }

  // A burst no named repeater claims sits on a carrier many other addresses
  // share at its receiver around then: a relay, named or not (map-latency.js
  // onShared).
  function onShared(list, b) {
    const all = new Set(), near = new Set();
    for (const x of list) {
      if (x.a === b.a || Math.abs(x.t - b.t) > SHARED_MS) continue;
      all.add(x.a);
      if (Math.abs(x.cfo - b.cfo) <= SHARED_HZ) near.add(x.a);
    }
    return near.size >= SHARED_MIN && near.size >= SHARED_SHARE * all.size;
  }

  // The station's copies over the last HEARD_H hours, each put to the hops it
  // proves: RX.paths, [{ ids: [...station ids, the base last], n, last }].
  async function ensureCopies(st) {
    if (typeof dbSelect !== 'function') return;
    if (!rxMay()) {
      if (RX.phase !== 'off') Object.assign(RX, { phase: 'off', id: null, paths: [], copies: 0, receivers: 0 });
      return;
    }
    if (RX.id === st.id && RX.phase === 'loading') return;
    if (RX.id === st.id && (RX.phase === 'ok' || RX.phase === 'none') && now_() - RX.at < COPIES_TTL) return;
    if (RX.id === st.id && RX.phase === 'error' && now_() - RX.at < MIN) return;
    const seq = ++RX.seq;
    Object.assign(RX, { phase: 'loading', id: st.id, err: '', paths: [], copies: 0, receivers: 0 });
    repaint();
    const t1 = now_(), t0 = t1 - HEARD_H * HOUR;
    const addrs = addrsOf(st);
    const a2 = st.alert2_station_id != null ? Number(st.alert2_station_id) : null;
    try {
      const asks = [];
      if (addrs.length) {
        asks.push(dbSelect(`reception?select=${RX_SELECT}&ok=is.true&alert_id=in.(${addrs.join(',')})`
          + `&heard_at=gte.${iso(t0)}&order=id.desc&limit=${PAGE}`));
      }
      if (a2 != null && Number.isFinite(a2)) {
        asks.push(dbSelect(`reception?select=${RX_SELECT}&ok=is.true&protocol=eq.alert2&a2_source=eq.${a2}`
          + `&heard_at=gte.${iso(t0)}&order=id.desc&limit=${PAGE}`));
      }
      const [points, ...got] = await Promise.all([
        dbSelect('ingest_point_latest?select=ingest_token_id,point_id,host_station_id&order=point_id.asc&limit=1000'),
        ...asks,
      ]);
      if (seq !== RX.seq) return;
      const seen = new Set();
      const copies = [];
      for (const list of got) for (const r of list || []) if (!seen.has(r.id)) { seen.add(r.id); copies.push(r); }
      const host = new Map((points || []).map(p => [p.ingest_token_id + '|' + p.point_id, p.host_station_id || null]));
      if (!copies.length) {
        Object.assign(RX, { phase: (points || []).length ? 'ok' : 'none', at: now_(), copies: 0, receivers: 0, paths: [] });
        planKey = ''; sync();
        return;
      }

      // Each receiver that took a measured legacy copy: its window of
      // measured bursts, every address's, to find its repeater carriers in.
      const pkOf = r => r.ingest_token_id + '|' + r.point_id;
      const legacy = copies.filter(r => r.protocol !== 'alert2' && r.alert_id != null && r.cfo_hz != null && isFinite(Number(r.cfo_hz)));
      const tally = new Map();
      legacy.forEach(r => tally.set(pkOf(r), (tally.get(pkOf(r)) || 0) + 1));
      const pks = [...tally.keys()].sort((p, q) => tally.get(q) - tally.get(p)).slice(0, MAX_RX);
      const windows = await inBatches(pks, async pk => {
        const [tok, ...rest] = pk.split('|');
        const pid = rest.join('|');
        const rows = await pages(`reception?select=${RX_WARM_SELECT}&protocol=eq.alert&ok=is.true&cfo_hz=not.is.null`
          + `&ingest_token_id=eq.${encodeURIComponent(tok)}&point_id=eq.${encodeURIComponent(pid)}&heard_at=gte.${iso(t0)}`, seq);
        return [pk, rows];
      });
      if (seq !== RX.seq) return;

      const reg = typeof SignalRoutes !== 'undefined' && SignalRoutes.register ? SignalRoutes.register() : null;
      const burstOf = new Map();          // reception id → its burst, attributed
      const listOf = new Map();
      for (const [pk, rows] of windows) {
        const list = (rows || []).filter(r => r.alert_id != null && isFinite(Number(r.cfo_hz)))
          .map(r => ({ id: r.id, a: Number(r.alert_id), cfo: Number(r.cfo_hz), dup: !!r.a2_duplicate,
                       t: Date.parse(r.heard_at), how: 'unmeasured', rid: null }));
        // The station's own copies are in the window by construction, but the
        // window's pages may stop short of them on a very busy receiver.
        const have = new Set(list.map(b => b.id));
        for (const r of legacy) {
          if (pkOf(r) !== pk || have.has(r.id)) continue;
          list.push({ id: r.id, a: Number(r.alert_id), cfo: Number(r.cfo_hz), dup: !!r.a2_duplicate,
                      t: Date.parse(r.heard_at), how: 'unmeasured', rid: null });
        }
        if (reg) { try { SignalRoutes.attribute(list, reg); } catch (_) { /* nothing attributed */ } }
        list.forEach(b => burstOf.set(b.id, b));
        listOf.set(pk, list);
      }

      // What each copy proves (map-latency.js proofOf).
      const a2Station = new Map();
      for (const s of stations()) if (s.alert2_station_id != null) a2Station.set(Number(s.alert2_station_id), s.id);
      const paths = new Map();
      const add = (ids, t) => {
        if (ids.some(x => !x) || ids.length < 2) return;
        for (let i = 1; i < ids.length; i++) if (ids[i] === ids[i - 1]) return;
        const k = ids.join('>');
        const p = paths.get(k) || { ids, n: 0, last: 0 };
        p.n++; p.last = Math.max(p.last, t || 0);
        paths.set(k, p);
      };
      const receivers = new Set();
      for (const c of copies) {
        const pk = pkOf(c), base = host.get(pk) || null;
        if (!base) continue;
        const t = Date.parse(c.heard_at);
        if (c.protocol === 'alert2' && c.a2_source != null) {
          const chain = [Number(c.a2_source)].concat(Array.isArray(c.a2_path) ? c.a2_path.map(Number) : []).map(x => a2Station.get(x) || null);
          // An ALERT2 PDU carrying a legacy address is a concentrator's: the
          // station's own hop into it is assumed, the rest named.
          const ids = (c.alert_id != null ? [st.id] : []).concat(chain);
          if (ids[0] !== st.id) continue;
          if (ids[ids.length - 1] !== base) ids.push(base);
          add(ids, t);
          receivers.add(pk);
          continue;
        }
        const b = burstOf.get(c.id);
        if (!b) continue;
        if (b.how === 'repeater' && b.rid) {
          add(b.rid === st.id ? [st.id, base] : [b.rid, base], t);
          receivers.add(pk);
        } else if (b.how === 'own' && !onShared(listOf.get(pk) || [], b)) {
          add([st.id, base], t);
          receivers.add(pk);
        }
      }
      Object.assign(RX, { phase: 'ok', at: now_(), copies: copies.length, receivers: new Set(copies.map(pkOf)).size,
                          proved: receivers.size, paths: [...paths.values()] });
    } catch (err) {
      if (seq !== RX.seq) return;
      Object.assign(RX, { phase: isDenied(err) ? 'none' : 'error', at: now_(), err: errText(err), paths: [] });
    }
    planKey = '';
    sync();
  }

  // ── The plan ────────────────────────────────────────────────────────────────

  // One hop's fade margin, as the fade margin layer has it — never one
  // invented here.
  function hopFig(cache, fromId, toId) {
    const k = `${fromId}>${toId}`;
    if (cache.has(k)) return cache.get(k);
    const a = byId(fromId), b = byId(toId);
    let fig = null;
    try { fig = typeof MapFade !== 'undefined' && a && b ? MapFade.known(a, b) : null; } catch (_) { fig = null; }
    const out = { from: fromId, to: toId, km: kmOf(a, b), margin: fig && fig.margin != null ? fig.margin : null };
    cache.set(k, out);
    return out;
  }

  function build(st) {
    const out = { id: st.id, name: st.name, kind: 'none', routes: [], edges: new Map(), nodes: new Map(), bases: new Set(),
                  starts: 0, relayHeard: [], note: '' };
    if (!placed(st)) { out.kind = 'unplaced'; return out; }
    if (isBase(st)) { out.kind = 'base'; return out; }
    const T = topology();
    const addrs = addrsOf(st);
    const ev = relayEvidence(addrs);
    out.relayWeek = [...ev.relayed.keys()];
    // Every hop the copies prove, and every repeater they show relaying it.
    const proved = new Set();
    for (const p of RX.id === st.id ? RX.paths : []) {
      for (let i = 1; i < p.ids.length; i++) proved.add(`${p.ids[i - 1]}>${p.ids[i]}`);
      for (const x of p.ids.slice(0, -1)) if (x !== st.id && !ev.relayed.has(x)) ev.relayed.set(x, { addrs: [], off: false, copies: true });
    }

    // The first hops: what the station's addresses are open to, nearest first,
    // and every repeater heard relaying it (off its pass ranges too).
    let starts = [];
    if (isRep(st)) {
      const self = T.nodes.get(st.id);
      if (self) starts.push({ node: self, carried: self.windows, self: true });
      out.kind = 'repeater';
    } else {
      out.kind = 'field';
      const cands = T.firsts.filter(n => n.id !== st.id)
        .map(n => ({ node: n, passes: addrs.filter(a => covers(n, a)), km: acmaHaversineKm(st.lat, st.lon, n.lat, n.lon) }))
        .filter(c => c.passes.length)
        .sort((a, b) => a.km - b.km || (a.node.id < b.node.id ? -1 : 1));
      const near = cands.filter(c => c.km <= FIRST_KM);
      const keep = near.slice(0, MAX_FIRST);
      for (const c of cands) if (ev.relayed.has(c.node.id) && !keep.includes(c)) keep.push(c);
      // Heard relaying it with no pass range on record that carries it: the
      // record is wrong, or the radio is — and the hop is real either way.
      ev.relayed.forEach((x, rid) => {
        if (keep.some(c => c.node.id === rid)) return;
        const n = T.nodes.get(rid);
        if (n && n.isRep && x.addrs.length) keep.push({ node: n, passes: x.addrs, km: acmaHaversineKm(st.lat, st.lon, n.lat, n.lon), offRecord: true });
      });
      starts = keep.map(c => ({ node: c.node, carried: c.passes.map(a => [a, a]), offRecord: !!c.offRecord }));
      out.carriers = cands.length;
      out.farCarriers = cands.length - near.length;
    }
    out.starts = starts.length;
    out.relayHeard = [...ev.relayed.keys()];

    // A hop's state before the routes are chosen: proved, or into a repeater
    // heard relaying it from the station or from another heard repeater.
    const prelim = (from, to) => {
      if (proved.has(`${from}>${to}`)) return 'heard';
      const n = T.nodes.get(to);
      if (n && n.isRep && ev.relayed.has(to) && (from === st.id || ev.relayed.has(from))) return 'heard';
      if (n && n.isRep && from === st.id && ev.elsewhere.has(to) && !ev.relayed.has(to)) return 'missed';
      return 'assumed';
    };
    const cache = new Map();
    const weigh = (ids, extra) => {
      const hops = [];
      for (let i = 1; i < ids.length; i++) hops.push(hopFig(cache, ids[i - 1], ids[i]));
      let heard = 0, missed = 0, unknown = 0, weakest = null, km = 0;
      hops.forEach(h => {
        const k = prelim(h.from, h.to);
        if (k === 'heard') heard++; else if (k === 'missed') missed++;
        km += h.km || 0;
        if (h.margin == null) unknown++; else if (!weakest || h.margin < weakest.margin) weakest = h;
      });
      return { ids, hops, heard, missed, unknown, weakest, km, extra: !!extra, key: ids.join('>') };
    };
    const better = (a, b) => (b.heard - a.heard) || (a.missed - b.missed) || (a.unknown - b.unknown)
      || ((b.weakest ? b.weakest.margin : -Infinity) - (a.weakest ? a.weakest.margin : -Infinity))
      || (a.hops.length - b.hops.length) || (a.km - b.km) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

    const kept = new Map();
    for (const s0 of starts) {
      const walked = routesFrom(T, s0.node, s0.carried);
      const lead = s0.self ? [] : [st.id];
      const weighed = walked.map(ids => weigh(lead.concat(ids))).sort(better).slice(0, PER_START);
      for (const r of weighed) if (!kept.has(r.key)) kept.set(r.key, r);
    }
    // What the copies prove and no route walked takes: drawn straight.
    const routes = [...kept.values()];
    const hasHop = k => routes.some(r => r.ids.some((x, i) => i > 0 && `${r.ids[i - 1]}>${x}` === k));
    for (const p of RX.id === st.id ? RX.paths : []) {
      const k = p.ids.slice(-2).join('>');
      if (hasHop(k) && (p.ids[0] !== st.id || routes.some(r => r.key === p.ids.join('>')))) continue;
      let ids = p.ids;
      if (ids[0] !== st.id) {
        // A repeater heard at a base: the way to it as a route walked has it,
        // else from the station straight to it.
        const via = routes.filter(r => r.ids.includes(ids[0])).sort((a, b) => a.ids.indexOf(ids[0]) - b.ids.indexOf(ids[0]))[0];
        ids = (via ? via.ids.slice(0, via.ids.indexOf(ids[0])) : [st.id]).concat(ids);
      }
      if (new Set(ids).size !== ids.length) continue;
      const r = weigh(ids, true);
      if (!kept.has(r.key)) { kept.set(r.key, r); routes.push(r); }
    }
    routes.sort(better);
    out.routes = routes;

    // The hops drawn, each with its state — final now the routes are known: a
    // heard repeater's hop from another heard repeater is heard only when no
    // hop runs into it from the station itself.
    for (const r of routes) {
      for (let i = 1; i < r.ids.length; i++) {
        const from = r.ids[i - 1], to = r.ids[i], k = `${from}>${to}`;
        if (out.edges.has(k)) continue;
        out.edges.set(k, { from, to, km: r.hops[i - 1].km, margin: r.hops[i - 1].margin, kind: 'assumed', straight: r.extra });
      }
    }
    out.edges.forEach(e => {
      const k = `${e.from}>${e.to}`;
      const n = T.nodes.get(e.to);
      if (proved.has(k)) { e.kind = 'heard'; return; }
      if (n && n.isRep && ev.relayed.has(e.to)) {
        if (e.from === st.id || (ev.relayed.has(e.from) && !out.edges.has(`${st.id}>${e.to}`))) e.kind = 'heard';
        return;
      }
      if (n && n.isRep && e.from === st.id && ev.elsewhere.has(e.to)) e.kind = 'missed';
    });
    for (const r of routes) r.kinds = r.ids.slice(1).map((x, i) => out.edges.get(`${r.ids[i]}>${x}`).kind);

    // Every station lit, and what is known of it.
    const nodeKind = id => {
      if (id === st.id) return 'station';
      if (ev.relayed.has(id)) return 'heard';
      const n = T.nodes.get(id);
      if (n && n.isBase && [...out.edges.values()].some(e => e.to === id && e.kind === 'heard')) return 'heard';
      if (ev.elsewhere.has(id) && [...out.edges.values()].every(e => e.to !== id || e.kind === 'missed')) return 'missed';
      return 'assumed';
    };
    out.nodes.set(st.id, { id: st.id, kind: 'station' });
    out.edges.forEach(e => {
      for (const id of [e.from, e.to]) if (!out.nodes.has(id)) out.nodes.set(id, { id, kind: nodeKind(id) });
    });
    for (const r of routes) out.bases.add(r.ids[r.ids.length - 1]);
    return out;
  }

  // ── Keeping the plan in step ────────────────────────────────────────────────

  function keyNow() {
    // The theme too: the lines take its colours when they are drawn.
    return [onId, linkKm(), stations().length, RL.at, RX.at, RX.id, state.data ? 1 : 0,
            document.documentElement.getAttribute('data-theme') || ''].join('|');
  }

  // Worked out again whenever what it rests on has moved: the station, the
  // Max TX distance, the file, the evidence. Cheap — a few dozen stations.
  // True when it was: the lines are drawn again and the card with them, and
  // the pins' restyle is the caller's (applyMapFocusStyles asks for the lit
  // set from inside one, and must not be sent round again).
  function refreshPlan() {
    if (!onId) return false;
    const st = byId(onId);
    if (!st) return false;
    const key = keyNow();
    if (key === planKey && plan && plan._data === state.data) return false;
    plan = build(st);
    plan._data = state.data;
    planKey = key;
    if (pickedRoute && !plan.routes.some(r => r.key === pickedRoute)) pickedRoute = null;
    draw();
    renderCard();
    return true;
  }

  function sync() {
    if (!onId) return;
    if (!byId(onId)) { clear({ quiet: true }); return; }
    if (refreshPlan()) restyle();
    else renderCard();
  }

  function restyle() {
    try { applyMapFocusStyles(); } catch (_) { /* not the Stations tab */ }
    try { applyMapLabels(); } catch (_) { /* likewise */ }
    try { rerenderMapLegend(); } catch (_) { /* likewise */ }
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  function clearLayers() {
    if (lineLayer) { lineLayer.remove(); lineLayer = null; }
  }

  // The way the hop runs, at its middle: a chevron turned to the screen angle
  // of the line — which Mercator keeps at every zoom, so it is worked out once.
  function chevron(a, b, c) {
    const p = map.latLngToLayerPoint([a.lat, a.lon]), q = map.latLngToLayerPoint([b.lat, b.lon]);
    const deg = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
    return L.marker([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], {
      pane: LINE_PANE, interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'mn-hop-dir', iconSize: [16, 16], iconAnchor: [8, 8],
                        html: `<span style="transform:rotate(${deg.toFixed(1)}deg);color:${c}">➤</span>` }),
    });
  }

  function draw() {
    clearLayers();
    if (!map || !plan || !plan.edges.size) return;
    lineLayer = L.layerGroup([], { pane: LINE_PANE }).addTo(map);
    const picked = pickedRoute ? plan.routes.find(r => r.key === pickedRoute) : null;
    const onPicked = new Set(picked ? picked.ids.slice(1).map((x, i) => `${picked.ids[i]}>${x}`) : []);
    const order = [...plan.edges.values()].sort((a, b) => KINDS[a.kind].rank - KINDS[b.kind].rank);
    for (const e of order) {
      const a = byId(e.from), b = byId(e.to);
      if (!placed(a) || !placed(b)) continue;
      const k = KINDS[e.kind], c = colour(e.kind);
      const heavy = onPicked.has(`${e.from}>${e.to}`);
      const w = (k.weight + (heavy ? 2 : 0)) * (typeof mapStrokeScale === 'function' ? mapStrokeScale() : 1);
      const ll = [[a.lat, a.lon], [b.lat, b.lon]];
      L.polyline(ll, { pane: LINE_PANE, color: '#ffffff', weight: w + 3, opacity: picked && !heavy ? 0.45 : 0.9,
                       interactive: false, lineCap: 'round' }).addTo(lineLayer);
      const line = L.polyline(ll, { pane: LINE_PANE, color: c, weight: w, opacity: picked && !heavy ? 0.5 : 1,
                                    dashArray: k.dash, interactive: false, lineCap: 'round' }).addTo(lineLayer);
      line.mnHop = { from: e.from, to: e.to, kind: e.kind };
      chevron(a, b, c).addTo(lineLayer);
    }
    // A ring round every station lit, in what is known of it; the station
    // itself in the card's teal, a size up.
    plan.nodes.forEach(n => {
      const s = byId(n.id);
      if (!placed(s)) return;
      const c = n.kind === 'station' ? cssVar('--edge-station', '#0f766e') : colour(n.kind);
      const ring = L.circleMarker([s.lat, s.lon], {
        pane: LINE_PANE, radius: n.kind === 'station' ? 13 : isBase(s) ? 12 : 10, color: c, weight: 3, opacity: 0.95,
        fill: false, interactive: false, dashArray: n.kind === 'missed' ? '2 5' : n.kind === 'assumed' ? '6 4' : null,
      }).addTo(lineLayer);
      ring.mnHopNode = n;
    });
  }

  // The map's room beside the station card, as fitBounds paddings: the card
  // stands over one side of the map on a desktop (map-leader.js measures the
  // same box), and a route drawn under it has not been shown to anybody.
  function room() {
    const pad = { l: 40, t: 40, r: 40, b: 40 };
    const card = document.getElementById('stn-card');
    if (!map || !card || card.hidden) return pad;
    const c = card.getBoundingClientRect(), m = map.getContainer().getBoundingClientRect();
    if (!c.width || !c.height || c.right <= m.left || c.left >= m.right || c.bottom <= m.top || c.top >= m.bottom) return pad;
    const left = c.left - m.left, right = m.right - c.right;
    // Only when what is left beside it is a map worth fitting to.
    if (left <= right && m.width - (c.right - m.left) > 260) pad.l = c.right - m.left + 24;
    else if (left > right && c.left - m.left > 260) pad.r = m.right - c.left + 24;
    return pad;
  }

  // Put the lit stations in view, clear of the card, unless they are already.
  function fit() {
    if (!map || !plan || !plan.nodes.size) return;
    const pts = [...plan.nodes.keys()].map(byId).filter(placed).map(s => [s.lat, s.lon]);
    if (!pts.length) return;
    const pad = room();
    try {
      const size = map.getSize();
      const seen = pts.every(ll => {
        const p = map.latLngToContainerPoint(ll);
        return p.x >= pad.l && p.y >= pad.t && p.x <= size.x - pad.r && p.y <= size.y - pad.b;
      });
      if (seen && map.getZoom() >= 7) return;
      map.fitBounds(L.latLngBounds(pts), { maxZoom: 11, paddingTopLeft: [pad.l, pad.t], paddingBottomRight: [pad.r, pad.b] });
    } catch (_) { /* a map not laid out yet */ }
  }

  // ── The card ────────────────────────────────────────────────────────────────

  function nameOf(id) {
    const s = byId(id);
    return s ? s.name : id;
  }

  function hopMark(kind) {
    const k = KINDS[kind];
    return `<span class="hop-mark hop-${kind}" title="${escAttr(`${k.word} — ${words()[kind]}`)}"
      ><span aria-hidden="true">→</span><span class="sr-only"> ${esc(k.word.toLowerCase())} hop to </span></span>`;
  }

  // A route a line a station, each after the mark of the hop into it: a
  // narrow card wraps a name, never a hop.
  function routeHtml(r) {
    return r.ids.map((id, i) => `<span class="hop-line">${i ? hopMark(r.kinds[i - 1]) : ''}<span class="hop-stn${
      isBase(byId(id)) ? ' hop-base' : ''}">${esc(nameOf(id))}</span></span>`).join('');
  }

  function keyHtml() {
    const w = words();
    return `<ul class="hops-key">${KIND_KEYS.map(k => `<li><span class="hops-swatch hops-swatch-${k}" aria-hidden="true"></span>
      ${termHtml(KINDS[k].word, w[k])}</li>`).join('')}</ul>`;
  }

  function when(t) {
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  }

  // What the hops' evidence is, and where it is up to.
  function evidenceHtml() {
    const p = plan;
    const bits = [];
    if (RL.phase === 'loading') bits.push('Reading what each repeater was heard relaying…');
    else if (RL.phase === 'error') bits.push(`What each repeater was heard relaying could not be read (${esc(RL.err)}), so no repeater hop is heard.`);
    else if (RL.phase === 'none') bits.push('No repeater has a week of what it was heard relaying yet, so no repeater hop is heard.');
    else if (RL.phase === 'ok') {
      const heard = p.relayWeek || [];
      bits.push(heard.length
        ? `Heard relaying it in the ${term('relay', 'relay week')}${RL.judged ? ` (to ${esc(when(RL.judged))})` : ''}: `
          + `${heard.map(id => `<strong>${esc(nameOf(id))}</strong>`).join(', ')}.`
        : `No repeater was heard relaying it in the ${term('relay', 'relay week')}${RL.judged ? ` (to ${esc(when(RL.judged))})` : ''}.`);
    }
    if (RX.phase === 'off') {
      bits.push('Which base station heard it is in the receivers\' copies, which are for editors — signed in as one, the hops into the base stations are checked against them.');
    } else if (RX.phase === 'loading') {
      bits.push(`Reading the receivers' copies of its readings over the last ${HEARD_H} hours…`);
    } else if (RX.phase === 'error') {
      bits.push(`The receivers' copies could not be read (${esc(RX.err)}).`);
    } else if (RX.phase === 'none') {
      bits.push('This account may not read the receivers\' copies, so the hops into the base stations are assumed.');
    } else if (RX.phase === 'ok' && RX.id === p.id) {
      const into = [...new Set(RX.paths.map(x => x.ids[x.ids.length - 1]))];
      bits.push(RX.copies
        ? `${plural(RX.copies, 'copy', 'copies')} of its readings at ${plural(RX.receivers, 'receiver')} in the last ${HEARD_H} hours`
          + (into.length ? ` — heard arriving at ${into.map(id => `<strong>${esc(nameOf(id))}</strong>`).join(', ')}.`
            : ', none on a carrier that names the way it came.')
        : `No receiver took a copy of its readings in the last ${HEARD_H} hours.`);
    }
    return bits.map(b => `<p class="small st-note">${b}</p>`).join('');
  }

  function cardHtml() {
    if (!onId || !plan) return '';
    const p = plan;
    const st = byId(p.id);
    if (!st) return '';
    const head = `
      <div class="panel-header">
        <h3 id="hops-card-h">Hops to base — ${esc(p.name)}</h3>
        <div class="button-group">
          <span class="badge" title="Base stations its routes end at">${p.bases.size}</span>
          <button type="button" onclick="MapHops.clear()" title="Take the hops off the map">Clear</button>
        </div>
      </div>`;
    if (p.kind === 'unplaced') return `${head}<p class="small st-note"><strong>${esc(p.name)}</strong> has no position recorded, so there is nothing to draw from.</p>`;
    if (p.kind === 'base') return `${head}<p class="small st-note"><strong>${esc(p.name)}</strong> is a base station: its readings are home already.</p>`;
    const intro = `<p class="small st-note">How <strong>${esc(p.name)}</strong>'s readings reach the base stations, hop by hop —
        lit on the map, everything else faded. ${p.kind === 'repeater'
          ? 'It is a repeater, so its routes start from it.'
          : `${plural(p.carriers || 0, 'repeater')} carr${(p.carriers || 0) === 1 ? 'ies' : 'y'} its address${addrsOf(st).length === 1 ? '' : 'es'}`
            + `${p.starts ? `; ${p.starts} ${p.starts === 1 ? 'is' : 'are'} walked on from — the nearest ${MAX_FIRST} within ${FIRST_KM} km, `
              + 'and every one heard relaying it' : ''}.`}
      </p>${keyHtml()}${evidenceHtml()}`;
    if (!p.routes.length) {
      const why = p.kind === 'repeater'
        ? `No base station or repeater that takes what it relays is within ${linkKm()} km (the Max TX distance in Layers).`
        : !addrsOf(st).length ? 'It has no ALERT address, so no pass range can carry it.'
          : !p.starts ? 'No repeater\'s pass ranges carry its address: it is orphaned, and nothing is listening for it.'
            : `None of the repeaters carrying it has a way on to a base station within ${linkKm()} km (the Max TX distance in Layers) and four repeaters.`;
      return `${head}${intro}<p class="small st-note txt-bad">${why}</p>${glossaryHtml()}`;
    }
    const list = showAll ? p.routes : p.routes.slice(0, SHOWN);
    const f1 = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`);
    return `${head}${intro}
      <div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="hops-card-h">
        <table class="hops-table">
          <caption class="sr-only">Each route from ${esc(p.name)} to a base station, its hops marked heard, assumed or not heard</caption>
          <colgroup><col style="width:58%"><col style="width:20%"><col style="width:22%"></colgroup>
          <thead><tr>
            <th scope="col">${term('route')}</th><th scope="col">${term('repeaters')}</th><th scope="col">${term('weakest')}</th>
          </tr></thead>
          <tbody>
            ${list.map(r => `
              <tr class="row-link${pickedRoute === r.key ? ' hops-picked' : ''}" data-hop-route="${escAttr(r.key)}"
                  onclick="MapHops.pick('${escAttr(r.key)}')" title="Pick this route on the map — again to put it back">
                <td><button type="button" class="hops-route" aria-pressed="${pickedRoute === r.key}"
                      onclick="event.stopPropagation();MapHops.pick('${escAttr(r.key)}')">${routeHtml(r)}</button>
                    <span class="hop-km small txt-muted">${fmtKm(r.km)} in all${r.extra ? ' — heard, off the map\'s paths' : ''}</span></td>
                <td class="small">${Math.max(0, r.ids.length - 2)}</td>
                <td class="small">${r.unknown ? '—' : f1(r.weakest ? r.weakest.margin : null)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${p.routes.length > SHOWN ? `<p class="small st-note"><button type="button" class="link-btn" onclick="MapHops.showAll()"
        >${showAll ? 'Show fewer' : `Show all ${p.routes.length} routes`}</button></p>` : ''}
      ${glossaryHtml()}`;
  }

  function renderCard() {
    const el = document.getElementById('hops-card');
    if (!el) return;
    const html = cardHtml();
    const had = el.contains(document.activeElement) ? document.activeElement : null;
    const route = had && had.closest('[data-hop-route]') ? had.closest('[data-hop-route]').dataset.hopRoute : null;
    el.innerHTML = html;
    el.hidden = !html;
    if (had && route) {
      const back = el.querySelector(`[data-hop-route="${CSS.escape(route)}"] .hops-route`);
      if (back) back.focus({ preventScroll: true });
    }
  }

  // The card's and the editor's repaint, both cheap; and the legend.
  function repaint() {
    renderCard();
  }

  function summary(p) {
    return {
      id: p.id, kind: p.kind, starts: p.starts, carriers: p.carriers,
      routes: p.routes.map(r => ({ ids: r.ids.slice(), kinds: r.kinds.slice(), km: r.km, extra: r.extra })),
      edges: [...p.edges.values()].map(e => ({ ...e })),
      nodes: [...p.nodes.values()].map(n => ({ ...n })),
      bases: [...p.bases],
    };
  }

  // ── The API ─────────────────────────────────────────────────────────────────

  // Station details' pill, in place, with the keyboard still on it if it was
  // (MapBlast.repaintEditorPill's way).
  function repaintEditorPill() {
    const el = document.getElementById('ef-hops');
    const s = el && byId(state.editorId);
    if (!s) return;
    const had = document.activeElement === el;
    el.outerHTML = MapHops.pillHtml(s, { editor: true });
    if (had) document.getElementById('ef-hops')?.focus({ preventScroll: true });
  }

  function show(id, { refit = true, quiet = false } = {}) {
    const st = byId(id);
    if (!st) return;
    onId = id;
    pickedRoute = null;
    showAll = false;
    planKey = '';
    plan = null;
    if (state.map) state.map.closePopup();
    sync();
    if (refit) fit();
    ensureRelay();
    ensureCopies(st);
    try { repaintStnCard(); } catch (_) { /* not the Stations tab */ }
    repaintEditorPill();
    if (!quiet && plan) {
      const n = plan.routes.length;
      const msg = n
        ? `Hops to base lit for ${st.name}: ${plural(n, 'route')} to ${plural(plan.bases.size, 'base station')} — listed ${stationsCardsWhere()} ${stationsCardsArrow()}`
        : `No route to a base station for ${st.name} — ${stationsCardsWhere()} says why.`;
      try { mapNote(msg, 5000); } catch (_) { /* no map note here */ }
      announce(msg);
    }
  }

  function clear({ quiet = false } = {}) {
    if (!onId) return;
    const name = plan ? plan.name : '';
    onId = null;
    plan = null;
    planKey = '';
    pickedRoute = null;
    clearLayers();
    renderCard();
    restyle();
    try { repaintStnCard(); } catch (_) { /* not the Stations tab */ }
    repaintEditorPill();
    if (!quiet && name) announce(`Hops to base taken off the map for ${name}.`);
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(LINE_PANE)) {
        const p = m.createPane(LINE_PANE);
        p.style.zIndex = LINE_Z;
        p.style.pointerEvents = 'none';
      }
      if (onId) { planKey = ''; sync(); }
    },

    detach() {
      clearLayers();
      map = null;
    },

    // The station card's pill, and Station details': for a station something
    // could start a route from. The editor's carries an id, so
    // repaintEditorPill() can put its label right without redrawing the form.
    pillHtml(s, { editor = false } = {}) {
      if (!s || !s.id || !canShow(s)) return '';
      const lit = onId === s.id;
      return `<button type="button" class="pill mn-hops-pill"${editor ? ' id="ef-hops"' : ''} aria-pressed="${lit}" onclick="MapHops.toggle('${escAttr(s.id)}')"
        title="${lit ? 'Take the hops off the map'
          : 'Light the radio paths its readings take to the base stations — each repeater on the way, heard or assumed'}"
        >${pillText('🪜', lit ? 'Hide hops to base' : 'Show hops to base')}</button>`;
    },

    repaintEditorPill,

    // The line under the card's pills, while its hops are lit.
    cardNoteHtml(s) {
      if (!s || onId !== s.id || !plan) return '';
      return `Hops to base lit — <button type="button" class="link-btn" onclick="MapHops.reveal()">listed ${stationsCardsWhere()} ${stationsCardsArrow()}</button>. `;
    },

    toggle(id) {
      if (onId === id) clear();
      else show(id);
    },

    show,
    clear,

    // The card moved to another station while the hops are lit: they go with
    // it. A card closed leaves them — on a phone the card is closed to look at
    // the map.
    follow(id) {
      if (!onId || !id || id === onId) return;
      const st = byId(id);
      if (!canShow(st)) { clear({ quiet: true }); return; }
      show(id, { quiet: true });
    },

    reveal() {
      const el = document.getElementById('hops-card');
      if (!el || el.hidden) return;
      if (state.mapFullscreen && typeof toggleMapFullscreen === 'function') toggleMapFullscreen(false);
      try { dockReveal(el); } catch (_) { /* no side panel */ }
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    pick(key) {
      if (!plan) return;
      pickedRoute = pickedRoute === key ? null : key;
      draw();
      renderCard();
      const r = pickedRoute ? plan.routes.find(x => x.key === pickedRoute) : null;
      if (r && map) {
        const pts = r.ids.map(byId).filter(placed).map(s => [s.lat, s.lon]);
        const pad = room();
      if (pts.length) {
        try { map.fitBounds(L.latLngBounds(pts), { maxZoom: 12, paddingTopLeft: [pad.l, pad.t], paddingBottomRight: [pad.r, pad.b] }); }
        catch (_) { /* not laid out */ }
      }
      }
    },

    showAll() { showAll = !showAll; renderCard(); },

    // Which stations stay lit while the hops are shown, or null when they are
    // not (applyMapFocusStyles): the station, and every one on its routes.
    litIds() {
      if (!onId) return null;
      refreshPlan();
      return plan ? new Set(plan.nodes.keys()) : new Set([onId]);
    },
    // …and named, whatever the label mode, unless names are off.
    labelIds() { return onId && plan ? [...plan.nodes.keys()] : []; },

    active() { return !!onId; },
    stationId() { return onId; },
    sync,

    legendHtml() {
      if (!onId || !plan) return '';
      return `
      <span class="legend-item">
        <span class="legend-line legend-line-hop-heard"></span>
        <span class="small">Hops to base for ${esc(plan.name)} — green where something received says the readings took the hop,
          blue dashed where only the pass ranges and backbone say so, red dotted where a repeater that carries its address
          was not heard relaying it; a ring round each station on the way, and an arrow the way the readings go</span>
      </span>`;
    },

    // For the check: what was worked out, and where the evidence is up to —
    // for the station lit, or worked out for any station without lighting it.
    _plan() { return plan ? summary(plan) : null; },
    _build(id) { const st = byId(id); return st ? summary(build(st)) : null; },
    _evidence() { return { relay: RL.phase, relayN: RL.byId.size, rx: RX.phase, rxId: RX.id, paths: RX.paths.map(p => p.ids.slice()) }; },
    _drawn() { return lineLayer ? lineLayer.getLayers().filter(l => l.mnHop).map(l => ({ ...l.mnHop })) : []; },
    _reset() {
      Object.assign(RL, { phase: 'idle', at: 0, err: '', byId: new Map(), judged: null }); RL.seq++;
      Object.assign(RX, { phase: 'off', id: null, at: 0, err: '', paths: [], copies: 0, receivers: 0 }); RX.seq++;
      planKey = '';
    },
  };
})();
