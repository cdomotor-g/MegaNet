// ⚖️ Repeater comparison (map-repcompare.js), held to what it claims.
//
// On the terrain kit's hilly world and the committed register, like the best
// repeater finder's check beside it:
//
//   0. the panel    a pane of the side panel, opened with a real click on ⚖️
//                   in its strip, in Tools straight after 🎯 — Compare off,
//                   with a reason, until two repeaters are in; the words of
//                   the panel listed in a fold as well as on hover.
//   1. picking      a repeater typed and picked from the list (only repeaters
//                   are offered), a field station refused, the map selection
//                   added with what is not a repeater left out and said to be.
//   2. the answer   the shared sites are exactly the stations two or more of
//                   the picked repeaters carry by repeaterPathsOf — the list
//                   🗼 and 🚚 keep — and "only it" the rest of each one's;
//                   every cell the path priced afresh to the last bit, with
//                   its picture kept; best and gap what the figures say.
//   3. a row        a real click moves the map to the site, marks the row,
//                   draws its paths heavy and opens the table of its paths
//                   with a picture and a ↗ each; ↗ puts that path on the
//                   profile card's line.
//   4. the CSV      a line for every shared site against every repeater.
//   5. the rail     live while repeaters are picked; 🧹 Clear the selection
//                   takes all of it off.
//
//   npm run repcompare          (or: node repcompare.mjs)
//   npm run repcompare -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { hillyTerrariumPng } from './lib/terrarium.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const RUN_TIMEOUT = 240_000;

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const J = v => JSON.stringify(v);

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];

const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
await applyNetworkPolicy(page, server.origin);
await page.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, route => {
  const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
  return route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(+m[1], +m[2], +m[3]),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
page.on('pageerror', e => errors.push(String(e)));
await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
await page.evaluate(() => switchTab('stations'));
await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => !state.map._animatingZoom, null, { timeout: LOAD_TIMEOUT });

await page.click('#help-panel .dock-tab[data-dock="map-repcompare"]');
await page.waitForTimeout(400);

// ── 0. the panel ─────────────────────────────────────────────────────────────
console.log('\nThe panel');

const panel = await page.evaluate(() => {
  const wrap = document.querySelector('.mn-mapctl[data-panel="repcompare"]');
  const strip = [...document.querySelectorAll('#help-panel .dock-strip button')];
  const at = sel => strip.findIndex(b => b.matches(sel));
  const body = wrap && wrap.querySelector('.mn-mapctl-body');
  return {
    present: !!wrap, docked: !!wrap && !!wrap.closest('#help-panel .dock-pane'),
    shown: !!(body && body.getClientRects().length), showing: dockShowing(),
    title: wrap && wrap.querySelector('.mn-mapctl-title')?.textContent,
    group: strip.find(b => b.dataset.dock === 'map-repcompare')?.closest('.dock-group')?.dataset.group,
    afterBest: at('[data-dock="map-repcompare"]') === at('[data-dock="map-bestrep"]') + 1,
    runDisabled: document.getElementById('repcmp-run')?.disabled,
    status: document.getElementById('repcmp-status')?.textContent || '',
    words: document.querySelectorAll('.repcmp-panel .bestrep-words dt').length,
    live: MapRepCompare.live(),
  };
});
ok('⚖️ Repeater comparison is a pane of the side panel, open from its button in the strip',
   panel.present && panel.docked && panel.shown && panel.showing === 'map-repcompare' && panel.title === 'Repeater comparison', J(panel));
ok('…in the tools group, straight after the best repeater finder', panel.group === 'tools' && panel.afterBest, J(panel));
ok('Compare is off with no repeaters, and the panel says what is missing',
   panel.runDisabled === true && /two or more repeaters/i.test(panel.status) && !panel.live, J(panel));
ok('the words of the panel are listed in a fold, a dozen or more', panel.words >= 12, String(panel.words));

