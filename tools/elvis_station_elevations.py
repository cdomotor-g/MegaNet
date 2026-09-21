#!/usr/bin/env python3
"""
elvis_station_elevations.py — ask Geoscience Australia what the ground is under
every station, to fill the ones with no surveyed height and to audit the ones
that have one.

WHY THIS EXISTS
    840 of the 3,174 stations in stations.json carry an `elevation_ahd`. The
    other 2,334 carry nothing, and link-budget.js falls back to a ~30 m terrain
    tile for those ends — in EGM96, not AHD, which is the datum every other
    height in this file is in.

    Elvis (elevation.fsdf.org.au, Geoscience Australia / ICSM) answers in AHD
    off the best model the nation holds at a point. Run over the whole file —
    3,173 stations asked, 3,173 answered, 0 "No Data", 0 unreachable:

        1 m              1,608   50.7%
        50 cm              337   10.6%
        2 m                170    5.4%
        5 m                132    4.2%
        ───────────────────────────────
        finer than 30 m  2,247   70.8%
        1 second (~30 m)   926   29.2%

    An earlier pass put "no data" at 10%; every one of those was the concurrency
    artefact described under THE SERVICE, which is why it is not the figure
    here. The output of that full run is committed under data/elvis/, with a
    README that reads the audit before acting on it.

    Nothing but the standard library — same rule as the rest of tools/, and the
    same reason: this repo has no build step, and the service is plain JSON over
    HTTPS, so there is nothing a dependency would buy.

WHAT IT DOES NOT DO
    It does not write stations.json. It proposes, and a person decides.

    That is not caution for its own sake. A surveyed mark and a model of the
    ground answer different questions, and over this particular file they
    disagree in a very particular way. Against the 840 surveyed heights the
    median |Δ| is ~5.9 m, and the disagreement is one-directional — the surveyed
    figure is almost always the higher one. The worst of them are creek and
    gorge gauges: `tarana_fish_river` (surveyed 953.8, Elvis 866.3),
    `upper_tenthill_al` (359.3 / 326.5), `st_agnes_ck_al` (49.2 / 26.3).

    Ring-sampling those coordinates settles it. Every one sits in incised ground
    with +10 to +49 m of relief within 120 m: the coordinate is the gauge down in
    the channel, the surveyed mark is the hut on the bank above it. A 1 m model
    finds the real channel floor; a 30 m one smooths it away and lands partway up
    the bank, which is why the coarser source looks "closer" to the mark and is
    not in fact more correct about the ground.

    So a large disagreement here is a flag on the *coordinate*, not a correction
    to the height, and --relief is what tells those two apart. Anything this
    prints is a question for a person, not an edit.

WHAT IT PRODUCES
    <out>/elvis-fill.csv     one row per station with no surveyed height:
                             the modelled AHD figure, its resolution, the
                             dataset that answered.
    <out>/elvis-audit.csv    one row per station that has one: both figures,
                             the difference, and (with --relief) the local
                             relief around the coordinate.
    <out>/elvis-summary.json counts, the resolution histogram, and the
                             disagreement distribution.

THE SERVICE
    GET https://api-elevation.fsdf.org.au/elevation-at-point?lat=<lat>&long=<lon>

    Undocumented; the endpoint and its parameters were read out of the Elvis
    front end and confirmed live. Keyless. Note `long`, not `lon` or
    `longitude` — the other spellings return 502, not 400, so a typo looks like
    an outage rather than a mistake.

    Every field comes back as prose with the unit stuck on ("11.94m"), and a
    point it holds nothing for is HTTP 200 with the literal string "No Data" in
    all five fields. Parsed naively that is a NaN travelling on as a height.

    Measured: 1.4-5.0 s per call and no batch endpoint, so the whole file is
    roughly 15 minutes at the default concurrency. --cache makes a re-run free,
    so an interrupted pass resumes.

    THE TRAP, and the reason --workers defaults low: above about 8 requests in
    flight the service sheds load by answering "No Data" — HTTP 200, all five
    fields, indistinguishable from a point it genuinely holds nothing for. It
    is a soft failure wearing a valid answer's clothes, and it is silent.

        workers=4    40/40 answered,  0 "No Data"
        workers=8    40/40 answered,  0 "No Data"
        workers=16   31/40 answered,  9 "No Data"

    Every one of those nine returned real 1 m LiDAR when asked again on its own.
    Taken at face value they would have written "no elevation data" into a
    dataset for stations that have some, which is why nothing here trusts a
    "No Data" until it has survived a serial re-ask (see recheck_no_data).

USAGE
    python3 tools/elvis_station_elevations.py --limit 50       # try it small
    python3 tools/elvis_station_elevations.py                  # the whole file
    python3 tools/elvis_station_elevations.py --relief 15      # + ring-sample
                                                               #   disagreements
"""

