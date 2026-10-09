// The Network Review tab (network-review.js), held to what it claims.
//
// The ground is terrainkit.mjs's hilly world (lib/terrarium.mjs) — hills every
// eight kilometres from a closed form — so the margins are whatever that world
// gives, and every assertion about a figure is about its *agreement* with the
// rest of the app rather than about Queensland. The two public inspection
// views the tab reads the measured margins from are answered by routes here.
//
//   Who it is for   signed out it is a paragraph and a Sign in button; signed
//                   in without being an administrator it says so; neither
//                   draws a control or asks the datastore anything.
//   The matrix      two repeaters in, every station their pass ranges carry
//                   out, each cell computed, the best and the count of good
//                   paths read off the row, the tiles over them adding up.
//   One figure      a cell is the link budget card's figure for the same path
//                   — not a cousin of it — and both are the field model's.
//   A site          a proposed site, only a pin, gets a column of its own at
//                   the mast typed in.
//   The field       the measured margins are read, a visit's figure is its
//                   largest load, nought is "not tested", a figure is the
//                   attenuator's 3 dB step (24 is 24–27), its 30 dB is "at
//                   least", a median leaning on an "at least" is one too, and
//                   the check against the model is computed only over rows
//                   that have both.
//   The file        the CSV is named floodnet-…, carries the model it was
//                   computed on, a column per hub, the measured step as two
//                   columns and a row per station.
//   The rest        the converter does its arithmetic, the register checks
//                   count what they say, and the model setting on the card
//                   is the model the tab says it is using.
//
// Run:  npm run review
//       npm run review -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { hillyTerrariumPng } from './lib/terrarium.mjs';
import fs from 'node:fs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);
const RUN_TIMEOUT = 180_000;

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};

const HUB_A = 'mt_stuart_al', HUB_B = 'castle_hill_al';

// ── the datastore, for the two views the tab reads ──────────────────────────
// The first four stations asked about get visits: one with two readings (21
// and 27, so a median of 24) and a nought that is "not tested"; one reading at
// the attenuator's 30 dB limit; one with 27 and 30 (≥28.5); and one reading 22,
// off the 3 dB grid — a 1 dB attenuator's. Everybody else has none. A read with
// no station or visit filter — the history check's — gets every visit there is,
// a page at a time as the datastore answers it.
const visitsFor = new Map();
let visitAsks = 0, marginAsks = 0;
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body),
                                              headers: { 'Access-Control-Allow-Origin': '*' } });
const inList = (url, col) => {
  const m = decodeURIComponent(url).match(new RegExp(`${col}=in\\.\\(([^)]*)\\)`));
  return m ? m[1].split(',') : [];
};

const server = await startServer();
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
await applyNetworkPolicy(page, server.origin);
await page.route(/elevation-tiles-prod\/terrarium\/\d+\/\d+\/\d+\.png/, route => {
  const m = route.request().url().match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
  return route.fulfill({ status: 200, contentType: 'image/png', body: hillyTerrariumPng(+m[1], +m[2], +m[3]),
                         headers: { 'Access-Control-Allow-Origin': '*' } });
});
// The datastore's own cap: at most 1000 rows to a read, from `offset`.
const paged = (url, rows) => {
  const u = decodeURIComponent(url);
  const limit = Math.min(1000, Number((u.match(/[?&]limit=(\d+)/) || [])[1] || 1000));
  const offset = Number((u.match(/[?&]offset=(\d+)/) || [])[1] || 0);
  return rows.slice(offset, offset + limit);
};
await page.route(/inspection_chart_visit\?/, route => {
  visitAsks++;
  const url = route.request().url();
  if (!/station_id=in\./.test(decodeURIComponent(url))) {
    const all = [];
    for (const [id, vs] of visitsFor) for (const v of vs) all.push({ id: v.id, station_id: id, inspected_on: v.at });
    return json(route, paged(url, all));
  }
  const ids = inList(url, 'station_id');
  const out = [];
  for (const id of ids) {
    if (!visitsFor.has(id) && visitsFor.size < 4) {
      visitsFor.set(id, [
        [{ id: `v-${id}-1`, at: '2020-09-28', load: [21] }, { id: `v-${id}-2`, at: '2019-10-03', load: [27, 12] },
         { id: `v-${id}-3`, at: '2018-09-20', load: [0] }],
        [{ id: `v-${id}-1`, at: '2020-09-18', load: [30] }],
        [{ id: `v-${id}-1`, at: '2020-08-11', load: [30] }, { id: `v-${id}-2`, at: '2019-08-02', load: [27] }],
        [{ id: `v-${id}-1`, at: '2021-05-12', load: [22] }],
      ][visitsFor.size]);
    }
    for (const v of visitsFor.get(id) || []) out.push({ id: v.id, station_id: id, inspected_on: v.at });
  }
  return json(route, paged(url, out));
});
await page.route(/inspection_chart_fade_margin\?/, route => {
  marginAsks++;
  const url = route.request().url();
  if (!/inspection_id=in\./.test(decodeURIComponent(url))) {
    const all = [];
    for (const vs of visitsFor.values()) for (const v of vs) for (const l of v.load) if (l > 0) all.push({ inspection_id: v.id, load_db: l });
    return json(route, paged(url, all));
  }
  const ids = new Set(inList(url, 'inspection_id'));
  const out = [];
  for (const vs of visitsFor.values()) for (const v of vs) if (ids.has(v.id)) for (const l of v.load) out.push({ inspection_id: v.id, load_db: l });
  return json(route, out);
});
// A table longer than one read, to hold selectAll to every row of it.
const PROBE = Array.from({ length: 2345 }, (_, i) => ({ n: i }));
await page.route(/paging_probe\?/, route => json(route, paged(route.request().url(), PROBE)));
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });

