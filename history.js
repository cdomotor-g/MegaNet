// MegaNet — history.js
//
//   History   the Inspection History tab: finding a station's past visits and
//             maintenance forms, reading one back the way the paper form reads,
//             printing it to A4 and exporting it.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc and escAttr; across to app.js for
// switchTab and goToStation from inline handlers, so at click time; to auth.js
// for Auth; to datastore.js for dbSelect, dbRpc, dbCanWrite and dbSignedUrl;
// and to inspections.js and maintenance.js for ensureRefs() and recordModel().
// Nothing reaches into this file: the tab is rendered from renderMain()'s one
// case and nothing else calls in.
//
// The IIFE body declares and calls nothing, so this file's position among the
// modules is free — checked, not reasoned about (`npm run toplevel`). It builds
// no Leaflet map, so it registers none; it starts no timer and holds nothing
// that outlives a tab switch, so it registers no teardown either. The one thing
// it does hold — signed URLs — is dropped when a record is closed and is
// session-only regardless (see below).
//
// ── What this file owns, and what it does not ────────────────────────────────
//
// It owns **finding** and **reading**, and owns neither sheet.
//
// The six inspection sheets are inspections.js's and the Council sheet is
// maintenance.js's, and both of those files know their layout box by box. So
// this file asks each of them for a **record model** — the sheet walked once in
// its printed order, every box resolved to the words a person would read — and
// renders that. One renderer, two form families, and a section added to either
// sheet appears here without this file being told it exists.
//
// The same model is what the CSV is written from. That is the property worth
// protecting: an export written separately from the screen drifts from it every
// time a form gains a box, and the drift is invisible because both halves look
// right on their own. Here they cannot disagree, because there is one walk.
//
// ── Why a tab of its own ─────────────────────────────────────────────────────
//
// Because it spans both form families and owns neither. The Inspections tab's
// recent-visits list — twenty-five rows, every station, no filter — is what
// somebody reaches for to *resume* work; this is what somebody reaches for to
// answer "what happened at this site". Putting it on either form tab would have
// made that tab the reader for the other family's records too.
//
// It costs the four shared edits #113's constraint 3 says a tab costs: a `TABS`
// entry, a `HELP` entry, a `state.hist` block and one line in renderMain().
//
// ── Editors only, and it says so before it asks ──────────────────────────────
//
// Every record table in 0009 is readable by editors and nobody else — an
// inspection's remarks carry site-access notes and the Council form carries
// named landowners' phone numbers, and the anon key this app ships with is
// published. So this whole tab is behind a session, and says so rather than
// showing an empty list to somebody who would see rows if they signed in.
//
// ── Signed URLs are not cached anywhere durable ──────────────────────────────
//
// The bucket is private and read through signed URLs, and #149's rule is that a
// signed URL is only ever as private as the path it signs. So the ones this file
// takes out to draw a photo live in `state.hist.urls` for as long as the record
// is open, are dropped when it closes, and are never written to localStorage,
// never put in the address bar and never included in an export. The CSV names a
// photo by its title and its object path; it does not carry a link that would
// still open weeks later out of somebody's Downloads folder.
//
// ── Print ────────────────────────────────────────────────────────────────────
//
// The workbook's own print setup is A4 portrait, one page per visit, Arial 8pt
// with 10pt bold banner headings — `styles.css`'s `@media print` block is that,
// and the reason the read-only view is a plain grid of labelled values rather
// than a wall of disabled inputs. A disabled input prints as a box with a
// browser's idea of a form control in it; a value under its printed label is
// what the paper looks like.
//
// Issue #118 (I4), sub-issue of #78.

