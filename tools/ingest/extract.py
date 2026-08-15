#!/usr/bin/env python3
"""Extractor — #124 (H2 of epic #122).

Reads `archive/QLD All Site Inspections.xlsx` and writes normalised staging
records, block records and a rejects file under `data/inspections/`. It writes
files, never database rows: the load into #115's schema is #126's job.

    python3 tools/ingest/extract.py            # rewrite the staging files
    python3 tools/ingest/extract.py --check    # re-run and fail on any drift

The rules are `docs/inspection-workbook-parse-spec.md` and the code that already
implements them is `survey.py`, which this module imports rather than copies —
one reader, one set of rules, and a rule that changes changes in one place.

What comes out, all under `data/inspections/`:

  blocks.jsonl        one record per station block — the facts that belong to
                      the station rather than the visit, plus the resolved
                      column layout the block's rows were read under.
  inspections.jsonl   one record per inspection row, with the source string
                      beside every value and a provenance ref that survives a
                      re-run.
  rejects.jsonl       every row that could not be read as an inspection, with
                      a reason category and the raw cells. A deliverable, not
                      a debug artefact — #122's acceptance reconciles here.
  duplicates.jsonl    the `ALERTS`-tab rows already recorded on a basin tab.
                      Dropped from the load, not from the record.
  counts.json         rows read / emitted / rejected / dropped, per sheet, and
                      the reconciliation against the survey's figures.

Scope is the manifest's, not this file's: a sheet is read because its
`disposition` says `ingest`. Twelve of the sheets the survey reads are
deliberately not loaded (#122 open question 2, answered 2026-08-15) and that
distinction lives in `inspection_sheet_manifest.json`.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import survey  # noqa: E402  (same directory, deliberately not a package)
import xlsx  # noqa: E402

HERE = survey.HERE
REPO = survey.REPO
WORKBOOK = survey.WORKBOOK
MANIFEST = os.path.join(HERE, 'inspection_sheet_manifest.json')
SURVEY_COUNTS = os.path.join(HERE, 'inspection_survey_counts.json')
SAMPLE = os.path.join(HERE, 'inspection_extract_sample.json')
OUT_DIR = os.path.join(REPO, 'data', 'inspections')

# The workbook this extract came from. A second historical workbook is not
# unimaginable, so the prefix is part of every provenance ref (spec §10).
SOURCE = 'qld-all-site-inspections'

# `meganet.inspection.origin` for everything this epic loads. A backfilled row
# must never read as one somebody typed today.
ORIGIN = 'import'


# ── Value coercion (spec §5) ─────────────────────────────────────────────────
# The governing rule is #122's acceptance and it is absolute: the source string
# is retained in every case. A `>30` fade margin reaches the output as `>30`.

# Fields whose values are text by nature. A word in one of these is a reading,
# not a reading that went wrong, so it is not flagged as text in a number's
# place.
TEXT_FIELDS = {
    'remarks', 'station_name', 'station_number', 'canister_no', 'canister_type',
    'logger_no', 'decoder_serial', 'receiver1_serial', 'receiver2_serial',
    'battery_test_raw', 'shaft_encoder_count_direction', 'shaft_encoder_result',
}

# Hoisted out of `readings` onto the record itself: identity and prose, which
# every consumer wants by name rather than by column.
HOISTED = {'inspect_date', 'station_number', 'station_name', 'remarks'}


def coerce(cell, field):
    """One reading: what the cell says, and what — if anything — it means.

    Never returns a value the cell does not carry. A qualified reading yields a
    bound and no number, because the technician's meter stopped there and any
    point estimate would be fabricated.
    """
    kind = survey.classify_value(cell)
    raw = cell.text.strip() if cell.kind != 'date' else cell.text
    out = {'raw': raw, 'class': kind}

    if kind == 'number':
        out['value'] = cell.value
    elif kind == 'numeric_text':
        out['value'] = float(raw) if '.' in raw else int(raw)
    elif kind == 'number_with_unit':
        m = survey.TRAILING_UNIT.match(raw)
        number = m.group(1)
        out['value'] = float(number) if '.' in number else int(number)
        out['unit'] = m.group(2).strip()
    elif kind == 'qualified':
        m = survey.QUALIFIED.match(raw)
        out['operator'] = m.group(1)
        bound = m.group(2)
        out['bound'] = float(bound) if '.' in bound else int(bound)
        if m.group(3):
            out['unit'] = m.group(3).strip()
    elif kind == 'status':
        # A status code, normalised only by case. `-` is not an empty cell: it
        # means not applicable or not measured, and the difference between that
        # and "nobody wrote anything" is worth keeping.
        out['status'] = raw.lower()
    elif kind == 'range':
        out['flag'] = 'two_readings_in_one_cell'
    elif kind == 'error':
        out['flag'] = 'excel_error'
    elif kind == 'date':
        out['flag'] = 'date_in_a_reading_column'
    elif kind in ('prose', 'short_text') and field not in TEXT_FIELDS:
        # `Unable to access battery box` where a transmit current should be.
        # Usually the most informative thing on the row.
        out['flag'] = 'text_where_a_number_was_expected'
    return out


# ── Sub-classifying the rejects (issue #124: a reason is a category) ─────────
# `read_rows` calls a row `unresolved` when none of its shapes fit. That is a
# fine survey answer and a poor reject reason, so each one is looked at again
# here and given a reason that says what is actually on the row.

CONTINUATION = re.compile(
    r'^(cont\.?|continued|as above|ditto|see above|new|old)\b', re.I)
SERIAL_ONLY = re.compile(r'^[A-Z0-9][A-Z0-9/\-. ]{3,}$')


DATE_SHAPED = re.compile(r'^["\']?\s*\d{1,2}\s*[/\-.]')


def reject_reason(cells, row_class, date_col):
    """(reason, detail) — a category and what it was about the row."""
    text = survey.norm(' '.join(c.text for c in cells))
    values = [c for c in cells if c.text.strip()]
    date_text = next((c.text.strip() for c in values if c.col == date_col), '')

    if row_class == 'implausible_date':
        return 'implausible_date', 'parses to a year outside 1980-2025'
    if row_class == 'no_header':
        return 'block_without_a_header', 'no header row within six rows of the banner'
    if row_class == 'malformed_date':
        if DATE_SHAPED.match(date_text):
            return 'malformed_date', 'a date-shaped cell no parser should accept'
        return 'text_in_the_date_cell', 'the date column holds a note rather than a date'
    if row_class == 'undated_data':
        return 'undated_data', 'readings with no date cell at all'

    # `unresolved` — the survey's answer when no shape fits, which is a fine
    # survey answer and a poor reject reason. Each one is looked at again here.
    if values and all(c.kind == 'error' for c in values):
        return 'excel_error_row', 'nothing on the row but Excel error cells'
    if survey.looks_like_header(cells) or sum(
            1 for c in values if survey.GROUP_ROW_WORDS.match(survey.norm(c.text))) >= 2:
        return 'repeat_header_row', 'a header band repeated part-way down the sheet'
    if len(values) == 1:
        cell = values[0]
        if cell.col == date_col:
            return 'orphan_date_cell', 'a date and nothing else on the row'
        if SERIAL_ONLY.match(cell.text.strip()):
            return 'orphan_identifier', 'one identifier-shaped cell and nothing else'
        return 'orphan_cell', 'one cell of a row, with no date and no readings'
    if CONTINUATION.search(text):
        return 'continuation_row', 'refers to the row above rather than carrying a visit'
    if sum(1 for c in values if survey.classify_value(c) in
           ('number', 'numeric_text', 'qualified', 'number_with_unit')) >= 1:
        return 'partial_readings_without_a_date', (
            'fewer than three readings and no date — too little to be a visit '
            'and too much to be a note')
    return 'undated_text_row', 'text on a data row, with no date and no readings'


# ── Calibration points (spec §4) ─────────────────────────────────────────────

POINT_TOKENS = re.compile(r'\d+(?:\.\d+)?')


def resolve_point(label):
    """(point, the whole stack) for a calibration-point column.

    A point column's header can carry two numbers, one per header row, where the
    point itself was changed and the old value left above the new one —
    `Fitzroy!Y` is `30` over `25`. Joining them the way §3 joins a `Stand`/`-by`
    stack gives `30 25`, which is not a point at all.

    The bottom row wins, for the same reason the lower of two header bands wins
    in §1: it is the one the rows underneath were entered under. The workbook
    proves it here — `Fitzroy!` row 7 reads 26·46·107·207·408 at points
    1·2·5·10·20, about 20 per point, and its last reading is 507. That is point
    25, not point 30. 83 columns across 32 blocks are stacked this way.
    """
    tokens = POINT_TOKENS.findall(label)
    if not tokens:
        return label, []
    return tokens[-1], tokens if len(tokens) > 1 else []


# ── Provenance (spec §10) ────────────────────────────────────────────────────


def block_ref(sheet, banner_row):
    return f'{SOURCE}:{sheet}:{banner_row}'


def row_ref(sheet, banner_row, row):
    return f'{SOURCE}:{sheet}:{banner_row}:{row}'


# The flat tabs have no banner, so the block position in the ref is a dash
# rather than a number somebody could mistake for a row.
FLAT_BANNER = '-'


def cells_of(sheet, row):
    """The raw cells of a row, by column letter — what a reject carries so the
    row can be found in Excel and looked at."""
    return {xlsx.index_to_col(c.col): c.text.strip()
            for c in sheet.row_cells(row) if c.text.strip()}


# ── Extraction ───────────────────────────────────────────────────────────────


def load_manifest():
    with open(MANIFEST, encoding='utf-8') as fh:
        manifest = json.load(fh)
    return {e['sheet']: e for e in manifest['sheets']}


def station_row_keys(name, number):
    """The keys a flat-tab row can be recognised by — the same normalisation
    `survey.station_keys` applies to a block (spec §7)."""
    keys = set()
    clean = re.sub(r'[^a-z0-9]', '', survey.norm(name).lower())
    if clean:
        keys.add('n:' + clean)
    cbm = survey.norm(number).lower()
    digits = re.match(r'^0*(\d+)(?:\.0)?$', cbm)
    if digits:
        keys.add('c:' + digits.group(1))
    elif cbm:
        keys.add('c:' + re.sub(r'[^a-z0-9./]', '', cbm))
    return keys


def comments_by_row(sheet):
    """Cell comments (spec §9), grouped by the row they sit on."""
    out = collections.defaultdict(list)
    for comment in sheet.comments:
        row, col = xlsx.split_ref(comment['ref'])
        author = '' if comment['author'].startswith('tc=') else comment['author']
        out[row].append({'ref': comment['ref'], 'col': xlsx.index_to_col(col),
                         'author': author, 'text': survey.comment_text(comment)})
    return out


def config_of(block):
    """The station configuration this block's form is for.

    The banner gives the family; the header gives the configuration. `Closed
    stations` carries Mace blocks under a `DATA LOGGER INSPECTION SUMMARY`
    banner and only the columns say so (spec §1).
    """
    if any(re.search(r'\bmace\b', label, re.I) for label in block.header.values()):
        return 'mace'
    return survey.FAMILY_TO_CONFIG.get(block.family, 'unknown')


# ── The flat tabs, and the header band each of their rows sits under ─────────
# `survey.FLAT_SHEETS` gives each of the two flat tabs one header row, which is
# right for `ALERTS` and wrong for `TM Only`: that sheet is two tables stacked,
# a two-row base-station table under the header at row 3 and 52 TM-station rows
# under a second, completely different header at row 19. Read under the first
# header, those 52 rows load a logger number as a transmitter size and lose
# RSSI, lithium voltage, phone socket voltage and the TBRG calibration to
# Excel's `Column4`…`Column10` placeholders. The band nearest the data wins here
# for the same reason it wins inside a block (spec §1).

FLAT_BANDS = {
    'ALERTS': [
        {'header_rows': [1, 2], 'first_row': 3, 'family': 'ALERT',
         'config': 'alert', 'from': 'alerts_tab',
         'name_col': 1, 'number_col': 2, 'date_col': 3},
    ],
    'TM Only': [
        {'header_rows': [3], 'first_row': 4, 'last_row': 17,
         'family': 'BASE STATION', 'config': 'base_station', 'from': 'tm_only_tab',
         'name_col': 1, 'number_col': 2, 'date_col': 3},
        {'header_rows': [18, 19], 'first_row': 20, 'family': 'TM',
         'config': 'datalogger_old', 'from': 'tm_only_tab',
         'name_col': 1, 'number_col': 2, 'date_col': 3},
    ],
}


def flat_columns(sheet, band):
    """(columns, calibration points) for one header band of a flat tab."""
    header, _ = survey.read_flat(sheet, {**band, 'family': band['family']})
    columns, points = {}, {}
    for col, label in sorted(header.items()):
        if not label:
            continue
        field, why = survey.map_field(label)
        entry = {'label': label, 'field': field}
        if field == 'river_calibration_point':
            point, stack = resolve_point(label)
            points[col] = point
            entry['point'] = point
            if stack:
                entry['point_stack'] = stack
        elif not field:
            entry['unmapped'] = str(why)
        columns[xlsx.index_to_col(col)] = entry
    return columns, points


def band_for(bands, row):
    """The band a row sits under — the last one whose header is above it."""
    for band, columns, points in reversed(bands):
        if row >= band['first_row']:
            return band, columns, points
    return bands[0]


def owner_text(sheet, row):
    text = survey.norm(' '.join(c.text for c in sheet.row_cells(row)))
    return re.sub(r'^.*?property\s*owner\s*[:.]?\s*', '', text, flags=re.I).strip()


def owners_by_block(sheet, blocks):
    """`Property Owner:` lines that belong to the block below them.

    `read_rows` classifies the line at the foot of the *previous* block, and
    spec §8 says to attach it to the block it names — the next banner down the
    sheet. In this workbook all 516 of them sit directly above that banner and
    `find_blocks` has already attached them, so this is the fallback for the one
    that does not; `counts.json` records how often it fires, which is how a
    workbook refresh that starts leaving a blank row in between becomes visible
    rather than silently costing 500 owners.
    """
    banners = [b.banner_row for b in blocks]
    found = {}
    for block in blocks:
        for record in block.rows:
            if record['class'] != 'next_block_owner':
                continue
            nxt = next((r for r in banners if r > record['row']), None)
            if nxt is not None:
                found.setdefault(nxt, owner_text(sheet, record['row']))
    return found


def block_record(sheet, block, comments, owners):
    """The station-level half of a block: what belongs to the site rather than
    to any one visit."""
    columns = {}
    points = {}
    for col, label in sorted(block.header.items()):
        if not label:
            continue
        letter = xlsx.index_to_col(col)
        field, why = survey.map_field(label)
        entry = {'label': label}
        if field:
            entry['field'] = field
            if field == 'river_calibration_point':
                point, stack = resolve_point(label)
                points[col] = point
                entry['point'] = point
                if stack:
                    entry['point_stack'] = stack
        else:
            entry['field'] = None
            entry['unmapped'] = str(why)
        columns[letter] = entry

    owner = owner_text(sheet, block.owner_row) if block.owner_row else ''
    from_fallback = False
    if not owner and block.banner_row in owners:
        owner = owners[block.banner_row]
        from_fallback = bool(owner) and not block.owner_row

    annotations = [{'row': r['row'], 'text': r.get('text', '')}
                   for r in block.rows if r['class'] == 'annotation']

    record = {
        'ref': block_ref(sheet.name, block.banner_row),
        'source': SOURCE,
        'origin': ORIGIN,
        'sheet': sheet.name,
        'banner_row': block.banner_row,
        'end_row': block.end_row,
        'block_index': block.index,
        'family': block.family,
        'inspection_config': config_of(block),
        'station_name': survey.norm(block.station_name),
        'cbm_no': survey.norm(block.cbm_no),
        'station_keys': sorted(survey.station_keys(block)),
        # An owner line left blank is not the same as no owner line at all, so
        # the row number is kept beside the name.
        'property_owner': owner,
        'owner_row': block.owner_row,
        'ids': {k: v for k, v in block.ids.items() if k != 'raw'},
        'ids_raw': block.ids.get('raw', ''),
        'notes': dict(block.notes),
        'header_rows': block.header_rows,
        'date_column': xlsx.index_to_col(block.date_col) if block.date_col else None,
        'inherited_header': block.inherited,
        'columns': columns,
        'calibration_points': [points[c] for c in sorted(points)],
        'calibration_columns': [xlsx.index_to_col(c) for c in sorted(points)],
        'annotations': annotations,
    }
    if from_fallback:
        record['owner_from_next_block_owner_row'] = True
    block_comments = [c for row, notes in comments.items()
                      if block.banner_row <= row <= block.end_row
                      and not any(r['row'] == row and r['class'] == 'inspection'
                                  for r in block.rows)
                      for c in notes]
    if block_comments:
        record['comments'] = block_comments
    return record, points


def inspection_record(sheet, row_record, *, ref, sheet_name, banner_row, columns,
                      points, date_col, block=None, flat=None, comments=()):
    """One visit: its date, its readings with their source strings, and where in
    the workbook every one of them came from."""
    readings = []
    calibration = []
    remarks = []
    hoisted = {}
    flags = []
    classes = collections.Counter()
    cells_on_the_row = 0
    # On a flat tab the station is named and numbered in known columns, so the
    # identity is read by position rather than through the header labels —
    # `TM Only` calls its name column "TM Stations Crosscheck", which the field
    # map reads as a station *number*.
    identity = {} if block else {flat['name_col']: 'station_name',
                                 flat['number_col']: 'station_number'}
    for cell in sheet.row_cells(row_record['row']):
        if cell.col == date_col:
            continue
        if not cell.text.strip():
            continue
        cells_on_the_row += 1

        if cell.col in identity:
            field = identity[cell.col]
            hoisted[field] = cell.text.strip()
            classes[survey.classify_value(cell)] += 1
            if cell.kind == 'error':
                flags.append(f'excel_error_in_{field}')
            continue
        letter = xlsx.index_to_col(cell.col)
        column = columns.get(letter)
        label = column['label'] if column else ''
        field = column['field'] if column else None

        if cell.col in points:
            reading = {'col': letter, 'point': points[cell.col],
                       **coerce(cell, 'river_calibration_point')}
            classes[reading['class']] += 1
            calibration.append(reading)
            continue

        reading = {'col': letter, 'field': field, **coerce(cell, field)}
        classes[reading['class']] += 1
        if not field:
            reading['label'] = label
            reading['unmapped'] = column['unmapped'] if column else 'no header for this column'

        if reading['class'] == 'error' and field in HOISTED:
            # `#N/A` where a station name or number should be. The string is
            # kept, and so is the fact that it is an error rather than a name.
            flags.append(f'excel_error_in_{field}')

        if field == 'remarks':
            remarks.append(reading['raw'])
            continue
        if field in HOISTED and field not in hoisted:
            hoisted[field] = reading['raw']
            continue
        # A second column mapping to the same hoisted field keeps its reading
        # rather than disappearing behind the first one.
        readings.append(reading)

    record = {
        'ref': ref,
        'source': SOURCE,
        'origin': ORIGIN,
        'sheet': sheet_name,
        'banner_row': banner_row,
        'row': row_record['row'],
        'block_ref': block_ref(sheet_name, banner_row) if block else None,
        'from': 'block' if block else flat['from'],
        'family': block.family if block else flat['family'],
        'inspection_config': config_of(block) if block else flat['config'],
        'station_name': (survey.norm(block.station_name) if block else
                         survey.norm(sheet.text(row_record['row'], flat['name_col']))),
        'cbm_no': (survey.norm(block.cbm_no) if block else
                   survey.norm(sheet.text(row_record['row'], flat['number_col']) or '')),
        'inspected_on': row_record['date'].date().isoformat() if row_record.get('date') else None,
        'date_precision': row_record['precision'],
        'date_kind': row_record['date_kind'],
        'date_raw': sheet.text(row_record['row'], date_col).strip() if date_col else '',
    }
    if 'station_number' in hoisted:
        record['station_number_raw'] = hoisted['station_number']
    if 'station_name' in hoisted and not record['station_name']:
        record['station_name'] = hoisted['station_name']
    record['readings'] = readings
    if calibration:
        record['calibration'] = calibration
    if remarks:
        record['remarks'] = ' | '.join(remarks)
    if comments:
        # A comment attaches to a cell, so it attaches to a field (spec §9).
        record['comments'] = [
            {**note, 'field': (columns.get(note['col']) or {}).get('field')}
            for note in comments]
    if flags:
        record['flags'] = flags

    # "Nothing silently dropped", checked rather than hoped for: every cell on
    # the row that is not the date landed in exactly one of these four places.
    kept = len(readings) + len(calibration) + len(remarks) + len(hoisted)
    if kept != cells_on_the_row:
        classes['cells_unaccounted_for'] += cells_on_the_row - kept
    return record, classes


def extract():
    manifest = load_manifest()
    wb = xlsx.load(WORKBOOK)

    blocks_out, inspections, rejects, duplicates = [], [], [], []
    per_sheet = []
    ignored_classes = collections.Counter()
    reject_reasons = collections.Counter()
    value_classes = collections.Counter()
    unmapped_columns = collections.Counter()
    point_notes = collections.Counter()

    in_scope = [s for s in wb.sheets
                if manifest.get(s.name, {}).get('disposition') == 'ingest']

    # The basin blocks are the canonical home (spec §7), so they are read first
    # and the flat `ALERTS` tab is matched against them afterwards.
    basin_visits = collections.defaultdict(set)

    flat_sheets = []
    for sheet in in_scope:
        if sheet.name in survey.FLAT_SHEETS:
            flat_sheets.append(sheet)
            continue

        comments = comments_by_row(sheet)
        counts = collections.Counter()
        sheet_blocks = survey.find_blocks(sheet)
        owners = owners_by_block(sheet, sheet_blocks)
        for block in sheet_blocks:
            record, header_points = block_record(sheet, block, comments, owners)
            counts['blocks'] += 1
            for letter, column in record['columns'].items():
                if column['field'] is None:
                    unmapped_columns[column['label']] += 1

            def reject(row, cls, *, level='row', as_class=None, extra=''):
                """Every row this extractor does not load, with a reason that is
                a category and the raw cells to find it in Excel by."""
                cells = sheet.row_cells(row)
                reason, detail = reject_reason(cells, as_class or cls,
                                               block.date_col)
                rejects.append({
                    'ref': (row_ref(sheet.name, block.banner_row, row) if level == 'row'
                            else block_ref(sheet.name, block.banner_row)),
                    'sheet': sheet.name, 'banner_row': block.banner_row, 'row': row,
                    'level': level, 'reason': reason, 'detail': detail + extra,
                    'row_class': cls, 'cells': cells_of(sheet, row),
                })
                reject_reasons[reason] += 1
                counts['rejected_blocks' if level == 'block' else 'rejected'] += 1

            if block.date_col is None and not block.inherited:
                reject(block.banner_row, 'no_header', level='block')
                blocks_out.append(record)
                continue

            # §4 rule 3: a point row inside the data redefines the points below
            # it, and the block header holds only until the first one appears.
            points = dict(header_points)
            emitted_here = 0
            for row_record in block.rows:
                cls = row_record['class']
                if cls == 'calibration_point_row':
                    redefined = {}
                    for cell in sheet.row_cells(row_record['row']):
                        if cell.col == block.date_col or not cell.text.strip():
                            continue
                        if header_points or cell.col in points:
                            redefined[cell.col] = resolve_point(survey.norm(cell.text))[0]
                    if redefined:
                        points = redefined
                        counts['calibration_point_rows'] += 1
                        ignored_classes[cls] += 1
                        continue
                    # An all-numeric row in a block with no calibration columns
                    # is not a point row: `read_rows` reaches that class before
                    # it asks whether the row is data, and two rows in the
                    # workbook fall through the gap — `Mooloolah!!69` is nine
                    # readings with no date. Rejected rather than ignored.
                    point_notes['numeric_row_in_a_block_with_no_calibration_columns'] += 1
                    cells = sheet.row_cells(row_record['row'])
                    reject(row_record['row'], cls,
                           as_class='undated_data' if survey.looks_like_data(
                               cells, block.date_col) else 'unresolved')
                    continue
                if cls in ('marker', 'error_only', 'next_block_owner', 'repeat_header'):
                    ignored_classes[cls] += 1
                    continue
                if cls == 'annotation':
                    # Kept, on the block — these are the reason a gap exists.
                    ignored_classes[cls] += 1
                    continue
                if cls == 'inspection':
                    if row_record.get('implausible_date'):
                        # Rejected, not repaired: `23/6/215` is obviously 2015
                        # to a person and not to a rule, and #122's non-goals
                        # are explicit that the record is not corrected.
                        reject(row_record['row'], cls, as_class='implausible_date',
                               extra=f': {row_record["implausible_date"]!r} -> '
                                     f'{row_record["date"].date().isoformat()}')
                        continue
                    record_row, classes = inspection_record(
                        sheet, row_record,
                        ref=row_ref(sheet.name, block.banner_row, row_record['row']),
                        sheet_name=sheet.name, banner_row=block.banner_row,
                        columns=record['columns'], points=points,
                        date_col=block.date_col, block=block,
                        comments=comments.get(row_record['row'], ()))
                    inspections.append(record_row)
                    value_classes.update(classes)
                    counts['emitted'] += 1
                    emitted_here += 1
                    if record_row['inspected_on']:
                        for key in record['station_keys']:
                            basin_visits[key].add(record_row['inspected_on'])
                    continue

                reject(row_record['row'], cls)

            record['inspection_rows'] = emitted_here
            blocks_out.append(record)

        counts['rows_read'] = sum(len(b.rows) for b in sheet_blocks)
        per_sheet.append({'sheet': sheet.name, 'structure': 'stacked_blocks',
                          **{k: counts[k] for k in
                             ('blocks', 'rows_read', 'emitted', 'rejected',
                              'rejected_blocks', 'calibration_point_rows')}})

    # -- the two flat tabs, once the basin blocks are in --
    for sheet in flat_sheets:
        spec = survey.FLAT_SHEETS[sheet.name]
        _, rows = survey.read_flat(sheet, spec)
        bands = [(band, *flat_columns(sheet, band)) for band in FLAT_BANDS[sheet.name]]
        for band, columns, _points in bands:
            for column in columns.values():
                if column['field'] is None:
                    unmapped_columns[column['label']] += 1
        comments = comments_by_row(sheet)
        counts = collections.Counter()
        for row_record in rows:
            cls = row_record['class']
            row = row_record['row']
            band, columns, points = band_for(bands, row)
            if cls == 'marker':
                ignored_classes[cls] += 1
                continue
            if cls != 'inspection':
                reason, detail = reject_reason(
                    sheet.row_cells(row), cls, spec['date_col'])
                rejects.append({
                    'ref': row_ref(sheet.name, FLAT_BANNER, row),
                    'sheet': sheet.name, 'banner_row': None,
                    'row': row, 'level': 'row',
                    'reason': reason, 'detail': detail, 'row_class': cls,
                    'cells': cells_of(sheet, row),
                })
                reject_reasons[reason] += 1
                counts['rejected'] += 1
                continue

            record_row, classes = inspection_record(
                sheet, row_record,
                ref=row_ref(sheet.name, FLAT_BANNER, row),
                sheet_name=sheet.name, banner_row=None, columns=columns,
                points=points, date_col=spec['date_col'], block=None, flat=band,
                comments=comments.get(row, ()))

            if sheet.name == 'ALERTS':
                keys = station_row_keys(record_row['station_name'], record_row['cbm_no'])
                day = record_row['inspected_on']
                hit = sorted(k for k in keys if day and day in basin_visits.get(k, ()))
                if hit:
                    duplicates.append({
                        'ref': record_row['ref'], 'sheet': sheet.name,
                        'row': row_record['row'],
                        'station_name': record_row['station_name'],
                        'cbm_no': record_row['cbm_no'],
                        'inspected_on': day, 'matched_on': hit,
                        'reason': 'already_recorded_on_a_basin_block',
                    })
                    counts['duplicates'] += 1
                    continue

            inspections.append(record_row)
            value_classes.update(classes)
            counts['emitted'] += 1

        counts['rows_read'] = len(rows)
        per_sheet.append({'sheet': sheet.name, 'structure': 'flat', 'blocks': 0,
                          **{k: counts[k] for k in
                             ('rows_read', 'emitted', 'rejected', 'duplicates')}})

    counts = build_counts(per_sheet, blocks_out, inspections, rejects, duplicates,
                          ignored_classes, reject_reasons, value_classes,
                          unmapped_columns, point_notes, manifest)

    result = {
        'blocks': blocks_out,
        'inspections': inspections,
        'rejects': rejects,
        'duplicates': duplicates,
        'counts': counts,
    }
    result['sample'] = build_sample(result, wb)
    return result


# ── Reconciliation (issue #124: emitted + rejected = read) ───────────────────


def build_counts(per_sheet, blocks, inspections, rejects, duplicates,
                 ignored_classes, reject_reasons, value_classes,
                 unmapped_columns, point_notes, manifest):
    with open(SURVEY_COUNTS, encoding='utf-8') as fh:
        surveyed = json.load(fh)

    unaccounted = value_classes.pop('cells_unaccounted_for', 0)

    row_rejects = [r for r in rejects if r['level'] == 'row']
    ignored = sum(ignored_classes.values())
    rows_read = sum(s['rows_read'] for s in per_sheet)

    # The two readers count the same rows and disagree about two of the labels,
    # so the reconciliation compares like with like and says where the rest
    # went. The survey's rejects are its three row classes (spec §8); this
    # extractor also rejects a row whose date is implausible — which the survey
    # calls an inspection and flags — and an all-numeric row in a block with no
    # calibration columns, which the survey calls a point row.
    surveys_classes = ('unresolved', 'malformed_date', 'undated_data')
    survey_class_rejects = [r for r in row_rejects
                            if r.get('row_class') in surveys_classes]
    beyond = collections.Counter(r['reason'] for r in row_rejects
                                 if r.get('row_class') not in surveys_classes)
    implausible = beyond['implausible_date']
    inspection_rows = len(inspections) + len(duplicates) + implausible

    balance = {
        'rows_classified_in_scope': rows_read,
        'emitted': len(inspections),
        'rejected_rows': len(row_rejects),
        'dropped_as_duplicates': len(duplicates),
        'not_inspection_rows': ignored,
        'balances': rows_read == len(inspections) + len(row_rejects)
                    + len(duplicates) + ignored,
        # Per cell rather than per row: every non-date cell of an emitted row
        # is a reading, a calibration pair, a remark or a hoisted identity
        # field. Anything else would be a value the loader never sees.
        'cells_unaccounted_for': unaccounted,
    }

    expected = {
        'blocks': surveyed['ingested_blocks'],
        'inspection_rows': surveyed['ingested_inspection_rows'],
        'rejects': surveyed['ingested_rejects'],
    }
    measured = {
        'blocks': len(blocks),
        'inspection_rows': inspection_rows,
        'rejects': len(survey_class_rejects),
    }

    return {
        '_': 'Rows read / emitted / rejected / dropped, per sheet, and the '
             'reconciliation against tools/ingest/inspection_survey_counts.json. '
             'Written by tools/ingest/extract.py; do not edit by hand.',
        'workbook': os.path.relpath(WORKBOOK, REPO),
        'sheets_ingested': len(per_sheet),
        'blocks': len(blocks),
        'inspection_rows': inspection_rows,
        'emitted': len(inspections),
        'rejected': len(row_rejects),
        'rejected_blocks': sum(1 for r in rejects if r['level'] == 'block'),
        'dropped_as_duplicates': len(duplicates),
        'balance': balance,
        'against_the_survey': {
            'expected': expected,
            'measured': measured,
            'agrees': expected == measured,
            'note': 'The survey (#123) and this extractor read the same workbook '
                    'through the same rules. A difference means one of the two '
                    'readers changed, and it is worth knowing while the table is '
                    'still empty. `inspection_rows` and `rejects` are counted the '
                    "survey's way — its three reject classes, and every row it "
                    'calls an inspection. This extractor rejects a further '
                    f'{sum(beyond.values())} rows that the survey does not count '
                    'as rejects; they are in `rejects_beyond_the_survey_classes` '
                    'and in rejects.jsonl like every other one.',
            'rejects_beyond_the_survey_classes': dict(beyond.most_common()),
            'extractor_reject_total': len(row_rejects),
        },
        'per_sheet': sorted(per_sheet, key=lambda s: s['sheet']),
        'rows_that_are_not_inspections': dict(ignored_classes.most_common()),
        'reject_reasons': dict(reject_reasons.most_common()),
        'value_classes': dict(value_classes.most_common()),
        'value_cells': sum(value_classes.values()),
        'flags': dict(collections.Counter(
            f for i in inspections for f in i.get('flags', ())).most_common()),
        'blocks_with_an_inherited_header': [
            b['ref'] for b in blocks if b['inherited_header']],
        'blocks_by_config': dict(collections.Counter(
            b['inspection_config'] for b in blocks).most_common()),
        'blocks_without_cbm': sum(1 for b in blocks if not b['cbm_no']),
        'blocks_with_an_owner_row': sum(1 for b in blocks if b['owner_row']),
        'blocks_with_a_named_owner': sum(1 for b in blocks if b['property_owner']),
        'owners_taken_from_a_next_block_owner_row': sum(
            1 for b in blocks if b.get('owner_from_next_block_owner_row')),
        'inspections_by_decade': dict(sorted(collections.Counter(
            f'{i["inspected_on"][:3]}0s' for i in inspections
            if i['inspected_on']).items())),
        'inspections_by_origin': dict(collections.Counter(
            i['from'] for i in inspections).most_common()),
        'block_comments': sum(len(b.get('comments', ())) for b in blocks),
        'inspection_comments': sum(len(i.get('comments', ())) for i in inspections),
        'annotations': sum(len(b['annotations']) for b in blocks),
        'unmapped_columns': dict(unmapped_columns.most_common()),
        'calibration_readings': sum(len(i.get('calibration', ())) for i in inspections),
        'calibration_columns_with_a_stacked_point': sum(
            1 for b in blocks for c in b['columns'].values() if c.get('point_stack')),
        'distinct_calibration_point_sets': len({
            tuple(b['calibration_points']) for b in blocks if b['calibration_points']}),
        'notes': dict(point_notes.most_common()),
        'sheets_read_but_not_loaded': sorted(
            e['sheet'] for e in manifest.values() if e['disposition'] != 'ingest'),
    }


# ── The hand-checked sample (issue #124, "Verification") ─────────────────────
# Named blocks rather than "the first one of each kind", so that the sample is
# the same sample after the workbook is refreshed and a diff means the reading
# of *these* blocks changed. Every record in the file was compared cell by cell
# against the workbook on 2026-08-15, which is what makes it a fixture rather
# than a second copy of the output.

SAMPLE_BLOCKS = [
    ("ALERT — the long calibration set, a point column stacked 30 over 25, and "
     "a point row inside the data that rescales everything below it (§4)",
     'Fitzroy!', 2, [7, 8, 20]),
    ("DATA LOGGER — the second banner family, on a TM station",
     'Border!', 303, [307, 308]),
    ("CR800 — one of only two blocks in the workbook", 'Mary!', 1006, [1010, 1011]),
    ("RRDL3 — the only block in the workbook", 'Closed stations', 174, [180, 181]),
    ("Mace — Mace columns under a DATA LOGGER banner, which is why the "
     "configuration comes from the header and not the banner (§1)",
     'Closed stations', 2, [8, 9]),
    ("The short calibration set, with a qualified reading (`>21`) and a status "
     "word (`U/S`) that both have to survive as themselves (§5)",
     'Ipswich', 2, [20, 23]),
    ("A block whose banner carries no CBM number at all — #125 resolves these "
     "by name (§2)", 'Border!', 86, [90, 91]),
]

SAMPLE_ROWS = [
    ("`TM Only` — the flat base-station tab, one row per inspection and the "
     "station named in a column", 'TM Only', 20),
    ("`ALERTS` — one of the seven rows that are on no basin tab, and the one "
     "with `#N/A` where its station number should be (§7)", 'ALERTS', 87),
    ("A cell holding two readings (`7500/18200`), kept raw and flagged (§5)",
     'Ipswich', 55),
    ("A reading with its unit in the cell (`1.3A`)", 'Noosa', 52),
    ("Prose in a column with no header at all — kept, with the column's "
     "position, because it is usually the most informative thing on the row",
     'Ipswich', 845),
    ("A number Excel stores as text (a canister serial with a leading zero)",
     'Ipswich', 86),
]


def build_sample(result, wb):
    sheets = {s.name: s for s in wb.sheets}
    blocks = {b['ref']: b for b in result['blocks']}
    by_ref = {i['ref']: i for i in result['inspections']}
    rows_by_sheet = collections.defaultdict(list)
    for i in result['inspections']:
        rows_by_sheet[i['sheet']].append(i)

    def workbook_cells(sheet_name, rows):
        sheet = sheets[sheet_name]
        return {str(row): cells_of(sheet, row) for row in sorted(rows)}

    samples = []
    for why, sheet_name, banner_row, rows in SAMPLE_BLOCKS:
        ref = block_ref(sheet_name, banner_row)
        block = blocks[ref]
        records = [by_ref[row_ref(sheet_name, banner_row, r)] for r in rows]
        context = ([block['owner_row']] if block['owner_row'] else []) + \
                  [banner_row] + block['header_rows'] + list(rows)
        samples.append({
            'why': why,
            'block': block,
            'inspections': records,
            'workbook_cells': workbook_cells(sheet_name, {r for r in context if r}),
        })

    for why, sheet_name, row in SAMPLE_ROWS:
        record = next(i for i in rows_by_sheet[sheet_name] if i['row'] == row)
        context = [row]
        if record['block_ref']:
            block = blocks[record['block_ref']]
            context += [block['banner_row']] + block['header_rows']
        samples.append({
            'why': why,
            'block': blocks.get(record['block_ref']),
            'inspections': [record],
            'workbook_cells': workbook_cells(sheet_name, context),
        })
    return {
        '_': 'The hand-checked sample #124 asks for: one block from each form '
             'family, a Mace block, a base-station row, the short and the long '
             'calibration set, a block with no CBM number, and a row carrying '
             'each class of qualified value. Each entry holds the extracted '
             'records and the workbook cells they were read from, so a drift in '
             'the reading shows up here as a diff between the two halves of the '
             'same file. Written by tools/ingest/extract.py; do not edit by hand.',
        'workbook': os.path.relpath(WORKBOOK, REPO),
        'checked_against_the_workbook_on': '2026-08-15',
        'samples': samples,
    }


# ── Files ────────────────────────────────────────────────────────────────────


def render(result, directory=OUT_DIR):
    """Every output file, by path. Deterministic: same workbook, same bytes —
    no timestamps, no iteration order that depends on anything but the sheet."""
    def jsonl(records):
        return ''.join(json.dumps(r, ensure_ascii=False, default=str) + '\n'
                       for r in records)

    files = {
        'blocks.jsonl': jsonl(result['blocks']),
        'inspections.jsonl': jsonl(result['inspections']),
        'rejects.jsonl': jsonl(result['rejects']),
        'duplicates.jsonl': jsonl(result['duplicates']),
        'counts.json': json.dumps(result['counts'], indent=2, ensure_ascii=False,
                                  default=str) + '\n',
    }
    out = {os.path.join(directory, name): text for name, text in files.items()}
    # The sample lives with the spec and the survey's artefacts rather than with
    # the bulk output: it is the evidence for the reading, not the reading.
    out[SAMPLE] = json.dumps(result['sample'], indent=2, ensure_ascii=False,
                             default=str) + '\n'
    return out


def write(result, directory=OUT_DIR):
    os.makedirs(directory, exist_ok=True)
    for path, text in render(result, directory).items():
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(text)


def check(result, directory=OUT_DIR):
    problems = []
    for path, text in render(result, directory).items():
        name = os.path.relpath(path, REPO)
        if not os.path.exists(path):
            problems.append(f'{name}: missing')
            continue
        with open(path, encoding='utf-8') as fh:
            on_disk = fh.read()
        if on_disk != text:
            problems.append(
                f'{name}: differs ({len(on_disk.splitlines())} lines on disk, '
                f'{len(text.splitlines())} from this run)')
    return problems


def summarise(counts):
    lines = [
        f'sheets   {counts["sheets_ingested"]}',
        f'blocks   {counts["blocks"]}  ({counts["rejected_blocks"]} rejected)',
        f'rows     {counts["inspection_rows"]} inspection rows: '
        f'{counts["emitted"]} emitted, {counts["rejected"]} rejected, '
        f'{counts["dropped_as_duplicates"]} dropped as duplicates',
        f'cells    {counts["value_cells"]} with a value',
    ]
    against = counts['against_the_survey']
    lines.append('survey   ' + ('agrees' if against['agrees'] else
                                f'DISAGREES expected={against["expected"]} '
                                f'measured={against["measured"]}'))
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true',
                        help='re-run and fail if the checked-in files have drifted')
    parser.add_argument('--out', default=OUT_DIR)
    args = parser.parse_args()

    result = extract()
    counts = result['counts']
    print(summarise(counts), file=sys.stderr)

    failures = []
    if not counts['balance']['balances']:
        failures.append(f'rows do not balance: {counts["balance"]}')
    if counts['balance']['cells_unaccounted_for']:
        failures.append(f'{counts["balance"]["cells_unaccounted_for"]} cells on '
                        'emitted rows reached none of the output fields')
    if not counts['against_the_survey']['agrees']:
        failures.append('the extract disagrees with the survey: '
                        f'{counts["against_the_survey"]}')

    if args.check:
        failures += check(result, args.out)
        if failures:
            print('\n'.join(f'FAIL {f}' for f in failures), file=sys.stderr)
            return 1
        print('extract: up to date', file=sys.stderr)
        return 0

    if failures:
        # A run that does not reconcile is not a run whose output anybody should
        # load, so it fails rather than reporting success.
        print('\n'.join(f'FAIL {f}' for f in failures), file=sys.stderr)
        return 1
    write(result, args.out)
    print(f'extract: wrote {args.out}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
