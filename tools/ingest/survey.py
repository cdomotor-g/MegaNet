#!/usr/bin/env python3
"""Survey of `archive/QLD All Site Inspections.xlsx` — #123 (H1 of epic #122).

This is reconnaissance, not an importer. It reads the workbook and writes four
artefacts next to itself; `docs/inspection-workbook-parse-spec.md` is the prose
half and explains every rule this file implements.

    python3 tools/ingest/survey.py            # rewrite the artefacts
    python3 tools/ingest/survey.py --check    # re-run and fail on any drift

Artefacts:

  inspection_sheet_manifest.json   one entry per worksheet, all 59, each with a
                                   disposition (ingest / skip / defer) and the
                                   counts #124 has to reconcile against.
  inspection_field_map.json        the canonical field vocabulary, and every
                                   header label observed in the workbook mapped
                                   onto it — or listed unmapped, with a reason.
  inspection_layouts.json          every distinct column layout, per form
                                   family, with each column's canonical field.
  inspection_survey_counts.json    the headline counts, and how they reconcile
                                   against the ones quoted in #122.

Nothing here writes to a database, and nothing here decides scope on its own.
#122's three open questions — the SLS tabs, precedence between a hidden legacy
sheet and its visible twin, and whether the NSW tabs are in scope — were
measured here and **answered by @cdomotor-g on 2026-08-15**; the answers are in
`DECISIONS` and in every affected sheet's `reason`. The twelve hidden legacy
sheets are out of scope and are still read, because the comparison that makes
ignoring them safe stops being checkable the moment the survey stops reading
them.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import xlsx  # noqa: E402  (same directory, deliberately not a package)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
WORKBOOK = os.path.join(REPO, 'archive', 'QLD All Site Inspections.xlsx')

# ── The shapes on the page ───────────────────────────────────────────────────

BANNER = re.compile(r'(ALERT|DATA LOGGER|CR800|RRDL3)\s+INSPECTION\s+SUMMARY', re.I)
DATE_HEADER = re.compile(r'inspect|^date$', re.I)
DATE_TEXT = re.compile(r'^\s*(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\s*$')
YEAR_ONLY = re.compile(r'^(19|20)\d{2}$')
NUMERIC_LABEL = re.compile(r'^[\d.\s]+$')
OWNER_ROW = re.compile(r'property\s*owner', re.I)
IDS_ROW = re.compile(r"^\s*ID\s*'?\s*s\s*$|\b(Rn|Rv|Batt|Mace|Logger)\s*=", re.I)
MARKER_ROW = re.compile(
    r'ENTER ANY NEW DATA|END IF DATA|SPILL|Formula above|STATION CLOSED|'
    r'NOW TO BE CO|BASE STATIONS NOW', re.I)

# The `ID's` line's own vocabulary. Everything else on that row stays raw.
IDS_FIELDS = [
    ('rain_alert_id', re.compile(r'\bRn\s*=\s*([0-9]+)', re.I)),
    ('river_alert_id', re.compile(r'\bRv\s*=\s*([0-9]+)', re.I)),
    ('battery_alert_id', re.compile(r'\bBatt\s*=\s*([0-9]+)', re.I)),
    ('orifice_level_raw', re.compile(r'Orifice\s*level\s*=?\s*(.+)$', re.I)),
    ('key_number_raw', re.compile(r'Key\s*#?\s*:?\s*(.+)$', re.I)),
    ('phone_no_raw', re.compile(r'Phone\s*(?:No|Number)\.?\s*:?\s*(.+)$', re.I)),
    ('mace_id', re.compile(r'\bMace\s*=\s*([0-9]+)', re.I)),
    ('logger_id', re.compile(r'\bLogger\s*=\s*([0-9]+)', re.I)),
]

# A group cell says one of these, or it is not a group label at all — it is a
# note somebody parked on the header row (a phone number, a key number, a
# repeater window, a frequency). See the spec, "Header-row resolution".
GROUP_LABELS = re.compile(
    r'^(alert|tm\b|base station|batter|consu|cons\.|cons/|lithium|mains|solar|'
    r'transmi|antenna|phone|tbrg|river calibration|gas|dp\b|shaft encoder|s/e|'
    r'serial|deco|recei|existing cylinder|replacement cylinder|power supply|'
    r'remark|repeater window|\(m?a\)|\(v\.?\)|\(w\))', re.I)

# The stricter set used to recognise a *row* as a group-label row. Deliberately
# narrower than GROUP_LABELS: `(mA)` is a perfectly good group cell but three of
# them in a row is a units row, not a second header band.
GROUP_ROW_WORDS = re.compile(
    r'^(batter|consu|solar|transmi|mains|lithium|phone|tbrg|river calibration|'
    r'gas|shaft encoder|antenna|serial|deco|recei|existing cylinder|'
    r'replacement cylinder|power supply)', re.I)

# Notes that ride on the group row rather than labelling a column group.
BLOCK_NOTES = [
    ('phone_no', re.compile(r'^phone\s*no\.?\s*:?\s*(.+)$', re.I)),
    ('key_number', re.compile(r'^key\s*#?\s*:?\s*(.+)$', re.I)),
    ('repeater_window', re.compile(r'^repeater\s*windows?\s*:?\s*(.+)$', re.I)),
    ('frequency', re.compile(r'^(?:freq\.?|frequency)\s*:?\s*(.+)$', re.I)),
    ('alert_id_note', re.compile(r'^(?:rain|river|battery)\s*:?\s*([0-9]+)$', re.I)),
]

# ── Value classes ────────────────────────────────────────────────────────────
# #122's acceptance: a qualified reading survives the round trip as itself. The
# classifier says what a cell IS; it never rewrites it.

QUALIFIED = re.compile(r'^\s*([<>]=?)\s*(\d+(?:\.\d+)?)\s*([a-zA-Z%/]*)\s*$')
STATUS_WORDS = {
    '-', '--', '?', 'x', '*', 'n/a', 'na', 'n\\a', 'nil', 'none', 'u/s', 'us',
    'ok', 'reset', 'n/m', 'nm', 'not tested', 'not checked', 'n/r', 'tba',
}
RANGE_VALUE = re.compile(r'^\s*\d+(\.\d+)?\s*/\s*\d+(\.\d+)?\s*$')
NUMERIC_TEXT = re.compile(r'^\s*-?\d+(\.\d+)?\s*$')
TRAILING_UNIT = re.compile(r'^\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Z%][a-zA-Z%/. ]{0,12})\s*$')


def classify_value(cell) -> str:
    """One of: number, date, error, qualified, status, range, numeric_text,
    number_with_unit, prose, short_text, bool."""
    if cell.kind in ('number', 'date', 'bool'):
        return cell.kind
    if cell.kind == 'error':
        return 'error'
    text = cell.text.strip()
    if not text:
        return 'blank'
    if QUALIFIED.match(text):
        return 'qualified'
    if text.lower() in STATUS_WORDS:
        return 'status'
    if RANGE_VALUE.match(text):
        return 'range'
    if NUMERIC_TEXT.match(text):
        return 'numeric_text'
    if TRAILING_UNIT.match(text):
        return 'number_with_unit'
    if len(text) > 40:
        return 'prose'
    return 'short_text'


def norm(text) -> str:
    return re.sub(r'\s+', ' ', str(text).replace('\n', ' ')).strip()


def parse_date(cell):
    """(kind, value-or-None, precision) for a cell in the date column."""
    if cell is None:
        return None, None, None
    if cell.kind == 'date':
        return 'datetime', cell.value, 'day'
    if cell.kind == 'text':
        text = cell.text.strip()
        m = DATE_TEXT.match(text)
        if m:
            day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if year < 100:
                # Two-digit years in this workbook are all 1990-2024; the pivot
                # is the workbook's own range, not a general rule.
                year += 2000 if year < 50 else 1900
            try:
                return 'text', dt.datetime(year, month, day), 'day'
            except ValueError:
                return 'unparseable', None, None
        if YEAR_ONLY.match(text):
            return 'year_only', dt.datetime(int(text), 1, 1), 'year'
        return 'unparseable', None, None
    if cell.kind == 'number':
        return 'unparseable', None, None
    return 'unparseable', None, None


# ── The canonical field vocabulary ───────────────────────────────────────────
# One name per concept, and the concept named the way `db/migrations/
# 0009_inspections.sql` names it wherever that migration already has a column.
# The `target` is where #126 is expected to land the value; where 0009 has no
# home yet, the target names what has to be added and the spec says so.

CANONICAL = [
    # (field, target, note)
    ('station_number', 'inspection.cbm_no', 'The CBM/Bureau number printed in the column, where the layout has one.'),
    ('inspect_date', 'inspection.inspected_on', 'The visit date. The only field whose absence disqualifies a row.'),
    ('canister_no', 'inspection_serial (equipment=alert_canister)', 'ALERT canister serial.'),
    ('canister_type', 'inspection_serial.model', 'Canister type, where a layout prints it instead of the serial.'),
    ('logger_no', 'inspection_serial (equipment=logger)', 'Logger or Mace serial.'),
    ('battery_standby_v', 'inspection_power.battery_existing_v', ''),
    ('battery_under_load_v', 'inspection_power.battery_existing_v_under_load', ''),
    ('lithium_battery_v', 'inspection_power.lithium_battery_v', ''),
    ('battery_test_raw', 'inspection_power.comments', 'Argus battery tester, printed as V/CCA — two numbers in one cell.'),
    ('consumption_standby_ma', 'inspection_power (new column)', '0009 has sleep/interrogation/operating but no standby; ALERT prints standby.'),
    ('consumption_transmit_ma', 'inspection_power (new column)', 'ALERT transmit draw.'),
    ('consumption_sleep_ma', 'inspection_power.consumption_sleep_ma', ''),
    ('consumption_operating_ma', 'inspection_power.consumption_operating_ma', ''),
    ('consumption_interrogation_ma', 'inspection_power.consumption_interrogation_ma', ''),
    ('solar_output_v', 'inspection_power.solar_output_v', 'Open-circuit output; several layouts word it "Open circuit" or "Volts".'),
    ('solar_short_circuit_ma', 'inspection_power.solar_short_circuit_ma', ''),
    ('solar_regulated_v', 'inspection_power.solar_regulator_v', ''),
    ('solar_charge_current_ma', 'inspection_power.solar_charge_current_ma', ''),
    ('solar_step_up_v', 'inspection_power.solar_step_up_v', ''),
    ('mains_charge_current_ma', 'inspection_power (new column)', 'Mains charger, on the sheets that have one instead of solar.'),
    ('mains_regulated_v', 'inspection_power (new column)', ''),
    ('telephone_socket_v', 'inspection_power.telephone_socket_v', ''),
    ('tx_forward_w', 'inspection_radio.existing_forward_w', ''),
    ('tx_reflected_w', 'inspection_radio.existing_reflected_w', ''),
    ('swr', 'inspection_radio.existing_swr', ''),
    ('tx_size_w', 'inspection_radio.tx_size_w', ''),
    ('tx_deviation_khz', 'inspection_radio (new column)', 'DEV (kHz) on the sheets that measure deviation.'),
    ('fade_margin_db', 'inspection_fade_margin.load_db', 'One number per visit here, not the sheet\'s full table.'),
    ('rssi_dbm', 'inspection_data.rssi_dbm', ''),
    ('antenna_forward_w', 'inspection_calibration (kind=receiver_test) / radio', 'Base-station antenna test, per frequency and per antenna number.'),
    ('antenna_reflected_w', 'inspection_calibration (kind=receiver_test) / radio', ''),
    ('antenna_swr', 'inspection_calibration (kind=receiver_test) / radio', ''),
    ('decoder_v', 'inspection_calibration (kind=decoder_test)', ''),
    ('receiver_v', 'inspection_calibration (kind=receiver_test)', ''),
    ('decoder_serial', 'inspection_serial (equipment=decoder)', ''),
    ('receiver1_serial', 'inspection_serial (equipment=receiver)', ''),
    ('receiver2_serial', 'inspection_serial (equipment=receiver)', ''),
    ('tbrg_calibration_mm', 'inspection_calibration (kind=rain_tip_test)', 'The one-number tip-test result these sheets print.'),
    ('river_calibration_point', 'inspection_calibration (kind=river_calibration — NEW)', 'A (point, reading) pair. 0009 has no river_calibration kind; #126 has to add one.'),
    ('shaft_encoder_increments_per_rev', 'inspection_calibration.revolutions / extra', ''),
    ('shaft_encoder_revs', 'inspection_calibration.revolutions', ''),
    ('shaft_encoder_result', 'inspection_calibration.result', ''),
    ('shaft_encoder_error', 'inspection_calibration.error_m', ''),
    ('shaft_encoder_accum_diff', 'inspection_calibration.difference', ''),
    ('gas_pressure_kpa', 'inspection_data.gas_pressure_kpa', ''),
    ('cylinder_pressure_kpa', 'inspection_gas.existing_cylinder_pressure_kpa', ''),
    ('replacement_cylinder_pressure_kpa', 'inspection_gas.replacement_cylinder_pressure_kpa', ''),
    ('feed_pressure_kpa', 'inspection_gas.existing_feed_pressure_kpa', ''),
    ('bubble_rate_bpm', 'inspection_gas.existing_bubble_rate_bpm', ''),
    ('gas_consumption_kpa_month', 'inspection_gas.consumption_kpa_per_month', ''),
    ('gas_pump_cycle_kpa', 'inspection_gas.compressor_pump_cycle_from_kpa', ''),
    ('dp_counter', 'inspection_data.dp_counter', ''),
    ('dp_battery_v', 'inspection_power (new column)', 'Mace DP battery, distinct from the station battery.'),
    ('supply_v', 'inspection_calibration.supply_v', 'Voltage the decoder supplies to a receiver.'),
    ('antenna_frequency_mhz', 'inspection_radio.existing_frequency_mhz', ''),
    ('shaft_encoder_count_direction', 'inspection_calibration.notes', 'S/E Count UP/DN.'),
    ('analogue_range_m', 'inspection_water_level.transmitter_range', ''),
    ('remarks', 'inspection.remarks', ''),
    ('station_name', 'inspection.station_name', 'Only the two flat tabs print it as a column.'),
]
CANONICAL_FIELDS = {f for f, _, _ in CANONICAL}

# Ordered: first match wins. Written against the labels the workbook actually
# has — `tools/ingest/inspection_field_map.json` lists every one of them and
# which rule caught it, so a rule that stops matching is visible in the diff.
FIELD_RULES = [
    ('inspect_date', r'inspect.*date|^date$|^inspect$|^inspection date$|'
                     r'^date installed$|^tm date$'),
    ('station_number', r'station\s*(number|no|#)|^station$|^tm station'),
    ('station_name', r'crosscheck site name|^site name$|^station name$|^base station$|'
                     r'^base station entires?$|^base station entries$'),
    ('canister_no', r'canister\s*(no|number)?$|^canister$'),
    ('canister_type', r'canister type|^type used$'),
    ('logger_no', r'(logger|mace)\s*(no|number)?$'),

    ('battery_test_raw', r'argus|v\s*/\s*cca'),
    ('lithium_battery_v', r'lithium'),
    ('dp_battery_v', r'^dp battery'),
    ('battery_under_load_v', r'batter\w*.*under\s*-?\s*load|^under\s*-?load$|'
                             r'^voltage under load$|batter\w*.*\b(load|under)\b'),
    ('battery_standby_v', r'batter\w*.*sta\w*\s*-?\s*by|^battery voltage$|^battery$|'
                          r'^sta\w*\s*-?\s*by$|batter\w*.*\bstand\b'),

    ('consumption_sleep_ma', r'sleep'),
    ('consumption_operating_ma', r'operat'),
    ('consumption_interrogation_ma', r'interr'),
    ('consumption_transmit_ma', r'consu\w*.*(trans|-?mit)|^transmit \(ma\)$|'
                                r'consu\w*.*\btrans\b'),
    ('consumption_standby_ma', r'consu\w*.*stand|^stand-?by \(ma\)$|^consu-? ?mption$|'
                               r'^consumption \(ma\)$|^consumption$'),

    ('mains_charge_current_ma', r'mains.*(charge|\(ma\))'),
    ('mains_regulated_v', r'mains.*(regul|\(v\))'),
    ('solar_step_up_v', r'step\s*-?\s*up'),
    ('solar_short_circuit_ma', r'short\s*(circuit|curcuit)'),
    ('solar_regulated_v', r'solar.*(regul|^reg$)|^regulated voltage|^regul|solar.*\breg\b'),
    ('solar_charge_current_ma', r'solar.*charge|^current charge|^charge current|'
                                r'^\(ma\) charge current|solar.*\(ma\)'),
    ('solar_output_v', r'solar.*(output|open\s*circuit|volt)|^output voltage|'
                       r'^open circuit|solar.*\(v'),

    ('telephone_socket_v', r'phone\s*socket'),
    ('tx_size_w', r'tx size'),
    ('tx_deviation_khz', r'\bdev\b'),
    ('rssi_dbm', r'\brssi\b|signal strength'),
    ('fade_margin_db', r'fade|^margin'),

    ('antenna_forward_w', r'antenna.*fwd|antenna.*forward|#\d\s*fwd'),
    ('antenna_reflected_w', r'antenna.*ref|#\d\s*ref'),
    ('antenna_swr', r'antenna.*swr|#\d\s*swr'),
    ('antenna_frequency_mhz', r'#\d\s*freq|antenna.*freq'),
    ('decoder_serial', r'serial.*deco'),
    ('receiver1_serial', r'serial.*recei\w*\s*-?\s*1|serial.*receiver1'),
    ('receiver2_serial', r'serial.*recei\w*\s*-?\s*2|serial.*receiver2'),
    ('supply_v', r'supply\s*v|voltage from decoder'),
    ('decoder_v', r'deco'),
    ('receiver_v', r'recei|^\d+(\.\d+)?\s*output$'),

    ('tx_forward_w', r'\bfwd\b|forward power|transmitter.*power|^power \(w\)$'),
    ('tx_reflected_w', r'^ref\.?$|reflected|transmitter.*ref'),
    ('swr', r'\bswr\b'),

    ('tbrg_calibration_mm', r'tbrg|calb|^cal\b|calib'),

    ('shaft_encoder_count_direction', r'count\s*up\s*/?\s*dn|s/e\s*up\s*/?\s*dn'),
    ('shaft_encoder_increments_per_rev', r'incre\w*\s*-?\s*ments?|^-?ments$'),
    ('shaft_encoder_revs', r'revs|revolution'),
    ('shaft_encoder_accum_diff', r'accum'),
    ('shaft_encoder_error', r'shaft.*error|^error$'),
    ('shaft_encoder_result', r'correct result|test\s*set|shaft.*(result|set)|^result$'),
    ('analogue_range_m', r'ogue range|analogue range|^range m'),

    ('replacement_cylinder_pressure_kpa', r'replacement cylinder'),
    ('cylinder_pressure_kpa', r'cylin\w*.*press|press-?\s*ure'),
    ('feed_pressure_kpa', r'feed press'),
    ('bubble_rate_bpm', r'bubble'),
    ('gas_consumption_kpa_month', r'cons.*month|gas consump'),
    ('gas_pump_cycle_kpa', r'pump cycle'),
    ('gas_pressure_kpa', r'gas|kpa'),
    ('dp_counter', r'^counter$'),

    ('remarks', r'remark|comment'),
]
FIELD_RULES = [(f, re.compile(p, re.I)) for f, p in FIELD_RULES]

# Labels that are real columns but carry nothing #126 can hold as a field. They
# are mapped explicitly so that "unmapped" stays a short, meaningful list.
UNMAPPABLE = [
    (re.compile(r'^cons\.?\s*\(m?a\)$', re.I),
     'a bare "Cons. (mA)" with no group cell of its own — standby or transmit '
     'is not recoverable from the sheet, so #124 rejects the column rather '
     'than guessing (Burrum Cherwell!K240)'),
    (re.compile(r'^column\d+$', re.I),
     'Excel table placeholder header over an empty column on the TM Only tab'),
    (re.compile(r'^putty log$', re.I),
     'a note about how the reading was taken, not a reading'),
    (re.compile(r'^power supply v$', re.I), 'ambiguous: one Ipswich block, no unit and no group'),
    (re.compile(r'^volts?$|^voltage$', re.I), 'bare "Volts" with no group label — which voltage is not recoverable'),
    (re.compile(r'^no$|^type$|^used$', re.I), 'a header fragment left over when its own stack row is blank'),
]


# A data row whose date cell is malformed gets absorbed into the header band,
# and its values end up appended to the labels above them: `Canister No
# 05122432001`, `Under -load 12.2`. The value is stripped off the label and the
# row is a reject for #124 — see the spec, "Rows that are not inspections".
ABSORBED_VALUE = re.compile(
    r'^(?P<label>.*?[A-Za-z)\-])\s+(?P<value>-?\d[\d./]*|[A-Z]{2}\d{3,})$')


def strip_absorbed_value(label: str) -> tuple[str, str]:
    m = ABSORBED_VALUE.match(label)
    if not m:
        return label, ''
    # `Antenna 151.5 #1` and `7091-7200` are labels, not values, so only a
    # trailing token after a word-ending character is taken.
    return m.group('label').strip(), m.group('value')


BARE_UNIT = re.compile(r'^\((m?a|v\.?|w|db|kpa|khz|mm|metres)\)', re.I)

ERROR_IN_LABEL = re.compile(r'\s*#(NAME\?|REF!|VALUE!|N/A)\s*')


def strip_block_note(label: str) -> tuple[str, tuple[str, str] | None]:
    """Split a header label into (column label, block note or None).

    The group row is not only group labels: technicians parked phone numbers,
    key numbers, repeater windows and frequencies on it, and those end up
    prefixed onto the column label underneath. `Phone No: 07 4676 4290 Lithium
    Batter Voltage (v)` is one column and one fact about the station.
    """
    for name, pattern in BLOCK_NOTES:
        m = pattern.match(label)
        if not m:
            continue
        rest = m.group(1)
        # The column label is the tail that survives after the note's own text.
        # Everything up to the last recognisable column word is the note.
        for field, rule in FIELD_RULES:
            hit = rule.search(rest)
            if hit:
                cut = hit.start()
                note_text = rest[:cut].strip(' .:,-')
                column = rest[cut:].strip()
                if column:
                    return column, (name, note_text or rest.strip())
        return label, None
    return label, None


def map_field(label: str):
    """(canonical field, rule index) or (None, reason)."""
    clean = norm(label)
    if not clean:
        return None, 'empty'
    if NUMERIC_LABEL.match(clean):
        return 'river_calibration_point', 'numeric'
    for pattern, reason in UNMAPPABLE:
        if pattern.match(clean):
            return None, reason
    for i, (field, rule) in enumerate(FIELD_RULES):
        if rule.search(clean):
            return field, i
    return None, 'no rule matches'


# ── Blocks ───────────────────────────────────────────────────────────────────


class Block:
    __slots__ = ('sheet', 'index', 'banner_row', 'family', 'end_row', 'owner_row',
                 'ids_row', 'group_rows', 'header_rows', 'date_col', 'header',
                 'station_name', 'cbm_no', 'ids', 'notes', 'rows', 'inherited')

    def __init__(self, sheet, index, banner_row, family):
        self.sheet, self.index = sheet, index
        self.banner_row, self.family = banner_row, family
        self.end_row = banner_row
        self.owner_row = None
        self.ids_row = None
        self.group_rows: list[int] = []
        self.header_rows: list[int] = []
        self.date_col = None
        self.header: dict[int, str] = {}
        self.station_name = ''
        self.cbm_no = ''
        self.ids: dict[str, str] = {}
        self.notes: dict[str, str] = {}
        self.rows: list[dict] = []
        self.inherited = False

    @property
    def ref(self) -> str:
        return f'{self.sheet}!{self.banner_row}'


# The label is anchored at the start of its cell. Unanchored, `BoM Abloy lock on
# gate Nov 2022` — a note somebody parked on a banner row — reads as a Bureau
# number label whose value is `Abloy lock on gate Nov 2022`.
CBM_LABEL = re.compile(
    r'^\s*(?:CBM|CMB|BUREAU|BOM)\b\s*(?:NO\.?|NUMBER)?\s*[:.]?\s*(.*)$', re.I)
STATION_LABEL = re.compile(r'^\s*STATION\b\s*[:.]?\s*(.*)$', re.I)
CBM_TOKEN = re.compile(r'^\d{4,8}(\.\d+)?$')

# What a number is allowed to look like. `33205/33291` is one block covering two
# numbers and `531043.2` is one of three sensors at a site, so the shape is
# digits, dots and slashes — never coerced, never split (spec §2).
CBM_NUMERIC = re.compile(r'^[\d./]+$')
# …and what a number followed by somebody's note looks like: `039338 < Still
# open as Old Range Rd Alert`, `40625 (Radar)`, `031205 OLD SITE`. The number is
# the number; the rest is kept as a note rather than as part of it.
CBM_LEADING = re.compile(r'^(\d{4,8}(?:[./]\d+)*)\b\s*(\S.*)$')


def read_cbm_value(text):
    """(cbm number, note) for a cell that should hold one.

    Returns ('', '') when the cell holds no number at all, so the caller keeps
    looking — two `CBM NO.` label cells in a row is a real layout, and taking
    the second label as the first one's value is how `CBM NO.` ends up stored
    as a station's Bureau number.
    """
    text = norm(text)
    inner = CBM_LABEL.match(text)
    if inner:
        # `CBM NO.    035242` — the label repeated inside its own value cell.
        text = inner.group(1).strip()
    if not text:
        return '', ''
    if CBM_NUMERIC.match(text):
        return text, ''
    m = CBM_LEADING.match(text)
    if m:
        return m.group(1), text
    return '', text


def read_banner(sheet, row):
    """(station name, cbm no, note) off a banner row."""
    cells = sheet.row_cells(row)
    name, cbm, note = '', '', ''
    for i, cell in enumerate(cells):
        if cell.kind != 'text':
            continue
        m = STATION_LABEL.match(cell.value)
        if not m:
            continue
        if m.group(1).strip():
            name = m.group(1).strip()
        else:
            for nxt in cells[i + 1:]:
                text = nxt.text.strip()
                if text and not re.search(r'\b(CBM|CMB|BUREAU|BOM)\b', text, re.I):
                    name = text
                    break
        break
    for i, cell in enumerate(cells):
        if cell.kind != 'text' or not CBM_LABEL.match(cell.value):
            continue
        for candidate in [CBM_LABEL.match(cell.value).group(1)] + \
                         [c.text for c in cells[i + 1:]]:
            cbm, said = read_cbm_value(candidate)
            # The note is whatever the banner said that was not the number, and
            # it is kept even when a later cell supplies the number:
            # `Burdekin!694` reads `s: SELLHEIM 34085 / SELLHEIM TM 533011/`
            # before it reaches `533075`, and those two other numbers exist
            # nowhere else.
            note = note or said
            if cbm:
                break
        break
    if not cbm:
        # Several sheets (Ipswich throughout) print the number in a fixed column
        # with no label at all. The rightmost bare 4-8 digit token is it.
        tokens = [c.text.strip() for c in cells if CBM_TOKEN.match(c.text.strip())]
        if tokens:
            cbm = tokens[-1]
    return name, cbm, note


def read_ids(sheet, row):
    """The `ID's` line: what is structured, and the raw cells besides."""
    found, raw = {}, []
    for cell in sheet.row_cells(row):
        text = norm(cell.text)
        if not text:
            continue
        raw.append(text)
        for name, pattern in IDS_FIELDS:
            m = pattern.search(text)
            if m and name not in found:
                found[name] = m.group(1).strip()
    found['raw'] = ' | '.join(raw)
    return found


def find_blocks(sheet):
    """Every station block on a banner-structured sheet, in sheet order."""
    banners = []
    for row, cells in sheet.iter_rows():
        for cell in cells:
            if cell.kind == 'text' and BANNER.search(cell.value):
                banners.append((row, BANNER.search(cell.value).group(1).upper()))
                break
    blocks = []
    previous = None
    for i, (row, family) in enumerate(banners):
        block = Block(sheet.name, i, row, family)
        block.end_row = banners[i + 1][0] - 1 if i + 1 < len(banners) else sheet.max_row
        block.station_name, block.cbm_no, cbm_note = read_banner(sheet, row)
        if cbm_note:
            # The banner said something beside the number — `40625 (Radar)`, or
            # prose where a number should be. Kept, because it is the only place
            # it exists and #125 resolves identities by hand where this happens.
            block.notes['cbm_note'] = cbm_note

        if row > 1 and OWNER_ROW.search(' '.join(c.text for c in sheet.row_cells(row - 1))):
            block.owner_row = row - 1

        anchor = None
        for candidate in range(row + 1, min(row + 9, block.end_row + 1)):
            if any(c.kind == 'text' and DATE_HEADER.search(norm(c.value))
                   for c in sheet.row_cells(candidate)):
                anchor = candidate
                break

        if anchor is None:
            # A banner dropped into the middle of a run of data rows — one
            # station renamed partway down another's block. It inherits the
            # header above it; see the spec, "Block detection".
            if previous is not None:
                block.header = dict(previous.header)
                block.date_col = previous.date_col
                block.inherited = True
            first_data = row + 1
        else:
            for candidate in range(row + 1, anchor):
                text = ' '.join(c.text for c in sheet.row_cells(candidate))
                if IDS_ROW.search(text):
                    block.ids_row = candidate
                    block.ids = read_ids(sheet, candidate)
                else:
                    block.group_rows.append(candidate)
            block.date_col = next(
                (c.col for c in sheet.row_cells(anchor)
                 if c.kind == 'text' and DATE_HEADER.search(norm(c.text))), None)
            block.header_rows = [anchor]
            probe = anchor + 1
            while probe <= block.end_row and len(block.header_rows) < 4:
                kind, _, _ = parse_date(sheet.cell(probe, block.date_col))
                if kind in ('datetime', 'text', 'year_only'):
                    break
                if not any(c.text.strip() for c in sheet.row_cells(probe)):
                    break
                block.header_rows.append(probe)
                probe += 1
            first_data = probe

            # A block can carry two header bands — an old one left in place and
            # a newer one pasted under it (Mary!600 is the clearest). The band
            # immediately above the data is the one the data was entered under,
            # so it wins, and everything above it becomes group/annotation rows.
            restart = next((r for r in reversed(block.header_rows[1:])
                            if is_second_band(sheet, r)), None)
            if restart is not None:
                block.group_rows += [r for r in block.header_rows if r < restart]
                block.header_rows = [r for r in block.header_rows if r >= restart]
                block.date_col = next(
                    (c.col for c in sheet.row_cells(restart)
                     if c.kind == 'text' and DATE_HEADER.search(norm(c.text))),
                    block.date_col)
            block.header, header_notes = resolve_header(sheet, block)
            # Merged rather than assigned: the banner may already have left a
            # `cbm_note` on the block.
            block.notes.update(header_notes)

        block.rows = read_rows(sheet, block, first_data)
        blocks.append(block)
        previous = block
    return blocks


def is_second_band(sheet, row):
    """Is this row the start of a *replacement* header rather than a
    continuation of the one above it?

    Two header bands in one block happen where a sheet was re-templated and the
    old header was left in place above the new one (`Mary!`600). The tell is not
    the date word — `Inspect` over `Date` is one header split across two rows —
    it is a full header row directly under a row of group labels.
    """
    cells = sheet.row_cells(row)
    if len(cells) < 5:
        return False
    if not any(c.kind == 'text' and DATE_HEADER.search(norm(c.text)) for c in cells):
        return False
    above = sheet.row_cells(row - 1)
    groups = sum(1 for c in above if c.kind == 'text' and GROUP_ROW_WORDS.match(norm(c.text)))
    return groups >= 3


def resolve_header(sheet, block):
    """Collapse the stacked header rows into one label per column."""
    stack: dict[int, list[str]] = {}
    for row in block.header_rows:
        for cell in sheet.row_cells(row):
            text = norm(cell.text)
            if text:
                stack.setdefault(cell.col, []).append(text)

    groups: dict[int, str] = {}
    notes: dict[str, str] = {}
    for row in block.group_rows:
        for cell in sheet.row_cells(row):
            text = norm(cell.text)
            if not text or IDS_ROW.search(text) or OWNER_ROW.search(text):
                continue
            if NUMERIC_LABEL.match(text):
                # The duplicate calibration-point row that sits above the header
                # on some sheets. Not a group label, and not the block's points
                # either — the row inside the header band is.
                notes.setdefault('stray_point_row_above_header', f'row {row}')
                continue
            claimed = False
            for name, pattern in BLOCK_NOTES:
                m = pattern.match(text)
                if m:
                    notes.setdefault(name, m.group(1).strip())
                    claimed = True
                    break
            if claimed or MARKER_ROW.search(text):
                continue
            if GROUP_LABELS.match(text):
                span = sheet.merge_span(row, cell.col)
                low, high = span if span else (cell.col, cell.col)
                for col in range(low, high + 1):
                    groups[col] = text
                continue
            notes.setdefault('group_row_note', text)

    header = {}
    for col, parts in stack.items():
        seen = []
        for part in parts:
            if part.lower() not in (p.lower() for p in seen):
                seen.append(part)
        label = ' '.join(seen)
        if NUMERIC_LABEL.match(label):
            # A calibration-point column: its label is the point, not a name.
            header[col] = label
            continue
        group = groups.get(col)
        if group is None and BARE_UNIT.match(label):
            # The group cell above is there but was never merged across this
            # column, so the span cannot see it. A label that is only a unit is
            # never the whole name, so the nearest group to the left is taken.
            group = next((groups[c] for c in range(col - 1, 0, -1) if c in groups), None)
        if group and group.lower() not in label.lower():
            label = f'{group} {label}'
        label, note = strip_block_note(norm(label))
        if note:
            notes.setdefault(note[0], note[1])
        if ERROR_IN_LABEL.search(label):
            notes.setdefault('formula_error_in_header', norm(label))
            label = ERROR_IN_LABEL.sub(' ', label)
        label, absorbed = strip_absorbed_value(norm(label))
        if absorbed:
            notes.setdefault('absorbed_value_in_header', f'{label}: {absorbed}')
        header[col] = norm(label)
    return header, notes


HEADER_WORDS = re.compile(
    r'^(stand|under|-?by|load|fwd|ref\.?|swr|margin|calb|calib|remarks?|circuit|'
    r'charge|regul\w*|volt\w*|sleep|operat\w*|interr\w*|no|date|inspect|'
    r'canister|logger|output|short|current|power|fade|tbrg|increm\w*|revs?\.?|'
    r'#\d\s*(fwd|ref|swr)\s*pwr?|deco\w*|recei\w*)$', re.I)

PLAUSIBLE_YEARS = (1980, 2025)


def looks_like_data(cells, date_col):
    """Three or more readings on the row, which is what a data row looks like
    once its date is gone."""
    return sum(1 for c in cells
               if c.col != date_col
               and classify_value(c) in ('number', 'numeric_text', 'qualified',
                                         'status', 'number_with_unit', 'range')) >= 3


def looks_like_header(cells):
    return sum(1 for c in cells
               if c.kind == 'text' and HEADER_WORDS.match(norm(c.text))) >= 3


def read_rows(sheet, block, first_data):
    """Classify every row from the header down to the end of the block."""
    out = []
    for row in range(first_data, block.end_row + 1):
        cells = sheet.row_cells(row)
        if not any(c.text.strip() for c in cells):
            continue
        kind, value, precision = parse_date(sheet.cell(row, block.date_col)) if block.date_col else (None, None, None)
        text = ' '.join(c.text for c in cells)
        if kind in ('datetime', 'text', 'year_only'):
            record = {'row': row, 'class': 'inspection', 'date_kind': kind,
                      'date': value, 'precision': precision}
            if value and not (PLAUSIBLE_YEARS[0] <= value.year <= PLAUSIBLE_YEARS[1]):
                record['implausible_date'] = sheet.text(row, block.date_col)
            out.append(record)
            continue
        if MARKER_ROW.search(text):
            out.append({'row': row, 'class': 'marker'})
        elif OWNER_ROW.search(text):
            out.append({'row': row, 'class': 'next_block_owner'})
        elif all(c.kind == 'error' for c in cells if c.text.strip()):
            out.append({'row': row, 'class': 'error_only'})
        elif all(NUMERIC_LABEL.match(c.text.strip()) or c.kind == 'number'
                 for c in cells if c.text.strip()):
            out.append({'row': row, 'class': 'calibration_point_row'})
        elif looks_like_header(cells):
            out.append({'row': row, 'class': 'repeat_header', 'text': norm(text)[:120]})
        elif looks_like_data(cells, block.date_col):
            # A row of readings whose date cell is either empty or something no
            # date parser should accept (`12/5//97`, `4/1/2/2012`, a stray
            # opening quote). #124 rejects these with the cell they came from.
            dated = block.date_col and sheet.text(row, block.date_col).strip()
            out.append({'row': row,
                        'class': 'malformed_date' if dated else 'undated_data',
                        'text': norm(text)[:120]})
        elif len(cells) <= 3 or len(norm(text)) > 40:
            out.append({'row': row, 'class': 'annotation', 'text': norm(text)[:160]})
        else:
            out.append({'row': row, 'class': 'unresolved', 'text': norm(text)[:120]})
    return out


# ── The two flat tabs ────────────────────────────────────────────────────────
# `ALERTS` and `TM Only` have no banners at all: one header band at the top and
# one row per inspection under it, with the station named in a column.

FLAT_SHEETS = {
    'ALERTS': {'header_rows': [1, 2], 'family': 'ALERT', 'name_col': 1,
               'number_col': 2, 'date_col': 3},
    'TM Only': {'header_rows': [3], 'family': 'BASE STATION', 'name_col': 1, 'date_col': 3},
}


def read_flat(sheet, spec):
    stack: dict[int, list[str]] = {}
    groups: dict[int, str] = {}
    rows = spec['header_rows']
    for row in rows[:-1]:
        for cell in sheet.row_cells(row):
            text = norm(cell.text)
            if not text:
                continue
            span = sheet.merge_span(row, cell.col)
            low, high = span if span else (cell.col, cell.col)
            for col in range(low, high + 1):
                groups[col] = text
    for cell in sheet.row_cells(rows[-1]):
        text = norm(cell.text)
        if text:
            stack.setdefault(cell.col, []).append(text)
    header = {}
    for col, parts in stack.items():
        label = ' '.join(parts)
        if NUMERIC_LABEL.match(label):
            header[col] = label
            continue
        group = groups.get(col)
        if group and group.lower() not in label.lower():
            label = f'{group} {label}'
        header[col] = norm(label)
    data = []
    for row in range(rows[-1] + 1, sheet.max_row + 1):
        cells = sheet.row_cells(row)
        if not any(c.text.strip() for c in cells):
            continue
        kind, value, precision = parse_date(sheet.cell(row, spec['date_col']))
        text = ' '.join(c.text for c in cells)
        if kind in ('datetime', 'text', 'year_only'):
            data.append({'row': row, 'class': 'inspection', 'date_kind': kind,
                         'date': value, 'precision': precision,
                         'name': norm(sheet.text(row, spec['name_col'])).lower(),
                         'number': norm(sheet.text(row, spec.get('number_col', 0)) or '').lower()})
        elif MARKER_ROW.search(text):
            data.append({'row': row, 'class': 'marker'})
        else:
            data.append({'row': row, 'class': 'unresolved', 'text': norm(text)[:120]})
    return header, data


# ── Dispositions ─────────────────────────────────────────────────────────────
# Every sheet gets one, and the reason is part of it. #122's non-goals decide
# three of them up front; the rest follow from what is on the sheet.

SKIP_REASONS = {
    'SLS OCT23': ('skip', "#122 non-goal: @cdomotor-g called this tab outdated. It is a "
                          "station registry (34 columns of Service Level Specification), "
                          "not inspections, so it would not write to these tables anyway."),
    'SWR': ('skip', '#122 non-goal: a 3-cell SWR calculator, not data.'),
    'SLS 26092023': ('skip', "Answered by @cdomotor-g on 2026-08-15: ignore both SLS tabs. "
                             "Hidden twin of `SLS OCT23`, identical 34-column shape, dated "
                             "slightly earlier. Station registry rather than inspections, so "
                             "it would write to the station table and nothing in #122 is "
                             "affected either way."),
}

# The hidden legacy sheets and the visible sheet each one shadows. Established
# by name, then checked by comparing what is actually in them — see
# `hidden_twin_report`.
TWINS = {
    'Barron': 'Barron!', 'Burdekin': 'Burdekin!', 'Burrum Cherwell': 'Burrum Cherwell!',
    'Don': 'Don!', 'Haughton': 'Haughton!', 'Herbert': 'Herbert!', 'Logan': 'Logan!',
    'Mary': 'Mary!', 'Moonie': 'Moonie!', 'Pioneer': 'Pioneer!', 'Redlands': 'Redlands!',
    'Townsville': 'Townsville!', 'Master': 'Master (2)',
}

# Answered by @cdomotor-g on 2026-08-15, in reply to #122's open question 2:
# ignore the hidden legacy sheets, and take the visible `!` twin as
# authoritative. They are still *read* — the comparison in `hidden_twins` is
# what makes the decision a safe one rather than a hopeful one, and it stops
# being checkable the moment the survey stops reading them.
#
# `Master` is hidden too and is skipped on its own merits (it is a template with
# no dated row), so it keeps that reason rather than this one.
DECIDED_OUT_OF_SCOPE = {
    hidden: ('skip',
             'Answered by @cdomotor-g on 2026-08-15: the hidden legacy sheets are ignored '
             f'and the visible `{visible}` is authoritative. Kept in the survey — see '
             '`hidden_twins` for what this sheet holds that its visible twin does not '
             '(measured, and every difference is an identity artefact rather than a '
             'missing visit).')
    for hidden, visible in {
        'Barron': 'Barron!', 'Burdekin': 'Burdekin!', 'Burrum Cherwell': 'Burrum Cherwell!',
        'Don': 'Don!', 'Haughton': 'Haughton!', 'Herbert': 'Herbert!', 'Logan': 'Logan!',
        'Mary': 'Mary!', 'Moonie': 'Moonie!', 'Pioneer': 'Pioneer!', 'Redlands': 'Redlands!',
        'Townsville': 'Townsville!',
    }.items()
}

FAMILY_TO_CONFIG = {
    'ALERT': 'alert',
    'DATA LOGGER': 'datalogger_old',
    'CR800': 'campbell_datalogger',
    'RRDL3': 'datalogger_old',
    'BASE STATION': 'base_station',
    'MACE': 'mace',
}


def station_keys(block):
    """Every key this block can be recognised by.

    Two, and either is enough: the station name with punctuation and case
    removed, and the CBM number with its leading zeros removed. The zeros
    matter — a hidden sheet stores `040876` as text and its visible twin stores
    the same number as a number, so a literal comparison says they are
    different stations when they are the same one.
    """
    keys = set()
    name = re.sub(r'[^a-z0-9]', '', norm(block.station_name).lower())
    if name:
        keys.add('n:' + name)
    cbm = norm(block.cbm_no).lower()
    digits = re.match(r'^0*(\d+)(?:\.0)?$', cbm)
    if digits:
        keys.add('c:' + digits.group(1))
    elif cbm:
        keys.add('c:' + re.sub(r'[^a-z0-9./]', '', cbm))
    return keys


def visit_keys(block):
    return {r['date'].date().isoformat() for r in block.rows
            if r['class'] == 'inspection' and r.get('date')}


# ── The survey ───────────────────────────────────────────────────────────────


def _date_col_of(info, row_record):
    """The date column a classified row was read under."""
    if info['flat']:
        return info['date_col']
    for b in info['blocks']:
        if b.banner_row <= row_record['row'] <= b.end_row:
            return b.date_col
    return 1


def survey():
    wb = xlsx.load(WORKBOOK)
    sheets = {s.name: s for s in wb.sheets}

    parsed = {}
    for sheet in wb.sheets:
        if sheet.name in SKIP_REASONS:
            continue
        if sheet.name in FLAT_SHEETS:
            header, rows = read_flat(sheet, FLAT_SHEETS[sheet.name])
            parsed[sheet.name] = {'flat': True, 'header': header, 'rows': rows,
                                  'blocks': [], 'date_col': FLAT_SHEETS[sheet.name]['date_col']}
        else:
            parsed[sheet.name] = {'flat': False, 'blocks': find_blocks(sheet)}

    # -- manifest --
    manifest = []
    label_counts = collections.Counter()
    label_example = {}
    layouts = collections.Counter()
    layout_example = {}
    layout_family = {}
    value_classes = collections.Counter()
    date_kinds = collections.Counter()
    years = collections.Counter()
    qualified = collections.Counter()
    status = collections.Counter()
    unresolved_rows = []
    implausible = []
    date_evidence = collections.Counter()
    block_notes = collections.Counter()
    calibration_point_sets = collections.Counter()

    for sheet in wb.sheets:
        entry = {
            'sheet': sheet.name,
            'visible': not sheet.hidden,
            'declared_dimension': sheet.declared_dimension,
            'used_range': sheet.used_range,
            'used_rows': sheet.max_row,
            'used_cols': sheet.max_col,
            'cell_comments': len(sheet.comments),
            'threaded_comments': sum(1 for c in sheet.comments if c['threaded']),
        }
        if sheet.name in SKIP_REASONS:
            disposition, reason = SKIP_REASONS[sheet.name]
            entry.update({'disposition': disposition, 'reason': reason,
                          'form_families': [], 'inspection_config': None,
                          'blocks': 0, 'inspection_rows': 0})
            manifest.append(entry)
            continue

        info = parsed[sheet.name]
        if info['flat']:
            spec = FLAT_SHEETS[sheet.name]
            families = [spec['family']]
            n_blocks = 0
            rows = info['rows']
            for col, label in info['header'].items():
                if not label:
                    continue
                label_counts[label] += 1
                label_example.setdefault(label, f'{sheet.name}!{xlsx.index_to_col(col)}{spec["header_rows"][-1]}')
            sig = tuple(f'{xlsx.index_to_col(c)}:{l}' for c, l in sorted(info['header'].items()))
            layouts[sig] += 1
            layout_example.setdefault(sig, f'{sheet.name}!{spec["header_rows"][-1]}')
            layout_family.setdefault(sig, spec['family'])
        else:
            blocks = info['blocks']
            families = sorted({b.family for b in blocks})
            n_blocks = len(blocks)
            rows = [r for b in blocks for r in b.rows]
            for b in blocks:
                if b.inherited:
                    continue
                for col, label in b.header.items():
                    if not label:
                        continue
                    label_counts[label] += 1
                    label_example.setdefault(
                        label, f'{sheet.name}!{xlsx.index_to_col(col)}'
                               f'{b.header_rows[0] if b.header_rows else b.banner_row}')
                sig = tuple(f'{xlsx.index_to_col(c)}:'
                            f'{"<point>" if NUMERIC_LABEL.match(l) else l}'
                            for c, l in sorted(b.header.items()) if l)
                if sig:
                    layouts[sig] += 1
                    layout_example.setdefault(sig, b.ref)
                    layout_family.setdefault(sig, b.family)
                points = tuple(l for _, l in sorted(b.header.items())
                               if l and NUMERIC_LABEL.match(l))
                if points:
                    calibration_point_sets[points] += 1

        if not info['flat']:
            for b in info['blocks']:
                for note in b.notes:
                    block_notes[note] += 1
        for r in rows:
            if r['class'] != 'inspection' or r['date_kind'] != 'text':
                continue
            m = DATE_TEXT.match(sheet.text(r['row'], _date_col_of(info, r)).strip())
            if not m:
                continue
            if int(m.group(1)) > 12:
                date_evidence['day_over_12_proving_day_first'] += 1
            if int(m.group(2)) > 12:
                date_evidence['month_over_12_which_would_prove_month_first'] += 1
            if len(m.group(3)) == 2:
                date_evidence['two_digit_year'] += 1
            else:
                date_evidence['four_digit_year'] += 1

        inspection_rows = sum(1 for r in rows if r['class'] == 'inspection')
        for r in rows:
            if r['class'] == 'inspection':
                date_kinds[r['date_kind']] += 1
                if r.get('date'):
                    years[r['date'].year] += 1
            elif r['class'] in ('unresolved', 'malformed_date', 'undated_data'):
                unresolved_rows.append(
                    f'{sheet.name}!{r["row"]} [{r["class"]}]: {r.get("text", "")}')
            if r.get('implausible_date'):
                implausible.append(
                    f'{sheet.name}!{r["row"]}: {r["implausible_date"]!r} '
                    f'-> {r["date"].date().isoformat()}')

        if inspection_rows == 0:
            disposition = 'skip'
            reason = ('Template. It carries the blank form — `NAME` and `xxxxxx` '
                      'in place of a station — and not one dated row.')
        elif sheet.name in DECIDED_OUT_OF_SCOPE:
            disposition, reason = DECIDED_OUT_OF_SCOPE[sheet.name]
        elif info['flat']:
            disposition, reason = 'ingest', 'Flat one-row-per-inspection tab.'
        else:
            disposition, reason = 'ingest', 'Station inspection blocks.'
        entry.update({
            'disposition': disposition,
            'reason': reason,
            'structure': 'flat' if info['flat'] else 'stacked_blocks',
            'form_families': families,
            'inspection_config': sorted({FAMILY_TO_CONFIG.get(f, 'unknown') for f in families}),
            'blocks': n_blocks,
            'inspection_rows': inspection_rows,
            'row_classes': dict(collections.Counter(r['class'] for r in rows)),
        })
        if sheet.name in TWINS:
            entry['shadows'] = TWINS[sheet.name]
        manifest.append(entry)

    # -- value classes, over the data rows of ingestable sheets --
    for sheet in wb.sheets:
        if sheet.name in SKIP_REASONS:
            continue
        info = parsed[sheet.name]
        if info['flat']:
            spec = FLAT_SHEETS[sheet.name]
            bands = [(spec['date_col'], [r['row'] for r in info['rows']
                                         if r['class'] == 'inspection'])]
        else:
            bands = [(b.date_col, [r['row'] for r in b.rows if r['class'] == 'inspection'])
                     for b in info['blocks']]
        for date_col, rows in bands:
            for row in rows:
                for cell in sheet.row_cells(row):
                    if cell.col == date_col:
                        continue
                    kind = classify_value(cell)
                    if kind == 'blank':
                        continue
                    value_classes[kind] += 1
                    if kind == 'qualified':
                        qualified[cell.text.strip()] += 1
                    elif kind == 'status':
                        status[cell.text.strip()] += 1

    # -- header vocabulary --
    mapped, unmapped = {}, {}
    for label, count in label_counts.items():
        field, why = map_field(label)
        record = {'count': count, 'example': label_example[label]}
        if field:
            record['field'] = field
            mapped[label] = record
        else:
            record['reason'] = why
            unmapped[label] = record

    # -- layouts, each column carrying its canonical field --
    layout_rows = []
    for sig, count in layouts.most_common():
        columns = []
        unmapped_here = 0
        for item in sig:
            col, _, label = item.partition(':')
            if label == '<point>':
                columns.append({'column': col, 'label': label,
                                'field': 'river_calibration_point'})
                continue
            field, why = map_field(label)
            columns.append({'column': col, 'label': label, 'field': field,
                            **({} if field else {'reason': why})})
            if not field:
                unmapped_here += 1
        layout_rows.append({
            'blocks': count,
            'family': layout_family.get(sig, ''),
            'example': layout_example.get(sig, ''),
            'columns': columns,
            'unmapped_columns': unmapped_here,
        })

    # -- hidden twins --
    twins = hidden_twin_report(parsed, sheets)

    # -- comments --
    comments = []
    for sheet in wb.sheets:
        if not sheet.comments:
            continue
        comments.append({
            'sheet': sheet.name,
            'comments': len(sheet.comments),
            'threaded': sum(1 for c in sheet.comments if c['threaded']),
            'authors': sorted({c['author'] for c in sheet.comments
                               if c['author'] and not c['author'].startswith('tc=')}),
            'notes': [{'ref': c['ref'],
                       'author': '' if c['author'].startswith('tc=') else c['author'],
                       'text': comment_text(c)}
                      for c in sheet.comments],
        })

    # -- ALERTS duplication --
    duplication = alerts_duplication(
        parsed, {e['sheet'] for e in manifest if e['disposition'] == 'ingest'})

    counts = {
        'workbook': 'archive/QLD All Site Inspections.xlsx',
        'sheets': len(wb.sheets),
        'visible': sum(1 for s in wb.sheets if not s.hidden),
        'hidden': sum(1 for s in wb.sheets if s.hidden),
        'blocks': sum(e.get('blocks', 0) for e in manifest),
        'ingested_sheets': sum(1 for e in manifest if e['disposition'] == 'ingest'),
        'ingested_blocks': sum(e.get('blocks', 0) for e in manifest
                               if e['disposition'] == 'ingest'),
        'ingested_inspection_rows': sum(e.get('inspection_rows', 0) for e in manifest
                                        if e['disposition'] == 'ingest'),
        'ingested_rejects': sum(
            n for e in manifest if e['disposition'] == 'ingest'
            for cls, n in (e.get('row_classes') or {}).items()
            if cls in ('unresolved', 'malformed_date', 'undated_data')),
        'blocks_by_family': dict(collections.Counter(
            b.family for name, info in parsed.items() if not info['flat']
            for b in info['blocks'])),
        'blocks_with_inherited_header': sum(
            1 for info in parsed.values() if not info['flat']
            for b in info['blocks'] if b.inherited),
        'inspection_rows': sum(e.get('inspection_rows', 0) for e in manifest),
        'inspection_rows_by_date_kind': dict(date_kinds),
        'inspection_rows_by_decade': dict(collections.Counter(
            f'{y // 10 * 10}s' for y in years.elements())),
        'date_range': [min(y for y in years if y >= PLAUSIBLE_YEARS[0]),
                       max(y for y in years if y <= PLAUSIBLE_YEARS[1])] if years else [],
        'distinct_cbm': None,   # filled below
        'distinct_station_names': None,
        'blocks_without_cbm': None,
        'distinct_header_labels': len(label_counts),
        'distinct_layouts': len(layouts),
        'distinct_calibration_point_sets': len(calibration_point_sets),
        'value_classes': dict(value_classes.most_common()),
        'top_qualified': dict(qualified.most_common(20)),
        'top_status': dict(status.most_common(20)),
        'unresolved_rows': len(unresolved_rows),
        'rows_needing_a_reject_reason': None,
        'implausible_dates': None,
        'cell_comments': sum(len(s.comments) for s in wb.sheets),
        'sheets_with_comments': sum(1 for s in wb.sheets if s.comments),
        'text_date_evidence': dict(date_evidence),
        'block_notes': dict(block_notes.most_common()),
        'row_classes': None,
    }

    cbm = collections.Counter()
    names = collections.Counter()
    no_cbm = 0
    for name, info in parsed.items():
        if info['flat']:
            continue
        for b in info['blocks']:
            if b.cbm_no:
                cbm[norm(b.cbm_no)] += 1
            else:
                no_cbm += 1
            if b.station_name:
                names[norm(b.station_name)] += 1
    counts['distinct_cbm'] = len(cbm)
    counts['distinct_station_names'] = len(names)
    counts['blocks_without_cbm'] = no_cbm

    totals = collections.Counter()
    for entry in manifest:
        for cls, n in (entry.get('row_classes') or {}).items():
            totals[cls] += n
    counts['row_classes'] = dict(totals.most_common())
    counts['implausible_dates'] = implausible
    counts['rows_needing_a_reject_reason'] = sum(
        n for entry in manifest for cls, n in (entry.get('row_classes') or {}).items()
        if cls in ('unresolved', 'malformed_date', 'undated_data'))
    counts['inspection_rows_by_decade'] = {
        k: v for k, v in sorted(counts['inspection_rows_by_decade'].items())
        if k in ('1980s', '1990s', '2000s', '2010s', '2020s')}
    counts['reconciliation'] = reconcile(counts)

    return {
        'manifest': manifest,
        'counts': counts,
        'field_map': {
            'canonical': [{'field': f, 'target': t, 'note': n} for f, t, n in CANONICAL],
            'mapped': dict(sorted(mapped.items(), key=lambda kv: -kv[1]['count'])),
            'unmapped': dict(sorted(unmapped.items(), key=lambda kv: -kv[1]['count'])),
        },
        'layouts': {
            'layouts': layout_rows,
            'calibration_point_sets': [
                {'points': list(points), 'blocks': n}
                for points, n in calibration_point_sets.most_common()
            ],
        },
        'twins': twins,
        'comments': comments,
        'duplication': duplication,
        'unresolved_examples': unresolved_rows[:40],
    }


# Excel writes a threaded comment twice: the real text under
# `xl/threadedComments/`, and a legacy stand-in in `xl/comments*.xml` that says
# "your version of Excel allows you to read this threaded comment" followed by
# a copy. The stand-in is what a naive reader gets, and it is not the note.
THREAD_BOILERPLATE = re.compile(
    r'^\s*\[Threaded comment\].*?(?:Comment:|comment:)\s*', re.S)


def comment_text(comment) -> str:
    if comment['threaded']:
        return norm(' / '.join(t['text'] for t in comment['threaded'] if t['text']))[:400]
    text = THREAD_BOILERPLATE.sub('', comment['text'])
    return norm(text)[:400]


def hidden_twin_report(parsed, sheets):
    """What each hidden legacy sheet has that its visible twin does not."""
    out = []
    for hidden, visible in sorted(TWINS.items()):
        if hidden not in parsed or visible not in parsed:
            continue
        h_blocks = parsed[hidden]['blocks']
        v_blocks = parsed[visible]['blocks']
        v_index = collections.defaultdict(set)
        for b in v_blocks:
            dates = visit_keys(b)
            for key in station_keys(b):
                v_index[key] |= dates
        h_index = collections.defaultdict(set)
        for b in h_blocks:
            dates = visit_keys(b)
            for key in station_keys(b):
                h_index[key] |= dates

        def missing(left, right):
            out = []
            for key, dates in left.items():
                for date in dates - right.get(key, set()):
                    out.append(f'{key} {date}')
            return sorted(set(out))

        only_hidden = missing(h_index, v_index)
        only_visible = missing(v_index, h_index)
        keys_only_hidden = collections.Counter(
            item.rsplit(' ', 1)[0] for item in only_hidden)
        h_visits = {f'{k} {d}' for k, dates in h_index.items() for d in dates}
        v_visits = {f'{k} {d}' for k, dates in v_index.items() for d in dates}
        out.append({
            'hidden': hidden,
            'visible': visible,
            'hidden_rows': sheets[hidden].max_row,
            'visible_rows': sheets[visible].max_row,
            'hidden_blocks': len(h_blocks),
            'visible_blocks': len(v_blocks),
            'hidden_visits': len(h_visits),
            'visible_visits': len(v_visits),
            'visits_only_in_hidden': len(only_hidden),
            'visits_only_in_visible': len(only_visible),
            'keys_only_in_hidden': [{'key': k, 'visits': n}
                                    for k, n in keys_only_hidden.most_common()],
            'examples_only_in_hidden': only_hidden[:5],
        })
    return out


def alerts_duplication(parsed, in_scope):
    """How many `ALERTS` rows are already on a basin tab, and how they match."""
    if 'ALERTS' not in parsed:
        return {}
    basin = collections.defaultdict(set)
    for name, info in parsed.items():
        if info['flat'] or name not in in_scope:
            continue
        for b in info['blocks']:
            key = norm(b.station_name).lower()
            for d in visit_keys(b):
                basin[key].add(d)
            if b.cbm_no:
                for d in visit_keys(b):
                    basin[norm(b.cbm_no).lower()].add(d)
    sheet = parsed['ALERTS']
    spec = FLAT_SHEETS['ALERTS']
    matched = unmatched = 0
    examples = []
    for row in sheet['rows']:
        if row['class'] != 'inspection' or not row.get('date'):
            continue
        day = row['date'].date().isoformat()
        keys = [k for k in (row.get('name', ''), row.get('number', '')) if k]
        if any(day in basin.get(k, ()) for k in keys):
            matched += 1
        else:
            unmatched += 1
            if len(examples) < 10:
                examples.append(f'ALERTS!{row["row"]} {keys[0] if keys else "?"} {day}')
    return {
        'alerts_rows': matched + unmatched,
        'already_on_a_basin_tab': matched,
        'only_on_the_alerts_tab': unmatched,
        'examples_only_on_alerts': examples,
        'note': 'Matched on (station name or station number, visit date). The '
                'ALERTS tab prints both, so a row that was copied down to its '
                'basin block matches on either. `Master (2)` instructs the '
                'crew to enter here first and copy into the basin block, so a '
                'match means the copy happened and the basin block is the '
                'canonical home; a miss means this tab is the only record. Matched '
                'against the ingested sheets only, so the hidden legacy sheets '
                '@cdomotor-g ruled out cannot supply a match.',
    }


def reconcile(counts):
    """Each headline count #122 quotes, against what this survey measures."""
    def row(name, issue, measured, note):
        return {'figure': name, 'issue_122': issue, 'survey': measured,
                'agrees': issue == measured, 'note': note}

    return [
        row('worksheets', 59, counts['sheets'], 'Agrees.'),
        row('visible worksheets', 44, counts['visible'],
            "#122 says 44 visible / 15 hidden. The workbook's own `state` "
            "attribute says 45 / 14 — every hidden sheet is listed in "
            "`twins` plus `SLS 26092023`, and there are fourteen."),
        row('hidden worksheets', 15, counts['hidden'], 'See above; off by one.'),
        row('station blocks', 1420, counts['blocks'], 'Agrees exactly.'),
        row('distinct CBM numbers', 1098, counts['distinct_cbm'],
            'Depends on the extraction rule; this survey adds a positional '
            'fallback for the sheets that print the number with no label at '
            'all (Ipswich prints it in a fixed column throughout). See the '
            'spec, "Block header extraction".'),
        row('blocks with no CBM on the banner', 55, counts['blocks_without_cbm'],
            'Same cause as the line above.'),
        row('distinct station names', 1083, counts['distinct_station_names'],
            'Same extraction question, plus whitespace normalisation.'),
        row('date-bearing inspection rows', 18500, counts['inspection_rows'],
            "#122's figure is approximate and appears to count only cells Excel "
            "stores as dates. This survey also counts the text dates "
            "(`16/03/06` and friends) and the two flat tabs, which have no "
            "banner and so no blocks. `ingested_inspection_rows` is the "
            "number #124 loads, which is lower: the hidden legacy sheets are "
            "read for comparison and not ingested."),
        row('distinct column-header layouts', 61, counts['distinct_layouts'],
            "Not reproducible: #122 does not record how a layout was counted, "
            "and no natural definition lands on 61. Measured here under four: "
            "column positions only = 87, the anchor header row's text = 140, "
            "the anchor row with column letters = 152, and the fully resolved "
            "header (group label + stacked rows, per column) = the number in "
            "`survey`. The mapping is the artefact rather than the count — "
            "every layout in inspection_layouts.json carries a canonical field "
            "per column."),
        row('free-text remark cells (>40 chars)', 7932, None,
            'Measured over every cell of every in-scope sheet rather than over '
            'data rows only; reported in value_classes as `prose` for data '
            'rows. The 7,932 figure reproduces exactly on the whole-sheet '
            'measure.'),
        row('#VALUE! cells', 707, None,
            'Reproduces exactly (707), plus #NAME? ×22, #N/A ×21 and #REF! ×1, '
            'which #122 does not mention.'),
    ]


