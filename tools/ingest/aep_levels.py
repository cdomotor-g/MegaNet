#!/usr/bin/env python3
"""
aep_levels.py — read the AEP flood level sheets into JSON, work out a water
surface slope for each station from its neighbours, and attach both to the
MegaNet stations they describe.

WHAT THIS IS
    Two workbooks in `archive/aep-levels/`, supplied on 26/09/2026:

      QLD_AEP_Levels_1.xlsx   sheet FWIN_QLD_V9_2   529 rows
      NSW_AEP_Levels_1.xlsx   sheet Sheet1          457 rows

    One row per flood warning station: its number, name, basin and position,
    the ground height at that position (`Elevation (mAHD)`), and the modelled
    water level there in four floods — the 1%, 0.5%, 0.2% and 0.066% annual
    exceedance probability (AEP) events, roughly the 1-in-100, 1-in-200,
    1-in-500 and 1-in-1,500 year floods — all in metres AHD. Then three scores
    the sheet gives its own figures: `Data Source Quality` (1–3), `1% AEP -
    Water Level Difference` (1–3) and `1% AEP - Confidence Score` (1–9, the
    product of the two; the NSW sheet writes it as the formula). Higher is
    better — the one row the QLD sheet comments on, "Incorrect Coordinates",
    scores 1, 1 and 1.

    They are modelled levels, not observed ones, which is why everything that
    shows them says "indicative".

    This writes `data/aep-levels.json` — every row of both sheets, including
    the ~300 stations MegaNet has no record of — and, with --sql, the SQL that
    attaches each row to the station it belongs to
    (db/migrations/0033_aep_levels_and_frequencies.sql is what it writes into).

WHAT IS READ, AND HOW
    The header row is checked word for word, so a re-issued sheet with a column
    moved raises rather than reading heights out of the wrong one. Figures are
    kept at the precision the sheet displays: a cell stores 17.51 as
    17.510000000000002, and the shortest literal that reads back as the same
    double (Python's repr) is 17.51 again. A station number of 0 means the sheet
    gives none (eleven QLD rows) and is kept as no number; those rows are
    attached by position instead (below).

    Checked, and a failure raises:
      * the four levels never fall as the flood gets rarer;
      * no level is below the ground it stands on;
      * the confidence score is the product of the other two;
      * a station number appears in a sheet once — the QLD sheet prints
        32160 twice, identically, and one copy is dropped; two different rows
        under one number would raise.

    A blank level is kept blank. 111 QLD and 138 NSW rows give no level at all,
    and ~100 give only the rarer ones: the sheet does not say why, and the
    likeliest reading — the modelled flood does not reach the point in that
    event — is the card's to say as a possibility, not this file's to assert.

THE WATER SURFACE SLOPE
    A velocity needs a slope (see flood-velocity.js), and the one slope that is
    in these sheets is the fall of the modelled flood surface between stations
    on the same stream. For every row with a level:

      1. The stream is the Bureau's for the station where its river height
         station lists name one (data/river-height-stations.json: Section 3,
         the index, then Section 5, the crossings), and otherwise the name's own
         "(… River)" — every NSW name carries one.
      2. The neighbours are the other rows in the same basin on the same stream
         with a level in the same flood, between 2 and 60 km away along the
         stream. Along the stream is the difference in AMTD where both gauges
         have one (Section 6), and otherwise the straight line × 1.3 — a
         typical sinuosity for these rivers, and the one assumption here.
         Stations at a dam, weir, headwater or tailwater are no one's
         neighbour: the level there is held by the structure, and the step
         across it is not a slope.
      3. The nearest neighbour upstream (higher level) and downstream (lower
         or equal) give the slope as the fall between them over the distance
         between them; only one of the two gives the fall to that one.

    It is stored raw with the sentence that says where it came from
    (`slope_basis`); flood-velocity.js decides what to do with a slope that is
    too flat or too steep to use.

    Most rows have no such neighbour — QLD names rarely say which stream they
    are on — and those take a default: the median of the slopes above among
    stations standing at a similar height (below 10 m AHD, 10–50, 50–150,
    150–400, 400 and up), written into the JSON's meta as `default_slopes`.
    The coastal flats come out flattest and the uplands steepest, as they
    should; the inland plains (150–400 m) are flatter than the coastal ranges
    below them, which is why the bands are not a single curve.

WHAT THE SQL DOES
    Attaches each row to the live station with its number (bureau_key(), as
    everywhere) or, for a row with no number, to the station within ~60 m of
    the sheet's position. Only where the station has no row from that sheet yet,
    so it is safe to run again, and it never overwrites a row somebody has since
    edited in the station editor. A station in both sheets (the border rivers)
    gets both rows.

USAGE
    python3 tools/ingest/aep_levels.py            # rewrite the JSON
    python3 tools/ingest/aep_levels.py --check    # fail if it would change
    python3 tools/ingest/aep_levels.py --report   # what came out, in prose
    python3 tools/ingest/aep_levels.py --sql \\
      | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction

Standard library only.
"""

