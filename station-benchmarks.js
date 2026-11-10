// MegaNet — station-benchmarks.js
//
//   StationBenchmarks   a station's benchmarks: the marks its gauge is levelled
//                       from. The Bureau's, as HDB holds them (0101) — each
//                       one's level and datum, what it is and where, the
//                       office's comments — and the ones an editor has entered
//                       here (0110), with what each reads on the gauge.
//                       On the station card's 🌊 Flood tab and in the station
//                       editor, where an editor adds, changes or removes an
//                       entered one; and in the 📏 Level Survey's Datum and
//                       control step, where Use puts one in as the survey's
//                       primary benchmark.
//
// After core.js and datastore.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, escAttr, termHtml and announce, to
// datastore.js for dbSelect, dbRpc and dbCanWrite, and to auth.js for
// Auth.mayWrite. Three files call in: app.js, whose station card places
// cardHtml() and asks cardAsk(); station-editor.js, which places editorHtml();
// and level-survey.js, which asks ask(), rows(), listHtml() and pick(). All of
// it from inside its own functions: the IIFE body only declares
// (`npm run toplevel`).
//
// ── Where the rows come from ─────────────────────────────────────────────────
// Three reads, by who is asking:
//
//   meganet.station_benchmark          the Bureau's report *Queensland Flood
//     (0101, editors)                  Warning River Height Stations —
//                                      Benchmark Details*, printed from HDB on
//                                      15/10/2026 and read by
//                                      tools/ingest/benchmarks.py, put on each
//                                      station by its bureau number.
//   meganet.station_benchmark_entered  what editors have entered (0110). A
//     (0110, editors)                  table of its own, so loading the
//                                      Bureau's report again cannot wipe one.
//   meganet.station_benchmark_public   the Bureau's in numbers only (0102):
//     (0102, anybody)                  level, datum, the survey mark's number,
//                                      on the gauge. For everybody else.
//
// A benchmark's description says where it is to the tree and the gate post, so
// the words are editors' (RLS) and somebody who is not one is shown the
// numbers. Levels are shown as held — the Bureau's to the centimetre, an
// entered one to the millimetre at most; the database works out the level on
// the gauge, and only where the mark and the gauge zero are both AHD or both
// State, or the level was given on the gauge to begin with.
//
// ── Writing ──────────────────────────────────────────────────────────────────
// meganet.station_benchmark_entry_save(jsonb) and _remove(uuid) (0110), which
// ask is_editor() themselves. Saved at once, on its own — not with the station
// editor's Save: a benchmark is its own record, so the editor's unsaved bar
// leaves this section alone (data-ef-ignore).

