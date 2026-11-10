#!/usr/bin/env python3
"""
acma_station_licences.py — the radio licences that flood-warning telemetry
runs under, out of the ACMA register, as the one small JSON the Stations map's
📜 ACMA licences tool and the station card's "Licences near here" read
(map-acma.js).

PIPELINE POSITION
    spectra_rrl.zip (ACMA daily extract, ~68 MB — never committed)
        └─ tools/acma_station_licences.py → data/acma-station-licences.json

    Runs in the weekly ACMA refresh (.github/workflows/acma-refresh.yml),
    straight off the zip the interference pipeline already downloads.
    Standard library only, like the other ACMA tools.

WHY ITS OWN FILE
    The interference extract (acma_prefilter.py → data/acma-raw →
    acma-licensing.json) answers "who else transmits near our receivers": it
    keeps transmitters only, within 60 km of a repeater, in one band. This
    asks the opposite question — "what are OUR transmitters licensed under" —
    and needs what that extract drops: the receive end of a point-to-point
    link (the far end of the line on the map), the licences of the holders
    wherever in the country they are, and each licence's special conditions.

WHICH LICENCES
    Fixed-service licences (point to multipoint, point to point) held by:

      bureau   the Bureau of Meteorology — every fixed licence below 1 GHz;
      channel  anybody else with a fixed licence on one of the channels this
               network's stations use (--stations: the repeaters' and bases'
               frequencies, 148–174 MHz) — their fixed licences in that band;
      council  local governments with a point-to-multipoint licence in
               148–174 MHz — those licences. A council's own flood gauges
               usually sit on a channel of its own beside the Bureau's.

    A licensee registered as a private individual is never named (and none
    qualifies today). Every status the register still lists is kept —
    granted, expired, surrendered — so the app can say which.

WHAT IT DOES NOT KNOW
    A point-to-multipoint licence names its base station only. The remote
    stations that talk to that base are authorised by the same licence but
    are not recorded on it or in the register, and the licence states no
    distance. The app draws ACMA's planning radius round the base and says
    that it is a planning figure; this file carries no radius.

Usage:
    python3 tools/acma_station_licences.py --zip /tmp/spectra_rrl.zip
    python3 tools/acma_station_licences.py --zip … --stations stations.json --out data/acma-station-licences.json
"""

import argparse
import csv
import io
import json
import os
import sys
import zipfile
from datetime import datetime, timezone

csv.field_size_limit(1 << 30)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

BAND_MHZ = (148.0, 174.0)          # ACMA's VHF high band
BUREAU_MAX_MHZ = 1000.0            # the Bureau's links to its offices are at 400–470 MHz
DEFAULT_NET_MHZ = (151.5, 151.525, 151.95, 152.4)
CHANNEL_TOL_MHZ = 0.001
FIXED_SV = "2"                     # licence_service.csv: Fixed
LOCAL_GOVERNMENT = "Local Government"
PERSON = "Person"
BUREAU_NAME = "BUREAU OF METEOROLOGY"


def rows(z, name):
    with z.open(name) as fh:
        yield from csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace", newline=""))


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def rnd(v, dp):
    return None if v is None else round(v, dp)


def watts(value, unit):
    """A power in watts, whatever unit the register wrote it in."""
    v = num(value)
    if v is None:
        return None
    u = (unit or "W").strip()
    scale = {"W": 1.0, "kW": 1e3, "MW": 1e6, "mW": 1e-3, "uW": 1e-6, "pW": 1e-12}.get(u)
    if scale is None:
        return None
    return v * scale


