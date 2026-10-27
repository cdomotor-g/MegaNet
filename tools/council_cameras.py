#!/usr/bin/env python3
"""
council_cameras.py — the flood and road cameras Queensland's councils (and a
few in NSW, the NT and WA) show on their disaster dashboards, gathered into the
one catalog the Stations map's flood and road cameras layer draws (map-cameras.js) and
the Worker's /api/cameras/* proxies the pictures for (worker/cameras.js).

PIPELINE POSITION
    QIT Plus's public list of the councils on its Guardian IMS dashboard
    (an ArcGIS layer: name, state, dashboard address)
        └─ each dashboard's own <dashboard>/dashboard/getCameras
           (GeoJSON: a point per camera, its name, its picture's address)
               └─ tools/council_cameras.py → data/council-cameras.json

    TMR's own flood cameras, as QLDTraffic's site reads them
        └─ data.qldtraffic.qld.gov.au/floodcameras.geojson   (into the same file)

    Weekly, by .github/workflows/council-cameras.yml, and by hand whenever a
    council is known to have added cameras. Standard library only; about 70
    small requests, one at a time, a minute or two end to end.

WHY THIS SOURCE
    Most Queensland councils' disaster dashboards are one product, QIT Plus's
    Guardian IMS, and every one of them answers the same question the same
    way: GET /dashboard/getCameras is the list behind the dashboard's own
    Flood Cameras page and its map — public, no key, no sign-in. So one reader
    covers ~55 councils, and a council that adds a camera to its dashboard
    adds it here at the next run. QIT Plus keeps the list of its dashboards
    on a public ArcGIS layer (the one dashboards.qitplus.com draws), which is
    where the councils come from rather than a list typed in here.

WHAT IT KEEPS — AND WHAT IT DOES NOT
    Where each camera is, what the council calls it, whether it is a flood
    camera or a road camera, the address of its latest picture (two or more
    for a camera that looks several ways), the council's note under it, and
    which council's dashboard to send a person to. Never a picture: those
    stay on the councils' and their vendors' servers, and the Worker fetches
    the latest one when somebody opens a camera. docs/council-cameras.md
    has the reasons and the numbers.

    A week in which no camera and no council changed writes nothing, so
    meta.generated is when the list last changed, not when it was last read.

    Left out: a feature with no point or a point outside Australia; a picture
    address that is not http(s); and the hosts in NOT_PICTURES, which serve
    something other than a camera's latest frame — an attachment uploaded to
    the dashboard behind a signed link that expires, a web page, a parked
    domain. The same picture on two councils' dashboards (a TMR camera on a
    shared highway, a Cape York camera every shire up there shows) is one
    camera, filed under the council whose area it stands in — QIT Plus's list
    carries each council's boundary, generalised to ~500 m — and naming the
    others.

    QLDTraffic's ~120 flood cameras go in beside them: TMR's own, on
    causeways and bridges, half of them on no council's dashboard. One that a
    council also shows from the dashboard's own copy of it (another address,
    the same camera, standing within SAME_POST_M and named for the same
    place) is the council's camera, credited to TMR — and given TMR's address
    in place of a Guardian IMS copy, which can fall weeks behind.

SAFETY
    A council whose dashboard does not answer keeps the cameras the last
    catalog had for it, marked with when it last answered, rather than
    vanishing from the map for a week because of one bad minute. And the run
    refuses to write a catalog that has lost more than 30% of the last one's
    cameras (QIT Plus moving the endpoint, say) — the job fails and says so
    instead of quietly emptying the layer. --force writes it anyway.

USAGE
    python3 tools/council_cameras.py                    # fetch, write data/council-cameras.json
    python3 tools/council_cameras.py --dry-run          # fetch and report, write nothing
    python3 tools/council_cameras.py --save-raw DIR     # also keep every answer in DIR
    python3 tools/council_cameras.py --from-raw DIR     # rebuild from a --save-raw DIR, no network
"""

import argparse
import datetime as dt
import html
import json
import math
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.path.join(REPO, 'data', 'council-cameras.json')

