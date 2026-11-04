#!/usr/bin/env python3
"""
benchmarks.py — read the Bureau's benchmark details for its Queensland river
height stations into JSON, and load them into MegaNet.

WHAT THIS IS
    `benchmarks/benchmark-details-2026-10-15.txt` in the private repository
    cdomotor-g/flood-net-private (tools/ingest/private.py finds it): the
    report *Queensland Flood Warning River Height Stations — Benchmark
    Details*, printed from HDB (the Bureau's hydrological database) on
    15/10/2026, 40 pages. It is the same family as the station lists Sections
    1–9 that river_height_stations.py reads — the same page head, the same
    basin and station number columns — and it says what Section 6 does not:
    the marks each gauge is levelled from.

    One row per benchmark, as many as HDB holds for the station:

      Basin        the river basin, printed on a basin's first row and again at
                   the top of each page
      Station No   the bureau number, padded to six — `station_number` less
                   the leading zeros `meganet.bureau_key()` strips
      Station Name as HDB has it ("CARRARA ALERT")
      Benchmark    the mark's level in metres, to the centimetre
      Datum        AHD, ASSUM, STATE or UNKNOWN — meganet.gauge_datum's codes
      Description  what the mark is and where ("PSM 46757", "TBM bolt in gum
                   18m and 294deg from corner of pump shed")
      Comments     anything else the office wrote down — who surveyed it, the
                   orifice's level, an adjustment to old records

    It is in the private repository, not this one, because a benchmark's
    description and position are editors' in the database (0060's rule, kept
    by 0101) and not for the open internet.

HOW IT READS IT
    Positionally, as river_height_stations.py reads Sections 1–6: each page's
    column rule — the line of dashes under the headings — *is* the column
    layout, the spans are read off it, and every page's rule is checked to be
    the same one. A row whose text strays into the gap between two columns
    raises rather than being read.

    A field too long for its column carries on underneath, on a line with no
    station number, sometimes after a page break and its whole page head. That
    line belongs to the row above it, column by column. All three columns that
    wrap — the station name, the description and the comment — are wrapped at
    a word, so the pieces join with one space: every one of the 85 joints where
    a piece fills its column to the last character falls between two words. A
    continuation line with anything in the basin, number, benchmark or datum
    column raises.

    Levels are kept as the literal printed — 104.26 stays 104.26 — for the
    reason db/README.md gives for `numeric`. Nothing else is interpreted: the
    level on the gauge is the database's question (meganet.station_benchmark,
    db/migrations/0101_station_benchmarks.sql), because the answer is in the
    station's gauge survey, and that can change without this file changing.

    Checked, and a failure raises:
      * every page is dated the same day, and numbered in order from 1;
      * every row has a basin, a station name, a level and a datum from the
        four codes (a description it may lack: Ida Creek's is blank);
      * a station's rows are printed together, under one name and one basin;
      * the file is ASCII, but for one byte: 0xBF, which the export wrote for
        a dash at Cairns Airport ("Origin of Level – Deep Driven Mark"), and is
        read as one. Any other byte above 0x7F raises.

USAGE
    python3 tools/ingest/benchmarks.py            # rewrite the JSON (private repo)
    python3 tools/ingest/benchmarks.py --check    # fail if it would change
    python3 tools/ingest/benchmarks.py --report   # what came out, in prose
    python3 tools/ingest/benchmarks.py --sql \\
      | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction

    --sql prints one call to meganet.load_benchmarks_doc() with the whole
    document in it, which makes the table match the file. There is no
    load-from-URL road, as there is for the public flood peaks (0037): the
    file is in a private repository, which the database cannot fetch.

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

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import private  # noqa: E402

REPO = os.path.dirname(os.path.dirname(HERE))
SOURCE_NAME = 'benchmark-details-2026-10-15.txt'
# How the document names the file it came from: a path in the private
# repository, the same wherever the checkout is.
SOURCE = 'flood-net-private/benchmarks/' + SOURCE_NAME
SOURCE_PATH = os.path.join(private.BENCHMARKS, SOURCE_NAME)
OUT_DEFAULT = os.path.join(private.BENCHMARKS, 'benchmarks.json')
STATIONS_DEFAULT = os.path.join(REPO, 'stations.json')

DATUMS = ('AHD', 'ASSUM', 'STATE', 'UNKNOWN')
COLUMNS = ['basin', 'number', 'name', 'level', 'datum', 'description', 'comment']
WRAPS = ('name', 'description', 'comment')

# One benchmark in the JSON, in this order — a list rather than an object, and
# the meta names the columns.
BENCHMARK_COLUMNS = ['level_m', 'datum', 'description', 'comment']

PAGE_RE = re.compile(r'^Date: (?P<d>\d\d)/(?P<m>\d\d)/(?P<y>\d{4})\s+Benchmarks\s+Page:\s+(?P<page>\d+)$')
HEAD_LINES = (
    re.compile(r'^QUEENSLAND FLOOD WARNING RIVER HEIGHT STATIONS$'),
    re.compile(r'^BENCHMARK DETAILS$'),
    re.compile(r'^Station\s+Benchmark$'),
    re.compile(r'^Basin\s+No\s+Station Name\s+\(m\)\s+Datum\s+Description\s+Comments$'),
)
RULE_RE = re.compile(r'^-+( -+){6}$')
LEVEL_RE = re.compile(r'^-?\d+\.\d+$')
NUMBER_RE = re.compile(r'^\d{6}$')

# The one byte above 0x7F the export wrote, and what it stands for.
STRAY = {0xBF: '–'}


class ParseError(Exception):
    pass


class Num(str):
    """A figure as the report prints it — written to JSON unquoted."""


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        h.update(fh.read())
    return h.hexdigest()


def decode(raw):
    """ASCII, but for the bytes STRAY names; anything else above 0x7F raises."""
    out, strays = [], []
    line = 1
    for b in raw:
        if b == 0x0A:
            line += 1
        if b < 0x80:
            out.append(chr(b))
        elif b in STRAY:
            out.append(STRAY[b])
            strays.append({'line': line, 'byte': f'0x{b:02X}', 'read_as': STRAY[b]})
        else:
            raise ParseError(f'{SOURCE} line {line}: byte 0x{b:02X} is not one this reads')
    return ''.join(out), strays


# ── Reading ──────────────────────────────────────────────────────────────────

def read(path):
    with open(path, 'rb') as fh:
        text, strays = decode(fh.read())
    if '\r' in text:
        raise ParseError(f'{SOURCE}: carriage returns — the file has been through a line-ending rewrite')
    lines = text.split('\n')

    spans = rule = None
    dated, pages = set(), []
    head = None            # index into HEAD_LINES the page head owes next, or None
    basin = None
    rows = []

    for i, raw in enumerate(lines, 1):
        where = f'{SOURCE} line {i}'
        line = raw.rstrip()
        m = PAGE_RE.match(line.strip())
        if m:
            try:
                datetime.date(int(m['y']), int(m['m']), int(m['d']))
            except ValueError:
                raise ParseError(f'{where}: the page is dated {m["d"]}/{m["m"]}/{m["y"]}, which is not a date') from None
            dated.add(f'{m["y"]}-{m["m"]}-{m["d"]}')
            page = int(m['page'])
            if page != len(pages) + 1:
                raise ParseError(f'{where}: page {page} follows page {len(pages)}')
            pages.append(i)
            head = 0
            continue
        if head is not None:
            if line == '':
                continue
            if head < len(HEAD_LINES):
                if not HEAD_LINES[head].match(line.strip()):
                    raise ParseError(f'{where}: expected the page head, got {raw!r}')
                head += 1
                continue
            if not RULE_RE.match(line):
                raise ParseError(f'{where}: expected the column rule, got {raw!r}')
            if rule is None:
                rule = line
                spans = [(m.start(), m.end()) for m in re.finditer(r'-+', line)]
            elif line != rule:
                raise ParseError(f'{where}: this page\'s column rule is not the first page\'s')
            head = None
            continue
        if line == '':
            continue
        if spans is None:
            raise ParseError(f'{where}: a row before any page head: {raw!r}')
        if len(line) > spans[-1][1]:
            raise ParseError(f'{where}: text past the last column: {raw!r}')

        for k in range(len(spans) - 1):
            gap = line[spans[k][1]:spans[k + 1][0]]
            if gap.strip():
                raise ParseError(f'{where}: text in the gap after the {COLUMNS[k]} column: {raw!r}')
        f = dict(zip(COLUMNS, (line[a:b].strip() for a, b in spans)))

        if f['number']:
            if not NUMBER_RE.match(f['number']):
                raise ParseError(f'{where}: {f["number"]!r} is not a station number')
            if f['basin']:
                basin = f['basin']
            if basin is None:
                raise ParseError(f'{where}: a row under no basin')
            if not LEVEL_RE.match(f['level']):
                raise ParseError(f'{where}: {f["level"]!r} is not a level')
            if f['datum'] not in DATUMS:
                raise ParseError(f'{where}: {f["datum"]!r} is not one of {", ".join(DATUMS)}')
            if not f['name']:
                raise ParseError(f'{where}: a row with no station name')
            rows.append({'_line': i, 'basin': basin, 'number': f['number'], 'level': Num(f['level']),
                         'datum': f['datum'], **{k: [f[k]] if f[k] else [] for k in WRAPS}})
            continue

        # A continuation: the row above, carried on. Only the wrapping columns.
        if f['basin'] or f['level'] or f['datum']:
            raise ParseError(f'{where}: a line with no station number, but something in a column that does not wrap: {raw!r}')
        if not rows:
            raise ParseError(f'{where}: a continuation with no row above it')
        for k in WRAPS:
            if f[k]:
                rows[-1][k].append(f[k])

    if head is not None:
        raise ParseError(f'{SOURCE}: the last page head is not finished')
    if len(dated) != 1:
        raise ParseError(f'{SOURCE}: the pages are dated {sorted(dated)}, not one day')
    return rows, pages, dated.pop(), strays


def build(path=None):
    path = path or SOURCE_PATH
    private.require(path)
    rows, pages, printed, strays = read(path)

    stations, by_number = [], {}
    for r in rows:
        name = ' '.join(r['name'])
        key = r['number'].lstrip('0')
        s = by_number.get(key)
        if s is None:
            s = {'bureau_number': r['number'], 'name': name, 'basin': r['basin'], 'benchmarks': [], '_last': r['_line']}
            by_number[key] = s
            stations.append(s)
        else:
            if stations[-1] is not s:
                raise ParseError(f'{SOURCE} line {r["_line"]}: station {r["number"]} again, after another station '
                                 f'(it was last at line {s["_last"]})')
            if s['name'] != name or s['basin'] != r['basin'] or s['bureau_number'] != r['number']:
                raise ParseError(f'{SOURCE} line {r["_line"]}: station {r["number"]} printed as '
                                 f'{r["number"]} {name!r} in {r["basin"]}, and before as '
                                 f'{s["bureau_number"]} {s["name"]!r} in {s["basin"]}')
            s['_last'] = r['_line']
        s['benchmarks'].append([r['level'], r['datum'], ' '.join(r['description']) or None,
                                ' '.join(r['comment']) or None])
    for s in stations:
        del s['_last']

    marks = [b for s in stations for b in s['benchmarks']]
    meta = {
        'title': 'Queensland flood warning river height stations — benchmark details (HDB)',
        'printed': printed,
        'generator': 'tools/ingest/benchmarks.py',
        'source': {'file': SOURCE, 'sha256': sha256(path), 'bytes': os.path.getsize(path),
                   'pages': len(pages)},
        'benchmark_columns': BENCHMARK_COLUMNS,
        'columns': {
            'level_m': 'the benchmark\'s level in metres, as printed, in its datum',
            'datum': ' | '.join(DATUMS) + ' (meganet.gauge_datum)',
            'description': 'what the mark is and where, its wrapped lines joined with a space, or null where it is empty',
            'comment': 'the Comments column, joined the same way, or null where it is empty',
        },
        'stations': len(stations),
        'benchmarks': len(marks),
        'by_datum': dict(collections.Counter(b[1] for b in marks).most_common()),
        'stations_by_basin': dict(collections.Counter(s['basin'] for s in stations)),
        'stray_bytes': strays,
    }
    return {'meta': meta, 'stations': stations}


# ── Output ───────────────────────────────────────────────────────────────────

def dump_value(v):
    return str(v) if isinstance(v, Num) else json.dumps(v, ensure_ascii=False)


def dump_station(s):
    head = ','.join(f'{json.dumps(k)}:{json.dumps(v, ensure_ascii=False)}' for k, v in s.items() if k != 'benchmarks')
    return ('{' + head + ',"benchmarks":[\n'
            + ',\n'.join('[' + ','.join(dump_value(v) for v in b) + ']' for b in s['benchmarks']) + '\n]}')


def render(doc):
    return ('{\n"meta": ' + json.dumps(doc['meta'], ensure_ascii=False) + ',\n"stations": [\n'
            + ',\n'.join(dump_station(s) for s in doc['stations']) + '\n]\n}\n')


def render_sql(doc, body=None):
    body = body if body is not None else render(doc)
    if '$benchmarks$' in body:
        raise ParseError('the document contains the SQL quote this uses')
    return ('-- Generated by tools/ingest/benchmarks.py — do not edit, and do not commit:\n'
            '-- it carries every benchmark\'s description, which is editors\' (0101).\n'
            '-- Makes meganet.bureau_benchmark match the benchmark details\n'
            f'-- ({doc["meta"]["stations"]} stations, {doc["meta"]["benchmarks"]} benchmarks, printed '
            f'{doc["meta"]["printed"]}).\n'
            '--\n'
            '--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f this.sql\n'
            'select meganet.load_benchmarks_doc($benchmarks$' + body + '$benchmarks$::jsonb);\n')


def report(doc, stations_path):
    meta = doc['meta']
    print(meta['title'])
    print(f'  printed {meta["printed"]}: {meta["source"]["pages"]} pages, {meta["stations"]} stations, '
          f'{meta["benchmarks"]} benchmarks')
    print('  by datum: ' + ', '.join(f'{k} {v}' for k, v in meta['by_datum'].items()))
    many = collections.Counter(len(s['benchmarks']) for s in doc['stations'])
    print('  benchmarks a station has: ' + ', '.join(f'{n}: {many[n]} stations' for n in sorted(many)))
    for s in meta['stray_bytes']:
        print(f'  line {s["line"]}: byte {s["byte"]} read as {s["read_as"]!r}')
    if os.path.exists(stations_path):
        with open(stations_path, encoding='utf-8') as fh:
            keyed = {(s.get('station_number') or '').strip().lstrip('0')
                     for s in json.load(fh)['stations'] if (s.get('station_number') or '').strip()}
        mine = [s for s in doc['stations'] if s['bureau_number'].lstrip('0') in keyed]
        print(f'  {len(mine)} of the {len(doc["stations"])} stations are in stations.json '
              f'(the snapshot; the database is the one that counts)')
    by_basin = collections.Counter(s['basin'] for s in doc['stations'])
    print('  stations by basin: ' + ', '.join(f'{b.title()} {n}' for b, n in by_basin.most_common()))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1].strip())
    ap.add_argument('--source', default=SOURCE_PATH, help='the report (default: the private checkout\'s)')
    ap.add_argument('--out', default=OUT_DEFAULT)
    ap.add_argument('--check', action='store_true', help='fail if the JSON would change')
    ap.add_argument('--report', action='store_true', help='what came out, in prose')
    ap.add_argument('--sql', action='store_true', help='print the SQL that makes the table match the file')
    ap.add_argument('--stations', default=STATIONS_DEFAULT,
                    help='for --report: which bureau numbers are in the stations snapshot')
    a = ap.parse_args(argv)

    try:
        doc = build(a.source)
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
    print(f'{a.out}: {doc["meta"]["stations"]} stations, {doc["meta"]["benchmarks"]} benchmarks, '
          f'{len(body):,} bytes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
