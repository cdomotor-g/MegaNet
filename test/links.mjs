// Where you are, in the address bar (#211, route.js), and the first load
// saying what it is doing (#212, app.js's autoLoad), driven in a real browser.
//
//   1. **The first load** — held part-way through by the server, so what the
//      page says while it waits can be read: a loading card on the data tab,
//      the source being asked after the one that failed, how much of how much
//      has arrived and a bar that agrees, the header saying "Loading", and
//      never "No data loaded". The station a link named stays in the address
//      while the list is on its way, and its card comes up when it lands.
//   2. **A load that fails everywhere** — the card says so, lists the three
//      sources in the order they were tried and why each failed, the header
//      and a screen reader are told, and ↻ Try again runs the chain again.
//   3. **The address follows the app** — a tab change is a step, a station's
//      card coming up is a step, the map moving and the card closing are not;
//      back and forward walk the steps, tab, card and view.
//   4. **A link** — tab, station and view open as named, for someone with
//      nothing stored; a station alone means the Stations tab; an unknown tab
//      or station is set aside politely; a reload keeps your place.
//   5. **The last tab** — a bare address opens the tab used last on this
//      device.
//   6. **The fragment's owners** — a Workbench case shared as `#wb…` still
//      opens the Workbench, and leaving it takes the case out of the address.
//   7. **Copy link** — the station card's pill puts a link on the clipboard
//      that opens that station for somebody else.
//
// Why a check of its own: every failure here is an address that looks fine.
// A link that opens on the wrong tab, a back button that skips a step or
// replays every pan, a reload that loses the card, a loading card that says
// nothing is coming — none of them throws.
//
// Run:  npm run links
//       npm run links -- -v

import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { REPO_ROOT } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log  = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}
const J = v => JSON.stringify(v);

// Two stations with a position and nobody within ~500 m, so a pin click on
// either opens its card rather than fanning a stack.
const DOC = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'stations.json'), 'utf8'));
const FILE_BYTES = fs.statSync(path.join(REPO_ROOT, 'stations.json')).size;
const near = (a, b) => Math.abs(a.lat - b.lat) < 0.005 && Math.abs(a.lon - b.lon) < 0.005;
const PLACED = DOC.stations.filter(s => s.lat != null && s.lon != null);
const LONE = PLACED.filter(s => !PLACED.some(o => o !== s && near(s, o)));
const [A, B] = [LONE[0], LONE[Math.floor(LONE.length / 2)]];

// The server holds stations.json after its first two 512 KB pieces while a
// gate is set, until the gate is opened.
let gate = null;
function newGate() {
  let open;
  const opened = new Promise(r => { open = r; });
  gate = { opened, open: () => { open(); gate = null; } };
  return gate;
}
const CHUNK = 512 * 1024;

const settle = page => page.waitForFunction(() => !state.map || (!state.map._animatingZoom
  && !(state.map._panAnim && state.map._panAnim._inProgress)), null, { timeout: 10_000 })
  .then(() => page.waitForTimeout(150));

// The address follows a pan once the map has stopped for 400 ms.
const MAP_SETTLE = 700;

// Every history call the page makes, counted: a step is a pushState, and
// "not a step" is no pushState at all. history.length cannot say it — a push
// from the middle of the history drops the steps ahead of it, so the length
// can stand still across a real step.
const COUNT_STEPS = () => {
  window.__steps = { push: 0, replace: 0 };
  const push = history.pushState.bind(history), replace = history.replaceState.bind(history);
  history.pushState = (...a) => { window.__steps.push++; return push(...a); };
  history.replaceState = (...a) => { window.__steps.replace++; return replace(...a); };
};

const where = page => page.evaluate(() => {
  const q = new URLSearchParams(location.search);
  return { search: location.search, hash: location.hash, tab: q.get('tab'), station: q.get('station'),
           map: q.get('map'), push: window.__steps.push, active: state.activeTab,
           card: state.stnCard && state.stnCard.id };
});

