#!/usr/bin/env python3
"""
build_geo_layers.py — rebuild the catchment and hub map layers from their KMZs.

WHY THIS EXISTS
    `kml_to_geojson.py` is deliberately generic. This is the MegaNet half: the
    handful of facts about *these two files* that a general converter has no
    business knowing, in one readable place, so that a newer KMZ is a rerun
    rather than an archaeology exercise.

    Those facts are:

    Basins arrive in pieces. The 2009 Queensland basin export has 83 placemarks
    for 77 basins: "Border Rivers 1/2/3", "Stradbroke 1/2/3/4", and "Maroochy"
    twice with no numbers at all. stations.json has always called the first of
    those `border_rivers`, singular, and every station on it points at that id.
    So the pieces are merged back into one multipolygon per basin before
    anything downstream sees them.

    BASIN_NUMB is two fields in a trenchcoat. Border Rivers reads "416 QLDNSW",
    everything else reads a bare number. That is the basin number and the fact
    that the basin straddles a state line, and it is exactly the split that
    `meganet.catchment` already models with `basin_no` + `border` — one row,
    "QLD/NSW", which until now nobody could say where it came from.

    One name is shouted in lower case. "hinchinbrook island" against 76 others
    in title case. stations.json says "Hinchinbrook Island"; so do we.

    Assignment is done at full resolution. The GeoJSON we ship is simplified to
    ~220 m and has its sub-square-kilometre islands dropped, because it is drawn
    at a zoom where none of that shows. Deciding which basin and which hub a
    station falls in is a different question and gets the untouched geometry —
    a station 80 m inside a boundary is inside it.

USAGE
    python3 tools/build_geo_layers.py --kmz-dir ~/Downloads
    python3 tools/build_geo_layers.py --kmz-dir ~/Downloads --check   # CI

    Writes:
      data/qld-basins.geojson     77 basins, drawn by map-catchments.js
      data/bom-hubs.geojson        8 hubs,   drawn by map-hubs.js
      data/geo-assignments.json   per-station basin + hub, for the loader

    Source KMZs are not in the repo (5 MB and 13 MB of someone else's export).
    Point --kmz-dir at wherever they are; the names are matched loosely so the
    upload's hash prefix does not matter.
"""

import argparse
import decimal
import glob
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kml_to_geojson as k2g  # noqa: E402
import snapshot_stations_json as snap  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# What we ship, versus what we decide with. The first pair is tuned by eye
# against the basemap; the second is "do not touch the data".
BASIN_DRAW = dict(tolerance=0.002, min_area_km2=0.0, precision=5)
HUB_DRAW = dict(tolerance=0.004, min_area_km2=1.0, precision=5)
EXACT = dict(tolerance=0.0, min_area_km2=0.0, precision=9)

# How far outside every hub a station may be and still be given one. The
# stations this catches are on rivers and in harbours, all within a few
# hundred metres of a shoreline; 25 km is loose enough not to have to argue
# about the coastline's resolution and tight enough that a real gap stays a
# real gap.
HUB_SNAP_KM = 25.0


class Opts:
    """kml_to_geojson.build() takes an argparse namespace; this is one."""

    def __init__(self, name_from, **kw):
        self.name_from = name_from
        self.id_from = None
        self.keep = None
        self.tolerance = kw["tolerance"]
        self.min_area_km2 = kw["min_area_km2"]
        self.precision = kw["precision"]


def find_kmz(kmz_dir, needle):
    hits = [p for p in glob.glob(os.path.join(kmz_dir, "*"))
            if needle.lower() in os.path.basename(p).lower()
            and p.lower().endswith((".kmz", ".kml"))]
    if not hits:
        raise SystemExit(f"no file matching '{needle}' in {kmz_dir}")
    return sorted(hits)[0]


# ── Basins ───────────────────────────────────────────────────────────────────

PART = re.compile(r"\s+\d+$")


def title_if_shouted(name):
    """"hinchinbrook island" -> "Hinchinbrook Island". Leave O'Connell alone."""
    return name.title() if name and name == name.lower() else name


