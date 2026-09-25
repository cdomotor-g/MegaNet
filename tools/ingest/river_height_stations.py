#!/usr/bin/env python3
"""
river_height_stations.py — read the Bureau's Queensland flood warning station
lists into JSON, and write what they say into MegaNet: the stations it does not
have yet, and what the lists say about every station they name.

WHAT THIS IS
    The Bureau prints its Queensland flood warning network as numbered sections,
    one table per section, every row keyed on the bureau number — the number
    `meganet.station.station_number` carries, less its leading zeros
    (`meganet.bureau_key()` joins the two). Nine documents are in
    `archive/river-height-stations/`:

      section-1   Index of FloodWarn rainfall stations, 25/09/2026  station_index
      section-2   Index of daily rainfall stations, 26/09/2026 .... station_index
      section-3   Index of river height stations, 26/09/2026 ...... station_index
      section-4   Flood classifications, 25/09/2026 ............... flood_classes
      section-4b  Flood classifications, 15/01/2014 ............... flood_classes
      section-5   Details of crossings, 25/09/2026 ................ crossings
      section-6   Survey details, 25/09/2026 ...................... gauge_survey
      section-9   Flood effects, 26/09/2026 ....................... flood_effects
      urbs        URBS details, 26/09/2026 ........................ urbs

    Sections 1–3 are the indexes: every station in the service, the basin it
    reports for and where it is, in degrees, minutes and seconds — and for a
    river height station its AWRC number and the stream it is on. Section 2 is
    the daily read gauges, and says on every page that it lists only the ones
    used for flood warning.

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

    Section 9 is what each height on the gauge means on the ground — "Minor
    Flood Level", "Bridge (Pacific Highway Bridge)", "Low lying roads at Budds
    Beach" — one row per height, as many as the Bureau has written down. The
    URBS details are the label each river height station goes by in the
    Bureau's URBS runoff-routing model, beside its minor, moderate and major
    levels; those three agree with Section 4 on every row that prints them, so
    the label is the only thing it adds.

    This writes `data/river-height-stations.json`, the nine documents as
    written, every station they list whether or not MegaNet has it. It
    interprets nothing. With --sql it writes the SQL that puts it in the
    database.

HOW IT READS THEM
    Positionally. Sections 1–6 are fixed-width, and each page's column rule —
    the line of dashes under the headings — *is* the column layout, so the
    spans are read off it rather than written down here, and every page's rule
    is checked to be the same one. A row whose text strays into the gap
    between two columns raises rather than being read.

    **A field too long for its column carries on underneath**, on a line with
    no station number, sometimes after a page break and its whole page header.
    That line belongs to the row above it, column by column. Two different
    wraps happen, and joining them the same way would be wrong for one:

      the station name   is wrapped at a word — "BONOGIN CK (HARDYS RD)" over
                         "ALERT" — so the pieces join with a space. Checked
                         against the 2014 edition, which prints the same names
                         unwrapped, and against Section 3, whose name column is
                         five characters wider: every one agrees.
      the stream         is cut at the column edge, mid-word if need be —
                         "SANDY CK (NORTH BRANCH" over ")" — so a piece that
                         filled its column joins the next with nothing.

    A wrap in any other column raises: nothing does it today, and a third rule
    should be decided by somebody looking at it rather than guessed here.

    Section 4 (B) is older and differently made: the columns are tab-aligned,
    the basin is a line of its own, and nothing wraps. Expanded at 8, every
    figure ends on one of seven fixed columns and every crossing type sits in
    one — which is checked, so a figure that lands anywhere else raises. The
    URBS details are the same kind of page and are read the same way.

    Section 9 is an HTML page, one <pre> block per station under an anchor per
    basin, tab-aligned inside. Expanded at 8 every height ends on column 18 and
    every effect starts on column 30. A line under an effect that starts on
    column 30 in brackets — "(Pacific Highway Bridge)" — is that effect's
    detail, kept without its brackets; the one line that starts on column 0
    is the effect above it carrying on, and is joined to it with a space.
    Three characters on the page are U+FFFD, the replacement character: what
    was there was lost before the page reached us, and each reads as a dash
    ("513.27 m AHD – ie: 0.1 m below …"), so each is read as an en dash.

    Figures are kept as the literal the page printed — 94.50 stays 94.50 —
    because the database stores `numeric` for the reason db/README.md gives.
    Two literals are tidied: `.02` gains its leading zero, which JSON needs,
    and the 2014 edition's `-0.0` (its one-decimal rounding of -0.03) is 0.0,
    because a numeric has no negative zero to keep it in.

    A position is printed ddmmss / dddmmss and kept as printed (`lat_dms`,
    `lon_dms`) beside its decimal degrees to five places (`lat`, `lon`), which
    is finer than the second it was printed to (0.00001° against 0.00028°), so
    converting loses nothing. 174 values print a 60 in the seconds or minutes —
    250760S — which is carried, 25°08'00". Four latitudes in the Torres Strait
    are printed as if decimal — 9.437S — with a digit of the minutes missing;
    those rows keep what was printed, have no decimal position and say why in
    `problem`, and nothing guesses the digit.

WHAT IS NOT KEPT
    A row with nothing in it: 4 of the 2026 flood classification rows and 362
    of the 2014 ones name a station and print no figure at all. They carry no
    fact, and stored they would be a flood classes block with nothing in it.
    Section 1 prints four stations twice, identically; the second copy is not
    kept. Two different rows for one station in one section would raise.

WHAT --sql WRITES
    Four things, in one transaction, all of them additive — nothing is
    deleted and nothing already on a station is written over:

      1. The stations Sections 1–3 list and MegaNet has no station for,
         matched by bureau number against every station, live or deleted: a
         station somebody deleted stays deleted. Each is a field station —
         what the station editor's "+ New" makes — named from the Bureau's
         name (below), numbered without the leading zeros MegaNet's numbers
         never carry, placed at the Bureau's position, and given the
         catchment and hub its position falls in: point in polygon against
         data/qld-basins.geojson and data/bom-hubs.geojson with
         tools/build_geo_layers.py's own functions. Those are the simplified
         copies the map draws, not the full-resolution KMZs build_geo_layers
         assigns from; against every station that already has an answer they
         agree on 3,163 of 3,173 catchments and on every hub. A position in no
         basin (a tide gauge off the coast) takes the basin the Bureau says it
         reports for; a position in no hub takes the nearest within
         HUB_SNAP_KM. The station's elevation is left empty: the height of the
         ground under it is tools/elvis_station_elevations.py's question.
      2. The rows of every list, attached by bureau number to live stations,
         and only where the station has none of its own yet — per edition for
         flood classes, crossings and flood effects, per section and edition
         for index listings, per station for the survey. So it is safe to run
         again, and it never overwrites a row somebody has since edited.
      3. The AWRC number and stream (Section 3) and URBS label, onto live
         stations that have none.
      4. A check that every station Sections 1–3 list now exists, which fails
         the transaction if a station could not be created — an id that the
         stations.json this read no longer describes, say.

    A station's position, name and elevation are never touched. Where the
    Bureau's position and MegaNet's disagree, --report says so and by how far,
    for a person to look at: tools/elvis_station_elevations.py sampled every
    elevation at the position MegaNet holds, so moving one quietly would leave
    its height describing somewhere else.

    New names follow what MegaNet's own names do with the Bureau's: title
    case, "ALERT" as "AL" (1,050 of the stations both name do), the network
    and agency abbreviations kept in capitals (KEEP_UPPER), and the Bureau's
    {BRACES} — a daily station's nearest town — as brackets. The Bureau's own
    spelling is kept in data/river-height-stations.json.

USAGE
    python3 tools/ingest/river_height_stations.py            # rewrite the JSON
    python3 tools/ingest/river_height_stations.py --check    # fail if it would change
    python3 tools/ingest/river_height_stations.py --report   # what came out, in prose
    python3 tools/ingest/river_height_stations.py --sql \\
      | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction

    --sql reads stations.json to know which stations exist and which ids are
    taken, so run it against a stations.json that is the database's own
    (tools/snapshot_stations_json.py). db/migrations/0031_river_height_details.sql
    and 0032_bureau_station_lists.sql are what it writes into.

Standard library only.
"""

