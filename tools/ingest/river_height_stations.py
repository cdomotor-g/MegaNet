#!/usr/bin/env python3
"""
river_height_stations.py — read the Bureau's river height station lists into JSON,
and attach what they say to the MegaNet stations they describe.

WHAT THIS IS
    "Queensland Flood Warning River Height Stations" is a Bureau report printed
    in sections, one table per section, every row keyed on the bureau number —
    the same number `meganet.station.station_number` carries. Four of them are
    in `archive/river-height-stations/`:

      section-4   Flood classifications, 25/09/2026 ......... flood_classes
      section-4b  Flood classifications, 15/01/2014 ......... flood_classes
      section-5   Details of crossings, 25/09/2026 .......... crossings
      section-6   Survey details, 25/09/2026 ................ gauge_survey

    Section 4 is the first-report, minor, crops-and-grazing, moderate, towns
    and major heights, plus the height of the crossing the gauge is read
    against and what kind of crossing it is. Section 4 (B) is the same table
    from 2014: superseded, and kept, because it is the only record of the
    levels a station had before and of stations the 2026 list has dropped.
    Section 5 names those crossings and the stream each is on. Section 6 is the
    gauge itself: what height its zero stands at, in which datum and since
    when — a history, several rows for a gauge that has been re-levelled — and
    two facts about where it is on the river:

      AMTD   Adopted Middle Thread Distance: kilometres along the middle of the
             stream from its mouth (or from its junction with the stream it
             joins) up to the gauge. How the Bureau says where on a river a
             gauge is, and what orders the gauges on one river.
      Area   the catchment area above the gauge, in km².

    This writes `data/river-height-stations.json`, the four sections as written
    — every station they list, including the ~half MegaNet has no station for —
    and, with --sql, the SQL that attaches each row to the station it belongs
    to. It interprets nothing; the card and the editor do that.

HOW IT READS THEM
    Positionally. Sections 4, 5 and 6 are fixed-width, and each page's column
    rule — the line of dashes under the headings — *is* the column layout, so
    the spans are read off it rather than written down here, and every page's
    rule is checked to be the same one. A row whose text strays into the gap
    between two columns raises rather than being read.

    **A field too long for its column carries on underneath**, on a line with
    no station number, sometimes after a page break and its whole page header.
    That line belongs to the row above it, column by column. Two different
    wraps happen, and joining them the same way would be wrong for one:

      the station name   is wrapped at a word — "BONOGIN CK (HARDYS RD)" over
                         "ALERT" — so the pieces join with a space. Checked
                         against the 2014 edition, which prints the same names
                         unwrapped: every one agrees.
      the stream         is cut at the column edge, mid-word if need be —
                         "SANDY CK (NORTH BRANCH" over ")" — so a piece that
                         filled its column joins the next with nothing.

    A wrap in any other column raises: nothing does it today, and a third rule
    should be decided by somebody looking at it rather than guessed here.

    Section 4 (B) is older and differently made: the columns are tab-aligned,
    the basin is a line of its own, and nothing wraps. Expanded at 8, every
    figure ends on one of seven fixed columns and every crossing type sits in
    one — which is checked, so a figure that lands anywhere else raises.

    Figures are kept as the literal the page printed — 94.50 stays 94.50 —
    because the database stores `numeric` for the reason db/README.md gives.
    Two literals are tidied: `.02` gains its leading zero, which JSON needs,
    and the 2014 edition's `-0.0` (its one-decimal rounding of -0.03) is 0.0,
    because a numeric has no negative zero to keep it in.

WHAT IS NOT KEPT
    A row with nothing in it: 4 of the 2026 flood classification rows and 362
    of the 2014 ones name a station and print no figure at all. They carry no
    fact, and stored they would be a flood classes block with nothing in it.

USAGE
    python3 tools/ingest/river_height_stations.py            # rewrite the JSON
    python3 tools/ingest/river_height_stations.py --check    # fail if it would change
    python3 tools/ingest/river_height_stations.py --report   # what came out, in prose
    python3 tools/ingest/river_height_stations.py --sql \\
      | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction

    The SQL attaches rows by bureau number to live stations only, and only
    where the station has none of its own yet — per edition for flood classes
    and crossings, per station for the survey. So it is safe to run again after
    stations are added, and it never overwrites a row somebody has since edited
    in the station editor. db/migrations/0031_river_height_details.sql is what
    it writes into.

Standard library only.
"""

