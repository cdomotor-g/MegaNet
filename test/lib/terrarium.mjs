// A terrarium-encoded PNG tile, built here so a check can stand its path on
// ground it chose.
//
// map3d.mjs and pathcover.mjs each grew their own copy of this before there was
// a third caller. This is that third caller's answer: the same arithmetic, in
// one place, for anything new. The two existing copies are left alone
// deliberately — they are load-bearing for checks that pass, and moving them is
// a change to those checks rather than to this one.
//
// The encoding is terrain.js's, and it has to stay that way or the ground the
// test draws is not the ground the app reads:
//
//   elevation_m = (R * 256 + G + B / 256) - 32768
import zlib from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A 256×256 tile, every pixel at `metres`. */
export function flatTerrariumPng(metres) {
  const v = metres + 32768;
  const r = Math.floor(v / 256), g = Math.floor(v % 256), b = Math.round((v % 1) * 256);
  const W = 256, H = 256;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;                                  // filter: none
    for (let x = 0; x < W; x++) {
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── A hilly world ────────────────────────────────────────────────────────────
// terrainkit.mjs's closed-form landscape, for a check that needs relief rather
// than a flat tile: hills every eight kilometres, their heights modulated by
// two slower terms so no two summits tie. Height is a function of the *world*
// position of a pixel, not of its position on one zoom's grid, so a check that
// fetches z10 for one feature and z12 for another is measuring one world.
// terrainkit.mjs keeps its own copy (see the note at the top of this file);
// this is the same formula, and sites.mjs is the caller that needed it here.
const EARTH_KM = 40075.017;
const HILL_KM  = 8;

/** Ground height at world position (wx, wy), each 0..1 across Web Mercator. */
export function hillyHeightAtWorld(wx, wy) {
  const K = 2 * Math.PI * EARTH_KM / HILL_KM;
  const a = Math.sin(wx * K) * Math.sin(wy * K);
  const b = Math.sin(wx * K / 9.7 + 0.6) * Math.cos(wy * K / 11.3 + 1.1);
  const c = Math.sin(wx * K / 41 + 2.2);
  return Math.round(180 + 380 * a * a + 220 * b + 90 * c);
}

/** The same world at a latitude and longitude. */
export function hillyHeightAt(lat, lon) {
  const r = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  const wx = (lon + 180) / 360;
  const wy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
  return hillyHeightAtWorld(wx, wy);
}

const hillyCache = new Map();

/** Tile z/x/y of the hilly world, as a terrarium PNG. */
export function hillyTerrariumPng(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (hillyCache.has(key)) return hillyCache.get(key);
  const W = 256, H = 256, side = 256 * Math.pow(2, z);
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let py = 0; py < H; py++) {
    raw[py * (W * 3 + 1)] = 0;
    for (let px = 0; px < W; px++) {
      const v = hillyHeightAtWorld((x * 256 + px) / side, (y * 256 + py) / side) + 32768;
      const o = py * (W * 3 + 1) + 1 + px * 3;
      raw[o] = Math.floor(v / 256) & 0xff;
      raw[o + 1] = Math.floor(v) % 256;
      raw[o + 2] = 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  hillyCache.set(key, png);
  return png;
}