// ── who it is for ────────────────────────────────────────────────────────────
console.log('\nWho it is for');
await page.evaluate(() => switchTab('review'));
await page.waitForTimeout(200);
let view = await page.evaluate(() => ({
  text: document.getElementById('main-content').textContent.replace(/\s+/g, ' '),
  pick: !!document.getElementById('nr-hub-pick'),
  signIn: !!document.querySelector('#main-content button[onclick="Auth.open()"]'),
}));
ok('signed out: it says what it is for', /reviewed the way a planner reviews one/.test(view.text), view.text.slice(0, 160));
ok('…offers Sign in', view.signIn);
ok('…and draws no control of the review', !view.pick);

await page.evaluate(() => {
  window.__auth = { isSignedIn: Auth.isSignedIn, isAdmin: Auth.isAdmin, role: Auth.role };
  Auth.isSignedIn = () => true; Auth.isAdmin = () => false; Auth.role = () => 'viewer';
  NetworkReview.authChanged();
});
view = await page.evaluate(() => ({
  text: document.getElementById('main-content').textContent.replace(/\s+/g, ' '),
  pick: !!document.getElementById('nr-hub-pick'),
}));
ok('signed in, not an administrator: it says it needs one', /needs an administrator/.test(view.text));
ok('…and still draws no control', !view.pick);
ok('…having asked the datastore nothing', visitAsks === 0 && marginAsks === 0);

await page.evaluate(() => { Auth.isAdmin = () => true; Auth.role = () => 'admin'; NetworkReview.authChanged(); });
view = await page.evaluate(() => ({
  pick: !!document.getElementById('nr-hub-pick'),
  options: document.querySelectorAll('#nr-hub-pick option').length,
  headings: [...document.querySelectorAll('#main-content h2, #main-content h3')].map(h => h.textContent.trim()),
}));
ok('an administrator gets the review', view.pick && view.options > 10, `${view.options} options`);
ok('…its four panels', ['Path margins across a network', 'Flood-Net, Radio Mobile and the field', 'Design principles',
  'The register, before a review'].every(h => view.headings.includes(h)), view.headings.join(' | '));

// ── the matrix ───────────────────────────────────────────────────────────────
console.log('\nThe matrix');
await page.selectOption('#nr-hub-pick', HUB_A);
await page.click('button:has-text("Add to the review")');
await page.selectOption('#nr-hub-pick', HUB_B);
await page.click('button:has-text("Add to the review")');
const before = await page.evaluate(() => ({
  hubs: [...document.querySelectorAll('.nr-hubs li strong')].map(s => s.textContent),
  count: (document.getElementById('nr-rows-count') || {}).textContent || '',
  mast: /assumed 10 m mast/.test(document.querySelector('.nr-hubs').textContent),
  disabled: document.querySelector(`#nr-hub-pick option[value="mt_stuart_al"]`).disabled,
}));
ok('two hubs added from the picker', before.hubs.length === 2, before.hubs.join(', '));
ok('…a hub already in the review cannot be picked again', before.disabled);
ok('…each on the assumed mast its 4 m radio system calls for, and saying so', before.mast);
ok('…and the rows it would compute are counted before anything is fetched', /\d+ field stations would be computed/.test(before.count), before.count);

