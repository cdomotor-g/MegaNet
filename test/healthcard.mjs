// A station's health where people already look (#218, health-glance.js): its
// card on the Stations map and its pin, driven in Chromium with the datastore
// stood in for by test/lib/postgrest-stub.mjs — the strict PostgREST the agent
// API is held to, so a query that only works against a forgiving fake goes
// red here too.
//
//   1. **The rules** — when a quiet station becomes a watch and when a fault,
//      for a learned check period and for the assumed one; a finding's
//      severity against a silence; a station heard too seldom to judge, and
//      no answer at all, are "no data", never "OK" and never a fault.
//   2. **The card** — against HealthAnalysis's demo week (real stations, one of
//      every fault planted): when it was last heard, its battery's night lows
//      and where they are going, and its findings worst first, for a station
//      whose battery is sliding, one gone silent, one left alone, one heard
//      only by the ingest (its readings aged out), one heard once — a stray
//      frame, no data rather than a fault — and one never heard. One request
//      a card, of the station's own rows and addresses (and a one-row look at
//      station_health for the three with no readings), none for a repaint or
//      a second look.
//   3. **The doors** — each line opens the Station Health tab on that station,
//      at the part it was about, with focus there and the address saying so
//      (?tab=health&station=…); a reload of that address lands on it again; a
//      station the window holds nothing from is said to be so.
//   4. **The pins** — Colour pins by health, off by default; switched on by a
//      real click in 🗺️ Map display, one request for the whole network,
//      however many times the map is rebuilt or the tab re-entered; every pin
//      a class, a class never only a colour (bigger is worse, the ring dashed
//      or heavy, no data hollow and dotted); the key in the legend in place of
//      the role key; the map's name carrying the counts; a pin following its
//      card; and switched off, the roles' colours back.
//   5. **No data, honestly** — a datastore that refuses this browser, and one
//      that cannot be reached: the card says which and offers Try again, every
//      pin is hollow, nothing says OK.
//   6. **A phone** — the card's health lines inside a 375 px screen.
//
// Why a check of its own: every failure here is a page that looks right. A pin
// coloured green for want of an answer, a card that asks the datastore on every
// filter keystroke, a map that fetches the network once per marker rebuild, a
// door that opens Station Health on nothing — none of them throws.
//
// Run:  npm run healthcard
//       npm run healthcard -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { PostgrestStub } from './lib/postgrest-stub.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };
const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}
const J = v => JSON.stringify(v);

// The project the app asks when it is not behind the Worker (core.js, DB_ORIGIN).
const DB = 'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1';
// The columns 0006/0024/0050 give meganet.reading and 0008 gives
// meganet.station_health: a select naming anything else is a 400 from the stub.
const READING_COLS = ['addr', 'alert_id', 'a2_station', 'a2_sensor', 'station_number', 'channel', 'station_id',
  'reading_ts', 'received_at', 'value_raw', 'value', 'unit', 'conversion', 'quality', 'protocol', 'source', 'path',
  'dup_count', 'dup_paths', 'last_dup_at', 'raw_id', 'ingest_token_id', 'freq_mhz', 'rssi_dbm', 'level_dbfs', 'snr_db'];
const HEALTH_COLS = ['station_key', 'station_id', 'station_name', 'online', 'since', 'last_seen_at', 'last_reading_at',
  'minutes_since_seen', 'minutes_since_reading', 'last_status', 'reported_by', 'updated_at'];

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

// Every request this check answers, by kind, so "one request" can be counted.
let asked = [];
const count = kind => asked.filter(a => a.kind === kind).length;
// 'ok' answers from the stub; 'denied' is a 401 on both relations, as a
// datastore refusing an anonymous reader would answer; 'down' aborts, as an
// unreachable one does.
let MODE = 'ok';
let stub = null;

async function standIn(page) {
  await page.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = req.url();
    const rel = new URL(url).pathname.replace(/^.*\/rest\/v1\//, '');
    if (rel !== 'reading' && rel !== 'station_health') return route.fallback();
    // The pins' batch; a card's one-row look at when the ingest last heard a
    // station with no readings left; a card's readings; the tab's week.
    const kind = rel === 'station_health' ? (/[?&]station_id=eq\./.test(url) ? 'ingest' : 'network')
      : /[?&]or=/.test(url) || /[?&]station_id=eq\./.test(url) ? 'card' : 'tab';
    asked.push({ kind, url: decodeURIComponent(url) });
    if (MODE === 'down') return route.abort('connectionrefused');
    if (MODE === 'denied') {
      return route.fulfill({ status: 401, contentType: 'application/json',
        body: J({ code: '42501', message: `permission denied for view ${rel}`, details: null, hint: null }) });
    }
    const res = await stub.fetch(url, { method: req.method(), headers: req.headers() });
    return route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
  });
}

