#!/usr/bin/env python3
"""Load #124's extraction and #125's crosswalk into the MegaNet schema.

Emits plain SQL on stdout, like `tools/import_stations_json.py` and for the same
reason: nothing here opens a database connection, so the output can be read
before it is run, piped into `psql`, or attached to a ticket.

    python3 tools/ingest/load.py > /tmp/history.sql
    psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f /tmp/history.sql

    # or in one go
    python3 tools/ingest/load.py \\
      | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction

Requires 0014_inspection_history.sql to have been applied.

## What it writes

Five tables and then one function call:

    meganet.inspection_block          1,093 station blocks
    meganet.inspection_block_fact     the `ID's` lines, split
    meganet.inspection                14,982 visits, origin = 'import'
    meganet.inspection_measurement    151,532 cells, each with its source string
    meganet.inspection_reject         153 rows that would not load
    meganet.project_inspection_measurements()

The bulk goes in through `COPY` into temporary tables, and the permanent tables
are then upserted from those. That is what makes 150,000 rows a few seconds
rather than a few minutes, and it is also what makes the whole thing readable:
the logic is at the top and the bottom of the file and the middle is data.

## Why a re-run is safe

Every visit has a `source_ref` — `<workbook>:<sheet>:<banner row>:<row>` — and
its primary key is a UUID derived from that ref by `uuid5`. The same cell
therefore produces the same UUID on every run, on any machine, so the second run
upserts the rows the first one wrote rather than inserting a parallel copy.
Nothing depends on reading an id back out of the database, which is what lets
the whole load be one stream of SQL.

The load is a *sync*, not an append: a block or a visit that the extractor no
longer emits is deleted. That deletion is a hard one, unlike
`meganet.delete_inspection()`'s soft delete, and the difference is deliberate —
a soft-deleted row is a record somebody chose to retire, whereas a row that has
fallen out of the extract never happened. Rows typed into MegaNet
(`origin = 'form'`) are never touched by any statement in the output.

## The route for a connection that cannot carry COPY (#159)

The stream above assumes `psql`: `COPY … FROM stdin` and temporary tables both
need the whole thing to ride one session. A Supabase MCP connection has neither
— its SQL surface takes one statement text per request, on a fresh session, and
20 MB in one request is not a statement, it is a payload. `--chunks DIR` emits
the same load re-cut for that surface:

    python3 tools/ingest/load.py --chunks /tmp/history-chunks
    # 1. setup.sql        → run over the MCP SQL surface (staging schema,
    #                       a secret-gated stage RPC, the sync function)
    # 2. the data plane   → python3 tools/ingest/apply_chunks.py --dir /tmp/history-chunks
    #                       (PostgREST RPC over HTTPS, resumable, verifies counts)
    # 3. sync.sql         → run over the MCP SQL surface. One statement, one
    #                       function call, one transaction — it refuses to run
    #                       unless the staged counts match this emission exactly.
    # 4. cleanup.sql      → drops the staging schema and both functions.

Same rows, same upserts, same deletes: the sync function's body is this file's
own UPSERT_* SQL with the temporary tables renamed to staging ones, so the two
routes cannot drift apart. What preserves the single-transaction rule is that
the sync is *one function call*: half a sync cannot happen, because a function
call cannot half-commit.

If the operator's own network cannot reach PostgREST either (the agent
environment's egress policy blocks `*.supabase.co`), the chunks can be
committed to the repo and relayed by the database itself: `pg_net`'s
`net.http_get()` fetches each chunk from `raw.githubusercontent.com`, and
`meganet.load159_stage()` is fed straight from `net._http_response.content` —
the same gate, the same casts, the same per-file row-count verification. #159
was applied that way; the exact statements are on the issue.

Standard library only.
"""

from __future__ import annotations

import argparse
import decimal
import json
import os
import re
import secrets
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(REPO, 'data', 'inspections')

# The namespace the visit UUIDs are derived in. Fixed forever: changing it would
# make every row on the next run a new row, and orphan every row already loaded.
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL,
                       'https://github.com/cdomotor-g/MegaNet/inspection')

WORKBOOK = 'archive/QLD All Site Inspections.xlsx'
SOURCE = 'qld-all-site-inspections'

