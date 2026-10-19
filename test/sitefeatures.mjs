// A station's site features (0061, site-features.js), driven in a real browser.
//
//   1. The kinds the panel offers are the kinds 0061 and 0067 seed — read out of the
//      migration (lib/migration.mjs), not copied, so a kind added there and
//      not here fails here.
//   2. Signed out there is nothing: no pill, no card section, not a request.
//   3. Signed in, the card lists what the database holds, and its 📌 pill
//      arms the mode — which takes the map from Draw & measure, puts the card
//      away and brings the site into view beside the panel, not under it.
//   4. A pit placed with a click and saved: what is sent, to seven places,
//      and that pressing the panel's own buttons is never a click on the map
//      (a repaint takes the button off the page mid-press, and Leaflet then
//      reads the press as one on the ground — map-move-pin.js met it first).
//   5. An orifice run clicked out from the station through the pit: a click
//      near the pin or a point lands on it exactly, Backspace takes a point
//      back, a double-click finishes without a stray point, Enter finishes
//      too, and Escape puts down a half-drawn line only after asking.
//   6. A point dragged, a ＋ clicked, and a save refused as stale — what was
//      drawn kept, and Reload opening the database's version.
//   7. A line from typed coordinates (one pasted longitude first), a point
//      typed, a GPS fix with its ±, a fix too coarse to use, and an "other"
//      with no name stopped before it is sent.
//   8. Delete, behind a question.
//   9. The GeoJSON download: the station, its features, and nobody's address.
//  10. Outside the mode: a feature's popup and its way in, a card row that
//      shows its feature, the Map display switch, and Move pin — refused over
//      a half-drawn feature, taking the map once nothing is.
//  11. Signing out ends the mode; a database without 0061 says so.
//  12. A phone: the panel folds itself, taps land, and the twin's offer waits.
//
// The datastore is a stand-in (page.route over the PostgREST URLs): it keeps
// the rows, stamps each save and refuses a stale one with 409, as
// save_station_feature() does. What the database itself refuses —
// geometry, kinds, distances, who may — is tools/check_station_features.sql's.
//
// Run:  npm run sitefeatures        (from test/)
//       npm run sitefeatures -- -v

import fs from 'node:fs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { seedRows } from './lib/migration.mjs';
import { repo } from './lib/paths.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

const log = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (ok && detail) vlog(`      ${detail}`);
}
const J = v => JSON.stringify(v);

const STN = 'abercorn_al';          // a field station on its own, with a pin
const OTHER = 'abbieglassie_al';    // another, far away
// 0061's kinds and the access track 0067 adds, in the vocabulary's order.
const SQL = fs.readFileSync(repo('db', 'migrations', '0061_station_features.sql'), 'utf8');
const KINDS = [...seedRows(SQL, 'station_feature_kind'),
               ...seedRows(fs.readFileSync(repo('db', 'migrations', '0067_access_tracks.sql'), 'utf8'), 'station_feature_kind')]
  .sort((a, b) => a.ord - b.ord);

const decimals = n => (String(n).split('.')[1] || '').length;

// ── The stand-in ─────────────────────────────────────────────────────────────