import argparse
import collections
import hashlib
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import xlsx  # noqa: E402  (tools/ingest/xlsx.py, stdlib only)

REPO = os.path.dirname(os.path.dirname(HERE))
ARCHIVE = os.path.join('archive', 'aep-levels')
OUT_DEFAULT = os.path.join(REPO, 'data', 'aep-levels.json')
RIVER_HEIGHT = os.path.join(REPO, 'data', 'river-height-stations.json')
TAG = 'aep_levels.py'
SUPPLIED = '2026-09-26'

HEADER = ['Station Number', 'Station Name', 'Basin', 'Lat', 'Long', 'State',
          'Location Types', 'Elevation (mAHD)', '1% AEP (EPSG:3577)- Water Level',
          '0.5% AEP - Water Level', '0.2% AEP - Water Level', '0.066% AEP - Water Level',
          'Data Source Quality', '1% AEP - Water Level Difference',
          '1% AEP - Confidence Score']
QLD_EXTRA = ['Comment', 'Correct Lat', 'Correct Long']

SOURCES = [
    {'file': 'QLD_AEP_Levels_1.xlsx', 'sheet': 'FWIN_QLD_V9_2', 'state': 'QLD',
     'header': HEADER + QLD_EXTRA},
    {'file': 'NSW_AEP_Levels_1.xlsx', 'sheet': 'Sheet1', 'state': 'NSW',
     'header': HEADER},
]

# The four floods, most frequent first — the order a level may only rise in.
LEVELS = [('aep_1_m', '1%'), ('aep_0_5_m', '0.5%'), ('aep_0_2_m', '0.2%'),
          ('aep_0_066_m', '0.066%')]
LEVEL_KEYS = [k for k, _ in LEVELS]
LEVEL_LABEL = dict(LEVELS)

FIELDS = ['bureau_number', 'station_name', 'basin', 'state', 'source', 'location_types',
          'lat', 'lon', 'ground_m', *LEVEL_KEYS, 'data_quality', 'level_difference',
          'confidence', 'comment', 'slope', 'slope_basis']

SINUOSITY = 1.3
NEIGHBOUR_KM = (2.0, 60.0)
# A station whose level a structure holds: not a neighbour, see the head.
STRUCTURE_RE = re.compile(r'\b(DAM|WEIR|HW|TW|HEADWATER|TAILWATER|SPILLWAY|STORAGE|BARRAGE)\b')


class ParseError(Exception):
    pass


class Num(str):
    """A figure as the sheet displays it — written to JSON and SQL unquoted."""


def figure(cell, where):
    """The shortest literal that is the cell's double, or None for an empty cell."""
    if cell is None:
        return None
    if cell.kind != 'number':
        raise ParseError(f'{where}: {cell.raw!r} is not a number')
    v = float(cell.raw)
    if v == int(v) and abs(v) < 1e15:
        return Num(str(int(v)))
    return Num(repr(v))


def integer(cell, where):
    f = figure(cell, where)
    if f is None:
        return None
    if '.' in f or 'e' in f:
        raise ParseError(f'{where}: {cell.raw!r} is not a whole number')
    return int(f)


def text(cell):
    if cell is None:
        return None
    t = re.sub(r'\s+', ' ', str(cell.value)).strip()
    return t or None


# ── Reading ──────────────────────────────────────────────────────────────────

