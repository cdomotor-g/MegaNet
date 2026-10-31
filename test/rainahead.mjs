// 🌧 Rain ahead — Station Health's card of where one weather model has rain in
// the next few days and which stations there have a fault open to fix first
// (health-rain-ahead.js), and the Worker route that asks the model for it
// (worker/rain-ahead.js, /api/rain-ahead).
//
// Three parts:
//
//   * The route, in Node, with Open-Meteo and the edge cache stood in for: the
//     squares snapped, sorted and told once, nothing outside Australia, at most
//     fifty a request; the upstream address naming only the model, the one
//     variable and those numbers (and the key, on the customer API, only when
//     the secret is set); Open-Meteo's answer reshaped for one place and for
//     several; one upstream request for the same squares asked twice, in any
//     order and precision, inside three hours; the last answer served marked
//     stale while Open-Meteo will not answer, and an error past two days; the
//     source and the "not a forecast or a warning" sentence in every answer;
//     and worker/index.js sending the path here.
//   * The card's rules, in Node: the bands at their edges (10 and 30 mm in a
//     day, 20 and 60 across three), the week judged from today in the
//     station's own time zone (an answer a day old starts a day in), both ends
//     snapping a coordinate to the same square, and who comes first — rain
//     before later, sooner before later, critical before warning — with notes,
//     data quality and register findings never counting as a fault.
//   * The card in Chromium, on the demo week's readings analysed as a live
//     week, with the route stood in for: the requests sorted and at most fifty
//     squares each; the card's sentence and its Get to these first, one row per
//     station with a fault open; the 🌧 chip beside each fault in Needs
//     attention and nowhere else; the station panel's line and week; the map's
//     halos; the Calm look's sentence; the credit and the Bureau's links; then
//     the route failing, said on the card with nothing else hurt; and the
//     Demo week's made-up rain, with no request at all.
//
// Run:  npm run rainahead          (add -v for every check)

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import {
  handleRainAhead, isRainAheadPath, parseCells, upstreamUrl, reshape, cellKey,
  CELLS_MAX, FRESH_S, KEEP_S, MODEL, DAYS, UPSTREAM, UPSTREAM_KEYED, SOURCE,
} from '../worker/rain-ahead.js';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${String(detail).slice(0, 600)}` : ''}`);
};

const DAY = 86400000;
const brisbaneDay = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const weekFrom = (t, n = 7) => Array.from({ length: n }, (_, k) => brisbaneDay(t + k * DAY));

// ── 1. the route ─────────────────────────────────────────────────────────────

