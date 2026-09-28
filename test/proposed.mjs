// Proposed stations (0039) in the browser: where a station is meant to go,
// what kind it is to be and the year it is proposed for, before it is built or
// numbered — proposed from the station list or from a point on the map, saved
// by anybody who may edit, established only by an administrator, and shown for
// what it is everywhere it is named.
//
//   1. **Proposing** — + Propose beside + New opens a proposal: the band, this
//      year, the Proposed box ticked, "choose one" for the type, "none yet" for
//      the number, the cursor in the name. What is here on the map opens one at
//      its point. A proposal missing its type, its year or its place is not
//      sent, and says which; one that is complete is sent with the three keys
//      and no number, and a year dated back or forward is sent as typed.
//   2. **What it looks like** — its pin hollow in a dashed ring of its role's
//      colour, its card opening with a band that says it is not established,
//      its row and its callout tagged, the legend explaining the pin, the
//      trail listing it — and a station that is not proposed carrying none of
//      it, and none of the three keys through a save.
//   3. **Who may** — an editor's Proposed box is locked on a saved station,
//      with why; an administrator's is not, and unticking it establishes the
//      station: a solid pin, no band, the type and year kept. An editor adding
//      a station outright is told, before and after, that it is an
//      administrator's — not that they are off the editors list. And a
//      database without 0039 is not sent a proposal at all.
//
// The database is a stand-in for save_station() (the real one is held to the
// same rules by tools/check_proposed_stations.sql): it takes a proposal from
// anybody, a station outright or an establishment only from an administrator,
// and answers the way PostgREST does.
//
// Run:  npm run proposed
//       npm run proposed -- -v

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
const YEAR = new Date().getFullYear();

// The stand-in. `who.admin` is what is_admin() would say; every save is kept.
function fakeDatabase(who) {
  const db = { saves: [], stamps: new Map() };
  db.install = page => page.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: J(body) });
    if (req.method() === 'POST' && name === 'rpc/save_station') {
      const body = JSON.parse(req.postData() || '{}');
      const doc = body.p_doc || {};
      const stamp = body.p_expected_updated_at || null;
      db.saves.push({ doc, stamp });
      const was = db.stamps.get(doc.id);
      const isNew = !was;
      const proposed = doc.proposed === true;
      if (!who.admin && ((isNew && !proposed) || (!isNew && !!was.proposed !== proposed))) {
        return json(403, { code: '42501', details: 'administrator',
          message: 'only an administrator adds a station outright — save it as a proposed station, and an administrator establishes it',
          hint: 'tick Proposed, give it a type and a year, and save again' });
      }
      const at = new Date(Date.now() + db.saves.length).toISOString();
      const saved = { ...doc };
      if (!proposed) delete saved.proposed;
      db.stamps.set(doc.id, { at, proposed });
      return json(200, { station: saved, updated_at: at, created: isNew, updated_by: 'proposer@example.test' });
    }
    // The editor's stamp for a station it opens — one row, asked for as an
    // object, the way dbStationStamp() asks — and nothing else.
    if (req.method() === 'GET' && name === 'station') {
      const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      const s = db.stamps.get(id);
      const row = { updated_at: s ? s.at : '2026-01-01T00:00:00+00:00', deleted_at: null };
      return json(200, /vnd\.pgrst\.object/.test(req.headers()['accept'] || '') ? row : [row]);
    }
    return json(200, []);
  });
  return db;
}

async function openStations(browser, server, errors, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => !state.map._animatingZoom
    && !(state.map._panAnim && state.map._panAnim._inProgress), null, { timeout: 10_000 });
  return { context, page };
}

// Signed in, against the datastore, as an editor or an administrator: what the
// editor reads to decide what to offer and where a save goes.
const signIn = (page, role, schema = 39) => page.evaluate(([role, schema]) => {
  state.dataSource = { kind: 'api', at: new Date() };
  dbSetAccessToken('test-token');
  Auth.isSignedIn = () => true;
  Auth.mayWrite = () => true;
  Auth.role = () => role;
  Auth.schemaVersion = () => schema;
  rerenderStationEditorCard();
}, [role, schema]);

