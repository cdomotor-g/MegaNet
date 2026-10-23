// Unsaved edits in the station editor (station-editor.js, editorUnsavedRefresh):
// the card teal while it shows what the database holds, gold-orange from the
// first edit until a save lands, each changed field gilded, and a bar stuck to
// the foot of the card saying how many and carrying a Save.
//
//   1. **Nothing is changed until somebody changes it** — a freshly drawn card,
//      for field stations, repeaters, bases, proposals and stations with the
//      Bureau's lists, gilds nothing and has no bar, and is teal; after the
//      fills that arrive late (the owner, the wind region, the pick-lists) too.
//   2. **What counts** — a typed field is gilded and counted, and typed back it
//      is neither; a ticked role gilds its label, and two roles are one change
//      (Roles); a select, a textarea; a sensor row from the record taken away
//      is counted by name, a row added and left blank is not, and typed into
//      it is. The names in the bar go to their fields.
//   3. **Saving** — the bar's Save is the card's: refused, the card stays gold,
//      every gilt stays and the bar says it was not saved; accepted, the card
//      is redrawn teal with nothing gilded and no bar. Signed out, the bar's
//      button asks for a sign-in instead.
//   4. **In view** — beside the map, the bar is stuck to the foot of the side
//      panel's pane while the card runs on below it.
//   5. **Undo** — to the left of Save in the header and in the bar, only while
//      something is unsaved: the card drawn again as the database has it, a
//      sensor taken away back, the draft too, nothing sent; a "+ New" form
//      back to blank.
//
// The database is a stand-in for save_station() that echoes the document back,
// or refuses it when told to.
//
// Run:  npm run unsaved
//       npm run unsaved -- -v

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

function fakeDatabase() {
  const db = { saves: [], refuse: false };
  db.install = page => page.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: J(body) });
    if (req.method() === 'POST' && name === 'rpc/save_station') {
      const doc = (JSON.parse(req.postData() || '{}').p_doc) || {};
      db.saves.push(doc);
      if (db.refuse) return json(500, { code: 'XX000', message: 'the datastore is having a moment' });
      return json(200, { station: doc, updated_at: new Date(Date.now() + db.saves.length).toISOString(),
                         created: false, updated_by: 'editor@example.test' });
    }
    if (req.method() === 'GET' && name === 'station') {
      const row = { updated_at: '2026-01-01T00:00:00+00:00', deleted_at: null };
      return json(200, /vnd\.pgrst\.object/.test(req.headers()['accept'] || '') ? row : [row]);
    }
    return json(200, []);
  });
  return db;
}

// What the editor says about itself: the card's state, what is gilded, the bar.
const look = page => page.evaluate(() => {
  const card = document.getElementById('stations-editor-card');
  const bar = document.getElementById('ef-unsaved');
  const root = getComputedStyle(document.documentElement);
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  const rgb = v => { probe.style.color = v; return getComputedStyle(probe).color; };
  const out = {
    unsaved: card.classList.contains('is-unsaved'),
    panel: rgb(getComputedStyle(card).getPropertyValue('--panel').trim()),
    teal: rgb(root.getPropertyValue('--panel-station').trim()),
    gold: rgb(root.getPropertyValue('--panel-unsaved').trim()),
    gilded: [...card.querySelectorAll('.ef-changed')].map(el => el.id || el.textContent.replace(/\s+/g, ' ').trim()),
    bar: !bar || bar.hidden ? null : bar.textContent.replace(/\s+/g, ' ').trim(),
    barButton: bar && !bar.hidden ? (bar.querySelector('#ef-save-bar') || {}).textContent?.trim() : null,
    names: bar && !bar.hidden ? [...bar.querySelectorAll('.link-btn')].map(b => b.textContent.trim()) : [],
    status: (document.getElementById('ef-status') || {}).textContent?.replace(/\s+/g, ' ').trim(),
  };
  probe.remove();
  return out;
});

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
  await page.waitForFunction(() => !!document.getElementById('stations-editor-card'), null, { timeout: LOAD_TIMEOUT });
  return { context, page };
}

