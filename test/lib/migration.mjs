// The seed rows in a migration, read out of the migration (#116, shared at #117).
//
// Every `insert into meganet.X (cols) values (…), (…) on conflict` in a
// migration file. The tuples are plain: single-quoted strings with '' for an
// embedded quote, integers, and true/false. Nothing here tries to be a SQL
// parser — it is a reader for the one statement shape 0009 uses, and it fails
// loudly rather than returning an empty table, because an empty fixture is how
// a test would pass while testing nothing.
//
// This started inside `inspections.mjs`. It moved here when the maintenance
// check needed the same ten vocabularies for the same reason: both tabs claim
// to render what the database says, and both fixtures have to come *out of* the
// database's own file rather than out of a copy of it. Two copies of this
// reader would be two things to keep in step.

import fs from 'node:fs';
import { repo } from './paths.mjs';

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

/** The rows one `insert into meganet.<table> … on conflict` statement seeds. */
export function seedRows(sql, table) {
  const re = new RegExp(
    `insert into meganet\\.${table}\\s*\\(([^)]*)\\)\\s*values([\\s\\S]*?)\\non conflict`, 'i');
  const m = sql.match(re);
  if (!m) throw new Error(`no seed insert found for meganet.${table}`);
  const cols = m[1].split(',').map(s => s.trim());
  const rows = splitTuples(m[2]).map(t => {
    const vals = splitValues(t);
    const row = {};
    cols.forEach((c, i) => {
      const raw = vals[i];
      if (raw === undefined) { row[c] = null; return; }
      if (raw === 'true' || raw === 'false') { row[c] = raw === 'true'; return; }
      if (/^-?\d+(\.\d+)?$/.test(raw)) { row[c] = Number(raw); return; }
      row[c] = raw;
    });
    return row;
  });
  if (!rows.length) throw new Error(`meganet.${table} parsed to zero rows`);
  return rows;
}

/** `db/migrations/0009_inspections.sql`, read once. */
export function inspectionsSql() {
  return fs.readFileSync(repo('db', 'migrations', '0009_inspections.sql'), 'utf8');
}

/** Several tables out of one migration, as { table: rows }. */
export function seedTables(sql, tables) {
  const out = {};
  for (const t of tables) out[t] = seedRows(sql, t);
  return out;
}

// Every table either form tab reads, plus meganet.inspection_form composed the
// way the view composes it. One list rather than two: the Inspections tab and
// the Site Maintenance tab share nine of the ten vocabularies, and a fixture
// that served one of them a different set of rows than the other would be
// testing something neither tab does.
export const FORM_TABLES = [
  'rain_instrument_type', 'wl_instrument_type', 'condition_rating', 'asset_owner',
  'comms_method', 'comms_equipment', 'power_supply', 'yes_no', 'data_quality_rating',
  'council', 'equipment_kind', 'attachment_role',
  'inspection_config', 'inspection_section', 'inspection_config_section',
  'calibration_kind',
];

export function formFixture() {
  const tables = seedTables(inspectionsSql(), FORM_TABLES);
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
