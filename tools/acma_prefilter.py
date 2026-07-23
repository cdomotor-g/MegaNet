#!/usr/bin/env python3
"""
acma_prefilter.py — reduce the ACMA Spectra RRL extract to a MegaNet-sized subset.

WHY THIS EXISTS
    The ACMA daily extract (spectra_rrl.zip) is ~68 MB zipped / ~580 MB unzipped,
    with device_details.csv alone at ~365 MB. That will not fit through a GitHub
    upload, a repo commit, or a cloud agent's sandbox.

    This script runs on YOUR machine, where the zip already is. It keeps only the
    records relevant to the MegaNet telemetry network and writes a small subset
    (expect single-digit MB) that CAN be committed to the repo and read by
    Claude Code.

REQUIREMENTS
    Python 3.8+. Standard library only — no pip install, no dependencies.

USAGE
    # Simplest: point it at the zip (no need to unzip)
    python acma_prefilter.py --zip spectra_rrl.zip --out acma_subset

    # Or at an already-extracted folder of CSVs
    python acma_prefilter.py --csv-dir ./spectra_rrl --out acma_subset

    # Use your live repeater list instead of the bundled snapshot
    python acma_prefilter.py --zip spectra_rrl.zip --stations stations.json --out acma_subset

    # Wider net (bigger output)
    python acma_prefilter.py --zip spectra_rrl.zip --radius-km 100 --out acma_subset

WHAT IT KEEPS
    1. SITES within --radius-km of any MegaNet repeater.
    2. TRANSMITTERS at those sites that are either:
         - inside the VHF high band 148-174 MHz, or
         - inside a harmonic-source window (a transmitter whose 2nd..5th harmonic
           lands on a MegaNet RX frequency), or
         - at a site within --cosite-m of a repeater, ANY frequency
           (front-end desensitisation is about proximity, not spectrum).
    3. The licences, clients, antennas and advisory/condition text for those
       devices only.
    4. All the small lookup tables, whole (they are 1-4 KB each).

OUTPUT
    <out>/*.csv          filtered tables, same column names as ACMA
    <out>/_manifest.json row counts, parameters, source file dates, size report

NOTE ON FREQUENCY UNITS
    ACMA stores DEVICE_DETAILS.FREQUENCY in HERTZ (confirmed in the ACMA data
    dictionary). 151.5 MHz == 151500000. All --*-mhz arguments below are in MHz
    and converted internally.
"""

import argparse
import csv
import io
import json
import math
import os
import sys
import zipfile
from datetime import datetime, timezone

csv.field_size_limit(min(2**31 - 1, sys.maxsize))

# --------------------------------------------------------------------------
# Bundled anchor snapshot: MegaNet repeaters with coordinates, taken from
# stations.json (178 repeaters, 88 with a known rx_mhz). Override at runtime
# with --stations to use your current data.
# --------------------------------------------------------------------------
BUNDLED_ANCHORS_NOTE = "snapshot of stations.json repeaters; override with --stations"

# Frequencies (MHz) the network receives on, used to build harmonic windows when
# an anchor has no rx_mhz recorded.
DEFAULT_RX_MHZ = [151.5, 151.525, 151.95, 152.4]

VHF_LOW_MHZ = 148.0
VHF_HIGH_MHZ = 174.0

# Tables copied in full — all tiny.
LOOKUP_TABLES = [
    "antenna_polarity", "class_of_station", "client_type", "fee_status",
    "industry_cat", "licence_service", "licence_status", "licence_subservice",
    "licensing_area", "nature_of_service", "access_area", "bsl_area",
]


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


class Source:
    """Reads CSVs from either a zip or a directory, without extracting."""

    def __init__(self, zip_path=None, csv_dir=None):
        self.zip_path = zip_path
        self.csv_dir = csv_dir
        self._zf = zipfile.ZipFile(zip_path) if zip_path else None
        self._index = {}
        if self._zf:
            for n in self._zf.namelist():
                base = os.path.basename(n).lower()
                if base.endswith(".csv"):
                    self._index[base[:-4]] = n
        else:
            for n in os.listdir(csv_dir):
                if n.lower().endswith(".csv"):
                    self._index[n.lower()[:-4]] = os.path.join(csv_dir, n)

    def has(self, table):
        return table in self._index

    def size(self, table):
        if table not in self._index:
            return 0
        if self._zf:
            return self._zf.getinfo(self._index[table]).file_size
        return os.path.getsize(self._index[table])

    def rows(self, table):
        """Yield dict rows, streaming. Never loads the whole file."""
        if table not in self._index:
            return
        if self._zf:
            raw = self._zf.open(self._index[table], "r")
            stream = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace",
                                      newline="")
        else:
            stream = open(self._index[table], "r", encoding="utf-8-sig",
                          errors="replace", newline="")
        with stream as fh:
            for row in csv.DictReader(fh):
                yield row

    def header(self, table):
        for row in self.rows(table):
            return list(row.keys())
        return []

    def close(self):
        if self._zf:
            self._zf.close()


