// map-height.js and lidar-profile.js's one-point read, in a bare Node VM.
//
//   One point     LidarProfile.peek says null before a spot's tile is fetched,
//                 its height once it is, NaN where the grid holds nothing or
//                 the spot is outside the grid; point() resolves to the height,
//                 to "none" or to "failed", never rejecting.
//   The words     the readout's two lines: LiDAR to the centimetre in m AHD;
//                 the ~30 m tiles put into AHD, rounded, with ≈ and what the
//                 LiDAR is doing; above EGM96, not AHD, where the geoid has
//                 nothing; and a plain "No ground height" when neither answered.
//
// No network: the tiles are answered by LidarProfile.seed(), the test seam.
//
// Run:  npm run mapheight
//       npm run mapheight -- -v    also print what passed

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

const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
const ctx = { console, Promise, Math, Date, JSON, Number, String, Array, Object, Map, Set, isFinite, isNaN,
              Float32Array, Float64Array, Uint8Array, Int8Array, DataView, ArrayBuffer, setTimeout, clearTimeout,
              localStorage: { getItem: () => null, setItem() {} } };
vm.createContext(ctx);
const LP = vm.runInContext(`${read('lidar-profile.js')}\n;LidarProfile`, ctx, { filename: 'lidar-profile.js' });
const MH = vm.runInContext(`${read('map-height.js')}\n;MapHeight`, ctx, { filename: 'map-height.js' });

// ── one point ───────────────────────────────────────────────────────────────
const LAT = -26.6, LON = 151.6;
{
  LP.seed(t => ({ W: t.W, H: t.H, data: new Float32Array(t.W * t.H).fill(342.25) }));
  ok('peek: nothing fetched yet is null', LP.peek(LAT, LON) === null, String(LP.peek(LAT, LON)));
  const r = await LP.point(LAT, LON);
  ok('point: the grid\'s height, in m AHD', r.ok && Math.abs(r.h - 342.25) < 1e-6, JSON.stringify(r));
  ok('peek: once fetched, the height at once', Math.abs(LP.peek(LAT, LON) - 342.25) < 1e-6, String(LP.peek(LAT, LON)));
  ok('peek: outside the grid is NaN, never null (nothing to fetch)', Number.isNaN(LP.peek(-20, 170)));

  LP.seed(() => null);
  const n = await LP.point(LAT, LON);
  ok('point: no survey here is "none"', !n.ok && n.none, JSON.stringify(n));
  ok('peek: a tile the grid holds nothing in is NaN', Number.isNaN(LP.peek(LAT, LON)));

  LP.seed(t => { const d = new Float32Array(t.W * t.H).fill(NaN); return { W: t.W, H: t.H, data: d }; });
  const h = await LP.point(LAT, LON);
  ok('point: a tile of holes is "none", not a height', !h.ok && h.none, JSON.stringify(h));
  LP.seed(null);
}

// ── the words ───────────────────────────────────────────────────────────────
{
  const w = MH._words;
  const a = w({ lidar: 342.256 });
  ok('LiDAR: to the centimetre, in m AHD', a.head === '342.26 m AHD' && /5 m LiDAR/.test(a.sub), JSON.stringify(a));
  const b = w({ tile: { h: 343.6, sep: -0.34 }, why: 'pending' });
  ok('tiles: into AHD, rounded, with ≈', b.head === '≈ 343 m AHD', JSON.stringify(b));
  ok('…saying the LiDAR is on its way', /~30 m terrain/.test(b.sub) && /LiDAR loading/.test(b.sub), b.sub);
  ok('…or to zoom in for it', /zoom in/.test(w({ tile: { h: 1, sep: 0 }, why: 'zoom' }).sub));
  ok('…or that there is none here', /no LiDAR here/.test(w({ tile: { h: 1, sep: 0 }, why: 'none' }).sub));
  ok('…or that it did not answer', /did not answer/.test(w({ tile: { h: 1, sep: 0 }, why: 'failed' }).sub));
  const c = w({ tile: { h: 12.4, sep: null }, why: 'none' });
  ok('no geoid: above EGM96, and says it is not AHD', c.head === '≈ 12 m above EGM96' && /not AHD/.test(c.sub), JSON.stringify(c));
  const d = w({ tile: { none: true }, why: 'failed' });
  ok('neither: says so, not a zero', d.head === 'No ground height' && !/\b0 m\b/.test(d.head), JSON.stringify(d));
  ok('every word on the readout has its meaning', ['ahd', 'lidar', 'tiles'].every(k => (MH.words()[k] || '').length > 40));
  ok('off until asked for', MH.enabled() === false);
}

console.log(`mapheight: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
