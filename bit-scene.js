// MegaNet — bit-scene.js
//
//   BitScene   the 🧪 Bit Bench's site in 3-D: one made-up ALERT site with
//              everything the bench's fourteen faults come from in it. A river
//              gauge sends; a repeater on the hill across the valley hears it;
//              and between and around them stand the hill that grazes the
//              path, a shed and a passing truck to echo off, a second gauge
//              that keys up on top of ours, a pager mast and a phone tower
//              beside the repeater, a storm and an electric fence, the sun
//              baking the gauge's hut — and inside the hut the logger, its
//              wiring and the float's shaft encoder. Each fault lights the
//              place it happens, shows what goes on there, and draws a
//              close-up of it beside the site.
//
// After core.js (cssVar), propagation-physics.js (PropPhysics: its seeded
// generator and keying times) and bit-model.js (BitModel), all read at call
// time. Every figure a close-up quotes is the model's, worked from the fault's
// settings as they stand on the bench — and where the model has a channel for
// the fault, the close-up sends a frame through it — so the site and the bench
// below it always agree. Before bit-bench.js, which owns the card, its buttons,
// the tour and the one animation loop, and calls draw() and closeUp() with the
// fault and its settings. Nothing here runs at load.
//
// ── How it is drawn ──────────────────────────────────────────────────────────
// A renderer of its own on a plain 2-D canvas, as the 🎓 Radio Propagation
// lesson's scene is (propagation-scene.js says why): flat-shaded ground quads,
// boxes, masts and trees sorted far to near (painter's algorithm), so it needs
// no library and no signal. Everything that stands still is drawn once per
// view into an offscreen canvas; each frame lays the moving parts over it —
// the signal on its way, the echoes, the bursts, the truck, the sun — then the
// marker on the culprit and the tour's dots. The close-up is a canvas of its
// own beside it (closeUp), so it never stands in front of the site. It is a
// model of a site, not a map: nothing is to scale, and heights least of all.
//
// Exposes: draw, closeUp, closeOf, SPOTS, ORDER, YAW0, clampYaw.

