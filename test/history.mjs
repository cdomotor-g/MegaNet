// The Inspection History tab, against records the app itself wrote (#118).
//
// Why this is a check of its own, and not another tab in `npm run smoke`.
//
// The same reason `insp` and `maint` are: smoke's network policy aborts every
// off-origin request, and this tab renders *from* the datastore. It is worse
// here than on either form tab, because the records are editors-only — under
// smoke this tab correctly renders "sign in to read them", which is a true
// result about the gate and silence about everything behind it.
//
// ── Where the fixture comes from, and why it is not written by hand ──────────
//
// `insp` takes its reference data out of `0009_inspections.sql` rather than out
// of a copy of it, because a form that claims to render what the database says
// must not be checked against a hand-written copy of what the database says.
// This check applies the same rule one level up: **the records it reads back are
// the ones the form saved during the run.** It opens the Inspections tab, fills
// the Alert sheet in box by box, presses Save, and serves that exact document
// back from `meganet.inspection_doc()`. Then it does the same with the Council
// sheet.
//
// So what is under test is the round trip a person actually makes — fill in,
// save, come back later and read it — rather than a reader's agreement with a
// fixture somebody wrote to match the reader.
//
// What it asserts:
//
//   1. A saved visit reads back with **exactly the sections the editable form
//      printed for that configuration, in the same order**. This is the
//      anti-drift assertion the whole design rests on: the read-only view and
//      the form are one walk over one field table, and a section that appeared
//      in one and not the other would mean they are not.
//   2. Pick-list values read back as **their printed labels, not their keys** —
//      the thing a reader would notice first if the model skipped the lookup.
//   3. A section the sheet prints with **no row saved against it says so**,
//      rather than printing a grid of empty boxes that reads as unfilled; and a
//      section the sheet does not print at all is named under "Not on this
//      form". 0009's decision 2, two levels down, and #118's third acceptance
//      criterion.
//   4. The **timeline** merges both form families, newest first, and the
//      on-departure column is 0009's own `inspection_needs_maintenance` — the
//      printed instruction at the foot of the sheet, with whether it was
//      followed.
//   5. The **CSV carries every box the screen shows**, because it is written
//      from the same walk. Asserted as a superset rather than by eye: every
//      (section, label) pair on screen has a row.
//   6. The CSV names a photo by its **object path and never by a signed URL** —
//      #149's rule, which only bites in an export, because an export outlives
//      the session it was made in.
//   7. The Council sheet's Comms and Power panel reads back as **three titled
//      sub-blocks with three Conditions**, not one. #148 repaired a wrong answer
//      in the writer; this is the reader not re-creating it.
//   8. Signed out, the tab shows the gate and no record.
//   9. Every `on*=` handler the tab rendered resolves in page scope.
//
// Run:  npm run history
//       npm run history -- -v    also print what passed

import { formFixture } from './lib/migration.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { auditHandlers } from './lib/controls.mjs';
import { storageStore, installStorage, attachmentRpc, attachmentRows, fileOf }
  from './lib/storage.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const SETTLE = Number(process.env.SMOKE_TAB_SETTLE || 300);

const INSPECTION_ID = '00000000-0000-4000-8000-00000000a001';
const ACTIVITY_ID   = '00000000-0000-4000-8000-00000000b001';
const IMPORT_ID     = '00000000-0000-4000-8000-00000000c001';
const UNMATCHED_ID  = '00000000-0000-4000-8000-00000000d001';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── The datastore ────────────────────────────────────────────────────────────
// The vocabularies and the matrix come out of 0009. The records are whatever
// the two forms saved during this run: `save_inspection` files the document in
// `records`, and `inspection_doc` hands the same document back. That is the
// round trip, rather than a fixture pretending to be one.

