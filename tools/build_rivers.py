#!/usr/bin/env python3
"""
build_rivers.py — every named river and creek in Australia, as one file the
Stations map draws: data/rivers-au.json, read by map-river-lines.js.

WHY THIS EXISTS
    The map had the catchments (map-catchments.js) and a river highlight that
    lights up OpenStreetMap watercourses matching the filter box
    (map-rivers.js), and no rivers. Asked for in these words: "what I really
    need is the rivers themselves plotted on the map. They are really what we
    are most interested in this whole project". So the rivers are a layer of
    their own, on by default, named, and each one a thing a click selects.

WHERE THEY COME FROM
    The Bureau of Meteorology's Australian Hydrological Geospatial Fabric
    (the Geofabric), version 3.3: Surface Hydrology Network, the sublayer
    "AHGF Network Stream - Major, Named" — the principal named watercourses of
    the 1:250,000 national topographic series, joined into one topologically
    correct network: 168,685 segments, 3,149 names, in October 2026.
    © Commonwealth of Australia (Bureau of Meteorology) 2022, CC BY 4.0. Read
    from the copy Geoscience Australia's Digital Atlas of Australia hosts on
    ArcGIS Online (FEATURE_URL below), which is keyless and CORS-open; the
    Bureau's own MapServer answers the same data but sends no CORS header, so
    a page could draw it and could never ask it anything.

    Each segment carries its name, the segment downstream of it (NextDownID)
    and the area that drains through it (UpstrDArea, m²). The drainage area
    is the whole of the cartography: a river is drawn from the mouth upward as
    the map zooms in, the Burdekin's last reach (94,000 km²) at the national
    view and its headwaters only at a district's.

    The minor named creeks — Oxley Creek, Kedron Brook, the Mooloolah — are
    the same network's "All" sublayer, about 600,000 named segments, and are
    not in this file: map-river-lines.js asks for them a town's view at a
    time, close in, which is the only scale they can be read at.

WHY A FILE AND NOT A LIVE QUERY
    Measured in October 2026: a Queensland-wide view asked of the service
    with a drainage-area filter took 36 s and still hit the 2,000-record cap,
    and the field is not indexed. A view of one town takes 2 s. A layer that
    is on for everybody the moment the map opens cannot cost either, and it
    has to be there with no signal at a gauge, where the service worker's
    copy of this file is the only river there is. The Geofabric is mapped at
    1:250,000 — a line in it is good to a hundred metres or so — so a copy
    simplified to SIMPLIFY_DEG loses nothing that was there.

THE FILES
    data/rivers-au.json, read when the map first opens:
    {
      "meta":      { source, licence, attribution, built, counts, format },
      "bands":     [20000, 5000, 1000, 250, 50, 0]  km² draining through a reach
      "quant":     10000                           line units per degree
      "tile_band": 3,  "tile_deg": 2,  "tiles": ["152_-28", …]
      "rivers":    [[name, area_km2, length_km, [w, s, e, n], [[band, line, n], …]], …]
    }
    data/rivers-au/<tile>.json, read once the map is close enough to draw
    band tile_band: { "tile": "152_-28", "runs": [[river, band, line, n], …] }

    One entry in `rivers` per river: the segments of one name that join,
    downstream or across a short gap (a lake, a weir pool, a reach the layer
    leaves out), into one system — so "DEEP CREEK" is the several different
    creeks it is, and the Brisbane River is one river either side of
    Wivenhoe. `area_km2` is what drains through its lowest reach, `length_km`
    the sum of its segments, the box its extent. Largest first; a tile names
    a river by its place in this list.

    A river's line is cut into runs, each wholly inside one drainage-area
    band: band 0 is its reaches draining at least bands[0] km², and so on
    down. The map draws band b and every band before it, so a wider view is
    the same rivers, shorter. The big reaches (bands before tile_band) are in
    the national file; the rest are filed under the tile_deg square each run
    starts in, a run that crosses a tile's edge cut there so both halves meet.
    `line` is an encoded polyline — Google's algorithm, latitude first — at
    1/quant degree, about eleven metres, a tenth of what the source can say;
    `n` is its point count.

    Names are as the Geofabric spells them, in capitals, the station
    register's convention for `stream` ("CONDAMINE RIVER"), so the map can
    match a river to the gauges on it by name.

USAGE
    python3 tools/build_rivers.py                          # fetch, build, write
    python3 tools/build_rivers.py --cache /tmp/geofabric   # keep the raw pages
    python3 tools/build_rivers.py --out data/rivers-au.json

    The fetch is 85 pages of 2,000 segments, twenty to thirty minutes from
    this service; the build after it about twenty seconds.
    With --cache, a page already on disk is not asked for again, so a rebuild
    with different bands or tolerance costs no requests at all.
"""