import argparse
import collections
import decimal
import html
import json
import math
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ARCHIVE = os.path.join('archive', 'river-height-stations')
OUT_DEFAULT = os.path.join(REPO, 'data', 'river-height-stations.json')
TAG = 'river_height_stations.py'


class ParseError(Exception):
    pass


# ── The documents ────────────────────────────────────────────────────────────
# `columns` names the column rule's dash groups in order; `wrap` says how a
# column that overflows onto the next line joins back (see the head of the
# file). `section` and `title` are what the page header must say, checked on
# every page before a row on it is read. `footer` is a line a page ends with.
SOURCES = [
    {
        'file': 'section-1-floodwarn-rainfall-stations-2026-09-25.txt',
        'key': 'station_index', 'section': '1',
        'title': 'INDEX OF QUEENSLAND FLOODWARN RAINFALL STATIONS',
        'label': 'Index of Queensland FloodWarn rainfall stations',
        'layout': 'fixed',
        'columns': ['number', 'station_name', 'basin', 'lat_dms', 'lon_dms'],
        'wrap': {'station_name': 'word'},
    },
    {
        'file': 'section-2-daily-rainfall-stations-2026-09-26.txt',
        'key': 'station_index', 'section': '2',
        'title': 'INDEX OF QUEENSLAND DAILY REPORTING RAINFALL STATIONS',
        'label': 'Index of Queensland daily reporting rainfall stations',
        'layout': 'fixed',
        'columns': ['number', 'station_name', 'basin', 'lat_dms', 'lon_dms'],
        'wrap': {'station_name': 'word'},
        'footer': '(Note: Only includes stations used for flood warning.)',
    },
    {
        'file': 'section-3-river-height-stations-2026-09-26.txt',
        'key': 'station_index', 'section': '3',
        'title': 'INDEX OF QUEENSLAND RIVER HEIGHT STATIONS',
        'label': 'Index of Queensland river height stations',
        'layout': 'fixed',
        'columns': ['number', 'awrc_number', 'station_name', 'stream', 'basin',
                    'lat_dms', 'lon_dms'],
        'wrap': {'station_name': 'word', 'stream': 'cut'},
    },
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
    {
        'file': 'section-9-flood-effects-2026-09-26.html',
        'key': 'flood_effects', 'section': '9', 'title': 'FLOOD EFFECTS',
        'label': 'Flood effects',
        'layout': 'effects',
    },
    {
        'file': 'urbs-details-2026-09-26.txt',
        'key': 'urbs', 'section': 'URBS',
        'title': 'URBS DETAILS FOR FLOOD WARNING RIVER HEIGHT STATIONS',
        'label': 'URBS details for flood warning river height stations',
        'layout': 'urbs',
    },
]
KEYS = ['station_index', 'flood_classes', 'crossings', 'gauge_survey', 'flood_effects', 'urbs']

# Section 4 (B), tabs expanded at 8: the column each figure's last character
# lands on, and the one column the crossing type is printed in.
TABBED_ENDS = {51: 'first_report_m', 58: 'crossing_height_m', 70: 'minor_m',
               79: 'crops_grazing_m', 88: 'moderate_m', 97: 'towns_m', 106: 'major_m'}
TABBED_TYPE_AT = 61

# The URBS details, tabs expanded at 8: the name is columns 9–33, the label
# 35–42, and each level ends on one of three columns.
URBS_NAME = (9, 34)
URBS_LABEL = (35, 43)
URBS_ENDS = {52: 'minor_m', 63: 'moderate_m', 74: 'major_m'}

