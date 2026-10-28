// The Pass Ranges tab's Address space and Allocate card (address-space.js),
// driven in Chromium on the real station file, with the datastore's
// alert_allocation (0084) and its two doors stood in for by routes. The oracle
// is worked out here, in Node, from stations.json itself — a repeater carries
// an address inside a pass range and outside every exclusion, and an address
// is in use when a station in the same hub holds it — so a picture that
// counted the wrong hub, missed an exclusion or double-counted a network's
// shared addresses is red.
//
//   0. **The cards** — All addresses, the Address grid and the Address map a
//      card each, above Address space and its two buttons; the Allocate card
//      folded shut to start, its heading opening it.
//   1. **The figures** — the busiest repeaters drawn first, each repeater's
//      in-use, free and longest free run as the oracle has them; a network's
//      addresses counted once across its repeaters, a lane a repeater; the
//      Brisbane Hub's grid every address the hub's stations hold.
//   2. **The filter box** — an address typed draws exactly the repeaters
//      that carry it, each marked where it is.
//   3. **The grid** — as wide as its card, and wider with it; an address
//      looked up names its station and goes into the filter box, kept on the
//      wheel; a free one pressed with the mouse the same, offering itself to
//      the Allocate card, which opens. **The wheel** — as wide as the card; a wedge counted as the station file has
//      it, every repeater carrying any of it called out when its inner bar is
//      pointed at and kept when it is pressed, the arrow keys stepping round;
//      the outer ring pointed at address by address, the callout naming the
//      station on it and drawing its block a cell an address, pressed kept
//      with its wedge and put in the filter box and the grid's Address, Shift
//      and an arrow an address on; an address in the filter box kept, marked
//      with a glowing ring and its number, and said under the wheel, as the
//      grid marks it; the biggest gap first, and kept, it takes its first
//      free address to the grid. Show set on the grid sets the wheel. **Every hub
//      together** — in use when any hub's station holds it, two hubs on one
//      address reuse and not a clash, the gaps the addresses nobody anywhere
//      is on, and a wedge's repeaters from every hub, each named with its hub.
//   4. **The map** — circles merge as it zooms out and break apart as it
//      zooms in; a merged circle's number is its repeaters' free addresses
//      counted once, not summed.
//   5. **Signed out** — the card suggests but cannot allocate, and says why.
//   6. **Signed in as an editor** — what is set aside read, the suggestion
//      stepping round it, one taken up by a station said so; an allocation
//      sent with the hub, addresses, repeater and purpose and listed; an
//      address a station holds refused before anything is sent; a release
//      confirmed and sent.
//   7. **The exports** — both CSVs, floodnet-named.
//   8. **A datastore before 0084** — the card says the migration is waiting.
//   9. **A phone** — nothing wider than 375 px, in every view.
//
// Run:  npm run passranges

import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const J = v => JSON.stringify(v);

// ── The oracle ──────────────────────────────────────────────────────────────

const DOC = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'stations.json'), 'utf8'));
const MAX = 8191;
const idsOf = s => [...new Set((s.sensors || []).map(x => x.alert_id).filter(a => a != null && a >= 1 && a <= MAX))];
const held = new Map();       // hub|addr → [station ids]
DOC.stations.forEach(s => idsOf(s).forEach(a => {
  const k = `${s.hub_id || ''}|${a}`;
  held.set(k, [...(held.get(k) || []), s.id]);
}));
const carries = (rep, a) => (rep.pass_ranges || []).some(p => a >= p.low && a <= p.high)
  && !(rep.exclusions || []).some(e => a >= e.low && a <= e.high);
const REPS = DOC.stations.filter(s => (s.roles || []).includes('repeater') && s.repeater && (s.repeater.pass_ranges || []).length)
  .map(s => {
    const c = new Set();
    s.repeater.pass_ranges.forEach(p => { for (let a = Math.max(1, p.low); a <= Math.min(MAX, p.high); a++) if (carries(s.repeater, a)) c.add(a); });
    return { id: s.id, name: s.name, hub: s.hub_id || '', nets: s.radio_network_ids || [], carried: [...c].sort((a, b) => a - b), lat: s.lat, lon: s.lon };
  });
function figuresOf(addrs, hubs, alloc = new Set()) {
  const t = { n: 0, use: 0, clash: 0, alloc: 0, free: 0 };
  const runs = [];
  let cur = null;
  addrs.forEach(a => {
    t.n++;
    const n = hubs.reduce((x, h) => x + (held.get(`${h}|${a}`) || []).length, 0);
    const st = n > 1 ? 'clash' : n === 1 ? 'use' : hubs.some(h => alloc.has(`${h}|${a}`)) ? 'alloc' : 'free';
    t[st]++;
    if (st !== 'free') { cur = null; return; }
    if (cur && a === cur.hi + 1) { cur.hi = a; cur.n++; } else runs.push(cur = { lo: a, hi: a, n: 1 });
  });
  t.runs = runs;
  t.longest = runs.reduce((b, r) => (!b || r.n > b.n ? r : b), null);
  return t;
}
const bestFit = (runs, count) => runs.filter(r => r.n >= count).sort((p, q) => (p.n - q.n) || (p.lo - q.lo))[0] || null;

// The repeater the card is driven against: in Brisbane, the most free
// addresses, and a run of at least three.
const R = REPS.filter(r => r.hub === 'brisbane').map(r => ({ r, t: figuresOf(r.carried, [r.hub]) }))
  .filter(x => x.t.runs.some(q => q.n >= 3)).sort((a, b) => b.t.free - a.t.free)[0];
// A station in Brisbane that R carries, for "held" and "taken up".
const HELD = R.r.carried.find(a => (held.get(`brisbane|${a}`) || []).length === 1);
const HELD_BY = DOC.stations.find(s => s.id === held.get(`brisbane|${HELD}`)[0]);

