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
//                   every region's field work starts no earlier than the gates
//                   it says it waits for.
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
//                   nothing ticked says so; presets leave the ticks alone.
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

try {
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => { try { localStorage.removeItem('meganet.a2plan.scenario'); } catch (_) {} });

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
  await page.waitForFunction(() => !!document.getElementById('a2p-out'), null, { timeout: 20_000 });

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
    const gates = M.regionRows.map(r => ({ name: r.name, start: r.start, review: r.review ? r.review.end : null, fit: r.fit ? r.fit.end : null }));
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
  ok('no region\'s field work starts before its review, its repeaters or the pilot',
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
             onStart: Math.min(...on.acts.filter(a => a.row === 'remediate' || a.row === 'acquire').map(a => a.start)),
             offStart: Math.min(...off.acts.filter(a => a.row === 'acquire').map(a => a.start)), P: on.P };
  });
  ok('backbone first starts the backbone on day one, ahead of the equipment', bb.onStart === 0 && bb.onFit, JSON.stringify(bb));
  ok('without it, the backbone waits for the equipment and goes with each region', bb.offStart >= bb.P && !bb.offFit, JSON.stringify(bb));

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
             repsServe: theirs.every(r => r.outside && [...r.carriedIds].some(id => ids.has(id))), kept: theirs.length,
             focused: document.activeElement && document.activeElement.dataset.k === `reg:${gi}` };
  }, [pick.gi]);
  ok(`the region box takes all ${reg.n} of ${reg.region}'s catchments out at once, and keeps its focus`, reg.allOff && reg.noField && reg.focused, JSON.stringify(reg));
  ok('…a repeater of theirs stays only if it carries a station still ticked, marked as outside', reg.repsServe, `${reg.kept} kept`);
  await page.evaluate(([gi]) => document.querySelector(`#a2p-cats-body input[data-k="reg:${gi}"]`).click(), [pick.gi]);

  // One catchment alone: every repeater in the plan is in it or carries one of its stations.
  const alone = await page.evaluate(([i]) => {
    Alert2Plan.catchments('none');
    Alert2Plan.catchment(i, true);
    const I = Alert2Plan.inventory();
    const ids = new Set(I.field.map(f => f.s.id));
    const C = Alert2Plan.catalogue();
    return { field: I.field.length, want: C.flat[i].field, reps: I.reps.length, outside: I.outsideReps,
             ok: I.reps.every(r => !r.outside || [...r.carriedIds].some(id => ids.has(id))),
             inside: I.reps.filter(r => !r.outside).length === C.flat[i].repeaters, bases: Alert2Plan.plan().nBases };
  }, [pick.i]);
  ok('one catchment alone: its field stations, its repeaters, and the repeaters outside it that carry them',
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
      refs: document.querySelectorAll('#a2p-out .a2p-refs li').length,
      cites: [...document.querySelectorAll('#a2p-out sup a')].every(a => !!document.getElementById(a.getAttribute('href').slice(1))),
    };
  });
  ok('every chart is an image named with its headline', drawn.n >= 6 && drawn.named, `${drawn.n} chart(s)`);
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
  ok('…and is a zip with its six sheets', zip.slice(0, 2).toString() === 'PK' && (zip.toString('latin1').match(/xl\/worksheets\/sheet\d+\.xml/g) || []).length >= 6);
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