await page.click('button:has-text("Compute margins")');
await page.waitForFunction(() => {
  const m = NetworkReview.matrix();
  return m && m.rows.length && m.rows.every(r => r.figs.every(f => f != null)) && !/Computing/.test(document.getElementById('nr-status').textContent);
}, null, { timeout: RUN_TIMEOUT });
await page.waitForFunction(() => !/Reading the measured/.test(document.getElementById('nr-status').textContent), null, { timeout: 20_000 });
const run = await page.evaluate(() => {
  const m = NetworkReview.matrix();
  const G = 15, O = 6;
  const sums = { two: 0, one: 0, marginal: 0, weak: 0 };
  const bad = [];
  for (const r of m.rows) {
    const figs = r.figs.filter(f => f && f.m != null);
    const best = figs.length ? Math.max(...figs.map(f => f.m)) : null;
    const good = figs.filter(f => f.m >= G).length;
    if (best == null || best < O) sums.weak++; else if (good >= 2) sums.two++; else if (good === 1) sums.one++; else sums.marginal++;
    const tr = [...document.querySelectorAll('.nr-matrix tbody tr')].find(t => t.querySelector('th').textContent.includes(r.name));
    const shown = tr ? tr.querySelectorAll('td')[m.hubs.length].textContent.trim() : null;
    const want = best == null ? '—' : `${best > 0 ? '+' : ''}${best.toFixed(1)}`;
    if (shown !== want) bad.push(`${r.name}: ${shown} vs ${want}`);
  }
  const tiles = [...document.querySelectorAll('#nr-kpis .adm-kpi')].map(t => [t.querySelector('.adm-kpi-label').textContent.trim(), Number(t.querySelector('.adm-kpi-value').textContent)]);
  return { n: m.rows.length, hubs: m.hubs.map(h => h.name), model: m.model, sums, bad, tiles: Object.fromEntries(tiles),
           failed: m.rows.reduce((n, r) => n + r.figs.filter(f => f.err).length, 0),
           rowsInTable: document.querySelectorAll('.nr-matrix tbody tr').length,
           hubIdsInRows: m.rows.some(r => r.id === 'mt_stuart_al' || r.id === 'castle_hill_al') };
});
ok('every station the two hubs carry got a row', run.n > 5 && run.rowsInTable === run.n, `${run.n} rows`);
ok('…and a hub is a column, never a row', !run.hubIdsInRows);
ok('every path was computed off the tiles', run.failed === 0, `${run.failed} failed`);
ok('the field model is the one the matrix ran', run.model === 'field');
ok('each row\'s Best is the largest of its cells', run.bad.length === 0, run.bad.slice(0, 3).join('; '));
ok('the tiles count the rows the way the bands read them',
   run.tiles['Two good paths'] === run.sums.two && run.tiles['One good path'] === run.sums.one
   && run.tiles['Marginal'] === run.sums.marginal && run.tiles['Needs a second way out'] === run.sums.weak
   && run.tiles['Field stations'] === run.n, JSON.stringify({ tiles: run.tiles, sums: run.sums }));

// ── one figure ───────────────────────────────────────────────────────────────
// The link budget card, set to the same two ends, has to give the same figure
// the cell does — the card is pointed one way and the cell is the worse of
// two, but every station here is on one radio system, so the two directions
// are one number.
console.log('\nOne figure');
const agree = await page.evaluate(async ({ hub }) => {
  const m = NetworkReview.matrix();
  const k = m.hubs.findIndex(h => h.id === hub);
  const r = m.rows.find(x => x.figs[k] && x.figs[k].m != null);
  switchTab('stations');
  await new Promise(res => setTimeout(res, 800));
  LinkBudget.setOpen(true);
  LinkBudget.arm('a'); LinkBudget.takeStation(r.id);
  LinkBudget.arm('b'); LinkBudget.takeStation(hub);
  for (let i = 0; i < 120; i++) {
    const c = LinkBudget.current();
    if (c && c.an && c.itm && c.margin != null) {
      return { station: r.name, cell: r.figs[k].m, card: c.margin, model: c.an.model, allow: c.allow,
               aglB: c.an.aglB, clutter: (c.clutA || 0) + (c.clutB || 0),
               sum: Math.abs(c.pathLoss - (c.fspl + c.aref + c.avar + c.floor + c.allow)) };
    }
    await new Promise(res => setTimeout(res, 250));
  }
  return { error: 'the card never priced the path' };
}, { hub: HUB_A });
ok('the card prices the same path', !agree.error, JSON.stringify(agree).slice(0, 200));
ok('…to the same figure the cell holds', !agree.error && Math.abs(agree.cell - agree.card) < 0.05,
   `cell ${agree.cell} vs card ${agree.card} — ${agree.station}`);
