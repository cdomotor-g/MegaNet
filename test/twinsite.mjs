// The Digital Twin's site, as the owner asked for it to be built — what
// stands at a station the record cannot vouch for, what else is in the
// patch, the bridge the bare ground drowns, the levels a station without any
// can borrow — and the two things that changed about how the twin is reached
// and read: the Stations map offers it rather than taking the map over, and
// the lines over the stage fold away.
//
// Why a check of its own. `twin` holds the ground, the mesh, the pole, the
// .glb and the hand-over's mechanics; `flood` holds the water. Every item
// here renders a scene that looks entirely plausible when it is wrong: a
// manual gauge drawn as a Type 3 pole, a bridge at the height of the creek
// bed, a neighbour floating a metre over its ground, water drawn from a
// station 40 km away in another catchment without a word — none of it
// throws, and all of it passes both of those.
//
// The world is made here, as `flood` makes its own: Queensland's elevation
// service is answered with a tiled float GeoTIFF of a closed-form valley
// about whichever station is under test (a creek bed at 85 m AHD 30 m west
// of the gauge, running north and south, between banks at 90.5 m); the
// State's imagery with a varied PNG, so the drape and the bridge decks wear
// something; its imagery catalogue with a 10 cm flight dated May 2021; and
// its road network's Bridges layer with one span across that creek 40 m
// south of the gauge. Overpass is left blocked, as the harness leaves it.
//
//   Station models   the manual rain collector (Ø200 mm × 300 mm), the 1 m
//                    staff gauge, both side by side, and the 1 m red post
//                    for a station the record cannot say anything about —
//                    measured off the scene's own bounding box; the Type 3
//                    pole and the tower still where the record is sure.
//   Neighbours       a station 129 m from another is built in its patch, on
//                    the ground where it is, named, and its name on the line
//                    under the stage goes to its own twin.
//   Bridges          Gatton's listed crossing (3.90 m on a gauge whose zero
//                    is 87.54 m AHD) puts the deck of the span nearest the
//                    gauge at 91.44 m AHD, level; a station with no listed
//                    crossing stands the same span at its banks; a road
//                    network that will not answer is said out loud.
//   Borrowed levels  a station with no levels offers the four nearest that
//                    have some, with distance, heights, the datum each
//                    gauge's zero is on, and catchment, and says this
//                    ground's datum and channel; one chosen is drawn over
//                    this channel as gauge heights, the notes, the line and
//                    the Scene panel say whose and every datum crossed
//                    (from, carried, here — all AHD); carried in AHD instead,
//                    no level is called a height on a gauge that is not
//                    here; stopping puts it back. A station whose own classes
//                    are on a State datum is offered its own, and the datums
//                    say that zero is not AHD.
//   The fold         open on arrival, folded after the delay (the check's
//                    seam shortens it), put off while the pointer or the
//                    focus is in it, and left alone once pressed — and the
//                    caveat along the stage's foot, which no fold takes:
//                    everything here is indicative modelling, in red, one
//                    line at every width, a note with the whole of it for a
//                    reader, on the tab and inside the Stations map alike.
//   The offer        zoom 17 on a station offers the twin and names the
//                    flight; nothing is handed over until it is pressed; ←
//                    Map leaves the map at the zoom it was; × puts it away
//                    until the next zoom in; Zoom to station goes all the way.
//
// Needs WebGL2, which Playwright's Chromium has through SwiftShader; skips
// rather than fails if that is ever absent, as twin and map3d do.
//
//   node --run twinsite        (or: npm run twinsite)
//       npm run twinsite -- -v    also print what passed

import fs from 'node:fs';
import vm from 'node:vm';
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STATIONS = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;
const byId = id => STATIONS.find(s => s.id === id);
const byIdLat = id => byId(id).lat, byIdLon = id => byId(id).lon;

// ── the world ────────────────────────────────────────────────────────────────
// About whichever station the twin is being built for (CUR, moved by the
// check): a creek bed at 85 m AHD, 30 m west of the station, running north and
// south between banks at 90.5 m, and the ground rising to the east.
let CUR = { lat: -27.555, lon: 152.275 };
const M_LAT = () => 110574, M_LON = () => 111320 * Math.cos(CUR.lat * Math.PI / 180);
function valley(x, z) {
  let h = 90.5;
  h -= 5.5 * Math.exp(-(((x + 30) / 8) ** 2));
  h += Math.min(10, Math.max(0, (x - 120) * 0.1));
  return h;
}
const groundAt = (lat, lon) => valley((lon - CUR.lon) * M_LON(), -(lat - CUR.lat) * M_LAT());
// A point `x` m east and `z` m south of CUR, as [lon, lat] (ArcGIS order).
const lonLat = (x, z) => [CUR.lon + x / M_LON(), CUR.lat - z / M_LAT()];

// The span across the creek, 40 m south of the gauge, 60 m long.
const BRIDGE = { z: 40, x0: -60, x1: 0 };
let bridgesAnswer = 'span';   // 'span' | 'fail' | 'edge' | 'rail' | 'cut' | 'twin' | 'flaky'
let flakyLeft = 0;

// The flood module, off the page, for the arithmetic the page is held to.
function loadFloodStages() {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(`${fs.readFileSync(repo('flood-velocity.js'), 'utf8')}\n${fs.readFileSync(repo('flood-stages.js'), 'utf8')}\n;this.FloodStages = FloodStages;`, ctx);
  return ctx.FloodStages;
}

