// 🔁 Repeaters: a link's ground and its link budget (repeaters.js, "A link's
// ground and budget").
//
// A link pressed on the Repeaters map — or "profile & budget" beside one in an
// opened row — opens the ground between its two ends and the link budget each
// way it carries traffic, under the map. Its whole promise is that it is the
// Stations map's figure, not a second opinion of its own, so the oracle here is
// the Stations map: the same link opened there through the card's own hand-off
// button must give the same fade margin, A to B, to a twentieth of a decibel.
//
// The ground is terrainkit's hilly world (lib/terrarium.mjs), served for every
// terrain tile, so the profile has relief and the model has something to price;
// the pairs are real ones from the register, chosen where both ends have a
// surveyed height and a complete radio system, so nothing about them is made
// up here. Also held:
//
//   · pressing a link on the map opens the card, moves focus to it and draws
//     the link heavy; from the full-screen map, the dialog closes first;
//   · between two repeaters it is priced both ways, from a repeater to its base
//     one way, from the repeater — however it was asked for;
//   · every column adds up: EIRP, received signal and margin from the terms
//     above them, and the path loss is the same both ways;
//   · every marked word on the card has a meaning, and the page's word list
//     carries them;
//   · a failed ground says so, draws no flat profile, and Try again recovers;
//   · Escape and ✕ close it and hand focus back; a phone gets the whole card;
//   · the map's 🗺️ Layers: council areas (shaded on request), hubs, basins and
//     ground height, on both maps, out of the pointer's way, remembered apart
//     from the Stations map's switches.
//
//   node --run rptrpath      (or: npm run rptrpath)
//       npm run rptrpath -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { hillyTerrariumPng } from './lib/terrarium.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const J = v => JSON.stringify(v);
const near = (x, y, tol) => x != null && y != null && Math.abs(x - y) <= tol;

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page    = await context.newPage();
await applyNetworkPolicy(page, server.origin);
await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
  const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
  return route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(+m[1], +m[2], +m[3]),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
page.on('pageerror', e => errors.push(String(e)));

const until = (fn, arg, timeout = 30_000) => page.waitForFunction(fn, arg, { timeout });

await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await until(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, LOAD_TIMEOUT);
await page.evaluate(() => switchTab('repeaters'));
await until(() => !!Repeaters.state().map && !!Repeaters.state().layer && !!Repeaters.model());

// ── the pairs ────────────────────────────────────────────────────────────────
// Real links at the tab's own distance, ends with a surveyed height and every
// radio figure on file, so the Stations card's ends and this card's are the
// same ground and the same radio.
const pick = await page.evaluate(() => {
  const M = Repeaters.model();
  const full = s => { const k = radioKey(s), d = radioDefaults(s); return ['tx_w', 'gain_dbi', 'loss_db', 'rx_dbm', 'agl_m'].every(x => radioVal(k, d, x) != null); };
  const good = s => s.elevation_ahd != null && full(s);
  const of = p => p && { a: p.a.id, b: p.b.id, an: p.a.name, bn: p.b.name, km: p.km };
  const rr = M.pairs.filter(p => p.kind === 'repeater' && good(p.a) && good(p.b) && p.km > 8);
  const rb = M.pairs.filter(p => p.kind === 'base' && good(p.a) && good(p.b) && p.km > 8);
  return { rr: of(rr[0]), rr2: of(rr.find(p => p.a.id !== rr[0].a.id && p.b.id !== rr[0].b.id) || rr[1]), rb: of(rb[0]) };
});
ok('the register has a repeater-to-repeater link and a repeater-to-base link to price', !!(pick.rr && pick.rr2 && pick.rb), J(pick));
if (!pick.rr || !pick.rr2 || !pick.rb) {
  await browser.close(); await server.close();
  console.log(`\nFAIL — no pairs to test.`);
  process.exit(1);
}

