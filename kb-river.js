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

  // ── The site plan ─────────────────────────────────────────────────────────
  // North up, the river running north to south, drawn from the game's own
  // geometry (its section-geometry.ts and site.ts), in metres: x east, z
  // south, the game's world origin near the staff gauge. BANKS is the water's
  // edge at the visit's stage (0.456 m) every 2 m down the reach — [z, west,
  // east] — worked from the game's channel centre, half-width and bank-slope
  // functions; TRACK_UP is its bank track, 2 m back from the west bank, from
  // the staff gauge up to the wading section. Computed once from the game's
  // functions and kept as figures, so nothing here re-runs its terrain model.
  const BANKS = [[-68,14.4,27.5],[-66,12.7,25.9],[-64,11.1,24.3],[-62,9.4,22.7],[-60,7.8,21.1],[-58,6.3,19.5],[-56,4.7,17.9],[-54,3.2,16.4],[-52,1.6,14.7],[-50,0.1,12.9],[-48,-1.2,11],[-46,-2.4,8.1],[-44,-3.3,6.5],[-42,-4.1,5.6],[-40,-4.6,5.5],[-38,-4.9,5.7],[-36,-4.9,5.6],[-34,-4.8,5.7],[-32,-4.6,5.7],[-30,-4.3,5.7],[-28,-4.1,5.9],[-26,-3.9,6.2],[-24,-3.6,6.4],[-22,-3.4,6.6],[-20,-3.2,6.9],[-18,-3,7.1],[-16,-2.7,7.3],[-14,-2.5,7.5],[-12,-2.3,7.7],[-10,-2.1,7.9],[-8,-1.9,8],[-6,-1.7,8.1],[-4,-1.2,8],[-2,-1,8.3],[0,-0.8,8.6],[2,-0.6,8.9],[4,-0.3,9.1],[6,0,9.3],[8,0.1,9.7],[10,0.3,10],[12,2.2,8.9],[14,0.8,10.1],[16,1,10.3],[18,1.2,10.8],[20,1.5,11.1],[22,1.7,11.4]];
  const TRACK_UP = [[-2.1,-1.1],[-2.5,-5.1],[-3.1,-9.1],[-3.6,-13.1],[-4,-17.1],[-4.5,-21.1],[-4.9,-25.1],[-5.4,-29.1],[-5.9,-33.1],[-6.1,-37.1],[-5.6,-41.1],[-4.3,-45.1],[-2.2,-49.1],[0.6,-53.1],[3.8,-57.1],[4.5,-58]];
  // [x, z, label, label anchor ('l' left of the point, 'r' in the right-hand
  // margin with a leader, 'b' below)]
  const SITES = {
    vehicle:   [-13, 9, 'Vehicle', 'b'],
    benchmark: [-18.4, -12.9, 'BMGS425010', 'bl'],
    shelter:   [-8.5, -3, 'Shelter', 'lb'],
    tbm:       [0, 5.5, 'TBM 01', 'l'],
    gco:       [-2.6, -2.7, 'GCO', 'r'],
    gauge:     [-1.65, -1.1, 'Staff gauge', 'r'],
    shallow:   [5.2, -58, 'Wading section', 'r'],
    deep:      [-2.4, -9.1, 'Gauging section', 'r'],
    control:   [2, 11.8, 'Bedrock control', 'r'],
  };
  // Where each section crosses the water, and the rock bar's extent.
  const SECTIONS = { shallow: [-58, 6.3, 19.5], deep: [-9.1, -2.0, 7.9] };
  const BAR = { z0: 10.5, z1: 13.4, x0: 0.6, x1: 10.4 };
  const PX = x => +(40 + (x + 22) * 3.4).toFixed(1);
  const PY = z => +(10 + (z + 68) * 3.4).toFixed(1);

  function siteMap(here = []) {
    const pt = ([x, z]) => `${PX(x)},${PY(z)}`;
    const water = [...BANKS.map(([z, w]) => pt([w, z])), ...BANKS.slice().reverse().map(([z, , e]) => pt([e, z]))].join(' ');
    const westEdge = BANKS.map(([z, w]) => pt([w, z])).join(' ');
    const eastEdge = BANKS.map(([z, , e]) => pt([e, z])).join(' ');
    const S = SITES;
    const at = k => [S[k][0], S[k][1]];
    const track = [
      [[-10.6, 10.2], at('vehicle'), [-9, 4], at('shelter'), at('benchmark')],
      [at('shelter'), at('gauge'), ...TRACK_UP.map(([x, z]) => [x, z])],
      [at('gauge'), at('tbm'), [-0.7, 9], at('control')],
    ].map(line => `<polyline points="${line.map(pt).join(' ')}" class="kr-track"/>`).join('');
    // The long grass beside the bank track, between it and the benchmark —
    // the game's snake lies 3 m west of the bank, at z −15.
    const grass = [[-15, -12.4], [-9, -11.9], [-4.7, -13], [-4.6, -19], [-7, -22.5], [-13, -22], [-16.2, -17.6]];
    const sec = Object.entries(SECTIONS).map(([k, [z, w, e]]) =>
      `<line x1="${PX(w)}" y1="${PY(z)}" x2="${PX(e)}" y2="${PY(z)}" class="kr-secline${here.includes(k) ? ' kr-secline-on' : ''}"/>`).join('');
    let ry = { shallow: 40, deep: 206, gco: 222, gauge: 240, control: 270 };
    const marks = Object.entries(S).map(([k, [x, z, lab, side]]) => {
      const on = here.includes(k), cx = PX(x), cy = PY(z);
      let t;
      if (side === 'r') {
        const y = ry[k];
        t = `<polyline points="${cx + 3},${cy} ${k === 'shallow' || k === 'deep' ? PX(SECTIONS[k][2]) + 2 : cx + 8},${k === 'shallow' || k === 'deep' ? cy : y} 226,${y}" class="kr-leader"/>
          <text x="229" y="${y + 2.5}" class="kr-ts${on ? ' kr-tb' : ''}">${lab}</text>`;
      } else if (side === 'l') {
        t = `<text x="${cx - 5}" y="${cy + 2.5}" text-anchor="end" class="kr-ts${on ? ' kr-tb' : ''}">${lab}</text>`;
      } else if (side === 'bl') {
        t = `<text x="4" y="${cy + 12}" class="kr-ts${on ? ' kr-tb' : ''}">${lab}</text>`;
      } else if (side === 'lb') {
        t = `<text x="${cx - 4}" y="${cy + 9}" text-anchor="end" class="kr-ts${on ? ' kr-tb' : ''}">${lab}</text>`;
      } else {
        t = `<text x="${Math.max(cx, 26)}" y="${cy + 10}" text-anchor="middle" class="kr-ts${on ? ' kr-tb' : ''}">${lab}</text>`;
      }
      return `${on ? `<circle cx="${cx}" cy="${cy}" r="5.5" class="kr-here"/>` : ''}<circle cx="${cx}" cy="${cy}" r="2.2" class="kr-pt${on ? ' kr-pt-on' : ''}"/>${t}`;
    }).join('');
    const label = `Site plan of ${F.name}, north up, the river running north to south: the vehicle and the shelter on the west bank, `
      + 'benchmark BMGS425010 north-west of the shelter, the staff gauge and the GCO at the water\'s edge below the shelter and TBM 01 '
      + 'downstream of them; the bank track runs up the west bank to the wading section 57 m upstream, past the gauging section 8 m '
      + 'upstream of the gauge; long grass lies between the track and the benchmark; the bedrock control crosses the river 13 m below '
      + `the gauge, and the crossing is on it.${here.length ? ` This step: ${here.map(k => S[k][2]).join(', ')}.` : ''}`;
    return svg(label, '0 0 330 324', `
      <polygon points="${grass.map(pt).join(' ')}" class="kr-grass"/>
      <text x="${PX(-10.2)}" y="${PY(-17.4)}" text-anchor="middle" class="kr-ts">long</text>
      <text x="${PX(-10.2)}" y="${PY(-17.4) + 8}" text-anchor="middle" class="kr-ts">grass</text>
      <polygon points="${water}" class="kr-water"/>
      <polyline points="${westEdge}" class="kr-edge"/><polyline points="${eastEdge}" class="kr-edge"/>
      <rect x="${PX(BAR.x0)}" y="${PY(BAR.z0)}" width="${(PX(BAR.x1) - PX(BAR.x0)).toFixed(1)}" height="${(PY(BAR.z1) - PY(BAR.z0)).toFixed(1)}" class="kr-rockbar${here.includes('control') ? ' kr-rockbar-on' : ''}"/>
      <text x="${PX(BAR.x1) + 3}" y="${PY(BAR.z1) + 9}" class="kr-ts">the crossing</text>
      ${sec}${track}
      <path d="M${PX(2.6)} ${PY(-36)} v18 m-4 -6 l4 6 l4 -6" class="kr-flow"/>
      <path d="M${PX(5.6)} ${PY(15.5)} v14 m-4 -6 l4 6 l4 -6" class="kr-flow"/>
      <text x="${PX(2.6) + 7}" y="${PY(-28)}" class="kr-ts">flow</text>
      <path d="M16 30 V12 M12 18 L16 12 L20 18" class="kr-north"/><text x="16" y="40" text-anchor="middle" class="kr-ts kr-tb">N</text>
      <line x1="10" y1="316" x2="${10 + 34}" y2="316" class="kr-scale"/><text x="48" y="318.5" class="kr-ts">10 m</text>
      ${marks}
      <text x="229" y="${ry.shallow + 11}" class="kr-ts">13 m wide, 0.35 m deep</text>
      <text x="229" y="${ry.deep + 11}" class="kr-ts">10 m wide, 1.4 m deep</text>
      <text x="229" y="${ry.control + 11}" class="kr-ts">crest 0.40 m</text>`, 'kr-map');
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

  // ── The two gauging sections, across the river ──────────────────────────
  // Each as the game shapes it — its GAUGING_REACHES (a flat bed between
  // banks that rise to 1.49 m over 3.5 m) — sampled every 0.5 m across, in
  // metres from the channel's centre, west negative. Drawn looking
  // downstream, so the left bank (east) is on the left, both to one scale:
  // 7 px a metre across, 35 px a metre up — the vertical stretched five times.
  const WADE = [[-10,1.49],[-9.5,1.49],[-9,1.49],[-8.5,1.427],[-8,1.239],[-7.5,0.974],[-7,0.68],[-6.5,0.405],[-6,0.198],[-5.5,0.107],[-5,0.106],[-4.5,0.106],[-4,0.106],[-3.5,0.106],[-3,0.106],[-2.5,0.106],[-2,0.106],[-1.5,0.106],[-1,0.106],[-0.5,0.106],[0,0.106],[0.5,0.106],[1,0.106],[1.5,0.106],[2,0.106],[2.5,0.106],[3,0.106],[3.5,0.106],[4,0.106],[4.5,0.106],[5,0.106],[5.5,0.107],[6,0.198],[6.5,0.405],[7,0.68],[7.5,0.974],[8,1.239],[8.5,1.427],[9,1.49],[9.5,1.49],[10,1.49]];
  const DEEP = [[-10,1.49],[-9.5,1.49],[-9,1.49],[-8.5,1.49],[-8,1.49],[-7.5,1.49],[-7,1.49],[-6.5,1.489],[-6,1.329],[-5.5,0.964],[-5,0.481],[-4.5,-0.037],[-4,-0.503],[-3.5,-0.834],[-3,-0.944],[-2.5,-0.944],[-2,-0.944],[-1.5,-0.944],[-1,-0.944],[-0.5,-0.944],[0,-0.944],[0.5,-0.944],[1,-0.944],[1.5,-0.944],[2,-0.944],[2.5,-0.944],[3,-0.944],[3.5,-0.834],[4,-0.503],[4.5,-0.037],[5,0.481],[5.5,0.964],[6,1.329],[6.5,1.489],[7,1.49],[7.5,1.49],[8,1.49],[8.5,1.49],[9,1.49],[9.5,1.49],[10,1.49]];
  function gaugingSvg() {
    const panel = (prof, ox, o) => {
      const X = x => +(ox + (10 - x) * 7).toFixed(1);      // looking downstream: east (x > 0) on the left
      const Y = el => +(22 + (1.6 - el) * 35).toFixed(1);
      const bed = prof.map(([x, el]) => `${X(x)},${Y(el)}`).join(' ');
      const [wL, wR] = o.edges;                               // wet edges, east then west
      const wl = Y(F.stage);
      return `<polygon points="${bed} ${X(10)},${Y(-1.15)} ${X(-10)},${Y(-1.15)}" class="kr-bank"/>
        <polygon points="${X(wL)},${wl} ${prof.filter(([x, el]) => el < F.stage && x <= wL && x >= wR).reverse().map(([x, el]) => `${X(x)},${Y(el)}`).join(' ')} ${X(wR)},${wl}" class="kr-water"/>
        <line x1="${X(wL)}" y1="${wl}" x2="${X(wR)}" y2="${wl}" class="kr-wline"/>
        <polyline points="${bed}" class="kr-bed"/>
        ${o.inst(X, Y)}
        <line x1="${X(wL)}" y1="${wl - 7}" x2="${X(wR)}" y2="${wl - 7}" class="kr-dim"/>
        <line x1="${X(wL)}" y1="${wl - 10}" x2="${X(wL)}" y2="${wl - 4}" class="kr-dim"/><line x1="${X(wR)}" y1="${wl - 10}" x2="${X(wR)}" y2="${wl - 4}" class="kr-dim"/>
        <text x="${ox + 70}" y="${wl - 10}" text-anchor="middle" class="kr-ts kr-mono">${o.width}</text>
        <text x="${ox + 2}" y="${Y(1.49) - 4}" class="kr-ts">LB</text><text x="${ox + 138}" y="${Y(1.49) - 4}" text-anchor="end" class="kr-ts">RB</text>
        <text x="${ox + 70}" y="12" text-anchor="middle" class="kr-ts kr-tb">${o.title}</text>
        <text x="${ox + 70}" y="${Y(-1.15) + 12}" text-anchor="middle" class="kr-ts">${o.note}</text>`;
    };
    const wade = panel(WADE, 6, {
      title: 'Wading section · ADV', width: '13.2 m', edges: [6.6, -6.7], note: 'max depth 0.35 m · 0.40 m/s',
      inst: (X, Y) => {
        // Verticals across the section; the rod at one of them, the ADV probe at 0.6 of the depth below the surface.
        let v = '';
        for (let x = -6; x <= 6; x += 1) v += `<line x1="${X(x)}" y1="${Y(F.stage)}" x2="${X(x)}" y2="${Y(0.106)}" class="kr-vertical"/>`;
        return `${v}<line x1="${X(-1)}" y1="${Y(1.2)}" x2="${X(-1)}" y2="${Y(0.106)}" class="kr-rod"/>
          <rect x="${X(-1) - 3}" y="${Y(F.stage - 0.6 * 0.35) - 1.5}" width="7" height="3" class="kr-inst"/>
          <text x="${X(-1) - 4}" y="${Y(1.2) + 2}" text-anchor="end" class="kr-ts">wading rod</text>`;
      },
    });
    const deep = panel(DEEP, 168, {
      title: 'Gauging section · ADCP', width: '9.9 m', edges: [4.96, -4.98], note: 'max depth 1.40 m',
      inst: (X, Y) => `<path d="M${X(0.4) - 9} ${Y(F.stage) - 3} h18 l-3 4 h-12 z" class="kr-inst"/>
          <path d="M${X(0.4) - 3} ${Y(F.stage) + 1} L${X(0.4) - 16} ${Y(-0.944)} M${X(0.4) + 3} ${Y(F.stage) + 1} L${X(0.4) + 16} ${Y(-0.944)}" class="kr-beam"/>
          <path d="M${X(0.4) + 9} ${Y(F.stage) - 2} Q${X(-4)} ${Y(F.stage) - 14} ${X(-7.5)} ${Y(1.49)}" class="kr-tube"/>
          <text x="${X(-2.6)}" y="${Y(F.stage) - 20}" text-anchor="middle" class="kr-ts">tether</text>`,
    });
    return svg('The two gauging sections across the river, looking downstream, to one scale (the vertical stretched five times). '
      + 'Left, the wading section 57 m upstream of the gauge: 13.2 m wide at the water, a flat firm bed 0.35 m under it, flowing at about 0.40 m/s, '
      + 'gauged with an ADV on a wading rod, vertical by vertical. Right, the gauging section 8 m upstream of the gauge: 9.9 m wide, 1.40 m deep '
      + 'over its flat bed, gauged with an ADCP on a float tethered from the bank. Both have the water at 0.456 m on the gauge.',
      '0 0 330 150', `${wade}${deep}
      <text x="165" y="146" text-anchor="middle" class="kr-ts">looking downstream · vertical ×5</text>`);
  }

  // ── The control, along the river ────────────────────────────────────────
  // A long-section down the channel's centre line, flow left to right, from
  // the game's bed (LONG: [z, level]; the gauge is at z −1.1, the bedrock bar's
  // crest, 0.40 m, at z 12) and its water: the pool standing level back past
  // the gauge and the gauging section, falling over the bar to 0.19 m below
  // it. 9 px a metre along, 80 px a metre up — the vertical stretched nine
  // times, so the 50 mm the log holds the pool up can be seen at all.
  const LONG = [[-12,-0.944],[-11,-0.944],[-10,-0.944],[-9,-0.944],[-8,-0.944],[-7,-0.944],[-6,-0.936],[-5,-0.915],[-4,-0.882],[-3,-0.84],[-2,-0.791],[-1,-0.738],[0,-0.682],[1,-0.626],[2,-0.573],[3,-0.524],[4,-0.482],[5,-0.449],[6,-0.428],[7,-0.42],[8,-0.42],[9,-0.42],[9.25,-0.42],[9.5,-0.42],[9.75,-0.42],[10,-0.412],[10.25,-0.365],[10.5,-0.226],[10.75,-0.007],[11,0.201],[11.25,0.332],[11.5,0.386],[11.75,0.399],[12,0.4],[12.25,0.399],[12.5,0.387],[12.75,0.335],[13,0.213],[13.25,0.019],[13.5,-0.194],[13.75,-0.343],[14,-0.405],[14.25,-0.419],[14.5,-0.42],[14.75,-0.42],[15,-0.42],[16,-0.42],[17,-0.42],[18,-0.42],[19,-0.42],[20,-0.42],[21,-0.42],[22,-0.42]];
  function controlSvg() {
    const X = z => +(8 + (z + 12) * 9).toFixed(1);
    const Y = el => +(22 + (0.75 - el) * 80).toFixed(1);
    const TAIL = 0.19;
    const surf = lvl => [[-12, lvl], [12, lvl], [12.6, lvl - (lvl - TAIL) * 0.11], [13.2, lvl - (lvl - TAIL) * 0.44], [13.8, TAIL], [22, TAIL]];
    const bed = LONG.map(([z, el]) => `${X(z)},${Y(el)}`).join(' ');
    const water = surf(F.stage);
    const wpoly = `${water.map(([z, el]) => `${X(z)},${Y(el)}`).join(' ')} ${LONG.slice().reverse().map(([z, el]) => `${X(z)},${Y(el)}`).join(' ')}`;
    const crest = Y(0.4);
    return svg('Long-section down the river through the control, flow left to right, the vertical stretched nine times. The pool upstream '
      + 'is 1.4 m deep at the gauging section and shoals towards a bedrock bar whose crest is at 0.40 m on the gauge; below the bar the '
      + 'water falls to 0.19 m. A loose log lies across the crest. With it there, the pool — and so the staff gauge, 13 m upstream — '
      + 'stands at 0.456 m; once the log is removed and the pool has drained and settled, it stands at 0.406 m, 50 mm lower, just over the crest.',
      '0 0 330 190', `
      <polygon points="${wpoly}" class="kr-water"/>
      <polygon points="${bed} ${X(22)},178 ${X(-12)},178" class="kr-bank"/>
      <polyline points="${bed}" class="kr-bed"/>
      <path d="${LONG.filter(([z]) => z >= 10 && z <= 14).map(([z, el], i) => `${i ? 'L' : 'M'}${X(z)} ${Y(el)}`).join(' ')}" class="kr-rockedge"/>
      <polyline points="${water.map(([z, el]) => `${X(z)},${Y(el)}`).join(' ')}" class="kr-wline"/>
      <line x1="${X(-12)}" y1="${Y(F.settled)}" x2="${X(12.2)}" y2="${Y(F.settled)}" class="kr-settled"/>
      <ellipse cx="${X(12)}" cy="${crest - 5}" rx="6" ry="5" class="kr-log"/>
      <line x1="${X(-1.1)}" y1="${Y(0.72)}" x2="${X(-1.1)}" y2="${Y(-0.1)}" class="kr-gaugepost"/>
      <text x="${X(-1.1) + 4}" y="${Y(0.72) + 6}" class="kr-ts">staff gauge</text>
      <line x1="${X(-9.1)}" y1="${Y(0.72)}" x2="${X(-9.1)}" y2="${Y(-0.944)}" class="kr-datum"/>
      <text x="${X(-9.1) + 3}" y="${Y(0.72) + 6}" class="kr-ts">gauging section</text>
      <text x="${X(-0.4)}" y="${Y(F.stage) - 4}" class="kr-ts kr-mono">0.456 with the log</text>
      <text x="${X(-0.4)}" y="${Y(F.settled) + 10}" class="kr-ts kr-mono">0.406 log removed</text>
      <text x="${X(12) + 8}" y="${crest - 13}" class="kr-ts kr-tb">loose log</text>
      <text x="${X(12) + 10}" y="${Y(0.0)}" class="kr-ts">bedrock bar,</text>
      <text x="${X(12) + 10}" y="${Y(0.0) + 10}" class="kr-ts">crest 0.40</text>
      <text x="${X(22) - 2}" y="${Y(TAIL) - 4}" text-anchor="end" class="kr-ts kr-mono">0.19 below</text>
      <text x="${X(-12) + 2}" y="${Y(-0.944) + 12}" class="kr-ts">pool, bed −0.94</text>
      <path d="M${X(16)} 12 h22 m-5 -4 l5 4 l-5 4" class="kr-flow"/><text x="${X(16) - 3}" y="15" text-anchor="end" class="kr-ts">flow</text>
      <text x="165" y="188" text-anchor="middle" class="kr-ts">long-section down the centre line · vertical ×9</text>`);
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
        id: 'gco', title: 'Check the raw head at the GCO', here: ['gco', 'gauge'],
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