const defaultAllowance = await page.evaluate(() => FN_MODEL_DEFAULTS.allowance);
ok('…the field model on both, with its allowance', agree.model === 'field' && agree.allow === defaultAllowance,
   `${agree.model}, ${agree.allow} dB against the default ${defaultAllowance}`);
ok('…the repeater on its assumed mast on both', agree.aglB === 10, `${agree.aglB} m`);
// The rows themselves are pathcover.mjs's; here, the sum they print.
ok('…its path loss free space, terrain, statistics, floor and allowance, with no terminal clutter',
   !agree.error && agree.clutter === 0 && agree.sum < 1e-6, `clutter ${agree.clutter}, residual ${agree.sum}`);
await page.evaluate(() => switchTab('review'));
await page.waitForTimeout(200);

// ── the field ────────────────────────────────────────────────────────────────
console.log('\nThe field');
const field = await page.evaluate(() => {
  const m = NetworkReview.matrix(), meas = NetworkReview.measured();
  const withM = m.rows.filter(r => meas && meas.has(r.id));
  const cells = withM.map(r => {
    const tr = [...document.querySelectorAll('.nr-matrix tbody tr')].find(t => t.querySelector('th').textContent.includes(r.name));
    return tr ? tr.querySelectorAll('td')[m.hubs.length + 2].textContent.replace(/\s+/g, ' ').trim() : null;
  });
  return { n: withM.length, values: withM.map(r => meas.get(r.id)), cells, check: NetworkReview.fieldCheck(),
           tile: [...document.querySelectorAll('#nr-kpis .adm-kpi-label')].some(l => /Against the attenuator/.test(l.textContent)) };
});
ok('the measured margins were asked for once the matrix ran', visitAsks >= 1 && marginAsks >= 1, `${visitAsks} / ${marginAsks}`);
ok('four stations have one', field.n === 4, JSON.stringify(field.values));
ok('…a visit\'s figure is its largest load, and nought is not a test: the median of 21 and 27',
   field.values.some(v => v.m === 24 && v.n === 2 && !v.censored), JSON.stringify(field.values));
ok('…and a figure is the attenuator\'s 3 dB step: 21–24 and 27–30 make 24–27', field.values.some(v => v.m === 24 && v.hi === 27)
   && field.cells.some(c => /^24–27/.test(c || '')), field.cells.join(' | '));
ok('…a reading at the attenuator\'s limit is "at least"', field.values.some(v => v.m === 30 && v.censored)
   && field.cells.some(c => /^≥30/.test(c || '')), field.cells.join(' | '));
ok('…and a median that leans on one is "at least" too: 27 and ≥30 is ≥28.5', field.values.some(v => v.m === 28.5 && v.censored)
   && field.cells.some(c => /^≥28\.5/.test(c || '')), field.cells.join(' | '));
ok('…a reading off the 3 dB grid came from a 1 dB attenuator: 22 is 22–23', field.values.some(v => v.m === 22 && v.hi === 23)
   && field.cells.some(c => /^22–23/.test(c || '')), field.cells.join(' | '));
ok('…and the model is checked against all four', field.check && field.check.n === 4 && isFinite(field.check.mean), JSON.stringify(field.check));
const inStep = await page.evaluate(() => {
  // A model figure inside the step is no error; outside, the error is the distance to it.
  const m = NetworkReview.matrix(), meas = NetworkReview.measured();
  return m.rows.filter(r => meas.has(r.id)).map(r => {
    const best = Math.max(...r.figs.filter(f => f && f.m != null).map(f => f.m)), v = meas.get(r.id);
    return best < v.m ? best - v.m : best > v.hi ? best - v.hi : 0;
  });
});
ok('…a model figure inside a step being no error, and one outside it the distance to it',
   Math.abs(inStep.reduce((a, b) => a + b, 0) / inStep.length - field.check.mean) < 1e-9, `${inStep} vs ${JSON.stringify(field.check)}`);