def read_source(src):
    path = os.path.join(REPO, ARCHIVE, src['file'])
    wb = xlsx.load(path)
    sheets = {s.name: s for s in wb.sheets}
    if src['sheet'] not in sheets:
        raise ParseError(f'{src["file"]}: no sheet {src["sheet"]!r} (has {sorted(sheets)})')
    sh = sheets[src['sheet']]
    got = [sh.text(1, c).strip() for c in range(1, len(src['header']) + 1)]
    if got != src['header']:
        raise ParseError(f'{src["file"]}: the header is not the one this reads:\n'
                         f'  expected {src["header"]}\n  got      {got}')
    col = {h: i + 1 for i, h in enumerate(src['header'])}

    rows, seen, dropped = [], {}, 0
    for r in range(2, sh.max_row + 1):
        if sh.row_is_blank(r):
            continue
        where = f'{src["file"]} row {r}'
        c = lambda h: sh.cell(r, col[h])  # noqa: E731
        number = integer(c('Station Number'), where)
        row = {
            'bureau_number': str(number) if number else None,
            'station_name': text(c('Station Name')),
            'basin': text(c('Basin')),
            'state': text(c('State')),
            'source': src['state'],
            'location_types': text(c('Location Types')),
            'lat': figure(c('Lat'), where),
            'lon': figure(c('Long'), where),
            'ground_m': figure(c('Elevation (mAHD)'), where),
            'aep_1_m': figure(c('1% AEP (EPSG:3577)- Water Level'), where),
            'aep_0_5_m': figure(c('0.5% AEP - Water Level'), where),
            'aep_0_2_m': figure(c('0.2% AEP - Water Level'), where),
            'aep_0_066_m': figure(c('0.066% AEP - Water Level'), where),
            'data_quality': integer(c('Data Source Quality'), where),
            'level_difference': integer(c('1% AEP - Water Level Difference'), where),
            'confidence': integer(c('1% AEP - Confidence Score'), where),
        }
        if 'Comment' in col:
            row['comment'] = text(c('Comment'))
            # A corrected position, where the sheet gives one, is the position.
            clat, clon = figure(c('Correct Lat'), where), figure(c('Correct Long'), where)
            if (clat is None) != (clon is None):
                raise ParseError(f'{where}: a corrected latitude without a longitude, or the reverse')
            if clat is not None:
                row['lat'], row['lon'] = clat, clon
        if not row['station_name'] or row['lat'] is None or row['lon'] is None:
            raise ParseError(f'{where}: a row needs a name and a position')
        check_row(row, where)

        key = row['bureau_number']
        if key is not None and key in seen:
            if seen[key] == row:
                dropped += 1
                continue
            raise ParseError(f'{where}: station {key} is in the sheet twice, differently')
        if key is not None:
            seen[key] = row
        rows.append({k: v for k, v in row.items() if v is not None})
    return sh, rows, dropped, path


def check_row(row, where):
    levels = [(k, row[k]) for k in LEVEL_KEYS if row[k] is not None]
    for (ka, a), (kb, b) in zip(levels, levels[1:]):
        if float(b) < float(a):
            raise ParseError(f'{where}: the {LEVEL_LABEL[kb]} AEP level ({b}) is below '
                             f'the {LEVEL_LABEL[ka]} one ({a})')
    if row['ground_m'] is not None:
        for k, v in levels:
            if float(v) < float(row['ground_m']):
                raise ParseError(f'{where}: the {LEVEL_LABEL[k]} AEP level ({v}) is below '
                                 f'the ground ({row["ground_m"]})')
    q, d, s = row['data_quality'], row['level_difference'], row['confidence']
    if None in (q, d, s) or q * d != s:
        raise ParseError(f'{where}: confidence {s} is not quality {q} × difference {d}')
    if not (1 <= q <= 3 and 1 <= d <= 3):
        raise ParseError(f'{where}: a score outside 1–3 ({q}, {d})')


# ── The slope ────────────────────────────────────────────────────────────────

def stream_key(name):
    s = re.sub(r'[^A-Z0-9 ]', ' ', (name or '').upper())
    s = re.sub(r'\bCK\b', 'CREEK', s)
    s = re.sub(r'\b(RV|R)\b', 'RIVER', s)
    return re.sub(r'\s+', ' ', s).strip() or None


def km_between(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (float(a['lat']), float(a['lon']),
                                            float(b['lat']), float(b['lon'])))
    h = (math.sin((la2 - la1) / 2) ** 2
         + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2)
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(h)))


def plain(v, sig=3):
    """A positive number to `sig` significant figures, never in exponent form."""
    if v == 0:
        return Num('0')
    dp = max(0, sig - 1 - math.floor(math.log10(abs(v))))
    s = f'{v:.{dp}f}'
    if '.' in s:
        s = s.rstrip('0').rstrip('.')
    return Num(s)


