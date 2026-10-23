#!/usr/bin/env python3
"""
build_catchments.py — the land that drains to every river on the map, and to
every gauge on one: data/catchments-au/, read by river-catchments.js.

WHY THIS EXISTS
    Asked for after the rivers layer (build_rivers.py) shipped: "it would be
    really cool if we could highlight the catchment of a stream … shade the
    catchment based on elevation data rather than the grainy KML data". So a
    river selected on the Stations map shades the country that drains into it,
    and a station on a stream can show the country above its gauge.

WHERE THE BOUNDARIES COME FROM
    Not from the elevation tiles in the browser. A catchment is where water
    runs downhill to, and working that out from raw heights is a job for a
    hydrologically conditioned DEM — pits filled, streams burnt in, flats
    given a direction — over a hundred million cells for one big river. The
    Bureau of Meteorology has done exactly that for the whole country: the
    Geofabric v3.3 Hydrology Reporting Catchments are the land surface cut at
    every significant node of the stream network — junctions, dams, and the
    gauging stations themselves — from that DEM, about 30 m, and joined into a
    network. © Commonwealth of Australia (Bureau of Meteorology), CC BY 4.0,
    read from Geoscience Australia's Digital Atlas copy (CATCH_URL), keyless
    and CORS-open like the rivers.

      AHGF Contracted Catchment   53,804 sub-catchments, ~100 km² on average,
                                  each draining from its inlet node
                                  (FConNodeID) to its outlet node (ConNodeID).
      AHGF Node                   the nodes; 2,699 carry a gauging station's
                                  number (StationNo — the AWRC number the
                                  station register holds as awrc_number).
      AHGF Network Stream         each river segment's sub-catchment
                                  (ConCatID), which ties a river to them.

    The catchment above a node is every sub-catchment draining to it, and
    every one draining to their inlets, and so on up: a walk over the nodes.

    A small creek can lie wholly inside one sub-catchment of the river it
    joins, and then the sub-catchments cannot cut its catchment out: both
    answers they give are the river's. For those the network's own fine
    catchments are read — one per stream segment of the whole network, minor
    creeks included, a square kilometre on average, 7 million in all, each
    draining to the next — and only round the reaches that need them: a
    river's mouth, a station's reach, draining under FINE_MAX_AREA. Asked of
    the service by sub-catchment they cost a scan of all seven million rows a
    page, so they are asked for by place instead, a FINE_TILE square at a
    time, links and areas only: a box round the reach sized to the area the
    network says drains to it, grown while what is traced above the reach
    falls short of that and is still growing. Rings are then read for only
    the fine catchments an answer is made of. The catchment is every fine
    catchment above the reach's own, inside its sub-catchment, and — where
    that falls short because the reach is on the sub-catchment's main stem —
    everything above the sub-catchment's inlet as well. Every answer, coarse
    or fine, is believed only within RATIO_LO to RATIO_HI of the drainage area
    the network gives that reach.

WHY A GRID
    The sub-catchments are cut from the DEM, so their edges are its cell
    edges — about 3,000 vertices each, 160 million in all. Joining the few
    thousand that make up the Murray–Darling into one outline is a polygon
    union nobody wants to write by hand in Python. So each sub-catchment is
    burnt into one national grid of labels at GRID_DEG (~250 m), a catchment
    is the cells whose label is in its set, and its outline is the edge of
    those cells, traced and then simplified — to a tolerance that grows with
    the catchment, since a continent-sized one is only ever looked at whole.
    The one tool in this directory that needs numpy (pip install numpy): the
    grid is 230 million cells.

THE FILES
    data/catchments-au/index.json
      { meta,
        rivers:   [[area_km2, bucket] | null, …]   by the rivers file's index
        stations: { station id: [area_km2, bucket, how, station_no], … } }
      how is "gauge" when the station's AWRC number is a gauged node of the
      network (exact), "reach" when it was traced up the fine catchments from
      the reach the station stands on, placed by name and position, or "near"
      when only the sub-catchments would answer (the nearer of the two
      sub-catchment boundaries round the reach).
    data/catchments-au/r<bucket>.json, s<bucket>.json
      { "<river index or station id>": { area, box: [w, s, e, n],
                                          rings: [line, …] }, … }
      rings are encoded polylines (Google's algorithm, latitude first) at
      1/quant degree, outer rings only — a pocket inside a catchment that the
      Geofabric says drains nowhere is filled (MIN_HOLE) — anticlockwise, and
      the page fills them even-odd.

USAGE
    python3 tools/build_catchments.py --cache ~/geofabric       # fetch, build
    python3 tools/build_catchments.py --cache ~/geofabric --rivers-cache ~/geofabric-rivers

    --rivers-cache is build_rivers.py's --cache: the rivers are rebuilt from
    the same pages so a river's index here is its index in rivers-au.json.
    The sub-catchments are 27 pages of about 50 MB, forty-five minutes from
    the service; the fine catchments round the reaches some 21,000 small
    tiles, twenty-five minutes or so at FINE_WORKERS in flight. With
    --cache a rebuild asks for nothing.
"""

