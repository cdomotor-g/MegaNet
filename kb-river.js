// MegaNet — kb-river.js
//
//   KbRiver   🏞️ the A Day on the River tab: one routine visit to a river
//             gauging station, step by step, in the order the work is done —
//             arrive and stay on the track, book the staff gauge and the
//             logger before touching anything, survey the plate from the
//             benchmark, correct it, exchange the sensor that is due for
//             calibration, check the raw head at the gas-purge chamber, gauge
//             before touching the control, clear the control and let the pool
//             settle, book the departure pair, and what the record is marked
//             on. Each step has a drawing and a practice decision or reading,
//             marked as the original marks it. Adapted from Mallee HydroTech's
//             "Hydrographer: A Day on the River"
//             (github.com/MalleeHydroTech/hydrographer-day-on-the-river), a
//             3-D game: its station 425010, its figures (the 8 mm low plate,
//             the 0.456 m stage, RV-101 and RV-204, the 1.68 and 1.70 m³/s
//             gaugings, the 50 mm pool behind the log), its tolerances and
//             its marking text came across; the 3-D walk, the models, the
//             audio, the fishing spot, the optional discoveries and the shared
//             score board were left out.
//
// After core.js, knowledge-base.js and levelling.js (whose reduce() works the
// level book, so this tab and the Level Survey sheet cannot disagree about a
// sum), before init.js. Reaches back to core.js for esc/escAttr/announce and
// to app.js for switchTab. Nothing runs at load.
//
// Progress (the step, the answers, the plate) is a per-device convenience in
// localStorage under floodnet-kb-river; every access is wrapped, and the tab
// works the same without it.