# Section 9, tabs expanded at 8: where a height ends and its effect starts.
EFFECT_HEIGHT_END = 18
EFFECT_TEXT_AT = 30

# Field order in the JSON, per key. Absent means the page printed nothing.
FIELDS = {
    'station_index': ['bureau_number', 'station_name', 'basin', 'section', 'as_at',
                      'awrc_number', 'stream', 'lat_dms', 'lon_dms', 'lat', 'lon',
                      'problem'],
    'flood_classes': ['bureau_number', 'station_name', 'basin', 'as_at',
                      'first_report_m', 'crossing_height_m', 'crossing_type',
                      'minor_m', 'crops_grazing_m', 'moderate_m', 'towns_m', 'major_m'],
    'crossings':     ['bureau_number', 'station_name', 'basin', 'as_at',
                      'stream', 'name', 'height_m', 'crossing_type'],
    'gauge_survey':  ['bureau_number', 'station_name', 'basin', 'valid_from',
                      'valid_to', 'gauge_zero_m', 'datum', 'amtd_km',
                      'catchment_area_km2'],
    'flood_effects': ['bureau_number', 'station_name', 'basin', 'as_at',
                      'height_m', 'effect', 'detail'],
    'urbs':          ['bureau_number', 'station_name', 'basin', 'as_at',
                      'urbs_label', 'minor_m', 'moderate_m', 'major_m'],
}
NUMERIC = {'first_report_m', 'crossing_height_m', 'minor_m', 'crops_grazing_m',
           'moderate_m', 'towns_m', 'major_m', 'height_m', 'gauge_zero_m',
           'amtd_km', 'catchment_area_km2', 'lat', 'lon'}
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
AWRC_RE = re.compile(r'\d{6}')
LAT_RE = re.compile(r'(\d{2})(\d{2})(\d{2})([NS])')
LON_RE = re.compile(r'(\d{3})(\d{2})(\d{2})([EW])')


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


def degrees(text, pattern):
    """ddmmss(N|S) or dddmmss(E|W) to decimal degrees at five places, or None
    for text that is not one. A 60 in the minutes or seconds is carried."""
    m = pattern.fullmatch(text)
    if not m:
        return None
    d, mi, s, hemi = int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)
    if mi > 60 or s > 60:
        return None
    v = decimal.Decimal(d) + decimal.Decimal(mi) / 60 + decimal.Decimal(s) / 3600
    v = v.quantize(decimal.Decimal('0.00001'), rounding=decimal.ROUND_HALF_UP)
    return Num(('-' if hemi in 'SW' else '') + str(v))


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


def new_state():
    return {'dated': None, 'pages': [], 'legend': {}, 'wrapped': 0, 'title_seen': False,
            'footers': 0}


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

    state = new_state()
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
        if src.get('footer') and line.strip() == src['footer']:
            state['footers'] += 1
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
    state = new_state()
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


def read_urbs(src, lines):
    """The URBS details: a dated first line, a title, and per basin a heading
    line, a column heading and the rows — tab-aligned, read like 4 (B)."""
    state = new_state()
    m = re.fullmatch(r'Report Generated from HdB on: (\d{2})/(\d{2})/(\d{4})', lines[0].strip())
    if not m:
        raise ParseError(f'{src["file"]}:1: not the URBS report\'s first line — {lines[0]!r}')
    state['dated'] = f'{m.group(3)}-{m.group(2)}-{m.group(1)}'
    state['pages'] = [1]
    rows, basin = [], None
    for n, raw in enumerate(lines[1:], 2):
        line = raw.expandtabs(8).rstrip()
        where = f'{src["file"]}:{n}'
        if not line.strip():
            continue
        if line.strip() == src['title']:
            state['title_seen'] = True
            continue
        if line.startswith('Stn No.'):
            if line.split() != ['Stn', 'No.', 'Name', 'Urbs', 'Label', 'Minor', 'Moderate', 'Major']:
                raise ParseError(f'{where}: not the column heading this reader knows — {line!r}')
            continue
        m = re.match(r'^ (\d{6})  \S', line)
        if not m:
            if BASIN_RE.fullmatch(line):
                basin = line
                continue
            raise ParseError(f'{where}: not a row, a basin or a heading — {line!r}')
        if basin is None:
            raise ParseError(f'{where}: a station before any basin')
        if len(line) > URBS_NAME[1] and line[URBS_NAME[1]] != ' ':
            raise ParseError(f'{where}: the name runs into the label — {line!r}')
        f = {'number': m.group(1), 'basin': basin, '_where': where,
             'station_name': line[URBS_NAME[0]:URBS_NAME[1]].strip(),
             'urbs_label': line[URBS_LABEL[0]:URBS_LABEL[1]].strip()}
        if len(line) > URBS_LABEL[1] and line[URBS_LABEL[1]] != ' ':
            raise ParseError(f'{where}: the label runs into the levels — {line!r}')
        f.update({c: '' for c in URBS_ENDS.values()})
        for t in re.finditer(r'\S+', line[URBS_LABEL[1]:]):
            start, end, tok = t.start() + URBS_LABEL[1], t.end() + URBS_LABEL[1], t.group()
            if end in URBS_ENDS and NUMBER_RE.fullmatch(tok):
                f[URBS_ENDS[end]] = tok
            else:
                raise ParseError(f'{where}: {tok!r} at columns {start}-{end} is in no column')
        rows.append(f)
    if not state['title_seen']:
        raise ParseError(f'{src["file"]}: no line reads {src["title"]!r}')
    return rows, state


