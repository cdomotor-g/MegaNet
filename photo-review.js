// MegaNet — photo-review.js
//
//   PhotoReview   the Field Photos tab's Review panel: what came in and what
//                 became of it — from this browser, and from every way in —
//                 and the equipment the photos show, read off their labels,
//                 proposed for each station's register and approved or
//                 rejected by an administrator. And the station card's
//                 Equipment section, which is where what was approved shows.
//
// After field-photos.js, whose tab draws this panel and whose queue it lists,
// and after photo-meta.js and photo-equipment.js, which read the labels —
// index.html holds the order and the reasons. Reaches back to core.js for
// state, esc, escAttr and announce; to datastore.js for dbSelect and dbRpc;
// to field-photos.js for FieldPhotos (the queue, signing, the viewer, the
// station finder); to photo-meta.js for PhotoMeta.ocrLabels; to
// photo-equipment.js for PhotoEquipment.parse; to app.js for docUrl. Every one
// of those is a runtime call from inside a function here; nothing executes at
// load (`npm run toplevel`).
//
// ── Three lists ──────────────────────────────────────────────────────────────
//
//   1. **From this browser** — the queue, as it stands: each file, the zip it
//      came out of, and what happened to it. The queue is this tab's memory
//      and goes with a reload; the list below it does not.
//   2. **Recent uploads** — meganet.field_photo_upload (0036), the last two
//      hundred attempts from the tab, Dropbox and Google Drive: when, who, the
//      file and its zip, the outcome and why, the station, and the photo it
//      became. Filtered by outcome and by way in, in the database, so "the
//      failures" is the last two hundred failures and not the failures among
//      the last two hundred.
//   3. **Equipment suggestions** — meganet.equipment_suggestion, pending ones
//      first, each with its photo, the text it was read from, and what the
//      station's register says now, beside the values proposed — editable,
//      for an administrator to put right before approving. Decided ones
//      below, folded.
//
// ── Who may decide ───────────────────────────────────────────────────────────
//
// An administrator: meganet.is_admin(), asked of the database once a sign-in
// and never guessed from the token. Everyone else who can see this panel — an
// editor — sees the same lists and can read photos' labels, which only ever
// makes suggestions; the Approve and Reject buttons are there, disabled, with
// the sentence saying why and what an administrator is. The database refuses
// a non-administrator's decision whatever this panel draws.
//
// ── Reading labels ───────────────────────────────────────────────────────────
//
// scan() is the one way a photo's labels get read — the viewer's 🔎 button, a
// station's worth from this panel, and the photos just uploaded when the add
// panel's box is ticked all go through it: one photo at a time, the whole
// frame and its quarters by PhotoMeta.ocrLabels (seconds a photo, bounded
// passes), candidates by PhotoEquipment.parse, each proposed as 'ocr' with the
// text it came from. A proposal the database already has — waiting, on the
// register, or rejected before from that photo — is counted as known, not as
// a failure. One scan at a time, and it can be stopped between photos.
//
// Schema: db/migrations/0036_photo_review.sql. The rest: docs/field-photos.md.