// A view is "the same" to within a few pixels: the maps are re-measured after
// a render (invalidateSize), and Leaflet pans in whole pixels, so a centre set
// exactly comes back a fraction of a pixel off — which, written to five
// decimals, is a different string.
const PX = 3;
const degPerPx = z => 360 / (256 * 2 ** z);
function viewNear(str, lat, lng, z) {
  if (!str) return false;
  const [la, ln, zz] = str.split(',').map(Number);
  const tol = PX * degPerPx(z);
  return zz === z && Math.abs(la - lat) <= tol && Math.abs(ln - lng) <= tol;
}
const centreNear = (page, lat, lng, z) => page.evaluate(([lat, lng, z, px]) => {
  if (state.map.getZoom() !== z) return false;
  const a = state.map.latLngToContainerPoint([lat, lng]);
  const b = state.map.latLngToContainerPoint(state.map.getCenter());
  return a.distanceTo(b) <= px;
}, [lat, lng, z, PX]);

async function open(browser, server, errors, url, contextOpts = {}, context = null) {
  context = context || await browser.newContext({ viewport: { width: 1440, height: 900 }, ...contextOpts });
  const page = await context.newPage();
  await page.addInitScript(COUNT_STEPS);
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  return { context, page };
}
const loaded = page => page.waitForFunction(
  () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
  null, { timeout: LOAD_TIMEOUT });
const mapUp = page => page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0,
  null, { timeout: LOAD_TIMEOUT }).then(() => settle(page));

// A real pin click, the way stn-card.mjs and trail.mjs make one.
const clickPin = (page, id) => page.evaluate(id => {
  const m = state.mapMarkers.find(x => x.mnStationId === id);
  state.map.setView(m.getLatLng(), 14, { animate: false });
  m.fire('click', { originalEvent: new MouseEvent('click'), latlng: m.getLatLng() });
}, id);