# ── Output ───────────────────────────────────────────────────────────────────

ARTEFACTS = {
    'inspection_sheet_manifest.json': 'manifest',
    'inspection_survey_counts.json': 'counts',
    'inspection_field_map.json': 'field_map',
    'inspection_layouts.json': 'layouts',
}

BANNERS = {
    'inspection_sheet_manifest.json':
        'One entry per worksheet — #123 deliverable 1. Written by '
        'tools/ingest/survey.py; do not edit by hand.',
    'inspection_survey_counts.json':
        'Headline counts and how they reconcile against #122. Written by '
        'tools/ingest/survey.py; do not edit by hand.',
    'inspection_field_map.json':
        'The canonical field vocabulary and every header label mapped onto it. '
        'Written by tools/ingest/survey.py; do not edit by hand.',
    'inspection_layouts.json':
        'Every distinct column layout, each column carrying its canonical '
        'field. Written by tools/ingest/survey.py; do not edit by hand.',
}


def payload(result, name):
    key = ARTEFACTS[name]
    body = result[key]
    doc = {'_': BANNERS[name]}
    if name == 'inspection_sheet_manifest.json':
        doc['decisions'] = DECISIONS
        doc['hidden_twins'] = result['twins']
        doc['cell_comments'] = result['comments']
        doc['sheets'] = body
    elif name == 'inspection_survey_counts.json':
        doc.update(body)
        doc['alerts_tab'] = result['duplication']
        doc['unresolved_examples'] = result['unresolved_examples']
    else:
        doc.update(body)
    return json.dumps(doc, indent=2, ensure_ascii=False) + '\n'


