// MegaNet — map-photos.js
//
//   MapPhotos   the field photos on the Stations map: a 📷 pin where each was
//               taken, with a cone the way the camera faced, and the carousel
//               of what was taken there on a click.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state` and esc; across to field-photos.js for
// FieldPhotos (the photos, the spots they fall into, and the viewer), to
// app.js for rerenderMapLegend, and to map-3d.js for Map3D, which draws these
// pins again on the terrain and is told when they change (photosChanged). All
// of it from inside its own functions, so this file's position among the
// modules is free.
//
// ── Why the map as well as the twin ──────────────────────────────────────────
// The twin is one station's patch — 200 m to 1.6 km — and a photo taken
// between two stations, along a reach, at a crossing or on the road in, is in
// nobody's patch. The map is where every photo has a place to be. From zoom 17
// with a station under the view the map hands its rectangle to that station's
// twin (map-twin.js), and the photos go on as markers there; this layer is
// everything short of that.
//
// ── How much it asks for ─────────────────────────────────────────────────────
// Nothing below zoom 12 (a view ~40 km across): a network's worth of photos is
// thousands of pins and the answer at that scale is "there are photos here",
// which the Field Photos tab says better. From 12, the photos inside the view
// and a margin round it, once per settled pan (FieldPhotos.inBox caches a box
// for a minute, so panning back and forth is not a stream of requests), drawn
// as one pin per spot — the photos within a few metres of each other — and
// pins that would overlap on screen merged into one with the total on it.
// Only for a signed-in session: the photos, and where they were taken, are
// editors-only (0035).
//
// ── The pin ──────────────────────────────────────────────────────────────────
// A dot on the exact point and a badge standing up off it, so a photo taken
// beside a station does not hide under the station's pin or hide it. A cone
// for every way the cameras faced from there — two photos taken a few seconds
// apart, up the reach and down it, are one pin with two cones — up to six.
//
// ── In 3-D (#200) ────────────────────────────────────────────────────────────
// The tilted map draws these same pins and asks for nothing itself: drawn()
// is what this file put on the map, after the query, FieldPhotos.spots() and
// the merge, and map-3d.js stands that on the terrain — #186's rule, that the
// first thing to work its own answer out is the first place the two modes can
// disagree. So the three reasons for no pins (signed out, zoomed out, switched
// off) are this file's in both modes, and so is the note that says which: the
// 2-D map under the canvas follows the camera, so its zoom is the camera's.
const MapPhotos = (function () {
  // Its own pane, over the network's canvas (the overlay pane, 400) and the
  // arrows (405), under the station pins (markerPane, 600). Over the canvas
  // because a full-map <canvas> takes every click that lands on it: at 352,
  // among the other context points, a pin could be seen and never pressed —
  // map-sites.js learnt the same about its candidates. Under the pins because
  // a photo taken beside a station must never cover the station.
  const PANE   = 'mnPhotos';
  const PANE_Z = 420;
  const MIN_ZOOM    = 12;
  const DEBOUNCE_MS = 250;
  const MERGE_PX    = 30;      // pins closer than this on screen are one
  const PAD         = 0.2;     // fraction of the view fetched beyond each edge
  const CONE_DEG    = 12;      // headings closer than this are one cone

  let map = null, layer = null, timer = null, seq = 0;
  let drawn = [];              // [{ lat, lon, ids, n, cones, title }]
  let note = { kind: 'off', n: 0, spots: 0, error: '' };

  function signedIn() { return typeof FieldPhotos !== 'undefined' && FieldPhotos.signedIn(); }
  // `isFinite(null)` is true; a photo with no heading has no cone, not a north one.
  function known(v) { return v !== null && v !== undefined && v !== '' && isFinite(v); }

  // Whatever is drawn changed, so the 3-D view draws it again. Asked for by
  // `typeof` because map-3d.js loads after this file; two early returns there
  // while 3-D is shut, which is almost always.
  function tell3d() {
    if (typeof Map3D !== 'undefined' && Map3D.photosChanged) Map3D.photosChanged();
  }

  function clear() {
    if (layer) { layer.remove(); layer = null; }
    const had = drawn.length > 0;
    drawn = [];
    if (had) tell3d();
  }

  function setNote(kind, extra = {}) {
    note = Object.assign({ kind, n: 0, spots: 0, error: '' }, extra);
    const el = document.getElementById('map-photos-note');
    if (el) el.innerHTML = noteHtml();
  }

  // Spots that would overlap on screen at this zoom, merged — greedily, in
  // the order the spots came, which is time order and so stable as more
  // photos arrive.
  function merge(spots) {
    const out = [];
    for (const sp of spots) {
      const p = map.latLngToLayerPoint([sp.lat, sp.lon]);
      let g = out.find(o => Math.hypot(o.p.x - p.x, o.p.y - p.y) <= MERGE_PX);
      if (!g) { g = { p, lat: sp.lat, lon: sp.lon, ids: [], headings: [] }; out.push(g); }
      g.ids.push(...sp.ids);
      for (const r of sp.rows) if (known(r.heading_deg)) g.headings.push(+r.heading_deg);
    }
    for (const g of out) {
      g.n = g.ids.length;
      // Every way the cameras faced, each once to within CONE_DEG, and no more
      // than six — past that a pin is a spot photographed all round, and six
      // cones already say so.
      g.cones = [];
      for (const h of g.headings) {
        if (g.cones.some(c => Math.abs(((c - h + 540) % 360) - 180) < CONE_DEG)) continue;
        if (g.cones.length < 6) g.cones.push(h);
      }
    }
    return out;
  }

  // The pin's markup, in its parts: a cone per heading, the dot on the point
  // and the badge with the count. One pin here; the 3-D view lays the cones on
  // the ground, puts the dot under the station pins and stands the badge up
  // (map-3d.js says why they are apart there), and they are these same parts.
  //
  // Each cone's turn is a custom property rather than an inline transform —
  // the design system's rule (#109): a token reaching the element, not a
  // decision no stylesheet can see.
  const CONE_PATH = 'M0 0 L-9 -18 A20 20 0 0 1 9 -18 Z';
  const DOT_HTML  = '<i class="mn-photo-dot" aria-hidden="true"></i>';
  function coneHtml(h) {
    return `<svg class="mn-photo-cone" style="--rot:${h.toFixed(1)}deg" viewBox="-20 -20 40 40" aria-hidden="true"><path d="${CONE_PATH}"/></svg>`;
  }
  function badgeHtml(g) {
    return `<span class="mn-photo-badge"><span aria-hidden="true">📷</span><b>${g.n}</b></span>`;
  }

  function icon(g) {
    return L.divIcon({
      className: 'mn-photo-icon',
      html: `<span class="mn-photo-pin">${g.cones.map(coneHtml).join('')}${DOT_HTML}${badgeHtml(g)}</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  function titleOf(g) {
    const facing = g.cones.length ? `, facing ${g.cones.map(h => `${Math.round(h)}°`).join(' and ')}` : '';
    return `${g.n} field photo${g.n === 1 ? '' : 's'} taken here${facing} — open ${g.n === 1 ? 'it' : 'them'}`;
  }

  // What pressing a pin does, in either mode: the carousel over the photos
  // taken there, in the viewer's compass order (FieldPhotos.openSpot), from
  // the first.
  function open(g) {
    if (typeof FieldPhotos === 'undefined' || !g || !g.ids || !g.ids.length) return;
    FieldPhotos.openSpot(g.ids, null, `${g.n} photo${g.n === 1 ? '' : 's'} taken here`);
  }

  function draw(groups) {
    if (layer) layer.remove();
    layer = L.layerGroup([], { pane: PANE });
    for (const g of groups) {
      L.marker([g.lat, g.lon], { icon: icon(g), pane: PANE, keyboard: true, riseOnHover: true,
                                 title: titleOf(g), alt: titleOf(g), bubblingMouseEvents: false })
        .on('click', () => open(g))
        .addTo(layer);
    }
    layer.addTo(map);
    drawn = groups.map(g => ({ lat: g.lat, lon: g.lon, ids: g.ids.slice(), n: g.n, cones: g.cones.slice(),
                               title: titleOf(g) }));
    tell3d();
  }

  function run() {
    if (!map) return;
    if (!state.mapPhotos) { clear(); setNote('off'); return; }
    if (!signedIn()) { clear(); setNote('signed-out'); return; }
    if (map.getZoom() < MIN_ZOOM) { clear(); setNote('zoom'); return; }
    const b = map.getBounds().pad(PAD);
    const mine = ++seq;
    if (!drawn.length) setNote('loading');
    FieldPhotos.inBox({ south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() }, { limit: 1000 })
      .then(rows => {
        if (mine !== seq || !map || !state.mapPhotos) return;
        const spots = FieldPhotos.spots(rows);
        const groups = merge(spots);
        draw(groups);
        setNote('ok', { n: rows.filter(r => known(r.lat)).length, spots: spots.length, capped: rows.length >= 1000 });
        if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
      })
      .catch(err => {
        if (mine !== seq || !map) return;
        clear();
        const msg = (err && err.message) || String(err);
        setNote('fail', { error: /field_photo/.test(msg) && /(does not exist|schema cache|not find)/i.test(msg)
          ? 'this database has no field photos table yet (0035 is not applied)' : msg });
      });
  }

  function sync() {
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  }

  function noteHtml() {
    switch (note.kind) {
      case 'off':
        return 'A 📷 where each field photo was taken, with a cone the way the camera faced. Click one for the photos.';
      case 'signed-out':
        return 'Field photos are for signed-in editors — sign in to see where they were taken.';
      case 'zoom':
        return `Zoom in (to level ${MIN_ZOOM} or closer) to see where field photos were taken.`;
      case 'loading':
        return 'Looking for field photos in view…';
      case 'fail':
        return `<span class="txt-bad">No field photos — ${esc(note.error)}</span>`;
      case 'ok':
        return note.n
          ? `${note.n}${note.capped ? '+' : ''} field photo${note.n === 1 ? '' : 's'} in and around this view, at ${note.spots} spot${note.spots === 1 ? '' : 's'}. Click a 📷 for the photos taken there.`
          : 'No field photos have been taken in and around this view.';
      default:
        return '';
    }
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      m.on('moveend', sync);
      sync();
    },

    detach() {
      clearTimeout(timer);
      if (map) map.off('moveend', sync);
      clear();
      map = null;
      seq++;
    },

    // Something changed (an upload, a move, a removal, a sign-in): draw again.
    refresh() { if (map) sync(); },

    active() { return !!(layer && drawn.length); },

    noteHtml,

    // On by default and remembered — it costs nothing signed out, and one
    // small query a settled view from zoom 12 signed in.
    setEnabled(on) {
      state.mapPhotos = !!on;
      try { localStorage.setItem('mn-field-photos', on ? 'on' : 'off'); } catch (_) { /* this session only */ }
      if (!on) { clearTimeout(timer); clear(); setNote('off'); }
      else sync();
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    },

    // What is drawn: a pin each, after the merge — where it stands, the
    // photos it opens, how many, each way the cameras faced from there (at
    // most six, to CONE_DEG), and its name. Copies, so nothing reading them
    // can move a pin. Empty whenever there are no pins: signed out, below
    // MIN_ZOOM, switched off, a query that failed.
    //
    // The 3-D view's source for the photos (#200) — and deliberately its only
    // one: it reads these rather than asking FieldPhotos for the rows again or
    // grouping them itself, so there is one query, one grouping rule
    // (FieldPhotos.spots) and one merge, and the tilted map shows what this
    // file decided. photosChanged() tells it when to read them again.
    drawn: () => drawn.map(d => ({ ...d, ids: d.ids.slice(), cones: d.cones.slice() })),
    // The parts of a pin the 3-D view draws the same pin from: the badge, and
    // the cone's outline (a path in the SVG's 40-unit box, the point at its
    // middle, opening north).
    badgeHtml,
    conePath: CONE_PATH,
    open,
    // Read by the check and by nothing else.
    _note: () => ({ ...note }),
  };
})();
if (typeof window !== 'undefined') window.MapPhotos = MapPhotos;
