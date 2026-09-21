// MegaNet — elvis.js
//
//   Elvis   The ground height at one point from Geoscience Australia / ICSM's
//           Elvis platform: the best digital elevation model the nation holds
//           there, in AHD, with the dataset that answered named (#197).
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches nothing; callers reach it. map-here.js and the station card use it.
//
// ── Why this exists next to terrain.js rather than inside it ────────────────
//
// terrain.js's header sets out why every profile in this app is read off
// terrarium tiles and not an elevation API: "the API would be one rate-limited
// request per profile with nothing kept between them, and a handful of tiles
// already covers a whole VHF hop." That reasoning was checked against this
// service rather than assumed, and it holds:
//
//   • There is no batch call. One point is one request.
//   • One request measured 1.4–5.0 s, and 6.4 a second with 32 in flight.
//     A 256-sample profile is ~40 s of that, against one tile fetch for the
//     whole hop.
//   • Elvis's own elevation-profile tool does not use this data either — it
//     falls back to the same 30 m SRTM the terrarium tiles carry.
//
// So this is **not** a terrain source and must never become one on the quiet.
// It answers about a *point* a person has asked about, one at a time, and the
// sweeps in map-los.js and map-fade.js must never reach it.
//
// What it is worth having for is the thing the tiles cannot give:
//
//   • **AHD.** map-here.js's header says its ground height is "above the EGM96
//     geoid — not AHD, and not a survey", and that a station's own elevation
//     row is a surveyed AHD figure the two must never be confused with. This
//     returns AHD, which is the datum the rest of the app's heights are in.
//   • **Resolution, and which dataset.** Over settled Queensland the answer
//     comes off 1 m LiDAR; in the outback off 30 m SRTM. It says which, and
//     names the file, so a figure can be traced.
//
// ── The service ────────────────────────────────────────────────────────────
//
// Undocumented — the endpoint and its parameter names were read out of the
// Elvis front end and confirmed against the live service. Keyless, and
// `Access-Control-Allow-Origin: *`, so it works from a static page with no
// proxy and no secret, which is the constraint every source in this app is
// chosen under.
//
// Note the parameter is `long`, not `lon` or `longitude`: the other spellings
// return 502, not a 400, so a typo here looks like an outage.
//
// Three response shapes, all HTTP 200 and all seen live:
//
//   {"SOURCE":"QLD Government - …","DATASET":"Brisbane_2014_…_1m.tif",
//    "DEM RESOLUTION":"1m","HEIGHT AT LOCATION":"11.94m","METADATA URL":""}
//
//   …the same with "1 Second" and the national SRTM file, outside LiDAR cover;
//   …and every field the literal string "No Data" where it holds nothing.
//
// Heights arrive as strings with the unit stuck on ("11.94m"), so they are
// parsed rather than trusted, and a parse that fails is a failure rather than
// a NaN travelling on.
//
// Every failure is loud and every result resolves — terrain.js's rule, for its
// reason: a height that quietly goes missing is worse than one that says so.
const Elvis = (function () {
  const AT_POINT  = 'https://api-elevation.fsdf.org.au/elevation-at-point';
  const ATTRIB    = 'Elevation at a point: Elvis — Geoscience Australia / ICSM, AHD';
  // Measured 1.4–5.0 s. The ceiling is generous because the alternative to
  // waiting is a row that says nothing, but it is bounded because a network
  // that denies this host must not hold the card open (see docs/floodwarning-net.md
  // — the Bureau's filter default-denies hostnames it has never categorised).
  const FETCH_MS  = 12000;
  const CACHE_MAX = 240;
  // A just-failed point is not re-asked for this long. No retry loop: a denied
  // host would otherwise be re-tried on every pick, and this way it costs one
  // slow call a minute rather than one per click.
  const FAIL_TTL  = 60000;
  // Points closer together than this share an answer. ~1 m at these latitudes,
  // which is the finest the service itself resolves.
  const KEY_DP    = 6;

  const cache    = new Map();   // key → result object
  const failedAt = new Map();   // key → timestamp of last failure
  const inflight = new Map();   // key → Promise<result>
  let seeded = null;            // test seam: (lat, lon) → raw response object

  const keyOf = (lat, lon) => `${lat.toFixed(KEY_DP)},${lon.toFixed(KEY_DP)}`;

  function remember(k, v) {
    cache.delete(k);
    cache.set(k, v);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return v;
  }

  // "1m" → 1, "50cm" → 0.5, "2m" → 2, "1 Second" → ~30. The string is what the
  // card shows; this number is what lets a caller compare it with terrain.js's
  // own ~30 m without parsing prose at the call site.
  function resolutionMetres(s) {
    if (!s || typeof s !== 'string') return null;
    const t = s.trim().toLowerCase();
    if (t === 'no data') return null;
    // A second of arc of latitude is ~30.9 m; the service means the national
    // SRTM product, which everything else in this app calls ~30 m.
    if (t.includes('second')) return 30;
    const cm = t.match(/^([\d.]+)\s*cm$/);
    if (cm) return Number(cm[1]) / 100;
    const m = t.match(/^([\d.]+)\s*m$/);
    if (m) return Number(m[1]);
    return null;
  }

  // "11.94m" → 11.94. Returns null rather than NaN so a bad parse is a missing
  // answer and not a number that poisons arithmetic downstream.
  function heightMetres(s) {
    if (s == null) return null;
    const t = String(s).trim();
    if (!t || t.toLowerCase() === 'no data') return null;
    const m = t.match(/^(-?[\d.]+)\s*m?$/i);
    if (!m) return null;
    const n = Number(m[1]);
    return isFinite(n) ? n : null;
  }

  // The service names its source as "QLD Government - https://www.qld.gov.au/".
  // The card wants the agency, not the URL trailing it.
  function agencyOf(s) {
    if (!s || typeof s !== 'string') return null;
    const t = s.split(' - ')[0].trim();
    return t && t.toLowerCase() !== 'no data' ? t : null;
  }

  function shape(j) {
    const res    = j ? j['DEM RESOLUTION'] : null;
    const height = heightMetres(j ? j['HEIGHT AT LOCATION'] : null);
    if (height == null) {
      return { ok: false, noData: true,
               error: 'Elvis holds no elevation data for this point.' };
    }
    return {
      ok: true,
      height_m: height,
      // AHD, stated rather than implied: this is the one thing that makes the
      // figure comparable with a station's surveyed elevation_ahd, and the one
      // thing a terrarium height is not.
      datum: 'AHD',
      resolution: typeof res === 'string' && res.toLowerCase() !== 'no data' ? res : null,
      resolution_m: resolutionMetres(res),
      source: agencyOf(j.SOURCE),
      dataset: j.DATASET && j.DATASET !== 'No Data' ? j.DATASET : null,
      attribution: ATTRIB,
    };
  }

  function fetchPoint(lat, lon) {
    const ctl   = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), FETCH_MS);
    const url   = `${AT_POINT}?lat=${encodeURIComponent(lat)}&long=${encodeURIComponent(lon)}`;
    return fetch(url, { signal: ctl ? ctl.signal : undefined })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }

  return {
    attribution: ATTRIB,
    resolutionMetres,

    // The ground height at one point. Resolves — never rejects — to one of:
    //   { ok: false, error, noData? }
    //   { ok: true, height_m, datum: 'AHD', resolution, resolution_m, source, dataset }
    at(lat, lon) {
      if (!isFinite(lat) || !isFinite(lon)) {
        return Promise.resolve({ ok: false, error: 'Needs a latitude and a longitude.' });
      }
      const k = keyOf(lat, lon);
      if (cache.has(k)) return Promise.resolve(cache.get(k));
      if (inflight.has(k)) return inflight.get(k);

      const failed = failedAt.get(k);
      if (failed != null && Date.now() - failed < FAIL_TTL) {
        return Promise.resolve({ ok: false, error: 'Elvis could not be reached just now.' });
      }

      if (seeded) {
        return Promise.resolve(remember(k, shape(seeded(lat, lon))));
      }
      if (typeof fetch !== 'function') {
        return Promise.resolve({ ok: false, error: 'No network in this environment.' });
      }

      const p = fetchPoint(lat, lon).then(j => {
        inflight.delete(k);
        if (!j) {
          failedAt.set(k, Date.now());
          return { ok: false, error: 'Elvis could not be reached just now.' };
        }
        failedAt.delete(k);
        // A "No Data" answer is cached: it is the service's real answer about
        // that place, not a failure to reach it, and it will not change.
        return remember(k, shape(j));
      });
      inflight.set(k, p);
      return p;
    },

    cached() { return cache.size; },
    clear() { cache.clear(); failedAt.clear(); inflight.clear(); },

    // Test seam, on LandCover.seed()'s terms: (lat, lon) → a raw service
    // response object, so the parsing under test is the real parsing.
    seed(fn) { seeded = typeof fn === 'function' ? fn : null; cache.clear(); failedAt.clear(); },
  };
})();
if (typeof window !== 'undefined') window.Elvis = Elvis;