const editor = page => page.evaluate(() => {
  const val = id => { const el = document.getElementById(id); return el ? el.value : null; };
  const band = document.getElementById('ef-proposal');
  const box = document.getElementById('ef-proposed');
  const hint = document.getElementById('ef-proposed-hint');
  return {
    heading: (document.querySelector('#stations-editor-card h3') || {}).textContent || null,
    band: !!band && !band.hidden && getComputedStyle(band).display !== 'none',
    year: val('ef-pyear'), type: val('ef-stype'), name: val('ef-name'),
    typeBlank: (document.querySelector('#ef-stype option[value=""]') || {}).textContent || null,
    number: val('ef-stnno'), numberHint: (document.getElementById('ef-stnno') || {}).placeholder || '',
    lat: val('ef-lat'), lon: val('ef-lon'),
    box: box ? { checked: box.checked, disabled: box.disabled, title: box.closest('label').title } : null,
    hint: !!hint && !hint.hidden,
    status: (document.getElementById('ef-status') || {}).textContent.replace(/\s+/g, ' ').trim(),
    focus: document.activeElement && document.activeElement.id,
  };
});

const pin = (page, id) => page.evaluate(id => {
  const m = state.mapMarkers.find(x => x.mnStationId === id);
  if (!m) return null;
  const o = m.options;
  return { fill: o.fillColor, ring: o.color, dash: o.dashArray, radius: o.radius };
}, id);

