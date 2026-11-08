// MegaNet — admin-teams.js
//
//   AdminTeams   the Admin tab's "Teams" panel (0095): every team — its name,
//                the maintenance hub it looks after, whether it hands out
//                tasks — made, renamed and removed here; and every roster,
//                where an administrator names a team's owners and adds or
//                takes off anybody. A team's owners add and take off its
//                members themselves, on the Tasks tab (tasks.js, My teams).
//
// After core.js and datastore.js (dbRpc), before admin.js, which draws it
// into #adm-teams and loads it from Admin.init(). Reads tasks.js's
// Tasks.WORDS at call time, so a word means one thing on both tabs, and
// admin.js's Admin.accounts() — admin_users(), asked once for the Users panel —
// for the approved accounts the Add somebody box suggests; Admin.load() calls
// accountsChanged() when they come back. Nothing here runs at load; auth.js
// calls authChanged() on every sign-in and out.
//
// This panel is not the security: team_save(), team_remove(),
// team_member_save() and team_member_remove() refuse anybody
// meganet.is_admin() says no to — an owner excepted, for the members of
// their own team — whatever is drawn here. teams_read() gives an
// administrator every roster, with addresses, and the hubs.

const AdminTeams = (function () {
  let read = null;            // teams_read()
  let loading = false, error = '', note = '', missing = false, busy = false;
  let openId = null;          // the team whose people and settings are open
  let make = { name: '', hub: '', hands: false };
  let edit = null;            // { id, name, hub, hands } for the open team
  const add = {};             // team id → { email, owner }

  const isAdmin = () => typeof Auth !== 'undefined' && Auth.isSignedIn()
    && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  const teams = () => (read && Array.isArray(read.teams) ? read.teams : []);
  const team = id => teams().find(t => t.id === id) || null;
  const hubs = () => (read && Array.isArray(read.hubs) ? read.hubs : []);

  // The accounts the open team's Add somebody box suggests: approved ones
  // (by an administrator, or by the allowlist) not on it already, by address.
  // admin_users() is the Users panel's; until it answers, nothing is offered.
  const ADDABLE = new Set(['approved', 'automatic']);
  function addable(t) {
    const all = typeof Admin !== 'undefined' && Admin.accounts ? Admin.accounts() : null;
    if (!Array.isArray(all) || !t) return [];
    const on = new Set((Array.isArray(t.roster) ? t.roster : []).map(p => p.id));
    return all.filter(u => u && u.email && ADDABLE.has(u.status) && !on.has(u.id))
      .sort((a, b) => String(a.email).toLowerCase().localeCompare(String(b.email).toLowerCase()));
  }
  const suggestHtml = t => addable(t).map(u => {
    const name = String(u.display_name || '').trim();
    return `<option value="${esc(u.email)}"${name && name.toLowerCase() !== String(u.email).toLowerCase() ? ` label="${esc(name)}"` : ''}></option>`;
  }).join('');

  // The words, from the Tasks tab's one list.
  const FALLBACK = {
    handsout: 'Members of a team marked this way may give a task to any team, and see every task. Administrators may too.',
    owner: 'Looks after a team\'s roster: adds and takes off its members by the address of their Flood-Net account — the one they sign in with, or a second address. An administrator names a team\'s owners.',
    hub: 'The maintenance hub the team looks after. A task SoRT hands over for a hub goes to its team. One team a hub.',
    second: 'Another address of the same person — an account of its own until an administrator made the two one. It does not sign in, but adding them to a team by it finds them.',
  };
  function word(k) {
    const w = typeof Tasks !== 'undefined' && Tasks.WORDS ? Tasks.WORDS[k] : null;
    return w || FALLBACK[k] || '';
  }

  // The address a person signs in with, and their second addresses (0100), to
  // the people who see addresses on a roster.
  function mailsHtml(p, cls) {
    const also = Array.isArray(p.also) ? p.also.filter(Boolean) : [];
    const own = p.email && p.email !== p.who ? `<div class="small txt-muted ${cls}">${esc(p.email)}</div>` : '';
    return own + also.map(a => `<div class="small txt-muted ${cls}">${esc(a)} · ${
      termHtml('second address', word('second'))}</div>`).join('');
  }

  function errText(err, what) {
    if (err && err.status === 404 && /function|PGRST202|schema cache/i.test(err.message || '')) {
      missing = true;
      return 'The database does not have teams yet — apply db/migrations/0095_teams_and_tasks.sql.';
    }
    return `Could not ${what}: ${err ? err.message : 'no answer'}`;
  }
  const dmy = ts => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ts || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };

  // ── Drawing ────────────────────────────────────────────────────────────────

  function hubOptions(cur) {
    const taken = new Map(teams().filter(t => t.hub_id).map(t => [t.hub_id, t]));
    return `<option value=""${cur ? '' : ' selected'}>No hub</option>` + hubs().map(h => {
      const by = taken.get(h.id);
      const other = by && (!edit || by.id !== edit.id) && by.id !== openId;
      return `<option value="${esc(h.id)}"${h.id === cur ? ' selected' : ''}>${esc(h.name)}${other ? ` — ${esc(by.name)}'s` : ''}</option>`;
    }).join('');
  }

  function rowHtml(t) {
    const r = Array.isArray(t.roster) ? t.roster : [];
    const ownersList = r.filter(p => p.owner).map(p => p.who || p.email);
    const open = openId === t.id;
    return `<tr class="row-link${open ? ' is-open' : ''}" onclick="AdminTeams.open('${escAttr(t.id)}')">
        <th scope="row"><button type="button" class="row-open" data-k="team:${escAttr(t.id)}" aria-expanded="${open}"
          onclick="event.stopPropagation(); AdminTeams.open('${escAttr(t.id)}')">${esc(t.name)}</button></th>
        <td>${t.hub ? esc(t.hub) : '<span class="txt-muted">—</span>'}</td>
        <td>${t.hands_out ? 'Yes' : '<span class="txt-muted">No</span>'}</td>
        <td>${ownersList.length ? esc(ownersList.join(', ')) : '<span class="txt-warn">none yet</span>'}</td>
        <td class="col-optional">${r.length}</td>
        <td class="col-optional">${Number(t.tasks) || 0}</td>
      </tr>`;
  }

  function rosterHtml(t) {
    const r = Array.isArray(t.roster) ? t.roster : [];
    const a = add[t.id] || { email: '', owner: false };
    const table = r.length ? `<div class="table-wrap"><table class="adm-table adm-team-roster">
        <caption class="sr-only">Who is on ${esc(t.name)}</caption>
        <thead><tr><th scope="col">Person</th><th scope="col">${termHtml('Owner', word('owner'))}</th>
          <th scope="col" class="col-optional">Added</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${r.map(p => `<tr>
          <th scope="row">${esc(p.who || p.email || '—')}${p.you ? ' <span class="badge">you</span>' : ''}${
            mailsHtml(p, 'adm-team-mail')}</th>
          <td><label class="check-label"><input type="checkbox" data-k="own:${escAttr(t.id)}:${escAttr(p.id)}"${p.owner ? ' checked' : ''}${busy ? ' disabled' : ''}
                onchange="AdminTeams.setOwner('${escAttr(t.id)}', '${escAttr(p.id)}', this.checked)"><span class="sr-only">${esc(p.who || p.email || '')} owns ${esc(t.name)}</span></label></td>
          <td class="small col-optional">${esc(dmy(p.added_at))}${p.added_by ? ` by ${esc(p.added_by)}` : ''}</td>
          <td><button type="button" class="exp-btn-sm" data-k="off:${escAttr(t.id)}:${escAttr(p.id)}"${busy ? ' disabled' : ''}
                onclick="AdminTeams.takeOff('${escAttr(t.id)}', '${escAttr(p.id)}')" aria-label="Take ${escAttr(p.who || p.email || '')} off ${escAttr(t.name)}">Take off…</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="small txt-warn">Nobody is on it yet. Name its owners first: they add the rest.</p>';
    return `${table}
      <form class="adm-tok-form adm-team-add" onsubmit="event.preventDefault(); AdminTeams.addPerson('${escAttr(t.id)}')">
        <label>Add somebody, by the address of their Flood-Net account
          <input type="email" id="adm-team-add-${escAttr(t.id)}" maxlength="254" autocomplete="off" spellcheck="false"
                 list="adm-team-people" value="${esc(a.email)}" oninput="AdminTeams.addField('${escAttr(t.id)}', 'email', this.value)"></label>
        <datalist id="adm-team-people">${suggestHtml(t)}</datalist>
        <label class="check-label"><input type="checkbox" id="adm-team-add-own-${escAttr(t.id)}"${a.owner ? ' checked' : ''}
          onchange="AdminTeams.addField('${escAttr(t.id)}', 'owner', this.checked)"><span>As an owner</span></label>
        <button type="submit" class="primary exp-btn-sm" data-k="add:${escAttr(t.id)}"${busy ? ' disabled' : ''}>Add to ${esc(t.name)}</button>
      </form>
      <p class="small txt-muted">They need an approved account first — waiting accounts are approved above. As you type, the approved accounts not on ${esc(t.name)} are offered.</p>`;
  }

  function openHtml() {
    const t = team(openId);
    if (!t) return '';
    const e = edit && edit.id === t.id ? edit : { id: t.id, name: t.name, hub: t.hub_id || '', hands: !!t.hands_out };
    return `<section class="adm-team-open" aria-labelledby="adm-team-h">
        <h3 id="adm-team-h" tabindex="-1">${esc(t.name)}</h3>
        <form class="adm-tok-form" onsubmit="event.preventDefault(); AdminTeams.saveEdit()">
          <label>Name <input type="text" id="adm-team-name" maxlength="80" value="${esc(e.name)}"
            oninput="AdminTeams.editField('name', this.value)"></label>
          <label>${termHtml('Hub', word('hub'))} <select id="adm-team-hub" onchange="AdminTeams.editField('hub', this.value)">${hubOptions(e.hub)}</select></label>
          <label class="check-label"><input type="checkbox" id="adm-team-hands"${e.hands ? ' checked' : ''}
            onchange="AdminTeams.editField('hands', this.checked)"><span>${termHtml('Hands out tasks', word('handsout'))}</span></label>
          <button type="submit" class="exp-btn-sm" id="adm-team-save"${busy ? ' disabled' : ''}>Save</button>
          <button type="button" class="exp-btn-sm adm-danger" id="adm-team-remove"${busy ? ' disabled' : ''}
            onclick="AdminTeams.remove('${escAttr(t.id)}')">Remove the team…</button>
        </form>
        ${rosterHtml(t)}
      </section>`;
  }

  function wordsHtml() {
    return `<details class="adm-team-words"><summary class="small">What the words here mean</summary>
        <dl class="small">
          <dt>Hands out tasks</dt><dd>${esc(word('handsout'))}</dd>
          <dt>Owner</dt><dd>${esc(word('owner'))}</dd>
          <dt>Hub</dt><dd>${esc(word('hub'))}</dd>
          <dt>Second address</dt><dd>${esc(word('second'))}</dd>
        </dl></details>`;
  }

  function render() {
    const head = `<div class="panel-header"><h2 id="adm-teams-h">Teams</h2>
        ${isAdmin() ? '<button type="button" class="exp-btn-sm" id="adm-teams-refresh" onclick="AdminTeams.load()">Refresh</button>' : ''}</div>`;
    if (!isAdmin()) {
      return `<div class="panel" aria-labelledby="adm-teams-h">${head}
        <p class="small">Who tasks are handed to — for administrators. A team's owners look after its members on the Tasks tab.</p></div>`;
    }
    let body = `<p class="small">The teams tasks are handed to. Make a team, link it to the maintenance hub it looks after, say
      whether it ${termHtml('hands out tasks', word('handsout'))}, and name its ${termHtml('owners', word('owner'))} — they add and take off
      the rest of its members on the Tasks tab. A roster is seen by administrators and by the people on that team, nobody else.</p>`;
    if (note) body += `<p class="small txt-ok" role="status">${esc(note)}</p>`;
    if (error) body += `<p class="small txt-bad" role="alert">${esc(error)}</p>`;
    if (loading && !read) body += '<p class="small" role="status">Loading…</p>';
    if (read && !missing) {
      body += `<div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="adm-teams-h"><table class="adm-table adm-teams-table">
          <caption class="sr-only">Every team, by name</caption>
          <thead><tr><th scope="col">Team</th><th scope="col">${termHtml('Hub', word('hub'))}</th>
            <th scope="col">${termHtml('Hands out tasks', word('handsout'))}</th><th scope="col">${termHtml('Owners', word('owner'))}</th>
            <th scope="col" class="col-optional">People</th><th scope="col" class="col-optional">Tasks</th></tr></thead>
          <tbody>${teams().length ? teams().map(rowHtml).join('') : '<tr><td colspan="6" class="small">No teams yet.</td></tr>'}</tbody>
        </table></div>
        <div id="adm-team-open">${openHtml()}</div>
        <h3 class="adm-req-h">Make a team</h3>
        <form class="adm-tok-form" onsubmit="event.preventDefault(); AdminTeams.make()">
          <label>Name <input type="text" id="adm-team-new-name" maxlength="80" value="${esc(make.name)}"
            oninput="AdminTeams.makeField('name', this.value)" placeholder="e.g. Townsville electrical"></label>
          <label>${termHtml('Hub', word('hub'))} <select id="adm-team-new-hub" onchange="AdminTeams.makeField('hub', this.value)">${hubOptions(make.hub)}</select></label>
          <label class="check-label"><input type="checkbox" id="adm-team-new-hands"${make.hands ? ' checked' : ''}
            onchange="AdminTeams.makeField('hands', this.checked)"><span>Hands out tasks</span></label>
          <button type="submit" class="primary" id="adm-team-new-go"${busy ? ' disabled' : ''}>Make the team</button>
        </form>
        ${wordsHtml()}`;
    }
    return `<div class="panel" aria-labelledby="adm-teams-h">${head}${body}</div>`;
  }

  function repaint(focus) {
    const el = document.getElementById('adm-teams');
    if (!el || state.activeTab !== 'admin') return;
    const a = document.activeElement;
    const key = focus || (a && el.contains(a) ? (a.id ? `#${a.id}` : a.dataset && a.dataset.k ? `k:${a.dataset.k}` : null) : null);
    el.innerHTML = render();
    if (!key) return;
    const back = key[0] === '#' ? document.getElementById(key.slice(1))
      : el.querySelector(`[data-k="${CSS.escape(key.slice(2))}"]`);
    if (back && !back.disabled) back.focus({ preventScroll: true });
  }

  async function load() {
    if (!isAdmin() || typeof dbRpc !== 'function') { repaint(); return; }
    loading = true; error = '';
    repaint();
    try {
      read = await dbRpc('teams_read', {});
      missing = false;
    } catch (err) {
      error = errText(err, 'load the teams');
    }
    loading = false;
    repaint();
  }

  // One change; teams_read() comes back and is drawn.
  async function call(fn, args, said, focus) {
    if (busy) return false;
    busy = true; error = ''; note = '';
    repaint(focus);
    let ok = false;
    try {
      const out = await dbRpc(fn, args);
      if (out && typeof out === 'object' && out.teams) read = out;
      note = said;
      announce(said);
      ok = true;
    } catch (err) {
      error = errText(err, 'change the teams');
    }
    busy = false;
    repaint(focus);
    return ok;
  }

  function authChanged() {
    read = null; error = ''; note = ''; missing = false; busy = false; openId = null; edit = null;
    if (state.activeTab === 'admin') { repaint(); if (isAdmin()) load(); }
  }

  // admin_users() answered: the open team's suggestions again, in place, so
  // the box being typed in keeps its words and its caret.
  function accountsChanged() {
    const dl = document.getElementById('adm-team-people');
    if (dl) dl.innerHTML = suggestHtml(team(openId));
  }

  return {
    render, load, authChanged, accountsChanged,
    open(id) {
      openId = openId === id ? null : id;
      edit = null;
      repaint(openId ? '#adm-team-h' : `k:team:${id}`);
    },
    makeField(k, v) { make[k] = v; },
    editField(k, v) {
      const t = team(openId);
      if (!t) return;
      if (!edit || edit.id !== t.id) edit = { id: t.id, name: t.name, hub: t.hub_id || '', hands: !!t.hands_out };
      edit[k] = v;
    },
    addField(id, k, v) { add[id] = { email: '', owner: false, ...(add[id] || {}), [k]: v }; },
    async make() {
      const name = make.name.trim();
      if (!name) { error = 'Give the team a name.'; repaint('#adm-team-new-name'); return; }
      const ok = await call('team_save', { p_id: null, p_name: name, p_hub_id: make.hub || null, p_hands_out: !!make.hands },
        `${name} is a team now. Name its owners: open it in the table.`, '#adm-team-new-go');
      if (ok) {
        const t = teams().find(x => x.name.toLowerCase() === name.toLowerCase());
        make = { name: '', hub: '', hands: false };
        openId = t ? t.id : null;
        repaint(openId ? '#adm-team-h' : '#adm-team-new-name');
      }
    },
    async saveEdit() {
      const t = team(openId);
      if (!t) return;
      const e = edit && edit.id === t.id ? edit : { name: t.name, hub: t.hub_id || '', hands: !!t.hands_out };
      if (!e.name.trim()) { error = 'A team needs a name.'; repaint('#adm-team-name'); return; }
      const ok = await call('team_save', { p_id: t.id, p_name: e.name.trim(), p_hub_id: e.hub || null, p_hands_out: !!e.hands },
        `${e.name.trim()} saved.`, '#adm-team-save');
      if (ok) edit = null;
    },
    async remove(id) {
      const t = team(id);
      if (!t) return;
      if (!(await confirmDialog({ title: `Remove ${t.name}?`,
        message: 'The team and its roster go. A team any task has been handed to stays — rename it instead.',
        confirm: 'Remove the team', danger: true }))) return;
      const ok = await call('team_remove', { p_id: id }, `${t.name} removed.`, '#adm-teams-refresh');
      if (ok) { openId = null; repaint('#adm-team-new-name'); }
    },
    async addPerson(id) {
      const t = team(id);
      const a = add[id] || { email: '', owner: false };
      const email = String(a.email || '').trim();
      if (!t) return;
      if (!email) { error = 'Whose address?'; repaint(`#adm-team-add-${id}`); return; }
      const ok = await call('team_member_save', { p_team_id: id, p_email: email, p_owner: !!a.owner },
        `${email} is on ${t.name}${a.owner ? ' as an owner' : ''}.`, `k:add:${id}`);
      if (ok) { add[id] = { email: '', owner: false }; repaint(`k:add:${id}`); }
    },
    async setOwner(id, userId, on) {
      const t = team(id);
      const p = t && (t.roster || []).find(x => x.id === userId);
      if (!p) return;
      const ok = await call('team_member_save', { p_team_id: id, p_email: p.email, p_owner: !!on },
        `${p.who || p.email} ${on ? 'owns' : 'no longer owns'} ${t.name}.`, `k:own:${id}:${userId}`);
      if (!ok) repaint(`k:own:${id}:${userId}`);
    },
    async takeOff(id, userId) {
      const t = team(id);
      const p = t && (t.roster || []).find(x => x.id === userId);
      if (!p) return;
      const who = p.who || p.email || 'them';
      if (!(await confirmDialog({ title: `Take ${who} off ${t.name}?`,
        message: `${who} stops seeing ${t.name}'s tasks at once. A task they made stays theirs to see.`,
        confirm: 'Take them off', danger: true }))) return;
      await call('team_member_remove', { p_team_id: id, p_user_id: userId }, `${who} is off ${t.name}.`, `k:add:${id}`);
    },
    // For the tests.
    _state: () => ({ teams: teams().length, openId, missing, error, offered: addable(team(openId)).map(u => u.email) }),
  };
})();

if (typeof window !== 'undefined') window.AdminTeams = AdminTeams;
