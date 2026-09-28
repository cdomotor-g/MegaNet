#!/usr/bin/env python3
"""
sls.py — read the Bureau's Service Level Specifications' station schedules into JSON.

WHAT THIS IS
    The Bureau writes one "Service Level Specification for Flood Forecasting and
    Warning Services" per state, and MegaNet's network reaches two of them:

    QLD  `archive/QLD_SLS_current.pdf` — "... for Queensland", version 3.7,
         dated December 2025, the file the Bureau publishes at
         https://www.bom.gov.au/qld/flood/brochures/QLD_SLS_current.pdf. 154
         pages, ten schedules, six of them tables of stations. Version 3.1
         (September 2018), which this read before, is kept beside it as
         `archive/QLD_SLS_v3.1_2018-09.pdf`.

    NSW  `archive/NSW_SLS_Current.pdf` — "... for New South Wales and the
         Australian Capital Territory", version 3.16, dated December 2025, the
         file the Bureau publishes at https://www.bom.gov.au/nsw/NSW_SLS_Current.pdf
         (byte for byte). 76 pages, and the same six kinds of station table,
         numbered differently.

    Every one of those tables is keyed on the bureau number — which is the same
    number `meganet.station.station_number` carries.

    That makes them the answer to a set of questions MegaNet has never been able
    to ask about a station: what its flood class levels are, whether anybody
    forecasts for it or merely reports it, who owns it, whether a person reads
    it or a radio does, and how much it matters when it stops.

    This reads the station schedules out of each document and writes one file
    of rows per document — `data/sls-qld.json`, `data/sls-nsw.json`, what the
    database loads — and one file the app reads, `data/sls-locations.json`. It
    does not interpret them; that is the loader's job and the app's.

WHICH SCHEDULES, AND WHY THESE SIX
                                                                  QLD   NSW
    Forecast locations and levels of service ..................    2     2
       the flood warning itself: flood class levels, prediction type, target
       warning lead time, trigger height, peak accuracy, priority.
    Information locations with flood class levels .............    3     3a
       reported but not forecast: flood class levels and priority only.
    River data locations ......................................    4     4
       name, owner, gauge, priority.
    Sites owned and maintained by the Bureau ..................    7     6
    Sites the Bureau assists with .............................    8     7
    Sites where the Bureau co-locates .........................    9     8
       ownership, plus what the site measures and what kind of gauge it is.

    Each schedule is filed under its own number and under what it is for — its
    `role`, `forecast_location` down to `bureau_colocated` — because the two
    documents do not number them alike and the roles are what the app and the
    database ask about. NSW's 3a is filed as Schedule 3, which is what the
    document's own text calls it ("refer to Schedule 3"), with "3a" kept as its
    label. Its 3b is the SES's alert thresholds, which name their stations but
    give no number to key them on.

    The rest are facts about the service rather than about a gauge: committee
    membership, base stations, data sharing agreements, product names and the
    document's history.

HOW IT READS THEM

    By the header over each column, and this is the load-bearing decision.
    Every one of these tables is ruled, so pdfplumber recovers the cell grid
    exactly — but the grid is not the same from one page to the next. Version
    3.7's Schedule 2 comes out 17, 18 or 20 columns wide depending on the page,
    and Schedule 8 15 or 18, because a rule that stops short on one page is a
    column boundary on another. Reading a fixed column index, which is how
    version 3.1 was read, would file a Major level as a Moderate one on the
    first page that moved, with nothing to say it happened.

    What does not move is where the headings sit. So each table's header rows
    are read first: a heading cell with another heading under it
    ("Flood classification (m)" over "Minor", "Moderate", "Major") is a group,
    the ones with nothing under them are the columns, and a heading split over
    three lines in one column ("Trigger" / "height" / "(m)") is one heading.
    Every data cell is then filed under the column it sits beneath, by
    position, and a cell under no column raises. Each page's columns are
    checked against what that schedule must have before any row on it is read.
    A table that starts part-way down a schedule with no header of its own
    takes the columns of the table before it. A cell merged across several
    columns — NSW prints one "TBC*" across the lead time, the trigger and the
    accuracy of WARDELL — is the value of each column it covers; a sentence
    merged across the table is kept as the row's `remark`.

    Which schedule a page belongs to: the Queensland document says so in its
    footer, "Schedule 3: Information locations with flood class levels defined
    31", and the contents list the same words with a dot leader before the page
    number, which is what tells the two apart. The New South Wales document has
    no such footer: a schedule opens with its heading in bold,
    "Schedule 3a: Information locations with flood classification levels
    defined", and runs until the next one, and its contents list the same words
    in the body face.

    The catchment is a row, not a column. Each schedule is grouped under
    subheadings that read "130 – Fitzroy" — the AWRC basin number and its name,
    which is exactly `meganet.catchment.basin_no`. A subheading sets the
    catchment for every row under it until the next one, and "(continued)" at
    the top of a page repeats it. A row that is one cell across the table is a
    heading and never a field: one whose number is not three digits (3.1 prints
    "40 – Noosa" for basin 140, the NSW document "1102 – Lake Bancannia") keeps
    its name, files no basin number, and says so on every row under it; one
    that is not a catchment at all raises.

    A row can be printed as two lines, ruled off under some of its columns.
    Three Schedule 2 rows in the Queensland 3.7 do it to give a station two
    targets — PALMVIEW is forecast 6 hours ahead of a peak over 4.5 m to
    ±0.1 m, and 18 hours ahead of the river passing 4.5 m to ±0.3 m. Text never
    wraps across a rule, so the second line is always a second value: it joins
    the first with " / ", in order, and the card pairs them back up. The NSW
    document gives 28 stations a second target (WAGGA WAGGA a third) the other
    way, as a second line inside the lead time and trigger cells; a cell whose
    every line is a lead time, or a trigger, is that many targets and is joined
    the same way. Any other line break inside a cell is a long name wrapped —
    except in the owner column, where NSW stacks a station's two owners the
    same way ("Tweed Shire Council" over "NSW DCCEEW"): a line the document
    prints elsewhere as a whole owner starts a second owner, joined " / " as
    the document writes two owners inline, and any other line ("Council",
    "and Climate Action") is the owner above it wrapped.

    A value in a column with a closed vocabulary — gauge type, gauge datum,
    priority, data type — or a flood class level that is not a number is not
    guessed into place: it is left out of the field and the row says what the
    document had (`source_note`), as does a bureau number printed without its
    leading zero or with a stray letter in front of it, and a station a
    schedule lists twice with different values (the first kept as printed). The
    NSW document prints numbers without their leading zero as a matter of course
    in four of its six station schedules, so there it is padded and not noted.
    Where a document defines what a mark means, the mark is read as that and
    not as an irregularity: NSW's "n/a" in a flood class column is a level the
    NSW SES has not yet defined (`classes_undefined`), in the AWRC column a
    number never allocated, and "-" for an owner is none stated; "^" after a
    name is a small catchment with a faster response (`fast_response`), "*"
    after a TBC an interim service with no determined lead time
    (`interim_service`).

    Two things only the NSW document does. Schedules 6 and 8 list a site once
    for each thing it measures — CHINDERAH once for River and once for
    Rainfall — so those rows are folded into one per site, the data types
    joined as the Queensland document prints them ("Rainfall/River"), the
    highest priority kept (a site that is High to lose is High to lose) and each
    type's own priority kept beside it where they differ. And some rows have no
    bureau number: ORANGE, COOTAMUNDRA and STOCKINBINGAL are forecast from
    rainfall with no gauge at all ("n/a"), and three river data sites are
    "External". They cannot be keyed, so they are not locations; each
    schedule's file keeps them as `unkeyed`, as the page printed them. Schedule
    7 reads NIL, and its file says so (`nil`).

    Version 3.1 of the Queensland document goes through this reader too, and
    comes out as the reader before this one — which read fixed column indices —
    had it, field for field on every row, except where that one lost something:
    the 70% peak accuracy of all 219 Schedule 2 rows, the nine rows whose bureau
    number is printed without its leading zero, and the two Noosa rows it had
    filed under Maroochy for want of reading "40 – Noosa" as a heading.

USAGE
    python3 tools/ingest/sls.py                    # rewrite the three files in data/
    python3 tools/ingest/sls.py --check            # fail if any would change
    python3 tools/ingest/sls.py --report           # what came out, in prose

    # one document — an earlier edition, say — somewhere other than data/; which
    # state it is for is read off its own title
    python3 tools/ingest/sls.py --pdf archive/QLD_SLS_v3.1_2018-09.pdf \
        --out /tmp/sls-3.1.json --out-locations /tmp/sls-3.1-locations.json

REQUIREMENTS
    pdfplumber. The only tool in this directory that needs a package, and it is
    a one-off: a PDF is read once per SLS revision and the JSON is committed.
"""

