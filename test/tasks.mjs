// ✅ Tasks (tasks.js), the Admin tab's Teams (admin-teams.js) and SoRT's
// hand-off, held to what they claim — in Chromium over the real register, with
// the database's doors (0095) stood in for by routes that keep its rules
// (tools/check_teams_and_tasks.sql holds the real ones to them).
//
//   Who it is for   signed out it says who it is for and offers Sign in; signed
//                   in on no team it says so and draws no control; on a team the
//                   nav offers it and it reads the teams and the list once.
//   The list        a member starts on their teams' unfinished tasks; the
//                   filters narrow by whose, status, team and station (typing
//                   keeps its box); a late task says overdue; every heading and
//                   status chip says what it means; the words are in a fold.
//   One task        opened from its row: its facts, details and thread; its
//                   team moves it on with a note, Cancelled not offered to it;
//                   nothing to save says so; somebody who hands out tasks hands
//                   it to another team and changes its words; a cancel asks.
//   A new task      the station found by name and picked, a general one, the
//                   team, the date: sent as one task and opened; an owner offered
//                   their own team only and told to pick it.
//   My teams        a member sees names and no addresses; an owner adds by
//                   address (the box emptied, focus kept), a waiting account
//                   refused in words with the address kept, Take off… asking.
//   Station card    a station's tasks still going, for the people they are for,
//                   with New task here; nothing — not even a request — for
//                   anybody else.
//   The hand-off    read as untrusted: the contract's example, a newer version,
//                   a broken payload, more than thirty tasks, unknown keys,
//                   control characters, a repeated ref, a bad date; landing on
//                   #tasks= clears the address and opens the review; signed out
//                   it is read only with Sign in, signed in without the right it
//                   says ask a SoRT Forum member and nothing is made; somebody
//                   who hands out tasks finds each team picked by hub or name,
//                   one already made shown as such, an edit carried, and Create
//                   sending exactly the tasks agreed, once; markup arriving in a
//                   title is shown as text; a station not in the register goes
//                   in the details; an owner can make only their own team's.
//   Admin › Teams   every team and roster; make one; name an owner — the Add
//                   box offering the approved accounts not on it; take
//                   somebody off; remove one with tasks refused in words; an
//                   editor shown the panel's purpose and no control.
//   Tags (0118)     a row's tags as chips that say what they mean; the Tag
//                   filter, No tag among it; its team tags a task by pressing a
//                   tag and types a new one, asked what it means, sent with its
//                   meaning and threaded as tagged; a new task sent with its
//                   tags; the fold says each tag's meaning. Admin › Tags: every
//                   tag with its tasks; rename and retire one, a retired one no
//                   longer offered but kept on its task; merge one into another,
//                   asked first; remove refused while a task has it.
//
// Run:  npm run tasks
//       npm run tasks -- -v    also print what passed

import { startServer } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { applyNetworkPolicy } from './lib/network.mjs';

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const LOAD_TIMEOUT = Number(process.env.SMOKE_LOAD_TIMEOUT || 60_000);

let failures = 0, passes = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passes++; if (VERBOSE) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
};
const J = x => JSON.stringify(x);

// ── The store, stood in for ──────────────────────────────────────────────────
// People, teams and tasks, and the rules 0095 keeps: who sees a task, who
// moves it on, who hands one out, who changes a roster. `as` is whose request
// it answers.

const PEOPLE = {
  admin:    { id: 'u-adm',  who: 'Ada Admin',     email: 'admin@example.test', admin: true },
  sort:     { id: 'u-sort', who: 'Sam Sort',      email: 'sort@example.test' },
  owner:    { id: 'u-own',  who: 'Olive Owner',   email: 'owner@example.test' },
  member:   { id: 'u-mem',  who: 'Max Member',    email: 'member@example.test' },
  radio:    { id: 'u-rad',  who: 'Rae Radio',     email: 'radio@example.test' },
  outsider: { id: 'u-out',  who: 'Oscar Outside', email: 'outsider@example.test' },
  newbie:   { id: 'u-new',  who: 'Nell New',      email: 'new@example.test' },
  waiting:  { id: 'u-wait', who: 'Walt Waiting',  email: 'waiting@example.test', waiting: true },
};
const byId = id => Object.values(PEOPLE).find(p => p.id === id);

function freshStore() {
  return {
    as: 'member', calls: [], n: 0,
    hubs: [{ id: 'brisbane', name: 'Brisbane Hub' }, { id: 'cairns', name: 'Cairns Hub' }],
    teams: [
      { id: 't-bris',  name: 'Brisbane Hub',    hub_id: 'brisbane', hands_out: false,
        members: [{ id: 'u-own', owner: true, added_at: '2026-10-01T00:00:00Z', added_by: 'u-adm' },
                  { id: 'u-mem', owner: false, added_at: '2026-10-02T00:00:00Z', added_by: 'u-own' }] },
      { id: 't-radio', name: 'Radio licensing', hub_id: null, hands_out: false,
        members: [{ id: 'u-rad', owner: false, added_at: '2026-10-02T00:00:00Z', added_by: 'u-adm' }] },
      { id: 't-ote',   name: 'OTE',             hub_id: null, hands_out: false, members: [] },
      { id: 't-sort',  name: 'SoRT Forum',      hub_id: null, hands_out: true,
        members: [{ id: 'u-sort', owner: false, added_at: '2026-10-01T00:00:00Z', added_by: 'u-adm' }] },
    ],
    tasks: [
      { id: 'k1', station_id: 'loudoun_br_al', title: 'Clear the orifice line', details: 'Silt at the outlet.\nTake the auger.',
        team_id: 't-bris', status: 'open', due_on: '2026-10-20', source: 'floodnet', created_by: 'u-own',
        created_at: '2026-10-10T00:00:00Z', thread: [{ kind: 'created', to: 'Brisbane Hub', by: 'u-own', at: '2026-10-10T00:00:00Z' },
                                                     { kind: 'note', body: 'Gate key is at the depot.', by: 'u-mem', at: '2026-10-11T00:00:00Z' }] },
      { id: 'k2', station_id: 'fifteen_mile_al', title: 'Replace the battery', details: '', team_id: 't-bris', status: 'in_progress',
        due_on: '2026-12-15', source: 'floodnet', created_by: 'u-sort', created_at: '2026-10-12T00:00:00Z', thread: [] },
      { id: 'k3', station_id: 'abbieglassie_al', title: 'Licence transfer', details: '', team_id: 't-radio', status: 'waiting',
        due_on: null, source: 'floodnet', created_by: 'u-sort', created_at: '2026-10-13T00:00:00Z', thread: [] },
      { id: 'k4', station_id: 'loudoun_br_al', title: 'Old job, finished', details: '', team_id: 't-bris', status: 'done',
        due_on: null, source: 'floodnet', created_by: 'u-own', created_at: '2026-09-01T00:00:00Z', thread: [] },
      { id: 'k5', station_id: null, title: 'Order spare radios', details: '', team_id: null, status: 'open',
        due_on: null, source: 'floodnet', created_by: 'u-sort', created_at: '2026-10-14T00:00:00Z', thread: [] },
      { id: 'k6', station_id: 'fifteen_mile_al', title: 'Check the ALERT IDs', details: '', team_id: 't-bris', status: 'open',
        due_on: null, source: 'sort', source_date: '2026-10-07', source_ref: 'sort:sess-1:alertIds', created_by: 'u-sort',
        created_at: '2026-10-07T03:00:00Z', thread: [] },
    ],
    tags: [
      { id: 'g-rts', name: 'RTS', meaning: 'Return to service: getting a station that is out of action working and reporting again.', colour: 'red', retired: false },
      { id: 'g-qa', name: 'QA', meaning: 'Quality assurance: checking that a station\'s readings, or the work done at it, are right.', colour: 'blue', retired: false },
      { id: 'g-asm', name: 'Assessment', meaning: 'FWIN site assessment: assessing a site for the Flood Warning Infrastructure Network program.', colour: 'green', retired: false },
    ],
    // Which tasks have which tags: task id → tag ids.
    tagged: { k2: ['g-rts'] },
    refuse: null,
  };
}
let store = freshStore();

const me = () => PEOPLE[store.as];
const teamsOf = (p, owned) => store.teams.filter(t => t.members.some(m => m.id === p.id && (m.owner || !owned))).map(t => t.id);
const handsOut = p => !!p.admin || store.teams.some(t => t.hands_out && t.members.some(m => m.id === p.id));
const sees = (p, k) => handsOut(p) || k.created_by === p.id || (k.team_id && teamsOf(p).includes(k.team_id));
const teamName = id => (store.teams.find(t => t.id === id) || {}).name || null;

function teamsRead() {
  const p = me();
  const on = teamsOf(p), owns = teamsOf(p, true);
  return {
    me: { admin: !!p.admin, hands_out: handsOut(p), on, owns },
    teams: [...store.teams].sort((a, b) => a.name.localeCompare(b.name)).map(t => ({
      id: t.id, name: t.name, hub_id: t.hub_id, hub: (store.hubs.find(h => h.id === t.hub_id) || {}).name || null,
      hands_out: t.hands_out, role: owns.includes(t.id) ? 'owner' : on.includes(t.id) ? 'member' : null,
      roster: p.admin || on.includes(t.id) ? [...t.members].sort((a, b) => b.owner - a.owner).map(m => ({
        id: m.id, who: byId(m.id).who, email: p.admin || owns.includes(t.id) ? byId(m.id).email : null, owner: m.owner,
        you: m.id === p.id, added_at: m.added_at, added_by: byId(m.added_by) ? byId(m.added_by).who : null })) : null,
      tasks: p.admin ? store.tasks.filter(k => k.team_id === t.id).length : null,
    })),
    hubs: p.admin ? store.hubs : null,
  };
}
const tagNames = id => (store.tagged[id] || []).map(g => store.tags.find(x => x.id === g)).filter(Boolean)
  .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