// ── The world: the repeaters that share the most ─────────────────────────────
const world = await page.evaluate(() => {
  const K = state.mapMaxLinkKm > 0 ? state.mapMaxLinkKm : 100;
  const reps = state.data.stations.filter(s => Array.isArray(s.roles) && s.roles.includes('repeater') && s.repeater && s.lat != null);
  const carried = new Map(reps.map(r => [r.id, new Set(repeaterPathsOf(r, K).upTo.map(d => d.s).filter(s => s.lat != null).map(s => s.id))]));
  let best = null;
  for (let i = 0; i < reps.length; i++) for (let j = i + 1; j < reps.length; j++) {
    const a = reps[i], b = reps[j];
    const both = [...carried.get(a.id)].filter(id => carried.get(b.id).has(id));
    // Enough to be a grid, few enough to price inside the check's time.
    if (both.length >= 3 && both.length <= 10 && (!best || both.length > best.both.length)) best = { a, b, both };
  }
  if (!best) return null;
  // A third that shares something with either, so "two or more" is not "all".
  const third = reps.find(r => r.id !== best.a.id && r.id !== best.b.id
    && [...carried.get(r.id)].some(id => carried.get(best.a.id).has(id) || carried.get(best.b.id).has(id))
    && [...carried.get(r.id)].filter(id => carried.get(best.a.id).has(id) || carried.get(best.b.id).has(id)).length <= 12) || null;
  const field = state.data.stations.find(s => Array.isArray(s.roles) && !s.roles.includes('repeater') && !s.roles.includes('base') && s.lat != null);
  const pick = r => ({ id: r.id, name: r.name, number: r.station_number || '' });
  return { a: pick(best.a), b: pick(best.b), third: third ? pick(third) : null, field: pick(field),
           carried: Object.fromEntries([best.a, best.b, third].filter(Boolean).map(r => [r.id, [...carried.get(r.id)]])) };
});
if (!world) {
  console.log('  FAIL no two repeaters in the register share three to ten sites — nothing to compare');
  await browser.close(); await server.close(); process.exit(1);
}
if (VERBOSE) console.log(`  (comparing ${world.a.name}, ${world.b.name}${world.third ? `, ${world.third.name}` : ''})`);

// ── 1. picking ───────────────────────────────────────────────────────────────
console.log('\nPicking the repeaters');

await page.fill('#repcmp-find', world.a.name);
const offered = await page.evaluate(() => [...document.querySelectorAll('#repcmp-hits .polar-hit span:first-child')].map(e => e.textContent));
ok('typing a name offers that repeater', offered.includes(world.a.name), J(offered));
await page.fill('#repcmp-find', world.field.name);
const offeredField = await page.evaluate(n => [...document.querySelectorAll('#repcmp-hits .polar-hit span:first-child')].some(e => e.textContent === n), world.field.name);
ok('…and never a station that is not a repeater', !offeredField);
await page.fill('#repcmp-find', world.a.name);
await page.locator('#repcmp-hits .polar-hit', { hasText: world.a.name }).first().click();
const one = await page.evaluate(() => ({ reps: MapRepCompare.repeaters(), run: document.getElementById('repcmp-run')?.disabled,
  status: document.getElementById('repcmp-status')?.textContent || '', live: MapRepCompare.live(),
  box: document.getElementById('repcmp-find')?.value }));
ok('a click on it puts it in the list, the box emptied, and the rail is told something is on',
   J(one.reps) === J([world.a.id]) && one.live && one.box === '', J(one));
ok('one repeater is not a comparison: Compare stays off and says so', one.run === true && /one more/i.test(one.status), J(one));

// The map selection: the second repeater and a field station; one goes in.
await page.evaluate(w => { state.mapSelection = new Set([w.b.id, w.field.id]); MapRepCompare.addSelection(); }, world);
const two = await page.evaluate(() => ({ reps: MapRepCompare.repeaters(), run: document.getElementById('repcmp-run')?.disabled,
  note: document.getElementById('repcmp-note')?.textContent || '', chosen: document.querySelectorAll('.repcmp-chosen li').length }));
ok('Add the map selection takes the repeater in it and leaves the field station out, saying so',
   J(two.reps) === J([world.a.id, world.b.id]) && two.chosen === 2 && /Added 1 repeater/.test(two.note) && /not a repeater/.test(two.note), J(two));
ok('with two in, Compare is on', two.run === false, J(two));
if (world.third) {
  await page.evaluate(id => { state.mapSelection = new Set(); selectStation(id); }, world.third.id);
  await page.locator('.repcmp-panel button', { hasText: 'Add the selected repeater' }).click();
  const three = await page.evaluate(() => MapRepCompare.repeaters());
  ok('Add the selected repeater takes the station selected', J(three) === J([world.a.id, world.b.id, world.third.id]), J(three));
}

// ── 2. the answer ────────────────────────────────────────────────────────────
console.log('\nThe answer');

await page.locator('#repcmp-run').click();
await page.waitForFunction(() => MapRepCompare.status().done, null, { timeout: RUN_TIMEOUT });
const res = await page.evaluate(() => MapRepCompare.results());
const ids = [world.a.id, world.b.id, ...(world.third ? [world.third.id] : [])];
const want = new Map();
for (const id of ids) for (const sid of world.carried[id]) { if (sid === id) continue; (want.get(sid) || want.set(sid, []).get(sid)).push(id); }
const shared = [...want].filter(([, on]) => on.length >= 2);
ok('the rows are exactly the sites two or more of them carry by their pass ranges',
   res.rows.length === shared.length && shared.every(([sid, on]) => { const r = res.rows.find(x => x.id === sid); return r && J(r.on.slice().sort()) === J(on.slice().sort()); }),
   `${res.rows.length} rows, ${shared.length} wanted`);
