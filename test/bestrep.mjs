// The best repeater finder (map-bestrep.js), held to what it claims.
//
// The terrain is the terrain kit's hilly world (lib/terrarium.mjs) and the
// stations are the committed register, so every figure below is worked out
// again here — by the link budget card's own functions, called by this check
// — rather than read back from the module. What is under test, and the defect
// each block would catch:
//
//   The panel       a pane of the side panel, its button straight after 🚚 and
//                   straight before ℹ️; Find the best repeater off until a
//                   station is given — with a reason.
//   The station     found by its number through the box, with a real click;
//                   the repeaters and bases offered are every one within the
//                   distance, nearest first, at most thirty, and every one
//                   carrying it now.
//   Its hop         every figure the card's arithmetic to the last bit, one
//                   way, station to hub; and for a repeater carrying it today,
//                   the fade margin layer's own figure for that link.
//   On to a base    a base ends there; a repeater's best route starts at it,
//                   ends at a base, hops no further than the map's Max TX
//                   distance, holds at most four repeaters and never a station
//                   twice, each repeater's window taking what the one before
//                   passed on. With nothing saved every hop on is "not worked
//                   out" and the whole way is marked ≈; "Work out the missing
//                   hops" works them out the layer's way, and the whole way is
//                   then the weaker of the two.
//   The ranking     the whole way best first, a hub with no route on below
//                   every one with; "Its own hop only" a re-sort with no
//                   terrain asked for.
//   The map         a path for every hub priced, the picked one heavier with
//                   its route on; a pin is what a real click lands on, and
//                   picks it; the legend says what it all is; Copy for a
//                   report puts the hubs listed on the clipboard, a row each.
//   Saved figures   a hop the datastore holds under the signature in force is
//                   read from it; one whose signature has moved is stale, not
//                   a figure.
//   A new site      a lat, lon typed, and a point picked on the map with a
//                   real click, each a site of its own with nothing carrying it.
//   The card        Repeaters listening hands its station to the panel.
//   Reset           takes all of it off the map.
//
//   npm run bestrep          (or: node bestrep.mjs)
//   npm run bestrep -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { hillyTerrariumPng } from './lib/terrarium.mjs';
import { answer, asking } from './lib/ask.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const RUN_TIMEOUT = 180_000;

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

async function openPage(rows) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  const counts = { tiles: 0, saved: 0 };
  await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
    counts.tiles++;
    const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(+m[1], +m[2], +m[3]),
                           headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  if (rows) {
    await page.route(/\/link_fade_margin/, route => {
      counts.saved++;
      const offset = +(new URL(route.request().url()).searchParams.get('offset') || 0);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(offset ? [] : rows) });
    });
  }
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });
  return { page, context, counts };
}

const { page, counts } = await openPage(null);
await page.click('#help-panel .dock-tab[data-dock="map-bestrep"]');
await page.waitForTimeout(400);

const done = () => page.waitForFunction(() => ['done', 'blocked'].includes(MapBestRepeater.status().kind), null, { timeout: RUN_TIMEOUT });

// ── 0. the panel ─────────────────────────────────────────────────────────────
console.log('\nThe panel');

const panel = await page.evaluate(() => {
  const wrap = document.querySelector('.mn-mapctl[data-panel="bestrep"]');
  const strip = [...document.querySelectorAll('#help-panel .dock-strip button')];
  const at = sel => strip.findIndex(b => b.matches(sel));
  const body = wrap && wrap.querySelector('.mn-mapctl-body');
  return {
    present: !!wrap, docked: !!wrap && !!wrap.closest('#help-panel .dock-pane'),
    shown: !!(body && body.getClientRects().length), showing: dockShowing(),
    title: wrap && wrap.querySelector('.mn-mapctl-title')?.textContent,
    group: strip.find(b => b.dataset.dock === 'map-bestrep')?.closest('.dock-group')?.dataset.group,
    afterRelocate: at('[data-dock="map-bestrep"]') === at('[data-dock="map-relocate"]') + 1,
    beforeHere: at('.mn-map-here') === at('[data-dock="map-bestrep"]') + 2
      && at('[data-dock="map-repcompare"]') === at('[data-dock="map-bestrep"]') + 1,
    runDisabled: document.getElementById('bestrep-run')?.disabled,
    status: document.getElementById('bestrep-status')?.textContent || '',
    words: document.querySelectorAll('.bestrep-words dt').length,
  };
});
ok('a 🎯 Best repeater is a pane of the side panel, open from its button in the strip',
   panel.present && panel.docked && panel.shown && panel.showing === 'map-bestrep' && panel.title === 'Best repeater',
   JSON.stringify(panel));
ok('…in the tools group, straight after the relocation finder, with ⚖️ Repeater comparison between it and What is here',
   panel.group === 'tools' && panel.afterRelocate && panel.beforeHere, JSON.stringify(panel));