# #122's three open questions, answered by @cdomotor-g on 2026-08-15 and
# recorded here rather than only in prose, so the artefact that carries the
# dispositions also carries the reason they are what they are.
DECISIONS = [
    {
        'id': '122-1',
        'question': "`SLS 26092023` (hidden) has the identical 34-column Service Level "
                    "Specification shape as `SLS OCT23`, which you asked to ignore. Ignore "
                    "both, or ingest the registry separately into the station table?",
        'answer': 'Ignore both.',
        'answered_by': '@cdomotor-g',
        'answered_on': '2026-08-15',
        'effect': "Both SLS tabs are `skip`. Neither is an inspection tab — they are a "
                  "station registry (basin, agency number, flood classes, priority, "
                  "gauge/telemetry/sensor type, LGA, owner, maintainer, schedules, hub) "
                  "and would have written to the station table rather than to "
                  "meganet.inspection, so nothing in #122 changes shape.",
    },
    {
        'id': '122-2',
        'question': "Hidden legacy sheets versus their visible `!` twins — merge both, or "
                    "treat the `!` sheet as authoritative?",
        'answer': 'Ignore the hidden sheets. The visible `!` sheet is authoritative.',
        'answered_by': '@cdomotor-g',
        'answered_on': '2026-08-15',
        'effect': "The twelve hidden legacy twins are `skip` (`Master` was already skipped "
                  "as a template). They are still read, and `hidden_twins` still records "
                  "what each one holds that its visible twin does not — 222 visits across "
                  "18 station keys, every one an identity artefact rather than a missing "
                  "visit. Keeping the measurement is what makes the decision checkable "
                  "later; #124 loads only the visible sheets.",
    },
    {
        'id': '122-3',
        'question': "NSW tabs (`NSW Lismore `, `NSW McIntyre`, `NSW Tweed!`, "
                    "`NSW Richmond!`) — in scope, or QLD only?",
        'answer': 'In scope.',
        'answered_by': '@cdomotor-g',
        'answered_on': '2026-08-15',
        'effect': "All four stay `ingest`: 41 blocks and 31 inspection rows, same form "
                  "family and same crews as the QLD sheets.",
    },
]


