// The Digital Twin's area, and the heights read off it — what the owner asked
// for in November 2026: ground that can be widened past the square round the
// station (Gayndah's flume wants the bridge a kilometre down the river), the
// ground's height under the pointer in m AHD and as a local gauge height, and
// a choice of whose gauge that height is on.
//
// Why a check of its own. `twin` holds the square: 201 × 201 samples with the
// station in the middle, and every assertion there passes whether or not the
// twin can stand on anything else. Everything here is the other case — a
// rectangle that is not round the station, sampled at its own count a side —
// and every way that goes wrong draws a perfectly plausible scene: a mesh
// slid half a patch from its heights, a flood mask laid on the wrong corner,
// a horizon with a gap where the patch used to end, a gauge height measured
// from the wrong station's zero. None of it throws.
//
// The world is `twinsite`'s: Queensland's elevation service answered with a
// tiled float GeoTIFF of a closed-form valley about the station (a creek bed
// at 85 m AHD 30 m west of it, banks at 90.5 m, the ground rising to the
// east), so every height asked of the twin is arithmetic; the State's bridges
// layer answered for the box it is asked about, with one span across the
// creek 40 m south of the gauge and another 640–720 m east of it — out of a
// 400 m patch, and the reason to widen one.
//
//   The arithmetic   an area is whole metres each way from the station, holds
//                    it, and is no wider than the limits; a plain square is
//                    sampled exactly as it always was; any other shape has
//                    square cells and the station on a sample.
//   The square       the default twin is still 201 × 201 round the station.
//   Widen to a bridge  the far bridge is offered by name and distance; one
//                    press builds the area that holds it — the mesh, the
//                    raster asked for, the heights, the station's own sample,
//                    the bridge drawn, the water, the horizon's seam — and it
//                    is kept for the station.
//   The four sides   a side typed in is the area; Back to the square undoes it.
//   Wide and fine    a 3.2 km square is sampled 401 a side, and so is a 400 m
//                    one asked for Fine.
//   Drawn on the map the twin steps aside, a drag on the map is the area
//                    (widened to hold the station), Escape puts it back.
//   The pointer      the readout beside the pointer is the ground under it,
//                    in m AHD and m LGH, and says whose gauge.
//   Whose gauge      the station's own zero by default; another gauge, the
//                    channel bed or a typed level by choice, kept for the
//                    station; a station with no zero says so and offers the
//                    rest.
//   Measuring        a click pins A, another B: the distance, the fall, the
//                    cross-section with the water in it; a third starts over.
//
// Needs WebGL2, which Playwright's Chromium has through SwiftShader; skips
// rather than fails if that is ever absent, as twin and twinsite do.
//
//   node --run twinarea        (or: npm run twinarea)
//       npm run twinarea -- -v    also print what passed

import fs from 'node:fs';
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

// ── the world ────────────────────────────────────────────────────────────────
let CUR = { lat: -27.555, lon: 152.275 };
const M_LAT = () => 110574, M_LON = () => 111320 * Math.cos(CUR.lat * Math.PI / 180);
function valley(x, z) {
  let h = 90.5;
  h -= 5.5 * Math.exp(-(((x + 30) / 8) ** 2));
  h += Math.min(10, Math.max(0, (x - 120) * 0.1));
  // A gentle fall to the south, so no two rows are the same and a ground laid
  // north for south is told apart.
  h -= 0.002 * z;
  return h;
}
const groundAt = (lat, lon) => valley((lon - CUR.lon) * M_LON(), -(lat - CUR.lat) * M_LAT());
const lonLat = (x, z) => [CUR.lon + x / M_LON(), CUR.lat - z / M_LAT()];

