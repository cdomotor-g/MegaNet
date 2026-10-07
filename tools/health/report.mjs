// tools/health/report.mjs — Station Health, worked out with nobody's browser
// open, and kept by the database (#215, 0059).
//
// What it does. Reads the last week of readings and the station register from
// the database, runs health-analysis.js over them — the same file, the same
// function, the Station Health tab runs — and reports the findings that say
// what is wrong *now* to meganet.report_station_findings(), which opens,
// updates and clears them in meganet.health_finding. .github/workflows/
// station-health.yml runs it every fifteen minutes.
//
// Why the browser's file and not a copy of its rules. The rules are two
// thousand lines that learn each station's check schedule, attribute an
// address several stations share by where each receiver listens, and set
// corrupted copies and ghosts aside before judging anything. A SQL port was
// written and measured against them on the live week; it disagreed exactly
// where those subtleties decide, so the rules live in one place and run in
// two (0059's header has the rest).
//
// How it loads them. sensor-values.js and health-analysis.js are classic
// scripts with no exports; they run here in a vm context, as they would on
// the page, with the register in `state.data`. The two register helpers they
// call are core.js' stationSensors() (and its label table) and app.js'
// stationAlertIds(), lifted out of those files at run time by name — neither
// file can be loaded whole outside a page, and copying the helpers here would
// be the drift this exists to avoid.
//
// What it reports. HealthAnalysis.CURRENT_KINDS — the analysis' own list of
// the findings about a present condition: silent, a repeater or an area gone
// quiet together, a receiver that stopped delivering, a battery low, critical
// or not charging — at whatever severity the analysis gave. The rest of what
// the tab shows is history (a spell that came back) or slow diagnosis (a
// marginal path), and stays on the tab.
//
// Run:  SUPABASE_SECRET_KEY=… node tools/health/report.mjs
//       … --dry-run        work it out and print it; report nothing
//       … --days 14        a longer window (7 by default, as the tab's)
//       … --cache DIR      keep the register and the week in DIR between runs
//                          (the workflow's actions/cache; see "the database")
//
// Env:  SUPABASE_SECRET_KEY   the project's secret key — reporting only
//       SUPABASE_URL          the project (default: core.js DB_ORIGIN)
//       TZ, LANG              the words' clock times and dates, as a person
//                             there would read them — the workflow sets
//                             Australia/Brisbane and en_AU

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const read = f => {
  if (!FILES.includes(f)) throw new Error(`${f} is not in FILES — add it there and to the workflow's checkout`);
  return fs.readFileSync(path.join(REPO, f), 'utf8');
};

// Every file of the repository this reads. The workflow checks out these and
// tools/health/ only — a 357 MB tree, 96 times a day, otherwise — and
// test/healthreport.mjs holds its list to this one.
export const FILES = ['core.js', 'app.js', 'sensor-values.js', 'health-analysis.js'];
// …and the register's snapshot, read only when the database cannot give it.
export const SNAPSHOT = 'stations.json';


const DAY = 86400000, HOUR = 3600000, MIN = 60000;
// Station Health's own paging (health.js): twelve-hour chunks, a thousand rows
// a page — PostgREST's ceiling on this project — four chunks at a time.
const CHUNK_MS = 12 * HOUR, PAGE = 1000, PARALLEL = 4, MAX_ROWS = 250000;
const SELECT = 'addr,alert_id,a2_station,a2_sensor,station_number,channel,station_id,'
             + 'reading_ts,received_at,value_raw,value,unit,protocol,source,path,'
             + 'dup_count,dup_paths,freq_mhz,rssi_dbm,level_dbfs,snr_db';

// ── the browser's files, in Node ─────────────────────────────────────────────

// One top-level declaration out of a script, by name: `function name(` or
// `const name =` at the start of a line, to the end of its outermost braces.
// Enough for the plain declarations it is asked for; it throws rather than
// guess when one is not there.
export function topLevel(src, name) {
  const m = new RegExp(`^(?:function ${name}\\s*\\(|const ${name}\\s*=)`, 'm').exec(src);
  if (!m) throw new Error(`no top-level ${name} found`);
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      let end = i + 1;
      if (src[end] === ';') end++;
      return src.slice(m.index, end);
    }
  }
  throw new Error(`${name} does not close`);
}

