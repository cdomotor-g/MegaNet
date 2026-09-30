// The Queensland cadastre in the Digital Twin (twin-cadastre.js): every lot's
// boundary on the twin's ground with its lot and plan written in it, and the
// road reserve outlined, washed and named — on the tab and inside the
// Stations map, in orbit, top-down and the POV.
//
// Why a check of its own. Everything this layer can get wrong draws a
// perfectly plausible picture: a boundary floating a few centimetres over the
// ground looks fine from above and wrong from the POV; a line drawn exactly on
// the ground vanishes under the 10 cm drape round the station, which is where
// it matters most, and nothing throws; a junction left out is a hole in the
// road reserve; an edge two road parcels share, drawn, cuts the reserve into
// blocks; a strata plan drawn on the ground is a knot of rectangles on every
// block of units; "the road reserve of Road" is the DCDB's placeholder read
// as a name. `twin` holds the ground and `twinsite` what is built on it; this
// holds what is written on it.
//
// The world is made here, as `twinsite` makes its own. The State's elevation
// service is answered with a tiled float GeoTIFF of a closed-form valley with
// curvature in both directions — flat ground would let a line drawn at the
// bilinear height pass for one drawn on the triangles. The imagery is a varied
// PNG, the imagery catalogue a 10 cm flight (so the sharp drape stands round
// the station, as it does in every Queensland town), and the cadastre a
// neighbourhood about the station in metres, answered the way the live
// Land Parcel Property Framework answers:
//
//   Lot 1 and Lot 2 on RP12345, north of Railway Street; the station stands
//   in Lot 2 (Freehold, 3,000 m²). Lot 2 again, as '00002' and started at
//   another corner — the scheme land of a building units plan is often
//   recorded twice like that. Lot 3 on SP999 (Reserve) south of the road.
//   Railway Street, west and east of a T-junction with North Street, whose
//   square is its own parcel under 'Unlinked parcel or inter' with no name,
//   sharing its corners with the four road halves exactly; an unlinked
//   remnant out on its own, sharing nothing. Easement A on RP12345 along the
//   north of Lot 2. The watercourse parcel of Lockyer Creek. A strata lot
//   over the station, which must not be drawn. A road parcel whose name is
//   the DCDB's "Road". Corners at seven decimals, as geometryPrecision=7
//   prints them, shared by reference so a shared corner is the same text.
//
// The stub honours the query's `where` (a stub that answered every row
// would draw the strata lot whatever the app asked for, and this file would
// pass against the code it was written to fail), and can page at five rows
// with the transfer-limit flag, as the live service pages at 4,000.
//
// Needs WebGL2, which Playwright's Chromium has through SwiftShader; skips
// rather than fails if that is ever absent, as twin and twinsite do.
//
//   node --run twincadastre      (or: npm run twincadastre)
//       npm run twincadastre -- -v    also print what passed

import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { tiffF32, snapExtent } from './lib/geotiff.mjs';
import { hillyTerrariumPng } from './lib/terrarium.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT  = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const BUILD_TIMEOUT = Number(process.env.TWIN_TIMEOUT || 90_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b, tol) => a != null && b != null && isFinite(a) && isFinite(b) && Math.abs(a - b) <= tol;
const section = t => console.log(`\n${t}\n`);
const J = v => JSON.stringify(v);

const STATIONS = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;
const byId = id => STATIONS.find(s => s.id === id);

