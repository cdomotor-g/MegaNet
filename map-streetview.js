// MegaNet — map-streetview.js
//
//   MapStreetView  street view from any point on the Stations map: right-click
//                  (a mouse) or press and hold (a finger), and a small callout
//                  at that spot offers "Open street view here" — a plain link
//                  to Google Street View in a new tab.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, announce, pillText and stationLatLonText,
// and across to map-3d.js and map-twin.js only to ask whether they are up — all
// from inside its own functions; the IIFE body only defines (`npm run toplevel`).
// app.js attaches it in initMap() and detaches it in stopStationsMap().
//
// ── Why ──────────────────────────────────────────────────────────────────────
// Every station card already has a Street View pill, and What's here? one too,
// but both start from a station or from the ℹ️ tool being armed. The question
// that comes up on a map is the other one: what does the *road in* look like,
// the gate, the bridge, the bend — a point nobody has made a station of. So the
// gesture is the one a map already has: ask the point itself.
//
// ── What it is, and is not ───────────────────────────────────────────────────
// A link. Nothing is embedded, no key is used, nothing is sent anywhere until
// the person presses it, and it opens with rel="noopener" in a new tab. The URL
// is Google's Maps URLs form (`map_action=pano&viewpoint=LAT,LNG`), which lands
// on the nearest panorama; where there is none it opens the map at that point,
// which the link's hover says.
//
// ── Why it does not get in the way ───────────────────────────────────────────
//   * A right-click is listened for on the map's container, not the map, so it
//     works over a pin too — a marker keeps its right-click to itself.
//   * A press and hold is a pointer timer of its own: a finger that moves, lifts,
//     adds a second finger or starts a pan or a zoom cancels it. Android's own
//     long-press menu is the contextmenu event, which is taken the same way.
//   * The click a long press can leave behind is swallowed for a moment (in the
//     capture phase), so a tool that is armed — What's here?, a draw tool —
//     does not also take the point.
//   * In 3-D and in the Digital Twin the 2-D map's coordinate under the pointer
//     is the wrong one (map-here.js says why), so it stands down there.
const MapStreetView = (function () {
  const HOLD_MS = 550;      // a finger held this long without moving is a press and hold
  const SLOP_PX = 10;       // …and "without moving" is this far
  const SWALLOW_MS = 700;   // the click a long press may leave behind, dropped for this long

  let map = null, box = null, popup = null;
  let hold = null;          // { id, x, y, timer } — a finger that might be a press and hold
  let swallowUntil = 0;

  // Google's Maps URLs form, the comma written as it is in the documentation.
  function url(lat, lon) {
    const f = v => String(Number(Number(v).toFixed(6)));
    return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${f(lat)},${f(lon)}`;
  }

  function html(lat, lon) {
    const here = stationLatLonText({ lat, lon });
    return `<div class="mn-sv">
      <div class="small txt-muted mn-sv-at">${esc(here)}</div>
      <div class="pill-row pill-list mn-popup-actions">
        <a class="pill mn-sv-link" href="${esc(url(lat, lon))}" target="_blank" rel="noopener"
           title="Opens Google Street View at the nearest panorama to this point, in a new tab; where there is no coverage it opens the map at this point instead">${pillText('🚶', 'Open street view here', '↗')}</a>
      </div>
    </div>`;
  }

  function threeD() {
    return (typeof Map3D !== 'undefined' && Map3D.active && Map3D.active())
        || (typeof MapTwin !== 'undefined' && MapTwin.active && MapTwin.active());
  }

  // Furniture that has its own right-click, press or text: the controls, a
  // callout, the magnifier's glass, a box being typed in.
  function ignored(target) {
    return !!(target && target.closest
      && target.closest('.leaflet-control, .leaflet-popup, .mn-magnify, input, textarea, select'));
  }

  function openAt(clientX, clientY) {
    if (!map || threeD()) return false;
    const ll = map.mouseEventToLatLng({ clientX, clientY }).wrap();
    if (!isFinite(ll.lat) || !isFinite(ll.lng)) return false;
    popup = L.popup({ className: 'mn-sv-pop', maxWidth: 280, autoPanPadding: [16, 16] })
      .setLatLng(ll).setContent(html(ll.lat, ll.lng)).openOn(map);
    announce(`Street view link for ${stationLatLonText({ lat: ll.lat, lon: ll.lng })} is open on the map.`);
    return true;
  }

  function onContextMenu(e) {
    if (!map || ignored(e.target)) return;
    if (openAt(e.clientX, e.clientY)) e.preventDefault();
  }

  function cancelHold() {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  }

  function onDown(e) {
    if (!map || e.pointerType === 'mouse') return;       // a mouse right-clicks
    if (hold) { cancelHold(); return; }                  // a second finger: a pinch, not a press
    if (ignored(e.target) || threeD()) return;
    const h = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: 0 };
    h.timer = setTimeout(() => {
      if (hold !== h) return;
      hold = null;
      if (openAt(h.x, h.y)) swallowUntil = Date.now() + SWALLOW_MS;
    }, HOLD_MS);
    hold = h;
  }

  function onMove(e) {
    if (hold && e.pointerId === hold.id && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > SLOP_PX) cancelHold();
  }

  function onUp(e) {
    if (hold && e.pointerId === hold.id) cancelHold();
  }

  function onClickCapture(e) {
    if (Date.now() > swallowUntil) return;
    swallowUntil = 0;
    e.stopPropagation();
    e.preventDefault();
  }

  return {
    attach(m) {
      this.detach();
      map = m;
      box = m.getContainer();
      box.addEventListener('contextmenu', onContextMenu);
      box.addEventListener('pointerdown', onDown);
      box.addEventListener('pointermove', onMove);
      box.addEventListener('pointerup', onUp);
      box.addEventListener('pointercancel', onUp);
      box.addEventListener('click', onClickCapture, true);
      map.on('movestart zoomstart', cancelHold);
    },

    detach() {
      cancelHold();
      if (box) {
        box.removeEventListener('contextmenu', onContextMenu);
        box.removeEventListener('pointerdown', onDown);
        box.removeEventListener('pointermove', onMove);
        box.removeEventListener('pointerup', onUp);
        box.removeEventListener('pointercancel', onUp);
        box.removeEventListener('click', onClickCapture, true);
      }
      if (map) map.off('movestart zoomstart', cancelHold);
      if (popup && map) map.closePopup(popup);
      map = box = popup = null;
      swallowUntil = 0;
    },

    // For the checks (test/streetview.mjs, and the callers that want the link).
    url,
    openAt,
    close() { if (popup && map) map.closePopup(popup); popup = null; },
  };
})();
if (typeof window !== 'undefined') window.MapStreetView = MapStreetView;
