// MegaNet — map-drive.js
//
//   MapDrive   🛣️ Route on map (#251 of #250): a drive to a station, drawn on
//              the Stations map — by road from where the trip starts to where
//              the station's access track begins, then along the track to the
//              gauge — with the distance, the time and the turns. Signed-in
//              editors only, for now (the owner, 2026-10-28).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, pillText, pillLong, announce,
// fmtKm, termHtml, kmPerDegLon, KM_PER_DEG_LAT and directionsPillHtml; across
// to app.js for repaintStnCard and closeStnCard; to map-twin.js and map-3d.js,
// which it leaves for the flat map the route is drawn on; to auth.js for Auth (who is signed
// in, and the session the Worker is asked with); to site-features.js for
// SiteFeatures.accessTracks and SITE_FEATURE_KINDS (the track's colour); to
// places.js for Places.parse and Places.find, which read a typed start; to
// station-editor.js for editorBoxesLatLon, the editor card's own coordinate;
// and to map-draw.js, link-budget.js, map-here.js and map-move-pin.js, to take
// the map's other click-takers off before a start is picked on it. All of it
// from inside its own functions, so this file's position among the modules is
// free: the IIFE body declares nothing but constants and nulls.
//
// ── Why, beside 🚗 Directions ────────────────────────────────────────────────
// Directions (#225) hands the station's coordinate to Apple or Google Maps,
// which is where voice guidance, re-routing and offline maps live, and it
// stays. What neither app knows is the last stretch: the GPS track somebody
// drove through the property to the gauge (0067). And neither can be drawn
// here — Google only lets its routes be shown on a Google Map. So the road
// comes from OpenStreetMap through the Worker (worker/drive.js, /api/drive,
// Valhalla on FOSSGIS's server), and the track from Flood-Net's own database;
// the two are drawn together, with the station's other layers under them.
//
// ── Where the drive starts ───────────────────────────────────────────────────
// The owner's rule, in order:
//
//   1. The phone's position, if it has one when the route is asked for — a
//      fix asked for then, on a phone or a tablet, within GPS_TIMEOUT_MS and
//      no coarser than GPS_WORST_M. A desk's browser is not asked: what it
//      would say is the office network's guess, not where anybody is driving
//      from, and asking would put a permission prompt in front of the route.
//   2. Pritchard Road, Virginia — the Brisbane depot — for a station on the
//      Brisbane hub (its `hub_id`).
//   3. Otherwise, ask: the panel offers where you are, Pritchard Road, a click
//      on the map, the start used last, or a place, a station or a coordinate
//      typed in.
//
// Whatever it starts from, Change on the panel asks again, and the start chosen
// is remembered for the session as the last one used, never as the default.
//
// ── The last stretch ─────────────────────────────────────────────────────────
// A station with a mapped access track is driven to where the track starts, and
// the track is drawn from there: of a track's two ends, the one nearer the pin
// is the station's and the other is the road's. Where a station has several,
// the one whose road end is nearest the start is taken — a track recorded from
// the other side of the property is no use to somebody coming this way. The
// track never leaves the browser: only its road end goes to the Worker, as a
// coordinate.
//
// Where nothing mapped reaches — the road stops at a gate, the track stops
// short of the pin, a pin with no track at all — the rest is a dotted straight
// line, and the panel says how long. It is not a way in; it is the part
// nobody has mapped.
//
// ── On the map ───────────────────────────────────────────────────────────────
// Its own pane, under the links and the pins and over every context layer
// (rivers 340, survey marks 345), taking no pointer: a route laid over a
// network map is something to read the network through, not something to
// click. The road a blue line in a dark casing; the track the access track's
// own green, as site-features.js draws it; the unmapped stretches dotted white;
// the start a ringed dot. The panel is a Leaflet control bottom left, as Move
// pin's is — the two can be up at once, one over the other.
//
// The station card gives way to it, as it does to Move pin and Site features:
// on a desk the card stands over the left of the map, where the panel is and
// where the route would be fitted, and on a phone it is a sheet over both. A
// card opened again while the route is up — another station looked at — folds
// the panel to its title and the one line of the drive, and closing the card
// unfolds it; ▾ folds and unfolds it by hand.
//
// The route outlives the map being rebuilt under it (a render of the tab, a
// visit to another one): detach() takes the drawing off, attach() puts it back.
// Signing out takes it away — it was asked for an editor.
const MapDrive = (function () {
  const ROUTE = '/api/drive';
  const PANE = 'mnDrive';
  const PANE_Z = 395;                 // over rivers (340) and survey marks (345), under the links (400)
  // Pritchard Road, Virginia: the middle of the road.
  const DEPOT = Object.freeze({ lat: -27.37429, lon: 153.06059, label: 'Pritchard Road, Virginia' });
  const DEPOT_HUB = 'brisbane';
  const GPS_TIMEOUT_MS = 12000;
  const GPS_MAX_AGE_MS = 2 * 60 * 1000;
  const GPS_WORST_M = 2000;           // coarser than this is not "where you are"
  const GAP_M = 30;                   // closer than this, an end is on the road
  const ROAD = '#448aff', ROAD_CASING = '#0d2c6b';
  const TRACK_CASING = '#1b2b10';
  const GAP = '#ffffff', GAP_CASING = '#263238';
  const DP = 5;

  let map = null;
  let layer = null;
  let renderer = null;        // the pane's one canvas, made on the first draw
  // Each line drawn, latitude first, for the check and the 3-D view to come:
  // { kind: 'road' | 'track' | 'gap', pts }.
  let drawn = [];
  let panel = null;
  let picking = false;
  let pickDown = null;        // where the pointer went down while picking, [x, y]
  let keyHandler = null;
  let cardWatch = null;       // the station card coming and going (see the header)
  let autoFolded = false;     // the panel folded for the card, not by hand
  let seq = 0;
  let last = null;            // the start chosen last, this session: { lat, lon, label, how }
  // job: { stationId, live, name, dest, start, status, error, note, tracks,
  //        track, to, route, folded }
  //   status: starting | locating | choose | routing | ok | error
  //   note:   why the start is what it is, when that needs saying — the
  //           device would not say where it is, a typed place was not found
  let job = null;

  // ── Words ──────────────────────────────────────────────────────────────────
  // The words the panel uses in its own sense, in one list: the marked terms
  // read their meaning from here, and so does the fold that lists them for a
  // finger or a keyboard, which never hover.
  const WORDS = [
    ['from', 'From', 'Where the drive starts. By default the phone’s position, if it gave one when the route was asked for; otherwise Pritchard Road, Virginia for a station on the Brisbane hub; otherwise wherever you chose. Change picks another.'],
    ['road', 'By road', 'The drive on the roads OpenStreetMap knows, worked out by the Valhalla router: its length, and the time at those roads’ usual speeds — with no traffic, roadworks, closures or floods taken into account.'],
    ['track', 'Access track', 'The way in to the site as somebody drove it and recorded it with a GPS, from the station’s mapped access tracks — drawn from where the road route meets it to the station. Gates, locks and wet weather are not on it.'],
    ['gap', 'Not mapped', 'A stretch with no road or track on the map, drawn as a dotted straight line: from where the road route ends to the track or the station. The real way in may be longer — a gate, a paddock, a walk.'],
  ];
  const word = k => (WORDS.find(w => w[0] === k) || [])[2] || '';
  const term = (k, text) => termHtml(text || (WORDS.find(w => w[0] === k) || [])[1] || k, word(k));

  // ── Who, and where ─────────────────────────────────────────────────────────

  function editor() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn() && Auth.mayWrite();
  }

  function stationById(id) {
    return ((state.data && state.data.stations) || []).find(s => s.id === id) || null;
  }

  function pinOf(s) {
    return s && s.lat != null && s.lon != null && isFinite(+s.lat) && isFinite(+s.lon) ? [+s.lat, +s.lon] : null;
  }

  // Where the drive ends: the station's pin, or — from the editor card — its
  // coordinate boxes as they are now, for Directions' reason (core.js,
  // directionsPillHtml): a route drawn to the saved pin beside boxes somebody
  // has just typed over would send a crew to where the station was.
  function destOf(s, live) {
    if (live && typeof editorBoxesLatLon === 'function') {
      const b = editorBoxesLatLon();
      if (b && b.lat != null && b.lon != null && isFinite(b.lat) && isFinite(b.lon)) return [b.lat, b.lon];
    }
    return pinOf(s);
  }

  // A phone or a tablet — a device somebody drives with. MapLocate's test.
  function handheld() {
    return (typeof L !== 'undefined' && L.Browser && L.Browser.mobile)
      || (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  // The device's position: { lat, lon, acc } or { error }. Never rejects.
  function locate() {
    return new Promise(resolve => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        resolve({ error: 'This device does not offer its position.' });
        return;
      }
      let done = false;
      const finish = v => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
      const t = setTimeout(() => finish({ error: 'This device did not say where it is in time.' }), GPS_TIMEOUT_MS + 1000);
      navigator.geolocation.getCurrentPosition(p => {
        const acc = p.coords.accuracy;
        if (acc != null && acc > GPS_WORST_M) {
          finish({ error: `This device only knows where it is to within ${fmtKm(acc / 1000)}.` });
          return;
        }
        finish({ lat: round(p.coords.latitude), lon: round(p.coords.longitude), acc });
      }, e => finish({ error: e && e.code === 1 ? 'This device was not allowed to say where it is.'
                                                : 'This device could not say where it is.' }),
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: GPS_MAX_AGE_MS });
    });
  }

  const round = n => Number(Number(n).toFixed(DP));

  // The owner's rule, the part that needs no device: the depot for a Brisbane
  // station, or null — ask.
  function fallbackStart(s) {
    return s && s.hub_id === DEPOT_HUB ? { lat: DEPOT.lat, lon: DEPOT.lon, label: DEPOT.label, how: 'depot' } : null;
  }

  // ── The last stretch ───────────────────────────────────────────────────────

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

  // The track to drive to, turned to run from the road to the station:
  // { id, pts, lengthM } or null. `from` is the start, [lat, lon].
  function pickTrack(tracks, dest, from) {
    let best = null;
    for (const t of tracks || []) {
      if (!t || !Array.isArray(t.pts) || t.pts.length < 2) continue;
      const a = t.pts[0], b = t.pts[t.pts.length - 1];
      const pts = metres(a, dest) <= metres(b, dest) ? t.pts.slice().reverse() : t.pts.slice();
      const d = metres(from, pts[0]);
      if (!best || d < best.d) best = { id: t.id, pts, d };
    }
    return best ? { id: best.id, pts: best.pts, lengthM: lengthM(best.pts) } : null;
  }

  // ── Asking the Worker ──────────────────────────────────────────────────────

  async function fetchRoute(from, to) {
    const t = typeof Auth !== 'undefined' && Auth.accessToken ? Auth.accessToken() : null;
    const q = `from=${from[0].toFixed(DP)},${from[1].toFixed(DP)}&to=${to[0].toFixed(DP)},${to[1].toFixed(DP)}`;
    let res;
    try {
      res = await fetch(`${ROUTE}?${q}`, { headers: t ? { Authorization: `Bearer ${t}` } : {},
                                            cache: 'no-store', credentials: 'same-origin' });
    } catch (_) {
      throw new Error('The route service could not be reached — is there a signal?');
    }
    const body = await res.json().catch(() => null);
    if (res.ok && body && Array.isArray(body.shape) && body.shape.length >= 2) return body;
    // No Worker in front of this copy of the app (github.io, a checkout): the
    // static server's own 404, with no JSON of the route's.
    if (res.status === 404 && !(body && body.error)) {
      throw new Error('This copy of Flood-Net has no route service. Routes are on floodwarning.net.');
    }
    throw new Error((body && body.error) || `The route service answered HTTP ${res.status}.`);
  }

  // ── The job ────────────────────────────────────────────────────────────────

  // Pressed on a station card or the editor card. Again for a station already
  // routed, it brings the route back into view.
  async function open(id, { live = false } = {}) {
    const s = stationById(id);
    if (!s) return;
    if (!editor()) { if (typeof Auth !== 'undefined' && Auth.open) Auth.open(); return; }
    const dest = destOf(s, live);
    if (!dest) { announce(`${s.name || id} has no position to drive to.`); return; }
    if (!map) { announce('Routes are drawn on the Stations map — open it first.'); return; }
    if (job && job.stationId === id && job.status === 'ok' && sameAt(job.dest, dest)) {
      if (typeof closeStnCard === 'function') closeStnCard(false);
      job.folded = false;
      autoFolded = false;
      addPanel();
      repaint();
      draw();
      fit();
      return;
    }
    stopPicking();
    const my = ++seq;
    job = { stationId: id, live, name: s.name || id, dest, start: null, status: handheld() ? 'locating' : 'starting',
            error: '', note: '', tracks: null, track: null, to: null, route: null, folded: false };
    autoFolded = false;
    // Drawn on the flat map: a twin up over it is put away, and ⛰️ 3-D left —
    // site-features.js's reasons — and the card gives way (the header).
    if (typeof MapTwin !== 'undefined' && MapTwin.active && MapTwin.active()) MapTwin.leave();
    if (typeof Map3D !== 'undefined' && Map3D.active && Map3D.active() && Map3D.stop) Map3D.stop();
    if (typeof closeStnCard === 'function') closeStnCard(false);
    map.closePopup();
    addPanel();
    draw();
    repaintCards();
    // The pill that was pressed went with the card: focus comes to the panel
    // rather than falling to the page (#138's rule).
    const a = document.activeElement;
    if (!a || a === document.body || !a.isConnected || a.closest('[hidden]')) {
      const first = panel && panel.getContainer().querySelector('button');
      if (first) first.focus({ preventScroll: true });
    }
    // The tracks are asked for while the device is: neither waits on the other.
    const tracksP = typeof SiteFeatures !== 'undefined' && SiteFeatures.accessTracks
      ? SiteFeatures.accessTracks(id) : Promise.resolve({ rows: [], error: '' });
    tracksP.then(t => { if (job && job.stationId === id && job.tracks == null) job.tracks = t.rows || []; });
    let start = null, why = '';
    if (handheld()) {
      const fix = await locate();
      if (!job || seq !== my) return;
      if (!fix.error) start = { lat: fix.lat, lon: fix.lon, label: 'Where you are', how: 'gps', acc: fix.acc };
      else why = fix.error;
    }
    if (!start) start = fallbackStart(s);
    await tracksP;
    if (!job || seq !== my) return;
    if (!start) {
      job.status = 'choose';
      job.note = why;
      repaint();
      announce(`Where does the drive to ${job.name} start? Choose on the map’s panel.`);
      return;
    }
    route(start, why);
  }

  function sameAt(a, b) {
    return !!a && !!b && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  }

  // The start chosen: the road from it, then the track. `note` is why it is
  // this start, when the default rule fell through to it.
  async function route(start, note = '') {
    if (!job) return;
    const my = ++seq;
    stopPicking();
    job.note = note;
    job.start = { lat: round(start.lat), lon: round(start.lon), label: start.label, how: start.how, acc: start.acc };
    if (start.how !== 'gps' && start.how !== 'depot') last = { ...job.start };
    const from = [job.start.lat, job.start.lon];
    job.track = pickTrack(job.tracks, job.dest, from);
    job.to = job.track ? job.track.pts[0] : job.dest;
    job.status = 'routing';
    job.route = null;
    job.error = '';
    repaint();
    draw();
    try {
      const r = await fetchRoute(from, job.to);
      if (!job || seq !== my) return;
      job.route = r;
      job.status = 'ok';
      repaint();
      draw();
      fit();
      repaintCards();
      announce(`Route to ${job.name}: ${summaryText()}.`);
    } catch (err) {
      if (!job || seq !== my) return;
      job.status = 'error';
      job.error = (err && err.message) || String(err);
      repaint();
      draw();
      announce(`No route to ${job.name}: ${job.error}`);
    }
  }

  function clear() {
    seq++;
    stopPicking();
    job = null;
    autoFolded = false;
    clearLayer();
    removePanel();
    repaintCards();
  }

  // ── Choosing the start ─────────────────────────────────────────────────────

  function choose() {
    if (!job) return;
    seq++;
    stopPicking();
    job.status = 'choose';
    job.error = '';
    repaint();
  }

  async function useGps() {
    if (!job) return;
    const my = ++seq;
    job.status = 'locating';
    job.note = '';
    repaint();
    const fix = await locate();
    if (!job || seq !== my) return;
    if (fix.error) {
      job.status = 'choose';
      job.note = fix.error;
      repaint();
      announce(fix.error);
      return;
    }
    route({ lat: fix.lat, lon: fix.lon, label: 'Where you are', how: 'gps', acc: fix.acc });
  }

  function useDepot() {
    route({ lat: DEPOT.lat, lon: DEPOT.lon, label: DEPOT.label, how: 'depot' });
  }

  function useLast() {
    if (last) route(last);
  }

  // The map's other click-takers off, as site-features.js's takeMap() does on
  // its way in: a draw tool, the link budget's pick, What is here and a pin
  // being moved all answer the same click.
  function takeMap() {
    if (state.draw && state.draw.tool && typeof MapDraw !== 'undefined') MapDraw.setTool('');
    if (typeof LinkBudget !== 'undefined' && LinkBudget.setPicking && state.link && state.link.picking) LinkBudget.setPicking(false);
    if (typeof MapHere !== 'undefined' && MapHere.armed && MapHere.armed()) MapHere.arm(false);
    if (typeof MapMovePin !== 'undefined' && MapMovePin.armed && MapMovePin.armed()) MapMovePin.cancel();
  }

  function pick() {
    if (!job || !map) return;
    seq++;
    takeMap();
    picking = true;
    job.status = 'choose';
    const c = map.getContainer();
    c.classList.add('mn-drive-picking');
    c.addEventListener('pointerdown', onPickDown, true);
    c.addEventListener('click', onPickClick, true);
    if (!keyHandler) { keyHandler = onKey; document.addEventListener('keydown', keyHandler, true); }
    repaint();
    announce('Click the map where the drive starts. Escape stops.');
  }

  function stopPicking() {
    if (!picking) return;
    picking = false;
    pickDown = null;
    if (map) {
      const c = map.getContainer();
      c.removeEventListener('pointerdown', onPickDown, true);
      c.removeEventListener('click', onPickClick, true);
      c.classList.remove('mn-drive-picking');
    }
    if (keyHandler) { document.removeEventListener('keydown', keyHandler, true); keyHandler = null; }
  }

  // The pick is the container's click, taken on its way down rather than as
  // Leaflet's map click: a station pin or a link drawn on the shared canvas
  // marks its click as handled, and Leaflet then fires no map click — but a
  // start picked on top of a pin is still a start, and the pin's card is not
  // what was asked for, so the click goes no further. A pan that ends where it
  // began is a click; one that moved is a pan.
  function onPickDown(e) {
    pickDown = [e.clientX, e.clientY];
  }

  function onPickClick(e) {
    if (!picking || !map) return;
    const target = e.target;
    // The press on the panel's own Click the map repaints the panel, and its
    // click arrives with a target already off the page — site-features.js met
    // it first. Nothing on the ground is ever off the page; the controls are
    // not the ground either.
    if (!target || target.isConnected === false) return;
    if (target.closest && target.closest('.leaflet-control, .leaflet-control-container')) return;
    if (pickDown && Math.hypot(e.clientX - pickDown[0], e.clientY - pickDown[1]) > 6) return;
    e.stopPropagation();
    e.preventDefault();
    const ll = map.mouseEventToLatLng(e);
    route({ lat: ll.lat, lon: ll.lng, label: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`, how: 'map' });
  }

  function onKey(e) {
    if (e.key !== 'Escape' || !picking) return;
    e.stopPropagation();
    stopPicking();
    repaint();
  }

  // A start typed in: a coordinate, a station by its name or number, or a
  // place OpenStreetMap's gazetteer knows (through places.js, on its terms).
  async function typed(form) {
    if (!job) return false;
    const box = form && form.querySelector('input');
    const text = box ? box.value.trim() : '';
    if (!text) return false;
    const c = typeof Places !== 'undefined' ? Places.parse(text) : null;
    if (c && isFinite(c.lat) && isFinite(c.lon)) {
      route({ lat: c.lat, lon: c.lon, label: `${(+c.lat).toFixed(5)}, ${(+c.lon).toFixed(5)}`, how: 'typed' });
      return false;
    }
    const s = stationNamed(text);
    if (s) {
      route({ lat: +s.lat, lon: +s.lon, label: s.name || s.id, how: 'station' });
      return false;
    }
    const my = ++seq;
    job.note = `Looking up “${text}”…`;
    repaint();
    const res = typeof Places !== 'undefined' && Places.find ? await Places.find(text) : { ok: false, list: [] };
    if (!job || seq !== my) return false;
    const hit = res.list && res.list[0];
    if (!hit) {
      job.note = res.ok ? `Nothing called “${text}” was found.` : `“${text}” could not be looked up — ${res.error || 'the place-name service did not answer'}.`;
      repaint();
      announce(job.note);
      return false;
    }
    route({ lat: hit.lat, lon: hit.lon, label: hit.where ? `${hit.name}, ${hit.where}` : hit.name, how: 'place' });
    return false;
  }

  // A station with a pin by its name, number, id or ALERT address — the whole
  // of it, not a part: a part is a search, and this is a start.
  function stationNamed(text) {
    const t = text.toLowerCase();
    const list = ((state.data && state.data.stations) || []).filter(s => pinOf(s));
    return list.find(s => String(s.name || '').toLowerCase() === t)
      || list.find(s => String(s.station_number || '') === text || s.id === t)
      || null;
  }

  // ── What it says ───────────────────────────────────────────────────────────

  function duration(s) {
    const min = Math.max(1, Math.round(s / 60));
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  // The unmapped stretches, in metres: before the road, between the road and
  // the track (or the station), and between the track and the station.
  function gaps() {
    if (!job || !job.route) return { start: 0, mid: 0, end: 0, total: 0 };
    const r = job.route;
    const start = r.gap_start_m || 0;
    const mid = r.gap_end_m || 0;
    const end = job.track ? metres(job.track.pts[job.track.pts.length - 1], job.dest) : 0;
    const keep = m => (m >= GAP_M ? m : 0);
    const out = { start: keep(start), mid: keep(mid), end: keep(end) };
    out.total = out.start + out.mid + out.end;
    return out;
  }

  function summaryText() {
    const r = job && job.route;
    if (!r) return '';
    const parts = [`${fmtKm(r.km)} by road, about ${duration(r.s)}`];
    if (job.track) parts.push(`then ${fmtKm(job.track.lengthM / 1000)} of access track`);
    const g = gaps();
    if (g.total) parts.push(`${fmtKm(g.total / 1000)} not mapped`);
    return parts.join(', ');
  }

  function startHtml() {
    const s = job.start;
    if (!s) return '<span class="txt-muted">not chosen yet</span>';
    const acc = s.how === 'gps' && s.acc != null ? ` <span class="txt-muted">(±${esc(fmtKm(s.acc / 1000))})</span>` : '';
    return `${esc(s.label)}${acc}`;
  }

  function chooseHtml() {
    const s = stationById(job.stationId);
    const why = job.start || picking ? ''
      : `<p class="small mn-drive-why">${esc(job.note ? `${job.note} ` : '')}${
          s && s.hub_id === DEPOT_HUB ? '' : `${esc(job.name)} is not a Brisbane-hub station, so there is no depot to start from.`} Where does the drive start?</p>`;
    if (picking) {
      return `<p class="small mn-drive-why" role="status">${handheld() ? 'Tap' : 'Click'} the map where the drive starts.</p>
        <div class="pill-row"><button type="button" class="pill" onclick="MapDrive.choose()">${pillText('✕', 'Stop picking')}</button></div>`;
    }
    const note = job.start && job.note ? `<p class="small mn-drive-why">${esc(job.note)}</p>` : '';
    const lastPill = last && !(job.start && sameAt([last.lat, last.lon], [job.start.lat, job.start.lon]))
      ? `<button type="button" class="pill" onclick="MapDrive.useLast()" title="Start from ${escAttr(last.label)} again">${pillText('↩️', esc(last.label))}</button>` : '';
    return `${why}${note}
      <div class="pill-row mn-drive-starts">
        <button type="button" class="pill" onclick="MapDrive.useGps()" title="Start from where this device says it is">${pillText('📍', 'Where I am')}</button>
        <button type="button" class="pill" onclick="MapDrive.useDepot()" title="Start from Pritchard Road, Virginia — the Brisbane depot">${pillText('🏢', esc(DEPOT.label))}</button>
        <button type="button" class="pill" onclick="MapDrive.pick()" title="Click or tap the map where the drive starts">${pillText('🖱️', handheld() ? 'Tap the map' : 'Click the map')}</button>
        ${lastPill}
      </div>
      <form class="mn-drive-typed" onsubmit="MapDrive.typed(this); return false">
        <label class="small" for="mn-drive-from">Or a town, a station or a coordinate</label>
        <span class="mn-drive-typed-row">
          <input id="mn-drive-from" type="text" autocomplete="off" spellcheck="false" placeholder="Gympie · Gatton AL · -26.19, 152.66">
          <button type="submit" class="pill">${pillText('↵', 'Start here')}</button>
        </span>
      </form>
      ${job.start ? `<div class="pill-row"><button type="button" class="pill" onclick="MapDrive.back()">${pillText('↩', `Keep ${pillLong('starting from ')}${esc(job.start.label)}`)}</button></div>` : ''}`;
  }

  function stepsHtml() {
    const r = job.route;
    const g = gaps();
    const rows = r.steps.map(st => `<li><span>${esc(st.text)}</span>${st.km ? ` <span class="txt-muted">${esc(fmtKm(st.km))}</span>` : ''}</li>`);
    if (g.mid) rows.push(`<li><span>Then ${esc(fmtKm(g.mid / 1000))} with no mapped road${job.track ? ' to the start of the access track' : ' to the station'}.</span></li>`);
    if (job.track) rows.push(`<li><span>Then the access track, ${esc(fmtKm(job.track.lengthM / 1000))}${g.end ? '' : ', to the station'}.</span></li>`);
    if (g.end) rows.push(`<li><span>Then ${esc(fmtKm(g.end / 1000))} with no mapped track to the station.</span></li>`);
    return `<details class="mn-drive-fold"><summary>Turn by turn (${rows.length})</summary><ol class="mn-drive-steps">${rows.join('')}</ol></details>`;
  }

  function wordsHtml() {
    return `<details class="mn-drive-fold"><summary>What the words here mean</summary>
      <dl class="mn-drive-words">${WORDS.map(([, label, meaning]) => `<dt>${esc(label)}</dt><dd>${esc(meaning)}</dd>`).join('')}</dl>
    </details>`;
  }

  function creditHtml() {
    return `<p class="small txt-muted mn-drive-credit">Roads © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL), routed by Valhalla on FOSSGIS’s server ·
      <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">Report a map error ↗</a></p>`;
  }

  function panelHtml() {
    if (!job) return '';
    const s = stationById(job.stationId);
    const head = `<div class="mn-drive-head">
        <strong id="mn-drive-h">Route to ${esc(job.name)}</strong>
        <span class="mn-drive-btns">
          <button type="button" class="mn-drive-x" onclick="MapDrive.fold()" aria-expanded="${!job.folded}"
            title="${job.folded ? 'Show the route’s details' : 'Fold the panel to one line'}" aria-label="${job.folded ? 'Show the route’s details' : 'Fold the panel to one line'}">${job.folded ? '▸' : '▾'}</button>
          <button type="button" class="mn-drive-x" onclick="MapDrive.clear()" title="Take the route off the map" aria-label="Take the route off the map">✕</button>
        </span>
      </div>`;
    if (job.folded) {
      const line = job.status === 'ok' ? summaryText() : job.status === 'error' ? 'No route' : 'Not worked out yet';
      return `${head}<p class="small mn-drive-line">${esc(line)}</p>`;
    }
    const from = `<dl class="mn-drive-read">
        <dt>${term('from')}</dt>
        <dd>${startHtml()}${job.start && job.status !== 'choose' && job.status !== 'locating'
          ? ` <button type="button" class="link-btn" onclick="MapDrive.choose()" title="Start the drive somewhere else">Change</button>` : ''}${
          job.start && job.note && job.status !== 'choose' ? `<br><span class="small txt-muted mn-drive-note">${esc(job.note)}</span>` : ''}</dd>
      </dl>`;
    let body = '';
    if (job.status === 'starting') {
      body = `<p class="small" role="status">Working out where to start…</p>`;
    } else if (job.status === 'locating') {
      body = `<p class="small" role="status">Finding where you are…</p>`;
    } else if (job.status === 'choose') {
      body = chooseHtml();
    } else if (job.status === 'routing') {
      body = `<p class="small" role="status">Working out the drive…</p>`;
    } else if (job.status === 'error') {
      body = `<p class="small txt-bad" role="alert">${esc(job.error)}</p>
        <div class="pill-row">
          <button type="button" class="pill" onclick="MapDrive.again()">${pillText('↻', 'Try again')}</button>
          <button type="button" class="pill" onclick="MapDrive.choose()">${pillText('📍', 'Start elsewhere')}</button>
        </div>`;
    } else if (job.status === 'ok') {
      const r = job.route;
      const g = gaps();
      const rows = [
        `<dt>${term('road')}</dt><dd>${esc(fmtKm(r.km))}, about ${esc(duration(r.s))}${r.ferry ? ' <span class="txt-warn">· includes a ferry</span>' : ''}</dd>`,
        job.track ? `<dt>${term('track')}</dt><dd>${esc(fmtKm(job.track.lengthM / 1000))}</dd>` : '',
        g.total ? `<dt>${term('gap')}</dt><dd>${esc(fmtKm(g.total / 1000))}${!job.track && g.end + g.mid >= 500 ? ' <span class="txt-muted">· no access track mapped</span>' : ''}</dd>` : '',
      ].join('');
      body = `<dl class="mn-drive-read">${rows}</dl>
        ${stepsHtml()}
        <div class="pill-row">
          ${s ? directionsPillHtml(job.live ? { lat: job.dest[0], lon: job.dest[1] } : s) : ''}
          <button type="button" class="pill" onclick="MapDrive.fit()" title="Fit the whole route on the map">${pillText('🔍', 'Whole route')}</button>
        </div>
        ${creditHtml()}`;
    }
    return `${head}${from}${body}${wordsHtml()}`;
  }

  // ── The panel ──────────────────────────────────────────────────────────────

  function addPanel() {
    if (!map) return;
    if (panel) { repaint(); return; }
    panel = L.control({ position: 'bottomleft' });
    panel.onAdd = () => {
      const div = L.DomUtil.create('div', 'mn-drive-panel');
      div.setAttribute('role', 'group');
      div.setAttribute('aria-labelledby', 'mn-drive-h');
      div.innerHTML = panelHtml();
      // A press on the panel is never a click on the map — which, while a
      // start is being picked, would start the drive from the panel's corner.
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    panel.addTo(map);
  }

  function removePanel() {
    if (panel) { panel.remove(); panel = null; }
  }

  // In place: a fold somebody opened stays open across a repaint of the rest,
  // and focus inside the panel stays inside it — on the same control where it
  // is still there (known by what it does), else on the panel's first button,
  // rather than falling to the page with the markup it was on.
  function repaint() {
    const el = panel && panel.getContainer();
    if (!el) return;
    const open = [...el.querySelectorAll('details.mn-drive-fold')].map(d => d.open);
    const typedNow = el.querySelector('#mn-drive-from');
    const text = typedNow ? typedNow.value : '';
    const focused = document.activeElement === typedNow;
    const had = el.contains(document.activeElement) && document.activeElement !== typedNow ? document.activeElement : null;
    const hadKey = had && (had.getAttribute('onclick') || had.tagName);
    el.innerHTML = panelHtml();
    [...el.querySelectorAll('details.mn-drive-fold')].forEach((d, i) => { if (open[i]) d.open = true; });
    if (had) {
      const same = [...el.querySelectorAll('[onclick], summary')].find(x => (x.getAttribute('onclick') || x.tagName) === hadKey);
      const to = same || el.querySelector('button');
      if (to) to.focus({ preventScroll: true });
    }
    const box = el.querySelector('#mn-drive-from');
    if (box && text) box.value = text;
    // Into the box when the panel has just asked where from — at a desk; on a
    // phone that would put the keyboard over the map before anybody asked.
    if (box && (focused || (!handheld() && job && job.status === 'choose' && !picking && !job.start))) box.focus({ preventScroll: true });
  }

  // The station card's and the editor's pill say whether this station's route is up.
  function repaintCards() {
    if (typeof repaintStnCard === 'function') repaintStnCard();
    const el = document.getElementById('ef-drive');
    const s = el && stationById(state.editorId);
    if (el && s) el.outerHTML = pillHtml(s, { editor: true });
  }

  // ── The drawing ────────────────────────────────────────────────────────────

  function clearLayer() {
    if (layer) { layer.remove(); layer = null; }
    drawn = [];
  }

  function trackColour() {
    const k = typeof SITE_FEATURE_KINDS !== 'undefined' ? SITE_FEATURE_KINDS.find(x => x.key === 'access_track') : null;
    return (k && k.colour) || '#76ff03';
  }

  function draw() {
    clearLayer();
    drawn = [];
    if (!map || !job) return;
    if (!map.getPane(PANE)) {
      const p = map.createPane(PANE);
      p.style.zIndex = PANE_Z;
      p.style.pointerEvents = 'none';
    }
    if (!renderer) renderer = L.canvas({ pane: PANE });
    layer = L.layerGroup().addTo(map);
    const line = (kind, pts, look) => {
      if (!pts || pts.length < 2) return;
      drawn.push({ kind, pts: pts.map(p => p.slice()) });
      if (look.casing) L.polyline(pts, { renderer, pane: PANE, interactive: false, color: look.casing, weight: look.weight + 3.5, opacity: .85, dashArray: look.dash || null, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
      L.polyline(pts, { renderer, pane: PANE, interactive: false, color: look.color, weight: look.weight, opacity: 1, dashArray: look.dash || null, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
    };
    const gapLook = { color: GAP, casing: GAP_CASING, weight: 2.5, dash: '2,8' };
    const r = job.route;
    const from = job.start ? [job.start.lat, job.start.lon] : null;
    if (r) {
      const g = gaps();
      if (g.start && from) line('gap', [from, r.shape[0]], gapLook);
      line('road', r.shape, { color: ROAD, casing: ROAD_CASING, weight: 4.5 });
      const roadEnd = r.shape[r.shape.length - 1];
      if (g.mid) line('gap', [roadEnd, job.to], gapLook);
      if (job.track) {
        line('track', job.track.pts, { color: trackColour(), casing: TRACK_CASING, weight: 4 });
        if (g.end) line('gap', [job.track.pts[job.track.pts.length - 1], job.dest], gapLook);
      }
    }
    if (from) {
      L.circleMarker(from, { renderer, pane: PANE, interactive: false, radius: 7, weight: 3, color: ROAD_CASING, fillColor: '#ffffff', fillOpacity: 1 }).addTo(layer);
      L.circleMarker(from, { renderer, pane: PANE, interactive: false, radius: 3, weight: 0, fillColor: ROAD, fillOpacity: 1 }).addTo(layer);
    }
  }

  // How much of the map the panel stands over, as fitBounds padding:
  // site-features.js's clearOfPanel, for this panel.
  function clearOfPanel(edge = 28) {
    const pad = { paddingTopLeft: [edge, edge], paddingBottomRight: [edge, edge] };
    const el = panel && panel.getContainer();
    if (!map || !el || !el.offsetWidth) return pad;
    const m = map.getContainer().getBoundingClientRect();
    const p = el.getBoundingClientRect();
    if (m.right - p.right >= 220) pad.paddingTopLeft[0] = Math.max(edge, p.right - m.left + edge);
    else pad.paddingBottomRight[1] = Math.max(edge, m.bottom - p.top + edge);
    return pad;
  }

  function fit() {
    if (!map || !job) return;
    const pts = [];
    if (job.start) pts.push([job.start.lat, job.start.lon]);
    if (job.route) pts.push(...job.route.shape);
    if (job.track) pts.push(...job.track.pts);
    pts.push(job.dest);
    if (pts.length < 2) return;
    map.fitBounds(L.latLngBounds(pts), { ...clearOfPanel(), maxZoom: 16, animate: false });
  }

  // A station card opened while the route is up folds the panel, and closing
  // it unfolds the panel again — unless somebody folded or unfolded it by hand
  // in between. The card is shown and hidden by its `hidden` attribute.
  function watchCard() {
    if (cardWatch || typeof MutationObserver === 'undefined') return;
    const el = document.getElementById('stn-card');
    if (!el) return;
    cardWatch = new MutationObserver(() => {
      if (!job) return;
      if (!el.hidden && !job.folded) { job.folded = true; autoFolded = true; repaint(); }
      else if (el.hidden && autoFolded) { job.folded = false; autoFolded = false; repaint(); }
    });
    cardWatch.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  }

  // ── The pill ───────────────────────────────────────────────────────────────

  // In the station card's Position group, beside Directions, and in the
  // editor's — for a signed-in editor, and only for a station with a position.
  function pillHtml(s, { editor: inEditor = false } = {}) {
    if (!s || !s.id || !editor() || !pinOf(s)) return '';
    const on = !!job && job.stationId === s.id;
    return `<button type="button" class="pill mn-drive-pill${on ? ' is-on' : ''}"${inEditor ? ' id="ef-drive"' : ''} aria-pressed="${on}"
        onclick="MapDrive.open('${escAttr(s.id)}'${inEditor ? ', { live: true }' : ''})"
        title="${on ? 'Bring the route back into view' : `The drive to ${inEditor ? 'the latitude and longitude in the boxes above' : 'this station'} on the map above — by road, then its access track`}"
        >${pillText('🛣️', on ? 'Route shown' : `Route ${pillLong('on ')}map`)}</button>`;
  }

  return {
    attach(m) {
      map = m;
      watchCard();
      if (job) {
        addPanel();
        draw();
      }
    },

    // The map is being torn down: what this put on it goes; the route is kept
    // for the map that replaces it.
    detach() {
      if (cardWatch) { cardWatch.disconnect(); cardWatch = null; }
      stopPicking();
      clearLayer();
      if (renderer) { renderer.remove(); renderer = null; }
      removePanel();
      map = null;
    },

    // Signed in or out: a route asked for one editor is not another's.
    authChanged() {
      if (job && !editor()) clear();
      else repaintCards();
    },

    open, clear, choose, pick, useGps, useDepot, useLast, typed, fit,
    fold() {
      if (!job) return;
      job.folded = !job.folded;
      autoFolded = false;
      repaint();
    },
    again() { if (job && job.start) route(job.start); else choose(); },
    // From the start chooser, the start that was there before Change — and
    // its route, if it had one, without asking for it again.
    back() {
      if (!job || !job.start) return;
      seq++;
      stopPicking();
      if (job.route) { job.status = 'ok'; job.note = ''; repaint(); draw(); } else route(job.start);
    },
    pillHtml,
    active: () => !!job,
    picking: () => picking,
    DEPOT,

    // Read by the check and by nothing else.
    _job: () => (job ? JSON.parse(JSON.stringify(job)) : null),
    _drawn: () => drawn.map(d => ({ kind: d.kind, pts: d.pts.map(p => p.slice()) })),
    _pickTrack: pickTrack,
    _fallbackStart: fallbackStart,
  };
})();
if (typeof window !== 'undefined') window.MapDrive = MapDrive;
