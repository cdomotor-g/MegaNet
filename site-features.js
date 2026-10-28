// MegaNet — site-features.js
//
//   SiteFeatures        a station's ancillary features on the Stations map —
//                       the orifice outlet, the inspection pits, the
//                       benchmarks, the gauge boards and the rest as points,
//                       the orifice run as a line through them (0061): drawn
//                       for a signed-in editor from zoom 16, listed on the
//                       station card, and placed, drawn, moved and deleted one
//                       station at a time in the 📌 Site features mode.
//   SITE_FEATURE_KINDS  the kinds as 0061 and 0067 seed them, and how each is drawn.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, pillText, pillLong, announce, fmtKm, kmPerDegLon,
// KM_PER_DEG_LAT, slug, dlText and BREAKPOINTS; across to app.js for mapNote,
// repaintStnCard, closeStnCard and rerenderMapLegend; to datastore.js for
// dbSelect, dbRpc and dbCanWrite; to auth.js for Auth.open; to modal.js for
// confirmDialog; to places.js for Places.parse, which reads a typed coordinate
// however it is punctuated; and to map-draw.js, link-budget.js, map-here.js
// and map-move-pin.js, to take the map's other interactive modes off before
// this one takes its clicks — map-move-pin.js asks this the same on its way in
// — and to map-twin.js, whose offer of the twin waits while the mode is armed,
// and map-3d.js, whose ⛰️ view the mode leaves for the flat map it maps on,
// and which draws what this drew there (drawn(), Map3D.siteFeaturesChanged).
// All of it from inside its own functions, so this file's position among the
// modules is free: the IIFE body declares nothing but constants and nulls.
//
// ── Why a mode, again ────────────────────────────────────────────────────────
// For MapMovePin's reason: a station is one of 3,174 pins on a map you pan by
// dragging, and a feature that moved whenever a pan started on it would be a
// pit 40 m into the river that nobody meant. So the features are drawn to be
// looked at, and changed only with the mode armed — for one station at a time,
// its name on the panel, and nothing written until Save.
//
// ── What it draws, and when ──────────────────────────────────────────────────
// Signed in, from zoom 16 (a view ~600 m across, where a pit is more than a
// pixel from its station), the features of the stations in and around the
// view: asked a station at a time rather than a box at a time, because the
// card and the mode ask by station too, and kept two minutes. A point is a
// glyph — the outlet a ringed dot, a pit a crossed square, a benchmark a
// triangle, a board a staff — and a line a coloured run in a dark casing, which
// reads over the State's imagery and the topo alike; the shape says the kind
// without the colour. Signed out nothing is asked: the features are
// editors-only (0061), as the levels behind them are (0060).
//
// The points are markers in a pane of their own, between the field photos and
// the station pins; the lines are paths on the map's own canvas, with the
// radio links. Not a pane for the lines as well: a renderer in a pane over the
// links is a sheet the size of the map, and every click meant for a link would
// land on it.
//
// ── Placing and drawing ──────────────────────────────────────────────────────
// A point is placed the way a pin is moved: click where it is, or drag it, or
// stand on it and take the phone's fix, or type its coordinates. A line is
// clicked out a point at a time — from the shelter, through each pit, to the
// outlet — snapping to the station's pin and its points within 14 px, so a run
// passes exactly through the pits it was drawn through; double-click, Enter or
// Finish ends it, Backspace takes the last point back. Once drawn its points
// drag, a ＋ between two adds one, and the whole list is a box of coordinates to
// type over or paste a survey into: the keyboard's way in, as Draw & measure's
// typed shapes are (#136). Dragging is the one thing a keyboard cannot do here,
// and the box is the same door.
//
// ── What is saved ────────────────────────────────────────────────────────────
// One feature at a time, through save_station_feature() and
// delete_station_feature(), with the stamp it was read with — a stale write is
// refused, as for a station, and what was drawn stays on screen. How the
// position was got goes with it: `map`, `gps` (with the fix's ±), `typed`, or
// `mixed` for a line some of whose points came one way and some another — the
// provenance rule the field photos keep (0035), because a pit dropped on 20 cm
// imagery and one stood on with a phone are different claims.
//
// The mode survives the map being rebuilt under it (a render of the tab, or a
// visit to another one): detach() takes its drawing off the map and keeps the
// station and the draft, and attach() puts them back. A line clicked out over
// ten minutes is not lost to a filter that re-rendered the tab.
//
// ── Tilted ───────────────────────────────────────────────────────────────────
// The ⛰️ view (map-3d.js) draws what this drew and asks the database nothing:
// drawn() is each feature on the map, as it was drawn, and every draw tells the
// 3-D view so — the field photos' arrangement (map-photos.js). Its canvas is
// over every Leaflet pane, so without that an access track was on the map and
// out of sight the moment the map was tilted.
//
// One thing differs while it is up: the floor is MIN_ZOOM_3D rather than
// MIN_ZOOM. The 2-D map under the canvas follows the camera a step closer in
// than it, and a camera tilted at 62° sees kilometres of ground — the scale an
// access track is drawn at, up to 10 km of it. At 16 the tracks would come and
// go with every zoom of a view that shows the whole of one. A pit is a pixel
// from its pin at that distance, so the 3-D view draws the lines from there
// and holds the points back until the camera is as close as MIN_ZOOM puts the
// flat map.
//
// Only the mode is flat-only: start() leaves the 3-D view, whose ground is not
// the flat map's under a click.

// The kinds 0061 seeds and the access track 0067 adds, in the vocabulary's
// order, with the shape and colour each is drawn in. The first six columns are
// the vocabulary's own, word for word — `npm run sitefeatures` holds them to
// the migrations — and the database's copy is read over this one when it
// answers, so a kind added there by an insert is offered here, drawn plainly,
// without a release.
const SITE_FEATURE_KINDS = [
  { key: 'orifice_outlet', label: 'Orifice outlet', geometry: 'Point', needs_name: false, ord: 10,
    note: 'Where the orifice line ends in the stream — the point a bubbler reads the water at.',
    glyph: 'outlet', colour: '#00b0ff' },
  { key: 'pit', label: 'Inspection pit', geometry: 'Point', needs_name: false, ord: 20,
    note: 'A pit on the orifice line or a cable run, opened to inspect, clear or join it.',
    glyph: 'pit', colour: '#ff9100' },
  { key: 'benchmark', label: 'Benchmark', geometry: 'Point', needs_name: false, ord: 30,
    note: 'A survey mark the gauge is levelled from — a local benchmark, a reference mark or a State mark.',
    glyph: 'benchmark', colour: '#ff1744' },
  { key: 'gauge_board', label: 'Gauge board', geometry: 'Point', needs_name: false, ord: 40,
    note: 'A staff gauge board, one of the flight read by eye.',
    glyph: 'board', colour: '#ffea00' },
  { key: 'crest_gauge', label: 'Crest gauge', geometry: 'Point', needs_name: false, ord: 50,
    note: 'A maximum height gauge, read after a flood.',
    glyph: 'crest', colour: '#d500f9' },
  { key: 'other_point', label: 'Other point', geometry: 'Point', needs_name: true, ord: 90,
    note: 'Anything else at the site worth finding again — named.',
    glyph: 'dot', colour: '#f5f5f5' },
  { key: 'orifice_run', label: 'Orifice run', geometry: 'LineString', needs_name: false, ord: 110,
    note: 'The orifice line, from the shelter to the outlet, through its pits.',
    colour: '#00b0ff', dash: null },
  { key: 'cable_run', label: 'Cable run', geometry: 'LineString', needs_name: false, ord: 120,
    note: 'A sensor\'s cable or a conduit, from the shelter to the sensor, through its pits.',
    colour: '#ff9100', dash: '9,6' },
  // 0067's: the way in, from the GPS tracks driven to the sites.
  { key: 'access_track', label: 'Access track', geometry: 'LineString', needs_name: false, ord: 130,
    note: 'The way in to the site — the road or track driven to it, ending at the station.',
    colour: '#76ff03', dash: null },
  { key: 'other_line', label: 'Other line', geometry: 'LineString', needs_name: true, ord: 190,
    note: 'Any other run worth finding again — an access track, a fence, a drain — named.',
    colour: '#f5f5f5', dash: '2,7' },
];