async function open(context) {
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await standIn(page);
  page.on('pageerror', e => errors.push(String(e)));
  return page;
}

async function loaded(page, path = '/index.html') {
  await page.goto(server.origin + path, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
}
async function toStations(page) {
  await page.evaluate(() => { if (state.activeTab !== 'stations') switchTab('stations'); });
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: LOAD_TIMEOUT });
}
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
// A wait that answers true or false rather than throwing, so a check that is
// broken goes red on its own assertion instead of ending the run.
const waitTrue = (page, fn, arg, timeout = 20_000) =>
  page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const press = (page, sel) => page.click(sel, { timeout: 5_000 }).then(() => true, () => false);

// Open a station's card and wait for its health section to stop asking.
async function card(page, id) {
  await page.evaluate(id => showStationCard(id), id);
  await waitTrue(page, id => {
    const el = document.getElementById('mn-health-card-' + id);
    return el && !el.querySelector('[aria-busy="true"]');
  }, id);
  return page.evaluate(id => {
    const el = document.getElementById('mn-health-card-' + id);
    if (!el) return { badge: null, heard: null, battery: null, findings: null, doors: [], items: [], text: '', retry: false, cls: HealthGlance.classOf(id) };
    const rowOf = label => [...el.querySelectorAll('.acma-row')].find(r => r.firstElementChild.textContent.trim() === label);
    const val = label => { const r = rowOf(label); return r ? r.lastElementChild.textContent.replace(/\s+/g, ' ').trim() : null; };
    const badge = el.querySelector('.hg-badge');
    return {
      badge: badge ? badge.textContent.replace(/\s+/g, ' ').trim() : null,
      heard: val('Last heard'), battery: val('Battery'), findings: val('Findings'),
      doors: [...el.querySelectorAll('button.hg-go')].map(b => b.getAttribute('onclick')),
      items: [...el.querySelectorAll('.stn-card-health-list li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      retry: !!el.querySelector('button[onclick^="HealthGlance.retry"]'),
      cls: HealthGlance.classOf(id),
    };
  }, id);
}

try {
  // ═══════════════════════════════════════════════════════════════════════
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Australia/Brisbane' });
  const page = await open(context);
  await loaded(page);

  // The week whose answer is known, against the real register, and the
  // station_health the ingest would have written for it.
  const W = await page.evaluate(() => {
    const w = HealthAnalysis.demoWorld(undefined, { now: Date.now() });
    const idx = SensorValues.index();
    const last = {}, first = {};
    w.rows.forEach(r => {
      const c = idx.get(r.alert_id) || [];
      if (c.length !== 1) return;
      const id = c[0].station.id;
      if (!last[id] || last[id] < r.reading_ts) last[id] = r.reading_ts;
      if (!first[id] || first[id] > r.reading_ts) first[id] = r.reading_ts;
    });
    const roles = new Set(Object.values(w.roles).filter(v => typeof v === 'string'));
    // Three stations the week does not touch: one the ingest heard for a month
    // and not for the last hundred days, its readings aged out; one it heard
    // once, two days ago — a single stray frame; and one nobody has heard.
    const spare = state.data.stations.filter(s => s.lat != null && !s.proposed && !roles.has(s.id)
      && stationAlertIds(s).length && (s.roles || []).includes('field') && !(s.roles || []).includes('repeater'));
    // And a fourth whose readings arrive only on an address it shares with
    // another station, through a receiver that hears nothing else: nothing
    // heard with them says whose they are, and the card must not call them
    // its own.
    const taken = new Set([...roles, spare[0].id, spare[1].id, spare[2].id]);
    let shared = null;
    for (const [aid, list] of idx) {
      if (list.length < 2 || aid > 8191 || list.some(c => taken.has(c.station.id))) continue;
      const s = list.find(c => c.station.lat != null && !c.station.proposed);
      if (s) { shared = { id: s.station.id, aid }; break; }
    }
    return { rows: w.rows, roles: w.roles, last, first, aged: spare[0].id, never: spare[1].id, once: spare[2].id, shared };
  });
  for (let k = 1; k <= 10; k++) {
    const t = Date.now() - k * 3 * 3600e3;
    W.rows.push({ addr: 'a:' + W.shared.aid, alert_id: W.shared.aid, a2_station: null, a2_sensor: null, station_number: null,
      channel: '', station_id: null, reading_ts: new Date(t).toISOString(), received_at: new Date(t + 4000).toISOString(),
      value_raw: 130 + (k % 3), value: null, unit: null, protocol: 1, source: 5, path: 'serial-monitor/test-elsewhere-pi',
      dup_count: 0, dup_paths: [], freq_mhz: null, rssi_dbm: null, level_dbfs: null, snr_db: null });
  }
  const R = W.roles;
  const DAY = 86400e3;
  // As the HTTP ingest keeps them: `online` null, and `since` the moment the
  // row was made — when the station was first heard.
  const healthRows = Object.entries(W.last).map(([id, t]) => ({
    station_key: id, station_id: id, station_name: null, online: null, since: W.first[id],
    last_seen_at: t, last_reading_at: t, minutes_since_seen: 0, minutes_since_reading: 0,
    last_status: {}, reported_by: null, updated_at: t,
  }));
  const ago = d => new Date(Date.now() - d * DAY).toISOString();
  // #162's twin: an older row keyed by a topic segment for a station that has
  // a newer one under its id. The newer is when it was last heard.
  healthRows.push({ station_key: 'STEADY_TOPIC', station_id: R.steady, online: null, since: ago(10), last_seen_at: ago(3),
    last_reading_at: null, last_status: {} });
  // An address no one station owns: keyed a:…, no station id — not a station's.
  healthRows.push({ station_key: 'a:9999', station_id: null, online: null, since: ago(0), last_seen_at: ago(0), last_reading_at: null, last_status: {} });
  healthRows.push({ station_key: W.aged, station_id: W.aged, online: null, since: ago(130), last_seen_at: ago(100),
    last_reading_at: ago(100), last_status: {} });
  // Heard once: `since` and `last_seen_at` the same moment — 115 of the live
  // network's 503 rows looked like this when #218 was built.
  healthRows.push({ station_key: W.once, station_id: W.once, online: null, since: ago(2), last_seen_at: ago(2),
    last_reading_at: ago(2), last_status: {} });
  stub = new PostgrestStub({
    base: DB,
    columns: { reading: new Set(READING_COLS), station_health: new Set(HEALTH_COLS) },
    tables: { reading: W.rows, station_health: healthRows },
  });
  vlog(`  the week: ${W.rows.length} readings; ${healthRows.length} station_health rows`);

  // ── 1. The rules ──────────────────────────────────────────────────────
  log('\n1. When quiet is a watch, and when a fault\n');
  const rules = await page.evaluate(() => {
    const H = 3600e3, now = Date.UTC(2026, 9, 7, 12);
    const at = (h, P, sev) => HealthGlance.classify({ lastHeard: now - h * H, P: P == null ? null : P * H, sev: sev || null }, now);
    return {
      assumed: HealthGlance.bars(null), three: HealthGlance.bars(3 * H), daily: HealthGlance.bars(24 * H),
      a5: at(5), a7: at(7), a13: at(13), a25: at(25),
      p5: at(5, 3), p7: at(7, 3), p13: at(13, 3), half: at(1, 0.5), half2: at(2.5, 0.5),
      warn: at(1, 3, 'warn'), crit: at(1, 3, 'critical'), info: at(1, 3, 'info'), worse: at(13, 3, 'warn'),
      never: HealthGlance.classify({ lastHeard: null, P: null, sev: 'critical' }, now),
      once: HealthGlance.classify({ lastHeard: now - 48 * H, firstHeard: now - 48 * H, P: null, sev: null }, now),
      brief: HealthGlance.classify({ lastHeard: now - 48 * H, firstHeard: now - 52 * H, P: null, sev: null }, now),
      long: HealthGlance.classify({ lastHeard: now - 48 * H, firstHeard: now - 60 * H, P: null, sev: null }, now),
      learned: HealthGlance.classify({ lastHeard: now - 48 * H, firstHeard: now - 52 * H, P: 30 * 60e3, sev: null }, now),
      onceNow: HealthGlance.classify({ lastHeard: now - 1 * H, firstHeard: now - 1 * H, P: null, sev: null }, now),
      onceWarn: HealthGlance.classify({ lastHeard: now - 48 * H, firstHeard: now - 48 * H, P: null, sev: 'warn' }, now),
      quiet: HealthGlance.quietFinding('x', now - 13 * H, 3 * H, now),
      notQuiet: HealthGlance.quietFinding('x', now - 2 * H, 3 * H, now),
      empty: HealthGlance.glanceFrom({ id: 'x', sensors: [] }, [], now),
    };
  });
  const h = 3600e3;
  check('a check is taken as three hours until it is learned: a watch from 6 h, a fault only from a day',
    rules.assumed.watch === 6 * h && rules.assumed.fault === 24 * h && rules.assumed.assumed, J(rules.assumed));
  check('learned at three hours: a watch from two checks, a fault from four', rules.three.watch === 6 * h && rules.three.fault === 12 * h, J(rules.three));
  check('learned at a day: a watch and a fault together, from two days', rules.daily.watch === 48 * h && rules.daily.fault === 48 * h, J(rules.daily));
  check('assumed: 5 h OK, 7 h watch, 13 h still a watch, 25 h a fault',
    rules.a5 === 'ok' && rules.a7 === 'watch' && rules.a13 === 'watch' && rules.a25 === 'fault', J([rules.a5, rules.a7, rules.a13, rules.a25]));
  check('learned at 3 h: 5 h OK, 7 h watch, 13 h fault; at half an hour, a watch from 90 min and a fault from 2 h',
    rules.p5 === 'ok' && rules.p7 === 'watch' && rules.p13 === 'fault' && rules.half === 'ok' && rules.half2 === 'fault',
    J([rules.p5, rules.p7, rules.p13, rules.half, rules.half2]));
  check('a warning is a watch and a critical finding a fault, however recently heard; a note colours nothing',
    rules.warn === 'watch' && rules.crit === 'fault' && rules.info === 'ok' && rules.worse === 'fault', J([rules.warn, rules.crit, rules.info, rules.worse]));
  check('never heard is no data, whatever else is said — never "OK" for want of an answer', rules.never === 'nodata', rules.never);
  check('heard once, or across less than two of its checks, and quiet since: no data — too seldom to judge, not a fault',
    rules.once === 'nodata' && rules.brief === 'nodata', J([rules.once, rules.brief]));
  check('…but heard across two checks, or keeping a learned schedule, its silence is judged; heard once just now is OK',
    rules.long === 'fault' && rules.learned === 'fault' && rules.onceNow === 'ok', J([rules.long, rules.learned, rules.onceNow]));
  check('…and a finding still counts for a station heard too seldom to judge its silence', rules.onceWarn === 'watch', rules.onceWarn);
  check('the silence as a finding: critical at four checks, and saying it cannot see the receivers',
    rules.quiet && rules.quiet.severity === 'critical' && /Quiet for 13 h/.test(rules.quiet.title)
      && /receivers/.test(rules.quiet.detail) && rules.notQuiet === null, J(rules.quiet));
  check('no readings is nothing heard, not an error', rules.empty.lastHeard === null && rules.empty.findings.length === 0, J(rules.empty));

  // ── 2. Off by default ─────────────────────────────────────────────────
  log('\n2. Colour pins by health is off until it is asked for\n');
  await toStations(page);
  await page.waitForTimeout(400);
  const off0 = await page.evaluate(() => ({
    flag: state.mapHealth, stored: localStorage.getItem('mn-map-health'),
    tagged: state.mapMarkers.filter(m => m.mnHealth).length,
    roles: /Field Station/.test(document.getElementById('map-legend').textContent),
    offLine: /Also available[^<]*Pins coloured by health/.test(document.getElementById('map-legend').innerHTML),
    note: (document.getElementById('map-health-note') || {}).textContent || null,
  }));
  check('off on a first visit, and the map asks the datastore nothing for it',
    off0.flag === false && off0.tagged === 0 && count('network') === 0, J({ off0, network: count('network') }));
  check('the legend keeps the role key and names the switch among what else is available', off0.roles && off0.offLine, J(off0));
  check('its note in Map display says what the pins wear while it is off', /role/.test(off0.note || ''), off0.note);

  // ── 3. The card ───────────────────────────────────────────────────────
  log('\n3. The card: last heard, the battery, the findings — one request\n');
  asked = [];
  const falling = await card(page, R.falling);
  const req = asked.filter(a => a.kind === 'card');
  const ids = await page.evaluate(id => stationAlertIds(state.data.stations.find(s => s.id === id)), R.falling);
  check('one request for the card', req.length === 1, J(asked.map(a => a.url.slice(0, 120))));
  check('…of the station’s own rows and its own ALERT addresses, newest first, at most 1,000',
    req[0] && req[0].url.includes(`station_id.eq."${R.falling}"`) && ids.every(a => req[0].url.includes(`"a:${a}"`))
      && /order=reading_ts\.desc/.test(req[0].url) && /limit=1000/.test(req[0].url), req[0] && req[0].url);
  check('a sliding battery: last heard, with how long ago and the learned schedule',
    /(today|yesterday|\d{2}:\d{2})/.test(falling.heard || '') && /ago/.test(falling.heard) && /checks every 3 h/.test(falling.heard), falling.heard);
  check('…its night lows, falling, and when they reach 11.8 V',
    /V last night/.test(falling.battery || '') && /falling 0\.\d\d V a day/.test(falling.battery) && /11\.8 V in about \d+ day/.test(falling.battery), falling.battery);
  check('…its findings worst first, the battery among them, every one listed under the line',
    /Battery (low|falling)/.test(falling.findings || '') && falling.items.length >= 2 && falling.items.some(t => /Battery falling/.test(t)), J(falling.items));
  check('…and its class a watch, as a word and a glyph beside the colour', /Watch/.test(falling.badge || '') && /⚠/.test(falling.badge) && falling.cls === 'watch', falling.badge);
  check('each line a door into Station Health at its own part — the checks, the battery, the findings',
    ['checks', 'battery', 'findings'].every(p => falling.doors.some(d => d.includes(`'${R.falling}', '${p}'`))), J(falling.doors));

  await page.evaluate(() => { repaintStnCard(); repaintStnCard(); rerenderStationEditorCard(); });
  await frames(page);
  await card(page, R.falling);
  check('a repaint and a second look inside five minutes ask nothing more', asked.filter(a => a.kind === 'card').length === 1,
    `${asked.filter(a => a.kind === 'card').length} card request(s)`);

  const silent = await card(page, R.silent);
  check('a station gone silent: a fault, its silence the worst finding, saying the receivers are Station Health’s to weigh',
    /Fault/.test(silent.badge || '') && /Quiet for/.test(silent.findings || '') && silent.cls === 'fault'
      && /Station Health/.test(silent.text) && /receivers/.test(silent.text), J({ badge: silent.badge, findings: silent.findings }));
  const steady = await card(page, R.steady);
  check('a station left alone: OK, nothing found', /OK/.test(steady.badge || '') && /nothing found/.test(steady.findings || '') && steady.cls === 'ok',
    J({ badge: steady.badge, findings: steady.findings }));
  const aged = await card(page, W.aged);
  check('heard only by the ingest, its readings aged out: when it was last heard, a fault, and why there is nothing else',
    /Fault/.test(aged.badge || '') && aged.heard && /ago/.test(aged.heard) && /aged out/.test(aged.text), J({ badge: aged.badge, heard: aged.heard, text: aged.text.slice(-160) }));
  const once = await card(page, W.once);
  check('heard once, two days ago: when, no data rather than a fault, and why',
    /No data/.test(once.badge || '') && /ago/.test(once.heard || '') && /Heard once/.test(once.text) && /too seldom/.test(once.text)
      && once.cls === 'nodata' && !/Quiet for/.test(once.text), J({ badge: once.badge, heard: once.heard, text: once.text.slice(-200) }));
  const shared = await card(page, W.shared.id);
  check('heard only on an address it shares, where nothing tells the owners apart: not called its own — no data, and why',
    /No data/.test(shared.badge || '') && /not told apart/.test(shared.heard || '') && /addresses it shares/.test(shared.text)
      && shared.cls === 'nodata' && shared.doors.length === 0, J({ badge: shared.badge, heard: shared.heard, text: shared.text.slice(-200) }));
  const never = await card(page, W.never);
  check('never heard: no data, said in words, and no door to a tab that has nothing on it',
    /No data/.test(never.badge || '') && /never/.test(never.heard || '') && never.doors.length === 0 && never.cls === 'nodata',
    J({ badge: never.badge, heard: never.heard, doors: never.doors }));
  const proposed = await page.evaluate(() => {
    const s = state.data.stations.find(x => x.proposed);
    return s ? HealthGlance.cardHtml(s) : null;
  });
  check('a proposed station has no health section — nothing to have heard', proposed === '' || proposed === null, String(proposed).slice(0, 80));
  check('one request a card, seven cards — and a second, of one row, only for the three with no readings at all',
    asked.filter(a => a.kind === 'card').length === 7 && count('ingest') === 3
      && asked.filter(a => a.kind === 'ingest').every(a => [W.aged, W.never, W.once].some(id => a.url.includes(`station_id=eq.${id}`))),
    J({ card: asked.filter(a => a.kind === 'card').length, ingest: count('ingest') }));

  // ── 4. The pins ───────────────────────────────────────────────────────
  log('\n4. Colour pins by health — one request for the whole network\n');
  await page.evaluate(() => closeStnCard(false));
  await page.click('#help-panel .dock-tab[data-dock="map-display"]');
  await page.waitForTimeout(300);
  await press(page, '#dock-pane-map-display #map-display-block input[onchange^="HealthGlance.setPins"]');
  await waitTrue(page, () => HealthGlance._state().net.status === 'ok'
    && state.mapMarkers.length > 1000 && state.mapMarkers.every(m => m.mnHealth));
  await page.waitForTimeout(200);
  const pins = await page.evaluate(([R, aged, never, once]) => {
    const m = id => state.mapMarkers.find(x => x.mnStationId === id);
    const style = id => { const x = m(id); return x && { cls: x.mnHealth, r: x.options.radius, ring: x.options.color, w: x.options.weight,
      dash: x.options.dashArray || null, fill: x.options.fillColor, base: x.mnStation.roles.includes('repeater') ? MAP_PIN_R_RPT : MAP_PIN_R_FIELD }; };
    const tally = {};
    state.mapMarkers.forEach(x => { tally[x.mnHealth] = (tally[x.mnHealth] || 0) + 1; });
    const legend = document.getElementById('map-legend');
    const keys = [...legend.querySelectorAll('.hg-key')].map(k => {
      const cs = getComputedStyle(k);
      return { cls: k.className, w: parseFloat(cs.width), border: cs.borderTopStyle, bw: parseFloat(cs.borderTopWidth) };
    });
    return {
      steady: style(R.steady), silent: style(R.silent), falling: style(R.falling), aged: style(aged), never: style(never), once: style(once),
      tally, keys, legendText: legend.textContent.replace(/\s+/g, ' '),
      roleRows: /Field Station/.test(legend.textContent),
      note: document.getElementById('map-health-note').textContent.replace(/\s+/g, ' ').trim(),
      alt: document.getElementById('leaflet-map').getAttribute('aria-label'),
      stored: localStorage.getItem('mn-map-health'), flag: state.mapHealth,
      said: document.getElementById('app-status').textContent,
    };
  }, [R, W.aged, W.never, W.once]);
  check('a real click on the switch turns it on, and it is remembered', pins.flag === true && pins.stored === 'on', J({ flag: pins.flag, stored: pins.stored }));
  check('one request for the whole network', count('network') === 1, `${count('network')} station_health request(s)`);
  check('every pin wears a class', Object.keys(pins.tally).every(k => ['ok', 'watch', 'fault', 'nodata'].includes(k)), J(pins.tally));
  check('heard lately and nothing found: OK; silent a day and more: a fault; heard for a month and not for 100 days: a fault; never: no data',
    pins.steady.cls === 'ok' && pins.silent.cls === 'fault' && pins.aged.cls === 'fault' && pins.never.cls === 'nodata',
    J({ steady: pins.steady.cls, silent: pins.silent.cls, aged: pins.aged.cls, never: pins.never.cls }));
  check('heard once by the ingest, two days ago: no data on the map too — a stray frame is not a fault', pins.once.cls === 'nodata', pins.once.cls);
  check('a pin follows what its card found: the sliding battery is a watch on the map too', pins.falling.cls === 'watch', pins.falling.cls);
  check('the latest of a station’s station_health rows is when it was heard (#162’s twin is older)', pins.steady.cls === 'ok', pins.steady.cls);
  // Colour is never the only channel: bigger is worse, and the ring says it.
  const s = pins;
  check('OK: the pin as it always was — its size, the white ring',
    s.steady.r === s.steady.base && s.steady.ring === '#ffffff' && !s.steady.dash, J(s.steady));
  check('watch: a step bigger, in a dashed black ring', s.falling.r === s.falling.base + 2 && s.falling.ring === '#000000' && s.falling.dash === '2,4', J(s.falling));
  check('fault: bigger again, in a heavy black ring', s.silent.r === s.silent.base + 4 && s.silent.ring === '#000000' && s.silent.w >= 3 && !s.silent.dash, J(s.silent));
  check('no data: hollow, smaller, in a dotted ring', s.never.fill === '#ffffff' && s.never.r < s.never.base && s.never.dash === '1,3', J(s.never));
  const k = Object.fromEntries(s.keys.map(x => [x.cls.replace(/^.*hg-key--/, ''), x]));
  check('the legend’s key in place of the role key: four classes, each swatch its pin’s second channel',
    s.keys.length === 4 && !s.roleRows && /not by role/.test(s.legendText)
      && k.ok.w < k.watch.w && k.watch.w < k.fault.w
      && k.watch.border === 'dashed' && k.fault.border === 'solid' && k.fault.bw >= 3 && k.nodata.border === 'dotted',
    J({ keys: s.keys, roleRows: s.roleRows }));
  check('the note says how many of each, and when', /As of .*OK.*watch.*fault.*no data/.test(s.note), s.note);
  check('the map’s name carries the counts', /pins coloured by health — [\d,]+ OK/.test(s.alt || ''), s.alt);
  check('the switch is announced with what it found', /Pins coloured by health: [\d,]+ OK/.test(s.said), s.said);

  // The flatline station's card has not been opened: OK on silence alone.
  // Opening it finds no daily charge, and its pin follows — with no second
  // request for the network.
  const before = await page.evaluate(id => HealthGlance.classOf(id), R.flatline);
  await card(page, R.flatline);
  await page.waitForFunction(id => (state.mapMarkers.find(x => x.mnStationId === id) || {}).mnHealth === 'watch', R.flatline, { timeout: 10_000 }).catch(() => {});
  const after = await page.evaluate(id => (state.mapMarkers.find(x => x.mnStationId === id) || {}).mnHealth, R.flatline);
  check('a pin follows its card the moment the card finds something: OK → watch, no second network request',
    before === 'ok' && after === 'watch' && count('network') === 1, J({ before, after, network: count('network') }));

  // Rebuilt by a filter, by the theme, by leaving the tab and coming back:
  // still one request.
  await page.evaluate(async () => {
    refreshMapLayers(); refreshMapLayers({ skipFit: true });
    setTheme('dark'); setTheme('light');
    switchTab('passranges'); switchTab('stations');
  });
  const classed = await waitTrue(page, () => !!state.map && state.mapMarkers.length > 1000 && state.mapMarkers.every(m => m.mnHealth), null, LOAD_TIMEOUT);
  check('rebuilt four times and the tab re-entered: still one request, every pin still classed',
    classed && count('network') === 1, `${count('network')} station_health request(s), classed: ${classed}`);
  const theme = await page.evaluate(id => ({ dark: state.mapMarkers.find(x => x.mnStationId === id).options.fillColor }), R.silent);
  check('the pins keep their colours across a theme change — the base maps do not go dark', theme.dark === '#c7401a', J(theme));

  await page.click('#help-panel .dock-tab[data-dock="map-display"]').catch(() => {});
  await page.waitForTimeout(300);
  if (!(await page.isVisible('#dock-pane-map-display #map-display-block input[onchange^="HealthGlance.setPins"]'))) {
    await page.click('#help-panel .dock-tab[data-dock="map-display"]');
    await page.waitForTimeout(300);
  }
  await press(page, '#dock-pane-map-display #map-display-block input[onchange^="HealthGlance.setPins"]');
  await frames(page);
  const offAgain = await page.evaluate(id => {
    const m = state.mapMarkers.find(x => x.mnStationId === id);
    return { cls: m.mnHealth, fill: m.options.fillColor, role: ROLE_COLOR[primaryRole(m.mnStation)],
             roles: /Field Station/.test(document.getElementById('map-legend').textContent),
             stored: localStorage.getItem('mn-map-health'), said: document.getElementById('app-status').textContent };
  }, R.silent);
  check('switched off by a real click: the roles’ colours and the role key back, remembered off',
    offAgain.cls === null && offAgain.fill === offAgain.role && offAgain.roles && offAgain.stored === 'off', J(offAgain));

  // ── 5. The doors ──────────────────────────────────────────────────────
  log('\n5. Each line opens Station Health on that station\n');
  await card(page, R.falling);
  asked = [];
  await press(page, `#mn-health-card-${R.falling} button.hg-go[onclick*="'battery'"]`);
  await waitTrue(page, id => state.activeTab === 'health' && Health.state().A && Health.state().sel === id
    && document.activeElement && document.activeElement.id === 'hl-h-batt', R.falling, 60_000);
  const door = await page.evaluate(() => {
    const at = id => document.getElementById(id);
    return {
      tab: state.activeTab, sel: Health.state().sel, focus: document.activeElement && document.activeElement.id,
      head: at('hl-h-stn') ? at('hl-h-stn').textContent : null, search: location.search,
      inView: !!at('hl-h-batt') && (() => { const r = at('hl-h-batt').getBoundingClientRect(); return r.top >= -1 && r.top < innerHeight; })(),
    };
  });
  const name = await page.evaluate(id => state.data.stations.find(s => s.id === id).name, R.falling);
  check('Battery opens Station Health with the station picked, its battery chart in view and focused',
    door.sel === R.falling && door.head === name && door.focus === 'hl-h-batt' && door.inView, J(door));
  check('…and the address says so', door.search === `?tab=health&station=${R.falling}`, door.search);
  check('…the tab reading its own week, as it always does', count('tab') >= 1, `${count('tab')} tab request(s)`);

  // A reload of that address lands on the same station.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const reloaded = await waitTrue(page, id => typeof Health !== 'undefined' && state.activeTab === 'health' && Health.state().A
    && Health.state().sel === id, R.falling, 60_000);
  check('a reload of that address opens the tab on the same station', reloaded,
    J(await page.evaluate(() => ({ tab: state.activeTab, sel: typeof Health !== 'undefined' && Health.state().sel, search: location.search }))));

  // The findings door, from another station's card.
  await toStations(page);
  await card(page, R.silent);
  await press(page, `#mn-health-card-${R.silent} button.hg-go[onclick*="'findings'"]`);
  const onFindings = await waitTrue(page, id => state.activeTab === 'health' && Health.state().sel === id
    && document.activeElement && document.activeElement.id === 'hl-h-stnf', R.silent, 30_000);
  check('Findings opens it on the findings, focused', onFindings,
    J(await page.evaluate(() => ({ tab: state.activeTab, sel: typeof Health !== 'undefined' && Health.state().sel, focus: document.activeElement && document.activeElement.id }))));

  // A station the window holds nothing from: said so, not dropped.
  await toStations(page);
  await card(page, W.aged);
  await press(page, `#mn-health-card-${W.aged} button.hg-go[onclick*="'checks'"]`);
  await waitTrue(page, id => state.activeTab === 'health' && Health.state().missing === id, W.aged, 30_000);
  const miss = await page.evaluate(() => ({
    text: (document.getElementById('hl-station') || { textContent: '' }).textContent.replace(/\s+/g, ' '),
    focus: document.activeElement && document.activeElement.id, search: location.search,
    longer: [...document.querySelectorAll('#hl-station button')].map(b => b.textContent.trim()),
  }));
  check('a station not heard in the window is named and said to be so, with a longer window one press away',
    /Not heard in this window/.test(miss.text) && miss.focus === 'hl-h-stn' && miss.longer.some(t => /Look back 14 days/.test(t))
      && miss.search === `?tab=health&station=${W.aged}`, J(miss));
  await page.evaluate(() => Health.close());
  await frames(page);
  check('Close puts the tab back, and the station leaves the address', await page.evaluate(() => location.search) === '?tab=health',
    await page.evaluate(() => location.search));

  // ── 6. No data, honestly ──────────────────────────────────────────────
  log('\n6. A datastore that refuses, and one that is not there\n');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Australia/Brisbane' });
    await ctx.addInitScript(() => { try { localStorage.setItem('mn-map-health', 'on'); localStorage.setItem('mn-tab', 'stations'); } catch (_) {} });
    const p = await open(ctx);
    MODE = 'denied';
    asked = [];
    await loaded(p, '/index.html?tab=stations');
    await toStations(p);
    await waitTrue(p, () => HealthGlance._state().net.status === 'error' && state.mapMarkers.every(m => m.mnHealth));
    const denied = await p.evaluate(() => ({
      tally: state.mapMarkers.reduce((t, m) => (t[m.mnHealth] = (t[m.mnHealth] || 0) + 1, t), {}),
      note: document.getElementById('map-health-note').textContent.replace(/\s+/g, ' '),
    }));
    check('remembered on: one request at load, before anything is clicked', count('network') === 1, `${count('network')}`);
    check('refused: every pin no data — hollow, not OK — and the note says the datastore would not let it read',
      Object.keys(denied.tally).join() === 'nodata' && /would not let this browser read/.test(denied.note), J(denied));
    const c = await card(p, R.steady);
    check('…and the card: no data, the refusal in words, and Try again',
      /No data/.test(c.badge || '') && /would not let this browser read its readings/.test(c.text) && c.retry && c.cls === 'nodata', J({ badge: c.badge, text: c.text }));

    MODE = 'down';
    const c2 = await card(p, R.flatline);
    check('unreachable: no data, "could not be reached", and Try again', /No data/.test(c2.badge || '') && /could not be reached/.test(c2.text) && c2.retry,
      J({ badge: c2.badge, text: c2.text }));
    MODE = 'ok';
    await press(p, `#mn-health-card-${R.flatline} button[onclick^="HealthGlance.retry"]`);
    check('Try again, with the datastore back, answers',
      await waitTrue(p, id => /Watch/.test((document.querySelector(`#mn-health-card-${id} .hg-badge`) || {}).textContent || ''), R.flatline));
    await press(p, '#help-panel .dock-tab[data-dock="map-display"]');
    await p.waitForTimeout(300);
    await press(p, '#dock-pane-map-display button[onclick^="HealthGlance.askAgain"]');
    const followed = await waitTrue(p, id => HealthGlance._state().net.status === 'ok'
      && (state.mapMarkers.find(x => x.mnStationId === id) || {}).mnHealth === 'fault', R.silent);
    check('…and ↻ Ask again in the note asks the network once more, and the pins follow', followed && count('network') === 2, `${count('network')}`);
    await ctx.close();
  }

  // ── 7. A phone ────────────────────────────────────────────────────────
  log('\n7. On a phone\n');
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 760 }, timezoneId: 'Australia/Brisbane', isMobile: true, hasTouch: true });
    const p = await open(ctx);
    await loaded(p, '/index.html?tab=stations');
    await toStations(p);
    await p.evaluate(id => showStationCard(id, { takeFocus: true }), R.falling);
    await waitTrue(p, id => { const el = document.getElementById('mn-health-card-' + id); return el && el.querySelector('.hg-badge'); }, R.falling);
    const narrow = await p.evaluate(id => {
      const el = document.getElementById('mn-health-card-' + id);
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      const d = document.documentElement;
      const wide = [...el.querySelectorAll('*')].filter(n => n.getBoundingClientRect().right > innerWidth + 1).length;
      return { scroll: d.scrollWidth, client: d.clientWidth, right: r.right, w: innerWidth, wide };
    }, R.falling);
    check('the card’s health lines fit a 375 px screen, nothing pushed sideways',
      !narrow.missing && narrow.scroll <= narrow.client + 1 && narrow.right <= narrow.w + 1 && narrow.wide === 0, J(narrow));
    await ctx.close();
  }

  check('nothing threw for the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter(r => !r.ok);
log(`\n  ${results.length} assertion(s).`);
if (failed.length) {
  log(`\nFAIL — ${failed.length} of them:\n`);
  for (const f of failed) log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
  process.exit(1);
}
log('\nPASS — a station’s card says when it was last heard and what is wrong with it, each line opens\n'
  + '       Station Health on it, and the map colours every station by health for one request a load.');