function installDatastore(page, tables, records, store) {
  return page.route('**://*.supabase.co/rest/v1/**', async route => {
    const url = new URL(route.request().url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const ok = body => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(body) });

    if (route.request().method() === 'POST' && name.startsWith('rpc/')) {
      const fn = name.slice(4);
      const body = JSON.parse(route.request().postData() || '{}');
      const att = attachmentRpc(fn, body, store);
      if (att !== undefined) return ok(att);

      if (fn === 'save_inspection' || fn === 'save_maintenance_activity') {
        const kind = fn === 'save_inspection' ? 'inspection' : 'maintenance';
        const doc = Object.assign({}, body.p_doc, {
          id: body.p_doc.id || (kind === 'inspection' ? INSPECTION_ID : ACTIVITY_ID),
          updated_at: '2026-08-13T04:00:00Z',
        });
        records[kind] = doc;
        return ok(doc);
      }
      if (fn === 'inspection_doc' || fn === 'maintenance_activity_doc') {
        const kind = fn === 'inspection_doc' ? 'inspection' : 'maintenance';
        // An imported visit's document, as the real function would compose it:
        // the row plus whatever the projection put in the section tables —
        // which for the fixture's 1994 row is one battery voltage and nothing
        // else. The `>30` and the `U/S` are deliberately NOT here; they have no
        // number, and the transcription is where the reader must find them.
        const imp = (records.imports || []).find(r => r.id === body.p_id);
        if (imp && kind === 'inspection') return ok(Object.assign({}, imp, { attachments: [] }));
        const doc = records[kind];
        if (!doc || doc.id !== body.p_id) return ok(null);
        // The document as the database would compose it — the record plus the
        // attachment rows filed against it. inspection_doc() joins them in; the
        // save function does not write them, so they are not on the saved copy.
        return ok(Object.assign({}, doc, {
          attachments: store.rows.filter(r =>
            (kind === 'inspection' ? r.inspection_id : r.maintenance_activity_id) === doc.id),
        }));
      }
      return route.fulfill({ status: 404, contentType: 'application/json',
        body: JSON.stringify({ message: `no such function ${fn} in this fixture` }) });
    }

    const table = name.split('?')[0];

    if (table === 'attachment') return ok(attachmentRows(store, url.search));

    // The list queries, answered off the saved records plus the import
    // fixture. The filters this honours are the ones the tab actually sends:
    // per-station scope, the unmatched scope (`station_id=is.null` +
    // `origin=eq.import`), and the single-row provenance fetch (`id=eq.…`).
    if (table === 'inspection') {
      const rows = [
        ...(records.inspection ? [records.inspection] : []),
        ...(records.imports || []),
      ];
      const eqSt   = /station_id=eq\.([^&]+)/.exec(url.search);
      const nullSt = /station_id=is\.null/.test(url.search);
      const eqOr   = /origin=eq\.([^&]+)/.exec(url.search);
      const eqId   = /[?&]id=eq\.([^&]+)/.exec(url.search);
      return ok(rows.filter(r =>
        (!eqSt || decodeURIComponent(eqSt[1]) === (r.station_id || '')) &&
        (!nullSt || r.station_id == null) &&
        (!eqOr || decodeURIComponent(eqOr[1]) === (r.origin || 'form')) &&
        (!eqId || decodeURIComponent(eqId[1]) === r.id)));
    }
    if (table === 'maintenance_activity') {
      const doc = records.maintenance;
      if (!doc) return ok([]);
      const want = /station_id=eq\.([^&]+)/.exec(url.search);
      if (want && decodeURIComponent(want[1]) !== (doc.station_id || '')) return ok([]);
      return ok([doc]);
    }

    // The record behind an imported visit: one row per workbook cell. The
    // transcription table is drawn from this, so it is what carries the `>30`.
    if (table === 'inspection_measurement') {
      const eq = /inspection_id=eq\.([^&]+)/.exec(url.search);
      return ok((records.measurements || [])
        .filter(m => !eq || m.inspection_id === decodeURIComponent(eq[1]))
        .sort((a, b) => a.ord - b.ord));
    }

    // 0009's own view, computed the way the view computes it: a visit whose
    // departure rating is one the ratings table marks as needing maintenance.
    if (table === 'inspection_needs_maintenance') {
      const doc = records.inspection;
      if (!doc) return ok([]);
      const want = /station_id=eq\.([^&]+)/.exec(url.search);
      if (want && decodeURIComponent(want[1]) !== (doc.station_id || '')) return ok([]);
      const rating = Object.fromEntries(tables.data_quality_rating.map(r => [r.key, r]));
      return ok((doc.data_quality || [])
        .filter(q => rating[q.on_departure_key] && rating[q.on_departure_key].needs_maintenance)
        .map(q => ({
          inspection_id: doc.id,
          station_id: doc.station_id,
          parameter: q.parameter,
          on_departure_label: rating[q.on_departure_key].label,
          has_maintenance_activity: !!(records.maintenance
            && records.maintenance.inspection_id === doc.id),
        })));
    }

    const rows = tables[table];
    if (!rows) {
      return route.fulfill({ status: 404, contentType: 'application/json',
        body: JSON.stringify({ message: `${table} is not in the fixture` }) });
    }
    const order = (url.searchParams.get('order') || '').split(',').filter(Boolean);
    return ok(rows.slice().sort((a, b) => {
      for (const key of order) {
        const col = key.split('.')[0];
        const dir = key.endsWith('.desc') ? -1 : 1;
        if (a[col] < b[col]) return -1 * dir;
        if (a[col] > b[col]) return 1 * dir;
      }
      return 0;
    }));
  });
}