def write(result, directory=HERE):
    for name in ARTEFACTS:
        with open(os.path.join(directory, name), 'w', encoding='utf-8') as fh:
            fh.write(payload(result, name))


def check(result, directory=HERE):
    drift = []
    for name in ARTEFACTS:
        path = os.path.join(directory, name)
        if not os.path.exists(path):
            drift.append(f'{name}: missing')
            continue
        with open(path, encoding='utf-8') as fh:
            if fh.read() != payload(result, name):
                drift.append(f'{name}: differs from a fresh survey of the workbook')
    return drift


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true',
                    help='re-run the survey and fail if the checked-in artefacts differ')
    args = ap.parse_args()

    result = survey()
    if args.check:
        drift = check(result)
        if drift:
            print('The checked-in survey artefacts no longer match the workbook:')
            for line in drift:
                print(f'  - {line}')
            print('\nRun `python3 tools/ingest/survey.py` and commit the result.')
            return 1
        print(f'survey artefacts match the workbook '
              f'({result["counts"]["blocks"]} blocks, '
              f'{result["counts"]["inspection_rows"]} inspection rows)')
        return 0

    write(result)
    counts = result['counts']
    print(f'{counts["sheets"]} sheets ({counts["visible"]} visible, {counts["hidden"]} hidden)')
    print(f'{counts["blocks"]} station blocks, {counts["inspection_rows"]} inspection rows')
    print(f'{counts["distinct_header_labels"]} distinct header labels, '
          f'{counts["distinct_layouts"]} distinct layouts')
    print(f'{len(result["field_map"]["unmapped"])} labels unmapped')
    for name in ARTEFACTS:
        print(f'  wrote tools/ingest/{name}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