ok('Find the best repeater is off with no station, and the panel says what is missing',
   panel.runDisabled === true && /Pick a station/.test(panel.status), panel.status);
ok('…and the panel\'s words are listed where a finger can read them', panel.words >= 10, `${panel.words}`);

// ── 1. the station ───────────────────────────────────────────────────────────
console.log('\nThe station');

// A field station in Queensland with one or two repeaters carrying it, each
// with a complete radio and 5–40 km away, a station number nobody else answers
// to, and at least one base within 60 km — so the answer has both kinds.
const pick = await page.evaluate(() => {
  const all = state.data.stations;
  const nums = all.reduce((m, s) => m.set(String(s.station_number || ''), (m.get(String(s.station_number || '')) || 0) + 1), new Map());
  const done = sys => sys && sys.tx_power_w != null && sys.antenna_gain_dbi != null && sys.line_loss_db != null && sys.rx_threshold_dbm != null;
  for (const s of all) {
    if (!s.roles.includes('field') || s.roles.includes('repeater') || s.lat == null || !s.station_number
        || nums.get(String(s.station_number)) !== 1) continue;
    if (!(s.lon > 139 && s.lon < 153 && s.lat < -11 && s.lat > -28.5)) continue;
    if (!done(rmSystemOf(s))) continue;
    const reps = findRepeaterMatches(s).filter(r => r.lat != null && r.id !== s.id);
    if (!reps.length || reps.length > 2 || !reps.every(r => done(rmSystemOf(r)))) continue;
    if (!reps.every(r => { const k = acmaHaversineKm(s.lat, s.lon, r.lat, r.lon); return k > 5 && k < 40; })) continue;
    if (!all.some(b => b.roles.includes('base') && b.lat != null && acmaHaversineKm(s.lat, s.lon, b.lat, b.lon) < 60)) continue;
    return { id: s.id, name: s.name, number: s.station_number, lat: s.lat, lon: s.lon, reps: reps.map(r => r.id) };
  }
  return null;
});
ok('the file holds a station to test with', !!pick, JSON.stringify(pick));

await page.fill('#bestrep-find', String(pick.number));
await page.locator('#bestrep-hits .polar-hit', { hasText: pick.name }).first().click();
await page.waitForTimeout(300);
const picked = await page.evaluate(() => ({
  site: MapBestRepeater.site(), choices: MapBestRepeater.choices(),
  run: document.getElementById('bestrep-run')?.disabled,
  line: document.getElementById('bestrep-picked')?.textContent || '',
}));
ok('a station found by its number is the station asked about', picked.site && picked.site.id === pick.id
   && picked.line.includes(pick.name), JSON.stringify(picked.site));
const want = await page.evaluate(({ id }) => {
  const st = state.data.stations.find(s => s.id === id);
  return state.data.stations
    .filter(x => x.id !== id && x.lat != null && ((x.roles.includes('repeater') && x.repeater) || x.roles.includes('base')))
    .map(x => ({ id: x.id, km: acmaHaversineKm(st.lat, st.lon, x.lat, x.lon) }))
    .filter(x => x.km <= 60).sort((a, b) => a.km - b.km).slice(0, 30).map(x => x.id);
}, pick);
const offered = picked.choices.map(c => c.id);
ok('the hubs offered are every repeater and base within 60 km, nearest first, at most thirty',
   want.every((id, i) => offered[i] === id), `${offered.length} offered, ${want.length} wanted`);
ok('…and every repeater carrying it now is among them, marked',
   pick.reps.every(id => picked.choices.some(c => c.id === id && c.carries))
   && picked.choices.filter(c => c.carries).length === pick.reps.length, JSON.stringify(picked.choices.filter(c => c.carries)));
ok('…and Find the best repeater is on', picked.run === false);

// ── 2. its hop ───────────────────────────────────────────────────────────────
console.log('\nIts hop');

await page.locator('#bestrep-run').click();
await done();
const A = await page.evaluate(() => ({ status: MapBestRepeater.status(), results: MapBestRepeater.results(),
  missing: MapBestRepeater.missing(), text: document.getElementById('bestrep-status')?.textContent.replace(/\s+/g, ' ') || '' }));
ok('the run finishes', A.status.kind === 'done', JSON.stringify(A.status));
ok('…with a row for every hub offered', A.results.length === offered.length, `${A.results.length} of ${offered.length}`);
ok('…and its first line says how the best compares with what carries it now',
   /better than|already the best/.test(A.text), A.text.slice(0, 300));
// npm run tabs's rule, for a pane it does not open: a marked word carries a
// meaning of a sentence, never the word again.
const terms = await page.evaluate(() => [...document.querySelectorAll('.bestrep-panel .term, .bestrep-panel .term-chip')]
  .map(el => ({ t: el.textContent.trim(), title: (el.getAttribute('title') || '').trim() })));
