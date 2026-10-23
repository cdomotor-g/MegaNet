// MegaNet — river-catchments.js
//
//   RiverCatchments   The land that drains to a river, or to a gauge on one:
//                     outlined on the Stations map and shaded by the height of
//                     its own ground, low green to pale tops, when a river is
//                     selected (map-river-lines.js) or a station's card asks
//                     for the country above its gauge.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, esc, escAttr, cssVar and announce;
// across to app.js for rerenderMapLegend, and to map-elevation.js for the
// terrain tiles' address (MapElevation.tileUrl, MAX_NATIVE). map-river-lines.js
// calls showRiver / clear as a river is selected and put down, and app.js
// places cardHtml on a station's card and calls ask once it is painted. All
// from inside its own functions, so this file's position among the modules is
// free.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Asked for after the rivers layer: "highlight the catchment of a stream … it
// would be cool to shade the catchment based on elevation data rather than the
// grainy KML data that we might already have" — the 2009 basins
// (map-catchments.js), 77 of them, drawn from a KMZ. A catchment here is the
// country above one river or one gauge, cut where the water actually divides.
//
// ── Where the boundaries come from ──────────────────────────────────────────
// The Bureau's Geofabric v3.3 Hydrology Reporting Catchments: the land surface
// cut at every significant node of the stream network — junctions, dams, and
// the gauging stations themselves — from a hydrologically conditioned ~30 m
// DEM, which is the job "work it out from the elevation" would be done
// properly, over the whole country, once. tools/build_catchments.py walks
// that network upstream for every river in the rivers file and every station
// on a stream, joins the pieces on a 250 m grid and writes the outlines:
//
//   data/catchments-au/index.json    each river's and station's area, and
//                                    which bucket holds its outline (~75 KB,
//                                    read when the first river is selected or
//                                    the first station card asks)
//   data/catchments-au/r<b>.json     the rivers' outlines, 32 to a file
//   data/catchments-au/s<b>.json     the stations', likewise
//
// A station's catchment is exact when its AWRC number is a gauged node of the
// network (2,699 nodes carry one), and otherwise the one above the reach it
// stands on, whichever of the two sub-catchment boundaries round it is nearer
// the Geofabric's own drainage area there. The card says which.
//
// ── The shading ─────────────────────────────────────────────────────────────
// The terrain is the Elevation layer's (map-elevation.js): the same ~30 m
// terrarium tiles, decoded in the browser, hillshaded the same way. What
// differs is the ramp. MapElevation's is the Radio Mobile colour file, a
// thousand metres in twelve absolute bands — four colours for the whole of
// coastal Queensland. A catchment is read for its own relief, so its ramp is
// stretched over its own ground: before a tile is drawn the outline's tiles
// are read at a coarse zoom and the 2nd and 98th percentile heights inside it
// become the ends of the ramp. The legend says what they are.
//
// Each tile is clipped to the outline (even-odd, so a hole stays a hole) in
// its own pixels, so outside the catchment nothing is drawn at all. Past the
// tiles' native zoom (12) Leaflet stretches them, edge and all; the outline,
// a vector over the top, stays sharp. With no terrain — offline, a blocked
// host — the catchment is a flat wash inside the same outline, and says so.
//
// ── Pointer conventions ─────────────────────────────────────────────────────
// None: both panes are pointer-events:none, for map-river-lines.js's reason,
// and a catchment the size of the Murray–Darling must never take a click a
// pin or a river was drawn to answer.
const RiverCatchments = (function () {
  const DIR = 'data/catchments-au/';
  const ATTRIBUTION = 'Catchments: Geofabric © Commonwealth of Australia (Bureau of Meteorology), CC BY 4.0';

  // Under the roads (338, 339) and the rivers (341) — the land is under what
  // runs across it — over the wind regions (330) and the polar plot (332).
  const RELIEF_PANE = 'mnCatchRelief', RELIEF_Z = 333;
  const LINE_PANE   = 'mnCatchLine',   LINE_Z   = 334;

  const TILE_PX = 256;
  const RANGE_TILES = 12;     // tiles read to find a catchment's height range
  const RELIEF_OPACITY = 0.78;
  const FAIL_TTL = 60000;

  // Low ground to high, as a topographic sheet tints it: river-flat green,
  // the plains' straw, the ranges' brown, the tops pale.
  const RAMP = ['#2f6b3b', '#5e9a4c', '#a7c46b', '#e2d79a', '#c9a46b', '#9b7350', '#efe9df'];
  const RAMP_RGB = RAMP.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));

  // MapElevation's hillshade, for the same ground: light from the north-west.
  const AZIMUTH = 315 * Math.PI / 180, ZENITH = 45 * Math.PI / 180, Z_FACTOR = 2.2;
  const SHADE_LO = 0.62, SHADE_HI = 1.22;

  let map = null, linePane = null, lineR = null, lineLayer = null, relief = null;
  let index = null, indexLoading = null, indexFailedAt = 0;
  const buckets = new Map();          // 'r3' → Promise of the bucket's JSON
  let shown = null;                   // { kind, key, title, area, how, no, rings, box, range, status }
  let seq = 0, attributed = false;

  // ── Data ──────────────────────────────────────────────────────────────────

  function ensureIndex() {
    if (index) return Promise.resolve(index);
    if (indexLoading) return indexLoading;
    if (Date.now() - indexFailedAt < FAIL_TTL) return Promise.reject(new Error('failed recently'));
    indexLoading = fetch(`${DIR}index.json`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { index = j; return j; })
      .catch(e => { indexFailedAt = Date.now(); throw e; })
      .finally(() => { indexLoading = null; });
    return indexLoading;
  }

  function bucket(name) {
    if (!buckets.has(name)) {
      buckets.set(name, fetch(`${DIR}${name}.json`)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .catch(e => { buckets.delete(name); throw e; }));
    }
    return buckets.get(name);
  }

  // Encoded polyline (latitude first) → flat [lat, lon, …].
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

  // The rings as decoded, each with its box [s, w, n, e].
  function ringsOf(entry, quant) {
    return entry.rings.map(str => {
      const ll = decodeLine(str, quant);
      let s = 90, w = 180, n = -90, e = -180;
      for (let i = 0; i < ll.length; i += 2) {
        if (ll[i] < s) s = ll[i];
        if (ll[i] > n) n = ll[i];
        if (ll[i + 1] < w) w = ll[i + 1];
        if (ll[i + 1] > e) e = ll[i + 1];
      }
      return { ll, box: [s, w, n, e] };
    });
  }

  // ── Web Mercator ──────────────────────────────────────────────────────────

  function worldX(lon, z) { return (lon + 180) / 360 * TILE_PX * Math.pow(2, z); }
  function worldY(lat, z) {
    const sin = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * TILE_PX * Math.pow(2, z);
  }

  // The outline as a Path2D in one tile's pixels, or null when no ring
  // reaches the tile — then nothing of the catchment is in it.
  function tilePath(rings, z, tx, ty) {
    const k = Math.pow(2, z);
    const w = tx / k * 360 - 180, e = (tx + 1) / k * 360 - 180;
    const lat = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / k))) * 180 / Math.PI;
    const n = lat(ty), s = lat(ty + 1);
    const ox = tx * TILE_PX, oy = ty * TILE_PX;
    let path = null;
    for (const r of rings) {
      const b = r.box;
      if (b[0] > n || b[2] < s || b[1] > e || b[3] < w) continue;
      path = path || new Path2D();
      const ll = r.ll;
      path.moveTo(worldX(ll[1], z) - ox, worldY(ll[0], z) - oy);
      for (let i = 2; i < ll.length; i += 2) path.lineTo(worldX(ll[i + 1], z) - ox, worldY(ll[i], z) - oy);
      path.closePath();
    }
    return path;
  }

  function loadTile(z, x, y) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('terrain tile'));
      img.src = MapElevation.tileUrl(z, x, y);
    });
  }

  function heightsOf(img) {
    const c = document.createElement('canvas');
    c.width = c.height = TILE_PX;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
    const px = cx.getImageData(0, 0, TILE_PX, TILE_PX).data;
    const h = new Float32Array(TILE_PX * TILE_PX);
    for (let i = 0, j = 0; j < h.length; i += 4, j++) h[j] = px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768;
    return h;
  }

  // Which of a tile's pixels are inside the outline: its path filled on a
  // scratch canvas, read back as alpha.
  function insideMask(path) {
    const c = document.createElement('canvas');
    c.width = c.height = TILE_PX;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.fill(path, 'evenodd');
    return cx.getImageData(0, 0, TILE_PX, TILE_PX).data;
  }

  // The catchment's own height range: its outline's tiles at the deepest
  // zoom that needs no more than RANGE_TILES of them, the heights inside it,
  // and the 2nd and 98th percentiles — so a lone peak or a sea pixel does not
  // set the ends of the ramp.
  async function heightRange(sh) {
    const [w, s, e, n] = sh.box;
    let z = Math.min(MapElevation.MAX_NATIVE, 11), tiles = [];
    for (; z >= 2; z--) {
      const x0 = Math.floor(worldX(w, z) / TILE_PX), x1 = Math.floor(worldX(e, z) / TILE_PX);
      const y0 = Math.floor(worldY(n, z) / TILE_PX), y1 = Math.floor(worldY(s, z) / TILE_PX);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= RANGE_TILES) {
        tiles = [];
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([x, y]);
        break;
      }
    }
    const got = [];
    await Promise.all(tiles.map(async ([x, y]) => {
      const path = tilePath(sh.rings, z, x, y);
      if (!path) return;
      const img = await loadTile(z, x, y);
      const h = heightsOf(img), m = insideMask(path);
      for (let j = 0; j < h.length; j += 3) {
        if (m[j * 4 + 3] > 127 && h[j] > -100 && h[j] < 9000) got.push(h[j]);
      }
    }));
    if (got.length < 20) throw new Error('no terrain inside the outline');
    got.sort((a, b) => a - b);
    const lo = got[Math.floor(got.length * 0.02)], hi = got[Math.floor(got.length * 0.98)];
    return { lo: Math.floor(lo), hi: Math.max(Math.ceil(hi), Math.floor(lo) + 10) };
  }

  // ── The relief ────────────────────────────────────────────────────────────

  function rampAt(t) {
    const f = Math.max(0, Math.min(1, t)) * (RAMP_RGB.length - 1);
    const i = Math.min(RAMP_RGB.length - 2, Math.floor(f)), u = f - i;
    const a = RAMP_RGB[i], b = RAMP_RGB[i + 1];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }

  function metresPerPixel(z, ty) {
    const n = Math.PI - 2 * Math.PI * (ty + 0.5) / Math.pow(2, z);
    return 156543.03392804097 * Math.cos(Math.atan(Math.sinh(n))) / Math.pow(2, z);
  }

  function paintRelief(h, z, ty, range) {
    const c = document.createElement('canvas');
    c.width = c.height = TILE_PX;
    const cx = c.getContext('2d');
    const data = cx.createImageData(TILE_PX, TILE_PX), px = data.data;
    const res = metresPerPixel(z, ty), span = range.hi - range.lo;
    const cosZ = Math.cos(ZENITH), sinZ = Math.sin(ZENITH);
    for (let y = 0, j = 0; y < TILE_PX; y++) {
      const yUp = y > 0 ? y - 1 : 0, yDn = y < TILE_PX - 1 ? y + 1 : TILE_PX - 1;
      for (let x = 0; x < TILE_PX; x++, j++) {
        const xL = x > 0 ? x - 1 : 0, xR = x < TILE_PX - 1 ? x + 1 : TILE_PX - 1;
        const dzdx = (h[y * TILE_PX + xR] - h[y * TILE_PX + xL]) / ((xR - xL) * res);
        const dzdy = (h[yUp * TILE_PX + x] - h[yDn * TILE_PX + x]) / ((yDn - yUp) * res);
        const slope = Math.atan(Z_FACTOR * Math.hypot(dzdx, dzdy));
        const aspect = Math.atan2(dzdy, -dzdx);
        const hs = cosZ * Math.cos(slope) + sinZ * Math.sin(slope) * Math.cos(AZIMUTH - aspect);
        const f = Math.max(SHADE_LO, Math.min(SHADE_HI, 1 + (hs - cosZ) * 1.15));
        const [r, g, b] = rampAt((h[j] - range.lo) / span);
        const o = j * 4;
        px[o] = Math.min(255, r * f); px[o + 1] = Math.min(255, g * f); px[o + 2] = Math.min(255, b * f);
        px[o + 3] = 255;
      }
    }
    cx.putImageData(data, 0, 0);
    return c;
  }

  function reliefLayer(sh) {
    const Layer = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement('canvas');
        tile.width = tile.height = TILE_PX;
        const path = tilePath(sh.rings, coords.z, coords.x, coords.y);
        if (!path) { setTimeout(() => done(null, tile), 0); return tile; }
        loadTile(coords.z, coords.x, coords.y).then(img => {
          const art = paintRelief(heightsOf(img), coords.z, coords.y, sh.range);
          const cx = tile.getContext('2d');
          cx.save();
          cx.clip(path, 'evenodd');
          cx.drawImage(art, 0, 0);
          cx.restore();
          done(null, tile);
        }).catch(e => done(e, tile));
        return tile;
      },
    });
    // Bounded to the outline's box, so no tile is even made for the country
    // round it; a tile inside the box but outside the outline is drawn blank.
    const [w, s, e, n] = sh.box;
    return new Layer({ pane: RELIEF_PANE, tileSize: TILE_PX, maxNativeZoom: MapElevation.MAX_NATIVE,
                       opacity: RELIEF_OPACITY, updateWhenZooming: false, keepBuffer: 1,
                       bounds: L.latLngBounds([s, w], [n, e]) });
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  function colours() {
    return { line: cssVar('--map-catch-line', '#0b4f8a'), wash: cssVar('--map-catch-wash', '#4fa3d9') };
  }

  function clearDrawn() {
    if (lineLayer) lineLayer.clearLayers();
    if (relief) { relief.remove(); relief = null; }
    syncAttribution();
  }

  function draw() {
    clearDrawn();
    if (!map || !shown || !shown.rings) return;
    const c = colours();
    const rings = shown.rings.map(r => {
      const out = new Array(r.ll.length / 2);
      for (let i = 0, j = 0; i < r.ll.length; i += 2, j++) out[j] = [r.ll[i], r.ll[i + 1]];
      return out;
    });
    // The wash first: it is all there is until the relief arrives, and all
    // there is without terrain. A white halo under the line, then the line.
    L.polygon(rings, { renderer: lineR, pane: LINE_PANE, interactive: false, stroke: false,
                       fillColor: c.wash, fillOpacity: shown.range ? 0.06 : 0.16, fillRule: 'evenodd',
                       className: 'mn-catch-wash' }).addTo(lineLayer);
    for (const [color, weight, opacity, cls] of [['#ffffff', 5, 0.85, 'mn-catch-halo'], [c.line, 2.2, 1, 'mn-catch-edge']]) {
      L.polygon(rings, { renderer: lineR, pane: LINE_PANE, interactive: false, fill: false,
                         color, weight, opacity, lineJoin: 'round', className: cls }).addTo(lineLayer);
    }
    if (shown.range) relief = reliefLayer(shown).addTo(map);
    syncAttribution();
  }

  function syncAttribution() {
    const want = !!(map && shown && shown.rings);
    if (!map || !map.attributionControl || want === attributed) return;
    if (want) map.attributionControl.addAttribution(ATTRIBUTION);
    else map.attributionControl.removeAttribution(ATTRIBUTION);
    attributed = want;
  }

  // Load, draw, then shade: the outline is up as soon as its bucket lands,
  // and the relief follows once the height range is known.
  async function show(kind, key, title, { fit = false } = {}) {
    const mine = ++seq;
    shown = { kind, key, title, status: 'loading' };
    clearDrawn();
    rerenderMapLegend();
    try {
      const ix = await ensureIndex();
      const row = kind === 'river' ? (ix.rivers || [])[key] : (ix.stations || {})[key];
      if (!row) {
        if (mine === seq) { shown.status = 'none'; rerenderMapLegend(); }
        return null;
      }
      const body = await bucket(`${kind === 'river' ? 'r' : 's'}${row[1]}`);
      const entry = body[String(key)];
      if (mine !== seq || !entry) return null;
      Object.assign(shown, { area: entry.area, box: entry.box, how: row[2] || null, no: row[3] || '',
                             rings: ringsOf(entry, ix.meta.quant), status: 'outline' });
      draw();
      if (fit && map) {
        const [w, s, e, n] = entry.box;
        map.fitBounds([[s, w], [n, e]], { padding: [24, 24], maxZoom: 13 });
      }
      rerenderMapLegend();
      try {
        const range = await heightRange(shown);
        if (mine !== seq) return shown;
        shown.range = range;
        shown.status = 'relief';
        draw();
      } catch (_) {
        if (mine === seq) shown.status = 'flat';
      }
      if (mine === seq) rerenderMapLegend();
      return shown;
    } catch (_) {
      if (mine === seq) { shown.status = 'fail'; rerenderMapLegend(); }
      return null;
    }
  }

  function clear() {
    seq++;
    if (!shown) return;
    shown = null;
    clearDrawn();
    rerenderMapLegend();
  }

  // ── The station card ──────────────────────────────────────────────────────

  const fmtInt = n => Math.round(n).toLocaleString('en-AU');

  function sectionHtml(s, row) {
    const head = `<span class="small txt-muted stn-card-rhs-head"
        title="The land that drains to this station, from the Bureau's Geofabric catchments (cut from a ~30 m elevation model at every gauge and junction of the stream network)">Catchment</span>`;
    if (row === undefined) return `${head}<div class="acma-row"><span>Above the gauge</span><span class="mn-pop-note">working it out…</span></div>`;
    const how = row[2] === 'gauge'
      ? `the Bureau's own, for gauging station ${esc(row[3])}`
      : 'placed on its stream by name and position — to the nearest sub-catchment boundary';
    return `${head}
      <div class="acma-row"><span>Above the gauge</span><span><strong>${fmtInt(row[0])} km²</strong>
        <span class="mn-pop-note">${how}</span></span></div>
      <div class="pill-row"><button type="button" class="pill" data-id="${escAttr(s.id)}"
        onclick="RiverCatchments.showStation(this.dataset.id)">Show the catchment on the map</button></div>`;
  }

  // Only a station a catchment could belong to gets the section: one on a
  // stream, or with a gauge number.
  function cardHtml(s) {
    if (!s || (!s.stream && !s.awrc_number)) return '';
    const row = index ? (index.stations || {})[String(s.id)] : undefined;
    if (index && !row) return '';
    return `<div class="acma-sect stn-card-catch" id="mn-catch-card-${escAttr(String(s.id))}">${sectionHtml(s, row)}</div>`;
  }

  function ask(elId, s) {
    if (!s || (!s.stream && !s.awrc_number) || index) return;
    ensureIndex().then(ix => {
      const el = document.getElementById(elId);
      if (!el) return;
      const row = (ix.stations || {})[String(s.id)];
      if (!row) { el.remove(); return; }
      el.innerHTML = sectionHtml(s, row);
    }).catch(() => {
      const el = document.getElementById(elId);
      if (el) el.remove();
    });
  }

  // ── The legend ────────────────────────────────────────────────────────────

  function legendHtml() {
    if (!shown) return '';
    const what = `${shown.kind === 'river' ? 'Catchment of' : 'Catchment above'} ${esc(shown.title || '')}`;
    const gradient = `linear-gradient(90deg, ${RAMP.join(', ')})`;
    let body;
    switch (shown.status) {
      case 'loading': body = `${what} — loading…`; break;
      case 'none':    body = `${what} — not in the Geofabric's catchments at this river's mouth`; break;
      case 'fail':    body = `${what} — could not be loaded`; break;
      case 'relief':  body = `${what} — ${fmtInt(shown.area)} km², shaded by its own ground from
                      ${fmtInt(shown.range.lo)} m to ${fmtInt(shown.range.hi)} m`; break;
      case 'flat':    body = `${what} — ${fmtInt(shown.area)} km² (no terrain to shade it with)`; break;
      default:        body = `${what} — ${fmtInt(shown.area || 0)} km², shading…`;
    }
    return `
    <span class="legend-item">
      <span class="legend-catch" style="--catch-ramp:${shown.status === 'relief' ? gradient : 'var(--map-catch-wash)'}"></span>
      <span class="small">${body} (Geofabric, Bureau of Meteorology)</span>
    </span>`;
  }

  return {
    ATTRIBUTION,

    attach(m) {
      map = m;
      for (const [name, z] of [[RELIEF_PANE, RELIEF_Z], [LINE_PANE, LINE_Z]]) {
        if (!m.getPane(name)) {
          const p = m.createPane(name);
          p.style.zIndex = z;
          p.style.pointerEvents = 'none';
        }
      }
      linePane = m.getPane(LINE_PANE);
      lineR = L.svg({ pane: LINE_PANE });
      lineLayer = L.layerGroup().addTo(m);
      // Survives the map being rebuilt, as a river's selection does.
      if (shown && shown.rings) draw();
    },

    detach() {
      if (relief) { relief.remove(); relief = null; }
      if (map && attributed && map.attributionControl) map.attributionControl.removeAttribution(ATTRIBUTION);
      attributed = false;
      map = linePane = lineR = lineLayer = null;
    },

    // A river selected on the map (its index in the rivers file).
    showRiver(rid, title) { return show('river', rid, title); },
    // A station's card: the country above its gauge, and the map goes there.
    showStation(id) {
      const s = state.data && state.data.stations.find(x => String(x.id) === String(id));
      if (!s) return Promise.resolve(null);
      return show('station', String(id), s.name, { fit: true }).then(r => {
        if (r) announce(`The catchment above ${s.name} is on the map: ${fmtInt(r.area)} km².`);
        return r;
      });
    },
    clear,

    // Theme switch: the line and the wash read their colours at draw time.
    repaint() { if (shown && shown.rings) draw(); },

    // What a river's callout says about its catchment: { area } once the
    // index is here, null for a river with none, undefined until then.
    riverInfo(rid) {
      if (!index) return undefined;
      const row = (index.rivers || [])[rid];
      return row ? { area: row[0] } : null;
    },
    ready: ensureIndex,

    // { kind, key, title, area, status, range } of what is on the map, or null.
    shown() {
      return shown ? { kind: shown.kind, key: shown.key, title: shown.title, area: shown.area || null,
                       status: shown.status, range: shown.range || null } : null;
    },
    active() { return !!shown; },
    legendHtml,
    cardHtml,
    ask,
  };
})();
if (typeof window !== 'undefined') window.RiverCatchments = RiverCatchments;