# #125's tiers, as meganet.inspection.station_match spells them. The crosswalk
# writes exactly these five and the check constraint allows exactly these five
# plus 'form'; a new tier would fail loudly here rather than quietly at insert.
TIERS = {'number', 'name', 'number_ambiguous', 'name_ambiguous', 'unmatched'}


def read_jsonl(name):
    path = os.path.join(DATA, name)
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line, parse_float=decimal.Decimal)


def visit_id(ref):
    """The stable primary key for one workbook row."""
    return str(uuid.uuid5(NAMESPACE, ref))


# ── COPY literals ────────────────────────────────────────────────────────────
# Postgres' text COPY format. Tab, newline, carriage return and backslash have
# to be escaped or a remark containing one would shift every column after it;
# `\N` is null, which is why an empty string and a missing value are different
# things all the way through this file.

_ESCAPES = str.maketrans({
    '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t',
    '\b': '\\b', '\f': '\\f', '\v': '\\v',
})


def c(value):
    """One COPY field."""
    if value is None:
        return '\\N'
    if value is True:
        return 't'
    if value is False:
        return 'f'
    if isinstance(value, (int, decimal.Decimal, float)):
        return str(value)
    return str(value).translate(_ESCAPES)


def cjson(value):
    """A jsonb field. Decimals are written as their digits, not as floats."""
    if value is None:
        return '\\N'
    return c(json.dumps(value, cls=_Encoder, separators=(',', ':'), sort_keys=True))


def cints(values):
    """An integer[] field."""
    if values is None:
        return '\\N'
    return '{' + ','.join(str(int(v)) for v in values) + '}'


class _Encoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, decimal.Decimal):
            return _Raw(str(o))
        return super().default(o)


class _Raw(float):
    """A number that survives json.dumps with its own digits."""
    def __new__(cls, text):
        obj = super().__new__(cls, text)
        obj._text = text
        return obj

    def __repr__(self):
        return self._text


def num(value):
    """A numeric field, from a cell that may hold anything."""
    if value is None or value is True or value is False:
        return None
    if isinstance(value, (int, decimal.Decimal)):
        return value
    try:
        return decimal.Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


# ── Emitting ─────────────────────────────────────────────────────────────────

def copy_block(out, table, columns, rows):
    """A temporary table's worth of data, as one COPY statement."""
    out.write('copy %s (%s) from stdin;\n' % (table, ', '.join(columns)))
    n = 0
    for row in rows:
        out.write('\t'.join(row))
        out.write('\n')
        n += 1
    out.write('\\.\n\n')
    return n


# ── The chunked route (#159) ─────────────────────────────────────────────────
# Everything below re-cuts the same emission for a connection that cannot carry
# COPY. The rows come out of the same generators, so the two routes cannot
# disagree about a value — only about how it travels.

_UNESCAPES = {'\\': '\\', 'n': '\n', 'r': '\r', 't': '\t',
              'b': '\b', 'f': '\f', 'v': '\v'}


def uncopy(field):
    """One COPY field back to the value it encoded. `c()`'s exact inverse:
    it only ever writes the seven escapes in `_ESCAPES`, so this is lossless."""
    if field == '\\N':
        return None
    if '\\' not in field:
        return field
    out, i = [], 0
    while i < len(field):
        ch = field[i]
        if ch == '\\' and i + 1 < len(field):
            out.append(_UNESCAPES.get(field[i + 1], field[i + 1]))
            i += 2
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def staging_columns(ddl):
    """`(name, type)` pairs out of a TEMP_* constant, in declaration order.
    Safe to split on commas because no column type here carries one."""
    body = ddl[ddl.index('(') + 1:ddl.rindex(')')]
    pairs = []
    for entry in body.split(','):
        entry = entry.strip()
        if entry:
            name, _, typ = entry.partition(' ')
            pairs.append((name, typ.strip()))
    return pairs


def staged(sql):
    """The stream's own SQL, with the temporary tables renamed to staging ones.
    Word boundaries keep `inspection_block_fact` out of it."""
    return re.sub(r'\b(_block|_fact|_visit|_measurement|_reject)\b',
                  r'meganet_load.\1', sql)