import argparse
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# The browser gets the merged half on its own, both documents in the one file.
# The Queensland rows file alone is 1.4 MB and half of that is the
# per-schedule rows, which only the database loader reads — app.js has no use
# for knowing that GOONDIWINDI is in Schedule 2 *and* Schedule 8, only for what
# the two of them say together. Like the wind regions (650 KB) and the basins
# (744 KB) it is fetched when something asks rather than at page load.
OUT_LOCATIONS = os.path.join(REPO, "data", "sls-locations.json")

# ── The schedules, and the columns each must have ────────────────────────────
# Keyed by the label the document prints. `fields` is exactly the set of
# columns the schedule's header must yield, and it is checked on every page
# before a row on that page is read. A schedule of the sites the Bureau owns
# has no owner column, because the Bureau owns all of it.
QLD_SCHEDULES = {
    "2": {
        "title": "Forecast locations and levels of service",
        "role": "forecast_location",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "class_minor",
                   "class_moderate", "class_major", "prediction_type", "lead_time",
                   "trigger", "peak_accuracy", "priority"},
    },
    "3": {
        "title": "Information locations with flood class levels defined",
        "role": "information_location",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "class_minor",
                   "class_moderate", "class_major", "priority"},
    },
    "4": {
        "title": "River data locations",
        "role": "river_data_location",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "priority"},
    },
    "7": {
        "title": "Sites owned and maintained by the Bureau",
        "role": "bureau_owned",
        "fields": {"bureau_number", "name", "gauge_type", "data_type", "priority"},
        "owner_implied": "Bureau",
    },
    "8": {
        "title": "Sites where the Bureau assists other agencies with maintenance",
        "role": "bureau_assists",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "data_type", "priority"},
    },
    "9": {
        "title": "Sites where the Bureau co-locates equipment and the site is owned by another agency",
        "role": "bureau_colocated",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "data_type", "priority"},
    },
}

# The same six, as the New South Wales document has them: an AWRC number and
# the gauge's datum beside every forecast, information and river data location,
# and the Bureau's own sites listed once per thing they measure.
NSW_SCHEDULES = {
    "2": {
        "title": "Forecast locations and levels of service",
        "role": "forecast_location",
        "fields": {"bureau_number", "awrc_number", "name", "owner", "gauge_type",
                   "gauge_datum", "class_minor", "class_moderate", "class_major",
                   "prediction_type", "lead_time", "trigger", "peak_accuracy", "priority"},
    },
    "3a": {
        "number": 3,
        "title": "Information locations with flood classification levels defined",
        "role": "information_location",
        "fields": {"bureau_number", "awrc_number", "name", "owner", "gauge_type",
                   "gauge_datum", "class_minor", "class_moderate", "class_major", "priority"},
    },
    "4": {
        "title": "River data locations",
        "role": "river_data_location",
        "fields": {"bureau_number", "awrc_number", "name", "owner", "gauge_type",
                   "gauge_datum", "priority"},
    },
    "6": {
        "title": "Sites owned and maintained by the Bureau",
        "role": "bureau_owned",
        "fields": {"bureau_number", "name", "gauge_type", "data_type", "priority"},
        "owner_implied": "Bureau of Meteorology",
        "row_per_data_type": True,
    },
    "7": {
        "title": "Sites where the Bureau assists other agencies with maintenance",
        "role": "bureau_assists",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "data_type", "priority"},
        "may_be_nil": True,
    },
    "8": {
        "title": "Sites where the Bureau co-locates equipment and the site is owned by another agency",
        "role": "bureau_colocated",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "data_type", "priority"},
        "row_per_data_type": True,
    },
}