ok('every word marked on the panel says what it means', terms.length >= 10
   && terms.every(x => x.title.length >= 20 && x.title.toLowerCase() !== x.t.toLowerCase()),
   JSON.stringify(terms.filter(x => !(x.title.length >= 20 && x.title.toLowerCase() !== x.t.toLowerCase())).slice(0, 3)));

const cross = await page.evaluate(async ({ st, ids }) => {
  const s = state.data.stations.find(x => x.id === st);
  const sysA = rmSystemOf(s);
  const out = [];
  for (const r of MapBestRepeater.results().filter(x => ids.includes(x.id))) {
    const hub = state.data.stations.find(x => x.id === r.id);
    const sysB = rmSystemOf(hub);
    if (!sysB || sysB.rx_threshold_dbm == null) { out.push({ id: r.id, skip: true }); continue; }
    const aglA = stationAntenna(s, sysA).agl, aglB = stationAntenna(hub, sysB).agl;
    const f = hub.repeater && hub.repeater.rx_mhz > 0 ? hub.repeater.rx_mhz : PATH_DEFAULT_MHZ;
    const g = await pathGround({ lat: s.lat, lon: s.lon, elev: s.elevation_ahd, agl: aglA, mast: false },
                               { lat: hub.lat, lon: hub.lon, elev: hub.elevation_ahd, agl: aglB, mast: stationIsMast(hub) },
                               { samples: 256, freqMhz: f });
    const an = pathAnalyse(g.prof, { elevA: g.ends.a.elev, elevB: g.ends.b.elev, aglA, aglB, freqMhz: f });
    const want = wattsToDbm(sysA.tx_power_w) + sysA.antenna_gain_dbi - sysA.line_loss_db - an.pathLoss_db
               + sysB.antenna_gain_dbi - sysB.line_loss_db - sysB.rx_threshold_dbm;
    out.push({ id: r.id, got: r.first && r.first.margin, want, verdict: r.first && r.first.verdict, wantV: an.verdict });
  }
  return out;
}, { st: pick.id, ids: [A.results[0].id, A.results[A.results.length - 1].id, ...pick.reps] });
ok('every figure checked is the link budget card\'s own arithmetic, one way, station to hub, to the last bit',
   cross.filter(c => !c.skip).length > 0 && cross.every(c => c.skip || (c.got === c.want && c.verdict === c.wantV)),
   JSON.stringify(cross));

const layer = await page.evaluate(async ({ st, reps }) => {
  const s = state.data.stations.find(x => x.id === st);
  const out = [];
  for (const id of reps) {
    const r = state.data.stations.find(x => x.id === id);
    const fig = await MapFade.work(s, r);
    out.push({ id, layer: fig && fig.margin, ours: (MapBestRepeater.results().find(x => x.id === id) || {}).first?.margin });
  }
  return out;
}, { st: pick.id, reps: pick.reps });
ok('…and for a repeater carrying it today, the fade margin layer\'s own figure for that link',
   layer.every(l => l.layer != null && l.layer === l.ours), JSON.stringify(layer));

// ── 3. on to a base ──────────────────────────────────────────────────────────
console.log('\nOn to a base');

const shape = await page.evaluate(() => {
  const K = state.mapMaxLinkKm > 0 ? state.mapMaxLinkKm : 100;
  const byId = id => state.data.stations.find(s => s.id === id);
  const bad = [];
  let routes = 0, bases = 0;
  for (const r of MapBestRepeater.results()) {
    if (!r.first || r.first.failed) continue;
    if (r.isBase) { if (r.onward.kind !== 'base') bad.push(`${r.id}: a base not ending there`); bases++; continue; }
    if (r.onward.kind !== 'route') continue;
    routes++;
    const ids = r.onward.ids;
    const last = byId(ids[ids.length - 1]);
    if (ids[0] !== r.id) bad.push(`${r.id}: does not start at itself`);
    if (!last.roles.includes('base')) bad.push(`${r.id}: ends at ${last.id}, not a base`);
    if (new Set(ids).size !== ids.length) bad.push(`${r.id}: a station twice`);
    if (ids.length - 1 > 4) bad.push(`${r.id}: ${ids.length - 1} repeaters`);
    for (let i = 0; i < ids.length - 1; i++) {
      const a = byId(ids[i]), b = byId(ids[i + 1]);
      if (acmaHaversineKm(a.lat, a.lon, b.lat, b.lon) > K + 1e-9) bad.push(`${r.id}: hop ${a.id}>${b.id} longer than ${K} km`);
      if (i > 0 && i < ids.length - 2 && windowOverlapCount(repeaterOpenWindows(a.repeater), repeaterOpenWindows(b.repeater)) === 0) {
        bad.push(`${r.id}: ${a.id}>${b.id} share no window`);
      }
    }
  }
  return { bad, routes, bases };
});
ok('a base ends there; a repeater\'s route starts at it and ends at a base', shape.bases > 0 && shape.routes > 0 && shape.bad.length === 0,
   `${shape.routes} routes, ${shape.bases} bases · ${shape.bad.slice(0, 5).join(' · ')}`);

