// 📜 ACMA licences (map-acma.js), held to what it claims.
//
// On the committed register copy (data/acma-station-licences.json) and the
// committed stations, with no network beyond the site itself:
//
//   0. the panel    a pane of the side panel, opened with a real click on 📜
//                   in its strip, in Tools straight after ⚖️; the register's
//                   date and counts said; every marked word with a meaning,
//                   and the same words in a fold.
//   1. the links    ACMA's licence document address built the way ACMA
//                   builds it (the owner's own example, to the character).
//   2. the map      Draw puts a circle round every point-to-multipoint base
//                   and a line on every point-to-point link, of the ticked
//                   holders only; the filters cut what is drawn.
//   3. the states   every transmitting station is in exactly one state, and
//                   each state is what the file says: a current transmitter
//                   within 500 m, inside a circle, or neither — worked out
//                   again here from the file, apart from the module.
//   4. the search   a station by its number answers with its state; a
//                   licence by its number zooms to it and lists its entries
//                   with ACMA's document; a frequency finds its licences.
//   5. coverage     a ring on every transmitting station, the counts, the
//                   stations with none and what would cover each, the CSVs.
//   6. the card     "ACMA licences near here" on a station's card: the
//                   verdict the panel gives, the nearest licences with their
//                   documents, the words in a fold, and Show on the map.
//   7. the guide    not legal advice, said first; every source a link to
//                   legislation.gov.au or acma.gov.au.
//   8. the rail     live while something is on; 🧹 Clear the selection takes
//                   all of it off.
//
//   npm run acmamap          (or: node acma-map.mjs)
//   npm run acmamap -- -v    also print what passed

import { readFileSync } from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const J = v => JSON.stringify(v);

const FILE = JSON.parse(readFileSync(new URL('../data/acma-station-licences.json', import.meta.url), 'utf8'));

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true });
const page = await context.newPage();
await applyNetworkPolicy(page, server.origin);
page.on('pageerror', e => errors.push(String(e)));
await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => { try { localStorage.removeItem('mn-acma-lic-v1'); } catch (_) { /* none */ } });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });

await page.click('#help-panel .dock-tab[data-dock="map-acma"]');
await page.waitForFunction(() => MapAcma.loaded(), null, { timeout: LOAD_TIMEOUT });
await page.waitForTimeout(400);

// ── 0. the panel ─────────────────────────────────────────────────────────────
console.log('\nThe panel');

const panel = await page.evaluate(() => {
  const wrap = document.querySelector('.mn-mapctl[data-panel="acma"]');
  const strip = [...document.querySelectorAll('#help-panel .dock-strip button')];
  const at = sel => strip.findIndex(b => b.matches(sel));
  const body = wrap && wrap.querySelector('.mn-mapctl-body');
  return {
    present: !!wrap, docked: !!wrap && !!wrap.closest('#help-panel .dock-pane'),
    shown: !!(body && body.getClientRects().length), showing: dockShowing(),
    title: wrap && wrap.querySelector('.mn-mapctl-title')?.textContent,
    group: strip.find(b => b.dataset.dock === 'map-acma')?.closest('.dock-group')?.dataset.group,
    afterCompare: at('[data-dock="map-acma"]') === at('[data-dock="map-repcompare"]') + 1,
    status: (document.getElementById('acmalic-status')?.textContent || '').replace(/\s+/g, ' '),
    words: document.querySelectorAll('.lic-panel > .bestrep-words dt').length,
    terms: [...document.querySelectorAll('.lic-panel .term, .lic-panel .term-chip')].map(e => [e.textContent.trim(), (e.getAttribute('title') || '').length]),
    tours: ['acma-search', 'acma-show', 'acma-cover', 'acma-guide'].map(t => !!document.querySelector(`.lic-panel [data-tour="${t}"]`)),
    live: MapAcma.live(), summary: MapAcma.summary(),
  };
});
ok('📜 ACMA licences is a pane of the side panel, open from its button in the strip',
   panel.present && panel.docked && panel.shown && panel.showing === 'map-acma' && panel.title === 'ACMA licences', J({ ...panel, terms: 0, summary: 0 }));
ok('…in the tools group, straight after the repeater comparison', panel.group === 'tools' && panel.afterCompare, J(panel.group));
ok('it says how many licences of how many holders, and the day the register copy was made',
   panel.status.includes(`${FILE.licences.length} licences of ${FILE.holders.length} holders`) && /\d{1,2} [A-Z][a-z]{2} \d{4}/.test(panel.status), panel.status);
