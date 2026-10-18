// MegaNet — nearby.js
//
//   Nearby   📌 the Nearby tab: the stations closest to where you are standing,
//            nearest first, with how far and which way — and, for the one you
//            pick, what a visit needs in one place: Start inspection, Photos,
//            Directions, Show on the map.
//
// After core.js (state, esc, escAttr, announce, fmtKm, bearingDeg,
// acmaHaversineKm, stationDirectionsUrl, ROLE_LABEL, registerTabTeardown),
// before init.js. Reaches across to app.js for filteredStations, switchTab
// and goToStation; to inspections.js for Inspections.pick, isOpen, refsReady
// and ensureRefs; to field-camera.js for FieldCamera.pickStation; and to
// toast.js for Toast. All of it at call time, so this file's position among
// the modules is free. Nothing runs at load (`npm run toplevel`);
// renderMain() calls render() and init() for the tab.
//
// ── Why a list ───────────────────────────────────────────────────────────────
// The first question at a gate is "which station is this?", and the second is
// "which one is next?". The Stations map answers both, but on a phone it is a
// map to pan and pins to tap, under a side panel; 🔭 Look Around answers the
// first by pointing, and needs the camera and the compass to. This is the
// answer as a list: the nearest twenty-five, the distance in a straight line
// and the compass point, big enough to tap with a glove on. It is the first
// button in the Calm look's bar along a phone's foot (calm-shell.js), and a
// tab like any other under Site visits in either look.
//
// ── Where it measures from ───────────────────────────────────────────────────
// The phone's position, read once when asked — not watched: a list that
// re-sorts itself under a thumb is a list that opens the wrong station. Refresh
// reads it again. Without a GPS (a desk, a refused prompt) it measures from
// where the Stations map was last looking, as Look Around does. Asked for
// without a press only where the browser says the permission is already
// given, so opening the tab never springs a prompt on anybody.
//
// The position is used here and nowhere else: not stored, not sent, gone with
// the page.
//
// Exposes: render, init, locate, fromMap, open, back, more, inspect, photos, show.

