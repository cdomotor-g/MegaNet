// The station history (0056) in the browser: the station card's History
// section and the Admin tab's Deleted stations (station-history.js), against a
// stand-in for the database.
//
//   1. **Nobody but an editor** — signed out, or signed in off the editors
//      list, the card has no History section and the Admin tab no Deleted
//      stations, and neither asks the database anything.
//   2. **The panel** — an editor's card asks for the station's changes, newest
//      first, and says who changed it last; opened, every change is an entry —
//      what kind, when, who — with the fields that moved, was over became, a
//      Restore beside each that can be put back, "as now" where it already is,
//      and "not restored here" with no button for the hub, which the editor's
//      save does not write. It stays open through a repaint of the card.
//   3. **A field back** — Restore asks first (and a "no" sends nothing), then
//      reads the database's own copy of the station and saves it through
//      save_station() with that copy's stamp and only that field changed, its
//      lists left out: the editor's own write path, not a write of its own.
//      The card, the list and the section follow, the restore itself the newest
//      entry.
//   4. **A version back** — "Restore as it was before this" puts back every
//      field that change or a later one moved, at its value before the oldest
//      of them, counts the later changes it undoes in the confirmation, and
//      leaves the hub alone, saying so.
//   5. **Refused** — a restore save_station() refuses (an editor putting
//      `proposed` back, 0039) is reported in words and changes nothing.
//   6. **No 0056** — a database without the table: the section says history
//      starts once the migration is applied, and the rest of the card is
//      drawn as ever.
//   7. **Deleted stations** — on the Admin tab, from meganet.station: each with
//      when, who and Restore, which calls restore_station() with the stamp the
//      list was read with and puts the station back on the map and in the
//      list; a refusal is said in the database's words and the station stays
//      in the list; and a database without 0056 is told so.
//   8. **Not in the agent API** — worker/api.js does not read the log.
//
// The database is a stand-in (the real one is held to the same rules by
// tools/check_station_history.sql): it keeps a document and a stamp per
// station, answers station_json and the change log, writes a change row on a
// save the way the trigger does, refuses an editor's `proposed` the way
// save_station() does, and answers the way PostgREST does.
//
// Run:  npm run stationhistory
//       npm run stationhistory -- -v

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';
import { READABLE_RELATIONS } from '../worker/api.js';

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
const EDITOR = 'history-editor@example.test';

// ── The stand-in ─────────────────────────────────────────────────────────────

