#!/usr/bin/env python3
"""
sls.py — read the Queensland Service Level Specification's schedules into JSON.

WHAT THIS IS
    `archive/QLD_SLS_current.pdf` is the Bureau's "Service Level Specification
    for Flood Forecasting and Warning Services for Queensland", version 3.7,
    dated December 2025 — the file the Bureau publishes at
    https://www.bom.gov.au/qld/flood/brochures/QLD_SLS_current.pdf. 154 pages,
    ten schedules, and six of those schedules are tables of stations keyed on
    the bureau number — which is the same number `meganet.station.station_number`
    carries. Version 3.1 (September 2018), which this read before, is kept
    beside it as `archive/QLD_SLS_v3.1_2018-09.pdf`.

    That makes it the answer to a set of questions MegaNet has never been able
    to ask about a station: what its flood class levels are, whether anybody
    forecasts for it or merely reports it, who owns it, whether a person reads
    it or a radio does, and how much it matters when it stops.

    This reads the six station schedules out and writes `data/sls-qld.json`.
    It does not interpret them; that is the loader's job and the app's.

WHICH SCHEDULES, AND WHY THESE SIX

    2  Forecast locations and levels of service ....... the flood warning itself:
       flood class levels, prediction type, target warning lead time, trigger
       height, peak accuracy, priority.
    3  Information locations with flood class levels .. reported but not
       forecast: flood class levels and priority only.
    4  River data locations ........................... name, owner, gauge,
                                                         priority.
    7  Sites owned and maintained by the Bureau ....... ownership, plus what the
    8  Sites the Bureau assists with ..................  site measures and what
    9  Sites where the Bureau co-locates .............   kind of gauge it is.

    Schedules 1, 5, 6 and 10 are committee membership, base stations, data
    sharing agreements and product names — facts about the service rather than
    about a gauge.

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
    takes the columns of the table before it.

    Which schedule a page belongs to is read off its footer, "Schedule 3:
    Information locations with flood class levels defined 31". The table of
    contents lists the same words with a dot leader before the page number,
    which is what tells the two apart.

    The catchment is a row, not a column. Each schedule is grouped under
    subheadings that read "130 – Fitzroy" — the AWRC basin number and its name,
    which is exactly `meganet.catchment.basin_no`. A subheading sets the
    catchment for every row under it until the next one, and "(continued)" at
    the top of a page repeats it. A row that is one cell across the table is a
    heading and never a field: one whose number is short (3.1 prints
    "40 – Noosa" for basin 140) keeps its name, files no basin number, and
    says so on every row under it; one that is not a catchment at all raises.

    A row can be printed as two lines, ruled off under some of its columns.
    Three Schedule 2 rows in 3.7 do it to give a station two targets —
    PALMVIEW is forecast 6 hours ahead of a peak over 4.5 m to ±0.1 m, and 18
    hours ahead of the river passing 4.5 m to ±0.3 m. Text never wraps across
    a rule, so the second line is always a second value: it joins the first
    with " / ", in order, and the card pairs them back up.

    A value in a column with a closed vocabulary — gauge type, priority, data
    type — or a flood class level that is not a number is not guessed into
    place: it is left out of the field and the row says what the document had
    (`source_note`), as does a bureau number printed without its leading zero
    and a station a schedule lists twice with different values (the first
    kept as printed).

    Version 3.1 goes through this reader too, and comes out as the reader
    before this one — which read fixed column indices — had it, field for
    field on every row, except where that one lost something: the 70% peak
    accuracy of all 219 Schedule 2 rows, the nine rows whose bureau number is
    printed without its leading zero, and the two Noosa rows it had filed under
    Maroochy for want of reading "40 – Noosa" as a heading.

USAGE
    python3 tools/ingest/sls.py                    # rewrite data/sls-qld.json
    python3 tools/ingest/sls.py --check            # fail if it would change
    python3 tools/ingest/sls.py --report           # what came out, in prose

    # an earlier edition, somewhere other than data/
    python3 tools/ingest/sls.py --pdf archive/QLD_SLS_v3.1_2018-09.pdf \
        --out /tmp/sls-3.1.json --out-locations /tmp/sls-3.1-locations.json

REQUIREMENTS
    pdfplumber. The only tool in this directory that needs a package, and it is
    a one-off: the PDF is read once per SLS revision and the JSON is committed.
"""