ok('the register copy read is the committed one, whole',
   panel.summary.licences === FILE.licences.length && panel.summary.holders.length === FILE.holders.length
   && panel.summary.asAt === FILE.meta.source_date, J({ n: panel.summary.licences, at: panel.summary.asAt }));
ok('nothing is drawn, and the rail is not lit, until something is asked for', !panel.live && !panel.summary.show && !panel.summary.cover, J(panel.live));
ok('every marked word has a meaning of a sentence or more', panel.terms.length >= 8 && panel.terms.every(t => t[1] >= 40),
   J(panel.terms.filter(t => t[1] < 40)));
ok('the words of the panel are listed in a fold, a dozen or more', panel.words >= 12, String(panel.words));
ok('each part of the panel carries its tour hook', panel.tours.every(Boolean), J(panel.tours));

// ── 1. the links ─────────────────────────────────────────────────────────────
console.log('\nACMA’s own pages');

const links = await page.evaluate(() => ['1463975/1', '433505/1', '10053639/1', '17942/1', '1620447/2', 'nonsense'].map(n => MapAcma.pdfUrl(n)));
ok('a licence’s document is at the address ACMA gives it — the owner’s example, to the character',
   links[0] === 'https://backend.acma.gov.au/rrl/v1/licences/pdf?blobUrl=https%3A%2F%2Fcdn.acma.gov.au%2Frrl%2Flicences%2F1%2F463%2F1463975%2F1.pdf&licenceNumber=1463975-1.pdf', links[0]);
ok('…for a six-figure number, a middle part under 100, a five-figure number and a second issue alike',
   links[1].includes(encodeURIComponent('/rrl/licences/0/433/433505/1.pdf')) && links[2].includes(encodeURIComponent('/rrl/licences/10/53/10053639/1.pdf'))
   && links[3].includes(encodeURIComponent('/rrl/licences/0/17/17942/1.pdf')) && links[4].includes(encodeURIComponent('/rrl/licences/1/620/1620447/2.pdf'))
   && links[4].endsWith('licenceNumber=1620447-2.pdf'), J(links.slice(1, 5)));
ok('…and nothing for what is not a licence number', links[5] === '', links[5]);

// ── 2. the map ───────────────────────────────────────────────────────────────
console.log('\nThe licences on the map');

// What the file says should be drawn, worked out here.
const kindOf = l => (/multipoint/i.test(l[2]) ? 'pmp' : 'ptp');
const devsOf = i => FILE.devices.filter(d => d[0] === i);
const txSitesOf = i => [...new Set(devsOf(i).filter(d => d[2] === 'T').map(d => d[1]))];
const expectCircles = FILE.licences.reduce((n, l, i) => n + (kindOf(l) === 'pmp' ? txSitesOf(i).length : 0), 0);
const allSites = new Set(FILE.devices.map(d => d[1])).size;

await page.click('#acmalic-show');
await page.waitForTimeout(600);
const drawn = await page.evaluate(() => {
  let circles = 0, lines = 0, rings = 0;
  state.map.eachLayer(l => {
    if (l.options && l.options.pane === 'mnAcmaLicArea') { if (l instanceof L.Circle) circles++; else if (l instanceof L.Polyline) lines++; }
    if (l.options && l.options.pane === 'mnAcmaLicSite' && l instanceof L.CircleMarker) rings++;
  });
  const ptp = MapAcma.licences().map(n => MapAcma.licence(n)).filter(l => l.kind === 'ptp');
  return { circles, lines, rings, links: ptp.reduce((n, l) => n + l.links.length, 0), ptp: ptp.length, ptpNoLink: ptp.filter(l => !l.links.length).length,
    live: MapAcma.live(), legend: (document.querySelector('.mn-mapctl[data-panel="legend"]')?.textContent || '').includes('ACMA licences'),
    shown: (document.getElementById('acmalic-shown')?.textContent || '').replace(/\s+/g, ' ') };
});
ok('Draw puts a circle round every point-to-multipoint base in the file', drawn.circles === expectCircles && expectCircles > 100, J({ drawn: drawn.circles, expectCircles }));
ok('…a line — and its shaded band — on every point-to-point link, both ends from the file',
   drawn.links > 0 && drawn.lines === 2 * drawn.links && drawn.ptpNoLink === 0, J(drawn));
