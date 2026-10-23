// The rivers layer on the Stations map (map-river-lines.js): on for a first
// visit in the Calm look, drawn from the bundled Geofabric file, named along
// the rivers, and each river a thing a real pointer can select.
//
// Everything here is on-origin — data/rivers-au.json and its tiles are files
// of the site — so unlike `npm run rivers` nothing has to be seeded to draw.
// The minor creeks are the exception: they come from a live service the
// harness blocks, so they are handed in through MapRiverLines.seedMinor(),
// which takes them down the same path an answer would.
//
// The pointer is real where it can be: page.mouse over the map container, at
// the screen position of a vertex the test reads out of the same file, so a
// hover and a click are the browser's own events reaching Leaflet's map
// handlers — the only route there is, under the shared pins canvas.
//
// Run:  npm run riverlines
//       npm run riverlines -- -v    also print what passed

import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else if (VERBOSE) console.log(`  ✓ ${name}`);
}

// The file, read the way the page reads it.
const DATA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'rivers-au.json'), 'utf8'));
function decode(str, quant) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    let b, shift = 0, r = 0;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << shift; shift += 5; } while (b >= 32);
    lat += (r & 1) ? ~(r >> 1) : (r >> 1);
    shift = 0; r = 0;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << shift; shift += 5; } while (b >= 32);
    lon += (r & 1) ? ~(r >> 1) : (r >> 1);
    out.push([lat / quant, lon / quant]);
  }
  return out;
}

// ── The file itself ──────────────────────────────────────────────────────────
const meta = DATA.meta || {};
check('the file credits the Bureau and carries its licence',
  /Bureau of Meteorology/.test(meta.attribution || '') && meta.licence === 'CC BY 4.0', JSON.stringify(meta.attribution));
check('bands run largest first and end at 0 km²',
  Array.isArray(DATA.bands) && DATA.bands.every((b, i) => i === 0 || b < DATA.bands[i - 1]) && DATA.bands.at(-1) === 0,
  JSON.stringify(DATA.bands));
const tilesOnDisk = fs.readdirSync(path.join(REPO_ROOT, 'data', 'rivers-au')).filter(f => f.endsWith('.json'))
  .map(f => f.replace(/\.json$/, '')).sort();
check('every tile the file lists is on disk, and no other',
  JSON.stringify(tilesOnDisk) === JSON.stringify([...DATA.tiles].sort()), `${tilesOnDisk.length} on disk, ${DATA.tiles.length} listed`);
const burdekin = DATA.rivers.find(r => r[0] === 'BURDEKIN RIVER');
check('the Burdekin is one river, ~94,000 km² at its mouth, with reaches in the national file',
  !!burdekin && burdekin[1] > 90000 && burdekin[1] < 100000 && burdekin[4].length > 0,
  burdekin ? `${burdekin[1]} km², ${burdekin[4].length} runs` : 'missing');
const brisbane = DATA.rivers.filter(r => r[0] === 'BRISBANE RIVER');
check('the Brisbane River is one system either side of Wivenhoe', brisbane.length === 1, `${brisbane.length} entries`);
const dc = DATA.rivers.filter(r => r[0] === 'DEEP CREEK');
check('a common name stays several different creeks', dc.length > 1, `${dc.length} Deep Creeks`);
let decodedOk = true;
for (const r of DATA.rivers.slice(0, 40)) {
  for (const [band, line, n] of r[4]) {
    const pts = decode(line, DATA.quant);
    if (pts.length !== n || pts.some(([la, lo]) => la < -45 || la > -9 || lo < 112 || lo > 155)) decodedOk = false;
  }
}
check('lines decode to their stated point count, inside Australia', decodedOk);