import argparse
import datetime
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FEATURE_URL = ('https://services-ap1.arcgis.com/ypkPEy1AmwPKGNNv/arcgis/rest/services/'
               'Geofabric_Surface_Hydrology_Network/FeatureServer/6')
SOURCE_PAGE = 'https://www.arcgis.com/home/item.html?id=cffa074a84f042dfa910fa9049a786e0'
ATTRIBUTION = 'Rivers: Geofabric v3.3 © Commonwealth of Australia (Bureau of Meteorology), CC BY 4.0'

PAGE = 2000             # the service's maxRecordCount
FETCH_OFFSET = 0.0002   # deg; generalised by the server as it answers (~20 m)
SIMPLIFY_DEG = 0.0004   # deg; Douglas–Peucker on the joined runs (~40 m)
QUANT = 10000           # coordinate units per degree in the file
BANDS = [20000, 5000, 1000, 250, 50, 0]   # km² draining through a reach
GAP_KM = 15             # same-name pieces this close are one river
MIN_AREA = 0            # km²; reaches draining less than this are left out
TILE_BAND = 3           # bands from this one on live in tiles, not the national file
TILE_DEG = 2            # deg; the tiles' side
TIMEOUT = 90


# ── Fetch ─────────────────────────────────────────────────────────────────────

def ask(params):
    url = FEATURE_URL + '/query?' + urllib.parse.urlencode(params)
    last = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT) as res:
                data = json.loads(res.read().decode('utf-8'))
            if 'error' in data:
                raise RuntimeError(data['error'])
            return data
        except Exception as e:     # a public service: retry before giving up
            last = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f'the Geofabric service did not answer: {last}')


def fetch(cache):
    """Every segment, as [{id, down, name, area_m2, len_m, paths}]."""
    count = ask({'where': '1=1', 'returnCountOnly': 'true', 'f': 'json'})['count']
    pages = math.ceil(count / PAGE)
    out = []
    for i in range(pages):
        path = os.path.join(cache, f'page-{i:04d}.json') if cache else None
        if path and os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
        else:
            data = ask({
                'where': '1=1',
                'outFields': 'OBJECTID,HydroID,NextDownID,Name,UpstrDArea,GeodesLen',
                'returnGeometry': 'true', 'outSR': '4326',
                'maxAllowableOffset': str(FETCH_OFFSET), 'geometryPrecision': '5',
                'orderByFields': 'OBJECTID', 'resultOffset': str(i * PAGE),
                'resultRecordCount': str(PAGE), 'f': 'json',
            })
            if path:
                with open(path, 'w', encoding='utf-8') as f:
                    json.dump(data, f)
        for feat in data.get('features', []):
            a = feat.get('attributes') or {}
            g = feat.get('geometry') or {}
            name = (a.get('Name') or '').strip()
            paths = [p for p in g.get('paths') or [] if len(p) >= 2]
            if not name or not paths:
                continue
            out.append({
                'id': a.get('HydroID'), 'down': a.get('NextDownID'), 'name': name,
                'area': (a.get('UpstrDArea') or 0) / 1e6, 'len': (a.get('GeodesLen') or 0) / 1000,
                'paths': paths,
            })
        print(f'  page {i + 1}/{pages}: {len(out)} segments', file=sys.stderr)
    return out, count



