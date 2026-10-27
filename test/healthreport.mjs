// Station Health with nobody's browser open (#215): tools/health/report.mjs,
// which .github/workflows/station-health.yml runs every fifteen minutes, works
// the findings out with the browser's own health-analysis.js and reports the
// ones about a present condition to meganet.report_station_findings().
//
// The oracle is the demo week the Station Health tab is held to (health.mjs):
// HealthAnalysis.demoWorld() plants one fault per station among twelve real
// ones. Node only, no browser, no network — the database is stood in for by a
// fetch that serves the register and the readings the way PostgREST pages
// them and records what is reported.
//
//   * the browser's files load outside a page: core.js' and app.js' register
//     helpers lifted out by name, sensor-values.js and health-analysis.js run
//     as the page runs them
//   * what is reported is exactly the analysis' own findings of the reported
//     kinds — same ids, same severities, same words — and nothing else
//   * the planted silent station is reported silent, by its finding id; the
//     stations left alone are not
//   * every report fits what the database takes: a subject, a kind it accepts,
//     a severity, a title, evidence under 8 KB
//   * a run reads the whole week page by page, reports it as complete with
//     what it read, and says so; with a cache, the register and the week once
//     per six hours and only what arrived since in between, the same report;
//     a database without 0059 is told plainly and the run does not fail; no
//     secret key, no report
//   * each station as the tab shows it (0085): a card per station heard,
//     carrying exactly the analysis' findings about it, its schedule's counts
//     day by day and its battery's night lows; a run reports them for the
//     tab's three windows, every batch naming every station heard; a database
//     without 0085 takes the findings and is told plainly about the cards
//
// Run:  npm run healthreport
//       npm run healthreport -- -v    also print what passed

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES, SNAPSHOT, topLevel, loadAnalysis, analyse, toReport, run, cardWindows, CARD_BATCH } from '../tools/health/report.mjs';
import { stationCards, CARD_MAX_BYTES, CARD_VERSION } from '../tools/health/cards.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'stations.json'), 'utf8'));

// ── loading the browser's files ──────────────────────────────────────────────

let threw = null;
try { topLevel('const a = 1;\n', 'stationSensors'); } catch (err) { threw = err.message; }
ok('a declaration that is not there is an error, not a guess', /no top-level stationSensors/.test(threw || ''), threw || 'did not throw');
ok('a declaration is lifted whole, braces in strings and all',
  topLevel("x();\nfunction f(a) {\n  if (a) { return '}'; }\n  return \"{\";\n}\nfunction g() {}\n", 'f')
    === "function f(a) {\n  if (a) { return '}'; }\n  return \"{\";\n}");

// The workflow checks out only what the run reads.
const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'station-health.yml'), 'utf8');
const sparse = (/sparse-checkout: \|\n((?:\s+\/\S+\n)+)/.exec(wf) || [, ''])[1].split('\n').map(l => l.trim()).filter(Boolean);
ok('the workflow checks out every file the run reads, and the run itself',
  FILES.concat(SNAPSHOT).every(f => sparse.includes('/' + f)) && sparse.includes('/tools/health/'), sparse.join(' '));

const api = loadAnalysis();
ok('health-analysis.js and sensor-values.js load outside a page',
  typeof api.HealthAnalysis.run === 'function' && typeof api.SensorValues.resolver === 'function');
// What is reported is the analysis' own list of present conditions, not one kept here.
const KINDS = api.HealthAnalysis.CURRENT_KINDS || [];
ok('the kinds reported are the analysis\' own list, each a kind it knows', KINDS.length >= 5 && KINDS.every(k => api.HealthAnalysis.ACTION[k]), KINDS.join(', '));

// ── the demo week ────────────────────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 60000) * 60000;
api.setRegister(doc);
const world = api.HealthAnalysis.demoWorld(20261006, { now: NOW, stations: doc.stations });
ok('the demo week is built against the real register', world.rows.length > 1000 && world.roles && world.roles.silent,
  `${world.rows.length} rows, roles ${Object.keys(world.roles || {}).join(', ')}`);

const t0 = NOW - 7 * 86400000;
const { A, findings } = analyse(api, world.rows, doc, { now: NOW, t0 });
const expected = A.findings.filter(f => KINDS.includes(f.kind));
ok('what is reported is the analysis\' own findings of the reported kinds, one for one',
  findings.length === new Set(expected.map(f => f.id)).size
    && findings.every(r => { const f = expected.find(x => x.id === r.subject); return f && f.kind === r.kind && f.severity === r.severity && f.title === r.title; }),
  `${findings.length} reported, ${expected.length} found`);
