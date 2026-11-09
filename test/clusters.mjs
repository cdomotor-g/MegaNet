// The Stations map's bubbles (map-cluster.js): nearby station pins drawn as
// one bubble with how many there are until the map is zoomed in, under any
// colouring of the pins, with a switch in Map display that turns it off.
//
//   1. **On by default** — a device that has never said: at the network-wide
//      view every station is in exactly one bubble or drawn as its own pin,
//      the counts add up, a pin in a bubble is neither drawn nor hit, and the
//      map's name says how many are grouped.
//      Pointing at a bubble lights its stations' paths under Tails, as
//      pointing at a pin does, and its hover words are a readable width.
//   2. **Pressing a bubble** zooms in on its stations, and the zoom groups
//      them again, smaller; from MAX_ZOOM + 1 every station has its own pin.
//   3. **What keeps its own pin** — the station whose card is up, the map
//      selection, a filter's matches.
//   4. **The switch** — Map display's box turns them off (every pin drawn,
//      nothing grouped, remembered) and on again; its words on hover and in a
//      fold; the legend's row.
//   5. **Roles** — a bubble is a mix: a ring split by the colours its pins wear,
//      the counts adding up to its own.
//   6. **Health** — the batch planted (a third of the stations last heard three
//      days ago, the rest now): Worst wears a fault's colour wherever a fault is
//      in it, Average the class most of them are in, Mix the classes counted.
//   7. **⏱️ Latency** by age, on the same batch: Worst the furthest band down
//      any of them is in, Average the band of their mean age.
//   8. **A message** from a station in a bubble flashes the bubble — the flare's
//      white-hot core at the bubble, not at the station under it — and its
//      ring stays behind the bubble beside it rather than over its count.
//
// And at every zoom checked, no two bubbles overlap and no pin left on its own
// is under one (map-cluster.js settles them apart).
//
// The datastore's station_health is stood in for by route; everything else
// off-origin is refused (lib/network.mjs). Under automation the bubbles are
// off unless asked for (navigator.webdriver, as pwa.js's offline copy is), so
// every other check gets every pin; this one asks, or stands in for a browser
// nobody is driving.
//
// Run:  npm run clusters

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const LOAD_TIMEOUT = 60_000;
const results = [];
const errors = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
}
const J = v => JSON.stringify(v);

const server = await startServer();
const browser = await launchBrowser();

async function open({ key = 'unset', health = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await applyNetworkPolicy(page, server.origin);
  // A device that has never said, in a browser nobody is driving (under
  // automation the bubbles are off unless asked for, as the offline copy is);
  // or one that has said.
  await page.addInitScript(k => {
    try {
      if (k === 'unset') Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
      else localStorage.setItem('mn-map-cluster', k);
    } catch (_) {}
  }, key);
  if (health) {
    await page.route(/\/rest\/v1\/station_health\?/, route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(health),
      headers: { 'access-control-allow-origin': '*' },
    }));
  }
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => state.data && state.data.stations, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => state.map && state.mapMarkers.length > 1000, null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
  return { context, page };
}

const snapshot = page => page.evaluate(() => {
  const st = MapCluster._state();
  const markers = state.mapMarkers;
  const inBubble = new Map();
  for (const b of st.bubbles) for (const id of b.ids) inBubble.set(id, (inBubble.get(id) || 0) + 1);
  return {
    on: st.on, how: st.how, zoom: state.map.getZoom(), bubbles: st.bubbles, clustered: st.clustered,
    total: markers.length,
    drawn: markers.filter(m => !m._mnClustered).length,
    twice: [...inBubble.values()].filter(n => n > 1).length,
    flagged: markers.filter(m => m._mnClustered).length,
    mismatch: markers.filter(m => !!m._mnClustered !== inBubble.has(m.mnStationId)).length,
    name: document.getElementById('leaflet-map').getAttribute('aria-label') || '',
  };
});

