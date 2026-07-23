#!/usr/bin/env python3
"""
acma_fetch.py — classify ACMA-licensed transmitters as interference candidates
against MegaNet repeater RX channels, and emit the static JSON the map reads.

PIPELINE POSITION
    spectra_rrl.zip (ACMA daily extract, ~68 MB — never committed)
        └─ tools/acma_prefilter.py       → data/acma-raw/   (committed subset)
              └─ tools/acma_fetch.py     → data/acma-*.json (committed, read by app.js)

    Despite the name (kept from the original design), this script performs no
    network fetch: the sandboxed environment has no egress to acma.gov.au. Input
    is the prefiltered CSV subset in data/acma-raw/ (default) or the full
    extract zip via --zip. Both carry ACMA's own table and column names.

SCHEMA FACTS (confirmed against the ACMA data dictionary + Oracle DDL shipped
inside the extract, DOC/cr_tables_oracle.sql):
    - DEVICE_DETAILS.FREQUENCY / BANDWIDTH / CARRIER_FREQ are in HERTZ.
      151.5 MHz == 151500000. Verified on import; aborts loudly if magnitudes
      look wrong.
    - SITE.LATITUDE/LONGITUDE are decimal degrees, GDA94.
    - DEVICE_TYPE: 'T' transmit / 'R' receive. Only 'T' rows are classified.
    - Power: TRANSMITTER_POWER + unit, EIRP + unit (observed 'W' throughout;
      dBW/dBm/kW/mW handled defensively).
    - licence.STATUS_TEXT gives currency directly ('Granted' etc.).
    - SITE_PRECISION: 'Within 10 metres' / 'Within 100 metres' / 'Unknown'.
    - Advisory notes / special conditions in APPLIC_TEXT_BLOCK join two ways:
      APTB_TABLE_PREFIX='LI' via LICENCE_NO, ='TCS' via APTB_TABLE_ID=TCS_ID.

MECHANISMS (per repeater RX frequency f_rx):
    co_channel       |f_dev − f_rx| ≤ 6.25 kHz
    adjacent         6.25 kHz < |Δf| ≤ 25 kHz (1st) or ≤ 50 kHz (2nd, downweighted)
    harmonic         n·f_dev within tol of f_rx for n = 2..5 (sources below band)
    imd3             2·f1 − f2 within tol of f_rx, devices at the SAME site
    imd5             3·f1 − 2·f2 within tol of f_rx, same site
    imd3_triple      f1 + f2 − f3 (optional, --imd3-triple, combinatorial)
    cosite_desense   any-frequency device within --cosite-m of the repeater
                     (front-end overload — proximity, not spectrum)

SCORING
    score = weight(mechanism) × distance_factor × power_factor × los_factor
    distance_factor = 1 / (1 + d_km/20)
    power_factor    = 0.15 + 0.85 · log-normalised EIRP (0.1 W → 0, 10 kW → 1),
                      missing EIRP → median of the candidate set
    los_factor      = 0.7 (line-of-sight not assessed in this pass; los=null in
                      output and the UI shows "not assessed")
    Components are emitted alongside each score so the card can explain it.

USAGE
    python3 tools/acma_fetch.py                        # subset → data/acma-*.json
    python3 tools/acma_fetch.py --dry-run              # counts only, no writes
    python3 tools/acma_fetch.py --anchors mt_stuart_rpt --tol-khz 25
    python3 tools/acma_fetch.py --suggest-licences     # also emit review CSV

Stdlib only. Idempotent: same inputs produce identical outputs (meta.generated
excepted); nothing is re-downloaded because nothing is downloaded.

Contains ACMA Register of Radiocommunications Licences data, CC BY 4.0.
"""

import argparse
import csv
import io
import json
import math
import os
import statistics
import sys
import zipfile
from datetime import datetime, timezone

csv.field_size_limit(min(2**31 - 1, sys.maxsize))

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

BW_RX_HZ = 12500.0          # MegaNet ALERT channel width assumption (narrowband VHF)
CO_CHANNEL_HZ = 6250.0
ADJ1_HZ = 25000.0
ADJ2_HZ = 50000.0

WEIGHTS = {
    'co_channel':     100,
    'imd3':            85,
    'adjacent':        70,
    'cosite_desense':  65,
    'harmonic':        55,
    'imd3_triple':     45,
    'imd5':            40,
}
ADJ2_FACTOR = 0.8           # 2nd-adjacent (25–50 kHz) downweight
LOS_UNKNOWN_FACTOR = 0.7
DIST_D0_KM = 20.0

MECHANISMS = list(WEIGHTS.keys())


# ── generic CSV source (dir or zip), same tolerant reader as the prefilter ────

class Source:
    def __init__(self, zip_path=None, csv_dir=None):
        self._zf = zipfile.ZipFile(zip_path) if zip_path else None
        self._index = {}
        if self._zf:
            for n in self._zf.namelist():
                base = os.path.basename(n).lower()
                if base.endswith('.csv'):
                    self._index[base[:-4]] = n
        else:
            for n in os.listdir(csv_dir):
                if n.lower().endswith('.csv'):
                    self._index[n.lower()[:-4]] = os.path.join(csv_dir, n)

    def has(self, table):
        return table in self._index

    def rows(self, table):
        if table not in self._index:
            return
        if self._zf:
            raw = self._zf.open(self._index[table], 'r')
            stream = io.TextIOWrapper(raw, encoding='utf-8-sig', errors='replace', newline='')
        else:
            stream = open(self._index[table], 'r', encoding='utf-8-sig', errors='replace', newline='')
        with stream as fh:
            for row in csv.DictReader(fh):
                yield row