import argparse
import collections
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ARCHIVE = os.path.join('archive', 'river-height-stations')
OUT_DEFAULT = os.path.join(REPO, 'data', 'river-height-stations.json')
TAG = 'river_height_stations.py'


class ParseError(Exception):
    pass


# ── The four documents ───────────────────────────────────────────────────────
# `columns` names the column rule's dash groups in order; `wrap` says how a
# column that overflows onto the next line joins back (see the head of the
# file). `section` and `title` are what the page header must say, checked on
# every page before a row on it is read.
SOURCES = [
    {
        'file': 'section-4-flood-classifications-2026-09-25.txt',
        'key': 'flood_classes', 'section': '4', 'title': 'FLOOD CLASSIFICATIONS',
        'layout': 'fixed',
        'columns': ['basin', 'number', 'station_name', 'first_report_m',
                    'crossing_height_m', 'crossing_type', 'minor_m',
                    'crops_grazing_m', 'moderate_m', 'towns_m', 'major_m'],
        'wrap': {'station_name': 'word'},
    },
    {
        'file': 'section-4b-flood-classifications-2014-01-15.txt',
        'key': 'flood_classes', 'section': '4 (B)', 'title': 'FLOOD CLASSIFICATIONS',
        'layout': 'tabbed',
    },
    {
        'file': 'section-5-crossings-2026-09-25.txt',
        'key': 'crossings', 'section': '5', 'title': 'DETAILS OF CROSSINGS',
        'layout': 'fixed',
        'columns': ['basin', 'number', 'station_name', 'stream', 'height_m',
                    'crossing_type', 'name'],
        'wrap': {'station_name': 'word', 'stream': 'cut'},
    },
    {
        'file': 'section-6-survey-details-2026-09-25.txt',
        'key': 'gauge_survey', 'section': '6', 'title': 'SURVEY DETAILS',
        'layout': 'fixed',
        'columns': ['basin', 'number', 'station_name', 'amtd_km', 'gauge_zero_m',
                    'datum', 'valid_from', 'valid_to', 'catchment_area_km2'],
        'wrap': {'station_name': 'word'},
    },
]

# Section 4 (B), tabs expanded at 8: the column each figure's last character
# lands on, and the one column the crossing type is printed in.
TABBED_ENDS = {51: 'first_report_m', 58: 'crossing_height_m', 70: 'minor_m',
               79: 'crops_grazing_m', 88: 'moderate_m', 97: 'towns_m', 106: 'major_m'}
TABBED_TYPE_AT = 61

# Field order in the JSON, per section. Absent means the page printed nothing.
FIELDS = {
    'flood_classes': ['bureau_number', 'station_name', 'basin', 'as_at',
                      'first_report_m', 'crossing_height_m', 'crossing_type',
                      'minor_m', 'crops_grazing_m', 'moderate_m', 'towns_m', 'major_m'],
    'crossings':     ['bureau_number', 'station_name', 'basin', 'as_at',
                      'stream', 'name', 'height_m', 'crossing_type'],
    'gauge_survey':  ['bureau_number', 'station_name', 'basin', 'valid_from',
                      'valid_to', 'gauge_zero_m', 'datum', 'amtd_km',
                      'catchment_area_km2'],
}
NUMERIC = {'first_report_m', 'crossing_height_m', 'minor_m', 'crops_grazing_m',
           'moderate_m', 'towns_m', 'major_m', 'height_m', 'gauge_zero_m',
           'amtd_km', 'catchment_area_km2'}
DATES = {'valid_from', 'valid_to'}
# What a flood classification row has to print at least one of to be kept.
FLOOD_FIGURES = ['first_report_m', 'crossing_height_m', 'crossing_type', 'minor_m',
                 'crops_grazing_m', 'moderate_m', 'towns_m', 'major_m']

HEADER_RE = re.compile(r'^Date: (\d{2})/(\d{2})/(\d{4})\s+SECTION (\d+(?: \([A-Z]\))?)\s+'
                       r'Page:\s+(\d+)\s*$')