# One entry per document. `locate` is how a page is known to be part of a
# schedule (above). The rest are what each document defines for itself, from
# the notes under its own tables — a mark read as what the document says it
# means rather than noted as an irregularity.
DOCUMENTS = {
    "QLD": {
        "pdf": os.path.join(REPO, "archive", "QLD_SLS_current.pdf"),
        "out": os.path.join(REPO, "data", "sls-qld.json"),
        "place": "Queensland",
        "url": "https://www.bom.gov.au/qld/flood/brochures/QLD_SLS_current.pdf",
        "locate": "footer",
        "schedules": QLD_SCHEDULES,
    },
    "NSW": {
        "pdf": os.path.join(REPO, "archive", "NSW_SLS_Current.pdf"),
        "out": os.path.join(REPO, "data", "sls-nsw.json"),
        "place": "New South Wales and the Australian Capital Territory",
        "url": "https://www.bom.gov.au/nsw/NSW_SLS_Current.pdf",
        "locate": "heading",
        "schedules": NSW_SCHEDULES,
        # "n/a: Refers to stations flood classifications have not yet been
        # defined by the NSW SES." (Schedule 2's notes; 3a's say the same.)
        "classes_not_defined": {"n/a"},
        # Four of its six station schedules print a number that starts with a
        # zero without it (58186 for 058186), and Schedule 4 with it: the
        # document's own habit, not an irregularity on any one row. Padded,
        # as every number is, so that one site is one key in every schedule.
        "prints_unpadded": True,
        # A dash where an owner goes: nobody is named. "n/a" where a priority
        # or an accuracy goes, on a forecast from rainfall: none applies.
        "blank": {"-", "n/a"},
        # "External: Refers to a station which does not currently have a station
        # number" (Schedule 4); "n/a" where a forecast has no gauge (Schedule 2).
        "unkeyed": {"n/a", "external"},
        # "^ Indicates locations where forecasts are provided for small
        # catchments with faster with response times."
        "name_marks": {"^": "fast_response"},
        # "* Indicates this forecast location is running on an interim service
        # ... There is no determined lead time for this forecast location".
        "value_marks": {"*": "interim_service"},
    },
}

ROLES = ("forecast_location", "information_location", "river_data_location",
         "bureau_owned", "bureau_assists", "bureau_colocated")

# A column heading, lower-cased, and the field it is. First match wins, so the
# order matters where one heading could read as two ("Station owner" is an
# owner, not a station name; "Gauge datum" is not a gauge type).
HEADINGS = [
    ("bureau_number",   lambda s: s.startswith("bureau")),
    ("awrc_number",     lambda s: s.startswith("awrc")),
    ("owner",           lambda s: "owner" in s),
    ("name",            lambda s: s.startswith("forecast location") or s.startswith("station")),
    ("gauge_datum",     lambda s: s.startswith("gauge datum")),
    ("gauge_type",      lambda s: s.startswith("gauge")),
    ("class_minor",     lambda s: s == "minor"),
    ("class_moderate",  lambda s: s == "moderate"),
    ("class_major",     lambda s: s == "major"),
    ("prediction_type", lambda s: s.startswith("prediction")),
    ("lead_time",       lambda s: s.startswith("time")),
    ("trigger",         lambda s: s.startswith("trigger")),
    ("peak_accuracy",   lambda s: s.startswith("70%")),
    ("priority",        lambda s: s == "priority"),
    ("data_type",       lambda s: s.startswith("data")),
]

# "146 – South Coast (Nerang)", "130 Fitzroy", either dash, "(continued)" or not.
CATCHMENT_RE = re.compile(
    r"^\s*(\d{3})\s*[–—-]\s*(.+?)\s*(?:\(continued\))?\s*$", re.I)
# The same heading with the number the wrong length. Version 3.1 prints
# "40 – Noosa" over the Noosa rows (basin 140), and the NSW document
# "1102 – Lake Bancannia" and "1004 – Lake Frome"; only a row that spans the
# table is taken for a heading on that looser reading.
SUBHEADING_RE = re.compile(
    r"^\s*(\d{1,4})\s*[–—-]\s*(\D.*?)\s*(?:\(continued\))?\s*$", re.I)
BUREAU_RE = re.compile(r"^\d{6}$")
# The bureau number column, as the page may print it: once in this edition
# without its leading zero (27015 for 027015). Padded back, and said so.
BUREAU_CELL_RE = re.compile(r"^\d{4,6}$")
# …or with a stray letter in front of it: the NSW document's "n558037".
STRAY_LETTER_RE = re.compile(r"^[A-Za-z](\d{6})$")
# A page's footer: the schedule, its title and the page's printed number. The
# contents list the same words, but with a dot leader before the number, and
# that is what tells the two apart. (Version 3.7 prints the physical page
# number; 3.1 counts from the end of its roman-numbered front matter.)
FOOTER_RE = re.compile(r"^Schedule (\d+): (?!.*\.{4}).*\S\s+\d+$")
# A schedule's heading, where the document opens each with one: "Schedule 3a:
# Information locations …", set in bold, where the contents set it in the body
# face (and end it with a dot leader).
HEADING_RE = re.compile(r"^Schedule (\d+[a-z]?)\s*:\s*(?!.*\.{4})\S")
# The lines of one cell that are each a whole lead time, or a whole trigger: a
# cell holding two of them holds two targets.
LEAD_LINE_RE = re.compile(r"^\d+(?:\.\d+)?\s*(?:hours?|hrs?|days?)$", re.I)
TRIGGER_LINE_RE = re.compile(r"^[<>≥≤]\s*\d+(?:\.\d+)?\s*m?$")
STACKABLE = {"lead_time": LEAD_LINE_RE, "trigger": TRIGGER_LINE_RE}
# Words stamped on every page that are not the document's title.
MARKINGS = {"OFFICIAL", "OFFICIAL: SENSITIVE", "UNCLASSIFIED"}


class ParseError(Exception):
    pass


def clean(cell):
    """One cell, as a string with its line breaks and runs of space closed up."""
    if cell is None:
        return ""
    return " ".join(str(cell).split())


def as_number(text):
    """A flood class level, or None. The document writes plain decimals; a cell
    that holds anything else (a dash, a note, an empty string) is not a level
    and is not guessed at."""
    t = clean(text)
    if not t:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def lead_time_hours(text):
    """"6 hours", "12 hrs", "1 day", "36 hrs" -> hours as a number, or None.

    Kept beside the text rather than replacing it: the document's own wording is
    what a person recognises, and the number is what a query can order by."""
    t = clean(text).lower()
    if not t:
        return None
    m = re.match(r"^([\d.]+)\s*(hour|hr|day)", t)
    if not m:
        return None
    n = float(m.group(1))
    return n * 24 if m.group(2) == "day" else n


