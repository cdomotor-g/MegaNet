#!/usr/bin/env python3
"""
mobile_sectors.py — every Telstra, Optus and TPG (Vodafone) mobile base station
sector in Australia, out of the ACMA register, as the small tiled JSON the
station card's and What is here card's mobile coverage section reads
(site-mobile.js).

PIPELINE POSITION
    spectra_rrl.zip (ACMA daily extract, ~68 MB — never committed)
        └─ tools/mobile_sectors.py   → data/mobile/index.json
                                        data/mobile/cells/<lat>_<lon>.json

    Runs in the monthly ACMA refresh (.github/workflows/acma-refresh.yml),
    straight off the zip the interference pipeline already downloads.
    Standard library only, like the other ACMA tools.

WHY THE REGISTER, AND NOT A COVERAGE MAP
    No open data gives mobile signal strength. The carriers' own public maps
    are on their websites only; the ACCC's open copies of them say covered or
    not, nothing in between. What *is* open is the register every mobile
    transmitter in a spectrum-licensed band has to be entered in: position,
    antenna height, azimuth, antenna, EIRP and bandwidth, for ~600,000
    transmitter entries at ~40,000 sites. With the app's Longley–Rice port
    (itm.js) and its terrain (terrain.js) that is enough to *estimate* the
    signal at a point — which is what site-mobile.js does with this file.

WHAT IT KEEPS
    Transmit devices ('T') on spectrum licences held by the three national
    carriers, in the bands their 4G and 5G networks use below 6 GHz (BANDS).
    Fixed links, satellite earth stations, pay TV, land mobile and 26 GHz
    millimetre wave are left out: the first four are not the mobile network,
    and millimetre wave covers a few hundred metres of a city street.

    One row per sector: (site, carrier, band, azimuth). The register enters a
    sector once per carrier and technology, often once per 5 MHz block, so a
    sector on a band is several rows; the row kept is the one with the most
    power per resource element (below), because that is the carrier a phone
    would camp on.

POWER PER RESOURCE ELEMENT
    RSRP — the figure the ACMA's coverage standard is written in — is the
    power of one reference-signal resource element: one 15 kHz subcarrier for
    LTE, one 30 kHz subcarrier for NR at 3.5 GHz. The register gives EIRP over
    the device's whole bandwidth, so the kept figure is

        rs_dbm = 10·log10(EIRP_W · 1000) − 10·log10(0.9 · BW / SCS)

    with 90% of the bandwidth occupied by subcarriers (LTE's 100 resource
    blocks in 20 MHz). That assumes the power is spread evenly over them, with
    no reference-signal boost, and that the register's EIRP is what the site
    radiates rather than the most it may. Neither is guaranteed: the estimate
    is labelled as one on every screen that shows it.

THE OPTUS–TPG REGIONAL SHARING (MOCN)
    From 2025 TPG's customers are carried on ~2,500 of Optus' regional sites.
    Those transmitters are on Optus' licences, so the register alone would
    leave TPG with no regional coverage at all. --mocn takes the ACCC's list
    of the shared sites (Mobile sites - Optus-TPG MOCN, data.gov.au, CC BY 2.5
    AU) and flags every Optus site within MOCN_MATCH_M of one; site-mobile.js
    counts a flagged site's Optus sectors for TPG as well.

OUTPUT
    data/mobile/index.json         meta, attribution, and every cell with its
                                   sector count (so the app never asks for a
                                   cell that does not exist)
    data/mobile/cells/<la>_<lo>.json
                                   one 1° × 1° cell, named for its south-west
                                   corner: { cell, sites: [[site_id, lat, lon,
                                   flags, [[carrier, band, f_mhz, az, h_m,
                                   hbw_deg, f2b_db, rs_dbm], …]], …] }
    carrier: 0 Telstra, 1 Optus, 2 TPG (Vodafone). flags: 1 = an Optus site
    the ACCC lists as shared with TPG. hbw 0 = no horizontal pattern known
    (an omni, or an antenna the register does not describe).

USAGE
    python3 tools/mobile_sectors.py --zip spectra_rrl.zip \\
        --mocn data/mobile/accc-mocn-sites-2026.csv --out data/mobile
"""

import argparse
import csv
import io
import json
import math
import os
import shutil
import sys
import zipfile
from datetime import datetime, timezone

csv.field_size_limit(min(2**31 - 1, sys.maxsize))