# ── Rivers ────────────────────────────────────────────────────────────────────

def km(a, b):
    """Rough distance in km between two lon, lat points — good to a percent."""
    mlat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * math.cos(mlat), a[1] - b[1]) * 111.32


class Union:
    def __init__(self):
        self.up = {}

    def find(self, x):
        self.up.setdefault(x, x)
        while self.up[x] != x:
            self.up[x] = self.up[self.up[x]]
            x = self.up[x]
        return x

    def join(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.up[max(a, b)] = min(a, b)


def systems(segs, by_id):
    """Segment id → river id: same-name segments that join downstream, or
    across a gap — through a short run of other names (a lake, a weir pool),
    or, where the gap is a reach the named layer leaves out, from the lower
    end of one piece to within GAP_KM of another of the same name."""
    u = Union()
    for s in segs:
        u.find(s['id'])
        d = by_id.get(s['down'])
        if d and d['name'] == s['name']:
            u.join(s['id'], d['id'])
    # Through other names: follow the network down from each piece's lowest
    # segment until GAP_KM of channel has gone by.
    for s in segs:
        d = by_id.get(s['down'])
        if not d or d['name'] == s['name']:
            continue
        walked, cur, seen = 0.0, d, 0
        while cur and walked <= GAP_KM and seen < 200:
            if cur['name'] == s['name']:
                u.join(s['id'], cur['id'])
                break
            walked += cur['len']
            cur = by_id.get(cur['down'])
            seen += 1
    # Across a reach that is not in the layer at all: by distance.
    pieces = {}
    for s in segs:
        pieces.setdefault((s['name'], u.find(s['id'])), []).append(s)
    by_name = {}
    for (name, root), members in pieces.items():
        pts = [p for m in members for path in m['paths'] for p in path]
        outlets = [m['paths'][-1][-1] for m in members
                   if not (by_id.get(m['down']) and by_id[m['down']]['name'] == name)]
        box = (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))
        by_name.setdefault(name, []).append({'root': root, 'pts': pts, 'outlets': outlets, 'box': box})
    pad = GAP_KM / 111.32 * 1.6
    for name, group in by_name.items():
        if len(group) < 2:
            continue
        for a in group:
            for b in group:
                if a is b or u.find(a['root']) == u.find(b['root']):
                    continue
                if (a['box'][0] - pad > b['box'][2] or b['box'][0] - pad > a['box'][2]
                        or a['box'][1] - pad > b['box'][3] or b['box'][1] - pad > a['box'][3]):
                    continue
                if any(km(o, p) <= GAP_KM for o in a['outlets'] for p in b['pts'][::3]):
                    u.join(a['root'], b['root'])
    return {s['id']: u.find(s['id']) for s in segs}


def band_of(area):
    for i, t in enumerate(BANDS):
        if area >= t:
            return i
    return len(BANDS) - 1


def runs(members, by_id, river_of):
    """One river's segments as [(band, [[lon, lat], …]), …]: chains of
    segments in one band, each joined end to end, upstream first.

    Where two reaches of the same name meet — an anabranch rejoining, a
    braided channel in the Channel Country — the line carries on up the one
    draining more, and the other ends at the junction. Breaking at every such
    junction instead left the inland rivers as thousands of two-point runs."""
    ids = {m['id'] for m in members}

    def nxt(m):
        d = by_id.get(m['down'])
        if d and d['id'] in ids and band_of(d['area']) == band_of(m['area']):
            return d
        return None

    main_up = {}                             # segment id → the upstream it continues
    for m in members:
        d = nxt(m)
        if d and (d['id'] not in main_up or m['area'] > main_up[d['id']]['area']):
            main_up[d['id']] = m
    out = []
    done = set()
    starts = [m for m in members if m['id'] not in main_up]
    for start in starts + members:          # members again: a loop has no start
        if start['id'] in done:
            continue
        line = []
        cur = start
        while cur and cur['id'] not in done:
            done.add(cur['id'])
            for k, path in enumerate(cur['paths']):
                pts = [list(p) for p in path]
                if k == 0 and line:
                    if km(line[-1], pts[-1]) < km(line[-1], pts[0]):
                        pts.reverse()
                    if pts[0] == line[-1]:
                        pts = pts[1:]
                    line.extend(pts)
                elif k == 0:
                    line = pts
                else:                        # a second part of one segment: its own run
                    out.append((band_of(cur['area']), pts))
            d = nxt(cur)
            cur = d if d and main_up.get(d['id']) is cur else None
        if len(line) >= 2:
            out.append((band_of(start['area']), line))
    return out