const StationBenchmarks = (function () {

  const FRESH_MS = 5 * 60 * 1000;   // a station's list, asked again after five minutes
  const COLS = 'bureau_number,ord,level_m,datum,description,comment,gauge_zero_m,gauge_datum,gauge_zero_from,on_gauge_m,printed_on';
  const PUBLIC_COLS = 'bureau_number,ord,mark,level_m,datum,gauge_zero_m,gauge_datum,gauge_zero_from,on_gauge_m,printed_on';
  const ENTERED_COLS = 'id,station_id,level_m,datum,datum_other,description,comment,surveyed_on,source,gauge_zero_m,gauge_datum,on_gauge_m,created_by,created_at,updated_by,updated_at';
  const DEFAULT_SOURCE = 'Entered in Flood-Net';
  const cache = {};                  // station id → { rows, entered, at, as, p, error, noEntries }
  let form = null;                   // the one open add/change form: { station, where, entry, values, error, busy }
  let removing = null;               // { station, entry } — the entered benchmark being asked about

  // The words this section uses, and what each means here — one list, for the
  // hover and for the fold that says the same without one.
  const WORDS = {
    benchmark: 'A fixed survey mark near the gauge whose level is known — a pin in concrete, a bolt in a tree, a State survey mark — that the gauge is levelled from. The Bureau\'s are the ones it holds for this station in HDB; an editor can add others here.',
    datum: 'The surface a level is measured up from. Two levels compare only when they are in the same datum — 4.43 m AHD and 4.43 m on an assumed datum are different heights.',
    AHD: 'Australian Height Datum: metres above mean sea level as the national survey fixes it. An AHD level compares with any other AHD level, anywhere.',
    ASSUM: 'An assumed datum: a level made up at the site — often 100.000 at one mark, or the gauge\'s own reading. It compares only with levels on the same assumption at this site, so it is never put on the gauge here.',
    STATE: 'Queensland\'s State datum, used before AHD. It differs from AHD by centimetres to decimetres from place to place; the comment often says by how much here.',
    UNKNOWN: 'Nobody has recorded which datum this level is in.',
    GH: 'Gauge height: the level is given on the river gauge itself — what the mark would read if the gauge boards reached it — rather than in AHD or another datum.',
    OTHER: 'A datum that is none of the others on the list — a council\'s, a mine\'s, an old port datum — named by whoever entered it.',
    onGauge: 'What the mark would read on the river gauge: its level less the gauge zero in force (the survey row with no end date, else the one that ended last). Worked out only when the mark and the zero are both AHD or both State; left out otherwise.',
    TBM: 'Temporary benchmark — a local mark set for the gauge (a bolt, a nail, a spike), not one of the State\'s numbered survey marks. Common in the descriptions.',
    PSM: 'Permanent survey mark — a numbered mark in the Queensland survey network, whose level and position the State holds. Also in the descriptions, often with its number.',
    HDB: 'The Bureau of Meteorology\'s hydrological database. Its Benchmark Details report lists the benchmarks the Bureau holds for each river height station; Flood-Net shows the report as printed.',
    entered: 'Added in Flood-Net by a signed-in editor, not taken from the Bureau\'s report. Loading a newer Bureau report never changes or removes these.',
  };
  const WORD_ORDER = ['benchmark', 'datum', 'AHD', 'ASSUM', 'STATE', 'GH', 'UNKNOWN', 'onGauge', 'TBM', 'PSM', 'HDB', 'entered'];
  const WORD_SAY = { benchmark: 'Benchmark', datum: 'Datum', AHD: 'AHD', ASSUM: 'Assumed', STATE: 'State', GH: 'Gauge height (GH)',
                     UNKNOWN: 'Datum unknown', onGauge: 'On the gauge', TBM: 'TBM', PSM: 'PSM', HDB: 'HDB', entered: 'Entered in Flood-Net' };
  const DATUM_LABEL = { AHD: 'AHD', ASSUM: 'assumed', STATE: 'State', UNKNOWN: 'datum unknown', GH: 'gauge height' };
  const DATUM_LONG = { AHD: 'm AHD', ASSUM: 'm on an assumed datum', STATE: 'm State datum', UNKNOWN: 'm, datum unknown', GH: 'm on the gauge' };
  // The pick-list, in the order the form offers them: the report's four, then
  // gauge height, then another.
  const DATUM_OPTIONS = [
    ['AHD', 'AHD — Australian Height Datum'],
    ['ASSUM', 'Assumed datum'],
    ['STATE', 'State datum'],
    ['GH', 'Gauge height (on the gauge itself)'],
    ['UNKNOWN', 'Datum unknown'],
    ['OTHER', 'Another datum…'],
  ];

  function signedIn() { return typeof dbCanWrite === 'function' && dbCanWrite(); }
  // Whether this person may write, as far as the page knows — the database is
  // the one that decides (is_editor(), in both functions).
  function editor() {
    if (!signedIn()) return false;
    return typeof Auth === 'undefined' || typeof Auth.mayWrite !== 'function' || !!Auth.mayWrite();
  }
  function who() { return editor() ? 'editor' : 'public'; }
  function m2(v) { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? '' : n.toFixed(2); }
  // An entered level: to the millimetre where it has one, never fewer than two places.
  function m3(v) {
    const n = Number(v);
    if (v == null || v === '' || !Number.isFinite(n)) return '';
    return n.toFixed(3).replace(/0$/, '');
  }
  function dmy(iso) { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; }
  function datumHtml(b) {
    if (b.datum === 'OTHER') return termHtml(b.datum_other || 'another datum', WORDS.OTHER);
    return termHtml(DATUM_LABEL[b.datum] || b.datum || '', WORDS[b.datum] || '');
  }
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ── The rows ───────────────────────────────────────────────────────────────

  // The station's benchmarks, asked once and kept five minutes — and kept as
  // whoever asked, so signing in or out asks again rather than showing the
  // other person's answer. An editor is given the Bureau's with their words
  // and the entered ones; anybody else the Bureau's numbers. A database before
  // 0101 has no such view, and one before 0110 no entered benchmarks: each is
  // an empty list, not an error to show.
  function missing(err) {
    return !!err && (err.status === 404 || /station_benchmark/.test(String(err.message || '')));
  }
  function current(c) { return !!c && c.as === who(); }
  function ask(id, o = {}) {
    if (!id) return Promise.resolve([]);
    const c = cache[id];
    if (c && c.p) return c.p;
    if (!o.again && current(c) && c.rows && Date.now() - c.at < FRESH_MS) return Promise.resolve(c.rows);
    if (typeof dbSelect !== 'function') {
      cache[id] = { rows: [], entered: [], at: Date.now(), as: who() };
      return Promise.resolve([]);
    }
    const as = who();
    const q = `station_id=eq.${encodeURIComponent(id)}`;
    const reads = as === 'editor'
      ? [dbSelect(`station_benchmark?select=${COLS}&${q}&order=ord.asc`),
         dbSelect(`station_benchmark_entered?select=${ENTERED_COLS}&${q}&order=created_at.asc`)
           .then(rows => ({ rows: rows || [] }), err => { if (missing(err)) return { rows: [], none: true }; throw err; })]
      : [dbSelect(`station_benchmark_public?select=${PUBLIC_COLS}&${q}&order=ord.asc`), Promise.resolve({ rows: [] })];
    const p = Promise.all(reads)
      .then(([rows, entered]) => {
        cache[id] = { rows: rows || [], entered: entered.rows, noEntries: !!entered.none, at: Date.now(), as };
        return cache[id].rows;
      })
      .catch(err => {
        // Somebody who is not an editor is shown nothing rather than an error:
        // the numbers are an extra, and offline is not news to them.
        cache[id] = { rows: [], entered: [], at: Date.now(), as,
                      error: missing(err) || as !== 'editor' ? '' : String((err && err.message) || err) };
        return [];
      });
    cache[id] = Object.assign({}, c, { p });
    return p;
  }
  // The Bureau's rows — with their words only for an editor (level-survey.js
  // and pick() ask as one).
  function rows(id) { const c = cache[id]; return current(c) && c.rows ? c.rows : null; }
  function entered(id) { const c = cache[id]; return current(c) && c.entered ? c.entered : []; }

  // A name for the mark out of its description, when the description gives
  // one: "PSM 46757", "CGC200041", "BM6001". Otherwise null, and the survey
  // keeps the name it had.
  function markName(desc) {
    const m = /\b(PSM|SSM|PM|CGC|BM|SD)\s*(?:#\s*)?(\d{3,}[A-Z]?)\b/i.exec(String(desc || ''));
    if (!m) return null;
    const p = m[1].toUpperCase();
    return p === 'CGC' || p === 'BM' ? `${p}${m[2]}` : `${p} ${m[2]}`;
  }

  // What Use puts in a level survey: the datum it can be booked in, its RL in
  // that datum, a name, its description, and where the figure came from. AHD
  // and assumed go in as they are; a gauge height goes in on the gauge; a
  // State mark goes in on the gauge where the database could put it there (the
  // survey has no State datum), else as an assumed level; any other datum is
  // an assumed one. `key` is the Bureau's order number, or an entered
  // benchmark's id.
  function pick(id, key) {
    const mine = typeof key === 'string' && !/^\d+$/.test(key);
    const b = mine ? entered(id).find(x => x.id === key)
                   : (rows(id) || []).find(x => Number(x.ord) === Number(key));
    if (!b) return null;
    const level = Number(b.level_m);
    const onGauge = b.on_gauge_m == null ? null : Number(b.on_gauge_m);
    const fmt = mine ? m3 : m2;
    const from = mine
      ? `${b.source || DEFAULT_SOURCE}${b.surveyed_on ? `, surveyed ${dmy(b.surveyed_on)}` : ''}`
      : `Bureau benchmark details (HDB${b.printed_on ? `, ${dmy(b.printed_on)}` : ''})`;
    const unit = b.datum === 'OTHER' ? `m ${b.datum_other || 'another datum'}` : (DATUM_LONG[b.datum] || 'm');
    let datum = 'ASSUMED', rl = level, source = `${from}: ${fmt(level)} ${unit}`;
    if (b.datum === 'AHD') datum = 'AHD';
    else if (b.datum === 'GH') datum = 'LGH';
    else if (b.datum === 'STATE' && onGauge != null) {
      datum = 'LGH';
      rl = onGauge;
      source += ` — ${fmt(onGauge)} on the gauge through its zero of ${m2(b.gauge_zero_m)} m State`;
    } else if (b.datum !== 'ASSUM') {
      source += ', booked as an assumed level';
    }
    return { datum, rl, source, name: markName(b.description), description: b.description || '' };
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  function onGaugeHtml(b, fmt) {
    if (b.on_gauge_m == null || b.datum === 'GH') return '';
    return ` · ${termHtml('on the gauge', WORDS.onGauge)} <strong>${esc(fmt(b.on_gauge_m))}</strong>`;
  }
  function useBtn(id, key, use) {
    return use ? ` <button type="button" onclick="${escAttr(use)}('${escAttr(id)}', ${key})">Use</button>` : '';
  }

  // One of the Bureau's. Without its words (somebody who is not an editor) it
  // is the numbers and the survey mark's number.
  function itemHtml(id, b, use) {
    return `<li><strong>${esc(m2(b.level_m))} m</strong> ${datumHtml(b)}${onGaugeHtml(b, m2)}${useBtn(id, Number(b.ord), use)}`
      + `${b.mark ? ` · ${esc(b.mark)}` : ''}`
      + `${b.description ? `<br>${esc(b.description)}` : ''}`
      + `${b.comment ? `<br><span class="small txt-muted">${esc(b.comment)}</span>` : ''}</li>`;
  }

  // One an editor entered: the same, then when it was surveyed, where the
  // figure came from and who entered it — and, where `o.edit`, Change and
  // Remove.
  function enteredItemHtml(id, b, o) {
    const by = [b.surveyed_on ? `Surveyed ${dmy(b.surveyed_on)}` : '', `Source: ${b.source || DEFAULT_SOURCE}`,
                b.created_by ? `entered by ${b.created_by}${b.created_at ? ` on ${dmy(b.created_at)}` : ''}` : '']
      .filter(Boolean).join(' · ');
    const key = `'${escAttr(b.id)}'`;
    let tools = '';
    if (o.edit && removing && removing.station === id && removing.entry === b.id) {
      tools = `<span class="sb-ask" role="group" aria-label="Remove this benchmark?">Remove this benchmark?
        <button type="button" class="sb-remove-yes" onclick="StationBenchmarks.removeNow('${escAttr(id)}', ${key})">Remove</button>
        <button type="button" onclick="StationBenchmarks.removeAsk('${escAttr(id)}', null)">Keep</button></span>`;
    } else if (o.edit) {
      tools = `<span class="sb-tools"><button type="button" class="link-btn sb-change" onclick="StationBenchmarks.openForm('${escAttr(id)}', '${escAttr(o.where)}', ${key})">Change</button>
        <button type="button" class="link-btn sb-remove" onclick="StationBenchmarks.removeAsk('${escAttr(id)}', ${key})">Remove</button></span>`;
    }
    return `<li data-sb-entry="${escAttr(b.id)}"><strong>${esc(m3(b.level_m))} m</strong> ${datumHtml(b)}${onGaugeHtml(b, m3)}${useBtn(id, key, o.use)}`
      + `<br>${esc(b.description || '')}`
      + `${b.comment ? `<br><span class="small txt-muted">${esc(b.comment)}</span>` : ''}`
      + `<br><span class="small txt-muted">${esc(by)}</span>${tools ? `<br>${tools}` : ''}</li>`;
  }

  function wordsHtml() {
    return `<details class="sb-words"><summary class="small">What the words here mean</summary><dl class="small">`
      + WORD_ORDER.map(k => `<dt>${esc(WORD_SAY[k])}</dt><dd>${esc(WORDS[k])}</dd>`).join('') + '</dl></details>';
  }

  function bureauHtml(id, o) {
    const list = rows(id) || [];
    if (!list.length) return '';
    const printed = list[0].printed_on ? `, printed ${dmy(list[0].printed_on)}` : '';
    const from = `(${termHtml('HDB', WORDS.HDB)}${esc(printed)})`;
    const lead = list.length === 1
      ? `The Bureau's benchmark details report lists this ${termHtml('benchmark', WORDS.benchmark)} here ${from}:`
      : `The Bureau's benchmark details report lists these ${list.length} ${termHtml('benchmarks', WORDS.benchmark)} here ${from}:`;
    return `<p class="small sb-from">${lead}</p><ul class="sb-list sb-bureau">${list.map(b => itemHtml(id, b, o.use)).join('')}</ul>`;
  }
  function enteredHtml(id, o) {
    const list = entered(id);
    if (!list.length) return '';
    return `<p class="small sb-from">${termHtml('Entered in Flood-Net', WORDS.entered)}:</p>`
      + `<ul class="sb-list sb-entered">${list.map(b => enteredItemHtml(id, b, o)).join('')}</ul>`;
  }

  // The list for the Level Survey, with a Use button on each when `use` names
  // the function to call — or '' when the station has none.
  function listHtml(id, o = {}) {
    const body = bureauHtml(id, o) + enteredHtml(id, { use: o.use });
    return body ? body + wordsHtml() : '';
  }

  // ── Adding and changing one ────────────────────────────────────────────────

  function blank() {
    return { level_m: '', datum: 'AHD', datum_other: '', description: '', comment: '', surveyed_on: '', source: DEFAULT_SOURCE };
  }
  function formHtml(id) {
    const v = form.values;
    const f = (name, label, control, hint) => `<label class="sb-f sb-f-${name}">${label}${control}${hint ? `<span class="small txt-muted">${hint}</span>` : ''}</label>`;
    const enter = `onkeydown="if (event.key === 'Enter') { event.preventDefault(); StationBenchmarks.saveForm(); }"`;
    return `<div class="sb-form" id="sb-form" data-ef-ignore role="group" aria-label="${form.entry ? 'Change this benchmark' : 'Add a benchmark'}">
      <strong class="sb-form-h">${form.entry ? 'Change this benchmark' : 'Add a benchmark'}</strong>
      <div class="sb-form-grid">
        ${f('level', `Level (m)`, `<input type="text" id="sb-level" inputmode="decimal" autocomplete="off" value="${escAttr(v.level_m)}" ${enter}>`,
            'The mark\'s level in metres, in the datum picked beside it.')}
        ${f('datum', termHtml('Datum', WORDS.datum), `<select id="sb-datum" onchange="StationBenchmarks.datumChanged()">${DATUM_OPTIONS.map(([k, t]) =>
            `<option value="${k}"${v.datum === k ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`)}
        <label class="sb-f sb-f-other"${v.datum === 'OTHER' ? '' : ' hidden'}>Which datum<input type="text" id="sb-datum-other" maxlength="40" value="${escAttr(v.datum_other)}" ${enter}></label>
        ${f('desc', 'Description', `<input type="text" id="sb-desc" maxlength="500" value="${escAttr(v.description)}" ${enter}>`,
            'What the mark is and where — “PSM 12345, brass plaque in the bridge kerb, 18 m upstream of the gauge”.')}
        ${f('comment', 'Comments', `<input type="text" id="sb-comment" maxlength="500" value="${escAttr(v.comment)}" ${enter}>`,
            'Anything else: who levelled it, how it ties to another datum.')}
        ${f('date', 'Date surveyed', `<input type="date" id="sb-date" max="${escAttr(today())}" value="${escAttr(v.surveyed_on)}">`)}
        ${f('source', 'Source', `<input type="text" id="sb-source" maxlength="200" value="${escAttr(v.source)}" ${enter}>`,
            'Where the figure came from — a survey report, a council, a level run.')}
      </div>
      <p class="small txt-muted sb-private">No person's name, phone number, or gate or lock code here — only what the mark is and where.</p>
      ${form.error ? `<p class="small txt-bad sb-error" role="alert">${esc(form.error)}</p>` : ''}
      <div class="sb-form-btns">
        <button type="button" class="primary" id="sb-save" onclick="StationBenchmarks.saveForm()"${form.busy ? ' disabled' : ''}>${form.busy ? 'Saving…' : form.entry ? 'Save the change' : 'Save the benchmark'}</button>
        <button type="button" id="sb-cancel" onclick="StationBenchmarks.closeForm()"${form.busy ? ' disabled' : ''}>Cancel</button>
      </div>
    </div>`;
  }

  // What is in the form's boxes, as typed.
  function readForm() {
    const val = i => { const el = document.getElementById(i); return el ? String(el.value || '') : ''; };
    return { level_m: val('sb-level').trim(), datum: val('sb-datum') || 'AHD', datum_other: val('sb-datum-other').trim(),
             description: val('sb-desc').trim(), comment: val('sb-comment').trim(), surveyed_on: val('sb-date'),
             source: val('sb-source').trim() };
  }
  // What is wrong with it, in a sentence — or '' when it can be sent. The
  // database checks the same things again (0110).
  function problem(v) {
    const level = v.level_m.replace(',', '.');
    if (level === '') return 'Give the benchmark\'s level in metres.';
    if (!/^[-+]?\d+(\.\d+)?$/.test(level)) return `The level has to be a number of metres, like 104.26 — not “${v.level_m}”.`;
    if (Number(level) < -500 || Number(level) > 9000) return 'The level has to be between -500 and 9000 metres.';
    if (v.datum === 'OTHER' && !v.datum_other) return 'Say which datum it is, or pick one from the list.';
    if (!v.description) return 'Say what the mark is and where, so the next crew can find it.';
    if (v.surveyed_on && v.surveyed_on > today()) return 'The date surveyed is in the future.';
    return '';
  }

  function openForm(id, where, entryId) {
    if (!editor()) return;
    const b = entryId ? entered(id).find(x => x.id === entryId) : null;
    if (entryId && !b) return;
    form = { station: id, where: where || 'card', entry: b ? b.id : null, error: '', busy: false,
             values: b ? { level_m: m3(b.level_m), datum: b.datum, datum_other: b.datum_other || '', description: b.description || '',
                           comment: b.comment || '', surveyed_on: b.surveyed_on || '', source: b.source || DEFAULT_SOURCE }
                       : blank() };
    removing = null;
    paint(id);
    const first = document.getElementById('sb-level');
    if (first) first.focus();
  }
  function closeForm() {
    if (!form) return;
    const { station, where } = form;
    form = null;
    paint(station);
    const add = document.querySelector(`[data-mn-bm="${cssAttr(station)}"][data-mn-bm-where="${where}"] .sb-add`);
    if (add) add.focus();
  }
  function datumChanged() {
    const sel = document.getElementById('sb-datum');
    const other = document.querySelector('#sb-form .sb-f-other');
    if (!sel || !other) return;
    other.hidden = sel.value !== 'OTHER';
    if (!other.hidden) { const el = document.getElementById('sb-datum-other'); if (el) el.focus(); }
  }
  async function saveForm() {
    if (!form || form.busy) return;
    const v = readForm();
    form.values = v;
    form.error = problem(v);
    const id = form.station;
    if (form.error) {
      paint(id);
      const el = document.getElementById(/level/i.test(form.error) ? 'sb-level' : /datum/.test(form.error) ? 'sb-datum-other'
        : /date/.test(form.error) ? 'sb-date' : 'sb-desc');
      if (el) el.focus();
      return;
    }
    form.busy = true;
    paint(id);
    const changed = !!form.entry;
    try {
      await dbRpc('station_benchmark_entry_save', { p: Object.assign(
        { station_id: id, level_m: v.level_m.replace(',', '.'), datum: v.datum, datum_other: v.datum === 'OTHER' ? v.datum_other : '',
          description: v.description, comment: v.comment, surveyed_on: v.surveyed_on || null, source: v.source || DEFAULT_SOURCE },
        form.entry ? { id: form.entry } : {}) });
    } catch (err) {
      if (!form) return;
      form.busy = false;
      form.error = saveErrorText(err);
      paint(id);
      return;
    }
    const where = form.where;
    form = null;
    await ask(id, { again: true });
    paint(id);
    if (typeof announce === 'function') announce(changed ? 'Benchmark changed.' : 'Benchmark added.');
    const add = document.querySelector(`[data-mn-bm="${cssAttr(id)}"][data-mn-bm-where="${where}"] .sb-add`);
    if (add) add.focus();
  }
  function saveErrorText(err) {
    if (err && err.denied) return 'Not saved — adding a benchmark is for signed-in editors. Sign in again, or ask an administrator to add you.';
    if (err && err.status === 404) return 'Not saved — this database does not keep entered benchmarks yet (they arrive with migration 0110).';
    return `Not saved — ${String((err && err.message) || err)}`;
  }

  function removeAsk(id, entryId) {
    removing = entryId ? { station: id, entry: entryId } : null;
    paint(id);
    const el = document.querySelector(removing ? '.sb-remove-yes' : `[data-mn-bm="${cssAttr(id)}"] .sb-add`);
    if (el) el.focus();
  }
  async function removeNow(id, entryId) {
    if (!editor()) return;
    removing = null;
    try {
      await dbRpc('station_benchmark_entry_remove', { p_id: entryId });
    } catch (err) {
      const c = cache[id];
      if (c) c.note = `Not removed — ${err && err.denied ? 'removing a benchmark is for signed-in editors' : String((err && err.message) || err)}.`;
      paint(id);
      return;
    }
    if (form && form.station === id && form.entry === entryId) form = null;
    await ask(id, { again: true });
    paint(id);
    if (typeof announce === 'function') announce('Benchmark removed.');
    const add = document.querySelector(`[data-mn-bm="${cssAttr(id)}"] .sb-add`);
    if (add) add.focus();
  }

  // ── The section, on the card and in the editor ─────────────────────────────
  // Drawn empty and filled when the rows arrive, SiteFeatures.cardAsk's terms;
  // an empty section is not drawn at all (:empty). Every place the station's
  // benchmarks are on the page carries data-mn-bm, and paint() fills them all,
  // so a benchmark added on the card is in the open editor too.

  const EDITOR_NONE = '<p class="small ef-note">No benchmarks are recorded for this station.</p>';
  function cssAttr(v) { return String(v).replace(/["\\]/g, '\\$&'); }

  // `offer`: whether an editor is offered Add where the station has no
  // benchmarks yet — always in the editor; on the card only at a station with
  // a river gauge, so a repeater's card is not given an empty section.
  function sectionBodyHtml(id, where, offer = true) {
    const c = cache[id];
    if (!current(c) || !c.rows) return '';
    const may = editor();
    const head = where === 'card'
      ? `<span class="small txt-muted stn-card-sb-h" title="${escAttr(WORDS.benchmark)}">Benchmarks</span>` : '';
    if (c.error) return `${head}<p class="small txt-bad">The benchmarks could not be read — ${esc(c.error)}</p>`;
    const o = { where, edit: may && !c.noEntries };
    const lists = bureauHtml(id, o) + enteredHtml(id, o);
    // Nothing to show somebody who cannot add one: no section at all.
    if (!lists && !(may && offer)) return '';
    const open = form && form.station === id && form.where === where;
    const numbersOnly = !may && lists
      ? `<p class="small txt-muted sb-numbers">What each mark is and where it is are shown to signed-in editors.</p>` : '';
    const none = lists ? '' : `<p class="small txt-muted sb-none">No ${termHtml('benchmarks', WORDS.benchmark)} are recorded for this station yet.</p>`;
    const add = !may ? ''
      : c.noEntries ? `<p class="small txt-muted">Adding a benchmark arrives with the next database update (migration 0110).</p>`
      : open ? formHtml(id)
      : `<button type="button" class="sb-add" onclick="StationBenchmarks.openForm('${escAttr(id)}', '${escAttr(where)}', null)">＋ Add a benchmark</button>`;
    const note = c.note ? `<p class="small txt-bad" role="alert">${esc(c.note)}</p>` : '';
    return `${head}${none}${lists}${numbersOnly}${note}${add}${wordsHtml()}`;
  }
  function paint(id) {
    document.querySelectorAll(`[data-mn-bm="${cssAttr(id)}"]`).forEach(el => {
      const where = el.dataset.mnBmWhere || 'card';
      el.innerHTML = sectionBodyHtml(id, where, el.dataset.mnBmOffer !== '0') || (where === 'editor' ? EDITOR_NONE : '');
    });
    const c = cache[id];
    if (c) delete c.note;
  }

  // The station card's 🌊 Flood tab.
  function cardHtml(s, o = {}) {
    if (!s || !s.id) return '';
    const offer = o.offerAdd !== false;
    return `<div class="acma-sect stn-card-benchmarks" id="mn-bm-card-${escAttr(s.id)}" data-mn-bm="${escAttr(s.id)}" data-mn-bm-where="card" data-mn-bm-offer="${offer ? 1 : 0}">${sectionBodyHtml(s.id, 'card', offer)}</div>`;
  }
  function cardAsk(s) {
    if (!s || !s.id) return;
    const id = s.id;
    ask(id).then(() => paint(id));
  }

  // The station editor, under the Bureau flood warning details. Its boxes are
  // not the station's fields, and are saved on their own (data-ef-ignore).
  function editorHtml(s) {
    const id = (s && s.id) || '';
    const head = `<div class="ef-section-head"><div class="ef-sub">${termHtml('Benchmarks', WORDS.benchmark)}</div></div>`;
    if (!id) {
      return `<div class="ef-section ef-bm" data-ef-ignore>${head}<p class="small ef-note">Save the station first; its benchmarks can be added after.</p></div>`;
    }
    const c = cache[id];
    const have = current(c) && !!c.rows;
    if (!(have && Date.now() - c.at < FRESH_MS)) ask(id).then(() => paint(id));
    return `<div class="ef-section ef-bm" data-ef-ignore>${head}
      <p class="small ef-note">The marks this station's gauge is levelled from: the Bureau's, as its report prints them, and any
        added here. A benchmark is saved as soon as you press Save the benchmark — it does not wait for the station's Save.</p>
      <div class="ef-bm-body" id="ef-bm-${escAttr(id)}" data-mn-bm="${escAttr(id)}" data-mn-bm-where="editor">${sectionBodyHtml(id, 'editor')
        || (have ? EDITOR_NONE : '<p class="small ef-note">Reading the benchmarks…</p>')}</div>
    </div>`;
  }

  return { WORDS, DATUM_OPTIONS, ask, rows, entered, pick, markName, listHtml, cardHtml, cardAsk, editorHtml,
           openForm, closeForm, saveForm, datumChanged, removeAsk, removeNow, problem };
})();
