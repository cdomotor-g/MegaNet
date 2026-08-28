// MegaNet — datastore.js
//
//   the datastore client   the browser's whole PostgREST layer. dbPing and
//                          dbCheck for "is it reachable and the shape this app
//                          expects", dbSelect and dbRpc for reads,
//                          dbSaveStation and dbDeleteStation for writes,
//                          dbSetAccessToken for the token, and
//                          snapshotStationsJson for the stations.json export
//                          that keeps the offline copy from drifting into
//                          fiction. Plus the status panel and the editor's
//                          status line, which report all of it.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for DB_URL, DB_ANON_KEY, DB_SCHEMA,
// DB_SCHEMA_VERSION, _dbClock, dbHostLabel, state, esc and dlText; across to
// app.js for SOURCE_LABELS and loadFromApi; and to auth.js for Auth, which
// reaches back here for dbSetAccessToken.
//
// This was three banner sections of app.js with the Export tab sitting in the
// middle of them; they are joined here because they are one concern. The seam
// that did not move: renderDbStatusHtml() renders into the Export tab and
// snapshotStationsJson() is driven by a button export.js writes, so those two
// files are wired across a file boundary. Moving a module never moves its
// registration — constraint 3 on #113.
//
// One thing here executes at load, and it is the only such thing in the whole
// app.js lineage: _dbToken reads sessionStorage for a saved access token. It
// touches nothing outside this file, so it does not constrain load order — but
// it is the shape to look for before moving anything, and the reason the check
// is worth running rather than assuming.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.

// ── Datastore status ───────────────────────────────────────────────────────────
// The whole client, for now: one timed GET of the smallest row in the database,
// so "is the datastore reachable from a browser, and is it the shape this app
// expects" has an answer on screen rather than in somebody's head.

// Reads meganet.app_meta.schema_version. Returns a result object rather than
// throwing, because every caller wants to render the failure, not catch it:
//   { ok:true,  ms, version }
//   { ok:false, ms, error }
async function dbPing() {
  const t0 = _dbClock();
  const url = `${DB_URL}/app_meta?select=value&key=eq.schema_version`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: DB_ANON_KEY,
        'Accept-Profile': DB_SCHEMA,
        // Exactly one row, as an object rather than a one-element array. If the
        // version row is missing or duplicated PostgREST says so with a 406,
        // which is a better answer than quietly reading undefined.
        Accept: 'application/vnd.pgrst.object+json',
      },
      cache: 'no-store',
    });
    const ms = Math.round(_dbClock() - t0);

    if (!res.ok) {
      // PostgREST reports failures as JSON — {message, hint, code}. A proxy, or
      // a project paused for inactivity, may answer with something else, so the
      // status line is the fallback rather than the parse being assumed.
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.message) {
          detail = body.message + (body.hint ? ` — ${body.hint}` : '');
        }
      } catch (_) { /* not JSON; the status line stands */ }
      return { ok: false, ms, error: detail };
    }

    const row = await res.json();
    const version = Number(row && row.value);
    return { ok: true, ms, version: Number.isFinite(version) ? version : null };
  } catch (e) {
    // fetch() rejects the same way for DNS failure, TLS failure, CORS refusal
    // and no network at all, and the browser deliberately does not say which.
    // So report what is actually known rather than guessing a cause.
    return { ok: false, ms: Math.round(_dbClock() - t0), error: `unreachable — ${e && e.message || e}` };
  }
}

// Run a check and repaint the panel around it — once for "checking", once for
// the result. Repaints the status node alone, not the tab: the Export tab's
// checkboxes are DOM state, and redrawing them under the operator would reset
// the very selection they had just made.
async function dbCheck() {
  state.dbStatus = { checking: true };
  dbRepaintStatus();
  state.dbStatus = await dbPing();
  dbRepaintStatus();
}

function dbRepaintStatus() {
  const el = document.getElementById('db-status');
  if (el) el.innerHTML = renderDbStatusHtml();
}