ok('…on a tile of its own', field.tile);

// ── a proposed site ──────────────────────────────────────────────────────────
console.log('\nA proposed site');
const site = await page.evaluate(async () => {
  const hub = state.data.stations.find(s => s.id === 'castle_hill_al');
  NetworkReview.siteField('name', 'The next hill');
  NetworkReview.siteField('lat', String(hub.lat + 0.03));
  NetworkReview.siteField('lon', String(hub.lon + 0.03));
  NetworkReview.siteField('agl', '14');
  NetworkReview.addSite();
  NetworkReview.compute();
  for (let i = 0; i < 600; i++) {
    const m = NetworkReview.matrix();
    if (m && m.hubs.length === 3 && m.rows.every(r => r.figs.every(f => f != null))) {
      return { hubs: m.hubs.map(h => `${h.name}@${h.agl}`), computed: m.rows.filter(r => r.figs[2] && r.figs[2].m != null).length, n: m.rows.length,
               head: [...document.querySelectorAll('.nr-matrix thead th')].map(t => t.textContent.replace(/\s+/g, ' ').trim()) };
    }
    await new Promise(res => setTimeout(res, 200));
  }
  return { error: 'the site never computed' };
});
ok('a site is a column of its own, at the mast typed in', !site.error && site.hubs[2] === 'The next hill@14', JSON.stringify(site.hubs));
ok('…computed for every row', !site.error && site.computed === site.n, `${site.computed} of ${site.n}`);
ok('…and headed by its name', !site.error && site.head.some(h => /^The next hill 14 m/.test(h)), (site.head || []).join(' | '));
const refused = await page.evaluate(() => {
  NetworkReview.siteField('lat', ''); NetworkReview.siteField('lon', '');
  const n = NetworkReview.matrix().hubs.length;
  NetworkReview.addSite();
  return { said: /needs a latitude and a longitude/.test(document.getElementById('nr-status').textContent), n };
});
ok('a site with no position is refused, and says why', refused.said);

