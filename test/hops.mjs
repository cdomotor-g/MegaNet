// 🪜 Hops to base (map-hops.js), held to what it claims.
//
// The stations are the committed register; the datastore is answered here —
// relay_summary, ingest_point_latest and reception — so what is heard is what
// this check says was. What is under test, and the defect each block would
// catch:
//
//   The pill        on the station card, Show hops to base; a real click
//                   lights them and it says Hide, pressed.
//   The routes      every one starts at the station and ends at a base
//                   station, never visits a station twice, holds at most four
//                   repeaters, each of which carries one of the station's
//                   addresses, and no hop past the map's Max TX distance —
//                   the map's own rules, walked.
//   Assumed         signed out, with no relay week, every hop is assumed.
//   The map         a line drawn for every hop; the stations on the routes
//                   keep their pins and are named, every other pin and every
//                   one of the map's own lines fades; the legend says what it
//                   is.
//   The card        a row a route, its words on hover and in a fold.
//   Heard relaying  a repeater the relay week heard relaying the address:
//                   the hop into it heard. One that heard it come another
//                   way: not heard.
//   The copies      signed in as an editor, a copy on a repeater's carrier at
//                   a base station's receiver is that repeater to that base
//                   heard; one on no repeater's carrier, the station heard
//                   direct — a hop the walk did not draw, added.
//   Follow, clear   the hops go with the card to another station; Clear and
//                   ↺ take them away, and the pins come back.
//
//   npm run hops          (or: node hops.mjs)
//   npm run hops -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { answer, asking } from './lib/ask.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const J = x => JSON.stringify(x);

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

// What the datastore answers, changed as the check goes.
const db = { relay: [], points: [], copies: [], windows: {}, asked: [] };
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
await applyNetworkPolicy(page, server.origin);
await page.route(/\/relay_summary\?/, route => { db.asked.push('relay_summary'); return json(route, db.relay); });
await page.route(/\/ingest_point_latest\?/, route => { db.asked.push('ingest_point_latest'); return json(route, db.points); });
await page.route(/\/reception\?/, route => {
  db.asked.push('reception');
  const q = new URL(route.request().url()).searchParams;
  if ((q.get('id') || '').startsWith('gt.')) return json(route, []);
  if (q.get('a2_source')) return json(route, []);
  if (q.get('alert_id')) return json(route, db.copies);
  if (q.get('cfo_hz') === 'not.is.null') return json(route, db.windows[(q.get('ingest_token_id') || '').slice(3)] || []);
  return json(route, []);
});
page.on('pageerror', e => errors.push(String(e)));
await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => { Auth.isSignedIn = () => false; switchTab('stations'); });
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });

// A field station whose routes start at two repeaters or more, the first of
// them going straight on to a base — and with four addresses or more in its
// pass ranges that no other repeater could relay, so a carrier of its own can
// be found at a receiver from bursts this check makes up.
const pick = await page.evaluate(() => {
  const reg = SignalRoutes.register();
  const byId = id => state.data.stations.find(s => s.id === id);
  const only = r => {
    const out = [];
    for (const p of r.repeater.pass_ranges || []) {
      for (let a = p.low; a <= p.high && out.length < 6; a++) {
        const c = reg.cands(a);
        if (c.length === 1 && c[0].rid === r.id && !c[0].own) out.push(a);
      }
    }
    return out;
  };
  for (const s of state.data.stations) {
    if (!s.roles.includes('field') || s.roles.includes('repeater') || s.roles.includes('base') || s.lat == null) continue;
    if (!stationAlertIds(s).length) continue;
    const p = MapHops._build(s.id);
    if (!p || !p.routes.length) continue;
    const firsts = [...new Set(p.routes.map(r => r.ids[1]).filter(id => { const x = byId(id); return x && !x.roles.includes('base'); }))];
    if (firsts.length < 2) continue;
    const direct = p.routes.find(r => r.ids.length === 3 && firsts.includes(r.ids[1]) && only(byId(r.ids[1])).length >= 4);
    if (!direct) continue;
    const r1 = direct.ids[1], b = direct.ids[2];
    const r2 = firsts.find(x => x !== r1);
    const b2 = state.data.stations.filter(x => x.roles.includes('base') && x.lat != null && x.id !== b && !p.bases.includes(x.id))
      .map(x => ({ x, km: acmaHaversineKm(s.lat, s.lon, x.lat, x.lon) })).sort((u, v) => u.km - v.km)[0];
    if (!b2) continue;
    return { id: s.id, name: s.name, addrs: stationAlertIds(s), r1, r2, b, b2: b2.x.id, r1only: only(byId(r1)).slice(0, 4) };
  }
  return null;
});
ok('a field station with routes from two repeaters, one straight on to a base, is in the register', !!pick, J(pick));
if (!pick) { await browser.close(); await server.close(); console.log('\nFAIL — nothing to check.'); process.exit(1); }
if (VERBOSE) console.log(`  station ${pick.name} (${pick.id}), first hops ${pick.r1} and ${pick.r2}, bases ${pick.b} and ${pick.b2}`);

