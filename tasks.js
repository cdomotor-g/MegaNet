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
//           Tags (0118): short words of people's own on a task — RTS, QA,
//           Assessment… — picked from the ones in use or typed new, shown
//           as chips with their meaning on hover, and a filter by them. The
//           Admin tab's Tags panel (admin-tags.js) renames, merges, recolours
//           and retires them.
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
    owner: 'Looks after a team\'s roster: adds and takes off its members by the address of their Flood-Net account — the one they sign in with, or a second address. An administrator names a team\'s owners. An owner may hand tasks to their own team.',
    member: 'On the team: sees its tasks, moves them on and writes notes on them.',
    sort: 'Made from the list the SoRT forum agreed for a station, handed over from SoRT\'s scope builder — the date is the forum\'s.',
    thread: 'Everything that has happened to the task, oldest first: who made it, every change of status or team, every edit and every note, with who and when.',
    mine: 'The tasks handed to a team you are on.',
    overdue: 'Past its due date and not done yet.',
    map: 'Each pin is a station with tasks that fit the filters above, coloured by the most pressing of them: overdue first, then waiting, in progress and open. The number is how many tasks are there. Pins close together on screen are drawn as one, with a dashed ring, until you zoom in.',
    tag: 'A short word put on a task to say what kind of job it is — RTS, QA, Assessment and so on. Hover one for what it means. Pick the ones in use, or type a new one: it is offered to everybody from then on.',
    newtag: 'A tag nobody has used yet. Saving the task makes it, with the meaning you give it, and offers it to everybody after.',
    second: 'Another address of the same person — an account of its own until an administrator made the two one. It does not sign in, but adding them to a team by it finds them.',
  };
  const GLOSSARY = [['task', 'Task'], ['team', 'Team'], ['status', 'Status'],
    ...STATUS.map(s => [`st:${s.key}`, s.label]),
    ['tag', 'Tag'], ['due', 'Due'], ['overdue', 'Overdue'], ['map', 'The map\'s pins'], ['unassigned', 'Unassigned'], ['handsout', 'Hands out tasks'], ['owner', 'Owner'],
    ['member', 'Member'], ['second', 'Second address'], ['sort', 'From SoRT'], ['thread', 'Thread']];
  const word = k => (k.startsWith('st:') ? (STATUS_OF[k.slice(3)] || {}).meaning : WORDS[k]) || '';

  const MAX_HANDOFF = 30;              // tasks a hand-off may carry
  const MAX_RAW = 96 * 1024;           // characters of payload read at all
  const HANDOFF_KEY = 'mn-tasks-handoff';
  const FRESH = 60000;                 // a station card's tasks, asked again after a minute

  // ── State ──────────────────────────────────────────────────────────────────
  let teams = null;        // teams_read(): { me, teams, hubs }
  let tags = null;         // tags_read(): { me, colours, tags } — or { tags: [], missing } before 0118
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
  const filt = { scope: '', status: 'live', team: '', tag: '', q: '' };
  let draft = freshDraft();
  // The open task's forms, mirrored: edit null until something in it changes.
  let upd = { status: '', note: '', edit: null, tagPick: null };
  let handoff = null;      // parseHandoff()'s data, with the review's rows
  let hoError = '';
  let refsAsked = '';      // which hand-off's references were last asked about
  const memberAdd = {};    // team id → the address being typed
  let teamErr = {};        // team id → what the database said
  const cards = {};        // station id → { at, rows, p, error }
  let listAt = 0;          // when the list was last read
  let listAsk = null;      // a read of the list for the Stations map, in flight
  const rowBusy = new Set(); // tasks a change from the list is being saved for
  let rowEdit = null;      // the task whose title is being typed in its row
  let rowNote = '';        // what the last change from the list did
  let rowErr = '';         // …or why it could not

  function freshDraft(stationId) {
    return { station: stationId || '', general: false, q: '', title: '', details: '', team: '', due: '', tagPick: freshPick([]) };
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

  // ── Tags (0118) ────────────────────────────────────────────────────────────
  // The list from tags_read(); a task carries its own as [{id, name, colour}].
  // A tag picker's state is { sel: [names], fresh: {lower name → meaning},
  // typed, err } — fresh for the names nobody has used yet, which the save
  // makes into tags.
  const TAG_MAX = 12;
  const tagsOn = () => !!tags && !tags.missing;
  const allTags = () => (tags && Array.isArray(tags.tags) ? tags.tags : []);
  const activeTags = () => allTags().filter(g => !g.retired);
  const tagByName = n => allTags().find(g => g.name.toLowerCase() === String(n || '').toLowerCase()) || null;
  const tagById = id => allTags().find(g => g.id === id) || null;
  const taskTags = t => (t && Array.isArray(t.tags) ? t.tags : []);
  function tagMeaning(g) {
    const k = g && (tagById(g.id) || tagByName(g.name));
    const m = k && k.meaning ? k.meaning : '';
    if (m) return m;
    return tags ? 'A tag people put on tasks. Nobody has said what this one means yet — an administrator can, on the Admin tab under Tags.'
      : 'A tag people put on tasks. The Tasks tab says what it means.';
  }
  const TAG_COLOURS = ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'grey'];
  const tagColour = g => {
    const k = g && (tagById(g.id) || tagByName(g.name));
    const c = (k && k.colour) || (g && g.colour) || 'grey';
    return TAG_COLOURS.includes(c) ? c : 'grey';
  };
  function tagChip(g) {
    return `<span class="tk-tag tk-tag-${tagColour(g)} term-chip" title="${escAttr(tagMeaning(g))}">${esc(g.name)}</span>`;
  }
  function tagChipsHtml(t, cls = '') {
    const ts = taskTags(t);
    return ts.length ? `<span class="tk-tags ${cls}">${ts.map(tagChip).join('')}</span>` : '';
  }
  // A name as the database keeps it: spaces closed up, trimmed.
  const cleanTag = v => String(v || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  function freshPick(names) { return { sel: [...names], fresh: {}, typed: '', err: '' }; }
  const sameTags = (a, b) => {
    const x = a.map(n => n.toLowerCase()).sort(), y = b.map(n => n.toLowerCase()).sort();
    return x.length === y.length && x.every((n, i) => n === y[i]);
  };
  // What a picker sends: a known name as the tag's own, a new one with the
  // meaning typed for it.
  function tagsPayload(p) {
    return p.sel.map(n => {
      const k = tagByName(n);
      if (k) return k.name;
      const m = String(p.fresh[n.toLowerCase()] || '').replace(/\s+/g, ' ').trim();
      return m ? { name: n, meaning: m.slice(0, 300) } : n;
    });
  }
  const pickHasNew = p => p.sel.some(n => !tagByName(n));

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
      const [t, l] = await Promise.all([dbRpc('teams_read', {}), dbRpc('task_list', {}), loadTags()]);
      teams = t && typeof t === 'object' ? t : { me: {}, teams: [] };
      list = Array.isArray(l) ? l : [];
      listAt = Date.now();
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
    listChanged();
    if (handoff) askRefs();
    if (view === 'task' && openId && !task && opening !== openId) openTask(openId);
  }

  // The tags, apart: a database without 0118 still has its tasks.
  async function loadTags() {
    try {
      const g = await dbRpc('tags_read', {});
      tags = g && typeof g === 'object' && Array.isArray(g.tags) ? g : { tags: [] };
    } catch (err) {
      tags = { tags: [], missing: true };
      if (!(err && err.status === 404)) tags.error = errTextQuiet(err);
    }
    return tags;
  }
  function errTextQuiet(err) { return err && err.message ? err.message : 'no answer'; }

  async function reloadList() {
    try {
      const l = await dbRpc('task_list', {});
      list = Array.isArray(l) ? l : list;
      listAt = Date.now();
    } catch (_) { /* the list as it was; the next load says why */ }
    for (const k of Object.keys(cards)) delete cards[k];
    listChanged();
  }
  // The Stations map's Tasks layer draws from the same list.
  function listChanged() {
    if (typeof MapTasks !== 'undefined' && MapTasks.refresh) MapTasks.refresh();
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
    if (TM.el && TM.el.parentNode) TM.el.remove();   // kept alive across the repaint (placeMap)
    el.innerHTML = render();
    placeMap();
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
      if (filt.tag === '-' && taskTags(t).length) return false;
      if (filt.tag && filt.tag !== '-' && !taskTags(t).some(g => g.id === filt.tag)) return false;
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

  // The tags worth filtering by: every one in use, and the retired ones only
  // where a task in the list still has them.
  function tagFilterOpts() {
    const used = new Set((list || []).flatMap(t => taskTags(t).map(g => g.id)));
    return allTags().filter(g => !g.retired || used.has(g.id));
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
        ${tagsOn() ? `<label>${termHtml('Tag', word('tag'))}
          <select id="tk-f-tag" onchange="Tasks.filter('tag', this.value)">
            ${opt('', 'Any tag', filt.tag)}${opt('-', 'No tag', filt.tag)}${tagFilterOpts().map(g => opt(g.id, g.retired ? `${g.name} (retired)` : g.name, filt.tag)).join('')}
          </select></label>` : ''}
        <label>Station
          <input type="search" id="tk-f-q" value="${escAttr(filt.q)}" placeholder="name or number" autocomplete="off"
                 oninput="Tasks.filter('q', this.value)"></label>
      </div>`;
  }

  // What this page offers on a row of the list — task_list() has no `may`, so
  // it is worked out the way task_may() does (0095); the database still
  // decides. Its team moves it on; whoever manages it (hands out tasks, made
  // it, owns its team) also hands it over and changes its words and date.
  const rowManage = t => handsOut() || !!t.by_me || (!!t.team_id && owns().includes(t.team_id));
  const rowWork = t => !!t.my_team || rowManage(t);
  // The teams a row may be handed to: any, for somebody who hands out tasks;
  // otherwise their own, and the one it has now (shown, not picked).
  function rowTeamsHtml(t) {
    const cur = t.team_id || '';
    const all = (teams && teams.teams || []);
    const may = handsOut() ? all : all.filter(x => owns().includes(x.id) || x.id === cur);
    if (!may.some(x => x.id !== cur)) return '';
    const none = handsOut() || !cur
      ? `<option value=""${!cur ? ' selected' : ''}${handsOut() ? '' : ' disabled'}>${cur ? 'No team (unassign)' : 'Unassigned — pick a team'}</option>` : '';
    return none + may.map(x => `<option value="${escAttr(x.id)}"${x.id === cur ? ' selected' : ''}${!handsOut() && !owns().includes(x.id) ? ' disabled' : ''}>${esc(x.name)}</option>`).join('');
  }
  function rowStatusHtml(t) {
    const m = rowManage(t);
    return STATUS.filter(s => s.key === t.status || m || (s.key !== 'cancelled' && t.status !== 'cancelled'))
      .map(s => `<option value="${s.key}"${s.key === t.status ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
  }
  // Every control in a row keeps its click to itself, so changing one does
  // not open the task.
  const STAY = 'onclick="event.stopPropagation()" onkeydown="event.stopPropagation()"';

  function rowHtml(t) {
    const id = escAttr(t.id);
    const busyRow = rowBusy.has(t.id);
    const dis = busyRow ? ' disabled' : '';
    const st = t.station_id ? `<button type="button" class="link-btn" onclick="event.stopPropagation(); Tasks.goStation('${escAttr(t.station_id)}')">${esc(stationLabel(t.station_id))}</button>`
      : '<span class="txt-muted">General</span>';
    const manage = rowManage(t);
    const label = esc(t.title);
    // The team: a picker for whoever may hand it over, the name for anybody else.
    const teamOpts = manage ? rowTeamsHtml(t) : '';
    const team = teamOpts
      ? `<select class="tk-cell-sel${t.team_id ? '' : ' tk-unassigned'}" data-k="team:${id}" aria-label="Team for ${escAttr(t.title)}"${dis} ${STAY}
            onchange="Tasks.rowSet('${id}', 'team_id', this.value)">${teamOpts}</select>`
      : t.team_id ? esc(t.team || teamName(t.team_id)) : termHtml('Unassigned', word('unassigned'));
    const status = rowWork(t)
      ? `<select class="tk-cell-sel tk-st-sel tk-st-${escAttr(t.status)}" data-k="status:${id}" aria-label="Status of ${escAttr(t.title)}"
            title="${escAttr((STATUS_OF[t.status] || {}).meaning || '')}"${dis} ${STAY}
            onchange="Tasks.rowSet('${id}', 'status', this.value)">${rowStatusHtml(t)}</select>`
      : statusChip(t.status);
    const late = isLate(t) ? ' <span class="tk-late"><strong>overdue</strong></span>' : '';
    const due = manage
      ? `<input type="date" class="tk-cell-date" data-k="due:${id}" value="${escAttr(t.due_on || '')}" aria-label="Due date for ${escAttr(t.title)}"${dis} ${STAY}
            onchange="Tasks.rowSet('${id}', 'due_on', this.value)">${late}`
      : dueHtml(t);
    const from = t.source === 'sort'
      ? ` <span class="tk-src term-chip" title="${esc(word('sort'))}">SoRT${t.source_date ? ' ' + esc(dmy(t.source_date)) : ''}</span>` : '';
    const title = rowEdit === t.id
      ? `<input type="text" class="tk-cell-title" data-k="title:${id}" maxlength="200" value="${escAttr(t.title)}" aria-label="New title"${dis} onclick="event.stopPropagation()"
            onkeydown="event.stopPropagation(); Tasks.titleKey(event, '${id}', this)" onblur="Tasks.titleDone('${id}', this.value)">`
      : `<button type="button" class="row-open" data-k="open:${id}" onclick="event.stopPropagation(); Tasks.open('${id}')">${label}</button>${
          manage ? ` <button type="button" class="tk-rename" data-k="rename:${id}" title="Rename it here" aria-label="Rename ${escAttr(t.title)}"${dis}
            onclick="event.stopPropagation(); Tasks.rename('${id}')">✎</button>` : ''}`;
    return `<tr class="row-link${busyRow ? ' is-busy' : ''}" onclick="Tasks.open('${id}')">
        <th scope="row">${title}${from}
          ${t.notes ? `<span class="small txt-muted"> · ${Number(t.notes)} note${Number(t.notes) === 1 ? '' : 's'}</span>` : ''}${
          taskTags(t).length ? `<div class="tk-row-tags">${tagChipsHtml(t)}</div>` : ''}</th>
        <td>${st}</td>
        <td>${team}</td>
        <td>${status}</td>
        <td>${due}</td>
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
    const editable = rows.some(rowWork);
    return `<p class="small txt-muted" role="status">${rows.length} of ${total} task${total === 1 ? '' : 's'}${editable
        ? ' · change a team, status or due date right in its row (✎ renames it); open a task for its details and thread' : ''}</p>
      ${rowNote ? `<p class="small txt-ok" role="status">${esc(rowNote)}</p>` : ''}
      ${rowErr ? `<p class="small txt-bad" role="alert">${esc(rowErr)}</p>` : ''}
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
    if (list) body += filtersHtml() + mapSlotHtml() + `<div id="tk-table">${tableHtml()}</div>`;
    return `<div class="panel" aria-labelledby="tk-list-h">${head}${body}</div>`;
  }

  // ── The map ────────────────────────────────────────────────────────────────
  // Where the tasks in the list are: a pin per station, coloured by its most
  // pressing task, with how many on a badge. The same pins, from the same
  // functions, are the Stations map's Tasks layer (map-tasks.js), so the two
  // never disagree about what a colour means.
  //
  // The page is repainted whole on most changes (paint), and a Leaflet map
  // torn down and built again on every filter would lose where somebody had
  // zoomed to. So the map's element is made once and kept: paint() lifts it
  // out before the repaint and placeMap() puts it into the new #tk-map-slot,
  // tells Leaflet its size, and draws the pins for what the filters now pick.
  // Leaving the tab takes it down (the teardown init() registers).

  // The colours, most pressing first. A station's pin takes the first of
  // these any of its tasks is.
  const PINS = [
    { key: 'late',        label: 'Overdue',     meaning: 'At least one task here is past its due date and not done yet.' },
    { key: 'waiting',     label: 'Waiting',     meaning: `At least one task here is waiting: ${STATUS_OF.waiting.meaning}` },
    { key: 'in_progress', label: 'In progress', meaning: 'At least one task here is being worked on, and none is overdue or waiting.' },
    { key: 'open',        label: 'Open',        meaning: 'The tasks here are handed to a team and not started yet.' },
    { key: 'done',        label: 'Finished',    meaning: 'Every task here that fits the filters is done or cancelled.' },
  ];
  const PIN_RANK = Object.fromEntries(PINS.map((p, i) => [p.key, i]));
  const MAP_MERGE_PX = 34;     // pins closer than this on screen are drawn as one
  const TM = { el: null, map: null, layer: null, groups: [], fitKey: '', unplaced: 0 };

  const placed = s => !!s && s.lat != null && s.lon != null && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon));
  const isLate = t => LIVE.includes(t.status) && !!t.due_on && t.due_on < today();
  function pinKeyOf(t) {
    if (isLate(t)) return 'late';
    return LIVE.includes(t.status) ? t.status : 'done';
  }
  const worse = (a, b) => (PIN_RANK[a] <= PIN_RANK[b] ? a : b);

  // Tasks → one group a station: { id, name, lat, lon, tasks, n, key }.
  // `unplaced` counts the tasks with no station, or a station with no place.
  function stationGroups(rows) {
    const by = new Map();
    let unplaced = 0;
    for (const t of rows || []) {
      const st = t && t.station_id ? stationOf(t.station_id) : null;
      if (!placed(st)) { unplaced++; continue; }
      let g = by.get(st.id);
      if (!g) { g = { id: st.id, name: stationLabel(st.id), lat: Number(st.lat), lon: Number(st.lon), tasks: [], key: 'done' }; by.set(st.id, g); }
      g.tasks.push(t);
      g.key = worse(g.key, pinKeyOf(t));
    }
    const groups = [...by.values()];
    for (const g of groups) {
      g.n = g.tasks.length;
      g.tasks.sort((a, b) => PIN_RANK[pinKeyOf(a)] - PIN_RANK[pinKeyOf(b)] || String(a.due_on || '9').localeCompare(String(b.due_on || '9')));
    }
    // The most pressing drawn last, so on top.
    groups.sort((a, b) => PIN_RANK[b.key] - PIN_RANK[a.key]);
    return { groups, unplaced };
  }

  // Groups that would overlap on screen at the map's zoom, drawn as one — in
  // the order given, so the same list and zoom always merge the same way. A
  // merged pin is { many: true, members, n, key, lat, lon }.
  function mergeOnScreen(map, groups, px = MAP_MERGE_PX) {
    const out = [];
    for (const g of groups) {
      const p = map.latLngToLayerPoint([g.lat, g.lon]);
      const m = out.find(o => Math.hypot(o.p.x - p.x, o.p.y - p.y) <= px);
      if (m) { m.members.push(g); continue; }
      out.push({ p, members: [g] });
    }
    return out.map(o => {
      if (o.members.length === 1) return o.members[0];
      const ms = o.members;
      return {
        many: true, members: ms, n: ms.reduce((a, g) => a + g.n, 0),
        key: ms.reduce((k, g) => worse(k, g.key), 'done'),
        lat: ms.reduce((a, g) => a + g.lat, 0) / ms.length,
        lon: ms.reduce((a, g) => a + g.lon, 0) / ms.length,
      };
    });
  }

  // The pin: a ring round the station and a badge standing up and right off
  // it, so the station's own pin is never covered. Colours are the page's
  // tokens, through the class (styles.css, .mn-task-*).
  function pinIcon(g, { ring = true } = {}) {
    const cls = `mn-task-pin mn-task-${g.key}${g.many ? ' mn-task-many' : ''}`;
    return L.divIcon({
      className: 'mn-task-icon',
      html: `<span class="${cls}">${ring ? '<i class="mn-task-ring" aria-hidden="true"></i>' : ''}<span class="mn-task-badge"><span aria-hidden="true">✅</span><b>${g.n}</b></span></span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }
  function pinTitle(g) {
    const what = (PINS.find(p => p.key === g.key) || {}).label || '';
    if (g.many) return `${g.n} task${g.n === 1 ? '' : 's'} at ${g.members.length} stations close together (the most pressing ${what.toLowerCase()}) — zoom in to tell them apart`;
    const first = g.tasks.slice(0, 3).map(t => `${t.title} (${isLate(t) ? 'overdue' : (STATUS_OF[t.status] || { label: t.status }).label.toLowerCase()})`).join('; ');
    return `${g.name} — ${g.n} task${g.n === 1 ? '' : 's'}: ${first}${g.n > 3 ? `; and ${g.n - 3} more` : ''}`;
  }
  // What pressing a single station's pin shows: its tasks, each opening.
  function pinPopupHtml(g, { card = false } = {}) {
    const rows = g.tasks.map(t => `<li><button type="button" class="link-btn" onclick="Tasks.open('${escAttr(t.id)}')">${esc(t.title)}</button>
        ${statusChip(t.status)}${isLate(t) ? ' <span class="tk-late"><strong>overdue</strong></span>' : ''}
        <span class="small txt-muted">· ${t.team_id ? esc(t.team || teamName(t.team_id)) : 'no team yet'}</span>${tagChipsHtml(t, 'tk-pop-tags')}</li>`).join('');
    return `<div class="tk-pop"><strong>${esc(g.name)}</strong>
        <ul class="tk-pop-list">${rows}</ul>
        ${card ? '' : `<button type="button" class="link-btn small" onclick="Tasks.goStation('${escAttr(g.id)}')">Open the station on the Stations map</button>`}</div>`;
  }
  // The key under a map: a swatch and its word for each colour, the word
  // saying on hover what it means (and the page's fold says it again).
  function keyHtml(keys) {
    const want = keys ? PINS.filter(p => keys.includes(p.key)) : PINS;
    return want.map(p => `<span class="tk-key-item"><i class="tk-key-sw mn-task-${p.key}" aria-hidden="true"></i>${termHtml(p.label, p.meaning)}</span>`).join('')
      + `<span class="tk-key-item"><i class="tk-key-sw mn-task-many" aria-hidden="true"></i>${termHtml('Several stations', 'Pins close together on screen, drawn as one until you zoom in. The number is all their tasks; pressing it zooms in to them.')}</span>`;
  }

  // The whole list, for the Stations map's Tasks layer: the one this tab read
  // if it is fresh, otherwise asked for again (once, however many ask).
  function mapRows() {
    if (!forMe() || typeof dbRpc !== 'function') return Promise.resolve(null);
    if (list && Date.now() - listAt < FRESH) return Promise.resolve(list);
    if (listAsk) return listAsk;
    if (!tags) loadTags().then(() => listChanged());
    listAsk = dbRpc('task_list', {})
      .then(l => { if (Array.isArray(l)) { list = l; listAt = Date.now(); } return list || []; })
      .finally(() => { listAsk = null; });
    return listAsk;
  }

  function mapSlotHtml() {
    return `<div class="tk-map-wrap">
        <div id="tk-map-slot" class="tk-map-slot" role="region" aria-label="Map of where the tasks are"></div>
        <div class="tk-key small" id="tk-map-key">${keyHtml()}</div>
        <p class="small txt-muted" id="tk-map-note" role="status"></p>
      </div>`;
  }

  // Scroll to zoom: the mouse wheel zooms the map (on unless switched off,
  // and remembered on this device), or, switched off, scrolls the page past
  // it. A button under + and −, pressed or not (aria-pressed).
  const WHEEL_KEY = 'mn-tasks-map-wheel';
  function wheelOn() {
    try { return localStorage.getItem(WHEEL_KEY) !== 'off'; } catch (_) { return true; }
  }
  function wheelTitle(on) {
    return on ? 'Scroll to zoom is on: the mouse wheel zooms the map. Press to have the wheel scroll the page instead.'
      : 'Scroll to zoom is off: the mouse wheel scrolls the page. Press to have it zoom the map.';
  }
  function wheelControl() {
    const C = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const box = L.DomUtil.create('div', 'leaflet-bar tk-wheel');
        const b = L.DomUtil.create('button', 'tk-wheel-btn', box);
        b.type = 'button';
        b.id = 'tk-map-wheel';
        b.innerHTML = '<span aria-hidden="true">🖱️</span><span class="sr-only">Scroll to zoom</span>';
        const paintBtn = () => {
          const on = wheelOn();
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          b.title = wheelTitle(on);
          b.classList.toggle('is-on', on);
        };
        paintBtn();
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.on(b, 'click', () => {
          const on = !wheelOn();
          try { localStorage.setItem(WHEEL_KEY, on ? 'on' : 'off'); } catch (_) { /* this session only */ }
          if (TM.map) { if (on) TM.map.scrollWheelZoom.enable(); else TM.map.scrollWheelZoom.disable(); }
          paintBtn();
          if (typeof announce === 'function') announce(on ? 'Scroll to zoom on.' : 'Scroll to zoom off: the wheel scrolls the page.');
        });
        return box;
      },
    });
    return new C();
  }

  function stopMap() {
    if (TM.map) TM.map = removeMap(TM.map);
    if (TM.el && TM.el.parentNode) TM.el.remove();
    TM.el = null; TM.layer = null; TM.groups = []; TM.fitKey = '';
  }

  function placeMap() {
    if (typeof document === 'undefined' || state.activeTab !== 'tasks') return;
    const slot = document.getElementById('tk-map-slot');
    if (!slot || typeof L === 'undefined') return;
    if (!TM.el) {
      TM.el = document.createElement('div');
      TM.el.id = 'tk-map';
      TM.el.className = 'tk-map';
    }
    slot.appendChild(TM.el);
    if (!TM.map) {
      TM.map = L.map(TM.el, { scrollWheelZoom: wheelOn(), zoomControl: true }).setView([-24, 147], 5);
      wheelControl().addTo(TM.map);
      if (typeof registerLiveMap === 'function') registerLiveMap('Tasks', () => TM.map);
      if (typeof addBaseLayers === 'function') addBaseLayers(TM.map);
      TM.layer = L.layerGroup().addTo(TM.map);
      TM.map.on('zoomend', () => drawPins());
    } else {
      TM.map.invalidateSize();
    }
    drawMap();
  }

  // The pins for what the filters pick, and the map fitted to them when that
  // set of stations changes.
  function drawMap() {
    if (!TM.map) return;
    const { groups, unplaced } = stationGroups(scoped());
    TM.groups = groups; TM.unplaced = unplaced;
    const key = groups.map(g => g.id).sort().join(',');
    if (key !== TM.fitKey) {
      TM.fitKey = key;
      if (groups.length === 1) TM.map.setView([groups[0].lat, groups[0].lon], 11);
      else if (groups.length) { try { TM.map.fitBounds(groups.map(g => [g.lat, g.lon]), { padding: [36, 36], maxZoom: 11 }); } catch (_) { /* not sized yet */ } }
    }
    drawPins();
    const n = groups.reduce((a, g) => a + g.n, 0);
    const el = document.getElementById('tk-map-note');
    if (el) {
      el.textContent = (groups.length
        ? `${n} task${n === 1 ? '' : 's'} at ${groups.length} station${groups.length === 1 ? '' : 's'} on the map. Press a pin for its tasks.`
        : 'No task picked above is at a station on the map.')
        + (unplaced ? ` ${unplaced} ${unplaced === 1 ? 'is' : 'are'} not on it: general tasks, or a station with no position.` : '');
    }
  }
  function drawPins() {
    if (!TM.map || !TM.layer) return;
    TM.layer.clearLayers();
    for (const g of mergeOnScreen(TM.map, TM.groups)) {
      const m = L.marker([g.lat, g.lon], { icon: pinIcon(g), keyboard: true, riseOnHover: true, title: pinTitle(g), alt: pinTitle(g) });
      if (g.many) {
        m.on('click', () => { try { TM.map.fitBounds(g.members.map(x => [x.lat, x.lon]), { padding: [48, 48], maxZoom: 13 }); } catch (_) { /* gone */ } });
      } else {
        m.bindPopup(() => pinPopupHtml(g), { maxWidth: 320 });
      }
      m.addTo(TM.layer);
    }
  }

  // ── One task ───────────────────────────────────────────────────────────────

  function threadEntryHtml(n) {
    const who = `<strong>${esc(n.you ? 'You' : n.who || 'Somebody')}</strong>`;
    let what;
    if (n.kind === 'created') what = n.to ? `${who} made it, for ${esc(n.to)}` : `${who} made it, with no team yet`;
    else if (n.kind === 'status') what = `${who} moved it from ${statusChip(n.from)} to ${statusChip(n.to)}`;
    else if (n.kind === 'team') what = `${who} handed it from ${esc(n.from || 'no team')} to ${esc(n.to || 'no team')}`;
    else if (n.kind === 'edit') what = `${who} changed its ${esc(n.to || 'words')}`;
    else if (n.kind === 'tags') {
      const split = v => String(v || '').split(', ').filter(Boolean);
      const was = split(n.from), now = split(n.to);
      const low = a => new Set(a.map(x => x.toLowerCase()));
      const lw = low(was), ln = low(now);
      const added = now.filter(x => !lw.has(x.toLowerCase())), gone = was.filter(x => !ln.has(x.toLowerCase()));
      const names = a => a.map(x => tagChip({ name: x })).join(' ');
      const parts = [added.length ? `tagged it ${names(added)}` : '', gone.length ? `took off ${names(gone)}` : ''].filter(Boolean);
      what = `${who} ${parts.length ? parts.join(' and ') : 'left its tags as they were'}`;
    }
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
      ...(tagsOn() || taskTags(t).length ? [[termHtml('Tags', word('tag')), tagChipsHtml(t) || '<span class="txt-muted">None</span>']] : []),
      ['From', t.source === 'sort' ? `<span class="tk-src term-chip" title="${esc(word('sort'))}">SoRT</span>${t.source_date ? ` forum of ${esc(dmy(t.source_date))}` : ''}` : 'Flood-Net'],
      ['Made', `${esc(t.by_me ? 'by you' : `by ${t.created_by || 'somebody no longer here'}`)} on ${esc(when(t.created_at))}`],
    ];
    const work = may.work || may.manage;
    // Whoever manages it changes everything in one form, always in view; its
    // team alone moves it on and writes on it.
    const updForm = may.manage ? editHtml(t) : work ? `<form class="tk-form" onsubmit="event.preventDefault(); Tasks.save()">
        <h3 id="tk-upd-h">Move it on</h3>
        <div class="control-row">
          <label>${termHtml('Status', word('status'))}
            <select id="tk-u-status" onchange="Tasks.updField('status', this.value)"${busy ? ' disabled' : ''}>${statusOptions(t)}</select></label>
        </div>
        ${tagPickerWrap('work')}
        <label class="tk-wide">A note for the thread (optional)
          <textarea id="tk-u-note" rows="3" maxlength="4000" oninput="Tasks.updField('note', this.value)"${busy ? ' disabled' : ''}>${esc(upd.note)}</textarea></label>
        <div class="button-group"><button type="submit" class="primary" id="tk-u-save"${busy ? ' disabled' : ''}>Save</button></div>
      </form>` : '<p class="small txt-muted">Only the team it is handed to, or whoever manages it, moves it on.</p>';
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
        <h3 id="tk-thread-h">${termHtml('Thread', word('thread'))}</h3>
        ${thread}
      </div>`;
  }

  function seedEdit(t) {
    return { title: t.title, details: t.details || '', due: t.due_on || '', station: t.station_id || '',
             team: t.team_id || '', status: t.status, picking: false, q: '',
             tagPick: freshPick(taskTags(t).map(g => g.name)) };
  }

  function editPicksHtml(e) {
    if (!e.q.trim()) return '';
    const hits = stationMatches(e.q);
    if (!hits.length) return '<p class="small txt-muted" role="status">No station by that name or number.</p>';
    return `<ul class="tk-picks" aria-label="Matching stations">${hits.map(s =>
      `<li><button type="button" class="link-btn" data-k="epick:${escAttr(s.id)}" onclick="Tasks.editPick('${escAttr(s.id)}')">${esc(s.name)}${s.station_number ? ` <span class="txt-muted">${esc(s.station_number)}</span>` : ''}</button></li>`).join('')}</ul>`;
  }

  // Everything whoever manages a task may change, in one form: who has it,
  // how far it has got, when it is due, its words and its station, and a note
  // for the thread — one Save, one task_update().
  function editHtml(t) {
    const may = t.may || {};
    const e = upd.edit || seedEdit(t);
    const only = may.any_team ? null : (Array.isArray(may.owns) ? may.owns : []);
    const dis = busy ? ' disabled' : '';
    const statusOpts = STATUS.map(s => `<option value="${s.key}"${s.key === e.status ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
    const station = e.picking
      ? `<label class="tk-wide">Station — its name or number
          <input type="search" id="tk-e-q" value="${escAttr(e.q)}" autocomplete="off" oninput="Tasks.editStationTyped(this.value)"${dis}></label>
        <div id="tk-e-picks">${editPicksHtml(e)}</div>
        <p class="small"><button type="button" class="link-btn" id="tk-e-general" onclick="Tasks.editPick('')">Make it a general task, at no one station</button>
          · <button type="button" class="link-btn" id="tk-e-keep" onclick="Tasks.editPick(null)">Keep ${e.station ? esc(stationLabel(e.station)) : 'it general'}</button></p>`
      : `<div class="tk-wide"><span>Station</span>
          <span class="tk-picked">${e.station ? esc(stationLabel(e.station)) : '<span class="txt-muted">None — a general task</span>'}
          <button type="button" class="link-btn" id="tk-e-station" onclick="Tasks.editPicking()"${dis}>Change</button></span></div>`;
    return `<section class="tk-edit" id="tk-manage" aria-labelledby="tk-edit-h">
        <h3 id="tk-edit-h">Change this task</h3>
        <p class="small txt-muted">Hand it to a team, move it on, change its date or its words — then Save. Every change goes in the thread.</p>
        <form class="tk-form" onsubmit="event.preventDefault(); Tasks.saveEdit()">
          <div class="control-row">
            <label>${termHtml('Team', word('team'))}
              <select id="tk-e-team" onchange="Tasks.editField('team', this.value)"${dis}>${teamOptions(e.team, { none: !!may.any_team, only })}</select></label>
            <label>${termHtml('Status', word('status'))}
              <select id="tk-e-status" onchange="Tasks.editField('status', this.value)"${dis}>${statusOpts}</select></label>
            <label>${termHtml('Due', word('due'))}
              <input type="date" id="tk-e-due" value="${escAttr(e.due)}" onchange="Tasks.editField('due', this.value)"${dis}></label>
          </div>
          ${only ? '<p class="small txt-muted">You may hand it to your own team; somebody who hands out tasks gives it to any other.</p>' : ''}
          <label class="tk-wide">Title
            <input type="text" id="tk-e-title" maxlength="200" value="${escAttr(e.title)}" oninput="Tasks.editField('title', this.value)"${dis}></label>
          ${tagPickerWrap('edit')}
          <label class="tk-wide">Details
            <textarea id="tk-e-details" rows="4" maxlength="8000" oninput="Tasks.editField('details', this.value)"${dis}>${esc(e.details)}</textarea></label>
          ${station}
          <label class="tk-wide">A note for the thread (optional)
            <textarea id="tk-e-note" rows="2" maxlength="4000" oninput="Tasks.updField('note', this.value)"${dis}>${esc(upd.note)}</textarea></label>
          <div class="button-group">
            <button type="submit" class="primary" id="tk-e-save"${dis}>Save</button>
            <button type="button" class="ghost" id="tk-e-reset" onclick="Tasks.editReset()"${dis}>Undo my changes</button>
          </div>
        </form>
      </section>`;
  }

  async function openTask(id) {
    openId = id; view = 'task'; taskErr = '';
    if (!task || task.id !== id) { task = null; upd = { status: '', note: '', edit: null, tagPick: null }; }
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
      if (Array.isArray(p_change.tags) && p_change.tags.some(x => typeof x === 'object' || !tagByName(x))) await loadTags();
      upd = { status: '', note: '', edit: null, tagPick: null };
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

  // ── Changing a task from its row in the list ──────────────────────────────
  // The same task_update() the open task uses, for one field at a time; the
  // row takes the answer, and the table alone is drawn again, focus going
  // back to the control it was on.

  function paintTable(focusKey) {
    if (typeof document === 'undefined' || state.activeTab !== 'tasks' || view !== 'list') return;
    const el = document.getElementById('tk-table');
    if (!el) return;
    const had = focusKey || (el.contains(document.activeElement) ? focusKeyOf(document.activeElement) : null);
    el.innerHTML = tableHtml();
    refocus(had);
  }

  async function rowChange(id, p_change, said, focusKey) {
    const t = (list || []).find(x => x.id === id);
    if (!t || rowBusy.has(id)) return;
    rowBusy.add(id); rowErr = ''; rowNote = ''; note = '';
    paintTable(focusKey);
    try {
      const out = await dbRpc('task_update', { p_id: id, p_change });
      if (out && typeof out === 'object') {
        const { details, may, thread, ...rest } = out;
        Object.assign(t, rest);
        if (task && task.id === id) task = out;
      }
      const gone = !scoped().some(x => x.id === id);
      rowNote = said + (gone ? ' It no longer fits the filters above, so it has left the list.' : '');
      announce(rowNote);
      for (const k of Object.keys(cards)) delete cards[k];
    } catch (err) {
      rowErr = errText(err, 'save that');
    }
    rowBusy.delete(id);
    paintTable(focusKey);
    drawMap();
    listChanged();
  }

  async function rowSet(id, key, value) {
    const t = (list || []).find(x => x.id === id);
    if (!t) return;
    const fk = `k:${key === 'team_id' ? 'team' : key === 'due_on' ? 'due' : 'status'}:${id}`;
    if (key === 'team_id') {
      const to = value || null;
      if (to === (t.team_id || null)) return;
      return rowChange(id, { team_id: to }, to ? `${t.title}: handed to ${teamName(to)}.` : `${t.title}: left with no team.`, fk);
    }
    if (key === 'status') {
      if (!STATUS_OF[value] || value === t.status) return;
      if (value === 'cancelled' && !(await confirmDialog({ title: `Cancel “${t.title}”?`,
        message: 'Its team stops seeing it as something to do. It can be brought back.', confirm: 'Cancel the task', cancel: 'Keep it', danger: true }))) {
        paintTable(fk);          // the picker back to what it was
        return;
      }
      return rowChange(id, { status: value }, `${t.title}: ${STATUS_OF[value].label}.`, fk);
    }
    if (key === 'due_on') {
      const to = value || null;
      if (to === (t.due_on || null)) return;
      if (to && !validDate(to)) { rowErr = 'That is not a date.'; paintTable(fk); return; }
      return rowChange(id, { due_on: to }, to ? `${t.title}: due ${dmy(to)}.` : `${t.title}: no due date now.`, fk);
    }
  }

  // ── The tag picker ─────────────────────────────────────────────────────────
  // One on each form that may change a task's tags: a new task ('new'), the
  // form whoever manages it uses ('edit') and its team's Move it on ('work').
  // Every tag in use is a button, pressed or not; the box under them takes a
  // name — one in use, offered as it is typed, or a new one, which asks what
  // it means. Drawn into its own wrapper, so a press repaints the picker
  // alone and nothing typed elsewhere in the form is touched.

  function pickerOf(ctx) {
    if (ctx === 'new') { if (!draft.tagPick) draft.tagPick = freshPick([]); return draft.tagPick; }
    if (!task) return null;
    if (ctx === 'edit') { if (!upd.edit) upd.edit = seedEdit(task); return upd.edit.tagPick; }
    if (!upd.tagPick) upd.tagPick = freshPick(taskTags(task).map(g => g.name));
    return upd.tagPick;
  }

  function tagPickerWrap(ctx) {
    if (!tagsOn()) return '';
    return `<div class="tk-tags-pick" id="tk-tags-${ctx}">${tagPickerHtml(ctx)}</div>`;
  }

  function tagPickerHtml(ctx) {
    const p = pickerOf(ctx);
    if (!p) return '';
    const dis = busy ? ' disabled' : '';
    const on = new Set(p.sel.map(n => n.toLowerCase()));
    // Every tag in use, the retired ones this task still has, and the new
    // ones picked — A to Z.
    const shown = [...activeTags(), ...allTags().filter(g => g.retired && on.has(g.name.toLowerCase()))]
      .map(g => ({ name: g.name, colour: g.colour, id: g.id, retired: g.retired, isNew: false }));
    for (const n of p.sel) if (!tagByName(n)) shown.push({ name: n, colour: 'grey', isNew: true });
    shown.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const btns = shown.map(g => {
      const pressed = on.has(g.name.toLowerCase());
      const tip = g.isNew ? word('newtag') : `${tagMeaning(g)}${g.retired ? ' (Retired: no longer offered for new tasks.)' : ''}`;
      return `<button type="button" class="tk-tag tk-tag-${g.isNew ? 'new' : tagColour(g)} tk-tag-opt${pressed ? ' is-on' : ''}" aria-pressed="${pressed}"
          data-k="tag:${ctx}:${escAttr(g.name.toLowerCase())}" data-name="${escAttr(g.name)}" title="${escAttr(tip)}"${dis}
          onclick="Tasks.tagToggle('${ctx}', this.dataset.name)"><span aria-hidden="true">${pressed ? '✓' : '+'}</span> ${esc(g.name)}${g.isNew ? ' <em>new</em>' : ''}</button>`;
    }).join('');
    const offer = activeTags().filter(g => !on.has(g.name.toLowerCase()));
    const typed = cleanTag(p.typed);
    const typedNew = typed && !tagByName(typed) && !on.has(typed.toLowerCase());
    const fresh = p.sel.filter(n => !tagByName(n));
    return `<div class="tk-tags-h small">${termHtml('Tags', word('tag'))} <span class="txt-muted">— press one to put it on or take it off${p.sel.length ? ` · ${p.sel.length} on` : ''}</span></div>
        <div class="tk-tag-opts" role="group" aria-label="Tags">${btns || '<span class="small txt-muted">No tags yet — type the first below.</span>'}</div>
        <div class="tk-tag-add">
          <label class="small">Another tag — one in use, or a new one
            <input type="text" id="tk-tag-in-${ctx}" list="tk-tag-names-${ctx}" maxlength="30" autocomplete="off" spellcheck="false"
                   value="${escAttr(p.typed)}" placeholder="e.g. RTS"${dis}
                   oninput="Tasks.tagTyped('${ctx}', this.value)" onkeydown="if (event.key === 'Enter') { event.preventDefault(); Tasks.tagAdd('${ctx}'); }"></label>
          <datalist id="tk-tag-names-${ctx}">${offer.map(g => `<option value="${escAttr(g.name)}"${g.meaning ? ` label="${escAttr(g.meaning)}"` : ''}></option>`).join('')}</datalist>
          <button type="button" class="exp-btn-sm" id="tk-tag-go-${ctx}"${dis} onclick="Tasks.tagAdd('${ctx}')">Add</button>
        </div>
        <p class="small txt-muted" id="tk-tag-hint-${ctx}" role="status">${typedNew ? `“${esc(typed)}” is a ${termHtml('new tag', word('newtag'))}: Add puts it on, and saving makes it.` : ''}</p>
        ${fresh.map(n => `<label class="tk-wide">What “${esc(n)}” means — say it for everybody (optional)
            <input type="text" data-k="tagmean:${ctx}:${escAttr(n.toLowerCase())}" data-name="${escAttr(n)}" maxlength="300"
                   value="${escAttr(p.fresh[n.toLowerCase()] || '')}" placeholder="e.g. Return to service: getting a station working again"${dis}
                   oninput="Tasks.tagMeaningTyped('${ctx}', this.dataset.name, this.value)"></label>`).join('')}
        ${p.err ? `<p class="small txt-bad" role="alert">${esc(p.err)}</p>` : ''}`;
  }

  function repaintPicker(ctx, focusKey) {
    const el = document.getElementById(`tk-tags-${ctx}`);
    if (!el) return;
    const had = focusKey || (el.contains(document.activeElement) ? focusKeyOf(document.activeElement) : null);
    el.innerHTML = tagPickerHtml(ctx);
    refocus(had);
  }

  function tagToggle(ctx, name) {
    const p = pickerOf(ctx);
    if (!p || !name) return;
    const k = name.toLowerCase();
    p.err = '';
    if (p.sel.some(n => n.toLowerCase() === k)) {
      p.sel = p.sel.filter(n => n.toLowerCase() !== k);
      delete p.fresh[k];
      announce(`${name} taken off.`);
    } else {
      if (p.sel.length >= TAG_MAX) { p.err = `At most ${TAG_MAX} tags on a task.`; repaintPicker(ctx); return; }
      p.sel.push((tagByName(name) || { name }).name);
      announce(`${name} put on.`);
    }
    repaintPicker(ctx, `k:tag:${ctx}:${k}`);
  }

  function tagAdd(ctx) {
    const p = pickerOf(ctx);
    if (!p) return;
    const name = cleanTag(p.typed);
    p.err = '';
    if (!name) { p.err = 'Type a tag first — one in use, or a new one.'; repaintPicker(ctx, `#tk-tag-in-${ctx}`); return; }
    if (name.length > 30) { p.err = 'A tag is at most 30 characters.'; repaintPicker(ctx, `#tk-tag-in-${ctx}`); return; }
    if (name.includes(',')) { p.err = 'A tag has no comma — make two tags instead.'; repaintPicker(ctx, `#tk-tag-in-${ctx}`); return; }
    const known = tagByName(name);
    const want = known ? known.name : name;
    if (!p.sel.some(n => n.toLowerCase() === want.toLowerCase())) {
      if (p.sel.length >= TAG_MAX) { p.err = `At most ${TAG_MAX} tags on a task.`; repaintPicker(ctx, `#tk-tag-in-${ctx}`); return; }
      p.sel.push(want);
    }
    p.typed = '';
    announce(known ? `${want} put on.` : `${want} put on — a new tag, made when you save.`);
    // A new one asks what it means next.
    repaintPicker(ctx, known ? `#tk-tag-in-${ctx}` : `k:tagmean:${ctx}:${want.toLowerCase()}`);
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
          ${tagPickerWrap('new')}
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
    const pick = draft.tagPick;
    if (tagsOn() && pick && pick.sel.length) t.tags = tagsPayload(pick);
    const madeNew = !!(t.tags && pickHasNew(pick));
    busy = true; paint('#tk-n-go');
    try {
      const out = await dbRpc('task_create', { p_tasks: [t] });
      const made = out && out.created && out.created[0];
      draft = freshDraft();
      if (madeNew) await loadTags();
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

  // The address a person signs in with, and their second addresses (0100), to
  // the people who see addresses on a roster.
  function mailsHtml(p, cls) {
    const also = Array.isArray(p.also) ? p.also.filter(Boolean) : [];
    const own = p.email && p.email !== p.who ? `<div class="small txt-muted ${cls}">${esc(p.email)}</div>` : '';
    return own + also.map(a => `<div class="small txt-muted ${cls}">${esc(a)} · ${
      termHtml('second address', word('second'))}</div>`).join('');
  }

  function rosterHtml(t, ownerView) {
    const r = Array.isArray(t.roster) ? t.roster : [];
    if (!r.length) return '<p class="small txt-muted">Nobody yet.</p>';
    return `<div class="table-wrap"><table class="tk-roster">
        <caption class="sr-only">Who is on ${esc(t.name)}</caption>
        <thead><tr><th scope="col">Person</th><th scope="col">On it as</th><th scope="col" class="col-optional">Added</th>
          ${ownerView ? '<th scope="col"><span class="sr-only">Actions</span></th>' : ''}</tr></thead>
        <tbody>${r.map(p => `<tr>
          <th scope="row">${esc(p.who || p.email || '—')}${p.you ? ' <span class="badge">you</span>' : ''}${
            mailsHtml(p, 'tk-mail')}</th>
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
          <span class="small txt-muted"> · ${esc(t.team || 'unassigned')}${t.due_on ? ` · due ${esc(dmy(t.due_on))}` : ''}</span>${tagChipsHtml(t)}</span></div>`).join('')
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
        ${activeTags().length ? `<h3 class="tk-words-sub">The tags</h3>
        <dl class="tk-words-list tk-words-tags">${activeTags().map(g => `<dt>${tagChip(g)}</dt><dd>${esc(tagMeaning(g))}</dd>`).join('')}</dl>` : ''}
      </details>`;
  }

  // ── The tab ────────────────────────────────────────────────────────────────

  function init() {
    placeMap();
    if (typeof registerTabTeardown === 'function') registerTabTeardown('tasks-map', stopMap);
    if (signedIn() && (forMe() || handoff) && teams === null && !loading && !missing) load();
    else if (handoff && teams) askRefs();
  }

  function authChanged() {
    teams = null; tags = null; list = null; task = null; taskErr = ''; error = ''; refused = ''; missing = false;
    // Another person, or nobody: the filters start again from theirs.
    Object.assign(filt, { scope: '', status: 'live', team: '', tag: '', q: '' });
    draft = freshDraft();
    loading = false; busy = false; note = ''; refsAsked = ''; teamErr = {};
    rowBusy.clear(); rowEdit = null; rowNote = ''; rowErr = '';
    for (const k of Object.keys(cards)) delete cards[k];
    listAt = 0; listAsk = null;
    listChanged();
    if (handoff) for (const r of handoff.rows) { r.existing = null; r.teamPicked = false; r.notYours = false; r.include = true; }
    // …and the list: the task open was the last person's.
    view = 'list'; openId = null;
    if (state.activeTab === 'tasks') { paint(); init(); }
  }

  return {
    render, init, load, authChanged, restoreFromUrl, cardHtml, cardAsk, parseHandoff,
    _mapWheel: () => (TM.map ? TM.map.scrollWheelZoom.enabled() : null),
    WORDS, STATUS, PINS, forMe, mapRows, stationGroups, mergeOnScreen, pinIcon, pinTitle, pinPopupHtml, keyHtml,
    filter(k, v) {
      filt[k] = v;
      rowNote = ''; rowErr = ''; rowEdit = null;
      if (k === 'q') { paintPart('tk-table', tableHtml()); drawMap(); return; }
      paint();
    },
    open(id) {
      if (state.activeTab !== 'tasks') switchTab('tasks');
      openTask(id);
    },
    back() { view = 'list'; task = null; openId = null; taskErr = ''; note = ''; rowNote = ''; rowErr = ''; rowEdit = null; paint('#tk-list-h'); },
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
      if (!upd.edit) upd.edit = seedEdit(task);
      upd.edit[k] = v;
    },
    editPicking() {
      if (!task) return;
      if (!upd.edit) upd.edit = seedEdit(task);
      upd.edit.picking = true; upd.edit.q = '';
      paint('#tk-e-q');
    },
    editStationTyped(v) { if (upd.edit) { upd.edit.q = v; paintPart('tk-e-picks', editPicksHtml(upd.edit)); } },
    editPick(id) {
      if (!upd.edit) return;
      if (id !== null) upd.edit.station = id;
      upd.edit.picking = false; upd.edit.q = '';
      paint('#tk-e-station');
    },
    editReset() { upd = { status: '', note: '', edit: null, tagPick: null }; taskErr = ''; paint('#tk-e-team'); },
    async save() {
      if (!task) return;
      const c = {};
      if (upd.status && upd.status !== task.status) c.status = upd.status;
      if (upd.tagPick && tagsOn() && !sameTags(upd.tagPick.sel, taskTags(task).map(g => g.name))) c.tags = tagsPayload(upd.tagPick);
      if (upd.note.trim()) c.note = upd.note.trim();
      if (!Object.keys(c).length) { taskErr = 'Nothing to save: change the status or the tags, or write a note.'; paint('#tk-u-save'); return; }
      if (c.status === 'cancelled' && !(await confirmDialog({ title: `Cancel “${task.title}”?`,
        message: 'Its team stops seeing it as something to do. It can be brought back.', confirm: 'Cancel the task', cancel: 'Keep it', danger: true }))) return;
      await change(c, c.status ? `${task.title}: ${STATUS_OF[c.status].label}${c.tags ? ', tags saved' : ''}.` : c.tags ? 'Tags saved.' : 'Note added.', 'tk-u-save');
    },
    async saveEdit() {
      if (!task || busy) return;
      const e = upd.edit || seedEdit(task), c = {}, said = [];
      const title = e.title.trim();
      if (!title) { taskErr = 'Give it a title — what is to be done, in a line.'; paint('#tk-e-title'); return; }
      if ((e.team || null) !== (task.team_id || null)) {
        if (!e.team && !(task.may || {}).any_team) { taskErr = 'Pick the team to hand it to.'; paint('#tk-e-team'); return; }
        c.team_id = e.team || null;
        said.push(e.team ? `handed to ${teamName(e.team)}` : 'left with no team');
      }
      if (e.status !== task.status) { c.status = e.status; said.push(STATUS_OF[e.status].label.toLowerCase()); }
      if (title !== task.title) { c.title = title; said.push('renamed'); }
      if (e.details !== (task.details || '')) { c.details = e.details; said.push('details changed'); }
      if ((e.due || '') !== (task.due_on || '')) { c.due_on = e.due || null; said.push(e.due ? `due ${dmy(e.due)}` : 'no due date'); }
      if ((e.station || '') !== (task.station_id || '')) { c.station_id = e.station || null; said.push(e.station ? `at ${stationLabel(e.station)}` : 'a general task now'); }
      if (tagsOn() && e.tagPick && !sameTags(e.tagPick.sel, taskTags(task).map(g => g.name))) {
        c.tags = tagsPayload(e.tagPick);
        said.push(e.tagPick.sel.length ? `tagged ${e.tagPick.sel.join(', ')}` : 'no tags now');
      }
      if (upd.note.trim()) { c.note = upd.note.trim(); if (!said.length) said.push('note added'); }
      if (!Object.keys(c).length) { taskErr = 'Nothing has changed.'; paint('#tk-e-save'); return; }
      if (c.status === 'cancelled' && !(await confirmDialog({ title: `Cancel “${task.title}”?`,
        message: 'Its team stops seeing it as something to do. It can be brought back.', confirm: 'Cancel the task', cancel: 'Keep it', danger: true }))) return;
      const line = said.join(', ');
      await change(c, `Saved: ${line.charAt(0).toUpperCase()}${line.slice(1)}.`, 'tk-e-save');
    },
    rowSet,
    tagToggle, tagAdd,
    tagTyped(ctx, v) {
      const p = pickerOf(ctx);
      if (!p) return;
      p.typed = v;
      // The hint under the box, in place, so the caret stays where it is.
      const typed = cleanTag(v);
      const isNew = typed && !tagByName(typed) && !p.sel.some(n => n.toLowerCase() === typed.toLowerCase());
      const el = document.getElementById(`tk-tag-hint-${ctx}`);
      if (el) el.innerHTML = isNew ? `“${esc(typed)}” is a ${termHtml('new tag', word('newtag'))}: Add puts it on, and saving makes it.` : '';
    },
    tagMeaningTyped(ctx, name, v) {
      const p = pickerOf(ctx);
      if (p && name) p.fresh[name.toLowerCase()] = v;
    },
    tags: () => allTags(),
    rename(id) {
      if (!(list || []).some(x => x.id === id)) return;
      rowEdit = id;
      paintTable(`k:title:${id}`);
      const el = document.querySelector(`#tk-table [data-k="title:${CSS.escape(id)}"]`);
      if (el) el.select();
    },
    titleKey(ev, id, el) {
      if (ev.key === 'Enter') { ev.preventDefault(); Tasks.titleDone(id, el.value); }
      else if (ev.key === 'Escape') { ev.preventDefault(); rowEdit = null; paintTable(`k:rename:${id}`); }
    },
    titleDone(id, v) {
      if (rowEdit !== id) return;
      rowEdit = null;
      const t = (list || []).find(x => x.id === id);
      const title = String(v || '').replace(/\s+/g, ' ').trim();
      if (!t || !title || title === t.title) { paintTable(`k:rename:${id}`); return; }
      rowChange(id, { title }, `Renamed: ${title}.`, `k:rename:${id}`);
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
    _state: () => ({ view, openId, teams: !!teams, list: list ? list.length : null,
      tags: tags ? { n: allTags().length, missing: !!tags.missing } : null,
      picks: { new: draft.tagPick ? [...draft.tagPick.sel] : [], edit: upd.edit && upd.edit.tagPick ? [...upd.edit.tagPick.sel] : null,
               work: upd.tagPick ? [...upd.tagPick.sel] : null },
      handoff: handoff ? {
      session: handoff.session, forum: handoff.forum, station: { ...handoff.station },
      rows: handoff.rows.map(r => ({ ref: r.ref, title: r.title, team: r.team, include: r.include, due: r.due,
                                     created: r.created, existing: !!r.existing, notYours: !!r.notYours })) } : null,
      hoError, missing, refused }),
  };
})();
if (typeof window !== 'undefined') window.Tasks = Tasks;
