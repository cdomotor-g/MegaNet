// MegaNet — station-history.js
//
//   StationHistory   the station card's History section: who changed the
//                    station, what and when, a field at a time, newest first,
//                    with Restore — one field, or the whole station as it was
//                    before a change — and the Admin tab's Deleted stations,
//                    each with Restore. Editors only, both of them.
//
// After photo-review.js, whose Equipment section this follows on the card —
// index.html holds the order and the reasons. Reaches back to core.js for
// state, esc, escAttr, announce, ROLE_LABEL, stationTypeLabel and netName; to
// datastore.js for dbSelect and dbRpc; to station-editor.js for
// stationSaveFields, the editor's own save of a station's fields; to app.js for
// repaintStnCard, rerenderStationEditorCard, rerenderStations,
// refreshFilterOptions, updateHeaderStats, refreshMapLayers and docUrl; and to
// auth.js for Auth. Every one of those is a runtime call from inside a
// function here; nothing executes at load (`npm run toplevel`). app.js draws
// the section (stnCardHtml) and asks for it (repaintStnCard), admin.js draws
// the panel and loads it, and auth.js tells this file when the session changes.
//
// ── What it reads ────────────────────────────────────────────────────────────
//
// meganet.station_change (0056): a row per station per statement that changed
// it — created, edited, deleted, restored, or removed by a sync — with the
// fields that moved as they were (`before`) and as they became (`after`), by
// column name, and who. Editors only, under RLS; anybody else is drawn nothing
// here, and the database would show them nothing anyway. The latest fifty rows
// a station has, asked for when its card opens and kept a minute, the way the
// Equipment section keeps its register.
//
// A database without 0056 answers 404 for the table. That is not an error to
// show: the section says, in words, that history starts once the migration is
// applied, and the rest of the card is untouched. The Admin tab's list of
// deleted stations reads meganet.station itself, which every database has, and
// its Restore says the same about 0056 if the function is not there yet.
//
// ── The way back ─────────────────────────────────────────────────────────────
//
// **Restore never writes a column itself.** A field goes back through
// stationSaveFields() — the database's current copy of the station, the earlier
// value put in, saved through save_station() with the stamp it read, exactly as
// the twin saves a tower height — so whatever save_station() would refuse if it
// were typed, it refuses here, in the same words: a proposal's rules (0039),
// 0053's guard, a station number somebody else has. And the restore is itself
// a change in the history, pinned on whoever pressed it.
//
// *Restore* beside a field puts back that field's value from before the change
// — the value a person would undo it to. *Restore as it was before this* puts
// every field back as it stood before the change: that change undone, and every
// later one with it, which the confirmation counts. The station as it was at
// any point is the station now with each later change's `before` put back in
// turn — 0056 records no values for a creation for exactly that reason — so
// the version restored is worked out here from the rows on screen, newest
// first, and no version is offered across a station's re-creation.
//
// Three columns never go back this way, and their rows say so rather than offer
// a button that would save nothing: hub_id (set from the station's position by
// the geometry tools — save_station() does not write it), alert_ids (worked
// out from the sensors on every save; put the sensors back in the editor), and
// document_managed (whether stations.json carries the station; a migration's
// call). deleted_at is not a field here at all — it is what *Deleted* and
// *Restored* mean — and a version restore never deletes. A column a later
// migration adds is shown by its name and tried as the document key of the
// same name; if the save does not take it, the message says so.
//
// **A deleted station comes back through meganet.restore_station()**, from the
// Admin tab: it clears deleted_at and hands the station as it stands to
// save_station() (0056), so a station number or ALERT2 address given to
// another station while it was away is refused in a sentence naming that
// station. Back, it is put into the list on screen from the document the
// database answered with — on the map, in the station list — without a reload.
//
// Schema: db/migrations/0056_station_history.sql; db/README.md, Station history.