def read_effects(src, text):
    """Section 9: an HTML page. Its body is <pre> blocks and basin anchors and
    nothing else, which is checked; each block is one station."""
    state = new_state()
    state['pages'] = [1]
    state['details'] = 0
    state['restored'] = 0
    state['stations'] = 0
    body = re.search(r'<body>(.*)</body>', text, re.S)
    if not body:
        raise ParseError(f'{src["file"]}: no <body>')
    rows, basin, first = [], None, True
    pos = 0
    for m in re.finditer(r'<a id="([^"]*)">([^<]*)</a>|<pre>(.*?)</pre>', body.group(1), re.S):
        between = body.group(1)[pos:m.start()]
        pos = m.end()
        if between.strip():
            raise ParseError(f'{src["file"]}: {between.strip()[:60]!r} outside any block')
        if m.group(1) is not None:
            name = m.group(2).strip()
            if not BASIN_RE.fullmatch(name) or m.group(1) != name.replace(' ', ''):
                raise ParseError(f'{src["file"]}: anchor {m.group(1)!r} is not a basin — {name!r}')
            basin = name
            continue
        block = [html.unescape(l).expandtabs(8).rstrip() for l in m.group(3).split('\n')]
        block = [l for l in block if l.strip()]
        if first:
            # The page header: the date, the section, and two title lines.
            first = False
            hm = re.fullmatch(r'Date: (\d{2})/(\d{2})/(\d{4})\s+SECTION (\d+)', block[0])
            if not hm or hm.group(4) != src['section']:
                raise ParseError(f'{src["file"]}: not a Section {src["section"]} header — {block[0]!r}')
            state['dated'] = f'{hm.group(3)}-{hm.group(2)}-{hm.group(1)}'
            titles = [l.strip() for l in block[1:]]
            if titles != ['QUEENSLAND FLOOD WARNING RIVER HEIGHT STATIONS', src['title']]:
                raise ParseError(f'{src["file"]}: not headed {src["title"]!r} — {titles!r}')
            state['title_seen'] = True
            continue
        if all(set(l.strip()) == {'-'} for l in block):
            continue                      # the rule between two basins
        sm = re.fullmatch(r'     Station: (\S.*?)\s+CBM No:\s+(\d{6})', block[0])
        if not sm or block[0].index('CBM No:') != 59:
            raise ParseError(f'{src["file"]}: a block that does not start with its station — {block[0]!r}')
        if len(block) < 2 or block[1].split() != ['GAUGE', 'Ht', '(m)', 'PROBABLE', 'FLOOD', 'EFFECT']:
            raise ParseError(f'{src["file"]}: {sm.group(2)} has no column heading')
        if basin is None:
            raise ParseError(f'{src["file"]}: {sm.group(2)} is before any basin')
        state['stations'] += 1
        where = f'{src["file"]}: {sm.group(2)}'
        prev = None
        for line in block[2:]:
            text_ = line
            if '\ufffd' in text_:
                state['restored'] += text_.count('\ufffd')
                text_ = text_.replace('\ufffd', '\u2013')
            rm = re.fullmatch(r'( +)(\S+)( +)(\S.*)', text_)
            if rm and NUMBER_RE.fullmatch(rm.group(2)):
                if len(rm.group(1)) + len(rm.group(2)) != EFFECT_HEIGHT_END \
                        or len(rm.group(1) + rm.group(2) + rm.group(3)) != EFFECT_TEXT_AT:
                    raise ParseError(f'{where}: a height or an effect out of its column — {line!r}')
                prev = {'number': sm.group(2), 'station_name': sm.group(1), 'basin': basin,
                        '_where': where, 'height_m': rm.group(2), 'effect': rm.group(4).strip(),
                        'detail': ''}
                rows.append(prev)
                continue
            if prev is None:
                raise ParseError(f'{where}: {line.strip()!r} before any height')
            if text_.startswith(' ' * EFFECT_TEXT_AT + '('):
                d = text_.strip()
                if not d.endswith(')') or prev['detail']:
                    raise ParseError(f'{where}: a second or unclosed detail — {line!r}')
                prev['detail'] = d[1:-1].strip()
                state['details'] += 1
                continue
            if not text_.startswith(' '):
                prev['effect'] = f'{prev["effect"]} {text_.strip()}'
                state['wrapped'] += 1
                continue
            raise ParseError(f'{where}: not a height, a detail or an effect carrying on — {line!r}')
    if pos != len(body.group(1)) and body.group(1)[pos:].strip():
        raise ParseError(f'{src["file"]}: {body.group(1)[pos:].strip()[:60]!r} after the last block')
    if not state['title_seen']:
        raise ParseError(f'{src["file"]}: no header block')
    return rows, state


def normalise(src, raw, dated, legend):
    """One page row, as the JSON carries it."""
    key, where = src['key'], raw['_where']
    out = {'bureau_number': raw['number'], 'station_name': raw['station_name'],
           'basin': raw['basin']}
    if key == 'station_index':
        out['section'] = src['section']
    if key in ('station_index', 'flood_classes', 'crossings', 'flood_effects', 'urbs'):
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
        if field == 'awrc_number' and v is not None and not AWRC_RE.fullmatch(v):
            raise ParseError(f'{where}: AWRC number {v!r} is not six digits')
        if v is not None:
            out[field] = v
    if key == 'station_index':
        lat = degrees(raw['lat_dms'], LAT_RE)
        lon = degrees(raw['lon_dms'], LON_RE)
        if lat is not None and lon is not None:
            out['lat'], out['lon'] = lat, lon
        else:
            bad = [f'{what} {raw[f]}' for what, f, v in
                   (('latitude', 'lat_dms', lat), ('longitude', 'lon_dms', lon)) if v is None]
            out['problem'] = (f'the {" and the ".join(bad)} '
                              f'{"is" if len(bad) == 1 else "are"} not degrees, minutes and seconds')
    return {f: out[f] for f in FIELDS[key] if f in out}


