#!/usr/bin/env node
// build_lga_layer.mjs — rebuild data/lga-boundaries.geojson, the council areas
// (local government areas) the Stations and Repeaters maps draw (map-councils.js).
//
// WHY THIS EXISTS
//   The council areas come from the Australian Bureau of Statistics: ASGS
//   Edition 4 (2026), the LGA layer's own generalised copy (LGA_GEN), from the
//   ABS's public ArcGIS service. That copy is 66 MB and 1.6 million vertices,
//   which is not a file a map opens, so this cuts it to about a megabyte and
//   writes down every choice it made in doing so, so that the next edition is
//   a rerun rather than an archaeology exercise.
//
//   The choices:
//
//   * Simplified with mapshaper, which keeps the topology: a border two
//     councils share is one line, simplified once, so the two never open a
//     gap or overlap along it. Simplifying each council on its own would.
//   * More detail where the network is: Queensland and New South Wales keep
//     3.5% of their vertices, everywhere else 1%. Weighted Visvalingam, so the
//     coastline's thousand wiggles go first and an inland boundary keeps its
//     shape.
//   * Islands under 2 km² dropped — 6,000-odd rocks and cays, none visible at
//     the zooms this is read at. Cocos (Keeling) is all such islands, so it
//     has no shape left and is left out; so are the ABS's placeholder areas
//     with no shape at all ("No usual address", "Migratory - Offshore -
//     Shipping", "Outside Australia").
//   * Each council gets a colour index `c` (0–5) that none of its neighbours
//     has — councils sharing a vertex are neighbours — so the shaded layer
//     never paints two adjoining councils the same.
//   * Each gets a label point `lp` ([lat, lon]) inside its shape, mapshaper's
//     inner point, so a crescent-shaped council's name is not written in the
//     next one.
//   * Coordinates to 4 decimal places, about 11 m.
//
//   The ABS's own caveat goes with the data and is quoted on the map: these
//   are an ABS Mesh Block approximation of the gazetted boundaries, close to
//   but not the legal line.
//
// USAGE
//   node tools/build_lga_layer.mjs                  fetch from the ABS and build
//   node tools/build_lga_layer.mjs --in lga.geojson build from a saved download
//   node tools/build_lga_layer.mjs --keep raw.geojson   also save the download
//
//   Needs Node 18+ and network access to geo.abs.gov.au and the npm registry
//   (mapshaper is run with npx, pinned).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'data', 'lga-boundaries.geojson');
const EDITION = 'ASGS2026';
const SRC = `https://geo.abs.gov.au/arcgis/rest/services/${EDITION}/LGA/MapServer/1/query`
  + '?where=1%3D1&outFields=LGA_CODE_2026,LGA_NAME_2026,STATE_CODE_2026,STATE_NAME_2026,AREA_ALBERS_SQKM'
  + '&outSR=4326&f=geojson';
const MAPSHAPER = 'mapshaper@0.6.102';
const COLOURS = 6;

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

const work = mkdtempSync(join(tmpdir(), 'lga-'));
try {
  const raw = join(work, 'raw.geojson');
  if (arg('--in')) {
    copyFileSync(arg('--in'), raw);
  } else {
    console.log(`Fetching ${EDITION} LGA_GEN from the ABS…`);
    const res = await fetch(SRC);
    if (!res.ok) throw new Error(`ABS answered ${res.status}`);
    writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
  }
  if (arg('--keep')) copyFileSync(raw, arg('--keep'));

  const simplified = join(work, 'simplified.geojson');
  execFileSync('npx', ['-y', MAPSHAPER, raw,
    '-filter', 'this.isNull == false',
    '-simplify', 'variable', 'weighted', 'keep-shapes',
    'percentage=STATE_CODE_2026 == "3" || STATE_CODE_2026 == "1" ? "3.5%" : "1%"',
    '-filter-islands', 'min-area=2km2',
    '-filter', 'this.isNull == false',
    '-each', 'code=LGA_CODE_2026, name=LGA_NAME_2026, state=STATE_NAME_2026, '
           + 'area_sqkm=Math.round(AREA_ALBERS_SQKM), lx=this.innerX, ly=this.innerY',
    '-filter-fields', 'code,name,state,area_sqkm,lx,ly',
    '-o', 'format=geojson', 'precision=0.0001', simplified,
  ], { stdio: 'inherit' });

  const fc = JSON.parse(readFileSync(simplified, 'utf8'));
  const feats = fc.features;

  // Neighbours: councils sharing a vertex. mapshaper writes a shared border
  // once and both councils carry the same coordinates for it, so an exact
  // match on the rounded pair is the adjacency.
  const owners = new Map();
  feats.forEach((f, i) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) for (const r of p) for (const [x, y] of r) {
      const k = `${x},${y}`;
      let s = owners.get(k);
      if (!s) owners.set(k, s = new Set());
      s.add(i);
    }
  });
  const nb = feats.map(() => new Set());
  for (const s of owners.values()) {
    if (s.size < 2) continue;
    for (const a of s) for (const b of s) if (a !== b) nb[a].add(b);
  }
  // Greedy colouring, most-connected first (Welsh–Powell).
  const order = feats.map((_, i) => i).sort((a, b) => nb[b].size - nb[a].size);
  const colour = new Array(feats.length).fill(-1);
  for (const i of order) {
    const used = new Set([...nb[i]].map(j => colour[j]));
    let c = 0;
    while (used.has(c)) c++;
    if (c >= COLOURS) throw new Error(`${feats[i].properties.name} needs a colour past ${COLOURS}`);
    colour[i] = c;
  }

  const r4 = v => Math.round(v * 1e4) / 1e4;
  fc.features = feats.map((f, i) => {
    const p = f.properties;
    return {
      type: 'Feature',
      properties: {
        code: String(p.code), name: p.name, state: p.state, area_sqkm: p.area_sqkm,
        c: colour[i], lp: p.ly != null && p.lx != null ? [r4(p.ly), r4(p.lx)] : null,
      },
      geometry: f.geometry,
    };
  }).sort((a, b) => a.properties.code.localeCompare(b.properties.code));
  fc.meta = {
    source: `Australian Bureau of Statistics, Australian Statistical Geography Standard (ASGS) Edition 4, `
          + `Local Government Areas 2026 (generalised), CC BY 4.0`,
    url: `https://geo.abs.gov.au/arcgis/rest/services/${EDITION}/LGA/MapServer`,
    caveat: 'An ABS Mesh Block approximation of the gazetted local government boundaries, '
          + 'not the legal boundary.',
    built: new Date().toISOString().slice(0, 10),
    tool: 'tools/build_lga_layer.mjs',
  };
  delete fc.bbox;
  writeFileSync(OUT, JSON.stringify(fc));
  const byState = {};
  for (const f of fc.features) byState[f.properties.state] = (byState[f.properties.state] || 0) + 1;
  console.log(`Wrote ${fc.features.length} council areas to data/lga-boundaries.geojson`, byState);
} finally {
  rmSync(work, { recursive: true, force: true });
}