const before = A.results.filter(r => r.onward && r.onward.kind === 'route');
ok('with nothing saved, every hop on is not worked out, and the whole way is the station\'s own hop marked ≈',
   A.missing.length > 0 && before.every(r => !r.complete && r.onward.unmodelled === r.onward.hops.length && r.approx
                                              && (r.first.failed || r.whole === r.first.margin)),
   `${A.missing.length} missing`);
ok('…and the panel says so, with the button to work them out', /no figure yet/.test(A.text)
   && await page.locator('#bestrep-status button', { hasText: 'Work out the missing hops' }).count() === 1, A.text.slice(0, 400));

await page.locator('#bestrep-status button', { hasText: 'Work out the missing hops' }).click();
await page.waitForFunction(() => MapBestRepeater.status().kind === 'done', null, { timeout: RUN_TIMEOUT });
const W = await page.evaluate(() => {
  const res = MapBestRepeater.results();
  const byId = id => state.data.stations.find(s => s.id === id);
  const wrong = [];
  for (const r of res) {
    if (!r.onward || r.onward.kind !== 'route' || !r.onward.complete) continue;
    for (const h of r.onward.hops) {
      const k = MapFade.known(byId(h.from), byId(h.to));
      if (!k || k.margin !== h.margin) wrong.push(`${h.from}>${h.to}`);
    }
    const weakest = Math.min(...r.onward.hops.map(h => h.margin));
    if (r.onward.weakest !== weakest) wrong.push(`${r.id}: weakest`);
    if (r.first && !r.first.failed && (r.approx || r.whole !== Math.min(r.first.margin, weakest))) wrong.push(`${r.id}: whole`);
  }
  return { res, wrong, missing: MapBestRepeater.missing().length };
});
const complete = W.res.filter(r => r.onward && r.onward.kind === 'route' && r.onward.complete);
ok('worked out, the hops on are the fade margin layer\'s figures, and the whole way is the weaker of the two',
   complete.length > 0 && W.wrong.length === 0, `${complete.length} complete · ${W.wrong.slice(0, 5).join(' · ')}`);
ok('…and nothing is left missing that could be worked out', W.missing <= A.missing.length && W.missing < A.missing.length,
   `${W.missing} of ${A.missing.length} still missing`);

// ── 4. the ranking ───────────────────────────────────────────────────────────
console.log('\nThe ranking');

const tierOf = r => (r.first == null || r.first.failed ? 3 : r.noRoute ? 2 : 0);
const headOf = r => (r.first == null || r.first.failed ? -Infinity : r.whole != null ? r.whole : r.first.margin);
const RS = W.res;
ok('ranked 1..n, the whole way best first, a hub with no route on below every one with',
   RS.every((r, i) => r.rank === i + 1) && RS.every((r, i) => i === 0 || tierOf(RS[i - 1]) < tierOf(r)
     || (tierOf(RS[i - 1]) === tierOf(r) && headOf(RS[i - 1]) >= headOf(r) - 1e-9)),
   RS.map(r => `${tierOf(r)}:${headOf(r) === -Infinity ? '—' : headOf(r).toFixed(1)}`).join(' → '));

const tilesAtSort = counts.tiles;
await page.evaluate(() => { window.__profiles = 0; const p = Terrain.profile; Terrain.__orig = p;
  Terrain.profile = function (...a) { window.__profiles++; return p.apply(this, a); }; });
await page.selectOption('#bestrep-rank', 'first');
const F = await page.evaluate(() => ({ res: MapBestRepeater.results(), profiles: window.__profiles }));
const firstOf = r => (r.first == null || r.first.failed ? -Infinity : r.first.margin);
ok('"Its own hop only" re-sorts by the station\'s hop, best first',
   F.res.length === RS.length && F.res.every((r, i) => i === 0 || firstOf(F.res[i - 1]) >= firstOf(r)),
   F.res.map(r => firstOf(r).toFixed(1)).join(' → '));
ok('…with no terrain asked for', F.profiles === 0 && counts.tiles === tilesAtSort, `${F.profiles} profile(s)`);
await page.evaluate(() => { Terrain.profile = Terrain.__orig; });
await page.selectOption('#bestrep-rank', 'whole');

// ── 5. the map ───────────────────────────────────────────────────────────────
console.log('\nThe map');

