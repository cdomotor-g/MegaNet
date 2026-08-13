// The Inspections tab, rendered against the schema's own seed data (#116).
//
// Why this is a check of its own rather than another tab in `npm run smoke`.
//
// Smoke's network policy aborts every off-origin request, which is exactly
// right for the other seventeen tabs — the run is deterministic and needs no
// network. But this tab renders *from* the datastore: the sections a
// configuration prints come out of `meganet.inspection_form`, and every
// pick-list on the form comes out of a lookup table. Under smoke's policy the
// tab correctly renders "the form itself could not be loaded", the handler
// audit sees six handlers, and a 1,500-line form nobody rendered passes.
//
// So this test supplies the reference data instead of blocking it — and takes
// it **out of `db/migrations/0009_inspections.sql`**, not out of a fixture file
// copied from it. That matters more than the convenience: the form's whole
// claim is that it renders what the database says, so a test that renders it
// against a hand-written copy of what the database says is testing the copy.
// Parse the migration, and an edit to the matrix that the form cannot render
// fails here.
//
// What it asserts, per configuration, for all six:
//
//   1. Every section the matrix says that configuration prints has a banner on
//      screen, in the matrix's own order — and no section it does not print.
//   2. Every section it does *not* print is named under "Not on this form",
//      because a stated gap is the whole point of the matrix (0009, decision 2).
//   3. Every `on*=` handler the tab rendered resolves in page scope. Same check
//      smoke runs, against a page smoke never gets to see.
//   4. No calibration block is offered that the database's own guard would
//      refuse — the kind's section has to be one the configuration prints.
//   4b. No configuration states an uncaptured box, and the five that used to be
//      uncaptured are on screen on the sheets that print them and on no others
//      (0011 / #146). Zero gaps on its own would also be true of a form that
//      quietly dropped them, which is why both halves are here.
//   5. Typing three tip-test errors produces the mean, and the printed 6% rule
//      reads against it.
//   6. Save sends a document with no section the form does not print, with what
//      was typed in it, and with the empty grids pruned out — "not recorded" is
//      no row, not a row of nulls.
//   7. A photo attaches to a saved visit and not to an unsaved one; the bytes go
//      up before the index row; the object is named with a generated uuid under
//      the visit's own prefix rather than with the camera's filename; a type or
//      a size the vocabulary refuses is refused before anything is uploaded; and
//      removing takes the row first and the bytes second (#149).
//
// Run:  npm run insp
//       npm run insp -- -v    also print what passed

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

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── The seed data, read out of the migration ─────────────────────────────────
// Every `insert into meganet.X (cols) values (…), (…)` in 0009, parsed rather
// than copied — see lib/migration.mjs for the reader and for why the fixture
// has to come out of the migration itself. The reader moved there at #117,
// which needs the same ten vocabularies for the same reason.

// ── The datastore, answered from the fixture ─────────────────────────────────
// Installed *after* the network policy, so Playwright reaches it first: the
// policy aborts everything off-origin, and this rescues the handful of reads
// the tab makes before the abort can. Only the paths this tab uses are served;
// anything else falls through to the abort, which is what keeps the test from
// quietly depending on a request nobody meant to make.