const card = page => page.evaluate(() => {
  const el = document.getElementById('stn-card');
  if (!el || el.hidden) return null;
  const band = el.querySelector('.stn-card-proposed');
  return { id: state.stnCard.id, text: el.textContent.replace(/\s+/g, ' ').trim(),
           band: band ? band.textContent.replace(/\s+/g, ' ').trim() : null,
           tag: !!el.querySelector('.acma-card-head .proposed-tag') };
});

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\nProposing (an editor, 1440 × 900)\n');
    const who = { admin: false };
    const db = fakeDatabase(who);
    const { context, page } = await openStations(browser, server, errors, { viewport: { width: 1440, height: 900 } });
    await db.install(page);
    await signIn(page, 'editor');

    const buttons = await page.$$eval('#stations-list-card .stations-card-actions button', bs => bs.map(b => b.textContent.trim()));
    check('+ Propose stands beside + New under the station list', J(buttons) === J(['+ Propose', '+ New']), J(buttons));

    await page.click('#stations-list-card .stations-card-actions button:first-child');
    await page.waitForTimeout(200);
    let E = await editor(page);
    check('+ Propose opens a proposal: its band up, the Proposed box ticked', E.heading === 'New Proposed Station' && E.band && E.box && E.box.checked && !E.box.disabled, J(E));
    check(`…for this year, ${YEAR}, until somebody dates it`, E.year === String(YEAR), E.year);
    check('…the type to be chosen, and no station number yet', E.type === '' && E.typeBlank === '— choose one —'
      && E.number === '' && /none yet/.test(E.numberHint), J(E));
    check('…with the cursor in its name', E.focus === 'ef-name', E.focus);

    // Missing what a proposal has to say.
    await page.fill('#ef-name', 'Laidley Creek Proposed');
    await page.click('#ef-save');
    await page.waitForTimeout(150);
    E = await editor(page);
    check('saved with no type and no place: not sent, and told which two', db.saves.length === 0
      && /needs its type and where it would go/.test(E.status), E.status);
    await page.selectOption('#ef-stype', 'auto_rain_gauge');
    await page.fill('#ef-pyear', '');
    await page.fill('#ef-lat', '-27.5711');
    await page.fill('#ef-lon', '152.3942');
    await page.click('#ef-save');
    await page.waitForTimeout(150);
    E = await editor(page);
    check('…with no year: not sent, and told', db.saves.length === 0 && /needs the year it is proposed for/.test(E.status), E.status);
    await page.fill('#ef-pyear', '1850');
    await page.click('#ef-save');
    await page.waitForTimeout(150);
    E = await editor(page);
    check('…for a year no station could be proposed for: not sent', db.saves.length === 0 && /1850 is not a year/.test(E.status), E.status);

    // The old database — only the schema this session's whoami() said, so the
    // form keeps what has been typed.
    await page.evaluate(() => { Auth.schemaVersion = () => 38; });
    await page.fill('#ef-pyear', String(YEAR - 7));
    await page.click('#ef-save');
    await page.waitForTimeout(150);
    E = await editor(page);
    check('a database without 0039 is not sent a proposal — it would take it for a station on the ground',
      db.saves.length === 0 && /schema 38/.test(E.status) && /0039_proposed_stations\.sql/.test(E.status), E.status);
    await page.evaluate(() => { Auth.schemaVersion = () => 39; });

    // Sent.
    await page.click('#ef-save');
    await page.waitForFunction(() => /Proposed at/.test(document.getElementById('ef-status').textContent), null, { timeout: 10_000 });
    const sent = db.saves[db.saves.length - 1];
    check('complete, it is sent: proposed, its type, and the year dated back as typed',
      sent && sent.doc.proposed === true && sent.doc.station_type === 'auto_rain_gauge'
        && sent.doc.proposed_year === YEAR - 7 && sent.stamp === null, J(sent && sent.doc));
    check('…with its place and no station number', sent.doc.lat === -27.5711 && sent.doc.lon === 152.3942
      && sent.doc.station_number === '', J(sent.doc));
    const id = sent.doc.id;
    E = await editor(page);
    check('the editor says it was proposed, and keeps it open as a proposal', /Proposed at/.test(E.status) && E.band && E.box.checked, E.status);

    // ── What it looks like ──
    log('\nWhat a proposal looks like\n');
    let P = await pin(page, id);
    const want = await page.evaluate(() => ({ fill: MAP_PIN_PROPOSED_FILL, dash: MAP_PIN_PROPOSED_DASH, ring: ROLE_COLOR.field }));
    check('its pin is hollow, in a dashed ring of its role\'s colour', P && P.fill === want.fill && P.dash === want.dash
      && P.ring === want.ring && want.fill === '#ffffff', J({ P, want }));
    let C = await card(page);
    check('its card is up on it, the map moved there', C && C.id === id
      && await page.evaluate(id => { const s = state.data.stations.find(x => x.id === id); return state.map.getBounds().contains([s.lat, s.lon]); }, id), J(C && C.id));
    check('…opening with a band: proposed, not yet established, what and for when', C.tag && C.band
      && /Not yet established/.test(C.band) && /An automatic rain gauge, proposed for/.test(C.band) && C.band.includes(String(YEAR - 7)), C.band);
    check('…and "none yet" for its number', /Stn #\s*none yet — proposed/.test(C.text), C.text.slice(0, 200));
    // Its row, as the list draws one — a new station is at the end of the
    // file, past the first 500 rows an unfiltered list draws.
    const row = await page.evaluate(id => {
      const box = document.createElement('div');
      box.innerHTML = stationsTable([state.data.stations.find(s => s.id === id)]);
      const tr = box.querySelector(`tr[data-sid="${CSS.escape(id)}"]`);
      return tr ? { text: tr.textContent.replace(/\s+/g, ' '), tag: !!tr.querySelector('.proposed-tag') } : null;
    }, id);
    check('its row in the station list is tagged', row && row.tag && /Proposed/.test(row.text), J(row));
    const trail = await page.evaluate(id => ({ head: StationTrail.ids()[0] === id }), id);
    check('it is at the head of the trail', trail.head);
    await page.click('#stn-trail-pill');
    const trailTag = await page.evaluate(id => !!document.querySelector(`.stn-trail-item[data-sid="${CSS.escape(id)}"] .proposed-tag`), id);
    check('…tagged in its list', trailTag);
    await page.keyboard.press('Escape');
    const popup = await page.evaluate(id => stationPopupHtml(state.data.stations.find(s => s.id === id)), id);
    check('a phone\'s callout tags it too', /proposed-tag/.test(popup));
    const legend = await page.evaluate(() => mapLegendHtml());
    check('the legend explains the hollow pin', /legend-dot-proposed/.test(legend) && /Proposed — not yet established/.test(legend));

    // A station that is not proposed carries none of it.
    await page.evaluate(() => selectStation('gatton'));
    await page.waitForTimeout(150);
    const plain = await page.evaluate(() => {
      const d = editorReadForm();
      return { keys: ['proposed', 'station_type', 'proposed_year'].filter(k => k in d),
               band: !document.getElementById('ef-proposal') || document.getElementById('ef-proposal').hidden,
               blank: document.querySelector('#ef-stype option[value=""]').textContent };
    });
    const gatton = await pin(page, 'gatton');
    C = await card(page);
    check('an established station: no band on the form, "not recorded" for its type', plain.band && plain.blank === '— not recorded —', J(plain));
    check('…none of the three keys in what a save would send', plain.keys.length === 0, J(plain.keys));
    check('…a solid pin, and a card with no band', gatton.fill !== '#ffffff' && !gatton.dash && C && C.band === null && !C.tag, J({ gatton, C: C && C.band }));

    // ── Who may ──
    log('\nWho may\n');
    await page.evaluate(id => selectStation(id), id);
    await page.waitForTimeout(150);
    E = await editor(page);
    check('an editor on a saved proposal: the Proposed box is locked, and says why', E.box && E.box.checked && E.box.disabled
      && /Only an administrator establishes a proposed station/.test(E.box.title), J(E.box));
    await page.fill('#ef-pyear', String(YEAR + 3));
    await page.click('#ef-save');
    await page.waitForFunction(() => /Saved at/.test(document.getElementById('ef-status').textContent), null, { timeout: 10_000 });
    const edited = db.saves[db.saves.length - 1];
    check('…and may still date it forward, and save', edited.doc.proposed === true && edited.doc.proposed_year === YEAR + 3 && !!edited.stamp, J(edited.doc));

    await page.click('#stations-list-card .stations-card-actions button:nth-child(2)');
    await page.waitForTimeout(150);
    E = await editor(page);
    check('an editor pressing + New is told first that adding one outright is an administrator\'s', E.heading === 'New Station'
      && E.box && !E.box.checked && !E.box.disabled && E.hint, J(E));
    await page.fill('#ef-name', 'Outright Station');
    await page.fill('#ef-lat', '-27.6');
    await page.fill('#ef-lon', '152.4');
    const before = db.saves.length;
    await page.click('#ef-save');
    await page.waitForFunction(n => /Not saved/.test(document.getElementById('ef-status').textContent), before, { timeout: 10_000 });
    E = await editor(page);
    check('…and saved anyway, the database refuses — and the words are about administrators, not the editors list',
      db.saves.length === before + 1 && /only an administrator adds a station outright/i.test(E.status)
        && !/editors list/.test(E.status) && /Tick Proposed/.test(E.status), E.status);
    await page.check('#ef-proposed');
    E = await editor(page);
    check('ticking Proposed puts the band up with this year, and the line about administrators away', E.band && E.year === String(YEAR) && !E.hint, J(E));

    // An administrator establishes the proposal.
    who.admin = true;
    await signIn(page, 'admin');
    await page.evaluate(id => selectStation(id), id);
    await page.waitForTimeout(150);
    E = await editor(page);
    check('an administrator\'s Proposed box is not locked', E.box && E.box.checked && !E.box.disabled, J(E.box));
    await page.uncheck('#ef-proposed');
    E = await editor(page);
    check('unticked, the band goes', !E.band);
    await page.fill('#ef-stnno', '540999');
    await page.click('#ef-save');
    await page.waitForFunction(() => /Saved at/.test(document.getElementById('ef-status').textContent), null, { timeout: 10_000 });
    const established = db.saves[db.saves.length - 1];
    check('established: sent without proposed, with its number, its type and its year kept',
      !('proposed' in established.doc) && established.doc.station_number === '540999'
        && established.doc.station_type === 'auto_rain_gauge' && established.doc.proposed_year === YEAR + 3, J(established.doc));
    P = await pin(page, id);
    await page.evaluate(id => showStationCard(id), id);
    C = await card(page);
    check('…its pin solid, its card with no band and its type on a row of its own', P.fill !== '#ffffff' && !P.dash
      && C.band === null && !C.tag && /Type\s*Automatic rain gauge/.test(C.text), J({ P, text: C.text.slice(0, 160) }));

    // ── What is here ──
    log('\nProposing at a point on the map\n');
    await page.evaluate(() => { state.map.setView([-27.62, 152.41], 13, { animate: false }); MapHere.arm(true); });
    await page.evaluate(() => state.map.fire('click', { latlng: L.latLng(-27.6234567891, 152.4123456789), originalEvent: new MouseEvent('click') }));
    await page.waitForFunction(() => { const c = document.getElementById('here-card'); return c && !c.hidden; }, null, { timeout: 10_000 });
    const pillText = await page.evaluate(() => [...document.querySelectorAll('#here-card button.pill')].map(b => b.textContent.trim()));
    check('What is here offers to propose a station at its point', pillText.includes('📌 Propose a station here'), J(pillText));
    await page.click('#here-card button.pill:has-text("Propose a station here")');
    await page.waitForTimeout(250);
    E = await editor(page);
    check('…and pressed, the editor opens on a proposal there, to six decimals, the cursor in its name',
      E.heading === 'New Proposed Station' && E.band && E.lat === '-27.623457' && E.lon === '152.412346' && E.focus === 'ef-name', J(E));

    check('nothing threw', errors.length === 0, errors.slice(0, 3).join(' | '));
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
  log('\nPASS — a station can be proposed from the list or a point on the map, is shown for\n'
    + '       what it is, and only an administrator adds one outright or establishes it.');
}

main().catch(err => { console.error(err); process.exit(1); });
