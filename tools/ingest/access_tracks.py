#!/usr/bin/env python3
"""
access_tracks.py — read a Google Earth KML of GPS tracks driven to stations,
keep the part of each that is a way in, and load those into Flood-Net as the
stations' access tracks.

WHAT THIS IS
    A KML of GPS tracks recorded on the way to stations over twenty years,
    organised by somebody before it got here: a folder of tracks renamed to
    the station they went to (`39319_ABERCORN-TM_access_20140313` — bureau
    number, name, `access`, the day), a folder of the same cut out of longer
    drives that called at several stations, a folder of tracks nobody could
    tie to a station (`UNMATCHED_SPRINGBLUFF_20111213`), and a folder of the
    stations' pins as that organiser had them.

    A GPS left running does not record an access track. It records the day:
    the drive from the depot, a jump of a hundred kilometres where it was
    switched off at one town and on at the next — drawn as a straight line
    across the map — a first fix a kilometre out before the receiver settled,
    a run up the wrong road and back, the walk around the gauge, and the
    drive home. Loaded as it is, every one of those is a line on the map that
    somebody will one day try to follow.

WHAT IT KEEPS
    For each track and the station it belongs to, the one line that ends at
    the station and comes from somewhere — what somebody arriving needs:

    1. Points outside Australia go (two of Garmin's demonstration tracks are
       in the 2021 file), and so does any repeat of the point before it.
    2. A spike — one point far from both its neighbours while they are close
       to each other, a fix that jumped and came back — goes.
    3. The track is cut wherever the GPS was off. A straight segment longer
       than ROAD_CHECK_M near the station is put to Queensland Roads and
       Tracks (QRT, the State's own road and track network, CC BY 4.0). One
       that runs along a mapped road or track — near it and the same way — is
       a straight road between two fixes, and stays whatever its length. One
       that does not is a jump across country if it is longer than GAP_M or
       OFF_RATIO times the spacing around it: a receiver logging every
       kilometre along a farm track QRT does not have is not a jump. Where QRT has nothing to say
       (New South Wales, the far west, or --no-roads), a segment is a jump if
       it is longer than GAP_M: a kilometre's straight line between two fixes
       is as often a receiver logging sparsely as a receiver switched off,
       and there is nothing to tell them apart by.
    4. The piece of track (between jumps) that comes nearest the station's
       pin is where the track got to, and it has to come within NEAR_MAX_M.
       Beyond NEAR_OK_M the line is kept with a note saying how far short it
       stopped: a track that stops at the same place 700 m out three trips
       running is somebody parking at a locked gate, or a pin that is out —
       not a wrong track. If that piece is only the walk round the site, the
       next nearest piece is the way in, when it too ends within NEAR_MAX_M:
       the drive to the gate, and a jump from there to the gauge.
    5. From there the way in is walked back through the track — and the way
       out forward, for when the GPS was only switched on at the site — until
       it leaves WINDOW_M of the pin or meets a gap. The way in is kept unless
       the way out is clearly longer, reversed, so every line ends at its
       station. WINDOW_M is 0061's own limit: a site feature is within 10 km
       of its station.
    6. A run up a side road and back, a lap of a paddock, or the whole of an
       earlier visit to the site and the drive between, is taken out: where
       the line comes back within LOOP_M of where it already was, the part
       between goes. Then the line starts where it last turned towards
       the station: walking back from the site, once it has come closer again
       by DROP_M (or DROP_FRAC of the way) it was somewhere else first.
    7. The line ends where it first arrived at the site, not after the walk
       around it, and starts where the GPS stopped standing still. Points
       closer than THIN_M to the last one kept are dropped, then the line is
       simplified (Douglas-Peucker, DP_M, widened only as far as it has to
       be to fit 0061's 500 points).
    8. Shorter than MIN_LEN_M, it is not a way in to anywhere.
    9. Two trips over the same road are one access track. Longest first, a
       line that lies DUP_COVER of its length within DUP_BUFFER_M of the
       lines already kept for the station is a repeat, and goes: the longer
       of two trips up one road shows more of it. Two ways in from different
       directions are two access tracks, sharing their last stretch.

    A track in the unmatched folder is tied to a station only when its name
    says which and its line goes there: the name (less its date, and less
    anything after FROM or VIA) has to be a station's name, or one inside its
    brackets — the longest that fits, one station a place — and the track has
    to come within NEAR_OK_M of that station's pin (NEAR_MAX_M when the name
    is the station's, not merely like it) and stop within END_M of where it
    got to, turn round there, or pass within PASS_M of the pin. A name that
    is no station the track goes to stays unmatched.

    The organiser's own pins (the fourth folder) are not loaded: Flood-Net's
    register is the pin. Where the two disagree, the report says so.

WHERE IT GOES
    `meganet.station_feature`, kind `access_track` (0067), one row a line,
    placed `gps`, named "Access track <date>", with a note saying where it
    came from and what was done to it, ending in the import's tag. Editors
    read them and nobody else does (0061's RLS): an access track is a route
    across somebody's land to a locked gate, and it is not for this public
    repository either. So this file carries no tracks: the KML is read from
    wherever it was saved, and everything written goes to --out, which has to
    be outside the checkout.

    --out gets:
      features.json   every line kept, as the database will hold it
      load.sql        one insert of them all, for psql, refusing to run if any
                      row already carries this import's tag
      chunks/         the same for a connection that cannot carry a 1.4 MB
                      statement (the Supabase MCP one) — load.py's #159 route:
                      setup.sql makes a staging table and a stage function
                      gated on a secret minted for this emission;
                      tools/ingest/apply_chunks.py --dir DIR/chunks posts the
                      data to it over HTTPS; sync.sql moves it into
                      station_feature in one call, checking the count, the
                      tag and the 10 km; cleanup.sql drops the scaffolding.
      report.md       what was kept, and every track left out and why
      roads.json      QRT's roads round each long segment, so a rerun asks
                      again only about what is new

    Either route needs 0067 first. Undo an import with
      delete from meganet.station_feature where note like '%[access-tracks:<tag>]';

USAGE
    python3 tools/ingest/access_tracks.py TRACKS.kml --out DIR
        [--tag 2021-gpx] [--stations stations.json] [--no-roads]

    Without --stations the register is read over the app's own public REST,
    as the page reads it. Standard library only, like the rest of tools/.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures
import datetime
import difflib
import json
import math
import os
import re
import secrets
import ssl
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

KML_NS = '{http://www.opengis.net/kml/2.2}'
QRT_URL = ('https://spatial-gis.information.qld.gov.au/arcgis/rest/services/'
           'Transportation/RoadsAndTracks/MapServer/10/query')

# Mainland Australia and Tasmania, generously. The stations are Queensland's
# and northern New South Wales's; this only has to catch a track in Kansas.
AUS = (112.0, 154.7, -44.5, -9.0)            # lon min, lon max, lat min, lat max

WINDOW_M = 10000      # 0061: a site feature is within 10 km of its station
ROAD_CHECK_M = 800    # a straight segment this long near a station is put to QRT
ROAD_BUFFER_M = 100   # ...and follows a road if this close to one
ROAD_COVER = 0.7      # ...over this much of its length
ROAD_ANGLE = 25       # ...running within this many degrees of the segment's way
GAP_M = 2000          # off any road, or where QRT has nothing: this long is the GPS off
OFF_RATIO = 3         # off any road, this many times the spacing around it is too
SPIKE_M = 150         # a point this far from both neighbours, which are close, is a bad fix
NEAR_OK_M = 300       # a track that gets this close to the pin got there
NEAR_MAX_M = 1000     # ...and one that stops short of this is somewhere else
PASS_M = 50           # an unmatched track this close to a pin named for went there
END_M = 500           # ...and so did one that stops this close to where it got to
ARRIVE_M = 30         # arrived: within this of the closest the track came
LOOP_M = 20           # back within this of where it was is a loop or a spur
LOOP_MIN_M = 150      # ...if it went at least this far in between
DROP_M = 500          # coming closer again by this much, walking back from the
DROP_FRAC = 0.35      # site, or this much of the way, is somewhere else first
STILL_M = 25          # standing still at the start: every point within this of the first
THIN_M = 10           # closer than this to the last point kept adds nothing
DP_M = 3.0            # Douglas-Peucker tolerance, widened only to fit MAX_POINTS
MAX_POINTS = 500      # 0061's limit for a line
MIN_LEN_M = 150       # shorter is not a way in
DUP_BUFFER_M = 40     # two GPS tracks of one road are within this of each other
DUP_COVER = 0.85      # ...over this much of the shorter one's length

NAME_RE = re.compile(r'^(\d+)_(.+)_access_(\d{8})(?:_(\d+))?$')
UNMATCHED_RE = re.compile(r'^UNMATCHED_(.+)_(\d{8})$')


# ── Ground ───────────────────────────────────────────────────────────────────

def hav(a, b):
    """Metres between two (lon, lat) points on the sphere."""
    r = 6371008.8
    la1, lo1, la2, lo2 = map(math.radians, (a[1], a[0], b[1], b[0]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


class Flat:
    """Metres east and north of a point — 0061's own flat earth
    (station_feature_reach_m), good to well under a metre at 10 km."""

    def __init__(self, origin):
        self.lon0, self.lat0 = origin
        self.kx = 111320.0 * math.cos(math.radians(self.lat0))
        self.ky = 110574.0

    def xy(self, p):
        return ((p[0] - self.lon0) * self.kx, (p[1] - self.lat0) * self.ky)

    def r(self, p):
        x, y = self.xy(p)
        return math.hypot(x, y)


def seg_dist(p, a, b):
    """Distance from p to the segment ab, all (x, y) in metres."""
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return math.hypot(p[0] - ax, p[1] - ay)
    t = max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2))
    return math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy))


def length_m(pts):
    return sum(hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def douglas_peucker(xy, tol):
    """Indices of the points kept, first and last always."""
    keep = [False] * len(xy)
    keep[0] = keep[-1] = True
    stack = [(0, len(xy) - 1)]
    while stack:
        i, j = stack.pop()
        best, at = -1.0, -1
        for k in range(i + 1, j):
            d = seg_dist(xy[k], xy[i], xy[j])
            if d > best:
                best, at = d, k
        if best > tol:
            keep[at] = True
            stack.append((i, at))
            stack.append((at, j))
    return [k for k, v in enumerate(keep) if v]


def coverage(a_xy, b_xy, buffer_m):
    """How much of line a's length lies within buffer_m of line b."""
    if len(a_xy) < 2 or len(b_xy) < 2:
        return 0.0
    tot = inside = 0.0
    for i in range(len(a_xy) - 1):
        p, q = a_xy[i], a_xy[i + 1]
        seg = math.hypot(q[0] - p[0], q[1] - p[1])
        n = max(1, int(seg // 20))
        for s in range(n):
            t = (s + 0.5) / n
            m = (p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]))
            tot += seg / n
            if any(seg_dist(m, b_xy[j], b_xy[j + 1]) <= buffer_m for j in range(len(b_xy) - 1)):
                inside += seg / n
    return inside / tot if tot else 0.0


