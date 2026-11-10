// A station's benchmarks on the station card's 🌊 Flood tab and in the station
// editor (station-benchmarks.js): the Bureau's (0101), the ones an editor
// enters (0110), and adding, changing and removing one — in Chromium over the
// real register, with the database's three reads and two functions stood in
// for (tools/check_station_benchmarks.sql holds the real ones to their rules).
//
//   1. **Signed out** the card shows the Bureau's benchmarks in numbers — the
//      level, the datum, on the gauge, the survey mark's number — from the
//      published view (0102), never the words, and no way to add one.
//   2. **An editor** sees every benchmark with its description and comment,
//      which report it is from and the day it was printed, under the flood
//      history; the words that need one have a meaning on hover and in the
//      fold; nothing typed into the database is run as markup.
//   3. **Adding one**: the form says what is wrong in a sentence, sends what
//      was typed to station_benchmark_entry_save(), and the new mark is in the
//      list without a reload; Change sends its id; Remove asks first.
//   4. **The editor** has the same section, saves a benchmark on its own, and
//      its boxes are not counted as unsaved station edits. A station not saved
//      yet is told to save first.
//   5. **Use in a Level Survey** takes an entered benchmark too; a database
//      before 0110 still shows the Bureau's and offers no Add.
//
// Every benchmark here is made up.
//
// Run:  npm run benchmarks        (-v to list what passed)

