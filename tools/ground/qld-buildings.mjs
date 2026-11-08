#!/usr/bin/env node
// The State of Queensland's generated building outlines as vector tiles for
// Flood-Net's 3-D view (#278). docs/ground-cover-sources.md ("Buildings",
// "Recommendation" and "Building the Queensland buildings tiles") says why
// this source and how a run goes.
//
//   node qld-buildings.mjs --out ./tiles                       all of Queensland, to disk
//   node qld-buildings.mjs --bbox 151.93,-27.58,151.98,-27.53 --out ./tiles
//   SUPABASE_SECRET_KEY=… node qld-buildings.mjs --upload     PUT to https://floodwarning.net
//   SUPABASE_SECRET_KEY=… node qld-buildings.mjs --upload https://other.example --bbox …
//   node qld-buildings.mjs --dry-run                          build every tile, keep none
//
// What it does:
//
//   1. Plans the area in squares of the web-map tile grid: starts with zoom-6
//      squares (about 5.6° across) over Queensland, asks the State's service
//      how many current outlines touch each, drops the empty ones and splits
//      any holding more than MAX_CHUNK into four, until every square is small
//      enough to hold in memory.
//   2. For each square, a few at a time: pages through the outlines touching
//      it (status = 'Current', in OBJECTID order, 4,000 a request), keeps each
//      as a polygon with h (height above ground), e (eave height above ground)
//      and y (survey year), cuts them into zoom-14 tiles with geojson-vt,
//      encodes each with vt-pbf, writes it to disk and/or PUTs it gzipped
//      (the Worker keeps and serves it as gzip, 40% smaller), then lets the
//      square go.
//      Every zoom-14 tile lies in exactly one square, so no tile is written
//      twice; an outline across a square's edge is fetched by both squares and
//      each draws its own part.
//   3. Writes meta.json last, so a build that stopped part-way never looks
//      finished. A --bbox run (a test, or one area again) does not PUT
//      meta.json, because its count and bounds are only that area's.
//
// The tiles are zoom 14 only; MapLibre over-zooms them, and the 3-D view
// draws them from its zoom 15 up. A tile with no building in it is not made —
// the Worker answers 204 for a tile it does not have.
//
// Uploads use the project's secret key (SUPABASE_SECRET_KEY) as a Bearer
// token, the same as tools/archive/archive-to-r2.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';

export const SERVICE = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Structure/BuildingsAndSettlements/MapServer/11';
const DEFAULT_BASE = 'https://floodwarning.net';
const ROUTE = '/api/ground/qld-buildings';
const USER_AGENT = 'Flood-Net ground tiles (+https://floodwarning.net/docs/ground-cover-sources.md)';

export const LAYER = 'buildings';
export const Z = 14;
const EXTENT = 4096;
const BUFFER = 64;
// In tile units (1/4096 of a tile, about half a metre at zoom 14): only points
// that are all but in line with their neighbours go. Corners stay.
const TOLERANCE = 0.25;

const PAGE = 4000;            // the service's maxRecordCount
const MAX_CHUNK = 100000;     // outlines a square may hold before it is split in four
const START_Z = 6;
const MAX_SPLIT_Z = 12;
const FETCH_AT_ONCE = 3;      // requests to the State's server at a time
const PUT_AT_ONCE = 8;
const TRIES = 7;              // waits of 2, 4, 8, 16, 32, 64 s between them
const TIMEOUT_MS = 180000;

// Height above ground in metres. Under 2 m is a shed roof the laser barely
// lifted off the ground, drawn at 2 m. The top is above Q1 on the Gold Coast
// (317 m to the spire in the State's data) and Brisbane Skytower (274 m): the
// State's 35 outlines over 150 m are all real towers, so they keep their height.
export const MIN_H = 2;
export const MAX_H = 350;