function installDatastore(page, tables, saved, store) {
  return page.route('**://*.supabase.co/rest/v1/**', async route => {
    const url = new URL(route.request().url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');

    if (route.request().method() === 'POST' && name.startsWith('rpc/')) {
      const fn = name.slice(4);
      const body = JSON.parse(route.request().postData() || '{}');
      const att = attachmentRpc(fn, body, store);
      if (att !== undefined) {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify(att) });
      }
      if (fn === 'save_inspection') {
        saved.push(body.p_doc);
        const doc = Object.assign({}, body.p_doc, {
          id: body.p_doc.id || '00000000-0000-4000-8000-000000000001',
          updated_at: '2026-08-13T00:00:00Z',
        });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) });
      }
      return route.fulfill({ status: 404, contentType: 'application/json',
        body: JSON.stringify({ message: `no such function ${fn} in this fixture` }) });
    }

    const table = name.split('?')[0];
    if (table === 'attachment') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(attachmentRows(store, url.search)) });
    }
    const rows = tables[table];
    if (!rows) {
      return route.fulfill({ status: 404, contentType: 'application/json',
        body: JSON.stringify({ message: `${table} is not in the fixture` }) });
    }
    // `order=` is honoured because the tab renders in the order the database
    // hands rows back and the matrix's `ord` is load-bearing.
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
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  const tables = formFixture();
  check(`0009 parsed — ${tables.inspection_config.length} configurations, `
      + `${tables.inspection_section.length} sections, `
      + `${tables.inspection_config_section.length} matrix rows`,
    tables.inspection_config.length === 6 && tables.inspection_section.length === 14,
    'six configurations and fourteen sections is what 0009 says it created');

  const server = await startServer();
  const browser = await launchBrowser();
  const saved = [];
  const errors = [];
  const store = storageStore();

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    await installDatastore(page, tables, saved, store);
    await installStorage(page, store);

    page.on('pageerror', e => errors.push(e.stack || e.message));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/^Failed to load resource|ERR_BLOCKED_BY_CLIENT|ERR_FAILED/i.test(t)) return;
      errors.push(t);
    });

    await page.goto(server.origin + '/index.html', { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    // `state` is a top-level `const` in a classic script, so it is a global
    // lexical binding and not a property of `window` — reachable by name here,
    // invisible to `window.state`.
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data,
      null, { timeout: LOAD_TIMEOUT });

    await page.evaluate(() => switchTab('inspections'));
    await page.waitForFunction(() => state.insp.refs || state.insp.refsError,
      null, { timeout: LOAD_TIMEOUT });

    const refsError = await page.evaluate(() => state.insp.refsError);
    check('the form matrix loaded', !refsError, refsError || '');
    if (refsError) throw new Error('nothing else can be checked without the matrix');

    // Open a blank form once per configuration and read the page back.
    let alertPanel = '';
    for (const cfg of tables.inspection_config) {
      await page.evaluate(key => {
        Inspections.pick(null);
        Inspections.setConfig(key);
      }, cfg.key);
      await page.waitForTimeout(SETTLE);

      const seen = await page.evaluate(() =>
        [...document.querySelectorAll('.insp-section')].map(s => s.dataset.section));
      const want = tables.inspection_config_section
        .filter(r => r.config_key === cfg.key)
        .sort((a, b) => a.ord - b.ord)
        .map(r => r.section_key);

      check(`${cfg.key}: renders ${want.length} sections, in the matrix's order`,
        JSON.stringify(seen) === JSON.stringify(want),
        `on screen: ${seen.join(', ')} | matrix: ${want.join(', ')}`);

      const absent = await page.evaluate(() =>
        [...document.querySelectorAll('.insp-absent-list li strong')].map(e => e.textContent));
      const wantAbsent = tables.inspection_section
        .filter(s => !want.includes(s.key)).map(s => s.label);
      check(`${cfg.key}: names the ${wantAbsent.length} sections it does not print`,
        JSON.stringify(absent.slice().sort()) === JSON.stringify(wantAbsent.slice().sort()),
        `on screen: ${absent.join(', ')}`);

      // Every calibration block offered has to be one the guard would accept:
      // the kind's section must be a section this configuration prints.
      const offered = await page.evaluate(() =>
        (state.insp.doc.calibrations || []).map(r => r.kind_key));
      const kinds = Object.fromEntries(tables.calibration_kind.map(k => [k.key, k.section_key]));
      const illegal = [...new Set(offered)].filter(k => !want.includes(kinds[k]));
      check(`${cfg.key}: offers no calibration the section guard would refuse`,
        illegal.length === 0, illegal.join(', '));

      const audit = await auditHandlers(page);
      check(`${cfg.key}: all ${audit.checked} handler(s) across ${audit.total} attribute(s) resolve`,
        audit.unresolved.length === 0,
        audit.unresolved.map(u => `${u.path} (${u.attr} on ${u.where})`).join('; '));

      // The Serial Numbers panel is per sheet, and every configuration here is
      // reached by switching one on a form that already carried another sheet's
      // panel. An untouched panel has to be re-seeded rather than carried over
      // — every one of the six names a different set of equipment, so the
      // no-two-sheets-agree property is what this asserts against.
      const serials = await page.evaluate(() =>
        (state.insp.doc.serials || []).map(r => `${r.equipment_key}|${r.label}`));
      if (cfg.key === 'alert') alertPanel = serials.join(',');
      check(`${cfg.key}: shows its own Serial Numbers panel after a configuration change`,
        serials.length > 0 && serials.every(s => !s.endsWith('|'))
        && (cfg.key === 'alert' || serials.join(',') !== alertPanel),
        serials.join(' · '));

      // The five boxes 0009 had no column for are boxes now (0011 / #146), so
      // every sheet maps box for box and no configuration states a gap. Asserted
      // as zero rather than deleted: the mechanism is still there for the next
      // unhomed box, and this is what says nothing is quietly using it.
      const gaps = await page.evaluate(() =>
        [...document.querySelectorAll('.insp-gap li')].map(e => e.textContent.trim()));
      check(`${cfg.key}: states no uncaptured box`, gaps.length === 0, gaps.join(' | '));

      // And the other half of that claim, which zero gaps does not make: the
      // five are on screen, on the sheets that print them and on no other. The
      // Base Station Time is a column on meganet.inspection and the four Mace DP
      // voltages are on meganet.inspection_power, so nothing but this file's
      // `only:` stops them appearing on all six.
      const boxes = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('.insp-page [oninput], .insp-page [onchange]')) {
          const h = el.getAttribute('oninput') || el.getAttribute('onchange') || '';
          const m = h.match(/Inspections\.set\('([^']+)'/);
          if (m) out.push(m[1]);
        }
        return out;
      });
      const wantBoxes = {
        base_station: ['top.inspected_at_time'],
        mace: ['power.dp_existing_v', 'power.dp_existing_v_under_load',
               'power.dp_replacement_v', 'power.dp_replacement_v_under_load'],
      };
      const shouldHave = wantBoxes[cfg.key] || [];
      const shouldNot = Object.entries(wantBoxes)
        .filter(([k]) => k !== cfg.key).flatMap(([, v]) => v);
      const missing = shouldHave.filter(p => !boxes.includes(p));
      const stray = shouldNot.filter(p => boxes.includes(p));
      check(`${cfg.key}: shows the ${shouldHave.length} box(es) 0011 gave it a column for, and no other sheet's`,
        missing.length === 0 && stray.length === 0,
        [...missing.map(p => `missing ${p}`), ...stray.map(p => `${p} is another sheet's`)].join('; '));

      // The tip-test reference values are printed on the sheet, differ per
      // sheet, and are what the % errors are worked out against — so the form
      // fills them in rather than leaving a crew to remember them.
      if (want.includes('rain_gauge')) {
        const rg = await page.evaluate(() => state.insp.doc.rain_gauge || {});
        const refs = { alert: [10, 10.4], campbell_datalogger: [20.8, 20.2],
                       mace: [10.302, 9.707], datalogger_old: [20.8, 20.2] }[cfg.key];
        check(`${cfg.key}: pre-fills the printed reference values (HS ${refs[0]} mm, Rimco ${refs[1]} mm)`,
          rg.expected_hs_mm === refs[0] && rg.expected_rimco_mm === refs[1],
          `HS ${rg.expected_hs_mm} · Rimco ${rg.expected_rimco_mm}`);
      }
    }

    // ── The printed 6% rule ──────────────────────────────────────────────────
    // Campbell prints an initial and a final tip-test grid; the rule is read
    // against the final one. Three errors either side of the threshold.
    for (const [errs, expect] of [[[2, 3, 4], false], [[7, 8, 9], true]]) {
      await page.evaluate(key => { Inspections.pick(null); Inspections.setConfig(key); },
        'campbell_datalogger');
      await page.waitForTimeout(SETTLE);
      await page.evaluate(list => {
        state.insp.doc.calibrations.forEach((r, i) => {
          if (r.kind_key !== 'rain_tip_test' || r.phase !== 'final') return;
          Inspections.set(`calibrations.${i}.pct_error`, String(list[r.ord - 1]), 'num');
        });
      }, errs);
      const mean = await page.evaluate(() => state.insp.doc.rain_gauge.mean_pct_error);
      const text = await page.evaluate(() => {
        const el = document.getElementById('insp-tip-rule');
        return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
      });
      const want = errs.reduce((a, b) => a + b, 0) / errs.length;
      // "adjustment indicated" is a substring of "no adjustment indicated", so
      // the negative has to be asserted rather than merely not matched.
      const said = text.includes('no adjustment indicated') ? false
                 : text.includes('adjustment indicated') ? true : null;
      check(`the 6% rule: mean of ${errs.join('/')} is ${want} and reads `
          + `"${expect ? '' : 'no '}adjustment indicated"`,
        mean === want && said === expect,
        `mean ${mean} · ${text}`);
    }

    // ── Saving ───────────────────────────────────────────────────────────────
    // Gas Only is the sharpest case for the pruning rule: five sections, so a
    // document carrying a rain gauge or a radio would be one the database
    // refuses outright.
    await page.evaluate(() => { Inspections.pick(null); Inspections.setConfig('gas_only'); });
    await page.waitForTimeout(SETTLE);
    await page.evaluate(() => {
      Inspections.set('top.station_name', 'Test Creek', 'text');
      Inspections.set('top.cbm_no', '999999', 'text');
      Inspections.set('gas.existing_cylinder_pressure_kpa', '4200', 'num');
      Inspections.set('gas.tested_for_leaks', 'true', 'bool');
      Inspections.set('water_level.staff_gauge_note', '1.42 m', 'text');
      dbSetAccessToken('test-token');
    });
    await page.evaluate(() => Inspections.save());
    await page.waitForFunction(() => !state.insp.busy, null, { timeout: LOAD_TIMEOUT });

    const doc = saved[saved.length - 1];
    check('save sends a document', !!doc);
    if (doc) {
      check('save: carries the configuration and what was typed',
        doc.config_key === 'gas_only' && doc.station_name === 'Test Creek'
        && doc.gas && doc.gas.existing_cylinder_pressure_kpa === 4200
        && doc.gas.tested_for_leaks === true
        && doc.water_level && doc.water_level.staff_gauge_note === '1.42 m',
        JSON.stringify({ cfg: doc.config_key, gas: doc.gas, wl: doc.water_level }));

      // Gas Only prints details, serials, gas, water level and remarks. A
      // rain-gauge, power, radio or admin object on this document is a row the
      // section guard would refuse.
      const forbidden = ['rain_gauge', 'power', 'radio', 'admin'].filter(k => doc[k]);
      check('save: carries no section the Gas Only form does not print',
        forbidden.length === 0, forbidden.join(', '));

      check('save: prunes the grids nobody filled in',
        (doc.serials || []).length === 0 && (doc.calibrations || []).length === 0
        && (doc.data_quality || []).length === 0 && !Object.keys(doc.data || {}).length,
        `serials ${(doc.serials || []).length}, calibrations ${(doc.calibrations || []).length}`);
    }

    // ── Attachments (#149) ───────────────────────────────────────────────────
    // The Alert sheet, because Mace and DataLogger - old print no photo
    // checklist at all and Gas Only prints five sections none of which is it —
    // so the panel's home is the one section the matrix says this configuration
    // has. What is being checked here is what went over the wire, not that the
    // database would accept it: tools/check_attachments.sql owns that, against a
    // real Postgres, and a second copy of those rules in the fixture would only
    // ever be able to disagree with the first.
    await page.evaluate(() => { Inspections.pick(null); Inspections.setConfig('alert'); });
    await page.waitForTimeout(SETTLE);

    const unsavedPanel = await page.evaluate(() => {
      const el = document.querySelector('.att-panel');
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    });
    check('an unsaved visit offers no uploader, because the file needs a row to hang off',
      /Save this record first/.test(unsavedPanel) && !/input/i.test(unsavedPanel),
      unsavedPanel.slice(0, 90));

    await page.evaluate(() => Inspections.save());
    await page.waitForFunction(() => !state.insp.busy && state.insp.doc.id,
      null, { timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => !!document.querySelector('.att-panel input[type="file"]'),
      null, { timeout: LOAD_TIMEOUT });
    check('once saved, the panel offers a file picker', true);

    // A file the vocabulary does not carry, first. It has to be refused *before*
    // anything is uploaded — the whole point of checking the type in the browser
    // as well as in the database is to not spend a paddock's worth of signal on
    // a file that will be refused at the end of it.
    await page.setInputFiles('.att-panel input[type="file"]',
      fileOf('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 512));
    await page.waitForFunction(() => !state.attach.busy, null, { timeout: LOAD_TIMEOUT });
    check('a type the vocabulary does not carry is refused without uploading anything',
      store.uploads.length === 0 && store.calls.length === 0,
      `${store.uploads.length} upload(s), ${store.calls.length} rpc call(s)`);

    // And one over the limit its own type carries. text/plain is capped at 1 MB
    // in 0010 precisely because one limit generous enough for a phone photo is
    // no limit at all on a terminal dump — so this is the type whose limit is
    // worth proving the browser reads.
    await page.setInputFiles('.att-panel input[type="file"]',
      fileOf('dump.txt', 'text/plain', 2 * 1024 * 1024));
    await page.waitForFunction(() => !state.attach.busy, null, { timeout: LOAD_TIMEOUT });
    check('a file over its type\'s limit is refused without uploading anything',
      store.uploads.length === 0 && store.calls.length === 0,
      `${store.uploads.length} upload(s)`);

    await page.setInputFiles('.att-panel input[type="file"]',
      fileOf('IMG_0042.jpg', 'image/jpeg', 4096));
    await page.waitForFunction(() => (state.attach.list || []).length === 1,
      null, { timeout: LOAD_TIMEOUT });

    const call = store.calls.find(c => c.fn === 'attach_file');
    check('the bytes go up before the index row does',
      store.uploads.length === 1 && !!call
      && store.uploads[0].path === call.body.p_storage_path,
      `${store.uploads.length} upload(s), path ${store.uploads[0] && store.uploads[0].path}`);

    check('the index row names the inspection and only the inspection',
      !!call && call.body.p_inspection_id === '00000000-0000-4000-8000-000000000001'
      && call.body.p_maintenance_activity_id === undefined
      && call.body.p_role_key === 'photo',
      JSON.stringify(call && { i: call.body.p_inspection_id, r: call.body.p_role_key }));

    // The security-carrying half: the object is named by the app, not by the
    // phone. A private bucket read through signed URLs is only as private as its
    // paths are unguessable, and `IMG_0042.jpg` under a known visit id is a
    // guess away. meganet.attach_file() refuses anything else; this is the
    // browser holding up its end.
    const path = call ? call.body.p_storage_path : '';
    check('the object is named with a generated uuid, under the record\'s own prefix',
      new RegExp('^inspection/00000000-0000-4000-8000-000000000001/'
               + '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$').test(path),
      path);
    check('the file\'s own name is kept as the title, not as the address',
      !!call && call.body.p_title === 'IMG_0042.jpg' && !path.includes('IMG_0042'), path);

    // The thumbnail resolves after the panel is on screen — the panel is built
    // as a string and the URL is signed behind it — so wait for the cache rather
    // than for the render. `state.attach.urls` is keyed by object path, which is
    // what makes "was this one signed" answerable without a timeout.
    await page.waitForFunction(p => !!state.attach.urls[p], path, { timeout: LOAD_TIMEOUT });
    check('the thumbnail is fetched through a signed URL rather than a public one',
      store.signed.includes(path), store.signed.join(', '));

    const attAudit = await auditHandlers(page);
    check(`attachments: all ${attAudit.checked} handler(s) across ${attAudit.total} attribute(s) resolve`,
      attAudit.unresolved.length === 0,
      attAudit.unresolved.map(u => `${u.path} (${u.attr} on ${u.where})`).join('; '));

    // Removing takes the index row first and the bytes second — a photo that has
    // gone from the form and not from the bucket is invisible; the reverse is a
    // broken thumbnail on a record somebody is relying on.
    await page.evaluate(() => { window.confirm = () => true; });
    await page.evaluate(() => Attachments.remove(state.attach.list[0].id));
    await page.waitForFunction(() => (state.attach.list || []).length === 0,
      null, { timeout: LOAD_TIMEOUT });
    check('removing drops the index row and then deletes the object',
      store.rows.length === 0 && store.removed.includes(path),
      `removed: ${store.removed.join(', ')}`);

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
  console.log('\nPASS — the form renders what the matrix says, on all six sheets.');
}

main().catch(err => {
  console.error('\nThe inspections check could not run:\n', err);
  process.exitCode = 1;
});
