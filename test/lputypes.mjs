// A station's logger (0089): the LPU type matcher (lpu-types.js) under Node,
// then the Logger section of the station editor and the station card
// (station-lpu.js) in Chromium against a stand-in for the database.
//
//   1. **One type, however it is written** — matchKey() agrees with the
//      database's lpu_match_key(): the pattern is lifted out of
//      db/migrations/0089_station_lpu.sql, run as JavaScript and held to
//      LpuTypes.matchKey() on every input here, so the editor and the database
//      cannot disagree about which spellings are one type.
//   2. **Did you mean** — a lookalike (CR3OO), a swap (CR030, ETR-A2), a
//      letter (C300) are slips and lead with the type they slipped from; a
//      digit (CR320, ERT-A3) and a letter on the end (CR1000XE — a real
//      CR1000Xe) never do, and say once which models on the list differ the
//      same way; a typed type with a model in it (LPRO ERT A2) is offered that
//      model; one near nothing is offered nothing; a new type's make, model
//      and family are guessed from what was typed.
//   3. **The section** — signed out it says the logger is for approved
//      accounts and asks the database nothing; signed in as an editor it shows
//      the type and the fields that type has, a value the photo reader filled
//      with its 📷 chip and a Right box, and a photo that shows something else
//      with Use it. A type off the list asks first — did you mean, or is it one
//      of these — and a pick changes the fields to the new type's.
//   4. **Saving** — an unpicked type stops the save before anything is sent;
//      a new type is added only once said to be new; the station saves first,
//      then save_station_lpu() with only what changed, the Right boxes ticked
//      and the stamp the section was read with; a refusal leaves the station
//      saved and the logger's edits in their boxes, gilded as unsaved.
//   5. **The card** — an approved account sees the logger's values, a photo's
//      marked as one, and an ERT-A2's versions held to Release G.
//
// The database's own rules — who may, the stale stamp, a duplicate type, what
// the photo reader may write — are tools/check_station_lpu.sql's.
//
// Run:  npm run lputypes
//       npm run lputypes -- -v    also print what passed

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { repo } from './lib/paths.mjs';
import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const require = createRequire(import.meta.url);
const LpuTypes = require(repo('lpu-types.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
function ok(name, pass, detail = '') {
  if (pass) passes++; else failures++;
  if (!pass || VERBOSE) console.log(`  ${pass ? '✓' : '✗'} ${name}${!pass && detail ? `\n      ${detail}` : ''}`);
}
const J = v => JSON.stringify(v);

// The list as 0089 seeds it.
const MIGRATION = fs.readFileSync(repo('db/migrations/0089_station_lpu.sql'), 'utf8');
const TYPES = [...MIGRATION.matchAll(/\('([a-z0-9_]+)', '([^']+)', '([^']*)', '([^']+)', '(ert_a2|campbell|other)', (\d+),/g)]
  .map(m => ({ key: m[1], label: m[2], make: m[3], model: m[4], family: m[5], ord: Number(m[6]) }));

// ── 1. One type, however it is written ───────────────────────────────────────
console.log('\nOne type, however it is written\n');
{
  ok('the seed list read out of 0089: the ERT-A2 and ten Campbell loggers', TYPES.length === 11
    && TYPES[0].key === 'elpro_ert_a2' && TYPES.filter(t => t.family === 'campbell').length === 10, J(TYPES.map(t => t.key)));

  // lpu_match_key()'s pattern, as Postgres reads it: \m and \M are word
  // boundaries, '' is a quote inside the SQL string.
  const m = /'\\m\((.*?)\)\\M', '', 'g'\)/.exec(MIGRATION);
  ok('lpu_match_key()\'s pattern is in the migration', !!m);
  const sqlRe = m ? new RegExp(`\\b(${m[1].replace(/''/g, "'").replace(/\((?!\?)/g, '(?:')})\\b`, 'g') : /$^/;
  const sqlKey = t => String(t).toUpperCase().replace(sqlRe, '').replace(/[^A-Z0-9]/g, '');
  const inputs = ['CR 300', 'cr-300', 'Campbell Scientific CR300', "Campbell's CR300", 'CampbellScientific CR300', 'CSI cr300',
    'ELPRO ERT-A2', 'ERRTS ERT A2', 'ert a2', 'Elpro Technologies ERT-A2', 'ELPROX 1', 'CSIRO 2', 'CR1000', 'CR1000X',
    'Campbell Sci CR6', 'campbells cr310', 'LPRO ERT A2', 'OTT netDL 1000', '  ', ''];
  const differ = inputs.filter(t => sqlKey(t) !== LpuTypes.matchKey(t));
  ok(`the database's rule and LpuTypes.matchKey() agree on all ${inputs.length} spellings`, !differ.length,
    differ.map(t => `${J(t)}: sql ${sqlKey(t)} js ${LpuTypes.matchKey(t)}`).join('; '));
  ok('…which make CR300, CR300, CR300 of three spellings, and ERTA2 of ERRTS ERT A2',
    ['CR 300', 'cr-300', 'Campbell Scientific CR300'].every(t => LpuTypes.matchKey(t) === 'CR300')
    && LpuTypes.matchKey('ERRTS ERT A2') === 'ERTA2');
  ok('…and keep a make inside a word: ELPROX, CSIRO', LpuTypes.matchKey('ELPROX 1') === 'ELPROX1' && LpuTypes.matchKey('CSIRO 2') === 'CSIRO2');
  ok('every seeded type is its own: no two share a key', new Set(TYPES.map(t => LpuTypes.matchKey(t.model))).size === TYPES.length);
}

// ── 2. Did you mean ──────────────────────────────────────────────────────────
console.log('\nDid you mean\n');
{
  const R = t => LpuTypes.resolve(t, TYPES);
  const first = t => (R(t).near[0] || {}).type?.model;
  const kinds = t => R(t).near.map(n => `${n.type.model}:${n.kind}`);

  ok('spelt another way it is the type, and nothing is asked',
    ['CR 300', 'cr-300', 'Campbell Scientific CR300', 'ERT A2', 'campbells cr310', 'CR 1000x']
      .every(t => R(t).exact) && R('ERT A2').exact.key === 'elpro_ert_a2' && R('CR 1000x').exact.key === 'campbell_cr1000x');
  ok('CR3OO: a lookalike, a slip, the CR300 first', R('CR3OO').slip && first('CR3OO') === 'CR300' && R('CR3OO').near[0].kind === 'lookalike', J(kinds('CR3OO')));
  ok('CR030 and ETR-A2: swaps, slips, CR300 and the ERT-A2', R('CR030').slip && first('CR030') === 'CR300'
    && R('ETR-A2').slip && first('ETR-A2') === 'ERT-A2' && R('ETR-A2').near[0].kind === 'swapped', J([kinds('CR030'), kinds('ETR-A2')]));
  ok('C300: a letter fewer, a slip of the CR300', R('C300').slip && first('C300') === 'CR300', J(kinds('C300')));
  const d = R('CR320');
  ok('CR320: no slip — the CR300, CR310 and CR350 offered, a digit each',
    !d.slip && ['CR300', 'CR310', 'CR350'].every(x => d.near.some(n => n.type.model === x && n.kind === 'digit')), J(kinds('CR320')));
  ok('…and said once: the list has all three, each a different logger — check the label',
    /CR300, CR310 and CR350/.test(d.caution) && /different logger/.test(d.caution) && /label/.test(d.caution)
    && d.near.every(n => !/label/.test(n.why)), d.caution);
  const x = R('CR1000XE');
  ok('CR1000XE: a letter on the end is never a slip — a CR1000Xe is a logger of its own',
    !x.slip && x.near.some(n => n.type.model === 'CR1000X' && n.kind === 'suffix') && /letter on the end/.test(x.caution), J([kinds('CR1000XE'), x.caution]));
  const a3 = R('ERT-A3');
  ok('ERT-A3: a digit from the ERT-A2, offered, not corrected', !a3.slip && first('ERT-A3') === 'ERT-A2' && /ERT-A3 and ERT-A2/.test(a3.caution), a3.caution);
  ok('LPRO ERT A2: has the ERT-A2 in it, and is offered it', first('LPRO ERT A2') === 'ERT-A2' && R('LPRO ERT A2').near[0].kind === 'contains', J(kinds('LPRO ERT A2')));
  ok('CR301: the swap first (CR310), the digit (CR300) offered beside it', first('CR301') === 'CR310' && kinds('CR301').includes('CR300:digit'), J(kinds('CR301')));
  ok('CR3OO is not also "a few characters" from the CR310 and CR350 — nothing that far once something nearer is found',
    !R('CR3OO').near.some(n => n.kind === 'close'), J(kinds('CR3OO')));
  ok('netDL: near nothing on the list, offered nothing', !R('netDL').near.length && !R('netDL').exact);
  ok('at most four offered', R('CR10X').near.length <= 4, J(kinds('CR10X')));
  ok('nothing typed: nothing asked', !R('  ').exact && !R('').near.length);

  const n1 = LpuTypes.parseNew('Campbell CR1000Xe'), n2 = LpuTypes.parseNew('OTT netDL 1000'), n3 = LpuTypes.parseNew('cr 3000x');
  ok('a new type\'s make, model and family guessed from what was typed',
    n1.make === 'Campbell Scientific' && n1.model === 'CR1000Xe' && n1.family === 'campbell' && n1.label === 'Campbell Scientific CR1000Xe'
    && n2.make === '' && n2.model === 'OTT netDL 1000' && n2.family === 'other'
    && n3.make === 'Campbell Scientific' && n3.family === 'campbell', J([n1, n2, n3]));
  ok('the fields each family has: an ERT-A2\'s three, a Campbell\'s two, firmware and program for others',
    J(LpuTypes.fieldsFor({ family: 'ert_a2' })) === J(['firmware_version', 'bootloader_version', 'radio_firmware_version'])
    && J(LpuTypes.fieldsFor({ family: 'campbell' })) === J(['os_version', 'program'])
    && J(LpuTypes.fieldsFor(null)) === J(['firmware_version', 'program']));
}

// ── 3–5. In the browser ──────────────────────────────────────────────────────

const STATION_FIELDS = ['serial_no', 'firmware_version', 'bootloader_version', 'radio_firmware_version', 'os_version', 'program', 'note'];

function fakeDatabase() {
  const db = {
    requests: [], stationSaves: [], lpuSaves: [], refuseLpu: null, order: [],
    rows: {}, readings: {}, changes: {},
  };
  db.install = page => page.route('**://*.supabase.co/rest/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace(/^.*\/rest\/v1\//, '');
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: J(body) });
    const eq = k => decodeURIComponent((url.searchParams.get(k) || '').replace(/^eq\./, ''));
    db.requests.push({ method: req.method(), name });
    if (req.method() === 'GET' && name === 'lpu_type') return json(200, TYPES);
    if (req.method() === 'GET' && name === 'station_lpu') { const r = db.rows[eq('station_id')]; return json(200, r ? [r] : []); }
    if (req.method() === 'GET' && name === 'photo_reading') return json(200, db.readings[eq('station_id')] || []);
    if (req.method() === 'GET' && name === 'station_lpu_change') return json(200, db.changes[eq('station_id')] || []);
    if (req.method() === 'POST' && name === 'rpc/save_station') {
      const doc = (JSON.parse(req.postData() || '{}').p_doc) || {};
      db.stationSaves.push(doc); db.order.push('station');
      return json(200, { station: doc, updated_at: new Date(Date.now() + db.stationSaves.length).toISOString(),
                         created: false, updated_by: 'lpu-editor@example.test' });
    }
    if (req.method() === 'POST' && name === 'rpc/save_station_lpu') {
      const body = JSON.parse(req.postData() || '{}');
      db.lpuSaves.push(body); db.order.push('lpu');
      if (db.refuseLpu) return json(409, db.refuseLpu);
      const p = body.p || {};
      const was = db.rows[p.station_id] || { station_id: p.station_id, lpu_type_key: null, provenance: {} };
      const row = { ...was };
      for (const f of STATION_FIELDS) if (f in p) row[f] = p[f];
      let added = null;
      if (p.new_lpu_type) { added = 'lpu_new'; row.lpu_type_key = added; TYPES.push({ key: added, ...p.new_lpu_type, ord: 1000 }); }
      if ('lpu_type_key' in p) row.lpu_type_key = p.lpu_type_key;
      row.updated_at = '2026-10-30T05:00:00.000Z';
      db.rows[p.station_id] = row;
      return json(200, { station_lpu: row, changed: true, added_type: added });
    }
    if (req.method() === 'GET' && name === 'station') {
      const row = { updated_at: '2026-01-01T00:00:00+00:00', deleted_at: null };
      return json(200, /vnd\.pgrst\.object/.test(req.headers()['accept'] || '') ? row : [row]);
    }
    return json(200, []);
  });
  return db;
}

