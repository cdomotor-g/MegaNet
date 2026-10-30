#!/usr/bin/env python3
"""tools/photo-reader/sql.py — the photo reader's readings, checked and put into
the statement that records them: meganet.record_photo_readings() (0090).

    sql.py RESULTS.json [--model MODEL] [--reader agent:photo-reader] [--version 1] [--chunk 60]

RESULTS.json is a list of readings, one per photo looked at:

    { "photo_id": "…", "outcome": "nothing" | "found" | "unreadable",
      "summary": "a sentence: what the photo shows",
      "lpu": { "lpu_type_key": "elpro_ert_a2", "serial_no": "…", "firmware_version": "…",
               "bootloader_version": "…", "radio_firmware_version": "…",
               "os_version": "…", "program": "…", "confidence": 0.9, "evidence": "…" },
      "equipment": [ { "equipment_key": "solar_regulator", "make": "…", "model": "…",
                       "serial_no": "…", "evidence": "…", "confidence": 0.8 } ] }

Prints one statement per --chunk readings, to run through the Supabase
connector (execute_sql) as they are. Refuses — and says which photo — what the
database would refuse, and two things it cannot see:

  * a site code: a gate combination, a padlock or logger code, a password, a
    key number. Those live only in the inspection records (CLAUDE.md, 0064),
    and a reading that mentions one is rewritten without it, not recorded.
  * a word the connector stops a statement for (drop, delete, truncate), which
    it would hold for a confirmation nobody is there to give. Say it another
    way: "removed", "taken off", "cleared".

No network, no database: text in, text out. Run with python3 -I.
"""

import argparse
import json
import re
import sys

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
LPU_KEYS = {'lpu_type_key', 'serial_no', 'firmware_version', 'bootloader_version', 'radio_firmware_version',
            'os_version', 'program', 'confidence', 'evidence'}
ITEM_KEYS = {'equipment_key', 'make', 'model', 'serial_no', 'evidence', 'confidence'}
KINDS = {'canister', 'ert_a2', 'logger', 'mace', 'modem', 'antenna', 'sim', 'receiver', 'decoder', 'tbrg',
         'water_level_sensor', 'river_sensor', 'shaft_encoder', 'pressure_transmitter', 'bubble_unit', 'gas_druck',
         'solar_panel', 'solar_regulator', 'power_supply', 'pha', 'other'}
STOP_WORDS = re.compile(r'\b(drop|dropped|dropping|delete|deleted|deleting|truncate)\b', re.I)
CODES = re.compile(r'\b(combination|(gate|lock|padlock|access|door|pin)\s*(code|number|no\b\.?)|passcode|password|key\s*(no\b\.?|number|#))', re.I)
CODES_CASED = re.compile(r'\bPIN\b')


def texts(r):
    yield r.get('summary') or ''
    lpu = r.get('lpu') or {}
    for k, v in lpu.items():
        if isinstance(v, str):
            yield v
    for it in r.get('equipment') or []:
        for v in it.values():
            if isinstance(v, str):
                yield v


def check(r, i):
    where = f'reading {i + 1} ({r.get("photo_id", "no photo_id")})'
    bad = []
    if not isinstance(r, dict):
        return [f'{where}: not an object']
    extra = set(r) - {'photo_id', 'outcome', 'summary', 'lpu', 'equipment'}
    if extra:
        bad.append(f'{where}: does not take {", ".join(sorted(extra))}')
    if not UUID.match(str(r.get('photo_id', ''))):
        bad.append(f'{where}: photo_id is the photo\'s uuid, from the manifest')
    if r.get('outcome') not in ('nothing', 'found', 'unreadable'):
        bad.append(f'{where}: outcome is nothing, found or unreadable')
    if len(r.get('summary') or '') > 1000:
        bad.append(f'{where}: summary is at most 1,000 characters')
    lpu = r.get('lpu')
    if lpu is not None:
        if not isinstance(lpu, dict):
            bad.append(f'{where}: lpu is an object')
        else:
            if set(lpu) - LPU_KEYS:
                bad.append(f'{where}: lpu does not take {", ".join(sorted(set(lpu) - LPU_KEYS))}')
            c = lpu.get('confidence')
            if not isinstance(c, (int, float)) or not 0 <= c <= 1:
                bad.append(f'{where}: lpu.confidence is a number from 0 to 1')
    for j, it in enumerate(r.get('equipment') or []):
        if not isinstance(it, dict):
            bad.append(f'{where}: equipment {j + 1} is an object')
            continue
        if set(it) - ITEM_KEYS:
            bad.append(f'{where}: equipment {j + 1} does not take {", ".join(sorted(set(it) - ITEM_KEYS))}')
        if it.get('equipment_key') == 'key_number':
            bad.append(f'{where}: a key number is a site code — leave it out')
        elif it.get('equipment_key') not in KINDS:
            bad.append(f'{where}: equipment {j + 1}: {it.get("equipment_key")} is not a kind the register knows ({", ".join(sorted(KINDS))})')
        if not (it.get('make') or it.get('model') or it.get('serial_no')):
            bad.append(f'{where}: equipment {j + 1} says nothing — a make, a model or a serial number')
    for t in texts(r):
        if STOP_WORDS.search(t):
            bad.append(f'{where}: "{STOP_WORDS.search(t).group(0)}" — the connector holds a statement with that word for a confirmation; say it another way')
        code = CODES.search(t) or CODES_CASED.search(t)
        if code:
            bad.append(f'{where}: "{code.group(0)}" — a site code is never recorded here; rewrite the text without it')
    return bad


def compact(r):
    out = {k: v for k, v in r.items() if v not in (None, '', [], {})}
    if 'lpu' in out:
        out['lpu'] = {k: v for k, v in out['lpu'].items() if v not in (None, '')}
    if 'equipment' in out:
        out['equipment'] = [{k: v for k, v in it.items() if v not in (None, '')} for it in out['equipment']]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('results')
    ap.add_argument('--model', default='')
    ap.add_argument('--reader', default='agent:photo-reader')
    ap.add_argument('--version', type=int, default=1)
    ap.add_argument('--chunk', type=int, default=60)
    a = ap.parse_args()
    with open(a.results) as f:
        rs = json.load(f)
    if not isinstance(rs, list):
        sys.exit('RESULTS.json is a list of readings')
    problems = [p for i, r in enumerate(rs) for p in check(r, i)]
    seen = {}
    for r in rs:
        seen[r.get('photo_id')] = seen.get(r.get('photo_id'), 0) + 1
    problems += [f'{pid} is read twice in this file — once is a reading' for pid, n in seen.items() if n > 1]
    if problems:
        print('\n'.join(problems), file=sys.stderr)
        sys.exit(1)
    if not re.match(r'^agent:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$', a.reader):
        sys.exit('--reader is agent:<name>')
    chunk = max(1, min(200, a.chunk))
    for i in range(0, len(rs), chunk):
        body = json.dumps({'reader': a.reader, 'reader_version': a.version, 'model': a.model,
                           'readings': [compact(r) for r in rs[i:i + chunk]]}, ensure_ascii=False, separators=(',', ':'))
        if '$rpr$' in body:
            sys.exit('a reading has $rpr$ in it')
        print(f'select meganet.record_photo_readings($rpr${body}$rpr$::jsonb);')


if __name__ == '__main__':
    main()