def col(row, *names):
    """Fetch a column tolerantly (ACMA casing has varied between releases)."""
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


def load_anchors(path, bundled_path):
    src = path or bundled_path
    if src and os.path.exists(src):
        with open(src, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and "stations" in data:
            out = []
            for s in data["stations"]:
                if "repeater" not in (s.get("roles") or []):
                    continue
                if s.get("lat") is None or s.get("lon") is None:
                    continue
                r = s.get("repeater") or {}
                out.append({"id": s.get("id"), "name": s.get("name"),
                            "lat": s["lat"], "lon": s["lon"],
                            "rx_mhz": r.get("rx_mhz"), "tx_mhz": r.get("tx_mhz")})
            return out
        return data
    raise SystemExit(
        "No anchor list found. Pass --stations path/to/stations.json "
        "(download it from your repo) or place anchors.json beside this script."
    )


def build_windows(anchors, harmonics, tol_khz):
    """Frequency windows of interest, in Hz."""
    tol = tol_khz * 1e3
    rx = sorted({a["rx_mhz"] for a in anchors if a.get("rx_mhz")} | set(DEFAULT_RX_MHZ))
    windows = [(VHF_LOW_MHZ * 1e6, VHF_HIGH_MHZ * 1e6, "vhf_high_band")]
    for f in rx:
        for n in harmonics:
            centre = (f / n) * 1e6
            if centre < VHF_LOW_MHZ * 1e6 or centre > VHF_HIGH_MHZ * 1e6:
                windows.append((centre - tol, centre + tol,
                                "harmonic_n%d_of_%.4f" % (n, f)))
    return windows, rx


def in_windows(freq_hz, windows):
    for lo, hi, tag in windows:
        if lo <= freq_hz <= hi:
            return tag
    return None


def write_csv(path, fieldnames, rows):
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--zip", help="path to spectra_rrl.zip")
    g.add_argument("--csv-dir", help="path to a folder of already-extracted CSVs")
    ap.add_argument("--out", default="acma_subset", help="output directory")
    ap.add_argument("--stations", help="path to stations.json (else uses anchors.json)")
    ap.add_argument("--radius-km", type=float, default=60.0)
    ap.add_argument("--cosite-m", type=float, default=250.0,
                    help="devices this close to a repeater are kept at ANY frequency")
    ap.add_argument("--tol-khz", type=float, default=25.0,
                    help="half-width of harmonic source windows")
    ap.add_argument("--harmonics", default="2,3,4,5")
    ap.add_argument("--keep-receivers", action="store_true",
                    help="also keep DEVICE_TYPE='R' rows (default: transmitters only)")
    ap.add_argument("--no-text-blocks", action="store_true",
                    help="skip applic_text_block (advisory notes / special conditions)")
    args = ap.parse_args()

    harmonics = [int(x) for x in args.harmonics.split(",") if x.strip()]
    here = os.path.dirname(os.path.abspath(__file__))
    anchors = load_anchors(args.stations, os.path.join(here, "anchors.json"))
    os.makedirs(args.out, exist_ok=True)

    src = Source(zip_path=args.zip, csv_dir=args.csv_dir)

    print("Tables found: %d" % len(src._index))
    for t in ("site", "device_details", "licence", "client", "antenna"):
        if not src.has(t):
            raise SystemExit("Missing required table: %s.csv" % t)
        print("  %-22s %10.1f MB" % (t, src.size(t) / 1e6))

    windows, rx_list = build_windows(anchors, harmonics, args.tol_khz)
    print("\nAnchors: %d repeaters (%d with rx_mhz)"
          % (len(anchors), sum(1 for a in anchors if a.get("rx_mhz"))))
    print("RX frequencies: %s" % ", ".join("%.4f" % f for f in rx_list))
    print("Frequency windows: %d" % len(windows))
    print("Radius: %.0f km   Co-site: %.0f m\n" % (args.radius_km, args.cosite_m))

    # ---- Pass 1: sites -----------------------------------------------------
    print("Pass 1/5  scanning sites ...")
    site_hdr = src.header("site")
    kept_sites, cosite_ids = {}, set()
    n_seen = 0
    for row in src.rows("site"):
        n_seen += 1
        lat = to_float(col(row, "LATITUDE"))
        lon = to_float(col(row, "LONGITUDE"))
        if lat is None or lon is None:
            continue
        best_km, best_a = None, None
        for a in anchors:
            d = haversine_km(lat, lon, a["lat"], a["lon"])
            if best_km is None or d < best_km:
                best_km, best_a = d, a
            if d <= args.cosite_m / 1000.0:
                break
        if best_km is not None and best_km <= args.radius_km:
            sid = col(row, "SITE_ID")
            row["_NEAREST_ANCHOR_ID"] = best_a["id"]
            row["_NEAREST_ANCHOR_NAME"] = best_a["name"]
            row["_DISTANCE_KM"] = round(best_km, 3)
            kept_sites[sid] = row
            if best_km <= args.cosite_m / 1000.0:
                cosite_ids.add(sid)
    print("          %d of %d sites within %.0f km (%d co-sited)\n"
          % (len(kept_sites), n_seen, args.radius_km, len(cosite_ids)))

    if not kept_sites:
        raise SystemExit("No sites matched. Check --radius-km and the anchor list.")

    # ---- Pass 2: devices ---------------------------------------------------
    print("Pass 2/5  streaming device_details (%.0f MB) ..." % (src.size("device_details") / 1e6))
    dev_hdr = src.header("device_details")
    kept_devs = []
    licence_nos, client_nos, antenna_ids, tcs_ids = set(), set(), set(), set()
    n_seen = 0
    for row in src.rows("device_details"):
        n_seen += 1
        if n_seen % 500000 == 0:
            print("          %d rows scanned, %d kept" % (n_seen, len(kept_devs)))
        sid = col(row, "SITE_ID")
        if not sid or sid not in kept_sites:
            continue
        dtype = (col(row, "DEVICE_TYPE") or "").strip().upper()
        if not args.keep_receivers and dtype == "R":
            continue
        freq = to_float(col(row, "FREQUENCY"))
        reason = None
        if sid in cosite_ids:
            reason = "cosite"
        elif freq is not None:
            reason = in_windows(freq, windows)
        if not reason:
            continue
        row["_KEEP_REASON"] = reason
        row["_SITE_DISTANCE_KM"] = kept_sites[sid]["_DISTANCE_KM"]
        row["_NEAREST_ANCHOR_ID"] = kept_sites[sid]["_NEAREST_ANCHOR_ID"]
        kept_devs.append(row)
        ln = col(row, "LICENCE_NO")
        if ln:
            licence_nos.add(ln)
        aid = col(row, "ANTENNA_ID")
        if aid:
            antenna_ids.add(aid)
        tid = col(row, "TCS_ID")
        if tid:
            tcs_ids.add(str(tid))
    print("          %d of %d devices kept\n" % (len(kept_devs), n_seen))

    # trim sites to those actually referenced
    used_sites = {col(d, "SITE_ID") for d in kept_devs}
    kept_sites = {k: v for k, v in kept_sites.items() if k in used_sites}

    # ---- Pass 3: licences --------------------------------------------------
    print("Pass 3/5  filtering licences ...")
    lic_hdr = src.header("licence")
    kept_lics = []
    for row in src.rows("licence"):
        if col(row, "LICENCE_NO") in licence_nos:
            kept_lics.append(row)
            cn = col(row, "CLIENT_NO")
            if cn:
                client_nos.add(str(cn).strip())
    print("          %d licences\n" % len(kept_lics))

    # ---- Pass 4: clients + antennas ---------------------------------------
    print("Pass 4/5  filtering clients and antennas ...")
    cli_hdr = src.header("client")
    kept_clients = [r for r in src.rows("client")
                    if str(col(r, "CLIENT_NO") or "").strip() in client_nos]
    ant_hdr = src.header("antenna")
    kept_ants = [r for r in src.rows("antenna")
                 if col(r, "ANTENNA_ID") in antenna_ids]
    print("          %d clients, %d antennas\n" % (len(kept_clients), len(kept_ants)))

    # ---- Pass 5: text blocks + lookups ------------------------------------
    kept_text, text_hdr = [], []
    if not args.no_text_blocks and src.has("applic_text_block"):
        print("Pass 5/5  filtering advisory notes and special conditions (%.0f MB) ..."
              % (src.size("applic_text_block") / 1e6))
        text_hdr = src.header("applic_text_block")
        for row in src.rows("applic_text_block"):
            prefix = (col(row, "APTB_TABLE_PREFIX") or "").strip().upper()
            if prefix == "LI" and col(row, "LICENCE_NO") in licence_nos:
                kept_text.append(row)
            elif prefix == "TCS" and str(col(row, "APTB_TABLE_ID") or "") in tcs_ids:
                kept_text.append(row)
        print("          %d text blocks\n" % len(kept_text))
    else:
        print("Pass 5/5  skipping applic_text_block\n")

    # ---- Write -------------------------------------------------------------
    print("Writing to %s/ ..." % args.out)
    write_csv(os.path.join(args.out, "site.csv"),
              site_hdr + ["_NEAREST_ANCHOR_ID", "_NEAREST_ANCHOR_NAME", "_DISTANCE_KM"],
              kept_sites.values())
    write_csv(os.path.join(args.out, "device_details.csv"),
              dev_hdr + ["_KEEP_REASON", "_SITE_DISTANCE_KM", "_NEAREST_ANCHOR_ID"],
              kept_devs)
    write_csv(os.path.join(args.out, "licence.csv"), lic_hdr, kept_lics)
    write_csv(os.path.join(args.out, "client.csv"), cli_hdr, kept_clients)
    write_csv(os.path.join(args.out, "antenna.csv"), ant_hdr, kept_ants)
    if kept_text:
        write_csv(os.path.join(args.out, "applic_text_block.csv"), text_hdr, kept_text)

    for t in LOOKUP_TABLES:
        if src.has(t):
            hdr = src.header(t)
            write_csv(os.path.join(args.out, "%s.csv" % t), hdr, src.rows(t))

    if src.has("antenna_pattern") and antenna_ids:
        hdr = src.header("antenna_pattern")
        pats = [r for r in src.rows("antenna_pattern")
                if col(r, "ANTENNA_ID") in antenna_ids]
        write_csv(os.path.join(args.out, "antenna_pattern.csv"), hdr, pats)

    total = 0
    sizes = {}
    for n in sorted(os.listdir(args.out)):
        if n.endswith(".csv"):
            b = os.path.getsize(os.path.join(args.out, n))
            sizes[n] = b
            total += b

    manifest = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "generator": "acma_prefilter.py",
        "source": os.path.basename(args.zip or args.csv_dir),
        "attribution": "Contains ACMA Register of Radiocommunications Licences data, CC BY 4.0",
        "parameters": {
            "radius_km": args.radius_km, "cosite_m": args.cosite_m,
            "tol_khz": args.tol_khz, "harmonics": harmonics,
            "transmitters_only": not args.keep_receivers,
            "frequency_units": "Hz",
        },
        "anchors": {"count": len(anchors),
                    "with_rx_mhz": sum(1 for a in anchors if a.get("rx_mhz")),
                    "rx_frequencies_mhz": rx_list},
        "counts": {"sites": len(kept_sites), "devices": len(kept_devs),
                   "licences": len(kept_lics), "clients": len(kept_clients),
                   "antennas": len(kept_ants), "text_blocks": len(kept_text)},
        "file_bytes": sizes,
        "total_bytes": total,
    }
    with open(os.path.join(args.out, "_manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    print("\n" + "=" * 58)
    for n, b in sizes.items():
        print("  %-28s %8.2f MB" % (n, b / 1e6))
    print("  %-28s %8.2f MB" % ("TOTAL", total / 1e6))
    print("=" * 58)
    if total > 25e6:
        print("\n!! Over 25 MB. Re-run with a smaller --radius-km (try 30),")
        print("   or add --no-text-blocks, to get it under the upload limit.")
    else:
        print("\nOK — this will fit through a GitHub upload. Zip the folder and")
        print("commit it, or attach it to your Claude Code session.")
    src.close()


if __name__ == "__main__":
    main()
