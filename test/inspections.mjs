// The Inspections tab, rendered against the schema's own seed data (#116).
//
// Why this is a check of its own rather than another tab in `npm run smoke`.
//
// Smoke's network policy aborts every off-origin request, which is exactly
// right for the other sixteen tabs — the run is deterministic and needs no
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
//   5. Typing three tip-test errors produces the mean, and the printed 6% rule
//      reads against it.
//   6. Save sends a document with no section the form does not print, with what
//      was typed in it, and with the empty grids pruned out — "not recorded" is
//      no row, not a row of nulls.
//
// Run:  npm run insp
//       npm run insp -- -v    also print what passed

import fs from 'node:fs';
import { repo } from './lib/paths.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { auditHandlers } from './lib/controls.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const SETTLE = Number(process.env.SMOKE_TAB_SETTLE || 300);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── The seed data, read out of the migration ─────────────────────────────────
// Every `insert into meganet.X (cols) values (…), (…)` in 0009. The tuples are
// plain: single-quoted strings with '' for an embedded quote, integers, and
// true/false. Nothing here tries to be a SQL parser — it is a reader for the
// one statement shape this file uses, and it fails loudly rather than returning
// an empty table, because an empty fixture is how this test would pass while
// testing nothing.

function splitTuples(body) {
  const tuples = [];
  let depth = 0, quoted = false, cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === "'" && body[i + 1] === "'") { cur += "''"; i++; continue; }
      if (c === "'") { quoted = false; cur += c; continue; }
      cur += c;
      continue;
    }
    if (c === "'") { quoted = true; cur += c; continue; }
    if (c === '(') { depth++; if (depth === 1) { cur = ''; continue; } }
    if (c === ')') { depth--; if (depth === 0) { tuples.push(cur); continue; } }
    if (depth > 0) cur += c;
  }
  return tuples;
}

function splitValues(tuple) {
  const out = [];
  let quoted = false, cur = '';
  for (let i = 0; i < tuple.length; i++) {
    const c = tuple[i];
    if (quoted) {
      if (c === "'" && tuple[i + 1] === "'") { cur += "'"; i++; continue; }
      if (c === "'") { quoted = false; continue; }
      cur += c;
      continue;
    }
    if (c === "'") { quoted = true; continue; }
    if (c === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  // A bare word that survived unquoted is a number or a boolean; anything that
  // was quoted has already had its quotes taken off, and a quoted empty string
  // arrives here as ''. Distinguishing the two matters only for `''`, which is
  // a legitimate value in this file and reads as an empty string either way.
  return out;
}

function seedRows(sql, table) {
  const re = new RegExp(
    `insert into meganet\\.${table}\\s*\\(([^)]*)\\)\\s*values([\\s\\S]*?)\\non conflict`, 'i');
  const m = sql.match(re);
  if (!m) throw new Error(`no seed insert found for meganet.${table} in 0009`);
  const cols = m[1].split(',').map(s => s.trim());
  const rows = splitTuples(m[2]).map(t => {
    const vals = splitValues(t);
    const row = {};
    cols.forEach((c, i) => {
      const raw = vals[i];
      if (raw === undefined) { row[c] = null; return; }
      if (raw === 'true' || raw === 'false') { row[c] = raw === 'true'; return; }
      if (/^-?\d+(\.\d+)?$/.test(raw)) { row[c] = Number(raw); return; }
      // Doubled percent signs are printf escapes in the migration's COMMENT
      // strings; they do not appear in a value, but strip them if one ever does.
      row[c] = raw;
    });
    return row;
  });
  if (!rows.length) throw new Error(`meganet.${table} parsed to zero rows`);
  return rows;
}

function buildFixture() {
  const sql = fs.readFileSync(repo('db', 'migrations', '0009_inspections.sql'), 'utf8');
  const tables = {};
  for (const t of ['inspection_config', 'inspection_section', 'inspection_config_section',
                   'calibration_kind', 'rain_instrument_type', 'condition_rating',
                   'wl_instrument_type', 'power_supply', 'yes_no', 'data_quality_rating',
                   'equipment_kind']) {
    tables[t] = seedRows(sql, t);
  }
  // meganet.inspection_form, composed the way the view composes it.
  const byCfg = Object.fromEntries(tables.inspection_config.map(c => [c.key, c]));
  const bySec = Object.fromEntries(tables.inspection_section.map(s => [s.key, s]));
  tables.inspection_form = tables.inspection_config_section.map(cs => ({
    config_key: cs.config_key,
    config_label: byCfg[cs.config_key].label,
    config_sheet: byCfg[cs.config_key].sheet,
    ord: cs.ord,
    section_key: cs.section_key,
    section_label: bySec[cs.section_key].label,
    section_home: bySec[cs.section_key].home,
    section_note: bySec[cs.section_key].note,
    variant_note: cs.variant_note,
  }));
  return tables;
}

// ── The datastore, answered from the fixture ─────────────────────────────────
// Installed *after* the network policy, so Playwright reaches it first: the
// policy aborts everything off-origin, and this rescues the handful of reads
// the tab makes before the abort can. Only the paths this tab uses are served;
// anything else falls through to the abort, which is what keeps the test from
// quietly depending on a request nobody meant to make.

function installDatastore(page, tables, saved) {
  return page.route('**://*.supabase.co/rest/v1/**', async route => {
    const url = new URL(route.request().url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');

    if (route.request().method() === 'POST' && name.startsWith('rpc/')) {
      const fn = name.slice(4);
      const body = JSON.parse(route.request().postData() || '{}');
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
  const tables = buildFixture();
  check(`0009 parsed — ${tables.inspection_config.length} configurations, `
      + `${tables.inspection_section.length} sections, `
      + `${tables.inspection_config_section.length} matrix rows`,
    tables.inspection_config.length === 6 && tables.inspection_section.length === 14,
    'six configurations and fourteen sections is what 0009 says it created');

  const server = await startServer();
  const browser = await launchBrowser();
  const saved = [];
  const errors = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    await installDatastore(page, tables, saved);

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

      // The two boxes 0009 has no column for are stated on the form that prints
      // them. A gap the form admits to is the point; a gap it hides is the bug.
      const gaps = await page.evaluate(() =>
        [...document.querySelectorAll('.insp-gap li')].map(e => e.textContent.trim()));
      const wantGaps = { base_station: 1, mace: 1 }[cfg.key] || 0;
      check(`${cfg.key}: states its ${wantGaps} uncaptured box${wantGaps === 1 ? '' : 'es'}`,
        gaps.length === wantGaps, gaps.join(' | '));

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