def build():
    doc = {'meta': {}, **{k: [] for k in KEYS}}
    sections, legend = [], {}
    for src in SOURCES:
        path = os.path.join(REPO, ARCHIVE, src['file'])
        encoding = 'utf-8' if src['layout'] == 'effects' else 'ascii'
        with open(path, encoding=encoding) as fh:
            text = fh.read()
        lines = text.split('\n')
        if src['layout'] == 'fixed':
            raw, state = read_fixed(src, lines)
        elif src['layout'] == 'tabbed':
            raw, state = read_tabbed(src, lines)
        elif src['layout'] == 'urbs':
            raw, state = read_urbs(src, lines)
        else:
            raw, state = read_effects(src, text)
        for code, label in state['legend'].items():
            if legend.get(code, label) != label:
                raise ParseError(f'{src["file"]}: legend says {code} is {label!r}, '
                                 f'another section says {legend[code]!r}')
            legend[code] = label
        rows, empty, seen, dupes = [], 0, {}, 0
        for r in raw:
            row = normalise(src, r, state['dated'], state['legend'])
            if src['key'] == 'flood_classes' and not any(f in row for f in FLOOD_FIGURES):
                empty += 1
                continue
            if src['key'] in ('station_index', 'urbs'):
                # One row per station per list; the same row twice is a
                # printing slip, two different ones would be a question.
                have = seen.get(row['bureau_number'])
                if have is not None:
                    if have != row:
                        raise ParseError(f'{r["_where"]}: {row["bureau_number"]} is listed '
                                         f'twice, differently')
                    dupes += 1
                    continue
                seen[row['bureau_number']] = row
            rows.append(row)
        doc[src['key']].extend(rows)
        entry = {
            'key': src['key'], 'section': src['section'],
            'title': src.get('label') or src['title'].capitalize(),
            'dated': state['dated'], 'source': f'{ARCHIVE}/{src["file"]}',
            'pages': len(state['pages']), 'rows_printed': len(raw), 'rows_kept': len(rows),
            'rows_without_a_figure': empty, 'wrapped_lines': state['wrapped'],
        }
        if src.get('footer'):
            entry['note'] = src['footer'].strip('()')
        if dupes:
            entry['rows_printed_twice'] = dupes
        if src['key'] == 'station_index':
            entry['positions_unreadable'] = sum(1 for r in rows if 'problem' in r)
        if src['layout'] == 'effects':
            entry['stations'] = state['stations']
            entry['details'] = state['details']
            entry['characters_restored'] = state['restored']
        sections.append(entry)
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
    for i, key in enumerate(KEYS):
        parts.append(f'"{key}": [\n')
        parts.append(',\n'.join(dump_row(r) for r in doc[key]))
        parts.append('\n]' + (',' if i < len(KEYS) - 1 else '') + '\n')
    parts.append('}\n')
    return ''.join(parts)


def q(v):
    if v is None:
        return 'null'
    if isinstance(v, Num):
        return str(v)
    if isinstance(v, (list, tuple)):
        return 'array[' + ', '.join(q(x) for x in v) + ']::text[]' if v else "'{}'::text[]"
    return "'" + str(v).replace("'", "''") + "'"


# ── Names, ids and places for the stations MegaNet does not have ─────────────

# Kept in capitals: the networks' own suffixes and the agencies' initials, as
# MegaNet's names already write them. Everything else is title case.
KEEP_UPPER = {'AL', 'AL-B', 'AL-P', 'TM', 'TM-B', 'HW', 'TW', 'T/W', 'D/S', 'U/S', 'P/S',
              'QLD', 'NSW', 'DNRM', 'DPI', 'WRC', 'SCS', 'AWS', 'UQ', 'MIM', 'NP', 'WTP',
              'AP', 'SES', 'RSL', 'BOM'}
SMALL_WORDS = {'OF', 'AT', 'AND'}


def _cap(part):
    if not part or part in KEEP_UPPER:
        return part
    if '/' in part:
        return '/'.join(_cap(p) for p in part.split('/'))
    if "'" in part:
        a, b = part.split("'", 1)
        if len(b) == 1:                       # BERRY'S
            return _cap(a) + "'" + b.lower()
        if a in ('O', 'D'):                   # O'CONNELL, D'AGUILAR
            return a + "'" + _cap(b)
        return _cap(a) + "'" + b.lower()      # R'DHOUSE
    if re.fullmatch(r'MC[A-Z]{2,}', part):    # MCKINLAY
        return 'Mc' + part[2:].capitalize()
    return part[:1].upper() + part[1:].lower()


def style_name(bureau_name):
    """The Bureau's name as MegaNet writes names. See the head of the file."""
    s = re.sub(r'\s+', ' ', bureau_name.strip()).replace('{', '(').replace('}', ')')
    s = re.sub(r'(?<=[A-Z0-9.])\(', ' (', s)
    s = re.sub(r'\)(?=[A-Z0-9])', ') ', s)
    out = []
    for i, w in enumerate(s.split(' ')):
        m = re.fullmatch(r'([(\[]*)(.*?)([)\].,]*)', w)
        pre, core, post = m.groups()
        if core == 'ALERT':
            core = 'AL'
        elif core in ('ALERT-B', 'ALERT-P'):
            core = 'AL-' + core[-1]
        if core in KEEP_UPPER:
            pass
        elif i and core in SMALL_WORDS:
            core = core.lower()
        else:
            core = '-'.join(_cap(p) for p in core.split('-'))
        out.append(pre + core + post)
    return ' '.join(out)


def slug(s):
    """core.js's slug(), which is what the station editor mints an id with."""
    return re.sub(r'^_|_$', '', re.sub(r'[^a-z0-9]+', '_', (s or '').lower()))[:64]


def bureau_key(n):
    return (n or '').strip().lstrip('0') or None


# The Bureau's basins that do not spell a MegaNet catchment's id outright.
BASIN_CATCHMENT = {'CONDAMINE-BALONNE': 'balonne_condamine', 'COOPER CREEK': 'coopers_creek',
                   'STRADBROKE ISLANDS': 'stradbroke', 'TORRES STRAIT ISLAND': 'torres_strait_islands'}


