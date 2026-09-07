#!/usr/bin/env python3
"""
sls.py — read the Queensland Service Level Specification's schedules into JSON.

WHAT THIS IS
    `archive/QLD_SLS_current.pdf` is the Bureau's "Service Level Specification
    for Flood Forecasting and Warning Services for Queensland", version 3.1,
    dated September 2018. 139 pages, eleven schedules, and five of those
    schedules are tables of stations keyed on the bureau number — which is the
    same number `meganet.station.station_number` carries.

    That makes it the answer to a set of questions MegaNet has never been able
    to ask about a station: what its flood class levels are, whether anybody
    forecasts for it or merely reports it, who owns it, whether a person reads
    it or a radio does, and how much it matters when it stops.

    This reads the five station schedules out and writes `data/sls-qld.json`.
    It does not interpret them; that is the loader's job and the app's.

WHICH SCHEDULES, AND WHY THESE FIVE

    2  Forecast locations and levels of service ....... the flood warning itself:
       flood class levels, prediction type, target warning lead time, trigger
       height, peak accuracy, priority. 205 rows.
    3  Information locations with flood class levels .. reported but not
       forecast: flood class levels and priority only.
    7  Sites owned and maintained by the Bureau ....... ownership, plus what the
    8  Sites the Bureau assists with ..................  site measures and what
    9  Sites where the Bureau co-locates .............   kind of gauge it is.

    Schedules 1, 6, 10 and 11 are committee membership, agreement names, product
    names and a change log — prose about the document rather than facts about
    stations. Schedule 4 (river data locations) and 5 (Enviromon base stations)
    are stations, but carry no fact the other five do not, so they are read for
    completeness and marked, not merged.

HOW IT READS THEM

    Positionally, and this is the load-bearing decision. Every one of these
    tables is ruled, so pdfplumber recovers the cell grid exactly — but the
    header cells are merged, which leaves the column list sparse: 21 columns for
    Schedule 2, of which 12 carry anything. The obvious repair is to drop the
    empty cells and read what is left in order. **That is wrong**, and quietly:
    a station with no Moderate level shifts every field after it by one, and the
    result is a Major level filed as a Moderate one with nothing to say it
    happened. So the column indices are fixed per schedule, the header row is
    checked on every page before any row on it is read, and a page whose header
    does not match raises rather than yielding.

    The catchment is a row, not a column. Each schedule is grouped under
    subheadings that read "130 Fitzroy" — the AWRC basin number and its name,
    which is exactly `meganet.catchment.basin_no`. A subheading sets the
    catchment for every row under it until the next one, and "(continued)" at
    the top of a page repeats it.

USAGE
    python3 tools/ingest/sls.py                    # rewrite data/sls-qld.json
    python3 tools/ingest/sls.py --check            # fail if it would change
    python3 tools/ingest/sls.py --report           # what came out, in prose

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

# ── Where each schedule is, and which column holds what ──────────────────────
# `pages` is the 0-based PDF page range, end-exclusive. `cols` maps a field to
# its index in the row pdfplumber returns, or to a tuple of candidate indices
# where a merged header cell makes the split unstable — the first candidate
# holding anything wins. `header` is what row 0 must contain for those indices
# to mean anything, and it is checked on every page.
#
# `shape: "typed"` opts a schedule out of column indices entirely; see typed_row().
SCHEDULES = {
    2: {
        "title": "Forecast locations and levels of service",
        "pages": (19, 29),
        "header": ["Bureau", "Forecast location", "Station owner", "Gauge"],
        "cols": {
            "bureau_number": 0, "name": 2, "owner": 3, "gauge_type": 4,
            "class_minor": 5, "class_moderate": 6, "class_major": 7,
            "prediction_type": 8, "lead_time": 9, "trigger": 12,
            # Priority lands in 19 on 176 rows and in 18 on 42, because the
            # header cell above it is merged and pdfplumber splits the merge
            # differently depending on where the row's text sits. Two rows
            # carry it in both. Taking the first of the pair that has anything
            # is the only reading that recovers all 220.
            "priority": (19, 18),
        },
    },
    3: {
        "title": "Information locations with flood class levels defined",
        "pages": (29, 54),
        "header": ["Bureau", "Station name", "Station owner", "Gauge"],
        "cols": {
            "bureau_number": 0, "name": 2, "owner": 3, "gauge_type": 4,
            "class_minor": 5, "class_moderate": 8, "class_major": 11,
            "priority": 14,
        },
    },
    # Schedule 4 is the one that will not hold still: its column count changes
    # from page to page (10, then 8, then 10) and the gauge type moves within
    # the same count. Fixed indices cannot describe it, and guessing would be
    # exactly the silent-shift failure the header check exists to prevent.
    #
    # It does not need them. Its five fields identify themselves: the bureau
    # number is six digits, the gauge type is one of two words, the priority is
    # one of three, and what is left over is the name and then the owner, in
    # that order. So this one is read by value — see typed_row().
    4: {
        "title": "River data locations",
        "pages": (54, 76),
        "header": ["Bureau", "Station name"],
        "shape": "typed",
    },
    7: {
        "title": "Sites owned and maintained by the Bureau",
        "pages": (79, 98),
        "header": ["Bureau", "Station", "Gauge", "Data"],
        "shape": "typed",
        "owner_implied": "Bureau",
    },
    8: {
        "title": "Sites where the Bureau assists other agencies with maintenance",
        "pages": (98, 119),
        "header": ["Bureau", "Station", "Owner", "Gauge", "Data"],
        "shape": "typed",
    },
    9: {
        "title": "Sites where the Bureau co-locates equipment and the site is owned by another agency",
        "pages": (119, 124),
        "header": ["Bureau", "Station", "Owner", "Gauge", "Data"],
        "shape": "typed",
    },
}

# "146 – South Coast (Nerang)", "130 Fitzroy", either dash, "(continued)" or not.
CATCHMENT_RE = re.compile(
    r"^\s*(\d{3})\s*[–—-]\s*(.+?)\s*(?:\(continued\))?\s*$", re.I)
BUREAU_RE = re.compile(r"^\d{6}$")


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


GAUGE_TYPES = {"automatic", "manual"}
PRIORITIES = {"high", "medium", "low"}
# "Rainfall", "River", "Rainfall/River", "Rainfall/Repeater", "Rainfall/River/Repeater"
DATA_TYPE_RE = re.compile(
    r"^(rainfall|river|repeater|storage|tide|weather)"
    r"(\s*/\s*(rainfall|river|repeater|storage|tide|weather))*$", re.I)


def typed_row(cells, expect_owner=True):
    """One row of a table whose columns move, read by what the values are.

    Only safe where every field is either a closed vocabulary or positionally
    unambiguous once the closed ones are removed, which is true of Schedule 4
    and of nothing else in this document. Returns None for a row that does not
    look like a station, which is how a stray header or note is skipped.
    """
    vals = [c for c in cells if c]
    if not vals or not BUREAU_RE.match(vals[0]):
        return None
    row = {"bureau_number": vals[0]}
    rest, spare = [], []
    for v in vals[1:]:
        low = v.lower()
        if low in GAUGE_TYPES and "gauge_type" not in row:
            row["gauge_type"] = v
        elif low in PRIORITIES and "priority" not in row:
            row["priority"] = v
        elif DATA_TYPE_RE.match(low) and "data_type" not in row:
            row["data_type"] = v
        elif low in GAUGE_TYPES or low in PRIORITIES or DATA_TYPE_RE.match(low):
            # A second value for a slot that is already filled. The document has
            # one of these: "031170 KAMERUNGA Manual River River", where the
            # priority column holds "River". Folding it into the station name
            # would invent a station called "KAMERUNGA River"; dropping it
            # silently would hide a defect in the source. It is kept aside and
            # the row says so.
            spare.append(v)
        else:
            rest.append(v)
    # Whatever is left is the name and then the owner, in the document's order.
    # A schedule with no owner column (7 — the Bureau owns all of it) keeps the
    # whole remainder as the name, because a station called "GOLD COAST SAND
    # BYPASS JETTY" arrives in pieces and joining them is right there and wrong
    # one column over.
    if rest:
        if expect_owner:
            row["name"] = rest[0]
            if len(rest) > 1:
                row["owner"] = " ".join(rest[1:])
        else:
            row["name"] = " ".join(rest)
    if spare:
        row["source_note"] = ("the document repeats " + ", ".join(spare)
                              + " where another column was expected")
    return row if "name" in row else None


def header_ok(row, expected):
    """Every word the schedule's header must contain, somewhere in row 0."""
    text = " ".join(clean(c) for c in row)
    return all(word in text for word in expected)


