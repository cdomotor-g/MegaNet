// The Backbone tab, "State of the backbone" (backbone.js), driven in Chromium
// with the datastore stood in for by routes — health_finding, transmitter_summary,
// flip_summary, flip_sources, reading_daily, station_health and recent_flips() —
// answering from a month planted on the real station file's repeaters:
//
//   R1  off air sixteen hours (a schedule kept and stopped), corrupting 40% of
//       what it relays — sixty copies as strong as the clean one, at all hours,
//       some clean upstream — with no daily charge: the Hillcrest case;
//   R2  corrupting 4.4%, the copies keeping evening hours;
//   R3  "silent" but heard three times a week with no schedule: seldom heard,
//       a note, never off air;
//   R4  its carrier 2.8 ppm off the fleet on three days, and 17 ppm out on one
//       day — that day set aside; and its signal 4.2 dB weaker in a week (0083);
//   R5, R6  off air six minutes apart: stopped together;
//   R7  three evening dropouts, each back by morning.
//
//   1. **The reads** — the findings asked for in id chunks of the repeaters, the
//      network's kinds and who is quiet now, each for the period (found before
//      its end, cleared after its start or not yet); the carriers, the week's
//      corrupted copies, the pass-range shares, the own reports and last heard;
//      recent_flips() for the repeaters any evidence points at, for the period.
//   2. **The ranking** — R1 first and critical; inside it the corrupted relays,
//      then off air, its power last; R3 only in the notes; R4's odd day said
//      and left out; R5 and R6 each naming the other; R7's nights.
//   3. **The summary** — a row a repeater with its two key issues and a score
//      bar; the tiles; a name taking focus to its section; the map's markers,
//      and a repeater picked showing the stations behind it.
//   4. **The period** — Last 7 days pressed, read again for seven days and
//      remembered on this device.
//   5. **Pass ranges against the air** — Signal Routes' analysis folded in:
//      a repeater relaying an address no range of its holds.
//   6. **The exports** — floodnet-named CSV and text.
//   7. **No database** — the error, Try again, and the demo.
//   8. **A phone** — nothing wider than 375 px.
//
// Run:  npm run backbone

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const DAY = 864e5, HOUR = 36e5;
let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];
const until = async (page, fn, arg, timeout = 20_000) => page.waitForFunction(fn, arg, { timeout });

// ── The stand-in datastore ──────────────────────────────────────────────────

let FIX = null;
let MODE = 'ok';          // 'ok' | 'down' (health_finding answers 500)
const asked = [];
const SERVED = new Set(['health_finding', 'transmitter_summary', 'flip_summary', 'flip_sources', 'reading_daily', 'station_health']);
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// in.("a","b") → ['a', 'b']
function inList(v) {
  const m = /^in\.\((.*)\)$/.exec(v || '');
  if (!m) return null;
  return m[1].match(/"((?:[^"\\]|\\.)*)"|[^,]+/g).map(s => s.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1'));
}
function page_(rows, sp) {
  const off = Number(sp.get('offset') || 0), lim = Number(sp.get('limit') || 1000);
  return rows.slice(off, off + lim);
}

async function standIn(page) {
  await page.route('**/rest/v1/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const rel = u.pathname.replace(/^.*\/rest\/v1\//, '');
    if (rel === 'rpc/recent_flips') {
      const body = JSON.parse(req.postData() || '{}');
      asked.push({ rel, url: req.url(), body });
      const rows = (FIX.flips[String(body.p_tx || '').slice(3)] || []).filter(r => Date.parse(r.heard_at) > Date.now() - body.p_days * DAY);
      return json(route, rows);
    }
    if (!SERVED.has(rel)) return route.fallback();
    asked.push({ rel, url: decodeURIComponent(req.url()) });
    const sp = u.searchParams;
    if (rel === 'health_finding') {
      if (MODE === 'down') return json(route, { code: 'XX000', message: 'the database is having a bad day' }, 500);
      if (sp.get('kind') === 'eq.silent' && sp.get('cleared_at') === 'is.null') return json(route, page_(FIX.openSilent, sp));
      const lte = Date.parse(String(sp.get('first_seen') || '').replace(/^lte\./, ''));
      const gte = Date.parse((/cleared_at\.gte\.([^,)]+)/.exec(sp.get('or') || '') || [])[1]);
      const inPeriod = f => (!Number.isFinite(lte) || Date.parse(f.first_seen) <= lte) && (!f.cleared_at || !Number.isFinite(gte) || Date.parse(f.cleared_at) >= gte);
      const ids = inList(sp.get('station_id'));
      const kinds = inList(sp.get('kind'));
      const rows = ids ? FIX.own.filter(f => ids.includes(f.station_id) && inPeriod(f))
        : kinds ? FIX.network.filter(f => kinds.includes(f.kind) && inPeriod(f)) : [];
      return json(route, page_(rows, sp));
    }
    if (rel === 'transmitter_summary') return json(route, FIX.tsum);
    if (rel === 'flip_summary') return json(route, FIX.fsum);
    if (rel === 'flip_sources') return json(route, []);
    if (rel === 'reading_daily') {
      const ids = inList(sp.get('station_id')) || [];
      return json(route, page_(FIX.daily.filter(r => ids.includes(r.station_id)), sp));
    }
    if (rel === 'station_health') {
      const ids = inList(sp.get('station_id')) || [];
      return json(route, FIX.health.filter(r => ids.includes(r.station_id)));
    }
    return route.fallback();
  });
}