class ChunkWriter:
    """The data plane of the chunked route: the same rows, as JSON files small
    enough for one HTTPS request each, all values as text for the server to
    cast. `tools/ingest/apply_chunks.py` is the applier."""

    def __init__(self, directory, chunk_bytes):
        self.dir = directory
        self.chunk_bytes = chunk_bytes
        self.files = []
        self.totals = {}
        self.columns = {}

    def table(self, table, columns, rows):
        part, buf, size, n = 0, [], 0, 0

        def flush():
            nonlocal part, buf, size
            if not buf:
                return
            name = 'chunk%s_%03d.json' % (table, part)
            with open(os.path.join(self.dir, name), 'w', encoding='utf-8') as f:
                json.dump({'table': table, 'columns': columns, 'rows': buf}, f,
                          ensure_ascii=False, separators=(',', ':'))
            self.files.append({'file': name, 'table': table, 'rows': len(buf)})
            part, buf, size = part + 1, [], 0

        for row in rows:
            vals = [uncopy(f) for f in row]
            size += len(json.dumps(vals, ensure_ascii=False,
                                   separators=(',', ':'))) + 2
            buf.append(vals)
            n += 1
            if size >= self.chunk_bytes:
                flush()
        flush()
        self.totals[table] = n
        self.columns[table] = columns
        return n


def crosswalk_by_ref():
    """block ref (or flat row ref) → (crosswalk key, station id, tier).

    #125 groups the workbook's blocks and its two flat tabs into 1,051
    identities and lists, on each, every ref that fed it. Inverting that is how
    a visit learns which station it belongs to.
    """
    index = {}
    for entry in read_jsonl('station_crosswalk.jsonl'):
        tier = entry['tier']
        if tier not in TIERS:
            raise SystemExit(
                'crosswalk tier %r is not one meganet.inspection.station_match '
                'allows (%s) — 0014 and tools/ingest/crosswalk.py have drifted'
                % (tier, ', '.join(sorted(TIERS))))
        for ref in entry['blocks']:
            index[ref] = (entry['key'], entry['station_id'], tier)
    return index


