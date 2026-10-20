#!/usr/bin/env python3
"""
coverage_tiles.py — the carriers' own 4G coverage maps, as the ACCC publishes
them, turned into the small tile set the Stations map's Mobile coverage layer
draws (map-mobile-coverage.js) and the station and What is here cards read a
point off (site-mobile.js).

PIPELINE POSITION
    ACCC Mobile Infrastructure Report data release (data.gov.au, CC BY 2.5 AU)
        Coverage map - <carrier> - 4G - Outdoor - <year>     (KML, or KML in a zip)
        Coverage map - <carrier> - 4G - Ext Ant - <year>
            └─ tools/coverage_tiles.py → data/coverage/index.json
                                          data/coverage/<z>/<x>/<y>.png

    Yearly: the ACCC publishes each carrier's maps as at 31 January. Run by
    hand or by .github/workflows/coverage-tiles.yml with --fetch <year>.
    Needs Pillow and numpy; ~3 GB of downloads, ~10 minutes.

WHAT THE MAPS ARE
    Each carrier's predicted coverage, at two levels the ACCC names in the
    file: "Outdoor" — a handheld outdoors at head height — and "Ext Ant" —
    with an external antenna. Polygons on a ~100 m grid; covered or not,
    nothing about strength. TPG's are its own network's; since 2025 its
    regional customers also ride Optus's masts (the MOCN), which the ACCC maps
    separately as "Optus-TPG MOCN", so TPG here is the union of the two.

WHAT THE TILES HOLD
    One 8-bit greyscale PNG per 256-px Web Mercator tile, every pixel 9·v,

        v = telstra + 3·optus + 9·tpg        each 0 none, 1 external antenna
                                             only, 2 outdoor (handheld)

    so 0–234 in steps of 9 — spaced so a decoder that rounds a grey a step
    either way still reads the right v — and one tile set answers for all
    three carriers: the layer reads
    the value back through a canvas and paints the carrier asked for, and a
    point lookup reads one pixel. Native at zoom 9 (~270 m a pixel at 27° S,
    near enough the maps' own 100 m grid for a map layer; the point lookup on
    the cards is no finer than that and says so). Zooms 3–8 are overviews,
    each carrier's best level over the 2 × 2 pixels below it, so a town too
    small to fill a pixel is still drawn. A tile with nothing on it is not
    written, and index.json lists every tile that is, so the map never asks
    for one that is not there.

USAGE
    # download the year's eight maps from data.gov.au and build — and the
    # year's list of Optus sites shared with TPG, for mobile_sectors.py
    python3 tools/coverage_tiles.py --fetch 2026 --out data/coverage \
        --mocn-sites data/mobile/accc-mocn-sites.csv

    # or from files already on disk (.kml, or the ACCC's .zip of one)
    python3 tools/coverage_tiles.py --year 2026 \\
        --telstra OUT.kml EXT.kml --optus OUT.zip EXT.zip \\
        --tpg OUT.kml EXT.kml --mocn OUT.zip EXT.zip --out data/coverage
"""

import argparse
import io
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.request
import zipfile
from datetime import datetime, timezone

try:
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("coverage_tiles: needs numpy and Pillow (pip install numpy pillow)")

CKAN = "https://data.gov.au/data/api/3/action/package_show?id=accc-mobile-infrastructure-report-data-release"
DATASET_PAGE = "https://data.gov.au/data/dataset/accc-mobile-infrastructure-report-data-release"

# The ACCC's resource names, per carrier, by level. "{year}" filled in.
NAMES = {
    "telstra": "Coverage map - Telstra - 4G - {level} - {year}",
    "optus": "Coverage map - Optus - 4G - {level} - {year}",
    "tpg": "Coverage map - TPG - 4G - {level} - {year}",
    "mocn": "Coverage map - Optus-TPG MOCN - 4G - {level} - {year}",
}
LEVELS = (("outdoor", "Outdoor"), ("extant", "Ext Ant"))