import argparse
import datetime
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_rivers as br  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ATLAS = 'https://services-ap1.arcgis.com/ypkPEy1AmwPKGNNv/arcgis/rest/services'
CATCH_URL = f'{ATLAS}/Geofabric_Hydrology_Reporting_Catchments/FeatureServer/5'
NODE_URL = f'{ATLAS}/Geofabric_Hydrology_Reporting_Catchments/FeatureServer/1'
STREAM_URL = br.FEATURE_URL
ATTRIBUTION = ('Catchments: Geofabric v3.3 © Commonwealth of Australia (Bureau of Meteorology), '
               'CC BY 4.0')

PAGE = 2000
FETCH_OFFSET = 0.002     # deg; the server's generalisation of each sub-catchment
TIMEOUT = 180


# ── Fetch ─────────────────────────────────────────────────────────────────────

def ask(url, params):
    """A query, POSTed: an IN list of a few hundred ids is past what a URL
    should carry."""
    body = urllib.parse.urlencode(params).encode('utf-8')
    last = None
    for attempt in range(6):
        try:
            req = urllib.request.Request(url + '/query', data=body,
                                         headers={'Content-Type': 'application/x-www-form-urlencoded'})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                data = json.loads(res.read().decode('utf-8'))
            if 'error' in data:
                raise RuntimeError(data['error'])
            return data
        except Exception as e:     # a public service: retry before giving up
            last = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f'the Geofabric service did not answer: {last}')


def pages(url, where, params, cache, prefix):
    """Every feature matching `where`, a page at a time, each page kept in
    `cache` under `prefix` so a rebuild asks for nothing."""
    count = ask(url, {'where': where, 'returnCountOnly': 'true', 'f': 'json'})['count']
    n = math.ceil(count / PAGE)
    for i in range(n):
        path = os.path.join(cache, f'{prefix}-{i:04d}.json') if cache else None
        if path and os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
        else:
            data = ask(url, dict(params, where=where, orderByFields='OBJECTID',
                                 resultOffset=str(i * PAGE), resultRecordCount=str(PAGE), f='json'))
            if path:
                tmp = path + '.part'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(data, f)
                os.replace(tmp, path)
        print(f'  {prefix} page {i + 1}/{n}', file=sys.stderr)
        yield data.get('features', [])


def catchment_pages(cache):
    return pages(CATCH_URL, '1=1', {
        'outFields': 'ConCatID,ConNodeID,FConNodeID,AlbersArea',
        'returnGeometry': 'true', 'outSR': '4326',
        'maxAllowableOffset': str(FETCH_OFFSET), 'geometryPrecision': '5',
    }, cache, 'catchments')


def gauged_nodes(cache):
    out = []
    for feats in pages(NODE_URL, "StationNo IS NOT NULL AND StationNo <> ' '", {
        'outFields': 'ConNodeID,StationNo,UpstrDArea', 'returnGeometry': 'true', 'outSR': '4326',
    }, cache, 'nodes'):
        for f in feats:
            a, g = f.get('attributes') or {}, f.get('geometry') or {}
            no = str(a.get('StationNo') or '').strip()
            if no and a.get('ConNodeID') is not None:
                out.append({'node': a['ConNodeID'], 'no': no, 'area': (a.get('UpstrDArea') or 0) / 1e6,
                            'lon': g.get('x'), 'lat': g.get('y')})
    return out


def segment_catchments(cache):
    """Network stream segment HydroID → its sub-catchment's ConCatID."""
    out = {}
    for feats in pages(STREAM_URL, '1=1', {'outFields': 'HydroID,ConCatID', 'returnGeometry': 'false'},
                       cache, 'segments'):
        for f in feats:
            a = f.get('attributes') or {}
            if a.get('HydroID') is not None and a.get('ConCatID') is not None:
                out[a['HydroID']] = a['ConCatID']
    return out


# ── The fine catchments ──────────────────────────────────────────────────────
# The Surface Hydrology Network's own catchments: one for every stream
# segment of the whole network, minor creeks included — 7,047,524 of them, a
# square kilometre on average, each draining to the next (NextDownID) and each
# knowing which sub-catchment it lies in (ConCatID). All of them would be tens
# of gigabytes; what is fetched is only the fine catchments inside the
# sub-catchments where a river's mouth or a station's reach is, which is where
# the sub-catchments are too coarse to cut a small creek's catchment out.

FINE_URL = br.FEATURE_URL.rsplit('/', 1)[0] + '/1'
FINE_OFFSET = 0.0003     # deg; the server's generalisation of each fine catchment
ID_CHUNK = 400           # ids in one IN list


def chunked(xs, n):
    xs = list(xs)
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def by_ids(url, field, ids, out_fields, cache, prefix):
    """Attribute rows for `field IN ids`, cached per chunk."""
    rows = []
    for chunk in chunked(sorted(set(ids)), ID_CHUNK):
        key = hashlib.sha1(','.join(map(str, chunk)).encode()).hexdigest()[:16]
        for feats in pages(url, f'{field} IN ({",".join(map(str, chunk))})',
                           {'outFields': out_fields, 'returnGeometry': 'false'}, cache, f'{prefix}-{key}'):
            rows.extend(f.get('attributes') or {} for f in feats)
    return rows


FINE_TILE = 0.1          # deg; the fine catchments are asked for a tile at a time
FINE_WORKERS = 12        # requests in flight at once
FINE_MAX_HALF = 0.5      # deg; how far round a reach the search may grow
FINE_MAX_AREA = 2000     # km²; a reach draining more keeps the sub-catchments' answer, which
                         # at that size is the right one: a river that big has its own