def simplify(pts, tol):
    """Douglas–Peucker, in degrees with longitude shrunk to the latitude."""
    if len(pts) < 3:
        return pts
    k = math.cos(math.radians(pts[0][1]))
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    t2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a][0] * k, pts[a][1]
        bx, by = pts[b][0] * k, pts[b][1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i][0] * k - ax, pts[i][1] - ay
            if L2:
                t = max(0.0, min(1.0, (px * dx + py * dy) / L2))
                ex, ey = px - t * dx, py - t * dy
            else:
                ex, ey = px, py
            d = ex * ex + ey * ey
            if d > best:
                best, bi = d, i
        if best > t2:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, kk in zip(pts, keep) if kk]


def _enc(v):
    v = ~(v << 1) if v < 0 else v << 1
    out = []
    while v >= 0x20:
        out.append(chr((0x20 | (v & 0x1f)) + 63))
        v >>= 5
    out.append(chr(v + 63))
    return ''.join(out)


def encode(pts):
    """[lon, lat] pairs → an encoded polyline (Google's algorithm, lat first)
    at 1/QUANT degree. Returns (text, points); a repeated point is dropped."""
    out, plat, plon, n = [], 0, 0, 0
    for x, y in pts:
        qlat, qlon = round(y * QUANT), round(x * QUANT)
        if n and qlat == plat and qlon == plon:
            continue
        out.append(_enc(qlat - plat) + _enc(qlon - plon))
        plat, plon, n = qlat, qlon, n + 1
    return ''.join(out), n


def tile_of(x, y):
    """The TILE_DEG square a lon, lat falls in, as its file name's key."""
    return f'{math.floor(x / TILE_DEG) * TILE_DEG}_{math.floor(y / TILE_DEG) * TILE_DEG}'


def cut_at_tiles(line):
    """A run as pieces that each start in one tile: a piece ends on the first
    vertex past its tile's edge, and the next piece starts from that vertex,
    so the pieces meet and the line is unbroken when both are drawn."""
    pieces, cur, key = [], [line[0]], tile_of(*line[0])
    for p in line[1:]:
        cur.append(p)
        k = tile_of(*p)
        if k != key:
            pieces.append((key, cur))
            cur, key = [p], k
    if len(cur) >= 2:
        pieces.append((key, cur))
    return pieces


