// MegaNet — map-river-lines.js
//
//   MapRiverLines   The rivers themselves: every principal named river and
//                   creek in Australia, from the Bureau of Meteorology's
//                   Geofabric, drawn on the Stations map under the pins and
//                   named along their courses — and each one a thing to point
//                   at. Hover names it; a click selects it, lit from its
//                   headwaters to its mouth, with a callout that says how much
//                   country drains through it and which of this network's
//                   stations stand on it.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, esc, escAttr, cssVar and announce;
// across to app.js for rerenderMapLegend and focusStationOnMap, and to
// map-here.js and map-move-pin.js only to ask whether one of them owns the
// click. All from inside its own functions, so this file's position among the
// modules is free. places.js asks selectNamed() for a river picked in 📍 Find
// a place.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Asked for in these words: "what I really need is the rivers themselves
// plotted on the map. They are really what we are most interested in this
// whole project, is the rivers." The map had the drainage basins
// (map-catchments.js) and a highlight that lights up the OpenStreetMap
// watercourses matching the filter box (map-rivers.js), and nothing that drew
// a river unless somebody typed its name. So this is on by default, for every
// look — the one context layer the Calm look does not start without — and
// remembered once somebody turns it off.
//
// ── The source ──────────────────────────────────────────────────────────────
// The Geofabric (Australian Hydrological Geospatial Fabric) v3.3, Surface
// Hydrology Network: the principal named watercourses of the 1:250,000
// national topographic series as one connected network, each reach with the
// area that drains through it. © Commonwealth of Australia (Bureau of
// Meteorology), CC BY 4.0. National, where the station register is — a
// quarter of its stations are outside Queensland — and named in capitals the
// way the register's `stream` is, so a river finds its gauges by name.
//
// Three ways in, one picture:
//
//   data/rivers-au.json       every river's name, size and extent, and its
//                             reaches draining 1,000 km² or more. 1.5 MB,
//                             read the first time the map opens with the
//                             switch on — never at page load — and kept by
//                             the service worker for a visit with no signal.
//   data/rivers-au/<t>.json   the smaller reaches, a 2° square at a time, read
//                             only once the map is close enough to draw them.
//   the live service          the minor named creeks — Oxley Creek, Kedron
//                             Brook — asked of Geoscience Australia's copy of
//                             the network a town's view at a time, from
//                             MINOR_MIN_ZOOM in: 600,000 segments nationally,
//                             far too many to ship, and only legible close in.
//
// tools/build_rivers.py writes both files and says why they are files.
//
// ── What is drawn at which zoom ─────────────────────────────────────────────
// A reach is in a band by the area that drains through it (the file's
// `bands`: 20,000, 5,000, 1,000, 250, 50 and 0 km²). The national view draws
// band 0 alone — the Murray, the Darling, the Burdekin, the Fitzroy — and each
// step in adds the next, so zooming in grows each river upstream rather than
// adding a confetti of creeks. The line is heavier the more drains through
// it, which is how a river map has always said which is the main stream.
//
// ── Pointer conventions ─────────────────────────────────────────────────────
// map-rivers.js's header has the discovery: the shared pins-and-links canvas
// sits above every context pane and owns every DOM event, so a path in a pane
// under it can take no pointer. Every pane here is pointer-events:none and
// every path non-interactive; hover and click are the map's own mousemove and
// click, hit-tested here against the projected lines within HIT_PX. A point
// under the pointer wins over the line it sits on — a bridge, a survey mark, a
// photo opens its own callout and this click stands down — and an armed tool
// (a draw tool, a link-budget pick, What is here, a pin being moved) owns the
// click outright. A click on open map, with nothing else taking it, puts the
// selection down. The keyboard and touch path is the note under the switch:
// one real <button> per river named in view.
const MapRiverLines = (function () {
  const DATA_URL  = 'data/rivers-au.json';
  const TILE_DIR  = 'data/rivers-au/';
  const MINOR_URL = 'https://services-ap1.arcgis.com/ypkPEy1AmwPKGNNv/arcgis/rest/services/'
                  + 'Geofabric_Surface_Hydrology_Network/FeatureServer/7/query';
  const ATTRIBUTION = 'Rivers: Geofabric © Commonwealth of Australia (Bureau of Meteorology), CC BY 4.0';

  // Over the road layers (338, 339) and the filter's OpenStreetMap highlight
  // (340), under the survey marks (345) and everything that is a point: on a
  // map about rivers, a road never draws over one. The selection over the
  // lines, the names over both.
  const PANE      = 'mnRiverLines', PANE_Z = 341;
  const PICK_PANE = 'mnRiverPick',  PICK_Z = 342;
  const NAME_PANE = 'mnRiverNames', NAME_Z = 343;

  // The deepest band drawn at a zoom. Tiles are asked for from the zoom
  // tile_band is first drawn at (8).
  function maxBand(z) { return z <= 4 ? 0 : z <= 5 ? 1 : z <= 7 ? 2 : z <= 8 ? 3 : z <= 9 ? 4 : 5; }
  // px, by band, and the minor creeks thinner again; a little heavier close in.
  const WEIGHT = [2.8, 2.4, 2.0, 1.6, 1.3, 1.1];
  const MINOR_BAND = 6, MINOR_WEIGHT = 1.0;
  function weightOf(band, z) {
    return (band >= MINOR_BAND ? MINOR_WEIGHT : WEIGHT[band]) + (z >= 13 ? 0.8 : z >= 10 ? 0.4 : 0);
  }

  const VIEW_PAD      = 0.35;   // drawn past the edge, so a small pan draws nothing new
  const TILE_CAP      = 40;     // tiles one view, or one selected river, may ask for
  const MINOR_MIN_ZOOM = 12;
  const MINOR_STEP    = 0.05;   // deg; the minor creeks' box is rounded out to this
  const MINOR_SPAN    = 0.6;    // deg; a backstop behind MINOR_MIN_ZOOM
  const MINOR_CACHE   = 30;
  const TIMEOUT_MS    = 20000;
  const FAIL_TTL      = 60000;
  const DEBOUNCE_MS   = 120;
  const TINY_PX       = 2;      // a run smaller than this on screen is not drawn
  const HIT_PX        = 8;      // hover and a mouse click, from the line's centre
  const HIT_TOUCH_PX  = 16;     // a finger
  const LABEL_CAP     = 24;
  const LABEL_MIN_PX  = 90;     // a stretch on screen shorter than this carries no name
  const LABEL_TINY_PX = 40;     // …and a run whose box is smaller is not even walked
  const LABEL_CHAR_PX = 6.6;    // the names' rough advance, for fitting and spacing
  const NOTE_BTN_CAP  = 12;
  const STATION_PAD   = 0.05;   // deg; a gauge this far outside a river's box is not on it
  const CALLOUT_STATIONS = 8;

  let map = null, timer = null, moveRaf = null;
  let netR = null, net = null, pickR = null;
  let pickLayer = null, hoverLayer = null, nameLayer = null;

  // The data. `rivers` is the national index, decoded; a tile's runs and the
  // minor creeks' join the river they belong to as they arrive.
  let data = null, loading = null, failedAt = 0;
  let rivers = [];
  const byName = new Map();          // name → [river]
  const tiles = new Map();           // key → 'loading' | true | failure time
  let tileSet = new Set();

  // What is on the map.
  const drawn = new Set();           // the runs the view draws
  let attributed = false;
  let selected = null, popup = null, hover = null, hoverTip = null, cursorSet = false;
  let foreignPopupAt = -Infinity;
  let labelled = [];                 // the rivers named in view, for the note's buttons

  // The minor creeks.
  const minorCache = new Map();      // box key → true, LRU by re-insert
  const minorSeen = new Set();       // OBJECTIDs already added
  const minorByName = new Map();     // name → a river of its own, when no major one claims it
  let minorKey = null, minorSeq = 0, minorFailedAt = 0;
  let minor = 'off';                 // 'off' | 'zoom' | 'wide' | 'loading' | 'ok' | 'fail'

  let note = 'idle';                 // 'off' | 'loading' | 'fail' | 'ok'

  // ── Words ─────────────────────────────────────────────────────────────────

  // "LOCKYER CREEK" as a person writes it — Places' rule, for the same names.
  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s\-(/])([a-z])/g, (m, a, b) => a + b.toUpperCase())
      .replace(/\bMc([a-z])/g, (m, a) => `Mc${a.toUpperCase()}`)
      .replace(/\bO['’]([a-z])/g, (m, a) => `${m.slice(0, 2)}${a.toUpperCase()}`);
  }

  // A river's name as a key for matching the register's `stream` to it:
  // Places' riverKey (CK, R, RV) and the register's other shorthands — STH and
  // NTH Johnstone, the Sth Pine, a Br for a branch.
  function riverKey(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      .replace(/\b(ck|crk)\b/g, 'creek').replace(/\b(rv|riv)\b/g, 'river').replace(/ r$/, ' river')
      .replace(/\bsth\b/g, 'south').replace(/\bnth\b/g, 'north').replace(/\bbr\b/g, 'branch')
      .replace(/\bmt\b/g, 'mount');
  }

  function kindWord(name) {
    return /\bRIVER\b|\bRIVULET\b/i.test(name) ? 'River' : /\bCREEK\b|\bBROOK\b|\bGULLY\b/i.test(name) ? 'Creek'
      : /\bCHANNEL\b|\bCANAL\b|\bANABRANCH\b|\bCUTTING\b/i.test(name) ? 'Channel' : 'Watercourse';
  }

  const fmtInt = n => Math.round(n).toLocaleString('en-AU');

  // ── Geometry ──────────────────────────────────────────────────────────────

  // An encoded polyline (Google's algorithm, latitude first) at 1/quant
  // degree, as a flat [lat, lon, lat, lon, …].
  function decodeLine(str, quant) {
    const out = [];
    let i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      let b, shift = 0, r = 0;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << shift; shift += 5; } while (b >= 32);
      lat += (r & 1) ? ~(r >> 1) : (r >> 1);
      shift = 0; r = 0;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << shift; shift += 5; } while (b >= 32);
      lon += (r & 1) ? ~(r >> 1) : (r >> 1);
      out.push(lat / quant, lon / quant);
    }
    return Float64Array.from(out);
  }

  // A run: one band's stretch of one river, with its box [s, w, n, e] and its
  // projection at one zoom, made when the pointer first needs it.
  function makeRun(river, band, ll) {
    let s = 90, w = 180, n = -90, e = -180;
    for (let i = 0; i < ll.length; i += 2) {
      if (ll[i] < s) s = ll[i];
      if (ll[i] > n) n = ll[i];
      if (ll[i + 1] < w) w = ll[i + 1];
      if (ll[i + 1] > e) e = ll[i + 1];
    }
    return { river, band, ll, box: [s, w, n, e], proj: null, projZoom: -1 };
  }

  function latLngs(run) {
    const out = new Array(run.ll.length / 2);
    for (let i = 0, j = 0; i < run.ll.length; i += 2, j++) out[j] = [run.ll[i], run.ll[i + 1]];
    return out;
  }

  function boxMeets(b, v) {   // b = [s, w, n, e]; v = L.LatLngBounds
    return !(b[0] > v.getNorth() || b[2] < v.getSouth() || b[1] > v.getEast() || b[3] < v.getWest());
  }

  // A river's extent as [s, w, n, e]: the index's box, widened by whatever
  // has joined it since.
  function riverBox(r) {
    let s = 90, w = 180, n = -90, e = -180;
    if (r.box) { [w, s, e, n] = r.box; }
    for (const run of r.runs) {
      s = Math.min(s, run.box[0]); w = Math.min(w, run.box[1]);
      n = Math.max(n, run.box[2]); e = Math.max(e, run.box[3]);
    }
    return s <= n ? [s, w, n, e] : null;
  }

  // ── The data ──────────────────────────────────────────────────────────────

  function index(j) {
    rivers = [];
    byName.clear();
    tileSet = new Set(j.tiles || []);
    for (let id = 0; id < j.rivers.length; id++) {
      const [name, area, len, box, lines] = j.rivers[id];
      const r = { id, name, title: titleCase(name), area, len, box, runs: [], minor: false };
      for (const [band, line] of lines) r.runs.push(makeRun(r, band, decodeLine(line, j.quant)));
      rivers.push(r);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(r);
    }
  }

  // Fetched once, when the map first opens with the switch on or somebody
  // picks a river in Find a place — never at page load. A failure is
  // remembered for FAIL_TTL, so a dead network costs a request a minute.
  function ensureData() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    if (Date.now() - failedAt < FAIL_TTL) return Promise.reject(new Error('failed recently'));
    loading = fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { index(j); data = j; failedAt = 0; return j; })
      .catch(e => { failedAt = Date.now(); throw e; })
      .finally(() => { loading = null; });
    return loading;
  }

  function tileKeys(s, w, n, e) {
    const d = data.tile_deg, keys = [];
    for (let x = Math.floor(w / d) * d; x < e; x += d) {
      for (let y = Math.floor(s / d) * d; y < n; y += d) {
        const k = `${x}_${y}`;
        if (tileSet.has(k)) keys.push(k);
      }
    }
    return keys;
  }

  // Ask for the tiles over a box that are not here yet. Resolves when every
  // one asked for has answered or failed; each that lands joins its rivers.
  function ensureTiles(s, w, n, e) {
    if (!data) return Promise.resolve();
    const keys = tileKeys(s, w, n, e).slice(0, TILE_CAP);
    const asks = [];
    for (const k of keys) {
      const t = tiles.get(k);
      if (t === true || t === 'loading' || (typeof t === 'number' && Date.now() - t < FAIL_TTL)) continue;
      tiles.set(k, 'loading');
      asks.push(fetch(`${TILE_DIR}${k}.json`)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(j => {
          for (const [rid, band, line] of j.runs || []) {
            const r = rivers[rid];
            if (r) r.runs.push(makeRun(r, band, decodeLine(line, data.quant)));
          }
          tiles.set(k, true);
        })
        .catch(() => { tiles.set(k, Date.now()); }));
    }
    return Promise.all(asks);
  }

  // ── The minor creeks ──────────────────────────────────────────────────────

  function minorBox(v) {
    const down = x => Math.floor(x / MINOR_STEP) * MINOR_STEP;
    const up   = x => Math.ceil(x / MINOR_STEP) * MINOR_STEP;
    return { s: down(v.getSouth()), w: down(v.getWest()), n: up(v.getNorth()), e: up(v.getEast()) };
  }

  async function askMinor(where, b) {
    const params = new URLSearchParams({
      where, geometry: [b.w, b.s, b.e, b.n].map(x => x.toFixed(4)).join(','),
      geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: 'OBJECTID,Name,UpstrDArea', returnGeometry: 'true', outSR: '4326',
      maxAllowableOffset: '0.00008', geometryPrecision: '5', resultRecordCount: '2000', f: 'json',
    });
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${MINOR_URL}?${params}`, { signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j && j.error) throw new Error('the service answered with an error');
      return (j && j.features) || [];
    } finally {
      clearTimeout(t);
    }
  }

  // The river a minor segment belongs to: a principal river of the same name
  // whose extent it is beside — a branch the Geofabric calls minor is still
  // the Lockyer — or else a creek of its own, by name.
  function minorRiver(name, lat, lon) {
    for (const r of byName.get(name) || []) {
      const b = r.box;
      if (b && lon >= b[0] - 0.1 && lon <= b[2] + 0.1 && lat >= b[1] - 0.1 && lat <= b[3] + 0.1) return r;
    }
    let r = minorByName.get(name);
    if (!r) {
      r = { id: `m:${name}`, name, title: titleCase(name), area: 0, len: 0, box: null, runs: [], minor: true };
      minorByName.set(name, r);
    }
    return r;
  }

  // Features from the service (or the harness) into runs. A segment already
  // added — two views overlap — is not added twice.
  function addMinor(features) {
    let added = 0;
    for (const f of features || []) {
      const a = (f && f.attributes) || {};
      const name = String(a.Name || '').trim();
      if (!name || minorSeen.has(a.OBJECTID)) continue;
      minorSeen.add(a.OBJECTID);
      for (const path of (f.geometry && f.geometry.paths) || []) {
        if (!path || path.length < 2) continue;
        const ll = new Float64Array(path.length * 2);
        path.forEach((p, i) => { ll[i * 2] = p[1]; ll[i * 2 + 1] = p[0]; });
        const r = minorRiver(name, ll[0], ll[1]);
        r.runs.push(makeRun(r, MINOR_BAND, ll));
        if (r.minor) r.area = Math.max(r.area, (a.UpstrDArea || 0) / 1e6);
        added++;
      }
    }
    return added;
  }

  function runMinor(v) {
    if (map.getZoom() < MINOR_MIN_ZOOM) { minor = 'zoom'; return; }
    const b = minorBox(v);
    if (b.n - b.s > MINOR_SPAN || b.e - b.w > MINOR_SPAN) { minor = 'wide'; return; }
    const key = [b.s, b.w, b.n, b.e].map(x => x.toFixed(2)).join(',');
    if (minorCache.has(key)) {
      minorCache.delete(key); minorCache.set(key, true);
      minor = 'ok';
      return;
    }
    if (Date.now() - minorFailedAt < FAIL_TTL) { minor = 'fail'; return; }
    if (minorKey === key) return;                 // already asking
    minorKey = key;
    const mine = ++minorSeq;
    minor = 'loading';
    askMinor("Hierarchy='Minor' AND Name <> ' '", b).then(features => {
      addMinor(features);
      minorCache.set(key, true);
      while (minorCache.size > MINOR_CACHE) minorCache.delete(minorCache.keys().next().value);
      if (mine !== minorSeq || !map) return;
      minorKey = null;
      sync();
    }).catch(() => {
      minorFailedAt = Date.now();
      if (mine !== minorSeq || !map) return;
      minorKey = null;
      minor = 'fail';
      setNote();
    });
  }

  // A minor creek picked: the rest of its course, from a box round what is
  // here, once — so the selection is the creek and not the screenful of it.
  function askCourse(r) {
    if (r.courseAsked || !r.minor) return;
    r.courseAsked = true;
    const box = riverBox(r);
    if (!box) return;
    const pad = 0.25;
    const b = { s: box[0] - pad, w: box[1] - pad, n: box[2] + pad, e: box[3] + pad };
    askMinor(`Hierarchy='Minor' AND Name = '${r.name.replace(/'/g, "''")}'`, b).then(features => {
      if (addMinor(features) && selected === r) { renderPick(); setNote(); }
    }).catch(() => { r.courseAsked = false; });
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  function colours() {
    return {
      line:  cssVar('--map-river-line', '#1565c0'),
      pick:  cssVar('--map-river-pick', '#0a2f8a'),
      glow:  cssVar('--map-river-glow', '#00c2ff'),
    };
  }

  function clearDrawn() {
    drawn.clear();
    if (net) net.redraw();
    if (nameLayer) nameLayer.clearLayers();
    labelled = [];
    clearHover();
    syncAttribution();
  }

  // Which runs the view draws: the bands this zoom draws, in the padded view,
  // less any run too small to show at all — the braided inland channels are
  // thousands of fragments of a kilometre or two, under a pixel from afar.
  // Choosing is cheap; the drawing is net's.
  function drawView() {
    const z = map.getZoom();
    const v = map.getBounds().pad(VIEW_PAD);
    const deepest = maxBand(z);
    const tiny = TINY_PX * 360 / (256 * Math.pow(2, z));    // deg
    drawn.clear();
    const take = (run) => {
      if (!boxMeets(run.box, v)) return;
      if (run.box[2] - run.box[0] + run.box[3] - run.box[1] < tiny) return;
      drawn.add(run);
    };
    for (const r of rivers) {
      if (!r.box || r.box[0] > v.getEast() || r.box[2] < v.getWest()
          || r.box[1] > v.getNorth() || r.box[3] < v.getSouth()) continue;
      for (const run of r.runs) {
        if (run.band <= deepest || (run.band === MINOR_BAND && z >= MINOR_MIN_ZOOM)) take(run);
      }
    }
    if (z >= MINOR_MIN_ZOOM) for (const r of minorByName.values()) for (const run of r.runs) take(run);
    if (net) net.redraw();
    syncAttribution();
  }

  // ── The network on its canvas ─────────────────────────────────────────────
  // One object on a canvas renderer of its own, not a polyline per run: a
  // State's view is several thousand runs, and as Leaflet layers each one is
  // its own LatLng array, projection, bounds and stroke — measured at 150 to
  // 300 ms a move. Here each band is one Path2D, stroked twice, casings first
  // then cores, so one river's white never paints over another's blue; and
  // the projection it draws from is the one the pointer is hit-tested against,
  // made once per run per zoom. The renderer still does what Leaflet's do
  // well — following a pan, scaling through a zoom, clearing and redrawing.
  function makeNet() {
    const Net = L.Path.extend({
      initialize(opts) { L.setOptions(this, opts); },
      // The canvas's own extent: the whole of what is drawn is redrawn whole.
      _project() {
        const b = this._renderer && this._renderer._bounds;
        this._pxBounds = b ? L.bounds(b.min, b.max) : L.bounds([-1e7, -1e7], [1e7, 1e7]);
      },
      _update() {},
      _updatePath() { if (this._renderer._drawing) drawNet(this._renderer._ctx); },
      _containsPoint() { return false; },
      _empty() { return !drawn.size; },
    });
    return new Net({ renderer: netR, pane: PANE, interactive: false, weight: 6 });
  }

  function drawNet(ctx) {
    if (!map || !drawn.size) return;
    const z = map.getZoom(), po = map.getPixelOrigin(), c = colours();
    const bands = new Map();
    for (const run of drawn) {
      let p = bands.get(run.band);
      if (!p) bands.set(run.band, p = new Path2D());
      const q = proj(run, z);
      p.moveTo(q[0] - po.x, q[1] - po.y);
      for (let i = 2; i < q.length; i += 2) p.lineTo(q[i] - po.x, q[i + 1] - po.y);
    }
    // The smallest band first, so a main stream draws over its tributaries.
    const order = [...bands].sort((a, b) => b[0] - a[0]);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.5;
    for (const [band, p] of order) { ctx.lineWidth = weightOf(band, z) + 1.8; ctx.stroke(p); }
    ctx.strokeStyle = c.line;
    ctx.globalAlpha = 0.92;
    for (const [band, p] of order) { ctx.lineWidth = weightOf(band, z); ctx.stroke(p); }
    ctx.restore();
  }

  // The selected river, every reach of it whatever the zoom: a glow, a white
  // casing, and a core in the selection's own ink. SVG, in its own pane: one
  // river is a few thousand points at most, and its paths are DOM a check
  // can find.
  function renderPick() {
    if (!pickLayer) return;
    pickLayer.clearLayers();
    if (!selected || !map) return;
    const z = map.getZoom(), c = colours();
    for (const pass of ['glow', 'casing', 'core']) {
      for (const run of selected.runs) {
        const w = weightOf(Math.min(run.band, 5), z) + 0.8;
        L.polyline(latLngs(run), {
          renderer: pickR, pane: PICK_PANE, interactive: false, lineCap: 'round', lineJoin: 'round',
          className: `mn-rl-pick mn-rl-pick-${pass}`,
          color:   pass === 'glow' ? c.glow : pass === 'casing' ? '#ffffff' : c.pick,
          weight:  pass === 'glow' ? w + 9 : pass === 'casing' ? w + 3 : w,
          opacity: pass === 'glow' ? 0.38 : pass === 'casing' ? 0.95 : 1,
        }).addTo(pickLayer);
      }
    }
  }

  function renderHover() {
    if (!hoverLayer) return;
    hoverLayer.clearLayers();
    if (!hover || hover === selected || !map) return;
    const z = map.getZoom(), c = colours();
    for (const run of drawn) {
      if (run.river !== hover) continue;
      L.polyline(latLngs(run), {
        renderer: pickR, pane: PICK_PANE, interactive: false, lineCap: 'round', lineJoin: 'round',
        className: 'mn-rl-hover', color: c.glow, weight: weightOf(run.band, z) + 6, opacity: 0.3,
      }).addTo(hoverLayer);
    }
  }

  function syncAttribution() {
    const want = !!(map && (drawn.size || selected));
    if (!map || !map.attributionControl || want === attributed) return;
    if (want) map.attributionControl.addAttribution(ATTRIBUTION);
    else map.attributionControl.removeAttribution(ATTRIBUTION);
    attributed = want;
  }

  // ── Names ─────────────────────────────────────────────────────────────────
  // One name per river in view, along its longest stretch on screen and
  // turned to run with it — upright, never upside down — the way a printed
  // map names a river. The biggest rivers are named first; a name that would
  // overlap one already placed, or is longer than its stretch, is left off.
  // Rebuilt on every moveend: LABEL_CAP markers is nothing to rebuild.

  function stretchOf(run, size, z, off) {
    const q = proj(run, z), M = 8;
    // A long run is sampled: where its name goes does not need every vertex.
    const step = 2 * Math.max(1, Math.ceil(q.length / 2 / 600));
    let best = null, cur = null, prev = null;
    for (let i = 0; i < q.length; i += step) {
      const p = { x: q[i] - off.x, y: q[i + 1] - off.y };
      const inside = p.x >= M && p.y >= M && p.x <= size.x - M && p.y <= size.y - M;
      if (!inside) { cur = null; prev = null; continue; }
      if (!cur) cur = { px: 0, pts: [p], cum: [0] };
      else {
        cur.px += Math.hypot(p.x - prev.x, p.y - prev.y);
        cur.pts.push(p);
        cur.cum.push(cur.px);
      }
      prev = p;
      if (!best || cur.px > best.px) best = cur;
    }
    if (!best || best.pts.length < 2) return null;
    // The middle, and the direction over about forty pixels either side.
    let m = 0;
    while (m < best.cum.length - 1 && best.cum[m] < best.px / 2) m++;
    let a = m, b = m;
    while (a > 0 && best.cum[m] - best.cum[a] < 40) a--;
    while (b < best.pts.length - 1 && best.cum[b] - best.cum[m] < 40) b++;
    let deg = Math.atan2(best.pts[b].y - best.pts[a].y, best.pts[b].x - best.pts[a].x) * 180 / Math.PI;
    if (deg > 90) deg -= 180;
    if (deg < -90) deg += 180;
    const pt = L.point(best.pts[m].x, best.pts[m].y);
    return { px: best.px, at: map.containerPointToLatLng(pt), pt, deg };
  }

  function applyLabels() {
    nameLayer.clearLayers();
    labelled = [];
    if (!drawn.size && !selected) return;
    const size = map.getSize(), view = map.getBounds(), z = map.getZoom();
    // A container point is a world pixel less this.
    const off = map.getPixelOrigin().add(map.containerPointToLayerPoint([0, 0]));
    const byRiver = new Map();
    const runs = new Set(drawn);
    if (selected) for (const run of selected.runs) runs.add(run);
    for (const run of runs) {
      if (!boxMeets(run.box, view)) continue;
      const r = run.river;
      // A run whose whole box is a few pixels across is not worth walking.
      const sw = map.latLngToContainerPoint([run.box[0], run.box[1]]);
      const ne = map.latLngToContainerPoint([run.box[2], run.box[3]]);
      if (Math.hypot(ne.x - sw.x, ne.y - sw.y) < LABEL_TINY_PX && r !== selected) continue;
      const s = stretchOf(run, size, z, off);
      if (!s) continue;
      const had = byRiver.get(r);
      if (!had || s.px > had.px) byRiver.set(r, { ...s, band: run.band });
    }
    const cands = [...byRiver].map(([r, s]) => ({ r, ...s }))
      .filter(c => c.px >= LABEL_MIN_PX || c.r === selected)
      .sort((x, y) => (y.r === selected) - (x.r === selected) || x.band - y.band || y.px - x.px);
    const placed = [];
    for (const c of cands) {
      if (labelled.length >= LABEL_CAP) break;
      const w = c.r.title.length * LABEL_CHAR_PX + 10, h = 15;
      if (w > c.px * 0.92 && c.r !== selected) continue;
      const rad = c.deg * Math.PI / 180;
      const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
      const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
      const box = { x0: c.pt.x - bw / 2 - 4, y0: c.pt.y - bh / 2 - 4, x1: c.pt.x + bw / 2 + 4, y1: c.pt.y + bh / 2 + 4 };
      if (box.x0 < 0 || box.y0 < 0 || box.x1 > size.x || box.y1 > size.y) continue;   // not cut by the edge
      if (placed.some(o => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0)) continue;
      placed.push(box);
      labelled.push(c.r);
      L.marker(c.at, {
        pane: NAME_PANE, interactive: false, keyboard: false,
        icon: L.divIcon({
          className: `mn-rl-icon${c.r === selected ? ' is-picked' : ''}`, iconSize: [0, 0], iconAnchor: [0, 0],
          html: `<span class="mn-rl-name" style="transform:translate(-50%,-50%) rotate(${c.deg.toFixed(1)}deg)">${esc(c.r.title)}</span>`,
        }),
      }).addTo(nameLayer);
    }
  }

  // ── The pointer ───────────────────────────────────────────────────────────

  function pointerTaken() {
    return !!((state.draw && state.draw.tool) || (state.link && state.link.picking)
      || (typeof MapHere !== 'undefined' && MapHere.armed && MapHere.armed())
      || (typeof MapMovePin !== 'undefined' && MapMovePin.armed && MapMovePin.armed()));
  }

  // Each run's points in the map's pixel space at a zoom — Web Mercator, as
  // Leaflet's EPSG:3857 projects them — which a pan does not move: made once
  // per run per zoom, by the drawing, the names or the pointer, whichever
  // needs it first, and shared by all three.
  function proj(run, z) {
    if (run.projZoom === z && run.proj) return run.proj;
    const ll = run.ll, out = new Float64Array(ll.length), k = 256 * Math.pow(2, z);
    for (let i = 0; i < ll.length; i += 2) {
      const sin = Math.sin(ll[i] * Math.PI / 180);
      out[i] = (ll[i + 1] + 180) / 360 * k;
      out[i + 1] = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * k;
    }
    run.proj = out; run.projZoom = z;
    return out;
  }

  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx - px, y = ay + t * dy - py;
    return x * x + y * y;
  }

  // The river under a point, within r px of its line: the drawn runs and the
  // selected river's (whose headwaters can be on screen past the band drawn).
  function riverAt(latlng, r) {
    if (!map) return null;
    const z = map.getZoom();
    const p = map.project(latlng, z);
    const corner = map.unproject([p.x + r, p.y + r], z);
    const dLat = Math.abs(corner.lat - latlng.lat), dLon = Math.abs(corner.lng - latlng.lng);
    const runs = new Set(drawn);
    if (selected) for (const run of selected.runs) runs.add(run);
    let best = null, bestD = r * r;
    for (const run of runs) {
      const b = run.box;
      if (latlng.lat < b[0] - dLat || latlng.lat > b[2] + dLat
          || latlng.lng < b[1] - dLon || latlng.lng > b[3] + dLon) continue;
      const q = proj(run, z);
      for (let i = 2; i < q.length; i += 2) {
        const d = segDist2(p.x, p.y, q[i - 2], q[i - 1], q[i], q[i + 1]);
        if (d <= bestD) { bestD = d; best = run.river; }
      }
    }
    return best;
  }

  function clearHover() {
    hover = null;
    if (hoverLayer) hoverLayer.clearLayers();
    if (hoverTip) { hoverTip.remove(); hoverTip = null; }
    if (cursorSet && map) { map.getContainer().style.cursor = ''; cursorSet = false; }
  }

  // One hit test a frame, on the frame's last position — not its first, or a
  // pointer that comes to rest on a river is tested where it was a move ago.
  let lastMove = null;
  function onMapMove(e) {
    lastMove = e;
    if (moveRaf || !map || (!drawn.size && !selected)) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = null;
      const e = lastMove;
      if (!map || !e) return;
      const r = pointerTaken() ? null : riverAt(e.latlng, HIT_PX);
      if (!r) { if (hover || cursorSet) clearHover(); return; }
      map.getContainer().style.cursor = 'pointer';
      cursorSet = true;
      if (!hoverTip) {
        hoverTip = L.tooltip({ className: 'mn-river-label mn-rl-tip', direction: 'top', offset: [0, -8], interactive: false })
          .setContent(esc(r.title)).setLatLng(e.latlng).addTo(map);
      } else {
        hoverTip.setLatLng(e.latlng);
        if (hover !== r) hoverTip.setContent(esc(r.title));
      }
      if (hover !== r) { hover = r; renderHover(); }
    });
  }

  function isTouch(e) {
    const o = e && e.originalEvent;
    return !!(o && (o.pointerType === 'touch' || (o.sourceCapabilities && o.sourceCapabilities.firesTouchEvents)));
  }

  // Every other handler on this click runs first: a point under the pointer
  // opens its own callout, and when one opened during this click — before
  // this handler or after it — the line under the point stands down.
  function onMapClick(e) {
    const catchment = typeof RiverCatchments !== 'undefined' && RiverCatchments.active();
    if (!map || pointerTaken() || (!drawn.size && !selected && !catchment)) return;
    const r = riverAt(e.latlng, isTouch(e) ? HIT_TOUCH_PX : HIT_PX);
    const at = e.latlng;
    const since = (e.originalEvent && e.originalEvent.timeStamp) || performance.now();
    setTimeout(() => {
      if (!map || foreignPopupAt >= since - 1) return;
      if (r) select(r, { at, callout: true });
      else if (selected || (typeof RiverCatchments !== 'undefined' && RiverCatchments.active())) clearSelection();
    }, 0);
  }

  function onPopupOpen(e) { if (e.popup !== popup) foreignPopupAt = performance.now(); }

  // ── Selecting ─────────────────────────────────────────────────────────────

  // The register's stations on this river: its `stream` names it, and the
  // station is inside the river's extent — "DEEP CREEK" is several creeks.
  function stationsOn(r) {
    const all = (typeof state !== 'undefined' && state.data && state.data.stations) || [];
    const box = riverBox(r);
    if (!box) return [];
    const k = riverKey(r.name);
    const [s, w, n, e] = box;
    return all.filter(st => st.stream && st.lat != null && st.lon != null
      && st.lat >= s - STATION_PAD && st.lat <= n + STATION_PAD
      && st.lon >= w - STATION_PAD && st.lon <= e + STATION_PAD
      && riverKey(st.stream) === k)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function calloutHtml(r) {
    const line = (html, cls) => `<span class="mn-pop-line${cls ? ' ' + cls : ''}">${html}</span><br>`;
    const out = [`<strong>${esc(r.title)}</strong><br>`];
    if (r.minor) {
      out.push(line(esc(`${kindWord(r.name)} · a minor watercourse in the Geofabric`
        + (r.area >= 1 ? ` · about ${fmtInt(r.area)} km² drains through the reaches drawn` : ''))));
    } else {
      // The catchment's area when it has one: the sub-catchments upstream of
      // its mouth, joined, which is the basin's own figure (the Burdekin's
      // 127,000 km²). The network's figure at its lowest reach can be well
      // short of it — 94,000 km² for the Burdekin — so it is the fallback.
      const ci = typeof RiverCatchments !== 'undefined' ? RiverCatchments.riverInfo(r.id) : undefined;
      if (ci) {
        out.push(line(esc(`${kindWord(r.name)} · catchment ${fmtInt(ci.area)} km²` + (state.mapRiverCatchment
          ? ', outlined on the map and shaded by its own ground' : ''))));
      } else {
        out.push(line(esc(`${kindWord(r.name)} · ${fmtInt(r.area)} km² drains through its lowest reach`)));
      }
      out.push(line(esc(`${fmtInt(r.len)} km of channel mapped, tributaries of the same name included`), 'txt-muted'));
      if (ci === null) {
        out.push(line(esc('No catchment drawn here — the Geofabric\'s catchments and its stream network '
          + 'disagree too much at this river to draw one'), 'txt-muted'));
      }
    }
    const on = stationsOn(r);
    if (on.length) {
      out.push(line(esc(`${on.length} station${on.length === 1 ? '' : 's'} of this network on it:`)));
      out.push('<span class="mn-rl-stations">' + on.slice(0, CALLOUT_STATIONS).map(st =>
        `<button type="button" class="pill mn-rl-station" data-id="${escAttr(st.id)}"
          onclick="MapRiverLines.openStation(this.dataset.id)">${esc(st.name)}</button>`).join('')
        + (on.length > CALLOUT_STATIONS ? ` <span class="small txt-muted">+${on.length - CALLOUT_STATIONS} more</span>` : '')
        + '</span><br>');
    } else {
      out.push(line(esc('No station in the register names it as its stream.'), 'txt-muted'));
    }
    out.push(`<div class="mn-popup-actions pill-row">
      <button type="button" class="pill" onclick="MapRiverLines.zoomToSelected()">Zoom to the whole ${esc(kindWord(r.name).toLowerCase())}</button>
      <button type="button" class="pill" onclick="MapRiverLines.clearSelection()">Clear selection</button>
    </div>`);
    out.push(line(esc(ATTRIBUTION), 'txt-muted small'));
    return out.join('');
  }

  function openCallout(r, at) {
    if (!map || !r) return;
    if (popup) popup.remove();
    const spot = at || labelSpot(r);
    if (!spot) return;
    // Made, then kept, then opened: its own popupopen must find it already
    // ours, or the next click would read it as a point's callout.
    popup = L.popup({ maxWidth: 320, minWidth: 220, className: 'mn-rl-popup' })
      .setLatLng(spot).setContent(() => calloutHtml(r));
    popup.openOn(map);
  }

  // Somewhere on the river to point a callout at: the middle of its longest
  // run in view, else of its longest run.
  function labelSpot(r) {
    const v = map.getBounds();
    let best = null;
    for (const run of r.runs) {
      const inView = boxMeets(run.box, v);
      const score = (inView ? 1e9 : 0) + run.ll.length;
      if (!best || score > best.score) best = { run, score };
    }
    if (!best) return null;
    const ll = best.run.ll, m = Math.floor(ll.length / 4) * 2;
    return L.latLng(ll[m], ll[m + 1]);
  }

  // Ask for whatever of the river is not here yet: its tiles, if it reaches
  // into the bands they hold, and a minor creek's whole course.
  function completeRiver(r) {
    if (r.minor) { askCourse(r); return; }
    if (!data || !r.box) return;
    const [w, s, e, n] = r.box;
    ensureTiles(s, w, n, e).then(() => { if (selected === r) { renderPick(); if (map) applyLabels(); } });
  }

  function select(r, { at = null, callout = false, fit = false } = {}) {
    if (!map || !r) return;
    selected = r;
    clearHover();
    renderPick();
    completeRiver(r);
    if (fit) fitTo(r);
    applyLabels();
    syncAttribution();
    if (callout) openCallout(r, at);
    // Its catchment (river-catchments.js), shaded by its own ground, unless
    // the switch under the rivers says not to. A minor creek has none: it is
    // not in the rivers file the catchments were built for.
    if (!r.minor && typeof RiverCatchments !== 'undefined') {
      if (state.mapRiverCatchment) {
        RiverCatchments.showRiver(r.id, r.title).then(() => {
          if (selected === r && popup && popup.isOpen()) popup.update();
        });
      } else {
        RiverCatchments.clear();
      }
    }
    setNote();
    rerenderMapLegend();
    announce(`${r.title} selected on the map.`);
  }

  function fitTo(r) {
    const box = riverBox(r);
    if (!box || !map) return;
    map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: [32, 32], maxZoom: 13 });
  }

  function clearSelection() {
    const catchment = typeof RiverCatchments !== 'undefined' && RiverCatchments.active();
    if (catchment) RiverCatchments.clear();
    if (!selected && !popup) return;
    selected = null;
    if (popup) { popup.remove(); popup = null; }
    renderPick();
    if (map) applyLabels();
    syncAttribution();
    setNote();
    rerenderMapLegend();
  }

  // ── The note ──────────────────────────────────────────────────────────────

  function setNote(kind) {
    if (kind) note = kind;
    const el = document.getElementById('map-river-lines-note');
    if (el) el.innerHTML = noteHtml();
  }

  function noteHtml() {
    if (!state.mapRiverLines && !selected) return 'Rivers are hidden.';
    const parts = [];
    if (state.mapRiverLines) {
      if (note === 'loading' || (!data && note !== 'fail')) parts.push('Loading the rivers…');
      else if (note === 'fail') parts.push('Rivers unavailable — data/rivers-au.json could not be read.');
      else if (map) {
        const z = map.getZoom(), deepest = maxBand(z);
        const floor = data.bands[deepest];
        parts.push(floor
          ? `Rivers draining ${fmtInt(floor)} km² or more — zoom in for smaller ones.`
          : 'Every principal named river and creek in view.');
        if (minor === 'zoom') parts.push(`Minor creeks from zoom ${MINOR_MIN_ZOOM} in.`);
        else if (minor === 'loading') parts.push('Looking up the minor creeks…');
        else if (minor === 'fail') parts.push('Minor creeks unavailable — the Geofabric service could not be reached.');
        else if (minor === 'ok') parts.push('Minor named creeks drawn too.');
      }
    }
    let html = esc(parts.join(' '));
    if (selected) {
      html += ` <span class="mn-rl-picked">Selected: <strong>${esc(selected.title)}</strong>
        <button type="button" class="mn-river-note-btn" onclick="MapRiverLines.clearSelection()">Clear</button></span>`;
    }
    const named = labelled.filter(r => r !== selected).slice(0, NOTE_BTN_CAP);
    if (state.mapRiverLines && named.length) {
      html += '<span class="mn-river-note-btns" aria-label="Rivers named in view">' + named.map(r =>
        `<button type="button" class="mn-river-note-btn" data-river="${escAttr(String(r.id))}"
          onclick="MapRiverLines.pick(this.dataset.river)">${esc(r.title)}</button>`).join('') + '</span>';
    }
    return html;
  }

  function legendHtml() {
    const items = [];
    if (drawn.size) {
      items.push(`
    <span class="legend-item">
      <span class="legend-line legend-line-river-net"></span>
      <span class="small">River or creek — heavier the more country drains through it. Hover for its name, click to select it (Geofabric, Bureau of Meteorology)</span>
    </span>`);
    }
    if (selected) {
      items.push(`
    <span class="legend-item">
      <span class="legend-line legend-line-river-pick"></span>
      <span class="small">Selected: ${esc(selected.title)}</span>
    </span>`);
    }
    return items.join('');
  }

  // ── The cycle ─────────────────────────────────────────────────────────────

  function run() {
    if (!map) return;
    if (!state.mapRiverLines) {
      clearDrawn(); minor = 'off'; setNote('off');
      if (selected) { renderPick(); applyLabels(); }
      return;
    }
    if (!data) {
      setNote('loading');
      ensureData().then(() => { if (map) run(); }, () => { if (map) setNote('fail'); });
      return;
    }
    const z = map.getZoom();
    if (maxBand(z) >= data.tile_band) {
      const v = map.getBounds().pad(VIEW_PAD);
      const pending = ensureTiles(v.getSouth(), v.getWest(), v.getNorth(), v.getEast());
      pending.then(landed => { if (landed.length && map) sync(); });
    }
    runMinor(map.getBounds());
    const had = drawn.size > 0;
    drawView();
    applyLabels();
    renderPick();
    setNote('ok');
    if (had !== drawn.size > 0) rerenderMapLegend();
  }

  function sync() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  return {
    ATTRIBUTION,
    riverKey,

    attach(m) {
      map = m;
      for (const [name, z] of [[PANE, PANE_Z], [PICK_PANE, PICK_Z], [NAME_PANE, NAME_Z]]) {
        if (!m.getPane(name)) {
          const pane = m.createPane(name);
          pane.style.zIndex = z;
          pane.style.pointerEvents = 'none';
        }
      }
      netR  = L.canvas({ pane: PANE, padding: VIEW_PAD });
      pickR = L.svg({ pane: PICK_PANE });
      net = makeNet().addTo(m);
      pickLayer  = L.layerGroup().addTo(m);
      hoverLayer = L.layerGroup().addTo(m);
      nameLayer  = L.layerGroup().addTo(m);
      m.on('moveend', sync);
      m.on('mousemove', onMapMove);
      m.on('mouseout', clearHover);
      m.on('click', onMapClick);
      m.on('popupopen', onPopupOpen);
      // A selection survives the map being rebuilt (a tab switch), as a
      // drawing does.
      if (selected) renderPick();
      sync();
    },

    detach() {
      clearTimeout(timer);
      if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = null; }
      if (map) {
        map.off('moveend', sync);
        map.off('mousemove', onMapMove);
        map.off('mouseout', clearHover);
        map.off('click', onMapClick);
        map.off('popupopen', onPopupOpen);
        if (attributed && map.attributionControl) map.attributionControl.removeAttribution(ATTRIBUTION);
      }
      clearHover();
      drawn.clear();
      labelled = [];
      attributed = false;
      popup = null;
      for (const r of rivers) for (const run of r.runs) { run.proj = null; run.projZoom = -1; }
      map = null;
      netR = net = pickR = pickLayer = hoverLayer = nameLayer = null;
      minorSeq++;
      minorKey = null;
    },

    sync,
    noteHtml,
    legendHtml,

    // Are rivers on the map right now? The legend asks before claiming a key.
    active() { return drawn.size > 0 || !!selected; },

    // Theme switch: the colours are read at draw time, so redraw what is there.
    repaint() {
      if (!map) return;
      if (net) net.redraw();
      renderPick();
    },

    // The river selected, as { name, title, minor }, or null.
    selected() { return selected ? { name: selected.name, title: selected.title, minor: selected.minor } : null; },

    // A note button (or anything holding a river's id): select it and open its
    // callout, without moving the map.
    pick(id) {
      const r = typeof id === 'string' && id.startsWith('m:')
        ? minorByName.get(id.slice(2)) : rivers[Number(id)];
      if (r) select(r, { callout: true });
    },

    // 📍 Find a place: select the river of this name nearest `near` ({ lat,
    // lon }), loading the rivers first if they are not here. Resolves to
    // { title, bounds: [s, n, w, e] } — Places' order — or null when the
    // Geofabric has no principal river by that name.
    selectNamed(name, near) {
      const k = riverKey(name);
      return ensureData().then(() => {
        let best = null, bestD = Infinity;
        for (const r of rivers) {
          if (riverKey(r.name) !== k || !r.box) continue;
          const [w, s, e, n] = r.box;
          const d = near ? Math.hypot(Math.max(w - near.lon, 0, near.lon - e), Math.max(s - near.lat, 0, near.lat - n)) : 0;
          if (d < bestD || (d === bestD && best && r.area > best.area)) { best = r; bestD = d; }
        }
        if (!best || (near && bestD > 1)) return null;
        select(best, { callout: false });
        const [w, s, e, n] = best.box;
        return { title: best.title, bounds: [s, n, w, e] };
      }).catch(() => null);
    },

    clearSelection,
    zoomToSelected() { if (selected) fitTo(selected); },

    // A station button in the callout: the map goes to it with its card up,
    // as a row picked in the list does.
    openStation(id) {
      const st = state.data && state.data.stations.find(s => s.id === id);
      if (st && typeof focusStationOnMap === 'function') focusStationOnMap(st);
    },

    // Wait for the national file — the harness, and Places, ask.
    ready: ensureData,

    // The harness blocks the live service, so a check that can never fetch a
    // minor creek hands its features in here and they take the real path.
    seedMinor(features) { const n = addMinor(features); sync(); return n; },

    // The switch under the rivers: a selected river's catchment shown with it.
    setCatchment(on) {
      state.mapRiverCatchment = !!on;
      try { localStorage.setItem('mn-river-catchment', on ? 'on' : 'off'); } catch (_) {}
      if (typeof RiverCatchments === 'undefined') return;
      if (on && selected && !selected.minor) RiverCatchments.showRiver(selected.id, selected.title);
      else if (!on && RiverCatchments.shown() && RiverCatchments.shown().kind === 'river') RiverCatchments.clear();
      if (popup && popup.isOpen()) popup.update();
    },

    setEnabled(on) {
      state.mapRiverLines = !!on;
      try { localStorage.setItem('mn-river-lines', on ? 'on' : 'off'); } catch (_) {}
      if (!on) {
        clearTimeout(timer);
        minorSeq++;
        minorKey = null;
        if (map) run();
        rerenderMapLegend();
        return;
      }
      setNote('loading');
      sync();
    },
  };
})();
if (typeof window !== 'undefined') window.MapRiverLines = MapRiverLines;