def build(out, chunks=None):
    xwalk = crosswalk_by_ref()
    counts = {}

    def emit(table, columns, rows):
        if chunks is not None:
            return chunks.table(table, columns, rows)
        return copy_block(out, table, columns, rows)

    out.write(HEADER)

    # ── Blocks ───────────────────────────────────────────────────────────────
    block_cols = ['ref', 'source', 'sheet', 'banner_row', 'end_row', 'block_index',
                  'family', 'config_key', 'station_name', 'cbm_no', 'station_id',
                  'station_key', 'station_match', 'property_owner', 'ids_raw',
                  'header_rows', 'date_column', 'inherited_header', 'columns',
                  'calibration_points', 'notes', 'annotations', 'comments']
    facts = []

    def block_rows():
        for b in read_jsonl('blocks.jsonl'):
            key, station_id, tier = xwalk.get(b['ref'], (None, None, 'unmatched'))
            for name, value in (b.get('ids') or {}).items():
                facts.append(fact_row(b['ref'], name, value))
            yield [
                c(b['ref']), c(b.get('source') or SOURCE), c(b['sheet']),
                c(b.get('banner_row')), c(b.get('end_row')), c(b.get('block_index')),
                c(b.get('family') or ''), c(b.get('inspection_config')),
                c(b.get('station_name') or ''), c(b.get('cbm_no') or ''),
                c(station_id), c(key), c(tier),
                c(b.get('property_owner') or ''), c(b.get('ids_raw') or ''),
                cints(b.get('header_rows') or []), c(b.get('date_column') or ''),
                c(bool(b.get('inherited_header'))),
                cjson(b.get('columns') or {}), cjson(b.get('calibration_points') or {}),
                cjson(b.get('notes') or {}), cjson(b.get('annotations') or []),
                cjson(b.get('comments') or []),
            ]

    out.write(SECTION % 'The station blocks')
    out.write(TEMP_BLOCK)
    counts['blocks'] = emit('_block', block_cols, block_rows())
    out.write(UPSERT_BLOCK)

    # ── Block facts ──────────────────────────────────────────────────────────
    out.write(SECTION % "The `ID's` lines, split into facts")
    out.write(TEMP_FACT)
    counts['block_facts'] = emit(
        '_fact',
        ['block_ref', 'fact_key', 'ord', 'value_raw', 'value_num', 'as_at', 'as_at_raw'],
        facts)
    out.write(UPSERT_FACT)

    # ── Visits and their measurements ────────────────────────────────────────
    visit_cols = ['id', 'station_id', 'config_key', 'station_name', 'cbm_no',
                  'inspected_on', 'remarks', 'origin', 'source_ref',
                  'date_precision', 'date_raw', 'source_workbook', 'source_sheet',
                  'source_block_ref', 'source_row', 'station_match', 'station_key',
                  'source_notes']
    measurement_cols = ['inspection_id', 'ord', 'field_key', 'label', 'source_col',
                        'point', 'raw', 'value_class', 'value', 'unit', 'operator',
                        'bound', 'status', 'flag']
    measurements = []

    def visit_rows():
        for r in read_jsonl('inspections.jsonl'):
            ref = r['ref']
            vid = visit_id(ref)
            anchor = r.get('block_ref') or ref
            key, station_id, tier = xwalk.get(anchor, (None, None, 'unmatched'))

            ord_no = 0
            for v in r.get('readings') or ():
                ord_no += 1
                measurements.append(measurement_row(vid, ord_no, v, point=None))
            for v in r.get('calibration') or ():
                ord_no += 1
                measurements.append(measurement_row(
                    vid, ord_no, v, point=num(v.get('point')),
                    field='river_calibration_point'))

            notes = {}
            for name in ('comments', 'flags', 'station_number_raw'):
                if r.get(name):
                    notes[name] = r[name]

            yield [
                c(vid), c(station_id), c(r['inspection_config']),
                c(r.get('station_name') or ''), c(r.get('cbm_no') or ''),
                c(r['inspected_on']), c(r.get('remarks') or ''),
                c('import'), c(ref),
                c(r.get('date_precision') or 'day'), c(r.get('date_raw') or ''),
                c(WORKBOOK), c(r['sheet']),
                c(r.get('block_ref')), c(r.get('row')),
                c(tier), c(key), cjson(notes),
            ]

    out.write(SECTION % 'The visits')
    out.write(TEMP_VISIT)
    counts['visits'] = emit('_visit', visit_cols, visit_rows())
    out.write(UPSERT_VISIT)

    out.write(SECTION % 'Every measured cell, with the string it was written as')
    out.write(TEMP_MEASUREMENT)
    counts['measurements'] = emit('_measurement', measurement_cols, measurements)
    out.write(UPSERT_MEASUREMENT)

    # ── Rejects ──────────────────────────────────────────────────────────────
    def reject_rows():
        for r in read_jsonl('rejects.jsonl'):
            yield [
                c(r['ref']), c(r.get('source') or SOURCE), c(r.get('sheet') or ''),
                c(r.get('banner_row')), c(r.get('row')),
                c(r.get('block_ref')), c(r.get('level') or 'row'),
                c(r['reason']), c(r.get('detail') or ''), c(r.get('row_class') or ''),
                cjson(r.get('cells') or {}),
            ]

    out.write(SECTION % 'The rows that would not load')
    out.write(TEMP_REJECT)
    counts['rejects'] = emit(
        '_reject',
        ['ref', 'source', 'sheet', 'banner_row', 'row_no', 'block_ref', 'level',
         'reason', 'detail', 'row_class', 'cells'],
        reject_rows())
    out.write(UPSERT_REJECT)

    out.write(PROJECT)
    out.write(RECONCILE)
    return counts


def fact_row(block_ref, name, value):
    """One entry off a block's `ID's` line.

    The orifice level is the only one the workbook dates, and it dates it in
    prose — `10.177 AHD as of 7/12/18`. The number and the date are pulled out
    where they can be, and the whole string is kept either way.
    """
    raw = str(value)
    number, as_at, as_at_raw = None, None, ''
    if name == 'orifice_level_raw':
        head = raw.split()[0] if raw.split() else ''
        number = num(head.rstrip('m'))
        lowered = raw.lower()
        for marker in (' as of ', ' as at ', ' at '):
            if marker in lowered:
                as_at_raw = raw[lowered.index(marker) + len(marker):].strip()
                as_at = parse_date(as_at_raw)
                break
    else:
        number = num(raw)
    return [c(block_ref), c(name), c(1), c(raw), c(number), c(as_at), c(as_at_raw)]


