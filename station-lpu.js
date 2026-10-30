// MegaNet — station-lpu.js
//
//   StationLpu   a station's logger (LPU, 0089): what type it is, its serial
//                number, and the versions that matter for that kind of unit —
//                an ELPRO ERT-A2's firmware, bootloader and radio firmware, a
//                Campbell logger's OS and program. On the station card for an
//                approved account, read only; in the station editor's
//                Telemetry section for an editor, saved with the station.
//
// After core.js and lpu-types.js (LpuTypes, which decides what a typed type
// is) — index.html holds the order and the reasons. Reaches back to core.js
// for esc, escAttr, termHtml, announce and switchTab's tab names; to
// datastore.js for dbSelect, dbRpc and dbCanWrite; to auth.js for
// Auth.isMember; to station-editor.js for editorUnsavedRefresh, which repaints
// the unsaved bar when a value is put in a box from here; to field-photos.js
// for FieldPhotos.openOne, the photo a value came off; to a2-firmware.js for
// A2Firmware.parse and advise — whether an ERT-A2's versions are Release G's;
// and to app.js for switchTab and repaintStnCard. All of it from inside its
// own functions: the IIFE body only declares (`npm run toplevel`).
// station-editor.js calls editorHtml(), formProblem() and save() from its form
// and its save; app.js calls cardHtml() and cardAsk() from the station card.
//
// ── Where the values come from ────────────────────────────────────────────────
// A person, through the station editor's Save (save_station_lpu()), or the
// photo reader, which reads the field photos every night and fills in what
// nobody has recorded (record_photo_reading(), docs/photo-reader.md). A value
// the reader filled carries a 📷 chip until somebody ticks Right or types
// another — the photo it came off a press away — and a photo that shows
// something different from the record is said under the box, with Use it.
// The record is never changed by a photo over a person's value: 0089 says why.
//
// ── A type that is not on the list ────────────────────────────────────────────
// The LPU type box offers the list as you type. A type it does not know is
// held against the list (LpuTypes.resolve) when the box is left: a slip — a
// lookalike, a swap, a letter — is asked about as "Did you mean"; a digit or a
// letter on the end is shown with the models it could be and a word that a
// digit can be a different unit; and only then may the editor add it as new —
// with its make, model and the fields it has — which the save sends as
// new_lpu_type with confirm_new, the one way the list grows.