GAUGE_TYPES = {"automatic": "Automatic", "manual": "Manual"}
PRIORITIES = {"high": "High", "medium": "Medium", "low": "Low"}
# The gauge's datum: AHD, or a local datum ("All levels are in metres to Local
# gauge datums unless indicated otherwise").
DATUMS = {"ahd": "AHD", "local": "Local"}
# "Rainfall", "River", "Rainfall/River", "Rainfall/Repeater", "Rainfall/River/Repeater"
DATA_TYPES = ("rainfall", "river", "repeater", "storage", "tide", "weather")
DATA_TYPE_RE = re.compile(
    r"^(rainfall|river|repeater|storage|tide|weather)"
    r"(\s*/\s*(rainfall|river|repeater|storage|tide|weather))*$", re.I)


def schedule_of(page):
    """Which schedule a page is part of, from its footer, or None."""
    lines = [l.strip() for l in (page.extract_text() or "").split("\n") if l.strip()]
    for line in reversed(lines[-4:]):
        m = FOOTER_RE.match(line)
        if m:
            return m.group(1)
    return None


def headings_on(page):
    """The schedule headings a page opens, top to bottom: [(top, label), ...]."""
    out = []
    for line in page.extract_text_lines():
        text = line["text"].strip()
        m = HEADING_RE.match(text)
        if m and line["chars"] and "bold" in line["chars"][0]["fontname"].lower():
            out.append((line["top"], m.group(1)))
    return out


def placed_tables(page, locate, current):
    """The page's tables, each with the label of the schedule it belongs to,
    and the schedule still open at the foot of the page."""
    tables = page.find_tables()
    if locate == "footer":
        label = schedule_of(page)
        return [(t, label) for t in tables], label, ({label} if label else set())
    heads = headings_on(page)
    placed = []
    for t in tables:
        above = [label for top, label in heads if top < t.bbox[1]]
        placed.append((t, above[-1] if above else current))
    at_foot = heads[-1][1] if heads else current
    return placed, at_foot, {label for _, label in placed if label}


def boxed_rows(table):
    """Each table row as its non-empty cells, [(x0, x1, text, lines), ...], in
    order — the text closed up, and its lines kept for the columns where a line
    break is a second value rather than a long one wrapped."""
    texts = table.extract()
    out = []
    for r, row in enumerate(table.rows):
        cells = []
        for c, box in enumerate(row.cells):
            if box is None or c >= len(texts[r]):
                continue
            t = clean(texts[r][c])
            if t:
                lines = [clean(l) for l in str(texts[r][c]).split("\n") if clean(l)]
                cells.append((box[0], box[2], t, lines))
        out.append(cells)
    return out


def spans_table(cells, width):
    """One cell, across more than half the table: a heading, never a field."""
    return len(cells) == 1 and cells[0][1] - cells[0][0] > width / 2


def catchment_of(cells, width):
    """The catchment a subheading row names, or None if the row is not one."""
    if not cells or BUREAU_CELL_RE.match(cells[0][2]):
        return None
    joined = " ".join(c[2] for c in cells)
    m = CATCHMENT_RE.match(joined)
    if m:
        return {"basin_no": m.group(1), "name": m.group(2)}
    m = SUBHEADING_RE.match(joined) if spans_table(cells, width) else None
    if m:
        # Not a basin number, so not filed as one and not guessed at: the name
        # is kept, and every row under it says what the heading said.
        return {"basin_no": None, "name": m.group(2), "printed": joined}
    return None


def starts_row(cells, width, doc):
    """Whether a table row is a station, a catchment, or a schedule's NIL —
    the first of which ends the table's header."""
    first = cells[0][2]
    return bool(BUREAU_CELL_RE.match(first) or STRAY_LETTER_RE.match(first)
                or first.lower() in doc.get("unkeyed", ()) or first.upper() == "NIL"
                or catchment_of(cells, width))


def columns_of(header):
    """The header rows as columns: [(x0, x1, field), ...], left to right.

    A heading cell with another heading centred under it is a group, not a
    column; the cells of one column across several header rows are one heading
    read top to bottom."""
    groups = {}
    for cells in header:
        for x0, x1, text, _ in cells:
            groups.setdefault((round(x0), round(x1)), []).append(text)
    cols = []
    for (a, b), texts in groups.items():
        if any(k != (a, b) and (k[1] - k[0]) < (b - a) and a - 1 <= (k[0] + k[1]) / 2 <= b + 1
               for k in groups):
            continue
        label = " ".join(texts).lower()
        field = next((f for f, test in HEADINGS if test(label)), None)
        if field is None:
            raise ParseError(f"a column headed {' '.join(texts)!r} is not one this reader knows")
        cols.append((a, b, field))
    return sorted(cols)


def fields_at(cols, x0, x1, where):
    """The columns a cell is filed under: the one its centre falls in — or, for
    a cell merged across several, every column whose centre it covers."""
    covered = [c for c in cols if x0 - 2 <= (c[0] + c[1]) / 2 <= x1 + 2]
    if len(covered) > 1:
        return [c[2] for c in covered]
    mid = (x0 + x1) / 2
    hits = [c for c in cols if c[0] - 2 <= mid <= c[1] + 2]
    if len(hits) != 1:
        raise ParseError(f"{where}: a cell at {x0:.0f}–{x1:.0f} is under "
                         f"{len(hits)} columns — {[c[2] for c in hits]}")
    return [hits[0][2]]


def cell_value(field, text, lines):
    """A cell's value for its column, and how many further targets it stacks.

    A line break inside a cell is a long value wrapped — except where every
    line is a whole lead time, or a whole trigger: then the cell is that many
    targets, and they are joined " / " as a second ruled line is."""
    pattern = STACKABLE.get(field)
    if pattern and len(lines) > 1 and all(pattern.match(l) for l in lines):
        return " / ".join(lines), len(lines) - 1
    return text, 0