// The month, planted on seven real repeaters — those with the most field
// stations behind them, so the ranking's weights are the real ones.
function fixture(reps, now) {
  const [R1, R2, R3, R4, R5, R6, R7] = reps;
  // Brisbane keeps no daylight saving: its clock is UTC + 10 all year.
  const brisbane = (t, h, m) => { const d = new Date(t); d.setUTCHours((h + 14) % 24, m, 0, 0); return d.getTime(); };
  const A1 = R1.addrs.length ? R1.addrs : [4000];
  const iso = t => new Date(t).toISOString();
  let id = 1;
  const F = o => Object.assign({ id: id++, source: 'stations', subject: `${o.kind}:${o.station_id || ''}`, station_id: null, severity: 'warn',
    title: 'x', detail: '', evidence: {}, first_seen: iso(now - DAY), last_seen: iso(now - HOUR), cleared_at: null }, o);
  const own = [], network = [], openSilent = [], daily = [], health = [], fsum = [], tsum = [];
  const flips = {};
  const silent = (R, o) => own.push(F({ kind: 'silent', station_id: R.id, subject: 'silent:' + R.id, ...o }));
  // R1: off air, corrupting, no charge.
  const off1 = now - 16 * HOUR;
  silent(R1, { severity: 'critical', title: 'Silent — missed its last 5 checks', evidence: { lastHeard: off1, periodMin: 180, trailingMisses: 5 }, first_seen: iso(off1 + 9 * HOUR) });
  own.push(F({ source: 'transmitters', kind: 'transmitter-corrupting', station_id: R1.id, subject: 'st:' + R1.id, severity: 'critical',
    title: `${R1.name}: 60 corrupted copies in a week (40.0% of what it sent)`, evidence: { rate: 0.4 }, first_seen: iso(now - 10 * DAY) }));
  own.push(F({ kind: 'battery-no-charge', station_id: R1.id, subject: 'battery-no-charge:' + R1.id, severity: 'info',
    title: 'No daily charge — battery flat-lining at 13.1 V', detail: 'A solar station\'s battery rises through the day; this one moved 0.1 V between night and day over 6 nights.',
    evidence: { medianV: 13.1 }, first_seen: iso(now - 6 * DAY) }));
  fsum.push({ tx: 'st:' + R1.id, station_id: R1.id, bursts: 150, flips: 60, rate: 0.4, clear: 58, clear_rate: 0.39, clean_upstream: 5, addr_flips: 20, addresses: 12, top: [], fleet_rate: 0.0004 });
  flips[R1.id] = Array.from({ length: 60 }, (_, k) => ({
    heard_at: iso(now - (2 + (k % 6)) * DAY - (k % 24) * HOUR), true_addr: A1[k % A1.length], true_value: 100 + k, bad_addr: k % 3 ? A1[k % A1.length] : A1[k % A1.length] ^ 16,
    bad_value: 100 + k + (k % 3 ? 64 : 0), bits: 1, addr_flip: k % 3 === 0, gap_s: 2.5, rule: 'fit', bad_snr: k < 2 ? 5 : 20, good_snr: 21,
    bad_tx: 'st:' + R1.id, bad_how: 'carrier', good_tx: k % 12 === 0 ? 'st:somewhere_else' : 'st:' + R1.id, good_measured: true }));
  R1.members.slice(0, 4).forEach(s => openSilent.push({ station_id: s, severity: 'warn', first_seen: iso(now - DAY) }));
  network.push(F({ kind: 'area-silence', subject: 'area-silence:area:' + R1.id, title: `5 stations around ${R1.name} went quiet together`,
    evidence: { stations: [R1.id, ...R1.members.slice(0, 4)], from: off1 - HOUR, to: off1 } }));
  for (let d = 0; d < 30; d++) if (now - d * DAY > off1) daily.push({ station_id: R1.id, bucket: iso(now - d * DAY).slice(0, 10), n: 8 });
  health.push({ station_id: R1.id, last_seen_at: iso(off1), last_reading_at: iso(off1) });
  // R2: corrupting, keeping evening hours.
  own.push(F({ source: 'transmitters', kind: 'transmitter-corrupting', station_id: R2.id, subject: 'st:' + R2.id, severity: 'warn',
    title: `${R2.name}: 20 corrupted copies in a week (4.4% of what it sent)`, evidence: { rate: 0.044 }, first_seen: iso(now - 5 * DAY) }));
  fsum.push({ tx: 'st:' + R2.id, station_id: R2.id, bursts: 450, flips: 20, rate: 0.044, clear: 20, clear_rate: 0.044, clean_upstream: 0, addr_flips: 4, addresses: 6, top: [], fleet_rate: 0.0004 });
  flips[R2.id] = Array.from({ length: 20 }, (_, k) => {
    const t = brisbane(now - (1 + (k % 5)) * DAY, 19 + (k % 4), 15);
    return { heard_at: iso(Math.min(t, now - HOUR)), true_addr: 5000 + k, true_value: 10, bad_addr: 5000 + k, bad_value: 26, bits: 1, addr_flip: false, gap_s: 2,
      rule: 'fit', bad_snr: 18, good_snr: 19, bad_tx: 'st:' + R2.id, bad_how: 'carrier', good_tx: 'st:' + R2.id, good_measured: true };
  });
  // R3: heard three times, no schedule — seldom heard.
  silent(R3, { severity: 'warn', title: 'Quiet for 4.0 days', evidence: { lastHeard: now - 4 * DAY, reports: 3 }, first_seen: iso(now - 3 * DAY) });
  // R4: off the fleet, with one wild day.
  tsum.push({ tx: 'st:' + R4.id, via: 'repeater', freq_mhz: 151.525, w_days: 4, w_ppm: 2.4, bursts: 900, receivers: 1,
    days: [4, 3, 2, 1].map(k => iso(now - k * DAY).slice(0, 10)), ppm: [-2.9, -2.8, 17.0, -2.7], judged_at: iso(now - HOUR) });
  own.push(F({ source: 'transmitters', kind: 'transmitter-snr-falling', station_id: R4.id, subject: 'st:' + R4.id, severity: 'warn',
    title: `${R4.name}: SNR down 4.2 dB in a week`, detail: 'Heard on its own carrier by 1 base station, at about 11.0 dB over the receiver\'s noise over the last 7 days.',
    evidence: { drop_db: 4.2, window: 'week', action: 'Check its antenna, the cable and connectors.' }, first_seen: iso(now - 2 * DAY) }));
  // R5 and R6: off air six minutes apart.
  silent(R5, { severity: 'critical', title: 'Silent — missed its last 9 checks', evidence: { lastHeard: now - 9 * HOUR, periodMin: 60, trailingMisses: 9 }, first_seen: iso(now - 6 * HOUR) });
  silent(R6, { severity: 'critical', title: 'Silent — missed its last 9 checks', evidence: { lastHeard: now - 9 * HOUR + 6 * 60e3, periodMin: 60, trailingMisses: 9 }, first_seen: iso(now - 6 * HOUR) });
  // R7: three evenings, back each morning.
  [9, 6, 3].forEach(dAgo => {
    const t = brisbane(now - dAgo * DAY, 19, 30);
    silent(R7, { severity: 'warn', title: 'Silent — missed its last 3 checks', evidence: { lastHeard: t, periodMin: 180, trailingMisses: 3 },
      first_seen: iso(t + 9 * HOUR), cleared_at: iso(t + 13 * HOUR) });
  });
  // A finding from before the period, which no period asks for.
  silent(R7, { severity: 'warn', title: 'Silent — long ago', evidence: { lastHeard: now - 80 * DAY, periodMin: 180 },
    first_seen: iso(now - 79 * DAY), cleared_at: iso(now - 78 * DAY) });
  return { own, network, openSilent, daily, health, fsum, tsum, flips };
}