function fakeDatabase() {
  const db = { rows: [], requests: [], saves: [], deletes: [], missing: false, n: 0 };
  db.stamp = () => new Date(Date.UTC(2026, 9, 12, 2, 0, 0) + (++db.n) * 1000).toISOString();
  db.seed = (row) => {
    const at = db.stamp();
    const r = { id: `00000000-0000-4000-8000-${String(++db.n).padStart(12, '0')}`, note: '', name: '', placed: 'map',
                accuracy_m: null, created_by: 'someone@example.test', created_at: at, updated_by: 'someone@example.test',
                updated_at: at, ...row };
    db.rows.push(r);
    return r;
  };
  db.install = page => page.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: J(body) });
    db.requests.push({ method: req.method(), name, url: req.url() });
    const gone = what => json(404, { code: 'PGRST205', message: `Could not find the table 'meganet.${what}' in the schema cache` });
    if (req.method() === 'GET' && name === 'station_feature_kind') {
      return db.missing ? gone('station_feature_kind') : json(200, KINDS);
    }
    if (req.method() === 'GET' && name === 'station_feature') {
      if (db.missing) return gone('station_feature');
      const ids = (url.searchParams.get('station_id') || '').replace(/^in\.\(|\)$/g, '').split(',')
        .map(s => s.replace(/^"|"$/g, ''));
      return json(200, db.rows.filter(r => ids.includes(r.station_id)));
    }
    if (req.method() === 'POST' && name === 'rpc/save_station_feature') {
      if (db.missing) return json(404, { code: 'PGRST202', message: 'Could not find the function meganet.save_station_feature(p_expected, p_feature) in the schema cache' });
      const body = JSON.parse(req.postData() || '{}');
      db.saves.push(body);
      const f = body.p_feature || {};
      if (f.id) {
        const r = db.rows.find(x => x.id === f.id);
        if (!r) return json(409, { code: 'PT409', message: 'that site feature is not in the database any more — it was deleted while you had it open' });
        if (r.updated_at !== body.p_expected) {
          return json(409, { code: 'PT409', message: `that site feature was changed at ${r.updated_at}, after you opened it` });
        }
        Object.assign(r, f, { updated_at: db.stamp(), updated_by: 'editor@example.test' });
        return json(200, r);
      }
      return json(200, db.seed({ ...f, created_by: 'editor@example.test', updated_by: 'editor@example.test' }));
    }
    if (req.method() === 'POST' && name === 'rpc/delete_station_feature') {
      const body = JSON.parse(req.postData() || '{}');
      db.deletes.push(body);
      const i = db.rows.findIndex(x => x.id === body.p_id);
      if (i < 0) return json(400, { code: '22023', message: `there is no site feature ${body.p_id}` });
      if (db.rows[i].updated_at !== body.p_expected) return json(409, { code: 'PT409', message: 'stale' });
      db.rows.splice(i, 1);
      return json(200, { id: body.p_id, deleted_at: db.stamp() });
    }
    return json(200, []);
  });
  return db;
}

// ── The page ─────────────────────────────────────────────────────────────────

async function openStations(browser, server, errors, contextOpts, db) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  if (db) await db.install(page);
  page.on('pageerror', e => errors.push(String(e.stack || e)));
  page.on('dialog', async d => { errors.push(`dialog: ${d.message()}`); await d.dismiss().catch(() => {}); });
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  return { context, page };
}

const settle = page => page.waitForFunction(() => !state.map._animatingZoom
  && !(state.map._panAnim && state.map._panAnim._inProgress), null, { timeout: 10_000 });

const signIn = page => page.evaluate(() => {
  dbSetAccessToken('test-token');
  Auth.isSignedIn = () => true;
  Auth.mayWrite = () => true;
  Auth.role = () => 'editor';
  SiteFeatures.authChanged();
  repaintStnCard();
});

const signOut = page => page.evaluate(() => {
  dbSetAccessToken(null);
  Auth.isSignedIn = () => false;
  Auth.mayWrite = () => false;
  Auth.role = () => null;
  SiteFeatures.authChanged();
  repaintStnCard();
});