// Press a link: the hit line the map draws for it, fired as Leaflet fires a
// click — on the page map, or the full-screen one.
const pressLink = (p, full = false) => page.evaluate(({ a, b, full }) => {
  const S = Repeaters.state();
  const layer = full ? S.flayer : S.layer;
  let hit = null;
  layer.eachLayer(l => { if (l.mnPath && ((l.mnPath[0] === a && l.mnPath[1] === b) || (l.mnPath[0] === b && l.mnPath[1] === a))) hit = l; });
  if (!hit) return false;
  hit.fire('click');
  return true;
}, { ...p, full });
const ready = (a, b) => until(({ a, b }) => {
  const r = Repeaters.pathReport();
  return r && r.a === a && r.b === b && (r.status === 'ready' || r.status === 'failed');
}, { a, b });

// ── 1. from the map ──────────────────────────────────────────────────────────
ok('the map draws a link a press can land on', await pressLink(pick.rr));
await ready(pick.rr.a, pick.rr.b);
const R1 = await page.evaluate(() => Repeaters.pathReport());
ok('the link pressed opens its card, its ground read and the model run over it', R1.status === 'ready', J({ status: R1.status, error: R1.error }));
const card1 = await page.evaluate(() => {
  const el = document.getElementById('rptr-path');
  if (!el) return null;
  const svg = el.querySelector('svg.path-chart');
  const heads = [...el.querySelectorAll('.rptr-lb thead th')].map(th => th.textContent.trim());
  const margins = [...el.querySelectorAll('.rptr-lb tfoot td.lb-num')].map(td => td.firstChild.textContent.trim());
  const terms = [...el.querySelectorAll('.term')].map(t => ({ text: t.textContent.trim(), title: t.getAttribute('title') || '' }));
  const words = [...document.querySelectorAll('.rd-words dt')].map(d => d.textContent.trim());
  let heavy = 0;
  Repeaters.state().layer.eachLayer(l => {
    if (!l.getLatLngs || l.options.interactive || l.options.weight !== 5) return;
    heavy++;
  });
  return {
    focused: document.activeElement === el,
    title: (el.querySelector('#rptr-path-h') || {}).textContent || '',
    chart: !!svg && svg.getAttribute('role') === 'img' && /^Ground profile over /.test(svg.getAttribute('aria-label') || ''),
    ground: svg ? svg.querySelectorAll('path[fill="var(--terrain-fill)"]').length : 0,
    zone: svg ? svg.querySelectorAll('polyline[stroke-dasharray="4 3"]').length : 0,
    viewW: svg ? Number(svg.getAttribute('viewBox').split(' ')[2]) : 0,
    boxW: (el.querySelector('.rptr-path-chart') || {}).clientWidth || 0,
    // The ground past each end: where A and B stand across the plot, the
    // veils over the plot past them, and the key's chip.
    ax: svg ? Number(svg.dataset.aX) : null, bx: svg ? Number(svg.dataset.bX) : null,
    veils: svg ? svg.querySelectorAll('.path-beyond').length : 0,
    beyondGround: svg ? svg.querySelectorAll('path.path-beyond-ground').length : 0,
    key: (el.querySelector('.path-key') || {}).textContent || '',
    heads, margins, terms, words, heavy,
    stn: !!el.querySelector('#rptr-path-stn'),
  };
});
ok('the card is under the map, and focus moved to it', !!card1 && card1.focused, J(card1 && { focused: card1.focused }));
ok('its heading names both ends, both ways', card1 && card1.title.includes(pick.rr.an) && card1.title.includes(pick.rr.bn) && card1.title.includes('↔'), card1 && card1.title);
ok('the ground is drawn: a chart with its words, the ground and the Fresnel zone either side of the line',
  card1 && card1.chart && card1.ground >= 1 && card1.zone === 2, J(card1 && { chart: card1.chart, ground: card1.ground, zone: card1.zone }));