def merge_basin_parts(features):
    """83 placemarks -> 77 basins, keyed on the name with its part number gone."""
    groups = {}
    order = []
    for f in features:
        base = title_if_shouted(PART.sub("", f["properties"]["name"]).strip())
        key = k2g.slugify(base)
        if key not in groups:
            groups[key] = {"name": base, "parts": []}
            order.append(key)
        groups[key]["parts"].append(f)

    out = []
    for key in order:
        g = groups[key]
        parts = g["parts"]
        # Biggest part first — it carries the label and, where the parts
        # disagree, the attribute.
        parts.sort(key=lambda f: -sum(k2g.ring_area_km2([tuple(p) for p in ring])
                                      for ring in _outer_rings(f["geometry"])))

        polys = []
        for f in parts:
            geom = f["geometry"]
            if geom["type"] == "Polygon":
                polys.append(geom["coordinates"])
            else:
                polys.extend(geom["coordinates"])

        props = {}
        for f in reversed(parts):          # smallest first, so biggest wins
            props.update(f["properties"])

        # "416 QLDNSW" is a basin number and a border. Any part that has the
        # border form settles it for the whole basin.
        border = None
        numb = props.get("BASIN_NUMB", "")
        for f in parts:
            raw = f["properties"].get("BASIN_NUMB", "")
            m = re.match(r"^\s*(\d+)\s+([A-Z]{3})([A-Z]{3})\s*$", raw)
            if m:
                numb = m.group(1)
                border = f"{m.group(2)}/{m.group(3)}"
                break
            if re.match(r"^\s*\d+\s*$", raw):
                numb = raw.strip()

        # Areas are per part and the basin is the sum of them.
        area = 0.0
        for f in parts:
            try:
                area += float(f["properties"].get("Basin_Area_Sqkm") or 0)
            except ValueError:
                pass

        props["name"] = g["name"]
        props["id"] = key
        props["basin_no"] = numb
        props["area_sqkm"] = round(area, 2)
        props["division"] = props.get("Drainage_Div", "")
        props["division_no"] = props.get("Drainage_Div_No", "")
        if border:
            props["border"] = border
        if len(parts) > 1:
            props["parts"] = len(parts)
        for gone in ("BASIN_NAME", "BASIN_NUMB", "Basin_Area_Sqkm",
                     "Drainage_Div", "Drainage_Div_No"):
            props.pop(gone, None)

        geom = ({"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1
                else {"type": "MultiPolygon", "coordinates": polys})
        out.append({"type": "Feature", "properties": props, "geometry": geom})

    out.sort(key=lambda f: f["properties"]["name"].lower())
    return out


def _outer_rings(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"][0]]
    return [poly[0] for poly in geom["coordinates"]]


# ── Hubs ─────────────────────────────────────────────────────────────────────

def tidy_hubs(features):
    for f in features:
        p = f["properties"]
        p["name"] = p.get("Hub_Name") or p["name"]
        p["id"] = k2g.slugify(re.sub(r"\s+Hub$", "", p["name"]))
        try:
            p["area_sqkm"] = round(float(p.get("Area") or 0), 2)
        except ValueError:
            pass
        for gone in ("Hub_Name", "FID", "Area", "Perimeter"):
            p.pop(gone, None)
    features.sort(key=lambda f: f["properties"]["name"].lower())
    return features


# ── Point in polygon ─────────────────────────────────────────────────────────

def bbox(rings):
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    return min(xs), min(ys), max(xs), max(ys)


def in_ring(x, y, ring):
    """Ray casting. A point exactly on an edge may go either way; at these
    scales nothing is exactly on an edge, and a station that were would be a
    coin toss between two neighbours either way."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def index_features(features):
    """[(id, name, [(bbox, outer, holes), ...]), ...] — bbox first, so 3,174
    stations against 664 rings is 3,174 cheap rejections and a few real tests."""
    idx = []
    for f in features:
        geom = f["geometry"]
        polys = ([geom["coordinates"]] if geom["type"] == "Polygon"
                 else geom["coordinates"])
        shapes = []
        for rings in polys:
            outer = rings[0]
            holes = rings[1:]
            shapes.append((bbox([outer]), outer, holes))
        idx.append((f["properties"]["id"], f["properties"]["name"], shapes))
    return idx


def _seg_dist_km(lon, lat, a, b):
    """Point-to-segment distance, flat-earth scaled at the point's latitude."""
    kx = 111.32 * math.cos(math.radians(lat))
    ky = 110.57
    px, py = lon * kx, lat * ky
    ax, ay = a[0] * kx, a[1] * ky
    bx, by = b[0] * kx, b[1] * ky
    dx, dy = bx - ax, by - ay
    if dx == 0.0 and dy == 0.0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def nearest(lon, lat, idx, max_km):
    """The closest feature boundary, for a point that is inside none of them.

    Every hub boundary is a coastline, so a gauge in the water is outside all
    eight of them — including the ones at Hawthorne and Jindalee, which are on
    the Brisbane River fifteen kilometres inland and unambiguously Brisbane's to
    maintain. Responsibility does not stop at the water's edge, so a point that
    lands in no hub takes the nearest one within max_km.
    """
    best, best_km = None, max_km
    for fid, name, shapes in idx:
        for (x0, y0, x1, y1), outer, _holes in shapes:
            # Cheap reject: if the bbox alone is further than the best so far,
            # no vertex of this ring can beat it.
            dx = max(x0 - lon, 0.0, lon - x1) * 111.32 * math.cos(math.radians(lat))
            dy = max(y0 - lat, 0.0, lat - y1) * 110.57
            if math.hypot(dx, dy) >= best_km:
                continue
            for i in range(len(outer) - 1):
                d = _seg_dist_km(lon, lat, outer[i], outer[i + 1])
                if d < best_km:
                    best, best_km = fid, d
    return best, (best_km if best else None)


def locate(lon, lat, idx):
    """Every feature containing the point, outermost test first."""
    hits = []
    for fid, name, shapes in idx:
        for (x0, y0, x1, y1), outer, holes in shapes:
            if not (x0 <= lon <= x1 and y0 <= lat <= y1):
                continue
            if in_ring(lon, lat, outer) and not any(in_ring(lon, lat, h) for h in holes):
                hits.append((fid, name))
                break
    return hits


# ── Output ───────────────────────────────────────────────────────────────────

def dump(path, features, meta, check):
    body = ("{\n"
            '"type": "FeatureCollection",\n'
            '"meta": ' + json.dumps(meta, sort_keys=True) + ",\n"
            '"features": [\n'
            + ",\n".join(json.dumps(f, separators=(",", ":"), sort_keys=True)
                         for f in features)
            + "\n]\n}\n")
    return _write(path, body, check)


def _write(path, body, check):
    if check:
        have = open(path, encoding="utf-8").read() if os.path.exists(path) else None
        if have != body:
            print(f"{path}: would change", file=sys.stderr)
            return False
        print(f"{path}: up to date ({len(body):,} bytes)")
        return True
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)
    print(f"{path}: {len(body):,} bytes")
    return True


# Areas that disagree by more than this fraction are a different measurement,
# not a rounding of the same one, and are left alone. Two do: Torres Strait
# Islands (6,856.7 km2 on file, 571.4 in the KML) and Moreton Island (1,152.6
# against 172.2). Both are island groups, and in both cases the KML carries one
# small polygon where the vocabulary carries what reads like the whole island
# group or the basin including its water. The file's number is the more likely
# of the two to be right, so it stays, and the disagreement is printed instead
# of being buried under it.
AREA_DISAGREE = 0.01


def update_stations(path, basins, hubs, rows, check):
    """Fold the new vocabulary and the new per-station facts into stations.json.

    Deliberately narrow. This writes exactly four things — the drainage division
    on each catchment, the basins the vocabulary was missing, the hubs[] list,
    and each station's catchment_ids and hub_id — and leaves every other byte of
    a 3.6 MB file alone. It renders through tools/snapshot_stations_json.py, so
    the key order and the number formatting are the committed file's own and the
    diff is the change and nothing else.
    """
    with open(path, encoding="utf-8") as fh:
        doc = json.loads(fh.read(), parse_float=decimal.Decimal)

    by_id = {f["properties"]["id"]: f["properties"] for f in basins}
    existing = {c["id"]: c for c in doc["catchments"]}

    # ── catchments: the division, and the basins the list did not have ───────
    added, area_notes = [], []
    for c in doc["catchments"]:
        k = by_id.get(c["id"])
        if not k:
            continue
        if k.get("division"):
            c["division"] = k["division"]
        if k.get("division_no"):
            c["division_no"] = k["division_no"]
        have, kml_area = float(c.get("area_sqkm") or 0), float(k.get("area_sqkm") or 0)
        if have and abs(have - kml_area) / have > AREA_DISAGREE:
            area_notes.append((c["id"], have, kml_area))

    for fid, k in sorted(by_id.items()):
        if fid in existing:
            continue
        row = {"id": fid, "name": k["name"], "basin_no": k["basin_no"],
               "area_sqkm": decimal.Decimal(str(k["area_sqkm"]))}
        # `region` is MegaNet's own map grouping, not the Bureau's, so it cannot
        # come out of the KML. A basin sharing its number with one already on the
        # list is the same stretch of country and takes its region; anything else
        # is left without one, which 22 basins on the list already are.
        twin = next((c for c in doc["catchments"]
                     if str(c.get("basin_no")) == str(k["basin_no"]) and c.get("region")), None)
        if twin:
            row["region"] = twin["region"]
        if k.get("division"):
            row["division"] = k["division"]
        if k.get("division_no"):
            row["division_no"] = k["division_no"]
        if k.get("border"):
            row["border"] = k["border"]
        doc["catchments"].append(row)
        added.append(fid)

    doc["catchments"].sort(key=lambda c: c["name"].lower())

    # ── hubs: a new vocabulary beside catchments[] ───────────────────────────
    doc["hubs"] = [{"id": h["properties"]["id"], "name": h["properties"]["name"],
                    "area_sqkm": decimal.Decimal(str(h["properties"]["area_sqkm"]))}
                   for h in hubs]

    # ── stations ────────────────────────────────────────────────────────────
    assign = {r["station_id"]: r for r in rows}
    moved = hubbed = 0
    for st in doc["stations"]:
        r = assign.get(st["id"])
        if not r:
            continue
        if sorted(st.get("catchment_ids") or []) != r["catchment_ids"]:
            st["catchment_ids"] = list(r["catchment_ids"])
            moved += 1
        if r["hub_id"]:
            if st.get("hub_id") != r["hub_id"]:
                hubbed += 1
            st["hub_id"] = r["hub_id"]

    doc["meta"]["description"] = (
        "MegaNet station database. catchments[] is the Queensland drainage-basin "
        "vocabulary used by the Network Maps navigator, with each basin's drainage "
        "division; hubs[] is the Bureau's field maintenance hubs. Per-station "
        "catchment_ids and hub_id are point-in-polygon against the boundaries in "
        "data/qld-basins.geojson and data/bom-hubs.geojson (see tools/"
        "build_geo_layers.py), not against the affine-fitted basin SVG.")

    text = snap.render(doc)
    ok = _write(path, text, check)
    print(f"  stations.json  {len(doc['catchments'])} catchments "
          f"({len(added)} added: {', '.join(added) or 'none'}), "
          f"{len(doc['hubs'])} hubs, {moved} catchment_ids changed, {hubbed} hub_id set")
    for cid, have, kml_area in area_notes:
        print(f"  ! {cid}: area_sqkm {have} on file, {kml_area} in the KML — "
              f"left as it was, they are not the same measurement")
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--kmz-dir", required=True)
    ap.add_argument("--stations", default=os.path.join(REPO, "stations.json"))
    ap.add_argument("--out-dir", default=os.path.join(REPO, "data"))
    ap.add_argument("--write-stations", action="store_true",
                    help="also fold the result into stations.json")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)

    basin_src = find_kmz(a.kmz_dir, "QldBasin")
    hub_src = find_kmz(a.kmz_dir, "Hub_Boundaries")
    print(f"basins  {os.path.basename(basin_src)}")
    print(f"hubs    {os.path.basename(hub_src)}")

    basins_draw, _ = k2g.build(basin_src, Opts("BASIN_NAME", **BASIN_DRAW))
    basins_draw = merge_basin_parts(basins_draw["features"])
    basins_exact, _ = k2g.build(basin_src, Opts("BASIN_NAME", **EXACT))
    basins_exact = merge_basin_parts(basins_exact["features"])

    hubs_draw, hstat = k2g.build(hub_src, Opts("Hub_Name", **HUB_DRAW))
    hubs_draw = tidy_hubs(hubs_draw["features"])
    hubs_exact, _ = k2g.build(hub_src, Opts("Hub_Name", **EXACT))
    hubs_exact = tidy_hubs(hubs_exact["features"])

    print(f"  basins  {len(basins_draw)} after merging parts")
    print(f"  hubs    {len(hubs_draw)}, "
          f"{hstat['rings_in'] - hstat['rings_kept']} islands under "
          f"{HUB_DRAW['min_area_km2']} km2 left off the drawn copy "
          f"({hstat['dropped_km2']:.0f} km2); assignment uses all of them")

    ok = True
    ok &= dump(os.path.join(a.out_dir, "qld-basins.geojson"), basins_draw,
               {"source": os.path.basename(basin_src),
                "generator": "tools/build_geo_layers.py",
                "tolerance_deg": BASIN_DRAW["tolerance"],
                "note": "Queensland drainage basins. Parts merged per basin."}, a.check)
    ok &= dump(os.path.join(a.out_dir, "bom-hubs.geojson"), hubs_draw,
               {"source": os.path.basename(hub_src),
                "generator": "tools/build_geo_layers.py",
                "tolerance_deg": HUB_DRAW["tolerance"],
                "min_area_km2": HUB_DRAW["min_area_km2"],
                "note": "Bureau maintenance hub boundaries, May 2018."}, a.check)

    # ── Assignment, at full resolution ───────────────────────────────────────
    doc = json.load(open(a.stations, encoding="utf-8"))
    bidx, hidx = index_features(basins_exact), index_features(hubs_exact)

    rows, no_basin, no_hub, moved, kept_legacy, snapped = [], 0, 0, [], [], []
    for s in doc["stations"]:
        lat, lon = s.get("lat"), s.get("lon")
        if lat is None or lon is None:
            continue
        bh = sorted(fid for fid, _ in locate(lon, lat, bidx))
        hh = [fid for fid, _ in locate(lon, lat, hidx)]
        was = sorted(s.get("catchment_ids") or [])

        # A point in no basin keeps whatever it had. The four stations this
        # saves are tide gauges — Brisbane Bar, Whyte Island, Mackay Outer
        # Harbour, Horseshoe Bay on Magnetic Island — sitting in the water off
        # the mouth of the river they report for. The basin polygons stop at
        # the coast, so the honest geometric answer for them is "nowhere", and
        # "nowhere" is worse than the answer they already had.
        if not bh:
            no_basin += 1
            if was:
                kept_legacy.append({"id": s["id"], "catchment_ids": was})
                bh = was
        hub, hub_km = (hh[0], 0.0) if hh else (None, None)
        if not hh:
            no_hub += 1
            hub, hub_km = nearest(lon, lat, hidx, HUB_SNAP_KM)
            if hub:
                snapped.append({"id": s["id"], "hub_id": hub,
                                "km_outside": round(hub_km, 2)})
        if bh != was:
            moved.append({"id": s["id"], "was": was, "now": bh})
        rows.append({"station_id": s["id"],
                     "station_number": s.get("station_number") or None,
                     "catchment_ids": bh,
                     "hub_id": hub})

    rows.sort(key=lambda r: r["station_id"])
    moved.sort(key=lambda r: r["id"])
    kept_legacy.sort(key=lambda r: r["id"])
    snapped.sort(key=lambda r: r["id"])
    # The audit record, and deliberately not the answers: every station's basin
    # and hub is in stations.json, and a second copy of 3,173 rows here would be
    # 500 KB of the same thing waiting to disagree with it. What is kept is what
    # stations.json cannot say — which assignments *changed*, which stations
    # kept an id the geometry would have taken away, and which were snapped to a
    # hub they are not technically inside. Those are the three judgement calls in
    # this tool, and they are the ones worth being able to re-read.
    body = json.dumps({
        "meta": {"generator": "tools/build_geo_layers.py",
                 "basins": os.path.basename(basin_src),
                 "hubs": os.path.basename(hub_src),
                 "stations": len(rows),
                 "with_basin": sum(1 for r in rows if r["catchment_ids"]),
                 "without_basin": no_basin,
                 "without_hub": no_hub,
                 "hub_snap_km": HUB_SNAP_KM,
                 "catchment_changes": len(moved),
                 "kept_legacy_catchment": len(kept_legacy),
                 "hub_snapped": len(snapped)},
        "catchment_changes": moved,
        "kept_legacy_catchment": kept_legacy,
        "hub_snapped": snapped,
    }, indent=1, sort_keys=True) + "\n"
    ok &= _write(os.path.join(a.out_dir, "geo-assignments.json"), body, a.check)

    print(f"  stations {len(rows)}: {no_basin} in no basin ({len(kept_legacy)} of them "
          f"keeping the id they had), {no_hub} in no hub, "
          f"{len(moved)} whose catchment_ids this changes")
    print(f"  hubs     {len(snapped)} stations outside every hub boundary snapped "
          f"to the nearest within {HUB_SNAP_KM} km")

    if a.write_stations:
        ok &= update_stations(a.stations, basins_draw, hubs_draw, rows, a.check)

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