async function open(context) {
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await standIn(page);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await until(page, () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, LOAD_TIMEOUT);
  return page;
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Australia/Brisbane', acceptDownloads: true });
  const page = await open(context);
  const reps = await page.evaluate(() => Backbone.register().reps
    .filter(r => r.st.lat != null && r.members.length >= 3)
    .sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id))
    .slice(0, 7).map(r => ({ id: r.id, name: r.st.name, members: r.members.map(s => s.id),
      // Addresses of the stations behind it — never its own, which a clean copy upstream cannot be.
      addrs: [...new Set(r.members.flatMap(s => stationAlertIds(s)))].filter(a => !stationAlertIds(r.st).includes(a)).slice(0, 7) })));
  ok('the register has seven repeaters with stations behind them to plant on', reps.length === 7, JSON.stringify(reps.map(r => r.id)));
  const [R1, R2, R3, R4, R5, R6, R7] = reps;
  const NOW = Date.now();
  FIX = fixture(reps, NOW);

  // ── 1. the reads ──────────────────────────────────────────────────────────
  await page.evaluate(() => switchTab('backbone'));
  await until(page, () => Backbone.state().phase === 'ready' && !!document.querySelector('.bk-summary'));
  const hf = asked.filter(a => a.rel === 'health_finding');
  const nRep = await page.evaluate(() => Backbone.register().reps.length);
  const byIds = hf.filter(a => /station_id=in\./.test(a.url));
  ok(`the repeaters' findings asked for in chunks of 50 ids (${Math.ceil(nRep / 50)})`, byIds.length === Math.ceil(nRep / 50), String(byIds.length));
  const from30 = Date.parse((/cleared_at\.gte\.([^,)]+)/.exec(byIds[0] ? byIds[0].url : '') || [])[1]);
  ok('…for the period: found before now, cleared within the last 30 days or not yet',
    byIds.every(a => /first_seen=lte\./.test(a.url) && /or=\(cleared_at\.is\.null,cleared_at\.gte\./.test(a.url)) && Math.abs(from30 - (NOW - 30 * DAY)) < 5 * 60e3,
    byIds[0] && byIds[0].url.slice(0, 260));
  ok('the network\'s kinds read the same way', hf.some(a => /kind=in\.\(repeater-down,area-silence,shared-spell\)/.test(a.url) && /cleared_at\.gte\./.test(a.url)));
  ok('…and who is quiet now', hf.some(a => /kind=eq\.silent/.test(a.url) && /cleared_at=is\.null/.test(a.url)));
  for (const rel of ['transmitter_summary', 'flip_summary', 'flip_sources', 'reading_daily', 'station_health']) {
    ok(`${rel} read`, asked.some(a => a.rel === rel));
  }
  const rpc = asked.filter(a => a.rel === 'rpc/recent_flips');
  ok('recent_flips() asked for the repeaters the evidence points at, for the 30 days',
    rpc.some(a => a.body.p_tx === 'st:' + R1.id && a.body.p_days === 30) && rpc.some(a => a.body.p_tx === 'st:' + R2.id) && rpc.every(a => a.body.p_addr === null),
    JSON.stringify(rpc.map(a => a.body)));

  // ── 2. the ranking ────────────────────────────────────────────────────────
  const A = await page.evaluate(() => {
    const A = Backbone.state().A;
    return { rows: A.rows.map(r => ({ id: r.id, rank: r.rank, level: r.level, resolved: r.resolved, score: r.score,
      issues: r.issues.map(i => ({ kind: i.kind, sev: i.sev, title: i.title, facts: i.facts, score: i.score })), points: r.points })), counts: A.counts };
  });
  const row = id => A.rows.find(r => r.id === id) || null;
  const r1 = row(R1.id);
  ok('the repeater off air and corrupting with no charge ranks first, critical', A.rows[0] && A.rows[0].id === R1.id && A.rows[0].level === 'critical',
    JSON.stringify(A.rows.slice(0, 3).map(r => [r.id, r.level, Math.round(r.score)])));
  ok('…its issues worst first: corrupted relays, then off air, its power last',
    r1 && r1.issues[0].kind === 'corrupt' && r1.issues[1].kind === 'offair' && r1.issues[r1.issues.length - 1].kind === 'power',
    JSON.stringify(r1 && r1.issues.map(i => [i.kind, Math.round(i.score)])));
  const c1 = r1 && r1.issues[0];
  ok('the corrupted relays: the rate, as strong as the clean copy, clean upstream, at all hours',
    c1 && /40% of what it relays arrives corrupted/.test(c1.title) && c1.facts.some(f => /^58 arrived as strong as the clean copy/.test(f))
      && c1.facts.some(f => /^5 also reached us clean by another way/.test(f)) && c1.facts.some(f => /at all hours/.test(f)),
    JSON.stringify(c1));
  const o1 = r1 && r1.issues[1];
  ok('off air: when it stopped, its schedule, the stations behind it quiet now, and the area with it',
    o1 && o1.sev === 'critical' && /^Off air — not heard since/.test(o1.title) && o1.facts.some(f => /reports every 3\.0 h and has missed its last 5/.test(f))
      && o1.facts.some(f => new RegExp(`^4 of the ${R1.members.length} field stations`).test(f)) && o1.facts.some(f => /near it went quiet at about the same time/.test(f)),
    JSON.stringify(o1));
  ok('what it points to: power first, and a failing radio fits as well',
    r1 && /^Power first: its battery showed no daily charge \(13\.1 V\)/.test(r1.points[0] || '') && /A failing radio fits as well/.test(r1.points[1] || ''),
    JSON.stringify(r1 && r1.points));
  const r2 = row(R2.id);
  ok('the corrupting repeater whose copies keep evening hours: a warning, said so',
    r2 && r2.level === 'warn' && r2.issues[0].kind === 'corrupt' && r2.issues[0].facts.some(f => /between 19:00 and 01:00 — interference keeps hours/.test(f))
      && r2.points.some(p => /keep hours/.test(p)), JSON.stringify(r2));
  const r3 = row(R3.id);
  ok('heard three times with no schedule is seldom heard — a note, never off air',
    r3 && r3.level === 'info' && r3.issues.length === 1 && r3.issues[0].kind === 'seldom' && /^Seldom heard/.test(r3.issues[0].title), JSON.stringify(r3));
  const r4 = row(R4.id);
  const car = r4 && r4.issues.find(i => i.kind === 'carrier');
  ok('a carrier off the fleet, its one wild day said and set aside',
    car && car.sev === 'warn' && /^Carrier −2\.8 ppm off the fleet/.test(car.title) && car.facts.some(f => /\(\+17\.0\) is far from every other day, and is left out/.test(f)),
    JSON.stringify(car));
  const sg = r4 && r4.issues.find(i => i.kind === 'signal');
  ok('its signal fading (0083): an issue of its own, its drop said, and what it points to',
    sg && sg.sev === 'warn' && sg.title === 'SNR down 4.2 dB in a week'
      && sg.facts.some(f => /the stations behind it have lost that margin too/.test(f))
      && r4.points.some(p => /Its own signal is weaker at the base stations that hear it/.test(p)), JSON.stringify({ sg, points: r4 && r4.points }));
  const r5 = row(R5.id), r6 = row(R6.id);
  ok('two repeaters off air six minutes apart each name the other',
    r5 && r6 && r5.points[0] === `It stopped together with ${R6.name}: look first for what they share.`
      && r6.points[0] === `It stopped together with ${R5.name}: look first for what they share.`
      && r5.issues[0].facts.some(f => /fits better than 2 separate faults/.test(f)), JSON.stringify([r5 && r5.points, r6 && r6.points]));
  const r7 = row(R7.id);
  const dr = r7 && r7.issues.find(i => i.kind === 'dropouts');
  ok('three evening dropouts: a warning, its nights said, and the one before the period not counted',
    dr && dr.sev === 'warn' && /^Dropped out 3 times/.test(dr.title) && dr.facts.some(f => /solar site that cannot carry the night/.test(f)) && !dr.facts.some(f => /long ago/.test(f)),
    JSON.stringify(dr));
  ok('no repeater with nothing planted is listed', A.rows.every(r => reps.some(x => x.id === r.id)), JSON.stringify(A.rows.map(r => r.id)));

  // ── 3. the summary ────────────────────────────────────────────────────────
  const sum = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.bk-summary tbody tr')].map(tr => ({
      name: tr.querySelector('th button').textContent.trim(), keys: tr.querySelectorAll('.bk-ki').length,
      bar: !!tr.querySelector('.bk-bar[role=img]') && /^Score \d+/.test(tr.querySelector('.bk-bar').getAttribute('aria-label') || '') })),
    tiles: [...document.querySelectorAll('.bk-tile')].map(t => t.textContent.replace(/\s+/g, ' ').trim()),
    notes: (document.querySelector('.bk-minor') || {}).textContent || '',
    sections: [...document.querySelectorAll('section.bk-sec h3')].map(h => h.textContent.trim()),
    timelines: document.querySelectorAll('section.bk-sec svg.bk-timeline[role=img][aria-label]').length,
    status: (document.getElementById('bk-status') || {}).textContent || '',
    pressed: [...document.querySelectorAll('.bk-controls [aria-pressed=true]')].map(b => b.textContent.trim()),
  }));
  ok('the summary: a row a repeater with a warning or worse, two key issues each and a score bar',
    sum.rows.length === 6 && sum.rows[0].name === R1.name && sum.rows.every(r => r.keys >= 1 && r.keys <= 2 && r.bar) && !sum.rows.some(r => r.name === R3.name),
    JSON.stringify(sum.rows));
  ok('…the seldom-heard one in the notes', new RegExp(R3.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(sum.notes), sum.notes.slice(0, 200));
  ok('the tiles: listed, critical now, off air now', /^6 of the \d+ repeaters with a warning or worse/.test(sum.tiles[0] || '') && /^3 critical now/.test(sum.tiles[1] || '')
    && /^3 off air now/.test(sum.tiles[2] || ''), JSON.stringify(sum.tiles));
  ok('a section a repeater, numbered as ranked, each with its timeline', sum.sections.length === 6 && sum.sections[0] === `1. ${R1.name}` && sum.timelines === 6,
    JSON.stringify(sum.sections));
  ok('it says when it was read and that it reads itself again', /Read at .*reads itself again every 15 minutes/.test(sum.status), sum.status);
  ok('Last 30 days is the one pressed', sum.pressed.length === 1 && sum.pressed[0] === 'Last 30 days', JSON.stringify(sum.pressed));

  await page.locator('.bk-summary tbody tr').nth(1).locator('th button').click();
  await page.waitForTimeout(200);
  const focus = await page.evaluate(() => document.activeElement && document.activeElement.id);
  const second = A.rows.filter(r => r.level !== 'info')[1];
  ok('a name in the summary takes focus to its section', focus === `bk-h-${second.id}`, String(focus));

  const markers = await page.evaluate(() => document.querySelectorAll('#bk-map path.leaflet-interactive').length);
  ok('the map draws the repeaters with a warning or worse', markers === 6, String(markers));
  await page.evaluate(id => Backbone.showOnMap(id), R1.id);
  await page.waitForTimeout(200);
  const picked = await page.evaluate(() => ({ lines: document.querySelectorAll('#bk-map path.leaflet-interactive').length, sel: document.querySelector('.bk-summary tr.is-selected th button').textContent.trim() }));
  ok('a repeater picked shows the stations behind it on the map', picked.lines > 6 + 4 && picked.sel === R1.name, JSON.stringify(picked));

  // ── 4. the exports ────────────────────────────────────────────────────────
  for (const [fn, name, head] of [['exportCsv', 'floodnet-backbone-30d.csv', 'rank,repeater,station_id,score,state'],
    ['exportText', 'floodnet-backbone-summary-30d.txt', 'State of the backbone — the last 30 days']]) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(f => Backbone[f](), fn)]);
    const body = await (await dl.createReadStream()).toArray().then(b => Buffer.concat(b).toString());
    ok(`${fn} downloads ${name}`, dl.suggestedFilename() === name && body.startsWith(head) && body.includes(R1.name),
      `${dl.suggestedFilename()} ${body.slice(0, 160)}`);
  }

  // ── 5. pass ranges against the air ────────────────────────────────────────
  const addr = await page.evaluate(id => {
    const R = Backbone.register().byId.get(id);
    const covered = new Set(R.members.flatMap(s => stationAlertIds(s)));
    return stationAlertIds(state.data.stations.find(s => s.roles.includes('field') && stationAlertIds(s).length && !stationAlertIds(s).some(a => covered.has(a)))) [0];
  }, R2.id);
  await page.evaluate(([rid, a]) => {
    const now = Date.now();
    const rep = { rid, days: 3, centre: 120, spread: 15, offrec: [{ a, evidence: 'copies', dup: 3, own: 1 }], elsewhere: new Map([[1, {}], [2, {}], [3, {}]]) };
    window.__srState = SignalRoutes.state;
    SignalRoutes.state = () => ({ phase: 'ready', A: { demo: false, days: 7, from: now - 7 * 864e5, to: now, reps: [rep], repById: new Map([[rid, rep]]) } });
    Backbone.authChanged();
  }, [R2.id, addr]);
  const air = await page.evaluate(id => {
    const r = Backbone.state().A.rows.find(x => x.id === id);
    const i = r && r.issues.find(x => x.kind === 'ranges');
    return { issue: i ? { sev: i.sev, title: i.title, facts: i.facts } : null, line: (document.querySelector('.bk-air') || {}).textContent || '' };
  }, R2.id);
  ok('Signal Routes\' analysis folded in: an address relayed off its record, and those heard another way',
    air.issue && air.issue.sev === 'warn' && air.issue.title === 'Relays 1 address its pass ranges do not include'
      && air.issue.facts.some(f => new RegExp(`^On its carrier, with copies, though no pass range on record includes it: ${addr}`).test(f))
      && air.issue.facts.some(f => /^3 addresses in its ranges reached us only another way/.test(f)), JSON.stringify(air.issue));
  ok('…and the line under the summary says where it came from', /from Signal Routes' 7 days of receptions/.test(air.line.replace(/\s+/g, ' ')), air.line);
  await page.evaluate(() => { SignalRoutes.state = window.__srState; Backbone.authChanged(); });

  // ── 6. the period ─────────────────────────────────────────────────────────
  const before = asked.length;
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await until(page, () => Backbone.state().phase === 'ready' && Backbone.state().A.days === 7);
  const again = asked.slice(before);
  const from7 = Date.parse((/cleared_at\.gte\.([^,)]+)/.exec((again.find(a => /station_id=in\./.test(a.url)) || {}).url || '') || [])[1]);
  ok('Last 7 days reads it all again for seven days', Math.abs(from7 - (Date.now() - 7 * DAY)) < 5 * 60e3
    && again.some(a => a.rel === 'rpc/recent_flips' && a.body.p_days === 7), String(new Date(from7)));
  const seven = await page.evaluate(() => ({ pressed: [...document.querySelectorAll('.bk-controls [aria-pressed=true]')].map(b => b.textContent.trim()),
    kept: localStorage.getItem('mn-backbone-days'), r7: Backbone.state().A.rows.find(r => r.issues.some(i => i.kind === 'dropouts' && /^Dropped out 3 times/.test(i.title))) }));
  ok('…pressed, and remembered on this device', seven.pressed[0] === 'Last 7 days' && seven.kept === '7', JSON.stringify(seven.pressed) + seven.kept);
  ok('…and the three dropouts of the last nine days are not all in the last seven', !seven.r7);

  // ── 8. a phone ────────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  ok('nothing wider than a 375 px phone', wide <= 376, String(wide));
  await context.close();

  // ── 7. no database ────────────────────────────────────────────────────────
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  MODE = 'down';
  const p2 = await open(c2);
  await p2.evaluate(() => switchTab('backbone'));
  await until(p2, () => Backbone.state().phase === 'error');
  ok('a database that fails says so, with Try again and a demo', await p2.evaluate(() => !!document.querySelector('#main-content [role=alert]')
    && ['Try again', 'Show a demo'].every(t => [...document.querySelectorAll('#main-content button')].some(b => b.textContent.trim() === t))));
  MODE = 'ok';
  await p2.getByRole('button', { name: 'Try again' }).click();
  await until(p2, () => !!document.querySelector('.bk-summary'));
  ok('…and Try again, answered, draws it', true);
  await p2.evaluate(() => Backbone.demo());
  const demo = await p2.evaluate(() => ({ status: (document.getElementById('bk-status') || {}).textContent || '', rows: Backbone.state().A.rows.length,
    sections: document.querySelectorAll('section.bk-sec').length }));
  ok('the demo: made-up findings on the real station file, said so, a summary and sections', /A demo:/.test(demo.status) && demo.rows >= 4 && demo.sections >= 4,
    JSON.stringify(demo));
  await c2.close();

  ok('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`  FAIL ${e.stack || e}`);
}
await browser.close();
await server.close();
if (failures) { console.log(`\nFAIL — ${failures} check(s) failed.`); process.exit(1); }
console.log('\nPASS — the Backbone tab.');