ok('the chart is drawn to the width its box has', card1 && Math.abs(card1.viewW - card1.boxW) <= 4, J(card1 && { viewW: card1.viewW, boxW: card1.boxW }));
// The plot runs on a little past both ends, as the Stations map's card does:
// A and B a little in from its edges (52 and 14 are pathChartSvg's margins),
// the ground past them drawn, faded under a veil, and named in the key.
ok('the chart runs on a little past both ends, the ground there drawn under a veil and named in the key',
  card1 && card1.ax > 52 + 4 && card1.bx < card1.viewW - 14 - 4
    && card1.ax - 52 < 0.12 * (card1.viewW - 66) && card1.viewW - 14 - card1.bx < 0.12 * (card1.viewW - 66)
    && card1.veils === 2 && card1.beyondGround >= 2 && /Ground past each end · [\d.]+ k?m, for context/.test(card1.key),
  J(card1 && { ax: card1.ax, bx: card1.bx, viewW: card1.viewW, veils: card1.veils, beyondGround: card1.beyondGround, key: card1.key }));
ok('the link is drawn heavy on the map', card1 && card1.heavy === 1, J(card1 && card1.heavy));
ok('between two repeaters it is priced both ways', R1.kind === 'repeater' && R1.ways.length === 2
  && R1.ways[0].from === pick.rr.a && R1.ways[1].from === pick.rr.b, J(R1.ways.map(w => [w.from, w.to])));
ok('…a column a way, headed by who sends to whom', card1 && card1.heads.length === 2
  && card1.heads[0] === `${pick.rr.an} → ${pick.rr.bn}` && card1.heads[1] === `${pick.rr.bn} → ${pick.rr.an}`, J(card1 && card1.heads));
ok('every margin is worked out', R1.ways.every(w => w.margin != null && isFinite(w.margin)), J(R1.ways.map(w => w.margin)));
const adds = w => near(w.eirp, w.txDbm + w.txGain - w.txLoss, 1e-9)
  && near(w.rx, w.eirp - w.pathLoss + w.rxGain - w.rxLoss, 1e-9) && near(w.margin, w.rx - w.thr, 1e-9);
ok('each column adds up: EIRP, received signal and margin from the terms above', R1.ways.every(adds), J(R1.ways));
ok('the path loss is the same both ways', near(R1.ways[0].pathLoss, R1.ways[1].pathLoss, 1e-9));
ok('the path loss is more than free space over hills', R1.ways[0].pathLoss > R1.ways[0].fspl, J(R1.ways[0]));
const shown = s => Number(String(s).replace('−', '-'));
ok('the table shows the margins it worked out', card1 && card1.margins.length === 2
  && card1.margins.every((s, i) => Math.abs(shown(s) - R1.ways[i].margin) <= 0.051), J(card1 && card1.margins));
const thin = (card1 ? card1.terms : []).filter(t => t.title.length < 40 || t.title.toLowerCase() === t.text.toLowerCase());
ok('every marked word on the card has a meaning', card1 && card1.terms.length >= 10 && !thin.length, J(thin.length ? thin : card1 && card1.terms.length));
const want = ['Fade margin', 'EIRP', 'Path loss', 'RX threshold', '60% Fresnel zone', 'Field allowance', 'Ground past each end'];
ok('the page\'s word list carries the card\'s words', want.every(w => card1 && card1.words.includes(w)), J(want.filter(w => !(card1 && card1.words.includes(w)))));
ok('the card offers the Stations map', card1 && card1.stn);

// ── 2. the Stations map's figure is the same figure ─────────────────────────
await page.click('#rptr-path-stn');
await until(() => state.activeTab === 'stations' && typeof MapBackbone !== 'undefined' && !!MapBackbone.current());
await until(() => { const r = LinkBudget.current(); return !!(r && r.itm); }, null, 45_000);
const lb = await page.evaluate(() => {
  const r = LinkBudget.current(), c = MapBackbone.current();
  return { margin: r.margin, pathLoss: r.pathLoss, fMhz: r.fMhz, cur: c, a: state.link.a && state.link.a.sid, b: state.link.b && state.link.b.sid };
});
ok('the hand-off opens the same path on the Stations map, from the same end', lb.cur && lb.cur.aId === pick.rr.a && lb.cur.bId === pick.rr.b
  && lb.a === pick.rr.a && lb.b === pick.rr.b, J(lb));
