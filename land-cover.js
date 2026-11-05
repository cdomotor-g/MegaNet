// MegaNet — land-cover.js
//
//   LandCover   what stands on the ground along a path — trees, buildings,
//               crops, water — sampled from a 10 m satellite land-cover map,
//               and the representative height each class is given so the
//               profile, the Fresnel zone and the propagation model see the
//               canopy and the rooftops rather than bare earth.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for nothing but the state object it keeps its
// height table in; the IIFE body sets tunables and two empty caches, so its
// position among the modules is free.
//
// ── Why ─────────────────────────────────────────────────────────────────────
// A 4 m field-station antenna in a gum forest is not 4 m above the ground the
// radio sees; it is 11 m *below* the top of it. Radio Mobile's "Land cover"
// layer exists for this: each cover class carries a height, the heights are
// added to the elevation model, and the Radio Link window paints the cover as
// a coloured band on the profile so an operator can see which ridge is rock
// and which is trees. This is the same feature, from a better map.
//
// ── The source ──────────────────────────────────────────────────────────────
// Esri / Impact Observatory / Microsoft "Sentinel-2 10m Land Cover", one
// class per 10 m pixel, a map per calendar year from 2017, served from an
// ArcGIS ImageServer that answers cross-origin from a static page and can be
// asked for every sample of a path in ONE request (`getSamples` over a
// multipoint). Nine classes; the ones that stand up are Trees, Built area,
// Crops, Flooded vegetation and Rangeland.
//
// It is a class map, not a height map, so every height here is the class's
// REPRESENTATIVE height — ITU-R P.1812's word for exactly this substitution:
// "Trees" is 15 m whether it is regrowth or a stand of ironbark. The table is
// editable on the card and remembered, and the figures start from P.1812-6's
// defaults (open/rural 10 m is deliberately *not* applied to rangeland: the
// profile already has the terrain, and a 10 m "representative clutter" over
// paddock is a fiction P.1812 uses in its terminal formula, not on a path).
//
// ── Tree heights from a canopy map, not a table ─────────────────────────────
// Where the class map says Trees, a fixed 15 m is a guess. Esri's Global
// Canopy Height 2020 (ETH Zürich's 10 m map, Lang et al., ±5 m) gives the
// measured canopy height per pixel, served as LERC-compressed tiles that a
// static page can fetch cross-origin. It is decoded here with Esri's own
// `lerc` decoder, loaded from a CDN the first time a profile needs it and
// never before — a 30 KB script for a feature most tabs never touch. Where the
// map has a height, that height stands on the profile; where it does not (no
// tile, decoder unavailable, offline) the class table's figure does, and the
// legend says which. Crops and rangeland are the exception: over a paddock or
// a pasture the canopy map reads 3–8 m of nothing, so such a pixel takes its
// reading only from TREE_MIN (10 m) up — a tree in the field, named Trees —
// and its class figure below it. This is the one place MegaNet is ahead of Radio Mobile
// rather than level with it: a real canopy height instead of a class constant
// — the input ITU-R P.1812 validation work found as good as a 1 m surface
// model, and better than a class map with 15 m trees.
//
// ── What comes back ─────────────────────────────────────────────────────────
// sample(lat[], lon[]) resolves — never rejects — to
//   { ok:false, error }                            nothing usable; say so
//   { ok:true, cls[], canopy[], canopyOk, year, resolution_m, attribution,
//     missing, partial, clsMap[] }
// cls[i] is the class code at sample i, or null where the service had no
// pixel (cloud, ocean edge, an answer that never came) — Trees where the
// canopy map stands a tree in a field or pasture (named()), with the class
// map's own answer in clsMap; canopy[i] the measured canopy height in metres,
// or null where there is none. The profile card
// turns the pair into a height per sample with `heights(cls, canopy)` and
// paints the classes with `colourVar(code)`. Every failure is loud: a path with no cover
// data is drawn bare and *says* it is bare, because bare reads as clear.

