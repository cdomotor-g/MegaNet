#!/usr/bin/env python3
"""Import ARRO "Sensors - List by System" exports into stations.json.

ARRO can export one workbook per state listing every sensor it knows about:

    Sensor Class | Sensor Class Name | Site | Site ID | Sensor | SSR |
    Comms ID | Sensor Number | Priority | Latitude | Longitude

Mapping onto the stations.json schema:

    Site       -> station name (authoritative; see --no-rename)
    Site ID    -> station_number / site.number
    Sensor     -> sensors[].type
    SSR        -> sensors[].sensor_id, with ".<Comms ID>" appended when the
                  sensor has an ALERT address (matches the national export)
    Comms ID   -> sensors[].alert_id (blank / "XXXX" means no ALERT address)
    Lat / Long -> lat / lon, for new stations only

`sensors[].device_id` and `site.db_id` are ARRO-internal ids that the workbooks
do not carry. They are looked up in the archived national export
(archive/z_Sensors_with_Database_IDs_by_View_NATIONAL.csv) when it is available;
sensors that cannot be resolved get a null device_id, which the app already
tolerates (the Bit Flipper simply cannot build an ARRO graph link for them).

The script is idempotent: running it twice over the same workbooks produces the
same stations.json.

Usage
-----
    pip install xlrd
    python3 tools/import_arro_sensors.py Sensors_*_List_by_System.xls
    python3 tools/import_arro_sensors.py --dry-run --report report.md *.xls
"""

from __future__ import annotations

import argparse
import collections
import csv
import datetime
import html
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_STATIONS = os.path.join(REPO, 'stations.json')
DEFAULT_NATIONAL = os.path.join(
    REPO, 'archive', 'z_Sensors_with_Database_IDs_by_View_NATIONAL.csv')

EXPECTED_HEADER = [
    'Sensor Class', 'Sensor Class Name', 'Site', 'Site ID', 'Sensor', 'SSR',
    'Comms ID', 'Sensor Number', 'Priority', 'Latitude', 'Longitude',
]

# Australia, generously bounded — anything outside is a placeholder (ARRO uses
# 0/0 for sites whose coordinates were never entered).
LAT_RANGE = (-45.0, -9.0)
LON_RANGE = (110.0, 156.0)


# ── helpers ───────────────────────────────────────────────────────────────────

def clean(value: str) -> str:
    """ARRO exports HTML-escape apostrophes ("Mosely&#039;s AL")."""
    return re.sub(r'\s+', ' ', html.unescape(value or '').strip())


def namekey(value: str) -> str:
    """Comparison key that ignores case, punctuation and spacing."""
    return re.sub(r'[^a-z0-9]', '', (value or '').lower())


def slug(value: str) -> str:
    """Mirror of app.js slug() so ids generated here match ids made in the UI."""
    return re.sub(r'^_|_$', '', re.sub(r'[^a-z0-9]+', '_', (value or '').lower()))[:64]


def coord(value: str, lo_hi: tuple[float, float]):
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    return num if lo_hi[0] < num < lo_hi[1] else None


def alert_id_of(comms: str):
    comms = (comms or '').strip()
    return int(comms) if comms.isdigit() else None


def sensor_id_of(ssr: str, comms: str) -> str:
    """SSR plus the ALERT address, the form the national export uses."""
    ssr = (ssr or '').strip()
    aid = alert_id_of(comms)
    return f'{ssr}.{aid}' if aid is not None else ssr


def sensor_sort_key(sensor: dict) -> tuple:
    big = float('inf')
    return (sensor.get('alert_id') if sensor.get('alert_id') is not None else big,
            sensor.get('device_id') if sensor.get('device_id') is not None else big,
            sensor.get('type') or '')


