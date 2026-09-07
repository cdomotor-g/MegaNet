// The Service Level Specification on a station card (#180).
//
// What is worth asserting, in order of what would actually go wrong:
//
//   * The join. The document pads bureau numbers to six digits and
//     station_number does not, so `40939` and `040939` are the same station and
//     string equality says they are not. 262 of the 1,146 matches depend on
//     that, and BEAUDESERT is one of them — a station whose number is five
//     digits in MegaNet and six in the SLS.
//   * Nothing is invented for a station the document does not carry. 2,030 of
//     MegaNet's stations are not in the SLS and their cards must look exactly
//     as they did before this existed.
//   * Manual is visible. It is the one fact in the block that changes what a
//     person does — a gauge read by hand reports nothing over the radio, so
//     silence from it is not a fault to go chasing — and it has to carry a word
//     and not only a colour.
//   * The numbers on screen are the numbers in the file. A flood class level is
//     read off a gauge board by somebody standing in a river; a transcription
//     error here is not cosmetic.
//
// Run:  npm run sls
//       npm run sls -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import fs from 'node:fs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}

// The file itself is the oracle: every assertion about what the card shows is
// checked against what tools/ingest/sls.py wrote, not against a copy typed here
// that would drift the first time the document is re-ingested.
const doc = JSON.parse(fs.readFileSync(repo('data/sls-locations.json'), 'utf8'));
const byKey = new Map();
for (const l of doc.locations) {
  const k = String(l.bureau_number).replace(/^0+/, '');
  if (k) byKey.set(k, l);
}
const BEAUDESERT = byKey.get('40939');
const ALPHA      = byKey.get('35229');

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });

  // ── The key, before anything that depends on it ──────────────────────────
  const keys = await page.evaluate(() => ({
    padded:   SLS.key('040939'),
    unpadded: SLS.key('40939'),
    sixDigit: SLS.key('540644'),
    spaced:   SLS.key('  040939 '),
    empty:    SLS.key(''),
    zeros:    SLS.key('000000'),
    nullish:  SLS.key(null),
  }));
  check('a padded and an unpadded bureau number are the same key',
    keys.padded === '40939' && keys.unpadded === '40939', JSON.stringify(keys));
  check('a six-digit number that needs no padding is left alone',
    keys.sixDigit === '540644', keys.sixDigit);
  check('an empty, all-zero or absent number is no key at all, never a match',
    keys.empty === null && keys.zeros === null && keys.nullish === null,
    JSON.stringify([keys.empty, keys.zeros, keys.nullish]));

  // ── The file loads, and every location is reachable by its key ────────────
  const loaded = await page.evaluate(async () => {
    await SLS.ensureData();
    return { n: SLS.all().length, version: (SLS.meta() || {}).version, ready: SLS.loaded() };
  });
  check('every location in the file is loaded', loaded.n === doc.locations.length,
    `${loaded.n} of ${doc.locations.length}`);
  check('the card can say which edition it is quoting', loaded.version === doc.meta.version,
    String(loaded.version));

  // ── The join, on a station whose number is padded in the document ─────────
  const beau = await page.evaluate(() => {
    const s = state.data.stations.find((x) => x.id === 'beaudesert_al');
    const l = SLS.forStation(s);
    return { station_number: s.station_number, bureau: l && l.bureau_number,
             name: l && l.name, minor: l && l.class_minor,
             moderate: l && l.class_moderate, major: l && l.class_major,
             prediction: l && l.prediction_type, lead: l && l.lead_time,
             priority: l && l.priority, owner: l && l.owner,
             forecast: !!(l && l.forecast_location) };
  });
  check('a five-digit station number finds its zero-padded SLS row',
    beau.station_number === '40939' && beau.bureau === '040939', JSON.stringify(beau));
  check('the flood class levels are the ones in the file',
    beau.minor === BEAUDESERT.class_minor && beau.moderate === BEAUDESERT.class_moderate
      && beau.major === BEAUDESERT.class_major,
    `${beau.minor}/${beau.moderate}/${beau.major} vs `
      + `${BEAUDESERT.class_minor}/${BEAUDESERT.class_moderate}/${BEAUDESERT.class_major}`);
  check('the prediction type, lead time, priority and owner are the file’s',
    beau.prediction === BEAUDESERT.prediction_type && beau.lead === BEAUDESERT.lead_time
      && beau.priority === BEAUDESERT.priority && beau.owner === BEAUDESERT.owner,
    JSON.stringify(beau));
  check('BEAUDESERT is a forecast location', beau.forecast === true);

  // ── On the card ──────────────────────────────────────────────────────────
  await page.evaluate(() => showStationCard('beaudesert_al'));
  await page.waitForFunction(
    () => { const el = document.getElementById('mn-sls-card-beaudesert_al');
            return el && el.textContent.trim().length > 0; },
    null, { timeout: 20_000 });
  const card = await page.evaluate(() => {
    const el = document.getElementById('mn-sls-card-beaudesert_al');
    return { text: el.textContent.replace(/\s+/g, ' ').trim(),
             manualPills: el.querySelectorAll('.mn-sls-manual').length };
  });
  check('the card names the flood class levels',
    card.text.includes(`minor ${BEAUDESERT.class_minor}`)
      && card.text.includes(`moderate ${BEAUDESERT.class_moderate}`)
      && card.text.includes(`major ${BEAUDESERT.class_major}`),
    card.text.slice(0, 160));
  check('the card says it is a forecast location and how it is forecast',
    /Forecast location/.test(card.text) && card.text.includes(BEAUDESERT.prediction_type)
      && card.text.includes(BEAUDESERT.lead_time), card.text.slice(0, 200));
  check('the card names the owner and the priority',
    card.text.includes(BEAUDESERT.owner) && card.text.includes(BEAUDESERT.priority),
    card.text.slice(0, 200));
  check('an automatic gauge gets no manual pill', card.manualPills === 0);

  // ── A manual gauge says so, in a word and not only a colour ───────────────
  await page.evaluate(() => showStationCard('alpha'));
  await page.waitForTimeout(200);
  const manual = await page.evaluate(() => {
    const el = document.getElementById('mn-sls-card-alpha');
    const pill = el && el.querySelector('.mn-sls-manual');
    return { text: el ? el.textContent.replace(/\s+/g, ' ').trim() : '',
             pill: !!pill, pillText: pill ? pill.textContent.trim() : '',
             title: pill ? pill.getAttribute('title') || '' : '' };
  });
  check('a manual gauge carries the manual pill', manual.pill, manual.text.slice(0, 160));
  check('the pill says "Manual" in words, not only in colour',
    /manual/i.test(manual.pillText), manual.pillText);
  check('the pill explains what manual means for someone chasing silence',
    /telemeter|radio|by hand|person/i.test(manual.title), manual.title.slice(0, 120));
  check('a manual gauge still shows its owner and priority',
    manual.text.includes(ALPHA.owner) && manual.text.includes(ALPHA.priority),
    manual.text.slice(0, 160));

  // ── A station the document does not carry gets nothing invented ───────────
  await page.evaluate(() => showStationCard('abbieglassie_al'));
  await page.waitForTimeout(200);
  const absent = await page.evaluate(() => {
    const el = document.getElementById('mn-sls-card-abbieglassie_al');
    const s = state.data.stations.find((x) => x.id === 'abbieglassie_al');
    return { present: !!el, text: el ? el.textContent.trim() : null,
             lookup: SLS.forStation(s) };
  });
  check('a station the SLS does not carry gets an empty section, not a wrong one',
    absent.present && absent.text === '' && absent.lookup === null,
    JSON.stringify(absent));

  // ── The counts the whole thing rests on ──────────────────────────────────
  const counts = await page.evaluate(() => {
    const all = SLS.all();
    const key = (n) => (String(n || '').trim().replace(/^0+/, '') || null);
    const stations = new Set(state.data.stations.map((s) => key(s.station_number)).filter(Boolean));
    let matched = 0, manual = 0, manualMatched = 0;
    for (const l of all) {
      const inNet = stations.has(key(l.bureau_number));
      if (inNet) matched++;
      if ((l.gauge_type || '').toLowerCase() === 'manual') {
        manual++;
        if (inNet) manualMatched++;
      }
    }
    return { all: all.length, matched, manual, manualMatched };
  });
  check('1,146 of the 2,783 SLS locations are MegaNet stations',
    counts.all === 2783 && counts.matched === 1146, JSON.stringify(counts));
  check('54 of MegaNet’s stations are gauges a person reads',
    counts.manual === 909 && counts.manualMatched === 54, JSON.stringify(counts));

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
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('PASS — the SLS reaches the card it belongs on, and nowhere it does not.');