ok('…and a ring to press at every licensed site', drawn.rings === allSites, J({ rings: drawn.rings, allSites }));
ok('the rail is lit and the legend says what the shapes mean', drawn.live && drawn.legend, J({ live: drawn.live, legend: drawn.legend }));
ok('the panel says a circle is a planning radius, not a boundary', /planning radius, not a legal boundary/.test(drawn.shown), drawn.shown);

const bureauPmp = FILE.licences.reduce((n, l, i) => n + (FILE.holders[l[5]][4] === 'bureau' && kindOf(l) === 'pmp' ? txSitesOf(i).length : 0), 0);
await page.locator('#acmalic-classes input[type="checkbox"]').first().click();
await page.waitForTimeout(400);
const noBureau = await page.evaluate(() => { let c = 0; state.map.eachLayer(l => { if (l.options && l.options.pane === 'mnAcmaLicArea' && l instanceof L.Circle) c++; }); return c; });
ok('unticking the Bureau takes exactly its circles off', noBureau === expectCircles - bureauPmp, J({ noBureau, expectCircles, bureauPmp }));
await page.locator('#acmalic-classes input[type="checkbox"]').first().click();
await page.selectOption('#acmalic-standing', 'soon');
await page.waitForTimeout(400);
const soon = await page.evaluate(() => ({ s: MapAcma.summary(), all: MapAcma.licences().map(n => MapAcma.licence(n)).filter(l => l.standing === 'soon').length }));
ok('Status: expiring shows only the licences within 90 days of expiry', soon.s.shown === soon.all && soon.s.shown === soon.s.soon, J({ shown: soon.s.shown, all: soon.all }));
await page.selectOption('#acmalic-standing', 'all');
await page.waitForTimeout(300);

// ── 3. the states ────────────────────────────────────────────────────────────
console.log('\nA station’s licensing state');

const st = await page.evaluate(() => {
  const located = s => s.lat != null && s.lon != null && s.lat !== '' && s.lon !== '';
  const tx = s => !!s.repeater || (s.roles || []).includes('repeater') || stationAlertIds(s).length > 0;
  const rows = state.data.stations.filter(s => located(s) && tx(s)).map(s => {
    const a = MapAcma.assess(s.id);
    return { id: s.id, lat: Number(s.lat), lon: Number(s.lon), state: a.state, chans: a.chans, site: a.site[0] || null, area: a.area[0] || null, nearest: a.nearest };
  });
  const quiet = state.data.stations.filter(s => located(s) && !tx(s));
  return { rows, counts: MapAcma.counts(), quiet: quiet.length, quietStates: [...new Set(quiet.slice(0, 300).map(s => MapAcma.stateOf(s).state))],
    nopos: state.data.stations.filter(s => !located(s)).length };
});
const tally = s => st.rows.filter(r => r.state === s).length;
ok('every transmitting station is in exactly one of three states, and the counts are theirs',
   st.counts.site === tally('site') && st.counts.area === tally('area') && st.counts.none === tally('none')
   && st.counts.site + st.counts.area + st.counts.none === st.rows.length, J(st.counts));
ok('a station with no ALERT address that is not a repeater is “not a transmitter”, never “none found”',
   st.counts.na === st.quiet && st.quietStates.length === 1 && st.quietStates[0] === 'na' && st.counts.nopos === st.nopos, J({ na: st.counts.na, quiet: st.quiet, s: st.quietStates }));

// The same answer from the file alone: haversine, 500 m, 30 km, in force, on its channel.
const hav = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742.0176 * Math.asin(Math.sqrt(x)); };
const today = new Date().toISOString().slice(0, 10);
const lic = FILE.licences.map((l, i) => {
  const conds = l[7].map(c => FILE.conditions[c]);
  const m = conds.map(c => /service area of (\d+(?:\.\d+)?)\s*km/i.exec(c)).find(Boolean);
  const tx = devsOf(i).filter(d => d[2] === 'T');
  return { no: l[0], kind: kindOf(l), current: /^granted/i.test(l[1]) && l[4] >= today, R: m ? Number(m[1]) : 30,
    f: [...new Set(tx.map(d => d[3]))], sites: [...new Set(tx.map(d => d[1]))].map(s => FILE.sites[s]) };
});
const mine = r => {
  let site = false, area = false;
  for (const l of lic) {
    if (!l.current) continue;
    if (r.chans.length && l.f.length && !l.f.some(f => r.chans.some(c => Math.abs(f - c) < 0.002))) continue;
    const km = Math.min(...l.sites.map(s => hav(r.lat, r.lon, s[2], s[3])));
    if (km <= 0.5) site = true; else if (l.kind === 'pmp' && km <= l.R) area = true;
  }
  return site ? 'site' : area ? 'area' : 'none';
};
const wrong = st.rows.filter(r => mine(r) !== r.state);
ok(`all ${st.rows.length} are what the file says, worked out again here apart from the module`, wrong.length === 0,
   J(wrong.slice(0, 5).map(r => [r.id, r.state, mine(r)])));