NUMBER_RE = re.compile(r'-?(?:\d+\.\d*|\.\d+|\d+)')
DATE_RE = re.compile(r'(\d{2})/(\d{2})/(\d{4})')
LEGEND_RE = re.compile(r'\b([A-Z]): ([A-Z][a-z]+(?: [A-Z][a-z]+)*)')
BASIN_RE = re.compile(r"[A-Z][A-Z' -]*[A-Z]")


class Num(str):
    """A figure as the page printed it — written to JSON and SQL unquoted."""


def number(text, where):
    t = text.strip()
    if not t:
        return None
    if not NUMBER_RE.fullmatch(t):
        raise ParseError(f'{where}: {t!r} is not a number')
    sign, body = ('-', t[1:]) if t.startswith('-') else ('', t)
    if body.startswith('.'):
        body = '0' + body
    if body.endswith('.'):
        body += '0'
    if sign and float(body) == 0:
        sign = ''
    return Num(sign + body)


def iso_date(text, where):
    t = text.strip()
    if not t:
        return None
    m = DATE_RE.fullmatch(t)
    if not m:
        raise ParseError(f'{where}: {t!r} is not a dd/mm/yyyy date')
    d, mo, y = m.groups()
    if not (1 <= int(mo) <= 12 and 1 <= int(d) <= 31):
        raise ParseError(f'{where}: {t!r} is not a date')
    return f'{y}-{mo}-{d}'


def page_header(line, src, where, state):
    """A page's first line. Every page must be the same document, in order."""
    m = HEADER_RE.match(line)
    if not m:
        return False
    d, mo, y, section, page = m.groups()
    dated = f'{y}-{mo}-{d}'
    if section != src['section']:
        raise ParseError(f'{where}: SECTION {section}, expected SECTION {src["section"]}')
    if state['dated'] not in (None, dated):
        raise ParseError(f'{where}: dated {dated}, earlier pages {state["dated"]}')
    if int(page) != len(state['pages']) + 1:
        raise ParseError(f'{where}: page {page} follows page {len(state["pages"])}')
    state['dated'] = dated
    state['pages'].append(int(page))
    return True


def read_fixed(src, lines):
    rules = {l.rstrip() for l in lines if l.startswith('-----')}
    if len(rules) != 1:
        raise ParseError(f'{src["file"]}: the column rule is not the same on every page')
    rule = rules.pop()
    spans = [(m.start(), m.end()) for m in re.finditer(r'-+', rule)]
    cols = src['columns']
    if len(spans) != len(cols):
        raise ParseError(f'{src["file"]}: {len(spans)} columns in the rule, expected {len(cols)}')
    width = {c: b - a for c, (a, b) in zip(cols, spans)}
    gaps = {i for (_, b1), (a2, _) in zip(spans, spans[1:]) for i in range(b1, a2)}

    state = {'dated': None, 'pages': [], 'legend': {}, 'wrapped': 0, 'title_seen': False}
    rows, basin, prev, in_header = [], None, None, False
    for n, raw in enumerate(lines, 1):
        line = raw.rstrip()
        where = f'{src["file"]}:{n}'
        if not line.strip():
            continue
        if page_header(line, src, where, state):
            in_header = True
            continue
        if in_header:
            # Everything between the Date line and the column rule is the
            # page's title and headings.
            if line.strip() == src['title']:
                state['title_seen'] = True
            if line.startswith('-----'):
                in_header = False
            continue
        if LEGEND_RE.search(line) or line.strip() == 'T: Highest Astronomical Tide':
            state['legend'].update(LEGEND_RE.findall(line))
            if 'Highest Astronomical Tide' in line:
                state['legend']['T'] = 'Highest Astronomical Tide'
            continue
        stray = sorted(i for i in gaps if i < len(line) and line[i] != ' ')
        if stray or len(line) > spans[-1][1]:
            raise ParseError(f'{where}: text outside the columns — {line!r}')
        f = {c: line[a:b].strip() for c, (a, b) in zip(cols, spans)}

        if f['number']:
            if not re.fullmatch(r'\d{6}', f['number']):
                raise ParseError(f'{where}: {f["number"]!r} is not a bureau number')
            if f['basin']:
                if not BASIN_RE.fullmatch(f['basin']):
                    raise ParseError(f'{where}: {f["basin"]!r} is not a basin')
                basin = f['basin']
            if basin is None:
                raise ParseError(f'{where}: a station before any basin')
            f['basin'] = basin
            f['_where'] = where
            f['_last'] = {c: f[c] for c in cols}
            rows.append(f)
            prev = f
            continue

        # A continuation line: whatever overflowed from the row above.
        if prev is None:
            raise ParseError(f'{where}: a continuation line with no row above it')
        for c in cols:
            if not f[c]:
                continue
            how = src['wrap'].get(c)
            if how is None:
                raise ParseError(f'{where}: the {c} column wrapped, which this reader '
                                 f'has no rule for — {line!r}')
            last = prev['_last'][c]
            joint = '' if how == 'cut' and len(last) == width[c] else ' '
            prev[c] = prev[c] + joint + f[c] if prev[c] else f[c]
            prev['_last'][c] = f[c]
            state['wrapped'] += 1
    if not state['title_seen']:
        raise ParseError(f'{src["file"]}: no page is headed {src["title"]!r}')
    return rows, state


