// The agent API's documentation says what the code does.
//
// The facts an agent needs — where the API is, where the MCP server is, and how
// fast it may ask — are written in seven places: worker/api.js, wrangler.toml,
// docs/agent-api.md and the five agent instruction files (AGENTS.md, GEMINI.md,
// .github/copilot-instructions.md, llms.txt, .cursor/rules/floodnet-api.mdc).
// There are five of those on purpose — each agent reads its own file and not the
// others — and that is exactly how they drift: a limit changed in the code and
// in two files, with three still quoting the old number to every agent that
// reads them. Nothing about that is visible from the running app.
//
// So this reads the numbers and URLs out of worker/api.js itself and requires
// every file to say the same: the base URL, the MCP URL, each rate limit as
// "<limit> requests / <period> s", and a pointer to docs/agent-api.md. It also
// holds wrangler.toml's [[ratelimits]] to RATE_LIMITS (a binding the code does
// not expect is a limit nobody enforces), every OpenAPI path, query parameter
// and MCP tool to the user doc — and every tool to each agent file that lists
// them — llms.txt to the llmstxt.org shape, and every relative link in the
// docs to a file that exists.
//
// Node only, no browser, well under a second.
//
// Run:  npm run agentdocs     (node agent-docs.mjs; -v lists what passed)

import fs from 'node:fs';
import path from 'node:path';
import { repo } from './lib/paths.mjs';
import * as api from '../worker/api.js';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  if (!ok || VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const read = rel => {
  try { return fs.readFileSync(repo(rel), 'utf8'); } catch (_) { return null; }
};

const DOC = 'docs/agent-api.md';
const AGENT_FILES = ['AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md', 'llms.txt', '.cursor/rules/floodnet-api.mdc'];
const RATE_PHRASES = api.RATE_LIMITS.map(r => `${r.limit} requests / ${r.period} s`);

// ── Every file states the same facts ─────────────────────────────────────────

for (const file of [DOC, ...AGENT_FILES]) {
  const text = read(file);
  check(`${file} exists`, text !== null);
  if (text === null) continue;
  check(`${file} names the API base URL`, text.includes(api.API_BASE_URL), api.API_BASE_URL);
  check(`${file} names the MCP URL`, text.includes(api.MCP_URL), api.MCP_URL);
  const missing = RATE_PHRASES.filter(p => !text.includes(p));
  check(`${file} states every rate limit as the code sets it`, missing.length === 0,
    missing.length ? `missing: ${missing.join('; ')}` : RATE_PHRASES.join('; '));
  // An old number left behind is the drift this file exists for: any
  // "N requests / P s" that is not one of the real ones.
  const stale = [...text.matchAll(/(\d[\d,]*) requests \/ (\d+) s/g)].map(m => m[0]).filter(p => !RATE_PHRASES.includes(p));
  check(`${file} quotes no other rate limit`, stale.length === 0, stale.join('; '));
  check(`${file} names the client header`, text.includes(api.CLIENT_HEADER), api.CLIENT_HEADER);
  if (file !== DOC) check(`${file} points to ${DOC}`, text.includes('docs/agent-api.md'));
  check(`${file} says it is read-only`, /read-only/i.test(text));
}

// ── The user doc covers the whole API ────────────────────────────────────────

const doc = read(DOC) || '';
const openapi = api.openApiDocument();
for (const p of Object.keys(openapi.paths)) {
  check(`${DOC} documents ${p}`, doc.includes(`GET ${p}\``) || doc.includes(`\`GET ${p}\``), 'as a "GET <path>" heading');
}
for (const t of api.MCP_TOOLS) {
  check(`${DOC} documents the tool ${t.name}`, doc.includes(`\`${t.name}\``));
}
// Each endpoint's query parameters named in its own section — from its
// "### `GET <path>`" heading to the next heading of that rank or higher — so a
// parameter the page mentions only in passing elsewhere still counts as missing.
const sectionOf = p => {
  const start = doc.indexOf(`### \`GET ${p}\``);
  if (start < 0) return '';
  const rest = doc.slice(start + 4);
  const end = rest.search(/^#{2,3} /m);
  return end < 0 ? rest : rest.slice(0, end);
};
const undocumented = Object.entries(openapi.paths).flatMap(([p, item]) =>
  (item.get.parameters || []).filter(x => x.in === 'query' && !sectionOf(p).includes(`\`${x.name}\``)).map(x => `${p} ${x.name}`));
check(`${DOC} names every query parameter the OpenAPI document declares, in its endpoint's own section`,
  undocumented.length === 0, undocumented.join('; '));
// AGENTS.md is canonical; GEMINI.md and llms.txt list the tools too, so a tool
// one of them leaves out is one that agent never learns exists.
for (const file of ['AGENTS.md', 'GEMINI.md', 'llms.txt']) {
  const text = read(file) || '';
  check(`${file} names every MCP tool`, api.MCP_TOOLS.every(t => text.includes(t.name)),
    api.MCP_TOOLS.filter(t => !text.includes(t.name)).map(t => t.name).join(', '));
}
check(`${DOC} states the reading windows the code enforces`,
  doc.includes(`raw ≤ ${api.LIMITS.windowMaxDays.raw} days`) && doc.includes(`hourly ≤ ${api.LIMITS.windowMaxDays.hourly} days`)
  && doc.includes(`daily ≤ ${api.LIMITS.windowMaxDays.daily} days`));
check(`${DOC} states the page and row caps the code enforces`,
  doc.includes(`${api.LIMITS.listMax} rows per page`) && doc.includes(`${api.LIMITS.readingsMax.toLocaleString('en-AU')} readings per call`)
  && doc.includes(`${api.LIMITS.radiusMaxKm} km search radius`));
// Whitespace collapsed, so a re-wrapped paragraph still says what it said.
const docFlat = doc.replace(/\s+/g, ' ');
check(`${DOC} states the latest readings' page, as the code sets it`,
  docFlat.includes(`${api.LIMITS.latestMax.toLocaleString('en-AU')} stations per call of the latest readings (${api.LIMITS.latestDefault} by default)`)
  && docFlat.includes(`${api.LIMITS.latestDefault} stations a page by default and at most ${api.LIMITS.latestMax.toLocaleString('en-AU')}`),
  `${api.LIMITS.latestDefault} / ${api.LIMITS.latestMax}`);
check(`${DOC} names the MCP protocol versions the server speaks`, api.MCP_VERSIONS.filter(v => v !== '2024-11-05').every(v => doc.includes(v)));
check(`${DOC} carries the About page's disclaimer`, doc.includes('Flood-Net is not a flood warning service'));

// ── wrangler.toml declares the bindings the code reads ───────────────────────

const toml = read('wrangler.toml') || '';
const blocks = toml.split(/^\[\[ratelimits\]\]\s*$/m).slice(1).map(b => ({
  name: (/^\s*name\s*=\s*"([^"]+)"/m.exec(b) || [])[1],
  namespace: (/^\s*namespace_id\s*=\s*"([^"]+)"/m.exec(b) || [])[1],
  limit: Number((/^\s*limit\s*=\s*(\d+)/m.exec(b) || [])[1]),
  period: Number((/^\s*period\s*=\s*(\d+)/m.exec(b) || [])[1]),
}));
for (const rule of api.RATE_LIMITS) {
  const b = blocks.find(x => x.name === rule.binding);
  check(`wrangler.toml declares ${rule.binding} as ${rule.limit} / ${rule.period} s`,
    b && b.limit === rule.limit && b.period === rule.period, b ? `${b.limit} / ${b.period}` : 'not declared');
}
check('wrangler.toml declares no rate limit the code does not read',
  blocks.every(b => api.RATE_LIMITS.some(r => r.binding === b.name)), blocks.map(b => b.name).join(', '));