def build(segs, min_area):
    """(rivers, tiles): the national index with every river's big reaches, and
    tile key → the smaller reaches that start in it."""
    by_id = {s['id']: s for s in segs if s['id'] is not None}
    river_of = systems(segs, by_id)
    groups = {}
    for s in segs:
        groups.setdefault(river_of[s['id']], []).append(s)
    found = []
    for members in groups.values():
        drawn = [m for m in members if m['area'] >= min_area]
        if not drawn:
            continue
        lines = [(band, simplify(line, SIMPLIFY_DEG)) for band, line in runs(drawn, by_id, river_of)]
        lines = [(b, l) for b, l in lines if len(l) >= 2]
        if not lines:
            continue
        pts = [p for _, l in lines for p in l]
        box = [round(min(p[0] for p in pts), 3), round(min(p[1] for p in pts), 3),
               round(max(p[0] for p in pts), 3), round(max(p[1] for p in pts), 3)]
        area = max(m['area'] for m in members)
        found.append({'name': members[0]['name'], 'area': area,
                      'len': sum(m['len'] for m in members), 'box': box, 'lines': lines})
    # Largest first: the index a tile names a river by is its place here, and
    # the order is also the order the map would label them in.
    found.sort(key=lambda r: (-r['area'], r['name']))
    rivers, tiles = [], {}
    for rid, r in enumerate(found):
        core = []
        for band, line in sorted(r['lines'], key=lambda bl: bl[0]):
            if band < TILE_BAND:
                enc, n = encode(line)
                if n >= 2:
                    core.append([band, enc, n])
                continue
            for key, piece in cut_at_tiles(line):
                enc, n = encode(piece)
                if n >= 2:
                    tiles.setdefault(key, []).append([rid, band, enc, n])
        a = r['area']
        rivers.append([r['name'], round(a, 1) if a < 100 else round(a), round(r['len'], 1), r['box'], core])
    return rivers, tiles


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--cache', help='keep (and reuse) the raw pages here')
    ap.add_argument('--out', default=os.path.join(REPO, 'data', 'rivers-au.json'),
                    help='the national file; the tiles go in a folder beside it of the same name')
    ap.add_argument('--min-area', type=float, default=MIN_AREA,
                    help=f'km² draining through a reach for it to be kept (default {MIN_AREA})')
    a = ap.parse_args()
    if a.cache:
        os.makedirs(a.cache, exist_ok=True)
    segs, total = fetch(a.cache)
    rivers, tiles = build(segs, a.min_area)

    tile_dir = os.path.splitext(a.out)[0]
    os.makedirs(tile_dir, exist_ok=True)
    for old in os.listdir(tile_dir):           # a rebuild leaves no tile behind
        if old.endswith('.json'):
            os.remove(os.path.join(tile_dir, old))
    tile_pts = 0
    for key, list_ in sorted(tiles.items()):
        tile_pts += sum(r[3] for r in list_)
        with open(os.path.join(tile_dir, f'{key}.json'), 'w', encoding='utf-8') as f:
            json.dump({'tile': key, 'runs': list_}, f, separators=(',', ':'))

    core_pts = sum(l[2] for r in rivers for l in r[4])
    doc = {
        'meta': {
            'source': 'Australian Hydrological Geospatial Fabric (Geofabric) v3.3, Surface Hydrology '
                      'Network — AHGF Network Stream, Major, Named',
            'publisher': 'Bureau of Meteorology',
            'licence': 'CC BY 4.0',
            'attribution': ATTRIBUTION,
            'url': SOURCE_PAGE,
            'service': FEATURE_URL,
            'built': datetime.date.today().isoformat(),
            'built_by': 'tools/build_rivers.py',
            'segments': total,
            'segments_kept': sum(1 for s in segs if s['area'] >= a.min_area),
            'min_area_km2': a.min_area,
            'simplify_deg': SIMPLIFY_DEG,
            'rivers': len(rivers),
            'points_here': core_pts,
            'points_in_tiles': tile_pts,
            'format': 'rivers: [name, area_km2, length_km, [west, south, east, north], '
                      '[[band, line, points], …]]. line is an encoded polyline (Google\'s '
                      'algorithm, latitude first) at 1/quant degree. A reach is in band i when at '
                      'least bands[i] km² drains through it; bands from tile_band on are in '
                      '<this file\'s name>/<tile>.json as runs: [[river index, band, line, '
                      'points], …], each run filed under the tile_deg square its first point is in.',
        },
        'bands': BANDS,
        'quant': QUANT,
        'tile_band': TILE_BAND,
        'tile_deg': TILE_DEG,
        'tiles': sorted(tiles),
        'rivers': rivers,
    }
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, separators=(',', ':'), ensure_ascii=False)
    tile_bytes = sum(os.path.getsize(os.path.join(tile_dir, f)) for f in os.listdir(tile_dir))
    print(f'{a.out}: {len(rivers)} rivers, {core_pts} points, {os.path.getsize(a.out) / 1e6:.2f} MB; '
          f'{len(tiles)} tiles, {tile_pts} points, {tile_bytes / 1e6:.2f} MB', file=sys.stderr)


if __name__ == '__main__':
    main()
