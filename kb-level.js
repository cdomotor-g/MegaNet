// MegaNet — kb-level.js
//
//   KbLevel   the "A Day on the Level" tab in Field training: a day of
//             levelling practice told one step at a time — the site and the
//             briefing, setting your organisation's limits before you go,
//             levelling the instrument, reading the staff, the two-peg test
//             from the midpoint and then near one peg, planning the weir
//             cross-section, running and booking it through a change point,
//             closing the loop on the benchmark, and the end-of-day review.
//             Adapted from Mallee HydroTech's Hydrographer: A Day on the
//             Level (github.com/MalleeHydroTech/hydrographer-day-on-the-level),
//             a three.js game with a simulated SDL50 and its LevelBook. What
//             came across: the site (local grid, BM01 at chainage 8, RL
//             104.150, the twelve-vertex weir profile), the coach's order of
//             work, the practice-policy rules (no blank limit is ever zero),
//             the reading tolerances, the two-peg geometry checks and formulas,
//             the misclose rules, the checked route from the game's own tests
//             and the review's messages. Left out: the 3D scene, models, audio,
//             the instrument's keypad and menus, and the evidence capture that
//             compares a booked number with the sight it came from.
//
// After core.js, knowledge-base.js, levelling.js (whose reduce() and twoPeg()
// do the sums) and two-peg.js (whose diagram() draws the peg test), before
// init.js. Nothing runs at load.