def col(row, *names):
    for n in names:
        if n in row:
            return row[n]
    low = {k.lower().strip(): v for k, v in row.items()}
    for n in names:
        if n.lower() in low:
            return low[n.lower()]
    return None


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


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def to_watts(value, unit):
    """Convert a power figure to watts. Observed unit is 'W' throughout the
    current extract; the rest are handled in case ACMA varies it."""
    v = to_float(value)
    if v is None:
        return None
    u = (unit or 'W').strip().lower()
    if u in ('w', 'watt', 'watts'):
        return v
    if u == 'kw':
        return v * 1e3
    if u == 'mw' and v > 500:       # ambiguous: ACMA uses 'MW' for megawatt on
        return v * 1e6              # broadcast; small values are milliwatt typos
    if u == 'mw':
        return v * 1e-3
    if u == 'dbw':
        return 10 ** (v / 10.0)
    if u == 'dbm':
        return 10 ** ((v - 30) / 10.0)
    return v


def drop_nulls(d):
    return {k: v for k, v in d.items() if v is not None and v != '' and v != []}


def r5(x):
    return round(x, 5) if x is not None else None


# ── stations.json anchors ─────────────────────────────────────────────────────

def load_anchors(stations_path, only_ids=None, all_repeaters=False):
    with open(stations_path, encoding='utf-8') as fh:
        data = json.load(fh)
    anchors = []
    for s in data.get('stations', []):
        if 'repeater' not in (s.get('roles') or []):
            continue
        if s.get('lat') is None or s.get('lon') is None:
            continue
        r = s.get('repeater') or {}
        if only_ids is not None and s.get('id') not in only_ids:
            continue
        if not all_repeaters and only_ids is None and not r.get('rx_mhz'):
            continue
        anchors.append({
            'id': s.get('id'), 'name': s.get('name'),
            'lat': s['lat'], 'lon': s['lon'],
            'rx_mhz': r.get('rx_mhz'), 'tx_mhz': r.get('tx_mhz'),
            'acma_licence': clean(r.get('acma_licence')),
        })
    return anchors, data


def licence_base(no):
    return (no or '').split('/')[0].strip()


# ── main ──────────────────────────────────────────────────────────────────────

def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument('--subset', default=os.path.join(REPO, 'data', 'acma-raw'),
                     help='directory of prefiltered ACMA CSVs (default: data/acma-raw)')
    src.add_argument('--zip', help='read tables from a spectra_rrl.zip instead '
                                   '(full extract or zipped subset)')
    ap.add_argument('--stations', default=os.path.join(REPO, 'stations.json'),
                    help='path to stations.json (default: repo stations.json)')
    ap.add_argument('--out', default=os.path.join(REPO, 'data'),
                    help='output directory for acma-*.json (default: data/)')
    ap.add_argument('--radius-km', type=float, default=60.0,
                    help='candidate search radius around each anchor (default 60; '
                         'cannot exceed what the subset was prefiltered at)')
    ap.add_argument('--cosite-m', type=float, default=250.0,
                    help='co-site desense distance in metres (default 250, matching '
                         'the prefilter keep distance — devices beyond the prefilter '
                         'cosite keep are not in the subset at out-of-band frequencies)')
    ap.add_argument('--tol-khz', type=float, default=12.5,
                    help='base frequency tolerance for harmonic/IMD products '
                         '(actual tol = max(this, involved bandwidths/2); default 12.5)')
    ap.add_argument('--tol-cap-khz', type=float, default=100.0,
                    help='hard cap on the product tolerance window, so wideband '
                         '(MHz-scale) carriers cannot inflate it (default 100)')
    ap.add_argument('--band', default='148:174',
                    help='in-band range MHz for co/adjacent candidates (default 148:174)')
    ap.add_argument('--harmonics', default='2:5',
                    help='harmonic orders lo:hi to test (default 2:5)')
    imd3 = ap.add_mutually_exclusive_group()
    imd3.add_argument('--imd3', dest='imd3', action='store_true', default=True,
                      help='test 3rd-order two-signal intermod at shared sites (default on)')
    imd3.add_argument('--no-imd3', dest='imd3', action='store_false')
    imd5 = ap.add_mutually_exclusive_group()
    imd5.add_argument('--imd5', dest='imd5', action='store_true', default=True,
                      help='test 5th-order two-signal intermod (default on)')
    imd5.add_argument('--no-imd5', dest='imd5', action='store_false')
    ap.add_argument('--imd3-triple', action='store_true',
                    help='also test three-signal products f1+f2-f3 (combinatorial; '
                         'sites over --max-site-devices unique frequencies are skipped)')
    ap.add_argument('--max-site-devices', type=int, default=24,
                    help='unique-frequency cap per site for the triple-beat test (default 24)')
    los = ap.add_mutually_exclusive_group()
    los.add_argument('--los', dest='los', action='store_true', default=False,
                     help='reserved: terrain line-of-sight assessment is not yet '
                          'implemented; threats carry los=null ("not assessed")')
    los.add_argument('--no-los', dest='los', action='store_false')
    ap.add_argument('--anchors', default=None,
                    help='comma-separated station ids, or "all-repeaters" to include '
                         'repeaters without a known rx_mhz (co-site analysis only); '
                         'default: every repeater with repeater.rx_mhz set')
    ap.add_argument('--min-emit-score', type=float, default=5.0,
                    help='drop threats scoring below this from the output (default 5)')
    ap.add_argument('--suggest-licences', action='store_true',
                    help='also write acma-licence-suggestions.csv matching MegaNet '
                         'repeaters to nearby ACMA sites/licences for review '
                         '(never edits stations.json)')
    ap.add_argument('--suggest-radius-m', type=float, default=500.0,
                    help='site match radius for --suggest-licences (default 500 m)')
    ap.add_argument('--source-date', default=None,
                    help='override the source extract date stamped into meta '
                         '(default: from data/acma-raw/_manifest.json)')
    ap.add_argument('--dry-run', action='store_true',
                    help='classify and print the summary, write nothing')
    return ap.parse_args(argv)


