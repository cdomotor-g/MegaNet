// 🪪 Radio Licensing (kb-licensing.js) and the licensing documents
// (licence-docs.js, docs/acma/), held to what they claim.
//
// The first half needs no browser — it is the half that matters most:
//
//   0. the words     every quotation the app shows (LicenceDocs.CITES) is on
//                    the page it names, word for word, in the saved copy of
//                    the document it is quoted from. A quotation that was
//                    retyped, tidied or moved fails here.
//   1. the shelf     every document has its PDF and its text, the page counts
//                    agree, and the hand-copied extracts are whole.
//   2. the glossary  every word has a meaning of a sentence or more, and every
//                    word it is "built from" is itself in the list.
//
// Then the tab itself, on the committed register copy, with no network beyond
// the site:
//
//   3. the page      thirteen sections and the glossary; every 📖 link names a
//                    quotation that exists; a set-apart quotation is the
//                    document's words.
//   4. 30 km         the station moved in and out of the circle: inside the
//                    plan, beyond it (never "unlicensed"), a relay beyond it
//                    needing its own licence, and the low-power model's 2 km.
//   5. the checker   a gauge's radio, cable, antenna and timing against the
//                    six limits, the arithmetic worked out again here.
//   6. the label     all three conditions, and only all three, ask for one.
//   7. the helper    every path through the questions ends at an answer.
//   8. the reader    a 📖 link opens the document at the sentence, marked;
//                    the saved PDF and the current version are linked; the
//                    pages turn.
//   9. the counts    the Bureau's licences as the register copy has them.
//
//   npm run licensing          (or: node licensing.mjs)
//   npm run licensing -- -v    also print what passed

import { readFileSync, existsSync, statSync } from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const ROOT = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, ROOT), 'utf8');

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const J = v => JSON.stringify(v);
const norm = t => String(t).replace(/\s+/g, ' ').trim();

// ── The modules, stood up without a page ─────────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const termHtml = (text, meaning) => `<span class="term" title="${esc(meaning)}">${esc(text)}</span>`;
const stand = (file, name, deps) => new Function(...Object.keys(deps), `${read(file)}; return ${name};`)(...Object.values(deps));
const LicenceDocs = stand('licence-docs.js', 'LicenceDocs', { esc, escAttr: esc, window: undefined });
const LicensingWords = stand('licensing-words.js', 'LicensingWords', { esc, escAttr: esc, termHtml, window: undefined });
const LicensingDraw = stand('kb-licensing-draw.js', 'LicensingDraw', { esc, escAttr: esc, window: undefined });

// ── 0. the words ─────────────────────────────────────────────────────────────
console.log('\nThe quotations — each on the page it names, word for word');

const TEXT = {};
for (const id of Object.keys(LicenceDocs.DOCS)) TEXT[id] = JSON.parse(read(`docs/acma/text/${id}.json`));
const cites = Object.entries(LicenceDocs.CITES);
const lost = [];
for (const [id, [doc, page, where, words]] of cites) {
  const t = TEXT[doc];
  if (!t || !t.pages[page - 1] || !norm(t.pages[page - 1]).includes(norm(words))) {
    const on = t ? t.pages.map((p, i) => (norm(p).includes(norm(words)) ? i + 1 : 0)).filter(Boolean) : [];
    lost.push(`${id}: not on ${doc} p${page}${on.length ? ` (it is on p${on.join(', ')})` : ' or anywhere in it'}`);
  }
  if (!where || words.length < 12) lost.push(`${id}: no place named, or too short to be a quotation`);
}
ok(`all ${cites.length} quotations are in their documents, on the page named`, lost.length === 0 && cites.length >= 60, lost.slice(0, 6).join(' | '));
ok('the reader finds each of them where it looks', cites.every(([, [doc, page, , words]]) => LicenceDocs.find(TEXT[doc].pages[page - 1], words)), '');
const must = ['fx16-30km', 'fx16-expected', 'fx16-another-master', 'es-anywhere', 'lcd-no-extend', 'lcd-power', 'lcd-timing', 'act-46', 'act-97', 'label-what', 'int-communal'];
ok('the rules the 30 km answer and the label rest on are among them', must.every(k => LicenceDocs.CITES[k]), J(must.filter(k => !LicenceDocs.CITES[k])));
ok('the two sentences the answer turns on read as they were found',
   LicenceDocs.said('fx16-30km') === 'A service area radius of 30 km. All stations must be contained within the service area.'
   && /can be located anywhere, although for most practical purposes/.test(LicenceDocs.said('es-anywhere')), '');