# Australia, the mainland, Tasmania and the Torres Strait — the box the
# raster is cut over. Norfolk and Christmas Islands are outside it.
BOX = {"w": 112.0, "e": 154.5, "n": -9.0, "s": -44.5}
Z_NATIVE = 9
Z_MIN = 3
TILE = 256
STEP = 9          # grey per value step: v 0–26 is written 0–234


def pixel(lon, lat, z):
    w = TILE * 2 ** z
    s = math.sin(math.radians(max(-85.0, min(85.0, lat))))
    return (lon + 180) / 360 * w, (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * w


class Grid:
    """The raster: whole tiles at Z_NATIVE covering BOX."""

    def __init__(self, z):
        self.z = z
        x0, y0 = pixel(BOX["w"], BOX["n"], z)
        x1, y1 = pixel(BOX["e"], BOX["s"], z)
        self.tx0, self.ty0 = int(x0 // TILE), int(y0 // TILE)
        self.X0, self.Y0 = self.tx0 * TILE, self.ty0 * TILE
        self.w = int(math.ceil(x1 / TILE)) * TILE - self.X0
        self.h = int(math.ceil(y1 / TILE)) * TILE - self.Y0
        self.W = TILE * 2 ** z

    def ring(self, text):
        """A KML coordinates string → the ring's pixels, repeats dropped."""
        first = text.split(None, 1)[0]
        a = np.array(text.replace(",", " ").split(), dtype=np.float64).reshape(-1, first.count(",") + 1)
        lat = np.clip(a[:, 1], -85.0, 85.0)
        x = (a[:, 0] + 180) / 360 * self.W - self.X0
        s = np.sin(np.radians(lat))
        y = (0.5 - np.log((1 + s) / (1 - s)) / (4 * np.pi)) * self.W - self.Y0
        xy = np.round(np.stack([x, y], 1)).astype(np.int32)
        keep = np.ones(len(xy), bool)
        keep[1:] = np.any(xy[1:] != xy[:-1], 1)
        return xy[keep]


def kml_streams(path):
    """Text streams over a .kml, or over every .kml inside a .zip."""
    if path.lower().endswith(".zip"):
        z = zipfile.ZipFile(path)
        names = [n for n in z.namelist() if n.lower().endswith(".kml")]
        if not names:
            raise SystemExit(f"coverage_tiles: no .kml inside {path}")
        for n in names:
            yield io.TextIOWrapper(z.open(n), encoding="utf-8", errors="replace")
    else:
        yield open(path, encoding="utf-8", errors="replace")


OUTER = re.compile(r"<outerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", re.S)
INNER = re.compile(r"<innerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", re.S)


def rasterise(path, grid):
    """Every polygon in a coverage KML, filled, holes and all → a 0/1 array.

    The maps are a union with no overlaps, so a hole only ever has smaller
    polygons inside it (an island in a lake). Drawing the polygons largest
    first, each one's outer ring and then its holes, puts every island back
    after the hole it sits in was cut — the even-odd answer without XOR.
    """
    polys = []
    for fh in kml_streams(path):
        with fh:
            buf = ""
            while True:
                chunk = fh.read(1 << 24)
                buf += chunk
                parts = re.split(r"(?=<Polygon>)", buf)
                buf = parts.pop() if chunk else ""
                for p in parts:
                    m = OUTER.search(p)
                    if not m:
                        continue
                    outer = grid.ring(m.group(1))
                    if not len(outer):
                        continue
                    lo, hi = outer.min(0), outer.max(0)
                    if hi[0] < 0 or hi[1] < 0 or lo[0] >= grid.w or lo[1] >= grid.h:
                        continue
                    polys.append((int(hi[0] - lo[0] + 1) * int(hi[1] - lo[1] + 1), outer,
                                  [grid.ring(h) for h in INNER.findall(p)]))
                if not chunk:
                    break
    polys.sort(key=lambda p: -p[0])
    img = Image.new("L", (grid.w, grid.h), 0)
    draw = ImageDraw.Draw(img)
    for _, outer, holes in polys:
        pts = [tuple(v) for v in outer.tolist()]
        if len(pts) >= 3:
            draw.polygon(pts, fill=1)
        else:
            draw.point(pts, fill=1)
        for h in holes:
            if len(h) >= 3:
                draw.polygon([tuple(v) for v in h.tolist()], fill=0)
    return np.asarray(img, dtype=np.uint8), len(polys)


def resources():
    """The ACCC release's resources on data.gov.au, by name (dashes evened out —
    the ACCC writes some with an en dash)."""
    req = urllib.request.Request(CKAN, headers={"User-Agent": "Flood-Net coverage tiles"})
    with urllib.request.urlopen(req, timeout=120) as r:
        found = json.load(r)["result"]["resources"]
    return {norm(r["name"]): r["url"] for r in found}


def norm(s):
    return re.sub(r"\s*[–—-]\s*", " - ", s.strip())


def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "Flood-Net coverage tiles"})
    with urllib.request.urlopen(req, timeout=1800) as r, open(dest, "wb") as out:
        shutil.copyfileobj(r, out, 1 << 20)