def parse_date(text):
    """`7/12/18` → 2018-12-07. Day first, and two-digit years pivot at 50.

    The same rule the extractor reads the date column with, and the workbook's
    own evidence for it is in docs/inspection-workbook-parse-spec.md §6: 1,058
    text dates have a first component over 12 and not one has a second.
    """
    parts = text.replace('-', '/').replace('.', '/').split('/')
    if len(parts) != 3:
        return None
    try:
        day, month, year = (int(p) for p in parts)
    except ValueError:
        return None
    if year < 100:
        year += 1900 if year >= 50 else 2000
    if not (1 <= month <= 12 and 1 <= day <= 31 and 1900 <= year <= 2100):
        return None
    return '%04d-%02d-%02d' % (year, month, day)


def measurement_row(vid, ord_no, v, point, field=None):
    """One cell. `raw` is never null and never repaired; everything else is an
    interpretation, and is null wherever the rules did not license one."""
    return [
        c(vid), c(ord_no), c(field or v.get('field')), c(v.get('label') or ''),
        c(v.get('col') or ''), c(point), c(v['raw']), c(v['class']),
        c(num(v.get('value'))), c(v.get('unit') or ''),
        c(v.get('operator')), c(num(v.get('bound'))), c(v.get('status')),
        c(v.get('flag') or ''),
    ]


# ── The SQL around the data ──────────────────────────────────────────────────

HEADER = """\
-- Generated by tools/ingest/load.py — do not edit.
--
-- The historical inspection archive, from #124's extraction and #125's
-- crosswalk, as one stream of SQL. Apply inside a single transaction:
--
--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f this-file
--
-- Requires db/migrations/0014_inspection_history.sql.
--
-- Re-running this is safe and is a sync rather than an append: every id is
-- derived from the workbook cell it came from, so a second run updates the rows
-- the first one wrote, and anything the extractor no longer emits is removed.
-- Nothing here touches a row with origin = 'form'.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_tables
                  where schemaname = 'meganet' and tablename = 'inspection_measurement') then
    raise exception 'apply db/migrations/0014_inspection_history.sql first';
  end if;
end
$$;

"""

SECTION = """
-- ── %s ─────────────────────────────
"""

TEMP_BLOCK = """
create temporary table _block (
  ref text, source text, sheet text, banner_row integer, end_row integer,
  block_index integer, family text, config_key text, station_name text,
  cbm_no text, station_id text, station_key text, station_match text,
  property_owner text, ids_raw text, header_rows integer[], date_column text,
  inherited_header boolean, columns jsonb, calibration_points jsonb,
  notes jsonb, annotations jsonb, comments jsonb
) on commit drop;

"""

UPSERT_BLOCK = """
insert into meganet.inspection_block (
  ref, source, sheet, banner_row, end_row, block_index, family, config_key,
  station_name, cbm_no, station_id, station_key, station_match, property_owner,
  ids_raw, header_rows, date_column, inherited_header, columns,
  calibration_points, notes, annotations, comments)
select ref, source, sheet, banner_row, end_row, block_index, family, config_key,
       station_name, cbm_no, station_id, station_key, station_match,
       property_owner, ids_raw, header_rows, date_column, inherited_header,
       columns, calibration_points, notes, annotations, comments
  from _block
on conflict (ref) do update set
  source = excluded.source, sheet = excluded.sheet, banner_row = excluded.banner_row,
  end_row = excluded.end_row, block_index = excluded.block_index,
  family = excluded.family, config_key = excluded.config_key,
  station_name = excluded.station_name, cbm_no = excluded.cbm_no,
  station_id = excluded.station_id, station_key = excluded.station_key,
  station_match = excluded.station_match, property_owner = excluded.property_owner,
  ids_raw = excluded.ids_raw, header_rows = excluded.header_rows,
  date_column = excluded.date_column, inherited_header = excluded.inherited_header,
  columns = excluded.columns, calibration_points = excluded.calibration_points,
  notes = excluded.notes, annotations = excluded.annotations,
  comments = excluded.comments;

"""

TEMP_FACT = """
create temporary table _fact (
  block_ref text, fact_key text, ord integer, value_raw text,
  value_num numeric, as_at date, as_at_raw text
) on commit drop;

"""

