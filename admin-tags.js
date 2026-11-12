// MegaNet — admin-tags.js
//
//   AdminTags   the Admin tab's "Tags" panel (0118): every tag people put on
//               tasks — its name, what it means, its colour, how many tasks
//               have it — renamed, re-worded, recoloured and retired here,
//               merged into another, and removed when no task has it. Anybody
//               tasks are for makes a tag by typing a new one on a task (✅
//               Tasks); this is where they are tidied.
//
// After core.js and datastore.js (dbRpc), before admin.js, which draws it
// into #adm-tags and loads it from Admin.init(). Reads tasks.js's
// Tasks.WORDS at call time, so a word means one thing on both tabs. Nothing
// here runs at load; auth.js calls authChanged() on every sign-in and out.
//
// This panel is not the security: tag_save() with an id, tag_merge() and
// tag_remove() refuse anybody meganet.is_admin() says no to, whatever is
// drawn here. tags_read() gives an administrator each tag's counts and maker.

const AdminTags = (function () {
  let read = null;            // tags_read()
  let loading = false, error = '', note = '', missing = false, busy = false;
  let openId = null;          // the tag open
  let edit = null;            // { id, name, meaning, colour, retired, into } for the open tag
  let make = { name: '', meaning: '', colour: '' };

  const COLOURS = [
    { key: 'blue', label: 'Blue' }, { key: 'green', label: 'Green' }, { key: 'amber', label: 'Amber' },
    { key: 'red', label: 'Red' }, { key: 'purple', label: 'Purple' }, { key: 'teal', label: 'Teal' },
    { key: 'pink', label: 'Pink' }, { key: 'grey', label: 'Grey' },
  ];
  const colourKey = c => (COLOURS.some(x => x.key === c) ? c : 'grey');

  const isAdmin = () => typeof Auth !== 'undefined' && Auth.isSignedIn()
    && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  const tags = () => (read && Array.isArray(read.tags) ? read.tags : []);
  const tag = id => tags().find(t => t.id === id) || null;

  // The words, from the Tasks tab's one list.
  const FALLBACK = {
    tag: 'A short word put on a task to say what kind of job it is — RTS, QA, Assessment and so on. Hover one for what it means.',
  };
  const WORDS = {
    retired: 'No longer offered when somebody tags a task. The tasks that have it keep it, and it can be brought back.',
    merge: 'Makes two tags one: every task with this tag gets the other instead — its thread says so — and this one goes. For two names that mean the same, like "QA" and "Q.A.".',
    live: 'How many of the tasks with this tag are not finished — open, in progress or waiting.',
    colour: 'Only to help the eye find a tag: the word is always written on it.',
  };
  function word(k) {
    if (WORDS[k]) return WORDS[k];
    const w = typeof Tasks !== 'undefined' && Tasks.WORDS ? Tasks.WORDS[k] : null;
    return w || FALLBACK[k] || '';
  }

  function errText(err, what) {
    if (err && err.status === 404 && /function|PGRST202|schema cache/i.test(err.message || '')) {
      missing = true;
      return 'The database does not have tags yet — apply db/migrations/0118_task_tags.sql.';
    }
    return `Could not ${what}: ${err ? err.message : 'no answer'}`;
  }
  const dmy = ts => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ts || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };
  const chip = t => `<span class="tk-tag tk-tag-${colourKey(t.colour)} term-chip" title="${esc(t.meaning || 'Nobody has said what it means yet.')}">${esc(t.name)}</span>`;
  const colourOptions = cur => COLOURS.map(c => `<option value="${c.key}"${c.key === cur ? ' selected' : ''}>${c.label}</option>`).join('');

  // ── Drawing ────────────────────────────────────────────────────────────────

  function rowHtml(t) {
    const open = openId === t.id;
    return `<tr class="row-link${open ? ' is-open' : ''}${t.retired ? ' adm-tag-retired' : ''}" onclick="AdminTags.open('${escAttr(t.id)}')">
        <th scope="row"><button type="button" class="row-open" data-k="tag:${escAttr(t.id)}" aria-expanded="${open}"
          aria-label="${escAttr(t.name)}" onclick="event.stopPropagation(); AdminTags.open('${escAttr(t.id)}')">${chip(t)}</button></th>
        <td class="small">${t.meaning ? esc(t.meaning) : '<span class="txt-warn">not said yet</span>'}</td>
        <td>${Number(t.tasks) || 0}${Number(t.live) ? ` <span class="small txt-muted">(${Number(t.live)} going)</span>` : ''}</td>
        <td>${t.retired ? termHtml('Retired', word('retired')) : '<span class="txt-muted">In use</span>'}</td>
        <td class="small col-optional">${esc(t.created_by || '—')}<div class="txt-muted">${esc(dmy(t.created_at))}</div></td>
      </tr>`;
  }

  function seed(t) {
    return { id: t.id, name: t.name, meaning: t.meaning || '', colour: colourKey(t.colour), retired: !!t.retired, into: '' };
  }

  function openHtml() {
    const t = tag(openId);
    if (!t) return '';
    const e = edit && edit.id === t.id ? edit : seed(t);
    const dis = busy ? ' disabled' : '';
    const others = tags().filter(x => x.id !== t.id);
    const n = Number(t.tasks) || 0;
    return `<section class="adm-team-open adm-tag-open" aria-labelledby="adm-tag-h">
        <h3 id="adm-tag-h" tabindex="-1">${chip(t)} <span class="small txt-muted">on ${n} task${n === 1 ? '' : 's'}</span></h3>
        <form class="adm-tok-form" onsubmit="event.preventDefault(); AdminTags.saveEdit()">
          <label>Name <input type="text" id="adm-tag-name" maxlength="30" value="${esc(e.name)}"
            oninput="AdminTags.editField('name', this.value)"${dis}></label>
          <label class="adm-tag-meaning">What it means <input type="text" id="adm-tag-meaning" maxlength="300" value="${esc(e.meaning)}"
            oninput="AdminTags.editField('meaning', this.value)" placeholder="e.g. Return to service: getting a station working again"${dis}></label>
          <label>${termHtml('Colour', word('colour'))} <select id="adm-tag-colour" onchange="AdminTags.editField('colour', this.value)"${dis}>${colourOptions(e.colour)}</select></label>
          <label class="check-label"><input type="checkbox" id="adm-tag-retired"${e.retired ? ' checked' : ''}
            onchange="AdminTags.editField('retired', this.checked)"${dis}><span>${termHtml('Retired', word('retired'))}</span></label>
          <button type="submit" class="exp-btn-sm" id="adm-tag-save"${dis}>Save</button>
        </form>
        <p class="small txt-muted">A new name shows on every task that has the tag at once; the tasks' threads keep the name it had when they were tagged.</p>
        ${others.length ? `<form class="adm-tok-form" onsubmit="event.preventDefault(); AdminTags.merge()">
          <label>${termHtml('Merge it into', word('merge'))}
            <select id="adm-tag-into" onchange="AdminTags.editField('into', this.value)"${dis}>
              <option value=""${e.into ? '' : ' selected'}>— pick the tag to keep —</option>
              ${others.map(x => `<option value="${escAttr(x.id)}"${x.id === e.into ? ' selected' : ''}>${esc(x.name)}${x.retired ? ' (retired)' : ''}</option>`).join('')}
            </select></label>
          <button type="submit" class="exp-btn-sm" id="adm-tag-merge"${dis}>Merge…</button>
        </form>` : ''}
        <div class="button-group">
          <button type="button" class="exp-btn-sm adm-danger" id="adm-tag-remove"${busy || n ? ' disabled' : ''}
            onclick="AdminTags.remove('${escAttr(t.id)}')">Remove the tag…</button>
          ${n ? `<span class="small txt-muted">A tag on any task stays — retire it, so it is no longer offered, or merge it into another.</span>` : ''}
        </div>
      </section>`;
  }

  function wordsHtml() {
    return `<details class="adm-team-words"><summary class="small">What the words here mean</summary>
        <dl class="small">
          <dt>Tag</dt><dd>${esc(word('tag'))}</dd>
          <dt>Retired</dt><dd>${esc(word('retired'))}</dd>
          <dt>Merge</dt><dd>${esc(word('merge'))}</dd>
          <dt>Going</dt><dd>${esc(word('live'))}</dd>
          <dt>Colour</dt><dd>${esc(word('colour'))}</dd>
        </dl></details>`;
  }

  function render() {
    const head = `<div class="panel-header"><h2 id="adm-tags-h">Tags</h2>
        ${isAdmin() ? '<button type="button" class="exp-btn-sm" id="adm-tags-refresh" onclick="AdminTags.load()">Refresh</button>' : ''}</div>`;
    if (!isAdmin()) {
      return `<div class="panel" aria-labelledby="adm-tags-h">${head}
        <p class="small">The tags people put on tasks — tidied here by administrators.</p></div>`;
    }
    let body = `<p class="small">The ${termHtml('tags', word('tag'))} people put on tasks. Anybody tasks are for adds one by typing a new
      name on a task; here you say what each means, give it a colour, ${termHtml('retire', word('retired'))} the ones nobody should pick any more, and
      ${termHtml('merge', word('merge'))} two that mean the same.</p>`;
    if (note) body += `<p class="small txt-ok" role="status">${esc(note)}</p>`;
    if (error) body += `<p class="small txt-bad" role="alert">${esc(error)}</p>`;
    if (loading && !read) body += '<p class="small" role="status">Loading…</p>';
    if (read && !missing) {
      body += `<div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="adm-tags-h"><table class="adm-table adm-tags-table">
          <caption class="sr-only">Every tag, the ones in use first</caption>
          <thead><tr><th scope="col">${termHtml('Tag', word('tag'))}</th><th scope="col">What it means</th>
            <th scope="col">Tasks <span class="small">(${termHtml('going', word('live'))})</span></th><th scope="col">${termHtml('State', word('retired'))}</th>
            <th scope="col" class="col-optional">Made by</th></tr></thead>
          <tbody>${tags().length ? tags().map(rowHtml).join('') : '<tr><td colspan="5" class="small">No tags yet.</td></tr>'}</tbody>
        </table></div>
        <div id="adm-tag-open">${openHtml()}</div>
        <h3 class="adm-req-h">Make a tag</h3>
        <form class="adm-tok-form" onsubmit="event.preventDefault(); AdminTags.make()">
          <label>Name <input type="text" id="adm-tag-new-name" maxlength="30" value="${esc(make.name)}"
            oninput="AdminTags.makeField('name', this.value)" placeholder="e.g. Solar"></label>
          <label class="adm-tag-meaning">What it means <input type="text" id="adm-tag-new-meaning" maxlength="300" value="${esc(make.meaning)}"
            oninput="AdminTags.makeField('meaning', this.value)"></label>
          <label>${termHtml('Colour', word('colour'))} <select id="adm-tag-new-colour" onchange="AdminTags.makeField('colour', this.value)">
            <option value=""${make.colour ? '' : ' selected'}>The next one</option>${colourOptions(make.colour)}</select></label>
          <button type="submit" class="primary" id="adm-tag-new-go"${busy ? ' disabled' : ''}>Make the tag</button>
        </form>
        ${wordsHtml()}`;
    }
    return `<div class="panel" aria-labelledby="adm-tags-h">${head}${body}</div>`;
  }

  function repaint(focus) {
    const el = document.getElementById('adm-tags');
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
      read = await dbRpc('tags_read', {});
      missing = false;
    } catch (err) {
      error = errText(err, 'load the tags');
    }
    loading = false;
    repaint();
  }

  // One change; tags_read() comes back and is drawn.
  async function call(fn, args, said, focus) {
    if (busy) return false;
    busy = true; error = ''; note = '';
    repaint(focus);
    let ok = false;
    try {
      const out = await dbRpc(fn, args);
      if (out && typeof out === 'object' && Array.isArray(out.tags)) read = out;
      note = said;
      announce(said);
      ok = true;
    } catch (err) {
      error = errText(err, 'change the tags');
    }
    busy = false;
    repaint(focus);
    return ok;
  }

  function authChanged() {
    read = null; error = ''; note = ''; missing = false; busy = false; openId = null; edit = null;
    if (state.activeTab === 'admin') { repaint(); if (isAdmin()) load(); }
  }

  const cleanName = v => String(v || '').replace(/\s+/g, ' ').trim();

  return {
    render, load, authChanged,
    open(id) {
      openId = openId === id ? null : id;
      edit = null;
      repaint(openId ? '#adm-tag-h' : `k:tag:${id}`);
    },
    makeField(k, v) { make[k] = v; },
    editField(k, v) {
      const t = tag(openId);
      if (!t) return;
      if (!edit || edit.id !== t.id) edit = seed(t);
      edit[k] = v;
    },
    async make() {
      const name = cleanName(make.name);
      if (!name) { error = 'Give the tag a name.'; repaint('#adm-tag-new-name'); return; }
      if (name.includes(',')) { error = 'A tag has no comma.'; repaint('#adm-tag-new-name'); return; }
      const ok = await call('tag_save', { p_id: null, p_name: name, p_meaning: make.meaning || '', p_colour: make.colour || null, p_retired: null },
        `${name} is a tag now: it is offered on every task.`, '#adm-tag-new-go');
      if (ok) { make = { name: '', meaning: '', colour: '' }; repaint('#adm-tag-new-name'); }
    },
    async saveEdit() {
      const t = tag(openId);
      if (!t) return;
      const e = edit && edit.id === t.id ? edit : seed(t);
      const name = cleanName(e.name);
      if (!name) { error = 'A tag needs a name.'; repaint('#adm-tag-name'); return; }
      if (name.includes(',')) { error = 'A tag has no comma.'; repaint('#adm-tag-name'); return; }
      const ok = await call('tag_save', { p_id: t.id, p_name: name, p_meaning: e.meaning || '', p_colour: e.colour, p_retired: !!e.retired },
        `${name} saved${e.retired && !t.retired ? ' — retired: no longer offered' : !e.retired && t.retired ? ' — offered again' : ''}.`, '#adm-tag-save');
      if (ok) edit = null;
    },
    async merge() {
      const t = tag(openId);
      const e = edit && edit.id === (t && t.id) ? edit : null;
      const into = e && tag(e.into);
      if (!t) return;
      if (!into) { error = 'Pick the tag to merge it into.'; repaint('#adm-tag-into'); return; }
      const n = Number(t.tasks) || 0;
      if (!(await confirmDialog({ title: `Merge ${t.name} into ${into.name}?`,
        message: `${n ? `The ${n} task${n === 1 ? '' : 's'} tagged ${t.name} will be tagged ${into.name} instead, each thread saying so. ` : ''}${t.name} goes. This cannot be undone.`,
        confirm: 'Merge them', danger: true }))) return;
      const ok = await call('tag_merge', { p_from: t.id, p_into: into.id }, `${t.name} is merged into ${into.name}.`, '#adm-tags-refresh');
      if (ok) { openId = into.id; edit = null; repaint('#adm-tag-h'); }
    },
    async remove(id) {
      const t = tag(id);
      if (!t) return;
      if (!(await confirmDialog({ title: `Remove ${t.name}?`, message: 'No task has it, so nothing else changes.',
        confirm: 'Remove the tag', danger: true }))) return;
      const ok = await call('tag_remove', { p_id: id }, `${t.name} removed.`, '#adm-tags-refresh');
      if (ok) { openId = null; repaint('#adm-tag-new-name'); }
    },
    // For the tests.
    _state: () => ({ tags: tags().length, openId, missing, error }),
  };
})();

if (typeof window !== 'undefined') window.AdminTags = AdminTags;
