// MegaNet — tasks.js
//
//   Tasks   📋 the Tasks tab (0095): the jobs handed to teams — at a station,
//           with a status, a due date and a running thread of notes — listed
//           for the people they are for, opened one at a time, and made by the
//           people who may hand them out. Under them, My teams: the rosters of
//           the teams you are on, and for a team's owners the address box that
//           adds a member. Also the station card's own open tasks (cardHtml,
//           cardAsk), and the SoRT scope builder's hand-off (#tasks=…),
//           reviewed here before anything is made.
//
// After core.js (esc, escAttr, termHtml, announce, state, TAB_LIST), app.js
// (switchTab, renderTabs, renderMain, goToStation), datastore.js (dbRpc),
// modal.js (confirmDialog), toast.js and auth.js — all read at call time.
// Nothing here runs at load: renderMain() calls render() and init(), app.js's
// station card calls cardHtml() and cardAsk(), init.js calls
// restoreFromUrl() once after the first render, and auth.js calls
// authChanged() on every sign-in and sign-out.
//
// ── This is not what keeps a task private ────────────────────────────────────
// The database is (0095): a task is seen by the people who hand out tasks, the
// team it is handed to and whoever made it, through task_list() and the
// table's own policy alike, and every change goes through task_update(), which
// asks who is calling. This page only decides what to offer. The tab is listed
// to an administrator and to anybody whoami() says has tasks (Auth.tasks());
// opened by its address by anybody else it says who it is for and no more.
//
// ── The hand-off from SoRT ───────────────────────────────────────────────────
// SoRT's scope builder (cdomotor-g/SoRT, v2/js/tasks.js — the Atlas calls it
// `tasks-handoff`) opens https://floodwarning.net/#tasks=<payload> in a new
// tab. <payload> is base64url, no padding, of UTF-8 JSON:
//
//   {"v":1,"source":"sort","session":"<SoRT session uuid>","forum":"2026-10-07",
//    "station":{"id":"fifteen_mile_al","number":"540601","name":"Fifteen Mile AL","hub":"brisbane"},
//    "tasks":[{"ref":"alertIds","title":"…","detail":"…","team":{"hub":"brisbane"}},
//             {"ref":"acmaTransfer","title":"…","detail":"…","team":{"name":"Radio licensing"}},
//             {"ref":"custom-1","title":"…","detail":"…","team":{"name":"OTE"},"due":"2026-12-01"}]}
//
// It is somebody else's words arriving in an address, so it is read as
// untrusted (parseHandoff): its shape and lengths checked, unknown keys
// ignored, at most MAX_HANDOFF tasks, every string escaped where it is drawn.
// The fragment leaves the address bar as soon as it is read; the payload is
// kept in this tab's sessionStorage until it is dealt with, so signing in
// with Google — a trip away and back — does not lose it.
//
// Nothing is made until a signed-in person who may hand out tasks presses
// Create. The review is a row a task: its title, details, team and due date
// to change; the team chosen by the task's team.hub (the team looking after
// that hub) or team.name (its name, case aside), or none until somebody picks
// one. The station is station.id, else station.number, in the register; when
// neither is there, the station's name goes at the top of each task's details
// and the task has no station. Each task's source_ref is
// `sort:<session>:<ref>`, so a task already made from the same hand-off says
// "already made on dd/mm — open it" rather than being made twice (task_refs(),
// and task_create() refuses a second one anyway). Anybody else sees why they
// cannot: sign in, or "you can't hand out tasks — ask a SoRT Forum member".
//
// ── Telling people ───────────────────────────────────────────────────────────
// Not yet: a task waits on this tab and on its station's card. An email when
// one is handed to your team waits for #237's mail, a push for #216's alerts.