ok('“licence at the site” rests on a transmitter within 500 m; “inside a licence’s area” on a point-to-multipoint base within its radius',
   st.rows.filter(r => r.state === 'site').every(r => r.site && r.site.txKm <= 0.5)
   && st.rows.filter(r => r.state === 'area').every(r => r.area && r.area.kind === 'pmp' && r.area.txKm > 0.5 && r.area.txKm <= 30.0001), '');
ok('“none found” names the nearest licence that would cover it, and a gap above nothing',
   st.rows.filter(r => r.state === 'none' && r.nearest).every(r => r.nearest.gap > 0 && r.nearest.kind === 'pmp')
   && st.rows.filter(r => r.state === 'none' && r.nearest).length > 0, '');
ok('there are stations in each state to look at', tally('site') > 20 && tally('area') > 100 && tally('none') > 10, J(st.counts));

const atSite = st.rows.find(r => r.state === 'site'), inArea = st.rows.find(r => r.state === 'area'), none = st.rows.find(r => r.state === 'none' && r.nearest);
const verdicts = await page.evaluate(ids => ids.map(id => MapAcma.verdict(id)), [atSite.id, inArea.id, none.id]);
ok('the verdict of a licensed site names the licence', verdicts[0].startsWith('Licensed at this site:') && verdicts[0].includes(atSite.site.no), verdicts[0]);
ok('…of a station inside a circle says no licence names the site, which licence covers it, and that the circle is a planning radius or the licence’s own',
   /^No licence names this site/.test(verdicts[1]) && verdicts[1].includes(inArea.area.no) && /(radius ACMA plans|service area written on that licence)/.test(verdicts[1]), verdicts[1]);
ok('…and where none was found it never says unlicensed as a fact',
   /^No licence found for this site in the register copy of/.test(verdicts[2]) && /not the same as unlicensed/.test(verdicts[2])
   && verdicts[2].includes(none.nearest.no) && !/\bis unlicensed\b/i.test(verdicts[2]), verdicts[2]);

// The radius is a setting: a smaller circle covers fewer.
await page.fill('#acmalic-radius', '10');
await page.locator('#acmalic-radius').dispatchEvent('change');
await page.waitForTimeout(500);
const small = await page.evaluate(() => MapAcma.counts());
ok('a 10 km radius leaves the licensed sites as they were and puts fewer stations inside a circle',
   small.site === st.counts.site && small.area < st.counts.area && small.none > st.counts.none, J(small));
await page.fill('#acmalic-radius', '30');
await page.locator('#acmalic-radius').dispatchEvent('change');
await page.waitForTimeout(500);

// ── 4. the search ────────────────────────────────────────────────────────────
console.log('\nThe search');

const stn = await page.evaluate(id => { const s = state.data.stations.find(x => x.id === id); return { id: s.id, name: s.name, number: s.station_number }; }, atSite.id);
await page.fill('#acmalic-find', String(stn.number || stn.name));
await page.waitForTimeout(300);
const hit = page.locator('#acmalic-hits .lic-hit', { hasText: stn.name }).first();
ok('a station typed by its number is offered with its licensing state beside it',
   await hit.count() === 1 && /Licence at the site/.test(await hit.textContent()), await page.locator('#acmalic-hits').textContent());