try {
  // ── 1. On by default ───────────────────────────────────────────────────
  console.log('\n1. On by default\n');
  let { context, page } = await open();
  let S = await snapshot(page);
  check('a device that has never said groups its pins: bubbles at the network-wide view', S.on && S.bubbles.length > 0 && S.zoom <= 11, J({ on: S.on, n: S.bubbles.length, zoom: S.zoom }));
  check('every station is in one bubble or drawn as its own pin, never both, never in two',
    S.twice === 0 && S.mismatch === 0 && S.drawn + S.clustered === S.total && S.flagged === S.clustered,
    J({ total: S.total, drawn: S.drawn, clustered: S.clustered, twice: S.twice, mismatch: S.mismatch }));
  check('each bubble\'s count is the stations in it, and every bubble holds two or more',
    S.bubbles.every(b => b.n === b.ids.length && b.n >= 2) && S.bubbles.reduce((a, b) => a + b.n, 0) === S.clustered, '');
  check('the map\'s name says how many are grouped', /grouped into \d[\d,]* bubbles of nearby stations/.test(S.name), S.name);
  const apart = await page.evaluate(async () => {
    const map = state.map, c0 = map.getCenter(), z0 = map.getZoom();
    const out = [];
    for (const z of [5, 6, 7, 9]) {
      await new Promise(r => { map.once('zoomend', r); map.setView([-27.4, 152.6], z, { animate: false }); });
      const discs = MapCluster.discs().map(d => ({ p: map.latLngToLayerPoint(d.latlng), r: d.r }));
      let touch = 0, under = 0;
      for (let i = 0; i < discs.length; i++) {
        for (let j = i + 1; j < discs.length; j++) {
          if (discs[i].p.distanceTo(discs[j].p) < discs[i].r + discs[j].r) touch++;
        }
      }
      for (const m of state.mapMarkers) {
        if (!m._map || m._mnClustered || MapCluster.overBubbles(m.mnStationId)) continue;
        const p = map.latLngToLayerPoint(m.getLatLng());
        if (discs.some(d => p.distanceTo(d.p) < d.r + (m.options.radius || 6))) under++;
      }
      out.push({ z, bubbles: discs.length, touch, under });
    }
    await new Promise(r => { map.once('zoomend', r); map.setView(c0, z0, { animate: false }); });
    return out;
  });
  check('no two bubbles overlap, and no pin left on its own is under a bubble, at zooms 5, 6, 7 and 9',
    apart.every(a => a.bubbles > 0 && a.touch === 0 && a.under === 0), J(apart));
  const hit = await page.evaluate(() => {
    const m = state.mapMarkers.find(x => x._mnClustered);
    const r = m._renderer;
    return { contains: m._containsPoint(m._point), drawnHere: !!r, id: m.mnStationId };
  });
  check('a pin in a bubble is not hit where it stands (the bubble over it is what a press reaches)', hit.contains === false, J(hit));
  // Pointing at a bubble points at every station in it (MapViews.hoverGroup):
  // under Tails their paths light, as one pin's do when it is pointed at.
  const hov = await page.evaluate(async () => {
    const was = MapViews.settings().draw;
    MapViews.set({ draw: 'tails' });
    await new Promise(r => setTimeout(r, 300));
    const fields = new Set(state.data.stations.filter(s => s.roles.includes('field')).map(s => String(s.id)));
    const layer = Object.values(state.map._layers)
      .filter(l => l.mnCluster)
      .sort((a, b) => b.mnCluster.members.length - a.mnCluster.members.length)
      .find(l => l.mnCluster.members.some(m => fields.has(String(m.mnStationId))));
    const ids = layer.mnCluster.members.map(m => m.mnStationId);
    layer.fire('mouseover');
    await new Promise(r => setTimeout(r, 300));
    const group = MapViews._state().hoveredGroup || [];
    const asked = MapViews.hoveredIds();
    const lit = MapTails._state().lit.stations;
    const tip = layer.getTooltip() && layer.getTooltip().getElement();
    const tipW = tip ? tip.getBoundingClientRect().width : 0;
    layer.fire('mouseout');
    await new Promise(r => setTimeout(r, 300));
    const after = { group: MapViews._state().hoveredGroup, lit: MapTails._state().lit.stations.length };
    MapViews.set({ draw: was });
    const idSet = new Set(ids.map(String));
    return { n: ids.length, group: group.length, same: group.length === ids.length && group.every((id, i) => id === ids[i]),
             asked: asked.length, lit: lit.length, litInside: lit.every(id => idSet.has(String(id))), after, tipW };
  });
  check('pointing at a bubble lights its stations\' paths under Tails, as pointing at a pin does, and leaving it puts them out',
    hov.same && hov.asked === hov.n && hov.lit > 0 && hov.litInside && hov.after.group == null && hov.after.lit === 0, J(hov));
  check('the bubble\'s hover words are a readable width, not a word a line', hov.tipW >= 120, J({ tipW: hov.tipW }));

  // ── 2. Pressing a bubble ──────────────────────────────────────────────
  console.log('\n2. Pressing a bubble\n');
  const before = S;
  const pressed = await page.evaluate(async () => {
    const st = MapCluster._state();
    const b = st.bubbles.slice().sort((a, c) => c.n - a.n)[0];
    const layer = Object.values(state.map._layers).find(l => l.mnCluster && l.options.mnCount === b.n);
    const z0 = state.map.getZoom();
    await new Promise(r => { state.map.once('zoomend', r); layer.fire('click'); });
    await new Promise(r => setTimeout(r, 400));
    const after = MapCluster._state();
    const bounds = state.map.getBounds();
    const inView = b.ids.filter(id => { const m = state.mapMarkers.find(x => x.mnStationId === id); return bounds.contains(m.getLatLng()); }).length;
    return { n: b.n, z0, z1: state.map.getZoom(), biggest: Math.max(...after.bubbles.map(x => x.n)), inView };
  });
  check('pressing a bubble zooms in on its stations', pressed.z1 > pressed.z0 && pressed.inView >= pressed.n * 0.9, J(pressed));
  check('…and the zoom groups them again, into smaller bubbles', pressed.biggest < pressed.n, J(pressed));
  const deep = await page.evaluate(async () => {
    await new Promise(r => { state.map.once('zoomend', r); state.map.setZoom(MapCluster.MAX_ZOOM + 1, { animate: false }); });
    return { zoom: state.map.getZoom(), bubbles: MapCluster._state().bubbles.length, clustered: state.mapMarkers.filter(m => m._mnClustered).length };
  });
  check(`from zoom ${12} every station has its own pin`, deep.bubbles === 0 && deep.clustered === 0, J(deep));
  await page.evaluate(async () => { await new Promise(r => { state.map.once('zoomend', r); state.map.setZoom(5, { animate: false }); }); });

  // ── 3. What keeps its own pin ─────────────────────────────────────────
  console.log('\n3. What keeps its own pin\n');
  const own = await page.evaluate(async () => {
    const tick = () => new Promise(r => setTimeout(r, 50));
    const pick = state.mapMarkers.find(m => m._mnClustered);
    const id = pick.mnStationId;
    showStationCard(id);
    await tick();
    const card = { clustered: !!state.mapMarkers.find(m => m.mnStationId === id)._mnClustered };
    closeStnCard(false);
    await tick();
    // Still the selected station, so still its own pin; unselected, back in.
    card.stillSelected = !state.mapMarkers.find(m => m.mnStationId === id)._mnClustered;
    if (state.selectedId === id) selectStation(id);
    await tick();
    card.back = !!state.mapMarkers.find(m => m.mnStationId === id)._mnClustered;
    const other = state.mapMarkers.find(m => m._mnClustered && m.mnStationId !== id).mnStationId;
    state.mapSelection.add(other);
    mapSelectionChanged();
    await tick();
    const sel = !!state.mapMarkers.find(m => m.mnStationId === other)._mnClustered;
    state.mapSelection.clear();
    mapSelectionChanged();
    await tick();
    return { card, sel, selBack: !!state.mapMarkers.find(m => m.mnStationId === other)._mnClustered };
  });
  check('the station whose card is up has its own pin, keeps it while it is the selected station, and goes back into its bubble once it is not',
    own.card.clustered === false && own.card.stillSelected === true && own.card.back === true, J(own.card));
  check('a station picked into the map selection has its own pin while it is picked', own.sel === false && own.selBack === true, J(own));
  const match = await page.evaluate(async () => {
    const s = state.data.stations.find(x => x.lat != null && x.name && /^[A-Za-z]{5,}/.test(x.name) && state.mapMarkers.find(m => m.mnStationId === x.id && m._mnClustered));
    mapSearchInput(0, s.name);
    await new Promise(r => setTimeout(r, 900));
    const m = state.mapMarkers.find(x => x.mnStationId === s.id);
    const res = { name: s.name, hit: !!(m && m.mnHit), clustered: !!(m && m._mnClustered) };
    mapSearchInput(0, '');
    await new Promise(r => setTimeout(r, 900));
    return res;
  });
  check('a filter\'s match has its own pin', match.hit && !match.clustered, J(match));

  // ── 4. The switch ─────────────────────────────────────────────────────
  console.log('\n4. The switch\n');
  const sw = await page.evaluate(async () => {
    const box = document.getElementById('map-cluster-on');
    const how = document.getElementById('map-cluster-how');
    const meaning = box && box.closest('label').title;
    const fold = !!document.querySelector('#map-cluster-note ~ details.lat-words');
    const term = how && how.closest('label').querySelector('.term');
    box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const off = { bubbles: MapCluster._state().bubbles.length, drawn: state.mapMarkers.filter(m => !m._mnClustered).length,
                  total: state.mapMarkers.length, kept: localStorage.getItem('mn-map-cluster'),
                  note: document.getElementById('map-cluster-note').textContent };
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    return { meaning, fold, term: term && term.title, off, onAgain: MapCluster._state().bubbles.length, kept: localStorage.getItem('mn-map-cluster'),
             legend: !!document.querySelector('.legend-cluster') };
  });
  check('Map display has the switch, its meaning on hover and its words in a fold', !!sw.meaning && /bubble/.test(sw.meaning) && sw.fold && /mix/i.test(sw.term || ''), J({ meaning: sw.meaning && sw.meaning.slice(0, 60), fold: sw.fold, term: sw.term && sw.term.slice(0, 60) }));
  check('unticked, every pin is drawn and nothing is grouped, and it is remembered',
    sw.off.bubbles === 0 && sw.off.drawn === sw.off.total && sw.off.kept === 'off' && /own pin/.test(sw.off.note), J(sw.off));
  check('ticked again, the bubbles are back, remembered, and the legend keys them', sw.onAgain > 0 && sw.kept === 'on' && sw.legend, J({ onAgain: sw.onAgain, kept: sw.kept, legend: sw.legend }));

  // ── 5. Roles ──────────────────────────────────────────────────────────
  console.log('\n5. With the pins in their role colours\n');
  const roles = await page.evaluate(() => {
    const st = MapCluster._state();
    const bad = st.bubbles.filter(b => !b.parts || b.parts.reduce((a, p) => a + p.n, 0) !== b.n);
    const colours = new Set(state.mapMarkers.map(m => m.options.fillColor));
    const big = st.bubbles.slice().sort((a, c) => c.n - a.n)[0];
    return { bad: bad.length, n: st.bubbles.length, parts: big.parts.map(p => `${p.label}:${p.n}`), known: big.parts.every(p => colours.has(p.colour) || /^#/.test(p.colour)) };
  });
  check('every bubble is a mix: a ring split by its pins\' colours, the parts adding up to its count', roles.bad === 0 && roles.known && roles.parts.length >= 2, J(roles));
  await context.close();

  // ── 6. Health ─────────────────────────────────────────────────────────
  console.log('\n6. Coloured by health\n');
  const ids = await (async () => {
    const { context: c, page: p } = await open({ key: 'on' });
    const out = await p.evaluate(() => state.data.stations.filter(s => s.lat != null).map(s => s.id));
    await c.close();
    return out;
  })();
  const now = Date.now();
  const rows = ids.map((id, i) => {
    const last = new Date(now - (i % 3 === 0 ? 3 * 86400e3 : 60e3)).toISOString();
    return { station_id: id, online: i % 3 !== 0, since: new Date(now - 30 * 86400e3).toISOString(), last_seen_at: last, last_reading_at: last };
  });
  ({ context, page } = await open({ key: 'on', health: rows }));
  const health = await page.evaluate(async () => {
    HealthGlance.setPins(true);
    for (let i = 0; i < 100 && !(HealthGlance._state().net.status === 'ok'); i++) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 500));
    const fills = { ok: '#107c10', watch: '#9e5e00', fault: '#c7401a' };
    const out = {};
    for (const how of ['worst', 'average', 'mix']) {
      MapCluster.setHow(how);
      const st = MapCluster._state();
      const by = id => state.mapMarkers.find(m => m.mnStationId === id).mnHealth;
      let right = 0, wrong = [];
      for (const b of st.bubbles) {
        const cls = b.ids.map(by);
        const tally = {}; cls.forEach(c => { tally[c] = (tally[c] || 0) + 1; });
        let want;
        if (how === 'worst') want = tally.fault ? fills.fault : tally.watch ? fills.watch : fills.ok;
        else if (how === 'average') {
          const heard = ['ok', 'watch', 'fault'].filter(c => tally[c]);
          const RANK = { ok: 0, watch: 1, fault: 2 };
          const top = heard.reduce((a, c) => (tally[c] > tally[a] || (tally[c] === tally[a] && RANK[c] > RANK[a]) ? c : a));
          want = fills[top];
        }
        const ok = how === 'mix' ? !!b.parts && b.parts.reduce((a, p) => a + p.n, 0) === b.n
          && b.parts.every(p => p.n === (tally[{ OK: 'ok', Watch: 'watch', Fault: 'fault', 'No data': 'nodata' }[p.label]] || 0))
          : b.fill === want && !b.parts;
        if (ok) right++; else wrong.push({ n: b.n, fill: b.fill, want, tally });
      }
      out[how] = { right, of: st.bubbles.length, wrong: wrong.slice(0, 2), classes: new Set(state.mapMarkers.map(m => m.mnHealth)).size };
    }
    return out;
  });
  check('the batch planted, the pins wear more than one class', health.worst.classes >= 2, J(health.worst));
  check('Worst: every bubble with a fault in it wears a fault\'s colour, one with none the best it holds', health.worst.right === health.worst.of && health.worst.of > 0, J(health.worst));
  check('Average: every bubble wears the class most of its stations are in', health.average.right === health.average.of, J(health.average));
  check('Mix: every bubble is a ring of its classes, counted', health.mix.right === health.mix.of, J(health.mix));

  // ── 7. ⏱️ Latency by age ───────────────────────────────────────────────
  console.log('\n7. Coloured by ⏱️ Latency (age)\n');
  const lat = await page.evaluate(async () => {
    MapLatency.setOn(true);
    MapLatency.setMode('age');
    await new Promise(r => setTimeout(r, 800));
    const B = MapLatency.BANDS.age;
    const out = {};
    for (const how of ['worst', 'average']) {
      MapCluster.setHow(how);
      const st = MapCluster._state();
      let right = 0, wrong = [];
      const now = Date.now();
      for (const b of st.bubbles) {
        const cls = b.ids.map(id => MapLatency.classOf(id));
        const banded = cls.filter(c => c.band);
        if (!banded.length) { right++; continue; }
        let want;
        if (how === 'worst') want = B[Math.max(...banded.map(c => B.indexOf(c.band)))].fill;
        else want = MapLatency.classifyValue('age', banded.reduce((a, c) => a + c.value, 0) / banded.length).fill;
        if (b.fill === want) right++; else wrong.push({ n: b.n, fill: b.fill, want });
      }
      out[how] = { right, of: st.bubbles.length, wrong: wrong.slice(0, 2), on: MapLatency.on() };
    }
    return out;
  });
  check('Worst: every bubble wears the furthest band down any of its stations is in', lat.worst.on && lat.worst.right === lat.worst.of && lat.worst.of > 0, J(lat.worst));
  check('Average: every bubble wears the band of its stations\' mean age', lat.average.right === lat.average.of, J(lat.average));

  // ── 8. A message lands in a bubble ────────────────────────────────────
  console.log('\n8. A message from a station in a bubble\n');
  const flash = await page.evaluate(async () => {
    MapLatency.setAnim(true);
    for (let i = 0; i < 40 && !MapLatency._live().canvas; i++) await new Promise(r => setTimeout(r, 50));
    const map = state.map;
    const st = MapCluster._state();
    // A station well away from its bubble's middle, so the two places differ.
    let pick = null;
    for (const b of st.bubbles) {
      const c = map.latLngToContainerPoint(b.at);
      for (const id of b.ids) {
        const s = state.data.stations.find(x => x.id === id);
        const p = map.latLngToContainerPoint([s.lat, s.lon]);
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (d > 30 && (!pick || d > pick.d)) pick = { id, c, p, d };
      }
      if (pick) break;
    }
    if (!pick) return { none: true };
    MapLatency._fire(pick.id, { addr: 'test' });
    await new Promise(r => setTimeout(r, 140));
    const cv = document.querySelector('.lat-pulse-canvas');
    const dpr = window.devicePixelRatio || 1;
    const px = q => Array.from(cv.getContext('2d').getImageData(Math.round(q.x * dpr), Math.round(q.y * dpr), 1, 1).data);
    return { d: Math.round(pick.d), atBubble: px(pick.c), atStation: px(pick.p), bubble: MapCluster.bubbleOf(pick.id) && MapCluster.bubbleOf(pick.id).radius };
  });
  const hot = c => c && c[3] > 120 && c[0] > 200 && c[1] > 200 && c[2] > 200;
  check('the message flashes its bubble: the flare\'s white-hot core is on the bubble, not on the station under it',
    !flash.none && hot(flash.atBubble) && !hot(flash.atStation), J(flash));
  // The bubble beside a lit one is in front of its ring: the two nearest
  // bubbles, one lit, and the canvas read just inside the other's disc where
  // the ring's halo would reach it, and on the ring on the far side.
  const behind = await page.evaluate(async () => {
    const map = state.map;
    await new Promise(r => { map.once('zoomend', r); map.setView([-27.4, 152.6], 6, { animate: false }); });
    await new Promise(r => setTimeout(r, 300));
    const st = MapCluster._state();
    const discs = MapCluster.discs().map(d => ({ ...d, p: map.latLngToContainerPoint(d.latlng) }));
    let pair = null;
    for (const b of st.bubbles) {
      const own = MapCluster.bubbleOf(b.ids[0]);
      const a = discs.find(d => d.key === own.key);
      for (const o of discs) {
        if (o === a) continue;
        const gap = a.p.distanceTo(o.p) - a.r - o.r;
        if (!pair || gap < pair.gap) pair = { gap, a, o, id: b.ids[0], r: own.radius };
      }
    }
    if (!pair || pair.gap > 8) return { none: true, gap: pair && pair.gap };
    MapLatency._fire(pair.id, { addr: 'test' });
    await new Promise(r => setTimeout(r, 1500));   // past the flare, the ring at full
    const cv = document.querySelector('.lat-pulse-canvas');
    const dpr = window.devicePixelRatio || 1;
    const alpha = q => cv.getContext('2d').getImageData(Math.round(q.x * dpr), Math.round(q.y * dpr), 1, 1).data[3];
    const { a, o } = pair;
    const d = a.p.distanceTo(o.p), ux = (o.p.x - a.p.x) / d, uy = (o.p.y - a.p.y) / d;
    const into = a.r + pair.gap + 1;                // just inside the neighbour's edge
    const ring = pair.r + 3;                          // the ring itself, away from the neighbour
    return {
      gap: Math.round(pair.gap * 10) / 10,
      onNeighbour: alpha({ x: a.p.x + ux * into, y: a.p.y + uy * into }),
      onRing: alpha({ x: a.p.x - ux * ring, y: a.p.y - uy * ring }),
    };
  });
  check('a lit bubble\'s ring glows round it and stays behind the bubble beside it',
    !behind.none && behind.onRing > 60 && behind.onNeighbour === 0, J(behind));
  await context.close();
} finally {
  await browser.close();
  await server.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const bad = results.filter(r => !r.ok);
if (bad.length) {
  console.log(`\nFAIL — ${bad.length} of ${results.length} check(s).`);
  process.exit(1);
}
console.log('\nPASS — nearby pins are bubbles until zoomed in, pressed to zoom in, coloured by worst, average or mix under\n'
  + '       health and ⏱️ Latency, flashed by a message landing in them, and turned off by Map display\'s switch.');
