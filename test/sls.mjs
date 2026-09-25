// The Service Level Specification on a station card (#180).
//
// What is worth asserting, in order of what would actually go wrong:
//
//   * The join. The document pads bureau numbers to six digits and
//     station_number does not, so `40939` and `040939` are the same station and
//     string equality says they are not. 1,176 of the 2,685 matches depend on
//     that, and BEAUDESERT is one of them — a station whose number is five
//     digits in MegaNet and six in the SLS.
//   * Nothing is invented for a station the document does not carry. 2,188 of
//     MegaNet's stations are not in the SLS and their cards must look exactly
//     as they did before this existed.
//   * Manual is visible. It is the one fact in the block that changes what a
//     person does — a gauge read by hand reports nothing over the radio, so
//     silence from it is not a fault to go chasing — and it has to carry a word
//     and not only a colour.
//   * The numbers on screen are the numbers in the file. A flood class level is
//     read off a gauge board by somebody standing in a river; a transcription
//     error here is not cosmetic. A station with two targets gets a line for
//     each, so neither lead time is read against the other's trigger.
//   * The document is one click away. The section's heading links to the copy
//     the Bureau publishes, says so to someone who cannot see the ↗, and names
//     the edition the figures are from — the link always opens the newest.
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

  // ── The heading is the way to the document ───────────────────────────────
  const head = await page.evaluate(() => {
    const a = document.querySelector('#mn-sls-card-beaudesert_al .stn-card-sls a.mn-sls-doc');
    return a && { href: a.getAttribute('href'), target: a.target, rel: a.rel,
                  text: a.textContent.replace(/\s+/g, ' ').trim(),
                  name: a.getAttribute('aria-label') || '', title: a.title || '',
                  heading: a.closest('.stn-card-sls').firstElementChild.contains(a),
                  docUrl: SLS.DOC_URL };
  });
  const edition = `Flood warning service (SLS v${doc.meta.version})`;
  check('the SLS heading links to the document as the Bureau publishes it',
    !!head && head.href === 'https://www.bom.gov.au/qld/flood/brochures/QLD_SLS_current.pdf'
      && head.href === head.docUrl, JSON.stringify(head));
  check('…in a new tab, without handing it this window',
    !!head && head.target === '_blank' && /\bnoopener\b/.test(head.rel), JSON.stringify(head));
  check('…from the heading itself, which names the edition the card quotes',
    !!head && head.heading && head.text.startsWith(edition), head && head.text);
  check('…its accessible name starting with the words on screen and saying where it goes',
    !!head && head.name.startsWith(edition) && /PDF/.test(head.name) && /new tab/.test(head.name),
    head && head.name);
  check('…and its tooltip naming the edition and its date, with no stray escape in "Bureau\'s"',
    !!head && head.title.includes(`version ${doc.meta.version}`)
      && (!doc.meta.published || head.title.includes(doc.meta.published))
      && head.title.includes('Bureau of Meteorology\'s') && !head.title.includes('\\'),
    head && head.title);

  // ── Two targets are two lines, each lead time beside its own trigger ──────
  // PALMVIEW is warned 6 hours ahead of a peak over 4.5 m and 18 hours ahead of
  // the river passing it. The file keeps the pair apart with " / ".
  const PALMVIEW = byKey.get('540350');
  const parts = (v) => String(v).split(' / ');
  const predictionLines = (id) => page.evaluate((id) => {
    const rows = [...document.querySelectorAll(`#mn-sls-card-${id} .acma-row`)];
    const r = rows.find((x) => x.firstElementChild.textContent.trim() === 'Prediction');
    // Each target is its own line; within one, the card keeps phrases together
    // with no-break spaces, which are still spaces to a reader.
    return r ? r.lastElementChild.innerText.split('\n')
      .map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean) : null;
  }, id);
  const openCard = async (id) => {
    await page.evaluate((id) => showStationCard(id), id);
    await page.waitForFunction((id) => { const el = document.getElementById(`mn-sls-card-${id}`);
      return el && el.textContent.trim().length > 0; }, id, { timeout: 20_000 });
  };
  await openCard('palmview_al');
  const palm = await predictionLines('palmview_al');
  const palmWant = parts(PALMVIEW.lead_time).map((lead, i) =>
    `${PALMVIEW.prediction_type} · ${lead} lead · from ${parts(PALMVIEW.trigger)[i]} · `
    + parts(PALMVIEW.peak_accuracy)[i]);
  check('the file gives PALMVIEW two targets', palmWant.length === 2, PALMVIEW.lead_time);
  check('a station with two targets gets a line for each, its lead time beside its own trigger',
    JSON.stringify(palm) === JSON.stringify(palmWant),
    `${JSON.stringify(palm)} vs ${JSON.stringify(palmWant)}`);

  // ── What the Bureau has not settled reads as such ────────────────────────
  const GLENORE = byKey.get('540149');
  await openCard('glenore_grove_alert');
  const glen = await page.evaluate(() => {
    const el = document.getElementById('mn-sls-card-glenore_grove_alert');
    const note = el.querySelector('.mn-sls-note');
    return { note: note ? note.textContent.replace(/\s+/g, ' ').trim() : '' };
  });
  const glenLines = await predictionLines('glenore_grove_alert');
  check('a service printed as TBC in every column reads "To be confirmed", once',
    GLENORE.prediction_type === 'TBC' && JSON.stringify(glenLines) === '["To be confirmed"]',
    JSON.stringify(glenLines));
  check('the note under it says what the page printed where a priority was expected',
    !!GLENORE.source_note && glen.note.includes(GLENORE.source_note), glen.note);

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
  // 1,146 and 54 until 0032 added the 1,697 stations the Bureau's flood
  // warning indexes list and MegaNet did not have — most of the SLS's manual
  // gauges among them, which are the daily read stations of Section 2 — and
  // then 2,566 of 2,783 and 789 of 909 until the SLS went from version 3.1 to
  // 3.7.
  check('2,685 of the 2,766 SLS locations are MegaNet stations',
    counts.all === 2766 && counts.matched === 2685, JSON.stringify(counts));
  check('796 of MegaNet’s stations are gauges a person reads',
    counts.manual === 865 && counts.manualMatched === 796, JSON.stringify(counts));

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
