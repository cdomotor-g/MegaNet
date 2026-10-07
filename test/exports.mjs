// One Export for what the tab shows (#227: export-menu.js's ExportMenu, and
// core.js's floodnetName at every place a file is written), driven in a real
// browser.
//
//   1. **Every tab accounted for** — each tab in TABS either offers something
//      or is exempt with a reason; none is both; every offer names a writer
//      the app has (resolved, not trusted).
//   2. **The banner's ⤓ Export** — on every tab, a dialog of the tab's offers;
//      on an exempt tab, the reason in words.
//   3. **Offers that cannot run** say why, in words, and write nothing; an
//      offer whose writer finds nothing says what to do first.
//   4. **The Stations tab** — signed out, the station list is not handed over
//      (the Export tab's rule, #191); signed in, the filtered list as CSV,
//      GeoJSON and KML, the GeoJSON's points exactly the filtered stations
//      that have a place — the filter takes in two that have none, so a
//      writer that put them at [0, 0] is red — and the note says how many
//      were left out; the selection's CSV.
//   5. **Other tabs, on their own demo data** — ARRO Data, ALERT2, HFEM,
//      Reception and Station Health each give a file through the banner.
//   6. **Every file is floodnet-…** — including a writer whose own name was
//      not.
//
// Run:  npm run exports
//       npm run exports -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

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

