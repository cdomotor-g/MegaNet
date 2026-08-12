#!/usr/bin/env python3
"""Load stations.json into the MegaNet Postgres schema.

Emits plain SQL on stdout. Nothing here talks to a database, which is the point:
the output can be piped into `psql`, pasted into Supabase's SQL editor, checked
into a ticket, or read by a human before it is run.

    python3 tools/import_stations_json.py > /tmp/stations.sql
    psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f /tmp/stations.sql

    # or in one go
    python3 tools/import_stations_json.py \\
      | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction

The SQL is a *sync*, not an append: every row in the file is upserted, and every
row in the database that is not in the file is deleted. Running it twice over the
same file is a no-op the second time — including `updated_at`, which is left
alone when a row's data has not actually changed, so a re-run does not restamp
3,174 rows and make it look like something happened.

That makes this the way to reload a snapshot into any empty database — including
the one inside the corporate network, which is the whole reason the schema is
portable SQL in the first place.

Requires 0002_stations.sql to have been applied. Standard library only.
"""

from __future__ import annotations

import argparse
import datetime
import decimal
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_STATIONS = os.path.join(REPO, 'stations.json')

# Every number is read as a Decimal and written out as the digits the file
# actually contained. Through a float, 151.5 is fine but 1060.2 comes back as
# 1060.2000000000000455, and an integer-valued 109 comes back as 109.0 — which
# would make the document the view rebuilds differ from stations.json in ~840
# places for no reason at all. The columns are `numeric` at the other end for the
# same reason. See db/migrations/0002_stations.sql.
def _load(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle, parse_float=decimal.Decimal)


# ── SQL literals ─────────────────────────────────────────────────────────────

def q(value):
    """Quote a scalar as a SQL literal."""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (int, decimal.Decimal)):
        return str(value)
    if isinstance(value, datetime.date):
        return "'%s'" % value.isoformat()
    return "'" + str(value).replace("'", "''") + "'"


def qarray(values):
    """Quote a list of strings as a text[] literal. None stays null."""
    if values is None:
        return 'null'
    if not values:
        return "'{}'::text[]"
    return 'array[' + ', '.join(q(v) for v in values) + ']::text[]'


class _DecimalEncoder(json.JSONEncoder):
    """Keeps Decimals as bare numbers rather than strings or floats."""

    def default(self, o):
        if isinstance(o, decimal.Decimal):
            return _Raw(str(o))
        return super().default(o)


class _Raw(float):
    """A number that serialises as its original digits.

    json.dumps() formats floats with repr(), so a float subclass carrying the
    original text and overriding __repr__ is the documented way through without
    hand-rolling a serialiser.
    """

    def __new__(cls, text):
        obj = super().__new__(cls, text)
        obj._text = text
        return obj

    def __repr__(self):
        return self._text


def qjson(value):
    """Quote a dict/list as a jsonb literal."""
    if value is None:
        return 'null'
    text = json.dumps(value, cls=_DecimalEncoder, ensure_ascii=False, sort_keys=True)
    return "'" + text.replace("'", "''") + "'::jsonb"


# ── Table sync ───────────────────────────────────────────────────────────────

def emit_sync(out, table, columns, key, rows, batch=500):
    """Emit upsert-everything + delete-what-is-missing for one table.

    columns  every data column, in order, as it appears in `rows`
    key      the primary key columns — the conflict target and the delete match
    rows     list of tuples of already-quoted SQL literals
    """
    data_cols = [c for c in columns if c not in key]
    collist = ', '.join(columns)

    out.write('\n-- %s: %d row%s\n' % (table, len(rows), '' if len(rows) == 1 else 's'))

    if rows:
        for start in range(0, len(rows), batch):
            chunk = rows[start:start + batch]
            out.write('insert into meganet.%s (%s, updated_by) values\n' % (table, collist))
            out.write(',\n'.join('  (%s, %s)' % (', '.join(r), q(IMPORT_TAG)) for r in chunk))
            out.write('\non conflict (%s) do update set\n' % ', '.join(key))
            out.write(',\n'.join('  %s = excluded.%s' % (c, c) for c in data_cols))
            out.write(',\n  updated_by = excluded.updated_by\n')
            # Only touch a row whose data actually differs. Without this the
            # updated_at trigger fires on every row on every run, and "when did
            # this station last change" stops meaning anything.
            out.write('where (%s)\n   is distinct from (%s);\n' % (
                ', '.join('meganet.%s.%s' % (table, c) for c in data_cols),
                ', '.join('excluded.%s' % c for c in data_cols)))
    else:
        out.write('-- (nothing in the file)\n')

    # Delete what the file no longer carries. Written as a NOT EXISTS against a
    # VALUES list so it stays one statement whatever the row count.
    if rows:
        keyed = [tuple(r[columns.index(k)] for k in key) for r in rows]
        out.write('delete from meganet.%s t where not exists (\n' % table)
        out.write('  select 1 from (values\n')
        out.write(',\n'.join('    (%s)' % ', '.join(k) for k in keyed))
        out.write('\n  ) as v(%s)\n' % ', '.join(key))
        out.write('  where %s\n);\n' % ' and '.join(
            't.%s = v.%s' % (k, k) for k in key))
    else:
        out.write('delete from meganet.%s;\n' % table)