const BitScene = (function () {
  const BM = () => BitModel;

  // ── The site ───────────────────────────────────────────────────────────────
  // Model units: x east, y north (the camera looks north from the south), z up.
  const GW = 120, GH = 72;
  const NX = 60, NY = 36;            // ground cells, two units each
  const ROAD_Y = 5;
  const HILLS = [
    { x: 58,  y: 40, h: 20, s: 11 },  // the hill between the gauge and the repeater
    { x: 103, y: 48, h: 17, s: 9 },   // the repeater's hill
    { x: 22,  y: 70, h: 10, s: 13 },  // rising ground to the north-west
  ];
  function riverY(x) { return 12.5 + 2.6 * Math.sin(x / 15 + 0.4); }
  function groundZ(x, y) {
    let z = 0.07 * y;
    for (const k of HILLS) {
      const dx = x - k.x, dy = y - k.y;
      z += k.h * Math.exp(-(dx * dx + dy * dy) / (2 * k.s * k.s));
    }
    const dr = y - riverY(x);
    return z - 2.4 * Math.exp(-(dr * dr) / (2 * 1.5 * 1.5));
  }
  const up = (x, y, h) => [x, y, groundZ(x, y) + h];

  // Where everything stands.
  const PLACE = {
    hut:   { x: 11, y: 18.5, w: 4.6, d: 3.6, h: 3.2 },  // the gauge's hut: logger and radio
    mast:  { x: 17.4, y: 20.2, h: 11 },                  // …and its aerial
    well:  { x: 13.6, y: 15.9 },                         // the stilling well, at the water's edge
    rhut:  { x: 99.2, y: 45.2, w: 3.2, d: 2.6, h: 2.6 },
    rmast: { x: 103.4, y: 47.8, h: 16 },                 // the repeater
    shed:  { x: 62, y: 21.5, w: 11, d: 5.5, h: 6 },
    hut2:  { x: 42, y: 59, w: 3.6, d: 3, h: 2.8 },       // the other gauge
    mast2: { x: 46.6, y: 60.6, h: 9 },
    pager: { x: 115, y: 33, h: 32 },
    phone: { x: 88, y: 65, h: 28 },
    fence: { x0: 74, x1: 96, y0: 29, y1: 33 },
    cloud: { x: 44, y: 47, z: 40 },
    strike: { x: 49, y: 49 },
  };

  // The points the drawings start and end at.
  function pt(name) {
    const P = PLACE;
    switch (name) {
      case 'tx':     return up(P.mast.x, P.mast.y, P.mast.h);
      case 'rx':     return up(P.rmast.x, P.rmast.y, P.rmast.h);
      case 'tx2':    return up(P.mast2.x, P.mast2.y, P.mast2.h);
      case 'pager':  return up(P.pager.x, P.pager.y, P.pager.h - 1);
      case 'phone':  return up(P.phone.x, P.phone.y, P.phone.h - 1);
      case 'hut':    return up(P.hut.x + P.hut.w / 2, P.hut.y + P.hut.d / 2, P.hut.h + 0.4);
      case 'well':   return up(P.well.x, P.well.y, 3.2);
      case 'echo':   return up(P.shed.x + 1, P.shed.y, 4.5);
      case 'fence':  return up((P.fence.x0 + P.fence.x1) / 2, (P.fence.y0 + P.fence.y1) / 2, 1.4);
      case 'strike': return up(P.strike.x, P.strike.y, 0);
      default:       return up(60, 36, 0);
    }
  }

  // ── Vectors ────────────────────────────────────────────────────────────────
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const lerp3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  const L = norm([-0.5, -0.45, 0.75]);     // lit from the south-west, above
  // Repeatable noise, so a speckle or a tree is the same every frame.
  function hn(i) { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

  // ── The camera ─────────────────────────────────────────────────────────────
  // It looks north across the valley; dragging turns it about the middle of
  // the site, a third of a turn either way.
  const TARGET = [62, 36, 7];
  const PITCH = 0.5, DIST = 150;
  const YAW0 = -0.28;
  const clampYaw = y => Math.max(-1.15, Math.min(0.75, y));
  const SKIRT = -6;                  // the block of ground goes down this far

  // What has to be in the picture: the block's corners top and bottom, and
  // the masts' tips. (The storm may run off the top: it is weather.)
  let fitPts = null;
  function fitList() {
    if (fitPts) return fitPts;
    const P = PLACE;
    fitPts = [[0, 0], [GW, 0], [GW, GH], [0, GH]].flatMap(([x, y]) => [[x, y, SKIRT], [x, y, groundZ(x, y) + 2]]);
    fitPts.push(up(P.pager.x, P.pager.y, P.pager.h + 2), up(P.phone.x, P.phone.y, P.phone.h + 2),
      up(P.rmast.x, P.rmast.y, P.rmast.h + 4));
    return fitPts;
  }

  // The camera, framed so that all of it fits the canvas whichever way the
  // site is turned: room left at the top for the title, at the foot for the
  // tour's dots.
  function basis(w, h, yaw) {
    const cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    const eye = [TARGET[0] + DIST * cp * Math.sin(yaw), TARGET[1] - DIST * cp * Math.cos(yaw), TARGET[2] + DIST * sp];
    const f = norm(sub(TARGET, eye));
    const r = norm(cross(f, [0, 0, 1]));
    const u = cross(r, f);
    const B = { eye, f, r, u, F: 1, cx: 0, cy: 0 };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of fitList()) {
      const q = proj(B, p);
      if (!q) continue;
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    const top = 36, foot = 22, side = 10;
    const k = Math.min((w - 2 * side) / (x1 - x0), (h - top - foot) / (y1 - y0));
    B.F = k;
    B.cx = w / 2 - k * (x0 + x1) / 2;
    B.cy = top + (h - top - foot) / 2 - k * (y0 + y1) / 2;
    return B;
  }
  function proj(B, p) {
    const v = sub(p, B.eye);
    const zc = dot(v, B.f);
    if (zc < 1) return null;
    return [B.cx + B.F * dot(v, B.r) / zc, B.cy - B.F * dot(v, B.u) / zc, zc];
  }

  // ── Colour ─────────────────────────────────────────────────────────────────
  // The landscape wears the 🎓 Radio Propagation scene's tokens, so the two
  // sites look like the same country; the ink, the signal and the status
  // colours are the app's, read again when the theme moves.
  const TOK = {
    sky: ['--rp-sky', '#cfe3f6'], sky2: ['--rp-sky-2', '#f2f7fc'], grass: ['--rp-grass', '#b5cf8f'],
    forest: ['--rp-forest', '#6f9a57'], tree: ['--rp-tree', '#2f6b35'], water: ['--rp-water', '#4f9bd9'],
    building: ['--rp-building', '#ece7de'], roof: ['--rp-silo', '#dcd6c9'], road: ['--bs-road', '#9d978b'],
    earth: ['--rp-ground', '#c9b48a'],
    solar: ['--bs-solar', '#2c4a72'], steel: ['--bs-steel', '#6f7a85'], mastRed: ['--bs-mast-red', '#c8352b'],
    wave: ['--rp-wave', '#0088b8'], echo: ['--rp-echo', '#d26a00'], sum: ['--rp-sum', '#7c35a3'],
    field: ['--role-field', '#107c10'], repeater: ['--role-repeater', '#0b5cab'],
    text: ['--text', '#16202a'], muted: ['--muted', '#4f6478'], panel: ['--panel', '#ffffff'],
    border: ['--border', '#dde5ee'], subtle: ['--subtle', '#f2f6fa'], accent: ['--accent', '#0b5cab'],
    ok: ['--ok', '#107c10'], warn: ['--warn', '#9a6700'], bad: ['--bad', '#c62828'],
  };
  let palCache = null, palTheme = null;
  function pal() {
    const theme = document.documentElement.getAttribute('data-theme') || '';
    if (palCache && palTheme === theme) return palCache;
    palTheme = theme;
    palCache = {};
    for (const [k, [name, fb]] of Object.entries(TOK)) palCache[k] = typeof cssVar === 'function' ? (cssVar(name, fb) || fb) : fb;
    palCache.key = theme + Object.values(palCache).join('');
    return palCache;
  }
  let scratch = null;
  function rgb(col) {
    if (!scratch) scratch = document.createElement('canvas').getContext('2d');
    scratch.fillStyle = '#808080';
    scratch.fillStyle = col;
    const c = scratch.fillStyle;
    if (/^#[0-9a-f]{6}$/i.test(c)) { const n = parseInt(c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(c);
    return m ? [+m[1], +m[2], +m[3]] : [128, 128, 128];
  }
  const shade = (c, k) => `rgb(${Math.round(Math.min(255, c[0] * k))},${Math.round(Math.min(255, c[1] * k))},${Math.round(Math.min(255, c[2] * k))})`;
  const alpha = (col, a) => { const c = rgb(col); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };

  // ── The world, built once ──────────────────────────────────────────────────
  let world0 = null;
  function world() {
    if (world0) return world0;
    const hv = new Float32Array((NX + 1) * (NY + 1));
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) hv[j * (NX + 1) + i] = groundZ(i * GW / NX, j * GH / NY);
    // Trees: thick on the hills' flanks and the high ground, never in the
    // river, on the road or on anything built.
    const clear = [[PLACE.hut.x + 2, PLACE.hut.y + 2, 7], [PLACE.rmast.x - 2, PLACE.rmast.y - 1, 6], [PLACE.shed.x + 5, PLACE.shed.y + 3, 9],
      [PLACE.mast2.x - 2, PLACE.mast2.y, 5], [PLACE.pager.x, PLACE.pager.y, 4], [PLACE.phone.x, PLACE.phone.y, 4], [85, 31, 12]];
    const trees = [];
    for (let k = 0; k < 900 && trees.length < 95; k++) {
      const x = 2 + hn(k) * (GW - 4), y = 9 + hn(k + 0.31) * (GH - 11);
      if (Math.abs(y - riverY(x)) < 3) continue;
      if (clear.some(([cx, cy, r]) => Math.hypot(x - cx, y - cy) < r)) continue;
      const hill = (groundZ(x, y) - 0.07 * y) / 20;
      const dens = 0.12 + 0.55 * Math.min(1, hill * 1.6) * (hill > 0.85 ? 0.4 : 1) + (y > 58 ? 0.25 : 0);
      if (hn(k + 0.77) < dens) trees.push({ x, y, s: 0.8 + 0.6 * hn(k + 0.13) });
    }
    world0 = { hv, trees };
    return world0;
  }

  // ── Building the still picture ─────────────────────────────────────────────
  // Every shape is a primitive with a depth; the lot are sorted far to near
  // and drawn in turn.
  function addBox(prims, B, b, col, roofCol) {
    const { x, y, w, d, h } = b;
    const z0 = Math.min(groundZ(x, y), groundZ(x + w, y), groundZ(x + w, y + d), groundZ(x, y + d)) - 0.3;
    const z1 = Math.max(groundZ(x, y), groundZ(x + w, y + d)) + h;
    const cs = [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
    const lo = cs.map(([a, c]) => proj(B, [a, c, z0]));
    const hi = cs.map(([a, c]) => proj(B, [a, c, z1]));
    if (lo.some(p => !p) || hi.some(p => !p)) return;
    const base = rgb(col);
    for (const [i0, i1, n] of [[0, 1, [0, -1, 0]], [1, 2, [1, 0, 0]], [2, 3, [0, 1, 0]], [3, 0, [-1, 0, 0]]]) {
      const mid = [(cs[i0][0] + cs[i1][0]) / 2, (cs[i0][1] + cs[i1][1]) / 2, z0];
      if (dot(n, sub(B.eye, mid)) <= 0) continue;
      prims.push({ d: (lo[i0][2] + lo[i1][2]) / 2 - 0.3, poly: [lo[i0], lo[i1], hi[i1], hi[i0]],
        fill: shade(base, 0.62 + 0.42 * Math.max(0, dot(n, L))), edge: true });
    }
    prims.push({ d: (hi[0][2] + hi[2][2]) / 2 - 0.35, poly: hi, fill: shade(rgb(roofCol || col), 1.04), edge: true });
  }
  function addLine(prims, B, a, b, col, wUnits, dz) {
    const p = proj(B, a), q = proj(B, b);
    if (!p || !q) return;
    const dd = Math.max(p[2], q[2]);
    prims.push({ d: dd - (dz || 0), line: [p, q], stroke: col, width: Math.max(0.8, B.F * wUnits / dd) });
  }
  // A lattice mast: two legs closing towards the top, braced in zig-zags
  // (in a second colour, if it has one).
  function addLattice(prims, B, x, y, h, wb, colA, colB) {
    const g = groundZ(x, y);
    const rh = norm([B.r[0], B.r[1], 0]);
    const leg = (s, z) => { const half = (wb / 2) * (1 - 0.75 * (z / h)); return [x + rh[0] * s * half, y + rh[1] * s * half, g + z]; };
    const n = Math.max(4, Math.round(h / 3));
    for (let k = 0; k < n; k++) {
      const za = h * k / n, zb = h * (k + 1) / n;
      addLine(prims, B, leg(-1, za), leg(-1, zb), colA, 0.32, 0.6);
      addLine(prims, B, leg(1, za), leg(1, zb), colA, 0.32, 0.6);
      addLine(prims, B, leg(k % 2 ? 1 : -1, za), leg(k % 2 ? -1 : 1, zb), colB || colA, 0.14, 0.6);
    }
  }

  let G = null;     // the still picture: { cv, key }
  function ground(B, w, h, dpr, C, yaw) {
    const key = [w, h, dpr, yaw.toFixed(3), C.key].join('|');
    if (G && G.key === key) return G.cv;
    if (!G) G = { cv: document.createElement('canvas'), key: '' };
    const cv = G.cv;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, C.sky);
    sky.addColorStop(1, C.sky2);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const { hv, trees } = world();
    const pts = new Array(hv.length);
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
      const k = j * (NX + 1) + i;
      pts[k] = proj(B, [i * GW / NX, j * GH / NY, hv[k]]);
    }
    const prims = [];
    const grass = rgb(C.grass), water = rgb(C.water), forest = rgb(C.forest);
    const cx = GW / NX, cy = GH / NY;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const k = j * (NX + 1) + i;
      const q = [pts[k], pts[k + 1], pts[k + NX + 2], pts[k + NX + 1]];
      if (q.some(p => !p)) continue;
      const dx = (hv[k + 1] + hv[k + NX + 2] - hv[k] - hv[k + NX + 1]) / 2 / cx;
      const dy = (hv[k + NX + 1] + hv[k + NX + 2] - hv[k] - hv[k + 1]) / 2 / cy;
      const n = norm([-dx, -dy, 1]);
      const lit = 0.5 + 0.6 * Math.max(0, dot(n, L));
      const x = (i + 0.5) * cx, y = (j + 0.5) * cy;
      const wet = Math.abs(y - riverY(x)) < 1.05;
      const high = (hv[k] - 0.07 * y) / 20;
      const base = wet ? water : high > 0.5 ? forest : grass;
      prims.push({ d: (q[0][2] + q[2][2]) / 2, poly: q, fill: shade(base, (wet ? 1 : lit) * (0.97 + 0.06 * hn(k))) });
    }
    // The block's sides, where the camera can see them: earth, darker with
    // depth, so the site sits on the page as a model rather than a map.
    const earth = rgb(C.earth);
    const edges = [
      { n: [0, -1, 0], at: k => [k * GW / NX, 0], len: NX },
      { n: [1, 0, 0], at: k => [GW, k * GH / NY], len: NY },
      { n: [0, 1, 0], at: k => [GW - k * GW / NX, GH], len: NX },
      { n: [-1, 0, 0], at: k => [0, GH - k * GH / NY], len: NY },
    ];
    for (const e of edges) {
      const [mx, my] = e.at(e.len / 2);
      if (dot(e.n, sub(B.eye, [mx, my, 0])) <= 0) continue;
      const lit = 0.55 + 0.4 * Math.max(0, dot(e.n, L));
      for (let k = 0; k < e.len; k++) {
        const [xa, ya] = e.at(k), [xb, yb] = e.at(k + 1);
        const q = [proj(B, [xa, ya, groundZ(xa, ya)]), proj(B, [xb, yb, groundZ(xb, yb)]), proj(B, [xb, yb, SKIRT]), proj(B, [xa, ya, SKIRT])];
        if (q.some(p => !p)) continue;
        prims.push({ d: (q[0][2] + q[1][2]) / 2 + 0.5, poly: q, fill: shade(earth, lit) });
      }
    }
    // The road along the front, in short pieces, each a little in front of
    // the ground it lies on.
    for (let x = 0; x < GW; x += 3) {
      const a = up(x, ROAD_Y, 0.15), b = up(x + 3, ROAD_Y, 0.15);
      const p = proj(B, a), q = proj(B, b);
      if (!p || !q) continue;
      prims.push({ d: Math.max(p[2], q[2]) - 3, line: [p, q], stroke: C.road, width: B.F * 2.6 / p[2], cap: 'butt' });
    }
    // Things built.
    const P = PLACE;
    addBox(prims, B, P.hut, C.building, C.roof);
    addBox(prims, B, P.rhut, C.building, C.roof);
    addBox(prims, B, P.shed, C.roof, C.steel);
    addBox(prims, B, P.hut2, C.building, C.roof);
    // The hut's solar panel, tilted to the north on its roof.
    {
      const hz = groundZ(P.hut.x, P.hut.y) + P.hut.h + 0.1;
      const a = proj(B, [P.hut.x + 0.6, P.hut.y + 0.5, hz + 0.1]), b = proj(B, [P.hut.x + 3.6, P.hut.y + 0.5, hz + 0.1]);
      const c2 = proj(B, [P.hut.x + 3.6, P.hut.y + 2.6, hz + 1.3]), d = proj(B, [P.hut.x + 0.6, P.hut.y + 2.6, hz + 1.3]);
      if (a && b && c2 && d) prims.push({ d: a[2] - 2, poly: [a, b, c2, d], fill: C.solar, edge: true });
    }
    // The stilling well: a concrete pipe from the riverbed to above the bank.
    addBox(prims, B, { x: P.well.x - 0.7, y: P.well.y - 0.7, w: 1.4, d: 1.4, h: 3 }, C.roof, C.steel);
    // Masts and aerials.
    addLine(prims, B, up(P.mast.x, P.mast.y, 0), up(P.mast.x, P.mast.y, P.mast.h), C.steel, 0.35);
    addLine(prims, B, up(P.mast.x, P.mast.y, P.mast.h - 0.4), up(P.mast.x, P.mast.y, P.mast.h + 2.4), C.text, 0.16);
    addLine(prims, B, up(P.hut.x + P.hut.w, P.hut.y + 1.5, 2.4), up(P.mast.x, P.mast.y, 2.4), C.text, 0.1);
    addLattice(prims, B, P.rmast.x, P.rmast.y, P.rmast.h, 2.2, C.steel);
    addLine(prims, B, up(P.rmast.x, P.rmast.y, P.rmast.h - 0.5), up(P.rmast.x, P.rmast.y, P.rmast.h + 2.8), C.text, 0.16);
    addLine(prims, B, up(P.mast2.x, P.mast2.y, 0), up(P.mast2.x, P.mast2.y, P.mast2.h), C.steel, 0.3);
    addLine(prims, B, up(P.mast2.x, P.mast2.y, P.mast2.h - 0.4), up(P.mast2.x, P.mast2.y, P.mast2.h + 2), C.text, 0.14);
    addLattice(prims, B, P.pager.x, P.pager.y, P.pager.h, 3.2, C.mastRed, C.steel);
    addLine(prims, B, up(P.phone.x, P.phone.y, 0), up(P.phone.x, P.phone.y, P.phone.h), C.steel, 0.9);
    for (const a of [0, 2.1, 4.2]) {
      const ox = Math.cos(a) * 1.1, oy = Math.sin(a) * 1.1;
      addLine(prims, B, up(P.phone.x + ox, P.phone.y + oy, P.phone.h - 3.2), up(P.phone.x + ox, P.phone.y + oy, P.phone.h - 0.2), C.building, 0.7, -0.1);
    }
    // The electric fence: posts and a wire.
    const posts = [];
    for (let k = 0; k <= 6; k++) {
      const x = P.fence.x0 + (P.fence.x1 - P.fence.x0) * k / 6, y = P.fence.y0 + (P.fence.y1 - P.fence.y0) * k / 6;
      posts.push(up(x, y, 1.6));
      addLine(prims, B, up(x, y, 0), up(x, y, 1.6), C.steel, 0.2);
    }
    for (let k = 0; k < 6; k++) addLine(prims, B, posts[k], posts[k + 1], C.muted, 0.06, -0.2);
    // Trees: a dark cone on a stalk.
    const tc = rgb(C.tree);
    for (const t of trees) {
      const g = groundZ(t.x, t.y);
      const p0 = proj(B, [t.x, t.y, g]), p1 = proj(B, [t.x, t.y, g + 5.5 * t.s]);
      if (!p0 || !p1) continue;
      const half = Math.max(1.5, B.F * 1.4 * t.s / p0[2]);
      const pb = [p0[0], p0[1] - (p0[1] - p1[1]) * 0.18];
      prims.push({ d: p0[2] - 0.2, poly: [[pb[0] - half, pb[1]], [pb[0] + half, pb[1]], [p1[0], p1[1]]], fill: shade(tc, 0.85 + 0.35 * hn(t.x * 7.3)) });
    }

    prims.sort((a, b) => b.d - a.d);
    ctx.lineJoin = 'round';
    for (const p of prims) {
      if (p.line) {
        ctx.beginPath();
        ctx.moveTo(p.line[0][0], p.line[0][1]);
        ctx.lineTo(p.line[1][0], p.line[1][1]);
        ctx.strokeStyle = p.stroke;
        ctx.lineWidth = p.width;
        ctx.lineCap = p.cap || 'round';
        ctx.stroke();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(p.poly[0][0], p.poly[0][1]);
      for (let i = 1; i < p.poly.length; i++) ctx.lineTo(p.poly[i][0], p.poly[i][1]);
      ctx.closePath();
      ctx.fillStyle = p.fill;
      ctx.fill();
      ctx.strokeStyle = p.edge ? 'rgba(0,0,0,.28)' : p.fill;
      ctx.lineWidth = p.edge ? 0.7 : 0.6;
      ctx.stroke();
    }
    // The river, smooth over the blocky water.
    ctx.beginPath();
    let first = true;
    for (let x = 0; x <= GW; x += 1.5) {
      const p = proj(B, up(x, riverY(x), 0.1));
      if (!p) continue;
      if (first) { ctx.moveTo(p[0], p[1]); first = false; } else ctx.lineTo(p[0], p[1]);
    }
    ctx.strokeStyle = alpha(C.water, 0.85);
    ctx.lineWidth = Math.max(2, B.F * 1.1 / DIST);
    ctx.lineCap = 'round';
    ctx.stroke();
    G.key = key;
    return cv;
  }

  // ── The moving parts' kit ──────────────────────────────────────────────────
  const FONT = '11px system-ui, -apple-system, Segoe UI, sans-serif';
  const FONT_B = '600 11px system-ui, -apple-system, Segoe UI, sans-serif';
  const FONT_T = '700 13px system-ui, -apple-system, Segoe UI, sans-serif';
  const MONO = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  function text(ctx, s, x, y, col, o) {
    const opt = o || {};
    ctx.font = opt.font || FONT;
    ctx.fillStyle = col;
    ctx.textAlign = opt.align || 'left';
    ctx.textBaseline = opt.base || 'alphabetic';
    ctx.fillText(s, x, y);
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function pill(ctx, s, x, y, C, o) {
    const opt = o || {};
    ctx.font = opt.font || FONT_B;
    const tw = ctx.measureText(s).width;
    const w = tw + 12, h = 18;
    const x0 = Math.max(4, Math.min(ctx.canvas.clientWidth - w - 4, opt.align === 'center' ? x - w / 2 : opt.align === 'right' ? x - w : x));
    roundRect(ctx, x0, y - h / 2, w, h, 9);
    ctx.fillStyle = alpha(C.panel, 0.92);
    ctx.fill();
    ctx.strokeStyle = opt.ring || C.border;
    ctx.lineWidth = opt.ring ? 1.5 : 1;
    ctx.stroke();
    text(ctx, s, x0 + 6, y + 0.5, opt.col || C.text, { font: opt.font || FONT_B, base: 'middle' });
    return { x: x0, w };
  }

  function kit(ctx, B, C, t, still) {
    const P2 = p => proj(B, p);
    const K = {
      ctx, B, C, t, still,
      p: name => pt(name),
      at: P2,
      // A run of signal along 3-D points: the way faint, and pulses of it
      // travelling. `col(u)` colours a pulse by how far along it is (0–1).
      flow(pts, col, o) {
        const opt = o || {};
        const sp = pts.map(P2);
        if (sp.some(p => !p)) return;
        ctx.beginPath();
        ctx.setLineDash(opt.dash || [4, 4]);
        ctx.moveTo(sp[0][0], sp[0][1]);
        for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i][0], sp[i][1]);
        ctx.strokeStyle = alpha(typeof col === 'function' ? col(0.5) : col, opt.base == null ? 0.45 : opt.base);
        ctx.lineWidth = opt.width || 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        const segs = [];
        let tot = 0;
        for (let i = 1; i < pts.length; i++) { const l = Math.hypot(...sub(pts[i], pts[i - 1])); segs.push(l); tot += l; }
        const n = opt.n || 6, speed = opt.speed || 40;
        for (let k = 0; k < n; k++) {
          let u = ((t * speed / tot) + k / n) % 1;
          if (opt.span && (u < opt.span[0] || u > opt.span[1])) continue;
          const uu = u;
          let dd = u * tot, i = 0;
          while (i < segs.length - 1 && dd > segs[i]) { dd -= segs[i]; i++; }
          const p = P2(lerp3(pts[i], pts[i + 1], Math.min(1, dd / segs[i])));
          if (!p) continue;
          const a = opt.fade ? opt.fade(uu) : 1;
          if (a <= 0.02) continue;
          ctx.beginPath();
          ctx.arc(p[0], p[1], opt.r || 3, 0, 2 * Math.PI);
          ctx.fillStyle = alpha(typeof col === 'function' ? col(uu) : col, a);
          ctx.fill();
        }
      },
      // Rings spreading from a point, flat, as a transmitter's signal goes
      // out in every direction.
      rings(c, col, o) {
        const opt = o || {};
        const R = opt.R || 18, n = opt.n || 3, v = opt.v || 9;
        for (let k = 0; k < n; k++) {
          const r = ((t * v) + k * R / n) % R;
          const a = (1 - r / R) * (opt.a || 0.8);
          if (r < 0.4 || a <= 0.02) continue;
          ctx.beginPath();
          let ok = false;
          for (let s = 0; s <= 40; s++) {
            const th = s / 40 * 2 * Math.PI;
            const p = P2([c[0] + r * Math.cos(th), c[1] + r * Math.sin(th), c[2]]);
            if (!p) continue;
            if (!ok) { ctx.moveTo(p[0], p[1]); ok = true; } else ctx.lineTo(p[0], p[1]);
          }
          ctx.strokeStyle = alpha(typeof col === 'function' ? col(r / R) : col, a);
          ctx.lineWidth = opt.width || 1.6;
          ctx.stroke();
        }
      },
      // The culprit: a ring pulsing on the ground under it, and its name.
      mark(p, label, o) {
        const opt = o || {};
        const g = [p[0], p[1], groundZ(p[0], p[1]) + 0.2];
        const pulse = still ? 0.5 : (t * 1.2) % 1;
        for (const k of [0, 0.5]) {
          const ph = (pulse + k) % 1, r = (opt.r || 3.2) * (0.6 + ph);
          ctx.beginPath();
          let ok = false;
          for (let s = 0; s <= 32; s++) {
            const th = s / 32 * 2 * Math.PI;
            const q = P2([g[0] + r * Math.cos(th), g[1] + r * Math.sin(th), g[2]]);
            if (!q) continue;
            if (!ok) { ctx.moveTo(q[0], q[1]); ok = true; } else ctx.lineTo(q[0], q[1]);
          }
          ctx.strokeStyle = alpha(C.bad, 0.9 * (1 - ph));
          ctx.lineWidth = 2.2;
          ctx.stroke();
        }
        const top = P2([p[0], p[1], p[2] + (opt.lift || 4)]);
        if (!top) return;
        const base = P2(p);
        if (base) { ctx.beginPath(); ctx.moveTo(base[0], base[1]); ctx.lineTo(top[0], top[1] + 8); ctx.strokeStyle = C.bad; ctx.lineWidth = 1.2; ctx.stroke(); }
        pill(ctx, label, top[0], top[1], C, { align: 'center', ring: C.bad });
      },
      // A flash at a point: a star of short rays.
      spark(p, col, size, k) {
        const q = P2(p);
        if (!q) return;
        const s = size || 9;
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        for (let i = 0; i < 8; i++) {
          const a = i / 8 * 2 * Math.PI + (k || 0);
          const r0 = s * 0.35, r1 = s * (i % 2 ? 0.75 : 1.15);
          ctx.beginPath();
          ctx.moveTo(q[0] + r0 * Math.cos(a), q[1] + r0 * Math.sin(a));
          ctx.lineTo(q[0] + r1 * Math.cos(a), q[1] + r1 * Math.sin(a));
          ctx.stroke();
        }
      },
      // Hiss: a flicker of dots around a point.
      hiss(p, r, col, n) {
        const q = P2(p);
        if (!q) return;
        const f = Math.floor(t * 14);
        for (let i = 0; i < (n || 40); i++) {
          const a = hn(i * 3.1 + f) * 2 * Math.PI, d = Math.sqrt(hn(i * 7.7 + f * 1.3)) * r;
          ctx.fillStyle = alpha(col, 0.35 + 0.5 * hn(i + f * 0.7));
          ctx.fillRect(q[0] + d * Math.cos(a), q[1] + d * Math.sin(a) * 0.8, 2, 2);
        }
      },
      // The path from the gauge to the repeater, and on to whatever else.
      direct: () => [pt('tx'), pt('rx')],
    };
    return K;
  }

  // ── The close-ups' kit ─────────────────────────────────────────────────────
  // Each close-up is drawn in a box {x, y, w, h}: its canvas, under its title.
  function wave(ctx, b, y0, A, f, ph, col, w, noise) {
    ctx.beginPath();
    for (let x = 0; x <= b.w; x += 1) {
      const y = y0 - A * Math.sin(2 * Math.PI * f * x / b.w + ph) + (noise ? noise(x) : 0);
      if (x) ctx.lineTo(b.x + x, y); else ctx.moveTo(b.x + x, y);
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = w || 1.5;
    ctx.stroke();
  }
  function hline(ctx, x0, x1, y, col, dash, w) {
    ctx.beginPath();
    ctx.setLineDash(dash || []);
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.strokeStyle = col;
    ctx.lineWidth = w || 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const hg = i => { const k = Math.floor(i / 3), f = i / 3 - k; const g = j => (hn(j) + hn(j + 0.37) + hn(j + 0.71) - 1.5) * 2; return g(k) * (1 - f) + g(k + 1) * f; };
  const fmt = (x, d = 0) => (Number.isFinite(x) ? Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const sgn = (x, d = 0) => (x > 0 ? '+' : x < 0 ? '−' : '±') + fmt(Math.abs(x), d);
  const hh = h => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

  // A row of bits, `bad(j)` marking the ones lost.
  function bitRow(ctx, b, y, bits, C, o) {
    const opt = o || {};
    const n = bits.length, cw = b.w / n, ch = opt.h || 16;
    for (let j = 0; j < n; j++) {
      const x = b.x + j * cw;
      const shown = opt.upto == null || j <= opt.upto;
      const bad = shown && opt.bad && opt.bad(j);
      ctx.fillStyle = bad ? C.bad : shown ? alpha(C.muted, 0.14) : alpha(C.muted, 0.05);
      ctx.fillRect(x + 1, y, cw - 2, ch);
      if (shown && cw >= 7) text(ctx, String(bits[j]), x + cw / 2, y + ch / 2 + 0.5, bad ? C.panel : C.text, { font: MONO, align: 'center', base: 'middle' });
    }
  }

  // Wires from a sensor's outputs to the logger's inputs, one for each bit of
  // the field the fault is set on (11 for a value, 13 for an address), by the
  // fault's rule: `to(i)` is the input output i lands on (−1 for none), and
  // `broken` the one wire that is not there. The reading rises a step at a
  // time, and what the logger makes of it is BitModel's dataPath — the same
  // sum the bench's batch runs.
  function wiring(ctx, b, C, t, id, p, o) {
    const M = BM();
    const f = M.FIELDS[p.field] || M.FIELDS.value, w = f.width;
    const base = p.field === 'address' ? 4000 : 600;
    const v = Math.min(f.max, base + Math.floor(t * 1.6) % 160);
    const s = M.dataPath(id, p, p.field === 'address' ? v : 4021, p.field === 'address' ? 1263 : v);
    const got = p.field === 'address' ? s.addr : s.value;
    const top = b.y + 2, rowH = (b.h - 30) / w;
    const lx = b.x + 2, lw = 50, rx = b.x + b.w - 52, rw = 50;
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(lx, top - 2, lw, w * rowH + 4);
    ctx.strokeRect(rx, top - 2, rw, w * rowH + 4);
    for (let i = w - 1; i >= 0; i--) {
      const yi = top + (w - 1 - i) * rowH + rowH / 2;
      const bi = (v >> i) & 1, gi = (got >> i) & 1;
      text(ctx, `${i}`, lx + 5, yi + 0.5, C.muted, { font: MONO, base: 'middle' });
      text(ctx, `${bi}`, lx + lw - 7, yi + 0.5, C.text, { font: MONO, base: 'middle', align: 'right' });
      text(ctx, `${gi}`, rx + 7, yi + 0.5, gi !== bi ? C.bad : C.text, { font: MONO, base: 'middle' });
      text(ctx, `${i}`, rx + rw - 5, yi + 0.5, C.muted, { font: MONO, base: 'middle', align: 'right' });
      const j = o.to(i, w);
      const x0 = lx + lw, x1 = rx;
      if (j < 0 || j >= w) continue;
      const yj = top + (w - 1 - j) * rowH + rowH / 2;
      ctx.beginPath();
      if (o.broken === i) {
        const xm = (x0 + x1) / 2;
        ctx.moveTo(x0, yi); ctx.lineTo(xm - 6, yi);
        ctx.moveTo(xm + 6, yj); ctx.lineTo(x1, yj);
        ctx.strokeStyle = C.bad;
        ctx.lineWidth = 2;
        ctx.stroke();
        text(ctx, '✕', xm, yi + 0.5, C.bad, { font: FONT_T, align: 'center', base: 'middle' });
        continue;
      }
      ctx.moveTo(x0, yi);
      ctx.bezierCurveTo((x0 + x1) / 2, yi, (x0 + x1) / 2, yj, x1, yj);
      ctx.strokeStyle = j !== i || o.mark ? C.warn : C.muted;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      if (o.mark) {
        const xm = (x0 + x1) / 2, ym = (yi + yj) / 2;
        ctx.beginPath(); ctx.arc(xm, ym, 3, 0, 2 * Math.PI); ctx.fillStyle = C.panel; ctx.fill(); ctx.strokeStyle = C.warn; ctx.stroke();
      }
    }
    const yb = top + w * rowH + 14;
    text(ctx, 'Sensor', lx + lw / 2, yb, C.muted, { font: FONT_B, align: 'center' });
    text(ctx, 'Logger', rx + rw / 2, yb, C.muted, { font: FONT_B, align: 'center' });
    const mid = (lx + lw + rx) / 2, my = top + w * rowH / 2;
    roundRect(ctx, mid - 42, my - 20, 84, 38, 6);
    ctx.fillStyle = alpha(C.panel, 0.94); ctx.fill(); ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
    text(ctx, `${fmt(v)} sent`, mid, my - 4, C.text, { font: FONT_B, align: 'center' });
    text(ctx, `${fmt(got)} read`, mid, my + 11, got !== v ? C.bad : C.ok, { font: FONT_B, align: 'center' });
    text(ctx, `the ${p.field === 'address' ? 'address\'s 13' : 'value\'s 11'} wires`, mid, yb, C.muted, { align: 'center' });
  }

  // ── The fourteen places ────────────────────────────────────────────────────
  // For each fault: where it happens (a sentence for the card), the short tag
  // the drawing wears, what moves in the scene, and the close-up. Both are
  // drawn from the fault's settings as the bench has them (K.prm in the
  // scene, `p` in the close-up), so moving a slider moves the picture. `still`
  // is the moment a still picture shows — one where the fault is plain to see.
  const T_BIT = () => BM().bitMs();
  const keying = () => (typeof PropPhysics !== 'undefined' ? PropPhysics : { LEAD_MS: 33.3, KEYING_MS: 200, CAPTURE_DB: 6 });
  const seeded = n => (typeof PropPhysics !== 'undefined' ? PropPhysics.rng(n) : Math.random);
  const SAMPLE = () => BM().air(4021, 1263);     // the frame the close-ups send
  const oneIn = e => (e <= 0 ? 'never' : e >= 0.5 ? 'half the time' : `1 in ${fmt(Math.round(1 / e))}`);

  const SPOTS = {
    noise: {
      tag: 'too far, and grazing the hill',
      where: 'The repeater is a long way off and the hill between grazes the path, so the gauge\'s signal reaches it only just above '
        + 'the hiss every receiver hears. A few decibels less and bits start to go.',
      close: 'At the repeater: the signal in the hiss',
      still: 1.1,
      scene(K) {
        const a = K.p('tx'), b = K.p('rx'), snr = K.prm.snr;
        const lose = Math.max(0, Math.min(1, (16 - snr) / 14));
        K.rings(a, K.C.wave, { R: 14 });
        K.flow([a, b], K.C.wave, { n: 8, fade: u => 1 - 0.85 * lose * u, r: 3 });
        K.hiss(b, 18 + 14 * lose, K.C.muted, Math.round(12 + 110 * lose));
        K.mark(b, snr >= 14 ? 'Strong enough at the repeater' : 'Weak at the repeater', { lift: 6 });
      },
      inset(ctx, b, C, t, p) {
        const snr = p.snr, ber = BM().ber(snr);
        const A = Math.min(20, b.h * 0.13), y0 = b.y + A + 6;
        // The hiss's spread, and the tones riding over it.
        const n = Math.min(A * 1.3, A * Math.sqrt(1 / (2 * Math.pow(10, snr / 10))) * 2.2);
        ctx.fillStyle = alpha(C.muted, 0.2);
        ctx.fillRect(b.x, y0 - n, b.w, 2 * n);
        wave(ctx, b, y0, A, 7, t * 8, alpha(C.wave, 0.35), 1);
        wave(ctx, b, y0, A, 7, t * 8, C.wave, 1.6, x => n * 0.9 * hg(x * 0.9 + Math.floor(t * 20) * 13));
        text(ctx, 'faint: the tones as sent · grey: the receiver\'s own hiss', b.x, y0 + A + 16, C.muted);
        // The cliff: bits misread against decibels over the hiss, 0 to 24.
        const gx = b.x + 2, gw = b.w - 4, gy = y0 + A + 44, gh = b.h - (gy - b.y) - 22;
        if (gh > 30) {
          const X = db => gx + db / 24 * gw, Y = db => gy + Math.min(1, -Math.log10(Math.max(1e-9, BM().ber(db))) / 7) * gh;
          hline(ctx, gx, gx + gw, gy + gh, C.border);
          ctx.beginPath();
          for (let db = 0; db <= 24.01; db += 0.25) { if (db > 0) ctx.lineTo(X(db), Y(db)); else ctx.moveTo(X(db), Y(db)); }
          ctx.strokeStyle = C.text; ctx.lineWidth = 1.4; ctx.stroke();
          ctx.beginPath(); ctx.arc(X(snr), Y(snr), 4, 0, 2 * Math.PI); ctx.fillStyle = C.bad; ctx.fill();
          text(ctx, 'bits misread, from 0 to 24 dB: a cliff, not a slope', gx, gy - 6, C.muted);
          const right = X(snr) > gx + gw - 40;
          text(ctx, 'here', X(snr) + (right ? -8 : 8), Y(snr) + (right ? -6 : 4), C.bad, { font: FONT_B, align: right ? 'right' : 'left' });
        }
        text(ctx, `${fmt(snr, 1)} dB over the hiss: a bit misread ${oneIn(ber)}`, b.x, b.y + b.h - 2, C.text, { font: FONT_B });
      },
    },

    impulse: {
      tag: 'lightning and an electric fence',
      where: 'A storm\'s lightning, the electric fence ticking beside the repeater\'s hill, a car\'s ignition: short, loud bursts of '
        + 'noise at the receiver that wipe out the few bits they land on, while the bits either side come through clean.',
      close: p => `Bursts of ${fmt(p.width, 1)} ms, ${fmt(p.rate, 1)} a second${p.regular ? ', evenly' : ''}`,
      still: 0.08,
      scene(K, t) {
        const a = K.p('tx'), b = K.p('rx'), { ctx, C } = K, p = K.prm;
        K.flow([a, b], C.wave, { n: 7 });
        // A burst: `rate` a second (shown at no more than six), evenly for a
        // fence, at random for a storm.
        const r = Math.min(6, p.rate), slot = Math.floor(t * r), within = t * r - slot;
        const at = p.regular ? 0 : hn(slot * 1.7) * 0.7;
        const burst = within >= at && within < at + Math.min(0.5, 0.18 * r);
        // The storm: a cloud, and the bolt when a burst comes from it.
        const cl = PLACE.cloud;
        const bolt = burst && !p.regular;
        for (const [dx, dy, rr] of [[-7, 0, 5], [0, 1, 6.5], [7, 0, 5], [3, -2, 4.5], [-3, -2, 4.5]]) {
          const q = K.at([cl.x + dx, cl.y + dy, cl.z]), e = K.at([cl.x + dx + rr, cl.y + dy, cl.z]);
          if (!q || !e) continue;
          ctx.beginPath(); ctx.arc(q[0], q[1], Math.abs(e[0] - q[0]), 0, 2 * Math.PI);
          ctx.fillStyle = bolt ? alpha(C.panel, 0.95) : alpha(C.muted, p.regular ? 0.25 : 0.55); ctx.fill();
        }
        if (bolt) {
          const s = K.p('strike');
          const pts = [];
          for (let k = 0; k <= 7; k++) pts.push(K.at([cl.x + (s[0] - cl.x) * k / 7 + (k % 2 ? 1.6 : -1.2), cl.y + (s[1] - cl.y) * k / 7, cl.z + (s[2] - cl.z) * k / 7]));
          if (pts.every(Boolean)) {
            ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
            for (const q of pts.slice(1)) ctx.lineTo(q[0], q[1]);
            ctx.strokeStyle = C.warn; ctx.lineWidth = 3; ctx.stroke();
          }
          K.rings(s, C.warn, { R: 40, n: 2, v: 60, a: 0.9 });
        }
        const f = K.p('fence');
        if (burst && p.regular) { K.spark(f, C.warn, 10, t); K.rings(f, C.warn, { R: 22, n: 1, v: 120 }); }
        if (burst) K.spark(b, C.bad, 12);
        if (p.regular) K.mark(f, 'Fence ticking', { lift: 5 });
        else K.mark(K.p('strike'), 'Lightning', { lift: 4 });
      },
      inset(ctx, b, C, t, p) {
        // One frame every 2.5 s through BitModel's own channel: where its
        // bursts land, and what they did.
        const per = 2.5, k = Math.floor(t / per);
        const tx = SAMPLE();
        const ch = BM().channel('impulse', p, tx, seeded(k * 7919 + 17), { trace: true });
        const hits = (ch.trace && ch.trace.hits) || [];
        const T = T_BIT(), dur = 40 * T;
        const upto = Math.floor(((t % per) / per) * 48);
        const X = ms => b.x + ms / dur * b.w;
        const y0 = b.y + 30;
        text(ctx, 'the noise at the receiver, through one frame', b.x, b.y + 8, C.muted);
        ctx.beginPath();
        for (let x = 0; x <= b.w; x++) {
          const ms = x / b.w * dur;
          const inHit = ms / T <= upto && hits.some(([s, e]) => ms >= s && ms <= e);
          const y = y0 - 2 * hg(x * 2) - (inHit ? 13 * Math.abs(Math.sin(x * 1.7)) * (hn(x * 0.37) > 0.4 ? 1 : -0.6) : 0);
          if (x) ctx.lineTo(b.x + x, y); else ctx.moveTo(b.x + x, y);
        }
        ctx.strokeStyle = C.warn; ctx.lineWidth = 1.2; ctx.stroke();
        for (const [s, e] of hits) {
          if (s / T > upto) continue;
          ctx.fillStyle = alpha(C.warn, 0.14);
          ctx.fillRect(X(Math.max(0, s)), y0 - 16, Math.max(2, X(Math.min(dur, e)) - X(Math.max(0, s))), 92);
        }
        const flips = new Set();
        if (ch.rx) for (let j = 0; j < 40; j++) if (ch.rx[j] !== tx[j]) flips.add(j);
        text(ctx, 'sent', b.x, b.y + 56, C.muted);
        bitRow(ctx, b, b.y + 61, Array.from(tx), C, { upto });
        text(ctx, 'heard', b.x, b.y + 92, C.muted);
        bitRow(ctx, b, b.y + 97, Array.from(ch.rx || tx), C, { upto, bad: j => flips.has(j) });
        const done = upto >= 40;
        const hit = hits.filter(([s, e]) => e > 0 && s < dur).length;
        text(ctx, `${fmt(p.width / T + 1, 1)} bits a burst. ${done ? (hit ? `This frame: ${hit} burst${hit > 1 ? 's' : ''}, ${flips.size} bit${flips.size === 1 ? '' : 's'} flipped.` : 'This frame: no burst — untouched.') : 'Sending…'}`,
          b.x, b.y + b.h - 2, done && flips.size ? C.bad : C.text, { font: FONT_B });
      },
    },

    multipath: {
      tag: 'off the shed and a passing truck',
      where: 'The signal reaches the repeater twice — straight, and bounced off the shed and the truck going past on the road. The '
        + 'copies add or cancel; the shed holds still, but as the truck moves the signal fades in and out.',
      close: 'Two copies adding up — or cancelling',
      still: 2.3,
      // Where the two copies stand, radians apart, at time t: swept by the
      // truck at `rate` fades a second, or held at `place` when nothing moves.
      phase: (t, p) => (p.rate > 0 ? 2 * Math.PI * p.rate * t : p.place * Math.PI / 180),
      truck: (t, p) => (p.rate > 0 ? 1 + ((t * 3 * Math.min(p.rate, 5)) % 114) : 40),
      scene(K, t) {
        const { ctx, C } = K, p = K.prm;
        const a = K.p('tx'), b = K.p('rx'), e = K.p('echo');
        const x = SPOTS.multipath.truck(t, p), y = ROAD_Y - 1.9;
        const tr = up(x + 2, ROAD_Y - 0.9, 2.4);
        K.flow([a, b], C.wave, { n: 6 });
        if (p.echo > 0) {
          K.flow([a, e, b], C.echo, { n: 6, speed: 36, base: 0.2 + 0.4 * p.echo });
          if (p.rate > 0) K.flow([a, tr, b], C.echo, { n: 5, speed: 34, dash: [2, 5], base: 0.3 * p.echo });
        }
        // The truck itself, on the road: moving, or parked when nothing is.
        const cs = [[x, y], [x + 4.2, y], [x + 4.2, y + 2], [x, y + 2]];
        const g = groundZ(x + 2, ROAD_Y) + 0.2;
        const lo = cs.map(([u, v]) => K.at([u, v, g])), hi = cs.map(([u, v]) => K.at([u, v, g + 2.3]));
        if (lo.every(Boolean) && hi.every(Boolean)) {
          ctx.fillStyle = shade(rgb(C.echo), 0.95);
          ctx.beginPath(); ctx.moveTo(lo[0][0], lo[0][1]); ctx.lineTo(lo[1][0], lo[1][1]); ctx.lineTo(hi[1][0], hi[1][1]); ctx.lineTo(hi[0][0], hi[0][1]); ctx.closePath(); ctx.fill();
          ctx.fillStyle = shade(rgb(C.echo), 1.2);
          ctx.beginPath(); hi.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 0.8; ctx.stroke();
        }
        // The repeater's signal meter: the sum of the two.
        const amp = BM().fadeAmp(p.echo, SPOTS.multipath.phase(t, p));
        const q = K.at(b);
        if (q) {
          const H = 34, v = Math.min(1, amp / 2);
          ctx.fillStyle = alpha(C.panel, 0.9); ctx.fillRect(q[0] + 14, q[1] - 6, 10, H + 2);
          ctx.fillStyle = v < 0.3 ? C.bad : C.ok; ctx.fillRect(q[0] + 15, q[1] - 5 + H * (1 - v), 8, H * v);
          ctx.strokeStyle = C.border; ctx.strokeRect(q[0] + 14, q[1] - 6, 10, H + 2);
        }
        K.mark(e, p.echo > 0 ? 'Echo off the shed' : 'No echo', { lift: 4 });
      },
      inset(ctx, b, C, t, p) {
        const ph = SPOTS.multipath.phase(t, p);
        const rho = p.echo;
        const A = Math.min(13, b.h * 0.09), y1 = b.y + A + 4, y2 = y1 + 2.6 * A + 4, y3 = y2 + 3.6 * A + 4;
        wave(ctx, b, y1, A, 5, t * 6, C.wave, 1.3);
        wave(ctx, b, y2, A * rho, 5, t * 6 + ph, C.echo, 1.3);
        const amp = BM().fadeAmp(rho, ph);
        const sumPh = Math.atan2(rho * Math.sin(ph), 1 + rho * Math.cos(ph));
        wave(ctx, b, y3, A * amp, 5, t * 6 + sumPh, C.sum, 2.2);
        text(ctx, 'straight', b.x, y1 - A - 2, C.wave, { font: FONT_B });
        text(ctx, p.rate > 0 ? 'off the truck' : 'off the shed', b.x, y2 - A - 2, C.echo, { font: FONT_B });
        text(ctx, 'what the repeater gets', b.x, y3 - 2 * A - 2, C.sum, { font: FONT_B });
        const db = 20 * Math.log10(Math.max(1e-3, amp));
        const fade = Math.cos(ph) < -0.4 && rho > 0.3;
        text(ctx, p.rate > 0 ? `${fmt(p.rate, 2)} fades a second — now ${sgn(db, 1)} dB` : `Still at ${fmt(p.place)}°: ${sgn(db, 1)} dB, for good`,
          b.x, b.y + b.h - 2, fade ? C.bad : C.text, { font: FONT_B });
      },
    },

    collision: {
      tag: 'another gauge keys up at once',
      where: 'Another gauge across the valley keys up while ours is still sending. Nobody listens before they talk on an ALERT '
        + 'network, so now and then two frames land on the repeater together, and where they disagree the bits flip.',
      close: p => `Two keyings at once: ours ${p.sir >= 0 ? `${fmt(p.sir, 1)} dB stronger` : `${fmt(-p.sir, 1)} dB weaker`}`,
      still: 0.95,
      scene(K, t) {
        const { C } = K, p = K.prm, cap = keying().CAPTURE_DB;
        const a = K.p('tx'), b = K.p('rx'), c = K.p('tx2');
        const ph = t % 3.2;
        const lost = p.sir <= -cap;
        K.rings(a, C.wave, { R: 14 });
        K.flow([a, b], lost ? C.muted : C.wave, { n: 7 });
        if (ph > 0.6) { K.rings(c, C.echo, { R: 14 }); K.flow([c, b], C.echo, { n: 7, speed: 44 }); }
        if (p.sir < cap && ph > 1.0 && ph < 2.9 && Math.floor(t * 6) % 2) K.spark(b, C.bad, 13, t);
        K.mark(c, p.copy ? 'A second repeater, same reading' : 'The other gauge', { lift: 5 });
      },
      inset(ctx, b, C, t, p) {
        const P = keying(), T = T_BIT(), ours = 40 * T, cap = P.CAPTURE_DB;
        const start = p.copy ? -P.LEAD_MS : p.start, len = P.KEYING_MS;
        const lo = Math.min(0, start) - 8, hi = Math.max(ours, start + len) + 8;
        const X = ms => b.x + (ms - lo) / (hi - lo) * b.w;
        const per = 3.2, k = Math.floor(t / per), ph = (t % per) / per;
        const row = (y, s, e, col, name) => {
          ctx.fillStyle = col; ctx.fillRect(X(s), y, X(e) - X(s), 16);
          ctx.save(); ctx.beginPath(); ctx.rect(X(s), y, X(e) - X(s), 16); ctx.clip();
          text(ctx, name, X(s) + 4, y + 8.5, C.panel, { font: FONT_B, base: 'middle' });
          ctx.restore();
        };
        row(b.y + 6, 0, ours, C.wave, `Ours — ${fmt(ours)} ms`);
        row(b.y + 28, start, start + len, C.echo, p.copy ? 'The same reading, relayed' : 'Theirs');
        const o0 = Math.max(0, start), o1 = Math.min(ours, start + len);
        if (o1 > o0) { ctx.fillStyle = alpha(C.bad, 0.22); ctx.fillRect(X(o0), b.y + 2, X(o1) - X(o0), 48); }
        ctx.fillStyle = C.text; ctx.fillRect(b.x + ph * b.w - 1, b.y + 2, 2, 48);
        // Our frame through BitModel's own collision, a new one each pass.
        const tx = SAMPLE();
        const ch = BM().channel('collision', p, tx, seeded(k * 104729 + 3), { trace: true });
        const upto = Math.floor(((ph * (hi - lo) + lo) / ours) * 40);
        const why = o1 <= o0 ? 'No overlap: the two never meet.'
          : p.sir >= cap ? `Ours ${fmt(p.sir, 1)} dB ahead: FM hears ours cleanly (capture).`
          : p.sir <= -cap ? `Theirs ${fmt(-p.sir, 1)} dB ahead: the receiver locks on to it, and ours is lost.`
          : `Within ${fmt(cap)} dB of each other: bits flip where the two differ.`;
        text(ctx, why, b.x, b.y + 66, o1 > o0 && p.sir < cap ? C.bad : C.text, { font: FONT_B });
        text(ctx, 'ours, as heard', b.x, b.y + 84, C.muted);
        if (ch.rx) bitRow(ctx, b, b.y + 90, Array.from(ch.rx), C, { upto, bad: j => ch.rx[j] !== tx[j] });
        else text(ctx, upto >= 0 ? 'nothing — captured by theirs' : '', b.x, b.y + 102, C.bad, { font: FONT_B });
        text(ctx, start < 0 ? `They key up ${fmt(-start)} ms before our first bit.` : `They key up ${fmt(start)} ms after our first bit.`,
          b.x, b.y + b.h - 2, C.muted);
      },
    },

    intermod: {
      tag: 'a pager mast and a phone tower',
      where: 'A pager mast and a phone tower stand beside the repeater. Their strong signals mix in its overloaded front end — or in a '
        + 'corroded joint on its mast — and one of the products, 2f₁ − f₂, lands on our channel whenever both are on the air.',
      close: 'Two frequencies in, a third out',
      still: 0.5,
      inBand: p => Math.abs(BM().nearestProduct(p.f1, p.f2).offsetHz) <= BM().IF_HALF_HZ,
      on: (t, p) => ((t % 2) / 2) < p.duty,
      scene(K, t) {
        const { C } = K, p = K.prm;
        const a = K.p('tx'), b = K.p('rx'), p1 = K.p('pager'), p2 = K.p('phone');
        const on = SPOTS.intermod.on(t, p), hit = on && SPOTS.intermod.inBand(p);
        K.flow([a, b], C.wave, { n: 6, base: 0.3 });
        K.rings(p1, C.sum, { R: 22, v: 14 });
        if (on) {
          K.rings(p2, C.ok, { R: 22, v: 14 });
          K.flow([p1, b], C.sum, { n: 4, speed: 30, dash: [2, 3] });
          K.flow([p2, b], C.ok, { n: 4, speed: 30, dash: [2, 3] });
        }
        if (hit) { K.spark(b, C.bad, 10, t * 3); K.rings(b, C.bad, { R: 9, n: 2, v: 10 }); }
        K.mark(b, hit ? 'Mixing at the repeater' : SPOTS.intermod.inBand(p) ? 'Waiting for both to key up' : 'Products miss our channel', { lift: 6 });
        const q1 = K.at(p1), q2 = K.at(p2);
        if (q1) pill(K.ctx, `Pager f₁ ${fmt(p.f1, 3)}`, q1[0], q1[1] - 14, C, { align: 'center' });
        if (q2) pill(K.ctx, `Phone f₂ ${fmt(p.f2, 3)}`, q2[0], q2[1] - 14, C, { align: 'center' });
      },
      inset(ctx, b, C, t, p) {
        const pr = BM().imProducts(p.f1, p.f2);
        const fs = [151.5, p.f1, p.f2, ...pr.map(x => x.mhz)];
        const span = Math.max(1.2, Math.max(...fs) - Math.min(...fs));
        const lo = Math.min(...fs) - span * 0.12, hi = Math.max(...fs) + span * 0.12;
        const X = f => b.x + (f - lo) / (hi - lo) * b.w;
        const yb = b.y + b.h - 30;
        hline(ctx, b.x, b.x + b.w, yb, C.muted);
        const step = [0.25, 0.5, 1, 2, 5, 10].find(s => (hi - lo) / s <= 6) || 10;
        for (let f = Math.ceil(lo / step) * step; f <= hi; f += step) {
          ctx.fillStyle = C.muted; ctx.fillRect(X(f), yb, 1, 4);
          text(ctx, f.toFixed(step < 1 ? 2 : 0), X(f), yb + 14, C.muted, { align: 'center' });
        }
        const bar = (f, h, col, name, w) => {
          ctx.fillStyle = col; ctx.fillRect(X(f) - (w || 2) / 2, yb - h, w || 2, h);
          if (name) text(ctx, name, X(f), yb - h - 4, col, { align: 'center', font: FONT_B });
        };
        // Our channel, and the receiver's filter around it (drawn wider than it
        // is, or it would be a hair at this scale).
        ctx.fillStyle = alpha(C.wave, 0.18);
        ctx.fillRect(X(151.5) - 3, b.y + 12, 6, yb - b.y - 12);
        text(ctx, 'our channel', X(151.5) + 6, b.y + 20, C.wave, { font: FONT_B });
        bar(151.5, 40, C.wave, '', 3);
        bar(p.f1, 62, C.sum, 'f₁');
        bar(p.f2, 62, C.ok, 'f₂');
        const on = SPOTS.intermod.on(t, p);
        for (const x of pr) {
          const h = on ? 30 : 8;
          bar(x.mhz, h, on ? C.bad : alpha(C.bad, 0.4), '');
          const edge = X(x.mhz) > b.x + b.w - 44;
          text(ctx, x.key === '2f1-f2' ? '2f₁−f₂' : '2f₂−f₁', X(x.mhz) + (edge ? -5 : 5), yb - h - 4, C.bad, { font: FONT_B, align: edge ? 'right' : 'left' });
        }
        const near = BM().nearestProduct(p.f1, p.f2), inside = Math.abs(near.offsetHz) <= BM().IF_HALF_HZ;
        const off = near.offsetHz / 1000;
        text(ctx, `${near.key === '2f1-f2' ? '2f₁ − f₂' : '2f₂ − f₁'} is ${sgn(off, 1)} kHz from ours: ${inside ? `inside the filter, ${on ? 'on now' : 'off'} (${fmt(p.duty * 100)}% of the time)` : 'outside the filter — no harm'}`,
          b.x, b.y + b.h - 2, inside ? C.bad : C.ok, { font: FONT_B });
      },
    },

    crystal: {
      tag: 'the sun on the gauge\'s hut',
      where: 'The gauge\'s hut bakes in the afternoon sun and chills before dawn, and its radio\'s crystal moves with it. A few parts '
        + 'per million off, and the carrier slides out of the repeater\'s filter — at one end of the day, and only for this transmitter.',
      close: 'The carrier in the repeater\'s filter, through a day',
      still: 3.75,
      hour: t => (6 + t * 2.4) % 24,
      sky(K, t) {
        const { ctx } = K;
        const h = SPOTS.crystal.hour(t);
        const day = Math.sin(Math.PI * (h - 6) / 12);
        const w = ctx.canvas.clientWidth, H = ctx.canvas.clientHeight;
        if (day < 0.15) { ctx.fillStyle = `rgba(8,18,40,${Math.min(0.45, (0.15 - day) * 0.6)})`; ctx.fillRect(0, 0, w, H); }
        if (day > -0.1) {
          const x = w * (0.08 + 0.84 * ((h - 6) / 12)), y = 30 + (1 - Math.max(0, day)) * 70;
          ctx.beginPath(); ctx.arc(x, y, 11, 0, 2 * Math.PI); ctx.fillStyle = '#f6b81a'; ctx.fill();
          ctx.strokeStyle = 'rgba(246,184,26,.6)'; ctx.lineWidth = 2;
          for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; ctx.beginPath(); ctx.moveTo(x + 14 * Math.cos(a), y + 14 * Math.sin(a)); ctx.lineTo(x + 19 * Math.cos(a), y + 19 * Math.sin(a)); ctx.stroke(); }
        }
      },
      scene(K, t) {
        const { ctx, C } = K, d = K.prm;
        const h = SPOTS.crystal.hour(t);
        const off = BM().crystalHz(d, h);
        const out = BM().edgePenaltyDb(off, d.wide) > 0;
        const a = K.p('tx'), b = K.p('rx');
        K.rings(a, out ? C.bad : C.wave, { R: 14 });
        K.flow([a, b], out ? C.bad : C.wave, { n: 7, fade: u => (out ? 1 - 0.85 * u : 1) });
        // A thermometer beside the hut.
        const T = BM().dayTemp(h, d.tmin, d.tmax);
        const q = K.at(K.p('hut'));
        if (q) {
          const x = Math.max(62, q[0] - 46), y = q[1] - 22, H = 30, v = Math.max(0, Math.min(1, (T + 10) / 60));
          roundRect(ctx, x - 4, y - 4, 8, H + 8, 4); ctx.fillStyle = alpha(C.panel, 0.95); ctx.fill(); ctx.strokeStyle = C.border; ctx.stroke();
          ctx.fillStyle = T > 30 ? C.bad : C.wave; ctx.fillRect(x - 2, y + H * (1 - v), 4, H * v);
          ctx.beginPath(); ctx.arc(x, y + H + 4, 5, 0, 2 * Math.PI); ctx.fill();
          pill(ctx, `${fmt(T)} °C`, x - 9, y + H / 2, C, { align: 'right', col: T > 30 ? C.bad : C.text });
        }
        K.mark(K.p('hut'), 'Crystal in the radio', { lift: 4 });
      },
      inset(ctx, b, C, t, d) {
        const M = BM();
        const h = SPOTS.crystal.hour(t);
        const off = M.crystalHz(d, h);
        const half = d.wide ? M.WIDE_HALF_HZ : M.IF_HALF_HZ, dev = d.wide ? 2 * M.DEV_HZ : M.DEV_HZ;
        const span = Math.max(half + dev + 1500, Math.abs(off) + dev + 800);
        const X = hz => b.x + b.w / 2 + Math.max(-1, Math.min(1, hz / span)) * b.w / 2;
        const yb = b.y + b.h - 66;
        // The filter: flat across its width, falling away outside it.
        ctx.beginPath();
        ctx.moveTo(X(-span), yb); ctx.lineTo(X(-half - 900), yb); ctx.lineTo(X(-half), b.y + 14); ctx.lineTo(X(half), b.y + 14);
        ctx.lineTo(X(half + 900), yb); ctx.lineTo(X(span), yb);
        ctx.fillStyle = alpha(C.wave, 0.14); ctx.fill(); ctx.strokeStyle = alpha(C.wave, 0.6); ctx.lineWidth = 1; ctx.stroke();
        text(ctx, `the repeater's filter, ±${fmt(half / 1000)} kHz`, X(0), b.y + 10, C.muted, { align: 'center' });
        const out = M.edgePenaltyDb(off, d.wide) > 0;
        ctx.fillStyle = alpha(out ? C.bad : C.ok, 0.85);
        ctx.fillRect(X(off - dev), yb - 26, X(off + dev) - X(off - dev), 8);
        ctx.fillRect(X(off) - 1, yb - 36, 2, 36);
        text(ctx, 'our swing', X(off), yb - 40, out ? C.bad : C.ok, { align: 'center', font: FONT_B });
        hline(ctx, b.x, b.x + b.w, yb, C.muted);
        const T = M.dayTemp(h, d.tmin, d.tmax);
        text(ctx, `${hh(h)} · ${fmt(T)} °C · ${sgn(off / M.hzPerPpm(), 1)} ppm = ${sgn(off / 1000, 2)} kHz`, b.x, yb + 14, C.text, { font: FONT_B });
        // The day as a strip: the hours this crystal is past the edge, the
        // hour now, and the hour set on the bench for a single frame.
        const sy = yb + 24, cw = b.w / 24;
        for (let k = 0; k < 24; k++) {
          const bad = M.edgePenaltyDb(M.crystalHz(d, k), d.wide) > 0;
          ctx.fillStyle = bad ? alpha(C.bad, 0.75) : alpha(C.ok, 0.3);
          ctx.fillRect(b.x + k * cw + 0.5, sy, cw - 1, 10);
        }
        ctx.fillStyle = C.text; ctx.fillRect(b.x + (h / 24) * b.w - 1, sy - 3, 2, 16);
        ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.strokeRect(b.x + d.hour * cw + 0.5, sy - 1, cw - 1, 12);
        text(ctx, '00', b.x, sy + 22, C.muted); text(ctx, '12', b.x + b.w / 2, sy + 22, C.muted, { align: 'center' }); text(ctx, '24', b.x + b.w, sy + 22, C.muted, { align: 'right' });
        text(ctx, out ? 'Past the edge now: the signal suffers.' : 'Inside the filter now: no harm.', b.x, b.y + b.h + 4, out ? C.bad : C.muted, { font: FONT_B });
      },
    },

    pll: {
      tag: 'the gauge\'s radio, keying up',
      where: 'Each time the gauge\'s radio keys up, its synthesiser needs a moment to lock on frequency. If the logger starts the data '
        + 'too soon, the first bits go out off frequency, and the repeater misreads them.',
      close: 'The carrier settling after key-up',
      still: 0.35,
      // When the loop is in the filter's reach for good, ms after key-up.
      settle(p) {
        const edge = BM().IF_HALF_HZ - BM().DEV_HZ;
        let last = 0;
        for (let ms = 0; ms <= 1500; ms += 0.5) if (Math.abs(BM().pllHz(ms, p)) > edge) last = ms;
        return last;
      },
      scene(K, t) {
        const { C } = K, p = K.prm;
        const a = K.p('tx'), b = K.p('rx');
        const off = Math.max(0, SPOTS.pll.settle(p) - p.lead) / (40 * T_BIT());
        const ph = t % 2.4;
        if (ph < 2.1) {
          K.rings(a, r => (r < Math.min(0.9, off * 1.5) ? C.bad : C.wave), { R: 16, v: 12 });
          K.flow([a, b], u => (u > 1 - Math.min(1, off) ? C.bad : C.wave), { n: 8, speed: 46, span: [0, Math.min(1, ph / 1.2)] });
        }
        K.mark(a, off > 0 ? 'Synthesiser still locking' : 'Locked before the data', { lift: 3 });
      },
      inset(ctx, b, C, t, p) {
        const M = BM();
        const edge = M.IF_HALF_HZ - M.DEV_HZ;
        const settle = SPOTS.pll.settle(p);
        const tMax = Math.min(600, Math.max(70, p.lead + 40 * T_BIT() * 0.4, settle * 1.5));
        const X = ms => b.x + ms / tMax * b.w;
        const y0 = b.y + (b.h - 30) / 2 + 10, kH = (b.h - 52) / 2;
        const Y = hz => y0 - hz / (p.kick * 1000) * kH;
        ctx.fillStyle = alpha(C.ok, 0.13);
        ctx.fillRect(b.x, Y(edge), b.w, Y(-edge) - Y(edge));
        text(ctx, 'in the filter\'s reach', b.x + b.w - 2, Y(-edge) + 12, C.ok, { align: 'right' });
        hline(ctx, b.x, b.x + b.w, y0, C.border);
        const cur = ((t % 2.4) / 1.8) * tMax;
        ctx.beginPath();
        for (let x = 0; x <= b.w; x++) {
          const ms = x / b.w * tMax;
          if (ms > cur) break;
          const hz = M.pllHz(ms, p);
          if (x) ctx.lineTo(b.x + x, Y(hz)); else ctx.moveTo(b.x + x, Y(hz));
        }
        ctx.strokeStyle = C.text; ctx.lineWidth = 1.6; ctx.stroke();
        if (settle > p.lead) { ctx.fillStyle = alpha(C.bad, 0.25); ctx.fillRect(X(p.lead), b.y + 8, X(Math.min(tMax, settle)) - X(p.lead), b.h - 46); }
        ctx.fillStyle = C.wave; ctx.fillRect(X(p.lead) - 1, b.y + 8, 2, b.h - 46);
        text(ctx, `data starts, ${fmt(p.lead)} ms`, Math.min(X(p.lead) + 4, b.x + b.w - 110), b.y + 16, C.wave, { font: FONT_B });
        const nBits = Math.min(40, Math.ceil((settle - p.lead) / T_BIT()));
        text(ctx, settle > p.lead ? `Locked by ${fmt(settle)} ms: the first ${fmt(nBits)} bit${nBits > 1 ? 's go' : ' goes'} out off frequency.`
          : `Locked by ${fmt(settle)} ms, before the data: no harm.`, b.x, b.y + b.h - 2, settle > p.lead ? C.bad : C.ok, { font: FONT_B });
      },
    },

    clock: {
      tag: 'the logger\'s clock, in the hut',
      where: 'The logger in the gauge\'s hut sends each bit by its own clock, and the repeater reads them by its own. A clock a few '
        + 'per cent fast or slow slides each reading further from the middle of its bit, and the last bits of each word go first.',
      close: p => (p.uart ? 'Where the receiver reads each bit of a word' : 'Where the receiver reads the last word of the frame'),
      still: 2.4,
      scene(K, t) {
        const { ctx, C } = K, p = K.prm;
        const a = K.p('tx'), b = K.p('rx');
        K.flow([a, b], C.wave, { n: 7 });
        const q = K.at(K.p('hut'));
        if (q) {
          const x = Math.max(16, q[0] - 50), y = q[1] - 8, r = 12;
          ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = alpha(C.panel, 0.95); ctx.fill(); ctx.strokeStyle = C.text; ctx.lineWidth = 1.4; ctx.stroke();
          const ang = t * (2 + p.err * 0.6);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + r * 0.8 * Math.sin(ang), y - r * 0.8 * Math.cos(ang)); ctx.strokeStyle = p.err ? C.bad : C.text; ctx.lineWidth = 2; ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + r * 0.5 * Math.sin(ang / 12), y - r * 0.5 * Math.cos(ang / 12)); ctx.strokeStyle = C.text; ctx.stroke();
        }
        K.mark(K.p('hut'), p.err ? `Logger's clock ${fmt(Math.abs(p.err), 1)}% ${p.err > 0 ? 'fast' : 'slow'}` : 'Logger\'s clock, exact', { lift: 4 });
      },
      inset(ctx, b, C, t, p) {
        // The model's sums: the sender's bit is 1 / (1 + err) of the
        // receiver's, and the receiver reads bit k (k + ½) of its own bits
        // after the start edge — of the word (a UART) or of the frame — give
        // or take its jitter, which wanders afresh every 0.8 s.
        const e = p.err / 100, j0 = p.uart ? 0 : 30;
        const bits = Array.from(SAMPLE()).slice(j0, j0 + 10);
        const y = b.y + 18, cw = b.w / 10;
        bitRow(ctx, b, y, bits, C, { h: 18 });
        ['S', '0', '1', '2', '3', '4', '5', '6', '7', 'P'].forEach((s, j) => text(ctx, s, b.x + (j + 0.5) * cw, y - 4, C.muted, { align: 'center' }));
        const wob = Math.floor(t / 0.8);
        let lost = -1;
        for (let k = 0; k < 10; k++) {
          const at = (j0 + k + 0.5) * (1 + e) - j0 + p.jitter / 100 * 0.6 * hg((k + wob * 13) * 3);
          const bad = Math.floor(at) !== k;
          if (bad && lost < 0) lost = k;
          const x = b.x + at * cw;
          if (x < b.x - 4 || x > b.x + b.w + 4) continue;
          ctx.fillStyle = bad ? C.bad : C.text;
          ctx.beginPath(); ctx.moveTo(x, y + 22); ctx.lineTo(x - 4, y + 30); ctx.lineTo(x + 4, y + 30); ctx.closePath(); ctx.fill();
        }
        text(ctx, `▲ where the receiver reads, counting from the ${p.uart ? 'word\'s' : 'frame\'s'} start edge`, b.x, y + 44, C.muted);
        // How far off the middle the stop bit is read: past half a bit, it is
        // read in the next bit along (or the one before, for a slow clock).
        const off = (j0 + 9.5) * e, my = y + 72, mx = b.x + b.w / 2, half = b.w * 0.36;
        ctx.fillStyle = alpha(C.ok, 0.15); ctx.fillRect(mx - half, my - 6, 2 * half, 12);
        ctx.fillStyle = alpha(C.bad, 0.15); ctx.fillRect(b.x, my - 6, mx - half - b.x, 12); ctx.fillRect(mx + half, my - 6, b.x + b.w - mx - half, 12);
        ctx.fillStyle = C.muted; ctx.fillRect(mx - 0.5, my - 8, 1, 16);
        const xo = Math.max(b.x + 4, Math.min(b.x + b.w - 4, mx + (off / 0.5) * half));
        ctx.fillStyle = Math.abs(off) >= 0.5 ? C.bad : C.text;
        ctx.beginPath(); ctx.arc(xo, my, 5, 0, 2 * Math.PI); ctx.fill();
        text(ctx, 'the stop bit read from its middle (half a bit either way is safe)', b.x, my - 10, C.muted);
        const al = xo > b.x + b.w - 44 ? 'right' : xo < b.x + 44 ? 'left' : 'center';
        text(ctx, `${sgn(off * 100)}% of a bit`, al === 'right' ? b.x + b.w : al === 'left' ? b.x : xo, my + 18, Math.abs(off) >= 0.5 ? C.bad : C.text, { align: al, font: FONT_B });
        const what = p.err ? `A clock ${fmt(Math.abs(p.err), 2)}% ${p.err > 0 ? 'fast' : 'slow'}` : 'An exact clock';
        text(ctx, `${what}: ${lost < 0 ? 'every bit read in its own place.' : `${lost === 9 ? 'the stop bit' : lost === 0 ? 'the start bit' : `bit ${lost - 1}`} is read in the wrong one.`}`,
          b.x, b.y + b.h - 2, lost < 0 ? C.text : C.bad, { font: FONT_B });
      },
    },

    twist: {
      tag: 'pre-emphasis in the gauge\'s radio',
      where: 'The gauge\'s radio boosts the treble of its data input the way it boosts voice, so the 2109 Hz tone goes out louder '
        + 'than the 1301 Hz one. Noise then takes the weaker tone\'s bits far more often than the other\'s.',
      close: 'The two tones, as the repeater hears them',
      still: 1.0,
      scene(K, t) {
        const { C } = K, p = K.prm;
        const a = K.p('tx'), b = K.p('rx');
        const wm = p.twist > 0 ? 2 : 3.5, ws = p.twist > 0 ? 3.5 : 2;
        K.rings(a, r => (Math.floor(r * 6) % 2 ? C.sum : C.wave), { R: 14, n: 4 });
        K.flow([a, b], u => (Math.floor(u * 12 + t * 3) % 2 ? C.sum : C.wave), { n: 10, r: (wm + ws) / 2 });
        K.mark(K.p('hut'), Math.abs(p.twist) < 0.5 ? 'Radio\'s tones balanced' : 'Radio\'s data input', { lift: 4 });
      },
      inset(ctx, b, C, t, p) {
        const M = BM();
        const g = Math.pow(10, p.snr / 10), k = Math.pow(10, p.twist / 10);
        const m = 10 * Math.log10(g * 2 / (1 + k)), s = 10 * Math.log10(g * 2 * k / (1 + k));
        const yb = b.y + b.h - 34, H = b.h - 64;
        const top = Math.max(m, s), dbH = H / Math.max(12, top + 2);
        const floorH = Math.max(2, 2 * dbH + 2 * Math.abs(hg(Math.floor(t * 10) * 7)));
        const bar = (x, db, col, name) => {
          const h = Math.max(2, db * dbH);
          ctx.fillStyle = col; ctx.fillRect(x - 16, yb - h, 32, h);
          text(ctx, name, x, yb + 12, C.text, { align: 'center', font: FONT_B });
          text(ctx, `${fmt(db, 1)} dB`, x, yb - h - 4, col, { align: 'center', font: FONT_B });
        };
        bar(b.x + b.w * 0.28, m, C.wave, `${fmt(M.MARK_HZ)} Hz — a 1`);
        bar(b.x + b.w * 0.68, s, C.sum, `${fmt(M.SPACE_HZ)} Hz — a 0`);
        ctx.fillStyle = alpha(C.muted, 0.3); ctx.fillRect(b.x, yb - floorH, b.w, floorH);
        text(ctx, 'noise', b.x + b.w - 2, yb - floorH - 3, C.muted, { align: 'right' });
        hline(ctx, b.x, b.x + b.w, yb, C.muted);
        text(ctx, `A 1 misread ${oneIn(M.ber(m))}, a 0 ${oneIn(M.ber(s))}.`, b.x, b.y + b.h - 2, Math.abs(p.twist) >= 1 ? C.bad : C.text, { font: FONT_B });
      },
    },

    stuck: {
      tag: 'a broken wire in the hut',
      where: 'Inside the gauge\'s hut, one wire from the sensor to the logger is broken, or shorted, or its input has failed: that '
        + 'bit always reads the same, and every reading that needed it the other way is out by exactly its weight.',
      close: p => `Inside the hut: bit ${p.bit}'s wire, stuck at ${p.to}`,
      still: 2.0,
      scene(K) { K.flow(K.direct(), K.C.wave, { n: 6, base: 0.3 }); K.mark(K.p('hut'), 'Inside the hut', { lift: 4 }); },
      inset(ctx, b, C, t, p) { wiring(ctx, b, C, t, 'stuck', p, { to: i => i, broken: p.bit }); },
    },
    shift: {
      tag: 'a loom one pin over, in the hut',
      where: 'Inside the gauge\'s hut, the loom is plugged in one pin over (or the decoder is told the field starts a bit early): '
        + 'every bit lands in its neighbour\'s place, and every reading comes out doubled — or halved.',
      close: p => `Inside the hut: every wire one pin ${p.left ? 'up — doubled' : 'down — halved'}`,
      still: 2.0,
      scene(K) { K.flow(K.direct(), K.C.wave, { n: 6, base: 0.3 }); K.mark(K.p('hut'), 'Inside the hut', { lift: 4 }); },
      inset(ctx, b, C, t, p) { wiring(ctx, b, C, t, 'shift', p, { to: i => (p.left ? i + 1 : i - 1) }); },
    },
    invert: {
      tag: 'logic the other way up',
      where: 'A sensor whose outputs are active-low, or a logger input set to the wrong polarity: every 1 reads as 0 and every 0 as '
        + '1, so each reading arrives as its mirror image — the largest number less the true one.',
      close: 'Inside the hut: every bit turned over',
      still: 2.0,
      scene(K) { K.flow(K.direct(), K.C.wave, { n: 6, base: 0.3 }); K.mark(K.p('hut'), 'Inside the hut', { lift: 4 }); },
      inset(ctx, b, C, t, p) { wiring(ctx, b, C, t, 'invert', p, { to: i => i, mark: true }); },
    },
    reverse: {
      tag: 'a loom wired end for end',
      where: 'Bits sent least significant first and read most significant first, or a loom wired end for end: each reading arrives '
        + 'with its bits in reverse order — one fixed rule, so the same reading always becomes the same wrong one.',
      close: 'Inside the hut: the wires crossed end for end',
      still: 2.0,
      scene(K) { K.flow(K.direct(), K.C.wave, { n: 6, base: 0.3 }); K.mark(K.p('hut'), 'Inside the hut', { lift: 4 }); },
      inset(ctx, b, C, t, p) { wiring(ctx, b, C, t, 'reverse', p, { to: (i, w) => w - 1 - i }); },
    },
    gray: {
      tag: 'the float\'s shaft encoder',
      where: 'The float in the stilling well turns a shaft encoder whose disc is printed in Gray code, so neighbouring steps differ in '
        + 'one bit. Read as plain binary, a river rising smoothly comes out zig-zagging.',
      close: p => (p.way === 'ungray' ? 'A binary disc, read as Gray code' : 'The encoder\'s disc, read as plain binary'),
      still: 1.4,
      scene(K, t) {
        const { ctx, C } = K;
        K.flow(K.direct(), C.wave, { n: 6, base: 0.3 });
        // The float, rising and falling in the well.
        const w = PLACE.well;
        const fz = groundZ(w.x, w.y) + 1.4 + 1.2 * Math.sin(t * 1.0);
        const q = K.at([w.x, w.y, fz]);
        if (q) { ctx.beginPath(); ctx.arc(q[0], q[1] - 2, 4, 0, 2 * Math.PI); ctx.fillStyle = C.warn; ctx.fill(); ctx.strokeStyle = C.text; ctx.lineWidth = 1; ctx.stroke(); }
        K.mark(K.p('well'), 'Float and encoder', { lift: 9 });
      },
      inset(ctx, b, C, t, p) {
        const M = BM();
        const gray = p.way !== 'ungray';
        const n = 16, step = Math.floor(t * 1.5) % n;
        const printed = s => (gray ? M.toGray(s) : s);
        const read = s => (gray ? M.toGray(s) : M.fromGray(s)) & 15;
        const r0 = Math.min(b.h / 2 - 6, 56), cx = b.x + r0 + 4, cy = b.y + b.h / 2 - 4;
        const turn = -step / n * 2 * Math.PI - Math.PI / 2;
        for (let ring = 0; ring < 4; ring++) {
          const ro = r0 * (1 - ring * 0.2), ri = ro - r0 * 0.18;
          for (let s = 0; s < n; s++) {
            const on = (printed(s) >> (3 - ring)) & 1;
            const a0 = turn + s / n * 2 * Math.PI, a1 = a0 + 2 * Math.PI / n;
            ctx.beginPath(); ctx.arc(cx, cy, ro, a0, a1); ctx.arc(cx, cy, ri, a1, a0, true); ctx.closePath();
            ctx.fillStyle = on ? C.text : alpha(C.muted, 0.16); ctx.fill();
          }
        }
        // The read head, across the four tracks.
        hline(ctx, cx + r0 * 0.3, cx + r0 + 6, cy, C.bad, [], 2.5);
        const g = read(step);
        const tx = cx + r0 + 16;
        text(ctx, `River at step ${fmt(step)}`, tx, b.y + 14, C.text, { font: FONT_B });
        text(ctx, `the head reads ${printed(step).toString(2).padStart(4, '0')}`, tx, cy - 4, C.muted, { font: MONO });
        text(ctx, `${gray ? 'as binary' : 'as Gray code'}: ${fmt(g)}`, tx, cy + 14, g !== step ? C.bad : C.ok, { font: FONT_B });
        text(ctx, 'steps 0, 1, 2, 3, 4, 5 read as', tx, b.y + b.h - 16, C.muted);
        text(ctx, `${[0, 1, 2, 3, 4, 5].map(s => fmt(read(s))).join(', ')} …`, tx, b.y + b.h - 2, C.bad, { font: FONT_B });
      },
    },
  };
  const ORDER = Object.keys(SPOTS);

  // ── A frame ────────────────────────────────────────────────────────────────
  // A canvas sized by CSS, given a backing store to match.
  function fit(cv) {
    if (!cv) return null;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    return { ctx: cv.getContext('2d'), w, h, dpr };
  }
  const momentOf = o => (o.still ? (SPOTS[o.id] || SPOTS.noise).still : o.t);
  // The bench's settings for the fault, or its defaults when there are none.
  const paramsOf = o => o.params || BM().defaults(SPOTS[o.id] ? o.id : 'noise');
  // A close-up's title: some say what the settings are.
  function closeOf(id, p) {
    const sp = SPOTS[id] || SPOTS.noise;
    return typeof sp.close === 'function' ? sp.close(p || BM().defaults(id)) : sp.close;
  }

  // The site. o: { id, name (the bench's word for the fault), params (its
  // settings on the bench), t (seconds since it came on screen), yaw, still,
  // tour: { i, n, frac, on } }
  function draw(cv, o) {
    const f = fit(cv);
    if (!f) return;
    const { ctx, w, h, dpr } = f;
    const C = pal();
    const yaw = clampYaw(o.yaw == null ? YAW0 : o.yaw);
    const B = basis(w, h, yaw);
    const sp = SPOTS[o.id] || SPOTS.noise;
    const t = momentOf(o);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(ground(B, w, h, dpr, C, yaw), 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const K = kit(ctx, B, C, t, !!o.still);
    K.prm = paramsOf(o);
    if (sp.sky) sp.sky(K, t);
    // The two ends, always named, so the site reads before the fault does.
    const tq = K.at(up(PLACE.hut.x + 2, PLACE.hut.y + 2, -1.5)), rq = K.at(up(PLACE.rhut.x, PLACE.rhut.y, -1.5));
    if (tq) pill(ctx, 'Our gauge — sends', tq[0], tq[1] + 16, C, { align: 'center', col: C.muted, font: FONT });
    if (rq) pill(ctx, 'Repeater — hears', rq[0], rq[1] + 16, C, { align: 'center', col: C.muted, font: FONT });
    sp.scene(K, t);
    // The title, top left: the fault, and where.
    const name = o.name || '';
    ctx.font = FONT_T;
    const nw = ctx.measureText(name).width;
    ctx.font = FONT;
    const tw = Math.min(w - 16, nw + 26 + ctx.measureText(`— ${sp.tag}`).width);
    roundRect(ctx, 8, 8, tw, 24, 6);
    ctx.fillStyle = alpha(C.panel, 0.92);
    ctx.fill();
    text(ctx, name, 16, 20.5, C.text, { font: FONT_T, base: 'middle' });
    if (nw + 40 < tw) {
      ctx.save(); ctx.beginPath(); ctx.rect(8, 8, tw - 4, 24); ctx.clip();
      text(ctx, `— ${sp.tag}`, 22 + nw, 20.5, C.muted, { base: 'middle' });
      ctx.restore();
    }
    // The tour: a dot for each fault, the one shown filled, and how long
    // until the next.
    if (o.tour) {
      const n = o.tour.n, gap = 11, x0 = 14, y = h - 11;
      for (let i = 0; i < n; i++) {
        ctx.beginPath();
        ctx.arc(x0 + i * gap, y, i === o.tour.i ? 4 : 2.6, 0, 2 * Math.PI);
        ctx.fillStyle = i === o.tour.i ? C.accent : alpha(C.muted, 0.55);
        ctx.fill();
      }
      if (o.tour.on) {
        ctx.fillStyle = alpha(C.accent, 0.25);
        ctx.fillRect(x0 + n * gap + 4, y - 2, 60, 4);
        ctx.fillStyle = C.accent;
        ctx.fillRect(x0 + n * gap + 4, y - 2, 60 * Math.max(0, Math.min(1, o.tour.frac)), 4);
      }
    }
  }

  // The close-up, on a canvas of its own beside the site: its title, and the
  // drawing under it. o as for draw().
  function closeUp(cv, o) {
    const f = fit(cv);
    if (!f) return;
    const { ctx, w, h, dpr } = f;
    const C = pal();
    const sp = SPOTS[o.id] || SPOTS.noise;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const p = paramsOf(o);
    text(ctx, closeOf(o.id, p), 10, 17, C.text, { font: FONT_B });
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 24, w, h - 24); ctx.clip();
    sp.inset(ctx, { x: 10, y: 30, w: w - 20, h: h - 38 }, C, momentOf(o), p);
    ctx.restore();
  }

  return { draw, closeUp, closeOf, SPOTS, ORDER, YAW0, clampYaw };
})();