def query_all(url, params, path):
    """Every record a query returns, page by page, kept at `path`. Paged on
    exceededTransferLimit, so a query that fits one page is one request."""
    if path and os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)['features']
    feats, off = [], 0
    while True:
        data = ask(url, dict(params, orderByFields='OBJECTID', resultOffset=str(off),
                             resultRecordCount=str(PAGE), f='json'))
        got = data.get('features', [])
        feats.extend(got)
        if not data.get('exceededTransferLimit') or not got:
            break
        off += len(got)
    if path:
        tmp = path + '.part'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'features': feats}, f)
        os.replace(tmp, path)
    return feats


def parallel(fn, items, label):
    """fn over items, FINE_WORKERS at a time, in order, saying how far it got."""
    from concurrent.futures import ThreadPoolExecutor
    items = list(items)
    out = []
    with ThreadPoolExecutor(FINE_WORKERS) as ex:
        for i, r in enumerate(ex.map(fn, items)):
            out.append(r)
            if (i + 1) % 200 == 0 or i + 1 == len(items):
                print(f'  {label} {i + 1}/{len(items)}', file=sys.stderr)
    return out


def fine_tile(cache, key):
    """The fine catchments meeting one FINE_TILE square: how they link and how
    big they are, no rings. A spatial query is the one the service answers
    fast; asked by ConCatID it scans all seven million rows a page."""
    tx, ty = key
    env = ','.join(f'{v:.4f}' for v in (tx * FINE_TILE, ty * FINE_TILE, (tx + 1) * FINE_TILE, (ty + 1) * FINE_TILE))
    return query_all(FINE_URL, {
        'where': '1=1', 'geometry': env, 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326',
        'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'HydroID,NextDownID,ConCatID,AlbersArea',
        'returnGeometry': 'false',
    }, os.path.join(cache, f'finetile-{tx}_{ty}.json') if cache else None)


def fine_rings(cache, hids):
    """The rings of these fine catchments, ID_CHUNK at a time."""
    def one(chunk):
        key = hashlib.sha1(','.join(map(str, chunk)).encode()).hexdigest()[:16]
        return query_all(FINE_URL, {
            'where': f'HydroID IN ({",".join(map(str, chunk))})', 'outFields': 'HydroID',
            'returnGeometry': 'true', 'outSR': '4326',
            'maxAllowableOffset': str(FINE_OFFSET), 'geometryPrecision': '5',
        }, os.path.join(cache, f'finerings-{key}.json') if cache else None)
    out = {}
    for feats in parallel(one, chunked(sorted(set(hids)), ID_CHUNK), 'rings'):
        for f in feats:
            a, g = f.get('attributes') or {}, f.get('geometry') or {}
            if a.get('HydroID') is not None:
                out[a['HydroID']] = g.get('rings') or []
    return out


# ── The grid ──────────────────────────────────────────────────────────────────
# One label per cell, 0 for none: the sub-catchment's place in the list, plus
# one. 53,804 fits a uint16.

GRID_DEG = 0.0025                       # ~250 m
W, E, S, N = 112.5, 154.0, -44.0, -9.0
COLS = round((E - W) / GRID_DEG)
ROWS = round((N - S) / GRID_DEG)
FINE_DEG = 0.0005                       # ~50 m, for a catchment cut from the fine ones


class Grid:
    """Where a grid's cells are: its west and north edges, its cell, its shape."""
    def __init__(self, w, n, res, rows, cols):
        self.w, self.n, self.res, self.rows, self.cols = w, n, res, rows, cols


NATIONAL = Grid(W, N, GRID_DEG, ROWS, COLS)


def burn(np, grid, label, rings, box, g=NATIONAL):
    """Paint one catchment's rings into the grid, even-odd, by cell centre —
    a scanline per row, every edge's crossings found at once."""
    x0s, y0s, x1s, y1s = [], [], [], []
    for ring in rings:
        r = np.asarray(ring, dtype=np.float64)
        if len(r) < 3:
            continue
        nxt = np.roll(r, -1, axis=0)
        x0s.append(r[:, 0]); y0s.append(r[:, 1]); x1s.append(nxt[:, 0]); y1s.append(nxt[:, 1])
    if not x0s:
        return
    x0, y0, x1, y1 = (np.concatenate(v) for v in (x0s, y0s, x1s, y1s))
    keep = y0 != y1
    x0, y0, x1, y1 = x0[keep], y0[keep], x1[keep], y1[keep]
    ylo, yhi = np.minimum(y0, y1), np.maximum(y0, y1)
    # Row r's centre is n - (r + ½)·res; an edge crosses it when ylo ≤ y < yhi.
    r_from = np.maximum(np.floor((g.n - yhi) / g.res - 0.5).astype(np.int64) + 1, 0)
    r_to = np.minimum(np.floor((g.n - ylo) / g.res - 0.5).astype(np.int64), g.rows - 1)
    counts = np.maximum(r_to - r_from + 1, 0)
    total = int(counts.sum())
    if not total:
        return
    idx = np.repeat(np.arange(len(counts)), counts)
    starts = np.repeat(np.cumsum(counts) - counts, counts)
    rows = r_from[idx] + (np.arange(total) - starts)
    yr = g.n - (rows + 0.5) * g.res
    xr = x0[idx] + (yr - y0[idx]) * (x1[idx] - x0[idx]) / (y1[idx] - y0[idx])
    order = np.lexsort((xr, rows))
    rows, xr = rows[order], xr[order]
    if len(rows) % 2:
        return                              # an unclosed ring: never seen, never guessed at
    ra, rb = rows[0::2], rows[1::2]
    ok = ra == rb
    ra, xa, xb = ra[ok], xr[0::2][ok], xr[1::2][ok]
    c0 = np.clip(np.ceil((xa - g.w) / g.res - 0.5).astype(np.int64), 0, g.cols)
    c1 = np.clip(np.ceil((xb - g.w) / g.res - 0.5).astype(np.int64), 0, g.cols)
    span = c1 > c0
    ra, c0, c1 = ra[span], c0[span], c1[span]
    if not len(ra):
        return
    for r, a, b in zip(ra.tolist(), c0.tolist(), c1.tolist()):
        grid[r, a:b] = label
    if box is not None:
        box[label] = (int(ra.min()), int(c0.min()), int(ra.max()), int(c1.max()) - 1)