def load_tables(src):
    t = {}

    lookups = {
        'services':        ('licence_service',   'SV_ID', 'SV_NAME'),
        'statuses':        ('licence_status',    'STATUS', 'STATUS_TEXT'),
        'station_classes': ('class_of_station',  'CODE', 'DESCRIPTION'),
        'natures':         ('nature_of_service', 'CODE', 'DESCRIPTION'),
        'polarities':      ('antenna_polarity',  'POLARISATION_CODE', 'POLARISATION_TEXT'),
        'client_types':    ('client_type',       'TYPE_ID', 'NAME'),
        'industries':      ('industry_cat',      'CAT_ID', 'NAME'),
        'fee_statuses':    ('fee_status',        'FEE_STATUS_ID', 'FEE_STATUS_TEXT'),
    }
    dicts = {}
    for key, (table, kcol, vcol) in lookups.items():
        dicts[key] = {clean(col(r, kcol)): clean(col(r, vcol))
                      for r in src.rows(table) if clean(col(r, kcol))}
    dicts['subservices'] = {clean(col(r, 'SS_ID')): clean(col(r, 'SS_NAME'))
                            for r in src.rows('licence_subservice')}
    t['dicts'] = dicts

    sites = {}
    for r in src.rows('site'):
        lat, lon = to_float(col(r, 'LATITUDE')), to_float(col(r, 'LONGITUDE'))
        if lat is None or lon is None:
            continue
        sid = clean(col(r, 'SITE_ID'))
        sites[sid] = {
            'id': sid, 'lat': lat, 'lon': lon,
            'name': clean(col(r, 'NAME')),
            'state': clean(col(r, 'STATE')),
            'elev': to_float(col(r, 'ELEVATION')),
            'precision': clean(col(r, 'SITE_PRECISION')),
            # POSTCODE is documented by ACMA as unreliable/deprecated: not carried.
        }
    t['sites'] = sites

    devices = []
    for r in src.rows('device_details'):
        if (clean(col(r, 'DEVICE_TYPE')) or 'T').upper() != 'T':
            continue
        sid = clean(col(r, 'SITE_ID'))
        if sid not in sites:
            continue
        f = to_float(col(r, 'FREQUENCY'))
        devices.append({
            'id': clean(col(r, 'SDD_ID')),
            'site_id': sid,
            'lic': clean(col(r, 'LICENCE_NO')),
            'f_hz': f,
            'bw_hz': to_float(col(r, 'BANDWIDTH')),
            'carrier_hz': to_float(col(r, 'CARRIER_FREQ')),
            'emission': clean(col(r, 'EMISSION')),
            'tx_w': to_watts(col(r, 'TRANSMITTER_POWER'), col(r, 'TRANSMITTER_POWER_UNIT')),
            'eirp_w': to_watts(col(r, 'EIRP'), col(r, 'EIRP_UNIT')),
            'power_ind': clean(col(r, 'POWER_IND')),
            'ant_id': clean(col(r, 'ANTENNA_ID')),
            'pol': clean(col(r, 'POLARISATION')),
            'az': to_float(col(r, 'AZIMUTH')),
            'h_m': to_float(col(r, 'HEIGHT')),
            'tilt': to_float(col(r, 'TILT')),
            'feeder_db': to_float(col(r, 'FEEDER_LOSS')),
            'mode': clean(col(r, 'LEQD_MODE')),
            'callsign': clean(col(r, 'CALL_SIGN')),
            'class': clean(col(r, 'CLASS_OF_STATION_CODE')),
            'nature': clean(col(r, 'NATURE_OF_SERVICE_ID')),
            'hours': clean(col(r, 'HOURS_OF_OPERATION')),
            'sv_id': clean(col(r, 'SV_ID')),
            'ss_id': clean(col(r, 'SS_ID')),
            'eqp_id': clean(col(r, 'EQP_ID')),
            'tcs_id': clean(col(r, 'TCS_ID')),
            'station_name': clean(col(r, 'STATION_NAME')),
            'station_type': clean(col(r, 'STATION_TYPE')),
            'authorised': clean(col(r, 'AUTHORISATION_DATE')),
        })
    t['devices'] = devices

    t['licences'] = {}
    for r in src.rows('licence'):
        no = clean(col(r, 'LICENCE_NO'))
        t['licences'][no] = {
            'no': no,
            'client_no': clean(col(r, 'CLIENT_NO')),
            'type': clean(col(r, 'LICENCE_TYPE_NAME')),
            'category': clean(col(r, 'LICENCE_CATEGORY_NAME')),
            'issued': clean(col(r, 'DATE_ISSUED')),
            'effect': clean(col(r, 'DATE_OF_EFFECT')),
            'expiry': clean(col(r, 'DATE_OF_EXPIRY')),
            'status': clean(col(r, 'STATUS_TEXT')) or t['dicts']['statuses'].get(clean(col(r, 'STATUS'))),
            'sv_id': clean(col(r, 'SV_ID')),
            'ss_id': clean(col(r, 'SS_ID')),
        }

    t['clients'] = {}
    for r in src.rows('client'):
        no = clean(col(r, 'CLIENT_NO'))
        t['clients'][no] = {
            'no': no,
            'name': clean(col(r, 'LICENCEE')),
            'trading': clean(col(r, 'TRADING_NAME')),
            'abn': clean(col(r, 'ABN')),
            'acn': clean(col(r, 'ACN')),
            'cat_id': clean(col(r, 'CAT_ID')),
            'type_id': clean(col(r, 'CLIENT_TYPE_ID')),
            'suburb': clean(col(r, 'POSTAL_SUBURB')),
            'state': clean(col(r, 'POSTAL_STATE')),
            'postcode': clean(col(r, 'POSTAL_POSTCODE')),
        }

    t['antennas'] = {}
    for r in src.rows('antenna'):
        aid = clean(col(r, 'ANTENNA_ID'))
        t['antennas'][aid] = drop_nulls({
            'gain_dbi': to_float(col(r, 'GAIN')),
            'f2b_db': to_float(col(r, 'FRONT_TO_BACK')),
            'h_bw': to_float(col(r, 'H_BEAMWIDTH')),
            'v_bw': to_float(col(r, 'V_BEAMWIDTH')),
            'type': clean(col(r, 'ANTENNA_TYPE')),
            'model': clean(col(r, 'MODEL')),
            'manufacturer': clean(col(r, 'MANUFACTURER')),
        })

    # Advisory notes / special conditions, deduplicated: standard condition
    # texts repeat across thousands of licences, so store unique texts once and
    # reference them by index.
    texts, text_idx = [], {}
    lic_notes, tcs_notes = {}, {}
    if src.has('applic_text_block'):
        for r in src.rows('applic_text_block'):
            cat = clean(col(r, 'APTB_CATEGORY'))
            desc = clean(col(r, 'APTB_DESCRIPTION'))
            body = clean(col(r, 'APTB_TEXT'))
            if not (desc or body):
                continue
            key = (cat, desc, body)
            if key not in text_idx:
                text_idx[key] = len(texts)
                texts.append(drop_nulls({'cat': cat, 'title': desc, 'text': body}))
            idx = text_idx[key]
            prefix = (clean(col(r, 'APTB_TABLE_PREFIX')) or '').upper()
            if prefix == 'LI':
                lic_notes.setdefault(clean(col(r, 'LICENCE_NO')), []).append(idx)
            elif prefix == 'TCS':
                tcs_notes.setdefault(clean(col(r, 'APTB_TABLE_ID')), []).append(idx)
    for m in (lic_notes, tcs_notes):
        for k in m:
            m[k] = sorted(set(m[k]))
    t['texts'], t['lic_notes'], t['tcs_notes'] = texts, lic_notes, tcs_notes
    return t