const select = (page, id) => page.evaluate(id => selectStation(id), id);

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\nNothing is changed until somebody changes it (1440 × 900)\n');
    const db = fakeDatabase();
    const { page } = await openStations(browser, server, errors, { viewport: { width: 1440, height: 900 } });
    await db.install(page);

    const ids = await page.evaluate(() => {
      const st = state.data.stations;
      const some = (f, n) => st.filter(f).slice(0, n).map(s => s.id);
      return [...new Set([
        ...some(s => s.roles.includes('field'), 10), ...some(s => s.roles.includes('repeater'), 10),
        ...some(s => s.roles.includes('base'), 6), ...some(s => s.proposed, 3),
        ...some(s => (s.sensors || []).length > 2, 5),
        ...some(s => s.flood_classes || s.bureau_indexes || s.aep_levels || s.crossings, 6),
      ])];
    });
    const dirty = [];
    for (const id of ids) {
      await select(page, id);
      const L = await look(page);
      if (L.unsaved || L.gilded.length || L.bar) dirty.push({ id, gilded: L.gilded, bar: L.bar });
    }
    check(`${ids.length} freshly drawn cards gild nothing, have no bar and are not gold`, dirty.length === 0, J(dirty.slice(0, 3)));
    await page.waitForTimeout(1500);
    await page.evaluate(() => editorUnsavedRefresh());
    let L = await look(page);
    check('…nor after the late fills — the owner, the wind region, the pick-lists', !L.unsaved && !L.gilded.length && !L.bar, J(L));

    const main = await page.evaluate(() => {
      const s = state.data.stations.find(x => !x.roles.includes('repeater') && (x.sensors || []).length >= 2 && x.lat != null);
      return { id: s.id, name: s.name, aid: String(s.sensors[0].alert_id ?? s.sensors[0].alert2_sensor_id) };
    });
    await select(page, main.id);
    await page.waitForTimeout(300);
    L = await look(page);
    check('a station as the database has it: the teal ground, no bar', !L.unsaved && L.panel === L.teal && !L.bar, J(L));

    // ═══════════════════════════════════════════════════════════════════════
    log('\nWhat counts\n');
    await page.fill('#ef-name', `${main.name} (renamed)`);
    await page.waitForTimeout(300);
    L = await look(page);
    check('a typed name: the card gold, the box gilded, the bar counting one', L.unsaved && L.panel === L.gold
      && J(L.gilded) === J(['ef-name']) && /^1 unsaved change, not in the database yet — Name\./.test(L.bar), J(L));
    await page.fill('#ef-name', main.name);
    L = await look(page);
    check('…typed back as it was: no gilt, no bar, teal again', !L.unsaved && !L.gilded.length && !L.bar, J(L));

    await page.check('input[name="ef-roles"][value="repeater"]');
    await page.check('input[name="ef-roles"][value="base"]');
    L = await look(page);
    check('two roles ticked: both labels gilded, counted once as Roles', L.gilded.length === 2
      && L.gilded.every(t => /repeater|base/.test(t)) && /^1 unsaved change/.test(L.bar) && J(L.names) === J(['Roles']), J(L));
    await page.uncheck('input[name="ef-roles"][value="base"]');
    await page.fill('#ef-notes', 'A note nobody has saved');
    await page.selectOption('#ef-tower', { index: 1 });
    L = await look(page);
    check('a role, the notes and a select: three changes, in the order the form has them',
      /^3 unsaved changes/.test(L.bar) && J(L.names) === J(['Tower platform height', 'Roles', 'Notes']), J(L));

    await page.click('#ef-sensors .sensor-row:first-child .sensor-del');
    L = await look(page);
    const gone = await page.evaluate(() => editorUnsavedGone.names);
    check(`a sensor from the record taken away is a change, by name (Sensor ${main.aid} removed)`,
      /^4 unsaved changes/.test(L.bar) && L.bar.includes('and 1 more') && J(gone) === J([`Sensor ${main.aid} removed`]), J({ bar: L.bar, gone }));
    await page.evaluate(() => editorAddSensorRow());
    L = await look(page);
    check('…a row added and left blank is not', /^4 unsaved changes/.test(L.bar), L.bar);
    await page.fill('#ef-sensors .sensor-row:last-child .sensor-type', 'Battery');
    L = await look(page);
    check('…and typed into, it is', /^5 unsaved changes/.test(L.bar), L.bar);

    await page.locator('#ef-unsaved .link-btn').first().click();
    await page.waitForTimeout(500);
    const focus = await page.evaluate(() => document.activeElement && document.activeElement.id);
    check('a name in the bar goes to its field', focus === 'ef-tower', focus);

    // ═══════════════════════════════════════════════════════════════════════
    log('\nSaving\n');
    L = await look(page);
    check('signed out, the bar asks for a sign-in rather than offering a Save that cannot work',
      L.barButton === 'Sign in to save', L.barButton);
    await page.evaluate(() => {
      state.dataSource = { kind: 'api', at: new Date() };
      dbSetAccessToken('test-token');
      Auth.isSignedIn = () => true;
      Auth.mayWrite = () => true;
      Auth.role = () => 'editor';
      editorUnsavedRefresh();
    });
    L = await look(page);
    check('signed in, it is a Save', L.barButton === 'Save', L.barButton);

    db.refuse = true;
    await page.click('#ef-save-bar');
    await page.waitForFunction(() => !state.editorBusy, null, { timeout: 10_000 });
    L = await look(page);
    check('refused: sent once, the card still gold, every gilt still there', db.saves.length === 1 && L.unsaved
      && L.gilded.includes('ef-tower') && L.gilded.includes('ef-notes'), J(L));
    check('…and the bar says it was not saved, with a way up to why', /⚠ not saved \(why ↑\)/.test(L.bar)
      && /Not saved/.test(L.status), J({ bar: L.bar, status: L.status }));

    db.refuse = false;
    await page.click('#ef-save-bar');
    await page.waitForFunction(() => !state.editorBusy, null, { timeout: 10_000 });
    await page.waitForTimeout(400);
    L = await look(page);
    check('accepted: redrawn teal, nothing gilded, no bar', db.saves.length === 2 && !L.unsaved
      && L.panel === L.teal && !L.gilded.length && !L.bar, J(L));
    check('…what was sent is what was typed', db.saves[1].notes === 'A note nobody has saved'
      && (db.saves[1].roles || []).includes('repeater'), J(db.saves[1]).slice(0, 300));
    check('…and the status line says it is in the database', /^Saved at .* in the database/.test(L.status), L.status);

    // ═══════════════════════════════════════════════════════════════════════
    log('\nIn view\n');
    await page.fill('#ef-notes', 'Another');
    await page.evaluate(() => {
      const list = document.getElementById('stations-list-body');
      if (list) list.hidden = true;
      document.getElementById('ef-name').scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(300);
    const stuck = await page.evaluate(() => {
      const bar = document.getElementById('ef-unsaved').getBoundingClientRect();
      const card = document.getElementById('stations-editor-card').getBoundingClientRect();
      const pane = document.getElementById('stations-editor-card').closest('#help-panel [id^="dock-pane"], #help-panel') ;
      const box = pane ? pane.getBoundingClientRect() : { bottom: innerHeight };
      return { barBottom: Math.round(bar.bottom), paneBottom: Math.round(Math.min(box.bottom, innerHeight)),
               cardBottom: Math.round(card.bottom), inHelp: !!pane };
    });
    check('beside the map, the bar is stuck to the foot of the pane while the card runs on below it',
      stuck.inHelp && stuck.cardBottom > stuck.paneBottom + 100
      && stuck.barBottom <= stuck.paneBottom && stuck.barBottom >= stuck.paneBottom - 24, J(stuck));

    // ═══════════════════════════════════════════════════════════════════════
    log('\nUndo\n');
    const undoLook = () => page.evaluate(() => {
      const top = document.getElementById('ef-undo'), bar = document.getElementById('ef-unsaved');
      const order = bar && !bar.hidden ? [...bar.querySelectorAll('button:not(.link-btn)')].map(b => b.id) : [];
      const heads = [...document.querySelectorAll('.ef-head .button-group > button')].filter(b => !b.hidden).map(b => b.id);
      return { top: !!top && !top.hidden, order, heads };
    });
    let U = await undoLook();
    check('something unsaved: Undo to the left of Save, in the header and in the bar',
      U.top && J(U.order) === J(['ef-undo-bar', 'ef-save-bar']) && U.heads[0] === 'ef-undo' && U.heads[1] === 'ef-save', J(U));

    const saved = await page.evaluate(id => {
      const s = state.data.stations.find(x => x.id === id);
      return { name: s.name, notes: s.notes || '', sensors: (s.sensors || []).length };
    }, main.id);
    await page.fill('#ef-name', `${saved.name} (again)`);
    await page.click('#ef-sensors .sensor-row:first-child .sensor-del');
    L = await look(page);
    check('…three changes to undo', /^3 unsaved changes/.test(L.bar), L.bar);
    await page.click('#ef-undo-bar');
    await page.waitForTimeout(300);
    L = await look(page);
    U = await undoLook();
    const back = await page.evaluate(() => ({
      name: document.getElementById('ef-name').value, notes: document.getElementById('ef-notes').value,
      sensors: document.querySelectorAll('#ef-sensors .sensor-row').length,
      draftNotes: state.editorDraft.notes || '', focus: document.activeElement && document.activeElement.id,
    }));
    check('the bar’s Undo: teal again, nothing gilded, no bar, the header’s Undo gone',
      !L.unsaved && L.panel === L.teal && !L.gilded.length && !L.bar && !U.top, J({ L, U }));
    check('…every field as the database has it, the sensor taken away back, the draft too',
      back.name === saved.name && back.notes === saved.notes && back.sensors === saved.sensors
        && back.draftNotes === saved.notes, J({ back, saved }));
    check('…the status line says what was undone, and focus is on the first field put back',
      /^Undid 3 unsaved changes — back to what the database holds\.$/.test(L.status) && back.focus === 'ef-name',
      J({ status: L.status, focus: back.focus }));

    await page.fill('#ef-notes', 'Changed my mind');
    await page.click('#ef-undo');
    await page.waitForTimeout(300);
    L = await look(page);
    const notesBack = await page.evaluate(() => document.getElementById('ef-notes').value);
    check('the header’s Undo the same, and nothing is sent to the database',
      !L.unsaved && !L.bar && notesBack === saved.notes && db.saves.length === 2
        && /^Undid 1 unsaved change — /.test(L.status), J({ L, notesBack, saves: db.saves.length }));

    await page.evaluate(() => editorNew());
    await page.fill('#ef-name', 'A station nobody has saved');
    await page.click('#ef-undo-bar');
    await page.waitForTimeout(300);
    L = await look(page);
    const blank = await page.evaluate(() => document.getElementById('ef-name').value);
    check('a "+ New" form goes back to what it opened with', !L.unsaved && !L.bar && blank === ''
      && /the form as it opened\.$/.test(L.status), J({ L, blank }));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await server.close?.();
  }

  const failed = results.filter(r => !r.ok);
  log(`\n  ${results.length} assertion(s).`);
  if (failed.length) {
    log(`\nFAIL — ${failed.length} of ${results.length}: ${failed.map(f => f.label).join('; ')}`);
    process.exit(1);
  }
  log('\nPASS — the station editor is teal until it is edited, gold and gilded until the edit is saved,\n'
    + '       and the bar that says so is in view with a Save while there is anything to say.');
}

main().catch(e => { console.error(e); process.exit(1); });