def derive_alert_ids(sensors: list[dict]) -> dict:
    """Legacy alert_ids object — same rules as editorSave() in app.js."""
    out: dict = {}
    water = []
    for sensor in sensors:
        aid = sensor.get('alert_id')
        if aid is None:
            continue
        kind = (sensor.get('type') or '').lower()
        if 'rain' in kind:
            out.setdefault('rainfall', aid)
        elif 'batt' in kind:
            out.setdefault('battery', aid)
        elif 'level' in kind and aid not in water:
            water.append(aid)
    if len(water) == 1:
        out['water_level'] = water[0]
    elif water:
        out['water_level'] = water
    return out


# ── inputs ────────────────────────────────────────────────────────────────────

def read_workbook(path: str) -> list[dict]:
    try:
        import xlrd
    except ImportError:
        sys.exit('xlrd is required to read the ARRO .xls exports: pip install xlrd')

    # ARRO writes the OLE directory with a stale entry; the sheet itself is fine.
    book = xlrd.open_workbook(path, ignore_workbook_corruption=True)
    sheet = book.sheet_by_index(0)
    header = [str(sheet.cell_value(0, c)).strip() for c in range(sheet.ncols)]
    if header != EXPECTED_HEADER:
        sys.exit(f'{path}: unexpected columns {header}')
    return [dict(zip(header, [str(sheet.cell_value(r, c)) for c in range(sheet.ncols)]))
            for r in range(1, sheet.nrows)]


def load_sites(paths: list[str]) -> dict:
    """Collapse the sensor rows into {site id: site record}."""
    sites: dict = {}
    for path in paths:
        for row in read_workbook(path):
            site_id = row['Site ID'].strip()
            if not site_id:
                continue
            site = sites.setdefault(site_id, {
                'number': site_id,
                'name': clean(row['Site']),
                'lat': coord(row['Latitude'], LAT_RANGE),
                'lon': coord(row['Longitude'], LON_RANGE),
                'sensors': [],
                'seen': set(),
            })
            sensor_id = sensor_id_of(row['SSR'], row['Comms ID'])
            kind = clean(row['Sensor'])
            if (sensor_id, kind) in site['seen']:
                continue        # the same sensor listed twice in one export
            site['seen'].add((sensor_id, kind))
            site['sensors'].append({
                'alert_id': alert_id_of(row['Comms ID']),
                'type': kind,
                'sensor_id': sensor_id,
                'device_id': None,
            })
    for site in sites.values():
        del site['seen']
    return sites


def load_national(path: str) -> tuple[dict, dict]:
    """(db_id by site number, device_id by (site number, sensor id, type)).

    The archived national export is the only source for ARRO's internal ids.
    Sites occasionally appear under more than one db_id (superseded records), so
    the most frequently used one wins.
    """
    if not path or not os.path.exists(path):
        return {}, {}
    db_ids: dict = collections.defaultdict(collections.Counter)
    devices: dict = collections.defaultdict(collections.Counter)
    with open(path, encoding='cp1252', newline='') as handle:
        for row in csv.DictReader(handle):
            number = (row.get('Site ID') or '').strip()
            db_id = (row.get('site_id') or '').strip()
            device_id = (row.get('device_id') or '').strip()
            sensor_id = (row.get('Sensor ID') or '').strip()
            kind = clean(row.get('Sensor'))
            if number and db_id.isdigit():
                db_ids[number][int(db_id)] += 1
            if number and device_id.isdigit():
                devices[(number, sensor_id, kind)][int(device_id)] += 1
    return ({k: v.most_common(1)[0][0] for k, v in db_ids.items()},
            {k: v.most_common(1)[0][0] for k, v in devices.items()})


