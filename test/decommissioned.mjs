// decommissioned.mjs — A station's own antenna height and its decommissioning
// (0125), in the browser: the station editor's two new fields, what a save
// sends, and how a decommissioned station looks afterwards.
//
//   1. A repeater, opened by an editor: the Antenna height box beside Radio
//      system, blank, saying what height the radio maths take instead; the
//      Decommissioned box on the row with Proposed and Enabled, its year
//      hidden until ticked.
//   2. An antenna height typed and Decommissioned ticked: the save sends
//      antenna_height_m, decommissioned true and this year — and the radio
//      maths (stationAntenna) take the recorded height outright.
//   3. Saved, the station is greyed: a grey pin with no health colour, a band
//      on its card saying it is out of service, its antenna height on the card,
//      a tag in the station list and on the editor's heading, and an entry in
//      the map's legend. It relays nothing any more: repeaterList leaves it out.
//   4. What is refused at the keyboard: proposed and decommissioned at once,
//      and either new field sent to a database before 0125.
//   5. Unticked, a save sends none of the three keys it no longer has.
//
// The database is a stand-in for save_station() (the real one is held to the
// same rules by tools/check_station_antenna_decommissioned.sql).
//
// Run:  npm run decommissioned
//       npm run decommissioned -- -v

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

// The stand-in: every save kept and answered with what was sent.
function fakeDatabase() {
  const db = { saves: [], stamps: new Map() };
  db.install = page => page.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: J(body) });
    if (req.method() === 'POST' && name === 'rpc/save_station') {
      const body = JSON.parse(req.postData() || '{}');
      const doc = body.p_doc || {};
      db.saves.push({ doc, stamp: body.p_expected_updated_at || null });
      const at = new Date(Date.now() + db.saves.length).toISOString();
      db.stamps.set(doc.id, at);
      return json(200, { station: { ...doc }, updated_at: at, created: false, updated_by: 'editor@example.test' });
    }
    if (req.method() === 'GET' && name === 'station') {
      const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      const row = { updated_at: db.stamps.get(id) || '2026-01-01T00:00:00+00:00', deleted_at: null };
      return json(200, /vnd\.pgrst\.object/.test(req.headers()['accept'] || '') ? row : [row]);
    }
    return json(200, []);
  });
  return db;
}

const signIn = (page, schema) => page.evaluate(schema => {
  state.dataSource = { kind: 'api', at: new Date() };
  dbSetAccessToken('test-token');
  Auth.isSignedIn = () => true;
  Auth.mayWrite = () => true;
  Auth.role = () => 'editor';
  Auth.schemaVersion = () => schema;
  rerenderStationEditorCard();
}, schema);

const form = page => page.evaluate(() => {
  const el = id => document.getElementById(id);
  const shown = e => !!e && !e.hidden && getComputedStyle(e).display !== 'none';
  return {
    heading: (document.querySelector('.ef-head h3') || {}).innerHTML || '',
    antenna: el('ef-antenna') ? { value: el('ef-antenna').value, placeholder: el('ef-antenna').placeholder } : null,
    antennaNextToRadio: !!el('ef-rmsys') && !!el('ef-antenna')
      && el('ef-rmsys').closest('.ef-field').nextElementSibling === el('ef-antenna').closest('.ef-field'),
    decom: el('ef-decom') ? { checked: el('ef-decom').checked, inFlags: !!el('ef-decom').closest('.ef-flags') } : null,
    yearShown: shown(el('ef-decom-year-wrap')), year: el('ef-decom-year') ? el('ef-decom-year').value : null,
    hintShown: shown(el('ef-decom-hint')),
    status: (el('ef-status') || {}).textContent || '',
  };
});

