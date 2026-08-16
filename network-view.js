// MegaNet — network-view.js
//
//   NetworkView   the Ghosting Graph tab: the ghosting knowledge graph. A node is
//                 one ALERT address as transmitted by one station; an edge is
//                 either computed (the two are one bit apart) or confirmed (the
//                 relationship was observed, with an evidence file behind it).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, csvEscape, dlText,
// bearingDeg, arroSiteId, arroSiteUrl, stationSensors, ROLE_COLOR,
// ROLE_LABEL, registerTabTeardown and registerLiveMap (#142 — this file says
// itself that it has a loop and a map to stop, rather than app.js saying it on
// its behalf) and removeMap (#143 — the one way to take a map down that
// survives a zoom still in flight when it goes); and across to app.js for
// MAP_HOME, MAP_LABEL_CAP, MAP_PIN_HIT,
// MAP_PIN_RING, addBaseLayers, addToMapSelection, findRepeaterMatches,
// goToStation, mapNote, passRangeCoversId, primaryRole, renderMain,
// stationAlertIds and switchTab. The widest reach of the fourteen, which is
// what 1,867 lines of graph over the Stations map costs.
//
// This file holds 3 of the app's 4 literal NUL bytes — U+0000 inside string
// literals at lines 506 and 570 (two on that line), used as compound-key
// separators (#129). Any tool that round-trips this file as text and normalises
// control characters destroys those keys silently, and grep will call the file
// binary. `npm run concat` in test/ is what catches it. app.js carries none
// after M3; the fourth left with Alert2 in M2 and is alert2.js:859.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.