# The ground-height bands a station with no neighbour takes its slope from:
# the median slope of the rows that have one, in the same band. Written into
# the JSON's meta, and flood-velocity.js carries a copy (`npm run floodvel`
# holds the two together). Upper bounds in m AHD; the last band is open.
SLOPE_BANDS = [10, 50, 150, 400, None]


def default_slopes(rows):
    out, lo = [], None
    for hi in SLOPE_BANDS:
        got = sorted(float(r['slope']) for r in rows
                     if 'slope' in r and r.get('ground_m') is not None
                     and (lo is None or float(r['ground_m']) >= lo)
                     and (hi is None or float(r['ground_m']) < hi))
        if not got:
            raise ParseError(f'no slope at all in the band {lo}–{hi} m to take a default from')
        mid = len(got) // 2
        median = got[mid] if len(got) % 2 else (got[mid - 1] + got[mid]) / 2
        out.append({'from_m': lo, 'below_m': hi, 'slope': float(plain(median, 2)), 'rows': len(got)})
        lo = hi
    return out


def attach_slopes(rows):
    """Give every row with a level and a same-stream neighbour a slope."""
    rhs = {}
    if os.path.exists(RIVER_HEIGHT):
        with open(RIVER_HEIGHT, encoding='utf-8') as fh:
            rhs = json.load(fh)
    bureau_stream, amtd = {}, {}
    # Section 3's stream first (every river height station it lists), then
    # Section 5's, which names the stream a crossing is on.
    for r in rhs.get('station_index', []):
        if r.get('section') == '3' and r.get('stream'):
            bureau_stream.setdefault(r['bureau_number'].lstrip('0'), r['stream'])
    for c in rhs.get('crossings', []):
        if c.get('stream'):
            bureau_stream.setdefault(c['bureau_number'].lstrip('0'), c['stream'])
    for g in rhs.get('gauge_survey', []):
        if g.get('amtd_km') is not None:
            amtd.setdefault(g['bureau_number'].lstrip('0'), float(g['amtd_km']))

    for r in rows:
        num = (r.get('bureau_number') or '').lstrip('0')
        m = re.search(r'\(([^()]*)\)[^()]*$', r['station_name'])
        r['_stream'] = stream_key(bureau_stream.get(num) or (m.group(1) if m else None))
        r['_amtd'] = amtd.get(num)
        r['_structure'] = bool(STRUCTURE_RE.search(r['station_name'].upper()))

    by_stream = collections.defaultdict(list)
    for r in rows:
        if r['_stream']:
            by_stream[(r.get('basin'), r['_stream'])].append(r)

    for r in rows:
        if not r['_stream']:
            continue
        k = next((k for k in LEVEL_KEYS if k in r), None)
        if k is None:
            continue
        here = float(r[k])
        up = down = None
        for q in by_stream[(r.get('basin'), r['_stream'])]:
            if q is r or q['_structure'] or k not in q:
                continue
            if r['_amtd'] is not None and q['_amtd'] is not None:
                along, how = abs(r['_amtd'] - q['_amtd']), 'amtd'
            else:
                along, how = km_between(r, q) * SINUOSITY, 'line'
            if not (NEIGHBOUR_KM[0] <= along <= NEIGHBOUR_KM[1]):
                continue
            cand = (along, q, how)
            if float(q[k]) > here:
                if up is None or along < up[0]:
                    up = cand
            elif down is None or along < down[0]:
                down = cand
        if not up and not down:
            continue
        if up and down:
            fall = float(up[1][k]) - float(down[1][k])
            dist = up[0] + down[0]
            hows = {up[2], down[2]}
            where = (f'from {up[1]["station_name"]}, {up[0]:.1f} km upstream, to '
                     f'{down[1]["station_name"]}, {down[0]:.1f} km downstream')
        else:
            one = up or down
            fall = abs(float(one[1][k]) - here)
            dist = one[0]
            hows = {one[2]}
            where = (f'from here to {one[1]["station_name"]}, {one[0]:.1f} km '
                     f'{"upstream" if up else "downstream"}')
        measure = ('along the stream by AMTD' if hows == {'amtd'}
                   else 'straight line × 1.3' if hows == {'line'}
                   else 'AMTD and straight line × 1.3')
        r['slope'] = plain(fall / (dist * 1000.0))
        r['slope_basis'] = (f'{LEVEL_LABEL[k]} AEP water surface {where}: '
                            f'{fall:.2f} m over {dist:.1f} km ({measure})')

    for r in rows:
        for k in ('_stream', '_amtd', '_structure'):
            r.pop(k, None)


