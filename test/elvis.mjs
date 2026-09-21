// Elvis — the ground height at one point, from Geoscience Australia / ICSM (#198).
//
// The service is undocumented and returns everything as prose strings with the
// unit stuck on, including the string "No Data" in every field where it holds
// nothing. So most of what can go wrong here is parsing, and most of the rest
// is a height with the wrong datum on it reaching a card that already carries a
// height with a different one. Both are what these checks are for.
//
// No network: Elvis.seed() replaces the fetch with a function returning a raw
// service response, so the parsing under test is the real parsing. The three
// shapes below were captured from the live service.
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

const HOST = 'api-elevation.fsdf.org.au';
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

  // ── the parser, against the three live shapes ────────────────────────────
  const parsed = await page.evaluate(async () => {
    const SHAPES = {
      lidar: { 'SOURCE': 'QLD Government - https://www.qld.gov.au/',
               'DATASET': 'Brisbane_2014_LGA_SW_502000_6961000_1K_DEM_1m.tif',
               'DEM RESOLUTION': '1m', 'HEIGHT AT LOCATION': '11.94m', 'METADATA URL': '' },
      srtm:  { 'SOURCE': 'Geoscience Australia SRTM - https://ga.gov.au',
               'DATASET': 'srtm-1sec-dem-v1-COG.tif',
               'DEM RESOLUTION': '1 Second', 'HEIGHT AT LOCATION': '172.98m', 'METADATA URL': '' },
      none:  { 'SOURCE': 'No Data', 'DATASET': 'No Data', 'DEM RESOLUTION': 'No Data',
               'HEIGHT AT LOCATION': 'No Data', 'METADATA URL': 'No Data' },
      halfm: { 'SOURCE': 'Griffith Uni - https://www.griffith.edu.au/',
               'DATASET': 'x.tif', 'DEM RESOLUTION': '50cm',
               'HEIGHT AT LOCATION': '-1.5m', 'METADATA URL': '' },
    };
    const out = {};
    for (const [k, v] of Object.entries(SHAPES)) {
      Elvis.seed(() => v);
      out[k] = await Elvis.at(-27.4 - Math.random() / 1e6, 153.0);
    }
    Elvis.seed(null); Elvis.clear();
    out.res = ['1m', '50cm', '2m', '5m', '1 Second', 'No Data', '', null]
      .map(s => Elvis.resolutionMetres(s));
    return out;
  });

  check('a LiDAR answer parses to metres', parsed.lidar.ok
    && Math.abs(parsed.lidar.height_m - 11.94) < 1e-9, JSON.stringify(parsed.lidar));
  check('…and is labelled AHD, which is what makes it comparable',
    parsed.lidar.datum === 'AHD', parsed.lidar.datum);
  check('…and names the resolution and the dataset that answered',
    parsed.lidar.resolution === '1m' && /_1m\.tif$/.test(parsed.lidar.dataset || ''),
    `${parsed.lidar.resolution} / ${parsed.lidar.dataset}`);
  check('…and the source is the agency, not the URL trailing it',
    parsed.lidar.source === 'QLD Government', parsed.lidar.source);
  check('an SRTM answer parses, and reads as ~30 m',
    parsed.srtm.ok && parsed.srtm.resolution_m === 30, JSON.stringify(parsed.srtm));
  // The whole point of the failure path: "No Data" is HTTP 200 with prose in
  // every field. Parsed naively that is NaN metres travelling on as a height.
  check('"No Data" is a failure, not a NaN height',
    parsed.none.ok === false && parsed.none.noData === true, JSON.stringify(parsed.none));
  check('a negative height below the datum survives the parse',
    parsed.halfm.ok && Math.abs(parsed.halfm.height_m + 1.5) < 1e-9,
    JSON.stringify(parsed.halfm));
  check('50 cm reads as half a metre, not fifty',
    parsed.halfm.resolution_m === 0.5, String(parsed.halfm.resolution_m));
  check('every resolution string maps to metres or to nothing',
    JSON.stringify(parsed.res) === JSON.stringify([1, 0.5, 2, 5, 30, null, null, null]),
    JSON.stringify(parsed.res));

  // ── caching and de-duplication ───────────────────────────────────────────
  const calls = await page.evaluate(async () => {
    let n = 0;
    Elvis.clear();
    Elvis.seed(() => { n++; return { 'SOURCE': 'x - y', 'DATASET': 'd.tif',
      'DEM RESOLUTION': '1m', 'HEIGHT AT LOCATION': '5.0m', 'METADATA URL': '' }; });
    await Elvis.at(-27.4, 153.0);
    await Elvis.at(-27.4, 153.0);
    await Elvis.at(-27.4, 153.0);
    const cached = Elvis.cached();
    Elvis.seed(null); Elvis.clear();
    return { n, cached };
  });
  check('the same point is asked once, not once per caller',
    calls.n === 1, `${calls.n} call(s)`);
  check('…and the answer is kept', calls.cached === 1, String(calls.cached));

  // The soft failure that wears a valid answer's clothes. Above ~8 requests in
  // flight the service returns "No Data" for points it holds 1 m LiDAR for:
  // measured 0 of 40 at eight in flight, 9 of 40 at sixteen, every one of which
  // answered properly when asked again alone. A card never goes near that
  // ceiling, but a cached false negative would outlive the load that made it —
  // so "No Data" has to be retried, not kept.
  const nodata = await page.evaluate(async () => {
    Elvis.clear();
    let n = 0;
    const NONE = { 'SOURCE': 'No Data', 'DATASET': 'No Data', 'DEM RESOLUTION': 'No Data',
                   'HEIGHT AT LOCATION': 'No Data', 'METADATA URL': 'No Data' };
    const REAL = { 'SOURCE': 'QLD Government - x', 'DATASET': 'd_1m.tif',
                   'DEM RESOLUTION': '1m', 'HEIGHT AT LOCATION': '7.5m', 'METADATA URL': '' };
    Elvis.seed(() => { n++; return NONE; });
    const first = await Elvis.at(-27.9, 153.9);
    const kept = Elvis.cached();
    Elvis.seed(null); Elvis.clear();
    return { first, kept, n, REAL_unused: !!REAL };
  });
  check('a "No Data" answer is not kept as an answer',
    nodata.first.ok === false && nodata.kept === 0,
    `ok=${nodata.first.ok} cached=${nodata.kept}`);

  // ── nothing is asked of the real service unprompted ──────────────────────
  check('no request reaches the service without a question',
    asked.length === 0, `${asked.length}: ${asked.slice(0, 2).join(' ')}`);

  // ── the What is here card carries it as its own row ──────────────────────
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000,
    null, { timeout: 30_000 });
  const here = await page.evaluate(async () => {
    Elvis.clear();
    Elvis.seed(() => ({ 'SOURCE': 'QLD Government - https://www.qld.gov.au/',
      'DATASET': 'Brisbane_2014_1K_DEM_1m.tif', 'DEM RESOLUTION': '1m',
      'HEIGHT AT LOCATION': '11.94m', 'METADATA URL': '' }));
    MapHere.arm(true);
    MapHere.pick(-27.4698, 153.0251);
    await new Promise(r => setTimeout(r, 900));
    const el = document.getElementById('here-card');
    // Read the rows structurally, not out of the running text: offline the
    // terrain tile cannot arrive, so that row legitimately carries a reason
    // instead of a height. What must hold either way is that it is still
    // *there* and still its own row.
    const rows = [...el.querySelectorAll('.acma-row')].map(r => {
      const sp = r.querySelectorAll('span');
      return { label: (sp[0] ? sp[0].textContent : '').trim(),
               value: (sp[1] ? sp[1].textContent : '').trim() };
    });
    return { text: el ? el.textContent.replace(/\s+/g, ' ') : '', rows };
  });
  check('the card grows an Elvis row', /Ground height \(Elvis\)/.test(here.text), here.text.slice(0, 200));
  check('…showing the height it was given', /11\.9\s*m/.test(here.text), here.text.slice(0, 200));
  check('…labelled AHD', /AHD/.test(here.text));
  // Two models, two rows, side by side — the Elvis row must sit *beside* the
  // terrain one, never in place of it. Where they disagree that is information
  // (a 1 m surface finds a channel floor a 30 m one smooths away), and a card
  // that quietly dropped one would throw that away.
  const terrainRow = here.rows.find(r => r.label === 'Ground height');
  const elvisRow   = here.rows.find(r => r.label === 'Ground height (Elvis)');
  check('…beside the terrain row rather than in place of it',
    !!terrainRow && !!elvisRow, JSON.stringify(here.rows.map(r => r.label)));
  // Offline the tile cannot arrive, so that row carries a reason instead of a
  // height. When it does carry one, it has to keep naming its own datum: two
  // models sharing one datum label on one card would be a lie.
  const hasHeight = !!terrainRow && /\d\s*m\b/.test(terrainRow.value);
  check('…and where the terrain row has a height it still says EGM96',
    !hasHeight || /EGM96/.test(terrainRow.value),
    terrainRow ? terrainRow.value : '(no row)');
  check('…and names the resolution it came off', /1m/.test(here.text));

  // ── the station card fills only where nothing was surveyed ───────────────
  const card = await page.evaluate(async () => {
    Elvis.clear();
    Elvis.seed(() => ({ 'SOURCE': 'QLD Government - https://www.qld.gov.au/',
      'DATASET': 'd_1m.tif', 'DEM RESOLUTION': '1m',
      'HEIGHT AT LOCATION': '123.4m', 'METADATA URL': '' }));
    const pick = p => (state.data.stations || []).find(p);
    const without = pick(s => s.elevation_ahd == null && s.lat != null);
    const with_   = pick(s => s.elevation_ahd != null && s.lat != null);
    const read = async (id) => {
      showStationCard(id);
      await new Promise(r => setTimeout(r, 700));
      const el = document.getElementById('stn-card');
      return el ? el.textContent.replace(/\s+/g, ' ') : '';
    };
    const a = without ? await read(without.id) : '';
    const b = with_   ? await read(with_.id)   : '';
    Elvis.seed(null);
    return { a, b, surveyed: with_ ? with_.elevation_ahd : null };
  });
  check('a station with no surveyed height gets a modelled one',
    /123\.4 m AHD/.test(card.a) && /modelled/.test(card.a), card.a.slice(0, 220));
  // The distinction the row exists to preserve: a mark on the ground and a
  // model of it are different claims, and the card must not let them read alike.
  check('…and it says "modelled", never plain metres',
    /modelled/.test(card.a), card.a.slice(0, 220));
  check('a station that WAS surveyed keeps its own figure and asks nothing',
    card.b.includes(`${card.surveyed} m AHD`) && !/modelled/.test(card.b),
    `${card.surveyed} | ${card.b.slice(0, 200)}`);

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
console.log('PASS — Elvis parses what the service actually returns, says AHD where it');
console.log('       means AHD, and never lets a modelled height read as a surveyed one.');