await hit.click();
await page.waitForFunction(id => { const p = MapAcma.summary().picked; return p && p.type === 'station' && String(p.id) === String(id); }, stn.id, { timeout: 10_000 });
await page.waitForTimeout(600);
const pickedSt = await page.evaluate(() => {
  const el = document.getElementById('acmalic-picked');
  return { text: (el?.textContent || '').replace(/\s+/g, ' '), state: el?.querySelector('.lic-verdict')?.dataset.licState,
    rows: el?.querySelectorAll('.lic-near').length, pdf: [...(el?.querySelectorAll('.lic-links a') || [])].map(a => a.href) };
});
ok('picking it puts its verdict and the licences near it in the panel, each with ACMA’s document',
   pickedSt.state === 'site' && pickedSt.text.includes(atSite.site.no) && pickedSt.rows >= 1
   && pickedSt.pdf.length >= 1 && pickedSt.pdf.every(h => h.startsWith('https://backend.acma.gov.au/rrl/v1/licences/pdf?blobUrl=')), J({ ...pickedSt, text: pickedSt.text.slice(0, 200) }));

const ptpNo = FILE.licences.find(l => kindOf(l) === 'ptp')[0];
await page.fill('#acmalic-find', ptpNo.split('/')[0]);
await page.waitForTimeout(300);
await page.locator('#acmalic-hits .lic-hit', { hasText: ptpNo }).first().click();
await page.waitForFunction(no => { const p = MapAcma.summary().picked; return p && p.type === 'licence' && p.id === no; }, ptpNo, { timeout: 10_000 });
await page.waitForTimeout(800);
const pickedLic = await page.evaluate(no => {
  const el = document.getElementById('acmalic-picked'), l = MapAcma.licence(no), b = state.map.getBounds();
  return { text: (el?.textContent || '').replace(/\s+/g, ' '), devs: el?.querySelectorAll('.lic-devs li').length,
    links: [...(el?.querySelectorAll('.lic-links a') || [])].map(a => a.href), pdf: MapAcma.pdfUrl(no),
    inView: l.sites.every(s => b.contains([s.lat, s.lon])), ends: l.sites.length, link: l.links.length };
}, ptpNo);
ok('a licence typed by its number is found, and picking it zooms the map to both ends of the link',
   pickedLic.inView && pickedLic.ends >= 2 && pickedLic.link >= 1, J({ inView: pickedLic.inView, ends: pickedLic.ends }));
ok('…and lists what it transmits and receives, where, with ACMA’s licence document and the register',
   pickedLic.devs >= 2 && /Transmits at/.test(pickedLic.text) && /Receives at/.test(pickedLic.text) && pickedLic.links[0] === pickedLic.pdf
   && pickedLic.links.some(h => h.startsWith('https://www.acma.gov.au/register-radiocommunication-licences-rrl')), J({ devs: pickedLic.devs, links: pickedLic.links }));

await page.fill('#acmalic-find', '151.95');
await page.waitForTimeout(300);
const freq = await page.evaluate(() => [...document.querySelectorAll('#acmalic-hits .lic-hit')].map(b => b.textContent.replace(/\s+/g, ' ')));
ok('a frequency finds the licences on it', freq.length >= 1 && freq.every(t => /151\.95/.test(t)), J(freq.slice(0, 3)));
await page.fill('#acmalic-find', 'zzz-no-such-thing');
await page.waitForTimeout(200);
ok('and nothing matching says what can be typed', /Nothing matches/.test(await page.locator('#acmalic-hits').textContent()), '');
await page.fill('#acmalic-find', '');

// ── 5. coverage ──────────────────────────────────────────────────────────────
console.log('\nWhich stations are licensed');

await page.evaluate(() => MapAcma.unpick());
await page.click('#acmalic-cover');
await page.waitForTimeout(800);
const cov = await page.evaluate(() => {
  let rings = 0;
  state.map.eachLayer(l => { if (l.options && l.options.pane === 'mnAcmaLicCover' && l instanceof L.CircleMarker) rings++; });
  const n = k => Number(document.querySelector(`#acmalic-counts li[data-state="${k}"] strong`)?.textContent);
  const csv = MapAcma.stationsCsv().trim().split('\n'), lcsv = MapAcma.licencesCsv().trim().split('\n');
  return { rings, shown: { site: n('site'), area: n('area'), none: n('none'), na: n('na') }, counts: MapAcma.counts(),
    noneSummary: (document.querySelector('#acmalic-none > summary')?.textContent || '').trim(),
    noneRows: document.querySelectorAll('#acmalic-none-table tbody tr').length,
    owners: document.querySelectorAll('#acmalic-owners tbody tr').length,
    csvHead: csv.find(l => l.startsWith('station_id')), csvRows: csv.filter(l => !l.startsWith('#') && !l.startsWith('station_id')).length,
    csvNone: csv.filter(l => l.includes(',None found,')).length, csvSays: csv[2],
    lcsvRows: lcsv.filter(l => !l.startsWith('#') && !l.startsWith('licence,')).length, n: MapAcma.summary().licences };
});
ok('a ring on every transmitting station, and no other', cov.rings === st.rows.length, J({ rings: cov.rings, tx: st.rows.length }));
ok('the counts on the panel are the counts', cov.shown.site === cov.counts.site && cov.shown.area === cov.counts.area
   && cov.shown.none === cov.counts.none && cov.shown.na === cov.counts.na, J(cov.shown));