const Nearby = (() => {
  const PAGE = 25;
  const GPS_TIMEOUT_MS = 15000;
  const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

  // Session-only, for the reasons above.
  let here = null;          // { lat, lon, acc, from: 'gps' | 'map', at }
  let asking = false;
  let error = '';
  let pick = null;          // the station id open, or null for the list
  let shown = PAGE;
  let lastAuto = 0;

  const $ = id => document.getElementById(id);
  const hasPos = s => !!s && s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon);
  const point = deg => POINTS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  const stationById = id => ((state.data && state.data.stations) || []).find(s => s.id === id) || null;

  function mapCentre() {
    const c = state.map ? state.map.getCenter() : state.mapLastView;
    return c && isFinite(c.lat) && isFinite(c.lng) ? { lat: c.lat, lon: c.lng } : null;
  }

  // The stations the Stations tab's filters leave, each with how far and
  // which way from `here`, nearest first.
  function ranked() {
    if (!here) return [];
    return filteredStations().filter(hasPos).map(s => {
      const km = acmaHaversineKm(here.lat, here.lon, s.lat, s.lon);
      return { s, km, deg: bearingDeg(here.lat, here.lon, s.lat, s.lon) };
    }).sort((a, b) => a.km - b.km);
  }

  function roleText(s) {
    const roles = (s.roles || []).map(r => (typeof ROLE_LABEL !== 'undefined' && ROLE_LABEL[r]) || r);
    return roles.join(' · ');
  }

  // ── The page ──────────────────────────────────────────────────────────────

  function render() {
    const s = pick ? stationById(pick) : null;
    if (pick && !s) pick = null;
    return `
      <div class="page nb-page" style="--page-max:720px">
        ${s ? stationHtml(s) : listHtml()}
      </div>`;
  }

  function fromText() {
    if (!here) return '';
    const mins = Math.round((Date.now() - here.at) / 60000);
    const when = mins < 1 ? 'just now' : `${mins} min ago`;
    return here.from === 'gps'
      ? `From your position${here.acc ? `, ±${Math.round(here.acc)} m` : ''} — ${when}.`
      : `From the middle of the Stations map, where it was last looking — ${when}.`;
  }

  function listHtml() {
    const centre = mapCentre();
    const rows = ranked();
    const list = rows.slice(0, shown);
    return `
      <div class="panel nb-head">
        <div class="panel-header"><h2 id="nb-h">Nearby</h2></div>
        <p class="small txt-muted nb-lead">The stations closest to you, nearest first. Pick one for what a visit needs.</p>
        <div class="button-row nb-go">
          <button type="button" class="primary" id="nb-gps" onclick="Nearby.locate()" ${asking ? 'disabled' : ''}>
            ${asking ? 'Finding you…' : here && here.from === 'gps' ? 'Refresh' : 'Use my location'}</button>
          <button type="button" id="nb-map" onclick="Nearby.fromMap()" ${centre ? '' : 'disabled aria-describedby="nb-map-why"'}>
            From the map's centre</button>
        </div>
        <p class="small nb-from" id="nb-from" role="status">${error ? `<span class="txt-warn">${esc(error)}</span> ` : ''}${esc(fromText())}</p>
        ${centre ? '' : `<p class="small txt-muted" id="nb-map-why">From the map's centre wakes up once the Stations tab
          has been opened on this device.</p>`}
      </div>
      ${!here ? `
      <div class="panel nb-empty">
        <p>Press <strong>Use my location</strong> and allow it once. Your position is used to sort this list on this
          device and is never sent or kept.</p>
      </div>` : !rows.length ? `
      <div class="panel nb-empty"><p>No station with a position is left by the Stations tab's filters.</p></div>` : `
      <ul class="nb-list" aria-labelledby="nb-h">
        ${list.map(r => `
        <li>
          <button type="button" class="nb-row" data-id="${escAttr(r.s.id)}" onclick="Nearby.open('${escAttr(r.s.id)}')">
            <span class="nb-name">${esc(r.s.name || r.s.id)}
              <span class="nb-meta">${esc([r.s.station_number && `Station ${r.s.station_number}`, roleText(r.s)].filter(Boolean).join(' · '))}</span>
            </span>
            <span class="nb-dist"><strong>${esc(fmtKm(r.km))}</strong><span>${point(r.deg)}</span></span>
          </button>
        </li>`).join('')}
      </ul>
      ${rows.length > list.length ? `
      <div class="button-row nb-more"><button type="button" onclick="Nearby.more()">Show ${Math.min(PAGE, rows.length - list.length)} more</button></div>` : ''}`}`;
  }

  function stationHtml(s) {
    const r = here ? { km: acmaHaversineKm(here.lat, here.lon, s.lat, s.lon), deg: bearingDeg(here.lat, here.lon, s.lat, s.lon) } : null;
    const dir = hasPos(s) ? stationDirectionsUrl(s) : null;
    const ids = s.alert_ids ? Object.values(s.alert_ids).filter(v => v != null) : [];
    return `
      <div class="panel nb-stn">
        <button type="button" class="link-btn nb-back" onclick="Nearby.back()">‹ Nearby</button>
        <h2 id="nb-stn-h">${esc(s.name || s.id)}</h2>
        <p class="txt-muted nb-stn-meta">${esc([s.station_number && `Station ${s.station_number}`, roleText(s)].filter(Boolean).join(' · '))}
          ${r ? `<br>${esc(fmtKm(r.km))} ${point(r.deg)} of ${here.from === 'gps' ? 'you' : 'the map\'s centre'}` : ''}</p>
        <div class="nb-acts">
          <button type="button" class="primary nb-big" onclick="Nearby.inspect('${escAttr(s.id)}')">Start inspection</button>
          <div class="nb-two">
            <button type="button" onclick="Nearby.photos('${escAttr(s.id)}')">Photos</button>
            ${dir ? `<a class="btn-link nb-dir" href="${escAttr(dir)}" target="_blank" rel="noopener">Directions</a>`
                  : '<button type="button" disabled title="This station has no position">Directions</button>'}
          </div>
          <button type="button" class="link-btn" onclick="Nearby.show('${escAttr(s.id)}')">Show on the map</button>
        </div>
        ${ids.length ? `<p class="small txt-muted">ALERT ${ids.length > 1 ? 'IDs' : 'ID'} ${esc(ids.join(', '))}</p>` : ''}
      </div>`;
  }

  function repaint() {
    if (state.activeTab !== 'nearby') return;
    const main = $('main-content');
    if (main) main.innerHTML = render();
  }

  // The tab coming into view. A position already allowed is read straight
  // away — once a minute at most, so going back and forth between tabs does
  // not keep the GPS busy.
  //
  // Leaving the tab puts the station away: coming back — the bar's Nearby
  // above all — is coming back to the list. The list itself, and where it was
  // measured from, stay for the page's life.
  let registered = false;
  function init() {
    if (!registered) { registerTabTeardown('Nearby', () => { pick = null; }); registered = true; }
    if (pick || asking || !navigator.permissions || !navigator.permissions.query) return;
    if (here && here.from === 'gps' && Date.now() - here.at < 60000) return;
    if (Date.now() - lastAuto < 60000) return;
    navigator.permissions.query({ name: 'geolocation' })
      .then(p => { if (p && p.state === 'granted' && state.activeTab === 'nearby') { lastAuto = Date.now(); locate(); } })
      .catch(() => {});
  }

  // ── Where from ────────────────────────────────────────────────────────────

  function locate() {
    if (!('geolocation' in navigator)) { error = 'This browser cannot tell where it is.'; repaint(); return; }
    asking = true;
    error = '';
    repaint();
    navigator.geolocation.getCurrentPosition(p => {
      asking = false;
      here = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy || 0, from: 'gps', at: Date.now() };
      shown = PAGE;
      repaint();
      const first = ranked()[0];
      announce(first ? `Nearest: ${first.s.name}, ${fmtKm(first.km)} ${point(first.deg)}.` : 'No station nearby.');
    }, e => {
      asking = false;
      error = e && e.code === 1 ? 'Location was refused — allow it for this site in the browser\'s settings, or use the map\'s centre.'
            : 'No position yet — try again in the open, or use the map\'s centre.';
      repaint();
      announce(error);
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: GPS_TIMEOUT_MS });
  }

  function fromMap() {
    const c = mapCentre();
    if (!c) return;
    here = { lat: c.lat, lon: c.lon, acc: 0, from: 'map', at: Date.now() };
    error = '';
    shown = PAGE;
    repaint();
    const first = ranked()[0];
    announce(first ? `Nearest the map's centre: ${first.s.name}.` : 'No station nearby.');
  }

  function more() {
    shown += PAGE;
    repaint();
  }

  // ── One station ───────────────────────────────────────────────────────────

  function open(id) {
    pick = id;
    repaint();
    window.scrollTo(0, 0);
    const h = $('nb-stn-h');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  function back() {
    const was = pick;
    pick = null;
    repaint();
    const row = was && document.querySelector(`.nb-row[data-id="${CSS.escape(was)}"]`);
    if (row) row.focus(); else { const h = $('nb-h'); if (h) { h.setAttribute('tabindex', '-1'); h.focus(); } }
  }

  // The inspection sheet, already filled in with this station — unless one is
  // already open on that tab, which is somebody's half-done visit and is not
  // thrown away for a new one: they are taken to it instead, and told.
  function inspect(id) {
    const open = typeof Inspections.isOpen === 'function' && Inspections.isOpen();
    switchTab('inspections');
    if (open) {
      if (typeof Toast !== 'undefined') Toast.note('An inspection is already open — save or close it, then start the next one.');
      return;
    }
    if (Inspections.refsReady()) Inspections.pick(id);
    else Inspections.ensureRefs(() => { if (state.activeTab === 'inspections' && !Inspections.isOpen()) Inspections.pick(id); });
  }

  function photos(id) {
    switchTab('camera');
    FieldCamera.pickStation(id);
  }

  function show(id) {
    goToStation(id);
  }

  return { render, init, locate, fromMap, open, back, more, inspect, photos, show };
})();
if (typeof window !== 'undefined') window.Nearby = Nearby;