def read_tabbed(src, lines):
    state = {'dated': None, 'pages': [], 'legend': {}, 'wrapped': 0, 'title_seen': False}
    rows, basin, in_header = [], None, False
    for n, raw in enumerate(lines, 1):
        line = raw.expandtabs(8).rstrip()
        where = f'{src["file"]}:{n}'
        if not line.strip():
            continue
        if page_header(line, src, where, state):
            in_header = True
            continue
        if in_header:
            if line.strip() == src['title']:
                state['title_seen'] = True
            if line.startswith('-----'):
                in_header = False
            continue
        if LEGEND_RE.search(line):
            state['legend'].update(LEGEND_RE.findall(line))
            continue
        m = re.match(r'^ (\d{6}) (\S.*?)(?=\s{2}|$)', line)
        if not m:
            if BASIN_RE.fullmatch(line):
                basin = line
                continue
            raise ParseError(f'{where}: not a row, a basin, a legend or a header — {line!r}')
        if basin is None:
            raise ParseError(f'{where}: a station before any basin')
        if m.end(2) > 46:
            raise ParseError(f'{where}: the name runs into the figures — {line!r}')
        f = {'number': m.group(1), 'station_name': m.group(2).strip(), 'basin': basin,
             'crossing_type': '', '_where': where}
        f.update({c: '' for c in TABBED_ENDS.values()})
        for t in re.finditer(r'\S+', line[46:]):
            start, end, tok = t.start() + 46, t.end() + 46, t.group()
            if start == TABBED_TYPE_AT and re.fullmatch(r'[A-Z]', tok):
                f['crossing_type'] = tok
            elif end in TABBED_ENDS and NUMBER_RE.fullmatch(tok):
                f[TABBED_ENDS[end]] = tok
            else:
                raise ParseError(f'{where}: {tok!r} at columns {start}-{end} is in no column')
        rows.append(f)
    if not state['title_seen']:
        raise ParseError(f'{src["file"]}: no page is headed {src["title"]!r}')
    return rows, state


def normalise(src, raw, dated, legend):
    """One page row, as the JSON carries it."""
    key, where = src['key'], raw['_where']
    out = {'bureau_number': raw['number'], 'station_name': raw['station_name'],
           'basin': raw['basin']}
    if key in ('flood_classes', 'crossings'):
        out['as_at'] = dated
    for field in FIELDS[key]:
        if field in out or field not in raw:
            continue
        v = raw[field]
        if field in NUMERIC:
            v = number(v, where)
        elif field in DATES:
            v = iso_date(v, where)
        else:
            v = v.strip() or None
        if field == 'crossing_type' and v is not None and v not in legend:
            raise ParseError(f'{where}: crossing type {v!r} is not in the page legend')
        if v is not None:
            out[field] = v
    return {f: out[f] for f in FIELDS[key] if f in out}