ok('…and only those kinds', findings.every(r => KINDS.includes(r.kind)), findings.map(r => r.kind).join(', '));

const silentId = world.roles.silent;
const silent = findings.find(r => r.subject === 'silent:' + silentId);
ok('the planted silent station is reported silent, by the analysis\' finding id',
  !!silent && silent.kind === 'silent' && silent.station_id === silentId && ['critical', 'warn'].includes(silent.severity),
  silent ? `${silent.severity}: ${silent.title}` : findings.map(r => r.subject).join(', '));
const leftAlone = Object.entries(world.roles).filter(([role]) => /^steady/.test(role)).map(([, id]) => id);
ok('the stations left alone are not', leftAlone.length >= 3 && !findings.some(r => leftAlone.includes(r.station_id)),
  findings.filter(r => leftAlone.includes(r.station_id)).map(r => r.subject).join(', '));
ok('every report fits what the database takes',
  findings.every(r => r.subject && r.subject.length <= 300 && /^[a-z][a-z0-9-]{1,39}$/.test(r.kind)
    && ['critical', 'warn', 'info'].includes(r.severity) && r.title && r.title.length <= 300 && r.detail.length <= 2000
    && r.evidence && typeof r.evidence === 'object' && JSON.stringify(r.evidence).length <= 8192),
  findings.map(r => `${r.subject}:${JSON.stringify(r.evidence).length}`).join(', '));
ok('evidence says what to do and since when, in words and times a person can read',
  !!silent && typeof silent.evidence.action === 'string' && silent.evidence.action.length > 10
    && !isNaN(Date.parse(silent.evidence.since)) && silent.evidence.category === 'comms');

// ── the cards (0085): each station as the tab shows it ───────────────────────

const cards = stationCards(A, { now: NOW });
ok('a card for every station the analysis heard, and none for one it did not',
  cards.length === A.stations.size && cards.every(c => A.stations.has(c.station_id) && c.card.station_id === c.station_id),
  `${cards.length} cards, ${A.stations.size} stations`);
const about = id => A.findings.filter(f => f.stationId === id || f.repeaterId === id
  || (f.evidence && Array.isArray(f.evidence.stations) && f.evidence.stations.some(x => (x && x.id) === id || x === id)));
ok('each card carries exactly the analysis\' findings about its station — the same ids, severities, words and actions',
  cards.every(c => {
    const want = about(c.station_id);
    return c.card.findings.length === want.length && want.every(f => c.card.findings.some(g => g.id === f.id && g.severity === f.severity
      && g.title === f.title && g.detail === f.detail && g.action === (f.action || null)));
  }), cards.map(c => `${c.station_id}:${c.card.findings.length}/${about(c.station_id).length}`).join(' '));
ok('…worst first, with the worst and the counts beside the card',
  cards.every(c => c.findings === c.card.findings.length && c.attention === c.card.findings.filter(f => f.severity !== 'info').length
    && c.worst === (c.card.findings[0] ? c.card.findings[0].severity : null)
    && c.card.findings.every((f, i, l) => !i || ['critical', 'warn', 'info'].indexOf(l[i - 1].severity) <= ['critical', 'warn', 'info'].indexOf(f.severity))));
const sc = cards.find(c => c.station_id === silentId);
const sS = A.stations.get(silentId);
ok('the planted silent station\'s card: silent, its schedule\'s counts day by day adding up to the window\'s',
  !!sc && sc.worst === 'critical' && sc.card.findings[0].kind === 'silent' && sc.card.schedule
    && sc.card.schedule.every_minutes === sS.schedule.P / 60000 && sc.card.schedule.trailing_misses === sS.schedule.trailingMisses
    && ['received', 'incomplete', 'missed', 'missed_network_wide', 'unknown'].every(k =>
      sc.card.schedule.daily.reduce((n, d) => n + d[k], 0) === { received: sS.schedule.counts.hits, incomplete: sS.schedule.counts.partial,
        missed: sS.schedule.counts.misses, missed_network_wide: sS.schedule.counts.net, unknown: sS.schedule.counts.unknown }[k])
    && sc.card.schedule.daily.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    && sc.card.schedule.spells.some(sp => sp.open) && !isNaN(Date.parse(sc.card.schedule.next_due_at)),
  sc ? JSON.stringify(sc.card.schedule).slice(0, 300) : 'no card');
