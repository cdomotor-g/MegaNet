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
  const colour = live ? 'var(--ok)' : 'var(--warn)';
  const bits = [];
  if (src.ms != null) bits.push(`${src.ms} ms`);
  if (src.dated) bits.push(`data dated ${esc(src.dated)}`);
  bits.push(`loaded ${src.at.toLocaleTimeString()}`);

  return `
    <div style="margin-bottom:.5rem;padding-bottom:.5rem;border-bottom:1px solid var(--line)">
      <div style="color:${colour}">
        <strong>Showing ${esc(SOURCE_LABELS[src.kind] || src.kind)}</strong>
      </div>
      <div class="small" style="margin-top:.25rem">${bits.join(' · ')}</div>
      ${!live && state.loadError
        ? `<div class="small" style="margin-top:.25rem;color:var(--warn)">
             fell back — ${esc(state.loadError)}
           </div>`
        : ''}
      ${!live
        ? `<button onclick="reloadFromDatastore()" style="padding:.25rem .5rem;font-size:.8rem;margin-top:.4rem">
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
    return `<div class="small" style="margin-top:.2rem;color:var(--muted)">
      Reading anonymously — <a href="#" onclick="Auth.open();return false">sign in</a> to edit.</div>`;
  }
  const email = Auth.email();
  const ok    = Auth.mayWrite();
  return `<div class="small" style="margin-top:.2rem;color:${ok ? 'var(--ok)' : 'var(--warn)'}">
    Signed in${email ? ` as ${esc(email)}` : ''}${Auth.role() ? ` (${esc(Auth.role())})` : ''} —
    ${ok ? 'edits will be saved and attributed' : 'not on the editors list, so edits will be refused'}.</div>`;
}

function renderDbStatusHtml() {
  const s = state.dbStatus;
  const loaded = renderLoadedSourceHtml();
  const host = `<div class="small" style="margin-top:.35rem">${esc(dbHostLabel())}</div>${authLineHtml()}`;

  if (!s || s.checking) {
    return `${loaded}<div class="small">Checking…</div>${host}`;
  }

  if (!s.ok) {
    return `
      ${loaded}
      <div style="color:var(--bad)"><strong>Not connected</strong></div>
      <div class="small" style="margin-top:.25rem;color:var(--bad)">${esc(s.error)}</div>
      ${host}`;
  }

  // Connected, but against a database that is not the one this build was written
  // against. Worth its own colour: everything still reads, and will keep reading
  // wrongly, until one side or the other is brought up to date.
  if (s.version !== DB_SCHEMA_VERSION) {
    const older = s.version != null && s.version < DB_SCHEMA_VERSION;
    return `
      <div style="color:var(--warn)"><strong>Connected · schema mismatch</strong></div>
      <div class="small" style="margin-top:.25rem;color:var(--warn)">
        database is v${esc(s.version ?? '?')}, this app expects v${DB_SCHEMA_VERSION} —
        ${older ? 'apply the newer migrations in db/migrations/' : 'this copy of the app is out of date'}
      </div>
      <div class="small" style="margin-top:.25rem">${s.ms} ms round trip</div>
      ${host}`;
  }

  return `
    <div style="color:var(--ok)"><strong>Connected · schema v${s.version} · ${s.ms} ms</strong></div>
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
  const say = (text, colour) => {
    const el = document.getElementById('snapshot-note');
    if (el) el.innerHTML = `<span style="color:${colour || 'var(--muted)'}">${esc(text)}</span>`;
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
        'var(--ok)');
  } catch (err) {
    say(`Could not snapshot the database — ${err && err.message || err}`, 'var(--bad)');
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
// sessionStorage rather than localStorage: a token outliving the tab it was
// obtained in is a token left on a shared machine.
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
    return `<span style="color:var(--warn)">Showing ${esc(SOURCE_LABELS[state.dataSource?.kind] || 'a file')} rather than the datastore —
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
    return `<span style="color:var(--warn)">Signed in as ${esc(Auth.email() || 'you')}, but this address is not on the
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

