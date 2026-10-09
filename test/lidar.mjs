// lidar-profile.js, held to what its header says, in a bare Node VM.
//
//   The GeoTIFF   the one layout the service answers with — uncompressed,
//                 one band, float32, in strips or in tiles — read back, with
//                 0.0 and an unwritten tile as "no survey here", and anything
//                 compressed refused rather than guessed at.
//   The tiles     fixed 0.01° tiles keyed by their corner, sized to the grid's
//                 5 m, and nothing asked for outside the grid's extent.
//   Where         the zones are the two ends and the obstacles — ground near
//                 the line of sight, the strongest first, a window either
//                 side — and nothing where the ground is well clear.
//   The splice    LiDAR inside the zones, the tiles outside, a ramp where the
//                 two meet, the path's own ends never ramped; a tile the grid
//                 holds nothing in keeps its 30 m heights and is counted.
//   A mast        stood on the highest ground within its position's rounding,
//                 and the rounding read off how the position was written.
//   Failure       a host that does not answer trips the breaker, and every
//                 call still resolves.
//
// No network: the tiles are answered by LidarProfile.seed(), the test seam.
//
// Run:  npm run lidar
//       npm run lidar -- -v    also print what passed

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { REPO_ROOT } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const src = fs.readFileSync(path.join(REPO_ROOT, 'lidar-profile.js'), 'utf8');
const ctx = { console, Promise, Math, Date, JSON, Number, String, Array, Object, Map, Set, isFinite, isNaN,
              Float32Array, Float64Array, Uint8Array, Int8Array, DataView, ArrayBuffer, setTimeout, clearTimeout };
vm.createContext(ctx);
const LP = vm.runInContext(`${src}\n;LidarProfile`, ctx, { filename: 'lidar-profile.js' });

// ── a GeoTIFF, built by hand ────────────────────────────────────────────────
// entries: [tag, type, values]; data blocks are appended after the IFD.
function tiff(W, H, entries0, blocks) {
  const SIZE = { 2: 1, 3: 2, 4: 4, 11: 4 };
  // The block offsets and lengths are named, not given: their count is the
  // blocks', and whether they fit in the entry turns on that count.
  const entries = entries0.map(([tag, type, vals]) => [tag, type,
    vals === 'BLOCKS' || vals === 'LENGTHS' ? { name: vals, count: blocks.length } : vals]);
  const countOf = vals => (vals && vals.name ? vals.count : Array.isArray(vals) ? vals.length : String(vals).length + 1);
  const n = entries.length;
  const ifd = 8, ifdLen = 2 + n * 12 + 4;
  let extra = ifd + ifdLen;
  const ext = [];
  const blockAt = [];
  let data = extra;
  // lay out out-of-line values first, then the blocks
  const outOfLine = entries.map(([, type, vals]) => SIZE[type] * countOf(vals) > 4);
  entries.forEach(([, type, vals], i) => {
    if (!outOfLine[i]) return;
    const len = SIZE[type] * countOf(vals);
    ext[i] = data; data += len + (len % 2);
  });
  for (const b of blocks) { blockAt.push(b ? data : 0); if (b) data += b.length * 4; }
  const buf = new ArrayBuffer(data);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, ifd, true);
  dv.setUint16(ifd, n, true);
  entries.forEach(([tag, type, vals], i) => {
    const at = ifd + 2 + i * 12;
    let v = vals;
    if (v && v.name === 'BLOCKS') v = blockAt;
    if (v && v.name === 'LENGTHS') v = blocks.map(b => (b ? b.length * 4 : 0));
    const arr = Array.isArray(v) ? v : null;
    dv.setUint16(at, tag, true); dv.setUint16(at + 2, type, true);
    dv.setUint32(at + 4, arr ? arr.length : String(v).length + 1, true);
    const base = outOfLine[i] ? ext[i] : at + 8;
    if (outOfLine[i]) dv.setUint32(at + 8, ext[i], true);
    if (type === 2) { const s = String(v); for (let k = 0; k < s.length; k++) dv.setUint8(base + k, s.charCodeAt(k)); return; }
    arr.forEach((x, k) => (type === 3 ? dv.setUint16(base + 2 * k, x, true) : dv.setUint32(base + 4 * k, x, true)));
  });
  blocks.forEach((b, k) => { if (b) b.forEach((x, j) => dv.setFloat32(blockAt[k] + 4 * j, x, true)); });
  return buf;
}