import argparse
import concurrent.futures
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AT_POINT = 'https://api-elevation.fsdf.org.au/elevation-at-point'
# A browser-ish agent: the front end is all this service normally sees, and a
# default urllib agent is the kind of thing a WAF in front of it may sample.
UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')

# ── parsing ────────────────────────────────────────────────────────────────
# Kept byte-for-byte equivalent to elvis.js's parser. If one changes the other
# has to, or the tool and the card will disagree about the same response.

def height_metres(s):
    """'11.94m' -> 11.94. None rather than NaN, so a bad parse is a missing
    answer and not a number that poisons the statistics below."""
    if s is None:
        return None
    t = str(s).strip()
    if not t or t.lower() == 'no data':
        return None
    m = re.match(r'^(-?[\d.]+)\s*m?$', t, re.I)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def resolution_metres(s):
    """'1m' -> 1.0, '50cm' -> 0.5, '1 Second' -> 30.0."""
    if not isinstance(s, str):
        return None
    t = s.strip().lower()
    if t == 'no data':
        return None
    if 'second' in t:
        return 30.0          # a second of latitude is ~30.9 m; the national SRTM product
    m = re.match(r'^([\d.]+)\s*cm$', t)
    if m:
        return float(m.group(1)) / 100.0
    m = re.match(r'^([\d.]+)\s*m$', t)
    if m:
        return float(m.group(1))
    return None


def agency_of(s):
    if not isinstance(s, str):
        return ''
    t = s.split(' - ')[0].strip()
    return '' if t.lower() == 'no data' else t


# ── the service ────────────────────────────────────────────────────────────

def ask_point(lat, lon, timeout, retries=2):
    """One point. Returns a dict, always — {'ok': False, 'error': ...} on any
    failure, so one unreachable point cannot take the run down with it."""
    url = '%s?%s' % (AT_POINT, urllib.parse.urlencode({'lat': lat, 'long': lon}))
    last = ''
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA,
                'Accept': 'application/json',
                'Referer': 'https://elevation.fsdf.org.au/',
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = json.loads(r.read().decode('utf-8'))
        except (urllib.error.URLError, OSError, ValueError) as e:
            last = str(e)
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))   # the service 502s under load, not policy
                continue
            return {'ok': False, 'error': last}
        h = height_metres(raw.get('HEIGHT AT LOCATION'))
        if h is None:
            return {'ok': False, 'error': 'no data', 'no_data': True}
        res = raw.get('DEM RESOLUTION')
        return {
            'ok': True,
            'height_m': h,
            'datum': 'AHD',
            'resolution': res if isinstance(res, str) and res.lower() != 'no data' else '',
            'resolution_m': resolution_metres(res),
            'source': agency_of(raw.get('SOURCE')),
            'dataset': '' if raw.get('DATASET') in (None, 'No Data') else raw['DATASET'],
        }
    return {'ok': False, 'error': last}


