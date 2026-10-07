// MegaNet — admin.js
//
//   Admin   the Admin tab: where the station data comes from and how to load
//           it, who is signed in and what they may do, the people who may sign
//           in (users and the allowlist, 0042), the roles and what each one
//           grants, and the housekeeping tools that had no other home.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, announce, APP_VERSION and
// DB_SCHEMA_VERSION; across to app.js for loadFromGitHub, dataSourceSummary,
// docUrl and switchTab; to datastore.js for dbRpc, dbCheck, renderDbStatusHtml,
// reloadFromDatastore and snapshotStationsJson; to export.js for
// exportMayDownload; to auth.js for Auth; to mem-meter.js for MemMeter; and to
// station-history.js for StationHistory, whose Deleted stations panel it draws
// under Station data and loads from init().
// Nothing here runs at load. auth.js calls Admin.authChanged() on every sign-in
// and sign-out.
//
// What moved here. The header's 📂 Load stations.json (now "Load from this
// device", beside its two siblings) and ⬇️ Load from GitHub,
// and the Export tab's Data source and stations.json panels: none of them is
// something done every visit, and every one of them is about the data rather
// than about a tab's work. The hidden <input id="file-input"> stays in
// index.html — the empty state's button uses it too.
//
// **This tab is not the security.** Every user and allowlist function refuses
// anybody meganet.is_admin() says no to (0042), whatever this page offers. The
// page only decides what to show: a signed-out visitor and an editor see what
// the roles are and how to ask, and never a list of people.
const Admin = (function () {

  // What the database last said. null is "not asked yet"; the arrays are the
  // answers of admin_users() and admin_allowlist().
  let users   = null;
  let allow   = null;
  let loading = false;
  let error   = null;
  // The allowlist form's contents, mirrored so a repaint does not take typing.
  let form    = { entry: '', role: '', note: '' };

  const ROLES = ['viewer', 'editor', 'admin'];

  // What each level may do. Written out once here, and the Roles panel is this
  // table: a privilege described in two places is described wrongly in one.
  // `enforced` says whether the database acts on it today — 'viewer' is
  // recorded and not yet enforced (0005), which the panel says rather than
  // leaving it to be discovered.
  const PRIVILEGES = [
    { who: 'Anyone (not signed in)', how: 'Behind Cloudflare Access only',
      may: 'Read stations, the maps, telemetry, inspection charts and every tab that reads. Load a stations.json from a file or GitHub.',
      not: 'Save anything; download the station document or the Radio Mobile set; see field photos, inspection records or a station\'s history.' },
    { who: 'Viewer', how: 'app_user.role = viewer',
      may: 'Everything an editor may, today — the role is recorded but not enforced yet.',
      not: 'To stop somebody writing, remove their allowlist entry rather than making them a viewer.',
      note: 'not enforced' },
    { who: 'Editor', how: 'On the allowlist (by address or domain), signed in',
      may: 'Edit, delete and restore stations, and see and put back what a station said before; record inspections and maintenance, upload and place field photos, propose equipment, snapshot stations.json, generate exports.',
      not: 'Approve equipment suggestions, prune the upload log, manage users.' },
    { who: 'Administrator', how: 'An editor whose app_user.role = admin',
      may: 'Everything an editor may, plus: approve or reject equipment suggestions, prune the photo upload log, and manage users and the allowlist on this tab.',
      not: 'Demote or delete themselves, remove the last administrator, or remove the only entry that lets them in.' },
    { who: 'Service key / owner', how: 'service_role, or a direct psql connection',
      may: 'Everything, including what the guards above refuse — this is how a mistake is undone.',
      not: 'Never in a browser. The key lives in GitHub Actions secrets and the owner\'s shell.' },
  ];

  function signedIn() { return typeof Auth !== 'undefined' && Auth.isSignedIn(); }
  // whoami()'s is_admin (0042); the role on its own for a database that has
  // not had 0042 yet, which the functions below would then 404 on anyway.
  function isAdmin()  {
    return signedIn() && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  }

  function when(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return isNaN(d) ? esc(ts) : esc(d.toLocaleString());
  }

  // ── Station data ──

  function dataHtml() {
    const mayDl = typeof exportMayDownload === 'function' && exportMayDownload();
    return `
      <div class="panel">
        <div class="panel-header"><h2>Station data</h2></div>
        <p class="small">The app loads the datastore first and falls back to the
          <code>stations.json</code> on this site, then GitHub's. These load one by hand —
          for working offline, or to look at a file before it goes anywhere.</p>
        <div class="button-group adm-actions">
          <button onclick="document.getElementById('file-input').click()"
                  title="Open a stations.json file on this device">📂 Load from this device</button>
          <button id="btn-load-gh" onclick="loadFromGitHub()"
                  title="Fetch stations.json from GitHub">⬇️ <span class="btn-label">Load from GitHub</span></button>
          <button onclick="reloadFromDatastore()"
                  title="Load the station list from the datastore again">🗄️ Load from the datastore</button>
        </div>
        <p class="small adm-loaded">${esc(typeof dataSourceSummary === 'function' ? dataSourceSummary() : '')}</p>
      </div>

      <!-- Moved from the Export tab. Two questions rather than one: what is on
           screen, and whether the database is reachable — a healthy connection
           under a list that fell back to a file is the case worth seeing. -->
      <div class="panel">
        <div class="panel-header">
          <h2>Data source</h2>
          <button class="exp-btn-sm" onclick="dbCheck()"
                  aria-label="Re-test the datastore connection">Re-test</button>
        </div>
        <div id="db-status" role="status">${renderDbStatusHtml()}</div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>stations.json snapshot</h2>
          ${mayDl
            ? `<button id="btn-snapshot" class="exp-btn-sm" onclick="snapshotStationsJson()"
                  title="Download the database's current station list, as stations.json holds it (floodnet-stations.json)">Snapshot</button>`
            : `<button class="exp-btn-sm" onclick="Auth.open()"
                  title="Downloading the station document needs a signed-in session">Sign in to snapshot</button>`}
        </div>
        <div class="small">
          The whole station list as a file — the offline copy, and what this app
          falls back to when the datastore cannot be reached. Taken from the
          database as it is right now, not from what this tab has loaded.
        </div>
        <div id="snapshot-note" class="small exp-note" role="status"></div>
      </div>`;
  }

  // ── Who you are ──

  function accessHtml() {
    if (!signedIn()) {
      return `
        <p class="small">Not signed in — reading anonymously.</p>
        <div class="button-group"><button class="primary" onclick="Auth.open()">🔑 Sign in</button></div>`;
    }
    const role = Auth.role();
    const rows = [
      ['Signed in as', esc(Auth.email() || '—')],
      ['Role', role ? `<span class="badge">${esc(role)}</span>` : '—'],
      ['May edit', Auth.mayWrite() ? '<span class="txt-ok">yes</span>' : '<span class="txt-bad">no — not on the allowlist</span>'],
      ['Administrator', isAdmin() ? '<span class="txt-ok">yes</span>' : 'no'],
      ['Database schema', Auth.schemaVersion() != null
        ? `v${esc(Auth.schemaVersion())}${Auth.schemaVersion() !== DB_SCHEMA_VERSION
            ? ` <span class="txt-warn">(this app expects v${DB_SCHEMA_VERSION})</span>` : ''}`
        : '—'],
    ];
    return `
      <dl class="adm-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <div class="button-group"><button onclick="Auth.open()">Account…</button></div>`;
  }

  // ── Users and the allowlist ──

  function peopleHtml() {
    if (!signedIn()) {
      return `<div class="panel"><div class="panel-header"><h2>Users</h2></div>
        <p class="small"><a href="#" onclick="Auth.open();return false">Sign in</a> as an
          administrator to manage users and the allowlist.</p></div>`;
    }
    if (!isAdmin()) {
      return `<div class="panel"><div class="panel-header"><h2>Users</h2></div>
        <p class="small">Managing users needs an administrator. If you should be one, ask an
          existing administrator to set your role to <strong>admin</strong> here, or the owner
          to run <code>update meganet.app_user set role = 'admin' where lower(email) = lower('you@…')</code>.</p></div>`;
    }
    const status = loading ? '<p class="small">Loading…</p>'
      : error ? `<p class="small txt-bad">${esc(error)}</p>` : '';
    return `${usersHtml(status)}${allowHtml()}`;
  }

  function usersHtml(status) {
    const list = users || [];
    return `
      <div class="panel">
        <div class="panel-header">
          <h2 id="adm-users-h">Users <span class="badge">${list.length}</span></h2>
          <button class="exp-btn-sm" onclick="Admin.load()">Refresh</button>
        </div>
        <p class="small">Everybody who has signed in, most recently seen first. A person appears here the first time they
          do; to add somebody, put their address on the allowlist below with the role they
          should arrive with. <strong>Viewer</strong> is recorded but not enforced yet — to stop
          somebody editing, remove their allowlist entry.</p>
        ${status}
        ${list.length ? `
        <div class="table-wrap" role="region" tabindex="0" aria-labelledby="adm-users-h">
          <table class="adm-table">
            <caption class="sr-only">Signed-in users, their roles, and whether the allowlist lets them edit</caption>
            <colgroup><col style="width:30%"><col style="width:20%"><col style="width:7.5rem">
              <col style="width:4.5rem"><col style="width:20%"><col style="width:9.5rem"></colgroup>
            <thead><tr>
              <th scope="col">Email</th><th scope="col">Display name</th><th scope="col">Role</th>
              <th scope="col">May edit</th><th scope="col" class="col-optional">Last seen</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              ${list.map(u => `
                <tr data-user="${escAttr(u.id)}">
                  <td>${esc(u.email)}${u.is_you ? ' <span class="badge">you</span>' : ''}</td>
                  <td><input type="text" data-f="name" value="${escAttr(u.display_name || '')}"
                             aria-label="Display name for ${escAttr(u.email)}"></td>
                  <td><select data-f="role" aria-label="Role for ${escAttr(u.email)}">
                    ${ROLES.map(r => `<option value="${r}"${u.role === r ? ' selected' : ''}>${r}</option>`).join('')}
                  </select></td>
                  <td>${u.may_edit ? '<span class="txt-ok">yes</span>' : '<span class="txt-bad">no</span>'}</td>
                  <td class="small col-optional" title="${escAttr(lastSeenTitle(u))}">${u.active_sessions
                    ? '<span class="adm-online">● online</span>'
                    : esc(typeof AdminDash !== 'undefined' ? AdminDash.ago(u.last_seen_at || u.last_sign_in_at) : '')}
                    ${u.visits_30d ? `<br><span class="txt-muted">${u.visits_30d} day${u.visits_30d === 1 ? '' : 's'} in 30</span>` : ''}</td>
                  <td class="adm-row-acts">
                    <button class="exp-btn-sm" onclick="Admin.saveUser('${escAttr(u.id)}')">Save</button>
                    ${u.is_you ? '' : `<button class="exp-btn-sm adm-danger"
                        onclick="Admin.deleteUser('${escAttr(u.id)}')">Delete</button>`}
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : (users ? '<p class="small table-empty">Nobody has signed in yet.</p>' : '')}
      </div>`;
  }

  // The hover on "Last seen": the absolute times, and what browser the latest
  // session was — the only place a user agent is shown.
  function lastSeenTitle(u) {
    const bits = [];
    if (u.last_seen_at)    bits.push(`Last seen ${new Date(u.last_seen_at).toLocaleString()}`);
    if (u.last_sign_in_at) bits.push(`last sign-in ${new Date(u.last_sign_in_at).toLocaleString()}`);
    if (u.active_sessions) bits.push(`${u.active_sessions} live session${u.active_sessions === 1 ? '' : 's'}`);
    if (u.user_agent)      bits.push(browserOf(u.user_agent));
    return bits.join(' · ') || 'Never seen';
  }

  function browserOf(ua) {
    const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : 'a browser';
    const o = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
            : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return `${b}${o ? ` on ${o}` : ''}`;
  }

  function allowHtml() {
    const list = allow || [];
    return `
      <div class="panel">
        <div class="panel-header">
          <h2 id="adm-allow-h">Allowlist — who may sign in and edit <span class="badge">${list.length}</span></h2>
        </div>
        <p class="small">An address (<code>name@example.org</code>) lets one person in; a domain
          (<code>@example.org</code>) lets in everybody at it. The initial role is what a person
          gets the first time they sign in — an address's wins over its domain's, and it is never
          applied again after that.</p>
        <form class="adm-form" onsubmit="Admin.saveEntry();return false">
          <label>Address or @domain
            <input type="text" id="adm-entry" inputmode="email" autocomplete="off" required
                   value="${escAttr(form.entry)}" oninput="Admin.formField('entry',this.value)"
                   placeholder="someone@example.org or @example.org"></label>
          <label>Initial role
            <select id="adm-entry-role" onchange="Admin.formField('role',this.value)">
              <option value=""${form.role === '' ? ' selected' : ''}>editor (default)</option>
              ${ROLES.map(r => `<option value="${r}"${form.role === r ? ' selected' : ''}>${r}</option>`).join('')}
            </select></label>
          <label>Note
            <input type="text" id="adm-entry-note" value="${escAttr(form.note)}"
                   oninput="Admin.formField('note',this.value)" placeholder="Who they are, why they are here"></label>
          <button type="submit" class="primary">Add / update</button>
        </form>
        ${list.length ? `
        <div class="table-wrap" role="region" tabindex="0" aria-labelledby="adm-allow-h">
          <table class="adm-table">
            <caption class="sr-only">Allowlist entries, the role each gives a first sign-in, and how many users each matches</caption>
            <colgroup><col style="width:26%"><col style="width:6rem"><col style="width:24%">
              <col style="width:4rem"><col style="width:20%"><col style="width:9.5rem"></colgroup>
            <thead><tr>
              <th scope="col">Entry</th><th scope="col">Initial role</th><th scope="col">Note</th>
              <th scope="col">Users</th><th scope="col" class="col-optional">Added</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              ${list.map((a, i) => `
                <tr>
                  <td><code>${esc(a.entry)}</code>${a.kind === 'domain' ? ' <span class="badge">domain</span>' : ''}</td>
                  <td>${esc(a.initial_role || 'editor')}</td>
                  <td class="small">${esc(a.note || '')}</td>
                  <td>${esc(a.users)}</td>
                  <td class="small col-optional">${when(a.added_at)}${a.added_by ? ` · ${esc(a.added_by)}` : ''}</td>
                  <td class="adm-row-acts">
                    <button class="exp-btn-sm" onclick="Admin.editEntry(${i})">Edit</button>
                    <button class="exp-btn-sm adm-danger" onclick="Admin.removeEntry(${i})">Remove</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
      </div>`;
  }

  // ── Roles and privileges ──

  function rolesHtml() {
    return `
      <div class="panel">
        <div class="panel-header"><h2 id="adm-roles-h">User groups &amp; privileges</h2></div>
        <div class="table-wrap" role="region" tabindex="0" aria-labelledby="adm-roles-h">
          <table class="adm-table">
            <caption class="sr-only">Each access level, how somebody gets it, and what it may and may not do</caption>
            <thead><tr><th scope="col">Group</th><th scope="col">How you get it</th>
              <th scope="col">May</th><th scope="col">May not</th></tr></thead>
            <tbody>
              ${PRIVILEGES.map(p => `
                <tr><th scope="row">${esc(p.who)}${p.note ? ` <span class="badge">${esc(p.note)}</span>` : ''}</th>
                  <td class="small">${esc(p.how)}</td>
                  <td class="small">${esc(p.may)}</td>
                  <td class="small">${esc(p.not)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
        <p class="small">The perimeter is Cloudflare Access; the enforcement is the database
          (<code>meganet.is_editor()</code>, <code>meganet.is_admin()</code>). This app only asks.</p>
      </div>`;
  }

  // ── This browser ──

  // What "clear settings" keeps: the sign-in, and the random visitor id the
  // dashboard counts this browser by (admin-dashboard.js) — clearing it would
  // count one person as two.
  const KEEP = ['meganet.session', 'meganet.visitor'];

  function storageKeys() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        out.push({ k, n: (localStorage.getItem(k) || '').length });
      }
    } catch (_) { /* storage blocked — nothing to list */ }
    return out.sort((a, b) => a.k.localeCompare(b.k));
  }

  function browserHtml() {
    const keys = storageKeys();
    const total = keys.reduce((s, x) => s + x.n, 0);
    return `
      <div class="panel">
        <div class="panel-header">
          <h2 id="adm-local-h">This browser</h2>
          <span class="button-group">
            <button class="exp-btn-sm" onclick="MemMeter.togglePanel()">Memory…</button>
            <button class="exp-btn-sm adm-danger" onclick="Admin.clearLocal()"
                    title="Forget every setting this browser keeps for the app, except the sign-in">Clear settings</button>
          </span>
        </div>
        <p class="small">App version <code>${esc(APP_VERSION)}</code>. Settings kept here —
          filters, panel widths, drafts — are this browser's alone:
          ${keys.length} item${keys.length !== 1 ? 's' : ''}, ${(total / 1024).toFixed(1)} KB.
          The app counts visits with a random id kept here — no name, address or IP — so the
          dashboard can tell how many people use it without signing in.</p>
        ${keys.length ? `
        <details><summary class="small">Stored items</summary>
          <div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="adm-local-h">
            <table class="adm-table">
              <caption class="sr-only">What this browser keeps for the app</caption>
              <thead><tr><th scope="col">Key</th><th scope="col">Size</th>
                <th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>${keys.map((x, i) => `
                <tr><td><code>${esc(x.k)}</code></td><td class="small">${(x.n / 1024).toFixed(1)} KB</td>
                  <td>${KEEP.includes(x.k) ? `<span class="small">${x.k === 'meganet.session' ? 'sign-in' : 'visitor id'}</span>`
                    : `<button class="exp-btn-sm" onclick="Admin.forgetKey(${i})">Forget</button>`}</td></tr>`).join('')}
              </tbody>
            </table>
          </div>
        </details>` : ''}
      </div>`;
  }

  function toolsHtml() {
    const link = (href, label) => `<a class="pill" href="${escAttr(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
    return `
      <div class="panel">
        <div class="panel-header"><h2>Other admin tools</h2></div>
        <div class="button-group adm-actions">
          ${link('migrate.html', '🧮 Migration tool (CSV → stations.json)')}
          ${link('arroadminlauncher.html', '🚀 ARRO admin launcher')}
          <button class="pill" onclick="switchTab('photos')">📷 Photo review &amp; equipment approvals</button>
          <button class="pill" onclick="switchTab('export')">📤 Radio Mobile export</button>
          <button class="pill" onclick="BugReport.open()">🐞 Report a bug</button>
        </div>
        <div class="button-group adm-actions">
          ${link(docUrl('docs/access.md'), 'Access & sign-in')}
          ${link(docUrl('db/README.md'), 'Database schema & migrations')}
          ${link(docUrl('docs/field-photos.md#administrators'), 'Administrators')}
          ${link(docUrl('docs/agent-api.md'), 'Agent API & MCP')}
        </div>
      </div>`;
  }

  // ── The tab ──

  function render() {
    return `
      <div class="page adm-page" style="--page-max:1200px">
        <h2 class="sr-only">Admin</h2>
        <div id="adm-dash" class="stack">${typeof AdminDash !== 'undefined' ? AdminDash.render() : ''}</div>
        <div class="adm-grid">
          <div class="stack">
            ${dataHtml()}
            ${typeof StationHistory !== 'undefined' ? StationHistory.adminHtml() : ''}
            <div class="panel">
              <div class="panel-header"><h2>Your access</h2></div>
              <div id="adm-access">${accessHtml()}</div>
            </div>
            <div id="adm-browser">${browserHtml()}</div>
          </div>
          <div class="stack">
            <div id="adm-people" class="stack">${peopleHtml()}</div>
            <div id="adm-tokens">${typeof AdminTokens !== 'undefined' ? AdminTokens.render() : ''}</div>
            ${rolesHtml()}
            ${toolsHtml()}
          </div>
        </div>
      </div>`;
  }

  function init() {
    if (!state.dbStatus) dbCheck();
    if (isAdmin() && users === null && !loading) load();
    // The deleted stations, for an editor (station-history.js): asked again
    // every visit, since a delete anywhere since is the point of the list.
    if (typeof StationHistory !== 'undefined') StationHistory.adminLoad();
    if (typeof AdminDash !== 'undefined') AdminDash.start();
    if (typeof AdminTokens !== 'undefined' && isAdmin()) AdminTokens.load();
  }

  // Only the parts that change are repainted: the Data source panel and the
  // snapshot note are live regions, and the allowlist form holds typing.
  function repaint(which) {
    if (state.activeTab !== 'admin') return;
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    if (!which || which === 'people') set('adm-people', peopleHtml());
    if (!which || which === 'access') set('adm-access', accessHtml());
    if (!which || which === 'browser') set('adm-browser', browserHtml());
  }

  async function load() {
    if (!isAdmin()) { repaint('people'); return; }
    loading = true; error = null; repaint('people');
    try {
      const [u, a] = await Promise.all([dbRpc('admin_users', {}), dbRpc('admin_allowlist', {})]);
      users = Array.isArray(u) ? u : [];
      allow = Array.isArray(a) ? a : [];
    } catch (err) {
      error = err.status === 404
        ? 'The database does not have the user admin functions yet — apply db/migrations/0042_user_admin.sql.'
        : `Could not load users: ${err.message}`;
    }
    loading = false;
    repaint('people');
  }

  async function act(fn, args, done) {
    try {
      const out = await dbRpc(fn, args);
      if (done) announce(done(out));
      await load();
    } catch (err) {
      Toast.failed(err.message);
    }
  }

  function saveUser(id) {
    const row = document.querySelector(`tr[data-user="${CSS.escape(id)}"]`);
    if (!row) return;
    const role = row.querySelector('[data-f="role"]').value;
    const name = row.querySelector('[data-f="name"]').value;
    const u = (users || []).find(x => x.id === id);
    act('admin_user_save', { p_id: id, p_role: role, p_display_name: name },
        () => `Saved ${u ? u.email : 'user'}.`);
  }

  // One question, with the second as a tick inside it (#223): the second used
  // to be a confirm() of its own, asked only after a yes to the first, whose
  // OK and Cancel meant "remove it" and "keep it" — which nobody could tell
  // from the buttons.
  async function deleteUser(id) {
    const u = (users || []).find(x => x.id === id);
    if (!u) return;
    const answer = await confirmDialog({ title: `Delete ${u.email}?`,
      message: 'Their sign-in is removed. What they edited stays, attributed to them.',
      checkbox: { label: `Also remove ${u.email}'s own allowlist entry, so they cannot sign in again. `
                       + 'A domain entry that matches them is left alone.' },
      confirm: 'Delete the user', danger: true });
    if (!answer) return;
    act('admin_user_delete', { p_id: id, p_disallow: answer.checked }, out =>
      `Deleted ${u.email}.${out && out.still_allowed ? ' The allowlist still lets them sign in again.' : ''}`);
  }

  function formField(k, v) { form[k] = v; }

  function saveEntry() {
    const entry = form.entry.trim();
    if (!entry) return;
    act('admin_allow_save', { p_entry: entry, p_note: form.note, p_initial_role: form.role || null },
        out => { form = { entry: '', role: '', note: '' }; return `Allowed ${out ? out.entry : entry}.`; });
  }

  function editEntry(i) {
    const a = (allow || [])[i];
    if (!a) return;
    form = { entry: a.entry, role: a.initial_role || '', note: a.note || '' };
    repaint('people');
    document.getElementById('adm-entry')?.focus();
  }

  async function removeEntry(i) {
    const a = (allow || [])[i];
    if (!a) return;
    const who = a.kind === 'domain' ? `Everybody at ${a.entry}` : a.entry;
    if (!(await confirmDialog({ title: `Remove ${a.entry} from the allowlist?`,
      message: `${who} will no longer be able to sign in or edit (unless another entry matches). `
        + 'Existing users keep their row but lose editing.',
      confirm: 'Remove from the allowlist', danger: true }))) return;
    act('admin_allow_remove', { p_entry: a.entry }, () => `Removed ${a.entry}.`);
  }

  function forgetKey(i) {
    const x = storageKeys()[i];
    if (!x || KEEP.includes(x.k)) return;
    try { localStorage.removeItem(x.k); } catch (_) { /* blocked */ }
    repaint('browser');
    announce(`Forgot ${x.k}.`);
  }

  async function clearLocal() {
    if (!(await confirmDialog({ title: 'Forget every setting this browser keeps for the app?',
      message: 'Filters, panel widths, drafts. Your sign-in is kept. Unsaved drafts are lost.',
      confirm: 'Forget the settings', danger: true }))) return;
    for (const x of storageKeys()) {
      if (KEEP.includes(x.k)) continue;
      try { localStorage.removeItem(x.k); } catch (_) { /* blocked */ }
    }
    repaint('browser');
    announce('Settings cleared. Reload the page for every tab to start fresh.');
  }

  // A sign-in or sign-out: what was fetched belonged to the last session.
  function authChanged() {
    users = null; allow = null; error = null;
    repaint();
    if (state.activeTab === 'admin' && isAdmin()) load();
  }

  return { render, init, load, authChanged, saveUser, deleteUser, formField,
           saveEntry, editEntry, removeEntry, forgetKey, clearLocal };
})();
if (typeof window !== 'undefined') window.Admin = Admin;