def fetch(year, into):
    """Download the year's eight maps from data.gov.au into a folder."""
    by_name = resources()
    got = {}
    for carrier, pattern in NAMES.items():
        for key, level in LEVELS:
            name = norm(pattern.format(level=level, year=year))
            url = by_name.get(name)
            if not url:
                raise SystemExit(f"coverage_tiles: data.gov.au has no '{name}' — not published yet?")
            dest = os.path.join(into, f"{carrier}-{key}{os.path.splitext(url)[1] or '.kml'}")
            print(f"  fetching {name}", flush=True)
            download(url, dest)
            got[(carrier, key)] = dest
    return got


def downsample(a):
    """Each carrier's best level over every 2 × 2 block (a is v = t + 3o + 9p)."""
    h, w = a.shape
    out = np.zeros((h // 2, w // 2), np.uint8)
    for unit in (1, 3, 9):
        c = (a // unit) % 3
        c = np.maximum(np.maximum(c[0::2, 0::2], c[1::2, 0::2]), np.maximum(c[0::2, 1::2], c[1::2, 1::2]))
        out += (c * unit).astype(np.uint8)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fetch", type=int, metavar="YEAR", help="download the year's maps from data.gov.au")
    ap.add_argument("--year", type=int, help="the year of the maps given as files")
    for c in NAMES:
        ap.add_argument(f"--{c}", nargs=2, metavar=("OUTDOOR", "EXT_ANT"))
    ap.add_argument("--out", default="data/coverage")
    ap.add_argument("--mocn-sites", metavar="CSV",
                    help="with --fetch: also save the year's list of Optus sites shared with TPG here "
                         "(tools/mobile_sectors.py --mocn reads it)")
    a = ap.parse_args()

    tmp = None
    if a.fetch:
        year = a.fetch
        tmp = tempfile.mkdtemp(prefix="coverage-")
        files = fetch(year, tmp)
        if a.mocn_sites:
            name = norm(f"Mobile sites - Optus-TPG MOCN - {year}")
            url = resources().get(name)
            if not url:
                raise SystemExit(f"coverage_tiles: data.gov.au has no '{name}'")
            print(f"  fetching {name}", flush=True)
            download(url, a.mocn_sites)
    else:
        if not a.year or not all(getattr(a, c) for c in NAMES):
            ap.error("give --fetch YEAR, or --year and all four of --telstra --optus --tpg --mocn")
        year = a.year
        files = {(c, k): getattr(a, c)[i] for c in NAMES for i, (k, _) in enumerate(LEVELS)}

    t0 = time.time()
    grid = Grid(Z_NATIVE)
    classes = {}
    counts = {}
    for carrier in NAMES:
        cls = np.zeros((grid.h, grid.w), np.uint8)
        for key, level in reversed(LEVELS):          # external antenna first, outdoor over it
            mask, n = rasterise(files[(carrier, key)], grid)
            counts[f"{carrier}_{key}"] = n
            cls = np.maximum(cls, mask * (2 if key == "outdoor" else 1))
            print(f"  {carrier} {level}: {n} polygons, {mask.mean() * 100:.1f}% of the box "
                  f"({time.time() - t0:.0f} s)", flush=True)
        classes[carrier] = cls
    # TPG's customers are on its own network and, in the regions, on Optus's
    # shared masts: the better of the two at every pixel.
    tpg = np.maximum(classes.pop("tpg"), classes.pop("mocn"))
    v = classes["telstra"] + 3 * classes["optus"] + 9 * tpg

    if os.path.isdir(a.out):
        for z in os.listdir(a.out):
            if z.isdigit():
                shutil.rmtree(os.path.join(a.out, z))
    os.makedirs(a.out, exist_ok=True)
    tiles = {}
    total = 0
    level = v
    for z in range(Z_NATIVE, Z_MIN - 1, -1):
        shift = Z_NATIVE - z
        tx0, ty0 = grid.tx0 >> shift, grid.ty0 >> shift
        # A zoom's raster starts on its own tile boundary: pad the finer one
        # so the halving lines up with tiles at every level.
        names = []
        for ty in range(level.shape[0] // TILE):
            for tx in range(level.shape[1] // TILE):
                t = level[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE]
                if not t.any():
                    continue
                d = os.path.join(a.out, str(z), str(tx0 + tx))
                os.makedirs(d, exist_ok=True)
                p = os.path.join(d, f"{ty0 + ty}.png")
                Image.fromarray(t * STEP, "L").save(p, optimize=True)
                total += os.path.getsize(p)
                names.append(f"{tx0 + tx}_{ty0 + ty}")
        tiles[str(z)] = sorted(names)
        if z > Z_MIN:
            nxt_x0, nxt_y0 = grid.tx0 >> (shift + 1), grid.ty0 >> (shift + 1)
            pad_l = (tx0 - (nxt_x0 << 1)) * TILE
            pad_t = (ty0 - (nxt_y0 << 1)) * TILE
            w = level.shape[1] + pad_l
            h = level.shape[0] + pad_t
            w += (-w) % (2 * TILE)
            h += (-h) % (2 * TILE)
            padded = np.zeros((h, w), np.uint8)
            padded[pad_t:pad_t + level.shape[0], pad_l:pad_l + level.shape[1]] = level
            level = downsample(padded)

    index = {
        "meta": {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "as_at": f"{year}-01-31",
            "year": year,
            "technology": "4G",
            "source": "ACCC Mobile Infrastructure Report data release — coverage maps supplied by Telstra, "
                      "Optus and TPG under the ACCC's Infrastructure Record Keeping Rules",
            "page": DATASET_PAGE,
            "attribution": "Mobile coverage: © Australian Competition and Consumer Commission (CC BY 2.5 AU), "
                           "from maps supplied by Telstra, Optus and TPG",
            "encoding": "grey = 9*v; v = telstra + 3*optus + 9*tpg; each 0 none, 1 external antenna only, 2 outdoor",
            "step": STEP,
            "box": BOX,
            "tpg": "TPG's own 4G map and the Optus-TPG MOCN 4G map, the better of the two",
            "z_native": Z_NATIVE, "z_min": Z_MIN,
            "polygons": counts,
            "tiles": sum(len(t) for t in tiles.values()), "bytes": total,
        },
        "tiles": tiles,
    }
    with open(os.path.join(a.out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, separators=(",", ":"))
        fh.write("\n")
    if tmp:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"coverage_tiles: {index['meta']['tiles']} tiles, {total / 1e6:.1f} MB, zooms {Z_MIN}–{Z_NATIVE}, "
          f"as at {year}-01-31 ({time.time() - t0:.0f} s)")


if __name__ == "__main__":
    main()