def plan_new_stations(doc, stations_path):
    """The stations Sections 1–3 list that stations.json does not have, with
    everything --sql needs to create them. Deterministic: the same inputs give
    the same ids, in the same order."""
    sys.path.insert(0, os.path.join(REPO, 'tools'))
    import build_geo_layers as geo  # noqa: E402

    with open(stations_path, encoding='utf-8') as fh:
        have = json.load(fh)
    known = {bureau_key(s.get('station_number')) for s in have['stations']} - {None}
    taken = {s['id'] for s in have['stations']}
    catchments = {c['id'] for c in have.get('catchments', [])}
    with open(os.path.join(REPO, 'data', 'qld-basins.geojson'), encoding='utf-8') as fh:
        basins = geo.index_features(json.load(fh)['features'])
    with open(os.path.join(REPO, 'data', 'bom-hubs.geojson'), encoding='utf-8') as fh:
        hubs = geo.index_features(json.load(fh)['features'])

    # One entry per station, its rows in the order its name is best read from:
    # Section 3's name column is the widest.
    rank = {'3': 0, '1': 1, '2': 2}
    by = collections.defaultdict(list)
    for r in doc['station_index']:
        if bureau_key(r['bureau_number']) not in known:
            by[r['bureau_number']].append(r)
    plan = []
    for number, rows in by.items():
        rows = sorted(rows, key=lambda r: rank[r['section']])
        first = rows[0]
        placed = next((r for r in rows if 'lat' in r), None)
        entry = {'bureau_number': number, 'station_number': bureau_key(number),
                 'name': style_name(first['station_name']), 'basin': first['basin'],
                 'lat': None, 'lon': None, 'catchment_ids': [], 'hub_id': None, 'notes': '',
                 'sections': sorted(r['section'] for r in rows)}
        fallback = BASIN_CATCHMENT.get(first['basin'], slug(first['basin']))
        fallback = [fallback] if fallback in catchments else []
        if placed is None:
            entry['catchment_ids'] = fallback
            entry['catchment_from'] = 'bureau basin'
            r = next(r for r in rows if 'problem' in r)
            y, mo, d = r['as_at'].split('-')
            entry['notes'] = (f'The Bureau\'s Section {r["section"]} index of {d}/{mo}/{y} prints '
                              f'this station at {r["lat_dms"]} {r["lon_dms"]}, and {r["problem"]}, '
                              f'so it has no position here yet.')
        else:
            lat, lon = float(placed['lat']), float(placed['lon'])
            entry['lat'], entry['lon'] = placed['lat'], placed['lon']
            ids = sorted(fid for fid, _ in geo.locate(lon, lat, basins))
            if not ids:
                ids = fallback
                entry['catchment_from'] = 'bureau basin'
            entry['catchment_ids'] = ids
            hh = [fid for fid, _ in geo.locate(lon, lat, hubs)]
            entry['hub_id'] = hh[0] if hh else geo.nearest(lon, lat, hubs, geo.HUB_SNAP_KM)[0]
        plan.append(entry)
    plan.sort(key=lambda e: (e['name'].lower(), e['bureau_number']))
    for e in plan:
        base = slug(e['name']) or f'stn_{e["station_number"]}'
        uid, n = base, 2
        while uid in taken:
            uid, n = f'{base}_{n}', n + 1
        taken.add(uid)
        e['id'] = uid
    return plan


# Per list: the table, the columns the SQL writes, the date the rows are
# ordered by (newest first, then as printed), and what "the station already
# has some" means — per edition where there is one, per station where not.
TABLES = {
    'bureau_listings': {
        'source': 'station_index',
        'table': 'station_bureau_listing',
        'columns': ['section', 'as_at'],
        'types': {'as_at': 'date'},
        'order': 'section, m.as_at desc nulls last',
        'already': 't.section = v.section and t.as_at is not distinct from v.as_at',
    },
    'flood_classes': {
        'source': 'flood_classes',
        'table': 'station_flood_class',
        'columns': ['as_at', 'first_report_m', 'crossing_height_m', 'crossing_type',
                    'minor_m', 'crops_grazing_m', 'moderate_m', 'towns_m', 'major_m'],
        'types': {'as_at': 'date'},
        'order': 'as_at desc nulls last',
        'already': 't.as_at is not distinct from v.as_at',
    },
    'crossings': {
        'source': 'crossings',
        'table': 'station_crossing',
        'columns': ['as_at', 'stream', 'name', 'height_m', 'crossing_type'],
        'types': {'as_at': 'date'},
        'order': 'as_at desc nulls last',
        'already': 't.as_at is not distinct from v.as_at',
    },
    'gauge_survey': {
        'source': 'gauge_survey',
        'table': 'station_gauge_survey',
        'columns': ['valid_from', 'valid_to', 'gauge_zero_m', 'datum', 'amtd_km',
                    'catchment_area_km2'],
        'types': {'valid_from': 'date', 'valid_to': 'date'},
        'order': 'valid_from desc nulls last',
        'already': 'true',
    },
    'flood_effects': {
        'source': 'flood_effects',
        'table': 'station_flood_effect',
        'columns': ['as_at', 'height_m', 'effect', 'detail'],
        'types': {'as_at': 'date'},
        'order': 'as_at desc nulls last',
        'already': 't.as_at is not distinct from v.as_at',
    },
}


def sql_type(col, spec):
    if col in spec['types']:
        return spec['types'][col]
    return 'numeric' if col in NUMERIC else 'text'


def values_sql(rows, cols, types):
    """A VALUES list whose first row carries a cast per column, which is what
    types a VALUES list: a date written as a bare literal would otherwise
    arrive as text."""
    return ',\n'.join(
        '    (' + ', '.join(q(r.get(c)) + (f'::{types[c]}' if i == 0 else '') for c in cols) + ')'
        for i, r in enumerate(rows))


