// The river height station details (0031): a station's flood classifications,
// crossings and gauge survey, on the station card and in the station editor,
// driven in a real browser against the committed stations.json.
//
//   1. **The copies agree.** river-details.js carries the crossing-type legend
//      and the datums because the card has to name a code when the datastore
//      is not there to ask; 0031 inserts the same two lists. Held together
//      here, along with the field keys the editor reads and the columns the
//      tables have — a key the form sends that no column holds is a figure
//      save_station() silently drops.
//   2. **The card** says what holds now — the newest flood classification, the
//      gauge zero in force — and puts everything else under Earlier. Nothing
//      for a station the Bureau's lists do not name.
//   3. **The editor** shows every row as a line, opens one to edit, adds a row
//      on top with the cursor in it, removes one without dropping focus on
//      <body>, and — the one that is invisible when it breaks — sends only the
//      lists that changed. An untouched list that went out anyway would come
//      back from the browser's parse with 94.50 as 94.5.
//
// Run:  npm run riverdetails
//       npm run riverdetails -- -v

import fs from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}

const MIGRATION = repo('db/migrations/0031_river_height_details.sql');
const STATIONS  = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;
const LISTS     = ['flood_classes', 'crossings', 'gauge_survey'];
const TABLE     = { flood_classes: 'station_flood_class', crossings: 'station_crossing',
                    gauge_survey: 'station_gauge_survey' };

// The rows of one `insert into meganet.<table> … values (…), (…)` in the
// migration, as arrays of their quoted text.
function insertedRows(sql, table) {
  const m = new RegExp(`insert into meganet\\.${table} \\([^)]*\\) values\\n([\\s\\S]*?)\\non conflict`).exec(sql);
  if (!m) return null;
  return [...m[1].matchAll(/\(([^)]*)\)/g)].map(r =>
    [...r[1].matchAll(/'((?:[^']|'')*)'/g)].map(x => x[1].replace(/''/g, "'")));
}