const NEAR_BRIDGE = { x0: -60, x1: 0, z: 40 };
const FAR_BRIDGE = { x0: 640, x1: 720, z: 60, name: 'Eastern Bridge' };

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const seen = { dem: [], bridges: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    const cors = { 'Access-Control-Allow-Origin': '*' };
    await page.route(/QldDem\/ImageServer\/exportImage/, route => {
      const u = new URL(route.request().url());
      const bbox = (u.searchParams.get('bbox') || '').split(',').map(Number);
      const [W, H] = (u.searchParams.get('size') || '0,0').split(',').map(Number);
      seen.dem.push({ bbox, W, H });
      const extent = snapExtent(bbox, W, H, u.searchParams.get('adjustAspectRatio'));
      const pw = (extent[2] - extent[0]) / W, ph = (extent[3] - extent[1]) / H;
      const body = tiffF32(W, H, extent, (x, y) => groundAt(extent[3] - (y + 0.5) * ph, extent[0] + (x + 0.5) * pw));
      return route.fulfill({ status: 200, contentType: 'image/tiff', body, headers: cors });
    });
    await page.route(/LatestStateProgram_AllUsers\/ImageServer\/exportImage/, route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(14, 15000, 9000), headers: cors }));
    await page.route(/LatestStateProgram_AllUsers\/ImageServer\/query/, route =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: J({ features: [] }) }));
    await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
      const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
      return route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(+m[1], +m[2], +m[3]), headers: cors });
    });
    // The bridges, for the box asked about — as the State answers.
    await page.route(/RoadsAndTracks\/MapServer\/22\/query|OtherTransport\/MapServer\/160\/query/, route => {
      const u = new URL(route.request().url());
      const [w, s, e, n] = (u.searchParams.get('geometry') || '').split(',').map(Number);
      seen.bridges.push({ w, s, e, n });
      if (/OtherTransport/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: J({ features: [] }) });
      const feats = [];
      for (const b of [NEAR_BRIDGE, FAR_BRIDGE]) {
        const a = lonLat(b.x0, b.z), c = lonLat(b.x1, b.z);
        if (c[0] < w || a[0] > e || a[1] < s || a[1] > n) continue;
        feats.push({ attributes: { name: b.name || null, feature_type: 'Road Bridge', dimension_m: b.x1 - b.x0 }, geometry: { paths: [[a, c]] } });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: J({ features: feats }) });
    });
    page.on('pageerror', e => errors.push(e.stack || e.message));

    await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
    const gl = await page.evaluate(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); });
    if (!gl) { console.log('\n  SKIP — this Chromium has no WebGL; the twin cannot be exercised here.'); return; }
    await page.evaluate(() => { DigitalTwin._infoFold(null); DigitalTwin.setFloodAnim(false); });

    const dbg = () => page.evaluate(() => DigitalTwin.debug());
    const seqNow = () => page.evaluate(() => DigitalTwin.debug().seq);
    const built = (id, after = -1) => page.waitForFunction(([i, a]) => {
      const d = DigitalTwin.debug();
      return d.built && d.stationId === i && d.seq > a && !d.status.endsWith('…') && d.bridges && d.bridges.status !== 'loading'
        && !d.horizon.pending && !!DigitalTwin._reach() && DigitalTwin._reach().status !== 'loading';
    }, [id, after], { timeout: BUILD_TIMEOUT });
    const open = async id => {
      const s = byId(id);
      CUR = { lat: s.lat, lon: s.lon };
      await page.evaluate(() => DigitalTwin._forgetBridges());
      const before = await seqNow();
      await page.evaluate(i => DigitalTwin.openStation(i), id);
      await built(id, before);
      return dbg();
    };
    // Do something that rebuilds the twin, and wait for the build it starts.
    const rebuilt = async (id, fn, arg) => {
      const before = await seqNow();
      await page.evaluate(fn, arg);
      await built(id, before);
      return dbg();
    };
    const text = sel => page.evaluate(s => { const el = document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);

    // ═══════════════════════════════════════════════════════════════════════
    section('The arithmetic of an area');

    const pure = await page.evaluate(() => {
      const T = DigitalTwin;
      const sq = T._areaBox(-27.5, 152.3, { w: 200, e: 200, n: 200, s: 200 }), old = T._patchBox(-27.5, 152.3, 400);
      const rect = T._areaBox(-27.5, 152.3, { w: 200, e: 760, n: 200, s: 200 });
      const wide = T._areaBox(-27.5, 152.3, { w: 1600, e: 1600, n: 1600, s: 1600 });
      return {
        norm: T._normExt({ w: 3.2, e: 99999, n: '250', s: 180.6 }),
        bad: [T._normExt(null), T._normExt({ w: 1, e: 2, n: 3 }), T._normExt({ w: 'x', e: 2, n: 3, s: 4 })],
        long: T._normExt({ w: 6000, e: 6000, n: 200, s: 200 }),
        sq, old, rect, wide, sizes: T._sizes(),
      };
    });
    ok('an area asked for is made one that can be built: whole metres, the station inside it, no edge past the limit',
      J(pure.norm) === J({ w: 20, e: 6380, n: 250, s: 181 }), J(pure.norm));
    ok('…what is not four numbers is no area', pure.bad.every(v => v === null), J(pure.bad));
    ok('…and a side longer than the limit gives way on its far side', pure.long.w + pure.long.e === 6400 && pure.long.n === 200, J(pure.long));
    ok('a plain square is the patch it always was, to the last bit: 201 × 201, the station on the middle sample',
      pure.sq.square && pure.sq.nx === 201 && pure.sq.nz === 201 && pure.sq.ci === 100 && pure.sq.cj === 100 && pure.sq.step === 2
        && ['west', 'east', 'south', 'north', 'size', 'half'].every(k => pure.sq[k] === pure.old[k]), J(pure.sq));
    const r = pure.rect;
    ok('any other shape has square cells that hold what was asked, the station on a sample, and about as many samples as the square has',
      !r.square && near(r.x0, -r.ci * r.step, 1e-9) && near(r.z0, -r.cj * r.step, 1e-9) && r.x0 <= -200 && r.x1 >= 760 && r.z0 <= -200 && r.z1 >= 200
        && r.x1 - 760 < r.step && near(r.x1 - r.x0, (r.nx - 1) * r.step, 1e-9) && near(r.z1 - r.z0, (r.nz - 1) * r.step, 1e-9)
        && r.nx * r.nz > 36000 && r.nx * r.nz < 46000, J(r));
    ok('past 1.6 km a side the ground is sampled 401 a side without being asked', pure.wide.nx === 401 && pure.wide.step === 8 && !pure.wide.square, J({ nx: pure.wide.nx, step: pure.wide.step }));
    ok('the squares offered run to 6.4 km', J(pure.sizes) === J([200, 400, 800, 1600, 3200, 6400]), J(pure.sizes));

    // ═══════════════════════════════════════════════════════════════════════
    section('The square round the station, as ever');

    let d = await open('gatton');
    const gatton = byId('gatton');
    ok('Gatton\'s twin opens on the 400 m square: 201 × 201, 2 m apart, the station in the middle',
      d.size === 400 && d.area.square && d.area.nx === 201 && d.area.nz === 201 && d.area.x0 === -200 && d.area.x1 === 200 && !d.area.custom
        && d.vertices === 201 * 201 && near(d.h0, valley(0, 0), 1e-3), J(d.area));
    const panel = await page.evaluate(() => ({
      options: [...document.querySelectorAll('#twin-size option')].map(o => o.textContent.trim()),
      sides: ['w', 'e', 'n', 's'].map(k => document.getElementById(`twin-side-${k}`).value),
      reset: document.getElementById('twin-area-reset').disabled, draw: document.getElementById('twin-area-draw').disabled,
      note: document.getElementById('twin-area-note').textContent,
    }));
    ok('the Scene panel says so: six squares, 200 m each way, nothing to go back to, and the map to draw on',
      panel.options.length === 6 && J(panel.sides) === J(['200', '200', '200', '200']) && panel.reset && !panel.draw && /400 m square every station gets/.test(panel.note), J(panel));

    // ═══════════════════════════════════════════════════════════════════════
    section('Widen to a bridge');

    const reach = await page.evaluate(() => DigitalTwin._reach());
    ok('the bridge 640–720 m east is offered, with the area that would hold it — the patch as it is, pushed east',
      reach.status === 'ok' && reach.list.length === 1 && reach.list[0].name === 'Eastern Bridge' && near(reach.list[0].d, 682, 6)
        && J(reach.list[0].need) === J({ w: 200, e: 760, n: 200, s: 200 }), J(reach));
    ok('…and the one already whole in the patch is not', d.bridges.list.length === 1, J(d.bridges.list.map(b => b.name)));
    const btn = await text('.twin-reach-btn');
    ok('…as a button that names it and says how far and which way', /Eastern Bridge — 680 m E/.test(btn || ''), btn);

    seen.dem.length = 0;
    d = await rebuilt('gatton', () => document.querySelector('.twin-reach-btn').click());
    const A = d.area;
    ok('one press builds it: the patch runs 200 m west and past 760 m east of the station, and is this station\'s own area now',
      A.custom && !A.square && A.x0 <= -200 && A.x0 > -200 - A.step && A.x1 >= 760 && A.x1 < 760 + A.step && A.z0 <= -200 && A.z1 >= 200
        && J(A.ext) === J({ w: 200, e: 760, n: 200, s: 200 }), J(A));
    ok('…a mesh of its own shape, every sample a vertex', d.vertices === A.nx * A.nz && A.nx > A.nz * 2, `${d.vertices} = ${A.nx} × ${A.nz}`);
    const req = seen.dem.find(q => q.W === A.nx && q.H === A.nz);
    const want = req && {
      west: CUR.lon + (A.x0 - A.step / 2) / M_LON(), east: CUR.lon + (A.x1 + A.step / 2) / M_LON(),
      south: CUR.lat - (A.z1 + A.step / 2) / M_LAT(), north: CUR.lat - (A.z0 - A.step / 2) / M_LAT(),
    };
    ok('the raster asked for is that rectangle grown by half a sample, nx × nz pixels',
      !!req && near(req.bbox[0], want.west, 2e-6) && near(req.bbox[2], want.east, 2e-6) && near(req.bbox[1], want.south, 2e-6) && near(req.bbox[3], want.north, 2e-6),
      J({ req, want }));
    // (Not in the creek itself: it is 8 m wide and the samples here are 3 m
    // apart, so between two of them the twin's ground is a chord across it.)
    const pts = [[0, 0], [-90, 10], [700, 60], [A.x1, A.z1], [A.x0, A.z0], [431.7, -123.4]];
    const got = await page.evaluate(ps => ps.map(([x, z]) => DigitalTwin._heightAt(x, z)), pts);
    ok('every height is the valley\'s where the twin says it is — at the station, west of the creek, at the far bridge, at the corners',
      got.every((h, i) => near(h, valley(pts[i][0], pts[i][1]), 0.06)), pts.map((p, i) => `${p}: ${got[i].toFixed(3)} vs ${valley(p[0], p[1]).toFixed(3)}`).join('; '));
    const mesh = await page.evaluate(() => {
      const g = DigitalTwin.debug().area, T = DigitalTwin._terrainVertex;
      return [0, g.nx - 1, (g.nz - 1) * g.nx, g.nx * g.nz - 1, Math.round(-g.z0 / g.step) * g.nx + Math.round(-g.x0 / g.step)].map(i => T(i));
    });
    ok('the mesh is where the heights are: its corners on the patch\'s corners, and the station\'s own sample at the origin, on the ground',
      near(mesh[0].x, A.x0, 1e-3) && near(mesh[0].z, A.z0, 1e-3) && near(mesh[1].x, A.x1, 1e-3) && near(mesh[2].z, A.z1, 1e-3) && near(mesh[3].x, A.x1, 1e-3)
        && near(mesh[4].x, 0, 1e-4) && near(mesh[4].z, 0, 1e-4) && near(mesh[4].y, 0, 1e-6)
        && mesh.every(v => near(v.y, (valley(v.x, v.z) - d.h0) * d.exag, 0.01)), J(mesh));
    ok('the far bridge is drawn now, whole, beside the near one', d.bridges.list.length === 2 && d.bridges.list.some(b => b.name === 'Eastern Bridge' && !b.cut), J(d.bridges.list.map(b => [b.name, b.cut])));
    const wet = await page.evaluate(() => {
      DigitalTwin.floodAt('minor_m');
      const F = DigitalTwin.debug().flood;
      return { F: F ? { level: F.level, top: F.top } : null, creek: DigitalTwin._floodWet(-30, 100), creekMask: DigitalTwin._floodMaskAt(-30, 100),
               hill: DigitalTwin._floodWet(700, -150), hillMask: DigitalTwin._floodMaskAt(700, -150) };
    });
    ok('the water is laid on this ground, not on a square: the creek under it at the minor flood level, the eastern rise dry — in the fill and in the mask as drawn',
      wet.creek === true && wet.creekMask === true && wet.hill === false && wet.hillMask === false, J(wet));
    const hz = d.horizon;
    const seam = await page.evaluate(() => {
      const d = DigitalTwin.debug(), F = DigitalTwin._ringFrame(), n = 2 * (F.Mx + F.Mz);
      const out = [];
      for (const t of [0, 1, Math.round(F.Mx / 2), F.Mx, F.Mx + 3, F.Mx + F.Mz, n - 1]) {
        const v = d.horizon.vertex(0, t);
        out.push({ t, inner: v.inner, dy: v.y - (DigitalTwin._heightAt(v.x, v.z) - d.h0) * d.exag, x: v.x, z: v.z });
      }
      const back = [[2000, 300], [-900, -1500], [10, 3000], [-250, 20]].map(([x, z]) => {
        const at = DigitalTwin._ringAt(x, z);
        return { x, z, h: at.h, t: at.t };
      });
      return { out, F, n, back, rings: DigitalTwin._ringList().map(r => [r.h, r.Mx, r.Mz, r.w, r.e, r.n, r.s]) };
    });
    ok('the horizon stands round it: three sheets, and its innermost ring is the patch\'s own edge, vertex for vertex',
      hz.up && hz.meshes.length === 3 && seam.out.every(v => v.inner && near(v.dy, 0, 1e-4))
        && near(seam.out[0].x, A.x0, 1e-3) && near(seam.out[0].z, A.z0, 1e-3) && near(seam.out[3].x, A.x1, 1e-3), J(seam.out));
    const rings = seam.rings;
    ok('…each ring out wider on every side than the last, ending square on the first sheet\'s edge',
      rings.every((q, i) => i === 0 || [3, 4, 5, 6].every(k => q[k] > rings[i - 1][k] - 1e-9))
        && rings.some(q => near(q[0], 4000, 1e-6) && [3, 4, 5, 6].every(k => near(q[k], 4000, 1e-6))) && rings[1][1] === 200 && rings[1][2] === 200,
      J(rings.slice(0, 3)));
    ok('…and any point outside the patch is on one ring, further out than the edge', seam.back.every(b => b.h > seam.F.H0 && b.t >= 0 && b.t <= seam.n), J(seam.back));
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('mn-twin')).areas);
    ok('the area is kept for Gatton', J(kept.gatton) === J({ w: 200, e: 760, n: 200, s: 200 }), J(kept));
    const own = await page.evaluate(() => ({ first: document.querySelector('#twin-size option').textContent.trim(), reset: document.getElementById('twin-area-reset').disabled,
                                             e: document.getElementById('twin-side-e').value }));
    ok('…and the panel says it is this station\'s own, 960 × 400 m, with a way back', /This station's own — 960 × 400 m/.test(own.first) && !own.reset && own.e === '760', J(own));
    ok('the status line says the shape built', /\d+ × \d+ m of ground/.test(d.status), d.status);
    const glb = await page.evaluate(async () => {
      const buf = await DigitalTwin.buildGlb(), dv = new DataView(buf), len = dv.getUint32(12, true);
      return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len))).asset.extras.ground.extent_m;
    }).catch(e => ({ error: String(e) }));
    ok('the .glb says where its ground\'s edges are from the origin', glb && near(glb.west, -A.x0, 1e-6) && near(glb.east, A.x1, 1e-6) && near(glb.south, A.z1, 1e-6), J(glb));

    // ═══════════════════════════════════════════════════════════════════════
    section('The four sides, and back to the square');

    d = await rebuilt('gatton', () => { const el = document.getElementById('twin-side-n'); el.value = '600'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    ok('a side typed in is the area: 600 m north now, the other three as they were',
      J(d.area.ext) === J({ w: 200, e: 760, n: 600, s: 200 }) && d.area.z0 <= -600 && d.area.z0 > -600 - d.area.step, J(d.area));
    d = await rebuilt('gatton', () => document.getElementById('twin-area-reset').click());
    ok('Back to the square is the 400 m square again, 201 × 201, and nothing kept for the station',
      d.area.square && d.size === 400 && !d.area.custom && d.vertices === 201 * 201
        && !(await page.evaluate(() => JSON.parse(localStorage.getItem('mn-twin')).areas.gatton)), J(d.area));

    // ═══════════════════════════════════════════════════════════════════════
    section('Wide, and fine');

    d = await rebuilt('gatton', () => DigitalTwin.setSize(3200));
    ok('the 3.2 km square is sampled 401 a side, 8 m apart, round the station', d.size === 3200 && d.area.nx === 401 && d.area.nz === 401 && d.area.step === 8 && d.area.x0 === -1600
      && near(d.h0, valley(0, 0), 1e-3) && d.vertices === 401 * 401, J(d.area));
    ok('…with its horizon, the first sheet still clear of it', d.horizon.up && d.horizon.meshes.length === 3 && near(d.horizon.meshes[0].innerHalf, 1600, 1e-6), J(d.horizon.meshes));
    const fg = await page.evaluate(() => { const g = DigitalTwin._flowGrid(); return { n: g.n, nz: g.nz, step: g.step, x0: g.x0, len: g.elev.length }; });
    ok('the flow line is traced on the same ground, thinned to what a trace needs', fg.len === fg.n * fg.nz && fg.n <= 413 && near(fg.x0, -1600, 1e-9), J(fg));
    d = await rebuilt('gatton', () => DigitalTwin.setSize(400));
    d = await rebuilt('gatton', () => { const el = document.getElementById('twin-detail'); el.value = 'fine'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    ok('Fine samples the 400 m square every metre', d.area.nx === 401 && d.area.step === 1 && d.size === 400 && near(d.h0, valley(0, 0), 1e-3), J(d.area));
    d = await rebuilt('gatton', () => DigitalTwin.setDetail('auto'));
    ok('…and Standard is 201 again', d.area.nx === 201 && d.area.square, J(d.area));

    // ═══════════════════════════════════════════════════════════════════════
    section('Drawn on the map');

    const view0 = await page.evaluate(() => ({ z: state.map.getZoom(), c: state.map.getCenter() }));
    await page.evaluate(() => document.getElementById('twin-area-draw').click());
    const aside = await page.evaluate(() => ({ drawing: MapTwin.drawing(), aside: document.getElementById('map-twin').classList.contains('is-aside'),
      banner: !!document.getElementById('map-twin-draw'), up: MapTwin.active(), zoom: state.map.getZoom() }));
    ok('▭ Draw it on the map puts the twin aside without taking it down, and the map comes back zoomed out under a banner',
      aside.drawing && aside.aside && aside.banner && aside.up && aside.zoom < view0.z, J(aside));
    await page.keyboard.press('Escape');
    const back = await page.evaluate(() => ({ drawing: MapTwin.drawing(), aside: document.getElementById('map-twin').classList.contains('is-aside'),
      banner: !!document.getElementById('map-twin-draw'), up: MapTwin.active(), z: state.map.getZoom(), c: state.map.getCenter() }));
    ok('Escape puts it back as it was: the twin up, the map where it was',
      !back.drawing && !back.aside && !back.banner && back.up && back.z === view0.z && near(back.c.lat, view0.c.lat, 1e-9) && near(back.c.lng, view0.c.lng, 1e-9), J(back));

    await page.evaluate(() => DigitalTwin.drawArea());
    const box = await page.evaluate(() => { const r = state.map.getContainer().getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    // A rectangle that leaves the station out, to the east of it: the area
    // has to be widened back over the station.
    const p0 = { x: box.x + box.w / 2 + 40, y: box.y + box.h / 2 - 90 }, p1 = { x: box.x + box.w / 2 + 260, y: box.y + box.h / 2 + 60 };
    const corners = await page.evaluate(([a, b, r]) => {
      const ll = p => state.map.containerPointToLatLng([p.x - r.x, p.y - r.y]);
      return [ll(a), ll(b)].map(q => DigitalTwin._xzOf(q.lat, q.lng));
    }, [p0, p1, box]);
    const before = await seqNow();
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.mouse.move((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, { steps: 4 });
    await page.mouse.move(p1.x, p1.y, { steps: 4 });
    await page.mouse.up();
    await built('gatton', before);
    d = await dbg();
    const E = d.area.ext;
    const wantE = { w: 20, e: Math.round(Math.max(corners[0].x, corners[1].x)), n: Math.round(-Math.min(corners[0].z, corners[1].z)), s: Math.round(Math.max(corners[0].z, corners[1].z)) };
    ok('a drag on the map is the area — its east, north and south edges where the rectangle\'s were',
      d.area.custom && near(E.e, wantE.e, 3) && near(E.n, wantE.n, 3) && near(E.s, wantE.s, 3), J({ E, wantE, corners }));
    ok('…widened west to hold the station, which the rectangle left out', E.w === 20 && corners[0].x > 0 && d.area.x0 <= -20 && near(d.h0, valley(0, 0), 1e-3), J(E));
    const after = await page.evaluate(() => ({ drawing: MapTwin.drawing(), aside: document.getElementById('map-twin').classList.contains('is-aside'), up: MapTwin.active(), z: state.map.getZoom() }));
    ok('…and the twin is back over the map, built on it', !after.drawing && !after.aside && after.up && after.z === view0.z, J(after));
    d = await rebuilt('gatton', () => DigitalTwin.resetArea());

    // ═══════════════════════════════════════════════════════════════════════
    section('The ground under the pointer');

    const zero = 87.54;   // Gatton's gauge zero, m AHD (stations.json)
    const pr = await page.evaluate(() => DigitalTwin._probe(-30, 0));
    ok('in the creek 30 m west of Gatton: 85.00 m AHD, and −2.54 m on Gatton\'s gauge, whose zero is 87.54 m AHD',
      near(pr.h, 85, 0.01) && near(pr.lgh, 85 - zero, 0.01) && pr.datum.kind === 'station' && pr.datum.id === 'gatton' && near(pr.datum.zero, zero, 1e-9)
        && /85\.00 m AHD/.test(pr.html) && /−2\.54 m LGH/.test(pr.html) && /Gatton's gauge/.test(pr.html) && !pr.far, J(pr));
    const farP = await page.evaluate(() => DigitalTwin._probe(900, 0));
    ok('past the patch\'s edge it is the far ground, and said to be: about, ~30 m data', farP && farP.far && /≈ \d+ m AHD/.test(farP.html) && /far ground/.test(farP.html), J(farP && farP.html));

    await page.evaluate(() => DigitalTwin.topView());
    await page.waitForTimeout(300);
    const cv = await page.evaluate(() => { const r = document.getElementById('twin-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const at = { x: cv.x + cv.w * 0.42, y: cv.y + cv.h * 0.55 };
    await page.mouse.move(at.x - 30, at.y - 30);
    await page.waitForTimeout(120);
    await page.mouse.move(at.x, at.y, { steps: 3 });
    await page.waitForFunction(() => { const el = document.getElementById('twin-probe'); return el && !el.hidden && el.textContent.length > 10; }, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(150);
    const hover = await page.evaluate(([x, y]) => {
      const el = document.getElementById('twin-probe'), hit = DigitalTwin._probeHit(x, y), r = el.getBoundingClientRect(), st = document.getElementById('twin-stage').getBoundingClientRect();
      return { hidden: el.hidden, text: el.textContent, hit, inStage: r.left >= st.left && r.right <= st.right && r.top >= st.top && r.bottom <= st.bottom,
               events: getComputedStyle(el).pointerEvents };
    }, [at.x, at.y]);
    ok('the pointer over the ground has its height beside it, in m AHD and m LGH — the ground a ray from the pointer meets',
      !hover.hidden && hover.hit && !hover.hit.far && hover.text.includes(`${hover.hit.h.toFixed(2)} m AHD`) && hover.text.includes(`${(hover.hit.h - zero < 0 ? '−' : '') + Math.abs(hover.hit.h - zero).toFixed(2)} m LGH`)
        && near(hover.hit.h, valley(hover.hit.x, hover.hit.z), 0.06), J(hover));
    ok('…inside the stage, and it never takes the pointer from the ground', hover.inStage && hover.events === 'none', J({ inStage: hover.inStage, events: hover.events }));
    await page.evaluate(() => { const el = document.getElementById('twin-probe-on'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.mouse.move(at.x + 20, at.y + 10, { steps: 2 });
    await page.waitForTimeout(200);
    ok('the switch puts it away, and is kept', await page.evaluate(() => document.getElementById('twin-probe').hidden && JSON.parse(localStorage.getItem('mn-twin')).probe === false));
    await page.evaluate(() => DigitalTwin.setProbe(true));

    // ═══════════════════════════════════════════════════════════════════════
    section('Whose gauge');

    await page.evaluate(() => MapTwin.openPane());
    await page.waitForSelector('#twin-lgh', { state: 'visible', timeout: 10_000 });
    const lgh0 = await page.evaluate(() => ({ ...DigitalTwin._lgh(), options: [...document.querySelectorAll('#twin-lgh option')].map(o => ({ v: o.value, t: o.textContent.trim(), off: o.disabled, sel: o.selected })),
                                              note: document.getElementById('twin-lgh-note').textContent }));
    ok('Gatton\'s own gauge is the one used, first in the list, with its zero',
      lgh0.value === 'station:gatton' && lgh0.options[0].v === 'station:gatton' && lgh0.options[0].sel && /zero 87\.54 m AHD · this station/.test(lgh0.options[0].t)
        && /0 m LGH is 87\.54 m AHD — Gatton's gauge/.test(lgh0.note), J(lgh0.options.slice(0, 3)));
    ok('…with the gauges near by that have a zero in AHD, the channel bed, and a level to type in',
      lgh0.options.some(o => o.v === 'channel' && !o.off) && lgh0.options.some(o => o.v === 'custom') && lgh0.gauges.every(g => g.own || (g.ok && g.datum === 'AHD' && g.km <= 25)), J(lgh0.options.map(o => o.v)));

    await page.selectOption('#twin-lgh', 'channel');
    let pick = await page.evaluate(() => ({ p: DigitalTwin._probe(-30, 0), l: DigitalTwin._lgh(), kept: JSON.parse(localStorage.getItem('mn-twin')).lgh }));
    // The lowest ground within 60 m: the creek's bed where it has fallen
    // furthest, 50-odd metres south — 85 less 0.002 a metre.
    ok('the channel bed: 0 m is the lowest ground within 60 m of the station, so the creek beside it reads a few centimetres — and it is kept for Gatton',
      pick.l.datum.kind === 'channel' && near(pick.l.datum.zero, 84.9, 0.03) && near(pick.p.lgh, pick.p.h - pick.l.datum.zero, 1e-9) && pick.p.lgh >= 0 && pick.p.lgh < 0.4
        && J(pick.kept.gatton) === J({ kind: 'channel' }), J(pick.l.datum));
    await page.selectOption('#twin-lgh', 'custom');
    await page.fill('#twin-lgh-m', '80');
    await page.keyboard.press('Enter');
    pick = await page.evaluate(() => ({ p: DigitalTwin._probe(-30, 0), l: DigitalTwin._lgh(), kept: JSON.parse(localStorage.getItem('mn-twin')).lgh,
                                       shown: !document.querySelector('.twin-lgh-custom').hidden, note: document.getElementById('twin-lgh-note').textContent }));
    ok('a level typed in: 0 m at 80 m AHD, so the creek reads 5.00',
      pick.l.datum.kind === 'custom' && pick.l.datum.zero === 80 && near(pick.p.lgh, 5, 0.01) && /5\.00 m LGH/.test(pick.p.html) && pick.shown && /80\.00 m AHD/.test(pick.note)
        && J(pick.kept.gatton) === J({ kind: 'custom', m: 80 }), J(pick.l.datum));
    const other = lgh0.gauges.find(g => !g.own);
    if (other) {
      await page.selectOption('#twin-lgh', `station:${other.id}`);
      pick = await page.evaluate(() => ({ p: DigitalTwin._probe(-30, 0), l: DigitalTwin._lgh() }));
      ok(`another gauge near by (${other.id}, zero ${other.zero} m AHD): the creek reads its height on that gauge, and says whose`,
        pick.l.datum.kind === 'station' && pick.l.datum.id === other.id && near(pick.p.lgh, 85 - other.zero, 0.01) && !pick.p.html.includes('Gatton\'s gauge'), J(pick.l.datum));
    } else ok('another gauge near by is offered', false, 'no station within 25 km of Gatton has a gauge zero in AHD in stations.json');
    await page.selectOption('#twin-lgh', 'station:gatton');
    pick = await page.evaluate(() => ({ l: DigitalTwin._lgh(), kept: JSON.parse(localStorage.getItem('mn-twin')).lgh }));
    ok('back to its own gauge, which needs nothing kept', pick.l.datum.id === 'gatton' && !pick.kept.gatton, J(pick.kept));

    // ═══════════════════════════════════════════════════════════════════════
    section('Measuring');

    await page.evaluate(() => { DigitalTwin.topView(); DigitalTwin.setFlood(true); });
    await page.waitForTimeout(300);
    const c1 = { x: cv.x + cv.w * 0.40, y: cv.y + cv.h * 0.50 }, c2 = { x: cv.x + cv.w * 0.62, y: cv.y + cv.h * 0.60 };
    const hits = await page.evaluate(([a, b]) => [DigitalTwin._probeHit(a.x, a.y), DigitalTwin._probeHit(b.x, b.y)], [c1, c2]);
    await page.mouse.click(c1.x, c1.y);
    await page.waitForTimeout(150);
    let M = await page.evaluate(() => ({ m: DigitalTwin._marks(), html: document.getElementById('twin-marks').textContent.replace(/\s+/g, ' '), pick: document.getElementById('twin-pick').textContent }));
    ok('a click on the ground pins A there, a post on the ground with its height, and the pane reads it both ways',
      M.m.list.length === 1 && near(M.m.list[0].x, hits[0].x, 0.5) && near(M.m.list[0].z, hits[0].z, 0.5) && near(M.m.list[0].h, valley(hits[0].x, hits[0].z), 0.06)
        && M.m.drawn.includes('point A') && /A — \d+\.\d\d m AHD, [−\d.]+ m LGH/.test(M.html) && /On Gatton's gauge: [−\d.]+ m LGH/.test(M.pick), `${M.html} | ${M.pick}`);
    await page.waitForTimeout(500);
    await page.mouse.click(c2.x, c2.y);
    await page.waitForTimeout(200);
    M = await page.evaluate(() => ({ m: DigitalTwin._marks(), html: document.getElementById('twin-marks').textContent.replace(/\s+/g, ' '),
                                     svg: !!document.getElementById('twin-sec-svg'), label: (document.getElementById('twin-sec-svg') || { getAttribute() { return ''; } }).getAttribute('aria-label'),
                                     rows: document.querySelectorAll('.twin-sec-table tbody tr').length }));
    const dWant = Math.hypot(hits[1].x - hits[0].x, hits[1].z - hits[0].z), dhWant = valley(hits[1].x, hits[1].z) - valley(hits[0].x, hits[0].z);
    ok('a second pins B: how far apart they are, how much higher or lower B is, and the slope that is',
      M.m.list.length === 2 && near(M.m.measure.d, dWant, 1) && near(M.m.measure.dh, dhWant, 0.1) && M.m.drawn.includes('point B') && M.m.drawn.includes('line A to B')
        && new RegExp(`A → B: ${M.m.measure.d.toFixed(1)} m apart`).test(M.html) && /B is \d+\.\d\d m (lower|higher)/.test(M.html), M.html.slice(0, 260));
    const sec = M.m.section;
    ok('…and the ground cut along the line between them, every point of it the valley\'s, with the same eleven as numbers',
      M.svg && sec.length >= 2 && near(sec[sec.length - 1].s, M.m.measure.d, 1e-6) && sec.every(p => near(p.h, valley(p.x, p.z), 0.06)) && M.rows === 11
        && /The ground from A to B/.test(M.label), M.label);
    await page.evaluate(() => DigitalTwin.setExag(2));
    const lifted = await page.evaluate(() => DigitalTwin._marks().drawn.length);
    await page.evaluate(() => DigitalTwin.setExag(1));
    ok('the posts follow the ground at another exaggeration', lifted >= 3);
    await page.waitForTimeout(500);
    await page.mouse.click(c1.x + 40, c1.y + 30);
    await page.waitForTimeout(150);
    M = await page.evaluate(() => DigitalTwin._marks());
    ok('a third click starts over at A', M.list.length === 1 && M.measure === null);
    await page.evaluate(() => document.getElementById('twin-centre-pin').click());
    M = await page.evaluate(() => ({ m: DigitalTwin._marks(), centre: document.getElementById('twin-centre').textContent }));
    ok('the middle of the view can be pinned without a pointer, and the pane reads the ground under it', M.m.list.length === 2 && /Under the middle of the view: \d+\.\d\d m AHD/.test(M.centre), M.centre);
    await page.evaluate(() => DigitalTwin.clearMarks());
    M = await page.evaluate(() => DigitalTwin._marks());
    ok('Clear the points takes them off the ground', M.list.length === 0 && M.drawn.length === 0);

    // ═══════════════════════════════════════════════════════════════════════
    section('A station with no gauge zero');

    d = await open('babinda_post_office');
    const none = await page.evaluate(() => ({ l: DigitalTwin._lgh(), p: DigitalTwin._probe(5, 5), note: document.getElementById('twin-lgh-note').textContent,
                                              first: document.querySelector('#twin-lgh option').textContent.trim() }));
    ok('no gauge height is made up: the readout is AHD alone, and the panel says why and what can be picked instead',
      none.l.datum.kind === 'none' && none.p.lgh === null && /m AHD/.test(none.p.html) && /no gauge chosen/.test(none.p.html)
        && /has no surveyed gauge zero/.test(none.note) && none.first === 'No gauge chosen', J({ note: none.note, first: none.first }));
    await page.selectOption('#twin-lgh', 'channel');
    const ch = await page.evaluate(() => DigitalTwin._lgh().datum);
    ok('…and the channel bed can still be chosen there', ch.kind === 'channel' && isFinite(ch.zero), J(ch));

    ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`  FAIL the check itself threw: ${err.stack || err}`);
  } finally {
    await browser.close();
    server.close();
  }
}

await main();
console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
