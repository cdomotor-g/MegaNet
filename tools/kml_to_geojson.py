#!/usr/bin/env python3
"""
kml_to_geojson.py — turn a KML/KMZ of polygons into a web-sized GeoJSON.

WHY THIS EXISTS
    Two of the layers on the Stations map come from KMZ files a person was
    emailed: the Bureau's maintenance hub boundaries and the Queensland drainage
    basins. Both are shapefile exports dressed as KML — thousands of rings, a
    styled HTML table where the attributes should be, and coordinates written to
    thirteen decimal places (a millionth of a millimetre, for a boundary drawn by
    hand off a 1:250,000 map). Shipped raw they are 5 MB and 13 MB; the browser
    has to parse every byte before it can draw the first line.

    This turns one into the other, with nothing but the standard library — same
    rule as the rest of tools/, and the same reason: this repo has no build step
    and adding shapely to draw a polygon would be the first crack in that.

    Rerun it when a newer KMZ turns up. The output is deterministic — same input,
    same bytes out — so a re-export that changed nothing is diff-clean.

WHAT IT DOES, IN ORDER
    1. Reads the placemarks, taking attributes from the `<description>` CDATA
       (both source files hide their real fields in a two-column HTML table) and
       falling back to `<name>`.
    2. Drops rings smaller than --min-area-km2. The hub file is 5,931 polygons
       for 8 hubs, and all but ~40 of those are islets off Tasmania and Cape
       York that carry no maintenance meaning at this zoom. Nothing is dropped
       silently: the summary says how many, and --min-area-km2 0 keeps them all.
    3. Simplifies each ring with Douglas-Peucker at --tolerance degrees, and
       will not let a ring collapse below 4 points — a triangle that used to be a
       coastline is worse than a dropped island, because it still draws.
    4. Rounds coordinates to --precision decimal places. 5 dp is 1.1 m at this
       latitude, which is finer than the source data is true.

USAGE
    python3 tools/kml_to_geojson.py IN.kmz OUT.geojson [options]

    # the two files this was written for, as build/kml_layers.sh runs them
    python3 tools/kml_to_geojson.py QldBasin_2009Nov.kmz data/qld-basins.geojson \
        --id-from BASIN_NUMB --name-from BASIN_NAME --tolerance 0.002

    python3 tools/kml_to_geojson.py Hub_Boundaries.kmz data/bom-hubs.geojson \
        --name-from Hub_Name --tolerance 0.004 --min-area-km2 5

OPTIONS
    --tolerance DEG      Douglas-Peucker tolerance in degrees (default 0.002,
                         ~220 m). The basins are the size of small countries and
                         the hubs are the size of states; neither is drawn at a
                         zoom where 220 m shows.
    --min-area-km2 KM2   Drop rings below this (default 0 — keep everything).
    --precision N        Decimal places to keep (default 5).
    --id-from FIELD      Attribute to use as the feature id.
    --name-from FIELD    Attribute to use as the feature name.
    --keep FIELD,FIELD   Attributes to carry into properties (default: all).
    --check              Rewrite nothing; fail if the output would differ. CI.
"""

import argparse
import json
import math
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

KML_NS = "{http://www.opengis.net/kml/2.2}"

# Mean Earth radius. Only ever used to turn a shoelace area in square degrees
# into square kilometres for --min-area-km2, which is a threshold, not a
# measurement — the basin areas we report come from the source file's own
# attribute, computed by whoever drew it in a projection that suits Queensland.
EARTH_R_KM = 6371.0088


# ── Reading the KML ──────────────────────────────────────────────────────────

