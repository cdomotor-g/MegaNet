#!/usr/bin/env python3
"""
flood_peaks.py — read the Bureau's HDB extract of peak flood heights into
JSON, and load it into MegaNet.

WHAT THIS IS
    `archive/flood-peaks/all-flood-peaks-2026-09-28.txt`, an extract from HDB
    (the Bureau's hydrological database) run on 28/09/2026: the report *Peak
    Flood Heights for the <basin> River Basin (Chronological Listing)* for
    each of 54 Queensland basins, one after the other, each headed by the
    name of the file it was written to (SOUTH_COAST_PEAKS_NEW.TXT, …).

    Under a basin, one block per gauge:

      Station : BEENLEIGH                                  CBM No : 40723
      Stream  : ALBERT RIVER                               AWRC No : 145905
      Flood Classifications : MINOR  3.50  MODERATE  4.50  MAJOR  5.50

         Date (UTC)   Time    Ht (m)   Site   Obs. Source   Obs. Type

         02/04/1989   1100      6.20   B      LOG SHEET     MANUAL OBS
         27/01/1974             8.04   B      OTHER         FLOOD MARK
               1887             8.10   B      OTHER         FLOOD MARK

    The CBM number is the bureau number — `station_number`, less the
    leading zeros `meganet.bureau_key()` strips. Each row is one peak: the
    date and time in UTC, the height on the gauge, the HDB site letter (a
    gauge that has moved has sites A, B, C…), where the figure came from
    (LOG SHEET, DNRM, REGISTER, F521, WRC, CBM CHART, OTHER) and what kind
    of reading it is (INSTRUMENT, MANUAL OBS, FLOOD MARK, UNKNOWN).

    "Chronological" is the report's word, and it is nearly true: a gauge's
    dated rows come first in date order, then the rows HDB holds less of a
    date for — a month and a year, or a year alone (1887 at Beenleigh) — in
    no order. The order printed is kept.

    This writes `data/flood-peaks.json`: every gauge the extract lists and
    every peak under it, whether or not MegaNet has the station, as printed.
    It interprets nothing — which zero a height stands on, and so how high
    the water was in metres AHD, is the database's question
    (`meganet.station_flood_peak`, db/migrations/0037_flood_peaks.sql),
    because the answer is in the station's gauge survey and that can change
    without this file changing.

HOW IT READS IT
    Line by line, each line one of a dozen shapes, and a line that is none
    of them raises rather than being skipped. The columns are tab-aligned but
    not consistently — seven rows at Waller Rd put the source two tabs over,
    and a row with no site has an empty column rather than a short one — so
    a row is read by its tokens in order, not by position: a date (dd/mm/yyyy,
    mm/yyyy or yyyy), a time (hhmm) if there is one, the height, a site letter
    if there is one, then a source and a type from the two vocabularies above.
    A source or type outside them raises.

    Dates are written ISO, as much of one as was printed: 2017-03-30,
    1947-01, 1887. They stay in UTC, as the extract gives them; the station
    record turns them into Queensland dates (the database, below). Times are
    hh:mm UTC. Heights are kept as the literal printed — 8.10 stays 8.10 —
    for the reason db/README.md gives for `numeric`.

    Checked, and a failure raises:
      * a gauge's bureau number appears once in the extract;
      * every date is a real date and every time a real time;
      * every basin's page is dated the same day.

WHAT COUNTS AS THE SAME PEAK TWICE
    A row printed twice — every column the same — is one peak, and the
    second copy is dropped and counted (`duplicates_dropped`, per gauge and
    in total). Nothing else is merged: two rows for one peak that differ in
    the height (11.61 and 11.62 at 15:40 on 20/03/2011) or the source are
    two records HDB holds, and both are kept. The station record picks one
    peak per flood, so neither is counted twice there.

WHAT IS NOT KEPT
    `NO PEAK HEIGHT DATA EXISTS FOR STATION` is printed for a gauge with no
    peaks at all, in place of its block — and so without its name: one is
    the first line of the Logan-Albert listing, above any station. They are
    counted per basin (`gauges_without_peaks`) and that is all that can be
    said of them. `Skipping station 535163 (no HDB_RIVHTSYSTEMS record)` —
    HDB declining to report a gauge — is listed in the meta by number,
    because it says a gauge is missing from the extract rather than that it
    has no floods.

USAGE
    python3 tools/ingest/flood_peaks.py            # rewrite the JSON
    python3 tools/ingest/flood_peaks.py --check    # fail if it would change
    python3 tools/ingest/flood_peaks.py --report   # what came out, in prose
    python3 tools/ingest/flood_peaks.py --sql \\
      | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction

    --sql prints one call to meganet.load_flood_peaks_doc() with the whole
    document in it, which makes the tables match the file. The live database
    fetches the file itself instead —

      select meganet.load_flood_peaks_from_url();

    — for 0028's reason: a 3 MB document is not something anybody pastes.

Standard library only.
"""

