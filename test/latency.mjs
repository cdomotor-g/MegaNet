// ⏱️ Latency (map-latency.js): the Stations map's pins coloured by how fresh
// each station's data is, and the pane beside the map that sums it up and,
// for a picked station, shows its checks slot by slot. Driven in Chromium with
// the datastore stood in for by test/lib/postgrest-stub.mjs — the strict
// PostgREST the agent API is held to — serving HealthAnalysis's demo week
// (real stations, one of every fault planted) and the station_health rows the
// ingest would have written for it.
//
//   1. **The rules** — the bands' edges for age, delay and checks; a negative
//      delay (a receiver's clock running ahead) is not late; the median and
//      the 95th percentile; a delay said short.
//   2. **Off until asked for** — no pin wears a band and no reading is fetched
//      for it on a first visit to the Stations tab.
//   3. **Opening the tool** — ⏱️ in the side panel's strip, after 🔑: the first
//      press that opens it turns the view on (a pane the side panel puts back
//      as the page loads does not, 6b); every pin a band or said otherwise (never
//      heard hollow in a dotted ring, a gauge read by hand left grey); the
//      shape and the Bureau's outline untouched; the readings fetched once;
//      the pane's summary counting what the pins say.
//   4. **Delay and checks** — a station whose uploads queue four minutes is
//      in the 2 – 5 min band and the rest under 10 s; one silent through the
//      window hollow in its ring; over the whole week, the planted fading
//      station misses more of its checks than a steady one; a rebuild of the
//      map fetches nothing again.
//   5. **One station** — picked in the pane: on the map with its card, and in
//      the pane its tiles, its checks slot by slot with the misses listed, its
//      delay dot by dot and the receiver that carried it; the pane follows the
//      card to another station and back to the summary when the card shuts.
//   5b. **Messages landing** — the first opening ticked the animation too and
//      the log is asked for what landed since (`received_at=gt.`, oldest
//      first); a message landing flares its station green on the pulse canvas
//      and runs a leg along its drawn link to its repeater, which flares as the
//      leg ends — assumed, signed out, so blue; a typed-in reading is not
//      played and an address no station carries is counted, not drawn;
//      unticked, the log is not asked and the colours stay; ⏻ turns the
//      colours and the animation off together and on again, the focus kept on
//      it; the view turned on from all off brings the animation back; ⏱️ in
//      the strip beating green behind its icon while the animation is on; and
//      once the pulse has played, the station still glowing green and its
//      link blue on the canvas, for a minute — and going with the station when
//      it is moved, the spot it left clear.
//   5c. **Which way it came** — the receivers' copies laid in (_hear): a
//      repeater's carrier found in a receiver's window of bursts from the
//      stations only it passes; a station's burst on its own carrier heard
//      direct — its hop to the base station green, its link to that repeater
//      red for exactly as long, no blue — and on the repeater's carrier the
//      way to the repeater blue, the repeater heard, its hop to the base
//      station green; red read off the canvas, dotted, while the green runs and
//      in the afterglow; a message no copy matches all blue; signed out, the
//      card says every hop is blue and why, and the receptions are not asked.
//   6. **One colouring at a time** — Colour pins by health turns latency off,
//      and latency turns health off; the 🔑 legend carries whichever is on.
//   7. **No data, honestly** — a datastore that cannot be reached: the pane
//      says so and offers to try again, and nothing throws.
//
// Run:  npm run latency
//       npm run latency -- -v

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

const DB = 'https://jjprlritvhdqpvphfrnu.supabase.co/rest/v1';
const READING_COLS = ['addr', 'alert_id', 'a2_station', 'a2_sensor', 'station_number', 'channel', 'station_id',
  'reading_ts', 'received_at', 'value_raw', 'value', 'unit', 'conversion', 'quality', 'protocol', 'source', 'path',
  'dup_count', 'dup_paths', 'last_dup_at', 'raw_id', 'ingest_token_id', 'freq_mhz', 'rssi_dbm', 'level_dbfs', 'snr_db'];
const HEALTH_COLS = ['station_key', 'station_id', 'station_name', 'online', 'since', 'last_seen_at', 'last_reading_at',
  'minutes_since_seen', 'minutes_since_reading', 'last_status', 'reported_by', 'updated_at'];

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

let asked = [];
const paths = [];      // every relation the page asked the datastore for
const count = kind => asked.filter(a => a.kind === kind).length;
let MODE = 'ok';
let stub = null;

async function standIn(page) {
  await page.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = req.url();
    const rel = new URL(url).pathname.replace(/^.*\/rest\/v1\//, '');
    paths.push(rel);
    if (rel !== 'reading' && rel !== 'station_health') return route.fallback();
    // The last-heard batch; a card's readings; the window's pages.
    const kind = rel === 'station_health' ? 'network'
      : /[?&]received_at=gt\./.test(url) ? 'live'
      : /[?&]or=/.test(url) || /[?&]station_id=eq\./.test(url) ? 'card' : 'window';
    asked.push({ kind, url: decodeURIComponent(url) });
    if (MODE === 'down') return route.abort('connectionrefused');
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
async function loaded(page) {
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
}
async function toStations(page) {
  await page.evaluate(() => { if (state.activeTab !== 'stations') switchTab('stations'); });
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: LOAD_TIMEOUT });
}
const waitTrue = (page, fn, arg, timeout = 20_000) =>
  page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const settled = page => waitTrue(page, () => MapLatency._state().window.status === 'ok' || MapLatency._state().window.status === 'error', null, 60_000);