{
  const p = parseCells('-27.61,153.02; -27.62,153.04;-28.3,152.9');
  ok('route: squares snapped to a quarter degree, told once, sorted south to north',
    !p.error && JSON.stringify(p.cells) === JSON.stringify([[-28.25, 153], [-27.5, 153]]), JSON.stringify(p));
  ok('route: nothing outside Australia', /outside Australia/.test(parseCells('51.5,-0.12').error || ''));
  ok('route: a malformed square is refused, not guessed at', /not a square/.test(parseCells('-27,153;hello').error || ''));
  const many = Array.from({ length: CELLS_MAX + 1 }, (_, i) => `${-20 - i * 0.25},140`).join(';');
  ok(`route: at most ${CELLS_MAX} squares a request`, /at most 50/.test(parseCells(many).error || ''));
  ok('route: an empty list is refused', !!parseCells('').error && !!parseCells(';;').error);
  ok('route: both ends print a square alike', cellKey(-27.61, 153.02) === '-27.50,153.00' && cellKey(-10.6, 142.2) === '-10.50,142.25');

  const u = new URL(upstreamUrl([[-28.25, 153], [-27.5, 153]], ''));
  ok('route: the upstream address names Open-Meteo, the one model, the one variable and the squares — nothing else',
    u.origin + u.pathname === UPSTREAM && u.searchParams.get('models') === MODEL && u.searchParams.get('daily') === 'precipitation_sum'
      && u.searchParams.get('latitude') === '-28.25,-27.50' && u.searchParams.get('longitude') === '153.00,153.00'
      && u.searchParams.get('forecast_days') === String(DAYS) && !u.searchParams.has('apikey')
      && [...u.searchParams.keys()].sort().join() === 'daily,forecast_days,latitude,longitude,models,timezone', u.toString());
  const k = new URL(upstreamUrl([[-27.5, 153]], 'k3y'));
  ok('route: with a key, the customer API and the key', k.origin + k.pathname === UPSTREAM_KEYED && k.searchParams.get('apikey') === 'k3y');

  const one = { timezone: 'Australia/Brisbane', daily: { time: ['2026-11-01', '2026-11-02'], precipitation_sum: [1.234, null] } };
  const r1 = reshape(one, [[-27.5, 153]]);
  ok('route: one place answered as an object, reshaped; a missing day stays missing',
    r1.length === 1 && r1[0].tz === 'Australia/Brisbane' && r1[0].mm[0] === 1.2 && r1[0].mm[1] === null, JSON.stringify(r1));
  const r2 = reshape([one, Object.assign({}, one, { timezone: 'Australia/Perth' })], [[-27.5, 153], [-31.75, 116]]);
  ok('route: several answered as a list, in the order asked', r2.length === 2 && r2[1].tz === 'Australia/Perth' && r2[1].at[1] === 116);
  let threw = '';
  try { reshape({ error: true, reason: 'Daily API request limit exceeded.' }, [[-27.5, 153]]); } catch (e) { threw = e.message; }
  ok('route: Open-Meteo\'s own error said, not swallowed', /limit exceeded/.test(threw), threw);
  threw = '';
  try { reshape([one], [[-27.5, 153], [-28, 153]]); } catch (e) { threw = e.message; }
  ok('route: an answer for the wrong number of places refused', /1 places, not 2/.test(threw), threw);

  // The cache and Open-Meteo, stood in for.
  const store = new Map();
  const cache = {
    async match(req) { const e = store.get(req.url); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
    async put(req, res) { store.set(req.url, { body: await res.text(), headers: Object.fromEntries(res.headers) }); },
  };
  let clock = Date.UTC(2026, 10, 1, 0, 0);
  const calls = [];
  let upstream = 'ok';
  const fetchStub = async (url) => {
    calls.push(url);
    if (upstream === 'down') throw new Error('connection refused');
    if (upstream === '429') return new Response(JSON.stringify({ error: true, reason: 'Hourly API request limit exceeded.' }), { status: 429 });
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    const place = i => ({ timezone: 'Australia/Brisbane', daily: { time: weekFrom(clock), precipitation_sum: [i, 31, 2, 0, 0, 0, 0] } });
    return new Response(JSON.stringify(n === 1 ? place(0) : Array.from({ length: n }, (_, i) => place(i))), { status: 200 });
  };
  const deps = { fetch: fetchStub, cache, now: () => clock };
  const ctx = { waitUntil: p => p };
  const get = async (q, method = 'GET') => {
    const res = await handleRainAhead(new Request(`https://floodwarning.net/api/rain-ahead${q}`, { method }), {}, ctx, deps);
    await new Promise(r => setTimeout(r, 0));
    return res;
  };

  const info = await get('');
  const ib = await info.json();
  ok('route: asked about nothing, it says what it is — the model, the source, the limits',
    info.status === 200 && ib.model === MODEL && ib.cells_max === CELLS_MAX && ib.fresh_s === FRESH_S && /not a forecast or a warning/i.test(ib.source.not), JSON.stringify(ib));
  ok('route: …and asks Open-Meteo nothing', calls.length === 0);
  ok('route: a bad list is a 400', (await get('?cells=0,0')).status === 400);

  const a = await get('?cells=-27.61,153.02;-28.3,152.9');
  const ab = await a.json();
  ok('route: the first ask goes to Open-Meteo once, and answers each square with its week',
    a.status === 200 && calls.length === 1 && ab.cells.length === 2 && ab.cells[0].mm[1] === 31 && ab.cells[0].days.length === 7 && ab.stale === null, JSON.stringify(ab).slice(0, 300));
  ok('route: every answer carries the source and says it is not a forecast or a warning',
    ab.source && /ECMWF/.test(ab.source.credit) && /Open-Meteo/.test(ab.source.credit) && /CC BY 4\.0/.test(ab.source.credit)
      && /not a forecast or a warning from the Bureau of Meteorology/i.test(ab.source.not));
  ok('route: CORS open, and the browser told how long the answer stays fresh',
    a.headers.get('access-control-allow-origin') === '*' && /max-age=10800/.test(a.headers.get('cache-control') || ''), a.headers.get('cache-control'));
  clock += 60 * 60 * 1000;
  const b = await get('?cells=-28.25,153;-27.5,153.0');
  ok('route: the same squares in another order and precision, an hour later: the edge cache, not Open-Meteo',
    b.status === 200 && calls.length === 1 && /max-age=7200/.test(b.headers.get('cache-control') || ''), `${calls.length} ${b.headers.get('cache-control')}`);
  clock += FRESH_S * 1000;
  upstream = 'down';
  const c = await get('?cells=-28.25,153;-27.5,153');
  const cb = await c.json();
  ok('route: past three hours with Open-Meteo unreachable, the last answer, marked stale and not kept by the browser',
    c.status === 200 && calls.length === 2 && /could not be reached/.test(cb.stale || '') && c.headers.get('cache-control') === 'no-store', JSON.stringify({ s: cb.stale, cc: c.headers.get('cache-control') }));
  upstream = '429';
  const c2 = await get('?cells=-28.25,153;-27.5,153');
  ok('route: …and Open-Meteo\'s refusal said in the stale reason', /HTTP 429: Hourly API request limit/.test((await c2.json()).stale || ''));
  clock += KEEP_S * 1000;
  const d = await get('?cells=-28.25,153;-27.5,153');
  ok('route: past two days with nothing new, an error, not a week-old week', d.status === 502 && /429/.test((await d.json()).error || ''));
  upstream = 'ok';
  const e = await get('?cells=-28.25,153;-27.5,153');
  ok('route: and when Open-Meteo answers again, a fresh answer', e.status === 200 && (await e.json()).stale === null);
  ok('route: every upstream request went to Open-Meteo and nowhere else', calls.every(u => u.startsWith(UPSTREAM + '?')), calls.join(' '));
  ok('route: OPTIONS and POST', (await get('', 'OPTIONS')).status === 204 && (await get('', 'POST')).status === 405);
  ok('route: its path, and not its neighbours\'', isRainAheadPath('/api/rain-ahead') && !isRainAheadPath('/api/rain-aheadx') && !isRainAheadPath('/api/rain'));

  const via = await worker.fetch(new Request('https://floodwarning.net/api/rain-ahead'), {}, ctx);
  ok('route: worker/index.js sends /api/rain-ahead here', via.status === 200 && (await via.json()).model === MODEL, String(via.status));
  void SOURCE;
}

// ── 2. the card's rules, in Node ─────────────────────────────────────────────

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function loadCard(A, owners = []) {
  const ctx = {
    console, Intl, Date, Math, Number, String, Object, Array, Map, Set, JSON, Promise, Error, isFinite, setTimeout,
    esc, escAttr: esc, termHtml: (t, m) => `<span class="term" title="${esc(m)}">${esc(t)}</span>`,
    state: { data: { stations: [], catchments: [{ id: 'logan', name: 'Logan-Albert' }] } },
    Health: { state: () => ({ A, owners }), owns: () => true },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'health-rain-ahead.js'), 'utf8') + '\n;this.HealthRainAhead = HealthRainAhead;', ctx);
  return ctx.HealthRainAhead;
}
{
  const HR = loadCard(null);
  const b = HR._bandOf;
  ok('bands: 9.9 mm in a day and little else is not shown', b([9.9, 0, 0]) === null && b([6, 6, 7.9]) === null);
  ok('bands: 10 mm in a day, or 20 across the three, is Wet', b([10, 0, 0]) === 'wet' && b([7, 7, 6]) === 'wet' && b([29.9, 0, 0]) === 'wet');
  ok('bands: 30 mm in a day, or 60 across the three, is Very wet', b([30, 0, 0]) === 'very' && b([20, 20, 20]) === 'very');
  ok('bands: a day with no figure counts as none, not as rain', b([null, 9, null]) === null);

  const now = Date.UTC(2026, 10, 1, 2, 0);   // midday on 1 November in Brisbane
  const days = weekFrom(now);
  const j = HR._judge({ tz: 'Australia/Brisbane', days, mm: [0, 34, 3, 0, 12, 1, 0] }, now);
  ok('judge: the wettest of the next three days, and when',
    j.near.band === 'very' && j.near.max === 34 && j.near.maxAt === 1 && j.near.first === 1 && j.later.band === 'wet', JSON.stringify(j.near));
  const aged = HR._judge({ tz: 'Australia/Brisbane', days: weekFrom(now - DAY), mm: [50, 0, 0, 12, 0, 0, 0] }, now);
  ok('judge: an answer a day old starts at today — yesterday\'s 50 mm is not rain ahead',
    aged.days[0].date === days[0] && aged.days.length === 6 && aged.near.band === 'wet' && aged.near.maxAt === 2, JSON.stringify(aged.near));
  // 15:00 UTC on 1 November: 1 am on the 2nd in Brisbane, 11 pm on the 1st in Perth.
  const late = Date.UTC(2026, 10, 1, 15, 0);
  const perth = HR._judge({ tz: 'Australia/Perth', days: weekFrom(late - 2 * DAY), mm: [0, 0, 0, 0, 0, 0, 40] }, late);
  ok('judge: today is the station\'s own — 1 am in Brisbane is still yesterday in Perth', perth && perth.days[0].date === '2026-11-01', perth && perth.days[0].date);
  ok('judge: an answer from before last week is no answer', HR._judge({ tz: 'Australia/Brisbane', days: weekFrom(now - 9 * DAY), mm: [1, 1, 1, 1, 1, 1, 1] }, now) === null);

  let same = true;
  for (let i = 0; i < 2000; i++) {
    const lat = -44 + Math.random() * 35, lon = 112 + Math.random() * 42;
    if (HR._cellOf(lat, lon) !== cellKey(lat, lon)) { same = false; break; }
  }
  ok('squares: the card and the route snap every coordinate to the same square', same);

  // Who comes first.
  const mk = (id, lat, findings) => ({ st: { id, name: id, lat, lon: 153, catchment_ids: ['logan'] }, findings });
  const F = (category, severity, title = category) => ({ category, severity, title });
  const A = { stations: new Map([
    ['wet-crit', mk('wet-crit', -27.0, [F('power', 'critical', 'Battery critical')])],
    ['very-warn', mk('very-warn', -27.5, [F('comms', 'warn', 'Missing checks')])],
    ['very-crit', mk('very-crit', -28.0, [F('sensor', 'critical', 'Gauge blocked'), F('power', 'warn')])],
    ['very-ok', mk('very-ok', -28.5, [])],
    ['very-notes', mk('very-notes', -29.0, [F('power', 'info'), F('data', 'warn'), F('register', 'warn')])],
    ['later-warn', mk('later-warn', -29.5, [F('power', 'warn')])],
    ['dry-crit', mk('dry-crit', -30.0, [F('power', 'critical')])],
  ]) };
  const HR2 = loadCard(A);
  const t0 = Date.now();
  const wk = weekFrom(t0);
  const cell = (lat, mm) => ({ at: [lat, 153], tz: 'Australia/Brisbane', days: wk, mm });
  HR2._absorb({ fetched: new Date(t0).toISOString(), source: null, cells: [
    cell(-27.0, [0, 12, 0, 0, 0, 0, 0]), cell(-27.5, [0, 0, 40, 0, 0, 0, 0]), cell(-28.0, [0, 45, 0, 0, 0, 0, 0]),
    cell(-28.5, [70, 0, 0, 0, 0, 0, 0]), cell(-29.0, [35, 0, 0, 0, 0, 0, 0]), cell(-29.5, [0, 0, 0, 0, 25, 0, 0]),
    cell(-30.0, [1, 0, 0, 0, 0, 0, 0]),
  ] }, t0);
  const rows = HR2._rows(A);
  const order = rows.map(r => r.S.st.id);
  ok('first: very wet before wet before later; sooner first; dry not listed',
    JSON.stringify(order) === JSON.stringify(['very-ok', 'very-notes', 'very-crit', 'very-warn', 'wet-crit', 'later-warn']), order.join(' '));
  const withFaults = rows.filter(r => r.faults.length).map(r => r.S.st.id);
  ok('first: notes, data quality and register findings are not faults',
    JSON.stringify(withFaults) === JSON.stringify(['very-crit', 'very-warn', 'wet-crit', 'later-warn']), withFaults.join(' '));
  ok('chips: beside a fault with rain in the next three days', /Very wet · 45 mm tomorrow/.test(HR2.chipHtml('very-crit', F('sensor', 'critical'))));
  ok('chips: not beside a register finding, a note, or rain only later in the week',
    HR2.chipHtml('very-notes', F('register', 'warn')) === '' && HR2.chipHtml('very-notes', F('power', 'info')) === '' && HR2.chipHtml('later-warn', F('power', 'warn')) === '');
  const html = HR2.render().replace(/\s+/g, ' ');
  ok('card: its sentence counts the stations with rain ahead and those with a fault open',
    /rain ahead<\/span> at 5 stations<\/strong> in the next three days — 4 <span class="term"[^>]*>very wet/.test(html) && /3 of them have a .*fault open/.test(html), html.slice(0, 900));
  ok('card: says whose figure it is, that it is not a forecast or a warning, and where the Bureau\'s are',
    /ECMWF/.test(html) && /Open-Meteo/.test(html) && /CC BY 4\.0/.test(html) && /not a forecast or a warning from the Bureau of Meteorology or from Flood-Net/.test(html)
      && /https:\/\/www\.bom\.gov\.au\//.test(html) && /australia\/warnings/.test(html));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/Flood-Net/g, '');
  ok('card: never speaks of floods, flood warnings or river heights — that is the Bureau\'s to say',
    !/flood|river height|watch and act|emergency warning|severe weather/i.test(text), (text.match(/flood|river height|watch and act|emergency warning|severe weather/i) || [''])[0]);
  ok('card: the basin fold names the basin and its wettest', /Logan-Albert/.test(html) && /70 mm today/.test(html));
}

// ── 3. the card in Chromium ──────────────────────────────────────────────────

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
const until = (page, fn, arg, timeout = 20_000) => page.waitForFunction(fn, arg, { timeout });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Australia/Brisbane' });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(e.message));

  // The route, stood in for: every square very wet tomorrow north of 27.6° S,
  // wet the day after south of it.
  const asked = [];
  let mode = 'ok';
  await page.route(u => new URL(u).pathname === '/api/rain-ahead', route => {
    const u = new URL(route.request().url());
    const cells = (u.searchParams.get('cells') || '').split(';').filter(Boolean);
    asked.push(cells);
    if (mode === 'fail') return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Open-Meteo answered HTTP 429' }) });
    const wk = weekFrom(Date.now());
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({
      model: MODEL, source: SOURCE, fetched: new Date().toISOString(), stale: null,
      cells: cells.map(c => { const [lat, lon] = c.split(',').map(Number); return { at: [lat, lon], tz: 'Australia/Brisbane', days: wk,
        mm: lat > -27.6 ? [2, 38, 6, 0, 0, 0, 0] : [0, 3, 14, 4, 0, 0, 0] }; }),
    }) });
  });

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await until(page, () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, LOAD_TIMEOUT);
  // The Calm look, whose Station Health opens with its answer in a sentence.
  await page.evaluate(() => { Looks.set('calm'); switchTab('health'); });
  await until(page, () => !!document.getElementById('hl-h'), null);

  // The demo week's readings, analysed as a live week.
  await page.evaluate(() => { const w = HealthAnalysis.demoWorld(); Health.adopt(w.rows, { t0: w.t0, t1: w.t1, now: w.now }); });
  await until(page, () => HealthRainAhead.state().cells > 0 && !HealthRainAhead.state().loading && !!document.querySelector('#hl-rain .hl-rain-lede'), null);

  const got = await page.evaluate(() => {
    const A = Health.state().A;
    const FAULT = new Set(['power', 'comms', 'sensor']);
    const placed = [...A.stations.values()].filter(S => Number.isFinite(S.st.lat) && Number.isFinite(S.st.lon));
    const faulty = placed.filter(S => S.findings.some(f => f.severity !== 'info' && FAULT.has(f.category)));
    const card = document.getElementById('hl-rain');
    const rows = [...card.querySelectorAll('.hl-rain-table tbody tr')];
    const frows = [...document.querySelectorAll('#hl-findings tbody tr')];
    const withChip = frows.filter(r => r.querySelector('.hl-rain-chip'));
    const visible = Health.state().A.findings.filter(f => f.severity !== 'info');
    const faultRows = visible.filter(f => f.stationId && FAULT.has(f.category)).length;
    const halos = document.querySelectorAll('#hl-map path.hl-rain-halo').length;
    return {
      placed: placed.length, faulty: faulty.length, lede: card.querySelector('.hl-rain-lede').textContent.replace(/\s+/g, ' ').trim(),
      rows: rows.length, more: !!card.querySelector('.hl-rain-more'), withChip: withChip.length, faultRows, frows: frows.length,
      chipText: withChip[0] ? withChip[0].querySelector('.hl-rain-chip').textContent.trim() : '',
      chipTitle: withChip[0] ? withChip[0].querySelector('.hl-rain-chip').getAttribute('title') : '',
      halos, src: card.querySelector('.hl-rain-src').textContent.replace(/\s+/g, ' '),
      bom: [...card.querySelectorAll('.hl-rain-src a')].map(a => a.href),
      verdict: (document.querySelector('.hl-verdict') || {}).textContent || '', look: state.look, calm: lookUsesCalmShell(),
      legend: (document.getElementById('hl-map-legend') || {}).textContent || '',
      firstName: rows[0] ? rows[0].querySelector('th').textContent.trim() : '',
      firstId: faulty.length ? null : null,
    };
  });
  const cellsAsked = asked.flat();
  ok('browser: the squares asked in sorted requests of at most fifty, each square once',
    asked.length >= 1 && asked.every(a => a.length <= 50) && new Set(cellsAsked).size === cellsAsked.length
      && asked.every(a => a.every((c, i) => !i || (() => { const [x, y] = a[i - 1].split(',').map(Number), [p, q] = c.split(',').map(Number); return x < p || (x === p && y < q); })())),
    JSON.stringify(asked.map(a => a.length)));
  ok('browser: the card says how many stations have rain ahead, and how many of them a fault open',
    new RegExp(`rain ahead at ${got.placed} stations in the next three days`).test(got.lede) && new RegExp(`${got.faulty} of them have a fault open`).test(got.lede), got.lede);
  ok('browser: Get to these first lists the stations with a fault open (the first eight, and Show all for the rest)',
    got.rows === Math.min(8, got.faulty) && got.more === got.faulty > 8, `${got.rows} rows, ${got.faulty} faulty, more ${got.more}`);
  ok('browser: a 🌧 chip beside every station fault in Needs attention, and beside nothing else',
    got.withChip === got.faultRows && got.withChip > 0 && got.withChip < got.frows, `${got.withChip} chips, ${got.faultRows} station faults, ${got.frows} rows`);
  ok('browser: the chip says how wet and when, and what it is not', /^🌧 (Very wet|Wet) · \d+ mm (today|tomorrow|\w{3})$/.test(got.chipText)
    && /not a forecast or a warning/.test(got.chipTitle), `${got.chipText} | ${got.chipTitle}`);
  ok('browser: a halo on the map round every station with rain ahead', got.halos === got.placed, `${got.halos} of ${got.placed}`);
  ok('browser: the legend says what the halo is', /rain ahead \(model\)/.test(got.legend), got.legend);
  ok('browser: the Calm look\'s sentence points at them', new RegExp(`Rain ahead at ${got.faulty} stations with a fault open — get to them first`).test(got.verdict.replace(/\s+/g, ' ')), JSON.stringify({ v: got.verdict, look: got.look, calm: got.calm }));
  ok('browser: the credit, and the Bureau\'s forecasts and warnings linked',
    /ECMWF/.test(got.src) && /CC BY 4\.0/.test(got.src) && /not a forecast or a warning from the Bureau of Meteorology/.test(got.src)
      && got.bom.includes('https://www.bom.gov.au/') && got.bom.some(h => /bom\.gov\.au\/australia\/warnings/.test(h)), got.src);

  // A station, opened from the card.
  await page.click('#hl-rain .hl-rain-table tbody tr th button');
  await until(page, () => /Rain ahead \(weather model\)/.test((document.getElementById('hl-station') || {}).textContent || ''), null);
  const stn = await page.evaluate(() => {
    const dd = [...document.querySelectorAll('#hl-station .hl-facts div')].find(d => /Rain ahead/.test(d.querySelector('dt').textContent));
    return { text: dd ? dd.querySelector('dd').textContent.replace(/\s+/g, ' ').trim() : '', days: dd ? dd.querySelectorAll('.hl-rain-day').length : 0,
      label: dd && dd.querySelector('.hl-rain-week') ? dd.querySelector('.hl-rain-week').getAttribute('aria-label') : '' };
  });
  ok('browser: a station opened from the card has its rain ahead and the model\'s seven days',
    /(Very wet|Wet) · \d+ mm/.test(stn.text) && stn.days === 7 && /^The model's rain a day: today \d/.test(stn.label), JSON.stringify(stn));

  // The route failing: said, and nothing else hurt.
  mode = 'fail';
  await page.evaluate(() => { Health.close(); HealthRainAhead._reset(); const w = HealthAnalysis.demoWorld(); Health.adopt(w.rows, { t0: w.t0, t1: w.t1, now: w.now }); });
  await until(page, () => !!HealthRainAhead.state().err && !HealthRainAhead.state().loading, null);
  await until(page, () => /could not be fetched/.test((document.getElementById('hl-rain') || {}).textContent || ''), null);
  const failed = await page.evaluate(() => ({
    card: document.getElementById('hl-rain').textContent.replace(/\s+/g, ' '),
    chips: document.querySelectorAll('.hl-rain-chip').length,
    findings: document.querySelectorAll('#hl-findings tbody tr').length,
  }));
  ok('browser: the route failing is said on the card, with the reason', /could not be fetched — Open-Meteo answered HTTP 429/.test(failed.card), failed.card.slice(0, 300));
  ok('browser: …and the rest of the tab carries on without it', failed.chips === 0 && failed.findings > 0, JSON.stringify(failed));

  // The demo week: made-up rain, and not a request.
  mode = 'ok';
  const before = asked.length;
  await page.evaluate(() => Health.demo());
  await until(page, () => HealthRainAhead.state().demo && /made up as well/.test((document.getElementById('hl-rain') || {}).textContent || ''), null);
  const demo = await page.evaluate(() => ({
    rows: document.querySelectorAll('#hl-rain .hl-rain-table tbody tr').length,
    src: document.querySelector('#hl-rain .hl-rain-src').textContent,
  }));
  ok('browser: Demo week shows made-up rain, says so, and asks the route nothing',
    asked.length === before && demo.rows > 0 && /made up for the demo week/.test(demo.src), JSON.stringify({ asked: asked.length - before, rows: demo.rows }));

  ok('browser: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

if (failures) { console.log(`\nFAIL — ${failures} of ${failures + passes} check(s) failed.`); process.exit(1); }
console.log(`PASS — ${passes} checks: the route asks one model for Australia's squares and keeps the answer; the card ranks the faults by the rain ahead, and says what the figure is not.`);