import argparse
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PDF_DEFAULT = os.path.join(REPO, "archive", "QLD_SLS_current.pdf")
OUT_DEFAULT = os.path.join(REPO, "data", "sls-qld.json")
# The browser gets the merged half on its own. The full file is 1.4 MB and half
# of that is the per-schedule rows, which only the database loader reads —
# app.js has no use for knowing that GOONDIWINDI is in Schedule 2 *and*
# Schedule 8, only for what the two of them say together. 710 KB is the same
# order as the wind regions (650 KB) and the basins (744 KB), and like both it
# is fetched when something asks rather than at page load.
OUT_LOCATIONS = os.path.join(REPO, "data", "sls-locations.json")

# ── The schedules, and the columns each must have ────────────────────────────
# `fields` is exactly the set of columns the schedule's header must yield, and
# it is checked on every page before a row on that page is read. Schedule 7
# has no owner column, because the Bureau owns all of it.
SCHEDULES = {
    2: {
        "title": "Forecast locations and levels of service",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "class_minor",
                   "class_moderate", "class_major", "prediction_type", "lead_time",
                   "trigger", "peak_accuracy", "priority"},
    },
    3: {
        "title": "Information locations with flood class levels defined",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "class_minor",
                   "class_moderate", "class_major", "priority"},
    },
    4: {
        "title": "River data locations",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "priority"},
    },
    7: {
        "title": "Sites owned and maintained by the Bureau",
        "fields": {"bureau_number", "name", "gauge_type", "data_type", "priority"},
        "owner_implied": "Bureau",
    },
    8: {
        "title": "Sites where the Bureau assists other agencies with maintenance",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "data_type", "priority"},
    },
    9: {
        "title": "Sites where the Bureau co-locates equipment and the site is owned by another agency",
        "fields": {"bureau_number", "name", "owner", "gauge_type", "data_type", "priority"},
    },
}