ok('…at the same frequency', near(lb.fMhz, R1.fMhz, 1e-9), J({ stations: lb.fMhz, repeaters: R1.fMhz }));
ok('…with the same path loss', near(lb.pathLoss, R1.ways[0].pathLoss, 0.05), J({ stations: lb.pathLoss, repeaters: R1.ways[0].pathLoss }));
ok('…and the same fade margin, A to B — one figure, not two', near(lb.margin, R1.ways[0].margin, 0.05), J({ stations: lb.margin, repeaters: R1.ways[0].margin }));

// ── 3. back again: still open, not read again ───────────────────────────────
await page.evaluate(() => switchTab('repeaters'));
await until(() => !!Repeaters.state().map && !!document.getElementById('rptr-path'));
const back = await page.evaluate(() => ({ r: Repeaters.pathReport(), chart: !!document.querySelector('#rptr-path svg.path-chart') }));
ok('back on the tab the link is still open, drawn at once', back.r && back.r.status === 'ready' && back.r.a === pick.rr.a && back.chart, J(back.r && back.r.status));

// ── 4. Escape closes it and hands focus back ────────────────────────────────
await page.focus('#rptr-path');
await page.keyboard.press('Escape');
const esc1 = await page.evaluate(() => ({ open: !!document.getElementById('rptr-path'), path: Repeaters.state().path,
  focus: document.activeElement && (document.activeElement.id || document.activeElement.className) }));
ok('Escape closes the card', !esc1.open && !esc1.path, J(esc1));
ok('…and focus goes back to the map, which opened it', /rptr-map|leaflet-container/.test(String(esc1.focus)), J(esc1.focus));

// ── 5. from a row: a repeater to its base, one way, from the repeater ───────
await page.evaluate(id => Repeaters.goTo(id), pick.rb.a);
const btnId = `rptr-pb-${pick.rb.a}-${pick.rb.b}`;
ok('an opened row offers its links\' profile and budget', await page.evaluate(id => !!document.getElementById(id), btnId), btnId);
await page.click(`[id="${btnId}"]`);
await ready(pick.rb.a, pick.rb.b);
const R2 = await page.evaluate(() => Repeaters.pathReport());
const t2 = await page.evaluate(() => (document.getElementById('rptr-path-h') || {}).textContent || '');
ok('a repeater to its base is priced one way, repeater first', R2.status === 'ready' && R2.kind === 'base' && R2.ways.length === 1
  && R2.ways[0].from === pick.rb.a && R2.ways[0].to === pick.rb.b && t2.includes('→'), J({ status: R2.status, kind: R2.kind, ways: R2.ways.map(w => [w.from, w.to]) }));
ok('…and adds up', R2.ways.every(adds), J(R2.ways));
await page.click('#rptr-path-x');
const x1 = await page.evaluate(id => ({ open: !!document.getElementById('rptr-path'), focus: document.activeElement && document.activeElement.id }), btnId);
ok('✕ closes it and focus goes back to the row\'s button', !x1.open && x1.focus === btnId, J(x1));
await page.evaluate(({ a, b }) => Repeaters.openPath(b, a), pick.rb);
await ready(pick.rb.a, pick.rb.b);
const R3 = await page.evaluate(() => Repeaters.pathReport());
ok('asked for base first, it is still priced from the repeater', R3.a === pick.rb.a && R3.b === pick.rb.b && R3.ways[0].from === pick.rb.a, J({ a: R3.a, b: R3.b }));

// ── 6. no ground: said, not drawn flat; Try again ───────────────────────────
await page.evaluate(() => { window.__pathGround = pathGround; pathGround = async () => ({ ok: false, error: 'test: the tile server is down' }); });
await page.evaluate(({ a, b }) => Repeaters.openPath(a, b), pick.rr2);
await ready(pick.rr2.a, pick.rr2.b);
const f1 = await page.evaluate(() => {
  const el = document.getElementById('rptr-path');
  return { r: Repeaters.pathReport(), text: el ? el.textContent : '', chart: !!(el && el.querySelector('svg.path-chart')), retry: !!document.getElementById('rptr-path-retry') };
});
ok('no ground says so, with the reason, and draws no profile', f1.r.status === 'failed' && /Terrain data unavailable/.test(f1.text)
  && /tile server is down/.test(f1.text) && !f1.chart && f1.retry, J({ status: f1.r.status, chart: f1.chart }));