def read_schedules(pdf, doc):
    """Every data row of the station schedules, with the catchment it sits
    under; the rows with no bureau number; and the schedules that read NIL."""
    specs = doc["schedules"]
    out = {label: [] for label in specs}
    unkeyed = {label: [] for label in specs}
    pages = {label: [] for label in specs}
    nil = set()
    stats = {"stacked": 0, "spread": 0}
    catchment = {label: None for label in specs}
    cols_before = {label: None for label in specs}
    current = None
    for page in pdf.pages:
        placed, current, on_page = placed_tables(page, doc["locate"], current)
        for label in sorted(on_page):
            if label in specs:
                pages[label].append(page.page_number)
        for table, label in placed:
            if label not in specs:
                continue
            spec = specs[label]
            number = int(spec.get("number", label))
            rows = boxed_rows(table)
            width = table.bbox[2] - table.bbox[0]
            first = next((i for i, cells in enumerate(rows)
                          if cells and starts_row(cells, width, doc)), None)
            if first is None:
                continue                  # the column definitions block, a note
            where = f"schedule {label}, page {page.page_number}"
            header = [cells for cells in rows[:first] if cells]
            if header:
                cols = columns_of(header)
            elif cols_before[label]:
                cols = cols_before[label]
            else:
                raise ParseError(f"{where}: a table with no header and none before it")
            got = {c[2] for c in cols}
            if got != spec["fields"]:
                raise ParseError(f"{where}: the columns are {sorted(got)}, the schedule's are "
                                 f"{sorted(spec['fields'])}")
            cols_before[label] = cols
            prev = None
            for cells in rows[first:]:
                if not cells:
                    continue
                heading = catchment_of(cells, width)
                if heading:
                    catchment[label] = heading
                    continue
                if spans_table(cells, width):
                    # Read as the rest of the row above, its text would land in
                    # whichever column its middle happens to be over.
                    raise ParseError(f"{where}: {cells[0][2]!r} spans the table and is "
                                     f"not a catchment heading this reader recognises")
                if all(c[2].upper() == "NIL" for c in cells):
                    # The schedule saying, in every column, that it lists nothing.
                    if not spec.get("may_be_nil"):
                        raise ParseError(f"{where}: NIL, in a schedule that must list stations")
                    nil.add(label)
                    continue
                fields, stacked_here = {}, 0
                for x0, x1, text, lines in cells:
                    fs = fields_at(cols, x0, x1, where)
                    if len(fs) > 1 and len(text.split()) > 2:
                        # A sentence across the table ("No specific forecast
                        # location exists – forecast based on …") is about the
                        # row, not a value of every column it happens to cover.
                        fields["remark"] = f"{fields['remark']} {text}" if "remark" in fields else text
                        continue
                    if len(fs) > 1:
                        stats["spread"] += 1
                    for f in fs:
                        value, stacked = cell_value(f, text, lines)
                        stacked_here = max(stacked_here, stacked)
                        if f == "owner" and len(lines) > 1:
                            fields["_owner_lines"] = lines
                        fields[f] = f"{fields[f]} {value}" if f in fields else value
                stats["stacked"] += stacked_here
                printed = fields.get("bureau_number", "")
                bureau, padded, stray = printed, None, None
                m = STRAY_LETTER_RE.match(bureau)
                if m:
                    stray, bureau = bureau, m.group(1)
                if BUREAU_CELL_RE.match(bureau) and not BUREAU_RE.match(bureau):
                    padded, bureau = bureau, bureau.zfill(6)
                if not BUREAU_RE.match(bureau) and bureau.lower() in doc.get("unkeyed", ()):
                    # No number to key it on: kept as the page printed it, and
                    # not a location.
                    if catchment[label] is None:
                        raise ParseError(f"{where}: {printed!r} is before any catchment")
                    row = {"printed_number": printed, "schedule": number,
                           "catchment_name": catchment[label]["name"]}
                    if catchment[label]["basin_no"]:
                        row["basin_no"] = catchment[label]["basin_no"]
                    row.update((f, v) for f, v in fields.items() if f != "bureau_number")
                    unkeyed[label].append(row)
                    prev = row
                    continue
                if not BUREAU_RE.match(bureau):
                    if bureau or prev is None:
                        raise ParseError(f"{where}: {' | '.join(c[2] for c in cells)!r} "
                                         f"is not a station, a catchment or the rest of one")
                    # A second line of the row above, ruled off under some of
                    # its columns: a second target for the same station. PALMVIEW
                    # is forecast 6 hours ahead of a peak over 4.5 m to ±0.1 m and
                    # 18 hours ahead of it passing 4.5 m to ±0.3 m, printed as two
                    # lines of one row. Wrapped text stays inside its cell in a
                    # ruled table, so this is never the end of a word; " / " keeps
                    # the two values apart and in order, which is what lets a
                    # reader pair each lead time with its own trigger.
                    for f, text in fields.items():
                        if f.startswith("_"):
                            continue
                        prev[f] = f"{prev[f]} / {text}" if prev.get(f) else text
                    stats["stacked"] += 1
                    continue
                if catchment[label] is None:
                    raise ParseError(f"{where}: {bureau} is before any catchment")
                row = {"bureau_number": bureau, "schedule": number,
                       "catchment_name": catchment[label]["name"]}
                if catchment[label]["basin_no"]:
                    row["basin_no"] = catchment[label]["basin_no"]
                else:
                    row["_printed_heading"] = catchment[label]["printed"]
                row.update((f, v) for f, v in fields.items() if f != "bureau_number")
                if padded:
                    row["_printed_number"] = padded
                if stray:
                    row["_stray_number"] = stray
                out[label].append(row)
                prev = row
    return out, unkeyed, pages, nil, stats


def resolve_owners(rows):
    """An owner cell of more than one line, as one owner or several.

    The NSW document stacks a station's two owners as two lines of one cell,
    and wraps a long owner onto a second line the same way. A line the document
    prints somewhere as an owner cell of its own ("NSW DCCEEW", "WaterNSW")
    starts a second owner; any other ("Council", "Regional Council", "and
    Climate Action") is the owner above it wrapped. Two owners are joined " / ",
    as the document writes them when it has the room."""
    whole = {r["owner"] for r in rows if r.get("owner") and "_owner_lines" not in r}
    for r in rows:
        lines = r.pop("_owner_lines", None)
        if not lines:
            continue
        owners = [lines[0]]
        for line in lines[1:]:
            if line in whole:
                owners.append(line)
            else:
                owners[-1] = f"{owners[-1]} {line}"
        r["owner"] = " / ".join(owners)