const fc = cards.find(c => c.station_id === world.roles.falling);
const fB = A.stations.get(world.roles.falling).battery;
ok('the planted falling battery\'s card: its night lows night by night and their trend, as the analysis has them',
  !!fc && fc.card.battery && fc.card.battery.night_lows.length === fB.nights.length && fc.card.battery.night_lows.length >= 4
    && fc.card.battery.trend_v_per_day < -0.04 && Math.abs(fc.card.battery.trend_v_per_day - fB.slope) < 0.001
    && fc.card.battery.night_lows.every(p => !isNaN(Date.parse(p.at)) && p.v > 10 && p.v < 15)
    && fc.card.findings.some(f => f.kind === 'battery-falling'),
  fc ? JSON.stringify(fc.card.battery).slice(0, 300) : 'no card');
const grp = cards.find(c => c.card.findings.some(f => f.about === 'group'));
ok('a group\'s finding is on each of its stations\' cards, marked as the group\'s, its times said as times',
  !!grp && grp.card.findings.filter(f => f.about === 'group').every(f => f.evidence.from == null || !isNaN(Date.parse(f.evidence.from))),
  grp ? grp.station_id : 'no group finding on any card');
ok('every card fits what the database takes', cards.every(c => JSON.stringify(c.card).length <= CARD_MAX_BYTES && c.card.v === CARD_VERSION),
  String(Math.max(...cards.map(c => JSON.stringify(c.card).length))));
ok('the windows are the tab\'s, and --cards picks among them',
  JSON.stringify(cardWindows([])) === '[3,7,14]' && JSON.stringify(cardWindows(['--cards', '14,7'])) === '[7,14]'
    && cardWindows(['--cards', 'none']).length === 0 && (() => { try { cardWindows(['--cards', '5']); return false; } catch (_) { return true; } })());

const big = toReport({ id: 'repeater-down:rep:x', kind: 'repeater-down', severity: 'critical', title: 't', detail: 'd',
  evidence: { stations: Array.from({ length: 900 }, (_, i) => 'station_number_' + i), from: 1 } });
ok('a long list in the evidence is cut to fit, with its length kept',
  JSON.stringify(big.evidence).length <= 8000 && big.evidence.stations.length === 20 && big.evidence.stationsTotal === 900 && big.evidence.from === 1);

// ── a run, against a stand-in for the database ───────────────────────────────

function standIn({ missing = false, register = 0, cardsMissing = false } = {}) {
  const seen = { pages: 0, reported: null, keys: new Set(), registerAsked: 0, since: [], cards: [] };
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const h = init.headers || {};
    seen.keys.add(h.apikey);
    if (u.pathname.endsWith('/rpc/stations_doc')) {
      // `register` times out that many times first, as a busy database does.
      if (seen.registerAsked++ < register) return json(500, { code: '57014', message: 'canceling statement due to statement timeout' });
      return json(200, doc);
    }
    if (u.pathname.endsWith('/rpc/report_station_findings')) {
      if (missing) return json(404, { code: 'PGRST202', message: 'Could not find the function meganet.report_station_findings' });
      seen.reported = JSON.parse(init.body).p_report;
      seen.reportKey = h.apikey;
      return json(200, { at: seen.reported.at, open: seen.reported.findings.length,
        opened: seen.reported.findings.map((f, i) => ({ id: i + 1, kind: f.kind, subject: f.subject, severity: f.severity, title: f.title })),
        worse: [], cleared: [] });
    }
    if (u.pathname.endsWith('/rpc/report_station_cards')) {
      if (cardsMissing) return json(404, { code: 'PGRST202', message: 'Could not find the function meganet.report_station_cards' });
      const b = JSON.parse(init.body).p_report;
      seen.cards.push(Object.assign(b, { key: h.apikey }));
      return json(200, { at: b.at, days: b.days, complete: b.complete, upserted: b.cards.length, unchanged: 0, removed: 0 });
    }
    if (u.pathname.endsWith('/reading')) {
      seen.pages++;
      const p = u.searchParams;
      const off = Number(p.get('offset')), lim = Number(p.get('limit'));
      if (p.get('received_at')) {
        // What arrived since: the delta a run with a base asks for.
        seen.since.push(p.get('received_at'));
        const after = Date.parse(p.get('received_at').replace(/^gt\./, ''));
        const rows = world.rows.filter(r => Date.parse(r.received_at) > after && Date.parse(r.reading_ts) < NOW)
          .sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
        return json(200, rows.slice(off, off + lim));
      }
      const [gte, lt] = p.getAll('reading_ts').map(v => Date.parse(v.replace(/^(gte|lt)\./, '')));
      const rows = world.rows.filter(r => { const t = Date.parse(r.reading_ts); return t >= gte && t < lt; })
        .sort((a, b) => Date.parse(a.reading_ts) - Date.parse(b.reading_ts));
      return json(200, rows.slice(off, off + lim));
    }
    return json(404, { message: 'not stood in for: ' + u.pathname });
  };
  return { fetch, seen };
}

