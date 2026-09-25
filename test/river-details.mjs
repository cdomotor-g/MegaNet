// The Bureau's flood warning details (0031, 0032): a station's index listings,
// AWRC number, stream and URBS label, flood classifications, crossings, gauge
// survey and flood effects, on the station card and in the station editor,
// driven in a real browser against the committed stations.json.
//
//   1. **The copies agree.** river-details.js carries the crossing-type legend,
//      the datums and the Bureau's indexes because the card has to name a code
//      when the datastore is not there to ask; 0031 and 0032 insert the same
//      lists. Held together here, along with the field keys the editor reads
//      and the columns the tables have — a key the form sends that no column
//      holds is a figure save_station() silently drops.
//   2. **The card** says what holds now — the indexes that list the station,
//      the newest flood classification, the gauge zero in force, the flood
//      effects of the newest edition — and puts everything else under Earlier.
//      Nothing for a station the Bureau's lists do not name.
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
const MIGRATION_32 = repo('db/migrations/0032_bureau_station_lists.sql');
const STATIONS  = JSON.parse(fs.readFileSync(repo('stations.json'), 'utf8')).stations;
const LISTS     = ['bureau_listings', 'flood_classes', 'crossings', 'gauge_survey', 'flood_effects'];
const FIELDS    = ['awrc_number', 'stream', 'urbs_label'];
const TABLE     = { flood_classes: 'station_flood_class', crossings: 'station_crossing',
                    gauge_survey: 'station_gauge_survey', bureau_listings: 'station_bureau_listing',
                    flood_effects: 'station_flood_effect', aep_levels: 'station_aep_level' };