UPSERT_FACT = """
delete from meganet.inspection_block_fact f
 where not exists (select 1 from _fact t
                    where t.block_ref = f.block_ref and t.fact_key = f.fact_key
                      and t.ord = f.ord);

insert into meganet.inspection_block_fact
  (block_ref, fact_key, ord, value_raw, value_num, as_at, as_at_raw)
select block_ref, fact_key, ord, value_raw, value_num, as_at, as_at_raw from _fact
on conflict (block_ref, fact_key, ord) do update set
  value_raw = excluded.value_raw, value_num = excluded.value_num,
  as_at = excluded.as_at, as_at_raw = excluded.as_at_raw;

"""

TEMP_VISIT = """
create temporary table _visit (
  id uuid, station_id text, config_key text, station_name text, cbm_no text,
  inspected_on date, remarks text, origin text, source_ref text,
  date_precision text, date_raw text, source_workbook text, source_sheet text,
  source_block_ref text, source_row integer, station_match text,
  station_key text, source_notes jsonb
) on commit drop;

"""

# The visits are deleted before they are inserted rather than after, because a
# visit that has fallen out of the extract must take its measurements with it —
# and the measurement rows cascade off this table's primary key.
UPSERT_VISIT = """
delete from meganet.inspection i
 where i.origin = 'import'
   and i.source_workbook = %s
   and not exists (select 1 from _visit v where v.id = i.id);
""" % ("'" + WORKBOOK.replace("'", "''") + "'",) + """
insert into meganet.inspection (
  id, station_id, config_key, station_name, cbm_no, inspected_on, remarks,
  origin, source_ref, date_precision, date_raw, source_workbook, source_sheet,
  source_block_ref, source_row, station_match, station_key, source_notes)
select id, station_id, config_key, station_name, cbm_no, inspected_on, remarks,
       origin, source_ref, date_precision, date_raw, source_workbook, source_sheet,
       source_block_ref, source_row, station_match, station_key, source_notes
  from _visit
on conflict (id) do update set
  station_id = excluded.station_id, config_key = excluded.config_key,
  station_name = excluded.station_name, cbm_no = excluded.cbm_no,
  inspected_on = excluded.inspected_on, remarks = excluded.remarks,
  source_ref = excluded.source_ref, date_precision = excluded.date_precision,
  date_raw = excluded.date_raw, source_workbook = excluded.source_workbook,
  source_sheet = excluded.source_sheet, source_block_ref = excluded.source_block_ref,
  source_row = excluded.source_row, station_match = excluded.station_match,
  station_key = excluded.station_key, source_notes = excluded.source_notes;

-- A block the extractor no longer emits, after its visits have let go of it.
delete from meganet.inspection_block b
 where b.source = '""" + SOURCE + """'
   and not exists (select 1 from _block t where t.ref = b.ref);

"""

TEMP_MEASUREMENT = """
create temporary table _measurement (
  inspection_id uuid, ord integer, field_key text, label text, source_col text,
  point numeric, raw text, value_class text, value numeric, unit text,
  operator text, bound numeric, status text, flag text
) on commit drop;

"""

UPSERT_MEASUREMENT = """
delete from meganet.inspection_measurement m
 where not exists (select 1 from _measurement t
                    where t.inspection_id = m.inspection_id and t.ord = m.ord);

insert into meganet.inspection_measurement (
  inspection_id, ord, field_key, label, source_col, point, raw, value_class,
  value, unit, operator, bound, status, flag)
select inspection_id, ord, field_key, label, source_col, point, raw, value_class,
       value, unit, operator, bound, status, flag
  from _measurement
on conflict (inspection_id, ord) do update set
  field_key = excluded.field_key, label = excluded.label,
  source_col = excluded.source_col, point = excluded.point, raw = excluded.raw,
  value_class = excluded.value_class, value = excluded.value, unit = excluded.unit,
  operator = excluded.operator, bound = excluded.bound, status = excluded.status,
  flag = excluded.flag;

"""

TEMP_REJECT = """
create temporary table _reject (
  ref text, source text, sheet text, banner_row integer, row_no integer,
  block_ref text, level text, reason text, detail text, row_class text,
  cells jsonb
) on commit drop;

"""