// All of Queensland, Torres Strait to the border. The service's own extent
// would do, but it is set when the service is published and need not grow when
// the State adds a survey; empty squares cost one count each.
export const QLD = Object.freeze({ west: 137.9, south: -29.2, east: 153.6, north: -9.0 });

export const ATTRIBUTION = '© The State of Queensland 2025 — generated building outlines (CC BY 4.0)';
export const FIELDS = Object.freeze({
  h: 'Height of the roof\'s highest point above the ground at the building\'s centre, in metres (bsm_max − dtm_centre), to 0.1 m. Under 2 m is drawn as 2 m; outlines whose roof came out below the ground are left out.',
  e: 'Eave height: the average height along the outline above the same ground, in metres (bsm_edge − dtm_centre), to 0.1 m, never above h.',
  y: 'Year the LiDAR survey that drew the outline was flown.',
});

// ── Tile arithmetic ──────────────────────────────────────────────────────────

const lon2x = (lon, z) => Math.min((1 << z) - 1, Math.max(0, Math.floor((lon + 180) / 360 * (1 << z))));
const lat2y = (lat, z) => {
  const r = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z);
  return Math.min((1 << z) - 1, Math.max(0, Math.floor(y)));
};
const x2lon = (x, z) => x / (1 << z) * 360 - 180;
const y2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (1 << z)))) * 180 / Math.PI;
// A tile's buffer, in degrees of longitude; in latitude it is less, so this covers both.
const BUF_DEG = 360 / (1 << Z) * BUFFER / EXTENT;

// An area as a range of zoom-14 tiles (inclusive), so every tile is whole.
export function tileRange({ west, south, east, north }) {
  return { x0: lon2x(west, Z), x1: lon2x(east, Z), y0: lat2y(north, Z), y1: lat2y(south, Z) };
}
const rangeBox = r => ({ west: x2lon(r.x0, Z), east: x2lon(r.x1 + 1, Z), north: y2lat(r.y0, Z), south: y2lat(r.y1 + 1, Z) });

// The zoom-14 tiles of square (z, x, y) that are also in the area, or null.
function chunkRange(c, area) {
  const d = Z - c.z;
  const r = {
    x0: Math.max(c.x << d, area.x0), x1: Math.min(((c.x + 1) << d) - 1, area.x1),
    y0: Math.max(c.y << d, area.y0), y1: Math.min(((c.y + 1) << d) - 1, area.y1),
  };
  return r.x0 <= r.x1 && r.y0 <= r.y1 ? r : null;
}

function envelope(r) {
  const b = rangeBox(r);
  const f = v => v.toFixed(7);
  return `${f(b.west - BUF_DEG)},${f(b.south - BUF_DEG)},${f(b.east + BUF_DEG)},${f(b.north + BUF_DEG)}`;
}

// ── Polite requests ──────────────────────────────────────────────────────────

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, res, rej } = queue.shift();
    Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); });
  };
  return fn => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = attempt => Math.min(64000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 1000);

const stateLimit = limiter(FETCH_AT_ONCE);

