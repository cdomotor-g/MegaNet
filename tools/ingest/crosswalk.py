#!/usr/bin/env python3
"""Station identity crosswalk — #125 (H3 of epic #122).

Decides which MegaNet station each of the workbook's station identities refers
to, so that #124's 14,982 extracted visits are history attached to something.

    python3 tools/ingest/crosswalk.py            # rewrite the crosswalk
    python3 tools/ingest/crosswalk.py --check    # re-run and fail on any drift

Input is #124's `data/inspections/blocks.jsonl` and the repository's
`stations.json`; output is four files under `data/inspections/`. Nothing here
writes to a database and nothing here invents a station: a workbook station with
no MegaNet counterpart stays unmatched, because creating registry records to
make the numbers line up would corrupt the registry to flatter this epic.

**The tiers, strongest first.** Every match records which tier produced it —
an exact number and a proposed name are not the same claim and must not look
alike to whoever reviews this later.

  manual    a person decided it, in `inspection_station_overrides.json`. Never
            written by this tool, so a re-run cannot undo a human's decision.
  number    the CBM/Bureau number equals a station's `station_number`, compared
            with leading zeros stripped from both sides.
  name      the station name matches exactly once punctuation, case, whitespace
            and the `ALERT`/`AL`/`TM` suffix noise are normalised off.
  proposed  a near name, above a stated threshold. **Proposed, never applied.**
            An inspection filed against the wrong station is a lie that looks
            like data.

**A tier that was tried and rejected: the ALERT ids.** #124 extracts the `ID's`
line, so `Rn = 5858` is available and looks like strong evidence — a sensor id
is more specific than a name. It is not evidence here, because the ids in
`stations.json` are **not unique across networks**: matching on them pairs
`CHARLEVILLE TM` with `Baulkham Hills Eucalyptus Ct`, `BAKERS BEND TM` with
`Northmead Bowling Club` and `RACEVIEW TM` with `The Needles (Woronora River)` —
Sydney stations, on a Queensland workbook. It would have attributed 20
identities and 252 visits, three of which the name tier catches correctly
anyway. The signal is kept out of the crosswalk rather than kept and hedged: a
tier that is right sometimes is worse than no tier, because the output stops
saying what it means.
"""

from __future__ import annotations

import argparse
import collections
import difflib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import extract  # noqa: E402  (same directory, deliberately not a package)

HERE = extract.HERE
REPO = extract.REPO
OUT_DIR = extract.OUT_DIR
STATIONS = os.path.join(REPO, 'stations.json')
OVERRIDES = os.path.join(HERE, 'inspection_station_overrides.json')

# A near-name has to be this close before it is worth a person's attention.
# 0.85 on the normalised strings, which is low enough to surface
# `Mantuan Downs` against `Mantuan Downs (West) AL` and high enough that the
# file stays a worklist somebody will actually read: across 56 unmatched
# identities it proposes twice.
FUZZY_THRESHOLD = 0.85
FUZZY_SUGGESTIONS = 3


# ── Normalisation ────────────────────────────────────────────────────────────
# Both sides, symmetrically. The registry writes `Loudoun Br AL` and the
# workbook writes `LOUDOUN BRIDGE ALERT`; whatever is stripped off one has to
# come off the other.

# Suffix noise: which telemetry a field site carries, which both sides write
# interchangeably — `BAKERS BEND TM` in the workbook is `Bakers Bend AL` in the
# registry, one site whose telemetry changed.
#
# `base station`, `repeater` and `radar` are deliberately **not** in here. They
# are not noise: they say what the installation *is*, and stripping them makes
# `Warwick Base Station` match `Warwick AL` — a different site in the same town,
# attributed with a confidence nothing supports. The registry holds 3,156 field
# sites, 88 repeaters and four base stations, and none of the workbook's twenty
# base stations is among them; they belong in the unmatched list, where a person
# can decide, rather than in the crosswalk looking answered.
SUFFIX = re.compile(
    r'\s*[-–]?\s*\b('
    r'alert|al|tm|ts|telemetry|logger|station|gauge|site|p'
    r')\b\s*$', re.I)

# The registry abbreviates where the workbook spells out, so a word that is one
# of these in either place becomes the same word in both. `CAPTAIN CREEK TM` and
# `Captain Ck AL` are one station and nothing but this makes them look like it.
WORDS = {
    'br': 'bridge', 'brdg': 'bridge', 'ck': 'creek', 'crk': 'creek',
    'cr': 'creek', 'rd': 'road', 'st': 'street', 'hwy': 'highway',
    'mt': 'mount', 'mtn': 'mountain', 'pk': 'park', 'res': 'reservoir',
    'wr': 'weir', 'riv': 'river', 'r': 'river', 'sth': 'south',
    'nth': 'north', 'no': 'number', 'ds': 'downstream', 'us': 'upstream',
}


