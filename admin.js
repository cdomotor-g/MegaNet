// MegaNet — admin.js
//
//   Admin   the Admin tab: where the station data comes from and how to load
//           it, who is signed in and what they may do, the accounts waiting
//           for an administrator's approval and whether anybody may sign up
//           (0062), the people who may sign in (users and the allowlist,
//           0042), the roles and what each one grants, an administrator's
//           notifications on this device (push.js, 0066), and the
//           housekeeping tools that had no other home.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, termHtml, announce,
// APP_VERSION and DB_SCHEMA_VERSION; to modal.js for confirmDialog and
// promptDialog; across to app.js for loadFromGitHub, dataSourceSummary,
// docUrl and switchTab; to datastore.js for dbRpc, dbCheck, renderDbStatusHtml,
// reloadFromDatastore and snapshotStationsJson; to export.js for
// exportMayDownload; to auth.js for Auth; to mem-meter.js for MemMeter; to
// push.js for Push, whose Notifications panel it draws among the cards; to
// admin-links.js for AdminLinks, whose Base station connections it draws under
// the dashboard; to admin-teams.js for AdminTeams, whose Teams panel (0095) it
// draws under the ingest tokens and loads from init(), and which it tells when
// the accounts its Add somebody box suggests come back (accountsChanged); to
// admin-costs.js for AdminCosts, whose Running costs it draws under the teams
// and repaints with the rest on a sign-in or sign-out; and
// to station-history.js for StationHistory, whose Deleted stations panel it draws
// under the cards and loads from init().
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
  // Which pending accounts are mid-decision, so their buttons hold still.
  const deciding = new Set();
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
    { who: 'Anyone (not signed in)', how: 'Nothing — reading needs no account',
      may: 'Read stations, the maps, telemetry, inspection charts and every tab that reads. Load a stations.json from a file or GitHub. Pick All, Simple or Field for the left bar.',
      not: 'Save anything; download the station document or the Radio Mobile set; see field photos, inspection records or a station\'s history.' },
    { who: 'Account, waiting', how: 'Signed up and confirmed its address; not approved yet (0062)',
      may: 'Everything anyone may, and keep its own left-bar views on every device.',
      not: 'See field photos, or anything an editor may — until an administrator approves it below.' },
    { who: 'Member', how: 'Approved — automatically for an address on the allowlist (any @bom.gov.au), or by an administrator here',
      may: 'Everything an account may, and see the field photos.',
      not: 'Edit anything, unless the allowlist also lets it in (Approve as editor does both).' },
    { who: 'On a team', how: 'A member put on a team by an administrator, or by one of the team\'s owners, by their address (0095)',
      may: 'See the tasks handed to the team and who else is on it; move those tasks on and write notes on them.',
      not: 'Hand out or cancel a task, or see another team\'s tasks or roster.' },
    { who: 'Team owner', how: 'Named by an administrator, under Teams on this tab',
      may: 'Everything somebody on the team may, plus: add and take off its members, hand tasks to the team, and hand over, change or cancel its tasks.',
      not: 'Name another owner, or hand a task to another team.' },
    { who: 'Hands out tasks', how: 'On a team marked so (the SoRT Forum), or an administrator',
      may: 'Give a task to any team, or to none yet, and see every task.',
      not: 'Change who is on a team they do not own.' },
    { who: 'Viewer', how: 'app_user.role = viewer',
      may: 'Everything an editor may, today — the role does not stop editing yet.',
      not: 'Write an AI briefing on Flood-Net\'s own key. To stop somebody editing, remove the allowlist entry that lets them in rather than making them a viewer.',
      note: 'does not stop edits' },
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
          <h2 id="adm-src-h">Data source</h2>
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

  // ── Accounts waiting, and who may sign up (0062) ──

  // How many wait for a decision — this panel's count, which the dashboard's
  // tile shows too (admin-dashboard.js). null until the users have come back.
  function waitingCount() { return users ? users.filter(u => u.status === 'pending').length : null; }

  // The confirmed accounts nobody has decided about yet and the allowlist does
  // not approve on its own — the ones an administrator was emailed about —
  // newest first; and, folded away under them, the sign-ups that have not
  // confirmed their address, which nobody need act on.
  function waitingHtml() {
    if (!users) return '';
    const waiting = users.filter(u => u.status === 'pending')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const unconfirmed = users.filter(u => u.status === 'unconfirmed');
    const row = u => {
      const busy = deciding.has(u.id);
      return `
        <li class="adm-wait-row" data-user="${escAttr(u.id)}">
          <div class="adm-wait-who">
            <strong>${esc(u.display_name || u.email)}</strong>
            ${u.display_name ? `<span class="small txt-muted">${esc(u.email)}</span>` : ''}
            <span class="small txt-muted">signed up ${when(u.created_at)}${u.confirmed_at ? ` · confirmed ${when(u.confirmed_at)}` : ''}</span>
          </div>
          <div class="button-group adm-wait-acts">
            <button type="button" class="primary" ${busy ? 'disabled' : ''}
                    onclick="Admin.decide('${escAttr(u.id)}','approve')"
                    title="A member from now on: the field photos, and its own views">Approve</button>
            <button type="button" ${busy ? 'disabled' : ''}
                    onclick="Admin.decide('${escAttr(u.id)}','approve',true)"
                    title="Approve, and put the address on the allowlist so it may edit as well">Approve as editor</button>
            <button type="button" class="adm-danger" ${busy ? 'disabled' : ''}
                    onclick="Admin.decide('${escAttr(u.id)}','decline')"
                    title="Locked out: it cannot sign in again unless you undo this">Decline</button>
          </div>
        </li>`;
    };
    return `
      <div class="panel adm-waiting" id="adm-waiting">
        <div class="panel-header">
          <h2 id="adm-wait-h">Waiting for approval <span class="badge${waiting.length ? ' adm-badge-hot' : ''}">${waiting.length}</span></h2>
        </div>
        ${waiting.length ? `
        <p class="small">These accounts confirmed their address, and it is not one the allowlist approves on its own.
          <strong>Approve</strong> makes one a member — it sees the field photos and keeps its own views;
          <strong>Approve as editor</strong> also lets it edit; <strong>Decline</strong> locks it out. Each person
          approved is emailed once the mail is set up (docs/accounts.md).</p>
        <ul class="adm-wait-list" aria-labelledby="adm-wait-h">${waiting.map(row).join('')}</ul>`
        : '<p class="small table-empty">Nobody is waiting. Bureau addresses are approved as soon as they are confirmed, so only other addresses ever appear here.</p>'}
        ${unconfirmed.length ? `
        <details class="adm-unconfirmed">
          <summary>${unconfirmed.length} sign-up${unconfirmed.length === 1 ? '' : 's'} not confirmed yet</summary>
          <p class="small">An address that has not been confirmed counts for nothing, so there is nothing to decide until it is.
            A sign-up nobody confirms is a typo or a robot.</p>
          <ul class="adm-unconf-list">${unconfirmed.map(u => `<li class="small">${esc(u.email)} — ${when(u.created_at)}
            <button type="button" class="exp-btn-sm adm-danger" onclick="Admin.decide('${escAttr(u.id)}','decline')">Decline</button></li>`).join('')}</ul>
        </details>` : ''}
        ${signupHtml()}
      </div>`;
  }

  // Open, or allowlist only: app_meta signup (0062), as whoami() last said it.
  function signupHtml() {
    const open = typeof Auth === 'undefined' || !Auth.signupOpen || Auth.signupOpen();
    return `
        <fieldset class="adm-signup">
          <legend>Who may create an account</legend>
          <label class="check-inline"><input type="radio" name="adm-signup" value="open" ${open ? 'checked' : ''}
            onchange="Admin.setSignup(true)"> <span><strong>Anybody</strong> — Bureau addresses are approved as soon as they are
            confirmed, everybody else waits for an administrator</span></label>
          <label class="check-inline"><input type="radio" name="adm-signup" value="allowlist" ${open ? '' : 'checked'}
            onchange="Admin.setSignup(false)"> <span><strong>Only addresses on the allowlist</strong> — for when strangers'
            sign-ups are more than you want to sort through</span></label>
        </fieldset>`;
  }

  // An account's second addresses (0100), under the address it signs in with.
  function secondHtml(u) {
    const list = Array.isArray(u.addresses) ? u.addresses.filter(a => a && a.email) : [];
    return list.map(a => `
                    <div class="small txt-muted adm-also">+ ${esc(a.email)} · ${termHtml('second address', WORDS.second)}${
                      a.mail_here ? ' · their emails go here' : ''}
                      <button type="button" class="link-btn" onclick="Admin.freeAddress('${escAttr(a.email)}')"
                        aria-label="Free ${esc(a.email)} from ${esc(u.email)}">Free…</button></div>`).join('');
  }

  // The word for an account's standing, in the users table.
  const STANDING = {
    automatic:   ['approved', 'txt-ok', 'Approved by the allowlist — its address or its domain is on it'],
    approved:    ['approved', 'txt-ok', 'Approved by an administrator'],
    pending:     ['waiting', 'txt-warn', 'Confirmed, and waiting for an administrator'],
    declined:    ['declined', 'txt-bad', 'Declined — it cannot sign in'],
    unconfirmed: ['unconfirmed', 'txt-muted', 'Has not confirmed its address'],
  };

  // What the words in the two lists mean (CLAUDE.md "Plain words"). The
  // headings' hovers and the fold under the allowlist are this one list, so a
  // heading and the fold never explain a word two ways.
  const WORDS = {
    users:     'People: one row for each person who has made an account. Their name, role and standing are kept here.',
    allowlist: 'Rules about addresses, not people: each entry is one address or a whole domain, so it can match many accounts, or somebody who has not signed up yet.',
    role:      'Admin is the one that matters: an admin manages this tab (users, the allowlist, tokens, teams) — while the allowlist also lets them edit. Editor and viewer edit alike, because whether somebody may edit is the allowlist\'s (May edit); a viewer only may not write an AI briefing on Flood-Net\'s own key.',
    standing:  'Whether the account is let in as a member, who sees the field photos and inspection records: approved (by an allowlist entry, or by an administrator), waiting for an administrator, declined (locked out), or unconfirmed (its address was never confirmed).',
    mayEdit:   'Whether this person may edit stations, record inspections and upload photos. Not set here: yes when their confirmed address matches an allowlist entry — their own address\'s, or their domain\'s, which is named under it.',
    lastSeen:  'When the account last used Flood-Net, or online while it has a session open now. "Days in 30" is on how many of the last 30 days it was used, on any device.',
    entry:     'An address (name@example.org) matches that one person; a domain (@example.org) matches everybody whose address ends in it, now and later.',
    initialRole: 'The role an account starts with, the first time somebody this entry matches signs up. Used once: after that, change the role in Users. An address\'s own entry wins over its domain\'s; none set means editor.',
    matches:   'How many accounts this entry lets in now. An address with none has not signed up yet: the entry is waiting for them.',
    second:    'An address that was an account of its own until an administrator made it part of this one (Same person…). It does not sign in; somebody adding the person to a team finds this account by it, and the person can have Flood-Net\'s emails sent to it.',
  };
  const WORD_LABELS = [
    ['users', 'Users'], ['allowlist', 'Allowlist'], ['role', 'Role'], ['standing', 'Standing'],
    ['mayEdit', 'May edit'], ['lastSeen', 'Last seen'], ['entry', 'Entry'], ['initialRole', 'Initial role'],
    ['matches', 'Matches'], ['second', 'Second address'],
  ];
  const th = (k, label, cls) => `<th scope="col"${cls ? ` class="${cls}"` : ''}>${termHtml(label, WORDS[k])}</th>`;

  // Which allowlist entries match an address — the database's email_allowed()
  // (0004) said again, for showing which rule is which person's. The database
  // still decides; this only names the entry.
  const isDomain = a => String(a.entry || '')[0] === '@';
  function entryMatches(a, email) {
    const x = String(a.entry || '').toLowerCase(), e = String(email || '').toLowerCase();
    return x === e || (x[0] === '@' && e.endsWith(x));
  }
  // The one entry to name: the address's own, else the longest domain.
  function allowedBy(email) {
    const hits = (allow || []).filter(a => entryMatches(a, email));
    return hits.find(a => !isDomain(a))
      || hits.sort((a, b) => String(b.entry).length - String(a.entry).length)[0] || null;
  }
  function matchedUsers(a) { return (users || []).filter(u => entryMatches(a, u.email)); }

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
    return `${waitingHtml()}${usersHtml(status)}${allowHtml()}`;
  }

  function usersHtml(status) {
    const list = users || [];
    return `
      <div class="panel">
        <div class="panel-header">
          <h2 id="adm-users-h">Users — who has an account <span class="badge">${list.length}</span></h2>
          <button class="exp-btn-sm" onclick="Admin.load()">Refresh</button>
        </div>
        <p class="small">${termHtml('People', WORDS.users)}: one row for each account, most recently seen first. Here you
          set somebody's name and role and see their standing. Whether they may edit is <em>not</em> set here — the
          allowlist below decides it, and <strong>May edit</strong> names the entry that lets them in. Somebody with two
          accounts — a personal address and a work one, say — is made one person with <strong>Same person…</strong> on
          the account they will stop signing in with: everything it has moves to the other, and its address stays there
          as a ${termHtml('second address', WORDS.second)}.</p>
        ${status}
        ${list.length ? `
        <div class="table-wrap" role="region" tabindex="0" aria-labelledby="adm-users-h">
          <table class="adm-table">
            <caption class="sr-only">Every account, its role and standing, and which allowlist entry lets it edit</caption>
            <colgroup><col style="width:32%"><col style="width:14%"><col style="width:7.5rem">
              <col style="width:6.5rem"><col style="width:7rem"><col style="width:11%"><col style="width:9.5rem"></colgroup>
            <thead><tr>
              <th scope="col">Email</th><th scope="col">Display name</th>${th('role', 'Role')}
              ${th('standing', 'Standing')}${th('mayEdit', 'May edit')}${th('lastSeen', 'Last seen', 'col-optional')}
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              ${list.map(u => `
                <tr data-user="${escAttr(u.id)}">
                  <td>${esc(u.email)}${u.is_you ? ' <span class="badge">you</span>' : ''}${secondHtml(u)}</td>
                  <td><input type="text" data-f="name" value="${esc(u.display_name || '')}"
                             aria-label="Display name for ${esc(u.email)}"></td>
                  <td><select data-f="role" aria-label="Role for ${esc(u.email)}">
                    ${ROLES.map(r => `<option value="${r}"${u.role === r ? ' selected' : ''}>${r}</option>`).join('')}
                  </select>${roleHint(u)}</td>
                  <td>${standingCell(u)}</td>
                  <td>${mayEditCell(u)}</td>
                  <td class="small col-optional" title="${esc(lastSeenTitle(u))}">${u.active_sessions
                    ? '<span class="adm-online">● online</span>'
                    : esc(typeof AdminDash !== 'undefined' ? AdminDash.ago(u.last_seen_at || u.last_sign_in_at) : '')}
                    ${u.visits_30d ? `<br><span class="txt-muted">${Math.min(30, u.visits_30d)} day${u.visits_30d === 1 ? '' : 's'} in 30</span>` : ''}</td>
                  <td class="adm-row-acts"><div class="adm-acts-wrap">
                    <button class="exp-btn-sm" onclick="Admin.saveUser('${escAttr(u.id)}')">Save</button>
                    ${u.status === 'declined' ? `<button class="exp-btn-sm" onclick="Admin.decide('${escAttr(u.id)}','reset')"
                        title="Undo the decline: unlocked, and waiting again">Undo decline</button>` : ''}
                    ${u.is_you || u.status === 'declined' || !u.confirmed_at ? '' : `<button class="exp-btn-sm"
                        onclick="Admin.samePerson('${escAttr(u.id)}')"
                        title="This is the same person as another account: make the two one, kept under the other">Same person…</button>`}
                    ${u.is_you ? '' : `<button class="exp-btn-sm adm-danger"
                        onclick="Admin.deleteUser('${escAttr(u.id)}')">Delete</button>`}
                  </div></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : (users ? '<p class="small table-empty">Nobody has signed in yet.</p>' : '')}
      </div>`;
  }

  function standingCell(u) {
    const st = STANDING[u.status];
    if (!st) return '—';
    const by = u.status === 'approved' && u.decided_by ? ` by ${u.decided_by}` : '';
    return `<span class="${st[1]}" title="${esc(st[2] + by)}">${esc(st[0])}</span>`;
  }

  // Does the allowlist let this account edit right now? admin_users' may_edit
  // is the address matching an entry; a decline or an unconfirmed address
  // still stops it (is_editor() asks editor_email(), 0054, 0062).
  function edits(u) { return !!u.may_edit && u.status !== 'declined' && u.status !== 'unconfirmed'; }

  // "yes, by @bom.gov.au": the column that ties a person to the rule that
  // lets them in, so the two lists read as one answer.
  function mayEditCell(u) {
    if (!u.may_edit) return '<span class="txt-bad">no</span><div class="small txt-muted">no entry matches</div>';
    if (!edits(u)) {
      return `<span class="txt-bad">no</span><div class="small txt-muted">${u.status === 'declined'
        ? 'declined' : 'not until confirmed'}</div>`;
    }
    const a = allowedBy(u.email);
    if (!a) return '<span class="txt-ok">yes</span>';
    return `<span class="txt-ok">yes</span><div class="small txt-muted adm-by">${isDomain(a)
      ? `by <code>${esc(a.entry)}</code>` : 'by its own entry'}</div>`;
  }

  // Said where the role and the allowlist disagree — the two cases where the
  // Role column on its own says the wrong thing.
  function roleHint(u) {
    if (u.role === 'admin' && !edits(u)) {
      return '<div class="small txt-warn">not in force: cannot edit</div>';
    }
    if (u.role === 'viewer' && edits(u)) {
      return '<div class="small txt-warn">still edits: viewer does not stop editing</div>';
    }
    return '';
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
    const open = typeof Auth === 'undefined' || !Auth.signupOpen || Auth.signupOpen();
    return `
      <div class="panel">
        <div class="panel-header">
          <h2 id="adm-allow-h">Allowlist — who may edit <span class="badge">${list.length}</span></h2>
        </div>
        <p class="small">${termHtml('Rules, not people', WORDS.allowlist)}. An address (<code>name@example.org</code>)
          matches one person; a domain (<code>@example.org</code>) matches everybody at it — including people who have
          not signed up yet. A confirmed address that an entry matches <strong>may edit</strong>, and is approved
          without waiting for you. ${open
            ? 'Anybody else may still make an account; they wait under Waiting for approval.'
            : 'While sign-up is limited to the allowlist, an entry is also the only way to make an account.'}
          The <strong>initial role</strong> is the role a new account starts with, used once; after that, change it
          in Users.</p>
        <form class="adm-form" onsubmit="Admin.saveEntry();return false">
          <label>Address or @domain
            <input type="text" id="adm-entry" inputmode="email" autocomplete="off" required
                   value="${esc(form.entry)}" oninput="Admin.formField('entry',this.value)"
                   placeholder="someone@example.org or @example.org"></label>
          <label>Initial role
            <select id="adm-entry-role" onchange="Admin.formField('role',this.value)">
              <option value=""${form.role === '' ? ' selected' : ''}>editor (default)</option>
              ${ROLES.map(r => `<option value="${r}"${form.role === r ? ' selected' : ''}>${r}</option>`).join('')}
            </select></label>
          <label>Note
            <input type="text" id="adm-entry-note" value="${esc(form.note)}"
                   oninput="Admin.formField('note',this.value)" placeholder="Who they are, why they are here"></label>
          <button type="submit" class="primary">Add / update</button>
        </form>
        ${list.length ? `
        <div class="table-wrap" role="region" tabindex="0" aria-labelledby="adm-allow-h">
          <table class="adm-table">
            <caption class="sr-only">Allowlist entries, the role each gives a new account, and which accounts each lets in</caption>
            <colgroup><col style="width:30%"><col style="width:7.5rem"><col style="width:26%">
              <col style="width:7rem"><col style="width:14%"><col style="width:9.5rem"></colgroup>
            <thead><tr>
              ${th('entry', 'Entry')}${th('initialRole', 'Initial role')}<th scope="col">Note</th>
              ${th('matches', 'Matches')}<th scope="col" class="col-optional">Added</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              ${list.map((a, i) => `
                <tr>
                  <td><code>${esc(a.entry)}</code>${a.kind === 'domain' ? ' <span class="badge">domain</span>' : ''}</td>
                  <td>${initialRoleCell(a)}</td>
                  <td class="small">${esc(a.note || '')}</td>
                  <td>${matchesCell(a)}</td>
                  <td class="small col-optional">${when(a.added_at)}${a.added_by ? ` · ${esc(a.added_by)}` : ''}</td>
                  <td class="adm-row-acts">
                    <button class="exp-btn-sm" onclick="Admin.editEntry(${i})">Edit</button>
                    <button class="exp-btn-sm adm-danger" onclick="Admin.removeEntry(${i})">Remove</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
        ${whyTwoHtml()}
      </div>`;
  }

  // An address's initial role does nothing once its account exists: it was
  // given (or, for an entry added later, never given) at sign-up.
  function initialRoleCell(a) {
    const role = esc(a.initial_role || 'editor');
    if (isDomain(a) || !users || !matchedUsers(a).length) return role;
    return `<span class="txt-muted">${role}</span><div class="small txt-muted">not used now: has an account</div>`;
  }

  // How many accounts the entry lets in, and — on hover, and for one — who.
  function matchesCell(a) {
    const n = Number(a.users) || 0;
    if (!n) return isDomain(a) ? '0' : '0<div class="small txt-muted">no account yet</div>';
    const who = users ? matchedUsers(a).map(u => u.email) : [];
    if (!who.length) return esc(n);
    return n === 1 && !isDomain(a) ? '1'
      : `<span title="${esc(who.join(', '))}">${esc(n)}</span>`;
  }

  // Why the people and the rules are two lists, and what each word means — the
  // same meanings as the headings' hovers, for a finger or a keyboard.
  function whyTwoHtml() {
    return `
        <details class="adm-why">
          <summary>Why two lists, and what the words in them mean</summary>
          <p class="small"><strong>Users</strong> are people; the <strong>allowlist</strong> is rules. They cannot be one
            table, because neither fits the other's rows: one domain entry (<code>@bom.gov.au</code>) lets in every
            Bureau address, including people who have not signed up yet, and an address can be put on the list before
            its owner ever arrives; while somebody approved by hand — a council officer who should see the photos — is
            an account with no entry at all. So each account's <strong>May edit</strong> names the entry that applies
            to it, and each entry's <strong>Matches</strong> counts the accounts it lets in.</p>
          <p class="small"><strong>To stop somebody editing</strong>, remove the entry that lets them in (their May edit
            says which). Somebody let in only by a domain has no entry of their own, and short of removing the
            whole domain there is no way to stop them today: <strong>viewer</strong> does not stop editing yet.</p>
          <dl class="adm-words">${WORD_LABELS.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(WORDS[k])}</dd>`).join('')}</dl>
        </details>`;
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
        <p class="small">The enforcement is the database — <code>meganet.is_editor()</code>,
          <code>meganet.is_member()</code>, <code>meganet.is_admin()</code> — whatever this page shows. This app only asks.</p>
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
          ${link(docUrl('api.html'), 'Agent API & MCP')}
        </div>
      </div>`;
  }

  // ── The tab ──

  // Anything with a table is a row of its own, the page's full width: the
  // users, the allowlist, the tokens and the roles were a column beside the
  // data cards, and an email address broke across three lines to fit. The
  // cards with no table share two columns between them below.
  function render() {
    return `
      <div class="page adm-page stack" style="--page-max:1200px">
        <h2 class="sr-only">Admin</h2>
        <div id="adm-dash" class="stack">${typeof AdminDash !== 'undefined' ? AdminDash.render() : ''}</div>
        <div id="adm-links" class="stack">${typeof AdminLinks !== 'undefined' ? AdminLinks.render() : ''}</div>
        <div id="adm-people" class="stack">${peopleHtml()}</div>
        <div id="adm-tokens">${typeof AdminTokens !== 'undefined' ? AdminTokens.render() : ''}</div>
        <div id="adm-teams">${typeof AdminTeams !== 'undefined' ? AdminTeams.render() : ''}</div>
        <div id="adm-costs">${typeof AdminCosts !== 'undefined' ? AdminCosts.render() : ''}</div>
        <div class="adm-cards">
          ${dataHtml()}
          <div class="panel">
            <div class="panel-header"><h2>Your access</h2></div>
            <div id="adm-access">${accessHtml()}</div>
          </div>
          <div id="adm-push">${typeof Push !== 'undefined' ? Push.render() : ''}</div>
          <div id="adm-browser">${browserHtml()}</div>
          ${toolsHtml()}
        </div>
        ${typeof StationHistory !== 'undefined' ? StationHistory.adminHtml() : ''}
        ${rolesHtml()}
      </div>`;
  }

  function init() {
    if (!state.dbStatus) dbCheck();
    if (isAdmin() && users === null && !loading) load();
    // The deleted stations, for an editor (station-history.js): asked again
    // every visit, since a delete anywhere since is the point of the list.
    if (typeof StationHistory !== 'undefined') StationHistory.adminLoad();
    if (typeof AdminDash !== 'undefined') AdminDash.start();
    // How each base station's connection has been (admin-links.js, 0080).
    if (typeof AdminLinks !== 'undefined') AdminLinks.start();
    if (typeof AdminTokens !== 'undefined' && isAdmin()) AdminTokens.load();
    // The teams and every roster (admin-teams.js, 0095).
    if (typeof AdminTeams !== 'undefined' && isAdmin()) AdminTeams.load();
    // This device's notifications (push.js, 0066), and the icon's count.
    if (typeof Push !== 'undefined' && isAdmin()) Push.refresh();
  }

  // Only the parts that change are repainted: the Data source panel and the
  // snapshot note are live regions, and the allowlist form holds typing.
  function repaint(which) {
    if (state.activeTab !== 'admin') return;
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    if (!which || which === 'people') set('adm-people', peopleHtml());
    if (!which || which === 'access') set('adm-access', accessHtml());
    if (!which || which === 'browser') set('adm-browser', browserHtml());
    if (!which && typeof AdminCosts !== 'undefined') set('adm-costs', AdminCosts.render());
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
    // The dashboard's Waiting for approval tile counts the same list.
    if (typeof AdminDash !== 'undefined' && AdminDash.waitingChanged) AdminDash.waitingChanged();
    // The Teams panel suggests these accounts in its Add somebody box.
    if (typeof AdminTeams !== 'undefined' && AdminTeams.accountsChanged) AdminTeams.accountsChanged();
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

  // One decision about one account (0062: admin_user_decide). Declining is
  // asked first — it locks the person out — and approving is not: it can be
  // undone from the users table, and nobody is harmed by it meanwhile.
  async function decide(id, decision, editor = false) {
    const u = (users || []).find(x => x.id === id);
    if (!u || deciding.has(id)) return;
    if (decision === 'decline' && !(await confirmDialog({ title: `Decline ${u.email}?`,
      message: 'The account is locked out: it cannot sign in, and a session it already has stops counting at once. '
        + 'Undo decline in the users table lets it back in.',
      confirm: 'Decline the account', danger: true }))) return;
    deciding.add(id);
    repaint('people');
    try {
      await dbRpc('admin_user_decide', { p_id: id, p_decision: decision, p_make_editor: !!editor });
      announce(decision === 'approve' ? `Approved ${u.email}${editor ? ' as an editor' : ''}.`
             : decision === 'decline' ? `Declined ${u.email}.` : `${u.email} is waiting again.`);
      if (decision === 'approve' && typeof Toast !== 'undefined') {
        Toast.done(`Approved ${u.email}${editor ? ' as an editor' : ''}. They are emailed once the mail is set up.`);
      }
    } catch (err) {
      Toast.failed(err.status === 404
        ? 'The database cannot decide about accounts yet — apply db/migrations/0062_open_accounts_and_views.sql.'
        : err.message);
    }
    deciding.delete(id);
    await load();
    if (typeof Auth !== 'undefined' && Auth.recheck) Auth.recheck();
    if (typeof Push !== 'undefined') Push.refresh();
  }

  async function setSignup(open) {
    try {
      const now = await dbRpc('admin_set_signup', { p_open: !!open });
      announce(now === 'open' ? 'Anybody may sign up now.' : 'Only addresses on the allowlist may sign up now.');
      Toast.done(now === 'open' ? 'Sign-up is open: anybody may make an account, and waits for approval.'
                                : 'Sign-up is closed to everybody but the allowlist.');
    } catch (err) {
      Toast.failed(err.message);
    }
    if (typeof Auth !== 'undefined' && Auth.recheck) await Auth.recheck();
    repaint('people');
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

  // One person with two accounts (0100: account_merge). Asked on the account
  // they will stop signing in with; the one they keep is named by its address.
  // Everything moves over, the kept account gets whatever the other could do,
  // the other's sign-in goes and its address stays as the kept one's second.
  async function samePerson(id) {
    const u = (users || []).find(x => x.id === id);
    if (!u) return;
    const typed = await promptDialog({ title: `${u.email} is the same person as…`,
      label: 'The address of the account they will keep signing in with',
      message: `Everything ${u.email} has moves to the account you name: its teams (owning them where it did), the tasks `
        + 'it made and its notes, the ALERT2 plan\'s list, its devices and views, and whatever it was allowed to do. '
        + `Then ${u.email} stops signing in by itself and stays on that account as its second address — somebody adding `
        + 'them to a team finds them by it, and their emails can go to it.',
      placeholder: 'their.other@example.com', confirm: 'Next' });
    if (typed == null) return;
    const want = typed.trim().toLowerCase();
    const keep = (users || []).find(x => String(x.email || '').toLowerCase() === want);
    if (!keep) return Toast.failed(`No account signs in as ${typed.trim()}. Type the address of the account they keep.`);
    if (keep.id === u.id) return Toast.failed('That is the same account. Type the address of their other one.');
    const answer = await confirmDialog({ title: `Make ${u.email} part of ${keep.email}?`,
      message: `${u.email} will no longer sign in; ${keep.email} keeps everything it had. There is no undo: freeing the `
        + 'address afterwards lets it make a new account, an empty one.',
      checkbox: { label: `Send Flood-Net's emails to ${u.email} from now on (they can change it under Your account).`,
                  checked: true },
      confirm: 'Make them one account', danger: true });
    if (!answer) return;
    await act('account_merge', { p_keep: keep.id, p_retire: u.id, p_mail_here: !!answer.checked }, out =>
      `${u.email} is part of ${keep.email} now${out && out.teams
        ? `, on ${out.teams} team${out.teams === 1 ? '' : 's'}` : ''}.`);
    // Kept under the account signed in here: its addresses, teams and role
    // just changed, so ask the database again.
    if (keep.is_you && typeof Auth !== 'undefined' && Auth.recheck) await Auth.recheck();
  }

  // A second address let go (0100: admin_address_remove): it no longer finds
  // the account, no email goes to it, and it may sign up afresh.
  async function freeAddress(email) {
    if (!(await confirmDialog({ title: `Free ${email}?`,
      message: 'It stops being part of its account: nobody finds the account by it and no email goes to it. It may '
        + 'then sign up as an account of its own — a new one, with none of what the account has.',
      confirm: 'Free the address', danger: true }))) return;
    act('admin_address_remove', { p_email: email }, () => `${email} is free.`);
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

  return { render, init, load, authChanged, waitingCount, saveUser, deleteUser, samePerson, freeAddress, formField,
           saveEntry, editEntry, removeEntry, forgetKey, clearLocal, decide, setSignup,
           // What admin_users() last said (null before it answers), for the
           // Teams panel's suggestions.
           accounts: () => users };
})();
if (typeof window !== 'undefined') window.Admin = Admin;