DIRECTORY_URL = (
    'https://services7.arcgis.com/si70weKpzPSa0BGV/arcgis/rest/services/'
    'QIT_Plus_LGA_Public/FeatureServer/0/query'
    '?where=g_ims%3D1&outFields=name,state,dash_url&returnGeometry=true'
    '&maxAllowableOffset=0.005&geometryPrecision=4&outSR=4326&f=json'
)
CAMERAS_PATH = '/dashboard/getCameras'

# TMR's flood cameras, as QLDTraffic's own site reads them: keyless, CORS-open,
# the same data as the documented API, which licenses it CC BY 4.0. Not a
# council, so marked as an agency: the viewer says "shown by QLDTraffic", not
# "from its disaster dashboard".
QLDTRAFFIC_URL = 'https://data.qldtraffic.qld.gov.au/floodcameras.geojson'
QLDTRAFFIC = {'key': 'qldtraffic', 'name': 'QLDTraffic (Transport and Main Roads)', 'short': 'QLDTraffic',
              'state': 'QLD', 'dashboard': 'https://qldtraffic.qld.gov.au/', 'agency': True}
TMR = 'Queensland Department of Transport and Main Roads (QLDTraffic)'

# Who is asking, and where to read why. Not a browser's name: nothing here is
# pretending to be a person at a dashboard.
USER_AGENT = 'Flood-Net council cameras catalog (+https://floodwarning.net/docs/council-cameras.md)'
TIMEOUT_S = 25
PAUSE_S = 0.4          # between councils — one request at a time, unhurried
MAX_LOSS = 0.30        # refuse a catalog that lost more than this share of cameras

# Australia, generously: a point outside it is a feature with no real place.
AU = {'s': -44.5, 'n': -9.0, 'w': 112.0, 'e': 154.5}

# Councils left out on purpose, by key, with why: a council that asks not to
# be shown is one line here (and its cameras are gone at the next run).
LEAVE_OUT = {}

# Hosts that answer with something other than a camera's latest picture.
NOT_PICTURES = {
    'ims-s3-upload.s3-ap-southeast-2.amazonaws.com': 'a file uploaded to the dashboard, behind a signed link that expires',
    'www.livetraffic.com': 'a Live Traffic NSW web page, not a picture',
    'qldtraffic.qld.gov.au': 'a QLDTraffic web page, not a picture',
    'www.usee.com': 'a parked domain',
}

# Hosts run by somebody other than the council: the picture is theirs, and is
# credited to them as well as to the council that shows it. The road agencies'
# cameras are road cameras whatever the dashboard calls them.
OPERATORS = {
    'cameras.qldtraffic.qld.gov.au': TMR,
    'roads-waterways.transport.nsw.gov.au': 'Transport for NSW (Live Traffic NSW)',
    'webcams.transport.nsw.gov.au': 'Transport for NSW (Live Traffic NSW)',
    'weathercams.airservicesaustralia.com': 'Airservices Australia (airport weather cameras)',
}
ROAD_HOSTS = {'cameras.qldtraffic.qld.gov.au', 'roads-waterways.transport.nsw.gov.au', 'webcams.transport.nsw.gov.au'}

# Hosts known to serve the same picture over https as over http.
UPGRADE_TO_HTTPS = {'cameras.qldtraffic.qld.gov.au'}
# Hosts whose query string is a cache-buster, not part of which picture it is.
DROP_QUERY = {'cameras.qldtraffic.qld.gov.au', 'camera-custom-image.s3-ap-southeast-2.amazonaws.com'}

# The Guardian IMS dashboards' own copies of TMR's pictures: the same camera at
# another address, and one that can fall behind TMR's (one was six weeks old
# while TMR's was minutes). Swapped for TMR's address when QLDTraffic has it.
MIRRORS = {'camera-custom-image.s3-ap-southeast-2.amazonaws.com'}
# A QLDTraffic camera and a council's this close, sharing a word of the place's
# name (not a road or a creek, a place), are one camera at two addresses.
SAME_POST_M = 30
PLACE_NOISE = {
    'road', 'highway', 'hwy', 'creek', 'crk', 'river', 'the', 'and', 'north', 'south', 'east', 'west',
    'bridge', 'bound', 'street', 'crossing', 'causeway', 'floodway', 'camera', 'near', 'view', 'development',
    'developmental', 'drive', 'lane', 'service', 'connection', 'overview', 'zoomed',
}