def tidy(row, spec, doc):
    """One row as the JSON carries it: numbers as numbers, vocabularies checked.

    What the page printed that is not a value of its column is left out of the
    field, and `source_note` says what it was — one clause per oddity, joined
    with semicolons, each of which reads on its own on the station card."""
    notes = []
    for f in ("class_minor", "class_moderate", "class_major"):
        if f in row:
            v = as_number(row[f])
            if v is not None:
                row[f] = v
            elif row[f].lower() in doc.get("classes_not_defined", ()):
                # Not an irregularity: the document says what it means.
                row.setdefault("classes_undefined", []).append(f.split("_")[1])
                del row[f]
            else:
                notes.append(f"the {f.split('_')[1]} level reads {row[f]!r}")
                del row[f]
    for f in [f for f in row if f != "printed_number" and isinstance(row[f], str)
              and row[f].lower() in doc.get("blank", ())]:
        del row[f]
    for f, vocab in (("gauge_type", GAUGE_TYPES), ("priority", PRIORITIES)):
        if f in row:
            # "High / High": a row printed as two lines states its priority on
            # each, and HALIFAX's cell holds the word twice over. A word said
            # twice is still that word; two different words are not one.
            words = set(re.split(r"[\s/]+", row[f].lower())) - {""}
            v = vocab.get(words.pop()) if len(words) == 1 else None
            if v is None:
                notes.append(f"the {f.replace('_', ' ')} reads {row[f]!r}")
                del row[f]
            else:
                row[f] = v
    if "data_type" in row and not DATA_TYPE_RE.match(row["data_type"]):
        notes.append(f"the data type reads {row['data_type']!r}")
        del row["data_type"]
    if "gauge_datum" in row:
        v = DATUMS.get(row["gauge_datum"].lower())
        if v is None:
            notes.append(f"the gauge datum reads {row['gauge_datum']!r}")
            del row["gauge_datum"]
        else:
            row["gauge_datum"] = v
    for mark, flag in doc.get("value_marks", {}).items():
        for f in ("prediction_type", "lead_time", "trigger", "peak_accuracy"):
            if row.get(f, "").endswith(mark):
                row[f] = row[f][:-len(mark)].rstrip()
                row[flag] = True
    if "lead_time" in row:
        # The first target's, where a row has two: the number is for ordering.
        h = lead_time_hours(row["lead_time"].split(" / ")[0])
        if h is not None:
            row["lead_time_hours"] = h
    if "owner" not in row and spec.get("owner_implied"):
        row["owner"] = spec["owner_implied"]
    # A trailing asterisk marks a footnote on the page, not part of the name.
    # Recorded so the name still matches, and flagged so nobody wonders where
    # it went. A mark the document defines is also read as what it means.
    marks = {"*": None, **doc.get("name_marks", {})}
    for mark, flag in marks.items():
        if row.get("name", "").endswith(mark):
            row["name"] = row["name"].rstrip(mark).strip()
            row["footnoted"] = True
            if flag:
                row[flag] = True
    printed = row.pop("_printed_number", None)
    if printed and not doc.get("prints_unpadded"):
        notes.append(f"the bureau number is printed {printed}, without its leading zero")
    stray = row.pop("_stray_number", None)
    if stray:
        notes.append(f"the bureau number is printed {stray}")
    heading = row.pop("_printed_heading", None)
    if heading:
        notes.append(f"the catchment heading reads {heading!r}, "
                     f"with no three-digit basin number")
    if notes:
        row["source_note"] = "; ".join(notes)
    return row


PRIORITY_RANK = {"low": 1, "medium": 2, "high": 3}


def fold_data_types(rows):
    """One row per site where a schedule lists a site once per thing it measures.

    The NSW document's Schedules 6 and 8 print CHINDERAH once for River and once
    for Rainfall; the Queensland document prints the same fact once, as
    "Rainfall/River". Rows for one number that differ only in their data type
    and priority are folded into one: the types joined in the order the
    Queensland document writes them, the highest priority kept — a site that is
    High to lose for its river gauge is High to lose — and, where the types'
    priorities differ, each kept beside it (`priority_by_data_type`). Rows that
    differ in anything else are a disagreement, and are left to dedupe()."""
    groups = {}
    for r in rows:
        groups.setdefault(r["bureau_number"], []).append(r)
    out, folded = [], 0
    for r in rows:
        group = groups.pop(r["bureau_number"], None)
        if group is None:
            continue
        rest = [{k: v for k, v in g.items() if k not in ("data_type", "priority")} for g in group]
        types = [g.get("data_type") for g in group]
        if (len(group) == 1 or any(x != rest[0] for x in rest) or None in types
                or any("/" in t for t in types) or len({t.lower() for t in types}) != len(types)):
            out.extend(group)
            continue
        one = dict(rest[0])
        one["data_type"] = "/".join(sorted((t.capitalize() for t in types),
                                           key=lambda t: DATA_TYPES.index(t.lower())))
        ranked = [g["priority"] for g in group if g.get("priority")]
        if ranked:
            one["priority"] = max(ranked, key=lambda p: PRIORITY_RANK[p.lower()])
        if len(set(ranked)) > 1:
            one["priority_by_data_type"] = {g["data_type"].capitalize(): g["priority"]
                                            for g in group if g.get("priority")}
        out.append(one)
        folded += len(group) - 1
    return out, folded


def dedupe(rows, number):
    """One row per station per schedule, which is the database's key.

    An identical row printed twice is dropped. Two different rows for one
    station in one schedule are a disagreement in the document itself: the
    first is kept as printed, and what the second says is written onto it
    (`source_note`), so the disagreement is on the record rather than resolved
    by whichever row happened to come last."""
    seen, unique, dropped, differing = {}, [], 0, 0
    for r in rows:
        have = seen.get(r["bureau_number"])
        if have is None:
            seen[r["bureau_number"]] = r
            unique.append(r)
            continue
        dropped += 1
        if have == r:
            continue
        differing += 1
        other = ", ".join(f"{f.replace('_', ' ')} {r[f]}" for f in r
                          if f not in ("schedule", "bureau_number") and r.get(f) != have.get(f))
        note = f"the schedule lists this number a second time, with {other}"
        have["source_note"] = f"{have['source_note']}; {note}" if have.get("source_note") else note
    return unique, dropped, differing