// ── 1. the pill ──────────────────────────────────────────────────────────────
console.log('\nThe pill');
await page.evaluate(id => showStationCard(id), pick.id);
await page.waitForSelector('#stn-card .mn-hops-pill', { timeout: 10_000 });
const pill0 = await page.evaluate(() => {
  const b = document.querySelector('#stn-card .mn-hops-pill');
  return { label: b.textContent.replace(/\s+/g, ' ').trim(), pressed: b.getAttribute('aria-pressed'),
           group: b.closest('.stn-card-group')?.getAttribute('aria-label') };
});
ok('the station card offers Show hops to base, among what the app does with the station',
  pill0.label === '🪜 Show hops to base' && pill0.pressed === 'false' && pill0.group === 'In Flood-Net', J(pill0));
await page.click('#stn-card .mn-hops-pill');
await page.waitForFunction(() => MapHops.active() && !!MapHops._plan(), null, { timeout: 10_000 });
await page.waitForFunction(() => MapHops._evidence().relay !== 'loading', null, { timeout: 10_000 });
const pill1 = await page.evaluate(() => {
  const b = document.querySelector('#stn-card .mn-hops-pill');
  return { label: b.textContent.replace(/\s+/g, ' ').trim(), pressed: b.getAttribute('aria-pressed'), on: MapHops.stationId(),
           note: document.querySelector('#stn-card .acma-card-note')?.textContent.replace(/\s+/g, ' ') || '' };
});
ok('a real click lights them, and the pill says Hide, pressed — and the card says where they are listed',
  pill1.label === '🪜 Hide hops to base' && pill1.pressed === 'true' && pill1.on === pick.id && /Hops to base lit/.test(pill1.note), J(pill1));

// ── 2. the routes ────────────────────────────────────────────────────────────
console.log('\nThe routes');
const routes = await page.evaluate(({ id, addrs }) => {
  const p = MapHops._plan();
  const byId = x => state.data.stations.find(s => s.id === x);
  const K = state.mapMaxLinkKm;
  const bad = [];
  for (const r of p.routes) {
    const ids = r.ids;
    if (ids[0] !== id) bad.push(`${ids.join('>')}: does not start at the station`);
    if (!byId(ids[ids.length - 1]).roles.includes('base')) bad.push(`${ids.join('>')}: does not end at a base`);
    if (new Set(ids).size !== ids.length) bad.push(`${ids.join('>')}: visits a station twice`);
    const mid = ids.slice(1, -1);
    if (mid.length > 4) bad.push(`${ids.join('>')}: more than four repeaters`);
    for (const x of ids.slice(1, -1).concat(byId(ids[ids.length - 1]).roles.includes('repeater') ? [] : [])) {
      const s = byId(x);
      if (!s.roles.includes('repeater') || !s.repeater) bad.push(`${x}: on the way but not a repeater`);
      else if (!r.extra && !addrs.some(a => passRangeCoversId(s.repeater, a))) bad.push(`${x}: carries none of the station's addresses`);
    }
    for (let i = 2; i < ids.length; i++) {
      const a = byId(ids[i - 1]), b = byId(ids[i]);
      const km = acmaHaversineKm(a.lat, a.lon, b.lat, b.lon);
      if (!r.extra && km > K + 1e-9) bad.push(`${ids[i - 1]}>${ids[i]}: ${km.toFixed(1)} km, past ${K} km`);
    }
  }
  return { n: p.routes.length, bad, kinds: [...new Set(p.edges.map(e => e.kind))], bases: p.bases.length };
}, pick);
ok('every route runs from the station to a base station, through repeaters that carry its address, within the Max TX distance, four repeaters at most, no station twice',
  routes.n > 0 && routes.bad.length === 0, J(routes));