def read_kml(path):
    """The document text, whether it arrived as .kml or zipped up in a .kmz."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".kml")]
            if not names:
                raise SystemExit(f"{path}: a zip with no .kml in it")
            # doc.kml if it is there, otherwise the first one — which is what
            # every KMZ writer since Google Earth 4 has produced.
            name = "doc.kml" if "doc.kml" in names else names[0]
            return z.read(name).decode("utf-8", "replace")
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


# Both source files put their attributes in an HTML table inside <description>,
# as <td>KEY</td><td>VALUE</td>. That is an ArcGIS "export to KML" artefact and
# it is the only place the real field names survive, so it is worth parsing
# rather than working around.
_ROW = re.compile(
    r"<td[^>]*>\s*([^<>]+?)\s*</td>\s*<td[^>]*>\s*([^<>]*?)\s*</td>",
    re.I | re.S,
)


def attrs_from_description(text):
    if not text:
        return {}
    out = {}
    for key, val in _ROW.findall(text):
        key = " ".join(key.split())
        val = " ".join(val.split())
        # The table's own title row is <td>Hobart Hub</td> with no partner cell;
        # the regex cannot match it, but a stray colspan header could sneak
        # through as an empty-keyed pair.
        if key and key not in out:
            out[key] = val
    return out


def parse_coords(text):
    """KML coordinate soup -> [(lon, lat), ...], altitude dropped."""
    pts = []
    for chunk in text.split():
        parts = chunk.split(",")
        if len(parts) < 2:
            continue
        try:
            lon, lat = float(parts[0]), float(parts[1])
        except ValueError:
            continue
        pts.append((lon, lat))
    return pts


def rings_of_polygon(poly):
    """(outer, [inner, ...]) for one <Polygon>."""
    outer, inners = [], []
    for boundary in poly.findall(f"{KML_NS}outerBoundaryIs"):
        for ring in boundary.iter(f"{KML_NS}coordinates"):
            outer = parse_coords(ring.text or "")
    for boundary in poly.findall(f"{KML_NS}innerBoundaryIs"):
        for ring in boundary.iter(f"{KML_NS}coordinates"):
            pts = parse_coords(ring.text or "")
            if pts:
                inners.append(pts)
    return outer, inners


def placemarks(doc_text):
    """Yield (name, attrs, [ (outer, inners), ... ]) per placemark with polygons."""
    root = ET.fromstring(doc_text)
    for pm in root.iter(f"{KML_NS}Placemark"):
        name_el = pm.find(f"{KML_NS}name")
        name = (name_el.text or "").strip() if name_el is not None else ""
        desc_el = pm.find(f"{KML_NS}description")
        attrs = attrs_from_description(desc_el.text if desc_el is not None else "")
        polys = []
        for poly in pm.iter(f"{KML_NS}Polygon"):
            outer, inners = rings_of_polygon(poly)
            if len(outer) >= 4:
                polys.append((outer, inners))
        if polys:
            yield name, attrs, polys


# ── Geometry, by hand ────────────────────────────────────────────────────────

def ring_area_km2(ring):
    """Shoelace in degrees, scaled by the cosine of the ring's own latitude.

    Good to a few percent over a basin, which is all --min-area-km2 needs. The
    areas we publish are the source file's, not this.
    """
    if len(ring) < 3:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx = (math.pi / 180.0) * EARTH_R_KM * math.cos(math.radians(lat0))
    ky = (math.pi / 180.0) * EARTH_R_KM
    acc = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i][0] * kx, ring[i][1] * ky
        x2, y2 = ring[(i + 1) % len(ring)][0] * kx, ring[(i + 1) % len(ring)][1] * ky
        acc += x1 * y2 - x2 * y1
    return abs(acc) / 2.0


def _perp_dist2(pt, a, b):
    """Squared distance from pt to the segment a-b, in degrees."""
    (px, py), (ax, ay), (bx, by) = pt, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0.0 and dy == 0.0:
        return (px - ax) ** 2 + (py - ay) ** 2
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    qx, qy = ax + t * dx, ay + t * dy
    return (px - qx) ** 2 + (py - qy) ** 2


def simplify(points, tolerance):
    """Douglas-Peucker, iterative — a 60,000-point coastline overflows recursion."""
    if tolerance <= 0 or len(points) < 3:
        return list(points)
    tol2 = tolerance * tolerance
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi - lo < 2:
            continue
        worst, worst_i = -1.0, -1
        a, b = points[lo], points[hi]
        for i in range(lo + 1, hi):
            d = _perp_dist2(points[i], a, b)
            if d > worst:
                worst, worst_i = d, i
        if worst > tol2:
            keep[worst_i] = True
            stack.append((lo, worst_i))
            stack.append((worst_i, hi))
    return [p for p, k in zip(points, keep) if k]


def simplify_ring(ring, tolerance):
    """Simplify a closed ring, backing the tolerance off rather than collapsing it.

    A ring cut to three points is not a small island, it is a triangle drawn
    where an island was — visibly wrong in a way that a dropped island is not.
    So halve the tolerance until the ring survives, then give up and keep it raw.
    """
    closed = ring[0] == ring[-1]
    body = ring[:-1] if closed else list(ring)
    if len(body) < 4:
        return _close(body)
    tol = tolerance
    for _ in range(8):
        out = simplify(body + [body[0]], tol)
        if len(out) >= 5:          # 4 distinct points + the repeated first
            return out
        tol /= 2.0
    return _close(body)


def _close(body):
    if not body:
        return []
    return body + [body[0]] if body[0] != body[-1] else list(body)


def round_ring(ring, precision):
    """Round, then drop points the rounding made identical to their neighbour."""
    out = []
    for lon, lat in ring:
        p = (round(lon, precision), round(lat, precision))
        if not out or p != out[-1]:
            out.append(p)
    return _close(out)


# ── Building the feature collection ──────────────────────────────────────────

def slugify(text):
    """Lower, non-alphanumerics to underscore, squeezed and trimmed.

    Matches the catchment ids already in stations.json ("balonne_condamine",
    "hinchinbrook_island"), which is the whole point — a new basin has to slug
    to the id the app already holds or it is a new basin to the app.
    """
    s = re.sub(r"[^a-z0-9]+", "_", (text or "").lower())
    return s.strip("_")


def build(path, opts):
    doc = read_kml(path)
    features = []
    stats = {"placemarks": 0, "rings_in": 0, "rings_kept": 0,
             "pts_in": 0, "pts_out": 0, "dropped_km2": 0.0}

    for name, attrs, polys in placemarks(doc):
        stats["placemarks"] += 1

        label = attrs.get(opts.name_from) if opts.name_from else None
        label = label or name
        raw_id = attrs.get(opts.id_from) if opts.id_from else None

        kept = []
        for outer, inners in polys:
            stats["rings_in"] += 1
            stats["pts_in"] += len(outer) + sum(len(r) for r in inners)
            area = ring_area_km2(outer)
            if opts.min_area_km2 and area < opts.min_area_km2:
                stats["dropped_km2"] += area
                continue
            o = round_ring(simplify_ring(outer, opts.tolerance), opts.precision)
            if len(o) < 4:
                stats["dropped_km2"] += area
                continue
            rings = [o]
            for inner in inners:
                # A hole is dropped on the same rule as an island: below the
                # threshold it is not a lake, it is a rounding artefact.
                if opts.min_area_km2 and ring_area_km2(inner) < opts.min_area_km2:
                    continue
                h = round_ring(simplify_ring(inner, opts.tolerance), opts.precision)
                if len(h) >= 4:
                    rings.append(h)
            kept.append(rings)
            stats["rings_kept"] += 1
            stats["pts_out"] += sum(len(r) for r in rings)

        if not kept:
            print(f"  ! {label}: every ring dropped", file=sys.stderr)
            continue

        props = {}
        if opts.keep:
            for k in opts.keep:
                if k in attrs:
                    props[k] = attrs[k]
        else:
            props.update(attrs)
        props["name"] = label
        props["id"] = slugify(raw_id if raw_id else label)

        # Largest ring first: the map draws in order and labels the first, and
        # "Fitzroy" belongs on the Fitzroy, not on an island in its mouth.
        kept.sort(key=lambda rings: -ring_area_km2(rings[0]))

        geom = ({"type": "Polygon", "coordinates": [[list(p) for p in r] for r in kept[0]]}
                if len(kept) == 1 else
                {"type": "MultiPolygon",
                 "coordinates": [[[list(p) for p in r] for r in rings] for rings in kept]})

        features.append({"type": "Feature", "properties": props, "geometry": geom})

    # By name, so a re-export that reordered its placemarks is still diff-clean.
    features.sort(key=lambda f: (f["properties"]["name"] or "").lower())
    fc = {
        "type": "FeatureCollection",
        "meta": {
            "source": os.path.basename(path),
            "generator": "tools/kml_to_geojson.py",
            "tolerance_deg": opts.tolerance,
            "min_area_km2": opts.min_area_km2,
            "precision": opts.precision,
        },
        "features": features,
    }
    return fc, stats


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("source")
    ap.add_argument("out")
    ap.add_argument("--tolerance", type=float, default=0.002)
    ap.add_argument("--min-area-km2", type=float, default=0.0)
    ap.add_argument("--precision", type=int, default=5)
    ap.add_argument("--id-from")
    ap.add_argument("--name-from")
    ap.add_argument("--keep")
    ap.add_argument("--check", action="store_true")
    opts = ap.parse_args(argv)
    opts.keep = [k.strip() for k in opts.keep.split(",")] if opts.keep else None

    fc, st = build(opts.source, opts)
    # Compact but not unreadable: one feature per line is what makes a boundary
    # change a one-line diff instead of a whole-file one.
    body = ("{\n"
            '"type": "FeatureCollection",\n'
            '"meta": ' + json.dumps(fc["meta"], sort_keys=True) + ",\n"
            '"features": [\n'
            + ",\n".join(json.dumps(f, separators=(",", ":"), sort_keys=True)
                         for f in fc["features"])
            + "\n]\n}\n")

    if opts.check:
        have = open(opts.out, encoding="utf-8").read() if os.path.exists(opts.out) else None
        if have != body:
            print(f"{opts.out}: would change — rerun without --check", file=sys.stderr)
            return 1
        print(f"{opts.out}: up to date")
        return 0

    with open(opts.out, "w", encoding="utf-8") as fh:
        fh.write(body)

    pct = 100.0 * st["pts_out"] / st["pts_in"] if st["pts_in"] else 0.0
    print(f"{opts.out}: {len(fc['features'])} features from {st['placemarks']} placemarks")
    print(f"  rings   {st['rings_kept']} kept of {st['rings_in']}"
          + (f"  ({st['rings_in'] - st['rings_kept']} below "
             f"{opts.min_area_km2} km2, {st['dropped_km2']:.1f} km2 total)"
             if st["rings_in"] != st["rings_kept"] else ""))
    print(f"  points  {st['pts_out']:,} of {st['pts_in']:,} ({pct:.1f}%)")
    print(f"  bytes   {len(body):,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