import argparse
import collections
import datetime
import hashlib
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE = os.path.join('archive', 'flood-peaks', 'all-flood-peaks-2026-09-28.txt')
OUT_DEFAULT = os.path.join(REPO, 'data', 'flood-peaks.json')
STATIONS_DEFAULT = os.path.join(REPO, 'stations.json')

SOURCES = ('LOG SHEET', 'DNRM', 'REGISTER', 'F521', 'WRC', 'CBM CHART', 'OTHER')
TYPES = ('INSTRUMENT', 'MANUAL OBS', 'FLOOD MARK', 'UNKNOWN')

# One peak in the JSON, in this order — a list rather than an object because
# there are sixty thousand of them, and the meta names the columns.
PEAK_COLUMNS = ['date', 'time_utc', 'height_m', 'site', 'source', 'type']

FILE_RE = re.compile(r'^(?P<file>[A-Z][A-Z_\-]*_PEAKS_NEW\.TXT)$')
DATED_RE = re.compile(r'^Bureau of Meteorology\s+Date: (?P<d>\d\d)/(?P<m>\d\d)/(?P<y>\d{4})$')
BASIN_RE = re.compile(r'^PEAK FLOOD HEIGHTS FOR THE (?P<basin>.+) RIVER BASIN$')
STATION_RE = re.compile(r'^Station : (?P<name>.*?)\s+CBM No : (?P<number>\d+)$')
STREAM_RE = re.compile(r'^Stream\s*:\s*(?P<stream>.*?)\s*AWRC No :\s*(?P<awrc>\S*)$')
CLASSES_RE = re.compile(r'^Flood Classifications : MINOR\s*(?P<minor>-?\d*\.\d+)?\s*'
                        r'MODERATE\s*(?P<moderate>-?\d*\.\d+)?\s*MAJOR\s*(?P<major>-?\d*\.\d+)?$')
HEADER_RE = re.compile(r'^Date \(UTC\)\s+Time\s+Ht \(m\)\s+Site\s+Obs\. Source\s+Obs\. Type$')
ROW_RE = re.compile(
    r'^(?:(?P<day>\d\d)/(?P<month>\d\d)/(?P<year>\d{4})|(?P<mmonth>\d\d)/(?P<myear>\d{4})|(?P<yyear>\d{4}))'
    r'(?:\s+(?P<time>\d{4}))?'
    r'\s+(?P<height>-?\d*\.\d+)'
    r'(?:\s+(?P<site>[A-Z]))?'
    r'\s+(?P<source>' + '|'.join(re.escape(s) for s in SOURCES) + r')'
    r'\s+(?P<type>' + '|'.join(re.escape(t) for t in TYPES) + r')$')
NO_DATA = 'NO PEAK HEIGHT DATA EXISTS FOR STATION'
SKIPPED_RE = re.compile(r'^Skipping station (?P<number>\d+) \((?P<why>[^)]*)\)$')


class ParseError(Exception):
    pass


class Num(str):
    """A figure as the extract prints it — written to JSON unquoted."""


def figure(text, where):
    t = text.strip()
    if t.startswith('.'):
        t = '0' + t
    elif t.startswith('-.'):
        t = '-0' + t[1:]
    try:
        float(t)
    except ValueError:
        raise ParseError(f'{where}: {text!r} is not a number') from None
    return Num(t)


def peak_date(m, where):
    """The date as ISO, as much of one as was printed, and checked."""
    try:
        if m['day']:
            return datetime.date(int(m['year']), int(m['month']), int(m['day'])).isoformat()
        if m['mmonth']:
            datetime.date(int(m['myear']), int(m['mmonth']), 1)
            return f'{m["myear"]}-{m["mmonth"]}'
        return m['yyear']
    except ValueError:
        raise ParseError(f'{where}: {m.group(0).split()[0]!r} is not a date') from None


def peak_time(text, where):
    if text is None:
        return None
    hh, mm = int(text[:2]), int(text[2:])
    if hh > 23 or mm > 59:
        raise ParseError(f'{where}: {text!r} is not a time')
    return f'{text[:2]}:{text[2:]}'


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        h.update(fh.read())
    return h.hexdigest()


# ── Reading ──────────────────────────────────────────────────────────────────

