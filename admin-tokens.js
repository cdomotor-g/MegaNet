// MegaNet — admin-tokens.js
//
//   AdminTokens   the Admin tab's "Ingest tokens" panel: every base station's
//                 credential — the gateways, the MQTT bridge, and each computer
//                 a Serial Monitor receiver posts from — listed, minted and
//                 revoked here instead of in the Supabase SQL editor; and the
//                 base stations *asking* for one, approved or turned down here.
//
// After core.js and datastore.js (dbRpc), before admin.js, which draws it into
// #adm-tokens and loads it from Admin.init(). Nothing here runs at load;
// init.js calls restoreFromUrl() once, after the first render.
//
// Minting (0046): admin_ingest_tokens(), admin_create_ingest_token(),
// admin_revoke_ingest_token(), all refused to anybody meganet.is_admin() says
// no to. A minted token is shown once — the database keeps only its hash —
// with a copy button, and with "Use in this browser", which hands it straight
// to the Serial Monitor's cards (serial-ingest.js keeps it in localStorage
// `mn-ingest`), so an administrator setting up their own computer never
// handles the token at all. It stays on screen until this panel is closed or
// another is minted, and is never written anywhere else.
//
// Asking (0048): a Raspberry Pi running RPi ALERT, or a Serial Monitor card in
// a browser nobody has signed in on, makes its own token and asks for it to be
// approved, showing a code. Its request appears under "Waiting for approval"
// here within a few seconds — admin_ingest_token_requests() is asked every 5 s
// while this tab is open and the page is visible — and Approve turns the
// device's own token into an ingest token: nothing to copy, nothing to carry,
// and the device starts sending on its next poll. The code is the point of the
// exercise: it is how the administrator knows the request they approve is the
// device in front of them, so it is shown large, and the approve form says to
// check it. The Pi's QR code links here as `#pair=XXXX-XXXX` (restoreFromUrl),
// which opens this tab with that request's form open — never approved by
// itself.

