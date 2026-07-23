#!/usr/bin/env python3
"""
acma_diff.py — archive monthly ACMA subsets and detect what changed on the air.

PIPELINE POSITION
    spectra_rrl.zip (ACMA daily extract — never committed)
        └─ tools/acma_prefilter.py    → data/acma-raw/          (current subset)
              ├─ tools/acma_fetch.py  → data/acma-*.json        (threat layer)
              └─ tools/acma_diff.py   → data/acma-raw/<YYYY-MM>/  (archive)
                                        data/acma-snapshots.json  (index)
                                        data/acma-changes.json    (diffs + new IMD)

WHY ARCHIVING MATTERS
    ACMA publishes a daily snapshot, not an archive. A single extract lists
    what exists NOW: removals are invisible, prior parameter values are
    invisible, and nothing recovers a month that was never captured. Change
    detection therefore only works between snapshots this repo has retained —
    every monthly subset is kept forever under data/acma-raw/<YYYY-MM>/ and
    must never be deleted.

DIFF KEY
    SDD_ID is explicitly documented as non-persistent between extract runs, so
    diffs key on:
      - EFL_ID                          (apparatus licences — the common case)
      - DEVICE_REGISTRATION_IDENTIFIER  (spectrum licences)
      - a composite fingerprint LICENCE_NO|SITE_ID|FREQUENCY as a last resort,
        marked confidence=low (currently never needed: in the observed data
        every row carries one of the two real keys).

CHANGE CLASSES (per consecutive snapshot pair)
    added / removed          key appears / disappears
    freq                     FREQUENCY differs
    power                    TRANSMITTER_POWER or EIRP differs
    antenna                  HEIGHT / AZIMUTH / TILT / ANTENNA_ID differ
    site                     SITE_ID differs
    status                   licence STATUS_TEXT differs
    Added devices at a site within the co-site distance of a repeater are also
    flagged cotenant=true — the highest-severity case (desense + new IMD pairs).

NEW IMD PRODUCTS
    Every added (or re-tuned) transmitter forms a new third/fifth-order product
    with each existing transmitter at the same site. Products that land within
    tolerance of a repeater RX channel are listed with their arithmetic — this
    is the mechanism most likely to explain a noise-floor step with no obvious
    co-channel culprit.

USAGE
    python3 tools/acma_diff.py --archive   # archive data/acma-raw as its month,
                                           # then recompute index + diffs
    python3 tools/acma_diff.py             # recompute from archived months only
    python3 tools/acma_diff.py --dry-run   # report, write nothing

Stdlib only. Idempotent: diffs are recomputed from the archived snapshots on
every run, so a missed month or a re-archived month self-heals.

Contains ACMA Register of Radiocommunications Licences data, CC BY 4.0.
"""

import argparse
import csv
import json
import math
import os
import re
import shutil
import sys
from datetime import datetime, timezone

csv.field_size_limit(min(2**31 - 1, sys.maxsize))

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

MONTH_RE = re.compile(r'^\d{4}-\d{2}$')

BW_RX_HZ = 12500.0
COSITE_KM = 0.25            # matches the prefilter/fetch co-site distance

# Relative tolerance for "power changed" so W-precision rounding in the
# extract doesn't produce phantom changes.
POWER_REL_TOL = 0.01


