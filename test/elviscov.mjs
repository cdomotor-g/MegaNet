// The Elvis elevation-data coverage overlay (#196).
//
// What this layer is for is the thing worth protecting: every terrain answer in
// the app — the profile card's clearance, ITM's loss, the fade margin on a
// link — is read off ~30 m terrarium tiles, and until this layer there was no
// way to see that the nation holds 1 m LiDAR under half of those paths and
// nothing better than 30 m under the rest. So the checks below are about the
// layer staying *metadata*: it must not fetch when it is off, it must not be
// mistaken for a height source, and its key must be the layer's own colours
// rather than a second list that can drift.
//
// The tiles themselves never arrive. lib/network.mjs aborts everything
// off-origin, which is the right behaviour to test against: what matters is
// which URL the layer *asks* for, and that it asks for none at all while off.
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

const HOST = 's3-ap-southeast-2.amazonaws.com';
const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));

  const asked = [];
  page.on('request', (r) => { if (r.url().includes(HOST)) asked.push(r.url()); });

  await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data,
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000,
    null, { timeout: 30_000 });

  // ── off by default, and silent while off ─────────────────────────────────
  const off = await page.evaluate(() => ({
    state: state.mapElvisCov,
    active: ElvisCoverage.active(),
    note: ElvisCoverage.noteHtml(),
  }));
  check('the layer is off on a cold load', off.state === false);
  check('…and claims no legend key while off', off.active === false);
  check('…and its note says so rather than going quiet', /^Off\./.test(off.note), off.note);
  await page.waitForTimeout(700);
  check('no coverage tile is requested while the layer is off',
    asked.length === 0, `${asked.length} request(s): ${asked.slice(0, 2).join(' ')}`);

  // ── the URL and the zoom ceiling are the measured ones ───────────────────
  const cfg = await page.evaluate(() => ({
    url: ElvisCoverage._url(),
    maxNative: ElvisCoverage._maxNativeZoom(),
    bands: ElvisCoverage._bands(),
  }));
  check('the tile template is the Elvis DEM coverage cache',
    cfg.url.includes(`${'s3-ap-southeast-2'}.amazonaws.com/fsdf-elevation-tile-cache/DEM/`)
    && cfg.url.includes('{z}/{x}/{y}.png'), cfg.url);
  // Measured against the live cache: z11 answers, z12 does not. A ceiling that
  // drifts up turns every close-in view into a wall of 403s.
  check('the zoom ceiling is the cache’s real last zoom', cfg.maxNative === 11,
    String(cfg.maxNative));
  check('the key covers every resolution Elvis publishes', cfg.bands.length === 7,
    `${cfg.bands.length} bands`);

  // ── turning it on ────────────────────────────────────────────────────────
  await page.evaluate(() => ElvisCoverage.setEnabled(true));
  await page.waitForTimeout(900);
  const on = await page.evaluate(() => {
    const pane = state.map.getPane('mnElvisCov');
    return {
      active: ElvisCoverage.active(),
      z: pane ? Number(getComputedStyle(pane).zIndex) : null,
      note: ElvisCoverage.noteHtml(),
      ramp: ElvisCoverage.rampHtml(),
    };
  });
  check('turning it on puts a layer on the map', on.active === true);
  // map-survey.js documents the budget: elevation shading 245, contours 335,
  // rivers 340, survey 345, leader lines 350. Basemap context belongs under
  // every one of those and over the base.
  check('its pane sits above the elevation ramp and under the context lines',
    on.z === 246, String(on.z));
  check('the layer asks the coverage cache for tiles once it is on',
    asked.length > 0 && asked.every(u => u.includes('/fsdf-elevation-tile-cache/DEM/')),
    `${asked.length} request(s)`);

  // The note has to keep saying the layer is not a height source, because that
  // is the single way this feature could mislead somebody.
  check('the note still says profiles read ~30 m terrain',
    /30\s*m/.test(on.note) && /not a source of heights/i.test(on.note), on.note);

  // ── the key is the layer's own colours ───────────────────────────────────
  const missing = cfg.bands.filter(([hex]) => !on.ramp.includes(hex));
  check('every band in the key is drawn with the layer’s own colour',
    missing.length === 0, missing.map(b => b[0]).join(' '));
  check('the key reuses the .elev-ramp strip rather than new markup',
    on.ramp.includes('class="elev-ramp"'));

  // ── the panel and the legend both pick it up ─────────────────────────────
  const ui = await page.evaluate(() => {
    rerenderMapLegend();
    const legend = document.querySelector('.mn-map-legend, #map-legend, .legend')
      || document.body;
    return {
      legend: /Elevation data coverage/i.test(legend.textContent || ''),
      panel: typeof ElvisCoverage.rampHtml() === 'string',
    };
  });
  check('the legend names the layer while it is on', ui.legend === true);

  // ── opacity round-trips and is remembered ────────────────────────────────
  const op = await page.evaluate(() => {
    ElvisCoverage.setOpacity(0.35);
    return { v: ElvisCoverage.opacity(),
             stored: localStorage.getItem('mn-elvis-cov-op') };
  });
  check('opacity round-trips', Math.abs(op.v - 0.35) < 1e-9, String(op.v));
  check('…and is remembered, because it is a preference and not a cost',
    op.stored === '0.35', String(op.stored));

  // ── off again leaves nothing behind ──────────────────────────────────────
  const back = await page.evaluate(() => {
    ElvisCoverage.setEnabled(false);
    return { active: ElvisCoverage.active(),
             pane: !!state.map.getPane('mnElvisCov').childElementCount };
  });
  check('turning it off removes the layer', back.active === false);
  check('…and leaves its pane empty', back.pane === false);

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
console.log('PASS — the coverage layer says where the good elevation data is, stays');
console.log('       quiet while it is off, and never claims to be a height source.');