def close_gaps(np, grid):
    """The server generalises each sub-catchment on its own, so two
    neighbours can leave a cell or two between them that is neither's.
    A cell with no label between two that have one, across or down, takes
    the first — twice, for a gap two cells wide."""
    for _ in range(2):
        for axis in (1, 0):
            g = grid
            a = g[:, :-2] if axis == 1 else g[:-2, :]
            m = g[:, 1:-1] if axis == 1 else g[1:-1, :]
            b = g[:, 2:] if axis == 1 else g[2:, :]
            fill = (m == 0) & (a != 0) & (b != 0)
            m[fill] = a[fill]


# ── Tracing ───────────────────────────────────────────────────────────────────
# A region of cells, as rings of grid vertices with the region on the left:
# anticlockwise outer rings, clockwise holes, in the map's own sense once the
# rows are turned into latitudes. Where two cells of the region touch only at
# a corner, the walk turns left, so each is its own ring.

E_, N_, W_, S_ = (0, 1), (-1, 0), (0, -1), (1, 0)       # (d row, d col)
LEFT = {E_: N_, N_: W_, W_: S_, S_: E_}
RIGHT = {v: k for k, v in LEFT.items()}


def trace(np, mask):
    rows, cols = mask.shape
    out = {}

    def add(ii, jj, d, di0, dj0):
        for i, j in zip(ii.tolist(), jj.tolist()):
            a = (i + di0, j + dj0)
            out.setdefault(a, []).append(d)

    up, dn = mask[:-1, :], mask[1:, :]
    ii, jj = np.nonzero(up & ~dn); add(ii, jj, E_, 1, 0)       # region above: eastward
    ii, jj = np.nonzero(dn & ~up); add(ii, jj, W_, 1, 1)       # region below: westward
    lf, rt = mask[:, :-1], mask[:, 1:]
    ii, jj = np.nonzero(rt & ~lf); add(ii, jj, S_, 0, 1)       # region east: southward
    ii, jj = np.nonzero(lf & ~rt); add(ii, jj, N_, 1, 1)       # region west: northward

    rings = []
    while out:
        start = next(iter(out))
        v, ring, heading = start, [], None
        while True:
            dirs = out.get(v)
            if not dirs:
                break
            if heading is None or len(dirs) == 1:
                d = dirs[0]
            else:
                d = next((t for t in (LEFT[heading], heading, RIGHT[heading]) if t in dirs), dirs[0])
            dirs.remove(d)
            if not dirs:
                del out[v]
            if d != heading:
                ring.append(v)               # a corner; straight runs need no vertex
            heading = d
            v = (v[0] + d[0], v[1] + d[1])
            if v == start:
                break
        if len(ring) >= 4:
            rings.append(ring)
    return rings


def shoelace(pts):
    a = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        a += x0 * y1 - x1 * y0
    return a / 2


TOL_DIV = 1500           # the box's diagonal over this, for the big ones — never under
                         # 0.8 of a cell, so the staircase goes and the shape stays
MIN_TOL = 0.003          # deg — nor under this: the fine catchments are cut on the
                         # Geofabric's ~250 m grid too, whatever grid they are burnt into
SMOOTH_SMALL = 1.0       # deg of diagonal: a catchment smaller is corner-cut twice
SMOOTH_MEDIUM = 4.0      # …smaller than this once, and bigger not at all — it is only
                         # ever seen from far enough out that its steps do not show
MIN_ISLAND = 40          # cells — a scrap of the region smaller than this is noise
# Holes are filled, whatever their size. Inside a catchment they are the
# pockets the Geofabric says drain nowhere — a claypan, a sink in the karst —
# and a catchment drawn with them punched out reads as a broken shape, not as
# hydrology. The area quoted is still the sub-catchments' own, without them.
MIN_HOLE = float('inf')
RATIO_LO, RATIO_HI = 0.6, 1.6   # the sub-catchments' area against the stream's own, to be believed