// ── The stand-in datastore ──────────────────────────────────────────────────

let ALLOC = [];
let MISSING = false;
const rpc = [];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function standIn(page) {
  await page.route('**/rest/v1/**', async route => {
    const req = route.request();
    const rel = new URL(req.url()).pathname.replace(/^.*\/rest\/v1\//, '');
    if (rel === 'alert_allocation') {
      if (MISSING) return json(route, { code: 'PGRST205', message: 'Could not find the table \'meganet.alert_allocation\' in the schema cache' }, 404);
      return json(route, ALLOC.filter(r => !r.released_at));
    }
    if (rel === 'rpc/allocate_alert_ids') {
      const b = JSON.parse(req.postData() || '{}');
      rpc.push({ fn: 'allocate', b });
      const batch = `b-${rpc.length}`;
      const rows = b.p_ids.map((a, i) => ({ id: `${batch}-${i}`, batch, hub_id: b.p_hub_id, alert_id: a, purpose: b.p_purpose,
        repeater_id: b.p_repeater_id, station_id: b.p_station_id, created_by: 'editor@example.test', created_at: new Date().toISOString(), released_at: null }));
      ALLOC.push(...rows);
      return json(route, rows);
    }
    if (rel === 'rpc/release_alert_allocation') {
      const b = JSON.parse(req.postData() || '{}');
      rpc.push({ fn: 'release', b });
      const rows = ALLOC.filter(r => b.p_ids.includes(r.id));
      rows.forEach(r => { r.released_at = new Date().toISOString(); });
      return json(route, rows);
    }
    return route.fallback();
  });
}

const server  = await startServer();
const browser = await launchBrowser();
const errors  = [];
const until = (page, fn, arg, timeout = 20_000) => page.waitForFunction(fn, arg, { timeout });

async function open(context) {
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  await standIn(page);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
  await until(page, () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, LOAD_TIMEOUT);
  await page.evaluate(() => { try { localStorage.removeItem('meganet.pr-space-view'); } catch (_) {} });
  return page;
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await open(context);
  await page.evaluate(() => switchTab('passranges'));
  await until(page, () => !!document.getElementById('as-alloc') && !!document.querySelector('.as-ruler'));

  // ── 0. the cards ──────────────────────────────────────────────────────────
  console.log('\nThe cards\n');
  const cards = await page.evaluate(() => ({
    order: [...document.querySelectorAll('.as-page h2')].map(h => h.id).filter(id => /^as-/.test(id)),
    buttons: [...document.querySelectorAll('.as-views button')].map(b => b.textContent.trim()),
  }));
  ok('All addresses, the Address grid and the Address map a card each, above Address space',
    J(cards.order) === J(['as-alloc-h', 'as-wheel-h', 'as-grid-h', 'as-map-h', 'as-h']), J(cards.order));
  ok('…which keeps its two buttons, Each repeater and Each radio network', J(cards.buttons) === J(['Each repeater', 'Each radio network']), J(cards.buttons));
  ok('…and the wheel, the grid and the map are drawn when the tab opens', await page.evaluate(() => document.getElementById('as-wheel').width > 0
    && document.getElementById('as-grid').width > 0 && !!AddressSpace.state().map));
  const fold = await page.evaluate(() => { const d = document.getElementById('as-alloc');
    return { tag: d.tagName, open: d.open, h: (d.querySelector(':scope > summary h2') || {}).id, form: document.getElementById('as-where').checkVisibility() }; });
  ok('the Allocate card is folded shut to start, its heading the fold\'s summary', fold.tag === 'DETAILS' && !fold.open && fold.h === 'as-alloc-h' && !fold.form, J(fold));
  // The toggle event is a task after the press: wait for it rather than race it.
  const soon = fn => until(page, fn, null, 3000).then(() => true, () => false);
  await page.click('#as-alloc > summary');
  ok('…and pressing the heading opens it', await soon(() => document.getElementById('as-alloc').open && AddressSpace.state().allocOpen
    && document.getElementById('as-where').checkVisibility()));
  await page.click('#as-alloc > summary');
  ok('…and folds it again', await soon(() => !document.getElementById('as-alloc').open && !AddressSpace.state().allocOpen));

  // ── 1. the figures ────────────────────────────────────────────────────────
  console.log('\nThe figures, against the station file\n');
  const drawn = await page.evaluate(() => [...document.querySelectorAll('#as-view .as-ruler')].map(f => f.dataset.scope));
  const busiest = REPS.slice().sort((a, b) => (b.carried.length - a.carried.length) || a.name.localeCompare(b.name)).slice(0, 12).map(r => 'rep:' + r.id);
  ok('Each repeater: the twelve carrying the most addresses, most first', J(drawn) === J(busiest), J({ drawn, busiest }));
  ok('…the rest a button away', await page.evaluate(() => /Show 12 more/.test(document.getElementById('as-view').textContent)));

  const mismatch = [];
  for (const r of REPS) {
    const want = figuresOf(r.carried, [r.hub]);
    const got = await page.evaluate(id => AddressSpace.figures(id), 'rep:' + r.id);
    if (!got || got.n !== want.n || got.use !== want.use || got.clash !== want.clash || got.free !== want.free
      || J(got.longest && [got.longest.lo, got.longest.hi]) !== J(want.longest && [want.longest.lo, want.longest.hi])) {
      mismatch.push(`${r.name}: ${J(got && { n: got.n, use: got.use, clash: got.clash, free: got.free })} ≠ ${J({ n: want.n, use: want.use, clash: want.clash, free: want.free })}`);
    }
  }
  ok(`every one of the ${REPS.length} repeaters: carried, in use, two on one, free and the longest free run as the station file has them`, !mismatch.length, mismatch.slice(0, 3).join('; '));
  const excl = REPS.find(r => DOC.stations.find(s => s.id === r.id).repeater.exclusions.length);
  if (excl) {
    const st = DOC.stations.find(s => s.id === excl.id).repeater;
    const e = st.exclusions[0];
    const inRange = st.pass_ranges.some(p => e.low >= p.low && e.low <= p.high);
    ok(`an exclusion is not carried (${excl.name}, ${e.low})`, !inRange || !(await page.evaluate(([id, a]) => AddressSpace.index().repById.get(id).carried.includes(a), [excl.id, e.low])));
  }

  const NET = 'constitution_hill';
  const netReps = REPS.filter(r => r.nets.includes(NET));
  const netAddrs = [...new Set(netReps.flatMap(r => r.carried))].sort((a, b) => a - b);
  const wantNet = figuresOf(netAddrs, ['brisbane']);
  const gotNet = await page.evaluate(id => AddressSpace.figures(id), 'net:' + NET);
  ok(`a radio network counts each address once across its ${netReps.length} repeaters (${wantNet.n} carried, ${netReps.reduce((t, r) => t + r.carried.length, 0)} summed)`,
    gotNet.n === wantNet.n && gotNet.use + gotNet.clash === wantNet.use + wantNet.clash && gotNet.free === wantNet.free, J({ gotNet: [gotNet.n, gotNet.use, gotNet.free], want: [wantNet.n, wantNet.use, wantNet.free] }));
  const emerald = await page.evaluate(() => AddressSpace.figures('net:emerald'));
  ok('a network across two hubs asks both (Emerald)', J(emerald.hubs.slice().sort()) === J(['brisbane', 'cairns']), J(emerald.hubs));

  await page.evaluate(() => AddressSpace.setView('networks'));
  const nets = await page.evaluate(() => ({
    rows: document.querySelectorAll('.as-nets tbody tr').length,
    figs: document.querySelectorAll('#as-view .as-ruler').length,
    lanes: (document.querySelector('#as-view .as-ruler[data-scope="net:constitution_hill"] svg') || { querySelectorAll: () => [] }).querySelectorAll('text.as-lane').length,
  }));
  const groups = new Set(REPS.flatMap(r => (r.nets.length ? r.nets : [`_none_${r.hub}`])));
  ok(`Each radio network: a table row and a figure a network (${groups.size})`, nets.rows === groups.size && nets.figs === groups.size, J(nets));
  ok('…and in a network\'s figure a lane a repeater, under the network\'s own', nets.lanes === netReps.length + 1, J(nets));

  const hubHeld = new Set([...held.keys()].filter(k => k.startsWith('brisbane|')).map(k => Number(k.split('|')[1])));
  const hub = await page.evaluate(() => Object.assign(AddressSpace.figures('hub:brisbane'), { scope: AddressSpace.state().scope }));
  ok(`Address grid: the busiest hub first, and every address its stations hold in use (${hubHeld.size})`,
    hub.scope === 'hub:brisbane' && hub.n === MAX && hub.use + hub.clash === hubHeld.size, J({ scope: hub.scope, n: hub.n, use: hub.use + hub.clash }));

  // ── 2. the filter box ─────────────────────────────────────────────────────
  console.log('\nThe filter box\n');
  await page.evaluate(() => AddressSpace.setView('repeaters'));
  await page.fill('#pr-filter', String(HELD));
  await page.waitForTimeout(300);
  const f = await page.evaluate(() => [...document.querySelectorAll('#as-view .as-ruler')].map(x => ({ id: x.dataset.scope, marks: x.querySelectorAll('.as-mark').length })));
  const carriers = REPS.filter(r => r.carried.includes(HELD)).map(r => 'rep:' + r.id);
  ok(`${HELD} typed: every repeater that carries it drawn (${carriers.length})`, carriers.every(id => f.some(x => x.id === id)), J({ f, carriers }));
  ok('…each with the address marked on it', f.filter(x => carriers.includes(x.id)).every(x => x.marks === 1), J(f));
  await page.fill('#pr-filter', '');
  await page.waitForTimeout(200);

  // ── 3. the grid ───────────────────────────────────────────────────────────
  console.log('\nThe grid\n');
  await page.locator('#as-grid').scrollIntoViewIfNeeded();
  const sizeOf = () => page.evaluate(() => { const w = document.querySelector('#as-grid-body .as-grid-wrap');
    return { g: AddressSpace.grid(), drawn: document.getElementById('as-grid').getBoundingClientRect().width, card: w.getBoundingClientRect().width, over: w.scrollWidth - w.clientWidth }; });
  const gs = await sizeOf();
  ok(`the grid is as wide as its card (${Math.round(gs.drawn)} of ${Math.round(gs.card)} px), its cells as big as that allows (${gs.g.cell} px), nothing to scroll sideways`,
    Math.abs(gs.drawn - gs.card) <= 1 && gs.over <= 0 && gs.g.cell >= Math.floor((gs.card - 200) / 100), J(gs));
  // The page stops widening at its own max width, a little past 1,600 px.
  await page.setViewportSize({ width: 1600, height: 900 });
  await until(page, w => { const g = AddressSpace.grid(); return g && g.avail > w + 50; }, gs.g.avail);
  const gs2 = await sizeOf();
  ok(`…and grows with it, wider and taller, when the window widens (${Math.round(gs2.drawn)} px, ${gs2.g.cell} px cells)`,
    Math.abs(gs2.drawn - gs2.card) <= 1 && gs2.over <= 0 && gs2.g.cell > gs.g.cell && gs2.g.H > gs.g.H, J({ gs, gs2 }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await until(page, w => { const g = AddressSpace.grid(); return g && g.avail === w; }, gs.g.avail);
  await page.locator('#as-grid').scrollIntoViewIfNeeded();
  await page.fill('#as-look', String(HELD));
  const lk = await page.evaluate(() => ({ text: document.getElementById('as-readout').textContent, box: document.getElementById('pr-filter').value, sel: AddressSpace.wheel().sel }));
  ok(`an address looked up names the station holding it (${HELD}, ${HELD_BY.name}), goes into the filter box and is kept on the wheel`,
    lk.text.includes(HELD_BY.name) && lk.box === String(HELD) && lk.sel && lk.sel.addr === HELD, J(lk));
  const FREE = R.t.runs[0].lo;
  const gg = await page.evaluate(() => AddressSpace.grid());
  const row = Math.floor(FREE / 100), col = FREE % 100;
  await page.locator('#as-grid').click({ position: { x: gg.x0 + col * gg.cell + gg.cell / 2, y: gg.top + row * gg.cell + Math.floor(row / 10) * gg.rg + gg.cell / 2 } });
  const ro = await page.evaluate(() => ({ pick: AddressSpace.state().pickAddr, text: document.getElementById('as-readout').textContent, box: document.getElementById('pr-filter').value,
    look: document.getElementById('as-look').value, sel: AddressSpace.wheel().sel, out: document.getElementById('as-wheel-out').textContent }));
  ok(`a free address pressed in the grid is picked, and offers itself (${FREE})`, ro.pick === FREE && new RegExp(`free.*Allocate ${FREE}`).test(ro.text), J(ro));
  ok('…into the filter box and the grid\'s Address, kept on the wheel and said under it', ro.box === String(FREE) && ro.look === String(FREE)
    && ro.sel && ro.sel.addr === FREE && ro.out.includes(`${FREE} —`), J(ro));
  await page.click('#as-readout .link-btn:last-of-type');
  const formed = await page.evaluate(() => Object.assign(AddressSpace.state().form, { open: document.getElementById('as-alloc').open }));
  ok('…to the Allocate card, opened: the repeater that carries it, that address, one of it', formed.open && formed.first === String(FREE) && formed.count === 1
    && REPS.find(r => 'rep:' + r.id === formed.where)?.carried.includes(FREE), J(formed));

  // ── 3b. the wheel ─────────────────────────────────────────────────────────
  console.log('\nAll addresses: the wheel\n');
  ok('the wheel starts on the busiest hub, as the grid does', (await page.evaluate(() => document.querySelector('#as-wheel-body select').value)) === 'hub:brisbane');
  const WG = Math.floor(HELD / 100), wlo = Math.max(1, WG * 100), whi = WG * 100 + 99;
  const wantReps = REPS.filter(r => r.hub === 'brisbane' && r.carried.some(a => a >= wlo && a <= whi)).map(r => r.id).sort();
  let wantHeld = 0;
  for (let a = wlo; a <= whi; a++) if ((held.get(`brisbane|${a}`) || []).length) wantHeld++;
  const st = await page.evaluate(([lo, hi]) => AddressSpace.stretch(lo, hi), [wlo, whi]);
  ok(`a wedge counted as the station file has it, every repeater carrying any of it named (${wlo}–${whi}: ${wantHeld} held, ${wantReps.length} repeaters)`,
    st.held === wantHeld && J(st.reps.map(x => x.id).sort()) === J(wantReps), J({ held: st.held, reps: st.reps.map(x => x.id), wantReps }));
  await page.locator('#as-wheel').scrollIntoViewIfNeeded();
  const geo = await page.evaluate(() => AddressSpace.wheel().geom);
  const wbox = await page.locator('#as-wheel').boundingBox();
  const cardW = await page.evaluate(() => document.getElementById('as-wheel-body').clientWidth);
  ok(`the wheel is as wide as its card, up to 1,240 px (${Math.round(wbox.width)} of ${cardW})`, Math.abs(wbox.width - Math.min(1240, cardW)) <= 2, J({ w: wbox.width, cardW }));
  const kk = wbox.width / geo.D;
  const onWheel = (a, r) => { const th = -Math.PI / 2 + (2 * Math.PI * a) / 8200; return [wbox.x + (geo.cx + Math.cos(th) * r) * kk, wbox.y + (geo.cy + Math.sin(th) * r) * kk]; };
  // The inner bars: a block at a time.
  const [px, py] = onWheel(WG * 100 + 50, (geo.rC0 + geo.rC1) / 2);
  await page.mouse.move(px, py);
  const firstRep = REPS.find(r => r.id === st.reps[0].id);
  const tip = await page.evaluate(() => { const t = document.getElementById('as-wheel-tip'); const w = AddressSpace.wheel(); return { shown: !t.hidden, text: t.textContent, hover: w.hover, ring: w.ring, lit: document.querySelector('.as-ring-row.is-on')?.dataset.ring }; });
  ok(`pointing at a wedge's inner bar calls out the repeaters carrying it (${firstRep.name}, …), its row of the key lit`, tip.shown && tip.hover === WG && tip.ring === 'block' && tip.lit === 'block'
    && tip.text.includes(`${wlo}–${whi}`) && tip.text.includes(firstRep.name), J(tip));
  await page.mouse.click(px, py);
  const kept = await page.evaluate(() => ({ sel: AddressSpace.wheel().sel, text: document.getElementById('as-wheel-out').textContent }));
  ok('…pressing it keeps it, the readout naming them', kept.sel && kept.sel.wedge === WG && kept.sel.addr == null && kept.text.includes(firstRep.name) && /On the address grid/.test(kept.text), J(kept));
  // The outer ring: an address at a time — the one a station holds.
  const [ax, ay] = onWheel(HELD + 0.5, (geo.rA0 + geo.R) / 2);
  await page.mouse.move(ax, ay);
  const pt = await page.evaluate(() => { const t = document.getElementById('as-wheel-tip'); const w = AddressSpace.wheel(); return { text: t.textContent, ring: w.ring, addr: w.addr, cells: t.querySelectorAll('.as-strip rect[class^="as-c-"]').length, mark: !!t.querySelector('.as-strip-at') }; });
  ok(`pointing at the outer ring goes address by address — ${HELD}, ${HELD_BY.name}'s, its block drawn a cell an address`, pt.ring === 'addr' && Math.abs(pt.addr - HELD) <= 1
    && pt.text.includes(String(pt.addr)) && (pt.addr !== HELD || pt.text.includes(HELD_BY.name)) && pt.cells === (WG === 0 ? 99 : 100) && pt.mark, J(pt));
  const [bx, by] = onWheel(HELD + 0.5, (geo.rB0 + geo.rB1) / 2);
  await page.mouse.move(bx, by);
  const mid = await page.evaluate(() => { const w = AddressSpace.wheel(); return { ring: w.ring, addr: w.addr, text: document.getElementById('as-wheel-tip').textContent, lit: document.querySelector('.as-ring-row.is-on')?.dataset.ring }; });
  ok('…and the middle ring the same, said to be the repeaters carrying it', mid.ring === 'cover' && mid.lit === 'cover' && Math.abs(mid.addr - HELD) <= 1 && /Middle ring/.test(mid.text), J(mid));
  await page.mouse.click(ax, ay);
  const keptA = await page.evaluate(() => ({ sel: AddressSpace.wheel().sel, text: document.getElementById('as-wheel-out').textContent,
    box: document.getElementById('pr-filter').value, look: document.getElementById('as-look').value }));
  ok('…an address pressed is kept with its wedge, as near as a pixel of the ring allows', keptA.sel && Math.abs(keptA.sel.addr - HELD) <= 4
    && keptA.sel.wedge === Math.floor(keptA.sel.addr / 100) && keptA.text.includes(String(keptA.sel.addr)), J(keptA));
  ok('…and goes into the filter box and the grid\'s Address', keptA.box === String(keptA.sel.addr) && keptA.look === keptA.box, J(keptA));
  // Under the wheel, the kept block drawn wide enough to press any one address.
  await page.locator('#as-wheel-out .as-strip-pick svg').scrollIntoViewIfNeeded();
  const sbox = await page.locator('#as-wheel-out .as-strip-pick svg').boundingBox();
  const KB = Math.floor(keptA.sel.addr / 100) * 100;
  const T = Array.from({ length: 100 }, (_, i) => KB + i).find(a => a >= 1 && a !== keptA.sel.addr && (held.get(`brisbane|${a}`) || []).length === 1);
  const T_BY = DOC.stations.find(x => x.id === held.get(`brisbane|${T}`)[0]);
  await page.mouse.click(sbox.x + ((T - KB + 0.5) / 100) * sbox.width, sbox.y + sbox.height / 2);
  const keptS = await page.evaluate(() => ({ sel: AddressSpace.wheel().sel, text: document.getElementById('as-wheel-out').textContent }));
  ok(`…and its block under the wheel picks the very one: ${T}, ${T_BY.name}`, keptS.sel && keptS.sel.addr === T && keptS.text.includes(T_BY.name), J(keptS));
  await page.locator('#as-wheel').scrollIntoViewIfNeeded();
  const wb3 = await page.locator('#as-wheel').boundingBox();
  await page.mouse.move(wb3.x + 2, wb3.y + 2);
  ok('…and the callout goes when the pointer leaves the rings', await page.evaluate(() => document.getElementById('as-wheel-tip').hidden && AddressSpace.wheel().hover === null));
  await page.focus('#as-wheel');
  await page.keyboard.press('Shift+ArrowRight');
  ok('Shift and an arrow step to the next address', (await page.evaluate(() => AddressSpace.wheel().sel)).addr === T + 1);
  await page.keyboard.press('ArrowRight');
  ok('the arrow keys step to the next wedge', (await page.evaluate(() => AddressSpace.wheel().sel)).wedge === (Math.floor((T + 1) / 100) + 1) % 82);
  // The filter box: the address marked on the wheel and the grid, with a
  // ring that glows over each and its number, and said under the wheel.
  await page.fill('#pr-filter', String(HELD));
  await page.waitForTimeout(300);
  const pins = await page.evaluate(() => ({ wheel: document.querySelectorAll('#as-wheel-pins .as-pin').length, tag: document.querySelector('#as-wheel-pins .as-pin-tag')?.textContent,
    grid: document.querySelectorAll('#as-grid-pins .as-pin').length, anim: getComputedStyle(document.querySelector('#as-wheel-pins .as-pin') || document.body).animationName,
    out: document.getElementById('as-wheel-out').textContent, sel: (AddressSpace.wheel().sel || {}).addr }));
  ok(`an address in the filter box (${HELD}) is kept, ringed and tagged on the wheel, ringed on the grid, and said under the wheel`, pins.wheel === 1 && pins.tag === String(HELD)
    && pins.grid === 1 && pins.sel === HELD && pins.anim === 'as-pin-glow' && pins.out.includes('In the filter box') && pins.out.includes(HELD_BY.name), J(pins));
  await page.fill('#pr-filter', '');
  await page.waitForTimeout(200);
  ok('…and the marks go when the filter box is emptied, and the wheel lets it go', await page.evaluate(() => !document.querySelector('#as-wheel-pins .as-pin')
    && !/In the filter box/.test(document.getElementById('as-wheel-out').textContent) && !AddressSpace.wheel().sel));
  const gap0 = figuresOf(Array.from({ length: MAX }, (_, i) => i + 1), ['brisbane']).runs.slice().sort((a, b) => (b.n - a.n) || (a.lo - b.lo))[0];
  const chip = await page.evaluate(() => { const b = document.querySelector('.as-gaps .pill'); return b && { lo: Number(b.dataset.lo), text: b.textContent }; });
  ok(`the biggest gap first under the wheel (${gap0.lo}–${gap0.hi}, ${gap0.n})`, chip && chip.lo === gap0.lo && chip.text.includes(`${gap0.lo}–${gap0.hi}`), J(chip));
  await page.click('.as-gaps .pill');
  const gk = await page.evaluate(() => ({ sel: AddressSpace.wheel().sel, text: document.getElementById('as-wheel-out').textContent, pressed: document.querySelector('.as-gaps .pill').getAttribute('aria-pressed') }));
  ok('…pressed, it is kept and said to be a gap', gk.sel && gk.sel.gap && gk.sel.lo === gap0.lo && gk.sel.hi === gap0.hi
    && gk.text.includes(`a gap of ${gap0.n.toLocaleString()}`) && gk.pressed === 'true', J(gk));
  const carriedB = new Set(REPS.filter(r => r.hub === 'brisbane').flatMap(r => r.carried));
  let firstFree = null;
  for (let a = gap0.lo; a <= gap0.hi && firstFree == null; a++) if (carriedB.has(a)) firstFree = a;
  firstFree ??= gap0.lo;
  await page.evaluate(() => [...document.querySelectorAll('#as-wheel-out .link-btn')].find(b => /address grid/.test(b.textContent)).click());
  const tg = await page.evaluate(() => Object.assign(AddressSpace.state(), { look: document.getElementById('as-look').value }));
  ok(`…and On the address grid takes its first free address there, under a repeater if one is (${firstFree})`, tg.scope === 'hub:brisbane' && tg.pickAddr === firstFree
    && tg.look === String(firstFree), J({ scope: tg.scope, pick: tg.pickAddr, look: tg.look }));

  // Every hub together.
  const HUBS = DOC.hubs.map(h => h.id);
  const hubsAt = a => HUBS.filter(h => (held.get(`${h}|${a}`) || []).length);
  const twoIn = a => HUBS.some(h => (held.get(`${h}|${a}`) || []).length > 1);
  let eUse = 0, eClash = 0, eLong = null, eCur = null, REUSED = null;
  for (let a = 1; a <= MAX; a++) {
    const n = hubsAt(a).length;
    if (twoIn(a)) eClash++; else if (n) eUse++;
    if (n >= 2 && !twoIn(a) && REUSED == null) REUSED = a;
    if (n) { eCur = null; continue; }
    if (eCur && a === eCur.hi + 1) { eCur.hi = a; eCur.n++; } else eCur = { lo: a, hi: a, n: 1 };
    if (!eLong || eCur.n > eLong.n) eLong = { ...eCur };
  }
  const every = await page.evaluate(() => AddressSpace.figures('all'));
  ok(`Every hub together: in use where any hub's station holds it (${eUse}), two only inside one hub (${eClash}), the longest gap ${eLong.lo}–${eLong.hi}`,
    every.n === MAX && every.use === eUse && every.clash === eClash && every.longest.lo === eLong.lo && every.longest.hi === eLong.hi,
    J({ n: every.n, use: every.use, clash: every.clash, longest: every.longest && [every.longest.lo, every.longest.hi] }));
  await page.selectOption('#as-grid-body select', 'all');
  await page.fill('#as-look', String(REUSED));
  const ro2 = await page.evaluate(() => document.getElementById('as-readout').innerHTML);
  ok(`…on the grid, an address ${hubsAt(REUSED).length} hubs reuse is in use in each, not held by two (${REUSED})`,
    ro2.includes(`in use in ${hubsAt(REUSED).length} hubs`) && !/txt-bad/.test(ro2), ro2.slice(0, 300));
  ok('…Show set on the grid sets the wheel too', (await page.evaluate(() => document.querySelector('#as-wheel-body select').value)) === 'all');
  const chip2 = await page.evaluate(() => ({ scope: document.querySelector('#as-wheel-body select').value, grid: AddressSpace.state().scope, lo: Number((document.querySelector('.as-gaps .pill') || {}).dataset?.lo) }));
  ok('…on the wheel, its biggest gap the one nobody anywhere is on', chip2.scope === 'all' && chip2.grid === 'all' && chip2.lo === eLong.lo, J(chip2));
  const W2 = Array.from({ length: 82 }, (_, i) => i).find(w => new Set(REPS.filter(r => r.carried.some(a => a >= Math.max(1, w * 100) && a <= w * 100 + 99)).map(r => r.hub)).size >= 2);
  const w2lo = Math.max(1, W2 * 100), w2hi = W2 * 100 + 99;
  const want2 = REPS.filter(r => r.carried.some(a => a >= w2lo && a <= w2hi)).map(r => r.id).sort();
  let wantReuse = 0;
  for (let a = w2lo; a <= w2hi; a++) if (hubsAt(a).length >= 2 && !twoIn(a)) wantReuse++;
  const st2 = await page.evaluate(([lo, hi]) => AddressSpace.stretch(lo, hi), [w2lo, w2hi]);
  ok(`…a wedge names the repeaters of every hub carrying it (${w2lo}–${w2hi}: ${want2.length}), and counts the reuse (${wantReuse})`,
    J(st2.reps.map(x => x.id).sort()) === J(want2) && st2.hub2 + st2.hub3 === wantReuse, J({ reps: st2.reps.length, want: want2.length, reuse: st2.hub2 + st2.hub3 }));
  await page.locator('#as-wheel').scrollIntoViewIfNeeded();
  const geo2 = await page.evaluate(() => AddressSpace.wheel().geom);
  const wbox2 = await page.locator('#as-wheel').boundingBox();
  const th2 = -Math.PI / 2 + (2 * Math.PI * (W2 * 100 + 50)) / 8200, k2 = wbox2.width / geo2.D, r2 = (geo2.rC0 + geo2.rC1) / 2;
  await page.mouse.move(wbox2.x + (geo2.cx + Math.cos(th2) * r2) * k2, wbox2.y + (geo2.cy + Math.sin(th2) * r2) * k2);
  const tip2 = await page.evaluate(() => document.getElementById('as-wheel-tip').textContent);
  const hubNames = [...new Set(st2.reps.slice(0, 8).map(x => DOC.hubs.find(h => h.id === REPS.find(r => r.id === x.id).hub).name))];
  ok(`…and the callout says each one's hub (${hubNames.join(', ')})`, hubNames.every(n => tip2.includes(`(${n})`)), tip2.slice(0, 300));
  await page.mouse.move(wbox2.x + 2, wbox2.y + 2);
  await page.evaluate(() => AddressSpace.setScope('hub:brisbane'));
  await page.fill('#pr-filter', '');

  // ── 4. the map ────────────────────────────────────────────────────────────
  console.log('\nThe map\n');
  await until(page, () => !!AddressSpace.state().map);
  const at = z => page.evaluate(zz => { const m = AddressSpace.state().map; m.setZoom(zz, { animate: false }); return AddressSpace.clusters(); }, z);
  const far = await at(5), near = await at(11);
  ok(`zoomed out the circles merge (${far.length}), zoomed in they break apart (${near.length})`, far.length < near.length && near.length <= REPS.length, J([far.length, near.length]));
  const merged = far.filter(c => c.reps.length > 1).sort((a, b) => b.reps.length - a.reps.length)[0];
  const keys = new Set();
  merged.reps.forEach(id => { const r = REPS.find(x => x.id === id); r.carried.forEach(a => { if (!(held.get(`${r.hub}|${a}`) || []).length) keys.add(`${r.hub}|${a}`); }); });
  const summed = merged.reps.reduce((t, id) => t + figuresOf(REPS.find(x => x.id === id).carried, [REPS.find(x => x.id === id).hub]).free, 0);
  ok(`a merged circle of ${merged.reps.length} repeaters is its free addresses counted once (${keys.size}), not summed (${summed})`, merged.free === keys.size, J({ got: merged.free, want: keys.size, summed }));
  ok('…and the circles are on the map, numbered', await page.evaluate(() => [...document.querySelectorAll('#as-map .as-bubble')].every(b => /^\d/.test(b.textContent))
    && document.querySelectorAll('#as-map .as-bubble').length > 0));

  // ── 5. signed out ─────────────────────────────────────────────────────────
  console.log('\nThe Allocate card, signed out\n');
  await page.evaluate(id => AddressSpace.allocateIn(id), 'rep:' + R.r.id);
  // Allocate puts the caret in What for a moment later: wait for it, or a
  // field filled meanwhile can lose its typing to it.
  await until(page, () => document.activeElement && document.activeElement.id === 'as-purpose');
  await page.fill('#as-count', '2');
  await page.fill('#as-first', '');
  await page.fill('#as-purpose', 'New rain gauge at Check Flat');
  const want0 = bestFit(R.t.runs, 2);
  const out = await page.evaluate(() => ({ ids: AddressSpace.plan().ids, go: document.getElementById('as-go').disabled, text: document.getElementById('as-alloc').textContent }));
  ok(`it suggests the smallest free run that fits — ${want0.lo}–${want0.lo + 1} in ${want0.lo}–${want0.hi}`, J(out.ids) === J([want0.lo, want0.lo + 1]), J(out.ids));
  ok('…and cannot allocate, saying so', out.go && /Sign in as an editor/.test(out.text) && /Sign in to see the addresses set aside/.test(out.text));

  // ── 6. signed in, an editor ───────────────────────────────────────────────
  console.log('\nThe Allocate card, an editor\n');
  ALLOC = [
    { id: 'a-1', batch: 'b-a', hub_id: 'brisbane', alert_id: want0.lo, purpose: 'Somebody else\'s gauge', repeater_id: R.r.id, station_id: null,
      created_by: 'other@example.test', created_at: '2026-10-20T01:00:00Z', released_at: null },
    { id: 'a-2', batch: 'b-b', hub_id: 'brisbane', alert_id: HELD, purpose: 'Built since', repeater_id: R.r.id, station_id: null,
      created_by: 'other@example.test', created_at: '2026-10-21T01:00:00Z', released_at: null },
  ];
  await page.evaluate(() => { Auth.isSignedIn = () => true; Auth.mayWrite = () => true; dbCanWrite = () => true; AddressSpace.authChanged(); });
  await until(page, () => AddressSpace.state().alloc.phase === 'ready');
  const list = await page.evaluate(() => [...document.querySelectorAll('.as-allocs tbody tr')].map(r => r.textContent.replace(/\s+/g, ' ')));
  ok('what is set aside is read and listed, a row a batch', list.length === 2, J(list));
  ok(`…one a station holds now said to be taken up by it (${HELD_BY.name})`, list.some(t => t.includes('Built since') && t.includes(`taken up by ${HELD_BY.name}`)), J(list));
  const fig = await page.evaluate(id => AddressSpace.figures(id), 'rep:' + R.r.id);
  ok('the repeater counts the one waiting as set aside', fig.alloc === 1 && fig.free === R.t.free - 1, J({ alloc: fig.alloc, free: fig.free }));
  // The form outlives the reload; the suggestion steps round what is set aside.
  await page.evaluate(id => AddressSpace.allocateIn(id), 'rep:' + R.r.id);
  // Allocate puts the caret in What for a moment later: wait for it, or a
  // field filled meanwhile can lose its typing to it.
  await until(page, () => document.activeElement && document.activeElement.id === 'as-purpose');
  await page.fill('#as-count', '2');
  await page.fill('#as-purpose', 'New rain gauge at Check Flat');
  const alloc1 = new Set([`brisbane|${want0.lo}`]);
  const want1 = bestFit(figuresOf(R.r.carried, ['brisbane'], alloc1).runs, 2);
  const p1 = await page.evaluate(() => AddressSpace.plan());
  ok(`the suggestion steps round it: ${want1.lo}–${want1.lo + 1}`, J(p1.ids) === J([want1.lo, want1.lo + 1]) && !p1.why.length, J(p1));

  await page.fill('#as-first', String(HELD));
  await page.fill('#as-count', '1');
  const refused = await page.evaluate(() => ({ why: AddressSpace.plan().why, go: document.getElementById('as-go').disabled }));
  ok(`an address a station holds is refused before anything is sent (${HELD})`, refused.go && refused.why.some(w => w.includes(HELD_BY.name)) && !rpc.length, J(refused));
  await page.fill('#as-first', '');
  await page.fill('#as-count', '2');
  await page.click('#as-go');
  await until(page, () => /Set aside/.test((document.getElementById('as-msg') || {}).textContent || ''));
  const sent = rpc.find(x => x.fn === 'allocate');
  ok('Allocate sends the hub, the addresses, the repeater and the purpose', sent && sent.b.p_hub_id === 'brisbane' && J(sent.b.p_ids) === J([want1.lo, want1.lo + 1])
    && sent.b.p_repeater_id === R.r.id && sent.b.p_purpose === 'New rain gauge at Check Flat' && sent.b.p_station_id === null, J(sent));
  const after = await page.evaluate(id => ({ rows: document.querySelectorAll('.as-allocs tbody tr').length, fig: AddressSpace.figures(id), purpose: document.getElementById('as-purpose').value }), 'rep:' + R.r.id);
  ok('…and it is listed, counted as set aside, and the form cleared for the next', after.rows === 3 && after.fig.alloc === 3 && after.purpose === '', J({ rows: after.rows, alloc: after.fig.alloc }));

  await page.evaluate(() => [...document.querySelectorAll('.as-allocs tbody tr')].find(r => r.textContent.includes('Built since')).querySelector('button').click());
  await until(page, () => !!document.querySelector('[data-ask="yes"]'));
  await page.click('[data-ask="yes"]');
  await until(page, () => document.querySelectorAll('.as-allocs tbody tr').length === 2);
  const rel = rpc.find(x => x.fn === 'release');
  ok('Release asks first, sends the batch, and the row goes', rel && J(rel.b.p_ids) === J(['a-2']), J(rel));

  // ── 7. the exports ────────────────────────────────────────────────────────
  console.log('\nThe exports\n');
  for (const [fn, name, head] of [['exportCsv', 'floodnet-alert-addresses-hub-brisbane.csv', 'address,status,stations,station_ids,set_aside_for,set_aside_by,carried_by'],
    ['exportAllocCsv', 'floodnet-alert-allocations.csv', 'address,hub,purpose,repeater,station,set_aside_by,set_aside_at,taken_up_by']]) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(x => AddressSpace[x](), fn)]);
    const body = fs.readFileSync(await dl.path(), 'utf8').split('\n');
    ok(`${name}: named, headed${fn === 'exportCsv' ? ', every address of the hub' : ', a row an address set aside'}`, dl.suggestedFilename() === name && body[0] === head
      && (fn === 'exportCsv' ? body.filter(Boolean).length === MAX + 1 : body.filter(Boolean).length === 4), `${dl.suggestedFilename()} ${body[0]} ${body.filter(Boolean).length}`);
  }
  const offers = await page.evaluate(() => ExportMenu.offers('passranges').map(o => o.label));
  ok('the banner\'s Export offers both', offers.length === 2, J(offers));

  // ── 9. a phone ────────────────────────────────────────────────────────────
  console.log('\nA phone\n');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.evaluate(() => renderMain());
  await until(page, () => { const c = document.getElementById('as-wheel'); return c && c.width > 0; });
  for (const v of ['repeaters', 'networks']) {
    await page.evaluate(x => AddressSpace.setView(x), v);
    await page.waitForTimeout(250);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(`every card, Address space showing ${v}: nothing wider than a 375 px phone`, wide <= 376, String(wide));
  }
  await context.close();

  // ── 8. a datastore before 0084 ────────────────────────────────────────────
  console.log('\nA datastore before 0084\n');
  MISSING = true;
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await open(c2);
  await p2.evaluate(() => { Auth.isSignedIn = () => true; Auth.mayWrite = () => true; dbCanWrite = () => true; switchTab('passranges'); });
  await until(p2, () => AddressSpace.state().alloc.phase === 'missing');
  const miss = await p2.evaluate(() => document.getElementById('as-alloc').textContent);
  ok('the card says the migration is waiting, and allocates nothing', /migration 0084/.test(miss), miss.slice(0, 300));
  ok('…while the pictures still draw from the register', await p2.evaluate(() => document.querySelectorAll('#as-view .as-ruler').length > 0));
  await c2.close();

  ok('no page errors', !errors.length, errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`  FAIL ${e.stack || e}`);
} finally {
  if (errors.length && failures) console.log(`  page errors: ${errors.join(' | ')}`);
  await browser.close();
  await server.close();
}

if (failures) { console.log(`\nFAIL — ${failures} check(s).`); process.exit(1); }
console.log('\nPASS — the Pass Ranges tab\'s address space and Allocate card.');
