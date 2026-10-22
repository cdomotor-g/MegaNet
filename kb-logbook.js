// MegaNet — kb-logbook.js
//
//   KbLogbook   📒 the Survey Logbook tab, in the Field training group: the
//               field book of a level run, worked six ways on one fictional
//               gauging station — booking the readings as they are taken
//               (back, inter, fore, and the change-point routine), reducing
//               the book by rise and fall and by height of instrument,
//               recovering readings missing from a book, closing it (the
//               three column checks, the misclose, a 1 + √n mm limit), and a
//               weir cross-section booked from the three hairs, carrying
//               chainage through each instrument move. Adapted from Mallee
//               HydroTech's Survey Logbook
//               (github.com/MalleeHydroTech/survey-logbook): its six modules,
//               help notes, exercise data and limits came across; its
//               illustrations, telescope staff renderer, CSV download, saved
//               answers and Golden Pencil award were left out, and the
//               cross-section is worked from the hair readings rather than
//               read off a drawn staff.
//
// After core.js (esc, escAttr), levelling.js (whose reduce() does every sum
// here, so this tab and the Level Survey sheet cannot disagree about one) and
// knowledge-base.js (the credit panel), before init.js. Reaches app.js for
// switchTab. Nothing runs at load.

const KbLogbook = (function () {
  const TAB = 'kblogbook';
  const KEY = 'floodnet-kb-logbook';
  const L = Levelling;
  const GZ = 42;                       // the exercise's gauge zero, m AHD
  const f3 = v => (v == null ? '' : L.fmt(v, 3));
  const f1 = v => (v == null ? '' : L.fmt(v, 1));
  const r3 = v => Math.round(v * 1000) / 1000;
  const r1 = v => Math.round(v * 10) / 10;

  // [id, title, what it asks] — the original's six modules, in its order.
  const MODULES = [
    ['survey', 'Book a survey', 'Read the staff and book the run as you work down the bank.'],
    ['rise', 'Rise and fall', 'Reduce the book by the rise and fall method.'],
    ['hi', 'Height of instrument', 'Reduce the same book by the height of instrument method.'],
    ['recover', 'Recover readings', 'Work out the staff readings missing from the book.'],
    ['closure', 'Close the survey', 'Add the columns, check the arithmetic and work out the misclose.'],
    ['cross', 'Cross-section survey', 'Carry chainage and level through each instrument move.'],
  ];
  const WORD = { bs: 'backsight', is: 'intermediate', fs: 'foresight' };
  const BUTTON = { bs: 'Back', is: 'Inter', fs: 'Fore' };

  // The original's synthetic gauging-station circuit, metres. Levels are on the
  // gauge datum; `x` places the point in the drawing.
  const OBS = [
    { point: 'BMGS', kind: 'bm', note: 'Top of channel at gauge range', bs: 1.237, x: 85, setup: 1 },
    { point: 'SG3', kind: 'board', face: 3, note: '3.000 m graduation, top of 2 to 3 m plate', is: 1.887, x: 295, setup: 1 },
    { point: 'CP1', kind: 'cp', note: 'Top of 2 to 3 m SG post', fs: 1.737, bs: 0.924, x: 295, setup: 2 },
    { point: 'SG3', kind: 'board', face: 3, note: '3.000 m graduation, repeat after move', is: 1.074, x: 295, setup: 2 },
    { point: 'SG2', kind: 'board', face: 2, note: '2.000 m graduation, top of 1 to 2 m plate', is: 2.074, x: 475, setup: 2 },
    { point: 'SG1', kind: 'board', face: 1, note: '1.000 m graduation, top of 0 to 1 m plate', is: 3.074, x: 680, setup: 2 },
    { point: 'CP2', kind: 'cp', note: 'Top of 0 to 1 m SG post', fs: 2.954, bs: 2.657, x: 680, setup: 3 },
    { point: 'SG1', kind: 'board', face: 1, note: '1.000 m graduation, repeat after move', is: 2.777, x: 680, setup: 3 },
    { point: 'WL', kind: 'water', note: 'Water level at 10:15', is: 3.034, x: 745, setup: 3 },
    { point: 'CTR', kind: 'ctr', note: 'Top of brass termination fitting', is: 3.532, x: 825, setup: 3 },
    { point: 'SG2', kind: 'board', face: 2, note: '2.000 m graduation, repeat on return', is: 1.777, x: 475, setup: 3 },
    { point: 'BMGS', kind: 'bm', note: 'Top of channel at gauge range, close', fs: 0.130, x: 85, setup: 3 },
  ];
  const BM_RL = 3.65;                         // BMGS on the gauge datum
  const MISSING = [[0, 'bs'], [2, 'fs'], [6, 'bs'], [11, 'fs']];   // the recover module's blanks
  const SETUP_X = [0, 190, 395, 575];         // where each set-up stands in the drawing

  // The original's weir cross-section worked book: one line per sight, the
  // three hairs read, and the direction from the level to the staff.
  const XS = [
    { setup: 1, sight: 'bs', c: 1.123, u: 1.173, l: 1.073, dir: 1, point: 'BMXS', note: 'Left bank benchmark; chainage origin' },
    { setup: 1, sight: 'is', c: 1.123, u: 1.183, l: 1.063, dir: 1, point: 'LB', note: 'Left bank crest' },
    { setup: 1, sight: 'fs', c: 3.123, u: 3.187, l: 3.059, dir: 1, point: 'CPWL', note: 'Left bank / wing interface; fixed contact' },
    { setup: 2, sight: 'bs', c: 3.427, u: 3.488, l: 3.366, dir: -1, point: 'CPWL', note: 'Left bank / wing interface; fixed contact' },
    { setup: 2, sight: 'is', c: 3.427, u: 3.475, l: 3.380, dir: -1, point: 'WTL', note: 'Left cutout, upper corner' },
    { setup: 2, sight: 'is', c: 4.427, u: 4.475, l: 4.380, dir: -1, point: 'WBL', note: 'Left cutout, lower corner' },
    { setup: 2, sight: 'is', c: 4.427, u: 4.460, l: 4.395, dir: -1, point: 'WBR', note: 'Right cutout, lower corner' },
    { setup: 2, sight: 'is', c: 3.427, u: 3.460, l: 3.395, dir: -1, point: 'WTR', note: 'Right cutout, upper corner' },
    { setup: 2, sight: 'fs', c: 3.427, u: 3.446, l: 3.408, dir: -1, point: 'CPWR', note: 'Right wing / bank interface; fixed contact' },
    { setup: 3, sight: 'bs', c: 3.123, u: 3.267, l: 2.979, dir: -1, point: 'CPWR', note: 'Right wing / bank interface; fixed contact' },
    { setup: 3, sight: 'is', c: 1.123, u: 1.263, l: 0.983, dir: -1, point: 'RB', note: 'Right bank crest' },
    { setup: 3, sight: 'is', c: 1.123, u: 1.253, l: 0.993, dir: -1, point: 'RF', note: 'Right bank flat' },
    { setup: 3, sight: 'fs', c: 1.123, u: 1.323, l: 0.923, dir: -1, point: 'BMXS', note: 'Close on left bank benchmark' },
  ];
  const XBM_RL = 5;

  let cache = null;      // the reduced books, worked out on first use
  let bk = null;         // the booking drill: { step, booked, sel, miss }
  let done = {};         // module id → true once checked complete
  let pending = null;    // a module to open once the tab has rendered

  // ── The books, reduced by Levelling ───────────────────────────────────────

  function docOf(rows, bm, rl, tol) {
    return {
      datum: 'LGH', bm: { name: bm, rl }, gauge_zero: { rl: GZ, source: 'Exercise' },
      tol: tol == null ? {} : { misclose: tol },
      rows: rows.map((r, i) => ({ id: `kl${i}`, kind: r.kind, name: r.point, face: r.face == null ? null : r.face,
        bs: r.bs == null ? null : r.bs, is: r.is == null ? null : r.is, fs: r.fs == null ? null : r.fs })),
    };
  }

  function data() {
    if (cache) return cache;
    const cps = OBS.filter(r => r.bs != null && r.fs != null).length;
    const limit = 1 + Math.sqrt(cps);                          // mm
    const red = L.reduce(docOf(OBS, 'BMGS', BM_RL, limit / 1000));
    const book = OBS.map((r, i) => {
      const o = red.rows[i];
      return Object.assign({}, r, {
        rl: o.rl, ahd: o.ahd,
        change: i ? r3((o.rise || 0) - (o.fall || 0)) : null,
        hi: r.bs != null && o.rl != null ? r3(o.rl + r.bs) : null,
      });
    });
    const stages = [];
    OBS.forEach((r, i) => {
      if (r.bs != null && r.fs != null) {
        stages.push({ i, k: 'fs', setup: r.setup - 1 }, { i, k: 'move', setup: r.setup - 1 }, { i, k: 'bs', setup: r.setup });
      } else stages.push({ i, k: r.bs != null ? 'bs' : r.is != null ? 'is' : 'fs', setup: r.setup });
    });

    // The cross-section: a change point's foresight and backsight share a row
    // in the book Levelling reduces, as they would on paper.
    const rows = [], lineRow = [];
    XS.forEach(s => {
      const prev = rows[rows.length - 1];
      if (s.sight === 'bs' && prev && prev.fs != null && prev.bs == null && prev.point === s.point) {
        prev.bs = s.c; prev.kind = 'cp'; lineRow.push(rows.length - 1); return;
      }
      rows.push({ point: s.point, kind: s.point === 'BMXS' ? 'bm' : 'other', [s.sight]: s.c });
      lineRow.push(rows.length - 1);
    });
    const xred = L.reduce(docOf(rows, 'BMXS', XBM_RL, null));
    const known = { BMXS: 0 }, inst = {};
    const xbook = XS.map((s, j) => {
      const d = Math.round(s.u * 1000 - s.l * 1000) / 10;      // (upper − lower) × 100
      let chain, at = null;
      if (s.sight === 'bs') { chain = known[s.point]; at = r1(chain - s.dir * d); inst[s.setup] = at; }
      else { chain = r1(inst[s.setup] + s.dir * d); known[s.point] = chain; }
      const o = xred.rows[lineRow[j]];
      return Object.assign({}, s, { d, chain, inst: at, rl: o.rl, hi: s.sight === 'bs' ? r3(o.rl + s.c) : null });
    });

    cache = { book, stages, red, cps, limit, xbook, xred, inst };
    return cache;
  }

  // ── Progress (this browser only) ──────────────────────────────────────────

  function load() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); done = v && v.done && typeof v.done === 'object' ? v.done : {}; }
    catch (e) { done = {}; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ done })); } catch (e) { /* private window: progress just isn't kept */ }
  }
  function setDone(id, yes = true) {
    if (yes) done[id] = true; else delete done[id];
    save();
    paintProgress();
  }
  function paintProgress() {
    for (const [id] of MODULES) {
      const el = document.getElementById(`kl-st-${id}`);
      if (!el) continue;
      el.textContent = done[id] ? 'Complete' : 'Not yet';
      el.classList.toggle('kl-complete', !!done[id]);
    }
    const all = document.getElementById('kl-all');
    if (all) all.textContent = MODULES.every(([id]) => done[id]) ? 'All six modules complete — the book is yours.' : '';
  }

  // ── Drawings ──────────────────────────────────────────────────────────────

  // The staff as seen through the level, central hair on `v`. 1 px = 1 mm, an
  // E-face staff: 1 cm blocks, the E alternating sides every 5 cm, black and
  // red alternating each metre, the decimetre number sitting on its line.
  function scopeSvg(v) {
    const cx = 120, cy = 120, R = 112;
    const y = m => r3(cy - (m - v) * 1000);
    const lo = Math.max(0, Math.floor((v - 0.13) * 100)), hi = Math.ceil((v + 0.13) * 100);
    let marks = '';
    for (let c = lo; c < hi; c++) {
      const cls = Math.floor(c / 100) % 2 ? 'kl-st-r' : 'kl-st-k';
      const left = Math.floor(c / 5) % 2 === 0;
      if (c % 5 === 0) marks += `<rect x="${left ? 72 : 162}" y="${y((c + 5) / 100)}" width="6" height="50" class="${cls}"/>`;
      if ((c % 5) % 2 === 0) marks += `<rect x="${left ? 72 : 126}" y="${y((c + 1) / 100)}" width="42" height="10" class="${cls}"/>`;
      if (c % 10 === 0) marks += `<text x="${left ? 145 : 95}" y="${y(c / 100) - 2}" text-anchor="middle" class="kl-st-num ${cls}">${String(c / 10).padStart(2, '0')}</text>`;
    }
    return `<svg viewBox="0 0 240 240" role="img" aria-labelledby="kl-scope-t" class="kl-svg kl-scope-svg">
      <title id="kl-scope-t">The staff seen through the level, the central hair across it. Read it where the horizontal hair cuts the staff.</title>
      <defs><clipPath id="kl-eye"><circle cx="${cx}" cy="${cy}" r="${R}"/></clipPath></defs>
      <circle cx="${cx}" cy="${cy}" r="${R}" class="kl-eye-bg"/>
      <g clip-path="url(#kl-eye)">
        <rect x="68" y="${y(hi / 100)}" width="104" height="${r3((hi - lo) * 10)}" class="kl-st-face"/>
        ${marks}
        <line x1="${cx - R}" y1="${cy}" x2="${cx + R}" y2="${cy}" class="kl-hair"/>
        <line x1="${cx}" y1="${cy - R}" x2="${cx}" y2="${cy + R}" class="kl-hair"/>
      </g>
      <circle cx="${cx}" cy="${cy}" r="${R + 3}" class="kl-ring"/>
    </svg>`;
  }

  const GROUND = [[-20, 119], [120, 119], [295, 198], [475, 260], [680, 312], [825, 330], [880, 331]];
  function groundY(x) {
    for (let i = 1; i < GROUND.length; i++) {
      const [x0, y0] = GROUND[i - 1], [x1, y1] = GROUND[i];
      if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
    return GROUND[GROUND.length - 1][1];
  }

  // The gauging station side-on: the benchmark at the top of the bank, the
  // three gauge plates down it, the water and the CTR; the level at set-up
  // `st.setup`, the staff on row `st.i`.
  function stationSvg(st) {
    const { book } = data();
    const r = book[st.i], y = v => r3(340 - v * 65);
    const ix = SETUP_X[st.setup];
    const hi = book.find(b => b.bs != null && b.setup === st.setup).hi;
    const iy = y(hi), gy = r3(groundY(ix));
    const plate = (x, base, top, label) => {
      let t = '';
      for (let n = 0; n <= 10; n++) {
        t += `<line x1="${x - 8}" y1="${y(base + n / 10)}" x2="${x + (n % 5 ? 0 : 6)}" y2="${y(base + n / 10)}" class="${n % 5 ? 'kl-tick' : 'kl-tick-r'}"/>`;
      }
      return `<rect x="${x - 12}" y="${y(top + 0.15)}" width="24" height="${r3((top - base + 0.45) * 65)}" class="kl-post"/>
        <rect x="${x - 9}" y="${y(top)}" width="18" height="65" class="kl-face"/>${t}
        <text x="${x - 16}" y="${y(top + 0.05)}" text-anchor="end" class="kl-lab">${label}</text>`;
    };
    const ground = `M-20 352${GROUND.map(([gx, gy2]) => `L${gx} ${gy2}`).join('')}L880 352Z`;
    return `<svg viewBox="-20 0 900 352" role="img" aria-labelledby="kl-stn-t" class="kl-svg kl-scene">
      <title id="kl-stn-t">The gauging station side-on. Set-up ${st.setup}: the level on the bank, the staff on ${esc(r.point)}.</title>
      <path d="${ground}" class="kl-ground"/>
      <path d="M601.2 292H880V331L825 330L680 312Z" class="kl-water"/>
      <text x="872" y="284" text-anchor="end" class="kl-lab">WL</text>
      <rect x="64" y="${y(BM_RL)}" width="42" height="${r3(119 - y(BM_RL))}" class="kl-bm"/>
      <text x="85" y="142" text-anchor="middle" class="kl-lab">BMGS</text>
      ${plate(295, 2, 3, 'SG3')}${plate(475, 1, 2, 'SG2')}${plate(680, 0, 1, 'SG1')}
      <rect x="818" y="321" width="15" height="8" rx="2" class="kl-ctr"/>
      <text x="826" y="348" text-anchor="middle" class="kl-lab">CTR</text>
      <line x1="${ix + 12}" y1="${iy}" x2="${r.x}" y2="${iy}" class="kl-sight"/>
      <rect x="${r.x - 4}" y="${r3(iy - 14)}" width="8" height="${r3(y(r.rl) - iy + 14)}" class="kl-staff"/>
      <circle cx="${r.x}" cy="${y(r.rl)}" r="4" class="kl-foot"/>
      <line x1="${ix}" y1="${iy + 6}" x2="${ix - 14}" y2="${gy}" class="kl-leg"/>
      <line x1="${ix}" y1="${iy + 6}" x2="${ix + 14}" y2="${gy}" class="kl-leg"/>
      <rect x="${ix - 12}" y="${iy - 6}" width="24" height="12" rx="2" class="kl-inst"/>
    </svg>`;
  }

  // The weir cross-section the last module books: banks, the concrete wings
  // sealed against them, the cut-out, and the points levelled.
  function sectionSvg() {
    const x = c => r3(30 + (c + 0.5) * 40), y = v => r3(230 - v * 36);
    const LBL = { WTL: ['end', -5, -4], WBL: ['end', -5, 13], WBR: ['start', 5, 13], WTR: ['start', 5, -4],
                  CPWL: ['end', -6, 14], CPWR: ['start', 6, 14] };
    const seen = new Set();
    const pts = data().xbook.filter(s => !seen.has(s.point) && seen.add(s.point)).map(s => {
      const [a, dx, dy] = LBL[s.point] || ['middle', 0, -9];
      return `<circle cx="${x(s.chain)}" cy="${y(s.rl)}" r="3.5" class="kl-pt"/><text x="${x(s.chain) + dx}" y="${y(s.rl) + dy}" text-anchor="${a}" class="kl-lab kl-lab-s">${esc(s.point)}</text>`;
    }).join('');
    const ticks = [0, 2, 4, 6, 8, 10, 12, 14].map(c => `<line x1="${x(c)}" y1="266" x2="${x(c)}" y2="272" class="kl-tick"/><text x="${x(c)}" y="286" text-anchor="middle" class="kl-lab kl-lab-s">${c}</text>`).join('');
    const ix = x(15), gy = y(5), iy = y(data().xbook.find(s => s.sight === 'bs' && s.setup === 2).hi);
    return `<svg viewBox="-34 -40 754 335" role="img" aria-labelledby="kl-xs-t" class="kl-svg kl-scene">
      <title id="kl-xs-t">The weir cross-section, looking downstream: banks at RL 5.0 sloping to a natural bed at RL 0.0 between chainage 4 and 10; across the channel a concrete weir with its crest at RL 3.0, sealed against both banks (CPWL at 2.8 m, CPWR at 11.2 m), and a cut-out between 5.5 and 8.5 m down to RL 2.0 with a little water in it. Set-up 2 stands on the right bank; set-ups 1 and 3 are off the drawing at chainage −10 and 40.</title>
      <path d="M${x(-0.5)} ${y(5)}H${x(2)}L${x(4)} ${y(0)}H${x(10)}L${x(12)} ${y(5)}H${x(16)}V262H${x(-0.5)}Z" class="kl-ground"/>
      <path d="M${x(2.8)} ${y(3)}H${x(5.5)}V${y(2)}H${x(8.5)}V${y(3)}H${x(11.2)}L${x(10)} ${y(0)}H${x(4)}Z" class="kl-wall"/>
      <path d="M${x(5.5)} ${y(2.2)}H${x(8.5)}V${y(2)}H${x(5.5)}Z" class="kl-water"/>
      <path d="M${x(2)} ${y(5)}L${x(4)} ${y(0)}H${x(10)}L${x(12)} ${y(5)}" class="kl-bedline"/>
      <text x="${x(7)}" y="${y(1)}" text-anchor="middle" class="kl-lab kl-lab-s">concrete weir, crest RL 3.0</text>
      <text x="${x(7)}" y="${y(0) - 5}" text-anchor="middle" class="kl-lab kl-lab-s">natural bed RL 0.0</text>
      <text x="${x(7)}" y="${y(2.2) - 5}" text-anchor="middle" class="kl-lab kl-lab-s">cut-out, RL 2.0</text>
      ${[0, 1, 2, 3, 4, 5].map(v => `<line x1="${x(-0.5) - 6}" y1="${y(v)}" x2="${x(-0.5)}" y2="${y(v)}" class="kl-tick"/><text x="${x(-0.5) - 9}" y="${y(v) + 4}" text-anchor="end" class="kl-lab kl-lab-s">${v}</text>`).join('')}
      <text x="${x(-0.5) - 9}" y="${y(5.6)}" text-anchor="end" class="kl-lab kl-lab-s">RL</text>
      ${pts}
      <line x1="${ix}" y1="${iy + 6}" x2="${ix - 10}" y2="${gy}" class="kl-leg"/><line x1="${ix}" y1="${iy + 6}" x2="${ix + 10}" y2="${gy}" class="kl-leg"/>
      <rect x="${ix - 10}" y="${iy - 5}" width="20" height="10" rx="2" class="kl-inst"/>
      <text x="${ix - 16}" y="${iy + 4}" text-anchor="end" class="kl-lab kl-lab-s">Set-up 2</text>
      <text x="4" y="-24" class="kl-lab kl-lab-s">← set-up 1 at −10.0</text>
      <text x="716" y="-24" text-anchor="end" class="kl-lab kl-lab-s">set-up 3 at 40.0 →</text>
      <text x="${x(0.8)}" y="250" text-anchor="middle" class="kl-lab kl-lab-s">Left bank</text>
      <text x="${x(13.2)}" y="250" text-anchor="middle" class="kl-lab kl-lab-s">Right bank</text>
      <line x1="${x(-0.5)}" y1="266" x2="${x(16)}" y2="266" class="kl-tick"/>${ticks}
      <text x="${x(16)}" y="286" text-anchor="end" class="kl-lab kl-lab-s">chainage, m</text>
    </svg>`;
  }

  // ── Drill parts ───────────────────────────────────────────────────────────

  // An answer box: the answer rides on the element, the label names the cell.
  function field(mod, key, answer, label, o = {}) {
    const dp = o.dp == null ? 3 : o.dp;
    const tol = o.tol == null ? 0.0005 : o.tol;
    return `<input id="kl-${mod}-${key}" class="kl-in" data-answer="${answer}" data-tol="${tol}" data-dp="${dp}"
      aria-label="${escAttr(label)}" inputmode="${o.signed ? 'text' : 'decimal'}" autocomplete="off" spellcheck="false"
      placeholder="${dp ? `0.${'0'.repeat(dp)}` : '0'}">`;
  }
  function wrap(label, caption, inner) {
    return `<div class="table-wrap" role="region" aria-label="${escAttr(label)}" tabindex="0"><table class="kl-book">
      <caption class="sr-only">${esc(caption)}</caption>${inner}</table></div>`;
  }
  const head = cols => `<thead><tr>${cols.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>`;
  function buttons(mod, label) {
    return `<div class="button-row kl-actions">
      <button type="button" class="primary" onclick="KbLogbook.check('${mod}')">${esc(label)}</button>
      <button type="button" onclick="KbLogbook.answers('${mod}')">Show answers</button>
      <button type="button" onclick="KbLogbook.clear('${mod}')">Start again</button>
    </div><p id="kl-${mod}-fb" class="kl-fb" role="status"></p>`;
  }

  // The rise-and-fall, height-of-instrument, recover and closure sheets — one
  // book, a different set of cells left for the learner each time.
  function sheet(mod) {
    const { book, red, cps, limit } = data();
    const mid = mod === 'hi' ? 'HI' : 'Rise/fall';
    const body = book.map((r, i) => {
      const who = `Row ${i + 1}, ${r.point}`;
      const rd = k => (mod === 'recover' && MISSING.some(([j, kk]) => j === i && kk === k)
        ? field(mod, `${i}-${k}`, r[k], `${who}: missing ${WORD[k]}`) : f3(r[k]));
      let m;
      if (mod === 'hi') m = r.bs != null ? field(mod, `${i}-hi`, r.hi, `${who}: height of instrument`) : '';
      else if (mod === 'rise' && i) m = field(mod, `${i}-ch`, r.change, `${who}: rise or fall (fall negative)`, { signed: true });
      else m = i ? L.signed(r.change) : '';
      const ask = (mod === 'rise' || mod === 'hi') && i;
      return `<tr><td>${rd('bs')}</td><td>${rd('is')}</td><td>${rd('fs')}</td><td>${m}</td>
        <td>${ask ? field(mod, `${i}-rl`, r.rl, `${who}: gauge datum level`) : f3(r.rl)}</td>
        <td>${ask ? field(mod, `${i}-ahd`, r.ahd, `${who}: AHD`) : f3(r.ahd)}</td>
        <th scope="row">${esc(r.point)}</th><td class="kl-note">${esc(r.note)}</td></tr>`;
    }).join('');
    const foot = mod !== 'closure' ? '' : `<tfoot><tr>
      <td>${field(mod, 'sbs', red.sums.bs, 'Sum of backsights')}</td><td></td>
      <td>${field(mod, 'sfs', red.sums.fs, 'Sum of foresights')}</td>
      <td><span class="kl-pair"><span>Rise</span>${field(mod, 'srise', red.sums.rise, 'Sum of rises')}</span>
        <span class="kl-pair"><span>Fall</span>${field(mod, 'sfall', red.sums.fall, 'Sum of falls')}</span></td>
      <td colspan="4">Column totals</td></tr></tfoot>`;
    const table = wrap(`Level book: ${MODULES.find(m2 => m2[0] === mod)[1]}`, `The gauging-station level book, ${mod === 'closure' ? 'to be totalled' : 'to be completed'}`,
      head(['Back', 'Inter', 'Fore', mid, 'Gauge datum', 'AHD', 'Point', 'Remarks']) + `<tbody>${body}</tbody>${foot}`);
    if (mod !== 'closure') return table;
    return `${table}
      <div class="kl-fields">
        <label>Misclose (m)${field(mod, 'mis', red.misclose, 'Misclose in metres', { signed: true })}</label>
        <label>Number of change points${field(mod, 'n', cps, 'Number of change points', { dp: 0, tol: 0.5 })}</label>
        <label>Limit, 1 + √n (mm)${field(mod, 'lim', limit, 'Misclose limit in millimetres', { dp: 2, tol: 0.005 })}</label>
        <label>Against the limit
          <select id="kl-closure-verdict" class="kl-in" data-pick="${Math.abs(red.misclose) * 1000 <= limit ? 'within' : 'outside'}" aria-label="The misclose against the limit">
            <option value="">Choose…</option><option value="within">Within: accept the levels</option><option value="outside">Outside: recheck and re-survey</option>
          </select></label>
      </div>`;
  }

  // The cross-section worked book: the hairs given, the rest to fill.
  function crossSheet() {
    const { xbook } = data();
    const body = xbook.map((s, j) => {
      const who = `Line ${j + 1}, ${s.point} ${WORD[s.sight]}`;
      return `<tr><td>${s.setup}</td><td>${s.sight.toUpperCase()}</td><td>${f3(s.c)}</td><td>${f3(s.u)}</td><td>${f3(s.l)}</td>
        <td>${s.dir > 0 ? 'Right →' : '← Left'}</td>
        <td>${field('cross', `${j}-d`, s.d, `${who}: distance`, { dp: 1, tol: 0.05 })}</td>
        <td>${s.sight === 'bs' ? field('cross', `${j}-i`, s.inst, `${who}: instrument chainage`, { dp: 1, tol: 0.05, signed: true }) : ''}</td>
        <td>${j ? field('cross', `${j}-c`, s.chain, `${who}: chainage`, { dp: 1, tol: 0.05 }) : f1(s.chain)}</td>
        <td>${j ? field('cross', `${j}-rl`, s.rl, `${who}: gauge datum level`) : f3(s.rl)}</td>
        <th scope="row">${esc(s.point)}</th><td class="kl-note">${esc(s.note)}</td></tr>`;
    }).join('');
    return wrap('Cross-section book', 'The weir cross-section book: hairs given, distance, chainage and level to fill',
      head(['Set-up', 'Sight', 'Central', 'Upper', 'Lower', 'Direction', 'Distance', 'Instrument chainage', 'Chainage', 'Gauge datum', 'Point', 'Remarks'])
      + `<tbody>${body}</tbody>`);
  }

  // ── The booking drill ─────────────────────────────────────────────────────

  function fresh() { return { step: 0, booked: {}, sel: '', miss: 0 }; }
  function drill() { if (!bk) bk = fresh(); return bk; }

  function liveTable(cur) {
    const { book } = data(), s = drill();
    const rows = book.map((r, i) => {
      const got = k => s.booked[`${i}:${k}`] || '';
      const any = ['bs', 'is', 'fs'].some(k => got(k));
      if (!any && cur !== i) return '';
      return `<tr${cur === i ? ' class="kl-current"' : ''}><td>${got('bs')}</td><td>${got('is')}</td><td>${got('fs')}</td>
        <td>${any && i ? L.signed(r.change) : ''}</td><td>${any || !i ? f3(r.rl) : ''}</td><td>${any || !i ? f3(r.ahd) : ''}</td>
        <th scope="row">${esc(r.point)}</th><td class="kl-note">${esc(r.note)}</td></tr>`;
    }).join('');
    return wrap('Level book as booked', 'The level book, booked so far',
      head(['Back', 'Inter', 'Fore', 'Rise/fall', 'Gauge datum', 'AHD', 'Point', 'Remarks']) + `<tbody>${rows}</tbody>`);
  }

  function bookingHtml() {
    const { book, stages } = data(), s = drill();
    const end = s.step >= stages.length;
    const st = stages[Math.min(s.step, stages.length - 1)];
    const r = book[st.i];
    let left, form = '';
    if (end) {
      left = `<div class="kl-msg"><h4>Survey booked</h4>
        <p>Twelve rows, three set-ups, closed back on BMGS. The rise and fall, levels and AHD filled in from your readings —
          the next modules work them out by hand.</p>
        <button type="button" onclick="KbLogbook.restart()">Book it again</button></div>`;
    } else if (st.k === 'move') {
      left = `<div class="kl-msg"><h4>${esc(r.point)} stays fixed</h4>
        <p>The foresight to ${esc(r.point)} is booked. The staff's foot stays exactly where it is — turn the staff to face the new
          set-up — and the level moves on down the bank.</p>
        <button type="button" class="primary" onclick="KbLogbook.move()">Move the level</button></div>`;
    } else {
      left = `<figure class="kl-scope">${scopeSvg(r[st.k])}<figcaption class="small">Through the telescope: the staff on ${esc(r.point)}.</figcaption></figure>`;
      form = `<form class="kl-form" onsubmit="KbLogbook.book(event)">
        <div class="kl-types" role="group" aria-label="Sight type">${['bs', 'is', 'fs'].map(k =>
          `<button type="button" data-kl-type="${k}" aria-pressed="${s.sel === k}" onclick="KbLogbook.pick('${k}')">${BUTTON[k]}</button>`).join('')}</div>
        <label for="kl-reading">Staff reading (m)</label>
        <div class="kl-entry"><input id="kl-reading" class="kl-in" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0.000">
          <button type="submit" class="primary">Book reading</button></div>
        <button type="button" class="link-btn" onclick="KbLogbook.hint()">Read it for me</button>
      </form>`;
    }
    return `<figure class="kl-figure">${stationSvg(st)}</figure>
      <div class="kl-bench">
        <div class="kl-scope-area">${left}</div>
        <div class="kl-obs">${form}<p id="kl-survey-fb" class="kl-fb" role="status"></p></div>
      </div>
      <p class="small">Set-up ${end ? 3 : st.setup} of 3 · gauge zero <strong>42.000 m AHD</strong></p>
      ${liveTable(end ? -1 : st.i)}`;
  }

  function say(id, text, kind, focus) {
    const el = document.getElementById(id);
    if (el) { el.textContent = text; el.className = `kl-fb${kind ? ` kl-${kind}` : ''}`; }
    if (focus && focus.focus) focus.focus();
  }

  function paintBooking(msg) {
    const box = document.getElementById('kl-survey-live');
    if (!box) return;
    box.innerHTML = bookingHtml();
    if (msg) say('kl-survey-fb', msg, 'good');
    const target = box.querySelector('.kl-msg button, [data-kl-type]');
    if (target) target.focus({ preventScroll: true });
  }

  function pick(k) {
    drill().sel = k;
    document.querySelectorAll('#kl-survey-live [data-kl-type]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.klType === k)));
    const el = document.getElementById('kl-reading');
    if (el && !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) el.focus();
  }

  function book(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const { book: rows, stages } = data(), s = drill();
    if (s.step >= stages.length) return;
    const g = stages[s.step];
    if (g.k === 'move') return;
    const el = document.getElementById('kl-reading');
    const raw = el ? el.value.trim() : '';
    const fb = 'kl-survey-fb';
    if (!/^\d+(\.\d{1,3})?$/.test(raw)) { say(fb, 'Enter the staff reading in metres, to no more than three decimal places.', 'bad', el); return; }
    if (!s.sel) { say(fb, 'Choose Back, Inter or Fore before you book it.', 'bad'); return; }
    if (s.sel !== g.k) {
      say(fb, 'Check the sight type: the first sight from a set-up is a backsight, the last before the level moves (or the closing sight) is a foresight, and anything between is an intermediate.', 'bad');
      return;
    }
    const want = rows[g.i][g.k];
    if (Math.abs(Number(raw) - want) >= 0.0005) {
      s.miss++;
      say(fb, s.miss >= 2 ? `Check the central hair — it reads ${f3(want)}. Find the decimetre number below the hair, count the centimetre blocks up to it, then judge the millimetres.`
        : 'Check the central hair. Enter metres to three decimal places.', 'bad', el);
      if (el) el.setAttribute('aria-invalid', 'true');
      return;
    }
    s.booked[`${g.i}:${g.k}`] = f3(want);
    s.step++; s.sel = ''; s.miss = 0;
    const end = s.step >= stages.length;
    if (end) setDone('survey');
    paintBooking(`Booked ${f3(want)} as ${g.k === 'is' ? 'an' : 'a'} ${WORD[g.k]} on ${rows[g.i].point}.${end ? ' Survey booked.' : ''}`);
  }

  function move() {
    const { book: rows, stages } = data(), s = drill();
    const g = stages[s.step];
    if (!g || g.k !== 'move') return;
    s.step++;
    paintBooking(`Level moved to set-up ${g.setup + 1}. Take the backsight on ${rows[g.i].point}.`);
  }

  function hint() {
    const { book: rows, stages } = data(), s = drill();
    const g = stages[s.step];
    if (!g || g.k === 'move') return;
    say('kl-survey-fb', `The central hair reads ${f3(rows[g.i][g.k])}.`, '');
  }

  function restart() { bk = fresh(); setDone('survey', false); paintBooking('Back at BMGS, set-up 1.'); }

  // ── Marking the sheets ────────────────────────────────────────────────────

  const SUCCESS = {
    rise: 'Complete — every rise, fall and level checks. The run comes back to BMGS at 3.647: the book is closed in "Close the survey".',
    hi: 'Complete — the same levels by height of instrument, as they should be.',
    recover: 'Complete — every missing reading recovered.',
    cross: 'Complete — the chainage comes back to 0.0 on BMXS and the level to 5.000.',
  };

  function boxOf(mod) { return document.getElementById(`kl-${mod}`); }
  function mark(el, ok) {
    el.setAttribute('aria-invalid', ok ? 'false' : 'true');
    el.classList.toggle('kl-ok', ok);
  }

  function check(mod) {
    const box = boxOf(mod);
    if (!box) return;
    const bad = [];
    box.querySelectorAll('input[data-answer]').forEach(el => {
      const v = L.num(el.value), want = Number(el.dataset.answer), tol = Number(el.dataset.tol);
      const ok = v != null && Math.abs(v - want) < tol + 1e-8;
      mark(el, ok);
      if (!ok) bad.push(el);
    });
    box.querySelectorAll('select[data-pick]').forEach(el => {
      const ok = el.value === el.dataset.pick;
      mark(el, ok);
      if (!ok) bad.push(el);
    });
    if (bad.length) {
      say(`kl-${mod}-fb`, `Check ${bad[0].getAttribute('aria-label')}. ${bad.length} ${bad.length === 1 ? 'entry needs' : 'entries need'} another look.`, 'bad', bad[0]);
      setDone(mod, false);
      return;
    }
    let msg = SUCCESS[mod];
    if (mod === 'closure') {
      const { red, limit } = data();
      msg = `The arithmetic checks: ΣBS − ΣFS = ΣRise − ΣFall = last − first = ${L.signed(red.checks.bsfs)} m. The misclose of ${L.signed(red.misclose)} m (${L.mm(red.misclose)}) is outside the ${limit.toFixed(2)} mm limit — recheck and re-survey before accepting the levels.`;
    }
    say(`kl-${mod}-fb`, msg, 'good');
    setDone(mod);
  }

  function answers(mod) {
    const box = boxOf(mod);
    if (!box) return;
    box.querySelectorAll('input[data-answer]').forEach(el => {
      const dp = Number(el.dataset.dp), v = Number(el.dataset.answer);
      el.value = el.inputMode === 'text' && dp === 3 ? L.signed(v, dp) : L.fmt(v, dp);
      el.removeAttribute('aria-invalid'); el.classList.remove('kl-ok');
    });
    box.querySelectorAll('select[data-pick]').forEach(el => { el.value = el.dataset.pick; el.removeAttribute('aria-invalid'); el.classList.remove('kl-ok'); });
    say(`kl-${mod}-fb`, 'Answers filled in. Work through them against the rules above, then press Start again and do it yourself.', '');
  }

  function clear(mod) {
    const box = boxOf(mod);
    if (!box) return;
    box.querySelectorAll('input[data-answer], select[data-pick]').forEach(el => { el.value = ''; el.removeAttribute('aria-invalid'); el.classList.remove('kl-ok'); });
    say(`kl-${mod}-fb`, '', '');
    const first = box.querySelector('input[data-answer]');
    if (first) first.focus();
  }

  // ── The page ──────────────────────────────────────────────────────────────

  function lessons() {
    const { book, cps, limit, xbook } = data();
    const b = i => book[i];
    return {
      survey: `
        <p>Each row of the book is one staff position, in the order you read it. A change point gets both readings on its row:
          the foresight you took to it, then — once the level has moved — the backsight from it.</p>
        <ul>
          <li><strong>Read the central hair</strong> to the millimetre. The number on the staff is decimetres (<em>12</em> is
            1.2 m) and sits on its line; count the centimetre blocks of the E up to the hair, then judge the millimetres.</li>
          <li><strong>Back</strong> is the first sight from a set-up, onto a point of known level. <strong>Fore</strong> is the last
            before you move the level, and the closing sight. Anything between is an <strong>Inter</strong>.</li>
          <li>At a change point: foresight, move the level, backsight on the <strong>same fixed contact</strong>. The staff's foot
            doesn't move until the backsight is booked.</li>
          <li>Gauge zero here is 42.000 m AHD, so every level has two columns:</li>
        </ul>
        <p class="kl-eq">AHD = gauge datum level + 42.000</p>
        <p class="small">The exercise uses the tops of two gauge posts as change points. On a real survey, pick something that can't
          shift and isn't a gauge board — see <button type="button" class="link-btn" onclick="switchTab('surveyguide')">How to Survey</button>.</p>`,
      rise: `
        <p>Compare each reading with the one before it <strong>from the same set-up</strong>. A smaller reading means the ground
          has risen; a larger one, fallen.</p>
        <p class="kl-eq">rise or fall = previous reading − this reading<br>next level = previous level + rise (or − fall)</p>
        <ul>
          <li>Book rises as positive and falls as negative in the one column.</li>
          <li>After a move, start again from the new backsight: the first sight after CP1 is compared with CP1's backsight
            (${f3(b(2).bs)}), not its foresight.</li>
        </ul>
        <p>Worked: BMGS backsight ${f3(b(0).bs)}, SG3 ${f3(b(1).is)}. ${f3(b(0).bs)} − ${f3(b(1).is)} = ${L.signed(b(1).change)}, a fall.
          ${f3(b(0).rl)} − ${f3(-b(1).change)} = ${f3(b(1).rl)} — the 3.000 m graduation it should be — and ${f3(b(1).ahd)} AHD.</p>`,
      hi: `
        <p>Work out the height of the line of sight once per set-up, then take each reading off it.</p>
        <p class="kl-eq">HI = known level + backsight<br>level = HI − reading</p>
        <ul>
          <li>At a change point, reduce the foresight from the <strong>old</strong> HI first, then add the new backsight to that
            level for the <strong>new</strong> HI.</li>
          <li>Only the backsight rows carry an HI.</li>
        </ul>
        <p>Worked: ${f3(b(0).rl)} + ${f3(b(0).bs)} = HI ${f3(b(0).hi)}. SG3: ${f3(b(0).hi)} − ${f3(b(1).is)} = ${f3(b(1).rl)}.
          CP1: ${f3(b(0).hi)} − ${f3(b(2).fs)} = ${f3(b(2).rl)}; then ${f3(b(2).rl)} + ${f3(b(2).bs)} = HI ${f3(b(2).hi)} for set-up 2.</p>
        <p>The levels must come out the same as by rise and fall. Both are worked from the same book.</p>`,
      recover: `
        <p>Run height of instrument backwards. Find the set-up's HI from any reading whose level you know, then the missing
          reading is the gap between the HI and the point's level.</p>
        <p class="kl-eq">HI = level + reading<br>missing reading = HI − level</p>
        <ul><li>A change point's foresight belongs to the <strong>old</strong> set-up's HI; its backsight to the <strong>new</strong> one.</li></ul>
        <p>Worked: in set-up 2, SG3 reads ${f3(b(3).is)} at ${f3(b(3).rl)}, so HI = ${f3(b(3).rl + b(3).is)}. CP1's backsight is
          ${f3(b(3).rl + b(3).is)} − ${f3(b(2).rl)} = ${f3(b(2).bs)}.</p>`,
      closure: `
        <p>Total the backsights, the foresights, the rises and the falls. Three numbers must agree:</p>
        <p class="kl-eq">ΣBack − ΣFore = ΣRise − ΣFall = last level − first level</p>
        <ul>
          <li>If they don't agree, the book has an arithmetic slip — find it before anything else.</li>
          <li>The <strong>misclose</strong> compares the closing sight on the benchmark with its known level: here the closing BMGS
            level less ${f3(BM_RL)}. Keep its sign.</li>
          <li>The exercise limit is <strong>1 + √n mm</strong>, where n counts the change points. Enter the limit to two decimals,
            but compare the misclose's size with the unrounded limit.</li>
          <li>Outside the limit, the levels aren't accepted: recheck the book, then re-survey.</li>
        </ul>
        <p class="small">The Level Survey sheet starts with a limit of ±${f3(L.TOL.misclose)} m and lets you set your site's figure.
          This exercise holds the run to its own ${(limit).toFixed(2)} mm, which this book (${cps} change points) doesn't meet.</p>`,
      cross: `
        <p>A cross-section books the same way, plus a distance for every sight, so each point gets a chainage along the section
          line as well as a level.</p>
        <ul>
          <li>Read all three hairs: upper, central and lower. The central hair gives the level, as before.</li>
          <li>Chainage increases towards the right bank. Level and staff stay on one straight section line.</li>
          <li>The first backsight anchors chainage zero, on BMXS. Each change-point backsight re-sets the instrument's chainage from
            the chainage saved for that contact.</li>
          <li>Readings to 0.001 m. Allowance on the hairs: ±0.001 m from 20 m, ±0.002 m from 30 m.</li>
        </ul>
        <p class="kl-eq">distance = (upper − lower) × 100<br>backsight: instrument chainage = point chainage ∓ distance<br>
          other sights: point chainage = instrument chainage ± distance</p>
        <p class="small">Add the distance when sighting towards the right bank, take it off towards the left (for the backsight it's the
          other way round). Assumes a horizontal sight, a vertical staff and a zero additive constant.</p>
        <p>Worked: BMXS, (${f3(xbook[0].u)} − ${f3(xbook[0].l)}) × 100 = ${f1(xbook[0].d)} m, sighting right, so the level stands at
          0.0 − ${f1(xbook[0].d)} = ${f1(xbook[0].inst)}; its HI is ${f3(XBM_RL)} + ${f3(xbook[0].c)} = ${f3(xbook[0].hi)}. LB:
          ${f1(xbook[1].d)} m right puts it at ${f1(xbook[0].inst)} + ${f1(xbook[1].d)} = ${f1(xbook[1].chain)}, level
          ${f3(xbook[0].hi)} − ${f3(xbook[1].c)} = ${f3(xbook[1].rl)}.</p>
        <figure class="kl-figure">${sectionSvg()}<figcaption class="small">The weir: concrete wings sealed against both banks, with a
          cut-out between chainage 5.5 and 8.5 m.</figcaption></figure>`,
    };
  }

  function render() {
    const T = lessons();
    const practice = {
      survey: `<div id="kl-survey-live">${bookingHtml()}</div>`,
      rise: `${sheet('rise')}${buttons('rise', 'Check levels')}`,
      hi: `${sheet('hi')}${buttons('hi', 'Check levels')}`,
      recover: `${sheet('recover')}${buttons('recover', 'Check readings')}`,
      closure: `${sheet('closure')}${buttons('closure', 'Check sums and closure')}`,
      cross: `${crossSheet()}${buttons('cross', 'Check the section')}`,
    };
    const ask = {
      survey: 'Choose Back, Inter or Fore, type what the central hair reads, and book it. The book fills in as you go.',
      rise: 'Fill the rise or fall, the gauge datum level and the AHD for every row after the first.',
      hi: 'Fill the HI on each backsight row, then the gauge datum level and AHD for every row after the first.',
      recover: 'Four readings are missing. Every level is given.',
      closure: 'Total the columns, then work out the misclose, the number of change points and the limit, and decide.',
      cross: 'The hairs and direction are given. Work out each distance, the instrument chainage on each backsight, and every chainage and level.',
    };
    return `<div class="page kl-page" style="--page-max:960px"><h2 class="sr-only">Survey Logbook</h2><div class="stack">
      <section class="panel kl-intro">
        <h3>📒 Booking and reducing a level run</h3>
        <p>Six short modules on the field book, all on one fictional gauging station: book the run as you read it, reduce it by rise
          and fall and by height of instrument, recover missing readings, close it, then book a weir cross-section from the three
          hairs. Each one is marked as you go.</p>
        <p>The station: <strong>BMGS</strong>, the benchmark at the top of the channel by the gauge range, at 3.650 m on the gauge
          datum; three gauge plates down the bank (<strong>SG3</strong> 2–3 m, <strong>SG2</strong> 1–2 m, <strong>SG1</strong> 0–1 m);
          the water; and <strong>CTR</strong>, the brass fitting where the sensor's conduit ends. Gauge zero is 42.000 m AHD.
          Two change points, three set-ups.</p>
        <nav aria-label="Logbook modules"><ol class="kl-toc">${MODULES.map(([id, title, what]) =>
          `<li><button type="button" class="link-btn" onclick="KbLogbook.go('${id}')">${esc(title)}</button>
            <span class="small">${esc(what)}</span> <span id="kl-st-${id}" class="kl-status">Not yet</span></li>`).join('')}</ol></nav>
        <p id="kl-all" class="kl-fb kl-good" role="status"></p>
        <div class="button-row"><button type="button" onclick="switchTab('levels')">📏 Level Survey</button>
          <button type="button" onclick="switchTab('surveyguide')">📖 How to Survey</button></div>
      </section>
      ${MODULES.map(([id, title], n) => `<section class="panel kl-mod" id="kl-sec-${id}" aria-labelledby="kl-h-${id}">
        <h3 id="kl-h-${id}" tabindex="-1">${n + 1}. ${esc(title)}</h3>
        <div class="kl-body">${T[id]}</div>
        <h4>Practice</h4>
        <p class="small">${esc(ask[id])}</p>
        <div id="kl-${id}" class="kl-drill">${practice[id]}</div>
      </section>`).join('')}
      ${KnowledgeBase.credit('logbook')}
    </div></div>`;
  }

  // A cell typed into loses its old mark.
  function onInput(e) {
    const el = e.target;
    if (el && el.classList && el.classList.contains('kl-in')) { el.removeAttribute('aria-invalid'); el.classList.remove('kl-ok'); }
  }

  function go(id) {
    const el = document.getElementById(`kl-sec-${id}`);
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    const h = document.getElementById(`kl-h-${id}`);
    if (h) h.focus({ preventScroll: true });
  }

  // Open a module from elsewhere in the app.
  function show(id) {
    pending = id;
    if (typeof state !== 'undefined' && state.activeTab === TAB) { const p = pending; pending = null; go(p); return; }
    switchTab(TAB);
  }

  function init() {
    load();
    paintProgress();
    const page = document.querySelector('.kl-page');
    if (page) { page.addEventListener('input', onInput); page.addEventListener('change', onInput); }
    if (pending) { const p = pending; pending = null; go(p); }
  }

  return { render, init, show, go, pick, book, move, hint, restart, check, answers, clear };
})();

if (typeof window !== 'undefined') window.KbLogbook = KbLogbook;