// A vertex in the middle of the Burdekin's longest band-0 run: on the line at
// any zoom the national file draws.
const bRun = burdekin[4].filter(l => l[0] === 0).map(l => decode(l[1], DATA.quant)).sort((a, b) => b.length - a.length)[0];
const ON_BURDEKIN = bRun[Math.floor(bRun.length / 2)];

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  // The Calm look, which every first visit opens in: the claim is that the
  // rivers are on there, where every other context layer starts off.
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, look: 'calm' });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', (e) => errors.push(e.message));
  const asked = [];
  page.on('request', (r) => { if (/\/data\/rivers-au/.test(r.url())) asked.push(r.url()); });

  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });

  // ── On for a first visit, in the Calm look ────────────────────────────────
  const first = await page.evaluate(() => ({ on: state.mapRiverLines, look: state.look,
    stored: localStorage.getItem('mn-river-lines') }));
  check('a first visit starts with the rivers on, in the Calm look that starts every other context layer off',
    first.on === true && first.look === 'calm' && first.stored === null, JSON.stringify(first));
  check('nothing is fetched for the rivers before the map opens',
    !asked.some(u => /rivers-au\.json/.test(u)), asked.join(' '));

  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 1000, null, { timeout: 30_000 });
  await page.waitForFunction(() => MapRiverLines.active(), null, { timeout: 20_000 });

  const panes = await page.evaluate(() => ['mnRiverLines', 'mnRiverPick', 'mnRiverNames'].map(p => {
    const el = document.querySelector(`.leaflet-${p}-pane`);
    return el ? getComputedStyle(el).pointerEvents : 'missing';
  }));
  check('the three panes take no pointer — the map’s own events are hit-tested',
    panes.every(p => p === 'none'), JSON.stringify(panes));
  const canv = await page.evaluate(() => document.querySelectorAll('.leaflet-mnRiverLines-pane canvas').length);
  check('the lines are drawn on one canvas of their own', canv === 1, `${canv} canvases`);

  const legend = await page.evaluate(() => document.getElementById('map-legend')?.textContent || '');
  check('the legend keys the river line and credits the Geofabric', /River or creek/.test(legend) && /Geofabric/.test(legend),
    legend.replace(/\s+/g, ' ').slice(0, 200));
  const attrib = await page.evaluate(() => document.querySelector('.leaflet-control-attribution')?.textContent || '');
  check('the map’s attribution credits the Bureau while rivers are drawn', /Bureau of Meteorology/.test(attrib), attrib.slice(0, 160));

  // ── The Burdekin country, zoom 8: names along the rivers ──────────────────
  await page.evaluate(([lat, lon]) => { state.map.setView([lat, lon], 8, { animate: false }); }, ON_BURDEKIN);
  await page.waitForFunction(() => [...document.querySelectorAll('.mn-rl-name')].some(e => /Burdekin River/.test(e.textContent)),
    null, { timeout: 15_000 }).catch(() => {});
  const names = await page.evaluate(() => [...document.querySelectorAll('.mn-rl-name')].map(e => e.textContent));
  check('rivers in view are named on the map, the Burdekin among them',
    names.includes('Burdekin River') && names.length >= 3, JSON.stringify(names.slice(0, 12)));
  const inside = await page.evaluate(() => {
    const m = state.map.getContainer().getBoundingClientRect();
    return [...document.querySelectorAll('.mn-rl-name')].every(e => {
      const r = e.getBoundingClientRect();
      return r.left >= m.left - 1 && r.right <= m.right + 1 && r.top >= m.top - 1 && r.bottom <= m.bottom + 1;
    });
  });
  check('no name is cut by the edge of the map', inside);
  const turned = await page.evaluate(() => [...document.querySelectorAll('.mn-rl-name')]
    .map(e => (e.style.transform.match(/rotate\((-?[\d.]+)deg\)/) || [])[1]).filter(v => v != null).map(Number));
  check('names turn with their rivers, and none is upside down',
    turned.length > 0 && turned.every(d => d >= -90 && d <= 90) && turned.some(d => Math.abs(d) > 1), JSON.stringify(turned.slice(0, 8)));
  check('zoom 8 asks for the tiles of the smaller reaches, and only once each',
    asked.some(u => /rivers-au\/[-\d]+_[-\d]+\.json/.test(u)) && new Set(asked).size === asked.length, `${asked.length} asked`);

  // ── A real pointer: hover names it, a click selects it ───────────────────
  const screen = async ([lat, lon]) => page.evaluate(([la, lo]) => {
    const p = state.map.latLngToContainerPoint([la, lo]);
    const r = state.map.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [lat, lon]);
  // Clear of any pin or radio link under the vertex: they are a canvas above,
  // and their own click wins over the river under them — rightly, and not
  // what this is testing. So the links go, and the vertex is nudged along the
  // line until no pin is near.
  await page.evaluate(() => { state.mapShowLinks = false; refreshMapLayers({ skipFit: true }); });
  await page.waitForTimeout(300);
  // The vertex of the run, inside the map, farthest from every station.
  const at = await page.evaluate((cands) => {
    const size = state.map.getSize();
    const pins = state.data.stations.filter(s => s.lat != null && s.lon != null)
      .map(s => state.map.latLngToContainerPoint([s.lat, s.lon]));
    let best = null, bestD = -1;
    for (const c of cands) {
      const p = state.map.latLngToContainerPoint(c);
      if (p.x < 40 || p.y < 40 || p.x > size.x - 40 || p.y > size.y - 40) continue;
      let d = Infinity;
      for (const q of pins) d = Math.min(d, q.distanceTo(p));
      if (d > bestD) { bestD = d; best = c; }
    }
    return bestD > 24 ? best : null;
  }, bRun);
  check('a vertex of the Burdekin clear of every pin is on screen to point at', !!at);
  const pt = await screen(at || ON_BURDEKIN);
  // In steps, a frame or two apart, as a hand moves: the pins canvas passes
  // the map at most one mousemove each 32 ms, so a pointer teleported onto
  // the line in one event would arrive as wherever it was a move before.
  await page.mouse.move(pt.x + 40, pt.y + 40);
  await page.waitForTimeout(60);
  await page.mouse.move(pt.x, pt.y, { steps: 6 });
  await page.waitForTimeout(60);
  await page.mouse.move(pt.x + 1, pt.y);
  await page.waitForTimeout(250);
  const hov = await page.evaluate(() => ({
    cursor: state.map.getContainer().style.cursor,
    tip: document.querySelector('.leaflet-tooltip.mn-rl-tip')?.textContent || '',
    glow: document.querySelectorAll('.mn-rl-hover').length,
  }));
  check('hovering the river names it, lights it, and the cursor says it can be clicked',
    hov.cursor === 'pointer' && hov.tip === 'Burdekin River' && hov.glow > 0, JSON.stringify(hov));

  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(400);
  const sel = await page.evaluate(() => ({
    sel: MapRiverLines.selected(),
    core: document.querySelectorAll('.leaflet-mnRiverPick-pane .mn-rl-pick-core').length,
    pop: document.querySelector('.mn-rl-popup .leaflet-popup-content')?.textContent.replace(/\s+/g, ' ') || '',
    buttons: [...document.querySelectorAll('.mn-rl-popup .mn-rl-station')].map(b => b.dataset.id),
    note: document.getElementById('map-river-lines-note')?.textContent.replace(/\s+/g, ' ') || '',
    legend: document.getElementById('map-legend')?.textContent || '',
  }));
  const onIt = await page.evaluate(() => state.data.stations.filter(s =>
    MapRiverLines.riverKey(s.stream || '') === 'burdekin river' && s.lat != null).length);
  check('a click selects the river and lights every reach of it', sel.sel && sel.sel.title === 'Burdekin River' && sel.core > 0,
    JSON.stringify({ sel: sel.sel, core: sel.core }));
  check('its callout says how much drains through it, and lists its stations as buttons',
    /Burdekin River/.test(sel.pop) && /km² drains through its lowest reach|catchment [\d,]+ km²/.test(sel.pop)
      && sel.buttons.length > 0 && sel.buttons.length === Math.min(onIt, 8) && /stations? of this network on it/.test(sel.pop),
    `${sel.buttons.length} buttons, ${onIt} on it — ${sel.pop.slice(0, 160)}`);
  check('the note and the legend say what is selected',
    /Selected: Burdekin River/.test(sel.note) && /Selected: Burdekin River/.test(sel.legend), sel.note.slice(0, 160));

  // A station from the callout: the map goes to it with its card up.
  const stId = sel.buttons[0];
  await page.click(`.mn-rl-popup .mn-rl-station[data-id="${stId}"]`);
  await page.waitForTimeout(500);
  const went = await page.evaluate((id) => {
    const s = state.data.stations.find(x => x.id === id);
    return { zoom: state.map.getZoom(), dist: state.map.getBounds().contains([s.lat, s.lon]),
             card: !!document.querySelector('.stn-card, #stn-card, [data-stn-card]') };
  }, stId);
  check('a station in the callout takes the map to it', went.dist && went.zoom >= 11, JSON.stringify(went));
  check('the river stays selected after going to one of its stations',
    await page.evaluate(() => (MapRiverLines.selected() || {}).title === 'Burdekin River'));

  // ── Open map puts it down; an armed tool owns the click ───────────────────
  // Out in the Coral Sea: no river, no pin.
  // The station's card goes first: it sits over the map, and a click on it
  // is a click on the card.
  await page.evaluate(() => { closeStnCard(false); state.map.setView([-18.6, 151.5], 8, { animate: false }); });
  await page.waitForTimeout(400);
  const sea = await screen([-18.6, 151.5]);
  check('the point in the sea is open map, nothing over it',
    await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.leaflet-container'), sea));
  // A link-budget pick armed: its click is its own (and asks a station, so
  // the sea answers nothing — which is the point: nothing here moves either).
  await page.evaluate(() => LinkBudget.setPicking('a'));
  await page.mouse.click(sea.x, sea.y);
  await page.waitForTimeout(200);
  const keptByTool = await page.evaluate(() => { const v = !!MapRiverLines.selected(); LinkBudget.setPicking(false); return v; });
  check('an armed pick owns the click — the selection is not touched', keptByTool);
  await page.mouse.click(sea.x, sea.y);
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(() => ({ sel: MapRiverLines.selected(),
    core: document.querySelectorAll('.mn-rl-pick-core').length }));
  check('a click on open map puts the selection down', cleared.sel === null && cleared.core === 0, JSON.stringify(cleared));

  // ── The keyboard path: a real button per river named in view ──────────────
  await page.evaluate(([lat, lon]) => { state.map.setView([lat, lon], 8, { animate: false }); }, ON_BURDEKIN);
  await page.waitForFunction(() => document.querySelectorAll('#map-river-lines-note .mn-river-note-btn[data-river]').length > 0,
    null, { timeout: 10_000 }).catch(() => {});
  const btn = await page.evaluate(() => {
    const b = document.querySelector('#map-river-lines-note .mn-river-note-btn[data-river]');
    if (!b) return null;
    const name = b.textContent.trim();
    b.click();
    return { name, tag: b.tagName };
  });
  await page.waitForTimeout(300);
  const byBtn = await page.evaluate(() => ({ sel: MapRiverLines.selected(),
    pop: !!document.querySelector('.mn-rl-popup') }));
  check('a river named in view is a real button in the note, and pressing it selects it with its callout',
    !!btn && btn.tag === 'BUTTON' && byBtn.sel && byBtn.sel.title === btn.name && byBtn.pop, JSON.stringify({ btn, byBtn }));

  // ── 🧹 Clear the selection takes it too ──────────────────────────────────
  await page.evaluate(() => clearStationsMapMarks());
  await page.waitForTimeout(300);
  check('🧹 Clear the selection puts the river down', await page.evaluate(() => MapRiverLines.selected() === null));

  // ── Find a place: a river picked there is selected here ───────────────────
  const named = await page.evaluate(() => MapRiverLines.selectNamed('Brisbane R', { lat: -27.47, lon: 152.97 }));
  const nowSel = await page.evaluate(() => MapRiverLines.selected());
  check('a river named the register’s way (Brisbane R) selects the Geofabric’s Brisbane River',
    !!named && named.title === 'Brisbane River' && Array.isArray(named.bounds) && nowSel && nowSel.title === 'Brisbane River',
    JSON.stringify({ named, nowSel }));
  const far = await page.evaluate(() => MapRiverLines.selectNamed('Brisbane River', { lat: -12.4, lon: 130.8 }));
  check('…but not one a thousand kilometres from the place asked about', far === null, JSON.stringify(far));
  await page.evaluate(() => MapRiverLines.clearSelection());

  // ── The minor creeks, close in ─────────────────────────────────────────────
  await page.evaluate(() => { state.map.setView([-27.55, 152.98], 13, { animate: false }); });
  await page.waitForTimeout(400);
  const seeded = await page.evaluate(() => MapRiverLines.seedMinor([
    { attributes: { OBJECTID: 9e9, Name: 'OXLEY CREEK', UpstrDArea: 2.6e8 },
      geometry: { paths: [[[152.96, -27.56], [152.975, -27.552], [152.99, -27.545], [153.0, -27.54]]] } },
    { attributes: { OBJECTID: 9e9 + 1, Name: ' ', UpstrDArea: 1e6 },
      geometry: { paths: [[[152.97, -27.57], [152.98, -27.565]]] } },
  ]));
  await page.waitForTimeout(400);
  check('a minor creek handed in joins the map; an unnamed segment does not', seeded === 1, `${seeded} added`);
  const ox = await screen([-27.552, 152.975]);
  await page.mouse.move(ox.x, ox.y, { steps: 4 });
  await page.waitForTimeout(60);
  await page.mouse.move(ox.x + 1, ox.y);
  await page.waitForTimeout(250);
  const oxTip = await page.evaluate(() => document.querySelector('.leaflet-tooltip.mn-rl-tip')?.textContent || '');
  check('a minor creek is named on hover like any river', oxTip === 'Oxley Creek', oxTip);

  // ── Off means off, and stays off ──────────────────────────────────────────
  await page.evaluate(() => MapRiverLines.setEnabled(false));
  await page.waitForTimeout(400);
  const off = await page.evaluate(() => ({
    active: MapRiverLines.active(),
    names: document.querySelectorAll('.mn-rl-name').length,
    stored: localStorage.getItem('mn-river-lines'),
    note: document.getElementById('map-river-lines-note')?.textContent || '',
    offLine: document.getElementById('map-legend')?.textContent || '',
  }));
  check('the switch off takes the lines and the names away, and is remembered',
    !off.active && off.names === 0 && off.stored === 'off' && /hidden/i.test(off.note), JSON.stringify({ ...off, offLine: undefined }));
  check('…and the legend names it among the layers that are off', /Rivers and creeks/.test(off.offLine));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  check('a later visit starts with them off', await page.evaluate(() => state.mapRiverLines === false));

  check('no pageerror', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`  ${results.length} assertion(s).`);
if (failed.length) {
  console.log('');
  console.log(`FAIL — ${failed.length} assertion(s):`);
  for (const f of failed) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
console.log('PASS — the rivers are on the map, named, and each one selectable by pointer and by keyboard.');
