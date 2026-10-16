// The ALERT2 Transition Plan tab (alert2-plan.js), held to what it claims.
//
// The register is the real stations.json the app loads, so the assertions are
// about the plan's *arithmetic and behaviour* — that its parts add up and move
// the way the card says they will — not about any one figure for Queensland.
//
//   Who it is for   signed out, or signed in without being an administrator,
//                   it says who it is for and draws no control.
//   The inventory   every field station, repeater and base it counts is in the
//                   scope it says, the regions add up to the totals, and the
//                   backbone is a subset of the repeaters.
//   The plan        the cost is its categories plus contingency, the FTE-years
//                   are the roles', the financial years add to the total, and
//                   every catchment's field work starts no earlier than the
//                   gates it says it waits for.
//   The backbone    catchment by catchment: every repeater in the plan is
//                   fitted once, a catchment needs its concentrators and every
//                   repeater from them to a base, its cut-over waits for its
//                   site works, its bases and the pilot, a rebuild for its
//                   design and its review; more rebuilds cost more; a site
//                   marked by its select is costed at that and not audited
//                   (the select keeps focus, its table stays open, the mark is
//                   kept and is no difference from the proposal); without the
//                   field stage nothing in the field is bought or done and the
//                   backbone is unchanged; ▲ ▼ reorder catchments in a region.
//   The card        a slider re-works the plan in place (the slider keeps its
//                   focus), more crews is never slower, contingency moves only
//                   the cost, the backbone-first switch and the reviews switch
//                   do what they say, a preset changes the figures and says how
//                   far from the proposal, and ▲ ▼ reorder the regions.
//   Catchments      the picker lists every catchment once under its region;
//                   unticking one takes exactly its stations out (its box keeps
//                   focus, its region shows a dash, its basin goes grey); a
//                   region's box clears all of its catchments; a repeater
//                   outside the ticks stays only if it carries a ticked station;
//                   nothing ticked says so and writes no file; presets leave the
//                   ticks alone; a place name under two hubs is two boxes; a tick
//                   from another scope is no difference to this one; reordering
//                   keeps a hidden region's place.
//   The files       the workbook and the CSV are floodnet-… and carry the plan.
//
// Run:  npm run a2plan
//       npm run a2plan -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const server = await startServer();
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await applyNetworkPolicy(page, server.origin);

// The shared store (0065) stood in for: the four functions, with the rules
// tools/check_alert2_plan.sql holds the real ones to — a scenario private to
// its author until shared, changed and removed by its author only — and a
// switch to refuse one, or to fail the read. Registered after the network
// policy, so it answers first.
const fake = {
  me: '00000000-0000-4000-8000-00000000a201', other: '00000000-0000-4000-8000-00000000a202',
  sites: new Map(), scenarios: [], calls: [], refuse: null, failRead: false, n: 0,
};
fake.scenarios.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', owner: fake.other, name: 'Eight crews, wet season worked', notes: 'From the Townsville meeting',
  shared: true, settings: { v: 1, fieldCrews: 8, wet: false }, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' });