ok('signed out, with no relay week, every hop is assumed', routes.kinds.length === 1 && routes.kinds[0] === 'assumed', J(routes.kinds));
ok('…and the receivers\' copies are not asked for', !db.asked.includes('reception') && !db.asked.includes('ingest_point_latest'), J(db.asked));

// ── 3. the map ───────────────────────────────────────────────────────────────
console.log('\nThe map');
const shown = await page.evaluate(() => {
  const p = MapHops._plan();
  const lit = new Set(p.nodes.map(n => n.id));
  const drawn = MapHops._drawn();
  const pins = state.mapMarkers;
  return {
    edges: p.edges.length, drawn: drawn.length,
    same: p.edges.every(e => drawn.some(d => d.from === e.from && d.to === e.to && d.kind === e.kind)),
    litPins: pins.filter(m => lit.has(m.mnStationId)).length,
    litDim: pins.filter(m => lit.has(m.mnStationId) && m.mnFocusDimmed).length,
    otherLit: pins.filter(m => !lit.has(m.mnStationId) && !m.mnFocusDimmed).length,
    lines: state.mapLines.length, linesLit: state.mapLines.filter(l => !l.mnFocusDimmed).length,
    named: pins.filter(m => lit.has(m.mnStationId) && m.getTooltip()).length,
    nodes: lit.size,
    legend: /Hops to base for/.test(document.getElementById('map-legend')?.textContent || ''),
    pane: !!state.map.getPane('mnHopLines'),
  };
});
ok('a line for every hop, drawn as what is known of it', shown.edges > 0 && shown.drawn === shown.edges && shown.same, J(shown));
ok('the stations on the routes keep their pins; every other pin fades, and every one of the map\'s own lines',
  shown.litPins > 0 && shown.litDim === 0 && shown.otherLit === 0 && shown.linesLit === 0, J(shown));
ok('…the stations on the routes are named', shown.named === shown.litPins, J(shown));
ok('…and the legend says what the lines are', shown.legend && shown.pane, J(shown));

// ── 4. the card ──────────────────────────────────────────────────────────────
console.log('\nThe card');
const card = await page.evaluate(() => {
  const el = document.getElementById('hops-card');
  return {
    shown: !!el && !el.hidden, head: el.querySelector('h3')?.textContent || '',
    rows: el.querySelectorAll('tbody tr').length, routes: MapHops._plan().routes.length,
    heads: [...el.querySelectorAll('thead .term')].map(t => [t.textContent, t.title.length]),
    key: [...el.querySelectorAll('.hops-key .term')].map(t => [t.textContent, t.title]),
    words: el.querySelectorAll('.hops-words dt').length,
    marks: el.querySelectorAll('.hop-mark').length,
    evidence: el.textContent.replace(/\s+/g, ' '),
  };
});
ok('the card is up, headed with the station, a row a route', card.shown && card.head.includes(pick.name) && card.rows === Math.min(card.routes, 12), J(card));
ok('its headings and its key each carry their meaning on hover',
  card.heads.length === 3 && card.heads.every(([, n]) => n > 40)
    && card.key.map(k => k[0]).join('|') === 'Heard|Assumed|Not heard' && card.key.every(([w, m]) => m.length > 40 && !m.startsWith(w)), J(card));
ok('…and in a fold a finger can read', card.words === 8, `${card.words}`);
ok('signed out, it says which base station heard it is for editors', /for editors/.test(card.evidence), card.evidence.slice(0, 400));