def sanity_check_units(devices):
    freqs = [d['f_hz'] for d in devices if d['f_hz']]
    if not freqs:
        raise SystemExit('No device frequencies parsed at all — wrong input?')
    in_hz = sum(1 for f in freqs if 1e5 <= f <= 1e12)
    if in_hz < len(freqs) * 0.95:
        raise SystemExit(
            'FREQUENCY magnitudes do not look like hertz (e.g. %r). The ACMA '
            'schema stores Hz; refusing to continue with suspect units.'
            % freqs[:5])


def tol_hz(base_khz, cap_khz, *bws):
    """Frequency tolerance for a product landing on the RX channel:
    max(base, half the involved bandwidths), hard-capped. The cap matters —
    wideband carriers (15–100 MHz cellular/NR) would otherwise open an absurd
    window in which any product "hits" a 12.5 kHz channel."""
    known = [b for b in bws if b] or [BW_RX_HZ]
    t = max(base_khz * 1000.0, (sum(known) + BW_RX_HZ) / 2.0)
    return min(t, cap_khz * 1000.0)


def power_factor(eirp_w, median_w):
    w = eirp_w if eirp_w and eirp_w > 0 else (median_w or 1.0)
    span = math.log10(10000.0) - math.log10(0.1)          # 0.1 W .. 10 kW
    n = (math.log10(max(w, 1e-3)) - math.log10(0.1)) / span
    return 0.15 + 0.85 * min(1.0, max(0.0, n))