function tagsRead() {
  const p = me();
  return { me: { admin: !!p.admin, may_tag: !!p.admin || teamsOf(p).length > 0 },
    colours: ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'grey'],
    tags: [...store.tags].sort((a, b) => (a.retired - b.retired) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .map(g => ({ id: g.id, name: g.name, meaning: g.meaning, colour: g.colour, retired: g.retired,
        ...(p.admin ? { tasks: Object.values(store.tagged).filter(l => l.includes(g.id)).length, live: 0, created_by: 'Ada Admin', created_at: '2026-11-12T00:00:00Z' } : {}) })) };
}
// As tag_resolve() does: a known name (case aside) is that tag, a new one made.
function resolveTags(list) {
  const out = [];
  for (const e of list || []) {
    const name = String(typeof e === 'string' ? e : e.name).replace(/\s+/g, ' ').trim();
    let g = store.tags.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!g) {
      g = { id: `g-new-${store.tags.length}`, name, meaning: typeof e === 'object' ? (e.meaning || '') : '', colour: 'purple', retired: false };
      store.tags.push(g);
    }
    if (!out.includes(g.id)) out.push(g.id);
  }
  return out;
}
const tagLine = id => tagNames(id).map(g => g.name).join(', ');
function listJson(k) {
  const p = me();
  return { id: k.id, station_id: k.station_id, title: k.title, team_id: k.team_id, team: teamName(k.team_id), status: k.status,
    due_on: k.due_on, source: k.source, source_date: k.source_date || null, source_ref: k.source_ref || null,
    created_at: k.created_at, created_by: byId(k.created_by).who, updated_at: k.created_at,
    closed_at: ['done', 'cancelled'].includes(k.status) ? '2026-10-30T00:00:00Z' : null,
    my_team: !!(k.team_id && teamsOf(p).includes(k.team_id)), by_me: k.created_by === p.id,
    notes: k.thread.filter(n => n.kind === 'note').length, last_at: k.created_at,
    tags: tagNames(k.id).map(g => ({ id: g.id, name: g.name, colour: g.colour })) };
}
function mayOn(k) {
  const p = me();
  return { work: !!(k.team_id && teamsOf(p).includes(k.team_id)),
           manage: handsOut(p) || k.created_by === p.id || !!(k.team_id && teamsOf(p, true).includes(k.team_id)),
           any_team: handsOut(p), owns: teamsOf(p, true) };
}
function getJson(k) {
  const p = me();
  return { ...listJson(k), details: k.details, may: mayOn(k),
    thread: k.thread.map((n, i) => ({ id: i + 1, kind: n.kind, body: n.body || '', from: n.from || null, to: n.to || null,
                                      who: byId(n.by).who, you: n.by === p.id, at: n.at })) };
}
const STATUSES = ['open', 'in_progress', 'waiting', 'done', 'cancelled'];

function answer(fn, a) {
  const p = me();
  const no = (status, code, message) => ({ status, body: { code, message } });
  const yes = body => ({ status: 200, body });
  if (store.refuse === fn) return no(403, '42501', 'refused for the test');
  const now = new Date(Date.UTC(2026, 10, 1, 1, 0, store.n++)).toISOString();
  if (p.waiting && fn !== 'whoami') return no(403, '42501', 'teams are for approved accounts — sign in with an account an administrator has approved');
  switch (fn) {
    case 'teams_read': return yes(teamsRead());
    case 'task_list':
      return yes(store.tasks.filter(k => sees(p, k) && (!a.p_station_id || k.station_id === a.p_station_id)
        && (!a.p_open_only || ['open', 'in_progress', 'waiting'].includes(k.status))).map(listJson));
    case 'task_get': {
      const k = store.tasks.find(x => x.id === a.p_id);
      if (!k || !sees(p, k)) return no(500, 'P0002', 'no such task, or not one you may see');
      return yes(getJson(k));
    }
    case 'task_refs':
      return yes(store.tasks.filter(k => k.source_ref && a.p_refs.includes(k.source_ref))
        .map(k => ({ ref: k.source_ref, created_at: k.created_at, visible: sees(p, k), id: sees(p, k) ? k.id : null })));
    case 'task_create': {
      const owns = teamsOf(p, true), all = handsOut(p);
      if (!all && !owns.length) return no(403, '42501', 'you may not hand out tasks');
      const created = [], existing = [];
      for (const t of a.p_tasks) {
        if (!all && (!t.team_id || !owns.includes(t.team_id))) return no(403, '42501', 'a team\'s owner hands tasks to their own team only');
        const had = t.source_ref && store.tasks.find(k => k.source_ref === t.source_ref);
        if (had) { existing.push({ ref: t.source_ref, created_at: had.created_at, visible: sees(p, had), id: sees(p, had) ? had.id : null }); continue; }
        const k = { id: `new-${store.n}-${created.length}`, station_id: t.station_id || null, title: t.title, details: t.details || '',
          team_id: t.team_id || null, status: 'open', due_on: t.due_on || null, source: t.source || 'floodnet',
          source_date: t.source_date || null, source_ref: t.source_ref || null, created_by: p.id, created_at: now,
          thread: [{ kind: 'created', to: teamName(t.team_id), by: p.id, at: now }] };
        store.tasks.push(k);
        if (t.tags && t.tags.length) { store.tagged[k.id] = resolveTags(t.tags); k.thread.push({ kind: 'tags', from: '', to: tagLine(k.id), by: p.id, at: now }); }
        created.push({ id: k.id, ref: k.source_ref, title: k.title });
      }
      return yes({ created, existing });
    }
    case 'task_update': {
      const k = store.tasks.find(x => x.id === a.p_id);
      if (!k || !sees(p, k)) return no(500, 'P0002', 'no such task, or not one you may see');
      const may = mayOn(k), c = a.p_change;
      if (c.note && !(may.work || may.manage)) return no(403, '42501', 'only the team it is handed to writes on a task');
      // As task_update() does: every change in one call, the note on the first.
      let used = false;
      const body = () => (used ? '' : (c.note || ''));
      if (c.status && c.status !== k.status) {
        if ((c.status === 'cancelled' || k.status === 'cancelled') && !may.manage) return no(403, '42501', 'only whoever handed it out cancels a task');
        if (!(may.work || may.manage)) return no(403, '42501', 'only the team it is handed to moves a task on');
        k.thread.push({ kind: 'status', from: k.status, to: c.status, body: body(), by: p.id, at: now }); used = true;
        k.status = c.status;
      }
      if ('team_id' in c && (c.team_id || null) !== k.team_id) {
        if (!may.manage) return no(403, '42501', 'only whoever manages a task hands it to another team');
        if (!c.team_id && !may.any_team) return no(403, '42501', 'only the people who hand out tasks leave one with no team');
        if (c.team_id && !may.any_team && !may.owns.includes(c.team_id)) return no(403, '42501', 'a team\'s owner hands tasks to their own team only');
        k.thread.push({ kind: 'team', from: teamName(k.team_id) || '', to: teamName(c.team_id) || '', body: body(), by: p.id, at: now }); used = true;
        k.team_id = c.team_id || null;
      }
      const changed = [];
      if ('title' in c && c.title !== k.title) changed.push('title');
      if ('details' in c && c.details !== k.details) changed.push('details');
      if ('due_on' in c && (c.due_on || null) !== k.due_on) changed.push('due date');
      if ('station_id' in c && (c.station_id || null) !== k.station_id) changed.push('station');
      if (changed.length) {
        if (!may.manage) return no(403, '42501', 'only whoever manages a task changes its words');
        if (changed.includes('title')) k.title = c.title;
        if (changed.includes('details')) k.details = c.details;
        if (changed.includes('due date')) k.due_on = c.due_on || null;
        if (changed.includes('station')) k.station_id = c.station_id || null;
        k.thread.push({ kind: 'edit', to: changed.join(', '), body: body(), by: p.id, at: now }); used = true;
      }
      if (Array.isArray(c.tags)) {
        const want = resolveTags(c.tags), had = store.tagged[k.id] || [];
        if (want.length !== had.length || want.some(x => !had.includes(x))) {
          if (!(may.work || may.manage)) return no(403, '42501', 'only the team it is handed to, or whoever manages it, tags a task');
          const was = tagLine(k.id);
          store.tagged[k.id] = want;
          k.thread.push({ kind: 'tags', from: was, to: tagLine(k.id), body: body(), by: p.id, at: now }); used = true;
        }
      }
      if (c.note && !used) k.thread.push({ kind: 'note', body: c.note, by: p.id, at: now });
      return yes(getJson(k));
    }
    case 'team_member_save': {
      const t = store.teams.find(x => x.id === a.p_team_id);
      if (!t) return no(500, 'P0002', 'no such team');
      const owner = teamsOf(p, true).includes(t.id);
      if (!p.admin && !owner) return no(403, '42501', 'only the team\'s owners, or an administrator, change who is on it');
      if (!p.admin && a.p_owner) return no(403, '42501', 'only an administrator names a team\'s owners');
      const who = Object.values(PEOPLE).find(x => x.email === String(a.p_email).trim().toLowerCase());
      if (!who) return no(500, 'P0002', `nobody has a Flood-Net account as ${a.p_email} — they sign up once, then you add them`);
      if (who.waiting) return no(400, '22023', `${a.p_email}'s account is not approved (pending), so the team's tasks would not open for them — an administrator approves it on the Admin tab first`);
      const m = t.members.find(x => x.id === who.id);
      if (m) { if (a.p_owner != null) m.owner = !!a.p_owner; }
      else t.members.push({ id: who.id, owner: !!a.p_owner, added_at: now, added_by: p.id });
      return yes(teamsRead());
    }
    case 'team_member_remove': {
      const t = store.teams.find(x => x.id === a.p_team_id);
      if (!t) return yes(teamsRead());
      const owner = teamsOf(p, true).includes(t.id);
      if (!p.admin && !owner) return no(403, '42501', 'only the team\'s owners, or an administrator, change who is on it');
      const m = t.members.find(x => x.id === a.p_user_id);
      if (m && m.owner && !p.admin) return no(403, '42501', 'only an administrator takes an owner off a team');
      t.members = t.members.filter(x => x !== m);
      return yes(teamsRead());
    }
    case 'team_save': {
      if (!p.admin) return no(403, '42501', 'only an administrator makes or changes a team');
      const name = String(a.p_name || '').trim();
      if (store.teams.some(t => t.name.toLowerCase() === name.toLowerCase() && t.id !== a.p_id)) return no(409, '23505', `a team is already called ${name}`);
      if (a.p_id) Object.assign(store.teams.find(t => t.id === a.p_id), { name, hub_id: a.p_hub_id || null, hands_out: !!a.p_hands_out });
      else store.teams.push({ id: `t-new-${store.n}`, name, hub_id: a.p_hub_id || null, hands_out: !!a.p_hands_out, members: [] });
      return yes(teamsRead());
    }
    case 'team_remove': {
      if (!p.admin) return no(403, '42501', 'only an administrator removes a team');
      const n = store.tasks.filter(k => k.team_id === a.p_id).length;
      if (n) return no(409, '23503', `${n} task${n === 1 ? ' has' : 's have'} been handed to it, so it stays — rename it, or hand them to another team first`);
      store.teams = store.teams.filter(t => t.id !== a.p_id);
      return yes(teamsRead());
    }
    case 'tags_read': return yes(tagsRead());
    case 'tag_save': {
      const name = String(a.p_name || '').replace(/\s+/g, ' ').trim();
      if (a.p_id && !p.admin) return no(403, '42501', 'only an administrator changes a tag');
      if (store.tags.some(g => g.name.toLowerCase() === name.toLowerCase() && g.id !== a.p_id)) return no(409, '23505', `there is a tag called ${name} already`);
      if (a.p_id) {
        const g = store.tags.find(x => x.id === a.p_id);
        Object.assign(g, { name, meaning: a.p_meaning || '', colour: a.p_colour || g.colour, retired: a.p_retired == null ? g.retired : !!a.p_retired });
      } else store.tags.push({ id: `g-made-${store.n}`, name, meaning: a.p_meaning || '', colour: a.p_colour || 'teal', retired: false });
      return yes(tagsRead());
    }
    case 'tag_merge': {
      if (!p.admin) return no(403, '42501', 'only an administrator merges tags');
      for (const [id, l] of Object.entries(store.tagged)) {
        if (!l.includes(a.p_from)) continue;
        store.tagged[id] = [...new Set(l.map(x => (x === a.p_from ? a.p_into : x)))];
      }
      store.tags = store.tags.filter(g => g.id !== a.p_from);
      return yes(tagsRead());
    }
    case 'tag_remove': {
      if (!p.admin) return no(403, '42501', 'only an administrator removes a tag');
      const n = Object.values(store.tagged).filter(l => l.includes(a.p_id)).length;
      if (n) return no(409, '23503', `that tag is on ${n} task${n === 1 ? '' : 's'}`);
      store.tags = store.tags.filter(g => g.id !== a.p_id);
      return yes(tagsRead());
    }
    // The Admin tab's Users panel; the Teams panel suggests its approved accounts.
    case 'admin_users':
      if (!p.admin) return no(403, '42501', 'administrators only');
      return yes(Object.values(PEOPLE).map(x => ({ id: x.id, email: x.email, display_name: x.who, role: x.admin ? 'admin' : 'editor',
        status: x.waiting ? 'pending' : 'approved', is_you: x.id === p.id })));
    case 'admin_allowlist':
      if (!p.admin) return no(403, '42501', 'administrators only');
      return yes([]);
    default: return null;
  }
}