const lines = [];
const s1 = standIn();
const realNow = Date.now;
Date.now = () => NOW;     // the run's window is the demo week's
let out;
try {
  out = await run({ fetch: s1.fetch, argv: [], env: { SUPABASE_SECRET_KEY: 'sb_secret_test', GITHUB_SHA: '0123456789abcdef' }, log: l => lines.push(l) });
} finally { Date.now = realNow; }
const rep = s1.seen.reported;
ok('a run reads the whole week page by page and reports it as complete',
  !!rep && rep.complete === true && rep.detail.readings === world.rows.filter(r => Date.parse(r.reading_ts) >= t0 && Date.parse(r.reading_ts) < NOW).length
    && s1.seen.pages >= 14 && rep.at === new Date(NOW).toISOString(),
  rep ? JSON.stringify(rep.detail) : 'nothing reported');
ok('…the same findings as the analysis worked out directly, and the commit it ran',
  !!rep && rep.findings.length === findings.length && rep.findings.some(f => f.subject === 'silent:' + silentId) && rep.detail.commit === '0123456789ab');
ok('…read with the publishable key, reported with the secret one',
  s1.seen.reportKey === 'sb_secret_test' && [...s1.seen.keys].filter(k => k !== 'sb_secret_test').every(k => /^sb_publishable_/.test(k)));
ok('…and says what it reported and what changed', out && out.opened && lines.some(l => /^Reported: \d+ open/.test(l)) && lines.some(l => /opened {3}Silent/.test(l)),
  lines.slice(-4).join(' | '));

ok('…from the register the database gave', !!rep && rep.detail.register === 'database' && s1.seen.registerAsked === 1);

const byDays = d => s1.seen.cards.filter(b => b.days === d);
ok('…and the cards for each of the tab\'s windows, with the secret key, the run\'s time, complete, every batch naming every station heard',
  [3, 7, 14].every(d => byDays(d).length === Math.max(1, Math.ceil(byDays(d)[0].heard.length / CARD_BATCH))
    && byDays(d).every(b => b.at === rep.at && b.complete === true && b.key === 'sb_secret_test' && b.detail.days === d
      && b.heard.length === byDays(d).reduce((n, x) => n + x.cards.length, 0))),
  s1.seen.cards.map(b => `${b.days}d:${b.cards.length}/${b.heard.length}`).join(' '));
const wk = byDays(7).flatMap(b => b.cards);
ok('…the week\'s from the findings\' own analysis, card for card',
  wk.length === cards.length && cards.every(c => { const r = wk.find(x => x.station_id === c.station_id); return r && r.worst === c.worst && r.findings === c.findings; }),
  `${wk.length} reported, ${cards.length} worked out`);
ok('…and says what it reported', lines.some(l => /^Cards reported, 14 days: \d+ stations/.test(l)), lines.filter(l => /^Cards/.test(l)).join(' | '));

const s4 = standIn({ register: 2 });
const lines4 = [];
await run({ fetch: s4.fetch, argv: [], env: { SUPABASE_SECRET_KEY: 'sb_secret_test' }, log: l => lines4.push(l), retryMs: 1 });
ok('a register that times out is asked again', s4.seen.registerAsked === 3 && s4.seen.reported && s4.seen.reported.detail.register === 'database');
const s5 = standIn({ register: 9 });
const lines5 = [];
await run({ fetch: s5.fetch, argv: [], env: { SUPABASE_SECRET_KEY: 'sb_secret_test' }, log: l => lines5.push(l), retryMs: 1 });
ok('…three times, and then the committed snapshot stands in, as the app\'s own load chain does, and the report says so',
  s5.seen.registerAsked === 3 && s5.seen.reported && s5.seen.reported.detail.register === 'snapshot'
    && lines5.some(l => /using the committed stations\.json/.test(l)), lines5[0]);