function fakeDatabase(lists) {
  const LISTS = new Set(lists);
  const col = k => (k === 'TBRGbucketSize' ? 'tbrg_bucket_size' : k);
  const db = {
    missing: false, docs: {}, stamps: {}, changes: {}, deleted: [], refuse: {},
    requests: [], saves: [], restores: [], dialogs: [], dismissNext: false, nextId: 100,
  };
  db.install = page => page.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: J(body) });
    const eq = k => (url.searchParams.get(k) || '').replace(/^eq\./, '');
    db.requests.push({ method: req.method(), name, search: decodeURIComponent(url.search) });

    if (req.method() === 'GET' && name === 'station_change') {
      if (db.missing) {
        return json(404, { code: 'PGRST205', details: null, hint: null,
          message: 'Could not find the table \'meganet.station_change\' in the schema cache' });
      }
      const rows = (db.changes[eq('station_id')] || []).slice()
        .sort((a, b) => b.changed_at.localeCompare(a.changed_at) || b.id - a.id);
      return json(200, rows.slice(0, Number(url.searchParams.get('limit') || 1000)));
    }
    if (req.method() === 'GET' && name === 'station_json') {
      const id = eq('id');
      return json(200, db.docs[id] ? [{ doc: db.docs[id], updated_at: db.stamps[id] }] : []);
    }
    if (req.method() === 'GET' && name === 'station') {
      if (url.searchParams.get('deleted_at') === 'not.is.null') return json(200, db.deleted);
      const row = { updated_at: db.stamps[eq('id')] || '2026-01-01T00:00:00+00:00', deleted_at: null };
      return json(200, /vnd\.pgrst\.object/.test(req.headers()['accept'] || '') ? row : [row]);
    }
    if (req.method() === 'POST' && name === 'rpc/save_station') {
      const body = JSON.parse(req.postData() || '{}');
      const doc = body.p_doc || {};
      db.saves.push({ doc, stamp: body.p_expected_updated_at || null });
      const was = db.docs[doc.id];
      if (!was) return json(409, { code: 'PT409', message: `station "${doc.id}" is no longer in the database` });
      if (body.p_expected_updated_at !== db.stamps[doc.id]) {
        return json(409, { code: 'PT409', message: `station "${doc.id}" was changed in the database after you opened it` });
      }
      if (!!was.proposed !== !!doc.proposed) {
        return json(403, { code: '42501', details: 'administrator', hint: null,
          message: 'only an administrator establishes a proposed station' });
      }
      // What the trigger does: one row with the fields that moved.
      const before = {}, after = {};
      for (const k of new Set([...Object.keys(was), ...Object.keys(doc)])) {
        if (LISTS.has(k)) continue;
        const a = k in was ? was[k] : (k === 'proposed' ? false : null);
        const b = k in doc ? doc[k] : (k === 'proposed' ? false : null);
        if (J(a) !== J(b)) { before[col(k)] = a; after[col(k)] = b; }
      }
      const id = ++db.nextId;
      const at = new Date(Date.parse('2026-10-07T00:00:00Z') + id * 1000).toISOString();
      if (Object.keys(before).length) {
        (db.changes[doc.id] ||= []).push({ id, changed_at: at, changed_by: EDITOR, kind: 'edited', before, after });
      }
      const saved = { ...doc };
      for (const k of LISTS) if (k in was) saved[k] = was[k];
      db.docs[doc.id] = saved;
      db.stamps[doc.id] = at;
      return json(200, { station: saved, updated_at: at, created: false, updated_by: EDITOR });
    }
    if (req.method() === 'POST' && name === 'rpc/restore_station') {
      if (db.missing) {
        return json(404, { code: 'PGRST202', details: null,
          hint: 'Perhaps you meant to call the function meganet.delete_station',
          message: 'Could not find the function meganet.restore_station(p_expected_updated_at, p_id) in the schema cache' });
      }
      const body = JSON.parse(req.postData() || '{}');
      db.restores.push(body);
      if (db.refuse[body.p_id]) return json(409, db.refuse[body.p_id]);
      const row = db.deleted.find(r => r.id === body.p_id);
      if (!row) return json(200, { id: body.p_id, already: true, station: db.docs[body.p_id] || null });
      if (body.p_expected_updated_at !== row.updated_at) return json(409, { code: 'PT409', message: 'the list is stale' });
      db.deleted = db.deleted.filter(r => r !== row);
      const at = '2026-10-07T03:00:00.000Z';
      db.stamps[body.p_id] = at;
      return json(200, { station: db.docs[body.p_id], updated_at: at, created: false, updated_by: EDITOR, restored: true });
    }
    // Writes of any other kind — a PATCH, a DELETE, another function — are a
    // restore going around the editor's save, which is the failure this check
    // exists for. Answered, and recorded for the assertion at the foot.
    return json(200, []);
  });
  return db;
}

// ── The page ─────────────────────────────────────────────────────────────────

async function openStations(browser, server, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 },
                                             locale: 'en-AU', timezoneId: 'Australia/Brisbane' });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
  return { context, page };
}

// An editor (or not), signed in against the datastore: what the module reads
// to decide what to draw, and the token the requests carry.
const signIn = (page, { editor = true } = {}) => page.evaluate(editor => {
  state.dataSource = { kind: 'api', at: new Date() };
  dbSetAccessToken('test-token');
  Auth.isSignedIn = () => true;
  Auth.mayWrite = () => editor;
  Auth.role = () => (editor ? 'editor' : null);
  StationHistory.authChanged();
  repaintStnCard();
}, editor);
const signOut = page => page.evaluate(() => {
  dbSetAccessToken(null);
  Auth.isSignedIn = () => false;
  Auth.mayWrite = () => false;
  Auth.role = () => null;
  StationHistory.authChanged();
  repaintStnCard();
});