const StationHistory = (function () {

  const LIMIT = 50;           // rows a card asks for
  const FRESH = 60000;        // ms a card's rows are kept
  const CLIP = 140;           // characters of a value shown before it is cut
  const SAID = 120000;        // ms a restore's outcome stays said in its section

  // What each column is called on screen, in the order a change lists them.
  const FIELDS = [
    ['name', 'Name'], ['station_number', 'Station number'], ['proposed', 'Proposed'],
    ['station_type', 'Station type'], ['proposed_year', 'Proposed for'],
    ['lat', 'Latitude'], ['lon', 'Longitude'], ['elevation_ahd', 'Elevation (m AHD)'],
    ['elevation_source', 'Elevation from'], ['roles', 'Roles'], ['enabled', 'Enabled'],
    ['owner', 'Owner'], ['radio_network_ids', 'Radio networks'], ['alert_ids', 'ALERT addresses'],
    ['alert2_station_id', 'ALERT2 station address'], ['rm_system_id', 'Radio Mobile system'],
    ['satcom', 'Satcom'], ['notes', 'Notes'], ['catchment_ids', 'Catchments'], ['hub_id', 'Hub'],
    ['basin', 'Basin'], ['lga', 'LGA'], ['stream', 'Stream'], ['awrc_number', 'AWRC number'],
    ['urbs_label', 'URBS label'], ['location_types', 'Location types'],
    ['tbrg_bucket_size', 'TBRG bucket (mm a tip)'], ['inspection_config_key', 'Inspection form'],
    ['tower_height', 'Tower platform (m)'], ['facing_deg', 'Faces (° from true north)'],
    ['flood_peaks_from', 'Takes its floods from'], ['legacy_unit_id', 'Legacy unit'],
    ['site', 'Site'], ['document_managed', 'In stations.json'],
  ];
  const LABEL = Object.fromEntries(FIELDS);
  const ORDER = Object.fromEntries(FIELDS.map(([k], i) => [k, i]));

  // The one column whose document key differs from its name (0004).
  const DOC_KEY = { tbrg_bucket_size: 'TBRGbucketSize' };
  // What the document leaves out where the column holds it: `proposed` is only
  // written where it is true (0039).
  const DOC_DEFAULT = { proposed: false };
  // Columns a restore cannot put back through the editor's save, and why.
  const FIXED = {
    hub_id: 'Set from the station\'s position by the geometry tools — the editor\'s save does not write it.',
    alert_ids: 'Worked out from the sensors on every save — put the sensors back in the station editor instead.',
    document_managed: 'Whether stations.json carries the station — a migration\'s decision, not the editor\'s.',
  };
  // Never listed as a field: it is what Deleted and Restored mean.
  const HIDDEN = new Set(['deleted_at', 'updated_at', 'updated_by', 'ord', 'id']);

  const KIND = {
    created:  'Created',
    edited:   'Edited',
    deleted:  'Deleted',
    restored: 'Restored',
    removed:  'Dropped by a sync',
  };

  let cards = {};       // station id → { at, rows, missing, error, p }
  let open = {};        // station id → the section is open
  let msgs = {};        // station id → { kind, text, at } — the last restore's outcome
  let busy = {};        // station id → a restore is being saved
  let del = null;       // the Admin tab's deleted stations, or null before asked
  let delP = null, delErr = null, delMsg = null, delBusy = null;

  // ── Small things ───────────────────────────────────────────────────────────

  // An editor, as this session last heard from the database. Signed out, or
  // signed in off the editors list, is nobody this file draws anything for.
  function editor() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn() && Auth.mayWrite();
  }
  function errText(err) { return (err && err.message) || String(err); }
  // 0056 not applied: PostgREST says the table or the function is not in its
  // schema cache (404), or Postgres that the relation does not exist.
  function missing(err) {
    const t = errText(err);
    return (err && err.status === 404)
      || (/(station_change|restore_station)/.test(t) && /(does not exist|schema cache|not find)/i.test(t));
  }
  function when(iso) {
    const t = Date.parse(iso);
    return isFinite(t) ? new Date(t).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }
  function whoText(by) {
    if (!by) return 'somebody unrecorded';
    if (by === 'load_stations_doc') return 'the stations loader';
    if (by === 'import_stations_json.py') return 'the stations.json import';
    if (by === 'service_role') return 'the service key';
    if (by === 'postgres') return 'the database owner (a direct connection)';
    return by;
  }
  function label(field) { return LABEL[field] || field.replace(/_/g, ' '); }
  function docKey(field) { return DOC_KEY[field] || field; }
  function station(id) { return ((state.data && state.data.stations) || []).find(s => s.id === id) || null; }

  // One spelling for a value, whatever order an object's keys arrived in and
  // whether "nothing" was a null or an absent key — so a value from the change
  // log and one from the station document compare as the same thing.
  function canon(v) {
    if (v === undefined) return 'null';
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
  }
  function now(s, field) {
    const k = docKey(field);
    return s && k in s ? s[k] : (field in DOC_DEFAULT ? DOC_DEFAULT[field] : null);
  }
  function same(a, b) { return canon(a) === canon(b); }
  function msgClass(m) { return !m ? '' : m.kind === 'error' ? 'txt-bad' : m.kind === 'ok' ? 'txt-ok' : 'txt-muted'; }

  // A value as a person reads it, plain — for a confirmation and a message.
  function plain(field, v) {
    if (v === null || v === undefined) return 'not recorded';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (v === '') return 'blank';
    if (Array.isArray(v)) {
      if (!v.length) return 'none';
      if (field === 'roles') return v.map(r => (typeof ROLE_LABEL !== 'undefined' && ROLE_LABEL[r]) || r).join(', ');
      if (field === 'radio_network_ids') return v.map(n => (typeof netName === 'function' ? netName(n) : n)).join(', ');
      return v.map(x => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      return keys.length ? keys.map(k => `${k}: ${typeof v[k] === 'object' && v[k] !== null ? JSON.stringify(v[k]) : v[k]}`).join(', ') : 'none';
    }
    if (field === 'station_type' && typeof stationTypeLabel === 'function') return stationTypeLabel(v);
    return String(v);
  }
  function quoted(field, v) {
    const t = plain(field, v);
    return v === null || v === undefined || v === '' || typeof v === 'boolean' ? t : `“${t}”`;
  }
  // …and in the section: cut where it is long, whole on hover.
  function valueHtml(field, v) {
    const t = plain(field, v);
    if (v === null || v === undefined || v === '') return `<span class="stn-hist-none">${esc(t)}</span>`;
    return t.length > CLIP
      ? `<span title="${esc(t)}">${esc(t.slice(0, CLIP))}…</span>`
      : esc(t);
  }

  // The fields of a change, in the order the card lists a station's.
  function fieldsOf(e) {
    return Object.keys(e.before || {})
      .filter(k => !HIDDEN.has(k))
      .sort((a, b) => (ORDER[a] ?? 999) - (ORDER[b] ?? 999) || a.localeCompare(b));
  }

  // ── An earlier version ─────────────────────────────────────────────────────
  // The station as it stood before change `cid`: every field that change or a
  // later one moved, at the `before` of the oldest of them. Null where no
  // version is offered — a creation, a sync's drop, or one of those between
  // here and now (the station was made again since; nothing before it is this
  // station's). `fields` are document keys, ready for the editor's save, and
  // only those that differ from now; `fixed` the ones the save cannot write.

  function plan(sid, cid) {
    const c = cards[sid];
    const rows = (c && c.rows) || [];
    const at = rows.findIndex(r => r.id === cid);
    if (at < 0) return null;
    const target = {};
    for (let i = 0; i <= at; i++) {
      const r = rows[i];
      if (r.kind === 'created' || r.kind === 'removed') return null;
      for (const [k, v] of Object.entries(r.before || {})) target[k] = v;
    }
    const s = station(sid);
    const fields = {}, labels = [], fixed = [];
    for (const k of Object.keys(target).filter(k => !HIDDEN.has(k))
                                       .sort((a, b) => (ORDER[a] ?? 999) - (ORDER[b] ?? 999) || a.localeCompare(b))) {
      if (same(target[k], now(s, k))) continue;
      if (FIXED[k]) { fixed.push(k); continue; }
      fields[docKey(k)] = target[k];
      labels.push(k);
    }
    return { fields, labels, fixed, later: at };
  }

  // ── The station card's section ─────────────────────────────────────────────
  // Drawn by stnCardHtml from what this file holds, and filled when the rows
  // arrive — SLS.ask's terms (app.js's repaintStnCard). A <details>, shut until
  // somebody opens it: the card is 340 px wide and every station has one.

  function cardHtml(s) {
    if (!s || !editor()) return '';
    keepOpen(s.id);
    return `<div class="acma-sect stn-hist" id="mn-hist-card-${esc(s.id)}" data-mn-hist="${esc(s.id)}">${bodyHtml(s.id)}</div>`;
  }

  // Whether the section is open is read off the one on screen before it is
  // drawn again, rather than trusted to its toggle event: that event is queued,
  // and a repaint that lands between a click and it would shut the section
  // under the hand that just opened it.
  function keepOpen(sid) {
    const live = document.querySelector(`#mn-hist-card-${CSS.escape(sid)} > details`);
    if (live) open[sid] = live.open;
  }

  function bodyHtml(sid) {
    const c = cards[sid];
    if (c && c.missing) {
      return `<p class="small stn-hist-off" role="note"><strong>History</strong> starts once
        <code>db/migrations/0056_station_history.sql</code> is applied to the database — until then
        nothing records who changes this station, or what it said before.</p>`;
    }
    const rows = c && c.rows;
    const sum = c && c.error ? 'could not be read'
      : !rows ? 'loading…'
      : !rows.length ? 'nothing recorded yet'
      : `last changed ${when(rows[0].changed_at)} by ${whoText(rows[0].changed_by)}`;
    const m = msgs[sid] && (msgs[sid].kind === 'busy' || Date.now() - msgs[sid].at < SAID) ? msgs[sid] : null;
    return `
      <details class="stn-hist-box" data-sid="${esc(sid)}"${open[sid] ? ' open' : ''}
               ontoggle="StationHistory.toggled(this)">
        <summary><span class="stn-hist-title">History</span>
          <span class="stn-hist-sum">· ${esc(sum)}</span></summary>
        <p class="small stn-hist-msg ${msgClass(m)}" role="status">${m ? esc(m.text) : ''}</p>
        ${c && c.error ? `<p class="small txt-bad">Could not read the history: ${esc(c.error)}
            <button type="button" class="link-btn" onclick="StationHistory.reload('${escAttr(sid)}')">Try again</button></p>` : ''}
        ${rows && rows.length ? `<ul class="stn-hist-list">${rows.map(r => entryHtml(sid, r)).join('')}</ul>` : ''}
        <p class="small stn-hist-note">${rows && rows.length >= LIMIT ? `The latest ${LIMIT} changes. ` : ''}The station's
          own fields, since history began. Its sensors, its repeater's ranges and the Bureau's lists are not in it
          yet — the ALERT addresses the sensors give it are.</p>
      </details>`;
  }

  function entryHtml(sid, r) {
    const s = station(sid);
    const off = !!busy[sid];
    const fields = r.kind === 'removed' ? [] : fieldsOf(r);
    const rowsHtml = fields.map(k => {
      const was = r.before[k], became = r.after ? r.after[k] : undefined;
      let act;
      if (FIXED[k]) act = `<span class="stn-hist-fixed" title="${esc(FIXED[k])}">not restored here</span>`;
      else if (same(was, now(s, k))) act = '<span class="stn-hist-same">as now</span>';
      else {
        act = `<button type="button" class="link-btn stn-hist-put"${off ? ' disabled' : ''}
            onclick="StationHistory.restoreField('${escAttr(sid)}', ${Number(r.id)}, '${escAttr(k)}')"
            aria-label="${esc(`Restore ${label(k)} to ${quoted(k, was)}`)}">Restore</button>`;
      }
      return `
          <div class="stn-hist-row" data-field="${esc(k)}">
            <dt>${esc(label(k))}</dt>
            <dd><span class="sr-only">was </span><del>${valueHtml(k, was)}</del>
              <span aria-hidden="true">→</span> <span class="sr-only">became </span><ins>${valueHtml(k, became)}</ins>
              ${act}</dd>
          </div>`;
    }).join('');
    // Offered on a change that moved a field of its own: a Deleted or Restored
    // that moved nothing else would offer exactly the version the edit below it
    // does, a second and a third time.
    const p = r.kind === 'created' || r.kind === 'removed' || !fields.length ? null : plan(sid, r.id);
    const later = p ? p.later : 0;
    const version = p && p.labels.length
      ? `<div class="stn-hist-acts"><button type="button" class="pill stn-hist-version"${off ? ' disabled' : ''}
            onclick="StationHistory.restoreVersion('${escAttr(sid)}', ${Number(r.id)})"
            title="${esc(`Put ${p.labels.map(label).join(', ')} back as they were before this change${later
              ? ` — undoing the ${later} later change${later === 1 ? '' : 's'} above it too` : ''}`)}"
            >↶ Restore as it was before this</button></div>`
      : '';
    const what = r.kind === 'removed'
      ? `<p class="small stn-hist-gone">Taken out of the database by a sync that no longer carried it${r.before && r.before.name
          ? ` — it was ${esc(quoted('name', r.before.name))}` : ''}.</p>` : '';
    return `
      <li class="stn-hist-entry" data-change="${Number(r.id)}" data-kind="${esc(r.kind)}">
        <p class="stn-hist-head"><span class="stn-hist-kind stn-hist-kind-${esc(r.kind)}">${esc(KIND[r.kind] || r.kind)}</span>
          <time datetime="${esc(r.changed_at)}">${esc(when(r.changed_at))}</time>
          · <span class="stn-hist-who">${esc(whoText(r.changed_by))}</span></p>
        ${what}
        ${rowsHtml ? `<dl class="stn-hist-diff">${rowsHtml}</dl>` : ''}
        ${version}
      </li>`;
  }

  // Fill the section if it is on screen, for this station — keeping the
  // keyboard where it was, as repaintStnCard() does for the card: a control
  // that vanishes under it hands focus to the same position in the new markup.
  function fill(sid) {
    const el = document.getElementById(`mn-hist-card-${sid}`);
    if (!el || el.dataset.mnHist !== sid) return;
    const controls = () => [...el.querySelectorAll('summary, button, a[href]')];
    const at = el.contains(document.activeElement) ? controls().indexOf(document.activeElement) : -1;
    keepOpen(sid);
    el.innerHTML = bodyHtml(sid);
    if (at >= 0) { const c = controls(); (c[Math.min(at, c.length - 1)] || el).focus({ preventScroll: true }); }
  }

  function cardAsk(s) {
    if (!s || !editor()) return;
    const sid = s.id;
    const c = cards[sid];
    if (c && (c.p || Date.now() - c.at < FRESH)) return;
    const entry = cards[sid] = { at: Date.now(), rows: c ? c.rows : null, missing: false, error: null, p: null };
    entry.p = dbSelect(`station_change?station_id=eq.${encodeURIComponent(sid)}`
        + `&select=id,changed_at,changed_by,kind,before,after&order=changed_at.desc,id.desc&limit=${LIMIT}`)
      .then(rows => { entry.rows = rows; },
            err => { if (missing(err)) entry.missing = true; else entry.error = errText(err); })
      .finally(() => { entry.p = null; entry.at = Date.now(); fill(sid); });
  }

  function reload(sid) {
    delete cards[sid];
    const s = station(sid);
    fill(sid);
    if (s) cardAsk(s);
  }

  function toggled(el) {
    const sid = el && el.dataset.sid;
    if (sid) open[sid] = el.open;
  }

  // ── Restoring ──────────────────────────────────────────────────────────────

  async function restoreField(sid, cid, field) {
    const c = cards[sid];
    const r = c && (c.rows || []).find(x => x.id === cid);
    if (!r || !r.before || !(field in r.before) || FIXED[field] || busy[sid]) return;
    const s = station(sid);
    const was = r.before[field];
    if (!(await confirmDialog({ title: `Put ${label(field)} back to ${quoted(field, was)}${s ? ` on ${s.name}` : ''}?`,
      message: saying(sid), confirm: `Put ${label(field)} back` }))) return;
    if (busy[sid]) return;
    save(sid, { [docKey(field)]: was }, [field], `${label(field)} put back to ${quoted(field, was)}`);
  }

  async function restoreVersion(sid, cid) {
    if (busy[sid]) return;
    const p = plan(sid, cid);
    const c = cards[sid];
    const r = c && (c.rows || []).find(x => x.id === cid);
    if (!p || !r || !p.labels.length) return;
    const s = station(sid);
    const names = p.labels.map(label).join(', ');
    // The answer is a question of its own (#223): its button says what it
    // puts back, and a version that undoes later changes is the dangerous kind.
    if (!(await confirmDialog({
      title: `Put ${s ? s.name : 'this station'} back as it was before the change of ${when(r.changed_at)}?`,
      message: `${p.labels.length} field${p.labels.length === 1 ? '' : 's'}: ${names}.`
        + (p.later ? `\nThis undoes the ${p.later} later change${p.later === 1 ? '' : 's'} listed above it as well.` : '')
        + (p.fixed.length ? `\n${p.fixed.map(label).join(', ')} stay${p.fixed.length === 1 ? 's' : ''} as now — the editor's save does not write ${p.fixed.length === 1 ? 'it' : 'them'}.` : '')
        + `\n\n${saying(sid)}`,
      confirm: p.later ? `Put back ${p.later + 1} changes` : 'Put it back', danger: !!p.later }))) return;
    if (busy[sid]) return;
    save(sid, p.fields, p.labels, `${s ? s.name : 'The station'} put back as it was before ${when(r.changed_at)} (${names})`);
  }

  // What every confirmation ends with: how it is saved, and — where the
  // station editor is open on this station — what that does to its form.
  function saying(sid) {
    return 'It is saved now, as you, through the station editor\'s own save, and its checks apply.'
      + (state.editorId === sid ? ' The station editor below shows what is saved: anything typed there and not yet saved is replaced.' : '');
  }

  // One save, for both: the editor's own (stationSaveFields), then the card,
  // the list, the editor if it is on this station, and the section — whose
  // rows are asked for again, since the restore is a change of its own.
  async function save(sid, fields, columns, what) {
    busy[sid] = true; msgs[sid] = { kind: 'busy', text: 'Restoring…', at: Date.now() };
    fill(sid);
    let result = null;
    try {
      if (typeof stationSaveFields !== 'function') throw new Error('the station editor is not loaded on this page');
      result = await stationSaveFields(sid, fields);
    } catch (err) {
      busy[sid] = false;
      msgs[sid] = { kind: 'error', text: errorText(err), at: Date.now() };
      fill(sid);
      announce(msgs[sid].text);
      return;
    }
    busy[sid] = false;
    // A column the save does not write would come back unchanged: say so,
    // rather than report a restore that did not happen.
    const saved = (result && result.station) || {};
    const missed = columns.filter(k => !same(now(saved, k), fields[docKey(k)]));
    msgs[sid] = missed.length
      ? { kind: 'error', at: Date.now(), text: `Saved, but ${missed.map(label).join(', ')} did not change — the station editor's save does not write ${missed.length === 1 ? 'it' : 'them'}.` }
      : { kind: 'ok', at: Date.now(), text: `Restored: ${what}.` };
    delete cards[sid];
    if (typeof rerenderStations === 'function') rerenderStations();
    if (typeof refreshFilterOptions === 'function') refreshFilterOptions();
    if (state.editorId === sid && typeof rerenderStationEditorCard === 'function') rerenderStationEditorCard();
    else if (typeof repaintStnCard === 'function') repaintStnCard();
    const s = station(sid);
    if (s) cardAsk(s);
    fill(sid);
    announce(msgs[sid].text);
  }

  // What went wrong, as an instruction rather than a status code. save_station()
  // words its own refusals; those are passed on whole.
  function errorText(err) {
    if (err && err.details === 'administrator') {
      return 'Not restored — only an administrator establishes a proposed station or takes an established one back'
        + ' to proposed, and this would. Restore the other fields one at a time.';
    }
    if (err && err.conflict) {
      return `Not restored — ${errText(err)}. Nothing was changed; reload the station list and try again.`;
    }
    if (err && err.denied) {
      return `Not restored — the database refused: ${errText(err)}. Nothing was changed.`;
    }
    return `Not restored — ${errText(err)}. Nothing was changed.`;
  }

  // ── The Admin tab's Deleted stations ───────────────────────────────────────
  // meganet.station read directly, deleted rows only — the table every
  // database has, so the list is there before 0056 is; who deleted each is the
  // stamp delete_station() left. Restore is restore_station() (0056).

  // The slot admin.js draws, filled from here; empty — and so not drawn, nor
  // given a gap in the column — for anybody who is not an editor.
  function adminHtml() {
    return `<div id="adm-deleted" class="adm-deleted-slot">${adminBodyHtml()}</div>`;
  }

  function adminBodyHtml() {
    if (!editor()) return '';
    const list = del || [];
    const m = delMsg;
    return `
      <div class="panel adm-deleted">
        <div class="panel-header">
          <h2 id="adm-deleted-h">Deleted stations${del ? ` <span class="badge">${list.length}</span>` : ''}</h2>
          <button class="exp-btn-sm" onclick="StationHistory.adminLoad()">Refresh</button>
        </div>
        <p class="small">A deleted station is off the map and out of <code>stations.json</code>, and nothing of
          it is lost — its sensors, its repeater and its lists are kept with it. <strong>Restore</strong> puts it
          back as it was, saved as you through the station editor's own save: if the register has moved on
          while it was away — its station number or ALERT2 address given to another station — it is refused,
          and says which.</p>
        <p class="small adm-deleted-msg ${msgClass(m)}" role="status">${m ? esc(m.text) : ''}</p>
        ${delErr ? `<p class="small txt-bad">Could not read the deleted stations: ${esc(delErr)}</p>` : ''}
        ${!del && !delErr ? '<p class="small">Loading…</p>' : ''}
        ${del && !list.length ? '<p class="small table-empty">No station is deleted.</p>' : ''}
        ${list.length ? `
        <div class="table-wrap" role="region" tabindex="0" aria-labelledby="adm-deleted-h">
          <table class="adm-table">
            <caption class="sr-only">Deleted stations, when each was deleted and by whom, each with Restore</caption>
            <thead><tr>
              <th scope="col">Station</th>
              <th scope="col">Deleted</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              ${list.map(r => `
                <tr data-deleted="${esc(r.id)}">
                  <td>${esc(r.name || r.id)}${r.proposed ? ' <span class="badge">proposed</span>' : ''}
                    <span class="adm-deleted-sub">${r.station_number ? `${esc(r.station_number)} · ` : ''}<code>${esc(r.id)}</code></span></td>
                  <td class="small">${esc(when(r.deleted_at))}
                    <span class="adm-deleted-sub">by ${esc(whoText(r.updated_by))}</span></td>
                  <td class="adm-row-acts"><button class="exp-btn-sm" onclick="StationHistory.restoreStation('${escAttr(r.id)}')"
                      ${delBusy ? 'disabled' : ''} aria-label="${esc(`Restore ${r.name || r.id}`)}">Restore</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
      </div>`;
  }

  function adminPaint() {
    const el = document.getElementById('adm-deleted');
    if (el) el.innerHTML = adminBodyHtml();
  }

  function adminLoad() {
    if (!editor()) { adminPaint(); return Promise.resolve(); }
    if (delP) return delP;
    delErr = null;
    adminPaint();
    delP = dbSelect('station?deleted_at=not.is.null'
        + '&select=id,name,station_number,proposed,deleted_at,updated_at,updated_by&order=deleted_at.desc&limit=500')
      .then(rows => { del = rows; }, err => { delErr = errText(err); })
      .finally(() => { delP = null; adminPaint(); });
    return delP;
  }

  async function restoreStation(id) {
    const r = (del || []).find(x => x.id === id);
    if (!r || delBusy || !editor()) return;
    if (!(await confirmDialog({ title: `Restore “${r.name || r.id}”?`,
      message: 'It comes back on the map and in the station list as it was when it'
        + ' was deleted — its sensors, its repeater and its lists with it — saved now, as you, through the'
        + ' station editor\'s own save.',
      confirm: 'Restore the station' }))) return;
    if (delBusy) return;
    delBusy = id; delMsg = { kind: 'busy', text: `Restoring ${r.name || r.id}…` };
    adminPaint();
    try {
      const out = await dbRpc('restore_station', { p_id: id, p_expected_updated_at: r.updated_at });
      putBack(out && out.station);
      delete cards[id];
      // Off the list at once, and the list asked again below for whatever
      // else changed while it was open.
      del = (del || []).filter(x => x.id !== id);
      delMsg = { kind: 'ok', text: out && out.already
        ? `${r.name || r.id} was not deleted any more — somebody restored it first.`
        : `Restored ${r.name || r.id}: it is back on the map and in the station list.` };
    } catch (err) {
      delMsg = { kind: 'error', text: missing(err)
        ? 'Not restored — restoring a station from here needs db/migrations/0056_station_history.sql applied to'
          + ' the database. The station stays deleted, and nothing of it is lost.'
        : `Not restored — ${errText(err)}. The station stays deleted.` };
    }
    delBusy = null;
    announce(delMsg.text);
    await adminLoad();
  }

  // The station as the database answered with it, into the list on screen.
  function putBack(doc) {
    if (!doc || !doc.id || !state.data || !Array.isArray(state.data.stations)) return;
    const list = state.data.stations;
    const i = list.findIndex(s => s.id === doc.id);
    if (i >= 0) list[i] = doc; else list.push(doc);
    if (typeof updateHeaderStats === 'function') updateHeaderStats();
    if (typeof refreshFilterOptions === 'function') refreshFilterOptions();
    if (typeof rerenderStations === 'function') rerenderStations();
    if (state.map && typeof refreshMapLayers === 'function') refreshMapLayers({ skipFit: true });
  }

  // A sign-in or a sign-out: what was read belonged to the last session.
  function authChanged() {
    cards = {}; msgs = {}; busy = {};
    del = null; delErr = null; delMsg = null; delBusy = null;
    if (state.activeTab === 'admin' && editor()) adminLoad(); else adminPaint();
  }

  return {
    cardHtml, cardAsk, reload, toggled, restoreField, restoreVersion,
    adminHtml, adminLoad, restoreStation, authChanged,
    // Read by the check and by nothing else.
    _state: () => ({ cards: Object.keys(cards), open: { ...open }, deleted: del ? del.length : null }),
  };
})();
if (typeof window !== 'undefined') window.StationHistory = StationHistory;