async function openStations(browser, server, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-AU', timezoneId: 'Australia/Brisbane' });
  const page = await context.newPage();
  await applyNetworkPolicy(page, server.origin);
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(server.url(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations), null, { timeout: LOAD_TIMEOUT });
  await page.evaluate(() => switchTab('stations'));
  await page.waitForFunction(() => !!document.getElementById('stations-editor-card'), null, { timeout: LOAD_TIMEOUT });
  return { context, page };
}

const signIn = (page, { editor = true, member = true } = {}) => page.evaluate(({ editor, member }) => {
  state.dataSource = { kind: 'api', at: new Date() };
  dbSetAccessToken(member ? 'test-token' : null);
  Auth.isSignedIn = () => member;
  Auth.isMember = () => member;
  Auth.mayWrite = () => editor;
  Auth.role = () => (editor ? 'editor' : null);
  StationLpu.authChanged();
}, { editor, member });

const section = page => page.evaluate(() => {
  const el = document.getElementById('ef-lpu');
  if (!el) return null;
  const val = id => { const b = document.getElementById(id); return b ? b.value : null; };
  return {
    id: el.dataset.efLpu, waiting: el.dataset.efLpuWaiting === '1',
    text: el.textContent.replace(/\s+/g, ' ').trim(),
    type: val('ef-lpu-type'),
    fields: [...el.querySelectorAll('[data-lpu-field]')].filter(b => !b.closest('[hidden]')).map(b => b.dataset.lpuField),
    values: Object.fromEntries([...el.querySelectorAll('[data-lpu-field]')].map(b => [b.dataset.lpuField, b.value])),
    chips: [...el.querySelectorAll('.lpu-chip')].map(c => ({ text: c.textContent.trim(), title: c.title })),
    rights: [...el.querySelectorAll('.lpu-right input')].map(b => b.id),
    differs: [...el.querySelectorAll('.lpu-differs')].map(d => d.textContent.replace(/\s+/g, ' ').trim()),
    ask: (document.getElementById('ef-lpu-ask') || {}).textContent?.replace(/\s+/g, ' ').trim() || '',
    picks: [...el.querySelectorAll('.lpu-picks button')].map(b => b.textContent.trim()),
    a2: (el.querySelector('.lpu-a2') || {}).textContent?.replace(/\s+/g, ' ').trim() || '',
    disabled: !!(document.getElementById('ef-lpu-type') || {}).disabled,
  };
});