const AdminTokens = (function () {
  let list = null, loading = false, error = null, minted = null, note = '';

  // The requests (0048). `reqs` is admin_ingest_token_requests()'s answer, or
  // null before it has been asked; `reqSig` what was last drawn, so a poll that
  // brings nothing new redraws nothing — the approve form is typed into, and a
  // redraw every five seconds would take the typing away.
  let reqs = null, reqErr = null, reqSig = '', reqDrawnAt = 0, reqTimer = null, reqMissing = false;
  // The approve form, mirrored so a redraw does not lose what was typed:
  // { id, label, host, replace }.
  let approving = null;
  // A request named by a deep link (#pair=CODE), opened once it is listed.
  let focusCode = null;

  const POLL_MS = 5000;
  const CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

  function isAdmin() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn() && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  }

  function when(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return isNaN(d) ? esc(ts) : esc(d.toLocaleString());
  }

  // "3 min ago", "in 27 min" — the waiting list is read in minutes.
  function rel(ts, future) {
    const d = new Date(ts).getTime();
    if (!isFinite(d)) return '';
    const m = Math.round(Math.abs(Date.now() - d) / 60000);
    const span = m < 1 ? 'under a minute' : m < 90 ? m + ' min' : Math.round(m / 60) + ' h';
    return future ? 'in ' + span : (m < 1 ? 'just now' : span + ' ago');
  }

  function receiversHtml(t) {
    const r = t.receivers || [];
    if (!r.length) return '<span class="small qs-dim">none reported</span>';
    return r.map(p => '<div class="small">' + esc(p.name || p.point_id) + ' <span class="qs-dim">(' + esc(p.receiver)
      + (p.location_source && p.location_source !== 'none' ? ', location ' + esc(p.location_source) + (p.location_approx ? ', approximate' : '') : ', no location')
      + ')</span></div>').join('');
  }

  // ── the requests ──────────────────────────────────────────────────────────

  function pending() { return (reqs || []).filter(r => r.status === 'pending'); }

  // A live token already wearing this label — the one approval would collide
  // with (0046's labels are unique among live tokens, case aside).
  function clashFor(label) {
    const l = String(label || '').trim().toLowerCase();
    return l ? (list || []).find(t => !t.revoked_at && String(t.label || '').toLowerCase() === l) || null : null;
  }

  // What the device said about itself (0048's detail), as one line. Every value
  // is the device's own words, so every value is escaped and none is a link.
  function deviceLine(r) {
    const d = r.detail && typeof r.detail === 'object' ? r.detail : {};
    const bits = [];
    if (d.app) bits.push(String(d.app) + (d.version ? ' ' + d.version : ''));
    if (d.board) bits.push(String(d.board));
    if (d.host) bits.push('host ' + d.host);
    if (Array.isArray(d.receivers) && d.receivers.length) bits.push(d.receivers.slice(0, 6).map(x => (x && (x.name || x.kind)) || x).join(', '));
    else if (d.receivers === 0 || (Array.isArray(d.receivers) && !d.receivers.length)) bits.push('no receivers plugged in yet');
    if (d.browser) bits.push(String(d.browser).slice(0, 60));
    if (r.host_station) bits.push('at ' + r.host_station);
    return bits.map(b => esc(String(b).slice(0, 120))).join(' · ');
  }

  function codeHtml(code) {
    // Read out letter by letter, which is how it is matched against the device.
    return '<span class="adm-req-code" aria-label="Code ' + esc(String(code).split('').join(' ')) + '">' + esc(code) + '</span>';
  }

  function approveFormHtml(r) {
    const a = approving;
    const clash = clashFor(a.label);
    return '<div class="adm-req-form" role="group" aria-label="Approve ' + esc(r.label) + '">'
      + '<p class="small"><strong>Check the device shows ' + esc(r.code) + '</strong> before approving — on the Pi\'s screen, '
      + 'its web page, or <code>rpi-alert status</code>. A request with the same name and another code is somebody else\'s.</p>'
      + '<div class="adm-tok-form">'
      + '<label>Label <input type="text" id="adm-req-label" maxlength="120" value="' + esc(a.label) + '" oninput="AdminTokens.approveField(\'label\', this.value)"></label>'
      + '<label>Lives at station (optional) <input type="text" id="adm-req-host" placeholder="station id" value="' + esc(a.host) + '" oninput="AdminTokens.approveField(\'host\', this.value)"></label>'
      + '</div>'
      + '<div id="adm-req-clash">' + clashHtml(clash) + '</div>'
      + '<div class="button-group">'
      + '<button class="primary" id="adm-req-go" onclick="AdminTokens.approve()">Approve ' + esc(r.code) + '</button>'
      + '<button class="ghost" onclick="AdminTokens.cancelApprove()">Cancel</button></div>'
      + '</div>';
  }

  function clashHtml(clash) {
    if (!clash) return '';
    return '<p class="small txt-warn">A live token is already called “' + esc(clash.label) + '”'
      + (clash.last_used_at ? ' (last used ' + esc(rel(clash.last_used_at)) + ')' : ' (never used)') + '.</p>'
      + '<label class="ser-check small"><input type="checkbox"' + (approving && approving.replace ? ' checked' : '')
      + ' onchange="AdminTokens.approveField(\'replace\', this.checked)"> Replace it — revoke that token as this one is approved '
      + '(a reflashed Pi asking again under its old name). Otherwise, change the label.</label>';
  }

  function reqHtml(r) {
    const open = approving && approving.id === r.id;
    const focus = focusCode && r.code === focusCode;
    return '<div class="adm-req' + (focus ? ' is-focus' : '') + '" data-req="' + Number(r.id) + '">'
      + codeHtml(r.code)
      + '<div class="adm-req-body">'
      + '<div><strong>' + esc(r.label) + '</strong> <span class="small qs-dim">asked ' + esc(rel(r.requested_at))
      + ' · expires ' + esc(rel(r.expires_at, true)) + '</span></div>'
      + '<div class="small qs-dim">' + (deviceLine(r) || 'It said nothing more about itself.') + '</div>'
      + (open ? approveFormHtml(r)
        : '<div class="button-group"><button class="primary" onclick="AdminTokens.openApprove(' + Number(r.id) + ')" aria-label="Approve '
          + esc(r.label) + ', code ' + esc(r.code) + '…">Approve…</button>'
          + '<button class="ghost" onclick="AdminTokens.deny(' + Number(r.id) + ')" aria-label="Deny ' + esc(r.label) + '">Deny</button></div>')
      + '</div></div>';
  }

  function recentHtml(r) {
    const what = r.status === 'approved' ? 'approved' + (r.token_label && r.token_label !== r.label ? ' as “' + esc(r.token_label) + '”' : '')
        + (r.token_revoked_at ? ' — since revoked' : '')
      : r.status === 'denied' ? 'denied' : r.status === 'withdrawn' ? 'withdrawn by the device' : 'expired unanswered';
    const who = r.decided_by && r.status !== 'withdrawn'
      ? ' by ' + esc(r.decided_by === (typeof Auth !== 'undefined' && Auth.email && Auth.email()) ? 'you' : r.decided_by) : '';
    return '<li class="small">' + esc(r.label) + ' <span class="qs-dim">(' + esc(r.code) + ')</span> — ' + what + who
      + ' <span class="qs-dim">' + esc(rel(r.decided_at || r.expires_at)) + '</span></li>';
  }

  function requestsHtml() {
    if (reqMissing) {
      return '<p class="small qs-dim">Base stations asking for their own token needs the database to have '
        + '<code>db/migrations/0048_ingest_token_requests.sql</code>.</p>';
    }
    const waiting = pending();
    const recent = (reqs || []).filter(r => r.status !== 'pending');
    let h = '<h3 class="adm-req-h" id="adm-req-h">Waiting for approval' + (waiting.length ? ' <span class="badge">' + waiting.length + '</span>' : '') + '</h3>';
    if (reqErr) h += '<p class="small txt-bad">' + esc(reqErr) + '</p>';
    if (reqs === null && !reqErr) h += '<p class="small">Looking…</p>';
    else if (!waiting.length) {
      h += '<p class="small qs-dim">Nothing is waiting. A base station can ask for its own token — <strong>Request a token</strong> '
        + 'on a Raspberry Pi running RPi ALERT, or <strong>Ask an administrator</strong> in a Serial Monitor card — and '
        + 'its request appears here within a few seconds, with the code it shows.</p>';
    }
    if (focusCode && reqs !== null && !waiting.some(r => r.code === focusCode)) {
      const gone = (reqs || []).find(r => r.code === focusCode);
      h += '<p class="small txt-warn" role="status">' + (gone ? 'The request showing ' + esc(focusCode) + ' was ' + esc(gone.status) + '.'
        : 'No request is waiting with the code ' + esc(focusCode) + ' — it may have expired, or not reached MegaNet yet.') + '</p>';
    }
    if (waiting.length) h += '<div class="adm-reqs" role="list" aria-labelledby="adm-req-h">' + waiting.map(r => '<div role="listitem">' + reqHtml(r) + '</div>').join('') + '</div>';
    if (recent.length) {
      h += '<details class="adm-req-recent"' + (waiting.length ? '' : ' open') + '><summary class="small">In the last day (' + recent.length + ')</summary>'
        + '<ul>' + recent.slice(0, 12).map(recentHtml).join('') + '</ul></details>';
    }
    return h;
  }

  // ── the panel ─────────────────────────────────────────────────────────────

  function render() {
    const head = '<div class="panel-header"><h2 id="adm-tok-h">Ingest tokens</h2>'
      + (isAdmin() ? '<button class="exp-btn-sm" onclick="AdminTokens.load()">Refresh</button>' : '') + '</div>';
    if (!isAdmin()) {
      const ask = focusCode
        ? '<p class="small" role="status">A base station showing <strong>' + esc(focusCode) + '</strong> is asking for an ingest token. '
          + 'Sign in as an administrator to approve it.</p><div class="button-group"><button class="primary" onclick="Auth.open()">🔑 Sign in</button></div>'
        : '';
      return '<div class="panel">' + head + '<p class="small">Base station credentials — for administrators.</p>' + ask + '</div>';
    }
    let body = '<div id="adm-tok-reqs" class="adm-tok-reqs">' + requestsHtml() + '</div>'
      + '<h3 class="adm-req-h">Make one here</h3>'
      + '<p class="small">One token per <strong>ingest point</strong>: a base station, a gateway, the MQTT bridge, or a computer '
      + 'whose Serial Monitor cards post what they hear (<a href="' + escAttr(docUrl('docs/ingest-serial-monitor.md')) + '" target="_blank" rel="noopener">how</a>). '
      + 'A token is shown once, when it is made; only its hash is kept.</p>'
      + '<div class="adm-tok-form">'
      + '<label>Label — name the computer or site <input type="text" id="adm-tok-label" maxlength="120" placeholder="e.g. Cameron work laptop"></label>'
      + '<label>Lives at station (optional) <input type="text" id="adm-tok-host" placeholder="station id"></label>'
      + '<button class="primary" onclick="AdminTokens.create()">Create token</button>'
      + '</div>';
    if (minted) {
      body += '<div class="note adm-tok-minted" role="status">'
        + '<p><strong>' + esc(minted.label) + '</strong> — copy this now; it will not be shown again.</p>'
        + '<p><code class="adm-tok-value" id="adm-tok-value">' + esc(minted.token) + '</code></p>'
        + '<div class="button-group">'
        + '<button class="ghost" onclick="AdminTokens.copy()">Copy</button>'
        + '<button class="ghost" onclick="AdminTokens.useHere()">Use in this browser</button>'
        + '<button class="ghost" onclick="AdminTokens.dismiss()">Done</button></div>'
        + '<p class="small qs-dim">“Use in this browser” gives it to the Serial Monitor\'s cards on this computer — no copying needed.</p>'
        + '</div>';
    }
    if (note) body += '<p class="small" role="status">' + esc(note) + '</p>';
    if (error) body += '<p class="small txt-bad">' + esc(error) + '</p>';
    if (loading && !list) body += '<p class="small">Loading…</p>';
    if (list) {
      body += '<div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="adm-tok-h"><table class="adm-table">'
        + '<caption class="sr-only">Ingest tokens, live first, most recently used first</caption>'
        + '<thead><tr><th scope="col">Label</th><th scope="col">Receivers</th><th scope="col">Last used</th>'
        + '<th scope="col">Made</th><th scope="col">Status</th></tr></thead><tbody>'
        + (list.length ? list.map(t => '<tr><th scope="row">' + esc(t.label)
            + (t.host_station ? '<div class="small qs-dim">at ' + esc(t.host_station) + '</div>' : '') + '</th>'
            + '<td>' + receiversHtml(t) + '</td>'
            + '<td class="small">' + when(t.last_used_at) + '</td>'
            + '<td class="small">' + when(t.created_at) + (t.created_by ? '<div class="qs-dim">' + esc(t.created_by) + '</div>' : '') + '</td>'
            + '<td>' + (t.revoked_at ? '<span class="badge">revoked ' + when(t.revoked_at) + '</span>'
              : '<button class="ghost" onclick="AdminTokens.revoke(' + Number(t.id) + ')" aria-label="Revoke ' + esc(t.label) + '">Revoke…</button>') + '</td></tr>').join('')
          : '<tr><td colspan="5" class="small">No tokens yet.</td></tr>')
        + '</tbody></table></div>';
    }
    return '<div class="panel">' + head + body + '</div>';
  }

  function repaint() {
    const el = document.getElementById('adm-tokens');
    if (el && state.activeTab === 'admin') el.innerHTML = render();
    reqDrawnAt = Date.now();
  }

  // Only the waiting list. Focus inside it is put back where it was, by id.
  function repaintReqs() {
    const el = document.getElementById('adm-tok-reqs');
    if (!el || state.activeTab !== 'admin') return;
    const had = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
    el.innerHTML = requestsHtml();
    reqDrawnAt = Date.now();
    if (had) document.getElementById(had)?.focus();
  }

  async function load() {
    if (!isAdmin()) { repaint(); return; }
    loading = true; repaint();
    try {
      const r = await dbRpc('admin_ingest_tokens', {});
      list = Array.isArray(r) ? r : [];
      error = null;
    } catch (err) {
      error = err.status === 404 ? 'The database does not have this yet — apply db/migrations/0046_ingest_token_admin.sql.'
        : 'Could not load the tokens: ' + err.message;
    }
    loading = false;
    repaint();
    await loadReqs(true);
    startPolling();
  }

  async function loadReqs(force) {
    if (!isAdmin() || reqMissing) return;
    try {
      const r = await dbRpc('admin_ingest_token_requests', {});
      reqs = Array.isArray(r) ? r : [];
      reqErr = null;
    } catch (err) {
      if (err.status === 404) { reqMissing = true; reqs = []; stopPolling(); }
      else reqErr = 'Could not load the requests: ' + err.message;
    }
    // A request approved or turned down elsewhere, or one that ran out, leaves
    // the form: it has nothing left to approve.
    if (approving && !pending().some(r => r.id === approving.id)) approving = null;
    const sig = JSON.stringify((reqs || []).map(r => [r.id, r.status, r.decided_at, r.token_label, r.token_revoked_at])) + '|' + (reqErr || '');
    const fresh = reqSig && sig !== reqSig && pending().length;
    const changed = force || sig !== reqSig;
    reqSig = sig;
    // The deep link's request, opened once, the moment it is listed.
    const hit = focusCode && !approving ? pending().find(r => r.code === focusCode) : null;
    if (hit) openApprove(hit.id, true);
    // Relative times ("asked 3 min ago") are refreshed once a minute, but never
    // under somebody typing in the approve form.
    else if (changed || (!approving && Date.now() - reqDrawnAt > 60000)) repaintReqs();
    if (fresh && typeof announce === 'function') {
      announce(pending().length + ' base station' + (pending().length === 1 ? ' is' : 's are') + ' waiting for approval.');
    }
  }

  function startPolling() {
    if (reqTimer || reqMissing || !isAdmin()) return;
    reqTimer = setInterval(() => { if (!document.hidden && state.activeTab === 'admin') loadReqs(false); }, POLL_MS);
    if (typeof registerTabTeardown === 'function') registerTabTeardown('admin-token-requests', stopPolling);
  }
  function stopPolling() { if (reqTimer) { clearInterval(reqTimer); reqTimer = null; } }

  function openApprove(id, fromLink) {
    const r = pending().find(x => x.id === id);
    if (!r) return;
    approving = { id, label: r.label, host: r.host_station_id || '', replace: false };
    repaintReqs();
    const box = document.querySelector('.adm-req[data-req="' + Number(id) + '"]');
    if (box && fromLink && box.scrollIntoView) box.scrollIntoView({ block: 'center' });
    // The Approve button rather than the label box: on a phone — where the QR
    // code lands — focusing a text box brings the keyboard up over the code.
    document.getElementById('adm-req-go')?.focus();
  }

  function approveField(k, v) {
    if (!approving) return;
    approving[k] = v;
    // The collision note follows the label as it is typed; nothing else moves.
    if (k === 'label') {
      const el = document.getElementById('adm-req-clash');
      if (el) { if (!clashFor(v)) approving.replace = false; el.innerHTML = clashHtml(clashFor(v)); }
    }
  }

  function cancelApprove() { approving = null; focusCode = null; repaintReqs(); }

  async function approve() {
    if (!approving) return;
    const r = pending().find(x => x.id === approving.id);
    if (!r) { approving = null; repaintReqs(); return; }
    const label = String(approving.label || '').trim() || r.label;
    const clash = clashFor(label);
    const args = { p_id: r.id, p_label: label, p_host_station_id: String(approving.host || '').trim(),
                   p_replace_token_id: clash && approving.replace ? clash.id : null };
    if (clash && !approving.replace) {
      reqErr = 'A live token is already called “' + clash.label + '” — change the label, or tick Replace it.';
      repaintReqs();
      return;
    }
    try {
      const out = await dbRpc('admin_approve_ingest_token_request', args);
      note = 'Approved “' + out.label + '” (' + r.code + ')' + (out.replaced_token_id ? ', replacing the old token' : '')
        + '. It starts sending within a few seconds — nothing to copy.';
      announce(note);
      approving = null; focusCode = null; reqErr = null;
      await load();
    } catch (err) {
      reqErr = 'Could not approve it: ' + err.message;
      repaintReqs();
    }
  }

  async function deny(id) {
    const r = pending().find(x => x.id === id);
    if (!r) return;
    if (!confirm('Deny “' + r.label + '” (code ' + r.code + ')?\n\nIts token never works. The device can ask again, and will show a new code.')) return;
    try {
      await dbRpc('admin_deny_ingest_token_request', { p_id: id });
      note = '“' + r.label + '” (' + r.code + ') denied.';
      announce(note);
      if (approving && approving.id === id) approving = null;
      if (focusCode === r.code) focusCode = null;
      await loadReqs(true);
      repaint();
    } catch (err) {
      reqErr = 'Could not deny it: ' + err.message;
      repaintReqs();
    }
  }

  // ── minting ───────────────────────────────────────────────────────────────

  async function create() {
    const label = (document.getElementById('adm-tok-label') || {}).value || '';
    const host = (document.getElementById('adm-tok-host') || {}).value || '';
    if (!label.trim()) { error = 'Give the token a label first — the computer or site it is for.'; repaint(); return; }
    note = ''; error = null;
    try {
      const r = await dbRpc('admin_create_ingest_token', { p_label: label.trim(), p_host_station_id: host.trim() || null });
      minted = { label: r.label, token: r.token };
      announce('Token made for ' + r.label + '. Copy it now; it is shown once.');
      await load();
    } catch (err) {
      error = 'Could not make the token: ' + err.message;
      repaint();
    }
  }

  async function revoke(id) {
    const t = (list || []).find(x => x.id === id);
    if (!t) return;
    if (!confirm('Revoke “' + t.label + '”?\n\nEverything posting with it stops at once — every station behind that base station, '
      + 'every receiver on that computer. A replacement is a new token; a revoked one never comes back.')) return;
    try {
      await dbRpc('admin_revoke_ingest_token', { p_id: id });
      note = t.label + ' revoked.';
      announce(note);
      await load();
    } catch (err) {
      error = 'Could not revoke: ' + err.message;
      repaint();
    }
  }

  async function copy() {
    if (!minted) return;
    let ok = false;
    try { await navigator.clipboard.writeText(minted.token); ok = true; } catch (_) {
      const el = document.getElementById('adm-tok-value');
      if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    }
    note = ok ? 'Copied.' : 'Selected — press Ctrl+C to copy.';
    repaint();
  }

  function useHere() {
    if (!minted) return;
    let s = {};
    try { s = JSON.parse(localStorage.getItem('mn-ingest') || '{}') || {}; } catch (_) {}
    s.token = minted.token;
    try { localStorage.setItem('mn-ingest', JSON.stringify(s)); note = 'This browser\'s Serial Monitor cards will post as “' + minted.label + '”.'; }
    catch (_) { note = 'This browser would not store it — copy it into a card instead.'; }
    announce(note);
    repaint();
  }

  function dismiss() { minted = null; note = ''; repaint(); }

  function authChanged() {
    list = null; minted = null; error = null; note = '';
    reqs = null; reqErr = null; reqSig = ''; approving = null; reqMissing = false;
    stopPolling();
    if (state.activeTab === 'admin') { repaint(); load(); }
  }

  // The Pi's QR code: https://floodwarning.net/#pair=XXXX-XXXX opens the Admin
  // tab with that request's approve form open. Called once by init.js after
  // the first render; the code leaves the address bar so a reload or a copied
  // link does not reopen a request decided since.
  function restoreFromUrl() {
    const m = /^#pair=([A-Za-z]{4}-?[A-Za-z]{4})$/.exec(location.hash || '');
    if (!m) return;
    const raw = m[1].toUpperCase().replace('-', '');
    const code = raw.slice(0, 4) + '-' + raw.slice(4);
    history.replaceState(null, '', location.pathname + location.search);
    if (!CODE_RE.test(code)) return;
    focusCode = code;
    state.activeTab = 'admin';
    renderTabs();
    renderMain();
  }

  return { render, load, create, revoke, copy, useHere, dismiss, authChanged, restoreFromUrl,
           openApprove, approveField, cancelApprove, approve, deny };
})();

if (typeof window !== 'undefined') window.AdminTokens = AdminTokens;
