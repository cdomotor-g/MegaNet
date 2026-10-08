// MegaNet — propagation-scene.js
//
//   PropScene   the 🎓 Radio Propagation tab's 3-D scene: a made-up catchment
//               thirty kilometres across — two field stations, two hilltop
//               repeaters, two base stations, a mountain between them, a
//               forest, a river, a town with grain silos and a scarp to the
//               south — and the radio waves crossing it, drawn as they go:
//               the wavefront spreading in every direction at once, the radio
//               shadow behind the mountain, the paths that bend over a ridge,
//               bounce off the silos, the scarp and the ground, and the
//               bursts that repeaters relay — with what each receiver made of
//               what it heard, bits flipped and all, and a timeline of the
//               whole exchange underneath.
//
// After propagation-physics.js (PropPhysics, every formula) and core.js
// (cssVar); before propagation.js, which owns the page around the canvas and
// calls mount() from its init(). Nothing here runs at load.
//
// ── Why a renderer of its own ────────────────────────────────────────────────
// The Stations map's 3-D view fetches MapLibre and the digital twin three.js,
// each the first time it is opened. This scene is a lesson rather than a map:
// a few thousand flat-shaded polygons and some lines, which a 2-D canvas draws
// in a few milliseconds. Drawing it here means it opens with no signal, on
// any device, and asks the network for nothing — the tab is meant to be read
// in a ute as easily as at a desk.
//
// The ground is drawn once per camera position into an offscreen canvas
// (painter's algorithm: every quad, tree and building face sorted far to
// near), and each animation frame lays the moving parts over that picture.
// Heights are drawn four times taller than they are (VEX) — a 640 m mountain
// in a 30 km square is otherwise a crease — and every radio sum is done in
// true metres; only the drawing is stretched.
//
// ── Time ─────────────────────────────────────────────────────────────────────
// The lesson needs two clocks. Radio crosses the whole scene in about 100
// microseconds; a keying lasts half a second and a repeater waits up to one.
// Shown at one rate, either the waves are a flash or the bursts take a day.
// So the story runs on a warped clock: each wave's flight is shown about
// 35,000 times slower than life and everything else six times slower, and the
// clock on the canvas always says which. That contrast — microseconds to fly,
// milliseconds to talk — is half of what the scene is for.
//
// ── What a receiver makes of it ──────────────────────────────────────────────
// Every keying's strength at every receiver is the sum of its paths (direct
// or diffracted, through any trees, and the echoes), and PropPhysics.receive()
// decides each frame: clean, flipped (a ghost or a wrong value that still
// passes), rejected by its check bits, lost under a stronger signal, or too
// weak. Repeaters store and forward: they relay what they decoded — flipped
// bits included — after their own delay, which the page lets you change.
//
// Exposes: mount, unmount, setScenario, setDelay, setLayer, setBaseHeight,
//          play, pause, toggle, replay, seekEnd, seekReal, now, cam, story,
//          layers, playing,
//          scenario, SCENARIOS, STATIONS, world, paths, linkDbm, tokens.

