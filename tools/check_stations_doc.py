#!/usr/bin/env python3
"""Prove that the database's document is stations.json.

The whole read path in #B2 rests on one claim: `meganet.stations_doc()` returns
something app.js cannot tell apart from the file it has always parsed. app.js is
~17,700 lines and every one of them below loadJson() assumes that shape, so the
claim is worth checking rather than asserting.

    # against the local or live database
    psql "$MEGANET_DB_URL" -tAc 'select doc from meganet.stations_json' > /tmp/doc.json
    python3 tools/check_stations_doc.py /tmp/doc.json

    # or against the deployed API, exactly as the browser fetches it
    curl -s 'https://<ref>.supabase.co/rest/v1/rpc/stations_doc' \\
         -H 'apikey: <publishable key>' -H 'Accept-Profile: meganet' > /tmp/doc.json
    python3 tools/check_stations_doc.py /tmp/doc.json

Exit status is 0 when the two are identical and 1 when they are not, so it works
as a gate as well as a report.

What "identical" means here, stated precisely, because a vague comparison would
pass on differences that matter:

  * Object keys are compared as sets — a key that is absent on one side and
    present-but-null on the other is a failure, not a detail. The app tests both
    `'lga' in s` and `s.site.db_id`, and those behave differently against a null.
  * Arrays are compared in order. stations[], sensors[] and pass_ranges[] are
    not in any natural order in the file, which is why the schema carries `ord`.
  * Numbers are compared as decimals, not floats, so 151.5 arriving back as
    151.49999999999997 is caught rather than rounded away.
  * Object key *order* is not compared. JSON objects are unordered by definition,
    jsonb sorts keys, and no JavaScript in this app reads a key by position.

Standard library only.
"""

from __future__ import annotations

import argparse
import decimal
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_STATIONS = os.path.join(REPO, 'stations.json')

MAX_REPORTED = 40


def load(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle, parse_float=decimal.Decimal)


def compare(a, b, path='$', out=None):
    """Walk both documents together, appending a line per difference."""
    if out is None:
        out = []
    if len(out) >= MAX_REPORTED:
        return out

    if isinstance(a, dict) and isinstance(b, dict):
        for key in sorted(set(a) - set(b)):
            out.append('%s.%s — in stations.json, missing from the database' % (path, key))
        for key in sorted(set(b) - set(a)):
            out.append('%s.%s — in the database, missing from stations.json' % (path, key))
        for key in sorted(set(a) & set(b)):
            compare(a[key], b[key], '%s.%s' % (path, key), out)
        return out

    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append('%s — %d element(s) in stations.json, %d in the database'
                       % (path, len(a), len(b)))
            return out
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, '%s[%d]' % (path, i), out)
        return out

    # bool before number: True == 1 in Python, and a boolean where a number
    # belongs is exactly the kind of thing this check exists to catch.
    if isinstance(a, bool) or isinstance(b, bool):
        if a is not b:
            out.append('%s — %r in stations.json, %r in the database' % (path, a, b))
        return out

    if isinstance(a, (int, decimal.Decimal)) and isinstance(b, (int, decimal.Decimal)):
        if decimal.Decimal(a) != decimal.Decimal(b):
            out.append('%s — %s in stations.json, %s in the database' % (path, a, b))
        return out

    if type(a) is not type(b):
        out.append('%s — %s in stations.json, %s in the database'
                   % (path, type(a).__name__, type(b).__name__))
        return out

    if a != b:
        out.append('%s — %r in stations.json, %r in the database' % (path, a, b))
    return out


def canonical(doc):
    """Both documents reduced to one canonical text, for the stronger check."""
    def norm(x):
        if isinstance(x, dict):
            return {k: norm(v) for k, v in sorted(x.items())}
        if isinstance(x, list):
            return [norm(v) for v in x]
        if isinstance(x, decimal.Decimal):
            # 109 and 109.0 are the same number to every consumer of this
            # document — JavaScript has one number type. Normalising the
            # representation keeps this check about values, while the walk above
            # is what guarantees structure.
            return format(x.normalize(), 'f')
        return x
    return json.dumps(norm(doc), sort_keys=True, ensure_ascii=False)


def summarise(doc):
    stations = doc.get('stations') or []
    return ('%d stations · %d sensors · %d repeaters · %d pass ranges · '
            '%d networks · %d catchments · %d rm systems'
            % (len(stations),
               sum(len(s.get('sensors') or []) for s in stations),
               sum(1 for s in stations if s.get('repeater')),
               sum(len((s.get('repeater') or {}).get('pass_ranges') or [])
                   + len((s.get('repeater') or {}).get('exclusions') or [])
                   for s in stations),
               len(doc.get('radio_networks') or []),
               len(doc.get('catchments') or []),
               len(doc.get('rm_systems') or [])))


def main():
    ap = argparse.ArgumentParser(
        description="Check the database's stations document against stations.json.")
    ap.add_argument('doc', help='the document from meganet.stations_doc() / the view')
    ap.add_argument('--stations', default=DEFAULT_STATIONS,
                    help='path to stations.json (default: repo root)')
    args = ap.parse_args()

    expected = load(args.stations)
    actual = load(args.doc)

    # PostgREST wraps a view's row as [{"doc": …}]; the RPC returns the document
    # itself. Accept either, so the same tool checks both the SQL and the HTTP
    # path without the caller having to unwrap anything first.
    if isinstance(actual, list) and len(actual) == 1 and isinstance(actual[0], dict) \
            and set(actual[0]) == {'doc'}:
        actual = actual[0]['doc']
    elif isinstance(actual, dict) and set(actual) == {'doc'}:
        actual = actual['doc']

    print('stations.json   %s' % summarise(expected))
    print('database        %s' % summarise(actual))
    print()

    diffs = compare(expected, actual)
    if diffs:
        print('DIFFERENT — %s%d difference(s):'
              % ('first ' if len(diffs) >= MAX_REPORTED else '', len(diffs)))
        for d in diffs:
            print('  %s' % d)
        return 1

    print('IDENTICAL — every key, every element, every value.')
    if canonical(expected) == canonical(actual):
        print('           canonical serialisations match byte for byte too.')
    else:
        # Structure and values agree, so the app cannot tell the difference, but
        # something is representing a number differently. Worth printing rather
        # than hiding, without failing the check.
        print('           (canonical texts differ — numeric representation only)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
