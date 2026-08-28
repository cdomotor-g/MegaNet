// MegaNet — auth.js
//
//   Auth   Supabase Auth (GoTrue) sign-in: obtains a token, keeps it alive,
//          hands it to the datastore layer, and makes the signed-out state
//          something the app renders rather than something it fails at.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for AUTH_URL, DB_URL, DB_ANON_KEY, DB_SCHEMA and esc;
// across to app.js for setHeaderLabel and rerenderStationEditorCard; and to
// datastore.js for dbSetAccessToken. datastore.js and station-editor.js call
// back into Auth, so this is a cycle — which is fine in one shared global scope
// and would not be under ESM, one of the four reasons #129 gives for classic
// scripts. Nothing here runs at load, so neither file's position is fixed.
//
// This is not what keeps people out. Cloudflare Access is the perimeter
// (docs/access.md) and meganet.is_editor() is the enforcement; this module is
// the middle that turns a person into a token. The banner below says it at
// length because it is the thing most likely to be misread here.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.

// ── Sign-in ──────────────────────────────────────────────────────────────────
// The browser half of #B8. Supabase Auth (GoTrue) issues the token; this module
// obtains one, keeps it alive, hands it to the datastore layer, and makes the
// signed-out state something the app renders rather than something it fails at.
//
// Read this before changing anything here:
//
// **This is not what keeps people out.** Cloudflare Access sits in front of the
// site and is the perimeter (docs/access.md); meganet.is_editor() sits in front
// of every write and is the enforcement. This module is the middle — it turns a
// person into a token so the database has something to check. Deleting all of it
// would make the app read-only, not open.
//
// **No library.** GoTrue is four HTTP endpoints and index.html gains no <script>
// tag for them, the same trade the Data API section above makes.
//
// **Two ways in, because the email decides which.** Supabase's default template
// sends a magic link; add {{ .Token }} to it and the same email also carries a
// six-digit code. The link lands back here with the session in the URL fragment;
// the code is typed into the panel. Both are supported because which one an
// operator gets depends on a template in a dashboard, and an app that only
// handles one of them is an app that breaks when somebody edits it.
//
// **localStorage, not sessionStorage — the trade was re-judged.** 0004 and the
// original #B8 build kept this per-tab: a token that outlives the tab it was
// obtained in is a token left behind on a shared machine. That priced sign-in
// at a fresh code per tab, and once floodwarning.net went behind Cloudflare
// Access (Aug 2026) the operator judged it the wrong trade — a machine that can
// reach this page has already passed the gate, so the session now sticks and
// sign-in happens once per browser. The lingering-session cost on a shared
// machine is accepted, not solved; #173 retires it properly by minting the
// session from the gate's own identity, with no second sign-in at all. This is
// still the only place the trade is decided: datastore.js keeps its per-tab
// mirror of the bare access token, and adopt() repopulates that from here.
const Auth = (function () {

  // The whole session, not just the token: the refresh token and the expiry are
  // what make this survive a reload, and dbSetAccessToken() only knows about the
  // one field it needs.
  const KEY = 'meganet.session';

  // Refresh this long before the token actually expires. GoTrue's default is an
  // hour; a minute of margin covers a slow request and a clock that disagrees.
  const REFRESH_MARGIN_MS = 60 * 1000;

  let session = null;      // { access_token, refresh_token, expires_at, email }
  let who     = null;      // last meganet.whoami() answer, or null
  let timer   = null;
  // `email` and `code` are mirrored here rather than left in the DOM because
  // every state change repaints the panel: a message that arrives while somebody
  // is mid-type would otherwise take the typing with it.
  let ui      = { step: 'email', email: '', code: '', busy: false, msg: null };

  // ── session plumbing ──

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function store(s) {
    try {
      if (s) localStorage.setItem(KEY, JSON.stringify(s));
      else localStorage.removeItem(KEY);
    } catch (_) { /* private mode; this session lives in memory only */ }
  }

  // Everything that has to happen for a token to count as adopted, in one place
  // so no path can adopt half of it.
  function adopt(s) {
    session = s;
    store(s);
    dbSetAccessToken(s ? s.access_token : null);
    scheduleRefresh();
  }

  function fromTokenResponse(body, email) {
    return {
      access_token:  body.access_token,
      refresh_token: body.refresh_token,
      // Absolute rather than a duration, because a duration is only meaningful
      // at the instant it was issued and this gets written to storage.
      expires_at:    Date.now() + (Number(body.expires_in) || 3600) * 1000,
      email:         (body.user && body.user.email) || email || null,
    };
  }

  function scheduleRefresh() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!session) return;
    const due = session.expires_at - Date.now() - REFRESH_MARGIN_MS;
    // Already past it — refresh on the next tick rather than never, which is
    // what a negative setTimeout would otherwise quietly mean.
    timer = setTimeout(refresh, Math.max(0, due));
  }

  async function refresh() {
    if (!session || !session.refresh_token) return false;
    try {
      const body = await post(`token?grant_type=refresh_token`,
                              { refresh_token: session.refresh_token });
      adopt(fromTokenResponse(body, session.email));
      return true;
    } catch (_) {
      // A refresh token is single-use and expires; a failure here means the
      // session is over, and pretending otherwise leaves the app showing a name
      // for someone the database will refuse. Sign out quietly — nobody asked
      // for this request, so nobody is waiting for an error about it.
      await signOut({ announce: false });
      return false;
    }
  }

  // ── the four endpoints ──

  async function post(path, body, opts = {}) {
    const res = await fetch(`${AUTH_URL}/${path}`, {
      method: 'POST',
      headers: {
        apikey: DB_ANON_KEY,
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (!res.ok) {
      const err = new Error(
        (parsed && (parsed.error_description || parsed.msg || parsed.message))
        || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return parsed;
  }

  // What the database makes of the token we are holding. Called after every
  // adoption because it is the only check that is not self-assessment: the token
  // could be well-formed, unexpired and still refused.
  async function whoami() {
    try {
      const res = await fetch(`${DB_URL}/rpc/whoami`, {
        method: 'POST',
        headers: {
          apikey: DB_ANON_KEY,
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
          'Content-Profile': DB_SCHEMA,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: '{}',
        cache: 'no-store',
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      // Offline, or a database that has not had 0005 applied yet. Neither is
      // worth an error in the operator's face: the app still reads, and the
      // header simply does not claim to know who they are.
      return null;
    }
  }

  // ── sign in ──

  // Refuse in the browser what the database is going to refuse anyway, so an
  // address that was never going to be let in does not cost a round trip to a
  // mailbox and a wait. Not a security check — meganet.auth_user_gate() is —
  // and it deliberately fails open: if this call itself fails, the sign-in goes
  // ahead and the server gets to answer.
  async function maySignIn(email) {
    try {
      const res = await fetch(`${DB_URL}/rpc/email_may_sign_in`, {
        method: 'POST',
        headers: {
          apikey: DB_ANON_KEY,
          'Content-Profile': DB_SCHEMA,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ p_email: email }),
        cache: 'no-store',
      });
      if (!res.ok) return true;
      return (await res.json()) !== false;
    } catch (_) { return true; }
  }

  async function requestCode() {
    const email = (document.getElementById('au-email')?.value || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return setMsg('error', 'That does not look like an email address.');
    }

    ui.email = email;
    setBusy(true, 'Checking…');

    if (!await maySignIn(email)) {
      setBusy(false);
      return setMsg('error',
        `${email} is not on the access list, so no code was sent. Access is open to any `
        + `verified @bom.gov.au address; anyone else has to be added by an administrator `
        + `— see docs/access.md.`);
    }

    setBusy(true, 'Sending…');
    try {
      // create_user true is what makes this a sign-in and a signup at once. The
      // database decides whether that signup is allowed, so "anyone can create
      // an account" is not what this line means.
      //
      // redirect_to is stated rather than left out, because leaving it out does
      // not mean "come back here" — it means GoTrue falls back to the project's
      // Site URL, which ships as http://localhost:3000 and sends the link to a
      // port nothing is listening on. The session is minted and thrown at a dead
      // page, which looks like a broken login and is not one. The app knows its
      // own origin; a dashboard field is a worse place to keep that. This is not
      // a loosening: Authentication → URL Configuration → Redirect URLs is what
      // decides whether the value is honoured, and an origin not on that list is
      // refused, not obeyed. See docs/access.md.
      await post(`otp?redirect_to=${encodeURIComponent(location.origin + location.pathname)}`,
                 { email, create_user: true });
    } catch (err) {
      setBusy(false);
      return setMsg('error', signInErrorText(err, email));
    }
    setBusy(false);
    ui.step = 'code';
    ui.code = '';
    setMsg('ok', `Sent. Check ${email} — click the link, or type the six-digit code below.`);
    document.getElementById('au-code')?.focus();
  }

  async function verifyCode() {
    const token = (document.getElementById('au-code')?.value || '').trim();
    ui.code = token;
    if (!token) return setMsg('error', 'Enter the code from the email.');

    setBusy(true, 'Verifying…');
    let body;
    try {
      body = await post('verify', { email: ui.email, token, type: 'email' });
    } catch (err) {
      setBusy(false);
      return setMsg('error',
        err.status === 401 || err.status === 403
          ? 'That code was not accepted. Codes expire — send a new one if this keeps happening.'
          : signInErrorText(err, ui.email));
    }

    adopt(fromTokenResponse(body, ui.email));
    who = await whoami();
    setBusy(false);
    ui.step = 'in';
    ui.msg  = null;

    // Signed in and still refused is a real state — an address on auth but not
    // on editor_allow — and the header would otherwise imply write access that
    // the first save would deny.
    if (who && who.may_write === false) {
      setMsg('error', 'Signed in, but this address may not edit stations. An administrator has to add it.');
    }

    syncHeader();
    render();
    // The editor's status line says "not signed in" until something tells it
    // otherwise, and it is on screen behind this panel.
    if (typeof rerenderStationEditorCard === 'function') rerenderStationEditorCard();
  }

  // GoTrue does not pass a trigger's message through, so a refused signup
  // arrives as a generic database error. Recognising it here is what turns
  // "unexpected_failure" into the one thing the person needs to know.
  function signInErrorText(err, email) {
    const m = String(err && err.message || '');
    if (/database error|unexpected_failure/i.test(m)) {
      return `${email} was refused by the database, which is what happens to an address that `
           + `is not on the access list. If it should be, an administrator has to add it — see docs/access.md.`;
    }
    if (err.status === 429) {
      return 'Too many attempts in a row. Wait a minute and try again.';
    }
    return `Could not send the code — ${m}`;
  }

  async function signOut({ announce = true } = {}) {
    const token = session && session.access_token;
    adopt(null);
    who = null;
    ui  = { step: 'email', email: '', code: '', busy: false, msg: null };
    // Best effort, and deliberately after the local state is already gone: if
    // this fails the token is still forgotten here, which is the part that
    // matters to the person at the keyboard.
    if (token) { try { await post('logout', {}, { token }); } catch (_) { /* already gone */ } }
    syncHeader();
    if (announce && document.getElementById('auth-modal')?.style.display === 'flex') render();
    if (typeof rerenderStationEditorCard === 'function') rerenderStationEditorCard();
  }

  // ── the magic link landing ──
  // A link from the email returns here with the session in the URL *fragment* —
  // which never reaches a server, and is why GoTrue uses it. Consuming it means
  // taking the tokens and then removing them from the address bar, so a copied
  // URL or a screenshot is not a copied session.
  function consumeHash() {
    const raw = location.hash || '';
    if (!raw.includes('access_token=') && !raw.includes('error=')) return false;

    const p = new URLSearchParams(raw.replace(/^#/, ''));
    // replaceState rather than clearing location.hash, which would leave a bare
    // '#' and push a history entry.
    history.replaceState(null, '', location.pathname + location.search);

    if (p.get('error') || p.get('error_description')) {
      ui.msg = { kind: 'error', text: p.get('error_description') || p.get('error') };
      return false;
    }
    const access = p.get('access_token');
    if (!access) return false;

    adopt({
      access_token:  access,
      refresh_token: p.get('refresh_token'),
      expires_at:    Date.now() + (Number(p.get('expires_in')) || 3600) * 1000,
      email:         null,          // filled in by whoami() below
    });
    return true;
  }

  // ── header ──

  function label() {
    if (!session) return 'Sign in';
    const email = (who && who.email) || session.email;
    if (!email) return 'Signed in';
    // The local part is enough to say "you are you" and fits the header; the
    // full address is in the panel and the title attribute.
    return email.split('@')[0];
  }

  function syncHeader() {
    setHeaderLabel('btn-auth', label());
    const btn = document.getElementById('btn-auth');
    if (!btn) return;
    const email = (who && who.email) || (session && session.email);
    btn.title = session
      ? `Signed in${email ? ` as ${email}` : ''}${who && who.may_write === false ? ' — read only' : ''}`
      : 'Sign in to edit stations';
    btn.classList.toggle('is-in', !!session);
  }

  // ── panel ──

  function template() {
    const busy = ui.busy;
    const msg  = ui.msg
      ? `<p class="small" style="color:${ui.msg.kind === 'error' ? 'var(--bad)'
                                      : ui.msg.kind === 'ok' ? 'var(--ok)' : 'var(--muted)'}">${esc(ui.msg.text)}</p>`
      : '';

    let body;
    if (ui.step === 'in') {
      const email = (who && who.email) || session?.email || '';
      const write = who ? who.may_write : null;
      body = `
        <div class="modal-form">
          <p>Signed in${email ? ` as <strong>${esc(email)}</strong>` : ''}.</p>
          <p class="small">${
            write === false
              ? 'This address may sign in but may not edit stations — an administrator has to add it to the editors list.'
              : write === true
                ? 'Edits to stations will be saved to the database and attributed to this address.'
                : 'The database did not answer when asked what this session may do; saving will tell you.'
          }</p>
          <p class="small">This session ends when this tab is closed.</p>
        </div>
        <div class="modal-foot">
          <button onclick="Auth.close()">Close</button>
          <button class="primary" onclick="Auth.signOut()">Sign out</button>
        </div>`;
    } else if (ui.step === 'code') {
      body = `
        <div class="modal-form">
          <label>Six-digit code from the email
            <input type="text" id="au-code" inputmode="numeric" autocomplete="one-time-code"
                   placeholder="123456" value="${esc(ui.code)}" ${busy ? 'disabled' : ''}
                   onkeydown="if(event.key==='Enter'){event.preventDefault();Auth.verifyCode();}">
          </label>
          <p class="small">The email also contains a link. Clicking it signs you in in whichever
             tab it opens, and you can ignore this box.</p>
          ${msg}
        </div>
        <div class="modal-foot">
          <button onclick="Auth.back()" ${busy ? 'disabled' : ''}>Use a different address</button>
          <button class="primary" onclick="Auth.verifyCode()" ${busy ? 'disabled' : ''}>Sign in</button>
        </div>`;
    } else {
      body = `
        <div class="modal-form">
          <label>Work email address
            <input type="email" id="au-email" autocomplete="email" placeholder="you@bom.gov.au"
                   value="${esc(ui.email)}" ${busy ? 'disabled' : ''}
                   onkeydown="if(event.key==='Enter'){event.preventDefault();Auth.requestCode();}">
          </label>
          <p class="small">Any verified <strong>@bom.gov.au</strong> address can sign in with no
             approval step. Other addresses have to be added first — see <code>docs/access.md</code>.
             There is no password: an email arrives with a link and a code.</p>
          ${msg}
        </div>
        <div class="modal-foot">
          <button onclick="Auth.close()" ${busy ? 'disabled' : ''}>Cancel</button>
          <button class="primary" onclick="Auth.requestCode()" ${busy ? 'disabled' : ''}>Email me a code</button>
        </div>`;
    }

    return `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="au-title"
           onclick="event.stopPropagation()">
        <div class="modal-head">
          <h2 id="au-title">${ui.step === 'in' ? 'Your session' : 'Sign in to MegaNet'}</h2>
          <button class="modal-x" title="Close (Esc)" onclick="Auth.close()">×</button>
        </div>
        <p class="sub">Signing in is only needed to <em>edit</em>. The station list, the maps and every
           tool read without it.</p>
        ${body}
      </div>`;
  }

  function render() {
    const root = document.getElementById('auth-modal');
    if (!root || root.style.display !== 'flex') return;
    root.innerHTML = template();
  }

  function open() {
    let root = document.getElementById('auth-modal');
    if (!root) {
      root = document.createElement('div');
      root.id = 'auth-modal';
      root.className = 'modal-overlay';
      root.onclick = close;
      document.body.appendChild(root);
    }
    if (session && ui.step !== 'in') { ui.step = 'in'; ui.msg = null; }
    root.style.display = 'flex';
    root.innerHTML = template();
    document.addEventListener('keydown', onKey);
    document.getElementById(ui.step === 'code' ? 'au-code' : 'au-email')?.focus();
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    const root = document.getElementById('auth-modal');
    if (root) root.style.display = 'none';
    document.removeEventListener('keydown', onKey);
    ui.busy = false;
  }

  function back() {
    ui.step = 'email'; ui.code = ''; ui.msg = null;
    render();
    document.getElementById('au-email')?.focus();
  }

  function setMsg(kind, text) { ui.msg = { kind, text }; render(); }
  function setBusy(on, text) {
    ui.busy = on;
    if (text) ui.msg = { kind: 'busy', text };
    render();
  }

  // ── start ──
  // Called from init(). Everything here is best-effort and none of it blocks the
  // app drawing: a person who never signs in must not wait on an auth server to
  // see the station list.
  function start() {
    const landed = consumeHash();
    if (!landed) {
      const s = load();
      // Expired while the tab was closed. Keep it only if there is a refresh
      // token to redeem — otherwise it is just a string that will 401.
      if (s && (s.expires_at > Date.now() || s.refresh_token)) adopt(s);
      else if (s) store(null);
    }
    syncHeader();
    if (!session) return;

    (async () => {
      if (session.expires_at <= Date.now() && !await refresh()) return;
      who = await whoami();
      // A token the database will not honour is worse than no token: the editor
      // would offer to save and the save would be refused.
      if (who && who.signed_in === false) { await signOut({ announce: false }); return; }
      syncHeader();
      render();
      if (typeof rerenderStationEditorCard === 'function') rerenderStationEditorCard();
    })();
  }

  return {
    start, open, close, back, requestCode, verifyCode, signOut, render,
    // Read by the editor and the Data source panel. Both ask the database in the
    // end; these only decide what to say before that round trip.
    isSignedIn: () => !!session,
    mayWrite:   () => !!session && (who ? who.may_write !== false : true),
    email:      () => (who && who.email) || (session && session.email) || null,
    role:       () => (who && who.role) || null,
  };
})();
if (typeof window !== 'undefined') window.Auth = Auth;