// What is loaded, as opposed to what is reachable. These are different questions
// and conflating them is how a stale file passes for the database: the
// connection can be perfectly healthy while the station list on screen came from
// a file, because the fallback ran before the project woke up.
function renderLoadedSourceHtml() {
  const src = state.dataSource;
  if (!src) return '';

  const live = src.kind === 'api';
  const tone = live ? 'txt-ok' : 'txt-warn';
  const bits = [];
  if (src.ms != null) bits.push(`${src.ms} ms`);
  if (src.dated) bits.push(`data dated ${esc(src.dated)}`);
  bits.push(`loaded ${src.at.toLocaleTimeString()}`);

  return `
    <div class="db-loaded">
      <div class="${tone}">
        <strong>Showing ${esc(SOURCE_LABELS[src.kind] || src.kind)}</strong>
      </div>
      <div class="small db-sub">${bits.join(' · ')}</div>
      ${!live && state.loadError
        ? `<div class="small db-sub txt-warn">fell back — ${esc(state.loadError)}</div>`
        : ''}
      ${!live
        ? `<button class="db-reload" onclick="reloadFromDatastore()">
             Load from the datastore
           </button>`
        : ''}
    </div>`;
}

// Retry the datastore by hand after a fallback — the obvious thing to want when
// the panel has just told you it is showing a file. Announces its failure,
// unlike the automatic attempt: this one was asked for.
async function reloadFromDatastore() {
  if (await loadFromApi({ announce: true })) dbCheck();
  else dbRepaintStatus();
}

// Who the database thinks is asking. This panel is where "what am I connected
// to" is answered, and "as whom" is half of that question — a read that works
// and a write that will not is otherwise indistinguishable from here.
function authLineHtml() {
  if (!Auth.isSignedIn()) {
    return `<div class="small db-auth">
      Reading anonymously — <a href="#" onclick="Auth.open();return false">sign in</a> to edit.</div>`;
  }
  const email = Auth.email();
  const ok    = Auth.mayWrite();
  return `<div class="small db-auth ${ok ? 'txt-ok' : 'txt-warn'}">
    Signed in${email ? ` as ${esc(email)}` : ''}${Auth.role() ? ` (${esc(Auth.role())})` : ''} —
    ${ok ? 'edits will be saved and attributed' : 'not on the editors list, so edits will be refused'}.</div>`;
}

function renderDbStatusHtml() {
  const s = state.dbStatus;
  const loaded = renderLoadedSourceHtml();
  const host = `<div class="small db-host">${esc(dbHostLabel())}</div>${authLineHtml()}`;

  if (!s || s.checking) {
    return `${loaded}<div class="small">Checking…</div>${host}`;
  }

  if (!s.ok) {
    return `
      ${loaded}
      <div class="txt-bad"><strong>Not connected</strong></div>
      <div class="small db-sub txt-bad">${esc(s.error)}</div>
      ${host}`;
  }

  // Connected, but against a database that is not the one this build was written
  // against. Worth its own colour: everything still reads, and will keep reading
  // wrongly, until one side or the other is brought up to date.
  if (s.version !== DB_SCHEMA_VERSION) {
    const older = s.version != null && s.version < DB_SCHEMA_VERSION;
    return `
      <div class="txt-warn"><strong>Connected · schema mismatch</strong></div>
      <div class="small db-sub txt-warn">
        database is v${esc(s.version ?? '?')}, this app expects v${DB_SCHEMA_VERSION} —
        ${older ? 'apply the newer migrations in db/migrations/' : 'this copy of the app is out of date'}
      </div>
      <div class="small db-sub">${s.ms} ms round trip</div>
      ${host}`;
  }

  return `
    <div class="txt-ok"><strong>Connected · schema v${s.version} · ${s.ms} ms</strong></div>
    ${host}`;
}

// First visit to the tab checks; after that the panel holds what it found until
// Re-test is pressed, so flipping between tabs is not a stream of requests.
function initExport() {
  if (!state.dbStatus) dbCheck();
}