def network_channels(stations_path):
    """The channels this network's stations use, from the station list."""
    out = set(DEFAULT_NET_MHZ)
    try:
        with open(stations_path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return sorted(out)
    for s in (doc.get("stations") or []):
        pairs = list(s.get("frequencies") or [])
        if s.get("repeater"):
            pairs.append(s["repeater"])
        for p in pairs:
            for k in ("rx_mhz", "tx_mhz"):
                f = num(p.get(k))
                if f is not None and BAND_MHZ[0] <= f <= BAND_MHZ[1]:
                    out.add(round(f, 4))
    return sorted(out)


def on_channel(f, channels):
    return any(abs(f - c) <= CHANNEL_TOL_MHZ for c in channels)


def build(zip_path, stations_path):
    z = zipfile.ZipFile(zip_path)
    names = {n.lower(): n for n in z.namelist()}

    def member(n):
        if n not in names:
            sys.exit("%s is not in %s" % (n, zip_path))
        return names[n]

    channels = network_channels(stations_path)
    client_types = {r["TYPE_ID"]: r["NAME"] for r in rows(z, member("client_type.csv"))}
    clients = {r["CLIENT_NO"]: r for r in rows(z, member("client.csv"))}

    fixed = {}                                       # licence number → licence row
    for r in rows(z, member("licence.csv")):
        if r.get("SV_ID") == FIXED_SV:
            fixed[r["LICENCE_NO"]] = r

    def ctype(client_no):
        c = clients.get(client_no) or {}
        return client_types.get(c.get("CLIENT_TYPE_ID"), "")

    def is_bureau(client_no):
        return ((clients.get(client_no) or {}).get("LICENCEE") or "").strip().upper() == BUREAU_NAME

    # Pass 1 over the devices: who holds what, and every fixed device kept by
    # licence until the holders are known.
    by_licence = {}
    channel_clients = set()
    council_licences = set()
    for d in rows(z, member("device_details.csv")):
        lic = fixed.get(d.get("LICENCE_NO"))
        if not lic:
            continue
        f_hz = num(d.get("FREQUENCY"))
        if f_hz is None:
            continue
        f = f_hz / 1e6
        client_no = lic["CLIENT_NO"]
        in_band = BAND_MHZ[0] <= f <= BAND_MHZ[1]
        bureau = is_bureau(client_no)
        if not in_band and not (bureau and f < BUREAU_MAX_MHZ):
            continue
        if ctype(client_no) == PERSON:
            continue
        by_licence.setdefault(lic["LICENCE_NO"], []).append(d)
        if in_band and on_channel(f, channels):
            channel_clients.add(client_no)
        if in_band and ctype(client_no) == LOCAL_GOVERNMENT and "multipoint" in (lic.get("LICENCE_CATEGORY_NAME") or "").lower():
            council_licences.add(lic["LICENCE_NO"])

    def holder_class(client_no):
        if is_bureau(client_no):
            return "bureau"
        if ctype(client_no) == LOCAL_GOVERNMENT:
            return "council"
        return "other"

    keep = []
    for number, devs in by_licence.items():
        client_no = fixed[number]["CLIENT_NO"]
        if is_bureau(client_no) or client_no in channel_clients or number in council_licences:
            keep.append(number)
    keep.sort(key=lambda n: (holder_class(fixed[n]["CLIENT_NO"]) != "bureau", fixed[n]["CLIENT_NO"], n))
    kept = set(keep)

    site_ids = {d["SITE_ID"] for n in keep for d in by_licence[n] if d.get("SITE_ID")}
    sites = {}
    for r in rows(z, member("site.csv")):
        if r["SITE_ID"] in site_ids:
            sites[r["SITE_ID"]] = r

    # The special conditions written on each licence (not the advisory notes,
    # which are the same paragraph on every licence of a type).
    cond_text, cond_ix, conds_of = [], {}, {}
    for r in rows(z, member("applic_text_block.csv")):
        n = r.get("LICENCE_NO")
        if n not in kept or (r.get("APTB_CATEGORY") or "").strip().upper() != "SPCOND":
            continue
        text = " ".join((r.get("APTB_TEXT") or "").split())
        if not text:
            continue
        if text not in cond_ix:
            cond_ix[text] = len(cond_text)
            cond_text.append(text)
        lst = conds_of.setdefault(n, [])
        if cond_ix[text] not in lst:
            lst.append(cond_ix[text])

    holder_ix, holders = {}, []
    site_ix, site_rows = {}, []
    licences, devices = [], []
    for number in keep:
        lic = fixed[number]
        client_no = lic["CLIENT_NO"]
        if client_no not in holder_ix:
            c = clients.get(client_no) or {}
            holder_ix[client_no] = len(holders)
            holders.append([client_no, (c.get("LICENCEE") or "").strip(), (c.get("TRADING_NAME") or "").strip(),
                            ctype(client_no), holder_class(client_no), client_no in channel_clients or is_bureau(client_no)])
        callsign = ""
        li = len(licences)
        for d in by_licence[number]:
            sid = d.get("SITE_ID") or ""
            s = sites.get(sid)
            if not s or num(s.get("LATITUDE")) is None or num(s.get("LONGITUDE")) is None:
                continue
            if sid not in site_ix:
                site_ix[sid] = len(site_rows)
                site_rows.append([sid, " ".join((s.get("NAME") or "").split()), rnd(num(s["LATITUDE"]), 6), rnd(num(s["LONGITUDE"]), 6),
                                  (s.get("STATE") or "").strip(), (s.get("SITE_PRECISION") or "").strip(), rnd(num(s.get("ELEVATION")), 0)])
            callsign = callsign or (d.get("CALL_SIGN") or "").strip()
            bw = num(d.get("BANDWIDTH"))
            devices.append([
                li, site_ix[sid], (d.get("DEVICE_TYPE") or "").strip().upper()[:1],
                rnd(num(d["FREQUENCY"]) / 1e6, 5), rnd(bw / 1e3, 2) if bw is not None else None,
                (d.get("EMISSION") or "").strip(),
                rnd(watts(d.get("TRANSMITTER_POWER"), d.get("TRANSMITTER_POWER_UNIT")), 3),
                rnd(watts(d.get("EIRP"), d.get("EIRP_UNIT")), 3),
                rnd(num(d.get("HEIGHT")), 1), rnd(num(d.get("AZIMUTH")), 1),
                (d.get("AUTHORISATION_DATE") or "").strip()[:10],
                (d.get("EFL_ID") or "").strip(), (d.get("RELATED_EFL_ID") or "").strip(),
            ])
        licences.append([
            number, (lic.get("STATUS_TEXT") or "").strip(), (lic.get("LICENCE_CATEGORY_NAME") or "").strip(),
            (lic.get("DATE_ISSUED") or "").strip()[:10], (lic.get("DATE_OF_EXPIRY") or "").strip()[:10],
            holder_ix[client_no], callsign, conds_of.get(number, []),
        ])

    stamp = max((i.date_time for i in z.infolist()), default=None)
    source_date = "%04d-%02d-%02d" % stamp[:3] if stamp else ""
    return {
        "meta": {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source_date": source_date,
            "source": "ACMA Spectra RRL daily extract (bulk download)",
            "attribution": "Contains data from the Australian Communications and Media Authority, "
                           "Register of Radiocommunications Licences (CC BY 4.0).",
            "note": "Read by the Stations map's ACMA licences tool and the station card (map-acma.js): the fixed "
                    "licences flood-warning telemetry runs under — the Bureau of Meteorology's, those of anybody else "
                    "on this network's channels, and councils' point-to-multipoint licences in 148-174 MHz — with both "
                    "ends of every point-to-point link and each licence's special conditions. Built by "
                    "tools/acma_station_licences.py. A point-to-multipoint licence names its base station only: the "
                    "remote stations it authorises are not in the register and it states no distance.",
            "rules": {"band_mhz": list(BAND_MHZ), "bureau_below_mhz": BUREAU_MAX_MHZ, "network_channels_mhz": channels},
            "columns": {
                "holders": ["client_no", "name", "trading_name", "type", "class", "on_network_channel"],
                "sites": ["id", "name", "lat", "lon", "state", "precision", "elevation_m"],
                "licences": ["number", "status", "category", "issued", "expiry", "holder", "callsign", "conditions"],
                "devices": ["licence", "site", "tr", "f_mhz", "bw_khz", "emission", "tx_w", "eirp_w", "antenna_m",
                            "azimuth", "authorised", "efl_id", "related_efl_id"],
            },
            "counts": {"holders": len(holders), "sites": len(site_rows), "licences": len(licences), "devices": len(devices),
                       "conditions": len(cond_text)},
        },
        "holders": holders,
        "sites": site_rows,
        "conditions": cond_text,
        "licences": licences,
        "devices": devices,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--zip", required=True, help="path to spectra_rrl.zip")
    ap.add_argument("--stations", default=os.path.join(ROOT, "stations.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "acma-station-licences.json"))
    args = ap.parse_args()

    doc = build(args.zip, args.stations)
    if not doc["licences"]:
        sys.exit("no licences kept — the register's layout may have changed; nothing written")
    lines = ["{", '"meta": ' + json.dumps(doc["meta"], indent=1) + ","]
    for key in ("holders", "sites", "conditions", "licences", "devices"):
        body = ",\n".join(json.dumps(r, separators=(",", ":"), ensure_ascii=False) for r in doc[key])
        lines.append('"%s": [\n%s\n]%s' % (key, body, "" if key == "devices" else ","))
    lines.append("}")
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    c = doc["meta"]["counts"]
    print("%s: %d licences of %d holders at %d sites, %d device rows, %d special conditions (%d bytes)" % (
        os.path.relpath(args.out, ROOT), c["licences"], c["holders"], c["sites"], c["devices"], c["conditions"],
        os.path.getsize(args.out)))


if __name__ == "__main__":
    main()