// sensor-values.js and health-analysis.js in a context of their own, as the
// page loads them. Returns { HealthAnalysis, SensorValues, setRegister(doc) }.
export function loadAnalysis() {
  const ctx = vm.createContext({ console, state: { data: null } });
  vm.runInContext([
    topLevel(read('core.js'), 'BF_TYPE_LABEL'),
    topLevel(read('core.js'), 'stationSensors'),
    topLevel(read('app.js'), 'stationAlertIds'),
  ].join('\n'), ctx, { filename: 'register-helpers.js' });
  for (const f of ['sensor-values.js', 'health-analysis.js']) vm.runInContext(read(f), ctx, { filename: f });
  vm.runInContext('globalThis.__loaded = { SensorValues, HealthAnalysis };', ctx);
  const { SensorValues, HealthAnalysis } = ctx.__loaded;
  return {
    SensorValues, HealthAnalysis,
    // The register the analysis resolves addresses against, as the page holds
    // it — a new object each time, which is what tells SensorValues to re-index.
    setRegister(doc) { ctx.state = { data: doc }; },
  };
}

// ── what is reported ─────────────────────────────────────────────────────────

const EVIDENCE_MAX = 8000;   // the database takes 8 KB; leave room

// A finding as meganet.report_station_findings() takes it. Its id is the
// analysis' own (silent:<station>, repeater-down:rep:<id> …), so the same
// condition on the next run is the same row.
export function toReport(f) {
  const evidence = Object.assign({}, f.evidence || {}, {
    category: f.category || null,
    action: f.action || null,
    since: f.since != null && isFinite(f.since) ? new Date(f.since).toISOString() : null,
    station: f.station || null,
    cause: f.cause || null,
  });
  // A long list (the stations behind a repeater) is cut to fit, never the rest.
  for (const k of Object.keys(evidence)) {
    if (JSON.stringify(evidence).length <= EVIDENCE_MAX) break;
    if (Array.isArray(evidence[k]) && evidence[k].length > 20) {
      evidence[k + 'Total'] = evidence[k].length;
      evidence[k] = evidence[k].slice(0, 20);
    }
  }
  if (JSON.stringify(evidence).length > EVIDENCE_MAX) {
    for (const k of Object.keys(f.evidence || {})) delete evidence[k];
    evidence.truncated = true;
  }
  return {
    subject: String(f.id).slice(0, 300),
    kind: f.kind,
    severity: f.severity,
    title: String(f.title || f.kind).slice(0, 300),
    detail: String(f.detail || '').slice(0, 2000),
    station_id: f.stationId || null,
    evidence,
  };
}

// The analysis over `rows` (meganet.reading's shape) against the register
// `doc`, as of `now`, over the window from `t0`: the whole result, and the
// findings to report.
export function analyse(api, rows, doc, { now, t0 }) {
  api.setRegister(doc);
  const A = api.HealthAnalysis.run(rows, { t0, t1: now, now, stations: doc.stations || [] });
  const kinds = api.HealthAnalysis.CURRENT_KINDS;
  const findings = A.findings.filter(f => kinds.includes(f.kind)).map(toReport);
  // One row per subject, the worse if the analysis ever said one twice.
  const rank = { critical: 0, warn: 1, info: 2 };
  const one = new Map();
  findings.forEach(f => { const o = one.get(f.subject); if (!o || rank[f.severity] < rank[o.severity]) one.set(f.subject, f); });
  return { A, findings: [...one.values()] };
}

// ── the database ─────────────────────────────────────────────────────────────
//
// What a run costs the project's egress, which the free plan meters. The
// register is 2.3 MB (870 KB compressed) and a week of readings 1.1 MB
// compressed: read whole every fifteen minutes, that is near 6 GB a month,
// more than the plan allows for everything. So a run given a cache directory
// (the workflow's actions/cache, one entry per six-hour slot) reads the
// register and the whole week only when the slot is new, keeps them there, and
// in between asks only for the readings received since — a few hundred rows.
// Rows already held do not change under it except by a duplicate's count or a
// later resolution of its station, both of which the next full read picks up.

export const BASE_MS = 6 * HOUR;          // the register and the whole week, at least this often
const OVERLAP_MS = 15 * MIN;              // a delta reaches back this far past the newest held

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function writeJson(file, v) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); }
const rowKey = r => `${r.addr}|${r.reading_ts}|${r.value_raw}`;
const newestReceived = rows => rows.reduce((m, r) => { const t = Date.parse(r.received_at); return t > m ? t : m; }, -Infinity);

export function project() {
  const core = read('core.js');
  const pick = name => { const m = new RegExp(`^const ${name}\\s*=\\s*'([^']+)'`, 'm').exec(core); return m ? m[1] : null; };
  return { url: (process.env.SUPABASE_URL || pick('DB_ORIGIN') || '').replace(/\/+$/, ''), publishable: pick('DB_ANON_KEY') };
}