# ── Building ─────────────────────────────────────────────────────────────────

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        h.update(fh.read())
    return h.hexdigest()


def build():
    rows, sources = [], []
    for src in SOURCES:
        sh, got, dropped, path = read_source(src)
        rows.extend(got)
        sources.append({
            'state': src['state'], 'file': f'{ARCHIVE}/{src["file"]}', 'sheet': src['sheet'],
            'sha256': sha256(path), 'rows_read': len(got) + dropped, 'rows_kept': len(got),
            'duplicates_dropped': dropped,
            'rows_without_a_level': sum(1 for r in got if not any(k in r for k in LEVEL_KEYS)),
        })
    attach_slopes(rows)
    ordered = [{k: r[k] for k in FIELDS if k in r} for r in rows]
    meta = {
        'title': 'AEP flood levels at flood warning stations, Queensland and New South Wales',
        'supplied': SUPPLIED,
        'generator': 'tools/ingest/aep_levels.py',
        'levels': {k: f'{v} AEP water level, m AHD' for k, v in LEVELS},
        'ground_m': 'Elevation (mAHD): the ground at the sheet\'s position',
        'scores': {
            'data_quality': 'Data Source Quality, 1–3',
            'level_difference': '1% AEP - Water Level Difference, 1–3',
            'confidence': '1% AEP - Confidence Score, 1–9 (quality × difference)',
        },
        'slope': ('m/m, the modelled water surface between same-stream neighbours; '
                  'see the head of tools/ingest/aep_levels.py'),
        'sources': sources,
        'rows_with_a_slope': sum(1 for r in ordered if 'slope' in r),
        'default_slopes': default_slopes(ordered),
    }
    return {'meta': meta, 'rows': ordered}


# ── Output ───────────────────────────────────────────────────────────────────

def dump_value(v):
    return str(v) if isinstance(v, Num) else json.dumps(v, ensure_ascii=False)


def dump_row(row):
    return '{' + ','.join(f'{json.dumps(k)}:{dump_value(v)}' for k, v in row.items()) + '}'


def render(doc):
    return ('{\n"meta": ' + json.dumps(doc['meta'], ensure_ascii=False) + ',\n"rows": [\n'
            + ',\n'.join(dump_row(r) for r in doc['rows']) + '\n]\n}\n')