IMPORT_TAG = 'import_stations_json.py'


def check_references(data):
    """Fail before emitting anything if the file points at things it does not define.

    Postgres enforces station.rm_system_id with a real foreign key, but
    radio_network_ids and catchment_ids are arrays, and Postgres has no
    per-element referential integrity. This is where that error is cheapest to
    catch — a bad id in an array would otherwise load silently and show up as a
    filter option that matches nothing.
    """
    networks = {n['id'] for n in data.get('radio_networks', [])}
    catchments = {c['id'] for c in data.get('catchments', [])}
    systems = {s['id'] for s in data.get('rm_systems', [])}
    problems = []

    seen = set()
    for s in data['stations']:
        if s['id'] in seen:
            problems.append('duplicate station id: %s' % s['id'])
        seen.add(s['id'])
        if s.get('rm_system_id') not in systems:
            problems.append('%s: unknown rm_system_id %r' % (s['id'], s.get('rm_system_id')))
        for n in s.get('radio_network_ids') or []:
            if n not in networks:
                problems.append('%s: unknown radio_network_id %r' % (s['id'], n))
        for c in s.get('catchment_ids') or []:
            if c not in catchments:
                problems.append('%s: unknown catchment_id %r' % (s['id'], c))

    # Not fatal, but worth saying out loud every time rather than leaving it to
    # be discovered: a range whose low is above its high passes no address at
    # all, in the app and in the database alike. Almost certainly a typo, but
    # which of the two numbers is wrong is not this script's call.
    for s in data['stations']:
        rep = s.get('repeater') or {}
        for field in ('pass_ranges', 'exclusions'):
            for rng in rep.get(field) or []:
                if rng['low'] > rng['high']:
                    print('warning: %s (%s): %s %s-%s is inverted and matches no '
                          'address' % (s['id'], s.get('name', ''), field.rstrip('s'),
                                       rng['low'], rng['high']), file=sys.stderr)

    if problems:
        for p in problems[:20]:
            print('error: %s' % p, file=sys.stderr)
        if len(problems) > 20:
            print('error: … and %d more' % (len(problems) - 20), file=sys.stderr)
        raise SystemExit('refusing to emit SQL for a file that does not hang together')