def to_float(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def clean(v):
    v = (v or '').strip()
    return v or None


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def drop_nulls(d):
    return {k: v for k, v in d.items() if v is not None and v != '' and v != []}


def read_rows(path):
    with open(path, encoding='utf-8-sig', errors='replace', newline='') as fh:
        yield from csv.DictReader(fh)


# ── snapshot loading ──────────────────────────────────────────────────────────

def stable_key(lic, site_id, f_hz, efl_id, dri):
    """Same identity rule as acma_fetch.stable_key, from raw CSV fields."""
    if efl_id:
        return 'efl:%s' % efl_id, 'high'
    if dri:
        return 'dri:%s' % dri, 'high'
    return ('fp:%s|%s|%s' % (lic or '', site_id or '',
                             int(f_hz) if f_hz else ''), 'low')


def load_snapshot(snap_dir):
    """Parse one archived subset into diff-ready records keyed on the stable
    device identity."""
    licences = {}
    for r in read_rows(os.path.join(snap_dir, 'licence.csv')):
        no = clean(r.get('LICENCE_NO'))
        licences[no] = {
            'status': clean(r.get('STATUS_TEXT')),
            'client_no': clean(r.get('CLIENT_NO')),
            'type': clean(r.get('LICENCE_TYPE_NAME')),
            'issued': clean(r.get('DATE_ISSUED')),
            'effect': clean(r.get('DATE_OF_EFFECT')),
            'expiry': clean(r.get('DATE_OF_EXPIRY')),
        }

    clients = {}
    cpath = os.path.join(snap_dir, 'client.csv')
    if os.path.exists(cpath):
        for r in read_rows(cpath):
            clients[clean(r.get('CLIENT_NO'))] = (
                clean(r.get('TRADING_NAME')) or clean(r.get('LICENCEE')))

    sites = {}
    for r in read_rows(os.path.join(snap_dir, 'site.csv')):
        sid = clean(r.get('SITE_ID'))
        sites[sid] = {
            'name': clean(r.get('NAME')),
            'lat': to_float(r.get('LATITUDE')),
            'lon': to_float(r.get('LONGITUDE')),
            # written by the prefilter; may be absent in a hand-built subset
            'anchor': clean(r.get('_NEAREST_ANCHOR_ID')),
            'anchor_km': to_float(r.get('_DISTANCE_KM')),
        }

    devices = {}
    dup_fp = 0
    for r in read_rows(os.path.join(snap_dir, 'device_details.csv')):
        if (clean(r.get('DEVICE_TYPE')) or 'T').upper() != 'T':
            continue
        f_hz = to_float(r.get('FREQUENCY'))
        lic_no = clean(r.get('LICENCE_NO'))
        site_id = clean(r.get('SITE_ID'))
        key, confidence = stable_key(lic_no, site_id, f_hz,
                                     clean(r.get('EFL_ID')),
                                     clean(r.get('DEVICE_REGISTRATION_IDENTIFIER')))
        lic = licences.get(lic_no) or {}
        site = sites.get(site_id) or {}
        rec = {
            'key': key,
            'confidence': confidence,
            'sdd_id': clean(r.get('SDD_ID')),
            'lic': lic_no,
            'client': clients.get(lic.get('client_no')),
            'site_id': site_id,
            'site_name': site.get('name'),
            'anchor': site.get('anchor'),
            'anchor_km': site.get('anchor_km'),
            'f_hz': f_hz,
            'bw_hz': to_float(r.get('BANDWIDTH')),
            'emission': clean(r.get('EMISSION')),
            'tx_w': to_float(r.get('TRANSMITTER_POWER')),
            'eirp_w': to_float(r.get('EIRP')),
            'ant_id': clean(r.get('ANTENNA_ID')),
            'az': to_float(r.get('AZIMUTH')),
            'height_m': to_float(r.get('HEIGHT')),
            'tilt': to_float(r.get('TILT')),
            'auth': clean(r.get('AUTHORISATION_DATE')),
            'status': lic.get('status'),
        }
        if key in devices:
            # Sectorised installs can legitimately share a fingerprint when
            # both real keys are missing; keep the first, count the collision.
            dup_fp += 1
            continue
        devices[key] = rec
    return {'devices': devices, 'sites': sites, 'dup_keys': dup_fp}


# ── diffing ───────────────────────────────────────────────────────────────────

def _num_changed(a, b, rel_tol=0.0, abs_tol=0.0):
    if a is None and b is None:
        return False
    if a is None or b is None:
        return True
    if abs(a - b) <= abs_tol:
        return False
    return abs(a - b) > rel_tol * max(abs(a), abs(b))


def mhz(f_hz):
    return round(f_hz / 1e6, 6) if f_hz else None


def diff_snapshots(old, new):
    """Compare two snapshots keyed on stable identity. Returns change records
    (one per device, listing every changed field old→new)."""
    changes = []
    o, n = old['devices'], new['devices']

    for key, d in n.items():
        if key not in o:
            changes.append(drop_nulls({
                'class': 'added',
                'key': key,
                'confidence': d['confidence'] if d['confidence'] != 'high' else None,
                'cotenant': True if (d['anchor_km'] is not None and
                                     d['anchor_km'] <= COSITE_KM) else None,
                'device_id': d['sdd_id'],
                'lic': d['lic'], 'client': d['client'],
                'site_id': d['site_id'], 'site_name': d['site_name'],
                'anchor': d['anchor'], 'anchor_km': d['anchor_km'],
                'f_mhz': mhz(d['f_hz']), 'eirp_w': d['eirp_w'], 'tx_w': d['tx_w'],
                'auth': d['auth'], 'status': d['status'],
            }))

    for key, d in o.items():
        if key not in n:
            changes.append(drop_nulls({
                'class': 'removed',
                'key': key,
                'confidence': d['confidence'] if d['confidence'] != 'high' else None,
                # sdd_id is from the OLD extract — not resolvable against the
                # current device file, so no card link is offered for removals
                'lic': d['lic'], 'client': d['client'],
                'site_id': d['site_id'], 'site_name': d['site_name'],
                'anchor': d['anchor'], 'anchor_km': d['anchor_km'],
                'f_mhz': mhz(d['f_hz']), 'eirp_w': d['eirp_w'], 'tx_w': d['tx_w'],
                'auth': d['auth'], 'status': d['status'],
            }))

    for key, dn in n.items():
        do = o.get(key)
        if not do:
            continue
        fields = {}
        if _num_changed(do['f_hz'], dn['f_hz'], abs_tol=1.0):
            fields['f_mhz'] = [mhz(do['f_hz']), mhz(dn['f_hz'])]
        if _num_changed(do['tx_w'], dn['tx_w'], rel_tol=POWER_REL_TOL):
            fields['tx_w'] = [do['tx_w'], dn['tx_w']]
        if _num_changed(do['eirp_w'], dn['eirp_w'], rel_tol=POWER_REL_TOL):
            fields['eirp_w'] = [do['eirp_w'], dn['eirp_w']]
        if _num_changed(do['height_m'], dn['height_m'], abs_tol=0.01):
            fields['height_m'] = [do['height_m'], dn['height_m']]
        if _num_changed(do['az'], dn['az'], abs_tol=0.01):
            fields['az'] = [do['az'], dn['az']]
        if _num_changed(do['tilt'], dn['tilt'], abs_tol=0.01):
            fields['tilt'] = [do['tilt'], dn['tilt']]
        if do['ant_id'] != dn['ant_id']:
            fields['ant_id'] = [do['ant_id'], dn['ant_id']]
        if do['site_id'] != dn['site_id']:
            fields['site_id'] = [do['site_id'], dn['site_id']]
        if (do['status'] or '') != (dn['status'] or ''):
            fields['status'] = [do['status'], dn['status']]
        if not fields:
            continue
        classes = []
        if 'f_mhz' in fields:
            classes.append('freq')
        if 'tx_w' in fields or 'eirp_w' in fields:
            classes.append('power')
        if any(k in fields for k in ('height_m', 'az', 'tilt', 'ant_id')):
            classes.append('antenna')
        if 'site_id' in fields:
            classes.append('site')
        if 'status' in fields:
            classes.append('status')
        changes.append(drop_nulls({
            'class': classes[0],
            'classes': classes if len(classes) > 1 else None,
            'key': key,
            'confidence': dn['confidence'] if dn['confidence'] != 'high' else None,
            'device_id': dn['sdd_id'],
            'lic': dn['lic'], 'client': dn['client'],
            'site_id': dn['site_id'], 'site_name': dn['site_name'],
            'anchor': dn['anchor'], 'anchor_km': dn['anchor_km'],
            'f_mhz': mhz(dn['f_hz']), 'eirp_w': dn['eirp_w'], 'tx_w': dn['tx_w'],
            'auth': dn['auth'], 'status': dn['status'],
            'fields': fields,
        }))

    order = {'added': 0, 'removed': 1, 'freq': 2, 'power': 3, 'antenna': 4,
             'site': 5, 'status': 6}
    changes.sort(key=lambda c: (0 if c.get('cotenant') else 1,
                                order.get(c['class'], 9),
                                c.get('anchor_km') or 1e9))
    return changes


# ── new IMD products ──────────────────────────────────────────────────────────

def tol_hz(*bws):
    known = [b for b in bws if b] or [BW_RX_HZ]
    return min(max(12.5e3, (sum(known) + BW_RX_HZ) / 2.0), 100e3)


def load_anchors(stations_path):
    with open(stations_path, encoding='utf-8') as fh:
        data = json.load(fh)
    anchors = []
    for s in data.get('stations', []):
        if 'repeater' not in (s.get('roles') or []):
            continue
        r = s.get('repeater') or {}
        if s.get('lat') is None or s.get('lon') is None or not r.get('rx_mhz'):
            continue
        anchors.append({'id': s['id'], 'name': s.get('name'),
                        'lat': s['lat'], 'lon': s['lon'],
                        'rx_mhz': r['rx_mhz']})
    return anchors


def new_imd_products(changes, new_snap, anchors, radius_km=60.0):
    """Third/fifth-order intermod products that exist ONLY because a device was
    added or re-tuned in this snapshot pair. Pairs the new/changed device with
    every other transmitter at the same ACMA site and keeps products landing
    within tolerance of a repeater RX channel."""
    by_site = {}
    for d in new_snap['devices'].values():
        if d['f_hz']:
            by_site.setdefault(d['site_id'], []).append(d)

    site_anchor_rx = {}          # site_id → [(anchor, dist_km)]
    for sid, s in new_snap['sites'].items():
        if s['lat'] is None or s['lon'] is None:
            continue
        hits = [(a, haversine_km(s['lat'], s['lon'], a['lat'], a['lon']))
                for a in anchors]
        hits = [(a, dk) for a, dk in hits if dk <= radius_km]
        if hits:
            site_anchor_rx[sid] = hits

    products = []
    seen = set()
    triggers = [c for c in changes if c['class'] == 'added' or
                'freq' in (c.get('classes') or [c['class']])]
    for c in triggers:
        d1 = new_snap['devices'].get(c['key'])
        if not d1 or not d1['f_hz']:
            continue
        partners = [d for d in by_site.get(d1['site_id'], []) if d['key'] != d1['key']]
        anchor_hits = site_anchor_rx.get(d1['site_id'], [])
        if not partners or not anchor_hits:
            continue
        f1 = d1['f_hz']
        for d2 in partners:
            f2 = d2['f_hz']
            if abs(f1 - f2) <= 1000:
                continue
            t = tol_hz(d1['bw_hz'], d2['bw_hz'])
            # both roles for each order: the new carrier can be either leg
            combos = [(3, 2 * f1 - f2, '2 × %.4f − %.4f' % (f1 / 1e6, f2 / 1e6)),
                      (3, 2 * f2 - f1, '2 × %.4f − %.4f' % (f2 / 1e6, f1 / 1e6)),
                      (5, 3 * f1 - 2 * f2, '3 × %.4f − 2 × %.4f' % (f1 / 1e6, f2 / 1e6)),
                      (5, 3 * f2 - 2 * f1, '3 × %.4f − 2 × %.4f' % (f2 / 1e6, f1 / 1e6))]
            for order, prod, formula in combos:
                for a, dk in anchor_hits:
                    dh = prod - a['rx_mhz'] * 1e6
                    if abs(dh) > t:
                        continue
                    sig = (d1['key'], d2['key'], order, round(prod), a['id'])
                    if sig in seen:
                        continue
                    seen.add(sig)
                    products.append(drop_nulls({
                        'trigger_key': d1['key'],
                        'trigger_class': c['class'],
                        'device_id': d1['sdd_id'],
                        'partner_key': d2['key'],
                        'partner_device_id': d2['sdd_id'],
                        'partner_client': d2['client'],
                        'site_id': d1['site_id'],
                        'site_name': d1['site_name'],
                        'order': order,
                        'formula': '%s = %.4f MHz' % (formula, prod / 1e6),
                        'product_mhz': round(prod / 1e6, 6),
                        'anchor': a['id'],
                        'rx_mhz': a['rx_mhz'],
                        'delta_khz': round(dh / 1e3, 2),
                        'anchor_km': round(dk, 2),
                        'client': d1['client'],
                    }))
    products.sort(key=lambda p: abs(p['delta_khz']))
    return products


# ── archive management ────────────────────────────────────────────────────────

def subset_meta(subset_dir):
    path = os.path.join(subset_dir, '_manifest.json')
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def archive_current(raw_dir, month=None, dry_run=False):
    """Copy the current subset (top-level CSVs + manifest) into
    raw_dir/<YYYY-MM>/. Re-archiving the same month replaces it with the newer
    extract of that month; other months are never touched, never deleted."""
    meta = subset_meta(raw_dir)
    month = month or (meta.get('generated') or '')[:7]
    if not MONTH_RE.match(month or ''):
        raise SystemExit('Cannot determine snapshot month from %s/_manifest.json; '
                         'pass --month YYYY-MM.' % raw_dir)
    dest = os.path.join(raw_dir, month)
    files = sorted(n for n in os.listdir(raw_dir)
                   if n.endswith('.csv') or n == '_manifest.json')
    if not files:
        raise SystemExit('No subset CSVs found in %s.' % raw_dir)
    if dry_run:
        print('--dry-run: would archive %d files to %s/' % (len(files), dest))
        return month
    replacing = os.path.isdir(dest)
    os.makedirs(dest, exist_ok=True)
    for n in files:
        shutil.copy2(os.path.join(raw_dir, n), os.path.join(dest, n))
    print('%s %d files → %s/' %
          ('Re-archived (same month, newer extract):' if replacing else 'Archived:',
           len(files), dest))
    return month


def list_snapshot_months(raw_dir):
    months = []
    for n in sorted(os.listdir(raw_dir)):
        p = os.path.join(raw_dir, n)
        if MONTH_RE.match(n) and os.path.isdir(p) and \
                os.path.exists(os.path.join(p, 'device_details.csv')):
            months.append(n)
    return months


# ── main ──────────────────────────────────────────────────────────────────────

def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--raw', default=os.path.join(REPO, 'data', 'acma-raw'),
                    help='subset directory holding current CSVs and <YYYY-MM>/ '
                         'archives (default: data/acma-raw)')
    ap.add_argument('--out', default=os.path.join(REPO, 'data'),
                    help='output directory for the index/changes JSON (default: data/)')
    ap.add_argument('--stations', default=os.path.join(REPO, 'stations.json'))
    ap.add_argument('--archive', action='store_true',
                    help='first archive the current subset as its extract month')
    ap.add_argument('--month', default=None,
                    help='override the archive month (YYYY-MM; default: from '
                         'the subset manifest)')
    ap.add_argument('--radius-km', type=float, default=60.0,
                    help='anchor radius for the new-IMD check (default 60)')
    ap.add_argument('--dry-run', action='store_true',
                    help='report what would be written, write nothing')
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not os.path.isdir(args.raw):
        raise SystemExit('%s not found — run tools/acma_prefilter.py first.' % args.raw)

    if args.archive:
        archive_current(args.raw, args.month, args.dry_run)

    months = list_snapshot_months(args.raw)
    if not months:
        raise SystemExit('No archived snapshots under %s/<YYYY-MM>/. '
                         'Run with --archive to create the first one — every '
                         'month not captured is unrecoverable.' % args.raw)
    print('Archived snapshots: %s' % ', '.join(months))

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    attribution = ('Contains data from the Australian Communications and Media '
                   'Authority, Register of Radiocommunications Licences (CC BY 4.0).')

    snap_index = []
    for m in months:
        meta = subset_meta(os.path.join(args.raw, m))
        counts = meta.get('counts') or {}
        snap_index.append(drop_nulls({
            'month': m,
            'extract_date': (meta.get('generated') or '')[:10] or None,
            'devices': counts.get('devices'),
            'licences': counts.get('licences'),
            'sites': counts.get('sites'),
            'bytes': meta.get('total_bytes'),
            'parameters': meta.get('parameters'),
        }))

    anchors = load_anchors(args.stations)
    pairs = []
    loaded = {}

    def snap(m):
        if m not in loaded:
            loaded[m] = load_snapshot(os.path.join(args.raw, m))
        return loaded[m]

    for prev, cur in zip(months, months[1:]):
        old, new = snap(prev), snap(cur)
        changes = diff_snapshots(old, new)
        imd = new_imd_products(changes, new, anchors, args.radius_km)
        by_class = {}
        for c in changes:
            for cl in (c.get('classes') or [c['class']]):
                by_class[cl] = by_class.get(cl, 0) + 1
        cotenants = sum(1 for c in changes if c.get('cotenant'))
        print('%s → %s: %d changed devices (%s)%s, %d new IMD products on RX channels'
              % (prev, cur, len(changes),
                 ', '.join('%s %d' % kv for kv in sorted(by_class.items())) or 'none',
                 (', %d new co-tenants' % cotenants) if cotenants else '',
                 len(imd)))
        pairs.append(drop_nulls({
            'from': prev, 'to': cur,
            'from_date': next((s.get('extract_date') for s in snap_index
                               if s['month'] == prev), None),
            'to_date': next((s.get('extract_date') for s in snap_index
                             if s['month'] == cur), None),
            'counts': by_class,
            'cotenants': cotenants or None,
            'changes': changes,
            'new_imd': imd,
        }))

    if not pairs:
        print('Only one snapshot so far — diffs begin when the next monthly '
              'refresh archives a second one.')

    changes_out = {
        'meta': {
            'generated': now,
            'attribution': attribution,
            'note': 'Diffs between consecutive archived monthly subsets, keyed '
                    'on EFL_ID / DEVICE_REGISTRATION_IDENTIFIER (never SDD_ID, '
                    'which is not persistent between extracts). A register '
                    'change is paperwork: an upper bound on when RF conditions '
                    'could have changed, not proof that they did.',
            'cosite_km': COSITE_KM,
            'snapshots': len(months),
        },
        'pairs': pairs,
    }
    snapshots_out = {
        'meta': {
            'generated': now,
            'attribution': attribution,
            'note': 'Index of archived monthly ACMA subsets under '
                    'data/acma-raw/<YYYY-MM>/. Snapshots are irreplaceable — '
                    'ACMA publishes no back-catalogue — and must never be deleted.',
        },
        'snapshots': snap_index,
    }

    if args.dry_run:
        print('--dry-run: nothing written.')
        return

    os.makedirs(args.out, exist_ok=True)
    for name, obj in (('acma-changes.json', changes_out),
                      ('acma-snapshots.json', snapshots_out)):
        path = os.path.join(args.out, name)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(obj, fh, separators=(',', ':'), ensure_ascii=False)
        print('  %-24s %8.2f KB' % (name, os.path.getsize(path) / 1e3))


if __name__ == '__main__':
    main()
