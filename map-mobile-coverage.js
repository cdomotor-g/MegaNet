// MegaNet — map-mobile-coverage.js
//
//   MapMobileCoverage   The carriers' own 4G coverage maps, on the Stations
//                       map: Telstra's, Optus's or TPG's (or the best of the
//                       three), covered outdoors or only with an external
//                       antenna, as each carrier submitted them to the ACCC.
//                       And one pixel of the same tiles for a point, so the
//                       station and What is here cards can set the carrier's
//                       own word beside their estimate (site-mobile.js).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `state`, esc and escAttr; across to app.js for
// rerenderMapLegend and rerenderMapDisplayControls. All from inside its own
// functions, so this file's position among the modules is free.
//
// ── Where the tiles come from ───────────────────────────────────────────────
// tools/coverage_tiles.py, once a year, out of the ACCC's Mobile Infrastructure
// Report data release (data.gov.au, CC BY 2.5 AU): each carrier's 4G map at the
// two levels the ACCC names, Outdoor and Ext Ant, as at 31 January. Those are
// polygons — 300 MB to 1.4 GB of KML a map — so the tool rasterises them once
// into data/coverage/: zoom 9 native (~270 m a pixel), 3–8 overviews, a tile
// only where there is coverage, and index.json listing every tile written.
// Same origin, so no CORS, no key and nothing to break but the file.
//
// Every pixel is 9·v with v = telstra + 3·optus + 9·tpg, each 0 none, 1
// external antenna only, 2 outdoor. One tile set answers for all three: this
// layer reads the value back through a canvas and paints the carrier asked
// for, which is why it is an L.GridLayer and not an L.tileLayer — a picture of
// three carriers' maps at once could not be told apart.
//
// ── What it is not ──────────────────────────────────────────────────────────
// It is the carriers' prediction, at 31 January, before the ACMA standard's
// grades: covered or not, nothing about how strong. The cards' estimate is the
// other half of the answer and says so; neither is a measurement.
const MapMobileCoverage = (function () {
  const BASE = 'data/coverage';
  const INDEX_URL = `${BASE}/index.json`;
  const TILE = 256;
  const BLANK_Z_BELOW = 3;
  // Above the elevation-data coverage (246) and below the contours (335) in
  // the z-index budget map-survey.js documents: a wash of colour over the
  // ground, under everything drawn to be read or clicked.
  const PANE = 'mnMobileCov';
  const PANE_Z = 248;
  const CACHE_MAX = 96;

  const CARRIERS = [
    { key: 'telstra', name: 'Telstra', unit: 1 },
    { key: 'optus', name: 'Optus', unit: 3 },
    { key: 'tpg', name: 'TPG (Vodafone)', unit: 9 },
    { key: 'any', name: 'Any of the three — the best', unit: 0 },
  ];

  // The two levels, as the ACCC names them, and their colours on the map and
  // in the key. Green for a phone that works outdoors, amber for one that
  // needs an external antenna: the same reading as the cards' good and basic.
  const LEVELS = [
    { cls: 2, key: 'outdoor', label: 'Outdoor — a phone in the hand', rgb: [31, 157, 85] },
    { cls: 1, key: 'external', label: 'External antenna only', rgb: [224, 161, 0] },
  ];

  let map = null;
  let layer = null;
  let indexP = null;
  let index = null;
  let have = null;                 // z → Set of 'x_y'
  const tiles = new Map();         // 'z/x/y' → Promise<Uint8Array|null> of v per pixel

  // ── Data ──────────────────────────────────────────────────────────────────

  function loadIndex() {
    if (!indexP) {
      indexP = fetch(INDEX_URL).then(r => {
        if (!r.ok) throw new Error(`${INDEX_URL}: HTTP ${r.status}`);
        return r.json();
      }).then(d => {
        index = d;
        have = {};
        for (const [z, list] of Object.entries(d.tiles || {})) have[z] = new Set(list);
        return d;
      }).catch(e => { indexP = null; throw e; });
    }
    return indexP;
  }

  function exists(z, x, y) {
    return !!(have && have[z] && have[z].has(`${x}_${y}`));
  }

  // A tile's v per pixel, decoded once and kept (most recently used last).
  function tileValues(z, x, y) {
    const k = `${z}/${x}/${y}`;
    if (tiles.has(k)) {
      const p = tiles.get(k);
      tiles.delete(k); tiles.set(k, p);
      return p;
    }
    const p = new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = cv.height = TILE;
          const cx = cv.getContext('2d', { willReadFrequently: true });
          cx.drawImage(img, 0, 0);
          const d = cx.getImageData(0, 0, TILE, TILE).data;
          const step = (index && index.meta && index.meta.step) || 9;
          const out = new Uint8Array(TILE * TILE);
          for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = Math.round(d[j] / step);
          resolve(out);
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = `${BASE}/${z}/${x}/${y}.png`;
    }).then(v => { if (!v) tiles.delete(k); return v; });
    tiles.set(k, p);
    while (tiles.size > CACHE_MAX) tiles.delete(tiles.keys().next().value);
    return p;
  }

  // One carrier's level out of a pixel's v; 'any' is the best of the three.
  function levelOf(v, carrier) {
    if (carrier === 'any') return Math.max(v % 3, Math.floor(v / 3) % 3, Math.floor(v / 9) % 3);
    const c = CARRIERS.find(x => x.key === carrier) || CARRIERS[0];
    return Math.floor(v / c.unit) % 3;
  }

  // ── The point ─────────────────────────────────────────────────────────────

  // What each carrier's own map says at a point: { telstra, optus, tpg } as
  // 0 none, 1 external antenna only, 2 outdoor, plus asAt — or null when the
  // point is outside the maps' box or the tiles cannot be read. Never draws
  // and needs no map: the cards ask it whether or not the layer is on.
  async function at(lat, lon) {
    let d;
    try { d = await loadIndex(); } catch (_) { return null; }
    const m = d.meta || {};
    const box = m.box;
    if (!box || lon < box.w || lon > box.e || lat > box.n || lat < box.s) return null;
    const z = m.z_native || 9;
    const n = TILE * 2 ** z;
    const s = Math.sin(lat * Math.PI / 180);
    const px = (lon + 180) / 360 * n;
    const py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    const x = Math.floor(px / TILE), y = Math.floor(py / TILE);
    let v = 0;
    if (exists(z, x, y)) {
      const vals = await tileValues(z, x, y);
      if (!vals) return null;
      v = vals[Math.floor(py - y * TILE) * TILE + Math.floor(px - x * TILE)];
    }
    return { telstra: v % 3, optus: Math.floor(v / 3) % 3, tpg: Math.floor(v / 9) % 3,
             asAt: m.as_at || null, year: m.year || null };
  }

  // ── The layer ─────────────────────────────────────────────────────────────

  function carrier() {
    const c = state.mapMobileCovCarrier;
    return CARRIERS.some(x => x.key === c) ? c : 'telstra';
  }

  function opacity() {
    const n = Number(state.mapMobileCovOpacity);
    return isFinite(n) ? Math.max(0.1, Math.min(1, n)) : 0.5;
  }

  // Paint one map tile from the native tile over it — itself, at z ≤ native;
  // a corner of it, scaled up a pixel at a time, past native.
  async function paint(cv, coords) {
    await loadIndex();
    const zN = index.meta.z_native || 9;
    if (coords.z < BLANK_Z_BELOW) return;
    const up = Math.max(0, coords.z - zN);
    const z = coords.z - up, x = coords.x >> up, y = coords.y >> up;
    if (!exists(z, x, y)) return;
    const vals = await tileValues(z, x, y);
    if (!vals) return;
    const span = TILE >> up;                                  // source pixels this tile covers
    const ox = (coords.x - (x << up)) * span, oy = (coords.y - (y << up)) * span;
    const cx = cv.getContext('2d');
    const img = cx.createImageData(TILE, TILE);
    const d = img.data;
    const who = carrier();
    const scale = TILE / span;
    for (let j = 0; j < TILE; j++) {
      const row = (oy + Math.floor(j / scale)) * TILE + ox;
      for (let i = 0; i < TILE; i++) {
        const lv = levelOf(vals[row + Math.floor(i / scale)], who);
        if (!lv) continue;
        const rgb = lv === 2 ? LEVELS[0].rgb : LEVELS[1].rgb;
        const o = (j * TILE + i) * 4;
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
  }

  function makeLayer() {
    const Grid = L.GridLayer.extend({
      createTile(coords, done) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = TILE;
        paint(cv, coords).then(() => done(null, cv), () => done(null, cv));
        return cv;
      },
    });
    return new Grid({ pane: PANE, opacity: opacity(), attribution: attribution() });
  }

  function attribution() {
    return (index && index.meta && index.meta.attribution)
      || 'Mobile coverage: © Australian Competition and Consumer Commission (CC BY 2.5 AU)';
  }

  function clearLayer() {
    if (layer && map) map.removeLayer(layer);
    layer = null;
  }

  function sync() {
    if (!map) return;
    if (!state.mapMobileCov) { clearLayer(); return; }
    if (!layer) {
      if (typeof L === 'undefined') return;
      if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = PANE_Z;
      layer = makeLayer().addTo(map);
      return;
    }
    layer.setOpacity(opacity());
  }

  function redraw() {
    if (layer) layer.redraw();
  }

  function rerender() {
    if (typeof rerenderMapDisplayControls === 'function') rerenderMapDisplayControls();
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
  }

  // ── Keys and notes ────────────────────────────────────────────────────────

  function keyHtml() {
    return `<ul class="elev-ramp mn-mobcov-key">${LEVELS.map(l =>
      `<li><i style="--dot:rgb(${l.rgb.join(',')})"></i><span>${esc(l.label)}</span></li>`).join('')}</ul>`;
  }

  function asAtWords() {
    const m = index && index.meta;
    return m && m.as_at ? `as at ${new Date(`${m.as_at}T00:00:00`).toLocaleDateString('en-AU',
      { day: 'numeric', month: 'long', year: 'numeric' })}` : 'as at 31 January';
  }

  function noteHtml() {
    if (!state.mapMobileCov) {
      return 'Off. Draws each carrier’s own 4G coverage map, as it gave it to the ACCC — where a phone works '
           + 'outdoors, and where only with an external antenna.';
    }
    const c = CARRIERS.find(x => x.key === carrier());
    return `${esc(c.name)}’s 4G map, ${esc(asAtWords())}, painted at <strong>${Math.round(opacity() * 100)}%</strong>. `
         + 'The carriers’ own prediction, not a measurement, and from before the ACMA’s standard grades — the '
         + 'station and What is here cards set an estimate of the signal beside it. Drawn at ~270 m; past zoom 9 '
         + 'it is that, enlarged.';
  }

  function controlsHtml() {
    const on = !!state.mapMobileCov;
    return `
    <label class="filter-check">
      <input type="checkbox" ${on ? 'checked' : ''}
             onchange="MapMobileCoverage.setEnabled(this.checked)">
      Mobile coverage — the carriers’ 4G maps
    </label>
    ${on ? `
    <label class="filter-field">
      <span>Carrier</span>
      <select onchange="MapMobileCoverage.setCarrier(this.value)">
        ${CARRIERS.map(c => `<option value="${escAttr(c.key)}" ${carrier() === c.key ? 'selected' : ''}>${
          esc(c.name)}</option>`).join('')}
      </select>
    </label>
    <label class="filter-range">
      <span>Coverage opacity <strong id="mobile-cov-opacity-val" aria-hidden="true">${
        Math.round(opacity() * 100)}%</strong></span>
      <input type="range" min="0.1" max="1" step="0.05" value="${opacity()}"
             aria-label="Mobile coverage opacity"
             aria-valuetext="${Math.round(opacity() * 100)} per cent"
             oninput="document.getElementById('mobile-cov-opacity-val').textContent=Math.round(this.value*100)+'%';this.setAttribute('aria-valuetext',Math.round(this.value*100)+' per cent');MapMobileCoverage.setOpacity(+this.value)">
    </label>
    ${keyHtml()}` : ''}
    <p class="filter-note" id="map-mobile-cov-note">${noteHtml()}</p>`;
  }

  function legendHtml() {
    const c = CARRIERS.find(x => x.key === carrier());
    return LEVELS.map(l => `
    <span class="legend-item">
      <span class="legend-sq" style="--dot:rgb(${l.rgb.join(',')})"></span>
      <span class="small">${esc(`${c.name} 4G — ${l.label.toLowerCase()} (the carrier’s map, ${asAtWords()}; ACCC)`)}</span>
    </span>`).join('');
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) m.createPane(PANE).style.zIndex = PANE_Z;
      sync();
    },

    detach() {
      clearLayer();
      map = null;
    },

    sync,
    at,
    levelOf,
    controlsHtml,
    legendHtml,
    keyHtml,
    noteHtml,
    opacity,

    // Does the legend claim a key right now?
    active() { return !!layer; },

    // Off by default and not persisted, on ElvisCoverage's terms: a context
    // layer that costs requests stays off until asked for. The carrier and the
    // opacity are preferences, so those are remembered.
    setEnabled(on) {
      state.mapMobileCov = !!on;
      if (on) loadIndex().then(() => { if (layer) layer.options.attribution = attribution(); }, () => {});
      sync();
      rerender();
    },

    setCarrier(c) {
      if (!CARRIERS.some(x => x.key === c)) return;
      state.mapMobileCovCarrier = c;
      try { localStorage.setItem('mn-mobile-cov-carrier', c); } catch (_) {}
      redraw();
      rerender();
    },

    setOpacity(v) {
      const n = Math.max(0.1, Math.min(1, Number(v) || 0));
      state.mapMobileCovOpacity = n;
      try { localStorage.setItem('mn-mobile-cov-op', String(n)); } catch (_) {}
      if (layer) layer.setOpacity(n);
      const note = document.getElementById('map-mobile-cov-note');
      if (note) note.innerHTML = noteHtml();
    },

    CARRIERS, LEVELS,
    clear() { tiles.clear(); indexP = null; index = null; have = null; },
  };
})();
if (typeof window !== 'undefined') window.MapMobileCoverage = MapMobileCoverage;