async function main() {
  const server = await startServer(undefined, {
    stream: rel => rel === '/stations.json' && gate
      ? { chunk: CHUNK, wait: i => (i === 2 && gate ? gate.opened : null) } : null,
  });
  const browser = await launchBrowser();
  const errors = [];
  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. The first load, held part-way through\n');
    const view = `${A.lat.toFixed(5)},${A.lon.toFixed(5)},13`;
    const g1 = newGate();
    const { context: c1, page } = await open(browser, server, errors,
      server.url(`/index.html?station=${encodeURIComponent(A.id)}&map=${view}`));
    // Held after two pieces: wait until both have arrived and been painted.
    const heldAt = `${(2 * CHUNK / 1e6).toFixed(1)} MB of ${(FILE_BYTES / 1e6).toFixed(1)} MB`;
    await page.waitForFunction(t => (document.getElementById('load-got') || {}).textContent === t,
      heldAt, { timeout: LOAD_TIMEOUT });
    const mid = await page.evaluate(() => {
      const card = document.getElementById('load-card');
      const bar = document.getElementById('load-bar');
      return {
        main: document.getElementById('main-content').textContent.replace(/\s+/g, ' ').trim(),
        title: card && card.querySelector('h2').textContent,
        busy: card && card.getAttribute('aria-busy'),
        step: document.getElementById('load-step').textContent,
        got: document.getElementById('load-got').textContent,
        tried: [...card.querySelectorAll('.load-tried li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
        value: bar && Number(bar.getAttribute('value')), max: bar && Number(bar.getAttribute('max')),
        label: bar && bar.getAttribute('aria-label'),
        header: document.getElementById('hdr-stats').textContent,
        search: location.search, active: state.activeTab, data: !!state.data,
      };
    });
    check('a data tab shows the loading card while the list is on its way, not "No data loaded"',
      mid.title === 'Loading the station list…' && mid.busy === 'true' && !/No data loaded|Migration Tool/.test(mid.main) && !mid.data,
      J({ title: mid.title, busy: mid.busy, main: mid.main.slice(0, 120) }));
    check('…saying the datastore failed and which source it is asking instead',
      mid.tried.length === 1 && /^✗ the datastore — \S/.test(mid.tried[0])
        && mid.step === 'Trying the copy of stations.json on this site instead…', J({ step: mid.step, tried: mid.tried }));
    check('…how much of how much has arrived, with the bar agreeing',
      mid.got === heldAt && mid.value === 2 * CHUNK && mid.max === FILE_BYTES && mid.label === 'Station list download',
      J({ got: mid.got, value: mid.value, max: mid.max }));
    check('the header says it is loading', mid.header === 'Loading stations…', mid.header);
    check('the station and view the link named stay in the address while the list loads',
      mid.active === 'stations' && new URLSearchParams(mid.search).get('station') === A.id
        && new URLSearchParams(mid.search).get('map') === view && new URLSearchParams(mid.search).get('tab') === 'stations',
      mid.search);
    g1.open();
    await loaded(page);
    await mapUp(page);
    await page.waitForFunction(id => state.stnCard.id === id, A.id, { timeout: 10_000 });
    const landedAt = await centreNear(page, A.lat, A.lon, 13);
    const landed = await page.evaluate(() => ({
      card: state.stnCard.id, sel: state.selectedId,
      c: state.map.getCenter(), z: state.map.getZoom(),
      loadCard: !!document.getElementById('load-card'),
      header: document.getElementById('hdr-stats').textContent,
      size: localStorage.getItem('mn-load-bytes-bundled'),
    }));
    check('…and when it lands, the card is up on that station and the map on that view',
      landed.card === A.id && landedAt,
      J(landed));
    check('…without selecting it: a link is what was looked at, not an edit', landed.sel === null, J(landed.sel));
    check('the loading card is gone and the header counts the stations',
      !landed.loadCard && /^\d+ stations · \d+ repeaters · from stations\.json \(this site\)$/.test(landed.header), landed.header);
    check('the size is kept, so the next load can say "of about"', Number(landed.size) === FILE_BYTES, landed.size);

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. The address follows the app — and back and forward follow it\n');
    // The load and the link wrote the address without a step: it was one page
    // opened, and back from it leaves the app as it always did.
    const opened = await where(page);
    check('opening the app, the list landing and the link applied are not steps of their own',
      opened.push === 0, J(opened));
    await page.evaluate(() => closeStnCard());
    await page.waitForTimeout(MAP_SETTLE);
    let w0 = await where(page);
    check('closing the card takes the station out of the address, in place',
      w0.station === null && w0.tab === 'stations' && viewNear(w0.map, A.lat, A.lon, 13) && w0.push === opened.push, J(w0));

    await page.click('#tab-nav .tab-btn[data-tab="passranges"]');
    await page.waitForFunction(() => state.activeTab === 'passranges', null, { timeout: 10_000 });
    let w = await where(page);
    check('a tab picked from the nav is a step, and the address names it alone',
      w.search === '?tab=passranges' && w.push === w0.push + 1, J({ w, before: w0.push }));
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => state.activeTab === 'stations' && !!state.map, null, { timeout: 10_000 });
    await mapUp(page);
    w = await where(page);
    check('back returns to the Stations tab, at the view it was on — and is not itself a step',
      w.tab === 'stations' && w.push === w0.push + 1 && await centreNear(page, A.lat, A.lon, 13), J(w));
    await page.evaluate(() => history.forward());
    await page.waitForFunction(() => state.activeTab === 'passranges', null, { timeout: 10_000 });
    check('forward goes to Pass Ranges again', (await where(page)).tab === 'passranges');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => state.activeTab === 'stations' && !!state.map, null, { timeout: 10_000 });
    await mapUp(page);

    // A station's card is a step; the map moving is not.
    w0 = await where(page);
    await clickPin(page, A.id);
    await page.waitForFunction(id => state.stnCard.id === id, A.id, { timeout: 10_000 });
    await page.waitForTimeout(MAP_SETTLE);
    const wA = await where(page);
    check('a pin opening a card is a step, and the address names the station',
      wA.station === A.id && wA.push === w0.push + 1, J({ wA, before: w0.push }));
    await page.evaluate(() => state.map.setView([-25.6, 134.3], 6, { animate: false }));
    await page.waitForTimeout(MAP_SETTLE);
    const wPan = await where(page);
    check('moving the map rewrites the view in place — no step per pan',
      wPan.push === wA.push && viewNear(wPan.map, -25.6, 134.3, 6) && wPan.station === A.id, J(wPan));
    await clickPin(page, B.id);
    await page.waitForFunction(id => state.stnCard.id === id, B.id, { timeout: 10_000 });
    await page.waitForTimeout(MAP_SETTLE);
    const wB = await where(page);
    check('a second station is a second step', wB.station === B.id && wB.push === wPan.push + 1, J(wB));
    await page.evaluate(() => history.back());
    await page.waitForFunction(id => state.stnCard.id === id, A.id, { timeout: 10_000 });
    const backA = await page.evaluate(() => ({ c: state.map.getCenter(), z: state.map.getZoom(), tab: state.activeTab,
      push: window.__steps.push }));
    check('back puts the first station\'s card up again, at the view that step was left on',
      backA.tab === 'stations' && backA.push === wB.push && await centreNear(page, -25.6, 134.3, 6), J(backA));
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => state.stnCard.id === null, null, { timeout: 10_000 });
    check('back again closes the card: the step before had none', (await where(page)).station === null);
    await page.evaluate(() => history.forward());
    await page.waitForFunction(id => state.stnCard.id === id, A.id, { timeout: 10_000 });
    check('forward brings it back', (await where(page)).station === A.id);

    // A reload keeps your place.
    await page.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await loaded(page);
    await mapUp(page);
    await page.waitForFunction(id => state.stnCard.id === id, A.id, { timeout: 10_000 });
    const re = await page.evaluate(() => ({ c: state.map.getCenter(), z: state.map.getZoom(), tab: state.activeTab }));
    check('a reload keeps the tab, the card and the view', re.tab === 'stations'
      && await centreNear(page, -25.6, 134.3, 6), J(re));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. Copy link, and the link it copies\n');
    await c1.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
    await page.click('#stn-card .mn-copy-link');
    await page.waitForFunction(() => /Copied/.test((document.querySelector('#stn-card .mn-copy-link') || {}).textContent || ''),
      null, { timeout: 5_000 });
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    let u = null;
    try { u = new URL(copied); } catch (_) {}
    check('the card\'s 🔗 Copy link copies an absolute link to this station on this view',
      !!u && u.origin === server.origin && u.searchParams.get('tab') === 'stations' && u.searchParams.get('station') === A.id
        && viewNear(u.searchParams.get('map'), -25.6, 134.3, 6), copied);
    await c1.close();

    const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = (await open(browser, server, errors, copied, {}, c2)).page;
    await loaded(p2);
    await mapUp(p2);
    await p2.waitForFunction(id => state.stnCard.id === id, A.id, { timeout: 10_000 });
    check('opened by somebody with nothing stored, it is that station, that view',
      await centreNear(p2, -25.6, 134.3, 6));
    await c2.close();

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3b. "Go to station" from another tab is one step\n');
    {
      const { context, page: p } = await open(browser, server, errors, server.url());
      await loaded(p);
      await p.evaluate(() => switchTab('passranges'));
      const before = await where(p);
      // Pass Ranges' rows and Station Health's findings open a station this
      // way: the tab switches and the card comes up, in one go.
      await p.evaluate(id => goToStation(id), B.id);
      await p.waitForFunction(id => state.stnCard.id === id && !!state.map, B.id, { timeout: LOAD_TIMEOUT });
      const went = await where(p);
      check('it is one step, landing on the station', went.push === before.push + 1
        && went.tab === 'stations' && went.station === B.id, J({ before: before.push, went }));
      await p.evaluate(() => history.back());
      await p.waitForFunction(() => state.activeTab === 'passranges', null, { timeout: 10_000 });
      check('so one back returns to the tab it was opened from', (await where(p)).tab === 'passranges');
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n4. Links that name less, or something that is not there\n');
    {
      const { context, page: p } = await open(browser, server, errors, server.url(`/index.html?station=${encodeURIComponent(B.id)}`));
      await loaded(p);
      await mapUp(p);
      await p.waitForFunction(id => state.stnCard.id === id, B.id, { timeout: 10_000 });
      const s = await p.evaluate(id => {
        const st = state.data.stations.find(x => x.id === id);
        return { tab: state.activeTab, inView: state.map.getBounds().contains([st.lat, st.lon]), z: state.map.getZoom(),
                 q: new URLSearchParams(location.search).get('tab') };
      }, B.id);
      check('a station alone means the Stations tab, its card up and the station in view, close in',
        s.tab === 'stations' && s.q === 'stations' && s.inView && s.z >= 11, J(s));
      await context.close();
    }
    {
      const { context, page: p } = await open(browser, server, errors, server.url('/index.html?tab=no-such-tab&keep=1'));
      await loaded(p);
      const s = await where(p);
      check('an unknown tab is set aside: Stations, and the address says so, keeping what else it carried',
        s.active === 'stations' && s.tab === 'stations' && /(^\?|&)keep=1(&|$)/.test(s.search), J(s));
      await context.close();
    }
    {
      const { context, page: p } = await open(browser, server, errors, server.url('/index.html?tab=stations&station=no_such_station'));
      await loaded(p);
      await mapUp(p);
      await p.waitForTimeout(MAP_SETTLE);
      const s = await where(p);
      await p.waitForFunction(() => /is not in the station list/.test(document.getElementById('app-status').textContent),
        null, { timeout: 5_000 }).catch(() => {});
      const said = await p.evaluate(() => document.getElementById('app-status').textContent);
      check('an unknown station opens the map without a card, says so, and leaves the address',
        s.card === null && s.station === null && /no_such_station\) is not in the station list/.test(said), J({ s, said }));
      await context.close();
    }
    {
      const { context, page: p } = await open(browser, server, errors, server.url('/index.html?tab=health'));
      const early = await p.evaluate(() => ({ tab: state.activeTab, card: !!document.getElementById('load-card') }));
      await loaded(p);
      const s = await where(p);
      check('a link to a data tab opens on it — the loading card first, then the tab',
        early.tab === 'health' && s.active === 'health' && s.search === '?tab=health', J({ early, s }));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n5. The last tab used on this device\n');
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const first = (await open(browser, server, errors, server.url(), {}, ctx)).page;
      await loaded(first);
      const fresh = await where(first);
      check('a first visit with a bare address opens the Site Map guide once (#222), and says so',
        fresh.active === 'sitemap' && fresh.tab === 'sitemap', J(fresh));
      await first.evaluate(() => switchTab('export'));
      await first.close();
      const again = (await open(browser, server, errors, server.url(), {}, ctx)).page;
      await loaded(again);
      const s = await where(again);
      check('the next bare visit on this device opens the tab used last', s.active === 'export' && s.tab === 'export', J(s));
      await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n6. The Workbench\'s own fragment\n');
    {
      const { context, page: p } = await open(browser, server, errors, server.url('/index.html#wb&a=6128.6129'));
      await loaded(p);
      let s = await where(p);
      check('a Workbench case shared as #wb… opens the Workbench, the case kept in the fragment',
        s.active === 'workbench' && s.tab === 'workbench' && s.hash.startsWith('#wb')
          && await p.evaluate(() => state.wb.affected.join(',') === '6128,6129'), J(s));
      await p.evaluate(() => switchTab('stations'));
      s = await where(p);
      check('leaving it takes the case out of the address, so a reload does not drag you back',
        s.active === 'stations' && s.hash === '' && s.tab === 'stations', J(s));
      await p.evaluate(() => history.back());
      await p.waitForFunction(() => state.activeTab === 'workbench', null, { timeout: 10_000 });
      s = await where(p);
      check('back is the Workbench, case and all', s.hash.startsWith('#wb') && s.tab === 'workbench', J(s));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n7. A load that fails everywhere\n');
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      await p.addInitScript(COUNT_STEPS);
      await applyNetworkPolicy(p, server.origin);
      p.on('pageerror', e => errors.push(String(e)));
      let refuse = true;
      await p.route('**/stations.json', route => refuse
        ? route.fulfill({ status: 503, contentType: 'text/plain', body: 'Service Unavailable' })
        : route.fallback());
      // On Stations by name: a first visit's bare address is the Site Map,
      // which needs no list and so shows no loading card.
      await p.goto(server.url('/index.html?tab=stations'), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
      await p.waitForFunction(() => /could not be loaded/.test((document.querySelector('#load-card h2') || {}).textContent || '')
        && /could not be loaded/.test(document.getElementById('app-status').textContent), null, { timeout: LOAD_TIMEOUT });
      const f = await p.evaluate(() => {
        const card = document.getElementById('load-card');
        return {
          tried: [...card.querySelectorAll('.load-tried li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
          buttons: [...card.querySelectorAll('.empty-actions button')].map(b => b.textContent.replace(/\s+/g, ' ').trim()),
          primary: (card.querySelector('.empty-actions button.primary') || {}).textContent,
          busy: card.getAttribute('aria-busy'),
          migrate: !!card.querySelector('a[href="migrate.html"]'),
          header: document.getElementById('hdr-stats').textContent,
          said: document.getElementById('app-status').textContent,
        };
      });
      check('the card says the list could not be loaded, and lists every source in the order tried, with why',
        f.tried.length === 3 && /^✗ the datastore — \S/.test(f.tried[0])
          && f.tried[1] === '✗ stations.json (this site) — HTTP 503' && /^✗ stations\.json \(GitHub\) — \S/.test(f.tried[2])
          && f.busy === null, J(f.tried));
      check('…↻ Try again leads, with a file, GitHub and Admin beside it, and the Migration Tool after',
        /Try again/.test(f.primary || '') && f.buttons.length === 4 && f.migrate, J(f.buttons));
      check('the header and a screen reader are told', f.header === 'Station list not loaded'
        && /station list could not be loaded/i.test(f.said), J({ header: f.header, said: f.said }));
      refuse = false;
      await p.click('#load-card button.primary');
      const retrying = await p.evaluate(() => ({ title: (document.querySelector('#load-card h2') || {}).textContent,
        header: document.getElementById('hdr-stats').textContent }));
      check('↻ Try again goes straight back to the loading card', retrying.title === 'Loading the station list…'
        && retrying.header === 'Loading stations…', J(retrying));
      await loaded(p);
      await mapUp(p);
      await p.waitForFunction(() => /^Station list loaded — \d+ stations$/.test(document.getElementById('app-status').textContent),
        null, { timeout: 5_000 }).catch(() => {});
      const after = await p.evaluate(() => ({ card: !!document.getElementById('load-card'), kind: state.dataSource.kind,
        pins: state.mapMarkers.length, said: document.getElementById('app-status').textContent }));
      check('…runs the chain again, the list lands, and the one who pressed it is told',
        !after.card && after.kind === 'bundled' && after.pins > 0 && /^Station list loaded — \d+ stations$/.test(after.said), J(after));
      await ctx.close();
    }

    check('nothing threw for the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    if (gate) gate.open();
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).`);
  if (failed.length) {
    log(`\nFAIL — ${failed.length} of them:\n`);
    for (const f of failed) log(`  ✗ ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exit(1);
  }
  log('\nPASS — the address says where you are, back and forward walk it, a link opens\n'
    + '       what it names, and the first load says what it is doing until it is done.');
}

main().catch(err => { console.error(err); process.exit(1); });
