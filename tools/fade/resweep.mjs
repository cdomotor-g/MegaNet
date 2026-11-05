// tools/fade/resweep.mjs — the fade-margin map's sweep-and-save, with nobody
// at the map.
//
// What it is for. A fade margin is saved with a signature of everything it was
// worked out from — both ends' positions, ground heights, antenna heights and
// radios, the frequency, the model (map-fade.js, sigFor). Move a station's pin
// to where it really stands, correct a ground height, change a radio system,
// and every saved figure on that station's links stops matching: the map leaves
// those links grey and the agent API's radio paths call them stale, until an
// editor turns the layer on, lets it sweep and presses Save. This does that
// every night instead (.github/workflows/fade-resweep.yml).
//
// How. It serves this checkout on a loopback port, opens the app in headless
// Chromium exactly as a visitor would — the station list and the saved margins
// from the database with the publishable key, the terrain from the same tiles —
// and calls MapFade.resweep(), the layer's own sweep: every saved row whose
// signature no longer holds, and every link the map draws within its Max TX
// distance that nobody has saved, worked out by the same computeOne the map and
// the link budget card use. The rows come back to Node and go to
// meganet.save_link_fade() with the project's secret key, which never enters
// the page. A fresh browser has the app's defaults — the field model, the 30 m
// ground, the card's reliability — so the rows are saved under the settings
// the agent API calls fresh.
//
// Run:  SUPABASE_SECRET_KEY=… node tools/fade/resweep.mjs
//       … --dry-run      work them out and say what would be saved; save nothing
//       … --limit N      work out at most N links (the stale ones first)
//       … --km N         links up to N km apart (default 150, the agent API's
//                        reach for a station's repeaters)
//       … --json FILE    also write the report as JSON
//
// Env:  SUPABASE_SECRET_KEY   the project's secret key — saving only
//       SUPABASE_URL          the project (default: core.js DB_ORIGIN)
//       GITHUB_STEP_SUMMARY   where the workflow wants its summary (optional)
//
// Needs test/'s packages (cd test && npm ci): the server and the browser are
// the checks' own (test/lib/server.mjs, test/lib/browser.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../test/lib/server.mjs';
import { launchBrowser } from '../../test/lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// Rows per save_link_fade call — the app's own CHUNK, for its reason: a whole
// network in one request is one some proxy will refuse for its size alone.
export const CHUNK = 400;
// How far apart two ends may be for their link to be worked out: the agent
// API's reach for a station's repeaters (worker/api.js LIMITS.relayKmMax),
// which is past the map's 100 km Max TX distance, so every hop the API reads
// is current. Further than this is mostly #236's pairs that share an address
// by accident, hundreds of kilometres apart.
export const RELAY_KM = 150;
const LOAD_TIMEOUT = 180_000;     // the station list is most of a megabyte
const SWEEP_TIMEOUT = 75 * 60_000; // a whole network from cold is minutes, not an hour