const PhotoReview = (function () {

  const UPLOADS = 200;     // log rows in the list
  const PENDING = 100;     // suggestions waiting
  const DECIDED = 50;      // …and decided, folded under them
  const SCAN_MAX = 60;     // photos in one station's scan
  const CARD_FRESH = 60000;

  const OUTCOME = {
    imported:  { word: 'Imported',           cls: 'ok' },
    unplaced:  { word: 'Unplaced',           cls: 'warn' },
    duplicate: { word: 'Already in MegaNet', cls: 'muted' },
    refused:   { word: 'Refused',            cls: 'bad' },
    failed:    { word: 'Failed',             cls: 'bad' },
    skipped:   { word: 'Skipped',            cls: 'muted' },
  };
  const ORIGIN = { upload: 'This tab', dropbox: 'Dropbox', gdrive: 'Google Drive' };
  const STATUS = { approved: 'Approved', rejected: 'Rejected', superseded: 'Superseded' };

  let kinds = null, kindsP = null;   // meganet.equipment_kind, public
  let cards = {};                    // station id → { at, rows, p } — the station card's section
  let queueTimer = 0;

  // ── Small things ───────────────────────────────────────────────────────────

  function R() {
    const s = state.photos;
    if (!s.review) {
      s.review = {
        loaded: false, loading: false, admin: null, adminError: null,
        uploads: null, uploadsError: null, filtered: null, filter: { outcome: '', origin: '' },
        pending: null, decided: null, suggestError: null, photos: {}, register: {},
        drafts: {}, notes: {}, busy: {}, msgs: {},
        scan: null, scanResult: null, scanFind: '', scanStation: '', scanPhotos: null, scanError: null,
      };
    }
    return s.review;
  }
  function signedIn() { return typeof FieldPhotos !== 'undefined' && FieldPhotos.signedIn(); }
  function stationById(id) { return ((state.data && state.data.stations) || []).find(s => s.id === id) || null; }
  function stationName(id) { const st = stationById(id); return st ? st.name : (id || ''); }
  function errText(err) { return (err && err.message) || String(err); }
  function missing(text) { return /(field_photo_upload|equipment_suggestion|station_equipment|is_admin|log_field_photo_upload|propose_equipment|decide_equipment)/.test(text || '') && /(does not exist|schema cache|not find|404)/i.test(text || ''); }
  function doc(anchor) {
    const p = `docs/field-photos.md${anchor ? `#${anchor}` : ''}`;
    return esc(typeof docUrl === 'function' ? docUrl(p) : p);
  }
  function when(iso) {
    const t = Date.parse(iso);
    return isFinite(t) ? new Date(t).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }
  function kindLabel(key) {
    const k = (kinds || []).find(x => x.key === key);
    return k ? k.label : String(key || '').replace(/_/g, ' ');
  }
  function unitText(u) {
    const name = [u.make, u.model].filter(Boolean).join(' ');
    return `${name || kindLabel(u.equipment_key)}${u.serial_no ? ` · s/n ${u.serial_no}` : ''}`;
  }
  function proposer(p) {
    if (p === 'ocr') return 'read off the photo';
    if (/^agent:/.test(p || '')) return `agent ${p.slice(6)}`;
    return p || 'somebody';
  }
  // `in.(…)` for PostgREST, every value quoted — a station id is a slug today,
  // and a quoted value is right whatever it is tomorrow.
  function inList(values) {
    return `in.(${values.map(v => encodeURIComponent(`"${String(v).replace(/"/g, '\\"')}"`)).join(',')})`;
  }

  function loadKinds() {
    if (kinds) return Promise.resolve(kinds);
    if (!kindsP) {
      kindsP = dbSelect('equipment_kind?select=key,label,ord&order=ord')
        .then(rows => { kinds = rows; return kinds; })
        .catch(() => { kindsP = null; return []; });
    }
    return kindsP;
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  function load(force) {
    const r = R();
    if (!signedIn() || r.loading || (r.loaded && !force)) return;
    r.loading = true;
    repaint();
    Promise.allSettled([loadAdmin(), loadKinds(), loadUploads(), loadSuggestions()])
      .finally(() => { r.loading = false; r.loaded = true; repaint(); });
  }

  // The database's answer, not the token's: is_admin() reads meganet.app_user
  // and editor_allow, neither of which this browser can see.
  async function loadAdmin() {
    const r = R();
    try { r.admin = (await dbRpc('is_admin', {})) === true; r.adminError = null; }
    catch (err) { r.admin = false; r.adminError = errText(err); }
  }

  async function loadUploads() {
    const r = R();
    try {
      r.uploads = await dbSelect(`field_photo_upload?select=*&order=attempted_at.desc&limit=${UPLOADS}`);
      r.uploadsError = null;
      await loadFiltered();
    } catch (err) {
      r.uploads = [];
      r.uploadsError = errText(err);
    }
  }
  async function loadFiltered() {
    const r = R(), f = r.filter;
    if (!f.outcome && !f.origin) { r.filtered = null; return; }
    let q = `field_photo_upload?select=*&order=attempted_at.desc&limit=${UPLOADS}`;
    if (f.outcome) q += `&outcome=eq.${encodeURIComponent(f.outcome)}`;
    if (f.origin) q += `&origin=eq.${encodeURIComponent(f.origin)}`;
    try { r.filtered = await dbSelect(q); r.uploadsError = null; } catch (err) { r.filtered = []; r.uploadsError = errText(err); }
  }

  // The suggestions, the photos they were read off (for a thumbnail each) and
  // the live register at each station with one waiting — what the
  // administrator compares the proposal with.
  async function loadSuggestions() {
    const r = R();
    try {
      const [pending, decided] = await Promise.all([
        dbSelect(`equipment_suggestion?select=*&status=eq.pending&order=created_at.desc&limit=${PENDING}`),
        dbSelect(`equipment_suggestion?select=*&status=neq.pending&order=decided_at.desc&limit=${DECIDED}`),
      ]);
      const photoIds = [...new Set([...pending, ...decided].map(s => s.photo_id).filter(Boolean))];
      const stationIds = [...new Set(pending.map(s => s.station_id))];
      const [photos, register] = await Promise.all([
        photoIds.length ? dbSelect(`field_photo?select=id,storage_path,thumb_path,title,station_id&id=${inList(photoIds)}`).catch(() => []) : [],
        stationIds.length ? dbSelect(`station_equipment?select=*&retired_at=is.null&station_id=${inList(stationIds)}&order=created_at`) : [],
      ]);
      r.photos = Object.fromEntries(photos.map(p => [p.id, p]));
      r.register = {};
      for (const u of register) (r.register[u.station_id] = r.register[u.station_id] || []).push(u);
      r.pending = pending;
      r.decided = decided;
      r.suggestError = null;
      for (const id of Object.keys(r.drafts)) if (!pending.some(s => s.id === id)) delete r.drafts[id];
    } catch (err) {
      r.pending = r.pending || [];
      r.decided = r.decided || [];
      r.suggestError = errText(err);
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function html() {
    if (!signedIn()) {
      return '<p class="small txt-muted">Sign in to see what came in and what became of it, and the equipment the photos show.</p>';
    }
    const r = R();
    const n = r.pending ? r.pending.length : 0;
    return `
      <div id="pr-intro">${introHtml()}</div>
      <section class="pr-sect" aria-labelledby="pr-queue-h">
        <h3 id="pr-queue-h">From this browser</h3>
        <div id="pr-queue">${queueHtml()}</div>
      </section>
      <section class="pr-sect" aria-labelledby="pr-up-h">
        <h3 id="pr-up-h">Recent uploads</h3>
        <div id="pr-uploads">${uploadsHtml()}</div>
      </section>
      <section class="pr-sect" aria-labelledby="pr-eq-h">
        <h3 id="pr-eq-h">Equipment suggestions${n ? ` <span class="pr-count">${n} waiting</span>` : ''}</h3>
        <div id="pr-scan">${scanHtml()}</div>
        <div id="pr-sugs">${suggestionsHtml()}</div>
      </section>`;
  }

  function introHtml() {
    const r = R();
    const bits = [];
    if (r.admin === true) {
      bits.push(`<p class="small">You are an <strong>administrator</strong>: approving a suggestion writes it into the
        station's equipment register, after any correction you make; rejecting one changes nothing but the suggestion.</p>`);
    } else if (r.admin === false) {
      bits.push(`<p class="small" id="pr-why">Approving or rejecting a suggestion is for an <strong>administrator</strong> —
        an editor the owner has marked as one (<a href="${doc('administrators')}" target="_blank" rel="noopener">how</a>).
        You can see everything here, and read photos' labels, which only ever makes suggestions.${
        r.adminError ? ` <span class="txt-muted">(The database could not say whether you are one — ${esc(r.adminError)}.)</span>` : ''}</p>`);
    } else {
      bits.push('<p class="small txt-muted">Checking what you may do here…</p>');
    }
    const logError = typeof FieldPhotos !== 'undefined' ? FieldPhotos.logError() : null;
    if (logError) {
      bits.push(`<p class="small txt-warn">What the last upload did could not be recorded for this panel — ${esc(logError)}.
        The photos themselves are unaffected.${missing(logError) ? ' Apply <code>db/migrations/0036_photo_review.sql</code>.' : ''}</p>`);
    }
    return bits.join('');
  }

  function queueHtml() {
    const q = state.photos.queue || [];
    const packs = typeof FieldPhotos !== 'undefined' ? FieldPhotos.packs() : [];
    if (!q.length && !packs.length) {
      return '<p class="small txt-muted">Nothing has been added in this browser since the page was opened.</p>';
    }
    const tally = {};
    for (const i of q) tally[i.status] = (tally[i.status] || 0) + 1;
    const word = st => (typeof FieldPhotos !== 'undefined' ? FieldPhotos.statusText(st) : st);
    const summary = Object.entries(tally).map(([st, n]) => `${n} ${word(st).toLowerCase()}`).join(', ');
    return `
      <p class="small">${q.length} file${q.length === 1 ? '' : 's'}${summary ? `: ${esc(summary)}` : ''}.${
        packs.length ? ` ${packs.length} zip${packs.length === 1 ? '' : 's'}: ${esc(packs.map(p => `${p.name} — ${p.note}`).join(' '))}` : ''}</p>
      ${q.length ? `<div class="table-wrap">
        <table class="pr-table">
          <caption class="sr-only">The files added in this browser and what became of each</caption>
          <thead><tr><th scope="col">File</th><th scope="col">State</th><th scope="col">What happened</th></tr></thead>
          <tbody>${q.map(i => `<tr>
            <td><span class="pr-file">${esc(i.name)}</span>${i.from ? ` <span class="small txt-muted">from ${esc(i.from)}</span>` : ''}</td>
            <td class="pr-q-${esc(i.status)}">${esc(word(i.status))}</td>
            <td class="small">${esc(i.note || '')}</td></tr>`).join('')}</tbody>
        </table>
      </div>` : ''}`;
  }

  function uploadsHtml() {
    const r = R();
    if (!r.uploads && !r.uploadsError) return '<p class="small">Loading…</p>';
    if (r.uploadsError && !(r.uploads || []).length) {
      return `<p class="small txt-bad">${missing(r.uploadsError)
        ? 'This database has no upload log yet — apply <code>db/migrations/0036_photo_review.sql</code>.'
        : `The upload log could not be read — ${esc(r.uploadsError)}.`}
        <button type="button" class="link-btn" onclick="PhotoReview.reload()">Try again</button></p>`;
    }
    const all = r.uploads || [];
    const counts = {};
    for (const u of all) counts[u.outcome] = (counts[u.outcome] || 0) + 1;
    const f = r.filter;
    const chip = (key, label, n) => `<button type="button" class="fp-filter${f.outcome === key ? ' is-on' : ''}" aria-pressed="${f.outcome === key}"
        onclick="PhotoReview.setOutcome('${escAttr(key)}')">${esc(label)} <span class="pr-n">${n}</span></button>`;
    const rows = r.filtered || all;
    return `
      <div class="pr-filters">
        <div class="button-group" role="group" aria-label="Show uploads by outcome">
          ${chip('', 'All', all.length)}
          ${Object.keys(OUTCOME).filter(k => counts[k]).map(k => chip(k, OUTCOME[k].word, counts[k])).join('')}
        </div>
        <label class="pr-origin small">Way in
          <select onchange="PhotoReview.setOrigin(this.value)">
            <option value="" ${!f.origin ? 'selected' : ''}>Every way in</option>
            ${Object.entries(ORIGIN).map(([k, w]) => `<option value="${esc(k)}" ${f.origin === k ? 'selected' : ''}>${esc(w)}</option>`).join('')}
          </select></label>
      </div>
      <p class="small txt-muted" id="pr-up-lead">${all.length >= UPLOADS ? `The last ${UPLOADS} attempts` : `${all.length} attempt${all.length === 1 ? '' : 's'}`}, newest first${
        f.outcome || f.origin ? ` — showing ${rows.length} ${f.outcome ? esc(OUTCOME[f.outcome] ? OUTCOME[f.outcome].word.toLowerCase() : f.outcome) : ''}${f.origin ? ` from ${esc(ORIGIN[f.origin] || f.origin)}` : ''}` : ''}.
        The counts are of the last ${UPLOADS}.</p>
      ${r.uploadsError ? `<p class="small txt-bad">${esc(r.uploadsError)}</p>` : ''}
      ${rows.length ? `<div class="table-wrap">
        <table class="pr-table">
          <caption class="sr-only">Recent attempts to bring photos into MegaNet, from every way in, and what became of each</caption>
          <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">File</th><th scope="col">Outcome</th><th scope="col">Station</th></tr></thead>
          <tbody>${rows.map(uploadRowHtml).join('')}</tbody>
        </table>
      </div>` : `<p class="small txt-muted">${all.length ? 'None of those.' : 'Nothing has been logged yet — the next upload, or the next run of a sync, will be.'}</p>`}`;
  }

  function uploadRowHtml(u) {
    const o = OUTCOME[u.outcome] || { word: u.outcome, cls: 'muted' };
    return `<tr>
      <td class="pr-when">${esc(when(u.attempted_at))}</td>
      <td class="small">${esc(u.uploaded_by || '—')}</td>
      <td><span class="pr-file">${esc(u.file_name)}</span>${u.archive_name ? ` <span class="small txt-muted">from ${esc(u.archive_name)}</span>` : ''}${
        u.origin && u.origin !== 'upload' ? ` <span class="fp-chip">${esc(ORIGIN[u.origin] || u.origin)}</span>` : ''}</td>
      <td><span class="fp-chip pr-out-${esc(o.cls)}">${esc(o.word)}</span>${u.reason ? ` <span class="small pr-reason">${esc(u.reason)}</span>` : ''}</td>
      <td>${u.station_id ? esc(stationName(u.station_id)) : '<span class="txt-muted">—</span>'}${
        u.photo_id ? ` <button type="button" class="link-btn" onclick="FieldPhotos.openOne('${escAttr(u.photo_id)}')" aria-label="Show the photo ${escAttr(u.file_name)} became">Show it</button>` : ''}</td>
    </tr>`;
  }

  // ── The equipment suggestions ──────────────────────────────────────────────

  function suggestionsHtml() {
    const r = R();
    if (!r.pending && !r.suggestError) return '<p class="small">Loading…</p>';
    const bits = [];
    if (r.suggestError) {
      bits.push(`<p class="small txt-bad">${missing(r.suggestError)
        ? 'This database has no equipment register yet — apply <code>db/migrations/0036_photo_review.sql</code>.'
        : `The suggestions could not be read — ${esc(r.suggestError)}.`}
        <button type="button" class="link-btn" onclick="PhotoReview.reload()">Try again</button></p>`);
    }
    if (r.lastDecision) bits.push(`<p class="small txt-ok" role="status">${esc(r.lastDecision)}</p>`);
    const pending = r.pending || [];
    if (pending.length) {
      bits.push(`<ul class="pr-sugs" aria-labelledby="pr-eq-h">${pending.map(s => `<li class="pr-sug" id="pr-sug-${esc(s.id)}">${sugHtml(s)}</li>`).join('')}</ul>`);
    } else if (!r.suggestError) {
      bits.push('<p class="small txt-muted">Nothing is waiting for a decision. Read a station\'s photos above, or a photo\'s labels from the viewer, to make suggestions.</p>');
    }
    const decided = r.decided || [];
    if (decided.length) {
      bits.push(`<details class="pr-decided">
        <summary>Decided — the last ${decided.length}</summary>
        <div class="table-wrap">
          <table class="pr-table">
            <caption class="sr-only">Equipment suggestions already decided, newest first</caption>
            <thead><tr><th scope="col">Decided</th><th scope="col">Station</th><th scope="col">Proposed</th><th scope="col">Decision</th></tr></thead>
            <tbody>${decided.map(s => `<tr>
              <td class="pr-when">${esc(when(s.decided_at))}</td>
              <td>${esc(stationName(s.station_id))}</td>
              <td>${esc(kindLabel(s.equipment_key))}: ${esc(unitText(s))} <span class="small txt-muted">(${esc(proposer(s.proposed_by))})</span></td>
              <td><span class="fp-chip pr-dec-${esc(s.status)}">${esc(STATUS[s.status] || s.status)}</span>
                <span class="small">by ${esc(s.decided_by || '—')}${s.decision_patch ? ', corrected' : ''}${s.decision_note ? ` — ${esc(s.decision_note)}` : ''}</span></td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </details>`);
    }
    return bits.join('');
  }

  // What an administrator changed so far, over what was proposed.
  function draftOf(s) {
    const d = R().drafts[s.id] || {};
    return {
      equipment_key: d.equipment_key != null ? d.equipment_key : s.equipment_key,
      make: d.make != null ? d.make : s.make,
      model: d.model != null ? d.model : s.model,
      serial_no: d.serial_no != null ? d.serial_no : s.serial_no,
      replaces: d.replaces || '',
    };
  }

  function sugHtml(s) {
    const r = R();
    const ph = s.photo_id ? r.photos[s.photo_id] : null;
    const d = draftOf(s);
    const live = r.register[s.station_id] || [];
    const sameKind = live.filter(u => u.equipment_key === d.equipment_key);
    const admin = r.admin === true;
    const busy = !!r.busy[s.id];
    const id = escAttr(s.id);
    const conf = s.confidence != null ? ` · ${Math.round(s.confidence * 100)}% sure` : '';
    const field = (key, label) => admin
      ? `<label class="pr-field">${label}<input type="text" value="${esc(d[key] || '')}" autocomplete="off" spellcheck="false"
            oninput="PhotoReview.edit('${id}','${key}',this.value)"></label>`
      : `<div class="pr-field"><span>${label}</span><span class="pr-value">${esc(d[key] || '—')}</span></div>`;
    return `
      <div class="pr-sug-photo">${ph
        ? `<button type="button" class="pr-thumb-btn" onclick="FieldPhotos.openOne('${escAttr(ph.id)}')" aria-label="Open the photo it was read off, ${escAttr(ph.title || '')}">
             <img class="pr-thumb" data-fp-src="${esc(ph.thumb_path || ph.storage_path)}" alt=""></button>`
        : `<span class="pr-thumb pr-thumb-none small txt-muted">${s.photo_id ? 'photo removed' : 'no photo'}</span>`}</div>
      <div class="pr-sug-body">
        <h4 class="pr-sug-h">${esc(kindLabel(s.equipment_key))} at ${esc(stationName(s.station_id))}</h4>
        <p class="small txt-muted">Proposed ${esc(when(s.created_at))} — ${esc(proposer(s.proposed_by))}${
          s.proposed_by === 'ocr' && s.created_by ? ` for ${esc(s.created_by)}` : ''}${esc(conf)}</p>
        ${s.evidence ? `<blockquote class="pr-evidence">${esc(s.evidence)}</blockquote>` : ''}
        <p class="small pr-now">${live.length
          ? `On the register now: ${live.map(u => `<span class="pr-unit">${esc(kindLabel(u.equipment_key))} — ${esc(unitText(u))}</span>`).join(' ')}`
          : 'Nothing is on this station\'s register yet.'}</p>
        <div class="pr-fields">
          ${admin ? `<label class="pr-field">Kind<select onchange="PhotoReview.edit('${id}','equipment_key',this.value)">
              ${(kinds || [{ key: s.equipment_key, label: kindLabel(s.equipment_key) }]).map(k =>
                `<option value="${esc(k.key)}" ${k.key === d.equipment_key ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}
            </select></label>` : `<div class="pr-field"><span>Kind</span><span class="pr-value">${esc(kindLabel(d.equipment_key))}</span></div>`}
          ${field('make', 'Make')}
          ${field('model', 'Model')}
          ${field('serial_no', 'Serial number')}
          ${admin && sameKind.length ? `<label class="pr-field pr-field-wide">What it is
            <select onchange="PhotoReview.edit('${id}','replaces',this.value)">
              <option value="" ${!d.replaces ? 'selected' : ''}>${sameKind.length === 1
                ? `As the register sees it — the same ${esc(kindLabel(d.equipment_key).toLowerCase())} if the serial matches, otherwise its replacement`
                : 'Choose which it replaces, or that it is another one'}</option>
              ${sameKind.map(u => `<option value="${esc(u.id)}" ${d.replaces === u.id ? 'selected' : ''}>Replaces ${esc(unitText(u))} — retired</option>`).join('')}
              <option value="alongside" ${d.replaces === 'alongside' ? 'selected' : ''}>Another one, alongside — nothing retired</option>
            </select></label>` : ''}
          ${admin ? `<label class="pr-field pr-field-wide">Note<input type="text" value="${esc(r.notes[s.id] || '')}" autocomplete="off"
              placeholder="Why — kept with the decision" oninput="PhotoReview.note('${id}',this.value)"></label>` : ''}
        </div>
        <div class="button-group pr-actions">
          <button type="button" class="primary" onclick="PhotoReview.approve('${id}')" ${admin && !busy ? '' : 'disabled'}
                  ${admin ? '' : 'aria-describedby="pr-why"'}>Approve</button>
          <button type="button" onclick="PhotoReview.reject('${id}')" ${admin && !busy ? '' : 'disabled'}
                  ${admin ? '' : 'aria-describedby="pr-why"'}>Reject</button>
        </div>
        <p class="small pr-msg" id="pr-msg-${esc(s.id)}" role="status">${r.msgs[s.id] ? `<span class="${r.msgs[s.id].kind === 'error' ? 'txt-bad' : 'txt-ok'}">${esc(r.msgs[s.id].text)}</span>` : ''}</p>
      </div>`;
  }

  function edit(id, key, value) {
    const r = R();
    const d = r.drafts[id] = r.drafts[id] || {};
    d[key] = String(value == null ? '' : value);
    // Another kind is another set of units it could replace.
    if (key === 'equipment_key') { delete d.replaces; repaintSug(id); }
  }
  function note(id, value) { R().notes[id] = String(value || ''); }

  function approve(id) { return decide(id, 'approve'); }
  function reject(id) { return decide(id, 'reject'); }

  // The corrections are what differs from what was proposed, and nothing
  // else — so an approval nobody touched sends no patch, and the suggestion
  // keeps a record of exactly what the administrator changed.
  async function decide(id, decision) {
    const r = R();
    const s = (r.pending || []).find(x => x.id === id);
    if (!s || r.busy[id]) return;
    const body = { p_id: id, p_decision: decision, p_note: (r.notes[id] || '').trim() || null, p_patch: null };
    if (decision === 'approve') {
      const d = r.drafts[id] || {};
      const patch = {};
      for (const k of ['equipment_key', 'make', 'model', 'serial_no']) {
        if (d[k] != null && d[k].trim() !== String(s[k] || '')) patch[k] = d[k].trim();
      }
      if (d.replaces) patch.replaces = d.replaces === 'alongside' ? null : d.replaces;
      if (Object.keys(patch).length) body.p_patch = patch;
    }
    r.busy[id] = true;
    r.msgs[id] = { text: decision === 'approve' ? 'Approving…' : 'Rejecting…', kind: 'ok' };
    repaintSug(id);
    let done = false;
    try {
      const out = await dbRpc('decide_equipment_suggestion', body);
      done = true;
      delete r.drafts[id]; delete r.notes[id]; delete r.msgs[id];
      forgetCard(s.station_id);
      const unit = out && out.equipment ? unitText(out.equipment) : unitText(s);
      const retired = out && Array.isArray(out.retired) ? out.retired.length : 0;
      r.lastDecision = decision === 'approve'
        ? `Approved: ${unit} is on ${stationName(s.station_id)}'s register${retired ? ', and the unit it replaced is retired' : ''}.`
        : `Rejected: ${unit} at ${stationName(s.station_id)}.`;
      announce(r.lastDecision);
    } catch (err) {
      r.msgs[id] = { text: `Not ${decision === 'approve' ? 'approved' : 'rejected'} — ${errText(err)}`, kind: 'error' };
    } finally {
      r.busy[id] = false;
    }
    if (done) { await loadSuggestions(); repaintSugs(); }
    else repaintSug(id);
  }

  // ── Reading labels ─────────────────────────────────────────────────────────

  function scanHtml() {
    const r = R();
    const sc = r.scan;
    const chosen = r.scanStation ? stationById(r.scanStation) : null;
    const n = r.scanPhotos ? r.scanPhotos.length : null;
    const hits = r.scanFind && typeof FieldPhotos !== 'undefined'
      ? FieldPhotos.stationHits(r.scanFind, sid => `PhotoReview.pickStation('${escAttr(sid)}')`) : '';
    return `
      <div class="pr-scan">
        <p class="small">Read the labels in a station's photos — makes, models and serial numbers — and suggest what
          they say for its register. The whole picture and its quarters are read, a few seconds a photo, one photo at
          a time; nothing is written to the register until an administrator approves it.</p>
        <label class="fp-place-field">Station to read
          <input type="search" id="pr-scan-find" value="${esc(r.scanFind)}" placeholder="name or station number" autocomplete="off"
                 oninput="PhotoReview.scanFind(this.value)"></label>
        <div id="pr-scan-hits">${hits}</div>
        ${chosen ? `<div class="button-group pr-scan-go">
          <button type="button" class="primary" onclick="PhotoReview.scanStation()" ${sc && sc.running || !n ? 'disabled' : ''}>🔎 ${
            n == null ? `Counting the photos at ${esc(chosen.name)}…` : n ? `Scan ${n === SCAN_MAX ? `the newest ${n}` : n} photo${n === 1 ? '' : 's'} at ${esc(chosen.name)}` : `No photos at ${esc(chosen.name)}`}</button>
          ${sc && sc.running ? '<button type="button" onclick="PhotoReview.stop()">Stop after this photo</button>' : ''}
        </div>` : ''}
        ${r.scanError ? `<p class="small txt-bad">${esc(r.scanError)}</p>` : ''}
        <p class="small" id="pr-scan-msg" role="status">${esc(sc && sc.running ? progressText(sc) : r.scanResult ? r.scanResult.text : '')}</p>
      </div>`;
  }

  function scanFind(text) {
    const r = R();
    r.scanFind = String(text || '');
    const el = document.getElementById('pr-scan-hits');
    if (el) el.innerHTML = r.scanFind && typeof FieldPhotos !== 'undefined'
      ? FieldPhotos.stationHits(r.scanFind, sid => `PhotoReview.pickStation('${escAttr(sid)}')`) : '';
  }

  async function pickStation(id) {
    const r = R();
    const st = stationById(id);
    if (!st) return;
    r.scanStation = id;
    r.scanFind = st.name;
    r.scanPhotos = null;
    r.scanError = null;
    repaintScan();
    try {
      r.scanPhotos = await dbSelect(`field_photo?select=id,storage_path,thumb_path,title,station_id&station_id=eq.${encodeURIComponent(id)}`
        + `&order=taken_at.desc.nullslast,created_at.desc&limit=${SCAN_MAX}`);
    } catch (err) {
      r.scanPhotos = [];
      r.scanError = `The photos at ${st.name} could not be listed — ${errText(err)}.`;
    }
    if (r.scanStation === id) repaintScan();
  }

  function scanStation() {
    const r = R();
    const st = stationById(r.scanStation);
    const photos = r.scanPhotos || [];
    if (!st || !photos.length) return null;
    return scan(photos.map(p => ({ id: p.id, station_id: p.station_id, title: p.title, storage_path: p.storage_path })),
                { what: `${photos.length} photo${photos.length === 1 ? '' : 's'} at ${st.name}` });
  }

  function stop() {
    const sc = R().scan;
    if (sc && sc.running) { sc.stop = true; paintScanMsg(`${progressText(sc)} Stopping after this photo…`); }
  }

  function progressText(sc) {
    return `Reading labels — photo ${sc.i} of ${sc.total}${sc.title ? ` (${sc.title})` : ''}${
      sc.passes ? `, pass ${sc.pass} of ${sc.passes}` : ''}…`;
  }
  function paintScanMsg(text) {
    const el = document.getElementById('pr-scan-msg');
    if (el) el.textContent = text;
  }

  async function fetchPhoto(job) {
    const [url] = await FieldPhotos.sign([job.storage_path]);
    if (!url) throw new Error('its link could not be signed');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`it could not be fetched (HTTP ${res.status})`);
    return res.blob();
  }

  // A candidate, proposed as the OCR's reading of this photo. The photo's own
  // station is the database's to fill in, so a photo moved since the scan
  // started proposes for where it is filed now.
  async function propose(job, c) {
    const p = { photo_id: job.id, equipment_key: c.equipment_key, make: c.make, model: c.model, serial_no: c.serial_no,
                evidence: c.evidence, confidence: c.confidence, proposed_by: 'ocr' };
    try {
      await dbRpc('propose_equipment', { p });
      return 'made';
    } catch (err) {
      if (err && (err.status === 409 || err.code === '23505')) return 'known';
      return errText(err);
    }
  }

  // jobs: [{ id, station_id, title, storage_path } | { id, station_id, title, blob: () => Promise<Blob> }]
  // opts: { what, onProgress(text), onDone(result) } → { text, kind, made, known, empty, failed }
  async function scan(jobs, opts = {}) {
    const r = R();
    if (r.scan && r.scan.running) {
      return { text: 'Labels are already being read — wait for that to finish, or stop it on the Review panel.', kind: 'error' };
    }
    if (typeof PhotoMeta === 'undefined' || typeof PhotoEquipment === 'undefined' || !PhotoMeta.ocrLabels) {
      return { text: 'The label reader is not loaded on this page.', kind: 'error' };
    }
    const sc = r.scan = { running: true, stop: false, total: jobs.length, i: 0, title: '', pass: 0, passes: 0,
                          made: 0, known: 0, empty: 0, failed: 0, proposeFailed: 0, last: '' };
    r.scanResult = null;
    repaintScan();
    const progress = () => {
      const t = progressText(sc);
      paintScanMsg(t);
      if (opts.onProgress) { try { opts.onProgress(t); } catch (_) { /* its own problem */ } }
    };
    for (const job of jobs) {
      if (sc.stop) break;
      sc.i++; sc.title = job.title || ''; sc.pass = 0; sc.passes = 0;
      progress();
      let bmp = null;
      try {
        const blob = job.blob ? await job.blob() : await fetchPhoto(job);
        try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
        catch (_) { bmp = await createImageBitmap(blob); }
        const got = await PhotoMeta.ocrLabels(bmp, bmp.width, bmp.height, {
          onPass: (n, total) => { sc.pass = n; sc.passes = total; progress(); },
        });
        const found = PhotoEquipment.parse(got.texts);
        if (!found.length) sc.empty++;
        for (const c of found) {
          const res = await propose(job, c);
          if (res === 'made') sc.made++;
          else if (res === 'known') sc.known++;
          else { sc.proposeFailed++; sc.last = res; }
        }
      } catch (err) {
        sc.failed++;
        sc.last = `${job.title || 'a photo'}: ${errText(err)}`;
      } finally {
        if (bmp) { try { bmp.close(); } catch (_) { /* already gone */ } }
      }
    }
    sc.running = false;
    const read = sc.i - sc.failed;
    const bits = [`${sc.made} suggestion${sc.made === 1 ? '' : 's'} made`];
    if (sc.known) bits.push(`${sc.known} already known — waiting, on the register, or turned down before`);
    if (sc.empty) bits.push(`nothing readable on ${sc.empty}`);
    if (sc.failed) bits.push(`${sc.failed} could not be read (${sc.last})`);
    else if (sc.proposeFailed) bits.push(`${sc.proposeFailed} could not be proposed (${sc.last})`);
    const what = opts.what || `${jobs.length} photo${jobs.length === 1 ? '' : 's'}`;
    const out = {
      text: `${sc.stop ? 'Stopped. ' : ''}Read the labels on ${read === jobs.length ? what : `${read} of ${what}`}: ${bits.join('; ')}.`,
      kind: sc.failed || sc.proposeFailed ? 'error' : 'ok',
      made: sc.made, known: sc.known, empty: sc.empty, failed: sc.failed + sc.proposeFailed,
    };
    r.scanResult = out;
    repaintScan();
    announce(out.text);
    if (sc.made) { await loadSuggestions(); repaintSugs(); }
    if (opts.onDone) { try { opts.onDone(out); } catch (_) { /* its own problem */ } }
    return out;
  }

  // ── The station card's Equipment section ───────────────────────────────────
  // What is fitted at a station, as its register says, for a signed-in editor:
  // live units only, a row each. Drawn empty and filled when the rows arrive —
  // SLS.ask's terms (app.js's repaintStnCard) — and an empty section is not
  // drawn at all (:empty). A minute's cache per station, forgotten when a
  // decision is made about it.

  function cardHtml(s) {
    if (!s || !signedIn()) return '';
    const c = cards[s.id];
    return `<div class="acma-sect stn-card-equip" id="mn-equip-card-${esc(s.id)}" data-mn-equip="${esc(s.id)}">${c && c.rows ? equipHtml(c.rows) : ''}</div>`;
  }

  function equipHtml(rows) {
    if (!rows || !rows.length) return '';
    const SOURCE = { photo: 'read off a field photo', inspection: 'from an inspection', manual: 'entered by a person', agent: 'proposed by an agent' };
    return `<span class="small txt-muted stn-card-equip-h">Equipment — the station's register</span>${rows.map(u =>
      `<div class="acma-row" title="${esc(`${SOURCE[u.source] || u.source}, approved ${String(u.updated_at || u.created_at || '').slice(0, 10)}`)}"><span>${esc(kindLabel(u.equipment_key))}</span><span>${esc(unitText(u))}</span></div>`).join('')}`;
  }

  function cardAsk(s) {
    if (!s || !signedIn()) return;
    const id = s.id;
    const c = cards[id];
    if (c && (c.p || Date.now() - c.at < CARD_FRESH)) return;
    const entry = cards[id] = { at: Date.now(), rows: c ? c.rows : null, p: null };
    const fill = () => {
      const el = document.getElementById(`mn-equip-card-${id}`);
      if (el && el.dataset.mnEquip === id) el.innerHTML = equipHtml(entry.rows);
    };
    entry.p = Promise.all([
      loadKinds(),
      dbSelect(`station_equipment?select=equipment_key,make,model,serial_no,source,created_at,updated_at`
        + `&station_id=eq.${encodeURIComponent(id)}&retired_at=is.null&order=equipment_key,created_at`),
    ])
      .then(([, rows]) => { entry.rows = rows; }, () => { entry.rows = entry.rows || []; })
      .finally(() => { entry.p = null; entry.at = Date.now(); fill(); });
  }
  function forgetCard(stationId) { delete cards[stationId]; }

  // ── Repainting ─────────────────────────────────────────────────────────────
  // One part at a time: an administrator half way through correcting a serial
  // must not lose it to an upload finishing in the list above.

  function part(id, fn) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = fn();
    return el;
  }
  function repaint() {
    const el = document.getElementById('fp-review');
    if (!el) return;
    if (!signedIn() || !document.getElementById('pr-sugs')) { el.innerHTML = html(); paintPhotos(); return; }
    part('pr-intro', introHtml);
    part('pr-queue', queueHtml);
    part('pr-uploads', uploadsHtml);
    repaintScan();
    repaintSugs();
  }
  function repaintScan() { part('pr-scan', scanHtml); }
  function repaintSugs() {
    part('pr-sugs', suggestionsHtml);
    const h = document.getElementById('pr-eq-h');
    const n = (R().pending || []).length;
    if (h) h.innerHTML = `Equipment suggestions${n ? ` <span class="pr-count">${n} waiting</span>` : ''}`;
    paintPhotos();
  }
  function repaintSug(id) {
    const s = (R().pending || []).find(x => x.id === id);
    const el = document.getElementById(`pr-sug-${id}`);
    if (!s || !el) { repaintSugs(); return; }
    el.innerHTML = sugHtml(s);
    paintPhotos(el);
  }
  function paintPhotos(root) {
    const el = root || document.getElementById('pr-sugs');
    if (el && typeof FieldPhotos !== 'undefined' && FieldPhotos.paintThumbs) FieldPhotos.paintThumbs(el);
  }

  // The queue changes a row at a time, often; this list follows it a few
  // times a second at most.
  function queueChanged() {
    if (queueTimer) return;
    queueTimer = setTimeout(() => { queueTimer = 0; part('pr-queue', queueHtml); }, 250);
  }
  // An upload finished and its outcomes were logged: the list, again.
  function uploadsChanged() {
    if (!signedIn()) return;
    part('pr-intro', introHtml);
    loadUploads().then(() => part('pr-uploads', uploadsHtml));
  }

  function setOutcome(key) {
    const r = R();
    r.filter.outcome = r.filter.outcome === key ? '' : key;
    loadFiltered().then(() => part('pr-uploads', uploadsHtml));
  }
  function setOrigin(key) {
    R().filter.origin = key || '';
    loadFiltered().then(() => part('pr-uploads', uploadsHtml));
  }
  function reload() { load(true); }

  function init() {
    if (!signedIn()) return;
    const r = R();
    // The library's station, if it is showing one, is the station to read.
    const f = state.photos.filter;
    if (!r.scanStation && f && f.show === 'station' && f.station) pickStation(f.station);
    // Every visit asks again — five small reads — because what the syncs and
    // other people did since is the point of the panel.
    load(r.loaded);
  }
  function authChanged() {
    state.photos.review = null;
    cards = {};
  }

  return {
    html, init, repaint, reload, authChanged, queueChanged, uploadsChanged,
    setOutcome, setOrigin, edit, note, approve, reject,
    scan, scanFind, pickStation, scanStation, stop,
    cardHtml, cardAsk,
    // Read by the check and by nothing else.
    _state: () => {
      const r = R();
      return { admin: r.admin, loaded: r.loaded, uploads: (r.uploads || []).length, filtered: r.filtered ? r.filtered.length : null,
               pending: (r.pending || []).map(s => s.id), decided: (r.decided || []).map(s => s.id),
               scan: r.scan ? { running: r.scan.running, i: r.scan.i, total: r.scan.total } : null,
               scanResult: r.scanResult, drafts: JSON.parse(JSON.stringify(r.drafts)) };
    },
  };
})();
if (typeof window !== 'undefined') window.PhotoReview = PhotoReview;
