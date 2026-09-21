// The second opinion: re-sampling one path against Elvis's 1 m data (#199).
//
// Why this check is worth its runtime. The verdict on the profile card is the
// one number somebody drives out to a site on, and it is computed on ~30 m
// terrarium ground. Thirty-metre sampling does not merely blur a ridge — it
// can miss one, and a knife edge smoothed by ten metres moves the diffraction
// term and can move the verdict. The feature exists to ask a finer model, and
// the thing that could quietly go wrong is the comparison itself.
//
// The trap it is really guarding: if the terrarium side were the card's
// 256-sample run and the Elvis side a 64-sample one, the difference between
// them would be partly the sample count, and the card would report a change of
// verdict that the DEM did not cause. Both sides must be analysed on the same
// points. That is what `sameGrid` below asserts, and it is the reason the
// implementation re-analyses the tiles rather than reusing the answer it has.
//
// The world: flat 200 m ground from the tile server, and an Elvis seed that
// puts a 60 m ridge across the middle of the hop. Flat ground over 10 km is
// comfortably clear; the ridge is not. So a correct implementation has to
// report a changed verdict, and a broken one that quietly compares a path to
// itself cannot.
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { flatTerrariumPng } from './lib/terrarium.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

const HOP = { latA: -27.50, lonA: 152.40, latB: -27.50, lonB: 152.50 };
const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  const tile = flatTerrariumPng(200);
  await page.route(/elevation-tiles-prod\/terrarium\//, route =>
    route.fulfill({ status: 200, contentType: 'image/png', body: tile,
                    headers: { 'Access-Control-Allow-Origin': '*' } }));
  page.on('pageerror', (e) => errors.push(String(e)));
  // Nothing may reach the real service: the seed is the whole point.
  const live = [];
  page.on('request', (r) => { if (r.url().includes('api-elevation.fsdf')) live.push(r.url()); });

  await page.goto(server.origin, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data,
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
    null, { timeout: LOAD_TIMEOUT });

  // ── the path, on flat ground ────────────────────────────────────────────
  await page.evaluate((h) => {
    state.path.cover = false;
    MapDraw.addLine([[h.latA, h.lonA], [h.latB, h.lonB]], [null, null]);
    PathProfile.setOpen(true);
  }, HOP);
  await page.waitForFunction(() => {
    const el = document.querySelector('#path-profile-panel svg');
    return !!el;
  }, null, { timeout: LOAD_TIMEOUT });

  const idle = await page.evaluate(() => PathProfile.elvisState());
  check('the second opinion is not fetched with the profile',
    idle.status === 'idle' && idle.res === null, JSON.stringify(idle));
  const panelText = await page.evaluate(
    () => document.getElementById('path-profile-panel').textContent);
  check('…and the card offers it as a button',
    /Check this path against 1 m data/.test(panelText), panelText.slice(0, 120));

  // ── a ridge only Elvis can see ──────────────────────────────────────────
  const ran = await page.evaluate(async (h) => {
    // 200 m at the ends, +60 m across the middle third — a ridge the flat tile
    // knows nothing about.
    Elvis.clear();
    Elvis.seed((lat, lon) => {
      const t = (lon - h.lonA) / (h.lonB - h.lonA);
      const ridge = t > 0.35 && t < 0.65 ? 60 : 0;
      return { 'SOURCE': 'QLD Government - x', 'DATASET': 'd_1m.tif',
               'DEM RESOLUTION': '1m',
               'HEIGHT AT LOCATION': `${(200 + ridge).toFixed(2)}m`, 'METADATA URL': '' };
    });
    PathProfile.askElvis();
    for (let i = 0; i < 100; i++) {
      const s = PathProfile.elvisState();
      if (s.status === 'ready' || s.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }
    const s = PathProfile.elvisState();
    return {
      status: s.status, error: s.error,
      asked: s.res && s.res.asked, got: s.res && s.res.got,
      changed: s.res && s.res.changed,
      base: s.res && s.res.base.verdict,
      alt: s.res && s.res.alt.verdict,
      worstD: s.res && s.res.worstD,
      basePts: s.res && s.res.base.pts.length,
      altPts: s.res && s.res.alt.pts.length,
      text: document.getElementById('path-profile-panel').textContent.replace(/\s+/g, ' '),
    };
  }, HOP);

  check('asking runs the comparison', ran.status === 'ready', `${ran.status} ${ran.error || ''}`);
  check('…over the sample budget, not the whole profile',
    ran.asked === 64, String(ran.asked));
  check('…and every point answered', ran.got === ran.asked, `${ran.got}/${ran.asked}`);

  // THE point of the check: both sides analysed on the same points, so the
  // difference reported is the elevation model and not the sample count.
  const sameGrid = ran.basePts === ran.altPts;
  check('both models are analysed on the same grid',
    sameGrid, `tiles ${ran.basePts} pts, elvis ${ran.altPts} pts`);

  // Flat 200 m ground over 10 km is *not* "clear": at these antenna heights the
  // earth bulge alone has already eaten into the first Fresnel zone, so the
  // card says marginal. That is the physics doing its job, and it is the right
  // baseline to compare against — what matters is that the ridge makes it
  // strictly worse, not which label the flat case happens to carry.
  const RANK = { clear: 0, marginal: 1, obstructed: 2 };
  check('flat tiles do not call the hop obstructed',
    ran.base !== 'obstructed', String(ran.base));
  check('…and the ridge Elvis sees makes it strictly worse',
    RANK[ran.alt] > RANK[ran.base], `${ran.base} -> ${ran.alt}`);
  check('…so the card reports the verdict changing',
    ran.changed === true && /verdict changes/i.test(ran.text), String(ran.changed));
  check('…and names the worst ground disagreement',
    Math.abs(ran.worstD - 60) < 1.5 && /Worst ground disagreement/.test(ran.text),
    String(ran.worstD));
  // The note that stops the two verdicts on the card being read as a
  // contradiction: the one at the top is the full 256-point run.
  check('…and says the figures are re-analysed on those points',
    /elevation model and not the sampling/i.test(ran.text));

  // ── ground Elvis agrees about must NOT change the verdict ───────────────
  const agree = await page.evaluate(async () => {
    Elvis.clear();
    Elvis.seed(() => ({ 'SOURCE': 'x - y', 'DATASET': 'd_1m.tif', 'DEM RESOLUTION': '1m',
                        'HEIGHT AT LOCATION': '200.00m', 'METADATA URL': '' }));
    PathProfile.askElvis();
    for (let i = 0; i < 100; i++) {
      const s = PathProfile.elvisState();
      if (s.status === 'ready' || s.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }
    const s = PathProfile.elvisState();
    return { changed: s.res && s.res.changed, base: s.res && s.res.base.verdict,
             alt: s.res && s.res.alt.verdict, worstD: s.res && s.res.worstD,
             text: document.getElementById('path-profile-panel').textContent.replace(/\s+/g, ' ') };
  });
  check('ground both models agree about leaves the verdict alone',
    agree.changed === false && agree.base === agree.alt,
    `${agree.base} vs ${agree.alt}`);
  check('…and the card says the verdict holds', /verdict holds/i.test(agree.text));
  check('…with no ground disagreement to report',
    Math.abs(agree.worstD) < 0.01, String(agree.worstD));

  // ── a point Elvis cannot answer keeps the tile height ───────────────────
  // A null in terrain_m reads downstream as missing ground, and a gap in the
  // middle of a path reads as a clear one — the one wrong answer that costs a
  // site visit. So an unanswered point falls back rather than punching a hole.
  const holes = await page.evaluate(async () => {
    Elvis.clear();
    let n = 0;
    Elvis.seed(() => {
      n++;
      if (n % 3 === 0) {
        return { 'SOURCE': 'No Data', 'DATASET': 'No Data', 'DEM RESOLUTION': 'No Data',
                 'HEIGHT AT LOCATION': 'No Data', 'METADATA URL': 'No Data' };
      }
      return { 'SOURCE': 'x - y', 'DATASET': 'd_1m.tif', 'DEM RESOLUTION': '1m',
               'HEIGHT AT LOCATION': '210.00m', 'METADATA URL': '' };
    });
    PathProfile.askElvis();
    for (let i = 0; i < 120; i++) {
      const s = PathProfile.elvisState();
      if (s.status === 'ready' || s.status === 'failed') break;
      await new Promise(r => setTimeout(r, 100));
    }
    const s = PathProfile.elvisState();
    Elvis.seed(null);
    return { status: s.status, got: s.res && s.res.got, asked: s.res && s.res.asked,
             nulls: s.res ? s.res.heights.filter(h => h == null).length : -1,
             min: s.res ? Math.min(...s.res.heights) : null,
             text: document.getElementById('path-profile-panel').textContent.replace(/\s+/g, ' ') };
  });
  check('some points went unanswered', holes.status === 'ready'
    && holes.got < holes.asked, `${holes.got}/${holes.asked}`);
  check('…and none of them became a hole in the ground',
    holes.nulls === 0 && holes.min >= 200, `${holes.nulls} null(s), min ${holes.min}`);
  check('…and the card says how many kept the tile height',
    /kept the tile height/.test(holes.text));

  check('nothing reached the live service', live.length === 0, live.slice(0, 2).join(' '));
  check('no pageerror', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `\n      ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('PASS — the second opinion compares two elevation models on one grid, so a');
console.log('       changed verdict is the terrain talking and not the sample count.');