// Typed, and the box left — which is when a person's change lands.
async function typeType(page, text) {
  await page.fill('#ef-lpu-type', text);
  await page.evaluate(() => document.getElementById('ef-lpu-type').blur());
}

async function until(fn, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end && !(await fn());) await new Promise(r => setTimeout(r, 50));
}

const server = await startServer();
const browser = await launchBrowser();
const errors = [];
try {
  const db = fakeDatabase();
  const { context, page } = await openStations(browser, server, errors);
  await db.install(page);
  const ids = await page.evaluate(() => state.data.stations.filter(s => s.roles.includes('field')).slice(0, 3).map(s => s.id));
  const [A, B] = ids;

  console.log('\nThe section, signed out and signed in\n');
  await page.evaluate(id => selectStation(id), A);
  let s = await section(page);
  ok('signed out: the logger is for approved accounts, and nothing is asked',
    s && /approved accounts/.test(s.text) && !db.requests.some(r => /lpu|photo_reading/.test(r.name)), J(s && s.text));

  // An ERT-A2 site: the type and the serial a person entered, the firmware
  // and bootloader off a photo nobody has checked, and a later photo showing
  // a newer bootloader.
  db.rows[A] = {
    station_id: A, lpu_type_key: 'elpro_ert_a2', serial_no: '20A2-1234', firmware_version: 'v1.6 Aug 25 2022 : 9814',
    bootloader_version: 'v1.1 - 8708', radio_firmware_version: '', os_version: '', program: '', note: '',
    updated_at: '2026-10-29T10:00:00.000Z', updated_by: 'agent:photo-reader',
    provenance: {
      lpu_type_key: { from: 'person', by: 'lpu-editor@example.test', at: '2026-10-20T00:00:00Z' },
      serial_no: { from: 'person', by: 'lpu-editor@example.test', at: '2026-10-20T00:00:00Z' },
      firmware_version: { from: 'photo', by: 'agent:photo-reader', photo_id: '11111111-1111-4111-8111-111111111111',
                          taken_at: '2025-03-01T00:00:00Z', confidence: 0.9, at: '2026-10-29T10:00:00Z' },
      bootloader_version: { from: 'photo', by: 'agent:photo-reader', photo_id: '11111111-1111-4111-8111-111111111111',
                            taken_at: '2025-03-01T00:00:00Z', confidence: 0.9, at: '2026-10-29T10:00:00Z',
                            checked_by: 'lpu-editor@example.test', checked_at: '2026-10-29T11:00:00Z' },
    },
  };
  db.readings[A] = [{ photo_id: '22222222-2222-4222-8222-222222222222', read_at: '2026-10-29T10:05:00Z', outcome: 'found', summary: '',
    applied: { lpu: { differed: [{ field: 'bootloader_version', recorded: 'v1.1 - 8708', read: 'v1.3 - 9967', taken_at: '2026-09-01T00:00:00Z' }] } } }];
  db.changes[A] = [{ changed_at: '2026-10-29T10:00:00Z', changed_by: 'agent:photo-reader', source: 'photo',
    photo_id: '11111111-1111-4111-8111-111111111111', before: { firmware_version: '' }, after: { firmware_version: 'v1.6 Aug 25 2022 : 9814' } }];

  await signIn(page);
  await page.evaluate(() => rerenderStationEditorCard());
  await until(async () => { const x = await section(page); return x && !x.waiting && x.type != null; });
  s = await section(page);
  ok('an editor: the type, and the ERT-A2\'s three fields under the serial', s.type === 'ELPRO ERT-A2'
    && J(s.fields) === J(['serial_no', 'firmware_version', 'bootloader_version', 'radio_firmware_version', 'note']), J(s.fields));
  ok('a photo\'s value nobody has checked: a 📷 chip whose title says so, and a Right box',
    s.chips.some(c => c.text === '📷 From a photo' && /Nobody has checked it yet/.test(c.title) && /90% sure/.test(c.title))
    && s.rights.includes('ef-lpu-check-firmware_version'), J([s.chips, s.rights]));
  ok('…one a person has checked: 📷 Checked, and no Right box', s.chips.some(c => c.text === '📷 Checked' && /lpu-editor@example\.test/.test(c.title))
    && !s.rights.includes('ef-lpu-check-bootloader_version'));
  ok('a photo that shows something else: said under the box, with Use it', s.differs.some(t => /shows “v1\.3 - 9967”/.test(t) && /Use it/.test(t)), J(s.differs));
  ok('the versions held to Release G: what is behind is named', /behind Release G/.test(s.a2) && /Firmware/.test(s.a2), s.a2);
  const unsaved0 = await page.evaluate(() => document.getElementById('stations-editor-card').classList.contains('is-unsaved'));
  ok('drawn from the record, nothing is unsaved', !unsaved0);

  console.log('\nA type off the list\n');
  await typeType(page, 'CR320');
  s = await section(page);
  ok('CR320: is it one of these — the CR300, CR310 and CR350 — and a word that a digit may be a different logger',
    /Is it one of these\?/.test(s.ask) && ['Campbell Scientific CR300', 'Campbell Scientific CR310', 'Campbell Scientific CR350'].every(x => s.picks.includes(x))
    && /different logger/.test(s.ask) && /add “CR320” as a new type/.test(s.ask), J([s.ask, s.picks]));
  const blocked = await page.evaluate(() => StationLpu.formProblem());
  ok('…and while it is neither picked nor added, the save is stopped with a sentence', /not on the list/.test(blocked), blocked);
  const before = db.stationSaves.length;
  await page.evaluate(() => editorSave());
  ok('…before anything is sent', db.stationSaves.length === before && !db.lpuSaves.length);

  await typeType(page, 'CR3OO');
  s = await section(page);
  ok('CR3OO: did you mean the CR300', /Did you mean this\?/.test(s.ask) && s.picks[0] === 'Campbell Scientific CR300', J([s.ask, s.picks]));
  await page.click('.lpu-picks button');
  s = await section(page);
  ok('picked: the box says the CR300, the question goes, and the fields are a Campbell\'s — the ERT-A2\'s recorded versions still shown',
    s.type === 'Campbell Scientific CR300' && !s.ask && s.fields.includes('os_version') && s.fields.includes('program')
    && s.fields.includes('firmware_version') && !s.fields.includes('radio_firmware_version'), J([s.type, s.ask, s.fields]));
  const gilt = await page.evaluate(() => [...document.querySelectorAll('#stations-editor-card .ef-changed')].map(e => e.id));
  ok('…and the unsaved bar counts the type', gilt.includes('ef-lpu-type'), J(gilt));

  await typeType(page, 'OTT netDL 1000');
  s = await section(page);
  ok('a type near nothing: not on the list, nothing close, and the way to add it', /nothing on it is close/.test(s.ask) && /add “OTT netDL 1000” as a new type/.test(s.ask), s.ask);
  await page.click('#ef-lpu-ask .link-btn');
  await page.fill('#ef-lpu-new-make', 'OTT HydroMet');
  await page.fill('#ef-lpu-new-model', 'netDL 1000');
  await page.selectOption('#ef-lpu-new-family', 'other');
  await page.click('#ef-lpu-ask .lpu-add button:not(.link-btn)');
  s = await section(page);
  ok('added as new: the box holds it, and it is said to be added when the station saves', s.type === 'OTT HydroMet netDL 1000'
    && /New type — OTT HydroMet netDL 1000/.test(s.ask) && /when you save/.test(s.ask), J(s));

  await page.fill('#ef-lpu-program', 'BOM_HYD v3.2');
  await page.check('#ef-lpu-check-firmware_version');
  await page.evaluate(() => editorSave());
  await until(() => db.lpuSaves.length > 0);
  const sent = db.lpuSaves[0] || {};
  ok('saved: the station first, then the logger', J(db.order) === J(['station', 'lpu']), J(db.order));
  ok('…the new type with confirm_new, only the field that changed, the Right box, and the stamp it was read with',
    J(sent.p && sent.p.new_lpu_type) === J({ label: 'OTT HydroMet netDL 1000', make: 'OTT HydroMet', model: 'netDL 1000', family: 'other', confirm_new: true })
    && sent.p.program === 'BOM_HYD v3.2' && !('serial_no' in sent.p) && !('firmware_version' in sent.p)
    && J(sent.p.checked) === J(['firmware_version']) && sent.p_expected === '2026-10-29T10:00:00.000Z' && sent.p.station_id === A, J(sent));
  await until(async () => /logger details/.test(await page.evaluate(() => (document.getElementById('ef-status') || {}).textContent || '')));
  const st = await page.evaluate(() => (document.getElementById('ef-status') || {}).textContent.replace(/\s+/g, ' ').trim());
  ok('…and the editor says so', /Saved, with the logger details, with a new LPU type on the list,/.test(st), st);

  console.log('\nRefused\n');
  db.refuseLpu = { code: 'PT409', message: 'this station\'s logger details were changed at 2026-10-30 by somebody, after you opened them — reload to see what changed' };
  await page.evaluate(id => selectStation(id), B);
  await until(async () => { const x = await section(page); return x && !x.waiting && x.type != null && x.id === B; });
  await page.fill('#ef-lpu-serial_no', 'SN 777');
  await page.evaluate(() => editorSave());
  await until(() => db.lpuSaves.length > 1);
  await until(async () => /logger details did not/.test(await page.evaluate(() => (document.getElementById('ef-status') || {}).textContent || '')));
  const refused = await page.evaluate(() => ({
    status: document.getElementById('ef-status').textContent.replace(/\s+/g, ' ').trim(),
    serial: document.getElementById('ef-lpu-serial_no').value,
    gilt: [...document.querySelectorAll('#stations-editor-card .ef-changed')].map(e => e.id),
  }));
  ok('a refused save: the station saved, the logger not, in words', /station saved; its logger details did not/.test(refused.status), refused.status);
  ok('…and the serial typed is still in its box, gilded as unsaved', refused.serial === 'SN 777' && refused.gilt.includes('ef-lpu-serial_no'), J(refused));
  db.refuseLpu = null;

  console.log('\nThe card\n');
  await page.evaluate(id => { state.stnCard.id = id; repaintStnCard(); }, A);
  await until(async () => !!(await page.evaluate(id => (document.getElementById(`mn-lpu-card-${id}`) || {}).textContent, A)));
  const cardText = await page.evaluate(id => document.getElementById(`mn-lpu-card-${id}`).textContent.replace(/\s+/g, ' ').trim(), A);
  ok('the station card: the logger\'s type and values, a photo\'s marked as one', /Logger — the station’s LPU/.test(cardText)
    && /OTT HydroMet netDL 1000/.test(cardText) && /BOM_HYD v3\.2/.test(cardText) && /📷/.test(cardText), cardText);

  await signIn(page, { editor: false, member: false });
  await page.evaluate(() => repaintStnCard());
  const gone = await page.evaluate(id => !!document.getElementById(`mn-lpu-card-${id}`), A);
  ok('signed out, the card has no Logger section', !gone);

  // A phone's width: nothing in the section scrolls the page sideways.
  await signIn(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.evaluate(id => selectStation(id), A);
  await until(async () => { const x = await section(page); return x && !x.waiting && x.type != null; });
  const over = await page.evaluate(() => { const el = document.getElementById('ef-lpu'); return el ? el.scrollWidth - el.clientWidth : -1; });
  ok('375 px: the section does not overflow', over <= 1, String(over));

  ok('nothing threw', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passes + failures} assertion(s), ${failures} failed.`);
if (failures) process.exit(1);