# Names QIT Plus's list gives that are not what the council calls itself.
NAME_FIXES = {
    'Weipa Town': 'Weipa Town Authority',
    'Palmerston Municipality': 'City of Palmerston',
}
GENERIC = re.compile(r'\b(regional|shire|city|council|municipality|town|aboriginal|of)\b', re.I)


def log(*a):
    print(*a, file=sys.stderr)


# ── Fetching ─────────────────────────────────────────────────────────────────

def get(url):
    """GET a URL, returning (bytes, final_url). Raises on failure."""
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S, context=ssl.create_default_context()) as r:
        return r.read(), r.geturl()


def get_json(url):
    """GET JSON, trying https first and the same address over http when the
    dashboard's TLS is broken (an incomplete certificate chain is the usual
    one). Returns (data, url_that_answered)."""
    tries = [url]
    if url.startswith('https://'):
        tries.append('http://' + url[len('https://'):])
    last = None
    for u in tries:
        for attempt in range(2):
            try:
                body, final = get(u)
            except urllib.error.HTTPError as e:
                # The server answered: the other scheme reaches the same one.
                if e.code >= 500 and attempt == 0:
                    time.sleep(1.5)
                    continue
                raise RuntimeError(f'HTTP {e.code}')
            except (ssl.SSLError, ssl.CertificateError) as e:
                last = e
                break                      # this scheme will not work; try the next
            except urllib.error.URLError as e:
                last = e
                if isinstance(e.reason, (ssl.SSLError, ssl.CertificateError)):
                    break
                if attempt == 0:
                    time.sleep(1.5)
                    continue
                break
            except OSError as e:           # a timeout, a reset mid-handshake
                last = e
                if attempt == 0:
                    time.sleep(1.5)
                    continue
                break
            try:
                return json.loads(body.decode('utf-8-sig')), final
            except ValueError:
                raise RuntimeError('answered, but not with JSON')
    reason = getattr(last, 'reason', last)
    if isinstance(reason, (ssl.SSLError, ssl.CertificateError)):
        raise RuntimeError('its certificate could not be verified, and plain http did not answer either')
    raise RuntimeError(f'{type(reason).__name__}: {reason}')


# ── Councils ─────────────────────────────────────────────────────────────────

def council_key(name):
    words = GENERIC.sub(' ', name).lower()
    return re.sub(r'[^a-z0-9]+', '-', words).strip('-')


def council_name(name, state):
    name = re.sub(r'\s+', ' ', name).strip()
    if name in NAME_FIXES:
        return NAME_FIXES[name]
    if re.search(r'\bcouncil\b|^(city|shire|town) of\b', name, re.I):
        return name
    return f'{name} Council'


def short_name(name):
    """What a link calls a council: "Lockyer Valley Regional Council" → "Lockyer
    Valley", "City of Moreton Bay" → "Moreton Bay"."""
    s = re.sub(r'^(city|shire|town) of\s+', '', name, flags=re.I)
    s = re.sub(r'\s+(aboriginal\s+)?((regional|shire|city|town)\s+)?(council|authority)$', '', s, flags=re.I)
    s = re.sub(r'\s+(regional|shire|city|municipality)$', '', s, flags=re.I)
    return s or name


def dashboard_url(u):
    """A dashboard's address, https where it was written http; None for
    anything that is not a web address at all."""
    u = (u or '').strip()
    if not re.match(r'^https?://[^\s/]+', u, re.I):
        return None
    if u.startswith('http://'):
        u = 'https://' + u[len('http://'):]
    return u.rstrip('/')


def councils_from_directory(directory, areas):
    out, seen = [], {}
    for f in directory.get('features') or []:
        a = f.get('attributes') or {}
        dash = dashboard_url(a.get('dash_url'))
        if not dash or not a.get('name'):
            continue
        key = council_key(a['name'])
        if key in LEAVE_OUT:
            continue
        if key in seen:                     # two councils, one slug: the state settles it
            key = f"{key}-{(a.get('state') or '').lower()}"
        seen[key] = True
        name = council_name(a['name'], a.get('state'))
        out.append({'key': key, 'name': name, 'short': short_name(name),
                    'state': a.get('state') or '', 'dashboard': dash})
        rings = ((f.get('geometry') or {}).get('rings')) or []
        if rings:
            areas.setdefault(key, []).extend(rings)
    out.sort(key=lambda c: c['key'])
    return out