// A cache directory: the slot's first run reads whole and keeps it; the next
// asks for the register not at all and for the readings only since.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthreport-'));
const runAt = async (fx, argv) => {
  const l = [];
  Date.now = () => NOW;
  try { return { out: await run({ fetch: fx.fetch, argv, env: { SUPABASE_SECRET_KEY: 'sb_secret_test' }, log: x => l.push(x), retryMs: 1 }), lines: l }; }
  finally { Date.now = realNow; }
};
const c1 = standIn();
await runAt(c1, ['--cache', cacheDir]);
const base1 = JSON.parse(fs.readFileSync(path.join(cacheDir, 'base.json'), 'utf8'));
ok('with a cache, the slot\'s first run reads the whole week and keeps it with the register',
  c1.seen.reported.detail.read === 'whole' && c1.seen.registerAsked === 1 && base1.rows.length === c1.seen.reported.detail.readings
    && Array.isArray(base1.doc.stations) && base1.at === NOW, JSON.stringify(c1.seen.reported.detail));
const c2 = standIn();
await runAt(c2, ['--cache', cacheDir]);
ok('…and the next asks for the register not at all, and for the readings only since — reporting the same',
  c2.seen.registerAsked === 0 && c2.seen.pages === 1 && c2.seen.since.length === 1 && c2.seen.reported.detail.read === 'since'
    && c2.seen.reported.detail.register === 'cache' && c2.seen.reported.detail.readings === c1.seen.reported.detail.readings
    && JSON.stringify(c2.seen.reported.findings) === JSON.stringify(c1.seen.reported.findings),
  JSON.stringify({ asked: c2.seen.registerAsked, pages: c2.seen.pages, detail: c2.seen.reported.detail }));
fs.writeFileSync(path.join(cacheDir, 'base.json'), JSON.stringify(Object.assign(base1, { at: NOW - 7 * 3600e3 })));
const c3 = standIn();
await runAt(c3, ['--cache', cacheDir]);
ok('…and a base older than six hours is read afresh', c3.seen.registerAsked === 1 && c3.seen.reported.detail.read === 'whole');
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'healthreport-'));
await runAt(standIn({ register: 9 }), ['--cache', dir2]);
ok('…but never kept from the snapshot, which would stand in for the database for six hours', !fs.existsSync(path.join(dir2, 'base.json')));
fs.rmSync(cacheDir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true });

const s2 = standIn({ missing: true });
const lines2 = [];
const out2 = await run({ fetch: s2.fetch, argv: [], env: { SUPABASE_SECRET_KEY: 'sb_secret_test' }, log: l => lines2.push(l) });
ok('a database without 0059 is told plainly, and the run does not fail', out2.missing === true && lines2.some(l => /apply db\/migrations\/0059/.test(l)));

const s6 = standIn({ cardsMissing: true });
const lines6 = [];
const out6 = await run({ fetch: s6.fetch, argv: [], env: { SUPABASE_SECRET_KEY: 'sb_secret_test' }, log: l => lines6.push(l) });
ok('a database without 0085 takes the findings, is told plainly about the cards, and the run does not fail',
  !!s6.seen.reported && out6.cardsMissing === true && lines6.filter(l => /apply db\/migrations\/0085/.test(l)).length === 1);
const s7 = standIn();
await run({ fetch: s7.fetch, argv: ['--cards', 'none'], env: { SUPABASE_SECRET_KEY: 'sb_secret_test' }, log: () => {} });
ok('--cards none reports the findings and no cards', !!s7.seen.reported && s7.seen.cards.length === 0);

let err3 = null;
try { await run({ fetch: standIn().fetch, argv: [], env: {}, log: () => {} }); } catch (err) { err3 = err.message; }
ok('no secret key, no report — and --dry-run needs none', /SUPABASE_SECRET_KEY is not set/.test(err3 || '')
  && (await run({ fetch: standIn().fetch, argv: ['--dry-run'], env: {}, log: () => {} })).dry === true, err3 || 'did not throw');

if (failures) { console.log(`\n${failures} check${failures === 1 ? '' : 's'} failed`); process.exit(1); }
console.log('healthreport: all checks passed');
