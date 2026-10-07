// MegaNet — geoid.js
//
//   Geoid   how far the Australian Height Datum is above the EGM96 geoid at a
//           point: the number that puts a terrain-tile height (EGM96) into
//           AHD, the datum every gauge zero, flood level, bridge deck and
//           surveyed height in this app is in.
//
// After core.js; only declares, and nothing it holds is fetched until a caller
// asks (`npm run toplevel`). digital-twin.js asks when its ground has to come
// from the tiles, and puts that ground into AHD with the answer.
//
// ── Why it is needed ─────────────────────────────────────────────────────────
// The app had taken the tiles and AHD to "agree to about a metre over
// Australia". Measured at the 4,866 stations with a position they do not: a
// point's AHD height is its EGM96 height less 2.07 m (the Barossa) to plus
// 0.64 m (the upper Hunter) — less 0.61 m on average, less 0.34 m at Gatton,
// written AHD = EGM96 − 0.34 m in the twin. A flood level in AHD
// stood on a tile ground in EGM96 is that far wrong before the tiles' own
// error is counted — two metres is a class, at most gauges.
//
// ── The grid ─────────────────────────────────────────────────────────────────
// data/geoid-ahd-egm96.json, ~200 kB, made by tools/build_geoid_grid.py from
// the two models as PROJ publishes them: AUSGeoid2020 (GDA2020 → AHD,
// © Geoscience Australia, CC BY 4.0) and EGM96 (WGS 84 → EGM96, NGA). A height
// is the ellipsoidal height less the geoid's undulation, so
//
//     H(AHD) − H(EGM96) = N(EGM96) − N(AUSGeoid2020)
//
// every 0.1° from 9° S to 44° S and 112° E to 154° E, one byte a node to 2 cm.
// Bilinear between nodes is not the 1′ model, and the file's meta says what
// that costs, measured against the two models directly: 1.6 cm on average at
// the stations, 8.5 cm at the 99th percentile, 21 cm at the worst — well
// inside the tiles' own vertical error, which is all it is ever applied to.
// AUSGeoid2020 holds nothing over open ocean; past ~30 km offshore there is
// no value, and the answer says so rather than guessing (three island gauges).
//
// Fetched once a session, on the first ask, like sls.js's list.

const Geoid = (function () {
  const DATA_URL = 'data/geoid-ahd-egm96.json';
  const MODEL    = 'AUSGeoid2020 less EGM96';
  const ATTRIB   = 'AHD from EGM96: AUSGeoid2020 © Geoscience Australia (CC BY 4.0) and EGM96 (NGA), as PROJ publishes them';

  let grid = null;      // { lat0, lon0, step, rows, cols, scale, offset, nodata, bytes, meta }
  let loading = null;

  // The file's shape, checked and decoded; throws on anything else, so a
  // half-written file is a failure to read, not a grid of zeros.
  function decode(j) {
    const need = ['lat0', 'lon0', 'step', 'rows', 'cols', 'scale', 'offset', 'nodata'];
    if (!j || typeof j !== 'object' || need.some(k => !Number.isFinite(Number(j[k]))) || typeof j.data !== 'string') {
      throw new Error('the geoid grid is not in the shape expected');
    }
    const bin = atob(j.data);
    const rows = Number(j.rows), cols = Number(j.cols);
    if (bin.length !== rows * cols) throw new Error(`the geoid grid holds ${bin.length} nodes, not ${rows} × ${cols}`);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { lat0: Number(j.lat0), lon0: Number(j.lon0), step: Number(j.step), rows, cols,
             scale: Number(j.scale), offset: Number(j.offset), nodata: Number(j.nodata), bytes, meta: j.meta || null };
  }

  // AHD less EGM96 at a point, bilinear between the four nodes round it; null
  // off the grid or where a node has no value.
  function lookup(g, lat, lon) {
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const fy = (g.lat0 - lat) / g.step, fx = (lon - g.lon0) / g.step;
    const r = Math.floor(fy), c = Math.floor(fx);
    if (r < 0 || c < 0 || r > g.rows - 2 || c > g.cols - 2) return null;
    const ty = fy - r, tx = fx - c, b = g.bytes, C = g.cols;
    const q = [b[r * C + c], b[r * C + c + 1], b[(r + 1) * C + c], b[(r + 1) * C + c + 1]];
    if (q.some(v => v === g.nodata)) return null;
    const v = q.map(x => (x - g.offset) * g.scale);
    return v[0] * (1 - tx) * (1 - ty) + v[1] * tx * (1 - ty) + v[2] * (1 - tx) * ty + v[3] * tx * ty;
  }

  function ensure() {
    if (grid) return Promise.resolve(grid);
    if (loading) return loading;
    if (typeof fetch !== 'function') return Promise.reject(new Error('no network in this environment'));
    loading = fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { grid = decode(j); return grid; })
      .catch(e => { loading = null; throw e; });
    return loading;
  }

  return {
    MODEL,
    DATA_URL,
    attribution: ATTRIB,

    // AHD less EGM96 at a point, in metres. Resolves — never rejects — to
    //   { ok: true, m, model }   add m to an EGM96 height to have it in AHD
    //   { ok: false, error }     not read, or no value here
    at(lat, lon) {
      return ensure().then(g => {
        const m = lookup(g, lat, lon);
        return m == null
          ? { ok: false, error: 'AUSGeoid2020 holds no value this far out at sea, so the tiles\' EGM96 heights cannot be put into AHD here.' }
          : { ok: true, m, model: MODEL };
      }, err => ({ ok: false, error: `the geoid grid (${DATA_URL}) could not be read — ${(err && err.message) || err}` }));
    },

    // The same, at once, when the grid is already loaded; null otherwise.
    ahdLessEgm96(lat, lon) { return grid ? lookup(grid, lat, lon) : null; },

    ensure,
    loaded() { return !!grid; },
    meta() { return grid ? grid.meta : null; },

    // The check's seam: the grid from an object in the file's own shape
    // rather than fetched, or null to forget it and fetch again.
    seed(j) { grid = j ? decode(j) : null; loading = null; },
  };
})();
if (typeof window !== 'undefined') window.Geoid = Geoid;