ok('the stations with none found are listed, with what would cover each',
   cov.noneSummary.startsWith(`${cov.counts.none} station`) && cov.noneRows === Math.min(cov.counts.none, 150), J({ s: cov.noneSummary, rows: cov.noneRows }));
ok('there is a line for every holder with licences', cov.owners === FILE.holders.length, String(cov.owners));
ok('the stations CSV has a line for every transmitting station, its state in words, and the caution at its head',
   cov.csvRows === st.rows.length && cov.csvNone === cov.counts.none && /not the same as unlicensed/.test(cov.csvSays)
   && /station_number.*state.*licence.*gap_km/.test(cov.csvHead), J({ rows: cov.csvRows, none: cov.csvNone }));
ok('the licences CSV has a line for every licence', cov.lcsvRows === cov.n, J({ rows: cov.lcsvRows, n: cov.n }));

const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), page.click('#acmalic-save')]);
ok('Save stations CSV saves a file named floodnet-…', /^floodnet-acma-licensing-stations-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());

await page.click('#acmalic-none > summary');
await page.selectOption('#acmalic-none-sort', 'name');
await page.waitForTimeout(300);
const sorted = await page.evaluate(() => [...document.querySelectorAll('#acmalic-none-table tbody tr td:first-child')].slice(0, 30).map(td => td.firstChild.textContent.trim()));
ok('the list sorts by name when asked', sorted.every((n, i) => i === 0 || sorted[i - 1].localeCompare(n) <= 0), J(sorted.slice(0, 5)));

// ── 6. the card ──────────────────────────────────────────────────────────────
console.log('\nThe station card');

await page.evaluate(() => MapAcma.clear());
await page.evaluate(id => showStationCard(id), inArea.id);
await page.waitForFunction(id => { const el = document.getElementById(`mn-lic-card-${id}`); return el && el.querySelector('.lic-verdict[data-lic-state]'); }, inArea.id, { timeout: 15_000 });
const card = await page.evaluate(id => {
  const el = document.getElementById(`mn-lic-card-${id}`);
  const group = el.closest('[data-grp]');
  return { tour: el.dataset.tour, group: group ? group.dataset.grp : '',
    state: el.querySelector('.lic-verdict').dataset.licState, verdict: el.querySelector('.lic-verdict').textContent.replace(/\s+/g, ' '),
    mine: MapAcma.verdict(id), rows: [...el.querySelectorAll('.lic-near-list > .lic-near')].map(li => li.textContent.replace(/\s+/g, ' ')),
    kms: [...el.querySelectorAll('ul.lic-near-list:not(details ul) .lic-km')].map(e => e.textContent),
    pdf: [...el.querySelectorAll('.lic-near .lic-links a')].map(a => a.href), words: el.querySelectorAll('.lic-words dt').length,
    caution: /not legal advice/.test(el.querySelector('.lic-words').textContent), head: el.querySelector('.stn-card-rhs-head').textContent.trim(),
    terms: [...el.querySelectorAll('.term, .term-chip')].every(e => (e.getAttribute('title') || '').length >= 40) };
}, inArea.id);
ok('a station’s card has “ACMA licences near here” under Radio, with its tour hook', card.head === 'ACMA licences near here' && card.tour === 'card-licences' && /radio/i.test(card.group), J({ head: card.head, group: card.group }));
ok('it leads with the same verdict the tool gives', card.state === 'area' && card.verdict.includes(card.mine), card.verdict.slice(0, 200));
ok('then the nearest licences, nearest first, each with its distance, holder, type, frequency and ACMA’s document',
   card.rows.length >= 2 && card.rows.every(r => /(km|m) [NSEW]/.test(r) && /(PMP|PTP)/.test(r) && /MHz/.test(r))
   && card.pdf.length === card.rows.length && card.pdf.every(h => h.startsWith('https://backend.acma.gov.au/rrl/v1/licences/pdf?blobUrl=')), J(card.rows.slice(0, 2)));
