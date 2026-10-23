// Accounts (auth.js, admin.js, 0062), driven in a real browser against a
// stand-in for Supabase Auth (GoTrue) and the database's account functions —
// answering as they answer, and recording what they are sent.
//
//   1. **The visitor note** — signed out, the note says what an account adds
//      (the photos, your own views, editing) and offers Create and Sign in;
//      Not now puts it away for a fortnight, a reload included; under test
//      automation it stays away unless a check asks for it.
//   2. **Signing in with a password** — the form a password manager knows
//      (username and current-password), the providers GoTrue says are on,
//      a wrong password said plainly, the right one signing in.
//   3. **Creating an account** — the address checked as it is typed (a
//      Bureau address "approved as soon as you confirm it", any other "an
//      administrator approves"), a short password refused before it is sent,
//      the sign-up sent with the name and a way back here, the confirmation
//      code (a wrong one refused, the right one signing in), and the account
//      then waiting: the panel, the banner and a note saying so.
//   4. **A forgotten password** — the reset sent, its code taking the person
//      to a new password, a short one refused, the new one saved; Back to
//      sign in out of the code box, for an email that never comes; and a
//      reset link landing on the page opening the panel on it, the tokens
//      gone from the address. A link from docs/accounts.md's templates
//      (?token_hash=…) verified only when Continue is pressed — a mail
//      scanner opening it uses nothing up — a used one saying so and offering
//      a new email, and a sign-in link (type email) waiting the same way.
//   5. **An address not confirmed** — signing in says so and offers the email
//      again; Send it again asks for it.
//   6. **An administrator** — the count on Admin in the bar, a note, and on
//      the tab the accounts waiting with Approve, Approve as editor and
//      Decline (asked first), each sent to admin_user_decide; and the switch
//      for who may sign up, sent to admin_set_signup.
//   7. **A refresh with no answer** — a stored session found expired on a
//      page that opens with no network (a phone's home-screen app brought
//      back, a laptop woken) is kept, not signed out, and refreshed once, not
//      twice; back online, the retry signs in properly. A refresh GoTrue
//      itself refuses still signs out.
//
// Why a check of its own: every failure here is a door that looks shut or
// open when it is the other. A sign-up that never says it is waiting, a code
// box that verifies the wrong kind of code, a reset link that signs somebody
// in and leaves them with no way to set a password, an Approve that approves
// the wrong row — none of them throws, and the real GoTrue is not something a
// check can sign up to a hundred times a day.
//
// Run:  npm run accounts
//       npm run accounts -- -v

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

const PASSWORD = 'correct horse battery';
// Who each bearer is, as whoami() would say.
const WHO = {
  'tok-pat': { signed_in: true, email: 'pat@council.example', display_name: 'Pat Example', role: 'editor',
               may_write: false, is_admin: false, is_member: false, status: 'pending', signup: 'open', schema_version: '65' },
  'tok-sam': { signed_in: true, email: 'sam@bom.gov.au', display_name: null, role: 'editor',
               may_write: true, is_admin: false, is_member: true, status: 'automatic', signup: 'open', schema_version: '65' },
  'tok-rec': { signed_in: true, email: 'sam@bom.gov.au', display_name: null, role: 'editor',
               may_write: true, is_admin: false, is_member: true, status: 'automatic', signup: 'open', schema_version: '65' },
  'tok-admin': { signed_in: true, email: 'boss@bom.gov.au', display_name: 'Boss', role: 'admin',
               may_write: true, is_admin: true, is_member: true, status: 'automatic', signup: 'open',
               approvals_waiting: 2, schema_version: '65' },
};
const session = (tok, email) => ({ access_token: tok, refresh_token: `r-${tok}`, expires_in: 3600, token_type: 'bearer',
  user: { id: `id-${tok}`, email } });