# ── Reading ──────────────────────────────────────────────────────────────────

def read_kml(path):
    """Every LineString placemark as {folder, name, coords} and every Point
    as {folder, name, coord}, in document order."""
    root = ET.parse(path).getroot()
    lines, points = [], []

    def walk(el, folder):
        for child in el:
            tag = child.tag.replace(KML_NS, '')
            if tag in ('Document', 'Folder'):
                nm = (child.findtext(KML_NS + 'name') or '').strip()
                walk(child, nm if tag == 'Folder' and nm else folder)
            elif tag == 'Placemark':
                nm = (child.findtext(KML_NS + 'name') or '').strip()
                for ls in child.iter(KML_NS + 'LineString'):
                    coords = []
                    for tok in (ls.findtext(KML_NS + 'coordinates') or '').split():
                        parts = tok.split(',')
                        if len(parts) >= 2:
                            coords.append((float(parts[0]), float(parts[1])))
                    lines.append({'folder': folder, 'name': nm, 'coords': coords})
                for pt in child.iter(KML_NS + 'Point'):
                    parts = (pt.findtext(KML_NS + 'coordinates') or '').strip().split(',')
                    if len(parts) >= 2:
                        points.append({'folder': folder, 'name': nm,
                                       'coord': (float(parts[0]), float(parts[1]))})

    walk(root, '')
    return lines, points


def https_context():
    return ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE') or None)


def app_defaults():
    """DB_ORIGIN and DB_ANON_KEY as core.js states them — the public values
    every browser uses."""
    with open(os.path.join(REPO, 'core.js'), encoding='utf-8') as f:
        src = f.read()
    url = re.search(r"const DB_ORIGIN\s*=\s*'([^']+)'", src)
    key = re.search(r"const DB_ANON_KEY\s*=\s*'([^']+)'", src)
    if not url or not key:
        raise SystemExit('could not read DB_ORIGIN / DB_ANON_KEY out of core.js — pass --stations')
    return url.group(1), key.group(1)