ok('…and each repeater\'s "only it" the sites nobody else here carries',
   res.reps.every(h => J(h.only.slice().sort()) === J([...want].filter(([, on]) => on.length === 1 && on[0] === h.id).map(([sid]) => sid).sort())));
ok('every repeater says how many it carries', res.reps.every(h => h.carried === world.carried[h.id].length), J(res.reps.map(h => h.carried)));

const cells = res.rows.flatMap(r => r.on.map(id => ({ sid: r.id, id, fig: r.figs[id] })));
ok('every path of every shared site has a figure or a reason', cells.length > 0 && cells.every(c => c.fig && (c.fig.failed || c.fig.colo || c.fig.margin != null)),
   J(cells.filter(c => !c.fig)));
const priced = cells.filter(c => c.fig && !c.fig.failed && !c.fig.colo);
ok('most of them priced, each with its picture kept', priced.length >= cells.length / 2 && priced.every(c => c.fig.thumb), `${priced.length} of ${cells.length}`);
const sample = priced.slice(0, 4);
const again = await page.evaluate(async list => {
  const out = [];
  for (const c of list) { const f = await MapRepCompare.priceOne(c.sid, c.id); out.push(f ? { margin: f.margin, verdict: f.verdict, dKm: f.dKm } : null); }
  return out;
}, sample);
ok('a cell is the path priced afresh, to the last bit',
   sample.every((c, i) => again[i] && again[i].margin === c.fig.margin && again[i].verdict === c.fig.verdict && again[i].dKm === c.fig.dKm),
   J(sample.map((c, i) => [c.fig.margin, again[i] && again[i].margin])));
ok('best heard by is the repeater with the most margin, and the gap the best less the worst',
   res.rows.every(r => {
     const ms = r.on.map(id => ({ id, f: r.figs[id] })).filter(x => x.f && !x.f.failed && !x.f.colo && x.f.margin != null);
     if (!ms.length || r.on.some(id => r.figs[id] && r.figs[id].colo)) return true;
     const hi = Math.max(...ms.map(x => x.f.margin)), lo = Math.min(...ms.map(x => x.f.margin));
     return r.figs[r.best].margin === hi && Math.abs((r.spread || 0) - (hi - lo)) < 1e-9;
   }));