const drawn = () => page.evaluate(() => {
  const lines = [];
  state.map.eachLayer(l => { if (l instanceof L.Polyline && !(l instanceof L.Polygon) && l.options.pane === 'mnBestLines') lines.push(l.options.weight); });
  return { lines, pins: document.querySelectorAll('.leaflet-mnBest-pane .mn-site').length, selected: MapBestRepeater.selected() };
});
const d1 = await drawn();
const priced = RS.filter(r => r.first && !r.first.failed).length;
const sel1 = RS.find(r => r.id === d1.selected);
const routeHops = sel1 && sel1.onward && sel1.onward.kind === 'route' ? sel1.onward.hops.length : 0;
ok('a path for every hub priced, the picked one heavier, with its route on',
   d1.lines.length === priced + routeHops && d1.lines.filter(w => w === 4.5).length === 1 && d1.lines.filter(w => w === 3).length === routeHops,
   JSON.stringify({ lines: d1.lines.length, priced, routeHops }));
ok('…and the best few pinned, numbered', d1.pins === Math.min(8, RS.length), `${d1.pins} pins`);

const r2 = RS[1];
await page.evaluate(r => state.map.setView([state.data.stations.find(s => s.id === r.id).lat, state.data.stations.find(s => s.id === r.id).lon], 13, { animate: false }), r2);
await page.waitForTimeout(400);
const pin2 = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.leaflet-mnBest-pane .mn-site')].find(x => x.querySelector('.mn-site-mark')?.textContent === '2');
  if (!el) return null;
  const r = el.querySelector('.mn-site-mark').getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { x, y, mine: !!(hit && el.contains(hit)), hit: hit ? `${hit.tagName}.${hit.className}` : null };
});
ok('#2\'s pin is what the pointer lands on', !!pin2 && pin2.mine, JSON.stringify(pin2));
if (pin2) { await page.mouse.click(pin2.x, pin2.y); await page.waitForTimeout(300); }
const sel = await page.evaluate(() => ({
  selected: MapBestRepeater.selected(),
  popup: document.querySelector('.leaflet-popup .mn-site-pop h4')?.textContent || '',
  row: document.querySelector('.bestrep-panel .sites-result.is-on .sites-rank')?.textContent || '',
  table: document.querySelectorAll('.bestrep-panel .sites-result.is-on .sites-table tbody tr').length,
}));
const r2hops = r2.onward && r2.onward.kind === 'route' ? r2.onward.hops.length : 0;
ok('…and a click on it picks it: its callout, its row, a table of every hop',
   sel.selected === r2.id && /^#2 /.test(sel.popup) && sel.row === '2' && sel.table === 1 + r2hops, JSON.stringify(sel));
await page.evaluate(() => state.map.closePopup());

// Each hop's ground, drawn small in its row: the station's own from the
// pricing, the hops on drawn when the card opens.
await page.waitForFunction(() => ![...document.querySelectorAll('.bestrep-panel .sites-result.is-on .sites-t-pic .sites-thumb-none')]
  .some(x => /Drawing/.test(x.textContent)), null, { timeout: 60000 }).catch(() => {});
const pics = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.bestrep-panel .sites-result.is-on .sites-table tbody tr')];
  return {
    head: document.querySelector('.bestrep-panel .sites-result.is-on .sites-table thead .sites-t-pic')?.textContent.trim() || '',
    means: document.querySelector('.bestrep-panel .sites-result.is-on .sites-table thead .sites-t-pic [title]')?.getAttribute('title') || '',
    rows: rows.length,
    drawn: rows.filter(r => r.querySelector('td.sites-t-pic .sites-thumb svg')).length,
    buttons: rows.filter(r => r.querySelector('td.sites-t-pic button.sites-thumb')).length,
    open: rows.filter(r => r.querySelector('button.btn-link')).length,
    key: !!document.querySelector('.bestrep-panel .sites-result.is-on .sites-thumbs-hint'),
    fold: [...document.querySelectorAll('.bestrep-words dt')].some(d => d.textContent === 'Ground profile'),
  };
});
ok('every hop in the table has its ground profile drawn beside its figures, and a ↗',
   pics.head === 'Ground profile' && pics.means.length > 40 && pics.rows === 1 + r2hops && pics.drawn === pics.rows
   && pics.buttons === pics.rows && pics.open === pics.rows && pics.key && pics.fold, JSON.stringify(pics));
await page.locator('.bestrep-panel .sites-result.is-on tbody tr:first-child .sites-thumb').click();
await page.waitForTimeout(600);
const fullOpen = await page.evaluate(() => ({
  line: !!MapDraw.findLine([MapBestRepeater.site().lat, MapBestRepeater.site().lon],
    (s => [s.lat, s.lon])(state.data.stations.find(x => x.id === MapBestRepeater.selected()))),
  full: !!document.querySelector('.pp-full, .path-full, [class*="pp-fs"], dialog[open]'),
}));
ok('a click on a picture puts that hop in the elevation profile', fullOpen.line, JSON.stringify(fullOpen));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