def resolve_device_ids(sites: dict, devices: dict) -> int:
    """Fill sensors[].device_id from the national export. Returns the hit count."""
    # Fall back to matching on the SSR alone, for sensors whose ALERT address
    # was reassigned (or blanked to "XXXX") since the national export was taken.
    by_ssr: dict = collections.defaultdict(list)
    for (number, sensor_id, kind), device_id in devices.items():
        by_ssr[(number, sensor_id.rsplit('.', 1)[0], kind)].append(device_id)
        by_ssr[(number, sensor_id, kind)].append(device_id)

    hits = 0
    for number, site in sites.items():
        for sensor in site['sensors']:
            key = (number, sensor['sensor_id'], sensor['type'])
            device_id = devices.get(key)
            if device_id is None:
                candidates = by_ssr.get(key) or []
                if len(set(candidates)) == 1:
                    device_id = candidates[0]
            if device_id is not None:
                sensor['device_id'] = device_id
                hits += 1
    return hits


# ── matching ──────────────────────────────────────────────────────────────────

def match_stations(stations: list[dict], sites: dict) -> tuple[dict, list]:
    """Map site number -> existing station, without creating duplicates.

    Three passes, most trustworthy first. A site is only ever claimed once, so a
    station_number match always beats a name match.
    """
    claimed: dict = {}
    taken: set = set()
    notes: list = []

    by_number = {}
    for station in stations:
        number = (station.get('station_number') or '').strip()
        if number and number not in by_number:
            by_number[number] = station

    # 1. station_number == Site ID.
    for number in sites:
        station = by_number.get(number)
        if station is not None:
            claimed[number] = station
            taken.add(id(station))

    # Stations with no station_number are the ones an early import truncated
    # and left unlinked — match them on name so they gain their number back
    # instead of being duplicated.
    orphans = [s for s in stations
               if not (s.get('station_number') or '').strip() and id(s) not in taken]
    by_name: dict = collections.defaultdict(list)
    for number, site in sites.items():
        if number not in claimed:
            by_name[namekey(site['name'])].append(number)

    # 2. exact name.
    for station in orphans:
        if id(station) in taken:
            continue
        hits = [n for n in by_name.get(namekey(station['name']), []) if n not in claimed]
        if len(hits) == 1:
            claimed[hits[0]] = station
            taken.add(id(station))
            notes.append(('matched-by-name', station['id'], hits[0], sites[hits[0]]['name']))

    # 3. name truncated to exactly 20 characters by the early import, and a
    #    single unclaimed site extends it.
    for station in orphans:
        if id(station) in taken or len(station['name']) != 20:
            continue
        prefix = namekey(station['name'])
        hits = [n for key, numbers in by_name.items() if key.startswith(prefix) and key != prefix
                for n in numbers if n not in claimed]
        if len(set(hits)) == 1:
            number = hits[0]
            claimed[number] = station
            taken.add(id(station))
            notes.append(('matched-by-truncated-name', station['id'], number, sites[number]['name']))

    # Left deliberately unmatched: a name that looks close but is not a clean
    # truncation, or a site number that disagrees. Worth a human's eye.
    unmatched_sites = {n: s for n, s in sites.items() if n not in claimed}
    for station in stations:
        if id(station) in taken:
            continue
        key = namekey(station['name'])
        if len(key) < 6:
            continue
        near = [(n, s['name']) for n, s in unmatched_sites.items()
                if namekey(s['name']).startswith(key) or key.startswith(namekey(s['name']))]
        for number, name in near:
            notes.append(('review-possible-duplicate', station['id'], number, name))

    return claimed, notes


def unique_id(name: str, used: set) -> str:
    base = slug(name) or 'station'
    candidate, n = base, 2
    while candidate in used:
        candidate = f'{base}_{n}'
        n += 1
    used.add(candidate)
    return candidate


# ── the import ────────────────────────────────────────────────────────────────