// ── off the page: the arithmetic ─────────────────────────────────────────────
function loadModule() {
  const ctx = { console, esc: s => String(s) };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(repo('twin-cadastre.js'), 'utf8')}\n;this.TwinCadastre = TwinCadastre;`, ctx);
  return ctx.TwinCadastre;
}

function nodeHalf(TC) {
  const X = TC._pure;
  section('The arithmetic, off the page');

  // A 3 × 3 grid, 2 m across: row 0 is north, as the State's raster is.
  const g3 = { elev: Float32Array.from([10, 11, 13, 12, 14, 17, 15, 18, 22]), size: 2, half: 1, h0: 10 };
  ok('a point in a cell\'s north-west triangle is on that triangle\'s plane', near(X.reliefAt(g3, -0.75, -0.75), 0.75, 1e-9), X.reliefAt(g3, -0.75, -0.75));
  ok('…and one in its south-east triangle on that one\'s', near(X.reliefAt(g3, -0.25, -0.25), 2.75, 1e-9), X.reliefAt(g3, -0.25, -0.25));
  ok('the diagonal runs south-west to north-east, and the two planes meet on it — 11.5 m, where the bilinear height is 11.75',
    near(X.reliefAt(g3, -0.5, -0.5), 1.5, 1e-9) && near(X.reliefAt(g3, -0.5 - 1e-9, -0.5 - 1e-9), 1.5, 1e-6)
      && near(X.reliefAt(g3, -0.5 + 1e-9, -0.5 + 1e-9), 1.5, 1e-6), X.reliefAt(g3, -0.5, -0.5));

  // A 21 × 21 grid over 40 m with relief that is not a plane anywhere.
  const n = 21, elev = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) elev[j * n + i] = 50 + 3 * Math.sin(i * 0.9) * Math.cos(j * 0.7) + 0.2 * i * j;
  const g21 = { elev, size: 40, half: 20, h0: 50 };
  const xz = [], rel = [];
  X.drape(g21, -17.3, -12.1, 15.9, 18.7, xz, rel);
  let planar = true, chained = true, worst = 0;
  for (let k = 0; k < rel.length; k += 2) {
    const ax = xz[2 * k], az = xz[2 * k + 1], bx = xz[2 * k + 2], bz = xz[2 * k + 3];
    const mid = X.reliefAt(g21, (ax + bx) / 2, (az + bz) / 2);
    const err = Math.abs(mid - (rel[k] + rel[k + 1]) / 2);
    worst = Math.max(worst, err);
    if (err > 1e-6) planar = false;
    if (k && (Math.abs(xz[2 * k] - xz[2 * k - 2]) > 1e-9 || Math.abs(xz[2 * k + 1] - xz[2 * k - 1]) > 1e-9)) chained = false;
  }
  ok('a boundary is cut at every grid line and every diagonal: each piece lies in one triangle, so its middle is on the ground too',
    planar && rel.length > 40, `${rel.length / 2} pieces, worst ${worst.toExponential(2)} m`);
  ok('…and the pieces run end to end from one corner to the other',
    chained && near(xz[0], -17.3, 1e-9) && near(xz[1], -12.1, 1e-9) && near(xz[xz.length - 2], 15.9, 1e-9) && near(xz[xz.length - 1], 18.7, 1e-9));

  ok('a segment inside the patch is kept whole', J(X.clip(-5, -5, 5, 5, 10)) === J([-5, -5, 5, 5]));
  const c = X.clip(-30, 0, 30, 0, 10);
  ok('…one across it is cut at its edges', c && near(c[0], -10, 1e-12) && near(c[2], 10, 1e-12), J(c));
  ok('…and one outside it is dropped', X.clip(15, 15, 30, 12, 10) === null);

  const rect = Float64Array.from([0, 0, 50, 0, 50, 60, 0, 60, 0, 0]);
  const pr = X.polylabel([rect], 0.1);
  ok('a lot\'s label goes at the point furthest from its edges: the middle of a 50 × 60 m lot, 25 m from the nearest',
    near(pr.x, 25, 0.2) && near(pr.z, 30, 1) && near(pr.d, 25, 0.2), J(pr));
  const ell = Float64Array.from([0, 0, 40, 0, 40, 10, 10, 10, 10, 40, 0, 40, 0, 0]);
  const pl = X.polylabel([ell], 0.05);
  // An L of 10 m arms: the biggest circle inside sits in its corner, touching
  // both outer edges and the inside corner — radius 10√2 / (1 + √2) = 5.86 m.
  ok('…and inside an L, in its corner, where the centroid is not', X.signedDist(pl.x, pl.z, [ell]) > 0
      && near(pl.d, 10 * Math.SQRT2 / (1 + Math.SQRT2), 0.06) && near(pl.x, pl.z, 0.1), J(pl));

  ok('the DCDB\'s accuracy codes read as metres: ±0.5, ±0.25, ±25, ±126, and none',
    X.accuracyM('B&D PLOT CONTROLLED - 0.5M') === 0.5 && X.accuracyM('NUMERIC ADJUSTMENT +/- 0.25M') === 0.25
      && X.accuracyM('PROVISIONAL 1:10000 CADASTRAL MAP - 25M') === 25 && X.accuracyM('PROVISIONAL 1:50000 CADASTRAL MAP - 126M') === 126
      && X.accuracyM('NO ACCURACY VALUE') === null);
  ok('…and as how they were plotted', X.accuracyHow('PROVISIONAL 1:10000 CADASTRAL MAP - 25M') === 'provisional 1:10000 cadastral map'
      && X.accuracyHow('NUMERIC ADJUSTMENT +/- 0.25M') === 'numeric adjustment', X.accuracyHow('NUMERIC ADJUSTMENT +/- 0.25M'));
  ok('areas in m² and hectares', X.areaWords(969) === '969 m²' && X.areaWords(30720) === '3.07 ha' && X.areaWords(148260000) === '14,826 ha',
    [X.areaWords(969), X.areaWords(30720), X.areaWords(148260000)].join(' | '));

  // classify and the edges, on parcels made here with lon/lat standing for x/z.
  const f = (props, ring) => ({ type: 'Feature', properties: { cover_typ: 'Base', ...props }, geometry: { type: 'Polygon', coordinates: [ring] } });
  const sq = (w, s, e, n_) => [[w, s], [e, s], [e, n_], [w, n_], [w, s]];
  const list = X.compact([
    f({ parcel_typ: 'Road Type Parcel', feat_name: 'Road' }, sq(0, 0, 10, 2)),
    f({ parcel_typ: 'Road Type Parcel', feat_name: 'Olc' }, sq(12, 0, 20, 2)),
    f({ parcel_typ: 'Unlinked parcel or inter' }, sq(10, 0, 12, 2)),
    f({ parcel_typ: 'Unlinked parcel or inter' }, sq(30, 30, 31, 31)),
    f({ parcel_typ: 'Lot Type Parcel', lot: '5', plan: 'RP1' }, sq(0, 2, 10, 8)),
    f({ parcel_typ: 'Lot Type Parcel', lot: '00005', plan: 'RP1' }, [[10, 2], [10, 8], [0, 8], [0, 2], [10, 2]]),
  ]);
  const cl = X.classify(list);
  const kinds = cl.map(p => `${p.kind}${p.node ? '*' : ''}:${p.name || p.lot || ''}`);
  ok('"Road" is the DCDB\'s word for no name, and is not written as one — "Olc" is a name',
    cl[0].kind === 'road' && cl[0].name === '' && cl[1].name === 'Olc', J(kinds));
  ok('a junction square sharing corners with a road is road reserve, named for the roads that meet there; a remnant sharing none is not',
    cl[2].kind === 'road' && cl[2].node && J(cl[2].joins) === J(['Olc']) && cl[3].kind === 'other', J(kinds));
  ok('the same lot recorded twice, with its lot number padded and its outline started at another corner, is kept once',
    cl.filter(p => p.kind === 'lot').length === 1 && cl.find(p => p.kind === 'lot').lot === '5', J(kinds));
  const prep = cl.map(p => ({ ...p, xz: p.parts.map(rings => ({ rings: rings.map(ll => { const r = Float64Array.from(ll); r.ll = ll; return r; }) })) }));
  const e = X.edgesOf(prep);
  const has = (set, ax, az, bx, bz) => set.some(s => (near(s.ax, ax, 1e-9) && near(s.az, az, 1e-9) && near(s.bx, bx, 1e-9) && near(s.bz, bz, 1e-9))
                                                  || (near(s.ax, bx, 1e-9) && near(s.az, bz, 1e-9) && near(s.bx, ax, 1e-9) && near(s.bz, az, 1e-9)));
  ok('an edge two road parcels share is inside the reserve and not drawn; the reserve\'s own edge is',
    !has(e.roads, 10, 0, 10, 2) && !has(e.roads, 12, 0, 12, 2) && has(e.roads, 0, 0, 10, 0) && has(e.roads, 0, 0, 0, 2));
  ok('a lot\'s frontage on the reserve is the reserve\'s edge, set aside from the lot lines for when the reserve is hidden',
    !has(e.lots, 0, 2, 10, 2) && has(e.lotsAlongRoad, 0, 2, 10, 2) && has(e.lots, 0, 8, 10, 8));
  ok('the compass: north, east, south-west', X.compass(0, -5) === 'N' && X.compass(5, 0) === 'E' && X.compass(-5, 5) === 'SW');
}

// ── the world ────────────────────────────────────────────────────────────────
let CUR = { lat: byId('gatton').lat, lon: byId('gatton').lon };
const M_LAT = () => 110574, M_LON = () => 111320 * Math.cos(CUR.lat * Math.PI / 180);
// Curved both ways, so the ground's triangles are not its bilinear surface.
const valley = (x, z) => 90 + 0.04 * x + 2.5 * Math.sin(x / 13) * Math.cos(z / 17) + 1.5 * Math.cos((x + z) / 29);
const groundAt = (lat, lon) => valley((lon - CUR.lon) * M_LON(), -(lat - CUR.lat) * M_LAT());
const r7 = v => Math.round(v * 1e7) / 1e7;
// A point x m east and z m south of the station, as the service prints it.
const P = (x, z) => [r7(CUR.lon + x / M_LON()), r7(CUR.lat - z / M_LAT())];
const ring = pts => { const r = pts.map(([x, z]) => P(x, z)); r.push(r[0]); return r; };
const PLACE = { locality: 'Gatton', shire_name: 'Lockyer Valley Regional' };
const GOOD = 'B&D PLOT CONTROLLED - 0.5M';
let lot2Acc = GOOD;

function neighbourhood() {
  const feat = (props, pts) => ({ type: 'Feature', properties: { cover_typ: 'Base', lot: null, plan: null, tenure: null, lot_area: 0,
                                                                  feat_name: null, acc_code: GOOD, ...PLACE, ...props },
                                  geometry: { type: 'Polygon', coordinates: [ring(pts)] } });
  return [
    feat({ parcel_typ: 'Lot Type Parcel', lot: '1', plan: 'RP12345', tenure: 'Freehold', lot_area: 2400 }, [[-60, -40], [-20, -40], [-20, 20], [-60, 20]]),
    feat({ parcel_typ: 'Lot Type Parcel', lot: '2', plan: 'RP12345', tenure: 'Freehold', lot_area: 3000, acc_code: lot2Acc }, [[-20, -40], [30, -40], [30, 20], [-20, 20]]),
    feat({ parcel_typ: 'Lot Type Parcel', lot: '00002', plan: 'RP12345', tenure: 'Freehold', lot_area: 3000, acc_code: lot2Acc }, [[30, -40], [30, 20], [-20, 20], [-20, -40]]),
    feat({ parcel_typ: 'Lot Type Parcel', lot: '3', plan: 'SP999', tenure: 'Reserve', lot_area: 5400 }, [[-60, 40], [30, 40], [30, 100], [-60, 100]]),
    feat({ parcel_typ: 'Road Type Parcel', feat_name: 'Railway Street' }, [[-170, 20], [-60, 20], [-20, 20], [30, 20], [30, 40], [-60, 40], [-170, 40]]),
    feat({ parcel_typ: 'Road Type Parcel', feat_name: 'Railway Street' }, [[50, 20], [200, 20], [200, 40], [50, 40]]),
    feat({ parcel_typ: 'Road Type Parcel', feat_name: 'North Street' }, [[30, -200], [50, -200], [50, 20], [30, 20], [30, -40]]),
    feat({ parcel_typ: 'Road Type Parcel', feat_name: 'North Street' }, [[30, 40], [50, 40], [50, 200], [30, 200], [30, 100]]),
    feat({ parcel_typ: 'Unlinked parcel or inter' }, [[30, 20], [50, 20], [50, 40], [30, 40]]),
    feat({ parcel_typ: 'Unlinked parcel or inter' }, [[-150, -150], [-140, -150], [-140, -140], [-150, -140]]),
    feat({ parcel_typ: 'Road Type Parcel', feat_name: 'Road' }, [[60, -120], [120, -120], [120, -110], [60, -110]]),
    feat({ parcel_typ: 'Easement', cover_typ: 'Easement', lot: 'A', plan: 'RP12345', tenure: 'Easement', lot_area: 500 }, [[-20, -40], [30, -40], [30, -30], [-20, -30]]),
    feat({ parcel_typ: 'Watercourse', feat_name: 'Lockyer Creek' }, [[-200, -200], [-172, -200], [-172, 200], [-200, 200]]),
    feat({ parcel_typ: 'Lot Type Parcel', cover_typ: 'Strata', lot: '7', plan: 'BUP1', tenure: 'Freehold', lot_area: 400 }, [[-10, -10], [10, -10], [10, 10], [-10, 10]]),
  ];
}

// The `where` the app sends, honoured: `cover_typ IN ('Base','Easement')` or nothing.
function honour(where, feats) {
  const m = /cover_typ\s+IN\s*\(([^)]*)\)/i.exec(where || '');
  if (!m) return feats;
  const allowed = new Set(m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')));
  return feats.filter(f => allowed.has(f.properties.cover_typ));
}

// PNG in, pixels out: the stage's screenshot, for the lines over the drape.
function decodePng(buf) {
  let p = 8, w = 0, h = 0, bpp = 4;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); bpp = body[9] === 6 ? 4 : 3; }
    else if (type === 'IDAT') idat.push(body);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * bpp), stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { w, h, at: (x, y) => { const o = (y * w + x) * bpp; return [px[o], px[o + 1], px[o + 2]]; } };
}

// ── the page ─────────────────────────────────────────────────────────────────
async function browserHalf() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const cad = { queries: [], probes: 0, mode: 'ok' };   // mode: 'ok' | 'fail' | 'paged'
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    const cors = { 'Access-Control-Allow-Origin': '*' };
    await page.route(/QldDem\/ImageServer\/exportImage/, route => {
      const u = new URL(route.request().url());
      const bbox = (u.searchParams.get('bbox') || '').split(',').map(Number);
      const [W, H] = (u.searchParams.get('size') || '0,0').split(',').map(Number);
      const extent = snapExtent(bbox, W, H, u.searchParams.get('adjustAspectRatio'));
      const pw = (extent[2] - extent[0]) / W, ph = (extent[3] - extent[1]) / H;
      return route.fulfill({ status: 200, contentType: 'image/tiff', headers: cors,
        body: tiffF32(W, H, extent, (x, y) => groundAt(extent[3] - (y + 0.5) * ph, extent[0] + (x + 0.5) * pw)) });
    });
    await page.route(/LatestStateProgram_AllUsers\/ImageServer\/exportImage/, route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(14, 15000, 9000), headers: cors }));
    await page.route(/LatestStateProgram_AllUsers\/ImageServer\/query/, route =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: J({ features: [
        { attributes: { name: 'Lockyer_Valley_Urban_2021_10cm_SISP', lowps: 0.1, year: 2021, capturestart: Date.UTC(2021, 4, 15), acq_platform: 1 } },
      ] }) }));
    await page.route(/RoadsAndTracks\/MapServer\/22\/query|OtherTransport\/MapServer\/160\/query/, route =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: J({ features: [] }) }));
    await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
      const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
      return route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: hillyTerrariumPng(+m[1], +m[2], +m[3]) });
    });
    // The cadastre: the service description MapRoads and the twin probe, and
    // the query — the `where` honoured, the rows in pages when asked to page.
    await page.route(/LandParcelPropertyFramework\/MapServer/, route => {
      const u = new URL(route.request().url());
      if (/\/MapServer\/?$/.test(u.pathname)) {
        cad.probes++;
        return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: J({ layers: [
          { id: 0, name: 'Addresses' }, { id: 4, name: 'Cadastral parcels' }, { id: 5, name: '[Deprecated] Cadastral parcels - gt 1ha' }] }) });
      }
      const m = /MapServer\/(\d+)\/query$/.exec(u.pathname);
      if (!m) return route.fulfill({ status: 404, body: 'no', headers: cors });
      const q = Object.fromEntries(u.searchParams);
      // The twin's own questions, which always name a page. The Stations map
      // the twin now stands in asks the same layer for its own parcels, with
      // none, and that is not what is being counted here.
      if ('resultOffset' in q) cad.queries.push({ id: Number(m[1]), ...q });
      if (cad.mode === 'fail') return route.fulfill({ status: 500, body: 'down', headers: cors });
      const all = honour(q.where, neighbourhood());
      let feats = all, more = false;
      if (cad.mode === 'paged') {
        const off = Number(q.resultOffset || 0);
        feats = all.slice(off, off + 5);
        more = off + 5 < all.length;
      }
      return route.fulfill({ status: 200, contentType: 'application/geo+json', headers: cors,
        body: J({ type: 'FeatureCollection', features: feats, ...(more ? { exceededTransferLimit: true, properties: { exceededTransferLimit: true } } : {}) }) });
    });
    page.on('pageerror', e => errors.push(e.stack || e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });

    await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
    const gl = await page.evaluate(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); });
    if (!gl) { console.log('\n  SKIP — this Chromium has no WebGL; the twin cannot be exercised here.'); return; }
    // The water and the far country are other checks' business, and each
    // would stand over the lines this one reads.
    await page.evaluate(() => { DigitalTwin._infoFold(null); DigitalTwin.setFlood(false); DigitalTwin.setHorizon(false); });

    const settle = id => page.waitForFunction(i => {
      const d = DigitalTwin.debug(), c = TwinCadastre.debug();
      return d.built && d.stationId === i && !d.status.endsWith('…') && !['loading'].includes(c.status)
        && (!c.prefs.lots && !c.prefs.roads ? true : c.status !== 'off');
    }, id, { timeout: BUILD_TIMEOUT });
    const open = async id => {
      const s = byId(id);
      CUR = { lat: s.lat, lon: s.lon };
      await page.evaluate(i => { if (state.activeTab === 'twin') DigitalTwin.pick(i); else DigitalTwin.openStation(i); }, id);
      await settle(id);
      await page.waitForTimeout(250);
      return page.evaluate(() => TwinCadastre.debug());
    };
    const text = sel => page.evaluate(s => { const el = document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
    const segs = k => page.evaluate(k_ => {
      const v = TwinCadastre._vertices(k_);
      const out = [];
      for (let i = 0; i + 1 < v.length; i += 2) out.push({ x: (v[i].x + v[i + 1].x) / 2, z: (v[i].z + v[i + 1].z) / 2, dx: v[i + 1].x - v[i].x, dz: v[i + 1].z - v[i].z });
      return out;
    }, k);
    // A piece of line running along x = at or z = at, between lo and hi: within
    // 2 cm, because the service prints degrees to seven places (about a
    // centimetre) so a corner at 20 m comes back a few millimetres off it; and
    // running *along* it, because an edge that ends on a grid line leaves a
    // sliver there whose middle is on the line too.
    const along = (list, axis, at, lo, hi) => list.some(s => (axis === 'z'
      ? Math.abs(s.z - at) < 0.02 && s.x > lo && s.x < hi && Math.abs(s.dx) > 0.1 && Math.abs(s.dz) < 0.02
      : Math.abs(s.x - at) < 0.02 && s.z > lo && s.z < hi && Math.abs(s.dz) > 0.1 && Math.abs(s.dx) < 0.02));
    const frame = () => page.waitForTimeout(200);

    // ═══════════════════════════════════════════════════════════════════════
    section('The question the twin asks the cadastre');

    let c = await open('gatton');
    const q = cad.queries[0] || {};
    const box = await page.evaluate(() => { const o = DigitalTwin._latLonAt(0, 0); return { o, a: DigitalTwin._latLonAt(-200, 200), b: DigitalTwin._latLonAt(200, -200) }; });
    const geom = String(q.geometry || '').split(',').map(Number);
    ok('one query of the "Cadastral parcels" layer, found by name, for the patch\'s own box',
      cad.queries.length === 1 && q.id === 4 && cad.probes >= 1 && geom.length === 4
        && near(geom[0], box.a.lon, 1e-9) && near(geom[1], box.a.lat, 1e-9) && near(geom[2], box.b.lon, 1e-9) && near(geom[3], box.b.lat, 1e-9),
      J({ n: cad.queries.length, id: q.id, geometry: q.geometry, box }));
    ok('…for the ground and its rights, not the buildings: Base and Easement, not Strata or Volumetric',
      /cover_typ IN \('Base','Easement'\)/.test(q.where || ''), q.where);
    ok('…as GeoJSON to the centimetre, not generalised, in pages the size the service allows',
      q.f === 'geojson' && q.geometryPrecision === '7' && !('maxAllowableOffset' in q) && q.outSR === '4326'
        && q.resultRecordCount === '4000' && q.resultOffset === '0' && q.orderByFields === 'objectid', J(q));
    ok('…with the fields the words are made of',
      ['lot', 'plan', 'parcel_typ', 'cover_typ', 'tenure', 'lot_area', 'feat_name', 'locality', 'acc_code'].every(k => String(q.outFields).split(',').includes(k)), q.outFields);

    // ═══════════════════════════════════════════════════════════════════════
    section('What is drawn, and where');

    ok('twelve parcels: three lots (Lot 2 once), five road parcels, the junction, the creek, the easement and the remnant — and no strata lot',
      c.status === 'ok' && J(c.counts) === J({ parcels: 12, lots: 3, roads: 5, junctions: 1, water: 1, easements: 1, other: 1 })
        && !c.labels.lots.some(l => l.sub === 'BUP1'), J(c.counts));
    const onMesh = await page.evaluate(() => {
      const out = {};
      for (const k of ['lots', 'roads', 'easements', 'lotsAlongRoad']) {
        const v = TwinCadastre._vertices(k, 13);
        let worst = 0, worstGround = 0, n = 0;
        for (const p of v) {
          const m = TwinCadastre._meshY(p.x, p.z);
          if (m == null) continue;
          n++;
          worst = Math.max(worst, Math.abs(p.y - m));
          worstGround = Math.max(worstGround, Math.abs(p.ground - m));
        }
        out[k] = { n, worst, worstGround };
      }
      return out;
    });
    ok('every line lies on the ground three draws — on the mesh itself, found by a ray, not on a height worked out beside it',
      Object.values(onMesh).every(o => o.n > 5 && o.worst < 2e-3), J(onMesh));
    const roadSegs = await segs('roads'), lotSegs = await segs('lots'), alongSegs = await segs('lotsAlongRoad'), easeSegs = await segs('easements');
    ok('the road reserve is outlined: Lot 2\'s frontage on Railway Street is drawn in the road colour…',
      along(roadSegs, 'z', 20, -20, 30), `${roadSegs.length} pieces`);
    ok('…and the edges the road parcels share with the junction are not drawn at all — the reserve is one piece',
      !along(roadSegs, 'x', 30, 20, 40) && !along(roadSegs, 'x', 50, 20, 40) && !along(roadSegs, 'z', 20, 30, 50) && !along(roadSegs, 'z', 40, 30, 50));
    ok('the frontage is not drawn in white as well, but is kept for when the reserve is hidden',
      !along(lotSegs, 'z', 20, -20, 30) && along(alongSegs, 'z', 20, -20, 30) && along(lotSegs, 'x', -20, -40, 20));
    ok('the remnant that meets no road is a boundary, not road reserve',
      along(lotSegs, 'z', -150, -150, -140) && !along(roadSegs, 'z', -150, -150, -140));
    ok('the easement is drawn where it crosses the lot, and not again over the lot\'s own boundary',
      along(easeSegs, 'z', -30, -20, 30) && !along(easeSegs, 'z', -40, -20, 30));
    ok('the reserve\'s wash lies on the ground\'s own geometry, and is not in the .glb', c.lines.wash.visible && c.lines.wash.sharesGround && !c.lines.wash.exported);
    const glb = await page.evaluate(async () => {
      const buf = await DigitalTwin.buildGlb();
      const dv = new DataView(buf), len = dv.getUint32(12, true);
      return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len))).meshes.map(m => m.name);
    });
    ok('…nor is anything else of the cadastre', glb.includes('ground') && !glb.some(n => /reserve|lot|cadastre|easement/i.test(n)), J(glb));

    // ═══════════════════════════════════════════════════════════════════════
    section('The station\'s ground, in words');

    let site = await text('#twin-site');
    ok('the line under the stage says which lot the station stands in, its tenure and area, the road reserve and how far, and how well it is plotted',
      /The station stands in Lot 2 on RP12345 \(Freehold, 3,000 m²\) · the road reserve of Railway Street 20 m S · boundaries plotted to ±0\.5 m/.test(site), site);
    ok('the cadastre is credited while it is drawn', /Cadastre: © State of Queensland/.test(await text('#twin-attrib')));
    const click = async (x, z) => {
      const pt = await page.evaluate(([x_, z_]) => DigitalTwin._screen(x_, DigitalTwin.debug().yAt(x_, z_), z_), [x, z]);
      await page.mouse.click(pt.x, pt.y);
      await frame();
      return text('#twin-pick');
    };
    await page.evaluate(() => DigitalTwin.topView());
    await frame();
    let pick = await click(-100, 30);
    ok('a click in the road says whose road it is', /In the road reserve of Railway Street \(Gatton\)\.$/.test(pick), pick);
    pick = await click(5, -35);
    ok('…in the lot, which lot, and the easement over it', /In Lot 2 on RP12345 \(Freehold, 3,000 m²\), inside Easement A on RP12345\.$/.test(pick), pick);
    pick = await click(40, 30);
    ok('…in the junction, the roads that meet there', /In the road reserve at the North Street \/ Railway Street intersection \(Gatton\)\.$/.test(pick), pick);
    pick = await click(90, -115);
    ok('…and a road the DCDB calls "Road" is an unnamed reserve', /In an unnamed road reserve \(Gatton\)\.$/.test(pick), pick);

    // ═══════════════════════════════════════════════════════════════════════
    section('The lot numbers and the road names');

    c = await page.evaluate(() => TwinCadastre.debug());
    const titles = c.labels.placed.map(l => `${l.title}${l.sub ? ` ${l.sub}` : ''}`);
    ok('looking down on the patch: every lot\'s number and plan, each road\'s name and the creek\'s — the station\'s own lot first',
      c.labels.placed[0] && c.labels.placed[0].own && c.labels.placed[0].title === 'Lot 2'
        && ['Lot 1 RP12345', 'Lot 2 RP12345', 'Lot 3 SP999', 'Railway Street', 'North Street', 'Lockyer Creek'].every(t => titles.includes(t)), J(titles));
    ok('…and nothing written for the junction, the remnant, the easement, the unnamed reserve or the strata lot',
      !titles.some(t => /Road$|Easement|BUP1|intersection/.test(t)) && c.labels.names.every(n => n.title) && c.labels.total === 8, J({ titles, total: c.labels.total }));
    const ink = await page.evaluate(() => {
      const cv = document.querySelector('#twin-stage canvas.twin-cad-labels');
      const gl = document.getElementById('twin-canvas');
      if (!cv) return null;
      const cs = getComputedStyle(cv), a = cv.getBoundingClientRect(), b = gl.getBoundingClientRect();
      const dpr = cv.width / a.width;
      const p = TwinCadastre.debug().labels.placed[0];
      const d = cv.getContext('2d').getImageData(Math.round((p.sx - 12) * dpr), Math.round((p.sy - 6) * dpr), Math.round(24 * dpr), Math.round(12 * dpr)).data;
      let inked = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 128) inked++;
      return { inked, events: cs.pointerEvents, hidden: cv.getAttribute('aria-hidden'), over: Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1 };
    });
    ok('the words are written on a canvas laid exactly over the scene, that the pointer goes through and a reader is not told about',
      ink && ink.inked > 20 && ink.events === 'none' && ink.hidden === 'true' && ink.over, J(ink));
    const clash = await page.evaluate(() => {
      const boxes = [...TwinCadastre._signBoxes(), ...TwinCadastre._furnitureBoxes()], placed = TwinCadastre.debug().labels.placed;
      return placed.filter(p => boxes.some(b => p.sx - p.w / 2 < b.x1 && p.sx + p.w / 2 > b.x0 && p.sy - p.h / 2 < b.y1 && p.sy + p.h / 2 > b.y0)).map(p => p.title);
    });
    const furniture = await page.evaluate(() => TwinCadastre._furnitureBoxes().length);
    ok('no label is written over a sign the scene stands up, or under the stage\'s own controls — the compass, the line of help',
      clash.length === 0 && furniture >= 2, J({ clash, furniture }));
    await page.evaluate(() => DigitalTwin._pov({ px: 5, pz: 12, yaw: 0, pitch: -0.25 }));
    await frame();
    c = await page.evaluate(() => TwinCadastre.debug());
    const pov = c.labels.placed.map(l => l.title);
    ok('standing in the lot: its own number, and none of the far country\'s — no creek 190 m off, no street across the town',
      pov.includes('Lot 2') && !pov.includes('Lockyer Creek') && pov.length <= 4, J(pov));
    await page.evaluate(() => DigitalTwin.toggleWalk());

    // ═══════════════════════════════════════════════════════════════════════
    section('Over the 10 cm drape round the station');

    const sharp = await page.evaluate(() => DigitalTwin.debug().sharp);
    ok('the station has its sharp drape, the mesh pulled forward over the ground', !!sharp && sharp.visible && sharp.size === 100, J(sharp));
    await page.evaluate(v => DigitalTwin._orbit(v), { radius: Number(process.env.TC_R || 45), theta: Number(process.env.TC_T || 1.2), phi: Number(process.env.TC_P || 1.25) });
    await frame();
    const shot = async () => {
      await page.evaluate(() => { const cv = document.querySelector('.twin-cad-labels'); if (cv) cv.style.visibility = 'hidden'; });
      await frame();
      const png = decodePng(await page.locator('#twin-stage').screenshot());
      await page.evaluate(() => { const cv = document.querySelector('.twin-cad-labels'); if (cv) cv.style.visibility = ''; });
      return png;
    };
    // Points on the stage's own screenshot: projected and measured against the
    // stage in one go, since a screenshot may scroll the page under them.
    const onStage = pts => page.evaluate(ps => {
      const st = document.getElementById('twin-stage').getBoundingClientRect(), y = DigitalTwin.debug().yAt;
      return ps.map(([x, z]) => { const s = DigitalTwin._screen(x, y(x, z), z); return { x: Math.round(s.x - st.left), y: Math.round(s.y - st.top) }; });
    }, pts);
    const on = await shot();
    const linePts = await onStage([-35, -30, -25, -20, -15, -10, -5, 0, 5, 10, 15].map(z => [-20, z]));
    const clearPts = await onStage([[8, -12], [15, -5], [0, -20]]);
    await page.evaluate(() => TwinCadastre.setLots(false));
    await frame();
    const off = await shot();
    await page.evaluate(() => TwinCadastre.setLots(true));
    const changed = pt => {
      let n = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const a = on.at(pt.x + dx, pt.y + dy), b = off.at(pt.x + dx, pt.y + dy);
        if (Math.abs(a[0] + a[1] + a[2] - b[0] - b[1] - b[2]) > 90) n++;
      }
      return n;
    };
    if (process.env.TC_SHOT) fs.writeFileSync(process.env.TC_SHOT, await page.locator('#twin-stage').screenshot());
    const drawnAt = linePts.map(changed), clearAt = clearPts.map(changed);
    ok('seen at a slant, Lot 1 and Lot 2\'s boundary — the 60 m of it inside the drape round the station — is drawn over the drape, not under it',
      drawnAt.filter(n => n >= 2).length >= 9 && clearAt.every(n => n === 0), J({ drawnAt, clearAt }));

    // ═══════════════════════════════════════════════════════════════════════
    section('The exaggeration');

    await page.evaluate(() => DigitalTwin.setExag(2.5));
    await frame();
    const lifted = await page.evaluate(() => {
      let worst = 0, n = 0;
      for (const p of TwinCadastre._vertices('lots', 11)) { const m = TwinCadastre._meshY(p.x, p.z); if (m == null) continue; n++; worst = Math.max(worst, Math.abs(p.y - m)); }
      return { n, worst };
    });
    ok('at 2.5× the lines go with the ground they lie on', lifted.n > 5 && lifted.worst < 5e-3, J(lifted));
    await page.evaluate(() => DigitalTwin.setExag(1));

    // ═══════════════════════════════════════════════════════════════════════
    section('The two switches in the Scene panel');

    // The Scene panel is in the 🧊 pane of the Stations side panel, beside the
    // twin in the map: opened, as ⚙ Settings on the twin's bar opens it.
    await page.evaluate(() => { setDockTab('twin'); DigitalTwin.topView(); });
    const boxes = await page.evaluate(() => [...document.querySelectorAll('#twin-cad-lots, #twin-cad-roads')].map(b => ({ id: b.id, checked: b.checked, label: b.closest('label').textContent.trim() })));
    ok('two switches, on, each named for what it draws', boxes.length === 2 && boxes.every(b => b.checked)
      && /Property boundaries and lot numbers/.test(boxes[0].label) && /Road parcels/.test(boxes[1].label), J(boxes));
    await page.click('#twin-cad-roads');
    await frame();
    c = await page.evaluate(() => TwinCadastre.debug());
    ok('the reserve off: its outline, its wash and its names go, and Lot 2\'s frontage is drawn in white instead',
      !c.lines.roads.visible && !c.lines.wash.visible && c.lines.lotsAlongRoad.visible && c.lines.lots.visible
        && !c.labels.placed.some(l => l.kind === 'road') && c.labels.placed.some(l => l.kind === 'lot'), J({ lines: c.lines, placed: c.labels.placed.map(l => l.title) }));
    ok('…and it is remembered', await page.evaluate(() => JSON.parse(localStorage.getItem('mn-twin-cadastre')).roads === false));
    await page.click('#twin-cad-lots');
    await frame();
    c = await page.evaluate(() => TwinCadastre.debug());
    site = await text('#twin-site');
    ok('both off: nothing drawn, nothing written, no credit and nothing said under the stage',
      !c.lines.lots.visible && !c.lines.lotsAlongRoad.visible && !c.lines.easements.visible && c.labels.placed.length === 0
        && !/Cadastre/.test(await text('#twin-attrib')) && !/🏠/.test(site), J({ placed: c.labels.placed.length, site }));
    const asked = cad.queries.length;
    c = await open('gatton_al');
    ok('with both off a new twin asks the cadastre nothing', cad.queries.length === asked && c.status === 'off', J({ asked, now: cad.queries.length, status: c.status }));
    await page.click('#twin-cad-lots');
    await page.waitForFunction(() => TwinCadastre.debug().status === 'ok', null, { timeout: BUILD_TIMEOUT });
    ok('…and asks the moment one is switched on', cad.queries.length === asked + 1);
    await page.click('#twin-cad-roads');
    c = await open('gatton');
    ok('back at Gatton the answer is drawn from memory, not asked again', cad.queries.length === asked + 1 && c.status === 'ok' && c.lines.roads.visible);

    // ═══════════════════════════════════════════════════════════════════════
    section('When the cadastre says something else');

    cad.mode = 'paged';
    await page.evaluate(() => TwinCadastre._clearCache());
    const before = cad.queries.length;
    c = await open('gatton_al');
    const pages = cad.queries.slice(before).map(x => x.resultOffset);
    ok('a patch past the service\'s page is read page after page, and drawn whole', J(pages) === J(['0', '5', '10']) && c.counts.parcels === 12, J({ pages, counts: c.counts }));
    cad.mode = 'ok';

    lot2Acc = 'PROVISIONAL 1:10000 CADASTRAL MAP - 25M';
    await page.evaluate(() => TwinCadastre._clearCache());
    c = await open('gatton');
    let notes = await page.evaluate(() => DigitalTwin.debug().notes);
    ok('a station plotted to ±25 m: the notes say the lines can be that far from the fences, and how it was plotted',
      notes.some(n => /plotted to ±25 m \(provisional 1:10000 cadastral map\)/.test(n) && /fences/.test(n))
        && /boundaries plotted to ±25 m/.test(await text('#twin-site')), J(notes));
    lot2Acc = GOOD;

    cad.mode = 'fail';
    await page.evaluate(() => TwinCadastre._clearCache());
    c = await open('gatton');
    notes = await page.evaluate(() => DigitalTwin.debug().notes);
    ok('a cadastre that will not answer: nothing drawn, no credit, and the notes say so and how to ask again',
      c.status === 'fail' && !c.lines && notes.some(n => /Queensland cadastre could not be asked/.test(n) && /Rebuild/.test(n))
        && !/Cadastre/.test(await text('#twin-attrib')), J({ status: c.status, notes }));
    cad.mode = 'ok';
    await page.evaluate(() => DigitalTwin.rebuild());
    await settle('gatton');
    ok('…and Rebuild asks again', (await page.evaluate(() => TwinCadastre.debug().status)) === 'ok');

    const nsw = 'armidale_stephens_br';
    const beforeNsw = cad.queries.length;
    c = await open(nsw);
    ok('over the border in New South Wales nothing is asked, and the line says there is no Queensland cadastre here',
      cad.queries.length === beforeNsw && c.status === 'outside' && /No Queensland cadastre in this patch/.test(await text('#twin-site')),
      J({ status: c.status, asked: cad.queries.length - beforeNsw }));

    // ═══════════════════════════════════════════════════════════════════════
    section('Inside the Stations map');

    CUR = { lat: byId('gatton').lat, lon: byId('gatton').lon };
    await page.evaluate(() => switchTab('stations'));
    ok('leaving the tab takes the layer and its words with it',
      await page.evaluate(() => TwinCadastre.debug().status === 'off' && !document.querySelector('canvas.twin-cad-labels')));
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(([lat, lon]) => { showStationCard('gatton'); state.map.setView([lat, lon], 17, { animate: false }); }, [CUR.lat, CUR.lon]);
    await page.waitForFunction(() => { const el = document.getElementById('map-twin-offer'); return el && !el.hidden; }, null, { timeout: LOAD_TIMEOUT });
    await page.click('#map-twin-offer .map-twin-offer-open');
    await page.waitForFunction(() => MapTwin.active() && DigitalTwin.debug().built && TwinCadastre.debug().status === 'ok', null, { timeout: BUILD_TIMEOUT });
    await frame();
    c = await page.evaluate(() => ({ ...TwinCadastre.debug(), inMap: !!document.querySelector('#map-twin #twin-stage canvas.twin-cad-labels') }));
    ok('the twin in the map draws the same parcels, and writes over its own stage', c.inMap && c.counts.parcels === 12 && c.labels.placed.length > 0,
      J({ inMap: c.inMap, counts: c.counts, placed: c.labels.placed.length }));
    await page.click('#map-twin .map-twin-back');
    await page.waitForFunction(() => !MapTwin.active(), null, { timeout: 10_000 });
    ok('← Map takes it down with the twin', await page.evaluate(() => TwinCadastre.debug().status === 'off' && !document.querySelector('canvas.twin-cad-labels')));

    ok('no uncaught page errors, and nothing on the console', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`  FAIL the check itself threw: ${err.stack || err}`);
  } finally {
    await browser.close();
    server.close();
  }
}

nodeHalf(loadModule());
await browserHalf();
console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
