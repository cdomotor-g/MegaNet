// The app is Flood-Net in everything a person reads.
//
// It was MegaNet, and the repository, the database schema, storage keys, MQTT
// topics and the Worker still are — names nobody reads as the product's. The
// code comments say MegaNet too, and that is the drift this exists for: a new
// label is written next to a comment that calls the app MegaNet, and the old
// name is back on screen. Several threads push to main at once, so it would
// come back by the next week.
//
// So this tokenises every script the app, the Worker, the SDR Pi and the photo
// syncs run (acorn, the same parser `names` and `toplevel` use) and requires no
// string or template literal to say MegaNet, and none to start a file name with
// `meganet-` / `meganet_` (the downloads are `floodnet-…`). Comments are not
// read. Then the pages and agent files a person or an agent reads as they are:
// index.html and about.html outside their comments, llms.txt, robots.txt, the
// five agent instruction files and docs/agent-api.md.
//
// What may still say it, and why:
//   cdomotor-g/MegaNet               the repository's own name, in its URLs
//   github.io/MegaNet                the GitHub Pages copy, served from the repo
//   MegaNet:<hex> / MegaNet:demo     the Quansheng radio's station-table tag — the
//                                    firmware's built-in table carries it too, and
//                                    the field holds 15 characters
//   X-MegaNet-Client                 worker/api.js still reads the header's old
//                                    name (LEGACY_CLIENT_HEADER); never documented
//   "earlier name, MegaNet"          the one sentence that says what it used to be
//   meganet-log, meganet-sdr,        a file-picker id, the Pi's systemd unit and
//   meganet-api|…                    log tag, and a rate-limit hash salt
//
// Node only, no browser, well under a second.
//
// Run:  npm run brand     (node brand.mjs; -v lists what passed)

import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  if (!ok || VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const ALLOWED = /cdomotor-g\/MegaNet|github\.io\/MegaNet|MegaNet:(?=[0-9a-f]{4}|demo\b|['"`])|X-MegaNet-Client|earlier name,? MegaNet/g;
const OLD_NAME = /MegaNet/;
const OLD_FILE_PREFIX = /^meganet[-_]/;
const INTERNAL_IDS = new Set(['meganet-log', 'meganet-sdr', '[meganet-sdr] ', 'meganet-api|client|', 'meganet-api|address|']);

const ls = (dir, re) => fs.readdirSync(repo(dir)).filter(f => re.test(f)).map(f => path.join(dir, f));
const SCRIPTS = [
  ...ls('.', /\.js$/), ...ls('worker', /\.js$/), ...ls('sdr-pi', /\.js$/), ...ls('tools/field-photos/lib', /\.mjs$/),
];

// ── Strings in the scripts ───────────────────────────────────────────────────

let strings = 0;
for (const file of SCRIPTS) {
  const src = fs.readFileSync(repo(file), 'utf8');
  const bad = [];
  try {
    for (const t of acorn.tokenizer(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true,
      allowReturnOutsideFunction: true, locations: true })) {
      if (t.type !== acorn.tokTypes.string && t.type !== acorn.tokTypes.template) continue;
      strings++;
      const raw = src.slice(t.start, t.end);
      const body = t.type === acorn.tokTypes.string ? raw.slice(1, -1) : raw;
      if (OLD_NAME.test(raw.replace(ALLOWED, ''))
        || (OLD_FILE_PREFIX.test(body) && !INTERNAL_IDS.has(body))) bad.push(`${t.loc.start.line}: ${raw.slice(0, 80).replace(/\n/g, '⏎')}`);
    }
  } catch (e) {
    check(`${file} tokenises`, false, e.message);
    continue;
  }
  check(`${file}: no string says MegaNet or names a download meganet-…`, bad.length === 0, bad.join(' | '));
}

// ── Pages and agent files ────────────────────────────────────────────────────

const PAGES = ['index.html', 'about.html', 'llms.txt', 'robots.txt', 'docs/agent-api.md',
  'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursor/rules/floodnet-api.mdc'];
for (const file of PAGES) {
  let text = fs.readFileSync(repo(file), 'utf8');
  if (file.endsWith('.html')) text = text.replace(/<!--[\s\S]*?-->/g, '');
  const bad = text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => OLD_NAME.test(l.replace(ALLOWED, '')));
  check(`${file} says Flood-Net`, bad.length === 0, bad.map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`).join(' | '));
}

// ── Verdict ──────────────────────────────────────────────────────────────────

console.log('');
const failed = results.filter(r => !r.ok);
if (failed.length) {
  console.log(`FAIL — ${failed.length} of ${results.length} check(s) failed.\n`);
  console.log('  The app is Flood-Net wherever a person reads it; "meganet" is only an internal');
  console.log('  identifier now. Say Flood-Net in the string, and name a download floodnet-….\n');
  process.exit(1);
}
console.log(`PASS — ${results.length} checks, ${strings} strings in ${SCRIPTS.length} scripts: nothing a person reads says MegaNet.`);