// ── NETWORK VIEW tab ───────────────────────────────────────────────────────────
// The ghosting knowledge graph. A node is one ALERT address as transmitted by
// one station; an edge is a relationship between two of them, and there are
// exactly two kinds:
//
//   computed   the two addresses are one bit apart. Arithmetic over the loaded
//              file — the same question the Bit Flipper asks about a single
//              address, asked about every address at once. XOR is symmetric, so
//              a computed edge has no direction and carries no arrowhead.
//   confirmed  the relationship was observed, candidate → target, with an
//              evidence file behind it. Directed, and comparatively rare.
//
// They share one graph rather than getting a view each, because the question
// worth asking is which bit-adjacent pairs were ever *seen* ghosting — and that
// is only answerable when a confirmed edge can sit on top of a computed one.
// Every confirmed relationship shipped in data/ghosting-links.json is exactly one
// bit apart, so in practice the confirmed set is a subset of the computed one.
//
// Ported from the standalone BitFlipper_Network_View build (own palette, own
// full-viewport grid, its data hard-coded in the page). What survived: search and
// focus, the cluster and sensor filters, reciprocal-only, same-site-only, labels,
// spread, group-by-site, export, and the drag/pan/zoom feel. What changed: the
// graph is built from the loaded stations.json instead of a baked-in blob, the
// filters are generated from the data rather than fixed at four sensor types, and
// the nodes are wired through to the Stations map.
const NetworkView = (function () {

  // Rendered-node cap, in the spirit of MAP_LABEL_CAP and BF_MAX_RENDER_ROWS.
  // The full computed graph over the shipped file is ~23,700 edges across 5,122
  // addresses, which is not a picture. Past this the best-connected nodes are
  // kept and the note under the graph says how many were left out.
  //
  // The number is set by drawing cost, not by arithmetic: the force loop is about
  // 1.3 ms a frame even at several hundred nodes, while rasterising the edges it
  // produces is an order of magnitude more. Edge count grows with the node count,
  // so capping nodes is what keeps a frame affordable.
  const NV_MAX_NODES = 400;

  // Permanent name labels beyond this are a grey smear rather than a reading, so
  // past it only the best-connected nodes (and anything searched for) keep one.
  // The ceiling is MAP_LABEL_CAP itself rather than a number of its own: this is
  // the same question the Stations map answers about its pins, and two different
  // answers to it in one app would only be two things to tune. The labels toggle
  // still turns the lot off; this decides what "on" means when it is crowded.
  const NV_LABEL_CAP = MAP_LABEL_CAP;

  // …but a graph has to answer it per stage, not per app. Labels hold a fixed
  // size on screen however far the view is zoomed out, so what they collide with
  // is the room the stage has: sixty names are comfortable across a desktop pane
  // and illegible stacked in a phone's. One name per this much area, capped above
  // by NV_LABEL_CAP.
  const NV_LABEL_AREA = 9000;   // px² of stage per labelled node

  function labelBudget() {
    return Math.max(8, Math.min(NV_LABEL_CAP, Math.floor((nv.w * nv.h) / NV_LABEL_AREA)));
  }

  // Neighbour expansion is the expensive direction — one click can pull in
  // sixteen new addresses per node — so it stops here regardless of the cap.
  const NV_EXPAND_MAX = 900;

  // Force layout. The original ran 140 synchronous iterations per interaction;
  // these run a couple per animation frame with a cooling alpha instead, so the
  // graph settles visibly and then stops burning frames on its own.
  const NV_REPULSION  = 1900;
  const NV_SPRING     = 0.012;
  const NV_CENTRING   = 0.0008;
  const NV_DAMPING    = 0.84;
  const NV_ALPHA_DECAY = 0.985;
  const NV_ALPHA_MIN   = 0.03;

  // Sensor-type colours. The four the standalone build knew are kept so a ported
  // graph still reads the same; everything else — and there are 22 sensor types
  // in the shipped file, not 4 — draws from the generic palette below.
  const NV_TYPE_COLOR = {
    'Rainfall':    '#2563eb',
    'Battery':     '#d97706',
    'Water Level': '#0891b2',
    'Repeater':    '#7c35a3',
  };

  // The map's third relationship (see visibleRepeaterInfo): a repeater whose
  // pass ranges carry an address in view, drawn as a diamond joined by a dotted
  // line. Deliberately not ROLE_COLOR.repeater (already a *station* colour on
  // this same map, for a repeater that is itself a graph node) and not
  // --map-line or the computed-edge grey (both already mean "this is an edge
  // of the ghosting graph"). A colour and a shape neither of those uses, so a
  // pass-range line can't be misread as a relationship the graph is claiming.
  const NV_REPEATER_COLOR = '#0d9488';

  // Categorical palette for every other facet value. Chosen to stay legible on
  // both themes — the graph background follows --panel, which flips.
  const NV_PALETTE = [
    '#2563eb', '#d97706', '#0891b2', '#7c3aed', '#16a34a', '#e11d48',
    '#0ea5e9', '#b45309', '#65a30d', '#be185d', '#0d9488', '#6d28d9',
  ];
  const NV_GREY = '#8b98a8';   // the "not recorded" bucket, on every facet

  // Which sensor type speaks for an address when several share it. Loudoun Br's
  // 6128 is both "Rainfall" and "Rainfall Increment"; the increment is derived
  // from the reading, so the reading is what the node is called.
  const NV_TYPE_RANK = ['Water Level', 'Rainfall', 'Battery', 'Repeater'];

  // The facets. Adding an attribute to the graph means adding one entry here:
  // it becomes a filter group in the sidebar and an option in "Colour by", with
  // no other change. This is the extensibility the fixed four-checkbox original
  // could not offer — see the note on the data model in the header above.
  //
  //   values(n)  every value the node carries for this facet. An empty list is
  //              the "not recorded" bucket, which is a value like any other so
  //              that un-mapped stations stay visible instead of silently
  //              dropping out (same reasoning as FILTER_NONE on the Stations tab).
  const NV_FACETS = [
    { key: 'type',    label: 'Sensor type',   values: n => n.types },
    { key: 'role',    label: 'Station role',  values: n => (n.role ? [ROLE_LABEL[n.role] || n.role] : []) },
    { key: 'network', label: 'Radio network', values: n => n.networks },
    { key: 'basin',   label: 'Basin',         values: n => (n.basin ? [n.basin] : []) },
    { key: 'cluster', label: 'Confirmed cluster', values: n => (n.cluster ? ['Cluster ' + n.cluster] : []) },
  ];

  const NV_NONE_LABEL = 'Not recorded';

  // ── module state ──────────────────────────────────────────────────────────────
  // Session-scoped and deliberately not in `state`: none of it belongs in a saved
  // file, and node positions in particular are a property of this screen, not of
  // the network. They do outlive a tab switch, so coming back finds the graph
  // where it was left rather than re-scattering it.
  const nv = {
    graph:     null,     // { nodes:Map(key→node), byAddr:Map(addr→[node]) }  built from state.data
    confirmed: null,     // parsed data/ghosting-links.json, plus anything imported
    confState: 'idle',   // idle | loading | ready | error
    confError: '',
    confSources: [],     // where the confirmed links came from, for the sidebar

    search:      '',
    facetOff:    {},     // facet key → Set of un-ticked values (empty Set = no constraint)
    colourBy:    'type',
    showConfirmed: true,
    showComputed:  true,
    expand:      false,  // pull 1-bit neighbours of the seed in with it
    reciprocalOnly: false,
    sameSiteOnly:   false,
    labels:      true,
    siteMode:    false,
    spread:      105,

    pos:  new Map(),     // node key → { x, y, vx, vy }   survives re-renders
    vis:  null,          // last computed visible set
    els:  null,          // live SVG elements, paired with their nodes
    view: { scale: 1, tx: 0, ty: 0 },
    userMoved: false,    // panned or zoomed since the last filter change: stop auto-framing
    w: 1200, h: 800,

    sel:  null,          // node key the detail card is open on
    raf:  null,
    alpha: 0,
    drag: null,
    pan:  null,
    ro:   null,          // ResizeObserver on the stage
  };

  // ── graph construction ────────────────────────────────────────────────────────

  // Thrown away whenever a new stations.json is loaded — every node in the graph
  // is a fact about that file.
  function invalidate() {
    nv.graph = null;
    nv.pos.clear();
    nv.vis = null;
    nv.sel = null;
    nv.facetOff = {};    // its values were vocabulary from the file just replaced
  }

  function typeRank(t) {
    const i = NV_TYPE_RANK.indexOf(t);
    return i < 0 ? NV_TYPE_RANK.length : i;
  }

  // One node per (station, ALERT address). Not per sensor, as the standalone
  // build had it: ghosting happens to an address on the air, and a station that
  // reports rainfall and rainfall-increment on the same address transmits one
  // thing, not two. Not per address either — 614 addresses in the shipped file
  // are claimed by more than one station, and collapsing those would invent a
  // relationship between sites that have never heard of each other.
  function buildGraph() {
    if (nv.graph) return nv.graph;
    const nodes  = new Map();
    const byAddr = new Map();
    const byName = new Map();    // "name|addr" → node, for the duplicate fold below
    if (!state.data) { nv.graph = { nodes, byAddr }; return nv.graph; }

    const nets = new Map((state.data.radio_networks || []).map(n => [n.id, n.name]));
    for (const s of state.data.stations) {
      const role     = primaryRole(s);
      const networks = (s.radio_network_ids || []).map(id => nets.get(id) || id);
      const perAddr  = new Map();
      for (const sensor of stationSensors(s)) {
        const addr = parseInt(sensor.alert_id, 10);
        if (isNaN(addr) || addr <= 0 || addr >= 65536) continue;
        if (!perAddr.has(addr)) perAddr.set(addr, []);
        perAddr.get(addr).push(sensor);
      }
      for (const [addr, sensors] of perAddr) {
        const types = [...new Set(sensors.map(x => x.type).filter(Boolean))]
          .sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
        const sensorIds = [...new Set(sensors.map(x => x.sensor_id).filter(Boolean))];

        // Seven sites in the shipped file appear twice — same name, same ARRO
        // db_id, same sensor ids, different station records. dedupeMatches folds
        // those together for the Bit Flipper's table and the graph has to fold
        // them too, or a duplicated site becomes two nodes with the same name,
        // twice the edges and a relationship to itself. Name plus address is the
        // same identity dedupeMatches keys on.
        const dupeKey = s.name + '|' + addr;
        const twin = byName.get(dupeKey);
        if (twin) {
          twin.stationIds.push(s.id);
          twin.types     = [...new Set([...twin.types, ...types])]
            .sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
          twin.type      = twin.types[0] || '';
          twin.sensorIds = [...new Set([...twin.sensorIds, ...sensorIds])];
          twin.sensors   = twin.sensors.concat(sensors);
          // The record carrying a station number and a position is the one worth
          // sending to the map; the stub duplicate is not.
          const number = s.station_number || (s.site && s.site.number) || '';
          if (!twin.number && number && s.lat != null) {
            twin.stationId = s.id;
            twin.number    = number;
          }
          continue;
        }

        const key = s.id + '|' + addr;
        const node = {
          key, addr,
          stationId: s.id,          // the record the map is sent to
          stationIds: [s.id],       // every record folded into this node
          name:      s.name,
          number:    s.station_number || (s.site && s.site.number) || '',
          sensorIds,
          sensors,
          types:     types.length ? types : [],
          type:      types[0] || '',
          role, networks,
          basin:     s.basin || '',
          dbId:      arroSiteId(s),
          cluster:   0,     // filled in from the confirmed graph, below
          unresolved: false,
        };
        nodes.set(key, node);
        byName.set(dupeKey, node);
        if (!byAddr.has(addr)) byAddr.set(addr, []);
        byAddr.get(addr).push(node);
      }
    }
    nv.graph = { nodes, byAddr };
    linkConfirmed();
    return nv.graph;
  }

  // Every station+address one bit away from this node's address. The Bit Flipper
  // asks this of one address through bfComputeVariants; here it is the edge
  // relation of the whole graph, so it is answered straight off the address index
  // rather than by expanding 16 variant rows per node.
  function computedNeighbours(node) {
    const g = buildGraph();
    const out = [];
    for (let b = 0; b < 16; b++) {
      const v = node.addr ^ (1 << b);
      if (v <= 0 || v >= 65536) continue;
      for (const other of g.byAddr.get(v) || []) out.push(other);
    }
    return out;
  }

  // ── confirmed relationships ───────────────────────────────────────────────────
  // Shipped as data, not baked into this file: they are a snapshot of an evidence
  // review that happens outside the app, and CSV import below is how the next
  // review gets in. Fetched the same lazy way the ACMA layer is.

  function ensureConfirmed() {
    if (nv.confState === 'ready' || nv.confState === 'loading') return;
    nv.confState = 'loading';
    fetch('data/ghosting-links.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        nv.confirmed = { sensors: d.sensors || [], links: (d.links || []).map(normaliseLink) };
        nv.confSources = [`${nv.confirmed.links.length} from data/ghosting-links.json`];
        nv.confState = 'ready';
        linkConfirmed();
        renderFacets();
        renderLegend();
        refresh(true);
      })
      .catch(err => {
        // A file:// open has no server to fetch from. The computed graph is
        // whole without this, so the tab keeps working and says what is missing.
        nv.confState = 'error';
        nv.confError = err.message;
        nv.confirmed = { sensors: [], links: [] };
        refresh(false);
      });
  }

  function normaliseLink(l) {
    return {
      source: String(l.source || ''),
      target: String(l.target || ''),
      sourceSite: String(l.source_site || ''),
      targetSite: String(l.target_site || ''),
      sourceAlert: parseInt(l.source_alert, 10),
      targetAlert: parseInt(l.target_alert, 10),
      reciprocal: !!l.reciprocal,
      sameSite:   !!l.same_site,
      evidence:   Array.isArray(l.evidence) ? l.evidence : (l.evidence ? [String(l.evidence)] : []),
      origin:     l.origin || 'ghosting-links.json',
    };
  }

  // Resolve each confirmed link's two ends onto graph nodes, and hang the result
  // off the nodes themselves. Resolution is by sensor id first (exact — 144 of
  // the 147 shipped ends match one outright) and by address second, which is
  // enough for the rest. An end that resolves to nothing is kept as its own node
  // and flagged: the issue this ports asks for unresolved nodes to be *reported*,
  // not quietly dropped, because a confirmed relationship pointing at an address
  // the station file has never heard of is a finding in itself.
  function linkConfirmed() {
    if (!nv.graph || !nv.confirmed) return;
    const g = nv.graph;
    // Clear anything a previous pass hung on the nodes — an import re-runs this,
    // and the placeholders it made last time have to go with it or a re-resolved
    // end would keep its old stand-in as well as its new node.
    for (const n of g.nodes.values()) { n.confirmed = null; n.cluster = 0; }
    for (const [k, n] of [...g.nodes]) if (n.unresolved) g.nodes.delete(k);
    for (const [addr, list] of g.byAddr) {
      const kept = list.filter(n => !n.unresolved);
      if (kept.length !== list.length) g.byAddr.set(addr, kept);
    }

    const bySensorId = new Map();
    for (const n of g.nodes.values()) for (const sid of n.sensorIds) {
      if (!bySensorId.has(sid)) bySensorId.set(sid, n);
    }

    const resolve = (sensorId, addr, siteNumber) => {
      const exact = bySensorId.get(sensorId);
      if (exact) return exact;
      const cands = g.byAddr.get(addr) || [];
      // One station transmits the address: that is who the link is about, whatever
      // site number the evidence file carries. Those numbers are not always the
      // station_number in this database — one shipped end says site 140024 for a
      // station numbered 85289 — so a mismatch is not evidence of the wrong station
      // when there is only one to choose from.
      if (cands.length === 1) return cands[0];
      // Several do claim it, and now the site number is the only thing that can
      // tell them apart.
      const bySite = cands.find(c => c.number && String(c.number) === String(siteNumber));
      if (bySite) return bySite;
      // It named none of them. Picking the first would attribute an observed
      // relationship to a station that may have nothing to do with it, which is
      // worse than saying so — this end is reported unresolved instead.
      return placeholder(sensorId, addr, siteNumber);
    };

    // A node for an end the station file cannot account for. It draws like any
    // other node so the relationship stays visible, but it is grey, it says
    // "not in stations.json", and it is excluded from anything that needs a real
    // station — the map hand-off above all.
    const placeholder = (sensorId, addr, siteNumber) => {
      const key = '?|' + (sensorId || addr);
      if (g.nodes.has(key)) return g.nodes.get(key);
      const meta = (nv.confirmed.sensors || []).find(s => s.sensor_id === sensorId) || {};
      const node = {
        key, addr: isNaN(addr) ? 0 : addr,
        stationId: null,
        stationIds: [],
        name:   meta.site_name || `Unknown site ${siteNumber || ''}`.trim(),
        number: String(meta.site_id || siteNumber || ''),
        sensorIds: sensorId ? [sensorId] : [],
        sensors: [],
        types:  meta.type ? [meta.type] : [],
        type:   meta.type || '',
        role: '', networks: [], basin: '', dbId: null,
        cluster: 0, unresolved: true,
      };
      g.nodes.set(key, node);
      if (!g.byAddr.has(node.addr)) g.byAddr.set(node.addr, []);
      g.byAddr.get(node.addr).push(node);
      return node;
    };

    const links = [];
    for (const l of nv.confirmed.links) {
      const a = resolve(l.source, l.sourceAlert, l.sourceSite);
      const b = resolve(l.target, l.targetAlert, l.targetSite);
      if (!a || !b || a === b) continue;
      const rec = { ...l, a, b };
      links.push(rec);
      (a.confirmed || (a.confirmed = [])).push(rec);
      (b.confirmed || (b.confirmed = [])).push(rec);
    }
    nv.confirmed.resolved = links;
    clusterConfirmed(links);
  }

  // Connected components of the confirmed graph only. The standalone build shipped
  // a cluster number per node and a "cluster" dropdown built from it; computing
  // them over the *visible* graph instead would give a filter whose own options
  // moved every time it was used, so they are pinned to the confirmed set — which
  // is the stable, evidence-backed part — and everything else is unclustered.
  function clusterConfirmed(links) {
    const adj = new Map();
    const add = (a, b) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    };
    for (const l of links) { add(l.a, l.b); add(l.b, l.a); }
    let c = 0;
    for (const start of adj.keys()) {
      if (start.cluster) continue;
      c++;
      const queue = [start];
      start.cluster = c;
      while (queue.length) {
        const n = queue.pop();
        for (const m of adj.get(n) || []) if (!m.cluster) { m.cluster = c; queue.push(m); }
      }
    }
  }

  // ── facet vocabulary ──────────────────────────────────────────────────────────

  // Every value each facet actually takes, with a count, built from the graph.
  // Same shape as the Stations tab's filter options, and the same rule: an empty
  // un-ticked set means "no constraint", so the default shows everything.
  function facetOptions() {
    const g = buildGraph();
    const out = {};
    for (const f of NV_FACETS) out[f.key] = new Map();
    for (const n of g.nodes.values()) {
      for (const f of NV_FACETS) {
        const vals = f.values(n);
        const list = vals && vals.length ? vals : [NV_NONE_LABEL];
        for (const v of list) out[f.key].set(v, (out[f.key].get(v) || 0) + 1);
      }
    }
    const sorted = {};
    for (const f of NV_FACETS) {
      sorted[f.key] = [...out[f.key].entries()]
        .sort((a, b) => (a[0] === NV_NONE_LABEL) - (b[0] === NV_NONE_LABEL) || b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    }
    return sorted;
  }

  function facetValues(node, key) {
    const f = NV_FACETS.find(x => x.key === key);
    if (!f) return [NV_NONE_LABEL];
    const v = f.values(node);
    return v && v.length ? v : [NV_NONE_LABEL];
  }

  function nodePasses(node) {
    for (const f of NV_FACETS) {
      const off = nv.facetOff[f.key];
      if (!off || !off.size) continue;
      if (facetValues(node, f.key).every(v => off.has(v))) return false;
    }
    return true;
  }

  // Stable colour for a facet value: the four known sensor types keep the
  // standalone build's palette, everything else is assigned by position in the
  // facet's own sorted vocabulary so a value does not change colour between
  // renders.
  const colourCache = new Map();
  function colourFor(value, facetKey) {
    if (value === NV_NONE_LABEL) return NV_GREY;
    if (facetKey === 'type' && NV_TYPE_COLOR[value]) return NV_TYPE_COLOR[value];
    const ck = facetKey + ' ' + value;
    if (colourCache.has(ck)) return colourCache.get(ck);
    let h = 0;
    for (let i = 0; i < ck.length; i++) h = (h * 31 + ck.charCodeAt(i)) >>> 0;
    const c = NV_PALETTE[h % NV_PALETTE.length];
    colourCache.set(ck, c);
    return c;
  }

  function nodeColour(n) {
    if (n.unresolved) return NV_GREY;
    return colourFor(facetValues(n, nv.colourBy)[0], nv.colourBy);
  }

  // ── the visible set ───────────────────────────────────────────────────────────
  // Built in one pass so nothing downstream has to recompute it. The original
  // called its equivalent from inside the per-frame tick, which meant re-deriving
  // the whole filtered graph sixty times a second; here the result is cached on
  // nv.vis and only rebuilt when a control moves.

  function searchTokens() {
    return (nv.search || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  }

  function matchesSearch(n, tokens) {
    if (!tokens.length) return false;
    const hay = `${n.name} ${n.number} ${n.addr} ${n.sensorIds.join(' ')} ${n.types.join(' ')}`.toLowerCase();
    return tokens.some(t => hay.includes(t));
  }

  function computeVisible() {
    const g = buildGraph();
    const tokens = searchTokens();

    // Seed. A search names the nodes it hits; without one the confirmed graph is
    // the starting point, because the whole computed graph is every address in
    // the file and says nothing on its own.
    const seed = new Set();
    const hits = new Set();
    if (tokens.length) {
      for (const n of g.nodes.values()) if (matchesSearch(n, tokens)) { seed.add(n); hits.add(n); }
    } else if (nv.showConfirmed && nv.confirmed && nv.confirmed.resolved) {
      for (const l of nv.confirmed.resolved) { seed.add(l.a); seed.add(l.b); }
    }

    // Expansion pulls each seed node's 1-bit neighbours in with it — the graph
    // equivalent of running the Bit Flipper on everything on screen at once.
    let expandCapped = false;
    if (nv.expand && nv.showComputed) {
      for (const n of [...seed]) {
        if (seed.size >= NV_EXPAND_MAX) { expandCapped = true; break; }
        for (const m of computedNeighbours(n)) seed.add(m);
      }
    }

    // Facets apply to the seed, not to the edges: a node the operator has filtered
    // out should take its links with it.
    let nodes = [...seed].filter(nodePasses);

    // Edges among the survivors. Computed adjacency is looked up per node rather
    // than materialised for the whole file — 16 map hits a node beats holding
    // 23,700 edge objects that mostly are not on screen.
    const present = new Set(nodes.map(n => n.key));
    const edges = new Map();   // unordered pair key → edge record
    const pairKey = (a, b) => (a.key < b.key ? a.key + ' ' + b.key : b.key + ' ' + a.key);

    if (nv.showComputed) {
      for (const n of nodes) {
        for (const m of computedNeighbours(n)) {
          if (!present.has(m.key) || m === n) continue;
          const k = pairKey(n, m);
          if (edges.has(k)) continue;
          edges.set(k, {
            a: n.key < m.key ? n : m, b: n.key < m.key ? m : n,
            computed: true, confirmed: false, dirs: [],
            sameSite: !!(n.stationId && n.stationId === m.stationId),
            reciprocal: false, evidence: [],
          });
        }
      }
    }
    if (nv.showConfirmed && nv.confirmed && nv.confirmed.resolved) {
      for (const l of nv.confirmed.resolved) {
        if (!present.has(l.a.key) || !present.has(l.b.key)) continue;
        const k = pairKey(l.a, l.b);
        let e = edges.get(k);
        if (!e) {
          e = { a: l.a.key < l.b.key ? l.a : l.b, b: l.a.key < l.b.key ? l.b : l.a,
                computed: false, confirmed: false, dirs: [], sameSite: l.sameSite,
                reciprocal: false, evidence: [] };
          edges.set(k, e);
        }
        e.confirmed  = true;
        e.reciprocal = e.reciprocal || l.reciprocal;
        e.sameSite   = e.sameSite || l.sameSite;
        e.evidence   = [...new Set([...e.evidence, ...l.evidence])];
        e.dirs.push({ from: l.a, to: l.b });
      }
    }

    let list = [...edges.values()];
    if (nv.reciprocalOnly) list = list.filter(e => e.reciprocal);
    if (nv.sameSiteOnly)   list = list.filter(e => e.sameSite);

    // Degree, for the cap and for node sizing.
    const deg = new Map();
    for (const e of list) {
      deg.set(e.a.key, (deg.get(e.a.key) || 0) + 1);
      deg.set(e.b.key, (deg.get(e.b.key) || 0) + 1);
    }

    // Isolated nodes go, except the ones the operator explicitly searched for —
    // an address with no bit-neighbours in the file is a real answer, and it
    // should be visible rather than vanish into an empty canvas.
    nodes = nodes.filter(n => deg.get(n.key) || hits.has(n));

    // The cap. Highest degree first, with search hits pinned in front so a
    // deliberate query is never the thing that gets trimmed.
    const total = nodes.length;
    let capped = false;
    if (nodes.length > NV_MAX_NODES) {
      capped = true;
      nodes.sort((a, b) =>
        (hits.has(b) - hits.has(a)) || ((deg.get(b.key) || 0) - (deg.get(a.key) || 0)));
      nodes = nodes.slice(0, NV_MAX_NODES);
      const keep = new Set(nodes.map(n => n.key));
      list = list.filter(e => keep.has(e.a.key) && keep.has(e.b.key));
    }

    // Which nodes earn a name. Under the cap, everything; over it, the search
    // hits and then the best-connected, because a hub is the node whose identity
    // a reader actually needs to place the cluster around it.
    const budget = labelBudget();
    const labelled = new Set();
    if (nodes.length <= budget) {
      for (const n of nodes) labelled.add(n.key);
    } else {
      [...nodes]
        .sort((a, b) => (hits.has(b) - hits.has(a)) || ((deg.get(b.key) || 0) - (deg.get(a.key) || 0)))
        .slice(0, budget)
        .forEach(n => labelled.add(n.key));
    }

    const unresolved = nodes.filter(n => n.unresolved).length;
    nv.vis = { nodes, edges: list, deg, hits, total, capped, expandCapped, unresolved, labelled, budget };
    return nv.vis;
  }

  // ── layout ────────────────────────────────────────────────────────────────────

  function posFor(node, i) {
    let p = nv.pos.get(node.key);
    if (p) return p;
    // New nodes land on a phyllotaxis spiral around the centre, as in the
    // original — an even scatter with no two nodes on top of each other, which a
    // random placement cannot promise. The spacing follows the spread control
    // rather than the original's fixed 8px: a starting arrangement packed tighter
    // than the layout wants costs the grid above its whole advantage on the first
    // few frames, when every node is still in one cell.
    const a = i * 2.399, r = 40 + nv.spread * 0.2 * Math.sqrt(i);
    p = { x: nv.w / 2 + Math.cos(a) * r, y: nv.h / 2 + Math.sin(a) * r, vx: 0, vy: 0 };
    nv.pos.set(node.key, p);
    return p;
  }

  // Every pair, as the original had it. A spatial grid was tried here to make it
  // O(n · neighbours) and measured slower — at the cap this loop is 1.3 ms a
  // frame, and the Map lookups a grid needs cost more than the square roots it
  // saves at that size. What actually costs a frame is rasterising the result,
  // which is why the cap above is on what gets drawn.
  function iterate(nodes, edges) {
    const cx = nv.w / 2, cy = nv.h / 2;
    const ps = nodes.map(n => n.p);
    for (let i = 0; i < ps.length; i++) {
      const u = ps[i];
      for (let j = i + 1; j < ps.length; j++) {
        const v = ps[j];
        const dx = v.x - u.x, dy = v.y - u.y;
        const d2 = dx * dx + dy * dy + 0.1, d = Math.sqrt(d2), f = NV_REPULSION / d2;
        u.vx -= dx / d * f; u.vy -= dy / d * f;
        v.vx += dx / d * f; v.vy += dy / d * f;
      }
    }
    for (const e of edges) {
      const u = e.pa, v = e.pb;
      const dx = v.x - u.x, dy = v.y - u.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      // Group-by-site pulls same-station addresses into a tight knot, so a site
      // reads as one thing with its neighbours hanging off it.
      const want = (nv.siteMode && e.sameSite) ? 34 : nv.spread;
      const f = (d - want) * NV_SPRING;
      u.vx += dx / d * f; u.vy += dy / d * f;
      v.vx -= dx / d * f; v.vy -= dy / d * f;
    }
    for (const p of ps) {
      p.vx += (cx - p.x) * NV_CENTRING;
      p.vy += (cy - p.y) * NV_CENTRING;
      p.vx *= NV_DAMPING; p.vy *= NV_DAMPING;
      p.x += p.vx; p.y += p.vy;
    }
  }

  // Site mode gets a deterministic starting arrangement — one ring of addresses
  // per station, laid out on a grid — rather than asking the force layout to
  // discover the grouping it has been told about.
  function siteLayout() {
    const V = nv.vis; if (!V) return;
    const groups = new Map();
    for (const n of V.nodes) {
      const k = n.stationId || n.key;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    const gs = [...groups.values()];
    const cols = Math.max(1, Math.ceil(Math.sqrt(gs.length)));
    const rows = Math.max(1, Math.ceil(gs.length / cols));
    const stepX = nv.w / (cols + 1), stepY = nv.h / (rows + 1);
    const f = nv.spread / 105;
    gs.forEach((g, i) => {
      const x = nv.w / 2 + (stepX * (1 + i % cols) - nv.w / 2) * f;
      const y = nv.h / 2 + (stepY * (1 + Math.floor(i / cols)) - nv.h / 2) * f;
      g.forEach((n, j) => {
        const a = 2 * Math.PI * j / g.length;
        n.p.x = x + Math.cos(a) * (g.length > 1 ? 22 : 0);
        n.p.y = y + Math.sin(a) * (g.length > 1 ? 22 : 0);
        n.p.vx = n.p.vy = 0;
      });
    });
    tick();
  }

  // ── the animation loop ────────────────────────────────────────────────────────
  // One place decides whether the simulation runs, and it checks that the tab is
  // still the open one every frame. A force layout left ticking behind another
  // tab is exactly the sort of idle CPU the performance pass went looking for.

  function start(energy) {
    nv.alpha = Math.max(nv.alpha, energy == null ? 1 : energy);
    if (!nv.raf) nv.raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (nv.raf) cancelAnimationFrame(nv.raf);
    nv.raf = null;
    nv.alpha = 0;
    stopNvMap();
  }

  function frame() {
    nv.raf = null;
    // Belt and braces: switchTab stops us on the way out, and this catches every
    // other way the tab can stop being on screen (a file load, a re-render, the
    // window going to the background).
    if (state.activeTab !== 'network' || !document.getElementById('nv-svg') || document.hidden) {
      nv.alpha = 0;
      return;
    }
    const V = nv.vis;
    if (!V || !V.nodes.length) return;
    // Fewer passes as the graph grows, so a frame costs about the same either way.
    const n = V.nodes.length;
    const passes = n > 300 ? 1 : n > 120 ? 2 : 3;
    for (let i = 0; i < passes; i++) iterate(V.nodes, V.edges);
    tick();
    // Keep the whole graph framed as it relaxes, not just once it has stopped.
    // A layout that settles over four seconds spends those four seconds walking
    // off the edges of the stage if the view is only fitted at the end, and the
    // snap back when it finishes is worse than the sprawl. Fitting every frame
    // tracks it smoothly, because the layout itself moves smoothly. Someone who
    // has panned or zoomed since the last filter change has said where they want
    // to be looking, and is left there.
    if (!nv.userMoved) fit();
    nv.alpha *= NV_ALPHA_DECAY;
    if (nv.alpha > NV_ALPHA_MIN) nv.raf = requestAnimationFrame(frame);
    else nv.alpha = 0;
  }

  // ── drawing ───────────────────────────────────────────────────────────────────

  function radius(n) {
    const V = nv.vis;
    const d = (V && V.deg.get(n.key)) || 0;
    return 5 + Math.min(10, Math.sqrt(d) * 2.5);
  }

  // Build the SVG once per visible-set change. Positions are then written by
  // tick() on every frame, and nothing else touches the DOM — the original
  // re-ran querySelectorAll for every node and label on every tick.
  function draw() {
    const svg = document.getElementById('nv-svg');
    if (!svg) return;
    const V = nv.vis || computeVisible();
    V.nodes.forEach((n, i) => { n.p = posFor(n, i); });
    for (const e of V.edges) { e.pa = nv.pos.get(e.a.key); e.pb = nv.pos.get(e.b.key); }

    const world = svg.querySelector('#nv-world');
    const eg = svg.querySelector('#nv-edges');
    const cg = svg.querySelector('#nv-confirmed');
    const ng = svg.querySelector('#nv-nodes');

    // Computed edges are symmetric and there can be thousands, so they are merged
    // into one <path> per style bucket: four attribute writes a frame instead of
    // four per edge. Confirmed edges stay individual <line>s because they are
    // directed — an arrowhead only renders at the end of a path, so a merged path
    // would lose every arrow but the last.
    const buckets = [
      { cls: 'nv-edge nv-edge--same',  test: e => e.sameSite },
      { cls: 'nv-edge',                test: e => !e.sameSite },
    ];
    const computed = V.edges.filter(e => e.computed && !e.confirmed);
    eg.innerHTML = buckets.map((b, i) => `<path class="${b.cls}" data-b="${i}"/>`).join('');
    const paths = buckets.map((b, i) => ({
      el: eg.querySelector(`[data-b="${i}"]`),
      edges: computed.filter(b.test),
    }));

    const confirmed = V.edges.filter(e => e.confirmed);
    cg.innerHTML = confirmed.map((e, i) => {
      const cls = 'nv-conf' + (e.reciprocal ? ' nv-conf--recip' : '') + (e.sameSite ? ' nv-conf--same' : '');
      return `<line class="${cls}" data-c="${i}" marker-end="url(#nv-arrow)"/>`;
    }).join('');
    const lines = confirmed.map((e, i) => ({ el: cg.querySelector(`[data-c="${i}"]`), e }));

    ng.innerHTML = V.nodes.map(n => {
      const r   = radius(n);
      const hit = V.hits.has(n) ? ' nv-node--hit' : '';
      const un  = n.unresolved ? ' nv-node--unresolved' : '';
      const label = V.labelled.has(n.key)
        ? `<text class="nv-label" x="${(r + 5).toFixed(1)}" y="-8">${esc(n.name)} · ${n.addr}</text>`
        : '';
      return `<g class="nv-node${hit}${un}" data-k="${escAttr(n.key)}" tabindex="0" role="button"
                 aria-label="${escAttr(n.name + ' address ' + n.addr)}">
                <circle r="${r.toFixed(1)}" fill="${nodeColour(n)}"/>${label}
              </g>`;
    }).join('');
    const nodeEls = [...ng.children].map((el, i) => ({ el, n: V.nodes[i] }));

    nv.els = { paths, lines, nodes: nodeEls, world };
    svg.classList.toggle('nv-hide-labels', !nv.labels);
    applyView();
    bind();
    tick();
    updateChrome();
  }

  // Per-frame position write. Every node is one transform, every computed bucket
  // one path, and only the handful of confirmed lines cost four attributes each.
  function tick() {
    const els = nv.els; if (!els) return;
    for (const item of els.nodes) {
      const p = item.n.p;
      item.el.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    }
    for (const b of els.paths) {
      let d = '';
      for (const e of b.edges) {
        d += `M${e.pa.x.toFixed(1)} ${e.pa.y.toFixed(1)}L${e.pb.x.toFixed(1)} ${e.pb.y.toFixed(1)}`;
      }
      b.el.setAttribute('d', d);
    }
    for (const item of els.lines) {
      const e = item.e;
      // Direction: the first observed candidate → target ordering. Reciprocal
      // pairs are drawn as one line and flagged, rather than as two overlapping.
      const dir = e.dirs[0];
      const from = dir ? nv.pos.get(dir.from.key) : e.pa;
      const to   = dir ? nv.pos.get(dir.to.key)   : e.pb;
      // Stop the line short of the target so the arrowhead lands on the rim of
      // the circle rather than inside it.
      const dx = to.x - from.x, dy = to.y - from.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 1;
      const back = radius(dir ? dir.to : e.b) + 7;
      item.el.setAttribute('x1', from.x.toFixed(1));
      item.el.setAttribute('y1', from.y.toFixed(1));
      item.el.setAttribute('x2', (to.x - dx / d * back).toFixed(1));
      item.el.setAttribute('y2', (to.y - dy / d * back).toFixed(1));
    }
  }

  function applyView() {
    const w = nv.els && nv.els.world;
    if (!w) return;
    w.setAttribute('transform', `translate(${nv.view.tx} ${nv.view.ty}) scale(${nv.view.scale})`);
    // Text and stroke widths are in world units, so a view fitted to 146 nodes
    // renders 10px labels at four. The scale goes to CSS, which divides the label
    // size back out and holds the edges to a screen width (see --nv-scale in
    // styles.css) — the graph stays readable at whatever zoom it is framed at.
    const svg = w.ownerSVGElement || document.getElementById('nv-svg');
    if (svg) svg.style.setProperty('--nv-scale', nv.view.scale.toFixed(4));
  }

  // ── interaction ───────────────────────────────────────────────────────────────

  function svgPoint(ev, el) {
    const svg = document.getElementById('nv-svg');
    if (!svg || !svg.createSVGPoint) return { x: 0, y: 0 };
    const p = svg.createSVGPoint();
    p.x = ev.clientX; p.y = ev.clientY;
    const ctm = (el || svg).getScreenCTM();
    return ctm ? p.matrixTransform(ctm.inverse()) : { x: 0, y: 0 };
  }

  function bind() {
    const els = nv.els; if (!els) return;
    for (const item of els.nodes) {
      const el = item.el, n = item.n;
      el.onpointerdown = ev => {
        ev.preventDefault(); ev.stopPropagation();
        // Dragging a node brings its neighbourhood with it, three hops out and
        // weakening as it goes — the standalone build's nicest touch, and the
        // one that makes a hairball explorable by hand.
        const dist = new Map([[n.key, 0]]);
        const queue = [n];
        while (queue.length) {
          const x = queue.shift(), z = dist.get(x.key);
          if (z >= 3) continue;
          for (const e of (nv.vis ? nv.vis.edges : [])) {
            const y = e.a === x ? e.b : e.b === x ? e.a : null;
            if (y && !dist.has(y.key)) { dist.set(y.key, z + 1); queue.push(y); }
          }
        }
        const start = svgPoint(ev, els.world);
        nv.drag = {
          key: n.key, start,
          items: [...dist].map(([k, z]) => {
            const p = nv.pos.get(k);
            return p ? { p, z, x0: p.x, y0: p.y } : null;
          }).filter(Boolean),
        };
        try { el.setPointerCapture(ev.pointerId); } catch (_) {}
      };
      el.onpointermove = ev => {
        if (!nv.drag || nv.drag.key !== n.key) return;
        const p = svgPoint(ev, els.world);
        const dx = p.x - nv.drag.start.x, dy = p.y - nv.drag.start.y;
        for (const o of nv.drag.items) {
          const f = o.z ? Math.pow(0.55, o.z) : 1;
          o.p.x = o.x0 + dx * f; o.p.y = o.y0 + dy * f;
          o.p.vx = o.p.vy = 0;
        }
        tick();
      };
      el.onpointerup = () => { if (nv.drag) { nv.drag = null; start(0.35); } };
      el.onpointercancel = () => { nv.drag = null; };
      el.onmouseenter = ev => showTip(ev, n);
      el.onmouseleave = hideTip;
      el.onclick = ev => { ev.stopPropagation(); select(n.key); };
      el.onkeydown = ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(n.key); }
      };
    }
  }

  function showTip(ev, n) {
    const tip = document.getElementById('nv-tip');
    const stage = document.getElementById('nv-stage');
    if (!tip || !stage) return;
    const deg = (nv.vis && nv.vis.deg.get(n.key)) || 0;
    const conf = (n.confirmed || []).length;
    tip.innerHTML = `<b>${esc(n.name)}</b><br>ALERT ${n.addr}`
      + `<br><span class="small">${esc(n.types.join(' · ') || 'No sensor type')}`
      + `<br>${deg} link${deg === 1 ? '' : 's'} in view`
      + (conf ? ` · ${conf} confirmed` : '')
      + (n.unresolved ? '<br>Not in the loaded station file' : '')
      + '</span>';
    const r = stage.getBoundingClientRect();
    tip.style.left = Math.min(r.width - 220, ev.clientX - r.left + 14) + 'px';
    tip.style.top  = (ev.clientY - r.top + 14) + 'px';
    tip.hidden = false;
  }

  function hideTip() {
    const tip = document.getElementById('nv-tip');
    if (tip) tip.hidden = true;
  }

  function stageBind() {
    const svg = document.getElementById('nv-svg');
    if (!svg) return;
    svg.onpointerdown = ev => {
      if (ev.target !== svg && ev.target.tagName !== 'rect') return;
      nv.pan = { p: svgPoint(ev, svg), tx: nv.view.tx, ty: nv.view.ty };
    };
    svg.onpointermove = ev => {
      if (!nv.pan || nv.drag) return;
      const p = svgPoint(ev, svg);
      nv.view.tx = nv.pan.tx + p.x - nv.pan.p.x;
      nv.view.ty = nv.pan.ty + p.y - nv.pan.p.y;
      nv.userMoved = true;
      applyView();
    };
    svg.onpointerup = () => { nv.pan = null; };
    svg.onpointerleave = () => { nv.pan = null; hideTip(); };
    svg.addEventListener('wheel', ev => {
      ev.preventDefault();
      const z = Math.exp(-ev.deltaY * 0.001);
      const p = svgPoint(ev, svg);
      nv.view.tx = p.x - (p.x - nv.view.tx) * z;
      nv.view.ty = p.y - (p.y - nv.view.ty) * z;
      nv.view.scale *= z;
      nv.userMoved = true;
      applyView();
    }, { passive: false });
    svg.onclick = ev => { if (ev.target === svg) select(null); };
  }

  // ── the detail card, and the way out to the map ───────────────────────────────

  function select(key) {
    nv.sel = key;
    renderDetail();
  }

  function renderDetail() {
    const el = document.getElementById('nv-detail');
    if (!el) return;
    const g = buildGraph();
    const n = nv.sel && g.nodes.get(nv.sel);
    if (!n) { el.hidden = true; el.innerHTML = ''; return; }

    const inbound  = (n.confirmed || []).filter(l => l.b === n);
    const outbound = (n.confirmed || []).filter(l => l.a === n);
    const neigh    = nv.showComputed ? computedNeighbours(n) : [];

    const linkRows = (list, dir) => list.length ? list.map(l => {
      const o = dir === 'in' ? l.a : l.b;
      return `<div class="nv-rel">
        <b>${dir === 'in' ? '←' : '→'} ${esc(o.name)}</b>
        <span class="small">ALERT ${o.addr}${o.types.length ? ' · ' + esc(o.types[0]) : ''}</span>
        ${l.evidence.length ? `<span class="small nv-ev">${esc(l.evidence.join(', '))}</span>` : ''}
      </div>`;
    }).join('') : '<p class="small" style="color:var(--muted);margin:.2rem 0">None</p>';

    const site = (n.stationId && state.data) ? state.data.stations.find(s => s.id === n.stationId) : null;
    const arro = site ? arroSiteUrl(arroSiteId(site)) : null;

    el.hidden = false;
    el.innerHTML = `
      <button class="nv-close" onclick="NetworkView.select(null)" title="Close" aria-label="Close">×</button>
      <h3>${esc(n.name)}</h3>
      <p class="small" style="color:var(--muted);margin:.15rem 0 .6rem">
        ALERT <strong>${n.addr}</strong>${n.number ? ` · Site ${esc(n.number)}` : ''}
        ${n.types.length ? `<br>${esc(n.types.join(' · '))}` : ''}
        ${n.role ? `<br>${esc(ROLE_LABEL[n.role] || n.role)}` : ''}
        ${n.networks.length ? `<br>${esc(n.networks.join(', '))}` : ''}
        ${n.cluster ? `<br>Confirmed cluster ${n.cluster}` : ''}
      </p>
      ${n.unresolved
        ? `<p class="small nv-warn">This end of a confirmed relationship has no match in the loaded
             station file — it can be read here, but it cannot be shown on the map.</p>`
        : `<div class="button-row" style="margin-bottom:.6rem">
             <button class="primary" onclick="NetworkView.showOnMap('${escAttr(n.key)}')">Show on map</button>
             ${arro ? `<a class="nv-link" href="${esc(arro)}" target="_blank" rel="noopener">ARRO site ↗</a>` : ''}
           </div>`}
      <h4>Incoming candidate data</h4>${linkRows(inbound, 'in')}
      <h4>Outgoing to targets</h4>${linkRows(outbound, 'out')}
      <h4>One bit away (${neigh.length})</h4>
      ${neigh.length
        ? `<div class="nv-neigh">${neigh.slice(0, 24).map(o =>
            `<button class="nv-chip" onclick="NetworkView.focus('${escAttr(o.key)}')"
                     title="${escAttr(o.name)}">${o.addr} <span>${esc(o.name)}</span></button>`).join('')}
           ${neigh.length > 24 ? `<p class="small" style="color:var(--muted)">…and ${neigh.length - 24} more</p>` : ''}</div>`
        : '<p class="small" style="color:var(--muted);margin:.2rem 0">No address in the file is one bit from this one.</p>'}`;
  }

  // Jump the graph to another node: select it, and make sure it is on screen by
  // searching for its address if the current view does not already hold it.
  function focus(key) {
    const g = buildGraph();
    const n = g.nodes.get(key);
    if (!n) return;
    const present = nv.vis && nv.vis.nodes.some(x => x.key === key);
    if (!present) {
      nv.search = String(n.addr);
      const box = document.getElementById('nv-search');
      if (box) box.value = nv.search;
      refresh(true);
    }
    select(key);
  }

  // One node → the Stations tab, focused on the station behind it. goToStation
  // already selects, scrolls and pans; there is no second way to do this and this
  // tab should not invent one.
  function showOnMap(key) {
    const g = buildGraph();
    const n = g.nodes.get(key);
    if (!n || !n.stationId) return;
    goToStation(n.stationId);
  }

  // The visible node set → the Stations map as a selection. state.mapSelection is
  // the mechanism the map already has for "these specific stations, whatever the
  // filters say", so the graph hands its answer to that rather than rewriting the
  // search box and hoping.
  function showAllOnMap() {
    const V = nv.vis || computeVisible();
    const ids = new Set();
    let unresolved = 0;
    for (const n of V.nodes) {
      if (n.stationId) ids.add(n.stationId); else unresolved++;
    }
    if (!ids.size) {
      note('Nothing in view resolves to a station in the loaded file.');
      return;
    }
    addToMapSelection([...ids]);
    switchTab('stations');
    // After the tab has rendered, so the note lands on the map that is now there.
    mapNote(`${ids.size} station${ids.size === 1 ? '' : 's'} from the network view selected`
      + (unresolved ? ` · ${unresolved} graph node${unresolved === 1 ? '' : 's'} had no match in this file` : '')
      + '.', 6000);
  }

  // ── repeaters open to the visible stations ──────────────────────────────────
  // A third relationship, alongside the graph's computed and confirmed edges:
  // which repeaters' pass ranges carry an address currently in view (the same
  // passRangeCoversId test the Bit Flipper and Pass Ranges tabs use). It has
  // nothing to do with bit-adjacency or observed ghosting — a repeater here is
  // a candidate carrier for a station in view, not a party to any edge on this
  // graph. One lookup feeds both the card below the graph and the map overlay,
  // so the two are provably listing the same set (same reasoning as nv.vis
  // feeding both the graph and refreshNvMap).
  function visibleRepeaterInfo() {
    const info = new Map(); // repeater id → { station, stations:Set(station), addrs:Set(number) }
    if (!state.data) return info;
    const V = nv.vis;
    if (!V) return info;
    const stationsById = new Map(state.data.stations.map(s => [s.id, s]));
    const seen = new Set();
    for (const n of V.nodes) {
      if (!n.stationId || seen.has(n.stationId)) continue;
      seen.add(n.stationId);
      const s = stationsById.get(n.stationId);
      if (!s) continue;
      for (const r of findRepeaterMatches(s)) {
        if (!info.has(r.id)) info.set(r.id, { station: r, stations: new Set(), addrs: new Set() });
        const rec = info.get(r.id);
        rec.stations.add(s);
        stationAlertIds(s).forEach(id => { if (passRangeCoversId(r.repeater, id)) rec.addrs.add(id); });
      }
    }
    return info;
  }

  function repeatersHtml() {
    const info = [...visibleRepeaterInfo().values()]
      .sort((a, b) => a.station.name.localeCompare(b.station.name));
    if (!info.length) {
      return `<p class="small" style="color:var(--muted)">
        No repeater's pass ranges cover an ALERT address currently in view.
      </p>`;
    }
    return `
      <div class="table-wrap medium">
        <table>
          <thead><tr><th>Repeater</th><th>Open to (in view)</th><th>Addresses carried</th></tr></thead>
          <tbody>
            ${info.map(({ station: r, stations, addrs }) => {
              const served = [...stations].sort((a, b) => a.name.localeCompare(b.name));
              return `
              <tr onclick="goToStation('${escAttr(r.id)}')" style="cursor:pointer"
                  title="Open ${escAttr(r.name)} on the Stations tab">
                <td>${esc(r.name)}</td>
                <td class="small">${served.map(s => esc(s.name)).join(', ')}</td>
                <td class="small">${[...addrs].sort((a, b) => a - b).join(', ')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // Called wherever nv.vis changes — see updateChrome, which every path that
  // rebuilds the visible set already runs through.
  function updateRepeaterCard() {
    const el = document.getElementById('nv-repeaters');
    if (el) el.innerHTML = repeatersHtml();
  }

  // ── the map panel ────────────────────────────────────────────────────────────
  // A second, geographic view of the same visible set the graph is drawing, side
  // by side with it. It reads nv.vis rather than re-querying state.data, so the
  // two panels are provably showing the same nodes and edges — there is only one
  // filter, one cap (NV_MAX_NODES, already applied before either panel draws) and
  // one place that decides what is "in view". Reuses the Stations map's own
  // rendering approach (circleMarker pins, polyline links, addBaseLayers) rather
  // than building a second map stack from scratch.

  function initNvMap() {
    stopNvMap();
    const el = document.getElementById('nv-map-canvas');
    if (!el) return;
    // Explicit renderer for its tolerance: the pass-range and backbone lines
    // are clickable, and canvas hit-testing confined to a 1.4 px stroke isn't.
    state.nvMap = L.map('nv-map-canvas', {
      preferCanvas: true, renderer: L.canvas({ tolerance: 5 }),
    }).setView(MAP_HOME, 4);
    // The getter, not the map: stopNvMap() below sets this back to null, and
    // the shell has to see that rather than hold a removed map open (#142).
    registerLiveMap('NetworkView', () => state.nvMap);
    addBaseLayers(state.nvMap);
    refreshNvMap();
  }

  // Mirrors NetworkView.stop(): called on the way out of the tab (so a hidden map
  // is not holding tile requests and pan/zoom listeners open) and at the top of
  // every init() (so a stale instance never leaks behind a fresh one).
  function stopNvMap() {
    state.nvMap = removeMap(state.nvMap);
    state.nvMapMarkers   = [];
    state.nvMapLines     = [];
    state.nvMapArrows    = [];
    state.nvMapRepeaters = [];
    state.nvMapBackbone  = [];
  }

  // Redrawn whenever refresh(true) rebuilds the graph's own visible set — not on
  // every animation frame the force layout ticks, since the map has no layout of
  // its own to settle: a station's pin sits at its real coordinates regardless of
  // where the force simulation currently has its graph node.
  function refreshNvMap() {
    const map = state.nvMap;
    if (!map || !state.data) return;
    state.nvMapMarkers.forEach(m => m.remove());
    state.nvMapLines.forEach(l => l.remove());
    state.nvMapArrows.forEach(a => a.remove());
    state.nvMapRepeaters.forEach(x => x.remove());
    (state.nvMapBackbone || []).forEach(x => x.remove());
    state.nvMapMarkers   = [];
    state.nvMapLines     = [];
    state.nvMapArrows    = [];
    state.nvMapRepeaters = [];
    state.nvMapBackbone  = [];

    const V = nv.vis || computeVisible();

    // The graph has one node per (station, address); the map plots stations, so
    // several graph nodes can fold onto the same pin.
    const byStation = new Map();
    for (const n of V.nodes) {
      if (!n.stationId) continue;
      if (!byStation.has(n.stationId)) byStation.set(n.stationId, []);
      byStation.get(n.stationId).push(n);
    }
    const stationsById = new Map(state.data.stations.map(s => [s.id, s]));
    const stations = [...byStation.keys()]
      .map(id => stationsById.get(id))
      .filter(s => s && s.lat != null && s.lon != null);
    const located = new Set(stations.map(s => s.id));
    const byId = new Map(stations.map(s => [s.id, s]));

    const lineColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--map-line').trim() || '#ff6f00';
    const muted = getComputedStyle(document.documentElement)
      .getPropertyValue('--muted').trim() || '#8b98a8';

    // Same distinction the graph draws: confirmed relationships solid and at
    // full strength, computed ones dashed and quieter (nv-conf vs nv-edge).
    // Computed first, so a confirmed line drawn between the same two stations
    // is not painted over by it.
    const ordered = [...V.edges].sort((a, b) => (a.confirmed === b.confirmed) ? 0 : a.confirmed ? 1 : -1);
    for (const e of ordered) {
      const sa = e.a.stationId, sb = e.b.stationId;
      if (!sa || !sb || sa === sb || !located.has(sa) || !located.has(sb)) continue;
      const A = byId.get(sa), B = byId.get(sb);
      const line = L.polyline([[A.lat, A.lon], [B.lat, B.lon]], {
        color:     e.confirmed ? lineColor : muted,
        weight:    e.confirmed ? (e.reciprocal ? 3 : 2.2) : 1.3,
        opacity:   e.confirmed ? 0.9 : 0.55,
        dashArray: e.confirmed ? null : '4,3',
      }).addTo(map);
      state.nvMapLines.push(line);

      // Direction only exists for confirmed relationships — a computed one-bit
      // pair has none to show. One arrowhead per recorded candidate → target
      // direction (two, opposite ways, for a genuinely reciprocal pair), dropped
      // at the midpoint so it reads against the line rather than hiding behind
      // a pin at either end.
      if (!e.confirmed) continue;
      const seen = new Set();
      for (const dir of e.dirs) {
        const fromS = byId.get(dir.from.stationId), toS = byId.get(dir.to.stationId);
        if (!fromS || !toS || fromS.id === toS.id) continue;
        const dk = fromS.id + '>' + toS.id;
        if (seen.has(dk)) continue;
        seen.add(dk);
        const brg = bearingDeg(fromS.lat, fromS.lon, toS.lat, toS.lon);
        const mid = [(fromS.lat + toS.lat) / 2, (fromS.lon + toS.lon) / 2];
        const arrow = L.marker(mid, {
          icon: L.divIcon({
            className: 'nv-map-arrow',
            html: `<svg width="14" height="14" viewBox="0 0 14 14" style="transform:rotate(${(brg - 90).toFixed(1)}deg)"><path d="M1,1 L13,7 L1,13 Z" fill="${lineColor}"/></svg>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7],
          }),
          interactive: false,
          keyboard: false,
        }).addTo(map);
        state.nvMapArrows.push(arrow);
      }
    }

    // Repeaters open to the stations in view, by pass range (see
    // visibleRepeaterInfo) — not a ghosting relationship, so drawn with a
    // colour and a shape neither edge style above uses: a diamond joined by a
    // fine dotted line, rather than the solid/dashed lines that mean "this is
    // an edge of the graph". Drawn before the station pins below so a station
    // circle always ends up on top of a repeater diamond sharing its spot.
    const repeaterCoords = [];
    // Repeaters actually on this map — as a diamond or as one of the station
    // pins — so the backbone layer below never draws a path to an off-map end.
    const drawnRepIds = new Set(
      stations.filter(s => s.roles.includes('repeater')).map(s => s.id));
    for (const { station: r, stations: served } of visibleRepeaterInfo().values()) {
      if (r.lat == null || r.lon == null) continue;
      const servedLocated = [...served].filter(s => located.has(s.id));
      if (!servedLocated.length) continue;
      repeaterCoords.push([r.lat, r.lon]);
      drawnRepIds.add(r.id);

      // Only pin the repeater itself if it is not already on the map as one of
      // the stations in view — a repeater that is itself a graph node keeps its
      // one pin rather than getting a second, different-shaped one on top of it.
      if (!located.has(r.id)) {
        const marker = L.marker([r.lat, r.lon], {
          icon: L.divIcon({
            className: 'nv-repeater-pin',
            html: `<span style="background:${NV_REPEATER_COLOR}"></span>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7],
          }),
        }).addTo(map);
        marker.bindTooltip(`${esc(r.name)} — pass-range coverage, not a link`, {
          direction: 'top', offset: [0, -8],
        });
        marker.bindPopup(`
          <strong>${esc(r.name)}</strong>
          <span style="background:${NV_REPEATER_COLOR};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem;margin-left:4px">pass range</span>
          <br><span style="font-size:.82rem;margin-top:4px;display:block">
            Open to ${servedLocated.map(s => esc(s.name)).join(', ')} by pass range —
            not a ghosting relationship.
          </span>
        `);
        marker.on('click', () => goToStation(r.id));
        state.nvMapRepeaters.push(marker);
      }

      for (const s of servedLocated) {
        const line = L.polyline([[r.lat, r.lon], [s.lat, s.lon]], {
          color:     NV_REPEATER_COLOR,
          weight:    1.4,
          opacity:   0.55,
          dashArray: '1,6',
        }).addTo(map);
        // A radio path is a radio path on every map: clicking it answers the
        // same questions here as on the Stations map, popup-sized, with the
        // hand-off to the full three-card treatment inside it.
        line.bindPopup(() => MapBackbone.popupHtml('field', s.id, r.id));
        state.nvMapRepeaters.push(line);
      }
    }

    // Repeater backbone paths (see map-backbone.js): black over the coverage
    // lines, under the pins, and only between repeaters already on this map so
    // the auto-fit extent stays what the graph put there.
    const backboneColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--map-backbone').trim() || '#000000';
    for (const p of backboneLinks(state.mapMaxLinkKm)) {
      if (!drawnRepIds.has(p.a.id) || !drawnRepIds.has(p.b.id)) continue;
      const casing = L.polyline([[p.a.lat, p.a.lon], [p.b.lat, p.b.lon]], {
        color: '#ffffff', weight: 4.5, opacity: 0.7,
      }).addTo(map);
      const line = L.polyline([[p.a.lat, p.a.lon], [p.b.lat, p.b.lon]], {
        color: backboneColor, weight: 2.5, opacity: 0.95,
      }).addTo(map);
      line.bindPopup(() => MapBackbone.popupHtml('backbone', p.a.id, p.b.id));
      state.nvMapBackbone.push(casing, line);
    }

    for (const s of stations) {
      const role  = primaryRole(s);
      const color = ROLE_COLOR[role] || ROLE_COLOR.field;
      // A search hit wears the amber ring on the map the same way it does on the
      // graph — the one highlight the two panels already agree on, so spotting a
      // cluster in one and finding it in the other needs no second mechanism.
      const hit = byStation.get(s.id).some(n => V.hits.has(n));
      const marker = L.circleMarker([s.lat, s.lon], {
        radius:      (s.roles.includes('repeater') ? 8 : 5) + (hit ? 1 : 0),
        color:       hit ? MAP_PIN_HIT : MAP_PIN_RING,
        weight:      hit ? 3 : 2,
        fillColor:   color,
        fillOpacity: 1,
        opacity:     1,
        className:   hit ? 'mn-pin mn-pin-hit' : 'mn-pin',
      }).addTo(map);
      marker.bindTooltip(esc(s.name), { direction: 'top', offset: [0, -6] });
      // goToStation already selects, scrolls and pans on the Stations tab; there
      // is no second way to do this and this panel should not invent one.
      marker.on('click', () => goToStation(s.id));
      state.nvMapMarkers.push(marker);
    }

    const note = document.getElementById('nv-map-note');
    if (note) {
      const missing = byStation.size - stations.length;
      const bits = [stations.length
        ? `${stations.length} station${stations.length === 1 ? '' : 's'} mapped`
        : 'Nothing in view has coordinates to plot.'];
      if (missing) bits.push(`${missing} in view ${missing === 1 ? 'has' : 'have'} no coordinates`);
      note.textContent = bits.join(' · ');
    }

    if (stations.length) {
      map.fitBounds(stations.map(s => [s.lat, s.lon]).concat(repeaterCoords), { padding: [24, 24], maxZoom: 13 });
    }
  }

  // ── import / export ───────────────────────────────────────────────────────────

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const head = rows.shift();
    if (!head) return [];
    return rows.filter(r => r.some(Boolean))
      .map(r => Object.fromEntries(head.map((k, i) => [k.trim(), (r[i] || '').trim()])));
  }

  // CSV import is an *additional* source of confirmed relationships, not the only
  // one it used to be: the nodes come from stations.json now, so a dropped file
  // only has to say which addresses were observed ghosting into which.
  async function importFiles(files) {
    if (!files || !files.length) return;
    const added = [];
    let skipped = 0;
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const u = new Uint8Array(buf);
        const enc = (u[0] === 255 && u[1] === 254) ? 'utf-16le' : 'utf-8';
        const rows = parseCsv(new TextDecoder(enc).decode(buf).replace(/^\uFEFF/, ''));
        if (!rows.length || !('source_sensor_id' in rows[0] || 'source_alert' in rows[0])) { skipped++; continue; }
        for (const r of rows) {
          const sa = parseInt(r.source_alert, 10), ta = parseInt(r.target_alert, 10);
          if (isNaN(sa) || isNaN(ta)) continue;
          added.push(normaliseLink({
            source: r.source_sensor_id, target: r.target_sensor_id,
            source_site: r.source_site_id, target_site: r.target_site_id,
            source_alert: sa, target_alert: ta,
            source_type: r.source_type, target_type: r.target_type,
            reciprocal: String(r.reciprocal).toLowerCase() === 'true',
            same_site:  String(r.same_site).toLowerCase() === 'true',
            evidence: (r.evidence_files || r.evidence || '').split(';').map(s => s.trim()).filter(Boolean),
            origin: f.name,
          }));
        }
        nv.confSources.push(`${rows.length} from ${f.name}`);
      } catch (_) { skipped++; }
    }
    if (!nv.confirmed) nv.confirmed = { sensors: [], links: [] };
    if (added.length) {
      nv.confirmed.links = nv.confirmed.links.concat(added);
      linkConfirmed();
    }
    note(added.length
      ? `Imported ${added.length} confirmed relationship${added.length === 1 ? '' : 's'}.`
      : `Nothing imported — a links CSV needs source_alert and target_alert columns.${skipped ? ` ${skipped} file(s) skipped.` : ''}`);
    renderFacets();
    refresh(true);
  }

  // The visible links, as the standalone build exported them, plus the two columns
  // that only exist now: whether the pair was computed, confirmed, or both.
  function exportVisible() {
    const V = nv.vis || computeVisible();
    if (!V.edges.length) { note('No links in view to export.'); return; }
    const cols = ['source_site', 'source_station', 'source_alert', 'source_type',
                  'target_site', 'target_station', 'target_alert', 'target_type',
                  'relationship', 'reciprocal', 'same_site', 'evidence_files'];
    const lines = [cols.join(',')];
    for (const e of V.edges) {
      const dir = e.dirs[0];
      const a = dir ? dir.from : e.a, b = dir ? dir.to : e.b;
      lines.push([
        a.number, a.name, a.addr, a.types[0] || '',
        b.number, b.name, b.addr, b.types[0] || '',
        e.confirmed && e.computed ? 'confirmed+computed' : e.confirmed ? 'confirmed' : 'computed',
        e.reciprocal, e.sameSite, e.evidence.join('; '),
      ].map(csvEscape).join(','));
    }
    dlText('meganet_ghosting_links.csv', lines.join('\n'));
  }

  // ── control handlers ──────────────────────────────────────────────────────────

  function note(msg) {
    const el = document.getElementById('nv-note');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  // `structure` says whether the visible set has to be rebuilt (a filter moved)
  // or only redrawn (a colour or a label toggle). Rebuilding re-runs the layout.
  function refresh(structure) {
    if (structure) {
      // A different set of nodes is a different picture, so the view goes back to
      // framing itself until the operator says otherwise again.
      nv.userMoved = false;
      computeVisible();
      draw();
      refreshNvMap();
      start(0.8);
    } else {
      draw();
    }
  }

  function onSearch(v) {
    nv.search = v;
    clearTimeout(onSearch._t);
    onSearch._t = setTimeout(() => refresh(true), 180);
  }

  function toggleFacet(key, value, on) {
    const off = nv.facetOff[key] || (nv.facetOff[key] = new Set());
    if (on) off.delete(value); else off.add(value);
    refresh(true);
  }

  function setColourBy(v) { nv.colourBy = v; renderLegend(); refresh(false); }
  function setLabels(on)  { nv.labels = !!on; const s = document.getElementById('nv-svg'); if (s) s.classList.toggle('nv-hide-labels', !nv.labels); }
  function setFlag(name, on) {
    nv[name] = !!on;
    refresh(true);
  }
  function setSpread(v) {
    const next = Math.max(55, Math.min(240, Number(v) || 105));
    const ratio = next / nv.spread;
    nv.spread = next;
    const el = document.getElementById('nv-spread-val');
    if (el) el.textContent = next + '%';
    const box = document.getElementById('nv-spread');
    if (box && Number(box.value) !== next) box.value = next;
    // Scale the current arrangement about the centre so the change reads as a
    // zoom of the layout rather than a re-scatter.
    for (const p of nv.pos.values()) {
      p.x = nv.w / 2 + (p.x - nv.w / 2) * ratio;
      p.y = nv.h / 2 + (p.y - nv.h / 2) * ratio;
    }
    if (nv.siteMode) siteLayout(); else start(0.6);
  }
  function nudgeSpread(delta) { setSpread(nv.spread + delta); }

  function toggleSiteMode() {
    nv.siteMode = !nv.siteMode;
    const b = document.getElementById('nv-site');
    if (b) b.textContent = 'Group by site: ' + (nv.siteMode ? 'On' : 'Off');
    if (nv.siteMode) siteLayout(); else start(0.9);
  }

  function reset() {
    nv.search = '';
    nv.facetOff = {};
    nv.showConfirmed = true;
    nv.showComputed = true;
    nv.expand = false;
    nv.reciprocalOnly = nv.sameSiteOnly = false;
    nv.labels = true;
    nv.siteMode = false;
    nv.spread = 105;
    nv.view = { scale: 1, tx: 0, ty: 0 };
    nv.userMoved = false;
    nv.pos.clear();
    nv.sel = null;
    renderMain();
  }

  function fit() {
    const V = nv.vis;
    if (!V || !V.nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of V.nodes) {
      x0 = Math.min(x0, n.p.x); x1 = Math.max(x1, n.p.x);
      y0 = Math.min(y0, n.p.y); y1 = Math.max(y1, n.p.y);
    }
    const pad = 60;
    const s = Math.min(nv.w / Math.max(1, x1 - x0 + pad * 2), nv.h / Math.max(1, y1 - y0 + pad * 2), 2.5);
    nv.view.scale = s;
    nv.view.tx = nv.w / 2 - s * (x0 + x1) / 2;
    nv.view.ty = nv.h / 2 - s * (y0 + y1) / 2;
    nv.userMoved = false;    // asking to be framed is asking to keep being framed
    applyView();
  }

  // ── page ──────────────────────────────────────────────────────────────────────

  function statsHtml() {
    const g = buildGraph();
    const V = nv.vis;
    const conf = (nv.confirmed && nv.confirmed.resolved) ? nv.confirmed.resolved.length : 0;
    const cells = [
      ['Addresses', g.nodes.size],
      ['In view',   V ? V.nodes.length : 0],
      ['Links',     V ? V.edges.length : 0],
      ['Confirmed', conf],
    ];
    return cells.map(([k, v]) =>
      `<div class="nv-stat"><b>${v.toLocaleString()}</b><span>${k}</span></div>`).join('');
  }

  function renderLegend() {
    const el = document.getElementById('nv-legend');
    if (!el) return;
    const opts = facetOptions()[nv.colourBy] || [];
    el.innerHTML = opts.slice(0, 10).map(([v]) =>
      `<span><i class="nv-dot" style="background:${colourFor(v, nv.colourBy)}"></i>${esc(v)}</span>`).join('')
      + (opts.length > 10 ? `<span class="small" style="color:var(--muted)">+${opts.length - 10} more</span>` : '');
  }

  // The confirmed relationships arrive after the page is built, and they bring a
  // facet with them — cluster membership is a property of that file. Rebuilding
  // the panel is the only honest answer: a filter group that never appears
  // because its data was still in flight is a filter that silently does not exist.
  function renderFacets() {
    const el = document.getElementById('nv-facets');
    if (el) el.innerHTML = facetsHtml();
  }

  function facetsHtml() {
    const opts = facetOptions();
    return NV_FACETS.map(f => {
      const list = opts[f.key] || [];
      if (list.length < 2) return '';       // a facet with one value filters nothing
      const off = nv.facetOff[f.key] || new Set();
      const shown = list.slice(0, 12);
      return `
        <details class="nv-facet"${f.key === 'type' ? ' open' : ''}>
          <summary>${esc(f.label)} <span class="small">${list.length}</span></summary>
          ${shown.map(([v, n]) => `
            <label class="nv-check">
              <input type="checkbox" ${off.has(v) ? '' : 'checked'}
                     onchange="NetworkView.toggleFacet('${escAttr(f.key)}','${escAttr(v)}',this.checked)">
              <span>${esc(v)}</span><span class="small">${n}</span>
            </label>`).join('')}
          ${list.length > shown.length
            ? `<p class="small" style="color:var(--muted);margin:.3rem 0 0">
                 ${list.length - shown.length} rarer value${list.length - shown.length === 1 ? '' : 's'} not listed — use the search box.</p>`
            : ''}
        </details>`;
    }).join('');
  }

  // The line under the graph that says what is on screen and what was left off.
  function updateChrome() {
    const V = nv.vis;
    const el = document.getElementById('nv-visible');
    if (el && V) {
      const conf = V.edges.filter(e => e.confirmed).length;
      el.textContent = `${V.nodes.length} addresses · ${V.edges.length} links`
        + (conf ? ` · ${conf} confirmed` : '');
    }
    const cap = document.getElementById('nv-cap');
    if (cap && V) {
      const bits = [];
      // An empty stage needs to say why it is empty. Without a search the graph
      // starts from the confirmed relationships, so turning those off with nothing
      // typed leaves nothing to draw — which looks like a broken tab rather than
      // an answered question unless it says so.
      if (!V.nodes.length) {
        bits.push(searchTokens().length
          ? 'Nothing matches that search.'
          : nv.showConfirmed
            ? 'Nothing to draw. Search for a station or an ALERT address.'
            : 'Confirmed links are switched off, so there is no starting point — search for a station or an ALERT address, or switch them back on.');
      }
      if (V.capped) bits.push(`Showing the ${NV_MAX_NODES} best-connected of ${V.total.toLocaleString()} matching addresses — narrow the filters or search to see the rest.`);
      if (V.expandCapped) bits.push(`Neighbour expansion stopped at ${NV_EXPAND_MAX} addresses.`);
      if (V.unresolved) bits.push(V.unresolved === 1
        ? '1 node in view has no match in the loaded station file and cannot be mapped.'
        : `${V.unresolved} nodes in view have no match in the loaded station file and cannot be mapped.`);
      cap.innerHTML = bits.map(esc).join(' ');
      cap.hidden = !bits.length;
    }
    const st = document.getElementById('nv-stats');
    if (st) st.innerHTML = statsHtml();
    updateRepeaterCard();
    const src = document.getElementById('nv-source-note');
    if (src) {
      src.innerHTML = nv.confState === 'loading' ? 'Loading confirmed relationships…'
        : nv.confState === 'error' ? `Confirmed relationships unavailable (${esc(nv.confError)}) — computed links only.`
        : esc(nv.confSources.join(' · '));
    }
  }

  function render() {
    buildGraph();
    return `
      <div class="nv-layout">
        <aside class="nv-side stack">
          <div class="panel">
            <div class="panel-header"><h2>Ghosting Graph</h2></div>
            <p class="small" style="color:var(--muted);margin:.4rem 0 0">
              ALERT addresses one bit apart, drawn as a graph. Grey-blue links are
              computed from the loaded file; solid arrows are relationships that were
              actually observed, candidate → target.
            </p>
            <div class="nv-stats" id="nv-stats">${statsHtml()}</div>
            <p class="small nv-src" id="nv-source-note"></p>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>Find and focus</h3></div>
            <input id="nv-search" type="search" placeholder="Station, number or ALERT address"
                   value="${escAttr(nv.search)}" oninput="NetworkView.onSearch(this.value)">
            <p class="small" style="color:var(--muted);margin:.35rem 0 .5rem">
              Several addresses at once: paste them separated by spaces or commas.
            </p>
            <div class="button-row">
              <button onclick="NetworkView.fit()">Fit to view</button>
              <button onclick="NetworkView.reset()">Reset</button>
            </div>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>Links</h3></div>
            <label class="nv-check"><input type="checkbox" ${nv.showConfirmed ? 'checked' : ''}
              onchange="NetworkView.setFlag('showConfirmed',this.checked)"><span>Confirmed (observed)</span></label>
            <label class="nv-check"><input type="checkbox" ${nv.showComputed ? 'checked' : ''}
              onchange="NetworkView.setFlag('showComputed',this.checked)"><span>Computed (one bit apart)</span></label>
            <label class="nv-check"><input type="checkbox" ${nv.expand ? 'checked' : ''}
              onchange="NetworkView.setFlag('expand',this.checked)"><span>Pull in bit-neighbours</span></label>
            <label class="nv-check"><input type="checkbox" ${nv.reciprocalOnly ? 'checked' : ''}
              onchange="NetworkView.setFlag('reciprocalOnly',this.checked)"><span>Reciprocal only</span></label>
            <label class="nv-check"><input type="checkbox" ${nv.sameSiteOnly ? 'checked' : ''}
              onchange="NetworkView.setFlag('sameSiteOnly',this.checked)"><span>Same-site only</span></label>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>Filters</h3></div>
            <div id="nv-facets">${facetsHtml()}</div>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>Layout</h3></div>
            <label class="small" style="color:var(--muted)">Colour by
              <select id="nv-colour" onchange="NetworkView.setColourBy(this.value)" style="margin-top:.3rem">
                ${NV_FACETS.map(f => `<option value="${escAttr(f.key)}" ${nv.colourBy === f.key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
              </select>
            </label>
            <div class="nv-legend" id="nv-legend"></div>
            <div class="nv-range">
              <input id="nv-spread" type="range" min="55" max="240" value="${nv.spread}"
                     oninput="NetworkView.setSpread(this.value)" aria-label="Spread">
              <span class="nv-val" id="nv-spread-val">${nv.spread}%</span>
            </div>
            <div class="button-row">
              <button onclick="NetworkView.nudgeSpread(25)">Spread out</button>
              <button onclick="NetworkView.nudgeSpread(-25)">Tighten</button>
            </div>
            <button id="nv-site" onclick="NetworkView.toggleSiteMode()">Group by site: ${nv.siteMode ? 'On' : 'Off'}</button>
            <label class="nv-check"><input type="checkbox" ${nv.labels ? 'checked' : ''}
              onchange="NetworkView.setLabels(this.checked)"><span>Show labels</span></label>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>To the map, and out</h3></div>
            <button class="primary" onclick="NetworkView.showAllOnMap()">Show these on the map</button>
            <p class="small" style="color:var(--muted);margin:.35rem 0 .6rem">
              Hands every address in view to the Stations map as a selection.
            </p>
            <button onclick="NetworkView.exportVisible()">Export visible links</button>
          </div>

          <div class="panel">
            <div class="panel-header"><h3>Import confirmed links</h3></div>
            <div class="nv-drop" id="nv-drop">Drop a links CSV here</div>
            <input id="nv-file" type="file" accept=".csv" multiple hidden
                   onchange="NetworkView.importFiles(this.files)">
            <button onclick="document.getElementById('nv-file').click()">Open CSV file(s)</button>
            <p class="small" style="color:var(--muted);margin:.35rem 0 0">
              Needs <code>source_alert</code> and <code>target_alert</code>; <code>evidence_files</code>,
              <code>reciprocal</code> and <code>same_site</code> are used when present. Station names and
              sensor types come from the loaded file, not the CSV.
            </p>
            <p class="small" id="nv-note" hidden></p>
          </div>
        </aside>

        <div class="nv-main">
          <div class="panel nv-stage" id="nv-stage">
            <div class="nv-top">
              <span class="nv-pill" id="nv-visible"></span>
              <span class="nv-pill nv-pill--quiet">Arrows point candidate → target</span>
            </div>
            <svg id="nv-svg" role="img" aria-label="Ghosting relationship graph">
              <defs>
                <marker id="nv-arrow" viewBox="0 -5 10 10" refX="4" markerWidth="5" markerHeight="5" orient="auto">
                  <path d="M0,-5L10,0L0,5" class="nv-arrowhead"/>
                </marker>
              </defs>
              <g id="nv-world">
                <g id="nv-edges"></g>
                <g id="nv-confirmed"></g>
                <g id="nv-nodes"></g>
              </g>
            </svg>
            <div class="nv-tip" id="nv-tip" hidden></div>
            <aside class="nv-detail" id="nv-detail" hidden></aside>
            <p class="nv-cap small" id="nv-cap" hidden></p>
          </div>

          <div class="panel nv-map" id="nv-map-wrap">
            <div class="nv-top">
              <span class="nv-pill" id="nv-map-note"></span>
              <span class="nv-pill nv-pill--quiet">Arrows point candidate → target</span>
              <span class="nv-pill nv-pill--quiet">
                <i class="nv-repeater-pin nv-repeater-pin--legend"><span style="background:${NV_REPEATER_COLOR}"></span></i>
                Repeater pass-range coverage — not a ghosting link
              </span>
            </div>
            <div id="nv-map-canvas"></div>
          </div>
        </div>
      </div>

      <div class="panel" id="nv-repeaters-panel">
        <div class="panel-header"><h3>Repeaters open to the stations in view</h3></div>
        <p class="small" style="color:var(--muted);margin:.4rem 0 .6rem">
          Every repeater whose pass ranges carry an ALERT address currently in view above,
          per the same test the Pass Ranges and Bit Flipper tabs use. This is a pass-range
          relationship, not a ghosting one — these repeaters are candidate carriers for the
          stations shown, not parties to any computed or confirmed edge on the graph or map.
        </p>
        <div id="nv-repeaters">${repeatersHtml()}</div>
      </div>`;
  }

  function measure() {
    const stage = document.getElementById('nv-stage');
    const svg   = document.getElementById('nv-svg');
    if (!stage || !svg) return false;
    const r = stage.getBoundingClientRect();
    const w = Math.max(320, Math.round(r.width));
    const h = Math.max(280, Math.round(r.height));
    const same = (w === nv.w && h === nv.h);
    nv.w = w; nv.h = h;
    // The attribute is written even when the size has not moved, because a
    // re-render hands back a brand new <svg> that has never had one. Only the
    // return value is conditional — that is what decides whether the layout needs
    // re-energising, and an unchanged stage does not.
    // The world is drawn in the same units as the pixels it covers, so a resize
    // is a bigger window onto the same graph rather than a rescale of it. The
    // standalone build's fixed 1400×900 viewBox stretched everything the moment
    // the nav collapsed.
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    return !same;
  }

  function init() {
    // The force layout and the map below both have to stop when the tab is
    // left. app.js named this module to do it until #142; it says so itself
    // now, and the registry is keyed by name so repeating this is free.
    registerTabTeardown('NetworkView', stop);
    stop();
    if (!state.data) return;
    ensureConfirmed();
    measure();
    computeVisible();
    draw();
    initNvMap();
    renderLegend();
    stageBind();
    dropBind();
    fit();
    start(1);

    // The stage changes width when the nav collapses and height when the header
    // wraps. Re-measuring keeps the graph's coordinate space honest; the layout
    // is only re-centred, never re-scattered.
    if (nv.ro) nv.ro.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      nv.ro = new ResizeObserver(() => {
        if (!measure()) return;
        // A resize that crosses a label-budget boundary changes which nodes are
        // named, and that needs the graph rebuilt rather than just re-framed.
        // Every other resize is a new window onto the same picture, so it only
        // re-energises the layout enough to settle into the new shape.
        if (nv.vis && nv.vis.budget !== labelBudget()) refresh(true);
        else start(0.3);
      });
      const stage = document.getElementById('nv-stage');
      if (stage) nv.ro.observe(stage);
    }
  }

  function dropBind() {
    const drop = document.getElementById('nv-drop');
    if (!drop) return;
    for (const ev of ['dragover', 'dragenter']) {
      drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('nv-drop--active'); });
    }
    for (const ev of ['dragleave', 'drop']) {
      drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('nv-drop--active'); });
    }
    drop.addEventListener('drop', e => importFiles(e.dataTransfer && e.dataTransfer.files));
  }

  return {
    render, init, stop, invalidate,
    onSearch, toggleFacet, setColourBy, setLabels, setFlag, setSpread, nudgeSpread,
    toggleSiteMode, reset, fit, select, focus, showOnMap, showAllOnMap,
    importFiles, exportVisible,
  };
})();

