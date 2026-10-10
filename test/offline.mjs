// Opens with no signal (#213: sw.js, pwa.js, manifest.webmanifest, and
// app.js's loaders reading X-FloodNet-Offline), in Chromium with a real
// service worker — which every other check keeps off: pwa.js stands down
// under automation unless localStorage mn-sw is 'on', and this check sets it.
// The network policy is the context's here, not the page's, so the worker's
// own requests meet it too.
//
//   1. **Installable** — the manifest names Flood-Net, standalone, scoped to
//      the site, with 192 and 512 icons (and a maskable one) that exist.
//   2. **Kept** — the worker registered for the page's own version keeps the
//      whole shell: every script index.html loads, styles.css, Leaflet; and,
//      once it controls the page, the station document and the inspection
//      sheet's reference tables, as they arrive — without holding them up:
//      held part-way, the list's download still counts its bytes on the
//      loading card (#212). A data file the site changes without a new stamp
//      (the monthly ACMA refresh) is the network's while there is one.
//   3. **No signal** — offline, a reload opens the app from the copy: the
//      stations are there, and the header says it is a saved copy and how old,
//      never "from" a source it could not reach; an inspection sheet can be
//      started and its draft saved on the device; the data file's last copy
//      answers; and an address that is not the app (a doc) is not answered
//      with the app.
//   4. **A new deploy** — back online, a page that came from the copy is
//      offered the newer version, and only reloaded when somebody says so; a
//      page from the network is offered nothing.
//   5. **Never the sign-in page as the app** — an index.html that is not the
//      app (a stand-in for Access's sign-in) is not kept: that worker never
//      takes over, and the copy before it is still the one that answers.
//   6. **The sheets' tables** — the reference tables sw.js keeps are exactly
//      the ones inspections.js and maintenance.js ask for.
//
// Run:  npm run offline
//       npm run offline -- -v

import fs from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { formFixture } from './lib/migration.mjs';
import { repo } from './lib/paths.mjs';

// The worker's own requests — its install, its fetches — reach the context's
// routes only with this set (Chromium; Playwright calls it experimental).
// Without it they go round the network policy to the real network.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

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

const INDEX_HTML = fs.readFileSync(repo('index.html'), 'utf8');
const STAMP = INDEX_HTML.match(/core\.js\?v=([0-9a-z]+)/)[1];
const NEXT = `${STAMP}z`;
const LIST_BYTES = fs.statSync(repo('stations.json')).size;
const CHUNK = 512 * 1024;
const ACMA = '/data/acma-snapshots.json';

// The site as the test server serves it: as committed, as a new deploy (every
// stamp moved on), or with an Access-like sign-in page in place of the app.
// The ACMA index as committed, or as the monthly refresh leaves it — the same
// name and no new stamp.
let site = 'now';
let refreshed = false;
const rewrite = (rel, text) => {
  if (rel === ACMA) return refreshed ? JSON.stringify({ ...JSON.parse(text), refreshedForTheCheck: true }) : null;
  if (rel !== '/index.html') return null;
  if (site === 'deployed') return text.replaceAll(`?v=${STAMP}`, `?v=${NEXT}`);
  if (site === 'signin') {
    return text.replace(/<script src="init\.js[^"]*"><\/script>/, '')
      .replace('<title>', '<title>Sign in · ');
  }
  return null;
};

