// ── Where am I? (mobile) ─────────────────────────────────────────────────────
// Off by default and only offered on touch devices: a button below the zoom
// control puts a dot at the phone's GPS position with an accuracy ring, plus a
// cone pointing the way the phone is facing when a compass is available.
// iOS only hands out orientation events after a permission request made from a
// user gesture, which is why that request lives in the button's click handler.
const MapLocate = (function () {
  let map = null, btn = null;
  let on = false, watchId = null, marker = null, ring = null;
  let heading = null, orientEvent = null, gotCompass = false, followed = false;

  function isMobile() {
    return L.Browser.mobile || window.matchMedia('(pointer: coarse)').matches;
  }

  function icon() {
    return L.divIcon({
      className: 'mn-loc-icon',
      html: '<div class="mn-loc"><i class="mn-loc-cone"></i><i class="mn-loc-dot"></i></div>',
      iconSize: [46, 46], iconAnchor: [23, 23],
    });
  }

  function applyHeading() {
    const el   = marker && marker.getElement();
    const cone = el && el.querySelector('.mn-loc-cone');
    if (!cone) return;
    cone.style.display   = heading == null ? 'none' : '';
    cone.style.transform = `rotate(${heading || 0}deg)`;
  }

  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      h = e.webkitCompassHeading;                                  // iOS: clockwise from north
    } else if (e.alpha != null && (e.absolute || e.type === 'deviceorientationabsolute')) {
      h = 360 - e.alpha;                                           // spec alpha runs anticlockwise
    }
    if (h == null) return;      // relative-only sensor: no compass, leave it to GPS course
    // Compass readings are relative to the device's natural orientation; add the
    // screen rotation so the cone still points the right way in landscape.
    const screenAngle = (window.screen.orientation && window.screen.orientation.angle) ||
                        window.orientation || 0;
    gotCompass = true;
    heading = (h + screenAngle + 360) % 360;
    applyHeading();
  }

  function listenOrientation() {
    orientEvent = ('ondeviceorientationabsolute' in window)
      ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(orientEvent, onOrient, true);
  }

  function startOrientation() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return;
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission()
        .then(res => { if (res === 'granted') listenOrientation(); })
        .catch(() => {});
    } else {
      listenOrientation();
    }
  }

  function onPos(p) {
    if (!on || !map) return;
    const ll  = [p.coords.latitude, p.coords.longitude];
    const acc = p.coords.accuracy || 0;
    // No compass readings arriving? Fall back to GPS course, which is only
    // meaningful on the move.
    if (!gotCompass && p.coords.heading != null && !isNaN(p.coords.heading) &&
        p.coords.speed > 0.5) {
      heading = p.coords.heading;
    }
    if (!marker) {
      ring   = L.circle(ll, { radius: acc, color: '#1e88e5', weight: 1,
                              fillColor: '#1e88e5', fillOpacity: .12, interactive: false }).addTo(map);
      marker = L.marker(ll, { icon: icon(), interactive: false, keyboard: false,
                              zIndexOffset: 2000 }).addTo(map);
    } else {
      marker.setLatLng(ll);
      ring.setLatLng(ll).setRadius(acc);
    }
    applyHeading();
    if (!followed) {                          // centre on the first fix only
      followed = true;
      map.setView(ll, Math.max(map.getZoom(), 14));
      mapNote('', 0);
    }
  }

  function onErr(e) {
    mapNote(`Location unavailable — ${e.message || 'no fix'}`, 6000);
    if (e.code === 1) stop();                 // permission denied: don't keep trying
  }

  function stop() {
    on = false;
    if (btn) btn.classList.remove('on');
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (orientEvent) window.removeEventListener(orientEvent, onOrient, true);
    orientEvent = null;
    heading = null;
    gotCompass = false;
    if (marker) marker.remove();
    if (ring)   ring.remove();
    marker = ring = null;
  }

  function toggle() {
    if (on) { stop(); mapNote('', 0); return; }
    on = true;
    followed = false;
    if (btn) btn.classList.add('on');
    mapNote('Locating…', 8000);
    startOrientation();
    watchId = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 20000,
    });
  }

  return {
    attach(m) {
      map = m;
      if (!('geolocation' in navigator) || !isMobile()) return;
      const ctl = L.control({ position: 'topleft' });
      ctl.onAdd = () => {
        const div = L.DomUtil.create('div', 'leaflet-bar mn-locate');
        const a   = L.DomUtil.create('a', '', div);
        a.href = '#';
        a.title = 'Show my location and heading';
        a.setAttribute('role', 'button');
        a.setAttribute('aria-label', 'Show my location and heading');
        a.innerHTML = '➤';
        L.DomEvent.on(a, 'click', L.DomEvent.stop).on(a, 'click', toggle);
        btn = a;
        return div;
      };
      ctl.addTo(m);
    },

    // The map is being torn down (tab switch or re-render): drop the GPS watch
    // and the compass listener rather than leaving them running unseen.
    detach() { if (on) stop(); map = null; btn = null; },
  };
})();

