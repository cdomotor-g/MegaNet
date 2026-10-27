// MegaNet — map-rain.js
//
//   MapRain   the rain the network's own gauges have measured, painted over
//             the Stations map as a heat map between them — a total over a
//             window, or the heaviest hour in it — with each gauge's figure
//             beside its station, the heaviest falls named, and the last 24
//             hours played back an hour a frame.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr and bucketSizeMm; to
// datastore.js for dbSelect; to group-plots.js for GroupPlots.gaugesOf (a
// station's rain gauges and the address each files its readings under); to
// health-analysis.js for HealthAnalysis.rainOf (a gauge's tips with the
// counter's wraps, resets and corrupted frames taken out); and to app.js for
// rerenderMapDisplayControls, rerenderMapLegend and goToStation. All at call
// time; nothing here runs at load (`npm run toplevel`).
//
// ── Where the rain comes from ────────────────────────────────────────────────
// meganet.reading, which `anon` reads, so the layer works signed out. A rain
// gauge's address carries its tipping bucket's counter; the rain over a window
// is the tips counted inside it, at the station's bucket size (0.2 mm a tip
// when none is recorded, as everywhere else in the app). Every gauge on the
// register is asked about, CHUNK addresses a request, from LOOKBACK before the
// window opens — so the first reading inside it has one before it to count
// from — or from 48 hours back, whichever is earlier, which is what the
// time-lapse needs. One load serves every window it covers, for TTL, and the
// layer reads again on that beat while it is on and the page is in view.
//
// A gauge is on the map when it has been heard from at any time since a day
// before the window opened: heard and no tips is a dry gauge, and a dry gauge
// pulls the surface down as surely as a wet one pushes it up. A gauge not heard
// at all is left out, not counted as dry — a flat battery is not a fine day.
//
// ── The surface ──────────────────────────────────────────────────────────────
// Between the gauges, Shepard's inverse-distance weighting with Franke and
// Nielson's taper, ((R − d) / (R·d))², so a gauge's say falls to nothing at the
// reach R rather than stopping at a step. Nothing is painted further than R
// from every gauge, and the last 40% of the reach fades out: this is what the
// gauges measured, not radar, and a colour over a hundred kilometres of
// ungauged country would be a guess dressed as a reading. The reach is the
// operator's to set (REACH), because the network is a gauge every few
// kilometres in the south-east and one every fifty out west.
//
// The grid is worked out at CELL_PX on screen over the view and PAD of it
// beyond each edge, one canvas pixel a cell, and laid on the map as an image
// that the browser smooths as it scales it up. Mercator keeps a column on one
// longitude and a row on one latitude, so each is converted once. Redrawn
// when the map stops moving.
//
// ── The colours ──────────────────────────────────────────────────────────────
// Twelve steps, pale blue through green and yellow to red and purple, the
// order the Bureau's rainfall maps and radar use, so heavier always reads as
// hotter. One set of colours, two scales: millimetres fallen (0.2 to 300+),
// and millimetres in an hour (0.2 to 100+) for the peak and for each frame of
// the time-lapse. Literal hexes, for MapWind's reason: an image's pixels and a
// Leaflet path's options cannot take var(), and over map tiles neither theme
// needs its own set. Under 0.2 mm — less than one tip — is dry, and dry is not
// painted.
//
// ── The z budget (map-survey.js) ─────────────────────────────────────────────
// The surface at 249: over the elevation shading and the coverage maps (245–
// 248), under the base map's place names (250) and every line and pin above
// them, so a town and a river can still be read through a storm. The gauges'
// figures at 402, just over the network's canvas (400) and under the station
// pins' own panes, beside the station rather than on it.
//
// 2-D only, like the cameras: the tilted map does not draw it yet.
const MapRain = (function () {
  const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
  const PANE = 'mnRain', PANE_Z = 249;
  const FIG_PANE = 'mnRainFigs', FIG_PANE_Z = 402;
  const CHUNK = 150;            // addresses one request names
  const AT_ONCE = 4;            // requests at a time
  const PAGE = 1000;            // PostgREST's usual cap; paged until a short page
  const ROW_CAP = 120000;       // across one load — a guard, said when it bites
  const LOOKBACK = DAY;         // read this far before a window opens
  const LAPSE_H = 24;           // the time-lapse: the last this many hours, an hour a frame
  const LAPSE_MS = 900;         // a frame this long when playing
  const TTL = 5 * MINUTE;       // a load is reused this long, and read again on this beat
  const CELL_PX = 4;            // the finest grid; coarser on a big screen, so a paint stays under CELL_CAP cells
  const CELL_CAP = 120000;
  const PAD = 0.25;             // fraction of the view painted beyond each edge
  const DEBOUNCE_MS = 150;
  const DRY = 0.2;              // under one tip of the usual bucket
  const REACH = { def: 30, min: 10, max: 80, step: 5 };   // km
  const OPACITY = { def: 0.7, min: 0.1, max: 1 };
  const FIG_ZOOM = 9;           // the wet gauges' figures from here
  const ALL_FIG_ZOOM = 11;      // every heard gauge's, dry ones too, from here
  const FIG_MERGE_PX = 36;      // figures closer than this: the heavier one stands
  const TOP_N = 5;
  const TZ = 'Australia/Brisbane';
  // 9 am in Brisbane, which keeps no daylight saving, is 23:00 UTC the day
  // before: the Bureau's rain day, on the clock the network's gauges are read on.
  const RAIN_DAY_UTC = 23 * HOUR;

  // ── Windows, measures, scales ─────────────────────────────────────────────

  const WINDOWS = [
    { k: '1h',     label: 'Last hour',      ms: HOUR },
    { k: '3h',     label: 'Last 3 hours',   ms: 3 * HOUR },
    { k: '6h',     label: 'Last 6 hours',   ms: 6 * HOUR },
    { k: '12h',    label: 'Last 12 hours',  ms: 12 * HOUR },
    { k: '24h',    label: 'Last 24 hours',  ms: DAY },
    { k: '72h',    label: 'Last 3 days',    ms: 3 * DAY },
    { k: '7d',     label: 'Last 7 days',    ms: 7 * DAY },
    { k: 'since9', label: 'Since 9 am — today’s rain day' },
    { k: 'to9',    label: '24 hours to 9 am — the last whole rain day' },
  ];
  const WINDOW_BY = Object.fromEntries(WINDOWS.map(w => [w.k, w]));

  const MEASURES = [
    { k: 'total', label: 'Rain fallen (mm)',                       scale: 'total' },
    { k: 'peak',  label: 'Peak intensity — the most in any hour (mm/h)', scale: 'rate' },
  ];
  const MEASURE_BY = Object.fromEntries(MEASURES.map(m => [m.k, m]));

  const PALETTE = ['#cfeaff', '#9ad2ff', '#5aaeff', '#2a78e4', '#169c50', '#7cc934',
                   '#f2df1d', '#ffa21c', '#ff4d1f', '#c8102e', '#a3007d', '#5b1a8b'];
  const SCALES = {
    total: { unit: 'mm',   steps: [0.2, 1, 2, 5, 10, 15, 25, 50, 100, 150, 200, 300] },
    rate:  { unit: 'mm/h', steps: [0.2, 0.5, 1, 2, 5, 10, 15, 20, 30, 50, 75, 100] },
  };
  const RGB = PALETTE.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
  // The figure's ink on its own colour: dark on the pale steps, white on the rest.
  const INK = RGB.map(([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? '#111' : '#fff'));
  const DRY_FILL = '#eef1f4';

  // The step a value falls in, or -1 when it is dry. The tolerance keeps a
  // lone gauge's one tip from falling just short of 0.2 in floating point.
  function binOf(v, scale) {
    const steps = (SCALES[scale] || SCALES.total).steps;
    let i = -1;
    for (let k = 0; k < steps.length && v >= steps[k] - 1e-9; k++) i = k;
    return i;
  }
  function colourOf(v, scale) {
    const i = binOf(v, scale);
    return i < 0 ? null : PALETTE[i];
  }

  // ── Words for time, on Brisbane's clock ───────────────────────────────────

  const dayKey = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
  function clock(ms) {
    return new Date(ms).toLocaleTimeString('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
      .replace(':00', '').replace(/\s+/g, ' ');
  }
  function dayWord(ms, now) {
    const k = dayKey(ms);
    if (k === dayKey(now)) return 'today';
    if (k === dayKey(now - DAY)) return 'yesterday';
    return new Date(ms).toLocaleDateString('en-AU', { timeZone: TZ, weekday: 'long' });
  }
  const when = (ms, now) => `${clock(ms)} ${dayWord(ms, now)}`;

  // The last 9 am in Brisbane at or before `now`.
  function last9am(now) {
    return Math.floor((now - RAIN_DAY_UTC) / DAY) * DAY + RAIN_DAY_UTC;
  }

  // A window's span, [t0, t1]: the rain counted is the tips after t0 and up to t1.
  function windowSpan(k, now) {
    const w = WINDOW_BY[k] || WINDOW_BY['24h'];
    if (w.k === 'since9') return { t0: last9am(now), t1: now };
    if (w.k === 'to9') { const e = last9am(now); return { t0: e - DAY, t1: e }; }
    return { t0: now - w.ms, t1: now };
  }

  function windowWords(k, now) {
    const w = WINDOW_BY[k] || WINDOW_BY['24h'];
    const { t0, t1 } = windowSpan(w.k, now);
    if (w.k === 'since9') return `since 9 am ${dayWord(t0, now)}`;
    if (w.k === 'to9') return `in the 24 hours to 9 am ${dayWord(t1, now)}`;
    return w.k === '1h' ? 'in the last hour' : `in the ${w.label.toLowerCase()}`;
  }

  // The time-lapse's frames: an hour each, on the clock's hours, the last one
  // the hour so far.
  function lapseFrames(now) {
    const top = Math.floor(now / HOUR) * HOUR;
    return Array.from({ length: LAPSE_H }, (_, i) => {
      const t0 = top - (LAPSE_H - 1 - i) * HOUR;
      return { t0, t1: Math.min(t0 + HOUR, now) };
    });
  }
  function frameWords(f, now) {
    return f.t1 >= now ? `${clock(f.t0)} to now` : `${clock(f.t0)} – ${clock(f.t1)} ${dayWord(f.t0, now)}`;
  }

  const fmtMm = v => (v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1));

  // ── Settings, remembered on this device ───────────────────────────────────

  function readPref(key, ok, def) {
    let v = null;
    try { v = localStorage.getItem(key); } catch (_) { /* private window */ }
    return v != null && ok(v) ? v : def;
  }
  function writePref(key, v) {
    try { localStorage.setItem(key, String(v)); } catch (_) { /* this session only */ }
  }
  const prefs = {
    win:     () => readPref('mn-rain-win', v => !!WINDOW_BY[v], '24h'),
    measure: () => readPref('mn-rain-measure', v => !!MEASURE_BY[v], 'total'),
    opacity: () => Number(readPref('mn-rain-op', v => +v >= OPACITY.min && +v <= OPACITY.max, OPACITY.def)),
    reach:   () => Number(readPref('mn-rain-reach', v => +v >= REACH.min && +v <= REACH.max, REACH.def)),
    figures: () => readPref('mn-rain-figs', v => v === 'on' || v === 'off', 'on') === 'on',
  };

  // ── The gauges ────────────────────────────────────────────────────────────

  let gaugeMemo = { data: undefined, list: [], byAddr: new Map() };

  // Every located rain gauge on the register, once each: the register holds a
  // few stations twice on one address, and those are one gauge.
  function gaugeList() {
    const data = state.data;
    if (gaugeMemo.data === data) return gaugeMemo;
    const list = [], byAddr = new Map();
    const of = typeof GroupPlots !== 'undefined' && GroupPlots.gaugesOf ? GroupPlots.gaugesOf : () => [];
    for (const st of (data && data.stations) || []) {
      const lat = Number(st.lat), lon = Number(st.lon);
      if (st.lat == null || st.lon == null || !isFinite(lat) || !isFinite(lon)) continue;
      for (const ga of of(st, 'rain')) {
        if (!ga.addr || byAddr.has(ga.addr)) continue;
        const b = typeof bucketSizeMm === 'function' ? bucketSizeMm(st) : { mm: 0.2, recorded: false };
        const g = { addr: ga.addr, id: st.id, name: st.name || st.id, lat, lon, mmPerTip: b.mm, recorded: b.recorded, st };
        list.push(g);
        byAddr.set(g.addr, g);
      }
    }
    gaugeMemo = { data, list, byAddr };
    return gaugeMemo;
  }

  // ── Reading the datastore ─────────────────────────────────────────────────

  let rd = null;      // the readings: { from, at, series: Map(addr -> series), rows, capped, chunks }
  let rdP = null;     // a load in flight: { from, promise }
  let progress = null;

  function addrParam(addrs) {
    // Quoted: an address carries a colon and a slash, both punctuation to
    // PostgREST's list parser (sensor-sparks.js does the same).
    const list = addrs.map(a => `"${String(a).replace(/["\\]/g, '')}"`).join(',');
    return `addr=in.(${encodeURIComponent(list).replace(/%2C/g, ',')})`;
  }

  async function readChunk(addrs, fromIso, budget) {
    const rows = [];
    for (;;) {
      const page = await dbSelect(`reading?${addrParam(addrs)}&reading_ts=gte.${fromIso}`
        + `&select=addr,reading_ts,value_raw,unit&order=addr.asc,reading_ts.asc&limit=${PAGE}&offset=${rows.length}`);
      if (!Array.isArray(page) || !page.length) break;
      rows.push(...page);
      budget.rows += page.length;
      if (page.length < PAGE) break;
      if (budget.rows >= ROW_CAP) { budget.capped = true; break; }
    }
    return rows;
  }

  // A gauge's readings as the rain it counted: the steps rainOf keeps, as two
  // arrays, oldest first, with when it was last heard from at all.
  function seriesOf(pts, g) {
    pts.sort((a, b) => a.t - b.t);
    const R = HealthAnalysis.rainOf(pts.map(p => ({ t: p.t, v: p.v })), g.st);
    return {
      t: R.steps.map(s => s.t), tips: R.steps.map(s => s.tips),
      heard: pts[pts.length - 1].t, n: pts.length,
      left: R.outliers + R.jumps + R.flips,
    };
  }

  function seriesFrom(rows, byAddr) {
    const by = new Map();
    for (const r of rows) {
      const t = Date.parse(r.reading_ts), v = Number(r.value_raw);
      if (!isFinite(t) || !byAddr.has(r.addr)) continue;
      if (!by.has(r.addr)) by.set(r.addr, []);
      by.get(r.addr).push({ t, v, unit: (r.unit || '').trim() });
    }
    const out = new Map();
    by.forEach((pts, addr) => {
      // A logger that sends millimetres has no tips to count, and whether its
      // figure is a running total or an increment is not on record.
      if (addr.startsWith('s:') && pts.some(p => p.unit && p.unit !== 'count')) return;
      out.set(addr, seriesOf(pts, byAddr.get(addr)));
    });
    return out;
  }

  async function loadFrom(from) {
    const { list, byAddr } = gaugeList();
    const addrs = list.map(g => g.addr);
    const chunks = [];
    for (let i = 0; i < addrs.length; i += CHUNK) chunks.push(addrs.slice(i, i + CHUNK));
    const fromIso = encodeURIComponent(new Date(from).toISOString());
    const budget = { rows: 0, capped: false };
    const rows = [];
    let next = 0, done = 0;
    progress = { done: 0, of: chunks.length };
    const worker = async () => {
      while (next < chunks.length && !budget.capped) {
        const c = chunks[next++];
        for (const r of await readChunk(c, fromIso, budget)) rows.push(r);
        progress = { done: ++done, of: chunks.length };
        if (note.kind === 'loading') setNote('loading');
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, chunks.length) }, worker));
    progress = null;
    return { from, at: Date.now(), series: seriesFrom(rows, byAddr), rows: rows.length,
             capped: budget.capped, gauges: list.length };
  }

  // How far back the current settings need the readings to go.
  function needFrom(now) {
    const win = windowSpan(prefs.win(), now);
    const lapse = now - LAPSE_H * HOUR;
    return Math.floor((Math.min(win.t0, lapse) - LOOKBACK) / HOUR) * HOUR;
  }

  function ensure(force) {
    const now = Date.now();
    const from = needFrom(now);
    const fresh = rd && now - rd.at < TTL && rd.from <= from && rd.data === state.data;
    if (fresh && !force) return Promise.resolve(rd);
    if (rdP && rdP.from <= from) return rdP.promise;
    const data = state.data;
    const promise = loadFrom(from).then(r => {
      r.data = data;
      rd = r;
      if (rdP && rdP.promise === promise) rdP = null;
      return r;
    }, err => {
      if (rdP && rdP.promise === promise) rdP = null;
      throw err;
    });
    rdP = { from, promise };
    return promise;
  }

  // ── What each gauge says ──────────────────────────────────────────────────

  // Tips after t0 and up to t1 — all of them, or the most in any hour.
  function tipsIn(s, t0, t1, measure) {
    let i = 0;
    while (i < s.t.length && s.t[i] <= t0) i++;
    if (measure !== 'peak') {
      let n = 0;
      for (; i < s.t.length && s.t[i] <= t1; i++) n += s.tips[i];
      return n;
    }
    let best = 0, sum = 0, a = i;
    for (let b = i; b < s.t.length && s.t[b] <= t1; b++) {
      sum += s.tips[b];
      while (s.t[a] <= s.t[b] - HOUR) sum -= s.tips[a++];
      if (sum > best) best = sum;
    }
    return best;
  }

  let lapse = null;   // the time-lapse while it is on: { i, playing, timer }

  // What the map is showing now: the window and measure, or a lapse frame.
  function showing(now) {
    if (lapse) {
      const f = lapseFrames(now)[lapse.i];
      return { t0: f.t0, t1: f.t1, measure: 'total', scale: 'rate', lapse: true, words: `in the hour ${frameWords(f, now)}` };
    }
    const k = prefs.win(), m = prefs.measure();
    const { t0, t1 } = windowSpan(k, now);
    return { t0, t1, measure: m, scale: MEASURE_BY[m].scale, lapse: false, words: windowWords(k, now) };
  }

  // Every heard gauge's figure for what is showing: [{ g, mm, s }], in mm (or
  // mm in an hour), heaviest first.
  function figures(now = Date.now()) {
    if (!rd) return [];
    const sh = showing(now);
    const out = [];
    for (const g of gaugeList().list) {
      const s = rd.series.get(g.addr);
      if (!s || s.heard < sh.t0 - LOOKBACK) continue;
      out.push({ g, s, mm: Math.round(tipsIn(s, sh.t0, sh.t1, sh.measure) * g.mmPerTip * 100) / 100 });
    }
    return out.sort((a, b) => b.mm - a.mm);
  }

  // ── The surface: inverse-distance weighting with a reach ──────────────────

  const KM_LAT = 110.574;
  const kmLon = lat => 111.320 * Math.cos(lat * Math.PI / 180);

  // Points binned by the reach, so a cell looks at the bins round it and no
  // further — the nine round each bin gathered once, the first time a cell in
  // it asks. `wet` says whether any of them is wet: an average of dry values
  // is dry, so a cell with no wet gauge in reach is left clear unweighed. A
  // bin is as many degrees of longitude as the reach is at the point furthest
  // from the equator, where a degree is shortest, so it is at least the reach
  // wide everywhere and the nine round a cell always hold all of its reach.
  const binKey = (i, j) => i * 1e6 + j;
  function buildIndex(pts, reachKm) {
    const lat0 = pts.reduce((m, p) => Math.max(m, Math.abs(p.lat)), 0);
    const dLat = reachKm / KM_LAT, dLon = reachKm / Math.max(1e-6, kmLon(lat0));
    const bins = new Map();
    for (const p of pts) {
      const k = binKey(Math.floor(p.lat / dLat), Math.floor(p.lon / dLon));
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(p);
    }
    return { bins, dLat, dLon, R: reachKm, around: new Map() };
  }

  function around(ix, bi, bj) {
    const k = binKey(bi, bj);
    let a = ix.around.get(k);
    if (!a) {
      const pts = [];
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const b = ix.bins.get(binKey(bi + di, bj + dj));
        if (b) pts.push(...b);
      }
      a = { pts, wet: pts.some(p => p.v >= DRY - 1e-9) };
      ix.around.set(k, a);
    }
    return a;
  }

  // The weighted value at a point, with how far the nearest gauge is and how
  // many had a say; null with none in reach. `wetOnly` skips the weighing
  // where no wet gauge is in reach (the painter's shortcut).
  function sampleAt(ix, lat, lon, wetOnly) {
    const a = around(ix, Math.floor(lat / ix.dLat), Math.floor(lon / ix.dLon));
    if (!a.pts.length || (wetOnly && !a.wet)) return null;
    const R = ix.R, R2 = R * R, kx = kmLon(lat);
    let sw = 0, swv = 0, n = 0, best = Infinity;
    for (const p of a.pts) {
      const dx = (lon - p.lon) * kx, dy = (lat - p.lat) * KM_LAT;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R2) continue;
      const d = Math.max(0.25, Math.sqrt(d2));
      const w = ((R - d) / (R * d)) ** 2;
      sw += w; swv += w * p.v; n++;
      if (d < best) best = d;
    }
    return n ? { v: swv / sw, near: best, n } : null;
  }

  // How much of a cell's colour shows, by its nearest gauge: whole to 60% of
  // the reach, fading to nothing at it.
  function fadeAt(near, R) {
    return near <= 0.6 * R ? 1 : Math.max(0, (R - near) / (0.4 * R));
  }

  // ── The layers ────────────────────────────────────────────────────────────

  let map = null, overlay = null, figLayer = null;
  let timer = null, beat = null, seq = 0;
  let note = { kind: 'off', error: '' };
  let noteTimer = null;
  let painted = { wet: 0, heard: 0, cells: 0 };

  function clearLayers() {
    if (overlay) { overlay.remove(); overlay = null; }
    if (figLayer) { figLayer.remove(); figLayer = null; }
    painted = { wet: 0, heard: 0, cells: 0 };
  }

  function paintSurface(figs, sh) {
    const reach = prefs.reach();
    const pts = figs.map(f => ({ lat: f.g.lat, lon: f.g.lon, v: f.mm }));
    if (!pts.some(p => p.v >= DRY - 1e-9)) {
      if (overlay) { overlay.remove(); overlay = null; }
      return 0;
    }
    const size = map.getSize();
    const px = Math.round(size.x * PAD), py = Math.round(size.y * PAD);
    const W = size.x + 2 * px, H = size.y + 2 * py;
    const cell = Math.max(CELL_PX, Math.ceil(Math.sqrt(W * H / CELL_CAP)));
    const cols = Math.max(1, Math.ceil(W / cell)), rows = Math.max(1, Math.ceil(H / cell));
    const lonAt = new Float64Array(cols), latAt = new Float64Array(rows);
    for (let c = 0; c < cols; c++) lonAt[c] = map.containerPointToLatLng([-px + (c + 0.5) * cell, 0]).lng;
    for (let r = 0; r < rows; r++) latAt[r] = map.containerPointToLatLng([0, -py + (r + 0.5) * cell]).lat;
    const ix = buildIndex(pts, reach);
    const canvas = document.createElement('canvas');
    canvas.width = cols; canvas.height = rows;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(cols, rows);
    const px8 = img.data;
    let cells = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const q = sampleAt(ix, latAt[r], lonAt[c], true);
        if (!q) continue;
        const i = binOf(q.v, sh.scale);
        if (i < 0) continue;
        const a = fadeAt(q.near, reach);
        if (a <= 0) continue;
        const o = (r * cols + c) * 4, rgb = RGB[i];
        px8[o] = rgb[0]; px8[o + 1] = rgb[1]; px8[o + 2] = rgb[2]; px8[o + 3] = Math.round(255 * a);
        cells++;
      }
    }
    ctx.putImageData(img, 0, 0);
    const bounds = L.latLngBounds(map.containerPointToLatLng([-px, -py]),
      map.containerPointToLatLng([-px + cols * cell, -py + rows * cell]));
    const url = canvas.toDataURL('image/png');
    if (!overlay) {
      overlay = L.imageOverlay(url, bounds, { pane: PANE, opacity: prefs.opacity(), interactive: false,
                                             className: 'mn-rain-surface', alt: '' }).addTo(map);
    } else {
      overlay.setUrl(url);
      overlay.setBounds(bounds);
    }
    return cells;
  }

  function figTitle(f, sh) {
    const what = sh.measure === 'peak' ? `${fmtMm(f.mm)} mm in its heaviest hour ${sh.words}`
      : `${fmtMm(f.mm)} mm ${sh.words}`;
    const tip = `${f.g.mmPerTip} mm a tip${f.g.recorded ? '' : ', assumed — no bucket size is recorded'}`;
    return `${f.g.name} — ${what}. Last heard ${when(f.s.heard, Date.now())}; ${tip}. Press for the station`;
  }

  function paintFigures(figs, sh) {
    if (figLayer) { figLayer.remove(); figLayer = null; }
    const z = map.getZoom();
    if (!prefs.figures() || z < FIG_ZOOM) return;
    const all = z >= ALL_FIG_ZOOM;
    const b = map.getBounds().pad(0.05);
    const placed = [];
    figLayer = L.layerGroup([], { pane: FIG_PANE });
    for (const f of figs) {
      if (!all && f.mm < DRY - 1e-9) continue;
      if (!b.contains([f.g.lat, f.g.lon])) continue;
      const p = map.latLngToContainerPoint([f.g.lat, f.g.lon]);
      if (placed.some(q => Math.hypot(q.x - p.x, q.y - p.y) < FIG_MERGE_PX)) continue;
      placed.push(p);
      const i = binOf(f.mm, sh.scale);
      const bg = i < 0 ? DRY_FILL : PALETTE[i], ink = i < 0 ? '#333' : INK[i];
      const title = figTitle(f, sh);
      const icon = L.divIcon({
        className: 'mn-rain-fig-icon', iconSize: [0, 0], iconAnchor: [0, 0],
        html: `<span class="mn-rain-fig" style="--dot:${bg};--ink:${ink}">${esc(fmtMm(f.mm))}</span>`,
      });
      L.marker([f.g.lat, f.g.lon], { icon, pane: FIG_PANE, keyboard: true, title, alt: title, bubblingMouseEvents: false })
        .on('click', () => MapRain.toStation(f.g.id))
        .addTo(figLayer);
    }
    figLayer.addTo(map);
  }

  // Whether the readings on hand reach back as far as what is showing needs.
  // A window that a failed read never fetched is not painted from a shorter one.
  const covers = now => !!rd && rd.from <= needFrom(now);

  function paint() {
    if (!map || !state.mapRain || !rd) return;
    const now = Date.now();
    if (!covers(now)) { clearLayers(); return; }
    const sh = showing(now);
    const figs = figures(now);
    const cells = paintSurface(figs, sh);
    paintFigures(figs, sh);
    painted = { wet: figs.filter(f => f.mm >= DRY - 1e-9).length, heard: figs.length, cells };
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(paint, DEBOUNCE_MS);
  }

  function rerender() {
    if (typeof rerenderMapDisplayControls === 'function') rerenderMapDisplayControls();
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
  }

  function setNote(kind, extra = {}) {
    note = Object.assign({ kind, error: '' }, extra);
    const el = document.getElementById('map-rain-note');
    if (el) el.innerHTML = noteHtml();
  }

  // Read (or reuse) and paint. A second call while one is reading waits on the
  // same read; one overtaken by a later call paints nothing.
  function run(force) {
    if (!map || !state.mapRain) return;
    const mine = ++seq;
    if (!rd || force || note.kind !== 'ok') setNote('loading');
    ensure(force).then(() => {
      if (mine !== seq || !map || !state.mapRain) return;
      paint();
      setNote('ok');
      // The note and the key, never the whole panel: the beat reads again
      // every few minutes, and redrawing the panel under somebody's slider
      // would take it out of their hand.
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    }, err => {
      if (mine !== seq || !map) return;
      // A read again that failed keeps the last good one on the map, and says
      // how old it is: in a storm, a quarter-hour-old picture beats none. One
      // that never had readings for this window paints nothing.
      const stale = covers(Date.now());
      if (stale) paint(); else clearLayers();
      setNote('fail', { error: (err && err.message) || String(err), stale });
      if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
    });
  }

  function startBeat() {
    clearInterval(beat);
    beat = setInterval(() => {
      if (!map || !state.mapRain || (lapse && lapse.playing)) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      run(true);
    }, TTL);
  }

  function onMove() { if (state.mapRain && rd) schedule(); }

  // ── The time-lapse ────────────────────────────────────────────────────────

  function lapseTick() {
    if (!lapse || !lapse.playing) return;
    lapse.i = (lapse.i + 1) % LAPSE_H;
    showFrame();
    // A breath on the last frame before it starts again.
    lapse.timer = setTimeout(lapseTick, lapse.i === LAPSE_H - 1 ? LAPSE_MS * 3 : LAPSE_MS);
  }

  function showFrame() {
    paint();
    if (note.kind === 'ok') setNote('ok');
    const now = Date.now();
    const f = lapseFrames(now)[lapse.i];
    const s = document.getElementById('rain-lapse-range');
    if (s) { s.value = String(lapse.i); s.setAttribute('aria-valuetext', frameWords(f, now)); }
    const w = document.getElementById('rain-lapse-when');
    if (w) w.textContent = frameWords(f, now);
    if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
  }

  function stopLapse() {
    if (!lapse) return;
    clearTimeout(lapse.timer);
    lapse = null;
  }

  // ── Notes, keys and controls ──────────────────────────────────────────────

  function rampHtml(scale) {
    const sc = SCALES[scale] || SCALES.total;
    const last = sc.steps.length - 1;
    return `<ol class="mn-rain-ramp" aria-label="${escAttr(`Colour key, ${sc.unit}: pale blue from ${sc.steps[0]}, `
      + `through green and yellow, to purple from ${sc.steps[last]}`)}">${sc.steps.map((s, i) =>
      `<li style="--dot:${PALETTE[i]}"><span>${i === last ? `${s}+` : s}</span></li>`).join('')}</ol>`;
  }

  function topHtml(figs) {
    const wet = figs.filter(f => f.mm >= DRY - 1e-9).slice(0, TOP_N);
    if (!wet.length) return '';
    const sh = showing(Date.now());
    const unit = sh.scale === 'rate' ? (sh.lapse ? 'mm' : 'mm/h') : 'mm';
    return `<span class="mn-rain-top">Heaviest: ${wet.map(f =>
      `<button type="button" class="link-btn" onclick="MapRain.toStation('${escAttr(f.g.id)}')"
         title="${escAttr(`Open ${f.g.name} on the map`)}">${esc(f.g.name)}</button> ${esc(fmtMm(f.mm))}&nbsp;${unit}`).join(' · ')}</span>`;
  }

  function noteHtml() {
    switch (note.kind) {
      case 'off':
        return 'Off. Paints the rain the network’s own gauges have measured — the last hour to the last week, '
             + 'or since 9 am — between them as a heat map, out of the Flood-Net datastore. Signed in or not.';
      case 'loading':
        return progress && progress.of > 1
          ? `Reading the rain gauges… ${progress.done} of ${progress.of}`
          : 'Reading the rain gauges…';
      case 'fail':
        return `<span class="txt-bad">The rain gauges could not be read${note.stale ? ' again' : ''} — ${esc(note.error)}.</span> `
             + (note.stale && rd ? `The map shows what they said as at ${esc(clock(rd.at))}. ` : '')
             + '<button type="button" class="link-btn" onclick="MapRain.refresh()">Try again</button>';
      case 'ok': {
        if (!rd) return '';
        const now = Date.now();
        const figs = figures(now);
        const sh = showing(now);
        const wet = figs.filter(f => f.mm >= DRY - 1e-9).length;
        const head = !figs.length
          ? 'No rain gauge has been heard from in this window.'
          : `${figs.length.toLocaleString()} gauge${figs.length === 1 ? '' : 's'} heard, `
            + `${wet ? `${wet.toLocaleString()} with rain` : 'every one of them dry'} ${esc(sh.words)}.`;
        const cap = rd.capped ? ' <span class="txt-bad">Only the first readings were read — the load hit its cap.</span>' : '';
        return `${head} ${topHtml(figs)}${cap}<br>Between the gauges, not radar: nothing is painted further than `
          + `${prefs.reach()} km from one. As at ${esc(clock(rd.at))}, read again every ${TTL / MINUTE} minutes while on. `
          + '<button type="button" class="link-btn" onclick="MapRain.refresh()">Read again now</button>';
      }
      default:
        return '';
    }
  }

  function lapseHtml() {
    if (!lapse) {
      return `<div class="mn-rain-lapse">
        <button type="button" onclick="MapRain.play()"
                title="The rain in each hour of the last ${LAPSE_H} hours, one after another, on the mm-an-hour scale.">▶ Play the last ${LAPSE_H} hours</button>
      </div>`;
    }
    const now = Date.now();
    const f = lapseFrames(now)[lapse.i];
    return `<div class="mn-rain-lapse is-on">
      <div class="mn-rain-lapse-btns">
        <button type="button" onclick="MapRain.${lapse.playing ? 'pause' : 'play'}()" aria-pressed="${lapse.playing}">${
          lapse.playing ? '⏸ Pause' : '▶ Play'}</button>
        <button type="button" onclick="MapRain.stopLapse()">Back to the window</button>
      </div>
      <label class="filter-range">
        <span>The rain in the hour <strong id="rain-lapse-when">${esc(frameWords(f, now))}</strong></span>
        <input type="range" id="rain-lapse-range" min="0" max="${LAPSE_H - 1}" step="1" value="${lapse.i}"
               aria-label="Hour shown" aria-valuetext="${escAttr(frameWords(f, now))}"
               oninput="MapRain.frame(+this.value)">
      </label>
    </div>`;
  }

  function controlsHtml() {
    const on = !!state.mapRain;
    const op = prefs.opacity(), reach = prefs.reach();
    const sh = showing(Date.now());
    return `
    <label class="filter-check"
           title="The rain the network’s own gauges have measured, painted between them: a total over a window you pick, or the heaviest hour in it, each gauge’s figure beside its station from zoom ${FIG_ZOOM}, and the last ${LAPSE_H} hours played back an hour at a time. Out of the Flood-Net datastore; signed in or not.">
      <input type="checkbox" ${on ? 'checked' : ''}
             onchange="MapRain.setEnabled(this.checked)">
      Rainfall heat map (the network’s gauges)
    </label>
    ${on ? `
    <label class="filter-field">
      <span>Rain over</span>
      <select aria-label="Rain window" onchange="MapRain.setWindow(this.value)" ${lapse ? 'disabled' : ''}>
        ${WINDOWS.map(w => `<option value="${w.k}" ${prefs.win() === w.k ? 'selected' : ''}>${esc(w.label)}</option>`).join('')}
      </select>
    </label>
    <label class="filter-field">
      <span>Show</span>
      <select aria-label="Rain measure" onchange="MapRain.setMeasure(this.value)" ${lapse ? 'disabled' : ''}>
        ${MEASURES.map(m => `<option value="${m.k}" ${prefs.measure() === m.k ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
      </select>
    </label>
    ${lapseHtml()}
    <label class="filter-range">
      <span>Rain opacity <strong id="rain-opacity-val" aria-hidden="true">${Math.round(op * 100)}%</strong></span>
      <input type="range" min="${OPACITY.min}" max="${OPACITY.max}" step="0.05" value="${op}"
             aria-label="Rain heat map opacity"
             aria-valuetext="${Math.round(op * 100)} per cent"
             oninput="document.getElementById('rain-opacity-val').textContent=Math.round(this.value*100)+'%';this.setAttribute('aria-valuetext',Math.round(this.value*100)+' per cent');MapRain.setOpacity(+this.value)">
    </label>
    <label class="filter-range"
           title="How far from a gauge its figure is spread. Nothing is painted further than this from every gauge, and the colour fades over the last part of it.">
      <span>Spread from each gauge <strong id="rain-reach-val" aria-hidden="true">${reach} km</strong></span>
      <input type="range" min="${REACH.min}" max="${REACH.max}" step="${REACH.step}" value="${reach}"
             aria-label="Spread from each gauge, kilometres"
             aria-valuetext="${reach} kilometres"
             oninput="document.getElementById('rain-reach-val').textContent=this.value+' km';this.setAttribute('aria-valuetext',this.value+' kilometres');MapRain.setReach(+this.value)">
    </label>
    <label class="filter-check filter-sub">
      <input type="checkbox" ${prefs.figures() ? 'checked' : ''} onchange="MapRain.setFigures(this.checked)">
      Each gauge’s figure beside its station (wet from zoom ${FIG_ZOOM}, dry too from ${ALL_FIG_ZOOM})
    </label>
    ${rampHtml(sh.scale)}` : ''}
    <p class="filter-note" id="map-rain-note">${noteHtml()}</p>`;
  }

  function legendHtml() {
    const now = Date.now();
    const sh = showing(now);
    const what = sh.lapse ? 'mm in the hour'
      : sh.measure === 'peak' ? 'the most in any hour, mm/h' : 'mm fallen';
    return `
    <div class="legend-rain">
      <span class="small"><strong>Rain</strong> ${esc(sh.words)} — ${what}, from ${painted.heard.toLocaleString()} gauge${
        painted.heard === 1 ? '' : 's'} heard (${painted.wet.toLocaleString()} wet). Painted between them, not radar:
        clear further than ${prefs.reach()} km from one, and where it was dry</span>
      ${rampHtml(sh.scale)}
    </div>`;
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) {
        const p = m.createPane(PANE);
        p.style.zIndex = PANE_Z;
        p.style.pointerEvents = 'none';
      }
      if (!m.getPane(FIG_PANE)) m.createPane(FIG_PANE).style.zIndex = FIG_PANE_Z;
      m.on('moveend', onMove);
      if (state.mapRain) { run(false); startBeat(); }
    },

    detach() {
      clearTimeout(timer);
      clearTimeout(noteTimer);
      clearInterval(beat);
      stopLapse();
      if (map) map.off('moveend', onMove);
      clearLayers();
      map = null;
      seq++;
    },

    // Does the legend claim a key right now?
    active() { return !!(state.mapRain && map && covers(Date.now())); },
    controlsHtml,
    legendHtml,
    noteHtml,

    // Off by default and remembered: a layer that reads the datastore and
    // paints over everything is the operator's to ask for, and one who has
    // asked for it means it next time too.
    setEnabled(on) {
      state.mapRain = !!on;
      writePref('mn-rain', on ? 'on' : 'off');
      if (!on) {
        clearTimeout(timer); clearInterval(beat); stopLapse(); seq++;
        clearLayers(); setNote('off');
      } else if (map) { run(false); startBeat(); }
      rerender();
    },

    setWindow(k) {
      if (!WINDOW_BY[k]) return;
      writePref('mn-rain-win', k);
      run(false);
      rerender();
    },

    setMeasure(k) {
      if (!MEASURE_BY[k]) return;
      writePref('mn-rain-measure', k);
      paint();
      rerender();
    },

    setOpacity(v) {
      const n = Math.max(OPACITY.min, Math.min(OPACITY.max, Number(v) || OPACITY.def));
      writePref('mn-rain-op', n);
      if (overlay) overlay.setOpacity(n);
    },

    setReach(v) {
      const n = Math.max(REACH.min, Math.min(REACH.max, Math.round((Number(v) || REACH.def) / REACH.step) * REACH.step));
      writePref('mn-rain-reach', n);
      schedule();
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => {
        if (note.kind === 'ok') setNote('ok');
        if (typeof rerenderMapLegend === 'function') rerenderMapLegend();
      }, DEBOUNCE_MS * 2);
    },

    setFigures(on) {
      writePref('mn-rain-figs', on ? 'on' : 'off');
      paint();
    },

    refresh() { run(true); },

    // The time-lapse: play from where it stands (the oldest hour when it
    // starts), pause, step to a frame, and back to the window.
    play() {
      if (!state.mapRain) return;
      const starting = !lapse;
      if (starting) lapse = { i: 0, playing: true, timer: null };
      else { clearTimeout(lapse.timer); lapse.playing = true; }
      rerender();
      showFrame();
      lapse.timer = setTimeout(lapseTick, LAPSE_MS);
    },
    pause() {
      if (!lapse) return;
      clearTimeout(lapse.timer);
      lapse.playing = false;
      rerender();
    },
    frame(i) {
      const n = Math.round(Number(i));
      if (!(n >= 0 && n < LAPSE_H)) return;
      if (!lapse) { lapse = { i: n, playing: false, timer: null }; rerender(); }
      else { clearTimeout(lapse.timer); lapse.i = n; if (lapse.playing) { lapse.playing = false; rerender(); } }
      showFrame();
    },
    stopLapse() {
      stopLapse();
      paint();
      rerender();
    },

    toStation(id) {
      if (typeof goToStation === 'function') goToStation(id);
    },

    // What is on the map, and what each gauge said — copies, read by the
    // check and by nothing else.
    _figures: () => figures().map(f => ({ addr: f.g.addr, id: f.g.id, mm: f.mm, heard: f.s.heard })),
    _painted: () => ({ ...painted, overlay: !!overlay, figs: figLayer ? figLayer.getLayers().length : 0,
                       opacity: overlay ? overlay.options.opacity : null }),
    _note: () => ({ ...note }),
    _lapse: () => (lapse ? { i: lapse.i, playing: lapse.playing } : null),
    _loaded: () => (rd ? { from: rd.from, at: rd.at, rows: rd.rows, gauges: rd.gauges, heard: rd.series.size } : null),
    _pure: { binOf, colourOf, last9am, windowSpan, windowWords, lapseFrames, tipsIn, buildIndex, sampleAt, fadeAt,
             seriesOf, fmtMm, needFrom, SCALES, PALETTE, WINDOWS, MEASURES, REACH, DRY, LOOKBACK, LAPSE_H, CHUNK },
  };
})();
if (typeof window !== 'undefined') window.MapRain = MapRain;
