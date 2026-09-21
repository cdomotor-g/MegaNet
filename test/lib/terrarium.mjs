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