// ── stations.json, from the database ───────────────────────────────────────────
// The escape hatch, kept deliberately. stations.json is the offline copy, the
// backup, and the thing that gets handed to whoever inherits this — and since
// #B3 the database is where edits land, so the file has to be refreshable from
// it rather than left to drift into fiction.
//
// This fetches the document fresh rather than serialising what is in memory: the
// point is a snapshot of the database as it is now, which is not necessarily
// what this tab loaded twenty minutes and three edits ago.
//
// The file committed in the repo is refreshed by .github/workflows/
// stations-snapshot.yml, which runs tools/snapshot_stations_json.py weekly and
// opens a PR. This button is the same snapshot by hand, for the operator who
// wants a copy on a USB stick before going somewhere without a network.
async function snapshotStationsJson() {
  const btn = document.getElementById('btn-snapshot');
  // The note is a live region on the Export tab (#141), so writing to it is the
  // announcement — the tone class is the visible half of the same sentence.
  const say = (text, tone) => {
    const el = document.getElementById('snapshot-note');
    if (el) el.innerHTML = `<span class="${tone || 'txt-muted'}">${esc(text)}</span>`;
  };

  if (btn) btn.disabled = true;
  say('Fetching the current document…');
  try {
    const res = await fetch(`${DB_URL}/rpc/stations_doc`, {
      headers: {
        apikey: DB_ANON_KEY,
        'Accept-Profile': DB_SCHEMA,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const doc  = JSON.parse(text);
    if (!Array.isArray(doc.stations)) throw new Error('that is not a stations document');
    // Indented, because a 3.6 MB single line is not something a human can read
    // or a diff can show. The committed file is produced the same way.
    dlText('stations.json', JSON.stringify(doc, null, 2) + '\n');
    say(`Downloaded ${doc.stations.length.toLocaleString()} stations, as at ${new Date().toLocaleString()}.`,
        'txt-ok');
  } catch (err) {
    say(`Could not snapshot the database — ${err && err.message || err}`, 'txt-bad');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Datastore writes ───────────────────────────────────────────────────────────
// The other direction. Reads are a GET anyone may make; a write has to say who
// is making it, arrives at exactly two functions, and can be refused — so this
// is a little more than fetch().
//
// Everything goes through meganet.save_station() and meganet.delete_station()
// rather than at the tables, because a station is a row plus its sensors plus
// its repeater plus that repeater's pass ranges, and those have to land together
// or not at all. The database enforces that by being the only thing granted the
// write verbs; see db/migrations/0004_station_writes.sql.

// The access token for the signed-in session, when there is one. #B8 owns
// getting one — verified @bom.gov.au, allowlist for everyone else — and calls
// dbSetAccessToken() with it. Until that lands this is null, every write goes
// out as `anon`, and the database refuses it. That is the write path working
// correctly, not a bug: the gate is server-side, so it does not matter that the
// browser has no sign-in screen yet.
//
// sessionStorage on purpose, even though auth.js now keeps the *session*
// per-device (the trade is recorded there): this is only a same-tab bridge
// across reloads, repopulated from the restored session on start, and a bare
// access token with no refresh half gains nothing from outliving its tab.
const DB_TOKEN_KEY = 'meganet.access_token';

let _dbToken = (() => {
  try { return sessionStorage.getItem(DB_TOKEN_KEY) || null; } catch (_) { return null; }
})();

function dbSetAccessToken(token) {
  _dbToken = token || null;
  try {
    if (_dbToken) sessionStorage.setItem(DB_TOKEN_KEY, _dbToken);
    else sessionStorage.removeItem(DB_TOKEN_KEY);
  } catch (_) { /* private mode; the token stays in memory for this page */ }
  return dbCanWrite();
}

// Whether this browser holds anything worth sending. Deliberately not a
// permission check — the database decides that, and this only decides whether
// the editor says "sign in first" before spending a round trip finding out.
function dbCanWrite() { return !!_dbToken; }

if (typeof window !== 'undefined') window.dbSetAccessToken = dbSetAccessToken;

// POST to a PostgREST function, with the errors turned into something the caller
// can branch on rather than a string to be pattern-matched:
//
//   err.conflict  somebody else changed the row first (HTTP 409, SQLSTATE PT409)
//   err.denied    not signed in, or signed in as somebody who may not write
//
// PostgREST answers 404 for a function the current role has no EXECUTE on, which
// reads as "no such thing" but means "not for you" — anon holds no grant on
// either of these, so that is the shape a signed-out save comes back in.
async function dbRpc(fn, args) {
  const res = await fetch(`${DB_URL}/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: DB_ANON_KEY,
      // Only when there is one. The publishable key is not a token, and offering
      // it as a bearer would get "invalid JWT" back instead of the honest
      // answer, which is that this request is anonymous.
      ...(_dbToken ? { Authorization: `Bearer ${_dbToken}` } : {}),
      'Content-Profile': DB_SCHEMA,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(args),
    cache: 'no-store',
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }

  if (!res.ok) {
    const message = (body && (body.message || body.error_description))
      || `HTTP ${res.status}`;
    const err = new Error(body && body.hint ? `${message} — ${body.hint}` : message);
    err.status   = res.status;
    err.conflict = res.status === 409;
    err.denied   = res.status === 401 || res.status === 403 || res.status === 404;
    throw err;
  }
  return body;
}

// GET a table or view through PostgREST. `path` is everything after the base —
// `reading?addr=in.("a:6128")&order=reading_ts.asc` — and the key, the schema
// and the token (when there is one) are added here so that no caller assembles
// them again. Reads only: writes go through dbRpc() and a `security definer`
// function, which is what the RLS in db/migrations assumes.
//
// Anonymous is the normal case. Readings, the rollups and the vocabularies are
// granted to `anon` in 0006 — a river height is not a secret — so this works
// signed out, and signing in adds nothing to a read.
async function dbSelect(path) {
  const res = await fetch(`${DB_URL}/${path}`, {
    headers: {
      apikey: DB_ANON_KEY,
      ...(_dbToken ? { Authorization: `Bearer ${_dbToken}` } : {}),
      'Accept-Profile': DB_SCHEMA,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
  if (!res.ok) {
    const message = (body && (body.message || body.error_description)) || `HTTP ${res.status}`;
    const err = new Error(body && body.hint ? `${message} — ${body.hint}` : message);
    err.status = res.status;
    throw err;
  }
  return Array.isArray(body) ? body : [];
}

// ── Supabase Storage ───────────────────────────────────────────────────────────
// The third API on the same project host, after the Data API and Auth, and the
// first thing in this app that moves bytes rather than JSON. #149 needed it:
// meganet.attachment has been an index into a bucket since 0009 and nothing
// could put anything in the bucket.
//
// Derived from DB_URL for the same reason AUTH_URL is — two constants naming
// one project is two chances to point them at different ones.
//
// These three are deliberately thin. Everything about *what may be attached* —
// the type list, the size limits, the path convention, who may — is in
// db/migrations/0010_attachments.sql and in attachments.js, because the database
// is the one enforcing it and a second copy of the rules here could only ever
// disagree. This layer knows how to speak the protocol and nothing else.
const STORAGE_URL = DB_URL.replace(/\/rest\/v1\/?$/, '/storage/v1');

// PUT the bytes at a path in a bucket. Storage takes the file as the raw body,
// not as multipart — the object's name is the URL, not a form field.
//
// `x-upsert: false` is the safe default and is left at it: attachments.js names
// every object with a fresh uuid, so a collision here means something has gone
// wrong upstream and quietly overwriting somebody else's photo is not the way to
// find out.
async function dbUploadObject(bucket, path, file) {
  const res = await fetch(`${STORAGE_URL}/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      apikey: DB_ANON_KEY,
      ...(_dbToken ? { Authorization: `Bearer ${_dbToken}` } : {}),
      'Content-Type': file.type || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: file,
  });
  if (!res.ok) throw await storageError(res);
  return { bucket, path };
}

// A time-limited URL for a private object. The bucket holds site photographs and
// canister config dumps and is deliberately not public (see
// tools/storage_bucket.sql), so there is no permanent URL to render — every
// thumbnail on screen is signed for the session that asked for it.
async function dbSignedUrl(bucket, path, seconds) {
  const res = await fetch(`${STORAGE_URL}/object/sign/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      apikey: DB_ANON_KEY,
      ...(_dbToken ? { Authorization: `Bearer ${_dbToken}` } : {}),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ expiresIn: seconds || 3600 }),
    cache: 'no-store',
  });
  if (!res.ok) throw await storageError(res);
  const body = await res.json();
  // Storage answers with a path relative to /storage/v1, leading slash included.
  const signed = body && (body.signedURL || body.signedUrl);
  if (!signed) throw new Error('Storage returned no signed URL');
  return `${STORAGE_URL}${signed.startsWith('/') ? '' : '/'}${signed}`;
}

// Remove the bytes. Called after meganet.detach_file() has dropped the index
// row, and as the compensating half of a failed attach — see attachments.js for
// why the two are in that order.
async function dbRemoveObject(bucket, path) {
  const res = await fetch(`${STORAGE_URL}/object/${bucket}/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: DB_ANON_KEY,
      ...(_dbToken ? { Authorization: `Bearer ${_dbToken}` } : {}),
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw await storageError(res);
  return true;
}

// Storage speaks its own error shape — {statusCode, error, message} — rather
// than PostgREST's, and its 400 for "Bucket not found" is the single most likely
// thing to go wrong on a project where tools/storage_bucket.sql has not been
// run. So that one is named rather than passed through as a status code.
async function storageError(res) {
  let body = null;
  try { body = await res.json(); } catch (_) { /* not JSON; the status stands */ }
  const raw = (body && (body.message || body.error)) || `HTTP ${res.status}`;
  const missing = /bucket not found/i.test(raw);
  const err = new Error(missing
    ? 'the `inspections` storage bucket does not exist on this project — run tools/storage_bucket.sql'
    : raw);
  err.status = res.status;
  err.bucketMissing = missing;
  err.denied = res.status === 401 || res.status === 403;
  return err;
}

// The version stamp the editor is holding. Two columns rather than one because
// "deleted while you had it open" is worth telling the operator before they type
// for ten minutes into a form that cannot be saved.
async function dbStationStamp(id) {
  const url = `${DB_URL}/station?id=eq.${encodeURIComponent(id)}&select=updated_at,deleted_at`;
  const res = await fetch(url, {
    headers: {
      apikey: DB_ANON_KEY,
      ...(_dbToken ? { Authorization: `Bearer ${_dbToken}` } : {}),
      'Accept-Profile': DB_SCHEMA,
      Accept: 'application/vnd.pgrst.object+json',
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function dbSaveStation(doc, expectedUpdatedAt) {
  return dbRpc('save_station', {
    p_doc: doc,
    p_expected_updated_at: expectedUpdatedAt || null,
  });
}

function dbDeleteStation(id, expectedUpdatedAt) {
  return dbRpc('delete_station', {
    p_id: id,
    p_expected_updated_at: expectedUpdatedAt || null,
  });
}

// Pull the stamp for the station just opened, in the background. Nothing waits
// on it — the operator starts typing immediately — but a save that arrives
// before it does is refused by the database rather than guessed at, which is the
// safe half of that race.
async function fetchEditorStamp(id) {
  state.editorStamp    = null;
  state.editorStampFor = id;
  if (!id) return;
  try {
    const row = await dbStationStamp(id);
    if (state.editorStampFor !== id) return;   // the operator moved on
    state.editorStamp = row && row.updated_at;
    if (row && row.deleted_at) {
      setEditorStatus({ kind: 'error', text: 'This station has been deleted in the database. Saving will bring it back.' });
    }
  } catch (_) {
    // Left null. The save will be refused with a message that says to reload,
    // which is the truthful answer: this editor cannot prove what it started
    // from.
    if (state.editorStampFor === id) state.editorStamp = null;
  }
}

// The editor's own status line. Repainted on its own so a failed save can say
// why without redrawing the form underneath it and throwing away the typing
// that is the entire thing being protected.
function setEditorStatus(msg) {
  state.editorMsg = msg;
  const el = document.getElementById('ef-status');
  if (el) el.innerHTML = editorStatusHtml();
}

function editorStatusHtml() {
  const m = state.editorMsg;
  if (m) {
    const colour = m.kind === 'error' ? 'var(--bad)'
                 : m.kind === 'ok'    ? 'var(--ok)'
                 : 'var(--muted)';
    return `<span style="color:${colour}">${esc(m.text)}</span>`;
  }
  // Nothing has happened yet, so say what will happen when Save is pressed —
  // which is different depending on where the list on screen came from and
  // whether this browser holds a session.
  if (!editorWritesGoToDatabase()) {
    return `<span class="txt-warn">Showing ${esc(SOURCE_LABELS[state.dataSource?.kind] || 'a file')} rather than the datastore —
      <a href="#" onclick="reloadFromDatastore();return false">load from the datastore</a> before editing,
      or Save would write what is on screen over whatever the database now holds.</span>`;
  }
  if (!dbCanWrite()) {
    return `<span style="color:var(--muted)">Not signed in — the database refuses anonymous writes.
      <a href="#" onclick="Auth.open();return false">Sign in</a> to save; everything on this form is kept while you do.</span>`;
  }
  // Signed in, and the database has already said this address may not write.
  // Worth saying here rather than letting Save be the one to find out, because
  // the answer will not change by trying again.
  if (!Auth.mayWrite()) {
    return `<span class="txt-warn">Signed in as ${esc(Auth.email() || 'you')}, but this address is not on the
      editors list — saving will be refused. An administrator has to add it (see <code>docs/access.md</code>).</span>`;
  }
  return '';
}

// Saving is only safe when the station on screen came out of the database this
// session. On the file fallback the form holds values that may be older than the
// row it would overwrite — and the version stamp would not catch it, because the
// stamp is read live and would match.
function editorWritesGoToDatabase() {
  return state.dataSource && state.dataSource.kind === 'api';
}