def inside(rings, lat, lon):
    """Whether a point is in a council's area: even-odd over every ring, so a
    hole (another council inside this one) is not in it."""
    hit = False
    for ring in rings or []:
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
                hit = not hit
            j = i
    return hit


# ── Cameras ──────────────────────────────────────────────────────────────────

TAG = re.compile(r'<[^>]+>')
SPACE = re.compile(r'\s+')


def plain(text, cap=None):
    """A council's HTML note as one line of plain text."""
    if not text:
        return ''
    t = TAG.sub(' ', str(text))
    t = SPACE.sub(' ', html.unescape(t).replace(' ', ' ')).strip()
    if cap and len(t) > cap:
        t = t[:cap - 1].rsplit(' ', 1)[0] + '…'
    return t


def picture_url(raw):
    """A picture's address as kept, or None with the reason it is left out."""
    # A council that typed its address into an HTML field typed &amp; for &.
    u = html.unescape((raw or '').strip())
    if not re.match(r'^https?://', u, re.I):
        return None, 'not an http(s) address'
    p = urllib.parse.urlsplit(u)
    host = (p.hostname or '').lower()
    if not host:
        return None, 'no host'
    if host in NOT_PICTURES:
        return None, NOT_PICTURES[host]
    scheme = 'https' if (p.scheme.lower() == 'https' or host in UPGRADE_TO_HTTPS) else 'http'
    query = '' if host in DROP_QUERY else p.query
    return urllib.parse.urlunsplit((scheme, p.netloc.lower(), p.path, query, '')), None


WORDS = re.compile(r'^[A-Za-z][A-Za-z ,.&()\'-]{1,30}$')


def view_label(url, n, total):
    """What to call one of a camera's several pictures: its file's name where
    the council named it in words (South Bound.jpeg), else View n."""
    if total < 2:
        return ''
    stem = urllib.parse.unquote(urllib.parse.urlsplit(url).path.rsplit('/', 1)[-1])
    stem = re.sub(r'\.(jpe?g|png|gif|webp)$', '', stem, flags=re.I).replace('_', ' ').strip()
    if WORDS.match(stem) and not re.search(r'\d{3,}', stem):
        return stem
    return f'View {n + 1}'


def kind_of(type_name, hosts):
    t = (type_name or '').lower()
    if 'flood' in t:
        return 'flood'
    if 'traffic' in t or 'road' in t:
        return 'road'
    return 'road' if any(h in ROAD_HOSTS for h in hosts) else 'flood'


def in_au(lat, lon):
    return AU['s'] <= lat <= AU['n'] and AU['w'] <= lon <= AU['e']


def point_of(f):
    """A feature's (lat, lon), or None and why not."""
    g = f.get('geometry') or {}
    c = g.get('coordinates') if g.get('type') == 'Point' else None
    try:
        lon, lat = float(c[0]), float(c[1])
    except (TypeError, ValueError, IndexError):
        return None, 'no point'
    if not in_au(lat, lon) and in_au(lon, lat):
        lat, lon = lon, lat                # typed the wrong way round, as GeoJSON invites
    if not in_au(lat, lon):
        return None, f'a point outside Australia ({lat}, {lon})'
    return (lat, lon), None