// ── 1. the shelf ─────────────────────────────────────────────────────────────
console.log('\nThe documents kept');

const docs = Object.entries(LicenceDocs.DOCS);
ok('every document has its words, and as many pages as it says', docs.every(([id, d]) => TEXT[id].pages.length === d.pages), J(docs.map(([id, d]) => [id, d.pages, TEXT[id].pages.length])));
ok('every document but the extracts has its PDF in docs/acma/', docs.filter(([, d]) => !d.extract).every(([, d]) => existsSync(new URL(`docs/acma/${d.file}`, ROOT)) && statSync(new URL(`docs/acma/${d.file}`, ROOT)).size > 100_000), '');
ok('each says what it is, when it took effect and where the current one is', docs.every(([, d]) => d.title && d.dated && /^https:\/\/www\.(acma|legislation)\.gov\.au\//.test(d.url) && d.why.length > 60 && LicenceDocs.KIND[d.kind]), '');
ok('the law in force and the copy first supplied are both kept, and told apart', LicenceDocs.DOCS.lcd.kind === 'law' && LicenceDocs.DOCS.lcd0.kind === 'old' && /Compilation No\. 2/.test(LicenceDocs.DOCS.lcd.title), '');
const law = TEXT.law;
ok('the hand-copied extracts each have a name, a version and an address', law.pages.length === law.labels.length && law.pages.length === law.from.length && law.pages.length === law.urls.length
   && law.urls.every(u => /^https:\/\/www\.legislation\.gov\.au\//.test(u)), J([law.pages.length, law.labels.length, law.from.length, law.urls.length]));
const readme = read('docs/acma/README.md');
ok('the folder’s notes say it is a snapshot, where each came from and on what terms', /snapshot, not the current rules/.test(readme) && /Creative Commons Attribution 4\.0/.test(readme)
   && docs.filter(([, d]) => !d.extract).every(([, d]) => readme.includes(d.file)), '');
ok('the snapshot’s date is one date everywhere', readme.includes('10 November 2026') && LicenceDocs.SNAPSHOT === '2026-11-10', LicenceDocs.SNAPSHOT);

// ── 2. the glossary ──────────────────────────────────────────────────────────
console.log('\nThe words');

const W = LicensingWords.WORDS, ids = Object.keys(W);
ok('sixty words or more, each in a group that exists', ids.length >= 60 && ids.every(k => LicensingWords.GROUPS.some(g => g[0] === W[k].g)), String(ids.length));
ok('each has a meaning of a sentence or more that is not the word again', ids.every(k => W[k].m.length >= 60 && norm(W[k].m).toLowerCase() !== norm(W[k].t).toLowerCase()), J(ids.filter(k => W[k].m.length < 60)));
ok('every word a word is built from is itself in the list', ids.every(k => (W[k].parts || []).every(p => W[p])), J(ids.flatMap(k => (W[k].parts || []).filter(p => !W[p]).map(p => `${k}→${p}`))));
ok('EIRP comes apart into equivalent, isotropic and radiated; isotropic says equal in every direction',
   ['equivalent', 'isotropic', 'radiated'].every(p => W.eirp.parts.includes(p)) && /equally in every direction/.test(W.isotropic.m) && /isos/.test(W.isotropic.m), '');
ok('dBi and dBd are tied by 2.15', /2\.15/.test(W.dbi.m) && /2\.15/.test(W.dbd.m) && /2\.15/.test(W.erp.m), '');

// The drawings' arithmetic.
const A = LicensingDraw.ANTENNAS;
ok('a pattern is half power at the edge of its beamwidth and its front-to-back ratio down behind',
   Object.values(A).filter(a => a.dir).every(a => Math.abs(LicensingDraw.lobeDb(a.bw / 2, a.bw, a.fb) + 3.0103) < 0.01 && LicensingDraw.lobeDb(180, a.bw, a.fb) === -a.fb && LicensingDraw.lobeDb(0, a.bw, a.fb) === 0), '');
ok('the antennas carry ACMA’s own figures where it gives them', A.yagi3.gain === 6 && A.yagi3.bw === 75 && A.yagi3.fb === 12 && A.yagi6.gain === 12 && A.yagi6.bw === 44 && A.yagi6.fb === 20 && A.col8.gain === 8.2, '');

// ── The tab ──────────────────────────────────────────────────────────────────
const FILE = JSON.parse(read('data/acma-station-licences.json'));
const server = await startServer();
const browser = await launchBrowser();
const errors = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
await applyNetworkPolicy(page, server.origin);
page.on('pageerror', e => errors.push(String(e)));
await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('licensing'));
await page.waitForSelector('#rlc-page');
await page.waitForFunction(() => !document.querySelector('#rlc-ours-body [aria-busy]'), null, { timeout: LOAD_TIMEOUT });

// ── 3. the page ──────────────────────────────────────────────────────────────
console.log('\nThe page');

const pg = await page.evaluate(() => ({
  sects: [...document.querySelectorAll('#rlc-page > section[data-sect]')].map(s => s.dataset.sect),
  want: KbLicensing.sections(),
  cites: [...document.querySelectorAll('#rlc-page .ld-cite')].map(b => b.dataset.cite),
  known: Object.keys(LicenceDocs.CITES),
  quotes: [...document.querySelectorAll('#rlc-page .ld-quote')].map(q => [q.dataset.cite, q.querySelector('p').textContent.replace(/\s+/g, ' ').trim()]),
  said: Object.fromEntries(Object.entries(LicenceDocs.CITES).map(([k, v]) => [k, v[3]])),
  terms: [...document.querySelectorAll('#rlc-page .term, #rlc-page .term-chip')].map(t => [t.textContent.trim(), (t.getAttribute('title') || '').length]),
  words: document.querySelectorAll('#rlc-glossary .rlc-word').length,
  disclaimer: (document.querySelector('.rlc-disclaimer')?.textContent || '').replace(/\s+/g, ' '),
  figs: [...document.querySelectorAll('#rlc-page svg[role="img"]')].map(s => (s.getAttribute('aria-label') || (s.querySelector('title') || {}).textContent || '').length),
  answer: (document.querySelector('.rlc-answer')?.textContent || '').replace(/\s+/g, ' '),
  links: [...document.querySelectorAll('#rlc-ask a')].map(a => a.href),
}));
ok('it has its thirteen sections, in order, and the glossary', J(pg.sects) === J(pg.want) && pg.sects.length === 13 && pg.words >= 60, J(pg.sects));
ok('it says first that it is a guide, not legal advice, and to ask ACMA', /A guide, not legal advice/.test(pg.disclaimer) && /ask ACMA/.test(pg.disclaimer), pg.disclaimer);
ok('every 📖 link names a quotation that exists', pg.cites.length >= 80 && pg.cites.every(c => pg.known.includes(c)), J(pg.cites.filter(c => !pg.known.includes(c))));
ok('a quotation set apart on the page is the document’s own words', pg.quotes.length >= 4 && pg.quotes.every(([k, t]) => t.includes(`“${pg.said[k]}”`)), J(pg.quotes.filter(([k, t]) => !t.includes(`“${pg.said[k]}”`)).map(q => q[0])));
ok('every marked word has a meaning of a sentence or more', pg.terms.length >= 60 && pg.terms.every(t => t[1] >= 40), J(pg.terms.filter(t => t[1] < 40).slice(0, 5)));
ok('every drawing has a name that says what it shows', pg.figs.length >= 9 && pg.figs.every(n => n >= 30), J(pg.figs));
const whole0 = await page.evaluate(() => document.getElementById('rlc-page').textContent.replace(/\s+/g, ' '));
ok('the short answer on 30 km: legal but unprotected, the law beside the policy, a repeater is different, not yet confirmed',
   /still licensed\. It is legal, but unprotected/.test(pg.answer) && /Both are true, because they are two different kinds of rule/.test(pg.answer)
   && /It sets no distance at all/.test(pg.answer) && /the price of being protected, not of being legal/.test(pg.answer)
   && /A repeater is different/.test(pg.answer) && /ACMA has not yet confirmed it in writing/.test(pg.answer), pg.answer);
ok('the page says a hub is not a Bureau office, and sends no radar data to an office by radio',
   /not a Bureau hub, the office its technicians work from/.test(whole0) && !/radar site to an office/.test(whole0) && /goes over the internet, not by radio/.test(whole0), '');
const whole = await page.evaluate(() => document.getElementById('rlc-page').textContent.replace(/\s+/g, ' '));
ok('it says base stations never transmit, that a licence’s “base station” is a repeater here, and that the network is nobody’s alone',
   /base stations never transmit/.test(whole) && /Nobody’s alone/.test(whole) && !/Flood-Net’s (own )?base station/.test(whole) && /In this network that hub is always a repeater/.test(whole)
   && /Base station \(a receiving site\)/.test(whole), '');
ok('…and nowhere suggests a base station transmits', !/base (station )?that (also )?transmits|receiving base that|bases? transmit(?!ter)/i.test(whole)
   && !/base (station )?that (also )?transmits/i.test(JSON.stringify(Object.values(LicensingWords.WORDS).map(w => w.m))), '');
ok('ACMA’s pages and the law are linked at acma.gov.au and legislation.gov.au', pg.links.length >= 16 && pg.links.every(h => /^https:\/\/www\.(acma|legislation)\.gov\.au\//.test(h)), J(pg.links.filter(h => !/^https:\/\/www\.(acma|legislation)\.gov\.au\//.test(h))));

// ── 4. 30 km ─────────────────────────────────────────────────────────────────
console.log('\nThe 30 km question — a station moved in and out of the circle');

const at = async (set) => page.evaluate(v => {
  for (const [k, x] of v) KbLicensing.set(k, x);
  return { verdict: document.getElementById('rlc-ex-verdict').textContent.replace(/\s+/g, ' ').trim(), read: document.getElementById('rlc-ex-read').textContent.replace(/\s+/g, ' '),
    name: document.getElementById('rlc-ex-name').textContent, st: document.getElementById('rlc-ex-st').getAttribute('class'),
    r: Number(document.getElementById('rlc-ex-area-a').getAttribute('r')), e: KbLicensing.explorerState() };
}, set);
const inside = await at([['model', 'high'], ['kind', 'gauge'], ['km', 20]]);
ok('a gauge at 20 km is inside what the licence was planned for', /Inside what the licence was planned for/.test(inside.verdict) && inside.st === 'rlc-st-in' && inside.e.inside, inside.verdict);
const out = await at([['km', 42]]);
ok('at 42 km it is beyond the plan — and the page does not call it unlicensed', /Beyond the plan — not unlicensed for that alone/.test(out.verdict) && out.st === 'rlc-st-out'
   && /Sets no distance for a gauge/.test(out.read) && /must be contained within the service area/.test(out.read) && /Do not record it as unlicensed/.test(out.read), out.verdict);
const other = await at([['km', 80]]);
ok('at 80 km it is inside the next base’s service area, and the page says so', other.st === 'rlc-st-other' && other.e.other && /inside that licence’s service area/.test(other.read), other.read.slice(0, 200));
const relay = await at([['kind', 'relay'], ['km', 42]]);
ok('a repeater at 42 km needs a licence of its own, by the law', /Needs a licence of its own/.test(relay.verdict) && /to extend the coverage area of a base station/.test(relay.read), relay.verdict);
const low = await at([['kind', 'gauge'], ['model', 'low']]);
ok('the low-power model draws a 2 km service area and a 10 km re-use distance', low.e.m.radius === 2 && low.e.m.reuse === 10 && Math.abs(low.r - 60) < 0.5 && /2 km/.test(low.name), J([low.e.m, low.r]));
await at([['model', 'high'], ['km', 42]]);

// ── 5. the checker ───────────────────────────────────────────────────────────
console.log('\nThe gauge checker');

const chk = async i => page.evaluate(n => { KbLicensing.check(n); const k = KbLicensing.checkState();
  return { atAnt: k.atAnt, eirp: k.eirp, back: k.back, fails: k.fails.map(r => r.name), verdict: document.getElementById('rlc-check-verdict').textContent,
    rows: document.querySelectorAll('#rlc-check-out .rlc-check-t tbody tr').length, over: document.querySelectorAll('#rlc-check-out .rlc-row-bad').length }; }, i);
const one = await chk(0);
ok('1 W through 0.5 dB into a 5.15 dBi collinear: 0.89 W at the antenna, 2.9 W EIRP, inside all six limits',
   Math.abs(one.atAnt - 0.8913) < 0.001 && Math.abs(one.eirp - 2.917) < 0.01 && one.fails.length === 0 && /Keeps all six limits/.test(one.verdict) && one.rows === 6, J(one));
const five = await chk(1);
ok('a 5 W radio on the same cable is over the law’s 1 W at the antenna, and over ACMA’s 5 W all round',
   Math.abs(five.atAnt - 4.456) < 0.01 && five.fails.includes('Power into the antenna') && five.fails.length === 2 && five.over === 2 && /Over 1 of the law’s limits/.test(five.verdict), J(five));
const pad = await chk(2);
ok('…and inside them again through a 7 dB pad', pad.atAnt < 1 && pad.fails.length === 0, J(pad));
const yagi = await chk(3);
ok('a 3-element Yagi sends a sixteenth of its EIRP backwards', Math.abs(yagi.back - yagi.eirp / Math.pow(10, 1.2)) < 1e-9 && yagi.fails.length === 0, J(yagi));
const fast = await chk(4);
ok('a burst every 5 seconds breaks the 10-second rule and the 1-in-30 rule', fast.fails.includes('Start to start') && fast.fails.includes('Share of time on the air'), J(fast.fails));
const txt = await page.evaluate(() => KbLicensing.checkText());
ok('the check can be kept as words, each limit with where it is written', /OVER\s+Start to start/.test(txt) && /Fixed Licence determination, section 15\(3\)/.test(txt) && /not legal advice/.test(txt), txt.slice(0, 200));
await chk(0);

// ── 6. the label ─────────────────────────────────────────────────────────────
console.log('\nThe transmitter label');

const lab = async v => page.evaluate(x => { for (const [k, on] of Object.entries(x)) KbLicensing.set(`label:${k}`, on); return document.getElementById('rlc-label-verdict').textContent; }, v);
ok('a licensed transmitter over 2 W at a shared site must carry one', /Yes — it must carry the label/.test(await lab({ lic: true, w2: true, shared: true })), '');
ok('…and without any one of the three, none is required', /No label is required/.test(await lab({ shared: false })) && /No label is required/.test(await lab({ shared: true, w2: false }))
   && /No label is required/.test(await lab({ w2: true, lic: false })), '');
const labelText = await page.evaluate(() => document.getElementById('rlc-base').textContent.replace(/\s+/g, ' '));
ok('the page says what goes on it, and what does not', /frequency assignment number and the words “Do Not Remove”/.test(labelText) && /no name, no licence number, no expiry date is asked for/.test(labelText), '');

// ── 7. the helper ────────────────────────────────────────────────────────────
console.log('\nDoes it need a licence of its own?');

const wiz = await page.evaluate(() => {
  const W = KbLicensing.WIZ, R = KbLicensing.RESULTS;
  const ends = new Set(), bad = [];
  const walk = (node, depth) => {
    if (R[node]) { ends.add(node); return; }
    if (!W[node] || depth > 12) { bad.push(node); return; }
    for (const a of W[node].a) walk(a[1], depth + 1);
  };
  walk('start', 0);
  return { ends: [...ends], results: Object.keys(R), bad };
});
ok('every path through the questions ends at an answer, and every answer can be reached', wiz.bad.length === 0 && wiz.results.every(r => wiz.ends.includes(r)), J(wiz));
const path = await page.evaluate(() => {
  KbLicensing.wiz('reset');
  for (const i of [0, 1, 1, 0, 0, 1]) KbLicensing.wiz('answer', i);
  const r = document.querySelector('#rlc-wiz .rlc-wiz-result');
  return { result: r ? r.dataset.result : '', text: r ? r.textContent.replace(/\s+/g, ' ') : '', asked: document.querySelectorAll('#rlc-wiz .rlc-wiz-past li').length };
});
ok('a gauge that reports to a licensed base, keeps the limits and is further out: not by law, but outside the plan', path.result === 'r-beyond' && path.asked === 6 && /Not by law — but it is outside the plan/.test(path.text), J(path));

// ── 8. the reader ────────────────────────────────────────────────────────────
console.log('\nThe document reader');

await page.locator('#rlc-km30 .ld-quote[data-cite="fx16-30km"] .ld-cite').click();
await page.waitForSelector('#ld-mark', { timeout: LOAD_TIMEOUT });
const rd = await page.evaluate(() => ({ mark: document.getElementById('ld-mark').textContent.replace(/\s+/g, ' '), head: document.querySelector('.ld-reader').textContent.replace(/\s+/g, ' '),
  links: [...document.querySelectorAll('.ld-links a')].map(a => a.getAttribute('href')), page: document.querySelector('.ld-reader').dataset.page,
  seen: (() => { const m = document.getElementById('ld-mark').getBoundingClientRect(), p = document.getElementById('ld-page').getBoundingClientRect(); return m.top >= p.top && m.bottom <= p.bottom; })() }));
ok('a 📖 link opens RALI FX16 at page 9 with the sentence marked and in view', rd.mark === LicenceDocs.said('fx16-30km') && rd.page === '9' && /Page 9 of 40/.test(rd.head) && rd.seen, J([rd.page, rd.mark]));
ok('it says it is a saved copy and that documents change', /A copy Flood-Net saved on 10 November 2026/.test(rd.head) && /open the current version before relying on it/.test(rd.head), '');
ok('it links the saved PDF at that page, and the version on ACMA’s website now', rd.links[0] === 'docs/acma/rali-fx16-2025-03-25.pdf#page=9' && rd.links[1] === LicenceDocs.DOCS.fx16.url, J(rd.links));
const pdf = await page.evaluate(async files => Promise.all(files.map(async f => { const r = await fetch(`docs/acma/${f}`); return [r.status, r.headers.get('content-type')]; })),
  docs.filter(([, d]) => !d.extract).map(([, d]) => d.file));
ok('every saved PDF is served, as a PDF', pdf.every(([s, t]) => s === 200 && /pdf/.test(t || '')), J(pdf));
await page.evaluate(() => LicenceDocs.turn(1));
const turned = await page.evaluate(() => ({ page: document.querySelector('.ld-reader').dataset.page, mark: !!document.getElementById('ld-mark'), text: document.getElementById('ld-page').textContent.length }));
ok('the pages turn', turned.page === '10' && !turned.mark && turned.text > 200, J(turned));
await page.evaluate(() => LicenceDocs.open('act-97'));
await page.waitForSelector('#ld-mark', { timeout: LOAD_TIMEOUT });
const act = await page.evaluate(() => ({ mark: document.getElementById('ld-mark').textContent.replace(/\s+/g, ' '), head: document.querySelector('.ld-reader').textContent.replace(/\s+/g, ' '),
  links: [...document.querySelectorAll('.ld-links a')].map(a => a.getAttribute('href')) }));
ok('a section of the Act opens as an extract, naming the version it was copied from and linking the one in force',
   act.mark === LicenceDocs.said('act-97') && /Compilation No\. 82/.test(act.head) && act.links.length === 1 && /legislation\.gov\.au\/C2004A04465/.test(act.links[0]), J(act.links));
await page.evaluate(() => LicenceDocs.openDoc('lcd0', 1));
await page.waitForFunction(() => /This version has been replaced/.test((document.querySelector('.ld-reader') || {}).textContent || ''), null, { timeout: LOAD_TIMEOUT });
await page.locator('.ld-reader .ld-warn button').click();
await page.waitForFunction(() => (document.querySelector('.ld-reader') || {}).dataset?.doc === 'lcd' && document.getElementById('ld-page').textContent.length > 200, null, { timeout: LOAD_TIMEOUT });
ok('the determination as first made says it has been replaced, and its link opens the one in force in its place', true, '');
await page.keyboard.press('Escape');

// ── 9. the counts ────────────────────────────────────────────────────────────
console.log('\nOurs, counted');

const bureau = new Set(FILE.holders.map((h, i) => (h[4] === 'bureau' ? i : -1)).filter(i => i >= 0));
const mine = FILE.licences.filter(l => bureau.has(l[5]) && /^granted/i.test(l[1]));
const tiles = await page.evaluate(() => [...document.querySelectorAll('#rlc-ours-body .rlc-tile-n')].map(e => Number(e.textContent)));
ok('the Bureau’s licences in force, and how many are point to multipoint and point to point, are the register copy’s',
   tiles[0] === mine.length && tiles[1] === mine.filter(l => /multipoint/i.test(l[2])).length && tiles[2] === mine.filter(l => !/multipoint/i.test(l[2])).length && tiles[0] > 300, J(tiles));
const counted = await page.evaluate(() => document.getElementById('rlc-lic-counts').textContent.replace(/\s+/g, ' '));
const pmp = FILE.licences.filter(l => /multipoint/i.test(l[2]) && /^granted/i.test(l[1]));
const stated = pmp.filter(l => l[7].some(c => /service area of \d/i.test(FILE.conditions[c]))).length;
ok('the licences that write a distance into a special condition are counted from the register copy', counted.includes(`${stated} of ${pmp.length} point-to-multipoint licences`) && stated >= 1, counted);
const glossary = await page.evaluate(() => { LicensingWords.go('isotropic'); LicensingWords.filter('isotropic');
  return { open: document.getElementById('rlc-glossary').open, shown: [...document.querySelectorAll('#rlc-glossary .rlc-word:not([hidden])')].length, all: document.querySelectorAll('#rlc-glossary .rlc-word').length }; });
ok('a word can be followed to its own entry, and the list narrowed by typing', glossary.open && glossary.shown >= 2 && glossary.shown < glossary.all, J(glossary));

ok('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
await server.close();
console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
