#!/usr/bin/env python3
"""Write stations.json from the database.

Since #B3 the station editor writes to Postgres, which makes the file in this
repo a copy rather than the original — and a copy nobody refreshes becomes a
lie. This is the refresh: fetch `meganet.stations_doc()` and write it out in
exactly the form the committed file already has.

    # the deployed database, over the public read API
    python3 tools/snapshot_stations_json.py

    # a document already in hand (psql, a backup, the browser's Snapshot button)
    psql "$MEGANET_DB_URL" -tAc 'select doc from meganet.stations_json' \\
      | python3 tools/snapshot_stations_json.py --from -

    # look, don't touch
    python3 tools/snapshot_stations_json.py --check

`--check` exits 1 when the file would change, which is what makes this usable as
a gate as well as a refresh. `.github/workflows/stations-snapshot.yml` runs the
plain form weekly and opens a pull request when the file moves.

Two things this does that a `curl … > stations.json` would not, and both are the
reason it exists:

  * **Key order.** jsonb sorts an object's keys by length and then by bytes, so a
    raw dump reorders every key in a 160,000-line file and buries the change
    that actually happened. The orders below are the file's own, so a snapshot
    diff shows edited stations and nothing else.

  * **Numbers.** Parsed as Decimal and written back as the literal that arrived.
    A JSON number round-tripped through a float comes back as 151.49999999999997
    or as 109.0 where the document said 109 — the same reason the schema uses
    `numeric` rather than `double precision`.

Standard library only.
"""

from __future__ import annotations

import argparse
import decimal
import json
import os
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO, 'stations.json')

# The same two constants app.js carries, for the same reason: the key is
# published on GitHub Pages, names the project and authorises nothing. Reads are
# public; every write needs a session the anon key cannot produce.
DB_URL = 'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1'
DB_ANON_KEY = 'sb_publishable_PV9VjCM8NQeGAJMuwa5TKA_yX9GWacY'
DB_SCHEMA = 'meganet'

# The committed file's key order, object by object. Anything not listed keeps the
# order it arrived in, appended after what is — so a key added to the schema
# tomorrow lands at the end of its object instead of failing here.
KEY_ORDER = {
    'root':    ['meta', 'radio_networks', 'catchments', 'hubs', 'rm_systems', 'stations'],
    'meta':    ['version', 'description', 'updated', 'rm_paths'],
    'rm_paths': ['map', 'jpg', 'land'],
    # The legacy alert_ids object, whose keys the app reads by name. The file is
    # not quite consistent about their order — jsonb is not either — so this is
    # the order it mostly has, applied to all of them.
    'alert_ids': ['rainfall', 'battery', 'water_level'],
    'network': ['id', 'name', 'description'],
    'catchment': ['id', 'name', 'basin_no', 'area_sqkm', 'region', 'division',
                  'division_no', 'border'],
    'hub':     ['id', 'name', 'area_sqkm'],
    'rm_system': ['id', 'name', 'tx_power_w', 'line_loss_db', 'supp_loss_db_m',
                  'antenna_type', 'antenna_gain_dbi', 'antenna_height_m',
                  'rx_threshold_dbm'],
    'station': ['id', 'name', 'station_number', 'lat', 'lon', 'elevation_ahd',
                'roles', 'radio_network_ids', 'catchment_ids', 'alert_ids',
                'satcom', 'rm_system_id', 'enabled', 'notes', 'legacy_unit_id',
                'repeater', 'site', 'sensors', 'lga', 'basin', 'hub_id',
                'location_types', 'TBRGbucketSize', 'inspection_config_key'],
    'sensor':  ['alert_id', 'type', 'sensor_id', 'device_id'],
    'site':    ['db_id', 'number', 'name'],
    'satcom':  ['enabled', 'provider', 'terminal_id'],
    'repeater': ['acma_licence', 'rx_mhz', 'tx_mhz', 'delay_ms', 'pass_ranges',
                 'exclusions', 'notes'],
    'range':   ['low', 'high'],
}


