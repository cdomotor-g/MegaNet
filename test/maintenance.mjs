// The Site Maintenance tab, rendered against the workbook's own filled sheet (#117).
//
// Why this is a check of its own rather than another tab in `npm run smoke`,
// and why it is separate from `npm run insp`.
//
// The first half of the answer is #116's: smoke's network policy aborts every
// off-origin request, and this tab renders *from* the datastore — every
// pick-list on it is a lookup table. Under smoke's policy it correctly renders
// "the form's pick-lists could not be loaded", and a form nobody drew passes.
// So this test supplies the reference data instead of blocking it, out of
// `db/migrations/0009_inspections.sql` rather than out of a copy of it.
//
// The second half is what makes this test different from `npm run insp`. The
// inspection form's claim is *the matrix decides what prints*, so its test
// renders the matrix. This form's claim is different — there is one Council
// sheet, its layout does not vary, and what it claims is **fidelity to a piece
// of paper**. The workbook has the piece of paper: `Council Maintenance Tasks`
// blank, and `Council Maint Tasks Mt Kanigan` filled in at a real station. So
// this test reads both sheets out of `archive/Inspection sheets for
// printing.xlsx` (lib/xlsx.mjs) and drives the filled one through the form.
//
// That gives the check its two strongest assertions, neither of which a
// hand-written fixture could make:
//
//   · Every cell where the filled sheet differs from the blank template is
//     either mapped onto a field or **named here as unmapped**. A value
//     somebody typed on that sheet cannot go missing quietly, and if the
//     workbook is ever replaced with a fuller example this fails until
//     somebody looks at it.
//   · Every pick-list cell on the sheet resolves against the migration's own
//     `label` — which is #117's "one source of truth, not a parallel list",
//     checked rather than asserted. The workbook says "Poor (add comments
//     below)"; `meganet.condition_rating` says it too, and that is why the key
//     is `poor`.
//
// What it asserts:
//
//   1. The workbook parsed, and the filled sheet differs from the blank one in
//      exactly the cells this file accounts for.
//   2. Every printed pick-list value resolves to a row in the lookup table the
//      form reads — the Council form and the inspection form share them.
//   3. The tab renders the nine sections in the sheet's print order, and every
//      `on*=` handler it rendered resolves in page scope.
//   4. A blank form materialises the three asset panels and the two
//      data-quality rows, states no uncaptured box, and prints the Comms and
//      Power panel as the three sub-blocks the sheet prints (0011 / #148). The
//      sub-block assertion is the one that matters: the diff in 1 cannot see
//      those four boxes, because the blank and filled sheets agree on them.
//   5. Opening the Mt Kanigan record puts every filled value on screen, in the
//      control that belongs to it — read back out of the DOM, not out of state.
//   6. Saving it round-trips the document unchanged, prunes the panels nobody
//      filled in, and strips the keys the panel's check constraints refuse.
//   7. The printed cross-reference works in both directions: the outstanding
//      list starts a form linked to the visit, and the button at the foot of an
//      inspection that departed poor lands on this tab with the link made.
//   8. The two boxes on this sheet that are images rather than fields — the
//      canister screenshot and the benchmark photo — are attachment panels on
//      the sections that print them, each listing only its own role, and a file
//      sent to one indexes against the activity under a generated object name
//      rather than the camera's (#149).
//
// Run:  npm run maint
//       npm run maint -- -v    also print what passed

import { repo } from './lib/paths.mjs';
import { formFixture } from './lib/migration.mjs';
import { openWorkbook } from './lib/xlsx.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { auditHandlers } from './lib/controls.mjs';
import { storageStore, installStorage, attachmentRpc, attachmentRows, fileOf }
  from './lib/storage.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const SETTLE = Number(process.env.SMOKE_TAB_SETTLE || 300);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── The sheet, cell by cell ──────────────────────────────────────────────────