def render_sql(doc, stations_path):
    plan = plan_new_stations(doc, stations_path)
    out = ['-- Generated by tools/ingest/river_height_stations.py — do not edit.',
           '-- The Bureau\'s Queensland flood warning station lists, written into MegaNet:',
           '-- the stations it lists that MegaNet has no station for, then every list',
           '-- attached by bureau number to the live stations it describes. Additive: a',
           '-- station that already has rows of its own is left alone, nothing is deleted.',
           '--',
           '--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f this.sql']
    for s in doc['meta']['sections']:
        out.append(f'--   section {s["section"]:<6} {s["dated"]}  {s["rows_kept"]:>5} rows  {s["source"]}')

    # ── 1 · stations ─────────────────────────────────────────────────────────
    cols = ['src', 'station_number', 'id', 'name', 'lat', 'lon', 'catchment_ids', 'hub_id', 'notes']
    types = {'src': 'integer', 'station_number': 'text', 'id': 'text', 'name': 'text',
             'lat': 'numeric', 'lon': 'numeric', 'catchment_ids': 'text[]', 'hub_id': 'text',
             'notes': 'text'}
    rows = [dict(e, src=Num(str(i))) for i, e in enumerate(plan)]
    if rows:
        out.append(f'''
-- 1 · {len(rows)} stations the Bureau lists that stations.json has no station for.
-- Matched against every station, live or deleted, by bureau number: a station
-- somebody deleted stays deleted. A field station, as the editor's "+ New"
-- makes one. An id taken since stations.json was written is skipped here and
-- fails the check at the end, which rolls all of this back.
with v ({', '.join(cols)}) as (
  values
{values_sql(rows, cols, types)}
),
fresh as (
  select v.* from v
   where not exists (select 1 from meganet.station st
                      where meganet.bureau_key(st.station_number) = meganet.bureau_key(v.station_number))
),
base as (select coalesce(max(ord), -1) as ord from meganet.station)
insert into meganet.station (id, ord, name, station_number, lat, lon, roles,
                             radio_network_ids, catchment_ids, alert_ids, satcom,
                             rm_system_id, enabled, notes, hub_id, updated_by)
select f.id, b.ord + (row_number() over (order by f.src))::integer, f.name,
       f.station_number, f.lat, f.lon, array['field']::text[], '{{}}'::text[],
       f.catchment_ids, '{{}}'::jsonb,
       jsonb_build_object('enabled', false, 'provider', '', 'terminal_id', ''),
       -- A hub the database does not hold is left off rather than refused: a
       -- database loaded by tools/import_stations_json.py has no hubs[] at all.
       1, true, f.notes, (select h.id from meganet.hub h where h.id = f.hub_id), {q(TAG)}
  from fresh f cross join base b
on conflict (id) do nothing;''')
    else:
        out.append('\n-- 1 · no station the Bureau lists is missing from stations.json.')

    # ── 2 · the lists ────────────────────────────────────────────────────────
    for n, (key, spec) in enumerate(TABLES.items(), 1):
        cols = spec['columns']
        src_rows = doc[spec['source']]
        types = {c: sql_type(c, spec) for c in cols}
        values = ',\n'.join(
            f'    ({i}, {q(r["bureau_number"])}, '
            + ', '.join(q(r.get(c)) + (f'::{types[c]}' if i == 0 else '') for c in cols)
            + ')'
            for i, r in enumerate(src_rows))
        out.append(f'''
-- 2.{n} · {key} → meganet.{spec['table']}: {len(src_rows)} rows as printed
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

    # ── 3 · the station's own fields, where it has none ─────────────────────
    fields = collections.OrderedDict()
    for r in doc['station_index']:
        if r['section'] == '3':
            f = fields.setdefault(r['bureau_number'], {'bureau_number': r['bureau_number']})
            f['awrc_number'], f['stream'] = r.get('awrc_number'), r.get('stream')
    for r in doc['urbs']:
        f = fields.setdefault(r['bureau_number'], {'bureau_number': r['bureau_number']})
        f['urbs_label'] = r.get('urbs_label')
    frows = [f for f in fields.values()
             if any(f.get(k) for k in ('awrc_number', 'stream', 'urbs_label'))]
    fcols = ['bureau_number', 'awrc_number', 'stream', 'urbs_label']
    out.append(f'''
-- 3 · the AWRC number and stream (Section 3) and URBS label, onto live
-- stations that have none of their own: {len(frows)} stations as printed.
with v ({', '.join(fcols)}) as (
  values
{values_sql(frows, fcols, {c: 'text' for c in fcols})}
)
update meganet.station st
   set awrc_number = coalesce(st.awrc_number, v.awrc_number),
       stream      = coalesce(st.stream, v.stream),
       urbs_label  = coalesce(st.urbs_label, v.urbs_label),
       updated_by  = {q(TAG)}
  from v
 where meganet.bureau_key(st.station_number) = meganet.bureau_key(v.bureau_number)
   and st.deleted_at is null
   and ((st.awrc_number is null and v.awrc_number is not null)
     or (st.stream is null and v.stream is not null)
     or (st.urbs_label is null and v.urbs_label is not null));''')

    # ── 4 · did every station arrive ─────────────────────────────────────────
    numbers = sorted({r['bureau_number'] for r in doc['station_index']})
    listed = ',\n'.join(f'    ({q(n)})' for n in numbers)
    out.append(f'''
-- 4 · every station Sections 1–3 list now exists, live or deliberately deleted.
do $$
declare
  missing text;
begin
  select string_agg(v.n, ', ' order by v.n) into missing
    from (values
{listed}
    ) v (n)
   where not exists (select 1 from meganet.station st
                      where meganet.bureau_key(st.station_number) = meganet.bureau_key(v.n));
  if missing is not null then
    raise exception 'river_height_stations.py: no station for bureau number(s) %', missing
      using hint = 'An id this SQL chose is taken by a station stations.json did not know. '
                   'Snapshot stations.json from the database and generate the SQL again.';
  end if;
end
$$;''')
    return '\n'.join(out) + '\n'


# ── Report ───────────────────────────────────────────────────────────────────

def _km(a_lat, a_lon, b_lat, b_lon):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    h = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b_lon - a_lon) / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def report(doc, stations_path):
    keyed = {}
    if os.path.exists(stations_path):
        with open(stations_path, encoding='utf-8') as fh:
            for s in json.load(fh)['stations']:
                k = bureau_key(s.get('station_number'))
                if k:
                    keyed[k] = s
    print(doc['meta']['title'])
    for s in doc['meta']['sections']:
        extra = []
        if s['rows_without_a_figure']:
            extra.append(f'{s["rows_without_a_figure"]} with no figure')
        if s.get('rows_printed_twice'):
            extra.append(f'{s["rows_printed_twice"]} printed twice')
        if s.get('positions_unreadable'):
            extra.append(f'{s["positions_unreadable"]} with no readable position')
        if s.get('stations'):
            extra.append(f'{s["stations"]} stations, {s["details"]} details')
        more = f' ({"; ".join(extra)})' if extra else ''
        print(f'  section {s["section"]:<6} dated {s["dated"]}  {s["pages"]:>2} pages  '
              f'{s["rows_printed"]:>5} rows printed, {s["rows_kept"]:>5} kept{more}, '
              f'{s["wrapped_lines"]} wrapped line(s) joined')
    print(f'  crossing types: {doc["meta"]["crossing_types"]}')
    for key in KEYS:
        rows = doc[key]
        numbers = {r['bureau_number'] for r in rows}
        mine = {n for n in numbers if bureau_key(n) in keyed}
        attach = sum(1 for r in rows if r['bureau_number'] in mine)
        print(f'  {key:<14} {len(rows):>5} rows for {len(numbers):>5} stations; '
              f'{len(mine):>4} of those are MegaNet stations ({attach} rows)')
    datums = collections.Counter(r.get('datum') for r in doc['gauge_survey'])
    print(f'  datums: {dict(datums)}')
    for r in doc['station_index']:
        if 'problem' in r:
            print(f'  ! {r["bureau_number"]} {r["station_name"]} (section {r["section"]}): {r["problem"]}')

    # Where the Bureau and MegaNet put the same station in different places.
    far = []
    seen = set()
    for r in doc['station_index']:
        s = keyed.get(bureau_key(r['bureau_number']))
        if not s or 'lat' not in r or s.get('lat') is None or r['bureau_number'] in seen:
            continue
        seen.add(r['bureau_number'])
        d = _km(float(s['lat']), float(s['lon']), float(r['lat']), float(r['lon']))
        if d >= 1.0:
            far.append((d, r, s))
    print(f'  {len(far)} MegaNet stations are 1 km or more from where Sections 1–3 put them '
          f'(left as they are):')
    for d, r, s in sorted(far, key=lambda x: -x[0]):
        print(f'    {d:8.2f} km  {s["id"]:<32} {s["lat"]}, {s["lon"]}  —  '
              f'{r["bureau_number"]} {r["station_name"]} {r["lat_dms"]} {r["lon_dms"]} '
              f'({r["lat"]}, {r["lon"]})')


    # Stations --sql would create within 300 m of one MegaNet already has
    # under the same name, or next to one with no bureau number of its own:
    # most likely the same station twice. Created anyway — they are separate
    # numbers to the Bureau, and only a person can say they are one station.
    plan = plan_new_stations(doc, stations_path)
    placed = [s for s in keyed.values()] + [
        s for s in json.load(open(stations_path, encoding='utf-8'))['stations']
        if not bureau_key(s.get('station_number'))]
    twins = []
    for e in plan:
        if e['lat'] is None:
            continue
        for s in placed:
            if s.get('lat') is None or abs(float(s['lat']) - float(e['lat'])) > 0.01 \
                    or abs(float(s['lon']) - float(e['lon'])) > 0.01:
                continue
            d = _km(float(e['lat']), float(e['lon']), float(s['lat']), float(s['lon']))
            same = re.sub(r'\W', '', e['name'].lower()) == re.sub(r'\W', '', s['name'].lower())
            unnumbered = not re.fullmatch(r'[0-5]\d{0,5}', s.get('station_number') or '')
            if d < 0.3 and (same or unnumbered):
                twins.append((d, e, s))
    print(f'  {len(plan)} stations Sections 1–3 list would be created; '
          f'{len(twins)} of them sit within 300 m of a MegaNet station that has the same '
          f'name or no bureau number of its own (created anyway):')
    for d, e, s in sorted(twins, key=lambda x: x[0]):
        print(f'    {d * 1000:5.0f} m  {e["station_number"]:>6} {e["name"]:<30} beside '
              f'{s["id"]} ({s.get("station_number") or "no number"}, {s["name"]})')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1].strip())
    ap.add_argument('--out', default=OUT_DEFAULT)
    ap.add_argument('--check', action='store_true', help='fail if the JSON would change')
    ap.add_argument('--report', action='store_true', help='what came out, in prose')
    ap.add_argument('--sql', action='store_true',
                    help='print the SQL that writes the lists into the database')
    ap.add_argument('--plan', action='store_true',
                    help='print the stations --sql would create, as JSON lines')
    ap.add_argument('--stations', default=os.path.join(REPO, 'stations.json'),
                    help='which stations MegaNet has (for --report, --sql and --plan)')
    a = ap.parse_args(argv)

    try:
        doc = build()
    except ParseError as e:
        print(f'error: {e}', file=sys.stderr)
        return 2

    if a.report:
        report(doc, a.stations)
        return 0
    if a.plan:
        for e in plan_new_stations(doc, a.stations):
            print(json.dumps(e, ensure_ascii=False))
        return 0
    if a.sql:
        sys.stdout.write(render_sql(doc, a.stations))
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