// ── 5. heard relaying, and not ───────────────────────────────────────────────
console.log('\nHeard relaying');
const a = pick.addrs[0];
const row = (id, o) => ({ station_id: id, days: 7, relayed: [], off_record: [], off_dup: [], off_own: [], off_all: [],
                          elsewhere: [], window_days: 7, judged_at: new Date().toISOString(), ...o });
db.relay = [row(pick.r1, { relayed: [a] }), row(pick.r2, { elsewhere: [a] })];
await page.evaluate(id => { MapHops._reset(); MapHops.show(id, { quiet: true, refit: false }); }, pick.id);
await page.waitForFunction(() => MapHops._evidence().relay === 'ok', null, { timeout: 10_000 });
const relay = await page.evaluate(({ id, r1, r2 }) => {
  const p = MapHops._plan();
  const e = (f, t) => (p.edges.find(x => x.from === f && x.to === t) || {}).kind;
  const n = x => (p.nodes.find(y => y.id === x) || {}).kind;
  return { in1: e(id, r1), in2: e(id, r2), n1: n(r1), n2: n(r2),
           drawn: MapHops._drawn().filter(d => d.from === id && d.to === r1).map(d => d.kind),
           card: document.getElementById('hops-card').textContent.replace(/\s+/g, ' ') };
}, pick);
ok('a repeater heard relaying the station\'s address in the relay week: the hop into it is heard, and drawn so',
  relay.in1 === 'heard' && relay.n1 === 'heard' && relay.drawn.includes('heard'), J(relay));
ok('one heard bringing it in another way, never relaying it: not heard', relay.in2 === 'missed' && relay.n2 === 'missed', J(relay));
ok('…and the card names the one heard relaying it', /Heard relaying it in the relay week/.test(relay.card), relay.card.slice(0, 500));

// ── 6. the receivers' copies ─────────────────────────────────────────────────
console.log('\nThe receivers\' copies');
const t = Date.now() - 3600e3;
const at = k => new Date(t + k * 1000).toISOString();
db.points = [{ ingest_token_id: 901, point_id: 'rx-a', host_station_id: pick.b },
             { ingest_token_id: 902, point_id: 'rx-b', host_station_id: pick.b2 }];
// At rx-a: the station's burst on the first repeater's carrier, with four
// addresses only that repeater relays on it too. At rx-b: the station on a
// carrier of its own, nothing else near it.
const mine = { id: 5001, ingest_token_id: 901, point_id: 'rx-a', heard_at: at(0), protocol: 'alert', alert_id: a, cfo_hz: 103,
               a2_duplicate: false, a2_source: null, a2_path: null };
const own = { id: 5002, ingest_token_id: 902, point_id: 'rx-b', heard_at: at(5), protocol: 'alert', alert_id: a, cfo_hz: 640,
              a2_duplicate: false, a2_source: null, a2_path: null };
db.copies = [mine, own];
db.windows = {
  901: [mine, ...pick.r1only.map((x, i) => ({ id: 6000 + i, ingest_token_id: 901, point_id: 'rx-a', heard_at: at(-60 * (i + 1)),
    alert_id: x, cfo_hz: [100, 98, 102, 101][i], a2_duplicate: false }))],
  902: [own],
};
db.asked = [];
await page.evaluate(id => {
  Auth.isSignedIn = () => true; Auth.mayWrite = () => true;
  MapHops._reset(); MapHops.show(id, { quiet: true, refit: false });
}, pick.id);
await page.waitForFunction(() => ['ok', 'error', 'none'].includes(MapHops._evidence().rx), null, { timeout: 10_000 });
const rx = await page.evaluate(({ id, r1, b, b2 }) => {
  const p = MapHops._plan();
  const e = (f, t) => (p.edges.find(x => x.from === f && x.to === t) || {});
  return { ev: MapHops._evidence(), viaB: e(r1, b).kind, direct: e(id, b2).kind, straight: e(id, b2).straight,
           route: p.routes.find(r => r.ids.join('>') === `${id}>${b2}`) || null,
           baseB: (p.nodes.find(n => n.id === b) || {}).kind, baseB2: (p.nodes.find(n => n.id === b2) || {}).kind,
           card: document.getElementById('hops-card').textContent.replace(/\s+/g, ' ') };
}, pick);
ok('signed in as an editor, the station\'s copies and each receiver\'s window are asked for',
  rx.ev.rx === 'ok' && db.asked.includes('reception') && db.asked.includes('ingest_point_latest'), J({ ev: rx.ev, asked: db.asked }));
