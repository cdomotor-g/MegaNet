// MegaNet — auth.js
//
//   Auth   Supabase Auth (GoTrue) accounts: signs a person up and in, obtains a
//          token and keeps it alive, hands it to the datastore layer, and makes
//          the signed-out state something the app renders rather than
//          something it fails at — down to telling a visitor, once, what an
//          account would give them.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for AUTH_URL, DB_URL, DB_ANON_KEY, DB_SCHEMA and esc;
// across to app.js for setHeaderLabel, rerenderStationEditorCard, renderTabs
// and switchTab; to field-photos.js for FieldPhotos.authChanged, because every
// photo it holds was fetched for one session (0035, 0062: members only); to
// field-camera.js for FieldCamera.authChanged, which sends the photos waiting
// on the device; to admin.js for Admin.authChanged (0042, administrators
// only); to network-review.js for NetworkReview.authChanged and alert2-plan.js
// for Alert2Plan.authChanged (administrators only); to station-history.js for StationHistory.authChanged (0056, editors
// only); to site-features.js for SiteFeatures.authChanged (0061, editors only);
// to nav-views.js for NavViews.authChanged (0062: an account's own views); to
// toast.js for the once-a-page notes; and to datastore.js for dbSetAccessToken.
// datastore.js and station-editor.js call back into Auth, so this is a cycle —
// which is fine in one shared global scope and would not be under ESM, one of
// the four reasons #129 gives for classic scripts. Nothing here runs at load,
// so neither file's position is fixed.
//
// This is not what keeps people out. The database is the enforcement:
// meganet.is_editor() in front of every write, meganet.is_member() (0062) in
// front of the field photos, meganet.is_admin() in front of the Admin tab's
// functions. This module is the middle that turns a person into a token. The
// banner below says it at length because it is the thing most likely to be
// misread here.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129, and given accounts
// with passwords by 0062.

