#!/usr/bin/env python3
"""
check_sls_merge.py — hold meganet.sls_location to data/sls-locations.json.

The Service Level Specification's merge rule — the lowest-numbered schedule
that states a field wins, except priority, where the highest stated anywhere
wins — is written twice: in tools/ingest/sls.py, for the file the app reads off
disk, and in the view meganet.sls_location (0028), for anything that asks the
database. db/README.md says why it has to be twice. This is what keeps the two
the same rule.

It loads data/sls-qld.json into the database the usual PG* variables name,
inside a transaction it rolls back, reads the view, and compares it with
data/sls-locations.json location by location and field by field. It prints
the md5 of each side over every location and every merged field, lists the
first disagreements it finds, and exits non-zero if there are any.

    python3 tools/check_sls_merge.py         # PGHOST, PGDATABASE, ... as psql takes them

Safe against the live database: nothing it loads survives the rollback. Needs
psql on the PATH and a role that may run meganet.load_sls_doc(). Standard
library only.
"""

import hashlib
import json
import os
import shlex
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROWS = os.path.join(REPO, "data", "sls-qld.json")
LOCATIONS = os.path.join(REPO, "data", "sls-locations.json")

# Every field a merged location carries, in both places. `trigger` is
# `trigger_height` in the view, because trigger is a reserved word there.
FIELDS = ["name", "owner", "gauge_type", "data_type", "basin_no", "catchment_name",
          "class_minor", "class_moderate", "class_major", "prediction_type",
          "lead_time", "lead_time_hours", "trigger", "peak_accuracy", "source_note",
          "priority", "schedules", "forecast_location", "information_location",
          "river_data_location", "bureau_owned", "bureau_assists", "bureau_colocated"]


def norm(field, value):
    """One field as both sides can agree on it. The file leaves out a flag that
    is false and a field that is empty, where the view says false and null;
    numbers compare as numbers, since 7.0 and 7 are the same flood level."""
    if value is None or value is False:
        return None
    if field.startswith("class_") or field == "lead_time_hours":
        return float(value)
    return value


def canon(locations):
    return json.dumps(sorted([loc["bureau_number"]] + [norm(f, loc.get(f)) for f in FIELDS]
                             for loc in locations),
                      separators=(",", ":"))


def view_rows():
    script = "\n".join([
        "begin;",
        f"\\set doc `cat {shlex.quote(ROWS)}`",
        "select 'loaded: ' || meganet.load_sls_doc(:'doc'::jsonb);",
        "select to_jsonb(l) from meganet.sls_location l;",
        "rollback;",
        "",
    ])
    run = subprocess.run(["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
                         input=script, capture_output=True, text=True)
    if run.returncode != 0:
        sys.exit(f"psql failed:\n{run.stderr.strip()}")
    rows = []
    for line in run.stdout.splitlines():
        if line.startswith("loaded: "):
            print(line[len("loaded: "):])
        elif line.startswith("{"):
            row = json.loads(line)
            row["trigger"] = row.pop("trigger_height", None)
            rows.append(row)
    return rows


def main():
    with open(LOCATIONS, encoding="utf-8") as fh:
        file_side = json.load(fh)["locations"]
    view_side = view_rows()

    a, b = canon(file_side), canon(view_side)
    print(f"data/sls-locations.json  {len(file_side):>5} locations  "
          f"md5 {hashlib.md5(a.encode()).hexdigest()}")
    print(f"meganet.sls_location     {len(view_side):>5} locations  "
          f"md5 {hashlib.md5(b.encode()).hexdigest()}")

    by_file = {loc["bureau_number"]: loc for loc in file_side}
    by_view = {loc["bureau_number"]: loc for loc in view_side}
    problems = []
    for number in sorted(set(by_file) | set(by_view)):
        f, v = by_file.get(number), by_view.get(number)
        if f is None or v is None:
            problems.append(f"{number}: only in {'the view' if f is None else 'the file'}")
            continue
        for field in FIELDS:
            if norm(field, f.get(field)) != norm(field, v.get(field)):
                problems.append(f"{number} {field}: the file says {f.get(field)!r}, "
                                f"the view {v.get(field)!r}")
    if len(by_view) != len(view_side):
        problems.append(f"the view has {len(view_side)} rows for {len(by_view)} bureau "
                        f"numbers — a join has fanned out")

    if problems:
        print(f"\nFAIL — {len(problems)} disagreement(s):")
        for p in problems[:20]:
            print(f"  {p}")
        return 1
    print(f"\nPASS — the view merges the SLS as the app's file does: "
          f"{len(file_side)} locations, {len(FIELDS)} fields each.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