def ordered(obj, shape):
    """Re-key one object into the committed file's order, recursively."""
    order = KEY_ORDER.get(shape, [])
    keys = [k for k in order if k in obj] + [k for k in obj if k not in order]
    out = {}
    for k in keys:
        v = obj[k]
        if shape == 'root' and k == 'stations':
            out[k] = [ordered(s, 'station') for s in v]
        elif shape == 'root' and k == 'radio_networks':
            out[k] = [ordered(n, 'network') for n in v]
        elif shape == 'root' and k == 'catchments':
            out[k] = [ordered(c, 'catchment') for c in v]
        elif shape == 'root' and k == 'hubs':
            out[k] = [ordered(h, 'hub') for h in v]
        elif shape == 'root' and k == 'rm_systems':
            out[k] = [ordered(y, 'rm_system') for y in v]
        elif shape == 'root' and k == 'meta':
            out[k] = ordered(v, 'meta')
        elif shape == 'meta' and k == 'rm_paths' and isinstance(v, dict):
            out[k] = ordered(v, 'rm_paths')
        elif shape == 'station' and k == 'alert_ids' and isinstance(v, dict):
            out[k] = ordered(v, 'alert_ids')
        elif shape == 'station' and k == 'sensors':
            out[k] = [ordered(se, 'sensor') for se in v]
        elif shape == 'station' and k == 'site' and isinstance(v, dict):
            out[k] = ordered(v, 'site')
        elif shape == 'station' and k == 'satcom' and isinstance(v, dict):
            out[k] = ordered(v, 'satcom')
        elif shape == 'station' and k == 'repeater' and isinstance(v, dict):
            out[k] = ordered(v, 'repeater')
        elif shape == 'repeater' and k in ('pass_ranges', 'exclusions'):
            out[k] = [ordered(r, 'range') for r in v]
        else:
            out[k] = v
    return out


def fetch(url, key):
    req = urllib.request.Request(
        f'{url}/rpc/stations_doc',
        headers={
            'apikey': key,
            'Accept-Profile': DB_SCHEMA,
            'Accept': 'application/json',
        },
    )
    with urllib.request.urlopen(req, timeout=180) as res:
        return res.read().decode('utf-8')


def dump(value, depth=0):
    """`json.dumps(indent=2)`, except that a Decimal keeps its own digits.

    json has no hook that reaches a number: `default=` is only called for types
    it cannot serialise at all, and a Decimal routed through it comes back as a
    float or as a quoted string. Writing the four container cases by hand is
    smaller than any of the ways around that, and every scalar is still escaped
    by json itself.
    """
    pad = '  ' * depth
    if isinstance(value, dict):
        if not value:
            return '{}'
        items = ['%s  %s: %s' % (pad, json.dumps(k, ensure_ascii=False), dump(v, depth + 1))
                 for k, v in value.items()]
        return '{\n' + ',\n'.join(items) + '\n' + pad + '}'
    if isinstance(value, list):
        if not value:
            return '[]'
        items = ['%s  %s' % (pad, dump(v, depth + 1)) for v in value]
        return '[\n' + ',\n'.join(items) + '\n' + pad + ']'
    if isinstance(value, decimal.Decimal):
        return str(value)
    return json.dumps(value, ensure_ascii=False)


def render(doc):
    return dump(ordered(doc, 'root')) + '\n'


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--from', dest='src', metavar='PATH',
                    help="read the document from a file, or '-' for stdin, "
                         'instead of fetching it')
    ap.add_argument('--url', default=DB_URL, help='PostgREST base URL')
    ap.add_argument('--key', default=os.environ.get('MEGANET_DB_KEY', DB_ANON_KEY),
                    help='API key to read with (default: the published anon key)')
    ap.add_argument('--out', default=DEFAULT_OUT, help='file to write')
    ap.add_argument('--check', action='store_true',
                    help='report whether the file would change; write nothing')
    args = ap.parse_args()

    if args.src == '-':
        raw = sys.stdin.read()
    elif args.src:
        with open(args.src, encoding='utf-8') as handle:
            raw = handle.read()
    else:
        raw = fetch(args.url, args.key)

    doc = json.loads(raw, parse_float=decimal.Decimal)
    if not isinstance(doc.get('stations'), list):
        sys.exit('that is not a stations document: stations[] is missing')

    text = render(doc)

    counts = (f"{len(doc['stations'])} stations · "
              f"{sum(len(s.get('sensors', [])) for s in doc['stations'])} sensors · "
              f"{sum(1 for s in doc['stations'] if 'repeater' in s)} repeaters")

    old = None
    if os.path.exists(args.out):
        with open(args.out, encoding='utf-8') as handle:
            old = handle.read()

    if old == text:
        print(f'{args.out} is already the database\'s document — {counts}')
        return 0

    if args.check:
        print(f'{args.out} differs from the database — {counts}')
        return 1

    with open(args.out, 'w', encoding='utf-8') as handle:
        handle.write(text)
    print(f'wrote {args.out} — {counts}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