def ring(lat, lon, radius_m, n=8):
    """n points on a circle of radius_m around (lat, lon)."""
    out = []
    dlat = radius_m / 111320.0
    for i in range(n):
        b = math.radians(i * (360.0 / n))
        out.append((lat + dlat * math.cos(b),
                    lon + dlat * math.sin(b) / math.cos(math.radians(lat))))
    return out


# ── the run ────────────────────────────────────────────────────────────────

def load_stations(path):
    with open(path, encoding='utf-8') as f:
        doc = json.load(f)
    rows = doc['stations'] if isinstance(doc, dict) else doc
    return [s for s in rows if s.get('lat') is not None and s.get('lon') is not None]


def run_points(points, workers, timeout, cache, log_every, label):
    """points: list of (key, lat, lon). Returns {key: result}. Cached keys are
    not re-asked, so an interrupted pass resumes for free."""
    todo = [p for p in points if p[0] not in cache]
    done = len(points) - len(todo)
    if todo:
        print('  %s: %d point(s), %d already cached' % (label, len(todo), done),
              file=sys.stderr)
    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(ask_point, lat, lon, timeout): key for key, lat, lon in todo}
        for i, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            cache[futs[fut]] = fut.result()
            if log_every and i % log_every == 0:
                rate = i / max(1e-9, time.time() - started)
                print('    %d/%d  (%.1f/s, ~%.0fs left)'
                      % (i, len(todo), rate, (len(todo) - i) / max(rate, 1e-9)),
                      file=sys.stderr)
    return cache


def recheck_no_data(stations, cache, timeout):
    """Re-ask, one at a time, every point that came back "No Data".

    The service sheds load by answering "No Data" rather than by erroring, so a
    concurrent pass produces false negatives that look exactly like real ones.
    Serially they come back with data. This is cheap because it only runs over
    the ones that failed, and it is not optional because the alternative is
    recording "this place has no elevation data" about places that do."""
    suspect = [s for s in stations
               if (cache.get(s['id']) or {}).get('no_data')]
    if not suspect:
        return
    print('  %d "No Data" answer(s); re-asking each on its own.' % len(suspect),
          file=sys.stderr)
    recovered = 0
    for s in suspect:
        r = ask_point(s['lat'], s['lon'], timeout)
        if r.get('ok'):
            cache[s['id']] = r
            recovered += 1
        elif not r.get('no_data'):
            cache[s['id']] = r        # a real error is more honest than a false "no data"
    print('    %d of %d had data after all.' % (recovered, len(suspect)), file=sys.stderr)


def self_check():
    """The parsing, against the shapes the live service really returns.

    No network. What is worth pinning here is not arithmetic but the two ways
    this service can put a wrong number into a dataset without erroring: every
    field is prose with a unit stuck on, and a point it holds nothing for is a
    200 with "No Data" in all five fields. Parsed loosely, both become a float.
    """
    cases = [
        # (what, parser, input, expected)
        ('a LiDAR height', height_metres, '11.94m', 11.94),
        ('a height with no unit', height_metres, '11.94', 11.94),
        ('a height below the datum', height_metres, '-1.5m', -1.5),
        ('a zero height', height_metres, '0.0m', 0.0),
        ('"No Data" is not a height', height_metres, 'No Data', None),
        ('nor is an empty string', height_metres, '', None),
        ('nor is prose', height_metres, 'unavailable', None),
        ('nor is None', height_metres, None, None),
        ('1 m resolution', resolution_metres, '1m', 1.0),
        ('50 cm is half a metre', resolution_metres, '50cm', 0.5),
        ('2 m', resolution_metres, '2m', 2.0),
        ('5 m', resolution_metres, '5m', 5.0),
        ('the national second is ~30 m', resolution_metres, '1 Second', 30.0),
        ('"No Data" has no resolution', resolution_metres, 'No Data', None),
        ('the agency, not the URL after it', agency_of,
         'QLD Government - https://www.qld.gov.au/', 'QLD Government'),
        ('"No Data" is no agency', agency_of, 'No Data', ''),
    ]
    bad = []
    for what, fn, given, want in cases:
        got = fn(given)
        if got != want:
            bad.append('%s: %r -> %r, expected %r' % (what, given, got, want))

    # A zero height is a real answer and must not be mistaken for a missing one:
    # SRTM returns 0.0 m at sea, and `if not height` would throw that away.
    if height_metres('0.0m') is None:
        bad.append('a 0 m height read as missing')

    # reading_for is what turns a difference into advice, so its one consequential
    # branch is pinned: a mark above ground the ring explains is a coordinate
    # question, not a height correction.
    if 'coordinate' not in reading_for(87.5, {'rise': 49.2}):
        bad.append('a mark explained by nearby high ground did not read as a coordinate flag')
    if 'coordinate' in reading_for(87.5, {'rise': 1.0}):
        bad.append('a mark the ring does NOT explain was blamed on the coordinate')
    if reading_for(0.5, {}) != 'agrees':
        bad.append('a sub-2 m difference did not read as agreement')

    if bad:
        print('elvis_station_elevations parsing is wrong:')
        for line in bad:
            print('  - %s' % line)
        return 1
    print('elvis_station_elevations: %d parsing case(s) OK, including "No Data" '
          'and a 0 m height.' % len(cases))
    return 0