//
// Where each printed box lives on `Council Maint Tasks Mt Kanigan`, and which
// column of 0009 it belongs to. A `select` entry names the lookup table its
// printed words have to resolve against; `text` is free text.
//
// Only boxes that carry a value on one of the two sheets are here, and that is
// a deliberate limit rather than an oversight. The sheet is a merged-cell grid
// with no borders, so a label's value box is found by *where the value is* —
// under the label in the left-hand blocks, beside it in the contact block. For
// a box that is empty on both sheets there is no value to locate it by, and a
// guessed cell reference is worse than none: it would read as a fact and could
// silently point at the wrong box for years. Those fields are covered by the
// render assertions below instead, which check the form draws a control for
// every column, filled or not.

const WORKBOOK = repo('archive', 'Inspection sheets for printing.xlsx');
const BLANK = 'Council Maintenance Tasks';
const FILLED = 'Council Maint Tasks Mt Kanigan';

const ASSET_CELLS = {
  rainfall: {
    rain_instrument_type_key: ['A9',  'rain_instrument_type'],
    condition_key:            ['A11', 'condition_rating'],
    owner_key:                ['A13', 'asset_owner'],
    comments:                 ['A15', 'text'],
  },
  water_level: {
    wl_instrument_type_key:   ['K9',  'wl_instrument_type'],
    condition_key:            ['K11', 'condition_rating'],
    owner_key:                ['K13', 'asset_owner'],
    comments:                 ['K16', 'text'],
  },
  // Three sub-columns, three Conditons (the sheet's spelling) and three Owners —
  // six boxes, all six mapped since 0011 (#148). `condition_key` and `owner_key`
  // are the Comms sub-column's here; on the two panels above they are the whole
  // panel's, because those print one of each.
  //
  // Note what the diff assertion below can and cannot say about these four. The
  // blank template and the filled Mt Kanigan sheet carry the *same* words in
  // Y11/AC11/Y13/AC13, so no difference between the sheets rests on them and the
  // diff would pass whether or not they were mapped. What proves #148 landed is
  // the DOM check further down: four more controls on screen, showing what the
  // sheet says.
  comms_power: {
    comms_method_key:         ['U9',  'comms_method'],
    condition_key:            ['U11', 'condition_rating'],
    owner_key:                ['U13', 'asset_owner'],
    comms_equipment_key:      ['Y9',  'comms_equipment'],
    equipment_condition_key:  ['Y11', 'condition_rating'],
    equipment_owner_key:      ['Y13', 'asset_owner'],
    power_key:                ['AC9', 'power_supply'],
    power_condition_key:      ['AC11', 'condition_rating'],
    power_owner_key:          ['AC13', 'asset_owner'],
    comments:                 ['U16', 'text'],
  },
};

const TOP_CELLS = {
  gauge_boards_present:       ['A25', 'yes_no'],
  gauge_boards_condition_key: ['A27', 'condition_rating'],
  gauge_boards_owner_key:     ['A29', 'asset_owner'],
  benchmark_surveyed:         ['A33', 'yes_no'],
};

const DQ_CELLS = {
  rainfall:    { on_arrival_key: ['E42', 'data_quality_rating'],
                 on_departure_key: ['E44', 'data_quality_rating'] },
  river_level: { on_arrival_key: ['O42', 'data_quality_rating'],
                 on_departure_key: ['O44', 'data_quality_rating'] },
};

// Filled cells on the Mt Kanigan sheet that no column holds, with the reason.
// The diff assertion below requires every difference between the two sheets to
// be either mapped above or named here, so this list is the complete account of
// what the digitised form does not carry.
const UNMAPPED = {
  F8: 'An unlabelled annotation in the Rainfall panel ("HS") — it sits in a blank merged area '
    + 'with no printed label, is not in #78\'s transcription either, and there is no box on the '
    + 'paper for it to be the value of. Recorded here rather than guessed at.',
};

// ── Building the document the form should hold ───────────────────────────────

function keyFor(tables, table, label) {
  // The workbook's own words, resolved against the migration's own rows. A
  // trailing space in either is the spreadsheet's, not a different value —
  // 0009's foot says the same about `Poor Quality `.
  const want = String(label).trim();
  const row = (tables[table] || []).find(r => String(r.label).trim() === want);
  return row ? row.key : null;
}