ok('a copy on the first repeater\'s carrier at a base station\'s receiver: that repeater to that base, heard',
  rx.ev.paths.some(x => x.join('>') === `${pick.r1}>${pick.b}`) && rx.viaB === 'heard' && rx.baseB === 'heard', J(rx));
ok('a copy on a carrier of the station\'s own at another: heard direct — a hop the walk did not draw, added straight',
  rx.ev.paths.some(x => x.join('>') === `${pick.id}>${pick.b2}`) && rx.direct === 'heard' && rx.straight === true
    && !!rx.route && rx.route.extra && rx.baseB2 === 'heard', J(rx));
ok('…and the card says where it was heard arriving', /heard arriving at/.test(rx.card), rx.card.slice(0, 600));

// ── 7. a route picked ────────────────────────────────────────────────────────
const picked = await page.evaluate(() => {
  const btn = document.querySelector('#hops-card tbody tr .hops-route');
  btn.click();
  const on = document.querySelectorAll('#hops-card tr.hops-picked').length;
  const pressed = document.querySelector('#hops-card tr.hops-picked .hops-route')?.getAttribute('aria-pressed');
  document.querySelector('#hops-card tr.hops-picked .hops-route').click();
  return { on, pressed, off: document.querySelectorAll('#hops-card tr.hops-picked').length };
});
ok('a route pressed in the card is picked, and pressed again put back', picked.on === 1 && picked.pressed === 'true' && picked.off === 0, J(picked));

// ── 8. follow, clear ─────────────────────────────────────────────────────────
console.log('\nFollow and clear');
const other = await page.evaluate(id => {
  const s = state.data.stations.find(x => x.id !== id && x.roles.includes('field') && !x.roles.includes('base')
    && x.lat != null && stationAlertIds(x).length && MapHops._build(x.id).routes.length);
  showStationCard(s.id);
  return { id: s.id, on: MapHops.stationId(), pill: document.querySelector('#stn-card .mn-hops-pill')?.getAttribute('aria-pressed') };
}, pick.id);
ok('the card moved to another station: the hops go with it', other.on === other.id && other.pill === 'true', J(other));
await page.click('#hops-card .panel-header button');
await page.waitForTimeout(200);
const cleared = await page.evaluate(() => ({
  on: MapHops.active(), drawn: MapHops._drawn().length, card: document.getElementById('hops-card').hidden,
  dim: state.mapMarkers.filter(m => m.mnFocusDimmed).length, lines: state.mapLines.filter(l => l.mnFocusDimmed).length,
  pill: document.querySelector('#stn-card .mn-hops-pill')?.textContent.replace(/\s+/g, ' ').trim(),
  legend: /Hops to base for/.test(document.getElementById('map-legend')?.textContent || ''),
}));
ok('Clear takes them off: nothing drawn, the card hidden, every pin and line back, the pill Show again, the legend without it',
  !cleared.on && cleared.drawn === 0 && cleared.card && cleared.dim === 0 && cleared.lines === 0
    && cleared.pill === '🪜 Show hops to base' && !cleared.legend, J(cleared));
await page.click('#stn-card .mn-hops-pill');
await page.waitForFunction(() => MapHops.active(), null, { timeout: 5000 });
await page.evaluate(() => document.querySelector('.mn-map-reset')?.click());
if (await asking(page)) await answer(page, true);
await page.waitForTimeout(400);
const reset = await page.evaluate(() => {
  let ours = 0;
  state.map.eachLayer(l => { if (!(l instanceof L.Renderer) && l.options && l.options.pane === 'mnHopLines') ours++; });
  return { on: MapHops.active(), ours, dim: state.mapMarkers.filter(m => m.mnFocusDimmed).length };
});
ok('↺ takes them off too', !reset.on && reset.ours === 0 && reset.dim === 0, J(reset));

ok('nothing threw', errors.length === 0, errors.join('\n'));

await browser.close();
await server.close();
console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