def shape_of_mask(np, mask, g, r0, c0):
    """The rings of a mask whose cell (0, 0) is cell (r0, c0) of grid g, in
    lon, lat, simplified; and their box. The mask is padded here, so a region
    touching its edge still closes."""
    padded = np.zeros((mask.shape[0] + 2, mask.shape[1] + 2), dtype=bool)
    padded[1:-1, 1:-1] = mask
    raw = trace(np, padded)
    if not raw:
        return []
    # Vertex (i, j) of the padded mask is the corner at row r0 + i - 1, col c0 + j - 1.
    rings = []
    for ring in raw:
        pts = [(g.w + (c0 + j - 1) * g.res, g.n - (r0 + i - 1) * g.res) for i, j in ring]
        rings.append((shoelace(pts) / (g.res * g.res), pts))
    biggest = max(a for a, _ in rings)
    keep = [(a, p) for a, p in rings
            if (a > 0 and (a >= MIN_ISLAND or a == biggest)) or (a < 0 and -a >= MIN_HOLE)]
    if not any(a > 0 for a, _ in keep):
        return []
    w = min(p[0] for _, ps in keep for p in ps); e = max(p[0] for _, ps in keep for p in ps)
    s = min(p[1] for _, ps in keep for p in ps); n = max(p[1] for _, ps in keep for p in ps)
    diag = math.hypot(e - w, n - s)
    tol = max(MIN_TOL, 0.8 * g.res, diag / TOL_DIV)
    passes = 2 if diag < SMOOTH_SMALL else 1 if diag < SMOOTH_MEDIUM else 0
    out = []
    for a, pts in sorted(keep, key=lambda ap: -abs(ap[0])):
        closed = [list(p) for p in pts] + [list(pts[0])]
        simple = br.simplify(closed, tol)
        if len(simple) >= 4:
            out.append(chaikin(simple, passes))
    return out, [round(w, 4), round(s, 4), round(e, 4), round(n, 4)]


def chaikin(ring, passes):
    """Corner-cutting, `passes` times, on a closed ring: each edge keeps its
    middle half. The Geofabric's boundaries are cut on its ~250 m grid, so
    even simplified they are staircases a few cells long, which read as a
    machine's line and not a watershed's; this rounds them off, never moving
    a boundary by more than a quarter of the edge it is on."""
    pts = ring[:-1]
    for _ in range(passes):
        nxt = []
        for i, (x0, y0) in enumerate(pts):
            x1, y1 = pts[(i + 1) % len(pts)]
            nxt.append([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1])
            nxt.append([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1])
        pts = nxt
    return pts + [pts[0]]


def outline(np, grid, lut, box, extra=None):
    """The rings of the national grid's cells whose label is in `lut`, inside
    box (r0, c0, r1, c1) — and, when `extra` is given, of those fine
    catchments' rings too, burnt into the same cells."""
    r0, c0, r1, c1 = box
    r0, c0 = max(r0 - 1, 0), max(c0 - 1, 0)
    r1, c1 = min(r1 + 2, ROWS), min(c1 + 2, COLS)
    mask = lut[grid[r0:r1, c0:c1]]
    if extra:
        g = Grid(W + c0 * GRID_DEG, N - r0 * GRID_DEG, GRID_DEG, r1 - r0, c1 - c0)
        more = np.zeros((r1 - r0, c1 - c0), dtype=np.uint8)
        for rings in extra:
            burn(np, more, 1, rings, None, g)
        mask = mask | (more > 0)
    return shape_of_mask(np, mask, NATIONAL, r0, c0)


def fine_outline(np, ring_sets):
    """The rings of a catchment made of fine catchments alone, burnt into a
    grid of its own at FINE_DEG."""
    pts = [p for rings in ring_sets for ring in rings for p in ring]
    if not pts:
        return []
    w = min(p[0] for p in pts) - 2 * FINE_DEG
    n = max(p[1] for p in pts) + 2 * FINE_DEG
    cols = int((max(p[0] for p in pts) + 2 * FINE_DEG - w) / FINE_DEG) + 1
    rows = int((n - min(p[1] for p in pts) + 2 * FINE_DEG) / FINE_DEG) + 1
    g = Grid(w, n, FINE_DEG, rows, cols)
    arr = np.zeros((rows, cols), dtype=np.uint8)
    for rings in ring_sets:
        burn(np, arr, 1, rings, None, g)
    close_gaps(np, arr)
    return shape_of_mask(np, arr > 0, g, 0, 0)


# ── Which sub-catchments ──────────────────────────────────────────────────────

def river_key(s):
    """map-river-lines.js's riverKey, for the same names."""
    s = re.sub(r'[^a-z0-9]+', ' ', str(s or '').lower()).strip()
    s = re.sub(r'\b(ck|crk)\b', 'creek', s)
    s = re.sub(r'\b(rv|riv)\b', 'river', s)
    s = re.sub(r' r$', ' river', s)
    s = re.sub(r'\bsth\b', 'south', s)
    s = re.sub(r'\bnth\b', 'north', s)
    s = re.sub(r'\bbr\b', 'branch', s)
    return re.sub(r'\bmt\b', 'mount', s)