check('each rate limit period is one Cloudflare accepts (10 or 60)', blocks.every(b => b.period === 10 || b.period === 60));
check('each namespace_id is a distinct positive integer',
  blocks.every(b => /^[1-9]\d*$/.test(b.namespace || '')) && new Set(blocks.map(b => b.namespace)).size === blocks.length);

// ── llms.txt has the llmstxt.org shape; the Cursor rule has its frontmatter ──

const llms = read('llms.txt') || '';
const lines = llms.split('\n');
const firstH2 = lines.findIndex(l => l.startsWith('## '));
check('llms.txt opens with an H1', /^# \S/.test(lines[0] || ''), lines[0]);
check('llms.txt has a blockquote summary before its sections', lines.slice(1, firstH2 < 0 ? undefined : firstH2).some(l => l.startsWith('> ')));
check('llms.txt has no other H1 and no H3', lines.slice(1).every(l => !/^#{1}\s/.test(l) && !/^###\s/.test(l)));
const listItems = lines.filter(l => l.startsWith('- '));
check('every llms.txt list item is a link', listItems.length > 0 && listItems.every(l => /^- \[[^\]]+\]\([^)]+\)/.test(l)),
  listItems.filter(l => !/^- \[[^\]]+\]\([^)]+\)/.test(l)).join(' | '));

const mdc = read('.cursor/rules/floodnet-api.mdc') || '';
const fm = /^---\n([\s\S]*?)\n---\n/.exec(mdc);
check('the Cursor rule has frontmatter with a description and alwaysApply',
  fm && /^description: \S/m.test(fm[1]) && /^alwaysApply: (true|false)$/m.test(fm[1]));

// ── Relative links in the docs point at files that exist ─────────────────────

for (const file of [DOC, 'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md']) {
  const text = read(file) || '';
  const dir = path.dirname(repo(file));
  const broken = [...text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)].map(m => m[1])
    .filter(href => !/^[a-z]+:/i.test(href))
    .filter(href => !fs.existsSync(path.resolve(dir, href)));
  check(`${file}: every relative link lands on a file`, broken.length === 0, broken.join(', '));
}

// ── Verdict ──────────────────────────────────────────────────────────────────

console.log('');
const bad = results.filter(r => !r.ok);
if (bad.length) {
  console.log(`FAIL — ${bad.length} of ${results.length} check(s) failed.\n`);
  console.log('  An agent reads only its own instruction file. One that quotes a URL or a');
  console.log('  limit the code no longer has sends every agent that reads it the wrong way.\n');
  process.exit(1);
}
console.log(`PASS — ${results.length} checks: the docs, the five agent files and wrangler.toml all say what worker/api.js does.`);