function cellValue(tables, cells, spec, misses) {
  const [ref, table] = spec;
  const raw = cells[ref];
  if (raw == null || raw === '') return { ref, value: table === 'text' ? '' : null };
  if (table === 'text') return { ref, value: raw };
  if (table === 'yes_no') {
    const key = keyFor(tables, 'yes_no', raw);
    if (key == null) misses.push(`${ref} "${raw}" is not in meganet.yes_no`);
    return { ref, value: key == null ? null : key === 'yes' };
  }
  const key = keyFor(tables, table, raw);
  if (key == null) misses.push(`${ref} "${raw}" is not in meganet.${table}`);
  return { ref, value: key };
}

function buildMtKanigan(tables, cells) {
  const misses = [];
  const used = new Set();
  const take = spec => {
    const { ref, value } = cellValue(tables, cells, spec, misses);
    used.add(ref);
    return value;
  };

  const doc = {
    id: '00000000-0000-4000-8000-0000000000aa',
    station_id: null,
    inspection_id: null,
    station_name: 'Mt Kanigan',
    cbm_no: '',
    visited_on: '2026-08-01',
    recorded_by: '',
    council_key: null,
    council_contact_name: '', council_contact_email: '', council_contact_phone: '',
    council_comments: '',
    landowner_contact_name: '', landowner_contact_email: '', landowner_contact_phone: '',
    landowner_comments: '',
    benchmark_present: null,
    gauge_boards_comments: '',
    access_whs_comments: '',
    remarks: '',
    trigger_reason: '',
    origin: 'import',
    source_ref: 'workbook:Council Maint Tasks Mt Kanigan',
    updated_at: '2026-08-13T00:00:00Z',
    assets: [], data_quality: [], attachments: [],
  };

  for (const [col, spec] of Object.entries(TOP_CELLS)) doc[col] = take(spec);

  for (const [asset, cols] of Object.entries(ASSET_CELLS)) {
    const row = { asset, rain_instrument_type_key: null, wl_instrument_type_key: null,
                  condition_key: null, owner_key: null, comms_method_key: null,
                  comms_equipment_key: null, power_key: null,
                  equipment_condition_key: null, equipment_owner_key: null,
                  power_condition_key: null, power_owner_key: null, comments: '' };
    for (const [col, spec] of Object.entries(cols)) row[col] = take(spec);
    doc.assets.push(row);
  }

  for (const [parameter, cols] of Object.entries(DQ_CELLS)) {
    const row = { parameter, on_arrival_key: null, on_departure_key: null, comments: '' };
    for (const [col, spec] of Object.entries(cols)) row[col] = take(spec);
    doc.data_quality.push(row);
  }

  return { doc, misses, used };
}

// ── The datastore, answered from the fixture ─────────────────────────────────

