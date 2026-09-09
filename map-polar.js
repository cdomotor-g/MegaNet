// MegaNet — map-polar.js
//
//   MapPolar   Radio Mobile's Single polar radio coverage, on the Stations
//              map: pick a centre, pick the radio at the other end, and paint
//              what it would hear all the way round.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, fmtKm, destPoint,
// acmaHaversineKm, cssVar, slug and dlText; across to terrain.js for
// Terrain.grid, itm.js for ITM.pointToPoint, path-profile.js for rmSystemOf,
// pathPropOf, wattsToDbm and the PATH_DEFAULT_* constants, map-controls.js
// for MapChrome.panel, and app.js for rerenderMapLegend and mapNote. All of it
// from inside its own functions, so this file's position among the modules is
// free.
//
// ── What it is ───────────────────────────────────────────────────────────────
// Every propagation tool in this app so far answers a question about a *link*:
// two ends, one path, one number. This answers the question a planner asks
// before there is a second end — "if I put a radio here, who could work it?" —
// by running the same Longley–Rice model down several hundred radials and
// colouring the ground by what a mobile would hear standing on it.
//
// The dialog it is modelled on is Radio Mobile's, control for control: a
// centre unit, a mobile unit, the direction the link is being asked about, a
// radial range, an azimuth range with a step, and a threshold with a from and
// a to. Where this departs from it, it departs deliberately and says so on the
// panel:
//
//   * The mobile end is an rm_systems row rather than a "unit", because that
//     is where transmit power, gain, line loss and receiver threshold live in
//     this dataset, and a unit here would be a station — which is the one
//     thing a coverage plot is *not* about.
//   * There are no antenna patterns. Radio Mobile has them and this does not;
//     a pattern only ever *reduces* real coverage off boresight, so every
//     figure below is the omnidirectional best case. The panel says so where
//     it cannot be missed, for the same reason the link budget's banner cannot
//     be dismissed.
//   * There is no land cover and no terminal clutter. The elevation profile
//     card stands trees on the ground and charges P.2108 at a mast under them;
//     this does not, because the cover raster is one fetch per path and this
//     draws eleven thousand of them. So the plot is **optimistic against the
//     profile card** — by whatever the trees on a given path are worth, which
//     is not a figure this can put a number on. The panel and the legend both
//     say so, and the card remains the authority for any path anybody is about
//     to build.
//
// ── How it is made fast enough to be usable ──────────────────────────────────
// The naive shape — one terrain profile per sample point — is tens of
// thousands of tile lookups and minutes of waiting. Instead:
//
//   1. ONE elevation grid is fetched over the whole plot (Terrain.grid), and
//      every radial is read out of it by bilinear interpolation. After that
//      first fetch the job is pure arithmetic and needs no network at all.
//   2. Each radial is sampled once, end to end, into a reusable PFL buffer.
//      A ring is then just a shorter read of the same buffer — pfl[0] is the
//      number of intervals, so the model is handed a prefix of the ray rather
//      than a freshly built array per ring.
//   3. The model runs at ring boundaries, not at every sample: 32 range bands
//      is a plot nobody can tell from 128 at map scale, and it is a quarter of
//      the arithmetic.
//   4. The work is chunked a radial at a time against the clock, so the panel
//      stays alive, the progress figure moves and Cancel is answered inside a
//      frame.
//
// What comes back is kept as *levels*, not as colours: changing the threshold
// or the palette re-paints from the stored figures and costs nothing, which is
// the same separation MapFade makes between a margin and the band it lands in.
const MapPolar = (function () {
  const PANE   = 'mnPolar';
  // Above the wind regions (330) and below the LiDAR contours (335) in the
  // z-index budget map-survey.js documents: this is basemap-like context — a
  // wash of colour over the ground — so everything drawn to be read goes over
  // the top of it, and it takes no pointer at all.
  const PANE_Z = 332;

  const RINGS       = 32;    // range bands the model is run at
  const RAY_SAMPLES = 128;   // terrain samples along each radial, end to end
  const GRID_N      = 384;   // elevation grid across the plot's box
  const CANVAS_MAX  = 1100;  // px on the long side of the rendered overlay
  const CHUNK_MS    = 20;    // arithmetic per frame, so the panel stays alive
  const HIT_CAP     = 8;     // stations offered by the centre-unit search
  const STORE       = 'mn-polar-v1';

  const DIRS = {
    tx:    { label: 'Centre Tx → Mobile Rx', short: 'centre transmitting' },
    rx:    { label: 'Centre Rx → Mobile Tx', short: 'centre receiving' },
    worst: { label: 'Worst case', short: 'the worse of the two directions' },
  };

  // Radio Mobile's rainbow, strongest first. Twelve steps because its own
  // colour files are twelve, and because a band an operator can point at beats
  // a gradient they have to guess at — the same argument map-elevation.js
  // makes about the elevation ramp.
  const RAINBOW = ['#ff0000', '#ff4000', '#ff8000', '#ffc000', '#ffff00', '#c0ff00',
                   '#40ff00', '#00ff80', '#00ffff', '#00a0ff', '#4040ff', '#0000ff'];

  const cfg = load();

  let map = null, overlay = null, body = null;
  let job = null;        // the run in flight: { cancelled, done, total }
  let plot = null;       // the finished run: { level, margin, lattice, box, … }
  let status = { kind: 'idle', text: '' };
  let hitQ = '';

  // ── Settings ────────────────────────────────────────────────────────────────

  function defaults() {
    return {
      centre: 'station',        // 'station' | 'map'
      centreId: null,
      centreAgl: null,          // null = the centre system's own height
      mobileSysId: null,
      mobileAgl: null,
      dir: 'worst',
      rMinKm: 0.01, rMaxKm: 50,
      azMin: 0, azMax: 360, azStep: 1,
      unit: 'dbm',              // 'dbm' | 'margin'
      fromDbm: -110, toDbm: -60,
      fromDb: 0, toDb: 30,
      freqMhz: null,            // null = whatever the ends imply
      rainbow: true,
      opacity: 0.65,
    };
  }

  function load() {
    const d = defaults();
    try { return Object.assign(d, JSON.parse(localStorage.getItem(STORE) || '{}')); }
    catch (_) { return d; }
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(cfg)); }
    catch (_) { /* private browsing, a full quota — it still holds this session */ }
  }

  // ── The two ends ────────────────────────────────────────────────────────────

  function centreStation() {
    if (cfg.centre !== 'station' || cfg.centreId == null || !state.data) return null;
    return (state.data.stations || []).find(s => s.id === cfg.centreId) || null;
  }

  function systems() {
    return ((state.data && state.data.rm_systems) || [])
      .filter(r => r.tx_power_w != null && r.antenna_gain_dbi != null
                && r.line_loss_db != null && r.rx_threshold_dbm != null);
  }

  function mobileSystem() {
    const list = systems();
    if (!list.length) return null;
    return list.find(r => r.id === cfg.mobileSysId) || list[0];
  }

  // The radio at the centre: the station's own rm_system, or — for a plot
  // pinned to the middle of the map, where there is no station to ask — the
  // same system the mobile end is using. A hypothetical mast with a radio
  // nobody chose would be this tool inventing a network.
  function centreRadio() {
    const st = centreStation();
    const sys = st ? rmSystemOf(st) : mobileSystem();
    if (!sys) return null;
    return {
      name: st ? st.name : 'the middle of the map',
      txW:  sys.tx_power_w, gain: sys.antenna_gain_dbi,
      loss: sys.line_loss_db, thr: sys.rx_threshold_dbm,
      agl:  cfg.centreAgl != null ? cfg.centreAgl
            : (sys.antenna_height_m != null ? sys.antenna_height_m : PATH_DEFAULT_AGL),
      elev: st && st.elevation_ahd != null ? st.elevation_ahd : null,
      sysName: sys.name,
    };
  }

  function mobileRadio() {
    const sys = mobileSystem();
    if (!sys) return null;
    return {
      name: sys.name,
      txW: sys.tx_power_w, gain: sys.antenna_gain_dbi,
      loss: sys.line_loss_db, thr: sys.rx_threshold_dbm,
      agl: cfg.mobileAgl != null ? cfg.mobileAgl
           : (sys.antenna_height_m != null ? sys.antenna_height_m : PATH_DEFAULT_AGL),
    };
  }

  function centreLatLon() {
    const st = centreStation();
    if (st && st.lat != null && st.lon != null) return [st.lat, st.lon];
    if (cfg.centre === 'map' && map) { const c = map.getCenter(); return [c.lat, c.lng]; }
    return null;
  }

  function freqMhz() {
    if (cfg.freqMhz > 0) return cfg.freqMhz;
    const st = centreStation();
    const r = st && st.repeater;
    return r && r.rx_mhz > 0 ? r.rx_mhz : PATH_DEFAULT_MHZ;
  }

  // Everything the plot needs, or the first reason it cannot be drawn. The
  // link budget's rule, inherited: a term nobody supplied blanks the answer
  // rather than being read as nought.
  function readiness() {
    if (!state.data) return { ok: false, why: 'No stations are loaded.' };
    const ll = centreLatLon();
    if (!ll) return { ok: false, why: 'Pick a centre unit — a station, or the middle of the map.' };
    const c = centreRadio(), m = mobileRadio();
    if (!m) return { ok: false, why: 'No radio system on file carries all four of transmit power, antenna gain, line loss and receiver threshold — there is nothing to compute a level from.' };
    if (!c) return { ok: false, why: 'The centre unit has no radio system on file.' };
    const missing = [
      [wattsToDbm(c.txW), 'transmit power at the centre'],
      [c.gain, 'antenna gain at the centre'], [c.loss, 'line loss at the centre'],
      [c.thr, 'receiver threshold at the centre'],
      [wattsToDbm(m.txW), 'transmit power on the mobile'],
      [m.gain, 'antenna gain on the mobile'], [m.loss, 'line loss on the mobile'],
      [m.thr, 'receiver threshold on the mobile'],
    ].filter(([v]) => v == null).map(([, l]) => l);
    if (missing.length) {
      return { ok: false, why: `No figure on file for ${missing.join(', ')}.` };
    }
    if (!(cfg.rMaxKm > cfg.rMinKm)) return { ok: false, why: 'The maximum radial range has to be greater than the minimum.' };
    if (!(cfg.azStep > 0)) return { ok: false, why: 'The azimuth step has to be greater than nought.' };
    return { ok: true, ll, c, m };
  }

  // ── The maths ───────────────────────────────────────────────────────────────

  // The plot's box: the circle's four extremes, which is a rectangle in
  // degrees and very nearly a square in metres at these latitudes.
  function boxOf(ll, rKm) {
    const n = destPoint(ll[0], ll[1], 0, rKm), s = destPoint(ll[0], ll[1], 180, rKm);
    const e = destPoint(ll[0], ll[1], 90, rKm), w = destPoint(ll[0], ll[1], 270, rKm);
    return { north: n[0], south: s[0], east: e[1], west: w[1] };
  }

  // Ground height anywhere in the box, bilinear over the grid. NaN where a
  // tile never arrived — terrain.js's loud-failure rule reaches all the way
  // out here, because a hole read as sea level is a plot claiming coverage
  // over ground it has never seen.
  function sampleGrid(g, box, lat, lon) {
    const fx = (lon - box.west) / (box.east - box.west) * (g.nx - 1);
    const fy = (box.north - lat) / (box.north - box.south) * (g.ny - 1);
    if (!(fx >= 0) || !(fy >= 0) || fx > g.nx - 1 || fy > g.ny - 1) return NaN;
    const x0 = Math.min(g.nx - 2, Math.floor(fx)), y0 = Math.min(g.ny - 2, Math.floor(fy));
    const tx = fx - x0, ty = fy - y0;
    const e = g.elev;
    const a = e[y0 * g.nx + x0],       b = e[y0 * g.nx + x0 + 1];
    const c = e[(y0 + 1) * g.nx + x0], d = e[(y0 + 1) * g.nx + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  // How many radials, and where each one points.
  function rays() {
    const span = Math.abs(cfg.azMax - cfg.azMin) >= 360 ? 360
               : ((cfg.azMax - cfg.azMin) % 360 + 360) % 360 || 360;
    const n = Math.max(1, Math.min(1440, Math.round(span / cfg.azStep)));
    return { n, span, az: i => cfg.azMin + span * i / n };
  }

  // The one number every cell is coloured by. Both directions are computed
  // whatever the setting says, because "worst case" needs them both and the
  // other two are a choice between them — and because the margin and the
  // received level are the same arithmetic stopped one term apart.
  // The two EIRPs and the two thresholds, worked out once for the whole run
  // rather than once per cell: everything except the path loss is constant
  // across eleven thousand of them.
  function endsFor(c, m) {
    return {
      cTx: wattsToDbm(c.txW) + c.gain - c.loss,          // centre EIRP
      mTx: wattsToDbm(m.txW) + m.gain - m.loss,          // mobile EIRP
      cRx: c.gain - c.loss, mRx: m.gain - m.loss,
      cThr: c.thr, mThr: m.thr,
    };
  }

  function levelsFrom(A_db, e) {
    const rxAtMobile = e.cTx - A_db + e.mRx;             // centre transmitting
    const rxAtCentre = e.mTx - A_db + e.cRx;             // centre receiving
    return {
      tx: { rx: rxAtMobile, margin: rxAtMobile - e.mThr },
      rx: { rx: rxAtCentre, margin: rxAtCentre - e.cThr },
    };
  }

  // ── The run ─────────────────────────────────────────────────────────────────

  function setStatus(kind, text) {
    status = { kind, text: text || '' };
    const el = document.getElementById('polar-status');
    if (el) el.innerHTML = statusHtml();
    const btn = document.getElementById('polar-draw');
    if (btn) btn.disabled = kind === 'running';
    const cancel = document.getElementById('polar-cancel');
    if (cancel) cancel.hidden = kind !== 'running';
  }

  function draw() {
    const r = readiness();
    if (!r.ok) { setStatus('blocked', r.why); return; }
    if (job) job.cancelled = true;
    clearOverlay();

    const { ll, c, m } = r;
    const box = boxOf(ll, cfg.rMaxKm);
    const ray = rays();
    const mine = job = { cancelled: false };
    setStatus('running', 'Fetching the terrain under the plot…');

    Terrain.grid(box, GRID_N, GRID_N).then(g => {
      if (mine.cancelled) return;
      if (!g.ok) { job = null; setStatus('blocked', g.error); return; }

      // The lattice: every ring boundary on every radial, once. The wedges are
      // drawn from it and the terrain is read along it, so a coordinate is
      // computed once and used twice.
      const dxM   = cfg.rMaxKm * 1000 / RAY_SAMPLES;
      const iMin  = Math.max(1, Math.round(cfg.rMinKm * 1000 / dxM));
      const bandI = [];                        // sample index at each ring edge
      for (let k = 0; k <= RINGS; k++) {
        bandI.push(Math.round(iMin + (RAY_SAMPLES - iMin) * k / RINGS));
      }

      const nR = ray.n;
      const lat = new Float64Array((nR + 1) * (RINGS + 1));
      const lon = new Float64Array((nR + 1) * (RINGS + 1));
      const lvlTx = new Float32Array(nR * RINGS);
      const lvlRx = new Float32Array(nR * RINGS);
      const mgTx  = new Float32Array(nR * RINGS);
      const mgRx  = new Float32Array(nR * RINGS);
      lvlTx.fill(NaN); lvlRx.fill(NaN); mgTx.fill(NaN); mgRx.fill(NaN);

      // One PFL buffer for the whole run. pfl[0] is the interval count and
      // pfl[1] the spacing, so a ring is the same buffer with a shorter count.
      const pfl = new Float64Array(RAY_SAMPLES + 3);
      pfl[1] = dxM;
      const prop = pathPropOf({});
      const f = freqMhz();
      const ends = endsFor(c, m);
      // The mast has to be standing on something. A surveyed height wins; the
      // grid answers otherwise; and if neither can, the plot is refused rather
      // than drawn off a centre at an invented sea level — every level in it
      // would be wrong by whatever the hill under the centre is worth, and
      // nothing on screen would say so.
      const centreGround = c.elev != null ? c.elev : sampleGrid(g, box, ll[0], ll[1]);
      if (!isFinite(centreGround)) {
        job = null;
        setStatus('blocked', 'No ground height at the centre — the terrain tile under it is missing.');
        return;
      }

      // Corner points on every radial, including the outer ring edge, so a
      // wedge can be drawn from four lattice entries and nothing else.
      for (let i = 0; i <= nR; i++) {
        const az = ray.az(i);
        for (let k = 0; k <= RINGS; k++) {
          const km = bandI[k] * dxM / 1000;
          const p = destPoint(ll[0], ll[1], az, km);
          lat[i * (RINGS + 1) + k] = p[0];
          lon[i * (RINGS + 1) + k] = p[1];
        }
      }

      let i = 0, bad = 0;
      const step = () => {
        if (mine.cancelled) return;
        const until = performance.now() + CHUNK_MS;
        while (i < nR && performance.now() < until) {
          const az = ray.az(i);
          // The radial, sampled end to end once.
          pfl[2] = centreGround;
          let holes = 0;
          for (let n = 1; n <= RAY_SAMPLES; n++) {
            const p = destPoint(ll[0], ll[1], az, n * dxM / 1000);
            const h = sampleGrid(g, box, p[0], p[1]);
            if (isNaN(h)) { holes++; pfl[n + 2] = pfl[n + 1]; }   // hold the last height
            else pfl[n + 2] = h;
          }
          if (holes > RAY_SAMPLES / 4) { bad++; i++; continue; }  // too little ground to answer

          for (let k = 0; k < RINGS; k++) {
            const np = bandI[k + 1];
            if (np < 2) continue;
            pfl[0] = np;
            const res = ITM.pointToPoint({
              pfl, hTx: c.agl, hRx: m.agl, fMhz: f,
              climate: prop.climate, N0: prop.N0, pol: prop.pol,
              epsilon: prop.epsilon, sigma: prop.sigma, mdvar: prop.mdvar,
              time: prop.time, location: prop.location, situation: prop.situation,
            });
            if (!res.ok) continue;
            const L = levelsFrom(res.A_db, ends);
            const at = i * RINGS + k;
            lvlTx[at] = L.tx.rx;  mgTx[at] = L.tx.margin;
            lvlRx[at] = L.rx.rx;  mgRx[at] = L.rx.margin;
          }
          i++;
        }
        if (i < nR) {
          setStatus('running', `${Math.round(i / nR * 100)}% — ${i} of ${nR} radials`);
          requestAnimationFrame(step);
          return;
        }
        job = null;
        plot = { lat, lon, nR, rings: RINGS, lvlTx, lvlRx, mgTx, mgRx, box,
                 centre: ll, res: g.resolution_m, tiles: g.tiles, missing: g.missing,
                 bad, fMhz: f, cName: c.name, mName: m.name, cAgl: c.agl, mAgl: m.agl,
                 rMinKm: bandI[0] * dxM / 1000, rMaxKm: cfg.rMaxKm,
                 az: { min: cfg.azMin, span: ray.span, step: ray.span / nR } };
        paint();
        setStatus('done', '');
        render();
        rerenderMapLegend();
      };
      requestAnimationFrame(step);
    }).catch(e => {
      if (mine.cancelled) return;
      job = null;
      setStatus('blocked', (e && e.message) || 'the terrain grid could not be built');
    });
  }

  // ── Painting ────────────────────────────────────────────────────────────────

  function values() {
    if (!plot) return null;
    if (cfg.unit === 'margin') {
      return cfg.dir === 'tx' ? plot.mgTx : cfg.dir === 'rx' ? plot.mgRx
           : plot.mgTx.map((v, n) => Math.min(v, plot.mgRx[n]));
    }
    return cfg.dir === 'rx' ? plot.lvlRx
         : cfg.dir === 'tx' ? plot.lvlTx
         : plot.lvlTx.map((v, n) => (plot.mgTx[n] <= plot.mgRx[n] ? v : plot.lvlRx[n]));
  }

  // The threshold, always low-to-high. Radio Mobile's dialog has a From box and
  // a To box and nothing stopping anybody filling them in the other way round;
  // a reversed span would divide the ramp by a negative and paint the strongest
  // ground blue, so it is normalised here rather than policed in the boxes. A
  // span of nothing is widened by a decibel — twelve bands over nought dB is a
  // division by zero, and one band is a plot that says only "yes" or "no".
  function span() {
    const raw = cfg.unit === 'margin' ? [cfg.fromDb, cfg.toDb] : [cfg.fromDbm, cfg.toDbm];
    let from = Math.min(raw[0], raw[1]), to = Math.max(raw[0], raw[1]);
    if (!(to > from)) to = from + 1;
    return { from, to };
  }

  // A value to one of the twelve bands, or null when it is under the floor —
  // under-threshold ground is left unpainted rather than painted a twelfth
  // colour, because the edge of the plot IS the answer and a wash to the
  // horizon hides it.
  function bandOf(v, s) {
    if (!isFinite(v) || v < s.from) return null;
    const t = (v - s.from) / (s.to - s.from);
    const n = RAINBOW.length;
    return Math.max(0, Math.min(n - 1, n - 1 - Math.floor(Math.min(0.9999, Math.max(0, t)) * n)));
  }

  function colourOf(band) {
    return cfg.rainbow ? RAINBOW[band] : cssVar('--accent', '#0b5cab');
  }

  function paint() {
    clearOverlay();
    if (!plot || !map) return;
    const vals = values();
    const s = span();
    const b = L.latLngBounds([plot.box.south, plot.box.west], [plot.box.north, plot.box.east]);
    const sw = L.CRS.EPSG3857.project(b.getSouthWest());
    const ne = L.CRS.EPSG3857.project(b.getNorthEast());
    const wSpan = ne.x - sw.x, hSpan = ne.y - sw.y;
    const cv = document.createElement('canvas');
    cv.width = cv.height = CANVAS_MAX;
    const cx = cv.getContext('2d');

    // Lattice → canvas pixels, once. The wedges are then four lookups each.
    const R1 = plot.rings + 1;
    const px = new Float32Array((plot.nR + 1) * R1);
    const py = new Float32Array((plot.nR + 1) * R1);
    for (let n = 0; n < px.length; n++) {
      const p = L.CRS.EPSG3857.project(L.latLng(plot.lat[n], plot.lon[n]));
      px[n] = (p.x - sw.x) / wSpan * cv.width;
      py[n] = (ne.y - p.y) / hSpan * cv.height;
    }

    for (let i = 0; i < plot.nR; i++) {
      for (let k = 0; k < plot.rings; k++) {
        const band = bandOf(vals[i * plot.rings + k], s);
        if (band == null) continue;
        const a = i * R1 + k, c2 = (i + 1) * R1 + k;
        cx.fillStyle = colourOf(band);
        cx.beginPath();
        cx.moveTo(px[a], py[a]);
        cx.lineTo(px[a + 1], py[a + 1]);
        cx.lineTo(px[c2 + 1], py[c2 + 1]);
        cx.lineTo(px[c2], py[c2]);
        cx.closePath();
        // A hairline stroke in the fill's own colour, because adjacent wedges
        // meeting on a diagonal leave a half-pixel of background between them
        // and 11,000 of those read as a moiré rather than as coverage.
        cx.fill();
        cx.strokeStyle = cx.fillStyle;
        cx.lineWidth = 1;
        cx.stroke();
      }
    }

    overlay = L.imageOverlay(cv.toDataURL('image/png'), b,
                             { pane: PANE, opacity: cfg.opacity, interactive: false }).addTo(map);
  }

  function clearOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  // A setting that changes *what would be computed* has to take the drawn plot
  // with it. A wash of colour that is still on the map while the panel above it
  // describes a different centre, a different range or a different pair of
  // radios is the one failure mode this tool has: it looks exactly like an
  // answer to the question now being asked, and it is an answer to the last
  // one. Threshold, palette, opacity and direction are not on this path —
  // those are a re-read of figures already in hand.
  function invalidate() {
    if (job) job.cancelled = true;
    job = null;
    clearOverlay();
    plot = null;
    setStatus('idle', '');
  }

  // ── Saving the numbers ──────────────────────────────────────────────────────
  // Radio Mobile's dialog has a **Save coverage data (TXT)** box in its corner,
  // and it is there for a reason a picture cannot serve: a plot is read, a
  // table is *checked*. One row per cell — where it is, how far out and round
  // from the centre, and all four figures the run computed, not only the one
  // currently painted — so the file answers questions the panel is not set to
  // at the moment it was written, and so a level can be taken to a spreadsheet
  // and argued with.
  //
  // The header carries the run's own conditions, commented with `#`, because a
  // column of dBm with no frequency, no antenna heights and no pair of radios
  // beside it is a column of numbers nobody can reproduce.
  function saveCsv() {
    if (!plot) return;
    const R1 = plot.rings + 1;
    const rows = [
      `# MegaNet polar radio coverage`,
      `# centre,${plot.cName},${plot.centre[0].toFixed(6)},${plot.centre[1].toFixed(6)},${plot.cAgl} m AGL`,
      `# mobile,${plot.mName},${plot.mAgl} m AGL`,
      `# frequency_mhz,${plot.fMhz.toFixed(3)}`,
      `# radial_km,${plot.rMinKm.toFixed(3)},${plot.rMaxKm}`,
      `# azimuth_deg,${plot.az.min},${plot.az.span},${plot.az.step.toFixed(3)}`,
      `# terrain,~${plot.res} m over ${plot.tiles} tiles, ${plot.missing} missing`,
      `# model,Longley-Rice point-to-point over bare terrain; no antenna patterns,`
        + ` no land cover, no terminal clutter — the best case`,
      'azimuth_deg,range_km,lat,lon,rx_dbm_centre_tx,margin_db_centre_tx,rx_dbm_centre_rx,margin_db_centre_rx',
    ];
    for (let i = 0; i < plot.nR; i++) {
      const az = plot.az.min + plot.az.span * i / plot.nR;
      for (let k = 0; k < plot.rings; k++) {
        const at = i * plot.rings + k;
        if (!isFinite(plot.lvlTx[at])) continue;
        const n = i * R1 + k + 1;                 // the band's outer edge, where it was computed
        rows.push([
          az.toFixed(3),
          acmaHaversineKm(plot.centre[0], plot.centre[1], plot.lat[n], plot.lon[n]).toFixed(4),
          plot.lat[n].toFixed(6), plot.lon[n].toFixed(6),
          plot.lvlTx[at].toFixed(2), plot.mgTx[at].toFixed(2),
          plot.lvlRx[at].toFixed(2), plot.mgRx[at].toFixed(2),
        ].join(','));
      }
    }
    dlText(`polar-coverage-${slug(plot.cName)}-${plot.rMaxKm}km.csv`, rows.join('\n') + '\n');
  }

  // ── The panel ───────────────────────────────────────────────────────────────

  function hits() {
    const q = hitQ.trim().toLowerCase();
    const all = ((state.data && state.data.stations) || []).filter(s => s.lat != null && s.lon != null);
    if (!q) return all.slice(0, HIT_CAP);
    return all.filter(s => (s.name || '').toLowerCase().includes(q)
                        || String(s.station_number || '').toLowerCase().includes(q))
              .slice(0, HIT_CAP);
  }

  function hitsHtml() {
    const st = centreStation();
    return hits().map(s => `
      <button type="button" class="polar-hit${st && st.id === s.id ? ' is-here' : ''}"
              onclick="MapPolar.pickCentre('${escAttr(s.id)}')">
        <span>${esc(s.name)}</span>
        <span class="small txt-muted">${esc(s.station_number || '')}</span>
      </button>`).join('') || '<p class="small txt-muted">No station by that name.</p>';
  }

  function num(id, label, value, step, unit, min, max) {
    return `
      <label class="draw-field">
        <span>${esc(label)}</span>
        <input type="number" id="polar-${id}" value="${value == null ? '' : value}"
               step="${step}"${min == null ? '' : ` min="${min}"`}${max == null ? '' : ` max="${max}"`}
               onchange="MapPolar.set('${id}', this.value)">
        ${unit ? `<b class="lb-flag">${esc(unit)}</b>` : ''}
      </label>`;
  }

  function statusHtml() {
    switch (status.kind) {
      case 'running':
        return `<span class="polar-run">Drawing… ${esc(status.text)}</span>`;
      case 'blocked':
        return `<span class="txt-warn">${esc(status.text)}</span>`;
      case 'done':
        if (!plot) return '';
        return `Drawn: ${plot.nR} radial${plot.nR === 1 ? '' : 's'} at ${plot.az.step.toFixed(2)}°,
          ${plot.rings} range bands out to ${fmtKm(plot.rMaxKm)}, at ${plot.fMhz.toFixed(3)} MHz.
          Terrain sampled every ~${plot.res} m over ${plot.tiles} tile${plot.tiles === 1 ? '' : 's'}${
          plot.missing ? `, <span class="txt-warn">${plot.missing} of them missing</span>` : ''}${
          plot.bad ? `, <span class="txt-warn">${plot.bad} radial${plot.bad === 1 ? '' : 's'} skipped for want of ground</span>` : ''}.`;
      default: {
        // Idle. A disabled Draw button with nothing beside it is a dead end —
        // say what is missing before it is pressed rather than after.
        const r = readiness();
        return r.ok ? '' : `<span class="txt-muted">${esc(r.why)}</span>`;
      }
    }
  }

  function keyHtml() {
    const s = span();
    const n = RAINBOW.length;
    return `<ul class="polar-key">${RAINBOW.map((hex, i) => {
      const hi = s.to - (s.to - s.from) * i / n;
      const lo = s.to - (s.to - s.from) * (i + 1) / n;
      return `<li><i style="--dot:${cfg.rainbow ? hex : colourOf(0)}"></i><span>${
        lo.toFixed(0)} to ${hi.toFixed(0)} ${cfg.unit === 'margin' ? 'dB' : 'dBm'}</span></li>`;
    }).join('')}</ul>`;
  }

  function panelHtml() {
    if (!state.data) {
      return '<p class="filter-note">No stations are loaded, so there is no centre unit to plot from.</p>';
    }
    const st = centreStation();
    const sys = systems();
    const m = mobileSystem();
    const r = readiness();
    return `
      <div class="polar-panel">
        <fieldset class="polar-fs">
          <legend>Centre unit</legend>
          <label class="filter-check">
            <input type="radio" name="polar-centre" value="station" ${cfg.centre === 'station' ? 'checked' : ''}
                   onchange="MapPolar.set('centre','station')"> A station
          </label>
          <label class="filter-check">
            <input type="radio" name="polar-centre" value="map" ${cfg.centre === 'map' ? 'checked' : ''}
                   onchange="MapPolar.set('centre','map')"> The middle of the map
          </label>
          ${cfg.centre === 'station' ? `
            <input type="search" id="polar-find" class="polar-find" autocomplete="off" spellcheck="false"
                   value="${escAttr(hitQ)}" placeholder="Name or station #"
                   aria-label="Find the centre station"
                   oninput="MapPolar.setSearch(this.value)">
            <p class="small polar-picked">${st
              ? `Centre: <strong>${esc(st.name)}</strong>${st.elevation_ahd != null
                  ? ` · ${Math.round(st.elevation_ahd)} m AHD` : ' · height from the terrain tiles'}`
              : 'No centre picked yet.'}</p>
            <div class="polar-hits" id="polar-hits">${hitsHtml()}</div>`
            : `<p class="small polar-picked">Centre: <strong>the middle of the map</strong> —
                 a hypothetical mast, using the mobile unit's own radio system.</p>`}
          ${num('centreAgl', 'Antenna height', cfg.centreAgl, 0.5, 'm AGL', 0)}
        </fieldset>

        <fieldset class="polar-fs">
          <legend>Mobile unit</legend>
          ${sys.length ? `
            <label class="filter-field">
              <span>Radio system</span>
              <select onchange="MapPolar.set('mobileSysId', this.value)">
                ${sys.map(x => `<option value="${x.id}" ${m && m.id === x.id ? 'selected' : ''}>${
                  esc(x.name)} — ${x.tx_power_w} W, ${x.antenna_gain_dbi} dBi, ${x.rx_threshold_dbm} dBm</option>`).join('')}
              </select>
            </label>
            ${num('mobileAgl', 'Antenna height', cfg.mobileAgl, 0.5, 'm AGL', 0)}`
            : '<p class="small txt-warn">No radio system on file carries all four of the figures a level needs.</p>'}
        </fieldset>

        <fieldset class="polar-fs">
          <legend>Link direction</legend>
          ${Object.entries(DIRS).map(([k, d]) => `
            <label class="filter-check">
              <input type="radio" name="polar-dir" value="${k}" ${cfg.dir === k ? 'checked' : ''}
                     onchange="MapPolar.set('dir','${k}')"> ${esc(d.label)}
            </label>`).join('')}
        </fieldset>

        <fieldset class="polar-fs">
          <legend>Radial range</legend>
          ${num('rMinKm', 'Minimum', cfg.rMinKm, 0.01, 'km', 0)}
          ${num('rMaxKm', 'Maximum', cfg.rMaxKm, 1, 'km', 0.1)}
        </fieldset>

        <fieldset class="polar-fs">
          <legend>Azimuth range</legend>
          ${num('azMin', 'From', cfg.azMin, 1, '°', -360, 360)}
          ${num('azMax', 'To', cfg.azMax, 1, '°', -360, 720)}
          ${num('azStep', 'Step', cfg.azStep, 0.5, '°', 0.25, 30)}
        </fieldset>

        <fieldset class="polar-fs">
          <legend>Threshold</legend>
          <label class="filter-check">
            <input type="radio" name="polar-unit" ${cfg.unit === 'dbm' ? 'checked' : ''}
                   onchange="MapPolar.set('unit','dbm')"> Received level (dBm)
          </label>
          <label class="filter-check">
            <input type="radio" name="polar-unit" ${cfg.unit === 'margin' ? 'checked' : ''}
                   onchange="MapPolar.set('unit','margin')"> Fade margin (dB over threshold)
          </label>
          ${cfg.unit === 'margin'
            ? num('fromDb', 'From', cfg.fromDb, 1, 'dB') + num('toDb', 'To', cfg.toDb, 1, 'dB')
            : num('fromDbm', 'From', cfg.fromDbm, 1, 'dBm') + num('toDbm', 'To', cfg.toDbm, 1, 'dBm')}
          ${num('freqMhz', 'Frequency', cfg.freqMhz, 0.001, 'MHz', 20, 20000)}
          <p class="small txt-muted">Frequency blank follows the centre station's repeater,
            else the network's ${PATH_DEFAULT_MHZ} MHz band.</p>
        </fieldset>

        <fieldset class="polar-fs">
          <legend>Plot</legend>
          <label class="filter-check">
            <input type="checkbox" ${cfg.rainbow ? 'checked' : ''}
                   onchange="MapPolar.set('rainbow', this.checked)"> Rainbow
          </label>
          <label class="filter-range">
            <span>Opacity <strong>${Math.round(cfg.opacity * 100)}%</strong></span>
            <input type="range" min="0.15" max="1" step="0.05" value="${cfg.opacity}"
                   aria-label="Coverage opacity"
                   onchange="MapPolar.set('opacity', this.value)">
          </label>
          ${keyHtml()}
        </fieldset>

        <div class="polar-actions">
          <button type="button" id="polar-draw" onclick="MapPolar.draw()"
                  ${r.ok ? '' : 'disabled'}>Draw</button>
          <button type="button" id="polar-cancel" onclick="MapPolar.cancel()" hidden>Cancel</button>
          <button type="button" onclick="MapPolar.clear()" ${plot ? '' : 'disabled'}>Clear</button>
          <button type="button" onclick="MapPolar.save()" ${plot ? '' : 'disabled'}
                  title="Every cell as a row — where it is, and all four figures the run computed">Save data (CSV)</button>
        </div>
        <p class="filter-note" id="polar-status">${statusHtml()}</p>
        <p class="filter-note">${esc(CAVEAT)}</p>
      </div>`;
  }

  const CAVEAT = 'Longley–Rice over bare ~30 m terrain, omnidirectional at both ends. '
    + 'No antenna patterns, no trees, no terminal clutter — every one of which only ever '
    + 'takes coverage away, so this is the best case and the elevation profile card is the '
    + 'authority for any path you are about to build.';

  function render() {
    if (body) body.innerHTML = panelHtml();
  }

  function renderHits() {
    const el = document.getElementById('polar-hits');
    if (el) el.innerHTML = hitsHtml();
  }

  return {
    attach(m) {
      map = m;
      if (!m.getPane(PANE)) {
        const pane = m.createPane(PANE);
        pane.style.zIndex = PANE_Z;
        pane.style.pointerEvents = 'none';
      }
      MapChrome.panel(m, {
        id: 'polar', icon: '📡', title: 'Polar radio coverage',
        html: () => panelHtml(),
        onMount(el) { body = el; },
      });
    },

    detach() {
      if (job) job.cancelled = true;
      job = null;
      clearOverlay();
      body = null;
      map = null;
      // The computed levels die with the map they were drawn on: the plot is
      // pinned to a coordinate and a zoom-independent overlay, and keeping it
      // across a rebuild would put a stale wash under a new map without
      // anything on screen saying when it was computed.
      plot = null;
      status = { kind: 'idle', text: '' };
    },

    active() { return !!overlay; },

    // For the map legend: what is drawn, in one line, plus its key.
    legend() {
      if (!plot) return null;
      const s = span();
      return { unit: cfg.unit === 'margin' ? 'dB over threshold' : 'dBm',
               from: s.from, to: s.to, dir: DIRS[cfg.dir].short,
               centre: plot.cName, mobile: plot.mName,
               colours: cfg.rainbow ? RAINBOW.slice() : [colourOf(0)] };
    },

    draw,

    save: saveCsv,

    cancel() {
      if (job) job.cancelled = true;
      job = null;
      setStatus('idle', '');
    },

    clear() {
      invalidate();
      render();
      rerenderMapLegend();
    },

    setSearch(v) { hitQ = String(v || ''); renderHits(); },

    pickCentre(id) {
      cfg.centreId = id;
      cfg.centre = 'station';
      save();
      invalidate();
      const st = centreStation();
      if (st && map) mapNote(`Coverage centre: ${st.name}. Press Draw.`, 5000);
      render();
      rerenderMapLegend();
    },

    // One setter for every control on the panel. Numbers arrive as strings from
    // the inputs and an empty box means "no override" rather than nought —
    // which is the difference between an antenna at ground level and one at
    // whatever its system says.
    set(key, value) {
      const asNum = v => { const s = String(v).trim(); return s === '' ? null : (isFinite(+s) ? +s : null); };
      switch (key) {
        case 'centre':      cfg.centre = value === 'map' ? 'map' : 'station'; break;
        case 'dir':         cfg.dir = DIRS[value] ? value : 'worst'; break;
        case 'unit':        cfg.unit = value === 'margin' ? 'margin' : 'dbm'; break;
        case 'rainbow':     cfg.rainbow = !!value; break;
        case 'opacity':     cfg.opacity = Math.max(0.15, Math.min(1, +value || 0.65)); break;
        case 'mobileSysId': cfg.mobileSysId = +value; break;
        case 'freqMhz':     cfg.freqMhz = asNum(value); break;
        case 'centreAgl':   cfg.centreAgl = asNum(value); break;
        case 'mobileAgl':   cfg.mobileAgl = asNum(value); break;
        default:
          if (!(key in cfg)) return;
          cfg[key] = asNum(value) == null ? cfg[key] : asNum(value);
      }
      save();
      // Threshold, palette and opacity are a re-read of figures already in
      // hand — MapFade's separation between a margin and the band it lands in.
      // Everything else changes what would be computed, so the plot on the map
      // is no longer an answer to the question the panel is asking.
      const REPAINT = ['unit', 'fromDb', 'toDb', 'fromDbm', 'toDbm', 'rainbow', 'opacity', 'dir'];
      if (plot && REPAINT.includes(key)) paint();
      else if (plot) invalidate();
      render();
      rerenderMapLegend();
    },
  };
})();
if (typeof window !== 'undefined') window.MapPolar = MapPolar;