def classify(args, tables, anchors):
    sites = tables['sites']
    devices = tables['devices']
    licences, clients = tables['licences'], tables['clients']
    meganet_bases = {licence_base(a['acma_licence']) for a in anchors if a['acma_licence']}
    band_lo, band_hi = (float(x) * 1e6 for x in args.band.split(':'))
    h_lo, h_hi = (int(x) for x in args.harmonics.split(':'))
    harmonics = range(h_lo, h_hi + 1)

    eirps = [d['eirp_w'] for d in devices if d['eirp_w'] and d['eirp_w'] > 0]
    median_w = statistics.median(eirps) if eirps else 1.0

    by_site = {}
    for d in devices:
        by_site.setdefault(d['site_id'], []).append(d)

    # site → [(anchor_index, dist_km)] within radius
    site_anchors = {}
    for sid, s in sites.items():
        hits = []
        for i, a in enumerate(anchors):
            dk = haversine_km(s['lat'], s['lon'], a['lat'], a['lon'])
            if dk <= args.radius_km:
                hits.append((i, dk))
        if hits:
            site_anchors[sid] = hits

    # Unique-frequency reps per site for IMD (sectorised installs share a
    # frequency; pairing them with each other is meaningless).
    site_freqs = {}
    for sid, devs in by_site.items():
        reps = {}
        for d in devs:
            if not d['f_hz']:
                continue
            key = round(d['f_hz'] / 100.0)          # merge within 100 Hz
            cur = reps.get(key)
            if cur is None or (d['eirp_w'] or 0) > (cur['eirp_w'] or 0):
                reps[key] = d
        site_freqs[sid] = sorted(reps.values(), key=lambda d: d['f_hz'])

    def mk_threat(anchor, dev, mech, weight_scale, detail, dk, partner=None, product_hz=None):
        a = anchors[anchor]
        s = sites[dev['site_id']]
        w = WEIGHTS[mech] * weight_scale
        df = 1.0 / (1.0 + dk / DIST_D0_KM)
        pf = power_factor(max(dev['eirp_w'] or 0, (partner['eirp_w'] if partner else 0) or 0) or None, median_w)
        lf = LOS_UNKNOWN_FACTOR
        score = w * df * pf * lf
        lic = licences.get(dev['lic']) or {}
        cl = clients.get(lic.get('client_no')) or {}
        return {
            'device_id': dev['id'],
            'site_id': dev['site_id'],
            'mechanism': mech,
            'score': round(score, 1),
            'detail': detail,
            'components': {'mechanism_weight': round(w, 1), 'distance_factor': round(df, 3),
                           'power_factor': round(pf, 3), 'los_factor': lf},
            'f_mhz': round(dev['f_hz'] / 1e6, 6) if dev['f_hz'] else None,
            'product_mhz': round(product_hz / 1e6, 6) if product_hz else None,
            'distance_km': round(dk, 2),
            'bearing_deg': round(bearing_deg(a['lat'], a['lon'], s['lat'], s['lon'])),
            'los': None,
            'partner_device_id': partner['id'] if partner else None,
            # denormalised so tooltips and filters work before the (lazy)
            # devices file has loaded
            'lic': dev['lic'],
            'client': cl.get('trading') or cl.get('name'),
            'expiry': lic.get('expiry'),
            'inactive': True if lic.get('status') and lic.get('status') != 'Granted' else None,
            'meganet': True if licence_base(dev['lic']) in meganet_bases else None,
        }

    per_anchor = []
    counts = {m: 0 for m in MECHANISMS}
    for ai, a in enumerate(anchors):
        f_rx = (a['rx_mhz'] or 0) * 1e6
        threats = []
        imd_pairs = []
        # (device_id, mechanism) → best threat, so one device can carry several
        # mechanisms but never duplicates within one
        best = {}

        def add(t):
            key = (t['device_id'], t['mechanism'])
            if key not in best or t['score'] > best[key]['score']:
                best[key] = t

        for sid, hits in site_anchors.items():
            dk = next((d for i, d in hits if i == ai), None)
            if dk is None:
                continue
            cosite = dk * 1000.0 <= args.cosite_m
            devs = by_site.get(sid, [])

            for d in devs:
                f = d['f_hz']
                spectral = False
                if f_rx and f:
                    delta = f - f_rx
                    if band_lo <= f <= band_hi:
                        if abs(delta) <= CO_CHANNEL_HZ:
                            add(mk_threat(ai, d, 'co_channel', 1.0,
                                          '%.4f MHz vs RX %.4f MHz (Δ %.1f kHz)'
                                          % (f / 1e6, f_rx / 1e6, delta / 1e3), dk))
                            spectral = True
                        elif abs(delta) <= ADJ1_HZ:
                            add(mk_threat(ai, d, 'adjacent', 1.0,
                                          '1st adjacent: %.4f MHz (Δ %+.2f kHz from RX)'
                                          % (f / 1e6, delta / 1e3), dk))
                            spectral = True
                        elif abs(delta) <= ADJ2_HZ:
                            add(mk_threat(ai, d, 'adjacent', ADJ2_FACTOR,
                                          '2nd adjacent: %.4f MHz (Δ %+.2f kHz from RX)'
                                          % (f / 1e6, delta / 1e3), dk))
                            spectral = True
                    elif f < band_lo:
                        for n in harmonics:
                            dh = f * n - f_rx
                            if abs(dh) <= tol_hz(args.tol_khz, args.tol_cap_khz, (d['bw_hz'] or 0) * n):
                                add(mk_threat(ai, d, 'harmonic', 1.0,
                                              '%d × %.4f = %.4f MHz (Δ %.2f kHz from RX %.4f)'
                                              % (n, f / 1e6, f * n / 1e6, dh / 1e3, f_rx / 1e6),
                                              dk, product_hz=f * n))
                                spectral = True
                                break
                if cosite and not spectral:
                    fdesc = ('%.4f MHz' % (f / 1e6)) if f else 'unknown frequency'
                    add(mk_threat(ai, d, 'cosite_desense', 1.0,
                                  '%s at %d m from repeater — front-end overload risk'
                                  % (fdesc, round(dk * 1000)), dk))

            # Intermodulation between devices sharing this ACMA site
            if f_rx and (args.imd3 or args.imd5 or args.imd3_triple):
                reps = site_freqs.get(sid, [])
                for i1 in range(len(reps)):
                    for i2 in range(len(reps)):
                        if i1 == i2:
                            continue
                        d1, d2 = reps[i1], reps[i2]
                        f1, f2 = d1['f_hz'], d2['f_hz']
                        t = tol_hz(args.tol_khz, args.tol_cap_khz, d1['bw_hz'], d2['bw_hz'])
                        if args.imd3:
                            prod = 2 * f1 - f2
                            dh = prod - f_rx
                            if abs(dh) <= t and abs(f1 - f2) > 1000:
                                add(mk_threat(ai, d1, 'imd3', 1.0,
                                              '2 × %.4f − %.4f = %.4f MHz (Δ %.2f kHz)'
                                              % (f1 / 1e6, f2 / 1e6, prod / 1e6, dh / 1e3),
                                              dk, partner=d2, product_hz=prod))
                                imd_pairs.append({'a': d1['id'], 'b': d2['id'], 'order': 3,
                                                  'product_mhz': round(prod / 1e6, 6),
                                                  'delta_khz': round(dh / 1e3, 2),
                                                  'site_id': sid})
                        if args.imd5:
                            prod = 3 * f1 - 2 * f2
                            dh = prod - f_rx
                            if abs(dh) <= t and abs(f1 - f2) > 1000:
                                add(mk_threat(ai, d1, 'imd5', 1.0,
                                              '3 × %.4f − 2 × %.4f = %.4f MHz (Δ %.2f kHz)'
                                              % (f1 / 1e6, f2 / 1e6, prod / 1e6, dh / 1e3),
                                              dk, partner=d2, product_hz=prod))
                                imd_pairs.append({'a': d1['id'], 'b': d2['id'], 'order': 5,
                                                  'product_mhz': round(prod / 1e6, 6),
                                                  'delta_khz': round(dh / 1e3, 2),
                                                  'site_id': sid})
                if args.imd3_triple and len(reps) <= args.max_site_devices:
                    for i1 in range(len(reps)):
                        for i2 in range(i1 + 1, len(reps)):
                            for i3 in range(len(reps)):
                                if i3 in (i1, i2):
                                    continue
                                d1, d2, d3 = reps[i1], reps[i2], reps[i3]
                                prod = d1['f_hz'] + d2['f_hz'] - d3['f_hz']
                                dh = prod - f_rx
                                t = tol_hz(args.tol_khz, args.tol_cap_khz, d1['bw_hz'], d2['bw_hz'], d3['bw_hz'])
                                if abs(dh) <= t:
                                    add(mk_threat(ai, d1, 'imd3_triple', 1.0,
                                                  '%.4f + %.4f − %.4f = %.4f MHz (Δ %.2f kHz)'
                                                  % (d1['f_hz'] / 1e6, d2['f_hz'] / 1e6,
                                                     d3['f_hz'] / 1e6, prod / 1e6, dh / 1e3),
                                                  dk, partner=d2, product_hz=prod))

        threats = [t for t in best.values() if t['score'] >= args.min_emit_score]
        threats.sort(key=lambda t: -t['score'])
        for t in threats:
            counts[t['mechanism']] += 1
        per_anchor.append({
            'station_id': a['id'], 'name': a['name'],
            'rx_mhz': a['rx_mhz'], 'tx_mhz': a['tx_mhz'],
            'lat': r5(a['lat']), 'lon': r5(a['lon']),
            'threats': [drop_nulls(t) for t in threats],
            'imd_pairs': imd_pairs,
        })
    return per_anchor, counts, median_w