function tableColumns(sql, table) {
  const m = new RegExp(`create table if not exists meganet\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  if (!m) return [];
  return m[1].split('\n').map(l => /^\s{2}([a-z_0-9]+)\s/.exec(l)).filter(Boolean).map(x => x[1])
    .filter(c => c !== 'primary' && c !== 'constraint');
}

async function openStations(browser, server, errors, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
    null, { timeout: LOAD_TIMEOUT });
  return { context, page };
}

async function main() {
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  // Stations to look at, picked from the file rather than named, so the check
  // follows the data: one with every list and more than one gauge zero, one
  // with none, one whose gauge zero history the Bureau printed backwards.
  const full = STATIONS.find(s => LISTS.every(k => (s[k] || []).length)
    && s.gauge_survey.length > 1 && s.flood_classes.length > 1 && s.lat != null);
  const none = STATIONS.find(s => !LISTS.some(k => s[k]) && s.lat != null);
  const backwards = STATIONS.find(s => (s.gauge_survey || []).some(r =>
    r.valid_from && r.valid_to && r.valid_to < r.valid_from));

  log('\nThe copies agree\n');

  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const { context, page } = await openStations(browser, server, errors, { viewport: { width: 1440, height: 1000 } });

    const js = await page.evaluate(() => ({
      types: RiverDetails.CROSSING_TYPES, datums: RiverDetails.DATUMS, keys: RiverDetails.LIST_KEYS,
    }));
    const sqlTypes = insertedRows(sql, 'crossing_type');
    check('the crossing types are 0031\'s, code and label, in its order',
      sqlTypes && JSON.stringify(sqlTypes.map(r => [r[0], r[1]]))
        === JSON.stringify(js.types.map(t => [t.code, t.label])),
      JSON.stringify({ sql: sqlTypes && sqlTypes.map(r => r[0]), js: js.types.map(t => t.code) }));
    const sqlDatums = insertedRows(sql, 'gauge_datum');
    check('the datums are 0031\'s, code and label, in its order',
      sqlDatums && JSON.stringify(sqlDatums.map(r => [r[0], r[1]]))
        === JSON.stringify(js.datums.map(d => [d.code, d.label])));
    check('the editor edits the three lists the document carries',
      JSON.stringify(js.keys) === JSON.stringify(LISTS), JSON.stringify(js.keys));

    // Every box the form reads has a column to land in — by reading the form's
    // own markup, which is what the save is built from.
    await page.evaluate(id => selectStation(id), full.id);
    await page.waitForSelector('#ef-rhs-flood_classes');
    const formKeys = await page.evaluate(lists => Object.fromEntries(lists.map(k =>
      [k, [...new Set([...document.querySelectorAll(`#ef-rhs-${k} [data-f]`)].map(e => e.dataset.f))]])), LISTS);
    for (const k of LISTS) {
      const cols = tableColumns(sql, TABLE[k]);
      const stray = formKeys[k].filter(f => !cols.includes(f));
      check(`every ${k} box has a column in meganet.${TABLE[k]}`,
        formKeys[k].length && !stray.length, stray.length ? `no column for ${stray.join(', ')}` : '');
    }

    log('\nThe card says what holds now\n');

    await page.evaluate(id => showStationCard(id), full.id);
    const card = await page.evaluate(() => {
      const sect = document.querySelector('#stn-card .stn-card-rhs');
      if (!sect) return null;
      const rows = [...sect.querySelectorAll(':scope > .acma-row')].map(r =>
        [r.children[0].textContent.trim(), r.children[1].textContent.replace(/\s+/g, ' ').trim()]);
      const earlier = sect.querySelector('.stn-card-rhs-earlier');
      return { rows, earlier: earlier ? earlier.querySelectorAll('.acma-row').length : 0,
               summary: earlier ? earlier.querySelector('summary').textContent.trim() : '' };
    });
    check('a station the lists name has the section on its card', !!card, full.id);

    const newest = [...full.flood_classes].sort((a, b) => (b.as_at || '').localeCompare(a.as_at || ''))[0];
    const classes = card && card.rows.find(r => r[0] === 'Flood classes');
    check('the flood classes are the newest edition\'s, dated',
      classes && newest.minor_m != null && classes[1].includes(`minor ${newest.minor_m.toFixed(1)}`)
        && classes[1].includes(`as at ${newest.as_at.slice(8, 10)}/${newest.as_at.slice(5, 7)}/${newest.as_at.slice(0, 4)}`),
      JSON.stringify(classes));

    const inForce = full.gauge_survey.filter(r => !r.valid_to)
      .sort((a, b) => (b.valid_from || '').localeCompare(a.valid_from || ''))[0];
    const zero = card && card.rows.find(r => r[0] === 'Gauge zero');
    check('the gauge zero is the one in force, to the centimetre',
      zero && inForce && zero[1].startsWith(`${inForce.gauge_zero_m.toFixed(2)} m`) && zero[1].includes('since'),
      JSON.stringify({ zero, inForce }));

    check('there is one crossing line per crossing, not one more for Section 4\'s copy',
      card && card.rows.filter(r => r[0] === 'Crossing').length === full.crossings.length,
      JSON.stringify(card && card.rows.filter(r => r[0] === 'Crossing')));

    const expectEarlier = (full.flood_classes.length - 1) + (full.gauge_survey.length - 1);
    check('everything else is under Earlier, and says how much',
      card && card.earlier === expectEarlier && card.summary.includes(String(expectEarlier)),
      JSON.stringify({ got: card && card.earlier, expectEarlier }));

    await page.evaluate(id => showStationCard(id), none.id);
    check('a station none of the lists name has no section at all',
      await page.evaluate(() => !!document.querySelector('#stn-card') && !document.querySelector('#stn-card .stn-card-rhs')),
      none.id);

    log('\nThe editor\n');

    // The editor is in the side panel at this width, behind whichever pane was
    // last showing; revealing it is what "Station details →" on the card does.
    // selectStation() toggles, so it is only asked when the station is not
    // already the selection — the check above left it selected.
    await page.evaluate(id => {
      if (state.selectedId !== id) selectStation(id);
      dockReveal(document.getElementById('stations-editor-card'));
    }, full.id);
    await page.waitForSelector('#ef-rhs-flood_classes .rhs-row');
    const shape = await page.evaluate(lists => lists.map(k => ({
      k,
      rows: document.querySelectorAll(`#ef-rhs-${k} .rhs-row`).length,
      open: document.querySelectorAll(`#ef-rhs-${k} .rhs-row[open]`).length,
      count: document.querySelector(`#ef-rhs-${k} .rhs-count`).textContent.trim(),
    })), LISTS);
    check('every row is on the form, each shut to one line',
      shape.every(x => x.rows === full[x.k].length && x.open === 0 && x.count.includes(String(x.rows))),
      JSON.stringify(shape));

    check('an untouched form sends none of the three lists',
      await page.evaluate(() => {
        const d = editorReadForm();
        return !('flood_classes' in d) && !('crossings' in d) && !('gauge_survey' in d);
      }));

    // Add a flood classification.
    await page.click('#ef-rhs-flood_classes .ef-section-head button');
    check('+ Add puts an open row on top, with the cursor in it',
      await page.evaluate(() => {
        const first = document.querySelector('#ef-rhs-flood_classes .rhs-row');
        return first.open && first.contains(document.activeElement)
          && document.activeElement.dataset.f === 'as_at';
      }));
    check('a row added and left blank is not a change',
      await page.evaluate(() => Object.keys(RiverDetails.readForm(state.editorDraft)).length === 0));

    await page.fill('#ef-rhs-flood_classes .rhs-row [data-f="as_at"]', '2027-03-01');
    await page.fill('#ef-rhs-flood_classes .rhs-row [data-f="minor_m"]', '3.25');
    await page.fill('#ef-rhs-flood_classes .rhs-row [data-f="major_m"]', '8');
    await page.selectOption('#ef-rhs-flood_classes .rhs-row [data-f="crossing_type"]', 'B');
    const summary = await page.evaluate(() =>
      document.querySelector('#ef-rhs-flood_classes .rhs-sum').textContent);
    check('the row\'s one line follows what is typed, and never rounds',
      summary.startsWith('01/03/2027') && summary.includes('minor 3.25') && summary.includes('major 8.0'),
      summary);

    const sent = await page.evaluate(() => {
      const d = editorReadForm();
      return { keys: ['flood_classes', 'crossings', 'gauge_survey'].filter(k => k in d), fc: d.flood_classes };
    });
    check('only the list that changed is sent',
      JSON.stringify(sent.keys) === '["flood_classes"]', JSON.stringify(sent.keys));
    check('…the new row first, keyed as the document keys it',
      sent.fc && sent.fc.length === full.flood_classes.length + 1
        && JSON.stringify(sent.fc[0]) === JSON.stringify({ as_at: '2027-03-01', minor_m: 3.25, major_m: 8, crossing_type: 'B' }),
      JSON.stringify(sent.fc && sent.fc[0]));

    // Remove the crossing.
    await page.evaluate(() => { document.querySelector('#ef-rhs-crossings .rhs-row').open = true; });
    await page.click('#ef-rhs-crossings .rhs-del');
    check('removing a row hands focus to its list\'s + Add, not to <body>',
      await page.evaluate(() => document.activeElement
        && document.activeElement.closest('#ef-rhs-crossings .ef-section-head') !== null));
    const after = await page.evaluate(() => {
      const d = editorReadForm();
      return { crossings: d.crossings, n: document.querySelectorAll('#ef-rhs-crossings .rhs-row').length,
               count: document.querySelector('#ef-rhs-crossings .rhs-count').textContent.trim() };
    });
    check('…and the list goes out one shorter, its count with it',
      Array.isArray(after.crossings) && after.crossings.length === full.crossings.length - 1
        && after.n === full.crossings.length - 1,
      JSON.stringify(after));

    // A box the browser cannot read.
    await page.evaluate(() => {
      const row = document.querySelector('#ef-rhs-gauge_survey .rhs-row');
      row.open = false;
      const i = row.querySelector('[data-f="gauge_zero_m"]');
      i.value = '';
      i.focus();
    });
    await page.evaluate(() => { document.querySelector('#ef-rhs-gauge_survey .rhs-row').open = true; });
    await page.focus('#ef-rhs-gauge_survey .rhs-row [data-f="gauge_zero_m"]');
    await page.keyboard.type('-');
    const problem = await page.evaluate(() => RiverDetails.formProblem());
    check('a figure the browser cannot read stops the save and is named',
      problem && problem.includes('Gauge survey, row 1') && problem.includes('Gauge zero'), problem || '(none)');

    // The Bureau's backwards period is shown, not hidden.
    if (backwards) {
      await page.evaluate(id => { if (state.selectedId !== id) selectStation(id); }, backwards.id);
      await page.waitForSelector('#ef-rhs-gauge_survey .rhs-row', { state: 'attached' });
      check('a period printed backwards is said so on its row',
        await page.evaluate(() => [...document.querySelectorAll('#ef-rhs-gauge_survey .rhs-flag')]
          .some(p => /before the From date/.test(p.textContent))),
        backwards.id);
    }

    await context.close();

    log('\nThe phone\n');

    const phone = await openStations(browser, server, errors, { viewport: { width: 375, height: 800 } });
    await phone.page.evaluate(id => { if (state.selectedId !== id) selectStation(id); showStationCard(id); }, full.id);
    await phone.page.evaluate(() => {
      for (const d of document.querySelectorAll('.rhs-row, .stn-card-rhs-earlier')) d.open = true;
    });
    const w = await phone.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    check('at 375 px, every row open, the page does not scroll sideways', w[0] <= w[1], JSON.stringify(w));
    const spill = await phone.page.evaluate(() => [...document.querySelectorAll('.rhs-fields')].some(g => {
      const r = g.getBoundingClientRect();
      return [...g.querySelectorAll('input, select, button')].some(c => {
        const b = c.getBoundingClientRect();
        return b.width && (b.left < r.left - 1 || b.right > r.right + 1);
      });
    }));
    check('…and no box spills out of its row', !spill);
    await phone.context.close();

    check('nothing threw for the whole run', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).\n`);
  if (failed.length) {
    log(`FAIL — ${failed.length} of them.`);
    process.exit(1);
  }
  log('PASS — the card says what holds now, the editor edits every row, and a save');
  log('       sends only what changed.');
}

main().catch(e => { console.error(e); process.exit(1); });
