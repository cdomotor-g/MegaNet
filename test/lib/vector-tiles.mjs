// Vector tiles and a PMTiles file, written out by hand for the checks of the
// trees and buildings (#278, #280) — just enough of each, so every building a
// view stands up is one the check put there.
//
//   mvtTile(layer, features, extent = 4096)
//       A Mapbox Vector Tile (the protobuf the State's building tiles and
//       Overture's are both in): one layer, its features
//       [{ rings: [[[x, y], …], …], props, type = 3 }], each ring written
//       MoveTo / LineTo / ClosePath in tile units. A property value is
//       written as a double (a number), a string, a bool, or — to say how an
//       integer goes — { sint }, { int64 } or { uint }.
//   square(x0, y0, size, props)
//       One square building, wound as the spec winds an outer ring.
//   pmtilesFile(tiles, zxyToTileId)
//       PMTiles version 3, laid out as Overture's is — header, root
//       directory, metadata, tiles — with nothing compressed, which the
//       reader allows. `tiles` is [{ z, x, y, data }]; `zxyToTileId` is the
//       `pmtiles` package's own. → { file: Buffer, at: Map(byte where each
//       tile starts → 'z/x/y') }, so a range request names the tile it asks
//       for.

function vint(n, out) {
  while (n > 127) { out.push((n % 128) + 128); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
function vint64(big, out) {
  let v = BigInt.asUintN(64, BigInt(big));
  while (v > 127n) { out.push(Number(v & 127n) + 128); v >>= 7n; }
  out.push(Number(v));
  return out;
}
const key = (field, wire, out) => vint(field * 8 + wire, out);
function bytesField(field, bytes, out) {
  key(field, 2, out); vint(bytes.length, out);
  for (const b of bytes) out.push(b);
  return out;
}
const packed = (field, nums, out) => bytesField(field, nums.reduce((o, n) => vint(n, o), []), out);
const zigzag = n => (n < 0 ? -2 * n - 1 : 2 * n);

function ringCommands(rings) {
  const g = [];
  let cx = 0, cy = 0;
  for (const r of rings) {
    g.push(1 + 8, zigzag(r[0][0] - cx), zigzag(r[0][1] - cy));
    cx = r[0][0]; cy = r[0][1];
    g.push(2 + (r.length - 1) * 8);
    for (let i = 1; i < r.length; i++) {
      g.push(zigzag(r[i][0] - cx), zigzag(r[i][1] - cy));
      cx = r[i][0]; cy = r[i][1];
    }
    g.push(7 + 8);
  }
  return g;
}

function valueBytes(v) {
  const m = [];
  if (typeof v === 'number') { key(3, 1, m); const d = Buffer.alloc(8); d.writeDoubleLE(v); m.push(...d); }
  else if (typeof v === 'boolean') { key(7, 0, m); vint(v ? 1 : 0, m); }
  else if (v && typeof v === 'object' && 'sint' in v) { key(6, 0, m); vint(zigzag(v.sint), m); }
  else if (v && typeof v === 'object' && 'int64' in v) { key(4, 0, m); vint64(v.int64, m); }
  else if (v && typeof v === 'object' && 'uint' in v) { key(5, 0, m); vint(v.uint, m); }
  else bytesField(1, Buffer.from(String(v)), m);
  return m;
}

export function mvtTile(layer, features, extent = 4096) {
  const keys = [], values = [], valueKeys = [];
  const keyIndex = k => { let i = keys.indexOf(k); if (i < 0) { keys.push(k); i = keys.length - 1; } return i; };
  const valueIndex = v => {
    const id = JSON.stringify(v);
    let i = valueKeys.indexOf(id);
    if (i < 0) { valueKeys.push(id); values.push(v); i = values.length - 1; }
    return i;
  };
  const L = [];
  key(15, 0, L); vint(2, L);                           // version
  bytesField(1, Buffer.from(layer), L);                // name
  for (const f of features) {
    const tags = [];
    for (const [k, v] of Object.entries(f.props || {})) tags.push(keyIndex(k), valueIndex(v));
    const F = [];
    packed(2, tags, F);
    key(3, 0, F); vint(f.type || 3, F);                // 3: a polygon
    packed(4, ringCommands(f.rings), F);
    bytesField(2, F, L);
  }
  for (const k of keys) bytesField(3, Buffer.from(k), L);
  for (const v of values) bytesField(4, valueBytes(v), L);
  key(5, 0, L); vint(extent, L);                       // extent
  return Buffer.from(bytesField(3, L, []));
}

export const square = (x0, y0, size, props = {}) =>
  ({ rings: [[[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size]]], props });

export function pmtilesFile(tiles, zxyToTileId, layer = 'building') {
  const ents = tiles.map(t => ({ id: zxyToTileId(t.z, t.x, t.y), t })).sort((a, b) => a.id - b.id);
  let off = 0;
  for (const e of ents) { e.off = off; off += e.t.data.length; }
  const dir = [];
  vint(ents.length, dir);
  let last = 0;
  for (const e of ents) { vint(e.id - last, dir); last = e.id; }
  for (const e of ents) vint(1, dir);                  // run lengths
  for (const e of ents) vint(e.t.data.length, dir);
  for (const e of ents) vint(e.off + 1, dir);
  const dirB = Buffer.from(dir);
  const meta = Buffer.from(JSON.stringify({ vector_layers: [{ id: layer, minzoom: 14, maxzoom: 14, fields: {} }] }));
  const H = 127, metaOff = H + dirB.length, dataOff = metaOff + meta.length;
  const head = Buffer.alloc(H);
  head.write('PMTiles', 0, 'latin1');
  head[7] = 3;
  [[8, H], [16, dirB.length], [24, metaOff], [32, meta.length], [40, dataOff], [48, 0], [56, dataOff], [64, off],
   [72, ents.length], [80, ents.length], [88, ents.length]].forEach(([at, v]) => head.writeBigUInt64LE(BigInt(v), at));
  head[96] = 1;                                        // clustered
  head[97] = 1; head[98] = 1;                          // directories and tiles uncompressed
  head[99] = 1;                                        // vector tiles
  head[100] = 14; head[101] = 14;                      // zooms
  [[102, -1800000000], [106, -850000000], [110, 1800000000], [114, 850000000]].forEach(([at, v]) => head.writeInt32LE(v, at));
  head[118] = 14;
  return { file: Buffer.concat([head, dirB, meta, ...ents.map(e => e.t.data)]),
           at: new Map(ents.map(e => [dataOff + e.off, `${e.t.z}/${e.t.x}/${e.t.y}`])) };
}