def read(path):
    with open(path, encoding='ascii') as fh:
        lines = fh.read().split('\n')

    gauges, skipped, files, dated = [], [], [], set()
    without = collections.Counter()
    by_number = {}
    basin = file = None
    gauge = None
    expect = None          # the header line a block owes next, if any

    for i, raw in enumerate(lines, 1):
        where = f'{SOURCE} line {i}'
        line = raw.expandtabs(8).strip()
        if expect and line != '':
            if not expect[1].match(line):
                raise ParseError(f'{where}: expected the {expect[0]} line, got {raw!r}')
            m = expect[1].match(line)
            if expect[0] == 'Stream':
                gauge['stream'] = m['stream'] or None
                if m['awrc']:
                    gauge['awrc_number'] = m['awrc']
                expect = ('Flood Classifications', CLASSES_RE)
            elif expect[0] == 'Flood Classifications':
                classes = {f'{k}_m': figure(m[k], where) for k in ('minor', 'moderate', 'major') if m[k]}
                if classes:
                    gauge['classes'] = classes
                expect = ('column heading', HEADER_RE)
            else:
                expect = None
            continue
        if line == '':
            continue

        m = FILE_RE.match(line)
        if m:
            file, basin, gauge = m['file'], None, None
            files.append(file)
            continue
        m = DATED_RE.match(line)
        if m:
            dated.add(f'{m["y"]}-{m["m"]}-{m["d"]}')
            continue
        m = BASIN_RE.match(line)
        if m:
            if file is None:
                raise ParseError(f'{where}: a basin with no file name above it')
            basin = m['basin']
            continue
        if line == '(Chronological Listing)':
            continue
        m = STATION_RE.match(line)
        if m:
            if basin is None:
                raise ParseError(f'{where}: a station outside any basin')
            number = m['number']
            if number.lstrip('0') in by_number:
                raise ParseError(f'{where}: bureau number {number} is in the extract twice '
                                 f'(first at line {by_number[number.lstrip("0")]["_line"]})')
            gauge = {'bureau_number': number, 'name': m['name'].strip(), 'stream': None,
                     'basin': basin, 'file': file, 'peaks': [], '_line': i,
                     'duplicates_dropped': 0}
            by_number[number.lstrip('0')] = gauge
            gauges.append(gauge)
            expect = ('Stream', STREAM_RE)
            continue
        m = ROW_RE.match(line)
        if m:
            if gauge is None:
                raise ParseError(f'{where}: a peak under no station')
            row = [peak_date(m, where), peak_time(m['time'], where), figure(m['height'], where),
                   m['site'], m['source'], m['type']]
            if row in gauge['peaks']:
                gauge['duplicates_dropped'] += 1
            else:
                gauge['peaks'].append(row)
            continue
        if line == NO_DATA:
            if basin is None:
                raise ParseError(f'{where}: "{NO_DATA}" outside any basin')
            without[basin] += 1
            continue
        m = SKIPPED_RE.match(line)
        if m:
            skipped.append({'bureau_number': m['number'], 'reason': m['why'], 'basin': basin,
                            'file': file})
            continue
        raise ParseError(f'{where}: not a line this reads: {raw!r}')

    if expect:
        raise ParseError(f'{SOURCE}: the last station is missing its {expect[0]} line')
    if len(dated) != 1:
        raise ParseError(f'{SOURCE}: the basins are dated {sorted(dated)}, not one day')
    for g in gauges:
        del g['_line']
    return gauges, skipped, files, dated.pop(), without


def build(path=None):
    path = path or os.path.join(REPO, SOURCE)
    gauges, skipped, files, extracted, without = read(path)
    ordered = []
    for g in gauges:
        out = {k: g[k] for k in ('bureau_number', 'name', 'stream', 'awrc_number', 'basin',
                                 'file', 'classes') if g.get(k) is not None}
        if g['duplicates_dropped']:
            out['duplicates_dropped'] = g['duplicates_dropped']
        out['peaks'] = g['peaks']
        ordered.append(out)
    peaks = sum(len(g['peaks']) for g in ordered)
    precision = collections.Counter(len(p[0]) for g in ordered for p in g['peaks'])
    meta = {
        'title': 'Peak flood heights, Queensland river basins (HDB, chronological listing)',
        'extracted': extracted,
        'generator': 'tools/ingest/flood_peaks.py',
        'source': {'file': SOURCE, 'sha256': sha256(path), 'bytes': os.path.getsize(path),
                   'basins': len(files)},
        'peak_columns': PEAK_COLUMNS,
        'columns': {
            'date': 'UTC, ISO, as much as HDB holds: yyyy-mm-dd, yyyy-mm or yyyy',
            'time_utc': 'hh:mm UTC, or null where none is printed',
            'height_m': 'metres on the gauge, as printed',
            'site': 'the HDB site letter, or null where none is printed',
            'source': ' | '.join(SOURCES),
            'type': ' | '.join(TYPES),
        },
        'gauges': len(ordered),
        'peaks': peaks,
        'dated_to_the_day': precision[10],
        'dated_to_the_month': precision[7],
        'dated_to_the_year': precision[4],
        'duplicates_dropped': sum(g.get('duplicates_dropped', 0) for g in ordered),
        'gauges_without_peaks': sum(without.values()),
        'gauges_without_peaks_by_basin': dict(without),
        'skipped_by_hdb': skipped,
    }
    return {'meta': meta, 'gauges': ordered}