const Tasks = (function () {

  // ── The words this page uses ──────────────────────────────────────────────
  // One list: the hover on a heading or a chip, and the fold at the foot that
  // says them all without one.
  const STATUS = [
    { key: 'open',        label: 'Open',
      meaning: 'Handed to a team and not started yet.' },
    { key: 'in_progress', label: 'In progress',
      meaning: 'Somebody on the team is working on it.' },
    { key: 'waiting',     label: 'Waiting',
      meaning: 'Held up by something outside the team — parts, access to the site, a reply, the weather. A note says what.' },
    { key: 'done',        label: 'Done',
      meaning: 'Finished. The team marks it done; it can be opened again if it was not.' },
    { key: 'cancelled',   label: 'Cancelled',
      meaning: 'Not needed any more. Only whoever handed it out, an owner of its team or somebody who hands out tasks cancels a task or brings one back.' },
  ];
  const STATUS_OF = Object.fromEntries(STATUS.map(s => [s.key, s]));
  const LIVE = ['open', 'in_progress', 'waiting'];
  const WORDS = {
    task: 'A job to do, usually at one station: what is needed, the team that has it, how far it has got and when it is due, with every change and note kept in its thread.',
    team: 'The group of people a task is handed to — a maintenance hub\'s staff, Property Services, Radio licensing and so on. Everybody on it sees its tasks and moves them on.',
    status: 'How far a task has got: Open, In progress, Waiting, Done or Cancelled.',
    due: 'The date it should be done by, if one was set. Once it has passed and the task is not done, it says overdue.',
    unassigned: 'No team has it yet. It waits, seen only by the people who hand out tasks and whoever made it, until one of them picks a team.',
    handsout: 'Members of a team marked this way — the SoRT Forum — may give a task to any team, and see every task. Administrators may too.',
    owner: 'Looks after a team\'s roster: adds and takes off its members by the address of their Flood-Net account. An administrator names a team\'s owners. An owner may hand tasks to their own team.',
    member: 'On the team: sees its tasks, moves them on and writes notes on them.',
    sort: 'Made from the list the SoRT forum agreed for a station, handed over from SoRT\'s scope builder — the date is the forum\'s.',
    thread: 'Everything that has happened to the task, oldest first: who made it, every change of status or team, every edit and every note, with who and when.',
    mine: 'The tasks handed to a team you are on.',
  };
  const GLOSSARY = [['task', 'Task'], ['team', 'Team'], ['status', 'Status'],
    ...STATUS.map(s => [`st:${s.key}`, s.label]),
    ['due', 'Due'], ['unassigned', 'Unassigned'], ['handsout', 'Hands out tasks'], ['owner', 'Owner'],
    ['member', 'Member'], ['sort', 'From SoRT'], ['thread', 'Thread']];
  const word = k => (k.startsWith('st:') ? (STATUS_OF[k.slice(3)] || {}).meaning : WORDS[k]) || '';

  const MAX_HANDOFF = 30;              // tasks a hand-off may carry
  const MAX_RAW = 96 * 1024;           // characters of payload read at all
  const HANDOFF_KEY = 'mn-tasks-handoff';
  const FRESH = 60000;                 // a station card's tasks, asked again after a minute

  // ── State ──────────────────────────────────────────────────────────────────
  let teams = null;        // teams_read(): { me, teams, hubs }
  let list = null;         // task_list()
  let loading = false;
  let missing = false;     // the database has no 0095
  let refused = '';        // the database's words for why not (an account still waiting)
  let error = '';
  let view = 'list';       // 'list' | 'task' | 'new'
  let openId = null;       // the task open
  let task = null;         // task_get() for openId
  let opening = null;      // the task being asked for
  let taskErr = '';
  let busy = false;
  let note = '';           // the last thing done, said under the heading
  const filt = { scope: '', status: 'live', team: '', q: '' };
  let draft = freshDraft();
  // The open task's forms, mirrored: team null until one is picked.
  let upd = { status: '', note: '', team: null, edit: null };
  let handoff = null;      // parseHandoff()'s data, with the review's rows
  let hoError = '';
  let refsAsked = '';      // which hand-off's references were last asked about
  const memberAdd = {};    // team id → the address being typed
  let teamErr = {};        // team id → what the database said
  const cards = {};        // station id → { at, rows, p, error }

  function freshDraft(stationId) {
    return { station: stationId || '', general: false, q: '', title: '', details: '', team: '', due: '' };
  }

  // ── Who may do what (the database decides; this decides what to offer) ────
  const signedIn = () => typeof Auth !== 'undefined' && Auth.isSignedIn();
  const isAdmin = () => signedIn() && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  const forMe = () => signedIn() && (isAdmin() || !!(Auth.tasks && Auth.tasks()));
  const handsOut = () => (teams && teams.me ? !!teams.me.hands_out : signedIn() && !!(Auth.handsOut && Auth.handsOut()));
  const owns = () => (teams && teams.me && Array.isArray(teams.me.owns) ? teams.me.owns : []);
  const ownsAny = () => owns().length > 0 || (!teams && signedIn() && !!(Auth.teamOwner && Auth.teamOwner()));
  const mayHandOut = () => handsOut() || ownsAny();
  const mayAssignTo = id => handsOut() || (!!id && owns().includes(id));
  const teamById = id => (teams && teams.teams || []).find(t => t.id === id) || null;
  const teamName = id => (teamById(id) || {}).name || '';
  const myTeams = () => (teams && teams.teams || []).filter(t => t.role);

  // ── Small things ───────────────────────────────────────────────────────────
  const pad = n => String(n).padStart(2, '0');
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  // 2026-12-01 → 01/12/2026, as the dates are written here.
  function dmy(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  }
  // A moment as its local day and month — "already made on 07/10".
  function dm(ts) {
    const d = new Date(ts);
    return isNaN(d) ? '' : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  }
  function when(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return '';
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function validDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  }
  const stations = () => (state.data && Array.isArray(state.data.stations) ? state.data.stations : []);
  const stationOf = id => (id ? stations().find(s => s.id === id) || null : null);
  function stationLabel(id) {
    const s = stationOf(id);
    if (!s) return id || '';
    return s.station_number ? `${s.name} (${s.station_number})` : s.name;
  }
  function statusChip(key) {
    const s = STATUS_OF[key] || { label: key, meaning: '' };
    return `<span class="tk-st tk-st-${escAttr(key)} term-chip" title="${esc(s.meaning)}">${esc(s.label)}</span>`;
  }
  function dueHtml(t) {
    if (!t.due_on) return '<span class="txt-muted">—</span>';
    const late = LIVE.includes(t.status) && t.due_on < today();
    return late ? `<span class="tk-late">${esc(dmy(t.due_on))} <strong>overdue</strong></span>` : esc(dmy(t.due_on));
  }
  function errText(err, what) {
    if (!err) return '';
    if (err.status === 404 && /function|PGRST202|schema cache/i.test(err.message || '')) {
      missing = true;
      return 'The database does not have teams and tasks yet — db/migrations/0095_teams_and_tasks.sql.';
    }
    if (err.status === 0 || /Failed to fetch|NetworkError|Load failed/i.test(err.message || '')) {
      return `Could not reach the database to ${what}. Check the connection and try again.`;
    }
    return `Could not ${what}: ${err.message}`;
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  async function load() {
    if (!signedIn() || typeof dbRpc !== 'function') { paint(); return; }
    loading = true; error = ''; refused = '';
    paint();
    try {
      const [t, l] = await Promise.all([dbRpc('teams_read', {}), dbRpc('task_list', {})]);
      teams = t && typeof t === 'object' ? t : { me: {}, teams: [] };
      list = Array.isArray(l) ? l : [];
      missing = false;
      // Somebody who hands out tasks starts on all of them; anybody else on
      // their own teams' — or, on none, on everything they may see, which is
      // the ones they made.
      if (!filt.scope) filt.scope = teams.me && teams.me.hands_out ? 'all' : myTeams().length ? 'mine' : 'all';
      if (handoff) seedHandoffTeams();
    } catch (err) {
      if (err.code === '42501' || err.status === 403) refused = err.message;
      else error = errText(err, 'read the tasks');
    }
    loading = false;
    paint();
    if (handoff) askRefs();
    if (view === 'task' && openId && !task && opening !== openId) openTask(openId);
  }

  async function reloadList() {
    try {
      const l = await dbRpc('task_list', {});
      list = Array.isArray(l) ? l : list;
    } catch (_) { /* the list as it was; the next load says why */ }
    for (const k of Object.keys(cards)) delete cards[k];
  }

  // ── Painting ───────────────────────────────────────────────────────────────
  // The page is drawn from state, and every box mirrors what is typed into
  // state, so a repaint loses nothing; focus goes back to the control it was
  // on, by id or data-k.
  function focusKeyOf(el) {
    if (!el || el === document.body) return null;
    if (el.id) return `#${el.id}`;
    if (el.dataset && el.dataset.k) return `k:${el.dataset.k}`;
    return null;
  }
  function refocus(key) {
    if (!key) return;
    const el = key[0] === '#' ? document.getElementById(key.slice(1))
      : document.querySelector(`#main-content [data-k="${CSS.escape(key.slice(2))}"]`);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
  function paint(focusKey) {
    if (typeof document === 'undefined' || state.activeTab !== 'tasks') return;
    const el = document.getElementById('main-content');
    if (!el) return;
    const had = focusKey || (el.contains(document.activeElement) ? focusKeyOf(document.activeElement) : null);
    el.innerHTML = render();
    refocus(had);
  }
  function paintPart(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  // ── The page ───────────────────────────────────────────────────────────────

  function render() {
    const parts = [];
    if (handoff) parts.push(`<div id="tk-handoff">${handoffHtml()}</div>`);
    else if (hoError) parts.push(`<div class="panel tk-handoff" role="alert"><div class="panel-header"><h2>From SoRT</h2></div>
      <p class="small">${esc(hoError)}</p>
      <div class="button-group"><button type="button" class="ghost" onclick="Tasks.dismissHandoff()">Dismiss</button></div></div>`);
    if (!forMe()) {
      if (!handoff) parts.push(outsideHtml());
    } else {
      parts.push(`<div id="tk-body" class="stack">${bodyHtml()}</div>`);
      if (!missing && !refused) parts.push(`<div id="tk-teams">${teamsHtml()}</div>`);
    }
    // The words, said without hovering, wherever any of them is drawn.
    if (forMe() || handoff) parts.push(glossaryHtml());
    return `<div class="page tk-page" style="--page-max:1200px"><div class="stack">${parts.join('')}</div></div>`;
  }

  // Signed out, or signed in without being anybody tasks are for: what it is
  // and who it is for, and nothing more.
  function outsideHtml() {
    return `<div class="panel">
      <div class="panel-header"><h2>Tasks</h2></div>
      <p class="small">Jobs handed to a team, each at a station: what needs doing, who has it, how far it has got and
        when it is due, with a thread of notes.</p>
      <p class="small">Tasks are for administrators and the people on a team. A team's owner adds you to it by the
        address of your Flood-Net account.</p>
      ${signedIn() ? '' : '<div class="button-group"><button class="primary" onclick="Auth.open()">🔑 Sign in</button></div>'}
    </div>`;
  }

  function bodyHtml() {
    if (missing) {
      return `<div class="panel"><div class="panel-header"><h2>Tasks</h2></div>
        <p class="small">The database does not have teams and tasks yet: it needs
        <code>db/migrations/0095_teams_and_tasks.sql</code>.</p></div>`;
    }
    if (refused) {
      return `<div class="panel"><div class="panel-header"><h2>Tasks</h2></div>
        <p class="small">${esc(refused)}</p></div>`;
    }
    if (view === 'task') return taskHtml();
    if (view === 'new') return newHtml();
    return listHtml();
  }

  // ── The list ───────────────────────────────────────────────────────────────

  function scoped() {
    const q = filt.q.trim().toLowerCase();
    const words = q ? q.split(/\s+/) : [];
    return (list || []).filter(t => {
      if (filt.scope === 'mine' && !t.my_team) return false;
      if (filt.scope === 'by_me' && !t.by_me) return false;
      if (filt.status === 'live' && !LIVE.includes(t.status)) return false;
      if (filt.status !== 'live' && filt.status !== 'any' && t.status !== filt.status) return false;
      if (filt.team === '-' && t.team_id) return false;
      if (filt.team && filt.team !== '-' && t.team_id !== filt.team) return false;
      if (words.length) {
        const s = stationOf(t.station_id);
        const hay = `${s ? s.name : ''} ${s && s.station_number ? s.station_number : ''} ${t.station_id || ''}`.toLowerCase();
        if (!words.every(w => hay.includes(w))) return false;
      }
      return true;
    }).sort((a, b) => {
      const sa = STATUS.findIndex(s => s.key === a.status), sb = STATUS.findIndex(s => s.key === b.status);
      if (sa !== sb) return sa - sb;
      if ((a.due_on || '9') !== (b.due_on || '9')) return (a.due_on || '9') < (b.due_on || '9') ? -1 : 1;
      return String(b.created_at).localeCompare(String(a.created_at));
    });
  }

  function filtersHtml() {
    const opt = (v, label, cur) => `<option value="${escAttr(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const teamOpts = (teams && teams.teams || []).map(t => opt(t.id, t.name, filt.team)).join('');
    return `<div class="control-row tk-filters" role="group" aria-label="Which tasks">
        <label>Whose
          <select id="tk-f-scope" onchange="Tasks.filter('scope', this.value)">
            ${opt('mine', 'My teams\' tasks', filt.scope)}${opt('by_me', 'Made by me', filt.scope)}${opt('all', 'Everything I may see', filt.scope)}
          </select></label>
        <label>Status
          <select id="tk-f-status" onchange="Tasks.filter('status', this.value)">
            ${opt('live', 'Not finished', filt.status)}${STATUS.map(s => opt(s.key, s.label, filt.status)).join('')}${opt('any', 'Any', filt.status)}
          </select></label>
        <label>Team
          <select id="tk-f-team" onchange="Tasks.filter('team', this.value)">
            ${opt('', 'Every team', filt.team)}${opt('-', 'Unassigned', filt.team)}${teamOpts}
          </select></label>
        <label>Station
          <input type="search" id="tk-f-q" value="${escAttr(filt.q)}" placeholder="name or number" autocomplete="off"
                 oninput="Tasks.filter('q', this.value)"></label>
      </div>`;
  }

  function rowHtml(t) {
    const st = t.station_id ? `<button type="button" class="link-btn" onclick="event.stopPropagation(); Tasks.goStation('${escAttr(t.station_id)}')">${esc(stationLabel(t.station_id))}</button>`
      : '<span class="txt-muted">General</span>';
    const team = t.team_id ? esc(t.team || teamName(t.team_id))
      : termHtml('Unassigned', word('unassigned'));
    const from = t.source === 'sort'
      ? ` <span class="tk-src term-chip" title="${esc(word('sort'))}">SoRT${t.source_date ? ' ' + esc(dmy(t.source_date)) : ''}</span>` : '';
    return `<tr class="row-link" onclick="Tasks.open('${escAttr(t.id)}')">
        <th scope="row"><button type="button" class="row-open" data-k="open:${escAttr(t.id)}" onclick="event.stopPropagation(); Tasks.open('${escAttr(t.id)}')">${esc(t.title)}</button>${from}
          ${t.notes ? `<span class="small txt-muted"> · ${Number(t.notes)} note${Number(t.notes) === 1 ? '' : 's'}</span>` : ''}</th>
        <td>${st}</td>
        <td>${team}</td>
        <td>${statusChip(t.status)}</td>
        <td>${dueHtml(t)}</td>
        <td class="small col-optional">${esc(t.created_by || '—')}<div class="txt-muted">${esc(dmy(String(t.created_at).slice(0, 10)))}</div></td>
      </tr>`;
  }

  function tableHtml() {
    const rows = scoped();
    const total = (list || []).length;
    if (!rows.length) {
      return `<p class="small table-empty" role="status">${total
        ? 'No task fits what is picked above.'
        : 'No tasks yet that are yours to see.'}${mayHandOut() ? ' <button type="button" class="link-btn" onclick="Tasks.newTask()">Hand one out</button>.' : ''}</p>`;
    }
    return `<p class="small txt-muted" role="status">${rows.length} of ${total} task${total === 1 ? '' : 's'}</p>
      <div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="tk-list-h">
        <table class="tk-table">
          <caption class="sr-only">Tasks, unfinished first, soonest due first</caption>
          <thead><tr>
            <th scope="col">${termHtml('Task', word('task'))}</th>
            <th scope="col">Station</th>
            <th scope="col">${termHtml('Team', word('team'))}</th>
            <th scope="col">${termHtml('Status', word('status'))}</th>
            <th scope="col">${termHtml('Due', word('due'))}</th>
            <th scope="col" class="col-optional">Made by</th>
          </tr></thead>
          <tbody>${rows.map(rowHtml).join('')}</tbody>
        </table>
      </div>`;
  }

  function listHtml() {
    const head = `<div class="panel-header"><h2 id="tk-list-h" tabindex="-1"><span aria-hidden="true">✅</span> Tasks</h2>
        <div class="button-group">
          ${mayHandOut() ? '<button type="button" class="primary exp-btn-sm" id="tk-new-btn" onclick="Tasks.newTask()">New task</button>' : ''}
          <button type="button" class="exp-btn-sm" id="tk-refresh" onclick="Tasks.load()">Refresh</button>
        </div></div>`;
    let body = `<p class="small">Jobs handed to a ${termHtml('team', word('team'))}, each at a station: who has it, how far it
      has got and when it is due. ${handsOut() ? `You ${termHtml('hand out tasks', word('handsout'))}: you see every task, and may give one to any team.`
        : ownsAny() ? `As a team's ${termHtml('owner', word('owner'))} you may hand tasks to your own team.`
        : 'The tasks here are your teams\' and the ones you made.'}</p>`;
    if (note) body += `<p class="small txt-ok" role="status">${esc(note)}</p>`;
    if (error) body += `<p class="small txt-bad" role="alert">${esc(error)} <button type="button" class="link-btn" onclick="Tasks.load()">Try again</button></p>`;
    if (loading && !list) body += '<p class="small" role="status">Loading the tasks…</p>';
    if (list) body += filtersHtml() + `<div id="tk-table">${tableHtml()}</div>`;
    return `<div class="panel" aria-labelledby="tk-list-h">${head}${body}</div>`;
  }

  // ── One task ───────────────────────────────────────────────────────────────

  function threadEntryHtml(n) {
    const who = `<strong>${esc(n.you ? 'You' : n.who || 'Somebody')}</strong>`;
    let what;
    if (n.kind === 'created') what = n.to ? `${who} made it, for ${esc(n.to)}` : `${who} made it, with no team yet`;
    else if (n.kind === 'status') what = `${who} moved it from ${statusChip(n.from)} to ${statusChip(n.to)}`;
    else if (n.kind === 'team') what = `${who} handed it from ${esc(n.from || 'no team')} to ${esc(n.to || 'no team')}`;
    else if (n.kind === 'edit') what = `${who} changed its ${esc(n.to || 'words')}`;
    else what = `${who} wrote`;
    return `<li class="tk-entry tk-entry-${escAttr(n.kind)}">
        <div class="tk-entry-h small">${what} <span class="txt-muted">· ${esc(when(n.at))}</span></div>
        ${n.body ? `<div class="tk-body">${esc(n.body)}</div>` : ''}
      </li>`;
  }

  function statusOptions(t) {
    const may = t.may || {};
    return STATUS.filter(s => s.key === t.status || may.manage || (s.key !== 'cancelled' && t.status !== 'cancelled'))
      .map(s => `<option value="${s.key}"${s.key === (upd.status || t.status) ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
  }

  function teamOptions(cur, { none = false, only = null } = {}) {
    const all = (teams && teams.teams || []).filter(t => !only || only.includes(t.id) || t.id === cur);
    return (none ? `<option value=""${!cur ? ' selected' : ''}>No team yet</option>` : `<option value=""${!cur ? ' selected' : ''} disabled>— pick a team —</option>`)
      + all.map(t => `<option value="${escAttr(t.id)}"${t.id === cur ? ' selected' : ''}${only && !only.includes(t.id) ? ' disabled' : ''}>${esc(t.name)}</option>`).join('');
  }

  function taskHtml() {
    const back = '<button type="button" class="exp-btn-sm" id="tk-back" onclick="Tasks.back()">← All tasks</button>';
    if (!task) {
      return `<div class="panel"><div class="panel-header"><h2 id="tk-task-h">Task</h2>${back}</div>
        ${taskErr ? `<p class="small txt-bad" role="alert">${esc(taskErr)}</p>` : '<p class="small" role="status">Opening the task…</p>'}</div>`;
    }
    const t = task, may = t.may || {};
    const s = stationOf(t.station_id);
    const facts = [
      ['Station', t.station_id ? (s ? `<button type="button" class="link-btn" onclick="Tasks.goStation('${escAttr(t.station_id)}')">${esc(stationLabel(t.station_id))}</button>` : esc(t.station_id))
        : '<span class="txt-muted">None — a general task</span>'],
      [termHtml('Team', word('team')), t.team_id ? esc(t.team || teamName(t.team_id)) : termHtml('Unassigned', word('unassigned'))],
      [termHtml('Status', word('status')), statusChip(t.status) + (t.closed_at ? ` <span class="small txt-muted">since ${esc(when(t.closed_at))}</span>` : '')],
      [termHtml('Due', word('due')), dueHtml(t)],
      ['From', t.source === 'sort' ? `<span class="tk-src term-chip" title="${esc(word('sort'))}">SoRT</span>${t.source_date ? ` forum of ${esc(dmy(t.source_date))}` : ''}` : 'Flood-Net'],
      ['Made', `${esc(t.by_me ? 'by you' : `by ${t.created_by || 'somebody no longer here'}`)} on ${esc(when(t.created_at))}`],
    ];
    const work = may.work || may.manage;
    const updForm = work ? `<form class="tk-form" onsubmit="event.preventDefault(); Tasks.save()">
        <h3 id="tk-upd-h">Move it on</h3>
        <div class="control-row">
          <label>${termHtml('Status', word('status'))}
            <select id="tk-u-status" onchange="Tasks.updField('status', this.value)"${busy ? ' disabled' : ''}>${statusOptions(t)}</select></label>
        </div>
        <label class="tk-wide">A note for the thread (optional)
          <textarea id="tk-u-note" rows="3" maxlength="4000" oninput="Tasks.updField('note', this.value)"${busy ? ' disabled' : ''}>${esc(upd.note)}</textarea></label>
        <div class="button-group"><button type="submit" class="primary" id="tk-u-save"${busy ? ' disabled' : ''}>Save</button></div>
      </form>` : '<p class="small txt-muted">Only the team it is handed to, or whoever manages it, moves it on.</p>';
    const only = may.any_team ? null : (Array.isArray(may.owns) ? may.owns : []);
    const manage = may.manage ? `<details class="tk-fold" id="tk-manage"${upd.edit ? ' open' : ''} ontoggle="Tasks.manageToggled(this.open)">
        <summary><h3 class="bk-inline-h">Hand it over, or change it</h3></summary>
        <form class="tk-form" onsubmit="event.preventDefault(); Tasks.reassign()">
          <div class="control-row">
            <label>Hand it to
              <select id="tk-u-team" onchange="Tasks.updField('team', this.value)"${busy ? ' disabled' : ''}>${teamOptions(upd.team !== null ? upd.team : (t.team_id || ''), { none: !!may.any_team, only })}</select></label>
            <button type="submit" class="exp-btn-sm" id="tk-u-hand"${busy ? ' disabled' : ''}>Hand it over</button>
          </div>
          ${only ? '<p class="small txt-muted">You may hand it to your own team; somebody who hands out tasks gives it to any other.</p>' : ''}
        </form>
        ${editHtml(t)}
      </details>` : '';
    const thread = (t.thread || []).length
      ? `<ol class="tk-thread" aria-labelledby="tk-thread-h">${t.thread.map(threadEntryHtml).join('')}</ol>`
      : '<p class="small txt-muted">Nothing yet.</p>';
    return `<div class="panel tk-task" aria-labelledby="tk-task-h">
        <div class="panel-header"><h2 id="tk-task-h">${esc(t.title)}</h2>${back}</div>
        ${note ? `<p class="small txt-ok" role="status">${esc(note)}</p>` : ''}
        ${taskErr ? `<p class="small txt-bad" role="alert">${esc(taskErr)}</p>` : ''}
        <dl class="tk-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        ${t.details ? `<div class="tk-details tk-body">${esc(t.details)}</div>` : '<p class="small txt-muted">No details.</p>'}
        ${updForm}
        ${manage}
        <h3 id="tk-thread-h">${termHtml('Thread', word('thread'))}</h3>
        ${thread}
      </div>`;
  }

  function editHtml(t) {
    const e = upd.edit || { title: t.title, details: t.details || '', due: t.due_on || '', station: t.station_id || '' };
    return `<form class="tk-form" onsubmit="event.preventDefault(); Tasks.saveEdit()">
        <label class="tk-wide">Title
          <input type="text" id="tk-e-title" maxlength="200" value="${escAttr(e.title)}" oninput="Tasks.editField('title', this.value)"></label>
        <label class="tk-wide">Details
          <textarea id="tk-e-details" rows="4" maxlength="8000" oninput="Tasks.editField('details', this.value)">${esc(e.details)}</textarea></label>
        <div class="control-row">
          <label>${termHtml('Due', word('due'))}
            <input type="date" id="tk-e-due" value="${escAttr(e.due)}" onchange="Tasks.editField('due', this.value)"></label>
          <label>Station id
            <input type="text" id="tk-e-station" value="${escAttr(e.station)}" autocomplete="off" spellcheck="false"
                   placeholder="none for a general task" oninput="Tasks.editField('station', this.value)"></label>
        </div>
        <div class="button-group"><button type="submit" class="exp-btn-sm" id="tk-e-save"${busy ? ' disabled' : ''}>Save the changes</button></div>
      </form>`;
  }

  async function openTask(id) {
    openId = id; view = 'task'; taskErr = '';
    if (!task || task.id !== id) { task = null; upd = { status: '', note: '', team: null, edit: null }; }
    opening = id;
    paint();
    try {
      const got = await dbRpc('task_get', { p_id: id });
      if (openId !== id) return;          // another was opened meanwhile
      task = got;
    } catch (err) {
      if (openId !== id) return;
      task = null;
      taskErr = err.code === 'P0002' ? 'That task is not there, or is not one you may see.' : errText(err, 'open the task');
    } finally {
      if (opening === id) opening = null;
    }
    paint();
    const h = document.getElementById('tk-task-h');
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: false }); }
  }

  // One change through task_update(), then the task drawn again from its answer.
  async function change(p_change, said, focusId) {
    if (!task || busy) return null;
    busy = true; taskErr = ''; note = '';
    paint(focusId ? `#${focusId}` : null);
    let out = null;
    try {
      out = await dbRpc('task_update', { p_id: task.id, p_change });
      task = out;
      upd = { status: '', note: '', team: null, edit: null };
      note = said;
      announce(said);
      await reloadList();
    } catch (err) {
      taskErr = errText(err, 'save that');
    }
    busy = false;
    paint(focusId ? `#${focusId}` : null);
    return out;
  }

  // ── A new task ─────────────────────────────────────────────────────────────

  function stationMatches(q) {
    const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return stations().filter(s => {
      const hay = `${s.name || ''} ${s.station_number || ''} ${s.id}`.toLowerCase();
      return words.every(w => hay.includes(w));
    }).slice(0, 8);
  }

  function picksHtml() {
    if (draft.station || draft.general) return '';
    const hits = stationMatches(draft.q);
    if (!draft.q.trim()) return '';
    if (!hits.length) return '<p class="small txt-muted" role="status">No station by that name or number.</p>';
    return `<ul class="tk-picks" aria-label="Matching stations">${hits.map(s =>
      `<li><button type="button" class="link-btn" data-k="pick:${escAttr(s.id)}" onclick="Tasks.pickStation('${escAttr(s.id)}')">${esc(s.name)}${s.station_number ? ` <span class="txt-muted">${esc(s.station_number)}</span>` : ''}</button></li>`).join('')}</ul>`;
  }

  function newHtml() {
    const only = handsOut() ? null : owns();
    const st = draft.station
      ? `<p class="tk-picked">${esc(stationLabel(draft.station))} <button type="button" class="link-btn" id="tk-n-unpick" onclick="Tasks.pickStation('')">Change</button></p>`
      : `<label class="tk-wide">Station — its name or number
          <input type="search" id="tk-n-q" value="${escAttr(draft.q)}" autocomplete="off"${draft.general ? ' disabled' : ''}
                 oninput="Tasks.stationTyped(this.value)"></label>
        <div id="tk-picks">${picksHtml()}</div>
        <label class="check-label"><input type="checkbox" id="tk-n-general"${draft.general ? ' checked' : ''}
          onchange="Tasks.draftField('general', this.checked)"><span>A general task, at no one station</span></label>`;
    return `<div class="panel" aria-labelledby="tk-new-h">
        <div class="panel-header"><h2 id="tk-new-h">New task</h2>
          <button type="button" class="exp-btn-sm" id="tk-n-cancel" onclick="Tasks.back()">Cancel</button></div>
        ${taskErr ? `<p class="small txt-bad" role="alert">${esc(taskErr)}</p>` : ''}
        <form class="tk-form" onsubmit="event.preventDefault(); Tasks.create()">
          ${st}
          <label class="tk-wide">Title — what is to be done, in a line
            <input type="text" id="tk-n-title" maxlength="200" value="${escAttr(draft.title)}" oninput="Tasks.draftField('title', this.value)"></label>
          <label class="tk-wide">Details (optional)
            <textarea id="tk-n-details" rows="4" maxlength="8000" oninput="Tasks.draftField('details', this.value)">${esc(draft.details)}</textarea></label>
          <div class="control-row">
            <label>${termHtml('Team', word('team'))}
              <select id="tk-n-team" onchange="Tasks.draftField('team', this.value)">${teamOptions(draft.team, { none: !only, only })}</select></label>
            <label>${termHtml('Due', word('due'))} (optional)
              <input type="date" id="tk-n-due" value="${escAttr(draft.due)}" onchange="Tasks.draftField('due', this.value)"></label>
          </div>
          ${only ? '<p class="small txt-muted">As a team\'s owner you hand tasks to your own team. Somebody who hands out tasks — the SoRT Forum, or an administrator — gives them to any.</p>' : ''}
          <div class="button-group"><button type="submit" class="primary" id="tk-n-go"${busy ? ' disabled' : ''}>Hand it out</button></div>
        </form>
      </div>`;
  }

  async function create() {
    if (busy || !mayHandOut()) return;
    const title = draft.title.trim();
    taskErr = '';
    if (!draft.station && !draft.general) taskErr = 'Pick the station, or tick that it is a general task.';
    else if (!title) taskErr = 'Give it a title — what is to be done, in a line.';
    else if (!draft.team && !handsOut()) taskErr = 'Pick your team.';
    if (taskErr) { paint(); return; }
    const t = { title, details: draft.details, team_id: draft.team || null };
    if (draft.station && !draft.general) t.station_id = draft.station;
    if (draft.due) t.due_on = draft.due;
    busy = true; paint('#tk-n-go');
    try {
      const out = await dbRpc('task_create', { p_tasks: [t] });
      const made = out && out.created && out.created[0];
      draft = freshDraft();
      note = `Handed out: ${title}${t.team_id ? ` — to ${teamName(t.team_id)}` : ', with no team yet'}.`;
      announce(note);
      await reloadList();
      busy = false;
      if (made) { openTask(made.id); return; }
      view = 'list';
    } catch (err) {
      taskErr = errText(err, 'hand it out');
    }
    busy = false;
    paint();
  }

  // ── My teams ───────────────────────────────────────────────────────────────

  function rosterHtml(t, ownerView) {
    const r = Array.isArray(t.roster) ? t.roster : [];
    if (!r.length) return '<p class="small txt-muted">Nobody yet.</p>';
    return `<div class="table-wrap"><table class="tk-roster">
        <caption class="sr-only">Who is on ${esc(t.name)}</caption>
        <thead><tr><th scope="col">Person</th><th scope="col">On it as</th><th scope="col" class="col-optional">Added</th>
          ${ownerView ? '<th scope="col"><span class="sr-only">Actions</span></th>' : ''}</tr></thead>
        <tbody>${r.map(p => `<tr>
          <th scope="row">${esc(p.who || p.email || '—')}${p.you ? ' <span class="badge">you</span>' : ''}${
            p.email && p.email !== p.who ? `<div class="small txt-muted tk-mail">${esc(p.email)}</div>` : ''}</th>
          <td>${p.owner ? `<span class="term-chip tk-role" title="${esc(word('owner'))}">Owner</span>`
                        : `<span class="term-chip tk-role" title="${esc(word('member'))}">Member</span>`}</td>
          <td class="small col-optional">${esc(dmy(String(p.added_at || '').slice(0, 10)))}${p.added_by ? ` by ${esc(p.added_by)}` : ''}</td>
          ${ownerView ? `<td>${p.owner ? '' : `<button type="button" class="exp-btn-sm" data-k="off:${escAttr(t.id)}:${escAttr(p.id)}"
                onclick="Tasks.takeOff('${escAttr(t.id)}', '${escAttr(p.id)}')" aria-label="Take ${escAttr(p.who || p.email || '')} off ${escAttr(t.name)}">Take off…</button>`}</td>` : ''}
        </tr>`).join('')}</tbody></table></div>`;
  }

  function teamCardHtml(t) {
    const own = t.role === 'owner';
    const chips = [
      t.hub ? `<span class="tk-chip">${esc(t.hub)}</span>` : '',
      t.hands_out ? `<span class="tk-chip term-chip" title="${esc(word('handsout'))}">Hands out tasks</span>` : '',
      own ? `<span class="tk-chip term-chip" title="${esc(word('owner'))}">You own it</span>` : '',
    ].join(' ');
    const add = own ? `<form class="tk-add" onsubmit="event.preventDefault(); Tasks.addMember('${escAttr(t.id)}')">
        <label>Add somebody, by the address of their Flood-Net account
          <input type="email" id="tk-add-${escAttr(t.id)}" maxlength="254" autocomplete="off" spellcheck="false"
                 value="${escAttr(memberAdd[t.id] || '')}" oninput="Tasks.memberTyped('${escAttr(t.id)}', this.value)"></label>
        <button type="submit" class="exp-btn-sm" data-k="add:${escAttr(t.id)}">Add to ${esc(t.name)}</button>
        <p class="small txt-muted">They need an approved account first. Only an administrator makes somebody an owner.</p>
      </form>` : '';
    return `<section class="tk-team" aria-labelledby="tk-team-${escAttr(t.id)}-h">
        <h3 id="tk-team-${escAttr(t.id)}-h">${esc(t.name)} ${chips}</h3>
        ${teamErr[t.id] ? `<p class="small txt-bad" role="alert">${esc(teamErr[t.id])}</p>` : ''}
        ${rosterHtml(t, own)}
        ${add}
      </section>`;
  }

  function teamsHtml() {
    if (!teams) return '';
    const mine = myTeams();
    const intro = mine.length
      ? `The teams you are on, and who else is. A team's ${termHtml('owners', word('owner'))} add and take off its members.`
      : 'You are on no team.';
    const adminLine = isAdmin()
      ? ' Administrators make the teams and name their owners on the <button type="button" class="link-btn" onclick="switchTab(\'admin\')">Admin tab</button>, under Teams.' : '';
    return `<div class="panel" aria-labelledby="tk-teams-h">
        <div class="panel-header"><h2 id="tk-teams-h">My teams</h2></div>
        <p class="small">${intro}${adminLine}</p>
        ${mine.map(teamCardHtml).join('')}
      </div>`;
  }

  async function teamCall(teamId, fn, args, said, focusKey) {
    teamErr = { ...teamErr, [teamId]: '' };
    try {
      const out = await dbRpc(fn, args);
      if (out && typeof out === 'object' && out.teams) teams = out;
      announce(said);
      paint(focusKey);
      return true;
    } catch (err) {
      teamErr = { ...teamErr, [teamId]: errText(err, 'change the team') };
      paint(focusKey);
      return false;
    }
  }

  // ── The station card's tasks ───────────────────────────────────────────────
  // For the people tasks are for, and nothing at all for anybody else: the
  // station's tasks still going, each opening here; and for somebody who may
  // hand them out, a way to make one at this station.

  function cardHtml(s) {
    if (!s || !forMe()) return '';
    return `<div class="acma-sect stn-card-tasks" id="mn-tasks-card-${escAttr(s.id)}" data-mn-tasks="${escAttr(s.id)}">${cardInner(s.id)}</div>`;
  }

  function cardInner(id) {
    const c = cards[id];
    if (!c || !Array.isArray(c.rows)) return '';
    const rows = c.rows.filter(t => LIVE.includes(t.status));
    if (!rows.length && !mayHandOut()) return '';
    const head = `<span class="small txt-muted stn-card-equip-h">${termHtml('Tasks', word('task'))} still going here</span>`;
    const body = rows.length ? rows.slice(0, 8).map(t => `<div class="acma-row"><span>${statusChip(t.status)}</span><span>
          <button type="button" class="link-btn" onclick="Tasks.open('${escAttr(t.id)}')">${esc(t.title)}</button>
          <span class="small txt-muted"> · ${esc(t.team || 'unassigned')}${t.due_on ? ` · due ${esc(dmy(t.due_on))}` : ''}</span></span></div>`).join('')
        + (rows.length > 8 ? `<div class="small txt-muted">and ${rows.length - 8} more on the Tasks tab</div>` : '')
      : '<div class="small txt-muted">None.</div>';
    const make = mayHandOut() ? `<div><button type="button" class="link-btn tk-new-here" onclick="Tasks.newAt('${escAttr(id)}')">✅ New task here</button></div>` : '';
    return head + body + make;
  }

  function cardAsk(s) {
    if (!s || !forMe() || typeof dbRpc !== 'function') return;
    const id = s.id;
    const c = cards[id];
    if (c && (c.p || Date.now() - c.at < FRESH)) return;
    const e = cards[id] = { at: Date.now(), rows: c ? c.rows : null, p: null };
    e.p = dbRpc('task_list', { p_station_id: id, p_open_only: true })
      .then(rows => { e.rows = Array.isArray(rows) ? rows : []; },
            () => { e.rows = e.rows || []; })
      .finally(() => {
        e.p = null; e.at = Date.now();
        const el = document.getElementById(`mn-tasks-card-${id}`);
        if (el && el.dataset.mnTasks === id) el.innerHTML = cardInner(id);
      });
  }

  // ── The hand-off from SoRT ─────────────────────────────────────────────────

  // One line of somebody else's text: control characters out, spaces closed
  // up, at most `max` characters.
  function line(v, max) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }
  // Several lines of it: newlines and tabs kept, the other control characters
  // out.
  function textBlock(v, max) {
    if (typeof v !== 'string') return '';
    return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, '').replace(/\s+$/, '').slice(0, max);
  }

  function b64urlText(raw) {
    let s = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  // The payload, read as untrusted: { ok, why } or { ok: true, data }. Pure —
  // test/tasks.mjs holds it to the contract.
  function parseHandoff(raw) {
    if (typeof raw !== 'string' || !raw) return { ok: false, why: 'The link carried no tasks.' };
    if (raw.length > MAX_RAW) return { ok: false, why: 'The link is too long to be a hand-off from SoRT.' };
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) return { ok: false, why: 'The link\'s tasks could not be read: it is not a hand-off from SoRT.' };
    let o;
    try { o = JSON.parse(b64urlText(raw)); } catch (_) {
      return { ok: false, why: 'The link\'s tasks could not be read — it may have been cut short. Open it again from SoRT.' };
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, why: 'The link\'s tasks could not be read: it is not a hand-off from SoRT.' };
    if (o.v !== 1) {
      return { ok: false, why: typeof o.v === 'number' && o.v > 1
        ? `This link is from a newer SoRT (version ${Math.floor(o.v)}) than Flood-Net reads yet. Flood-Net needs bringing up to date before it can take it.`
        : 'The link\'s tasks could not be read: it is not a hand-off Flood-Net knows.' };
    }
    if (o.source !== 'sort') return { ok: false, why: 'The link\'s tasks could not be read: it does not say it is from SoRT.' };
    if (typeof o.session !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(o.session)) {
      return { ok: false, why: 'The link\'s tasks could not be read: it does not say which SoRT session they came from.' };
    }
    const st = o.station && typeof o.station === 'object' && !Array.isArray(o.station) ? o.station : {};
    const station = {
      id: typeof st.id === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(st.id) ? st.id : '',
      number: typeof st.number === 'string' && /^[A-Za-z0-9-]{1,20}$/.test(st.number.trim()) ? st.number.trim() : '',
      name: line(st.name, 120),
      hub: line(st.hub, 40),
    };
    if (!Array.isArray(o.tasks)) return { ok: false, why: 'The link carried no tasks.' };
    const rows = [], seen = new Set();
    let skipped = 0;
    for (const t of o.tasks) {
      if (rows.length >= MAX_HANDOFF) break;
      if (!t || typeof t !== 'object' || Array.isArray(t)) { skipped++; continue; }
      const ref = typeof t.ref === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(t.ref) ? t.ref : '';
      const title = line(t.title, 200);
      if (!ref || !title || seen.has(ref)) { skipped++; continue; }
      seen.add(ref);
      const team = t.team && typeof t.team === 'object' && !Array.isArray(t.team) ? t.team : {};
      rows.push({
        ref, title,
        detail: textBlock(t.detail, 7000),
        wantHub: line(team.hub, 40),
        wantTeam: line(team.name, 80),
        due: validDate(t.due) ? t.due : '',
      });
    }
    if (!rows.length) return { ok: false, why: 'The link carried no tasks Flood-Net could read.' };
    return { ok: true, data: {
      raw, session: o.session, forum: validDate(o.forum) ? o.forum : '', station, rows,
      over: Math.max(0, o.tasks.length - rows.length - skipped), skipped,
    } };
  }

  // The register's station the hand-off names: its id, else its number.
  function handoffStation() {
    if (!handoff) return null;
    const st = handoff.station;
    return (st.id && stations().find(s => s.id === st.id))
      || (st.number && stations().find(s => String(s.station_number || '') === st.number)) || null;
  }

  // The team a row asks for: the one looking after its hub, else the one by
  // its name, case aside — or none.
  function matchTeam(row) {
    const all = teams && teams.teams || [];
    const h = row.wantHub.toLowerCase();
    if (h) {
      const t = all.find(x => x.hub_id && x.hub_id.toLowerCase() === h)
        || all.find(x => x.hub && (x.hub.toLowerCase() === h || x.hub.toLowerCase() === `${h} hub`));
      if (t) return t;
    }
    const n = row.wantTeam.toLowerCase();
    return n ? all.find(x => x.name.toLowerCase() === n) || null : null;
  }

  // Once the teams are known: each row's team picked for it, and — for an
  // owner who may hand out to their own team only — a row for another team
  // left out until they pick their own.
  function seedHandoffTeams() {
    if (!handoff || !teams) return;
    for (const r of handoff.rows) {
      if (r.teamPicked) continue;
      const t = matchTeam(r);
      r.matched = t ? t.name : '';
      r.team = t && mayAssignTo(t.id) ? t.id : '';
      r.notYours = !!(t && !mayAssignTo(t.id));
      if (r.notYours) r.include = false;
    }
  }

  function startHandoff(data) {
    handoff = { ...data, rows: data.rows.map(r => ({ ...r, include: true, team: '', teamPicked: false,
                                                   existing: null, created: null })) };
    hoError = '';
    refsAsked = '';
    try { sessionStorage.setItem(HANDOFF_KEY, data.raw); } catch (_) { /* this tab only, then */ }
    seedHandoffTeams();
  }

  const sourceRef = r => `sort:${handoff.session}:${r.ref}`;

  async function askRefs() {
    if (!handoff || !signedIn() || !teams || typeof dbRpc !== 'function') return;
    const key = handoff.raw;
    if (refsAsked === key) return;
    refsAsked = key;
    try {
      const got = await dbRpc('task_refs', { p_refs: handoff.rows.map(sourceRef) });
      if (!handoff || handoff.raw !== key) return;
      for (const x of Array.isArray(got) ? got : []) {
        const r = handoff.rows.find(y => sourceRef(y) === x.ref);
        if (r && !r.created) r.existing = x;
      }
    } catch (_) { refsAsked = ''; }
    paint();
  }

  function rowAllowed(r) { return handsOut() || (!!r.team && owns().includes(r.team)); }
  const toMake = () => (handoff ? handoff.rows.filter(r => r.include && !r.created && !r.existing && rowAllowed(r)) : []);

  function hoRowHtml(r, i, editable) {
    const ref = `<span class="small txt-muted tk-ref">${esc(r.ref)}</span>`;
    if (r.created) {
      return `<li class="tk-ho-row is-made"><div class="tk-ho-title">${esc(r.title)} ${ref}</div>
        <p class="small txt-ok">Made${r.team ? ` for ${esc(teamName(r.team))}` : ''} — <button type="button" class="link-btn" onclick="Tasks.open('${escAttr(r.created)}')">open it</button></p></li>`;
    }
    if (r.existing) {
      return `<li class="tk-ho-row is-made"><div class="tk-ho-title">${esc(r.title)} ${ref}</div>
        <p class="small">Already made on ${esc(dm(r.existing.created_at))}${r.existing.visible && r.existing.id
          ? ` — <button type="button" class="link-btn" onclick="Tasks.open('${escAttr(r.existing.id)}')">open it</button>`
          : ', for a team whose tasks you do not see'}.</p></li>`;
    }
    const want = r.matched || r.wantTeam || (r.wantHub ? `the ${r.wantHub} hub's team` : '');
    if (!editable) {
      return `<li class="tk-ho-row"><div class="tk-ho-title">${esc(r.title)} ${ref}</div>
        ${r.detail ? `<div class="tk-body small">${esc(r.detail)}</div>` : ''}
        <p class="small txt-muted">${want ? `For ${esc(want)}` : 'No team named'}${r.due ? ` · due ${esc(dmy(r.due))}` : ''}</p></li>`;
    }
    const only = handsOut() ? null : owns();
    return `<li class="tk-ho-row${r.include ? '' : ' is-out'}">
        <label class="check-label"><input type="checkbox" data-k="ho-in:${i}"${r.include ? ' checked' : ''}
          onchange="Tasks.hoField(${i}, 'include', this.checked)"><span>Make this one ${ref}</span></label>
        <label class="tk-wide">Title
          <input type="text" data-k="ho-title:${i}" maxlength="200" value="${escAttr(r.title)}" oninput="Tasks.hoField(${i}, 'title', this.value)"></label>
        <label class="tk-wide">Details
          <textarea data-k="ho-detail:${i}" rows="3" maxlength="7000" oninput="Tasks.hoField(${i}, 'detail', this.value)">${esc(r.detail)}</textarea></label>
        <div class="control-row">
          <label>${termHtml('Team', word('team'))}
            <select data-k="ho-team:${i}" onchange="Tasks.hoField(${i}, 'team', this.value)">${teamOptions(r.team, { none: !only, only })}</select></label>
          <label>${termHtml('Due', word('due'))}
            <input type="date" data-k="ho-due:${i}" value="${escAttr(r.due)}" onchange="Tasks.hoField(${i}, 'due', this.value)"></label>
        </div>
        ${r.notYours ? `<p class="small txt-warn">SoRT asked for ${esc(r.matched)} — you may hand tasks only to your own team. Pick it, or ask a SoRT Forum member to make this one.</p>`
          : !r.team && handsOut() ? `<p class="small txt-muted">${want && !r.matched ? `SoRT asked for ${esc(want)}, which is not a team here. ` : ''}No team yet: it waits, ${termHtml('unassigned', word('unassigned'))}, until somebody picks one.</p>`
          : !r.team ? '<p class="small txt-warn">Pick your team, or leave this one out.</p>' : ''}
      </li>`;
  }

  function handoffHtml() {
    const h = handoff;
    const st = handoffStation();
    const named = h.station.name || h.station.number || h.station.id || 'a station';
    const where = st ? `<button type="button" class="link-btn" onclick="Tasks.goStation('${escAttr(st.id)}')">${esc(stationLabel(st.id))}</button>`
      : esc(named);
    const lost = !st && (h.station.id || h.station.number || h.station.name)
      ? `<p class="small txt-warn">${esc(named)} is not in Flood-Net's station list${state.data ? '' : ' (still loading)'}: these tasks will have no station, and its name goes at the top of each one's details.</p>` : '';
    const editable = signedIn() && !!teams && mayHandOut();
    const n = toMake().length;
    let say;
    if (!signedIn()) {
      say = `<p class="small">Sign in to make these tasks — with an account that may hand them out.</p>
        <div class="button-group"><button class="primary" onclick="Auth.open()">🔑 Sign in</button>
        <button type="button" class="ghost" onclick="Tasks.dismissHandoff()">Dismiss</button></div>`;
    } else if (refused) {
      say = `<p class="small">${esc(refused)}</p>`;
    } else if (!teams) {
      say = loading ? '<p class="small" role="status">Finding out what you may do…</p>' : (error ? `<p class="small txt-bad">${esc(error)}</p>` : '');
    } else if (!mayHandOut()) {
      say = `<p class="small"><strong>You can't hand out tasks</strong> — ask a SoRT Forum member to open this link, or
        an administrator. <button type="button" class="link-btn" id="tk-ho-copy" onclick="Tasks.copyHandoff()">Copy the link</button> to send it on.</p>
        <div class="button-group"><button type="button" class="ghost" onclick="Tasks.dismissHandoff()">Dismiss</button></div>`;
    } else {
      const others = h.rows.some(r => r.notYours && !r.created && !r.existing);
      say = `${others ? `<p class="small">Some are for teams you cannot hand tasks to: <button type="button" class="link-btn" id="tk-ho-copy"
          onclick="Tasks.copyHandoff()">copy the link</button> to send it to a SoRT Forum member for those.</p>` : ''}
        <div class="button-group">
          <button type="button" class="primary" id="tk-ho-go" onclick="Tasks.makeHandoff()"${n && !busy ? '' : ' disabled'}>Create ${n} task${n === 1 ? '' : 's'}</button>
          <button type="button" class="ghost" id="tk-ho-dismiss" onclick="Tasks.dismissHandoff()">${h.rows.every(r => r.created || r.existing) ? 'Done' : 'Dismiss'}</button>
        </div>`;
    }
    const counts = [h.skipped ? `${h.skipped} it carried could not be read and ${h.skipped === 1 ? 'is' : 'are'} left out` : '',
                    h.over ? `only the first ${MAX_HANDOFF} are shown — ${h.over} more ${h.over === 1 ? 'was' : 'were'} left out` : ''].filter(Boolean);
    return `<div class="panel tk-handoff" aria-labelledby="tk-ho-h">
        <div class="panel-header"><h2 id="tk-ho-h">From SoRT: ${h.rows.length} task${h.rows.length === 1 ? '' : 's'} for ${esc(named)}</h2></div>
        <p class="small">The ${termHtml('SoRT', word('sort'))} scope builder${h.forum ? `, from the forum of ${esc(dmy(h.forum))},` : ''} handed these over for ${where}.
          Nothing is made until you press Create: check each one, its team and its date first.</p>
        ${lost}
        ${counts.length ? `<p class="small txt-muted">Of the tasks the link carried, ${esc(counts.join('; '))}.</p>` : ''}
        ${hoError ? `<p class="small txt-bad" role="alert">${esc(hoError)}</p>` : ''}
        <ol class="tk-ho-rows">${h.rows.map((r, i) => hoRowHtml(r, i, editable)).join('')}</ol>
        ${say}
      </div>`;
  }

  async function makeHandoff() {
    if (!handoff || busy || !signedIn() || !mayHandOut()) return;
    const rows = toMake();
    if (!rows.length) return;
    const st = handoffStation();
    const h = handoff;
    const named = h.station.name || h.station.number || h.station.id;
    const prefix = !st && named
      ? `Station: ${h.station.name || named}${h.station.number && h.station.name ? ` (${h.station.number})` : ''} — not in Flood-Net's station list.\n\n` : '';
    const payload = rows.map(r => {
      const t = { title: line(r.title, 200), details: (prefix + r.detail).slice(0, 8000), source: 'sort', source_ref: sourceRef(r) };
      if (h.forum) t.source_date = h.forum;
      if (st) t.station_id = st.id;
      if (r.team) t.team_id = r.team;
      if (r.due) t.due_on = r.due;
      return t;
    });
    if (payload.some(t => !t.title)) { hoError = 'Every task needs a title.'; paint(); return; }
    busy = true; hoError = '';
    paint('#tk-ho-go');
    try {
      const out = await dbRpc('task_create', { p_tasks: payload });
      for (const c of out && out.created || []) {
        const r = h.rows.find(y => sourceRef(y) === c.ref);
        if (r) r.created = c.id;
      }
      for (const x of out && out.existing || []) {
        const r = h.rows.find(y => sourceRef(y) === x.ref);
        if (r && !r.created) r.existing = x;
      }
      const made = (out && out.created || []).length, had = (out && out.existing || []).length;
      note = `Made ${made} task${made === 1 ? '' : 's'} from SoRT${had ? `; ${had} had been made already` : ''}.`;
      announce(note);
      // Kept until every task is made — one left out may be for somebody
      // else to make — or until it is dismissed.
      if (h.rows.every(r => r.created || r.existing)) {
        try { sessionStorage.removeItem(HANDOFF_KEY); } catch (_) {}
      }
      await reloadList();
    } catch (err) {
      hoError = errText(err, 'make the tasks');
    }
    busy = false;
    paint('#tk-ho-dismiss');
  }

  // init.js, once, after the first render: a #tasks=… address read, taken out
  // of the address bar, and the Tasks tab opened on its review — or one kept
  // from earlier in this browser tab. And the same for one pasted into the
  // address bar of a Flood-Net already open.
  let listening = false;
  function restoreFromUrl() {
    if (typeof window === 'undefined') return;
    if (!listening) {
      listening = true;
      window.addEventListener('hashchange', () => { if (/^#tasks=/.test(location.hash || '')) restoreFromUrl(); });
    }
    const m = /^#tasks=(.*)$/.exec(location.hash || '');
    let raw = null;
    if (m) {
      raw = m[1];
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch (_) {}
    } else {
      // One kept from earlier in this browser tab — a reload, or a sign-in
      // that went to Google and back: put back, and shown on the Tasks tab
      // when it is next open, without taking the app there.
      try { raw = sessionStorage.getItem(HANDOFF_KEY); } catch (_) { raw = null; }
      if (!raw) return;
      const kept = parseHandoff(raw);
      if (kept.ok) startHandoff(kept.data);
      else { try { sessionStorage.removeItem(HANDOFF_KEY); } catch (_) {} }
      if (kept.ok && state.activeTab === 'tasks') renderMain();
      return;
    }
    const got = parseHandoff(raw);
    if (got.ok) startHandoff(got.data);
    else {
      handoff = null;
      hoError = got.why;
      try { sessionStorage.removeItem(HANDOFF_KEY); } catch (_) {}
    }
    view = 'list';
    state.activeTab = 'tasks';
    renderTabs();
    renderMain();
  }

  // ── The words, without hovering ────────────────────────────────────────────

  function glossaryHtml() {
    return `<details class="tk-fold tk-words"><summary><h2 class="bk-inline-h" id="tk-words-h">What the words on this page mean</h2></summary>
        <dl class="tk-words-list">${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(word(k))}</dd>`).join('')}</dl>
      </details>`;
  }

  // ── The tab ────────────────────────────────────────────────────────────────

  function init() {
    if (signedIn() && (forMe() || handoff) && teams === null && !loading && !missing) load();
    else if (handoff && teams) askRefs();
  }

  function authChanged() {
    teams = null; list = null; task = null; taskErr = ''; error = ''; refused = ''; missing = false;
    // Another person, or nobody: the filters start again from theirs.
    Object.assign(filt, { scope: '', status: 'live', team: '', q: '' });
    loading = false; busy = false; note = ''; refsAsked = ''; teamErr = {};
    for (const k of Object.keys(cards)) delete cards[k];
    if (handoff) for (const r of handoff.rows) { r.existing = null; r.teamPicked = false; r.notYours = false; r.include = true; }
    // …and the list: the task open was the last person's.
    view = 'list'; openId = null;
    if (state.activeTab === 'tasks') { paint(); init(); }
  }

  return {
    render, init, load, authChanged, restoreFromUrl, cardHtml, cardAsk, parseHandoff,
    WORDS, STATUS,
    filter(k, v) {
      filt[k] = v;
      if (k === 'q') { paintPart('tk-table', tableHtml()); return; }
      paint();
    },
    open(id) {
      if (state.activeTab !== 'tasks') switchTab('tasks');
      openTask(id);
    },
    back() { view = 'list'; task = null; openId = null; taskErr = ''; note = ''; paint('#tk-list-h'); },
    newTask() { view = 'new'; taskErr = ''; note = ''; paint(draft.station ? '#tk-n-title' : '#tk-n-q'); },
    newAt(stationId) {
      draft = freshDraft(stationId);
      if (state.activeTab !== 'tasks') switchTab('tasks');
      view = 'new'; taskErr = ''; note = '';
      paint('#tk-n-title');
    },
    goStation(id) { if (typeof goToStation === 'function') goToStation(id); },
    draftField(k, v) {
      draft[k] = v;
      if (k === 'general') { if (v) draft.station = ''; paint('#tk-n-general'); }
    },
    stationTyped(v) { draft.q = v; paintPart('tk-picks', picksHtml()); },
    pickStation(id) {
      draft.station = id; draft.general = false;
      if (!id) draft.q = '';
      paint(id ? '#tk-n-title' : '#tk-n-q');
    },
    create,
    updField(k, v) { upd[k] = v; },
    editField(k, v) {
      if (!task) return;
      if (!upd.edit) upd.edit = { title: task.title, details: task.details || '', due: task.due_on || '', station: task.station_id || '' };
      upd.edit[k] = v;
    },
    manageToggled(open) { if (open && !upd.edit && task) upd.edit = { title: task.title, details: task.details || '', due: task.due_on || '', station: task.station_id || '' }; },
    async save() {
      if (!task) return;
      const c = {};
      if (upd.status && upd.status !== task.status) c.status = upd.status;
      if (upd.note.trim()) c.note = upd.note.trim();
      if (!Object.keys(c).length) { taskErr = 'Nothing to save: change the status, or write a note.'; paint('#tk-u-save'); return; }
      if (c.status === 'cancelled' && !(await confirmDialog({ title: `Cancel “${task.title}”?`,
        message: 'Its team stops seeing it as something to do. It can be brought back.', confirm: 'Cancel the task', cancel: 'Keep it', danger: true }))) return;
      await change(c, c.status ? `${task.title}: ${STATUS_OF[c.status].label}.` : 'Note added.', 'tk-u-save');
    },
    async reassign() {
      if (!task) return;
      const to = upd.team === null ? (task.team_id || '') : upd.team;
      if (to === '' && !(task.may || {}).any_team) { taskErr = 'Pick the team to hand it to.'; paint('#tk-u-hand'); return; }
      if ((to || null) === (task.team_id || null)) { taskErr = 'It is with that team already.'; paint('#tk-u-hand'); return; }
      await change({ team_id: to || null }, to ? `Handed to ${teamName(to)}.` : 'Left with no team.', 'tk-u-hand');
    },
    async saveEdit() {
      if (!task || !upd.edit) return;
      const e = upd.edit, c = {};
      if (e.title.trim() !== task.title) c.title = e.title.trim();
      if (e.details !== (task.details || '')) c.details = e.details;
      if ((e.due || '') !== (task.due_on || '')) c.due_on = e.due || null;
      if ((e.station || '').trim() !== (task.station_id || '')) c.station_id = (e.station || '').trim() || null;
      if (!Object.keys(c).length) { taskErr = 'Nothing has changed.'; paint('#tk-e-save'); return; }
      await change(c, 'Changes saved.', 'tk-e-save');
    },
    memberTyped(teamId, v) { memberAdd[teamId] = v; },
    async addMember(teamId) {
      const email = String(memberAdd[teamId] || '').trim();
      if (!email) { teamErr = { ...teamErr, [teamId]: 'Whose address?' }; paint(`#tk-add-${teamId}`); return; }
      const ok = await teamCall(teamId, 'team_member_save', { p_team_id: teamId, p_email: email, p_owner: null },
        `${email} is on ${teamName(teamId)} now.`, `k:add:${teamId}`);
      if (ok) { memberAdd[teamId] = ''; paint(`k:add:${teamId}`); }
    },
    async takeOff(teamId, userId) {
      const t = teamById(teamId);
      const p = t && (t.roster || []).find(x => x.id === userId);
      if (!p) return;
      const who = p.who || p.email || 'them';
      if (!(await confirmDialog({ title: `Take ${who} off ${t.name}?`,
        message: `${who} stops seeing ${t.name}'s tasks at once. A task they made stays theirs to see.`,
        confirm: 'Take them off', danger: true }))) return;
      await teamCall(teamId, 'team_member_remove', { p_team_id: teamId, p_user_id: userId }, `${who} is off ${t.name}.`, `k:add:${teamId}`);
    },
    hoField(i, k, v) {
      const r = handoff && handoff.rows[i];
      if (!r) return;
      r[k] = v;
      if (k === 'team') { r.teamPicked = true; r.notYours = false; if (v) r.include = true; }
      if (k === 'team' || k === 'include') {
        // The count on Create follows, and the row's note.
        const el = document.getElementById('tk-handoff');
        if (el) { const key = focusKeyOf(document.activeElement); el.innerHTML = handoffHtml(); refocus(key); }
      }
    },
    makeHandoff,
    dismissHandoff() {
      handoff = null; hoError = '';
      try { sessionStorage.removeItem(HANDOFF_KEY); } catch (_) {}
      paint();
    },
    async copyHandoff() {
      if (!handoff) return;
      const url = `${location.origin}${location.pathname}#tasks=${handoff.raw}`;
      let ok = false;
      try { await navigator.clipboard.writeText(url); ok = true; } catch (_) { ok = false; }
      announce(ok ? 'The hand-off link is copied — send it to a SoRT Forum member.' : 'Copying was refused; the link is ' + url);
      if (typeof Toast !== 'undefined') Toast.show(ok ? 'Link copied.' : 'Could not copy the link here.', { kind: ok ? 'ok' : 'note' });
    },
    // For the tests: where it stands.
    _state: () => ({ view, openId, teams: !!teams, list: list ? list.length : null, handoff: handoff ? {
      session: handoff.session, forum: handoff.forum, station: { ...handoff.station },
      rows: handoff.rows.map(r => ({ ref: r.ref, title: r.title, team: r.team, include: r.include, due: r.due,
                                     created: r.created, existing: !!r.existing, notYours: !!r.notYours })) } : null,
      hoError, missing, refused }),
  };
})();
if (typeof window !== 'undefined') window.Tasks = Tasks;