# Carrier by licensee name. TPG Telecom holds the old Vodafone Hutchison
# licences under that name, so both words mean the one network.
CARRIERS = [
    ("telstra", "Telstra", ("TELSTRA",)),
    ("optus", "Optus", ("OPTUS",)),
    ("tpg", "TPG (Vodafone)", ("TPG", "VODAFONE")),
]

# Downlink frequency ranges (MHz) of the bands the three networks use for 4G
# and 5G below 6 GHz, as band label → [lo, hi). A transmitter outside every
# range is counted and dropped, so a new band shows up in the summary rather
# than silently in nobody's estimate.
BANDS = [
    (700, 740, 810),     # APT 700 (B28 / n28), downlink 758–803
    (850, 860, 895),     # 850 (B5 / n5), downlink 870–890
    (900, 925, 965),     # 900 (B8 / n8), downlink 935–960
    (1800, 1800, 1885),  # 1800 (B3 / n3)
    (2100, 2100, 2175),  # 2100 (B1 / n1)
    (2300, 2290, 2410),  # 2300 TDD (B40)
    (2600, 2610, 2700),  # 2600 (B7)
    (3500, 3300, 3850),  # 3.4–3.8 GHz NR (n78)
]

OCCUPANCY = 0.9          # subcarriers / bandwidth (LTE: 100 RB × 180 kHz in 20 MHz)
# The most an antenna adds to its transmitter. A 3.5 GHz massive-MIMO panel's
# beamforming is ~27 dB over its 200 W; a register EIRP further than this over
# the device's own transmitter power is a keying error — one Docklands light
# pole is entered at 166 MW from 7.94 W — and is recomputed from the
# transmitter, the antenna's gain and the feeder instead.
MAX_GAIN_DB = 32.0
SCS_LOW_HZ = 15e3        # LTE, and NR below 3 GHz as it is deployed here
SCS_HIGH_HZ = 30e3       # NR at 3.5 GHz
MOCN_MATCH_M = 150.0     # an ACCC site position and a register site are this close or not the same
CELL_DEG = 1


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


class Source:
    """The extract's CSVs, read from the zip or a folder, one row at a time."""

    def __init__(self, zip_path=None, csv_dir=None):
        self.zf = zipfile.ZipFile(zip_path) if zip_path else None
        self.csv_dir = csv_dir
        self.index = {}
        names = self.zf.namelist() if self.zf else os.listdir(csv_dir)
        for n in names:
            base = os.path.basename(n).lower()
            if base.endswith(".csv"):
                self.index[base[:-4]] = n if self.zf else os.path.join(csv_dir, n)

    def rows(self, table):
        if table not in self.index:
            raise SystemExit(f"mobile_sectors: the extract has no {table}.csv")
        if self.zf:
            fh = io.TextIOWrapper(self.zf.open(self.index[table]), encoding="utf-8-sig",
                                  errors="replace", newline="")
        else:
            fh = open(self.index[table], encoding="utf-8-sig", errors="replace", newline="")
        with fh:
            yield from csv.DictReader(fh)

    def date(self):
        """The extract's own date — the zip's entry timestamp for site.csv."""
        if self.zf and "site" in self.index:
            y, m, d = self.zf.getinfo(self.index["site"]).date_time[:3]
            return f"{y:04d}-{m:02d}-{d:02d}"
        return None


def num(v, default=None):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return x if math.isfinite(x) else default


def band_of(f_mhz):
    for label, lo, hi in BANDS:
        if lo <= f_mhz < hi:
            return label
    return None


def watts(v, unit):
    """The register's EIRP in watts. 'W' throughout in practice; the rest is
    acma_fetch.py's defensive list."""
    if unit == "kW":
        return v * 1e3
    if unit == "mW":
        return v / 1e3
    if unit in ("dBW", "dBm") and v < 200:
        return 10 ** (v / 10) / (1e3 if unit == "dBm" else 1)
    return v


def rs_dbm(eirp_w, bw_hz, f_mhz):
    """EIRP per reference-signal resource element, dBm (see the docstring)."""
    if not (eirp_w > 0 and bw_hz > 0):
        return None
    scs = SCS_HIGH_HZ if f_mhz >= 3300 else SCS_LOW_HZ
    n_re = max(1.0, OCCUPANCY * bw_hz / scs)
    return 10 * math.log10(eirp_w * 1000) - 10 * math.log10(n_re)