// The inspection sheets' reference tables, from the fixture the inspections
// check uses — on the context, so the worker's requests are answered too.
function installDatastore(context, tables) {
  return context.route('**://*.supabase.co/rest/v1/**', route => {
    const url = new URL(route.request().url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '').split('?')[0];
    const rows = tables[name];
    if (route.request().method() !== 'GET' || !rows) return route.abort();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
}

const header = page => page.evaluate(() => ({
  stats: (document.getElementById('hdr-stats') || {}).textContent || '',
  title: (document.getElementById('hdr-stats') || {}).title || '',
  stations: state.data ? state.data.stations.length : 0,
}));

async function cacheState(page, version) {
  return page.evaluate(async v => {
    const names = await caches.keys();
    const shell = names.includes(`floodnet-shell-${v}`) ? await caches.open(`floodnet-shell-${v}`) : null;
    const data = names.includes('floodnet-data') ? await caches.open('floodnet-data') : null;
    return {
      names,
      shell: shell ? (await shell.keys()).map(r => r.url) : [],
      data: data ? (await data.keys()).map(r => r.url) : [],
    };
  }, version);
}

// stations.json held after two pieces while a gate is set — links.mjs's way of
// looking at a download part-way through.
let gate = null;
function newGate() {
  let open;
  const opened = new Promise(r => { open = r; });
  gate = { opened, open: () => { open(); gate = null; } };
  return gate;
}

const fetchText = (page, rel) => page.evaluate(r => fetch(r).then(x => x.text(), e => `failed: ${e.message}`), rel);

async function main() {
  log('\n6. The sheets\' tables\n');
  {
    const sw = fs.readFileSync(repo('sw.js'), 'utf8');
    const kept = new Set([...sw.match(/const REFERENCE = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
    const asked = new Set();
    for (const f of ['inspections.js', 'maintenance.js']) {
      const src = fs.readFileSync(repo(f), 'utf8');
      for (const list of [/const LOOKUPS = \[([\s\S]*?)\]/, /const TABLES = \[([\s\S]*?)\]/]) {
        const m = src.match(list);
        if (m) for (const t of m[1].matchAll(/'([a-z_]+)'/g)) asked.add(t[1]);
      }
    }
    asked.add('inspection_form');
    const missing = [...asked].filter(t => !kept.has(t));
    const extra = [...kept].filter(t => !asked.has(t));
    check(`sw.js keeps exactly the ${asked.size} tables the two sheets ask for`, !missing.length && !extra.length, J({ missing, extra }));
  }

  const server = await startServer(undefined, {
    rewrite,
    stream: rel => rel === '/stations.json' && gate
      ? { chunk: CHUNK, wait: i => (i === 2 && gate ? gate.opened : null) } : null,
  });
  const browser = await launchBrowser();
  const errors = [], natives = [];
  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. Installable\n');
    {
      const m = JSON.parse(fs.readFileSync(repo('manifest.webmanifest'), 'utf8'));
      const icons = m.icons || [];
      const has = (size, purpose) => icons.some(i => i.sizes === size && (purpose ? i.purpose === purpose : !i.purpose)
        && fs.existsSync(repo(i.src.split('?')[0])));
      check('the manifest names Flood-Net, standalone, scoped to the site', m.name === 'Flood-Net' && m.short_name === 'Flood-Net'
        && m.display === 'standalone' && m.start_url === './' && m.scope === './', J(m));
      check('…with 192 and 512 icons that exist, and a maskable one', has('192x192') && has('512x512') && has('512x512', 'maskable'), J(icons));
      check('index.html links it', /<link rel="manifest" href="manifest\.webmanifest(?:\?v=[^"]+)?"[^>]*>/.test(INDEX_HTML));
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. Kept\n');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'allow' });
    await applyNetworkPolicy(context, server.origin);
    await installDatastore(context, formFixture());
    // No signal, for the worker too: setOffline() does not reach the requests
    // the worker makes through the context's routes, so the cut is made here
    // as well — last registered, so asked first.
    let noSignal = false;
    await context.route('**/*', route => (noSignal ? route.abort('internetdisconnected') : route.fallback()));
    await context.addInitScript(() => { try { localStorage.setItem('mn-sw', 'on'); } catch (_) {} });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    page.on('dialog', d => { natives.push(d.message()); d.dismiss().catch(() => {}); });
    await page.goto(server.url('/?tab=stations'), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => !!state.data, null, { timeout: LOAD_TIMEOUT });
    const reg = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready;
      return { script: r.active && r.active.scriptURL, scope: r.scope };
    });
    check('a first visit registers the worker for the page\'s own version, over the whole site',
      reg.script && reg.script.endsWith(`/sw.js?v=${STAMP}`) && reg.scope === `${server.origin}/`, J(reg));
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
    let C = await cacheState(page, STAMP);
    const scripts = [...INDEX_HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
    const local = scripts.filter(s => !/^https?:/.test(s)).map(s => `${server.origin}/${s}`);
    const missingShell = local.filter(u => !C.shell.includes(u));
    check(`it keeps the whole shell: all ${local.length} of index.html's scripts, styles.css, the page itself and Leaflet`,
      !missingShell.length && C.shell.includes(`${server.origin}/styles.css?v=${STAMP}`) && C.shell.includes(`${server.origin}/`)
        && C.shell.some(u => /unpkg\.com\/leaflet@[\d.]+\/dist\/leaflet\.js$/.test(u)), J({ missing: missingShell.slice(0, 5), n: C.shell.length }));
    check('…and nothing it was not asked to: no Access page, no /api route', !C.shell.some(u => /\/api\//.test(u)), J(C.shell.filter(u => /api/.test(u))));
    // Controlled now: a reload's station document goes through the worker.
    await page.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => !!state.data, null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => switchTab('inspections'));
    await page.waitForFunction(() => state.insp.refs || state.insp.refsError, null, { timeout: LOAD_TIMEOUT });
    C = await cacheState(page, STAMP);
    check('controlled, it keeps the station document the page loaded', C.data.some(u => /\/stations\.json$/.test(u)), J(C.data.slice(0, 4)));
    check('…and the inspection sheet\'s tables', C.data.some(u => /\/rest\/v1\/inspection_form\?/.test(u))
      && C.data.some(u => /\/rest\/v1\/yes_no\?/.test(u)), J(C.data.filter(u => /rest/.test(u)).length));
    let H = await header(page);
    check('online, the header says where the list came from, as ever', /from stations\.json/.test(H.stats) && !/saved copy/.test(H.stats), J(H));
    // A kept copy on screen while there is a signal (a paused datastore fails
    // a request as no network does) names the source that did not answer.
    const withSignal = await page.evaluate(() => {
      const was = state.dataSource.kept;
      state.dataSource.kept = new Date(Date.now() - 2 * 3600e3);
      updateHeaderStats();
      const text = document.getElementById('hdr-stats').textContent;
      state.dataSource.kept = was;
      updateHeaderStats();
      return text;
    });
    check('…and a kept copy shown while there is a signal names the source that did not answer — never "no signal"',
      /saved copy, 2 hours old — no answer from this site/.test(withSignal) && !/no signal/.test(withSignal), withSignal);
    // The list goes through the worker as it arrives: held after two pieces,
    // the loading card already counts them, of the whole.
    const g = newGate();
    await page.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
    const heldAt = `${(2 * CHUNK / 1e6).toFixed(1)} MB of ${(LIST_BYTES / 1e6).toFixed(1)} MB`;
    const counted = await page.waitForFunction(t => (document.getElementById('load-got') || {}).textContent === t,
      heldAt, { timeout: 20_000 }).then(() => true, () => false);
    const seen = await page.evaluate(() => (document.getElementById('load-got') || {}).textContent || null);
    g.open();
    check('…and still arrives as it downloads: held part-way, the loading card counts its bytes, of the whole (#212)',
      counted && await page.evaluate(() => !!navigator.serviceWorker.controller), J({ seen, want: heldAt }));
    await page.waitForFunction(() => !!state.data, null, { timeout: LOAD_TIMEOUT });
    // A data file the site changes under the same name, with no new stamp.
    const acmaBefore = await fetchText(page, ACMA.slice(1));
    // The copy is written beside the answer, not before it: the site changes
    // once there is one to be wrong about.
    for (const end = Date.now() + 5_000; Date.now() < end;) {
      if (await page.evaluate(u => caches.match(u).then(Boolean), `${server.origin}${ACMA}`)) break;
      await page.waitForTimeout(100);
    }
    refreshed = true;
    const acmaAfter = await fetchText(page, ACMA.slice(1));
    check('a data file the site changes without a new stamp is the network\'s, not a kept copy\'s',
      !/refreshedForTheCheck/.test(acmaBefore) && /refreshedForTheCheck/.test(acmaAfter), J({ before: acmaBefore.slice(0, 60), after: acmaAfter.slice(0, 60) }));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. No signal\n');
    noSignal = true;
    await context.setOffline(true);
    await page.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
    H = await header(page);
    check('offline, a reload opens the app from the copy, with its stations', H.stations > 1000, J(H));
    check('…and the header says it is a saved copy, how old, and that there is no signal — not "from" anywhere',
      /saved copy, \d+ minutes? old — no signal/.test(H.stats) && !/ from /.test(H.stats) && /kept on this device, saved /.test(H.title), J(H));
    await page.evaluate(() => switchTab('inspections'));
    await page.waitForFunction(() => state.insp.refs || state.insp.refsError, null, { timeout: LOAD_TIMEOUT });
    const draft = await page.evaluate(async () => {
      if (!state.insp.refs) return { refs: false, error: state.insp.refsError };
      const cfg = state.insp.refs.inspection_config[0].key;
      Inspections.pick(null);
      Inspections.setConfig(cfg);
      await new Promise(r => setTimeout(r, 200));
      Inspections.saveDraft();
      const all = JSON.parse(localStorage.getItem('mn-insp-drafts') || '{}');
      return { refs: true, cfg, drafts: Object.keys(all).length };
    });
    check('…and an inspection sheet starts from the kept tables, its draft saved on the device', draft.refs && draft.drafts >= 1, J(draft));
    const acmaOffline = await fetchText(page, ACMA.slice(1));
    check('…and a data file fetched online is there, as last fetched', /refreshedForTheCheck/.test(acmaOffline), acmaOffline.slice(0, 80));
    {
      const other = await context.newPage();
      const went = await other.goto(server.url('/docs/agent-api.md'), { timeout: 15_000 })
        .then(r => ({ status: r && r.status(), text: '' }), e => ({ error: String(e.message || e).split('\n')[0] }));
      if (!went.error) went.text = (await other.content()).slice(0, 120);
      await other.close();
      check('…and an address that is not the app is not answered with the app', !!went.error && !/<script src="init\.js/.test(went.text || ''), J(went));
    }
    refreshed = false;

    // ═══════════════════════════════════════════════════════════════════════
    log('\n4. A new deploy\n');
    site = 'deployed';
    noSignal = false;
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const offered = await page.waitForSelector('#pwa-update', { timeout: 10_000 }).then(() => true, () => false);
    const bar = await page.evaluate(() => {
      const el = document.getElementById('pwa-update');
      return el && { text: el.textContent.replace(/\s+/g, ' ').trim(), buttons: [...el.querySelectorAll('button')].map(b => b.textContent),
        live: el.getAttribute('aria-live') || el.getAttribute('role'), version: APP_VERSION };
    });
    check('back online, a page that came from the copy is offered the newer version', offered && /A newer version of Flood-Net is ready/.test(bar.text)
      && J(bar.buttons) === J(['Reload now', 'Later']), J(bar));
    await page.waitForTimeout(1500);
    check('…and is not reloaded under its author: it is the same page, still the old version, until somebody says',
      await page.evaluate(v => APP_VERSION === v && !!document.getElementById('pwa-update'), STAMP));
    // A note that stays (a failure) while the bar is up stands above it.
    const stack = await page.evaluate(() => {
      Toast.failed('A note for the check, while the bar is up.');
      const t = document.querySelector('#toasts .toast'), b = document.getElementById('pwa-update');
      const tr = t && t.getBoundingClientRect(), br = b.getBoundingClientRect();
      const out = { toastBottom: tr && Math.round(tr.bottom), barTop: Math.round(br.top) };
      Toast.clear();
      return out;
    });
    check('…and a note shown while it is up stands above it, not over its buttons',
      stack.toastBottom != null && stack.toastBottom <= stack.barTop, J(stack));
    await page.click('#pwa-update [data-pwa="reload"]');
    await page.waitForFunction(v => typeof APP_VERSION !== 'undefined' && APP_VERSION === v, NEXT, { timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => !!state.data, null, { timeout: LOAD_TIMEOUT });
    await page.waitForFunction(v => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.endsWith(`?v=${v}`),
      NEXT, { timeout: 20_000 }).catch(() => {});
    // A worker becomes the page's controller as it starts to activate; the old
    // copy goes during activation, a moment later.
    for (const end = Date.now() + 15_000; Date.now() < end;) {
      if (!(await page.evaluate(v => caches.keys().then(k => k.includes(`floodnet-shell-${v}`)), STAMP))) break;
      await page.waitForTimeout(200);
    }
    const after = await page.evaluate(async () => ({
      version: APP_VERSION,
      sw: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL,
      names: await caches.keys(),
      bar: !!document.getElementById('pwa-update'),
    }));
    check('Reload now opens the new version, whose worker keeps its own copy and drops the old one',
      after.version === NEXT && after.sw && after.sw.endsWith(`sw.js?v=${NEXT}`)
        && after.names.includes(`floodnet-shell-${NEXT}`) && !after.names.includes(`floodnet-shell-${STAMP}`), J(after));
    await page.evaluate(() => Pwa.check());
    await page.waitForTimeout(500);
    check('a page that came from the network is offered nothing', !(await page.evaluate(() => !!document.getElementById('pwa-update'))));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n5. Never the sign-in page as the app\n');
    site = 'signin';
    // A version the browser has not met, so it tries to install a worker for it.
    const tried = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.register('sw.js?v=signin-test', { scope: './' });
      const w = r.installing || r.waiting;
      if (!w) return { state: 'none' };
      return new Promise(resolve => {
        const done = () => resolve({ state: w.state });
        w.addEventListener('statechange', () => { if (w.state === 'redundant' || w.state === 'activated') done(); });
        setTimeout(done, 15_000);
      });
    });
    const still = await page.evaluate(async () => ({
      names: await caches.keys(),
      controller: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL,
    }));
    check('a worker that is handed a page that is not the app does not install — it never takes over',
      tried.state === 'redundant' && !still.names.includes('floodnet-shell-signin-test'), J({ tried, still }));
    check('…and the copy before it is still the one that answers', still.controller && still.controller.endsWith(`?v=${NEXT}`)
      && still.names.includes(`floodnet-shell-${NEXT}`), J(still));
    site = 'now';

    check('no native dialog, and nothing threw', !natives.length && !errors.length, J({ natives, errors: errors.slice(0, 3) }));
    await context.close();

    // ═══════════════════════════════════════════════════════════════════════
    log('\n…and under automation, by default, no worker at all\n');
    {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      await applyNetworkPolicy(ctx, server.origin);
      const p = await ctx.newPage();
      await p.goto(server.url('/?tab=stations'), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
      await p.waitForTimeout(1500);
      const none = await p.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
      check('every other check runs with no worker between it and the requests it stubs', none === 0, J(none));
      await ctx.close();
    }
  } finally {
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
  log('\nPASS — a device that has opened Flood-Net opens it again with no signal, says what\n'
    + '       it is showing and how old, and is offered a new deploy rather than handed one.');
}

main().catch(err => { console.error(err); process.exit(1); });