def build(data, out):
    stations = data['stations']

    out.write('-- Generated by tools/import_stations_json.py — do not edit.\n')
    out.write('-- Source: stations.json meta.version=%s meta.updated=%s\n'
              % (data.get('meta', {}).get('version'), data.get('meta', {}).get('updated')))
    out.write('-- %d stations, %d sensors, %d repeaters.\n'
              % (len(stations),
                 sum(len(s.get('sensors') or []) for s in stations),
                 sum(1 for s in stations if s.get('repeater'))))
    out.write('--\n-- Apply inside a transaction:\n')
    out.write('--   psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f this.sql\n')

    # meta — one row, and the check constraint on the table enforces that.
    meta = data.get('meta') or {}
    out.write('\n-- meta: the document header\n')
    out.write('insert into meganet.doc_meta (only_row, version, description, updated, rm_paths, updated_by)\n')
    out.write('values (true, %s, %s, %s, %s, %s)\n' % (
        q(meta.get('version', '')), q(meta.get('description', '')),
        q(meta.get('updated')), qjson(meta.get('rm_paths') or {}), q(IMPORT_TAG)))
    out.write('on conflict (only_row) do update set\n')
    out.write('  version = excluded.version,\n  description = excluded.description,\n')
    out.write('  updated = excluded.updated,\n  rm_paths = excluded.rm_paths,\n')
    out.write('  updated_by = excluded.updated_by\n')
    out.write('where (meganet.doc_meta.version, meganet.doc_meta.description,\n')
    out.write('       meganet.doc_meta.updated, meganet.doc_meta.rm_paths)\n')
    out.write('   is distinct from (excluded.version, excluded.description,\n')
    out.write('       excluded.updated, excluded.rm_paths);\n')

    emit_sync(out, 'rm_system',
              ['id', 'ord', 'name', 'tx_power_w', 'line_loss_db', 'supp_loss_db_m',
               'antenna_type', 'antenna_gain_dbi', 'antenna_height_m', 'rx_threshold_dbm'],
              ['id'],
              [[q(r['id']), q(i), q(r.get('name', '')), q(r.get('tx_power_w')),
                q(r.get('line_loss_db')), q(r.get('supp_loss_db_m')),
                q(r.get('antenna_type')), q(r.get('antenna_gain_dbi')),
                q(r.get('antenna_height_m')), q(r.get('rx_threshold_dbm'))]
               for i, r in enumerate(data.get('rm_systems', []))])

    emit_sync(out, 'radio_network',
              ['id', 'ord', 'name', 'description'], ['id'],
              [[q(r['id']), q(i), q(r.get('name', '')), q(r.get('description', ''))]
               for i, r in enumerate(data.get('radio_networks', []))])

    emit_sync(out, 'catchment',
              ['id', 'ord', 'name', 'basin_no', 'area_sqkm', 'region', 'border'], ['id'],
              [[q(r['id']), q(i), q(r.get('name', '')), q(r.get('basin_no')),
                q(r.get('area_sqkm')), q(r.get('region')), q(r.get('border'))]
               for i, r in enumerate(data.get('catchments', []))])

    # Stations. `site`, `lga`, `basin`, `legacy_unit_id`, `location_types` are
    # null in the database exactly when the key is absent from the document —
    # the view turns that back into an absent key. No station in the file
    # carries any of them as an empty value, so nothing is lost in the round
    # trip; tools/check_stations_doc.py is what proves that rather than assuming.
    emit_sync(out, 'station',
              ['id', 'ord', 'name', 'station_number', 'lat', 'lon', 'elevation_ahd',
               'roles', 'radio_network_ids', 'catchment_ids', 'alert_ids', 'satcom',
               'rm_system_id', 'enabled', 'notes', 'legacy_unit_id', 'site', 'lga',
               'basin', 'location_types'],
              ['id'],
              [[q(s['id']), q(i), q(s.get('name', '')), q(s.get('station_number', '')),
                q(s.get('lat')), q(s.get('lon')), q(s.get('elevation_ahd')),
                qarray(s.get('roles') or []), qarray(s.get('radio_network_ids') or []),
                qarray(s.get('catchment_ids') or []), qjson(s.get('alert_ids') or {}),
                qjson(s.get('satcom') or {}), q(s.get('rm_system_id')),
                q(bool(s.get('enabled'))), q(s.get('notes', '')),
                q(s.get('legacy_unit_id')), qjson(s.get('site')), q(s.get('lga')),
                q(s.get('basin')), qarray(s.get('location_types'))]
               for i, s in enumerate(stations)])

    sensors = []
    for s in stations:
        for i, sensor in enumerate(s.get('sensors') or []):
            sensors.append([q(s['id']), q(sensor.get('sensor_id', '')),
                            q(sensor.get('type', '')), q(i),
                            q(sensor.get('alert_id')), q(sensor.get('device_id'))])
    emit_sync(out, 'sensor',
              ['station_id', 'sensor_id', 'type', 'ord', 'alert_id', 'device_id'],
              ['station_id', 'sensor_id', 'type'], sensors)

    repeaters, ranges = [], []
    for s in stations:
        r = s.get('repeater')
        if not r:
            continue
        repeaters.append([q(s['id']), q(r.get('acma_licence', '')), q(r.get('rx_mhz')),
                          q(r.get('tx_mhz')), q(r.get('notes', ''))])
        for kind, field in (('pass', 'pass_ranges'), ('exclusion', 'exclusions')):
            for i, rng in enumerate(r.get(field) or []):
                ranges.append([q(s['id']), q(kind), q(rng['low']), q(rng['high']), q(i)])

    emit_sync(out, 'repeater',
              ['station_id', 'acma_licence', 'rx_mhz', 'tx_mhz', 'notes'],
              ['station_id'], repeaters)
    emit_sync(out, 'pass_range',
              ['repeater_id', 'kind', 'lo', 'hi', 'ord'],
              ['repeater_id', 'kind', 'lo', 'hi'], ranges)

    out.write('\n-- Row counts after this file, for the record:\n')
    out.write('--   stations %d · sensors %d · repeaters %d · pass ranges %d\n'
              % (len(stations), len(sensors), len(repeaters), len(ranges)))

    return {
        'stations': len(stations), 'sensors': len(sensors),
        'repeaters': len(repeaters), 'ranges': len(ranges),
        'radio_networks': len(data.get('radio_networks', [])),
        'catchments': len(data.get('catchments', [])),
        'rm_systems': len(data.get('rm_systems', [])),
    }


def main():
    ap = argparse.ArgumentParser(
        description='Emit SQL that syncs the meganet schema to stations.json.')
    ap.add_argument('--stations', default=DEFAULT_STATIONS,
                    help='path to stations.json (default: repo root)')
    ap.add_argument('--out', help='write SQL here instead of stdout')
    args = ap.parse_args()

    data = _load(args.stations)
    if not isinstance(data.get('stations'), list):
        raise SystemExit('%s has no stations[] array' % args.stations)
    check_references(data)

    handle = open(args.out, 'w', encoding='utf-8') if args.out else sys.stdout
    try:
        stats = build(data, handle)
    finally:
        if args.out:
            handle.close()

    for k in ('stations', 'sensors', 'repeaters', 'ranges',
              'radio_networks', 'catchments', 'rm_systems'):
        print('%-16s %6d' % (k, stats[k]), file=sys.stderr)
    if args.out:
        print('wrote %s' % args.out, file=sys.stderr)


if __name__ == '__main__':
    main()