def apply_import(data: dict, sites: dict, db_ids: dict, rename: bool, report: list) -> dict:
    stations = data['stations']
    claimed, notes = match_stations(stations, sites)
    reviews = [n for n in notes if n[0] == 'review-possible-duplicate']
    for note in notes:
        if note[0] != 'review-possible-duplicate':
            report.append(f'- `{note[1]}` linked to site {note[2]} ({note[3]}) — {note[0]}')

    stats = collections.Counter()
    renames, added_sensors = [], []

    for number, site in sorted(sites.items()):
        station = claimed.get(number)
        if station is None:
            continue
        stats['matched'] += 1

        if not (station.get('station_number') or '').strip():
            station['station_number'] = number
            stats['station_number_filled'] += 1

        if rename and station['name'] != site['name']:
            renames.append((number, station['name'], site['name']))
            station['name'] = site['name']
            stats['renamed'] += 1

        site_ref = station.setdefault('site', {})
        if site_ref.get('db_id') is None:
            site_ref['db_id'] = db_ids.get(number)
        site_ref['number'] = number
        if rename or not site_ref.get('name'):
            site_ref['name'] = site['name']
        station['site'] = {'db_id': site_ref.get('db_id'),
                           'number': site_ref['number'],
                           'name': site_ref['name']}

        existing = station.get('sensors') or []
        have = {(s.get('sensor_id'), s.get('type')) for s in existing}
        new = [s for s in site['sensors'] if (s['sensor_id'], s['type']) not in have]
        if new:
            for sensor in new:
                added_sensors.append((number, site['name'], sensor))
            merged = existing + [dict(s) for s in new]
            merged.sort(key=sensor_sort_key)
            station['sensors'] = merged
            stats['sensors_added'] += len(new)
            stats['stations_gaining_sensors'] += 1

    used_ids = {s['id'] for s in stations}
    created = []
    for number, site in sorted(sites.items(), key=lambda kv: (kv[1]['name'], kv[0])):
        if number in claimed:
            continue
        sensors = sorted((dict(s) for s in site['sensors']), key=sensor_sort_key)
        created.append({
            'id': unique_id(site['name'], used_ids),
            'name': site['name'],
            'station_number': number,
            'lat': site['lat'],
            'lon': site['lon'],
            'elevation_ahd': None,
            'roles': ['field'],
            'radio_network_ids': [],
            'catchment_ids': [],
            'alert_ids': derive_alert_ids(sensors),
            'satcom': {'enabled': False, 'provider': '', 'terminal_id': ''},
            'rm_system_id': 1,
            'enabled': True,
            'notes': '',
            'site': {'db_id': db_ids.get(number), 'number': number, 'name': site['name']},
            'sensors': sensors,
        })
    stations.extend(created)
    stats['created'] = len(created)
    stats['created_sensors'] = sum(len(s['sensors']) for s in created)

    report.append('')
    report.append(f'## Renamed ({len(renames)})')
    report.append('')
    report.append('| Site ID | stations.json name | ARRO Site name |')
    report.append('|---|---|---|')
    for number, before, after in sorted(renames, key=lambda r: r[2]):
        report.append(f'| {number} | {before} | {after} |')

    report.append('')
    report.append(f'## Sensors added to existing stations ({len(added_sensors)})')
    report.append('')
    report.append('| Site ID | Site | Sensor | ALERT ID | Sensor ID |')
    report.append('|---|---|---|---|---|')
    for number, name, sensor in added_sensors:
        report.append(f'| {number} | {name} | {sensor["type"]} | '
                      f'{sensor["alert_id"] if sensor["alert_id"] is not None else "—"} | '
                      f'{sensor["sensor_id"]} |')

    report.append('')
    report.append(f'## New stations ({len(created)})')
    report.append('')
    report.append('| Site ID | Name | Sensors | Lat | Lon |')
    report.append('|---|---|---|---|---|')
    for station in created:
        report.append(f'| {station["station_number"]} | {station["name"]} | '
                      f'{len(station["sensors"])} | {station["lat"]} | {station["lon"]} |')

    report.append('')
    report.append(f'## Possible duplicates left for review ({len(reviews)})')
    report.append('')
    report.append('Existing stations whose name resembles a site that was imported as new. '
                  'Neither the station number nor a clean truncation linked them, so both '
                  'records were kept.')
    report.append('')
    report.append('| stations.json id | name | new site ID | new site name |')
    report.append('|---|---|---|---|')
    for _, station_id, number, name in sorted(reviews, key=lambda n: n[1]):
        station = next(s for s in stations if s['id'] == station_id)
        report.append(f'| `{station_id}` | {station["name"]} | {number} | {name} |')

    return stats