# The merge rule, in one place. `meganet.sls_location` is the same rule in SQL,
# and db/README.md states it once for both:
#
#   the lowest-numbered schedule that states a field wins — because the
#   schedules run from the most specific statement of service (2: forecast
#   locations) to the most general inventory (what the Bureau owns), so the
#   earlier one is making a claim about the flood-warning service rather than
#   about a site register;
#
#   except priority, where the highest stated anywhere wins — because priority
#   measures the impact of losing a site, and a site that is High to any part of
#   the service is High to lose. Letting a "Low" in a site register overrule a
#   "High" in the forecast schedule is the one direction this field must not
#   move.
#
# Each document is merged on its own: a station both documents list (47, all
# on the Queensland border) is two locations, one per document, because each
# is the Bureau's statement of a different state's service and neither
# overrules the other.
#
# Emitted alongside the raw rows rather than left to the reader, because the app
# reads this file straight off disk — it is a field tool that has to work from
# file:// with no database behind it — and a second implementation of this rule
# in JavaScript would be a second thing to keep in step.
MERGE_FIELDS = ("name", "owner", "gauge_type", "data_type", "basin_no",
                "catchment_name", "awrc_number", "gauge_datum",
                "class_minor", "class_moderate", "class_major", "classes_undefined",
                "prediction_type", "lead_time", "lead_time_hours",
                "trigger", "peak_accuracy", "fast_response", "interim_service",
                "source_note")


def merge_locations(schedules, jurisdiction):
    """One entry per bureau number, the document's schedules folded together."""
    by_number = {}
    roles = {}
    for key in sorted(schedules, key=int):
        roles[int(key)] = schedules[key]["role"]
        for r in schedules[key]["rows"]:
            by_number.setdefault(r["bureau_number"], []).append(r)

    out = []
    for bureau in sorted(by_number):
        rows = sorted(by_number[bureau], key=lambda r: r["schedule"])
        loc = {"bureau_number": bureau, "jurisdiction": jurisdiction,
               "schedules": sorted({r["schedule"] for r in rows})}
        for f in MERGE_FIELDS:
            for r in rows:                      # already in schedule order
                if r.get(f) is not None:
                    loc[f] = r[f]
                    break
        best = max((PRIORITY_RANK.get(str(r.get("priority", "")).lower(), 0)
                    for r in rows), default=0)
        if best:
            loc["priority"] = {1: "Low", 2: "Medium", 3: "High"}[best]
        for sched in loc["schedules"]:
            loc[roles[sched]] = True
        out.append(loc)
    return out


def published(pdf, version):
    """The edition's month and year, from the document's own release history
    ("3.7 December 2025"), or None where it has none. The Queensland 3.7 prints
    its history up front; 3.1 and the NSW document print it in their last
    schedule, the date followed by what changed."""
    if not version:
        return None
    line = re.compile(rf"^{re.escape(version)}\s+([A-Z][a-z]+ \d{{4}})$")
    for page in pdf.pages[:4]:
        for text in (page.extract_text() or "").split("\n"):
            m = line.match(text.strip())
            if m:
                return m.group(1)
    line = re.compile(rf"^{re.escape(version)}\s+([A-Z][a-z]+ \d{{4}})\b")
    for page in pdf.pages:
        text = page.extract_text() or ""
        if "Changes to this Service Level Specification" not in text:
            continue
        for t in text.split("\n"):
            m = line.match(t.strip())
            if m:
                return m.group(1)
    return None


def title_of(first):
    """The document's title as its cover prints it, up to and including the
    version, less the classification stamped on every page."""
    lines = [l.strip() for l in first.split("\n") if l.strip() and l.strip().upper() not in MARKINGS]
    for i, l in enumerate(lines):
        if re.search(r"Version\s+[\d.]+", l):
            return " ".join(lines[:i + 1])
    return " ".join(first.split("\n")[0:4]).strip()[:120]


def jurisdiction_of(title):
    """Which state's service a document specifies, from its own title."""
    for j, spec in DOCUMENTS.items():
        if f"for {spec['place'].split(' and ')[0]}" in title:
            return j
    raise SystemExit(f"error: {title!r} is not a Service Level Specification this reader knows")


def build(pdf_path, jurisdiction=None):
    import pdfplumber
    out = {"meta": {}, "schedules": {}}
    with pdfplumber.open(pdf_path) as pdf:
        first = pdf.pages[0].extract_text() or ""
        title = title_of(first)
        jurisdiction = jurisdiction or jurisdiction_of(title)
        doc = DOCUMENTS[jurisdiction]
        version = re.search(r"Version\s+([\d.]+)", first)
        version = version.group(1) if version else None
        out["meta"] = {
            "source": os.path.basename(pdf_path),
            "title": title,
            "version": version,
            "published": published(pdf, version),
            "generator": "tools/ingest/sls.py",
            "pages": len(pdf.pages),
            "jurisdiction": jurisdiction,
            "place": doc["place"],
            "url": doc["url"],
        }
        try:
            raw, unkeyed, pages, nil, stats = read_schedules(pdf, doc)
        except ParseError as e:
            raise SystemExit(f"error: {jurisdiction}: {e}")
    resolve_owners([r for rows in list(raw.values()) + list(unkeyed.values()) for r in rows])
    dupes = disagreements = folded = 0
    for label, spec in sorted(doc["schedules"].items(), key=lambda kv: int(kv[1].get("number", kv[0]))):
        number = int(spec.get("number", label))
        if not raw[label] and label not in nil:
            raise SystemExit(f"{jurisdiction} schedule {label}: no rows — no page names it")
        rows = [tidy(r, spec, doc) for r in raw[label]]
        if spec.get("row_per_data_type"):
            rows, n = fold_data_types(rows)
            folded += n
        rows, dropped, differing = dedupe(rows, number)
        dupes += dropped - differing
        disagreements += differing
        entry = {"title": spec["title"], "label": label, "role": spec["role"], "rows": rows,
                 "pages": [min(pages[label]), max(pages[label])]}
        if label in nil:
            entry["nil"] = True
        if unkeyed[label]:
            entry["unkeyed"] = [tidy(r, spec, doc) for r in unkeyed[label]]
        out["schedules"][str(number)] = entry
    out["meta"]["identical_rows_dropped"] = dupes
    out["meta"]["differing_rows_noted"] = disagreements
    out["meta"]["stacked_lines_joined"] = stats["stacked"]
    out["meta"]["merged_cells_spread"] = stats["spread"]
    out["meta"]["data_type_rows_folded"] = folded
    out["meta"]["unkeyed_rows"] = sum(len(s.get("unkeyed", [])) for s in out["schedules"].values())
    out["locations"] = merge_locations(out["schedules"], jurisdiction)
    out["meta"]["locations"] = len(out["locations"])
    return out