import fs from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const J = JSON.stringify;

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok });
  if (!ok) console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${label}`);
}

const STATIONS = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;
// A river gauge with floods on record (so the flood history is on its card),
// and a station the Bureau's lists say nothing about.
const river = STATIONS.find(s => (s.flood_peaks || []).some(p => p && p.height_m != null)
  && (s.flood_classes || []).length && s.lat != null && s.station_number);
const plain = STATIONS.find(s => !(s.flood_peaks || []).length && !(s.flood_classes || []).length && !(s.gauge_survey || []).length
  && !(s.crossings || []).length && !(s.bureau_listings || []).length && !(s.flood_effects || []).length
  && !s.awrc_number && !s.stream && !s.urbs_label && s.lat != null);

// ── The database, stood in for ───────────────────────────────────────────────
const BUREAU = [
  { bureau_number: '599001', ord: 0, level_m: 104.26, datum: 'AHD', on_gauge_m: 5.5, gauge_zero_m: 98.76, gauge_datum: 'AHD', printed_on: '2026-10-15',
    description: 'PSM 990001 made-up plaque <img src=x onerror="window.__xss=1"> in the kerb', comment: 'A made-up <b>comment</b>.' },
  { bureau_number: '599001', ord: 1, level_m: 8.57, datum: 'ASSUM', on_gauge_m: null, gauge_zero_m: 98.76, gauge_datum: 'AHD', printed_on: '2026-10-15',
    description: 'TBM made-up bolt in a made-up gum', comment: null },
];
const db = { requests: [], rpc: [], entered: [], noEntries: false, failSave: 0, seq: 0 };
const reads = name => db.requests.filter(r => r.name === name);
async function installDb(ctx) {
  await ctx.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: J(body) });
    const station = (url.searchParams.get('station_id') || '').replace(/^eq\./, '');
    const signed = /^Bearer /.test(req.headers().authorization || '');
    if (name === 'station_benchmark' || name === 'station_benchmark_public' || name === 'station_benchmark_entered') {
      db.requests.push({ name, station, signed });
    }
    if (name === 'station_benchmark') return json(200, signed && station === river.id ? BUREAU : []);
    if (name === 'station_benchmark_public') {
      return json(200, station === river.id
        ? BUREAU.map(({ description, comment, ...n }) => ({ ...n, mark: /PSM/.test(description) ? 'PSM 990001' : null })) : []);
    }
    if (name === 'station_benchmark_entered') {
      if (db.noEntries) return json(404, { message: 'Could not find the table meganet.station_benchmark_entered in the schema cache' });
      return json(200, signed ? db.entered.filter(e => e.station_id === station) : []);
    }
    if (name === 'rpc/station_benchmark_entry_save') {
      const p = (req.postDataJSON() || {}).p || {};
      db.rpc.push({ fn: 'save', p, signed });
      if (!signed) return json(404, { message: 'not for you' });
      if (db.failSave) return json(db.failSave, { message: 'made-up failure for the test' });
      const level = Number(p.level_m);
      const row = { level_m: level, datum: p.datum, datum_other: p.datum_other || '', description: p.description, comment: p.comment || '',
                    surveyed_on: p.surveyed_on || null, source: p.source || 'Entered in Flood-Net', gauge_zero_m: 98.76, gauge_datum: 'AHD',
                    on_gauge_m: p.datum === 'GH' ? level : p.datum === 'AHD' ? Math.round((level - 98.76) * 1000) / 1000 : null };
      if (p.id) {
        const e = db.entered.find(x => x.id === p.id);
        if (!e) return json(400, { message: 'no such benchmark on that station — it may have been removed' });
        Object.assign(e, row, { updated_by: 'editor@example.com' });
        return json(200, { benchmark: e });
      }
      const e = { id: `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`, station_id: p.station_id, ...row,
                  created_by: 'editor@example.com', created_at: '2026-11-10T01:00:00Z', updated_by: 'editor@example.com', updated_at: '2026-11-10T01:00:00Z' };
      db.entered.push(e);
      return json(200, { benchmark: e });
    }
    if (name === 'rpc/station_benchmark_entry_remove') {
      const id = (req.postDataJSON() || {}).p_id;
      db.rpc.push({ fn: 'remove', id, signed });
      db.entered = db.entered.filter(e => e.id !== id);
      return json(200, { removed: id });
    }
    return route.fallback();
  });
}

const as = (page, who) => page.evaluate(w => {
  dbSetAccessToken(w ? 'test-token' : null);
  Auth.isSignedIn = () => !!w;
  Auth.mayWrite = () => w === 'editor';
  Auth.email = () => (w ? `${w}@example.com` : null);
}, who);
const text = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
}, sel);
// The card, on its Flood tab.
const showCard = async (page, id) => {
  await page.evaluate(i => showStationCard(i), id);
  await page.waitForSelector('#stn-card:not([hidden]) #stn-cv-tab-flood', { state: 'attached', timeout: 15_000 });
  await page.evaluate(() => {
    const t = document.getElementById('stn-cv-tab-flood');
    if (t && t.getAttribute('aria-selected') !== 'true') t.click();
  });
};
const CARD = `#mn-bm-card-${river.id}`;

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Australia/Brisbane', locale: 'en-AU' });
  await applyNetworkPolicy(ctx, server.origin);
  await installDb(ctx);
  await ctx.addInitScript(() => { try { localStorage.setItem('mn-nudge', 'off'); } catch (_) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nSigned out: the numbers\n');
  await as(page, null);
  await showCard(page, river.id);
  await page.waitForSelector(`${CARD} .sb-list li`, { state: 'attached', timeout: 15_000 });
  let t = await text(page, CARD);
  check('the card asks the published numbers, and not the editors\' view',
    reads('station_benchmark_public').length === 1 && reads('station_benchmark').length === 0 && reads('station_benchmark_entered').length === 0,
    J(db.requests));
  check('each benchmark is there in numbers: level, datum, on the gauge, the survey mark\'s number',
    /104\.26 m AHD · on the gauge 5\.50 · PSM 990001/.test(t) && /8\.57 m assumed/.test(t), t);
  check('…with which report and the day it was printed', /Bureau's benchmark details report lists these 2 benchmarks here \(HDB, printed 15\/10\/2026\)/.test(t), t);
  check('…and not the words, which it says are editors\'',
    !/made-up/i.test(t) && /What each mark is and where it is are shown to signed-in editors/.test(t), t);
  check('nobody signed out is offered Add', !(await page.$(`${CARD} .sb-add`)));
  const where = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    const fh = el.parentElement.querySelector(':scope > .stn-card-fh');
    return { sameGroup: !!fh, after: !!fh && !!(fh.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
             next: !!fh && fh.nextElementSibling === el,
             rhs: !!el.parentElement.querySelector(':scope > .stn-card-rhs'),
             grp: (el.closest('.stn-grp') || { dataset: {} }).dataset.grp, hidden: !el.offsetParent };
  }, CARD);
  check('the benchmarks are on the Flood tab, straight under the flood history', where.grp === 'flood' && !where.hidden && where.sameGroup && where.next && where.rhs, J(where));

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nAn editor: every benchmark, with its words\n');
  await as(page, 'editor');
  await showCard(page, river.id);
  await page.waitForFunction(sel => /made-up bolt/.test((document.querySelector(sel) || {}).textContent || ''), CARD, { timeout: 15_000 });
  t = await text(page, CARD);
  check('an editor is given the editors\' views', reads('station_benchmark').length === 1 && reads('station_benchmark_entered').length === 1, J(db.requests));
  check('each benchmark has its level, datum, description and comment',
    /104\.26 m AHD · on the gauge 5\.50/.test(t) && /PSM 990001 made-up plaque/.test(t) && /A made-up <b>comment<\/b>\./.test(t)
    && /8\.57 m assumed/.test(t) && /TBM made-up bolt in a made-up gum/.test(t), t);
  check('…and the report and its date', /\(HDB, printed 15\/10\/2026\)/.test(t), t);
  check('what the database holds is shown as text, never run as markup',
    await page.evaluate(sel => !window.__xss && !document.querySelector(`${sel} img`) && !document.querySelector(`${sel} .sb-list b`), CARD));
  const words = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    return { hover: [...el.querySelectorAll('.term[title]')].map(x => `${x.textContent}=${x.title.length}`),
             fold: [...el.querySelectorAll('.sb-words dt')].map(x => x.textContent),
             short: [...el.querySelectorAll('.sb-words dd')].filter(x => x.textContent.length < 40).length,
             head: (el.querySelector('.stn-card-sb-h') || {}).title || '' };
  }, CARD);
  check('Benchmark, the datum and On the gauge each have a meaning on hover',
    words.head.length > 40 && ['benchmarks', 'HDB', 'AHD', 'assumed', 'on the gauge'].every(w => words.hover.some(h => h.startsWith(`${w}=`) && Number(h.split('=')[1]) > 40)),
    J(words));
  check('…and the fold lists the same words where a finger can read them: Benchmark, Datum, AHD, TBM, PSM, gauge height',
    ['Benchmark', 'Datum', 'AHD', 'Assumed', 'State', 'Gauge height (GH)', 'On the gauge', 'TBM', 'PSM', 'HDB', 'Entered in Flood-Net'].every(w => words.fold.includes(w))
    && words.short === 0, J(words.fold));
  check('an editor is offered Add a benchmark', !!(await page.$(`${CARD} .sb-add`)));

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nAdding, changing and removing one\n');
  await page.evaluate(sel => document.querySelector(`${sel} .sb-add`).click(), CARD);
  await page.waitForSelector('#sb-form', { state: 'attached' });
  const formAt = await page.evaluate(() => ({
    focus: document.activeElement && document.activeElement.id,
    datums: [...document.querySelectorAll('#sb-datum option')].map(o => o.value),
    source: document.getElementById('sb-source').value,
    otherHidden: document.querySelector('#sb-form .sb-f-other').hidden,
    max: document.getElementById('sb-date').max,
    labelled: [...document.querySelectorAll('#sb-form input, #sb-form select')].every(el => !!el.closest('label')),
  }));
  check('the form opens with the cursor in Level, the datums of the report plus gauge height and another, and the source filled in',
    formAt.focus === 'sb-level' && formAt.datums.join() === 'AHD,ASSUM,STATE,GH,UNKNOWN,OTHER' && formAt.source === 'Entered in Flood-Net'
    && formAt.otherHidden && /^\d{4}-\d\d-\d\d$/.test(formAt.max) && formAt.labelled, J(formAt));
  const press = id => page.evaluate(i => document.getElementById(i).click(), id);
  const fill = (id, v) => page.evaluate(([i, val]) => { document.getElementById(i).value = val; }, [id, v]);
  const error = () => text(page, '#sb-form .sb-error');

  await press('sb-save');
  check('saving it empty asks for the level, and sends nothing', /Give the benchmark's level in metres/.test(await error() || '') && db.rpc.length === 0, await error());
  await fill('sb-level', 'about 3m');
  await press('sb-save');
  check('a level that is not a number is named as such', /has to be a number of metres/.test(await error() || '') && db.rpc.length === 0, await error());
  await fill('sb-level', '102.345');
  await press('sb-save');
  check('…and it asks what the mark is and where', /Say what the mark is and where/.test(await error() || '') && db.rpc.length === 0, await error());
  check('what was typed is kept through each refusal', (await page.evaluate(() => document.getElementById('sb-level').value)) === '102.345');
  await fill('sb-desc', 'Made-up pin in the made-up slab');
  await page.selectOption('#sb-datum', 'OTHER');
  check('picking Another datum shows a box for its name', !(await page.evaluate(() => document.querySelector('#sb-form .sb-f-other').hidden)));
  await press('sb-save');
  check('…which has to be filled in', /Say which datum it is/.test(await error() || '') && db.rpc.length === 0, await error());
  await page.selectOption('#sb-datum', 'AHD');
  await fill('sb-date', '2999-01-01');
  await press('sb-save');
  check('a date surveyed in the future is refused', /in the future/.test(await error() || '') && db.rpc.length === 0, await error());
  await fill('sb-date', '2026-11-01');
  await fill('sb-comment', 'Made-up comment');
  await press('sb-save');
  await page.waitForFunction(sel => !!document.querySelector(`${sel} .sb-entered li`), CARD, { timeout: 15_000 });
  const sent = db.rpc[0] || {};
  check('Save sends what was typed to station_benchmark_entry_save, signed in, for this station',
    db.rpc.length === 1 && sent.fn === 'save' && sent.signed && J(sent.p) === J({ station_id: river.id, level_m: '102.345', datum: 'AHD', datum_other: '',
      description: 'Made-up pin in the made-up slab', comment: 'Made-up comment', surveyed_on: '2026-11-01', source: 'Entered in Flood-Net' }), J(sent));
  t = await text(page, `${CARD} .sb-entered`);
  check('the new benchmark is in the list at once, to the millimetre, with its date, source and who entered it',
    /102\.345 m AHD · on the gauge 3\.585/.test(t) && /Made-up pin in the made-up slab/.test(t) && /Made-up comment/.test(t)
    && /Surveyed 01\/11\/2026 · Source: Entered in Flood-Net · entered by editor@example\.com on 10\/11\/2026/.test(t), t);
  check('…under its own heading, apart from the Bureau\'s, and the form is gone',
    /Entered in Flood-Net:/.test(await text(page, CARD)) && !(await page.$('#sb-form'))
    && (await page.evaluate(sel => document.querySelectorAll(`${sel} .sb-bureau li`).length, CARD)) === 2);
  check('the Bureau\'s benchmarks have no Change or Remove; the entered one has both',
    await page.evaluate(sel => !document.querySelector(`${sel} .sb-bureau .sb-change, ${sel} .sb-bureau .sb-remove`)
      && !!document.querySelector(`${sel} .sb-entered .sb-change`) && !!document.querySelector(`${sel} .sb-entered .sb-remove`), CARD));

  // A gauge height: on the gauge as itself, said once.
  await page.evaluate(sel => document.querySelector(`${sel} .sb-add`).click(), CARD);
  await fill('sb-level', '2,5');
  await page.selectOption('#sb-datum', 'GH');
  await fill('sb-desc', 'Made-up mark at the foot of the post');
  await fill('sb-source', 'Made-up level run');
  await press('sb-save');
  await page.waitForFunction(sel => document.querySelectorAll(`${sel} .sb-entered li`).length === 2, CARD, { timeout: 15_000 });
  t = await text(page, `${CARD} .sb-entered li:nth-child(2)`);
  check('a gauge height is entered with a comma or a point, and reads as a gauge height from its source',
    db.rpc[1].p.level_m === '2.5' && db.rpc[1].p.datum === 'GH' && /^2\.50 m gauge height/.test(t) && !/on the gauge/.test(t) && /Source: Made-up level run/.test(t), t);

  // Change.
  await page.evaluate(sel => document.querySelector(`${sel} .sb-entered li .sb-change`).click(), CARD);
  await page.waitForSelector('#sb-form', { state: 'attached' });
  const pre = await page.evaluate(() => ['sb-level', 'sb-datum', 'sb-desc', 'sb-comment', 'sb-date', 'sb-source'].map(i => document.getElementById(i).value));
  check('Change opens the form with what the benchmark holds',
    pre.join('|') === '102.345|AHD|Made-up pin in the made-up slab|Made-up comment|2026-11-01|Entered in Flood-Net', pre.join('|'));
  await fill('sb-level', '102.35');
  db.failSave = 500;
  await press('sb-save');
  await page.waitForSelector('#sb-form .sb-error', { state: 'attached' });
  check('a save the database refuses says so and keeps the form', /Not saved — made-up failure/.test(await error() || '')
    && (await page.evaluate(() => document.getElementById('sb-level').value)) === '102.35', await error());
  db.failSave = 0;
  await press('sb-save');
  await page.waitForFunction(sel => /102\.35 m AHD/.test((document.querySelector(`${sel} .sb-entered`) || {}).textContent || ''), CARD, { timeout: 15_000 });
  const change = db.rpc[db.rpc.length - 1];
  check('…and saving the change sends the benchmark\'s id', change.fn === 'save' && change.p.id === db.entered[0].id && change.p.level_m === '102.35'
    && db.entered.length === 2, J(change));

  // Remove.
  await page.evaluate(sel => document.querySelector(`${sel} .sb-entered li .sb-remove`).click(), CARD);
  check('Remove asks first, and removes nothing yet',
    /Remove this benchmark\?/.test(await text(page, `${CARD} .sb-entered li .sb-ask`) || '') && !db.rpc.some(r => r.fn === 'remove'));
  await page.evaluate(sel => document.querySelector(`${sel} .sb-ask button:last-child`).click(), CARD);
  check('Keep keeps it', !(await page.$(`${CARD} .sb-ask`)) && db.entered.length === 2);
  const firstId = db.entered[0].id;
  await page.evaluate(sel => document.querySelector(`${sel} .sb-entered li .sb-remove`).click(), CARD);
  await page.evaluate(sel => document.querySelector(`${sel} .sb-remove-yes`).click(), CARD);
  await page.waitForFunction(sel => document.querySelectorAll(`${sel} .sb-entered li`).length === 1, CARD, { timeout: 15_000 });
  const removed = db.rpc[db.rpc.length - 1];
  check('Remove sends that benchmark\'s id to station_benchmark_entry_remove, and it leaves the list',
    removed.fn === 'remove' && removed.id === firstId && removed.signed
    && !/102\.35/.test(await text(page, CARD)) && /2\.50 m gauge height/.test(await text(page, CARD)), J(removed));

  // Use in a Level Survey.
  const use = await page.evaluate(([id, key]) => ({
    entered: StationBenchmarks.pick(id, key),
    bureau: StationBenchmarks.pick(id, 0),
    list: StationBenchmarks.listHtml(id, { use: 'LevelSurvey.useBureauBm' }),
  }), [river.id, db.entered[0].id]);
  check('the Level Survey\'s Use takes an entered benchmark too: a gauge height is booked on the gauge, with where it came from',
    use.entered && use.entered.datum === 'LGH' && use.entered.rl === 2.5 && /^Made-up level run: 2\.50 m on the gauge$/.test(use.entered.source)
    && use.bureau && use.bureau.datum === 'AHD' && use.bureau.name === 'PSM 990001'
    && use.list.includes(`LevelSurvey.useBureauBm('${river.id}', '${db.entered[0].id}')`) && use.list.includes(`LevelSurvey.useBureauBm('${river.id}', 0)`),
    J([use.entered, use.bureau]));

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nThe station editor\n');
  await page.evaluate(id => { if (state.selectedId !== id) selectStation(id); }, river.id);
  const ED = `#ef-bm-${river.id}`;
  await page.waitForSelector(`${ED} .sb-list li`, { state: 'attached', timeout: 15_000 });
  t = await text(page, ED);
  check('the editor has the station\'s benchmarks: the Bureau\'s with their words, and the entered one',
    /104\.26 m AHD/.test(t) && /PSM 990001 made-up plaque/.test(t) && /8\.57 m assumed/.test(t) && /2\.50 m gauge height/.test(t)
    && /\(HDB, printed 15\/10\/2026\)/.test(t), t);
  check('…under a Benchmarks heading with a meaning on hover, which says a benchmark is saved on its own',
    await page.evaluate(() => {
      const sect = document.querySelector('.ef-bm');
      const head = sect.querySelector('.ef-sub .term');
      return !!head && head.textContent === 'Benchmarks' && head.title.length > 40 && /does not wait for the station's Save/.test(sect.textContent.replace(/\s+/g, ' '));
    }));
  const before = db.rpc.length;
  await page.evaluate(sel => document.querySelector(`${sel} .sb-add`).click(), ED);
  await page.waitForSelector(`${ED} #sb-form`, { state: 'attached' });
  await page.fill('#sb-level', '55.5');
  await page.fill('#sb-desc', 'Made-up nail in the made-up kerb');
  const bar = await page.evaluate(() => {
    if (typeof editorUnsavedRefresh === 'function') editorUnsavedRefresh();
    const el = document.getElementById('ef-unsaved');
    return { hidden: !el || el.hidden, ignored: !!document.getElementById('sb-form').closest('[data-ef-ignore]') };
  });
  check('typing a benchmark is not counted as an unsaved edit to the station', bar.hidden && bar.ignored, J(bar));
  await page.press('#sb-desc', 'Enter');
  await page.waitForFunction(sel => document.querySelectorAll(`${sel} .sb-entered li`).length === 2, ED, { timeout: 15_000 });
  check('Enter in a box saves the benchmark — one call, for this station — and it is in the editor\'s list',
    db.rpc.length === before + 1 && db.rpc[before].p.station_id === river.id && db.rpc[before].p.level_m === '55.5'
    && /55\.50 m AHD/.test(await text(page, ED)), J(db.rpc[before]));
  check('…and in the open card\'s list too, without asking for the card again',
    !(await page.$(CARD)) || /55\.50 m AHD/.test(await text(page, CARD) || ''));
  check('the station itself was not saved or marked changed by any of it',
    await page.evaluate(() => { const el = document.getElementById('ef-unsaved'); return !el || el.hidden; }));

  await page.evaluate(() => editorNew());
  await page.waitForSelector('.ef-bm', { state: 'attached' });
  t = await text(page, '.ef-bm');
  check('a station not saved yet is told to save first, and offered no Add',
    /Save the station first; its benchmarks can be added after/.test(t) && !(await page.$('.ef-bm .sb-add')), t);

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nThe edges\n');
  if (plain) {
    await showCard(page, plain.id);
    await page.waitForFunction(() => true);
    await page.waitForTimeout(400);
    const empty = await page.evaluate(id => {
      const el = document.getElementById(`mn-bm-card-${id}`);
      return el ? el.innerHTML.trim() : '(no section)';
    }, plain.id);
    check('a station with no river gauge and no benchmarks has no Benchmarks section on its card, even for an editor', empty === '', empty.slice(0, 200));
  }
  // A river gauge with none yet: an editor is offered Add, under a line saying so.
  const other = STATIONS.find(s => s.id !== river.id && (s.flood_classes || []).length && s.lat != null);
  await showCard(page, other.id);
  await page.waitForSelector(`#mn-bm-card-${other.id} .sb-add`, { state: 'attached', timeout: 15_000 });
  t = await text(page, `#mn-bm-card-${other.id}`);
  check('a river gauge with no benchmarks yet says so, and offers an editor Add', /No benchmarks are recorded for this station yet/.test(t), t);

  // A database before 0110.
  db.noEntries = true;
  await page.evaluate(id => StationBenchmarks.ask(id, { again: true }), river.id);
  await showCard(page, river.id);
  await page.waitForSelector(`${CARD} .sb-bureau li`, { state: 'attached', timeout: 15_000 });
  t = await text(page, CARD);
  check('a database that does not keep entered benchmarks yet still shows the Bureau\'s, and says Add is coming instead of offering it',
    /104\.26 m AHD/.test(t) && /Adding a benchmark arrives with the next database update/.test(t) && !(await page.$(`${CARD} .sb-add`)), t);
  db.noEntries = false;

  // Signed in, not an editor: the numbers.
  await as(page, 'viewer');
  await showCard(page, river.id);
  await page.waitForFunction(sel => /shown to signed-in editors/.test((document.querySelector(sel) || {}).textContent || ''), CARD, { timeout: 15_000 });
  t = await text(page, CARD);
  check('somebody signed in who is not an editor is shown the numbers, and no Add',
    /104\.26 m AHD/.test(t) && !/made-up/i.test(t) && !(await page.$(`${CARD} .sb-add`)), t);

  check('no page errors', errors.length === 0, errors.join('\n'));
  await ctx.close();
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? ` — ${failed.length} failed` : ''}\n`);
process.exit(failed.length ? 1 : 0);