// ── the file ─────────────────────────────────────────────────────────────────
console.log('\nThe file');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#main-content button:has-text("CSV")')]);
const csv = fs.readFileSync(await dl.path(), 'utf8').split('\n').filter(Boolean);
const head = csv.find(l => /^station,/.test(l)) || '';
ok('named floodnet-network-review-…csv', /^floodnet-network-review-\d{8}\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
ok('…saying the model it was computed on', csv[0].includes(`field-calibrated model, ${defaultAllowance} dB allowance`), csv[0]);
ok('…and the measured step as two columns, the second empty for "at least"',
   head.includes('measured_margin_from_db,measured_margin_to_db')
   && csv.some(l => /,24,27,2,/.test(l)) && csv.some(l => /,30,,1,/.test(l)) && csv.some(l => /,28\.5,,2,/.test(l))
   && csv.some(l => /,22,23,1,/.test(l)),
   csv.filter(l => !l.startsWith('#')).slice(0, 4).join(' / '));
ok('…a margin and a distance column per hub', ['Mt Stuart AL margin_db', 'Castle Hill AL margin_db', 'The next hill margin_db', 'The next hill km']
  .every(c => head.includes(c)), head.slice(0, 200));
ok('…and a row per station', csv.filter(l => !l.startsWith('#')).length - 1 === site.n, `${csv.length} lines`);

// ── the rest ─────────────────────────────────────────────────────────────────
console.log('\nThe converter, the register and the model');
const conv = await page.evaluate(() => {
  NetworkReview.convert('24');
  return document.getElementById('nr-conv-out').textContent.replace(/\s+/g, ' ');
});
ok('a Radio Mobile 24 dB is 24.1 in Flood-Net and 21.7 on site, which the attenuator reads as 21',
   /24\.1 dB/.test(conv) && /21\.7 dB/.test(conv) && /read as 21\b/.test(conv), conv);
const reg = await page.evaluate(() => {
  const c = NetworkReview.registerChecks();
  const masts = state.data.stations.filter(s => stationIsMast(s));
  const want = masts.filter(s => { const sys = rmSystemOf(s); return (sys && sys.antenna_height_m != null ? Number(sys.antenna_height_m) : 4) < 10; }).length;
  return { assumed: c.assumed.length, want, masts: c.masts, long: c.long.length,
           longest: c.long[0] ? Math.round(c.long[0].km) : null,
           text: [...document.querySelectorAll('#nr-page .panel')].pop().textContent.replace(/\s+/g, ' ') };
});
ok('every repeater and base on a radio system under the mast is counted as assumed', reg.assumed === reg.want && reg.masts > 0,
   `${reg.assumed} of ${reg.masts}, expected ${reg.want}`);
ok('…and the panel says how many', new RegExp(`${reg.assumed} of the register's ${reg.masts}`).test(reg.text), reg.text.slice(0, 200));
ok('pass-range links over 150 km are counted, longest first', reg.long === 0 || reg.longest > 150, `${reg.long}, longest ${reg.longest} km`);

// ── every row of a long read ─────────────────────────────────────────────────
const probe = await page.evaluate(async () => (await NetworkReview.selectAll('paging_probe?select=n&order=n.asc')).length);
ok('a read longer than the datastore\'s 1000 rows comes back whole', probe === 2345, String(probe));

// ── the model against every attenuator test ─────────────────────────────────
console.log('\nThe history check');
const hist = await page.evaluate(async () => {
  const before = pathPropOf().allowance;
  NetworkHistory.start();
  for (let i = 0; i < 900; i++) {
    const r = NetworkHistory.run();
    if (r && (r.phase === 'done' || r.phase === 'failed')) break;
    await new Promise(res => setTimeout(res, 200));
  }
  const r = NetworkHistory.run();
  const panel = [...document.querySelectorAll('#nr-page .panel')].find(p => /The model against every attenuator test/.test(p.textContent));
  return { phase: r && r.phase, error: r && r.error, stations: r ? r.stations.length : 0, priced: r ? r.stations.filter(x => x.best).length : 0,
           summary: !!(r && r.summary && r.summary.all), n: r && r.summary && r.summary.all ? r.summary.all.n : 0,
           tiles: panel ? [...panel.querySelectorAll('.adm-kpi-label')].map(l => l.textContent.trim()) : [],
           tables: panel ? panel.querySelectorAll('table').length : 0, before,
           fit: r && r.summary ? r.summary.fitNear : null };
});
ok('a run reads every test on file and finishes', hist.phase === 'done', `${hist.phase} ${hist.error || ''}`);
ok('…pricing each tested station\'s paths', hist.stations === 4 && hist.priced === 4, `${hist.priced} of ${hist.stations}`);
ok('…and summing them up network-wide, on tiles and tables', hist.summary && hist.n === 4
   && hist.tiles.includes('Stations priced') && hist.tables >= 1, JSON.stringify(hist.tiles));
const used = await page.evaluate(() => {
  const r = NetworkHistory.run();
  NetworkHistory.useFit();
  const after = pathPropOf().allowance;
  LinkBudget.resetProp();
  return { after, want: r.summary.fitNear == null ? null : Math.max(0, Math.round((r.allowance + r.summary.fitNear) * 2) / 2) };
});
ok('its fit can be taken up for the session, to the half-decibel', used.want != null && used.after === used.want, JSON.stringify(used));
await page.evaluate(() => NetworkReview.authChanged());
const [hdl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => NetworkHistory.exportCsv())]);
const hcsv = fs.readFileSync(await hdl.path(), 'utf8').split('\n').filter(Boolean);
ok('…and it saves as floodnet-attenuator-history-check-….csv, a row per station', /^floodnet-attenuator-history-check-\d{8}\.csv$/.test(hdl.suggestedFilename())
   && hcsv.filter(l => !l.startsWith('#')).length === 5, `${hdl.suggestedFilename()} · ${hcsv.length} lines`);