const KbLevel = (function () {
  const TAB = 'kblevel';
  const KEY = 'floodnet-kb-level';
  const L = Levelling;

  // ── The game's site ────────────────────────────────────────────────────────
  // Authored practice terrain on a local grid, not a real survey: chainage 0 at
  // the left bank (E 1000, N 1000) to 98 at the right (E 1098), in metres.
  const PROFILE = [[0, 104.2], [8, 104.15], [20, 104.2], [38, 100.6], [43, 100.6], [43, 100], [45, 100],
    [45, 100.6], [50, 100.6], [68, 104.2], [82, 104.15], [98, 104.2]];
  const FEATURES = ['Left section endpoint', 'Left natural-ground hollow', 'Top of left bank', 'Left bank meets concrete',
    'Left low-flow top corner', 'Left low-flow inside corner', 'Right low-flow inside corner', 'Right low-flow top corner',
    'Right concrete meets bank', 'Top of right bank', 'Right natural-ground hollow', 'Right section endpoint'];
  const BM = { name: 'BM01', ch: 8, rl: 104.15 };
  const EYE = 1.3736;      // the game's line of sight above the ground under the tripod (0.1076 + 1.266 m)
  const STAFF = 4;         // a 4 m staff: a reading outside 0–4 m is off the staff
  const POOL = 100.10;     // the pool's art level above the low-flow notch

  // Sights from the game's checked route (its mixed-survey test): digital
  // readings to 0.1 mm, E-face readings to the millimetre.
  const SIGHTS = [
    { what: 'Backsight on BM01 from the level at chainage 26', c: 0.2236, d: 18 },
    { what: 'Foresight to the left low-flow top corner (chainage 43) from chainage 26', c: 3.7736, d: 17 },
    { what: 'Backsight on that corner from the level at chainage 38', c: 1.3736, d: 5 },
    { what: 'Intermediate on the right concrete edge (chainage 50) from chainage 38', c: 1.3736, d: 12 },
  ];
  // The closing foresight as the game's route reads it, then three badly read
  // versions for practice.
  const CLOSE_READS = ['0.2236', '0.2246', '0.2206', '0.2276'];
  const PEG_SPACINGS = [24, 30, 50];
  const NEAR = 5;

  const STEPS = [
    { id: 'brief', title: 'Morning briefing' },
    { id: 'policy', title: 'Set your practice policy' },
    { id: 'level', title: 'Set up and level the instrument' },
    { id: 'read', title: 'Read the staff' },
    { id: 'peg1', title: 'Two-peg test: between the pegs' },
    { id: 'peg2', title: 'Two-peg test: near one peg' },
    { id: 'plan', title: 'The weir section: plan the sights' },
    { id: 'book', title: 'Run and book the levels' },
    { id: 'close', title: 'Close the loop' },
    { id: 'review', title: 'Review your day' },
  ];

  const QUIZ = {
    brief: { q: 'Where does the cross-section open and close?',
      options: ['On BM01 — a backsight to open, a foresight to close, RL 104.150 m', 'On the left section endpoint, chainage 0',
        'On whichever change point is handiest'],
      answer: 0,
      why: 'The run opens with a backsight on BM01 and closes with a foresight back onto it, booking its RL, 104.150 m, as the closing reference. The review checks both.' },
    r1: { q: 'You typed 1.41 for a sight whose centre hair read 1.402. What does the review say?',
      options: ['The staff reading does not match the saved sight.', 'The bubble was not centred when the reading was taken.', 'This instrument reading was used for another row.'],
      answer: 0, why: 'A manual reading has to be within a millimetre of the sight it came from.' },
    r2: { q: 'Your closing staff stood on the change point, not on BM01.',
      options: ['The opening backsight was not on BM01.', 'The closing staff position was not on the supplied BM01.', 'The distance does not match the saved sight.'],
      answer: 1, why: 'Closing on anything but the supplied benchmark proves nothing about the run.' },
    r3: { q: 'You nudged the tripod between the backsight and an intermediate in one set-up.',
      options: ['The backsight did not return to the same change point.', 'The instrument moved within this recorded setup.', 'Use metres for this sheet.'],
      answer: 1, why: 'Every sight in a set-up hangs off one height of collimation — move the level and that height is gone.' },
    r4: { q: 'Two-peg test, pegs 24 m apart: your second set-up was 9 m from peg A.',
      options: ['The first setup was not near the midpoint.', 'The second setup was not in the near-peg working area.', 'The instrument did not move to a different setup.'],
      answer: 1, why: 'The near set-up sits between the pegs within the nearest quarter of their spacing (6 m here), with sights of at least 5 m.' },
  };

  // ── Where you are ──────────────────────────────────────────────────────────
  let step = 0;
  let policy = null;          // the saved policy, or null
  let done = {};
  let loaded = false;
  let bubble = null;          // { x, y } in drawing units from the vial's centre
  let bubbleChecked = '';
  let sightIdx = 0;
  let peg = null;             // the current two-peg readings
  let closeIdx = 0;
  let picked = {};

  // ── Small parts ────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const val = id => { const el = $(id); return el ? L.num(el.value) : null; };
  const f3 = v => L.fmt(v, 3);
  const f4 = v => L.fmt(v, 4);
  const good = t => `<span class="kv-good">✓ ${t}</span>`;
  const bad = t => `<span class="kv-bad">✗ ${t}</span>`;

  function groundAt(x) {
    for (let i = 1; i < PROFILE.length; i++) {
      const [a, h] = PROFILE[i - 1], [b, k] = PROFILE[i];
      if (x <= b && b > a) return h + (k - h) * Math.max(0, Math.min(1, (x - a) / (b - a)));
    }
    return PROFILE[PROFILE.length - 1][1];
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && typeof s === 'object') {
        if (Number.isInteger(s.step) && s.step >= 0 && s.step < STEPS.length) step = s.step;
        if (s.policy && !checkPolicy(s.policy)) policy = s.policy;
        if (s.done && typeof s.done === 'object') done = s.done;
      }
    } catch (e) { /* a private window: start at the beginning */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ step, policy, done })); } catch (e) { /* nothing kept */ }
  }
  function mark(id) {
    if (done[id]) return;
    done[id] = true;
    save();
    const p = $('kv-prog');
    if (p) p.innerHTML = progressHtml();
  }

  // ── The policy (the game's practice-policy rules) ──────────────────────────
  function checkPolicy(p) {
    if (!p || !String(p.organisation || '').trim()) return 'Enter your organisation or training policy name.';
    const pos = v => String(v == null ? '' : v).trim() !== '' && Number.isFinite(Number(v)) && Number(v) > 0;
    if (!pos(p.twoPegLimit)) return 'Enter a positive two-peg tolerance.';
    if (!pos(p.minimumPegSpacing)) return 'Enter a positive minimum peg spacing.';
    if (p.surveyBasis !== 'change-points' && !pos(p.surveyLimit)) return 'Enter a positive survey tolerance.';
    if (!['fixed', 'per10'].includes(p.twoPegBasis)) return 'Choose a two-peg tolerance basis.';
    if (!['fixed', 'change-points', 'fixed-or-change-points', 'distance'].includes(p.surveyBasis)) return 'Choose a misclose rule.';
    return null;
  }
  function policyRows(p) {
    const cp = '(1 + √change points) mm';
    const s = !p ? 'Not recorded' : p.surveyBasis === 'change-points' ? cp
      : p.surveyBasis === 'fixed' ? `${Number(p.surveyLimit)} mm`
      : p.surveyBasis === 'distance' ? `${Number(p.surveyLimit)} × √distance (km) mm`
      : `Larger of ${Number(p.surveyLimit)} mm or ${cp}`;
    return [
      ['Organisation or policy', p ? String(p.organisation) : 'Not recorded'],
      ['Two-peg misclose', !p ? 'Not recorded' : p.twoPegBasis === 'per10' ? `${Number(p.twoPegLimit)} mm per 10 m of peg spacing` : `${Number(p.twoPegLimit)} mm`],
      ['Minimum peg spacing', p ? `${Number(p.minimumPegSpacing)} m` : 'Not recorded'],
      ['Cross-section misclose', s],
    ];
  }
  // The two-peg allowance in mm for a given spacing, or null with no policy.
  function pegTolerance(spacing) {
    if (!policy) return null;
    const lim = Number(policy.twoPegLimit);
    return policy.twoPegBasis === 'per10' ? lim * spacing / 10 : lim;
  }
  // The section allowance in mm (the game's reduceSurvey), or null.
  function sectionAllowance(cps, km) {
    if (!policy) return null;
    const cpa = 1 + Math.sqrt(cps), lim = Number(policy.surveyLimit);
    if (policy.surveyBasis === 'change-points') return cpa;
    if (policy.surveyBasis === 'fixed-or-change-points') return Math.max(lim, cpa);
    if (policy.surveyBasis === 'distance') return km > 0 ? lim * Math.sqrt(km) : null;
    return lim;
  }

  // ── The two-peg readings ───────────────────────────────────────────────────
  // Made the way the game makes a sight: the line of sight EYE above the ground
  // under the level, plus the collimation slope times the sight length, read to
  // the millimetre. Set-up 1 at the midpoint, set-up 2 NEAR m from peg A.
  function makePeg(S) {
    const r3 = v => Math.round(v * 1000) / 1000;
    const c = Math.round((Math.random() * 0.5 - 0.25) * 1000) / 1e6;        // ±0.25 mm per metre
    const dB = r3(Math.random() * 0.6 - 0.3);                               // peg B's ground above A's
    const g1 = r3(Math.random() * 0.2 - 0.1), g2 = r3(Math.random() * 0.2 - 0.1);
    const half = S / 2;
    return {
      S, da1: half, db1: half, da2: NEAR, db2: S - NEAR,
      a1: r3(EYE + g1 + c * half), b1: r3(EYE + g1 - dB + c * half),
      a2: r3(EYE + g2 + c * NEAR), b2: r3(EYE + g2 - dB + c * (S - NEAR)),
    };
  }
  function pegNow() { if (!peg) peg = makePeg(PEG_SPACINGS[0]); return peg; }
  function pegResult() {
    const p = pegNow();
    const spacing = p.da1 + p.db1;
    const tol = pegTolerance(spacing);
    const r = L.twoPeg({ a1: p.a1, b1: p.b1, a2: p.a2, b2: p.b2, spacing, near: NEAR, tol: tol == null ? null : tol / 1000 });
    const mis = Math.round((r.d2 - r.d1) * 1e5) / 100;                       // setup 2 minus setup 1, mm
    const denom = (p.da2 - p.db2) - (p.da1 - p.db1);
    const collim = Math.abs(denom) < 1 ? null : (r.d2 - r.d1) / denom * 10 * 1000;
    const spacingOK = !policy || spacing + 1e-9 >= Number(policy.minimumPegSpacing);
    const verdict = !policy ? 'No tolerance recorded' : !spacingOK ? 'Review peg spacing'
      : Math.abs(mis) <= tol + 1e-9 ? 'Within limit' : 'Outside limit';
    return { r, mis, spacing, tol, collim, verdict };
  }

  // ── The route (the game's checked cross-section run) ───────────────────────
  function routeDoc(closeFs) {
    const R = (kind, name, s) => L.blankRow(kind, Object.assign({ name }, s));
    return {
      bm: { name: BM.name, rl: BM.rl }, datum: 'ASSUMED', gauge_zero: { rl: null }, tol: { misclose: 0.003, sight: 100, balance: 5 },
      rows: [
        R('bm', 'BM01', { bs: '0.2236', bs_d: 18 }),
        R('cp', 'CP1', { fs: '3.774', fs_d: 17, bs: '1.3736', bs_d: 5 }),
        R('other', 'Right concrete meets bank', { is: '1.374', is_d: 12 }),
        R('cp', 'CP2', { fs: '1.374', fs_d: 5, bs: '3.774', bs_d: 17 }),
        R('bm', 'BM01', { fs: closeFs, fs_d: 18 }),
      ],
    };
  }
  const ROUTE_INFO = [
    { setup: '1 (ch 26)', dir: 'Towards left bank', d: '18', note: 'Opening backsight, BM01' },
    { setup: '1 → 2 (ch 38)', dir: 'Towards right bank', d: '17 / 5', note: 'Left low-flow top corner, ch 43 — change point' },
    { setup: '2 (ch 38)', dir: 'Towards right bank', d: '12', note: 'Right concrete meets bank' },
    { setup: '2 → 3 (ch 26)', dir: 'Towards right bank', d: '5 / 17', note: 'Same corner again — change point' },
    { setup: '3 (ch 26)', dir: 'Towards left bank', d: '18', note: 'Closing foresight, BM01' },
  ];
  const ROUTE_KM = (18 + 17 + 5 + 5 + 17 + 18) / 1000;

  // ── Drawings ───────────────────────────────────────────────────────────────
  // The weir section along the game's section line, which runs along the
  // control's crest: natural ground from bank to bank, and between chainage 38
  // and 50 the concrete control the game builds (concrete-control.ts) — two
  // wing blocks with their crest at 100.6 and the 2 m low-flow notch between
  // them, chainage 43–45, at 100.0 — founded at 98.75. The pool upstream stands
  // at 100.10 (weir-flow.ts), so on this line water shows only in the notch.
  // Drawn twice in one figure: the whole section (the vertical stretched about
  // eight times, as a section usually is), and below it the control close up
  // (stretched twice), where the notch is wide enough to see what a staff in
  // it can and cannot reach.
  const CONTROL = { from: 38, to: 50, crest: 100.6, notchFrom: 43, notchTo: 45, notch: 100.0, base: 98.75 };
  const WHOLE = { c0: 0, c1: 98, h0: 98.6, h1: 105.2, x: 34, y: 18, w: 352, h: 150 };
  const CLOSE = { c0: 35, c1: 53, h0: 98.6, h1: 102.2, x: 34, y: 226, w: 352, h: 100 };

  function sectionPanel(o, P, id) {
    const sx = P.w / (P.c1 - P.c0), sy = P.h / (P.h1 - P.h0);
    const X = c => +(P.x + (c - P.c0) * sx).toFixed(1);
    const Y = h => +(P.y + (P.h1 - h) * sy).toFixed(1);
    const bottom = Y(P.h0);
    const parts = [];
    const ground = PROFILE.map(([c, h]) => `${X(c)},${Y(h)}`).join(' ');
    parts.push(`<polygon points="${ground} ${X(98)},${bottom} ${X(0)},${bottom}" class="kv-earth"/>`);
    const C = CONTROL;
    parts.push(`<polygon points="${[[C.from, C.crest], [C.notchFrom, C.crest], [C.notchFrom, C.notch], [C.notchTo, C.notch], [C.notchTo, C.crest], [C.to, C.crest], [C.to, C.base], [C.from, C.base]]
      .map(([c, h]) => `${X(c)},${Math.min(Y(h), bottom)}`).join(' ')}" class="kv-concrete"/>`);
    parts.push(`<rect x="${X(C.notchFrom)}" y="${Y(POOL)}" width="${(X(C.notchTo) - X(C.notchFrom)).toFixed(1)}" height="${(Y(C.notch) - Y(POOL)).toFixed(1)}" class="kv-water"/>`);
    parts.push(`<polyline points="${ground}" class="kv-surface"/>`);
    // RL ticks up the left, chainage along the foot.
    const step = P === WHOLE ? 1 : 0.5;
    for (let h = Math.ceil(P.h0 / step) * step; h <= P.h1 + 1e-9; h += step) {
      const t = Math.round(h * 10) / 10;
      parts.push(`<line x1="${P.x - 4}" y1="${Y(t)}" x2="${P.x}" y2="${Y(t)}" class="kv-tick"/>`
        + (P === WHOLE || Math.abs(t - Math.round(t)) < 1e-9 ? `<text x="${P.x - 6}" y="${Y(t) + 3}" text-anchor="end" class="kv-tiny">${t.toFixed(P === WHOLE ? 0 : 1)}</text>` : ''));
    }
    const cstep = P === WHOLE ? 10 : 2;
    for (let c = Math.ceil(P.c0 / cstep) * cstep; c <= P.c1; c += cstep) {
      parts.push(`<line x1="${X(c)}" y1="${bottom}" x2="${X(c)}" y2="${bottom + 4}" class="kv-tick"/><text x="${X(c)}" y="${bottom + 13}" text-anchor="middle" class="kv-tiny">${c}</text>`);
    }
    if (o.collimation != null) {
      parts.push(`<line x1="${P.x}" y1="${Y(o.collimation)}" x2="${P.x + P.w}" y2="${Y(o.collimation)}" class="kv-sight"/>`);
    }
    for (const sgt of o.sights || []) {
      const hy = Y(groundAt(sgt.from) + EYE);
      parts.push(`<line x1="${X(sgt.from)}" y1="${hy}" x2="${X(sgt.to)}" y2="${hy}" class="kv-sight"/>`);
    }
    for (const c of o.staffs || []) {
      const g = groundAt(c), w = Math.max(3, 0.08 * sx);
      parts.push(`<rect x="${(X(c) - w / 2).toFixed(1)}" y="${Y(g + STAFF)}" width="${w.toFixed(1)}" height="${(Y(g) - Y(g + STAFF)).toFixed(1)}" class="kv-staff"/>`);
    }
    for (const c of o.setups || []) {
      const g = groundAt(c), x = X(c), top = Y(g + EYE), gy = Y(g), spread = P === WHOLE ? 5 : 9;
      parts.push(`<g class="kv-level"><line x1="${x}" y1="${top + 3}" x2="${x - spread}" y2="${gy}" class="kv-leg"/>`
        + `<line x1="${x}" y1="${top + 3}" x2="${x + spread}" y2="${gy}" class="kv-leg"/>`
        + `<rect x="${x - 6}" y="${top - 3}" width="12" height="6" rx="1.5" class="kv-inst"/></g>`);
    }
    for (const t of o.labels || []) parts.push(`<text x="${X(t.ch)}" y="${Y(groundAt(t.ch) + EYE) - 7}" text-anchor="middle" class="kv-num">${esc(t.text)}</text>`);
    if (o.features) PROFILE.forEach(([c, h]) => parts.push(`<circle cx="${X(c)}" cy="${Y(h)}" r="2.6" class="kv-feature"/>`));
    for (const p of o.points || []) parts.push(`<circle cx="${X(p.ch)}" cy="${Y(p.rl)}" r="3.4" class="kv-pt"/>`);
    return `<g clip-path="url(#kv-clip-${id})">${parts.join('')}</g>`;
  }

  function sectionSvg(o) {
    const W = WHOLE, C = CLOSE, X = c => W.x + (c - W.c0) * W.w / (W.c1 - W.c0), Yw = h => W.y + (W.h1 - h) * W.h / (W.h1 - W.h0);
    const XC = c => C.x + (c - C.c0) * C.w / (C.c1 - C.c0), YC = h => C.y + (C.h1 - h) * C.h / (C.h1 - C.h0);
    const clip = (P, k) => `<clipPath id="kv-clip-${o.id}-${k}"><rect x="${P.x - 40}" y="${P.y - 16}" width="${P.w + 44}" height="${P.h + 34}"/></clipPath>`;
    const notes = [];
    // BM01 and the banks, on the whole section.
    notes.push(`<path d="M${X(BM.ch).toFixed(1)} ${(Yw(BM.rl) - 1).toFixed(1)} l-4 -8 h8 z" class="kv-bm"/>`
      + `<text x="${X(BM.ch).toFixed(1)}" y="${(Yw(BM.rl) - 12).toFixed(1)}" text-anchor="middle" class="kv-lab">BM01</text>`
      + `<text x="${W.x}" y="${W.y - 6}" class="kv-lab">LB · ch 0</text><text x="${W.x + W.w}" y="${W.y - 6}" text-anchor="end" class="kv-lab">RB · ch 98</text>`
      + `<text x="${X(53)}" y="${Yw(99.3)}" class="kv-tiny">concrete control</text>`);
    // The close-up's frame on the whole section, and leaders down to the close-up.
    notes.push(`<rect x="${X(C.c0).toFixed(1)}" y="${Yw(C.h1).toFixed(1)}" width="${(X(C.c1) - X(C.c0)).toFixed(1)}" height="${(Yw(C.h0) - Yw(C.h1)).toFixed(1)}" class="kv-frame"/>`
      + `<line x1="${X(C.c0).toFixed(1)}" y1="${Yw(C.h0).toFixed(1)}" x2="${C.x}" y2="${C.y - 14}" class="kv-frame"/>`
      + `<line x1="${X(C.c1).toFixed(1)}" y1="${Yw(C.h0).toFixed(1)}" x2="${C.x + C.w}" y2="${C.y - 14}" class="kv-frame"/>`);
    // Names on the close-up.
    notes.push(`<text x="${XC(40.5)}" y="${YC(CONTROL.crest) + 14}" text-anchor="middle" class="kv-tiny">crest 100.6</text>`
      + `<text x="${XC(47.5)}" y="${YC(CONTROL.crest) + 14}" text-anchor="middle" class="kv-tiny">crest 100.6</text>`
      + `<text x="${XC(44)}" y="${YC(CONTROL.notch) + 14}" text-anchor="middle" class="kv-tiny">notch 100.0</text>`
      + `<text x="${C.x + C.w}" y="${C.y + C.h + 27}" text-anchor="end" class="kv-tiny">the control close up · chainage ${C.c0}–${C.c1} · vertical ×2</text>`
      + `<text x="${W.x + W.w}" y="${W.y + W.h + 27}" text-anchor="end" class="kv-tiny">whole section · vertical ×8</text>`);
    if ((o.staffs || []).length) {
      const c = o.staffs.find(s => s >= C.c0 && s <= C.c1);
      if (c != null) notes.push(`<text x="${XC(c) + 6}" y="${Math.max(YC(groundAt(c) + STAFF), C.y) + 10}" class="kv-tiny">4 m staff</text>`);
    }
    if (o.collimation != null) {
      notes.push(`<text x="${W.x + W.w - 2}" y="${Yw(o.collimation) - 3}" text-anchor="end" class="kv-tiny">line of sight ${o.collimation.toFixed(4)}</text>`);
    }
    const whole = sectionPanel(o, W, `${o.id}-w`), close = sectionPanel(o, C, `${o.id}-c`);
    return `<svg viewBox="0 0 400 362" role="img" aria-labelledby="kv-s-${o.id}" class="kv-svg">
      <title id="kv-s-${o.id}">${esc(o.title)}</title><defs>${clip(W, 'w')}${clip(C, 'c')}</defs>${whole}${close}${notes.join('')}</svg>`;
  }

  // The telescope on an E-face: 1 cm bars, an E every 5 cm, three hairs.
  function staffSvg(s) {
    const c = s.c, cy = 130, px = 1000;                    // 1 mm = 1 px
    const y = m => cy - (m - c) * px;
    const parts = [];
    parts.push(`<rect x="100" y="0" width="60" height="260" class="kv-face"/>`);
    const lo = Math.floor((c - 0.14) * 100), hi = Math.ceil((c + 0.14) * 100);
    for (let k = Math.max(0, lo); k <= hi; k++) {
      const p = ((k % 10) + 10) % 10, top = y((k + 1) / 100), h = 10;
      if (p <= 4) {
        parts.push(`<rect x="100" y="${top.toFixed(1)}" width="7" height="${h}" class="kv-bar"/>`);
        if (p % 2 === 0) parts.push(`<rect x="100" y="${top.toFixed(1)}" width="30" height="${h}" class="kv-bar"/>`);
      } else {
        parts.push(`<rect x="153" y="${top.toFixed(1)}" width="7" height="${h}" class="kv-bar"/>`);
        if (p % 2 === 1) parts.push(`<rect x="130" y="${top.toFixed(1)}" width="30" height="${h}" class="kv-bar"/>`);
      }
      if (p === 0) parts.push(`<text x="94" y="${(y(k / 100 + 0.03) + 4).toFixed(1)}" text-anchor="end" class="kv-staffnum">${(k / 100).toFixed(1)}</text>`);
    }
    const st = s.d / 200 * px;
    const hair = `<line x1="20" y1="${cy}" x2="240" y2="${cy}" class="kv-hair"/><line x1="130" y1="16" x2="130" y2="244" class="kv-hair kv-hair-v"/>
      <line x1="108" y1="${(cy - st).toFixed(1)}" x2="152" y2="${(cy - st).toFixed(1)}" class="kv-hair"/>
      <line x1="108" y1="${(cy + st).toFixed(1)}" x2="152" y2="${(cy + st).toFixed(1)}" class="kv-hair"/>`;
    return `<svg viewBox="0 0 260 260" role="img" aria-labelledby="kv-staff-t" class="kv-svg kv-scope-svg">
      <title id="kv-staff-t">Telescope view of an E-face staff behind three hairs: read the centre hair, and the upper and lower hairs for the distance</title>
      <defs><clipPath id="kv-scope-clip"><circle cx="130" cy="130" r="118"/></clipPath></defs>
      <g clip-path="url(#kv-scope-clip)"><rect x="0" y="0" width="260" height="260" class="kv-sky"/>${parts.join('')}${hair}</g>
      <circle cx="130" cy="130" r="118" class="kv-scope"/></svg>`;
  }

  // The circular bubble seen in the mirror, and the three foot screws.
  const SCREWS = { A: [0, -1], B: [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], C: [-Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)] };
  const RING = 26, BUB = 18;
  const centred = b => Math.hypot(b.x, b.y) + BUB <= RING + 1e-9;
  function newBubbleAt() {
    const a = Math.random() * Math.PI * 2, r = 26 + Math.random() * 16;
    return { x: Math.round(r * Math.cos(a)), y: Math.round(r * Math.sin(a)) };
  }
  function bubbleNow() { if (!bubble) bubble = newBubbleAt(); return bubble; }
  function bubbleWords(b) {
    if (centred(b)) return 'The bubble sits inside the ring.';
    let best = 'A', most = -Infinity;
    for (const [k, [ux, uy]] of Object.entries(SCREWS)) { const dot = b.x * ux + b.y * uy; if (dot > most) { most = dot; best = k; } }
    const far = Math.hypot(b.x, b.y) > 34 ? 'well off centre' : 'just off centre';
    return `The bubble is ${far}, towards screw ${best}.`;
  }
  function bubbleSvg() {
    const b = bubbleNow();
    const screw = ([k, [ux, uy]]) => `<g><circle cx="${(100 + ux * 84).toFixed(1)}" cy="${(100 + uy * 84).toFixed(1)}" r="11" class="kv-screw"/>
      <text x="${(100 + ux * 84).toFixed(1)}" y="${(100 + uy * 84 + 4).toFixed(1)}" text-anchor="middle" class="kv-lab">${k}</text></g>`;
    return `<svg viewBox="0 0 200 200" role="img" aria-labelledby="kv-bub-t" class="kv-svg kv-bubble-svg">
      <title id="kv-bub-t">Circular level: ${esc(bubbleWords(b))}</title>
      <circle cx="100" cy="100" r="62" class="kv-vial"/>
      <circle cx="${100 + b.x}" cy="${100 + b.y}" r="${BUB}" class="kv-bubble"/>
      <circle cx="100" cy="100" r="${RING}" class="kv-ring"/>
      ${Object.entries(SCREWS).map(screw).join('')}</svg>`;
  }

  // LevelBook on a phone, holding the policy.
  function phoneSvg() {
    const rows = policyRows(policy);
    return `<svg viewBox="0 0 220 230" role="img" aria-labelledby="kv-ph-t" class="kv-svg kv-phone-svg">
      <title id="kv-ph-t">The level book's policy page: ${policy ? 'saved' : 'not set yet'}</title>
      <rect x="40" y="6" width="140" height="218" rx="16" class="kv-phone"/>
      <rect x="50" y="26" width="120" height="180" rx="4" class="kv-screen"/>
      <text x="110" y="44" text-anchor="middle" class="kv-lab">Practice policy</text>
      ${rows.map(([k, v], i) => `<text x="58" y="${70 + i * 34}" class="kv-tiny">${esc(k)}</text>
        <text x="58" y="${84 + i * 34}" class="kv-num">${policy ? esc(v.length > 20 ? `${v.slice(0, 19)}…` : v) : '—'}</text>`).join('')}
    </svg>`;
  }

  function fig(svg, cap) {
    return `<figure class="kv-fig">${svg}${cap ? `<figcaption class="small">${cap}</figcaption>` : ''}</figure>`;
  }
  function quizHtml(id) {
    const q = QUIZ[id], p = picked[id];
    return `<fieldset class="kv-quiz" id="kv-q-${id}"><legend>${esc(q.q)}</legend><div class="kv-opts">
      ${q.options.map((o, i) => `<button type="button" class="kv-opt" aria-pressed="${p === i}" onclick="KbLevel.answer('${id}', ${i})">${esc(o)}</button>`).join('')}
      </div><p class="kv-fb" id="kv-fb-${id}" role="status">${p == null ? '' : quizFeedback(id, p)}</p></fieldset>`;
  }
  function quizFeedback(id, i) {
    const q = QUIZ[id];
    return i === q.answer ? `${good('Right.')} ${esc(q.why)}` : `${bad('Not that one.')} Try another.`;
  }
  function field(id, label, value = '', unit = '') {
    return `<div class="kv-field"><label for="${id}">${label}</label>
      <span class="kv-in"><input id="${id}" inputmode="decimal" autocomplete="off" value="${escAttr(value)}">${unit ? `<span class="small">${unit}</span>` : ''}</span></div>`;
  }
  function verdictSelect(id, options) {
    return `<div class="kv-field"><label for="${id}">Verdict</label><select id="${id}">
      <option value="">Choose…</option>${options.map(o => `<option>${esc(o)}</option>`).join('')}</select></div>`;
  }

  // ── The steps ──────────────────────────────────────────────────────────────
  function stepBrief() {
    return `<div class="kv-cols">${fig(sectionSvg({ id: 'brief', title: 'The weir section from the left bank (chainage 0) to the right (chainage 98), with BM01 on the left bank and the low-flow notch in the middle', features: true }),
      'The practice site, looking downstream. Vertical scale stretched; dots mark the twelve points that give the section its shape.')}
      <div class="kv-text">
        <p>The game puts you on a fictional river practice site with a Sokkia SDL50 digital level, a 4 m staff with a barcode face
          on one side and an E-face on the other, and a level book on your phone. There are two jobs today — a <strong>two-peg
          test</strong> and a <strong>cross-section of the weir</strong> — and either can be done first.</p>
        <div class="kv-ref"><h4>Site reference</h4>
          <p class="small">Local practice grid, in metres — not a real survey.<br>
          LB: E 1000, N 1000. Chainage 0 m.<br>RB: E 1098, N 1000. Chainage 98 m.<br>
          BM01: E 1008, N 1000, on the transect at chainage 8. RL ${f3(BM.rl)} m (practice datum).<br>
          Chainage runs from the left bank to the right, looking downstream.</p></div>
        <p>The rule of the day: nothing is filled in for you. You place the kit, level it, read the staff and type what you read;
          the book does the sums, and at the end a review compares what you booked with what you actually did.</p>
      </div></div>
      <div class="kv-task"><h4>Before you head out</h4>${quizHtml('brief')}</div>`;
  }

  function stepPolicy() {
    const p = policy || {};
    const draft = policy ? '' : `
      <form class="kv-form" onsubmit="event.preventDefault(); KbLevel.savePolicy()">
        ${field('kv-p-org', 'Organisation or policy name', '')}
        <fieldset class="kv-fs"><legend>Two-peg test</legend>
          <div class="kv-field"><label for="kv-p-pbasis">Tolerance basis</label>
            <select id="kv-p-pbasis" onchange="KbLevel.policyBasis()"><option value="fixed">Fixed</option><option value="per10">Per 10 m</option></select></div>
          ${field('kv-p-plimit', 'Two-peg tolerance', '', '<span id="kv-p-punit">mm</span>')}
          ${field('kv-p-spacing', 'Minimum peg spacing', '', 'm')}
        </fieldset>
        <fieldset class="kv-fs"><legend>Cross-section</legend>
          <div class="kv-field"><label for="kv-p-sbasis">Misclose rule</label>
            <select id="kv-p-sbasis" onchange="KbLevel.policyBasis()">
              <option value="fixed">Fixed allowance</option><option value="change-points">(1 + √change points) mm</option>
              <option value="fixed-or-change-points">Larger of fixed or change-point allowance</option>
              <option value="distance">Coefficient × √distance (km)</option></select></div>
          <div id="kv-p-swrap">${field('kv-p-slimit', '<span id="kv-p-slabel">Survey tolerance</span>', '', '<span id="kv-p-sunit">mm</span>')}</div>
        </fieldset>
        <div class="button-group"><button type="submit" class="primary">Start practice</button>
          <button type="button" onclick="KbLevel.fillStarting()">Use Flood-Net's starting limits</button></div>
        <p class="kv-fb" id="kv-fb-policy" role="status"></p>
      </form>`;
    const saved = policy ? `<dl class="kv-dl">${policyRows(p).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      <p>To use different limits, start a new practice. <button type="button" onclick="KbLevel.newPractice()">New practice</button></p>` : '';
    return `<div class="kv-cols">${fig(phoneSvg(), 'The book asks for your limits before you go into the field.')}
      <div class="kv-text">
        <p>Use your organisation's limits, or a policy supplied by your trainer. The game will not let you start without one, and a
          blank box never means zero — a limit you have not written down is not a limit.</p>
        <ul>
          <li><strong>Two-peg test:</strong> a tolerance in millimetres, either fixed or per 10 m of peg spacing, and a minimum peg spacing.</li>
          <li><strong>Cross-section misclose:</strong> a fixed allowance; (1 + √change points) mm; the larger of the two; or a coefficient
            × √distance in km, the distance being the backsights and foresights you booked.</li>
        </ul>
        <p>Once a test starts, the rule it started under stays with it. To change a limit you start again.</p>
      </div></div>
      <div class="kv-task"><h4>${policy ? 'Your saved policy' : 'Practice: enter your policy'}</h4>${saved}${draft}</div>`;
  }

  function stepLevel() {
    const b = bubbleNow();
    const btn = (k, dir) => `<button type="button" onclick="KbLevel.turn('${k}', ${dir})" aria-label="Turn screw ${k} ${dir > 0 ? 'clockwise' : 'anticlockwise'}">${k} ${dir > 0 ? '↻' : '↺'}</button>`;
    return `<div class="kv-cols"><div id="kv-bubble-fig">${fig(bubbleSvg(), 'The bubble in the mirror, and the three foot screws.')}</div>
      <div class="kv-text">
        <p>For the two-peg test, put the level between your pegs; for the section, at a sensible spot on the transect. Keep it clear
          of the staff, and remember the telescope will not focus closer than 1.5 m.</p>
        <ol>
          <li>Open the mirror and turn the three foot screws until the bubble sits inside the ring. Turning a screw clockwise
            raises that foot and moves the bubble towards it.</li>
          <li>Focus the crosshairs with the eyepiece first, then the staff with the large side knob.</li>
          <li>Aim at the staff with the fine-motion knob.</li>
        </ol>
        <p>Checking the bubble checks levelling only — judge focus by what you can see. The compensator takes up a small leftover
          tilt, but a reading taken with the bubble off centre is flagged in the review: <em>“The bubble was not centred when the
          reading was taken.”</em></p>
      </div></div>
      <div class="kv-task"><h4>Practice: centre the bubble</h4>
        <div class="kv-screws" role="group" aria-label="Foot screws">${['A', 'B', 'C'].map(k => `<div class="button-group">${btn(k, 1)}${btn(k, -1)}</div>`).join('')}</div>
        <p class="small" id="kv-bub-words" aria-live="polite">${esc(bubbleWords(b))}</p>
        <div class="button-group"><button type="button" class="primary" onclick="KbLevel.checkBubble()">Check bubble</button>
          <button type="button" onclick="KbLevel.newBubble()">Reset setup</button></div>
        <p class="kv-fb" id="kv-fb-level" role="status">${bubbleChecked}</p></div>`;
  }

  function stepRead() {
    const s = SIGHTS[sightIdx];
    const up = s.c + s.d / 200, lo = s.c - s.d / 200;
    return `<div class="kv-cols">${fig(staffSvg(s), esc(s.what) + '.')}
      <div class="kv-text">
        <p><strong>Digital (the barcode face).</strong> Press PWR, then ESC for the measurement screen. Focus the crosshairs, then the
          staff; aim with fine motion; press the blue side button. The level shows <strong>Rh</strong> (staff reading) and
          <strong>Hd</strong> (horizontal distance) — book both. It reads from 1.6 m to 100 m.</p>
        <p><strong>Manual (the E-face).</strong> Turn the staff to its E-face. Read the centre hair in metres. For the distance,
          take the lower stadia hair from the upper and multiply by 100.</p>
        <p class="kv-eq">distance = (upper − lower) × 100</p>
        <p class="small">The game marks a manual reading right within 1 mm of the sight, and a distance within 0.2 m — reading each
          stadia hair to the millimetre is worth up to 0.2 m. To replace a reading, clear the box and read again; editing a
          number keeps the original sight as its evidence.</p>
      </div></div>
      <div class="kv-task"><h4>Practice: read this sight (${sightIdx + 1} of ${SIGHTS.length})</h4>
        <div class="kv-grid">${field('kv-r-c', 'Centre reading', '', 'm')}${field('kv-r-d', 'Horizontal distance', '', 'm')}</div>
        <div class="button-group"><button type="button" class="primary" onclick="KbLevel.checkRead()">Book it</button>
          <button type="button" onclick="KbLevel.newSight()">Another sight</button></div>
        <details class="kv-help"><summary>Read the hairs for me</summary>
          <p class="small">Upper hair ${f3(up)} m, centre ${f3(s.c)} m, lower ${f3(lo)} m (to the millimetre).</p></details>
        <p class="kv-fb" id="kv-fb-read" role="status"></p></div>`;
  }

  function pegTable(p, which) {
    const rows = which === 1 ? [['A', p.a1, p.da1], ['B', p.b1, p.db1]] : [['A', p.a2, p.da2], ['B', p.b2, p.db2]];
    return `<div class="table-wrap" role="region" aria-label="Set-up ${which} readings" tabindex="0"><table class="kv-table">
      <caption>Set-up ${which}${which === 1 ? ', midway' : `, ${NEAR} m from A`}</caption>
      <thead><tr><th scope="col">Peg</th><th scope="col">Staff reading (m)</th><th scope="col">Horizontal distance (m)</th></tr></thead>
      <tbody>${rows.map(([k, r, d]) => `<tr><td>${k}</td><td class="kv-mono">${f3(r)}</td><td class="kv-mono">${L.fmt(d, 1)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function spacingButtons() {
    const p = pegNow();
    return `<div class="button-group" role="group" aria-label="Peg spacing">${PEG_SPACINGS.map(S =>
      `<button type="button" aria-pressed="${p.S === S}" onclick="KbLevel.pegSpacing(${S})">Pegs ${S} m apart</button>`).join('')}</div>`;
  }
  function pegDiagram(n) {
    const p = pegNow();
    if (typeof TwoPeg === 'undefined' || !TwoPeg.diagram) return '';
    const tilt = pegResult().r.tilt || 0;
    return n === 1 ? fig(TwoPeg.diagram(1, p.a1, p.b1, 0), 'Set-up 1, midway: equal sights, so any tilt of the line of sight cancels out of A − B.')
      : fig(TwoPeg.diagram(2, p.a2, p.b2, tilt), `Set-up 2, ${NEAR} m from A: unequal sights, so a tilt shows (exaggerated).`);
  }

  function stepPeg1() {
    const p = pegNow();
    return `<div class="kv-cols">${pegDiagram(1)}
      <div class="kv-text">
        <p>Two fixed pegs; the same pegs read from two instrument positions. The check uses the actual distances.</p>
        <ol>
          <li>Place peg A and peg B on firm ground.</li>
          <li>Set the level between A and B, on their line, near the midpoint. The game checks you are within 1 m of equal sight
            lengths and within 0.15 m of the line between the pegs.</li>
          <li>Stand the staff on the named peg — not beside it — and read A, then B. Book each reading with its distance.</li>
        </ol>
        <p>The book works out the <strong>peg spacing</strong> from these two horizontal distances, and holds it against your
          policy's minimum. The first difference is <strong>A minus B</strong>: from the middle, a tilted line of sight errs the same
          on both, so this difference is the true one.</p>
      </div></div>
      <div class="kv-task"><h4>Practice: book set-up 1</h4>
        <p class="small">Choose where the pegs go — 24 m is the game's own checked layout, 30 m the SDL50's own adjustment
          layout, 50 m what Flood-Net's Survey Guide suggests. A new choice gives new readings.</p>
        ${spacingButtons()}
        ${pegTable(p, 1)}
        <div class="kv-grid">${field('kv-p1-d', 'Setup 1: A minus B', '', 'm')}${field('kv-p1-s', 'Peg spacing', '', 'm')}</div>
        <div class="button-group"><button type="button" class="primary" onclick="KbLevel.checkPeg1()">Check</button></div>
        <p class="kv-fb" id="kv-fb-peg1" role="status"></p></div>`;
  }

  function stepPeg2() {
    const p = pegNow();
    const opts = ['Within limit', 'Outside limit', 'Review peg spacing', 'No tolerance recorded'];
    const tol = pegTolerance(p.S);
    return `<div class="kv-cols">${pegDiagram(2)}
      <div class="kv-text">
        <p>Keep both pegs fixed. Move the level close to A or B and read A, then B again.</p>
        <ul>
          <li>The second set-up must move at least 1 m, sit between the pegs within the nearest quarter of their spacing, and keep
            both sights at least 5 m.</li>
          <li><strong>Misclose</strong> = (set-up 2 A − B) − (set-up 1 A − B), in millimetres, sign kept.</li>
          <li>It is held to your two-peg tolerance — fixed, or per 10 m × spacing ÷ 10. A spacing under your minimum gives
            <em>Review peg spacing</em>; no tolerance recorded gives <em>No tolerance recorded</em>.</li>
          <li><strong>Collimation</strong>, in mm per 10 m of sight, is the misclose over the change in signed sight-distance
            difference, (dA2 − dB2) − (dA1 − dB1). That change has to be at least 1 m, or the geometry tells you nothing.</li>
        </ul>
        <p class="small">The SDL50 has its own version in its Adjust programme: position A with the staffs 15 m either side, then
          position B 3 m from one and 33 m from the other; it shows the difference and can store a correction.</p>
      </div></div>
      <div class="kv-task"><h4>Practice: finish the test</h4>
        <p class="small">Set-up 1: A ${f3(p.a1)}, B ${f3(p.b1)} at ${L.fmt(p.da1, 1)} m each — pegs ${p.S} m apart. Your policy:
          ${tol == null ? 'none saved (step 2)' : `${L.fmt(tol, 1)} mm${policy.twoPegBasis === 'per10' ? ` (${Number(policy.twoPegLimit)} mm per 10 m)` : ''}, minimum spacing ${Number(policy.minimumPegSpacing)} m`}.</p>
        ${pegTable(p, 2)}
        <div class="kv-grid">${field('kv-p2-d', 'Setup 2: A minus B', '', 'm')}${field('kv-p2-m', 'Misclose (setup 2 minus 1)', '', 'mm')}${verdictSelect('kv-p2-v', opts)}</div>
        <div class="button-group"><button type="button" class="primary" onclick="KbLevel.checkPeg2()">Save test</button>
          <button type="button" onclick="KbLevel.pegSpacing(${p.S})">New readings</button></div>
        <p class="kv-fb" id="kv-fb-peg2" role="status"></p></div>`;
  }

  function stepPlan() {
    const hpc = groundAt(26) + EYE;
    return `<div class="kv-cols">${fig(sectionSvg({ id: 'plan', title: 'The level at chainage 26 with its line of sight drawn across the section, and a 4 m staff standing in the low-flow notch, its top below the line', setups: [26], staffs: [44], collimation: hpc, features: true }),
      'From chainage 26 the line of sight passes above the top of a 4 m staff stood in the notch.')}
      <div class="kv-text">
        <p>The section's shape is twelve points: the two ends, a natural-ground hollow on each bank, the bank tops, where each bank
          meets the concrete, and the four corners of the low-flow notch (each wall's top and inside corner count separately).</p>
        <p>Each sight after the opening is booked with a direction — towards the right bank or towards the left — and a distance.
          The book works chainage out from BM01's: the opening backsight fixes where the level stands, and every other sight is
          that plus or minus its distance.</p>
        <p>The game's level sights ${f3(EYE)} m above the ground it stands on. Set up on the left bank at chainage 26 (ground
          ${f3(groundAt(26))} m) and the height of collimation is <strong>${f4(hpc)} m</strong>. A point reads
          HPC − RL — and the staff is only ${STAFF} m long.</p>
      </div></div>
      <div class="kv-task"><h4>Practice: which points can you read from chainage 26?</h4>
        <fieldset class="kv-fs"><legend class="small">Tick each one whose reading lands on the 4 m staff.</legend>
        <ul class="kv-checks">${PROFILE.map(([c, h], i) => `<li><input type="checkbox" id="kv-pl-${i}"><label for="kv-pl-${i}">${esc(FEATURES[i])}
          <span class="small">ch ${c}, RL ${f3(h)}</span></label> <span id="kv-pl-m-${i}"></span></li>`).join('')}</ul></fieldset>
        <div class="button-group"><button type="button" class="primary" onclick="KbLevel.checkPlan()">Check</button></div>
        <p class="kv-fb" id="kv-fb-plan" role="status"></p></div>`;
  }

  function stepBook() {
    const doc = routeDoc(CLOSE_READS[0]);
    const r = doc.rows;
    const cell = v => (v == null ? '' : `<td class="kv-mono">${esc(String(v))}</td>`);
    return `<div class="kv-cols">${fig(sectionSvg({ id: 'book', title: 'The checked route: the level at chainage 26 reads BM01 and the notch corner; moved to chainage 38 it reads the corner and the right concrete edge, then returns to 26 and closes on BM01', setups: [26, 38], staffs: [8, 43, 50], sights: [{ from: 26, to: 8 }, { from: 26, to: 43 }, { from: 38, to: 50 }], labels: [{ ch: 26, text: '1, 3' }, { ch: 38, text: '2' }] }),
      'Set-ups 1 and 3 at chainage 26, set-up 2 at chainage 38. The change point is the top of the left low-flow wall.')}
      <div class="kv-text">
        <p>This is the run the game's own checks use — a mix of digital readings (to 0.1 mm) and E-face readings (to the millimetre):</p>
        <ol>
          <li>Set-up 1 at chainage 26: backsight on BM01; foresight to the top of the left low-flow wall (chainage 43), a change point.</li>
          <li>Set-up 2 at chainage 38: backsight on that corner; an intermediate on the right concrete edge (chainage 50); a
            foresight back to the corner.</li>
          <li>Set-up 3, back at chainage 26: backsight on the corner; foresight onto BM01, booking its RL as the closing reference.</li>
        </ol>
        <p>The book takes each sight as its own line; Flood-Net's sheet puts a change point's foresight and backsight on one row —
          same numbers. Height of collimation = RL + backsight; each RL = that height − the sight. Once the closing foresight is
          in, the run is closed: <em>“This run is closed. Use the level book to correct a reading.”</em> Corrections keep their audit trail.</p>
      </div></div>
      <div class="kv-task"><h4>Practice: reduce the run</h4>
        <div class="table-wrap" role="region" aria-label="The run to reduce" tabindex="0"><table class="kv-table kv-book">
          <caption>The checked route, BM01 at ${f3(BM.rl)} m</caption>
          <thead><tr><th scope="col">Row</th><th scope="col">Point</th><th scope="col">Direction</th><th scope="col">Dist (m)</th>
            <th scope="col">BS</th><th scope="col">IS</th><th scope="col">FS</th><th scope="col">RL (m)</th><th scope="col">Mark</th></tr></thead>
          <tbody>${r.map((row, i) => `<tr><td>${i + 1}</td><td>${esc(ROUTE_INFO[i].note)}</td><td>${ROUTE_INFO[i].dir}</td><td class="kv-mono">${ROUTE_INFO[i].d}</td>
            ${cell(row.bs) || '<td></td>'}${cell(row.is) || '<td></td>'}${cell(row.fs) || '<td></td>'}
            <td>${i === 0 ? `<span class="kv-mono">${f3(BM.rl)}</span>` : `<input id="kv-bk-rl-${i}" class="kv-num-in" inputmode="decimal" autocomplete="off" aria-label="RL of row ${i + 1}">`}</td>
            <td id="kv-bk-m-${i}"></td></tr>`).join('')}</tbody></table></div>
        <div class="kv-grid">${field('kv-bk-ch', 'Chainage of row 3 (the intermediate)', '', 'm')}</div>
        <div class="button-group"><button type="button" class="primary" onclick="KbLevel.checkBook()">Check</button></div>
        <div class="kv-fb" id="kv-fb-book" role="status"></div></div>`;
  }

  function stepClose() {
    const red = L.reduce(routeDoc(CLOSE_READS[closeIdx]));
    const allow = sectionAllowance(red.cps, ROUTE_KM);
    return `<div class="kv-cols">${fig(sectionSvg({ id: 'close', title: 'Set-up 3 at chainage 26 reading back onto BM01 to close the loop', setups: [26], staffs: [8, 43], sights: [{ from: 26, to: 8 }, { from: 26, to: 43 }] }),
      'Closing the loop: the last foresight goes back onto the benchmark you opened on.')}
      <div class="kv-text">
        <p><strong>Misclose</strong> = the closing RL − BM01's ${f3(BM.rl)} m. Without a closing foresight on a known reference there
          is nothing to check: <em>“Finish on a known reference to check misclose.”</em></p>
        <p>The arithmetic check comes first: ΣBS − ΣFS must equal the closing RL − the opening RL, or something was booked wrong
          (<em>Review readings</em>). Then the misclose is held to your rule:</p>
        <ul>
          <li>Fixed: your figure in mm.</li>
          <li>(1 + √change points) mm — a change point counts when a backsight was taken from it. This run has two.</li>
          <li>Larger of the two.</li>
          <li>Coefficient × √km, the km being the backsights and foresights booked (intermediates do not count): here
            ${L.fmt(ROUTE_KM, 3)} km.</li>
        </ul>
        <p>Outside the limit? Look for a booking slip first; then re-read set-up by set-up through the same change points.</p>
      </div></div>
      <div class="kv-task"><h4>Practice: close it</h4>
        <p class="small">${closeIdx === 0 ? 'The closing foresight as the game reads it' : 'The same run, but the closing foresight was read badly'}:
          <strong class="kv-mono">${esc(CLOSE_READS[closeIdx])}</strong> m. ΣBS ${f4(red.sums.bs)}, ΣFS ${f4(red.sums.fs)}.
          Your rule: ${policy ? esc(policyRows(policy)[3][1]) : 'none saved (step 2)'}.</p>
        <div class="kv-grid">${field('kv-cl-m', 'Misclose', '', 'mm')}${allow == null ? '' : field('kv-cl-a', 'Allowance', '', 'mm')}
          ${verdictSelect('kv-cl-v', ['Within limit', 'Outside limit', 'No tolerance recorded'])}</div>
        <div class="button-group"><button type="button" class="primary" onclick="KbLevel.checkClose()">Complete and save</button>
          <button type="button" onclick="KbLevel.newClose()">Another closing sight</button></div>
        <div class="kv-fb" id="kv-fb-close" role="status"></div></div>`;
  }

  function stepReview() {
    const red = L.reduce(routeDoc(CLOSE_READS[0]));
    const chain = [8, 43, 50, 43, 8];
    const pts = red.rows.map((o, i) => ({ ch: chain[i], rl: o.rl })).filter(p => p.rl != null);
    return `<div class="kv-cols">${fig(sectionSvg({ id: 'review', title: 'Your section: the terrain with its twelve shape points hollow, and the points from your book filled — BM01, the left low-flow top corner and the right concrete edge', features: true, points: pts }),
      'Grey: terrain. Filled: your book. Hollow: shape points. Vertical scale stretched.')}
      <div class="kv-text">
        <p>At the end the game draws your book over the terrain and lists what it found. Two things are checked separately:</p>
        <ul>
          <li><strong>Coverage</strong> — was the staff within 0.15 m across and 0.03 m up or down of each of the twelve shape
            points? Repeat sights at a change point count once. The checked route visits three: BM01's hollow, the left low-flow
            top corner and the right concrete edge. A full section visits all twelve; a point on a straight stretch between two
            already does nothing — its ends already define the shape.</li>
          <li><strong>The book</strong> — each line against the sight it came from: the reading and distance copied right, metres,
            the bank direction, the bubble centred, nothing moved during the reading or within a set-up, the change point the
            same spot both times, the run opened and closed on BM01, no instrument reading used twice.</li>
        </ul>
        <p>These are practice placement allowances, not survey accuracy limits, and no overall pass or fail is given.</p>
      </div></div>
      <div class="kv-task"><h4>Practice: what would the review say?</h4>${['r1', 'r2', 'r3', 'r4'].map(quizHtml).join('')}
        <p>Done for the day. In Flood-Net the same work is real: <button type="button" class="link-btn" onclick="switchTab('twopeg')">the Two-Peg Test</button>,
          <button type="button" class="link-btn" onclick="switchTab('levels')">a Level Survey</button>, and
          <button type="button" class="link-btn" onclick="switchTab('surveyguide')">How to Survey</button> for the refresher.</p></div>`;
  }

  const BODY = { brief: stepBrief, policy: stepPolicy, level: stepLevel, read: stepRead, peg1: stepPeg1, peg2: stepPeg2,
    plan: stepPlan, book: stepBook, close: stepClose, review: stepReview };

  function stepHtml() {
    const s = STEPS[step];
    return `<section class="panel kv-step" aria-labelledby="kv-step-h">
      <h3 id="kv-step-h" tabindex="-1"><span class="kv-count">Step ${step + 1} of ${STEPS.length}</span> ${esc(s.title)}</h3>
      ${BODY[s.id]()}
      <div class="button-row kv-nav">
        <button type="button" onclick="KbLevel.back()" ${step === 0 ? 'disabled' : ''}>← Back</button>
        <button type="button" class="primary" onclick="KbLevel.next()" ${step === STEPS.length - 1 ? 'disabled' : ''}>Next →</button>
      </div></section>`;
  }
  function progressHtml() {
    return `<ol class="kv-progress">${STEPS.map((s, i) => `<li><button type="button" class="kv-pstep${i === step ? ' is-current' : ''}${done[s.id] ? ' is-done' : ''}"
      ${i === step ? 'aria-current="step"' : ''} onclick="KbLevel.go(${i})"><span class="kv-pnum" aria-hidden="true">${done[s.id] ? '✓' : i + 1}</span>
      <span>${esc(s.title)}</span>${done[s.id] ? '<span class="sr-only"> (done)</span>' : ''}</button></li>`).join('')}</ol>`;
  }

  function render() {
    load();
    return `<div class="page kv-page" style="--page-max:960px"><h2 class="sr-only">Levelling Day</h2><div class="stack">
      <section class="panel kv-intro">
        <h3>A day on the level</h3>
        <p>A day's levelling practice, one step at a time: set your limits, level the instrument, read the staff, run a two-peg
          test, then run, book and close a cross-section of a weir. Each step has a drawing and a short task, marked as you go.
          The figures are the game's own.</p>
        <nav aria-label="Steps of the day" id="kv-prog">${progressHtml()}</nav>
      </section>
      <div id="kv-step">${stepHtml()}</div>
      ${KnowledgeBase.credit('level')}
    </div></div>`;
  }

  function paint(focus) {
    const p = $('kv-prog'), s = $('kv-step');
    if (p) p.innerHTML = progressHtml();
    if (s) s.innerHTML = stepHtml();
    if (STEPS[step].id === 'policy' && !policy) policyBasis();
    if (focus) { const h = $('kv-step-h'); if (h) h.focus(); }
  }

  function init() {
    load();
    paint(false);
  }

  // ── Doing things ───────────────────────────────────────────────────────────
  function go(i) {
    if (!(i >= 0 && i < STEPS.length)) return;
    step = i;
    save();
    paint(true);
  }
  function next() { go(step + 1); }
  function back() { go(step - 1); }

  function answer(id, i) {
    const q = QUIZ[id];
    if (!q) return;
    picked[id] = i;
    const box = $(`kv-q-${id}`);
    if (box) box.querySelectorAll('.kv-opt').forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
    const fb = $(`kv-fb-${id}`);
    if (fb) fb.innerHTML = quizFeedback(id, i);
    if (id === 'brief' && i === q.answer) mark('brief');
    if (['r1', 'r2', 'r3', 'r4'].every(k => picked[k] === QUIZ[k].answer)) mark('review');
  }

  // Policy
  function policyBasis() {
    const pb = $('kv-p-pbasis'), sb = $('kv-p-sbasis');
    if (pb && $('kv-p-punit')) $('kv-p-punit').textContent = pb.value === 'per10' ? 'mm / 10 m' : 'mm';
    if (!sb) return;
    const wrap = $('kv-p-swrap');
    if (wrap) wrap.hidden = sb.value === 'change-points';
    if ($('kv-p-slabel')) $('kv-p-slabel').textContent = sb.value === 'distance' ? 'Distance coefficient' : 'Survey tolerance';
    if ($('kv-p-sunit')) $('kv-p-sunit').textContent = sb.value === 'distance' ? 'mm / √km' : 'mm';
  }
  function fillStarting() {
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    set('kv-p-org', 'Flood-Net starting limits');
    set('kv-p-pbasis', 'fixed');
    set('kv-p-plimit', String(L.TOL.pegtest * 1000));
    set('kv-p-sbasis', 'fixed');
    set('kv-p-slimit', String(L.TOL.misclose * 1000));
    policyBasis();
    const fb = $('kv-fb-policy');
    if (fb) fb.innerHTML = 'Filled in the two-peg and misclose limits Flood-Net\'s sheets start with. Flood-Net sets no minimum peg spacing — type your organisation\'s (its Survey Guide puts the pegs about 50 m apart).';
    const sp = $('kv-p-spacing');
    if (sp) sp.focus();
  }
  function savePolicy() {
    const get = id => { const el = $(id); return el ? el.value.trim() : ''; };
    const p = { organisation: get('kv-p-org'), twoPegBasis: get('kv-p-pbasis') || 'fixed', twoPegLimit: get('kv-p-plimit'),
      minimumPegSpacing: get('kv-p-spacing'), surveyBasis: get('kv-p-sbasis') || 'fixed', surveyLimit: get('kv-p-slimit') };
    if (p.surveyBasis === 'change-points') p.surveyLimit = '';
    const err = checkPolicy(p);
    if (err) { const fb = $('kv-fb-policy'); if (fb) fb.innerHTML = bad(esc(err)); return; }
    policy = p;
    mark('policy');
    save();
    paint(true);
  }
  function newPractice() {
    policy = null;
    done = {};
    peg = null;
    picked = {};
    save();
    paint(true);
  }

  // Bubble
  function turn(k, dir) {
    const u = SCREWS[k];
    if (!u) return;
    const b = bubbleNow();
    let x = b.x + dir * 6 * u[0], y = b.y + dir * 6 * u[1];
    const r = Math.hypot(x, y);
    if (r > 44) { x *= 44 / r; y *= 44 / r; }
    bubble = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    bubbleChecked = 'Check the bubble when you are ready.';
    const f = $('kv-bubble-fig');
    if (f) f.innerHTML = fig(bubbleSvg(), 'The bubble in the mirror, and the three foot screws.');
    const w = $('kv-bub-words');
    if (w) w.textContent = bubbleWords(bubble);
    const fb = $('kv-fb-level');
    if (fb) fb.textContent = bubbleChecked;
  }
  function checkBubble() {
    const ok = centred(bubbleNow());
    bubbleChecked = ok ? good('Bubble centred.') : bad('Centre the bubble with the foot screws.');
    const fb = $('kv-fb-level');
    if (fb) fb.innerHTML = bubbleChecked;
    if (ok) mark('level');
  }
  function newBubble() {
    bubble = newBubbleAt();
    bubbleChecked = 'New setup. Centre the bubble.';
    paint(false);
  }

  // Reading
  function checkRead() {
    const s = SIGHTS[sightIdx];
    const c = val('kv-r-c'), d = val('kv-r-d');
    const cOk = c != null && Math.abs(c - s.c) <= 0.00100001;
    const dOk = d != null && Math.abs(d - s.d) <= 0.20000001;
    const out = [];
    out.push(c == null ? bad('Enter the centre reading.') : cOk ? good(`Reading ${f3(c)} m.`) : bad('The staff reading does not match the saved sight.'));
    out.push(d == null ? bad('Enter the distance.') : dOk ? good(`Distance ${L.fmt(d, 1)} m.`) : bad('The distance does not match the saved sight.'));
    if (!(cOk && dOk) && c != null && d != null) {
      out.push(`<span class="small">The sight: centre ${f4(s.c)} m, distance ${s.d} m — upper ${f4(s.c + s.d / 200)} − lower ${f4(s.c - s.d / 200)} = ${f4(s.d / 100)}, × 100.</span>`);
    }
    const fb = $('kv-fb-read');
    if (fb) fb.innerHTML = out.join('<br>');
    if (cOk && dOk) mark('read');
  }
  function newSight() {
    sightIdx = (sightIdx + 1) % SIGHTS.length;
    paint(false);
  }

  // Two-peg
  function pegSpacing(S) {
    if (!PEG_SPACINGS.includes(S)) return;
    peg = makePeg(S);
    paint(false);
  }
  function checkPeg1() {
    const p = pegNow(), res = pegResult();
    const d = val('kv-p1-d'), s = val('kv-p1-s');
    const dOk = d != null && Math.abs(d - res.r.d1) <= 0.0005;
    const sOk = s != null && Math.abs(s - res.spacing) <= 0.05;
    const out = [
      d == null ? bad('Enter A minus B.') : dOk ? good(`A − B = ${L.signed(res.r.d1)} m.`) : bad(`A − B is ${f3(p.a1)} − ${f3(p.b1)} = ${L.signed(res.r.d1)} m.`),
      s == null ? bad('Enter the peg spacing.') : sOk ? good(`Peg spacing ${L.fmt(res.spacing, 1)} m.`) : bad(`Peg spacing is the two distances added: ${L.fmt(p.da1, 1)} + ${L.fmt(p.db1, 1)} = ${L.fmt(res.spacing, 1)} m.`),
    ];
    if (policy && res.spacing + 1e-9 < Number(policy.minimumPegSpacing)) {
      out.push(`<span class="txt-warn">Below your minimum of ${Number(policy.minimumPegSpacing)} m — this test will come out <em>Review peg spacing</em>. Choose wider pegs.</span>`);
    }
    const fb = $('kv-fb-peg1');
    if (fb) fb.innerHTML = out.join('<br>');
    if (dOk && sOk) mark('peg1');
  }
  function checkPeg2() {
    const p = pegNow(), res = pegResult();
    const d = val('kv-p2-d'), m = val('kv-p2-m'), vEl = $('kv-p2-v'), v = vEl ? vEl.value : '';
    const dOk = d != null && Math.abs(d - res.r.d2) <= 0.0005;
    const mOk = m != null && Math.abs(m - res.mis) <= 0.05;
    const vOk = v === res.verdict;
    const out = [
      d == null ? bad('Enter A minus B for set-up 2.') : dOk ? good(`A − B = ${L.signed(res.r.d2)} m.`) : bad(`A − B is ${f3(p.a2)} − ${f3(p.b2)} = ${L.signed(res.r.d2)} m.`),
      m == null ? bad('Enter the misclose.') : mOk ? good(`Misclose ${L.signed(res.mis, 0)} mm.`)
        : Math.abs(Math.abs(m) - Math.abs(res.mis)) <= 0.05 ? bad('Right size, wrong sign — it is set-up 2 minus set-up 1.')
        : bad(`Misclose = (${L.signed(res.r.d2)}) − (${L.signed(res.r.d1)}) = ${L.signed(res.mis, 0)} mm.`),
      !v ? bad('Choose a verdict.') : vOk ? good(`${res.verdict}.`) : bad(`Not ${esc(v)}: ${res.verdict === 'No tolerance recorded' ? 'no policy is saved — set one in step 2'
        : res.verdict === 'Review peg spacing' ? `the spacing, ${L.fmt(res.spacing, 1)} m, is under your minimum of ${Number(policy.minimumPegSpacing)} m`
        : `|${L.signed(res.mis, 0)}| mm against ${L.fmt(res.tol, 1)} mm makes it ${res.verdict.toLowerCase()}`}.`),
    ];
    if (dOk && mOk && res.collim != null) out.push(`<span class="small">Collimation: ${L.fmt(res.collim, 2)} mm per 10 m of sight distance${res.r.per30 != null ? `; over a 30 m sight, ${L.fmt(Math.abs(res.r.per30) * 1000, 1)} mm` : ''}.</span>`);
    if (vOk && res.verdict === 'Outside limit') out.push('<span class="small">Over the limit, the level is out of action until it has been adjusted or serviced — keep the readings either way.</span>');
    const fb = $('kv-fb-peg2');
    if (fb) fb.innerHTML = out.join('<br>');
    if (dOk && mOk && vOk) mark('peg2');
  }

  // The section
  function checkPlan() {
    const hpc = groundAt(26) + EYE;
    let right = 0;
    PROFILE.forEach(([, h], i) => {
      const reading = hpc - h, can = reading >= 0 && reading <= STAFF;
      const el = $(`kv-pl-${i}`), m = $(`kv-pl-m-${i}`);
      const ticked = !!(el && el.checked);
      if (ticked === can) right++;
      if (m) m.innerHTML = ticked === can ? good(`${f4(reading)} m${can ? '' : ' — off the staff'}`) : bad(`${f4(reading)} m — ${can ? 'on the staff' : 'off the end of a 4 m staff'}`);
    });
    const fb = $('kv-fb-plan');
    const all = right === PROFILE.length;
    if (fb) {
      fb.innerHTML = (all ? good('All twelve right.') : bad(`${right} of ${PROFILE.length} right.`))
        + ' Only the two inside corners of the notch are out of reach — 4.374 m below the line of sight. That is why the route carries the level down into the channel through a change point. The right bank is on the staff too, but 42–72 m away — the SDL50 reaches 100 m, yet short sights are better ones.';
    }
    if (all) mark('plan');
  }
  function checkBook() {
    const red = L.reduce(routeDoc(CLOSE_READS[0]));
    let ok = 0;
    for (let i = 1; i < red.rows.length; i++) {
      const v = val(`kv-bk-rl-${i}`), want = red.rows[i].rl;
      const right = v != null && Math.abs(v - want) <= 0.0006;
      if (right) ok++;
      const m = $(`kv-bk-m-${i}`);
      if (m) m.innerHTML = v == null ? '' : right ? good(f4(want)) : bad(f4(want));
    }
    const ch = val('kv-bk-ch'), chOk = ch != null && Math.abs(ch - 50) <= 0.05;
    const s = red.sums, c = red.checks;
    const hpc = [BM.rl + 0.2236, red.rows[1].rl + 1.3736, red.rows[3].rl + 3.774];
    const out = [
      ok === 4 ? good('All four levels right.') : bad(`${ok} of 4 levels right.`),
      ch == null ? bad('Enter the intermediate\'s chainage.') : chOk ? good('Chainage 50 m.')
        : bad('Set-up 2 stands 5 m on the left-bank side of the corner (43 − 5 = 38); the intermediate is 12 m towards the right bank: 38 + 12 = 50 m.'),
      `<span class="small">Heights of collimation: ${hpc.map(f4).join(', ')} m. ΣBS ${f4(s.bs)} − ΣFS ${f4(s.fs)} = ${L.signed(c.bsfs, 4)};
        ΣRise ${f4(s.rise)} − ΣFall ${f4(s.fall)} = ${L.signed(c.risefall, 4)}; last − first = ${L.signed(c.lastfirst, 4)}. ${c.agree ? 'They agree.' : ''}</span>`,
    ];
    const fb = $('kv-fb-book');
    if (fb) fb.innerHTML = out.join('<br>');
    if (ok === 4 && chOk) mark('book');
  }
  function checkClose() {
    const red = L.reduce(routeDoc(CLOSE_READS[closeIdx]));
    const misMm = Math.round(red.misclose * 1e5) / 100;
    const allow = sectionAllowance(red.cps, ROUTE_KM);
    const verdict = allow == null ? 'No tolerance recorded' : Math.abs(misMm) <= allow + 1e-9 ? 'Within limit' : 'Outside limit';
    const m = val('kv-cl-m'), a = val('kv-cl-a'), vEl = $('kv-cl-v'), v = vEl ? vEl.value : '';
    const mOk = m != null && Math.abs(m - misMm) <= 0.05;
    const aOk = allow == null || (a != null && Math.abs(a - allow) <= 0.01);
    const vOk = v === verdict;
    const out = [
      m == null ? bad('Enter the misclose.') : mOk ? good(`Misclose ${L.signed(misMm, 1)} mm.`)
        : bad(`The closing RL is ${f4(red.rows[4].rl)}; ${f4(red.rows[4].rl)} − ${f3(BM.rl)} = ${L.signed(misMm, 1)} mm.`),
    ];
    if (allow != null) out.push(a == null ? bad('Enter the allowance.') : aOk ? good(`Allowance ${L.fmt(allow, 2)} mm.`) : bad(`Allowance under your rule: ${L.fmt(allow, 2)} mm (1 + √2 = 2.41; √${L.fmt(ROUTE_KM, 2)} = ${L.fmt(Math.sqrt(ROUTE_KM), 3)}).`));
    out.push(!v ? bad('Choose a verdict.') : vOk ? good(`${verdict}.`) : bad(`Not ${esc(v)} — ${verdict === 'No tolerance recorded' ? 'no policy is saved (step 2)' : `${L.signed(misMm, 1)} mm against ${L.fmt(allow, 2)} mm is ${verdict.toLowerCase()}`}.`));
    if (vOk && verdict === 'Outside limit') out.push('<span class="small">First look for a booking slip. The sums agree here, so it is a reading: go round again set-up by set-up through the same change points, and overwrite only what you have re-read.</span>');
    const fb = $('kv-fb-close');
    if (fb) fb.innerHTML = out.join('<br>');
    if (mOk && aOk && vOk) mark('close');
  }
  function newClose() {
    closeIdx = (closeIdx + 1) % CLOSE_READS.length;
    paint(false);
  }

  return { TAB, render, init, go, next, back, answer, policyBasis, fillStarting, savePolicy, newPractice,
    turn, checkBubble, newBubble, checkRead, newSight, pegSpacing, checkPeg1, checkPeg2, checkPlan, checkBook, checkClose, newClose };
})();

if (typeof window !== 'undefined') window.KbLevel = KbLevel;