class Network:
    def __init__(self, cats):
        self.cats = cats                       # [{cid, out, inn, area}], label = index + 1
        self.index = {c['cid']: i for i, c in enumerate(cats)}
        self.into = {}
        for i, c in enumerate(cats):
            if c['out'] is not None:
                self.into.setdefault(c['out'], []).append(i)

    def above_cat(self, i):
        """Sub-catchment i and everything draining into it."""
        seen, stack = set(), [i]
        while stack:
            j = stack.pop()
            if j in seen:
                continue
            seen.add(j)
            node = self.cats[j]['inn']
            if node is not None:
                stack.extend(self.into.get(node, ()))
        return seen

    def above_node(self, node):
        seen = set()
        for i in self.into.get(node, ()):
            if i not in seen:
                seen |= self.above_cat(i)
        return seen

    def area(self, members):
        return sum(self.cats[i]['area'] for i in members)

    def best(self, i, target):
        """The catchment above a reach in sub-catchment i whose own drainage
        area is `target` km²: everything draining into i with i, or without
        it — whichever is nearer the target — and None when neither is near
        it at all. A small creek wholly inside a big river's sub-catchment is
        the case that check is for: both answers there are the river's."""
        cands = [self.above_cat(i)]
        inn = self.cats[i]['inn']
        if inn is not None:
            ex = self.above_node(inn)
            if ex:
                cands.append(ex)
        pick = min(cands, key=lambda m: abs(self.area(m) - target))
        if target <= 0 or not RATIO_LO <= self.area(pick) / target <= RATIO_HI:
            return None
        return pick


def nearest_segment(np, by_key, key, lat, lon, max_km):
    """The segment of this name nearest a point, within max_km, or None."""
    group = by_key.get(key)
    if not group:
        return None
    pts, owner = group
    k = math.cos(math.radians(lat))
    d = np.hypot((pts[:, 0] - lon) * k, pts[:, 1] - lat) * 111.32
    i = int(np.argmin(d))
    return owner[i] if d[i] <= max_km else None