def read_schedule(pdf, number, spec):
    """Every data row in one schedule, with the catchment it sits under."""
    rows, catchment = [], None
    lo, hi = spec["pages"]
    ncols = None

    for idx in range(lo, hi):
        page = pdf.pages[idx]
        for table in page.extract_tables():
            if not table:
                continue
            if not header_ok(table[0], spec["header"]):
                # Schedules 2 and 3 carry a second, tiny table on the first page
                # (the column definitions block). Not an error — just not this.
                continue
            if spec.get("shape") == "typed":
                for raw in table[1:]:
                    cells = [clean(c) for c in raw]
                    joined = " ".join(c for c in cells if c)
                    m = CATCHMENT_RE.match(joined)
                    if m and not BUREAU_RE.match(cells[0] if cells else ""):
                        catchment = {"basin_no": m.group(1), "name": m.group(2)}
                        continue
                    row = typed_row(cells, spec.get("owner_implied") is None)
                    if not row:
                        continue
                    row["schedule"] = number
                    if "owner" not in row and spec.get("owner_implied"):
                        row["owner"] = spec["owner_implied"]
                    if catchment:
                        row["basin_no"] = catchment["basin_no"]
                        row["catchment_name"] = catchment["name"]
                    if row.get("name", "").endswith("*"):
                        row["name"] = row["name"].rstrip("*").strip()
                        row["footnoted"] = True
                    rows.append(row)
                continue

            if ncols is None:
                ncols = len(table[0])
            if len(table[0]) != ncols:
                raise SystemExit(
                    f"schedule {number}, pdf page {idx + 1}: the table has "
                    f"{len(table[0])} columns where every page before it had "
                    f"{ncols}. The column map in this file no longer describes "
                    f"the document; fix it rather than trusting what comes out.")

            for raw in table[1:]:
                cells = [clean(c) for c in raw]
                joined = " ".join(c for c in cells if c)

                m = CATCHMENT_RE.match(joined)
                if m and not BUREAU_RE.match(cells[0]):
                    catchment = {"basin_no": m.group(1), "name": m.group(2)}
                    continue

                bureau = cells[spec["cols"]["bureau_number"]]
                if not BUREAU_RE.match(bureau):
                    continue          # a header repeat, a note, a blank

                row = {"bureau_number": bureau, "schedule": number}
                for field, col in spec["cols"].items():
                    if field == "bureau_number":
                        continue
                    candidates = col if isinstance(col, tuple) else (col,)
                    val = ""
                    for c in candidates:
                        if c < len(cells) and cells[c]:
                            val = cells[c]
                            break
                    if field.startswith("class_"):
                        val = as_number(val)
                    elif not val:
                        val = None
                    if val is not None:
                        row[field] = val
                if "owner" not in row and spec.get("owner_implied"):
                    row["owner"] = spec["owner_implied"]
                if "lead_time" in row:
                    h = lead_time_hours(row["lead_time"])
                    if h is not None:
                        row["lead_time_hours"] = h
                if catchment:
                    row["basin_no"] = catchment["basin_no"]
                    row["catchment_name"] = catchment["name"]
                # A trailing asterisk marks a footnote on the page, not part of
                # the name. Recorded so the name still matches, and flagged so
                # nobody wonders where it went.
                if row.get("name", "").endswith("*"):
                    row["name"] = row["name"].rstrip("*").strip()
                    row["footnoted"] = True
                rows.append(row)

    if not rows:
        raise SystemExit(f"schedule {number}: no rows — the page range is wrong")

    # Four rows in this document are listed twice — two on the same page, two
    # either side of a page break — and in all four cases the repeat is
    # identical in every field. Dropping an exact duplicate is lossless; a
    # *differing* pair would be a real disagreement and is kept, so that the
    # (schedule, bureau_number) key can only collide on something worth looking
    # at. The count is returned rather than swallowed.
    seen, unique, dropped = set(), [], 0
    for r in rows:
        key = json.dumps(r, sort_keys=True)
        if key in seen:
            dropped += 1
            continue
        seen.add(key)
        unique.append(r)
    return unique, dropped