export function parseArgs(argv) {
  const out = { dryRun: false, limit: 0, km: RELAY_KM, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--limit takes a whole number above 0, not "${argv[i]}"`);
      out.limit = n;
    } else if (a === '--km') {
      const n = Number(argv[++i]);
      if (!isFinite(n) || n <= 0 || n > 600) throw new Error(`--km takes a distance in kilometres, above 0 and at most 600, not "${argv[i]}"`);
      out.km = n;
    } else if (a === '--json') {
      out.json = argv[++i];
      if (!out.json) throw new Error('--json takes a file name');
    } else throw new Error(`unknown argument "${a}" — --dry-run, --limit N, --km N, --json FILE`);
  }
  return out;
}

// The project the app itself talks to, read from core.js so the two cannot
// point at different databases.
export function dbOrigin() {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL.replace(/\/+$/, '');
  const core = fs.readFileSync(path.join(REPO, 'core.js'), 'utf8');
  const m = /const DB_ORIGIN\s*=\s*'([^']+)'/.exec(core);
  if (!m) throw new Error('core.js has no DB_ORIGIN');
  return m[1];
}

export function chunks(rows, size = CHUNK) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function answer(res, what) {
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.message || j.error || text; } catch (_) {}
    throw new Error(`${what}: HTTP ${res.status} ${String(msg).slice(0, 300)}`);
  }
  try { return JSON.parse(text); } catch (_) { return text; }
}

export async function save(fetchFn, { url, secret, rows, good, ok }) {
  let written = 0, sent = 0;
  for (const chunk of chunks(rows)) {
    const res = await fetchFn(`${url}/rest/v1/rpc/save_link_fade`, {
      method: 'POST',
      headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Profile': 'meganet', 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_rows: chunk, p_good_db: good, p_ok_db: ok }),
    });
    const got = await answer(res, 'save_link_fade');
    written += Number(got && got.written) || 0;
    sent += chunk.length;
  }
  return { written, sent };
}

const WHY_WORDS = {
  moved: 'a station moved',
  ground: 'a ground height changed',
  antenna: 'an antenna height changed',
  radio: 'a radio changed',
  frequency: 'the frequency changed',
  model: 'the model moved on',
  settings: 'the propagation settings changed',
};

const plural = (n, one, many) => `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`;

// The report, in words, for the workflow's summary page and the log.
export function summary(r, { dryRun = false, saved = null } = {}) {
  const c = r.counts;
  const out = [];
  out.push(`## 📶 Fade margins — the nightly re-sweep${dryRun ? ' (trial run, nothing saved)' : ''}`);
  out.push('');
  out.push(`${plural(c.links, 'link', 'links')} in the network · ${c.fresh.toLocaleString('en-AU')} saved and still current · `
    + `**${plural(c.stale, 'gone stale', 'gone stale')}** · ${plural(c.unsaved, 'never saved', 'never saved')} within ${r.maxKm} km`);
  out.push('');
  if (!c.stale && !c.unsaved) {
    out.push(`Nothing to do: every link up to ${r.maxKm} km has a current figure.`);
  } else {
    out.push(`- Worked out: **${c.computed.toLocaleString('en-AU')}**`
      + (c.failed ? ` · could not be worked out: ${c.failed.toLocaleString('en-AU')} (terrain unreachable, or the model refused the path)` : '')
      + (c.left ? ` · left for the next run: ${c.left.toLocaleString('en-AU')}` : ''));
    if (saved) out.push(`- Saved to the database: **${saved.written.toLocaleString('en-AU')}** of ${saved.sent.toLocaleString('en-AU')}`);
    else if (dryRun) out.push(`- Would save: ${r.rows.length.toLocaleString('en-AU')} (trial run)`);
    const why = Object.entries(r.why).sort((a, b) => b[1] - a[1]);
    if (why.length) out.push(`- Why they had gone stale: ${why.map(([k, n]) => `${WHY_WORDS[k] || k} (${n})`).join(' · ')}`);
  }
  if (c.staleBeyond) out.push(`- ${plural(c.staleBeyond, 'stale figure is', 'stale figures are')} on links longer than ${r.maxKm} km — left alone: the map does not draw them, and most are stations far apart that share an address by accident`);
  if (c.noRadio) out.push(`- ${plural(c.noRadio, 'link has', 'links have')} no radio system on file at one end — no margin to give`);
  if (r.moved.length) {
    out.push('');
    out.push('### Stations that moved since their links were last worked out');
    out.push('');
    out.push('| Station | Moved | Its stale links |');
    out.push('|---|---:|---:|');
    for (const m of r.moved.slice(0, 40)) {
      const far = m.metres == null ? '—' : m.metres >= 1000 ? `${(m.metres / 1000).toFixed(1)} km` : `${m.metres} m`;
      out.push(`| ${String(m.name).replace(/\|/g, '/')} | ${far} | ${m.links} |`);
    }
    if (r.moved.length > 40) out.push(`| …and ${r.moved.length - 40} more | | |`);
  }
  if (r.failed.length) {
    out.push('');
    out.push(`<details><summary>The ${plural(c.failed, 'link', 'links')} that could not be worked out</summary>`);
    out.push('');
    for (const f of r.failed) out.push(`- ${f.names}${f.stale ? ' (stale)' : ''}`);
    if (c.failed > r.failed.length) out.push(`- …and ${c.failed - r.failed.length} more`);
    out.push('');
    out.push('</details>');
  }
  out.push('');
  out.push(`Model ${r.model}; banded at ${r.good} dB (green) and ${r.ok} dB (yellow), the thresholds the network was last saved under.`);
  return out.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const secret = process.env.SUPABASE_SECRET_KEY || '';
  if (!args.dryRun && !secret) throw new Error('SUPABASE_SECRET_KEY is not set — nothing can be saved (use --dry-run to work them out only)');
  const url = dbOrigin();
  const t0 = Date.now();
  const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s] ${msg}`);

  const server = await startServer(REPO);
  const browser = await launchBrowser();
  let report;
  try {
    // The app's defaults: no look or rail pinned, nothing in storage.
    const context = await browser.newContext({ look: null, rail: null, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.exposeFunction('fadeResweepProgress', (done, total) => {
      if (done === total || done % 100 === 0) log(`${done.toLocaleString('en-AU')} of ${total.toLocaleString('en-AU')} worked out`);
    });
    await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(
      () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations)
         && !!state.dataSource && !state.dataSource.slow,
      null, { timeout: LOAD_TIMEOUT });
    // Only the database's own list will do: a margin saved against the bundled
    // stations.json would carry that file's positions in its signature, and
    // would be stale the moment it landed.
    const src = await page.evaluate(() => ({ kind: state.dataSource.kind, n: state.data.stations.length }));
    if (src.kind !== 'api') throw new Error(`the station list came from ${src.kind}, not the database — nothing worked out`);
    log(`${src.n.toLocaleString('en-AU')} stations from the database`);

    page.setDefaultTimeout(SWEEP_TIMEOUT);
    report = await page.evaluate(
      ({ limit, km }) => MapFade.resweep({ limit, maxKm: km, onProgress: (d, t) => window.fadeResweepProgress(d, t) }),
      { limit: args.limit, km: args.km });
    const c = report.counts;
    log(`${c.links} links · ${c.fresh} current · ${c.stale} stale · ${c.unsaved} never saved · `
      + `${c.computed} worked out · ${c.failed} failed${c.left ? ` · ${c.left} left` : ''}`);
    if (errors.length) log(`the page reported ${errors.length} error(s); the first: ${errors[0].slice(0, 300)}`);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }

  let saved = null;
  if (!args.dryRun && report.rows.length) {
    saved = await save(fetch, { url, secret, rows: report.rows, good: report.good, ok: report.ok });
    log(`saved ${saved.written} of ${saved.sent}`);
  }

  const text = summary(report, { dryRun: args.dryRun, saved });
  console.log(`\n${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  if (args.json) {
    const { rows, ...rest } = report;
    fs.writeFileSync(args.json, JSON.stringify({ ...rest, rows: rows.length, saved }, null, 2));
  }
  // Saved fewer than sent: a pair the database's station list does not have
  // (save_link_fade refuses those quietly). Said, not failed — the rest landed.
  if (saved && saved.written < saved.sent) console.log(`::warning::${saved.sent - saved.written} rows were not taken — their stations are not both in the database`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`::error::${(err && err.message) || err}`);
    process.exit(1);
  });
}