const KbRiver = (function () {
  const TAB = 'kbriver';
  const KEY = 'floodnet-kb-river';

  // The original's fixture, in metres. Its own words: "authored training
  // fixtures", and the 1 mm / 5 min / 2 mm / 0.1 V limits are "scenario design
  // assumptions, not an operating standard or measurement uncertainty".
  const F = {
    station: '425010', name: 'Red Gum Reach', date: '2026-09-09', start: '08:40',
    gaugeZeroAhd: 100.000,
    bm: 3.000, tbm: 2.500,
    stage: 0.456, settled: 0.406, plateRead: 0.464, plateMark: 0.992, step: 0.008,
    orifice: -0.250, gcoTop: -0.140, gcoCorr: 0.110,
    battery: 13.2, solar: 18.4,
    adv: 1.68, adcp: 1.70, unc: 5,
    readTol: 0.001, pairMin: 5, headTol: 0.002, battTol: 0.1, tempMax: 2,
    maxMoves: 8,
  };
  const rating = h => (h <= 0.1 ? 0 : 10 * Math.pow(h - 0.1, 1.5));

  let step = 0;
  let answers = {};
  let plate = { adj: 0, moves: 0, downs: 0, prev: null, msg: '' };
  let stepCache = null;

  const m3 = v => (typeof Levelling !== 'undefined' ? Levelling.fmt(v, 3) : Number(v).toFixed(3));

  // ── Drawings ───────────────────────────────────────────────────────────────

  function svg(label, viewBox, inner, cls = '') {
    return `<svg class="kr-svg ${cls}" viewBox="${viewBox}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${inner}</svg>`;
  }

  // The site as the game lays it out (its world plan, scaled down): the track
  // from the vehicle to the benchmark, the shelter and the river; the far bank
  // reached only at the crossing; the long grass the snake lives in.
  const SITES = {
    vehicle: [57.5, 51.7, 'Vehicle', 57.5, 62, 'middle'],
    benchmark: [90.7, 48.6, 'BMGS425010', 90.7, 42, 'middle'],
    shelter: [111.9, 67.5, 'Shelter', 104, 74, 'end'],
    tbm: [120.4, 78.3, 'TBM 01', 116, 88, 'end'],
    gauge: [154, 104.3, 'Staff gauge', 145, 107, 'end'],
    shallow: [163.6, 47.8, 'Wading (ADV)', 203, 46, 'start'],
    deep: [158.7, 80.3, 'Deep (ADCP)', 215, 84, 'start'],
    control: [161.7, 124.3, 'Control', 154, 127, 'end'],
  };
  function siteMap(here = []) {
    const west = [[183, 0], [162.5, 19.2], [169.6, 38.3], [165.4, 57.5], [164.2, 76.7], [155.8, 95.8], [160.4, 114.6], [164.6, 124.3], [177.9, 133.9], [199.2, 152.9]];
    const east = [[195.8, 0], [193.3, 19.2], [192.5, 38.3], [195.8, 57.5], [207.5, 76.7], [213.3, 95.8], [224.2, 114.6], [228.3, 124.3], [235.4, 133.9], [254.6, 152.9]];
    const river = [...west, ...east.reverse()].map(p => p.join(',')).join(' ');
    const S = SITES;
    const track = [['vehicle', 'benchmark'], ['benchmark', 'shelter'], ['shelter', 'deep'], ['deep', 'shallow'], ['shelter', 'gauge'], ['gauge', 'control']]
      .map(([a, b]) => `<line x1="${S[a][0]}" y1="${S[a][1]}" x2="${S[b][0]}" y2="${S[b][1]}" class="kr-track"/>`).join('');
    const leaders = ['shallow', 'deep'].map(k => `<line x1="${S[k][0]}" y1="${S[k][1]}" x2="${S[k][3] - 2}" y2="${S[k][4] - 3}" class="kr-leader"/>`).join('');
    const marks = Object.entries(S).map(([k, [x, y, lab, lx, ly, a]]) => {
      const on = here.includes(k);
      return `${on ? `<circle cx="${x}" cy="${y}" r="6" class="kr-here"/>` : ''}<circle cx="${x}" cy="${y}" r="2.4" class="kr-pt${on ? ' kr-pt-on' : ''}"/>
        <text x="${lx}" y="${ly}" text-anchor="${a}" class="kr-ts${on ? ' kr-tb' : ''}">${lab}</text>`;
    }).join('');
    return svg(`Site plan of ${F.name}: the track from the vehicle past benchmark BMGS425010 to the shelter, TBM 01 and the staff gauge on the near bank; the wading and deep gauging sections upstream, the control downstream, the crossing below it, long grass off the track.${here.length ? ` This step: ${here.map(k => S[k][2]).join(', ')}.` : ''}`,
      '40 20 222 128', `
      <polygon points="${river}" class="kr-water"/>
      <rect x="158.3" y="120.8" width="93.3" height="12.1" class="kr-crossing"/>
      <text x="212" y="141" text-anchor="middle" class="kr-ts">Crossing</text>
      <ellipse cx="142" cy="30" rx="16" ry="7" class="kr-grass"/>
      <text x="142" y="32.5" text-anchor="middle" class="kr-ts">long grass</text>
      ${track}${leaders}${marks}`, 'kr-map');
  }

  // A 0–1 m flat staff-gauge plate (10 mm divisions, as the original's
  // Australian flat staff gauge), a 100 mm window of it around the waterline.
  function plateSvg(readM, label) {
    const r = Math.round(readM * 1000);
    const lo = Math.floor((r - 50) / 10) * 10, hi = lo + 100;
    const Y = mm => 20 + (hi - mm) * 2.4;
    let marks = '';
    for (let m = lo; m <= hi; m += 5) {
      const y = Y(m), cm = m % 10 === 0, dm = m % 100 === 0;
      marks += `<line x1="72" x2="${dm ? 128 : cm ? 110 : 90}" y1="${y}" y2="${y}" class="kr-tick${dm ? ' kr-tick-dm' : ''}"/>`;
      if (cm) marks += `<text x="134" y="${y + 3}" class="kr-ts${dm ? ' kr-tb' : ''}">${(m / 1000).toFixed(2)}</text>`;
    }
    const wy = Y(r);
    const below = Math.floor(r / 10) * 10;
    return svg(label || `Staff gauge plate, enlarged, 10 mm divisions with a half mark at 5 mm: the water surface meets the plate ${r - below} mm above the ${(below / 1000).toFixed(2)} m mark. Read it to the millimetre.`,
      '0 0 200 280', `
      <rect x="58" y="6" width="12" height="270" class="kr-post"/>
      <rect x="70" y="10" width="60" height="266" class="kr-plate"/>
      ${marks}
      <rect x="14" y="${wy}" width="180" height="${276 - wy}" class="kr-water"/>
      <path d="M14 ${wy} H194" class="kr-wline"/>
      <text x="18" y="${wy - 5}" class="kr-ts">water</text>`, 'kr-plate-svg');
  }

  function loggerSvg(rows, label) {
    const h = 34 + rows.length * 22;
    const lines = rows.map(([k, v], i) => `<text x="22" y="${42 + i * 22}" class="kr-t">${k}</text><text x="214" y="${42 + i * 22}" text-anchor="end" class="kr-t kr-mono">${v}</text>`).join('');
    return svg(label || `Logger display: ${rows.map(r => `${r[0]} ${r[1]}`).join(', ')}.`, `0 0 236 ${h + 10}`, `
      <rect x="4" y="4" width="228" height="${h}" rx="8" class="kr-case"/>
      <rect x="12" y="20" width="212" height="${h - 24}" rx="3" class="kr-lcd"/>
      <text x="14" y="15" class="kr-ts kr-tb">iRIS 270 · ${F.station}</text>${lines}`, 'kr-logger');
  }

  // Setup 1 of the run, side on: the level, its line of sight at HI 4.500,
  // the backsight on the benchmark and the intermediate on the plate's top mark.
  function levelSvg() {
    const Y = rl => 200 - rl * 40;
    return svg('Setup 1, side on: the level stands between benchmark BMGS425010 (3.000 m on the gauge) and the staff gauge. Its line of sight is at 4.500 m: backsight 1.500 on the benchmark, intermediate 3.508 on the plate\'s 1.000 m mark, which puts that mark at 0.992 m. TBM 01 (2.500 m) on the bank is the change point to setup 2.',
      '0 0 300 210', `
      <rect x="222" y="${Y(F.stage)}" width="78" height="${210 - Y(F.stage)}" class="kr-water"/>
      <path d="M0 ${Y(3)} L130 ${Y(2.95)} L170 ${Y(2.5)} L212 ${Y(1.2)} L232 ${Y(0.2)} L300 ${Y(0)}" class="kr-ground"/>
      <line x1="0" y1="${Y(4.5)}" x2="300" y2="${Y(4.5)}" class="kr-sight"/>
      <rect x="17" y="${Y(4.5) - 6}" width="6" height="${Y(3) - Y(4.5) + 6}" class="kr-staff"/>
      <rect x="16" y="${Y(3)}" width="8" height="4" class="kr-mark"/>
      <line x1="120" y1="${Y(4.5) + 4}" x2="108" y2="${Y(2.95)}" class="kr-leg"/><line x1="120" y1="${Y(4.5) + 4}" x2="132" y2="${Y(2.95)}" class="kr-leg"/>
      <rect x="111" y="${Y(4.5) - 5}" width="18" height="9" rx="2" class="kr-inst"/>
      <circle cx="170" cy="${Y(2.5) - 2}" r="3" class="kr-mark"/>
      <rect x="234" y="${Y(1 - F.step)}" width="9" height="${Y(-F.step) - Y(1 - F.step)}" class="kr-plate"/>
      <rect x="235.5" y="${Y(4.5) - 8}" width="6" height="${Y(1 - F.step) - Y(4.5) + 8}" class="kr-staff"/>
      <path d="M222 ${Y(F.stage)} H300" class="kr-wline"/>
      <text x="4" y="${Y(3) + 16}" class="kr-ts">BMGS425010 · 3.000</text>
      <text x="27" y="${Y(3.75)}" class="kr-ts kr-mono">BS 1.500</text>
      <text x="58" y="${Y(4.5) - 5}" class="kr-ts kr-tb">HI 4.500</text>
      <text x="245" y="${Y(2.75)}" class="kr-ts kr-mono">IS 3.508</text>
      <text x="244" y="${Y(1) + 3}" class="kr-ts">1.000 mark</text>
      <text x="170" y="${Y(2.5) - 9}" text-anchor="middle" class="kr-ts">TBM 01 (CP)</text>
      <text x="296" y="${Y(F.stage) + 13}" text-anchor="end" class="kr-ts">water</text>`);
  }

  function cabinetSvg() {
    return svg('The shelter cabinet: the iRIS 270 logger, the HS40 gas-purge bubbler and pressure sensor RV-101, whose certificate fell due on 2026-09-08, the day before the visit. In the vehicle: spare sensor RV-204, certificate current to 2027-09-09.',
      '0 0 300 170', `
      <rect x="6" y="6" width="186" height="158" rx="4" class="kr-case"/>
      <text x="12" y="19" class="kr-ts kr-tb">Shelter cabinet</text>
      <rect x="14" y="26" width="92" height="44" rx="3" class="kr-lcd"/>
      <text x="20" y="41" class="kr-ts">iRIS 270</text><text x="100" y="60" text-anchor="end" class="kr-t kr-mono">0.456 m</text>
      <rect x="114" y="26" width="70" height="66" rx="3" class="kr-box"/>
      <text x="149" y="40" text-anchor="middle" class="kr-ts">HS40</text>
      <circle cx="140" cy="58" r="3" class="kr-bubble"/><circle cx="150" cy="70" r="2.5" class="kr-bubble"/><circle cx="143" cy="81" r="2" class="kr-bubble"/>
      <rect x="14" y="80" width="92" height="76" rx="3" class="kr-box kr-due"/>
      <text x="20" y="96" class="kr-t kr-tb">RV-101</text>
      <text x="20" y="111" class="kr-ts">pressure sensor</text>
      <text x="20" y="127" class="kr-ts kr-bad-t">cert due</text>
      <text x="20" y="140" class="kr-ts kr-bad-t kr-mono">2026-09-08</text>
      <rect x="208" y="58" width="86" height="106" rx="4" class="kr-case"/>
      <text x="214" y="71" class="kr-ts kr-tb">Vehicle</text>
      <rect x="214" y="80" width="74" height="76" rx="3" class="kr-box kr-current"/>
      <text x="220" y="96" class="kr-t kr-tb">RV-204</text>
      <text x="220" y="111" class="kr-ts">spare</text>
      <text x="220" y="127" class="kr-ts kr-ok-t">cert due</text>
      <text x="220" y="140" class="kr-ts kr-ok-t kr-mono">2027-09-09</text>
      <path d="M210 118 H112" class="kr-arrow"/><path d="M118 113 L110 118 L118 123" class="kr-arrow"/>`);
  }

  // The fixed gas-purge chamber (GCO): its top is 0.140 m below gauge zero and
  // its active interface 0.110 m lower, at the orifice datum, −0.250 m.
  function gcoSvg(stage = F.stage) {
    const Y = rl => 30 + (0.5 - rl) * 250;
    const above = stage - F.gcoTop, head = stage - F.orifice;
    return svg(`The gas-purge chamber (GCO), side on. Water at ${m3(stage)} m on the gauge. A tape from the chamber's top (−0.140 m) to the water reads ${m3(above)} m; the chamber's interface is 0.110 m below its top, at the orifice datum (−0.250 m), so the raw head is ${m3(head)} m.`,
      '0 0 300 240', `
      <rect x="0" y="${Y(stage)}" width="300" height="${236 - Y(stage)}" class="kr-water"/>
      <path d="M0 ${Y(stage)} H300" class="kr-wline"/>
      <path d="M0 236 L300 236" class="kr-ground"/>
      <line x1="0" y1="${Y(0)}" x2="300" y2="${Y(0)}" class="kr-datum"/>
      <text x="4" y="${Y(0) - 4}" class="kr-ts">gauge zero 0.000</text>
      <rect x="112" y="${Y(F.gcoTop)}" width="40" height="${Y(F.orifice) - Y(F.gcoTop)}" class="kr-box"/>
      <line x1="122" y1="${Y(F.orifice)}" x2="122" y2="236" class="kr-leg"/><line x1="142" y1="${Y(F.orifice)}" x2="142" y2="236" class="kr-leg"/>
      <path d="M112 ${Y(F.gcoTop) + 6} H92 V20" class="kr-tube"/>
      <text x="96" y="18" class="kr-ts">river line to HS40</text>
      <line x1="80" y1="${Y(F.gcoTop)}" x2="112" y2="${Y(F.gcoTop)}" class="kr-datum"/>
      <line x1="80" y1="${Y(F.orifice)}" x2="112" y2="${Y(F.orifice)}" class="kr-datum"/>
      <line x1="166" y1="${Y(F.gcoTop)}" x2="166" y2="${Y(stage)}" class="kr-tape"/>
      <text x="171" y="${(Y(F.gcoTop) + Y(stage)) / 2}" class="kr-ts kr-mono">tape ${m3(above)}</text>
      <line x1="166" y1="${Y(F.gcoTop)}" x2="166" y2="${Y(F.orifice)}" class="kr-leg"/>
      <text x="171" y="${Y(F.orifice) - 6}" class="kr-ts kr-mono">+0.110</text>
      <line x1="262" y1="${Y(F.orifice)}" x2="262" y2="${Y(stage)}" class="kr-sightline"/>
      <text x="258" y="${Y(0.32)}" text-anchor="end" class="kr-ts kr-tb">raw head ${m3(head)}</text>
      <text x="132" y="${(Y(F.gcoTop) + Y(F.orifice)) / 2 + 3}" text-anchor="middle" class="kr-ts kr-tb">GCO</text>
      <text x="4" y="${Y(F.gcoTop) + 3}" class="kr-ts">GCO top −0.140</text>
      <text x="4" y="${Y(F.orifice) + 3}" class="kr-ts">orifice −0.250</text>`);
  }

  function gaugingSvg() {
    return svg('Two gauging sections in cross-section. Left, the wading section: max depth 0.35 m, velocity 0.40 m/s, firm bed — an ADV (FlowTracker2) on a wading rod. Right, the deep section: max depth 1.4 m — an ADCP on a tethered float, after its configuration and moving-bed checks.',
      '0 0 300 150', `
      <path d="M8 46 Q70 78 132 46 Z" class="kr-water"/><path d="M8 46 H132" class="kr-wline"/>
      <path d="M2 38 L8 46 Q70 78 132 46 L138 38" class="kr-ground"/>
      <line x1="70" y1="20" x2="70" y2="62" class="kr-leg"/><rect x="66" y="55" width="12" height="5" class="kr-inst"/>
      <circle cx="58" cy="16" r="4" class="kr-person"/><path d="M58 20 V40 M58 40 L52 56 M58 40 L64 56 M58 26 L70 30" class="kr-leg"/>
      <text x="70" y="84" text-anchor="middle" class="kr-ts kr-tb">Wading section · ADV</text>
      <text x="70" y="96" text-anchor="middle" class="kr-ts">depth 0.35 m · 0.40 m/s</text>
      <path d="M158 46 Q226 130 294 46 Z" class="kr-water"/><path d="M158 46 H294" class="kr-wline"/>
      <path d="M152 38 L158 46 Q226 130 294 46 L298 38" class="kr-ground"/>
      <path d="M212 40 H240 L236 47 H216 Z" class="kr-inst"/>
      <path d="M220 47 L208 80 M232 47 L244 80" class="kr-beam"/>
      <path d="M152 36 Q190 30 214 40" class="kr-tube"/>
      <text x="226" y="112" text-anchor="middle" class="kr-ts kr-tb">Deep section · ADCP</text>
      <text x="226" y="124" text-anchor="middle" class="kr-ts">max depth 1.4 m</text>`);
  }

  function controlSvg() {
    const Y = rl => 140 - (rl - 0.25) * 500;
    return svg('The control, side on, looking across the river: a bedrock bar with a loose log lying on it. With the log, the pool upstream stands at 0.456 m on the gauge, spilling over the log; once the log is removed and the pool has drained and settled, it stands at 0.406 m — 50 mm lower.',
      '0 0 300 150', `
      <path d="M0 ${Y(F.stage)} H158 Q176 ${Y(F.stage)} 186 ${Y(0.42)} Q205 ${Y(0.3)} 300 ${Y(0.27)} V150 H0 Z" class="kr-water"/>
      <path d="M0 ${Y(F.stage)} H158 Q176 ${Y(F.stage)} 186 ${Y(0.42)} Q205 ${Y(0.3)} 300 ${Y(0.27)}" class="kr-wline"/>
      <line x1="0" y1="${Y(F.settled)}" x2="166" y2="${Y(F.settled)}" class="kr-settled"/>
      <path d="M0 146 L120 140 L158 ${Y(0.38)} L192 ${Y(0.38)} L215 ${Y(0.3)} L300 ${Y(0.26)} V150 H0 Z" class="kr-rock"/>
      <circle cx="174" cy="${Y(0.38) - 11}" r="11" class="kr-log"/>
      <text x="6" y="${Y(F.stage) - 5}" class="kr-ts kr-mono">with the log 0.456</text>
      <text x="6" y="${Y(F.settled) + 12}" class="kr-ts kr-mono">log removed, settled 0.406</text>
      <text x="196" y="${Y(0.38) - 18}" class="kr-ts kr-tb">loose log</text>
      <text x="226" y="146" class="kr-ts">bedrock bar</text>
      <text x="294" y="14" text-anchor="end" class="kr-ts">flow →</text>`);
  }

  const RUBRIC = [
    ['Arrival observations', 60], ['Plate datum', 280], ['Pre-clear gauging', 100], ['Obstructed control', 200],
    ['Instrument checks and exchange', 200], ['Photographic evidence', 100], ['Departure observations', 60],
  ];
  function rubricSvg() {
    const rows = RUBRIC.map(([k, v], i) => `<text x="4" y="${20 + i * 22}" class="kr-ts">${k}</text>
      <rect x="162" y="${10 + i * 22}" width="${v / 280 * 108}" height="13" class="kr-bar"/>
      <text x="${166 + v / 280 * 108}" y="${20 + i * 22}" class="kr-ts kr-mono">${v}</text>`).join('');
    return svg(`How the original marks a visit, out of 1000: ${RUBRIC.map(([k, v]) => `${k} ${v}`).join(', ')}.`, `0 0 300 ${RUBRIC.length * 22 + 8}`, rows);
  }

  // ── The visit ──────────────────────────────────────────────────────────────

  function levelBook() {
    if (typeof Levelling === 'undefined') return '';
    const L = Levelling;
    const doc = L.blankSurvey({ datum: 'LGH', practice: true, station: { number: F.station, name: F.name } });
    doc.bm = Object.assign(doc.bm, { name: 'BMGS425010', rl: F.bm });
    doc.gauge_zero = { rl: F.gaugeZeroAhd, source: 'Site record', from_row: null };
    const R = (kind, name, s, extra, remark) => L.blankRow(kind, Object.assign({ name, desc: remark }, s, extra || {}));
    doc.rows = [
      R('bm', 'BMGS425010', { bs: 1.5 }, null, 'Recessed survey pin beneath hinged cover, 14 m NW of shelter.'),
      R('board', 'SG1', { is: 3.508 }, { face: 1 }, '1.000 m graduation on the 0–1 m plate, western bank.'),
      R('water', 'WL1', { is: 4.044 }, null, 'Water surface beside the staff gauge.'),
      R('cp', 'TBM 01', { fs: 2.0, bs: 1.5 }, null, 'Top centre of bolt in exposed bedrock, 12 m SE of shelter. Change point.'),
      R('board', 'SG1', { is: 3.008 }, { face: 1 }, 'Same 1.000 m graduation.'),
      R('water', 'WL1', { is: 3.544 }, null, 'Water surface beside the staff gauge.'),
      R('bm', 'BMGS425010', { fs: 1.0 }, null, 'Close on the same recessed pin.'),
    ];
    const red = L.reduce(doc);
    const f = v => (v == null ? '' : L.fmt(v, 3));
    const board = red.boards[0];
    return `<div class="table-wrap" role="region" aria-label="The level book" tabindex="0"><table class="kr-book">
      <caption>Level book, ${F.station} ${esc(F.name)} — gauge datum, gauge zero ${f(F.gaugeZeroAhd)} m AHD</caption>
      <thead><tr>${['No.', 'Point', 'BS', 'IS', 'FS', 'Rise', 'Fall', 'Gauge', 'AHD', 'Remarks'].map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead>
      <tbody>${doc.rows.map((r, i) => { const o = red.rows[i];
        return `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${f(o.bs)}</td><td>${f(o.is)}</td><td>${f(o.fs)}</td><td>${f(o.rise)}</td><td>${f(o.fall)}</td>
          <td>${f(o.lgh)}</td><td>${f(o.ahd)}</td><td class="kr-remark">${esc(r.desc)}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr><th scope="row">Σ</th><td></td><td>${f(red.sums.bs)}</td><td></td><td>${f(red.sums.fs)}</td><td>${f(red.sums.rise)}</td><td>${f(red.sums.fall)}</td><td colspan="3"></td></tr></tfoot>
    </table></div>
    <p class="small">ΣBS − ΣFS = ${L.signed(red.checks.bsfs)}, ΣRise − ΣFall = ${L.signed(red.checks.risefall)}, closure ${L.signed(red.misclose)} m: the book closes.
      SG1's 1.000 m mark comes out at ${f(board.lgh)} — ${L.signed(board.error)} m against its face value, outside the ±${f(L.TOL.board)} m that Flood-Net's
      Level Survey sheet starts its board limit at, so the sheet would flag it too.</p>`;
  }

  // Each step: where on site, what the original has you do, a drawing, and
  // the practice checks. Choice answers are option indexes; numbers are in the
  // unit named, marked within `tol`.
  function steps() {
    if (stepCache) return stepCache;
    stepCache = [
      {
        id: 'arrive', title: 'Arrive and stay on the track', here: ['vehicle'],
        figs: () => '',
        body: () => `
          <p>Station ${F.station}, ${esc(F.name)}, ${F.start} on ${F.date}. The game's opening line: <em>“Routine site visits rarely turn out
            routine. Can you pick up all the problems?”</em> Nobody hands you a list — there are four, and you find them by looking.</p>
          <ul>
            <li><strong>Walk the track.</strong> It runs from the vehicle past the benchmark to the shelter, the staff gauge, the gauging
              sections and the control. Step off it into the long grass and the visit ends: <em>“You stepped on a snake.”</em></li>
            <li><strong>Cross the river only at the crossing</strong> below the control.</li>
            <li><strong>Inspect a thing before you use it</strong> — the gauge, the shelter, each mark, each section.</li>
            <li><strong>Record before you change.</strong> Moving the plate, clearing the control and swapping the sensor each change the
              site; anything read before a change describes the old site, not this one.</li>
            <li>Everything else — level kit, staff and tape, ADV and ADCP, field meter, the spare sensor — is in the vehicle. Take what the
              next job needs and bring it back.</li>
          </ul>`,
        checks: [
          { id: 'first', type: 'choice', q: 'You have parked. What comes first?',
            opts: ['Clear the log off the control while the light is good.',
              'Walk to the gauge and the shelter and book the staff gauge and logger readings, before changing anything.',
              'Swap the sensor first — its certificate is due.'],
            ans: 1, ok: 'Right. Arrival readings come before anything that changes the site, and both within five minutes of each other.',
            no: 'Record the staff reading and the logger reading in Arrival before changing the plate, control or sensor.' },
          { id: 'grass', type: 'choice', q: 'The quickest line from the benchmark to the river is straight through the long grass. Take it?',
            opts: ['Yes — it saves a few minutes.', 'No — stay on the track.'],
            ans: 1, ok: 'Stay on the track. In the game the short cut is where the snake is.',
            no: 'You stepped on a snake. This visit is over.' },
        ],
      },
      {
        id: 'arrival', title: 'Arrival readings: staff gauge and logger', here: ['gauge', 'shelter'],
        figs: () => `<figure>${plateSvg(F.plateRead)}<figcaption class="small">The staff gauge on arrival, enlarged.</figcaption></figure>
          <figure>${loggerSvg([['Water level', `${m3(F.stage)} m`], ['Battery', `${F.battery.toFixed(1)} V`], ['Solar', `${F.solar.toFixed(1)} V`]])}<figcaption class="small">The logger in the shelter.</figcaption></figure>`,
        body: () => `
          <p>Book a <strong>pair</strong>: the staff gauge, read by eye at the water's edge, and the logger's water level, read at the shelter.
            The field book takes metres to three places (0.500, not 0.5). The game marks a reading right within <strong>1 mm</strong> and a pair
            “close” within <strong>${F.pairMin} minutes</strong>, in either order — its own design figures, not a standard.</p>
          <p>Photograph the gauge as you found it, before the plate or the control is touched. That photo can't be taken later.</p>`,
        checks: [
          { id: 'staff', type: 'number', unit: 'm', q: 'Read the staff gauge to the millimetre.', ans: F.plateRead, tol: F.readTol,
            ok: 'The initial plate reads 0.464 m.', no: 'Count up from the 0.46 mark: the water sits a little under halfway to 0.47.' },
          { id: 'diff', type: 'number', unit: 'm', q: 'Staff minus logger, in metres (with its sign)?', ans: F.step, tol: 0.0005,
            ok: '+0.008 m: the board reads 8 mm higher than the logger.', no: '0.464 − 0.456.' },
          { id: 'next', type: 'choice', q: 'The board and the logger disagree by 8 mm. What now?',
            opts: ['Lower the plate 8 mm so it agrees with the logger.',
              'Change the logger\'s offset so it agrees with the board.',
              'Book both, photograph the gauge as found, and survey the plate from the benchmark before moving anything.'],
            ans: 2, ok: 'Survey the plate before moving it. Until it is levelled, nothing says which of the two is wrong.',
            no: 'Neither instrument is proven yet. Survey the plate before moving it — and record both level setups and close to BMGS425010.' },
        ],
      },
      {
        id: 'survey', title: 'Survey the plate from the benchmark', here: ['benchmark', 'tbm', 'gauge'],
        figs: () => `<figure>${levelSvg()}<figcaption class="small">Setup 1. Setup 2 reads back from TBM 01 at HI 4.000.</figcaption></figure>`,
        body: () => `
          <p>Take the level kit from the vehicle. The marks, from the site record:</p>
          <ul>
            <li><strong>BMGS425010</strong> — the permanent mark, a recessed survey pin beneath a hinged cover, 14 m NW of the shelter:
              ${m3(F.bm)} m on the gauge, ${m3(F.gaugeZeroAhd + F.bm)} m AHD.</li>
            <li><strong>TBM 01</strong> — a temporary reference, a bolt in exposed bedrock 12 m SE of the shelter: ${m3(F.tbm)} m
              (${m3(F.gaugeZeroAhd + F.tbm)} m AHD). Here it is the change point; keep the staff on the same bolt.</li>
          </ul>
          <p>Two setups. Open with a backsight on BMGS425010; from each setup read the plate's 1.000 m graduation and the water beside
            it; carry the level through TBM 01; close with a foresight on BMGS425010. Level the instrument and plumb the staff before each
            sight — move a setup and its sights are archived and read again. A staff can't stand on water, so in the game it stands on the bed
            at the edge and you add the depth read on it.</p>
          ${levelBook()}
          <p>The water level agrees with the logger. The plate is the one that is out: its graduations sit 8 mm low.</p>
          <p><button type="button" onclick="switchTab('levels')">📏 Book a survey in Level Survey</button>
            <button type="button" onclick="switchTab('surveyguide')">📖 How to Survey</button></p>`,
        checks: [
          { id: 'mark', type: 'number', unit: 'm', q: 'Setup 1: HI 4.500, the staff on the plate\'s 1.000 m graduation reads 3.508. What level is that graduation on the gauge?',
            ans: F.plateMark, tol: 0.0005, ok: '0.992 m — the 1.000 m mark is 8 mm low, so every graduation on the plate is 8 mm low.', no: 'HI minus the reading: 4.500 − 3.508.' },
          { id: 'wl', type: 'number', unit: 'm', q: 'Same setup, the water reads 4.044. Water level on the gauge?',
            ans: F.stage, tol: 0.0005, ok: '0.456 m — what the logger says. The logger is right; the plate is not.', no: '4.500 − 4.044.' },
          { id: 'tbmonly', type: 'choice', q: 'Your run opened and closed on TBM 01 and closed to the millimetre. Good enough?',
            opts: ['Yes — it closed.', 'No — open and close on the permanent mark, BMGS425010; TBM 01 is the change point.'],
            ans: 1, ok: 'The survey should refer to the permanent benchmark. A run on TBM 01 never implies BMGS425010 was occupied or checked.',
            no: 'TBM 01 established the offset. Refer the survey to permanent BMGS425010 for the remaining 25 marks.' },
        ],
      },
      {
        id: 'plate', title: 'Correct the plate, then check it', here: ['gauge'], plate: true,
        figs: () => '',
        body: () => `
          <p>The plate is mounted on slotted bolts and moves in 8 mm steps. The survey says its graduations are 8 mm low, so the plate goes
            <strong>up</strong> — and then the result is checked with a <strong>fresh</strong> pair, never the arrival one.</p>
          ${plateBlock()}
          <p>Each movement is a change to the site: it voids every staff and logger comparison taken before it. Book an intermediate
            staff/logger pair after correcting the plate, before the control is touched, and photograph the corrected gauge.</p>`,
        checks: [
          { id: 'fresh', type: 'number', unit: 'm', q: 'With the plate corrected, what should the fresh staff and logger pair both read?',
            ans: F.stage, tol: F.readTol, ok: 'Both should read 0.456 m.', no: 'The plate now agrees with the gauge datum, and the water has not moved.' },
          { id: 'reuse', type: 'choice', q: 'Can the arrival logger reading stand in for the logger half of that check?',
            opts: ['Yes — the logger hasn\'t changed.', 'No — record a fresh close pair after the last change.'],
            ans: 1, ok: 'Record a fresh staff and logger comparison before relying on the result.',
            no: 'The arrival pair describes the site before the plate moved. Record a close intermediate pair after correcting the plate.' },
        ],
      },
      {
        id: 'cabinet', title: 'The cabinet: sensor due for calibration', here: ['shelter', 'vehicle'],
        figs: () => `<figure>${cabinetSvg()}<figcaption class="small">Inside the shelter, and the spare in the vehicle.</figcaption></figure>`,
        body: () => `
          <p>The shelter holds the iRIS 270 logger, the HS40 gas-purge bubbler and the water-level pressure sensor, with its certificate
            label and the site record. Check the sensor's identity and certificate: <strong>RV-101</strong>, due <strong>2026-09-08</strong> — yesterday.
            The spare in the vehicle, <strong>RV-204</strong>, is current to 2027-09-09.</p>
          <ol>
            <li>Photograph the cabinet with RV-101 in it.</li>
            <li>Take RV-204 from the vehicle; exchange the sensors.</li>
            <li>Check the installed sensor.</li>
            <li>Photograph the cabinet with RV-204 in it.</li>
            <li>Return RV-101 to the vehicle, tagged out of service for calibration.</li>
          </ol>
          <p>Read the logger too: battery ${F.battery.toFixed(1)} V (the game wants it within ${F.battTol} V), solar ${F.solar.toFixed(1)} V, and the
            instrument's <strong>raw head</strong> — the water above the orifice, not the gauge height. The orifice datum is −0.250 m on the gauge,
            and a sensor exchange leaves it where it is.</p>
          <p class="small">The HS40's bubble-rate test runs with River Line closed and Calibrate open, the test orifice in a beaker; a purge closes
            before the receiver falls below 400 kPa, and the river line opens only once it has recovered. The game's drain rates and waits are its own,
            not the manufacturer's.</p>
          <p><button type="button" onclick="switchTab('maintenance')">🛠️ Maintenance</button>
            <button type="button" onclick="switchTab('inspections')">📋 Inspections (gas bubbler section)</button>
            <button type="button" onclick="switchTab('health')">🩺 Station Health (battery and solar)</button></p>`,
        checks: [
          { id: 'rv101', type: 'choice', q: 'RV-101 is reading sensibly against the survey. What do you do with it?',
            opts: ['Leave it — it is working.', 'Exchange it for RV-204, check the installation, and return RV-101 tagged out of service.',
              'Take it out and leave the site without a sensor until it comes back.'],
            ans: 1, ok: 'Replace RV-101, due for routine calibration, with the current-certificate spare RV-204 — then check the replacement and retain the removed sensor.',
            no: 'Replace RV-101, due for routine calibration, with the current-certificate spare RV-204.' },
          { id: 'raw', type: 'number', unit: 'm', q: 'The logger shows water level 0.456 m; the orifice datum is −0.250 m. What raw head should the instrument show?',
            ans: F.stage - F.orifice, tol: F.headTol, ok: '0.706 m. Raw head is different from gauge height.', no: 'Water level minus the orifice datum: 0.456 − (−0.250).' },
        ],
      },
      {
        id: 'gco', title: 'Check the raw head at the GCO', here: ['gauge'],
        figs: () => `<figure>${gcoSvg()}<figcaption class="small">The fixed chamber on its driven galvanised posts.</figcaption></figure>`,
        body: () => `
          <p>An independent check of what the sensor reports. The river line ends in a fixed gas-purge chamber (GCO) on driven posts. Measure
            the water's height above the <strong>top</strong> of the chamber with a metric tape or survey staff, add this site's <strong>0.110 m</strong>
            correction (top to the interface), and compare that corrected raw head with the instrument's raw head read at the same state of the site.
            The game wants both accurate, and agreeing within <strong>2 mm</strong>.</p>
          <p class="small">The 0.110 m is this site's figure. The original notes that a chamber's overall dimensions don't set its top-to-interface
            offset for every real GCO.</p>`,
        checks: [
          { id: 'tape', type: 'number', unit: 'm', q: 'The tape reads 0.596 m from the chamber top to the water. Corrected raw head?',
            ans: F.stage - F.orifice, tol: 0.0005, ok: '0.596 + 0.110 = 0.706 m.', no: 'Add the 0.110 m from the top to the interface.' },
          { id: 'compare', type: 'choice', q: 'What do you compare that 0.706 m with?',
            opts: ['The gauge height, 0.456 m.', 'The instrument\'s raw head read at the same state of the site.', 'The staff gauge reading.'],
            ans: 1, ok: 'Both heads must be accurate and agree within 2 mm — here 0.706 and 0.706.',
            no: 'Raw head is different from gauge height. Compare with a recorded raw instrument reading from the same site revision.' },
        ],
      },
      {
        id: 'gauge', title: 'Gauge the flow before touching the control', here: ['shallow', 'deep'],
        figs: () => `<figure>${gaugingSvg()}<figcaption class="small">Pick the method for the section.</figcaption></figure>`,
        body: () => `
          <p>Two sections, each with its method. The wading section is a straight calm reach, max depth 0.35 m, velocity 0.40 m/s, firm bed,
            access cleared: <strong>ADV</strong> (FlowTracker2). The deep section is a straight reach, max depth 1.4 m, stable bank:
            <strong>ADCP</strong>, after its configuration and moving-bed checks.</p>
          <p>Before each method, a <strong>spot check</strong>: the field meter's water temperature and conductivity beside the instrument, the
            instrument's own temperature, and the difference. Investigate a difference over 2 °C. The game's readings:</p>
          <div class="table-wrap" role="region" aria-label="Spot checks" tabindex="0"><table class="kr-table">
            <caption>Spot checks at the two sections</caption>
            <thead><tr><th scope="col">Section</th><th scope="col">Water °C</th><th scope="col">µS/cm</th><th scope="col">Instrument °C</th></tr></thead>
            <tbody><tr><td>Wading (FlowTracker2)</td><td>19.9</td><td>371</td><td>20.2</td></tr>
              <tr><td>Deep (ADCP)</td><td>20.1</td><td>365</td><td>20.4</td></tr></tbody></table></div>
          <p>Gauge with the control <strong>as found</strong>, after the plate is corrected and its pair booked; book the logger's stage with each
            gauging. The game's rating: Q = 10 × (h − 0.1)<sup>1.5</sup> m³/s, h the stage in metres. Its results: ADV <strong>${F.adv.toFixed(2)}</strong>,
            ADCP <strong>${F.adcp.toFixed(2)}</strong> m³/s, each ±${F.unc}% (illustrative). A second measurement — another method, or a repeat at the same
            section — is a bonus.</p>`,
        checks: [
          { id: 'method', type: 'choice', q: 'Which instrument at the wading section?',
            opts: ['ADV (FlowTracker2) on a wading rod.', 'ADCP on a float.'],
            ans: 0, ok: 'ADV for the shallow, firm-bedded reach; the ADCP belongs in the 1.4 m section.', no: 'Method check not suitable for this section.' },
          { id: 'adcpchk', type: 'choice', q: 'At the deep section, before deploying the ADCP?',
            opts: ['Deploy straight away.', 'Run its configuration and moving-bed checks.'],
            ans: 1, ok: 'Configuration and moving-bed check first.', no: 'ADCP configuration and moving-bed check incomplete.' },
          { id: 'temp', type: 'number', unit: '°C', q: 'Wading section: field meter 19.9 °C, FlowTracker2 20.2 °C. The difference?',
            ans: 0.3, tol: 0.05, ok: '0.3 °C — well inside 2 °C.', no: '20.2 − 19.9.' },
          { id: 'rate', type: 'number', unit: 'm³/s', q: 'Rated discharge at the logger\'s 0.456 m?',
            ans: rating(F.stage), tol: 0.01, ok: '2.12 m³/s.', no: '10 × (0.456 − 0.1)^1.5 = 10 × 0.356^1.5.' },
          { id: 'dev', type: 'number', unit: '%', q: 'The ADV measured 1.68 m³/s. How far from the rating, in per cent?',
            ans: (F.adv - rating(F.stage)) / rating(F.stage) * 100, tol: 0.3, ok: '−20.9% — about 20% below the rating.', no: '(1.68 − 2.12) ÷ 2.12 × 100.' },
          { id: 'mean', type: 'choice', q: 'Both gaugings are about 20% below the rating. What does that tell you?',
            opts: ['The gaugings are wrong — adjust them toward the rating.', 'The rating has moved — shift it to fit.',
              'Something is holding the stage up. Keep the results and look at the control.'],
            ans: 2, ok: 'A low result is evidence for investigation, not permission to tune the result. It supports investigating the obstructed control.',
            no: 'Valid observations are compared with the current rating. A low result is evidence for investigation, not permission to tune the result.' },
        ],
      },
      {
        id: 'control', title: 'The control: clear it, let it settle', here: ['control'],
        figs: () => `<figure>${controlSvg()}<figcaption class="small">Before and after the log.</figcaption></figure>`,
        body: () => `
          <p>The control is a bedrock bar, and a small movable log lies on it. Inspect the access and local conditions, photograph it,
            then decide. With the log gone the pool drains: wait for it to settle, inspect the control again, and photograph it after.
            Pre-clear gaugings stay the evidence of the obstruction — measurements after clearing can't replace them, and another discharge
            measurement isn't required.</p>`,
        checks: [
          { id: 'log', type: 'choice', q: 'What do you do about the log?',
            opts: ['Remove the loose log.', 'Leave it, and report it.'],
            ans: 0, ok: 'The loose log was removed. The pool is draining.',
            no: 'Remove the loose log obstruction. Reporting it alone retains the raised pool and does not resolve this scenario\'s main control fault.' },
          { id: 'drain', type: 'choice', q: 'The pool is still draining. Gauge now to confirm the fix?',
            opts: ['Yes, while you are here.', 'No — wait for it to settle, post-check the control, photograph it.'],
            ans: 1, ok: 'Inspect the cleared control and allow the pool to settle. Another discharge measurement is not required.',
            no: 'Observed during pool drainage, non-steady flow cannot validate the rating — the game adds 0.42 m³/s to a measurement taken now.' },
          { id: 'clean', type: 'number', unit: 'm³/s', q: 'Settled, the stage is 0.406 m. What does the rating give now?',
            ans: rating(F.settled), tol: 0.01, ok: '1.69 m³/s — the same as the pre-clear gaugings (1.68, 1.70). The log was holding the pool 50 mm up.',
            no: '10 × (0.406 − 0.1)^1.5.' },
        ],
      },
      {
        id: 'depart', title: 'Lower pool and departure', here: ['gauge', 'shelter'],
        figs: () => `<figure>${plateSvg(F.settled, 'Staff gauge plate, enlarged, after the log is removed and the pool has settled. Read it to the millimetre.')}<figcaption class="small">The corrected plate, pool settled.</figcaption></figure>
          <figure>${loggerSvg([['Water level', `${m3(F.settled)} m`], ['Raw head', `${m3(F.settled - F.orifice)} m`], ['Sensor', 'RV-204']])}<figcaption class="small">The logger, with RV-204 installed.</figcaption></figure>`,
        body: () => `
          <ul>
            <li><strong>The lower pool:</strong> once the pool has settled, book a fresh intermediate staff/logger pair and photograph the gauge — plate
              correct, control clear.</li>
            <li><strong>Departure:</strong> after the last plate, control and sensor change and the settling, book the Departure pair, both within
              ${F.pairMin} minutes, in either order. An intermediate entry is not a departure entry.</li>
            <li>The raw head falls with the stage: 0.406 − (−0.250).</li>
          </ul>`,
        checks: [
          { id: 'dstaff', type: 'number', unit: 'm', q: 'Read the staff gauge.', ans: F.settled, tol: F.readTol,
            ok: '0.406 m, and the logger agrees.', no: 'Count up from the 0.40 mark.' },
          { id: 'dpair', type: 'choice', q: 'You booked an intermediate pair after the pool settled. Can it be the departure pair?',
            opts: ['Yes — it is after every change.', 'No — book the Departure pair separately, after the last change.'],
            ans: 1, ok: 'Departure readings are recorded separately.',
            no: 'Record an accurate logger value in Departure after the last material change. An intermediate entry is not a departure entry.' },
          { id: 'draw', type: 'number', unit: 'm', q: 'Raw head now?', ans: F.settled - F.orifice, tol: F.headTol, ok: '0.656 m.', no: '0.406 + 0.250.' },
        ],
      },
      {
        id: 'review', title: 'The record, and how it is marked', here: ['vehicle'],
        figs: () => `<figure>${rubricSvg()}<figcaption class="small">Out of 1000. A category earns its marks from the evidence in the record.</figcaption></figure>`,
        body: () => `
          <p>Back at the vehicle the visit is closed — <em>“The record cannot be changed after closing.”</em> The review marks what the record
            shows, not what you meant to do: each item with a reason when it is missed.</p>
          ${rubricTable()}
          <h4>The photographs</h4>
          <ul class="kr-cols">
            <li>Staff gauge on arrival, before the plate moves</li><li>Staff gauge after adjustment, control still obstructed</li>
            <li>Staff gauge after control clearance, pool settled</li><li>Cabinet before the sensor exchange (RV-101)</li>
            <li>Cabinet after the exchange (RV-204)</li><li>Control before action, and after</li>
            <li>Bonus: the shelter exterior; a gauging section</li><li>Also kept: the surroundings, each reference mark</li>
          </ul>
          <p>In Flood-Net the same visit is an inspection sheet, a maintenance record and a set of stamped photos:</p>
          <p><button type="button" onclick="switchTab('inspections')">📋 Inspections</button>
            <button type="button" onclick="switchTab('maintenance')">🛠️ Maintenance</button>
            <button type="button" onclick="switchTab('camera')">📷 Camera</button>
            <button type="button" onclick="switchTab('health')">🩺 Station Health</button></p>`,
        checks: [
          { id: 'photo', type: 'choice', q: 'Which photograph can\'t be taken later in the day?',
            opts: ['The shelter exterior.', 'The staff gauge on arrival, before the plate is moved.', 'A gauging section.'],
            ans: 1, ok: 'Photograph the original gauge before plate movement and control clearance.',
            no: 'That one can be taken any time — it is a bonus. The arrival gauge photo has to come before anything changes.' },
        ],
      },
    ];
    return stepCache;
  }

  function rubricTable() {
    const items = [
      ['Arrival', 'Staff 20 · logger 20 · the pair within 5 minutes 20'],
      ['Plate datum', 'Survey closed to BMGS425010 60 (TBM 01 only: 35) · plate raised 8 mm 170 · right way first time 20 · corrected pair 30'],
      ['Pre-clear gauging', 'A suitable gauging before the log is touched 60 · after the datum work 10 · a second measurement 10 · spot checks 10 · rating review 10'],
      ['Obstructed control', 'Inspect 20 · remove the log 150 · post-check after settling 15 · lower-pool pair 15'],
      ['Instrument', 'Identify RV-101 20 · exchange for RV-204 120 · check the replacement 20 · return RV-101 20 · battery 5 · raw head 5 · GCO comparison 10'],
      ['Photos', 'Five at 15 (gauge ×3, cabinet ×2) · control before and after at 10 · bonus 3 + 2'],
      ['Departure', 'Staff 20 · logger 20 · the pair within 5 minutes, after every change 20'],
    ];
    return `<div class="table-wrap" role="region" aria-label="Marking" tabindex="0"><table class="kr-table">
      <caption>What each category is marked on</caption>
      <thead><tr><th scope="col">Category</th><th scope="col">Items and marks</th></tr></thead>
      <tbody>${items.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // ── The plate ──────────────────────────────────────────────────────────────

  function plateBlock() {
    const read = F.plateRead - plate.adj / 1000;
    const diff = Math.round((read - F.stage) * 1000);
    const done = plate.adj === 8;
    const verdict = done
      ? (plate.moves === 1 && plate.downs === 0
        ? 'Plate corrected with the first movement — the game\'s 170 marks for the plate and 20 for the first movement.'
        : 'Plate corrected (170). Lowering or unnecessary repeat movements lose the 20 first-movement marks even if later recovered.')
      : plate.moves ? `The plate reads ${diff > 0 ? '+' : ''}${diff} mm against the logger.` : '';
    return `<div class="kr-figs" id="kr-plate">
      <figure>${plateSvg(read, `Staff gauge plate, moved ${plate.adj > 0 ? '+' : ''}${plate.adj} mm: the water now reads ${m3(read)} m on it. The logger reads ${m3(F.stage)} m.`)}
        <figcaption class="small">Plate mounting ${plate.adj > 0 ? '+' : ''}${plate.adj} mm · staff ${m3(read)} · logger ${m3(F.stage)}</figcaption></figure>
      <div>
        <div class="button-row">
          <button type="button" onclick="KbRiver.movePlate('up')"${plate.moves >= F.maxMoves ? ' disabled' : ''}>⬆️ Raise 8 mm</button>
          <button type="button" onclick="KbRiver.movePlate('down')"${plate.moves >= F.maxMoves ? ' disabled' : ''}>⬇️ Lower 8 mm</button>
          <button type="button" onclick="KbRiver.movePlate('undo')"${plate.prev === null ? ' disabled' : ''}>↩️ Undo movement</button>
        </div>
        <p class="kr-fb${done ? ' kr-ok' : plate.moves ? ' kr-no' : ''}" role="status" aria-live="polite">${esc(plate.msg)}${plate.msg && verdict ? ' ' : ''}${esc(verdict)}</p>
        <p class="small">Movements ${plate.moves} of ${F.maxMoves}.</p>
      </div></div>`;
  }

  function movePlate(dir) {
    if (dir === 'undo') {
      if (plate.prev === null) return;
      plate.adj = plate.prev; plate.prev = null;
      plate.msg = 'The previous gauge plate change was undone. Arrival evidence remains in the notebook.';
    } else {
      if (plate.moves >= F.maxMoves) return;
      const before = Math.abs(F.plateRead * 1000 - plate.adj - F.stage * 1000);
      plate.prev = plate.adj;
      plate.adj += dir === 'up' ? 8 : -8;
      plate.moves += 1;
      if (dir === 'down') plate.downs += 1;
      const after = Math.abs(F.plateRead * 1000 - plate.adj - F.stage * 1000);
      plate.msg = `${dir === 'up' ? 'Raised' : 'Lowered'}: gauge plate changed ${dir} by 8 mm — the difference from the logger ${after < before ? 'decreased' : after > before ? 'increased' : 'is unchanged'}. Record a fresh staff and logger comparison before relying on the result.`;
    }
    save();
    const el = document.getElementById('kr-plate');
    if (el) el.outerHTML = plateBlock();
    paintNav();
    say(plate.msg);
  }

  // ── Checks ─────────────────────────────────────────────────────────────────

  function parse(v) {
    const s = String(v ?? '').trim().replace(/[−–]/g, '-').replace(/,/g, '.').replace(/[^\d.+-]/g, '');
    if (!s || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function findCheck(id) {
    for (const s of steps()) { const c = s.checks.find(x => x.id === id); if (c) return c; }
    return null;
  }

  function feedback(c) {
    const a = answers[c.id];
    if (!a) return '';
    return a.ok ? `✅ ${esc(c.ok)}` : `❌ ${a.why ? `${esc(a.why)} ` : ''}${esc(Array.isArray(c.no) ? c.no[a.v] : c.no)}`;
  }

  function checkHtml(c) {
    const a = answers[c.id];
    const fb = `<p class="kr-fb${a ? (a.ok ? ' kr-ok' : ' kr-no') : ''}" id="kr-fb-${c.id}" role="status" aria-live="polite">${feedback(c)}</p>`;
    if (c.type === 'choice') {
      return `<fieldset class="kr-check"><legend>${esc(c.q)}</legend>
        ${c.opts.map((o, i) => `<label class="kr-opt"><input type="radio" name="kr-${c.id}" value="${i}"${a && String(a.v) === String(i) ? ' checked' : ''}> <span>${esc(o)}</span></label>`).join('')}
        <div class="button-row"><button type="button" onclick="KbRiver.check('${c.id}')">Check</button></div>${fb}</fieldset>`;
    }
    return `<div class="kr-check"><label for="kr-in-${c.id}">${esc(c.q)}</label>
      <div class="kr-num"><input id="kr-in-${c.id}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${a ? esc(a.v) : ''}"
        onkeydown="if(event.key==='Enter'){event.preventDefault();KbRiver.check('${c.id}')}"><span class="kr-unit">${esc(c.unit)}</span>
      <button type="button" onclick="KbRiver.check('${c.id}')">Check</button></div>${fb}</div>`;
  }

  function check(id) {
    const c = findCheck(id);
    if (!c) return;
    let v, ok, why = '';
    if (c.type === 'choice') {
      const el = document.querySelector(`input[name="kr-${id}"]:checked`);
      if (!el) { setFb(id, 'Pick one first.', false); return; }
      v = Number(el.value); ok = v === c.ans;
    } else {
      const el = document.getElementById(`kr-in-${id}`);
      v = el ? el.value : '';
      const n = parse(v);
      if (n == null) { setFb(id, 'Enter a number.', false); return; }
      ok = Math.abs(n - c.ans) <= c.tol + 1e-9;
      if (!ok) why = `${String(v).trim()} ${c.unit} isn't it.`;
    }
    answers[id] = { v, ok, why };
    save();
    const fb = feedback(c);
    setFb(id, fb, ok, true);
    paintNav();
    say((ok ? 'Right. ' : 'Not yet. ') + (ok ? c.ok : (Array.isArray(c.no) ? c.no[v] : c.no)));
  }

  function setFb(id, html, ok, isHtml) {
    const el = document.getElementById(`kr-fb-${id}`);
    if (!el) return;
    el.className = `kr-fb ${ok ? 'kr-ok' : 'kr-no'}`;
    el.innerHTML = isHtml ? html : esc(html);
  }

  function stepDone(s) {
    return s.checks.every(c => answers[c.id] && answers[c.id].ok) && (!s.plate || plate.adj === 8);
  }

  // ── Page ───────────────────────────────────────────────────────────────────

  function navHtml() {
    const list = steps();
    const done = list.filter(stepDone).length;
    return `<p class="small">${done} of ${list.length} steps practised.</p>
      <ol class="kr-progress">${list.map((s, i) => `<li><button type="button" class="kr-step-btn${stepDone(s) ? ' kr-done' : ''}" onclick="KbRiver.go(${i})"${i === step ? ' aria-current="step"' : ''}>
        <span class="kr-n" aria-hidden="true">${stepDone(s) ? '✓' : i + 1}</span><span>${esc(s.title)}</span>${stepDone(s) ? '<span class="sr-only"> (done)</span>' : ''}</button></li>`).join('')}</ol>`;
  }

  function stepHtml() {
    const list = steps();
    const s = list[step];
    const figs = s.figs();
    return `<h3 id="kr-step-h" tabindex="-1"><span class="kr-of">Step ${step + 1} of ${list.length}</span> ${esc(s.title)}</h3>
      <div class="kr-figs">
        <figure class="kr-mapfig">${siteMap(s.here)}<figcaption class="small">Where on site.</figcaption></figure>
        ${figs}
      </div>
      <div class="kr-body">${s.body()}</div>
      ${s.checks.length ? `<h4>Practice</h4>${s.checks.map(checkHtml).join('')}` : ''}
      <div class="button-row kr-nav">
        <button type="button" onclick="KbRiver.back()"${step === 0 ? ' disabled' : ''}>← Back</button>
        <button type="button" class="primary" onclick="KbRiver.next()"${step === list.length - 1 ? ' disabled' : ''}>Next →</button>
      </div>`;
  }

  function render() {
    load();
    return `<div class="page kr-page" style="--page-max:960px"><h2 class="sr-only">River Visit Day</h2><div class="stack">
      <section class="panel kr-intro">
        <h3>🏞️ A routine visit to a river station</h3>
        <p>One visit to station ${F.station}, ${esc(F.name)}, in the order the work goes — arrival readings, the level survey, the gauge
          plate, the sensor, the raw-head check, gauging, the control, departure — with a practice reading or decision at each step,
          marked the way the original game marks it. Its figures are a training fixture, not a real station.</p>
        <nav aria-label="Steps of the visit" id="kr-progress">${navHtml()}</nav>
        <div class="button-row"><button type="button" onclick="KbRiver.reset()">↺ Start the visit again</button></div>
      </section>
      <section class="panel kr-step" id="kr-step" aria-labelledby="kr-step-h">${stepHtml()}</section>
      ${typeof KnowledgeBase !== 'undefined' ? KnowledgeBase.credit('river') : ''}
    </div></div>`;
  }

  function paintNav() {
    const nav = document.getElementById('kr-progress');
    if (nav) nav.innerHTML = navHtml();
  }

  function paint(focus) {
    const el = document.getElementById('kr-step');
    if (el) el.innerHTML = stepHtml();
    paintNav();
    if (focus) {
      const h = document.getElementById('kr-step-h');
      if (h) {
        h.focus({ preventScroll: true });
        if (h.scrollIntoView) h.scrollIntoView({ block: 'start' });
      }
    }
  }

  function go(i) {
    const n = steps().length;
    step = Math.max(0, Math.min(n - 1, Number(i) || 0));
    save();
    paint(true);
  }
  function next() { go(step + 1); }
  function back() { go(step - 1); }

  function reset() {
    answers = {};
    plate = { adj: 0, moves: 0, downs: 0, prev: null, msg: '' };
    step = 0;
    save();
    paint(true);
    say('Visit restarted at step 1.');
  }

  function say(text) {
    if (typeof announce === 'function') announce(text);
  }

  function load() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') {
        if (Number.isInteger(d.step)) step = Math.max(0, Math.min(steps().length - 1, d.step));
        if (d.answers && typeof d.answers === 'object') answers = d.answers;
        if (d.plate && typeof d.plate === 'object' && Number.isFinite(d.plate.adj)) plate = Object.assign({ adj: 0, moves: 0, downs: 0, prev: null, msg: '' }, d.plate);
      }
    } catch (e) { /* storage unavailable: start fresh */ }
  }
  function save() {
    try { window.localStorage && window.localStorage.setItem(KEY, JSON.stringify({ step, answers, plate })); } catch (e) { /* not kept */ }
  }

  function init() {
    if (typeof state !== 'undefined' && state.activeTab && state.activeTab !== TAB) return;
    paintNav();
  }

  return { render, init, go, next, back, reset, check, movePlate };
})();

if (typeof window !== 'undefined') window.KbRiver = KbRiver;
