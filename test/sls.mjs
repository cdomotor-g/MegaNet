// The Service Level Specifications on a station card (#180) — Queensland's and,
// since 0038, the one for New South Wales and the ACT.
//
// What is worth asserting, in order of what would actually go wrong:
//
//   * The join. The file pads bureau numbers to six digits and station_number
//     does not, so `40939` and `040939` are the same station and string
//     equality says they are not. 1,474 of the 3,253 stations found depend on
//     that, and BEAUDESERT is one of them — a station whose number is five
//     digits in MegaNet and six in the SLS.
//   * Nothing is invented for a station neither document carries. 1,620 of
//     MegaNet's stations are in neither and their cards must look exactly as
//     they did before this existed.
//   * Each document speaks for itself. A station both list (GOONDIWINDI) gets a
//     section from each, under its own heading and link, with its own figures
//     — they do not agree, and neither is allowed to overwrite the other.
//   * What the NSW document says that Queensland's does not reaches the card:
//     the gauge's datum (AHD levels say "m AHD"), its AWRC number, a class the
//     SES has not defined yet said in words, two owners, the small-catchment
//     and interim-service marks.
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
// One document's entry for one number: a station on the border is in both.
const byKey = new Map();
for (const l of doc.locations) {
  const k = String(l.bureau_number).replace(/^0+/, '');
  if (k) byKey.set(`${l.jurisdiction}:${k}`, l);
}
const qld = (n) => byKey.get(`QLD:${n}`);
const nsw = (n) => byKey.get(`NSW:${n}`);
const BEAUDESERT = qld('40939');
const ALPHA      = qld('35229');

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
    const docs = SLS.documents() || {};
    return { n: SLS.all().length, qld: (docs.QLD || {}).version, nsw: (docs.NSW || {}).version,
             ready: SLS.loaded() };
  });
  check('every location in the file is loaded', loaded.n === doc.locations.length,
    `${loaded.n} of ${doc.locations.length}`);
  check('the card can say which edition of each document it is quoting',
    loaded.qld === doc.documents.QLD.version && loaded.nsw === doc.documents.NSW.version,
    JSON.stringify(loaded));

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

  // ── The owner, first on the card and always there ────────────────────────
  // The station's own owner where it has one; else the SLS's, marked so;
  // else "Not recorded" — never "unknown".
  const owners = await page.evaluate(async () => {
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const first = async (id) => {
      showStationCard(id);
      await frame();
      const row = document.querySelector('#stn-card .acma-sect .acma-row');
      const [k, v] = row ? [...row.children].map(c => c.textContent.replace(/\s+/g, ' ').trim()) : [];
      return { id, k, v };
    };
    const st = state.data.stations;
    const own = st.find(s => s.owner && String(s.owner).trim());
    const none = st.find(s => !s.owner && s.lat != null && !(SLS.forStation(s) || {}).owner);
    return { sls: await first('beaudesert_al'), own: own ? await first(own.id) : null, ownName: own && own.owner,
             none: none ? await first(none.id) : null };
  });
  check('the card\'s first row is its owner, from the SLS and marked so where the station records none',
    owners.sls.k === 'Owner' && owners.sls.v.includes(BEAUDESERT.owner.replace(/^Bureau$/, 'Bureau of Meteorology'))
      && /per SLS/.test(owners.sls.v), JSON.stringify(owners.sls));
  check('…the station\'s own owner where it records one, not marked',
    owners.own && owners.own.k === 'Owner' && owners.own.v === owners.ownName, JSON.stringify(owners.own));
  check('…and "Not recorded" where nobody is on record — the row is still there',
    owners.none && owners.none.k === 'Owner' && owners.none.v === 'Not recorded', JSON.stringify(owners.none));
  await page.evaluate(() => showStationCard('beaudesert_al'));

  // ── The heading is the way to the document ───────────────────────────────
  const head = await page.evaluate(() => {
    const a = document.querySelector('#mn-sls-card-beaudesert_al .stn-card-sls a.mn-sls-doc');
    return a && { href: a.getAttribute('href'), target: a.target, rel: a.rel,
                  text: a.textContent.replace(/\s+/g, ' ').trim(),
                  name: a.getAttribute('aria-label') || '', title: a.title || '',
                  heading: a.closest('.stn-card-sls').firstElementChild.contains(a),
                  docUrl: SLS.DOCS.QLD.url };
  });
  const edition = `Flood warning service (QLD SLS v${doc.documents.QLD.version})`;
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
    !!head && head.title.includes(`version ${doc.documents.QLD.version}`)
      && (!doc.documents.QLD.published || head.title.includes(doc.documents.QLD.published))
      && head.title.includes('Bureau of Meteorology\'s') && !head.title.includes('\\'),
    head && head.title);

  // ── Two targets are two lines, each lead time beside its own trigger ──────
  // PALMVIEW is warned 6 hours ahead of a peak over 4.5 m and 18 hours ahead of
  // the river passing it. The file keeps the pair apart with " / ".
  const PALMVIEW = qld('540350');
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
  const GLENORE = qld('540149');
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
  check('a station neither SLS carries gets an empty section, not a wrong one',
    absent.present && absent.text === '' && absent.lookup === null,
    JSON.stringify(absent));

  // ── New South Wales and the ACT ──────────────────────────────────────────
  // The NSW document's own entries, on stations that are only in it. Every
  // figure is checked against the file, as above.
  const sections = (id) => page.evaluate((id) => [...document.querySelectorAll(
    `#mn-sls-card-${id} .stn-card-sls`)].map((el) => {
    const a = el.querySelector('a.mn-sls-doc');
    const rows = {};
    for (const r of el.querySelectorAll('.acma-row')) {
      rows[r.firstElementChild.textContent.trim()] = r.lastElementChild.innerText
        .split('\n').map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    }
    return { jurisdiction: el.dataset.jurisdiction, href: a && a.getAttribute('href'),
             label: a ? a.textContent.replace(/\s+/g, ' ').trim() : '',
             name: a ? a.getAttribute('aria-label') || '' : '', title: a ? a.title : '',
             text: el.textContent.replace(/\s+/g, ' ').trim(), rows,
             manualPill: !!el.querySelector('.mn-sls-manual'),
             marks: [...el.querySelectorAll('.mn-sls-mark')].map((m) => ({
               text: m.textContent.replace(/\s+/g, ' ').trim(), title: m.title })) };
  }), id);
  const NSWDOC = doc.documents.NSW;
  const nswEdition = `Flood warning service (NSW SLS v${NSWDOC.version})`;

  const LISMORE = nsw('58176');
  await openCard('lismore_wilsons_river');
  const lis = await sections('lismore_wilsons_river');
  check('a station only the NSW document lists gets one section, and it is the NSW one',
    lis.length === 1 && lis[0].jurisdiction === 'NSW', JSON.stringify(lis.map((x) => x.jurisdiction)));
  check('…whose heading opens the Bureau\'s copy of the NSW document and names its edition',
    lis[0].href === 'https://www.bom.gov.au/nsw/NSW_SLS_Current.pdf' && lis[0].href === NSWDOC.url
      && lis[0].label.startsWith(nswEdition) && lis[0].name.startsWith(nswEdition)
      && /New South Wales and the Australian Capital Territory/.test(lis[0].name)
      && lis[0].title.includes(`version ${NSWDOC.version}`) && lis[0].title.includes(NSWDOC.published),
    JSON.stringify({ href: lis[0].href, label: lis[0].label, title: lis[0].title }));
  check('an AHD gauge\'s flood classes are the file\'s, in metres AHD',
    JSON.stringify(lis[0].rows['Flood classes'])
      === JSON.stringify([`minor ${LISMORE.class_minor} · moderate ${LISMORE.class_moderate} · major ${LISMORE.class_major} m AHD`]),
    JSON.stringify(lis[0].rows['Flood classes']));
  check('…with the gauge datum, the AWRC number and the owner beside them',
    LISMORE.gauge_datum === 'AHD' && JSON.stringify(lis[0].rows['Gauge datum']) === '["AHD"]'
      && JSON.stringify(lis[0].rows['AWRC number']) === JSON.stringify([LISMORE.awrc_number])
      && JSON.stringify(lis[0].rows['Station owner']) === JSON.stringify([LISMORE.owner]),
    JSON.stringify(lis[0].rows));
  check('…and its forecast service: type, lead time, trigger and accuracy',
    JSON.stringify(lis[0].rows.Prediction) === JSON.stringify([
      `${LISMORE.prediction_type} · ${LISMORE.lead_time} lead · from ${LISMORE.trigger} · ${LISMORE.peak_accuracy}`]),
    JSON.stringify(lis[0].rows.Prediction));

  // NSW stacks a second target, and a second owner, inside one cell.
  const MURW = nsw('58186');
  await openCard('north_murwillumbah_tweed_river');
  const murw = (await sections('north_murwillumbah_tweed_river'))[0];
  const murwWant = parts(MURW.lead_time).map((lead, i) =>
    `${MURW.prediction_type} · ${lead} lead · from ${parts(MURW.trigger)[i]} · ${MURW.peak_accuracy}`);
  check('the NSW file gives NORTH MURWILLUMBAH two targets and two owners',
    murwWant.length === 2 && MURW.owner === 'Tweed Shire Council / NSW DCCEEW', `${MURW.lead_time} | ${MURW.owner}`);
  check('…and the card gives each target its own line, and names both owners',
    JSON.stringify(murw.rows.Prediction) === JSON.stringify(murwWant)
      && JSON.stringify(murw.rows['Station owner']) === JSON.stringify([MURW.owner]),
    JSON.stringify(murw.rows));

  // "n/a" is a class the NSW SES has not defined yet: said, not dropped.
  const REPTON = nsw('559024');
  await openCard('repton_bellinger_ri');
  const rep = (await sections('repton_bellinger_ri'))[0];
  check('a class the NSW SES has not defined is said in words, after the ones it has',
    JSON.stringify(REPTON.classes_undefined) === '["moderate"]'
      && JSON.stringify(rep.rows['Flood classes'])
        === JSON.stringify([`minor ${REPTON.class_minor} · major ${REPTON.class_major} m AHD · moderate not yet defined`]),
    JSON.stringify(rep.rows['Flood classes']));
  check('…and that is not called an irregularity', !/irregular/.test(rep.text), rep.text.slice(-120));

  // The page's marks, in words, with what the document says they mean.
  await openCard('billinudgel_marshal');
  const bil = (await sections('billinudgel_marshal'))[0];
  check('a location the document marks ^ says "small catchment, fast response", and why',
    nsw('558020').fast_response === true && bil.marks.length === 1
      && bil.marks[0].text === 'small catchment, fast response' && /faster response/.test(bil.marks[0].title)
      && /^Forecast location · small catchment, fast response$/.test((bil.rows.Role || [])[0] || ''),
    JSON.stringify({ role: bil.rows.Role, marks: bil.marks }));
  await openCard('byrnes_point');
  const bal = (await sections('byrnes_point'))[0];
  check('a service the document marks * (BALLINA) says it is interim, with no set lead time',
    nsw('558044').interim_service === true && nsw('558044').lead_time === 'TBC'
      && bal.marks.some((m) => /^Interim service/.test(m.text) && /no determined lead time/.test(m.title)),
    JSON.stringify({ prediction: bal.rows.Prediction, marks: bal.marks }));

  await openCard('copmanhurst_clarenc');
  const cop = (await sections('copmanhurst_clarenc'))[0];
  check('an NSW gauge a person reads carries the manual pill too',
    nsw('58181').gauge_type === 'Manual' && cop.manualPill, cop.text.slice(0, 120));

  // ── A station both documents list ────────────────────────────────────────
  // GOONDIWINDI is a forecast location in both, and the two disagree about its
  // levels. Both are shown, each with its own heading, link and figures.
  const GQ = qld('41500'), GN = nsw('41500');
  await openCard('goondiwindi_tm');
  const goon = await sections('goondiwindi_tm');
  check('the documents disagree about GOONDIWINDI',
    GQ && GN && GQ.class_major !== GN.class_major, `${GQ && GQ.class_major} vs ${GN && GN.class_major}`);
  check('…so its card has a section from each, Queensland\'s first',
    goon.length === 2 && goon[0].jurisdiction === 'QLD' && goon[1].jurisdiction === 'NSW',
    JSON.stringify(goon.map((x) => x.jurisdiction)));
  check('…each under its own document\'s heading and link',
    goon[0].href === doc.documents.QLD.url && goon[1].href === NSWDOC.url
      && goon[0].label.startsWith('Flood warning service (QLD SLS') && goon[1].label.startsWith(nswEdition),
    JSON.stringify(goon.map((x) => [x.href, x.label])));
  check('…and each with its own flood classes, neither overwritten',
    goon[0].text.includes(`major ${GQ.class_major}`) && !goon[0].text.includes(`major ${GN.class_major}`)
      && goon[1].text.includes(`major ${GN.class_major}`) && !goon[1].text.includes(`major ${GQ.class_major}`),
    JSON.stringify(goon.map((x) => x.rows['Flood classes'])));
  const goonOne = await page.evaluate(() => {
    const l = SLS.forStation(state.data.stations.find((x) => x.id === 'goondiwindi_tm'));
    return l && l.jurisdiction;
  });
  check('…and asked for one answer, the lookup gives Queensland\'s, as the card puts first',
    goonOne === 'QLD', String(goonOne));

  // ── The counts the whole thing rests on ──────────────────────────────────
  const counts = await page.evaluate(() => {
    const all = SLS.all();
    const key = (n) => (String(n || '').trim().replace(/^0+/, '') || null);
    const stations = new Set(state.data.stations.map((s) => key(s.station_number)).filter(Boolean));
    const by = {};
    const withAny = new Set();
    for (const l of all) {
      const c = by[l.jurisdiction] || (by[l.jurisdiction] = { all: 0, matched: 0, manual: 0, manualMatched: 0 });
      const inNet = stations.has(key(l.bureau_number));
      c.all++;
      if (inNet) { c.matched++; withAny.add(key(l.bureau_number)); }
      if ((l.gauge_type || '').toLowerCase() === 'manual') {
        c.manual++;
        if (inNet) c.manualMatched++;
      }
    }
    const both = [...withAny].filter((k) => SLS.entriesFor({ station_number: k }).length === 2).length;
    return { ...by, stations: withAny.size, both };
  });
  // Queensland's: 1,146 and 54 until 0032 added the 1,697 stations the
  // Bureau's flood warning indexes list and MegaNet did not have — most of the
  // SLS's manual gauges among them, which are the daily read stations of
  // Section 2 — and then 2,566 of 2,783 and 789 of 909 until the SLS went from
  // version 3.1 to 3.7.
  check('2,685 of the 2,766 Queensland SLS locations are MegaNet stations',
    counts.QLD.all === 2766 && counts.QLD.matched === 2685, JSON.stringify(counts.QLD));
  check('796 of MegaNet’s stations are gauges the Queensland SLS says a person reads',
    counts.QLD.manual === 865 && counts.QLD.manualMatched === 796, JSON.stringify(counts.QLD));
  // The NSW document covers the whole state and the ACT; MegaNet reaches its
  // North Coast and the border rivers.
  check('615 of the 1,375 NSW SLS locations are MegaNet stations, 7 of them read by hand',
    counts.NSW.all === 1375 && counts.NSW.matched === 615
      && counts.NSW.manual === 37 && counts.NSW.manualMatched === 7, JSON.stringify(counts.NSW));
  check('3,253 of MegaNet’s stations are in one document or the other, 47 in both',
    counts.stations === 3253 && counts.both === 47, JSON.stringify({ stations: counts.stations, both: counts.both }));

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