console.log('The GeoTIFF');
{
  const W = 4, H = 3;
  const vals = [10, 11, 12, 13, 20, 0, 22, 23, 30, 31, 32, 33];
  const stripped = tiff(W, H, [[256, 3, [W]], [257, 3, [H]], [258, 3, [32]], [259, 3, [1]], [273, 4, 'BLOCKS'],
    [277, 3, [1]], [278, 3, [H]], [279, 4, 'LENGTHS'], [339, 3, [3]]], [vals]);
  const g = LP.readTiff(stripped);
  ok('a stripped float32 grid reads back cell for cell', g && g.W === 4 && g.H === 3 && g.data[0] === 10 && g.data[11] === 33,
     g ? Array.from(g.data).join(',') : 'null');
  ok('…and 0.0 is "no survey here", not sea level', g && Number.isNaN(g.data[5]));

  // Tiled: 2×2 tiles of 2×2 cells over a 4×3 grid, the bottom-right tile never written.
  const t = [[1, 2, 5, 6], [3, 4, 7, 8], [9, 10, 0, 0], null];
  const tiled = tiff(4, 3, [[256, 3, [4]], [257, 3, [3]], [258, 3, [32]], [259, 3, [1]], [277, 3, [1]],
    [322, 3, [2]], [323, 3, [2]], [324, 4, 'BLOCKS'], [325, 4, 'LENGTHS'], [339, 3, [3]]], t);
  const h = LP.readTiff(tiled);
  ok('a tiled grid lands each tile in place', h && h.data[0] === 1 && h.data[1] === 2 && h.data[4] === 5 && h.data[2] === 3 && h.data[8] === 9,
     h ? Array.from(h.data).join(',') : 'null');
  ok('…and an unwritten tile is no data', h && Number.isNaN(h.data[10]) && Number.isNaN(h.data[11]));

  const packed = tiff(W, H, [[256, 3, [W]], [257, 3, [H]], [258, 3, [32]], [259, 3, [5]], [273, 4, 'BLOCKS'],
    [277, 3, [1]], [278, 3, [H]], [279, 4, 'LENGTHS'], [339, 3, [3]]], [vals]);
  ok('a compressed answer is refused, not guessed at', LP.readTiff(packed) === null);
  ok('…and so is something that is not a TIFF', LP.readTiff(new ArrayBuffer(16)) === null);
}

console.log('\nThe tiles');
{
  const t = LP.tileOf(-27.4632, 153.0281);
  ok('keyed by the corner of its 0.01° cell', t.key === '15302/-2747' && near(t.w, 153.02, 1e-9) && near(t.n, -27.46, 1e-9), JSON.stringify(t));
  ok('sized to the grid\'s 5 m: ~197 × 221 cells at 27° S', near(t.W, 197, 1) && near(t.H, 221, 1), `${t.W} × ${t.H}`);
  const t2 = LP.tileOf(-27.4699, 153.0201);
  ok('two points in one cell share a tile', t2.key === t.key);
}

// A 10 km path along a parallel near Brisbane, a sample every 5 m: ground at
// 200 m under each end, 100 m between, and a ridge at 6 km that comes up to
// 205 m — well inside 30 m of the line from 210 m to 210 m.
function path10k(ridge = true) {
  const n = 2001, lat = -27.5, lon0 = 152.9, mPerDeg = 111320 * Math.cos(lat * Math.PI / 180);
  const distance_m = [], terrain_m = [], la = [], lo = [];
  for (let i = 0; i < n; i++) {
    const d = i * 5;
    distance_m.push(d); la.push(lat); lo.push(lon0 + d / mPerDeg);
    let h = 100;
    if (d < 400) h = 200 - d / 4; else if (d > 9600) h = 200 - (10000 - d) / 4;
    if (ridge) h = Math.max(h, 205 - Math.abs(d - 6000) / 3);
    terrain_m.push(h);
  }
  return { ok: true, distance_m, terrain_m, lat: la, lon: lo };
}
const ENDS = { elevA: 200, elevB: 200, aglA: 10, aglB: 10, freqMhz: 152.4 };

console.log('\nWhere');
{
  const z = LP.zonesOf(path10k(), ENDS);
  const kinds = z.map(x => x.kind).join(',');
  ok('the two ends and the ridge, in path order', kinds === 'end,obstacle,end', JSON.stringify(z));
  ok('…each end LiDAR for 500 m', z[0].from === 0 && z[0].to === 500 && z[2].from === 9500 && z[2].to === 10000);
  const o = z[1];
  ok('…the ridge whole, with a window either side', o.from < 5850 && o.to > 6150 && o.to - o.from < 2000, `${o.from}–${o.to}`);
  const flat = LP.zonesOf(path10k(false), ENDS);
  ok('a path whose ground is well clear has its ends and nothing else', flat.length === 2 && flat.every(x => x.kind === 'end'), JSON.stringify(flat));
  const short = LP.zonesOf({ ...path10k(), distance_m: path10k().distance_m.map(d => d / 20) }, ENDS);
  ok('a path shorter than its two end zones is one zone, end to end', short.length === 1 && short[0].from === 0, JSON.stringify(short));
}