def main():
    import numpy as np

    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--cache', help='keep (and reuse) the raw pages here')
    ap.add_argument('--rivers-cache', help="build_rivers.py's --cache, for the rivers' segments")
    ap.add_argument('--out', default=os.path.join(REPO, 'data', 'catchments-au'))
    ap.add_argument('--bucket', type=int, default=32)
    a = ap.parse_args()
    for d in (a.cache, a.rivers_cache):
        if d:
            os.makedirs(d, exist_ok=True)

    print('rivers…', file=sys.stderr)
    segs, _ = br.fetch(a.rivers_cache)
    found = br.assemble(segs, br.MIN_AREA)
    seg2cat = segment_catchments(a.cache)
    nodes = gauged_nodes(a.cache)

    print('sub-catchments…', file=sys.stderr)
    grid = np.zeros((ROWS, COLS), dtype=np.uint16)
    cats, boxes = [], {}
    for feats in catchment_pages(a.cache):
        for f in feats:
            at, g = f.get('attributes') or {}, f.get('geometry') or {}
            if at.get('ConCatID') is None:
                continue
            cats.append({'cid': at['ConCatID'], 'out': at.get('ConNodeID'), 'inn': at.get('FConNodeID'),
                         'area': (at.get('AlbersArea') or 0) / 1e6})
            burn(np, grid, len(cats), g.get('rings') or [], boxes)
    print(f'  {len(cats)} burnt; closing gaps…', file=sys.stderr)
    close_gaps(np, grid)
    net = Network(cats)

    def region_box(members):
        bs = [boxes[i + 1] for i in members if (i + 1) in boxes]
        if not bs:
            return None
        return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))

    os.makedirs(a.out, exist_ok=True)
    for old in os.listdir(a.out):
        if old.endswith('.json'):
            os.remove(os.path.join(a.out, old))

    with open(os.path.join(REPO, 'stations.json'), encoding='utf-8') as f:
        stations = json.load(f)['stations']
    by_no = {}
    for n in nodes:
        by_no.setdefault(n['no'], n)
    seg_by_id = {s['id']: s for s in segs}
    by_key = {}
    for s in segs:
        k = river_key(s['name'])
        pts = [p for path in s['paths'] for p in path]
        g = by_key.setdefault(k, ([], []))
        g[0].extend(pts)
        g[1].extend([s['id']] * len(pts))
    by_key = {k: (np.asarray(p, dtype=np.float64), o) for k, (p, o) in by_key.items()}

    # ── First, the sub-catchments' answer — and what they cannot answer.
    # A river: everything above the sub-catchment its lowest reach is in. A
    # station at a gauged node: everything above the node. A station on a
    # named stream: above the reach it stands on, to the nearer sub-catchment
    # boundary — a fallback, which the fine catchments below replace.
    print('catchments from the sub-catchments…', file=sys.stderr)
    river_res, station_res, fine_want, gauge_ratio = {}, {}, [], []
    for rid, r in enumerate(found):
        cat, target = None, 0
        for m in sorted(r['members'], key=lambda m: -m['area']):
            cat = net.index.get(seg2cat.get(m['id']))
            if cat is not None:
                target = m['area']
                break
        members = net.best(cat, target) if cat is not None else None
        if members:
            river_res[rid] = ('coarse', members, None)
        else:
            outlet = max(r['members'], key=lambda m: m['area'])
            fine_want.append(('r', rid, outlet['id'], outlet['area']))
    done = sorted((s for s in stations if s.get('lat') is not None and s.get('lon') is not None),
                  key=lambda s: str(s['id']))
    for s in done:
        sid = str(s['id'])
        n = by_no.get(str(s.get('awrc_number') or '').strip())
        if n:
            members = net.above_node(n['node'])
            if members:
                station_res[sid] = ('gauge', n['no'], ('coarse', members, None))
                if n['area'] > 0:
                    gauge_ratio.append(net.area(members) / n['area'])
                continue
        if not s.get('stream'):
            continue
        seg_id = nearest_segment(np, by_key, river_key(s['stream']), s['lat'], s['lon'], 3.0)
        if seg_id is None:
            continue
        target = seg_by_id[seg_id]['area']
        fine_want.append(('s', sid, seg_id, target))
        cat = net.index.get(seg2cat.get(seg_id))
        members = net.best(cat, target) if cat is not None else None
        if members:
            station_res[sid] = ('near', '', ('coarse', members, None))

    # ── Then the fine catchments, where they can do better: every fine
    # catchment above the reach's own, inside its sub-catchment — and, where
    # that falls short of the reach's drainage area because the reach is on
    # the sub-catchment's main stem, everything above the sub-catchment's
    # inlet as well. Believed only within RATIO_LO..RATIO_HI of the area the
    # network gives the reach.
    print(f'fine catchments for {len(fine_want)} rivers and stations…', file=sys.stderr)
    drains = {r['HydroID']: r.get('DrainID') for r in
              by_ids(STREAM_URL, 'HydroID', {w[2] for w in fine_want}, 'HydroID,DrainID', a.cache, 'drains')}
    ends = {w[2]: seg_by_id[w[2]]['paths'][-1][-1] for w in fine_want}
    fine, ups, tiles_done = {}, {}, set()

    def take_tiles(keys):
        todo = sorted(k for k in keys if k not in tiles_done)
        for key, feats in zip(todo, parallel(lambda k: fine_tile(a.cache, k), todo, 'tiles')):
            tiles_done.add(key)
            for f in feats:
                at = f.get('attributes') or {}
                h = at.get('HydroID')
                if h is None or h in fine:
                    continue
                fine[h] = {'next': at.get('NextDownID'), 'cid': at.get('ConCatID'),
                           'area': (at.get('AlbersArea') or 0) / 1e6}
                if fine[h]['next'] is not None:
                    ups.setdefault(fine[h]['next'], []).append(h)

    def fine_above(h0):
        cid, seen, stack = fine[h0]['cid'], set(), [h0]
        while stack:
            h = stack.pop()
            if h in seen:
                continue
            seen.add(h)
            stack.extend(u for u in ups.get(h, ()) if u in fine and fine[u]['cid'] == cid)
        return seen

    # Each reach is searched round outward: a box sized to the area the
    # network says drains to it, the fine catchments in it read, everything
    # above the reach's own traced — and the box grown by half while that falls
    # short and is still growing. A reach on its sub-catchment's main stem
    # stops growing at the sub-catchment's edge; the rest is the
    # sub-catchments' own, below.
    pending = []
    for w in fine_want:
        kind, key, seg_id, target = w
        if target <= 0 or drains.get(seg_id) is None:
            continue
        if kind == 's' and key in station_res and station_res[key][0] == 'gauge':
            continue
        if target > FINE_MAX_AREA:
            continue
        pending.append([w, min(FINE_MAX_HALF, max(0.03, math.sqrt(target) / 111.32 * 0.5)), -1.0])
    traced = {}
    while pending:
        keys = set()
        for w, half, _ in pending:
            x, y = ends[w[2]]
            for tx in range(math.floor((x - half) / FINE_TILE), math.floor((x + half) / FINE_TILE) + 1):
                for ty in range(math.floor((y - half) / FINE_TILE), math.floor((y + half) / FINE_TILE) + 1):
                    keys.add((tx, ty))
        print(f'  {len(pending)} reaches, {len(keys - tiles_done)} tiles to read', file=sys.stderr)
        take_tiles(keys)
        nxt = []
        for w, half, last in pending:
            h0 = drains[w[2]]
            if h0 not in fine:
                if half < FINE_MAX_HALF:
                    nxt.append([w, min(FINE_MAX_HALF, half * 1.6), last])
                continue
            up = fine_above(h0)
            area = sum(fine[h]['area'] for h in up)
            if area >= 0.95 * w[3] or area <= last + 1e-9 or half >= FINE_MAX_HALF:
                traced[(w[0], w[1])] = (w, up, area)
            else:
                nxt.append([w, min(FINE_MAX_HALF, half * 1.6), area])
        pending = nxt
    print(f'  {len(fine)} fine catchments read in {len(tiles_done)} tiles', file=sys.stderr)

    fine_count = {'r': 0, 's': 0}
    for (kind, key), (w, up, area) in traced.items():
        target, h0 = w[3], drains[w[2]]
        coarse = set()
        if not RATIO_LO <= area / target <= RATIO_HI:
            ci = net.index.get(fine[h0]['cid'])
            inn = cats[ci]['inn'] if ci is not None else None
            coarse = net.above_node(inn) if inn is not None else set()
            if not coarse or not RATIO_LO <= (area + net.area(coarse)) / target <= RATIO_HI:
                continue
        res = ('fine', up, coarse)
        if kind == 'r':
            river_res[key] = res
        else:
            station_res[key] = ('reach', '', res)
        fine_count[kind] += 1

    # Rings only for the fine catchments an answer is made of.
    needed = set()
    for res in list(river_res.values()) + [v[2] for v in station_res.values()]:
        if res[0] == 'fine':
            needed |= res[1]
    print(f'  rings for {len(needed)} fine catchments…', file=sys.stderr)
    rings_of = fine_rings(a.cache, needed)

    # ── The outlines.
    def shape(res):
        how, members, coarse = res
        if how == 'coarse':
            box = region_box(members)
            if not box:
                return None
            lut = np.zeros(65536, dtype=bool)
            lut[[i + 1 for i in members]] = True
            got = outline(np, grid, lut, box)
            area = net.area(members)
        else:
            rings = [rings_of[h] for h in members if rings_of.get(h)]
            if not rings:
                return None
            area = sum(fine[h]['area'] for h in members) + net.area(coarse)
            if coarse:
                box = list(region_box(coarse))
                pts = [p for rs in rings for ring in rs for p in ring]
                box[0] = min(box[0], int((N - max(p[1] for p in pts)) / GRID_DEG))
                box[2] = max(box[2], int((N - min(p[1] for p in pts)) / GRID_DEG))
                box[1] = min(box[1], int((min(p[0] for p in pts) - W) / GRID_DEG))
                box[3] = max(box[3], int((max(p[0] for p in pts) - W) / GRID_DEG))
                lut = np.zeros(65536, dtype=bool)
                lut[[i + 1 for i in coarse]] = True
                got = outline(np, grid, lut, tuple(box), extra=rings)
            else:
                got = fine_outline(np, rings)
        if not got or not got[0]:
            return None
        rings, bbox = got
        return {'area': round(area, 1) if area < 100 else round(area), 'box': bbox,
                'rings': [br.encode(r)[0] for r in rings]}

    print('outlines…', file=sys.stderr)
    river_index, buckets, ratios = [], {}, []
    for rid, r in enumerate(found):
        sh = shape(river_res[rid]) if rid in river_res else None
        if not sh:
            river_index.append(None)
            continue
        b = rid // a.bucket
        buckets.setdefault(f'r{b}', {})[str(rid)] = sh
        river_index.append([sh['area'], b])
        if r['area'] > 0:
            ratios.append(sh['area'] / r['area'])
        if rid % 500 == 0:
            print(f'  {rid}/{len(found)}', file=sys.stderr)

    station_index, how_count, k_station, by_sig = {}, {}, 0, {}
    for s in done:
        sid = str(s['id'])
        if sid not in station_res:
            continue
        how, no, res = station_res[sid]
        sig = res[0] + ':' + hashlib.sha1(','.join(map(str, sorted(res[1]))).encode()).hexdigest()
        if sig not in by_sig:
            by_sig[sig] = shape(res)
        sh = by_sig[sig]
        if not sh:
            continue
        b = k_station // a.bucket
        buckets.setdefault(f's{b}', {})[sid] = sh
        station_index[sid] = [sh['area'], b, how, no]
        how_count[how] = how_count.get(how, 0) + 1
        k_station += 1

    total_bytes = 0
    for name, body in buckets.items():
        path = os.path.join(a.out, f'{name}.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(body, f, separators=(',', ':'))
        total_bytes += os.path.getsize(path)

    def median(v):
        v = sorted(v)
        return round(v[len(v) // 2], 3) if v else None

    doc = {
        'meta': {
            'source': 'Australian Hydrological Geospatial Fabric (Geofabric) v3.3, Hydrology Reporting '
                      'Catchments — AHGF Contracted Catchment and AHGF Node; Surface Hydrology Network',
            'publisher': 'Bureau of Meteorology',
            'licence': 'CC BY 4.0',
            'attribution': ATTRIBUTION,
            'service': CATCH_URL,
            'built': datetime.date.today().isoformat(),
            'built_by': 'tools/build_catchments.py',
            'sub_catchments': len(cats),
            'grid_deg': GRID_DEG,
            'rivers': sum(1 for r in river_index if r),
            'rivers_from_fine': fine_count['r'],
            'stations': how_count,
            'fine_catchments_read': len(fine),
            'river_area_ratio_median': median(ratios),
            'gauge_area_ratio_median': median(gauge_ratio),
            'quant': br.QUANT,
            'format': 'rivers: [area_km2, bucket] by the rivers file\'s index, or null; stations: '
                      '{id: [area_km2, bucket, how, station_no]}, how one of gauge (at a gauged node), '
                      'reach (traced up the fine catchments from the reach the station stands on) or '
                      'near (to the nearer sub-catchment boundary); r<bucket>.json and s<bucket>.json: '
                      '{key: {area, box: [w, s, e, n], rings: [encoded polyline, lat first, 1/quant '
                      'degree]}} — outer rings anticlockwise, holes clockwise, filled even-odd.',
        },
        'rivers': river_index,
        'stations': station_index,
    }
    with open(os.path.join(a.out, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(doc, f, separators=(',', ':'), ensure_ascii=False)
    print(f'{a.out}: {doc["meta"]["rivers"]} rivers, {how_count} stations, {len(buckets)} files, '
          f'{total_bytes / 1e6:.2f} MB; river area ratio median {doc["meta"]["river_area_ratio_median"]}, '
          f'gauge {doc["meta"]["gauge_area_ratio_median"]}', file=sys.stderr)


if __name__ == '__main__' and '--fetch-only' in sys.argv:
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True)
    ap.add_argument('--fetch-only', action='store_true')
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    print(len(gauged_nodes(a.cache)), 'gauged nodes', file=sys.stderr)
    print(len(segment_catchments(a.cache)), 'segments', file=sys.stderr)
    for _ in catchment_pages(a.cache):
        pass
elif __name__ == '__main__':
    main()
