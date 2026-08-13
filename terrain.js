// MegaNet — terrain.js
//
//   Terrain   ground height along a line, decoded in the browser from
//             terrarium-encoded PNG tiles. What the elevation profile and the
//             link budget are both built on.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for bearingDeg, destPoint and acmaHaversineKm, and
// nowhere else in the app. Those three are among the six helpers #129 found
// misfiled and M1 moved into core.js for exactly this case: each was defined
// inside one feature and read by five to seven others, so leaving them where
// they were would have made this file depend on another tab module. The IIFE
// body sets tunables and three empty caches, so its position among the modules
// is free.
//
// Moved out of app.js byte-for-byte by M2 (#133) of #129.

// ── Terrain elevation ────────────────────────────────────────────────────────
// Ground height along a line — what both the elevation profile and the link
// budget are built on. MegaNet is a static page: there is no backend to ask and
// no key can live in the repo, so elevation comes from open terrarium-encoded
// PNG tiles, decoded in a canvas here in the browser.
//
// AWS Terrain Tiles (elevation-tiles-prod) is the source: open data, no key,
// `Access-Control-Allow-Origin: *`, and ~30 m SRTM over Australia. It rides the
// same XYZ scheme Leaflet already fetches base maps on (see makeBaseLayers), so
// the lat/lon → tile maths is the standard Web Mercator pair and nothing more.
//
//   elevation_m = (R * 256 + G + B / 256) - 32768
//
// Tiles are cached decoded, so a second profile over the same country costs no
// network at all. That is the reason for tiles over an elevation API: the API
// would be one rate-limited request per profile with nothing kept between them,
// and a handful of tiles already covers a whole VHF hop.
//
// DATUM — terrarium heights are above the EGM96 geoid; a station's
// `elevation_ahd` is Australian Height Datum. Over Australia the two agree to
// about a metre, well inside the ~30 m sampling error, but they are not the
// same datum and neither one is ellipsoidal height. So where a station's own
// elevation_ahd exists it wins for that *endpoint*, and tiles only ever supply
// the ground *between* the ends. Everything drawn from this says so on screen.
//
// Every failure here is loud. A caller that cannot get terrain has to say so:
// a flat profile reads as a clear path, which is the one wrong answer that
// actually costs someone a site visit.