def build():
    doc = {'meta': {}, 'flood_classes': [], 'crossings': [], 'gauge_survey': []}
    sections, legend = [], {}
    for src in SOURCES:
        path = os.path.join(REPO, ARCHIVE, src['file'])
        with open(path, encoding='ascii') as fh:
            lines = fh.read().split('\n')
        reader = read_fixed if src['layout'] == 'fixed' else read_tabbed
        raw, state = reader(src, lines)
        for code, label in state['legend'].items():
            if legend.get(code, label) != label:
                raise ParseError(f'{src["file"]}: legend says {code} is {label!r}, '
                                 f'another section says {legend[code]!r}')
            legend[code] = label
        rows, empty = [], 0
        for r in raw:
            row = normalise(src, r, state['dated'], state['legend'])
            if src['key'] == 'flood_classes' and not any(f in row for f in FLOOD_FIGURES):
                empty += 1
                continue
            rows.append(row)
        doc[src['key']].extend(rows)
        sections.append({
            'key': src['key'], 'section': src['section'], 'title': src['title'].capitalize(),
            'dated': state['dated'], 'source': f'{ARCHIVE}/{src["file"]}',
            'pages': len(state['pages']), 'rows_printed': len(raw), 'rows_kept': len(rows),
            'rows_without_a_figure': empty, 'wrapped_lines': state['wrapped'],
        })
    doc['meta'] = {
        'title': 'Queensland Flood Warning River Height Stations',
        'publisher': 'Bureau of Meteorology',
        'generator': 'tools/ingest/river_height_stations.py',
        'crossing_types': legend,
        'sections': sections,
    }
    return doc


# ── Output ───────────────────────────────────────────────────────────────────

def dump_value(v):
    return str(v) if isinstance(v, Num) else json.dumps(v, ensure_ascii=False)


def dump_row(row):
    return '{' + ','.join(f'{json.dumps(k)}:{dump_value(v)}' for k, v in row.items()) + '}'


def render(doc):
    parts = ['{\n"meta": ', json.dumps(doc['meta'], ensure_ascii=False), ',\n']
    keys = ['flood_classes', 'crossings', 'gauge_survey']
    for i, key in enumerate(keys):
        parts.append(f'"{key}": [\n')
        parts.append(',\n'.join(dump_row(r) for r in doc[key]))
        parts.append('\n]' + (',' if i < len(keys) - 1 else '') + '\n')
    parts.append('}\n')
    return ''.join(parts)


def q(v):
    if v is None:
        return 'null'
    if isinstance(v, Num):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


# Per table: the columns the SQL writes, the date the rows are ordered by
# (newest first, then as printed), and what "the station already has some"
# means — per edition where there is one, per station where there is not.
TABLES = {
    'flood_classes': {
        'table': 'station_flood_class',
        'columns': ['as_at', 'first_report_m', 'crossing_height_m', 'crossing_type',
                    'minor_m', 'crops_grazing_m', 'moderate_m', 'towns_m', 'major_m'],
        'types': {'as_at': 'date'},
        'order': 'as_at desc nulls last',
        'already': 't.as_at is not distinct from v.as_at',
    },
    'crossings': {
        'table': 'station_crossing',
        'columns': ['as_at', 'stream', 'name', 'height_m', 'crossing_type'],
        'types': {'as_at': 'date'},
        'order': 'as_at desc nulls last',
        'already': 't.as_at is not distinct from v.as_at',
    },
    'gauge_survey': {
        'table': 'station_gauge_survey',
        'columns': ['valid_from', 'valid_to', 'gauge_zero_m', 'datum', 'amtd_km',
                    'catchment_area_km2'],
        'types': {'valid_from': 'date', 'valid_to': 'date'},
        'order': 'valid_from desc nulls last',
        'already': 'true',
    },
}


def sql_type(col, spec):
    if col in spec['types']:
        return spec['types'][col]
    return 'numeric' if col in NUMERIC else 'text'