async function answer(res, what) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  if (!res.ok) {
    const msg = (body && (body.message || body.error)) || text || `HTTP ${res.status}`;
    const err = new Error(`${what}: ${String(msg).slice(0, 300)}${body && body.hint ? ` — ${body.hint}` : ''}`);
    err.status = res.status; err.code = body && body.code;
    throw err;
  }
  return body;
}

// The register as the app loads it (meganet.stations_doc()), and every reading
// in [t0, t1) the way Station Health pages them. Both are public: read with
// the publishable key, as the page reads them.
//
// The register is a 2.3 MB document that the database now and then takes
// longer to build than a publishable-key request is given (57014). Asked three
// times, then — as the app's own load chain does — the snapshot committed in
// the repository, which the weekly stations-snapshot workflow keeps, and the
// report says which it was.
export async function fetchRegister(fetch, { url, key, retryMs = 2000, log = () => {}, base = null }) {
  if (base && base.doc) return { doc: base.doc, from: 'cache' };
  const head = { apikey: key, 'Accept-Profile': 'meganet', 'Content-Profile': 'meganet', 'Content-Type': 'application/json' };
  let last = null;
  for (let i = 0; i < 3; i++) {
    try {
      return { doc: await answer(await fetch(`${url}/rest/v1/rpc/stations_doc`, { method: 'POST', headers: head, body: '{}' }), 'the station register'), from: 'database' };
    } catch (err) {
      last = err;
      if (err.status && err.status < 500 && err.code !== '57014') break;
      if (i < 2) await new Promise(r => setTimeout(r, retryMs * (i + 1)));
    }
  }
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, SNAPSHOT), 'utf8'));
    log(`The register could not be read from the database (${last.message}) — using the committed ${SNAPSHOT}.`);
    return { doc, from: 'snapshot' };
  } catch (_) {
    throw last;
  }
}

// The readings received after `since`, paged in the order they arrived.
async function fetchSince(fetch, { url, head, since }) {
  const rows = [];
  const iso = encodeURIComponent(new Date(since).toISOString());
  for (let off = 0; ; off += PAGE) {
    const page = await answer(await fetch(`${url}/rest/v1/reading?select=${SELECT}&received_at=gt.${iso}`
      + `&order=received_at.asc,addr.asc,reading_ts.asc,value_raw.asc&limit=${PAGE}&offset=${off}`, { headers: head }), 'the readings since the last run');
    rows.push(...page);
    if (page.length < PAGE || rows.length >= MAX_ROWS) break;
  }
  return rows;
}

