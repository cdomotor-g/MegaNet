// MegaNet — admin-tokens.js
//
//   AdminTokens   the Admin tab's "Ingest tokens" panel: every base station's
//                 credential — the gateways, the MQTT bridge, and each computer
//                 a Serial Monitor receiver posts from — listed, minted and
//                 revoked here instead of in the Supabase SQL editor.
//
// After core.js and datastore.js (dbRpc), before admin.js, which draws it into
// #adm-tokens and loads it from Admin.init(). Nothing here runs at load.
//
// Three calls, all 0046 and all refused to anybody meganet.is_admin() says no
// to: admin_ingest_tokens(), admin_create_ingest_token(), admin_revoke_ingest_token().
// A minted token is shown once — the database keeps only its hash — with a copy
// button, and with "Use in this browser", which hands it straight to the Serial
// Monitor's cards (serial-ingest.js keeps it in localStorage `mn-ingest`), so an
// administrator setting up their own computer never handles the token at all.
// It stays on screen until this panel is closed or another is minted, and is
// never written anywhere else.

const AdminTokens = (function () {
  let list = null, loading = false, error = null, minted = null, note = '';

  function isAdmin() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn() && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  }

  function when(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return isNaN(d) ? esc(ts) : esc(d.toLocaleString());
  }

  function receiversHtml(t) {
    const r = t.receivers || [];
    if (!r.length) return '<span class="small qs-dim">none reported</span>';
    return r.map(p => '<div class="small">' + esc(p.name || p.point_id) + ' <span class="qs-dim">(' + esc(p.receiver)
      + (p.location_source && p.location_source !== 'none' ? ', location ' + esc(p.location_source) + (p.location_approx ? ', approximate' : '') : ', no location')
      + ')</span></div>').join('');
  }

  function render() {
    const head = '<div class="panel-header"><h2 id="adm-tok-h">Ingest tokens</h2>'
      + (isAdmin() ? '<button class="exp-btn-sm" onclick="AdminTokens.load()">Refresh</button>' : '') + '</div>';
    if (!isAdmin()) {
      return '<div class="panel">' + head + '<p class="small">Base station credentials — for administrators.</p></div>';
    }
    let body = '<p class="small">One token per <strong>ingest point</strong>: a base station, a gateway, the MQTT bridge, or a computer '
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
              : '<button class="ghost" onclick="AdminTokens.revoke(' + Number(t.id) + ')" aria-label="Revoke ' + escAttr(t.label) + '">Revoke…</button>') + '</td></tr>').join('')
          : '<tr><td colspan="5" class="small">No tokens yet.</td></tr>')
        + '</tbody></table></div>';
    }
    return '<div class="panel">' + head + body + '</div>';
  }

  function repaint() {
    const el = document.getElementById('adm-tokens');
    if (el && state.activeTab === 'admin') el.innerHTML = render();
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
  }

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

  function authChanged() { list = null; minted = null; error = null; note = ''; if (state.activeTab === 'admin') { repaint(); load(); } }

  return { render, load, create, revoke, copy, useHere, dismiss, authChanged };
})();

if (typeof window !== 'undefined') window.AdminTokens = AdminTokens;