def fetch_stations():
    """The register, over the app's own public REST."""
    origin, key = app_defaults()
    rows, offset = [], 0
    while True:
        url = (f'{origin}/rest/v1/station?select=id,name,station_number,lat,lon,deleted_at'
               f'&order=id&limit=1000&offset={offset}')
        req = urllib.request.Request(url, headers={'apikey': key, 'Accept-Profile': 'meganet'})
        with urllib.request.urlopen(req, context=https_context(), timeout=60) as r:
            page = json.load(r)
        rows += page
        if len(page) < 1000:
            return rows
        offset += 1000


def bureau_key(n):
    """A station number less its leading zeros — meganet.bureau_key()."""
    n = (n or '').strip()
    return n.lstrip('0') or n


# ── Roads ────────────────────────────────────────────────────────────────────

def seg_key(a, b):
    return '%.5f,%.5f,%.5f,%.5f' % (a[0], a[1], b[0], b[1])


def qrt_paths(a, b):
    """QRT's roads and tracks within a padded box round the segment a→b, as
    lists of (lon, lat). An empty list is QRT having nothing there."""
    pad = 0.003
    env = '%.6f,%.6f,%.6f,%.6f' % (min(a[0], b[0]) - pad, min(a[1], b[1]) - pad,
                                   max(a[0], b[0]) + pad, max(a[1], b[1]) + pad)
    q = urllib.parse.urlencode({
        'geometry': env, 'geometryType': 'esriGeometryEnvelope', 'inSR': 4326,
        'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'objectid',
        'returnGeometry': 'true', 'outSR': 4326, 'geometryPrecision': 6,
        'maxAllowableOffset': 0.00005, 'f': 'json'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(QRT_URL + '?' + q, context=https_context(), timeout=60) as r:
                d = json.load(r)
            if 'error' in d:
                raise RuntimeError(d['error'])
            return [p for f in d.get('features', []) for p in f['geometry'].get('paths', [])]
        except Exception:                                   # noqa: BLE001 — retried, then said
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def road_verdict(a, b, paths):
    """'road' if a→b runs along QRT, 'off' if QRT has roads there and a→b
    does not follow them, 'unknown' if QRT has nothing there. Along, not
    near: in a town every line is within 100 m of a street, so the road has
    to run the segment's way (within ROAD_ANGLE degrees) as well."""
    if not paths:
        return 'unknown'
    flat = Flat(a)
    sxy = [flat.xy(a), flat.xy(b)]
    dx, dy = sxy[1][0] - sxy[0][0], sxy[1][1] - sxy[0][1]
    seg = math.hypot(dx, dy)
    if seg == 0:
        return 'road'
    segs = []
    for p in paths:
        xy = [flat.xy(q) for q in p]
        for i in range(len(xy) - 1):
            u, v = xy[i], xy[i + 1]
            ux, uy = v[0] - u[0], v[1] - u[1]
            un = math.hypot(ux, uy)
            if un == 0:
                continue
            cos = abs(ux * dx + uy * dy) / (un * seg)
            if cos >= math.cos(math.radians(ROAD_ANGLE)):
                segs.append((u, v))
    n = max(2, int(seg // 50))
    hit = 0
    for k in range(n):
        t = (k + 0.5) / n
        m = (sxy[0][0] + t * dx, sxy[0][1] + t * dy)
        if any(seg_dist(m, u, v) <= ROAD_BUFFER_M for u, v in segs):
            hit += 1
    return 'road' if hit / n >= ROAD_COVER else 'off'


class Roads:
    """QRT's roads round each long segment, kept in roads.json between runs."""

    def __init__(self, path, enabled):
        self.path, self.enabled = path, enabled
        self.cache, self.verdicts = {}, {}
        if path and os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                self.cache = {k: v for k, v in json.load(f).items() if isinstance(v, list)}

    def resolve(self, segments):
        if not self.enabled:
            return
        todo = {seg_key(a, b): (a, b) for a, b in segments if seg_key(a, b) not in self.cache}
        if not todo:
            return
        print(f'asking QRT about {len(todo)} long segments…', file=sys.stderr)
        done = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futs = {pool.submit(qrt_paths, a, b): k for k, (a, b) in todo.items()}
            for fut in concurrent.futures.as_completed(futs):
                k = futs[fut]
                a, b = todo[k]
                try:
                    self.cache[k] = [[[round(x, 6), round(y, 6)] for x, y in p] for p in fut.result()]
                except Exception as e:                      # noqa: BLE001
                    print(f'  QRT failed for {k}: {e}', file=sys.stderr)
                done += 1
                if done % 200 == 0:
                    print(f'  {done}/{len(todo)}', file=sys.stderr)
                    self.save()
        self.save()

    def save(self):
        if self.path:
            with open(self.path, 'w', encoding='utf-8') as f:
                json.dump(self.cache, f, sort_keys=True, separators=(',', ':'))

    def verdict(self, a, b):
        k = seg_key(a, b)
        if not self.enabled or k not in self.cache:
            return 'unknown'
        if k not in self.verdicts:
            self.verdicts[k] = road_verdict(a, b, self.cache[k])
        return self.verdicts[k]


# ── Names ────────────────────────────────────────────────────────────────────

ABBREV = [('CREEK', 'CK'), ('ROAD', 'RD'), ('MOUNT', 'MT'), ('CROSSING', 'XING'),
          ('BRIDGE', 'BR'), ('LOOKOUT', 'LKT'), ('DRIVE', 'DV'), ('SOUTH', 'STH'),
          ('NORTH', 'NTH'), ('MAC', 'MC')]
SUFFIXES = ('ALERT', 'AL', 'TM', 'DERM', 'NEW', 'B')


def squash(s):
    s = re.sub(r'[^A-Z0-9]', '', s.upper())
    for a, b in ABBREV:
        s = s.replace(a, b)
    return s


def strip_suffix(s):
    changed = True
    while changed:
        changed = False
        for suf in SUFFIXES:
            if len(s) > len(suf) + 3 and s.endswith(suf):
                s, changed = s[:-len(suf)], True
    return s


def track_key(raw):
    """What an unmatched track's name says it went to: less FROM… and VIA…,
    less a year, less TM/AL/DERM."""
    s = re.sub(r'[^A-Z0-9]', '', raw.upper())
    s = re.split(r'FROM|VIA', s)[0] or s
    s = re.sub(r'(19|20)\d\d$', '', s)
    return strip_suffix(squash(s))


def station_keys(name):
    """The names a station answers to: its own less AL/TM, and each name in
    its brackets."""
    keys = set()
    keys.add(strip_suffix(squash(re.sub(r'\(.*?\)', ' ', name))))
    for inner in re.findall(r'\(([^)]*)\)', name):
        k = strip_suffix(squash(inner))
        if len(k) >= 5:
            keys.add(k)
    return {k for k in keys if len(k) >= 4}


def name_match(tkey, skeys):
    """How well a track's key names a station: (score, span in the track key)
    or None. Exact beats the station's name inside the track's (a track named
    for two stations), beats the track's inside the station's, beats close."""
    best = None
    for k in skeys:
        if tkey == k:
            m = (4, len(k), (0, len(tkey)))
        elif len(k) >= 5 and k in tkey:
            i = tkey.index(k)
            m = (3, len(k), (i, i + len(k)))
        elif len(tkey) >= 5 and tkey in k:
            m = (2, len(tkey), (0, len(tkey)))
        elif difflib.SequenceMatcher(None, tkey, k).ratio() >= 0.85:
            m = (1, len(k), (0, len(tkey)))
        else:
            continue
        if best is None or m[:2] > best[:2]:
            best = m
    return best


# ── Cleaning ─────────────────────────────────────────────────────────────────

def in_aus(p):
    return AUS[0] <= p[0] <= AUS[1] and AUS[2] <= p[1] <= AUS[3]


def despike(c):
    """Repeats and one-point excursions out of a track: (coords, n removed)."""
    out = []
    for p in c:
        if not out or p != out[-1]:
            out.append(p)
    removed = len(c) - len(out)
    changed = True
    while changed and len(out) >= 3:
        changed = False
        keep = [out[0]]
        for i in range(1, len(out) - 1):
            a, p, b = keep[-1], out[i], out[i + 1]
            dap, dpb, dab = hav(a, p), hav(p, b), hav(a, b)
            if dap > SPIKE_M and dpb > SPIKE_M and dab < 0.25 * min(dap, dpb):
                removed += 1
                changed = True
            else:
                keep.append(p)
        keep.append(out[-1])
        out = keep
    return out, removed


def long_segments(c, pin):
    """The segments of c longer than ROAD_CHECK_M with an end inside the window."""
    flat = Flat(pin)
    return [(c[i], c[i + 1]) for i in range(len(c) - 1)
            if hav(c[i], c[i + 1]) > ROAD_CHECK_M
            and min(flat.r(c[i]), flat.r(c[i + 1])) <= WINDOW_M]


def gaps(c, roads):
    """{i: why} for each segment c[i] → c[i+1] that is the GPS having been
    off, and a count of the long ones QRT vouched for."""
    seg = [hav(c[i], c[i + 1]) for i in range(len(c) - 1)]

    def spacing(i):
        around = sorted(seg[j] for j in range(max(0, i - 6), min(len(seg), i + 7)) if j != i)
        return max(around[len(around) // 2], 20.0) if around else None

    out, on_road = {}, 0
    for i, s in enumerate(seg):
        if s <= ROAD_CHECK_M:
            continue
        v = roads.verdict(c[i], c[i + 1]) if s > ROAD_CHECK_M else 'unknown'
        if v == 'road':
            on_road += 1
            continue
        sp = spacing(i)
        if s > GAP_M:
            out[i] = 'off' if v == 'off' else 'long'
        elif v == 'off':
            if sp is None or s > OFF_RATIO * sp:
                out[i] = 'off'
    return out, on_road


def leg(c, k, step, flat, gap_at):
    """Indices from k walking by step (-1 back, +1 forward) while inside the
    window and not across a gap. An earlier visit to the site is in it, and
    erase_loops() takes it out with everything between the two."""
    idx, i = [k], k
    while True:
        j = i + step
        if j < 0 or j >= len(c) or min(i, j) in gap_at or flat.r(c[j]) > WINDOW_M:
            break
        idx.append(j)
        i = j
    return idx


def erase_loops(pts, flat):
    """The line with every return to where it already was cut out: a spur up
    a side road and back, a lap of a paddock. pts run towards the station."""
    xy = [flat.xy(p) for p in pts]
    cum = [0.0]
    for i in range(1, len(xy)):
        cum.append(cum[-1] + math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]))
    out, i, n = [], 0, len(xy)
    while i < n:
        out.append(i)
        nxt = i + 1
        for j in range(n - 1, i + 1, -1):
            if cum[j] - cum[i] < LOOP_MIN_M:
                break
            if seg_dist(xy[i], xy[j - 1], xy[j]) <= LOOP_M:
                nxt = j
                break
        i = nxt
    return [pts[i] for i in out]


def last_approach(pts, flat):
    """The line from where it last turned towards the station. pts run
    towards the station."""
    r = [flat.r(p) for p in pts]
    far, at = r[-1], len(pts) - 1
    for i in range(len(pts) - 1, -1, -1):
        if r[i] > far:
            far, at = r[i], i
        elif far - r[i] > max(DROP_M, DROP_FRAC * far):
            return pts[at:], True
    return pts, False


def tidy_line(pts, flat, near):
    """Cut at first arrival, the standing-still start dropped, thinned and
    simplified. pts run towards the station."""
    arrive = max(near + ARRIVE_M, ARRIVE_M * 2)
    for i, p in enumerate(pts):
        if flat.r(p) <= arrive:
            pts = pts[:i + 1]
            break
    s = 0
    while s + 1 < len(pts) and hav(pts[0], pts[s + 1]) <= STILL_M:
        s += 1
    pts = pts[s:]
    thin = [pts[0]]
    for p in pts[1:-1]:
        if hav(thin[-1], p) >= THIN_M:
            thin.append(p)
    if len(pts) > 1:
        if len(thin) > 1 and hav(thin[-1], pts[-1]) < THIN_M:
            thin[-1] = pts[-1]
        else:
            thin.append(pts[-1])
    if len(thin) < 2:
        return thin, 0.0
    xy = [flat.xy(p) for p in thin]
    tol = DP_M
    while True:
        keep = douglas_peucker(xy, tol)
        if len(keep) <= MAX_POINTS:
            return [thin[k] for k in keep], tol
        tol *= 1.25


def f_near(c, pos):
    return min(hav(pos, p) for p in c)


def fmt_m(m):
    return f'{m / 1000:.1f} km' if m >= 1000 else f'{round(m)} m'


def extract(c, gap_at, st):
    """The way in to one station from one cleaned track: (feature, None), or
    (None, why not). The piece nearest the pin first, then the next."""
    pin = (float(st['lon']), float(st['lat']))
    flat = Flat(pin)
    if len(c) < 2:
        return None, 'fewer than two usable points'
    rs = [flat.r(p) for p in c]
    pieces, start = [], 0
    for i in range(len(c) - 1):
        if i in gap_at:
            pieces.append((start, i))
            start = i + 1
    pieces.append((start, len(c) - 1))
    nearest = [(min(range(a, b + 1), key=lambda i: rs[i]), a, b) for a, b in pieces]
    nearest.sort(key=lambda x: rs[x[0]])
    first_why = None
    for n, (k, a, b) in enumerate(nearest):
        if rs[k] > NEAR_MAX_M:
            if first_why and (a > 0 or b < len(c) - 1) and n == 1:
                return None, (f'the GPS jumps straight to the site across country, from a track that '
                              f'stops {fmt_m(rs[k])} out')
            break
        f, why = extract_at(c, gap_at, st, flat, rs, k, a, b)
        if f is not None:
            if first_why:
                f['after_jump'] = True
            return f, None
        first_why = first_why or why
    if first_why:
        return None, first_why
    return None, f'never gets within {fmt_m(NEAR_MAX_M)} of the pin — the closest it comes is {fmt_m(min(rs))}'


def extract_at(c, gap_at, st, flat, rs, k, a, b):
    """The way in from c[k], the nearest point of the piece c[a..b]."""
    pin = (float(st['lon']), float(st['lat']))
    near = rs[k]
    back = leg(c, k, -1, flat, gap_at)
    fwd = leg(c, k, +1, flat, gap_at)
    way_in = [c[i] for i in reversed(back)]
    way_out = [c[i] for i in reversed(fwd)]
    lin, lout = length_m(way_in), length_m(way_out)
    use_out = lout > 1.25 * lin and lout - lin > 200
    turned = (lin > 300 and lout > 300
              and coverage([flat.xy(p) for p in way_out], [flat.xy(p) for p in way_in], DUP_BUFFER_M) >= 0.6)
    ends_here = min(hav(c[a], c[k]), hav(c[b], c[k])) <= END_M
    pts = way_out if use_out else way_in
    pts = erase_loops(pts, flat)
    pts, trimmed = last_approach(pts, flat)
    line, tol = tidy_line(pts, flat, near)
    L = length_m(line) if len(line) >= 2 else 0.0
    if len(line) < 2 or L < MIN_LEN_M:
        if L < 1:
            return None, 'nothing reaches the station but a point or two at the site — too short to show a way in'
        return None, f'what reaches the station is only {fmt_m(L)} — too short to show a way in'
    return {
        'station_id': st['id'], 'station_name': st['name'], 'pin': pin, 'line': line,
        'length_m': L, 'reach_m': max(flat.r(p) for p in line), 'near_m': near,
        'points': len(line), 'tolerance_m': tol, 'direction': 'out' if use_out else 'in',
        'destination': ends_here or turned or near <= PASS_M, 'detour_trimmed': trimmed,
        'after_jump': False,
    }, None


# ── The run ──────────────────────────────────────────────────────────────────

def iso(d8):
    return f'{d8[:4]}-{d8[4:6]}-{d8[6:]}'


def human_date(d8):
    try:
        d = datetime.date(int(d8[:4]), int(d8[4:6]), int(d8[6:]))
        return f'{d.day} {d.strftime("%b %Y")}'
    except ValueError:
        return iso(d8)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Access tracks from a KML of GPS tracks, cleaned, for Flood-Net.')
    ap.add_argument('kml')
    ap.add_argument('--out', required=True, help='a directory outside this checkout')
    ap.add_argument('--stations', help='the register as JSON (id, name, station_number, lat, lon, deleted_at)')
    ap.add_argument('--tag', default='2021-gpx', help='names this import in every note, for undoing it')
    ap.add_argument('--source', help='what the notes call the file (default: its name)')
    ap.add_argument('--no-roads', action='store_true', help='do not ask QRT; judge gaps by length alone')
    args = ap.parse_args(argv)

    out = os.path.realpath(args.out)
    if out == REPO or out.startswith(REPO + os.sep):
        raise SystemExit('--out is inside the checkout: access tracks are not for a public repository')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,39}', args.tag):
        raise SystemExit('--tag is lower-case letters, digits and hyphens')
    os.makedirs(out, exist_ok=True)
    source = args.source or os.path.basename(args.kml)

    lines, points = read_kml(args.kml)
    if args.stations:
        with open(args.stations, encoding='utf-8') as f:
            stations = json.load(f)
    else:
        stations = fetch_stations()
    live = [s for s in stations if not s.get('deleted_at')]
    pinned = [s for s in live if s.get('lat') is not None and s.get('lon') is not None]
    by_num = collections.defaultdict(list)
    for s in live:
        if s.get('station_number'):
            by_num[bureau_key(s['station_number'])].append(s)
    organiser_pin = {}
    for p in points:
        m = re.search(r'\((\d+)\)\s*$', p['name'])
        if m:
            organiser_pin[bureau_key(m.group(1))] = p['coord']

    # Pass 1: which station(s) each track is for.
    log, work = [], []
    for t in lines:
        e = {'name': t['name'], 'folder': t['folder'], 'points': len(t['coords']),
             'length_m': length_m(t['coords']), 'left_out': None, 'notes': [], 'stations': []}
        log.append(e)
        aus = [p for p in t['coords'] if in_aus(p)]
        if not aus:
            e['left_out'] = 'nowhere in Australia'
            continue
        if len(aus) < len(t['coords']):
            e['notes'].append(f'{len(t["coords"]) - len(aus)} points outside Australia dropped')
        clean, spikes = despike(aus)
        if spikes:
            e['notes'].append(f'{spikes} repeated or stray points dropped')
        m, u = NAME_RE.match(t['name']), UNMATCHED_RE.match(t['name'])
        if m:
            num, date, part = bureau_key(m.group(1)), m.group(3), m.group(4)
            sts = by_num.get(num, [])
            if not sts:
                e['left_out'] = f'station {num} is not in Flood-Net'
                continue
            sts = [s for s in sts if s.get('lat') is not None and s.get('lon') is not None]
            if not sts:
                e['left_out'] = f'station {num} has no pin in Flood-Net'
                continue
            st = sts[0]
            op = organiser_pin.get(num)
            if op and hav(op, (float(st['lon']), float(st['lat']))) > 200:
                e['organiser_pin_m'] = hav(op, (float(st['lon']), float(st['lat'])))
            work.append((t, e, clean, date, part, [(st, 'number', None)]))
        elif u:
            date, tkey = u.group(2), track_key(u.group(1))
            lo, hi = min(p[0] for p in clean) - 0.01, max(p[0] for p in clean) + 0.01
            la, ha = min(p[1] for p in clean) - 0.01, max(p[1] for p in clean) + 0.01
            cands = []
            for s in pinned:
                pos = (float(s['lon']), float(s['lat']))
                if not (lo <= pos[0] <= hi and la <= pos[1] <= ha):
                    continue
                nm = name_match(tkey, station_keys(s['name']))
                if nm is None:
                    continue
                d = min(hav(pos, p) for p in clean)
                if d <= NEAR_OK_M or (nm[0] >= 2 and d <= NEAR_MAX_M):
                    cands.append((nm, d, s))
            # Best name first: which of these it went to is settled once the
            # ways in are known (pass 3).
            cands.sort(key=lambda x: (-x[0][0], -x[0][1], x[1]))
            if not cands:
                named = [(min(hav((float(s['lon']), float(s['lat'])), p) for p in clean), s) for s in pinned
                         if (name_match(tkey, station_keys(s['name'])) or (0,))[0] >= 2]
                named = [x for x in named if x[0] <= 20000]
                if named:
                    d, s = min(named, key=lambda x: x[0])
                    e['left_out'] = (f'not tied to a station — its name ({u.group(1)}) is {s["name"]}\'s, but it '
                                     f'comes no closer than {fmt_m(d)} to that pin')
                else:
                    e['left_out'] = (f'not tied to a station — its name ({u.group(1)}) is no station in '
                                     f'Flood-Net near where it goes')
                continue
            work.append((t, e, clean, date, None, [(s, 'name and place', nm[2]) for nm, d, s in cands]))
        else:
            e['left_out'] = 'a name this does not read'

    # Pass 2: QRT on every long segment near a station the tracks are for.
    roads = Roads(os.path.join(out, 'roads.json'), not args.no_roads)
    want = []
    for t, e, clean, date, part, targets in work:
        for st, how, span in targets:
            want += long_segments(clean, (float(st['lon']), float(st['lat'])))
    roads.resolve(want)

    # Pass 3: the way in, for each.
    candidates = []
    for t, e, clean, date, part, targets in work:
        gap_at, on_road = gaps(clean, roads)
        e['gaps'] = collections.Counter(gap_at.values())
        e['on_road'] = on_road
        # An unmatched track's candidates, best name first: the first that the
        # track goes to takes its part of the name, then any other station
        # named by another part of it (a drive named for three), one station a
        # place. A candidate passed over says why only if nothing was taken.
        spans, taken, missed = [], [], []
        for st, how, span in targets:
            pos = (float(st['lon']), float(st['lat']))
            if span is not None:
                if any(span[0] < y and x < span[1] for x, y in spans):
                    continue
                if any(hav(pos, (float(o['lon']), float(o['lat']))) < 300 for o in taken):
                    continue
            f, why = extract(clean, gap_at, st)
            row = {'station': st['name'], 'id': st['id'], 'how': how, 'kept': f is not None, 'why': why}
            if f is not None and how == 'name and place' and not f['destination']:
                f = None
                row['kept'] = False
                row['why'] = (f'passes {fmt_m(f_near(clean, pos))} from it without stopping or turning round '
                              f'— a name match, not a destination')
            if f is None:
                (missed if span is not None else e['stations']).append(row)
                continue
            if span is not None:
                spans.append(span)
                taken.append(st)
            e['stations'].append(row)
            f.update(track=t['name'], date=date, part=part or '', how=how, folder=t['folder'],
                     source_len_m=e['length_m'], organiser_pin_m=e.get('organiser_pin_m'))
            candidates.append((f, row))
        if missed and not taken:
            e['stations'].append(missed[0])

    # Pass 4: repeats, longest first, per station.
    groups = collections.defaultdict(list)
    for f, row in candidates:
        groups[f['station_id']].append((f, row))
    features = []
    for sid, group in groups.items():
        group.sort(key=lambda x: (x[0]['length_m'], x[0]['date'], x[0]['part'], x[0]['track']), reverse=True)
        flat = Flat(group[0][0]['pin'])
        kept = []
        for f, row in group:
            xy = [flat.xy(p) for p in f['line']]
            cov = [(coverage(xy, [flat.xy(p) for p in g['line']], DUP_BUFFER_M), g) for g in kept]
            best = max(cov, key=lambda x: x[0], default=(0.0, None))
            if best[0] >= DUP_COVER:
                row['kept'] = False
                row['why'] = (f'a repeat — {round(best[0] * 100)}% of it runs over the '
                              f'{iso(best[1]["date"])} track kept for the station')
                continue
            kept.append(f)
            row['feature'] = f
        features += kept

    # Names and notes.
    seen = collections.Counter()
    features.sort(key=lambda f: (f['station_id'], f['date'], f['part'], f['track']))
    for f in features:
        base = f'Access track {iso(f["date"])}'
        seen[(f['station_id'], base)] += 1
        n = seen[(f['station_id'], base)]
        f['name'] = base if n == 1 else f'{base} ({n})'
        bits = [f'GPS track recorded {human_date(f["date"])}, from {source} ({f["track"]}).']
        if f['how'] == 'name and place':
            bits.append('Not numbered in the file; tied to this station by its name and where it goes.')
        if f['direction'] == 'out':
            bits.append('Recorded leaving the site, and reversed.')
        if f['source_len_m'] - f['length_m'] > 500:
            bits.append(f'The last {fmt_m(f["length_m"])} into the station, of {fmt_m(f["source_len_m"])} recorded.')
        if f['after_jump']:
            bits.append(f'Stops {fmt_m(f["near_m"])} from the pin, where the GPS jumped straight to the site; '
                        'the last of the way is not recorded.')
        elif f['near_m'] > NEAR_OK_M:
            bits.append(f'Stops {fmt_m(f["near_m"])} from the pin: a locked gate and a walk, or a pin that is out.')
        bits.append(f'[access-tracks:{args.tag}]')
        f['note'] = ' '.join(bits)
        f['geom'] = {'type': 'LineString',
                     'coordinates': [[round(p[0], 7), round(p[1], 7)] for p in f['line']]}

    write_features(out, features)
    write_sql(out, args.tag, source, features)
    write_chunks(os.path.join(out, 'chunks'), args.tag, features)
    write_report(out, args.tag, source, features, log)
    print(f'{len(lines)} tracks read; {len(features)} access tracks kept at '
          f'{len({f["station_id"] for f in features})} stations; written to {out}')
    return 0


# ── Writing ──────────────────────────────────────────────────────────────────

def sql_text(s):
    return "'" + s.replace("'", "''") + "'"


def write_features(out, features):
    keys = ('station_id', 'station_name', 'name', 'note', 'geom', 'length_m', 'near_m', 'reach_m',
            'points', 'track', 'date', 'how', 'direction', 'detour_trimmed', 'after_jump', 'organiser_pin_m')
    with open(os.path.join(out, 'features.json'), 'w', encoding='utf-8') as fh:
        json.dump([{k: f.get(k) for k in keys} for f in features], fh, ensure_ascii=False, indent=1)


def write_sql(out, tag, source, features):
    actor = f'import:access-tracks:{tag}'
    marker = f'%[access-tracks:{tag}]'
    rows = ['(' + ', '.join([sql_text(f['station_id']), sql_text(f['name']), sql_text(f['note']),
                             sql_text(json.dumps(f['geom'], separators=(',', ':')))]) + ')'
            for f in features]
    with open(os.path.join(out, 'load.sql'), 'w', encoding='utf-8') as fh:
        fh.write(f'-- {len(features)} access tracks from {source}, import tag {tag}.\n'
                 '-- Written by tools/ingest/access_tracks.py; needs 0067. Refuses to run twice.\n'
                 'do $$ begin\n'
                 f'  if exists (select 1 from meganet.station_feature where note like {sql_text(marker)}) then\n'
                 f"    raise exception 'access tracks tagged {tag} are already loaded';\n"
                 '  end if;\n'
                 'end $$;\n'
                 'insert into meganet.station_feature (station_id, kind, name, note, geom, placed, created_by, updated_by)\n'
                 f"select v.station_id, 'access_track', v.name, v.note, meganet.station_feature_round(v.geom::jsonb), 'gps', "
                 f'{sql_text(actor)}, {sql_text(actor)}\n'
                 '  from (values\n    ' + ',\n    '.join(rows) + '\n  ) as v(station_id, name, note, geom);\n')


def write_chunks(directory, tag, features, chunk_rows=200):
    """The chunked route (see the module docstring): data as JSON files,
    control as three SQL files, and manifest.json for apply_chunks.py."""
    os.makedirs(directory, exist_ok=True)
    for old in os.listdir(directory):
        os.remove(os.path.join(directory, old))
    secret = secrets.token_hex(24)
    actor = f'import:access-tracks:{tag}'
    files = []
    for n in range(0, len(features), chunk_rows):
        rows = [[f['station_id'], f['name'], f['note'], f['geom']] for f in features[n:n + chunk_rows]]
        name = f'track-{n // chunk_rows + 1:03d}.json'
        with open(os.path.join(directory, name), 'w', encoding='utf-8') as fh:
            json.dump({'table': 'track', 'rows': rows}, fh, ensure_ascii=False, separators=(',', ':'))
        files.append({'file': name, 'table': 'track', 'rows': len(rows)})

    def write(name, text):
        with open(os.path.join(directory, name), 'w', encoding='utf-8') as fh:
            fh.write(text)

    write('setup.sql', f"""-- Access tracks, import tag {tag}: the chunked route's scaffolding.
-- Dropped again by cleanup.sql; the stage function exists for minutes.
drop schema if exists meganet_load_tracks cascade;
create schema meganet_load_tracks;
revoke all on schema meganet_load_tracks from public;

create unlogged table meganet_load_tracks.track (
  station_id text not null, name text not null, note text not null, geom jsonb not null);
alter table meganet_load_tracks.track enable row level security;

-- The gate: one secret for this emission, in a table nothing is granted on,
-- compared inside the one function anon may execute.
create table meganet_load_tracks.secret (value text not null);
alter table meganet_load_tracks.secret enable row level security;
insert into meganet_load_tracks.secret (value) values ('{secret}');

create or replace function meganet.access_tracks_stage(p_secret text, p_table text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $stage$
declare
  v_n integer;
begin
  if not exists (select 1 from meganet_load_tracks.secret s where s.value = p_secret) then
    raise exception 'access_tracks_stage: bad secret';
  end if;
  if p_table is distinct from 'track' then
    raise exception 'access_tracks_stage: unknown table %', p_table;
  end if;
  insert into meganet_load_tracks.track (station_id, name, note, geom)
  select r ->> 0, r ->> 1, r ->> 2, r -> 3 from pg_catalog.jsonb_array_elements(p_rows) as x(r);
  get diagnostics v_n = row_count;
  return v_n;
end
$stage$;
revoke all on function meganet.access_tracks_stage(text, text, jsonb) from public;
grant execute on function meganet.access_tracks_stage(text, text, jsonb) to anon;

-- The move, as one function so it is one transaction: the count staged, no
-- row of this tag already in, every line a station's and within 0061's 10 km.
create or replace function meganet.access_tracks_sync(p_expected integer, p_tag text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $sync$
declare
  v_staged integer;
  v_bad    text;
  v_n      integer;
begin
  select count(*) into v_staged from meganet_load_tracks.track;
  if v_staged <> p_expected then
    raise exception 'access_tracks_sync: % staged, % expected — stage every chunk first', v_staged, p_expected;
  end if;
  if exists (select 1 from meganet.station_feature f where f.note like '%[access-tracks:' || p_tag || ']') then
    raise exception 'access_tracks_sync: access tracks tagged % are already loaded', p_tag;
  end if;
  select string_agg(t.station_id || ' ' || t.name, ', ') into v_bad
    from meganet_load_tracks.track t
    left join meganet.station s on s.id = t.station_id and s.deleted_at is null
   where s.id is null
      or meganet.station_feature_geom_problem(t.geom) is not null
      or meganet.station_feature_reach_m(t.geom, s.lat, s.lon) > 10000;
  if v_bad is not null then
    raise exception 'access_tracks_sync: not a station''s, not a line, or past 10 km: %', v_bad;
  end if;
  insert into meganet.station_feature (station_id, kind, name, note, geom, placed, created_by, updated_by)
  select t.station_id, 'access_track', t.name, t.note, meganet.station_feature_round(t.geom), 'gps', p_actor, p_actor
    from meganet_load_tracks.track t;
  get diagnostics v_n = row_count;
  return pg_catalog.jsonb_build_object('staged', v_staged, 'inserted', v_n,
    'stations', (select count(distinct station_id) from meganet_load_tracks.track));
end
$sync$;
revoke all on function meganet.access_tracks_sync(integer, text, text) from public;

notify pgrst, 'reload schema';
""")
    write('sync.sql', f"""-- Run once apply_chunks.py reports every chunk staged. One call: all or nothing.
select meganet.access_tracks_sync({len(features)}, '{tag}', '{actor}') as result;
""")
    write('cleanup.sql', """-- Run last. Removes everything setup.sql made.
drop function if exists meganet.access_tracks_stage(text, text, jsonb);
drop function if exists meganet.access_tracks_sync(integer, text, text);
drop schema if exists meganet_load_tracks cascade;
notify pgrst, 'reload schema';
""")
    write('manifest.json', json.dumps({
        'rpc': 'access_tracks_stage', 'profile': 'meganet', 'secret': secret,
        'expected': {'track': len(features)}, 'files': files}, indent=2) + '\n')


REASONS = [  # (code, heading, what the rule is) — the report's sections, in order
    ('abroad', 'Nowhere in Australia',
     'Every point outside Australia.'),
    ('no_station', 'For a station Flood-Net does not have',
     'Numbered for a station that is not in the register, or has no pin.'),
    ('never_reaches', 'Never reaches the station',
     f'Never within {fmt_m(NEAR_MAX_M)} of the station\'s pin. Either the track is for somewhere else or '
     'the pin is out — worth a look at the pin where the organiser\'s own pin for it differs.'),
    ('jump', 'Reaches the station only by a jump',
     'The only line to the site is a straight jump across country (the GPS switched off and on), '
     f'from a track that stops more than {fmt_m(NEAR_MAX_M)} out.'),
    ('short', 'Too short to be a way in',
     f'What reaches the station is under {fmt_m(MIN_LEN_M)}: the GPS was switched on at the site.'),
    ('unmatched', 'Unnumbered, and not tied to a station',
     'No station in Flood-Net by its name that the track goes to.'),
    ('passes', 'Unnumbered, and only passes the station it is named for',
     f'The name fits, but the track goes past without stopping or turning round within {fmt_m(END_M)}.'),
    ('repeat', 'A repeat of another trip',
     f'{round(DUP_COVER * 100)}% or more of it runs within {DUP_BUFFER_M} m of a longer track kept for '
     'the same station.'),
]


def reason_code(why):
    for code, test in (('abroad', 'nowhere in Australia'), ('no_station', 'not in Flood-Net'),
                       ('no_station', 'has no pin'), ('never_reaches', 'never gets within'),
                       ('jump', 'jumps straight'), ('short', 'too short'), ('unmatched', 'not tied to'),
                       ('passes', 'without stopping'), ('repeat', 'a repeat')):
        if test in why:
            return code
    return 'other'


def write_report(out, tag, source, features, log):
    rows = []
    for e in log:
        if e['left_out']:
            rows.append({'track': e['name'], 'folder': e['folder'], 'station': '', 'kept': False,
                         'code': reason_code(e['left_out']), 'why': e['left_out'], 'entry': e})
            continue
        for s in e['stations']:
            rows.append({'track': e['name'], 'folder': e['folder'], 'station': s['station'], 'kept': s['kept'],
                         'code': 'kept' if s['kept'] else reason_code(s['why']), 'why': s.get('why') or '',
                         'feature': s.get('feature'), 'entry': e})
    with open(os.path.join(out, 'report.json'), 'w', encoding='utf-8') as fh:
        json.dump([{k: r[k] for k in ('track', 'folder', 'station', 'kept', 'code', 'why')} for r in rows],
                  fh, ensure_ascii=False, indent=1)

    kept = [r for r in rows if r['kept']]
    left = [r for r in rows if not r['kept']]
    stations = {f['station_id'] for f in features}
    by_code = collections.defaultdict(list)
    for r in left:
        by_code[r['code']].append(r)
    numbered = sum(1 for f in features if f['how'] == 'number')
    jumps = sum(sum(r['entry'].get('gaps', {}).values()) for r in kept)
    trimmed = sum(1 for f in features if f['source_len_m'] - f['length_m'] > 500)
    detours = sum(1 for f in features if f['detour_trimmed'])

    md = [f'# Access tracks from {source}', '',
          f'Import tag `{tag}` — every row it wrote ends its note with `[access-tracks:{tag}]`.', '',
          '| | |', '|---|---|',
          f'| Tracks in the file | {len(log)} |',
          f'| Access tracks kept | **{len(features)}**, at {len(stations)} stations |',
          f'| …from numbered tracks | {numbered} |',
          f'| …from unnumbered tracks, tied by name and place | {len(features) - numbered} |']
    for code, heading, _ in REASONS:
        if by_code.get(code):
            md.append(f'| Left out: {heading[0].lower() + heading[1:]} | {len(by_code[code])} |')
    md += ['', '## What was done to the ones kept', '',
           f'- Each is the last of the way into its station — at most {fmt_m(WINDOW_M)} out, Flood-Net\'s limit '
           f'for a site feature — ending where the track first arrived. {trimmed} were cut down from a longer '
           'drive.',
           f'- {jumps} straight-line jumps (the GPS off at one place, on at another) were found in the tracks kept, '
           'and nothing is drawn across one. A straight stretch over '
           f'{fmt_m(ROAD_CHECK_M)} was kept only where Queensland Roads and Tracks has a road running along it.',
           '- Stray fixes, runs up a side road and back, laps of a paddock and the walk round the gauge are gone; '
           f'{detours} lines also lost a drive somewhere else before the final approach.',
           f'- Simplified to the fewest points that stay within {DP_M:g} m of the GPS\'s line.', '']

    caution = [r for r in kept if r['feature']['near_m'] > NEAR_OK_M or r['feature']['after_jump']]
    if caution:
        md += ['## Kept, but stopping short of the pin', '',
               f'These end {fmt_m(NEAR_OK_M)}–{fmt_m(NEAR_MAX_M)} from the station\'s pin — a locked gate and a '
               'walk, or a pin that is out. Each one\'s note says so.', '',
               '| Station | Track | Stops | The organiser\'s pin from ours |', '|---|---|---|---|']
        for r in sorted(caution, key=lambda r: r['station']):
            f = r['feature']
            op = f.get('organiser_pin_m')
            md.append(f'| {r["station"]} | {r["track"]} | {fmt_m(f["near_m"])} | {fmt_m(op) if op else "—"} |')
        md.append('')

    md += ['## Left out', '']
    for code, heading, rule in REASONS:
        group = by_code.get(code)
        if not group:
            continue
        md += [f'### {heading} ({len(group)})', '', rule, '', '| Track | Station | Why |', '|---|---|---|']
        md += [f'| {r["track"]} | {r["station"] or "—"} | {r["why"]} |'
               for r in sorted(group, key=lambda r: (r['station'], r['track']))]
        md.append('')
    if by_code.get('other'):
        md += ['### Other', '', '| Track | Station | Why |', '|---|---|---|']
        md += [f'| {r["track"]} | {r["station"] or "—"} | {r["why"]} |' for r in by_code['other']]
        md.append('')

    md += ['## Kept', '', '| Station | Name | Track | Length | Points |', '|---|---|---|---|---|']
    for f in sorted(features, key=lambda f: (f['station_name'], f['name'])):
        md.append(f'| {f["station_name"]} | {f["name"]} | {f["track"]} | {fmt_m(f["length_m"])} | {f["points"]} |')
    with open(os.path.join(out, 'report.md'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(md) + '\n')

if __name__ == '__main__':
    sys.exit(main())