// What a pin is wearing, the canvas having no DOM to ask. `grow` is how many
// pixels the view added to the radius the pin would have had without it — a
// triangle is drawn round a circle 1.4 times its size (MapSymbols.radius), so
// two radii are only comparable through it.
const pin = (page, id) => page.evaluate(id => {
  const m = state.mapMarkers.find(x => x.mnStationId === id);
  if (!m) return null;
  const base = m.mnStation.roles.includes('repeater') ? MAP_PIN_R_RPT : MAP_PIN_R_FIELD;
  let grow = null;
  for (let g = -2; g <= 6; g++) if (MapSymbols.radius(Math.max(3, base + g), m.mnSymbol) === m.options.radius) { grow = g; break; }
  return { band: m.mnLatency, health: m.mnHealth, fill: m.options.fillColor, ring: m.options.color,
           dash: m.options.dashArray, shape: m.options.mnShape, outline: m.options.mnOutline || null,
           r: m.options.radius, grow };
}, id);

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Australia/Brisbane' });
  const page = await open(context);
  await loaded(page);

  // The demo week, ending now, with one station's uploads made to queue four
  // minutes; and stations the week does not touch, for the hollow and the grey.
  const W = await page.evaluate(() => {
    const w = HealthAnalysis.demoWorld(undefined, { now: Date.now() });
    const idx = SensorValues.index();
    const whose = aid => { const c = idx.get(aid) || []; return c.length === 1 ? c[0].station.id : null; };
    w.rows.forEach(r => {
      if (whose(r.alert_id) === w.roles.steady3) r.received_at = new Date(Date.parse(r.reading_ts) + 240e3).toISOString();
    });
    const last = {}, first = {};
    w.rows.forEach(r => {
      const id = whose(r.alert_id);
      if (!id) return;
      if (!last[id] || last[id] < r.reading_ts) last[id] = r.reading_ts;
      if (!first[id] || first[id] > r.reading_ts) first[id] = r.reading_ts;
    });
    const roles = new Set(Object.values(w.roles).filter(v => typeof v === 'string'));
    const placedField = s => s.lat != null && s.lon != null && !s.proposed && (s.roles || []).includes('field')
      && MapSymbols.ownerDrawn(s);
    const never = state.data.stations.find(s => placedField(s) && !roles.has(s.id) && stationAlertIds(s).length
      && !MapSymbols.kind(s).manual && !MapSymbols.kind(s).tm);
    const manual = state.data.stations.find(s => placedField(s) && !roles.has(s.id) && MapSymbols.kind(s).manual);
    return { rows: w.rows, roles: w.roles, last, first, never: never && never.id, manual: manual ? manual.id : null };
  });
  const R = W.roles;
  const healthRows = Object.entries(W.last).map(([id, t]) => ({
    station_key: id, station_id: id, station_name: null, online: null, since: W.first[id],
    last_seen_at: t, last_reading_at: t, minutes_since_seen: 0, minutes_since_reading: 0,
    last_status: {}, reported_by: null, updated_at: t,
  }));
  stub = new PostgrestStub({
    base: DB,
    columns: { reading: new Set(READING_COLS), station_health: new Set(HEALTH_COLS) },
    tables: { reading: W.rows, station_health: healthRows },
  });
  vlog(`  the week: ${W.rows.length} readings; ${healthRows.length} station_health rows; roles ${J(R)}`);

  // ── 1. The rules ──────────────────────────────────────────────────────
  log('\n1. The bands\n');
  const rules = await page.evaluate(() => {
    const M = 60e3, H = 3600e3, D = 86400e3, k = (m, v) => MapLatency.classifyValue(m, v).k;
    return {
      age: [k('age', 15 * M), k('age', 15 * M + 1), k('age', H), k('age', 3 * H + 1), k('age', D), k('age', 7 * D + 1)],
      delay: [k('delay', -3), k('delay', 10), k('delay', 52), k('delay', 61), k('delay', 240), k('delay', 4000)],
      checks: [k('checks', 0), k('checks', 0.05), k('checks', 0.2), k('checks', 0.3), k('checks', 0.9)],
      q: [MapLatency.quantile([4, 1, 3, 2], 0.5), MapLatency.quantile([1, 2, 3, 4, 100], 0.95), MapLatency.quantile([], 0.5)],
      f: [MapLatency.fmtDelay(1.64), MapLatency.fmtDelay(52.2), MapLatency.fmtDelay(270), MapLatency.fmtDelay(7600)],
    };
  });
  check('age: 15 min and under is the freshest band, a minute more the next; an hour, three, a day and a week are edges',
    J(rules.age) === J(['a0', 'a1', 'a1', 'a3', 'a4', 'a6']), J(rules.age));
  check('delay: a clock running ahead is not late; 10 s, a minute, five and thirty are edges',
    J(rules.delay) === J(['d0', 'd0', 'd1', 'd2', 'd3', 'd5']), J(rules.delay));
  check('checks: none missed, under 10%, to a quarter, to half, more than half',
    J(rules.checks) === J(['c0', 'c1', 'c2', 'c3', 'c4']), J(rules.checks));
  check('the median interpolates, the 95th percentile is not the maximum, nothing is null',
    rules.q[0] === 2.5 && rules.q[1] > 4 && rules.q[1] < 100 && rules.q[2] === null, J(rules.q));
  check('a delay said short: 1.6 s, 52 s, 4.5 min, 2.1 h', J(rules.f) === J(['1.6 s', '52 s', '4.5 min', '2.1 h']), J(rules.f));

  // ── 2. Off until asked for ────────────────────────────────────────────
  log('\n2. Off until it is asked for\n');
  await toStations(page);
  await waitTrue(page, () => HealthGlance._state().net.status === 'ok');
  await page.waitForTimeout(300);
  const off0 = await page.evaluate(() => ({
    on: MapLatency.on(), tagged: state.mapMarkers.filter(m => m.mnLatency).length,
    strip: [...document.querySelectorAll('#help-panel .dock-strip .dock-tab')].map(b => b.dataset.dock),
  }));
  check('off on a first visit: no pin wears a band, and no reading is fetched for it',
    off0.on === false && off0.tagged === 0 && count('window') === 0, J({ off0, window: count('window') }));
  check('…and no message animated: the log is not watched',
    !(await page.evaluate(() => MapLatency.anim())) && count('live') === 0, J({ live: count('live') }));
  check('⏱️ stands in the strip after 🔑, among what the map shows',
    off0.strip.indexOf('map-latency') === off0.strip.indexOf('map-legend') + 1, J(off0.strip));

  // ── 3. Opening the tool ───────────────────────────────────────────────
  log('\n3. Opening ⏱️ Latency\n');
  await page.click('#help-panel .dock-tab[data-dock="map-latency"]');
  check('the first opening turns the view on', await waitTrue(page, () => MapLatency.on()));
  const anim0 = await waitTrue(page, () => MapLatency.anim() && MapLatency._live().status === 'ok' && MapLatency._live().watching);
  const live0 = await page.evaluate(() => ({
    box: (document.querySelector('#map-latency-panel input[data-lat-f="anim"]') || {}).checked,
    power: (document.querySelector('#map-latency-panel .lat-power') || {}).getAttribute?.('aria-pressed'),
    status: (document.getElementById('lat-live-status') || {}).textContent || '',
    legend: /Flashing green/.test(document.getElementById('map-legend').textContent),
    strip: (() => { const b = document.querySelector('#help-panel .dock-tab[data-dock="map-latency"] .rail-ico');
                    return { root: document.documentElement.hasAttribute('data-lat-anim'), beat: getComputedStyle(b, '::after').animationName }; })(),
  }));
  check('…and the message animation with it: its box ticked, ⏻ pressed, the 🔑 legend saying what a green flash is',
    anim0 && live0.box === true && live0.power === 'true' && live0.legend && /Asked at/.test(live0.status), J(live0));
  check('…and ⏱️ in the rail rings green round its picture while it does, to the card\'s node\'s beat',
    live0.strip.root && live0.strip.beat === 'lat-rail-ring', J(live0.strip));
  check('…the log asked for what has landed since, oldest first, a page at most, with the columns a station is found by',
    count('live') >= 1 && asked.filter(a => a.kind === 'live').every(a => /order=received_at\.asc/.test(a.url)
      && /limit=1000/.test(a.url) && /select=addr,alert_id,.*received_at,source,path/.test(a.url)),
    J(asked.filter(a => a.kind === 'live').map(a => a.url.replace(/^.*\?/, '')).slice(0, 2)));
  await settled(page);
  await waitTrue(page, () => state.mapMarkers.some(m => m.mnLatency));
  const steady = await pin(page, R.steady);
  const silent = await pin(page, R.silent);
  const never = W.never ? await pin(page, W.never) : null;
  check('a station heard minutes ago is in a fresh band, in that band\'s green',
    steady && ['a0', 'a1'].includes(steady.band) && /^#(1a7f37|57a83a)$/i.test(steady.fill), J(steady));
  check('the silent station, last heard a day and a half ago, is in 1 – 7 days and a step bigger',
    silent && silent.band === 'a5' && silent.grow > steady.grow, J({ silent, steady }));
  check('a radio station nobody has heard is hollow in a dotted ring, a step smaller',
    never && never.band === 'never' && never.fill === '#ffffff' && /1,3/.test(String(never.dash)), J(never));
  if (W.manual) {
    const man = await pin(page, W.manual);
    check('a gauge read by hand keeps its grey: its silence is not latency',
      man && !man.band && man.fill === (await page.evaluate(() => MapSymbols.MANUAL)), J(man));
  }
  const shapes = await page.evaluate(() => state.mapMarkers.filter(m => m.mnLatency)
    .every(m => m.options.mnShape === (m.mnSymbol.triangle ? 'triangle' : 'circle') && (m.options.mnOutline || null) === (m.mnSymbol.outline || null)));
  check('every pin keeps its shape and the Bureau\'s outline under the colour', shapes);
  const sum = await page.evaluate(() => {
    MapLatency.setScope('all');
    const el = document.getElementById('map-latency-panel');
    const bars = [...el.querySelectorAll('.lat-bar')].map(b => ({ label: b.querySelector('.lat-bar-label').textContent, n: Number(b.querySelector('.lat-bar-n').textContent.replace(/,/g, '')) }));
    const drawn = state.data.stations.filter(s => s.lat != null && s.lon != null && !s.proposed && MapSymbols.ownerDrawn(s)).length;
    const pinsBand = state.mapMarkers.filter(m => m.mnLatency && /^a\d$/.test(m.mnLatency)).length;
    return { head: el.querySelector('#lat-h-sum').textContent, bars, drawn, pinsBand,
             tiles: [...el.querySelectorAll('.adm-kpi-label')].map(x => x.textContent.trim()),
             shown: !!el.getClientRects().length, checked: el.querySelector('input[type=checkbox]').checked };
  });
  const banded = sum.bars.filter(b => !/never|hand/.test(b.label)).reduce((a, b) => a + b.n, 0);
  check('the pane is on screen, its switch on, with the four tiles',
    sum.shown && sum.checked && J(sum.tiles) === J(['Heard in the last hour', 'Quiet over a day', 'Delay to the database', 'Checks received']), J(sum));
  check('the whole map\'s rows add up to every station drawn, and its bands to the pins that wear one',
    sum.bars.reduce((a, b) => a + b.n, 0) === sum.drawn && banded === sum.pinsBand, J({ sum, banded }));
  const fetched = count('window');
  check('the readings were fetched for it — the window, paged, with the columns the analysis reads',
    fetched > 0 && asked.filter(a => a.kind === 'window').every(a => /select=addr,alert_id,.*received_at/.test(a.url) && !/rssi_dbm/.test(a.url)),
    J({ fetched }));

  // ── 4. Delay and checks ───────────────────────────────────────────────
  log('\n4. Delay and checks\n');
  await page.evaluate(() => MapLatency.setMode('delay'));
  await waitTrue(page, id => { const m = state.mapMarkers.find(x => x.mnStationId === id); return m && /^d/.test(m.mnLatency || ''); }, R.steady);
  const d = { steady: await pin(page, R.steady), queued: await pin(page, R.steady3), silent: await pin(page, R.silent) };
  check('delay: readings landing in 5.3 s are under 10 s; the station whose uploads queue four minutes is 2 – 5 min',
    d.steady.band === 'd0' && d.queued.band === 'd3' && d.queued.grow > d.steady.grow, J(d));
  check('…and the station silent through the last 24 h is hollow in a maroon ring, not given a delay',
    d.silent.band === 'quiet' && d.silent.fill === '#ffffff' && /^#6b1717$/i.test(d.silent.ring), J(d.silent));
  check('changing what the pins say fetched nothing again', count('window') === fetched, J({ before: fetched, after: count('window') }));
  await page.evaluate(() => { MapLatency.setWin('7d'); MapLatency.setMode('checks'); });
  await settled(page);
  await waitTrue(page, () => MapLatency._state().window.key === '7d' && MapLatency._state().window.status === 'ok');
  await waitTrue(page, id => { const m = state.mapMarkers.find(x => x.mnStationId === id); return m && /^c/.test(m.mnLatency || ''); }, R.steady);
  const c = await page.evaluate(R => {
    const of = id => { const x = MapLatency.classOf(id); return x && { k: x.key, rate: x.value, ch: x.st && x.st.checks }; };
    return { steady: of(R.steady), fading: of(R.fading), silent: of(R.silent) };
  }, R);
  check('checks over the week: the fading station misses more than the steady one, and is in a worse band',
    c.fading && c.steady && c.fading.rate > c.steady.rate && c.fading.k > c.steady.k && c.steady.k <= 'c1', J(c));
  const w7 = count('window');
  check('a week is fetched as a week — more pages than the day', w7 > fetched, J({ day: fetched, week: w7 - fetched }));
  await page.evaluate(() => refreshMapLayers({ skipFit: true }));
  await page.waitForTimeout(300);
  check('a rebuild of the map inside the window\'s lifetime fetches nothing', count('window') === w7, J({ w7, now: count('window') }));

  // ── 5. One station ────────────────────────────────────────────────────
  log('\n5. One station, picked\n');
  await page.evaluate(id => MapLatency.focus(id), R.fading);
  await page.waitForTimeout(300);
  const one = await page.evaluate(id => {
    const el = document.getElementById('map-latency-panel');
    const strip = el.querySelector('svg.lat-strip');
    const s = state.data.stations.find(x => x.id === id);
    return {
      card: state.stnCard.id, head: (el.querySelector('#lat-h-stn') || {}).textContent, name: s.name,
      focus: document.activeElement && document.activeElement.id,
      tiles: [...el.querySelectorAll('.adm-kpi-label')].map(x => x.textContent.trim()),
      slots: strip ? strip.querySelectorAll('rect.hl-slot').length : 0,
      misses: strip ? strip.querySelectorAll('rect.hl-slot--miss').length : 0,
      stripName: strip ? strip.getAttribute('aria-label') : '',
      missed: (el.querySelector('.lat-missed') || {}).textContent || '',
      dots: !!el.querySelector('svg.lat-delay path.lat-dots'),
      rx: [...el.querySelectorAll('.lat-table tbody tr td:first-child')].map(td => td.textContent.trim()),
    };
  }, R.fading);
  check('a station pressed in the pane is on the map with its card, and the pane is about it, focus on its name',
    one.card === R.fading && one.head === one.name && one.focus === 'lat-h-stn', J(one));
  check('…its tiles: last heard, delay, checks received and the next check',
    J(one.tiles) === J(['Last heard', 'Delay', 'Checks received', 'Next check']), J(one.tiles));
  check('…its checks slot by slot, the misses drawn and named, the picture saying the counts',
    one.slots > 40 && one.misses > 0 && /missed/.test(one.stripName) && /Missed while a receiver/.test(one.missed), J(one));
  check('…its delay dot by dot, and the receiver that carried it', one.dots && one.rx.some(r => /demo-pi-sdr1/.test(r)), J(one.rx));
  await page.evaluate(id => showStationCard(id), R.steady);
  await page.waitForTimeout(150);
  const followed = await page.evaluate(() => (document.querySelector('#map-latency-panel #lat-h-stn') || {}).textContent);
  const steadyName = await page.evaluate(id => state.data.stations.find(s => s.id === id).name, R.steady);
  check('the pane follows the card to another station', followed === steadyName, J({ followed, steadyName }));
  await page.evaluate(() => closeStnCard());
  await page.waitForTimeout(150);
  check('…and goes back to the summary when the card shuts',
    await page.evaluate(() => !!document.querySelector('#map-latency-panel #lat-h-sum') && MapLatency._state().sel === null));

  // ── 5b. Messages landing ──────────────────────────────────────────────
  log('\n5b. Messages landing\n');
  // A field station with a link drawn to its repeater, an address of its own,
  // and another station with a pin, for a reading typed in.
  const pick = await page.evaluate(() => {
    const idx = SensorValues.index();
    const own = id => { const s = state.data.stations.find(x => x.id === id); return s && stationAlertIds(s).find(a => (idx.get(a) || []).length === 1); };
    const l = state.mapLines.find(x => x.mnLinkRole === 'core' && x.mnArrowDir && own(x.mnLinkStationId) != null
      && state.mapMarkers.some(m => m.mnStationId === x.mnLinkStationId));
    if (!l) return null;
    const other = state.mapMarkers.find(m => m.mnStationId !== l.mnLinkStationId && own(m.mnStationId) != null);
    const s = state.data.stations.find(x => x.id === l.mnLinkStationId);
    state.map.setView([s.lat, s.lon], 11, { animate: false });
    return { id: s.id, aid: own(s.id), rpt: l.mnLinkRepeaterId, other: other.mnStationId, oaid: own(other.mnStationId) };
  });
  check('a field station with its own address and a link drawn to its repeater, to land a message from', !!pick, J(pick));
  if (pick) {
    const newest = stub.tables.reading.reduce((a, r) => (r.received_at > a ? r.received_at : a), '');
    const at = new Date(Math.max(Date.now(), Date.parse(newest)) + 2000);
    const row = (aid, sid, source) => Object.assign({}, W.rows[0], {
      addr: 'a:' + aid, alert_id: aid, a2_station: null, a2_sensor: null, station_number: null, channel: '',
      station_id: sid, reading_ts: new Date(at - 1500).toISOString(), received_at: at.toISOString(),
      value_raw: 7, source, path: 'serial-monitor/demo-pi-sdr1', dup_count: 0, dup_paths: null,
    });
    stub.tables.reading.push(row(pick.aid, pick.id, 5), row(pick.oaid, pick.other, 3), row(64999, null, 5));
    const liveBefore = count('live');
    const got = await page.evaluate(async id => {
      await new Promise(r => setTimeout(r, 400));   // the map settled where it was put
      const n0 = MapLatency._live().firedN;
      await MapLatency._askNow();
      const t0 = performance.now();
      while (!MapLatency._live().fired.slice(-(MapLatency._live().firedN - n0) || 1e9).includes(id) && performance.now() - t0 < 4000) {
        await new Promise(r => setTimeout(r, 15));
      }
      const live = MapLatency._live();
      const fresh = live.fired.slice(live.fired.length - (live.firedN - n0));
      await new Promise(r => setTimeout(r, 140));     // past the flare's peak, before it fades
      const cv = document.querySelector('.lat-pulse-canvas');
      const s = state.data.stations.find(x => x.id === id);
      const m = state.mapMarkers.find(x => x.mnStationId === id);
      const p = state.map.latLngToContainerPoint([s.lat, s.lon]);
      const dpr = window.devicePixelRatio || 1;
      const px = (dx, dy) => Array.from(cv.getContext('2d').getImageData(Math.round((p.x + dx) * dpr), Math.round((p.y + dy) * dpr), 1, 1).data);
      const sz = 2 * m.options.radius + 2;
      return { fresh, batch: live.batches[live.batches.length - 1], pulses: live.pulses,
               centre: px(0, 0), halo: px(sz, 0), route: MapLatency._route(id),
               pane: getComputedStyle(cv.parentNode).pointerEvents, z: cv.parentNode.style.zIndex,
               status: document.getElementById('lat-live-status').textContent.replace(/\s+/g, ' ') };
    }, pick.id);
    check('the log asked once more, for what landed after the newest it had seen',
      count('live') >= liveBefore + 1 && /received_at=gt\./.test(asked.filter(a => a.kind === 'live').pop().url), J({ before: liveBefore, now: count('live') }));
    check('the message plays: its station flares — white-hot at the core, green round it — on a canvas over the pins that takes no clicks',
      got.fresh.includes(pick.id) && got.centre[3] > 120 && got.halo[3] > 0 && got.halo[1] > got.halo[0] + 40
        && got.pane === 'none' && got.z === '407', J({ fresh: got.fresh, centre: got.centre, halo: got.halo, pane: got.pane, z: got.z }));
    check('…and runs along its link to the repeater, which flares as the leg lands on it — blue, assumed: nothing heard says so',
      got.route && got.route.legs.length >= 1 && got.route.legs[0].to === pick.rpt && got.route.legs[0].start === 0
        && got.route.nodes.some(n => n.id === pick.rpt && n.start === got.route.legs[0].dur) && got.route.nodes[0].id === pick.id
        && got.route.legs.every(l => l.kind === 'assumed') && !got.route.proved && got.route.nodes[0].kind === 'heard',
      J(got.route));
    check('a reading typed in is not played, and an address no station carries is counted, not drawn',
      !got.fresh.includes(pick.other) && got.batch && got.batch.n === 2 && got.batch.lost === 1, J({ fresh: got.fresh, batch: got.batch }));
    check('the card counts what landed', /message/.test(got.status) && /not on the map/.test(got.status), got.status);
    const guess = await page.evaluate(() => {
      const g = document.querySelector('#map-latency-panel .lat-live-guess');
      const bad = getComputedStyle(document.documentElement).getPropertyValue('--bad').trim();
      const probe = document.createElement('span'); probe.style.color = bad; document.body.appendChild(probe);
      const want = getComputedStyle(probe).color; probe.remove();
      return g && { text: g.textContent.replace(/\s+/g, ' '), colour: getComputedStyle(g).color, want };
    });
    check('…and says, in the red the app warns in, that the way it runs is the likeliest, not a record',
      guess && /likeliest way in, not a record of the hops/.test(guess.text) && guess.colour === guess.want, J(guess));
    const glow = await page.evaluate(async id => {
      const t0 = performance.now();
      while (!MapLatency._live().glowing.includes(id) && performance.now() - t0 < 6000) await new Promise(r => setTimeout(r, 25));
      await new Promise(r => setTimeout(r, 700));     // up past GLOW_IN, the canvas drawn at its slower beat
      const cv = document.querySelector('.lat-pulse-canvas');
      const dpr = window.devicePixelRatio || 1;
      const s = state.data.stations.find(x => x.id === id);
      const m = state.mapMarkers.find(x => x.mnStationId === id);
      const l = state.mapLines.find(x => x.mnLinkRole === 'core' && x.mnLinkStationId === id);
      const p = state.map.latLngToContainerPoint([s.lat, s.lon]);
      const q = state.map.latLngToContainerPoint(l.getLatLngs()[1]);
      const px = (x, y) => Array.from(cv.getContext('2d').getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data);
      const R = m.options.radius + 3;
      // A stretch of the link, not a point: an assumed hop glows dashed.
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const link = [];
      for (let d = R + 10; d <= R + 30; d += 2) link.push(px(p.x + (q.x - p.x) * d / len, p.y + (q.y - p.y) * d / len));
      return { glowing: MapLatency._live().glowing.includes(id), anim: MapLatency._live().pulses,
               ring: px(p.x + R, p.y), inside: px(p.x, p.y), link };
    }, pick.id);
    const green = c => c[3] > 60 && c[1] > c[0] + 60 && c[1] > c[2];
    const blue = c => c[3] > 60 && c[2] > c[0] + 60 && c[2] > c[1];
    check('once the pulse has played, its station keeps a green ring — the pin inside it left clear — and its link a blue glow',
      glow.glowing && green(glow.ring) && glow.inside[3] < 40 && glow.link.some(blue) && !glow.link.some(green), J(glow));
    // Moved while it glows — Move pin's save rebuilds the map with the station
    // somewhere else: the ring and the link's glow go with the pin, and the
    // spot it left is clear. Across the link, so the new one misses the old spot.
    const moved = await page.evaluate(async id => {
      const s = state.data.stations.find(x => x.id === id);
      const was = [s.lat, s.lon];
      const cv = document.querySelector('.lat-pulse-canvas');
      const dpr = window.devicePixelRatio || 1;
      const px = (x, y) => Array.from(cv.getContext('2d').getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data);
      const p0 = state.map.latLngToContainerPoint(was);
      const q = state.map.latLngToContainerPoint(state.mapLines.find(x => x.mnLinkRole === 'core' && x.mnLinkStationId === id).getLatLngs()[1]);
      const d = Math.hypot(q.x - p0.x, q.y - p0.y) || 1;
      const to = state.map.containerPointToLatLng([p0.x - 50 * (q.y - p0.y) / d, p0.y + 50 * (q.x - p0.x) / d]);
      s.lat = to.lat; s.lon = to.lng;
      refreshMapLayers({ skipFit: true });
      await new Promise(r => setTimeout(r, 400));     // a glow beat past the rebuild
      const m = state.mapMarkers.find(x => x.mnStationId === id);
      const p = state.map.latLngToContainerPoint([s.lat, s.lon]);
      const R = m.options.radius + 3;
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const link = [];
      for (let d = R + 10; d <= R + 30; d += 2) link.push(px(p.x + (q.x - p.x) * d / len, p.y + (q.y - p.y) * d / len));
      const out = { ring: px(p.x + R, p.y), old: px(p0.x + R, p0.y), oldOther: px(p0.x - R, p0.y), link };
      s.lat = was[0]; s.lon = was[1];
      refreshMapLayers({ skipFit: true });
      return out;
    }, pick.id);
    check('…and a station moved while it glows takes its ring and its link\'s glow with it, leaving the old spot clear',
      green(moved.ring) && moved.link.some(blue) && moved.old[3] < 40 && moved.oldOther[3] < 40, J(moved));
    check('…held, then faded: a minute after the animation ends', got.route && got.route.life - got.route.anim === 60000,
      J(got.route && { anim: got.route.anim, life: got.route.life }));
  }
  const liveOn = count('live');
  const off1 = await page.evaluate(async () => {
    MapLatency.setAnim(false);
    await new Promise(r => setTimeout(r, 50));
    const n = MapLatency._live();
    await MapLatency._askNow();
    return { anim: MapLatency.anim(), on: MapLatency.on(), watching: n.watching, status: n.status, pulses: n.pulses,
             stored: localStorage.getItem('mn-latency-anim'),
             strip: document.documentElement.hasAttribute('data-lat-anim')
               || getComputedStyle(document.querySelector('#help-panel .dock-tab[data-dock="map-latency"] .rail-ico'), '::after').content !== 'none',
             legend: /Flashing green/.test(document.getElementById('map-legend').textContent),
             card: document.getElementById('lat-live-status').textContent,
             banded: state.mapMarkers.filter(m => m.mnLatency).length };
  });
  check('unticked, the log is not watched or asked, nothing runs, the legend drops it — and the pins keep their colours',
    !off1.anim && off1.on && !off1.watching && off1.status === 'idle' && off1.pulses === 0 && off1.stored === 'off'
      && !off1.legend && /Off/.test(off1.card) && off1.banded > 0 && count('live') === liveOn, J({ off1, liveOn, now: count('live') }));
  check('…and ⏱️ in the strip stops glowing', off1.strip === false, J(off1.strip));
  await page.click('#map-latency-panel .lat-power');
  await page.waitForTimeout(300);
  const pw0 = await page.evaluate(() => ({ on: MapLatency.on(), anim: MapLatency.anim(),
    banded: state.mapMarkers.filter(m => m.mnLatency).length,
    pressed: document.querySelector('#map-latency-panel .lat-power').getAttribute('aria-pressed'),
    focus: document.activeElement && document.activeElement.dataset && document.activeElement.dataset.latF }));
  check('⏻ turns the whole view off — no pin wears a band, nothing animated — and keeps the focus',
    !pw0.on && !pw0.anim && pw0.banded === 0 && pw0.pressed === 'false' && pw0.focus === 'power', J(pw0));
  await page.click('#map-latency-panel .lat-power');
  await waitTrue(page, () => MapLatency._live().watching);
  const pw1 = await page.evaluate(() => ({ on: MapLatency.on(), anim: MapLatency.anim(), watching: MapLatency._live().watching,
    pressed: document.querySelector('#map-latency-panel .lat-power').getAttribute('aria-pressed'),
    word: document.querySelector('#map-latency-panel .lat-power-state').textContent }));
  check('…and on again: the pins coloured and the messages animated together',
    pw1.on && pw1.anim && pw1.watching && pw1.pressed === 'true' && pw1.word === 'On', J(pw1));
  const back1 = await page.evaluate(() => {
    MapLatency.setAnim(false); MapLatency.setOn(false);
    const off = !MapLatency.on() && !MapLatency.anim();
    MapLatency.setOn(true);
    return { off, on: MapLatency.on(), anim: MapLatency.anim() };
  });
  check('the colours turned on from all off bring the animation with them', back1.off && back1.on && back1.anim, J(back1));

  // ── 5c. Which way it came ─────────────────────────────────────────────
  log('\n5c. Which way it came: heard, assumed, missed\n');
  const signedOut = await page.evaluate(() => ({ rx: MapLatency._rx(),
    card: document.getElementById('lat-live-status').textContent.replace(/\s+/g, ' '),
    key: [...document.querySelectorAll('#map-latency-panel .lat-hop-key li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
    terms: [...document.querySelectorAll('#map-latency-panel .lat-hop-key .term')].map(t => [t.textContent, t.title]) }));
  check('signed out: the receivers\' copies are not asked for, and the card says every hop is blue and why',
    signedOut.rx.status === 'off' && !paths.includes('reception') && !paths.includes('ingest_point_latest')
      && /Every hop is blue/.test(signedOut.card) && /for editors/.test(signedOut.card), J(signedOut));
  check('the card keys the three kinds of hop, each word with its meaning on hover and in words beside it',
    signedOut.key.length === 3 && /^Heard — /.test(signedOut.key[0]) && /^Assumed — /.test(signedOut.key[1]) && /^Missed — /.test(signedOut.key[2])
      && signedOut.terms.length === 3 && signedOut.terms.every(([w, m]) => m.length > 40 && !m.startsWith(w)), J(signedOut.key));
  // A repeater whose pass ranges alone hold six field stations' addresses —
  // only it could relay them — one of them with its link to the repeater
  // drawn; and a base station on the map, where the receiver is.
  const way = await page.evaluate(() => {
    const reg = SignalRoutes.register();
    const onMap = id => state.mapMarkers.some(m => m.mnStationId === id);
    const drawn = new Set(state.mapLines.filter(l => l.mnLinkRole === 'core' && l.mnArrowDir)
      .map(l => l.mnLinkStationId + '>' + l.mnLinkRepeaterId));
    const only = new Map();
    for (const s of reg.list) {
      if (!(s.roles || []).includes('field') || s.lat == null) continue;
      const a = reg.idsOf(s).find(x => (reg.addrSt.get(x) || []).length === 1 && reg.cands(x).length === 1 && !reg.cands(x)[0].own);
      if (a == null) continue;
      const rid = reg.cands(a)[0].rid;
      if (!only.has(rid)) only.set(rid, []);
      only.get(rid).push({ st: s.id, a });
    }
    for (const [rid, list] of only) {
      if (list.length < 6 || !onMap(rid)) continue;
      const s = list.find(x => drawn.has(x.st + '>' + rid) && onMap(x.st));
      const base = state.data.stations.find(b => (b.roles || []).includes('base') && b.id !== rid && onMap(b.id));
      if (!s || !base) continue;
      // Close on the station and the repeater, so the link between them is
      // long enough to read; the base station may be off the edge.
      const at = id => { const x = state.data.stations.find(y => y.id === id); return [x.lat, x.lon]; };
      state.map.fitBounds([at(s.st), at(rid)], { padding: [120, 120], maxZoom: 15, animate: false });
      return { rid, st: s.st, a: s.a, others: list.filter(x => x !== s).slice(0, 5).map(x => x.a), base: base.id };
    }
    return null;
  });
  check('a repeater only it can relay six stations through, one linked to it on the map, and a base station', !!way, J(way));
  if (way) {
    const PT = { ingest_token_id: 99, point_id: 'demo-pi-sdr1', host_station_id: way.base };
    const now = Date.now();
    let id = 1000;
    const burst = (a, cfo, ago) => ({ id: id++, ingest_token_id: 99, point_id: 'demo-pi-sdr1', heard_at: new Date(now - ago).toISOString(),
      protocol: 'alert', alert_id: a, cfo_hz: cfo, a2_duplicate: false, a2_source: null, a2_path: null });
    // Its five other stations relayed on its carrier, twice each, over the hours before.
    const warm = way.others.flatMap((a, i) => [burst(a, 249 + i % 3, 3 * 3600e3 + i * 60e3), burst(a, 251 - i % 3, 2 * 3600e3 + i * 60e3)]);
    const heard = await page.evaluate(({ PT, warm, live, st, a, rid, base }) => {
      const fed = MapLatency._hear({ points: [PT], warm, live });
      return { fed, direct: MapLatency._route(st, { keys: ['a:' + a] }), none: MapLatency._route(st) };
    }, { PT, warm, live: [burst(way.a, 96, 2000)], st: way.st, a: way.a, rid: way.rid, base: way.base });
    const kept = heard.fed.kept.find(([pk]) => pk === '99|demo-pi-sdr1');
    check('the receiver\'s window finds the repeater\'s carrier, and the station\'s burst off it is its own',
      kept && kept[1].includes(way.rid) && heard.fed.how[0] && heard.fed.how[0].how === 'own', J(heard.fed));
    const d = heard.direct;
    const hop = d && d.legs.find(l => l.from === way.st && l.to === way.base);
    const miss = d && d.legs.find(l => l.from === way.st && l.to === way.rid);
    check('heard direct: its hop to the base station green, its link to the repeater red for exactly as long, nothing blue',
      d && d.proved && hop && hop.kind === 'heard' && miss && miss.kind === 'missed'
        && miss.start === hop.start && miss.dur === hop.dur && miss.tail === hop.tail
        && !d.legs.some(l => l.kind === 'assumed') && !d.nodes.some(n => n.id === way.rid)
        && d.nodes.some(n => n.id === way.base && n.kind === 'heard'), J(d));
    check('a message no copy matches runs the way the map draws, all of it blue',
      heard.none && !heard.none.proved && heard.none.legs.length >= 1 && heard.none.legs.every(l => l.kind === 'assumed'), J(heard.none));
    // Played, and read off the canvas: the red while the green runs, then both glowing.
    const red = c => c[3] > 60 && c[0] > c[1] + 80 && c[0] > c[2] + 80;
    const green = c => c[3] > 60 && c[1] > c[0] + 60 && c[1] > c[2];
    const seen = await page.evaluate(async ({ st, rid, base, a }) => {
      const cv = document.querySelector('.lat-pulse-canvas');
      const dpr = window.devicePixelRatio || 1;
      const px = (x, y) => Array.from(cv.getContext('2d').getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data);
      const pt = id => { const s = state.data.stations.find(x => x.id === id); return state.map.latLngToContainerPoint([s.lat, s.lon]); };
      // Along the middle of a link, a pixel at a time — a dotted line is
      // mostly gaps — and along the start of the hop to the base station,
      // clear of the station's own ring.
      const mid = (ia, ib) => {
        const p = pt(ia), q = pt(ib), out = [];
        for (let k = -8; k <= 8; k++) {
          const f = 0.5 + k / Math.max(40, Math.hypot(q.x - p.x, q.y - p.y));
          out.push(px(p.x + (q.x - p.x) * f, p.y + (q.y - p.y) * f));
        }
        return out;
      };
      const near = (ia, ib) => {
        const p = pt(ia), q = pt(ib), len = Math.hypot(q.x - p.x, q.y - p.y), out = [];
        for (let d = 30; d <= 46; d++) out.push(px(p.x + (q.x - p.x) * d / len, p.y + (q.y - p.y) * d / len));
        return out;
      };
      await new Promise(r => setTimeout(r, 300));
      MapLatency._fire(st, { keys: ['a:' + a] });
      await new Promise(r => setTimeout(r, 160));
      const running = { missed: mid(st, rid) };
      const t0 = performance.now();
      while (!MapLatency._live().glowing.includes(st) && performance.now() - t0 < 6000) await new Promise(r => setTimeout(r, 25));
      await new Promise(r => setTimeout(r, 700));
      return { running, after: { missed: mid(st, rid), heard: near(st, base) }, apart: Math.hypot(pt(rid).x - pt(st).x, pt(rid).y - pt(st).y) };
    }, way);
    check('on the canvas: the missed link lit red while the heard hop runs, and both glowing after — red, and green',
      seen.running.missed.some(red) && seen.after.missed.some(red) && seen.after.heard.some(green) && !seen.after.heard.some(red),
      J({ apart: seen.apart, running: seen.running.missed.filter(red).length, missed: seen.after.missed.filter(red).length, heard: seen.after.heard.filter(green).length }));
    const via = await page.evaluate(({ PT, warm, live, st, a }) => {
      MapLatency._hear({ points: [PT], warm, live });
      return MapLatency._route(st, { keys: ['a:' + a] });
    }, { PT, warm, live: [burst(way.a, 250, 2000)], st: way.st, a: way.a });
    const toRep = via && via.legs.find(l => l.from === way.st && l.to === way.rid);
    const fromRep = via && via.legs.find(l => l.from === way.rid && l.to === way.base);
    check('on the repeater\'s carrier: the way to the repeater blue, the repeater heard, its hop to the base station green, nothing red',
      via && via.proved && toRep && toRep.kind === 'assumed' && !toRep.straight && fromRep && fromRep.kind === 'heard'
        && fromRep.start === toRep.start + toRep.dur + 120 && via.nodes.some(n => n.id === way.rid && n.kind === 'heard')
        && !via.legs.some(l => l.kind === 'missed'), J(via));
    const card = await page.evaluate(() => document.getElementById('lat-live-status').textContent.replace(/\s+/g, ' '));
    check('…and the card says what the copies found', /1 repeater carrier found on 1 receiver over the last 12 h/.test(card), card);
    // A message landing before its copies: it waits for the next ask of them,
    // and plays then with what came.
    const newest = stub.tables.reading.reduce((x, r) => (r.received_at > x ? r.received_at : x), '');
    const at = new Date(Math.max(Date.now(), Date.parse(newest)) + 2000);
    stub.tables.reading.push(Object.assign({}, W.rows[0], {
      addr: 'a:' + way.a, alert_id: way.a, a2_station: null, a2_sensor: null, station_number: null, channel: '',
      station_id: way.st, reading_ts: new Date(at - 1500).toISOString(), received_at: at.toISOString(),
      value_raw: 9, source: 5, path: 'serial-monitor/demo-pi-sdr1', dup_count: 0, dup_paths: null,
    }));
    const wait = await page.evaluate(async ({ PT, warm, st }) => {
      MapLatency._hear({ points: [PT], warm });
      const n0 = MapLatency._live().firedN;
      await MapLatency._askNow();
      await new Promise(r => setTimeout(r, 300));
      const live = MapLatency._live();
      return { held: live.held, fired: live.fired.slice(live.fired.length - (live.firedN - n0)) };
    }, { PT, warm, st: way.st });
    const later = await page.evaluate(async ({ PT, warm, live, st }) => {
      MapLatency._hear({ points: [PT], warm, live });
      const n0 = MapLatency._live().firedN;
      await MapLatency._askNow();
      const t0 = performance.now();
      while (!MapLatency._live().fired.slice(-(MapLatency._live().firedN - n0) || 1e9).includes(st) && performance.now() - t0 < 4000) {
        await new Promise(r => setTimeout(r, 15));
      }
      const l = MapLatency._live();
      return { held: l.held, fired: l.fired.slice(l.fired.length - (l.firedN - n0)), rx: MapLatency._rx() };
    }, { PT, warm, live: [burst(way.a, 96, 1000)], st: way.st });
    check('a message whose copies are not in yet waits for the next ask of them, then plays with them',
      wait.held.includes(way.st) && !wait.fired.includes(way.st)
        && later.fired.includes(way.st) && !later.held.includes(way.st) && later.rx.played === 1 && later.rx.matched === 1,
      J({ wait, later }));
  }

  // ── 6. One colouring at a time ────────────────────────────────────────
  log('\n6. One colouring of the pins at a time\n');
  const legOn = await page.evaluate(() => document.getElementById('map-legend').textContent);
  check('the 🔑 legend carries the latency key in place of the roles while it is on',
    /Latency — how many of its timed checks went missing/.test(legOn) && !/Field Station/.test(legOn), legOn.slice(0, 160));
  await page.evaluate(() => HealthGlance.setPins(true));
  await page.waitForTimeout(400);
  const h = await page.evaluate(() => ({ lat: MapLatency.on(), health: state.mapHealth,
    latPins: state.mapMarkers.filter(m => m.mnLatency).length, stored: localStorage.getItem('mn-map-latency'),
    note: (document.getElementById('map-health-note') || {}).textContent || '' }));
  check('Colour pins by health turns latency off — no pin wears a band, and it is remembered off',
    !h.lat && h.health && h.latPins === 0 && h.stored === 'off', J(h));
  await page.evaluate(() => MapLatency.setOn(true));
  await page.waitForTimeout(400);
  const l = await page.evaluate(() => ({ lat: MapLatency.on(), health: state.mapHealth,
    healthPins: state.mapMarkers.filter(m => m.mnHealth).length, latPins: state.mapMarkers.filter(m => m.mnLatency).length,
    note: (document.getElementById('map-health-note') || {}).textContent || '',
    box: (document.querySelector('#map-display-block input[onchange^="HealthGlance.setPins"]') || {}).checked }));
  check('…and latency turns health off, its box unticked and its note saying where the colour went',
    l.lat && !l.health && l.healthPins === 0 && l.latPins > 0 && l.box === false && /latency/.test(l.note), J(l));
  await page.evaluate(() => MapLatency.setOn(false));
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({ tagged: state.mapMarkers.filter(m => m.mnLatency).length,
    roles: /Field Station/.test(document.getElementById('map-legend').textContent) }));
  check('switched off, the pins and the legend are back in their roles', back.tagged === 0 && back.roles, J(back));
  await page.evaluate(() => { setDockTab('stations', { instant: true }); });
  await page.click('#help-panel .dock-tab[data-dock="map-latency"]');
  await page.waitForTimeout(300);
  check('opening the pane again in the same session leaves a view turned off, off', await page.evaluate(() => !MapLatency.on()));

  // ── 6b. A pane put back as the page loads ────────────────────────────
  log('\n6b. The pane put back by a reload\n');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      try {
        if (sessionStorage.getItem('lat-seeded')) return;
        sessionStorage.setItem('lat-seeded', '1');
        localStorage.setItem('mn-help', 'expanded');
        localStorage.setItem('mn-dock-tab', 'map-latency');
        localStorage.setItem('mn-map-latency', 'off');
      } catch (_) {}
    });
    const p = await open(ctx);
    await loaded(p);
    await toStations(p);
    await p.waitForTimeout(600);
    const re = await p.evaluate(() => ({ showing: dockShowing(), on: MapLatency.on(), anim: MapLatency.anim(),
      pane: !!document.querySelector('#map-latency-panel #lat-h-sum') }));
    check('the side panel putting the pane back leaves a view stored off, off — only a press of ⏱️ turns it on',
      re.showing === 'map-latency' && re.pane && re.on === false && re.anim === false, J(re));
    await ctx.close();
  }

  // ── 7. No data, honestly ──────────────────────────────────────────────
  log('\n7. A datastore that cannot be reached\n');
  {
    MODE = 'down';
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await open(ctx);
    await loaded(p);
    await toStations(p);
    await p.click('#help-panel .dock-tab[data-dock="map-latency"]');
    await settled(p);
    await p.waitForTimeout(300);
    const down = await p.evaluate(() => ({
      status: MapLatency._state().window.status,
      text: document.getElementById('lat-status').textContent.replace(/\s+/g, ' '),
      retry: !!document.querySelector('#lat-status button[onclick="MapLatency.refresh()"]'),
      banded: state.mapMarkers.filter(m => m.mnLatency && /^a\d$/.test(m.mnLatency)).length,
    }));
    check('the pane says the readings could not be fetched and offers to try again; no pin claims an age',
      down.status === 'error' && /could not be fetched/.test(down.text) && down.retry && down.banded === 0, J(down));
    await waitTrue(p, () => MapLatency._live().status === 'error');
    const liveDown = await p.evaluate(() => ({ status: MapLatency._live().status, watching: MapLatency._live().watching,
      text: document.getElementById('lat-live-status').textContent }));
    check('…and the messages card that the log could not be read, asking again later',
      liveDown.status === 'error' && liveDown.watching && /could not be read/.test(liveDown.text), J(liveDown));
    await ctx.close();
    MODE = 'ok';
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
log('\nPASS — ⏱️ Latency colours every pin by age, delay or missed checks and keeps its shape and outline,\n'
  + '       fetches the window once, sums up the stations in view, and shows a picked station\'s checks\n'
  + '       slot by slot; one colouring of the pins at a time.');