def q(v):
    if v is None:
        return 'null'
    if isinstance(v, (Num, int)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


# The station document's row, column by column, from a sheet row.
COLUMNS = ['as_at', 'source', 'point_lat', 'point_lon', 'ground_m', *LEVEL_KEYS,
           'data_quality', 'level_difference', 'confidence', 'slope', 'slope_basis', 'note']
TYPES = {'as_at': 'date', 'source': 'text', 'slope_basis': 'text', 'note': 'text',
         'data_quality': 'integer', 'level_difference': 'integer', 'confidence': 'integer'}


def source_label(r):
    s = next(x for x in SOURCES if x['state'] == r['source'])
    return f'{s["file"]} ({s["sheet"]})'


def row_values(r):
    note = f'Sheet comment: {r["comment"]}' if r.get('comment') else None
    return {'as_at': SUPPLIED, 'source': source_label(r), 'point_lat': r['lat'],
            'point_lon': r['lon'], 'ground_m': r.get('ground_m'),
            **{k: r.get(k) for k in LEVEL_KEYS},
            'data_quality': r['data_quality'], 'level_difference': r['level_difference'],
            'confidence': r['confidence'], 'slope': r.get('slope'),
            'slope_basis': r.get('slope_basis'), 'note': note}


def render_sql(doc):
    out = ['-- Generated by tools/ingest/aep_levels.py — do not edit.',
           '-- The AEP flood level sheets, attached to the live stations they describe:',
           '-- by bureau number, or by position (within ~60 m) for a row with none. A',
           '-- station that already has a row from the same sheet is left alone.',
           '--',
           '--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f this.sql']
    for s in doc['meta']['sources']:
        out.append(f'--   {s["state"]}  {s["rows_kept"]:>4} rows  {s["file"]} ({s["sheet"]})')
    values = ',\n'.join(
        f'    ({i}, {q(r.get("bureau_number"))}, '
        + ', '.join(q(v) + (f'::{TYPES.get(c, "numeric")}' if i == 0 else '')
                    for c, v in row_values(r).items())
        + ')'
        for i, r in enumerate(doc['rows']))
    cols = ', '.join(COLUMNS)
    out.append(f'''
with v (src, bureau_number, {cols}) as (
  values
{values}
),
-- By number where the sheet gives one; by position where it does not, to the
-- nearest live station within 0.0006° (~60 m) each way, and said so on the row.
by_number as (
  select st.id as station_id, v.*
    from v
    join meganet.station st
      on meganet.bureau_key(st.station_number) = meganet.bureau_key(v.bureau_number)
     and st.deleted_at is null
   where v.bureau_number is not null
),
by_position as (
  select distinct on (v.src) st.id as station_id, v.*
    from v
    join meganet.station st
      on st.deleted_at is null and st.lat is not null and st.lon is not null
     and abs(st.lat - v.point_lat) < 0.0006 and abs(st.lon - v.point_lon) < 0.0006
   where v.bureau_number is null
   order by v.src, (st.lat - v.point_lat) ^ 2 + (st.lon - v.point_lon) ^ 2
),
matched as (
  select m.* from (
    select * from by_number
    union all
    select station_id, src, bureau_number, as_at, source, point_lat, point_lon,
           ground_m, {', '.join(LEVEL_KEYS)}, data_quality, level_difference,
           confidence, slope, slope_basis,
           concat_ws(' ', note, 'Matched by position: the sheet gives no station number.')
      from by_position
  ) m
   where not exists (select 1 from meganet.station_aep_level t
                      where t.station_id = m.station_id and t.source = m.source)
),
attached as (
  insert into meganet.station_aep_level (station_id, ord, {cols}, updated_by)
  select m.station_id,
         coalesce((select max(t.ord) + 1 from meganet.station_aep_level t
                    where t.station_id = m.station_id), 0)
           + (row_number() over (partition by m.station_id order by m.src))::integer - 1,
         {', '.join('m.' + c for c in COLUMNS)}, {q(TAG)}
    from matched m
  returning station_id
)
-- The station's own stamp moves too, so an editor holding it open is told
-- to reload rather than saving over what just arrived.
update meganet.station st set updated_by = {q(TAG)}
 where st.id in (select station_id from attached);''')
    return '\n'.join(out) + '\n'


def report(doc, stations_path):
    keyed, located = {}, []
    if os.path.exists(stations_path):
        with open(stations_path, encoding='utf-8') as fh:
            for s in json.load(fh)['stations']:
                k = (s.get('station_number') or '').strip().lstrip('0')
                if k:
                    keyed[k] = s
                if s.get('lat') is not None:
                    located.append(s)
    print(doc['meta']['title'])
    for s in doc['meta']['sources']:
        print(f'  {s["state"]}  {s["rows_read"]:>4} rows read, {s["rows_kept"]:>4} kept '
              f'({s["duplicates_dropped"]} duplicate dropped), {s["rows_without_a_level"]} '
              f'with no level — {s["file"]} ({s["sheet"]})')
    mine = far = by_pos = 0
    for r in doc['rows']:
        st = keyed.get((r.get('bureau_number') or '').lstrip('0'))
        if st is None and r.get('bureau_number') is None:
            st = next((s for s in located if abs(s['lat'] - float(r['lat'])) < 0.0006
                       and abs(s['lon'] - float(r['lon'])) < 0.0006), None)
            by_pos += st is not None
        if st is None:
            continue
        mine += 1
        if st.get('lat') is not None and km_between(r, st) > 1:
            far += 1
            print(f'  far: {r.get("bureau_number")} {r["station_name"]} is '
                  f'{km_between(r, st):.1f} km from MegaNet\'s {st["id"]}')
    print(f'  {mine} rows are MegaNet stations ({by_pos} of them by position); '
          f'{far} are more than 1 km from MegaNet\'s position')
    print(f'  {doc["meta"]["rows_with_a_slope"]} rows have a same-stream slope')


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
    print(f'{a.out}: {len(doc["rows"])} rows from {len(doc["meta"]["sources"])} sheets, '
          f'{len(body):,} bytes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