const legend = await page.evaluate(() => document.getElementById('map-legend')?.textContent.replace(/\s+/g, ' ') || '');
ok('the legend says what the paths and the pins are', /Best repeater/.test(legend), legend.slice(0, 200));

const csv = await page.evaluate(() => MapBestRepeater.csvText());
const lines = csv.trim().split('\n');
const head = lines.find(l => l.startsWith('rank,'));
ok('Save CSV writes every hub priced, one row each, under named columns',
   lines.filter(l => !l.startsWith('#') && !l.startsWith('rank,')).length === RS.length
   && /hop_margin_db/.test(head) && /whole_way_db/.test(head) && /route_on/.test(head) && /^# Flood-Net/.test(lines[0]), head);

// Copy for a report: the rows the panel lists, a line each in the plain text
// (tab between columns, for a spreadsheet) and a row each in the document,
// on the clipboard for real.
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
await page.evaluate(() => { document.getElementById('toasts')?.replaceChildren(); return navigator.clipboard.writeText(''); });
await page.locator('#bestrep-copy').click();
await page.waitForFunction(() => /Copied/.test(document.getElementById('toasts')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
const copied = await page.evaluate(async () => ({
  clip: await navigator.clipboard.readText(),
  html: MapBestRepeater.reportHtml(),
  listed: [...document.querySelectorAll('.bestrep-results > li .bestrep-head strong')].map(e => e.textContent),
  inHtml: [...document.querySelectorAll('.bestrep-results > li .bestrep-head strong')].every(e => MapBestRepeater.reportHtml().includes(esc(e.textContent))),
  toast: document.getElementById('toasts')?.textContent || '',
}));
const clipLines = copied.clip.split('\n');
const at = clipLines.findIndex(l => l.startsWith('Rank\tRepeater or base\t'));
const tableRows = at < 0 ? [] : clipLines.slice(at + 1, at + 1 + copied.listed.length);
ok('📋 Copy for a report puts the listed repeaters on the clipboard, a row each in rank order, tab between columns',
   /^Best repeater for /.test(clipLines[0]) && at > 0 && copied.listed.length > 0
   && tableRows.every((l, i) => l.split('\t')[0] === String(i + 1) && l.split('\t')[1].startsWith(copied.listed[i]) && l.split('\t').length === 9)
   && clipLines[at + 1 + copied.listed.length] === '' && /WHAT THE WORDS MEAN/.test(copied.clip) && /Copied/.test(copied.toast),
   JSON.stringify({ head: clipLines.slice(0, 6), listed: copied.listed, toast: copied.toast }));
ok('…and the document beside it has the same rows, the hops on and the words',
   (copied.html.match(/<tr>/g) || []).length >= copied.listed.length + 1 && /(Every hop from|The hop from) /.test(copied.html)
   && /What the words mean/.test(copied.html) && copied.inHtml);

// A typed antenna height takes the answer away: it is not the question asked.
await page.fill('#bestrep-agl', '9');
await page.locator('#bestrep-agl').dispatchEvent('change');
const afterAgl = await page.evaluate(() => ({ n: MapBestRepeater.results().length, agl: MapBestRepeater.radio().agl }));
ok('a new antenna height takes the answer away, and is the height asked next', afterAgl.n === 0 && afterAgl.agl === 9, JSON.stringify(afterAgl));

// ── 6. saved figures ─────────────────────────────────────────────────────────
console.log('\nSaved figures');

// The hops of the best route found above, saved: the first under the
// signature in force, the second under one whose position has moved.
const hops = (complete.find(r => r.onward.hops.length >= 2) || complete[0]).onward.hops;
const rows = await page.evaluate(hs => {
  const byId = id => state.data.stations.find(s => s.id === id);
  return hs.slice(0, 2).map((h, i) => {
    const a = byId(h.from), b = byId(h.to);
    const [x, y] = a.id < b.id ? [a, b] : [b, a];
    const m = i === 0 ? 21.5 : 30;
    return { station_a_id: x.id, station_b_id: y.id, margin_db: m, margin_ab_db: m, margin_ba_db: m, verdict: 'clear',
             signature: i === 0 ? MapFade.signature(a, b) : MapFade.signature(a, b).replace(/^([^|]*)\|(-?\d+)\./, '$1|9.'),
             good_db: 15, ok_db: 6, computed_at: '2026-11-04T00:00:00Z' };
  });
}, hops);
const P2 = await openPage(rows);
const page2 = P2.page;
await page2.evaluate(id => MapBestRepeater.pickStation(id), pick.id);
await page2.evaluate(() => MapBestRepeater.run());
await page2.waitForFunction(() => MapBestRepeater.status().kind === 'done', null, { timeout: RUN_TIMEOUT });
const S = await page2.evaluate(hs => {
  const cache = new Map();
  for (const r of MapBestRepeater.results()) for (const h of (r.onward && r.onward.hops) || []) cache.set(`${h.from}>${h.to}`, h);
  return { a: cache.get(`${hs[0].from}>${hs[0].to}`) || null, b: hs[1] ? cache.get(`${hs[1].from}>${hs[1].to}`) || null : null,
           missing: MapBestRepeater.missing() };
}, hops);
ok('the datastore is asked', P2.counts.saved > 0, `${P2.counts.saved} read(s)`);
ok('a hop saved under the signature in force is read from it', S.a && S.a.margin === 21.5 && S.a.src === 'saved', JSON.stringify(S.a));
if (hops.length >= 2) {
  ok('…and one whose signature has moved is stale, not a figure',
     S.b && S.b.margin == null && S.b.stale === true && S.missing.some(m => m.from === hops[1].from && m.to === hops[1].to && m.stale),
     JSON.stringify(S.b));
}
await P2.context.close();

// ── 7. a new site ────────────────────────────────────────────────────────────
console.log('\nA new site');

const k = { lat: 111132.92, lon: 111412.84 * Math.cos(pick.lat * Math.PI / 180) };
const typed = { lat: +(pick.lat + 3000 / k.lat).toFixed(5), lon: +(pick.lon + 2000 / k.lon).toFixed(5) };
// One box for both: the same one the station was found in reads a lat, lon,
// says what it has understood, and Enter takes it.
const reads = await page.evaluate(() => ({
  boxes: document.querySelectorAll('.mn-mapctl[data-panel="bestrep"] input[type="search"], .mn-mapctl[data-panel="bestrep"] input[type="text"]').length,
  hint: (document.getElementById('bestrep-find-hint')?.textContent || '').replace(/\s+/g, ' '),
  plain: MapBestRepeater.parsePoint('-17.5, 145.9'), hemi: MapBestRepeater.parsePoint('17.5S 145.9E'),
  pre: MapBestRepeater.parsePoint('S17.5 E145.9'), swap: MapBestRepeater.parsePoint('145.9E 17.5S'),
  dms: MapBestRepeater.parsePoint('17°30\'00"S 145°54\'00"E'), spaces: MapBestRepeater.parsePoint('-17.5 145.9'),
  north: MapBestRepeater.parsePoint('17.5N 145.9E'), number: MapBestRepeater.parsePoint('541155'),
  off: MapBestRepeater.parsePoint('95, 200'),
}));
const nearPt = p => p && Math.abs(p.lat + 17.5) < 1e-9 && Math.abs(p.lon - 145.9) < 1e-9;
ok('the panel has one box for a station or a new site, with a hint under it',
   reads.boxes === 1 && /latitude, longitude/.test(reads.hint) && /ALERT address/.test(reads.hint), JSON.stringify(reads.boxes) + ' ' + reads.hint.slice(0, 120));
ok('it reads a lat, lon the common ways: signed, with N S E W before or after, either order, and in degrees minutes seconds',
   nearPt(reads.plain) && nearPt(reads.hemi) && nearPt(reads.pre) && nearPt(reads.swap) && nearPt(reads.dms) && nearPt(reads.spaces)
   && reads.north && reads.north.lat === 17.5, JSON.stringify(reads));
ok('a station number is not a position, and a latitude past 90 is refused', reads.number === null && reads.off === null);
await page.fill('#bestrep-find', `${typed.lat}, ${typed.lon}`);
const offer = await page.evaluate(() => (document.getElementById('bestrep-hits')?.textContent || '').replace(/\s+/g, ' '));
ok('typing a lat, lon says it is a new site, where, and how far from the nearest station',
   /New site at/.test(offer) && /km from/.test(offer), offer.slice(0, 160));
await page.press('#bestrep-find', 'Enter');
await page.waitForTimeout(300);
const pt = await page.evaluate(() => ({ site: MapBestRepeater.site(), choices: MapBestRepeater.choices(), radio: MapBestRepeater.radio() }));
ok('a lat, lon typed is a new site of its own, nothing carrying it',
   pt.site && pt.site.kind === 'point' && pt.site.lat === typed.lat && pt.site.lon === typed.lon
   && pt.choices.length > 0 && pt.choices.every(c => !c.carries), JSON.stringify(pt.site));
ok('…on the network\'s commonest radio, at its own antenna height', pt.radio && pt.radio.common && !pt.radio.typedAgl, JSON.stringify(pt.radio));
await page.locator('#bestrep-run').click();
await done();
const N = await page.evaluate(() => ({ status: MapBestRepeater.status(), n: MapBestRepeater.results().length,
  text: document.getElementById('bestrep-status')?.textContent.replace(/\s+/g, ' ') || '' }));
ok('…and it is answered', N.status.kind === 'done' && N.n === pt.choices.length && /is the best of/.test(N.text), N.text.slice(0, 200));

await page.fill('#bestrep-find', '95, 200');
const badList = await page.evaluate(() => (document.getElementById('bestrep-hits')?.textContent || '').replace(/\s+/g, ' '));
await page.press('#bestrep-find', 'Enter');
const bad = await page.evaluate(() => document.getElementById('bestrep-status')?.textContent || '');
ok('a lat, lon it cannot read is said to be, under the box and on Enter',
   /cannot be read/.test(badList) && /latitude, longitude/.test(bad), badList.slice(0, 120) + ' | ' + bad);
await page.fill('#bestrep-find', 'zzz-no-such-station');
const none = await page.evaluate(() => (document.getElementById('bestrep-hits')?.textContent || '').replace(/\s+/g, ' '));
ok('a name nothing matches says so and how to give a new site', /No station/.test(none) && /latitude, longitude/.test(none), none.slice(0, 140));
await page.fill('#bestrep-find', '');

// Picked on the map: a real click on open ground.
await page.evaluate(p => state.map.setView([p.lat, p.lon], 12, { animate: false }), typed);
await page.waitForTimeout(300);
await page.locator('#bestrep-arm').click();
const where = await page.evaluate(() => {
  const r = state.map.getContainer().getBoundingClientRect();
  const x = Math.round(r.left + r.width * 0.62), y = Math.round(r.top + r.height * 0.41);
  const ll = state.map.containerPointToLatLng([x - r.left, y - r.top]);
  const one = state.map.containerPointToLatLng([x - r.left + 1, y - r.top + 1]);
  return { x, y, lat: ll.lat, lon: ll.lng, px: Math.max(Math.abs(one.lat - ll.lat), Math.abs(one.lng - ll.lng)),
           armed: MapBestRepeater.armed(),
           cursor: state.map.getContainer().classList.contains('mn-bestrep-picking') };
});
ok('Pick on the map arms, with the crosshair', where.armed && where.cursor, JSON.stringify(where));
await page.mouse.click(where.x, where.y);
await page.waitForTimeout(300);
const clicked = await page.evaluate(() => ({ site: MapBestRepeater.site(), armed: MapBestRepeater.armed() }));
// Within a pixel: the pointer lands on whole pixels, the map's sum on fractions.
ok('…and the click is the new site, and disarms it',
   clicked.site && clicked.site.kind === 'point' && Math.abs(clicked.site.lat - where.lat) <= where.px
   && Math.abs(clicked.site.lon - where.lon) <= where.px && !clicked.armed, JSON.stringify({ clicked, where }));

// ── 8. the card ──────────────────────────────────────────────────────────────
console.log('\nThe card');

await page.evaluate(id => { state.selectedId = id; rerenderStationCarriersCard(); }, pick.id);
const link = page.locator('#stations-carriers-card button', { hasText: 'Find the best repeater for it' });
ok('Repeaters listening offers the station to the finder', await link.count() === 1);
if (await link.count()) {
  await link.evaluate(b => b.click());
  await page.waitForTimeout(500);
}
const handed = await page.evaluate(() => ({ site: MapBestRepeater.site(), showing: dockShowing() }));
ok('…and pressing it puts that station in the panel, open', handed.site && handed.site.id === pick.id && handed.showing === 'map-bestrep',
   JSON.stringify(handed));

// ── 9. reset ─────────────────────────────────────────────────────────────────
console.log('\nReset');

await page.evaluate(() => MapBestRepeater.run());
await page.waitForFunction(() => MapBestRepeater.status().kind === 'done', null, { timeout: RUN_TIMEOUT });
await page.evaluate(() => document.querySelector('.mn-map-reset')?.click());
if (await asking(page)) await answer(page, true);
await page.waitForTimeout(400);
const after = await page.evaluate(() => {
  let ours = 0;
  state.map.eachLayer(l => { if (!(l instanceof L.Renderer) && l.options && /^mnBest/.test(l.options.pane || '')) ours++; });
  return { site: MapBestRepeater.site(), results: MapBestRepeater.results().length, ours,
           legend: /Best repeater/.test(document.getElementById('map-legend')?.textContent || '') };
});
ok('↺ takes the station, the answer and everything drawn for them away',
   !after.site && after.results === 0 && after.ours === 0 && !after.legend, JSON.stringify(after));

ok('nothing threw', errors.length === 0, errors.join('\n'));

await browser.close();
await server.close();
console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
