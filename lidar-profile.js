// MegaNet — lidar-profile.js
//
//   LidarProfile   the ground under a radio path where it decides the answer,
//                  read off Geoscience Australia's 5 m LiDAR-derived DEM and
//                  spliced into the ~30 m terrain profile everywhere else.
//
// After terrain.js and path-profile.js; before init.js — index.html holds the
// order. Nothing here runs at load. Reaches back to core.js for
// acmaHaversineKm, and to path-profile.js for fresnelR1, earthBulge and
// kFactorFor (each looked up when called, with a plain fallback, so a bare VM
// can load this file on its own). Callers: pathGround() in path-profile.js,
// which is the one place a path's ground is decided.
//
// ── Why only where it matters ────────────────────────────────────────────────
// A radio path is decided in a few places, not along its whole length: at the
// two ends, where an antenna a few metres up either clears the edge of its own
// hilltop or does not, and at whatever ridges come near the line of sight.
// Everywhere else the ground is tens or hundreds of metres below the line and
// a better DEM changes nothing. The ~30 m tiles are worst exactly where it
// matters — a summit is a handful of their pixels, and in a forest they carry
// part of the canopy, so a forested crest stands metres taller than the ground
// — and the 5 m LiDAR grid is best there.
//
// So a path gets LiDAR:
//   • within END_M of each end — the station's own ground and its horizon;
//   • round every obstacle: wherever the 30 m ground comes within NEAR_M of
//     the line of sight, or inside the first Fresnel zone if that is wider —
//     the strongest MAX_OBST of them, PAD_M either side, a broad crest whole
//     up to SPAN_MAX_M;
// and the ~30 m tiles everywhere else. The whole path in LiDAR was weighed and
// is not done: it is the same answer for many times the requests — a 40 km
// path crosses thirty-odd 1 km grid tiles, where its ends and obstacles touch
// a handful — and the requests are somebody else's service.
//
// ── The service ──────────────────────────────────────────────────────────────
// GA's WCS for the national 5 m LiDAR grid — the one map-elevation.js draws
// its overlay from, with the measurements in its header: GetCoverage answers
// a float32 GeoTIFF in 1.5–3 s, reflects any Origin in
// Access-Control-Allow-Origin, wants CRS=EPSG:4283 (GDA94 — under 2 m from
// WGS84, inside one cell), marks "no survey here" with exactly 0.0 or an
// internal tile never written, and answers a box wholly outside its extent
// with a 404. Heights are AHD.
//
// The grid is asked for in fixed tiles of TILE_DEG on a side, keyed by their
// corner, not in boxes cut to each path: a hub's ground and a ridge many paths
// cross are then fetched once and shared by every path that needs them — which
// is what makes a matrix of a few hundred links, or a sweep, affordable.
//
// ── The splice ───────────────────────────────────────────────────────────────
// The refined profile is the ~30 m profile at STEP_M spacing (the LiDAR's own),
// with the LiDAR height substituted inside each zone and blended over BLEND_M
// at a zone's inner edges, so no cliff is invented where the two sources
// disagree — and they do disagree, by design: the tiles are a surface and the
// LiDAR is bare ground, so in a forest the LiDAR is the lower. That is the
// point at an obstacle (a VHF signal passes through foliage it would not
// through rock), and harmless at a zone's edge, which is by construction where
// the ground is well clear of the line. A sample the LiDAR does not cover
// keeps its 30 m height, and the report says how much did.
//
// Every failure is loud and every call resolves (terrain.js's rule): a tile the
// service will not give leaves that stretch on 30 m and is counted, a host the
// network denies trips a breaker after TRIP_AFTER failures, and the caller is
// told what share of the zones it asked for came back.
const LidarProfile = (function () {
  const WCS = 'https://services.ga.gov.au/gis/services/DEM_LiDAR_5m_2025/MapServer/WCSServer';
  const ATTRIB = 'Ground at the ends and the obstacles: Geoscience Australia 5 m LiDAR-derived DEM (Elvis, AHD); '
               + '~30 m terrain tiles between';
  const EXTENT = [114.0985, -43.4628, 153.6775, -9.8660];   // W, S, E, N — the coverage's envelope
  const CELL_M     = 5;       // the grid's own spacing
  const STEP_M     = 5;       // the refined profile's spacing
  const END_M      = 500;     // LiDAR this far round each end
  const PAD_M      = 150;     // and this far either side of an obstacle
  const NEAR_M     = 30;      // an obstacle: ground within this of the sight line …
  const MAX_OBST   = 6;       // … the strongest this many
  const SPAN_MAX_M = 1500;    // a broad crest is taken whole up to this
  const BLEND_M    = 25;      // where LiDAR meets tiles inside a path
  const TILE_DEG   = 0.01;    // the grid is fetched in tiles this size (~1 km)
  const MAX_SAMPLES = 40000;  // a 200 km path at STEP_M
  const IN_FLIGHT  = 6;       // map-elevation.js measured twelve answering cleanly
  const FETCH_MS   = 20000;
  const CACHE_MAX  = 160;     // decoded tiles, ~180 KB each
  const TRIP_AFTER = 3;       // failures in a row before the breaker trips …
  const TRIP_MS    = 60000;   // … and how long it stays tripped

  const cache = new Map();     // tile key → { grid } | { none: true }
  const inflight = new Map();  // tile key → Promise
  const queue = [];
  let running = 0, fails = 0, trippedAt = 0;
  let seeded = null;           // test seam: (tile) → { W, H, data } | null
  const stats = { asked: 0, fetched: 0, cached: 0, failed: 0 };

  const tripped = () => trippedAt && Date.now() - trippedAt < TRIP_MS;
  const helper = (name, fallback) => (typeof globalThis[name] === 'function' ? globalThis[name] : fallback);

  // ── the tiles ──
  function tileOf(lat, lon) {
    const ix = Math.floor(lon / TILE_DEG), iy = Math.floor(lat / TILE_DEG);
    const w = ix * TILE_DEG, s = iy * TILE_DEG, e = w + TILE_DEG, n = s + TILE_DEG;
    const midLat = (s + n) / 2;
    const W = Math.max(8, Math.round(TILE_DEG * 111320 * Math.cos(midLat * Math.PI / 180) / CELL_M));
    const H = Math.max(8, Math.round(TILE_DEG * 110574 / CELL_M));
    return { key: `${ix}/${iy}`, w, s, e, n, W, H };
  }
  const inExtent = t => !(t.e < EXTENT[0] || t.w > EXTENT[2] || t.n < EXTENT[1] || t.s > EXTENT[3]);

  function urlOf(t) {
    return `${WCS}?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=1&CRS=EPSG:4283`
         + `&BBOX=${[t.w, t.s, t.e, t.n].map(v => v.toFixed(6)).join(',')}`
         + `&WIDTH=${t.W}&HEIGHT=${t.H}&FORMAT=GeoTIFF`;
  }

  function remember(key, v) {
    cache.delete(key);
    cache.set(key, v);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return v;
  }

  function pump() {
    while (running < IN_FLIGHT && queue.length) {
      const job = queue.shift();
      running++;
      job.run().then(job.resolve, () => job.resolve({ failed: true }))
        .finally(() => { running--; pump(); });
    }
  }

  // Resolves — never rejects — to { grid }, { none } (the grid holds nothing
  // here) or { failed }.
  function tile(t) {
    stats.asked++;
    if (cache.has(t.key)) { stats.cached++; return Promise.resolve(remember(t.key, cache.get(t.key))); }
    if (inflight.has(t.key)) return inflight.get(t.key);
    if (!inExtent(t)) return Promise.resolve(remember(t.key, { none: true }));
    if (seeded) {
      const g = seeded(t);
      return Promise.resolve(remember(t.key, g ? { grid: g } : { none: true }));
    }
    if (tripped()) { stats.failed++; return Promise.resolve({ failed: true }); }
    const p = new Promise(resolve => {
      queue.push({
        resolve,
        run() {
          return fetchTiff(urlOf(t)).then(buf => {
            if (buf == null) throw new Error('LiDAR: no answer');
            const g = readTiff(buf);
            if (!g || g.W !== t.W || g.H !== t.H) throw new Error('LiDAR: an answer of the wrong shape');
            fails = 0;
            stats.fetched++;
            let any = false;
            for (let i = 0; i < g.data.length && !any; i++) any = g.data[i] === g.data[i];
            return remember(t.key, any ? { grid: g } : { none: true });
          }).catch(err => {
            stats.failed++;
            if (++fails >= TRIP_AFTER) trippedAt = Date.now();
            throw err;
          });
        },
      });
      pump();
    }).finally(() => inflight.delete(t.key));
    inflight.set(t.key, p);
    return p;
  }

  function fetchTiff(url) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), FETCH_MS);
    return fetch(url, ctl ? { signal: ctl.signal } : undefined)
      .then(r => {
        // A 200 that is not a TIFF is a service exception in XML: a failure.
        const ct = (r.headers && r.headers.get && r.headers.get('content-type')) || 'image/tiff';
        return r.ok && /tiff/i.test(ct) ? r.arrayBuffer() : null;
      })
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }

  // ── the GeoTIFF ──
  // The one layout this service answers with — uncompressed, one band, float32
  // (or int16), in strips or tiles — and nothing else: anything else is a
  // failure, not a guess. map-elevation.js has the same reader for its tiles;
  // this one keeps NaN for "no survey here" and the grid's own shape.
  function readTiff(buf) {
    const dv = new DataView(buf);
    if (dv.byteLength < 8) return null;
    const le = dv.getUint16(0) === 0x4949;
    if (!le && dv.getUint16(0) !== 0x4d4d) return null;
    if (dv.getUint16(2, le) !== 42) return null;
    const ifd = dv.getUint32(4, le);
    const n = dv.getUint16(ifd, le);
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8, 16: 8 };
    const tags = {};
    for (let i = 0; i < n; i++) {
      const at = ifd + 2 + i * 12;
      const tag = dv.getUint16(at, le), type = dv.getUint16(at + 2, le), count = dv.getUint32(at + 4, le);
      const size = (SIZE[type] || 1) * count;
      const base = size <= 4 ? at + 8 : dv.getUint32(at + 8, le);
      const vals = [];
      if (type === 2) {
        let s = '';
        for (let k = 0; k < count; k++) { const c = dv.getUint8(base + k); if (c) s += String.fromCharCode(c); }
        tags[tag] = s;
        continue;
      }
      for (let k = 0; k < count; k++) {
        vals.push(type === 3 ? dv.getUint16(base + 2 * k, le) : type === 4 ? dv.getUint32(base + 4 * k, le)
                : type === 12 ? dv.getFloat64(base + 8 * k, le) : type === 11 ? dv.getFloat32(base + 4 * k, le)
                : dv.getUint8(base + k));
      }
      tags[tag] = vals;
    }
    const one = (t, d) => (tags[t] ? tags[t][0] : d);
    const W = one(256), H = one(257), bits = one(258, 32), fmt = one(339, 1), comp = one(259, 1), spp = one(277, 1);
    if (!W || !H || comp !== 1 || spp !== 1) return null;
    let read, bpp;
    if (bits === 32 && fmt === 3) { bpp = 4; read = o => dv.getFloat32(o, le); }
    else if (bits === 16 && fmt === 2) { bpp = 2; read = o => dv.getInt16(o, le); }
    else return null;
    const nodata = typeof tags[42113] === 'string' && tags[42113].trim() !== '' ? Number(tags[42113]) : null;
    const data = new Float32Array(W * H).fill(NaN);
    const tiled = !!tags[322];
    const bw = tiled ? one(322) : W, bh = tiled ? one(323) : one(278, H);
    const offs = tags[tiled ? 324 : 273] || [], lens = tags[tiled ? 325 : 279] || [];
    const across = Math.ceil(W / bw);
    for (let b = 0; b < offs.length; b++) {
      if (!offs[b] || !lens[b]) continue;
      const x0 = (b % across) * bw, y0 = Math.floor(b / across) * bh;
      for (let y = 0; y < bh && y0 + y < H; y++) {
        for (let x = 0; x < bw && x0 + x < W; x++) {
          const o = offs[b] + (y * bw + x) * bpp;
          if (o + bpp > dv.byteLength) continue;
          const v = read(o);
          // 0.0 is this service's hole inside a written block; a declared
          // nodata or a float sentinel is anyone's.
          if (v === 0 || v === nodata || !(Math.abs(v) < 1e5)) continue;
          data[(y0 + y) * W + x0 + x] = v;
        }
      }
    }
    return { W, H, data };
  }

  // Bilinear between cell centres; NaN where the four cells are not all held
  // (an edge of the survey keeps its 30 m height rather than half of one).
  function heightAt(t, g, lat, lon) {
    const fx = (lon - t.w) / (t.e - t.w) * g.W - 0.5, fy = (t.n - lat) / (t.n - t.s) * g.H - 0.5;
    const x0 = Math.max(0, Math.min(g.W - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(g.H - 2, Math.floor(fy)));
    const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
    const d = g.data, i = y0 * g.W + x0;
    const v00 = d[i], v10 = d[i + 1], v01 = d[i + g.W], v11 = d[i + g.W + 1];
    if (!(v00 === v00 && v10 === v10 && v01 === v01 && v11 === v11)) return NaN;
    return (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
  }

  // ── where it matters ──
  // [{ from, to, kind: 'end' | 'obstacle' }] in metres along the path, merged.
  // `ends` is what the analysis will be given: elevA/elevB (surveyed, may be
  // null), aglA/aglB and freqMhz. The ends stand on the higher of survey and
  // ground, as pathAnalyse stands them.
  function zonesOf(base, ends) {
    const d = base.distance_m, g = base.terrain_m, last = g.length - 1, D = d[last];
    const zones = [{ from: 0, to: Math.min(D, END_M), kind: 'end' },
                   { from: Math.max(0, D - END_M), to: D, kind: 'end' }];
    const endOn = (survey, t) => (survey == null ? t : t == null ? survey : Math.max(survey, t));
    const gA = endOn(ends.elevA, g[0]), gB = endOn(ends.elevB, g[last]);
    if (gA == null || gB == null || !(D > 2 * END_M)) return merge(zones);
    const txZ = gA + (ends.aglA || 0), rxZ = gB + (ends.aglB || 0);
    const f = ends.freqMhz > 0 ? ends.freqMhz : 151.5;
    const kOf = helper('kFactorFor', null);
    const k = kOf ? kOf(g).k : 4 / 3;
    const bulge = helper('earthBulge', (a, b, kk) => a * b / (2 * kk * 6371000));
    const r1 = helper('fresnelR1', (a, b, fm) => Math.sqrt(299.792458 / fm * a * b / (a + b)));
    // How far each sample is inside its own "matters" band: positive is ground
    // nearer the line than max(NEAR_M, the first Fresnel radius), or above it.
    const intr = new Float64Array(g.length).fill(-Infinity);
    for (let i = 1; i < last; i++) {
      if (g[i] == null) continue;
      const d1 = d[i], d2 = D - d1;
      const clear = txZ + (rxZ - txZ) * d1 / D - (g[i] + bulge(d1, d2, k));
      intr[i] = Math.max(NEAR_M, r1(d1, d2, f)) - clear;
    }
    // The obstacles: local maxima of intrusion that are inside the band, the
    // strongest first, no two closer than a window apart.
    const peaks = [];
    for (let i = 1; i < last; i++) {
      if (!(intr[i] > 0)) continue;
      if (intr[i] >= intr[i - 1] && intr[i] >= intr[i + 1]) peaks.push(i);
    }
    peaks.sort((a, b) => intr[b] - intr[a]);
    const taken = [];
    for (const i of peaks) {
      if (taken.length >= MAX_OBST) break;
      if (taken.some(j => Math.abs(d[j] - d[i]) < 2 * PAD_M)) continue;
      taken.push(i);
      // The crest whole: the run of samples still inside the band either side.
      let a = i, b = i;
      while (a > 1 && intr[a - 1] > 0 && d[i] - d[a - 1] < SPAN_MAX_M / 2) a--;
      while (b < last - 1 && intr[b + 1] > 0 && d[b + 1] - d[i] < SPAN_MAX_M / 2) b++;
      zones.push({ from: Math.max(0, d[a] - PAD_M), to: Math.min(D, d[b] + PAD_M), kind: 'obstacle' });
    }
    return merge(zones);
  }

  function merge(zones) {
    const z = zones.slice().sort((a, b) => a.from - b.from);
    const out = [];
    for (const x of z) {
      const p = out[out.length - 1];
      if (p && x.from <= p.to) { p.to = Math.max(p.to, x.to); if (x.kind === 'end') p.kind = 'end'; }
      else out.push({ ...x });
    }
    return out;
  }

  // ── a mast's ground ──
  // The highest LiDAR ground within radiusM of a point, and where. A repeater
  // or a base is put where the ground is highest — that is what a radio site
  // is chosen for — and its registered position is often rounded: three
  // decimals of a degree is ±55 m, which on a summit is the difference between
  // the top and a shoulder ten metres down. The ~30 m tiles hid that, because a
  // summit pixel stands every antenna inside it on the top; at 5 m it is the
  // register's error and not the hill's. Resolves to { lat, lon, ground,
  // moved_m, from_m } or null where the grid holds nothing there.
  async function highest(lat, lon, radiusM) {
    const r = Math.max(0, radiusM || 0);
    const mLat = 110574, mLon = 111320 * Math.cos(lat * Math.PI / 180);
    const keys = new Map();
    for (const dy of [-r, 0, r]) for (const dx of [-r, 0, r]) {
      const t = tileOf(lat + dy / mLat, lon + dx / mLon);
      keys.set(t.key, t);
    }
    const tiles = await Promise.all([...keys.values()].map(t => tile(t).then(res => ({ t, res }))));
    let best = null, here = null;
    for (const { t, res } of tiles) {
      if (!res.grid) continue;
      const g = res.grid;
      for (let y = 0; y < g.H; y++) {
        const la = t.n - (y + 0.5) * (t.n - t.s) / g.H;
        const dy = (la - lat) * mLat;
        if (Math.abs(dy) > r + CELL_M) continue;
        for (let x = 0; x < g.W; x++) {
          const h = g.data[y * g.W + x];
          if (!(h === h)) continue;
          const lo = t.w + (x + 0.5) * (t.e - t.w) / g.W;
          const dist = Math.hypot((lo - lon) * mLon, dy);
          if (dist <= CELL_M && (!here || dist < here.d)) here = { d: dist, h };
          if (dist > Math.max(r, CELL_M)) continue;
          if (!best || h > best.ground) best = { lat: la, lon: lo, ground: h, moved_m: dist };
        }
      }
    }
    if (!best) return null;
    return { ...best, from_m: here ? here.h : null };
  }

  // How far a registered position may be from where it was measured, from how
  // it was written down: half the last decimal place, in metres — three
  // decimals of a degree is ±56 m, four ±6 — kept between SNAP_MIN_M and
  // SNAP_MAX_M, so a two-decimal position is not let wander onto the next hill.
  const SNAP_MIN_M = 15, SNAP_MAX_M = 100;
  function roundingOf(lat, lon) {
    const dp = v => { const s = String(v); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
    const d = Math.min(dp(lat), dp(lon));
    return Math.max(SNAP_MIN_M, Math.min(SNAP_MAX_M, 0.5 * Math.pow(10, -d) * 111320));
  }

  // ── the refinement ──
  // base: a profile at even spacing — Terrain.profile at STEP_M (see
  // pathGround) — and ends as zonesOf takes them. Resolves to
  //   { ok: true, prof, report }   prof is a copy of base with LiDAR heights
  //                                in the zones (prof.lidar marks them), or
  //                                base itself when there was nothing to add
  //   report: { zones, tiles, fetched, failed, lidarShare, covered, attribution }
  async function refine(base, ends, opt) {
    const o = opt || {};
    if (!base || !base.ok || !Array.isArray(base.terrain_m) || base.terrain_m.length < 3) {
      return { ok: false, error: 'No profile to refine.' };
    }
    const g = base.terrain_m, last = g.length - 1;
    const zones = zonesOf(base, ends || {});
    // Which samples each zone covers, and the tiles under them.
    const want = new Map();
    const inZone = new Int8Array(g.length);
    zones.forEach((z, zi) => {
      for (let i = 0; i <= last; i++) {
        const x = base.distance_m[i];
        if (x < z.from || x > z.to) continue;
        inZone[i] = 1;
        const t = tileOf(base.lat[i], base.lon[i]);
        if (!want.has(t.key)) want.set(t.key, t);
      }
    });
    const before = { failed: stats.failed, fetched: stats.fetched };
    const got = new Map();
    await Promise.all([...want.values()].map(t => tile(t).then(r => got.set(t.key, { t, r }))));
    const terrain = g.slice(), lidar = new Uint8Array(g.length);
    let asked = 0, had = 0;
    for (let i = 0; i <= last; i++) {
      if (!inZone[i]) continue;
      asked++;
      const hit = got.get(tileOf(base.lat[i], base.lon[i]).key);
      if (!hit || !hit.r.grid) continue;
      const h = heightAt(hit.t, hit.r.grid, base.lat[i], base.lon[i]);
      if (!(h === h)) continue;
      had++;
      lidar[i] = 1;
      terrain[i] = h;
    }
    // Blend at the inner edges of each run of LiDAR samples, so the two
    // sources meet on a ramp rather than a step. Never at the path's own ends.
    const blendN = Math.max(1, Math.round(BLEND_M / Math.max(1, base.distance_m[1] - base.distance_m[0])));
    for (let i = 1; i < last; i++) {
      if (lidar[i] && !lidar[i - 1] && i - 1 > 0) ramp(i, -1);
      if (lidar[i] && !lidar[i + 1] && i + 1 < last) ramp(i, +1);
    }
    function ramp(edge, dir) {
      // edge is the outermost LiDAR sample; walk inward, easing from the tile
      // height at the edge to the LiDAR height blendN samples in.
      for (let s = 0; s < blendN; s++) {
        const j = edge - dir * s;
        if (j <= 0 || j >= last || !lidar[j] || g[j] == null) break;
        const w = (s + 1) / (blendN + 1);
        terrain[j] = g[j] + (terrain[j] - g[j]) * w;
      }
    }
    const fetched = stats.fetched - before.fetched, failed = stats.failed - before.failed;
    const report = {
      zones: zones.map(z => ({ ...z })), tiles: want.size, fetched, failed,
      lidarShare: g.length ? had / g.length : 0,           // of the whole profile
      covered: asked ? had / asked : 0,                     // of what was asked for
      attribution: ATTRIB,
    };
    if (!had) return { ok: true, prof: base, report };
    return { ok: true, prof: { ...base, terrain_m: terrain, lidar, ground: 'lidar' }, report };
  }

  return {
    attribution: ATTRIB,
    STEP_M, END_M, NEAR_M, MAX_SAMPLES,
    refine,
    highest,
    roundingOf,
    zonesOf,
    readTiff,
    tileOf,
    stats() { return { ...stats, cached_tiles: cache.size, tripped: !!tripped() }; },
    // Test seam: answer tiles from a function instead of the network.
    seed(fn) { seeded = typeof fn === 'function' ? fn : null; cache.clear(); },
    clear() { cache.clear(); fails = 0; trippedAt = 0; },
  };
})();