def build_outputs(args, tables, anchors, per_anchor, counts, median_w, source_date):
    dicts = tables['dicts']
    sites, devices = tables['sites'], tables['devices']
    licences, clients = tables['licences'], tables['clients']

    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    attribution = ('Contains data from the Australian Communications and Media '
                   'Authority, Register of Radiocommunications Licences (CC BY 4.0).')
    meta_common = {
        'generated': now,
        'source_date': source_date,
        'source': 'ACMA Spectra RRL daily extract (bulk download)',
        'attribution': attribution,
    }

    by_site_count = {}
    for d in devices:
        by_site_count[d['site_id']] = by_site_count.get(d['site_id'], 0) + 1

    meganet_bases = {licence_base(a['acma_licence']) for a in anchors if a['acma_licence']}

    sites_out = {
        'meta': dict(meta_common, radius_km=args.radius_km),
        'sites': [drop_nulls({
            'id': s['id'], 'name': s['name'],
            'lat': r5(s['lat']), 'lon': r5(s['lon']),
            'elevation_m': s['elev'], 'state': s['state'],
            'precision': s['precision'],
            'device_count': by_site_count.get(s['id'], 0),
        }) for s in sites.values() if by_site_count.get(s['id'])],
    }

    devs_out = []
    for d in devices:
        lic = licences.get(d['lic']) or {}
        notes = list(tables['lic_notes'].get(d['lic'], []))
        if d['tcs_id']:
            notes += tables['tcs_notes'].get(d['tcs_id'], [])
        devs_out.append(drop_nulls({
            'id': d['id'],
            'site_id': d['site_id'],
            'lic': d['lic'],
            'f_mhz': round(d['f_hz'] / 1e6, 6) if d['f_hz'] else None,
            'bw_khz': round(d['bw_hz'] / 1e3, 3) if d['bw_hz'] else None,
            'emission': d['emission'],
            'tx_w': d['tx_w'], 'eirp_w': d['eirp_w'],
            'az': d['az'], 'height_m': d['h_m'], 'tilt': d['tilt'],
            'feeder_db': d['feeder_db'],
            'pol': dicts['polarities'].get(d['pol'], d['pol']),
            'mode': {'S': 'Simplex', 'D': 'Duplex'}.get(d['mode'], d['mode']),
            'callsign': d['callsign'],
            'station_class': dicts['station_classes'].get(d['class'], d['class']),
            'nature': dicts['natures'].get(d['nature'], d['nature']),
            'service': dicts['services'].get(d['sv_id'] or lic.get('sv_id')),
            'subservice': dicts['subservices'].get(d['ss_id'] or lic.get('ss_id')),
            'hours': d['hours'],
            'eqp_id': d['eqp_id'],
            'station_name': d['station_name'],
            'station_type': d['station_type'],
            'authorised': d['authorised'],
            'ant': d['ant_id'] if d['ant_id'] in tables['antennas'] else None,
            'notes': sorted(set(notes)) or None,
            'meganet': True if licence_base(d['lic']) in meganet_bases else None,
        }))

    lics_out = {}
    for no, l in licences.items():
        cl = clients.get(l['client_no']) or {}
        lics_out[no] = drop_nulls({
            'type': l['type'], 'category': l['category'],
            'issued': l['issued'], 'effect': l['effect'], 'expiry': l['expiry'],
            'status': l['status'],
            'service': dicts['services'].get(l['sv_id']),
            'subservice': dicts['subservices'].get(l['ss_id']),
            'client_no': l['client_no'],
            'notes': tables['lic_notes'].get(no) or None,
        })

    clients_out = {}
    for no, c in clients.items():
        clients_out[no] = drop_nulls({
            'name': c['name'], 'trading': c['trading'],
            'abn': c['abn'], 'acn': c['acn'],
            'industry': dicts['industries'].get(c['cat_id']),
            'type': dicts['client_types'].get(c['type_id']),
            'postal': ' '.join(x for x in (c['suburb'], c['state'], c['postcode']) if x) or None,
        })

    devices_out = {
        'meta': dict(meta_common,
                     note='Lazy-loaded by the app on first card open. Licensee '
                          'contact data must not be used for unsolicited messaging '
                          '(Spam Act 2003 / Do Not Call Register Act 2006).'),
        'devices': devs_out,
        'antennas': {k: v for k, v in tables['antennas'].items() if v},
        'licences': lics_out,
        'clients': clients_out,
        'texts': tables['texts'],
    }

    threats_out = {
        'meta': dict(meta_common,
                     radius_km=args.radius_km, cosite_m=args.cosite_m,
                     tol_khz=args.tol_khz, tol_cap_khz=args.tol_cap_khz,
                     band_mhz=[float(x) for x in args.band.split(':')],
                     harmonics=args.harmonics, weights=WEIGHTS,
                     adj2_factor=ADJ2_FACTOR, los_note='line-of-sight not assessed',
                     median_eirp_w=round(median_w, 1),
                     min_emit_score=args.min_emit_score,
                     counts=counts),
        'anchors': per_anchor,
    }

    dicts_out = {'meta': meta_common}
    dicts_out.update(tables['dicts'])

    return {
        'acma-threats.json': threats_out,
        'acma-sites.json': sites_out,
        'acma-devices.json': devices_out,
        'acma-dictionaries.json': dicts_out,
    }


