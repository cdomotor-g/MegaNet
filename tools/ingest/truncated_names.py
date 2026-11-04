#!/usr/bin/env python3
"""
truncated_names.py — station names that Radio Mobile cut at 20 characters, and
the full names that replaced them.

WHY
    Radio Mobile keeps a unit's name in 20 characters, and the first import
    took the network's names from it. So "Augustus Downs Station" arrived as
    "Augustus Downs Stati", "Ainsworth Road (Middle Creek)" as "Ainsworth Rd
    (Middle". Some were then shortened again after the cut — Road to Rd, Creek
    to Ck, Bridge to Br — and the Road one was applied inside words too, which
    is how Broadwater became "BRdwater". A few had their words squeezed
    together to fit ("SuffolkPrk(ServoRd").

HOW A CUT IS FOUND
    A station's name is a cut when some other list gives its number a longer
    name whose first 20 characters, trailing space dropped, are the station's
    name — read with Rd, Ck, Br and the like spelled out, so a name cut and then
    shortened is found too. A longer name that only spells out an abbreviation
    Flood-Net uses on purpose ("AL" for ALERT, "TM", "Br") is not a cut, and nor
    is a short form somebody chose with its bracket closed ("Tintot (Macintyre
    R)"). The lists, all in the repository:

      archive/z_Sensors_with_Database_IDs_by_View_NATIONAL.csv   ARRO's sites
      archive/fred_sites_newfile.csv          a site list: name and number
      data/sls-qld.json, data/sls-nsw.json    the Bureau's SLS schedules
      data/river-height-stations.json         the Bureau's QLD station lists
      archive/flood-peaks/*.txt               HDB's flood peaks
      data/fldwarn-2024/kmz.json              the 2024 FldWarn KMZ
      stations.json (site.name)               ARRO, as attached to the station

    Where a name was cut and no list had its number, a person looked further —
    the Bureau's rain and river pages, its station metadata, the station's
    position — and the reason is written beside the decision.

    data/station-names/review.json holds every decision: id, number, the name
    as it was, the name now, where the full name came from and why. `left` is
    what was looked at and kept.

USE
    python3 tools/ingest/truncated_names.py --find
        lists names in stations.json that still look cut, and are not decided
        in review.json — run it after an import, or after a list is refreshed
    python3 tools/ingest/truncated_names.py --sql \\
        | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
        writes review.json into the database

    The SQL renames a station only while it still has the name the review found
    it with, so a second run changes nothing and a name somebody has changed
    since is left as they put it. It stamps updated_by = STAMP, which is the
    name the station history shows. Then refresh stations.json
    (tools/snapshot_stations_json.py), because the file is a copy.

Standard library only, like the rest of tools/.
"""

from __future__ import annotations

import argparse
import csv
import glob
import itertools
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
REVIEW = os.path.join(REPO, 'data', 'station-names', 'review.json')
STAMP = 'station names cut at 20 (claude)'

# Spelled out when testing a name against a longer one. Rd, Ck and Br are the
# shortenings applied after the cut; the rest are the network's usual ones.
LONG = {'Rd': 'Road', 'Ck': 'Creek', 'Br': 'Bridge', 'Mt': 'Mount', 'Hwy': 'Highway',
        'St': 'Street', 'Stn': 'Station', 'Res': 'Reservoir', 'Xing': 'Crossing',
        'Cr': 'Creek', 'Nth': 'North', 'Sth': 'South', 'R': 'River', 'Ave': 'Avenue',
        'Pk': 'Park', 'Prk': 'Park', 'Jn': 'Junction', 'Jct': 'Junction'}
# The other way, for "did the longer name only spell out what was abbreviated".
SHORT = {'alert': 'al', 'road': 'rd', 'creek': 'ck', 'bridge': 'br', 'crossing': 'xing',
         'reservoir': 'res', 'park': 'pk', 'mount': 'mt', 'street': 'st', 'station': 'stn',
         'highway': 'hwy', 'telemetry': 'tm'}


def number(x):
    x = re.sub(r'\.0$', '', str(x if x is not None else '').strip())
    return x.lstrip('0')


def squash(s):
    return re.sub(r'[^a-z0-9]', '', s.lower())


