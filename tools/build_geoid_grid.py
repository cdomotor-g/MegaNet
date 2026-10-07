#!/usr/bin/env python3
"""
build_geoid_grid.py — how far AHD is above the EGM96 geoid, everywhere a
station can be, as one small grid the browser reads: data/geoid-ahd-egm96.json.

WHY THIS EXISTS
    The ~30 m terrain tiles (terrain.js) are heights above the EGM96 geoid.
    Everything a flood is measured in — a gauge zero, an AEP level, a peak, a
    bridge deck, a surveyed station height — is in AHD. The app has said the
    two "agree to about a metre over Australia", and over the 4,866 stations
    with a position they do not: a point's AHD height is its EGM96 height less
    2.07 m to plus 0.64 m, less 0.61 m on average. Water put on a tile ground in
    the wrong datum is a flood two metres off.

    The Digital Twin turns the tile ground into AHD with this grid
    (geoid.js), so the levels it stands on it — the station's own or ones
    borrowed from a neighbour — are in the same datum as the ground.

WHERE THE NUMBERS COME FROM
    Two geoid models, as PROJ publishes them on its CDN (GeoTIFF, deflate,
    floating-point predictor, tiled — read here with nothing but the standard
    library, the same rule as the rest of tools/):

      au_ga_AUSGeoid2020_20180201.tif   GDA2020 ellipsoid → AHD, 1′ grid
                                        © Geoscience Australia, CC BY 4.0
      us_nga_egm96_15.tif               WGS 84 ellipsoid → EGM96, 15′ grid
                                        NGA, public domain

    A height is the ellipsoidal height less the geoid's undulation N, so

        H(AHD) − H(EGM96) = N(EGM96) − N(AUSGeoid2020)

    GDA2020 and WGS 84 (G1762) agree to a few centimetres, and GRS80 and the
    WGS 84 ellipsoid to under a millimetre in height, which is below the 2 cm
    the grid is stored to.

THE GRID
    Every 0.1° from 9° S to 44° S and from 112° E to 154° E — 351 × 421
    nodes, each on an AUSGeoid2020 node, so only the EGM96 side is
    interpolated. Stored as one byte a node: round(value / 0.02) + 128, 0 for
    "no value", base64. Over open ocean AUSGeoid2020 holds nothing; a node
    within three nodes (~30 km) of one that has a value takes the mean of its
    neighbours, so a coastal or island gauge still interpolates, and past that
    there is no value and the app says so rather than guessing.

    Bilinear interpolation of a 0.1° grid is not the 1′ model: the script
    measures what it costs, against the two source grids directly, at every
    station in stations.json and at 20,000 points over the land, and writes
    it into the file's meta. At the time of writing: 1.5 cm on average at the
    stations, 8 cm at the 99th percentile, 22 cm at the worst — an order of
    magnitude inside the tiles' own vertical error, which is what it is used
    against.

USAGE
    python3 tools/build_geoid_grid.py                   # fetch both from cdn.proj.org
    python3 tools/build_geoid_grid.py --egm96 a.tif --ausgeoid b.tif
    python3 tools/build_geoid_grid.py --out data/geoid-ahd-egm96.json
"""

import argparse
import base64
import datetime
import itertools
import json
import os
import random
import struct
import sys
import urllib.request
import zlib

CDN = 'https://cdn.proj.org/'
EGM96 = 'us_nga_egm96_15.tif'
AUSGEOID = 'au_ga_AUSGeoid2020_20180201.tif'

LAT0, LON0, STEP = -9.0, 112.0, 0.1
ROWS, COLS = 351, 421           # to 44° S and 154° E
SCALE, OFFSET, NODATA = 0.02, 128, 0
FILL_NODES = 3

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