ok('its words are on hover and in a fold, with the caution', card.terms && card.words >= 10 && card.caution, J({ words: card.words }));

await page.evaluate(id => document.querySelector(`#mn-lic-card-${CSS.escape(String(id))} .lic-foot button`).click(), inArea.id);
await page.waitForFunction(id => { const p = MapAcma.summary().picked; return p && p.type === 'station' && String(p.id) === String(id); }, inArea.id, { timeout: 10_000 });
await page.waitForTimeout(600);
const handed = await page.evaluate(() => ({ showing: dockShowing(), drawn: MapAcma.drawn(), live: MapAcma.live() }));
ok('Show on the map opens the tool on that station, with the licence it rests on drawn', handed.showing === 'map-acma' && handed.drawn.areas >= 1 && handed.live, J(handed));

// ── 7. the guide ─────────────────────────────────────────────────────────────
console.log('\nThe guide');

const guide = await page.evaluate(() => {
  const g = document.getElementById('acmalic-guide');
  return { first: g.querySelector('.lic-disclaimer')?.textContent.replace(/\s+/g, ' ') || '', secs: [...g.querySelectorAll('.lic-guide-sec')].map(d => d.dataset.guide),
    srcs: [...g.querySelectorAll('a')].map(a => a.href), dated: [...g.querySelectorAll('.lic-sources li')].map(li => li.textContent.replace(/\s+/g, ' ')),
    text: g.textContent.replace(/\s+/g, ' ') };
});
ok('the guide says first that it is a guide, not legal advice, and to check with ACMA', /guide, not legal advice/.test(guide.first) && /check with ACMA/.test(guide.first), guide.first);
ok('it covers why, the types, how far a licence reaches, power, what a site should hold, renewal and reading the register',
   ['why', 'types', 'reach', 'power', 'site', 'renew', 'read', 'sources'].every(k => guide.secs.includes(k)), J(guide.secs));
ok('every claim’s source is a link to the Federal Register of Legislation or to ACMA',
   guide.srcs.length >= 25 && guide.srcs.every(h => /^https:\/\/www\.(legislation|acma)\.gov\.au\//.test(h)), J(guide.srcs.filter(h => !/^https:\/\/www\.(legislation|acma)\.gov\.au\//.test(h))));
ok('…and each is listed once more with its date', guide.dated.length >= 12 && guide.dated.every(t => /(20\d\d)/.test(t)), J(guide.dated.slice(0, 2)));
ok('it answers the 30 km question: a planning figure, the licence states no distance',
   /The licence states no distance/.test(guide.text) && /30 km is ACMA’s planning figure/.test(guide.text) && /100 mW EIRP/.test(guide.text), '');

// ── 8. the rail, and clearing ────────────────────────────────────────────────
console.log('\nThe rail and Clear the selection');

await page.evaluate(() => { MapAcma.set('show', true); MapAcma.set('cover', true); });
await page.click('#help-panel .dock-tab[data-dock="stations"]').catch(() => {});
await page.waitForTimeout(300);
const rail = await page.evaluate(() => ({ live: MapAcma.live(), tool: typeof dockToolLive === 'function' ? dockToolLive('map-acma') : null }));
ok('with its pane put away the tool still says it has something on', rail.live && rail.tool !== false, J(rail));
await page.evaluate(() => clearStationsMapMarks());
await page.waitForTimeout(300);
const gone = await page.evaluate(() => {
  let shapes = 0;
  state.map.eachLayer(l => { if (l instanceof L.Path && ['mnAcmaLicArea', 'mnAcmaLicSite', 'mnAcmaLicCover'].includes(l.options.pane)) shapes++; });
  return { live: MapAcma.live(), s: MapAcma.summary(), shapes };
});
ok('Clear the selection takes the licences, the rings and the picked station off the map',
   !gone.live && !gone.s.show && !gone.s.cover && gone.s.picked === null && gone.shapes === 0, J({ live: gone.live, shapes: gone.shapes }));
ok('…and leaves the holders and the radius as they were set', gone.s.radius === 30 && gone.s.holders.every(h => h.on), J(gone.s.radius));

ok('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
await server.close();
console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