def render_sql(doc):
    out = ['-- Generated by tools/ingest/river_height_stations.py — do not edit.',
           '-- The Bureau\'s river height station lists, attached by bureau number to',
           '-- the live stations they describe. A station that already has rows of its',
           '-- own (per edition for flood classes and crossings) is left alone.',
           '--',
           '--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f this.sql']
    for s in doc['meta']['sections']:
        out.append(f'--   section {s["section"]:<6} {s["dated"]}  {s["rows_kept"]:>5} rows  {s["source"]}')
    for key, spec in TABLES.items():
        cols = spec['columns']
        # The first row carries a cast per column, which is what types a VALUES
        # list: a date written as a bare literal would otherwise arrive as text.
        values = ',\n'.join(
            f'    ({i}, {q(r["bureau_number"])}, '
            + ', '.join(q(r.get(c)) + (f'::{sql_type(c, spec)}' if i == 0 else '') for c in cols)
            + ')'
            for i, r in enumerate(doc[key]))
        out.append(f'''
-- {key} → meganet.{spec['table']}: {len(doc[key])} rows as printed
with v (src, bureau_number, {', '.join(cols)}) as (
  values
{values}
),
matched as (
  select st.id as station_id, v.*
    from v
    join meganet.station st
      on meganet.bureau_key(st.station_number) = meganet.bureau_key(v.bureau_number)
     and st.deleted_at is null
   where not exists (select 1 from meganet.{spec['table']} t
                      where t.station_id = st.id and {spec['already']})
),
attached as (
  insert into meganet.{spec['table']} (station_id, ord, {', '.join(cols)}, updated_by)
  select m.station_id,
         coalesce((select max(t.ord) + 1 from meganet.{spec['table']} t
                    where t.station_id = m.station_id), 0)
           + (row_number() over (partition by m.station_id order by m.{spec['order']}, m.src))::integer - 1,
         {', '.join('m.' + c for c in cols)}, {q(TAG)}
    from matched m
  returning station_id
)
-- The station's own stamp moves too, so an editor holding it open is told
-- to reload rather than saving over what just arrived.
update meganet.station st set updated_by = {q(TAG)}
 where st.id in (select station_id from attached);''')
    return '\n'.join(out) + '\n'


def report(doc, stations_path):
    keyed = {}
    if os.path.exists(stations_path):
        with open(stations_path, encoding='utf-8') as fh:
            for s in json.load(fh)['stations']:
                k = (s.get('station_number') or '').strip().lstrip('0')
                if k:
                    keyed[k] = s['id']
    print(doc['meta']['title'])
    for s in doc['meta']['sections']:
        empty = s['rows_without_a_figure']
        dropped = f' ({empty} with no figure)' if empty else ''
        print(f'  section {s["section"]:<6} dated {s["dated"]}  {s["pages"]:>2} pages  '
              f'{s["rows_printed"]:>5} rows printed, {s["rows_kept"]:>5} kept{dropped}, '
              f'{s["wrapped_lines"]} wrapped line(s) joined')
    print(f'  crossing types: {doc["meta"]["crossing_types"]}')
    for key in ('flood_classes', 'crossings', 'gauge_survey'):
        rows = doc[key]
        numbers = {r['bureau_number'] for r in rows}
        mine = {n for n in numbers if n.lstrip('0') in keyed}
        attach = sum(1 for r in rows if r['bureau_number'] in mine)
        print(f'  {key:<14} {len(rows):>5} rows for {len(numbers):>5} stations; '
              f'{len(mine):>4} of those are MegaNet stations ({attach} rows)')
    datums = collections.Counter(r.get('datum') for r in doc['gauge_survey'])
    print(f'  datums: {dict(datums)}')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1].strip())
    ap.add_argument('--out', default=OUT_DEFAULT)
    ap.add_argument('--check', action='store_true', help='fail if the JSON would change')
    ap.add_argument('--report', action='store_true', help='what came out, in prose')
    ap.add_argument('--sql', action='store_true',
                    help='print the SQL that attaches the rows to stations')
    ap.add_argument('--stations', default=os.path.join(REPO, 'stations.json'),
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
    if a.sql:
        sys.stdout.write(render_sql(doc))
        return 0
    body = render(doc)
    if a.check:
        have = open(a.out, encoding='utf-8').read() if os.path.exists(a.out) else None
        if have != body:
            print(f'{a.out}: would change — rerun without --check', file=sys.stderr)
            return 1
        print(f'{a.out}: up to date')
        return 0
    with open(a.out, 'w', encoding='utf-8') as fh:
        fh.write(body)
    kept = sum(s['rows_kept'] for s in doc['meta']['sections'])
    print(f'{a.out}: {kept} rows from {len(doc["meta"]["sections"])} sections, {len(body):,} bytes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