# ── a GeoTIFF of one float32 band, as PROJ writes them ──────────────────────
class Grid:
    TAGS = {256: 'width', 257: 'height', 258: 'bits', 259: 'compression', 317: 'predictor',
            322: 'tile_w', 323: 'tile_h', 324: 'tile_offsets', 325: 'tile_counts',
            339: 'sample_format', 270: 'description', 33550: 'scale', 33922: 'tiepoint',
            34735: 'geokeys', 42113: 'nodata'}

    def __init__(self, data):
        self.data = data
        bo = data[:2]
        if bo not in (b'II', b'MM'):
            raise ValueError('not a TIFF')
        self.e = '<' if bo == b'II' else '>'
        (magic,) = struct.unpack(self.e + 'H', data[2:4])
        if magic != 42:
            raise ValueError('not a classic TIFF (BigTIFF is not read here)')
        (ifd,) = struct.unpack(self.e + 'I', data[4:8])
        t = self.tags = self._ifd(ifd)
        if t.get('bits', [32])[0] != 32 or t.get('sample_format', [3])[0] != 3:
            raise ValueError('expected float32 samples')
        if 'tile_w' not in t:
            raise ValueError('expected a tiled TIFF')
        self.w, self.h = t['width'][0], t['height'][0]
        self.tw, self.th = t['tile_w'][0], t['tile_h'][0]
        self.across = -(-self.w // self.tw)
        self.comp = t.get('compression', [1])[0]
        self.pred = t.get('predictor', [1])[0]
        sx, sy = t['scale'][0], t['scale'][1]
        tie = t['tiepoint']
        # Raster type: 2 is PixelIsPoint (the tie point is the first node), 1 is
        # PixelIsArea (it is the first cell's corner, half a cell off the node).
        gk = t.get('geokeys', [])
        raster = 1
        for i in range(4, len(gk), 4):
            if gk[i] == 1025:
                raster = gk[i + 3]
        half = 0.0 if raster == 2 else 0.5
        self.lon0 = tie[3] + half * sx
        self.lat0 = tie[4] - half * sy
        self.dx, self.dy = sx, sy
        nd = t.get('nodata')
        self.nodata = float(nd.strip('\x00')) if isinstance(nd, str) and nd.strip('\x00') else None
        self.description = (t.get('description') or '').strip('\x00')
        self.cache = {}

    def _ifd(self, off):
        e, d = self.e, self.data
        (n,) = struct.unpack(e + 'H', d[off:off + 2])
        sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8}
        fmt = {1: 'B', 2: 's', 3: 'H', 4: 'I', 5: 'II', 11: 'f', 12: 'd', 16: 'Q'}
        out = {}
        for i in range(n):
            p = off + 2 + 12 * i
            tag, typ, count = struct.unpack(e + 'HHI', d[p:p + 8])
            if tag not in self.TAGS or typ not in sizes:
                continue
            size = sizes[typ] * count
            at = p + 8 if size <= 4 else struct.unpack(e + 'I', d[p + 8:p + 12])[0]
            raw = d[at:at + size]
            if typ == 2:
                val = raw.decode('latin-1')
            elif typ == 5:
                v = struct.unpack(e + 'I' * (2 * count), raw)
                val = [v[k] / v[k + 1] for k in range(0, len(v), 2)]
            else:
                val = list(struct.unpack(e + fmt[typ] * count, raw))
            out[self.TAGS[tag]] = val
        return out

    def _tile(self, k):
        if k in self.cache:
            return self.cache[k]
        off, cnt = self.tags['tile_offsets'][k], self.tags['tile_counts'][k]
        raw = self.data[off:off + cnt]
        if self.comp in (8, 32946):
            raw = zlib.decompress(raw)
        elif self.comp != 1:
            raise ValueError(f'compression {self.comp} is not read here')
        tw, th = self.tw, self.th
        vals = []
        if self.pred == 3:
            # The floating-point predictor (Adobe TN3): each row's bytes are
            # differenced, and laid out as every sample's most significant byte,
            # then every sample's next, and so on — big-endian whatever the file.
            rb = tw * 4
            for r in range(th):
                row = raw[r * rb:(r + 1) * rb]
                acc = bytes(x & 255 for x in itertools.accumulate(row))
                be = bytearray(rb)
                for b in range(4):
                    be[b::4] = acc[b * tw:(b + 1) * tw]
                vals.extend(struct.unpack('>%df' % tw, be))
        elif self.pred == 1:
            vals = list(struct.unpack(self.e + '%df' % (tw * th), raw[:tw * th * 4]))
        else:
            raise ValueError(f'predictor {self.pred} is not read here')
        self.cache[k] = vals
        return vals

    def node(self, r, c):
        if not (0 <= r < self.h and 0 <= c < self.w):
            return None
        k = (r // self.th) * self.across + (c // self.tw)
        v = self._tile(k)[(r % self.th) * self.tw + (c % self.tw)]
        if v != v or (self.nodata is not None and abs(v - self.nodata) < 1e-3) or abs(v) > 1000:
            return None
        return v

    def at(self, lat, lon):
        """Bilinear between the four nodes round a point; None if any is empty."""
        fy = (self.lat0 - lat) / self.dy
        fx = (lon - self.lon0) / self.dx
        r, c = int(fy // 1), int(fx // 1)
        ty, tx = fy - r, fx - c
        if abs(ty) < 1e-9 and abs(tx) < 1e-9:
            return self.node(r, c)
        q = [self.node(r, c), self.node(r, c + 1), self.node(r + 1, c), self.node(r + 1, c + 1)]
        if any(v is None for v in q):
            return None
        return (q[0] * (1 - tx) * (1 - ty) + q[1] * tx * (1 - ty)
                + q[2] * (1 - tx) * ty + q[3] * tx * ty)


def fetch(name, path):
    if path:
        with open(path, 'rb') as f:
            return f.read()
    print(f'fetching {CDN}{name} …', file=sys.stderr)
    with urllib.request.urlopen(CDN + name, timeout=120) as r:
        return r.read()


def separation(egm, aus, lat, lon):
    a, e = aus.at(lat, lon), egm.at(lat, lon)
    return None if a is None or e is None else e - a


def build(egm, aus):
    grid = [[separation(egm, aus, LAT0 - i * STEP, LON0 + j * STEP) for j in range(COLS)] for i in range(ROWS)]
    # Near the coast, the mean of the neighbours that have a value; a pass at a
    # time, so a node is filled only from nodes no further than FILL_NODES out.
    filled = 0
    for _ in range(FILL_NODES):
        nxt = [row[:] for row in grid]
        for i in range(ROWS):
            for j in range(COLS):
                if grid[i][j] is not None:
                    continue
                nb = [grid[y][x] for y, x in ((i - 1, j), (i + 1, j), (i, j - 1), (i, j + 1))
                      if 0 <= y < ROWS and 0 <= x < COLS and grid[y][x] is not None]
                if nb:
                    nxt[i][j] = sum(nb) / len(nb)
                    filled += 1
        grid = nxt
    return grid, filled


def encode(grid):
    out = bytearray()
    for row in grid:
        for v in row:
            if v is None:
                out.append(NODATA)
                continue
            q = round(v / SCALE) + OFFSET
            if not 1 <= q <= 255:
                raise ValueError(f'{v} m does not fit the byte encoding')
            out.append(q)
    return bytes(out)


def decoded_at(enc, lat, lon):
    """The app's own lookup (geoid.js), restated: bilinear in the decoded grid."""
    fy, fx = (LAT0 - lat) / STEP, (lon - LON0) / STEP
    r, c = int(fy // 1), int(fx // 1)
    if not (0 <= r < ROWS - 1 and 0 <= c < COLS - 1):
        return None
    ty, tx = fy - r, fx - c
    q = [enc[r * COLS + c], enc[r * COLS + c + 1], enc[(r + 1) * COLS + c], enc[(r + 1) * COLS + c + 1]]
    if NODATA in q:
        return None
    v = [(b - OFFSET) * SCALE for b in q]
    return v[0] * (1 - tx) * (1 - ty) + v[1] * tx * (1 - ty) + v[2] * (1 - tx) * ty + v[3] * tx * ty


def errors(egm, aus, enc, points):
    errs, sep = [], []
    for lat, lon in points:
        truth = separation(egm, aus, lat, lon)
        got = decoded_at(enc, lat, lon)
        if truth is None or got is None:
            continue
        errs.append(abs(got - truth))
        sep.append(truth)
    if not errs:
        return None
    errs.sort()
    return {'points': len(errs), 'mean_m': round(sum(errs) / len(errs), 3),
            'p99_m': round(errs[min(len(errs) - 1, int(0.99 * len(errs)))], 3), 'max_m': round(errs[-1], 3),
            'separation_min_m': round(min(sep), 2), 'separation_max_m': round(max(sep), 2),
            'separation_mean_m': round(sum(sep) / len(sep), 2)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0].strip())
    ap.add_argument('--egm96', help=f'a local copy of {EGM96}')
    ap.add_argument('--ausgeoid', help=f'a local copy of {AUSGEOID}')
    ap.add_argument('--out', default=os.path.join(REPO, 'data', 'geoid-ahd-egm96.json'))
    ap.add_argument('--stations', default=os.path.join(REPO, 'stations.json'))
    a = ap.parse_args()

    egm = Grid(fetch(EGM96, a.egm96))
    aus = Grid(fetch(AUSGEOID, a.ausgeoid))
    print('grids read; sampling …', file=sys.stderr)
    grid, filled = build(egm, aus)
    enc = encode(grid)

    pts = []
    try:
        with open(a.stations, encoding='utf-8') as f:
            st = json.load(f)
        st = st.get('stations', st) if isinstance(st, dict) else st
        pts = [(float(s['lat']), float(s['lon'])) for s in st if s.get('lat') is not None and s.get('lon') is not None]
    except (OSError, ValueError) as e:
        print(f'no stations to measure against: {e}', file=sys.stderr)
    rnd = random.Random(1)
    land = [(rnd.uniform(-43.5, -10.0), rnd.uniform(113.0, 153.9)) for _ in range(20000)]
    acc = {'stations': errors(egm, aus, enc, pts), 'land': errors(egm, aus, enc, land)}
    print(json.dumps(acc, indent=2), file=sys.stderr)

    doc = {
        'meta': {
            'what': 'AHD less EGM96, metres: add it to a height above the EGM96 geoid to have the height in AHD',
            'formula': 'N(EGM96) − N(AUSGeoid2020), each the undulation over its ellipsoid at the node',
            'sources': [
                {'file': AUSGEOID, 'url': CDN + AUSGEOID, 'model': 'AUSGeoid2020 (GDA2020 → AHD)',
                 'described': aus.description, 'attribution': '© Commonwealth of Australia (Geoscience Australia)',
                 'licence': 'CC BY 4.0'},
                {'file': EGM96, 'url': CDN + EGM96, 'model': 'EGM96 (WGS 84 → EGM96)',
                 'described': egm.description, 'attribution': 'NGA', 'licence': 'public domain'},
            ],
            'tool': 'tools/build_geoid_grid.py',
            'generated': datetime.date.today().isoformat(),
            'filled_near_coast': filled,
            'accuracy': acc,
        },
        'lat0': LAT0, 'lon0': LON0, 'step': STEP, 'rows': ROWS, 'cols': COLS,
        'scale': SCALE, 'offset': OFFSET, 'nodata': NODATA,
        'encoding': 'base64 of one byte a node, rows north to south from lat0, columns west to east from lon0: value = (byte − offset) × scale; nodata is no value',
        'data': base64.b64encode(enc).decode('ascii'),
    }
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f'wrote {a.out} ({os.path.getsize(a.out):,} bytes)', file=sys.stderr)


if __name__ == '__main__':
    main()