def carrier_of(name):
    up = (name or "").upper()
    for i, (_, _, words) in enumerate(CARRIERS):
        if any(w in up for w in words):
            return i
    return None


def load_mocn(path):
    """(lat, lon) of every site the ACCC lists as Optus–TPG shared."""
    out = []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            lat, lon = num(r.get("Latitude")), num(r.get("Longitude"))
            if lat is not None and lon is not None:
                out.append((lat, lon))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--zip", help="spectra_rrl.zip, as ACMA publishes it")
    src.add_argument("--csv-dir", help="the same CSVs, already extracted")
    ap.add_argument("--mocn", help="the ACCC's Optus-TPG MOCN site list (CSV)")
    ap.add_argument("--out", default="data/mobile", help="output folder (default data/mobile)")
    a = ap.parse_args()

    s = Source(a.zip, a.csv_dir)

    clients = {}
    for r in s.rows("client"):
        c = carrier_of(f"{r.get('LICENCEE', '')} {r.get('TRADING_NAME', '')}")
        if c is not None:
            clients[r["CLIENT_NO"]] = c
    licences = {}
    for r in s.rows("licence"):
        if r.get("CLIENT_NO") in clients and (r.get("LICENCE_TYPE_NAME") or "").startswith("Spectrum"):
            licences[r["LICENCE_NO"]] = clients[r["CLIENT_NO"]]
    antennas = {}
    for r in s.rows("antenna"):
        antennas[r["ANTENNA_ID"]] = (num(r.get("H_BEAMWIDTH"), 0.0), num(r.get("FRONT_TO_BACK"), 0.0),
                                     num(r.get("GAIN"), 0.0))

    # (site, carrier, band, az) → the strongest device's figures
    sectors = {}
    seen = dropped_band = dropped_power = underground = eirp_fixed = 0
    for r in s.rows("device_details"):
        c = licences.get(r.get("LICENCE_NO"))
        if c is None or r.get("DEVICE_TYPE") != "T":
            continue
        seen += 1
        f = num(r.get("FREQUENCY"), 0.0) / 1e6
        band = band_of(f)
        if band is None:
            dropped_band += 1
            continue
        # Below ground is a tunnel or a mine — a transmitter serving nobody
        # standing on the surface above it.
        h = num(r.get("HEIGHT"), 0.0)
        if h < 0:
            underground += 1
            continue
        hbw, f2b, gain = antennas.get(r.get("ANTENNA_ID"), (0.0, 0.0, 0.0))
        eirp = watts(num(r.get("EIRP"), 0.0), (r.get("EIRP_UNIT") or "W").strip())
        tx = watts(num(r.get("TRANSMITTER_POWER"), 0.0), (r.get("TRANSMITTER_POWER_UNIT") or "W").strip())
        if tx > 0 and eirp > tx * 10 ** (MAX_GAIN_DB / 10):
            eirp = tx * 10 ** ((gain - num(r.get("FEEDER_LOSS"), 0.0)) / 10) if gain > 0 else 0.0
            eirp_fixed += 1
        rs = rs_dbm(eirp, num(r.get("BANDWIDTH"), 0.0), f)
        if rs is None:
            dropped_power += 1
            continue
        az = num(r.get("AZIMUTH"), 0.0) % 360
        k = (r["SITE_ID"], c, band, round(az))
        if k in sectors and sectors[k][5] >= rs:
            continue
        sectors[k] = (f, az, h, hbw, f2b, rs)

    sites = {}
    for r in s.rows("site"):
        sites[r["SITE_ID"]] = (num(r.get("LATITUDE")), num(r.get("LONGITUDE")))

    # Grouped by site, carrier and band order, so a cell file diffs month to
    # month by the sectors that changed.
    by_site = {}
    no_site = 0
    for (sid, c, band, _), (f, az, h, hbw, f2b, rs) in sectors.items():
        ll = sites.get(sid)
        if not ll or ll[0] is None or ll[1] is None:
            no_site += 1
            continue
        by_site.setdefault(sid, {"ll": ll, "sec": []})["sec"].append(
            [c, band, round(f, 2), round(az), round(h, 1),
             round(hbw) if 0 < hbw < 300 else 0, round(f2b), round(rs, 1)])

    # The shared sites: Optus sites near a listed position. A coarse grid
    # keeps the match linear rather than every Optus site against every row.
    mocn_rows = load_mocn(a.mocn) if a.mocn else []
    grid = {}
    for lat, lon in mocn_rows:
        grid.setdefault((round(lat, 2), round(lon, 2)), []).append((lat, lon))
    mocn_sites = 0
    for sid, v in by_site.items():
        v["flags"] = 0
        if not grid or not any(x[0] == 1 for x in v["sec"]):
            continue
        lat, lon = v["ll"]
        k = (round(lat, 2), round(lon, 2))
        near = [p for dk in ((0, 0), (0.01, 0), (-0.01, 0), (0, 0.01), (0, -0.01),
                             (0.01, 0.01), (0.01, -0.01), (-0.01, 0.01), (-0.01, -0.01))
                for p in grid.get((round(k[0] + dk[0], 2), round(k[1] + dk[1], 2)), [])]
        if any(haversine_m(lat, lon, p[0], p[1]) <= MOCN_MATCH_M for p in near):
            v["flags"] = 1
            mocn_sites += 1

    cells = {}
    for sid in sorted(by_site, key=lambda x: (len(x), x)):
        v = by_site[sid]
        lat, lon = v["ll"]
        key = f"{math.floor(lat / CELL_DEG) * CELL_DEG}_{math.floor(lon / CELL_DEG) * CELL_DEG}"
        v["sec"].sort()
        cells.setdefault(key, []).append([sid, round(lat, 5), round(lon, 5), v["flags"], v["sec"]])

    out_cells = os.path.join(a.out, "cells")
    if os.path.isdir(out_cells):
        shutil.rmtree(out_cells)
    os.makedirs(out_cells)
    total_bytes = 0
    for key, rows in cells.items():
        la, lo = key.split("_")
        blob = json.dumps({"cell": [int(la), int(lo)], "sites": rows}, separators=(",", ":"))
        with open(os.path.join(out_cells, f"{key}.json"), "w", encoding="utf-8") as fh:
            fh.write(blob + "\n")
        total_bytes += len(blob) + 1

    per_carrier = [0, 0, 0]
    for v in by_site.values():
        for x in v["sec"]:
            per_carrier[x[0]] += 1
    index = {
        "meta": {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source_date": s.date(),
            "source": "ACMA Spectra RRL daily extract (bulk download)",
            "attribution": "Contains data from the Australian Communications and Media Authority, "
                           "Register of Radiocommunications Licences (CC BY 4.0).",
            "mocn_source": ("ACCC Mobile Infrastructure Report data release — Mobile sites, "
                            "Optus-TPG MOCN (CC BY 2.5 AU)") if a.mocn else None,
            "carriers": [name for _, name, _ in CARRIERS],
            "cell_deg": CELL_DEG,
            "row": ["carrier", "band", "f_mhz", "az", "h_m", "hbw_deg", "f2b_db", "rs_dbm"],
            "rs": "EIRP per resource element: EIRP over 0.9 x bandwidth / subcarrier spacing "
                  "(15 kHz below 3.3 GHz, 30 kHz above)",
            "counts": {"transmitters": seen, "sectors": sum(per_carrier),
                       "per_carrier": per_carrier, "sites": len(by_site),
                       "mocn_sites": mocn_sites, "mocn_listed": len(mocn_rows),
                       "dropped_band": dropped_band, "dropped_power": dropped_power,
                       "dropped_underground": underground, "eirp_recomputed": eirp_fixed,
                       "dropped_no_site": no_site, "bytes": total_bytes},
        },
        "cells": {k: sum(len(r[4]) for r in rows) for k, rows in sorted(cells.items())},
    }
    with open(os.path.join(a.out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1)
        fh.write("\n")
    m = index["meta"]["counts"]
    print(f"mobile_sectors: {m['transmitters']} transmitters → {m['sectors']} sectors at {m['sites']} sites "
          f"in {len(cells)} cells ({total_bytes / 1e6:.1f} MB); Telstra {per_carrier[0]}, Optus {per_carrier[1]}, "
          f"TPG {per_carrier[2]}; {mocn_sites} Optus sites shared with TPG of {len(mocn_rows)} listed; dropped "
          f"{dropped_band} out of band, {dropped_power} with no power, {underground} underground, {no_site} with "
          f"no site; {eirp_fixed} impossible EIRPs recomputed from the transmitter")


if __name__ == "__main__":
    main()