const section = (page, id) => page.evaluate(id => {
  const el = document.getElementById(`mn-hist-card-${id}`);
  if (!el) return null;
  const box = el.querySelector('details');
  return {
    text: el.textContent.replace(/\s+/g, ' ').trim(),
    open: !!(box && box.open),
    summary: ((el.querySelector('summary') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
    msg: ((el.querySelector('.stn-hist-msg') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
    entries: [...el.querySelectorAll('.stn-hist-entry')].map(li => ({
      id: Number(li.dataset.change), kind: li.dataset.kind,
      head: li.querySelector('.stn-hist-head').textContent.replace(/\s+/g, ' ').trim(),
      version: !!li.querySelector('button.stn-hist-version'),
      rows: [...li.querySelectorAll('.stn-hist-row')].map(r => ({
        field: r.dataset.field,
        label: r.querySelector('dt').textContent.trim(),
        was: r.querySelector('del').textContent.replace(/\s+/g, ' ').trim(),
        became: r.querySelector('ins').textContent.replace(/\s+/g, ' ').trim(),
        button: r.querySelector('button.stn-hist-put') ? r.querySelector('button.stn-hist-put').getAttribute('aria-label') : null,
        note: ((r.querySelector('.stn-hist-same, .stn-hist-fixed') || {}).textContent || '').trim(),
      })),
    })),
  };
}, id);

const card = page => page.evaluate(() => {
  const el = document.getElementById('stn-card');
  if (!el || el.hidden) return null;
  return { id: state.stnCard.id, title: (el.querySelector('#stn-card-title') || {}).textContent || '',
           groups: el.querySelectorAll('.stn-card-group').length,
           sls: !!el.querySelector('[data-mn-sls]') };
});

const reqs = (db, name, method = 'GET') => db.requests.filter(r => r.name === name && r.method === method);

// Wait, in Node, for something the stand-in records.
async function until(fn, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end && !fn();) await new Promise(r => setTimeout(r, 50));
}

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const { context, page } = await openStations(browser, server, errors);
    const lists = await page.evaluate(() => [...RiverDetails.LIST_KEYS, 'frequencies']);
    const db = fakeDatabase(lists);
    await db.install(page);
    // A click on something a broken build never drew fails in seconds, not 30.
    page.setDefaultTimeout(10_000);
    page.on('dialog', d => {
      db.dialogs.push(d.message());
      if (db.dismissNext) { db.dismissNext = false; d.dismiss(); } else d.accept();
    });

    // The register as the stand-in holds it: Gatton as its changes have left
    // it, Laidley an established proposal, and two stations deleted.
    const docs = await page.evaluate(() => {
      const g = { ...state.data.stations.find(s => s.id === 'gatton') };
      const l = { ...state.data.stations.find(s => s.id === 'laidley') };
      return { g, l };
    });
    const gatton = { ...docs.g, name: 'Gatton Weir', owner: 'Lockyer Valley Regional Council',
                     notes: 'Weir rebuilt 2026', lat: -27.554471, hub_id: 'brisbane' };
    const laidley = { ...docs.l, station_type: 'auto_water_level', proposed_year: 2025 };
    delete laidley.proposed;
    await page.evaluate(([g, l]) => {
      const list = state.data.stations;
      list[list.findIndex(s => s.id === 'gatton')] = g;
      list[list.findIndex(s => s.id === 'laidley')] = l;
    }, [gatton, laidley]);
    db.docs.gatton = gatton;   db.stamps.gatton = '2026-10-03T04:12:00.000Z';
    db.docs.laidley = laidley; db.stamps.laidley = '2026-10-02T00:00:00.000Z';
    db.changes.gatton = [
      { id: 14, changed_at: '2026-10-03T04:12:00Z', changed_by: 'bob@example.test', kind: 'edited',
        before: { notes: '' }, after: { notes: 'Weir rebuilt 2026' } },
      { id: 12, changed_at: '2026-10-01T01:30:00Z', changed_by: 'alice@example.test', kind: 'edited',
        before: { name: 'Gatton', owner: null }, after: { name: 'Gatton Weir', owner: 'Lockyer Valley Regional Council' } },
      { id: 9, changed_at: '2026-09-25T01:30:00Z', changed_by: 'alice@example.test', kind: 'restored',
        before: { deleted_at: '2026-09-24T00:00:00+00:00' }, after: { deleted_at: null } },
      { id: 8, changed_at: '2026-09-24T00:00:00Z', changed_by: 'bob@example.test', kind: 'deleted',
        before: { deleted_at: null }, after: { deleted_at: '2026-09-24T00:00:00+00:00' } },
      { id: 7, changed_at: '2026-09-20T00:00:00Z', changed_by: 'load_stations_doc', kind: 'edited',
        before: { lat: -27.55, hub_id: null }, after: { lat: -27.554471, hub_id: 'brisbane' } },
      { id: 3, changed_at: '2026-09-01T00:00:00Z', changed_by: 'import_stations_json.py', kind: 'created',
        before: null, after: null },
    ];
    db.changes.laidley = [
      { id: 21, changed_at: '2026-10-02T00:00:00Z', changed_by: 'admin@example.test', kind: 'edited',
        before: { proposed: true }, after: { proposed: false } },
    ];
    const gone = id => ({ ...docs.l, id, name: id === '_gone_a' ? 'Old Creek AL' : 'Older Creek AL',
                          station_number: id === '_gone_a' ? '540999' : '40716', lat: -27.6, lon: 152.33 });
    db.docs._gone_a = gone('_gone_a');
    db.docs._gone_b = gone('_gone_b');
    db.deleted = [
      { id: '_gone_a', name: 'Old Creek AL', station_number: '540999', proposed: false,
        deleted_at: '2026-10-04T02:00:00+00:00', updated_at: '2026-10-04T02:00:00+00:00', updated_by: 'alice@example.test' },
      { id: '_gone_b', name: 'Older Creek AL', station_number: '40716', proposed: false,
        deleted_at: '2026-09-30T02:00:00+00:00', updated_at: '2026-09-30T02:00:00+00:00', updated_by: 'bob@example.test' },
    ];

    // Each part runs to its end or is recorded as having stopped, by name — a
    // broken restore is a red line saying where, not a timeout with no label.
    let C, S, P, sent;
    const part = async (name, fn) => {
      log(`\n${name}\n`);
      try { await fn(); } catch (err) { check(`${name}: ran to its end`, false, String(err.message || err).split('\n')[0]); }
    };

    // ═══════════════════════════════════════════════════════════════════════
    await part('Nobody but an editor', async () => {
      await page.evaluate(() => showStationCard('gatton'));
      await page.waitForTimeout(250);
      C = await card(page);
      S = await section(page, 'gatton');
      check('signed out, the station card is drawn — and has no History section', C && C.id === 'gatton' && S === null, J({ C, S }));
      await signIn(page, { editor: false });
      await page.waitForTimeout(250);
      S = await section(page, 'gatton');
      check('signed in but off the editors list: still none', S === null, J(S));
      await page.evaluate(() => switchTab('admin'));
      await page.waitForTimeout(300);
      const slot = await page.evaluate(() => {
        const el = document.getElementById('adm-deleted');
        return el ? { html: el.innerHTML, shown: getComputedStyle(el).display !== 'none' } : null;
      });
      check('…and the Admin tab\'s Deleted stations is an empty slot, not drawn', slot && slot.html === '' && !slot.shown, J(slot));
      check('neither asked the database for anything', reqs(db, 'station_change').length === 0
        && !db.requests.some(r => r.name === 'station' && /deleted_at/.test(r.search)), J(db.requests.map(r => r.name)));
      await page.evaluate(() => switchTab('stations'));
      await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
    });

    // ═══════════════════════════════════════════════════════════════════════
    await part('The panel (an editor)', async () => {
      await signIn(page);
      await page.evaluate(() => showStationCard('gatton'));
      await page.waitForFunction(() => /last changed/.test((document.querySelector('#mn-hist-card-gatton summary') || {}).textContent || ''),
                                 null, { timeout: 10_000 });
      S = await section(page, 'gatton');
      const asked = reqs(db, 'station_change');
      check('an editor\'s card asks for the station\'s changes, newest first, fifty at most',
        asked.length === 1 && /station_id=eq\.gatton/.test(asked[0].search)
          && /order=changed_at\.desc,id\.desc/.test(asked[0].search) && /limit=50/.test(asked[0].search), J(asked));
      check('…and, shut, says who changed it last and when',
        !S.open && /^History · last changed 3 Oct 2026, 2:12 pm by bob@example\.test$/.test(S.summary), S.summary);
      await page.click('#mn-hist-card-gatton summary');
      S = await section(page, 'gatton');
      check('opened: six entries, newest first', S.open && J(S.entries.map(e => e.id)) === J([14, 12, 9, 8, 7, 3]), J(S.entries.map(e => e.id)));
      const e12 = S.entries.find(e => e.id === 12);
      check('an entry says what kind, when and who', /^Edited 1 Oct 2026, 11:30 am · alice@example\.test$/.test(e12.head), e12.head);
      check('…and the fields that moved, was over became, in the card\'s own words',
        J(e12.rows.map(r => [r.label, r.was, r.became])) === J([['Name', 'Gatton', 'Gatton Weir'],
          ['Owner', 'not recorded', 'Lockyer Valley Regional Council']]), J(e12.rows));
      check('…each with a Restore that says what it puts back',
        e12.rows[0].button === 'Restore Name to “Gatton”' && e12.rows[1].button === 'Restore Owner to not recorded', J(e12.rows));
      const e7 = S.entries.find(e => e.id === 7);
      const hub = e7.rows.find(r => r.field === 'hub_id');
      check('a loader\'s change is named for the loader', /the stations loader$/.test(e7.head), e7.head);
      check('the hub, which the editor\'s save does not write, is "not restored here", with no button',
        hub && hub.button === null && hub.note === 'not restored here', J(hub));
      const e3 = S.entries.find(e => e.id === 3);
      check('a creation is an entry with no fields and nothing to restore it to',
        e3.kind === 'created' && /^Created .* · the stations\.json import$/.test(e3.head) && !e3.rows.length && !e3.version, J(e3));
      const e8 = S.entries.find(e => e.id === 8), e9 = S.entries.find(e => e.id === 9);
      check('a delete and a restore are entries of their own kind, with no field rows — deleted_at is what they mean',
        /^Deleted 24 Sept 2026, 10:00 am · bob@example\.test$/.test(e8.head) && /^Restored 25 Sept 2026, 11:30 am · alice@example\.test$/.test(e9.head)
          && !e8.rows.length && !e9.rows.length, J({ e8, e9 }));
      check('every change that moved a field offers the version before it; a delete, a restore and the creation do not',
        J(S.entries.map(e => e.version)) === J([true, true, false, false, true, false]), J(S.entries.map(e => e.version)));
      await page.evaluate(() => repaintStnCard());
      S = await section(page, 'gatton');
      check('a repaint of the card keeps the section open, and asks nothing new',
        S.open && S.entries.length === 6 && reqs(db, 'station_change').length === 1, J({ open: S.open, n: reqs(db, 'station_change').length }));
    });

    // ═══════════════════════════════════════════════════════════════════════
    await part('A field back', async () => {
      const lat = '#mn-hist-card-gatton .stn-hist-entry[data-change="7"] .stn-hist-row[data-field="lat"] button.stn-hist-put';
      db.dismissNext = true;
      await page.click(lat);
      await page.waitForTimeout(200);
      check('Restore asks first, saying what goes back — and a "no" sends nothing',
        /^Put Latitude back to “-27\.55” on Gatton Weir\?/.test(db.dialogs[0] || '') && db.saves.length === 0
          && reqs(db, 'station_json').length === 0, db.dialogs[0]);
      await page.click(lat);
      await page.waitForFunction(() => /Restored:/.test((document.querySelector('#mn-hist-card-gatton .stn-hist-msg') || {}).textContent || ''),
                                 null, { timeout: 10_000 });
      sent = db.saves[db.saves.length - 1];
      const read = reqs(db, 'station_json');
      check('…then reads the database\'s own copy of the station, and saves it through save_station() with that copy\'s stamp',
        read.length === 1 && /id=eq\.gatton/.test(read[0].search) && db.saves.length === 1
          && sent.stamp === '2026-10-03T04:12:00.000Z', J({ read, stamp: sent && sent.stamp }));
      check('…with only the latitude changed',
        sent.doc.lat === -27.55 && sent.doc.name === 'Gatton Weir' && sent.doc.owner === 'Lockyer Valley Regional Council'
          && sent.doc.notes === 'Weir rebuilt 2026' && sent.doc.lon === gatton.lon, J({ lat: sent.doc.lat, name: sent.doc.name }));
      check('…and its lists left out, for save_station() to leave alone', lists.every(k => !(k in sent.doc)),
        J(lists.filter(k => k in sent.doc)));
      S = await section(page, 'gatton');
      const mem = await page.evaluate(() => state.data.stations.find(s => s.id === 'gatton').lat);
      check('the list on screen has the latitude back, and the section says so',
        mem === -27.55 && S.msg === 'Restored: Latitude put back to “-27.55”.', J({ mem, msg: S.msg }));
      await page.waitForFunction(() => {
        const li = document.querySelector('#mn-hist-card-gatton .stn-hist-entry');
        return li && li.dataset.change !== '14';
      }, null, { timeout: 10_000 });
      S = await section(page, 'gatton');
      check('…asks for the history again, and the restore is the newest entry, pinned on whoever pressed it',
        reqs(db, 'station_change').length === 2 && S.entries[0].id === 101
          && new RegExp(`· ${EDITOR.replace(/\./g, '\\.')}$`).test(S.entries[0].head)
          && J(S.entries[0].rows.map(r => [r.field, r.was, r.became])) === J([['lat', '-27.554471', '-27.55']]), J(S.entries[0]));
      const latRow = S.entries.find(e => e.id === 7).rows.find(r => r.field === 'lat');
      check('the latitude it put back now reads "as now", with no button', latRow.button === null && latRow.note === 'as now', J(latRow));
    });

    // ═══════════════════════════════════════════════════════════════════════
    await part('A version back', async () => {
      await page.click('#mn-hist-card-gatton .stn-hist-entry[data-change="12"] button.stn-hist-version');
      await page.waitForFunction(() => /Restored: Gatton Weir put back as it was before/.test(
        (document.querySelector('#mn-hist-card-gatton .stn-hist-msg') || {}).textContent || ''), null, { timeout: 10_000 });
      const ask = db.dialogs[db.dialogs.length - 1];
      sent = db.saves[db.saves.length - 1];
      check('the confirmation names the fields, counts the later changes it undoes too',
        /4 fields: Name, Latitude, Owner, Notes\./.test(ask) && /undoes the 2 later changes listed above it/.test(ask), ask);
      check('…and says nothing of the hub, which no change since then moved', !/Hub/.test(ask), ask);
      check('sent: every field as it was before that change — the latitude as the loader left it, the owner taken out',
        sent.doc.name === 'Gatton' && sent.doc.lat === -27.554471 && !('owner' in sent.doc) && sent.doc.notes === ''
          && sent.doc.hub_id === 'brisbane' && db.saves.length === 2, J({ name: sent.doc.name, lat: sent.doc.lat, owner: sent.doc.owner, notes: sent.doc.notes }));
      C = await card(page);
      check('the card is the station put back: its old name in the title', C && C.title === 'Gatton', J(C));
      // Before the loader's change: the hub would go back too, and cannot.
      await page.waitForFunction(() => {
        const li = document.querySelector('#mn-hist-card-gatton .stn-hist-entry');
        return li && li.dataset.change === '102';
      }, null, { timeout: 10_000 });
      await page.click('#mn-hist-card-gatton .stn-hist-entry[data-change="7"] button.stn-hist-version');
      await page.waitForFunction(() => /put back as it was before/.test(
        (document.querySelector('#mn-hist-card-gatton .stn-hist-msg') || {}).textContent || '')
        && (document.querySelector('#mn-hist-card-gatton .stn-hist-entry') || {}).dataset?.change === '103',
        null, { timeout: 10_000 });
      const ask7 = db.dialogs[db.dialogs.length - 1];
      sent = db.saves[db.saves.length - 1];
      check('before the loader\'s change: the latitude goes back, and the hub stays — the confirmation says why',
        /1 field: Latitude\./.test(ask7) && /Hub stays as now — the editor's save does not write it\./.test(ask7)
          && sent.doc.lat === -27.55 && sent.doc.hub_id === 'brisbane', J({ ask7, lat: sent.doc.lat }));
    });

    // ═══════════════════════════════════════════════════════════════════════
    await part('Refused', async () => {
      await page.evaluate(() => showStationCard('laidley'));
      await page.waitForFunction(() => /last changed/.test((document.querySelector('#mn-hist-card-laidley summary') || {}).textContent || ''),
                                 null, { timeout: 10_000 });
      await page.click('#mn-hist-card-laidley summary');
      const nSaves = db.saves.length;
      await page.click('#mn-hist-card-laidley .stn-hist-row[data-field="proposed"] button.stn-hist-put');
      await page.waitForFunction(() => /Not restored/.test((document.querySelector('#mn-hist-card-laidley .stn-hist-msg') || {}).textContent || ''),
                                 null, { timeout: 10_000 });
      S = await section(page, 'laidley');
      const l2 = await page.evaluate(() => state.data.stations.find(s => s.id === 'laidley'));
      check('putting `proposed` back is sent through the same save, and refused as any editor\'s would be',
        db.saves.length === nSaves + 1 && db.saves[nSaves].doc.proposed === true, J(db.saves[nSaves] && db.saves[nSaves].doc.proposed));
      check('…said in words about administrators, and nothing changed on screen',
        /^Not restored — only an administrator establishes a proposed station/.test(S.msg) && !l2.proposed, S.msg);
    });

    // ═══════════════════════════════════════════════════════════════════════
    await part('A database without 0056', async () => {
      db.missing = true;
      const other = await page.evaluate(() => state.data.stations.find(s => !['gatton', 'laidley'].includes(s.id) && s.lat != null).id);
      await page.evaluate(id => showStationCard(id), other);
      await page.waitForFunction(id => /starts once/.test((document.getElementById(`mn-hist-card-${id}`) || {}).textContent || ''),
                                 other, { timeout: 10_000 });
      S = await section(page, other);
      C = await card(page);
      check('the section says history starts once 0056 is applied — in words, not an error',
        /History starts once db\/migrations\/0056_station_history\.sql is applied to the database/.test(S.text)
          && !/could not|error/i.test(S.text), S.text);
      check('…and the rest of the card is drawn as ever', C && C.id === other && C.groups >= 3 && C.sls, J(C));
    });

    // ═══════════════════════════════════════════════════════════════════════
    await part('Deleted stations (the Admin tab)', async () => {
      db.missing = false;
      await page.evaluate(() => switchTab('admin'));
      await page.waitForFunction(() => document.querySelectorAll('#adm-deleted tr[data-deleted]').length === 2, null, { timeout: 10_000 });
      const panel = () => page.evaluate(() => {
        const el = document.getElementById('adm-deleted');
        return {
          head: el.querySelector('h2').textContent.replace(/\s+/g, ' ').trim(),
          msg: (el.querySelector('.adm-deleted-msg').textContent || '').replace(/\s+/g, ' ').trim(),
          rows: [...el.querySelectorAll('tr[data-deleted]')].map(tr => ({ id: tr.dataset.deleted, text: tr.textContent.replace(/\s+/g, ' ').trim() })),
        };
      });
      P = await panel();
      const deletedReads = () => db.requests.filter(r => r.name === 'station' && /deleted_at=not\.is\.null/.test(r.search));
      const read2 = deletedReads();
      check('the deleted stations, read from meganet.station itself', read2.length === 1, J(read2));
      check('…each with its number, when and by whom, newest first',
        P.head === 'Deleted stations 2' && P.rows[0].id === '_gone_a' && P.rows[1].id === '_gone_b'
          && ['Old Creek AL', '_gone_a', '540999', '4 Oct 2026, 12:00 pm', 'by alice@example.test'].every(t => P.rows[0].text.includes(t)), J(P));
      await page.click('#adm-deleted tr[data-deleted="_gone_a"] button');
      await page.waitForFunction(() => /Restored Old Creek AL/.test((document.querySelector('#adm-deleted .adm-deleted-msg') || {}).textContent || ''),
                                 null, { timeout: 10_000 });
      P = await panel();
      check('Restore asks first, then calls restore_station() with the stamp the list was read with',
        /^Restore “Old Creek AL”\?/.test(db.dialogs[db.dialogs.length - 1])
          && J(db.restores[0]) === J({ p_id: '_gone_a', p_expected_updated_at: '2026-10-04T02:00:00+00:00' }), J(db.restores));
      const back = await page.evaluate(() => { const s = state.data.stations.find(x => x.id === '_gone_a'); return s ? s.name : null; });
      check('…puts it back in the list on screen, says so, and takes it off the deleted list',
        back === 'Old Creek AL' && P.msg === 'Restored Old Creek AL: it is back on the map and in the station list.'
          && P.rows.length === 1 && P.rows[0].id === '_gone_b', J({ back, P }));
      await until(() => deletedReads().length === 2);
      check('…and asks the database for the deleted stations again', deletedReads().length === 2, J(deletedReads()));
      db.refuse._gone_b = { code: '23505', details: null,
        message: 'station "_gone_b" cannot come back holding station number 40716: Laidley (laidley) has it now',
        hint: 'renumber or delete that station first, then restore this one' };
      await page.click('#adm-deleted tr[data-deleted="_gone_b"] button');
      await page.waitForFunction(() => /Not restored/.test((document.querySelector('#adm-deleted .adm-deleted-msg') || {}).textContent || ''),
                                 null, { timeout: 10_000 });
      P = await panel();
      check('a refusal is said in the database\'s words, and the station stays in the list',
        P.msg === 'Not restored — station "_gone_b" cannot come back holding station number 40716: Laidley (laidley) has it now'
          + ' — renumber or delete that station first, then restore this one. The station stays deleted.'
          && P.rows.length === 1 && !(await page.evaluate(() => state.data.stations.some(s => s.id === '_gone_b'))), P.msg);
      delete db.refuse._gone_b;
      db.missing = true;
      await page.click('#adm-deleted tr[data-deleted="_gone_b"] button');
      await page.waitForFunction(() => /0056/.test((document.querySelector('#adm-deleted .adm-deleted-msg') || {}).textContent || ''),
                                 null, { timeout: 10_000 });
      P = await panel();
      check('a database without 0056 is told so: the list is there, and Restore needs the migration',
        /^Not restored — restoring a station from here needs db\/migrations\/0056_station_history\.sql applied/.test(P.msg)
          && P.rows.length === 1, P.msg);
      db.missing = false;
      await page.evaluate(() => switchTab('stations'));
      await page.waitForFunction(() => !!state.map && state.mapMarkers.some(m => m.mnStationId === '_gone_a'), null, { timeout: LOAD_TIMEOUT })
        .catch(() => {});
      check('the restored station has its pin on the Stations map',
        await page.evaluate(() => !!state.map && state.mapMarkers.some(m => m.mnStationId === '_gone_a')));
    });

    // ═══════════════════════════════════════════════════════════════════════
    await part('Signed out again, and the write path', async () => {
      await signOut(page);
      await page.evaluate(() => showStationCard('gatton'));
      await page.waitForTimeout(250);
      check('signed out, the History section goes with the session', (await section(page, 'gatton')) === null);
      // A write to a station by any other road: a verb on a table, or one of the
      // other functions that write stations.
      const stray = db.requests.filter(r => ['PATCH', 'PUT', 'DELETE'].includes(r.method)
        || (r.method === 'POST' && !r.name.startsWith('rpc/'))
        || ['rpc/delete_station', 'rpc/load_stations_doc', 'rpc/load_stations_from_url'].includes(r.name));
      check('every station write was save_station() or restore_station() — nothing written around them',
        stray.length === 0 && db.saves.length === 4 && db.restores.length === 2, J({ stray, saves: db.saves.length, restores: db.restores.length }));
      check('the agent API does not read the change log (worker/api.js)', !READABLE_RELATIONS.has('station_change'));
    });

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
  log('\nPASS — an editor sees who changed a station, what and when, and puts a field, an earlier\n'
    + '       version or a deleted station back through the editor\'s own save; nobody else sees any of it.');
}

main().catch(err => { console.error(err); process.exit(1); });