def reading_for(d, rel):
    """What a difference most likely means, in words.

    `d` is surveyed minus modelled, so a positive number means the mark sits
    above the ground the model found. `rel` is the ring result, when one was
    taken. The distinction this makes is the whole reason --relief exists: a
    coordinate that has landed in a channel and a height that is simply wrong
    look identical in the difference column alone."""
    a = abs(d)
    if a < 2:
        return 'agrees'
    if a < 10:
        return 'close'
    rise = rel.get('rise')
    if rise is None:
        return 'differs — ring-sample it (--relief) before reading anything into it'
    if d > 0:
        # How much of the gap the nearby ground accounts for. Reported as a
        # share rather than a verdict, because it rarely closes the gap exactly
        # and the honest answer is "this much of it". tarana_fish_river is the
        # worked example: 87.5 m of difference, 49.2 m of rise within 120 m —
        # 56%, which is not all of it and is plainly the same story.
        share = rise / a
        if share >= 0.5 or rise >= 15:
            return ('coordinate: ground rises %.0f m within the ring, %.0f%% of the '
                    'difference — the mark is likely uphill of the point, so check '
                    'the position before the height' % (rise, 100 * share))
        return ('mark is %.0f m above the modelled ground and the ring explains only '
                '%.0f%% of it' % (a, 100 * share))
    return 'modelled ground is above the mark — unusual; check both'


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--stations', default=os.path.join(REPO, 'stations.json'),
                    help='stations.json to read (default: the repo copy)')
    ap.add_argument('--out', default=os.path.join(REPO, 'data', 'elvis'),
                    help='directory for the CSVs and the summary')
    ap.add_argument('--limit', type=int, default=0,
                    help='stop after the first N stations by id — try the run small '
                         'first. Ids cluster geographically, so this is a quick check '
                         'and not a representative sample; use --sample for that.')
    ap.add_argument('--sample', type=int, default=0, metavar='N',
                    help='N stations drawn at random instead, seeded so the same N is '
                         'the same N every run. This is what to use for a figure about '
                         'the file as a whole.')
    ap.add_argument('--seed', type=int, default=20260921, help='seed for --sample')
    ap.add_argument('--workers', type=int, default=8,
                    help='requests in flight. 8 is the measured ceiling: above it the '
                         'service starts answering "No Data" for points it holds data '
                         'for (see THE SERVICE). Raising this trades silence for speed.')
    ap.add_argument('--timeout', type=float, default=45.0, help='seconds per request')
    ap.add_argument('--only', choices=('all', 'missing', 'surveyed'), default='all',
                    help='missing = only stations with no elevation_ahd')
    ap.add_argument('--relief', type=float, default=0.0, metavar='M',
                    help='ring-sample stations whose |difference| exceeds M metres, '
                         'to tell a wrong height from a coordinate sitting in a channel')
    ap.add_argument('--relief-radii', default='25,60,120',
                    help='ring radii in metres (default: 25,60,120)')
    ap.add_argument('--cache', default='', metavar='FILE',
                    help='read/write raw answers here so a re-run is free')
    ap.add_argument('--check', action='store_true',
                    help='self-test the parsing against the shapes the service really '
                         'returns, and exit. No network — this is what CI runs.')
    args = ap.parse_args()

    if args.check:
        return self_check()

    stations = load_stations(args.stations)
    if args.only == 'missing':
        stations = [s for s in stations if s.get('elevation_ahd') in (None, '')]
    elif args.only == 'surveyed':
        stations = [s for s in stations if s.get('elevation_ahd') not in (None, '')]
    stations.sort(key=lambda s: s['id'])        # deterministic: same input, same bytes out
    if args.sample and args.sample < len(stations):
        import random
        stations = sorted(random.Random(args.seed).sample(stations, args.sample),
                          key=lambda s: s['id'])
    elif args.limit:
        stations = stations[:args.limit]

    cache = {}
    if args.cache and os.path.exists(args.cache):
        with open(args.cache, encoding='utf-8') as f:
            cache = json.load(f)

    print('Asking Elvis about %d station(s), %d at a time.'
          % (len(stations), args.workers), file=sys.stderr)
    run_points([(s['id'], s['lat'], s['lon']) for s in stations],
               args.workers, args.timeout, cache, 100, 'stations')

    # A "No Data" is not believed until it has been asked again on its own. See
    # THE TRAP above: under concurrency the service answers "No Data" for points
    # it holds 1 m LiDAR for, and the answer is a valid-looking 200.
    recheck_no_data(stations, cache, args.timeout)

    # ── ring sampling, only where the two figures disagree ─────────────────
    relief = {}
    if args.relief > 0:
        radii = [float(x) for x in args.relief_radii.split(',') if x.strip()]
        flagged = []
        for s in stations:
            r = cache.get(s['id'])
            surveyed = s.get('elevation_ahd')
            if not (r and r.get('ok')) or surveyed in (None, ''):
                continue
            if abs(float(surveyed) - r['height_m']) >= args.relief:
                flagged.append(s)
        pts = []
        for s in flagged:
            for rad in radii:
                for j, (la, lo) in enumerate(ring(s['lat'], s['lon'], rad)):
                    pts.append(('%s@%g#%d' % (s['id'], rad, j), la, lo))
        if pts:
            print('  %d station(s) disagree by >= %g m; ring-sampling %d point(s).'
                  % (len(flagged), args.relief, len(pts)), file=sys.stderr)
            run_points(pts, args.workers, args.timeout, cache, 200, 'rings')
        for s in flagged:
            hs = [cache[k]['height_m'] for k in cache
                  if k.startswith(s['id'] + '@') and cache[k].get('ok')]
            at = cache[s['id']]['height_m']
            relief[s['id']] = {'max': max(hs) if hs else None,
                               'rise': (max(hs) - at) if hs else None,
                               'n': len(hs)}

    if args.cache:
        os.makedirs(os.path.dirname(os.path.abspath(args.cache)) or '.', exist_ok=True)
        with open(args.cache, 'w', encoding='utf-8') as f:
            json.dump(cache, f, indent=1, sort_keys=True)

    # ── the two tables ─────────────────────────────────────────────────────
    os.makedirs(args.out, exist_ok=True)
    import csv

    fill_rows, audit_rows = [], []
    res_hist, src_hist, failures, no_data = {}, {}, 0, 0
    for s in stations:
        r = cache.get(s['id']) or {}
        if not r.get('ok'):
            if r.get('no_data'):
                no_data += 1
            else:
                failures += 1
            continue
        res_hist[r.get('resolution') or '?'] = res_hist.get(r.get('resolution') or '?', 0) + 1
        src_hist[r.get('source') or '?'] = src_hist.get(r.get('source') or '?', 0) + 1
        surveyed = s.get('elevation_ahd')
        if surveyed in (None, ''):
            fill_rows.append({
                'id': s['id'], 'name': s.get('name', ''),
                'lat': s['lat'], 'lon': s['lon'],
                'elvis_ahd_m': round(r['height_m'], 2),
                'dem_resolution': r.get('resolution', ''),
                'dem_resolution_m': r.get('resolution_m') or '',
                'source': r.get('source', ''), 'dataset': r.get('dataset', ''),
            })
        else:
            d = float(surveyed) - r['height_m']
            rel = relief.get(s['id']) or {}
            audit_rows.append({
                'id': s['id'], 'name': s.get('name', ''),
                'lat': s['lat'], 'lon': s['lon'],
                'surveyed_ahd_m': float(surveyed),
                'elvis_ahd_m': round(r['height_m'], 2),
                'difference_m': round(d, 2),
                'abs_difference_m': round(abs(d), 2),
                'dem_resolution': r.get('resolution', ''),
                'relief_within_ring_m': ('' if rel.get('rise') is None
                                         else round(rel['rise'], 1)),
                # The reading the ring is there to support, said in words
                # rather than left for whoever opens the CSV to work it out.
                'reading': reading_for(d, rel),
                'source': r.get('source', ''), 'dataset': r.get('dataset', ''),
            })

    def write_csv(path, rows):
        if not rows:
            return
        with open(path, 'w', encoding='utf-8', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    fill_rows.sort(key=lambda r: r['id'])
    audit_rows.sort(key=lambda r: -r['abs_difference_m'])
    write_csv(os.path.join(args.out, 'elvis-fill.csv'), fill_rows)
    write_csv(os.path.join(args.out, 'elvis-audit.csv'), audit_rows)

    diffs = [r['abs_difference_m'] for r in audit_rows]
    summary = {
        'asked': len(stations),
        'answered': len(fill_rows) + len(audit_rows),
        'no_data': no_data,
        'unreachable': failures,
        'proposed_fills': len(fill_rows),
        'audited': len(audit_rows),
        'dem_resolution': dict(sorted(res_hist.items(), key=lambda kv: -kv[1])),
        'source': dict(sorted(src_hist.items(), key=lambda kv: -kv[1])),
        'difference_m': ({
            'median': round(statistics.median(diffs), 2),
            'mean': round(statistics.mean(diffs), 2),
            'p90': round(sorted(diffs)[int(0.9 * len(diffs)) - 1], 2),
            'max': round(max(diffs), 2),
            'within_2m': sum(1 for d in diffs if d <= 2),
            'within_5m': sum(1 for d in diffs if d <= 5),
            'within_10m': sum(1 for d in diffs if d <= 10),
        } if diffs else None),
        'note': ('A large difference flags the coordinate, not the height: these are '
                 'creek and gorge gauges where the point is the gauge in the channel '
                 'and the surveyed mark is the hut on the bank. Use --relief to tell '
                 'that apart from a genuinely wrong figure. Nothing here edits '
                 'stations.json.'),
    }
    with open(os.path.join(args.out, 'elvis-summary.json'), 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=2)

    print('', file=sys.stderr)
    print('  answered %d/%d   no data %d   unreachable %d'
          % (summary['answered'], summary['asked'], no_data, failures), file=sys.stderr)
    print('  resolution: %s' % ', '.join('%s x%d' % kv for kv in summary['dem_resolution'].items()),
          file=sys.stderr)
    print('  %d proposed fill(s), %d audited' % (len(fill_rows), len(audit_rows)), file=sys.stderr)
    if diffs:
        print('  |difference|: median %.2f m, p90 %.2f m, max %.2f m'
              % (summary['difference_m']['median'], summary['difference_m']['p90'],
                 summary['difference_m']['max']), file=sys.stderr)
    print('  written to %s' % args.out, file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