const History = (function () {

  const S = () => state.hist;

  // How many records to list. A station's whole history is the point, so this is
  // generous; the all-stations view is a starting point rather than a report and
  // is deliberately short.
  const PER_STATION = 500;
  const ACROSS_ALL  = 50;

  const INSPECTION_COLS = 'id,station_id,station_name,cbm_no,config_key,inspected_on,'
                        + 'inspector,origin,updated_at,date_precision,date_raw';
  const ACTIVITY_COLS   = 'id,station_id,station_name,cbm_no,visited_on,recorded_by,'
                        + 'council_key,inspection_id,origin,updated_at';

  // Anything the browser will draw inline. Everything else — a text dump, a PDF
  // — is offered as a link that is signed when it is clicked, so a record with
  // eight of them does not sign eight URLs nobody looked at.
  const INLINE = /^image\//;

  // ── Loading ────────────────────────────────────────────────────────────────

  function init() {
    // Both sheets' vocabularies, because a record from either family may be
    // opened next and a model cannot be built without them. Each is a no-op
    // after the first call and each repaints this tab when it lands.
    Inspections.ensureRefs(repaint);
    Maintenance.ensureRefs(repaint);
    if (dbCanWrite() && !S().list && !S().listBusy) load();
  }

  function repaint() {
    if (state.activeTab !== 'history') return;
    renderMain();
  }

  function load() {
    const s = S();
    if (!dbCanWrite()) { s.list = null; return; }
    s.listBusy = true;
    s.listError = null;

    const station = s.station;
    // The third scope (#128): imported visits whose station #125's crosswalk
    // could not identify. They are invisible from every per-station view by
    // construction — no station, no scope reaches them — so they need a door
    // of their own or the UI implies a completeness the data does not have.
    const unmatched = s.unmatched;
    const scope = unmatched ? '&station_id=is.null&origin=eq.import'
                : station  ? `&station_id=eq.${encodeURIComponent(station.id)}` : '';
    const limit = (station || unmatched) ? PER_STATION : ACROSS_ALL;

    Promise.all([
      dbSelect(`inspection?select=${INSPECTION_COLS}&deleted_at=is.null${scope}`
             + `&order=inspected_on.desc&limit=${limit}`),
      // The Council forms are all typed in MegaNet, so the unmatched scope has
      // nothing to ask them for — and asking with station_id=is.null would
      // dredge up something else entirely.
      unmatched ? Promise.resolve([])
                : dbSelect(`maintenance_activity?select=${ACTIVITY_COLS}&deleted_at=is.null${scope}`
                         + `&order=visited_on.desc&limit=${limit}`),
      // The departure ratings the database itself marks as needing a maintenance
      // visit. Read off 0009's own view rather than matched on the word "poor" —
      // which rating counts is `data_quality_rating.needs_maintenance`, and that
      // is a fact about the vocabulary rather than about the spelling.
      unmatched ? Promise.resolve([])
                : dbSelect('inspection_needs_maintenance?select=inspection_id,parameter,'
                         + `on_departure_label,has_maintenance_activity${scope}`),
    ])
      .then(([visits, forms, flags]) => {
        s.listBusy = false;
        s.flags = {};
        flags.forEach(f => {
          (s.flags[f.inspection_id] = s.flags[f.inspection_id] || []).push(f);
        });
        s.list = merge(visits, forms);
        repaint();
      })
      .catch(err => {
        s.listBusy = false;
        s.list = [];
        s.listError = `Could not read the history — ${(err && err.message) || err}`;
        repaint();
      });
  }

  // One timeline out of two tables. Dates are ISO, so they sort as strings; the
  // tie-break is the row's own last write, which is the only other ordering the
  // database can offer for two things that happened on one day.
  function merge(visits, forms) {
    const rows = [
      ...visits.map(r => ({
        kind: 'inspection', id: r.id, on: r.inspected_on || '',
        station_id: r.station_id, station_name: r.station_name, cbm_no: r.cbm_no,
        // The key, not the label. The list can arrive before the vocabularies
        // do — two independent fetches — and a label resolved here would be the
        // raw key for as long as that race lasted and for ever after.
        config_key: r.config_key, who: r.inspector || '',
        origin: r.origin, updated_at: r.updated_at,
        date_precision: r.date_precision || 'day', date_raw: r.date_raw || '',
      })),
      ...forms.map(r => ({
        kind: 'maintenance', id: r.id, on: r.visited_on || '',
        station_id: r.station_id, station_name: r.station_name, cbm_no: r.cbm_no,
        config_key: null, who: r.recorded_by || '',
        from_inspection: r.inspection_id || null,
        origin: r.origin, updated_at: r.updated_at,
      })),
    ];
    return rows.sort((a, b) =>
      b.on.localeCompare(a.on) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }

  function open(kind, id) {
    const s = S();
    s.open = { kind, id, doc: null, src: null, cells: null, cellsError: null };
    s.openError = null;
    s.openBusy = true;
    s.msg = null;
    s.urls = {};
    repaint();

    dbRpc(kind === 'inspection' ? 'inspection_doc' : 'maintenance_activity_doc', { p_id: id })
      .then(doc => {
        if (!doc) throw new Error('that record is no longer in the database');
        if (!s.open || s.open.id !== id) return;      // somebody clicked elsewhere first
        s.openBusy = false;
        s.open.doc = doc;
        repaint();
        signPhotos(doc);
        if (kind === 'inspection' && doc.origin === 'import') loadTranscription(id);
      })
      .catch(err => {
        s.openBusy = false;
        s.openError = `Could not open it — ${(err && err.message) || err}`;
        repaint();
      });
  }

  // The other half of an imported record (#128). inspection_doc() serves the
  // *projected* numbers — the modern form's reading — and a projection has no
  // number for `>30`, for `U/S`, or for a sentence, which is exactly right and
  // exactly not the record. meganet.inspection_measurement is the record: one
  // row per workbook cell, `raw` never repaired. Both are fetched and both are
  // shown, each labelled as what it is.
  function loadTranscription(id) {
    const s = S();
    const eq = encodeURIComponent(id);
    Promise.all([
      dbSelect(`inspection?id=eq.${eq}&select=source_workbook,source_sheet,source_row,`
             + 'source_block_ref,source_ref,date_precision,date_raw,station_match,station_key'),
      dbSelect(`inspection_measurement?inspection_id=eq.${eq}&select=ord,field_key,label,`
             + 'source_col,raw,value_class,value,unit,operator,bound,status,flag&order=ord'),
    ])
      .then(([srcRows, cells]) => {
        if (!s.open || s.open.id !== id) return;
        s.open.src = srcRows[0] || null;
        s.open.cells = cells;
        repaint();
      })
      .catch(err => {
        if (!s.open || s.open.id !== id) return;
        s.open.cellsError = String((err && err.message) || err);
        repaint();
      });

    // #127's derived events, on their own request and their own catch: a
    // database from before 0016 has no table to ask, and the transcription
    // must not be lost to that. The vocabulary rides along once per session.
    const vocab = s.eventTypes
      ? Promise.resolve(s.eventTypes)
      : dbSelect('inspection_event_type?select=key,label,note&order=ord')
          .then(rows => { s.eventTypes = rows; return rows; });
    Promise.all([
      vocab,
      dbSelect(`inspection_event?inspection_id=eq.${eq}`
             + '&select=ord,event_type,confidence,rule,quote,detail&order=ord'),
    ])
      .then(([, events]) => {
        if (!s.open || s.open.id !== id) return;
        s.open.events = events;
        repaint();
      })
      .catch(() => { /* pre-0016 database, or events not loaded — the record stands without them */ });
  }

  // One signed URL per image, taken out when the record opens so that the page
  // that prints is the page on screen. Dropped by close(); never persisted.
  function signPhotos(doc) {
    const s = S();
    (doc.attachments || []).forEach(a => {
      if (!INLINE.test(a.content_type || '')) return;
      dbSignedUrl(a.storage_bucket || 'inspections', a.storage_path)
        .then(url => {
          if (!s.open || !s.open.doc || s.open.doc.id !== doc.id) return;
          s.urls[a.storage_path] = url;
          const el = document.querySelector(`img[data-att-path="${cssEscape(a.storage_path)}"]`);
          if (el) el.src = url;
        })
        .catch(() => { /* a photo that will not sign is a photo the panel says is missing */ });
    });
  }

  // Only ever used on a storage path, which 0010 constrains to
  // `<kind>/<uuid>/<uuid>.<ext>` — but the selector is built by string
  // concatenation, so quoting it is not optional.
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function close() {
    const s = S();
    s.open = null;
    s.openError = null;
    s.msg = null;
    s.urls = {};
    repaint();
  }

  function refresh() { load(); }

  function retry() {
    S().listError = null;
    load();
  }

  // ── The station picker ─────────────────────────────────────────────────────

  function search(q) {
    S().query = q;
    const el = document.getElementById('hist-matches');
    if (el) el.innerHTML = matchesHtml();
  }

  function pick(stationId) {
    const s = S();
    const st = ((state.data && state.data.stations) || []).find(x => x.id === stationId);
    s.station = st ? { id: st.id, name: st.name, number: st.station_number || '' } : null;
    s.unmatched = false;
    s.query = '';
    s.list = null;
    s.open = null;
    load();
    repaint();
  }

  function clearStation() {
    const s = S();
    s.station = null;
    s.unmatched = false;
    s.list = null;
    s.open = null;
    load();
    repaint();
  }

  // The unmatched scope (#128): the 535 imported visits #125 could park but not
  // place. No station, so no per-station view can ever reach them.
  function showUnmatched() {
    const s = S();
    s.station = null;
    s.unmatched = true;
    s.query = '';
    s.list = null;
    s.open = null;
    load();
    repaint();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function render() {
    const s = S();
    return `
      <div class="hist-page">
        ${headHtml()}
        ${!dbCanWrite() ? signedOutHtml()
          : s.open ? recordHtml()
          : `${pickerHtml()}${listHtml()}`}
      </div>`;
  }

  function headHtml() {
    const s = S();
    return `
      <div class="panel hist-head">
        <div class="panel-header">
          <h2>Inspection History</h2>
          <div class="hist-head-actions">
            ${s.open ? `<button onclick="History.close()">← Back to the list</button>` : ''}
          </div>
        </div>
        <p class="small hist-sub">
          Past station inspections and Council maintenance forms, newest first — read-only, laid out
          the way the paper sheet is, and printable to A4. The forms themselves are filled in on the
          <button class="btn-link" onclick="switchTab('inspections')">Inspections</button> and
          <button class="btn-link" onclick="switchTab('maintenance')">Site Maintenance</button> tabs.
        </p>
      </div>`;
  }

  function signedOutHtml() {
    return `
      <div class="panel hist-note">
        <strong>Past records are editors-only.</strong>
        <p class="small">An inspection's remarks carry site-access notes and the Council form carries
          named contacts' phone numbers, so 0009 grants every record table to editors and to nobody
          else — and the anon key this app ships with is published.
          <a href="#" onclick="Auth.open();return false">Sign in</a> to read them.</p>
        <p class="small hist-muted">The <em>form</em> itself is public and fills in signed out; it is
          the filled-in records that are not.</p>
      </div>`;
  }

  function pickerHtml() {
    const s = S();
    return `
      <div class="panel hist-picker">
        <div class="panel-header">
          <h3>${s.unmatched ? 'Imported, not yet matched to a station'
              : s.station ? esc(s.station.name) : 'Every station'}</h3>
          <div class="hist-head-actions">
            ${s.station || s.unmatched
              ? `<button onclick="History.clearStation()">Show every station</button>` : ''}
            ${!s.unmatched
              ? `<button onclick="History.showUnmatched()"
                         title="Imported visits whose station the crosswalk could not identify —
                                they keep the name and number the sheet had">Not matched</button>` : ''}
            <button onclick="History.refresh()">Refresh</button>
          </div>
        </div>
        ${state.data
          ? `<label class="hist-search">Scope the history to a station
               <input type="search" id="hist-q" value="${escAttr(s.query)}"
                      placeholder="name, station number or ALERT address"
                      oninput="History.search(this.value)">
             </label>
             <div id="hist-matches">${matchesHtml()}</div>`
          // The records are the datastore's and the station list is a file, so
          // the whole timeline reads without one. Only the per-station scope
          // needs it — same arrangement as the ARRO tabs.
          : `<p class="small hist-muted">Load a station file to scope this to one station. Every
               record below reads from the datastore and needs no file.</p>`}
        ${s.unmatched
          ? `<p class="small hist-muted">Imported visits parked with no station: #125's crosswalk
               could not identify these, so they are attributed to nobody and no per-station view
               reaches them. Each keeps the name and CBM number its sheet carried, and
               <code>meganet.backfill_inspection_station()</code> accepts a match later without a
               reload.</p>`
          : s.station
          ? `<p class="small hist-muted">Showing every record at
               <strong>${esc(s.station.name)}</strong>${
               s.station.number ? ` (${esc(s.station.number)})` : ''} —
               <button class="btn-link" onclick="goToStation('${escAttr(s.station.id)}')">open it on the
               Stations map</button>.</p>`
          : `<p class="small hist-muted">Showing the most recent ${ACROSS_ALL} records across every
               station. Pick one above for its whole history.</p>`}
      </div>`;
  }

  function matchesHtml() {
    const s = S();
    const q = s.query.trim().toLowerCase();
    if (!q) return '';
    const all = (state.data && state.data.stations) || [];
    const hits = all.filter(st =>
      (st.name || '').toLowerCase().includes(q) ||
      (st.station_number || '').toLowerCase().includes(q) ||
      Object.values(st.alert_ids || {}).some(id => String(id) === q)
    ).slice(0, 25);
    if (!hits.length) return `<p class="small hist-muted">No station matches “${esc(s.query)}”.</p>`;
    return `
      <div class="hist-hits">
        ${hits.map(st => `
          <button class="hist-hit" onclick="History.pick('${escAttr(st.id)}')">
            <span class="hist-hit-name">${esc(st.name)}</span>
            <span class="small hist-muted">${esc(st.station_number || '—')}</span>
          </button>`).join('')}
      </div>`;
  }

  // ── The list ───────────────────────────────────────────────────────────────

  function listHtml() {
    const s = S();
    if (s.listError) {
      return `
        <div class="panel hist-note hist-bad">
          <p class="small">${esc(s.listError)}</p>
          <button onclick="History.retry()">Try again</button>
        </div>`;
    }
    if (!s.list) return `<div class="panel hist-note"><p class="small hist-muted">Loading…</p></div>`;
    if (!s.list.length) {
      return `
        <div class="panel hist-note">
          <p class="small hist-muted">${s.unmatched
            ? 'Every imported visit is matched to a station — nothing is parked.'
            : s.station
            ? `Nothing has been recorded at ${esc(s.station.name)} yet.`
            : 'No inspections or maintenance forms have been recorded yet.'}</p>
          ${s.unmatched ? '' : `<p class="small hist-muted">Records typed on the Inspections and
            Site Maintenance tabs appear here as soon as they are saved, and the ~35 years of
            paper history from <code>QLD All Site Inspections.xlsx</code> is loaded beside them
            (#122) — a station showing nothing here has no record in either.</p>`}
        </div>`;
    }
    // The archive makes sixty-visit stations ordinary, so the heading says how
    // deep the list goes — and the earliest year is the archive's own headline.
    const earliest = s.list[s.list.length - 1].on;
    return `
      <div class="panel hist-list-panel">
        <div class="panel-header">
          <!-- The station is in the heading rather than only in the picker
               above, because the picker does not print and a printed list of
               visits that does not say whose visits they are is not much of a
               record. -->
          <h3>${s.unmatched ? 'Not matched — ' : s.station ? `${esc(s.station.name)} — ` : ''}${
            s.list.length} record${s.list.length === 1 ? '' : 's'}${
            (s.station || s.unmatched) && s.list.length > 1 && earliest
              ? ` <span class="small hist-muted">· back to ${esc(earliest.slice(0, 4))}</span>` : ''}</h3>
          <div class="hist-head-actions">
            <button onclick="History.exportList()">Export this list (CSV)</button>
          </div>
        </div>
        <div class="hist-scroll">
          <table class="hist-table">
            <thead><tr>
              <th>Date</th><th>Station</th><th>Form</th><th>By</th><th>On departure</th><th></th>
            </tr></thead>
            <tbody>
              ${s.list.map(r => rowHtml(r)).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function formLabel(r) {
    return r.kind === 'inspection'
      ? Inspections.configLabel(r.config_key) : 'Council Maintenance Tasks';
  }

  // Whether the printed instruction at the foot of an inspection sheet was
  // followed. A tick and an exclamation mark rather than two words, because this
  // is a column somebody scans down.
  const RAISED = 'A Council maintenance form was raised against this visit.';
  const NOT_RAISED = 'The sheet asks for a Council maintenance form for a site that departs like '
                   + 'this, and none has been raised.';

  function rowHtml(r) {
    const flags = (S().flags && S().flags[r.id]) || [];
    // A date the workbook only half gave renders as what it gave. `1990` in
    // this column is a claim about a year; `1990-01-01` would be the list
    // asserting a day the paper never said (#128, 0014's date_precision).
    const loose = r.date_precision !== 'day' && r.date_raw;
    return `
      <tr class="hist-row ${flags.length ? 'hist-row-flagged' : ''}">
        <td class="hist-date">${loose
          ? `<span title="The workbook recorded only this — precision: ${escAttr(r.date_precision)}">${
              esc(r.date_raw)}</span>`
          : esc(r.on || '—')}</td>
        <td>${esc(r.station_name || r.station_id || 'Unnamed site')}${
          r.cbm_no ? `<span class="small hist-muted"> · ${esc(r.cbm_no)}</span>` : ''}${
          r.origin === 'import' && !r.station_id
            ? '<span class="small hist-muted"> · not matched</span>' : ''}</td>
        <td>${esc(formLabel(r))}${
          r.kind === 'maintenance' && r.from_inspection
            ? '<span class="small hist-muted"> · from an inspection</span>' : ''}${
          r.origin === 'import' ? '<span class="small hist-muted"> · imported</span>' : ''}</td>
        <td>${esc(r.who || '—')}</td>
        <td>${flags.length
          ? flags.map(f => `<span class="hist-flag" title="${
              escAttr(f.has_maintenance_activity ? RAISED : NOT_RAISED)}">${
              esc(param(f.parameter))} ${esc(f.on_departure_label)}${
              f.has_maintenance_activity ? ' ✓' : ' !'}</span>`).join(' ')
          : '<span class="hist-muted">—</span>'}</td>
        <td class="hist-actions">
          <button class="btn-link"
                  onclick="History.open('${escAttr(r.kind)}','${escAttr(r.id)}')">Open</button>
        </td>
      </tr>`;
  }

  function param(p) {
    return { rain: 'Rain', water_level: 'Water Level',
             rainfall: 'Rainfall', river_level: 'River Level' }[p] || p;
  }

  // ── One record, read-only ──────────────────────────────────────────────────

  function model() {
    const s = S();
    if (!s.open || !s.open.doc) return null;
    const m = s.open.kind === 'inspection'
      ? Inspections.recordModel(s.open.doc)
      : Maintenance.recordModel(s.open.doc);
    if (m && m.origin === 'import') amendImport(m);
    return m;
  }

  // What is different about an imported record, put into the model rather than
  // the renderer — so the screen, the printed page and the CSV keep being three
  // renderings of one walk (#118's design, extended rather than forked).
  //
  // The transcription goes FIRST, because for an import it is the record: a
  // 1994 row is three cells, and the modern form's sections below it are the
  // projection of those cells into today's layout — right for comparing eras,
  // and silent about a `>30`, a `U/S` or a sentence, each of which projects to
  // no number on purpose (0014's check constraint). Here they read verbatim.
  function amendImport(m) {
    const s = S();
    const src = s.open.src;
    const cells = s.open.cells;

    // A date the workbook only half gave. The heading must not sharpen `1990`
    // into 1 January 1990 — and the CSV and its filename carry the same words.
    if (src && src.date_precision && src.date_precision !== 'day' && src.date_raw) {
      const h = m.heading.find(x => x.label === 'Date');
      if (h) h.value = `${src.date_raw} — recorded to the ${src.date_precision}`;
      m.dated = src.date_raw;
    }

    const sec = {
      key: '_transcription', ord: '§', label: 'As transcribed from the workbook',
      note: '', blocks: [], tables: [], lines: [], files: [],
    };

    if (src) {
      sec.lines.push({ kind: 'note',
        text: `Source: ${src.source_workbook || 'workbook'} — sheet ${src.source_sheet || '?'}, `
            + `row ${src.source_row != null ? src.source_row : '?'}`
            + `${src.source_ref ? ` (${src.source_ref})` : ''}. Anyone doubting a number can open `
            + 'the cell it came from.' });
      if (!m.station_id) {
        sec.lines.push({ kind: 'flag',
          text: `Not matched to a station: the sheet called it “${m.title}” and the crosswalk `
              + `could not identify which station that is (${src.station_match || 'unmatched'}). `
              + 'A match accepted later attributes it without a reload — '
              + 'meganet.backfill_inspection_station().' });
      }
    }

    if (!cells) {
      sec.note = s.open.cellsError
        ? `The transcription could not be read — ${s.open.cellsError}. The sections below still `
          + 'show the numbers projected into the modern form.'
        : 'Reading the transcription…';
    } else {
      sec.tables.push({
        note: '“As written” is the record and is never repaired; “Reads as” is the interpretation '
            + 'the loader licensed. A bound (>30), a status word (U/S) or a sentence has no '
            + 'number, deliberately — the sections below can only show the cells that do.',
        columns: ['Box', 'As written', 'Reads as', 'Unit'],
        labelCols: [0], // Box names the sheet's field — a label, not a reading
        rows: cells.map(c => [
          c.label || c.field_key || (c.source_col ? `column ${c.source_col}` : ''),
          c.raw,
          readsAs(c),
          c.unit || '',
        ]),
      });
    }

    m.sections.unshift(sec);

    // The derived events (#127), after the transcription they were read from.
    // Marked as what they are: readings by rules, not technician entries, and
    // every one shows the words it was read from — the issue's discipline that
    // the prose stays the source of truth wherever an extraction appears.
    const events = s.open.events;
    if (events && events.length) {
      const types = Object.fromEntries((s.eventTypes || []).map(t => [t.key, t.label]));
      m.sections.splice(1, 0, {
        key: '_events', ord: '§', label: 'Derived events',
        note: 'Read from the remarks by rules (tools/ingest/remarks.py), not entered by a '
            + 'technician. Each event names the words it was read from; the remark itself is '
            + 'the record.',
        blocks: [], lines: [], files: [],
        tables: [{
          columns: ['Event', 'Confidence', 'Read from'],
          labelCols: [2], // the quote is the remark's prose, not a value
          rows: events.map(e => [
            (types[e.event_type] || e.event_type)
              + (e.detail && e.detail.equipment ? ` — ${e.detail.equipment}` : '')
              + (e.detail && e.detail.figures ? ` (${e.detail.figures.join(', ')}` +
                 (e.detail.figures_meaning === 'unconfirmed' ? ' — figures unconfirmed)' : ')') : ''),
            e.confidence,
            e.quote,
          ]),
        }],
      });
    }
  }

  function readsAs(c) {
    if (c.value != null) return String(c.value);
    if (c.operator != null && c.bound != null) return `${c.operator}${c.bound} — a bound, not a reading`;
    if (c.status) return `${c.status} — a status, not a number`;
    if (c.value_class === 'prose') return 'prose — kept whole';
    return c.value_class || '';
  }

  function recordHtml() {
    const s = S();
    if (s.openError) {
      return `
        <div class="panel hist-note hist-bad">
          <p class="small">${esc(s.openError)}</p>
          <button onclick="History.close()">Back to the list</button>
        </div>`;
    }
    if (s.openBusy || !s.open.doc) {
      return `<div class="panel hist-note"><p class="small hist-muted">Opening…</p></div>`;
    }
    // The vocabularies decide what every pick-list value reads as, so a record
    // rendered without them would be a page of raw keys. Say so instead.
    const owner = s.open.kind === 'inspection' ? Inspections : Maintenance;
    const refsError = owner.refsError();
    if (!owner.refsReady()) {
      return `
        <div class="panel hist-note ${refsError ? 'hist-bad' : ''}">
          <p class="small">${refsError
            ? `The form's own words could not be loaded — ${esc(refsError)}. The record is in the
               database; what is missing is the vocabulary that says what its pick-list values read
               as, so it is not rendered rather than rendered as a page of keys.`
            : 'Loading the form…'}</p>
        </div>`;
    }

    const m = model();
    return `
      ${toolsHtml(m)}
      <div class="hist-doc" id="hist-doc">
        ${docHeadHtml(m)}
        ${m.sections.map(sec => sectionHtml(sec)).join('')}
        ${absentHtml(m)}
        ${docFootHtml(m)}
      </div>`;
  }

  function toolsHtml(m) {
    const s = S();
    return `
      <div class="panel hist-tools">
        <div class="hist-head-actions">
          <button onclick="History.close()">← Back to the list</button>
          <button class="primary" onclick="History.print()">Print / save as PDF</button>
          <button onclick="History.exportRecord()">Export this record (CSV)</button>
          <button onclick="History.edit()">Open in the form to edit</button>
        </div>
        <p class="small hist-muted">Read-only. Editing happens on the
          ${s.open.kind === 'inspection' ? 'Inspections' : 'Site Maintenance'} tab, which is the one
          that holds the 409 contract — two people editing one record is a conflict the database
          detects, and it can only do that for a form that loaded a stamp.
          ${m.updated_at ? `Last written ${esc(new Date(m.updated_at).toLocaleString())}.` : ''}</p>
        <p class="small hist-bad-text" id="hist-msg">${esc(s.msg || '')}</p>
      </div>`;
  }

  // The printed head of the sheet. The Bureau's logo sits top-left of every form
  // in the workbook; the image itself is not in this repository, so this is a
  // wordmark rather than a reproduction of it — right shape, no invented
  // artwork. Replacing it with the real asset is a one-line change here.
  function docHeadHtml(m) {
    return `
      <section class="panel hist-doc-head">
        <div class="hist-brand">
          <span class="hist-brand-mark">Bureau of Meteorology</span>
          <span class="hist-brand-sub">Hydrology</span>
        </div>
        <h3 class="hist-doc-title">${m.kind === 'inspection'
          ? 'Station Inspection Form' : 'Council Site Maintenance Tasks'}</h3>
        <p class="hist-doc-form">${esc(m.form)}${
          m.sheet ? ` <span class="small hist-muted">— sheet <code>${esc(m.sheet)}</code></span>` : ''}</p>
        ${m.formNote ? `<p class="small hist-muted">${esc(m.formNote)}</p>` : ''}
        <div class="hist-grid hist-heading">
          ${m.heading.map(h => valueHtml(h.label, h.value, '')).join('')}
        </div>
        ${m.origin === 'import'
          ? `<p class="small hist-import">Loaded from the historical workbook rather than typed on
               this form — <code>origin = 'import'</code>.</p>` : ''}
      </section>`;
  }

  function sectionHtml(sec) {
    return `
      <section class="panel hist-section" data-section="${escAttr(sec.key)}">
        <div class="hist-banner">
          <span class="hist-banner-ord">${sec.ord}</span>
          <span class="hist-banner-label">${esc(sec.label)}</span>
        </div>
        ${sec.note ? `<p class="small hist-variant">${esc(sec.note)}</p>` : ''}
        ${sec.empty ? emptyHtml() : ''}
        ${sec.blocks.map(b => blockHtml(b)).join('')}
        ${sec.tables.map(t => tableHtml(t)).join('')}
        ${sec.lines.map(l => lineHtml(l)).join('')}
        ${sec.files.map(f => filesHtml(f)).join('')}
      </section>`;
  }

  // The distinction 0009 exists to protect, on screen: a section this form does
  // print, with no row saved against it, is a section nobody filled in — which
  // is not the same as a section this form does not have, and is not the same as
  // a grid of empty boxes either.
  function emptyHtml() {
    return `<p class="small hist-empty">Nothing was recorded in this section — the sheet prints it
      and it was left blank. The database holds no row for it, which is how “nobody filled this in”
      is spelled.</p>`;
  }

  function blockHtml(b) {
    const fields = b.fields.filter(f => f.label);
    if (!fields.length) return '';
    return `
      ${b.title ? `<h4 class="hist-block">${esc(b.title)}</h4>` : ''}
      ${b.note ? `<p class="small hist-muted">${esc(b.note)}</p>` : ''}
      <div class="hist-grid">
        ${fields.map(f => valueHtml(f.label, f.value, f.note)).join('')}
      </div>`;
  }

  // A value under its printed label, in a box the shape of the one on paper.
  // Deliberately not a disabled input: a disabled input prints as whatever the
  // browser thinks a dead form control looks like, and reads as something
  // somebody could have typed in and did not.
  function valueHtml(label, value, note) {
    const filled = value !== '' && value != null;
    return `
      <div class="hist-field${filled ? '' : ' hist-field-blank'}">
        <span class="hist-label">${esc(label)}${
          note ? `<span class="hist-hint">${esc(note)}</span>` : ''}</span>
        <span class="hist-value">${filled ? esc(value) : '—'}</span>
      </div>`;
  }

  function tableHtml(t) {
    // Which columns are labels rather than recorded values. A table can say so
    // itself (labelCols, used by the transcription and derived-events tables
    // below); the ones the two recordModel()s emit don't, so the tell is the
    // header: an unnamed first column or a '#' is the sheet's own row label
    // (the QC tables' parameter names, a calibration block's row number), and
    // colouring those green would light up exactly the words the highlight
    // exists to get past. Everything else in a row is what the visit recorded.
    const labelCols = new Set(t.labelCols
      || (t.columns.length && (t.columns[0] === '' || t.columns[0] === '#') ? [0] : []));
    return `
      ${t.title ? `<h4 class="hist-block">${esc(t.title)}</h4>` : ''}
      ${t.note ? `<p class="small hist-muted">${esc(t.note)}</p>` : ''}
      <div class="hist-scroll">
        <table class="hist-table hist-grid-table">
          <thead><tr>${t.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>
            ${t.rows.map(r => `<tr>${r.map((c, i) =>
              `<td>${c === '' || c == null ? '<span class="hist-muted">—</span>'
                : labelCols.has(i) ? esc(c)
                : `<span class="hist-cell-value">${esc(c)}</span>`}</td>`
            ).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function lineHtml(l) {
    return `<p class="small ${l.kind === 'flag' ? 'hist-flagline' : 'hist-footnote'}">${esc(l.text)}</p>`;
  }

  function filesHtml(f) {
    return `
      <h4 class="hist-block">${esc(f.label)}</h4>
      ${f.note ? `<p class="small hist-muted">${esc(f.note)}</p>` : ''}
      ${!f.items.length
        ? `<p class="small hist-muted">None attached.</p>`
        : `<div class="hist-files">
             ${f.items.map(a => fileHtml(a)).join('')}
           </div>`}`;
  }

  function fileHtml(a) {
    const url = S().urls[a.path];
    const caption = `<span class="small hist-file-cap">${esc(a.caption || a.title || 'Untitled')}</span>`;
    if (INLINE.test(a.content_type || '')) {
      return `
        <figure class="hist-file">
          <img data-att-path="${escAttr(a.path)}" alt="${escAttr(a.caption || a.title || 'Photo')}"
               ${url ? `src="${escAttr(url)}"` : ''}>
          <figcaption>${caption}</figcaption>
        </figure>`;
    }
    return `
      <div class="hist-file hist-file-doc">
        <button class="btn-link" onclick="History.viewFile('${escAttr(a.bucket)}','${escAttr(a.path)}')">
          Open ${esc(a.title || 'the file')}</button>
        ${caption}
      </div>`;
  }

  function absentHtml(m) {
    if (!m.absent.length) return '';
    return `
      <section class="panel hist-absent">
        <h4 class="hist-block">Not on this form</h4>
        <p class="small hist-muted">The ${esc(m.form)} sheet does not print these, so their absence
          is not a gap in the record — and the database refuses a row for one, which is what keeps
          “this station has no gas bubbler” a different fact from “nobody filled the gas section
          in”.</p>
        <ul class="small hist-absent-list">
          ${m.absent.map(s => `<li><strong>${esc(s.label)}</strong>${
            s.note ? ` — ${esc(s.note)}` : ''}</li>`).join('')}
        </ul>
      </section>`;
  }

  function docFootHtml(m) {
    return `
      <section class="panel hist-doc-foot">
        <p class="small hist-muted">${m.kind === 'inspection' ? 'Inspection' : 'Maintenance form'}
          <code>${esc(m.id || '')}</code>${m.station_id
            ? ` · station <code>${esc(m.station_id)}</code>` : ' · not matched to a station'}.
          Printed from MegaNet on ${esc(new Date().toLocaleDateString())}.</p>
      </section>`;
  }

  // ── Opening a file ─────────────────────────────────────────────────────────
  // Signed when it is clicked, opened in a tab, and not kept. A URL that opens a
  // private object is not something to hold on to.

  function viewFile(bucket, path) {
    say('');
    dbSignedUrl(bucket, path)
      .then(url => window.open(url, '_blank', 'noopener'))
      .catch(err => say(`Could not open that file — ${(err && err.message) || err}`));
  }

  // One line in the toolbar, patched in place. The record on screen is not
  // re-rendered for it: re-rendering would re-request every signed URL the
  // photos are drawn from, which is a lot of work to say one sentence.
  function say(text) {
    S().msg = text || null;
    const el = document.getElementById('hist-msg');
    if (el) el.textContent = text || '';
  }

  // ── Print ──────────────────────────────────────────────────────────────────

  function print() {
    window.print();
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  //
  // Two files, and they answer two different questions. The list is "what
  // happened at this site", one row per visit, the shape a spreadsheet wants.
  // The record is one visit in full, one row per printed box, carrying the
  // section and block a box sits under — because a flat row of 200 columns
  // loses the grouping the sheet is *made* of, and the grouping is the thing
  // somebody reading a form back is using to find anything.

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCsv(rows) {
    return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  function download(name, text) {
    // A BOM, because these open in Excel more often than in anything else and
    // Excel reads a UTF-8 CSV as the local code page without one — which turns
    // every ° and every ’ in a remarks box into mojibake.
    const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportList() {
    const s = S();
    if (!s.list || !s.list.length) return;
    const rows = [['date', 'kind', 'station', 'station_id', 'cbm_no', 'form', 'by',
                   'on_departure', 'maintenance_raised', 'origin', 'record_id']];
    s.list.forEach(r => {
      const flags = (s.flags && s.flags[r.id]) || [];
      rows.push([
        r.on, r.kind, r.station_name || '', r.station_id || '', r.cbm_no || '',
        formLabel(r), r.who,
        flags.map(f => `${param(f.parameter)}: ${f.on_departure_label}`).join(' · '),
        flags.length ? (flags.every(f => f.has_maintenance_activity) ? 'yes' : 'no') : '',
        r.origin || '', r.id,
      ]);
    });
    download(`meganet-history-${s.station ? slug(s.station.name) : 'all-stations'}.csv`, toCsv(rows));
  }

  function exportRecord() {
    const m = model();
    if (!m) return;
    const rows = [['station', 'cbm_no', 'date', 'form', 'section', 'block', 'field', 'value']];
    const head = [m.title, headingValue(m, 'CBM No'), m.dated, m.form];

    m.heading.forEach(h => rows.push([...head, 'Header', '', h.label, h.value]));

    m.sections.forEach(sec => {
      if (sec.empty) rows.push([...head, sec.label, '', '(not recorded)', '']);
      sec.blocks.forEach(b => b.fields.forEach(f =>
        rows.push([...head, sec.label, b.title || '', f.label, f.value])));
      sec.tables.forEach(t => t.rows.forEach((r, i) => r.forEach((cell, j) =>
        rows.push([...head, sec.label, t.title || '',
                   `${t.columns[j] || `col ${j + 1}`} (row ${i + 1})`, cell]))));
      sec.lines.forEach(l => rows.push([...head, sec.label, '', 'Note', l.text]));
      // The object path rather than a signed URL, deliberately: a link that
      // still opens a private photo weeks later does not belong in a file
      // somebody mails around. #149's second bullet.
      sec.files.forEach(f => f.items.forEach(a =>
        rows.push([...head, sec.label, f.label, a.title || 'attachment', a.path])));
    });

    m.absent.forEach(a => rows.push([...head, 'Not on this form', '', a.label, a.note]));

    download(`meganet-${m.kind}-${slug(m.title)}-${m.dated || 'undated'}.csv`, toCsv(rows));
  }

  function headingValue(m, label) {
    const h = m.heading.find(x => x.label === label);
    return h ? h.value : '';
  }

  function slug(s) {
    return String(s || 'record').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '').slice(0, 60) || 'record';
  }

  // Straight to the form that owns this record, which is where editing belongs.
  function edit() {
    const s = S();
    if (!s.open) return;
    const { kind, id } = s.open;
    switchTab(kind === 'inspection' ? 'inspections' : 'maintenance');
    if (kind === 'inspection') Inspections.open(id); else Maintenance.open(id);
  }

  return {
    render, init, search, pick, clearStation, showUnmatched, open, close, refresh, retry,
    print, exportList, exportRecord, edit, viewFile,
  };
})();