// ── LiDAR ────────────────────────────────────────────────────────────────────
// The tiles are answered by LidarProfile's seam with the hilly world itself,
// so the LiDAR ground is the tiles' ground at 5 m, and every hub is surveyed
// somewhere the hilly world is not.
console.log('\nLiDAR');
await page.evaluate(() => {
  const EARTH_KM = 40075.017, HILL_KM = 8, K = 2 * Math.PI * EARTH_KM / HILL_KM;
  const hAt = (lat, lon) => {
    const r = lat * Math.PI / 180, wx = (lon + 180) / 360, wy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
    const a = Math.sin(wx * K) * Math.sin(wy * K), b = Math.sin(wx * K / 9.7 + 0.6) * Math.cos(wy * K / 11.3 + 1.1), c = Math.sin(wx * K / 41 + 2.2);
    return 180 + 380 * a * a + 220 * b + 90 * c;
  };
  LidarProfile.seed(t => {
    const data = new Float32Array(t.W * t.H);
    for (let y = 0; y < t.H; y++) for (let x = 0; x < t.W; x++) {
      data[y * t.W + x] = hAt(t.n - (y + 0.5) * (t.n - t.s) / t.H, t.w + (x + 0.5) * (t.e - t.w) / t.W);
    }
    return { W: t.W, H: t.H, data };
  });
});
const lid = await page.evaluate(async () => {
  const st = state.data.stations.find(s => s.id === NetworkReview.matrix().rows[0].id), hub = state.data.stations.find(s => s.id === 'mt_stuart_al');
  const A = NetworkReview.radioOfStation(st), B = NetworkReview.radioOfStation(hub);
  const tiles = await NetworkReview.pathMargin(A, B, 152.4);
  LinkBudget.setGround('lidar');
  const g = await pathGround(A, B, { freqMhz: 152.4 });
  const lidar = await NetworkReview.pathMargin(A, B, 152.4);
  const asked = LidarProfile.stats().asked;
  LinkBudget.setGround('30m');
  return { tiles: tiles.m, lidar: lidar.m, err: lidar.err, asked, share: g.lidar ? g.lidar.lidarShare : null,
           n: g.prof.terrain_m.length, stood: g.ends.b.stood_m != null, zones: g.lidar ? g.lidar.zones.map(z => z.kind) : [] };
});
ok('under the LiDAR setting a path is priced over 5 m LiDAR at its ends and obstacles', lid.err == null && isFinite(lid.lidar)
   && lid.asked > 0 && lid.share > 0 && lid.n > 1024 && lid.zones.filter(z => z === 'end').length >= 1, JSON.stringify(lid));
ok('…a figure of its own, beside the tiles\' one', isFinite(lid.tiles) && lid.tiles !== lid.lidar, `${lid.tiles} vs ${lid.lidar}`);
ok('…and the repeater stood on its top', lid.stood, JSON.stringify(lid));
const hubsCheck = await page.evaluate(async () => {
  await NetworkReview.checkHubsLidar();
  const c = NetworkReview.lidarCheck();
  const masts = state.data.stations.filter(s => !s.deleted_at && stationIsMast(s) && s.lat != null).length;
  const el = document.getElementById('nr-lidar');
  return { phase: c.phase, rows: c.rows.length, masts, flagged: el ? el.querySelectorAll('tbody tr').length : -1,
           said: el ? el.textContent.replace(/\s+/g, ' ').slice(0, 160) : '' };
});
ok('every repeater and base is checked against the LiDAR', hubsCheck.phase === 'done' && hubsCheck.rows === hubsCheck.masts, JSON.stringify(hubsCheck));
ok('…and the ones whose survey the LiDAR disagrees with are tabled', hubsCheck.flagged > 0 && /worth a second look/.test(hubsCheck.said), hubsCheck.said);
await page.evaluate(() => LidarProfile.seed(null));

const cover = await page.evaluate(() => {
  LinkBudget.setModel('cover');
  NetworkReview.authChanged();
  const said = /land-cover model/.test(document.querySelector('#nr-page .panel').textContent);
  LinkBudget.resetProp();
  NetworkReview.authChanged();
  return { said, back: /field-calibrated/.test(document.querySelector('#nr-page .panel').textContent) };
});
ok('the model on the card is the model the tab says it is using', cover.said && cover.back, JSON.stringify(cover));

ok('nothing threw', errors.length === 0, errors.join('\n         '));

await context.close();
await browser.close();
await server.close();

console.log(failures
  ? `\nFAIL — ${failures} of ${failures + passes} assertions about the Network Review tab.`
  : `\nPASS — ${passes} assertions: administrators only, a matrix whose cells are the card's figures,\n`
    + '       a proposed site as a column, the attenuator beside the model, and the file it all saves to.');
process.exit(failures ? 1 : 0);