async function route(page) {
  await page.route('**/rpc/*', async r => {
    const fn = r.request().url().split('/rpc/')[1].split('?')[0];
    let a = {};
    try { a = JSON.parse(r.request().postData() || '{}') || {}; } catch (_) {}
    const got = answer(fn, a);
    if (!got) return r.fallback();
    store.calls.push({ fn, a, as: store.as });
    return r.fulfill({ status: got.status, contentType: 'application/json', body: J(got.body) });
  });
}

// The session, as whoami() would have it — every getter tasks.js and the nav
// ask, set in the page.
async function as(page, who) {
  store.as = who || 'member';
  const p = who ? PEOPLE[who] : null;
  const t = p ? { admin: !!p.admin, tasks: !!p.admin || teamsOf(p).length > 0, hands: handsOut(p), owner: teamsOf(p, true).length > 0, teams: teamsOf(p).length } : null;
  await page.evaluate(t => {
    Auth.isSignedIn = () => !!t;
    Auth.isAdmin = () => !!(t && t.admin);
    Auth.role = () => (t ? (t.admin ? 'admin' : 'editor') : null);
    Auth.tasks = () => !!(t && t.tasks);
    Auth.handsOut = () => !!(t && t.hands);
    Auth.teamOwner = () => !!(t && t.owner);
    Auth.teams = () => (t ? t.teams : 0);
    Auth.isMember = () => !!t;
    renderTabs();
  }, t);
}
const calls = fn => store.calls.filter(c => c.fn === fn);
const main = page => page.evaluate(() => document.getElementById('main-content').textContent.replace(/\s+/g, ' ').trim());

// base64url of the UTF-8 JSON, no padding — SoRT's side of the contract.
const b64url = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const EXAMPLE = {
  v: 1, source: 'sort', session: 'sess-1', forum: '2026-10-07',
  station: { id: 'fifteen_mile_al', number: '540601', name: 'Fifteen Mile AL', hub: 'brisbane' },
  tasks: [
    { ref: 'alertIds', title: 'Check the ALERT IDs', detail: 'Against the pass ranges.', team: { hub: 'brisbane' } },
    { ref: 'acmaTransfer', title: 'Transfer the ACMA licence', detail: 'To the Bureau.', team: { name: 'radio LICENSING' } },
    { ref: 'custom-1', title: 'Fence the hut', detail: 'Two panels.', team: { name: 'OTE' }, due: '2026-12-01' },
    { ref: 'custom-2', title: 'Ask the council <img src=x onerror="window.__xss=1">', detail: 'About the <b>road</b>.', team: { name: 'Roads crew' } },
  ],
};

const server = await startServer();
const browser = await launchBrowser();
const errors = [];

async function openPage({ hash = '', viewport = { width: 1440, height: 1000 } } = {}) {
  const context = await browser.newContext({ viewport, timezoneId: 'Australia/Brisbane', locale: 'en-AU' });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await applyNetworkPolicy(page, server.origin);
  await route(page);
  await page.addInitScript(() => { try { localStorage.setItem('mn-nudge', 'off'); } catch (_) {} });
  await page.goto(server.url('/index.html') + hash, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.data && Array.isArray(state.data.stations),
    null, { timeout: LOAD_TIMEOUT });
  return { context, page };
}
const settle = page => page.waitForTimeout(120);

