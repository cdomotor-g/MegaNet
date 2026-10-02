// MegaNet — station-ar.js
//
//   StationAR   🔭 the AR station finder, a tool in the Stations tab's side
//               panel: hold a phone up, turn round, and the stations that lie
//               the way it faces are pinned over the camera's picture — one
//               pin a direction, the nearest station in it named, its type in
//               one letter (F field, R repeater, B base, in the map's own
//               colours) and how many more stand behind it, out to a distance
//               a slider sets. A tap on a pin opens the station: its number,
//               its ALERT ids, how far and which way, the rest of that
//               direction, and the way back to it on the map.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, announce, fmtKm, bearingDeg,
// acmaHaversineKm, ROLE_LABEL, proposedTagHtml and registerTabTeardown; across
// to app.js for filteredStations, primaryRole, stationAlertIdTypes,
// focusStationOnMap, isPhoneNav and shutDock. All of it from inside its own
// functions, so this file's position among the modules is free. Nothing
// executes at load (`npm run toplevel`).
//
// ── One pin a direction ──────────────────────────────────────────────────────
// Thirty kilometres from a town in the south-east is two hundred stations, and
// a pin each is a wall of labels nobody can read. So the stations in range are
// gathered by bearing, nearest first: each one joins the direction of the
// nearest station already standing within a few degrees of it, or stands as a
// direction of its own. A direction's pin is its nearest station — the one a
// person turning round is most likely to be looking for, and the one most
// likely to be in sight — with a count of everything behind it, and the pin's
// sheet lists the rest. The gathering is done in bearings rather than on the
// screen, so it holds still as the phone turns: a pin does not change what it
// stands for because another came into view beside it. How many degrees make
// one direction follows the screen (about a finger's width of it), and widens
// where even then the labels would not fit in a few rows over the horizon.
//
// ── Which way is north ───────────────────────────────────────────────────────
// A phone's compass reads magnetic north, and every bearing here is true: in
// Brisbane the two are eleven degrees apart, which at ten kilometres is a pin
// two kilometres to one side of its mast. So the heading is corrected by the
// declination where the phone stands, from the World Magnetic Model (WMM2025,
// NOAA and the British Geological Survey, good to 2030) — the model's own
// coefficients below, its own test values held in test/ar.mjs.
//
// Two browsers say which way the phone faces in two ways:
//
//   Android      `deviceorientationabsolute`: alpha, beta, gamma against
//                magnetic north, and the camera's heading is arithmetic on
//                them (the spec's own worked example, extended to the camera's
//                tilt and the screen's roll). Firefox flags the plain event
//                `absolute` instead.
//   iPhone       `deviceorientation`, whose alpha is against wherever the phone
//                happened to point when it started, plus `webkitCompassHeading`
//                from the compass. The gyro's alpha is smooth and the compass
//                is not, so the gyro turns the view and the compass only keeps
//                saying where north is in the gyro's frame — read while the
//                phone is held up, which is when its heading is the camera's.
//
// A phone whose compass sends no north at all still turns the view by its
// gyro, and "I'm facing it" on a station's sheet sets north by a station the
// person can see. The same button corrects a compass that is merely out —
// five to fifteen degrees is ordinary, and more beside a vehicle.
//
// ── Where you are standing, and the picture ──────────────────────────────────
// The GPS, or — for a desktop, or a look at a site before driving to it — the
// middle of the map. The camera is asked for only on a phone or a tablet and
// only when standing where the GPS says: the picture is the place the pins
// describe. A pin's place on the picture assumes the main camera sees about
// 66° along its long side (most phones' 1×); there is no browser API to ask.
// The picture is drawn on this screen and goes nowhere else: nothing here
// records it, stores it or sends it.
//
// Without a compass — a desktop, or a phone that refused — the view turns by
// drag, or by ← and → from the keyboard.
const StationAR = (function () {
  const RAD = Math.PI / 180;

  // The slider's stops, in km. Half a kilometre is a site and its neighbour;
  // 300 km is a repeater network from one of its hills.
  const RANGES_KM = [0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300];
  const RANGE_DEFAULT = 9;                  // 30 km

  // The three kinds of station the user asked to tell apart, by primaryRole():
  // a base or repeater that also reads a gauge is its rarer role. Satcom-only
  // stations are field stations here, as primaryRole files them.
  const ROLES  = ['field', 'repeater', 'base'];
  const LETTER = { field: 'F', repeater: 'R', base: 'B' };
  const SHORT  = { field: 'Field', repeater: 'Repeater', base: 'Base' };

  const HERE_KM = 0.02;          // a station this close is where you stand, not a direction
  const CLUSTER_PX = 48;         // a direction is about a finger's width of the screen…
  const CLUSTER_MIN_DEG = 2;     // …but never narrower than this…
  const CLUSTER_MAX_DEG = 12;    // …and widened no further than this to make the labels fit
  const MAX_ROWS = 5;            // label rows stacked over the horizon
  const LABEL_GAP_PX = 10;
  const CAMERA_LONG_FOV = 66;    // degrees a phone's main camera sees along its long side
  const PLAIN_HFOV = 60;         // degrees across the view where there is no picture
  const SENSOR_WAIT_MS = 2500;   // how long to wait for a compass before turning by hand
  const GPS_TIMEOUT_MS = 30000;
  const REPLAN_M = 15;           // the GPS moved this far: gather the directions again
  const DECL_KM = 5;             // …and this far: ask the magnetic model again
  const SMOOTH = 0.25;           // per reading, on the camera's direction
  const OFFSET_SMOOTH = 0.05;    // per reading, on an iPhone's north in the gyro's frame
  const UPRIGHT_U = 0.7;         // |sin pitch| under which the camera is looking out (~44°)
  const MORE_CAP = 40;           // rows listed under a station's sheet
  const TURN_STEP = 5;           // degrees an arrow key turns by; Shift turns by 20
  const EDGE_PX = 8;             // a pin shows while its stem is this near the screen

  // ── WMM2025 ────────────────────────────────────────────────────────────────
  // The World Magnetic Model 2025 (NOAA NCEI / BGS), its WMM.COF file verbatim
  // in order: n = 1…12, m = 0…n, each row [g, h, ġ, ḣ] in nT and nT a year
  // from 2025.0. Public domain. Valid 2025.0–2030.0; the next model replaces
  // this block and nothing else.
  const WMM_EPOCH = 2025.0;
  const WMM_N = 12;
  const WMM_COEF = [
    [-29351.8, 0, 12, 0],
    [-1410.8, 4545.4, 9.7, -21.5],
    [-2556.6, 0, -11.6, 0],
    [2951.1, -3133.6, -5.2, -27.7],
    [1649.3, -815.1, -8, -12.1],
    [1361, 0, -1.3, 0],
    [-2404.1, -56.6, -4.2, 4],
    [1243.8, 237.5, 0.4, -0.3],
    [453.6, -549.5, -15.6, -4.1],
    [895, 0, -1.6, 0],
    [799.5, 278.6, -2.4, -1.1],
    [55.7, -133.9, -6, 4.1],
    [-281.1, 212, 5.6, 1.6],
    [12.1, -375.6, -7, -4.4],
    [-233.2, 0, 0.6, 0],
    [368.9, 45.4, 1.4, -0.5],
    [187.2, 220.2, 0, 2.2],
    [-138.7, -122.9, 0.6, 0.4],
    [-142, 43, 2.2, 1.7],
    [20.9, 106.1, 0.9, 1.9],
    [64.4, 0, -0.2, 0],
    [63.8, -18.4, -0.4, 0.3],
    [76.9, 16.8, 0.9, -1.6],
    [-115.7, 48.8, 1.2, -0.4],
    [-40.9, -59.8, -0.9, 0.9],
    [14.9, 10.9, 0.3, 0.7],
    [-60.7, 72.7, 0.9, 0.9],
    [79.5, 0, 0, 0],
    [-77, -48.9, -0.1, 0.6],
    [-8.8, -14.4, -0.1, 0.5],
    [59.3, -1, 0.5, -0.8],
    [15.8, 23.4, -0.1, 0],
    [2.5, -7.4, -0.8, -1],
    [-11.1, -25.1, -0.8, 0.6],
    [14.2, -2.3, 0.8, -0.2],
    [23.2, 0, -0.1, 0],
    [10.8, 7.1, 0.2, -0.2],
    [-17.5, -12.6, 0, 0.5],
    [2, 11.4, 0.5, -0.4],
    [-21.7, -9.7, -0.1, 0.4],
    [16.9, 12.7, 0.3, -0.5],
    [15, 0.7, 0.2, -0.6],
    [-16.8, -5.2, 0, 0.3],
    [0.9, 3.9, 0.2, 0.2],
    [4.6, 0, 0, 0],
    [7.8, -24.8, -0.1, -0.3],
    [3, 12.2, 0.1, 0.3],
    [-0.2, 8.3, 0.3, -0.3],
    [-2.5, -3.3, -0.3, 0.3],
    [-13.1, -5.2, 0, 0.2],
    [2.4, 7.2, 0.3, -0.1],
    [8.6, -0.6, -0.1, -0.2],
    [-8.7, 0.8, 0.1, 0.4],
    [-12.9, 10, -0.1, 0.1],
    [-1.3, 0, 0.1, 0],
    [-6.4, 3.3, 0, 0],
    [0.2, 0, 0.1, 0],
    [2, 2.4, 0.1, -0.2],
    [-1, 5.3, 0, 0.1],
    [-0.6, -9.1, -0.3, -0.1],
    [-0.9, 0.4, 0, 0.1],
    [1.5, -4.2, -0.1, 0],
    [0.9, -3.8, -0.1, -0.1],
    [-2.7, 0.9, 0, 0.2],
    [-3.9, -9.1, 0, 0],
    [2.9, 0, 0, 0],
    [-1.5, 0, 0, 0],
    [-2.5, 2.9, 0, 0.1],
    [2.4, -0.6, 0, 0],
    [-0.6, 0.2, 0, 0.1],
    [-0.1, 0.5, -0.1, 0],
    [-0.6, -0.3, 0, 0],
    [-0.1, -1.2, 0, 0.1],
    [1.1, -1.7, -0.1, 0],
    [-1, -2.9, -0.1, 0],
    [-0.2, -1.8, -0.1, 0],
    [2.6, -2.3, -0.1, 0],
    [-2, 0, 0, 0],
    [-0.2, -1.3, 0, 0],
    [0.3, 0.7, 0, 0],
    [1.2, 1, 0, -0.1],
    [-1.3, -1.4, 0, 0.1],
    [0.6, 0, 0, 0],
    [0.6, 0.6, 0.1, 0],
    [0.5, -0.1, 0, 0],
    [-0.1, 0.8, 0, 0],
    [-0.4, 0.1, 0, 0],
    [-0.2, -1, -0.1, 0],
    [-1.3, 0.1, 0, 0],
    [-0.7, 0.2, -0.1, -0.1],
  ];

  // The year as a decimal, for the secular variation.
  function decimalYear(d = new Date()) {
    const y = d.getUTCFullYear();
    const t0 = Date.UTC(y, 0, 1), t1 = Date.UTC(y + 1, 0, 1);
    return y + (d.getTime() - t0) / (t1 - t0);
  }

  // The field at a point: north, east and down in nT, and the declination in
  // degrees east of true north — the WMM technical report's equations, with
  // the Schmidt semi-normalised Legendre functions built by recursion in θ
  // (and their derivatives with them, so nothing divides by sin θ but Y′).
  function wmmField(latDeg, lonDeg, altKm = 0, year = decimalYear()) {
    const A = 6378.137, F = 1 / 298.257223563, E2 = F * (2 - F), RE = 6371.2;
    const lat = latDeg * RAD, lon = lonDeg * RAD;
    const sl = Math.sin(lat), cl = Math.cos(lat);
    const rc = A / Math.sqrt(1 - E2 * sl * sl);
    const p = (rc + altKm) * cl, z = (rc * (1 - E2) + altKm) * sl;
    const r = Math.hypot(p, z);
    const latc = Math.asin(z / r);                     // geocentric latitude
    const mu = Math.sin(latc), s = Math.cos(latc);     // cos θ, sin θ
    const dt = year - WMM_EPOCH;
    const P = [], dP = [];
    for (let n = 0; n <= WMM_N; n++) { P.push(new Float64Array(WMM_N + 1)); dP.push(new Float64Array(WMM_N + 1)); }
    P[0][0] = 1;
    for (let m = 0; m <= WMM_N; m++) {
      if (m > 0) {
        P[m][m] = (2 * m - 1) * s * P[m - 1][m - 1];
        dP[m][m] = (2 * m - 1) * (mu * P[m - 1][m - 1] + s * dP[m - 1][m - 1]);
      }
      if (m + 1 <= WMM_N) {
        P[m + 1][m] = (2 * m + 1) * mu * P[m][m];
        dP[m + 1][m] = (2 * m + 1) * (mu * dP[m][m] - s * P[m][m]);
      }
      for (let n = m + 2; n <= WMM_N; n++) {
        P[n][m] = ((2 * n - 1) * mu * P[n - 1][m] - (n + m - 1) * P[n - 2][m]) / (n - m);
        dP[n][m] = ((2 * n - 1) * (mu * dP[n - 1][m] - s * P[n - 1][m]) - (n + m - 1) * dP[n - 2][m]) / (n - m);
      }
    }
    let X = 0, Y = 0, Zc = 0, i = 0;
    for (let n = 1; n <= WMM_N; n++) {
      const ar = Math.pow(RE / r, n + 2);
      for (let m = 0; m <= n; m++, i++) {
        const [g0, h0, gd, hd] = WMM_COEF[i];
        const g = g0 + dt * gd, h = h0 + dt * hd;
        let k = 1;
        if (m > 0) { let q = 1; for (let j = n - m + 1; j <= n + m; j++) q *= j; k = Math.sqrt(2 / q); }
        const cm = Math.cos(m * lon), sm = Math.sin(m * lon);
        X  += ar * (g * cm + h * sm) * k * dP[n][m];
        Y  += ar * m * (g * sm - h * cm) * k * P[n][m];
        Zc -= ar * (n + 1) * (g * cm + h * sm) * k * P[n][m];
      }
    }
    Y /= s;
    const psi = latc - lat;                            // geocentric to geodetic
    const Xg = X * Math.cos(psi) - Zc * Math.sin(psi);
    const Zg = X * Math.sin(psi) + Zc * Math.cos(psi);
    return { x: Xg, y: Y, z: Zg, decl: Math.atan2(Y, Xg) / RAD };
  }

  function declination(latDeg, lonDeg, altKm = 0, year) {
    return wmmField(latDeg, lonDeg, altKm, year).decl;
  }

  // ── The phone's attitude ───────────────────────────────────────────────────

  // One DeviceOrientation reading as the two things the view needs: the way the
  // back camera looks (its −z axis) in east, north and up, and which way is up
  // in the screen's own plane. The rotation matrix rather than the three angles,
  // because a phone held upright is where those angles are worst behaved — a
  // small roll there swings gamma to ±90° and alpha with it — and the matrix
  // they make is the same either way.
  function orient(alpha, beta, gamma) {
    const ca = Math.cos(alpha * RAD), sa = Math.sin(alpha * RAD);
    const cb = Math.cos(beta * RAD),  sb = Math.sin(beta * RAD);
    const cg = Math.cos(gamma * RAD), sg = Math.sin(gamma * RAD);
    return {
      e: -ca * sg - sa * sb * cg,
      n: -sa * sg + ca * sb * cg,
      u: -cb * cg,
      ux: -cb * sg,
      uy: sb,
    };
  }

  function headingOf(v) {
    return norm360(Math.atan2(v.e, v.n) / RAD);
  }

  function pitchOf(v) {
    const len = Math.hypot(v.e, v.n, v.u) || 1;
    return Math.asin(clamp(v.u / len, -1, 1)) / RAD;
  }

  // How far to turn the drawing so its horizon lies along the world's: up in
  // the device's x, y, turned into the screen's by the screen's own rotation.
  // Nothing to level on a phone lying flat.
  function rollOf(v, screenDeg = 0) {
    const a = screenDeg * RAD;
    const sx = v.ux * Math.cos(a) - v.uy * Math.sin(a);
    const sy = v.ux * Math.sin(a) + v.uy * Math.cos(a);
    if (Math.hypot(sx, sy) < 0.2) return 0;
    return Math.atan2(sx, sy) / RAD;
  }

  // ── Directions ─────────────────────────────────────────────────────────────

  // Stations into directions. `items` nearest first, each with its bearing `b`;
  // each joins the angularly nearest direction whose first station stands
  // within `widthDeg` of it, or starts one. So a direction's first member is
  // its nearest station, no two directions start within `widthDeg` of each
  // other, and the directions come out nearest first.
  function clusterByBearing(items, widthDeg) {
    const clusters = [];
    const buckets = new Array(360);
    for (const it of items) {
      let best = null, bestDiff = Infinity;
      const lo = Math.floor(it.b - widthDeg), hi = Math.floor(it.b + widthDeg);
      for (let k = lo; k <= hi; k++) {
        const arr = buckets[((k % 360) + 360) % 360];
        if (!arr) continue;
        for (const c of arr) {
          const diff = Math.abs(wrap180(it.b - c.b));
          if (diff <= widthDeg && diff < bestDiff) { best = c; bestDiff = diff; }
        }
      }
      if (best) { best.members.push(it); continue; }
      const c = { b: it.b, d: it.d, members: [it] };
      clusters.push(c);
      const key = ((Math.floor(it.b) % 360) + 360) % 360;
      (buckets[key] || (buckets[key] = [])).push(c);
    }
    return clusters;
  }

  // How wide a direction's label is drawn, near enough: the letter, the name
  // up to where it is cut, the padding. Good enough to decide how wide a
  // direction must be; the rows are laid out again on the labels as drawn.
  function labelPx(c) {
    const name = (c.members[0].s.name || '').length;
    return Math.round(Math.min(48 + 6.8 * Math.min(name, 22), 200));
  }

  // The labels into rows over the horizon, nearest direction lowest: each in
  // the lowest row where it overlaps nothing already there. Laid out round the
  // whole circle in degrees, not on the screen, so nothing moves rows as the
  // phone turns. False if some label found no row clear of the others — it
  // goes in the least crowded one, and the caller widens the directions.
  function layoutRows(clusters, pxPerDeg, rows = MAX_ROWS) {
    const placed = Array.from({ length: rows }, () => []);
    let fits = true;
    for (const c of clusters) {
      c.px = c.px || labelPx(c);
      c.half = (c.px / 2 + LABEL_GAP_PX / 2) / pxPerDeg;
      const clash = o => Math.abs(wrap180(o.b - c.b)) < o.half + c.half;
      let row = placed.findIndex(list => !list.some(clash));
      if (row < 0) {
        fits = false;
        let least = Infinity;
        placed.forEach((list, r) => { const n = list.filter(clash).length; if (n < least) { least = n; row = r; } });
      }
      c.row = row;
      placed[row].push(c);
    }
    return fits;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  let loaded = false;
  let rangeIdx = RANGE_DEFAULT;
  let roles = { field: true, repeater: true, base: true };

  let view = null, opener = null;
  let source = 'gps';                  // 'gps' | 'map'
  let here = null;                     // { lat, lon, acc } — where the view stands
  let planAt = null;                   // …and where the directions were last gathered
  let watchId = null, gpsError = '';
  let stream = null, camState = 'off'; // 'off' | 'asking' | 'on' | 'denied' | 'none'
  let compass = 'waiting';             // 'waiting' | 'absolute' | 'ios' | 'relative' | 'none'
  let seenRelative = false, listening = false, sensorTimer = 0;
  let vec = null;                      // the camera's direction and the screen's up, smoothed
  let iosOff = null;                   // an iPhone's north in its gyro's frame, as cos and sin
  let compassAcc = null;               // an iPhone's own word on its compass, in degrees
  let manualHeading = 0;
  let align = 0;                       // the operator's correction, in degrees
  let decl = 0, declAt = null;
  let plan = null;
  let pick = null;                     // { id } — the station whose sheet is open
  let pinEls = [];
  let proj = { f: 500, w: 0, h: 0 };
  let raf = 0, drag = null, wake = null;
  let shownHeading = null;

  // ── Small things ───────────────────────────────────────────────────────────

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function norm360(x) { return ((x % 360) + 360) % 360; }
  function wrap180(x) { const y = norm360(x); return y > 180 ? y - 360 : y; }

  const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function compassPoint(deg) { return POINTS[Math.round(norm360(deg) / 22.5) % 16]; }
  function bearingText(deg) {
    const r = Math.round(norm360(deg)) % 360;
    return `${String(r).padStart(3, '0')}° ${compassPoint(r)}`;
  }
  function kmText(km) { return km < 1 ? `${Math.round(km * 1000)} m` : `${km} km`; }
  function declText(d) { return `${Math.abs(d).toFixed(1)}° ${d < 0 ? 'W' : 'E'}`; }

  function hasPos(s) {
    return !!s && s.lat != null && s.lon != null && isFinite(s.lat) && isFinite(s.lon);
  }
  function roleOf(s) {
    return Array.isArray(s.roles) && typeof primaryRole === 'function' ? primaryRole(s) : 'field';
  }
  function isMobile() {
    return (typeof L !== 'undefined' && L.Browser && L.Browser.mobile)
      || window.matchMedia('(pointer: coarse)').matches;
  }
  function screenAngle() {
    const so = window.screen && window.screen.orientation;
    if (so && typeof so.angle === 'number') return so.angle;
    return typeof window.orientation === 'number' ? window.orientation : 0;
  }
  function pxPerDeg() { return proj.f * RAD; }
  const $ = id => document.getElementById(id);

  // The stations the map shows — its filters apply here too — that have a
  // position to take a bearing to.
  function candidates() {
    if (!state.data) return [];
    const list = typeof filteredStations === 'function' ? filteredStations() : state.data.stations;
    return list.filter(hasPos);
  }

  // The distance and the types, remembered across visits.
  function loadSettings() {
    if (loaded) return;
    loaded = true;
    try {
      const r = parseInt(localStorage.getItem('mn-ar-range'), 10);
      if (r >= 0 && r < RANGES_KM.length) rangeIdx = r;
      const t = localStorage.getItem('mn-ar-roles');
      if (t != null) for (const k of ROLES) roles[k] = t.split(',').includes(k);
    } catch (_) { /* private mode — the defaults */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem('mn-ar-range', String(rangeIdx));
      localStorage.setItem('mn-ar-roles', ROLES.filter(k => roles[k]).join(','));
    } catch (_) { /* private mode, a full quota — it still works this visit */ }
  }

  // ── The pane, and the two controls it shares with the view ─────────────────

  function rangeHtml(id) {
    const km = kmText(RANGES_KM[rangeIdx]);
    return `<label class="ar-range"><span class="ar-range-label">Stations within <output id="${id}-range-out">${esc(km)}</output></span>
        <input type="range" id="${id}-range" class="ar-range-input" min="0" max="${RANGES_KM.length - 1}" step="1"
               value="${rangeIdx}" aria-valuetext="${escAttr(km)}" oninput="StationAR.setRange(this.value)"></label>`;
  }

  function rolesHtml() {
    return `<div class="ar-roles" role="group" aria-label="Station types shown">${ROLES.map(r =>
      `<button type="button" class="ar-role role-${r}" data-role="${r}" aria-pressed="${roles[r]}"
               title="${escAttr(`${ROLE_LABEL[r]}s — ${LETTER[r]} on a pin`)}" onclick="StationAR.toggleRole('${r}')"><span
               class="ar-letter" aria-hidden="true">${LETTER[r]}</span>${esc(SHORT[r])}</button>`).join('')}</div>`;
  }

  // The pane's markup, once, for the side panel's skeleton (app.js,
  // dockSkeleton): what the tool does, the two ways in, the distance and the
  // types, and how it works.
  function paneHtml() {
    loadSettings();
    return `
      <div class="ar-pane">
        <div class="mn-mapctl-head ar-pane-head">
          <h2 class="mn-mapctl-title" id="ar-pane-h"><span aria-hidden="true">🔭</span> AR station finder</h2>
        </div>
        <p class="small ar-pane-lead">Hold your phone up and turn round: the stations the way it faces are pinned over the
          camera's picture, each with its type — <strong>F</strong> field, <strong>R</strong> repeater, <strong>B</strong> base.
          One pin a direction: the nearest station that way, and how many more stand behind it. Tap a pin for its station
          number and ALERT IDs.</p>
        <div class="button-group ar-pane-go">
          <button type="button" class="primary" id="ar-pane-gps" onclick="StationAR.open('gps')"
                  title="Your position by GPS, the way you face by the compass, and the camera's picture">🔭 Look around</button>
          <button type="button" id="ar-pane-map" onclick="StationAR.open('map')"
                  title="Stand in the middle of the map instead — no GPS and no camera; turn by the compass, by dragging or with the arrow keys">From the map's centre</button>
        </div>
        ${rangeHtml('ar-pane')}
        ${rolesHtml()}
        <p class="small ar-pane-note" id="ar-pane-note"></p>
        <details class="ar-pane-how">
          <summary>How it works</summary>
          <p class="small">Your position comes from the GPS and the way the phone faces from its compass, turned to
            <strong>true north</strong> by the World Magnetic Model — about 11° east of magnetic north in Brisbane, 6° in
            Cairns. Phone compasses are often 5–15° out, more beside a vehicle: aim at a station you can see, tap its pin,
            and press <em>I'm facing it</em> to bring every pin into line.</p>
          <p class="small">It shows the stations the map does — the map's filters apply here too. Stations are gathered
            by direction, nearest first, so a pin is the nearest station that way and its number counts the rest; the
            pin's sheet lists them. The little circle is the same directions from above, the way you face at the top.</p>
          <p class="small">The camera's picture is drawn on your screen and goes nowhere else — nothing is recorded or
            sent. On a computer, <em>From the map's centre</em> turns by dragging or with ← and →.</p>
        </details>
      </div>`;
  }

  // What the pane says about what it will show, brought up to date whenever it
  // comes into view (app.js, renderDock).
  function syncPane() {
    loadSettings();
    syncControls();
    const note = $('ar-pane-note');
    if (note) {
      if (!state.data) note.textContent = '';
      else {
        const all = state.data.stations.filter(hasPos).length;
        const shown = candidates().length;
        note.textContent = shown < all
          ? `The map's filters are on: ${shown.toLocaleString()} of the ${all.toLocaleString()} stations with a position, and the finder shows those.`
          : `${all.toLocaleString()} stations with a position. Filters set on the map apply here too.`;
      }
    }
  }

  function syncControls() {
    const km = kmText(RANGES_KM[rangeIdx]);
    for (const id of ['ar-pane', 'ar']) {
      const inp = $(`${id}-range`);
      if (inp) {
        if (Number(inp.value) !== rangeIdx) inp.value = String(rangeIdx);
        inp.setAttribute('aria-valuetext', km);
      }
      const out = $(`${id}-range-out`);
      if (out) out.textContent = km;
    }
    document.querySelectorAll('.ar-role').forEach(b => b.setAttribute('aria-pressed', String(!!roles[b.dataset.role])));
  }

  function setRange(v) {
    loadSettings();
    const i = clamp(Math.round(Number(v)), 0, RANGES_KM.length - 1);
    if (!isFinite(i) || i === rangeIdx) { syncControls(); return; }
    rangeIdx = i;
    saveSettings();
    syncControls();
    replan();
  }

  function toggleRole(r) {
    loadSettings();
    if (!ROLES.includes(r)) return;
    roles[r] = !roles[r];
    saveSettings();
    syncControls();
    replan();
  }

  // ── The view ───────────────────────────────────────────────────────────────

  function viewHtml() {
    return `
      <div class="ar-stage" id="ar-stage">
        <video class="ar-cam" id="ar-cam" playsinline muted autoplay aria-hidden="true" hidden></video>
        <div class="ar-sky" aria-hidden="true"></div>
        <div class="ar-world">
          <div class="ar-horizon" aria-hidden="true"></div>
          <div class="ar-pins" id="ar-pins"></div>
        </div>
        <div class="ar-edge" id="ar-edge" aria-hidden="true" hidden></div>
      </div>
      <div class="ar-top">
        <button type="button" class="ar-close" onclick="StationAR.close()" aria-label="Close the AR station finder"
                title="Close (Esc)">✕</button>
        <div class="ar-top-mid">
          <h2 class="ar-title"><span class="sr-only">Facing </span><span id="ar-heading">—</span></h2>
          <p class="ar-status" id="ar-status"></p>
          <div class="ar-tools">
            <button type="button" class="ar-tool" id="ar-use-map" onclick="StationAR.useMap()" hidden>Use the map's centre</button>
            <button type="button" class="ar-tool" id="ar-unalign" onclick="StationAR.unalign()" hidden></button>
          </div>
        </div>
        <svg class="ar-radar" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">
          <circle class="ar-radar-disc" r="48"></circle>
          <circle class="ar-radar-ring" r="23"></circle>
          <path class="ar-radar-fov" id="ar-radar-fov" d=""></path>
          <g class="ar-radar-rot" id="ar-radar-rot">
            <text class="ar-radar-n" x="0" y="-38">N</text>
            <g id="ar-radar-dots"></g>
          </g>
          <circle class="ar-radar-me" r="3"></circle>
        </svg>
      </div>
      <p class="ar-hint" id="ar-hint" hidden></p>
      <div class="ar-bottom">
        ${rangeHtml('ar')}
        ${rolesHtml()}
        <p class="ar-count" id="ar-count"></p>
      </div>
      <section class="ar-detail" id="ar-detail" tabindex="-1" aria-labelledby="ar-detail-h" hidden></section>`;
  }

  // Open it — from a press, which is what lets an iPhone be asked for its
  // compass (the ask has to be made inside the gesture, before anything waits).
  function open(src) {
    if (view || !state.data || (src === 'map' && !state.map)) return;
    loadSettings();
    source = src === 'map' ? 'map' : 'gps';
    opener = document.activeElement;
    startCompass();
    view = document.createElement('div');
    view.className = 'ar-view';
    view.id = 'ar-view';
    view.dataset.theme = 'dark';      // a camera's HUD is dark in either theme
    view.setAttribute('role', 'dialog');
    view.setAttribute('aria-modal', 'true');
    view.setAttribute('aria-label', 'AR station finder');
    view.tabIndex = -1;
    view.innerHTML = viewHtml();
    document.body.appendChild(view);
    const stage = $('ar-stage');
    stage.addEventListener('pointerdown', dragStart);
    stage.addEventListener('pointermove', dragMove);
    stage.addEventListener('pointerup', dragEnd);
    stage.addEventListener('pointercancel', dragEnd);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisible);
    registerTabTeardown('StationAR', () => close({ refocus: false }));
    here = null; planAt = null; gpsError = ''; align = 0; pick = null; plan = null;
    manualHeading = 0; shownHeading = null; camState = 'off';
    if (source === 'map') here = mapCentre();
    else {
      startGps();
      if (isMobile()) startCamera();
    }
    holdWake();
    measure();
    replan();
    view.focus({ preventScroll: true });
    announce(source === 'map'
      ? 'AR station finder open, looking out from the middle of the map.'
      : 'AR station finder open. Hold the phone up and turn round.');
  }

  function close({ refocus = true } = {}) {
    if (!view) return;
    stopCompass();
    stopGps();
    stopCamera();
    releaseWake();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisible);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    view.remove();
    view = null;
    pinEls = [];
    plan = null; pick = null; here = null; planAt = null; drag = null; vec = null; iosOff = null;
    const back = opener;
    opener = null;
    if (refocus && back && back.focus && document.contains(back) && back.getClientRects().length) {
      back.focus({ preventScroll: true });
    }
  }

  // ── Where the view stands ──────────────────────────────────────────────────

  function mapCentre() {
    const c = state.map && state.map.getCenter();
    return c ? { lat: c.lat, lon: c.lng, acc: 0 } : null;
  }

  function startGps() {
    if (!('geolocation' in navigator)) { gpsError = 'this browser has no location'; status(); return; }
    watchId = navigator.geolocation.watchPosition(onPos, onPosErr, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: GPS_TIMEOUT_MS,
    });
  }

  function stopGps() {
    if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function onPos(p) {
    if (!view || source !== 'gps') return;
    here = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy || 0 };
    gpsError = '';
    if (!planAt || acmaHaversineKm(planAt.lat, planAt.lon, here.lat, here.lon) * 1000 > REPLAN_M) replan();
    else { status(); renderCount(); }
  }

  function onPosErr(e) {
    if (!view || source !== 'gps') return;
    gpsError = e && e.code === 1 ? 'location was refused' : (e && e.message) || 'no fix';
    if (e && e.code === 1) stopGps();
    status();
    renderCount();
  }

  // ── The picture ────────────────────────────────────────────────────────────

  function startCamera() {
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { camState = 'none'; return; }
    camState = 'asking';
    md.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then(s => {
        if (!view || source !== 'gps') { s.getTracks().forEach(t => t.stop()); return; }
        stream = s;
        const v = $('ar-cam');
        v.muted = true;
        v.srcObject = s;
        v.hidden = false;
        camState = 'on';
        v.addEventListener('loadedmetadata', () => { if (measure()) replan(); }, { once: true });
        const played = v.play();
        if (played && played.catch) played.catch(() => {});
        status();
      }, err => {
        camState = err && err.name === 'NotAllowedError' ? 'denied' : 'none';
        status();
      });
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    const v = $('ar-cam');
    if (v) { v.srcObject = null; v.hidden = true; }
    if (camState === 'on' || camState === 'asking') camState = 'off';
  }

  // The screen kept awake while the phone is held up — nobody touches it.
  function holdWake() {
    if (!view || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(w => { if (view) wake = w; else w.release(); }, () => {});
  }

  function releaseWake() {
    if (wake) wake.release().catch(() => {});
    wake = null;
  }

  function onVisible() {
    if (!view || document.visibilityState !== 'visible') return;
    const v = $('ar-cam');
    if (stream && v && v.paused) v.play().catch(() => {});
    holdWake();
  }

  // ── The compass ────────────────────────────────────────────────────────────

  function startCompass() {
    compass = 'waiting';
    seenRelative = false;
    vec = null; iosOff = null; compassAcc = null;
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { compass = 'none'; return; }
    const listen = () => {
      if (listening) return;
      listening = true;
      if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
    };
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then(r => { if (r === 'granted') listen(); else noCompass(); }, noCompass);
    } else {
      listen();
    }
    clearTimeout(sensorTimer);
    sensorTimer = setTimeout(() => { if (compass === 'waiting') noCompass(); }, SENSOR_WAIT_MS);
  }

  function noCompass() {
    if (!view || (compass !== 'waiting' && compass !== 'none')) return;
    compass = seenRelative ? 'relative' : 'none';
    if (compass === 'relative') vec = null;
    status();
    touch();
  }

  function stopCompass() {
    clearTimeout(sensorTimer);
    if (listening) {
      window.removeEventListener('deviceorientationabsolute', onOrient, true);
      window.removeEventListener('deviceorientation', onOrient, true);
    }
    listening = false;
  }

  function onOrient(ev) {
    if (!view || ev.alpha == null || ev.beta == null || ev.gamma == null) return;
    const ios = typeof ev.webkitCompassHeading === 'number' && isFinite(ev.webkitCompassHeading) && ev.webkitCompassHeading >= 0;
    const kind = ios ? 'ios' : (ev.type === 'deviceorientationabsolute' || ev.absolute === true) ? 'absolute' : 'relative';
    // Chrome sends a relative stream beside the absolute one; the absolute one
    // has north in it, and the two must never be mixed in one smoothed vector.
    if (kind === 'relative') {
      if (compass === 'absolute' || compass === 'ios') return;
      seenRelative = true;
      if (compass !== 'relative') return;
    } else if (compass !== kind) {
      compass = kind;
      vec = null;
      status();
    }
    const v = orient(ev.alpha, ev.beta, ev.gamma);
    if (!vec) vec = { ...v };
    else for (const k of ['e', 'n', 'u', 'ux', 'uy']) vec[k] += SMOOTH * (v[k] - vec[k]);
    if (kind === 'ios') {
      const acc = ev.webkitCompassAccuracy;
      compassAcc = typeof acc === 'number' && acc >= 0 ? acc : null;
      if (Math.abs(v.u) < UPRIGHT_U) {
        const off = (ev.webkitCompassHeading - headingOf(v)) * RAD;
        if (!iosOff) iosOff = { c: Math.cos(off), s: Math.sin(off) };
        else {
          iosOff.c += OFFSET_SMOOTH * (Math.cos(off) - iosOff.c);
          iosOff.s += OFFSET_SMOOTH * (Math.sin(off) - iosOff.s);
        }
      }
    }
    touch();
  }

  function sensorLive() {
    return compass === 'absolute' || compass === 'ios' || compass === 'relative';
  }

  // The way the view faces, in degrees from true north — or null on an iPhone
  // that has not yet been held up long enough to say where north is.
  function headingNow() {
    if (!sensorLive()) return manualHeading;
    if (!vec) return null;
    if (compass === 'absolute') return norm360(headingOf(vec) + decl + align);
    if (compass === 'ios') return iosOff ? norm360(headingOf(vec) + Math.atan2(iosOff.s, iosOff.c) / RAD + decl + align) : null;
    return norm360(headingOf(vec) + align);
  }
  function pitchNow() { return sensorLive() && vec ? pitchOf(vec) : 0; }
  function rollNow()  { return sensorLive() && vec ? rollOf(vec, screenAngle()) : 0; }

  // ── Gathering the directions ───────────────────────────────────────────────

  // The focal length in screen pixels: from the picture where there is one,
  // its long side seeing CAMERA_LONG_FOV and drawn to cover the screen; a
  // plain PLAIN_HFOV across the view where there is not. True when it moved
  // enough to lay the labels out again.
  function measure() {
    const stage = $('ar-stage');
    if (!stage) return false;
    const w = stage.clientWidth || window.innerWidth, h = stage.clientHeight || window.innerHeight;
    const v = $('ar-cam');
    let f;
    if (camState === 'on' && v && v.videoWidth && v.videoHeight) {
      const long = Math.max(v.videoWidth, v.videoHeight);
      f = (long / 2) / Math.tan(CAMERA_LONG_FOV / 2 * RAD) * Math.max(w / v.videoWidth, h / v.videoHeight);
    } else {
      f = (w / 2) / Math.tan(PLAIN_HFOV / 2 * RAD);
    }
    const moved = Math.abs(f - proj.f) > 1 || w !== proj.w || h !== proj.h;
    proj = { f, w, h };
    const fov = $('ar-radar-fov');
    if (fov) {
      const half = Math.atan((w / 2) / f);
      const x = (46 * Math.sin(half)).toFixed(2), y = (-46 * Math.cos(half)).toFixed(2);
      fov.setAttribute('d', `M0 0 L${-x} ${y} A46 46 0 0 1 ${x} ${y} Z`);
    }
    return moved;
  }

  function replan() {
    if (!view) return;
    plan = null;
    if (here) {
      if (!declAt || acmaHaversineKm(declAt.lat, declAt.lon, here.lat, here.lon) > DECL_KM) {
        decl = declination(here.lat, here.lon, 0);
        declAt = { lat: here.lat, lon: here.lon };
      }
      const maxKm = RANGES_KM[rangeIdx];
      const items = [], at = [];
      for (const s of candidates()) {
        const role = roleOf(s);
        if (!roles[role]) continue;
        const d = acmaHaversineKm(here.lat, here.lon, s.lat, s.lon);
        if (d > maxKm) continue;
        if (d < HERE_KM) { at.push(s); continue; }
        items.push({ s, role, d, b: bearingDeg(here.lat, here.lon, s.lat, s.lon) });
      }
      items.sort((a, b) => a.d - b.d);
      const ppd = pxPerDeg();
      let width = clamp(CLUSTER_PX / ppd, CLUSTER_MIN_DEG, CLUSTER_MAX_DEG), clusters;
      for (;;) {
        clusters = clusterByBearing(items, width);
        if (layoutRows(clusters, ppd) || width >= CLUSTER_MAX_DEG) break;
        width = Math.min(CLUSTER_MAX_DEG, width * 1.5);
      }
      plan = { clusters, n: items.length, at, width, maxKm };
      planAt = { lat: here.lat, lon: here.lon };
    }
    if (pick && !findPick()) pick = null;
    renderPins();
    renderRadar();
    renderDetail();
    renderCount();
    status();
    touch();
  }

  // The picked station in the plan now: which direction, and which member.
  function findPick() {
    if (!pick || !plan) return null;
    for (let k = 0; k < plan.clusters.length; k++) {
      const m = plan.clusters[k].members.find(x => x.s.id === pick.id);
      if (m) return { k, c: plan.clusters[k], m };
    }
    return null;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  function pinHtml(c, k) {
    const rep = c.members[0], n = c.members.length;
    const picked = pick && c.members.some(x => x.s.id === pick.id);
    const name = rep.s.name || 'Unnamed station';
    const label = `${ROLE_LABEL[rep.role]} ${name}, ${fmtKm(rep.d)}, bearing ${bearingText(rep.b)}`
      + (n > 1 ? `. ${n} stations this way` : '');
    return `<div class="ar-pin role-${rep.role}${picked ? ' is-picked' : ''}" data-k="${k}" data-id="${escAttr(rep.s.id)}"
                 style="--ar-row: ${c.row}; --ar-z: ${1000 - k}" hidden>
        <button type="button" class="ar-pin-box" onclick="StationAR.pickCluster(${k})" aria-label="${escAttr(label)}"
                ${picked ? 'aria-current="true"' : ''}><span class="ar-letter" aria-hidden="true">${LETTER[rep.role]}</span><span
                class="ar-pin-text" aria-hidden="true"><span class="ar-pin-name">${esc(name)}</span><span
                class="ar-pin-dist">${esc(fmtKm(rep.d))}</span></span>${n > 1
                ? `<span class="ar-pin-n" aria-hidden="true">${n}</span>` : ''}</button>
        <span class="ar-pin-stem" aria-hidden="true"></span>
      </div>`;
  }

  function renderPins() {
    const box = $('ar-pins');
    if (!box) return;
    const a = document.activeElement;
    const had = a && box.contains(a) ? a.closest('.ar-pin') : null;
    const hadId = had ? had.dataset.id : null;
    box.innerHTML = plan ? plan.clusters.map(pinHtml).join('') : '';
    pinEls = [...box.querySelectorAll('.ar-pin')];
    // The labels as drawn — one layout, off the screen (--ar-x is unset) — and
    // the rows laid out again on them, so a long name never runs into the
    // label beside it.
    if (plan && pinEls.length) {
      pinEls.forEach(el => { el.hidden = false; });
      pinEls.forEach(el => {
        const w = el.querySelector('.ar-pin-box').offsetWidth;
        if (w) plan.clusters[Number(el.dataset.k)].px = w;
      });
      layoutRows(plan.clusters, pxPerDeg());
      pinEls.forEach(el => {
        el.style.setProperty('--ar-row', String(plan.clusters[Number(el.dataset.k)].row));
        el.hidden = true;
      });
    }
    if (had) {
      const again = pinEls.find(el => el.dataset.id === hadId);
      if (again) { again.hidden = false; again.querySelector('button').focus({ preventScroll: true }); }
      else view.focus({ preventScroll: true });
    }
  }

  // The directions from above, north up — the group turns with the view.
  function renderRadar() {
    const g = $('ar-radar-dots');
    if (!g) return;
    if (!plan) { g.innerHTML = ''; return; }
    const at = findPick();
    g.innerHTML = plan.clusters.map((c, k) => {
      const r = 46 * Math.min(1, c.d / plan.maxKm);
      const x = (r * Math.sin(c.b * RAD)).toFixed(2), y = (-r * Math.cos(c.b * RAD)).toFixed(2);
      const on = at && at.k === k;
      return `<circle class="ar-radar-dot role-${c.members[0].role}${on ? ' is-picked' : ''}" cx="${x}" cy="${y}" r="${on ? 4 : 2.6}"></circle>`;
    }).join('');
  }

  function renderCount() {
    const el = $('ar-count');
    if (!el) return;
    const km = kmText(RANGES_KM[rangeIdx]);
    let text;
    if (!ROLES.some(r => roles[r])) text = 'Every station type is switched off.';
    else if (!here) text = source === 'gps' && gpsError ? 'No position yet.' : 'Finding where you are…';
    else if (!plan || !plan.n) text = `No stations within ${km}${plan && plan.at.length ? '' : ' — widen the distance'}.`;
    else {
      const dirs = plan.clusters.length;
      text = `${plan.n.toLocaleString()} station${plan.n === 1 ? '' : 's'} within ${km}`
        + (dirs < plan.n ? `, in ${dirs} direction${dirs === 1 ? '' : 's'}` : '') + '.';
    }
    if (plan && plan.at.length) text += ` You're at ${plan.at.map(s => s.name).join(', ')}.`;
    el.textContent = text;
  }

  function status() {
    const el = $('ar-status');
    if (!el) return;
    const parts = [];
    if (source === 'map') parts.push("From the map's centre");
    else if (here) parts.push(`GPS ±${Math.max(1, Math.round(here.acc))} m`);
    else if (gpsError) parts.push(`No GPS — ${gpsError}`);
    else parts.push('Finding you…');
    if (compass === 'absolute') parts.push('compass');
    else if (compass === 'ios') parts.push(compassAcc != null ? `compass ±${Math.round(compassAcc)}°` : 'compass');
    else if (compass === 'relative') parts.push(align ? 'gyro, north set by hand' : 'no compass north — face a station you can see and align on it');
    else if (compass === 'waiting') parts.push('looking for a compass…');
    else parts.push('no compass — drag or ← → to turn');
    if ((compass === 'absolute' || compass === 'ios') && here) parts.push(`true north, ${declText(decl)} declination`);
    if (source === 'gps' && camState === 'denied') parts.push('camera refused');
    el.textContent = parts.join(' · ');
    view.classList.toggle('is-manual', !sensorLive());
    const useMap = $('ar-use-map');
    if (useMap) useMap.hidden = !(source === 'gps' && gpsError && state.map);
    const un = $('ar-unalign');
    if (un) {
      un.hidden = !align;
      un.textContent = `Undo align (${align > 0 ? '+' : '−'}${Math.abs(align).toFixed(0)}°)`;
    }
  }

  function detailHtml(at) {
    const { c, m } = at;
    const s = m.s;
    const ids = typeof stationAlertIdTypes === 'function' ? stationAlertIdTypes(s) : [];
    const others = c.members.filter(x => x !== m);
    const idsHtml = ids.length
      ? `ALERT ${ids.length === 1 ? 'ID' : 'IDs'}: ${ids.map(x => `<strong>${esc(String(x.id))}</strong>${x.types.length
          ? ` <span class="ar-detail-kind">${esc(x.types.join(', '))}</span>` : ''}`).join(' · ')}`
      : 'No ALERT IDs on file';
    return `
      <div class="ar-detail-head role-${m.role}">
        <span class="ar-letter" aria-hidden="true">${LETTER[m.role]}</span>
        <h3 class="ar-detail-name" id="ar-detail-h">${esc(s.name || 'Unnamed station')}</h3>
        <button type="button" class="ar-x" onclick="StationAR.unpick()" aria-label="Close the station's details" title="Close (Esc)">✕</button>
      </div>
      <p class="ar-detail-line">${esc(ROLE_LABEL[m.role])} · ${s.station_number
        ? `Stn # <strong>${esc(String(s.station_number))}</strong>` : 'no station number'}${s.enabled === false
        ? ' · <span class="ar-detail-kind">not enabled</span>' : ''} ${proposedTagHtml(s, { short: true })}</p>
      <p class="ar-detail-line">${esc(fmtKm(m.d))} away, bearing <strong>${esc(bearingText(m.b))}</strong></p>
      <p class="ar-detail-line">${idsHtml}</p>
      <div class="button-group ar-detail-actions">
        <button type="button" class="primary" onclick="StationAR.showOnMap()">Show on the map</button>
        ${sensorLive()
          ? `<button type="button" onclick="StationAR.alignHere()" title="Point the phone straight at this station — a mast or a hut you can see — and press: every pin moves to agree">I'm facing it — align</button>`
          : `<button type="button" onclick="StationAR.turnTo()">Turn to it</button>`}
      </div>
      ${others.length ? `<h4 class="ar-more-h">${others.length} more this way</h4>
      <ul class="ar-more">${others.slice(0, MORE_CAP).map(x => `<li><button type="button" class="ar-more-row role-${x.role}"
            data-id="${escAttr(x.s.id)}" onclick="StationAR.pickStation(this.dataset.id)"><span class="ar-letter"
            aria-hidden="true">${LETTER[x.role]}</span><span class="ar-more-name">${esc(x.s.name || 'Unnamed station')}</span><span
            class="ar-more-d">${esc(fmtKm(x.d))}</span></button></li>`).join('')}</ul>
      ${others.length > MORE_CAP ? `<p class="ar-more-cap">…and ${others.length - MORE_CAP} more further out.</p>` : ''}` : ''}`;
  }

  function renderDetail() {
    const el = $('ar-detail');
    if (!el) return;
    const at = findPick();
    const inside = el.contains(document.activeElement);
    if (!at) {
      el.hidden = true;
      el.innerHTML = '';
      if (inside) view.focus({ preventScroll: true });
      return;
    }
    el.innerHTML = detailHtml(at);
    el.hidden = false;
    if (inside) el.focus({ preventScroll: true });
  }

  // Ask for a frame; everything that changes the picture comes through here.
  function touch() {
    if (view && !raf) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    if (!view) return;
    const stage = $('ar-stage');
    const { w, h, f } = proj;
    const H = headingNow();
    const pitch = clamp(pitchNow(), -60, 60);
    const ce = Math.max(0.35, Math.cos(pitch * RAD));
    const horizon = clamp(h / 2 + f * Math.tan(pitch * RAD), h * 0.2, h * 0.85);
    stage.style.setProperty('--ar-h', `${horizon.toFixed(1)}px`);
    stage.style.setProperty('--ar-roll', `${rollNow().toFixed(2)}deg`);
    const a = document.activeElement;
    const onScreen = [];
    for (const el of pinEls) {
      const c = plan && plan.clusters[Number(el.dataset.k)];
      let show = !!c && H != null, x = 0;
      if (show) {
        const rel = wrap180(c.b - H);
        show = Math.abs(rel) < 80;
        if (show) {
          x = w / 2 + f * Math.tan(rel * RAD) / ce;
          show = x > -EDGE_PX && x < w + EDGE_PX;
        }
      }
      if (show) onScreen.push({ el, c, x });
      if (el.hidden === show) {
        if (!show && a && el.contains(a)) view.focus({ preventScroll: true });
        el.hidden = !show;
      }
    }
    slideOntoScreen(onScreen, w);
    for (const p of onScreen) {
      p.el.style.setProperty('--ar-x', `${p.x.toFixed(1)}px`);
      p.el.style.setProperty('--ar-dx', `${p.dx.toFixed(1)}px`);
    }
    const hd = $('ar-heading');
    const shown = H == null ? null : Math.round(H) % 360;
    if (hd && shown !== shownHeading) {
      shownHeading = shown;
      hd.textContent = shown == null ? '—' : bearingText(shown);
    }
    const rot = $('ar-radar-rot');
    if (rot) rot.style.setProperty('--ar-rot', `${H == null ? 0 : (-H).toFixed(1)}deg`);
    paintEdge(H, w, f, ce);
    paintHint(H, pitch);
  }

  // A label cut by the screen's edge slides back onto it — as far as it can
  // and still stand on its stem, and no further than the next label in its
  // row leaves room for. The stem stays on the bearing. `pins` are the shown
  // ones, { c, x }; each gets its slide as `dx`.
  function slideOntoScreen(pins, w) {
    const rows = new Map();
    for (const p of pins) {
      p.dx = 0;
      if (!rows.has(p.c.row)) rows.set(p.c.row, []);
      rows.get(p.c.row).push(p);
    }
    for (const row of rows.values()) {
      row.sort((p, q) => p.x - q.x);
      row.forEach((p, i) => {
        const half = p.c.px / 2, reach = Math.max(0, half - 10);
        const left = p.x - half, right = p.x + half;
        if (left < 4) {
          const next = row[i + 1];
          const room = next ? next.x - next.c.px / 2 - LABEL_GAP_PX - right : Infinity;
          p.dx = Math.max(0, Math.min(4 - left, reach, room));
        } else if (right > w - 4) {
          const prev = row[i - 1];
          const room = prev ? left - (prev.x + prev.dx + prev.c.px / 2) - LABEL_GAP_PX : Infinity;
          p.dx = -Math.max(0, Math.min(right - (w - 4), reach, room));
        }
      });
    }
  }

  // The picked station, when it is off the screen: which way to turn, and how far.
  function paintEdge(H, w, f, ce) {
    const el = $('ar-edge');
    if (!el) return;
    const at = findPick();
    let side = null, rel = 0;
    if (at && H != null) {
      rel = wrap180(at.m.b - H);
      const x = Math.abs(rel) < 80 ? w / 2 + f * Math.tan(rel * RAD) / ce : (rel < 0 ? -1 : w + 1);
      if (x < 0) side = 'left'; else if (x > w) side = 'right';
    }
    el.hidden = !side;
    if (!side) return;
    el.className = `ar-edge is-${side} role-${at.m.role}`;
    const deg = `${Math.round(Math.abs(rel))}°`;
    el.textContent = side === 'left' ? `◀ ${deg} ${LETTER[at.m.role]}` : `${LETTER[at.m.role]} ${deg} ▶`;
  }

  function paintHint(H, pitch) {
    const el = $('ar-hint');
    if (!el) return;
    let text = '';
    if (sensorLive() && vec && Math.abs(pitchOf(vec)) > 50) text = 'Hold the phone upright, its camera to the horizon.';
    else if (compass === 'ios' && H == null) text = 'Hold the phone up so the compass can find north.';
    else if (compass === 'ios' && compassAcc != null && compassAcc > 25) text = 'The compass is unsure — move the phone in a figure of eight.';
    el.hidden = !text;
    if (el.textContent !== text) el.textContent = text;
  }

  // ── Doing things ───────────────────────────────────────────────────────────

  function pickCluster(k) {
    const c = plan && plan.clusters[k];
    if (!c) return;
    pickStation(c.members[0].s.id);
  }

  function pickStation(id) {
    if (!view || !plan) return;
    pick = { id };
    if (!findPick()) { pick = null; return; }
    pinEls.forEach(el => {
      const c = plan.clusters[Number(el.dataset.k)];
      const on = c.members.some(x => x.s.id === id);
      el.classList.toggle('is-picked', on);
      const b = el.querySelector('.ar-pin-box');
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    });
    renderRadar();
    renderDetail();
    const el = $('ar-detail');
    if (el && !el.hidden) el.focus({ preventScroll: true });
    touch();
  }

  function unpick() {
    if (!pick) return;
    const at = findPick();
    pick = null;
    pinEls.forEach(el => {
      el.classList.remove('is-picked');
      el.querySelector('.ar-pin-box').removeAttribute('aria-current');
    });
    renderRadar();
    renderDetail();
    const pin = at && pinEls[at.k];
    if (pin && !pin.hidden) pin.querySelector('button').focus({ preventScroll: true });
    else if (view) view.focus({ preventScroll: true });
    touch();
  }

  function pickedStation() {
    const at = findPick();
    return at ? at.m : null;
  }

  // Off to the map with it: the station's card, the map on its pin. On a phone
  // the side panel's pane is a drawer over the map, so it goes too.
  function showOnMap() {
    const m = pickedStation();
    if (!m) return;
    const drawer = typeof isPhoneNav === 'function' && isPhoneNav() && typeof shutDock === 'function';
    // Focus goes back to Look around — except into a drawer that is going.
    close({ refocus: !drawer });
    if (drawer) shutDock({ instant: true });
    if (typeof focusStationOnMap === 'function') focusStationOnMap(m.s);
  }

  // "I'm facing it": north moved so that the picked station is dead ahead.
  function alignHere() {
    const m = pickedStation();
    const H = headingNow();
    if (!m || H == null || !sensorLive()) return;
    align = wrap180(align + wrap180(m.b - H));
    status();
    touch();
    announce(`Aligned on ${m.s.name}.`);
  }

  function unalign() {
    align = 0;
    status();
    touch();
  }

  function turnTo() {
    const m = pickedStation();
    if (!m || sensorLive()) return;
    manualHeading = norm360(m.b);
    touch();
  }

  function turn(deg) {
    if (sensorLive()) return;
    manualHeading = norm360(manualHeading + deg);
    touch();
  }

  // No GPS to be had: stand in the middle of the map instead. The picture
  // goes with the GPS — it would be of somewhere else.
  function useMap() {
    if (!view || !state.map) return;
    stopGps();
    stopCamera();
    source = 'map';
    gpsError = '';
    here = mapCentre();
    measure();
    replan();
  }

  function dragStart(e) {
    if (!view || sensorLive() || (e.button != null && e.button > 0)) return;
    if (e.target.closest && e.target.closest('button, input, a, .ar-detail')) return;
    drag = { id: e.pointerId, x: e.clientX, h: manualHeading };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic pointer */ }
  }

  function dragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    manualHeading = norm360(drag.h - (e.clientX - drag.x) / pxPerDeg());
    touch();
  }

  function dragEnd(e) {
    if (drag && e.pointerId === drag.id) drag = null;
  }

  function onResize() {
    if (!view) return;
    if (measure()) replan(); else touch();
  }

  // Escape puts the sheet down, then the view; Tab stays inside; ← and → turn
  // where no compass does. Claimed in the capture phase, as Modal's is, so the
  // drawer and the full-screen map under it stand down.
  function onKey(e) {
    if (!view) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (pick) unpick(); else close();
      return;
    }
    if (e.key === 'Tab') {
      const items = [...view.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(n => n.getClientRects().length);
      if (!items.length) return;
      const at = items.indexOf(document.activeElement);
      if (e.shiftKey) { if (at <= 0) { e.preventDefault(); items[items.length - 1].focus(); } }
      else if (at < 0 || at === items.length - 1) { e.preventDefault(); items[0].focus(); }
      return;
    }
    const t = e.target;
    if (t && t.matches && t.matches('input, textarea, select')) return;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !sensorLive()) {
      e.preventDefault();
      turn((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 20 : TURN_STEP));
    }
  }

  return {
    paneHtml,
    syncPane,
    open,
    close,
    setRange,
    toggleRole,
    pickCluster,
    pickStation,
    unpick,
    showOnMap,
    alignHere,
    unalign,
    turnTo,
    turn,
    useMap,

    // The arithmetic, for the checks (test/ar.mjs) — none of it touches the page.
    wmmField,
    declination,
    orient,
    headingOf,
    pitchOf,
    rollOf,
    clusterByBearing,
    layoutRows,
    RANGES_KM,

    // Read by the checks: what the view holds.
    debug() {
      return {
        open: !!view, source, here, compass, camera: camState, gps: watchId != null, gpsError,
        heading: view ? headingNow() : null, pitch: view ? pitchNow() : null, roll: view ? rollNow() : null,
        decl, align, rangeKm: RANGES_KM[rangeIdx], roles: { ...roles }, f: proj.f, w: proj.w, h: proj.h,
        width: plan ? plan.width : null, n: plan ? plan.n : null,
        clusters: plan ? plan.clusters.map(c => ({
          b: c.b, d: c.d, row: c.row, n: c.members.length, role: c.members[0].role,
          id: c.members[0].s.id, name: c.members[0].s.name, ids: c.members.map(x => x.s.id),
        })) : null,
        visible: pinEls.filter(el => !el.hidden).map(el => el.dataset.id),
        pick: pick ? pick.id : null,
        listening, tracks: stream ? stream.getTracks().filter(t => t.readyState === 'live').length : 0,
      };
    },
  };
})();
if (typeof window !== 'undefined') window.StationAR = StationAR;