// ── Accounts ─────────────────────────────────────────────────────────────────
// The browser half of #B8, grown up. Supabase Auth (GoTrue) issues the token;
// this module obtains one, keeps it alive, hands it to the datastore layer, and
// makes the signed-out state something the app renders rather than something
// it fails at.
//
// Read this before changing anything here:
//
// **This is not what keeps people out.** meganet.is_editor() sits in front of
// every write and meganet.is_member() in front of every field photo, inside
// Postgres, where curl meets them too. Deleting all of this would make the app
// read-only, not open.
//
// **Anybody may make an account (0062).** Until October 2026 an account was
// handed out in advance — the database refused to create one for an address
// not on its allowlist. Now anybody may sign up with an address and a
// password. What an account is *worth* is still the database's to say:
//
//   any account      its own left-bar views, kept in the database
//   a member         the field photos — a Bureau address as soon as it is
//                    confirmed (the allowlist), anybody else once an
//                    administrator approves them (the Admin tab)
//   an editor        stations, inspections, surveys and photos to change —
//                    the allowlist, exactly as before
//
// whoami() says which of those this session is, and the panel says it in words.
//
// **Passwords are GoTrue's, never ours.** The password goes from the form to
// /auth/v1/token or /auth/v1/signup over TLS and nowhere else: GoTrue keeps a
// bcrypt hash of it in auth.users, and nothing in this app or the meganet
// schema ever holds or sees one. The rules a password must meet — its length,
// whether it has been in a breach — are GoTrue's settings (docs/accounts.md);
// the form asks for PASSWORD_MIN characters first only so that a short one is
// refused before the round trip, and says what GoTrue says when it refuses one.
//
// **An address is proven before it counts.** Sign-up sends a confirmation
// email — a link, and a six-digit code where the template carries {{ .Token }}
// — and is_member() and is_editor() read only a *confirmed* address from
// auth.users (0054). That is what stops anybody typing a Bureau address they
// do not hold and being approved for it.
//
// **No library.** GoTrue is a handful of HTTP endpoints and index.html gains no
// <script> tag for them, the same trade the Data API section makes.
//
// **Several ways in, the same session out.** A password; a code or link by
// email (the original #B8 way, kept for anybody who would rather not have a
// password); and Google or Microsoft where the project has the provider on —
// GoTrue's own /settings says which, and only those buttons are drawn. The
// links and the providers come back through the same URL-fragment landing
// (consumeHash), so nothing downstream can tell the ways apart.
//
// **An emailed link waits for a click (consumeLink).** A Bureau mailbox's
// scanner opens every link in an email before the person sees it, and a link
// straight to GoTrue's /verify is used up by that visit — the person's reset
// then fails, and the scanner briefly holds their session (seen in the auth
// log, 14 Oct 2026). The templates in docs/accounts.md (step C) link to the
// app with ?token_hash=…&type=…, and the app verifies it only when a person
// presses Continue. Opening a page is what a scanner does; pressing a button is
// not.
//
// **localStorage, not sessionStorage — the trade was re-judged.** 0004 and the
// original #B8 build kept this per-tab: a token that outlives the tab it was
// obtained in is a token left behind on a shared machine. That priced sign-in
// at a fresh code per tab, and once floodwarning.net went behind Cloudflare
// Access (Aug 2026) the operator judged it the wrong trade, so the session now
// sticks and sign-in happens once per browser. The lingering-session cost on a
// shared machine is accepted, not solved — which is why the panel has *Sign out
// everywhere*. This is still the only place the trade is decided: datastore.js
// keeps its per-tab mirror of the bare access token, and adopt() repopulates
// that from here.
const Auth = (function () {

  // The whole session, not just the token: the refresh token and the expiry are
  // what make this survive a reload, and dbSetAccessToken() only knows about the
  // one field it needs.
  const KEY = 'meganet.session';

  // Refresh this long before the token actually expires. GoTrue's default is an
  // hour; a minute of margin covers a slow request and a clock that disagrees.
  const REFRESH_MARGIN_MS = 60 * 1000;

  // The shortest password the form sends. GoTrue's own minimum is a dashboard
  // setting (docs/accounts.md asks for this same figure there); length is what
  // makes a password strong, so this asks for length and nothing else — no
  // "one capital and a symbol", which NIST stopped recommending because it
  // buys predictable passwords.
  const PASSWORD_MIN = 10;

  // The visitor note (nudge): until when "Not now" holds it back, in ms since
  // the epoch, and for how long a "Not now" holds.
  const NUDGE_KEY = 'mn-signin-nudge';
  const NUDGE_SNOOZE_MS = 14 * 24 * 3600 * 1000;
  const NUDGE_DELAY_MS = 2500;

  let session = null;      // { access_token, refresh_token, expires_at, email, via? }
  let who     = null;      // last meganet.whoami() answer, or null
  let timer   = null;
  // What the panel is showing and what has been typed into it. Typing is
  // mirrored here rather than left in the DOM because every state change
  // repaints the panel: a message that arrives while somebody is mid-type would
  // otherwise take the typing with it. A password is the exception — it is
  // read off its box when the form is sent and never kept.
  let ui = fresh('signin');
  // Which of Google and Microsoft can be offered, once asked (loadProviders):
  // switched on in GoTrue's /settings and answering /authorize with a redirect.
  // null until then, and {} if neither — a panel with no provider buttons is
  // the email and password panel, not a fault.
  let external = null;
  // The notes said once a page: an account waiting for approval, and an
  // administrator with accounts waiting for them.
  const told = { pending: false, approvals: false };
  let nudgeTimer = null;
  // What had focus when the panel opened, to have it back when it closes.
  let opener = null;

  // `link`: the emailed link waiting for Continue, { hash, type, failed }.
  function fresh(step) {
    return { step, email: '', name: '', code: '', busy: false, msg: null, show: false, check: null, link: null };
  }

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
      adopt({ ...fromTokenResponse(body, session.email), ...(session.via ? { via: session.via } : {}) });
      return true;
    } catch (_) {
      // A refresh token is single-use and expires; a failure here means the
      // session is over, and pretending otherwise leaves the app showing a name
      // for someone the database will refuse — or one an administrator has
      // just declined, whose refresh GoTrue now refuses. Behind the gate that
      // is not the end of anything — Access can prove who this is again
      // without a person typing — so try that before giving up.
      const s = await gateSession();
      if (s) { adopt(s); return true; }
      // Sign out quietly — nobody asked for this request, so nobody is waiting
      // for an error about it.
      await signOut({ announce: false });
      return false;
    }
  }

  // ── the endpoints ──

  // `method` is POST but for the one PUT (/user, a new password). An error
  // carries GoTrue's status and its error code (error_code in newer GoTrue,
  // error in older), and a weak password's reasons — what errorText() reads.
  async function post(path, body, opts = {}) {
    const res = await fetch(`${AUTH_URL}/${path}`, {
      method: opts.method || 'POST',
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
      err.code = (parsed && (parsed.error_code || parsed.error)) || '';
      err.reasons = (parsed && parsed.weak_password && parsed.weak_password.reasons) || [];
      throw err;
    }
    return parsed;
  }

  // Where a link in an email, or a provider, should bring the person back to.
  // Stated rather than left out, because leaving it out does not mean "come
  // back here" — it means GoTrue falls back to the project's Site URL, which
  // ships as http://localhost:3000 and sends the link to a port nothing is
  // listening on. The app knows its own origin; a dashboard field is a worse
  // place to keep that. This is not a loosening: Authentication → URL
  // Configuration → Redirect URLs decides whether the value is honoured, and an
  // origin not on that list is refused, not obeyed. See docs/access.md.
  function backHere() {
    return encodeURIComponent(location.origin + location.pathname);
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

  // ── the gate ──
  //
  // Cloudflare Access proved who this is before the page loaded. Asking a second
  // time was friction, not security: `meganet.editor_allow` is the Access policy
  // written again, so everyone the door admits is already an editor.
  // worker/index.js verifies that proof against Access's own public keys and
  // mints an ordinary Supabase session from it; this is the browser half.
  //
  // What does *not* change is who may write. The token minted is the person's,
  // not the Worker's, so meganet.is_editor() reads it exactly as it reads one
  // from the email flow and meganet.actor() still attributes the save.
  //
  // Every failure is silent, because none of the common ones is a fault: 401 on
  // an origin Access does not cover (github.io, workers.dev, file://, and
  // floodwarning.net itself since the gate came off), 404 where no Worker is
  // deployed, 503 before its secrets are set, 403 for an address the gate
  // admits and the editors list does not. All of them mean the same thing to
  // the app — no gate here — and leave the panel below in charge.
  const NO_GATE_KEY = 'meganet.no-gate';

  function gateSuppressed() {
    try { return sessionStorage.getItem(NO_GATE_KEY) === '1'; } catch (_) { return false; }
  }

  async function gateSession() {
    if (location.protocol === 'file:' || gateSuppressed()) return null;
    try {
      const res = await fetch('/api/session', { method: 'POST', cache: 'no-store' });
      if (!res.ok) return null;
      const body = await res.json();
      if (!body || !body.access_token) return null;
      const s = fromTokenResponse(body, body.email);
      // Remembered so the panel can say how this session was obtained, and so
      // signing out can explain what it does and does not undo.
      s.via = 'gate';
      return s;
    } catch (_) { return null; }
  }

  // ── Google and Microsoft ──

  // /settings says which providers are switched on, not which work: Google was
  // on in this project with no client secret, and its button opened a page of
  // JSON. So each one switched on is asked to start — /authorize, not followed
  // — and offered only if it answers with the redirect to its sign-in page (to
  // fetch, an opaque redirect). A 400 ("missing OAuth secret") or no answer at
  // all leaves its button off; the email and password are always there.
  async function answers(provider) {
    try {
      const res = await fetch(`${AUTH_URL}/authorize?provider=${provider}`, {
        redirect: 'manual', cache: 'no-store', credentials: 'omit',
      });
      return res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
    } catch (_) { return false; }
  }

  async function loadProviders() {
    if (external) return external;
    let on = {};
    try {
      const res = await fetch(`${AUTH_URL}/settings`, {
        headers: { apikey: DB_ANON_KEY }, cache: 'no-store',
      });
      on = res.ok ? ((await res.json()).external || {}) : {};
    } catch (_) { on = {}; }
    const keys = Object.keys(PROVIDERS).filter(k => on[k]);
    const work = await Promise.all(keys.map(answers));
    external = Object.fromEntries(keys.map((k, i) => [k, work[i]]));
    return external;
  }

  // A navigation, not a fetch: GoTrue answers /authorize with a redirect to the
  // provider, the provider to the project's /callback, and that to
  // redirect_to with the session in the fragment. Microsoft's `email` scope is
  // what GoTrue needs to be handed the address at all; Google's default scopes
  // carry it. The provider's account is a new account like any other: a
  // Bureau address is approved by the allowlist, anybody else's waits.
  const PROVIDERS = {
    google: { label: 'Continue with Google', scopes: '' },
    azure:  { label: 'Continue with Microsoft', scopes: 'email' },
  };

  function signInWith(provider) {
    const p = PROVIDERS[provider];
    if (!p) return;
    ui.busy = true;
    ui.msg  = { kind: 'busy', text: `Opening ${provider === 'azure' ? 'Microsoft' : 'Google'} sign-in…` };
    render();
    location.assign(`${AUTH_URL}/authorize?provider=${provider}${p.scopes ? `&scopes=${p.scopes}` : ''}`
      + `&redirect_to=${backHere()}`);
  }

  // The Microsoft button's old name, kept for any page that still calls it.
  function signInMicrosoft() { signInWith('azure'); }

  // ── what the database says may happen ──

  // Refuse in the browser what the database is going to refuse anyway, so an
  // address that was never going to be let in does not cost a round trip to a
  // mailbox and a wait. Not a security check — meganet.auth_user_gate() is —
  // and it deliberately fails open: if this call itself fails, the request goes
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

  // What the Create account form says under the address (0062): whether an
  // account can be made for it, and whether it will be approved on its own.
  // null when the database cannot say — a database before 0062, or none at all
  // — and the form then says the general thing.
  async function signupCheck(email) {
    try {
      const res = await fetch(`${DB_URL}/rpc/signup_check`, {
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
      return res.ok ? await res.json() : null;
    } catch (_) { return null; }
  }

  // ── signing in ──

  function emailOf(id) {
    return (document.getElementById(id)?.value || '').trim();
  }
  function looksLikeEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }

  // After any way in: the database asked who this is, the panel told, every tab
  // that keeps something for a session told.
  async function arrived(note) {
    who = await whoami();
    if (who && who.email && session && !session.email) { session.email = who.email; store(session); }
    setBusy(false);
    ui.step = 'in';
    ui.msg = note ? { kind: 'ok', text: note } : null;
    syncHeader();
    render();
    // The editor's status line says "not signed in" until something tells it
    // otherwise, and it is on screen behind this panel.
    if (typeof rerenderStationEditorCard === 'function') rerenderStationEditorCard();
    hideNudge();
    tabsAuthChanged();
    sayStanding();
  }

  async function signIn(e) {
    if (e) e.preventDefault();
    const email = emailOf('au-email');
    const password = document.getElementById('au-password')?.value || '';
    ui.email = email;
    if (!looksLikeEmail(email)) return setMsg('error', 'That does not look like an email address.');
    if (!password) return setMsg('error', 'Type your password — or use Forgot your password, or an emailed code.');
    setBusy(true, 'Signing in…');
    let body;
    try {
      body = await post('token?grant_type=password', { email, password });
    } catch (err) {
      setBusy(false);
      if (err.code === 'email_not_confirmed' || /not confirmed/i.test(err.message)) {
        ui.step = 'confirm';
        return setMsg('error', `${email} has not been confirmed yet. Click the link in the email we sent, or type its code below — or send it again.`);
      }
      return setMsg('error', errorText(err, email));
    }
    adopt(fromTokenResponse(body, email));
    await arrived();
  }

  async function signUp(e) {
    if (e) e.preventDefault();
    const email = emailOf('au-email');
    const password = document.getElementById('au-password')?.value || '';
    const name = (document.getElementById('au-name')?.value || '').trim().slice(0, 60);
    ui.email = email;
    ui.name = name;
    if (!looksLikeEmail(email)) return setMsg('error', 'That does not look like an email address.');
    if (password.length < PASSWORD_MIN) {
      return setMsg('error', `Use at least ${PASSWORD_MIN} characters. Three or four ordinary words make a long password that is easy to remember.`);
    }
    setBusy(true, 'Creating the account…');
    let body;
    try {
      body = await post(`signup?redirect_to=${backHere()}`,
                        { email, password, data: name ? { full_name: name } : {} });
    } catch (err) {
      setBusy(false);
      return setMsg('error', errorText(err, email));
    }
    setBusy(false);
    // A project that confirms nobody (mailer_autoconfirm) answers with a
    // session straight away; the one this app is built for answers with the
    // user and sends the email.
    if (body && body.access_token) {
      adopt(fromTokenResponse(body, email));
      return arrived('Account created.');
    }
    ui.step = 'confirm';
    ui.code = '';
    setMsg('ok', `Nearly there. We have emailed ${email}: click the link in it, or type its six-digit code here. `
      + 'If it does not arrive in a few minutes, look in junk mail, then send it again.');
    document.getElementById('au-code')?.focus();
  }

  // The confirmation code from the sign-up email. `email` covers a sign-up's
  // code as well as a sign-in code's in GoTrue, so one verify serves both.
  async function confirmCode(e) {
    if (e) e.preventDefault();
    const token = (document.getElementById('au-code')?.value || '').replace(/\s+/g, '');
    ui.code = token;
    if (!token) return setMsg('error', 'Type the code from the email.');
    setBusy(true, 'Confirming…');
    let body;
    try {
      body = await post('verify', { email: ui.email, token, type: 'email' });
    } catch (err) {
      setBusy(false);
      return setMsg('error', err.status === 401 || err.status === 403 || err.code === 'otp_expired'
        ? 'That code was not accepted. Codes expire — send a new one if this keeps happening.'
        : errorText(err, ui.email));
    }
    adopt(fromTokenResponse(body, ui.email));
    await arrived('Address confirmed — you are signed in.');
  }

  async function resend() {
    if (!looksLikeEmail(ui.email)) return setMsg('error', 'Type the address the account was made with, then send it again.');
    setBusy(true, 'Sending…');
    try {
      await post(`resend?redirect_to=${backHere()}`, { type: 'signup', email: ui.email });
    } catch (err) {
      setBusy(false);
      return setMsg('error', errorText(err, ui.email));
    }
    setBusy(false);
    setMsg('ok', `Sent again to ${ui.email}. The newest email's link and code are the ones that work.`);
  }

  // ── a code by email instead of a password (the original way in) ──

  async function requestCode(e) {
    if (e) e.preventDefault();
    const email = emailOf('au-email');
    if (!looksLikeEmail(email)) return setMsg('error', 'That does not look like an email address.');
    ui.email = email;
    setBusy(true, 'Checking…');
    if (!await maySignIn(email)) {
      setBusy(false);
      return setMsg('error',
        `New accounts are open only to listed addresses at the moment, and ${email} is not one, so no code was `
        + 'sent. Any @bom.gov.au address can sign in; anyone else has to be added by an administrator.');
    }
    setBusy(true, 'Sending…');
    try {
      // create_user true is what makes this a sign-in and a sign-up at once —
      // an account with no password, which is a fine account to have.
      await post(`otp?redirect_to=${backHere()}`, { email, create_user: true });
    } catch (err) {
      setBusy(false);
      return setMsg('error', errorText(err, email));
    }
    setBusy(false);
    ui.step = 'code';
    ui.code = '';
    setMsg('ok', `Sent. Check ${email} — click the link, or type the six-digit code below.`);
    document.getElementById('au-code')?.focus();
  }

  async function verifyCode(e) {
    if (e) e.preventDefault();
    const token = (document.getElementById('au-code')?.value || '').replace(/\s+/g, '');
    ui.code = token;
    if (!token) return setMsg('error', 'Enter the code from the email.');
    setBusy(true, 'Verifying…');
    let body;
    try {
      body = await post('verify', { email: ui.email, token, type: 'email' });
    } catch (err) {
      setBusy(false);
      return setMsg('error',
        err.status === 401 || err.status === 403 || err.code === 'otp_expired'
          ? 'That code was not accepted. Codes expire — send a new one if this keeps happening.'
          : errorText(err, ui.email));
    }
    adopt(fromTokenResponse(body, ui.email));
    await arrived();
  }

  // ── a forgotten password ──

  async function forgot(e) {
    if (e) e.preventDefault();
    const email = emailOf('au-email');
    if (!looksLikeEmail(email)) return setMsg('error', 'That does not look like an email address.');
    ui.email = email;
    setBusy(true, 'Sending…');
    try {
      await post(`recover?redirect_to=${backHere()}`, { email });
    } catch (err) {
      setBusy(false);
      return setMsg('error', errorText(err, email));
    }
    setBusy(false);
    ui.step = 'recover';
    ui.code = '';
    // Said the same whether or not there is an account: GoTrue answers alike
    // either way, so that the form cannot be used to find out who has one.
    setMsg('ok', `If ${email} has an account, an email is on its way: click its link, or type its code below, `
      + 'and then choose a new password.');
    document.getElementById('au-code')?.focus();
  }

  async function recoverCode(e) {
    if (e) e.preventDefault();
    const token = (document.getElementById('au-code')?.value || '').replace(/\s+/g, '');
    ui.code = token;
    if (!token) return setMsg('error', 'Type the code from the email.');
    setBusy(true, 'Checking the code…');
    let body;
    try {
      body = await post('verify', { email: ui.email, token, type: 'recovery' });
    } catch (err) {
      setBusy(false);
      return setMsg('error', err.status === 401 || err.status === 403 || err.code === 'otp_expired'
        ? 'That code was not accepted. Codes expire — ask for a new email if this keeps happening.'
        : errorText(err, ui.email));
    }
    adopt(fromTokenResponse(body, ui.email));
    toNewPassword('Code accepted — you are signed in. Choose a new password.');
  }

  // Signed in by a recovery — the code or the link — and on to the one thing
  // the person came for.
  function toNewPassword(note) {
    setBusy(false);
    ui.step = 'newpw';
    setMsg('ok', note);
    document.getElementById('au-password')?.focus();
    syncHeader();
    tabsAuthChanged();
  }

  // A new password, for the account signed in: after a recovery, or from the
  // account panel. GoTrue checks it against its own rules and says why not.
  async function setPassword(e) {
    if (e) e.preventDefault();
    const password = document.getElementById('au-password')?.value || '';
    if (password.length < PASSWORD_MIN) {
      return setMsg('error', `Use at least ${PASSWORD_MIN} characters. Three or four ordinary words make a long password that is easy to remember.`);
    }
    if (!session) return setMsg('error', 'The session has ended — sign in again, or ask for a new email.');
    setBusy(true, 'Saving…');
    try {
      await post('user', { password }, { method: 'PUT', token: session.access_token });
    } catch (err) {
      setBusy(false);
      return setMsg('error', err.code === 'reauthentication_needed'
        ? 'For safety this needs a fresh sign-in: sign out, use Forgot your password, and set it from the email.'
        : errorText(err, (who && who.email) || session.email || ''));
    }
    await arrived('Password saved. Use it with your email address next time.');
  }

  // GoTrue's refusals, in the words the person needs. It does not pass a
  // trigger's message through, so a sign-up the database refused arrives as a
  // generic "Database error saving new user" — which, since 0062, means sign-up
  // has been closed to listed addresses.
  function errorText(err, email) {
    const m = String(err && err.message || '');
    const code = (err && err.code) || '';
    if (/database error|unexpected_failure/i.test(m)) {
      return `New accounts are open only to listed addresses at the moment, and ${email || 'this address'} is not `
           + 'one. Any @bom.gov.au address can still sign up; anyone else has to be added by an administrator.';
    }
    if (code === 'invalid_credentials' || code === 'invalid_grant' || /invalid login credentials/i.test(m)) {
      return 'That email and password do not match an account. Check both, or use Forgot your password.';
    }
    if (code === 'user_banned' || /banned/i.test(m)) {
      return 'This account cannot sign in: an administrator has declined it. If that is a mistake, ask them to look again.';
    }
    if (code === 'weak_password' || /password/i.test(m) && /weak|short|least|pwned|breach|leak/i.test(m)) {
      const r = err.reasons || [];
      if (r.includes('pwned') || /pwned|breach|leak/i.test(m)) {
        return 'That password has turned up in a data breach somewhere, so it is not safe to use. Choose another.';
      }
      return `That password is too weak: ${m.replace(/\.$/, '')}. A longer one — three or four ordinary words — works.`;
    }
    if (code === 'same_password') return 'That is the password the account already has — choose a different one.';
    if (code === 'email_address_invalid' || /email address .* invalid/i.test(m)) {
      return `${email} was not accepted as an email address.`;
    }
    if (code === 'signup_disabled' || /signups not allowed/i.test(m)) {
      return 'New accounts are switched off on this server at the moment.';
    }
    if (code === 'over_email_send_rate_limit' || /email rate limit/i.test(m)) {
      return 'Too many emails have gone out for now. Wait a few minutes and try again.';
    }
    if (err && err.status === 429) return 'Too many attempts in a row. Wait a minute and try again.';
    if (err && err.status === 0) return 'No answer — check the connection and try again.';
    return `That did not work — ${m}`;
  }

  // `suppressGate` follows `announce` because the two callers differ in exactly
  // that way: a person clicking Sign out means it, and must not be signed back
  // in by the gate a moment later; the internal callers (a refresh that failed,
  // a token the database disowns) are cleaning up and should still be allowed
  // to recover through the door. `everywhere` ends every session the account
  // has, on every device — GoTrue's global scope.
  async function signOut({ announce = true, suppressGate = announce, everywhere = false } = {}) {
    const token = session && session.access_token;
    if (suppressGate) {
      try { sessionStorage.setItem(NO_GATE_KEY, '1'); } catch (_) { /* memory only */ }
    }
    adopt(null);
    who = null;
    // A stored session found stale behind a link waiting for Continue must not
    // take the link with it.
    if (ui.step !== 'link') ui = fresh('signin');
    told.pending = told.approvals = false;
    // Best effort, and deliberately after the local state is already gone: if
    // this fails the token is still forgotten here, which is the part that
    // matters to the person at the keyboard.
    if (token) { try { await post(`logout${everywhere ? '?scope=global' : ''}`, {}, { token }); } catch (_) { /* already gone */ } }
    syncHeader();
    if (announce && document.getElementById('auth-modal')?.style.display === 'flex') render();
    if (typeof rerenderStationEditorCard === 'function') rerenderStationEditorCard();
    tabsAuthChanged();
  }

  // ── the link landing ──
  // A link from an email, or a provider, returns here with the session in the
  // URL *fragment* — which never reaches a server, and is why GoTrue uses it.
  // Consuming it means taking the tokens and then removing them from the
  // address bar, so a copied URL or a screenshot is not a copied session. A
  // password-reset link says type=recovery, and the panel then opens on
  // choosing the new password.
  function consumeHash() {
    const raw = location.hash || '';
    // A refused OAuth sign-in can come back in the query string rather than the
    // fragment, depending on which hop refused it.
    const q = new URLSearchParams(location.search);
    const queryError = q.get('error') && (q.get('error_description') || q.get('error_code'));
    if (!raw.includes('access_token=') && !raw.includes('error=') && !queryError) return false;

    const p = new URLSearchParams(raw.includes('=') ? raw.replace(/^#/, '') : location.search);
    if (queryError) for (const k of ['error', 'error_code', 'error_description']) q.delete(k);
    const search = q.toString() ? `?${q}` : '';
    // replaceState rather than clearing location.hash, which would leave a bare
    // '#' and push a history entry.
    history.replaceState(null, '', location.pathname + search);

    if (p.get('error') || p.get('error_description')) {
      const text = p.get('error_description') || p.get('error');
      ui.msg = { kind: 'error', text: errorText({ message: text, code: p.get('error_code') || '' }, '') };
      // Opened, so the refusal is seen rather than sitting in a closed panel.
      setTimeout(open, 0);
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
    if (p.get('type') === 'recovery') {
      ui = fresh('newpw');
      ui.msg = { kind: 'ok', text: 'You are signed in from the reset email. Choose a new password.' };
      setTimeout(open, 0);
    }
    return true;
  }

  // The links docs/accounts.md's templates send, by the `type` GoTrue's verify
  // takes: `email` for a sign-up's confirmation and a sign-in link alike, and
  // `recovery` for a reset. `again` is the form that sends a fresh one.
  const LINK_KINDS = {
    recovery: { title: 'Reset your password', button: 'Continue to a new password', again: 'forgot',
                lead: 'This is the link from your Flood-Net password reset email.' },
    email:    { title: 'Sign in to Flood-Net', button: 'Continue', again: 'otp',
                lead: 'This is the link from your Flood-Net email.' },
  };

  // A link that came back as ?token_hash=…&type=…: taken out of the address
  // bar, as the fragment's tokens are, and held for Continue — nothing is
  // verified here. The rest of the query (the tab, say) stays.
  function consumeLink() {
    const q = new URLSearchParams(location.search);
    const hash = q.get('token_hash');
    const type = q.get('type');
    if (!hash || !LINK_KINDS[type]) return;
    q.delete('token_hash');
    q.delete('type');
    history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash);
    ui = fresh('link');
    ui.link = { hash, type, failed: false };
    setTimeout(open, 0);
  }

  // Continue: the link verified now, by the person who pressed it.
  async function followLink(e) {
    if (e) e.preventDefault();
    const link = ui.link;
    if (!link) return go('signin');
    setBusy(true, 'Checking the link…');
    let body;
    try {
      body = await post('verify', { type: link.type, token_hash: link.hash });
    } catch (err) {
      link.failed = true;
      setBusy(false);
      return setMsg('error', err.status === 401 || err.status === 403 || err.code === 'otp_expired'
        ? 'That link has been used already, or it has expired. Send yourself a new one.'
        : errorText(err, ''));
    }
    adopt(fromTokenResponse(body, null));
    if (link.type === 'recovery') return toNewPassword('You are signed in from the reset email. Choose a new password.');
    await arrived('Address confirmed — you are signed in.');
  }

  // ── header ──

  function label() {
    if (!session) return 'Sign in';
    const name = who && who.display_name;
    if (name) return name.split(/\s+/)[0];
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
    const standing = who && who.status;
    btn.title = session
      ? `Signed in${email ? ` as ${email}` : ''}${standing === 'pending' ? ' — waiting for approval'
          : who && who.may_write === false ? ' — read only' : ''}`
      : 'Sign in, or create a free account';
    btn.classList.toggle('is-in', !!session);
    btn.classList.toggle('is-waiting', !!session && standing === 'pending');
  }

  // Everything that keeps something for one session, told that the session
  // changed. Field photos are members' (0035, 0062): whatever the tab, the
  // twin and the map were holding was fetched for the session that just ended
  // or began. The Admin tab (admin.js) is administrators-only (0042), and
  // redraws its users and allowlist — or its "sign in" — for the same reason;
  // so is the Base Stations tab (0049), and the Network Review tab; a station's
  // history and the deleted stations are editors-only (0056, station-history.js),
  // and so are a station's site features (0061, site-features.js); and Station
  // Health's Ask Claude (health-agent.js) runs on Flood-Net's key for editors
  // and administrators only (#229), so it asks again who may. The Field Camera
  // (field-camera.js) sends the photos it has kept on this device as soon as
  // somebody is signed in to send them as, and the level surveys and two-peg
  // tests (level-store.js) theirs; the Level Survey tab shows an
  // administrator the filed surveys waiting for a decision (0060). The left
  // bar's views are the account's own (0062, nav-views.js), and the bar shows
  // an administrator how many accounts are waiting for them.
  function tabsAuthChanged() {
    for (const mod of [typeof FieldPhotos !== 'undefined' ? FieldPhotos : null,
                       typeof FieldCamera !== 'undefined' ? FieldCamera : null,
                       typeof LevelStore  !== 'undefined' ? LevelStore  : null,
                       typeof LevelSurvey !== 'undefined' ? LevelSurvey : null,
                       typeof TwoPeg      !== 'undefined' ? TwoPeg      : null,
                       typeof Admin       !== 'undefined' ? Admin       : null,
                       typeof AdminDash   !== 'undefined' ? AdminDash   : null,
                       typeof AdminTokens !== 'undefined' ? AdminTokens : null,
                       typeof BaseStations !== 'undefined' ? BaseStations : null,
                       typeof NetworkReview !== 'undefined' ? NetworkReview : null,
                       typeof Alert2Plan !== 'undefined' ? Alert2Plan : null,
                       typeof StationHistory !== 'undefined' ? StationHistory : null,
                       typeof SiteFeatures !== 'undefined' ? SiteFeatures : null,
                       typeof HealthAgent !== 'undefined' ? HealthAgent : null,
                       typeof NavViews    !== 'undefined' ? NavViews    : null]) {
      if (!mod || !mod.authChanged) continue;
      try { mod.authChanged(); } catch (_) { /* its own problem, not the sign-in's */ }
    }
  }

  // Once a page, a word on where the account stands — the panel says it at
  // length, but the panel may never be opened: an account waiting for an
  // administrator, and an administrator with accounts waiting for them.
  function sayStanding() {
    if (typeof Toast === 'undefined' || !who) return;
    if (who.status === 'pending' && !told.pending) {
      told.pending = true;
      Toast.show('Signed in. Your account is waiting for an administrator to approve it — you will get an email when '
        + 'they have. Your own left-bar views work already.', { kind: 'note', ms: 9000 });
    }
    const n = Number(who.approvals_waiting) || 0;
    if (n > 0 && !told.approvals) {
      told.approvals = true;
      Toast.show(`${n} account${n === 1 ? ' is' : 's are'} waiting for your approval — on the Admin tab.`,
                 { kind: 'note', ms: 9000 });
    }
  }

  // ── panel ──

  function msgHtml() {
    if (!ui.msg) return '';
    const cls = ui.msg.kind === 'error' ? 'txt-bad' : ui.msg.kind === 'ok' ? 'txt-ok' : 'txt-muted';
    return `<p class="small au-msg ${cls}" role="${ui.msg.kind === 'error' ? 'alert' : 'status'}">${esc(ui.msg.text)}</p>`;
  }

  // A password box with Show beside it: on a phone, a password typed blind is
  // a password typed twice.
  function passwordHtml(autocomplete, label, busy) {
    return `
          <label>${label}
            <span class="au-pw">
              <input type="${ui.show ? 'text' : 'password'}" id="au-password" name="password" autocomplete="${autocomplete}"
                     ${autocomplete === 'new-password' ? `minlength="${PASSWORD_MIN}"` : ''} required ${busy ? 'disabled' : ''}
                     spellcheck="false" autocapitalize="off">
              <button type="button" class="au-show" aria-pressed="${ui.show}" onclick="Auth.togglePassword()"
                      aria-label="${ui.show ? 'Hide the password' : 'Show the password'}">${ui.show ? 'Hide' : 'Show'}</button>
            </span>
          </label>`;
  }

  function emailHtml(busy, autocomplete = 'username email') {
    return `
          <label>Email address
            <input type="email" id="au-email" name="email" autocomplete="${autocomplete}" inputmode="email" required
                   value="${escAttr(ui.email)}" ${busy ? 'disabled' : ''} spellcheck="false" autocapitalize="off"
                   ${ui.step === 'signup' ? 'oninput="Auth.checkAddress(this.value)"' : ''}>
          </label>`;
  }

  function providersHtml(busy) {
    const on = Object.keys(PROVIDERS).filter(k => external && external[k]);
    if (!on.length) return '';
    return `
        <div class="au-providers">
          ${on.map(k => `<button type="button" class="au-provider" onclick="Auth.signInWith('${k}')" ${busy ? 'disabled' : ''}>
             ${esc(PROVIDERS[k].label)}</button>`).join('')}
        </div>
        <p class="au-or" aria-hidden="true"><span>or with your email</span></p>`;
  }

  // The terms and the privacy policy, said where an account is made — on the
  // Create form, and under Sign in, where Continue with Google can make one
  // too. A new tab, so following the link does not lose what was typed.
  function legalHtml(verb) {
    return `
        <p class="small au-legal">${verb} means you agree to the
          <a href="/terms" target="_blank" rel="noopener">terms of use</a>. The
          <a href="/privacy" target="_blank" rel="noopener">privacy policy</a> says what is kept, and why.</p>`;
  }

  // What an account is for — said where it is decided, on the Create form, and
  // in the visitor note.
  function benefitsHtml() {
    return `
        <ul class="au-benefits">
          <li><span aria-hidden="true">📷</span> See the field photos of every site — straight away with a Bureau address,
            once an administrator approves you with any other</li>
          <li><span aria-hidden="true">🎛️</span> Keep your own left-bar views, on every device you sign in on</li>
          <li><span aria-hidden="true">✏️</span> Edit stations, file inspections and add photos — for Bureau staff and
            the people an administrator adds</li>
        </ul>`;
  }

  function checkHtml() {
    const c = ui.check;
    if (!c || !looksLikeEmail(ui.email)) {
      return '<p class="small au-check" id="au-check">A Bureau address is approved as soon as you confirm it; any other is approved by an administrator, who is told.</p>';
    }
    if (c.allowed === false) {
      return `<p class="small au-check txt-bad" id="au-check">New accounts are open only to listed addresses at the moment, and this is not one.</p>`;
    }
    return c.automatic
      ? '<p class="small au-check txt-ok" id="au-check">✓ This address is approved as soon as you confirm it.</p>'
      : '<p class="small au-check" id="au-check">An administrator approves accounts from outside the Bureau. You can sign in and keep your views meanwhile, and we email you when it is done.</p>';
  }

  let checkTimer = null;
  function checkAddress(value) {
    ui.email = String(value || '').trim();
    clearTimeout(checkTimer);
    if (!looksLikeEmail(ui.email)) { ui.check = null; paintCheck(); return; }
    const asked = ui.email;
    checkTimer = setTimeout(async () => {
      const c = await signupCheck(asked);
      if (ui.email !== asked) return;
      ui.check = c;
      paintCheck();
    }, 350);
  }
  function paintCheck() {
    const el = document.getElementById('au-check');
    if (el) el.outerHTML = checkHtml();
  }

  function standingHtml() {
    if (!who) return '<p class="small">The database did not answer when asked about this account; saving will say what it allows.</p>';
    const s = who.status;
    const lines = {
      automatic: '✓ <strong>Approved</strong> — your address is on the access list, so nobody had to approve it.',
      approved:  '✓ <strong>Approved</strong> by an administrator.',
      pending:   '⏳ <strong>Waiting for approval.</strong> An administrator has been told, and you will get an email when they '
               + 'have approved the account. Meanwhile your own left-bar views work, and everything that needs no account.',
      declined:  '✗ An administrator has <strong>declined</strong> this account.',
      unconfirmed: 'This address has not been confirmed yet — use the link or the code in the email.',
    };
    const can = [];
    if (who.is_member) can.push('see the field photos');
    if (who.may_write) can.push('edit stations, file inspections and add photos');
    if (who.is_admin) can.push('approve accounts and manage users on the Admin tab');
    return `
          <p class="small au-standing">${lines[s] || ''}</p>
          ${can.length ? `<p class="small">You can ${esc(can.join('; '))}.</p>` : ''}
          ${who.is_member && !who.may_write ? '<p class="small">Editing is for Bureau staff and the people an administrator adds — ask one if you should be able to.</p>' : ''}`;
  }

  function template() {
    const busy = ui.busy;
    const msg  = msgHtml();
    let body;
    let title = 'Sign in to Flood-Net';
    let sub = 'Reading needs no account: the station list, the maps and every tool work without one.';

    if (ui.step === 'in') {
      title = 'Your account';
      sub = '';
      const email = (who && who.email) || session?.email || '';
      const name = who && who.display_name;
      body = `
        <div class="modal-form">
          <p>Signed in as ${name ? `<strong>${esc(name)}</strong> · ` : ''}<strong>${esc(email || 'this account')}</strong>.</p>
          ${standingHtml()}
          ${msg}
          <p class="small">${
            session && session.via === 'gate'
              ? 'Signed in automatically, because this site is behind Cloudflare Access. Signing out here applies to this tab; to leave for good, log out of Access.'
              : 'This device remembers the sign-in until you sign out.'
          }</p>
          <details class="au-change">
            <summary>Set a new password</summary>
            <form class="modal-form" onsubmit="Auth.setPassword(event)" novalidate>
              ${passwordHtml('new-password', 'New password', busy)}
              <p class="small">At least ${PASSWORD_MIN} characters. A sign-in with a code or with Google or Microsoft keeps
                working whether or not the account has a password.</p>
              <div class="modal-foot"><button type="submit" class="primary" ${busy ? 'disabled' : ''}>Save the password</button></div>
            </form>
          </details>
        </div>
        <div class="modal-foot">
          <button type="button" onclick="Auth.signOut({everywhere:true})" title="End this account's sessions on every device">Sign out everywhere</button>
          <button type="button" onclick="Auth.close()">Close</button>
          <button type="button" class="primary" id="au-signout" onclick="Auth.signOut()">Sign out</button>
        </div>`;
    } else if (ui.step === 'signup') {
      title = 'Create a Flood-Net account';
      sub = '';
      body = `
        <form class="modal-form" onsubmit="Auth.signUp(event)" novalidate>
          ${providersHtml(busy)}
          ${emailHtml(busy, 'email')}
          ${checkHtml()}
          ${passwordHtml('new-password', 'Choose a password', busy)}
          <p class="small">At least ${PASSWORD_MIN} characters. Three or four ordinary words make a long password that is
            easy to remember — and a password manager can make and keep one for you.</p>
          <label>Your name <span class="txt-muted">(optional — what administrators see)</span>
            <input type="text" id="au-name" name="name" autocomplete="name" maxlength="60"
                   value="${escAttr(ui.name)}" ${busy ? 'disabled' : ''}>
          </label>
          ${msg}
          <div class="modal-foot">
            <button type="button" onclick="Auth.go('signin')" ${busy ? 'disabled' : ''}>I have an account</button>
            <button type="submit" class="primary" ${busy ? 'disabled' : ''}>Create the account</button>
          </div>
          <details class="au-why">
            <summary>What an account gives you</summary>
            ${benefitsHtml()}
          </details>
          ${legalHtml('Creating an account')}
        </form>`;
    } else if (ui.step === 'confirm') {
      title = 'Confirm your address';
      sub = '';
      body = `
        <form class="modal-form" onsubmit="Auth.confirmCode(event)" novalidate>
          ${msg}
          ${emailHtml(busy)}
          <label>Six-digit code from the email
            <input type="text" id="au-code" inputmode="numeric" autocomplete="one-time-code"
                   placeholder="123456" value="${escAttr(ui.code)}" ${busy ? 'disabled' : ''}>
          </label>
          <p class="small">The email's link does the same job, in whichever tab it opens.</p>
          <div class="modal-foot">
            <button type="button" onclick="Auth.resend()" ${busy ? 'disabled' : ''}>Send it again</button>
            <button type="submit" class="primary" ${busy ? 'disabled' : ''}>Confirm</button>
          </div>
          <p class="small"><button type="button" class="link-btn" onclick="Auth.go('signin')">Back to sign in</button></p>
        </form>`;
    } else if (ui.step === 'forgot') {
      title = 'Reset your password';
      sub = '';
      body = `
        <form class="modal-form" onsubmit="Auth.forgot(event)" novalidate>
          ${emailHtml(busy)}
          <p class="small">We email a link and a code. Either signs you in, and then you choose a new password.</p>
          ${msg}
          <div class="modal-foot">
            <button type="button" onclick="Auth.go('signin')" ${busy ? 'disabled' : ''}>Back</button>
            <button type="submit" class="primary" ${busy ? 'disabled' : ''}>Email me a reset</button>
          </div>
        </form>`;
    } else if (ui.step === 'recover') {
      title = 'Reset your password';
      sub = '';
      body = `
        <form class="modal-form" onsubmit="Auth.recoverCode(event)" novalidate>
          ${msg}
          <label>Six-digit code from the email
            <input type="text" id="au-code" inputmode="numeric" autocomplete="one-time-code"
                   placeholder="123456" value="${escAttr(ui.code)}" ${busy ? 'disabled' : ''}>
          </label>
          <div class="modal-foot">
            <button type="button" onclick="Auth.go('forgot')" ${busy ? 'disabled' : ''}>Send another</button>
            <button type="submit" class="primary" ${busy ? 'disabled' : ''}>Continue</button>
          </div>
        </form>`;
    } else if (ui.step === 'link') {
      const kind = LINK_KINDS[ui.link && ui.link.type] || LINK_KINDS.email;
      const failed = ui.link && ui.link.failed;
      title = kind.title;
      sub = '';
      body = `
        <form class="modal-form" onsubmit="Auth.followLink(event)" novalidate>
          <p>${esc(kind.lead)}</p>
          ${msg}
          <p class="small">One more click, on purpose: work email systems open the links in an email to check them,
            and a link that worked on its own would be used up before you got to it.</p>
          <div class="modal-foot">
            ${failed
              ? `<button type="button" onclick="Auth.close()" ${busy ? 'disabled' : ''}>Close</button>
                 <button type="button" class="primary" onclick="Auth.go('${kind.again}')" ${busy ? 'disabled' : ''}>Send a new email</button>`
              : `<button type="button" onclick="Auth.close()" ${busy ? 'disabled' : ''}>Not now</button>
                 <button type="submit" class="primary" ${busy ? 'disabled' : ''}>${esc(kind.button)}</button>`}
          </div>
        </form>`;
    } else if (ui.step === 'newpw') {
      title = 'Choose a new password';
      sub = '';
      body = `
        <form class="modal-form" onsubmit="Auth.setPassword(event)" novalidate>
          ${msg}
          ${passwordHtml('new-password', 'New password', busy)}
          <p class="small">At least ${PASSWORD_MIN} characters. Three or four ordinary words make a long password that is
            easy to remember.</p>
          <div class="modal-foot">
            <button type="button" onclick="Auth.close()" ${busy ? 'disabled' : ''}>Not now</button>
            <button type="submit" class="primary" ${busy ? 'disabled' : ''}>Save the password</button>
          </div>
        </form>`;
    } else if (ui.step === 'code') {
      title = 'Sign in with a code';
      body = `
        <form class="modal-form" onsubmit="Auth.verifyCode(event)" novalidate>
          <label>Six-digit code from the email
            <input type="text" id="au-code" inputmode="numeric" autocomplete="one-time-code"
                   placeholder="123456" value="${escAttr(ui.code)}" ${busy ? 'disabled' : ''}>
          </label>
          <p class="small">The email also contains a link. Clicking it signs you in in whichever
             tab it opens, and you can ignore this box.</p>
          ${msg}
          <div class="modal-foot">
            <button type="button" onclick="Auth.go('otp')" ${busy ? 'disabled' : ''}>Use a different address</button>
            <button type="submit" class="primary" ${busy ? 'disabled' : ''}>Sign in</button>
          </div>
        </form>`;
    } else if (ui.step === 'otp') {
      title = 'Sign in with a code';
      body = `
        <form class="modal-form" onsubmit="Auth.requestCode(event)" novalidate>
          ${emailHtml(busy, 'email')}
          <p class="small">No password needed: an email arrives with a link and a six-digit code. A new address gets an
             account this way too.</p>
          ${msg}
          <div class="modal-foot">
            <button type="button" onclick="Auth.go('signin')" ${busy ? 'disabled' : ''}>Back</button>
            <button type="submit" class="primary" ${busy ? 'disabled' : ''}>Email me a code</button>
          </div>
          ${legalHtml('Signing in')}
        </form>`;
    } else {
      body = `
        <form class="modal-form" onsubmit="Auth.signIn(event)" novalidate>
          ${providersHtml(busy)}
          ${emailHtml(busy)}
          ${passwordHtml('current-password', 'Password', busy)}
          ${msg}
          <div class="modal-foot">
            <button type="button" onclick="Auth.close()" ${busy ? 'disabled' : ''}>Cancel</button>
            <button type="submit" class="primary" ${busy ? 'disabled' : ''}>Sign in</button>
          </div>
          <p class="small au-alt">
            <button type="button" class="link-btn" onclick="Auth.go('forgot')">Forgot your password?</button>
            · <button type="button" class="link-btn" onclick="Auth.go('otp')">Email me a code instead</button>
          </p>
          <p class="small au-new">New to Flood-Net?
            <button type="button" class="link-btn" onclick="Auth.go('signup')">Create a free account</button>
            — it shows you the field photos and keeps your own views.</p>
          ${legalHtml('Signing in')}
        </form>`;
    }

    return `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="au-title"
           onclick="event.stopPropagation()">
        <div class="modal-head">
          <h2 id="au-title">${esc(title)}</h2>
          <button class="modal-x" title="Close (Esc)" aria-label="Close" onclick="Auth.close()">×</button>
        </div>
        ${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
        ${body}
      </div>`;
  }

  // Every repaint of the panel keeps what is in hand while the form is the same
  // form: the address typed (mirrored in `ui`), a password typed so far — the
  // one thing never kept in `ui` — and where the cursor was. A repaint that
  // moves to another form (signed in, say) keeps none of it: a password typed
  // to sign in must not turn up in the box for setting a new one.
  function render() {
    const root = document.getElementById('auth-modal');
    if (!root || root.style.display !== 'flex') return;
    const same = root.dataset.step === ui.step;
    const a = document.activeElement;
    const focusId = same && a && root.contains(a) && a.id ? a.id : null;
    const sel = focusId && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    const box = document.getElementById('au-password');
    const typed = same && box ? box.value : '';
    if (same) ui.email = emailOf('au-email') || ui.email;
    root.innerHTML = template();
    root.dataset.step = ui.step;
    const again = document.getElementById('au-password');
    if (again && typed) again.value = typed;
    const el = focusId && document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch (_) { /* not a text box */ } }
    }
  }

  // `mode`: 'signup' opens on Create an account, 'signin' on the sign-in form;
  // anything else opens wherever the panel was, or on the account if signed in.
  function open(opts) {
    const mode = opts && typeof opts === 'object' ? opts.mode : null;
    let root = document.getElementById('auth-modal');
    if (!root) {
      root = document.createElement('div');
      root.id = 'auth-modal';
      root.className = 'modal-overlay';
      root.onclick = close;
      document.body.appendChild(root);
    }
    const was = root.style.display === 'flex';
    if (!was) opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    // A link waiting for Continue keeps the panel even for somebody signed in:
    // it may be for another account, and it is what they came to press.
    if (session && ui.step !== 'in' && ui.step !== 'newpw' && ui.step !== 'link') { ui.step = 'in'; ui.msg = null; }
    else if (!session && (mode === 'signup' || mode === 'signin')) {
      const keep = ui.email;
      ui = fresh(mode);
      ui.email = keep;
    } else if (!session && ui.step === 'in') ui = fresh('signin');
    root.style.display = 'flex';
    root.innerHTML = template();
    root.dataset.step = ui.step;
    hideNudge();
    // First open only: ask which providers are on, and redraw if any is.
    if (!external) loadProviders().then(e => { if (Object.keys(PROVIDERS).some(k => e[k])) render(); });
    document.addEventListener('keydown', onKey);
    focusFirst();
  }

  function focusFirst() {
    const first = { signin: 'au-email', signup: 'au-email', otp: 'au-email', forgot: 'au-email',
                    confirm: 'au-code', code: 'au-code', recover: 'au-code', newpw: 'au-password' }[ui.step];
    const el = first && document.getElementById(first);
    if (el && !el.value) { el.focus(); return; }
    if ((ui.step === 'signin' || ui.step === 'signup') && el) { document.getElementById('au-password')?.focus(); return; }
    if (el) { el.focus(); return; }
    document.querySelector('#auth-modal .modal-card button.primary, #auth-modal .modal-card button')?.focus();
  }

  // preventDefault claims the key (the Modal contract), so dismissing the
  // sign-in cannot also drop a fullscreen map out from under it.
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

  function close() {
    const root = document.getElementById('auth-modal');
    if (root) root.style.display = 'none';
    document.removeEventListener('keydown', onKey);
    ui.busy = false;
    if (ui.step === 'newpw' && session) { ui.step = 'in'; ui.msg = null; }
    // Not now on a link lets it go: the panel opens as usual next time.
    if (ui.step === 'link') ui = fresh('signin');
    // Focus back to whatever opened the panel, or to the banner's button when
    // that has gone in the meantime (a tab redrawn by the sign-in, say).
    const back = opener && document.contains(opener) && opener.getClientRects().length
      ? opener : document.getElementById('btn-auth');
    opener = null;
    if (back && back.focus) back.focus({ preventScroll: true });
  }

  // From one form of the panel to another, keeping the address typed.
  function go(step) {
    const keep = emailOf('au-email') || ui.email;
    ui = fresh(step);
    ui.email = keep;
    render();
    focusFirst();
    if (step === 'signup' && looksLikeEmail(keep)) checkAddress(keep);
  }

  // The old "Use a different address".
  function back() { go('otp'); }

  function togglePassword() {
    ui.show = !ui.show;
    ui.name = (document.getElementById('au-name')?.value || ui.name);
    render();
    document.getElementById('au-password')?.focus();
  }

  function setMsg(kind, text) { ui.msg = { kind, text }; render(); }
  function setBusy(on, text) {
    ui.busy = on;
    if (text) ui.msg = { kind: 'busy', text };
    render();
  }

  // ── the visitor note ──
  // On arrival without an account, once the page has settled: a card at the
  // foot of the window saying that this is browsing without an account, and
  // the three things an account adds. Not now puts it away for a fortnight on
  // this device; signing in or opening the panel puts it away for good. It is
  // a note, not a dialog: it takes no focus and asks nothing, and it says
  // nothing to a screen reader on its own — the banner's Sign in is where that
  // conversation starts. Under test automation it stands down unless a check
  // asks for it ('mn-nudge' = 'on', as pwa.js does with 'mn-sw'): a card the
  // size of a toast appearing in a hundred checks that are about other things
  // would be a hundred chances to cover what they measure.
  function nudgeWanted() {
    if (session) return false;
    // Not over the panel — an emailed link's Continue opens it on arrival.
    if (document.getElementById('auth-modal')?.style.display === 'flex') return false;
    let until = 0, flag = null;
    try { until = Number(localStorage.getItem(NUDGE_KEY)) || 0; flag = localStorage.getItem('mn-nudge'); } catch (_) {}
    if (flag === 'off') return false;
    if (typeof navigator !== 'undefined' && navigator.webdriver && flag !== 'on') return false;
    return Date.now() >= until;
  }

  function nudge() {
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      if (!nudgeWanted() || document.getElementById('signin-nudge')) return;
      const el = document.createElement('section');
      el.id = 'signin-nudge';
      el.className = 'signin-nudge';
      el.setAttribute('aria-labelledby', 'sn-h');
      el.innerHTML = `
        <button type="button" class="signin-nudge-x" aria-label="Not now" title="Not now" onclick="Auth.snooze()">×</button>
        <h2 id="sn-h" class="signin-nudge-h">You are browsing without an account</h2>
        <p class="small">Everything here reads without one. A free account adds:</p>
        ${benefitsHtml()}
        <div class="button-group">
          <button type="button" class="primary" onclick="Auth.open({mode:'signup'})">Create an account</button>
          <button type="button" onclick="Auth.open({mode:'signin'})">Sign in</button>
          <button type="button" onclick="Auth.snooze()">Not now</button>
        </div>`;
      document.body.appendChild(el);
    }, NUDGE_DELAY_MS);
  }

  function hideNudge() {
    clearTimeout(nudgeTimer);
    document.getElementById('signin-nudge')?.remove();
  }

  function snooze() {
    try { localStorage.setItem(NUDGE_KEY, String(Date.now() + NUDGE_SNOOZE_MS)); } catch (_) {}
    const had = document.getElementById('signin-nudge')?.contains(document.activeElement);
    hideNudge();
    if (had) document.getElementById('btn-auth')?.focus();
  }

  // Ask the database again, after something on this page changed what it
  // would say — an administrator's decision changes the count in the bar.
  async function recheck() {
    if (!session) return;
    const w = await whoami();
    if (!w || !session) return;
    who = w;
    syncHeader();
    if (typeof renderTabs === 'function') renderTabs();
  }

  // ── start ──
  // Called from init(). Everything here is best-effort and none of it blocks the
  // app drawing: a person who never signs in must not wait on an auth server to
  // see the station list.
  function start() {
    consumeLink();
    const landed = consumeHash();
    if (!landed) {
      const s = load();
      // Expired while the tab was closed. Keep it only if there is a refresh
      // token to redeem — otherwise it is just a string that will 401.
      if (s && (s.expires_at > Date.now() || s.refresh_token)) adopt(s);
      else if (s) store(null);
    }
    syncHeader();

    (async () => {
      // Nothing stored, or nothing worth keeping. Ask the gate before the header
      // offers a sign-in link to somebody who signed in at the door already.
      if (!session) {
        const s = await gateSession();
        if (!s) { nudge(); return; }
        adopt(s);
        syncHeader();
      }
      if (session.expires_at <= Date.now() && !await refresh()) { nudge(); return; }
      who = await whoami();
      // A token the database will not honour is worse than no token: the editor
      // would offer to save and the save would be refused.
      if (who && who.signed_in === false) { await signOut({ announce: false }); nudge(); return; }
      if (who && who.email && session && !session.email) { session.email = who.email; store(session); }
      syncHeader();
      render();
      if (typeof rerenderStationEditorCard === 'function') rerenderStationEditorCard();
      tabsAuthChanged();
      sayStanding();
    })();
  }

  return {
    start, open, close, back, go, render,
    signIn, signUp, confirmCode, resend, forgot, recoverCode, setPassword, followLink,
    requestCode, verifyCode, signInWith, signInMicrosoft, signOut,
    togglePassword, checkAddress, snooze, recheck,
    // Read by the editor and the Data source panel. Both ask the database in the
    // end; these only decide what to say before that round trip.
    isSignedIn: () => !!session,
    // The session's bearer as it is now (refreshed in place), for this origin's
    // own Worker routes that put it to the database rather than trust it — the
    // briefing's (worker/briefing.js), as datastore.js does for /api/photos.
    accessToken: () => (session && session.access_token) || null,
    mayWrite:   () => !!session && (who ? who.may_write !== false : true),
    email:      () => (who && who.email) || (session && session.email) || null,
    role:       () => (who && who.role) || null,
    // whoami()'s is_admin (0042) — meganet.is_admin() as the database sees it.
    // What the Admin tab asks before it offers the user list; the functions
    // behind it refuse anybody else regardless.
    isAdmin:    () => !!session && !!(who && who.is_admin),
    // whoami()'s is_member (0062): may see the field photos. False until the
    // database has answered — an answer is what decides, not a guess.
    isMember:   () => !!session && !!(who && who.is_member),
    // Whether whoami() has answered for this session yet.
    known:      () => !!session && !!who,
    // unconfirmed | pending | approved | automatic | declined, or null (0062).
    standing:   () => (session && who && who.status) || null,
    displayName: () => (who && who.display_name) || null,
    // To an administrator: the accounts waiting for a decision (0062).
    approvalsWaiting: () => (session && who && Number(who.approvals_waiting)) || 0,
    // Whether anybody may sign up (0062), as the database last said.
    signupOpen: () => !who || who.signup !== 'allowlist',
    // The address of the session stored on this device, before start() has
    // adopted it — what nav-views.js matches its copy of the views against.
    storedEmail: () => {
      const s = session || load();
      return s && s.email ? String(s.email).toLowerCase() : null;
    },
    // The schema the database answering this session is at, as whoami()
    // echoes it (0005), or null before it has answered. What the editor asks
    // before it sends a proposal to a database that would not know one (0039).
    schemaVersion: () => (who && who.schema_version != null && who.schema_version !== ''
      ? Number(who.schema_version) : null),
  };
})();
if (typeof window !== 'undefined') window.Auth = Auth;