const readDownload = async dl => {
  const chunks = [];
  for await (const c of await dl.createReadStream()) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

// The menu, as somebody sees it.
const menu = page => page.evaluate(() => {
  const root = document.getElementById('exm');
  if (!root) return null;
  return {
    title: (document.getElementById('app-modal-title') || {}).textContent || '',
    offers: [...root.querySelectorAll('.exm-opt')].map(b => ({
      label: b.querySelector('.exm-label').textContent,
      sub: b.querySelector('.exm-sub').textContent,
      off: b.getAttribute('aria-disabled') === 'true',
    })),
    none: (root.querySelector('.exm-none') || {}).textContent || '',
    focus: document.activeElement && document.activeElement.classList.contains('exm-opt'),
  };
});

// Opens ⤓ Export on the tab, picks the offer whose label starts with `label`,
// and waits for the file it writes.
async function take(page, label) {
  await page.click('#btn-export');
  await page.waitForSelector('#exm', { timeout: 5_000 });
  const i = await page.evaluate(l => [...document.querySelectorAll('#exm .exm-opt')]
    .findIndex(b => b.querySelector('.exm-label').textContent.startsWith(l)), label);
  if (i < 0) { await page.keyboard.press('Escape'); return { error: `no offer "${label}"` }; }
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }).catch(() => null),
    page.click(`#exm .exm-opt[data-exm="${i}"]`),
  ]);
  if (!dl) return { error: `"${label}" wrote nothing` };
  return { name: dl.suggestedFilename(), body: await readDownload(dl) };
}

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [], natives = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    page.on('pageerror', e => errors.push(String(e)));
    page.on('dialog', async d => { natives.push(d.message()); await d.dismiss().catch(() => {}); });
    await page.goto(server.url('/index.html?tab=stations'), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => !!state.data && !!state.map, null, { timeout: LOAD_TIMEOUT });

    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. Every tab accounted for\n');
    const cov = await page.evaluate(() => ({ tabs: TAB_LIST.map(t => t.id), ...ExportMenu.coverage() }));
    const offerSet = new Set(cov.offers), exemptIds = Object.keys(cov.exempt);
    const missing = cov.tabs.filter(t => !offerSet.has(t) && !(t in cov.exempt));
    const both = cov.tabs.filter(t => offerSet.has(t) && t in cov.exempt);
    const stray = [...cov.offers, ...exemptIds].filter(t => !cov.tabs.includes(t));
    check(`every one of the ${cov.tabs.length} tabs offers something or is exempt — none both, none unknown`,
      !missing.length && !both.length && !stray.length, J({ missing, both, stray }));
    const thin = exemptIds.filter(t => !(String(cov.exempt[t]).length >= 40) || /todo|tbd|later/i.test(cov.exempt[t]));
    check(`each of the ${exemptIds.length} exempt tabs says why, in a sentence`, !thin.length, J(thin.map(t => [t, cov.exempt[t]])));
    const dead = Object.entries(cov.calls).flatMap(([t, list]) => list.filter(o => !o.resolves).map(o => `${t}: ${o.path}`));
    const named = Object.values(cov.calls).reduce((n, l) => n + l.length, 0);
    check(`all ${named} offers name a writer the app has`, !dead.length && named > 20, dead.join('; '));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. The banner\'s ⤓ Export\n');
    const btn = await page.evaluate(() => {
      const b = document.getElementById('btn-export');
      return b && { text: b.textContent.trim(), title: b.title, shown: b.offsetParent !== null };
    });
    check('⤓ Export is in the banner, saying what it does', btn && btn.shown && /Export/.test(btn.text) && /what this tab shows/.test(btn.title), J(btn));
    await page.click('#btn-export');
    let M = await menu(page);
    check('on Stations it opens the tab\'s offers, named for the tab, the first ready one focused',
      M && M.title === 'Export — Stations' && M.offers.length >= 6 && M.focus, J(M && { title: M.title, n: M.offers.length, focus: M.focus }));
    await page.keyboard.press('Escape');
    await page.evaluate(() => switchTab('bitflipper'));
    await page.click('#btn-export');
    M = await menu(page);
    check('on an exempt tab it says why there is nothing to save', M && M.offers.length === 0 && /calculator/.test(M.none), J(M));
    await page.keyboard.press('Escape');
    await page.evaluate(() => switchTab('stations'));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. Offers that cannot run, and writers with nothing to write\n');
    await page.evaluate(() => { Auth.isSignedIn = () => false; });
    await page.click('#btn-export');
    M = await menu(page);
    const listOff = M.offers.filter(o => o.label.startsWith('The station list'));
    check('signed out, the station list is offered and says why it cannot be had — the Export tab\'s rule',
      listOff.length === 3 && listOff.every(o => o.off && /Sign in first/.test(o.sub)), J(listOff));
    const sel = M.offers.find(o => o.label.startsWith('The selection'));
    check('…and the selection, with nothing selected, says so', sel && sel.off && /Nothing is selected/.test(sel.sub), J(sel));
    const [noFile] = await Promise.all([
      page.waitForEvent('download', { timeout: 1_500 }).then(() => true, () => false),
      // force: Playwright will not press an aria-disabled button, and a person can.
      page.click('#exm .exm-opt[data-exm="0"]', { force: true }),
    ]);
    const why = await page.evaluate(() => (document.querySelector('#toasts .toast-text') || {}).textContent || '');
    check('pressed anyway, it writes nothing and says why — the dialog stays', !noFile && /Sign in first/.test(why)
      && await page.evaluate(() => !!document.getElementById('exm')), J({ noFile, why }));
    await page.keyboard.press('Escape');
    await page.evaluate(() => Toast.clear());
    // A writer that finds nothing: no polar plot is drawn.
    await page.click('#btn-export');
    const pi = await page.evaluate(() => [...document.querySelectorAll('#exm .exm-opt')].findIndex(b => /polar/.test(b.textContent)));
    await page.click(`#exm .exm-opt[data-exm="${pi}"]`);
    const said = await page.waitForFunction(() => {
      const t = document.querySelector('#toasts .toast-text');
      return t && /no polar plot/.test(t.textContent) ? t.textContent : null;
    }, null, { timeout: 5_000 }).then(h => h.jsonValue(), () => null);
    check('an offer whose writer finds nothing to write says what to do first', !!said, String(said));
    await page.evaluate(() => Toast.clear());

    // ═══════════════════════════════════════════════════════════════════════
    log('\n4. The Stations tab\n');
    await page.evaluate(() => { Auth.isSignedIn = () => true; });
    const want = await page.evaluate(() => {
      const rows = filteredStations();
      return { n: rows.length, located: rows.filter(s => s.lat != null && s.lon != null).length, all: state.data.stations.length };
    });
    let F = await take(page, 'The station list — CSV');
    const csvRows = F.body ? F.body.trim().split('\n').length - 1 : -1;
    check('signed in: the station list as CSV, one row a station the filters leave, named floodnet-stations-…',
      /^floodnet-stations-\d{4}-\d{2}-\d{2}\.csv$/.test(F.name || '') && csvRows === want.n
        && /^id,name,station_number,roles,networks,alert_ids,lat,lon,elevation_ahd,elevation_source,enabled/.test(F.body), J({ name: F.name, csvRows, want, error: F.error }));
    // Narrowed by a filter, and as GeoJSON. Repeaters and bases: every
    // repeater in stations.json has a position and two of the bases (the
    // workshop rigs) have none, so the filtered list holds stations a map
    // file has to leave out — a fixture of only located stations would pass
    // a writer that put the rest at [0, 0].
    await page.evaluate(() => { state.filters.roles = new Set(['repeater', 'base']); renderMain(); });
    await page.waitForTimeout(300);
    const wantR = await page.evaluate(() => {
      const rows = filteredStations();
      return { ids: rows.filter(s => s.lat != null && s.lon != null).map(s => s.id).sort(), n: rows.length };
    });
    check('the filtered list holds stations with no position, for the map files to leave out', wantR.n - wantR.ids.length >= 1,
      J({ n: wantR.n, located: wantR.ids.length }));
    F = await take(page, 'The station list — GeoJSON');
    let gj = null;
    try { gj = JSON.parse(F.body); } catch (_) {}
    const gotIds = gj ? gj.features.map(f => f.properties.id).sort() : [];
    const pt = gj && gj.features.find(f => (f.properties.roles || []).includes('repeater'));
    check('filtered, the GeoJSON is a FeatureCollection of exactly the stations left that have a place, named -filtered-',
      /^floodnet-stations-filtered-\d{4}-\d{2}-\d{2}\.geojson$/.test(F.name || '') && gj && gj.type === 'FeatureCollection'
        && J(gotIds) === J(wantR.ids) && wantR.n < want.all, J({ name: F.name, got: gotIds.length, want: wantR.ids.length, error: F.error }));
    const lostSaid = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast-text')].map(t => t.textContent).join(' | '));
    check('…and the note says how many were left out, and where they are',
      new RegExp(`${wantR.n - wantR.ids.length} with no position are in the CSV only`).test(lostSaid), lostSaid);
    await page.evaluate(() => Toast.clear());
    check('…each a point at [lon, lat], its roles and ALERT ids with it', pt && pt.geometry.type === 'Point'
      && Math.abs(pt.geometry.coordinates[0]) > 100 && Math.abs(pt.geometry.coordinates[1]) < 50
      && Array.isArray(pt.properties.roles) && pt.properties.roles.includes('repeater') && Array.isArray(pt.properties.alert_ids), J(pt));
    F = await take(page, 'The station list — KML');
    const marks = F.body ? (F.body.match(/<Placemark>/g) || []).length : 0;
    check('…and as KML for Google Earth: a placemark each, in a document that says Flood-Net',
      /\.kml$/.test(F.name || '') && marks === wantR.ids.length && /<name>[^<]* — Flood-Net<\/name>/.test(F.body), J({ name: F.name, marks, error: F.error }));
    await page.evaluate(() => { state.filters.roles = new Set(); renderMain(); });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const ids = state.data.stations.filter(s => s.lat != null).slice(0, 3).map(s => s.id);
      ids.forEach(id => state.mapSelection.add(id));
    });
    F = await take(page, 'The selection — CSV');
    check('the selection, as its own button writes it', /^floodnet-selection-/.test(F.name || '') && F.body && F.body.trim().split('\n').length === 4,
      J({ name: F.name, error: F.error }));
    await page.evaluate(() => state.mapSelection.clear());

    // ═══════════════════════════════════════════════════════════════════════
    log('\n5. Other tabs, on their own demo data\n');
    await page.evaluate(async () => { switchTab('arrodata'); await new Promise(r => setTimeout(r, 60)); await ArroData.loadDemo(); });
    await page.waitForFunction(() => ArroData.ad.series.length > 0, null, { timeout: LOAD_TIMEOUT });
    F = await take(page, 'The series shown, filtered — CSV');
    check('ARRO Data: the series shown, filtered, as its own button writes it — and floodnet-…', /^floodnet-.*\.csv$/.test(F.name || '')
      && /Reading,Receive,Value/.test(F.body || ''), J({ name: F.name, error: F.error }));
    F = await take(page, 'The chart — SVG');
    check('…and the chart as SVG, a file whose own name was not floodnet-… before', /^floodnet-.*\.svg$/.test(F.name || '') && /<svg/.test(F.body || ''),
      J({ name: F.name, error: F.error }));

    await page.evaluate(async () => { switchTab('alert2'); await new Promise(r => setTimeout(r, 60)); Alert2.loadSample('ascii'); await new Promise(r => setTimeout(r, 200)); });
    F = await take(page, 'The readings decoded — CSV');
    check('ALERT2: a sample decoded, its readings as CSV — named floodnet-alert2-readings.csv now', F.name === 'floodnet-alert2-readings.csv'
      && (F.body || '').split('\n').length > 1, J({ name: F.name, error: F.error }));

    await page.evaluate(async () => { switchTab('hfem'); await new Promise(r => setTimeout(r, 60)); HfemTab.loadSample('spec'); await new Promise(r => setTimeout(r, 200)); });
    F = await take(page, 'The measurements decoded — CSV');
    check('HFEM: the spec\'s examples decoded, as CSV', F.name === 'floodnet-hfem-measurements.csv' && (F.body || '').split('\n').length > 5,
      J({ name: F.name, error: F.error }));

    await page.evaluate(async () => { switchTab('reception'); await new Promise(r => setTimeout(r, 60)); Reception.loadDemo(); await new Promise(r => setTimeout(r, 300)); });
    F = await take(page, 'The receptions — GeoJSON');
    let rx = null;
    try { rx = JSON.parse(F.body); } catch (_) {}
    check('Reception: the demo drive as GeoJSON', /^floodnet-receptions-.*\.geojson$/.test(F.name || '') && rx && rx.features && rx.features.length > 10,
      J({ name: F.name, n: rx && rx.features && rx.features.length, error: F.error }));

    await page.evaluate(async () => {
      switchTab('health');
      await new Promise(r => setTimeout(r, 60));
      if (!(Health.state().A && Health.state().demo)) Health.demo();
      for (let i = 0; i < 200 && !(Health.state().A && document.querySelector('.hl-ftable')); i++) await new Promise(r => setTimeout(r, 25));
    });
    F = await take(page, 'The findings — CSV');
    check('Station Health: the demo week\'s findings, as CSV', /^floodnet-station-health.*\.csv$/.test(F.name || '') && (F.body || '').split('\n').length > 3,
      J({ name: F.name, error: F.error }));
    F = await take(page, 'Check times — CSV');
    check('Station Health: every station\'s check time and the move suggested, as CSV', /^floodnet-check-times-.*\.csv$/.test(F.name || '')
      && (F.body || '').split('\n').length > 10 && /\d\d:\d\d:\d\d, then every 3 h/.test(F.body || ''), J({ name: F.name, error: F.error }));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n6. Every file floodnet-…\n');
    const names = await page.evaluate(() => [floodnetName('stations.json'), floodnetName('floodnet-x.csv'), floodnetName('floodnet_field.csv'), floodnetName('')]);
    check('a name is made floodnet-… once, and one that already says so is left alone',
      J(names) === J(['floodnet-stations.json', 'floodnet-x.csv', 'floodnet_field.csv', 'floodnet-export']), J(names));

    check('no native dialog, and nothing threw', !natives.length && !errors.length, J({ natives, errors: errors.slice(0, 3) }));
    await context.close();
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
  log('\nPASS — every tab says what it can save of what it shows, from the writers its\n'
    + '       own buttons call, and every file is named floodnet-….');
}

main().catch(err => { console.error(err); process.exit(1); });