UPSERT_REJECT = """
delete from meganet.inspection_reject r
 where r.source = '""" + SOURCE + """'
   and not exists (select 1 from _reject t where t.ref = r.ref);

insert into meganet.inspection_reject (
  ref, source, sheet, banner_row, row_no, block_ref, level, reason, detail,
  row_class, cells)
select ref, source, sheet, banner_row, row_no, block_ref, level, reason, detail,
       row_class, cells
  from _reject
on conflict (ref) do update set
  source = excluded.source, sheet = excluded.sheet, banner_row = excluded.banner_row,
  row_no = excluded.row_no, block_ref = excluded.block_ref, level = excluded.level,
  reason = excluded.reason, detail = excluded.detail, row_class = excluded.row_class,
  cells = excluded.cells;

"""

# The section tables are filled from the measurements rather than by this file,
# so that the mapping between a workbook field and a MegaNet column lives in
# meganet.measurement_field where it can be queried and corrected, instead of in
# this generator where it could only be re-run.
PROJECT = """
-- ── Into 0009's section tables ─────────────────────────────
-- Driven by meganet.measurement_field. Only values with a number are projected;
-- a bound (`>30`), a status word (`U/S`) or a sentence has none, and stays
-- complete in meganet.inspection_measurement, which is the record either way.

select * from meganet.project_inspection_measurements();

"""

RECONCILE = """
-- ── What landed ─────────────────────────────
select * from meganet.inspection_history_reconciliation;
"""


# ── The chunked route's control plane (#159) ─────────────────────────────────
# Three SQL files around the JSON data. The stage function is the only thing
# `anon` can reach, it is gated on a secret minted per emission, and everything
# here is dropped again by cleanup.sql — the door exists for minutes.

TEMPS = {'_block': TEMP_BLOCK, '_fact': TEMP_FACT, '_visit': TEMP_VISIT,
         '_measurement': TEMP_MEASUREMENT, '_reject': TEMP_REJECT}
TABLE_ORDER = ('_block', '_fact', '_visit', '_measurement', '_reject')


def stage_fn_sql(columns_by_table):
    """`meganet.load159_stage()` — one INSERT branch per staging table, the
    casts read off the staging DDL itself so the two cannot drift."""
    branches = []
    for table in TABLE_ORDER:
        cols = columns_by_table[table]
        types = dict(staging_columns(TEMPS[table]))
        casts = ',\n           '.join(
            '(r->>%d)::%s' % (i, types[col]) for i, col in enumerate(cols))
        branches.append(
            "%s p_table = '%s' then\n"
            '    insert into meganet_load.%s (%s)\n'
            '    select %s\n'
            '      from pg_catalog.jsonb_array_elements(p_rows) as x(r);'
            % ('if' if not branches else 'elsif', table, table,
               ',\n        '.join(cols), casts))
    return """
create or replace function meganet.load159_stage(
  p_secret text, p_table text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $stage$
declare
  v_n integer;
begin
  if not exists (select 1 from meganet_load.secret s where s.value = p_secret) then
    raise exception 'load159_stage: bad secret';
  end if;
  %s
  else
    raise exception 'load159_stage: unknown table %%', p_table;
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end
$stage$;

revoke all on function meganet.load159_stage(text, text, jsonb) from public;
grant execute on function meganet.load159_stage(text, text, jsonb) to anon;
""" % '\n  '.join(branches)


def sync_fn_sql():
    """`meganet.load159_sync()` — the whole sync as one function, which is what
    keeps it one transaction on a surface that offers no BEGIN. Its body is the
    stream route's own UPSERT_* SQL, staging-qualified by `staged()`."""
    body = ''.join(staged(part) for part in (
        UPSERT_BLOCK, UPSERT_FACT, UPSERT_VISIT, UPSERT_MEASUREMENT,
        UPSERT_REJECT))
    return """
create or replace function meganet.load159_sync(p_expected jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $sync$
declare
  v_staged    jsonb;
  v_projected jsonb;
  v_recon     jsonb;
begin
  select pg_catalog.jsonb_build_object(
    '_block',       (select count(*) from meganet_load._block),
    '_fact',        (select count(*) from meganet_load._fact),
    '_visit',       (select count(*) from meganet_load._visit),
    '_measurement', (select count(*) from meganet_load._measurement),
    '_reject',      (select count(*) from meganet_load._reject))
    into v_staged;
  if v_staged is distinct from p_expected then
    raise exception
      'load159_sync: staged counts %% do not match the emission''s %% — '
      'stage every chunk first (a rerun of apply_chunks.py resumes), '
      'or truncate meganet_load.* and restage', v_staged, p_expected;
  end if;
%s
  select pg_catalog.jsonb_object_agg(home, rows_written) into v_projected
    from meganet.project_inspection_measurements();

  select pg_catalog.to_jsonb(r) into v_recon
    from meganet.inspection_history_reconciliation r;

  return pg_catalog.jsonb_build_object(
    'staged', v_staged, 'projected', v_projected, 'reconciliation', v_recon);
end
$sync$;

revoke all on function meganet.load159_sync(jsonb) from public;
""" % body