def render(doc):
    parts = ['{\n"meta": ' + json.dumps(doc["meta"], sort_keys=True) + ',\n"schedules": {\n']
    keys = sorted(doc["schedules"], key=int)
    for i, k in enumerate(keys):
        s = doc["schedules"][k]
        parts.append(f'"{k}": {{\n"title": {json.dumps(s["title"])},\n'
                     f'"label": {json.dumps(s["label"])},\n"role": {json.dumps(s["role"])},\n'
                     f'"pages": {json.dumps(s.get("pages"))},\n')
        if s.get("nil"):
            parts.append('"nil": true,\n')
        parts.append('"rows": [\n')
        parts.append(",\n".join(json.dumps(r, sort_keys=True, separators=(",", ":"))
                                for r in s["rows"]))
        parts.append("\n]")
        if s.get("unkeyed"):
            parts.append(',\n"unkeyed": [\n')
            parts.append(",\n".join(json.dumps(r, sort_keys=True, separators=(",", ":"))
                                    for r in s["unkeyed"]))
            parts.append("\n]")
        parts.append("\n}" + ("," if i < len(keys) - 1 else "") + "\n")
    parts.append("},\n")
    parts.append('"locations": [\n')
    parts.append(",\n".join(json.dumps(l, sort_keys=True, separators=(",", ":"))
                             for l in doc["locations"]))
    parts.append("\n]\n}\n")
    return "".join(parts)


def render_locations(docs):
    """The merged half of every document, in one file, for the app: each
    document's edition under `documents`, and each location naming its
    document (`jurisdiction`)."""
    locs = sorted((l for d in docs.values() for l in d["locations"]),
                  key=lambda l: (l["jurisdiction"], l["bureau_number"]))
    meta = {"generator": "tools/ingest/sls.py", "documents": sorted(docs), "locations": len(locs)}
    return ('{\n"meta": ' + json.dumps(meta, sort_keys=True) + ',\n'
            '"documents": {\n'
            + ",\n".join(f'"{j}": ' + json.dumps(docs[j]["meta"], sort_keys=True)
                         for j in sorted(docs))
            + '\n},\n"locations": [\n'
            + ",\n".join(json.dumps(l, sort_keys=True, separators=(",", ":"))
                          for l in locs)
            + "\n]\n}\n")


def report(doc):
    import collections
    print(f"{doc['meta']['title']}")
    print(f"  version {doc['meta']['version']}, {doc['meta']['published']}, "
          f"{doc['meta']['pages']} pages\n")
    seen = {}
    for k in sorted(doc["schedules"], key=int):
        s = doc["schedules"][k]
        rows = s["rows"]
        gauge = collections.Counter(r.get("gauge_type", "—") for r in rows)
        print(f"  Schedule {s['label']:<3} {len(rows):>4} rows  "
              f"{dict(gauge) if rows else ('NIL' if s.get('nil') else '')}  {s['title'][:44]}")
        for r in rows:
            seen.setdefault(r["bureau_number"], []).append(int(k))
        for u in s.get("unkeyed", []):
            print(f"      no number ({u['printed_number']}): {u.get('name')}")
    print(f"\n  {len(seen)} distinct bureau numbers across all schedules")
    both = [b for b, s in seen.items() if len(s) > 1]
    print(f"  {len(both)} appear in more than one schedule")

    owners = collections.Counter()
    gauges = collections.Counter()
    basins = set()
    for k in doc["schedules"]:
        for r in doc["schedules"][k]["rows"]:
            if r.get("owner"):
                owners[r["owner"]] += 1
            if r.get("gauge_type"):
                gauges[r["gauge_type"]] += 1
            if r.get("basin_no"):
                basins.add((r["basin_no"], r.get("catchment_name")))
    print(f"  gauge types: {dict(gauges)}")
    print(f"  {len(basins)} catchment subheadings")
    print(f"  {len(owners)} distinct station owners; commonest:")
    for o, n in owners.most_common(12):
        print(f"      {n:>5}  {o}")
    notes = [(r["bureau_number"], r["source_note"]) for k in doc["schedules"]
             for r in doc["schedules"][k]["rows"] if r.get("source_note")]
    print(f"  {len(notes)} rows the document is irregular on:")
    for b, n in notes:
        print(f"      {b}  {n}")
    print()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--pdf", help="one document rather than the ones in archive/ — an earlier "
                                  "edition, say; which state's it is is read off its title")
    ap.add_argument("--out", help="with --pdf: where its rows go")
    ap.add_argument("--out-locations", help="where the merged locations go")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args(argv)

    if a.pdf:
        if not a.report and not (a.out and a.out_locations):
            ap.error("--pdf needs --out and --out-locations: it is not what data/ holds")
        one = build(a.pdf)
        docs = {one["meta"]["jurisdiction"]: one}
        outs = {one["meta"]["jurisdiction"]: a.out}
    else:
        docs = {j: build(spec["pdf"], j) for j, spec in DOCUMENTS.items()}
        outs = {j: DOCUMENTS[j]["out"] for j in docs}
    out_locations = a.out_locations or OUT_LOCATIONS
    bodies = {j: render(d) for j, d in docs.items()}
    locs = render_locations(docs)

    if a.report:
        for j in sorted(docs):
            report(docs[j])
        return 0
    if a.check:
        ok = True
        for path, want in [(outs[j], bodies[j]) for j in sorted(docs)] + [(out_locations, locs)]:
            have = open(path, encoding="utf-8").read() if os.path.exists(path) else None
            if have != want:
                print(f"{path}: would change — rerun without --check", file=sys.stderr)
                ok = False
            else:
                print(f"{path}: up to date")
        return 0 if ok else 1

    for j in sorted(docs):
        with open(outs[j], "w", encoding="utf-8") as fh:
            fh.write(bodies[j])
        total = sum(len(s["rows"]) for s in docs[j]["schedules"].values())
        print(f"{outs[j]}: {total} rows across {len(docs[j]['schedules'])} schedules, "
              f"{len(bodies[j]):,} bytes")
        if docs[j]["meta"].get("identical_rows_dropped"):
            print(f"  {docs[j]['meta']['identical_rows_dropped']} identical duplicate row(s) "
                  f"the document lists twice, dropped")
    with open(out_locations, "w", encoding="utf-8") as fh:
        fh.write(locs)
    n = sum(len(d["locations"]) for d in docs.values())
    print(f"{out_locations}: {n} merged locations from {len(docs)} document(s), "
          f"{len(locs):,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