const Terrain = (function () {
  const TILE_URL  = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const TILE_PX   = 256;
  // The source is ~30 m SRTM. Past z12 (~33 m/px at Queensland latitudes) the
  // tiles are resampling their own pixels — four times the tiles for no more
  // terrain.
  const MAX_ZOOM  = 12;
  const MIN_ZOOM  = 7;
  const MAX_TILES = 48;      // per profile; the zoom drops until the path fits
  const CACHE_MAX = 128;     // × 128 KB decoded ≈ 16 MB — the bound on a long session
  const FETCH_MS  = 12000;   // a tile that hasn't arrived by now has failed
  const FAIL_TTL  = 60000;   // how long a failed tile is remembered before a retry

  // Decoded tiles, oldest first: a Map iterates in insertion order, so re-inserting
  // on read is the whole of the LRU.
  const cache    = new Map();   // 'z/x/y' → Int16Array(65536) of metres
  const failedAt = new Map();   // 'z/x/y' → timestamp of the last failure
  const inflight = new Map();   // 'z/x/y' → Promise<Int16Array|null>
  let canvas = null;

  const ATTRIB = 'Elevation: AWS Terrain Tiles (SRTM/GMTED, ~30 m), height above the EGM96 geoid';

  // ── Web Mercator ──
  // Fractional tile coordinates: the integer part is the tile, the fraction
  // times 256 is the pixel inside it.
  function tileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }

  function tileY(lat, z) {
    const r = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }

  // Ground distance one tile pixel covers, which is what picks the zoom.
  function metresPerPixel(lat, z) {
    return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
  }

  // ── tiles ──

  function sharedCanvas() {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = TILE_PX;
    }
    return canvas;
  }

  // RGB → metres, once per tile, into an Int16Array. Holding the raw RGBA
  // instead would be 256 KB a tile; metre resolution is far finer than the
  // ~30 m the source actually resolves, and it halves the cache.
  function decode(img) {
    const cv = sharedCanvas();
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.clearRect(0, 0, TILE_PX, TILE_PX);
    cx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
    // Throws if the image tainted the canvas — i.e. the CORS headers went away.
    // That is a failure like any other, and the caller turns it into one.
    const d = cx.getImageData(0, 0, TILE_PX, TILE_PX).data;
    const out = new Int16Array(TILE_PX * TILE_PX);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      out[i] = Math.round(d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768);
    }
    return out;
  }

  function remember(key, px) {
    cache.set(key, px);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  // Resolves to the decoded tile, or to null for every kind of failure there is
  // — offline, blocked, rate-limited, 404 over the ocean, CORS withdrawn. It
  // never rejects: one missing tile is a gap in a profile, not a dead panel.
  function loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (cache.has(key)) {
      const px = cache.get(key);
      cache.delete(key); cache.set(key, px);        // most recently used
      return Promise.resolve(px);
    }
    if (inflight.has(key)) return inflight.get(key);
    // A tile that just failed is not retried on every mouse-driven re-profile;
    // after the TTL it gets another chance, so a dropped connection heals.
    const fa = failedAt.get(key);
    if (fa != null && Date.now() - fa < FAIL_TTL) return Promise.resolve(null);

    const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const p = new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';               // required before getImageData
      let settled = false;
      const finish = v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), FETCH_MS);
      img.onload  = () => { try { finish(decode(img)); } catch (_) { finish(null); } };
      img.onerror = () => finish(null);
      img.src = url;
    }).then(px => {
      inflight.delete(key);
      if (px) { failedAt.delete(key); remember(key, px); }
      else    { failedAt.set(key, Date.now()); }
      return px;
    });
    inflight.set(key, p);
    return p;
  }

  // Nearest pixel, deliberately: interpolating between samples of a ~30 m grid
  // invents detail the source does not have, and across a tile edge it would
  // need the neighbour fetched as well.
  function readTile(px, fx, fy, tx, ty) {
    const ix = Math.min(TILE_PX - 1, Math.max(0, Math.floor((fx - tx) * TILE_PX)));
    const iy = Math.min(TILE_PX - 1, Math.max(0, Math.floor((fy - ty) * TILE_PX)));
    return px[iy * TILE_PX + ix];
  }

  // ── path sampling ──

  // n points evenly spaced by distance along the polyline, each carried back as
  // a real lat/lon so the caller can name and re-use them. Great-circle within
  // each leg, via the geodesy the map already uses.
  function walk(pts, n) {
    const legs = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const km = acmaHaversineKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      legs.push({ from: pts[i - 1], to: pts[i], km, at: total,
                  brg: bearingDeg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) });
      total += km;
    }
    const out = [];
    let leg = 0;
    for (let i = 0; i < n; i++) {
      const km = total * i / (n - 1);
      while (leg < legs.length - 1 && km > legs[leg].at + legs[leg].km) leg++;
      const L = legs[leg];
      // The ends are the vertices themselves, not a destPoint approximation of
      // them — a snapped endpoint has to stay exactly on its station.
      const ll = i === 0 ? pts[0]
               : i === n - 1 ? pts[pts.length - 1]
               : destPoint(L.from[0], L.from[1], L.brg, Math.max(0, km - L.at));
      out.push({ km, lat: ll[0], lon: ll[1] });
    }
    return { samples: out, totalKm: total };
  }

  // The coarsest zoom whose pixels are still finer than the gap between
  // samples, then backed off further if the path won't fit in the tile budget.
  //
  // Going coarser than the sample spacing is the expensive mistake: adjacent
  // samples start landing on the same pixel and a ridge narrower than a pixel
  // simply stops existing — and a ridge that stops existing is a path that
  // reports clear. Going finer only costs tiles. So: fine enough that no sample
  // is wasted, and no finer. A 5 km hop lands on z12, a 120 km hop on z9.
  function pickZoom(samples, totalKm, n) {
    const midLat = samples[Math.floor(samples.length / 2)].lat;
    const spacing = Math.max(1, totalKm * 1000 / Math.max(1, n - 1));
    let z = MIN_ZOOM;
    while (z < MAX_ZOOM && metresPerPixel(midLat, z) > spacing) z++;
    let capped = false;
    for (;;) {
      const keys = new Set();
      for (const s of samples) keys.add(`${Math.floor(tileX(s.lon, z))}/${Math.floor(tileY(s.lat, z))}`);
      if (keys.size <= MAX_TILES || z <= MIN_ZOOM) return { z, tiles: keys.size, capped };
      z--; capped = true;
    }
  }

  return {
    // Ground height at one point, or null if the tile for it can't be had.
    sample(lat, lon, zoom) {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom || MAX_ZOOM));
      const fx = tileX(lon, z), fy = tileY(lat, z);
      const tx = Math.floor(fx), ty = Math.floor(fy);
      return loadTile(z, tx, ty).then(px => (px ? readTile(px, fx, fy, tx, ty) : null));
    },

    // n evenly-spaced ground samples along a polyline.
    //
    // Resolves — never rejects — to one of two shapes, so a caller has to look
    // at `ok` before it can draw anything:
    //   { ok: false, error }                      nothing usable; say so
    //   { ok: true, distance_m[], terrain_m[], …} terrain_m holds null wherever
    //                                             a tile was missing, and
    //                                             `partial` says it happened
    profile(pts, n) {
      const count = Math.max(2, Math.min(1024, n || 256));
      if (!pts || pts.length < 2) {
        return Promise.resolve({ ok: false, error: 'A path needs at least two points.' });
      }
      const { samples, totalKm } = walk(pts, count);
      if (!(totalKm > 0)) {
        return Promise.resolve({ ok: false, error: 'The two ends are in the same place.' });
      }
      const { z, tiles, capped } = pickZoom(samples, totalKm, count);

      const need = new Map();
      for (const s of samples) {
        s.fx = tileX(s.lon, z); s.fy = tileY(s.lat, z);
        s.tx = Math.floor(s.fx); s.ty = Math.floor(s.fy);
        need.set(`${s.tx}/${s.ty}`, [s.tx, s.ty]);
      }
      const keys = [...need.keys()];
      return Promise.all([...need.values()].map(([x, y]) => loadTile(z, x, y))).then(got => {
        const byKey = {};
        keys.forEach((k, i) => { byKey[k] = got[i]; });
        const distance_m = [], terrain_m = [], lat = [], lon = [];
        let missing = 0;
        for (const s of samples) {
          const px = byKey[`${s.tx}/${s.ty}`];
          distance_m.push(s.km * 1000);
          lat.push(s.lat); lon.push(s.lon);
          if (px) terrain_m.push(readTile(px, s.fx, s.fy, s.tx, s.ty));
          else { terrain_m.push(null); missing++; }
        }
        if (missing === samples.length) {
          return { ok: false,
                   error: 'Terrain tiles could not be fetched — offline, blocked, or the tile service is unavailable.' };
        }
        return { ok: true, distance_m, terrain_m, lat, lon,
                 totalKm, zoom: z, tiles, capped, missing, partial: missing > 0,
                 resolution_m: Math.round(metresPerPixel(samples[Math.floor(samples.length / 2)].lat, z)),
                 attribution: ATTRIB };
      });
    },

    attribution: ATTRIB,
    maxTiles: MAX_TILES,
    // For the panel footer: how much of a session's terrain is already in hand.
    cached() { return cache.size; },
    // MemMeter's Release button. Costs a re-fetch of whatever profile is drawn
    // next — nothing currently on screen depends on the cache staying warm.
    clear() { cache.clear(); failedAt.clear(); },
  };
})();