await page.evaluate(() => { pathGround = window.__pathGround; });
await page.click('#rptr-path-retry');
await until(() => { const r = Repeaters.pathReport(); return r && r.status === 'ready'; });
ok('Try again reads it once the ground is there', await page.evaluate(() => !!document.querySelector('#rptr-path svg.path-chart')));

// ── 7. from the full-screen map ─────────────────────────────────────────────
await page.evaluate(() => Repeaters.closePath());
await page.evaluate(() => Repeaters.openFull());
await until(() => !!Repeaters.state().fmap && !!Repeaters.state().flayer);
ok('the full-screen map draws the links to press too', await pressLink(pick.rr, true));
await until(() => !Repeaters.state().fmap && !!Repeaters.pathReport());
await ready(pick.rr.a, pick.rr.b);
const fs = await page.evaluate(() => ({ modal: !!document.querySelector('#rptr-mapfull'), card: !!document.getElementById('rptr-path'), r: Repeaters.pathReport() }));
ok('pressed full screen, the dialog closes and the card opens under the page map', !fs.modal && fs.card && fs.r.status === 'ready', J({ modal: fs.modal, card: fs.card }));

// ── 7b. the map's overlays (🗺️ Layers on the map) ──────────────────────────
// Four of the Stations map's layers, drawn by their own modules on this map:
// council areas (shaded on request), maintenance hubs, drainage basins and
// ground height. Off to begin with; on in the page map and the full-screen
// one alike; remembered apart from the Stations map's switches; off again
// takes them down; nothing takes the pointer a link or a repeater wants. The
// link card from step 7 stays open under the map for step 8.
const lay0 = await page.evaluate(() => {
  const el = Repeaters.state().map.getContainer();
  return {
    boxes: [...el.querySelectorAll('[data-rptr-lay]')].map(b => `${b.dataset.rptrLay}:${b.checked}`),
    base: !!el.querySelector('.mn-mapctl[data-panel="display"] [data-base-map]'),
    drawn: el.querySelectorAll('.leaflet-mnCouncils-pane path, .leaflet-mnHubs-pane path, .leaflet-mnCatchments-pane path').length,
  };
});
ok('the map\'s 🗺️ Layers carries the base maps and the overlays, all off to begin with',
  lay0.base && lay0.boxes.length === 5 && lay0.boxes.every(b => b.endsWith(':false')) && lay0.drawn === 0, J(lay0));
await page.evaluate(() => { for (const k of ['councils', 'shade', 'hubs', 'basins', 'elev']) Repeaters.setLayer(k, true); });
await until(() => {
  const el = Repeaters.state().map.getContainer();
  return el.querySelectorAll('.leaflet-mnCouncils-pane path').length > 500 && el.querySelectorAll('.leaflet-mnHubs-pane path').length === 8
    && el.querySelectorAll('.leaflet-mnCatchments-pane path').length >= 77 && el.querySelectorAll('.leaflet-mnElevation-pane canvas').length > 0;
});
const lay1 = await page.evaluate(() => {
  const el = Repeaters.state().map.getContainer();
  const paths = [...el.querySelectorAll('.leaflet-mnCouncils-pane path, .leaflet-mnHubs-pane path, .leaflet-mnCatchments-pane path')];
  const councils = [...el.querySelectorAll('.leaflet-mnCouncils-pane path')];
  return {
    interactive: paths.filter(p => p.classList.contains('leaflet-interactive')).length,
    panes: ['mnCouncils', 'mnHubs', 'mnCatchments'].map(n => getComputedStyle(Repeaters.state().map.getPane(n)).pointerEvents),
    shaded: councils.filter(p => Number(p.getAttribute('fill-opacity')) > 0).length === councils.length,
    key: document.querySelector('[data-rptr-key]').textContent,
    boxes: [...el.querySelectorAll('[data-rptr-lay]')].every(b => b.checked),
    stored: JSON.parse(localStorage.getItem('mn-rpt-layers') || '{}'),
    stations: state.mapCouncils || state.mapHubs || state.mapCatchments || state.mapElev,
  };
});
ok('on, each overlay draws on the page map, none taking the pointer', lay1.interactive === 0 && lay1.panes.every(p => p === 'none'), J(lay1.panes));
ok('council shading fills every council area', lay1.shaded);
ok('the key names the boundaries that are on, and the switches agree', /Council area boundary/.test(lay1.key)
  && /Maintenance hub boundary/.test(lay1.key) && /Drainage basin/.test(lay1.key) && lay1.boxes, lay1.key.replace(/\s+/g, ' '));
