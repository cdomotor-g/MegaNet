// The Pass Ranges tab's Address space and Allocate card (address-space.js),
// driven in Chromium on the real station file, with the datastore's
// alert_allocation (0084) and its two doors stood in for by routes. The oracle
// is worked out here, in Node, from stations.json itself — a repeater carries
// an address inside a pass range and outside every exclusion, and an address
// is in use when a station in the same hub holds it — so a picture that
// counted the wrong hub, missed an exclusion or double-counted a network's
// shared addresses is red.
//
//   1. **The figures** — the busiest repeaters drawn first, each repeater's
//      in-use, free and longest free run as the oracle has them; a network's
//      addresses counted once across its repeaters, a lane a repeater; the
//      Brisbane Hub's grid every address the hub's stations hold.
//   2. **The filter box** — an address typed draws exactly the repeaters
//      that carry it, each marked where it is.
//   3. **The grid** — an address looked up names its station; a free one
//      pointed at with the mouse offers itself to the Allocate card.
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

  await page.evaluate(() => AddressSpace.setView('grid'));
  await until(page, () => { const c = document.getElementById('as-grid'); return c && c.width > 0; });
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
  await page.evaluate(() => AddressSpace.setView('grid'));
  await until(page, () => { const c = document.getElementById('as-grid'); return c && c.width > 0; });
  await page.fill('#as-look', String(HELD));
  ok(`an address looked up names the station holding it (${HELD}, ${HELD_BY.name})`,
    await page.evaluate(n => document.getElementById('as-readout').textContent.includes(n), HELD_BY.name));
  const FREE = R.t.runs[0].lo;
  const gw = await page.evaluate(() => document.getElementById('as-grid').getBoundingClientRect().width);
  const cell = (gw - 146) / 100, row = Math.floor(FREE / 100), col = FREE % 100;
  await page.locator('#as-grid').click({ position: { x: 46 + col * cell + cell / 2, y: 14 + row * cell + Math.floor(row / 10) * 3 + cell / 2 } });
  const ro = await page.evaluate(() => ({ pick: AddressSpace.state().pickAddr, text: document.getElementById('as-readout').textContent }));
  ok(`a free address pointed at in the grid is picked, and offers itself (${FREE})`, ro.pick === FREE && new RegExp(`free.*Allocate ${FREE}`).test(ro.text), J(ro));
  await page.click('#as-readout .link-btn:last-of-type');
  const formed = await page.evaluate(() => AddressSpace.state().form);
  ok('…to the Allocate card: the repeater that carries it, that address, one of it', formed.first === String(FREE) && formed.count === 1
    && REPS.find(r => 'rep:' + r.id === formed.where)?.carried.includes(FREE), J(formed));

  // ── 4. the map ────────────────────────────────────────────────────────────
  console.log('\nThe map\n');
  await page.evaluate(() => AddressSpace.setView('map'));
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
  await page.evaluate(() => AddressSpace.setView('grid'));
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
  for (const v of ['repeaters', 'networks', 'grid', 'map']) {
    await page.evaluate(x => AddressSpace.setView(x), v);
    await page.waitForTimeout(250);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    ok(`${v}: nothing wider than a 375 px phone`, wide <= 376, String(wide));
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