function nodeHalf(FS) {
  section('Borrowed levels — the arithmetic, off the page');
  const gleneagle = byId('gleneagle');
  const b = FS.borrowable(gleneagle);
  ok('a station on a State datum still has classes to lend, as heights on its gauge',
    b && b.classes.length === 3 && b.classes[0].h === 4.5 && b.ahdZero === null, J(b && b.classes));
  const L = FS.borrowed(gleneagle, 'gauge', 85, { km: 3.2 });
  ok('laid over a channel at 85 m: minor 89.5, moderate 93.5, major 94 m AHD, and 0 m on the borrowed gauge is the channel',
    L.levels.length === 3 && near(L.levels[0].ahd, 89.5, 1e-9) && near(L.levels[1].ahd, 93.5, 1e-9) && near(L.levels[2].ahd, 94, 1e-9)
      && L.ahdZero === 85 && near(L.top, 94, 1e-9) && L.borrowed.id === 'gleneagle' && L.borrowed.km === 3.2, J(L.levels));
  const gatton = byId('gatton');
  const LG = FS.borrowed(gatton, 'gauge', 85);
  const aep1 = LG.levels.find(l => l.key === 'aep_1_m');
  ok('an AEP level crosses as a gauge height, through the lender\'s AHD zero: Gatton\'s 1% at 102.69 m AHD is 15.15 m over its zero',
    aep1 && near(aep1.gauge, 102.69 - 87.54, 1e-9) && near(aep1.ahd, 85 + 102.69 - 87.54, 1e-9), J(aep1));
  const LA = FS.borrowed(gatton, 'ahd', 85);
  ok('…and in AHD mode the lender\'s own ladder, unchanged', LA.levels.length === FS.ladder(gatton).levels.length
    && near(LA.top, FS.ladder(gatton).top, 1e-9) && LA.borrowed.mode === 'ahd');
  const noAhd = FS.borrowed({ ...gatton, gauge_survey: [] }, 'gauge', 85);
  ok('a lender whose AEP levels cannot come down to its gauge: they are left out, and the notes say so',
    noAhd.levels.every(l => l.kind !== 'aep') && noAhd.notes.some(n => /left out/.test(n)), J(noAhd.notes));
  const withPeaks = { ...gatton, flood_peaks: [{ date: '1974-01-27', height_m: 10, level_m_ahd: 97.54 }, { date: '2011-01-12', height_m: 9, level_m_ahd: 96.54 }, { date: '1893-02-01', height_m: 12 }] };
  const LP = FS.borrowed(withPeaks, 'gauge', 85);
  const pk = LP.levels.filter(l => l.kind === 'peak');
  ok('recorded floods cross too, as gauge heights over the channel, the highest starred, none colouring the water; an unplaced one is left out',
    pk.length === 2 && near(pk.find(l => l.highest).ahd, 85 + 97.54 - 87.54, 1e-9) && pk.every(l => l.rank === null), J(pk));
  ok('a station with only recorded floods still has something to lend', FS.borrowable({ id: 'y', name: 'Old', flood_peaks: [{ date: '1974-01-27', level_m_ahd: 50 }] }) !== null);
  ok('a station with nothing to lend lends nothing', FS.borrowable({ id: 'x', name: 'Nowhere' }) === null);

  // The datums, carried with the ladder and said in words.
  ok('a borrowed ladder is in AHD, and keeps the lender\'s zero and datum with it',
    L.datum === 'AHD' && L.borrowed.datums.zero && L.borrowed.datums.zero.datum === 'STATE' && L.borrowed.datums.channel === 85, J(L.borrowed.datums));
  const wl = FS.datumWords(L, { ground: 'this station\'s ground — Queensland\'s DTM, in AHD' });
  ok('…said: Gleneagle\'s classes are over a zero on the State datum, not AHD — which does not matter laid over a channel, and the water is AHD here',
    /on the State datum — not AHD/.test(wl.from) && /0 m laid on this station's channel at 85\.00 m AHD/.test(wl.carried)
      && /whatever datum its zero is on/.test(wl.carried) && /^Drawn in metres AHD on this station's ground — Queensland's DTM, in AHD\.$/.test(wl.here)
      && wl.brief === 'm AHD, over this channel', J(wl));
  const wg = FS.datumWords(LG, {});
  ok('Gatton\'s, carried on its gauge: its zero is 87.54 m AHD, and its AEP levels come down to the gauge through it',
    /gauge zero of 87\.54 m AHD \(since 1929-09-01\)/.test(wg.from) && /AEP levels are metres AHD/.test(wg.from)
      && /85\.00 \+ h m AHD/.test(wg.carried) && /brought down to gauge heights through its AHD zero/.test(wg.carried), J(wg));
  ok('…carried in AHD: unchanged, the classes through its zero — and its gauge, not being here, names no level',
    LA.ahdZero === null && LA.levels.every(l => l.gauge === null) && LA.levels.find(l => l.key === 'minor_m').lent === 7
      && /unchanged — its classes through its zero \(87\.54 m AHD\)/.test(FS.datumWords(LA).carried) && FS.datumWords(LA).brief === 'm AHD, as lent', J(FS.datumWords(LA)));
  ok('…and a State-datum lender carried in AHD lends no classes, and says why',
    FS.borrowed(gleneagle, 'ahd', 85).levels.length === 0 && /its classes left out, its zero not being AHD/.test(FS.datumWords(FS.borrowed(gleneagle, 'ahd', 85)).carried));
  ok('a station\'s own ladder is not borrowed and has no datum chain to say', FS.datumWords(FS.ladder(gatton)) === null);
}