const grid = await page.evaluate(() => ({
  heads: [...document.querySelectorAll('#repcmp-grid thead th')].map(th => th.textContent.replace(/\s+/g, ' ').trim()),
  rows: document.querySelectorAll('#repcmp-grid tr.repcmp-row').length,
  stars: document.querySelectorAll('#repcmp-grid tr.repcmp-row .repcmp-star').length,
  bands: document.querySelectorAll('#repcmp-grid tr.repcmp-row .sites-band').length,
  sum: [...document.querySelectorAll('.repcmp-sum li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
  save: document.getElementById('repcmp-save')?.disabled,
  status: document.getElementById('repcmp-status')?.textContent || '',
  legend: MapRepCompare.active() && /Repeater comparison/.test(MapRepCompare.legendHtml()),
  terms: [...document.querySelectorAll('.repcmp-panel .term, .repcmp-panel .term-chip')].filter(e => !(e.getAttribute('title') || '').trim()).length,
}));
ok('the grid has the sites down the side and a column for each repeater, then Best heard by and Gap',
   grid.rows === res.rows.length && grid.heads.length === ids.length + 3 && grid.heads[0] === 'Site'
   && ids.every((id, i) => grid.heads[i + 1].includes(res.reps[i].name)) && grid.heads.at(-2) === 'Best heard by' && grid.heads.at(-1) === 'Gap', J(grid.heads));
ok('…a coloured margin in every priced cell and a ★ on each row\'s best', grid.bands >= priced.length && grid.stars >= 1, J([grid.bands, grid.stars]));
ok('each repeater has a line: carries, shared, only it', grid.sum.length === ids.length && grid.sum.every(t => /carries \d+/.test(t) && /shared \d+/.test(t) && /only it \d+/.test(t)), J(grid.sum));
ok('the status counts the shared sites, Save CSV is on, and the map\'s legend has its line',
   new RegExp(`^${res.rows.length} site`).test(grid.status.trim()) && grid.save === false && grid.legend, J(grid));
ok('every marked word on the panel has a meaning on hover', grid.terms === 0, String(grid.terms));

// ── 3. a row ─────────────────────────────────────────────────────────────────
console.log('\nA row');

const target = res.rows.find(r => r.on.some(id => r.figs[id] && !r.figs[id].failed && !r.figs[id].colo)) || res.rows[0];
await page.evaluate(() => state.map.setView([-20, 140], 9, { animate: false }));
await page.locator(`#repcmp-grid tr.repcmp-row[data-sid="${target.id}"]`).click();
await page.waitForTimeout(900);
const sel = await page.evaluate(sid => {
  const st = state.data.stations.find(s => s.id === sid);
  const row = document.querySelector(`#repcmp-grid tr.repcmp-row[data-sid="${CSS.escape(sid)}"]`);
  const det = row && row.nextElementSibling;
  const heavy = [];
  state.map.eachLayer(l => { if (l instanceof L.Polyline && !(l instanceof L.Polygon) && l.options.pane === 'mnRepCmpLines' && l.options.weight > 4) heavy.push(l.getLatLngs().map(p => [p.lat, p.lng])); });
  return {
    selected: MapRepCompare.selected(), pressed: row && row.getAttribute('aria-pressed'), on: row && row.classList.contains('is-on'),
    inView: state.map.getBounds().contains([st.lat, st.lon]), st: [st.lat, st.lon], heavy,
    detail: !!(det && det.classList.contains('repcmp-detail-row')),
    paths: det ? det.querySelectorAll('.sites-table-pics tbody tr').length : 0,
    pics: det ? det.querySelectorAll('.sites-thumb svg').length : 0,
    arrows: det ? det.querySelectorAll('button.btn-link').length : 0,
  };
}, target.id);
ok('a click on a row marks it and moves the map to the site', sel.selected === target.id && sel.pressed === 'true' && sel.on && sel.inView, J(sel));
ok('…with a heavy line from the site to every repeater that carries it',
   sel.heavy.length === target.on.length && sel.heavy.every(l => Math.abs(l[0][0] - sel.st[0]) < 1e-9 && Math.abs(l[0][1] - sel.st[1]) < 1e-9), J(sel.heavy));
const targetPriced = target.on.filter(id => target.figs[id] && !target.figs[id].failed && !target.figs[id].colo).length;
ok('…and the row opens to its paths, one a repeater, each with its ground profile and a ↗',
   sel.detail && sel.paths === target.on.length && sel.pics === targetPriced && sel.arrows >= targetPriced, J(sel));

const hubId = target.on.find(id => target.figs[id] && !target.figs[id].failed && !target.figs[id].colo);
if (hubId) {
  await page.locator('#repcmp-grid .repcmp-detail-row button.btn-link').first().click();
  await page.waitForTimeout(500);
  const prof = await page.evaluate(() => {
    const sh = state.draw.shapes.find(s => s.id === state.draw.selectedId);
    return { open: !!state.path.open, pts: sh ? sh.pts : null, still: MapRepCompare.selected() };
  });
  ok('↗ puts that path on the elevation profile card, the site first, and the row stays picked',
     prof.open && prof.pts && prof.pts.length === 2 && Math.abs(prof.pts[0][0] - sel.st[0]) < 1e-9 && prof.still === target.id, J(prof));
}

// ── 4. the CSV ───────────────────────────────────────────────────────────────
console.log('\nThe CSV');

const csv = await page.evaluate(() => MapRepCompare.csvText());
const lines = csv.trim().split('\n');
const data = lines.filter(l => !l.startsWith('#')).slice(1);
ok('the CSV says whose it is and has a line for every shared site against every repeater',
   lines[0] === '# Flood-Net repeater comparison' && data.length === res.rows.length * ids.length, `${data.length} lines`);
ok('…headed, with the margin of a priced path in it',
   /^site_id,site,/.test(lines.find(l => !l.startsWith('#'))) && (!priced.length || csv.includes(priced[0].fig.margin.toFixed(1))));

// ── 5. the rail, and clearing ────────────────────────────────────────────────
console.log('\nThe rail and Clear the selection');

await page.click('#help-panel .dock-tab[data-dock="stations"]').catch(() => {});
await page.waitForTimeout(300);
const rail = await page.evaluate(() => ({ live: MapRepCompare.live(),
  tool: typeof dockToolLive === 'function' ? dockToolLive('map-repcompare') : null }));
ok('with its pane put away the tool still says it has something on', rail.live && rail.tool !== false, J(rail));
await page.evaluate(() => clearStationsMapMarks());
const gone = await page.evaluate(() => {
  let lines = 0;
  // Paths and pins, not the pane's own renderer, which stays for the next run.
  state.map.eachLayer(l => { if ((l instanceof L.Path || l instanceof L.Marker) && (l.options.pane === 'mnRepCmpLines' || l.options.pane === 'mnRepCmp')) lines++; });
  return { live: MapRepCompare.live(), reps: MapRepCompare.repeaters(), results: MapRepCompare.results(), lines };
});
ok('Clear the selection takes the repeaters, the answer and everything it drew off the map',
   !gone.live && gone.reps.length === 0 && gone.results === null && gone.lines === 0, J(gone));

ok('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
await server.close();
console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