fake.scenarios.push({ id: 'aaaaaaaa-0000-4000-8000-000000000002', owner: fake.other, name: 'Somebody else\'s private one', notes: null,
  shared: false, settings: { v: 1, fieldCrews: 1 }, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-03T00:00:00Z' });
const byName = id => (id === fake.me ? 'Test Admin' : 'Other Admin');
const scenOut = x => ({ id: x.id, name: x.name, notes: x.notes, shared: x.shared, mine: x.owner === fake.me, by: byName(x.owner),
                        settings: x.settings, created_at: x.created_at, updated_at: x.updated_at });
await page.route('**/rpc/a2plan_*', async route => {
  const fn = route.request().url().split('/rpc/')[1].split('?')[0];
  const a = JSON.parse(route.request().postData() || '{}');
  fake.calls.push({ fn, a });
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const no = (status, code, message) => json(status, { code, message });
  if (fake.refuse === fn) return no(403, '42501', 'only an administrator may say what a site needs');
  const now = new Date(Date.UTC(2026, 9, 16, 12, 0, fake.n++)).toISOString();
  if (fn === 'a2plan_read') {
    if (fake.failRead) return no(500, 'XX000', 'the database is having a moment');
    return json(200, { sites: [...fake.sites.values()],
      scenarios: fake.scenarios.filter(x => x.owner === fake.me || x.shared).sort((x, y) => y.updated_at.localeCompare(x.updated_at)).map(scenOut) });
  }
  if (fn === 'a2plan_site_set') {
    if (!a.p_condition) { fake.sites.delete(a.p_station_id); return json(200, { station_id: a.p_station_id, condition: null }); }
    if (!['fit', 'retrofit', 'rebuild'].includes(a.p_condition)) return no(400, '22023', 'a site condition is fit, retrofit or rebuild');
    const row = { station_id: a.p_station_id, condition: a.p_condition, updated_at: now, by: 'Test Admin' };
    fake.sites.set(a.p_station_id, row);
    return json(200, row);
  }
  if (fn === 'a2plan_scenario_save') {
    if (a.p_id == null) {
      const x = { id: `bbbbbbbb-0000-4000-8000-${String(fake.n).padStart(12, '0')}`, owner: fake.me, name: a.p_name.trim(), notes: (a.p_notes || '').trim() || null,
                  shared: !!a.p_shared, settings: a.p_settings, created_at: now, updated_at: now };
      fake.scenarios.push(x);
      return json(200, scenOut(x));
    }
    const x = fake.scenarios.find(y => y.id === a.p_id);
    if (!x || (x.owner !== fake.me && !x.shared)) return no(404, 'P0002', 'no such scenario');
    if (x.owner !== fake.me) return no(403, '42501', 'only the administrator who saved a scenario may change it — save your own copy');
    if (a.p_name != null) x.name = a.p_name.trim();
    if (a.p_notes != null) x.notes = a.p_notes.trim() || null;
    if (a.p_shared != null) x.shared = a.p_shared;
    if (a.p_settings != null) x.settings = a.p_settings;
    x.updated_at = now;
    return json(200, scenOut(x));
  }
  if (fn === 'a2plan_scenario_delete') {
    const x = fake.scenarios.find(y => y.id === a.p_id);
    if (!x) return json(200, false);
    if (x.owner !== fake.me) return no(403, '42501', 'only the administrator who saved a scenario may remove it');
    fake.scenarios = fake.scenarios.filter(y => y !== x);
    return json(200, true);
  }
  return no(404, 'PGRST202', 'no such function');
});

try {
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => { try { localStorage.removeItem('meganet.a2plan.scenario'); localStorage.removeItem('meganet.a2plan.loaded'); } catch (_) {} });
  // A site condition kept on the device, inside the card, as the revision
  // before 0065 kept them: carried to the database when the store answers.
  await page.evaluate(() => localStorage.setItem('meganet.a2plan.scenario', JSON.stringify({ fieldCrews: 4, sites: { amiens_knob_al: 'rebuild' } })));
  await page.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });

  // ── who it is for ──
  console.log('\nWho it is for\n');
  await page.evaluate(() => {
    Auth.isSignedIn = () => false; Auth.isAdmin = () => false; Auth.role = () => null;
    switchTab('a2plan');
  });
  let out = await page.evaluate(() => ({ text: document.getElementById('main-content').textContent,
    controls: document.querySelectorAll('#main-content input, #main-content select').length,
    signIn: !!document.querySelector('#main-content button[onclick="Auth.open()"]') }));
  ok('signed out it is a paragraph and Sign in, and no control', out.signIn && out.controls === 0, `${out.controls} control(s)`);
  await page.evaluate(() => { Auth.isSignedIn = () => true; Auth.role = () => 'editor'; Alert2Plan.authChanged(); });
  out = await page.evaluate(() => ({ text: document.getElementById('main-content').textContent,
    controls: document.querySelectorAll('#main-content input, #main-content select').length }));
  ok('signed in without being an administrator it says it is for administrators, and no control',
    /administrators only/i.test(out.text) && out.controls === 0, out.text.slice(0, 120));

  await page.evaluate(async () => {
    Auth.isAdmin = () => true; Auth.role = () => 'admin';
    try { await SLS.ensureData(); } catch (_) {}
    Alert2Plan.authChanged();
  });
  await page.waitForFunction(() => !!document.getElementById('a2p-out') && Alert2Plan.storeState().store === 'ready', null, { timeout: 20_000 });

  // ── the shared store ──
  console.log('\nThe shared store\n');
  const carried = await page.evaluate(() => ({ state: Alert2Plan.storeState(),
    kept: JSON.parse(localStorage.getItem('meganet.a2plan.scenario') || '{}') }));
  ok('opened by an administrator, the tab reads the shared store once',
    fake.calls.filter(c => c.fn === 'a2plan_read').length === 1 && carried.state.store === 'ready', JSON.stringify(fake.calls.map(c => c.fn)));
  ok('a site condition kept on the device the old way is saved for every administrator, then forgotten on the device',
    fake.sites.get('amiens_knob_al')?.condition === 'rebuild' && carried.state.conditions.amiens_knob_al === 'rebuild' && !('sites' in carried.kept),
    JSON.stringify({ fake: [...fake.sites.keys()], kept: Object.keys(carried.kept) }));
  ok('…the others\' shared scenarios are listed, and nobody else\'s private one',
    carried.state.scenarios.length === 1 && carried.state.scenarios[0].name === 'Eight crews, wet season worked' && !carried.state.scenarios[0].mine);
  fake.sites.clear();
  await page.evaluate(() => Alert2Plan.reloadStore());

  // ── the inventory ──
  console.log('\nThe inventory\n');
  const inv = await page.evaluate(() => {
    const I = Alert2Plan.inventory();
    const sum = k => I.regions.reduce((a, r) => a + r[k], 0);
    return {
      field: I.field.length, reps: I.reps.length, bases: I.bases.length, bb: I.reps.filter(r => r.backbone).length,
      sumField: sum('field'), sumRain: sum('rain'), sumLevel: sum('level'), sumReps: sum('repeaters'), sumBb: sum('backbone'), sumBases: sum('bases'),
      fieldRoles: I.field.every(f => f.s.roles.includes('field') && !f.s.roles.includes('repeater') && Object.keys(f.s.alert_ids || {}).length > 0),
      repRoles: I.reps.every(r => r.s.roles.includes('repeater')),
      qld: I.field.concat(I.reps).every(x => x.p.qld),
      noRig: !I.bases.some(b => /test (unit|rig)/i.test(b.s.name)),
      regions: I.regions.length,
    };
  });
  ok('it counts field stations, repeaters and bases from the register', inv.field > 100 && inv.reps > 10, JSON.stringify({ field: inv.field, reps: inv.reps, bases: inv.bases }));
  ok('a field station is one with the field role, ALERT addresses and no repeater role', inv.fieldRoles);
  ok('every repeater has the repeater role, and the backbone is some of them', inv.repRoles && inv.bb > 0 && inv.bb <= inv.reps, `${inv.bb} of ${inv.reps}`);
  ok('in the Queensland scope everything counted is in Queensland, and no test rig is a base', inv.qld && inv.noRig);
  ok('the regions add up to the totals', inv.sumField === inv.field && inv.sumRain + inv.sumLevel === inv.field
    && inv.sumReps === inv.reps && inv.sumBb === inv.bb && inv.sumBases === inv.bases, JSON.stringify(inv));
  const wider = await page.evaluate(() => { Alert2Plan.set('scope', 'all'); const n = Alert2Plan.inventory().field.length; Alert2Plan.set('scope', 'qld'); return n; });
  ok('the whole register is more than Queensland', wider > inv.field, `${wider} against ${inv.field}`);

  // ── the plan ──
  console.log('\nThe plan adds up\n');
  const P = await page.evaluate(() => {
    const M = Alert2Plan.plan();
    const s = Alert2Plan.scenario();
    const sum = arr => arr.reduce((a, v) => a + (v || 0), 0);
    const cats = Object.keys(M.cost);
    const fyTotal = M.fy.reduce((a, r) => a + r.total, 0);
    const equip = M.equipment.reduce((a, e) => a + e.total, 0);
    const gates = M.cats.map(c => ({ name: c.name, start: c.start, review: M.review.has(c.region) ? M.review.get(c.region).end : null, fit: c.cutover }));
    return {
      total: M.total, base: M.base, contingency: M.contingency, cont: s.contingency, cats: cats.map(k => [k, sum(M.cost[k])]),
      breakdown: M.breakdown.reduce((a, b) => a + b.v, 0), fyTotal, equip, equipCat: sum(M.cost.equip),
      fteTotal: M.fteTotal, fteRoles: Object.values(M.fteYears).reduce((a, v) => a + v, 0), end: M.end,
      fieldEnd: M.fieldEnd, gates, units: M.units, nField: M.nField, spares: s.spares, pilotEnd: M.pilotEnd,
      order: M.order, rows: M.regionRows.length,
    };
  });
  ok('the cost is its categories plus contingency at the card\'s rate',
    near(P.breakdown, P.total, 1) && near(P.contingency, P.base * P.cont / 100, 1), `${Math.round(P.total)} = ${Math.round(P.base)} + ${Math.round(P.contingency)}`);
  ok('the financial years add up to the total', near(P.fyTotal, P.total, 1), `${Math.round(P.fyTotal)} against ${Math.round(P.total)}`);
  ok('the equipment table is the equipment spend', near(P.equip, P.equipCat, 1), `${P.equip} against ${Math.round(P.equipCat)}`);
  ok('the FTE-years are the roles\'', near(P.fteTotal, P.fteRoles, 1e-6));
  ok('an ERT-A2 for every field station, with the spares', P.units.ertA2 >= Math.ceil(P.nField * (1 + P.spares / 100)));
  ok('every region is in the order once', P.rows === P.order.length && new Set(P.order).size === P.order.length);
  ok('no catchment\'s field work starts before its region\'s review, its backbone on ALERT2 or the pilot',
    P.gates.every(g => g.start >= P.pilotEnd - 1e-6 && (g.review == null || g.start >= g.review - 1e-6) && (g.fit == null || g.start >= g.fit - 1e-6)),
    JSON.stringify(P.gates.map(g => [g.name, g.start.toFixed(1), g.review && g.review.toFixed(1), g.fit && g.fit.toFixed(1)])));
  ok('the program ends after the last field station', P.end > P.fieldEnd);

  // ── the card ──
  console.log('\nThe card\n');
  const base = await page.evaluate(() => { const M = Alert2Plan.plan(); return { total: M.total, end: M.end, field: M.fieldEnd }; });
  // A slider moved as a person moves it: the input event, the plan worked
  // again, the slider still focused.
  const slid = await page.evaluate(async () => {
    const el = document.getElementById('a2p-c-fieldCrews');
    el.focus();
    el.value = String(Number(el.value) + 2);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    const M = Alert2Plan.plan();
    return { focused: document.activeElement === el, out: document.getElementById('a2p-c-fieldCrews-o').textContent,
             crews: Alert2Plan.scenario().fieldCrews, field: M.fieldEnd,
             kpi: document.querySelector('#a2p-kpis').textContent, note: /not the proposal/.test(document.querySelector('.a2p-controls').textContent) };
  });
  ok('a slider works the plan again in place, and keeps its focus', slid.focused && slid.crews === 6 && /6/.test(slid.out), JSON.stringify({ focused: slid.focused, out: slid.out }));
  ok('two more field crews finish the field sooner', slid.field < base.field, `${slid.field.toFixed(1)} against ${base.field.toFixed(1)}`);
  ok('…and the figures say how far that is from the proposal', /than the proposal/.test(slid.kpi) && slid.note);

  const crews = await page.evaluate(() => [1, 2, 3, 4, 6, 8, 10].map(n => Alert2Plan.model({ ...Alert2Plan.defaults(), fieldCrews: n }).fieldEnd));
  ok('more crews is never slower', crews.every((v, i) => !i || v <= crews[i - 1] + 1e-6), crews.map(v => v.toFixed(1)).join(' ≥ '));

  const cont = await page.evaluate(() => {
    const a = Alert2Plan.model({ ...Alert2Plan.defaults(), contingency: 10 });
    const b = Alert2Plan.model({ ...Alert2Plan.defaults(), contingency: 40 });
    return { ba: a.base, bb: b.base, ea: a.end, eb: b.end, ta: a.total, tb: b.total };
  });
  ok('contingency moves the cost and nothing else', near(cont.ba, cont.bb, 1) && cont.ea === cont.eb && near(cont.tb - cont.ta, cont.ba * 0.3, 1));

  const bb = await page.evaluate(() => {
    const d = Alert2Plan.defaults();
    const on = Alert2Plan.model(d), off = Alert2Plan.model({ ...d, backboneFirst: false });
    return { on: on.end, off: off.end, onFit: on.acts.some(a => a.row === 'fit'), offFit: off.acts.some(a => a.row === 'fit'),
             onStart: Math.min(...on.acts.filter(a => a.row === 'audit' || a.row === 'acquire').map(a => a.start)),
             offStart: Math.min(...off.acts.filter(a => a.row === 'acquire').map(a => a.start)), P: on.P };
  });
  ok('backbone first starts the backbone on day one, ahead of the equipment', bb.onStart === 0 && bb.onFit, JSON.stringify(bb));
  ok('without it, the backbone waits for the equipment and goes with each catchment', bb.offStart >= bb.P && !bb.offFit, JSON.stringify(bb));

  const rv = await page.evaluate(() => {
    const d = Alert2Plan.defaults();
    const on = Alert2Plan.model(d), off = Alert2Plan.model({ ...d, reviews: false });
    return { onAdded: on.added, offAdded: off.added, offRemoved: off.removed, onReviews: on.acts.filter(a => a.row === 'review').length,
             offReviews: off.acts.filter(a => a.row === 'review').length, regions: on.regionRows.length };
  });
  ok('the reviews switch: a review per region with it, none and no network changes without it',
    rv.onReviews === rv.regions && rv.offReviews === 0 && rv.offAdded === 0 && rv.offRemoved === 0 && rv.onAdded > 0, JSON.stringify(rv));

  const wet = await page.evaluate(() => {
    const d = Alert2Plan.defaults();
    return { wet: Alert2Plan.model(d).fieldEnd, dry: Alert2Plan.model({ ...d, wet: false }).fieldEnd };
  });
  ok('slowing the wet season makes the field take longer', wet.wet > wet.dry, `${wet.wet.toFixed(1)} against ${wet.dry.toFixed(1)}`);

  const fwin = await page.evaluate(() => {
    const d = Alert2Plan.defaults();
    const a = Alert2Plan.model({ ...d, fwinPct: 0 }), b = Alert2Plan.model({ ...d, fwinPct: 60 });
    return { a: a.fteYears.field, b: b.fteYears.field };
  });
  ok('more stations converted on FWIN visits is fewer field FTE-years', fwin.b < fwin.a, `${fwin.b.toFixed(1)} against ${fwin.a.toFixed(1)}`);

  const pre = await page.evaluate(() => {
    Alert2Plan.preset('faster');
    const fast = Alert2Plan.plan().end;
    const kpi = document.querySelector('#a2p-kpis').textContent;
    Alert2Plan.preset('proposed');
    return { fast, prop: Alert2Plan.plan().end, kpi, back: document.querySelector('#a2p-kpis').textContent };
  });
  ok('a preset re-works the plan and says how far from the proposal; "The proposal" puts it back',
    pre.fast < pre.prop && /less than the proposal/.test(pre.kpi) && !/than the proposal/.test(pre.back), JSON.stringify({ fast: pre.fast, prop: pre.prop }));

  const mv = await page.evaluate(async () => {
    const before = Alert2Plan.plan().order.slice();
    const btn = document.querySelector('#a2p-out button[aria-label^="Convert"][aria-label$="later"]');
    btn.click();
    await new Promise(r => setTimeout(r, 30));
    const after = Alert2Plan.plan().order.slice();
    return { before, after, focused: document.activeElement && document.activeElement.tagName === 'BUTTON' && !!document.activeElement.closest('#a2p-out'),
             tableFirst: document.querySelector('#a2p-out .a2p-table tbody th[scope="row"]').firstChild.nextSibling.textContent.trim() };
  });
  ok('▼ moves a region later, the order is kept, the table follows and focus stays on the control',
    mv.after[0] === mv.before[1] && mv.after[1] === mv.before[0] && mv.tableFirst === mv.after[0] && mv.focused, JSON.stringify(mv));
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('meganet.a2plan.scenario') || '{}').order || []);
  ok('the scenario is kept on this device', kept[0] === mv.after[0], kept.slice(0, 2).join(', '));

  // ── the backbone, catchment by catchment ──
  console.log('\nThe backbone, catchment by catchment\n');
  await page.evaluate(() => Alert2Plan.reset());
  const bk = await page.evaluate(() => {
    const M = Alert2Plan.plan(), I = Alert2Plan.inventory(), C = Alert2Plan.catalogue(), s = Alert2Plan.scenario();
    const keyOf = new Map(I.field.map(f => [f.s.id, f.key]));
    // A catchment needs every repeater in the plan that carries one of its
    // stations, and every repeater on the way from those to a base.
    const missing = [];
    for (const c of M.cats) {
      const needs = new Set(c.needs);
      for (const r of I.reps) {
        if (![...r.carriedIds].some(id => keyOf.get(id) === c.key)) continue;
        if (!needs.has(r.s.id)) missing.push(`${c.name}: ${r.s.name}`);
        for (const p of C.pathOf.get(r.s.id) || []) if (!needs.has(p)) missing.push(`${c.name}: relay ${p}`);
      }
    }
    const gates = M.cats.filter(c => c.cutover != null).map(c => ({ name: c.name, cut: c.cutover,
      after: Math.max(c.retroEnd || 0, c.rebuildEnd || 0, c.baseReady, M.pilotEnd) }));
    const rebuilds = M.cats.filter(c => c.rebuildStart != null).map(c => ({ name: c.name, start: c.rebuildStart,
      after: Math.max(c.audited + s.rebuildLeadMonths, M.review.has(c.region) ? M.review.get(c.region).end : 0) }));
    const unheard = M.cats.filter(c => !c.needs.length);
    return {
      fresh: M.cats.reduce((a, c) => a + c.fresh, 0), reps: I.reps.length, missing: missing.slice(0, 5), nMissing: missing.length,
      classes: M.nRetro + M.nRebuild + M.nFitOnly, audit: M.nAudit, bbUnmarked: I.reps.filter(r => r.backbone).length,
      rebuild: M.nRebuild, rebuildPct: s.rebuildPct, retro: M.nRetro, retrofitPct: s.retrofitPct,
      lateGates: gates.filter(g => g.cut < g.after - 1e-6).map(g => g.name), nGates: gates.length,
      lateRebuilds: rebuilds.filter(r => r.start < r.after - 1e-6).map(r => r.name), nRebuilds: rebuilds.length,
      unheard: unheard.every(c => c.cutover == null && (c.start == null || c.start >= c.baseReady - 1e-6)),
      first: M.firstCut, ready: M.bbReady, shared: M.shared,
      kpi: document.getElementById('a2p-kpis').textContent,
    };
  });
  ok('every repeater in the plan is fitted once, by the first catchment that needs it', bk.fresh === bk.reps, `${bk.fresh} of ${bk.reps}`);
  ok('a catchment needs the repeaters that carry its stations and every repeater from them to a base', bk.nMissing === 0, bk.missing.join(' | '));
  ok('every site is one of fit-out, retrofit or rebuild, and with nothing marked every backbone site is audited first',
    bk.classes === bk.reps && bk.audit === bk.bbUnmarked, JSON.stringify({ classes: bk.classes, audit: bk.audit }));
  ok('…and the unassessed are allotted at the card\'s mix, to the site', Math.abs(bk.rebuild - bk.audit * bk.rebuildPct / 100) <= 1
    && Math.abs(bk.rebuild + bk.retro - bk.audit * (bk.rebuildPct + bk.retrofitPct) / 100) <= 1, JSON.stringify({ rebuild: bk.rebuild, retro: bk.retro, audit: bk.audit }));
  ok('no catchment is cut over before its site works, its bases and the pilot', bk.nGates > 10 && bk.lateGates.length === 0, bk.lateGates.join(', '));
  ok('no structure is rebuilt before its design lead from its audit and its network\'s review', bk.nRebuilds > 0 && bk.lateRebuilds.length === 0, bk.lateRebuilds.join(', '));
  ok('a catchment no repeater carries has no cut-over, and its field work waits for its bases', bk.unheard);
  ok('the figures say when the backbone is on ALERT2, the first catchment before the last', bk.first < bk.ready && /Backbone on ALERT2/.test(bk.kpi) && bk.shared > 0, JSON.stringify({ first: bk.first, ready: bk.ready }));

  const heavy = await page.evaluate(() => {
    const d = Alert2Plan.defaults();
    const a = Alert2Plan.model(d), b = Alert2Plan.model({ ...d, rebuildPct: 35 }), c = Alert2Plan.model({ ...d, rebuildLeadMonths: 14 });
    const over = Alert2Plan.model({ ...d, retrofitPct: 90, rebuildPct: 30 });
    return { a: a.total, b: b.total, ra: a.bbReady, rb: b.bbReady, rc: c.bbReady, nb: b.nRebuild, na: a.nRebuild,
             over: over.nRetro + over.nRebuild, overAudit: over.nAudit };
  });
  ok('more structures rebuilt costs more and puts the backbone no sooner', heavy.b > heavy.a && heavy.nb > heavy.na && heavy.rb >= heavy.ra - 1e-6, JSON.stringify(heavy));
  ok('a longer design and approvals lead puts the backbone no sooner', heavy.rc >= heavy.ra - 1e-6);
  ok('retrofits and rebuilds together never pass every unassessed site', heavy.over <= heavy.overAudit, JSON.stringify(heavy));

  // A site condition set by its select, as a person would, in the folded site table.
  const mark = await page.evaluate(async () => {
    const d = document.getElementById('a2p-sites');
    d.open = true;
    const before = Alert2Plan.plan();
    const sel = document.querySelector('#a2p-sites select[data-k^="site:"]');
    const k = sel.dataset.k;
    sel.focus();
    sel.value = 'rebuild';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    const now = document.querySelector(`#a2p-sites select[data-k="${k}"]`);
    const pending = document.getElementById(`${now.id}-by`).textContent;
    await new Promise(r => setTimeout(r, 300));
    const after = Alert2Plan.plan();
    const again = document.querySelector(`#a2p-sites select[data-k="${k}"]`);
    return { k, audit: [before.nAudit, after.nAudit], known: after.nKnown, total: [before.total, after.total],
             focused: document.activeElement === again, value: again.value, open: document.getElementById('a2p-sites').open,
             by: document.getElementById(`${again.id}-by`).textContent, pending,
             device: JSON.parse(localStorage.getItem('meganet.a2plan.scenario') || '{}').sites,
             proposal: /This is the proposal as drafted/.test(document.querySelector('.a2p-controls').textContent),
             kpi: document.getElementById('a2p-kpis').textContent };
  });
  const sent = fake.calls.filter(c => c.fn === 'a2plan_site_set').pop();
  ok('a site condition set to "Rebuild the structure" by its select is costed at that and not audited, and the select keeps its focus with its table open',
    mark.audit[1] === mark.audit[0] - 1 && mark.known === 1 && mark.total[1] !== mark.total[0] && mark.focused && mark.value === 'rebuild' && mark.open,
    JSON.stringify({ audit: mark.audit, known: mark.known, focused: mark.focused, open: mark.open }));
  ok('…it is saved in the database for every administrator, says who set it and when, and nothing is kept on the device',
    sent && sent.a.p_condition === 'rebuild' && fake.sites.size === 1 && /^set by Test Admin, 16 Oct 2026$/.test(mark.by) && mark.device === undefined,
    JSON.stringify({ sent: sent && sent.a, by: mark.by, pending: mark.pending }));
  ok('…and it is what is known rather than a lever: still the proposal', mark.proposal && !/than the proposal/.test(mark.kpi));

  fake.refuse = 'a2plan_site_set';
  const refused = await page.evaluate(async () => {
    const sel = document.querySelector('#a2p-sites select[data-k^="site:"]');
    sel.focus();
    sel.value = 'fit';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const now = document.querySelector(`#a2p-sites select[data-k="${sel.dataset.k}"]`);
    return { value: now.value, known: Alert2Plan.storeState().conditions, said: document.getElementById('app-status').textContent };
  });
  fake.refuse = null;
  ok('a site condition the database refuses goes back to what it was, and says so', refused.value === 'rebuild'
    && Object.values(refused.known).includes('rebuild') && !Object.values(refused.known).includes('fit') && /was not saved/.test(refused.said), JSON.stringify(refused));

  const marks = await page.evaluate(async () => {
    Alert2Plan.preset('faster');
    const kept = Object.keys(Alert2Plan.storeState().conditions).length;
    Alert2Plan.preset('proposed');
    const I = Alert2Plan.inventory();
    const base = Alert2Plan.plan();
    const all = Alert2Plan.model({ ...Alert2Plan.defaults(), sites: Object.fromEntries(I.reps.map(r => [r.s.id, 'fit'])) });
    const sel = document.querySelector('#a2p-sites select[data-k^="site:"]');
    sel.value = '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return { kept, audit: all.nAudit, remed: all.nRetro + all.nRebuild, cheaper: all.total < base.total, cleared: Object.keys(Alert2Plan.storeState().conditions).length };
  });
  ok('a preset leaves the site conditions alone; every site fit-out only is no audit, retrofit or rebuild, and cheaper; "Not assessed" clears one, in the database too',
    marks.kept === 1 && marks.audit === 0 && marks.remed === 0 && marks.cheaper && marks.cleared === 0 && fake.sites.size === 0, JSON.stringify(marks));

  const stage = await page.evaluate(() => {
    const d = Alert2Plan.defaults();
    const on = Alert2Plan.model(d), off = Alert2Plan.model({ ...d, fieldStage: false });
    const q = (M, i) => M.equipment[i].qty;
    return { field: off.acts.filter(a => a.row === 'field').length, ert: q(off, 0), power: q(off, 5), onErt: q(on, 0),
             cheaper: off.total < on.total, sooner: off.end <= on.end + 1e-6, ready: [on.bbReady, off.bbReady], fieldFte: [on.fteYears.field, off.fteYears.field] };
  });
  ok('without the field stage: no field work, no field ERT-A2 or power upgrade, cheaper and no longer, and the backbone cut over just the same',
    stage.field === 0 && stage.ert === 0 && stage.power === 0 && stage.onErt > 0 && stage.cheaper && stage.sooner && Math.abs(stage.ready[0] - stage.ready[1]) < 1e-6,
    JSON.stringify(stage));

  const mc = await page.evaluate(async () => {
    const M0 = Alert2Plan.plan();
    const i = M0.cats.findIndex((c, j) => j + 1 < M0.cats.length && M0.cats[j + 1].region === c.region);
    const a = M0.cats[i].key, b = M0.cats[i + 1].key;
    const top = document.querySelector(`#a2p-out button[data-k="cup:${CSS.escape(String(a))}"]`);
    const btn = document.querySelector(`#a2p-out button[data-k="cdown:${CSS.escape(String(a))}"]`);
    const topOff = top.disabled;
    btn.click();
    await new Promise(r => setTimeout(r, 30));
    const M1 = Alert2Plan.plan();
    const f = document.activeElement;
    const kept = JSON.parse(localStorage.getItem('meganet.a2plan.scenario') || '{}').catOrder || [];
    return { swapped: M1.cats[i].key === b && M1.cats[i + 1].key === a, topOff,
             focused: !!f && f.tagName === 'BUTTON' && /^c(up|down):/.test(f.dataset.k || ''),
             kept: kept.indexOf(String(b)) < kept.indexOf(String(a)) || kept.indexOf(b) < kept.indexOf(a) };
  });
  ok('▼ on a catchment swaps it with the next in its region, ▲ is off at the top of one, focus stays on the control and the order is kept',
    mc.swapped && mc.topOff && mc.focused && mc.kept, JSON.stringify(mc));
  await page.evaluate(() => Alert2Plan.reset());

  // ── saved scenarios ──
  console.log('\nSaved scenarios\n');
  await page.evaluate(() => Alert2Plan.reset());
  const sv = await page.evaluate(async () => {
    const panel = () => document.getElementById('a2p-scen');
    const before = panel().textContent;
    document.querySelector('#a2p-scen [data-k="scen:new"]').click();
    await new Promise(r => setTimeout(r, 30));
    const nameFocused = document.activeElement && document.activeElement.id === 'a2p-scen-name';
    // A slider moved first, so the scenario is not the proposal.
    const el = document.getElementById('a2p-c-fieldCrews');
    el.value = '6'; el.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('a2p-scen-name').value = 'Six crews';
    document.getElementById('a2p-scen-notes').value = 'For the board';
    document.querySelector('#a2p-scen [data-k="scen:save"]').click();
    await new Promise(r => setTimeout(r, 300));
    return { before, after: panel().textContent, head: document.getElementById('a2p-scen-line').textContent,
             st: Alert2Plan.storeState(), focus: document.activeElement && document.activeElement.dataset.k };
  });
  const saved = fake.calls.filter(c => c.fn === 'a2plan_scenario_save').pop();
  ok('the card says it is not saved as a scenario, and "Save as a new scenario…" opens a form with the name ready to type',
    /not saved as a scenario/.test(sv.before), sv.before.slice(0, 120));
  ok('saving it sends the card, private, with its name and notes — and no site conditions',
    saved && saved.a.p_id === null && saved.a.p_name === 'Six crews' && saved.a.p_notes === 'For the board' && saved.a.p_shared === false
    && saved.a.p_settings.fieldCrews === 6 && saved.a.p_settings.v === 1 && !('sites' in saved.a.p_settings), JSON.stringify(saved && saved.a).slice(0, 200));
  ok('…the card is then working from it, private to you, the document says so, and focus is not lost',
    /Working from Six crews — yours, private to you/.test(sv.after) && /Scenario: Six crews/.test(sv.head) && !!sv.focus
    && sv.st.scenarios.some(x => x.name === 'Six crews' && x.mine && !x.shared), JSON.stringify({ after: sv.after.slice(0, 160), head: sv.head, focus: sv.focus }));

  const upd = await page.evaluate(async () => {
    const el = document.getElementById('a2p-c-contingency');
    el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    const changed = document.getElementById('a2p-scen').textContent;
    const btn = document.querySelector('#a2p-scen [data-k="scen:update"]');
    const off = btn.disabled;
    btn.click();
    await new Promise(r => setTimeout(r, 300));
    return { changed, off, after: document.getElementById('a2p-scen').textContent, btnOff: document.querySelector('#a2p-scen [data-k="scen:update"]').disabled };
  });
  const updated = fake.calls.filter(c => c.fn === 'a2plan_scenario_save').pop();
  ok('a slider moved says the card has changed since it was loaded, and "Save changes" saves it to the same scenario',
    /changed since it was loaded/.test(upd.changed) && !upd.off && updated.a.p_id === sv.st.loaded.id && updated.a.p_settings.contingency === 30
    && !/changed since/.test(upd.after) && upd.btnOff, JSON.stringify({ off: upd.off, id: updated.a.p_id }));

  const sh = await page.evaluate(async () => {
    const id = Alert2Plan.storeState().loaded.id;
    const btn = document.querySelector(`#a2p-scen [data-k="sshare:${id}"]`);
    btn.click();
    await new Promise(r => setTimeout(r, 300));
    const row = [...document.querySelectorAll('#a2p-scen tbody tr')].find(tr => /Six crews/.test(tr.textContent));
    return { row: row && row.textContent.replace(/\s+/g, ' '), focus: document.activeElement && document.activeElement.dataset.k === `sshare:${id}`,
             now: document.getElementById('a2p-scen-now').textContent };
  });
  const sharedCall = fake.calls.filter(c => c.fn === 'a2plan_scenario_save').pop();
  ok('"Share" shares it with every administrator, and nothing else about it is sent again; focus stays on the button',
    sharedCall.a.p_shared === true && sharedCall.a.p_settings === null && sharedCall.a.p_name === null && /Shared/.test(sh.row) && /Make private/.test(sh.row)
    && /shared with every administrator/.test(sh.now) && sh.focus, JSON.stringify(sh));

  const ld = await page.evaluate(async () => {
    const st = Alert2Plan.storeState();
    const theirs = st.scenarios.find(x => !x.mine);
    document.querySelector(`#a2p-scen [data-k="sload:${theirs.id}"]`).click();
    await new Promise(r => setTimeout(r, 100));
    const dialog = !!document.querySelector('[data-ask="yes"]');
    return { dialog, crews: Alert2Plan.scenario().fieldCrews, wet: Alert2Plan.scenario().wet, slider: document.getElementById('a2p-c-fieldCrews').value,
             now: document.getElementById('a2p-scen-now').textContent, head: document.getElementById('a2p-scen-line').textContent,
             update: !!document.querySelector('#a2p-scen [data-k="scen:update"]'), mine: !!document.querySelector(`#a2p-scen [data-k="sshare:${theirs.id}"]`) };
  });
  ok('loading another administrator\'s shared scenario asks nothing when the card is saved, and the card and plan follow it',
    !ld.dialog && ld.crews === 8 && ld.wet === false && ld.slider === '8', JSON.stringify(ld));
  ok('…it says whose it is and that only its author can change it, offers no "Save changes", "Share" or "Remove"',
    /by Other Admin/.test(ld.now) && /Only its author can change it/.test(ld.now) && /by Other Admin/.test(ld.head) && !ld.update && !ld.mine, ld.now);

  const ask = await page.evaluate(async () => {
    const el = document.getElementById('a2p-c-fieldCrews');
    el.value = '3'; el.dispatchEvent(new Event('input', { bubbles: true }));
    const mine = Alert2Plan.storeState().scenarios.find(x => x.mine);
    document.querySelector(`#a2p-scen [data-k="sload:${mine.id}"]`).click();
    await new Promise(r => setTimeout(r, 100));
    const yes = document.querySelector('[data-ask="yes"]');
    const text = yes ? yes.closest('[role="alertdialog"], [role="dialog"], .modal-card, .modal').textContent : '';
    if (yes) yes.click();
    await new Promise(r => setTimeout(r, 100));
    return { asked: !!yes, text: text.replace(/\s+/g, ' ').slice(0, 200), crews: Alert2Plan.scenario().fieldCrews, contingency: Alert2Plan.scenario().contingency };
  });
  ok('loading over a changed card asks first, saying what is lost; yes loads it', ask.asked && /will be lost/.test(ask.text) && ask.crews === 6 && ask.contingency === 30, JSON.stringify(ask));

  const rm = await page.evaluate(async () => {
    const mine = Alert2Plan.storeState().scenarios.find(x => x.mine);
    document.querySelector(`#a2p-scen [data-k="sdel:${mine.id}"]`).click();
    await new Promise(r => setTimeout(r, 100));
    const card = document.querySelector('[data-ask="yes"]');
    const danger = card && card.classList.contains('btn-danger');
    const text = card ? card.closest('[role="alertdialog"], [role="dialog"], .modal-card, .modal').textContent.replace(/\s+/g, ' ') : '';
    if (card) card.click();
    await new Promise(r => setTimeout(r, 300));
    return { danger, text: text.slice(0, 200), left: Alert2Plan.storeState().scenarios.map(x => x.name), loaded: Alert2Plan.storeState().loaded,
             now: document.getElementById('a2p-scen-now').textContent };
  });
  ok('"Remove…" asks, as something that cannot be undone, warning that a shared one goes for everybody; then it is gone and the card is unsaved',
    rm.danger && /every administrator loses it/.test(rm.text) && !rm.left.includes('Six crews') && rm.loaded === null && /not saved as a scenario/.test(rm.now)
    && fake.calls.some(c => c.fn === 'a2plan_scenario_delete'), JSON.stringify(rm));

  const own = await page.evaluate(() => Alert2Plan.storeState().scenarios.map(x => x.name));
  ok('nobody else\'s private scenario was ever listed', !own.includes('Somebody else\'s private one'), own.join(', '));

  fake.failRead = true;
  const failed = await page.evaluate(async () => {
    await Alert2Plan.reloadStore();
    const sel = document.querySelector('#a2p-sites select[data-k^="site:"]');
    return { text: document.getElementById('a2p-scen').textContent.replace(/\s+/g, ' '), off: sel ? sel.disabled : null,
             retry: !!document.querySelector('#a2p-scen [data-k="scen:retry"]') };
  });
  fake.failRead = false;
  const retried = await page.evaluate(async () => {
    document.querySelector('#a2p-scen [data-k="scen:retry"]').click();
    await new Promise(r => setTimeout(r, 300));
    return Alert2Plan.storeState().store;
  });
  ok('when the store cannot be read the card says so and why, no site condition can be set, and "Try again" reads it again',
    /could not be loaded/.test(failed.text) && /having a moment/.test(failed.text) && failed.off === true && failed.retry && retried === 'ready', JSON.stringify(failed));
  await page.evaluate(() => Alert2Plan.reset());

  // ── catchments in the plan ──
  console.log('\nCatchments in the plan\n');
  await page.evaluate(() => { const d = document.getElementById('a2p-cats'); d.open = true; });
  const cat0 = await page.evaluate(() => {
    const C = Alert2Plan.catalogue();
    const boxes = [...document.querySelectorAll('#a2p-cats-body input[data-k^="cat:"]')];
    const regs = [...document.querySelectorAll('#a2p-cats-body input[data-k^="reg:"]')];
    return { flat: C.flat.length, boxes: boxes.length, regs: regs.length, groups: C.groups.length,
             keys: new Set(C.flat.map(c => c.key)).size,
             sumField: C.flat.reduce((a, c) => a + c.field, 0), sumReps: C.flat.reduce((a, c) => a + c.repeaters, 0),
             field: C.field.length, reps: C.reps.length, allTicked: boxes.every(b => b.checked),
             count: document.getElementById('a2p-cats-n').textContent, total: Alert2Plan.plan().total };
  });
  ok('the picker lists every catchment in the scope once, under its region, every one ticked',
    cat0.boxes === cat0.flat && cat0.keys === cat0.flat && cat0.regs === cat0.groups && cat0.allTicked && /^all \d+$/.test(cat0.count), JSON.stringify(cat0));
  ok('…and its catchments hold every field station and repeater in the scope', cat0.sumField === cat0.field && cat0.sumReps === cat0.reps);

  // One catchment unticked by its box, as a person would: the biggest one in
  // a region of several, so the region's own box is left half-ticked.
  const pick = await page.evaluate(() => {
    const C = Alert2Plan.catalogue();
    let gi = -1, best = null;
    C.groups.forEach((g, i) => { if (g.cats.length < 2) return; for (const c of g.cats) if (!best || c.field > best.field) { best = c; gi = i; } });
    return { i: C.flat.indexOf(best), gi, key: best.key, name: best.name, field: best.field };
  });
  const offBasins0 = await page.evaluate(() => document.querySelectorAll('#a2p-out .a2p-basin-off').length);
  await page.click(`#a2p-cats-body input[data-k="cat:${pick.i}"]`);
  const one = await page.evaluate(([pick]) => {
    const I = Alert2Plan.inventory();
    const box = document.querySelector(`#a2p-cats-body input[data-k="cat:${pick.i}"]`);
    const reg = document.querySelector(`#a2p-cats-body input[data-k="reg:${pick.gi}"]`);
    return { field: I.field.length, none: !I.field.some(f => f.key === pick.key), focused: document.activeElement === box, checked: box.checked,
             partial: reg.indeterminate, count: document.getElementById('a2p-cats-n').textContent,
             kept: (JSON.parse(localStorage.getItem('meganet.a2plan.scenario') || '{}').excluded || []).includes(pick.key),
             kpi: document.getElementById('a2p-kpis').textContent, offBasins: document.querySelectorAll('#a2p-out .a2p-basin-off').length,
             summary: document.querySelector('#a2p-out .a2p-sec').textContent };
  }, [pick]);
  ok(`unticking ${pick.name} takes its ${pick.field} field stations out of the plan, and the box keeps its focus`,
    one.field === cat0.field - pick.field && one.none && one.focused && !one.checked, JSON.stringify({ field: one.field, focused: one.focused }));
  ok('…its region\'s box shows a dash for "some", and the count says how many of how many',
    one.partial && one.count === `${cat0.flat - 1} of ${cat0.flat}`, one.count);
  ok('…the five figures say how far that is from the proposal over every catchment, and the summary says what it covers',
    /less than the proposal/.test(one.kpi) && /covers \d+ of the \d+ catchments/.test(one.summary));
  ok('…it is kept on this device, and its basin goes grey on the map', one.kept && one.offBasins > offBasins0, `${offBasins0} → ${one.offBasins}`);
  await page.click(`#a2p-cats-body input[data-k="cat:${pick.i}"]`);
  const back = await page.evaluate(() => ({ total: Alert2Plan.plan().total, count: document.getElementById('a2p-cats-n').textContent }));
  ok('ticking it again puts the plan back exactly', near(back.total, cat0.total, 0.01) && /^all /.test(back.count), `${back.total} against ${cat0.total}`);

  // A whole region by its own box.
  const reg = await page.evaluate(async ([gi]) => {
    const C = Alert2Plan.catalogue();
    const g = C.groups[gi];
    const box = document.querySelector(`#a2p-cats-body input[data-k="reg:${gi}"]`);
    box.click();
    await new Promise(r => setTimeout(r, 30));
    const I = Alert2Plan.inventory();
    const ids = new Set(I.field.map(f => f.s.id));
    const keys = new Set(g.cats.map(c => c.key));
    const theirs = I.reps.filter(r => keys.has(r.key));
    return { region: g.region, n: g.cats.length,
             allOff: [...document.querySelectorAll(`#a2p-cats-body input[data-k^="cat:"]`)].filter(b => keys.has(C.flat[Number(b.dataset.k.slice(4))].key)).every(b => !b.checked),
             noField: !I.field.some(f => keys.has(f.key)),
             repsServe: theirs.every(r => r.outside && (r.relay || [...r.carriedIds].some(id => ids.has(id)))), kept: theirs.length,
             focused: document.activeElement && document.activeElement.dataset.k === `reg:${gi}` };
  }, [pick.gi]);
  ok(`the region box takes all ${reg.n} of ${reg.region}'s catchments out at once, and keeps its focus`, reg.allOff && reg.noField && reg.focused, JSON.stringify(reg));
  ok('…a repeater of theirs stays only if it carries a station still ticked, or relays one to a base, marked as outside', reg.repsServe, `${reg.kept} kept`);
  await page.evaluate(([gi]) => document.querySelector(`#a2p-cats-body input[data-k="reg:${gi}"]`).click(), [pick.gi]);

  // One catchment alone: every repeater in the plan is in it or carries one of its stations.
  const alone = await page.evaluate(([i]) => {
    Alert2Plan.catchments('none');
    Alert2Plan.catchment(i, true);
    const I = Alert2Plan.inventory();
    const ids = new Set(I.field.map(f => f.s.id));
    const C = Alert2Plan.catalogue();
    return { field: I.field.length, want: C.flat[i].field, reps: I.reps.length, outside: I.outsideReps,
             ok: I.reps.every(r => !r.outside || r.relay || [...r.carriedIds].some(id => ids.has(id))),
             inside: I.reps.filter(r => !r.outside).length === C.flat[i].repeaters, bases: Alert2Plan.plan().nBases };
  }, [pick.i]);
  ok('one catchment alone: its field stations, its repeaters, and the repeaters outside it that carry them or relay them to a base',
    alone.field === alone.want && alone.ok && alone.inside, JSON.stringify(alone));
  ok('…and the bases scaled to it rather than the whole network\'s', alone.bases >= 1 && alone.bases < 15, String(alone.bases));

  const scoped = await page.evaluate(() => {
    Alert2Plan.catchments('all');
    const n0 = document.querySelectorAll('#a2p-cats-body input[data-k^="cat:"]').length;
    const sel = document.getElementById('a2p-c-scope');
    sel.value = 'hubs'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    const n1 = document.querySelectorAll('#a2p-cats-body input[data-k^="cat:"]').length;
    const flat = Alert2Plan.catalogue().flat.length;
    const last = document.querySelectorAll('#a2p-cats-body input[data-k^="cat:"]');
    const lastName = last[last.length - 1].closest('label').textContent.trim();
    const want = Alert2Plan.catalogue().flat[flat - 1].name;
    sel.value = 'qld'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { n0, n1, flat, lastName, want, back: document.querySelectorAll('#a2p-cats-body input[data-k^="cat:"]').length };
  });
  ok('changing the scope redraws the picker for the new scope, so no box acts on another scope\'s catchment',
    scoped.n1 === scoped.flat && scoped.n1 > scoped.n0 && scoped.lastName.startsWith(scoped.want) && scoped.back === scoped.n0, JSON.stringify(scoped));

  const none = await page.evaluate(() => {
    Alert2Plan.catchments('none');
    return { tiles: document.querySelectorAll('#a2p-kpis .a2p-kpi').length, empty: !!document.querySelector('#a2p-out .a2p-empty'),
             secs: document.querySelectorAll('#a2p-out .a2p-sec').length, count: document.getElementById('a2p-cats-n').textContent };
  });
  ok('nothing ticked: the page says so, with no figures and no plan of zeros', none.tiles === 0 && none.empty && none.secs === 0 && /^0 of/.test(none.count), JSON.stringify(none));
  const high = await page.evaluate(() => {
    Alert2Plan.catchments('high');
    const I = Alert2Plan.inventory(), C = Alert2Plan.catalogue();
    const hot = new Set(C.field.filter(f => f.high).map(f => f.key));
    return { n: I.catchmentCount, hot: hot.size, every: I.field.every(f => hot.has(f.key)) };
  });
  ok('"Only those with High-priority SLS sites" ticks exactly those', high.n === high.hot && high.every && high.n > 0, JSON.stringify(high));
  const ticks = await page.evaluate(() => {
    const before = Alert2Plan.scenario().excluded.length;
    Alert2Plan.preset('faster');
    const after = Alert2Plan.scenario().excluded.length;
    switchTab('stations'); switchTab('a2plan');
    const dash = [...document.querySelectorAll('#a2p-cats-body input[data-k^="reg:"]')].some(b => b.indeterminate);
    return { before, after, dash, count: document.getElementById('a2p-cats-n').textContent };
  });
  ok('a preset leaves the ticks alone, and they survive leaving the tab — dashes and all', ticks.before === ticks.after && ticks.before > 0 && ticks.dash, JSON.stringify(ticks));
  await page.evaluate(() => { Alert2Plan.catchments('all'); Alert2Plan.preset('proposed'); });
  const all = await page.evaluate(() => Alert2Plan.plan().total);
  ok('"Tick every catchment" and the proposal put the plan back as it was', near(all, cat0.total, 0.01), `${all} against ${cat0.total}`);

  // What the review of the picker found, held.
  const wide = await page.evaluate(() => {
    Alert2Plan.reset();   // the regions moved above are a difference of their own
    Alert2Plan.set('scope', 'all');
    const C = Alert2Plan.catalogue();
    const keys = C.flat.map(c => c.key);
    // Two boxes with the same place name under two hubs are two catchments.
    const byName = new Map();
    C.flat.forEach((c, i) => { if (!byName.has(c.name)) byName.set(c.name, []); byName.get(c.name).push(i); });
    const twin = [...byName.values()].find(l => l.length > 1) || [];
    let other = null;
    if (twin.length) {
      Alert2Plan.catchment(twin[0], false);
      other = document.querySelector(`#a2p-cats-body input[data-k="cat:${twin[1]}"]`).checked;
      Alert2Plan.catchment(twin[0], true);
    }
    Alert2Plan.catchments('none');
    const zero = document.getElementById('a2p-cats-n').textContent;
    Alert2Plan.catchments('all');
    // A catchment unticked here, then back in Queensland: nothing there differs.
    const x = C.flat.findIndex(c => c.key.startsWith('x:'));
    Alert2Plan.catchment(x, false);
    Alert2Plan.set('scope', 'qld');
    Alert2Plan.preset('proposed');
    const note = document.querySelector('.a2p-controls > p.small').textContent;
    const kept = Alert2Plan.scenario().excluded.length;
    Alert2Plan.set('scope', 'all');
    const remembered = !document.querySelector(`#a2p-cats-body input[data-k="cat:${x}"]`).checked;
    Alert2Plan.catchments('all');
    Alert2Plan.set('scope', 'qld');
    return { n: keys.length, unique: new Set(keys).size, twin: twin.length, other, zero, note, kept, remembered };
  });
  ok('in the whole register every box is its own catchment — one place name under two hubs is two boxes, and unticking one leaves the other',
    wide.unique === wide.n && (wide.twin === 0 || wide.other === true), JSON.stringify({ n: wide.n, unique: wide.unique, twin: wide.twin, other: wide.other }));
  ok('"Clear every catchment" says none is ticked', /^0 of \d+$/.test(wide.zero), wide.zero);
  ok('a catchment unticked under another scope is remembered there, and is no difference here: the proposal is the proposal',
    /This is the proposal as drafted/.test(wide.note) && wide.kept === 1 && wide.remembered, JSON.stringify({ note: wide.note.replace(/^.*?(This is[^.:]*).*$/s, '$1'), kept: wide.kept, remembered: wide.remembered }));

  const place = await page.evaluate(() => {
    const M0 = Alert2Plan.plan();
    const C = Alert2Plan.catalogue();
    // A region past the first two, unticked whole; the first two swapped; the
    // region ticked again — it is where it was.
    const R = M0.order[3];
    const gi = C.groups.findIndex(g => g.region === R);
    Alert2Plan.region(gi, false);
    const btn = document.querySelector('#a2p-out button[aria-label^="Convert"][aria-label$="later"]');
    btn.click();
    Alert2Plan.region(gi, true);
    const M1 = Alert2Plan.plan();
    return { R, before: M0.order.indexOf(R), after: M1.order.indexOf(R), swapped: M1.order[0] === M0.order[1] && M1.order[1] === M0.order[0] };
  });
  ok('reordering while a region is unticked keeps that region\'s place for when it is back', place.after === place.before && place.swapped, JSON.stringify(place));

  const emptyFiles = await page.evaluate(async () => {
    document.getElementById('a2p-cats').open = false;
    Alert2Plan.catsToggled(false);
    Alert2Plan.catchments('none');
    const why = Alert2Plan.exportWhy();
    const named = floodnetName.count || 0;
    Alert2Plan.exportCsv(); Alert2Plan.exportXlsx();
    const after = floodnetName.count || 0;
    const btn = document.querySelector('#a2p-out .a2p-empty button');
    btn.focus(); btn.click();
    await new Promise(r => setTimeout(r, 30));
    const f = document.activeElement;
    return { why, wrote: after - named, focus: f && f.tagName + (f.closest('#a2p-cats') ? ' in the picker' : ''),
             back: document.getElementById('a2p-cats-n').textContent };
  });
  ok('nothing ticked: neither file is written, and the export menu says why', emptyFiles.wrote === 0 && /No catchment is ticked/.test(emptyFiles.why), JSON.stringify(emptyFiles));
  ok('the empty plan\'s own button ticks everything and leaves focus on the picker, not the page', /^all /.test(emptyFiles.back) && emptyFiles.focus === 'SUMMARY in the picker', emptyFiles.focus);
  await page.evaluate(() => { Alert2Plan.preset('proposed'); });

  // ── what the page draws ──
  console.log('\nWhat it draws\n');
  const drawn = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('#a2p-out svg[role="img"]')];
    return {
      n: svgs.length,
      named: svgs.every(s => (s.querySelector('title') || {}).textContent),
      sections: [...document.querySelectorAll('#a2p-out .a2p-sec h3')].map(h => h.textContent),
      basins: document.querySelectorAll('#a2p-out .a2p-basin').length,
      bars: document.querySelectorAll('#a2p-out .a2p-gantt .a2p-bar').length,
      cut: /on the ALERT2 backbone/.test((document.querySelector('#a2p-out .a2p-cutover title') || {}).textContent || ''),
      refs: document.querySelectorAll('#a2p-out .a2p-refs li').length,
      cites: [...document.querySelectorAll('#a2p-out sup a')].every(a => !!document.getElementById(a.getAttribute('href').slice(1))),
    };
  });
  ok('every chart is an image named with its headline, the cut-over chart among them', drawn.n >= 7 && drawn.named && drawn.cut, `${drawn.n} chart(s)`);
  ok('the document has its sections, in order', drawn.sections.length >= 11 && /^1\. Summary/.test(drawn.sections[0]) && /Sources/.test(drawn.sections[drawn.sections.length - 1]), drawn.sections.join(' | '));
  ok('the map draws the basins, and the timeline its bars', drawn.basins > 50 && drawn.bars > 10, `${drawn.basins} basins, ${drawn.bars} bars`);
  ok('every citation lands on a source', drawn.refs >= 8 && drawn.cites, `${drawn.refs} source(s)`);

  // ── the files ──
  console.log('\nThe files\n');
  const [xl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => Alert2Plan.exportXlsx())]);
  ok('the workbook is floodnet-alert2-transition-plan.xlsx', xl.suggestedFilename() === 'floodnet-alert2-transition-plan.xlsx', xl.suggestedFilename());
  const xpath = await xl.path();
  const fs = await import('node:fs');
  const zip = fs.readFileSync(xpath);
  ok('…and is a zip with its eight sheets, the cut-over and the repeaters among them', zip.slice(0, 2).toString() === 'PK' && new Set(zip.toString('latin1').match(/xl\/worksheets\/sheet\d+\.xml/g) || []).size >= 8);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => Alert2Plan.exportCsv())]);
  const text = fs.readFileSync(await csv.path(), 'utf8');
  const rows = text.trim().split(/\r?\n/);
  const csvField = rows.slice(1).reduce((a, r) => { const c = r.split(','); return a + Number(c[3]) + Number(c[4]); }, 0);
  ok('the CSV is floodnet-…, a row a catchment, and its stations add up to the plan\'s',
    csv.suggestedFilename() === 'floodnet-alert2-plan-quantities.csv' && /^Order,Region,Catchment/.test(rows[0]) && csvField === inv.field,
    `${csv.suggestedFilename()}, ${rows.length - 1} rows, ${csvField} stations`);

  ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n  ${passes + failures} assertion(s).\n`);
if (failures) {
  console.log(`FAIL — ${failures} of ${passes + failures}.`);
  process.exit(1);
}
console.log(`PASS — the ALERT2 Transition Plan adds up, moves the way its card says, and is for administrators only (${passes} checks).`);