const StationLpu = (function () {

  const FRESH = 60000;          // a station's record, asked again after a minute
  const READINGS = 100;         // the reader's readings of one station, at most
  const CHANGES = 12;           // …and the changes in its history fold

  const FIELDS = ['serial_no', 'firmware_version', 'bootloader_version', 'radio_firmware_version',
                  'os_version', 'program', 'note'];
  const LABEL = {
    lpu_type_key: 'LPU type', serial_no: 'Serial number', firmware_version: 'Firmware',
    bootloader_version: 'Bootloader', radio_firmware_version: 'Radio firmware', os_version: 'OS version',
    program: 'Program', note: 'Logger note',
  };
  const FAMILY = {
    ert_a2:   'an ERT-A2’s fields: firmware, bootloader and radio firmware',
    campbell: 'a Campbell logger’s fields: OS version and program',
    other:    'firmware and program',
  };

  // The words this section uses, and what each means here — one list, for the
  // hover and for the fold that says them without one.
  const WORDS = {
    lpu: 'The logger at the site, the LPU: the box that reads the sensors and sends their readings — an ELPRO ERT-A2 at an ALERT site, a Campbell Scientific datalogger at most of the others.',
    lpu_type_key: 'Which logger it is, from the list Flood-Net keeps — so the same model is always written the same way. A type not on the list can be added, once you have checked it is not one already there.',
    serial_no: 'The logger’s own serial number, off its label. A radio’s, a modem’s or a regulator’s goes on the Equipment register instead.',
    firmware_version: 'The ERT-A2’s host firmware: the “Firmware:” line of its version screen, such as v1.7 Sep 20 2024 : 10366, the number after the colon being the build. For another kind of logger, the firmware it reports.',
    bootloader_version: 'What starts the ERT-A2 and loads its firmware: the “Host Bootloader:” line of its version screen, such as v1.3 - 9967.',
    radio_firmware_version: 'The firmware in the ERT-A2’s radio: the “Radio Firmware:” line of its version screen, with the radio’s function image number (FI:) when it shows one.',
    os_version: 'The Campbell logger’s operating system, as the logger reports it in its Status table (OSVersion), such as CR300.Std.10.03.',
    program: 'The program the logger runs — for a Campbell logger usually a Bureau program, its version in its name — as the logger’s Status table shows it.',
    note: 'Anything else about the logger worth knowing before a visit.',
    photo: 'Read off a field photo by the photo reader, which reads each new photo every night. Nobody has checked it yet: tick Right if it is, or type the right value.',
    checked: 'Read off a field photo, and a person has since said it is right.',
    differs: 'A field photo shows something different from what is recorded. The record stands until a person changes it: the photo may be older, or misread.',
    releaseg: 'ELPRO’s current firmware pack for the ERT-A2 (Release G) — the 💾 A2 Firmware tab walks through bringing a unit up to it.',
  };
  const GLOSSARY = [['lpu', 'LPU'], ['lpu_type_key', 'LPU type'], ['serial_no', 'Serial number'],
    ['firmware_version', 'Firmware'], ['bootloader_version', 'Bootloader'], ['radio_firmware_version', 'Radio firmware'],
    ['os_version', 'OS version'], ['program', 'Program'], ['photo', '📷 From a photo'], ['checked', '📷 Checked'],
    ['differs', 'A photo shows something else'], ['releaseg', 'Release G']];

  let types = null, typesP = null, typesMissing = false;
  let recs = {};                 // station id → { at, row, readings, changes, p, error, missing }
  let drafts = {};               // station id → what a save that failed left in the boxes
  let asked = {};                // station id → the type box's open question, if any

  // ── Small things ───────────────────────────────────────────────────────────

  function member() { return typeof Auth !== 'undefined' && Auth.isMember(); }
  function editor() { return typeof dbCanWrite === 'function' && dbCanWrite() && typeof Auth !== 'undefined' && Auth.mayWrite(); }
  function errText(err) { return (err && err.message) || String(err); }
  function missing(text) { return /(station_lpu|lpu_type|photo_reading|save_station_lpu)/.test(text || '') && /(does not exist|schema cache|not find|404)/i.test(text || ''); }
  function day(iso) {
    const t = Date.parse(iso);
    return isFinite(t) ? new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  }
  function typeOf(key) { return (types || []).find(t => t.key === key) || null; }
  function typeLabel(key) { const t = typeOf(key); return t ? t.label : (key || ''); }
  function word(k) { return WORDS[k] || ''; }
  function cap(field) { return termHtml(LABEL[field], word(field)); }
  function boxId(field) { return `ef-lpu-${field}`; }
  function who(by) { return /^agent:/.test(by || '') ? 'the photo reader' : (by || 'somebody'); }

  function loadTypes() {
    if (types) return Promise.resolve(types);
    if (!typesP) {
      typesP = dbSelect('lpu_type?select=key,label,make,model,family,ord,note&order=ord,label')
        .then(rows => { types = rows; typesMissing = false; return types; },
              err => { typesMissing = missing(errText(err)); return []; })
        .finally(() => { typesP = null; });
    }
    return typesP;
  }

  // A station's record, its readings and its history — the last two only for
  // an editor, whose they are (0089). Kept a minute; `force` asks again.
  function ask(id, { force = false } = {}) {
    if (!id || !member()) return Promise.resolve(null);
    const r = recs[id];
    if (!force && r && (r.p || Date.now() - r.at < FRESH)) return r.p || Promise.resolve(r);
    const e = recs[id] = { at: Date.now(), row: r ? r.row : undefined, readings: r ? r.readings : [], changes: r ? r.changes : [],
                           p: null, error: null, missing: false };
    const ed = editor();
    const sid = encodeURIComponent(id);
    e.p = Promise.all([
      loadTypes(),
      dbSelect(`station_lpu?station_id=eq.${sid}&select=*`),
      ed ? dbSelect(`photo_reading?station_id=eq.${sid}&select=photo_id,read_at,outcome,summary,applied&order=read_at.desc&limit=${READINGS}`) : [],
      ed ? dbSelect(`station_lpu_change?station_id=eq.${sid}&select=changed_at,changed_by,source,photo_id,before,after&order=changed_at.desc,id.desc&limit=${CHANGES}`) : [],
    ]).then(([, rows, readings, changes]) => {
      e.row = rows[0] || null; e.readings = readings || []; e.changes = changes || [];
    }, err => {
      e.error = errText(err); e.missing = missing(e.error);
      if (e.row === undefined) e.row = null;
    }).finally(() => { e.p = null; e.at = Date.now(); paint(id); });
    return e.p.then(() => e);
  }

  // Both places a station's logger is drawn, repainted when its record lands:
  // the card always (it holds nothing typed), the editor only while it is
  // still waiting for it — never over boxes somebody may be typing in.
  function paint(id) {
    const card = document.getElementById(`mn-lpu-card-${id}`);
    if (card && card.dataset.mnLpu === id) card.innerHTML = cardInner(id);
    const ed = document.getElementById('ef-lpu');
    if (ed && ed.dataset.efLpu === id && ed.dataset.efLpuWaiting === '1') {
      ed.outerHTML = editorHtml({ id });
      applyDrafts();
      if (typeof editorUnsavedRefresh === 'function') editorUnsavedRefresh();
    }
  }

  // ── Provenance ─────────────────────────────────────────────────────────────

  function prov(row, field) { return (row && row.provenance && row.provenance[field]) || null; }
  function fromPhoto(p) { return !!p && p.from === 'photo'; }
  function unchecked(p) { return fromPhoto(p) && !p.checked_at; }

  function provTitle(p) {
    if (!fromPhoto(p)) return '';
    const bits = [word(p.checked_at ? 'checked' : 'photo')];
    if (p.taken_at) bits.push(`The photo was taken ${day(p.taken_at)}.`);
    if (p.confidence != null) bits.push(`The reader was ${Math.round(Number(p.confidence) * 100)}% sure.`);
    if (p.checked_at) bits.push(`Checked by ${p.checked_by || 'somebody'} on ${day(p.checked_at)}.`);
    return bits.join(' ');
  }
  function chipHtml(p) {
    if (!fromPhoto(p)) return '';
    const open = p.photo_id && typeof FieldPhotos !== 'undefined'
      ? ` <button type="button" class="link-btn small" onclick="FieldPhotos.openOne('${escAttr(p.photo_id)}')">See the photo</button>` : '';
    return `<span class="term-chip lpu-chip${p.checked_at ? ' is-checked' : ''}" title="${escAttr(provTitle(p))}">📷 ${p.checked_at ? 'Checked' : 'From a photo'}</span>${open}`;
  }

  // What the readings say differently from the record now, newest first and
  // one a field — a disagreement the record has since caught up with is not one.
  function differences(rec) {
    const out = {};
    const row = rec && rec.row;
    for (const r of (rec && rec.readings) || []) {
      const d = r.applied && r.applied.lpu && r.applied.lpu.differed;
      if (!Array.isArray(d)) continue;
      for (const x of d) {
        if (!x || !x.field || out[x.field]) continue;
        const now = row ? (x.field === 'lpu_type_key' ? (row.lpu_type_key || '') : (row[x.field] || '')) : '';
        if (now !== x.recorded || now === x.read) continue;
        out[x.field] = { read: x.read, taken_at: x.taken_at, photo_id: r.photo_id };
      }
    }
    return out;
  }

  // ── The station card ───────────────────────────────────────────────────────
  // Filled after the fetch, the way the Equipment section under it is
  // (photo-review.js), and not drawn at all when nothing is recorded (:empty).

  function cardHtml(s) {
    if (!s || !member()) return '';
    return `<div class="acma-sect stn-card-lpu" id="mn-lpu-card-${escAttr(s.id)}" data-mn-lpu="${escAttr(s.id)}">${cardInner(s.id)}</div>`;
  }
  function cardAsk(s) { if (s) ask(s.id); }

  function cardInner(id) {
    const rec = recs[id];
    const row = rec && rec.row;
    if (!row) return '';
    const type = typeOf(row.lpu_type_key);
    const fields = ['serial_no', ...LpuTypes.fieldsFor(type || { family: 'other' })];
    for (const f of LpuTypes.VERSION_FIELDS) if (row[f] && !fields.includes(f)) fields.push(f);
    const rows = [];
    if (row.lpu_type_key) rows.push(['lpu_type_key', typeLabel(row.lpu_type_key)]);
    for (const f of fields) if (row[f]) rows.push([f, row[f]]);
    if (row.note) rows.push(['note', row.note]);
    if (!rows.length) return '';
    return `<span class="small txt-muted stn-card-equip-h">Logger — the station’s ${termHtml('LPU', word('lpu'))}</span>${rows.map(([f, v]) =>
      `<div class="acma-row"><span>${esc(LABEL[f])}</span><span>${esc(v)} ${chipHtml(prov(row, f))}</span></div>`).join('')}${a2Html(row, type, true)}`;
  }

  // ── An ERT-A2's versions against Release G ─────────────────────────────────
  // The 💾 A2 Firmware tab's own reading of a version screen (A2Firmware.parse
  // and advise), handed the three lines as the unit prints them — so the
  // station and the tab can never disagree about what is current.

  function a2Html(row, type, short) {
    if (!row || !type || type.family !== 'ert_a2' || typeof A2Firmware === 'undefined') return '';
    const lines = [row.firmware_version && `Firmware: ${row.firmware_version}`,
                   row.bootloader_version && `Host Bootloader: ${row.bootloader_version}`,
                   row.radio_firmware_version && `Radio Firmware: ${row.radio_firmware_version}`].filter(Boolean);
    if (!lines.length) return '';
    let adv;
    try { adv = A2Firmware.advise(A2Firmware.parse(lines.join('\n'))); } catch (_) { return ''; }
    if (!adv || adv.empty) return '';
    const parts = [['host', 'Firmware'], ['boot', 'Bootloader'], ['radio', 'Radio'], ['fi', 'Function image']]
      .filter(([k]) => adv[k] && adv[k].state !== 'unknown');
    if (!parts.length) return '';
    const behind = parts.filter(([k]) => adv[k].state === 'update' || adv[k].state === 'stop');
    const head = behind.length
      ? `${behind.map(([, n]) => n).join(', ')} behind ${termHtml('Release G', word('releaseg'))}`
      : `Up to date for ${termHtml('Release G', word('releaseg'))}`;
    const go = `<button type="button" class="link-btn" onclick="switchTab('a2firmware')">💾 A2 Firmware</button>`;
    if (short) return `<div class="small lpu-a2${behind.length ? ' is-behind' : ''}">${head} — ${go}</div>`;
    return `<div class="full small lpu-a2${behind.length ? ' is-behind' : ''}"><strong>${head}</strong> (${go}):
      ${parts.map(([k, n]) => `${esc(n)} — ${esc(adv[k].words)}`).join(' ')}</div>`;
  }

  // ── The editor's section ───────────────────────────────────────────────────
  // In the Telemetry section, under the telemetry pick-list. Its boxes are the
  // form's like any other — the unsaved bar counts them, and Save saves them
  // after the station (editorSave → save()) — except the type box's question,
  // whose own controls are not edits to anything (data-ef-ignore).

  function editorHtml(s) {
    const id = (s && s.id) || '';
    const head = `<div class="ef-section-head"><div class="ef-sub">Logger (${termHtml('LPU', word('lpu'))})
      ${typeof hintToggleHtml === 'function' ? hintToggleHtml('ef-h-lpu', 'the logger') : ''}</div></div>
      <div class="small ef-note hint-fold" id="ef-h-lpu" hidden>
        Which logger is at the site, its serial number and what it runs — an ERT-A2's firmware, bootloader and
        radio firmware, a Campbell logger's OS and program. The photo reader fills in what it can read off the
        field photos each night, marked 📷 until somebody says it is right; nothing it reads is written over
        what a person entered. Saved with the station.
        ${glossaryHtml()}
      </div>`;
    const wrap = (inner, waiting) => `<div class="full ef-section ef-lpu" id="ef-lpu" data-ef-lpu="${escAttr(id)}"${waiting ? ' data-ef-lpu-waiting="1"' : ''}>${head}${inner}</div>`;

    if (!member()) {
      return wrap(`<p class="small ef-note">The logger's type, serial number and versions are for approved accounts —
        sign in to see them.</p>`, false);
    }
    const rec = id ? recs[id] : { row: null, readings: [], changes: [] };
    if (id && (!rec || rec.row === undefined)) {
      ask(id);
      return wrap('<p class="small ef-note">Reading the logger’s details…</p>', true);
    }
    if (!types && !typesMissing) {
      loadTypes().then(() => paint(id));
      return wrap('<p class="small ef-note">Reading the list of logger types…</p>', true);
    }
    if (typesMissing || (rec && rec.missing)) {
      return wrap(`<p class="small ef-note">The database does not keep logger details yet — they arrive with
        db/migrations/0089_station_lpu.sql.</p>`, false);
    }
    if (rec && rec.error) {
      return wrap(`<p class="small ef-note">The logger's details could not be read: ${esc(rec.error)}.
        <button type="button" class="link-btn" onclick="StationLpu.reload('${escAttr(id)}')">Try again</button></p>`, false);
    }
    return wrap(formHtml(id, rec || {}), false);
  }

  function formHtml(id, rec) {
    const row = rec.row || null;
    const draft = drafts[id] || null;
    const may = editor();
    const dis = may ? '' : ' disabled';
    const typeText = draft && draft.typeText != null ? draft.typeText : (row && row.lpu_type_key ? typeLabel(row.lpu_type_key) : '');
    const typeDefault = row && row.lpu_type_key ? typeLabel(row.lpu_type_key) : '';
    const newType = draft && draft.newType ? draft.newType : null;
    const type = newType ? { family: newType.family } : LpuTypes.resolve(typeText, types).exact || (row && typeOf(row.lpu_type_key));
    const diff = differences(rec);
    const shown = showing(row, type);

    // Every field is drawn, and those the type does not have are hidden — so a
    // change of type shows and hides boxes rather than drawing new ones, and
    // never takes the focus or a typed value with it (refit).
    const field = f => {
      const was = row ? (row[f] || '') : '';
      const now = draft && draft.values && draft.values[f] != null ? draft.values[f] : was;
      const p = prov(row, f);
      const d = diff[f];
      return `<div class="ef-field${f === 'note' ? ' full' : ''}" data-lpu-wrap="${f}"${shown.includes(f) ? '' : ' hidden'}>
          <span class="ef-cap"><label for="${boxId(f)}">${cap(f)}</label></span>
          <input type="text" id="${boxId(f)}" value="${escAttr(was)}"${now !== was ? ` data-lpu-draft="${escAttr(now)}"` : ''}
                 data-lpu-field="${f}" autocomplete="off" spellcheck="false" placeholder="not recorded"${dis}>
          ${provHtml(f, p, may && now === was, draft)}
          ${d && may ? differsHtml(d, `<button type="button" class="link-btn" onclick="StationLpu.useRead('${escAttr(f)}', this)"
             data-read="${escAttr(d.read)}">Use it</button>`, `“${esc(d.read)}”`) : ''}
        </div>`;
    };

    const tdiff = diff.lpu_type_key;
    const typeProv = prov(row, 'lpu_type_key');
    return `<div class="form-grid ef-grid ef-lpu-grid">
        <div class="ef-field">
          <span class="ef-cap"><label for="ef-lpu-type">${cap('lpu_type_key')}</label></span>
          <input type="text" id="ef-lpu-type" list="ef-lpu-types" value="${escAttr(typeDefault)}" autocomplete="off" spellcheck="false"
                 placeholder="not recorded — e.g. ERT-A2, CR300"${newType ? ` data-new-type="${escAttr(JSON.stringify(newType))}"` : ''}
                 ${typeText !== typeDefault ? ` data-lpu-draft="${escAttr(typeText)}"` : ''}
                 onchange="StationLpu.typed(this)"${dis}>
          ${provHtml('lpu_type_key', typeProv, may && typeText === typeDefault, draft)}
          ${tdiff && may ? differsHtml(tdiff, `<button type="button" class="link-btn" onclick="StationLpu.pick('${escAttr(tdiff.read)}')">Use it</button>`,
                                       esc(typeLabel(tdiff.read))) : ''}
          <datalist id="ef-lpu-types">${(types || []).map(t => `<option value="${escAttr(t.label)}">`).join('')}</datalist>
        </div>
        ${FIELDS.map(field).join('')}
        <div class="full ef-lpu-ask" id="ef-lpu-ask" data-ef-ignore role="status" aria-live="polite"></div>
        ${a2Html(row, type, false)}
        ${readerHtml(rec)}
        ${historyHtml(rec)}
      </div>`;
  }

  // The fields shown for a type: the serial, the version fields its family
  // has, the note — and a version recorded under an earlier type, still
  // shown rather than lost.
  function showing(row, type) {
    const out = ['serial_no', ...LpuTypes.fieldsFor(type || { family: 'other' }), 'note'];
    for (const f of LpuTypes.VERSION_FIELDS) if (row && row[f] && !out.includes(f)) out.push(f);
    return out;
  }

  // A value's 📷 chip, and — while a photo's value nobody has checked is still
  // the one in the box — its Right box. A Right ticked before a redraw is
  // ticked again after it (applyDrafts), not drawn checked: drawn checked, it
  // would be the record, and the unsaved bar would not count it.
  function provHtml(f, p, offer, draft) {
    const ticked = !!(draft && draft.checked && draft.checked.includes(f));
    const check = offer && unchecked(p)
      ? `<label class="check-label small lpu-right"><input type="checkbox" id="ef-lpu-check-${f}"${ticked ? ' data-lpu-draft-checked="1"' : ''}>
          Right<span class="sr-only"> — the ${esc(LABEL[f].toLowerCase())} the photo showed</span></label>` : '';
    return p || check ? `<span class="lpu-prov">${chipHtml(p)} ${check}</span>` : '';
  }

  function differsHtml(d, use, shown) {
    return `<div class="small lpu-differs">${termHtml('A photo', word('differs'))}${d.taken_at ? ` taken ${esc(day(d.taken_at))}` : ''}
      shows ${shown}. ${use}${typeof FieldPhotos !== 'undefined' && d.photo_id
        ? ` · <button type="button" class="link-btn" onclick="FieldPhotos.openOne('${escAttr(d.photo_id)}')">See the photo</button>` : ''}</div>`;
  }

  // What the photo reader has done here — an editor's line, since the
  // readings are editors' (0089).
  function readerHtml(rec) {
    const rs = (rec && rec.readings) || [];
    if (!editor() || !rs.length) return '';
    const found = rs.filter(r => r.outcome === 'found').length;
    return `<p class="full small ef-note lpu-reader">The photo reader has read ${rs.length}${rs.length >= READINGS ? '+' : ''}
      of this station's photos — the last on ${esc(day(rs[0].read_at))} — and found something to read in ${found}.</p>`;
  }

  function historyHtml(rec) {
    const cs = (rec && rec.changes) || [];
    if (!editor() || !cs.length) return '';
    const show = (f, v) => (v == null || v === '' ? 'nothing' : `“${f === 'lpu_type_key' ? typeLabel(v) : v}”`);
    return `<details class="full small lpu-history" data-ef-ignore><summary>History — the last ${cs.length} change${cs.length === 1 ? '' : 's'}</summary>
      <ul>${cs.map(c => `<li><strong>${esc(day(c.changed_at))}</strong> — ${esc(c.source === 'photo' ? 'the photo reader, from a photo' : who(c.changed_by))}:
        ${Object.keys(c.after || {}).map(f => `${esc(LABEL[f] || f)} ${esc(show(f, (c.before || {})[f]))} → ${esc(show(f, c.after[f]))}`).join('; ')}
        ${c.photo_id && typeof FieldPhotos !== 'undefined' ? ` <button type="button" class="link-btn" onclick="FieldPhotos.openOne('${escAttr(c.photo_id)}')">See the photo</button>` : ''}</li>`).join('')}</ul>
    </details>`;
  }

  function glossaryHtml() {
    return `<details class="lpu-words"><summary>What the words here mean</summary>
      <dl>${GLOSSARY.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(word(k))}</dd>`).join('')}</dl></details>`;
  }

  // ── The type box ───────────────────────────────────────────────────────────

  // The box left with a value in it. Asked again for the same text — a change
  // the browser fires late, as the pointer goes down on one of the question's
  // own buttons — it changes nothing, so the button is still there to click.
  function typed(box) {
    const id = (document.getElementById('ef-lpu') || {}).dataset?.efLpu || '';
    const a = asked[id];
    if (a && a.text === box.value.trim() && !box.dataset.newType) return;
    delete box.dataset.newType;
    const r = LpuTypes.resolve(box.value, types);
    if (!box.value.trim()) { asked[id] = null; }
    else if (r.exact) { box.value = r.exact.label; asked[id] = null; }
    else asked[id] = { text: box.value.trim(), r, adding: false, draft: LpuTypes.parseNew(box.value) };
    refit(id);
  }

  // The box's question: did you mean, or is it one of these, or add it.
  function askHtml(id) {
    const a = asked[id];
    const box = document.getElementById('ef-lpu-type');
    if (box && box.dataset.newType) {
      let n = null;
      try { n = JSON.parse(box.dataset.newType); } catch (_) { /* below */ }
      if (n) return `<p class="small lpu-new">New type — <strong>${esc(n.label)}</strong>, with ${esc(FAMILY[n.family] || FAMILY.other)} —
        added to the list when you save.
        <button type="button" class="link-btn" onclick="StationLpu.undoNew()">Not new after all</button></p>`;
    }
    if (!a || (box && box.value.trim() !== a.text)) return '';
    const { r } = a;
    const shown = `“${esc(a.text)}”`;
    const picks = r.near.map(n => `<li><button type="button" class="pill" onclick="StationLpu.pick('${escAttr(n.type.key)}')">${esc(n.type.label)}</button>
        <span class="small">${esc(n.why)}</span></li>`).join('');
    const lead = !r.near.length ? `${shown} is not a type on the list, and nothing on it is close.`
      : r.slip ? `${shown} is not a type on the list. Did you mean ${r.near.length > 1 ? 'one of these' : 'this'}?`
      : `${shown} is not a type on the list. Is it one of these?`;
    const add = a.adding ? addFormHtml(a) : `<p class="small">${r.near.length ? 'None of them — ' : ''}<button type="button" class="link-btn"
        onclick="StationLpu.adding(true)">add ${shown} as a new type…</button></p>`;
    return `<div class="lpu-ask${r.slip ? ' is-slip' : ''}">
      <p class="small"><strong>${lead}</strong></p>
      ${r.caution ? `<p class="small lpu-caution">${esc(r.caution)}</p>` : ''}
      ${picks ? `<ul class="lpu-picks">${picks}</ul>` : ''}
      ${add}
    </div>`;
  }

  function addFormHtml(a) {
    const d = a.draft;
    return `<fieldset class="lpu-add"><legend class="small">A new type, added to the list when you save</legend>
      <label class="small">Make<input type="text" id="ef-lpu-new-make" value="${escAttr(d.make)}" placeholder="e.g. OTT HydroMet" autocomplete="off"></label>
      <label class="small">Model<input type="text" id="ef-lpu-new-model" value="${escAttr(d.model)}" autocomplete="off"></label>
      <label class="small">Its fields<select id="ef-lpu-new-family">
        ${Object.entries(FAMILY).map(([k, v]) => `<option value="${k}"${k === d.family ? ' selected' : ''}>${esc(v[0].toUpperCase() + v.slice(1))}</option>`).join('')}
      </select></label>
      <p class="small">Check the unit's label first: the list keeps each model once, so a type added by mistake is a second
        name for one logger.</p>
      <button type="button" onclick="StationLpu.confirmNew()">Add it when I save</button>
      <button type="button" class="link-btn" onclick="StationLpu.adding(false)">Cancel</button>
    </fieldset>`;
  }

  function adding(on) {
    const id = currentId();
    if (asked[id]) asked[id].adding = !!on;
    repaintAsk(id);
    if (on) { const m = document.getElementById('ef-lpu-new-model'); if (m) m.focus(); }
  }

  function confirmNew() {
    const id = currentId();
    const box = document.getElementById('ef-lpu-type');
    const make = (document.getElementById('ef-lpu-new-make') || {}).value || '';
    const model = ((document.getElementById('ef-lpu-new-model') || {}).value || '').trim();
    const family = (document.getElementById('ef-lpu-new-family') || {}).value || 'other';
    if (!box || !LpuTypes.matchKey(model)) {
      const m = document.getElementById('ef-lpu-new-model');
      if (m) { m.setCustomValidity('A model has letters or digits in it — CR300, ERT-A2.'); m.reportValidity(); m.setCustomValidity(''); }
      return;
    }
    // The make and model as typed here may be on the list after all.
    const again = LpuTypes.resolve(`${make} ${model}`, types);
    if (again.exact) { pick(again.exact.key); return; }
    const label = [make.trim(), model].filter(Boolean).join(' ');
    box.value = label;
    box.dataset.newType = JSON.stringify({ label, make: make.trim(), model, family });
    asked[id] = null;
    refit(id);
    if (typeof announce === 'function') announce(`${label} will be added as a new type when you save.`);
  }

  function undoNew() {
    const box = document.getElementById('ef-lpu-type');
    if (!box) return;
    delete box.dataset.newType;
    box.value = box.defaultValue;
    asked[currentId()] = null;
    refit(currentId());
  }

  function pick(key) {
    const box = document.getElementById('ef-lpu-type');
    const t = typeOf(key);
    if (!box || !t) return;
    delete box.dataset.newType;
    box.value = t.label;
    asked[currentId()] = null;
    refit(currentId());
    box.focus();
  }

  function useRead(field, btn) {
    const box = document.getElementById(boxId(field));
    if (!box || !btn) return;
    box.value = btn.dataset.read || '';
    if (typeof editorUnsavedRefresh === 'function') editorUnsavedRefresh();
    box.focus();
  }

  function currentId() { return (document.getElementById('ef-lpu') || {}).dataset?.efLpu || ''; }
  function repaintAsk(id) {
    const el = document.getElementById('ef-lpu-ask');
    if (el) el.innerHTML = askHtml(id);
  }

  // The type changed: its question, and the version boxes its family has.
  // Shown and hidden, not drawn again: a box hidden goes back to the record,
  // so a value typed for one type is not saved under another.
  function refit(id) {
    const sect = document.getElementById('ef-lpu');
    if (!sect) return;
    const rec = recs[id] || null;
    const row = rec && rec.row ? rec.row : null;
    const box = document.getElementById('ef-lpu-type');
    let type = null;
    if (box && box.dataset.newType) {
      try { type = { family: JSON.parse(box.dataset.newType).family }; } catch (_) { /* below */ }
    }
    if (!type && box) type = LpuTypes.resolve(box.value, types).exact || (row && typeOf(row.lpu_type_key));
    const shown = showing(row, type);
    sect.querySelectorAll('[data-lpu-wrap]').forEach(w => {
      const on = shown.includes(w.dataset.lpuWrap);
      if (!on && !w.hidden) {
        const b = w.querySelector('[data-lpu-field]');
        if (b) b.value = b.defaultValue;
      }
      w.hidden = !on;
    });
    repaintAsk(id);
    if (typeof editorUnsavedRefresh === 'function') editorUnsavedRefresh();
  }

  // What the section's boxes hold now, as a draft to draw them back from.
  function snapshot() {
    const box = document.getElementById('ef-lpu-type');
    let newType = null;
    try { newType = box && box.dataset.newType ? JSON.parse(box.dataset.newType) : null; } catch (_) { /* none */ }
    return {
      typeText: box ? box.value : '', newType, values: readValues(),
      checked: FIELDS.concat('lpu_type_key').filter(f => (document.getElementById(`ef-lpu-check-${f}`) || {}).checked),
    };
  }

  // After every drawing of the section — the editor card's (app.js's
  // stationEditorCardDrawn), a refit, a record landing. Its boxes' defaults
  // are the record, so the unsaved bar sees what differs; what was typed goes
  // back in as values, a ticked Right is ticked again, and the type box's
  // question is asked of the box now there. The draft is then spent: the
  // boxes hold the edit.
  function applyDrafts() {
    const sect = document.getElementById('ef-lpu');
    if (!sect) return;
    sect.querySelectorAll('[data-lpu-draft]').forEach(el => { el.value = el.dataset.lpuDraft; delete el.dataset.lpuDraft; });
    sect.querySelectorAll('[data-lpu-draft-checked]').forEach(el => { el.checked = true; delete el.dataset.lpuDraftChecked; });
    const id = sect.dataset.efLpu || '';
    delete drafts[id];
    repaintAsk(id);
  }

  // Undo: the section back to the record.
  function discard() {
    const id = currentId();
    delete drafts[id];
    asked[id] = null;
  }

  function readValues() {
    const out = {};
    for (const f of FIELDS) {
      const el = document.getElementById(boxId(f));
      if (el && !el.closest('[hidden]')) out[f] = el.value;
    }
    return out;
  }

  // ── Saving, with the station ───────────────────────────────────────────────

  // What is wrong with the section before anything is saved: a type typed and
  // neither picked from the list nor added as new.
  function formProblem() {
    const box = document.getElementById('ef-lpu-type');
    if (!box || box.disabled || !types) return '';
    const text = box.value.trim();
    if (!text || box.dataset.newType || LpuTypes.resolve(text, types).exact) return '';
    return `Not saved — the LPU type “${text}” is not on the list. Pick one of the types it is close to, or add it as a new type, `
      + 'in the Logger section under Telemetry. Your edits are still here.';
  }

  // The section's edits as save_station_lpu() takes them, or null when there
  // are none.
  function payload(id) {
    const sect = document.getElementById('ef-lpu');
    const rec = recs[id] || recs[sect && sect.dataset.efLpu] || null;
    const box = document.getElementById('ef-lpu-type');
    if (!sect || !box || box.disabled) return null;
    const row = rec && rec.row ? rec.row : null;
    const p = { station_id: id };
    let any = false;
    const text = box.value.trim();
    if (box.dataset.newType) {
      const n = JSON.parse(box.dataset.newType);
      p.new_lpu_type = { label: n.label, make: n.make, model: n.model, family: n.family, confirm_new: true };
      any = true;
    } else {
      const t = text ? LpuTypes.resolve(text, types).exact : null;
      const key = t ? t.key : null;
      if ((key || null) !== ((row && row.lpu_type_key) || null)) { p.lpu_type_key = key; any = true; }
    }
    const vals = readValues();
    for (const f of FIELDS) {
      if (!(f in vals)) continue;
      const was = row ? (row[f] || '') : '';
      if (vals[f].trim() !== was) { p[f] = vals[f]; any = true; }
    }
    const checked = FIELDS.concat('lpu_type_key').filter(f => (document.getElementById(`ef-lpu-check-${f}`) || {}).checked);
    if (checked.length) { p.checked = checked; any = true; }
    return any ? { p, expected: row ? row.updated_at : null } : null;
  }

  // After the station has saved: the section's edits, if any. Answers the
  // words to add to the editor's status, '' for nothing to save; throws what
  // dbRpc throws, with the edits kept for the redraw that follows.
  async function save(id) {
    const sect = document.getElementById('ef-lpu');
    const was = sect ? sect.dataset.efLpu : '';
    const body = payload(id);
    if (!body) return '';
    try {
      const out = await dbRpc('save_station_lpu', { p: body.p, p_expected: body.expected });
      if (out && out.added_type) { types = null; await loadTypes(); }
      delete drafts[id];
      if (was && was !== id) delete drafts[was];
      asked[id] = null;
      const e = recs[id] = recs[id] || { readings: [], changes: [] };
      e.row = (out && out.station_lpu) || e.row || null;
      e.at = 0;               // the history moved: ask again on the next draw
      ask(id, { force: true });
      return out && out.added_type ? 'the logger details, with a new LPU type on the list' : 'the logger details';
    } catch (err) {
      drafts[id] = snapshot();
      throw err;
    }
  }

  // Words for a refused save of the section.
  function saveErrorText(err) {
    if (err && err.conflict) return `${err.message}. The station saved; its logger details did not — your edits to them are still here.`;
    if (err && err.code === '23505') return `${err.message}. The station saved; its logger details did not.`;
    return `The station saved, but its logger details did not: ${errText(err)}. Your edits to them are still here.`;
  }

  function reload(id) { ask(id, { force: true }); }

  function authChanged() {
    recs = {}; drafts = {}; asked = {};
    types = null; typesMissing = false;
  }

  return {
    cardHtml, cardAsk, editorHtml, formProblem, save, saveErrorText, reload, authChanged,
    typed, pick, useRead, adding, confirmNew, undoNew, applyDrafts, discard,
    WORDS,
    // Read by the check and by nothing else.
    _state: () => ({ recs: Object.keys(recs), types: (types || []).length, asked: JSON.parse(JSON.stringify(asked)) }),
  };
})();
if (typeof window !== 'undefined') window.StationLpu = StationLpu;