async function save(page, db, expectSave) {
  const before = db.saves.length;
  await page.click('#ef-save');
  if (expectSave) {
    await page.waitForFunction(() => /Saved at/.test(document.getElementById('ef-status').textContent), null, { timeout: 10_000 });
  } else {
    await page.waitForFunction(() => /Not saved/.test(document.getElementById('ef-status').textContent), null, { timeout: 10_000 });
  }
  return db.saves.length > before ? db.saves[db.saves.length - 1].doc : null;
}

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    page.on('pageerror', e => errors.push(String(e)));
    const db = fakeDatabase();
    await db.install(page);
    await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
      null, { timeout: LOAD_TIMEOUT });
    await page.evaluate(() => switchTab('stations'));
    await page.waitForFunction(() => !!state.map && state.mapMarkers.length > 0, null, { timeout: LOAD_TIMEOUT });
    await signIn(page, 125);

    // A placed repeater with a radio system, not proposed or decommissioned.
    const id = await page.evaluate(() => {
      const r = repeaterList(state.data.stations)
        .find(s => s.lat != null && s.lon != null && !s.proposed && !s.decommissioned && s.antenna_height_m == null
          && state.mapMarkers.some(m => m.mnStationId === s.id));
      return r ? r.id : null;
    });
    check('the register has a placed repeater to work on', !!id, String(id));
    if (!id) throw new Error('no repeater');

    // ── 1 ──
    log('\nThe two new fields\n');
    // Beside the map the form is behind the station's Edit (#299).
    await page.evaluate(id => { selectStation(id); editStationFromCard(id); }, id);
    await page.waitForTimeout(200);
    let F = await form(page);
    check('an Antenna height box, blank, beside Radio system', F.antenna && F.antenna.value === '' && F.antennaNextToRadio, J(F));
    check('…saying the height the radio maths take while it is blank', /not recorded — modelled at \d/.test(F.antenna.placeholder), F.antenna.placeholder);
    check('a Decommissioned box on the row with Proposed and Enabled, unticked', F.decom && !F.decom.checked && F.decom.inFlags, J(F.decom));
    check('…its year and its line hidden until it is ticked', !F.yearShown && !F.hintShown, J(F));

    // ── 2 ──
    log('\nRecorded, and decommissioned\n');
    await page.fill('#ef-antenna', '18.5');
    await page.check('#ef-decom');
    F = await form(page);
    check('ticked: its year shows, set to this year, and the line saying nothing is deleted', F.yearShown && F.year === String(YEAR) && F.hintShown, J(F));
    let doc = await save(page, db, true);
    check('the save sends the height, decommissioned and the year', doc && doc.antenna_height_m === 18.5
      && doc.decommissioned === true && doc.decommissioned_year === YEAR, J(doc && { a: doc.antenna_height_m, d: doc.decommissioned, y: doc.decommissioned_year }));
    const ant = await page.evaluate(id => { const s = state.data.stations.find(x => x.id === id); return stationAntenna(s, rmSystemOf(s)); }, id);
    check('the radio maths take the recorded 18.5 m outright', ant.agl === 18.5 && ant.recorded === true && ant.mast === false, J(ant));

    // ── 3 ──
    log('\nHow it looks\n');
    await page.evaluate(() => { refreshMapLayers(); });
    await page.waitForTimeout(200);
    const pin = await page.evaluate(id => {
      const m = state.mapMarkers.find(x => x.mnStationId === id);
      return m ? { fill: m.options.fillColor, ring: m.options.color, op: m.options.fillOpacity, want: MAP_PIN_DECOM } : null;
    }, id);
    check('its pin is greyed, fill and ring', pin && pin.fill === pin.want && pin.ring === pin.want && pin.op < 1, J(pin));
    if (await page.evaluate(id => state.selectedId !== id, id)) await page.evaluate(id => selectStation(id), id);
    await page.evaluate(id => { if (!state.stnCard.editing) editStationFromCard(id); }, id);
    await page.waitForTimeout(200);
    const card = await page.evaluate(id => {
      const el = document.getElementById('stn-card');
      const band = el && el.querySelector('.stn-card-decom');
      return el ? { band: band ? band.textContent.replace(/\s+/g, ' ').trim() : null, text: el.textContent.replace(/\s+/g, ' ') } : null;
    }, id);
    check('its card opens with a band: out of service since this year, its record kept', card && card.band
      && new RegExp(`Out of service since ${YEAR}`).test(card.band) && /kept/.test(card.band), J(card && card.band));
    check('…and shows its antenna height', card && /Antenna\s*18\.5 m above ground/.test(card.text), card && card.text.slice(0, 300));
    const row = await page.evaluate(id => {
      const box = document.createElement('div');
      box.innerHTML = stationsTable([state.data.stations.find(s => s.id === id)]);
      const tr = box.querySelector(`tr[data-sid="${CSS.escape(id)}"]`);
      return tr ? { greyed: tr.classList.contains('stn-row-decom'), tag: !!tr.querySelector('.decom-tag') } : null;
    }, id);
    check('its row in the station list is greyed and tagged', row && row.greyed && row.tag, J(row));
    await page.waitForTimeout(150);
    F = await form(page);
    check('the editor\'s heading is tagged', /decom-tag/.test(F.heading), F.heading);
    const legend = await page.evaluate(() => mapLegendHtml());
    check('the map\'s legend explains the grey pin', /legend-dot-decom/.test(legend) && /Decommissioned — kept, greyed/.test(legend));
    const relays = await page.evaluate(id => { state.repeaterIdx = null; return repeaterList(state.data.stations).some(s => s.id === id); }, id);
    check('it relays nothing: repeaterList leaves it out', relays === false);

    // ── 4 ──
    log('\nWhat is refused at the keyboard\n');
    const proposedBox = await page.$('#ef-proposed:not([disabled])');
    if (proposedBox) {
      await page.check('#ef-proposed');
      await page.selectOption('#ef-stype', { index: 1 });
      doc = await save(page, db, false);
      F = await form(page);
      check('proposed and decommissioned at once: not saved, and why', doc === null && /not both proposed and decommissioned/.test(F.status), F.status);
      await page.uncheck('#ef-proposed');
    } else {
      check('proposed and decommissioned at once: the check that refuses it', await page.evaluate(() =>
        /not both proposed and decommissioned/.test(editorDecommissionProblem({ decommissioned: true, proposed: true }) || '')));
    }
    await signIn(page, 124);
    doc = await save(page, db, false);
    F = await form(page);
    check('a database before 0125 is not sent either field: not saved, naming the file', doc === null
      && /0125_station_antenna_decommissioned\.sql/.test(F.status), F.status);
    await signIn(page, 125);

    // ── 5 ──
    log('\nBrought back\n');
    await page.uncheck('#ef-decom');
    await page.fill('#ef-antenna', '');
    F = await form(page);
    check('unticked: the year and the line are put away', !F.yearShown && !F.hintShown, J(F));
    doc = await save(page, db, true);
    check('the save sends none of the three keys', doc && !('antenna_height_m' in doc) && !('decommissioned' in doc)
      && !('decommissioned_year' in doc), J(doc && Object.keys(doc).filter(k => /antenna|decom/.test(k))));

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
  log('\nPASS — a station\'s antenna height and its decommissioning are set in the editor, sent as the\n'
    + '       database keeps them, and a decommissioned station is greyed and relays nothing.');
}

main().catch(err => { console.error(err); process.exit(1); });