def build(pdf_path):
    import pdfplumber
    out = {"meta": {}, "schedules": {}}
    with pdfplumber.open(pdf_path) as pdf:
        first = pdf.pages[0].extract_text() or ""
        version = re.search(r"Version\s+([\d.]+)", first)
        out["meta"] = {
            "source": os.path.basename(pdf_path),
            "title": " ".join(first.split("\n")[0:3])[:120],
            "version": version.group(1) if version else None,
            "generator": "tools/ingest/sls.py",
            "pages": len(pdf.pages),
        }
        dupes = 0
        for number in sorted(SCHEDULES):
            spec = SCHEDULES[number]
            rows, dropped = read_schedule(pdf, number, spec)
            dupes += dropped
            out["schedules"][str(number)] = {"title": spec["title"], "rows": rows}
        out["meta"]["identical_rows_dropped"] = dupes
    return out


def render(doc):
    parts = ['{\n"meta": ' + json.dumps(doc["meta"], sort_keys=True) + ',\n"schedules": {\n']
    keys = sorted(doc["schedules"], key=int)
    for i, k in enumerate(keys):
        s = doc["schedules"][k]
        parts.append(f'"{k}": {{\n"title": {json.dumps(s["title"])},\n"rows": [\n')
        parts.append(",\n".join(json.dumps(r, sort_keys=True, separators=(",", ":"))
                                for r in s["rows"]))
        parts.append("\n]\n}" + ("," if i < len(keys) - 1 else "") + "\n")
    parts.append("}\n}\n")
    return "".join(parts)


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
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args(argv)

    doc = build(a.pdf)
    body = render(doc)

    if a.report:
        report(doc)
        return 0
    if a.check:
        have = open(a.out, encoding="utf-8").read() if os.path.exists(a.out) else None
        if have != body:
            print(f"{a.out}: would change — rerun without --check", file=sys.stderr)
            return 1
        print(f"{a.out}: up to date")
        return 0

    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(body)
    total = sum(len(s["rows"]) for s in doc["schedules"].values())
    print(f"{a.out}: {total} rows across {len(doc['schedules'])} schedules, "
          f"{len(body):,} bytes")
    if doc["meta"].get("identical_rows_dropped"):
        print(f"  {doc['meta']['identical_rows_dropped']} identical duplicate row(s) "
              f"the document lists twice, dropped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
