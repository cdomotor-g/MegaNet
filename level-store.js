// MegaNet — level-store.js
//
//   LevelStore   where the level surveys, two-peg tests, levels and staffs and
//                the pictures behind each reading are kept on the device, and
//                how they reach Flood-Net: sent by themselves, in order, when
//                there is a signal and somebody signed in to send them as.
//
// After core.js, datastore.js and levelling.js, before level-camera.js,
// level-survey.js and two-peg.js, which call it — index.html holds the order.
// Reaches back to datastore.js for dbRpc, dbSelect, dbCanWrite, dbUploadObject
// and dbSignedUrl; to auth.js for Auth; to levelling.js for Levelling. All of
// them from inside functions; nothing runs at load (`npm run toplevel`).
// init.js calls boot(), which opens what this device keeps and sends whatever
// is waiting.
//
// ── Kept first ───────────────────────────────────────────────────────────────
// A gauging station is often somewhere without a signal, and a survey that
// lives only in a page's memory is a survey lost when the phone locks. So
// every change is written to IndexedDB the moment it is made — `surveys`,
// `tests` and `kit` (one document each), `evidence` (a picture's record) and
// `bytes` (the picture, as an ArrayBuffer: older Safari would not store a
// Blob). Without IndexedDB (some private windows) they are held in this page
// only, and the tabs say so.
//
// ── Then sent ────────────────────────────────────────────────────────────────
// A document marked to send waits until it can go, then goes by the doors
// 0060 opened, one thing at a time and in an order that never sends a survey
// ahead of what it names: the level and staff first (level_equipment_save —
// a unit another phone already filed comes back as that one, and the survey is
// filed under it), then the two-peg test, then the survey or test itself, then
// each of its pictures — the bytes into the private `level-surveys` bucket,
// then their record (level_evidence_add). Every step can be sent again: a
// picture already in the bucket is taken as sent, a record already there
// changes nothing. It goes when somebody is signed in and the network answers;
// failing that it waits, and is tried again when the browser says the
// network is back, when somebody signs in, when the app is opened, or on a
// back-off of fifteen seconds to ten minutes. A refusal says why on the
// document and stops it until it is changed.
//
// A database that does not have 0060 yet answers "no such function"; that is
// said plainly (the survey waits on the device, and exports work) rather than
// taken for a refusal.
//
// Practice documents are never sent.