def number_key(value):
    """`040838` and `40838` are the same station and the zero is real, so it is
    stripped for comparison and never for storage (spec §2)."""
    m = re.match(r'^0*(\d+)(?:\.0)?$', str(value or '').strip())
    return m.group(1) if m else None


def number_candidates(cbm):
    """Every number a CBM cell offers. `33205/33291` is one block covering two
    stations and `531043.2` is one of three sensors at one site, so both the
    parts and the stem are candidates — in order, strongest first."""
    out = []
    for part in re.split(r'[/,]', str(cbm or '')):
        part = part.strip()
        if not part:
            continue
        key = number_key(part)
        if key:
            out.append(key)
            continue
        stem = number_key(part.split('.')[0])
        if stem:
            out.append(stem)
    stems = [k.split('.')[0] for k in out]
    for stem in stems:
        base = number_key(stem)
        if base and base not in out:
            out.append(base)
    return out


def name_key(name, *, strip_suffix=True):
    """A name reduced to what identifies the place."""
    text = re.sub(r'\s+', ' ', str(name or '')).strip().lower()
    if strip_suffix:
        previous = None
        while previous != text:
            previous = text
            text = SUFFIX.sub('', text).strip(' -–')
    text = re.sub(r'[^a-z0-9 ]', ' ', text)
    return ''.join(WORDS.get(word, word) for word in text.split())


# ── The registry side ────────────────────────────────────────────────────────


def load_registry():
    with open(STATIONS, encoding='utf-8') as fh:
        stations = json.load(fh)['stations']

    by_number = collections.defaultdict(set)
    by_name = collections.defaultdict(set)
    names = {}
    for station in stations:
        site = station.get('site') or {}
        for value in (station.get('station_number'), site.get('number')):
            key = number_key(value)
            if key:
                by_number[key].add(station['id'])
        for value in (station.get('name'), site.get('name')):
            key = name_key(value)
            if key:
                by_name[key].add(station['id'])
        names[station['id']] = station.get('name') or ''
    return stations, by_number, by_name, names


# ── The workbook side ────────────────────────────────────────────────────────


def workbook_identities(blocks, inspections):
    """One entry per station the workbook thinks it has.

    A station's blocks are scattered across sheets and repeated per basin tab,
    so they are grouped by the number where there is one and by the name where
    there is not — which is the same rule #124 deduplicates visits with.
    """
    rows = collections.Counter(i['block_ref'] for i in inspections)
    dates = collections.defaultdict(list)
    for i in inspections:
        if i['inspected_on']:
            dates[i['block_ref']].append(i['inspected_on'])

    # The two flat tabs have no blocks, and the 61 visits on them that #124
    # loads are as much a station's history as any block's. Each contributes its
    # own row's name and number.
    sources = [(b['ref'], b['sheet'], b['cbm_no'], b['station_name'],
                b['ids'] or {}, b['notes'] or {}) for b in blocks]
    flat_rows = collections.defaultdict(list)
    for i in inspections:
        if i['block_ref'] is None:
            sources.append((i['ref'], i['sheet'], i['cbm_no'], i['station_name'], {}, {}))
            flat_rows[i['ref']].append(i)

    identities = {}
    for ref, sheet, cbm_no, station_name, ids, block_notes in sources:
        numbers = number_candidates(cbm_no)
        key = f'c:{numbers[0]}' if numbers else f'n:{name_key(station_name)}'
        if key == 'n:':
            key = f'b:{ref}'  # no number and no name: itself, and unmatched
        entry = identities.setdefault(key, {
            'key': key,
            'cbm_numbers': [],
            'cbm_raw': [],
            'names_raw': [],
            'name_keys': [],
            'alert_ids': [],
            'blocks': [],
            'sheets': [],
            'inspection_rows': 0,
            'first_visit': None,
            'last_visit': None,
            'notes': [],
        })
        for number in numbers:
            if number not in entry['cbm_numbers']:
                entry['cbm_numbers'].append(number)
        for field, value in (('cbm_raw', cbm_no), ('names_raw', station_name),
                             ('sheets', sheet)):
            if value and value not in entry[field]:
                entry[field].append(value)
        key_name = name_key(station_name)
        if key_name and key_name not in entry['name_keys']:
            entry['name_keys'].append(key_name)
        for name, value in ids.items():
            if name.endswith('_alert_id') and str(value) not in entry['alert_ids']:
                entry['alert_ids'].append(str(value))
        note = block_notes.get('cbm_note')
        if note and note not in entry['notes']:
            entry['notes'].append(note)
        entry['blocks'].append(ref)
        entry['inspection_rows'] += rows[ref] or len(flat_rows.get(ref, ()))
        visits = dates.get(ref) or [i['inspected_on'] for i in flat_rows.get(ref, ())
                                    if i['inspected_on']]
        if visits:
            low, high = min(visits), max(visits)
            entry['first_visit'] = min(entry['first_visit'] or low, low)
            entry['last_visit'] = max(entry['last_visit'] or high, high)
    return [identities[k] for k in sorted(identities)]