const SiteFeatures = (function () {
  const PANE      = 'mnSiteFeat';       // the points: over the photos (420), under the pins (600)
  const PANE_Z    = 425;
  const EDIT_PANE = 'mnSiteFeatEdit';   // the mode's handles: over the pins, so one beside a pin can be held
  const EDIT_Z    = 650;
  const MIN_ZOOM  = 16;
  const MIN_ZOOM_3D = 14;               // while the ⛰️ view is up — see "Tilted"
  const FRESH_MS  = 2 * 60 * 1000;
  const DEBOUNCE_MS = 250;
  const SNAP_PX   = 14;
  const MAX_STATIONS = 25;              // asked about per settled view, nearest the middle first
  const MAX_POINTS = 500;               // 0061's limit for a line
  const FAR_M     = 500;                // said to be far from its pin
  const LIMIT_M   = 10000;              // refused by the database as the wrong station's map
  const GPS_WORST_M = 100;              // a fix coarser than this places nothing
  const DP        = 7;                  // 0061 keeps seven places: about a centimetre
  const COLS = 'id,station_id,kind,name,note,geom,placed,accuracy_m,created_by,created_at,updated_by,updated_at';
  const NOT_READY = 'This database has no site features yet — 0061 is not applied.';

  let map = null;
  let layer = null;          // what is drawn to be looked at
  let editLayer = null;      // the mode's draft, its handles, the ghost and the snap ring
  let pieces = null;         // the parts of editLayer that are moved rather than rebuilt
  let panel = null;          // the mode's panel, bottom left of the map
  let timer = null, seq = 0;
  let cache = {};            // station id → { at, rows, p, error }
  let kinds = null;          // the vocabulary as the database has it, over SITE_FEATURE_KINDS
  let kindsTried = false;
  let notReady = false;      // the database answered that it has no 0061
  let note = { kind: 'off', n: 0, stations: 0, error: '' };
  let drawnKinds = [];       // for the legend
  let shown = [];            // what draw() put on the map, for the ⛰️ view (drawn())
  let session = null;        // the mode — see start()
  let highlight = null;      // { stationId, id } shown from the card, outside the mode
  let keyHandler = null;
  let ghostTo = null;        // where the next point would go, while a line is drawn

  const round = n => Number(Number(n).toFixed(DP));

  // ── Reading the station list ───────────────────────────────────────────────

  function signedIn() { return typeof dbCanWrite === 'function' && dbCanWrite(); }
  function tilted() { return typeof Map3D !== 'undefined' && !!Map3D.active && Map3D.active(); }
  function minZoom() { return tilted() ? MIN_ZOOM_3D : MIN_ZOOM; }
  function stationById(id) { return ((state.data && state.data.stations) || []).find(s => s.id === id) || null; }
  function hasPin(s) {
    return !!s && s.lat != null && s.lon != null && s.lat !== '' && s.lon !== '' && isFinite(s.lat) && isFinite(s.lon);
  }
  function pinOf(s) { return hasPin(s) ? [+s.lat, +s.lon] : null; }

  // ── The kinds ──────────────────────────────────────────────────────────────

  function kindList() { return kinds || SITE_FEATURE_KINDS; }
  function kindOf(key, geometry) {
    return kindList().find(k => k.key === key) || {
      key, label: key ? String(key).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : 'Feature',
      geometry: geometry || 'Point', needs_name: false, ord: 999, note: '', glyph: 'dot', colour: '#f5f5f5', dash: null,
    };
  }
  function isLineKind(key) { return kindOf(key).geometry === 'LineString'; }

  // Only a hex literal reaches an attribute: a kind the database added has no
  // colour of its own, and nothing it carries is written into markup unread.
  function safeColour(c) { return /^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#f5f5f5'; }

  // The database's own list, once a session: its labels and notes are the
  // ones to show, and a kind it has that this file does not is still a kind.
  function loadKinds() {
    if (kinds || kindsTried || !signedIn()) return Promise.resolve();
    kindsTried = true;
    return dbSelect('station_feature_kind?select=key,label,geometry,needs_name,ord,note&order=ord.asc')
      .then(rows => {
        if (!rows.length) return;
        kinds = rows.map(r => {
          const mine = SITE_FEATURE_KINDS.find(k => k.key === r.key) || { glyph: 'dot', colour: '#f5f5f5', dash: null };
          return { ...mine, ...r, ord: Number(r.ord) };
        }).sort((a, b) => a.ord - b.ord);
      }, () => { /* the list above stands */ });
  }

  // ── The glyphs ─────────────────────────────────────────────────────────────
  // Plan symbols, so the shape says the kind before the colour does: a ringed
  // dot where the line ends, the crossed square a drawing uses for a pit, a
  // bullseye for a benchmark (the survey layer's benchmark symbol; it was a
  // triangle until a triangle became a river height gauge's pin), a staff with
  // its metre marks, a diamond for the crest gauge's tube, and a plain dot for
  // anything else. A dark edge on every one, for the white of a sandbank and
  // the yellow of a board alike.
  const GLYPH = {
    outlet:    c => `<circle cx="10" cy="10" r="6.6" fill="${c}" stroke="#14181c" stroke-width="1.6"/><circle cx="10" cy="10" r="2.3" fill="#fff"/>`,
    pit:       c => `<rect x="3.6" y="3.6" width="12.8" height="12.8" fill="${c}" stroke="#14181c" stroke-width="1.6"/><path d="M3.6 3.6L16.4 16.4M16.4 3.6L3.6 16.4" stroke="#14181c" stroke-width="1.3"/>`,
    benchmark: c => `<circle cx="10" cy="10" r="7.4" fill="${c}" stroke="#14181c" stroke-width="1.6"/><circle cx="10" cy="10" r="5" fill="#fff"/><circle cx="10" cy="10" r="2.5" fill="${c}" stroke="#14181c" stroke-width="1"/>`,
    board:     c => `<rect x="6.4" y="1.8" width="7.2" height="16.4" fill="${c}" stroke="#14181c" stroke-width="1.6"/><path d="M6.4 6h3.6M6.4 10h3.6M6.4 14h3.6" stroke="#14181c" stroke-width="1.3"/>`,
    crest:     c => `<path d="M10 2.2L17.8 10L10 17.8L2.2 10Z" fill="${c}" stroke="#14181c" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 6.2v7.6" stroke="#14181c" stroke-width="1.6"/>`,
    dot:       c => `<circle cx="10" cy="10" r="6" fill="${c}" stroke="#14181c" stroke-width="1.6"/>`,
  };

  function glyphSvg(k, size = 20) {
    const g = GLYPH[k.glyph] || GLYPH.dot;
    return `<svg class="mn-sf-glyph" viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true" focusable="false">${g(safeColour(k.colour))}</svg>`;
  }

  // A line kind's swatch: a short run in its casing, dashed as it is drawn.
  function lineSwatch(k, size = 20) {
    const dash = k.dash ? ` stroke-dasharray="${esc(String(k.dash).split(',').map(n => Math.max(1, Math.round(n / 2))).join(','))}"` : '';
    return `<svg class="mn-sf-glyph" viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
      + '<path d="M2 15.5L7.5 8.5L12.5 12.5L18 4.5" fill="none" stroke="#14181c" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-opacity=".6"/>'
      + `<path d="M2 15.5L7.5 8.5L12.5 12.5L18 4.5" fill="none" stroke="${safeColour(k.colour)}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"${dash}/></svg>`;
  }

  function kindIcon(k, size = 16) { return k.geometry === 'LineString' ? lineSwatch(k, size) : glyphSvg(k, size); }

  function pointIcon(k, { sel = false, edit: editing = false } = {}) {
    return L.divIcon({
      className: `mn-sf-pt${sel ? ' is-sel' : ''}${editing ? ' is-edit' : ''}`,
      html: glyphSvg(k, 20),
      iconSize: [24, 24], iconAnchor: [12, 12],
    });
  }

  // ── Geometry ───────────────────────────────────────────────────────────────
  // GeoJSON is longitude first; Leaflet, and every coordinate a person reads
  // here, latitude first. The turn happens at these two functions and nowhere
  // else.

  function ptsOf(f) {
    const g = f && f.geom;
    if (!g || !Array.isArray(g.coordinates)) return [];
    if (g.type === 'Point') return [[+g.coordinates[1], +g.coordinates[0]]];
    if (g.type === 'LineString') return g.coordinates.map(c => [+c[1], +c[0]]);
    return [];
  }

  function geomOf(geometry, pts) {
    return geometry === 'LineString'
      ? { type: 'LineString', coordinates: pts.map(p => [round(p[1]), round(p[0])]) }
      : { type: 'Point', coordinates: [round(pts[0][1]), round(pts[0][0])] };
  }

  // Metres between two points on the flat, as field-photos.js and 0061 both
  // measure them — centimetres out at a kilometre, which is the scale of a site.
  function metres(a, b) {
    const dx = (b[1] - a[1]) * kmPerDegLon(a[0]) * 1000;
    const dy = (b[0] - a[0]) * KM_PER_DEG_LAT * 1000;
    return Math.hypot(dx, dy);
  }
  function lengthM(pts) {
    let m = 0;
    for (let i = 1; i < pts.length; i++) m += metres(pts[i - 1], pts[i]);
    return m;
  }
  // The farthest point from the station's pin, as 0061 measures its 10 km.
  function reachM(s, pts) {
    const pin = pinOf(s);
    if (!pin || !pts.length) return null;
    return Math.max(...pts.map(p => metres(pin, p)));
  }
  function fmtM(m) {
    if (m == null || !isFinite(m)) return '—';
    if (m < 10) return `${m.toFixed(1)} m`;
    if (m < 1000) return `${Math.round(m)} m`;
    return fmtKm(m / 1000);
  }
  function fmtAcc(m) { return m < 10 ? `${(Math.round(m * 10) / 10)} m` : `${Math.round(m)} m`; }
  function midpoint(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

  // "latitude, longitude" a line, as the box shows the points.
  function ptsText(pts) { return pts.map(p => `${p[0].toFixed(DP)}, ${p[1].toFixed(DP)}`).join('\n'); }

  // The box read back: one coordinate a line, punctuated however a GPS, a
  // spreadsheet or a plan's table punctuates it (Places.parse, which every
  // coordinate box in the app reads through), latitude first unless the first
  // number cannot be one. { pts } or { error } naming the line that is wrong.
  function parsePts(text) {
    const pts = [];
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      let got = typeof Places !== 'undefined' && Places.parse ? Places.parse(t) : null;
      if (!got) {
        const n = t.split(/[\s,;]+/).filter(Boolean).map(Number);
        if (n.length === 2 && n.every(isFinite)) {
          got = Math.abs(n[0]) > 90 && Math.abs(n[1]) <= 90 ? { lat: n[1], lon: n[0] } : { lat: n[0], lon: n[1] };
        }
      }
      if (!got || !(Math.abs(got.lat) <= 90) || !(Math.abs(got.lon) <= 180)) {
        return { error: `Line ${i + 1} is not a coordinate — “${t}”. One point a line, latitude then longitude.` };
      }
      pts.push([round(got.lat), round(got.lon)]);
    }
    return { pts };
  }

  // ── Words ──────────────────────────────────────────────────────────────────

  function titleOf(f) {
    const k = kindOf(f.kind, f.geom && f.geom.type);
    return f.name ? `${k.label} — ${f.name}` : k.label;
  }
  function measureText(f, s) {
    const pts = ptsOf(f);
    if (f.geom && f.geom.type === 'LineString') return `${fmtM(lengthM(pts))} long, ${pts.length} points`;
    const r = reachM(s, pts);
    return r == null ? 'no pin to measure from' : `${fmtM(r)} from the pin`;
  }
  function far(f, s) {
    const r = reachM(s, ptsOf(f));
    return r != null && r > FAR_M;
  }
  function placedText(placed, acc) {
    switch (placed) {
      case 'gps':   return `by GPS${acc != null && acc !== '' ? ` ±${fmtAcc(+acc)}` : ''}`;
      case 'typed': return 'typed in';
      case 'mixed': return 'some points one way, some another';
      default:      return 'on the map';
    }
  }
  // In the order the vocabulary lists the kinds, named ones by name, the rest
  // as they were added.
  function sorted(rows) {
    return rows.slice().sort((a, b) =>
      (kindOf(a.kind).ord - kindOf(b.kind).ord)
      || String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true })
      || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  }

  // ── The database ───────────────────────────────────────────────────────────

  function missing(err) {
    const t = (err && err.message) || String(err || '');
    return !!err && (err.code === 'PGRST202' || err.code === 'PGRST205' || err.code === '42P01'
      || (/station_feature/.test(t) && /(does not exist|schema cache|not find)/i.test(t)));
  }

  function fresh(id) {
    const c = cache[id];
    return !!c && !c.p && c.rows != null && !c.error && Date.now() - c.at < FRESH_MS;
  }

  // The features of the stations given that are not already in hand, in one
  // request. Resolves when every one of them has an answer, from this request
  // or one already on its way.
  function load(ids, { force = false } = {}) {
    if (!signedIn() || (notReady && !force)) return Promise.resolve();
    const all = [...new Set(ids.filter(Boolean))];
    const want = all.filter(id => !(cache[id] && cache[id].p) && (force || !fresh(id)));
    const pending = all.map(id => cache[id] && cache[id].p).filter(Boolean);
    if (!want.length) return Promise.all(pending).then(() => {});
    const list = want.map(id => `"${String(id).replace(/["\\]/g, m => `\\${m}`)}"`).join(',');
    const p = dbSelect(`station_feature?select=${COLS}&station_id=in.(${encodeURIComponent(list)})&order=created_at.asc`)
      .then(rows => {
        notReady = false;
        const by = {};
        for (const r of rows) (by[r.station_id] = by[r.station_id] || []).push(r);
        const at = Date.now();
        for (const id of want) cache[id] = { at, rows: by[id] || [], p: null, error: null };
      }, err => {
        const gone = missing(err);
        if (gone) notReady = true;
        const at = Date.now();
        for (const id of want) {
          cache[id] = { at, rows: (cache[id] && cache[id].rows) || null, p: null,
                        error: gone ? NOT_READY : ((err && err.message) || String(err)) };
        }
      });
    for (const id of want) cache[id] = { at: 0, rows: null, ...(cache[id] || {}), p, error: null };
    return Promise.all([p, ...pending]).then(() => {});
  }

  // A saved row into the cache, in place of its old self.
  function keep(row) {
    const c = cache[row.station_id] || (cache[row.station_id] = { at: Date.now(), rows: [], p: null, error: null });
    c.rows = (c.rows || []).filter(r => r.id !== row.id).concat([row]);
  }
  function drop(stationId, id) {
    const c = cache[stationId];
    if (c && c.rows) c.rows = c.rows.filter(r => r.id !== id);
  }

  // ── The layer ──────────────────────────────────────────────────────────────

  // The stations in and around the view, nearest the middle first: a site's
  // benchmark can be off the screen its station is on.
  function stationsInView() {
    if (!map || !state.data) return [];
    const b = map.getBounds().pad(0.5);
    const c = map.getCenter();
    const mid = [c.lat, c.lng];
    return state.data.stations
      .filter(s => hasPin(s) && b.contains([+s.lat, +s.lon]))
      .map(s => ({ id: s.id, d: metres(mid, [+s.lat, +s.lon]) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_STATIONS)
      .map(x => x.id);
  }

  // Whose features are drawn: the stations in view while the layer is on and
  // the map is close enough — and, whatever the switch and the zoom say, the
  // station the mode is on and the one a card is showing a feature of.
  function shownIds() {
    if (!map || !signedIn()) return [];
    const ids = [];
    if (state.mapSiteFeatures && map.getZoom() >= minZoom()) ids.push(...stationsInView());
    if (session) ids.push(session.stationId);
    if (highlight) ids.push(highlight.stationId);
    return [...new Set(ids)];
  }

  // The ⛰️ view draws what is drawn here; told whenever that changes, and
  // nothing rebuilt there when it is what was drawn last time (map-3d.js).
  function tell3d() {
    if (typeof Map3D !== 'undefined' && Map3D.siteFeaturesChanged) Map3D.siteFeaturesChanged();
  }

  function clearLayer({ quiet = false } = {}) {
    if (layer) { layer.remove(); layer = null; }
    drawnKinds = [];
    shown = [];
    if (!quiet) tell3d();
  }

  function draw() {
    if (!map) return;
    clearLayer({ quiet: true });
    layer = L.layerGroup();
    const editing = session && session.draft && session.draft.id;
    const kindsHere = new Set();
    for (const id of shownIds()) {
      const c = cache[id];
      if (!c || !c.rows) continue;
      const s = stationById(id);
      for (const f of c.rows) {
        if (editing && f.id === editing) continue;       // the draft stands in for it
        const sel = (session && session.stationId === id && session.selectedId === f.id)
          || (!!highlight && highlight.id === f.id);
        if (drawFeature(f, s, sel)) kindsHere.add(f.kind);
      }
    }
    layer.addTo(map);
    drawnKinds = [...kindsHere].sort((a, b) => kindOf(a).ord - kindOf(b).ord);
    tell3d();
  }

  // How a line is drawn, in Leaflet's pixels: the run, and the dark casing
  // under it that reads over the State's imagery and the topo alike — each
  // heavier picked. One place for the numbers, because the ⛰️ view draws the
  // same lines with them (map-3d.js).
  const LOOK = { weight: 3.5, weightSel: 5, casing: '#14181c', casingWeight: 7, casingWeightSel: 10,
                 casingOpacity: 0.55, casingOpacitySel: 0.8 };

  function drawFeature(f, s, sel) {
    const k = kindOf(f.kind, f.geom && f.geom.type);
    const pts = ptsOf(f);
    if (!pts.length) return false;
    const title = titleOf(f);
    const isLine = f.geom.type === 'LineString';
    shown.push({ id: f.id, station: f.station_id, name: (s && s.name) || f.station_id, kind: f.kind,
                 line: isLine, pts, sel: !!sel, colour: safeColour(k.colour), dash: isLine ? (k.dash || null) : null,
                 title, sub: measureText(f, s) });
    if (isLine) {
      L.polyline(pts, { color: LOOK.casing, opacity: sel ? LOOK.casingOpacitySel : LOOK.casingOpacity,
                        weight: sel ? LOOK.casingWeightSel : LOOK.casingWeight,
                        lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(layer);
      // A dashed run squared off at its ends: Leaflet's round caps lengthen
      // every dash by half the weight each way, and close a short gap
      // (docs/design-system.md, the health pins).
      const line = L.polyline(pts, { color: safeColour(k.colour), weight: sel ? LOOK.weightSel : LOOK.weight, opacity: 1,
                                     dashArray: k.dash || null, lineCap: k.dash ? 'butt' : 'round', lineJoin: 'round',
                                     bubblingMouseEvents: false });
      line.bindTooltip(`${esc(title)} · ${esc(measureText(f, s))}`,
                       { sticky: true, direction: 'top', offset: [0, -10], className: 'mn-sf-tip' });
      line.on('click', e => { L.DomEvent.stop(e); onFeatureClick(f, e.latlng); });
      line.addTo(layer);
    } else {
      const m = L.marker(pts[0], { icon: pointIcon(k, { sel }), pane: PANE, keyboard: true, title, alt: title,
                                   riseOnHover: true, bubblingMouseEvents: false });
      m.on('click', e => { L.DomEvent.stop(e); onFeatureClick(f, L.latLng(pts[0])); });
      m.addTo(layer);
    }
    return true;
  }

  function countDrawn(ids) {
    let n = 0, at = 0;
    for (const id of ids) {
      const rows = cache[id] && cache[id].rows;
      if (rows && rows.length) { n += rows.length; at++; }
    }
    return { n, at };
  }

  function setNote(kind, extra = {}) {
    note = Object.assign({ kind, n: 0, stations: 0, error: '' }, extra);
    const el = document.getElementById('map-sitefeat-note');
    if (el) el.innerHTML = noteHtml();
  }

  function run() {
    if (!map) return;
    if (!signedIn()) { clearLayer(); setNote('signed-out'); return; }
    // The vocabulary once a session; what is drawn and listed again only if
    // the database's differs from the one it was drawn with.
    if (!kinds && !kindsTried) {
      loadKinds().then(() => {
        if (!kinds || !map) return;
        if (layer) draw();
        repaintPanel();
      });
    }
    const ids = shownIds();
    const mine = ++seq;
    if (!ids.length) {
      clearLayer();
      setNote(!state.mapSiteFeatures ? 'off' : 'zoom');
      return;
    }
    if (ids.some(id => !fresh(id)) && !layer) setNote('loading');
    load(ids).then(() => {
      if (mine !== seq || !map) return;
      draw();
      const err = ids.map(id => cache[id] && cache[id].error).find(Boolean);
      if (notReady) setNote('not-ready');
      else if (err) setNote('fail', { error: err });
      else if (!state.mapSiteFeatures) setNote('off');
      else if (map.getZoom() < minZoom()) setNote('zoom');
      else { const c = countDrawn(ids); setNote('ok', { n: c.n, stations: c.at }); }
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    });
  }

  function sync() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  function noteHtml() {
    switch (note.kind) {
      case 'off':
        return 'A station’s orifice outlet, pits, benchmarks, gauge boards, orifice run and access tracks, where they have been mapped. 📌 Site features on a station’s card maps them.';
      case 'signed-out':
        return 'Site features are for signed-in editors — sign in to see where they are.';
      case 'zoom':
        return tilted() ? 'Bring the camera in closer to see the stations’ site features.'
          : `Zoom in (to level ${MIN_ZOOM} or closer) to see the stations’ site features.`;
      case 'loading':
        return 'Looking for site features in view…';
      case 'not-ready':
        return `<span class="txt-warn">${esc(NOT_READY)}</span>`;
      case 'fail':
        return `<span class="txt-bad">No site features — ${esc(note.error)}</span>`;
      case 'ok':
        return note.n
          ? `${note.n} site feature${note.n === 1 ? '' : 's'} at ${note.stations} station${note.stations === 1 ? '' : 's'} in and around this view. Click one for what it is.`
          : 'No site features have been mapped in and around this view.';
      default:
        return '';
    }
  }

  // A feature clicked on the map: in the mode, at its station, it is picked
  // in the list; anywhere else it says what it is, with the door into the mode.
  function onFeatureClick(f, at) {
    if (session && session.draft) return;
    if (session && session.stationId === f.station_id) { select(f.id); return; }
    if (!map) return;
    L.popup({ className: 'mn-sf-popup', maxWidth: 300, autoPanPadding: [40, 40] })
      .setLatLng(at).setContent(popupHtml(f)).openOn(map);
  }

  function popupHtml(f) {
    const k = kindOf(f.kind, f.geom && f.geom.type);
    const s = stationById(f.station_id);
    const when = String(f.updated_at || f.created_at || '').slice(0, 10);
    return `<div class="mn-sf-pop">
      <p class="mn-sf-pop-head">${kindIcon(k)} <strong>${esc(k.label)}</strong>${f.name ? ` · ${esc(f.name)}` : ''}</p>
      ${f.note ? `<p class="small mn-sf-pop-note">${esc(f.note)}</p>` : ''}
      <p class="small txt-muted">${esc(s ? s.name : f.station_id)} · ${esc(measureText(f, s))}${far(f, s) ? ' — far from the pin' : ''}.
        Placed ${esc(placedText(f.placed, f.accuracy_m))}${when ? `, last changed ${esc(when)}${f.updated_by ? ` by ${esc(f.updated_by)}` : ''}` : ''}.</p>
      <div class="pill-row"><button type="button" class="pill"
        onclick="SiteFeatures.start('${escAttr(f.station_id)}', { edit: '${escAttr(f.id)}' })">✏️ Edit on the map</button></div>
    </div>`;
  }

  // A click on the bare map puts down whatever the card had shown.
  function onBareClick() {
    if (highlight && !session) { highlight = null; draw(); }
  }

  // ── The station card ───────────────────────────────────────────────────────
  // What is mapped at the station, for a signed-in editor: a row a feature, its
  // name or where it is, each a button that shows it on the map. Drawn empty
  // and filled when the rows arrive, SLS.ask's terms (app.js, repaintStnCard);
  // an empty section is not drawn at all (:empty).

  function cardHtml(s) {
    if (!s || !signedIn()) return '';
    return `<div class="acma-sect stn-card-sitefeat" id="mn-sitefeat-card-${esc(s.id)}" data-mn-sitefeat="${esc(s.id)}">${cardBodyHtml(s)}</div>`;
  }

  function cardBodyHtml(s) {
    const head = '<span class="small txt-muted stn-card-sf-h">Site features</span>';
    if (notReady) return `${head}<p class="small txt-muted">${esc(NOT_READY)}</p>`;
    const c = cache[s.id];
    if (!c || c.rows == null) {
      return c && c.error ? `${head}<p class="small txt-bad">Could not be read — ${esc(c.error)}</p>` : '';
    }
    if (!c.rows.length) return `${head}<p class="small txt-muted">None mapped yet.</p>`;
    return head + sorted(c.rows).map(f => {
      const k = kindOf(f.kind, f.geom && f.geom.type);
      const where = f.geom && f.geom.type === 'LineString'
        ? `${fmtM(lengthM(ptsOf(f)))} long` : (() => { const r = reachM(s, ptsOf(f)); return r == null ? 'mapped' : `${fmtM(r)} from the pin`; })();
      return `<div class="acma-row"><span class="stn-card-sf-kind">${kindIcon(k)} ${esc(k.label)}</span><span>`
        + `<button type="button" class="link-btn" onclick="SiteFeatures.show('${escAttr(s.id)}', '${escAttr(f.id)}')"`
        + ` title="Show it on the map">${f.name ? `${esc(f.name)} · ` : ''}${esc(where)}</button></span></div>`;
    }).join('');
  }

  function cardAsk(s) {
    if (!s || !signedIn()) return;
    const id = s.id;
    load([id]).then(() => {
      const el = document.getElementById(`mn-sitefeat-card-${id}`);
      if (el && el.dataset.mnSitefeat === id) el.innerHTML = cardBodyHtml(s);
    });
  }

  // The feature, on the map: close enough to see it, and ringed until the map
  // is clicked or another is shown.
  function show(stationId, id) {
    const c = cache[stationId];
    const f = c && c.rows && c.rows.find(r => r.id === id);
    if (!f || !map) return;
    highlight = { stationId, id };
    const pts = ptsOf(f);
    if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 18));
    else map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 19 });
    draw();
    sync();
    announce(`${titleOf(f)}, shown on the map.`);
  }

  // ── The two buttons that arm the mode ──────────────────────────────────────
  // One on the station card, one in the station editor beside Move pin — the
  // same mode, from wherever the station is already in hand. Signed in only:
  // signed out there is nothing to look at, let alone to change.

  function armedFor(id) { return !!session && session.stationId === id; }

  function pillHtml(s) {
    if (!s || !s.id || !signedIn()) return '';
    const on = armedFor(s.id);
    return `<button type="button" class="pill mn-sitefeat-pill${on ? ' is-on' : ''}" aria-pressed="${on}"
        onclick="SiteFeatures.${on ? 'stop()' : `start('${escAttr(s.id)}')`}"
        title="${on ? 'Close site features' : 'Map this station’s orifice outlet, pits, benchmarks and gauge boards, and draw its orifice run'}"
        >${pillText('📌', on ? 'Mapping site features…' : 'Site features')}</button>`;
  }

  function editorButtonHtml(s) {
    if (!s || !s.id || !signedIn()) return '';
    const on = armedFor(s.id);
    return `<button type="button" class="pill${on ? ' is-on' : ''}" id="ef-sitefeat" aria-pressed="${on}"
        onclick="SiteFeatures.${on ? 'stop()' : `start('${escAttr(s.id)}')`}"
        title="${on ? 'Close site features' : 'Map this station’s orifice outlet, pits, benchmarks, gauge boards and orifice run on the map above'}"
        >${pillText('📌', on ? 'Mapping site features…' : `Site features${pillLong(' on the map')}`)}</button>`;
  }

  // Both, wherever they are: the editor's in place (a re-render of the card
  // would throw away what is half-typed in it), the station card's by its own
  // repaint, which paints nothing when no card is up.
  function repaintButtons() {
    const el = document.getElementById('ef-sitefeat');
    const s = el && stationById(state.editorId);
    if (el && s) el.outerHTML = editorButtonHtml(s);
    if (typeof repaintStnCard === 'function') repaintStnCard();
  }

  // ── The mode ───────────────────────────────────────────────────────────────
  // session: { stationId, draft, selectedId, msg, busy, folded }
  // draft:   { id, stamp, kind, name, note, pts, src, acc, drawing, sel, dirty, ptsOpen }
  //          — pts latitude first; src and acc a point each: how it was got
  //          (map, gps, typed, or a saved line's own `placed`) and a fix's ±.

  function sessionStation() { return session ? stationById(session.stationId) : null; }
  function features() {
    const c = session && cache[session.stationId];
    return (c && c.rows) || [];
  }
  function dirty() { return !!(session && session.draft && session.draft.dirty); }

  function confirmDiscard() {
    const d = session && session.draft;
    const what = !d ? 'what is drawn'
      : d.id ? `your changes to the ${kindOf(d.kind).label.toLowerCase()}`
      : `the new ${kindOf(d.kind).label.toLowerCase()}`;
    return confirmDialog({
      title: `Throw away ${what}?`,
      message: 'It has not been saved.',
      confirm: 'Throw it away', cancel: 'Keep it', danger: true,
    });
  }

  // The map has no registry of exclusive modes — link-budget.js's guard is the
  // whole precedent — so this says which it is taking the map from: a draw
  // tool, whose `.mn-drawing` puts pointer-events: none on every marker and
  // would leave a handle undraggable; the link budget's picker and What is
  // here, which answer the same click; and a pin being moved, which is one
  // station's mode as this is.
  function takeMap() {
    if (state.draw && state.draw.tool && typeof MapDraw !== 'undefined') MapDraw.setTool('');
    if (typeof LinkBudget !== 'undefined' && LinkBudget.setPicking && state.link && state.link.picking) LinkBudget.setPicking(false);
    if (typeof MapHere !== 'undefined' && MapHere.armed && MapHere.armed()) MapHere.arm(false);
    if (typeof MapMovePin !== 'undefined' && MapMovePin.armed && MapMovePin.armed()) MapMovePin.cancel();
  }

  // Arm the mode for a station, or — already armed for it — open one of its
  // features: { edit: id }. From the card, the editor, a feature's popup.
  async function start(id, opts = {}) {
    const s = stationById(id);
    if (!s) return;
    if (!signedIn()) { if (typeof Auth !== 'undefined') Auth.open(); return; }
    if (!map) {
      announce('Site features are mapped on the Stations map — open it first.');
      return;
    }
    if (session && session.stationId === id) {
      if (opts.edit) await edit(opts.edit);
      return;
    }
    if (session && dirty() && !await confirmDiscard()) return;
    if (session) end();
    // Mapped on the flat map: a twin up over it is put away first, or the
    // panel would come up under it (it stands down for the twin) and the
    // press would seem to have done nothing — and ⛰️ 3-D is left, whose
    // camera's ground is not the flat map's under a click (mapIsOurs).
    if (typeof MapTwin !== 'undefined' && MapTwin.active && MapTwin.active()) MapTwin.leave();
    if (typeof Map3D !== 'undefined' && Map3D.active && Map3D.active() && Map3D.stop) Map3D.stop();
    takeMap();
    highlight = null;
    session = { stationId: id, draft: null, selectedId: opts.edit || null, msg: null, busy: false, folded: false };
    // The mode takes the map, and the station card gives way to it, as it does
    // to Move pin: on a phone the card is a sheet over the panel this adds.
    if (typeof closeStnCard === 'function') closeStnCard(false);
    map.closePopup();
    arm();
    goTo(s);
    repaintButtons();
    twinSync();
    // The pill that was pressed went with the card: focus comes to the panel's
    // first control rather than falling to the page (#138's rule).
    const a = document.activeElement;
    if (!a || a === document.body || !a.isConnected) {
      const first = document.getElementById('mn-sf-kind');
      if (first) first.focus({ preventScroll: true });
    }
    const text = `Site features at ${s.name || id}. Pick what to add and put it on the map, or pick one to edit it. Escape closes.`;
    announce(text);
    mapNote('Site features: pick what to add, then put it on the map. Escape closes.', 6000);
    await load([id], { force: true });
    if (!session || session.stationId !== id) return;
    draw();
    repaintPanel();
    if (opts.edit) await edit(opts.edit);
  }

  // How much of the map the panel stands over, as padding for Leaflet's
  // panInside and fitBounds: down its left side on a map with room beside
  // the panel, across its foot on a phone's, where the panel is the width of
  // the map. What is being worked on is put where the panel is not.
  function clearOfPanel(edge = 24) {
    const pad = { paddingTopLeft: [edge, edge], paddingBottomRight: [edge, edge] };
    const el = panel && panel.getContainer();
    if (!map || !el || !el.offsetWidth) return pad;
    const m = map.getContainer().getBoundingClientRect();
    const p = el.getBoundingClientRect();
    if (m.right - p.right >= 220) pad.paddingTopLeft[0] = Math.max(edge, p.right - m.left + edge);
    else pad.paddingBottomRight[1] = Math.max(edge, m.bottom - p.top + edge);
    return pad;
  }

  // A point, or a line's points, in view and clear of the panel — moving the
  // map only as far as that needs, or (`centre`) to the middle of what is left.
  function bringIntoView(pts, { centre = false, zoom = null } = {}) {
    if (!map || !pts || !pts.length) return;
    const pad = clearOfPanel();
    if (pts.length > 1) {
      map.fitBounds(L.latLngBounds(pts), { ...pad, maxZoom: Math.max(map.getZoom(), zoom || 17) });
      return;
    }
    if (zoom != null && map.getZoom() < zoom) centre = true;
    if (!centre) { map.panInside(pts[0], pad); return; }
    map.setView(pts[0], Math.max(map.getZoom(), zoom || 0), { animate: false });
    const dx = (pad.paddingTopLeft[0] - pad.paddingBottomRight[0]) / 2;
    const dy = (pad.paddingTopLeft[1] - pad.paddingBottomRight[1]) / 2;
    if (dx || dy) map.panBy([-dx, -dy], { animate: false });
  }

  // The site, close enough to put a pit on — from zoom 18, where the State's
  // imagery is a few decimetres a pixel — and beside the panel, not under it.
  function goTo(s) {
    const pin = pinOf(s);
    if (pin) bringIntoView([pin], { centre: map && map.getZoom() < 17, zoom: 18 });
  }

  // The mode's hold on the map: its listeners, its panel, its drawing. Undone
  // by disarm(), which keeps the session — detach() calls it — and by end(),
  // which does not.
  function arm() {
    if (!map || !session) return;
    if (!map.getPane(EDIT_PANE)) map.createPane(EDIT_PANE).style.zIndex = EDIT_Z;
    if (editLayer) editLayer.remove();
    editLayer = L.layerGroup().addTo(map);
    map.on('click', onMapClick);
    map.on('mousemove', onMove);
    map.on('dblclick', onDblClick);
    if (!keyHandler) { keyHandler = onKey; document.addEventListener('keydown', keyHandler, true); }
    addPanel();
    syncMode();
  }

  function disarm() {
    if (map) {
      map.off('click', onMapClick);
      map.off('mousemove', onMove);
      map.off('dblclick', onDblClick);
      if (panel) map.removeControl(panel);
      map.getContainer().classList.remove('mn-sf-placing', 'mn-sf-drawing');
      map.doubleClickZoom.enable();
    }
    if (editLayer) { editLayer.remove(); editLayer = null; }
    pieces = null;
    if (keyHandler) { document.removeEventListener('keydown', keyHandler, true); keyHandler = null; }
    panel = null;
  }

  function end() {
    disarm();
    session = null;
    ghostTo = null;
    draw();
    repaintButtons();
    twinSync();
  }

  // The twin holds its offer while the mode is armed (map-twin.js asks
  // armed()), so it is told when that changes.
  function twinSync() {
    if (typeof MapTwin !== 'undefined' && MapTwin.sync) MapTwin.sync();
  }

  // A phone's map — narrower than the scale's `xs` step — where the panel open
  // is most of the map: it folds to its head and its Save while a feature is
  // being put on the ground. A desktop's map beside the side panel can be
  // narrower than `sm` and still leave the site room beside the panel, which
  // is what clearOfPanel() gives it. Named off BREAKPOINTS (core.js).
  function narrow() {
    const xs = typeof BREAKPOINTS !== 'undefined' ? BREAKPOINTS.xs : 560;
    return !!map && map.getContainer().clientWidth < xs;
  }

  async function stop({ force = false } = {}) {
    if (!session) return;
    if (session.busy) return;
    if (!force && dirty() && !await confirmDiscard()) return;
    if (!session) return;
    const s = sessionStation();
    const el = panel && panel.getContainer();
    const hadFocus = !!el && el.contains(document.activeElement);
    end();
    sync();
    // Focus that was in the panel goes to the map the panel stood on.
    if (hadFocus && map) map.getContainer().focus({ preventScroll: true });
    mapNote('Site features closed.', 3000);
    announce(`Site features at ${(s && s.name) || 'the station'} closed.`);
  }

  // Which station is armed, or null — and whether a draft would be lost: read
  // by map-move-pin.js before it takes the map.
  function armed() { return session ? session.stationId : null; }

  function addPanel() {
    panel = L.control({ position: 'bottomleft' });
    panel.onAdd = () => {
      const div = L.DomUtil.create('div', 'mn-sf-panel');
      div.setAttribute('role', 'group');
      div.setAttribute('aria-label', 'Site features');
      div.innerHTML = panelHtml();
      // A click on Save must not also be a click on the map, which would put
      // the point being placed under the panel's own corner.
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    panel.addTo(map);
  }

  // The container's two classes, the double-click, and the drawing of the
  // draft, for whatever the mode is doing now.
  function syncMode() {
    if (!map) return;
    const d = session && session.draft;
    const line = !!d && isLineKind(d.kind);
    const el = map.getContainer();
    el.classList.toggle('mn-sf-placing', !!d && !line);
    el.classList.toggle('mn-sf-drawing', !!d && line && d.drawing);
    if (d && line && d.drawing) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    drawEdit();
  }

  // ── The draft on the map ───────────────────────────────────────────────────

  function handleIcon(i, d) {
    const end_ = i === 0 || i === d.pts.length - 1;
    return L.divIcon({
      className: `mn-sf-handle${d.sel === i ? ' is-sel' : ''}${end_ ? ' is-end' : ''}`,
      html: '<i></i>', iconSize: [16, 16], iconAnchor: [8, 8],
    });
  }
  function midIcon() {
    return L.divIcon({ className: 'mn-sf-mid', html: '<i aria-hidden="true">+</i>', iconSize: [16, 16], iconAnchor: [8, 8] });
  }

  function drawEdit() {
    if (!editLayer) return;
    editLayer.clearLayers();
    pieces = { line: null, casing: null, ghost: null, snap: null, point: null };
    const d = session && session.draft;
    if (!d) return;
    const k = kindOf(d.kind);
    if (isLineKind(d.kind)) {
      if (d.pts.length) {
        pieces.casing = L.polyline(d.pts, { color: '#14181c', opacity: .6, weight: 9, interactive: false,
                                          lineCap: 'round', lineJoin: 'round' }).addTo(editLayer);
        pieces.line = L.polyline(d.pts, { color: safeColour(k.colour), weight: 4.5, dashArray: k.dash || null,
                                        interactive: false, lineCap: k.dash ? 'butt' : 'round', lineJoin: 'round' }).addTo(editLayer);
      }
      d.pts.forEach((p, i) => {
        const h = L.marker(p, { icon: handleIcon(i, d), pane: EDIT_PANE, draggable: !d.drawing, keyboard: false,
                                title: `Point ${i + 1}`, bubblingMouseEvents: false, zIndexOffset: 100 });
        if (!d.drawing) {
          h.on('drag', e => moveVertex(i, e.latlng, { live: true }));
          h.on('dragend', e => moveVertex(i, e.target.getLatLng()));
          h.on('click', e => { L.DomEvent.stop(e); selectVertex(i); });
        }
        h.addTo(editLayer);
      });
      // A ＋ halfway along each stretch: drag it, or click it, for a point there.
      if (!d.drawing && d.pts.length < MAX_POINTS) {
        for (let i = 1; i < d.pts.length; i++) {
          const h = L.marker(midpoint(d.pts[i - 1], d.pts[i]), {
            icon: midIcon(), pane: EDIT_PANE, draggable: true, keyboard: false,
            title: 'Drag, or click, for a point here', bubblingMouseEvents: false,
          });
          h.on('dragstart', () => { insertVertex(i, h.getLatLng(), { live: true }); });
          h.on('drag', e => moveVertex(i, e.latlng, { live: true }));
          h.on('dragend', e => moveVertex(i, e.target.getLatLng()));
          h.on('click', e => { L.DomEvent.stop(e); insertVertex(i, h.getLatLng()); });
          h.addTo(editLayer);
        }
      }
    } else if (d.pts.length) {
      pieces.point = L.marker(d.pts[0], { icon: pointIcon(k, { edit: true }), pane: EDIT_PANE, draggable: true,
                                        autoPan: true, keyboard: false, bubblingMouseEvents: false,
                                        title: `${k.label} — drag it, or click the map, to move it` });
      pieces.point.on('drag', e => setPoint(e.latlng, 'map', null, { live: true }));
      pieces.point.on('dragend', e => setPoint(e.target.getLatLng(), 'map'));
      pieces.point.addTo(editLayer);
    }
    showGhost();
  }

  // The dashed stretch from the last point to the pointer while a line is
  // drawn, and a ring on what the next click would snap to.
  function showGhost() {
    if (!pieces) return;
    if (pieces.ghost) { pieces.ghost.remove(); pieces.ghost = null; }
    if (pieces.snap) { pieces.snap.remove(); pieces.snap = null; }
    const d = session && session.draft;
    if (!d || !d.drawing || !ghostTo || !editLayer) return;
    const last = d.pts[d.pts.length - 1];
    if (last) {
      pieces.ghost = L.polyline([last, ghostTo.pt], { color: safeColour(kindOf(d.kind).colour), weight: 2.5,
                                                    dashArray: '5,6', interactive: false }).addTo(editLayer);
    }
    if (ghostTo.snapped) {
      pieces.snap = L.circleMarker(ghostTo.pt, { radius: 12, color: '#ffc400', weight: 2.5, dashArray: '3,3',
                                               fill: false, interactive: false }).addTo(editLayer);
    }
  }

  // What a click near the station's pin or one of its points lands on: that
  // point exactly. Screen pixels, for MapDraw's reason — a distance on the
  // ground would snap from across the paddock at zoom 16 and never at 20.
  function snapTarget(ll) {
    if (!map || !session) return null;
    const at = map.latLngToContainerPoint(ll);
    const d = session.draft;
    const targets = [];
    const pin = pinOf(sessionStation());
    if (pin) targets.push(pin);
    for (const f of features()) {
      if ((d && f.id === d.id) || !f.geom || f.geom.type !== 'Point') continue;
      targets.push(ptsOf(f)[0]);
    }
    let best = null, bestD = SNAP_PX;
    for (const t of targets) {
      const dist = at.distanceTo(map.latLngToContainerPoint(t));
      if (dist <= bestD) { best = t; bestD = dist; }
    }
    return best ? { pt: [round(best[0]), round(best[1])], snapped: true } : null;
  }

  // ── Changing the draft ─────────────────────────────────────────────────────

  function setPoint(ll, src, acc = null, { live = false } = {}) {
    const d = session && session.draft;
    if (!d || isLineKind(d.kind)) return;
    d.pts = [[round(ll.lat), round(ll.lng)]];
    d.src = [src];
    d.acc = [acc];
    d.dirty = true;
    if (!live) drawEdit();
    repaintReadout();
  }

  // One more point at the end of the line. The second click of a double-click
  // lands where the first did, and is not a point.
  function addVertex(p, src, acc = null, { force = false } = {}) {
    const d = session && session.draft;
    if (!d) return;
    if (d.pts.length >= MAX_POINTS) {
      session.msg = { kind: 'error', text: `A line is at most ${MAX_POINTS} points.` };
      repaintPanel();
      return;
    }
    const last = d.pts[d.pts.length - 1];
    if (!force && last && map
        && map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(p)) < 3) return;
    d.pts.push(p);
    d.src.push(src);
    d.acc.push(acc);
    d.dirty = true;
    drawEdit();
    repaintReadout();
  }

  function moveVertex(i, ll, { live = false } = {}) {
    const d = session && session.draft;
    if (!d || i < 0 || i >= d.pts.length) return;
    let p = [round(ll.lat), round(ll.lng)];
    if (!live) { const t = snapTarget(L.latLng(p)); if (t) p = t.pt; }
    d.pts[i] = p;
    d.src[i] = 'map';
    d.acc[i] = null;
    d.dirty = true;
    if (live) {
      if (pieces && pieces.line) pieces.line.setLatLngs(d.pts);
      if (pieces && pieces.casing) pieces.casing.setLatLngs(d.pts);
      repaintReadout();
      return;
    }
    drawEdit();
    repaintReadout();
  }

  function insertVertex(i, ll, { live = false } = {}) {
    const d = session && session.draft;
    if (!d || d.pts.length >= MAX_POINTS) return;
    d.pts.splice(i, 0, [round(ll.lat), round(ll.lng)]);
    d.src.splice(i, 0, 'map');
    d.acc.splice(i, 0, null);
    d.sel = null;
    d.dirty = true;
    if (live) {
      if (pieces && pieces.line) pieces.line.setLatLngs(d.pts);
      if (pieces && pieces.casing) pieces.casing.setLatLngs(d.pts);
      repaintReadout();
      return;
    }
    drawEdit();
    repaintPanel();
  }

  function selectVertex(i) {
    const d = session && session.draft;
    if (!d || d.drawing) return;
    d.sel = d.sel === i ? null : i;
    drawEdit();
    repaintPanel();
  }

  function dropPoint(i) {
    const d = session && session.draft;
    if (!d || !isLineKind(d.kind)) return;
    const at = i == null ? d.sel : i;
    if (at == null || at < 0 || at >= d.pts.length) return;
    if (d.pts.length <= 2) {
      session.msg = { kind: 'error', text: 'A line keeps two points at least — delete the whole line instead.' };
      repaintPanel();
      return;
    }
    d.pts.splice(at, 1);
    d.src.splice(at, 1);
    d.acc.splice(at, 1);
    d.sel = null;
    d.dirty = true;
    drawEdit();
    repaintPanel();
    announce(`Point ${at + 1} taken out — ${d.pts.length} left.`);
  }

  function undo() {
    const d = session && session.draft;
    if (!d || !d.drawing || !d.pts.length) return;
    d.pts.pop();
    d.src.pop();
    d.acc.pop();
    d.dirty = d.pts.length > 0 || !!d.id;
    drawEdit();
    repaintReadout();
    announce(d.pts.length ? `Last point taken back — ${d.pts.length} left.` : 'No points yet.');
  }

  function finish() {
    const d = session && session.draft;
    if (!d || !d.drawing) return;
    if (d.pts.length < 2) {
      session.msg = { kind: 'error', text: 'A line needs two points at least — click where it goes on.' };
      repaintPanel();
      return;
    }
    d.drawing = false;
    ghostTo = null;
    session.msg = null;
    syncMode();
    repaintPanel();
    announce(`Line finished: ${d.pts.length} points, ${fmtM(lengthM(d.pts))}. Drag a point to move it; Save keeps it.`);
  }

  function continueLine() {
    const d = session && session.draft;
    if (!d || !isLineKind(d.kind) || d.drawing || d.pts.length >= MAX_POINTS) return;
    d.drawing = true;
    d.sel = null;
    session.msg = null;
    syncMode();
    repaintPanel();
    announce('Drawing on from the end of the line. Click each point; Enter finishes.');
  }

  // ── The pointer and the keys ───────────────────────────────────────────────

  function mapIsOurs() {
    if (state.draw && state.draw.tool) return false;                       // a draw tool owns its clicks
    if (state.link && state.link.picking) return false;                    // …and the link budget its pick
    if (typeof MapHere !== 'undefined' && MapHere.armed && MapHere.armed()) return false;
    // Under ⛰️ 3-D or the twin, the flat map's coordinate for a pixel is not
    // the ground the operator pointed at (map-move-pin.js says it at length).
    if (typeof Map3D !== 'undefined' && Map3D.active && Map3D.active()) return false;
    if (typeof MapTwin !== 'undefined' && MapTwin.active && MapTwin.active()) return false;
    return true;
  }

  function onMapClick(e) {
    const d = session && session.draft;
    if (!d || session.busy || !mapIsOurs()) return;
    // A press on the panel that repainted the panel — Put it on the map, Save
    // — reaches the map as a click on the ground under it: Leaflet keeps a
    // control's clicks off the map by walking up from what was pressed, and a
    // button the press itself took off the page has nothing above it to walk
    // (map-move-pin.js met the same in the twin). Nothing on the ground is
    // ever off the page, so a click from something that is is not this map's.
    const target = e.originalEvent && e.originalEvent.target;
    if (target && target.isConnected === false) return;
    if (target && target.closest && target.closest('.leaflet-control')) return;
    if (isLineKind(d.kind)) {
      if (!d.drawing) return;
      const t = snapTarget(e.latlng);
      addVertex(t ? t.pt : [round(e.latlng.lat), round(e.latlng.lng)], 'map');
      return;
    }
    setPoint(e.latlng, 'map');
  }

  function onMove(e) {
    const d = session && session.draft;
    if (!d || !d.drawing) return;
    ghostTo = snapTarget(e.latlng) || { pt: [e.latlng.lat, e.latlng.lng], snapped: false };
    showGhost();
  }

  function onDblClick(e) {
    const d = session && session.draft;
    if (d && d.drawing) { L.DomEvent.stop(e); finish(); }
  }

  // The mode's keys come first while it is armed — in the capture phase, as
  // Move pin's do — so one Escape does one thing: finish or let go of the line
  // being drawn, put the draft down, or close the mode, in that order. A key
  // pressed in a box is the box's, Escape aside; a dialog over everything has
  // its own (modal.js takes them on the window, ahead of this).
  function onKey(e) {
    if (!session || e.defaultPrevented) return;
    const modal = document.getElementById('app-modal');
    if (modal && modal.style.display && modal.style.display !== 'none') return;
    const t = e.target;
    const inBox = !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
    const d = session.draft;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (session.busy) return;
      if (d && d.drawing) {
        if (d.pts.length >= 2) finish();
        else discardDraft();
      } else if (d) cancel();
      else stop();
      return;
    }
    if (inBox || !d) return;
    if (e.key === 'Enter' && d.drawing) { e.preventDefault(); finish(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (d.drawing && d.pts.length) { e.preventDefault(); undo(); }
      else if (!d.drawing && d.sel != null) { e.preventDefault(); dropPoint(d.sel); }
    }
  }

  // ── Drafts ─────────────────────────────────────────────────────────────────

  async function add(kindKey) {
    if (!session || session.busy) return;
    const key = kindKey || (document.getElementById('mn-sf-kind') || {}).value;
    if (!key) return;
    if (dirty() && !await confirmDiscard()) return;
    if (!session) return;
    const k = kindOf(key);
    const line = k.geometry === 'LineString';
    session.draft = { id: null, stamp: null, kind: k.key, name: '', note: '', pts: [], src: [], acc: [],
                      drawing: line, sel: null, dirty: false, ptsOpen: false };
    session.selectedId = null;
    session.msg = null;
    ghostTo = null;
    if (narrow()) session.folded = true;
    syncMode();
    draw();
    repaintPanel();
    const text = line
      ? `New ${k.label.toLowerCase()}: click each point along it — points snap to the station and its features. Double-click or Enter finishes; Backspace takes the last point back.`
      : `New ${k.label.toLowerCase()}: click the map where it is, use your position, or type its coordinates.`;
    announce(text);
    mapNote(line ? 'Click each point along the line. Double-click or Enter finishes.' : 'Click the map where it is.', 5000);
  }

  async function edit(id) {
    if (!session || session.busy) return;
    if (session.draft && session.draft.id === id) return;
    if (dirty() && !await confirmDiscard()) return;
    if (!session) return;
    const f = features().find(r => r.id === id);
    if (!f) {
      session.msg = { kind: 'error', text: 'That feature is not in the list any more — somebody may have deleted it.' };
      repaintPanel();
      return;
    }
    const pts = ptsOf(f);
    const src = f.placed || 'map';
    const acc = f.accuracy_m != null && f.accuracy_m !== '' ? +f.accuracy_m : null;
    session.draft = { id: f.id, stamp: f.updated_at, kind: f.kind, name: f.name || '', note: f.note || '',
                      pts, src: pts.map(() => src), acc: pts.map(() => acc),
                      drawing: false, sel: null, dirty: false, ptsOpen: false };
    session.selectedId = f.id;
    session.msg = null;
    ghostTo = null;
    if (narrow()) session.folded = true;
    syncMode();
    draw();
    repaintPanel();
    bringIntoView(pts);
    announce(`Editing ${titleOf(f)}. ${pts.length > 1 ? 'Drag a point to move it.' : 'Drag it, or click the map, to move it.'} Save keeps it.`);
  }

  function discardDraft() {
    if (!session) return;
    const d = session.draft;
    session.draft = null;
    session.folded = false;
    ghostTo = null;
    session.msg = null;
    if (d && d.id) session.selectedId = d.id;
    syncMode();
    draw();
    repaintPanel();
    announce(d && d.id ? 'Left as it was.' : 'Nothing added.');
  }

  async function cancel() {
    const d = session && session.draft;
    if (!d || session.busy) return;
    if (d.dirty && !await confirmDiscard()) return;
    if (!session || session.draft !== d) return;
    discardDraft();
  }

  function select(id) {
    if (!session || session.draft) return;
    session.selectedId = session.selectedId === id ? null : id;
    session.msg = null;
    draw();
    repaintPanel();
    const f = features().find(r => r.id === id);
    if (f && session.selectedId) {
      bringIntoView(ptsOf(f));
      announce(`${titleOf(f)}: ${measureText(f, sessionStation())}.`);
    }
  }

  function setKind(key) {
    const d = session && session.draft;
    if (!d) return;
    const k = kindOf(key);
    if (k.geometry !== kindOf(d.kind).geometry) return;   // a point does not become a line by its kind
    d.kind = k.key;
    d.dirty = true;
    drawEdit();
    repaintPanel();
  }

  // A box typed in: the draft follows without a repaint, which would take the
  // caret out of the box being typed in.
  function setField(field, value) {
    const d = session && session.draft;
    if (!d || (field !== 'name' && field !== 'note')) return;
    d[field] = String(value || '');
    d.dirty = true;
  }

  // The two coordinate boxes, read when one is left: both a number, or a pair
  // pasted into either (places.js splits it between them first).
  function typed() {
    const d = session && session.draft;
    if (!d || isLineKind(d.kind)) return;
    const lat = (document.getElementById('mn-sf-lat') || {}).value;
    const lon = (document.getElementById('mn-sf-lon') || {}).value;
    if (!String(lat || '').trim() || !String(lon || '').trim()) return;
    const got = typeof Places !== 'undefined' && Places.parse ? Places.parse(`${lat}, ${lon}`) : null;
    const la = got ? got.lat : Number(lat), lo = got ? got.lon : Number(lon);
    if (!(Math.abs(la) <= 90) || !(Math.abs(lo) <= 180)) {
      session.msg = { kind: 'error', text: 'That is not a coordinate — a latitude between −90 and 90, a longitude between −180 and 180.' };
      repaintPanel();
      return;
    }
    setPoint(L.latLng(la, lo), 'typed');
    session.msg = null;
    repaintPanel();
    bringIntoView([[la, lo]]);
  }

  function applyPts() {
    const d = session && session.draft;
    if (!d || !isLineKind(d.kind)) return;
    const box = document.getElementById('mn-sf-ptstext');
    const got = parsePts(box ? box.value : '');
    if (got.error) {
      session.msg = { kind: 'error', text: got.error };
      repaintPanel();
      return;
    }
    if (got.pts.length > MAX_POINTS) {
      session.msg = { kind: 'error', text: `A line is at most ${MAX_POINTS} points, not ${got.pts.length}.` };
      repaintPanel();
      return;
    }
    d.pts = got.pts;
    d.src = got.pts.map(() => 'typed');
    d.acc = got.pts.map(() => null);
    d.sel = null;
    d.dirty = true;
    if (d.pts.length >= 2) d.drawing = false;
    ghostTo = null;
    session.msg = { kind: 'ok', text: `${d.pts.length} point${d.pts.length === 1 ? '' : 's'} from the box.` };
    syncMode();
    repaintPanel();
    bringIntoView(d.pts);
  }

  function ptsToggle(open) {
    const d = session && session.draft;
    if (d) d.ptsOpen = !!open;
  }

  function fold() {
    if (!session) return;
    session.folded = !session.folded;
    repaintPanel();
  }

  // Where the device is, as the point or as the line's next point. A fix
  // worse than 100 m places nothing: that is the paddock, not the pit.
  function gps() {
    const d = session && session.draft;
    if (!d || session.busy) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      session.msg = { kind: 'error', text: 'This browser cannot give a position — click the map, or type the coordinates.' };
      repaintPanel();
      return;
    }
    session.msg = { kind: 'busy', text: 'Asking for this device’s position…' };
    repaintPanel();
    navigator.geolocation.getCurrentPosition(pos => {
      if (!session || session.draft !== d) return;
      const acc = pos.coords.accuracy > 0 ? Math.round(pos.coords.accuracy * 100) / 100 : null;
      if (acc != null && acc > GPS_WORST_M) {
        session.msg = { kind: 'error', text: `That fix is only good to ±${Math.round(acc)} m — too coarse to place a feature by. Try again in the open, or place it on the imagery.` };
        repaintPanel();
        return;
      }
      const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
      if (isLineKind(d.kind)) addVertex([round(ll.lat), round(ll.lng)], 'gps', acc, { force: true });
      else setPoint(ll, 'gps', acc);
      const text = `Your position${acc != null ? `, ±${fmtAcc(acc)}` : ''}${acc != null && acc > 10 ? ' — the imagery may be better than that' : ''}.`;
      session.msg = { kind: 'ok', text };
      repaintPanel();
      bringIntoView([[ll.lat, ll.lng]]);
      announce(text);
    }, err => {
      if (!session || session.draft !== d) return;
      session.msg = { kind: 'error', text: err && err.code === 1
        ? 'The browser will not give this device’s position (blocked here, or by policy). Click the map, or type the coordinates.'
        : `No position (${(err && err.message) || 'no answer'}). Click the map, or type the coordinates.` };
      repaintPanel();
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  // ── Saving ─────────────────────────────────────────────────────────────────

  // How the draft's position was got, as one word for the whole feature.
  function placedOf(d) {
    const ways = new Set(d.src.map(s => s || 'map'));
    return ways.size === 1 ? [...ways][0] : 'mixed';
  }
  // The worst of its GPS points' ±, where it has any: the line is no better
  // than its weakest fix.
  function accOf(d) {
    const p = placedOf(d);
    if (p !== 'gps' && p !== 'mixed') return null;
    const a = d.acc.filter(x => x != null && isFinite(x) && x > 0);
    return a.length ? Math.round(Math.max(...a) * 100) / 100 : null;
  }

  // What would stop the database taking the draft, said before the round trip.
  function draftProblem(d) {
    const k = kindOf(d.kind);
    if (k.geometry === 'LineString') {
      if (d.pts.length < 2) return 'A line needs two points at least — click where it runs.';
      if (lengthM(d.pts) < 0.01) return 'A line has to go somewhere — its points are all in one place.';
    } else if (!d.pts.length) {
      return 'Put it on the map first — click where it is, use your position, or type its coordinates.';
    }
    if (k.needs_name && !d.name.trim()) return `An “${k.label.toLowerCase()}” needs a name saying what it is.`;
    const s = sessionStation();
    const r = reachM(s, d.pts);
    if (r != null && r > LIMIT_M) {
      return `That is ${fmtKm(r / 1000)} from the pin of ${s.name}, and a site feature is within 10 km of its station. If the pin is what is wrong, move it first.`;
    }
    return null;
  }

  function saveErrorText(err, verb = 'saved') {
    if (missing(err)) return `Not ${verb} — ${NOT_READY}`;
    if (err && err.conflict) return `Not ${verb} — ${err.message}. Reload shows the version in the database.`;
    if (err && err.denied) return `Not ${verb} — the database did not take this as an editor’s. Sign in with an address on the editors list and try again; what you drew stays here.`;
    if (err instanceof TypeError || (err && !err.status)) return `Not ${verb} — the database could not be reached. What you drew stays here; try again when there is a signal.`;
    return `Not ${verb} — ${(err && err.message) || err}.`;
  }

  async function save() {
    const d = session && session.draft;
    if (!d || session.busy) return;
    const k = kindOf(d.kind);
    const problem = draftProblem(d);
    if (problem) {
      session.msg = { kind: 'error', text: problem };
      repaintPanel();
      announce(problem);
      return;
    }
    if (!signedIn()) {
      session.msg = { kind: 'error', text: 'Not saved — saving needs a signed-in session. Sign in, then press Save again; what you drew stays here.' };
      repaintPanel();
      return;
    }
    const doc = { kind: d.kind, name: d.name.trim(), note: d.note.trim(), geom: geomOf(k.geometry, d.pts),
                  placed: placedOf(d), accuracy_m: accOf(d) };
    if (d.id) doc.id = d.id;
    else doc.station_id = session.stationId;
    const sid = session.stationId;
    session.busy = true;
    session.msg = { kind: 'busy', text: 'Saving…' };
    repaintPanel();
    let row;
    try {
      row = await dbRpc('save_station_feature', { p_feature: doc, p_expected: d.id ? d.stamp : null });
    } catch (err) {
      if (!session || session.draft !== d) return;
      session.busy = false;
      session.msg = { kind: err && err.conflict ? 'conflict' : 'error', text: saveErrorText(err) };
      repaintPanel();
      announce(session.msg.text);
      return;
    }
    if (!row || !row.id) row = { ...doc, id: d.id, station_id: sid };
    keep(row);
    if (!session || session.stationId !== sid) { draw(); return; }
    session.busy = false;
    session.draft = null;
    session.folded = false;
    session.selectedId = row.id;
    ghostTo = null;
    const text = `Saved: ${titleOf(row)} — ${measureText(row, sessionStation())}.`;
    session.msg = { kind: 'ok', text };
    syncMode();
    draw();
    repaintPanel();
    announce(text);
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
  }

  async function remove() {
    const d = session && session.draft;
    if (!d || !d.id || session.busy) return;
    const k = kindOf(d.kind);
    const name = d.name ? `${k.label} “${d.name}”` : `This ${k.label.toLowerCase()}`;
    const ok = await confirmDialog({
      title: `Delete this ${k.label.toLowerCase()}?`,
      message: `${name} leaves the map and the list. The database keeps a record of it, and of who deleted it.`,
      confirm: `Delete the ${k.label.toLowerCase()}`, danger: true,
    });
    if (!ok || !session || session.draft !== d) return;
    const sid = session.stationId;
    session.busy = true;
    session.msg = { kind: 'busy', text: 'Deleting…' };
    repaintPanel();
    try {
      await dbRpc('delete_station_feature', { p_id: d.id, p_expected: d.stamp });
    } catch (err) {
      if (!session || session.draft !== d) return;
      session.busy = false;
      session.msg = { kind: err && err.conflict ? 'conflict' : 'error', text: saveErrorText(err, 'deleted') };
      repaintPanel();
      announce(session.msg.text);
      return;
    }
    drop(sid, d.id);
    if (!session || session.stationId !== sid) { draw(); return; }
    session.busy = false;
    session.draft = null;
    session.folded = false;
    session.selectedId = null;
    const text = `Deleted: ${name.replace(/^This /, 'the ')}.`;
    session.msg = { kind: 'ok', text };
    syncMode();
    draw();
    repaintPanel();
    announce(text);
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
  }

  // After a refusal as stale: the station's features as the database has them
  // now. A draft of a feature somebody else has changed is put down — the
  // change has to be made again on their version, which is opened — and a new
  // one is kept, since nobody else could have touched it.
  async function reload() {
    if (!session || session.busy) return;
    const sid = session.stationId;
    session.msg = { kind: 'busy', text: 'Reloading…' };
    repaintPanel();
    await load([sid], { force: true });
    if (!session || session.stationId !== sid) return;
    const d = session.draft;
    session.msg = null;
    if (d && d.id) {
      const still = features().find(r => r.id === d.id);
      session.draft = null;
      if (still) {
        await edit(still.id);
        if (session) session.msg = { kind: 'note', text: 'This is the version in the database now. Make your change again, and Save.' };
      } else if (session) {
        session.msg = { kind: 'note', text: 'Somebody has deleted that feature since you opened it.' };
      }
    }
    syncMode();
    draw();
    repaintPanel();
  }

  // ── The panel ──────────────────────────────────────────────────────────────

  function kindOptions(cur, geometry = null) {
    const ks = kindList().filter(k => !geometry || k.geometry === geometry);
    const group = (g, label) => {
      const list = ks.filter(k => k.geometry === g);
      return list.length ? `<optgroup label="${label}">${list.map(k =>
        `<option value="${esc(k.key)}"${k.key === cur ? ' selected' : ''}>${esc(k.label)}</option>`).join('')}</optgroup>` : '';
    };
    return group('Point', 'Points') + group('LineString', 'Lines');
  }

  function rowHtml(f, s) {
    const k = kindOf(f.kind, f.geom && f.geom.type);
    const sel = session.selectedId === f.id;
    return `<li class="mn-sf-row${sel ? ' is-sel' : ''}">
        <button type="button" class="mn-sf-pick" id="mn-sf-pick-${esc(f.id)}" aria-pressed="${sel}"
                onclick="SiteFeatures.select('${escAttr(f.id)}')">${kindIcon(k)}<span class="mn-sf-what"><span>${esc(k.label)}${f.name ? ` · ${esc(f.name)}` : ''}</span><span class="small txt-muted">${esc(measureText(f, s))}${far(f, s) ? ' — far from the pin' : ''}</span></span></button>
        <button type="button" class="pill mn-sf-edit" id="mn-sf-edit-${esc(f.id)}" onclick="SiteFeatures.edit('${escAttr(f.id)}')"
                aria-label="Edit ${esc(titleOf(f))}">Edit</button>
      </li>`;
  }

  function listHtml(s) {
    const c = cache[session.stationId];
    const rows = features();
    let body;
    if (notReady) body = `<p class="small txt-warn">${esc(NOT_READY)}</p>`;
    else if (!c || (c.rows == null && !c.error)) body = '<p class="small txt-muted">Reading this station’s site features…</p>';
    else if (c.error) body = `<p class="small txt-bad">Could not read them — ${esc(c.error)}</p>`;
    else if (!rows.length) body = '<p class="small txt-muted">None mapped yet. Pick what to add, below.</p>';
    else body = `<ul class="mn-sf-list" aria-label="Site features at ${esc((s && s.name) || session.stationId)}">${sorted(rows).map(f => rowHtml(f, s)).join('')}</ul>`;
    return `
      ${body}
      <div class="mn-sf-add">
        <label class="mn-sf-field"><span>Add</span>
          <select id="mn-sf-kind">${kindOptions(null)}</select></label>
        <button type="button" class="pill is-on" id="mn-sf-add" onclick="SiteFeatures.add()"${notReady ? ' disabled' : ''}>Put it on the map</button>
      </div>
      <div class="pill-row mn-sf-actions">
        <button type="button" class="pill" id="mn-sf-dl" onclick="SiteFeatures.download()"${rows.length ? '' : ' disabled'}
                title="Download this station’s site features as GeoJSON, for QGIS or Google Earth">⬇ GeoJSON</button>
        <button type="button" class="pill" id="mn-sf-done" onclick="SiteFeatures.stop()">Done</button>
      </div>`;
  }

  function hintFor(d) {
    if (isLineKind(d.kind)) {
      return d.drawing
        ? 'Click each point along it, from the shelter through each pit to the end — a click snaps to the station and its points. Double-click or Enter finishes; Backspace takes a point back.'
        : 'Drag a point to move it, or a ＋ to add one. Click a point to pick it; Delete takes it out.';
    }
    return d.pts.length ? 'Drag it, or click the map, to move it.' : 'Click the map where it is — or stand on it and use your position, or type its coordinates.';
  }

  function readoutHtml(d) {
    const s = sessionStation();
    const placed = d.pts.length ? placedText(placedOf(d), accOf(d)) : '—';
    if (isLineKind(d.kind)) {
      return `<dt>Points</dt><dd>${d.pts.length}</dd>
        <dt>Length</dt><dd>${d.pts.length > 1 ? esc(fmtM(lengthM(d.pts))) : '—'}</dd>
        <dt>Placed</dt><dd>${esc(placed)}</dd>`;
    }
    const r = reachM(s, d.pts);
    return `<dt>Placed</dt><dd>${esc(placed)}</dd>
      <dt>From the pin</dt><dd>${r == null ? '—' : `${esc(fmtM(r))}${r > FAR_M ? ' <span class="txt-warn">— far from it</span>' : ''}`}</dd>`;
  }

  function pointControlsHtml(d) {
    const p = d.pts[0];
    return `
      <div class="mn-sf-coords">
        <label class="mn-sf-field"><span>Latitude</span><input type="text" id="mn-sf-lat" data-coord="lat" spellcheck="false"
          autocomplete="off" value="${p ? p[0].toFixed(DP) : ''}" onchange="SiteFeatures.typed()"></label>
        <label class="mn-sf-field"><span>Longitude</span><input type="text" id="mn-sf-lon" data-coord="lon" spellcheck="false"
          autocomplete="off" value="${p ? p[1].toFixed(DP) : ''}" onchange="SiteFeatures.typed()"></label>
      </div>
      <div class="pill-row"><button type="button" class="pill" id="mn-sf-gps" onclick="SiteFeatures.gps()">📍 Use my position</button></div>`;
  }

  function lineControlsHtml(d) {
    const n = d.pts.length;
    const drawBtns = d.drawing
      ? `<button type="button" class="pill is-on" id="mn-sf-finish" onclick="SiteFeatures.finish()"${n < 2 ? ' disabled' : ''}>✓ Finish the line</button>
         <button type="button" class="pill" id="mn-sf-undo" onclick="SiteFeatures.undo()"${n ? '' : ' disabled'}>↶ Last point back</button>`
      : `<button type="button" class="pill" id="mn-sf-continue" onclick="SiteFeatures.continueLine()"${n >= MAX_POINTS ? ' disabled' : ''}>＋ Carry on from the end</button>
         ${d.sel != null ? `<button type="button" class="pill" id="mn-sf-drop" onclick="SiteFeatures.dropPoint()">✕ Take out point ${d.sel + 1}</button>` : ''}`;
    return `
      <div class="pill-row mn-sf-line">
        ${drawBtns}
        <button type="button" class="pill" id="mn-sf-gps" onclick="SiteFeatures.gps()">📍 Add my position</button>
      </div>
      <details class="mn-sf-pts"${d.ptsOpen ? ' open' : ''} ontoggle="SiteFeatures.ptsToggle(this.open)">
        <summary>Points as coordinates</summary>
        <label class="mn-sf-field"><span>One point a line: latitude, longitude</span>
          <textarea id="mn-sf-ptstext" rows="4" spellcheck="false">${esc(ptsText(d.pts))}</textarea></label>
        <button type="button" class="pill" id="mn-sf-apply" onclick="SiteFeatures.applyPts()">Use these points</button>
      </details>`;
  }

  function draftHtml(d) {
    const k = kindOf(d.kind);
    const line = k.geometry === 'LineString';
    const busy = session.busy;
    return `
      <p class="mn-sf-doing">${kindIcon(k)} <strong>${d.id ? 'Editing' : 'New'} ${esc(k.label.toLowerCase())}</strong></p>
      <p class="mn-sf-hint" id="mn-sf-hint">${esc(hintFor(d))}</p>
      <div class="mn-sf-form">
        <label class="mn-sf-field"><span>Kind</span>
          <select id="mn-sf-dkind" onchange="SiteFeatures.setKind(this.value)">${kindOptions(d.kind, k.geometry)}</select></label>
        <label class="mn-sf-field"><span>Name${k.needs_name ? '' : ' <span class="txt-muted">(optional)</span>'}</span>
          <input type="text" id="mn-sf-name" maxlength="100" autocomplete="off" value="${esc(d.name)}"
                 placeholder="${line ? 'e.g. old line' : 'e.g. BM1, Pit 2'}" oninput="SiteFeatures.setField('name', this.value)"></label>
        <label class="mn-sf-field mn-sf-wide"><span>Note <span class="txt-muted">(optional)</span></span>
          <textarea id="mn-sf-note" rows="1" maxlength="2000" oninput="SiteFeatures.setField('note', this.value)">${esc(d.note)}</textarea></label>
        <div class="mn-sf-wide">${line ? lineControlsHtml(d) : pointControlsHtml(d)}</div>
      </div>
      <dl class="mn-sf-read" id="mn-sf-read">${readoutHtml(d)}</dl>
      <div class="pill-row mn-sf-actions">
        <button type="button" class="pill is-on" id="mn-sf-save" onclick="SiteFeatures.save()"${busy ? ' disabled' : ''}>${busy ? 'Saving…' : 'Save'}</button>
        <button type="button" class="pill" id="mn-sf-cancel" onclick="SiteFeatures.cancel()"${busy ? ' disabled' : ''}>Cancel</button>
        ${d.id ? `<button type="button" class="pill mn-sf-del" id="mn-sf-delete" onclick="SiteFeatures.remove()"${busy ? ' disabled' : ''}>🗑 Delete</button>` : ''}
      </div>`;
  }

  function msgHtml() {
    const m = session.msg;
    const cls = !m ? '' : m.kind === 'error' || m.kind === 'conflict' ? ' txt-bad' : m.kind === 'ok' ? ' txt-ok' : '';
    return `<p class="small mn-sf-msg${cls}" id="mn-sf-msg" role="status">${m ? esc(m.text) : ''}${m && m.kind === 'conflict'
      ? ' <button type="button" class="link-btn" id="mn-sf-reload" onclick="SiteFeatures.reload()">Reload</button>' : ''}</p>`;
  }

  function panelHtml() {
    const s = sessionStation();
    const d = session.draft;
    const head = `
      <div class="mn-sf-head">
        <span class="mn-sf-title"><strong>📌 Site features</strong><span class="mn-sf-name">${esc((s && s.name) || session.stationId)}</span></span>
        <button type="button" class="mn-sf-icon" id="mn-sf-fold" aria-expanded="${!session.folded}"
                aria-label="${session.folded ? 'Open the panel' : 'Fold the panel to see the map'}"
                title="${session.folded ? 'Open the panel' : 'Fold the panel to see the map'}"
                onclick="SiteFeatures.fold()"><span aria-hidden="true">${session.folded ? '▴' : '▾'}</span></button>
        <button type="button" class="mn-sf-icon" id="mn-sf-close" aria-label="Close site features"
                title="Close site features (Esc)" onclick="SiteFeatures.stop()"><span aria-hidden="true">×</span></button>
      </div>`;
    if (session.folded) {
      const k = d && kindOf(d.kind);
      const what = d ? `<p class="small mn-sf-doing">${kindIcon(k)} ${d.id ? 'Editing' : 'New'} ${esc(k.label.toLowerCase())}${
        isLineKind(d.kind) ? ` · ${d.pts.length} point${d.pts.length === 1 ? '' : 's'}` : d.pts.length ? '' : ' · not placed yet'}</p>` : '';
      return `${head}${what}${d ? `<div class="pill-row mn-sf-actions">
          ${d.drawing ? `<button type="button" class="pill is-on" id="mn-sf-finish" onclick="SiteFeatures.finish()"${d.pts.length < 2 ? ' disabled' : ''}>✓ Finish</button>` : ''}
          <button type="button" class="pill is-on" id="mn-sf-save" onclick="SiteFeatures.save()"${session.busy ? ' disabled' : ''}>${session.busy ? 'Saving…' : 'Save'}</button>
          <button type="button" class="pill" id="mn-sf-cancel" onclick="SiteFeatures.cancel()"${session.busy ? ' disabled' : ''}>Cancel</button>
        </div>` : ''}${msgHtml()}`;
    }
    return `${head}${d ? draftHtml(d) : listHtml(s)}${msgHtml()}`;
  }

  // The whole panel again, with focus put back on the control that had it.
  // Every control a repaint can be pressed from has an id, for this.
  function repaintPanel() {
    const el = panel && panel.getContainer();
    if (!el || !session) return;
    const f = document.activeElement;
    const focusId = f && el.contains(f) && f.id ? f.id : null;
    const top = el.scrollTop;
    el.innerHTML = panelHtml();
    el.scrollTop = top;
    if (!focusId) return;
    const back = document.getElementById(focusId);
    if (back && !back.disabled) { back.focus({ preventScroll: true }); return; }
    // The control is gone — Save, once it has saved — so the panel itself
    // holds focus rather than <body> (#138's rule).
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
  }

  // The numbers only — redrawn on every point and every move of a drag, so
  // nothing being typed in is touched: a box with the caret in it keeps what
  // is in it.
  function repaintReadout() {
    const el = panel && panel.getContainer();
    const d = session && session.draft;
    if (!el || !d) return;
    // Folded, the panel is a line and three buttons: drawn again whole.
    if (session.folded) { repaintPanel(); return; }
    const read = el.querySelector('#mn-sf-read');
    if (read) read.innerHTML = readoutHtml(d);
    const hint = el.querySelector('#mn-sf-hint');
    if (hint) hint.textContent = hintFor(d);
    const active = document.activeElement;
    const put = (id, v) => { const b = el.querySelector(`#${id}`); if (b && b !== active) b.value = v; };
    if (isLineKind(d.kind)) {
      put('mn-sf-ptstext', ptsText(d.pts));
      const fin = el.querySelector('#mn-sf-finish');
      if (fin) fin.disabled = d.pts.length < 2;
      const und = el.querySelector('#mn-sf-undo');
      if (und) und.disabled = !d.pts.length;
    } else {
      const p = d.pts[0];
      put('mn-sf-lat', p ? p[0].toFixed(DP) : '');
      put('mn-sf-lon', p ? p[1].toFixed(DP) : '');
    }
  }

  // ── GeoJSON ────────────────────────────────────────────────────────────────
  // The station's features as a file QGIS and Google Earth open, the station's
  // own pin with them for context. Who changed what stays in the database: a
  // file goes where it is sent.
  function download() {
    if (!session) return;
    const s = sessionStation();
    const rows = sorted(features());
    if (!rows.length) return;
    const fc = {
      type: 'FeatureCollection',
      features: [
        ...(hasPin(s) ? [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [+s.lon, +s.lat] },
          properties: { kind: 'station', kind_label: 'Station', name: s.name || s.id, station_id: s.id,
                        station_number: s.station_number || null },
        }] : []),
        ...rows.map(f => ({
          type: 'Feature',
          id: f.id,
          geometry: f.geom,
          properties: {
            kind: f.kind, kind_label: kindOf(f.kind).label, name: f.name || null, note: f.note || null,
            placed: f.placed || 'map', accuracy_m: f.accuracy_m == null || f.accuracy_m === '' ? null : +f.accuracy_m,
            station_id: f.station_id, station_name: s ? s.name : null, updated_at: f.updated_at || null,
          },
        })),
      ],
    };
    const name = `site-features-${slug((s && s.name) || session.stationId) || 'station'}.geojson`;
    dlText(name, JSON.stringify(fc, null, 2), 'application/geo+json');
    announce(`Downloaded ${rows.length} site feature${rows.length === 1 ? '' : 's'} as GeoJSON.`);
  }

  // ── The legend ─────────────────────────────────────────────────────────────

  function legendHtml() {
    if (!drawnKinds.length) return '';
    return `
    <span class="legend-item legend-sf">
      <span class="small">Site features — ${drawnKinds.map(key => {
        const k = kindOf(key);
        return `<span class="legend-sf-kind">${kindIcon(k, 14)} ${esc(k.label)}</span>`;
      }).join(' ')}</span>
    </span>`;
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      if (!m.getPane(EDIT_PANE)) m.createPane(EDIT_PANE).style.zIndex = EDIT_Z;
      m.on('moveend', sync);
      m.on('click', onBareClick);
      // The mode, back on the map that was rebuilt under it — unless what it
      // was for has gone meanwhile.
      if (session) {
        if (!stationById(session.stationId) || !signedIn()) session = null;
        else arm();
      }
      sync();
    },

    // The map is being torn down: everything this put on it goes, and the
    // mode's station and draft are kept for the map that replaces it.
    detach() {
      clearTimeout(timer);
      if (map) {
        map.off('moveend', sync);
        map.off('click', onBareClick);
      }
      disarm();
      clearLayer();
      map = null;
      seq++;
    },

    // Signed in or out: what was read was read for the other session.
    authChanged() {
      cache = {};
      kinds = null;
      kindsTried = false;
      notReady = false;
      highlight = null;
      if (!signedIn() && session) end();
      if (map) sync();
    },

    refresh() { if (map) sync(); },
    active() { return !!(layer && drawnKinds.length); },

    // A station's access tracks (0067), latitude first, for Route on map
    // (map-drive.js), which drives to where one begins and draws it from
    // there. Read as the card reads them — the same cache, the same two
    // minutes — and resolving, never rejecting: { rows: [{ id, name, pts }],
    // error }. Signed out, no rows and nothing asked.
    accessTracks(id) {
      return load([id]).then(() => {
        const c = cache[id];
        const rows = ((c && c.rows) || []).filter(r => r.kind === 'access_track')
          .map(r => ({ id: r.id, name: r.name || '', pts: ptsOf(r) }))
          .filter(r => r.pts.length >= 2);
        return { rows, error: (c && c.error) || '' };
      });
    },
    noteHtml,
    legendHtml,

    // For the ⛰️ view (map-3d.js), which draws these again on the terrain:
    // each feature drawn on the 2-D map — latitude first, as Leaflet has it —
    // with its kind's colour and dash, whether it is the one picked, and the
    // words its tooltip says. A copy: nothing done to it reaches the map.
    drawn: () => shown.map(d => ({ ...d, pts: d.pts.map(p => p.slice()) })),
    LOOK, MIN_ZOOM,
    // A point kind's glyph, the 2-D marker's own markup, for the 3-D view to
    // make its image from.
    glyphSvg: (kind, size) => glyphSvg(kindOf(kind), size),
    // What a click on a feature says, wherever it is clicked: the 2-D popup's
    // own markup, or '' for a feature no longer in hand.
    popupHtml(stationId, id) {
      const c = cache[stationId];
      const f = c && c.rows && c.rows.find(r => r.id === id);
      return f ? popupHtml(f) : '';
    },

    // On by default and remembered — it costs nothing signed out, and one small
    // query a settled view from zoom 16 signed in.
    setEnabled(on) {
      state.mapSiteFeatures = !!on;
      try { localStorage.setItem('mn-site-features', on ? 'on' : 'off'); } catch (_) { /* this session only */ }
      if (!on && !session && !highlight) { clearTimeout(timer); clearLayer(); setNote('off'); }
      sync();
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    },

    cardHtml, cardAsk, pillHtml, editorButtonHtml, show,
    start, stop, armed,
    // Whether stopping now would throw away a draft (map-move-pin.js asks).
    dirty,
    add, edit, select, cancel, save, remove, reload, finish, undo, continueLine, gps, typed, applyPts,
    setKind, setField, ptsToggle, fold, download,
    dropPoint(i) { dropPoint(i); },

    // Read by the check and by nothing else.
    _session: () => (session ? JSON.parse(JSON.stringify(session)) : null),
    _cache: () => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, { rows: v.rows, error: v.error }])))),
    _note: () => ({ ...note }),
    _geo: { metres, lengthM, parsePts, placedOf, accOf, geomOf, ptsOf },
  };
})();
if (typeof window !== 'undefined') window.SiteFeatures = SiteFeatures;