ok('the choice is remembered on this device, apart from the Stations map\'s', lay1.stored.councils === true && lay1.stored.elev === true
  && !lay1.stations, J({ stored: lay1.stored, stations: lay1.stations }));
await page.evaluate(() => Repeaters.layOpacity('shadeOp', 0.5, true));
ok('the shading slider restyles in place', await page.evaluate(() =>
  Repeaters.state().map.getContainer().querySelector('.leaflet-mnCouncils-pane path').getAttribute('fill-opacity') === '0.5'));
await page.evaluate(() => Repeaters.openFull());
await until(() => !!Repeaters.state().fmap && Repeaters.state().fmap.getContainer().querySelectorAll('.leaflet-mnCouncils-pane path').length > 500);
const layF = await page.evaluate(() => {
  const el = Repeaters.state().fmap.getContainer();
  return { hubs: el.querySelectorAll('.leaflet-mnHubs-pane path').length, boxes: el.querySelectorAll('[data-rptr-lay]:checked').length };
});
ok('full screen draws the same overlays, its switches ticked', layF.hubs === 8 && layF.boxes === 5, J(layF));
await page.evaluate(() => { Repeaters.setLayer('councils', false); Repeaters.setLayer('hubs', false); });
const layOff = await page.evaluate(() => [Repeaters.state().map, Repeaters.state().fmap].map(m =>
  m.getContainer().querySelectorAll('.leaflet-mnCouncils-pane path, .mn-council-label, .leaflet-mnHubs-pane path, .mn-hub-label').length));
ok('off takes the councils and hubs down from both maps', layOff.every(n => n === 0), J(layOff));
await page.evaluate(() => Repeaters.closeFull());
await until(() => !Repeaters.state().fmap);
ok('closing full screen lets its map\'s overlays go', await page.evaluate(() => Repeaters.state().lh.size === 1));
await page.evaluate(() => { for (const k of ['shade', 'basins', 'elev']) Repeaters.setLayer(k, false); });

// ── 8. a phone ──────────────────────────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const phone = await page.evaluate(() => {
  const el = document.getElementById('rptr-path');
  const svg = el && el.querySelector('svg.path-chart');
  const box = el && el.querySelector('.rptr-path-chart');
  return { cardOver: el ? el.scrollWidth - el.clientWidth : -1, pageOver: document.documentElement.scrollWidth - window.innerWidth,
           cardW: el ? Math.round(el.getBoundingClientRect().width) : 0,
           viewW: svg ? Number(svg.getAttribute('viewBox').split(' ')[2]) : 0, boxW: box ? box.clientWidth : 0 };
});
// Two long station names heading the budget's columns once held the table —
// and with it the whole page — at 650 px on a 390 px screen.
ok('on a phone the card fits the screen, and the page does not scroll sideways', phone.cardOver <= 1 && phone.pageOver <= 0
  && phone.cardW <= 390, J(phone));
ok('…and the chart is drawn again to the narrower box', phone.boxW > 0 && Math.abs(phone.viewW - Math.max(320, phone.boxW)) <= 4, J(phone));

ok('nothing threw for the whole run', errors.length === 0, errors.join('\n         '));

await browser.close();
await server.close();

console.log(failures
  ? `\nFAIL — ${failures} of ${failures + passes} assertions about the Repeaters tab's ground profile and link budget.`
  : `\nPASS — ${passes} assertions: a link pressed on the Repeaters map opens its ground and its budget each way,\n`
    + '       and the fade margin is the Stations map\'s own figure.');
process.exit(failures ? 1 : 0);