try {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nThe hand-off, read as untrusted\n');
  const { context: c1, page } = await openPage();
  const parsed = await page.evaluate(([good, newer, big, odd]) => {
    const P = Tasks.parseHandoff;
    return {
      good: P(good), newer: P(newer), broken: P('not!base64'), cut: P(good.slice(0, 40)), notJson: P(btoa('hello').replace(/=+$/, '')),
      notSort: P(odd.notSort), big: P(big), odd: P(odd.odd),
    };
  }, [b64url(EXAMPLE), b64url({ ...EXAMPLE, v: 2 }),
      b64url({ ...EXAMPLE, tasks: Array.from({ length: 34 }, (_, i) => ({ ref: `r${i}`, title: `Job ${i}` })) }),
      { notSort: b64url({ ...EXAMPLE, source: 'elsewhere' }),
        odd: b64url({ ...EXAMPLE, colour: 'red', tasks: [
          { ref: 'a', title: 'Line\u0007 one\nand two', detail: 'Keep\nlines\u0000', team: { hub: 'brisbane', extra: 1 }, due: '2026-02-30', more: true },
          { ref: 'a', title: 'The same ref again' },
          { ref: 'bad ref!', title: 'A ref with spaces' },
          { ref: 'b', title: '' },
          'not a task',
        ] }) }]);
  ok('the contract\'s example reads: four tasks, the session, the forum and the station',
    parsed.good.ok && parsed.good.data.rows.length === 4 && parsed.good.data.session === 'sess-1'
    && parsed.good.data.forum === '2026-10-07' && parsed.good.data.station.id === 'fifteen_mile_al'
    && parsed.good.data.rows[2].due === '2026-12-01' && parsed.good.data.rows[1].wantTeam === 'radio LICENSING', J(parsed.good));
  ok('a newer version is refused in words that say so', !parsed.newer.ok && /newer SoRT \(version 2\)/.test(parsed.newer.why), J(parsed.newer));
  ok('a payload that is not base64url, is cut short or is not JSON is refused in words',
    !parsed.broken.ok && !parsed.cut.ok && !parsed.notJson.ok && /could not be read/.test(parsed.cut.why), J([parsed.broken, parsed.cut, parsed.notJson]));
  ok('one not from SoRT is refused', !parsed.notSort.ok, J(parsed.notSort));
  ok('at most thirty tasks are read, and the rest are counted', parsed.big.ok && parsed.big.data.rows.length === 30
    && parsed.big.data.over === 4, J({ rows: parsed.big.data && parsed.big.data.rows.length, over: parsed.big.data && parsed.big.data.over }));
  const oddRows = parsed.odd.ok ? parsed.odd.data.rows : [];
  ok('unknown keys are ignored, control characters taken out of a title and lines kept in details, a bad date dropped',
    parsed.odd.ok && oddRows.length === 1 && oddRows[0].title === 'Line one and two' && oddRows[0].detail === 'Keep\nlines'
    && oddRows[0].due === '' && oddRows[0].wantHub === 'brisbane', J(oddRows));
  ok('…a repeated ref, a ref that is not a ref, an empty title and a task that is not one left out, and counted',
    parsed.odd.ok && parsed.odd.data.skipped === 4, J(parsed.odd.data && parsed.odd.data.skipped));
  await c1.close();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nLanding on #tasks=…\n');
  store = freshStore();
  const { context: c2, page: p2 } = await openPage({ hash: `#tasks=${b64url(EXAMPLE)}` });
  await p2.waitForFunction(() => state.activeTab === 'tasks' && !!document.getElementById('tk-ho-h'), null, { timeout: 20_000 });
  let land = await p2.evaluate(() => ({
    hash: location.hash, href: location.href, tab: state.activeTab,
    controls: document.querySelectorAll('#tk-handoff input, #tk-handoff select, #tk-handoff textarea').length,
    signIn: !!document.querySelector('#tk-handoff button[onclick="Auth.open()"]'),
    create: !!document.getElementById('tk-ho-go'),
    rows: document.querySelectorAll('#tk-handoff .tk-ho-row').length,
    imgs: document.querySelectorAll('#main-content img').length,
    xss: window.__xss || 0,
    kept: (() => { try { return !!sessionStorage.getItem('mn-tasks-handoff'); } catch (_) { return null; } })(),
  }));
  ok('the address bar loses the fragment as soon as it is read, and the Tasks tab opens on the review',
    land.hash === '' && !/tasks=/.test(land.href) && land.tab === 'tasks' && land.rows === 4, J(land));
  ok('signed out, the review is read only, with Sign in, and no Create', land.controls === 0 && land.signIn && !land.create, J(land));
  ok('markup arriving in a title is shown as text, not run', land.imgs === 0 && land.xss === 0
    && /Ask the council <img src=x onerror/.test(await main(p2)), J(land));
  ok('the hand-off is kept in this browser tab until it is dealt with', land.kept === true, J(land));
  ok('nothing was asked of the database, let alone made', store.calls.length === 0, J(store.calls));

  // Signed in on no team: says why, makes nothing.
  await as(p2, 'outsider');
  await p2.evaluate(() => Tasks.authChanged());
  await p2.waitForFunction(() => /can't hand out tasks/.test(document.getElementById('main-content').textContent), null, { timeout: 10_000 });
  land = await p2.evaluate(() => ({
    text: document.getElementById('tk-handoff').textContent.replace(/\s+/g, ' '),
    create: !!document.getElementById('tk-ho-go'), copy: !!document.getElementById('tk-ho-copy'),
    listed: tabShown(TAB_LIST.find(t => t.id === 'tasks')),
  }));
  ok('signed in without the right: "you can\'t hand out tasks — ask a SoRT Forum member", a link to copy, and no Create',
    /You can't hand out tasks — ask a SoRT Forum member/.test(land.text) && land.copy && !land.create, land.text.slice(0, 200));
  ok('…the nav does not offer the tab to them', land.listed === false);
  ok('…and nothing is made', calls('task_create').length === 0, J(calls('task_create')));

  // Somebody who hands out tasks: the teams picked, one already made, Create.
  store.calls = [];
  await as(p2, 'sort');
  await p2.evaluate(() => Tasks.authChanged());
  await p2.waitForFunction(() => !!document.getElementById('tk-ho-go'), null, { timeout: 10_000 });
  await p2.waitForFunction(() => /Already made on/.test(document.getElementById('tk-handoff').textContent), null, { timeout: 10_000 });
  let ho = await p2.evaluate(() => Tasks._state().handoff);
  const teamOf = ref => (ho.rows.find(r => r.ref === ref) || {}).team;
  ok('each task\'s team is picked: by the hub SoRT named, and by name with its case aside',
    teamOf('acmaTransfer') === 't-radio' && teamOf('custom-1') === 't-ote', J(ho.rows));
  ok('…a team that is not one here leaves it with no team, said in words',
    teamOf('custom-2') === '' && /Roads crew, which is not a team here/.test(await main(p2)), J(ho.rows));
  ok('…the date SoRT gave is kept', (ho.rows.find(r => r.ref === 'custom-1') || {}).due === '2026-12-01');
  ok('the references were asked about once, as sort:<session>:<ref>',
    calls('task_refs').length === 1 && J(calls('task_refs')[0].a.p_refs) === J(['sort:sess-1:alertIds', 'sort:sess-1:acmaTransfer', 'sort:sess-1:custom-1', 'sort:sess-1:custom-2']),
    J(calls('task_refs')));
  let shown = await p2.evaluate(() => ({
    made: [...document.querySelectorAll('#tk-handoff .tk-ho-row.is-made')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
    go: document.getElementById('tk-ho-go').textContent.trim(),
    station: document.querySelector('#tk-handoff .tk-handoff p.small button.link-btn, #tk-handoff p.small button.link-btn')?.textContent || '',
  }));
  ok('one made already says "already made on 07/10 — open it" instead of being made again',
    shown.made.length === 1 && /Already made on 07\/10 — open it/.test(shown.made[0]), J(shown));
  ok('Create counts the ones left to make', shown.go === 'Create 3 tasks', shown.go);
  ok('the station is found in the register by its id', /Fifteen Mile AL \(540601\)/.test(shown.station), shown.station);
  // An edit is carried, and a task left out.
  await p2.fill('[data-k="ho-title:1"]', 'Transfer the ACMA licence to the Bureau');
  await p2.uncheck('[data-k="ho-in:3"]');
  await settle(p2);
  shown = await p2.evaluate(() => ({ go: document.getElementById('tk-ho-go').textContent.trim(), focus: document.activeElement?.dataset?.k }));
  ok('leaving one out takes it off the count, the box keeping focus', shown.go === 'Create 2 tasks' && shown.focus === 'ho-in:3', J(shown));
  ok('nothing is made before Create is pressed', calls('task_create').length === 0);
  await p2.click('#tk-ho-go');
  await p2.waitForFunction(() => /Made 2 tasks from SoRT/.test(document.getElementById('main-content').textContent), null, { timeout: 10_000 });
  const sent = calls('task_create');
  const want = [
    { title: 'Transfer the ACMA licence to the Bureau', details: 'To the Bureau.', source: 'sort', source_ref: 'sort:sess-1:acmaTransfer',
      source_date: '2026-10-07', station_id: 'fifteen_mile_al', team_id: 't-radio' },
    { title: 'Fence the hut', details: 'Two panels.', source: 'sort', source_ref: 'sort:sess-1:custom-1',
      source_date: '2026-10-07', station_id: 'fifteen_mile_al', team_id: 't-ote', due_on: '2026-12-01' },
  ];
  ok('Create sends exactly the tasks agreed, once — the edit carried, the one made already and the one left out not sent',
    sent.length === 1 && J(sent[0].a.p_tasks) === J(want), J(sent.map(c => c.a)));
  land = await p2.evaluate(() => ({
    made: [...document.querySelectorAll('#tk-handoff .tk-ho-row.is-made')].length,
    kept: (() => { try { return sessionStorage.getItem('mn-tasks-handoff'); } catch (_) { return 'x'; } })(),
    done: document.getElementById('tk-ho-dismiss')?.textContent.trim(),
  }));
  ok('each made shows "Made — open it"; one left out keeps the hand-off, to be made or dismissed',
    land.made === 3 && !!land.kept && land.done === 'Dismiss', J(land).slice(0, 200));
  await p2.click('#tk-ho-dismiss');
  await settle(p2);
  land = await p2.evaluate(() => ({ review: !!document.getElementById('tk-ho-h'),
    kept: (() => { try { return sessionStorage.getItem('mn-tasks-handoff'); } catch (_) { return 'x'; } })() }));
  ok('…and Dismiss forgets it', !land.review && land.kept === null, J(land));
  await c2.close();

  // A station not in the register; an owner who may hand out to their own team only.
  console.log('\nThe hand-off — a station not in the register, an owner\n');
  store = freshStore();
  const LOST = { ...EXAMPLE, session: 'sess-2', station: { id: 'nowhere_al', number: '998877', name: 'Nowhere AL', hub: 'brisbane' },
                 tasks: [EXAMPLE.tasks[0], EXAMPLE.tasks[1]] };
  const { context: c3, page: p3 } = await openPage({ hash: `#tasks=${b64url(LOST)}` });
  await p3.waitForFunction(() => !!document.getElementById('tk-ho-h'), null, { timeout: 20_000 });
  await as(p3, 'owner');
  await p3.evaluate(() => Tasks.authChanged());
  await p3.waitForFunction(() => !!document.getElementById('tk-ho-go'), null, { timeout: 10_000 });
  ho = await p3.evaluate(() => Tasks._state().handoff);
  const txt3 = await main(p3);
  ok('a station the register does not have is said, and its tasks will have none',
    /Nowhere AL is not in Flood-Net's station list/.test(txt3), txt3.slice(0, 300));
  ok('an owner finds their own team picked, and another team\'s task left out with why',
    ho.rows[0].team === 't-bris' && ho.rows[0].include && !ho.rows[1].include && ho.rows[1].notYours
    && /SoRT asked for Radio licensing — you may hand tasks only to your own team/.test(txt3), J(ho.rows));
  const ownerOpts = await p3.evaluate(() => [...document.querySelectorAll('[data-k="ho-team:0"] option')].map(o => [o.value, o.disabled]));
  ok('…and is offered no team but their own', J(ownerOpts.filter(([v, d]) => v && !d)) === J([['t-bris', false]]), J(ownerOpts));
  await p3.click('#tk-ho-go');
  await p3.waitForFunction(() => /Made 1 task from SoRT/.test(document.getElementById('main-content').textContent), null, { timeout: 10_000 });
  const sent3 = calls('task_create');
  ok('the task made has no station, and the station\'s name at the top of its details',
    sent3.length === 1 && sent3[0].a.p_tasks.length === 1 && !('station_id' in sent3[0].a.p_tasks[0])
    && sent3[0].a.p_tasks[0].details === 'Station: Nowhere AL (998877) — not in Flood-Net\'s station list.\n\nAgainst the pass ranges.'
    && sent3[0].a.p_tasks[0].team_id === 't-bris', J(sent3.map(c => c.a)));
  // A reload keeps what is left (one row left out stays to be dealt with).
  await p3.reload({ waitUntil: 'load', timeout: LOAD_TIMEOUT });
  await p3.waitForFunction(() => typeof state !== 'undefined' && !!state.data, null, { timeout: LOAD_TIMEOUT });
  await as(p3, 'owner');
  await p3.evaluate(() => switchTab('tasks'));
  await p3.waitForFunction(() => !!document.getElementById('tk-ho-h'), null, { timeout: 10_000 });
  ok('a hand-off not yet dealt with is put back after a reload, the address left alone',
    (await p3.evaluate(() => location.hash)) === '' && /From SoRT: 2 tasks/.test(await main(p3)));
  await c3.close();

  // A broken link says so and makes nothing.
  store = freshStore();
  const { context: c4, page: p4 } = await openPage({ hash: '#tasks=%%%not-a-payload' });
  await p4.waitForFunction(() => state.activeTab === 'tasks', null, { timeout: 20_000 });
  const broken = await p4.evaluate(() => ({ hash: location.hash, text: document.getElementById('main-content').textContent }));
  ok('a link whose tasks cannot be read says so, and clears the address', broken.hash === '' && /could not be read/.test(broken.text), J(broken));
  await c4.close();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nWho it is for\n');
  store = freshStore();
  const { context: c5, page: q } = await openPage();
  await as(q, null);
  await q.evaluate(() => switchTab('tasks'));
  let out = await q.evaluate(() => ({ text: document.getElementById('main-content').textContent.replace(/\s+/g, ' '),
    controls: document.querySelectorAll('#main-content input, #main-content select, #main-content textarea').length,
    signIn: !!document.querySelector('#main-content button[onclick="Auth.open()"]') }));
  ok('signed out it says who it is for, with Sign in, and no control',
    /for administrators and the people on a team/.test(out.text) && out.signIn && out.controls === 0, out.text.slice(0, 200));
  await as(q, 'outsider');
  await q.evaluate(() => Tasks.authChanged());
  out = await q.evaluate(() => ({ text: document.getElementById('main-content').textContent.replace(/\s+/g, ' '),
    controls: document.querySelectorAll('#main-content input, #main-content select').length,
    listed: tabShown(TAB_LIST.find(t => t.id === 'tasks')) }));
  ok('signed in on no team, the same words and no control, and the nav does not offer it',
    /for administrators and the people on a team/.test(out.text) && out.controls === 0 && out.listed === false, J(out).slice(0, 200));
  ok('…and nothing is asked of the database', store.calls.length === 0, J(store.calls));

  await as(q, 'member');
  await q.evaluate(() => Tasks.authChanged());
  await q.waitForFunction(() => !!document.querySelector('#tk-table table'), null, { timeout: 10_000 });
  ok('on a team, the nav offers it, and it reads the teams and the list once each',
    await q.evaluate(() => tabShown(TAB_LIST.find(t => t.id === 'tasks'))) && calls('teams_read').length === 1 && calls('task_list').length === 1,
    J(store.calls.map(c => c.fn)));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nThe list\n');
  const rows = () => q.evaluate(() => [...document.querySelectorAll('#tk-table tbody tr')].map(tr => tr.querySelector('th').textContent.replace(/\s+/g, ' ').trim()));
  let r = await rows();
  ok('a member starts on their teams\' tasks still going, unfinished first',
    r.length === 3 && /Clear the orifice line/.test(r[0]) && r.some(x => /Replace the battery/.test(x)) && !r.some(x => /Old job/.test(x))
    && !r.some(x => /Licence transfer/.test(x)), J(r));
  const memRow = await q.evaluate(() => ({
    status: !!document.querySelector('#tk-table [data-k="status:k1"]'),
    team: !!document.querySelector('#tk-table [data-k="team:k1"]'),
    rename: !!document.querySelector('#tk-table [data-k="rename:k1"]'),
    due: !!document.querySelector('#tk-table [data-k="due:k1"]') }));
  ok('a member moves their team\'s task on from its row, and is offered no hand-over, rename or date there',
    memRow.status && !memRow.team && !memRow.rename && !memRow.due, J(memRow));
  let late = await q.evaluate(() => document.querySelector('#tk-table tbody tr td .tk-late')?.textContent || '');
  ok('a task past its due date and not done says overdue', /20\/10\/2026 overdue/.test(late), late);
  // The map above the list: a pin a station, coloured by its most pressing
  // task, the same map kept across a repaint, and narrowed with the filters.
  const mapNow = () => q.evaluate(() => ({
    pins: [...document.querySelectorAll('#tk-map .mn-task-pin')].map(e => ({ n: e.textContent.replace(/\D/g, ''), cls: e.className }))
      .sort((a, b) => a.n.localeCompare(b.n)),
    note: document.getElementById('tk-map-note')?.textContent || '',
    keys: [...document.querySelectorAll('#tk-map-key .term')].map(e => [e.textContent, e.getAttribute('title') || '']),
    el: !!document.querySelector('#tk-map-slot > #tk-map.leaflet-container'),
  }));
  await q.waitForFunction(() => document.querySelectorAll('#tk-map .mn-task-pin').length > 0, null, { timeout: 10_000 });
  let mp = await mapNow();
  ok('the map pins each station with tasks: the overdue one red, the two at Fifteen Mile as one pin in progress',
    mp.el && mp.pins.length === 2 && mp.pins.some(x => x.n === '1' && /mn-task-late/.test(x.cls))
    && mp.pins.some(x => x.n === '2' && /mn-task-in_progress/.test(x.cls)) && /3 tasks at 2 stations/.test(mp.note), J(mp));
  ok('…with a key whose every colour says what it means', mp.keys.length >= 5 && mp.keys.every(([, m]) => m.length > 25), J(mp.keys));
  const wheel = () => q.evaluate(() => ({ pressed: document.getElementById('tk-map-wheel')?.getAttribute('aria-pressed'),
    zooms: Tasks._mapWheel() }));
  let wh = await wheel();
  ok('scroll to zoom is on to begin with, and its button says so', wh.pressed === 'true' && wh.zooms === true, J(wh));
  await q.click('#tk-map-wheel');
  wh = await wheel();
  const kept = await q.evaluate(() => localStorage.getItem('mn-tasks-map-wheel'));
  ok('…pressed, the wheel scrolls the page instead, remembered on this device',
    wh.pressed === 'false' && wh.zooms === false && kept === 'off', J({ wh, kept }));
  await q.click('#tk-map-wheel');
  ok('…and pressed again it zooms the map', J(await wheel()) === J({ pressed: 'true', zooms: true }));
  await q.evaluate(() => { window.__tkMap = document.getElementById('tk-map'); });
  await q.selectOption('#tk-f-status', 'any');
  mp = await mapNow();
  ok('a filter repaints the pins on the same map, and a general task is said to be off it',
    await q.evaluate(() => document.getElementById('tk-map') === window.__tkMap)
    && mp.pins.some(x => x.n === '2' && /mn-task-late/.test(x.cls)) && !/not on it/.test(mp.note), J(mp));
  await q.selectOption('#tk-f-status', 'live');
  await q.click('#tk-map .mn-task-in_progress .mn-task-badge');
  await q.waitForFunction(() => !!document.querySelector('#tk-map .tk-pop'), null, { timeout: 5_000 });
  const pop = await q.evaluate(() => document.querySelector('#tk-map .tk-pop').textContent.replace(/\s+/g, ' '));
  ok('pressing a pin lists the tasks there', /Replace the battery/.test(pop) && /Check the ALERT IDs/.test(pop) && !/orifice/.test(pop), pop);
  await q.evaluate(() => Tasks.render && document.querySelector('#tk-map .leaflet-popup-close-button')?.click());

  const terms = await q.evaluate(() => [...document.querySelectorAll('#main-content .term, #main-content .term-chip')]
    .map(e => [e.textContent.trim(), e.getAttribute('title') || '']));
  ok('every heading and chip that means something here says what, in a sentence',
    terms.length >= 8 && terms.every(([w, m]) => m.length > 25 && m.toLowerCase() !== w.toLowerCase()), J(terms.filter(([, m]) => m.length <= 25)));
  ok('…and the words are said without hovering, in a fold',
    await q.evaluate(() => /What the words on this page mean/.test(document.querySelector('.tk-words summary')?.textContent || '')
      && document.querySelectorAll('.tk-words dt').length >= 12));
  await q.selectOption('#tk-f-status', 'any');
  r = await rows();
  ok('Any status brings the finished one in', r.length === 4 && r.some(x => /Old job/.test(x)), J(r));
  await q.selectOption('#tk-f-scope', 'by_me');
  r = await rows();
  ok('Made by me: none for this member', r.length === 0, J(r));
  await q.selectOption('#tk-f-scope', 'mine');
  await q.selectOption('#tk-f-status', 'live');
  await q.click('#tk-f-q');
  await q.keyboard.type('fifteen');
  await settle(q);
  r = await rows();
  const qFocus = await q.evaluate(() => document.activeElement && document.activeElement.id);
  ok('the station box narrows by name as it is typed, keeping its focus',
    r.length === 2 && r.every(x => /battery|ALERT IDs/.test(x)) && qFocus === 'tk-f-q', J({ r, qFocus }));
  await q.fill('#tk-f-q', '');
  await q.dispatchEvent('#tk-f-q', 'input');
  await q.selectOption('#tk-f-team', 't-radio');
  r = await rows();
  ok('a team picked narrows to it', r.length === 0, J(r));
  await q.selectOption('#tk-f-team', '');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nOne task\n');
  await q.click('[data-k="open:k1"]');
  await q.waitForFunction(() => document.getElementById('tk-task-h')?.textContent === 'Clear the orifice line', null, { timeout: 10_000 });
  let page1 = await q.evaluate(() => ({
    facts: document.querySelector('.tk-facts').textContent.replace(/\s+/g, ' '),
    details: document.querySelector('.tk-details')?.textContent,
    thread: [...document.querySelectorAll('.tk-thread li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
    options: [...document.querySelectorAll('#tk-u-status option')].map(o => o.value),
    manage: !!document.getElementById('tk-manage'),
    focus: document.activeElement && document.activeElement.id,
  }));
  ok('opened from its row: the station, team, status, due, who made it, the details with their lines, and the thread',
    /Loudoun Br AL/.test(page1.facts) && /Brisbane Hub/.test(page1.facts) && /Open/.test(page1.facts) && /overdue/.test(page1.facts)
    && /Olive Owner/.test(page1.facts) && page1.details === 'Silt at the outlet.\nTake the auger.'
    && page1.thread.length === 2 && /Olive Owner made it, for Brisbane Hub/.test(page1.thread[0]) && /Gate key is at the depot/.test(page1.thread[1]),
    J(page1));
  ok('…focus on its heading', page1.focus === 'tk-task-h', page1.focus);
  ok('its team is offered every status but Cancelled, and no hand-over', !page1.options.includes('cancelled')
    && page1.options.length === 4 && !page1.manage, J(page1.options));
  await q.click('#tk-u-save');
  await settle(q);
  ok('nothing to save says so', /Nothing to save/.test(await main(q)));
  await q.selectOption('#tk-u-status', 'in_progress');
  await q.fill('#tk-u-note', 'On it this week.');
  await q.click('#tk-u-save');
  await q.waitForFunction(() => /In progress/.test(document.querySelector('.tk-facts')?.textContent || '')
    && document.querySelectorAll('.tk-thread li').length === 3, null, { timeout: 10_000 });
  const upd = calls('task_update');
  page1 = await q.evaluate(() => ({ last: [...document.querySelectorAll('.tk-thread li')].pop().textContent.replace(/\s+/g, ' ').trim(),
    focus: document.activeElement && document.activeElement.id, note: document.getElementById('tk-u-note').value }));
  ok('Save sends the status and the note together, and the thread says who moved it and what they wrote',
    upd.length === 1 && J(upd[0].a) === J({ p_id: 'k1', p_change: { status: 'in_progress', note: 'On it this week.' } })
    && /You moved it from Open to In progress/.test(page1.last) && /On it this week/.test(page1.last) && page1.note === '',
    J({ a: upd.map(c => c.a), page1 }));
  ok('…focus stays on Save', page1.focus === 'tk-u-save', page1.focus);
  await q.click('#tk-back');
  await q.waitForFunction(() => !!document.querySelector('#tk-table table'), null, { timeout: 10_000 });

  // Somebody who hands out tasks: hand it over, change it, cancel it.
  await as(q, 'sort');
  await q.evaluate(() => Tasks.authChanged());
  await q.waitForFunction(() => !!document.querySelector('#tk-table table'), null, { timeout: 10_000 });
  r = await rows();
  ok('somebody who hands out tasks starts on every task still going, the unassigned among them',
    r.length === 5 && r.some(x => /Order spare radios/.test(x)), J(r));
  await q.evaluate(() => Tasks.open('k5'));
  await q.waitForFunction(() => document.getElementById('tk-task-h')?.textContent === 'Order spare radios', null, { timeout: 10_000 });
  ok('an unassigned task says so, with what it means', await q.evaluate(() =>
    [...document.querySelectorAll('.tk-facts .term')].some(t => t.textContent === 'Unassigned' && /waits/.test(t.title))));
  ok('whoever manages it has the form to change it in view, not folded away',
    await q.evaluate(() => { const m = document.getElementById('tk-manage'); return !!m && m.tagName === 'SECTION' && m.offsetParent !== null
      && !document.getElementById('tk-u-save'); }));
  await q.selectOption('#tk-e-team', 't-radio');
  await q.click('#tk-e-save');
  await q.waitForFunction(() => /Radio licensing/.test(document.querySelector('.tk-facts')?.textContent || ''), null, { timeout: 10_000 });
  ok('it is handed to a team, and the thread says from and to',
    J(calls('task_update').pop().a) === J({ p_id: 'k5', p_change: { team_id: 't-radio' } })
    && /handed it from no team to Radio licensing/.test(await main(q)), J(calls('task_update').pop()));
  await q.fill('#tk-e-title', 'Order four spare radios');
  await q.fill('#tk-e-due', '2026-11-30');
  await q.click('#tk-e-save');
  await q.waitForFunction(() => document.getElementById('tk-task-h')?.textContent === 'Order four spare radios', null, { timeout: 10_000 });
  ok('its words and date are changed, the thread saying which',
    J(calls('task_update').pop().a.p_change) === J({ title: 'Order four spare radios', due_on: '2026-11-30' })
    && /changed its title, due date/.test(await main(q)), J(calls('task_update').pop()));
  ok('…and Cancelled is offered to them', await q.evaluate(() => [...document.querySelectorAll('#tk-e-status option')].some(o => o.value === 'cancelled')));
  await q.selectOption('#tk-e-status', 'cancelled');
  await q.click('#tk-e-save');
  await q.waitForSelector('[data-ask="yes"]', { timeout: 5000 });
  const asked = await q.evaluate(() => document.querySelector('[data-ask="yes"]').textContent);
  await q.click('[data-ask="no"]');
  await settle(q);
  ok('a cancel asks first, as something with weight, and a no sends nothing',
    asked === 'Cancel the task' && calls('task_update').length === 3, J({ asked, n: calls('task_update').length }));
  await q.click('#tk-e-reset');
  await settle(q);
  await q.selectOption('#tk-e-team', 't-ote');
  await q.selectOption('#tk-e-status', 'waiting');
  await q.click('#tk-e-station');
  await q.waitForSelector('#tk-e-q', { timeout: 5000 });
  await q.keyboard.type('loudoun br');
  await q.waitForSelector('[data-k="epick:loudoun_br_al"]', { timeout: 5000 });
  await q.click('[data-k="epick:loudoun_br_al"]');
  await q.fill('#tk-e-note', 'Needs OTE to quote first.');
  await q.click('#tk-e-save');
  await q.waitForFunction(() => /OTE/.test(document.querySelector('.tk-facts')?.textContent || '')
    && /Loudoun/.test(document.querySelector('.tk-facts')?.textContent || ''), null, { timeout: 10_000 });
  ok('team, status, station and a note are changed together, in one call',
    calls('task_update').length === 4 && J(calls('task_update').pop().a.p_change)
      === J({ team_id: 't-ote', status: 'waiting', station_id: 'loudoun_br_al', note: 'Needs OTE to quote first.' })
    && /Needs OTE to quote first/.test(await main(q)), J(calls('task_update').pop()));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nChanging tasks in the list\n');
  await q.click('#tk-back');
  await q.waitForFunction(() => !!document.querySelector('#tk-table table'), null, { timeout: 10_000 });
  const n0 = calls('task_update').length;
  const lastUpd = () => calls('task_update').slice(-1)[0];
  await q.selectOption('[data-k="team:k5"]', 't-radio');
  await q.waitForFunction(() => /handed to Radio licensing/.test(document.getElementById('tk-table')?.textContent || ''), null, { timeout: 10_000 });
  let cell = await q.evaluate(() => ({ v: document.querySelector('[data-k="team:k5"]').value,
    focus: document.activeElement && document.activeElement.dataset.k, view: Tasks._state().view }));
  ok('a team picked in a row hands it over there, the list staying open and focus on the picker',
    J(lastUpd().a) === J({ p_id: 'k5', p_change: { team_id: 't-radio' } }) && cell.v === 't-radio'
    && cell.focus === 'team:k5' && cell.view === 'list', J({ a: lastUpd().a, cell }));
  await q.selectOption('[data-k="status:k5"]', 'in_progress');
  await q.waitForFunction(() => document.querySelector('[data-k="status:k5"]')?.value === 'in_progress'
    && !document.querySelector('[data-k="status:k5"]').disabled, null, { timeout: 10_000 });
  ok('a status picked in a row moves it on', J(lastUpd().a.p_change) === J({ status: 'in_progress' }), J(lastUpd().a));
  await q.fill('[data-k="due:k5"]', '2026-12-05');
  await q.waitForFunction(() => /due 05\/12\/2026/.test(document.getElementById('tk-table')?.textContent || ''), null, { timeout: 10_000 });
  ok('a date put in a row sets its due date', J(lastUpd().a.p_change) === J({ due_on: '2026-12-05' }), J(lastUpd().a));
  await q.click('[data-k="rename:k5"]');
  await q.waitForSelector('[data-k="title:k5"]', { timeout: 5000 });
  ok('✎ turns the title into a box, with focus in it',
    await q.evaluate(() => document.activeElement && document.activeElement.dataset.k === 'title:k5'));
  await q.keyboard.press('Escape');
  await settle(q);
  ok('…Escape puts it back, sending nothing', !(await q.$('[data-k="title:k5"]')) && calls('task_update').length === n0 + 3);
  await q.click('[data-k="rename:k5"]');
  await q.fill('[data-k="title:k5"]', 'Order five spare radios');
  await q.press('[data-k="title:k5"]', 'Enter');
  await q.waitForFunction(() => /Order five spare radios/.test(document.querySelector('[data-k="open:k5"]')?.textContent || ''), null, { timeout: 10_000 });
  ok('…and Enter renames it', J(lastUpd().a.p_change) === J({ title: 'Order five spare radios' }) && calls('task_update').length === n0 + 4, J(lastUpd().a));
  await q.selectOption('[data-k="status:k5"]', 'cancelled');
  await q.waitForSelector('[data-ask="no"]', { timeout: 5000 });
  await q.click('[data-ask="no"]');
  await settle(q);
  ok('a cancel from a row asks first, and a no sends nothing and puts the picker back',
    calls('task_update').length === n0 + 4 && await q.evaluate(() => document.querySelector('[data-k="status:k5"]').value === 'in_progress'));
  ok('clicking a row\'s picker does not open the task', (await q.evaluate(() => Tasks._state().view)) === 'list');
  await q.selectOption('[data-k="status:k5"]', 'done');
  await q.waitForFunction(() => !document.querySelector('[data-k="status:k5"]'), null, { timeout: 10_000 });
  ok('a task marked done leaves the Not finished list, and the page says why',
    /left the list/.test(await q.evaluate(() => document.getElementById('tk-table').textContent)));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nA new task\n');
  if (await q.$('#tk-back')) await q.click('#tk-back');
  await q.waitForSelector('#tk-new-btn', { timeout: 10_000 });
  await q.click('#tk-new-btn');
  await q.waitForSelector('#tk-n-q', { timeout: 5000 });
  await q.click('#tk-n-go');
  await settle(q);
  ok('handing out without a station says to pick one, or tick that it is general', /Pick the station, or tick/.test(await main(q)));
  await q.click('#tk-n-q');
  await q.keyboard.type('loudoun br');
  await settle(q);
  const picks = await q.evaluate(() => ({ list: [...document.querySelectorAll('.tk-picks button')].map(b => b.textContent.trim()),
    focus: document.activeElement && document.activeElement.id }));
  ok('the station is found by its name as it is typed, the box keeping focus',
    picks.list.length >= 1 && picks.list.includes('Loudoun Br AL 541155') && picks.list.every(x => /^Loudoun/.test(x))
    && picks.focus === 'tk-n-q', J(picks));
  await q.click('[data-k="pick:loudoun_br_al"]');
  await settle(q);
  ok('picked, it is named, and focus moves to the title', await q.evaluate(() =>
    /Loudoun Br AL \(541155\)/.test(document.querySelector('.tk-picked')?.textContent || '') && document.activeElement.id === 'tk-n-title'));
  await q.fill('#tk-n-title', 'Trim the trees over the gauge');
  await q.fill('#tk-n-details', 'Two of them.');
  await q.selectOption('#tk-n-team', 't-bris');
  await q.fill('#tk-n-due', '2026-11-20');
  await q.click('#tk-n-go');
  await q.waitForFunction(() => document.getElementById('tk-task-h')?.textContent === 'Trim the trees over the gauge', null, { timeout: 10_000 });
  ok('Hand it out sends one task, and opens it',
    J(calls('task_create').pop().a) === J({ p_tasks: [{ title: 'Trim the trees over the gauge', details: 'Two of them.', team_id: 't-bris',
      station_id: 'loudoun_br_al', due_on: '2026-11-20' }] }), J(calls('task_create').pop()));

  // An owner: their own team only.
  const madeBefore = calls('task_create').length;
  await as(q, 'owner');
  await q.evaluate(() => Tasks.authChanged());
  await q.waitForSelector('#tk-new-btn', { timeout: 10_000 });
  await q.click('#tk-new-btn');
  await q.waitForSelector('#tk-n-team', { timeout: 5000 });
  const opts = await q.evaluate(() => [...document.querySelectorAll('#tk-n-team option')].filter(o => !o.disabled).map(o => o.value));
  ok('an owner is offered their own team and no other', J(opts) === J(['t-bris']), J(opts));
  await q.check('#tk-n-general');
  await q.fill('#tk-n-title', 'A general job');
  await q.click('#tk-n-go');
  await settle(q);
  ok('…and told to pick it before handing out, nothing sent', /Pick your team/.test(await main(q)) && calls('task_create').length === madeBefore);
  await q.click('#tk-n-cancel');
  await q.waitForFunction(() => !!document.querySelector('#tk-table'), null, { timeout: 10_000 });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nMy teams\n');
  await as(q, 'member');
  await q.evaluate(() => Tasks.authChanged());
  await q.waitForSelector('#tk-teams-h', { timeout: 10_000 });
  let mt = await q.evaluate(() => ({
    text: document.getElementById('tk-teams').textContent.replace(/\s+/g, ' '),
    mails: document.querySelectorAll('#tk-teams .tk-mail').length, add: document.querySelectorAll('#tk-teams .tk-add').length,
  }));
  ok('a member sees their team\'s roster — names, no addresses — and no way to change it',
    /Olive Owner/.test(mt.text) && /Max Member/.test(mt.text) && mt.mails === 0 && mt.add === 0, J(mt).slice(0, 300));
  await as(q, 'owner');
  await q.evaluate(() => Tasks.authChanged());
  await q.waitForSelector('#tk-add-t-bris', { timeout: 10_000 });
  ok('an owner sees the addresses, and the box that adds', await q.evaluate(() =>
    [...document.querySelectorAll('#tk-teams .tk-mail')].map(e => e.textContent).join() === 'owner@example.test,member@example.test'));
  await q.fill('#tk-add-t-bris', 'waiting@example.test');
  await q.click('[data-k="add:t-bris"]');
  await q.waitForFunction(() => /not approved/.test(document.getElementById('tk-teams').textContent), null, { timeout: 10_000 });
  ok('a waiting account is refused in words, the address kept', await q.evaluate(() => document.getElementById('tk-add-t-bris').value === 'waiting@example.test'));
  await q.fill('#tk-add-t-bris', 'new@example.test');
  await q.click('[data-k="add:t-bris"]');
  await q.waitForFunction(() => /Nell New/.test(document.getElementById('tk-teams').textContent), null, { timeout: 10_000 });
  mt = await q.evaluate(() => ({ box: document.getElementById('tk-add-t-bris').value, focus: document.activeElement && document.activeElement.dataset.k }));
  ok('an owner adds somebody by address: on the roster, the box emptied, focus on Add',
    J(calls('team_member_save').pop().a) === J({ p_team_id: 't-bris', p_email: 'new@example.test', p_owner: null })
    && mt.box === '' && mt.focus === 'add:t-bris', J(mt));
  await q.click('[data-k="off:t-bris:u-new"]');
  await q.waitForSelector('[data-ask="yes"]', { timeout: 5000 });
  await q.click('[data-ask="yes"]');
  await q.waitForFunction(() => !/Nell New/.test(document.getElementById('tk-teams').textContent), null, { timeout: 10_000 });
  ok('Take off… asks, then takes them off', J(calls('team_member_remove').pop().a) === J({ p_team_id: 't-bris', p_user_id: 'u-new' }));
  ok('an owner is offered no Take off for an owner', await q.evaluate(() => !document.querySelector('[data-k="off:t-bris:u-own"]')));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nThe station\'s card\n');
  store.calls = [];
  await as(q, 'member');
  await q.evaluate(() => { Tasks.authChanged(); switchTab('stations'); });
  await q.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
  await q.evaluate(() => showStationCard('loudoun_br_al', { opener: null, select: false }));
  await q.waitForFunction(() => /still going here/.test(document.getElementById('mn-tasks-card-loudoun_br_al')?.textContent || ''), null, { timeout: 10_000 });
  const card = await q.evaluate(() => document.getElementById('mn-tasks-card-loudoun_br_al').textContent.replace(/\s+/g, ' ').trim());
  ok('a station\'s card lists its tasks still going, to somebody they are for, and not the finished one',
    /Clear the orifice line/.test(card) && /Trim the trees/.test(card) && !/Old job/.test(card)
    && J(calls('task_list').pop().a) === J({ p_station_id: 'loudoun_br_al', p_open_only: true }), card);
  ok('…with no New task for somebody who hands none out', !/New task here/.test(card));
  await as(q, 'sort');
  await q.evaluate(() => { Tasks.authChanged(); closeStnCard(false); showStationCard('loudoun_br_al', { opener: null, select: false }); });
  await q.waitForFunction(() => /New task here/.test(document.getElementById('mn-tasks-card-loudoun_br_al')?.textContent || ''), null, { timeout: 10_000 });
  await q.click('#mn-tasks-card-loudoun_br_al .tk-new-here');
  await q.waitForFunction(() => state.activeTab === 'tasks' && !!document.querySelector('.tk-picked'), null, { timeout: 10_000 });
  ok('New task here opens a new task at that station', /Loudoun Br AL/.test(await q.evaluate(() => document.querySelector('.tk-picked').textContent)));
  store.calls = [];
  await as(q, 'outsider');
  await q.evaluate(() => { Tasks.authChanged(); switchTab('stations'); });
  await q.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
  await q.evaluate(() => showStationCard('loudoun_br_al', { opener: null, select: false }));
  await settle(q);
  ok('anybody else gets no section, and nothing is asked', await q.evaluate(() => !document.getElementById('mn-tasks-card-loudoun_br_al'))
    && calls('task_list').length === 0, J(store.calls));

  // The Stations map's Tasks view: the same pins, for the person's own tasks.
  store.calls = [];
  await as(q, 'member');
  await q.evaluate(() => { Tasks.authChanged(); switchTab('stations'); });
  await q.waitForFunction(() => !!state.map, null, { timeout: LOAD_TIMEOUT });
  await q.evaluate(() => { closeStnCard(false); state.map.setView([-16.9, 145.7], 9, { animate: false }); });
  await settle(q);
  await q.evaluate(() => MapViews.apply('tasks'));
  await q.waitForFunction(() => MapTasks._groups().length > 0, null, { timeout: 10_000 });
  await q.waitForTimeout(600);
  ok('…turned on, the map moves to take in every station with a task',
    await q.evaluate(() => ['fifteen_mile_al', 'loudoun_br_al'].every(id => {
      const st = state.data.stations.find(x => x.id === id);
      return state.map.getBounds().contains([st.lat, st.lon]);
    })));
  const lay = await q.evaluate(() => ({ g: MapTasks._groups(), badges: document.querySelectorAll('.mn-task-badge').length,
    note: MapTasks._note(), on: state.mapTasks, links: state.mapShowLinks, view: MapViews.active() }));
  ok('the Stations map\'s Tasks view rings the member\'s stations with unfinished tasks (Loudoun has the one made above too), and draws no radio paths',
    lay.on && lay.links === false && lay.view === 'tasks' && lay.badges >= 1
    && J(lay.g.map(x => `${x.id}:${x.n}:${x.key}`).sort()) === J(['fifteen_mile_al:2:in_progress', 'loudoun_br_al:2:late']), J(lay));
  await as(q, 'outsider');
  await q.evaluate(() => Tasks.authChanged());
  await settle(q);
  ok('…and for anybody tasks are not for, no pin and the note says why',
    await q.evaluate(() => MapTasks._groups().length === 0 && document.querySelectorAll('.mn-task-badge').length === 0
      && MapTasks._note().kind === 'not-yours'));
  await q.evaluate(() => MapTasks.setEnabled(false));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nAdmin › Teams\n');
  store.calls = [];
  await as(q, 'radio');
  await q.evaluate(() => { AdminTeams.authChanged(); switchTab('admin'); });
  await q.waitForSelector('#adm-teams-h', { timeout: 10_000 });
  out = await q.evaluate(() => ({ text: document.getElementById('adm-teams').textContent.replace(/\s+/g, ' '),
    controls: document.querySelectorAll('#adm-teams input, #adm-teams select, #adm-teams button').length }));
  ok('somebody not an administrator is shown what the panel is for, and no control',
    /for administrators/.test(out.text) && out.controls === 0 && calls('teams_read').length === 0, J(out));
  await as(q, 'admin');
  await q.evaluate(() => { AdminTeams.authChanged(); });
  await q.waitForSelector('.adm-teams-table', { timeout: 10_000 });
  const adm = await q.evaluate(() => [...document.querySelectorAll('.adm-teams-table tbody tr')].map(tr => [...tr.children].map(c => c.textContent.trim())));
  ok('an administrator sees every team: its hub, whether it hands out tasks, its owners, its people and its tasks',
    adm.length === 4 && J(adm.find(x => x[0] === 'Brisbane Hub')) === J(['Brisbane Hub', 'Brisbane Hub', 'No', 'Olive Owner', '2', '5'])
    && adm.find(x => x[0] === 'OTE')[3] === 'none yet' && adm.find(x => x[0] === 'SoRT Forum')[2] === 'Yes', J(adm));
  await q.fill('#adm-team-new-name', 'Cairns electrical');
  await q.selectOption('#adm-team-new-hub', 'cairns');
  await q.click('#adm-team-new-go');
  await q.waitForFunction(() => document.getElementById('adm-team-h')?.textContent === 'Cairns electrical', null, { timeout: 10_000 });
  ok('Make the team sends its name and hub, and opens it to name its owners',
    J(calls('team_save').pop().a) === J({ p_id: null, p_name: 'Cairns electrical', p_hub_id: 'cairns', p_hands_out: false })
    && /Nobody is on it yet/.test(await q.evaluate(() => document.getElementById('adm-team-open').textContent)));
  const newId = await q.evaluate(() => AdminTeams._state().openId);
  await q.evaluate(() => Admin.load());
  out = await q.evaluate(id => ({ list: document.getElementById(`adm-team-add-${id}`).getAttribute('list'),
    opts: [...document.querySelectorAll('#adm-team-people option')].map(o => [o.value, o.label]) }), newId);
  ok('the Add somebody box offers every approved account by address, its name beside it, and no waiting one',
    out.list === 'adm-team-people' && out.opts.length === Object.values(PEOPLE).filter(x => !x.waiting).length
    && out.opts.some(o => o[0] === 'radio@example.test' && o[1] === 'Rae Radio')
    && !out.opts.some(o => o[0] === 'waiting@example.test')
    && J(out.opts.map(o => o[0])) === J(out.opts.map(o => o[0]).sort()), J(out));
  await q.fill(`#adm-team-add-${newId}`, 'radio@example.test');
  await q.check(`#adm-team-add-own-${newId}`);
  await q.click(`[data-k="add:${newId}"]`);
  await q.waitForFunction(() => /Rae Radio/.test(document.getElementById('adm-team-open').textContent), null, { timeout: 10_000 });
  ok('an administrator names an owner by address', J(calls('team_member_save').pop().a) === J({ p_team_id: newId, p_email: 'radio@example.test', p_owner: true }));
  out = await q.evaluate(() => [...document.querySelectorAll('#adm-team-people option')].map(o => o.value));
  ok('…and somebody on the team is offered no more', out.length && !out.includes('radio@example.test'), J(out));
  await q.uncheck(`[data-k="own:${newId}:u-rad"]`);
  await q.waitForFunction(id => !document.querySelector(`[data-k="own:${id}:u-rad"]`).checked && !document.querySelector(`[data-k="own:${id}:u-rad"]`).disabled, newId, { timeout: 10_000 });
  ok('…and makes them an owner no more, the box keeping focus',
    J(calls('team_member_save').pop().a) === J({ p_team_id: newId, p_email: 'radio@example.test', p_owner: false })
    && await q.evaluate(id => document.activeElement && document.activeElement.dataset.k === `own:${id}:u-rad`, newId));
  await q.click('[data-k="team:t-bris"]');
  await q.waitForFunction(() => document.getElementById('adm-team-h')?.textContent === 'Brisbane Hub', null, { timeout: 10_000 });
  await q.click('#adm-team-remove');
  await q.waitForSelector('[data-ask="yes"]', { timeout: 5000 });
  await q.click('[data-ask="yes"]');
  await q.waitForFunction(() => /handed to it, so it stays/.test(document.getElementById('adm-teams').textContent), null, { timeout: 10_000 });
  ok('removing a team tasks were handed to is refused in the database\'s words', calls('team_remove').length === 1);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTags\n');
  store = freshStore();
  await as(q, 'member');
  await q.evaluate(() => { Tasks.authChanged(); switchTab('tasks'); });
  await q.waitForFunction(() => document.querySelectorAll('#tk-table tbody tr').length > 0 && !!document.getElementById('tk-f-tag'), null, { timeout: 10_000 });
  const rowTags = () => q.evaluate(() => Object.fromEntries([...document.querySelectorAll('#tk-table tbody tr')].map(tr => [
    tr.querySelector('.row-open').textContent.trim(), [...tr.querySelectorAll('.tk-tag')].map(e => [e.textContent.trim(), e.getAttribute('title') || ''])])));
  let rt = await rowTags();
  ok('a task\'s tags are chips on its row, each saying what it means',
    J(rt['Replace the battery'].map(x => x[0])) === J(['RTS']) && /^Return to service/.test(rt['Replace the battery'][0][1])
    && rt['Clear the orifice line'].length === 0, J(rt));
  await q.selectOption('#tk-f-tag', 'g-rts');
  r = await rows();
  ok('the Tag filter narrows to a tag', r.length === 1 && /Replace the battery/.test(r[0]), J(r));
  await q.selectOption('#tk-f-tag', '-');
  r = await rows();
  ok('…and No tag to the tasks without one', r.length === 2 && !r.some(x => /battery/.test(x)), J(r));
  await q.selectOption('#tk-f-tag', '');
  ok('the fold says what each tag means without hovering', await q.evaluate(() =>
    [...document.querySelectorAll('.tk-words-tags dd')].map(e => e.textContent).filter(t => /Return to service|Quality assurance|FWIN site assessment/.test(t)).length === 3));

  // Its team tags it: a tag pressed, a new one typed and given its meaning.
  await q.click('[data-k="open:k1"]');
  await q.waitForSelector('#tk-tags-work', { timeout: 10_000 });
  await q.click('[data-k="tag:work:qa"]');
  ok('pressing a tag puts it on, and the button says so, keeping focus', await q.evaluate(() => {
    const b = document.querySelector('[data-k="tag:work:qa"]');
    return b.getAttribute('aria-pressed') === 'true' && document.activeElement === b;
  }));
  await q.click('#tk-tag-in-work');
  const offered = await q.evaluate(() => [...document.querySelectorAll('#tk-tag-names-work option')].map(o => o.value));
  ok('the box offers the tags in use that it does not have yet', J(offered.sort()) === J(['Assessment', 'RTS']), J(offered));
  await q.keyboard.type('Fence');
  ok('…and says a name nobody has used is a new tag', /“Fence” is a new tag/.test(await q.evaluate(() => document.getElementById('tk-tag-hint-work').textContent)));
  await q.keyboard.press('Enter');
  await settle(q);
  const fresh = await q.evaluate(() => ({ chip: !!document.querySelector('[data-k="tag:work:fence"][aria-pressed="true"]'),
    focus: document.activeElement && document.activeElement.dataset.k }));
  ok('Enter puts it on, and asks what it means', fresh.chip && fresh.focus === 'tagmean:work:fence', J(fresh));
  await q.keyboard.type('Fence work at the site.');
  await q.click('#tk-u-save');
  await q.waitForFunction(() => /tagged it/.test(document.querySelector('.tk-thread')?.textContent || ''), null, { timeout: 10_000 });
  ok('Save sends the tags — the new one with its meaning — once',
    J(calls('task_update').pop().a) === J({ p_id: 'k1', p_change: { tags: ['QA', { name: 'Fence', meaning: 'Fence work at the site.' }] } }),
    J(calls('task_update').pop()));
  ok('…the thread says it was tagged, and the new tag is offered from then on',
    /You tagged it Fence QA/.test((await main(q)).replace(/\s+/g, ' '))
    && await q.evaluate(() => Tasks.tags().some(g => g.name === 'Fence' && g.meaning === 'Fence work at the site.')));
  await q.click('[data-k="tag:work:fence"]');
  await q.click('#tk-u-save');
  await q.waitForFunction(() => /took off/.test(document.querySelector('.tk-thread')?.textContent || ''), null, { timeout: 10_000 });
  ok('taking one off is sent as the list as it is to be, and threaded as taken off',
    J(calls('task_update').pop().a.p_change) === J({ tags: ['QA'] }) && /took off Fence/.test((await main(q)).replace(/\s+/g, ' ')));
  const nUpd = calls('task_update').length;
  await q.click('#tk-u-save');
  await settle(q);
  ok('nothing changed is said, and nothing sent', calls('task_update').length === nUpd && /Nothing to save/.test(await main(q)));

  // A new task with its tags.
  await as(q, 'sort');
  await q.evaluate(() => { Tasks.authChanged(); });
  await q.waitForSelector('#tk-new-btn', { timeout: 10_000 });
  await q.evaluate(() => Tasks.newAt('loudoun_br_al'));
  await q.waitForSelector('#tk-tags-new', { timeout: 5000 });
  await q.fill('#tk-n-title', 'Bring the gauge back');
  await q.click('[data-k="tag:new:rts"]');
  await q.selectOption('#tk-n-team', 't-bris');
  await q.click('#tk-n-go');
  await q.waitForFunction(() => document.getElementById('tk-task-h')?.textContent === 'Bring the gauge back', null, { timeout: 10_000 });
  ok('a new task is sent with its tags, and opens showing them',
    J(calls('task_create').pop().a.p_tasks[0].tags) === J(['RTS'])
    && /TagsRTS/.test(await q.evaluate(() => document.querySelector('.tk-facts').textContent.replace(/\s+/g, ' '))), J({ sent: calls('task_create').pop().a, facts: await q.evaluate(() => document.querySelector('.tk-facts').textContent.replace(/\s+/g, ' ')) }));

  // Admin › Tags.
  store.calls = [];
  await as(q, 'member');
  await q.evaluate(() => { AdminTags.authChanged(); switchTab('admin'); });
  await q.waitForSelector('#adm-tags-h', { timeout: 10_000 });
  out = await q.evaluate(() => ({ text: document.getElementById('adm-tags').textContent.replace(/\s+/g, ' '),
    controls: document.querySelectorAll('#adm-tags input, #adm-tags select, #adm-tags button').length }));
  ok('Admin › Tags shows anybody not an administrator what it is for, no control, and asks nothing',
    /tidied here by administrators/.test(out.text) && out.controls === 0 && calls('tags_read').length === 0, J(out));
  await as(q, 'admin');
  await q.evaluate(() => AdminTags.authChanged());
  await q.waitForSelector('.adm-tags-table', { timeout: 10_000 });
  const tagRows = () => q.evaluate(() => [...document.querySelectorAll('.adm-tags-table tbody tr')].map(tr => [...tr.children].map(c => c.textContent.replace(/\s+/g, ' ').trim())));
  let tr2 = await tagRows();
  ok('an administrator sees every tag, what it means and how many tasks have it',
    tr2.length === 4 && tr2.find(x => x[0] === 'RTS')[2] === '2' && tr2.find(x => x[0] === 'Fence')[2] === '0'
    && /^Quality assurance/.test(tr2.find(x => x[0] === 'QA')[1]), J(tr2));
  await q.click('[data-k="tag:g-qa"]');
  await q.waitForSelector('#adm-tag-name', { timeout: 5000 });
  await q.fill('#adm-tag-name', 'Q.A.');
  await q.check('#adm-tag-retired');
  await q.click('#adm-tag-save');
  await q.waitForFunction(() => /Q\.A\. saved — retired/.test(document.getElementById('adm-tags').textContent), null, { timeout: 10_000 });
  ok('renamed and retired, in one Save', J(calls('tag_save').pop().a) === J({ p_id: 'g-qa', p_name: 'Q.A.', p_meaning:
    'Quality assurance: checking that a station\'s readings, or the work done at it, are right.', p_colour: 'blue', p_retired: true }));
  await q.evaluate(() => { Tasks.authChanged(); switchTab('tasks'); });
  await q.waitForFunction(() => Tasks.tags().length > 0 && !!document.getElementById('tk-f-tag'), null, { timeout: 10_000 });
  await q.evaluate(() => Tasks.newAt('loudoun_br_al'));
  await q.waitForSelector('#tk-tags-new', { timeout: 5000 });
  out = await q.evaluate(() => ({ offered: [...document.querySelectorAll('#tk-tags-new .tk-tag-opt')].map(b => b.dataset.name) }));
  ok('…a retired tag is no longer offered', !out.offered.includes('Q.A.') && out.offered.includes('RTS'), J(out));
  await q.evaluate(() => Tasks.back());
  await q.waitForSelector('#tk-table', { timeout: 5000 });
  rt = await rowTags();
  ok('…but stays on the task that has it', rt['Clear the orifice line'].map(x => x[0]).includes('Q.A.'), J(rt));
  await q.evaluate(() => switchTab('admin'));
  await q.waitForSelector('.adm-tags-table', { timeout: 10_000 });
  const fenceId = await q.evaluate(() => Tasks.tags().find(g => g.name === 'Fence').id);
  await q.click(`[data-k="tag:${fenceId}"]`);
  await q.waitForSelector('#adm-tag-into', { timeout: 5000 });
  await q.selectOption('#adm-tag-into', 'g-asm');
  await q.click('#adm-tag-merge');
  await q.waitForSelector('[data-ask="yes"]', { timeout: 5000 });
  await q.click('[data-ask="yes"]');
  await q.waitForFunction(() => /Fence is merged into Assessment/.test(document.getElementById('adm-tags').textContent), null, { timeout: 10_000 });
  tr2 = await tagRows();
  ok('merging one into another is asked first, sent once, and the one merged is gone',
    J(calls('tag_merge').pop().a) === J({ p_from: fenceId, p_into: 'g-asm' }) && !tr2.some(x => x[0] === 'Fence'), J(tr2));
  await q.click('[data-k="tag:g-rts"]');
  await q.waitForSelector('#adm-tag-remove', { timeout: 5000 });
  ok('a tag on tasks cannot be removed here, and it says why', await q.evaluate(() =>
    document.getElementById('adm-tag-remove').disabled && /retire it/.test(document.getElementById('adm-tag-open').textContent)));
  await q.fill('#adm-tag-new-name', 'Solar');
  await q.fill('#adm-tag-new-meaning', 'Solar panel and charger work.');
  await q.click('#adm-tag-new-go');
  await q.waitForFunction(() => /Solar is a tag now/.test(document.getElementById('adm-tags').textContent), null, { timeout: 10_000 });
  ok('Make the tag sends its name and meaning', J(calls('tag_save').pop().a) === J({ p_id: null, p_name: 'Solar', p_meaning: 'Solar panel and charger work.', p_colour: null, p_retired: null }));
  const solarId = await q.evaluate(() => [...document.querySelectorAll('.adm-tags-table [data-k^="tag:"]')].find(b => b.getAttribute('aria-label') === 'Solar').dataset.k.slice(4));
  await q.click(`[data-k="tag:${solarId}"]`);
  await q.waitForSelector('#adm-tag-remove:not([disabled])', { timeout: 5000 });
  await q.click('#adm-tag-remove');
  await q.waitForSelector('[data-ask="yes"]', { timeout: 5000 });
  await q.click('[data-ask="yes"]');
  await q.waitForFunction(() => /Solar removed/.test(document.getElementById('adm-tags').textContent), null, { timeout: 10_000 });
  ok('…and one no task has is removed, asked first', calls('tag_remove').length === 1 && !(await tagRows()).some(x => x[0] === 'Solar'));
  await c5.close();

  ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await server.close();
}

console.log('');
console.log(`  ${passes + failures} assertion(s).`);
console.log('');
if (failures) {
  console.log(`FAIL — ${failures} of ${passes + failures}.`);
  process.exit(1);
}
console.log('PASS — tasks are seen by the people they are for, moved on by the right ones, and a SoRT hand-off makes nothing until it is checked.');