def suggest_licences(args, tables, stations_data):
    """Match every MegaNet repeater to nearby ACMA sites/devices on its own
    frequencies, to review/backfill repeater.acma_licence. Emits CSV rows,
    never edits stations.json."""
    sites, devices = tables['sites'], tables['devices']
    licences, clients = tables['licences'], tables['clients']
    by_site = {}
    for d in devices:
        by_site.setdefault(d['site_id'], []).append(d)

    rows = []
    for s in stations_data.get('stations', []):
        if 'repeater' not in (s.get('roles') or []) or s.get('lat') is None:
            continue
        rep = s.get('repeater') or {}
        own_freqs = [f for f in (rep.get('rx_mhz'), rep.get('tx_mhz')) if f]
        current = clean(rep.get('acma_licence'))
        for site in sites.values():
            dm = haversine_km(s['lat'], s['lon'], site['lat'], site['lon']) * 1000.0
            if dm > args.suggest_radius_m:
                continue
            for d in by_site.get(site['id'], []):
                if not d['f_hz']:
                    continue
                f_mhz = d['f_hz'] / 1e6
                freq_hit = any(abs(f_mhz - f) * 1000 <= 12.5 for f in own_freqs)
                if own_freqs and not freq_hit:
                    continue
                if not own_freqs and not (148.0 <= f_mhz <= 174.0):
                    continue
                lic = licences.get(d['lic']) or {}
                cl = clients.get(lic.get('client_no')) or {}
                rows.append({
                    'station_id': s.get('id'), 'station_name': s.get('name'),
                    'current_acma_licence': current or '',
                    'suggested_licence_no': d['lic'],
                    'already_recorded': 'yes' if current and licence_base(current) == licence_base(d['lic']) else '',
                    'licensee': cl.get('name') or '',
                    'freq_mhz': '%.4f' % f_mhz,
                    'freq_match': 'yes' if freq_hit else ('n/a (no rx_mhz recorded)' if not own_freqs else ''),
                    'distance_m': str(round(dm)),
                    'site_id': site['id'], 'site_name': site['name'] or '',
                    'site_precision': site['precision'] or '',
                    'device_id': d['id'],
                })
    rows.sort(key=lambda r: (r['station_id'], int(r['distance_m'])))
    return rows