const LevelStore = (function () {
  const DB_NAME = 'mn-levels';
  const BUCKET = 'level-surveys';
  const PREFS_KEY = 'mn-levels';
  const RETRY_MS = [15e3, 30e3, 60e3, 120e3, 300e3, 600e3];
  const KINDS = ['surveys', 'tests', 'kit'];

  let dbP = null, memOnly = false, booted = false, loading = null;
  const mem = { surveys: new Map(), tests: new Map(), kit: new Map(), evidence: new Map(), bytes: new Map() };
  const cache = { surveys: new Map(), tests: new Map(), kit: new Map(), evidence: new Map() };
  const listeners = new Set();
  const urls = new Map();
  let pumping = false, pumpTimer = 0, persistAsked = false;
  let lastNote = '';

  // ── IndexedDB ──────────────────────────────────────────────────────────────

  function db() {
    if (dbP) return dbP;
    dbP = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('this browser keeps no database')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (err) { reject(err); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of [...KINDS, 'evidence']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
        if (!d.objectStoreNames.contains('bytes')) d.createObjectStore('bytes');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('the database would not open'));
      req.onblocked = () => reject(new Error('the database is held by another tab'));
    });
    dbP.catch(() => { memOnly = true; });
    return dbP;
  }
  function tx(stores, mode, fn) {
    return db().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error || new Error('the database refused it'));
      t.onabort = () => reject(t.error || new Error('the database gave up — the device may be out of space'));
      out = fn(t);
    }));
  }
  function getAll(store) {
    if (memOnly) return Promise.resolve([...mem[store].values()]);
    return tx([store], 'readonly', t => {
      const o = { list: [] };
      const r = t.objectStore(store).getAll();
      r.onsuccess = () => { o.list = r.result || []; };
      return o;
    }).then(o => o.list);
  }
  function putRow(store, row) {
    if (memOnly) { mem[store].set(row.id, row); return Promise.resolve(); }
    return tx([store], 'readwrite', t => { t.objectStore(store).put(row); })
      .catch(err => { if (memOnly) { mem[store].set(row.id, row); return; } throw err; });
  }
  function delRow(store, id) {
    if (memOnly) { mem[store].delete(id); return Promise.resolve(); }
    return tx([store], 'readwrite', t => { t.objectStore(store).delete(id); }).catch(() => {});
  }
  function putBytes(id, u8) {
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    if (memOnly) { mem.bytes.set(id, buf); return Promise.resolve(); }
    return tx(['bytes'], 'readwrite', t => { t.objectStore('bytes').put(buf, id); })
      .catch(err => { if (memOnly) { mem.bytes.set(id, buf); return; } throw err; });
  }
  function getBytes(id) {
    if (memOnly) { const b = mem.bytes.get(id); return Promise.resolve(b ? new Uint8Array(b) : null); }
    return tx(['bytes'], 'readonly', t => {
      const o = { v: null };
      const r = t.objectStore('bytes').get(id);
      r.onsuccess = () => { o.v = r.result ? new Uint8Array(r.result) : null; };
      return o;
    }).then(o => o.v).catch(() => null);
  }
  function delBytes(id) {
    if (memOnly) { mem.bytes.delete(id); return Promise.resolve(); }
    return tx(['bytes'], 'readwrite', t => { t.objectStore('bytes').delete(id); }).catch(() => {});
  }

  // Ask the browser to keep this site's storage through a clear-out: a phone
  // short of space evicts a site's data otherwise, a day's surveys with it.
  function persistStorage() {
    if (persistAsked || typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }

  // ── Loading and listening ──────────────────────────────────────────────────

  function load() {
    if (loading) return loading;
    loading = Promise.all([...KINDS, 'evidence'].map(s => getAll(s).catch(() => {
      memOnly = true;
      return [...mem[s].values()];
    }).then(list => {
      cache[s].clear();
      for (const row of list) cache[s].set(row.id, row);
    }))).then(() => { changed(); });
    return loading;
  }
  function ready() { return load(); }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  let changeQueued = false;
  function changed() {
    if (changeQueued) return;
    changeQueued = true;
    Promise.resolve().then(() => {
      changeQueued = false;
      for (const fn of [...listeners]) { try { fn(); } catch (_) { /* a listener's fault is its own */ } }
    });
  }

  // ── Documents ──────────────────────────────────────────────────────────────

  function list(kind) {
    return [...cache[kind].values()].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }
  function get(kind, id) { return cache[kind].get(id) || null; }

  // Keep a document. `touch` stamps it as changed now — and a document that
  // had been sent is marked to send again, unless it is one the database
  // keeps as a record.
  async function put(kind, doc, opts = {}) {
    if (!doc || !doc.id) throw new Error('a document needs an id');
    if (opts.touch !== false) {
      doc.updated_at = new Date().toISOString();
      const s = doc.sync || {};
      if (s.state === 'sent' && !(s.server && s.server.status === 'applied') && opts.resend !== false) {
        doc.sync = Object.assign({}, s, { state: 'draft', note: 'Changed since it was sent — send it again.' });
      }
    }
    cache[kind].set(doc.id, doc);
    persistStorage();
    changed();
    await putRow(kind, JSON.parse(JSON.stringify(doc)));
    return doc;
  }

  async function remove(kind, id) {
    cache[kind].delete(id);
    for (const e of evidenceOf(id)) await dropEvidence(e.id);
    changed();
    await delRow(kind, id);
  }

  // ── Pictures ───────────────────────────────────────────────────────────────
  // meta: { id, owner ('survey' | 'two-peg' | 'kit'), owner_id, row_id, field,
  //         kind ('reading' | 'photo' | 'label'), type, width, height,
  //         ocr_text, value_m, taken_at, lat, lon, acc, sha256 }

  async function addEvidence(meta, bytes) {
    const row = Object.assign({ id: Levelling.newId(), status: 'local', at: new Date().toISOString() }, meta,
                              { bytes: bytes ? bytes.length : 0 });
    cache.evidence.set(row.id, row);
    changed();
    if (bytes) await putBytes(row.id, bytes);
    await putRow('evidence', row);
    persistStorage();
    return row;
  }
  async function saveEvidence(row) {
    cache.evidence.set(row.id, row);
    changed();
    await putRow('evidence', row);
  }
  function evidenceOf(ownerId) {
    return [...cache.evidence.values()].filter(e => e.owner_id === ownerId)
      .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  }
  function evidence(id) { return cache.evidence.get(id) || null; }
  async function dropEvidence(id) {
    cache.evidence.delete(id);
    const u = urls.get(id);
    if (u) { URL.revokeObjectURL(u); urls.delete(id); }
    changed();
    await delRow('evidence', id);
    await delBytes(id);
  }
  function bytesOf(id) { return getBytes(id); }
  // An object URL for a picture kept here, made once.
  async function urlOf(id) {
    if (urls.has(id)) return urls.get(id);
    const e = evidence(id);
    const b = await getBytes(id);
    if (!b) return null;
    const u = URL.createObjectURL(new Blob([b], { type: (e && e.type) || 'image/jpeg' }));
    urls.set(id, u);
    return u;
  }
  const extOf = type => (type === 'image/webp' ? 'webp' : type === 'image/png' ? 'png' : 'jpg');
  function pathOf(e) { return `${e.owner}/${e.owner_id}/${e.id}.${extOf(e.type)}`; }

  // ── Preferences ────────────────────────────────────────────────────────────
  // The crew's names and organisation, the last level and staff, and a few
  // switches — remembered so the next survey starts filled in.
  function prefs() {
    try { return Object.assign({ ocr: true, keepCrops: true, autoSend: true }, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); }
    catch (_) { return { ocr: true, keepCrops: true, autoSend: true }; }
  }
  function setPrefs(patch) {
    const p = Object.assign(prefs(), patch || {});
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) { /* a private window: kept for this page only */ }
    return p;
  }

  // ── Who may send, and is anything waiting ──────────────────────────────────

  function signedIn() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn && Auth.isSignedIn() && (typeof dbCanWrite !== 'function' || dbCanWrite());
  }
  function online() { return typeof navigator === 'undefined' || navigator.onLine !== false; }

  const WAITING = new Set(['waiting', 'failed', 'sign-in', 'not-ready']);
  function waitingDocs() {
    const out = [];
    for (const kind of KINDS) for (const d of cache[kind].values()) if (d.sync && WAITING.has(d.sync.state) && !d.practice) out.push({ kind, d });
    return out;
  }
  function status() {
    const all = [];
    for (const kind of KINDS) for (const d of cache[kind].values()) all.push(d.sync || {});
    const count = s => all.filter(x => x.state === s).length;
    const pics = [...cache.evidence.values()].filter(e => e.status !== 'sent' && e.owner !== 'kit');
    return {
      waiting: count('waiting') + count('failed'), signIn: count('sign-in'), notReady: count('not-ready'),
      sending: count('sending'), refused: count('refused'), sent: count('sent'),
      pictures: pics.length, signedIn: signedIn(), online: online(), memOnly, note: lastNote,
    };
  }

  // Mark a document to be sent, and send it now if it can go.
  async function queue(kind, id) {
    const d = get(kind, id);
    if (!d || d.practice) return;
    d.sync = Object.assign({}, d.sync, { state: 'waiting', tries: 0, next: 0, note: '' });
    await put(kind, d, { touch: false });
    pump(true);
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  // A network that is not there answers with a TypeError, or a status no
  // database gave; a database that said no answers with its SQLSTATE.
  function isOffline(err) {
    return err instanceof TypeError || !err || !err.status || err.status >= 500 || err.status === 408 || err.status === 429;
  }
  function isMissing(err) {
    return !!err && (err.code === 'PGRST202' || err.code === '42883' || err.bucketMissing
                     || (err.status === 404 && /function|schema cache/i.test(err.message || '')));
  }

  async function pump(force) {
    if (pumping) return;
    clearTimeout(pumpTimer);
    if (!booted) return;
    if (!force && !prefs().autoSend) { changed(); return; }
    pumping = true;
    try {
      // Levels and staffs first: a survey names them.
      for (const k of list('kit').filter(x => x.sync && WAITING.has(x.sync.state))) {
        if (!signedIn()) break;
        const r = await sendKit(k, force);
        if (r === 'stop') break;
      }
      for (;;) {
        const now = Date.now();
        const next = waitingDocs()
          .filter(x => x.kind !== 'kit')
          .filter(x => force || !x.d.sync.next || x.d.sync.next <= now)
          .sort((a, b) => (a.kind === 'tests' ? 0 : 1) - (b.kind === 'tests' ? 0 : 1)
                       || String(a.d.updated_at || '').localeCompare(String(b.d.updated_at || '')))[0];
        if (!next) break;
        if (!signedIn()) {
          for (const x of waitingDocs()) {
            if (x.d.sync.state !== 'sign-in') { x.d.sync = Object.assign({}, x.d.sync, { state: 'sign-in', note: 'Waiting for somebody to sign in.' }); await put(x.kind, x.d, { touch: false }); }
          }
          break;
        }
        const out = await sendDoc(next.kind, next.d);
        if (out === 'stop') break;
        force = false;
      }
    } finally {
      pumping = false;
    }
    changed();
    const later = waitingDocs().map(x => x.d.sync.next || 0).filter(Boolean);
    if (later.length) pumpTimer = setTimeout(() => pump(), Math.max(1000, Math.min(...later) - Date.now()));
  }

  async function setSync(kind, d, patch) {
    d.sync = Object.assign({}, d.sync, patch);
    await put(kind, d, { touch: false });
  }

  // What became of a failed attempt — 'stop' when nothing else can go either.
  async function failed(kind, d, err) {
    const tries = ((d.sync && d.sync.tries) || 0) + 1;
    if (isMissing(err)) {
      lastNote = 'Flood-Net\'s database does not take level surveys yet (migration 0060 and the level-surveys bucket). Kept on this device — export it meanwhile.';
      await setSync(kind, d, { state: 'not-ready', tries, next: Date.now() + RETRY_MS[RETRY_MS.length - 1], note: lastNote });
      return 'stop';
    }
    if (err && err.denied && !(err.code === '42501')) {
      await setSync(kind, d, { state: 'sign-in', tries, note: 'Sign in again to send it.' });
      return 'stop';
    }
    if (isOffline(err)) {
      await setSync(kind, d, { state: 'failed', tries, next: Date.now() + RETRY_MS[Math.min(tries - 1, RETRY_MS.length - 1)],
                               note: 'No answer from Flood-Net — it will try again.' });
      return 'stop';
    }
    if (err && err.code === '55000') {
      await setSync(kind, d, { state: 'sent', note: String(err.message || 'Applied at its station — it no longer changes.'),
                               server: Object.assign({}, d.sync && d.sync.server, { status: 'applied' }) });
      return 'next';
    }
    const why = String((err && err.message) || err || 'refused');
    await setSync(kind, d, { state: 'refused', tries, note: err && err.code === '42501'
      ? `Flood-Net would not take it from this account: ${why}` : `Flood-Net would not take it: ${why}` });
    return err && err.code === '42501' ? 'stop' : 'next';
  }

  async function sendKit(k, force) {
    if (!force && k.sync.next && k.sync.next > Date.now()) return 'next';
    try {
      const body = { id: k.id, kind: k.kind || 'level', make: k.make || '', model: k.model || '', serial: k.serial || '',
                     service_date: k.service_date || '', note: k.note || '', retired: !!k.retired };
      const out = await dbRpc('level_equipment_save', { p: body });
      const dup = out && out.duplicate_of;
      if (dup && dup !== k.id) {
        // Another phone filed this unit first: adopt its id everywhere here.
        const server = out.equipment || {};
        const merged = Object.assign({}, k, { id: dup, make: server.make, model: server.model, serial: server.serial,
                                              service_date: server.service_date || k.service_date || '',
                                              sync: { state: 'sent', at: new Date().toISOString() } });
        await put('kit', merged, { touch: false });
        await remove('kit', k.id);
        for (const kind of ['surveys', 'tests']) {
          for (const d of list(kind)) {
            let hit = false;
            if (d.instrument && d.instrument.id === k.id) { d.instrument.id = dup; hit = true; }
            if (d.staff && d.staff.id === k.id) { d.staff.id = dup; hit = true; }
            if (hit) await put(kind, d, { touch: false });
          }
        }
      } else {
        await setSync('kit', k, { state: 'sent', at: new Date().toISOString(), note: '' });
      }
      return 'next';
    } catch (err) {
      return failed('kit', k, err);
    }
  }

  async function sendDoc(kind, d) {
    // What it names, first.
    const ids = [d.instrument && d.instrument.id, d.staff && d.staff.id].filter(Boolean);
    for (const id of ids) {
      const k = get('kit', id);
      if (k && k.sync && WAITING.has(k.sync.state)) {
        const r = await sendKit(k, true);
        if (r === 'stop') return failed(kind, d, Object.assign(new Error(k.sync.note || 'its equipment could not be sent'), { status: 0 }));
      }
    }
    if (kind === 'surveys' && d.peg_test && d.peg_test.id) {
      const t = get('tests', d.peg_test.id);
      if (t && !t.practice && (!t.sync || t.sync.state !== 'sent')) {
        if (!t.sync || t.sync.state === 'draft') t.sync = Object.assign({}, t.sync, { state: 'waiting' });
        const r = await sendDoc('tests', t);
        if (r === 'stop') return 'stop';
      }
    }
    await setSync(kind, d, { state: 'sending', note: 'Sending…' });
    try {
      const body = JSON.parse(JSON.stringify(d));
      delete body.sync;
      if (kind === 'surveys') {
        const red = Levelling.reduce(body);
        body.result = {
          closed: red.closed && red.closesOnBm, misclose: red.misclose, within: red.within, agree: red.checks.agree,
          errors: red.errors, warnings: red.warnings, cps: red.cps, gauge_zero: red.gaugeZero.rl,
          sums: red.sums, app: typeof APP_VERSION !== 'undefined' ? APP_VERSION : '',
        };
        if (!body.result.closed) body.result.misclose = null;
        const out = await dbRpc('level_survey_save', { p: body });
        d.sync = Object.assign({}, d.sync, { server: out && out.survey ? {
          status: out.survey.status, outcome: out.survey.outcome, misclose: out.survey.misclose_m } : null });
      } else {
        const out = await dbRpc('two_peg_test_save', { p: body });
        d.sync = Object.assign({}, d.sync, { server: out && out.test ? { error: out.test.error_m, passed: out.test.passed } : null });
      }
    } catch (err) {
      return failed(kind, d, err);
    }
    // Its pictures.
    const owner = kind === 'surveys' ? 'survey' : 'two-peg';
    for (const e of evidenceOf(d.id)) {
      if (e.status === 'sent') continue;
      try {
        if (e.status !== 'uploaded') {
          const b = await getBytes(e.id);
          if (b) {
            try {
              await dbUploadObject(BUCKET, pathOf(Object.assign({}, e, { owner })), new Blob([b], { type: e.type || 'image/jpeg' }));
            } catch (err) {
              if (!(err && (err.status === 409 || /already exists|duplicate/i.test(err.message || '')))) throw err;
            }
          }
          e.status = 'uploaded';
          await saveEvidence(e);
        }
        await dbRpc('level_evidence_add', { p: {
          id: e.id, owner, owner_id: d.id, row_id: e.row_id || null, field: e.field || null, kind: e.kind || 'photo',
          storage_path: pathOf(Object.assign({}, e, { owner })), content_type: e.type || 'image/jpeg', byte_size: e.bytes || 1,
          width: e.width || null, height: e.height || null, sha256: e.sha256 || null, ocr_text: e.ocr_text || null,
          value_m: e.value_m == null ? null : e.value_m, taken_at: e.taken_at || null,
          lat: e.lat == null ? null : e.lat, lon: e.lon == null ? null : e.lon, accuracy_m: e.acc == null ? null : e.acc,
        } });
        e.status = 'sent';
        await saveEvidence(e);
      } catch (err) {
        return failed(kind, d, err);
      }
    }
    lastNote = '';
    await setSync(kind, d, { state: 'sent', at: new Date().toISOString(), tries: 0, next: 0, note: '' });
    return 'next';
  }

  // ── Levels and staffs ──────────────────────────────────────────────────────
  // The register is shared: what this device has, merged with what Flood-Net
  // has (pulled when signed in). A unit changed here and not yet sent wins over
  // the database's copy of it.

  async function saveKit(item) {
    const k = Object.assign({ id: Levelling.newId(), kind: 'level', make: '', model: '', serial: '', service_date: '', note: '' }, item);
    k.sync = { state: 'waiting', tries: 0, next: 0 };
    await put('kit', k);
    pump(true);
    return k;
  }
  async function retireKit(id) {
    const k = get('kit', id);
    if (!k) return;
    k.retired = true;
    k.sync = { state: 'waiting', tries: 0, next: 0 };
    await put('kit', k);
    pump(true);
  }
  function kit(kind) {
    return list('kit').filter(k => !k.retired && (!kind || (k.kind || 'level') === kind))
      .sort((a, b) => String(b.last_used || '').localeCompare(String(a.last_used || '')) || Levelling.kitLabel(a).localeCompare(Levelling.kitLabel(b)));
  }
  async function usedKit(id) {
    const k = get('kit', id);
    if (!k) return;
    k.last_used = new Date().toISOString();
    await put('kit', k, { touch: false });
  }
  async function pullKit() {
    if (!signedIn()) return 0;
    let rows;
    try { rows = await dbSelect('level_equipment?select=id,kind,make,model,serial,service_date,note,updated_at,retired_at&order=updated_at.desc&limit=500'); }
    catch (_) { return 0; }
    let n = 0;
    for (const r of rows) {
      const mine = get('kit', r.id);
      if (mine && mine.sync && WAITING.has(mine.sync.state)) continue;
      const k = Object.assign({}, mine || {}, { id: r.id, kind: r.kind, make: r.make, model: r.model, serial: r.serial,
        service_date: r.service_date || '', note: r.note || '', retired: !!r.retired_at, sync: { state: 'sent' } });
      await put('kit', k, { touch: false });
      n++;
    }
    return n;
  }

  // ── Flood-Net's side ───────────────────────────────────────────────────────

  const SURVEY_COLS = 'id,station_id,station_number,station_name,survey_date,datum,bm_name,outcome,misclose_m,tolerance_m,rows_n,status,submitted_by,submitted_at,decided_by,decided_at,decision_note';
  function serverSurveys(o = {}) {
    const q = [`select=${SURVEY_COLS}`, 'order=submitted_at.desc', `limit=${o.limit || 50}`];
    if (o.station) q.push(`station_id=eq.${encodeURIComponent(o.station)}`);
    if (o.status) q.push(`status=eq.${encodeURIComponent(o.status)}`);
    return dbSelect(`level_survey?${q.join('&')}`);
  }
  async function serverSurvey(id) {
    const rows = await dbSelect(`level_survey?select=${SURVEY_COLS},doc&id=eq.${encodeURIComponent(id)}`);
    return rows[0] || null;
  }
  function serverEvidence(ownerId, owner = 'survey') {
    const col = owner === 'survey' ? 'survey_id' : 'two_peg_test_id';
    return dbSelect(`level_evidence?select=id,row_id,field,kind,storage_path,content_type,byte_size,width,height,ocr_text,value_m,taken_at,lat,lon&${col}=eq.${encodeURIComponent(ownerId)}&order=taken_at.asc`);
  }
  function serverTests(o = {}) {
    const q = ['select=id,equipment_id,tested_on,a1,b1,a2,b2,spacing_m,near_m,tolerance_m,error_m,passed,submitted_by,submitted_at,doc',
               'order=tested_on.desc', `limit=${o.limit || 30}`];
    if (o.equipment) q.push(`equipment_id=eq.${encodeURIComponent(o.equipment)}`);
    return dbSelect(`two_peg_test?${q.join('&')}`);
  }
  async function stationControl(stationId) {
    const id = encodeURIComponent(stationId);
    const [points, offsets] = await Promise.all([
      dbSelect(`station_level_point?select=*&station_id=eq.${id}&superseded_at=is.null&order=kind.asc,name.asc`),
      dbSelect(`station_level_offset?select=*&station_id=eq.${id}&order=valid_from.desc&limit=5`),
    ]);
    return { points, offsets };
  }
  function decisions(surveyId) {
    return dbSelect(`level_survey_decision?select=*&survey_id=eq.${encodeURIComponent(surveyId)}&order=decided_at.desc`);
  }
  function apply(surveyId, changes, note) {
    return dbRpc('level_survey_apply', { p_survey: surveyId, p_changes: changes, p_note: note || null });
  }
  function giveBack(surveyId, note) {
    return dbRpc('level_survey_return', { p_survey: surveyId, p_note: note });
  }
  function signedUrls(paths) {
    return typeof dbSignedUrls === 'function' ? dbSignedUrls(BUCKET, paths, 3600) : Promise.resolve({});
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  function boot() {
    if (booted) return;
    booted = true;
    load().then(async () => {
      // Anything caught half-way when the page went is waiting again.
      for (const kind of KINDS) {
        for (const d of cache[kind].values()) {
          if (d.sync && d.sync.state === 'sending') await setSync(kind, d, { state: 'waiting', note: '' });
        }
      }
      pump();
    }).catch(() => {});
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => pump(true));
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pump(); });
    }
  }
  // Somebody signed in or out: what was waiting for them goes now.
  function authChanged() {
    if (!booted) return;
    for (const x of waitingDocs()) if (x.d.sync.state === 'sign-in') x.d.sync.state = 'waiting';
    pump(true);
    pullKit().catch(() => {});
  }

  return {
    BUCKET, boot, ready, onChange, list, get, put, remove, queue, pump, status, authChanged,
    addEvidence, saveEvidence, evidenceOf, evidence, dropEvidence, bytesOf, urlOf, pathOf,
    prefs, setPrefs, signedIn,
    saveKit, retireKit, kit, usedKit, pullKit,
    serverSurveys, serverSurvey, serverEvidence, serverTests, stationControl, decisions, apply, giveBack, signedUrls,
    _isMissing: isMissing,
  };
})();

if (typeof window !== 'undefined') window.LevelStore = LevelStore;