// ── the page ─────────────────────────────────────────────────────────────────
async function browserHalf() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const seen = { catalog: 0, bridges: 0 };
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
      const body = tiffF32(W, H, extent, (x, y) => groundAt(extent[3] - (y + 0.5) * ph, extent[0] + (x + 0.5) * pw));
      return route.fulfill({ status: 200, contentType: 'image/tiff', body, headers: cors });
    });
    // The photography: anything with variance (a flat sheet reads as "no
    // data here"), which a hilly terrarium tile is.
    await page.route(/LatestStateProgram_AllUsers\/ImageServer\/exportImage/, route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(14, 15000, 9000), headers: cors }));
    await page.route(/LatestStateProgram_AllUsers\/ImageServer\/query/, route => {
      seen.catalog++;
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: J({ features: [
        { attributes: { name: 'Lockyer_Valley_Urban_2021_10cm_SISP', lowps: 0.1, year: 2021, capturestart: Date.UTC(2021, 4, 15), acq_platform: 1 } },
        { attributes: { name: 'SEQ_Regional_2019_20cm_SISP_PeriUrban', lowps: 0.2, year: 2019, capturestart: Date.UTC(2019, 7, 9), acq_platform: 1 } },
        { attributes: { name: 'QSat_2017_240cm_Planet_Q3_v2', lowps: 2.38865713, year: 2017, acq_platform: 2 } },
      ] }) });
    });
    await page.route(/RoadsAndTracks\/MapServer\/22\/query|OtherTransport\/MapServer\/160\/query/, route => {
      seen.bridges++;
      if (bridgesAnswer === 'fail') return route.fulfill({ status: 500, body: 'no', headers: cors });
      const rail = /OtherTransport/.test(route.request().url());
      if (bridgesAnswer === 'flaky' && flakyLeft > 0) { flakyLeft--; return route.fulfill({ status: 500, body: 'busy', headers: cors }); }
      const road = (x0, x1, z) => ({ attributes: { name: null, feature_type: 'Road Bridge', dimension_m: 60 }, geometry: { paths: [[lonLat(x0, z), lonLat(x1, z)]] } });
      const railF = (x0, x1, z) => ({ attributes: { name: null, feature_type: 'Railway Bridge', dimension_m: 60 }, geometry: { paths: [[lonLat(x0, z), lonLat(x1, z)]] } });
      let feats;
      if (bridgesAnswer === 'edge') feats = rail ? [] : [road(-10, 20, -215)];             // wholly past the north edge of 400 m
      else if (bridgesAnswer === 'rail') feats = rail ? [railF(-60, 0, 5)] : [road(BRIDGE.x0, BRIDGE.x1, BRIDGE.z)];   // a railway nearer the gauge than the road
      else if (bridgesAnswer === 'cut') feats = rail ? [] : [road(20, 500, 40)];            // too long to hold, one end in the patch
      else if (bridgesAnswer === 'twin') feats = rail ? [railF(-60, 0, 5), railF(-60, 0, 8.5)] : [];   // one bridge digitised twice
      else feats = rail ? [] : [road(BRIDGE.x0, BRIDGE.x1, BRIDGE.z)];
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: J({ features: feats }) });
    });
    page.on('pageerror', e => errors.push(e.stack || e.message));

    await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
    const gl = await page.evaluate(() => { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); });
    if (!gl) { console.log('\n  SKIP — this Chromium has no WebGL; the twin cannot be exercised here.'); return; }
    // The lines over the stage are left open for every section but the one
    // about them: a check pressing a button in them must not race the fold.
    await page.evaluate(() => DigitalTwin._infoFold(null));

    // `after` is the build sequence the twin was at: a build for the station already
    // on the stage must not be answered with the last one's numbers.
    const built = (id, after = -1) => page.waitForFunction(([i, a, lat]) => {
      const d = DigitalTwin.debug();
      return d.built && d.stationId === i && d.seq > a && (a < 0 || (d.origin && Math.abs(d.origin.lat - lat) < 1e-9)) && !d.status.endsWith('…') && d.bridges && d.bridges.status !== 'loading';
    }, [id, after, CUR.lat], { timeout: BUILD_TIMEOUT });
    const open = async id => {
      const s = byId(id);
      CUR = { lat: s.lat, lon: s.lon };
      await page.evaluate(() => DigitalTwin._forgetBridges());
      const before = await page.evaluate(() => DigitalTwin.debug().seq);
      await page.evaluate(i => { if (state.activeTab === 'twin') DigitalTwin.pick(i); else DigitalTwin.openStation(i); }, id);
      await built(id, before);
      return page.evaluate(() => DigitalTwin.debug());
    };
    const text = sel => page.evaluate(s => { const el = document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);

    // ═══════════════════════════════════════════════════════════════════════
    section('What stands at the station, when the record says — and when it cannot');

    let d = await open('babinda_post_office');
    ok('a manual rainfall station (the SLS: Manual, Rainfall) is the collector: Ø200 mm, 300 mm tall, standing on the ground',
      d.model.structure === 'collector' && d.model.manual && near(d.model.size.x, 0.2, 1e-3) && near(d.model.size.z, 0.2, 1e-3)
        && near(d.model.size.y, 0.3, 1e-3) && near(d.model.size.minY, 0, 1e-3) && d.model.parts.includes('collector body'),
      J({ structure: d.model.structure, size: d.model.size, sls: d.model.sls }));
    ok('…silver, and the notes do not call it anything it is not', !d.notes.some(n => /red post|TM station/.test(n)), J(d.notes));

    d = await open('gatton');
    ok('a manual river station (the SLS: Manual, River) is the staff gauge: 1 m tall, 100 mm wide, white, on the ground',
      d.model.structure === 'staff' && near(d.model.size.y, 1.0, 1e-3) && near(d.model.size.minY, 0, 1e-3)
        && near(d.model.size.x, 0.1, 1e-3) && d.model.parts.includes('gauge board') && d.model.parts.includes('gauge board graduations'),
      J({ structure: d.model.structure, size: d.model.size }));

    d = await open('alpha');
    ok('a manual station that reads both is both, side by side, and the notes say they are often apart on the ground',
      d.model.structure === 'collector+staff' && d.model.parts.includes('collector body') && d.model.parts.includes('gauge board')
        && d.notes.some(n => /side by side/.test(n)), J({ structure: d.model.structure, notes: d.notes }));

    d = await open('doongal_ck_old_g');
    ok('a station the record says nothing about is a red post, 1 m, and the notes say what is not known',
      d.model.structure === 'post' && near(d.model.size.maxY, 1.0375, 1e-3) && d.model.parts.includes('red post')
        && d.notes.some(n => /red post 1 m tall rather than as a guess/.test(n) && /neither what it measures nor whether/.test(n)),
      J({ structure: d.model.structure, size: d.model.size, notes: d.notes }));

    d = await open('abbieglassie_al');
    ok('an ALERT station that reads rainfall is still the Type 3 pole, with its gauge on top',
      d.model.structure === 'pole' && d.model.telemetry === 'alert' && d.model.parts.includes('rain gauge'), J(d.model.structure));
    const kinds = await page.evaluate(() => ['blackstone_br_al', 'doongal_ck_old_g', 'peachester', 'chinchilla_weir_tw']
      .map(id => [id, DigitalTwin._kind(state.data.stations.find(s => s.id === id)).structure]));
    ok('and the rules, station by station: a river AL a tower, an unknowable a post, manual rain a collector, manual river a staff',
      J(kinds) === J([['blackstone_br_al', 'tower'], ['doongal_ck_old_g', 'post'], ['peachester', 'collector'], ['chinchilla_weir_tw', 'staff']]), J(kinds));

    // ═══════════════════════════════════════════════════════════════════════
    section('The other stations in the patch');

    d = await open('beenleigh_al');
    const other = byId('beenleigh');
    const nb = d.neighbours && d.neighbours.list.find(n => n.id === 'beenleigh');
    const want = await page.evaluate(([la, lo]) => DigitalTwin._xzOf(la, lo), [other.lat, other.lon]);
    ok('Beenleigh, 129 m from Beenleigh AL, is built in its patch, where the record puts it',
      !!nb && near(nb.x, want.x, 1e-6) && near(nb.z, want.z, 1e-6) && near(nb.d, 129, 2), J({ nb, want }));
    ok('…standing on the ground there, named over it', nb && near(nb.y, nb.groundY, 1e-6) && nb.signY > nb.y + nb.top && nb.signVisible, J(nb));
    const siteLine = await text('#twin-site');
    ok('…and named on the line under the stage, with its distance', /Also in this patch \(\d+\):/.test(siteLine) && siteLine.includes('Beenleigh') && /\d+ m [NESW]{1,2}/.test(siteLine), siteLine);
    await page.evaluate(() => DigitalTwin.setExag(2));
    await page.waitForTimeout(100);
    const lifted = (await page.evaluate(() => DigitalTwin.debug())).neighbours.list.find(n => n.id === 'beenleigh');
    ok('the exaggeration lifts it with its ground', near(lifted.y, lifted.groundY, 1e-6) && Math.abs(lifted.y - nb.y) > 0 || nb.groundY === 0, J(lifted));
    await page.evaluate(() => DigitalTwin.setExag(1));
    await page.evaluate(() => DigitalTwin.setLabel(false));
    ok('the Name over the pole switch takes its name off too', !(await page.evaluate(() => DigitalTwin.debug())).neighbours.list[0].signVisible);
    await page.evaluate(() => DigitalTwin.setLabel(true));
    CUR = { lat: other.lat, lon: other.lon };
    await page.click('#twin-site button.twin-site-stn:has-text("Beenleigh")');
    await built('beenleigh');
    ok('pressing its name goes to its own twin', (await page.evaluate(() => DigitalTwin.debug().stationId)) === 'beenleigh');

    // ═══════════════════════════════════════════════════════════════════════
    section('The bridge the bare ground drowns');

    d = await open('gatton');
    const B = d.bridges;
    const g = byId('gatton');
    const crossingAhd = 87.54 + 3.9;
    ok('the State\'s road network was asked, and the span across the creek is built: deck, girders, rails, piers',
      seen.bridges > 0 && B.status === 'ok' && B.source === 'qld' && B.list.length === 1
        && ['bridge deck', 'bridge girders', 'bridge rail'].every(m => B.meshes.includes(m)), J({ B, seen }));
    ok('Gatton\'s listed crossing — Smithfield Road Bridge, 3.90 m on a gauge whose zero is 87.54 m AHD — is its deck: 91.44 m AHD, level',
      B.crossing && near(B.crossing.ahd, crossingAhd, 1e-9) && B.list[0].basis === 'crossing'
        && near(B.list[0].deck[0], crossingAhd, 1e-9) && near(B.list[0].deck[1], crossingAhd, 1e-9), J(B.list[0]));
    const bed = await page.evaluate(() => [-32, -31, -30, -29, -28].map(x => [x, DigitalTwin._heightAt(x, 40), DigitalTwin._heightAt(x, 0)]));
    ok('…drawn there: the deck\'s top is 91.44 m AHD on the scene\'s scale, over a bed at 85',
      near(B.deckTop, (crossingAhd - d.h0) * d.exag, 1e-4) && near(B.list[0].under, 85, 1e-3), J({ top: B.deckTop, h0: d.h0, under: B.list[0].under, bed }));
    ok('…wearing the photograph of the road', B.textured === true);
    ok('…and the line under the stage says so', /Bridges \(1\):.*91\.44 m AHD — the crossing height the Bureau lists \(3\.90 m on the gauge\)/.test(await text('#twin-site')), await text('#twin-site'));
    const glb = await page.evaluate(async () => {
      const buf = await DigitalTwin.buildGlb();
      const dv = new DataView(buf);
      const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
      return json.meshes.map(m => m.name);
    });
    ok('the bridge is in the .glb — it is the site — and the station\'s staff with it',
      glb.includes('bridge deck') && glb.includes('bridge girders') && glb.includes('gauge board'), J(glb.filter(n => /bridge|gauge/.test(n))));

    // ── bridges at and past the patch's edge, whose carrier, whose crossing ──
    bridgesAnswer = 'edge';
    d = await open('babinda_post_office');
    ok('a bridge wholly past the 400 m patch\'s edge widens the patch to hold it whole (460 m, 2.3 m samples), and says so',
      d.size === 460 && near(d.sample_m, 2.3, 1e-9) && d.bridges.list.length === 1 && !d.bridges.list[0].cut
        && d.notes.some(n => /patch is 460 m, not the 400 m asked for/.test(n)), J({ size: d.size, B: d.bridges.list, notes: d.notes }));
    ok('…and its deck stands at its banks, a level of 90.5 m over a bank of 90.5 m',
      d.bridges.list[0].basis === 'banks' && near(d.bridges.list[0].deck[0], 90.5, 0.05), J(d.bridges.list[0]));
    const b5 = await page.evaluate(() => DigitalTwin.debug().seq);
    await page.evaluate(() => DigitalTwin.setFitBridges(false));
    await built('babinda_post_office', b5);
    d = await page.evaluate(() => DigitalTwin.debug());
    ok('with the switch off the patch stays 400 m, the bridge is not drawn, and the notes name it past the edge',
      d.size === 400 && d.bridges.list.length === 0 && d.notes.some(n => /past the patch's edge/.test(n)), J({ size: d.size, notes: d.notes }));
    await page.evaluate(() => DigitalTwin.setFitBridges(true));

    bridgesAnswer = 'rail';
    d = await open('gatton');
    const rl = d.bridges.list.find(b => b.kind === 'rail'), rd = d.bridges.list.find(b => b.kind === 'road');
    ok('the listed crossing goes on the road bridge, not the railway nearer the gauge, which stands at its banks',
      rd && rd.basis === 'crossing' && near(rd.deck[0], crossingAhd, 1e-9) && rl && rl.basis === 'banks', J(d.bridges.list));

    bridgesAnswer = 'twin';
    d = await open('babinda_post_office');
    ok('one railway bridge digitised twice is drawn once, wide enough to cover both',
      d.bridges.list.length === 1 && d.bridges.list[0].merged === 1 && d.bridges.list[0].width > 5, J(d.bridges.list));

    bridgesAnswer = 'cut';
    d = await open('babinda_post_office');
    ok('a bridge too long to hold runs out of the patch: level from the bank that is in it (90.5 m), not from the creek bed or the edge',
      d.bridges.list.length === 1 && d.bridges.list[0].basis === 'one bank' && d.bridges.list[0].cut && near(d.bridges.list[0].deck[0], 90.5, 0.05)
        && d.notes.some(n => /past what a patch of up to/.test(n)), J({ B: d.bridges.list, notes: d.notes }));

    bridgesAnswer = 'flaky';
    flakyLeft = 1;
    d = await open('babinda_post_office');
    ok('a State layer that drops one request is asked again: the bridge is drawn and no failure is said',
      d.bridges.list.length === 1 && !d.bridges.failed && !d.notes.some(n => /Neither Queensland/.test(n)), J({ B: d.bridges, notes: d.notes }));

    // A station with no crossing of its own, beside a gauge that has one: the
    // same bridge at the same height.
    bridgesAnswer = 'span';
    const g0 = byId('gatton');
    await page.evaluate(({ lat, lon }) => {
      const st = state.data.stations;
      if (!st.find(s => s.id === 'beside_gatton')) st.push({ id: 'beside_gatton', name: 'Beside Gatton', lat, lon: lon + 100 / (111320 * Math.cos(lat * Math.PI / 180)), roles: ['field'], enabled: true, proposed: true, station_type: 'auto_water_level', alert_ids: {}, sensors: [] });
    }, { lat: g0.lat, lon: g0.lon });
    CUR = { lat: g0.lat, lon: g0.lon + 100 / (111320 * Math.cos(g0.lat * Math.PI / 180)) };
    const b4 = await page.evaluate(() => DigitalTwin.debug().seq);
    await page.evaluate(() => { DigitalTwin._forgetBridges(); DigitalTwin.pick('beside_gatton'); });
    await built('beside_gatton', b4);
    d = await page.evaluate(() => DigitalTwin.debug());
    ok('a proposed station beside Gatton stands the bridge at Gatton\'s listed crossing, 91.44 m AHD, and the line says whose it is',
      d.bridges.list.length === 1 && d.bridges.list[0].basis === 'crossing' && near(d.bridges.list[0].deck[0], crossingAhd, 1e-9)
        && d.bridges.list[0].crossing.from.id === 'gatton' && /lists for Gatton/.test(await text('#twin-site')), J({ B: d.bridges.list, site: await text('#twin-site') }));
    bridgesAnswer = 'span';

    // The State flew this station at 10 cm, and the drape is 0.39 m a pixel.
    await page.waitForFunction(() => { const d = DigitalTwin.debug(); return !!d.sharp && /round the station/.test(d.status); }, null, { timeout: BUILD_TIMEOUT });
    d = await page.evaluate(() => DigitalTwin.debug());
    ok('the State flew 10 cm here and the drape is 0.39 m: a 100 m square round the station is draped again, at 0.098 m a pixel',
      d.sharp && d.sharp.x === 0 && d.sharp.z === 0 && near(d.sharp.mpp, 100 / 1024, 1e-12) && d.sharp.textured && d.sharp.onGround
        && near(d.mpp, 400 / 1024, 1e-12) && d.tier && d.tier.res_m === 0.1, J({ sharp: d.sharp, mpp: d.mpp, tier: d.tier }));
    ok('…and the status line says what was flown, and when', /10 cm imagery \(Lockyer Valley Urban, May 2021\) round the station/.test(d.status), d.status);
    ok('…which is the view, not the site: it is not in the .glb', !glb.includes('sharp imagery'));

    d = await open('babinda_post_office');
    ok('a station with no listed crossing stands the same span at its banks: 90.5 m AHD at both ends',
      d.bridges.list.length === 1 && d.bridges.list[0].basis === 'banks' && near(d.bridges.list[0].deck[0], 90.5, 0.05)
        && near(d.bridges.list[0].deck[1], 90.5, 0.05), J(d.bridges.list[0]));
    ok('…said as the height of its banks', /the height of its banks/.test(await text('#twin-site')), await text('#twin-site'));

    bridgesAnswer = 'fail';
    d = await open('peachester');
    ok('a road network that will not answer, and Overpass blocked: no deck guessed at, and the notes say where the road will be',
      d.bridges.list.length === 0 && d.notes.some(n => /Neither Queensland's road network nor OpenStreetMap/.test(n)), J(d.notes));
    bridgesAnswer = 'span';

    // ═══════════════════════════════════════════════════════════════════════
    section('A station with no levels, and the four nearest that have some');

    d = await open('babinda_post_office');
    ok('no levels of its own: nothing drawn, and the flood line offers the nearest station\'s',
      d.flood && d.flood.none && /none recorded for Babinda Post Office/.test(await text('#twin-flood')), await text('#twin-flood'));
    const pill = await page.evaluate(() => { const el = document.getElementById('twin-flood-pill'); return { hidden: el.hidden, text: el.textContent }; });
    ok('…and so does the pill on the stage — on a phone\'s map, the only place it can', !pill.hidden && /borrow/.test(pill.text), J(pill));
    // The pill, which is where a desktop's map offers it too: the twin is in
    // the Stations map now, where the line under the bar is one line, cut
    // short, and the link at its end is past the cut.
    await page.click('#twin-flood-pill');
    await page.waitForSelector('#app-modal .twin-borrow-table');
    const modal = await page.evaluate(() => [...document.querySelectorAll('#app-modal .twin-borrow-table tbody tr')].map(tr => ({
      name: tr.querySelector('th').textContent.trim(), cells: [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim()) })));
    const donors = await page.evaluate(() => DigitalTwin._donors('babinda_post_office'));
    const kmOf = t => { const m = /([\d.]+) (km|m)/.exec(t); return m ? Number(m[1]) / (m[2] === 'm' ? 1000 : 1) : NaN; };
    ok('the modal lists the four nearest stations with levels, nearest first',
      modal.length === 4 && donors.length === 4 && modal.every((r, i) => r.name.startsWith(byId(donors[i].id).name))
        && modal.every((r, i, a) => !i || kmOf(a[i - 1].cells[0]) <= kmOf(r.cells[0])), J({ modal: modal.map(r => [r.name, r.cells[0]]), donors }));
    ok('…each with its distance and bearing, its flood heights, the datum its gauge is on, and its catchment',
      modal.every(r => /\d.*(km|m) [NESW]{1,2}/.test(r.cells[0]) && /m (on the gauge|AHD)/.test(r.cells[1])
        && /^(Gauge zero -?[\d.]+ m( AHD|, .* — not AHD)|No surveyed gauge zero)/.test(r.cells[2]) && r.cells[3].length > 1), J(modal));
    const here = await page.evaluate(() => document.querySelector('#app-modal .twin-borrow-here').textContent.replace(/\s+/g, ' ').trim());
    ok('…and says this ground\'s datum and its channel, and that every height drawn is AHD',
      /^Datum here: this station's ground — Queensland's DTM, in AHD\. The channel by the gauge — the lowest ground within 60 m — is at 85\.\d\d m AHD\. Every height drawn is in metres AHD\.$/.test(here), here);
    const first = byId(donors[0].id);
    await page.click('#app-modal .twin-borrow-table tbody tr:first-child button');
    await page.waitForFunction(() => { const f = DigitalTwin.debug().flood; return f && !f.none && f.level != null; }, null, { timeout: BUILD_TIMEOUT });
    d = await page.evaluate(() => DigitalTwin.debug());
    const minorH = (first.flood_classes || []).slice().sort((a, b) => (a.as_at < b.as_at ? 1 : -1))[0];
    const seedElev = d.flood.seed.elev;
    ok(`choosing ${first.name} draws its levels over this channel: its minor as ${minorH && minorH.minor_m} m over the bed`,
      d.flood.levels.some(l => l.key === 'minor_m' && near(l.ahd, seedElev + minorH.minor_m, 1e-9)) && near(seedElev, 85, 0.05), J({ levels: d.flood.levels, seedElev }));
    ok('…and says whose, how far, and that it is a guide', d.notes.some(n => n.startsWith(`Flood levels borrowed from ${first.name}`) && /A guide, not a model/.test(n))
      && /borrowed from/.test(await text('#twin-flood')), J(d.notes));
    const chain = d.notes.find(n => n.startsWith('Datums of the borrowed levels — '));
    ok('…and every datum the levels crossed: the lender\'s, how they were carried, and AHD here',
      chain && chain.includes(`${first.name}: `) && /Carried as heights on .*'s gauge, 0 m laid on this station's channel at 85\.\d\d m AHD/.test(chain)
        && /Drawn in metres AHD on this station's ground — Queensland's DTM, in AHD\.$/.test(chain), chain);
    ok('…the line saying it in a word, the whole of it on hover',
      /in m AHD, over this channel/.test(await text('#twin-flood .twin-flood-datum'))
        && (await page.$eval('#twin-flood .twin-flood-datum', el => el.title)).startsWith(`${first.name}: `), await text('#twin-flood'));
    ok('…and the reading saying the water\'s height over this channel, not on a gauge that is not here',
      /m over the channel, \d+\.\d\d m AHD/.test(await text('#twin-flood-now')), await text('#twin-flood'));
    // Carried in AHD instead: the lender's own ladder, no gauge named.
    await page.evaluate(id => DigitalTwin.useFloodFrom(id, 'ahd'), first.id);
    await page.waitForFunction(() => { const f = DigitalTwin.debug().flood; return f && (f.none || f.level != null); }, null, { timeout: BUILD_TIMEOUT });
    d = await page.evaluate(() => DigitalTwin.debug());
    const ahdChain = d.notes.find(n => n.startsWith('Datums of the borrowed levels — '));
    ok('carried in AHD instead: the levels as lent, none called a height on a gauge, and the datums say so',
      ahdChain && /Carried as the same heights in metres AHD, unchanged/.test(ahdChain) && /no level is called a height on the gauge/.test(ahdChain)
        && (d.flood.none || (d.flood.levels.every(l => l.gauge === null) && d.flood.zero === null && !/on the gauge|over the channel/.test(await text('#twin-flood-now')))),
      J({ chain: ahdChain, levels: d.flood.levels, now: await text('#twin-flood') }));
    ok('…and only the new choice\'s notes: the earlier borrowing\'s are gone, the lender\'s own record said as its',
      d.notes.filter(n => n.startsWith('Datums of the borrowed levels')).length === 1 && d.notes.filter(n => n.startsWith('Flood levels borrowed from')).length === 1
        && !d.notes.some(n => /bring them down to heights on the gauge/.test(n))
        && d.notes.filter(n => /flood classes are heights on the gauge|HDB records floods/.test(n)).every(n => n.startsWith(`From ${first.name}'s record: `)), J(d.notes));
    await page.$eval('#twin-flood button[data-flood="unborrow"]', b => b.click());
    d = await page.evaluate(() => DigitalTwin.debug());
    ok('stopping takes the water away and every note it brought with it', d.flood.none && !d.notes.some(n => /borrowed from|Datums of the borrowed/.test(n) || n.includes(first.name)), J(d.notes));

    d = await open('gleneagle');
    await page.evaluate(() => DigitalTwin.borrowFlood());
    await page.waitForSelector('#app-modal .twin-borrow-table');
    const selfRow = await page.evaluate(() => document.querySelector('#app-modal .twin-borrow-table tbody tr th').textContent.trim());
    ok('a station whose classes are on a State datum is offered its own first, over its own channel', /Gleneagle \(its own\)/.test(selfRow), selfRow);
    await page.click('#app-modal .twin-borrow-table tbody tr:first-child button');
    await page.waitForFunction(() => { const f = DigitalTwin.debug().flood; return f && !f.none; }, null, { timeout: BUILD_TIMEOUT });
    d = await page.evaluate(() => DigitalTwin.debug());
    ok('…4.5, 8.5 and 9 m over the bed', J(d.flood.levels.map(l => Number((l.ahd - d.flood.seed.elev).toFixed(6)))) === J([4.5, 8.5, 9]), J(d.flood.levels));
    ok('…and the datums say its zero is on the State datum, not AHD, and the water is AHD here',
      d.notes.some(n => n.startsWith('Datums of the borrowed levels — This station: ') && /State datum — not AHD/.test(n) && /Drawn in metres AHD/.test(n)), J(d.notes));
    await page.evaluate(() => DigitalTwin.stopBorrowingFlood());

    // ═══════════════════════════════════════════════════════════════════════
    section('The lines over the stage fold away');

    // The pointer off the stage and the focus off the page: over the lines
    // or in them, either would put the fold off — which is checked below.
    await page.mouse.move(2, 2);
    await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
    await page.evaluate(() => DigitalTwin._infoFold(1200));
    CUR = { lat: byIdLat('peachester'), lon: byIdLon('peachester') };
    await page.evaluate(() => DigitalTwin.pick('peachester'));
    let info = await page.evaluate(() => DigitalTwin.debug().info);
    ok('open on arrival, with the fold\'s clock running', info.open && info.hidden === false && info.timer, J(info));
    await page.waitForFunction(() => !DigitalTwin.debug().info.open, null, { timeout: 8000 });
    await built('peachester');
    d = await page.evaluate(() => DigitalTwin.debug());
    const btn = await page.evaluate(() => { const b = document.getElementById('twin-info-toggle'); const g = b.querySelector('.twin-info-badge'); return { exp: b.getAttribute('aria-expanded'), badge: g.hidden ? null : g.textContent }; });
    ok('folded after the delay, the button saying so and counting the notes', !d.info.open && d.info.hidden === true && btn.exp === 'false'
      && (d.notes.length ? btn.badge === `⚠ ${d.notes.length}` : btn.badge === null), J({ info: d.info, btn, notes: d.notes.length }));
    // The caveat is not one of the lines: folded, it is still along the foot.
    const caveat = scope => page.evaluate(sc => {
      const p = document.querySelector(`${sc} #twin-caveat`), st = document.querySelector(`${sc} #twin-stage`);
      if (!p || !st) return null;
      const r = p.getBoundingClientRect(), b = st.getBoundingClientRect();
      const cs = getComputedStyle(p);
      const rgb = (cs.color.match(/\d+/g) || []).map(Number);
      return {
        shown: [...p.children].filter(x => !x.classList.contains('sr-only') && x.getClientRects().length).map(x => x.textContent),
        sr: (p.querySelector('.sr-only') || {}).textContent || '', role: p.getAttribute('role'),
        red: rgb.length >= 3 && rgb[0] > 2 * rgb[1] && rgb[0] > 2 * rgb[2],
        inStage: r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top && r.bottom <= b.bottom + 0.5,
        atFoot: Math.abs(r.bottom - b.bottom) <= 2, oneLine: r.height <= 26 && p.scrollHeight <= p.clientHeight + 1,
        pointer: cs.pointerEvents, stageW: Math.round(b.width),
        // The hint above it, not under it.
        hudClear: (() => { const h = document.querySelector(`${sc} #twin-hud`); return !h || h.getBoundingClientRect().bottom <= r.top + 0.5; })(),
      };
    }, scope);
    let cv = await caveat('');
    ok('the caveat stays along the foot of the stage with the lines folded: red, one line, the hint clear above it',
      cv && cv.shown.length === 1 && /^⚠ Indicative modelling only/.test(cv.shown[0]) && cv.red && cv.inStage && cv.atFoot && cv.oneLine && cv.hudClear, J(cv));
    ok('…a note that a reader is read the whole of, and that takes no pointer from the view under it',
      cv.role === 'note' && /Everything in this view is modelled, not surveyed/.test(cv.sr) && /not a flood map or a forecast/.test(cv.sr) && cv.pointer === 'none', J(cv));
    await page.click('#twin-info-toggle');
    await sleep(1600);
    d = await page.evaluate(() => DigitalTwin.debug());
    ok('pressed open, it stays open: the operator has it now', d.info.open && d.info.pinned && !d.info.hidden, J(d.info));
    cv = await caveat('');
    ok('…and the caveat is there with them open as well', cv && cv.shown.length === 1 && cv.atFoot, J(cv));
    // Being read: the focus inside it puts the fold off. The status line is
    // written in place, never re-rendered, so the focus stays where it is put.
    CUR = { lat: byIdLat('babinda_post_office'), lon: byIdLon('babinda_post_office') };
    await page.evaluate(() => {
      DigitalTwin.pick('babinda_post_office');
      const b = document.getElementById('twin-status');
      b.setAttribute('tabindex', '-1');
      b.focus();
    });
    await sleep(2000);
    ok('a new station opens it again, and with the focus in it, the fold waits', (await page.evaluate(() => DigitalTwin.debug().info.open)));
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForFunction(() => !DigitalTwin.debug().info.open, null, { timeout: 8000 });
    ok('…and folds once the focus has gone', true);
    await built('babinda_post_office');
    await page.evaluate(() => DigitalTwin._infoFold(null));

    // ═══════════════════════════════════════════════════════════════════════
    section('At close zoom the map offers the twin, and waits to be asked');

    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
    CUR = { lat: g.lat, lon: g.lon };
    const catalogBefore = seen.catalog;
    await page.evaluate(([id, lat, lon]) => { showStationCard(id); state.map.setView([lat, lon], 17, { animate: false }); }, ['gatton', g.lat, g.lon]);
    await page.waitForFunction(() => { const el = document.getElementById('map-twin-offer'); return el && !el.hidden && /10 cm/.test(el.textContent); }, null, { timeout: LOAD_TIMEOUT });
    const offer = await page.evaluate(() => ({ text: document.getElementById('map-twin-offer').textContent.replace(/\s+/g, ' ').trim(), active: MapTwin.active(), zoom: state.map.getZoom() }));
    ok('zoom 17 on Gatton: a card offers its twin and names the flight over it — and the map is still the map',
      !offer.active && offer.zoom === 17 && /High-resolution imagery here/.test(offer.text)
        && /Aerial photography at 10 cm \(Lockyer Valley Urban, May 2021\) covers Gatton/.test(offer.text)
        // Asked once for the station, by whichever came first — the twin's
        // own sharp drape did, here — and remembered for the session.
        && seen.catalog > 0 && seen.catalog === catalogBefore, J({ offer, seen: seen.catalog, before: catalogBefore }));
    await page.click('#map-twin-offer .map-twin-offer-open');
    await page.waitForFunction(() => MapTwin.active() && DigitalTwin.debug().built, null, { timeout: BUILD_TIMEOUT });
    ok('pressed, the map hands over', await page.evaluate(() => MapTwin.active() && MapTwin.station() === 'gatton' && document.getElementById('map-twin-offer').hidden));
    cv = await caveat('#map-twin');
    ok('…and the twin inside the map carries the caveat along its foot too, in the words its width has room for',
      cv && cv.shown.length === 1 && /^⚠ Indicative modelling only/.test(cv.shown[0]) && cv.red && cv.atFoot && cv.oneLine && cv.inStage, J(cv));
    await page.click('#map-twin .map-twin-back');
    await page.waitForFunction(() => !MapTwin.active(), null, { timeout: 10_000 });
    const back = await page.evaluate(() => ({ zoom: state.map.getZoom(), offer: !document.getElementById('map-twin-offer').hidden }));
    ok('← Map gives the map back at the zoom it was, with the offer on it again', back.zoom === 17 && back.offer, J(back));
    await page.click('#map-twin-offer .map-twin-offer-x');
    ok('× puts it away', await page.evaluate(() => document.getElementById('map-twin-offer').hidden));
    await page.evaluate(([lat, lon]) => state.map.setView([lat, lon], 16, { animate: false }), [g.lat, g.lon]);
    await page.evaluate(([lat, lon]) => state.map.setView([lat, lon], 17, { animate: false }), [g.lat, g.lon]);
    await page.waitForFunction(() => !document.getElementById('map-twin-offer').hidden, null, { timeout: 10_000 });
    ok('…until the map is next zoomed in', true);
    await page.evaluate(() => MapTwin.setEnabled(false));
    ok('the switch in Map display takes the offer off', await page.evaluate(() => document.getElementById('map-twin-offer').hidden && !MapTwin.active()));
    await page.evaluate(() => MapTwin.setEnabled(true));

    await page.evaluate(([lat, lon]) => state.map.setView([lat - 0.3, lon + 0.3], 9, { animate: false }), [g.lat, g.lon]);
    await page.evaluate(() => zoomToStation('gatton'));
    await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: 10_000 });
    const zoomed = await page.evaluate(() => ({ zoom: state.map.getZoom(), max: state.map.getMaxZoom(), c: state.map.getCenter() }));
    ok('Zoom to station goes all the way in, on the station', zoomed.zoom === zoomed.max && near(zoomed.c.lat, g.lat, 1e-6) && near(zoomed.c.lng, g.lon, 1e-6), J(zoomed));

    ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`  FAIL the check itself threw: ${err.stack || err}`);
  } finally {
    await browser.close();
    server.close();
  }
}

nodeHalf(loadFloodStages());
await browserHalf();
console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