const PropScene = (function () {
  // ── The world ──────────────────────────────────────────────────────────────
  const W = 30, H = 20;            // km east, km north
  const NX = 60, NY = 40;          // terrain cells, half a kilometre each
  const VEX = 4;                   // heights drawn four times taller
  const TREE_M = 20;               // the canopy, for foliage loss
  const BLD_VEX = 4;               // buildings drawn taller again, so they show
  const FRESNEL_VIS = 8;           // the Fresnel zone drawn this much wider
  // A field station's link budget, the same shape as the link budget card's:
  // 5 W, 3 dBi omnidirectional antennas at both ends, 2 dB of feeder at each,
  // and the field allowance the app's model is calibrated with — core.js's
  // FN_MODEL_DEFAULTS, read at call time so a recalibration reaches the lesson.
  const PTX_DBM = 37, GAIN_DBI = 3, FEEDER_DB = 2;
  function budgetDb() {
    const field = typeof FN_MODEL_DEFAULTS !== 'undefined' ? FN_MODEL_DEFAULTS.allowance : 16;
    return PTX_DBM + 2 * GAIN_DBI - 2 * FEEDER_DB - field;
  }
  // The clock (see the header).
  const FLIGHT_MS = 0.12;          // 120 µs: a wave 36 km out, past every edge
  const FLIGHT_SHOW = 4200;        // …shown over 4.2 s
  const SLOW = 6;                  // the rest: one real ms is six on screen
  const HOLD = 3000;               // the end, held before it starts again

  const HILLS = [
    { x: 7.5,  y: 5.5,  h: 470, s: 2.2 },   // Hill A — repeater R1
    { x: 23.0, y: 15.2, h: 500, s: 2.3 },   // Hill B — repeater R2
    { x: 13.6, y: 12.6, h: 640, s: 2.4 },   // Mt Ridge, between the creek and the east
  ];
  const TOWN = { x0: 20.4, x1: 24.6, y0: 4.0, y1: 5.95 };
  const FORESTS = [
    { x: 4.4,  y: 13.0, rx: 3.4, ry: 2.8 },  // the creek's catchment
    { x: 12.6, y: 14.6, rx: 2.6, ry: 2.0 },  // Mt Ridge's north side
    { x: 17.55, y: 3.75, rx: 0.85, ry: 0.65 }, // a stand beside the rain gauge
    { x: 27.5, y: 13.5, rx: 1.6, ry: 2.4 },
  ];

  function riverY(x) { return 9.2 + 1.1 * Math.sin(x / 3.7) + 0.4 * Math.sin(x / 1.6); }

  // Ground height, m above sea level.
  function groundM(x, y) {
    let h = 30 + 0.9 * y;
    for (const k of HILLS) {
      const dx = x - k.x, dy = y - k.y;
      h += k.h * Math.exp(-(dx * dx + dy * dy) / (2 * k.s * k.s));
    }
    // The northern range, rising behind Hill B.
    h += 560 / (1 + Math.exp(-(y - 18.6) / 0.45)) * (0.85 + 0.15 * Math.sin(x * 0.55));
    // The southern scarp: a steep face looking north along y ≈ 1.2 km.
    const sx = 1 / (1 + Math.exp(-(x - 8) / 0.6)) * (1 / (1 + Math.exp((x - 27.5) / 0.6)));
    h += 430 / (1 + Math.exp((y - 1.2) / 0.22)) * sx;
    const dr = y - riverY(x);
    h -= 14 * Math.exp(-(dr * dr) / (2 * 0.28 * 0.28));
    return h;
  }

  function coverAt(x, y) {
    if (Math.abs(y - riverY(x)) < 0.22) return 'water';
    if (x >= TOWN.x0 && x <= TOWN.x1 && y >= TOWN.y0 && y <= TOWN.y1) return 'town';
    for (const f of FORESTS) {
      const u = (x - f.x) / f.rx, v = (y - f.y) / f.ry;
      // A ragged edge, so the wood does not read as an ellipse.
      if (u * u + v * v < 1 + 0.18 * Math.sin(x * 3.1 + y * 2.3)) return 'forest';
    }
    return 'grass';
  }

  // The six stations. `mast` is the antenna's height above the ground, m.
  const STATIONS = [
    { id: 'fs1', role: 'field',    name: 'Creek gauge',     short: 'Creek',  x: 4.2,  y: 13.2, mast: 4,
      msg: { addr: 1234, value: 412, says: 'river at 4.12 m' } },
    { id: 'fs2', role: 'field',    name: 'Rain gauge',      short: 'Rain',   x: 16.88, y: 3.6, mast: 4,
      msg: { addr: 2051, value: 37, says: 'rain gauge tip 37' } },
    { id: 'r1',  role: 'repeater', name: 'Hill A repeater', short: 'Hill A', x: 7.5,  y: 5.5,  mast: 20,
      msg: { addr: 3001, value: 133, says: 'battery 13.3 V' } },
    { id: 'r2',  role: 'repeater', name: 'Hill B repeater', short: 'Hill B', x: 23.0, y: 15.2, mast: 30,
      msg: { addr: 3002, value: 131, says: 'battery 13.1 V' } },
    { id: 'b1',  role: 'base',     name: 'Town base',       short: 'Town',   x: 22.6, y: 6.3,  mast: 15 },
    { id: 'b2',  role: 'base',     name: 'Depot base',      short: 'Depot',  x: 28.2, y: 9.6,  mast: 12 },
  ];
  const byId = id => STATIONS.find(s => s.id === id);

  // Planes that echo: the silos' west wall, and the scarp's face. In true km;
  // n is the side the echo leaves from.
  const SILO = { x: 23.15, y0: 6.0, y1: 6.6, h: 52 };
  const REFLECTORS = [
    { id: 'silos', label: 'Grain silos', kind: 'building', lossDb: 6,
      p0: [SILO.x, SILO.y0, 0], n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1],
      uMin: 0, uMax: SILO.y1 - SILO.y0, vMin: 0, vMax: 0 /* set from the ground */ },
    { id: 'scarp', label: 'Southern scarp', kind: 'mountain', lossDb: 10,
      p0: [8.5, 1.2, 0], n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1],
      uMin: 0, uMax: 18.5, vMin: 0.08, vMax: 0.42 },
  ];

  const SCENARIOS = {
    home: {
      title: 'A reading goes home',
      tx: [{ who: 'fs1', at: 0 }], relay: ['r1', 'r2'], delays: { r1: 0, r2: 600 },
      focus: 'b1', fresnel: ['fs1', 'r1'], drapeFrom: 'fs1', seed: 7,
    },
    same: {
      title: 'Two repeaters, one delay',
      tx: [{ who: 'fs2', at: 0 }], relay: ['r1', 'r2'], delays: { r1: 0, r2: 0 },
      focus: 'b1', fresnel: ['r1', 'b1'], drapeFrom: 'fs2', seed: 162,
    },
    both: {
      title: 'Two stations at once',
      tx: [{ who: 'fs1', at: 0 }, { who: 'fs2', at: 90 }], relay: ['r1', 'r2'], delays: { r1: 0, r2: 900 },
      focus: 'r1', fresnel: ['fs2', 'r1'], drapeFrom: 'fs2', seed: 58,
    },
    echo: {
      title: 'Echoes in town',
      tx: [{ who: 'r1', at: 0 }], relay: [], delays: { r1: 0, r2: 0 },
      focus: 'b1', fresnel: ['r1', 'b1'], drapeFrom: 'r1', echoes: true, seed: 3,
    },
  };

  // ── Geometry helpers ───────────────────────────────────────────────────────
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  let built = null;      // the grid, built on first use
  let baseMast = 15;     // the Town base's antenna, which the page can raise

  function world() {
    if (built) return built;
    const hv = new Float32Array((NX + 1) * (NY + 1));
    for (let j = 0; j <= NY; j++) {
      for (let i = 0; i <= NX; i++) hv[j * (NX + 1) + i] = groundM(i * W / NX, j * H / NY);
    }
    const cover = [];
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) cover.push(coverAt((i + 0.5) * W / NX, (j + 0.5) * H / NY));
    }
    // The silo wall stands on the ground under it.
    const g = groundM(SILO.x, (SILO.y0 + SILO.y1) / 2) / 1000;
    REFLECTORS[0].p0 = [SILO.x, SILO.y0, g];
    REFLECTORS[0].vMax = SILO.h / 1000;
    // Town blocks: a deterministic scatter, the silos kept clear.
    const rand = PropPhysics.rng(41);
    const blocks = [];
    for (let x = TOWN.x0 + 0.15; x < TOWN.x1 - 0.2; x += 0.42) {
      for (let y = TOWN.y0 + 0.15; y < TOWN.y1 - 0.2; y += 0.38) {
        if (rand() < 0.22) continue;
        blocks.push({ x: x + rand() * 0.08, y: y + rand() * 0.08, w: 0.2 + rand() * 0.12,
                      d: 0.16 + rand() * 0.1, h: 8 + rand() * 18, kind: 'block' });
      }
    }
    // The silos: three tall bins in a row behind the wall that echoes.
    for (let k = 0; k < 3; k++) {
      blocks.push({ x: SILO.x, y: SILO.y0 + 0.02 + k * 0.2, w: 0.22, d: 0.17, h: SILO.h, kind: 'silo' });
    }
    // Trees: one or two glyphs a forest cell, jittered.
    const trees = [];
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        if (cover[j * NX + i] !== 'forest') continue;
        const n = rand() < 0.55 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          trees.push({ x: (i + 0.15 + rand() * 0.7) * W / NX, y: (j + 0.15 + rand() * 0.7) * H / NY,
                       s: 0.75 + rand() * 0.5 });
        }
      }
    }
    built = { hv, cover, blocks, trees };
    return built;
  }

  // A station's antenna, true km.
  function antenna(s) {
    const mast = s.id === 'b1' ? baseMast : s.mast;
    return [s.x, s.y, (groundM(s.x, s.y) + mast) / 1000];
  }

  // ── Radio paths ────────────────────────────────────────────────────────────
  // Along the straight line a→b: the worst knife edge (with the Earth's
  // bulge under it), how much of the line runs through the canopy, and where.
  function profile(a, b, n = 120, skipEnds = 0) {
    const f = PropPhysics.F_MHZ;
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const dKm = Math.hypot(dx, dy);
    let worst = { nu: -Infinity, h: -Infinity, t: 0, x: a[0], y: a[1], g: 0 };
    let canopyM = 0;
    const leaves = [];          // [t0, t1] stretches through the trees
    let open = -1;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (t < skipEnds || t > 1 - skipEnds) continue;
      const x = a[0] + dx * t, y = a[1] + dy * t, zM = (a[2] + dz * t) * 1000;
      const d1 = dKm * t, d2 = dKm * (1 - t);
      const g = groundM(x, y);
      const h = g + PropPhysics.earthBulgeM(d1, d2) - zM;
      const nu = PropPhysics.knifeNu(h, d1, d2, f);
      if (nu > worst.nu) worst = { nu, h, t, x, y, g };
      const inLeaves = zM - g < TREE_M && zM - g > -5 && coverAt(x, y) === 'forest';
      if (inLeaves) { canopyM += dKm * 1000 / n; if (open < 0) open = t; }
      else if (open >= 0) { leaves.push([open, t]); open = -1; }
    }
    if (open >= 0) leaves.push([open, 1]);
    return { dKm, worst, canopyM, leaves, blocked: worst.h > 0 };
  }

  function polyKm(pts) {
    let k = 0;
    for (let i = 1; i < pts.length; i++) k += len(sub(pts[i], pts[i - 1]));
    return k;
  }

  // An echo off a plane reflector, by the image method: mirror the source in
  // the plane, draw the straight line from the mirror image to the receiver,
  // and where that line crosses the plane is where the wave bounced — if it
  // crosses inside the reflector and both legs are clear.
  function reflectOff(a, b, R) {
    const da = dot(sub(a, R.p0), R.n), db = dot(sub(b, R.p0), R.n);
    if (da <= 0 || db <= 0) return null;
    const img = sub(a, mul(R.n, 2 * da));
    const dir = sub(b, img);
    const t = -dot(sub(img, R.p0), R.n) / dot(dir, R.n);
    const p = add(img, mul(dir, t));
    const lu = dot(sub(p, R.p0), R.u), lv = dot(sub(p, R.p0), R.v);
    if (lu < R.uMin || lu > R.uMax || lv < R.vMin || lv > R.vMax) return null;
    const l1 = profile(a, p, 80, 0.02), l2 = profile(p, b, 40, 0.04);
    if (l1.blocked || l2.blocked) return null;
    return { p, img, legs: [l1, l2] };
  }

  // The ground bounce near the receiver: the ground there as a level mirror.
  function groundBounce(a, b) {
    const g = groundM(b[0], b[1]) / 1000;
    const R = { p0: [b[0] - 3, b[1] - 3, g], n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0],
                uMin: 0, uMax: 6, vMin: 0, vMax: 6 };
    const da = a[2] - g, db = b[2] - g;
    if (da <= 0 || db <= 0) return null;
    const img = [a[0], a[1], 2 * g - a[2]];
    const dir = sub(b, img);
    const t = (g - img[2]) / dir[2];
    const p = add(img, mul(dir, t));
    if (dot(sub(p, R.p0), R.u) < 0 || dot(sub(p, R.p0), R.u) > 6) return null;
    const c = coverAt(p[0], p[1]);
    if (c === 'town' || c === 'forest') return null;   // no mirror there
    const lift = [p[0], p[1], p[2] + 0.004];
    const l1 = profile(a, lift, 80, 0.02), l2 = profile(lift, b, 40, 0.04);
    if (l1.blocked || l2.blocked) return null;
    return { p, img, legs: [l1, l2] };
  }

  // Every way a wave gets from station `aId` to station `bId`, strongest
  // first: { kind, label, pts (true km), km, us, dbm, phase, losses, leaves }.
  // `echoes` adds the reflections; without it, the direct (or diffracted)
  // path alone, which is what the story and the coverage drape price.
  function paths(aId, bId, { echoes = false } = {}) {
    world();
    const PH = PropPhysics;
    const a = antenna(byId(aId)), b = antenna(byId(bId));
    const lam = PH.wavelengthM();
    const out = [];
    const make = (kind, label, pts, extraDb, phaseExtra, legs, losses) => {
      const km = polyKm(pts);
      const canopyM = legs.reduce((s, l) => s + l.canopyM, 0);
      const fol = PH.foliageDb(canopyM);
      const fspl = PH.fsplDb(km);
      const dbm = budgetDb() - fspl - fol - extraDb;
      const phase = -2 * Math.PI * ((km * 1000 / lam) % 1) + phaseExtra;
      out.push({ kind, label, pts, km, us: PH.delayUs(km), dbm, phase, canopyM,
                 losses: { fspl, foliage: fol, ...losses }, legs });
    };
    const pr = profile(a, b);
    const diff = PH.knifeDb(pr.worst.nu);
    if (pr.blocked) {
      const crest = [pr.worst.x, pr.worst.y, (pr.worst.g + 8) / 1000];
      const l1 = profile(a, crest, 60, 0.03), l2 = profile(crest, b, 60, 0.03);
      make('diffracted', 'Over the ridge', [a, crest, b], diff, 0, [l1, l2], { diffraction: diff });
    } else {
      make('direct', 'Direct', [a, b], diff, 0, [pr], { diffraction: diff });
    }
    if (echoes) {
      const gb = groundBounce(a, b);
      // A leg that grazes a ridge pays for it, as the direct path does.
      const graze = legs => legs.reduce((s, l) => s + PH.knifeDb(l.worst.nu), 0);
      if (gb) make('ground', 'Ground bounce', [a, gb.p, b], 1 + graze(gb.legs), Math.PI, gb.legs,
                   { reflection: 1, diffraction: graze(gb.legs) });
      for (const R of REFLECTORS) {
        const r = reflectOff(a, b, R);
        if (r) make(R.kind, R.label, [a, r.p, b], R.lossDb + graze(r.legs), Math.PI, r.legs,
                    { reflection: R.lossDb, diffraction: graze(r.legs) });
      }
    }
    // Phases relative to the first (direct or diffracted) path.
    const ref = out[0];
    for (const p of out) {
      p.dKm = p.km - ref.km;
      p.dUs = p.us - ref.us;
      p.rel = p.phase - ref.phase;
    }
    return out;
  }

  // The strength a receiver sees from a transmitter, averaged over the
  // fading: the copies' powers added.
  function linkDbm(aId, bId, opts) {
    const ps = paths(aId, bId, opts);
    return PropPhysics.dbm(ps.reduce((s, p) => s + PropPhysics.mw(p.dbm), 0));
  }

  // ── The story ──────────────────────────────────────────────────────────────
  // Who keys up when, what each receiver made of it, and the clock that shows
  // it. Built from the scenario, the delays and the base's mast; rebuilt when
  // any of them changes.
  function buildStory(sc, delays) {
    const PH = PropPhysics;
    const keyings = [];
    let n = 0;
    for (const t of sc.tx) {
      const s = byId(t.who);
      keyings.push({ key: 'k' + (n++), who: t.who, origin: t.who, via: null, startMs: t.at,
                     msg: s.msg, bits: PH.encodeAbf(s.msg.addr, s.msg.value) });
    }
    const flightMs = (a, b) => PH.delayUs(len(sub(antenna(byId(a)), antenna(byId(b))))) / 1000;
    const receptions = {};     // receiver id → [{ key, from, dbm, arriveMs, result }]
    const heardBy = (rx, list) => list
      .filter(k => k.who !== rx)
      .map(k => ({ id: k.key, from: k.who, startMs: k.startMs + flightMs(k.who, rx),
                   dbm: linkDbm(k.who, rx, { echoes: !!sc.echoes && rx === sc.focus }), bits: k.bits }));
    // Repeaters first: they hear the field stations and relay.
    let seed = sc.seed || 1;
    for (const rid of sc.relay) {
      const heard = heardBy(rid, keyings.filter(k => byId(k.who).role === 'field'));
      const res = PH.receive(heard, { seed: seed++ });
      receptions[rid] = heard.map((h, i) => ({ key: h.id, from: h.from, dbm: h.dbm, arriveMs: h.startMs, result: res[i] }));
      let free = -Infinity;
      const delay = delays[rid] || 0;
      for (const r of receptions[rid].slice().sort((p, q) => p.arriveMs - q.arriveMs)) {
        if (r.result.status !== 'clean' && r.result.status !== 'flipped') continue;
        const k = keyings.find(x => x.key === r.key);
        const start = Math.max(r.arriveMs + PH.KEYING_MS + delay, free);
        free = start + PH.KEYING_MS;
        keyings.push({ key: 'k' + (n++), who: rid, origin: k.origin, via: rid, startMs: start,
                       msg: k.msg, bits: r.result.bits.slice(), heardAs: r.result });
      }
    }
    // Then everyone hears everything that was keyed.
    for (const s of STATIONS) {
      if (s.role === 'field') continue;
      if (sc.relay.includes(s.id)) {
        continue;
      }
      const heard = heardBy(s.id, keyings);
      const res = PH.receive(heard, { seed: seed++ });
      receptions[s.id] = heard.map((h, i) => ({ key: h.id, from: h.from, dbm: h.dbm, arriveMs: h.startMs, result: res[i] }));
    }
    let endMs = 0;
    for (const k of keyings) endMs = Math.max(endMs, k.startMs + PH.KEYING_MS);
    endMs += 250;
    // The warped clock: flights slowed hugely, the rest gently.
    const wins = keyings.map(k => [k.startMs, k.startMs + FLIGHT_MS]).sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const w of wins) {
      const last = merged[merged.length - 1];
      if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
      else merged.push(w.slice());
    }
    const segs = [];
    let r = 0, d = 0;
    const push = (r0, r1, flight) => {
      const dd = flight ? FLIGHT_SHOW * (r1 - r0) / FLIGHT_MS : (r1 - r0) * SLOW;
      segs.push({ r0, r1, d0: d, d1: d + dd, flight });
      d += dd;
    };
    for (const w of merged) {
      if (w[0] > r) push(r, w[0], false);
      push(w[0], w[1], true);
      r = w[1];
    }
    if (endMs > r) push(r, endMs, false);
    return { keyings, receptions, endMs, segs, showMs: d, delays: { ...delays } };
  }

  function realAt(story, dMs) {
    for (const s of story.segs) {
      if (dMs <= s.d1) return { t: s.r0 + (s.r1 - s.r0) * (dMs - s.d0) / Math.max(s.d1 - s.d0, 1e-9), seg: s };
    }
    const s = story.segs[story.segs.length - 1];
    return { t: story.endMs, seg: s };
  }

  // ── Colour ─────────────────────────────────────────────────────────────────
  // Every colour is a token in styles.css, read at mount and again when the
  // theme moves (an observer on <html data-theme>).
  const TOKENS = {
    sky: '--rp-sky', sky2: '--rp-sky-2', grass: '--rp-grass', forest: '--rp-forest', tree: '--rp-tree',
    town: '--rp-town', water: '--rp-water', building: '--rp-building', silo: '--rp-silo',
    wave: '--rp-wave', echo: '--rp-echo', ray: '--rp-ray', leaves: '--rp-leaves', fresnel: '--rp-fresnel',
    field: '--role-field', repeater: '--role-repeater', base: '--role-base',
    good: '--rp-cov-strong', ok: '--rp-cov-good', weak: '--rp-cov-weak', none: '--rp-cov-none',
    text: '--text', muted: '--muted', panel: '--panel', border: '--border', bad: '--bad', okc: '--ok', warn: '--warn',
  };
  const FALLBACK = {
    sky: '#cfe3f6', sky2: '#f2f7fc', grass: '#a9c98a', forest: '#5f8f4e', tree: '#2f6b35', town: '#c9c3b8',
    water: '#5aa0d8', building: '#e6e1d8', silo: '#d9d4c8', wave: '#0097c4', echo: '#e07b00', ray: '#0b5cab',
    leaves: '#2e7d32', fresnel: '#7c35a3', field: '#107c10', repeater: '#0b5cab', base: '#c7401a',
    good: '#1b9e4b', ok: '#9bc53d', weak: '#e8a33d', none: '#8a8f98', text: '#16202a', muted: '#4f6478',
    panel: '#ffffff', border: '#dde5ee', bad: '#c7401a', okc: '#107c10', warn: '#9e5e00',
  };
  function tokens() {
    const out = {};
    for (const [k, v] of Object.entries(TOKENS)) {
      out[k] = typeof cssVar === 'function' ? cssVar(v, FALLBACK[k]) : FALLBACK[k];
    }
    return out;
  }
  function rgb(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return [128, 128, 128];
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const shade = (c, k) => `rgb(${Math.round(Math.min(255, c[0] * k))},${Math.round(Math.min(255, c[1] * k))},${Math.round(Math.min(255, c[2] * k))})`;
  const alpha = (hex, a) => { const c = rgb(hex); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };

  // ── The instance ───────────────────────────────────────────────────────────
  // One scene at a time: the tab has one canvas.
  let S = null;
  const CAM0 = { yaw: -0.42, pitch: 0.6, dist: 33 };
  const TARGET = [15, 10.2, 0];

  function stillPreferred() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (_) { return false; }
  }

  // ── Projection ─────────────────────────────────────────────────────────────
  function basis() {
    const c = S.cam;
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const eye = [TARGET[0] + c.dist * cp * Math.sin(c.yaw), TARGET[1] - c.dist * cp * Math.cos(c.yaw),
                 TARGET[2] + c.dist * sp];
    const f = norm(sub(TARGET, eye));
    const r = norm(cross(f, [0, 0, 1]));
    const u = cross(r, f);
    const F = 1.0 * Math.max(S.w, S.h * 1.45);
    return { eye, f, r, u, F, cx: S.w / 2, cy: S.h * 0.5 };
  }
  // A true-km point (z true km) to the screen: [sx, sy, depth] or null.
  function proj(B, p, zVis) {
    const v = [p[0] - B.eye[0], p[1] - B.eye[1], (zVis != null ? zVis : p[2] * VEX) - B.eye[2]];
    const zc = dot(v, B.f);
    if (zc < 0.5) return null;
    return [B.cx + B.F * dot(v, B.r) / zc, B.cy - B.F * dot(v, B.u) / zc, zc];
  }

  // ── The ground, drawn once per view ────────────────────────────────────────
  function drapeColour(dbm, P) {
    if (dbm >= -90) return P.good;
    if (dbm >= -105) return P.ok;
    if (dbm >= PropPhysics.SENS_DBM) return P.weak;
    return P.none;
  }

  // Received strength from `fromId` at every grid vertex, at a field
  // station's 4 m — the coverage drape. Cached per transmitter and mast.
  function drapeGrid(fromId) {
    const key = fromId + ':' + baseMast;
    if (S.drape && S.drape.key === key) return S.drape.v;
    const a = antenna(byId(fromId));
    const v = new Float32Array((NX + 1) * (NY + 1));
    const PH = PropPhysics;
    for (let j = 0; j <= NY; j++) {
      for (let i = 0; i <= NX; i++) {
        const x = i * W / NX, y = j * H / NY;
        const b = [x, y, (groundM(x, y) + 4) / 1000];
        const pr = profile(a, b, 36);
        const km = Math.max(len(sub(a, b)), 0.05);
        v[j * (NX + 1) + i] = budgetDb() - PH.fsplDb(km) - PH.knifeDb(pr.worst.nu) - PH.foliageDb(pr.canopyM);
      }
    }
    S.drape = { key, v };
    return v;
  }

  function drawGround() {
    const { hv, cover, blocks, trees } = world();
    const B = basis();
    const P = S.pal;
    const ctx = S.gctx;
    const dpr = S.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, S.h);
    sky.addColorStop(0, P.sky);
    sky.addColorStop(1, P.sky2);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, S.w, S.h);
    const pts = new Array((NX + 1) * (NY + 1));
    for (let j = 0; j <= NY; j++) {
      for (let i = 0; i <= NX; i++) {
        const k = j * (NX + 1) + i;
        pts[k] = proj(B, [i * W / NX, j * H / NY, hv[k] / 1000]);
      }
    }
    const L = norm([-0.55, 0.35, 0.62]);
    const prims = [];
    const drape = S.layers.drape ? drapeGrid(S.sc.drapeFrom) : null;
    const base = { grass: rgb(P.grass), forest: rgb(P.forest), town: rgb(P.town), water: rgb(P.water) };
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * (NX + 1) + i;
        const q = [pts[k], pts[k + 1], pts[k + NX + 2], pts[k + NX + 1]];
        if (q.some(p => !p)) continue;
        const dx = (hv[k + 1] + hv[k + NX + 2] - hv[k] - hv[k + NX + 1]) / 2 * VEX / 1000 / (W / NX);
        const dy = (hv[k + NX + 1] + hv[k + NX + 2] - hv[k] - hv[k + 1]) / 2 * VEX / 1000 / (H / NY);
        const nrm = norm([-dx, -dy, 1]);
        // Lit from the north-west, so a slope facing away reads as shadow;
        // and lifted a little with height, so the hills stand up.
        const hAvg = (hv[k] + hv[k + 1] + hv[k + NX + 1] + hv[k + NX + 2]) / 4;
        const lit = 0.42 + 0.72 * Math.max(0, dot(nrm, L)) + 0.12 * Math.min(1, hAvg / 650);
        let col;
        if (drape) {
          const avg = (drape[k] + drape[k + 1] + drape[k + NX + 1] + drape[k + NX + 2]) / 4;
          col = shade(rgb(drapeColour(avg, P)), lit);
        } else {
          const c = cover[j * NX + i];
          col = shade(base[c === 'water' ? 'grass' : c], lit);
        }
        prims.push({ d: (q[0][2] + q[2][2]) / 2, poly: q, fill: col });
      }
    }
    if (!drape) {
      const tc = rgb(P.tree);
      for (const t of trees) {
        const g = groundM(t.x, t.y) / 1000;
        const p0 = proj(B, [t.x, t.y, g]);
        const p1 = proj(B, [t.x, t.y, 0], g * VEX + 0.2 * t.s);
        if (!p0 || !p1) continue;
        const half = Math.max(1.2, (B.F * 0.07 * t.s) / p0[2]);
        prims.push({ d: p0[2] - 0.01, poly: [[p0[0] - half, p0[1]], [p0[0] + half, p0[1]], [p1[0], p1[1]]],
                     fill: shade(tc, 0.85 + 0.3 * ((t.x * 7.3) % 1)) });
      }
    }
    // Buildings: the four walls and the roof, each its own polygon.
    for (const b of blocks) {
      const g = groundM(b.x, b.y) / 1000 * VEX;
      const top = g + b.h / 1000 * VEX * (b.kind === 'silo' ? 1 : BLD_VEX);
      const x0 = b.x, x1 = b.x + b.w, y0 = b.y, y1 = b.y + b.d;
      const c = rgb(b.kind === 'silo' ? P.silo : P.building);
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const lo = corners.map(([x, y]) => proj(B, [x, y, 0], g));
      const hi = corners.map(([x, y]) => proj(B, [x, y, 0], top));
      if (lo.some(p => !p) || hi.some(p => !p)) continue;
      const faces = [[0, 1, [0, -1, 0]], [1, 2, [1, 0, 0]], [2, 3, [0, 1, 0]], [3, 0, [-1, 0, 0]]];
      for (const [i0, i1, n] of faces) {
        // Back faces are hidden by the front ones anyway; skip them.
        const mid = [(corners[i0][0] + corners[i1][0]) / 2, (corners[i0][1] + corners[i1][1]) / 2, g];
        if (dot(n, sub(B.eye, mid)) <= 0) continue;
        const lit = 0.55 + 0.45 * Math.max(0, dot(n, L));
        prims.push({ d: (lo[i0][2] + lo[i1][2]) / 2 - 0.02, poly: [lo[i0], lo[i1], hi[i1], hi[i0]],
                     fill: shade(c, lit), edge: true });
      }
      prims.push({ d: (hi[0][2] + hi[2][2]) / 2 - 0.03, poly: hi, fill: shade(c, 1.08), edge: true });
    }
    prims.sort((p, q) => q.d - p.d);
    ctx.lineJoin = 'round';
    for (const p of prims) {
      ctx.beginPath();
      ctx.moveTo(p.poly[0][0], p.poly[0][1]);
      for (let i = 1; i < p.poly.length; i++) ctx.lineTo(p.poly[i][0], p.poly[i][1]);
      ctx.closePath();
      ctx.fillStyle = p.fill;
      ctx.fill();
      ctx.strokeStyle = p.edge ? 'rgba(0,0,0,.25)' : p.fill;
      ctx.lineWidth = p.edge ? 0.6 : 0.7;
      ctx.stroke();
    }
    // The river, as a line over the ground.
    ctx.beginPath();
    let first = true;
    for (let x = 0; x <= W; x += 0.25) {
      const y = riverY(x);
      const p = proj(B, [x, y, (groundM(x, y) + 2) / 1000]);
      if (!p) continue;
      if (first) { ctx.moveTo(p[0], p[1]); first = false; } else ctx.lineTo(p[0], p[1]);
    }
    ctx.strokeStyle = P.water;
    ctx.lineWidth = Math.max(2, 3.2 * 33 / S.cam.dist);
    ctx.lineCap = 'round';
    ctx.stroke();
    S.groundKey = viewKey();
  }

  function viewKey() {
    return [S.w, S.h, S.cam.yaw.toFixed(4), S.cam.pitch.toFixed(4), S.cam.dist.toFixed(3),
            S.layers.drape ? S.sc.drapeFrom + baseMast : '', S.palKey].join('|');
  }

  // ── The moving parts ───────────────────────────────────────────────────────
  // Is the wave from `a` (true km) at point p in the open, or in a shadow?
  function lit(a, p) {
    const pr = profile(a, p, 18, 0.02);
    return pr.worst.h <= 0;
  }

  // One spherical wavefront of radius rKm about `c`, drawn as rings at a few
  // heights and the line where it meets the ground. Points the wave reaches
  // in the open are bright; points in a radio shadow, faint and dashed — the
  // wave gets there only by bending, and much weaker. `keep(p)` filters the
  // points (an echo exists only beyond its reflector).
  function drawFront(ctx, B, c, rKm, colour, strength, keep) {
    const P = S.pal;
    const N = 84;
    const fade = Math.max(0.4, Math.min(1, 4 / Math.max(rKm, 0.6))) * strength;
    const rings = [];
    // The ground line.
    const ground = [];
    for (let i = 0; i <= N; i++) {
      const a = i / N * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      let rho = rKm, ok = true, z = 0;
      for (let it = 0; it < 4; it++) {
        const x = c[0] + rho * ca, y = c[1] + rho * sa;
        z = groundM(x, y) / 1000;
        const dz = z - c[2];
        if (Math.abs(dz) > rKm) { ok = false; break; }
        rho = Math.sqrt(rKm * rKm - dz * dz);
      }
      const p = [c[0] + rho * ca, c[1] + rho * sa, z + 0.002];
      const inside = ok && p[0] > -0.5 && p[0] < W + 0.5 && p[1] > -0.5 && p[1] < H + 0.5;
      ground.push(inside && (!keep || keep(p)) ? p : null);
    }
    rings.push({ pts: ground, w: 3.2 });
    for (const zKm of [0.25, 0.5, 0.8, 1.1, 1.4]) {
      const dz = zKm - c[2];
      if (Math.abs(dz) >= rKm) continue;
      const rho = Math.sqrt(rKm * rKm - dz * dz);
      const ring = [];
      for (let i = 0; i <= N; i++) {
        const a = i / N * Math.PI * 2;
        const p = [c[0] + rho * Math.cos(a), c[1] + rho * Math.sin(a), zKm];
        const inside = p[0] > -0.5 && p[0] < W + 0.5 && p[1] > -0.5 && p[1] < H + 0.5
          && groundM(p[0], p[1]) / 1000 < zKm;
        ring.push(inside && (!keep || keep(p)) ? p : null);
      }
      rings.push({ pts: ring, w: 1.1 });
    }
    for (const ring of rings) {
      let prev = null, prevLit = null;
      for (const p of ring.pts) {
        if (!p) { prev = null; continue; }
        const sp = proj(B, p);
        if (!sp) { prev = null; continue; }
        const on = lit(c, p);
        if (prev) {
          const both = on && prevLit;
          if (both) {
            // A soft halo under the lit front, so it reads over any ground.
            ctx.beginPath();
            ctx.moveTo(prev[0], prev[1]);
            ctx.lineTo(sp[0], sp[1]);
            ctx.strokeStyle = alpha(colour, 0.22 * fade);
            ctx.setLineDash([]);
            ctx.lineWidth = ring.w * 3;
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.lineTo(sp[0], sp[1]);
          ctx.strokeStyle = alpha(colour, both ? 0.95 * fade : 0.35 * fade);
          ctx.setLineDash(both ? [] : [3, 4]);
          ctx.lineWidth = ring.w * (both ? 1 : 0.8);
          ctx.stroke();
        }
        prev = sp; prevLit = on;
      }
    }
    ctx.setLineDash([]);
    void P;
  }

  // A path drawn as far as the wave has got along it (`reachKm`), with the
  // stretches through the trees tinted and an echo's bounce marked.
  function drawPath(ctx, B, path, reachKm, colour, weight, flowing, t) {
    const P = S.pal;
    const pts = path.pts;
    let acc = 0;
    const scr = [];
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) {
        const seg = len(sub(pts[i], pts[i - 1]));
        if (acc + seg > reachKm) {
          const f = Math.max(0, (reachKm - acc) / seg);
          scr.push(proj(B, add(pts[i - 1], mul(sub(pts[i], pts[i - 1]), f))));
          break;
        }
        acc += seg;
      }
      scr.push(proj(B, pts[i]));
    }
    if (scr.some(p => !p) || scr.length < 2) return null;
    ctx.save();
    ctx.lineCap = 'round';
    // A pale casing so the line reads over any ground.
    ctx.beginPath();
    ctx.moveTo(scr[0][0], scr[0][1]);
    for (let i = 1; i < scr.length; i++) ctx.lineTo(scr[i][0], scr[i][1]);
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = weight + 2.2;
    ctx.stroke();
    ctx.strokeStyle = colour;
    ctx.lineWidth = weight;
    if (path.kind === 'diffracted') ctx.setLineDash([7, 5]);
    else if (path.kind === 'ground') ctx.setLineDash([2, 3]);
    if (flowing) {
      ctx.setLineDash(path.kind === 'diffracted' ? [7, 5] : [10, 6]);
      ctx.lineDashOffset = -t * 0.06;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // The trees along it, in green.
    {
      for (const [li, leg] of path.legs.entries()) {
        const a = pts[li], b = pts[li + 1];
        if (!a || !b) continue;
        for (const [t0, t1] of leg.leaves) {
          const pa = proj(B, add(a, mul(sub(b, a), t0))), pb = proj(B, add(a, mul(sub(b, a), t1)));
          if (!pa || !pb) continue;
          ctx.beginPath();
          ctx.moveTo(pa[0], pa[1]);
          ctx.lineTo(pb[0], pb[1]);
          ctx.strokeStyle = P.leaves;
          ctx.lineWidth = weight + 1.5;
          ctx.stroke();
        }
      }
    }
    if (path.pts.length === 3 && acc >= len(sub(pts[1], pts[0]))) {
      const m = proj(B, pts[1]);
      if (m) {
        ctx.beginPath();
        ctx.arc(m[0], m[1], path.kind === 'diffracted' ? 3 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = path.kind === 'diffracted' ? colour : P.echo;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
    return scr[scr.length - 1];
  }

  function drawFresnel(ctx, B) {
    const [aId, bId] = S.sc.fresnel;
    const a = antenna(byId(aId)), b = antenna(byId(bId));
    const d = len(sub(a, b));
    const dir = norm(sub(b, a));
    const s1 = norm(cross(dir, [0, 0, 1]));
    const s2 = cross(s1, dir);
    ctx.save();
    ctx.strokeStyle = alpha(S.pal.fresnel, 0.85);
    ctx.fillStyle = alpha(S.pal.fresnel, 0.08);
    ctx.lineWidth = 1.4;
    for (let k = 1; k < 16; k++) {
      const t = k / 16;
      // Drawn FRESNEL_VIS times wider than it is, in every direction, so the
      // pipe reads at this scale; the HUD says so.
      const r = PropPhysics.fresnelM(d * t, d * (1 - t)) / 1000 * FRESNEL_VIS;
      const c = add(a, mul(sub(b, a), t));
      ctx.beginPath();
      for (let i = 0; i <= 32; i++) {
        const th = i / 32 * Math.PI * 2;
        const p = add(c, add(mul(s1, r * Math.cos(th)), mul(s2, r * Math.sin(th) / VEX)));
        const sp = proj(B, p);
        if (!sp) continue;
        if (i === 0) ctx.moveTo(sp[0], sp[1]); else ctx.lineTo(sp[0], sp[1]);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function roleCol(role) { return S.pal[role] || S.pal.text; }

  function drawStations(ctx, B, now) {
    const P = S.pal;
    const st = S.story;
    for (const s of STATIONS) {
      const a = antenna(s);
      const g = groundM(s.x, s.y) / 1000;
      const foot = proj(B, [s.x, s.y, g]);
      const tip = proj(B, a);
      const flag = proj(B, [s.x, s.y, 0], g * VEX + 0.55);
      if (!foot || !tip || !flag) continue;
      const col = roleCol(s.role);
      // The mast, up to a label well above the ground.
      ctx.beginPath();
      ctx.moveTo(foot[0], foot[1]);
      ctx.lineTo(flag[0], flag[1]);
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // Keying: rings pulsing at the antenna.
      const keyed = st.keyings.some(k => k.who === s.id && now >= k.startMs && now <= k.startMs + PropPhysics.KEYING_MS);
      if (keyed) {
        const ph = (performance.now() / 420) % 1;
        for (const k of [0, 0.5]) {
          const rr = 4 + ((ph + k) % 1) * 14;
          ctx.beginPath();
          ctx.arc(tip[0], tip[1], rr, 0, Math.PI * 2);
          ctx.strokeStyle = alpha(col, 1 - ((ph + k) % 1));
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      // Hearing: a halo while a copy is arriving.
      const rx = (st.receptions[s.id] || []).some(r => r.result.status !== 'weak'
        && now >= r.arriveMs && now <= r.arriveMs + PropPhysics.KEYING_MS);
      if (rx) {
        ctx.beginPath();
        ctx.arc(tip[0], tip[1], 9, 0, Math.PI * 2);
        ctx.fillStyle = alpha(col, 0.25);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(tip[0], tip[1], 4, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      if (!S.layers.labels) continue;
      // The label, and what the station made of the last frame it finished.
      const out = lastOutcome(s.id, now);
      const text = s.short + (out ? '  ' + out.mark : '');
      ctx.font = `600 ${S.w < 520 ? 10 : 12}px system-ui, -apple-system, Segoe UI, sans-serif`;
      const tw = ctx.measureText(text).width;
      const bx = flag[0] - tw / 2 - 6, by = flag[1] - 20;
      ctx.fillStyle = alpha(P.panel, 0.92);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      roundRect(ctx, bx, by, tw + 12, 18, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = out ? out.colour : P.text;
      ctx.fillText(text, bx + 6, by + 13);
    }
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

  // The last frame a receiver finished hearing by `now`, as a mark.
  function lastOutcome(id, now) {
    const PH = PropPhysics;
    const rs = (S.story.receptions[id] || []).filter(r => now >= r.arriveMs + PH.LEAD_MS + PH.FRAME_MS);
    if (!rs.length) return null;
    const r = rs.sort((p, q) => p.arriveMs - q.arriveMs)[rs.length - 1];
    return outcomeMark(r.result);
  }
  function outcomeMark(res) {
    const P = S ? S.pal : FALLBACK;
    switch (res.status) {
      case 'clean':    return { mark: '✓ ' + res.decoded.addr, colour: P.okc, word: 'clean' };
      case 'flipped':  return { mark: '⚡ ' + res.decoded.addr, colour: P.bad, word: 'bits flipped' };
      case 'rejected': return { mark: '✗ checks', colour: P.warn, word: 'rejected by its check bits' };
      case 'lost':     return { mark: '✗ lost', colour: P.muted, word: 'lost under a stronger signal' };
      default:         return { mark: '· weak', colour: P.muted, word: 'too weak to hear' };
    }
  }

  // ── A frame ────────────────────────────────────────────────────────────────
  function frame(ts) {
    S.raf = 0;
    if (!S.canvas.isConnected) return;
    const dt = S.lastTs ? Math.min(100, ts - S.lastTs) : 0;
    S.lastTs = ts;
    if (S.playing && S.onScreen) {
      S.clock += dt * S.speed;
      if (S.clock > S.story.showMs + HOLD) S.clock = 0;
    }
    draw();
    if (S.playing || S.dragging) S.raf = requestAnimationFrame(frame);
  }

  function kick() {
    if (S && !S.raf) S.raf = requestAnimationFrame(frame);
  }

  function nowReal() {
    return realAt(S.story, Math.min(S.clock, S.story.showMs));
  }

  function draw() {
    resize();
    const ctx = S.ctx;
    const dpr = S.dpr;
    if (S.groundKey !== viewKey()) drawGround();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(S.ground, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const B = basis();
    const { t, seg } = nowReal();
    const st = S.story;
    const PH = PropPhysics;
    if (S.layers.fresnel) drawFresnel(ctx, B);
    // Rays: every keying to every receiver that heard it.
    if (S.layers.rays) {
      for (const k of st.keyings) {
        if (t < k.startMs) continue;
        const reach = (t - k.startMs) * 1000 * PH.C_KM_PER_US;
        const on = t <= k.startMs + PH.KEYING_MS;
        const inFrame = t >= k.startMs + PH.LEAD_MS && t <= k.startMs + PH.LEAD_MS + PH.FRAME_MS;
        for (const [rid, list] of Object.entries(st.receptions)) {
          const rec = list.find(r => r.key === k.key);
          if (!rec || rec.result.status === 'weak') continue;
          const ps = S.paths(k.who, rid);
          const col = roleCol(byId(k.who).role);
          for (const p of ps) {
            const strong = Math.max(0.15, Math.min(1, (p.dbm - PH.SENS_DBM) / 40));
            const w = 1 + 2.4 * strong;
            const colour = p.kind === 'direct' || p.kind === 'diffracted' ? col : S.pal.echo;
            ctx.globalAlpha = on ? 0.95 : 0.22;
            drawPath(ctx, B, p, reach, colour, w, on && inFrame && S.playing, S.clock);
          }
        }
        ctx.globalAlpha = 1;
      }
    }
    // Wavefronts, while they are in flight.
    if (S.layers.waves) {
      for (const k of st.keyings) {
        const dt = t - k.startMs;
        if (dt < 0 || dt > FLIGHT_MS) continue;
        const r = dt * 1000 * PH.C_KM_PER_US;
        const a = antenna(byId(k.who));
        drawFront(ctx, B, a, r, S.pal.wave, 1);
        if (S.sc.echoes) {
          for (const R of REFLECTORS) {
            const da = dot(sub(a, R.p0), R.n);
            if (da <= 0) continue;
            const img = sub(a, mul(R.n, 2 * da));
            drawFront(ctx, B, img, r, S.pal.echo, 0.9, p => {
              if (dot(sub(p, R.p0), R.n) <= 0) return false;
              const dir = sub(p, img);
              const tt = -dot(sub(img, R.p0), R.n) / dot(dir, R.n);
              if (!(tt > 0 && tt < 1)) return false;
              const q = add(img, mul(dir, tt));
              const lu = dot(sub(q, R.p0), R.u), lv = dot(sub(q, R.p0), R.v);
              return lu >= R.uMin && lu <= R.uMax && lv >= R.vMin && lv <= R.vMax;
            });
          }
        }
      }
    }
    drawStations(ctx, B, t);
    drawHud(ctx, t, seg);
    drawLanes(t);
    if (S.onTick) S.onTick({ t, flight: seg.flight, factor: seg.flight ? FLIGHT_SHOW / FLIGHT_MS : SLOW, story: st });
  }

  function fmtT(ms) {
    if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
    return `${ms.toFixed(ms < 10 ? 2 : 0)} ms`;
  }

  function drawHud(ctx, t, seg) {
    const P = S.pal;
    const lines = [
      `t = ${fmtT(t)}`,
      seg.flight ? `waves in flight — shown ${Math.round(FLIGHT_SHOW / FLIGHT_MS).toLocaleString('en-AU')}× slower`
                 : `bursts on the air — shown ${SLOW}× slower`,
    ];
    ctx.font = '600 13px system-ui, -apple-system, Segoe UI, sans-serif';
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16;
    ctx.fillStyle = alpha(P.panel, 0.88);
    roundRect(ctx, 8, 8, w, 42, 6);
    ctx.fill();
    ctx.fillStyle = P.text;
    ctx.fillText(lines[0], 16, 25);
    ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = seg.flight ? P.wave : P.muted;
    ctx.fillText(lines[1], 16, 42);
    ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = P.muted;
    const note = 'Heights drawn ×4' + (S.layers.fresnel ? ` · Fresnel zone drawn ×${FRESNEL_VIS} wide` : '');
    ctx.fillText(note, 10, S.h - 10);
    // North, as an arrow on the ground.
    const B = basis();
    const c = proj(B, [1.2, 18.4, 0.15]), n = proj(B, [1.2, 19.6, 0.15]);
    if (c && n) {
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      ctx.lineTo(n[0], n[1]);
      ctx.strokeStyle = P.text;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.fillStyle = P.text;
      ctx.fillText('N', n[0] - 4, n[1] - 4);
    }
  }

  // ── The timeline under the scene ───────────────────────────────────────────
  function drawLanes(t) {
    const cv = S.lanes;
    if (!cv) return;
    const P = S.pal;
    const PH = PropPhysics;
    const st = S.story;
    const cssW = cv.clientWidth || 600;
    const rows = STATIONS;
    const rowH = 22, top = 18, left = 74, right = 12;
    const cssH = top + rows.length * rowH + 22;
    const dpr = S.dpr;
    if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
      cv.width = Math.round(cssW * dpr);
      cv.height = Math.round(cssH * dpr);
      cv.style.setProperty('--rp-lanes-h', cssH + 'px');
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const span = Math.max(st.endMs, 1200);
    const X = ms => left + (cssW - left - right) * ms / span;
    ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
    // Ticks every 250 ms.
    ctx.strokeStyle = alpha(P.muted, 0.35);
    ctx.fillStyle = P.muted;
    ctx.lineWidth = 1;
    // A label every 250 ms where there is room, every 500 or 1000 where not.
    const every = cssW < 420 ? 1000 : cssW < 720 ? 500 : 250;
    for (let ms = 0; ms <= span; ms += 250) {
      ctx.beginPath();
      ctx.moveTo(X(ms), top - 4);
      ctx.lineTo(X(ms), top + rows.length * rowH);
      ctx.stroke();
      if (ms % every) continue;
      const lab = ms === 0 ? '0' : (ms / 1000).toFixed(ms % 1000 ? 2 : 0) + ' s';
      ctx.fillText(lab, X(ms) - (ms === 0 ? 0 : 12), top + rows.length * rowH + 14);
    }
    rows.forEach((s, i) => {
      const y = top + i * rowH;
      ctx.fillStyle = P.text;
      ctx.fillText(s.short, 6, y + 14);
      ctx.fillStyle = roleCol(s.role);
      ctx.fillRect(left - 10, y + 6, 5, 10);
      // What it keyed.
      for (const k of st.keyings.filter(k => k.who === s.id)) {
        const x0 = X(k.startMs), x1 = X(k.startMs + PH.KEYING_MS);
        const f0 = X(k.startMs + PH.LEAD_MS), f1 = X(k.startMs + PH.LEAD_MS + PH.FRAME_MS);
        ctx.fillStyle = alpha(roleCol(s.role), 0.3);
        ctx.fillRect(x0, y + 3, x1 - x0, rowH - 6);
        ctx.fillStyle = roleCol(s.role);
        ctx.fillRect(f0, y + 3, f1 - f0, rowH - 6);
      }
      // What it heard, outlined in what it made of it.
      for (const r of st.receptions[s.id] || []) {
        if (r.result.status === 'weak') continue;
        const f0 = X(r.arriveMs + PH.LEAD_MS), f1 = X(r.arriveMs + PH.LEAD_MS + PH.FRAME_MS);
        const o = outcomeMark(r.result);
        ctx.strokeStyle = o.colour;
        ctx.lineWidth = 2;
        ctx.strokeRect(f0 + 1, y + 4, f1 - f0 - 2, rowH - 8);
      }
    });
    // Now.
    const xn = X(Math.min(t, span));
    ctx.beginPath();
    ctx.moveTo(xn, top - 6);
    ctx.lineTo(xn, top + rows.length * rowH + 2);
    ctx.strokeStyle = P.wave;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ── Size ───────────────────────────────────────────────────────────────────
  function resize() {
    const cv = S.canvas;
    const w = cv.clientWidth || 640, h = cv.clientHeight || 400;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (S.w === w && S.h === h && S.dpr === dpr) return;
    S.w = w; S.h = h; S.dpr = dpr;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    S.ground.width = cv.width;
    S.ground.height = cv.height;
    S.groundKey = null;
  }

  // ── The camera ─────────────────────────────────────────────────────────────
  function clampCam() {
    const c = S.cam;
    c.pitch = Math.max(0.16, Math.min(1.45, c.pitch));
    c.dist = Math.max(14, Math.min(64, c.dist));
  }
  function cam(action) {
    if (!S) return;
    const c = S.cam;
    switch (action) {
      case 'left':  c.yaw -= 0.26; break;
      case 'right': c.yaw += 0.26; break;
      case 'up':    c.pitch += 0.12; break;
      case 'down':  c.pitch -= 0.12; break;
      case 'in':    c.dist /= 1.18; break;
      case 'out':   c.dist *= 1.18; break;
      case 'top':   c.pitch = 1.45; c.yaw = 0; break;
      case 'low':   c.pitch = 0.22; break;
      default:      Object.assign(c, CAM0);
    }
    clampCam();
    kick();
  }

  function wire() {
    const cv = S.canvas;
    const ptrs = new Map();
    let pinch = 0;
    const down = e => {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* a synthetic pointer */ }
      S.dragging = true;
      if (ptrs.size === 2) {
        const [p, q] = [...ptrs.values()];
        pinch = Math.hypot(p.x - q.x, p.y - q.y);
      }
      kick();
    };
    const move = e => {
      const was = ptrs.get(e.pointerId);
      if (!was) return;
      const now = { x: e.clientX, y: e.clientY };
      ptrs.set(e.pointerId, now);
      if (ptrs.size === 2) {
        const [p, q] = [...ptrs.values()];
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (pinch) S.cam.dist *= pinch / Math.max(d, 1);
        pinch = d;
      } else {
        S.cam.yaw -= (now.x - was.x) * 0.0065;
        S.cam.pitch += (now.y - was.y) * 0.0045;
      }
      clampCam();
      kick();
    };
    const up = e => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = 0;
      if (!ptrs.size) S.dragging = false;
    };
    const key = e => {
      const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
                    '+': 'in', '=': 'in', '-': 'out', '_': 'out', Home: 'reset' };
      if (e.key === ' ') { e.preventDefault(); toggle(); return; }
      const a = map[e.key];
      if (!a) return;
      e.preventDefault();
      cam(a);
    };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('keydown', key);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => kick()) : null;
    if (ro) { ro.observe(cv); if (S.lanes) ro.observe(S.lanes); }
    const io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(es => { S.onScreen = es.some(x => x.isIntersecting); if (S.onScreen) kick(); })
      : null;
    if (io) io.observe(cv);
    const mo = new MutationObserver(() => repaint());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    S.off = () => {
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      cv.removeEventListener('keydown', key);
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      mo.disconnect();
    };
  }

  function repaint() {
    if (!S) return;
    S.pal = tokens();
    S.palKey = Object.values(S.pal).join(',');
    S.groundKey = null;
    kick();
  }

  // ── The API ────────────────────────────────────────────────────────────────

  // Paths, cached for the life of a story (they depend only on the stations
  // and the base's mast).
  function pathCache() {
    const cache = new Map();
    return (a, b) => {
      const k = a + '>' + b;
      if (!cache.has(k)) cache.set(k, paths(a, b, { echoes: !!S.sc.echoes && b === S.sc.focus }));
      return cache.get(k);
    };
  }

  function restory() {
    S.story = buildStory(S.sc, S.delays);
    S.paths = pathCache();
    S.drape = null;
    S.groundKey = null;
    if (S.onStory) S.onStory(S.story);
  }

  function mount({ canvas, lanes, onTick, onStory, scenario = 'home', layers = null, cam: camAt = null,
                   clock = null, delays = null }) {
    unmount();
    world();
    const ground = document.createElement('canvas');
    S = {
      canvas, lanes, ctx: canvas.getContext('2d'), ground, gctx: ground.getContext('2d'),
      w: 0, h: 0, dpr: 1, cam: { ...(camAt || CAM0) }, raf: 0, lastTs: 0, clock: 0, speed: 1,
      playing: false, dragging: false, onScreen: true, onTick, onStory,
      layers: layers ? { ...layers } : { waves: true, rays: true, fresnel: false, drape: false, labels: true },
      sc: SCENARIOS[scenario] || SCENARIOS.home, scId: SCENARIOS[scenario] ? scenario : 'home',
      delays: { ...((SCENARIOS[scenario] || SCENARIOS.home).delays), ...(delays || {}) },
      pal: null, palKey: '', groundKey: null, drape: null,
    };
    repaint();
    restory();
    wire();
    if (clock != null) S.clock = clock;
    if (stillPreferred()) S.clock = clock != null ? clock : S.story.showMs;   // the end, everything drawn
    else S.playing = true;
    kick();
  }

  function unmount() {
    if (!S) return;
    if (S.raf) cancelAnimationFrame(S.raf);
    if (S.off) S.off();
    S = null;
  }

  function setScenario(id) {
    if (!S || !SCENARIOS[id]) return;
    S.sc = SCENARIOS[id];
    S.scId = id;
    S.delays = { ...S.sc.delays };
    S.clock = 0;
    restory();
    if (stillPreferred() && !S.playing) S.clock = S.story.showMs;
    kick();
  }

  function setDelay(rid, ms) {
    if (!S) return;
    S.delays[rid] = Math.max(0, Math.min(990, Number(ms) || 0));
    restory();
    S.clock = Math.min(S.clock, S.story.showMs);
    kick();
  }

  function setBaseHeight(m) {
    baseMast = Math.max(2, Math.min(60, Number(m) || 15));
    if (!S) return;
    restory();
    kick();
  }

  function setLayer(name, on) {
    if (!S || !(name in S.layers)) return;
    S.layers[name] = !!on;
    S.groundKey = null;
    kick();
  }

  function play()   { if (!S) return; S.playing = true; S.lastTs = 0; if (S.clock >= S.story.showMs + HOLD) S.clock = 0; kick(); }
  function pause()  { if (!S) return; S.playing = false; kick(); }
  function toggle() { if (!S) return; if (S.playing) pause(); else play(); if (S.onTick) kick(); }
  function replay() { if (!S) return; S.clock = 0; play(); }
  function seekEnd() { if (!S) return; S.clock = S.story.showMs; S.playing = false; kick(); }
  // Paused at a moment of the story's own clock (real ms) — for a still
  // picture of one instant, and for test/propagation.mjs.
  function seekReal(ms) {
    if (!S) return;
    let d = S.story.showMs;
    for (const g of S.story.segs) {
      if (ms <= g.r1) { d = g.d0 + (g.d1 - g.d0) * Math.max(0, ms - g.r0) / Math.max(g.r1 - g.r0, 1e-9); break; }
    }
    S.clock = d;
    S.playing = false;
    kick();
  }
  function now() { return S ? nowReal().t : null; }

  return {
    mount, unmount, setScenario, setDelay, setLayer, setBaseHeight, play, pause, toggle, replay, seekEnd, seekReal, now, cam,
    story: () => (S ? S.story : null),
    layers: () => (S ? { ...S.layers } : null),
    playing: () => !!(S && S.playing),
    scenario: () => (S ? S.scId : null),
    delays: () => (S ? { ...S.delays } : null),
    baseMast: () => baseMast,
    outcomeMark,
    SCENARIOS, STATIONS, REFLECTORS, world, paths, linkDbm, groundM, coverAt, antenna, tokens,
    buildStory: (id, delays) => buildStory(SCENARIOS[id], { ...SCENARIOS[id].delays, ...(delays || {}) }),
  };
})();