def metres(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = (math.sin((lat2 - lat1) * r / 2) ** 2
         + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2)
    return 2 * 6371008.8 * math.asin(math.sqrt(a))


def cameras_of(council, collection, dropped):
    """The cameras on one council's dashboard."""
    out = []
    for i, f in enumerate(collection.get('features') or []):
        p = f.get('properties') or {}
        name = plain(p.get('description')) or plain(p.get('locality')) or 'Camera'
        at, why = point_of(f)
        if not at:
            dropped.append((council['key'], name, why))
            continue
        lat, lon = at
        urls = []
        for raw in str(p.get('image_url') or '').split(','):
            if not raw.strip():
                continue
            u, why = picture_url(raw)
            if u is None:
                dropped.append((council['key'], name, f'{raw.strip()[:80]} — {why}'))
            elif u not in urls:
                urls.append(u)
        if not urls:
            continue
        hosts = [urllib.parse.urlsplit(u).hostname for u in urls]
        fid = p.get('id')
        ident = f"{council['key']}-{fid if isinstance(fid, int) else i}"
        cam = {
            'id': ident,
            'council': council['key'],
            'name': name,
            'kind': kind_of(p.get('typeName'), hosts),
            'lat': round(lat, 6),
            'lon': round(lon, 6),
            'views': [{'url': u, 'label': view_label(u, n, len(urls))} for n, u in enumerate(urls)],
        }
        owner = next((OPERATORS[h] for h in hosts if h in OPERATORS), None)
        if owner:
            cam['owner'] = owner
        facing = plain(p.get('direction'), 24)
        if facing:
            cam['facing'] = facing
        note = plain(p.get('additional_detail'), 420)
        if note:
            cam['note'] = note
        if re.search(r'check image date', p.get('typeName') or '', re.I):
            cam['check_date'] = True
        out.append(cam)
    return out


def cameras_of_qldtraffic(collection, dropped):
    """TMR's flood cameras, from QLDTraffic's feed. Flood cameras all; TMR's
    unless the feed says a council supplied the picture."""
    out = []
    for i, f in enumerate(collection.get('features') or []):
        p = f.get('properties') or {}
        name = plain(p.get('description')) or plain(p.get('locality')) or 'Flood camera'
        at, why = point_of(f)
        if not at:
            dropped.append(('qldtraffic', name, why))
            continue
        u, why = picture_url(p.get('image_url'))
        if u is None:
            dropped.append(('qldtraffic', name, f'{str(p.get("image_url"))[:80]} — {why}'))
            continue
        fid = p.get('id')
        src = plain(p.get('image_sourced_from'))
        cam = {
            'id': f"qldtraffic-{fid if isinstance(fid, int) else i}",
            'council': 'qldtraffic',
            'name': name,
            'kind': 'flood',
            'lat': round(at[0], 6),
            'lon': round(at[1], 6),
            'views': [{'url': u, 'label': ''}],
            'owner': TMR if not src or re.search(r'transport|main roads|\btmr\b', src, re.I) else src,
        }
        facing = plain(p.get('direction'), 24)
        if facing:
            cam['facing'] = facing
        note = plain(p.get('extra_info'), 420)
        if note:
            cam['note'] = note
        out.append(cam)
    return out


def merge(cameras, areas):
    """One camera per picture: the same image on several dashboards is one
    camera, filed under a council whose area it stands in (the one listing the
    most of its views, then the first by key), else under the first by key, and
    naming the others."""
    groups, order = {}, []
    for cam in sorted(cameras, key=lambda c: (c['council'], natural(c['id']))):
        cam.pop('also', None)              # worked out afresh: a carried camera's may be stale
        first = cam['views'][0]['url']
        if first not in groups:
            groups[first] = []
            order.append(first)
        groups[first].append(cam)
    out = []
    for first in order:
        listed = groups[first]
        home_ones = [c for c in listed if inside(areas.get(c['council']), c['lat'], c['lon'])] or listed
        home = max(home_ones, key=lambda c: len(c['views']))      # max keeps the first of a tie
        others = sorted({c['council'] for c in listed} - {home['council']})
        if others:
            home['also'] = others
        # A flood camera to any of them is one; a picture somebody else owns is
        # theirs whichever listing said so.
        if any(c['kind'] == 'flood' for c in listed):
            home['kind'] = 'flood'
        owner = next((c['owner'] for c in listed if c.get('owner')), None)
        if owner and not home.get('owner'):
            home['owner'] = owner
        out.append(home)
    out = fold_same_post(out)
    out.sort(key=lambda c: (c['council'], natural(c['id'])))
    return out


def place_words(name):
    return {w for w in re.findall(r'[a-z]{3,}', name.lower()) if w not in PLACE_NOISE}


def fold_same_post(cameras):
    """QLDTraffic's camera of a crossing that a council shows from another
    address is the council's camera: kept under the council, naming
    QLDTraffic, credited to TMR when the picture is TMR's, and on TMR's own
    address when the council's is a Guardian IMS copy. One to one, nearest
    first, so two TMR cameras on one bridge do not fold into one."""
    mine = [c for c in cameras if c['council'] == 'qldtraffic' and not c.get('also')]
    theirs = [c for c in cameras if c['council'] != 'qldtraffic' and 'qldtraffic' not in (c.get('also') or [])]
    pairs = []
    for i, q in enumerate(mine):
        words = place_words(q['name'])
        for j, c in enumerate(theirs):
            d = metres(q['lat'], q['lon'], c['lat'], c['lon'])
            if d <= SAME_POST_M and words & place_words(c['name']):
                pairs.append((d, i, j))
    gone, taken = set(), set()
    for d, i, j in sorted(pairs):
        if i in gone or j in taken:
            continue
        q, c = mine[i], theirs[j]
        gone.add(i)
        taken.add(j)
        c['also'] = sorted(set(c.get('also') or []) | {'qldtraffic'})
        c['kind'] = 'flood'
        if q.get('owner') == TMR:
            c['owner'] = TMR
        first = c['views'][0]
        if urllib.parse.urlsplit(first['url']).hostname in MIRRORS:
            first['url'] = q['views'][0]['url']
    folded = {id(mine[i]) for i in gone}
    return [c for c in cameras if id(c) not in folded]


def natural(s):
    return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', s)]


# ── Writing ──────────────────────────────────────────────────────────────────

def dumps(catalog):
    """The catalog with a council or a camera per line, so a week's changes
    read as a diff of the cameras that changed."""
    def line(o):
        return json.dumps(o, ensure_ascii=False, separators=(', ', ': '))
    parts = ['{', f'  "meta": {line(catalog["meta"])},', '  "councils": [']
    parts += [f'    {line(c)}{"," if i < len(catalog["councils"]) - 1 else ""}'
              for i, c in enumerate(catalog['councils'])]
    parts += ['  ],', '  "cameras": [']
    parts += [f'    {line(c)}{"," if i < len(catalog["cameras"]) - 1 else ""}'
              for i, c in enumerate(catalog['cameras'])]
    parts += ['  ]', '}', '']
    return '\n'.join(parts)


def substance(catalog):
    """What a catalog says, without when it was made or when each council last
    answered: two weeks the same are one file, and the weekly job commits
    nothing."""
    councils = [{k: v for k, v in c.items() if k != 'answered'} for c in catalog.get('councils') or []]
    return json.dumps({'councils': councils, 'cameras': catalog.get('cameras') or []}, sort_keys=True)


def previous(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def build(args):
    raw_in = args.from_raw
    raw_out = args.save_raw
    if raw_out:
        os.makedirs(raw_out, exist_ok=True)

    # A rebuild from saved answers fails where the run that saved them did,
    # with that run's words — never with a path on the machine doing it.
    def fetch(name, url):
        if raw_in:
            try:
                with open(os.path.join(raw_in, f'{name}.json'), encoding='utf-8') as f:
                    saved = json.load(f)
            except (OSError, ValueError):
                raise RuntimeError('no saved answer')
            if 'error' in saved:
                raise RuntimeError(saved['error'])
            return saved['data'], saved['url']

        def keep(o):
            if raw_out:
                with open(os.path.join(raw_out, f'{name}.json'), 'w', encoding='utf-8') as f:
                    json.dump(o, f)
        try:
            data, final = get_json(url)
        except Exception as e:
            keep({'url': url, 'error': str(e)})
            raise
        keep({'url': final, 'data': data})
        return data, final

    old = previous(args.out) or {}
    old_councils = {c['key']: c for c in old.get('councils') or []}
    old_cams = {}
    for cam in old.get('cameras') or []:
        old_cams.setdefault(cam['council'], []).append(cam)

    areas = {}
    try:
        directory, _ = fetch('_directory', DIRECTORY_URL)
        councils = councils_from_directory(directory, areas)
        if not councils:
            raise RuntimeError('the list named no dashboards')
    except Exception as e:                  # the list is down: last week's councils will do
        if not old_councils:
            raise
        log(f'! QIT Plus\'s list of dashboards did not answer ({e}); using the last catalog\'s councils')
        councils = [{k: c[k] for k in ('key', 'name', 'short', 'state', 'dashboard') if k in c}
                    for c in old_councils.values() if not c.get('agency')]
    councils.append(dict(QLDTRAFFIC))

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    today = now.date().isoformat()
    cameras, dropped, report = [], [], []
    for n, council in enumerate(councils):
        if n and not raw_in:
            time.sleep(PAUSE_S)
        entry = dict(council)
        agency = council.get('agency')
        try:
            url = QLDTRAFFIC_URL if agency else council['dashboard'] + CAMERAS_PATH
            data, final = fetch(council['key'], url)
            if not isinstance(data, dict) or not isinstance(data.get('features'), list):
                raise RuntimeError('answered, but not with a list of cameras')
            if not agency and final.startswith('http://') and council['dashboard'].startswith('https://'):
                entry['dashboard'] = 'http://' + council['dashboard'][len('https://'):]
            mine = cameras_of_qldtraffic(data, dropped) if agency else cameras_of(council, data, dropped)
            entry['answered'] = today
            report.append(f'  {council["key"]:<28} {len(mine):>3} cameras')
        except Exception as e:
            was = old_councils.get(council['key']) or {}
            mine = old_cams.get(council['key'], [])
            entry['answered'] = was.get('answered')
            entry['error'] = str(e)[:200]
            report.append(f'  {council["key"]:<28} {len(mine):>3} cameras — did not answer ({e}); '
                          f'{"kept from " + str(was.get("answered")) if mine else "none kept"}')
        cameras.extend(mine)
        entry['cameras'] = len(mine)
        councils[n] = entry

    # Each council's count stays what its own dashboard shows, a camera it
    # shares with a neighbour included; the map draws that camera once.
    cameras = merge(cameras, areas)
    views = sum(len(c['views']) for c in cameras)
    catalog = {
        'meta': {
            'generated': now.isoformat().replace('+00:00', 'Z'),
            'tool': 'tools/council_cameras.py',
            'source': 'Each council\'s Guardian IMS disaster dashboard (/dashboard/getCameras), '
                      'the councils from QIT Plus\'s public list of its dashboards; and TMR\'s flood cameras '
                      'from QLDTraffic (floodcameras.geojson, CC BY 4.0)',
            'councils': sum(1 for c in councils if c['cameras'] and not c.get('agency')),
            'cameras': len(cameras),
            'views': views,
            'flood': sum(1 for c in cameras if c['kind'] == 'flood'),
            'road': sum(1 for c in cameras if c['kind'] == 'road'),
        },
        'councils': councils,
        'cameras': cameras,
    }
    return catalog, old, report, dropped


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--dry-run', action='store_true', help='fetch and report, write nothing')
    ap.add_argument('--force', action='store_true', help='write even if it lost more than 30%% of the cameras')
    ap.add_argument('--save-raw', metavar='DIR', help='keep every answer in DIR')
    ap.add_argument('--from-raw', metavar='DIR', help='rebuild from a --save-raw DIR, with no network')
    ap.add_argument('--out', default=OUT, help='where to write the catalog (default data/council-cameras.json)')
    args = ap.parse_args()

    catalog, old, report, dropped = build(args)
    m = catalog['meta']
    print('\n'.join(report))
    if dropped:
        print(f'\nLeft out ({len(dropped)}):')
        for key, name, why in dropped:
            print(f'  {key}: {name} — {why}')
    print(f'\n{m["cameras"]} cameras ({m["flood"]} flood, {m["road"]} road; {m["views"]} pictures) '
          f'from {m["councils"]} councils')

    had = len((old or {}).get('cameras') or [])
    if had and m['cameras'] < had * (1 - MAX_LOSS) and not args.force:
        print(f'\nREFUSED: {m["cameras"]} cameras against {had} in the last catalog — more than '
              f'{int(MAX_LOSS * 100)}% gone at once. Nothing written; --force writes it anyway.')
        return 2
    if args.dry_run:
        print('\n--dry-run: nothing written')
        return 0
    if old and substance(catalog) == substance(old):
        print('\nNo camera or council changed since the last catalog — nothing written.')
        return 0
    text = dumps(catalog)
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(text)
    print(f'\nWrote {os.path.relpath(args.out, REPO)} ({len(text.encode("utf-8")) // 1024} KB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