// The sixth list the editor carries, the AEP flood levels, is 0033's.
const MIGRATION_0033 = repo('db/migrations/0033_aep_levels_and_frequencies.sql');
const EDITOR_LISTS = [...LISTS, 'aep_levels'];

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
  const sql = fs.readFileSync(MIGRATION, 'utf8') + '\n' + fs.readFileSync(MIGRATION_32, 'utf8');
  const sql33 = fs.readFileSync(MIGRATION_0033, 'utf8');

  // Stations to look at, picked from the file rather than named, so the check
  // follows the data: one with every list, every field and more than one gauge
  // zero, one with none, one whose gauge zero history the Bureau printed
  // backwards.
  const full = STATIONS.find(s => LISTS.every(k => (s[k] || []).length)
    && FIELDS.every(k => s[k])
    && s.gauge_survey.length > 1 && s.flood_classes.length > 1 && s.lat != null);
  const none = STATIONS.find(s => !LISTS.some(k => s[k]) && !FIELDS.some(k => s[k]) && s.lat != null);
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
      indexes: RiverDetails.BUREAU_INDEXES, fields: RiverDetails.FIELD_KEYS,
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
    const sqlIndexes = insertedRows(sql, 'bureau_index');
    check('the Bureau\'s indexes are 0032\'s, code and label, in its order',
      sqlIndexes && JSON.stringify(sqlIndexes.map(r => [r[0], r[1]]))
        === JSON.stringify(js.indexes.map(i => [i.code, i.label])),
      JSON.stringify({ sql: sqlIndexes, js: js.indexes }));
    check('the editor edits the six lists the document carries — the Bureau\'s five and the AEP levels',
      JSON.stringify(js.keys) === JSON.stringify(EDITOR_LISTS), JSON.stringify(js.keys));
    const added = [...sql.matchAll(/alter table meganet\.station add column if not exists ([a-z_0-9]+) /g)].map(m => m[1]);
    check('…and the three fields, each a column 0032 adds to meganet.station',
      JSON.stringify(js.fields) === JSON.stringify(FIELDS) && FIELDS.every(f => added.includes(f)),
      JSON.stringify({ js: js.fields, added }));

    // Every box the form reads has a column to land in — by reading the form's
    // own markup, which is what the save is built from.
    await page.evaluate(id => selectStation(id), full.id);
    await page.waitForSelector('#ef-rhs-flood_classes');
    const formKeys = await page.evaluate(lists => Object.fromEntries(lists.map(k =>
      [k, [...new Set([...document.querySelectorAll(`#ef-rhs-${k} [data-f]`)].map(e => e.dataset.f))]])), LISTS);
    // The AEP list's boxes are the spec's, read off the module: `full` has no
    // AEP row to draw them from.
    formKeys.aep_levels = await page.evaluate(() => {
      RiverDetails.addRow('aep_levels');
      const keys = [...new Set([...document.querySelectorAll('#ef-rhs-aep_levels [data-f]')].map(e => e.dataset.f))];
      document.querySelector('#ef-rhs-aep_levels .rhs-row .rhs-del').click();
      return keys;
    });
    for (const k of EDITOR_LISTS) {
      const cols = tableColumns(k === 'aep_levels' ? sql33 : sql, TABLE[k]);
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
      const effects = sect.querySelector('.stn-card-rhs-effects');
      const block = sect.querySelector('.stn-card-rhs-classes');
      const head = sect.querySelector('.stn-card-rhs-head');
      const colour = sel => { const e = block && block.querySelector(sel); return e ? getComputedStyle(e).color : null; };
      return { rows, earlier: earlier ? earlier.querySelectorAll('.acma-row').length : 0,
               afterHead: head && head.nextElementSibling ? head.nextElementSibling.textContent.trim() : '',
               classesHead: block ? [...block.querySelectorAll(':scope > span')].slice(0, 2).map(e => e.textContent.trim()).join(' ') : '',
               classLines: block ? [...block.querySelectorAll('.mn-pop-line')].map(e => e.textContent.trim()) : [],
               colours: { minor: colour('.rhs-minor'), moderate: colour('.rhs-moderate'), major: colour('.rhs-major') },
               summary: earlier ? earlier.querySelector('summary').textContent.trim() : '',
               effects: effects ? [...effects.querySelectorAll('.acma-row')].map(r =>
                 [r.children[0].textContent.trim(), r.children[1].textContent.replace(/\s+/g, ' ').trim()]) : null,
               effectsSummary: effects ? effects.querySelector('summary').textContent.trim() : '',
               effectsOpen: effects ? effects.open : null };
    });
    check('a station the lists name has the section on its card', !!card, full.id);

    check('"Hdb snapshot 26/9/26" is the line under the section\'s heading',
      card && card.afterHead === 'Hdb snapshot 26/9/26', card && card.afterHead);

    const listed = card && card.rows.find(r => r[0] === 'Bureau lists');
    const labels = { 1: 'FloodWarn rainfall', 2: 'Daily rainfall', 3: 'River height' };
    check('the indexes that list it are named, in section order',
      listed && [...new Set(full.bureau_listings.map(l => l.section))].sort()
        .map(k => labels[k]).join(' · ')
        === listed[1].replace(/ as at .*$/, '').replace(/ \d{2}\/\d{2}\/\d{4}/g, ''),
      JSON.stringify({ listed, rows: full.bureau_listings }));
    check('its AWRC number, stream and URBS label are on the card, as recorded',
      card && FIELDS.every((k, i) => {
        const r = card.rows.find(x => x[0] === ['AWRC number', 'Stream', 'URBS label'][i]);
        return r && r[1] === full[k];
      }), JSON.stringify(card && card.rows.slice(0, 5)));

    const editionOf = rows => rows.filter(e => e.as_at === [...rows].map(r => r.as_at || '').sort().reverse()[0]);
    const effectsNow = editionOf(full.flood_effects);
    check('the flood effects are shut behind their own line, which counts them',
      card && card.effects && card.effectsOpen === false
        && card.effectsSummary.includes(`${effectsNow.length} height`),
      JSON.stringify({ summary: card && card.effectsSummary, n: effectsNow.length }));
    check('…each a height to the centimetre against what it means, in the page\'s order',
      card && card.effects && effectsNow.every((e, i) => card.effects[i]
        && card.effects[i][0] === `${Number(e.height_m).toFixed(2)} m`
        && card.effects[i][1].startsWith(e.effect || e.detail || '')),
      JSON.stringify({ card: card && card.effects && card.effects.slice(0, 3), rows: effectsNow.slice(0, 3) }));

    const newest = [...full.flood_classes].sort((a, b) => (b.as_at || '').localeCompare(a.as_at || ''))[0];
    const want = [['Minor', newest.minor_m], ['Moderate', newest.moderate_m], ['Major', newest.major_m]]
      .filter(([, v]) => v != null).map(([k, v]) => `${k} ${v.toFixed(1)} m`);
    check('the newest edition\'s minor, moderate and major are a line each, like the AlertIDs',
      card && want.length && JSON.stringify(card.classLines) === JSON.stringify(want)
        && !card.rows.some(r => r[0] === 'Flood classes'),
      JSON.stringify({ got: card && card.classLines, want }));
    check('…dated by the edition they came from',
      card && card.classesHead.includes(`as at ${newest.as_at.slice(8, 10)}/${newest.as_at.slice(5, 7)}/${newest.as_at.slice(0, 4)}`),
      card && card.classesHead);

    // Green, yellow, red: read as hues off the computed colours, so a palette
    // retuned for contrast still passes and a swapped pair does not.
    const hue = rgb => {
      const [r, g, b] = (rgb || '').match(/\d+/g).slice(0, 3).map(n => Number(n) / 255);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (!d) return null;
      const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const hues = card && Object.fromEntries(Object.entries(card.colours).map(([k, v]) => [k, v && hue(v)]));
    check('…minor in green, moderate in yellow, major in red',
      hues && hues.minor > 90 && hues.minor < 150 && hues.moderate > 40 && hues.moderate < 65
        && (hues.major < 15 || hues.major > 345),
      JSON.stringify({ colours: card && card.colours, hues }));

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

    check('an untouched form sends none of the six lists',
      await page.evaluate(lists => {
        const d = editorReadForm();
        return lists.every(k => !(k in d));
      }, EDITOR_LISTS));
    check('…and carries the three fields as they were',
      await page.evaluate(([fields, rec]) => {
        const d = editorReadForm();
        return fields.every(k => d[k] === rec[k]);
      }, [FIELDS, { awrc_number: full.awrc_number, stream: full.stream, urbs_label: full.urbs_label }]));

    // The fields: a blank box is no key, a changed one is the new value.
    await page.fill('#ef-urbs', '  NEW_LBL ');
    await page.fill('#ef-awrc', '');
    const fieldsSent = await page.evaluate(() => {
      const d = editorReadForm();
      return { urbs: d.urbs_label, awrc: 'awrc_number' in d, stream: d.stream };
    });
    check('a field typed into is sent trimmed, one emptied is no key at all',
      fieldsSent.urbs === 'NEW_LBL' && fieldsSent.awrc === false && fieldsSent.stream === full.stream,
      JSON.stringify(fieldsSent));
    await page.fill('#ef-urbs', full.urbs_label);
    await page.fill('#ef-awrc', full.awrc_number);

    // A flood effect, added.
    await page.click('#ef-rhs-flood_effects .ef-section-head button');
    await page.fill('#ef-rhs-flood_effects .rhs-row [data-f="height_m"]', '12.50');
    await page.fill('#ef-rhs-flood_effects .rhs-row [data-f="effect"]', 'Bridge');
    await page.fill('#ef-rhs-flood_effects .rhs-row [data-f="detail"]', 'Test Road Bridge');
    const eff = await page.evaluate(() => ({
      sum: document.querySelector('#ef-rhs-flood_effects .rhs-sum').textContent,
      sent: RiverDetails.readForm(state.editorDraft),
    }));
    check('a flood effect added reads as its height and effect, and only its list is sent',
      eff.sum === '12.50 m — Bridge (Test Road Bridge)'
        && JSON.stringify(Object.keys(eff.sent)) === '["flood_effects"]'
        && JSON.stringify(eff.sent.flood_effects[0]) === JSON.stringify({ height_m: 12.5, effect: 'Bridge', detail: 'Test Road Bridge' })
        && eff.sent.flood_effects.length === full.flood_effects.length + 1,
      JSON.stringify({ sum: eff.sum, first: eff.sent.flood_effects && eff.sent.flood_effects[0] }));
    await page.click('#ef-rhs-flood_effects .rhs-row .rhs-del');

    // A listing: the index is a pick-list of the Bureau's three.
    await page.click('#ef-rhs-bureau_listings .ef-section-head button');
    const pick = await page.evaluate(() => [...document.querySelectorAll(
      '#ef-rhs-bureau_listings .rhs-row:first-child [data-f="section"] option')].map(o => o.value));
    check('a new listing picks its index from the Bureau\'s three',
      JSON.stringify(pick) === '["","1","2","3"]', JSON.stringify(pick));
    await page.click('#ef-rhs-bureau_listings .rhs-row .rhs-del');

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

    const sent = await page.evaluate(lists => {
      const d = editorReadForm();
      return { keys: lists.filter(k => k in d), fc: d.flood_classes };
    }, EDITOR_LISTS);
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
      for (const d of document.querySelectorAll('.rhs-row, .stn-card-rhs-earlier, .stn-card-rhs-effects')) d.open = true;
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
  log('PASS — the card says what holds now, the editor edits every row and field,');
  log('       and a save sends only what changed.');
}

main().catch(e => { console.error(e); process.exit(1); });