# A column heading, lower-cased, and the field it is. First match wins, so the
# order matters where one heading could read as two ("Station owner" is an
# owner, not a station name).
HEADINGS = [
    ("bureau_number",   lambda s: s.startswith("bureau")),
    ("owner",           lambda s: "owner" in s),
    ("name",            lambda s: s.startswith("forecast location") or s.startswith("station")),
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
# The same heading with the number short. Version 3.1 prints "40 – Noosa" over
# the Noosa rows (basin 140), and only a row that spans the table is taken for
# a heading on that looser reading.
SUBHEADING_RE = re.compile(
    r"^\s*(\d{1,3})\s*[–—-]\s*(\D.*?)\s*(?:\(continued\))?\s*$", re.I)
BUREAU_RE = re.compile(r"^\d{6}$")
# The bureau number column, as the page may print it: once in this edition
# without its leading zero (27015 for 027015). Padded back, and said so.
BUREAU_CELL_RE = re.compile(r"^\d{4,6}$")
# A page's footer: the schedule, its title and the page's printed number. The
# contents list the same words, but with a dot leader before the number, and
# that is what tells the two apart. (Version 3.7 prints the physical page
# number; 3.1 counts from the end of its roman-numbered front matter.)
FOOTER_RE = re.compile(r"^Schedule (\d+): (?!.*\.{4}).*\S\s+\d+$")


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
# "Rainfall", "River", "Rainfall/River", "Rainfall/Repeater", "Rainfall/River/Repeater"
DATA_TYPE_RE = re.compile(
    r"^(rainfall|river|repeater|storage|tide|weather)"
    r"(\s*/\s*(rainfall|river|repeater|storage|tide|weather))*$", re.I)


def schedule_of(page):
    """Which schedule a page is part of, from its footer, or None."""
    lines = [l.strip() for l in (page.extract_text() or "").split("\n") if l.strip()]
    for line in reversed(lines[-4:]):
        m = FOOTER_RE.match(line)
        if m:
            return int(m.group(1))
    return None


def boxed_rows(table):
    """Each table row as its non-empty cells, [(x0, x1, text), ...], in order."""
    texts = table.extract()
    out = []
    for r, row in enumerate(table.rows):
        cells = []
        for c, box in enumerate(row.cells):
            if box is None or c >= len(texts[r]):
                continue
            t = clean(texts[r][c])
            if t:
                cells.append((box[0], box[2], t))
        out.append(cells)
    return out


def spans_table(cells, width):
    """One cell, across more than half the table: a heading, never a field."""
    return len(cells) == 1 and cells[0][1] - cells[0][0] > width / 2


def catchment_of(cells, width):
    """The catchment a subheading row names, or None if the row is not one."""
    if not cells or BUREAU_CELL_RE.match(cells[0][2]):
        return None
    joined = " ".join(t for _, _, t in cells)
    m = CATCHMENT_RE.match(joined)
    if m:
        return {"basin_no": m.group(1), "name": m.group(2)}
    m = SUBHEADING_RE.match(joined) if spans_table(cells, width) else None
    if m:
        # Not a basin number, so not filed as one and not guessed at: the name
        # is kept, and every row under it says what the heading said.
        return {"basin_no": None, "name": m.group(2), "printed": joined}
    return None


def columns_of(header):
    """The header rows as columns: [(x0, x1, field), ...], left to right.

    A heading cell with another heading centred under it is a group, not a
    column; the cells of one column across several header rows are one heading
    read top to bottom."""
    groups = {}
    for cells in header:
        for x0, x1, text in cells:
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


def field_at(cols, x0, x1, where):
    """The column a cell sits under: the one its centre falls in."""
    mid = (x0 + x1) / 2
    hits = [c for c in cols if c[0] - 2 <= mid <= c[1] + 2]
    if len(hits) != 1:
        raise ParseError(f"{where}: a cell at {x0:.0f}–{x1:.0f} is under "
                         f"{len(hits)} columns — {[c[2] for c in hits]}")
    return hits[0][2]


def read_schedules(pdf):
    """Every data row of the six schedules, with the catchment it sits under."""
    out = {n: [] for n in SCHEDULES}
    pages = {n: [] for n in SCHEDULES}
    stats = {"stacked": 0}
    catchment = {n: None for n in SCHEDULES}
    cols_before = {n: None for n in SCHEDULES}
    for page in pdf.pages:
        number = schedule_of(page)
        if number not in SCHEDULES:
            continue
        spec = SCHEDULES[number]
        pages[number].append(page.page_number)
        for table in page.find_tables():
            rows = boxed_rows(table)
            width = table.bbox[2] - table.bbox[0]
            first = next((i for i, cells in enumerate(rows)
                          if cells and (BUREAU_CELL_RE.match(cells[0][2])
                                        or catchment_of(cells, width))), None)
            if first is None:
                continue                  # the column definitions block, a note
            where = f"schedule {number}, page {page.page_number}"
            header = [cells for cells in rows[:first] if cells]
            if header:
                cols = columns_of(header)
            elif cols_before[number]:
                cols = cols_before[number]
            else:
                raise ParseError(f"{where}: a table with no header and none before it")
            got = {c[2] for c in cols}
            if got != spec["fields"]:
                raise ParseError(f"{where}: the columns are {sorted(got)}, the schedule's are "
                                 f"{sorted(spec['fields'])}")
            cols_before[number] = cols
            prev = None
            for cells in rows[first:]:
                if not cells:
                    continue
                heading = catchment_of(cells, width)
                if heading:
                    catchment[number] = heading
                    continue
                if spans_table(cells, width):
                    # Read as the rest of the row above, its text would land in
                    # whichever column its middle happens to be over.
                    raise ParseError(f"{where}: {cells[0][2]!r} spans the table and is "
                                     f"not a catchment heading this reader recognises")
                fields = {}
                for x0, x1, text in cells:
                    f = field_at(cols, x0, x1, where)
                    fields[f] = f"{fields[f]} {text}" if f in fields else text
                bureau = fields.get("bureau_number", "")
                padded = None
                if BUREAU_CELL_RE.match(bureau) and not BUREAU_RE.match(bureau):
                    padded, bureau = bureau, bureau.zfill(6)
                if not BUREAU_RE.match(bureau):
                    if bureau or prev is None:
                        raise ParseError(f"{where}: {' | '.join(t for _, _, t in cells)!r} "
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
                        prev[f] = f"{prev[f]} / {text}" if prev.get(f) else text
                    stats["stacked"] += 1
                    continue
                if catchment[number] is None:
                    raise ParseError(f"{where}: {bureau} is before any catchment")
                row = {"bureau_number": bureau, "schedule": number,
                       "catchment_name": catchment[number]["name"]}
                if catchment[number]["basin_no"]:
                    row["basin_no"] = catchment[number]["basin_no"]
                else:
                    row["_printed_heading"] = catchment[number]["printed"]
                row.update((f, v) for f, v in fields.items() if f != "bureau_number")
                if padded:
                    row["_printed_number"] = padded
                out[number].append(row)
                prev = row
    return out, pages, stats


def tidy(row, spec):
    """One row as the JSON carries it: numbers as numbers, vocabularies checked.

    What the page printed that is not a value of its column is left out of the
    field, and `source_note` says what it was — one clause per oddity, joined
    with semicolons, each of which reads on its own on the station card."""
    notes = []
    for f in ("class_minor", "class_moderate", "class_major"):
        if f in row:
            v = as_number(row[f])
            if v is None:
                notes.append(f"the {f.split('_')[1]} level reads {row[f]!r}")
                del row[f]
            else:
                row[f] = v
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
    if "lead_time" in row:
        # The first target's, where a row has two: the number is for ordering.
        h = lead_time_hours(row["lead_time"].split(" / ")[0])
        if h is not None:
            row["lead_time_hours"] = h
    if "owner" not in row and spec.get("owner_implied"):
        row["owner"] = spec["owner_implied"]
    # A trailing asterisk marks a footnote on the page, not part of the name.
    # Recorded so the name still matches, and flagged so nobody wonders where
    # it went.
    if row.get("name", "").endswith("*"):
        row["name"] = row["name"].rstrip("*").strip()
        row["footnoted"] = True
    printed = row.pop("_printed_number", None)
    if printed:
        notes.append(f"the bureau number is printed {printed}, without its leading zero")
    heading = row.pop("_printed_heading", None)
    if heading:
        notes.append(f"the catchment heading reads {heading!r}, "
                     f"with no three-digit basin number")
    if notes:
        row["source_note"] = "; ".join(notes)
    return row


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
#   locations) to the most general inventory (7: what the Bureau owns), so the
#   earlier one is making a claim about the flood-warning service rather than
#   about a site register;
#
#   except priority, where the highest stated anywhere wins — because priority
#   measures the impact of losing a site, and a site that is High to any part of
#   the service is High to lose. Letting a "Low" in a site register overrule a
#   "High" in the forecast schedule is the one direction this field must not
#   move.
#
# Emitted alongside the raw rows rather than left to the reader, because the app
# reads this file straight off disk — it is a field tool that has to work from
# file:// with no database behind it — and a second implementation of this rule
# in JavaScript would be a second thing to keep in step.
MERGE_FIELDS = ("name", "owner", "gauge_type", "data_type", "basin_no",
                "catchment_name", "class_minor", "class_moderate", "class_major",
                "prediction_type", "lead_time", "lead_time_hours",
                "trigger", "peak_accuracy", "source_note")
PRIORITY_RANK = {"low": 1, "medium": 2, "high": 3}
SCHEDULE_FLAG = {2: "forecast_location", 3: "information_location",
                 4: "river_data_location", 7: "bureau_owned",
                 8: "bureau_assists", 9: "bureau_colocated"}


def merge_locations(schedules):
    """One entry per bureau number, six schedules folded together."""
    by_number = {}
    for key in sorted(schedules, key=int):
        for r in schedules[key]["rows"]:
            by_number.setdefault(r["bureau_number"], []).append(r)

    out = []
    for bureau in sorted(by_number):
        rows = sorted(by_number[bureau], key=lambda r: r["schedule"])
        loc = {"bureau_number": bureau,
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
        for sched, flag in SCHEDULE_FLAG.items():
            if sched in loc["schedules"]:
                loc[flag] = True
        out.append(loc)
    return out


def published(pdf, version):
    """The edition's month and year, from the document's own release history
    ("3.7 December 2025"), or None where it has none — 3.1 does not."""
    if not version:
        return None
    line = re.compile(rf"^{re.escape(version)}\s+([A-Z][a-z]+ \d{{4}})$")
    for page in pdf.pages[:4]:
        for text in (page.extract_text() or "").split("\n"):
            m = line.match(text.strip())
            if m:
                return m.group(1)
    return None


def build(pdf_path):
    import pdfplumber
    out = {"meta": {}, "schedules": {}}
    with pdfplumber.open(pdf_path) as pdf:
        first = pdf.pages[0].extract_text() or ""
        version = re.search(r"Version\s+([\d.]+)", first)
        version = version.group(1) if version else None
        out["meta"] = {
            "source": os.path.basename(pdf_path),
            "title": " ".join(first.split("\n")[0:4]).strip()[:120],
            "version": version,
            "published": published(pdf, version),
            "generator": "tools/ingest/sls.py",
            "pages": len(pdf.pages),
        }
        try:
            raw, pages, stats = read_schedules(pdf)
        except ParseError as e:
            raise SystemExit(f"error: {e}")
        dupes = disagreements = 0
        for number in sorted(SCHEDULES):
            spec = SCHEDULES[number]
            if not raw[number]:
                raise SystemExit(f"schedule {number}: no rows — no page's footer names it")
            rows, dropped, differing = dedupe([tidy(r, spec) for r in raw[number]], number)
            dupes += dropped - differing
            disagreements += differing
            out["schedules"][str(number)] = {"title": spec["title"], "rows": rows,
                                             "pages": [min(pages[number]), max(pages[number])]}
        out["meta"]["identical_rows_dropped"] = dupes
        out["meta"]["differing_rows_noted"] = disagreements
        out["meta"]["stacked_lines_joined"] = stats["stacked"]
        out["locations"] = merge_locations(out["schedules"])
        out["meta"]["locations"] = len(out["locations"])
    return out


def render(doc):
    parts = ['{\n"meta": ' + json.dumps(doc["meta"], sort_keys=True) + ',\n"schedules": {\n']
    keys = sorted(doc["schedules"], key=int)
    for i, k in enumerate(keys):
        s = doc["schedules"][k]
        parts.append(f'"{k}": {{\n"title": {json.dumps(s["title"])},\n'
                     f'"pages": {json.dumps(s.get("pages"))},\n"rows": [\n')
        parts.append(",\n".join(json.dumps(r, sort_keys=True, separators=(",", ":"))
                                for r in s["rows"]))
        parts.append("\n]\n}" + ("," if i < len(keys) - 1 else "") + "\n")
    parts.append("},\n")
    parts.append('"locations": [\n')
    parts.append(",\n".join(json.dumps(l, sort_keys=True, separators=(",", ":"))
                             for l in doc["locations"]))
    parts.append("\n]\n}\n")
    return "".join(parts)


def render_locations(doc):
    """The merged half on its own, for the app."""
    return ('{\n"meta": ' + json.dumps(doc["meta"], sort_keys=True) + ',\n'
            '"locations": [\n'
            + ",\n".join(json.dumps(l, sort_keys=True, separators=(",", ":"))
                          for l in doc["locations"])
            + "\n]\n}\n")


def report(doc):
    import collections
    print(f"{doc['meta']['title']}")
    print(f"  version {doc['meta']['version']}, {doc['meta']['pages']} pages\n")
    seen = {}
    for k in sorted(doc["schedules"], key=int):
        rows = doc["schedules"][k]["rows"]
        gauge = collections.Counter(r.get("gauge_type", "—") for r in rows)
        print(f"  Schedule {k}: {len(rows):>4} rows  "
              f"{dict(gauge)}  {doc['schedules'][k]['title'][:44]}")
        for r in rows:
            seen.setdefault(r["bureau_number"], []).append(int(k))
    print(f"\n  {len(seen)} distinct bureau numbers across all schedules")
    both = [b for b, s in seen.items() if len(s) > 1]
    print(f"  {len(both)} appear in more than one schedule")

    import collections as c
    owners = c.Counter()
    gauges = c.Counter()
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


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--pdf", default=PDF_DEFAULT)
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--out-locations", default=OUT_LOCATIONS)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args(argv)

    doc = build(a.pdf)
    body = render(doc)
    locs = render_locations(doc)

    if a.report:
        report(doc)
        return 0
    if a.check:
        ok = True
        for path, want in ((a.out, body), (a.out_locations, locs)):
            have = open(path, encoding="utf-8").read() if os.path.exists(path) else None
            if have != want:
                print(f"{path}: would change — rerun without --check", file=sys.stderr)
                ok = False
            else:
                print(f"{path}: up to date")
        return 0 if ok else 1

    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(body)
    with open(a.out_locations, "w", encoding="utf-8") as fh:
        fh.write(locs)
    print(f"{a.out_locations}: {len(doc['locations'])} merged locations, "
          f"{len(locs):,} bytes")
    total = sum(len(s["rows"]) for s in doc["schedules"].values())
    print(f"{a.out}: {total} rows across {len(doc['schedules'])} schedules, "
          f"{len(body):,} bytes")
    if doc["meta"].get("identical_rows_dropped"):
        print(f"  {doc['meta']['identical_rows_dropped']} identical duplicate row(s) "
              f"the document lists twice, dropped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