async function main() {
  const server = await startServer();
  const browser = await launchBrowser();
  const errors = [];
  const sent = [];          // every request to the stand-ins: { path, method, body, query }
  // What the next refreshes get: `down` of them no answer at all, then a
  // refusal if `refuse`, else a session.
  const refreshes = { down: 0, refuse: false };

  async function open(url, { nudge = false, store = null, viewport = { width: 1440, height: 900 } } = {}) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await applyNetworkPolicy(page, server.origin);
    const auth = async route => {
      const req = route.request();
      const u = new URL(req.url());
      const path = u.pathname.replace(/^.*\/auth\/v1\//, '');
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
      sent.push({ path, method: req.method(), body, query: Object.fromEntries(u.searchParams), auth: req.headers().authorization || '' });
      const reply = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: J(obj) });
      // Both switched on, one of them with no secret — as Google was in the
      // live project: it answers /authorize with a 400, and gets no button.
      if (path === 'settings') return reply(200, { external: { google: true, azure: true, email: true }, disable_signup: false });
      if (path === 'authorize') {
        if (u.searchParams.get('provider') === 'google') {
          return route.fulfill({ status: 302, headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=stand-in' }, body: '' });
        }
        return reply(400, { code: 400, error_code: 'validation_failed', msg: 'Unsupported provider: missing OAuth secret' });
      }
      if (path === 'token' && u.searchParams.get('grant_type') === 'password') {
        if (body.email === 'late@council.example') return reply(400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
        if (body.email === 'sam@bom.gov.au' && body.password === PASSWORD) return reply(200, session('tok-sam', body.email));
        return reply(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      if (path === 'token') {
        if (refreshes.down > 0) { refreshes.down--; return route.abort('internetdisconnected'); }
        if (refreshes.refuse) return reply(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
        return reply(200, session(String(body.refresh_token || '').replace(/^r-/, ''), null));
      }
      if (path === 'signup') return reply(200, { id: 'id-new', email: body.email, confirmation_sent_at: '2026-10-13T00:00:00Z', identities: [{}] });
      if (path === 'verify') {
        // A link from docs/accounts.md's templates: a token_hash and no address.
        if (body.token_hash) {
          if (body.token_hash === 'hash-rec' && body.type === 'recovery') return reply(200, session('tok-rec', 'sam@bom.gov.au'));
          if (body.token_hash === 'hash-in' && body.type === 'email') return reply(200, session('tok-sam', 'sam@bom.gov.au'));
          return reply(403, { code: 403, error_code: 'otp_expired', msg: 'Email link is invalid or has expired' });
        }
        if (body.token !== '123456') return reply(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
        if (body.type === 'recovery') return reply(200, session('tok-rec', body.email));
        return reply(200, session('tok-pat', body.email));
      }
      if (path === 'recover' || path === 'resend' || path === 'otp') return reply(200, {});
      if (path === 'user' && req.method() === 'PUT') {
        if ((body.password || '').length < 10) return reply(422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 10 characters.', weak_password: { reasons: ['length'] } });
        return reply(200, { id: 'id-tok-rec', email: 'sam@bom.gov.au' });
      }
      if (path === 'logout') return route.fulfill({ status: 204, body: '' });
      return reply(404, { msg: 'not stood in for' });
    };
    await page.route('**/auth/v1/**', auth);
    const rpc = async route => {
      const req = route.request();
      const name = new URL(req.url()).pathname.split('/rpc/')[1];
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
      const bearer = (req.headers().authorization || '').replace(/^Bearer\s+/, '');
      sent.push({ path: `rpc/${name}`, method: 'POST', body, auth: bearer });
      const reply = obj => route.fulfill({ status: 200, contentType: 'application/json', body: J(obj) });
      if (name === 'whoami') return reply(WHO[bearer] || { signed_in: false, is_member: false, may_write: false, signup: 'open' });
      if (name === 'signup_check') {
        const auto = /@bom\.gov\.au$/i.test((body && body.p_email) || '');
        return reply({ open: true, automatic: auto, allowed: true });
      }
      if (name === 'email_may_sign_in') return reply(true);
      if (name === 'my_prefs') return reply({ nav_views: null, updated_at: null });
      if (name === 'admin_users') {
        return reply([
          { id: 'u-boss', email: 'boss@bom.gov.au', display_name: 'Boss', role: 'admin', status: 'automatic', is_you: true,
            created_at: '2026-09-01T00:00:00Z', confirmed_at: '2026-09-01T00:00:00Z', may_edit: true },
          { id: 'u-pat', email: 'pat@council.example', display_name: 'Pat Example', role: 'editor', status: 'pending',
            created_at: '2026-10-12T22:00:00Z', confirmed_at: '2026-10-12T22:05:00Z', may_edit: false },
          { id: 'u-lee', email: 'lee@contractor.example', display_name: null, role: 'editor', status: 'pending',
            created_at: '2026-10-12T23:00:00Z', confirmed_at: '2026-10-12T23:01:00Z', may_edit: false },
          { id: 'u-bot', email: 'zz@spam.example', display_name: null, role: 'editor', status: 'unconfirmed',
            created_at: '2026-10-13T01:00:00Z', confirmed_at: null, may_edit: false },
        ]);
      }
      if (name === 'admin_allowlist') return reply([]);
      if (name === 'admin_user_decide') return reply({ id: body.p_id, status: body.p_decision === 'approve' ? 'approved' : 'declined' });
      if (name === 'admin_set_signup') return reply(body.p_open ? 'open' : 'allowlist');
      return route.fulfill({ status: 404, contentType: 'application/json', body: J({ message: 'not stood in for' }) });
    };
    await page.route('**/rest/v1/rpc/**', rpc);
    await page.addInitScript(({ nudge, store }) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      if (nudge) localStorage.setItem('mn-nudge', 'on');
      if (store) localStorage.setItem('meganet.session', JSON.stringify(store));
    }, { nudge, store });
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
    return { context, page };
  }

  const modal = page => page.evaluate(() => {
    const m = document.getElementById('auth-modal');
    return {
      open: !!m && m.style.display === 'flex',
      title: document.getElementById('au-title')?.textContent.trim() || '',
      text: (m?.textContent || '').replace(/\s+/g, ' '),
      msg: (document.querySelector('#auth-modal .au-msg')?.textContent || '').replace(/\s+/g, ' ').trim(),
    };
  });
  const sentTo = (path, from = 0) => sent.slice(from).filter(r => r.path === path);

  try {
    // ═══════════════════════════════════════════════════════════════════════
    log('\n1. The visitor note\n');
    {
      const { context, page } = await open(server.url('/index.html?tab=stations'));
      await page.waitForTimeout(3200);
      check('under test automation the note stays away unless a check asks for it',
        !(await page.$('#signin-nudge')));
      await context.close();
    }
    const { context: c1, page } = await open(server.url('/index.html?tab=stations'), { nudge: true });
    await page.waitForSelector('#signin-nudge', { timeout: 8000 });
    const note = await page.evaluate(() => {
      const n = document.getElementById('signin-nudge');
      return { h: n.querySelector('h2')?.textContent.trim(), items: [...n.querySelectorAll('.au-benefits li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
               buttons: [...n.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean),
               focus: n.contains(document.activeElement), named: n.getAttribute('aria-labelledby') };
    });
    check('signed out, a note says so: the photos, your own views, editing — and Create, Sign in, Not now',
      /without an account/.test(note.h) && note.items.length === 3 && /field photos/.test(note.items[0]) && /views/.test(note.items[1])
        && /Edit stations/.test(note.items[2]) && ['Create an account', 'Sign in', 'Not now'].every(t => note.buttons.includes(t))
        && !note.focus && note.named === 'sn-h', J(note));
    await page.click('#signin-nudge button:has-text("Not now")');
    const snoozed = await page.evaluate(() => ({ gone: !document.getElementById('signin-nudge'),
      until: Number(localStorage.getItem('mn-signin-nudge')) - Date.now() }));
    check('Not now puts it away for a fortnight', snoozed.gone && snoozed.until > 13 * 86400e3 && snoozed.until <= 14 * 86400e3 + 1000, J(snoozed));
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(3200);
    check('…and a reload does not bring it back', !(await page.$('#signin-nudge')));

    // ═══════════════════════════════════════════════════════════════════════
    log('\n2. Signing in with a password\n');
    await page.click('#btn-auth');
    await page.waitForSelector('#au-password');
    // The panel opens before the providers are asked (/settings, then each
    // one's /authorize) and draws their buttons when they answer. Wait for
    // that, or the read below races it and finds none on a slow runner; a
    // panel that never offers one still fails the check, with what it showed.
    await page.waitForSelector('.au-provider', { timeout: 8000 }).catch(() => {});
    const form = await page.evaluate(() => ({
      email: document.getElementById('au-email')?.getAttribute('autocomplete'),
      pw: document.getElementById('au-password')?.getAttribute('autocomplete'),
      providers: [...document.querySelectorAll('.au-provider')].map(b => b.textContent.trim()),
      create: /Create a free account/.test(document.getElementById('auth-modal').textContent),
      focus: document.activeElement?.id,
    }));
    check('the panel is a sign-in form a password manager knows, offering the provider that answers — not the one switched on with no secret',
      /username/.test(form.email || '') && form.pw === 'current-password' && J(form.providers) === J(['Continue with Google'])
        && form.create && form.focus === 'au-email', J(form));
    await page.fill('#au-email', 'sam@bom.gov.au');
    await page.fill('#au-password', 'not the password');
    await page.click('#auth-modal button[type="submit"]');
    await page.waitForFunction(() => /do not match/.test(document.querySelector('#auth-modal .au-msg')?.textContent || ''));
    const typed = await page.evaluate(() => ({ email: document.getElementById('au-email').value, pw: document.getElementById('au-password').value }));
    check('a wrong password is said plainly, and nothing typed is lost', typed.email === 'sam@bom.gov.au' && typed.pw === 'not the password', J(typed));
    await page.fill('#au-password', PASSWORD);
    await page.click('#auth-modal button[type="submit"]');
    await page.waitForFunction(() => Auth.known() && /Your account/.test(document.getElementById('au-title')?.textContent || ''));
    const inSam = await modal(page);
    const tokenReq = sentTo('token').pop();
    check('the right one signs in: the password sent once, to /token, and the account standing said',
      tokenReq && tokenReq.query.grant_type === 'password' && tokenReq.body.password === PASSWORD
        && /Approved/.test(inSam.text) && /field photos/.test(inSam.text), J({ q: tokenReq && tokenReq.query, text: inSam.text.slice(0, 200) }));
    const hdr = await page.evaluate(() => ({ label: document.querySelector('#btn-auth .hdr-label')?.textContent, cls: document.getElementById('btn-auth').className }));
    check('the banner says who', hdr.label === 'sam' && /is-in/.test(hdr.cls), J(hdr));
    await page.click('#au-signout');
    await page.waitForFunction(() => !Auth.isSignedIn());
    await c1.close();

    // ═══════════════════════════════════════════════════════════════════════
    log('\n3. Creating an account\n');
    const { context: c2, page: p2 } = await open(server.url('/index.html?tab=stations'));
    await p2.evaluate(() => Auth.open({ mode: 'signup' }));
    await p2.waitForSelector('#au-name');
    await p2.fill('#au-email', 'sam@bom.gov.au');
    await p2.waitForFunction(() => /approved as soon as you confirm/.test(document.getElementById('au-check')?.textContent || ''));
    check('a Bureau address: "approved as soon as you confirm it"', true);
    await p2.fill('#au-email', 'pat@council.example');
    await p2.waitForFunction(() => /administrator approves/.test(document.getElementById('au-check')?.textContent || ''));
    check('any other: "an administrator approves", and the views meanwhile', true);
    const pwAttr = await p2.getAttribute('#au-password', 'autocomplete');
    const before = sent.length;
    await p2.fill('#au-password', 'short');
    await p2.fill('#au-name', 'Pat Example');
    await p2.click('#auth-modal button[type="submit"]');
    await p2.waitForFunction(() => /at least 10 characters/.test(document.querySelector('#auth-modal .au-msg')?.textContent || ''));
    check('a password under ten characters is refused before it is sent, as a new password',
      pwAttr === 'new-password' && sentTo('signup', before).length === 0, J({ pwAttr }));
    await p2.fill('#au-password', 'three ordinary words');
    await p2.click('#auth-modal button[type="submit"]');
    await p2.waitForFunction(() => /Confirm your address/.test(document.getElementById('au-title')?.textContent || ''));
    const signup = sentTo('signup', before).pop();
    check('the sign-up is sent with the address, the password, the name and a way back here',
      signup && signup.body.email === 'pat@council.example' && signup.body.password === 'three ordinary words'
        && signup.body.data && signup.body.data.full_name === 'Pat Example' && /index\.html/.test(signup.query.redirect_to || ''),
      J(signup));
    const conf = await modal(p2);
    check('…and the panel asks for the code, or the link, in the email', /emailed pat@council\.example/.test(conf.msg), conf.msg);
    await p2.fill('#au-code', '000000');
    await p2.click('#auth-modal button[type="submit"]');
    await p2.waitForFunction(() => /not accepted/.test(document.querySelector('#auth-modal .au-msg')?.textContent || ''));
    check('a wrong code is refused', true);
    await p2.fill('#au-code', '123456');
    await p2.click('#auth-modal button[type="submit"]');
    await p2.waitForFunction(() => Auth.known() && Auth.standing() === 'pending');
    const verify = sentTo('verify').pop();
    const waiting = await p2.evaluate(() => ({
      text: document.getElementById('auth-modal').textContent.replace(/\s+/g, ' '),
      waitingCls: document.getElementById('btn-auth').classList.contains('is-waiting'),
      title: document.getElementById('btn-auth').title,
      toast: [...document.querySelectorAll('#toasts .toast-text')].map(t => t.textContent).join(' | '),
      member: Auth.isMember(),
    }));
    check('the right code signs in (verified as an email code), and the account is waiting — said in the panel, the banner and a note',
      verify && verify.body.type === 'email' && verify.body.email === 'pat@council.example'
        && /Waiting for approval/.test(waiting.text) && waiting.waitingCls && /waiting for approval/.test(waiting.title)
        && /waiting for an administrator/.test(waiting.toast) && !waiting.member, J({ verify: verify && verify.body, ...waiting, text: waiting.text.slice(0, 160) }));
    await p2.evaluate(() => switchTab('photos'));
    const photos = await p2.evaluate(() => (document.getElementById('main-content').textContent || '').replace(/\s+/g, ' '));
    check('Field Photos says the photos come once the account is approved, not that there are none',
      /waiting for an administrator's approval/.test(photos) && !/No field photos yet/.test(photos), photos.slice(0, 300));
    await c2.close();

    // ═══════════════════════════════════════════════════════════════════════
    log('\n4. A forgotten password\n');
    const { context: c3, page: p3 } = await open(server.url('/index.html?tab=stations'));
    await p3.click('#btn-auth');
    await p3.click('#auth-modal button:has-text("Forgot your password?")');
    await p3.fill('#au-email', 'sam@bom.gov.au');
    const b4 = sent.length;
    await p3.click('#auth-modal button[type="submit"]');
    await p3.waitForSelector('#au-code');
    const rec = sentTo('recover', b4).pop();
    const recMsg = (await modal(p3)).msg;
    check('the reset is sent, with a way back here, and the panel says the same whether or not there is an account',
      rec && rec.body.email === 'sam@bom.gov.au' && /index\.html/.test(rec.query.redirect_to || '') && /If sam@bom\.gov\.au has an account/.test(recMsg),
      J({ rec, recMsg }));
    await p3.fill('#au-code', '123456');
    await p3.click('#auth-modal button[type="submit"]');
    await p3.waitForSelector('#au-password');
    const v4 = sentTo('verify', b4).pop();
    check('its code, verified as a recovery, leads to choosing a new password', v4 && v4.body.type === 'recovery'
      && /Choose a new password/.test((await modal(p3)).title), J(v4 && v4.body));
    await p3.fill('#au-password', 'short');
    await p3.click('#auth-modal button[type="submit"]');
    await p3.waitForFunction(() => /at least 10 characters/.test(document.querySelector('#auth-modal .au-msg')?.textContent || ''));
    check('a short one is refused before it is sent', sentTo('user', b4).length === 0);
    await p3.fill('#au-password', 'a much longer pass phrase');
    await p3.click('#auth-modal button[type="submit"]');
    await p3.waitForFunction(() => /Password saved/.test(document.querySelector('#auth-modal .au-msg')?.textContent || ''));
    const put = sentTo('user', b4).pop();
    check('the new one is saved to the account (PUT /user, with the recovery session)',
      put && put.method === 'PUT' && put.body.password === 'a much longer pass phrase' && put.auth === 'Bearer tok-rec', J(put));
    await c3.close();

    {
      // An email that never comes must not trap the person on the code box.
      const { context, page: pb } = await open(server.url('/index.html?tab=stations'));
      await pb.click('#btn-auth');
      await pb.click('#auth-modal button:has-text("Forgot your password?")');
      await pb.fill('#au-email', 'sam@bom.gov.au');
      await pb.click('#auth-modal button[type="submit"]');
      await pb.waitForSelector('#au-code');
      const waiting = await modal(pb);
      await pb.click('#auth-modal button:has-text("Back to sign in")');
      await pb.waitForSelector('#au-password');
      const backTo = await pb.evaluate(() => ({ title: document.getElementById('au-title')?.textContent.trim(),
        email: document.getElementById('au-email')?.value }));
      check('waiting for the reset code, the panel says where an email that has not come may be, and Back to sign in leads out with the address kept',
        /junk mail/.test(waiting.text) && /quarantine/.test(waiting.text) && /Sign in to Flood-Net/.test(backTo.title)
          && backTo.email === 'sam@bom.gov.au', J({ waiting: waiting.text.slice(0, 300), backTo }));
      await context.close();
    }

    {
      const { context, page: pl } = await open(server.url('/index.html?tab=stations#access_token=tok-rec&refresh_token=r-tok-rec&expires_in=3600&token_type=bearer&type=recovery'));
      await pl.waitForFunction(() => document.getElementById('auth-modal')?.style.display === 'flex', null, { timeout: 10_000 });
      const land = await pl.evaluate(() => ({ title: document.getElementById('au-title')?.textContent, hash: location.hash,
        box: !!document.getElementById('au-password'), signedIn: Auth.isSignedIn() }));
      check('a reset link landing on the page opens the panel on choosing a new password, the tokens gone from the address',
        /Choose a new password/.test(land.title) && land.hash === '' && land.box && land.signedIn, J(land));
      await context.close();
    }

    // The templates' links (?token_hash=…&type=…) wait for a person: a mail
    // scanner opening the page must not use the link up.
    const shown = async pl => {
      await pl.waitForFunction(() => document.getElementById('auth-modal')?.style.display === 'flex', null, { timeout: 10_000 });
      return pl.evaluate(() => ({ title: document.getElementById('au-title')?.textContent.trim(), search: location.search,
        buttons: [...document.querySelectorAll('#auth-modal .modal-foot button')].map(b => b.textContent.trim()),
        signedIn: Auth.isSignedIn() }));
    };
    {
      const b = sent.length;
      const { context, page: pl } = await open(server.url('/index.html?tab=stations&token_hash=hash-rec&type=recovery'));
      const wait = await shown(pl);
      await pl.waitForTimeout(500);
      check('a reset link from the new template waits for Continue: nothing verified by opening it, the token gone from the address, the tab kept',
        /Reset your password/.test(wait.title) && wait.buttons.includes('Continue to a new password') && sentTo('verify', b).length === 0
          && !wait.signedIn && /tab=stations/.test(wait.search) && !/token_hash|type=/.test(wait.search), J(wait));
      await pl.click('#auth-modal button[type="submit"]');
      await pl.waitForSelector('#au-password');
      const v = sentTo('verify', b).pop();
      const after = await modal(pl);
      check('Continue verifies it as a recovery (the token hash, no address) and leads to choosing a new password',
        v && v.body.type === 'recovery' && v.body.token_hash === 'hash-rec' && !('email' in v.body)
          && /Choose a new password/.test(after.title) && await pl.evaluate(() => Auth.isSignedIn()), J({ body: v && v.body, after }));
      await context.close();
    }
    {
      const { context, page: pl } = await open(server.url('/index.html?tab=stations&token_hash=used-up&type=recovery'));
      await shown(pl);
      await pl.click('#auth-modal button[type="submit"]');
      await pl.waitForFunction(() => /used already/.test(document.querySelector('#auth-modal .au-msg')?.textContent || ''));
      const used = await shown(pl);
      await pl.click('#auth-modal button:has-text("Send a new email")');
      const again = await modal(pl);
      check('a link already used says so plainly and offers a new email, which is the reset form',
        used.buttons.includes('Send a new email') && !used.signedIn && /Reset your password/.test(again.title)
          && await pl.evaluate(() => !!document.getElementById('au-email')), J({ used, again: again.title }));
      await context.close();
    }
    {
      const b = sent.length;
      const { context, page: pl } = await open(server.url('/index.html?tab=stations&token_hash=hash-in&type=email'));
      const wait = await shown(pl);
      await pl.click('#auth-modal button[type="submit"]');
      await pl.waitForFunction(() => /Address confirmed/.test(document.querySelector('#auth-modal .au-msg')?.textContent || ''));
      const v = sentTo('verify', b).pop();
      const after = await modal(pl);
      check('a sign-up or sign-in link (type email) waits the same way, then signs in on Continue',
        /Sign in to Flood-Net/.test(wait.title) && wait.buttons.includes('Continue') && v && v.body.type === 'email'
          && v.body.token_hash === 'hash-in' && /Your account/.test(after.title), J({ wait, body: v && v.body, after: after.title }));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n5. An address not confirmed\n');
    {
      const { context, page: p5 } = await open(server.url('/index.html?tab=stations'));
      await p5.click('#btn-auth');
      await p5.fill('#au-email', 'late@council.example');
      await p5.fill('#au-password', 'whatever it is');
      await p5.click('#auth-modal button[type="submit"]');
      await p5.waitForSelector('#au-code');
      const m5 = await modal(p5);
      check('signing in before confirming says so, with the code box and Send it again',
        /Confirm your address/.test(m5.title) && /not been confirmed/.test(m5.msg) && /Send it again/.test(m5.text), J(m5));
      const b5 = sent.length;
      await p5.click('#auth-modal button:has-text("Send it again")');
      await p5.waitForFunction(() => /Sent again/.test(document.querySelector('#auth-modal .au-msg')?.textContent || ''));
      const rs = sentTo('resend', b5).pop();
      check('…which asks for the sign-up email again', rs && rs.body.type === 'signup' && rs.body.email === 'late@council.example', J(rs));
      await context.close();
    }

    // ═══════════════════════════════════════════════════════════════════════
    log('\n6. An administrator\n');
    const store = { access_token: 'tok-admin', refresh_token: 'r-tok-admin', expires_at: Date.now() + 3600e3, email: 'boss@bom.gov.au' };
    const { context: c6, page: p6 } = await open(server.url('/index.html?tab=stations'), { store });
    await p6.waitForFunction(() => Auth.known() && Auth.isAdmin(), null, { timeout: 15_000 });
    await p6.waitForFunction(() => !!document.querySelector('#tab-nav .tab-btn[data-tab="admin"] .nav-count'), null, { timeout: 10_000 });
    const badge = await p6.evaluate(() => {
      const b = document.querySelector('#tab-nav .tab-btn[data-tab="admin"]');
      return { n: b.querySelector('.nav-count')?.textContent, said: b.querySelector('.sr-only')?.textContent,
               toast: [...document.querySelectorAll('#toasts .toast-text')].map(t => t.textContent).join(' | ') };
    });
    check('the bar shows the administrator how many accounts wait, and says it aloud; a note says it once',
      badge.n === '2' && /2 accounts waiting for approval/.test(badge.said || '') && /2 accounts are waiting for your approval/.test(badge.toast), J(badge));
    await p6.click('#tab-nav .tab-btn[data-tab="admin"]');
    await p6.waitForSelector('#adm-waiting .adm-wait-row', { timeout: 10_000 });
    const list = await p6.evaluate(() => ({
      rows: [...document.querySelectorAll('#adm-waiting .adm-wait-row')].map(r => r.dataset.user),
      count: document.querySelector('#adm-wait-h .badge')?.textContent,
      unconfirmed: document.querySelector('#adm-waiting .adm-unconfirmed summary')?.textContent,
      buttons: [...document.querySelectorAll('#adm-waiting .adm-wait-row:first-child button')].map(b => b.textContent.trim()),
      standing: [...document.querySelectorAll('.table-wrap[aria-labelledby="adm-users-h"] tbody tr')]
        .map(tr => tr.querySelectorAll('td')[3]?.textContent.trim()),
    }));
    check('the Admin tab lists the confirmed accounts waiting, newest first, the unconfirmed folded away',
      J(list.rows) === J(['u-lee', 'u-pat']) && list.count === '2' && /1 sign-up not confirmed/.test(list.unconfirmed || '')
        && J(list.buttons) === J(['Approve', 'Approve as editor', 'Decline']), J(list));
    check('…and the users table says each account\'s standing',
      J(list.standing) === J(['approved', 'waiting', 'waiting', 'unconfirmed']), J(list.standing));
    const b6 = sent.length;
    await p6.click('#adm-waiting .adm-wait-row[data-user="u-pat"] button:has-text("Approve as editor")');
    await p6.waitForTimeout(400);
    await p6.click('#adm-waiting .adm-wait-row[data-user="u-lee"] button:has-text("Approve")');
    await p6.waitForTimeout(400);
    await p6.click('#adm-waiting .adm-wait-row[data-user="u-lee"] button:has-text("Decline")');
    await p6.waitForSelector('[data-ask="yes"]');
    const ask = await p6.evaluate(() => document.querySelector('.modal-card--ask')?.textContent.replace(/\s+/g, ' ') || '');
    await p6.click('[data-ask="yes"]');
    await p6.waitForTimeout(400);
    const decided = sentTo('rpc/admin_user_decide', b6).map(r => r.body);
    check('Approve as editor, Approve and Decline (asked first) each go to admin_user_decide for their own row',
      J(decided) === J([
        { p_id: 'u-pat', p_decision: 'approve', p_make_editor: true },
        { p_id: 'u-lee', p_decision: 'approve', p_make_editor: false },
        { p_id: 'u-lee', p_decision: 'decline', p_make_editor: false },
      ]) && /Decline lee@contractor\.example\?/.test(ask) && /locked out/.test(ask), J({ decided, ask: ask.slice(0, 120) }));
    await p6.click('.adm-signup input[value="allowlist"]');
    await p6.waitForTimeout(400);
    const sw = sentTo('rpc/admin_set_signup', b6).pop();
    check('the switch for who may sign up goes to admin_set_signup', sw && sw.body.p_open === false, J(sw));
    await c6.close();

    // ═══════════════════════════════════════════════════════════════════════
    log('\n7. A refresh with no answer\n');
    {
      const expired = { access_token: 'tok-old', refresh_token: 'r-tok-sam', expires_at: Date.now() - 3600e3, email: 'sam@bom.gov.au' };
      refreshes.down = 1;
      const b7 = sent.length;
      const { context, page } = await open(server.url('/index.html?tab=stations'), { store: expired });
      await page.waitForFunction(() => document.getElementById('btn-auth')?.textContent.trim(), null, { timeout: 10_000 });
      await page.waitForTimeout(1500);
      const held = await page.evaluate(() => ({
        in: Auth.isSignedIn(), known: Auth.known(), header: document.getElementById('btn-auth').textContent.trim(),
        stored: !!localStorage.getItem('meganet.session'),
      }));
      const tries = sentTo('token', b7).length;
      check('an expired session whose refresh gets no answer is kept — still signed in, still stored, no logout',
        held.in && held.stored && !held.known && /sam/.test(held.header) && sentTo('logout', b7).length === 0, J(held));
      check('…and its refresh token is sent once, not twice', tries === 1, `${tries} refreshes`);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.waitForFunction(() => Auth.known(), null, { timeout: 10_000 });
      const back = await page.evaluate(() => ({
        in: Auth.isSignedIn(), token: Auth.accessToken(), mayWrite: Auth.mayWrite(),
        stored: JSON.parse(localStorage.getItem('meganet.session') || 'null')?.access_token,
      }));
      check('back online, the retry refreshes it and asks who this is',
        back.in && back.token === 'tok-sam' && back.stored === 'tok-sam' && back.mayWrite
          && sentTo('rpc/whoami', b7).some(r => r.auth === 'tok-sam'), J(back));
      await context.close();
    }
    {
      const expired = { access_token: 'tok-old', refresh_token: 'r-tok-sam', expires_at: Date.now() - 3600e3, email: 'sam@bom.gov.au' };
      refreshes.refuse = true;
      const { context, page } = await open(server.url('/index.html?tab=stations'), { store: expired });
      await page.waitForFunction(() => !Auth.isSignedIn(), null, { timeout: 10_000 }).catch(() => {});
      const gone = await page.evaluate(() => ({
        in: Auth.isSignedIn(), stored: !!localStorage.getItem('meganet.session'),
        header: document.getElementById('btn-auth').textContent.trim(),
      }));
      check('a refresh GoTrue refuses still ends the session here', !gone.in && !gone.stored && /Sign in/.test(gone.header), J(gone));
      refreshes.refuse = false;
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter(r => !r.ok);
  log(failed.length
    ? `\nFAIL — ${failed.length} of ${results.length}:\n${failed.map(f => `  ✗ ${f.label}`).join('\n')}`
    : `\nPASS — accounts: the visitor note, a password, a new account waiting, a reset, and an administrator deciding, and a refresh with no answer kept (${results.length} checks).`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