// ── Filling a sheet in ───────────────────────────────────────────────────────
// Every box the rendered form addresses, given a value of the right shape. The
// paths are read off the DOM rather than listed here, so a box added to a sheet
// is a box this check fills in and then looks for on the way back — which is the
// only version of this that stays true.

// Every fourth box is left blank on purpose, and that is not decoration. A
// sheet where every box is filled cannot tell a CSV that carries every box from
// one that carries only the answered ones — and the second is the version that
// loses the difference between "no" and "nobody asked". Confirmed: with the
// sheet filled solid, deliberately dropping empty boxes from the export passed.
function fillTheSheet(skip) {
  const out = { filled: [], blank: [] };
  let n = 0;
  for (const el of document.querySelectorAll('.insp-page [oninput], .insp-page [onchange]')) {
    const h = el.getAttribute('oninput') || el.getAttribute('onchange') || '';
    const m = h.match(/Inspections\.set\('([^']+)',this\.value,'([^']+)'/);
    if (!m) continue;
    const path = m[1];
    const type = m[2];
    if (skip.some(p => path.startsWith(p))) continue;
    if (n++ % 4 === 3) { out.blank.push(path); continue; }
    let value;
    if (type === 'num') value = '12.5';
    else if (type === 'time') value = '09:30';
    else if (type === 'bool') value = 'true';
    else if (type === 'sel') {
      const opt = [...el.querySelectorAll('option')].map(o => o.value).find(v => v !== '');
      if (!opt) continue;
      value = opt;
    } else if (el.tagName === 'INPUT' && el.type === 'date') value = '2026-07-04';
    else value = 'filled ' + out.filled.length;
    Inspections.set(path, value, type);
    out.filled.push([path, value]);
  }
  return out;
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  const tables = formFixture();
  const server = await startServer();
  const browser = await launchBrowser();
  const records = {};
  const errors = [];
  const store = storageStore();

  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    await installDatastore(page, tables, records, store);
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
    await page.evaluate(() => dbSetAccessToken('test-token'));

    const stationId = await page.evaluate(() => state.data.stations[0].id);

    // ── The import fixture (#128) ──────────────────────────────────────────
    // Two visits the loader would have written, not the form: a sparse 1994
    // row whose date the workbook gave only as a year and whose cells include
    // the two shapes a projection cannot carry (`>30`, `U/S`), and a parked
    // visit #125 could not match to any station. The route fake serves both.
    records.imports = [
      {
        id: IMPORT_ID, station_id: stationId, station_name: 'Test Creek',
        cbm_no: '040001', config_key: 'alert', inspected_on: '1994-01-01',
        inspector: '', origin: 'import', updated_at: '2026-08-17T00:00:00Z',
        date_precision: 'year', date_raw: '1994',
        source_workbook: 'archive/QLD All Site Inspections.xlsx',
        source_sheet: 'Fitzroy!', source_row: 42,
        source_block_ref: 'qld:Fitzroy!:7:1', source_ref: 'qld:Fitzroy!:7:42',
        station_match: 'number', station_key: 'c:40001',
        power: { battery_existing_v: 12.9 },
      },
      {
        id: UNMATCHED_ID, station_id: null, station_name: 'SOMEWHERE CREEK ALERT',
        cbm_no: '049999', config_key: 'alert', inspected_on: '2011-03-04',
        inspector: '', origin: 'import', updated_at: '2026-08-17T00:00:00Z',
        date_precision: 'day', date_raw: '',
        source_workbook: 'archive/QLD All Site Inspections.xlsx',
        source_sheet: 'Check!', source_row: 11,
        source_block_ref: 'qld:Check!:7:1', source_ref: 'qld:Check!:7:11',
        station_match: 'unmatched', station_key: 'c:49999',
      },
    ];
    records.measurements = [
      { inspection_id: IMPORT_ID, ord: 1, field_key: 'battery_standby_v',
        label: 'Battery Voltage - Standby', source_col: 'C', raw: '12.9',
        value_class: 'number', value: 12.9, unit: 'V',
        operator: null, bound: null, status: null, flag: '' },
      { inspection_id: IMPORT_ID, ord: 2, field_key: 'fade_margin_db',
        label: 'Fade Margin', source_col: 'H', raw: '>30',
        value_class: 'qualified', value: null, unit: 'dB',
        operator: '>', bound: 30, status: null, flag: '' },
      { inspection_id: IMPORT_ID, ord: 3, field_key: 'swr',
        label: 'SWR', source_col: 'J', raw: 'U/S',
        value_class: 'status', value: null, unit: '',
        operator: null, bound: null, status: 'u/s', flag: '' },
    ];

    // ── Write an inspection ────────────────────────────────────────────────
    await page.evaluate(() => switchTab('inspections'));
    await page.waitForFunction(() => state.insp.refs || state.insp.refsError,
      null, { timeout: LOAD_TIMEOUT });
    const refsError = await page.evaluate(() => state.insp.refsError);
    check('the form matrix loaded', !refsError, refsError || '');
    if (refsError) throw new Error('nothing else can be checked without the matrix');

    await page.evaluate(id => { Inspections.pick(id); Inspections.setConfig('alert'); }, stationId);
    await page.waitForTimeout(SETTLE);

    // Everything but the gas section, deliberately. A section the sheet prints
    // and nobody filled in prunes to no row on save — which is exactly the case
    // assertion 3 is about, and the only way to produce it is to leave one.
    const swept = await page.evaluate(fillTheSheet, ['gas.']);
    check(`filled ${swept.filled.length} boxes on the Alert sheet, left ${swept.blank.length} `
        + 'blank and the whole gas section unrecorded',
      swept.filled.length > 40 && swept.blank.length > 10,
      `${swept.filled.length} filled, ${swept.blank.length} blank`);

    // The departure ratings, set on purpose rather than by the sweep: the
    // timeline's on-departure column is read off `needs_maintenance`, so this
    // has to be a rating the table marks and not merely one spelt "poor".
    await page.evaluate(() => {
      Inspections.set('data_quality.0.on_departure_key', 'poor_quality', 'sel');
      Inspections.set('data_quality.0.on_arrival_key', 'good_quality', 'sel');
      Inspections.set('data_quality.1.on_departure_key', 'good_quality', 'sel');
      Inspections.set('top.station_name', 'Test Creek', 'text');
      Inspections.set('top.inspector', 'AB', 'text');
      Inspections.set('top.inspected_on', '2026-07-04', 'text');
    });

    // The sections the *editable* form printed, which assertion 1 compares
    // against. Read now, while the form is on screen.
    const formSections = await page.evaluate(() =>
      [...document.querySelectorAll('.insp-section')].map(s => s.dataset.section));

    await page.evaluate(() => Inspections.save());
    await page.waitForFunction(() => !state.insp.busy && state.insp.doc.id,
      null, { timeout: LOAD_TIMEOUT });

    // A photo, so the record has one to read back and the export has one to
    // name. The panel only appears once the record is saved — the attachment is
    // a foreign key — which is why this is here and not above.
    await page.waitForFunction(() => !!document.querySelector('.att-panel input[type="file"]'),
      null, { timeout: LOAD_TIMEOUT });
    await page.setInputFiles('.att-panel input[type="file"]',
      fileOf('IMG_0042.jpg', 'image/jpeg', 4096));
    await page.waitForFunction(() => (state.attach.list || []).length === 1,
      null, { timeout: LOAD_TIMEOUT });
    const photoPath = store.rows[0].storage_path;

    // ── Write a Council form against it ────────────────────────────────────
    await page.evaluate(() => switchTab('maintenance'));
    await page.waitForFunction(() => state.maint.refs || state.maint.refsError,
      null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(id => Maintenance.pick(id), stationId);
    await page.waitForTimeout(SETTLE);
    await page.evaluate(insp => {
      const doc = state.maint.doc;
      doc.inspection_id = insp;
      Maintenance.set('top.station_name', 'Test Creek', 'text');
      Maintenance.set('top.recorded_by', 'CD', 'text');
      Maintenance.set('top.visited_on', '2026-07-18', 'text');
      // The three sub-columns of the Comms and Power panel, answered
      // differently on purpose — which is the shape #148 repaired and the shape
      // a reader can silently collapse back into one.
      const i = doc.assets.findIndex(r => r.asset === 'comms_power');
      Maintenance.set(`assets.${i}.condition_key`, 'poor', 'sel');
      Maintenance.set(`assets.${i}.equipment_condition_key`, 'good', 'sel');
      Maintenance.set(`assets.${i}.power_condition_key`, 'fair', 'sel');
      Maintenance.set('data_quality.0.on_departure_key', 'good_quality', 'sel');
    }, INSPECTION_ID);
    await page.evaluate(() => Maintenance.save());
    await page.waitForFunction(() => !state.maint.busy && state.maint.doc.id,
      null, { timeout: LOAD_TIMEOUT });

    const conditionLabels = await page.evaluate(() => {
      const rating = state.maint.refs.condition_rating;
      const doc = state.maint.doc;
      const a = doc.assets.find(r => r.asset === 'comms_power');
      return [a.condition_key, a.equipment_condition_key, a.power_condition_key]
        .map(k => (rating.find(r => r.key === k) || {}).label || k);
    });

    // ── Read them back ─────────────────────────────────────────────────────
    await page.evaluate(() => switchTab('history'));
    await page.waitForFunction(() => !!state.hist.list, null, { timeout: LOAD_TIMEOUT });

    const listed = await page.evaluate(() =>
      [...document.querySelectorAll('.hist-table tbody tr')].map(tr =>
        [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim())));
    check('the timeline merges both form families and the imports, newest first',
      listed.length === 4 && listed[0][0] === '2026-07-18' && listed[1][0] === '2026-07-04'
      && listed[2][0] === '2011-03-04'
      && /Council Maintenance Tasks/.test(listed[0][2]) && /ALERT/i.test(listed[1][2]),
      listed.map(r => r.slice(0, 3).join(' | ')).join(' // '));

    // #128: a date the workbook gave only as a year renders as the year — a
    // full date here would assert a day the paper never said — and an imported
    // row says it is one; the parked visit additionally says it is unmatched.
    check('the 1994 visit lists as “1994”, marked imported',
      listed[3] && listed[3][0] === '1994' && /imported/.test(listed[3][2]),
      listed[3] && `${listed[3][0]} | ${listed[3][2]}`);
    check('the parked visit keeps its workbook name and says it is not matched',
      /SOMEWHERE CREEK ALERT/.test(listed[2][1]) && /not matched/.test(listed[2][1]),
      listed[2][1]);

    // The printed instruction at the foot of the sheet, as a column. The tick
    // is there because a Council form was raised against this visit; the rating
    // is 0009's label rather than the key, and rather than the word "poor".
    check('the on-departure column names the rating and says the form was raised',
      /Rain Poor Quality ✓/.test(listed[1][4] || ''), listed[1][4]);

    await page.evaluate(id => History.open('inspection', id), INSPECTION_ID);
    await page.waitForFunction(() => !!(state.hist.open && state.hist.open.doc),
      null, { timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(SETTLE);

    const histSections = await page.evaluate(() =>
      [...document.querySelectorAll('.hist-section')].map(s => s.dataset.section));
    check(`the record reads back with the form's own ${formSections.length} sections, in order`,
      JSON.stringify(histSections) === JSON.stringify(formSections),
      `read-only: ${histSections.join(', ')} | form: ${formSections.join(', ')}`);

    // Assertion 2. Every pick-list on the form was set to its first real option
    // by the sweep, so a model that skipped the lookup would put keys on screen.
    // `poor_quality` → "Poor Quality" is the one asserted by name, because it is
    // also the one the timeline's column depends on.
    // Both places a value lands: the labelled boxes, and the grids — the
    // data-quality ratings are a table, and they are the ones the timeline's
    // on-departure column is read from, so a check that only looked at the
    // boxes would miss exactly the pick-list that matters most.
    const shown = await page.evaluate(() => [
      ...[...document.querySelectorAll('.hist-value')].map(e => e.textContent.trim()),
      ...[...document.querySelectorAll('.hist-grid-table td')].map(e => e.textContent.trim()),
    ]);
    const keys = await page.evaluate(() => {
      const refs = state.insp.refs;
      const out = new Set();
      Object.keys(refs).forEach(t => (refs[t] || []).forEach(r => {
        if (r && r.key && r.label && r.key !== r.label) out.add(r.key);
      }));
      return [...out];
    });
    const rawKeys = shown.filter(v => keys.includes(v));
    check('pick-list values read back as their printed labels, not their keys',
      rawKeys.length === 0 && shown.includes('Poor Quality'),
      rawKeys.length ? `raw keys on screen: ${rawKeys.join(', ')}` : 'no "Poor Quality" on screen');

    // Assertion 3, both halves.
    const gas = await page.evaluate(() => {
      const el = document.querySelector('.hist-section[data-section="gas"]');
      if (!el) return null;
      return { empty: !!el.querySelector('.hist-empty'),
               boxes: el.querySelectorAll('.hist-field').length };
    });
    check('a printed section with no row saved says so, and prints no boxes',
      !!gas && gas.empty && gas.boxes === 0, JSON.stringify(gas));

    const absent = await page.evaluate(() =>
      [...document.querySelectorAll('.hist-absent-list li strong')].map(e => e.textContent));
    const printed = new Set(formSections);
    const wantAbsent = tables.inspection_section.filter(s => !printed.has(s.key)).map(s => s.label);
    check(`the ${wantAbsent.length} sections the Alert sheet does not print are named`,
      JSON.stringify(absent.slice().sort()) === JSON.stringify(wantAbsent.slice().sort()),
      absent.join(', '));

    const audit = await auditHandlers(page);
    check(`all ${audit.checked} handler(s) across ${audit.total} attribute(s) resolve`,
      audit.unresolved.length === 0,
      audit.unresolved.map(u => `${u.path} (${u.attr} on ${u.where})`).join('; '));

    // The photo is drawn through a signed URL, like everything else that reads
    // out of a private bucket.
    await page.waitForFunction(p => !!state.hist.urls[p], photoPath, { timeout: LOAD_TIMEOUT });
    check('a photo on the record is drawn through a signed URL',
      store.signed.includes(photoPath), store.signed.join(', '));

    // ── The export ─────────────────────────────────────────────────────────
    const csv = await capture(page, () => History.exportRecord());
    const rows = parseCsv(csv);
    check(`the record exports as CSV — ${rows.length - 1} row(s)`,
      rows.length > 40 && rows[0].join(',') === 'station,cbm_no,date,form,section,block,field,value',
      rows[0] && rows[0].join(','));

    // Assertion 5. Every labelled box on screen has a row in the file, keyed the
    // way the file keys it. This is the claim that the screen and the export are
    // one walk — a box in one and not the other means they are not.
    const onScreen = await page.evaluate(() =>
      [...document.querySelectorAll('.hist-section')].flatMap(sec => {
        const label = sec.querySelector('.hist-banner-label').textContent.trim();
        return [...sec.querySelectorAll('.hist-field')].map(f =>
          `${label}|${f.querySelector('.hist-label').childNodes[0].textContent.trim()}`);
      }));
    const inFile = new Set(rows.slice(1).map(r => `${r[4]}|${r[6]}`));
    const missing = [...new Set(onScreen)].filter(k => !inFile.has(k));
    check(`every one of the ${new Set(onScreen).size} boxes on screen has a row in the CSV`,
      missing.length === 0, missing.slice(0, 5).join(' · '));

    // Assertion 6. The path, never the URL — an export outlives the session that
    // made it, and a signed URL in a file somebody mails around is a private
    // bucket with a door propped open.
    check('the CSV names the photo by its object path and carries no signed URL',
      csv.includes(photoPath) && !csv.includes('/object/sign/') && !/token=/.test(csv),
      csv.includes(photoPath) ? 'a signed URL is in the file' : 'the object path is not');

    const listCsv = parseCsv(await capture(page, () => {
      History.close();
      return History.exportList();
    }));
    check('the list exports as CSV, one row per record',
      listCsv.length === 5 && listCsv[0][0] === 'date' && listCsv[1][0] === '2026-07-18',
      listCsv.map(r => r[0]).join(' | '));

    // ── An imported record, read back (#128) ───────────────────────────────
    await page.evaluate(id => History.open('inspection', id), IMPORT_ID);
    await page.waitForFunction(() =>
      !!(state.hist.open && state.hist.open.doc && state.hist.open.cells),
      null, { timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(SETTLE);

    const imp = await page.evaluate(() => {
      const secs = [...document.querySelectorAll('.hist-section')].map(s => s.dataset.section);
      const trans = document.querySelector('.hist-section[data-section="_transcription"]');
      const cells = trans
        ? [...trans.querySelectorAll('.hist-grid-table td')].map(td => td.textContent.trim()) : [];
      const notes = trans
        ? [...trans.querySelectorAll('p')].map(p => p.textContent.replace(/\s+/g, ' ')).join(' ') : '';
      const head = document.querySelector('.hist-doc-head');
      return {
        secs, cells, notes,
        headText: head ? head.textContent.replace(/\s+/g, ' ') : '',
      };
    });
    check('the transcription leads an imported record',
      imp.secs[0] === '_transcription', imp.secs.join(', '));
    check('`>30` and `U/S` read back verbatim, as themselves',
      imp.cells.includes('>30') && imp.cells.includes('U/S'),
      imp.cells.join(' | ').slice(0, 160));
    check('and each says what it reads as — a bound, a status — not a number',
      imp.cells.some(c => /a bound, not a reading/.test(c))
      && imp.cells.some(c => /a status, not a number/.test(c)),
      imp.cells.join(' | ').slice(0, 160));
    check('the record names its source cell — workbook, sheet, row',
      /Fitzroy!/.test(imp.notes) && /row 42/.test(imp.notes), imp.notes.slice(0, 160));
    check('the heading refuses to sharpen a year into a date',
      /1994 — recorded to the year/.test(imp.headText)
      && !/1994-01-01/.test(imp.headText), imp.headText.slice(0, 200));
    check('the head says it was loaded, not typed',
      /historical workbook/i.test(imp.headText), imp.headText.slice(0, 200));

    const impCsv = await capture(page, () => History.exportRecord());
    check('the CSV carries the transcription — `>30` is in the file, dated 1994',
      /(^|,)"?>30"?(,|$)/m.test(impCsv) && /,1994,/.test(impCsv),
      impCsv.split('\r\n').slice(0, 3).join(' // '));

    // ── The unmatched scope (#128) ─────────────────────────────────────────
    await page.evaluate(() => { History.close(); History.showUnmatched(); });
    await page.waitForFunction(() => !!state.hist.list && !state.hist.listBusy,
      null, { timeout: LOAD_TIMEOUT });
    const parked = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('.hist-table tbody tr')].map(tr =>
        tr.textContent.replace(/\s+/g, ' ').trim()),
      heading: document.querySelector('.hist-list-panel h3').textContent.replace(/\s+/g, ' '),
    }));
    check('the unmatched scope reaches the parked visit, and only it',
      parked.rows.length === 1 && /SOMEWHERE CREEK ALERT/.test(parked.rows[0]),
      parked.rows.join(' // ').slice(0, 160));
    await page.evaluate(() => History.clearStation());
    await page.waitForFunction(() => !!state.hist.list && !state.hist.listBusy,
      null, { timeout: LOAD_TIMEOUT });

    // ── The Council form, read back ────────────────────────────────────────
    await page.evaluate(id => History.open('maintenance', id), ACTIVITY_ID);
    await page.waitForFunction(() => !!(state.hist.open && state.hist.open.doc),
      null, { timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(SETTLE);

    // Assertion 7. Three sub-blocks, three Conditions, three different answers.
    // A reader that showed one Condition for the panel would pass every other
    // assertion in this file and lose exactly what #148 repaired.
    const panel = await page.evaluate(() => {
      const el = document.querySelector('.hist-section[data-section="comms_power"]');
      if (!el) return null;
      const blocks = [...el.querySelectorAll('.hist-block')].map(h => h.textContent.trim());
      const conditions = [...el.querySelectorAll('.hist-field')]
        .filter(f => f.querySelector('.hist-label').textContent.trim().startsWith('Condition'))
        .map(f => f.querySelector('.hist-value').textContent.trim());
      return { blocks, conditions };
    });
    check('the Comms and Power panel reads back as three sub-blocks with three Conditions',
      !!panel && JSON.stringify(panel.blocks) === JSON.stringify(['Comms', 'Equipment', 'Power'])
      && JSON.stringify(panel.conditions) === JSON.stringify(conditionLabels),
      JSON.stringify(panel));

    const mAudit = await auditHandlers(page);
    check(`the Council record: all ${mAudit.checked} handler(s) resolve`,
      mAudit.unresolved.length === 0,
      mAudit.unresolved.map(u => `${u.path} (${u.attr})`).join('; '));

    // ── Signed out ─────────────────────────────────────────────────────────
    await page.evaluate(() => { dbSetAccessToken(null); History.close(); });
    await page.waitForTimeout(SETTLE);
    const gated = await page.evaluate(() => ({
      text: document.querySelector('.hist-page').textContent.replace(/\s+/g, ' '),
      rows: document.querySelectorAll('.hist-table tbody tr').length,
    }));
    check('signed out, the tab shows the gate and no record',
      /editors-only/i.test(gated.text) && gated.rows === 0,
      `${gated.rows} row(s)`);

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
  console.log('\nPASS — a saved record reads back as the sheet it was written on, and exports as it reads.');
}

// The download, read rather than saved. `URL.createObjectURL` is the one place
// every export in this file passes through, so the blob is taken there and the
// real URL is still returned — the anchor click goes ahead exactly as it would
// for a person, and the file it produces is the one asserted about.
async function capture(page, fn) {
  return page.evaluate(async body => {
    let blob = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = b => { blob = b; return orig.call(URL, b); };
    try { (new Function(`return (${body})`))()(); } finally { URL.createObjectURL = orig; }
    return blob ? await blob.text() : '';
  }, fn.toString());
}

// Enough of RFC 4180 for a file this app wrote: quoted fields, doubled quotes,
// CRLF between records. A leading BOM, because download() writes one.
function parseCsv(text) {
  const out = [];
  let row = [], cur = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; continue; }
      if (c === '"') { quoted = false; continue; }
      cur += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(cur); cur = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; continue; }
    cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); out.push(row); }
  return out;
}

main().catch(err => {
  console.error('\nThe history check could not run:\n', err);
  process.exitCode = 1;
});
