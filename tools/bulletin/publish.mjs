// tools/bulletin/publish.mjs — a written bulletin into data/bulletins/.
//
// The last step of the scheduled bulletin task (tools/bulletin/README.md):
// checks the draft against what a bulletin may hold (validate.mjs) and the
// stations it names against the register, writes it to
// data/bulletins/<daily|weekly>/<date>.json, and puts it at the head of
// data/bulletins/index.json — replacing an earlier one of the same day, and
// letting the oldest go (fourteen dailies, eight weeklies are kept; git
// keeps the rest). It changes nothing else, and pushes nothing: the task
// commits and pushes the two files itself.
//
// Run:  node tools/bulletin/publish.mjs DRAFT.json [--facts FACTS.json] [--dry-run]
//
// Exits 1 with the problems listed when the draft would not be drawn as
// written; warnings are printed and do not stop it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, validateIndex, INDEX_FORMAT } from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
export const KEEP = { daily: 14, weekly: 8 };

export function stationIds({ facts = null, repo = REPO } = {}) {
  if (facts && Array.isArray(facts.known_ids) && facts.known_ids.length) return new Set(facts.known_ids);
  const doc = JSON.parse(fs.readFileSync(path.join(repo, 'stations.json'), 'utf8'));
  return new Set((doc.stations || []).map(s => s.id));
}

export function publish(b, { repo = REPO, ids, dry = false, log = console.log } = {}) {
  const { errors, warnings } = validate(b, { stationIds: ids });
  warnings.forEach(w => log(`  warning  ${w}`));
  if (errors.length) return { ok: false, errors, warnings };
  const date = b.id.slice(-10);
  const rel = `data/bulletins/${b.kind}/${date}.json`;
  const ixRel = 'data/bulletins/index.json';
  const ixPath = path.join(repo, ixRel);
  let ix = { format: INDEX_FORMAT, updated_at: null, daily: [], weekly: [] };
  if (fs.existsSync(ixPath)) ix = JSON.parse(fs.readFileSync(ixPath, 'utf8'));
  const entry = { id: b.id, file: rel, issued_at: b.issued_at, headline: b.headline, sky: b.outlook.sky, presenter: b.presenter };
  const list = (ix[b.kind] || []).filter(e => e.id !== b.id);
  list.push(entry);
  list.sort((x, y) => Date.parse(y.issued_at) - Date.parse(x.issued_at));
  const dropped = list.splice(KEEP[b.kind]);
  ix[b.kind] = list;
  ix.updated_at = new Date().toISOString();
  const chk = validateIndex(ix);
  if (chk.errors.length) return { ok: false, errors: chk.errors.map(e => `index: ${e}`), warnings };
  if (!dry) {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), JSON.stringify(b, null, 1) + '\n');
    fs.writeFileSync(ixPath, JSON.stringify(ix, null, 1) + '\n');
    for (const e of dropped) { const p = path.join(repo, e.file); if (fs.existsSync(p) && e.file !== rel) fs.unlinkSync(p); }
  }
  return { ok: true, file: rel, index: ixRel, dropped: dropped.map(e => e.file), warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const file = argv.find(a => !a.startsWith('--') && a !== arg('--facts'));
  if (!file) { console.error('node tools/bulletin/publish.mjs DRAFT.json [--facts FACTS.json] [--dry-run]'); process.exit(2); }
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  const facts = arg('--facts') ? JSON.parse(fs.readFileSync(arg('--facts'), 'utf8')) : null;
  const out = publish(b, { ids: stationIds({ facts }), dry: argv.includes('--dry-run') });
  if (!out.ok) { console.error(`Not published — ${out.errors.length} problem${out.errors.length === 1 ? '' : 's'}:`); out.errors.forEach(e => console.error(`  ${e}`)); process.exit(1); }
  console.log(`${argv.includes('--dry-run') ? 'Would publish' : 'Published'} ${out.file} and ${out.index}${out.dropped.length ? `; let go ${out.dropped.join(', ')}` : ''}.`);
  if (!argv.includes('--dry-run')) console.log(`Next: git add ${out.file} ${out.index}${out.dropped.length ? ' ' + out.dropped.join(' ') : ''} && git commit && git push origin main`);
}