// `cache`: a directory to keep the slot's base in (see above), or none.
export async function fetchInputs(fetch, { url, key, t0, t1, retryMs, log = () => {}, cache = null, now = t1 }) {
  const head = { apikey: key, 'Accept-Profile': 'meganet', 'Content-Profile': 'meganet', 'Content-Type': 'application/json' };
  const file = cache ? path.join(cache, 'base.json') : null;
  const held = file ? readJson(file) : null;
  const base = held && Number.isFinite(held.at) && now - held.at < BASE_MS && held.doc && Array.isArray(held.rows) ? held : null;
  const { doc, from } = await fetchRegister(fetch, { url, key, retryMs, log, base });

  if (base) {
    // The base, and what has arrived since: newer copies of a row win.
    const since = (Number.isFinite(base.newest) ? Math.min(base.newest, now) : base.at) - OVERLAP_MS;
    const fresh = await fetchSince(fetch, { url, head, since });
    const byKey = new Map(base.rows.map(r => [rowKey(r), r]));
    fresh.forEach(r => byKey.set(rowKey(r), r));
    const rows = [...byKey.values()].filter(r => { const t = Date.parse(r.reading_ts); return t >= t0 && t < t1; })
      .sort((a, b) => Date.parse(a.reading_ts) - Date.parse(b.reading_ts));
    const capped = rows.length >= MAX_ROWS;
    log(`${rows.length.toLocaleString()} readings (${fresh.length.toLocaleString()} since the base of ${new Date(base.at).toISOString()}), `
      + `${(doc.stations || []).length.toLocaleString()} stations (kept)${capped ? ' — capped' : ''}`);
    return { doc, register: from, rows: capped ? rows.slice(-MAX_ROWS) : rows, capped, read: 'since' };
  }

  const chunks = [];
  for (let a = t0; a < t1; a += CHUNK_MS) chunks.push([a, Math.min(t1, a + CHUNK_MS)]);
  const rows = [];
  let next = 0, capped = false;
  const iso = t => encodeURIComponent(new Date(t).toISOString());
  const worker = async () => {
    while (next < chunks.length && !capped) {
      const [a, b] = chunks[next++];
      for (let off = 0; ; off += PAGE) {
        const page = await answer(await fetch(`${url}/rest/v1/reading?select=${SELECT}&reading_ts=gte.${iso(a)}&reading_ts=lt.${iso(b)}`
          + `&order=reading_ts.asc,addr.asc,value_raw.asc&limit=${PAGE}&offset=${off}`, { headers: head }), 'the readings');
        rows.push(...page);
        if (rows.length >= MAX_ROWS) { capped = true; return; }
        if (page.length < PAGE) break;
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  log(`${rows.length.toLocaleString()} readings, ${(doc.stations || []).length.toLocaleString()} stations${from === 'snapshot' ? ' (snapshot)' : ''}${capped ? ' — capped' : ''}`);
  // A new base for the slot — but never one made of the snapshot or of a
  // capped read, which would stand in for the real thing for six hours.
  if (file && from === 'database' && !capped) writeJson(file, { at: now, newest: newestReceived(rows), doc, rows });
  return { doc, register: from, rows, capped, read: 'whole' };
}

export async function report(fetch, { url, secret, body }) {
  const res = await fetch(`${url}/rest/v1/rpc/report_station_findings`, {
    method: 'POST',
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Profile': 'meganet', 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_report: body }),
  });
  return answer(res, 'report_station_findings');
}

// ── the run ──────────────────────────────────────────────────────────────────

export async function run({ fetch = globalThis.fetch, argv = process.argv.slice(2), env = process.env, log = console.log, retryMs } = {}) {
  const dry = argv.includes('--dry-run');
  const di = argv.indexOf('--days');
  const days = di >= 0 ? Math.max(1, Math.min(14, Number(argv[di + 1]) || 7)) : 7;
  const { url, publishable } = project();
  const secret = env.SUPABASE_SECRET_KEY;
  if (!url || !publishable) throw new Error('core.js no longer says where the database is (DB_ORIGIN, DB_ANON_KEY)');
  if (!dry && !secret) throw new Error('SUPABASE_SECRET_KEY is not set — nothing can be reported (--dry-run works without it)');

  const started = Date.now();
  const now = started, t0 = now - days * DAY;
  const ci = argv.indexOf('--cache');
  const cache = ci >= 0 && argv[ci + 1] ? argv[ci + 1] : null;
  const { doc, register, rows, capped, read } = await fetchInputs(fetch, { url, key: publishable, t0, t1: now, retryMs, log, cache, now });
  const api = loadAnalysis();
  const { A, findings } = analyse(api, rows, doc, { now, t0 });
  const took = Date.now() - started;
  const counts = findings.reduce((o, f) => (o[f.severity] = (o[f.severity] || 0) + 1, o), {});
  log(`${A.counts.stationsHeard} stations heard; reporting ${findings.length} findings `
    + `(${counts.critical || 0} critical, ${counts.warn || 0} warnings, ${counts.info || 0} notes) in ${took} ms`);
  for (const f of findings) log(`  ${f.severity.padEnd(8)} ${f.title}${f.station_id ? ` [${f.station_id}]` : ''}`);
  if (dry) return { dry: true, findings };

  const body = {
    at: new Date(now).toISOString(),
    // A capped read is not the whole week: open and update, but clear nothing.
    complete: !capped,
    detail: {
      t0: new Date(t0).toISOString(), t1: new Date(now).toISOString(), days,
      readings: rows.length, register, read, stations_heard: A.counts.stationsHeard, took_ms: took,
      commit: (env.GITHUB_SHA || '').slice(0, 12) || null,
    },
    findings,
  };
  let out;
  try {
    out = await report(fetch, { url, secret, body });
  } catch (err) {
    // A database without 0059 yet: say so plainly rather than fail every run.
    if (err.status === 404 || err.code === 'PGRST202') {
      log('The database does not have meganet.report_station_findings() yet — apply db/migrations/0059_health_findings.sql. Nothing reported.');
      return { missing: true, findings };
    }
    throw err;
  }
  if (out && out.stale) { log(`A newer report is already in (${out.last}); this one was not used.`); return out; }
  log(`Reported: ${out.open} open — ${out.opened.length} opened, ${out.worse.length} worse, ${out.cleared.length} cleared.`);
  for (const f of out.opened) log(`  opened   ${f.title}`);
  for (const f of out.worse) log(`  worse    ${f.title} (was ${f.was})`);
  for (const f of out.cleared) log(`  cleared  ${f.title}`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(err => { console.error(err.message || err); process.exit(1); });
}
