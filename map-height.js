// MegaNet — map-height.js
//
//   MapHeight   the ground's height under the pointer on the Stations map, in
//               metres AHD — the digital twin's height readout, on the map,
//               in 2-D and in ⛰️ 3-D. Off until its switch (AHD, under 💬 in
//               the map's top-right corner) is pressed; remembered.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches across to terrain.js (Terrain.sample), geoid.js (Geoid.at),
// lidar-profile.js (LidarProfile.peek, point) and map-3d.js (Map3D.active),
// and back to core.js for esc, announce and toast.js's Toast — all from inside
// its own functions. Nothing runs at load: app.js attaches the switch to the
// Stations map when it builds it, and map-3d.js hands it the 3-D view's moves.
//
// ── Asked for ────────────────────────────────────────────────────────────────
// "add a little button to the top right with the tool tip button that turns
// on AHD height to the tooltip (like we have in the digital twin mode tool
// tip)" (16 Nov 2026), with the 5 m LiDAR where it covers, as the twin has.
//
// ── Where the height comes from ──────────────────────────────────────────────
// Two answers, the better one shown as soon as it is here:
//
//   ~30 m tiles   terrain.js's SRTM tiles, already fetched for every profile,
//                 put into AHD with geoid.js (AHD = EGM96 − 2.07 m to + 0.64 m
//                 over the stations). At once, rounded to the metre and said
//                 with ≈: a tile pixel is 30 m of ground and, in a forest,
//                 partly canopy. Where the geoid has no value (far out at sea)
//                 the height is left above EGM96 and the readout says so.
//   5 m LiDAR     Geoscience Australia's LiDAR-derived grid, bare ground, AHD
//                 — the same tiles the path profiles fetch (LidarProfile), so
//                 a spot near a path already drawn is free. Asked for only
//                 when the pointer rests (REST_MS) and only from LIDAR_ZOOM in:
//                 further out a screen pixel is wider than the tiles' 30 m and
//                 a sweep of the pointer would ask for a tile a pixel. Shown to
//                 the centimetre, as the twin shows its LiDAR ground.
//
// ── Where it is shown ────────────────────────────────────────────────────────
// A small box below and left of the pointer, turned back inside the map at its
// edges: the map's hover names hang above the pointer and the 3-D view's label
// below and right of it, so the three never land on one another. It is its own
// switch, not one of 💬's hover notes: turning those off leaves it alone. A
// finger has no pointer to rest, so on a touch screen the switch does nothing
// until a mouse is used — its hover text says the readout follows the pointer.
const MapHeight = (() => {
  const STORE      = 'mn-map-height';
  const LIDAR_ZOOM = 12;    // the 2-D map's zoom (or 3-D's) from which LiDAR is asked for
  const REST_MS    = 250;   // the pointer still this long before a LiDAR tile is fetched
  const GAP        = 14;    // px between the pointer and the box

  let isOnNow = null;           // read once, the first time anything asks
  const switched = new Set();   // maps wearing the switch
  let box = null;               // the readout
  let at = null;                // the pointer's last spot: { lat, lon, x, y, zoom, host }
  let frame = 0, restTimer = 0, seq = 0;

  // The words on the readout, and what each means — the switch's hover text
  // and What's new carry them where a finger can read them.
  const WORDS = {
    ahd: 'm AHD: metres on the Australian Height Datum — height above mean sea level as Australia surveys it, the datum '
      + 'every station\'s surveyed height, gauge zero and flood level in Flood-Net is in.',
    lidar: '5 m LiDAR: bare ground from Geoscience Australia\'s laser survey, on a 5 m grid, to a few tenths of a metre. '
      + 'Shown to the centimetre where the survey covers the spot.',
    tiles: '~30 m terrain: the satellite (SRTM) heights the elevation profiles use, one per 30 m of ground and in a forest '
      + 'partly the treetops, put into AHD here. Rounded to the metre and shown with ≈ while the LiDAR loads or where it '
      + 'does not cover.',
  };
  const TITLE_ON = 'Ground height is on: resting the pointer on the map shows the ground\'s height there in m AHD — '
    + 'from the 5 m LiDAR where it covers (zoom in close), otherwise ≈ from the ~30 m terrain. Press to turn it off.\n\n'
    + `${WORDS.ahd}\n\n${WORDS.lidar}\n\n${WORDS.tiles}`;
  const TITLE_OFF = 'Ground height under the pointer, in m AHD — as the digital twin shows it. Press to turn it on.\n\n'
    + `${WORDS.ahd}\n\n${WORDS.lidar}\n\n${WORDS.tiles}`;

  function isOn() {
    if (isOnNow === null) {
      try { isOnNow = localStorage.getItem(STORE) === 'on'; } catch (_) { isOnNow = false; }
    }
    return isOnNow;
  }

  function paint(map) {
    const b = map._mnHeightBtn;
    if (!b) return;
    const on = isOn();
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-on', on);
    b.title = on ? TITLE_ON : TITLE_OFF;
  }

  function setEnabled(on) {
    isOnNow = !!on;
    try { localStorage.setItem(STORE, on ? 'on' : 'off'); } catch (_) { /* still set for this session */ }
    for (const m of [...switched]) {
      const el = m.getContainer && m.getContainer();
      if (!el || !document.contains(el)) { switched.delete(m); continue; }
      paint(m);
    }
    if (!on) hide();
    const said = on ? 'Ground height on — rest the pointer on the map to read the ground\'s height in m AHD.'
      : 'Ground height off.';
    if (typeof Toast !== 'undefined' && Toast.show) Toast.show(said);
    else if (typeof announce === 'function') announce(said);
  }

  const in3d = () => typeof Map3D !== 'undefined' && !!Map3D.active && Map3D.active();

  // The switch: a small control of its own under 💬 (map-tip-stack.js), in its
  // dress — a way of reading the map, not a tool.
  function attachSwitch(map) {
    if (!map || map._mnHeightBtn || typeof L === 'undefined') { if (map) paint(map); return; }
    const ctl = L.control({ position: 'topright' });
    ctl.onAdd = () => {
      const b = L.DomUtil.create('button', 'mn-map-tips mn-map-height');
      b.type = 'button';
      b.innerHTML = '<span aria-hidden="true">AHD</span>';
      b.setAttribute('aria-label', 'Ground height under the pointer, in metres AHD');
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, 'click', L.DomEvent.stop);
      L.DomEvent.on(b, 'click', () => setEnabled(!isOn()));
      L.DomEvent.on(b, 'dblclick', L.DomEvent.stop);
      map._mnHeightBtn = b;
      return b;
    };
    ctl.addTo(map);
    switched.add(map);
    paint(map);
    // The flat map's moves. While ⛰️ 3-D is up its canvas is inside this
    // container and the moves bubble here with the flat map's idea of where
    // they are, which is not the ground under the pointer: 3-D sends its own.
    map.on('mousemove', e => {
      if (in3d()) return;
      const ev = e.originalEvent;
      if (!ev || ev.buttons || (ev.target && ev.target.closest && ev.target.closest('.leaflet-control'))) { hide(); return; }
      move(e.latlng.lat, e.latlng.lng, ev.clientX, ev.clientY, map.getZoom(), map.getContainer());
    });
    map.on('mouseout', () => { if (!in3d()) hide(); });
    map.on('movestart zoomstart', () => { if (!in3d()) hide(); });
  }

  // The 3-D view's moves (map-3d.js): the ground the pointer is on, there.
  function move3d(lat, lon, ev, zoom, host) {
    if (!ev || ev.buttons) { hide(); return; }
    move(lat, lon, ev.clientX, ev.clientY, zoom, host);
  }

  function move(lat, lon, x, y, zoom, host) {
    if (!isOn() || !host || !isFinite(lat) || !isFinite(lon)) { hide(); return; }
    at = { lat, lon, x, y, zoom, host };
    if (!frame) frame = requestAnimationFrame(now);
  }

  function hide() {
    at = null;
    seq++;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    if (restTimer) { clearTimeout(restTimer); restTimer = 0; }
    if (box) box.hidden = true;
  }

  function now() {
    frame = 0;
    const p = at;
    if (!p) return;
    const my = ++seq;
    if (restTimer) { clearTimeout(restTimer); restTimer = 0; }
    const LP = typeof LidarProfile !== 'undefined' && LidarProfile.peek ? LidarProfile : null;
    const close = p.zoom >= LIDAR_ZOOM;
    const lid = LP && close ? LP.peek(p.lat, p.lon) : undefined;
    if (typeof lid === 'number' && lid === lid) { render(p, { lidar: lid }); return; }
    // What the LiDAR line says while the tiles answer: coming, not here, or
    // not asked for at this zoom.
    let why = !LP ? 'none' : !close ? 'zoom' : lid === null ? 'pending' : 'none';
    let tile = null;
    const show = () => { if (my === seq) render(p, { tile, why }); };
    const T = typeof Terrain !== 'undefined' && Terrain.sample ? Terrain : null;
    const G = typeof Geoid !== 'undefined' && Geoid.at ? Geoid : null;
    Promise.all([
      T ? T.sample(p.lat, p.lon, 12).catch(() => null) : null,
      G ? G.at(p.lat, p.lon) : { ok: false },
    ]).then(([h, g]) => {
      tile = h == null || !isFinite(h) ? { none: true } : { h, sep: g && g.ok ? g.m : null };
      show();
    });
    if (why === 'pending') {
      restTimer = setTimeout(() => {
        restTimer = 0;
        LP.point(p.lat, p.lon).then(r => {
          if (my !== seq) return;
          if (r.ok) { render(p, { lidar: r.h }); return; }
          why = r.none ? 'none' : 'failed';
          show();
        });
      }, REST_MS);
    }
  }

  // The readout's two lines, as plain text: { head, sub }.
  function words(r) {
    if (r.lidar != null) return { head: `${r.lidar.toFixed(2)} m AHD`, sub: 'ground · 5 m LiDAR' };
    const lidarSay = {
      pending: 'LiDAR loading…',
      zoom: 'zoom in for 5 m LiDAR',
      none: 'no LiDAR here',
      failed: 'LiDAR did not answer',
    }[r.why] || '';
    const t = r.tile;
    if (!t) return { head: '…', sub: 'reading the ground' };
    if (t.none) return { head: 'No ground height', sub: r.why === 'pending' ? 'terrain tile missing · LiDAR loading…' : 'the terrain tile did not load' };
    if (t.sep == null) return { head: `≈ ${Math.round(t.h)} m above EGM96`, sub: `not AHD here · ~30 m terrain${lidarSay ? ` · ${lidarSay}` : ''}` };
    return { head: `≈ ${Math.round(t.h + t.sep)} m AHD`, sub: `~30 m terrain${lidarSay ? ` · ${lidarSay}` : ''}` };
  }

  function render(p, r) {
    const host = p.host;
    if (!host || !document.contains(host)) return;
    if (!box || box.parentNode !== host) {
      if (box) box.remove();
      box = document.createElement('div');
      box.className = 'mn-height-tip';
      box.setAttribute('aria-hidden', 'true');
      box.innerHTML = '<strong></strong><span></span>';
      host.appendChild(box);
    }
    const w = words(r);
    box.firstChild.textContent = w.head;
    box.lastChild.textContent = w.sub;
    box.classList.toggle('is-lidar', r.lidar != null);
    box.hidden = false;
    // Below and left of the pointer; turned back inside the map at its edges.
    const rect = host.getBoundingClientRect();
    const px = p.x - rect.left, py = p.y - rect.top;
    const bw = box.offsetWidth, bh = box.offsetHeight;
    let x = px - GAP - bw, y = py + GAP;
    if (x < 4) x = Math.min(px + GAP, rect.width - bw - 4);
    if (y + bh > rect.height - 4) y = Math.max(4, py - GAP - bh);
    box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  return {
    attachSwitch,
    setEnabled,
    enabled: isOn,
    move3d,
    hide,
    words: () => ({ ...WORDS }),
    // The check's seam: the two lines a result would show.
    _words: words,
  };
})();