# ── Output ───────────────────────────────────────────────────────────────────

def dump_value(v):
    return str(v) if isinstance(v, Num) else json.dumps(v, ensure_ascii=False)


def dump_peak(p):
    return '[' + ','.join(dump_value(v) for v in p) + ']'


def dump_gauge(g):
    head = ','.join(f'{json.dumps(k)}:{json.dumps(v, ensure_ascii=False) if k != "classes" else dump_classes(v)}'
                    for k, v in g.items() if k != 'peaks')
    return '{' + head + ',"peaks":[\n' + ',\n'.join(dump_peak(p) for p in g['peaks']) + '\n]}'


def dump_classes(c):
    return '{' + ','.join(f'{json.dumps(k)}:{dump_value(v)}' for k, v in c.items()) + '}'


def render(doc):
    return ('{\n"meta": ' + json.dumps(doc['meta'], ensure_ascii=False) + ',\n"gauges": [\n'
            + ',\n'.join(dump_gauge(g) for g in doc['gauges']) + '\n]\n}\n')


def render_sql(doc, body=None):
    body = body if body is not None else render(doc)
    if '$flood_peaks$' in body:
        raise ParseError('the document contains the SQL quote this uses')
    return ('-- Generated by tools/ingest/flood_peaks.py — do not edit.\n'
            '-- Makes meganet.flood_peak_gauge and meganet.flood_peak match data/flood-peaks.json\n'
            f'-- ({doc["meta"]["gauges"]} gauges, {doc["meta"]["peaks"]} peaks, extracted '
            f'{doc["meta"]["extracted"]}).\n'
            '--\n'
            '--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f this.sql\n'
            'select meganet.load_flood_peaks_doc($flood_peaks$' + body + '$flood_peaks$::jsonb);\n')


def report(doc, stations_path):
    meta = doc['meta']
    print(meta['title'])
    print(f'  extracted {meta["extracted"]}: {meta["source"]["basins"]} basins, '
          f'{meta["gauges"]} gauges, {meta["peaks"]} peaks '
          f'({meta["duplicates_dropped"]} printed twice and dropped)')
    print(f'  dated to the day {meta["dated_to_the_day"]}, to the month '
          f'{meta["dated_to_the_month"]}, to the year {meta["dated_to_the_year"]}')
    print(f'  {meta["gauges_without_peaks"]} gauges have no peaks, and HDB does not name them')
    for s in meta['skipped_by_hdb']:
        print(f'  HDB skipped {s["bureau_number"]} in {s["basin"]}: {s["reason"]}')
    if not os.path.exists(stations_path):
        return
    with open(stations_path, encoding='utf-8') as fh:
        keyed = {(s.get('station_number') or '').strip().lstrip('0'): s
                 for s in json.load(fh)['stations'] if (s.get('station_number') or '').strip()}
    mine = [g for g in doc['gauges'] if g['bureau_number'].lstrip('0') in keyed]
    print(f'  {len(mine)} gauges are MegaNet stations, with '
          f'{sum(len(g["peaks"]) for g in mine)} peaks; '
          f'{len(doc["gauges"]) - len(mine)} are not, and are kept for when they are')
    by_basin = collections.Counter(g['basin'] for g in doc['gauges'])
    print('  gauges by basin: ' + ', '.join(f'{b.title()} {n}' for b, n in by_basin.most_common()))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1].strip())
    ap.add_argument('--out', default=OUT_DEFAULT)
    ap.add_argument('--check', action='store_true', help='fail if the JSON would change')
    ap.add_argument('--report', action='store_true', help='what came out, in prose')
    ap.add_argument('--sql', action='store_true',
                    help='print the SQL that makes the tables match the file')
    ap.add_argument('--stations', default=STATIONS_DEFAULT,
                    help='for --report: which bureau numbers are MegaNet stations')
    a = ap.parse_args(argv)

    try:
        doc = build()
    except ParseError as e:
        print(f'error: {e}', file=sys.stderr)
        return 2

    if a.report:
        report(doc, a.stations)
        return 0
    body = render(doc)
    if a.sql:
        sys.stdout.write(render_sql(doc, body))
        return 0
    if a.check:
        have = open(a.out, encoding='utf-8').read() if os.path.exists(a.out) else None
        if have != body:
            print(f'{a.out}: would change — rerun without --check', file=sys.stderr)
            return 1
        print(f'{a.out}: up to date')
        return 0
    with open(a.out, 'w', encoding='utf-8') as fh:
        fh.write(body)
    print(f'{a.out}: {doc["meta"]["gauges"]} gauges, {doc["meta"]["peaks"]} peaks, '
          f'{len(body):,} bytes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
