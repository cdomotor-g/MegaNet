#!/usr/bin/env python3
"""
fldwarn_kmz_2024.py — read the Bureau's 2024 "FldWarn Stations and paths" KMZ
into JSON, and write the changes it led to into Flood-Net.

WHAT THE KMZ IS
    A Google Earth file the Queensland flood warning team kept in 2024: one
    folder per basin of station pins, each described "number : what it
    observes : how it reports" ("540322 : RN : ALERT"), and nine folders of
    radio paths, each a straight line named "<sender> to <receiver>" in a
    folder named for its frequency. 2,348 pins, 180 paths.

    The pins are the Bureau's own list of the time, positions to the second of
    arc, with some of them dragged by hand afterwards to where the station
    really is. A dragged pin is the only kind that does not land on a whole
    second, so `hand_placed` below is a fact about the pin, not a guess.

    One folder is misnamed: "Frequency = 125.400 Mhz" is 152.400. ACMA licenses
    the Bureau on 152.400 at exactly the sites those paths join, and Flood-Net
    already had O'Reillys and Laheys sending on 152.4. `mhz` is the corrected
    figure; `folder_mhz` keeps the one written.

WHAT IT CHANGED
    Not by itself. Every pin was checked against Flood-Net, the Bureau's
    September 2026 lists (data/river-height-stations.json), Flood-Net's station
    history and references neither came from — ACMA licence sites, Queensland's
    gauging stations and watercourses, terrain, aerial imagery — and a person
    decided what to apply. data/fldwarn-2024/review.json is that decision, one
    row per station with its reason; this tool's --sql writes exactly what it
    says. data/fldwarn-2024/README.md has the summary and what was left alone.

USE
    python3 tools/ingest/fldwarn_kmz_2024.py --extract ~/Downloads/FldWarn*.kmz
        writes data/fldwarn-2024/kmz.json from the KMZ (not in the repo: it is
        somebody else's export, the same rule as the basin and hub KMZs)
    python3 tools/ingest/fldwarn_kmz_2024.py --sql \\
        | psql "$MEGANET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
        writes review.json into the database

    The SQL moves a station only while it is still where the review found it,
    adds a pass range only to a repeater that has none, and fills a frequency or
    a network only where it is empty, so a second run changes nothing and a
    station somebody moved since is left as they put it. Every row it writes is
    stamped `updated_by = 'fldwarn kmz 2024 (claude)'`, which is the name the
    station history shows. Then refresh stations.json
    (tools/snapshot_stations_json.py), because the file is a copy.

Standard library only, like the rest of tools/.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT_DIR = os.path.join(REPO, 'data', 'fldwarn-2024')
KML = '{http://www.opengis.net/kml/2.2}'
STAMP = 'fldwarn kmz 2024 (claude)'


# ── Reading the KMZ ──────────────────────────────────────────────────────────

def whole_second(deg):
    s = abs(deg) * 3600
    return abs(s - round(s)) < 0.02


def _folders(el, path):
    for ch in el:
        tag = ch.tag.replace(KML, '')
        if tag in ('Folder', 'Document'):
            n = ch.find(KML + 'name')
            yield from _folders(ch, path + [n.text.strip() if n is not None and n.text else ''])
        elif tag == 'Placemark':
            yield path, ch


def _styles(doc):
    """styleUrl → pushpin colour, through the StyleMaps, so a pin's colour is
    the one Google Earth showed."""
    icon = {}
    for st in doc.iter(KML + 'Style'):
        h = st.find(f'{KML}IconStyle/{KML}Icon/{KML}href')
        if h is not None and h.text:
            m = re.search(r'/(\w+)-pushpin\.png', h.text)
            icon[st.get('id')] = m.group(1) if m else None
    normal = {}
    for sm in doc.iter(KML + 'StyleMap'):
        for p in sm.findall(KML + 'Pair'):
            if p.findtext(KML + 'key') == 'normal':
                normal[sm.get('id')] = (p.findtext(KML + 'styleUrl') or '').lstrip('#')
    return lambda url: icon.get(normal.get(url.lstrip('#'), url.lstrip('#'))) if url else None


def _km(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    h = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b[1] - a[1]) / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def _squash(t):
    return re.sub(r'[^a-z]', '', (t or '').lower())


def extract(kmz_path):
    with zipfile.ZipFile(kmz_path) as z:
        kml = next(n for n in z.namelist() if n.lower().endswith('.kml'))
        root = ET.fromstring(z.read(kml))
    doc = root.find(KML + 'Document')
    colour = _styles(doc)
    pins, lines = [], []
    for path, pm in _folders(doc, []):
        name = (pm.findtext(KML + 'name') or '').strip()
        desc = (pm.findtext(KML + 'description') or '').strip()
        pt = pm.find(f'.//{KML}Point/{KML}coordinates')
        ls = pm.find(f'.//{KML}LineString/{KML}coordinates')
        if pt is not None:
            lon, lat = (float(v) for v in pt.text.strip().split(',')[:2])
            parts = [p.strip() for p in desc.split(':')]
            num = parts[0] if parts and re.fullmatch(r'\d{5,6}', parts[0]) else ''
            pins.append({
                'basin': path[-1], 'name': name, 'number': num,
                'observes': parts[1] if len(parts) > 1 else '',
                'network': parts[2] if len(parts) > 2 else '',
                'lat': round(lat, 8), 'lon': round(lon, 8),
                'hand_placed': not (whole_second(lat) and whole_second(lon)),
                'pushpin': colour(pm.findtext(KML + 'styleUrl')),
            })
        elif ls is not None:
            pts = [tuple(float(v) for v in c.split(',')[:2]) for c in ls.text.split()]
            lines.append((path, name, [(pts[0][1], pts[0][0]), (pts[-1][1], pts[-1][0])]))
    paths = []
    for path, name, ends in lines:
        folder_mhz = float(re.search(r'([\d.]+)\s*Mhz', path[-1], re.I).group(1))
        mhz = 152.4 if abs(folder_mhz - 125.4) < 1e-9 else folder_mhz
        near = [min(pins, key=lambda p: _km(e, (p['lat'], p['lon']))) for e in ends]
        sender, receiver = near
        label = re.split(r'\s+to\s+', name, flags=re.I)
        # The name says which end sends; the line's own direction does not.
        if len(label) == 2 and _squash(near[1]['name']).startswith(_squash(label[0])[:6]) \
                and not _squash(near[0]['name']).startswith(_squash(label[0])[:6]):
            sender, receiver = near[1], near[0]
        paths.append({
            'name': name, 'region': path[-2].replace(' ALERT Radio Paths', ''),
            'folder_mhz': folder_mhz, 'mhz': mhz,
            'from': sender['name'], 'from_number': sender['number'],
            'to': receiver['name'], 'to_number': receiver['number'],
            'ends': [[round(a, 8), round(b, 8)] for a, b in ends],
        })
    return {
        'source': os.path.basename(kmz_path),
        'pins': pins, 'paths': paths,
    }


# ── Writing review.json into the database ────────────────────────────────────

def q(v):
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, tuple)):
        return ('array[' + ', '.join(q(x) for x in v) + ']::text[]') if v else "'{}'::text[]"
    return "'" + str(v).replace("'", "''") + "'"


def values(rows, types):
    """VALUES rows; the first carries a cast per column, which is what types
    a VALUES list."""
    out = []
    for i, r in enumerate(rows):
        out.append('  (' + ', '.join(q(v) + (f'::{t}' if i == 0 and t else '')
                                     for v, t in zip(r, types)) + ')')
    return ',\n'.join(out)


def append_note(col, note_sql):
    return (f"case when {col} = '' then {note_sql} "
            f"when position({note_sql} in {col}) > 0 then {col} "
            f"else {col} || E'\\n\\n' || {note_sql} end")


def render_sql(review):
    S = q(STAMP)
    out = ['-- Generated by tools/ingest/fldwarn_kmz_2024.py from data/fldwarn-2024/review.json.',
           '-- Run in one transaction. Every write is guarded so a second run changes nothing.', '']

    moves = [p for p in review['positions'] if p['action'] == 'move']
    notes = {n['id']: n['note'] for n in review.get('notes', [])}
    out += ['-- Positions: only where the station is still where the review found it.',
            '-- A modelled height follows its pin; a surveyed one stays with the station.',
            'with v(id, from_lat, from_lon, lat, lon, elevation_ahd, elevation_source, catchment_ids, note) as (values',
            values([(p['id'], p['from'][0], p['from'][1], p['to'][0], p['to'][1],
                     p.get('elevation_ahd'), p.get('elevation_source'), p.get('catchment_ids'), notes.get(p['id']))
                    for p in moves],
                   ['text', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'text', 'text[]', 'text']),
            ')',
            'update meganet.station s set',
            '  lat = v.lat, lon = v.lon,',
            '  elevation_ahd = coalesce(v.elevation_ahd, s.elevation_ahd),',
            '  elevation_source = case when v.elevation_ahd is null then s.elevation_source else v.elevation_source end,',
            '  catchment_ids = coalesce(v.catchment_ids, s.catchment_ids),',
            "  notes = case when v.note is null then s.notes else " + append_note('s.notes', 'v.note') + " end,",
            f'  updated_by = {S}',
            'from v where s.id = v.id and s.lat = v.from_lat and s.lon = v.from_lon;', '']

    out += ['-- Names the Bureau\'s 20-character field cut short.',
            'update meganet.station s set name = v.now, updated_by = ' + S,
            'from (values', values([(n['id'], n['was'], n['now']) for n in review['names']], ['text', 'text', 'text']),
            ') v(id, was, now) where s.id = v.id and s.name = v.was;', '']

    out.append('-- Radio. Frequencies and networks only where empty; a repeater gets pass')
    out.append('-- ranges only if it has none, so no range Flood-Net already holds is touched.')
    for r in review['radio']:
        sid = q(r['id'])
        out.append(f"-- {r['id']}: {r['why']}")
        # The station row in one statement, so its history shows one change.
        sets, would = [], []
        if r['kind'] != 'frequencies':
            sets.append("roles = case when 'repeater' = any(roles) then roles else roles || array['repeater'] end")
            would.append("not 'repeater' = any(roles)")
        if r.get('networks'):
            sets.append(f"radio_network_ids = case when radio_network_ids = '{{}}' then {q(r['networks'])} "
                        "else radio_network_ids end")
            would.append("radio_network_ids = '{}'")
        if r.get('note'):
            sets.append('notes = ' + append_note('notes', 'n.t'))
            would.append("position(n.t in notes) = 0")
        if r.get('owner'):
            sets.append(f"owner = coalesce(owner, {q(r['owner'])})")
            would.append('owner is null')
        if sets:
            note = (f"with n(t) as (values ({q(r['note'])})) ", ' from n') if r.get('note') else ('', '')
            out.append(f"{note[0]}update meganet.station set {', '.join(sets)}, updated_by = {S}{note[1]} "
                       f"where id = {sid} and ({' or '.join(would)});")
        if r['kind'] != 'frequencies':
            out.append('insert into meganet.repeater (station_id, acma_licence, rx_mhz, tx_mhz, notes, updated_by) '
                       f"values ({sid}, {q(r['acma'])}, {q(r['rx'])}, {q(r['tx'])}, '', {S}) "
                       'on conflict (station_id) do nothing;')
        out.append(f"update meganet.repeater set rx_mhz = {q(r['rx'])}, tx_mhz = {q(r['tx'])}, "
                   f"acma_licence = case when acma_licence = '' then {q(r['acma'])} else acma_licence end, "
                   f"updated_by = {S} where station_id = {sid} and rx_mhz is null and tx_mhz is null;")
        if r.get('ranges'):
            rows = ', '.join(f"({sid}, 'pass', {lo}, {hi}, {i}, {S})" for i, (lo, hi) in enumerate(r['ranges']))
            out.append('insert into meganet.pass_range (repeater_id, kind, lo, hi, ord, updated_by) '
                       f'select * from (values {rows}) v(repeater_id, kind, lo, hi, ord, updated_by) '
                       f'where not exists (select 1 from meganet.pass_range p where p.repeater_id = {sid});')
        for i, f in enumerate(r.get('frequencies', [])):
            out.append('insert into meganet.station_frequency (station_id, ord, rx_mhz, tx_mhz, label, acma_licence, updated_by) '
                       f"values ({sid}, {i}, {q(f['rx_mhz'])}, {q(f['tx_mhz'])}, {q(f['label'])}, "
                       f"{q(f['acma_licence'])}, {S}) on conflict (station_id, ord) do nothing;")
        out.append('')

    out.append('-- Base stations the KMZ paths end at, after the last station in the document.')
    for i, b in enumerate(review['bases'], 1):
        out.append('insert into meganet.station (id, ord, name, station_number, lat, lon, elevation_ahd, elevation_source, '
                   'roles, radio_network_ids, catchment_ids, alert_ids, satcom, rm_system_id, enabled, notes, hub_id, '
                   'owner, document_managed, updated_by)')
        out.append(f"select {q(b['id'])}, (select max(ord) from meganet.station) + 1, {q(b['name'])}, "
                   f"{q(b['station_number'])}, {q(b['lat'])}, {q(b['lon'])}, {q(b.get('elevation_ahd'))}, "
                   f"{q(b.get('elevation_source'))}, array['base']::text[], {q(b['networks'])}, {q(b['catchment_ids'])}, "
                   "'{}'::jsonb, '{\"enabled\": false, \"provider\": \"\", \"terminal_id\": \"\"}'::jsonb, 1, true, "
                   f"{q(b['note'])}, {q(b['hub_id'])}, {q(b['owner'])}, true, {S}")
        out.append(f"where not exists (select 1 from meganet.station where id = {q(b['id'])});")
        for j, f in enumerate(b['frequencies']):
            out.append('insert into meganet.station_frequency (station_id, ord, rx_mhz, tx_mhz, label, acma_licence, updated_by) '
                       f"values ({q(b['id'])}, {j}, {q(f['rx_mhz'])}, {q(f['tx_mhz'])}, {q(f['label'])}, "
                       f"{q(f['acma_licence'] or None)}, {S}) on conflict (station_id, ord) do nothing;")
    out.append('')
    if review.get('round2'):
        out += render_round2(review['round2'])
    return '\n'.join(out)


def render_round2(r2):
    """The second round, on the owner's answers: the FCRC base, the stations the
    KMZ has and Flood-Net did not (switched off unless the Bureau's December 2025
    SLS still lists them), every station's type, and Laheys Lookout's inverted
    range."""
    S = q(STAMP)
    out = ['-- Round two.', '']
    f = r2['fcrc']
    note = q(f['note'])
    out += ["-- Flood-Net's 260127 is the KMZ's FCRC Base Station.",
            f"update meganet.station set name = {q(f['name'])}, roles = {q(f['roles'])}, owner = coalesce(owner, {q(f['owner'])}), "
            f"lat = {q(f['to'][0])}, lon = {q(f['to'][1])}, elevation_ahd = {q(f['elevation_ahd'])}, "
            f"elevation_source = {q(f['elevation_source'])}, catchment_ids = {q(f['catchment_ids'])}, "
            f"notes = {append_note('notes', note)}, updated_by = {S} "
            f"where id = {q(f['id'])} and lat = {q(f['from_'][0])} and lon = {q(f['from_'][1])};"]
    for i, fr in enumerate(f['frequencies']):
        out.append('insert into meganet.station_frequency (station_id, ord, rx_mhz, tx_mhz, label, acma_licence, updated_by) '
                   f"values ({q(f['id'])}, {i}, {q(fr['rx_mhz'])}, {q(fr['tx_mhz'])}, {q(fr['label'])}, "
                   f"{q(fr['acma_licence'])}, {S}) on conflict (station_id, ord) do nothing;")
    out += ['', "-- Stations in the KMZ that Flood-Net did not have: switched on if the December 2025 SLS lists them, off if not.",
            'insert into meganet.station (id, ord, name, station_number, lat, lon, elevation_ahd, elevation_source, roles, '
            'radio_network_ids, catchment_ids, alert_ids, satcom, rm_system_id, enabled, notes, hub_id, station_type, '
            'document_managed, updated_by)',
            "select v.id, (select max(ord) from meganet.station) + v.n, v.name, v.num, v.lat, v.lon, v.elev, v.src, "
            "array['field']::text[], '{}'::text[], v.catch, '{}'::jsonb, "
            "'{\"enabled\": false, \"provider\": \"\", \"terminal_id\": \"\"}'::jsonb, 1, v.enabled, v.note, v.hub, v.stype, true, " + S,
            'from (values',
            values([(i, o['id'], o['name'], o['station_number'], o['lat'], o['lon'], o['elevation_ahd'], o['elevation_source'],
                     o['catchment_ids'], o['note'], o['hub_id'], o['station_type'], o['enabled'])
                    for i, o in enumerate(r2['old_stations'], 1)],
                   ['int', 'text', 'text', 'text', 'numeric', 'numeric', 'numeric', 'text', 'text[]', 'text', 'text', 'text', 'boolean']),
            ') v(n, id, name, num, lat, lon, elev, src, catch, note, hub, stype, enabled)',
            'where not exists (select 1 from meganet.station s where s.id = v.id);']
    fc = [(o['id'], i, c['as_at'], c.get('first_report_m'), c.get('crossing_height_m'), c.get('crossing_type'), c.get('minor_m'),
           c.get('crops_grazing_m'), c.get('moderate_m'), c.get('towns_m'), c.get('major_m'), c.get('note'))
          for o in r2['old_stations'] for i, c in enumerate(o['flood_classes'])]
    if fc:
        out += ['insert into meganet.station_flood_class (station_id, ord, as_at, first_report_m, crossing_height_m, crossing_type, '
                'minor_m, crops_grazing_m, moderate_m, towns_m, major_m, note, updated_by)',
                f'select v.*, {S} from (values',
                values(fc, ['text', 'int', 'date', 'numeric', 'numeric', 'text', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'text']),
                ') v(station_id, ord, as_at, first_report_m, crossing_height_m, crossing_type, minor_m, crops_grazing_m, moderate_m, towns_m, major_m, note)',
                'where not exists (select 1 from meganet.station_flood_class c where c.station_id = v.station_id);']
    out += ['', "-- Each station's type, only where it has none. " + r2['station_type_rule']]
    by_type = {}
    for t in r2['station_types']:
        by_type.setdefault(t['station_type'], []).append(t['id'])
    for code, ids in sorted(by_type.items()):
        out.append(f"update meganet.station set station_type = {q(code)}, updated_by = {S} "
                   f"where station_type is null and id in ({', '.join(q(i) for i in ids)});")
    lh = r2['laheys']
    out += ['', f"-- {lh['why']}",
            f"update meganet.pass_range set lo = {lh['now'][0]}, hi = {lh['now'][1]}, updated_by = {S} "
            f"where repeater_id = {q(lh['id'])} and kind = 'pass' and lo = {lh['was'][0]} and hi = {lh['was'][1]};", '']
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--extract', metavar='KMZ', help='read the KMZ and write data/fldwarn-2024/kmz.json')
    g.add_argument('--sql', action='store_true', help='print the SQL that writes review.json into the database')
    ap.add_argument('--review', default=os.path.join(OUT_DIR, 'review.json'))
    a = ap.parse_args(argv)
    if a.extract:
        doc = extract(a.extract)
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(os.path.join(OUT_DIR, 'kmz.json'), 'w', encoding='utf-8') as fh:
            json.dump(doc, fh, indent=1, ensure_ascii=False)
            fh.write('\n')
        hand = sum(p['hand_placed'] for p in doc['pins'])
        print(f"kmz.json: {len(doc['pins'])} pins ({hand} placed by hand), {len(doc['paths'])} paths", file=sys.stderr)
        return 0
    with open(a.review, encoding='utf-8') as fh:
        sys.stdout.write(render_sql(json.load(fh)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