function installDatastore(page, tables, state, store) {
  return page.route('**://*.supabase.co/rest/v1/**', async route => {
    const url = new URL(route.request().url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (status, body) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (route.request().method() === 'POST' && name.startsWith('rpc/')) {
      const fn = name.slice(4);
      const body = JSON.parse(route.request().postData() || '{}');
      const att = attachmentRpc(fn, body, store);
      if (att !== undefined) return json(200, att);
      if (fn === 'maintenance_activity_doc') {
        return json(200, body.p_id === state.doc.id ? state.doc : null);
      }
      if (fn === 'save_maintenance_activity') {
        state.saved.push(body.p_doc);
        return json(200, Object.assign({}, body.p_doc, {
          id: body.p_doc.id || '00000000-0000-4000-8000-0000000000bb',
          updated_at: '2026-08-13T01:00:00Z',
        }));
      }
      if (fn === 'save_inspection') {
        return json(200, Object.assign({}, body.p_doc, {
          id: '00000000-0000-4000-8000-0000000000cc',
          updated_at: '2026-08-13T02:00:00Z',
        }));
      }
      return json(404, { message: `no such function ${fn} in this fixture` });
    }

    const table = name.split('?')[0];
    if (table === 'attachment') return json(200, attachmentRows(store, url.search));
    if (table === 'maintenance_activity') return json(200, state.recent);
    if (table === 'inspection_needs_maintenance') return json(200, state.outstanding);
    if (table === 'inspection') return json(200, []);

    const rows = tables[table];
    if (!rows) return json(404, { message: `${table} is not in the fixture` });
    const order = (url.searchParams.get('order') || '').split(',').filter(Boolean);
    const out = rows.slice().sort((a, b) => {
      for (const key of order) {
        const col = key.split('.')[0];
        const dir = key.endsWith('.desc') ? -1 : 1;
        if (a[col] < b[col]) return -1 * dir;
        if (a[col] > b[col]) return 1 * dir;
      }
      return 0;
    });
    return json(200, out);
  });
}

// What the form should be showing, read back out of the DOM rather than out of
// `state`. A value that is in the document and not in its control is exactly
// the bug a fidelity test exists to catch.
async function shownValues(page) {
  return page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('.mnt-page [oninput], .mnt-page [onchange]')) {
      const h = el.getAttribute('oninput') || el.getAttribute('onchange') || '';
      const m = h.match(/Maintenance\.set\('([^']+)'/);
      if (m) out[m[1]] = el.value;
    }
    return out;
  });
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  const tables = formFixture();
  const wb = openWorkbook(WORKBOOK);
  const blank = wb.cells(BLANK);
  const filled = wb.cells(FILLED);

  check(`the workbook opened — ${wb.names.length} sheets, "${FILLED}" among them`,
    wb.names.includes(BLANK) && wb.names.includes(FILLED), wb.names.join(', '));

  const { doc: mtk, misses, used } = buildMtKanigan(tables, filled);

  // Every printed pick-list word resolved against the migration's own row. This
  // is #117's "one source of truth" as an assertion: if 0009 renamed a label,
  // or the form grew a second copy of a list, this is where it shows.
  check('every pick-list value printed on the sheet is a row in the table the form reads',
    misses.length === 0, misses.join(' | '));

  // Everything the filled sheet says that the blank template does not, accounted
  // for — either mapped onto a column or named as unmapped, never neither.
  const refs = [...new Set([...Object.keys(blank), ...Object.keys(filled)])];
  const diffs = refs.filter(r => blank[r] !== filled[r]);
  const unaccounted = diffs.filter(r => !used.has(r) && !UNMAPPED[r]);
  check(`the filled sheet differs from the blank template in ${diffs.length} cells, all accounted for`,
    diffs.length > 0 && unaccounted.length === 0,
    unaccounted.length ? `unaccounted: ${unaccounted.map(r => `${r}="${filled[r]}"`).join(', ')}`
                       : diffs.sort().join(', '));

  check(`${Object.keys(UNMAPPED).length} filled cell(s) named as having no column`,
    Object.keys(UNMAPPED).every(r => filled[r] != null),
    Object.keys(UNMAPPED).join(', '));

  // The values the sheet actually carries, so a fixture that silently parsed to
  // nothing cannot pass the DOM checks below by comparing empty to empty.
  const rain = mtk.assets.find(a => a.asset === 'rainfall');
  const dqRain = mtk.data_quality.find(q => q.parameter === 'rainfall');
  check('the filled sheet parsed to the values it prints',
    rain.rain_instrument_type_key === 'tbrg_0_2mm' && rain.condition_key === 'poor'
    && rain.owner_key === 'council' && /TBRG is old/.test(rain.comments)
    && dqRain.on_arrival_key === 'missing_record' && dqRain.on_departure_key === 'good_quality'
    && mtk.gauge_boards_present === false && mtk.benchmark_surveyed === true,
    JSON.stringify({ rain: rain.rain_instrument_type_key, cond: rain.condition_key,
                     dq: [dqRain.on_arrival_key, dqRain.on_departure_key],
                     boards: mtk.gauge_boards_present }));

  const state = {
    doc: mtk,
    saved: [],
    recent: [{ id: mtk.id, station_id: null, inspection_id: null, station_name: 'Mt Kanigan',
               cbm_no: '', visited_on: mtk.visited_on, recorded_by: '', council_key: null,
               origin: 'import', updated_at: mtk.updated_at }],
    outstanding: [{ inspection_id: '00000000-0000-4000-8000-0000000000dd',
                    station_id: null, station_name: 'Test Creek', cbm_no: '999999',
                    config_key: 'alert', inspected_on: '2026-08-10', parameter: 'water_level',
                    on_departure_key: 'poor_quality', on_departure_label: 'Poor Quality',
                    has_maintenance_activity: false }],
  };

  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const store = storageStore();

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    await installDatastore(page, tables, state, store);
    await installStorage(page, store);

    page.on('pageerror', e => errors.push(e.stack || e.message));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/^Failed to load resource|ERR_BLOCKED_BY_CLIENT|ERR_FAILED/i.test(t)) return;
      errors.push(t);
    });

    await page.goto(server.origin + '/index.html', { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data,
      null, { timeout: LOAD_TIMEOUT });

    // Signed in, so the two editors-only lists render. The token is what
    // dbCanWrite() reads; the fixture answers regardless of what is in it.
    await page.evaluate(() => dbSetAccessToken('test-token'));
    await page.evaluate(() => switchTab('maintenance'));
    await page.waitForFunction(() => state.maint.refs || state.maint.refsError,
      null, { timeout: LOAD_TIMEOUT });

    const refsError = await page.evaluate(() => state.maint.refsError);
    check('the pick-lists loaded', !refsError, refsError || '');
    if (refsError) throw new Error('nothing else can be checked without them');

    // ── The picker ───────────────────────────────────────────────────────────
    await page.waitForFunction(() => state.maint.recent && state.maint.outstanding,
      null, { timeout: LOAD_TIMEOUT });
    const listed = await page.evaluate(() =>
      [...document.querySelectorAll('.mnt-list .btn-link')].map(b => b.textContent.trim()));
    check('the picker lists past forms and the visits waiting for one',
      listed.includes('Mt Kanigan') && listed.includes('Test Creek'), listed.join(' · '));

    // ── A blank form ─────────────────────────────────────────────────────────
    await page.evaluate(() => Maintenance.pick(null));
    await page.waitForTimeout(SETTLE);

    const sections = await page.evaluate(() =>
      [...document.querySelectorAll('.mnt-section')].map(s => s.dataset.section));
    const WANT_SECTIONS = ['rainfall', 'water_level', 'comms_power', 'gauge_boards', 'contacts',
                           'access_whs', 'data_quality', 'remarks', 'canister'];
    check(`a blank form renders ${WANT_SECTIONS.length} sections, in the sheet's print order`,
      JSON.stringify(sections) === JSON.stringify(WANT_SECTIONS), sections.join(', '));

    const shape = await page.evaluate(() => ({
      assets: (state.maint.doc.assets || []).map(a => a.asset),
      dq: (state.maint.doc.data_quality || []).map(q => q.parameter),
    }));
    check('a blank form materialises the three panels and the two data-quality rows',
      JSON.stringify(shape.assets) === JSON.stringify(['rainfall', 'water_level', 'comms_power'])
      && JSON.stringify(shape.dq) === JSON.stringify(['rainfall', 'river_level']),
      JSON.stringify(shape));

    // Every box on this sheet has a column since 0011 (#148), so no section
    // states a gap. Asserted as zero rather than deleted: the mechanism is still
    // there for the next unhomed box, and this is what says nothing is quietly
    // using it.
    const gaps = await page.evaluate(() =>
      [...document.querySelectorAll('.mnt-section')]
        .filter(s => s.querySelector('.mnt-gap li'))
        .map(s => s.dataset.section));
    check('no section states an uncaptured box', gaps.length === 0, gaps.join(', '));

    // The Comms and Power panel, as three sub-columns rather than one. This is
    // the assertion #148 turns on: the diff below cannot see it, because the
    // blank and filled sheets carry the same words in those four cells.
    const commsBlocks = await page.evaluate(() =>
      [...document.querySelectorAll('.mnt-section[data-section="comms_power"] .mnt-block')]
        .map(h => h.textContent.trim()));
    check('the Comms and Power panel prints its three sub-columns as three sub-blocks',
      JSON.stringify(commsBlocks) === JSON.stringify(['Comms', 'Equipment', 'Power']),
      commsBlocks.join(', '));

    let audit = await auditHandlers(page);
    check(`blank form: all ${audit.checked} handler(s) across ${audit.total} attribute(s) resolve`,
      audit.unresolved.length === 0,
      audit.unresolved.map(u => `${u.path} (${u.attr} on ${u.where})`).join('; '));

    // Only the comms panel offers the comms boxes, and neither instrument box
    // appears on the panel whose check constraint refuses it.
    const boxes = Object.keys(await shownValues(page));
    const misplaced = [
      ['assets.0.wl_instrument_type_key', 'a water-level instrument on the rainfall panel'],
      ['assets.1.rain_instrument_type_key', 'a rain instrument on the water-level panel'],
      ['assets.0.comms_method_key', 'a comms box outside the comms panel'],
      ['assets.1.power_key', 'a power box outside the comms panel'],
    ].filter(([path]) => boxes.includes(path)).map(([, why]) => why);
    check('no panel offers a box its check constraint would refuse',
      misplaced.length === 0, misplaced.join('; '));

    // ── The filled sheet, through the form ───────────────────────────────────
    await page.evaluate(id => Maintenance.open(id), mtk.id);
    await page.waitForFunction(() => state.maint.doc && state.maint.doc.id,
      null, { timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(SETTLE);

    const shown = await shownValues(page);
    const wrong = [];
    const want = (path, value) => {
      const got = shown[path];
      const expect = value == null ? '' : value === true ? 'true' : value === false ? 'false' : String(value);
      if (got === undefined) wrong.push(`${path}: no control on screen`);
      else if (got !== expect) wrong.push(`${path}: shows "${got}", sheet says "${expect}"`);
    };
    mtk.assets.forEach((row, i) => {
      Object.keys(ASSET_CELLS[row.asset]).forEach(col => want(`assets.${i}.${col}`, row[col]));
    });
    Object.keys(TOP_CELLS).forEach(col => want(`top.${col}`, mtk[col]));
    mtk.data_quality.forEach((row, i) => {
      Object.keys(DQ_CELLS[row.parameter]).forEach(col => want(`data_quality.${i}.${col}`, row[col]));
    });
    // Counted rather than written down: the comms panel went from four mapped
    // boxes to nine at #148, and an arithmetic constant here would have gone on
    // reading right while saying the wrong number.
    const mappedBoxes = Object.values(ASSET_CELLS).reduce((n, c) => n + Object.keys(c).length, 0)
      + Object.keys(TOP_CELLS).length
      + Object.values(DQ_CELLS).reduce((n, c) => n + Object.keys(c).length, 0);
    check(`Mt Kanigan: all ${mappedBoxes} mapped boxes show what the sheet says`,
      wrong.length === 0, wrong.join(' | '));

    audit = await auditHandlers(page);
    check(`Mt Kanigan: all ${audit.checked} handler(s) across ${audit.total} attribute(s) resolve`,
      audit.unresolved.length === 0,
      audit.unresolved.map(u => `${u.path} (${u.attr} on ${u.where})`).join('; '));

    // ── The two boxes on this sheet that are images (#149) ───────────────────
    // The canister panel is a pasted screenshot in the filled example, and
    // "(if yes take photo)" is printed beside Bench Mark present. Both are
    // attachment panels now rather than the note that used to say they could not
    // be. What is checked is what went over the wire: the rules the database
    // enforces are proven by tools/check_attachments.sql against a real Postgres.
    const panels = await page.evaluate(() =>
      [...document.querySelectorAll('.att-panel')].map(el => ({
        section: el.closest('.mnt-section').dataset.section,
        role: el.dataset.attRole,
      })));
    check('both image boxes are attachment panels, on the sections that print them',
      JSON.stringify(panels) === JSON.stringify([
        { section: 'gauge_boards', role: 'gauge_board' },
        { section: 'canister', role: 'canister_config' }]),
      JSON.stringify(panels));

    // The canister dump, as the filled sheet has it: a pasted screenshot. Sent
    // to the panel that prints it, so the role it lands under is the one 0009
    // created a `canister_config` row for.
    await page.setInputFiles('.mnt-section[data-section="canister"] input[type="file"]',
      fileOf('canister-dump.png', 'image/png', 8192));
    await page.waitForFunction(() => (state.attach.list || []).length === 1,
      null, { timeout: LOAD_TIMEOUT });

    const call = store.calls.find(c => c.fn === 'attach_file');
    check('the canister screenshot indexes against the activity, under canister_config',
      !!call && call.body.p_maintenance_activity_id === mtk.id
      && call.body.p_inspection_id === undefined
      && call.body.p_role_key === 'canister_config',
      JSON.stringify(call && { a: call.body.p_maintenance_activity_id, r: call.body.p_role_key }));

    check('the object is named with a generated uuid, under the activity\'s own prefix',
      !!call && new RegExp(`^maintenance/${mtk.id}/`
        + '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png$')
        .test(call.body.p_storage_path),
      call && call.body.p_storage_path);

    // Two roles on one record, and each panel shows its own. A single
    // undifferentiated pile would lose which box on the paper a file answers.
    await page.setInputFiles('.mnt-section[data-section="gauge_boards"] input[type="file"]',
      fileOf('benchmark.jpg', 'image/jpeg', 4096));
    await page.waitForFunction(() => (state.attach.list || []).length === 2,
      null, { timeout: LOAD_TIMEOUT });

    const perPanel = await page.evaluate(() =>
      [...document.querySelectorAll('.att-panel')].map(el => ({
        role: el.dataset.attRole,
        names: [...el.querySelectorAll('.att-name')].map(n => n.textContent.trim()),
      })));
    check('each panel lists only the files filed under its own role',
      JSON.stringify(perPanel) === JSON.stringify([
        { role: 'gauge_board', names: ['benchmark.jpg'] },
        { role: 'canister_config', names: ['canister-dump.png'] }]),
      JSON.stringify(perPanel));

    audit = await auditHandlers(page);
    check(`attachments: all ${audit.checked} handler(s) across ${audit.total} attribute(s) resolve`,
      audit.unresolved.length === 0,
      audit.unresolved.map(u => `${u.path} (${u.attr} on ${u.where})`).join('; '));

    // ── Saving ───────────────────────────────────────────────────────────────
    await page.evaluate(() => Maintenance.save());
    await page.waitForFunction(() => !state.maint.busy, null, { timeout: LOAD_TIMEOUT });

    const sent = state.saved[state.saved.length - 1];
    check('save sends a document', !!sent);
    if (sent) {
      const sentAssets = Object.fromEntries((sent.assets || []).map(a => [a.asset, a]));
      check('save: round-trips what the sheet said',
        sent.id === mtk.id
        && sentAssets.rainfall.rain_instrument_type_key === 'tbrg_0_2mm'
        && sentAssets.rainfall.condition_key === 'poor'
        && sentAssets.comms_power.comms_method_key === 'alert1'
        && sentAssets.comms_power.power_key === 'mains'
        && /Receivers 151\.5/.test(sentAssets.comms_power.comments)
        && sent.gauge_boards_present === false
        && sent.benchmark_surveyed === true
        && (sent.data_quality || []).length === 2,
        JSON.stringify({ assets: Object.keys(sentAssets), dq: (sent.data_quality || []).length }));

      const leaked = (sent.assets || []).filter(a =>
        (a.asset !== 'rainfall' && a.rain_instrument_type_key)
        || (a.asset !== 'water_level' && a.wl_instrument_type_key)
        || (a.asset !== 'comms_power' && (a.comms_method_key || a.comms_equipment_key || a.power_key)));
      check('save: carries no key the panel\'s check constraint would refuse',
        leaked.length === 0, leaked.map(a => a.asset).join(', '));

      check('save: does not send attachments, which the save function does not write',
        !('attachments' in sent));
    }

    // A form nobody touched must not write three rows of nulls — "not recorded"
    // is no row, the same rule the inspection form follows.
    await page.evaluate(() => { Maintenance.close(); Maintenance.pick(null); });
    await page.waitForTimeout(SETTLE);
    await page.evaluate(() => {
      Maintenance.set('top.station_name', 'Empty Creek', 'text');
      Maintenance.set('assets.2.power_key', 'mains', 'sel');
      return Maintenance.save();
    });
    await page.waitForFunction(() => !state.maint.busy, null, { timeout: LOAD_TIMEOUT });
    const pruned = state.saved[state.saved.length - 1];
    check('save: prunes the panels nobody filled in',
      pruned && (pruned.assets || []).length === 1
      && pruned.assets[0].asset === 'comms_power'
      && (pruned.data_quality || []).length === 0,
      JSON.stringify({ assets: (pruned.assets || []).map(a => a.asset),
                       dq: (pruned.data_quality || []).length }));

    // ── The printed cross-reference, both directions ─────────────────────────
    await page.evaluate(() => { Maintenance.close(); });
    await page.waitForTimeout(SETTLE);
    await page.evaluate(() => Maintenance.fromInspection('00000000-0000-4000-8000-0000000000dd'));
    await page.waitForTimeout(SETTLE);
    const fromList = await page.evaluate(() => ({
      inspection_id: state.maint.doc.inspection_id,
      station_name: state.maint.doc.station_name,
      cbm_no: state.maint.doc.cbm_no,
      trigger: state.maint.doc.trigger_reason,
      // The date is this visit's, not the inspection's — a guess that reads as
      // a fact is the thing this deliberately does not do.
      sameDate: state.maint.doc.visited_on === '2026-08-10',
      linked: !!document.querySelector('.mnt-linked'),
    }));
    check('the outstanding list starts a form linked to the visit, carrying its station',
      fromList.inspection_id === '00000000-0000-4000-8000-0000000000dd'
      && fromList.station_name === 'Test Creek' && fromList.cbm_no === '999999'
      && fromList.trigger === 'poor_on_departure' && fromList.linked && !fromList.sameDate,
      JSON.stringify(fromList));

    // The other direction: an inspection that departs poor grows a button, and
    // pressing it lands here with the link made. The inspection has to be saved
    // first, because the link is a foreign key.
    await page.evaluate(() => { Maintenance.close(); switchTab('inspections'); });
    await page.waitForFunction(() => state.insp.refs || state.insp.refsError,
      null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => { Inspections.pick(null); Inspections.setConfig('alert'); });
    await page.waitForTimeout(SETTLE);
    await page.evaluate(() => {
      Inspections.set('top.station_name', 'Departed Poor Creek', 'text');
      const i = state.insp.doc.data_quality.findIndex(r => r.parameter === 'water_level');
      Inspections.set(`data_quality.${i}.on_departure_key`, 'poor_quality', 'sel');
    });
    const beforeSave = await page.evaluate(() =>
      !!document.querySelector('#insp-crossref [onclick*="raiseMaintenance"]'));
    check('an unsaved inspection offers no link, because the link is a foreign key', !beforeSave);

    await page.evaluate(() => Inspections.save());
    await page.waitForFunction(() => !state.insp.busy, null, { timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(SETTLE);
    const button = await page.$('#insp-crossref [onclick*="raiseMaintenance"]');
    check('a saved inspection that departed poor offers the Council form as a button', !!button);
    if (button) {
      await button.click();
      await page.waitForTimeout(SETTLE);
      const landed = await page.evaluate(() => ({
        tab: state.activeTab,
        inspection_id: state.maint.doc && state.maint.doc.inspection_id,
        station_name: state.maint.doc && state.maint.doc.station_name,
        trigger: state.maint.doc && state.maint.doc.trigger_reason,
      }));
      check('pressing it lands on the Site Maintenance tab with the link made',
        landed.tab === 'maintenance'
        && landed.inspection_id === '00000000-0000-4000-8000-0000000000cc'
        && landed.station_name === 'Departed Poor Creek'
        && landed.trigger === 'poor_on_departure',
        JSON.stringify(landed));
    }

    check('nothing threw and the console stayed clean', errors.length === 0,
      errors.slice(0, 3).join(' | '));

    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n  ${results.length} assertion(s).`);
  if (failed.length) {
    console.log(`\nFAIL — ${failed.length} of ${results.length}:`);
    failed.forEach(f => console.log(`  ✗ ${f.name}`));
    process.exitCode = 1;
    return;
  }
  console.log('\nPASS — the Council sheet renders what the workbook says, filled example and all.');
}

main().catch(err => {
  console.error('\nThe maintenance check could not run:\n', err);
  process.exitCode = 1;
});
