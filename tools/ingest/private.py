"""Where the inspection archive lives — not in this repository.

The historical inspection workbook (`QLD All Site Inspections.xlsx`) and
everything derived from it — the staging rows, the blocks, the mined events, the
station crosswalk and the hand-checked sample — carry site-access notes and
gate, padlock and logger codes. The codes are for the people who maintain the
sites (approved accounts read them in the database, 0064), not for a public
repository or the public site, so those files live in the private repository
`cdomotor-g/flood-net-private`, under `inspections/`.

The tools that read or write them (survey.py, extract.py, crosswalk.py,
remarks.py, load.py) find it beside this checkout:

    ~/src/MegaNet                 this repository
    ~/src/flood-net-private       git clone https://github.com/cdomotor-g/flood-net-private

or wherever FLOODNET_PRIVATE points. Without it they say so and stop; nothing
else in this repository needs it. The derived-artefact checks that used to run
in web-smoke.yml run in that repository's own workflow instead.
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

ROOT = os.environ.get('FLOODNET_PRIVATE') or os.path.join(os.path.dirname(REPO), 'flood-net-private')
INSPECTIONS = os.path.join(ROOT, 'inspections')
WORKBOOK = os.path.join(INSPECTIONS, 'QLD All Site Inspections.xlsx')
DATA = os.path.join(INSPECTIONS, 'data')
SAMPLE = os.path.join(INSPECTIONS, 'inspection_extract_sample.json')

# How a record names the workbook it came from (inspection.source_workbook, the
# survey's and the sample's own headers). A name, not a path: it was written into
# the database before the workbook moved, and it stays the same wherever the
# checkout is.
WORKBOOK_NAME = 'archive/QLD All Site Inspections.xlsx'


def require(what: str = WORKBOOK) -> None:
    """Stop with a sentence, not a traceback, when the private checkout is missing."""
    if os.path.exists(what):
        return
    print(f'{os.path.relpath(what, os.path.dirname(REPO))} is not here.\n'
          'The inspection archive lives in the private repository '
          'cdomotor-g/flood-net-private (it carries site access codes). Clone it '
          f'beside this one, at {ROOT},\nor set FLOODNET_PRIVATE to a checkout of it.',
          file=sys.stderr)
    raise SystemExit(2)