async function query(params, { fetch = globalThis.fetch, log = console.log } = {}) {
  const url = `${SERVICE}/query?${new URLSearchParams(params)}`;
  let last;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    if (attempt) {
      const wait = backoff(attempt - 1);
      log(`    the State's server: ${last.message} — trying again in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
    try {
      const body = await stateLimit(async () => {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const text = await res.text();
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: res.status === 429 || res.status >= 500 });
        let json;
        try { json = JSON.parse(text); } catch (_) { throw Object.assign(new Error('an answer that is not JSON'), { retry: true }); }
        // ArcGIS answers 200 with an error object when a query fails on its side.
        if (json.error) throw Object.assign(new Error(`error ${json.error.code}: ${json.error.message}`), { retry: true });
        return json;
      });
      return body;
    } catch (err) {
      last = err;
      if (err.retry === false) throw err;
    }
  }
  throw new Error(`the State's server failed ${TRIES} times: ${last.message}`);
}

const WHERE = "status='Current'";
const spatial = env => ({ geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' });

async function countIn(env, opts) {
  const j = await query({ where: WHERE, ...spatial(env), returnCountOnly: 'true', f: 'json' }, opts);
  return j.count;
}

// ── Outlines to features ─────────────────────────────────────────────────────

const round1 = v => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// { h, e } for an outline's properties, or null when it has no usable height.
export function heights(p, stats) {
  const top = p.bsm_max, eave = p.bsm_edge, ground = p.dtm_centre;
  if (!Number.isFinite(top) || !Number.isFinite(ground)) { if (stats) stats.noHeight++; return null; }
  const raw = top - ground;
  if (raw < 0) { if (stats) stats.below++; return null; }
  if (stats) { if (raw < MIN_H) stats.raised++; if (raw > MAX_H) stats.cut++; }
  const h = round1(clamp(raw, MIN_H, MAX_H));
  const out = { h };
  if (Number.isFinite(eave)) out.e = round1(clamp(eave - ground, 0, h));
  return out;
}

export function surveyYear(p) {
  if (Number.isFinite(p.captureenddate)) return new Date(p.captureenddate + 12 * 3600e3).getUTCFullYear();
  if (Number.isFinite(p.capturestartdate)) return new Date(p.capturestartdate + 12 * 3600e3).getUTCFullYear();
  const m = /(?:^|_)((?:19|20)\d\d)(?:_|$)/.exec(p.featuresourceproject || '');
  return m ? +m[1] : undefined;
}

function firstPoint(g) {
  if (g.type === 'Polygon') return g.coordinates[0]?.[0];
  if (g.type === 'MultiPolygon') return g.coordinates[0]?.[0]?.[0];
  return undefined;
}

function growBounds(b, g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys) for (const ring of poly) for (const [lon, lat] of ring) {
    if (lon < b[0]) b[0] = lon; if (lat < b[1]) b[1] = lat;
    if (lon > b[2]) b[2] = lon; if (lat > b[3]) b[3] = lat;
  }
}

// Every current outline touching the square's envelope, as GeoJSON features.
async function fetchChunk(r, run) {
  const env = envelope(r);
  const features = [];
  let after = 0, pages = 0;
  for (;;) {
    const page = await query({
      where: `${WHERE} AND objectid > ${after}`, ...spatial(env),
      outFields: 'objectid,bsm_max,bsm_edge,dtm_centre,captureenddate,featuresourceproject',
      returnGeometry: 'true', outSR: '4326', geometryPrecision: '7',
      orderByFields: 'objectid', resultRecordCount: String(PAGE), f: 'geojson',
    }, run.opts);
    pages++;
    const got = page.features || [];
    for (const f of got) {
      const p = f.properties || {};
      const id = Number.isFinite(f.id) ? f.id : p.objectid;
      if (Number.isFinite(id) && id > after) after = id;
      run.stats.fetched++;
      const g = f.geometry;
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) { run.stats.noShape++; continue; }
      const hv = heights(p, run.stats);
      if (!hv) continue;
      const props = hv;
      const y = surveyYear(p);
      if (y) props.y = y;
      if (p.featuresourceproject) run.surveys.add(p.featuresourceproject);
      features.push({ type: 'Feature', id, geometry: g, properties: props });
    }
    const more = page.exceededTransferLimit || page.properties?.exceededTransferLimit;
    if (!got.length || (!more && got.length < PAGE)) break;
  }
  return { features, pages };
}

// ── Tiles ────────────────────────────────────────────────────────────────────

// True when some part of the tile's features is inside the tile, not only in
// its buffer.
function hasInside(tile) {
  for (const f of tile.features) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of f.geometry) for (const [x, y] of ring) {
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    if (x1 > 0 && y1 > 0 && x0 < EXTENT && y0 < EXTENT) return true;
  }
  return false;
}

export function buildTiles(features, r) {
  const index = geojsonvt({ type: 'FeatureCollection', features }, {
    maxZoom: Z, indexMaxZoom: Z, indexMaxPoints: 0,
    tolerance: TOLERANCE, extent: EXTENT, buffer: BUFFER,
  });
  const tiles = [];
  for (const { z, x, y } of index.tileCoords) {
    if (z !== Z || x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
    const tile = index.getTile(z, x, y);
    if (!tile || !tile.features.length || !hasInside(tile)) continue;
    const bytes = Buffer.from(vtpbf.fromGeojsonVt({ [LAYER]: tile }, { version: 2, extent: EXTENT }));
    tiles.push({ x, y, bytes, n: tile.features.length });
  }
  return tiles;
}

// ── Writing and uploading ────────────────────────────────────────────────────

const putLimit = limiter(PUT_AT_ONCE);

async function put(run, rel, body, type) {
  const url = `${run.base}${ROUTE}/${rel}`;
  let last;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    if (attempt) await sleep(backoff(attempt - 1));
    try {
      return await putLimit(async () => {
        const res = await run.opts.fetch(url, {
          method: 'PUT', body,
          headers: { Authorization: `Bearer ${run.key}`, 'Content-Type': type, 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await res.text();
        if (res.ok) return;
        const err = new Error(`PUT ${rel}: HTTP ${res.status} ${text.slice(0, 200)}`);
        err.retry = res.status === 429 || res.status >= 500;
        if (res.status === 401 || res.status === 403) err.message += ' — the secret key was refused';
        if (res.status === 404) err.message += ' — is the Worker\'s /api/ground route deployed?';
        throw err;
      });
    } catch (err) {
      last = err;
      if (err.retry === false) throw err;
    }
  }
  throw last;
}

// On disk as it is, so it can be opened as it is; over the wire as sent.
async function keep(run, rel, bytes, type, sent = bytes) {
  if (run.out) {
    const file = path.join(run.out, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  if (run.base && !run.dryRun) await put(run, rel, sent, type);
}

// ── The run ──────────────────────────────────────────────────────────────────

function children(c) {
  const z = c.z + 1, x = c.x * 2, y = c.y * 2;
  return [{ z, x, y }, { z, x: x + 1, y }, { z, x, y: y + 1 }, { z, x: x + 1, y: y + 1 }];
}

export async function plan(area, run) {
  const d = Z - START_Z;
  let todo = [];
  for (let x = area.x0 >> d; x <= area.x1 >> d; x++) for (let y = area.y0 >> d; y <= area.y1 >> d; y++) todo.push({ z: START_Z, x, y });
  const chunks = [];
  while (todo.length) {
    const counted = await Promise.all(todo.map(async c => {
      const r = chunkRange(c, area);
      return r ? { ...c, r, expected: await countIn(envelope(r), run.opts) } : null;
    }));
    todo = [];
    for (const c of counted) {
      if (!c || !c.expected) continue;
      if (c.expected > MAX_CHUNK && c.z < MAX_SPLIT_Z) todo.push(...children(c));
      else chunks.push(c);
    }
  }
  // North to south, west to east: neighbouring squares one after the other.
  return chunks.sort((a, b) => a.r.y0 - b.r.y0 || a.r.x0 - b.r.x0);
}

const mb = n => `${(n / 1048576).toFixed(1)} MB`;
const took = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };

export async function build({ bbox, out, base, key, dryRun = false, fetch = globalThis.fetch, log = console.log, now = () => Date.now() } = {}) {
  const t0 = now();
  const area = tileRange(bbox || QLD);
  const run = {
    out, base, key, dryRun, opts: { fetch, log }, surveys: new Set(),
    stats: { fetched: 0, noShape: 0, noHeight: 0, below: 0, raised: 0, cut: 0 },
  };
  const box = rangeBox(area);
  log(`Queensland building outlines → zoom-${Z} tiles, layer "${LAYER}"`);
  log(`  area ${box.west.toFixed(4)},${box.south.toFixed(4)},${box.east.toFixed(4)},${box.north.toFixed(4)} (${area.x1 - area.x0 + 1} × ${area.y1 - area.y0 + 1} tiles)${bbox ? ', from --bbox' : ''}`);
  log(`  ${out ? `writing to ${out}` : 'not writing to disk'}; ${base ? (dryRun ? `dry run: nothing PUT to ${base}` : `PUT to ${base}${ROUTE}/`) : 'not uploading'}`);

  if (base && !dryRun) {
    // A cheap look before the long part: is the route there to take the tiles?
    // Tile 14/0/0 is open sea: the route answers 204 for it.
    const res = await fetch(`${base}${ROUTE}/${Z}/0/0.pbf`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) }).catch(e => ({ status: 0, error: e }));
    const type = res.headers?.get('content-type') || '';
    if (!(res.status === 204 || (res.status === 200 && type.startsWith('application/x-protobuf')))) {
      throw new Error(`${base}${ROUTE}/ does not answer like the tile route (${res.status || res.error?.message}${type ? `, ${type}` : ''}) — deploy the Worker's /api/ground route first`);
    }
  }

  const chunks = await plan(area, run);
  const expected = chunks.reduce((s, c) => s + c.expected, 0);
  log(`  ${chunks.length} square${chunks.length === 1 ? '' : 's'} to fetch, about ${expected.toLocaleString('en-AU')} outlines (an outline across a square's edge counts in both) — planned in ${took(now() - t0)}`);

  const total = { count: 0, tiles: 0, bytes: 0, gzipBytes: 0, maxTile: 0, bounds: [Infinity, Infinity, -Infinity, -Infinity], years: [Infinity, -Infinity] };
  let done = 0, doneExpected = 0, next = 0;

  async function one(c) {
    const t = now();
    const { features, pages } = await fetchChunk(c.r, run);
    const tFetch = now() - t;
    let counted = 0;
    for (const f of features) {
      const p0 = firstPoint(f.geometry);
      if (!p0) continue;
      const tx = lon2x(p0[0], Z), ty = lat2y(p0[1], Z);
      if (tx < c.r.x0 || tx > c.r.x1 || ty < c.r.y0 || ty > c.r.y1) continue;
      counted++;
      growBounds(total.bounds, f.geometry);
      const y = f.properties.y;
      if (y) { total.years[0] = Math.min(total.years[0], y); total.years[1] = Math.max(total.years[1], y); }
    }
    const tiles = buildTiles(features, c.r);
    features.length = 0;
    let bytes = 0;
    await Promise.all(tiles.map(tl => {
      const gz = zlib.gzipSync(tl.bytes, { level: 9 });
      bytes += tl.bytes.length;
      total.gzipBytes += gz.length;
      total.maxTile = Math.max(total.maxTile, tl.bytes.length);
      return keep(run, `${Z}/${tl.x}/${tl.y}.pbf`, tl.bytes, 'application/x-protobuf', gz);
    }));
    total.count += counted;
    total.tiles += tiles.length;
    total.bytes += bytes;
    done++;
    doneExpected += c.expected;
    const pct = expected ? Math.round(doneExpected / expected * 100) : 100;
    log(`  [${done}/${chunks.length}] square ${c.z}/${c.x}/${c.y}: ${counted.toLocaleString('en-AU')} outlines (${pages} page${pages === 1 ? '' : 's'}, ${took(tFetch)}), ${tiles.length} tiles, ${mb(bytes)} — ${pct}% after ${took(now() - t0)}`);
  }

  // A few squares at a time; the request limiter keeps the State's server to
  // FETCH_AT_ONCE requests whatever happens here.
  await Promise.all(Array.from({ length: Math.min(FETCH_AT_ONCE, chunks.length) }, async () => {
    while (next < chunks.length) await one(chunks[next++]);
  }));

  const r6 = v => Math.round(v * 1e6) / 1e6;
  const meta = {
    layer: LAYER,
    built: new Date(now()).toISOString(),
    count: total.count,
    tiles: total.tiles,
    bytes: total.bytes,
    gzipBytes: total.gzipBytes,
    bounds: total.count ? total.bounds.map(r6) : null,
    minzoom: Z,
    maxzoom: Z,
    fields: FIELDS,
    surveys: run.surveys.size,
    years: total.count && Number.isFinite(total.years[0]) ? total.years : null,
    source: SERVICE,
    attribution: ATTRIBUTION,
  };
  if (bbox) meta.bbox = [box.west, box.south, box.east, box.north].map(r6);
  const metaBytes = Buffer.from(JSON.stringify(meta, null, 2) + '\n');
  if (run.out) await fs.writeFile(path.join(run.out, 'meta.json'), metaBytes);
  if (base && !dryRun && !bbox) await put(run, 'meta.json', metaBytes, 'application/json');

  const s = run.stats;
  log(`Done in ${took(now() - t0)}: ${total.count.toLocaleString('en-AU')} outlines in ${total.tiles.toLocaleString('en-AU')} tiles, ${mb(total.bytes)}, ${mb(total.gzipBytes)} gzipped (largest tile ${(total.maxTile / 1024).toFixed(0)} KB).`);
  log(`  fetched ${s.fetched.toLocaleString('en-AU')} (edge outlines twice); left out ${s.below} with the roof below the ground, ${s.noHeight} with no height, ${s.noShape} with no outline; ${s.raised} raised to ${MIN_H} m, ${s.cut} cut to ${MAX_H} m.`);
  if (base && bbox && !dryRun) log('  meta.json not PUT: a --bbox run covers only part of Queensland.');
  return { meta, stats: s };
}

// ── Command line ─────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === '--bbox') {
      const v = String(value() ?? '').split(',').map(Number);
      const [west, south, east, north] = v;
      if (v.length !== 4 || !v.every(Number.isFinite) || west >= east || south >= north || west < -180 || east > 180 || south < -85 || north > 85) {
        throw new Error('--bbox wants west,south,east,north in degrees, e.g. 151.93,-27.58,151.98,-27.53');
      }
      o.bbox = { west, south, east, north };
    } else if (flag === '--out') o.out = value();
    else if (flag === '--upload') {
      const v = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : DEFAULT_BASE);
      if (!/^https?:\/\/[^/]+$/.test(v.replace(/\/$/, ''))) throw new Error('--upload wants a site\'s base address, e.g. https://floodwarning.net');
      o.base = v.replace(/\/$/, '');
    } else if (flag === '--dry-run') o.dryRun = true;
    else if (flag === '--help' || flag === '-h') o.help = true;
    else throw new Error(`unknown argument ${a} (try --help)`);
  }
  return o;
}

const HELP = `Usage: node qld-buildings.mjs [--bbox w,s,e,n] [--out DIR] [--upload [BASE]] [--dry-run]
  --bbox w,s,e,n  only this area (degrees), widened to whole zoom-14 tiles
  --out DIR       write DIR/14/x/y.pbf (unpacked) and DIR/meta.json
  --upload [BASE] PUT each tile, gzipped, to BASE${ROUTE}/14/x/y.pbf (BASE defaults to ${DEFAULT_BASE});
                  needs SUPABASE_SECRET_KEY
  --dry-run       fetch and build every tile, PUT nothing`;

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.help) { console.log(HELP); process.exit(0); }
    if (!o.out && !o.base && !o.dryRun) throw new Error('nothing to do: give --out, --upload or --dry-run (try --help)');
    const key = process.env.SUPABASE_SECRET_KEY;
    if (o.base && !o.dryRun && !key) throw new Error('SUPABASE_SECRET_KEY is not set, so nothing can be uploaded');
    await build({ ...o, key });
  } catch (err) {
    console.error(`qld-buildings: ${err.message}`);
    process.exit(1);
  }
}