// A point on the map as page pixels.
const at = (page, ll) => page.evaluate(([lat, lon]) => {
  const r = document.getElementById('leaflet-map').getBoundingClientRect();
  const p = state.map.latLngToContainerPoint([lat, lon]);
  return { x: r.x + p.x, y: r.y + p.y };
}, ll);
const pinOf = page => page.evaluate(id => {
  const s = state.data.stations.find(x => x.id === id);
  return [+s.lat, +s.lon];
}, STN);
const session = page => page.evaluate(() => SiteFeatures._session());
const draft = async page => { const s = await session(page); return s && s.draft; };
const lastSave = db => db.saves[db.saves.length - 1];

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];

  try {
    // ── 1. The vocabulary ──────────────────────────────────────────────────
    log('\nThe kinds offered are the kinds 0061 and 0067 seed\n');
    const db = fakeDatabase();
    const outlet = db.seed({ station_id: STN, kind: 'orifice_outlet', name: 'Outlet',
                             geom: { type: 'Point', coordinates: [151.13105, -25.12975] } });
    db.seed({ station_id: OTHER, kind: 'benchmark', name: 'BM far',
              geom: { type: 'Point', coordinates: [147.4840, -27.2920] } });
    const { page } = await openStations(browser, server, errors, { viewport: { width: 1440, height: 900 } }, db);

    const app = await page.evaluate(() => SITE_FEATURE_KINDS.map(k =>
      ({ key: k.key, label: k.label, geometry: k.geometry, needs_name: k.needs_name, ord: k.ord, note: k.note })));
    check('every kind the migration seeds, word for word, in its order',
      J(app) === J(KINDS.map(k => ({ key: k.key, label: k.label, geometry: k.geometry, needs_name: k.needs_name, ord: k.ord, note: k.note }))),
      `${J(app)}\n      ${J(KINDS)}`);
    check('…the four the owner named as points, the orifice run as a line',
      ['orifice_outlet', 'pit', 'benchmark', 'gauge_board'].every(k => (KINDS.find(x => x.key === k) || {}).geometry === 'Point')
      && (KINDS.find(x => x.key === 'orifice_run') || {}).geometry === 'LineString');

    // ── 2. Signed out ──────────────────────────────────────────────────────
    log('\nSigned out there is nothing to see\n');
    const pin = await pinOf(page);
    await page.evaluate(([lat, lon]) => state.map.setView([lat, lon], 17, { animate: false }), pin);
    await page.evaluate(id => showStationCard(id), STN);
    await page.waitForTimeout(600);
    const out = await page.evaluate(() => ({
      pill: !!document.querySelector('#stn-card .mn-sitefeat-pill'),
      section: !!document.querySelector('#stn-card .stn-card-sitefeat'),
      note: SiteFeatures._note().kind,
      markers: document.querySelectorAll('.leaflet-mnSiteFeat-pane .mn-sf-pt').length,
    }));
    check('no 📌 pill and no Site features section on the card', !out.pill && !out.section, J(out));
    check('…nothing drawn, and the Map display note says why', out.markers === 0 && out.note === 'signed-out', J(out));
    check('…and nothing asked of the database', !db.requests.some(r => r.name.startsWith('station_feature')),
      J(db.requests.map(r => r.name)));

    // ── 3. Signed in ───────────────────────────────────────────────────────
    log('\nSigned in, the card lists them and the pill arms the mode\n');
    await signIn(page);
    await page.waitForFunction(() => !!document.querySelector('#stn-card .stn-card-sitefeat .acma-row'), null, { timeout: 10_000 });
    const card = await page.evaluate(() => ({
      text: document.querySelector('#stn-card .stn-card-sitefeat').innerText,
      pill: (document.querySelector('#stn-card .mn-sitefeat-pill') || {}).textContent || '',
    }));
    check('the card lists the station’s features, and not another station’s',
      /Orifice outlet/.test(card.text) && /Outlet/.test(card.text) && !/BM far/.test(card.text), card.text);
    check('…and offers 📌 Site features beside Move pin', /Site features/.test(card.pill), card.pill);
    await page.waitForFunction(() => document.querySelectorAll('.leaflet-mnSiteFeat-pane .mn-sf-pt').length >= 1,
      null, { timeout: 10_000 });
    check('…and the map draws its outlet at zoom 17', (await page.evaluate(() =>
      document.querySelectorAll('.leaflet-mnSiteFeat-pane .mn-sf-pt').length)) === 1);

    await page.evaluate(() => MapDraw.setTool('line'));
    await page.click('#stn-card .mn-sitefeat-pill');
    await page.waitForSelector('.mn-sf-panel', { timeout: 10_000 });
    await settle(page);
    const armed = await page.evaluate(id => {
      const panel = document.querySelector('.mn-sf-panel').getBoundingClientRect();
      const r = document.getElementById('leaflet-map').getBoundingClientRect();
      const s = state.data.stations.find(x => x.id === id);
      const p = state.map.latLngToContainerPoint([s.lat, s.lon]);
      return { armed: SiteFeatures.armed(), tool: state.draw.tool, card: document.getElementById('stn-card').hidden,
               zoom: state.map.getZoom(), pinX: r.x + p.x, panelRight: panel.right,
               rows: document.querySelectorAll('.mn-sf-list .mn-sf-row').length };
    }, STN);
    check('the pill arms the mode on the station, and Draw & measure lets go of the map',
      armed.armed === STN && armed.tool === '', J(armed));
    check('…the card gives way to it, as it does to Move pin', armed.card === true, J(armed));
    check('…the site is close, and beside the panel rather than under it',
      armed.zoom >= 17 && armed.pinX > armed.panelRight, J(armed));
    check('…and the panel lists what is mapped', armed.rows === 1, J(armed));

    // ── 4. A pit ───────────────────────────────────────────────────────────
    log('\nA pit, placed with a click\n');
    await page.selectOption('#mn-sf-kind', 'pit');
    await page.click('#mn-sf-add');
    await page.waitForTimeout(200);
    let d = await draft(page);
    check('pressing "Put it on the map" places nothing — the press is the panel’s, not the ground’s',
      d && d.kind === 'pit' && d.pts.length === 0, J(d));
    check('…and the map takes every click while a point is placed',
      await page.evaluate(() => state.map.getContainer().classList.contains('mn-sf-placing')));
    const p0 = await at(page, pin);
    await page.mouse.click(p0.x + 60, p0.y + 40);
    await page.waitForTimeout(150);
    d = await draft(page);
    const boxes = await page.evaluate(() => [document.getElementById('mn-sf-lat').value, document.getElementById('mn-sf-lon').value]);
    check('a click places it, and the two boxes read where',
      d.pts.length === 1 && d.src[0] === 'map' && Number(boxes[0]) === d.pts[0][0] && Number(boxes[1]) === d.pts[0][1],
      `${J(d.pts)} ${J(boxes)}`);
    await page.fill('#mn-sf-name', 'Pit 2');
    await page.click('#mn-sf-save');
    await page.waitForFunction(() => !SiteFeatures._session().draft, null, { timeout: 10_000 });
    let s = lastSave(db);
    const pitGeom = s && s.p_feature.geom;
    check('Save sends the station, the kind, the name, a GeoJSON point (longitude first) and how it was placed',
      s && s.p_feature.station_id === STN && s.p_feature.kind === 'pit' && s.p_feature.name === 'Pit 2'
      && pitGeom.type === 'Point' && pitGeom.coordinates[0] > 150 && pitGeom.coordinates[1] < 0
      && s.p_feature.placed === 'map' && s.p_feature.accuracy_m === null && s.p_expected === null && !s.p_feature.id,
      J(s));
    check('…to seven places at most', pitGeom.coordinates.every(c => decimals(c) <= 7), J(pitGeom));
    const listed = await page.evaluate(() => ({
      rows: document.querySelectorAll('.mn-sf-list .mn-sf-row').length,
      msg: (document.getElementById('mn-sf-msg') || {}).textContent || '',
      cls: [...state.map.getContainer().classList].filter(c => c.startsWith('mn-sf')),
    }));
    check('…and it is listed, said, and the map is the map again',
      listed.rows === 2 && /Saved: Inspection pit — Pit 2/.test(listed.msg) && !listed.cls.length, J(listed));
    const pit = db.rows.find(r => r.kind === 'pit');
    const pitLL = [pit.geom.coordinates[1], pit.geom.coordinates[0]];

    // ── 5. An orifice run ──────────────────────────────────────────────────
    log('\nAn orifice run, from the station through the pit\n');
    await page.selectOption('#mn-sf-kind', 'orifice_run');
    await page.click('#mn-sf-add');
    await page.waitForTimeout(200);
    d = await draft(page);
    const drawingOn = await page.evaluate(() => ({ cls: state.map.getContainer().classList.contains('mn-sf-drawing'),
                                                   dbl: state.map.doubleClickZoom.enabled() }));
    check('a new run is drawn from nothing: the press is not its first point',
      d && d.drawing && d.pts.length === 0, J(d));
    check('…with every click the map’s, and the double-click the line’s rather than a zoom',
      drawingOn.cls && !drawingOn.dbl, J(drawingOn));
    let q = await at(page, pin);
    await page.mouse.click(q.x + 6, q.y + 5);
    await page.waitForTimeout(120);
    q = await at(page, pitLL);
    await page.mouse.click(q.x - 4, q.y + 6);
    await page.waitForTimeout(120);
    await page.mouse.click(q.x + 50, q.y + 60);
    await page.waitForTimeout(120);
    d = await draft(page);
    check('a click beside the pin lands on the station exactly', J(d.pts[0]) === J(pin), `${J(d.pts[0])} vs ${J(pin)}`);
    check('…and one beside the pit on the pit exactly', J(d.pts[1]) === J(pitLL), `${J(d.pts[1])} vs ${J(pitLL)}`);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
    d = await draft(page);
    check('Backspace takes the last point back', d.pts.length === 2, J(d.pts));
    // The site stands beside the panel, so what is drawn keeps to the map's
    // right half: down and back, never off the map's edge.
    await page.mouse.click(q.x + 40, q.y + 80);
    await page.waitForTimeout(120);
    await page.mouse.dblclick(q.x + 10, q.y + 170);
    await page.waitForTimeout(250);
    d = await draft(page);
    check('a double-click puts its point down once and finishes the line',
      !d.drawing && d.pts.length === 4, J(d.pts));
    const handles = await page.evaluate(() => ({ v: document.querySelectorAll('.mn-sf-handle').length,
                                                 m: document.querySelectorAll('.mn-sf-mid').length }));
    check('…and its points are handles now, with a ＋ on each stretch', handles.v === 4 && handles.m === 3, J(handles));
    await page.click('#mn-sf-save');
    await page.waitForFunction(() => !SiteFeatures._session().draft, null, { timeout: 10_000 });
    s = lastSave(db);
    check('Save sends a GeoJSON line from the station through the pit',
      s.p_feature.kind === 'orifice_run' && s.p_feature.geom.type === 'LineString'
      && s.p_feature.geom.coordinates.length === 4
      && J(s.p_feature.geom.coordinates[0]) === J([pin[1], pin[0]])
      && J(s.p_feature.geom.coordinates[1]) === J(pit.geom.coordinates)
      && s.p_feature.placed === 'map', J(s.p_feature));

    // Enter finishes; Escape asks before a half-drawn line goes.
    await page.selectOption('#mn-sf-kind', 'cable_run');
    await page.click('#mn-sf-add');
    await page.waitForTimeout(150);
    q = await at(page, pin);
    await page.mouse.click(q.x - 50, q.y + 120);
    await page.waitForTimeout(100);
    await page.mouse.click(q.x - 30, q.y + 220);
    await page.waitForTimeout(100);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    d = await draft(page);
    check('Enter finishes a line too', d && !d.drawing && d.pts.length === 2, J(d && d.pts));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#app-ask [data-ask="no"]', { timeout: 5000 });
    await page.click('#app-ask [data-ask="no"]');
    await page.waitForTimeout(150);
    check('Escape over an unsaved line asks first, and "Keep it" keeps it', !!(await draft(page)));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#app-ask [data-ask="yes"]', { timeout: 5000 });
    await page.click('#app-ask [data-ask="yes"]');
    await page.waitForTimeout(150);
    check('…and "Throw it away" does', !(await draft(page)) && !!(await session(page)));

    // ── 6. Changing one ────────────────────────────────────────────────────
    log('\nA run changed, and a stale save refused\n');
    const run = db.rows.find(r => r.kind === 'orifice_run');
    await page.click(`#mn-sf-edit-${run.id}`);
    await page.waitForTimeout(300);
    d = await draft(page);
    check('Edit opens it with the stamp it was read with', d && d.id === run.id && d.stamp === run.updated_at, J(d));
    const end = await at(page, d.pts[3]);
    await page.mouse.move(end.x, end.y);
    await page.mouse.down();
    await page.mouse.move(end.x + 25, end.y + 15, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const dragged = await draft(page);
    check('a point drags, and is then a point placed on the map',
      J(dragged.pts[3]) !== J(d.pts[3]) && dragged.src[3] === 'map' && dragged.dirty, J(dragged.pts));
    await page.evaluate(() => { const m = document.querySelector('.mn-sf-mid'); m && m.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await page.waitForTimeout(200);
    check('a ＋ clicked is a point there', (await draft(page)).pts.length === 5, J((await draft(page)).pts));
    run.updated_at = '2026-10-12T09:09:09.000Z';           // somebody else got there first
    await page.click('#mn-sf-save');
    await page.waitForFunction(() => { const m = SiteFeatures._session().msg; return m && m.kind === 'conflict'; },
      null, { timeout: 10_000 });
    const refused = await page.evaluate(() => ({ s: SiteFeatures._session(), reload: !!document.getElementById('mn-sf-reload') }));
    check('a save read before somebody else’s is refused, in words, with Reload',
      /changed at/.test(refused.s.msg.text) && refused.reload, J(refused.s.msg));
    check('…and what was drawn is still on screen', refused.s.draft && refused.s.draft.pts.length === 5 && refused.s.draft.dirty);
    await page.click('#mn-sf-reload');
    await page.waitForFunction(() => { const s = SiteFeatures._session(); return s.draft && !s.draft.dirty; }, null, { timeout: 10_000 });
    d = await draft(page);
    check('Reload opens the database’s version to make the change again on',
      d.id === run.id && d.stamp === '2026-10-12T09:09:09.000Z' && d.pts.length === 4, J(d));
    await page.click('#mn-sf-cancel');
    await page.waitForTimeout(150);

    // ── 7. Typed, GPS, and a name ──────────────────────────────────────────
    log('\nTyped points, a GPS fix, and a name an "other" needs\n');
    await page.selectOption('#mn-sf-kind', 'other_line');
    await page.click('#mn-sf-add');
    await page.waitForTimeout(150);
    await page.click('.mn-sf-pts > summary');
    await page.fill('#mn-sf-ptstext', '-25.1290000, 151.1300000\n151.1302, -25.1291\n25°07\'45.0"S 151°07\'49.0"E');
    await page.click('#mn-sf-apply');
    await page.waitForTimeout(150);
    d = await draft(page);
    check('a line from typed coordinates — one longitude first, one in degrees and minutes',
      d.pts.length === 3 && !d.drawing && J(d.pts[1]) === J([-25.1291, 151.1302])
      && Math.abs(d.pts[2][0] + 25.129167) < 1e-5 && d.src.every(x => x === 'typed'), J(d.pts));
    await page.click('#mn-sf-save');
    await page.waitForTimeout(200);
    const named = await page.evaluate(() => SiteFeatures._session());
    check('an "other line" with no name is stopped before it is sent',
      named.draft && /needs a name/.test(named.msg.text) && lastSave(db).p_feature.kind !== 'other_line', J(named.msg));
    await page.fill('#mn-sf-name', 'Fence');
    await page.click('#mn-sf-save');
    await page.waitForFunction(() => !SiteFeatures._session().draft, null, { timeout: 10_000 });
    check('…and named, goes, placed as typed', lastSave(db).p_feature.placed === 'typed' && lastSave(db).p_feature.name === 'Fence',
      J(lastSave(db).p_feature));

    await page.selectOption('#mn-sf-kind', 'benchmark');
    await page.click('#mn-sf-add');
    await page.waitForTimeout(150);
    await page.fill('#mn-sf-lat', '-25.1290');
    await page.fill('#mn-sf-lon', '151.1301');
    await page.press('#mn-sf-lon', 'Tab');
    await page.waitForTimeout(100);
    d = await draft(page);
    check('a point typed into its two boxes', d.pts.length === 1 && J(d.pts[0]) === J([-25.129, 151.1301]) && d.src[0] === 'typed', J(d));
    await page.fill('#mn-sf-name', 'BM1');
    await page.click('#mn-sf-save');
    await page.waitForFunction(() => !SiteFeatures._session().draft, null, { timeout: 10_000 });

    await page.evaluate(() => {
      window.__fix = { latitude: -25.12905, longitude: 151.13075, accuracy: 3.2 };
      navigator.geolocation.getCurrentPosition = ok => setTimeout(() => ok({ coords: { ...window.__fix } }), 10);
    });
    await page.selectOption('#mn-sf-kind', 'gauge_board');
    await page.click('#mn-sf-add');
    await page.waitForTimeout(150);
    await page.evaluate(() => { window.__fix = { latitude: -25.1291, longitude: 151.1308, accuracy: 250 }; });
    await page.click('#mn-sf-gps');
    await page.waitForTimeout(200);
    const coarse = await page.evaluate(() => SiteFeatures._session());
    check('a fix good only to ±250 m places nothing, and says so',
      coarse.draft.pts.length === 0 && /too coarse/.test(coarse.msg.text), J(coarse.msg));
    await page.evaluate(() => { window.__fix = { latitude: -25.12905, longitude: 151.13075, accuracy: 3.2 }; });
    await page.click('#mn-sf-gps');
    await page.waitForTimeout(200);
    await page.click('#mn-sf-save');
    await page.waitForFunction(() => !SiteFeatures._session().draft, null, { timeout: 10_000 });
    s = lastSave(db);
    check('a GPS fix is the point, placed by GPS with its ±',
      s.p_feature.kind === 'gauge_board' && s.p_feature.placed === 'gps' && s.p_feature.accuracy_m === 3.2
      && J(s.p_feature.geom.coordinates) === J([151.13075, -25.12905]), J(s.p_feature));

    // ── 8. Delete ──────────────────────────────────────────────────────────
    log('\nDelete, behind a question\n');
    await page.click(`#mn-sf-edit-${pit.id}`);
    await page.waitForTimeout(200);
    await page.click('#mn-sf-delete');
    await page.waitForSelector('#app-ask [data-ask="yes"]', { timeout: 5000 });
    const asked = await page.evaluate(() => document.getElementById('app-ask-title').textContent);
    await page.click('#app-ask [data-ask="yes"]');
    await page.waitForFunction(() => !SiteFeatures._session().draft, null, { timeout: 10_000 });
    const del = db.deletes[db.deletes.length - 1];
    check('Delete asks first, then sends the feature with its stamp',
      /Delete this inspection pit/.test(asked) && del && del.p_id === pit.id && !!del.p_expected, `${asked} ${J(del)}`);
    check('…and it leaves the list', !(await page.evaluate(id => !!document.getElementById(`mn-sf-edit-${id}`), pit.id)));

    // ── 9. GeoJSON ─────────────────────────────────────────────────────────
    log('\nThe GeoJSON download\n');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), page.click('#mn-sf-dl')]);
    const file = dl.suggestedFilename();
    const gj = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    const live = db.rows.filter(r => r.station_id === STN);
    check('named floodnet-site-features-<station>.geojson', file === 'floodnet-site-features-abercorn_al.geojson', file);
    check('a FeatureCollection: the station first, then each of its features as GeoJSON',
      gj.type === 'FeatureCollection' && gj.features[0].properties.kind === 'station'
      && J(gj.features[0].geometry.coordinates) === J([pin[1], pin[0]])
      && gj.features.length === live.length + 1
      && live.every(r => gj.features.some(f => f.id === r.id && J(f.geometry) === J(r.geom))), J(gj).slice(0, 300));
    check('…and nobody’s address in it', !/@example\.test/.test(J(gj)));

    // ── 10. Outside the mode ───────────────────────────────────────────────
    log('\nOutside the mode\n');
    await page.click('#mn-sf-done');
    await page.waitForTimeout(200);
    const done = await page.evaluate(() => ({ armed: SiteFeatures.armed(), panel: !!document.querySelector('.mn-sf-panel'),
                                              dbl: state.map.doubleClickZoom.enabled() }));
    check('Done closes the mode and gives the map back', !done.armed && !done.panel && done.dbl, J(done));
    await page.waitForFunction(() => document.querySelectorAll('.leaflet-mnSiteFeat-pane .mn-sf-pt').length >= 3, null, { timeout: 10_000 });
    await page.evaluate(id => {
      const m = [...document.querySelectorAll('.leaflet-mnSiteFeat-pane .mn-sf-pt')]
        .find(e => (e.getAttribute('title') || '').startsWith('Orifice outlet'));
      m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, STN);
    await page.waitForSelector('.mn-sf-pop', { timeout: 5000 });
    const pop = await page.evaluate(() => document.querySelector('.mn-sf-pop').innerText);
    check('a feature clicked says what it is, where and how it was placed', /Orifice outlet/.test(pop) && /from the pin/.test(pop) && /Placed on the map/.test(pop), pop);
    await page.click('.mn-sf-pop button');
    await page.waitForFunction(() => { const s = SiteFeatures._session(); return s && s.draft; }, null, { timeout: 10_000 });
    d = await draft(page);
    check('…and its Edit opens the mode on it', d.id === outlet.id, J(d));

    // Move pin over a half-moved point is refused; once nothing is, it takes the map.
    const p1 = await at(page, d.pts[0]);
    await page.mouse.click(p1.x + 30, p1.y + 30);
    await page.waitForTimeout(150);
    await page.evaluate(id => MapMovePin.start(id), STN);
    await page.waitForTimeout(150);
    const refusedPin = await page.evaluate(() => ({ pin: MapMovePin.armed(), sf: SiteFeatures.armed(),
                                                    note: (document.getElementById('map-note') || {}).textContent || '' }));
    check('Move pin will not take the map from a half-moved feature', !refusedPin.pin && !!refusedPin.sf && /Save or cancel/.test(refusedPin.note), J(refusedPin));
    // Not awaited inside the page: cancel() waits on the question, which is
    // answered from out here.
    await page.evaluate(() => { SiteFeatures.cancel(); });
    await page.waitForSelector('#app-ask [data-ask="yes"]', { timeout: 5000 });
    await page.click('#app-ask [data-ask="yes"]');
    await page.waitForTimeout(150);
    await page.evaluate(id => MapMovePin.start(id), STN);
    await page.waitForTimeout(150);
    const tookPin = await page.evaluate(() => ({ pin: MapMovePin.armed(), sf: SiteFeatures.armed() }));
    check('…and takes it once nothing is', tookPin.pin === 'abercorn_al' && !tookPin.sf, J(tookPin));
    await page.evaluate(() => MapMovePin.cancel());

    // A card row shows its feature; the Map display switch.
    await page.evaluate(id => showStationCard(id), STN);
    await page.waitForSelector('#stn-card .stn-card-sitefeat .link-btn', { timeout: 10_000 });
    await page.evaluate(() => state.map.setZoom(15, { animate: false }));
    await page.click('#stn-card .stn-card-sitefeat .link-btn');
    await settle(page);
    await page.waitForTimeout(400);
    const shown = await page.evaluate(() => ({ zoom: state.map.getZoom(),
      sel: document.querySelectorAll('.leaflet-mnSiteFeat-pane .mn-sf-pt.is-sel').length }));
    check('a row on the card zooms the map to its feature and rings it', shown.zoom >= 17 && shown.sel === 1, J(shown));
    await page.evaluate(() => SiteFeatures.setEnabled(false));
    await page.evaluate(() => state.map.fire('click', { latlng: state.map.getCenter() }));
    await page.waitForTimeout(400);
    const offState = await page.evaluate(() => ({ n: document.querySelectorAll('.leaflet-mnSiteFeat-pane .mn-sf-pt').length,
                                                  note: SiteFeatures._note().kind, stored: localStorage.getItem('mn-site-features') }));
    check('the Map display switch takes them off the map, and is remembered',
      offState.n === 0 && offState.note === 'off' && offState.stored === 'off', J(offState));
    await page.evaluate(() => SiteFeatures.setEnabled(true));
    await page.waitForFunction(() => document.querySelectorAll('.leaflet-mnSiteFeat-pane .mn-sf-pt').length >= 3, null, { timeout: 10_000 });
    check('…and back on, they are back', true);

    // ── 11. Signing out, and a database without 0061 ───────────────────────
    log('\nSigned out mid-mode, and a database that has not had 0061\n');
    await page.evaluate(id => SiteFeatures.start(id), STN);
    await page.waitForSelector('.mn-sf-panel', { timeout: 5000 });
    await signOut(page);
    await page.waitForTimeout(300);
    const signedOut = await page.evaluate(() => ({ armed: SiteFeatures.armed(), panel: !!document.querySelector('.mn-sf-panel'),
      n: document.querySelectorAll('.leaflet-mnSiteFeat-pane .mn-sf-pt').length }));
    check('signing out ends the mode and takes the features off the map',
      !signedOut.armed && !signedOut.panel && signedOut.n === 0, J(signedOut));

    const db2 = fakeDatabase();
    db2.missing = true;
    const second = await openStations(browser, server, errors, { viewport: { width: 1440, height: 900 } }, db2);
    await signIn(second.page);
    await second.page.evaluate(id => showStationCard(id), STN);
    await second.page.waitForFunction(() => /0061/.test((document.querySelector('#stn-card .stn-card-sitefeat') || {}).textContent || ''),
      null, { timeout: 10_000 });
    await second.page.evaluate(id => SiteFeatures.start(id), STN);
    await second.page.waitForSelector('.mn-sf-panel', { timeout: 5000 });
    await second.page.waitForTimeout(500);
    const nr = await second.page.evaluate(() => ({ panel: document.querySelector('.mn-sf-panel').innerText,
      add: document.getElementById('mn-sf-add').disabled, note: SiteFeatures._note().kind }));
    check('a database without 0061 says so on the card and in the panel, and offers nothing to add',
      /0061 is not applied/.test(nr.panel) && nr.add, J(nr));
    await second.context.close();

    // ── 12. A phone ─────────────────────────────────────────────────────────
    log('\nOn a phone\n');
    const db3 = fakeDatabase();
    const phone = await openStations(browser, server, errors,
      { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, db3);
    await signIn(phone.page);
    await phone.page.evaluate(id => SiteFeatures.start(id), STN);
    await phone.page.waitForSelector('.mn-sf-panel', { timeout: 5000 });
    await phone.page.evaluate(() => document.getElementById('leaflet-map').scrollIntoView());
    await settle(phone.page);
    await phone.page.evaluate(() => SiteFeatures.add('orifice_run'));
    await phone.page.waitForTimeout(300);
    const folded = await phone.page.evaluate(() => {
      const offer = document.getElementById('map-twin-offer');
      return { folded: SiteFeatures._session().folded, h: document.querySelector('.mn-sf-panel').getBoundingClientRect().height,
               offer: !!offer && !offer.hidden, zoom: state.map.getZoom() };
    });
    check('the panel folds itself to its head and its Save while a line is drawn', folded.folded && folded.h < 200, J(folded));
    check('…and the twin’s offer waits, at a zoom it would make one', !folded.offer && folded.zoom >= 17, J(folded));
    const tp = await at(phone.page, pin);
    await phone.page.touchscreen.tap(tp.x + 4, tp.y + 3);
    await phone.page.waitForTimeout(350);
    await phone.page.touchscreen.tap(tp.x + 50, tp.y + 70);
    await phone.page.waitForTimeout(350);
    d = await draft(phone.page);
    check('taps land: the first on the station, the second where it was', d.pts.length === 2 && J(d.pts[0]) === J(pin), J(d.pts));
    await phone.context.close();

    check('no page errors', errors.length === 0, errors.slice(0, 3).join('\n      '));
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n${failed.length ? 'FAIL' : 'PASS'} — ${results.length - failed.length} of ${results.length} checks.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