def other_names():
    """Bureau or site number -> [(list, name)], from every list in the repository."""
    out = {}

    def add(n, name, tag):
        n, name = number(n), re.sub(r'\s+', ' ', (name or '').strip())
        if n and name and (tag, name) not in out.setdefault(n, []):
            out[n].append((tag, name))

    def rows(path):
        with open(path, newline='', encoding='utf-8-sig', errors='replace') as f:
            yield from csv.DictReader(f)

    for r in rows(os.path.join(REPO, 'archive', 'z_Sensors_with_Database_IDs_by_View_NATIONAL.csv')):
        add(r['Site ID'], r['Site'], 'arro')
    for r in rows(os.path.join(REPO, 'archive', 'fred_sites_newfile.csv')):
        add(r['Station Number'], r['Title'], 'site-list')
    for j in ('qld', 'nsw'):
        for loc in json.load(open(os.path.join(REPO, 'data', f'sls-{j}.json')))['locations']:
            add(loc.get('bureau_number'), loc.get('name'), f'sls-{j}')
    rhs = json.load(open(os.path.join(REPO, 'data', 'river-height-stations.json')))
    for key, part in rhs.items():
        if isinstance(part, list):
            for r in part:
                if isinstance(r, dict):
                    add(r.get('bureau_number'), r.get('station_name'), 'bom-qld-lists')
    for path in glob.glob(os.path.join(REPO, 'archive', 'flood-peaks', '*.txt')):
        text = open(path, encoding='latin-1').read()
        for m in re.finditer(r'Station\s*:\s*(.+?)\s{2,}CBM No\s*:\s*(\d+)', text):
            add(m.group(2), m.group(1), 'hdb-peaks')
    kmz = os.path.join(REPO, 'data', 'fldwarn-2024', 'kmz.json')
    if os.path.exists(kmz):
        for p in json.load(open(kmz)).get('pins', []):
            add(p.get('number'), p.get('name'), 'kmz-2024')
    return out


def spelled_out(name):
    """The name, and every way of spelling out its abbreviations."""
    toks = re.split(r'(\W+)', name)
    at = [i for i, t in enumerate(toks) if t in LONG]
    out = {name}
    for k in range(1, len(at) + 1):
        for pick in itertools.combinations(at, k):
            t = list(toks)
            for i in pick:
                t[i] = LONG[t[i]]
            out.add(''.join(t))
    return out | {e.replace('BRd', 'Broad') for e in out if 'BRd' in e}


def only_spelled_out(name, full):
    k = lambda x: squash(' '.join(SHORT.get(w, w) for w in re.findall(r'[a-z0-9]+', x.lower())))
    if name.count('(') != name.count(')') and full.count('(') == full.count(')'):
        return False
    return k(name) == k(full.removesuffix(' Tm'))


def looks_cut(name, full):
    """Whether `name` is `full` cut at 20 characters (and maybe shortened)."""
    low = lambda s: re.sub(r'\s+', ' ', s.lower()).strip()
    f = re.sub(r'\s+', ' ', full)
    if len(f) <= 20 or only_spelled_out(name, full):
        return False
    head = low(f[:20])
    return any(head == low(e) and len(low(f)) > len(low(e)) for e in spelled_out(name))


def find():
    review = json.load(open(REVIEW))
    decided = {r['id'] for r in review['names']} | {r['id'] for r in review.get('left', [])}
    names = other_names()
    stations = json.load(open(os.path.join(REPO, 'stations.json')))['stations']
    for s in stations:
        if s.get('site') and s['site'].get('name'):
            names.setdefault(number(s['station_number']), []).append(('site', s['site']['name']))
    found = 0
    for s in stations:
        if s['id'] in decided:
            continue
        name = s['name']
        longer = [(t, f) for t, f in names.get(number(s['station_number']), []) if looks_cut(name, f)]
        open_bracket = name.count('(') > name.count(')')
        if longer or open_bracket:
            found += 1
            print(f"{s['id']}\t{s['station_number'] or '-'}\t{name}\t"
                  + ('; '.join(f'{t}: {f}' for t, f in longer) or 'an open bracket, and no list has a longer name'))
    print(f'{found} station(s) to look at', file=sys.stderr)
    return 0


def q(v):
    return "'" + str(v).replace("'", "''") + "'"


def sql():
    review = json.load(open(REVIEW))
    rows = review['names']
    out = ['-- Station names Radio Mobile cut at 20 characters: data/station-names/review.json,',
           '-- written by tools/ingest/truncated_names.py --sql. A station is renamed only while',
           '-- it still has the name the review found it with.',
           f"update meganet.station s set name = v.now, updated_by = {q(STAMP)}",
           'from (values']
    out.append(',\n'.join(f"  ({q(r['id'])}, {q(r['was'])}, {q(r['now'])})" for r in rows))
    out.append(') v(id, was, now)')
    out.append('where s.id = v.id and s.name = v.was;')
    print('\n'.join(out))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--find', action='store_true', help='list names that still look cut')
    g.add_argument('--sql', action='store_true', help='write review.json as SQL')
    a = ap.parse_args()
    return find() if a.find else sql()


if __name__ == '__main__':
    sys.exit(main())