def main(argv=None):
    args = parse_args(argv)

    if args.zip:
        src = Source(zip_path=args.zip)
    else:
        if not os.path.isdir(args.subset):
            raise SystemExit('Subset directory %s not found. Run tools/acma_prefilter.py '
                             'first (see README), or pass --zip.' % args.subset)
        src = Source(csv_dir=args.subset)

    for required in ('site', 'device_details', 'licence', 'client'):
        if not src.has(required):
            raise SystemExit('Missing required table: %s.csv' % required)

    source_date = args.source_date
    if not source_date and not args.zip:
        manifest_path = os.path.join(args.subset, '_manifest.json')
        if os.path.exists(manifest_path):
            with open(manifest_path, encoding='utf-8') as fh:
                source_date = (json.load(fh).get('generated') or '')[:10] or None
    source_date = source_date or datetime.now(timezone.utc).strftime('%Y-%m-%d')

    only_ids, all_repeaters = None, False
    if args.anchors == 'all-repeaters':
        all_repeaters = True
    elif args.anchors:
        only_ids = {x.strip() for x in args.anchors.split(',') if x.strip()}
    anchors, stations_data = load_anchors(args.stations, only_ids, all_repeaters)
    if not anchors:
        raise SystemExit('No anchor repeaters matched (need roles: repeater, lat/lon, '
                         'and repeater.rx_mhz unless --anchors all-repeaters).')

    print('Loading tables ...')
    tables = load_tables(src)
    sanity_check_units(tables['devices'])
    print('  %d sites, %d transmitters, %d licences, %d clients, %d antennas, %d note texts'
          % (len(tables['sites']), len(tables['devices']), len(tables['licences']),
             len(tables['clients']), len(tables['antennas']), len(tables['texts'])))
    print('Anchors: %d (%d with rx_mhz)   radius %.0f km   cosite %.0f m   tol %.1f kHz'
          % (len(anchors), sum(1 for a in anchors if a['rx_mhz']),
             args.radius_km, args.cosite_m, args.tol_khz))

    per_anchor, counts, median_w = classify(args, tables, anchors)

    total = sum(counts.values())
    n_pairs = sum(len(a['imd_pairs']) for a in per_anchor)
    print('\nThreats by mechanism (score ≥ %.0f):' % args.min_emit_score)
    for m in MECHANISMS:
        print('  %-16s %6d' % (m, counts[m]))
    print('  %-16s %6d   (%d IMD product pairs)' % ('TOTAL', total, n_pairs))
    if not any(counts[m] for m in ('imd3', 'imd5', 'imd3_triple')):
        print('  NOTE: no same-site IMD candidates found within tolerance.')

    busiest = sorted(per_anchor, key=lambda a: -len(a['threats']))[:8]
    print('\nBusiest anchors:')
    for a in busiest:
        by = {}
        for t in a['threats']:
            by[t['mechanism']] = by.get(t['mechanism'], 0) + 1
        print('  %-28s %4d  (%s)' % (a['station_id'], len(a['threats']),
                                     ', '.join('%s %d' % kv for kv in sorted(by.items()))))

    if args.dry_run:
        print('\n--dry-run: nothing written.')
        return

    outputs = build_outputs(args, tables, anchors, per_anchor, counts, median_w, source_date)
    os.makedirs(args.out, exist_ok=True)
    print('\nWriting to %s/ ...' % args.out)
    for name, obj in outputs.items():
        path = os.path.join(args.out, name)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(obj, fh, separators=(',', ':'), ensure_ascii=False)
        print('  %-28s %8.2f KB' % (name, os.path.getsize(path) / 1e3))

    if args.suggest_licences:
        rows = suggest_licences(args, tables, stations_data)
        path = os.path.join(args.out, 'acma-licence-suggestions.csv')
        fields = ['station_id', 'station_name', 'current_acma_licence',
                  'suggested_licence_no', 'already_recorded', 'licensee',
                  'freq_mhz', 'freq_match', 'distance_m', 'site_id', 'site_name',
                  'site_precision', 'device_id']
        with open(path, 'w', encoding='utf-8', newline='') as fh:
            w = csv.DictWriter(fh, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
        print('  %-28s %8.2f KB  (%d suggestions — review, do not auto-apply)'
              % ('acma-licence-suggestions.csv', os.path.getsize(path) / 1e3, len(rows)))


if __name__ == '__main__':
    main()