console.log('\nThe splice');
{
  const LIDAR = 50;
  LP.seed(t => ({ W: t.W, H: t.H, data: new Float32Array(t.W * t.H).fill(LIDAR) }));
  const base = path10k();
  const r = await LP.refine(base, ENDS);
  const g = r.prof.terrain_m, L = r.prof.lidar;
  ok('resolves with a refined profile and its report', r.ok && r.prof !== base && r.prof.ground === 'lidar' && r.report.zones.length === 3);
  ok('every sample asked for came back', near(r.report.covered, 1, 1e-9), String(r.report.covered));
  ok('the ends are the LiDAR\'s, unramped', g[0] === LIDAR && g[g.length - 1] === LIDAR && L[0] === 1);
  ok('the ridge is the LiDAR\'s', g[1200] === LIDAR && L[1200] === 1, `${g[1200]}`);
  ok('the ground well clear of the line keeps its tiles', g[600] === 100 && L[600] === 0 && g[1700] === 100);
  const inner = r.report.zones[1].from / 5;   // first sample of the obstacle zone
  ok('…and the two meet on a ramp, not a step', g[inner] > LIDAR && g[inner] < 100 && g[inner + 1] < g[inner], `${g[inner - 1]} → ${g[inner]} → ${g[inner + 1]} → ${g[inner + 6]}`);
  ok('…which is LiDAR within the blend width', g[inner + 6] === LIDAR);
  ok('the share of the profile is the zones\' share', near(r.report.lidarShare, (101 + 101 + (r.report.zones[1].to - r.report.zones[1].from) / 5 + 1) / 2001, 0.002),
     r.report.lidarShare.toFixed(3));

  // A tile the grid holds nothing in: the stretch keeps its 30 m heights.
  LP.seed(t => (t.w > 152.95 ? null : { W: t.W, H: t.H, data: new Float32Array(t.W * t.H).fill(LIDAR) }));
  const p = await LP.refine(path10k(), ENDS);
  ok('a tile with no survey keeps the tiles\' heights there, and the report says how much came back',
     p.prof.terrain_m[p.prof.terrain_m.length - 1] === 200 && p.report.covered < 1 && p.report.covered > 0, String(p.report.covered));
  LP.seed(() => null);
  const none = await LP.refine(path10k(), ENDS);
  ok('no survey anywhere hands back the profile it was given', none.ok && none.prof === none.prof && none.report.covered === 0 && !none.prof.lidar);
}

console.log('\nA mast');
{
  // A summit 14 m higher, 40 m north-east of a registered position.
  const lat0 = -19.344, lon0 = 146.781;
  const mLat = 110574, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  const pk = { lat: lat0 + 28 / mLat, lon: lon0 + 28 / mLon };
  LP.seed(t => {
    const data = new Float32Array(t.W * t.H);
    for (let y = 0; y < t.H; y++) for (let x = 0; x < t.W; x++) {
      const la = t.n - (y + 0.5) * (t.n - t.s) / t.H, lo = t.w + (x + 0.5) * (t.e - t.w) / t.W;
      const d = Math.hypot((la - pk.lat) * mLat, (lo - pk.lon) * mLon);
      data[y * t.W + x] = 572 + Math.max(0, 14 - d / 5);
    }
    return { W: t.W, H: t.H, data };
  });
  const top = await LP.highest(lat0, lon0, LP.roundingOf(lat0, lon0));
  ok('stood on the highest ground within its rounding', top && near(top.ground, 586, 1.5) && near(top.moved_m, 40, 6), JSON.stringify(top));
  ok('…saying what the ground was where it was registered', top && near(top.from_m, 578, 1.5), String(top && top.from_m));
  const tight = await LP.highest(lat0, lon0, 15);
  ok('a tighter rounding keeps it nearer home', tight && tight.moved_m <= 15 + 5 && tight.ground < top.ground, JSON.stringify(tight));
  ok('three decimals is ±56 m', near(LP.roundingOf(-19.344, 146.781), 55.7, 0.2), String(LP.roundingOf(-19.344, 146.781)));
  ok('four decimals is held to the 15 m least', LP.roundingOf(-19.2586, 146.8031) === 15);
  ok('two decimals is held to the 100 m most', LP.roundingOf(-19.34, 146.78) === 100);
}

console.log('\nFailure');
{
  LP.seed(null);
  LP.clear();
  const outside = await LP.refine({ ...path10k(), lat: path10k().lat.map(() => 10), lon: path10k().lon.map(() => 10) }, ENDS);
  ok('outside the grid\'s extent nothing is asked for', outside.ok && outside.report.fetched === 0 && outside.report.failed === 0 && outside.report.covered === 0);
  // No fetch in this VM: every tile is a failure, and the breaker trips.
  const r = await LP.refine(path10k(), ENDS);
  ok('a host that does not answer is counted, and the call still resolves', r.ok && r.report.failed > 0 && r.prof.terrain_m[0] === 200, JSON.stringify(r.report));
  ok('…and three in a row trips the breaker', LP.stats().tripped === true, JSON.stringify(LP.stats()));
  const again = await LP.refine(path10k(), ENDS);
  ok('…after which nothing is asked of it until it resets', again.ok && again.report.fetched === 0);
}

console.log(failures
  ? `\nFAIL — ${failures} of ${passes + failures} assertions about lidar-profile.js.`
  : `\nPASS — ${passes} assertions: the GeoTIFF, the tiles, where LiDAR goes, the splice, a mast's top, and failing loudly.`);
process.exit(failures ? 1 : 0);