# ── Matching ─────────────────────────────────────────────────────────────────


class OverrideError(Exception):
    """A hand-written pairing that does not name a station that exists."""


def load_overrides(known_ids):
    """The human-decided pairings. This tool reads this file and never writes
    it, which is what makes a decision survive the next run.

    A `station_id` that is not in the registry raises rather than being ignored:
    a typo here silently drops a station's whole history into the unmatched
    pile, which is the one failure mode this file exists to prevent.
    """
    if not os.path.exists(OVERRIDES):
        return {}
    with open(OVERRIDES, encoding='utf-8') as fh:
        overrides = json.load(fh).get('overrides') or {}
    unknown = sorted({o.get('station_id') for o in overrides.values()
                      if o.get('station_id') and o['station_id'] not in known_ids})
    if unknown:
        raise OverrideError(
            f'{os.path.relpath(OVERRIDES, REPO)} names {len(unknown)} station(s) '
            f'that are not in stations.json: {", ".join(unknown)}')
    return overrides


def match(identity, registry, overrides):
    """(tier, station ids, what matched) — or ('unmatched', [], '')."""
    _, by_number, by_name, _ = registry

    override = overrides.get(identity['key'])
    if override is not None:
        station = override.get('station_id')
        return ('manual', [station] if station else [],
                override.get('why', 'decided by hand'))

    for number in identity['cbm_numbers']:
        if number in by_number:
            return 'number', sorted(by_number[number]), number
    for key in identity['name_keys']:
        if key in by_name:
            return 'name', sorted(by_name[key]), key
    return 'unmatched', [], ''


def propose(identity, registry):
    """Near names, for a person to accept or reject. Never applied."""
    _, _, by_name, names = registry
    best = []
    for key in identity['name_keys']:
        for candidate, ids in by_name.items():
            score = difflib.SequenceMatcher(None, key, candidate).ratio()
            if score >= FUZZY_THRESHOLD:
                for station in sorted(ids):
                    best.append({'station_id': station,
                                 'station_name': names[station],
                                 'matched_on': candidate,
                                 'score': round(score, 3)})
    best.sort(key=lambda p: (-p['score'], p['station_id']))
    return best[:FUZZY_SUGGESTIONS]


