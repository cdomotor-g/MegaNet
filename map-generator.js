// MegaNet — map-generator.js
//
//   MapGen   the Map Generator tab: composes a to-scale sheet — stations,
//            rivers, elevation contours, graticule, title block — into a
//            millimetre-true SVG for printing (A4 in hand or PDF on a drive)
//            or for laser work in K40 Whisperer, including a one-file-per-
//            elevation layered mode for stacked vector-cut terrain.
//
// After core.js and app.js, before init.js — index.html holds the order.
// Reaches back to core.js for state, esc, escAttr, slug, announce,
// registerTabTeardown, registerLiveMap, removeMap and acmaHaversineKm; across
// to app.js for switchTab, addBaseLayers and primaryRole; and across to
// terrain.js for Terrain.grid — the DEM lattice the contours are traced from.
// app.js reaches back the other way once: the Stations tab's "Send view to
// Map Generator" button calls MapGen.adoptStationsView().
//
// ── Why this is not a screenshot of the Stations map ─────────────────────────
//
// The Stations map answers "where is everything, right now, on my screen".
// This tab answers "give me a sheet at 1:100 000 on A4" and "give me a
// 200 × 200 mm plate the K40 can cut" — both of which are statements about
// millimetres and scale, not pixels and zoom. So the output is built as its
// own SVG document whose user units ARE millimetres (width="200mm"
// viewBox="0 0 200 200"): every stroke width, pin size and text height below
// is a physical dimension, and the same document prints true and cuts true.
//
// ── The K40 Whisperer contract ───────────────────────────────────────────────
//
// K40 Whisperer sorts an SVG's ink by colour: black is raster-engraved, pure
// blue (#0000FF) strokes are vector-engraved, pure red (#FF0000) strokes are
// vector-cut. The laser palettes below default to exactly those three, and the
// border defaults to red because on a billet the border IS the cut that frees
// the 200 × 200 plate from the blank. Text in the laser modes is drawn with a
// built-in single-stroke (Hershey) font rather than <text>: K40 Whisperer
// does not flatten font glyphs to paths, and a single-stroke line engraves
// faster and cleaner than a filled outline anyway. Every colour is still an
// ordinary colour input — the palette is a default, not a fence.
//
// ── Layered mode (one file per elevation) ────────────────────────────────────
//
// Layer k's file cuts the contour at its own level (red) and vector-engraves
// the NEXT level up (blue): stack the plates and each cut edge sits exactly
// on the engraved line of the plate below it — the engrave is the assembly
// jig. Layer 0 is the base billet (border cut only, level-1 engrave), the top
// layer has nothing above it to align, and every file repeats the border cut
// so a contour that runs off the plate edge still comes free of the blank.
// Rivers, pins, names and graticule are engraved on the layer whose elevation
// band they sit in — the plate that is actually visible there once assembled.
// The elevation-step ⇄ material-thickness ratio is the user's to judge, so
// the tab shows the resulting vertical scale and exaggeration rather than
// deciding: contour interval, datum offset and plate thickness are all inputs.
//
// Everything network-shaped fails soft: no DEM → no contours and a note; no
// Overpass → no rivers and a note; a tile host that refuses CORS → no base
// image and a note. The sheet still generates with whatever arrived.
const MapGen = (() => {

// ── Output presets ───────────────────────────────────────────────────────────
// A4 for the technicians' print pathway; 200 × 200 for the K40 billet (blanks
// run 220-250 mm square, the working area is 200 × 200). Margins: a printer
// needs one, a billet is cut edge-to-edge.
const MG_PRESETS = {
  a4p:    { label: 'A4 portrait — 210 × 297 mm',  w: 210, h: 297, margin: 10 },
  a4l:    { label: 'A4 landscape — 297 × 210 mm', w: 297, h: 210, margin: 10 },
  billet: { label: 'Laser billet — 200 × 200 mm', w: 200, h: 200, margin: 0  },
  custom: { label: 'Custom size…',                w: 200, h: 200, margin: 0  },
};

// The same base set the Stations map offers (makeBaseLayers, app.js), plus
// "None" — a laser file wants no raster under it, and the option to turn the
// base off entirely is part of the brief. Raw URL templates rather than
// Leaflet layers because these tiles are composed onto a canvas and embedded
// in the SVG as one image, not panned live.
const MG_BASES = {
  'none':          null,
  'OSM-Topo':      { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', sub: 'abc', max: 17,
                     attr: '© OpenStreetMap contributors, SRTM · © OpenTopoMap (CC-BY-SA)' },
  'OpenStreetMap': { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', sub: 'abc', max: 19,
                     attr: '© OpenStreetMap contributors' },
  'Satellite':     { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', sub: '', max: 19,
                     attr: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics' },
};

// Feature colours, one palette per output mode. Print reads like the app's
// own map (role colours from ROLE_COLOR's family); the two laser palettes are
// the K40 Whisperer contract above. `border` doubles as the cut colour;
// `align` is layered mode's next-level-up engrave.
const MG_PALETTES = {
  print:  { contour: '#8d6e63', contourMajor: '#5d4037', river: '#1565c0', grat: '#90a0b0',
            gratText: '#5a6b7c', pinField: '#107c10', pinRepeater: '#0b5cab', pinBase: '#c7401a',
            label: '#1a2430', title: '#1a2430', border: '#333333', align: '#0000ff' },
  laser:  { contour: '#0000ff', contourMajor: '#0000ff', river: '#0000ff', grat: '#000000',
            gratText: '#000000', pinField: '#000000', pinRepeater: '#000000', pinBase: '#000000',
            label: '#0000ff', title: '#0000ff', border: '#ff0000', align: '#0000ff' },
  layers: { contour: '#0000ff', contourMajor: '#0000ff', river: '#0000ff', grat: '#000000',
            gratText: '#000000', pinField: '#000000', pinRepeater: '#000000', pinBase: '#000000',
            label: '#0000ff', title: '#0000ff', border: '#ff0000', align: '#0000ff' },
};

const MG_COLOR_LABELS = [
  ['contour',      'Contours'],
  ['contourMajor', 'Index contours'],
  ['river',        'Rivers'],
  ['grat',         'Graticule'],
  ['gratText',     'Graticule numbers'],
  ['pinField',     'Field pins'],
  ['pinRepeater',  'Repeater pins'],
  ['pinBase',      'Base pins'],
  ['label',        'Station names'],
  ['title',        'Title block'],
  ['border',       'Border / cut'],
  ['align',        'Alignment engrave'],
];

// Overpass, for the rivers — the same two mirrors MapRivers trusts, asked a
// different question: every watercourse in the frame rather than the ones a
// typed name matches. Same manners too: bounded, capped, cached, and silent
// about failure beyond a note.
const MG_OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const MG_RIVER_CAP    = 800;      // ways kept per query, longest first
const MG_FETCH_MS     = 25000;
const MG_DEBOUNCE_MS  = 600;      // settings settle before a regenerate
const MG_MAX_LEVELS   = 240;      // contour levels a single generate will trace
const MG_BASE_DPI     = 150;      // raster base resolution on the sheet
const MG_BASE_MAX_PX  = 2400;     // long edge of the composed base image
const MG_SIMPLIFY_MM  = 0.08;     // Douglas-Peucker tolerance on the sheet
const MG_LABEL_CAP    = 500;      // station names attempted per sheet

// Web Mercator, spherical radius — the same projection the Leaflet maps and
// the terrarium DEM tiles use, so everything drawn here lines up with what
// the Stations map shows. y grows north; the sheet flips it.
const MG_R = 6378137;

// ── Hershey single-stroke font (laser text) ──────────────────────────────────
// The classic Hershey "futural" (Simplex) set, ASCII 32-126, in the compact
// JHF encoding: per glyph, a vertex count then coordinate pairs as printable
// characters offset from 'R', with " R" as pen-up. Public-domain-style data
// distributed for decades with the request that the origin (US NBS, Dr A. V.
// Hershey) be acknowledged — acknowledged. Baseline sits at y=+9, cap height
// spans up to y=-12: 21 units tall, scaled so "size" means cap height in mm.
const MG_JHF = [
"  1JZ", "  9MWRFRT RRYQZR[SZRY", "  6JZNFNM RVFVM", " 12H]SBLb RYBRb RLOZO RKUYU",
" 27H\\PBP_ RTBT_ RYIWGTFPFMGKIKKLMMNOOUQWRXSYUYXWZT[P[MZKX", " 32F^[FI[ RNFPHPJOLMMKMIKIIJGLFNFPGSHVHYG[F RWTUUTWTYV[X[ZZ[X[VYTWT", " 35E_\\O\\N[MZMYNXPVUTXRZP[L[JZIYHWHUISJRQNRMSKSIRGPFNGMIMKNNPQUXWZY[[[\\Z\\Y", "  8MWRHQGRFSGSIRKQL",
" 11KYVBTDRGPKOPOTPYR]T`Vb", " 11KYNBPDRGTKUPUTTYR]P`Nb", "  9JZRLRX RMOWU RWOMU", "  6E_RIR[ RIR[R",
"  8NVSWRXQWRVSWSYQ[", "  3E_IR[R", "  6NVRVQWRXSWRV", "  3G][BIb",
" 18H\\QFNGLJKOKRLWNZQ[S[VZXWYRYOXJVGSFQF", "  5H\\NJPISFS[", " 15H\\LKLJMHNGPFTFVGWHXJXLWNUQK[Y[", " 16H\\MFXFRNUNWOXPYSYUXXVZS[P[MZLYKW",
"  7H\\UFKTZT RUFU[", " 18H\\WFMFLOMNPMSMVNXPYSYUXXVZS[P[MZLYKW", " 24H\\XIWGTFRFOGMJLOLTMXOZR[S[VZXXYUYTXQVOSNRNOOMQLT", "  6H\\YFO[ RKFYF",
" 30H\\PFMGLILKMMONSOVPXRYTYWXYWZT[P[MZLYKWKTLRNPQOUNWMXKXIWGTFPF", " 24H\\XMWPURRSQSNRLPKMKLLINGQFRFUGWIXMXRWWUZR[P[MZLX", " 12NVROQPRQSPRO RRVQWRXSWRV", " 14NVROQPRQSPRO RSWRXQWRVSWSYQ[",
"  4F^ZIJRZ[", "  6E_IO[O RIU[U", "  4F^JIZRJ[", " 21I[LKLJMHNGPFTFVGWHXJXLWNVORQRT RRYQZR[SZRY",
" 56E`WNVLTKQKOLNMMPMSNUPVSVUUVS RQKOMNPNSOUPV RWKVSVUXVZV\\T]Q]O\\L[JYHWGTFQFNGLHJJILHOHRIUJWLYNZQ[T[WZYYZX RXKWSWUXV", "  9I[RFJ[ RRFZ[ RMTWT", " 24G\\KFK[ RKFTFWGXHYJYLXNWOTP RKPTPWQXRYTYWXYWZT[K[", " 19H]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZV",
" 16G\\KFK[ RKFRFUGWIXKYNYSXVWXUZR[K[", " 12H[LFL[ RLFYF RLPTP RL[Y[", "  9HZLFL[ RLFYF RLPTP", " 23H]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZVZS RUSZS",
"  9G]KFK[ RYFY[ RKPYP", "  3NVRFR[", " 11JZVFVVUYTZR[P[NZMYLVLT", "  9G\\KFK[ RYFKT RPOY[",
"  6HYLFL[ RL[X[", " 12F^JFJ[ RJFR[ RZFR[ RZFZ[", "  9G]KFK[ RKFY[ RYFY[", " 22G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF",
" 14G\\KFK[ RKFTFWGXHYJYMXOWPTQKQ", " 25G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF RSWY]", " 17G\\KFK[ RKFTFWGXHYJYLXNWOTPKP RRPY[", " 21H\\YIWGTFPFMGKIKKLMMNOOUQWRXSYUYXWZT[P[MZKX",
"  6JZRFR[ RKFYF", " 11G]KFKULXNZQ[S[VZXXYUYF", "  6I[JFR[ RZFR[", " 12F^HFM[ RRFM[ RRFW[ R\\FW[",
"  6H\\KFY[ RYFK[", "  7I[JFRPR[ RZFRP", "  9H\\YFK[ RKFYF RK[Y[", " 12KYOBOb RPBPb ROBVB RObVb",
"  3KYKFY^", " 12KYTBTb RUBUb RNBUB RNbUb", "  6JZRDJR RRDZR", "  3I[Ib[b",
"  8NVSKQMQORPSORNQO", " 18I\\XMX[ RXPVNTMQMONMPLSLUMXOZQ[T[VZXX", " 18H[LFL[ RLPNNPMSMUNWPXSXUWXUZS[P[NZLX", " 15I[XPVNTMQMONMPLSLUMXOZQ[T[VZXX",
" 18I\\XFX[ RXPVNTMQMONMPLSLUMXOZQ[T[VZXX", " 18I[LSXSXQWOVNTMQMONMPLSLUMXOZQ[T[VZXX", "  9MYWFUFSGRJR[ ROMVM", " 23I\\XMX]W`VaTbQbOa RXPVNTMQMONMPLSLUMXOZQ[T[VZXX",
" 11I\\MFM[ RMQPNRMUMWNXQX[", "  9NVQFRGSFREQF RRMR[", " 12MWRFSGTFSERF RSMS^RaPbNb", "  9IZMFM[ RWMMW RQSX[",
"  3NVRFR[", " 19CaGMG[ RGQJNLMOMQNRQR[ RRQUNWMZM\\N]Q][", " 11I\\MMM[ RMQPNRMUMWNXQX[", " 18I\\QMONMPLSLUMXOZQ[T[VZXXYUYSXPVNTMQM",
" 18H[LMLb RLPNNPMSMUNWPXSXUWXUZS[P[NZLX", " 18I\\XMXb RXPVNTMQMONMPLSLUMXOZQ[T[VZXX", "  9KXOMO[ ROSPPRNTMWM", " 18J[XPWNTMQMNNMPNRPSUTWUXWXXWZT[Q[NZMX",
"  9MYRFRWSZU[W[ ROMVM", " 11I\\MMMWNZP[S[UZXW RXMX[", "  6JZLMR[ RXMR[", " 12G]JMN[ RRMN[ RRMV[ RZMV[",
"  6J[MMX[ RXMM[", " 10JZLMR[ RXMR[P_NaLbKb", "  9J[XMM[ RMMXM RM[X[", " 40KYTBRCQDPFPHQJRKSMSOQQ RRCQEQGRISJTLTNSPORSTTVTXSZR[Q]Q_Ra RQSSUSWRYQZP\\P^Q`RaTb",
"  3NVRBRb", " 40KYPBRCSDTFTHSJRKQMQOSQ RRCSESGRIQJPLPNQPURQTPVPXQZR[S]S_Ra RSSQUQWRYSZT\\T^S`RaPb", " 24F^IUISJPLONOPPTSVTXTZS[Q RISJQLPNPPQTTVUXUZT[Q[O", " 35JZJFJ[K[KFLFL[M[MFNFN[O[OFPFP[Q[QFRFR[S[SFTFT[U[UFVFV[W[WFXFX[Y[YFZFZ[",
];

let hfont = null;
function hersheyFont() {
  if (hfont) return hfont;
  hfont = {};
  for (let g = 0; g < MG_JHF.length; g++) {
    const line = MG_JHF[g];
    const n = parseInt(line.slice(0, 3), 10);
    const body = line.slice(3);
    const lh = body.charCodeAt(0) - 82, rh = body.charCodeAt(1) - 82;
    const strokes = [];
    let cur = null;
    for (let k = 1; k < n; k++) {
      if (body[2 * k] === ' ' && body[2 * k + 1] === 'R') { cur = null; continue; }
      if (!cur) { cur = []; strokes.push(cur); }
      cur.push([body.charCodeAt(2 * k) - 82, body.charCodeAt(2 * k + 1) - 82]);
    }
    hfont[String.fromCharCode(32 + g)] = { lh, rh, strokes };
  }
  // Two glyphs the Hershey set never carried, that the sheets use: the degree
  // sign for decimal-degree labels (a small octagon up at cap height) and the
  // middle dot the title block and layer tags separate their facts with.
  hfont['°'] = { lh: -5, rh: 5,
    strokes: [[[0, -12], [2, -11], [3, -9], [2, -7], [0, -6], [-2, -7], [-3, -9], [-2, -11], [0, -12]]] };
  hfont['·'] = { lh: -3, rh: 3,
    strokes: [[[-1, -4], [1, -4], [1, -6], [-1, -6], [-1, -4]]] };
  return hfont;
}

// Text as stroke polylines. (x, y) is the baseline start; size is cap height
// in mm. Returns width so callers can lay out and collision-test exactly.
function strokeText(str, sizeMm) {
  const f = hersheyFont(), k = sizeMm / 21;
  let x = 0;
  const polys = [];
  for (const ch of String(str)) {
    const g = f[ch] || f['?'];
    if (!g) continue;
    for (const s of g.strokes) polys.push(s.map(([px, py]) => [x + (px - g.lh) * k, (py - 9) * k]));
    x += (g.rh - g.lh) * k;
  }
  return { w: x, polys };
}

// One text element, dispatched on how the sheet will be consumed: real
// <text> for print (searchable, kerned), stroke paths for the laser modes
// (K40 Whisperer never sees a font). Anchor works in both worlds.
function textMarkup(x, y, str, sizeMm, color, opts) {
  const o = opts || {};
  if (o.vector) {
    const t = strokeText(str, sizeMm);
    const dx = o.anchor === 'middle' ? -t.w / 2 : o.anchor === 'end' ? -t.w : 0;
    const d = t.polys
      .map(p => 'M' + p.map(([px, py]) => (px + x + dx).toFixed(2) + ' ' + (py + y).toFixed(2)).join(' L'))
      .join(' ');
    if (!d) return '';
    const sw = Math.max(0.12, sizeMm * 0.07).toFixed(2);
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  const halo = o.halo ? ` paint-order="stroke" stroke="#ffffff" stroke-width="0.5" stroke-linejoin="round"` : '';
  const anchor = o.anchor ? ` text-anchor="${o.anchor}"` : '';
  return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-family="Helvetica, Arial, sans-serif"` +
         ` font-size="${sizeMm.toFixed(2)}"${anchor}${halo} fill="${color}">${svgEsc(str)}</text>`;
}

function measureText(str, sizeMm, vector) {
  return vector ? strokeText(str, sizeMm).w : String(str).length * sizeMm * 0.58;
}

function svgEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The LOCAL calendar date, for title blocks and filenames — toISOString() is
// UTC, which is yesterday for most of the Australian working morning.
function localDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Projection and the frame ─────────────────────────────────────────────────

function mercX(lon) { return MG_R * lon * Math.PI / 180; }
function mercY(lat) {
  const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
  return MG_R / 2 * Math.log((1 + s) / (1 - s));
}
function invMercX(x) { return x / MG_R * 180 / Math.PI; }
function invMercY(y) { return (2 * Math.atan(Math.exp(y / MG_R)) - Math.PI / 2) * 180 / Math.PI; }

// Everything derived from page size + margin + centre + scale, in one place.
// "1:scale" is read at the centre latitude, the convention every printed map
// sheet uses; mercPerMm carries the cos(lat) correction so a 200 mm plate at
// 1:100 000 covers 20.0 km of actual ground east-west at the centre.
function frame() {
  const s = mg.s;
  const w = s.wMm, h = s.hMm;
  const m = Math.max(0, Math.min(s.marginMm, (Math.min(w, h) - 20) / 2));
  const cw = w - 2 * m, ch = h - 2 * m;
  const mercPerMm = (s.scale / 1000) / Math.cos(s.lat * Math.PI / 180);
  const cx = mercX(s.lon), cy = mercY(s.lat);
  const west = cx - cw / 2 * mercPerMm, east = cx + cw / 2 * mercPerMm;
  const south = cy - ch / 2 * mercPerMm, north = cy + ch / 2 * mercPerMm;
  return {
    w, h, m, cw, ch, mercPerMm,
    merc: { west, east, south, north },
    deg: { west: invMercX(west), east: invMercX(east), south: invMercY(south), north: invMercY(north) },
    toMm(lat, lon) {
      return [m + (mercX(lon) - west) / mercPerMm, m + (north - mercY(lat)) / mercPerMm];
    },
    rect: { x0: m, y0: m, x1: m + cw, y1: m + ch },
  };
}

// ── Polyline machinery ───────────────────────────────────────────────────────

// Liang-Barsky, one segment against the content rect; a polyline in, the
// visible pieces out. Everything that comes from outside the frame's own
// lattice (rivers, graticule) goes through this so nothing inks the margin.
function clipPolyline(pts, rect) {
  const out = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    const p = [-dx, dx, -dy, dy];
    const q = [ax - rect.x0, rect.x1 - ax, ay - rect.y0, rect.y1 - ay];
    for (let k = 0; k < 4 && ok; k++) {
      if (p[k] === 0) { if (q[k] < 0) ok = false; }
      else {
        const t = q[k] / p[k];
        if (p[k] < 0) { if (t > t1) ok = false; else if (t > t0) t0 = t; }
        else          { if (t < t0) ok = false; else if (t < t1) t1 = t; }
      }
    }
    if (!ok) { cur = null; continue; }
    const p1 = [ax + dx * t1, ay + dy * t1];
    if (t0 === 0 && cur) cur.push(p1);
    else { cur = [[ax + dx * t0, ay + dy * t0], p1]; out.push(cur); }
    if (t1 < 1) cur = null;
  }
  return out;
}

// Douglas-Peucker, iterative. The DEM lattice and the band splitter both
// produce far more vertices than the pen can use; this is what keeps a
// hundred contour levels from being a 30 MB file.
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0], ay = pts[a][1];
    const dx = pts[b][0] - ax, dy = pts[b][1] - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      let t = len2 ? ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = pts[i][0] - (ax + t * dx), ey = pts[i][1] - (ay + t * dy);
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > t2) { keep[maxI] = 1; stack.push([a, maxI], [maxI, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Chaikin corner-cutting. The ~30 m DEM traced onto a sheet is visibly
// faceted; one or two passes round it into something that reads as terrain
// without inventing detail the source lacks (the deviation stays inside a
// lattice cell).
function chaikin(pts, closed, iterations) {
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) return pts;
    const out = [];
    if (!closed) out.push(pts[0]);
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
      out.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
    }
    if (!closed) out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function pathD(pts, closed) {
  return 'M' + pts.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' L') + (closed ? ' Z' : '');
}

// ── Marching squares ─────────────────────────────────────────────────────────
// Isolines of one level over the DEM lattice, chained into polylines. Each
// crossing point lives on exactly one lattice edge, so edges are the keys the
// chain is stitched on — no floating-point welding. A line that reaches the
// lattice boundary ends exactly on the content-rect edge, which is what lets
// a cut contour meet the border cut and free the piece.
function isolines(vals, nx, ny, level) {
  const segs = [];
  for (let j = 0; j < ny - 1; j++) {
    const row = j * nx, rowB = (j + 1) * nx;
    for (let i = 0; i < nx - 1; i++) {
      const tl = vals[row + i], tr = vals[row + i + 1], br = vals[rowB + i + 1], bl = vals[rowB + i];
      if (Number.isNaN(tl) || Number.isNaN(tr) || Number.isNaN(br) || Number.isNaN(bl)) continue;
      const c = [];
      if ((tl >= level) !== (tr >= level)) c.push(['h' + (row + i),      i + (level - tl) / (tr - tl), j]);
      if ((tr >= level) !== (br >= level)) c.push(['v' + (row + i + 1),  i + 1, j + (level - tr) / (br - tr)]);
      if ((bl >= level) !== (br >= level)) c.push(['h' + (rowB + i),     i + (level - bl) / (br - bl), j + 1]);
      if ((tl >= level) !== (bl >= level)) c.push(['v' + (row + i),      i, j + (level - tl) / (bl - tl)]);
      if (c.length === 2) segs.push([c[0], c[1]]);
      else if (c.length === 4) {
        // Saddle. The centre average decides whether the two inside corners
        // join through the middle; the pairing rule falls out of which
        // diagonal the inside corners sit on. c is pushed in T,R,B,L order.
        const centreIn = (tl + tr + br + bl) / 4 >= level;
        if (centreIn === (tl >= level)) segs.push([c[0], c[1]], [c[2], c[3]]);
        else                            segs.push([c[0], c[3]], [c[1], c[2]]);
      }
    }
  }
  // Chain on edge keys.
  const byKey = new Map();
  segs.forEach((s, idx) => {
    for (const end of s) {
      const list = byKey.get(end[0]);
      if (list) list.push(idx); else byKey.set(end[0], [idx]);
    }
  });
  const used = new Uint8Array(segs.length);
  const lines = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let pts = [segs[i][0], segs[i][1]];
    for (const tail of [true, false]) {
      for (;;) {
        const endPt = tail ? pts[pts.length - 1] : pts[0];
        const cands = byKey.get(endPt[0]) || [];
        let next = null;
        for (const ci of cands) {
          if (used[ci]) continue;
          const s = segs[ci];
          next = s[0][0] === endPt[0] ? s[1] : s[0];
          used[ci] = 1;
          break;
        }
        if (!next) break;
        if (tail) pts.push(next); else pts.unshift(next);
      }
    }
    const closed = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0];
    if (closed) pts = pts.slice(0, -1);
    lines.push({ pts: pts.map(p => [p[1], p[2]]), closed });
  }
  return lines;
}

// ── Module state ─────────────────────────────────────────────────────────────

const mg = {
  s: null,            // settings — the persisted half, see defaults()
  map: null,          // the little view-picker Leaflet map
  rect: null,         // plate footprint drawn on it
  timer: null,        // regenerate debounce
  seq: 0,             // stale-generation guard, MapRivers-style
  gen: null,          // last successful generation (art + per-layer builder)
  previewPick: 'flat',     // which sheet the preview shows — 'flat' or a layer index
  layerSel: null,          // layered-mode file tick state, kept across regenerates
  riverCache: new Map(),   // rounded bbox → overpass ways, LRU
  baseCache: new Map(),    // tile compose → data URL, LRU
  layerSvgCache: new Map(),
};

function defaults() {
  return {
    preset: 'a4l', wMm: 297, hMm: 210, marginMm: 10,
    lat: -23.5, lon: 145.5, scale: 7500000, fitDone: false,
    mode: 'print', autoRefresh: true,
    base: { print: 'OSM-Topo', laser: 'none', layers: 'none' },
    colors: {
      print:  { ...MG_PALETTES.print },
      laser:  { ...MG_PALETTES.laser },
      layers: { ...MG_PALETTES.layers },
    },
    f: { contours: true, rivers: true, streams: false, stations: true, labels: true,
         graticule: true, gratLabels: true, title: true, layerTags: true },
    roles: { field: true, repeater: true, base: true },
    contour: { auto: true, interval: 10, datum: 0, majorEvery: 5, labels: true,
               detail: 288, smooth: 1, thick: 3 },
    pins: {
      field:    { shape: 'circle',  sizeMm: 2.4, filled: true },
      repeater: { shape: 'diamond', sizeMm: 3.6, filled: true },
      base:     { shape: 'cross',   sizeMm: 4.5, filled: true },
    },
    label: { sizeMm: 2.0 },
    grat: { spacing: 'auto', sizeMm: 2.2 },
    title: { text: 'MegaNet radio network' },
  };
}

// Settings survive the session the way the draw palette does — this tab is
// configured once for a billet run and revisited for weeks.
function loadSettings() {
  const d = defaults();
  try {
    const raw = localStorage.getItem('mn-mapgen');
    if (!raw) return d;
    const saved = JSON.parse(raw);
    const merge = (into, from) => {
      for (const k of Object.keys(into)) {
        if (from == null || !(k in from)) continue;
        if (into[k] && typeof into[k] === 'object' && !Array.isArray(into[k])) merge(into[k], from[k]);
        else into[k] = from[k];
      }
    };
    merge(d, saved);
    // Self-heal what an older blob may hold: a numeric leaf saved as a string
    // (or as null, which is what JSON makes of NaN) would concatenate or
    // divide by zero downstream. Anything unusable falls back to its default.
    const dd = defaults();
    const heal = (obj, def, keys) => {
      for (const k of keys) obj[k] = Number.isFinite(+obj[k]) && obj[k] !== null && obj[k] !== '' ? +obj[k] : def[k];
    };
    heal(d, dd, ['wMm', 'hMm', 'marginMm', 'lat', 'lon', 'scale']);
    heal(d.contour, dd.contour, ['interval', 'datum', 'majorEvery', 'detail', 'smooth', 'thick']);
    heal(d.label, dd.label, ['sizeMm']);
    heal(d.grat, dd.grat, ['sizeMm']);
    for (const r of ['field', 'repeater', 'base']) heal(d.pins[r], dd.pins[r], ['sizeMm']);
    if (!(d.scale >= 1000)) d.scale = dd.scale;
    return d;
  } catch (_) { return d; }
}

function save() {
  try { localStorage.setItem('mn-mapgen', JSON.stringify(mg.s)); } catch (_) {}
}

function palette() { return mg.s.colors[mg.s.mode]; }
function isVectorText() { return mg.s.mode !== 'print'; }
function baseName() { return mg.s.base[mg.s.mode]; }

// ── Data: stations, rivers, base image, DEM ──────────────────────────────────

function stationsInFrame(fr) {
  if (!state.data) return [];
  const out = [];
  for (const s of state.data.stations) {
    if (s.lat == null || s.lon == null) continue;
    const role = primaryRole(s);
    if (!mg.s.roles[role]) continue;
    const [x, y] = fr.toMm(s.lat, s.lon);
    if (x < fr.rect.x0 || x > fr.rect.x1 || y < fr.rect.y0 || y > fr.rect.y1) continue;
    out.push({ x, y, role, name: s.name || s.id, lat: s.lat, lon: s.lon });
  }
  return out;
}

async function overpassAsk(ql) {
  let last = null;
  for (const url of MG_OVERPASS) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), MG_FETCH_MS);
    try {
      const res = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) { last = err; } finally { clearTimeout(t); }
  }
  throw last || new Error('no Overpass endpoint answered');
}

async function fetchRivers(fr) {
  const pad = 0.03;
  const s = (fr.deg.south - (fr.deg.north - fr.deg.south) * pad).toFixed(3);
  const n = (fr.deg.north + (fr.deg.north - fr.deg.south) * pad).toFixed(3);
  const w = (fr.deg.west - (fr.deg.east - fr.deg.west) * pad).toFixed(3);
  const e = (fr.deg.east + (fr.deg.east - fr.deg.west) * pad).toFixed(3);
  if (n - s > 14 || e - w > 14) return { ok: false, error: 'view too wide for a river query' };
  const kinds = mg.s.f.streams ? '^(river|stream)$' : '^river$';
  const key = `${kinds}|${s},${w},${n},${e}`;
  if (mg.riverCache.has(key)) {
    const hit = mg.riverCache.get(key);
    mg.riverCache.delete(key); mg.riverCache.set(key, hit);
    return hit;
  }
  const ql = `[out:json][timeout:25];\nway["waterway"~"${kinds}"](${s},${w},${n},${e});\nout geom;`;
  try {
    const json = await overpassAsk(ql);
    const ways = [];
    for (const el of (json && json.elements) || []) {
      const coords = [];
      for (const p of el.geometry || []) {
        if (p && p.lat != null && p.lon != null) coords.push([p.lat, p.lon]);
      }
      if (coords.length < 2) continue;
      ways.push({ coords, kind: (el.tags && el.tags.waterway) || 'river' });
    }
    // Longest first before the cap, so a capped answer keeps the rivers that
    // carry the map and drops the ditches.
    ways.sort((a, b) => b.coords.length - a.coords.length);
    const capped = ways.length > MG_RIVER_CAP;
    const entry = { ok: true, ways: ways.slice(0, MG_RIVER_CAP), capped, total: ways.length };
    mg.riverCache.set(key, entry);
    while (mg.riverCache.size > 12) mg.riverCache.delete(mg.riverCache.keys().next().value);
    return entry;
  } catch (err) {
    return { ok: false, error: 'Overpass could not be reached' };
  }
}

// The base image: the frame's tiles composed onto a canvas at print
// resolution and embedded as one data URL. crossOrigin so the canvas can be
// read back; a host that withholds CORS taints it, toDataURL throws, and the
// sheet ships without a base rather than not shipping.
async function fetchBaseImage(fr) {
  const layer = MG_BASES[baseName()];
  if (!layer) return null;
  const wMerc = fr.merc.east - fr.merc.west, hMerc = fr.merc.north - fr.merc.south;
  let pxW = Math.round(fr.cw / 25.4 * MG_BASE_DPI);
  if (pxW > MG_BASE_MAX_PX) pxW = MG_BASE_MAX_PX;
  const mercPerPx = wMerc / pxW;
  const pxH = Math.round(hMerc / mercPerPx);
  const EQ = 2 * Math.PI * MG_R;
  let z = Math.round(Math.log2(EQ / (256 * mercPerPx)));
  z = Math.max(2, Math.min(layer.max, z));
  const worldPx = 256 * Math.pow(2, z);
  const pxOf = (x, y) => [(x / EQ + 0.5) * worldPx, (0.5 - y / EQ) * worldPx];
  const [px0, py0] = pxOf(fr.merc.west, fr.merc.north);
  const [px1, py1] = pxOf(fr.merc.east, fr.merc.south);
  const tx0 = Math.floor(px0 / 256), tx1 = Math.floor(px1 / 256);
  const ty0 = Math.floor(py0 / 256), ty1 = Math.floor(py1 / 256);
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 180) return { fail: 'too many base tiles at this size' };
  const key = `${baseName()}|${z}|${tx0},${ty0},${tx1},${ty1}|${pxW}`;
  if (mg.baseCache.has(key)) return mg.baseCache.get(key);

  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const sub = layer.sub ? layer.sub[(tx + ty) % layer.sub.length] : '';
      const url = layer.url.replace('{s}', sub).replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
      jobs.push(new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const t = setTimeout(() => { img.src = ''; resolve(null); }, 12000);
        img.onload = () => { clearTimeout(t); resolve({ img, tx, ty }); };
        img.onerror = () => { clearTimeout(t); resolve(null); };
        img.src = url;
      }));
    }
  }
  const tiles = (await Promise.all(jobs)).filter(Boolean);
  if (!tiles.length) return { fail: 'no base tiles arrived' };
  try {
    const cv = document.createElement('canvas');
    cv.width = pxW; cv.height = pxH;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#f2efe9';
    cx.fillRect(0, 0, pxW, pxH);
    const scale = pxW / (px1 - px0);
    for (const t of tiles) {
      cx.drawImage(t.img, (t.tx * 256 - px0) * scale, (t.ty * 256 - py0) * scale,
                   256 * scale + 0.5, 256 * scale + 0.5);
    }
    const entry = { href: cv.toDataURL('image/jpeg', 0.92), attr: layer.attr };
    mg.baseCache.set(key, entry);
    while (mg.baseCache.size > 3) mg.baseCache.delete(mg.baseCache.keys().next().value);
    return entry;
  } catch (_) {
    return { fail: 'the tile host blocks image export (CORS)' };
  }
}

// ── Contour levels and bands ─────────────────────────────────────────────────

function autoInterval(min, max) {
  const range = Math.max(1, max - min);
  for (const c of [2, 5, 10, 20, 50, 100, 200, 500]) {
    if (range / c <= 32) return c;
  }
  return 500;
}

// The cut levels for a grid: every multiple of the interval (offset by the
// datum) that the terrain in view actually crosses. Both knobs are coerced
// here as well as at the input — a stringly datum from an old saved settings
// blob would otherwise concatenate instead of add.
function contourLevels(grid) {
  const s = mg.s.contour;
  const interval = s.auto ? autoInterval(grid.min, grid.max) : Math.max(0.5, +s.interval || 10);
  const datum = +s.datum || 0;
  const first = Math.floor((grid.min - datum) / interval) * interval + datum + interval;
  const levels = [];
  let capped = false;
  for (let v = first; v < grid.max; v += interval) {
    if (levels.length >= MG_MAX_LEVELS) { capped = true; break; }
    levels.push(Math.round(v * 100) / 100);
  }
  return { interval, levels, capped };
}

// ── Feature construction (shared by flat sheet and layer files) ──────────────

function buildArt(fr, dem, riversRaw, base) {
  const s = mg.s;
  const vec = isVectorText();
  const art = { fr, base: base && base.href ? base : null, notes: [], dem: null,
                contours: null, rivers: [], grat: null, pins: [], labels: [], dropped: 0 };

  // Contours.
  if ((s.f.contours || s.mode === 'layers') && dem && dem.ok) {
    const { interval, levels, capped } = contourLevels(dem);
    if (capped) {
      art.notes.push(`contours capped at ${MG_MAX_LEVELS} levels — terrain above ` +
                     `${levels[levels.length - 1]} m not traced; widen the interval`);
    }
    const gx = fr.cw / (dem.nx - 1), gy = fr.ch / (dem.ny - 1);
    const lineSets = new Map();
    for (const lv of levels) {
      const lines = isolines(dem.elev, dem.nx, dem.ny, lv).map(l => {
        let pts = l.pts.map(([px, py]) => [fr.rect.x0 + px * gx, fr.rect.y0 + py * gy]);
        pts = chaikin(pts, l.closed, Math.max(0, Math.min(3, s.contour.smooth | 0)));
        pts = simplify(pts, MG_SIMPLIFY_MM);
        return { pts, closed: l.closed };
      }).filter(l => l.pts.length > 1);
      lineSets.set(lv, lines);
    }
    art.dem = dem;
    art.contours = { interval, levels, lineSets };
    if (dem.missing) art.notes.push(`terrain partial — ${dem.missing} DEM tile(s) missing`);
  } else if (s.f.contours || s.mode === 'layers') {
    art.notes.push(dem && dem.error ? `contours unavailable — ${dem.error}` : 'contours unavailable — terrain tiles could not be fetched');
  }

  // Band lookup for layered mode: which plate is on top at a point.
  const bandAt = (() => {
    if (!art.contours || !art.dem) return () => 0;
    const { levels } = art.contours;
    const d = art.dem;
    return (x, y) => {
      const gi = Math.round((x - fr.rect.x0) / fr.cw * (d.nx - 1));
      const gj = Math.round((y - fr.rect.y0) / fr.ch * (d.ny - 1));
      const e = d.elev[Math.max(0, Math.min(d.ny - 1, gj)) * d.nx + Math.max(0, Math.min(d.nx - 1, gi))];
      if (Number.isNaN(e)) return 0;
      let b = 0;
      while (b < levels.length && e >= levels[b]) b++;
      return b;
    };
  })();
  art.bandAt = bandAt;

  // Rivers — projected, clipped, banded, simplified.
  if (s.f.rivers && riversRaw) {
    if (riversRaw.ok) {
      for (const way of riversRaw.ways) {
        const mm = way.coords.map(([lat, lon]) => fr.toMm(lat, lon));
        for (const piece of clipPolyline(mm, fr.rect)) {
          const simp = simplify(piece, 0.12);
          let len = 0;
          for (let i = 1; i < simp.length; i++) len += Math.hypot(simp[i][0] - simp[i - 1][0], simp[i][1] - simp[i - 1][1]);
          if (len < 1.2) continue;
          art.rivers.push({ pts: simp, kind: way.kind });
        }
      }
      if (riversRaw.capped) art.notes.push(`rivers capped — ${riversRaw.total - riversRaw.ways.length} smaller watercourses not drawn`);
    } else {
      art.notes.push(`rivers unavailable — ${riversRaw.error}`);
    }
  }

  // Graticule.
  if (s.f.graticule) {
    const spanLon = fr.deg.east - fr.deg.west, spanLat = fr.deg.north - fr.deg.south;
    let sp = s.grat.spacing === 'auto' ? null : +s.grat.spacing;
    if (!sp || !(sp > 0)) {
      sp = 10;
      for (const c of [10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01]) {
        if (Math.max(spanLon, spanLat) / c >= 3) { sp = c; break; }
      }
    }
    const dec = (() => { for (let d = 0; d <= 4; d++) { const m2 = sp * Math.pow(10, d); if (Math.abs(m2 - Math.round(m2)) < 1e-9) return d; } return 4; })();
    const fmt = (v, hemi) => Math.abs(v).toFixed(dec) + '°' + (hemi === 'lat' ? (v < 0 ? 'S' : 'N') : (v < 0 ? 'W' : 'E'));
    const grat = { lines: [], labels: [], sp };
    for (let lon = Math.ceil(fr.deg.west / sp) * sp; lon < fr.deg.east; lon += sp) {
      const x = fr.toMm(s.lat, lon)[0];
      if (x < fr.rect.x0 + 0.5 || x > fr.rect.x1 - 0.5) continue;
      grat.lines.push([[x, fr.rect.y0], [x, fr.rect.y1]]);
      if (s.f.gratLabels) {
        grat.labels.push({ x: x + 0.8, y: fr.rect.y0 + s.grat.sizeMm + 0.8, text: fmt(lon, 'lon'), anchor: 'start' });
        grat.labels.push({ x: x + 0.8, y: fr.rect.y1 - 1.2, text: fmt(lon, 'lon'), anchor: 'start' });
      }
    }
    for (let lat = Math.ceil(fr.deg.south / sp) * sp; lat < fr.deg.north; lat += sp) {
      const y = fr.toMm(lat, s.lon)[1];
      if (y < fr.rect.y0 + 0.5 || y > fr.rect.y1 - 0.5) continue;
      grat.lines.push([[fr.rect.x0, y], [fr.rect.x1, y]]);
      if (s.f.gratLabels) {
        grat.labels.push({ x: fr.rect.x0 + 1.0, y: y - 0.8, text: fmt(lat, 'lat'), anchor: 'start' });
        grat.labels.push({ x: fr.rect.x1 - 1.0, y: y - 0.8, text: fmt(lat, 'lat'), anchor: 'end' });
      }
    }
    art.grat = grat;
  }

  // Pins, then names with overlap management: bases first (there are four in
  // the whole network and they anchor the sheet), repeaters, then field
  // stations; each name tries eight positions around its pin and a name that
  // fits nowhere is dropped and counted rather than printed on a neighbour.
  const pins = stationsInFrame(fr);
  const order = { base: 0, repeater: 1, field: 2 };
  pins.sort((a, b) => order[a.role] - order[b.role]);
  art.pins = pins;
  if (s.f.labels && pins.length) {
    const placed = [];
    if (s.f.title) {
      const tb = titleBlockLayout(fr, art, vec);
      placed.push({ x: tb.x, y: tb.y, w: tb.w, h: tb.hgt });
    }
    for (const p of pins) {
      const r = s.pins[p.role].sizeMm / 2;
      placed.push({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r });
    }
    const sz = s.label.sizeMm;
    let attempts = 0;
    for (const p of pins) {
      if (attempts >= MG_LABEL_CAP) { art.dropped++; continue; }
      attempts++;
      const w = measureText(p.name, sz, vec), h = sz * 1.15;
      const r = s.pins[p.role].sizeMm / 2 + 0.6;
      const cands = [
        [p.x + r, p.y + sz * 0.36], [p.x - r - w, p.y + sz * 0.36],
        [p.x - w / 2, p.y - r - h * 0.25], [p.x - w / 2, p.y + r + h * 0.8],
        [p.x + r * 0.8, p.y - r * 0.8], [p.x - r * 0.8 - w, p.y - r * 0.8],
        [p.x + r * 0.8, p.y + r * 0.8 + h * 0.6], [p.x - r * 0.8 - w, p.y + r * 0.8 + h * 0.6],
      ];
      let done = false;
      for (const [lx, ly] of cands) {
        const box = { x: lx, y: ly - h * 0.8, w, h };
        if (box.x < fr.rect.x0 + 0.5 || box.x + box.w > fr.rect.x1 - 0.5 ||
            box.y < fr.rect.y0 + 0.5 || box.y + box.h > fr.rect.y1 - 0.5) continue;
        if (placed.some(q => box.x < q.x + q.w && box.x + box.w > q.x && box.y < q.y + q.h && box.y + box.h > q.y)) continue;
        placed.push(box);
        art.labels.push({ x: lx, y: ly, text: p.name, px: p.x, py: p.y });
        done = true;
        break;
      }
      if (!done) art.dropped++;
    }
    if (art.dropped) art.notes.push(`${art.dropped} station name(s) dropped to avoid overlap`);
  }

  return art;
}

// ── SVG assembly ─────────────────────────────────────────────────────────────

function pinMarkup(p, color) {
  const st = mg.s.pins[p.role];
  const r = st.sizeMm / 2;
  const x = p.x, y = p.y;
  const f2 = v => v.toFixed(2);
  const paint = st.filled ? `fill="${color}"` : `fill="none" stroke="${color}" stroke-width="0.3"`;
  switch (st.shape) {
    case 'circle':   return `<circle cx="${f2(x)}" cy="${f2(y)}" r="${f2(r)}" ${paint}/>`;
    case 'square':   return `<rect x="${f2(x - r)}" y="${f2(y - r)}" width="${f2(2 * r)}" height="${f2(2 * r)}" ${paint}/>`;
    case 'diamond':  return `<path d="M${f2(x)} ${f2(y - r)} L${f2(x + r)} ${f2(y)} L${f2(x)} ${f2(y + r)} L${f2(x - r)} ${f2(y)} Z" ${paint}/>`;
    case 'triangle': return `<path d="M${f2(x)} ${f2(y - r)} L${f2(x + r * 0.87)} ${f2(y + r * 0.5)} L${f2(x - r * 0.87)} ${f2(y + r * 0.5)} Z" ${paint}/>`;
    case 'cross': {
      if (!st.filled) return `<path d="M${f2(x - r)} ${f2(y)} L${f2(x + r)} ${f2(y)} M${f2(x)} ${f2(y - r)} L${f2(x)} ${f2(y + r)}" fill="none" stroke="${color}" stroke-width="0.35"/>`;
      const b = r * 0.28;
      return `<path d="M${f2(x - b)} ${f2(y - r)} L${f2(x + b)} ${f2(y - r)} L${f2(x + b)} ${f2(y - b)} L${f2(x + r)} ${f2(y - b)} L${f2(x + r)} ${f2(y + b)} L${f2(x + b)} ${f2(y + b)} L${f2(x + b)} ${f2(y + r)} L${f2(x - b)} ${f2(y + r)} L${f2(x - b)} ${f2(y + b)} L${f2(x - r)} ${f2(y + b)} L${f2(x - r)} ${f2(y - b)} L${f2(x - b)} ${f2(y - b)} Z" fill="${color}"/>`;
    }
    case 'x': {
      const a = r * 0.71;
      if (!st.filled) return `<path d="M${f2(x - a)} ${f2(y - a)} L${f2(x + a)} ${f2(y + a)} M${f2(x - a)} ${f2(y + a)} L${f2(x + a)} ${f2(y - a)}" fill="none" stroke="${color}" stroke-width="0.35"/>`;
      const b = r * 0.2;
      return `<path d="M${f2(x - a)} ${f2(y - a + b)} L${f2(x - a + b)} ${f2(y - a)} L${f2(x)} ${f2(y - b)} L${f2(x + a - b)} ${f2(y - a)} L${f2(x + a)} ${f2(y - a + b)} L${f2(x + b)} ${f2(y)} L${f2(x + a)} ${f2(y + a - b)} L${f2(x + a - b)} ${f2(y + a)} L${f2(x)} ${f2(y + b)} L${f2(x - a + b)} ${f2(y + a)} L${f2(x - a)} ${f2(y + a - b)} L${f2(x - b)} ${f2(y)} Z" fill="${color}"/>`;
    }
    default: return `<circle cx="${f2(x)}" cy="${f2(y)}" r="${f2(r)}" ${paint}/>`;
  }
}

function niceScaleBarKm(fr) {
  const targetMm = Math.min(50, fr.cw * 0.35);
  const targetKm = targetMm * mg.s.scale / 1e6;
  let best = 0;
  for (const m of [1, 2, 5]) {
    for (let e = -2; e <= 4; e++) {
      const v = m * Math.pow(10, e);
      if (v <= targetKm && v > best) best = v;
    }
  }
  return best || 0.01;   // finer than every candidate: take the smallest bar
}

// The block's facts and geometry, shared between the markup below and the
// label placer — names must treat the block as occupied ground, so its box
// has to be knowable before it is drawn.
function titleBlockLayout(fr, art, vec) {
  const s = mg.s;
  const sz = { title: 3.4, meta: 2.0, pad: 2.4 };
  const dstr = localDateStr();
  const scaleStr = '1:' + Math.round(s.scale).toLocaleString('en-AU').replace(/,/g, ' ');
  const meta1 = scaleStr
    + (art.contours ? ` · contours ${art.contours.interval} m` : '')
    + ` · ${dstr}`;
  const meta2 = `Centre ${Math.abs(s.lat).toFixed(3)}°${s.lat < 0 ? 'S' : 'N'} ${Math.abs(s.lon).toFixed(3)}°${s.lon < 0 ? 'W' : 'E'}`
    + (art.base ? ` · ${art.base.attr.replace(/©/g, '(c)')}` : '');
  const legendRoles = s.f.stations ? ['base', 'repeater', 'field'].filter(r => s.roles[r]) : [];
  const barKm = niceScaleBarKm(fr);
  const barMm = barKm * 1e6 / s.scale;
  const barLabel = barKm >= 1 ? `${barKm} km` : `${Math.round(barKm * 1000)} m`;
  const widths = [
    measureText(s.title.text, sz.title, vec),
    measureText(meta1, sz.meta, vec),
    measureText(meta2, sz.meta, vec),
    barMm + measureText(barLabel, sz.meta, vec) + 4,
  ];
  const w = Math.max(46, ...widths) + 2 * sz.pad;
  let hgt = sz.pad + sz.title + 1.6 + (sz.meta + 1.2) * 2 + 1.0;
  if (legendRoles.length) hgt += 4.6;
  hgt += 5.2 + sz.pad - 1.5;
  return { sz, meta1, meta2, legendRoles, barKm, barMm, barLabel, w, hgt,
           x: fr.rect.x0 + 4, y: fr.rect.y1 - 4 - hgt };
}

function titleBlockMarkup(fr, art, colors, vec) {
  const s = mg.s;
  const { sz, meta1, meta2, legendRoles, barMm, barLabel, w, hgt, x, y } = titleBlockLayout(fr, art, vec);
  const out = [];
  out.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${hgt.toFixed(2)}"` +
           ` fill="${vec ? 'none' : '#ffffff'}" fill-opacity="0.92" stroke="${colors.title}" stroke-width="0.25"/>`);
  let ty = y + sz.pad + sz.title;
  out.push(textMarkup(x + sz.pad, ty, s.title.text, sz.title, colors.title, { vector: vec }));
  ty += 1.6 + sz.meta;
  out.push(textMarkup(x + sz.pad, ty, meta1, sz.meta, colors.title, { vector: vec }));
  ty += 1.2 + sz.meta;
  out.push(textMarkup(x + sz.pad, ty, meta2, sz.meta, colors.title, { vector: vec }));
  if (legendRoles.length) {
    ty += 3.6;
    let lx = x + sz.pad + 2;
    const roleLabel = { base: 'Base', repeater: 'Repeater', field: 'Field' };
    for (const r of legendRoles) {
      out.push(pinMarkup({ x: lx, y: ty - sz.meta * 0.35, role: r }, colors['pin' + r[0].toUpperCase() + r.slice(1)]));
      const t = roleLabel[r];
      out.push(textMarkup(lx + s.pins[r].sizeMm / 2 + 1.2, ty, t, sz.meta, colors.title, { vector: vec }));
      lx += s.pins[r].sizeMm / 2 + 1.2 + measureText(t, sz.meta, vec) + 4.5;
    }
  }
  // Scale bar: a line with end and middle ticks, true at the centre latitude.
  ty += 4.4;
  const bx = x + sz.pad;
  out.push(`<path d="M${bx.toFixed(2)} ${ty.toFixed(2)} L${(bx + barMm).toFixed(2)} ${ty.toFixed(2)}` +
           ` M${bx.toFixed(2)} ${(ty - 1.2).toFixed(2)} L${bx.toFixed(2)} ${ty.toFixed(2)}` +
           ` M${(bx + barMm / 2).toFixed(2)} ${(ty - 0.8).toFixed(2)} L${(bx + barMm / 2).toFixed(2)} ${ty.toFixed(2)}` +
           ` M${(bx + barMm).toFixed(2)} ${(ty - 1.2).toFixed(2)} L${(bx + barMm).toFixed(2)} ${ty.toFixed(2)}"` +
           ` fill="none" stroke="${colors.title}" stroke-width="0.3"/>`);
  out.push(textMarkup(bx + barMm + 1.5, ty + 0.4, barLabel, sz.meta, colors.title, { vector: vec }));
  return out.join('\n');
}

function svgOpen(fr, forFile) {
  const head = forFile ? '<?xml version="1.0" encoding="UTF-8"?>\n' : '';
  return head +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"` +
    ` width="${fr.w}mm" height="${fr.h}mm" viewBox="0 0 ${fr.w} ${fr.h}">\n` +
    `<defs><clipPath id="mg-clip"><rect x="${fr.rect.x0}" y="${fr.rect.y0}"` +
    ` width="${fr.cw}" height="${fr.ch}"/></clipPath></defs>\n`;
}

function borderMarkup(fr, color) {
  return `<rect x="${fr.rect.x0}" y="${fr.rect.y0}" width="${fr.cw}" height="${fr.ch}"` +
         ` fill="none" stroke="${color}" stroke-width="0.2"/>`;
}

// The whole map on one sheet — the print pathway and the single-plate laser
// pathway ("cut the border, engrave everything").
function flatSvg(art, forFile) {
  const fr = art.fr, s = mg.s, colors = palette(), vec = isVectorText();
  const out = [svgOpen(fr, forFile)];
  if (!vec) out.push(`<rect x="0" y="0" width="${fr.w}" height="${fr.h}" fill="#ffffff"/>`);
  out.push('<g clip-path="url(#mg-clip)">');
  if (art.base) {
    out.push(`<image x="${fr.rect.x0}" y="${fr.rect.y0}" width="${fr.cw}" height="${fr.ch}"` +
             ` preserveAspectRatio="none" href="${art.base.href}" xlink:href="${art.base.href}"/>`);
  }
  if (s.f.contours && art.contours) {
    const { levels, lineSets, interval } = art.contours;
    const majorEvery = Math.max(1, s.contour.majorEvery | 0);
    for (const lv of levels) {
      const major = Math.round(lv / interval) % majorEvery === 0;
      const d = lineSets.get(lv).map(l => pathD(l.pts, l.closed)).join(' ');
      if (!d) continue;
      out.push(`<path d="${d}" fill="none" stroke="${major ? colors.contourMajor : colors.contour}"` +
               ` stroke-width="${major ? 0.3 : 0.16}"/>`);
      if (s.contour.labels && major && !vec) {
        for (const l of lineSets.get(lv)) {
          if (l.pts.length < 12) continue;
          const p = l.pts[Math.floor(l.pts.length / 2)];
          out.push(textMarkup(p[0], p[1] - 0.4, String(lv), 1.8, colors.contourMajor, { halo: true, anchor: 'middle' }));
        }
      }
    }
  }
  if (s.f.rivers) {
    for (const r of art.rivers) {
      out.push(`<path d="${pathD(r.pts)}" fill="none" stroke="${colors.river}"` +
               ` stroke-width="${r.kind === 'stream' ? 0.18 : 0.35}" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
  }
  if (art.grat) {
    const d = art.grat.lines.map(l => pathD(l)).join(' ');
    if (d) out.push(`<path d="${d}" fill="none" stroke="${colors.grat}" stroke-width="0.13"/>`);
    for (const lb of art.grat.labels) {
      out.push(textMarkup(lb.x, lb.y, lb.text, s.grat.sizeMm, colors.gratText, { vector: vec, anchor: lb.anchor, halo: !vec }));
    }
  }
  if (s.f.stations) {
    for (const p of art.pins) out.push(pinMarkup(p, colors['pin' + p.role[0].toUpperCase() + p.role.slice(1)]));
  }
  if (s.f.labels) {
    for (const lb of art.labels) out.push(textMarkup(lb.x, lb.y, lb.text, s.label.sizeMm, colors.label, { vector: vec, halo: !vec }));
  }
  if (s.f.title) out.push(titleBlockMarkup(fr, art, colors, vec));
  out.push('</g>');
  out.push(borderMarkup(fr, colors.border));
  out.push('</svg>');
  return out.join('\n');
}

// One layered-mode file. Red cuts this layer's own contour (plus the border,
// so pieces that touch the plate edge come free); blue engraves the next
// level up as the assembly jig; surface details engrave only on the band
// this plate actually shows once the stack is together.
function layerSvg(art, k, forFile) {
  const fr = art.fr, s = mg.s, colors = mg.s.colors.layers;
  const { levels, lineSets, interval } = art.contours;
  const cutLv = k > 0 ? levels[k - 1] : null;
  const alignLv = k < levels.length ? levels[k] : null;
  const out = [svgOpen(fr, forFile)];
  out.push('<g clip-path="url(#mg-clip)">');

  const bandPieces = polys => {
    const kept = [];
    for (const { pts, kind } of polys) {
      for (const piece of splitByBand(pts, art.bandAt)) {
        if (piece.band !== k) continue;
        const simp = simplify(piece.pts, 0.1);
        if (simp.length > 1) kept.push({ pts: simp, kind });
      }
    }
    return kept;
  };

  if (s.f.rivers && art.rivers.length) {
    for (const r of bandPieces(art.rivers)) {
      out.push(`<path d="${pathD(r.pts)}" fill="none" stroke="${colors.river}"` +
               ` stroke-width="${r.kind === 'stream' ? 0.18 : 0.3}" stroke-linecap="round"/>`);
    }
  }
  if (art.grat) {
    for (const g of bandPieces(art.grat.lines.map(pts => ({ pts })))) {
      out.push(`<path d="${pathD(g.pts)}" fill="none" stroke="${colors.grat}" stroke-width="0.13"/>`);
    }
    for (const lb of art.grat.labels) {
      if (art.bandAt(lb.x, lb.y) !== k) continue;
      out.push(textMarkup(lb.x, lb.y, lb.text, s.grat.sizeMm, colors.gratText, { vector: true, anchor: lb.anchor }));
    }
  }
  if (s.f.stations) {
    for (const p of art.pins) {
      if (art.bandAt(p.x, p.y) !== k) continue;
      out.push(pinMarkup(p, colors['pin' + p.role[0].toUpperCase() + p.role.slice(1)]));
    }
  }
  if (s.f.labels) {
    for (const lb of art.labels) {
      if (art.bandAt(lb.px, lb.py) !== k) continue;
      out.push(textMarkup(lb.x, lb.y, lb.text, s.label.sizeMm, colors.label, { vector: true }));
    }
  }
  if (s.f.title && k === 0) out.push(titleBlockMarkup(fr, art, colors, true));
  if (alignLv != null) {
    const d = lineSets.get(alignLv).map(l => pathD(l.pts, l.closed)).join(' ');
    if (d) out.push(`<path d="${d}" fill="none" stroke="${colors.align}" stroke-width="0.16"/>`);
  }
  if (cutLv != null) {
    const d = lineSets.get(cutLv).map(l => pathD(l.pts, l.closed)).join(' ');
    if (d) out.push(`<path d="${d}" fill="none" stroke="${colors.border}" stroke-width="0.2"/>`);
  }
  if (s.f.layerTags) {
    const tag = `L${String(k).padStart(2, '0')}` +
      (cutLv != null ? ` · cut ${cutLv} m` : ' · base') +
      (alignLv != null ? ` · next ${alignLv} m` : '');
    out.push(textMarkup(fr.rect.x1 - 2, fr.rect.y1 - 2, tag, 2.0, colors.align, { vector: true, anchor: 'end' }));
  }
  out.push('</g>');
  out.push(borderMarkup(fr, colors.border));
  out.push('</svg>');
  return out.join('\n');
}

// A polyline diced into runs by elevation band — how a river that climbs
// through three plates is shared out among the three files. Sampled about
// every 0.8 mm; the simplify pass downstream re-thins what this densifies.
function splitByBand(pts, bandAt) {
  const out = [];
  let cur = null, curBand = -1e9;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.8));
    for (let kk = 0; kk < n; kk++) {
      const t0 = kk / n, t1 = (kk + 1) / n;
      const p0 = [ax + (bx - ax) * t0, ay + (by - ay) * t0];
      const p1 = [ax + (bx - ax) * t1, ay + (by - ay) * t1];
      const b = bandAt((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
      if (!cur || b !== curBand) { cur = [p0, p1]; curBand = b; out.push({ band: b, pts: cur }); }
      else cur.push(p1);
    }
  }
  return out;
}

// ── The generate pipeline ────────────────────────────────────────────────────

function scheduleGen() {
  clearTimeout(mg.timer);
  if (!mg.s.autoRefresh) { setStatus('Changed — press Generate to refresh.'); return; }
  mg.timer = setTimeout(() => { generate().catch(() => {}); }, MG_DEBOUNCE_MS);
}

async function generate() {
  if (state.activeTab !== 'mapgen') return;
  const mine = ++mg.seq;
  const t0 = Date.now();
  setStatus('Generating…');
  const fr = frame();
  const s = mg.s;
  const needDem = s.f.contours || s.mode === 'layers';
  const pad = 0.02;
  const demBox = {
    west: fr.deg.west - (fr.deg.east - fr.deg.west) * pad, east: fr.deg.east + (fr.deg.east - fr.deg.west) * pad,
    south: fr.deg.south, north: fr.deg.north,
  };
  const detail = Math.max(96, Math.min(512, s.contour.detail | 0));
  const [dem, rivers, base] = await Promise.all([
    needDem ? Terrain.grid({ west: fr.deg.west, south: fr.deg.south, east: fr.deg.east, north: fr.deg.north },
                           detail, Math.round(detail * fr.ch / fr.cw)).catch(() => null) : Promise.resolve(null),
    s.f.rivers ? fetchRivers(fr).catch(() => ({ ok: false, error: 'Overpass could not be reached' })) : Promise.resolve(null),
    baseName() !== 'none' ? fetchBaseImage(fr).catch(() => ({ fail: 'base tiles could not be fetched' })) : Promise.resolve(null),
  ]);
  if (mine !== mg.seq || state.activeTab !== 'mapgen') return;

  const art = buildArt(fr, dem, rivers, base);
  if (base && base.fail) art.notes.push(`base map omitted — ${base.fail}`);
  mg.gen = { art, when: Date.now() };
  mg.layerSvgCache.clear();
  // The file ticks and the preview pick survive a regenerate as long as the
  // layer count still matches — a re-tuned interval is a different stack, so
  // that resets both rather than mis-mapping ticks onto different levels.
  const n = layerCount();
  if (!mg.layerSel || Object.keys(mg.layerSel).length !== n) {
    mg.layerSel = n ? Object.fromEntries(Array.from({ length: n }, (_, i) => [i, true])) : null;
    if (mg.previewPick !== 'flat') mg.previewPick = 'flat';
  }
  renderPreview();
  refreshPanel('export');
  syncNotes(Date.now() - t0);
}

function layerCount() {
  const g = mg.gen;
  return g && g.art.contours ? g.art.contours.levels.length + 1 : 0;
}

function layerFileSvg(k) {
  if (!mg.layerSvgCache.has(k)) mg.layerSvgCache.set(k, layerSvg(mg.gen.art, k, true));
  return mg.layerSvgCache.get(k);
}

function layerFileName(k) {
  const g = mg.gen.art.contours;
  const lv = k > 0 ? g.levels[k - 1] : null;
  const date = localDateStr();
  return `meganet-map-${date}-layer-${String(k).padStart(2, '0')}-` +
         (lv == null ? 'base' : String(lv).replace('.', '_') + 'm') + '.svg';
}

// ── Preview, status, notes ───────────────────────────────────────────────────

function setStatus(text) {
  const el = document.getElementById('mg-status');
  if (el) el.textContent = text;
}

function syncNotes(ms) {
  const g = mg.gen;
  if (!g) return;
  const bits = [];
  if (ms != null) bits.push(`generated in ${(ms / 1000).toFixed(1)} s`);
  if (g.art.dem) {
    bits.push(`terrain ${g.art.dem.min}–${g.art.dem.max} m (z${g.art.dem.zoom}, ~${g.art.dem.resolution_m} m grid)`);
    if (g.art.contours) bits.push(`${g.art.contours.levels.length} contour level(s) at ${g.art.contours.interval} m`);
  }
  if (mg.s.f.rivers) bits.push(`${g.art.rivers.length} river piece(s)`);
  if (mg.s.f.stations) bits.push(`${g.art.pins.length} station(s) in frame`);
  setStatus(bits.join(' · ') || 'Generated.');
  const el = document.getElementById('mg-notes');
  if (el) {
    el.innerHTML = g.art.notes.length
      ? g.art.notes.map(n => `<li>${esc(n)}</li>`).join('')
      : '';
    el.hidden = !g.art.notes.length;
  }
}

function renderPreview() {
  const el = document.getElementById('mg-preview');
  if (!el || !mg.gen) return;
  const want = mg.previewPick;
  let svg;
  if (want !== 'flat' && mg.s.mode === 'layers' && mg.gen.art.contours) {
    const k = Math.max(0, Math.min(layerCount() - 1, +want || 0));
    svg = layerSvg(mg.gen.art, k, false);
  } else {
    svg = flatSvg(mg.gen.art, false);
  }
  el.innerHTML = svg;
}

// ── The view-picker map ──────────────────────────────────────────────────────

function buildMiniMap() {
  const el = document.getElementById('mg-minimap');
  if (!el) return;
  mg.map = removeMap(mg.map);
  mg.map = L.map('mg-minimap');
  registerLiveMap('MapGen', () => mg.map);
  addBaseLayers(mg.map);
  const fr = frame();
  mg.map.fitBounds([[fr.deg.south, fr.deg.west], [fr.deg.north, fr.deg.east]], { padding: [12, 12] });
  syncRect();
}

function syncRect() {
  if (!mg.map) return;
  const fr = frame();
  const bounds = [[fr.deg.south, fr.deg.west], [fr.deg.north, fr.deg.east]];
  if (mg.rect) mg.rect.setBounds(bounds);
  else mg.rect = L.rectangle(bounds, { color: '#c7401a', weight: 1.5, fill: false, dashArray: '4 3', interactive: false }).addTo(mg.map);
}

// ── Settings plumbing shared by the handlers ─────────────────────────────────

function afterChange(opts) {
  const o = opts || {};
  save();
  syncRect();
  if (o.panel) refreshPanel(o.panel, o.focus);
  scheduleGen();
}

function num(v, lo, hi, fallback) {
  const n = parseFloat(v);
  if (isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// ── UI — panels ──────────────────────────────────────────────────────────────

function checkRow(label, path, checked, extra) {
  return `<label class="mg-check"><input type="checkbox" ${checked ? 'checked' : ''}` +
         ` onchange="MapGen.set('${path}', this.checked, 'bool')">${label}</label>${extra || ''}`;
}

function colorInput(key) {
  const v = palette()[key];
  return `<input type="color" class="mg-color" value="${esc(v)}" aria-label="${esc(MG_COLOR_LABELS.find(c => c[0] === key)[1])} colour"` +
         ` onchange="MapGen.setColor('${key}', this.value)">`;
}

// The fields half of the Output area panel only — the #mg-minimap div above
// it is deliberately NOT part of this: the live Leaflet map is mounted in it,
// and re-rendering the container out from under the map would leave mg.map
// bound to a detached DOM node and the picker blank.
function viewFieldsHtml() {
  const s = mg.s;
  return `
    <div class="button-row mg-row">
      <button onclick="MapGen.centreHere()" title="Move the output frame to this map view's centre">Centre output here</button>
      <button onclick="MapGen.showOutput()" title="Pan the picker to the output frame">Show output area</button>
      <button onclick="MapGen.useStationsFit()" title="Frame every station in the loaded file">Fit all stations</button>
    </div>
    <div class="control-row" id="mg-view-fields">
      <label>Centre latitude
        <input type="number" step="0.0001" class="mg-num" value="${s.lat}" onchange="MapGen.set('lat', this.value, 'lat')"></label>
      <label>Centre longitude
        <input type="number" step="0.0001" class="mg-num" value="${s.lon}" onchange="MapGen.set('lon', this.value, 'lon')"></label>
      <label>Scale 1:
        <input type="number" step="1000" min="1000" max="50000000" class="mg-num" value="${s.scale}"
               onchange="MapGen.set('scale', this.value, 'scale')" list="mg-scales"></label>
      <datalist id="mg-scales">
        <option value="25000"></option><option value="50000"></option><option value="100000"></option>
        <option value="250000"></option><option value="500000"></option><option value="1000000"></option>
      </datalist>
    </div>
    <div class="button-row mg-row" role="group" aria-label="Step the output frame by one plate, for tiled maps">
      <button onclick="MapGen.nudge(-1,0)" aria-label="Step west one plate" title="Step west one plate width">◀</button>
      <button onclick="MapGen.nudge(0,1)" aria-label="Step north one plate" title="Step north one plate height">▲</button>
      <button onclick="MapGen.nudge(0,-1)" aria-label="Step south one plate" title="Step south one plate height">▼</button>
      <button onclick="MapGen.nudge(1,0)" aria-label="Step east one plate" title="Step east one plate width">▶</button>
      <span class="mg-hint">Steps move exactly one plate — tile a large area billet by billet.</span>
    </div>`;
}

function pagePanelHtml() {
  const s = mg.s;
  const custom = s.preset === 'custom';
  return `
    <div class="panel-header"><h2>Page &amp; size</h2></div>
    <div class="control-row">
      <label>Preset
        <select onchange="MapGen.setPreset(this.value)">
          ${Object.entries(MG_PRESETS).map(([k, p]) =>
            `<option value="${k}" ${s.preset === k ? 'selected' : ''}>${p.label}</option>`).join('')}
        </select></label>
      ${custom ? `
      <label>Width mm
        <input type="number" min="40" max="2000" class="mg-num" value="${s.wMm}" onchange="MapGen.set('wMm', this.value, 'dim')"></label>
      <label>Height mm
        <input type="number" min="40" max="2000" class="mg-num" value="${s.hMm}" onchange="MapGen.set('hMm', this.value, 'dim')"></label>` : ''}
      <label>Margin mm
        <input type="number" min="0" max="80" step="0.5" class="mg-num" value="${s.marginMm}" onchange="MapGen.set('marginMm', this.value, 'margin')"></label>
    </div>
    <p class="mg-hint">${esc(coverageHint())}</p>`;
}

function coverageHint() {
  const fr = frame();
  const kmW = fr.cw * mg.s.scale / 1e6, kmH = fr.ch * mg.s.scale / 1e6;
  return `Content ${fr.cw.toFixed(0)} × ${fr.ch.toFixed(0)} mm covers ` +
         `${kmW.toFixed(kmW < 10 ? 1 : 0)} × ${kmH.toFixed(kmH < 10 ? 1 : 0)} km at the centre latitude.`;
}

function modePanelHtml() {
  const s = mg.s;
  const modes = [
    ['print',  'Print / PDF', 'Colour sheet for paper or PDF — technicians’ pathway'],
    ['laser',  'Laser — single plate', 'One SVG: red border cut, everything else engraved'],
    ['layers', 'Laser — layered cut', 'One SVG per elevation level for stacked terrain'],
  ];
  return `
    <div class="panel-header"><h2>Output mode &amp; colours</h2></div>
    <div class="mg-modes" role="radiogroup" aria-label="Output mode">
      ${modes.map(([k, label, hint]) => `
      <label class="mg-mode${s.mode === k ? ' on' : ''}" title="${esc(hint)}">
        <input type="radio" name="mg-mode" value="${k}" ${s.mode === k ? 'checked' : ''}
               onchange="MapGen.setMode(this.value)">${label}</label>`).join('')}
    </div>
    <div class="control-row">
      <label>Base map
        <select onchange="MapGen.setBase(this.value)">
          ${Object.keys(MG_BASES).map(k =>
            `<option value="${k}" ${baseName() === k ? 'selected' : ''}>${k === 'none' ? 'None (blank)' : k}</option>`).join('')}
        </select></label>
    </div>
    <div class="mg-colors">
      ${MG_COLOR_LABELS.filter(([k]) => s.mode === 'layers' || k !== 'align').map(([k, label]) => `
      <label class="mg-color-row"><span>${label}</span>${colorInput(k)}</label>`).join('')}
    </div>
    <div class="button-row mg-row">
      <button onclick="MapGen.resetColors()" title="Reset this mode's colours to its defaults — laser modes reset to K40 black/blue/red">Reset colours</button>
      <span class="mg-hint">K40 Whisperer: black = raster engrave, blue #0000FF = vector engrave, red #FF0000 = vector cut.</span>
    </div>`;
}

function featuresPanelHtml() {
  const s = mg.s;
  const shapes = ['circle', 'square', 'diamond', 'triangle', 'cross', 'x'];
  const roleLabel = { field: 'Field', repeater: 'Repeater', base: 'Base' };
  return `
    <div class="panel-header"><h2>Features</h2></div>

    <h3 class="mg-sub">Contours</h3>
    ${checkRow('Elevation contours', 'f.contours', s.f.contours)}
    <div class="control-row${s.f.contours || s.mode === 'layers' ? '' : ' is-off'}">
      <label class="mg-check"><input type="checkbox" ${s.contour.auto ? 'checked' : ''}
             onchange="MapGen.set('contour.auto', this.checked, 'bool-panel')">Auto interval</label>
      <label>Interval m
        <input type="number" min="0.5" step="0.5" class="mg-num" value="${s.contour.interval}"
               ${s.contour.auto ? 'disabled' : ''} onchange="MapGen.set('contour.interval', this.value, 'num')"></label>
      <label>Datum offset m
        <input type="number" step="1" class="mg-num" value="${s.contour.datum}" onchange="MapGen.set('contour.datum', this.value, 'num')"></label>
      <label>Index every
        <input type="number" min="1" max="20" class="mg-num" value="${s.contour.majorEvery}" onchange="MapGen.set('contour.majorEvery', this.value, 'num')"></label>
    </div>
    <div class="control-row${s.f.contours || s.mode === 'layers' ? '' : ' is-off'}">
      <label>Detail
        <select onchange="MapGen.set('contour.detail', this.value, 'num')">
          ${[[192, 'Fast'], [288, 'Standard'], [384, 'Fine'], [512, 'Finest']].map(([v, l]) =>
            `<option value="${v}" ${+s.contour.detail === v ? 'selected' : ''}>${l} (${v})</option>`).join('')}
        </select></label>
      <label>Smoothing
        <select onchange="MapGen.set('contour.smooth', this.value, 'num')">
          ${[[0, 'None'], [1, 'Light'], [2, 'Medium'], [3, 'Heavy']].map(([v, l]) =>
            `<option value="${v}" ${+s.contour.smooth === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      ${checkRow('Label index contours (print)', 'contour.labels', s.contour.labels)}
    </div>

    <h3 class="mg-sub">Rivers</h3>
    ${checkRow('Rivers (OpenStreetMap)', 'f.rivers', s.f.rivers)}
    ${checkRow('Include streams too', 'f.streams', s.f.streams)}

    <h3 class="mg-sub">Stations</h3>
    ${checkRow('Plot stations', 'f.stations', s.f.stations)}
    <div class="mg-pin-grid${s.f.stations ? '' : ' is-off'}" role="group" aria-label="Station pin styles">
      <span class="mg-pin-head">Role</span><span class="mg-pin-head">On</span><span class="mg-pin-head">Shape</span>
      <span class="mg-pin-head">Size mm</span><span class="mg-pin-head">Filled</span>
      ${['field', 'repeater', 'base'].map(r => `
      <span>${roleLabel[r]}</span>
      <input type="checkbox" ${s.roles[r] ? 'checked' : ''} aria-label="Include ${roleLabel[r].toLowerCase()} stations"
             onchange="MapGen.setRole('${r}', this.checked)">
      <select aria-label="${roleLabel[r]} pin shape" onchange="MapGen.setPin('${r}', 'shape', this.value)">
        ${shapes.map(sh => `<option value="${sh}" ${s.pins[r].shape === sh ? 'selected' : ''}>${sh}</option>`).join('')}
      </select>
      <input type="number" min="0.5" max="20" step="0.1" class="mg-num-sm" value="${s.pins[r].sizeMm}"
             aria-label="${roleLabel[r]} pin size in millimetres" onchange="MapGen.setPin('${r}', 'sizeMm', this.value)">
      <input type="checkbox" ${s.pins[r].filled ? 'checked' : ''} aria-label="${roleLabel[r]} pin filled"
             onchange="MapGen.setPin('${r}', 'filled', this.checked)">`).join('')}
    </div>
    ${checkRow('Station names', 'f.labels', s.f.labels, `
    <label class="mg-inline">Name size mm
      <input type="number" min="1" max="8" step="0.1" class="mg-num-sm" value="${s.label.sizeMm}"
             onchange="MapGen.set('label.sizeMm', this.value, 'num')"></label>`)}

    <h3 class="mg-sub">Graticule</h3>
    ${checkRow('Latitude / longitude lines', 'f.graticule', s.f.graticule)}
    ${checkRow('Number them (decimal degrees)', 'f.gratLabels', s.f.gratLabels, `
    <label class="mg-inline">Spacing
      <select onchange="MapGen.set('grat.spacing', this.value, 'raw-panel')">
        ${[['auto', 'Auto'], ['1', '1°'], ['0.5', '0.5°'], ['0.25', '0.25°'], ['0.1', '0.1°'], ['0.05', '0.05°']].map(([v, l]) =>
          `<option value="${v}" ${String(s.grat.spacing) === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>`)}

    <h3 class="mg-sub">Title block</h3>
    ${checkRow('Title block (name, scale, legend, scale bar)', 'f.title', s.f.title)}
    <div class="control-row${s.f.title ? '' : ' is-off'}">
      <label class="mg-wide">Map title
        <input type="text" maxlength="80" value="${esc(s.title.text)}" onchange="MapGen.set('title.text', this.value, 'str')"></label>
    </div>`;
}

function exportPanelHtml() {
  const s = mg.s;
  const g = mg.gen;
  const layered = s.mode === 'layers';
  let files = '';
  if (layered) {
    const n = layerCount();
    if (!n) {
      files = `<p class="mg-hint">Layer files appear here once terrain has been fetched and contours traced.</p>`;
    } else {
      const { levels, interval } = g.art.contours;
      const sel = mg.layerSel || (mg.layerSel = Object.fromEntries(Array.from({ length: n }, (_, i) => [i, true])));
      const vertScale = Math.round(interval * 1000 / Math.max(0.1, s.contour.thick));
      const exag = (s.scale / vertScale);
      files = `
      <p class="mg-file-count"><strong>${n} file${n === 1 ? '' : 's'}</strong> — one per elevation level, plus the base plate.
        At ${esc(String(s.contour.thick))} mm material per ${interval} m step the stack's vertical scale is
        1:${vertScale.toLocaleString('en-AU').replace(/,/g, ' ')} (×${exag.toFixed(1)} vertical exaggeration at 1:${Math.round(s.scale).toLocaleString('en-AU').replace(/,/g, ' ')}).</p>
      <div class="control-row">
        <label>Material thickness mm
          <input type="number" min="0.5" max="50" step="0.5" class="mg-num-sm" value="${s.contour.thick}"
                 onchange="MapGen.set('contour.thick', this.value, 'num-panel')"></label>
        <label>Preview
          <select id="mg-preview-pick" onchange="MapGen.previewPick(this.value)">
            <option value="flat" ${mg.previewPick === 'flat' ? 'selected' : ''}>Whole map (flat)</option>
            ${Array.from({ length: n }, (_, i) =>
              `<option value="${i}" ${String(mg.previewPick) === String(i) ? 'selected' : ''}>Layer ${String(i).padStart(2, '0')} — ${i === 0 ? 'base plate' : 'cut ' + levels[i - 1] + ' m'}</option>`).join('')}
          </select></label>
      </div>
      <ul class="mg-file-list">
        ${Array.from({ length: n }, (_, i) => `
        <li><label><input type="checkbox" ${sel[i] ? 'checked' : ''} onchange="MapGen.layerToggle(${i}, this.checked)">
          <span class="mg-file-name">${esc(layerFileName(i))}</span>
          <span class="mg-file-meta">${i === 0 ? 'base plate' : 'cut ' + levels[i - 1] + ' m'}${i < levels.length ? ' · engrave ' + levels[i] + ' m' : ' · top'}</span></label>
          <button class="mg-btn-sm" onclick="MapGen.downloadLayer(${i})" aria-label="Download ${esc(layerFileName(i))}">⬇</button></li>`).join('')}
      </ul>
      <div class="button-row mg-row">
        <button onclick="MapGen.layersAll(true)">Select all</button>
        <button onclick="MapGen.layersAll(false)">Select none</button>
        <button class="primary" onclick="MapGen.downloadLayers()">Download selected</button>
      </div>`;
    }
  }
  return `
    <div class="panel-header"><h2>Export</h2></div>
    ${layered ? files : `
    <div class="button-row mg-row">
      <button class="primary" onclick="MapGen.downloadSvg()">Download SVG</button>
      <button onclick="MapGen.downloadPng()">Download PNG (300 dpi)</button>
      <button onclick="MapGen.printMap()" title="Opens a print window at true size — print to paper or save as PDF">Print / PDF…</button>
    </div>
    <p class="mg-hint">${s.mode === 'print'
      ? 'The SVG and the print window are millimetre-true: print at 100% scale (no fit-to-page) and the scale bar is honest.'
      : 'Single-plate laser file: red border is the cut that frees the plate; everything else engraves. Load the SVG straight into K40 Whisperer.'}</p>`}`;
}

function render() {
  // renderMain() calls render() before init(), so the settings load here.
  if (!mg.s) mg.s = loadSettings();
  return `
  <div class="layout mg-layout">
    <aside class="sidebar stack" aria-label="Map generator controls">
      <div class="panel">
        <div class="panel-header"><h2>Output area</h2></div>
        <div id="mg-minimap" class="mg-minimap" aria-label="Output area picker map"></div>
        <div id="mg-panel-view">${viewFieldsHtml()}</div>
      </div>
      <div class="panel" id="mg-panel-page">${pagePanelHtml()}</div>
      <div class="panel" id="mg-panel-mode">${modePanelHtml()}</div>
      <div class="panel" id="mg-panel-features">${featuresPanelHtml()}</div>
    </aside>
    <div class="stack">
      <div class="panel">
        <div class="panel-header">
          <h2>Preview</h2>
          <div class="button-group">
            <label class="mg-check"><input type="checkbox" ${mg.s.autoRefresh ? 'checked' : ''}
                   onchange="MapGen.setAuto(this.checked)">Auto refresh</label>
            <button class="primary" onclick="MapGen.generate()">Generate</button>
          </div>
        </div>
        <p class="mg-status" id="mg-status" role="status">Generating…</p>
        <ul class="mg-notes" id="mg-notes" hidden></ul>
        <div class="mg-preview" id="mg-preview" aria-label="Generated map preview"></div>
      </div>
      <div class="panel" id="mg-panel-export">${exportPanelHtml()}</div>
    </div>
  </div>`;
}

function refreshPanel(name, focusId) {
  const el = document.getElementById('mg-panel-' + name);
  if (!el) return;
  el.innerHTML = { view: viewFieldsHtml, page: pagePanelHtml, mode: modePanelHtml,
                   features: featuresPanelHtml, export: exportPanelHtml }[name]();
  if (focusId) {
    const f = document.getElementById(focusId);
    if (f) f.focus();
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function stop() {
  clearTimeout(mg.timer);
  mg.seq++;
  mg.rect = null;
  mg.map = removeMap(mg.map);
}

function init() {
  registerTabTeardown('MapGen', stop);
  if (!mg.s) mg.s = loadSettings();
  // First visit with a file loaded: frame the whole network. render() has
  // already painted the default centre into the inputs by now, so the two
  // panels that show the view re-render with the fitted one.
  if (!mg.s.fitDone && state.data && fitAllStations()) {
    refreshPanel('view');
    refreshPanel('page');
  }
  buildMiniMap();
  scheduleGen();
  if (!mg.s.autoRefresh) generate().catch(() => {});
}

function fitAllStations() {
  if (!state.data) return false;
  const located = state.data.stations.filter(st => st.lat != null && st.lon != null);
  if (!located.length) return false;
  let s = 90, n = -90, w = 180, e = -180;
  for (const st of located) {
    if (st.lat < s) s = st.lat; if (st.lat > n) n = st.lat;
    if (st.lon < w) w = st.lon; if (st.lon > e) e = st.lon;
  }
  mg.s.lat = (s + n) / 2;
  mg.s.lon = (w + e) / 2;
  const fr0 = frame();
  const needW = (mercX(e) - mercX(w)) * 1.06, needH = (mercY(n) - mercY(s)) * 1.06;
  const mercPerMm = Math.max(needW / fr0.cw, needH / fr0.ch);
  const scale = mercPerMm * 1000 * Math.cos(mg.s.lat * Math.PI / 180);
  // One located station (or a single co-located cluster) has no extent, and
  // the magnitude rounding below would turn a zero scale into NaN — frame a
  // site-sized sheet instead.
  if (!(scale > 0)) mg.s.scale = 25000;
  else {
    const mag = Math.pow(10, Math.floor(Math.log10(scale)) - 1);
    mg.s.scale = Math.max(1000, Math.round(scale / mag) * mag);
  }
  mg.s.fitDone = true;
  save();
  return true;
}

// ── Downloads / print ────────────────────────────────────────────────────────

// dlText (core.js) hard-codes text/csv; an SVG needs its own MIME or some
// viewers refuse it, so this is that helper with the type as a parameter.
function dlBlob(name, content, type) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([content], { type })),
    download: name,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

function flatFileName(ext) {
  return `meganet-map-${localDateStr()}-1to${Math.round(mg.s.scale)}.${ext}`;
}

// ── Public surface ───────────────────────────────────────────────────────────
// Everything an inline on*= in render() names, plus adoptStationsView (called
// from the Stations tab) and geom (the pure geometry, exported for the test
// harness to exercise without a browser).

return {
  render, init, stop,

  // The generic setter every simple control routes through. `kind` says how
  // to coerce and which panel (if any) has to re-render for dependent
  // controls — '-panel' suffixed kinds re-render their own panel.
  set(path, value, kind) {
    const keys = path.split('.');
    let obj = mg.s;
    for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
    const leaf = keys[keys.length - 1];
    switch (kind) {
      case 'bool':       obj[leaf] = !!value; break;
      case 'bool-panel': obj[leaf] = !!value; break;
      case 'num':
      case 'num-panel':  obj[leaf] = num(value, -1e9, 1e9, obj[leaf]); break;
      case 'lat':        obj[leaf] = num(value, -85, 85, obj[leaf]); break;
      case 'lon':        obj[leaf] = num(value, -180, 180, obj[leaf]); break;
      case 'scale':      obj[leaf] = num(value, 1000, 5e7, obj[leaf]); break;
      case 'dim':        obj[leaf] = num(value, 40, 2000, obj[leaf]); break;
      case 'margin':     obj[leaf] = num(value, 0, 80, obj[leaf]); break;
      case 'str':        obj[leaf] = String(value).slice(0, 120); break;
      default:           obj[leaf] = value; break;
    }
    const panel = kind === 'bool-panel' || kind === 'num-panel' || kind === 'raw-panel' ? 'features' : null;
    afterChange({ panel: path.startsWith('contour.thick') ? 'export' : panel });
    if (path === 'f.contours' || path === 'f.stations' || path === 'f.labels' || path === 'f.title' || path === 'f.gratLabels') {
      refreshPanel('features');
    }
    if (path.startsWith('wMm') || path.startsWith('hMm') || path.startsWith('marginMm') || path === 'scale') {
      refreshPanel('page');
    }
  },

  setPreset(v) {
    if (!MG_PRESETS[v]) return;
    mg.s.preset = v;
    if (v !== 'custom') {
      mg.s.wMm = MG_PRESETS[v].w;
      mg.s.hMm = MG_PRESETS[v].h;
      mg.s.marginMm = MG_PRESETS[v].margin;
    }
    afterChange({ panel: 'page' });
  },

  setMode(v) {
    if (!mg.s.colors[v]) return;
    mg.s.mode = v;
    save();
    refreshPanel('mode');
    refreshPanel('export');
    scheduleGen();
  },

  setBase(v) {
    if (!(v in MG_BASES)) return;
    mg.s.base[mg.s.mode] = v;
    afterChange({});
  },

  setColor(key, v) {
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
    palette()[key] = v.toLowerCase();
    afterChange({});
  },

  resetColors() {
    mg.s.colors[mg.s.mode] = { ...MG_PALETTES[mg.s.mode] };
    save();
    refreshPanel('mode');
    scheduleGen();
    announce('Colours reset to the ' + (mg.s.mode === 'print' ? 'print' : 'laser') + ' defaults.');
  },

  setPin(role, key, v) {
    const p = mg.s.pins[role];
    if (!p) return;
    if (key === 'sizeMm') p.sizeMm = num(v, 0.5, 20, p.sizeMm);
    else if (key === 'filled') p.filled = !!v;
    else if (key === 'shape' && ['circle', 'square', 'diamond', 'triangle', 'cross', 'x'].includes(v)) p.shape = v;
    afterChange({});
  },

  setRole(role, on) {
    if (!(role in mg.s.roles)) return;
    mg.s.roles[role] = !!on;
    afterChange({});
  },

  setAuto(on) {
    mg.s.autoRefresh = !!on;
    save();
    if (on) scheduleGen();
  },

  nudge(dx, dy) {
    const fr = frame();
    const cx = mercX(mg.s.lon) + dx * (fr.merc.east - fr.merc.west);
    const cy = mercY(mg.s.lat) + dy * (fr.merc.north - fr.merc.south);
    mg.s.lon = invMercX(cx);
    mg.s.lat = invMercY(cy);
    afterChange({ panel: 'view' });
    if (mg.map && mg.rect) mg.map.fitBounds(mg.rect.getBounds().pad(0.15));
  },

  centreHere() {
    if (!mg.map) return;
    const c = mg.map.getCenter();
    mg.s.lat = Math.round(c.lat * 1e4) / 1e4;
    mg.s.lon = Math.round(c.lng * 1e4) / 1e4;
    afterChange({ panel: 'view' });
  },

  showOutput() {
    if (mg.map && mg.rect) mg.map.fitBounds(mg.rect.getBounds().pad(0.15));
  },

  useStationsFit() {
    if (!fitAllStations()) { announce('No stations with coordinates are loaded.'); return; }
    refreshPanel('view');
    refreshPanel('page');
    syncRect();
    if (mg.map && mg.rect) mg.map.fitBounds(mg.rect.getBounds().pad(0.15));
    scheduleGen();
  },

  // The Stations tab's button: carry that map's centre and zoom over here as
  // centre + a rounded 1:n scale, then switch. Zoom → scale is the standard
  // Web Mercator figure at 96 dpi, the same one MapContours' viewScale uses.
  adoptStationsView() {
    if (!state.map) { announce('Open the Stations tab map first.'); return; }
    if (!mg.s) mg.s = loadSettings();
    const c = state.map.getCenter(), z = state.map.getZoom();
    mg.s.lat = Math.round(c.lat * 1e4) / 1e4;
    mg.s.lon = Math.round(c.lng * 1e4) / 1e4;
    const raw = 559082264.028 / Math.pow(2, z) * Math.cos(c.lat * Math.PI / 180);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
    mg.s.scale = Math.max(1000, Math.round(raw / mag) * mag);
    mg.s.fitDone = true;
    save();
    switchTab('mapgen');
    announce('Stations map view sent to the Map Generator.');
  },

  generate() {
    return generate().catch(() => { setStatus('Generation failed — see the notes.'); });
  },

  previewPick(v) {
    mg.previewPick = v === 'flat' ? 'flat' : String(Math.max(0, Math.min(layerCount() - 1, +v || 0)));
    renderPreview();
  },

  downloadSvg() {
    if (!mg.gen) { announce('Nothing generated yet.'); return; }
    dlBlob(flatFileName('svg'), flatSvg(mg.gen.art, true), 'image/svg+xml');
    announce('SVG downloaded.');
  },

  downloadPng() {
    if (!mg.gen) { announce('Nothing generated yet.'); return; }
    const fr = mg.gen.art.fr;
    const scale = 300 / 25.4;   // 300 dpi in px per mm
    const svg = flatSvg(mg.gen.art, false);
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = Math.round(fr.w * scale);
        cv.height = Math.round(fr.h * scale);
        const cx = cv.getContext('2d');
        cx.fillStyle = '#ffffff';
        cx.fillRect(0, 0, cv.width, cv.height);
        cx.drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(b => {
          if (!b) { announce('PNG export failed — the SVG download still works.'); return; }
          const a = Object.assign(document.createElement('a'), {
            href: URL.createObjectURL(b), download: flatFileName('png') });
          a.click();
          URL.revokeObjectURL(a.href);
        }, 'image/png');
      } catch (_) { announce('PNG export failed — the SVG download still works.'); }
    };
    img.onerror = () => announce('PNG export failed — the SVG download still works.');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  },

  printMap() {
    if (!mg.gen) { announce('Nothing generated yet.'); return; }
    const fr = mg.gen.art.fr;
    const win = window.open('', '_blank');
    if (!win) { announce('The print window was blocked — allow pop-ups for this page.'); return; }
    win.document.write(
      `<!doctype html><html><head><title>${esc(mg.s.title.text)}</title>` +
      `<style>@page{size:${fr.w}mm ${fr.h}mm;margin:0}html,body{margin:0;padding:0}` +
      `svg{display:block;width:${fr.w}mm;height:${fr.h}mm}</style></head><body>` +
      flatSvg(mg.gen.art, false) +
      `<script>window.onload=function(){window.print();}<\/script></body></html>`);
    win.document.close();
  },

  layerToggle(i, on) {
    if (mg.layerSel) mg.layerSel[i] = !!on;
  },

  layersAll(on) {
    if (!mg.layerSel) return;
    for (const k of Object.keys(mg.layerSel)) mg.layerSel[k] = !!on;
    refreshPanel('export');
  },

  downloadLayer(i) {
    if (!mg.gen || !mg.gen.art.contours) return;
    dlBlob(layerFileName(i), layerFileSvg(i), 'image/svg+xml');
  },

  downloadLayers() {
    if (!mg.gen || !mg.gen.art.contours) { announce('Nothing generated yet.'); return; }
    const sel = mg.layerSel || {};
    const picked = Array.from({ length: layerCount() }, (_, i) => i).filter(i => sel[i]);
    if (!picked.length) { announce('No layer files are selected.'); return; }
    // Staggered like runExport's five CSVs, so the browser keeps them as
    // separate downloads instead of folding them into one prompt.
    picked.forEach((i, idx) => setTimeout(() => dlBlob(layerFileName(i), layerFileSvg(i), 'image/svg+xml'), idx * 250));
    announce(`Downloading ${picked.length} layer file(s).`);
  },

  // Pure geometry, exported for the Node-side test harness — nothing in the
  // app calls these through the namespace.
  geom: { isolines, simplify, chaikin, clipPolyline, splitByBand, strokeText, mercX, mercY, invMercX, invMercY },
};

})();

if (typeof window !== 'undefined') window.MapGen = MapGen;