def fix_names_from_site(stations: list[dict], report: list) -> int:
    """Un-truncate names the workbooks do not cover, using the station's own
    site.name (imported from the national export, so equally authoritative)."""
    fixed = 0
    for station in stations:
        name, site = station['name'], station.get('site') or {}
        full = clean(site.get('name'))
        if not full or full == name:
            continue
        if namekey(full).startswith(namekey(name)) and namekey(full) != namekey(name):
            report.append(f'- {station["station_number"] or station["id"]}: '
                          f'`{name}` → `{full}` (from site.name)')
            station['name'] = full
            fixed += 1

    # The early import cut names at 20 characters. Anything still exactly that
    # long, and not confirmed against an ARRO site name, needs another source.
    stuck = [s for s in stations
             if len(s['name']) == 20 and clean((s.get('site') or {}).get('name')) != s['name']]
    report.append('')
    report.append(f'## Still truncated — no source to expand them ({len(stuck)})')
    report.append('')
    report.append('| Site ID | name |')
    report.append('|---|---|')
    for station in sorted(stuck, key=lambda s: s['name']):
        report.append(f'| {station["station_number"] or "—"} | {station["name"]} |')
    return fixed


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('workbooks', nargs='+', help='ARRO "Sensors - List by System" .xls exports')
    ap.add_argument('--stations', default=DEFAULT_STATIONS, help='stations.json to update')
    ap.add_argument('--national', default=DEFAULT_NATIONAL,
                    help='archived national CSV used for db_id / device_id lookups')
    ap.add_argument('--report', help='write a Markdown change report here')
    ap.add_argument('--no-rename', action='store_true',
                    help='keep existing station names instead of taking the ARRO Site name')
    ap.add_argument('--dry-run', action='store_true', help='report only, do not write stations.json')
    args = ap.parse_args()

    sites = load_sites(args.workbooks)
    db_ids, devices = load_national(args.national)
    resolved = resolve_device_ids(sites, devices)

    with open(args.stations, encoding='utf-8') as handle:
        data = json.load(handle)
    before = len(data['stations'])

    report = [f'# ARRO sensor import — {datetime.date.today().isoformat()}', '',
              f'Workbooks: {", ".join(os.path.basename(p) for p in args.workbooks)}', '',
              f'{len(sites)} sites / '
              f'{sum(len(s["sensors"]) for s in sites.values())} sensors read; '
              f'{resolved} sensors resolved to an ARRO device_id.', '']

    stats = apply_import(data, sites, db_ids, not args.no_rename, report)

    report.append('')
    report.append('## Truncations fixed from site.name (not covered by the workbooks)')
    report.append('')
    fixed = fix_names_from_site(data['stations'], report)

    data['meta']['updated'] = datetime.date.today().isoformat()

    print(f'sites read              {len(sites)}')
    print(f'matched existing        {stats["matched"]}')
    print(f'  renamed               {stats["renamed"]}')
    print(f'  station_number filled {stats["station_number_filled"]}')
    print(f'  sensors added         {stats["sensors_added"]} '
          f'across {stats["stations_gaining_sensors"]} stations')
    print(f'new stations            {stats["created"]} ({stats["created_sensors"]} sensors)')
    print(f'names fixed from site   {fixed}')
    print(f'stations {before} -> {len(data["stations"])}')

    if args.report:
        with open(args.report, 'w', encoding='utf-8') as handle:
            handle.write('\n'.join(report) + '\n')
        print(f'report written to {args.report}')

    if not args.dry_run:
        with open(args.stations, 'w', encoding='utf-8') as handle:
            handle.write(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
        print(f'wrote {args.stations}')


if __name__ == '__main__':
    main()