def build_chunks(directory, chunk_bytes):
    """The whole chunked emission: data as JSON files, control as three SQL
    files, and manifest.json tying them together for apply_chunks.py."""
    os.makedirs(directory, exist_ok=True)
    writer = ChunkWriter(directory, chunk_bytes)
    with open(os.devnull, 'w') as devnull:
        counts = build(devnull, chunks=writer)

    secret = secrets.token_hex(24)
    expected = {t: writer.totals[t] for t in TABLE_ORDER}
    expected_json = json.dumps(expected, separators=(',', ':'))

    staging_ddl = ''.join(
        TEMPS[t].replace('create temporary table %s' % t,
                         'create unlogged table meganet_load.%s' % t)
                .replace(') on commit drop;', ');')
        for t in TABLE_ORDER)

    def write(name, text):
        with open(os.path.join(directory, name), 'w', encoding='utf-8') as f:
            f.write(text)

    write('setup.sql', HEADER + """
-- ── The chunked route's staging ─────────────────────────────
-- Everything below is scaffolding and is dropped by cleanup.sql.

drop schema if exists meganet_load cascade;
create schema meganet_load;
revoke all on schema meganet_load from public;
""" + staging_ddl + """
-- The gate. One secret per emission, held in a table nothing is granted on,
-- compared inside the one function anon may execute.
create table meganet_load.secret (value text not null);
insert into meganet_load.secret (value) values ('%s');
""" % secret + stage_fn_sql(writer.columns) + sync_fn_sql() + """
notify pgrst, 'reload schema';
""")

    write('sync.sql', """-- Run over the SQL surface once apply_chunks.py reports every chunk staged.
-- One function call: the sync either happens whole or not at all.
set statement_timeout = '600s';
select meganet.load159_sync('%s'::jsonb) as result;
""" % expected_json)

    write('cleanup.sql', """-- Run last. Removes every piece of scaffolding setup.sql created.
drop function if exists meganet.load159_stage(text, text, jsonb);
drop function if exists meganet.load159_sync(jsonb);
drop schema if exists meganet_load cascade;
notify pgrst, 'reload schema';
""")

    write('manifest.json', json.dumps({
        'rpc': 'load159_stage',
        'profile': 'meganet',
        'secret': secret,
        'expected': expected,
        'files': writer.files,
    }, indent=2) + '\n')

    return counts, writer


def main():
    ap = argparse.ArgumentParser(
        description=__doc__.split('\n')[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', help='write SQL here instead of stdout')
    ap.add_argument('--chunks', metavar='DIR',
                    help='emit the chunked route here instead of the psql '
                         'stream — for a connection that cannot carry COPY '
                         '(see the #159 section of the module docstring)')
    ap.add_argument('--chunk-bytes', type=int, default=900_000,
                    help='data chunk size bound in bytes (default 900000 — '
                         'small enough for one HTTPS request each)')
    args = ap.parse_args()

    if args.chunks:
        counts, writer = build_chunks(args.chunks, args.chunk_bytes)
        for name, n in counts.items():
            print('%-14s %7d' % (name, n), file=sys.stderr)
        print('%-14s %7d' % ('chunk files', len(writer.files)), file=sys.stderr)
        return 0

    handle = open(args.out, 'w', encoding='utf-8') if args.out else sys.stdout
    try:
        counts = build(handle)
    finally:
        if args.out:
            handle.close()

    for name, n in counts.items():
        print('%-14s %7d' % (name, n), file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