const LandCover = (function () {
  const SERVICE  = 'https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer';
  const BATCH    = 256;      // samples per request; a 256-sample profile is one call
  const FETCH_MS = 20000;    // the service takes ~4 s for 256 points over 80 km
  const STORE    = 'mn-cover-heights-v1';
  const CACHE_MAX = 64;      // sampled paths kept, ~1 KB each

  // Esri's class codes. `h` is the representative height in metres — the
  // P.1812-6 figures where it has one (trees/forest 15, suburban 10), and a
  // field estimate where it does not: cane and sorghum stand 2–4 m, mangrove
  // and paperbark swamp a good deal more than reeds, and a 10 m "built area"
  // is the low-rise town this network actually runs through, not a CBD.
  // Cloud is NOT a height: a cloud pixel is a missing pixel, and it is kept
  // as null so it can never quietly read as 0 m of nothing there.
  const CLASSES = {
    1:  { key: 'water',   label: 'Water',              h: 0,    note: 'reflective, no height' },
    2:  { key: 'trees',   label: 'Trees',              h: 15,   note: 'P.1812 trees/forest' },
    4:  { key: 'flooded', label: 'Flooded vegetation', h: 5,    note: 'mangrove, swamp, wetland' },
    5:  { key: 'crops',   label: 'Crops',              h: 2,    note: 'cane and grain in the field' },
    7:  { key: 'built',   label: 'Built area',         h: 10,   note: 'P.1812 suburban' },
    8:  { key: 'bare',    label: 'Bare ground',        h: 0,    note: '' },
    9:  { key: 'snow',    label: 'Snow / ice',         h: 0,    note: '' },
    10: { key: 'cloud',   label: 'Cloud — no data',    h: null, note: 'unclassified pixel' },
    11: { key: 'range',   label: 'Rangeland',          h: 1,    note: 'grass, scrub, open woodland floor' },
  };
  const ATTRIB = 'Land cover: Esri / Impact Observatory / Microsoft Sentinel-2 10 m Land Cover';

  // The canopy-height tiles: EPSG:4326, 256 px, origin (−180, 84), level n at
  // 0.68266°/2ⁿ per pixel — level 13 is ~9.3 m. Fine for a short hop, and one
  // level coarser (~37 m) past 30 km where the terrain is sampled coarser than
  // that anyway and a 100 km path would otherwise want forty tiles.
  const CANOPY    = 'https://tiledimageservices.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/10m_Tree_Canopy_Height/ImageServer';
  const CANOPY_ATTRIB = 'Canopy height: Esri Global Canopy Height 2020 (ETH Zürich, Lang et al., 10 m, ±5 m)';
  const LERC_URL  = 'https://cdn.jsdelivr.net/npm/lerc@3.0.0/LercDecode.min.js';
  const CANOPY_RES0 = 0.6826666666666666;
  const CANOPY_MAX_TILES = 48;
  const canopyTiles = new Map();          // 'z/r/c' → Int16Array(65536) | null
  let lercLoading = null;                 // Promise<boolean>

  let overrides = null;                   // code → metres, the operator's table
  const cache = new Map();                // sig → result
  let seeded = null;                      // test seam: (lat[], lon[]) → cls[]

  function loadOverrides() {
    if (overrides) return overrides;
    overrides = {};
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
      for (const [k, v] of Object.entries(raw)) {
        if (CLASSES[k] && CLASSES[k].h != null && isFinite(v) && v >= 0) overrides[k] = Number(v);
      }
    } catch (_) {}
    return overrides;
  }

  function saveOverrides() {
    try { localStorage.setItem(STORE, JSON.stringify(overrides || {})); } catch (_) {}
  }

  // The height a class stands, after the operator's table.
  function heightOf(code) {
    const c = CLASSES[code];
    if (!c || c.h == null) return null;
    const o = loadOverrides();
    return o[code] != null ? o[code] : c.h;
  }

  // Whether a class is something that stands above the ground the antenna is
  // on — the only kind the terminal-clutter term applies to. Open ground's
  // "height gain" is already inside the propagation model's effective heights.
  function standsUp(code) {
    return code === 2 || code === 4 || code === 5 || code === 7;
  }

  // A canopy reading on a crop or rangeland pixel is believed only from this
  // height up. Over paddocks the canopy map is not quiet: across 11,861 crop pixels in
  // eight Queensland farming districts (Jimbour, Dalby, Pittsworth, Lockyer,
  // Bundaberg, Burdekin, Emerald, checked 2026-11-05) it read 1 m or more on
  // three in four and 3–8 m on two in five, and the satellite photos under a
  // sample of the 4–7 m readings were bare, ploughed or planted ground seven
  // times out of eight. A ploughed paddock at Jimbour read 4–8 m end to end.
  // At 10 m and up the readings were real trees — a creek line, a road's tree
  // line, a paddock tree — five times in eight. Rangeland (grazing country,
  // checked the same day at Jimbour, Pittsworth, Lockyer, Bundaberg, Roma and
  // Warwick) is the same: under its 1–9 m readings the photos showed open
  // grass, a road verge, a sports oval — something that tall only 2 times in
  // 16 — and at 10 m and up a tree about five times in eight. So under 10 m a
  // crop or rangeland pixel stands at its class figure, and from 10 m it is a
  // tree and is drawn as one. (Built area was checked too and is left as it
  // is: its 15 m+ readings were a town's real trees seven times in eight.)
  const TREE_MIN = 10;

  // Whether the canopy map has found a tree standing in a pixel the class map
  // calls a field or a pasture — a creek's gums through a paddock, a shelter
  // belt — tall enough to be believed over the class.
  function treeIn(code, ch) {
    return (code === 5 || code === 11) && ch != null && ch >= TREE_MIN;
  }

  // Heights for a whole class array; null where the class is unknown. With a
  // canopy array alongside, a measured canopy of a metre or more replaces the
  // class figure on trees and flooded vegetation — the map has looked, the
  // table has guessed — and on crops and rangeland only from TREE_MIN up,
  // since under that the canopy map is reading a paddock's noise. A
  // built pixel keeps the larger of the two, since a canopy map does not see
  // roofs.
  function heights(cls, canopy) {
    return cls.map((c, i) => {
      if (c == null) return null;
      const h = heightOf(c);
      const ch = canopy && canopy[i] != null && canopy[i] >= 1 ? canopy[i] : null;
      if (ch == null) return h;
      if (c === 7) return h == null ? ch : Math.max(h, ch);
      if (c === 1 || c === 8 || c === 9) return h;        // water, bare, snow: a canopy there is noise
      if (c === 5 || c === 11) return treeIn(c, ch) ? ch : h;   // a tree, or the field's own height
      return ch;
    });
  }

  // The classes as the profile names them: a crop or rangeland pixel where
  // the canopy map stands a tree (treeIn) is called Trees, so the band, the
  // legend and the cursor say "16 m trees" over a creek's gums and not
  // "16 m crops". The class map's own answer is kept beside it as clsMap.
  function named(cls, canopy) {
    if (!canopy) return cls;
    return cls.map((c, i) => (treeIn(c, canopy[i]) ? 2 : c));
  }

  // The canopy readings that are trees, for something that wants the trees
  // themselves rather than a profile's surface — the relocation finder's open
  // sky and clear ground. A field or pasture's reading under TREE_MIN is
  // nothing (0); every other reading stands as the map gave it, and so does
  // every reading where the class is unknown, which is the most this can do
  // without a class.
  function believed(cls, canopy) {
    if (!canopy) return canopy;
    return canopy.map((h, i) => {
      const c = cls ? cls[i] : null;
      return h != null && (c === 5 || c === 11) && h < TREE_MIN ? 0 : h;
    });
  }

  // ── canopy tiles ──

  // Esri's LERC decoder, fetched once and only when first asked for. Resolves
  // false — never rejects — when it cannot be had, and the class table stands
  // in for every tree.
  function loadLerc() {
    if (typeof Lerc !== 'undefined' && Lerc.decode) return Promise.resolve(true);
    if (lercLoading) return lercLoading;
    if (typeof document === 'undefined') return Promise.resolve(false);
    lercLoading = new Promise(resolve => {
      const el = document.createElement('script');
      el.src = LERC_URL;
      el.async = true;
      el.crossOrigin = 'anonymous';
      const done = ok => { resolve(ok && typeof Lerc !== 'undefined' && !!Lerc.decode); };
      el.onload = () => done(true);
      el.onerror = () => done(false);
      document.head.appendChild(el);
      setTimeout(() => done(false), FETCH_MS);
    }).then(ok => { if (!ok) lercLoading = null; return ok; });
    return lercLoading;
  }

  function canopyLevel(spanKm) { return spanKm > 30 ? 11 : 13; }

  function canopyTile(z, row, col) {
    const key = `${z}/${row}/${col}`;
    if (canopyTiles.has(key)) return Promise.resolve(canopyTiles.get(key));
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), FETCH_MS);
    const p = fetch(`${CANOPY}/tile/${z}/${row}/${col}`, { signal: ctl ? ctl.signal : undefined })
      .then(r => (r.ok ? r.arrayBuffer() : null))
      .then(buf => {
        if (!buf) return null;
        const d = Lerc.decode(buf);
        if (!d || !d.pixels || !d.pixels[0]) return null;
        const px = d.pixels[0];
        // A masked pixel (water, no data) is null, not 0 — 0 is "no trees".
        const out = new Int16Array(px.length);
        for (let i = 0; i < px.length; i++) out[i] = d.mask && !d.mask[i] ? -1 : px[i];
        return out;
      })
      .catch(() => null)
      .finally(() => clearTimeout(timer));
    return p.then(t => {
      canopyTiles.set(key, t);
      while (canopyTiles.size > CANOPY_MAX_TILES) canopyTiles.delete(canopyTiles.keys().next().value);
      return t;
    });
  }

  // Canopy height at each sample, or null per sample; null overall when the
  // layer could not be used at all.
  async function canopy(lat, lon, spanKm) {
    if (typeof fetch !== 'function') return null;
    if (!(await loadLerc())) return null;
    const z = canopyLevel(spanKm);
    const res = CANOPY_RES0 / Math.pow(2, z);
    const need = new Map();
    const at = lat.map((la, i) => {
      const fx = (lon[i] + 180) / res, fy = (84 - la) / res;
      const col = Math.floor(fx / 256), row = Math.floor(fy / 256);
      const key = `${z}/${row}/${col}`;
      if (!need.has(key)) need.set(key, [row, col]);
      return { key, px: Math.floor(fx) % 256, py: Math.floor(fy) % 256 };
    });
    if (need.size > CANOPY_MAX_TILES) return null;
    const got = await Promise.all([...need.entries()].map(([key, [row, col]]) => canopyTile(z, row, col).then(t => [key, t])));
    const tiles = Object.fromEntries(got);
    let any = false;
    const out = at.map(a => {
      const t = tiles[a.key];
      if (!t) return null;
      const v = t[a.py * 256 + a.px];
      if (v < 0) return null;
      any = true;
      return v;
    });
    return any ? out : null;
  }

  // The CSS token the chart paints a class with. Tokens live in styles.css in
  // both themes, so the band follows the theme like every other colour does.
  function colourVar(code) {
    const c = CLASSES[code];
    return c ? `var(--cover-${c.key})` : 'var(--muted)';
  }

  // The most recent complete calendar year's map, then the one before it if
  // that answers nothing — a new year's map is published some months in.
  function candidateYears() {
    const y = new Date().getUTCFullYear() - 1;
    return [y, y - 1, y - 2];
  }

  function timeParam(year) { return String(Date.UTC(year, 0, 1)); }

  // One batch of points → class codes in the same order, or null per point.
  function fetchBatch(lat, lon, year) {
    const body = new URLSearchParams();
    body.set('f', 'json');
    body.set('geometryType', 'esriGeometryMultipoint');
    body.set('geometry', JSON.stringify({
      points: lat.map((la, i) => [Number(lon[i].toFixed(6)), Number(la.toFixed(6))]),
      spatialReference: { wkid: 4326 },
    }));
    body.set('returnFirstValueOnly', 'true');
    body.set('interpolation', 'RSP_NearestNeighbor');
    body.set('time', timeParam(year));
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), FETCH_MS);
    return fetch(`${SERVICE}/getSamples`, { method: 'POST', body, signal: ctl ? ctl.signal : undefined })
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!j || !Array.isArray(j.samples)) return null;
        const out = new Array(lat.length).fill(null);
        for (const s of j.samples) {
          const i = s.locationId;
          const v = s.value;
          if (i == null || i < 0 || i >= out.length) continue;
          const code = v === 'NoData' || v == null ? null : Number(v);
          out[i] = isFinite(code) && CLASSES[code] ? code : null;
        }
        return out;
      })
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }

  // The class map over a whole patch in ONE request — exportImage of the box
  // round the points, raw class codes at the map's own 10 m (Web Mercator, the
  // service's grid), LERC-compressed — read at each point's pixel. For a
  // lattice of thousands of points, where getSamples would be one request per
  // 256: the relocation finder's 4 km square is ~170,000 points and ~18 KB
  // here. Checked against getSamples on 256 points of a Jimbour path: the
  // same class at 255, the other on a class boundary. null per point where
  // the map has no pixel; null overall when the request fails.
  const GRID_MAX = 4000;                  // the service's maxImageWidth/Height
  function mercX(lo) { return lo * Math.PI / 180 * 6378137; }
  function mercY(la) { return Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360)) * 6378137; }
  function fetchGrid(lat, lon, year) {
    const xs = lon.map(mercX), ys = lat.map(mercY);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] < x0) x0 = xs[i]; if (xs[i] > x1) x1 = xs[i];
      if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i];
    }
    x0 -= 20; y0 -= 20; x1 += 20; y1 += 20;
    const res = Math.max(10, (x1 - x0) / GRID_MAX, (y1 - y0) / GRID_MAX);
    const W = Math.ceil((x1 - x0) / res), H = Math.ceil((y1 - y0) / res);
    const top = y0 + H * res;
    const q = new URLSearchParams({
      bbox: [x0, y0, x0 + W * res, top].join(','), bboxSR: '3857', imageSR: '3857', size: `${W},${H}`,
      format: 'lerc', pixelType: 'U8', interpolation: 'RSP_NearestNeighbor', time: timeParam(year),
      renderingRule: JSON.stringify({ rasterFunction: 'None' }), f: 'image',
    });
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), FETCH_MS);
    return fetch(`${SERVICE}/exportImage?${q}`, { signal: ctl ? ctl.signal : undefined })
      .then(r => (r.ok ? r.arrayBuffer() : null))
      .then(buf => {
        if (!buf) return null;
        const d = Lerc.decode(buf);
        if (!d || !d.pixels || !d.pixels[0] || d.width !== W || d.height !== H) return null;
        const px = d.pixels[0];
        return xs.map((x, i) => {
          const c = Math.min(W - 1, Math.floor((x - x0) / res)), r = Math.min(H - 1, Math.floor((top - ys[i]) / res));
          const n = r * W + c;
          if (d.mask && !d.mask[n]) return null;
          return CLASSES[px[n]] ? px[n] : null;
        });
      })
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }

  // Rough length of the path, for picking the canopy tile level.
  function spanOf(lat, lon) {
    const n = lat.length - 1;
    const dLat = (lat[n] - lat[0]) * 111.2;
    const dLon = (lon[n] - lon[0]) * 111.2 * Math.cos((lat[0] + lat[n]) / 2 * Math.PI / 180);
    return Math.hypot(dLat, dLon);
  }

  function sigOf(lat, lon) {
    const n = lat.length;
    return `${n}:${lat[0].toFixed(5)},${lon[0].toFixed(5)}:${lat[n - 1].toFixed(5)},${lon[n - 1].toFixed(5)}`;
  }

  function remember(sig, res) {
    cache.set(sig, res);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function sampleYear(lat, lon, year) {
    const parts = [];
    for (let i = 0; i < lat.length; i += BATCH) {
      parts.push(fetchBatch(lat.slice(i, i + BATCH), lon.slice(i, i + BATCH), year));
    }
    const got = await Promise.all(parts);
    if (got.some(g => g == null)) return null;          // a batch failed outright
    return got.flat();
  }

  return {
    CLASSES, attribution: ATTRIB, canopyAttribution: CANOPY_ATTRIB, TREE_MIN,
    heightOf, heights, named, believed, colourVar, standsUp,

    // Every class's current height, for the editable table.
    table() {
      return Object.entries(CLASSES).map(([code, c]) => ({
        code: Number(code), key: c.key, label: c.label, note: c.note,
        h: heightOf(Number(code)), def: c.h, edited: loadOverrides()[code] != null,
      }));
    },

    // Set (or, with null/'' , reset) one class's height.
    setHeight(code, v) {
      const c = CLASSES[code];
      if (!c || c.h == null) return;
      loadOverrides();
      const n = v == null || String(v).trim() === '' ? null : Number(v);
      if (n != null && isFinite(n) && n >= 0) overrides[code] = n; else delete overrides[code];
      saveOverrides();
    },

    resetHeights() { overrides = {}; saveOverrides(); },

    // Class code at each of a path's sample points. Same sample points the
    // terrain profile used, so cover and ground line up by index.
    async sample(lat, lon) {
      if (!lat || !lon || lat.length < 2 || lat.length !== lon.length) {
        return { ok: false, error: 'A path needs at least two sample points.' };
      }
      const sig = sigOf(lat, lon);
      if (cache.has(sig)) return cache.get(sig);
      let res;
      if (seeded) {
        const got = seeded(lat, lon);
        const cls = Array.isArray(got) ? got : got.cls;
        const can = Array.isArray(got) ? null : got.canopy || null;
        res = { ok: true, cls, canopy: can, canopyOk: !!can, year: 'seeded', resolution_m: 10, attribution: ATTRIB,
                missing: cls.filter(c => c == null).length, partial: cls.some(c => c == null) };
      } else if (typeof fetch !== 'function') {
        res = { ok: false, error: 'This browser cannot fetch the land-cover service.' };
      } else {
        res = { ok: false, error: 'Land cover could not be fetched — offline, blocked, or the service is unavailable.' };
        // The canopy is asked for alongside the classes, not after them: the
        // two are independent services and a profile is waiting on both.
        const spanKm = spanOf(lat, lon);
        const canopyP = canopy(lat, lon, spanKm).catch(() => null);
        for (const year of candidateYears()) {
          const cls = await sampleYear(lat, lon, year);
          if (!cls) break;                                   // the service is not answering; stop asking
          const missing = cls.filter(c => c == null).length;
          if (missing === cls.length) continue;              // no map for that year yet — try the one before
          res = { ok: true, cls, year, resolution_m: 10, attribution: ATTRIB, missing, partial: missing > 0 };
          break;
        }
        const can = await canopyP;
        if (res.ok) { res.canopy = can; res.canopyOk = !!can; }
      }
      if (res.ok && res.canopy) { res.clsMap = res.cls; res.cls = named(res.cls, res.canopy); }
      if (res.ok) remember(sig, res);
      return res;
    },

    // The canopy height alone, at each of any set of points — a lattice over a
    // patch of ground rather than the samples of a path — read off the canopy
    // tiles at their finest level and never off the class service, so ten
    // thousand points cost the handful of tiles under them and no request
    // each. The station relocation finder (map-relocate.js) reads the trees
    // round a candidate this way. Resolves — never rejects — to an array of
    // metres (null where the map has no pixel), or null when the canopy
    // cannot be had at all; a seeded sampler answers with its `canopy`.
    async canopyAt(lat, lon) {
      if (!lat || !lon || !lat.length || lat.length !== lon.length) return null;
      if (seeded) {
        const got = seeded(lat, lon);
        return got && !Array.isArray(got) && Array.isArray(got.canopy) ? got.canopy : null;
      }
      return canopy(lat, lon, 0).catch(() => null);
    },

    // The class at each of any set of points, from one picture of the class
    // map over their box (fetchGrid) rather than a sample per point — for a
    // lattice, beside canopyAt, so believed() can tell a paddock's noise from
    // a tree. Resolves — never rejects — to { ok:true, cls[], year } or
    // { ok:false, error }; a seeded sampler answers with its classes.
    async classAt(lat, lon) {
      if (!lat || !lon || !lat.length || lat.length !== lon.length) return { ok: false, error: 'No points to look at.' };
      if (seeded) {
        const got = seeded(lat, lon);
        return { ok: true, cls: Array.isArray(got) ? got : got.cls, year: 'seeded' };
      }
      const fail = { ok: false, error: 'Land cover could not be fetched — offline, blocked, or the service is unavailable.' };
      if (typeof fetch !== 'function' || !(await loadLerc())) return fail;
      for (const year of candidateYears()) {
        const cls = await fetchGrid(lat, lon, year).catch(() => null);
        if (!cls) return fail;                               // the service is not answering; stop asking
        if (cls.every(c => c == null)) continue;             // no map for that year yet — try the one before
        return { ok: true, cls, year };
      }
      return fail;
    },

    // Tests cannot reach the service; they hand in a sampler that answers
    // from a fixture, the way MapRivers.seed() hands in ways.
    seed(fn) { seeded = typeof fn === 'function' ? fn : null; cache.clear(); },

    cached() { return cache.size + canopyTiles.size; },
    clear() { cache.clear(); canopyTiles.clear(); },
  };
})();
if (typeof window !== 'undefined') window.LandCover = LandCover;