def crosswalk():
    with open(os.path.join(OUT_DIR, 'blocks.jsonl'), encoding='utf-8') as fh:
        blocks = [json.loads(line) for line in fh]
    with open(os.path.join(OUT_DIR, 'inspections.jsonl'), encoding='utf-8') as fh:
        inspections = [json.loads(line) for line in fh]

    registry = load_registry()
    stations, _, _, names = registry
    overrides = load_overrides(set(names))
    identities = workbook_identities(blocks, inspections)

    matched, unmatched, ambiguous = [], [], []
    tiers = collections.Counter()
    tier_rows = collections.Counter()

    for identity in identities:
        tier, station_ids, matched_on = match(identity, registry, overrides)
        record = {
            'key': identity['key'],
            'tier': tier,
            'station_id': station_ids[0] if len(station_ids) == 1 else None,
            'station_name': names.get(station_ids[0]) if len(station_ids) == 1 else None,
            'matched_on': matched_on,
            'candidates': station_ids if len(station_ids) > 1 else [],
            'workbook': {
                'cbm_raw': identity['cbm_raw'],
                'cbm_numbers': identity['cbm_numbers'],
                'names_raw': identity['names_raw'],
                'alert_ids': identity['alert_ids'],
                'notes': identity['notes'],
            },
            'inspection_rows': identity['inspection_rows'],
            'first_visit': identity['first_visit'],
            'last_visit': identity['last_visit'],
            'sheets': identity['sheets'],
            'blocks': identity['blocks'],
        }

        if len(station_ids) > 1:
            record['tier'] = f'{tier}_ambiguous'
            ambiguous.append({**record, 'candidate_names':
                              [names.get(s) for s in station_ids]})
            tiers['ambiguous'] += 1
            tier_rows['ambiguous'] += identity['inspection_rows']
        elif station_ids:
            tiers[tier] += 1
            tier_rows[tier] += identity['inspection_rows']
        else:
            proposals = propose(identity, registry)
            if proposals:
                record['proposed'] = proposals
            unmatched.append(record)
            tiers['unmatched' if tier != 'manual' else 'manual_no_station'] += 1
            tier_rows['unmatched' if tier != 'manual'
                      else 'manual_no_station'] += identity['inspection_rows']
        matched.append(record)

    unmatched.sort(key=lambda r: (-r['inspection_rows'], r['key']))
    ambiguous.sort(key=lambda r: (-r['inspection_rows'], r['key']))

    total_rows = sum(i['inspection_rows'] for i in identities)
    report = {
        '_': 'Match rates per tier, honestly — a blended percentage would hide '
             'that a proposed name and an exact number are different claims. '
             'Written by tools/ingest/crosswalk.py; do not edit by hand.',
        'workbook_identities': len(identities),
        'inspection_rows': total_rows,
        'registry_stations': len(stations),
        'by_tier': {
            tier: {
                'identities': count,
                'inspection_rows': tier_rows[tier],
                'identities_pct': round(100 * count / len(identities), 1),
                'inspection_rows_pct': round(100 * tier_rows[tier] / total_rows, 1),
            }
            for tier, count in tiers.most_common()
        },
        'attributed': {
            'identities': sum(1 for r in matched if r['station_id']),
            'inspection_rows': sum(r['inspection_rows'] for r in matched
                                   if r['station_id']),
        },
        'unmatched_with_a_proposal': sum(1 for r in unmatched if r.get('proposed')),
        # The unmatched are not 56 separate mysteries. Most of them are one
        # thing: `stations.json` is a register of field sites, and a base
        # station or a repeater is not one — which is a question about the
        # registry's scope rather than a matching failure.
        'unmatched_shape': dict(collections.Counter(
            'base_station_or_repeater'
            if re.search(r'base\s*station|repeater|receiving', ' '.join(
                r['workbook']['names_raw']), re.I)
            else 'has_a_cbm_number_the_registry_does_not'
            if r['workbook']['cbm_numbers'] else 'name_only'
            for r in unmatched).most_common()),
        'overrides_applied': sum(1 for r in matched if r['tier'] == 'manual'),
        'fuzzy_threshold': FUZZY_THRESHOLD,
        'note': 'A proposal is never applied. To accept one, add it to '
                'tools/ingest/inspection_station_overrides.json — this tool '
                'reads that file and never writes it, so a decision made by '
                'hand survives every re-run.',
    }
    return {'crosswalk': matched, 'unmatched': unmatched,
            'ambiguous': ambiguous, 'report': report}


# ── Files ────────────────────────────────────────────────────────────────────


def render(result, directory=OUT_DIR):
    def jsonl(records):
        return ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records)

    def doc(what, records):
        return json.dumps({'_': what, 'count': len(records), 'entries': records},
                          indent=2, ensure_ascii=False) + '\n'

    return {
        os.path.join(directory, 'station_crosswalk.jsonl'):
            jsonl(result['crosswalk']),
        os.path.join(directory, 'station_crosswalk_unmatched.json'):
            doc('Every workbook station with no confident match, most '
                'inspections first — a station with 60 visits and no match '
                'matters more than one with 1. `proposed` is a near name for a '
                'person to accept or reject; it is not applied. Written by '
                'tools/ingest/crosswalk.py; do not edit by hand.',
                result['unmatched']),
        os.path.join(directory, 'station_crosswalk_ambiguous.json'):
            doc('Workbook stations that match more than one MegaNet station. '
                'Listed rather than resolved arbitrarily — picking one would '
                'be a coin toss recorded as a fact. Written by '
                'tools/ingest/crosswalk.py; do not edit by hand.',
                result['ambiguous']),
        os.path.join(directory, 'station_crosswalk_report.json'):
            json.dumps(result['report'], indent=2, ensure_ascii=False) + '\n',
    }


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
            if fh.read() != text:
                problems.append(f'{name}: differs')
    return problems


def summarise(report):
    lines = [f'identities {report["workbook_identities"]} covering '
             f'{report["inspection_rows"]} inspections']
    for tier, figures in report['by_tier'].items():
        lines.append(f'  {tier:<10} {figures["identities"]:>5} '
                     f'({figures["identities_pct"]:>4}%)  '
                     f'{figures["inspection_rows"]:>6} rows '
                     f'({figures["inspection_rows_pct"]:>4}%)')
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true',
                        help='re-run and fail if the checked-in files have drifted')
    parser.add_argument('--out', default=OUT_DIR)
    args = parser.parse_args()

    result = crosswalk()
    print(summarise(result['report']), file=sys.stderr)

    if args.check:
        problems = check(result, args.out)
        if problems:
            print('\n'.join(f'FAIL {p}' for p in problems), file=sys.stderr)
            return 1
        print('crosswalk: up to date', file=sys.stderr)
        return 0

    write(result, args.out)
    print(f'crosswalk: wrote {args.out}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
