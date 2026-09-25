// MegaNet — frequencies.js
//
//   Frequencies   a station's RX/TX frequency pairs — a repeater's own pair and
//                 every other channel it or a base station uses (0033) — as
//                 rows in the station editor that "+ Add frequency" adds to,
//                 and as a line each on the station card.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc and escAttr. station-editor.js places
// editorHtml() and reads readForm()/formProblem() on save; app.js's
// stnCardHtml() places cardHtml(). The IIFE body only declares, so this file's
// position among the modules is free (`npm run toplevel`).
//
// ── Two homes for a pair, on purpose ─────────────────────────────────────────
// A repeater's own RX/TX pair stays on the repeater (meganet.repeater.rx_mhz /
// tx_mhz, `repeater.rx_mhz` in the document): it is what the path profile, the
// fade map, the backbone, the frequency layer and the ACMA threat analysis all
// read, and it is the primary pair. Every *other* pair is a row of the
// station's `frequencies` list — a second ALERT channel, a voice or link
// channel — and a base station, which has no repeater row, keeps all of its
// pairs there. The editor draws the two as one list of rows with the primary
// first, because to the person typing them they are one list.
//
// ── What a save sends ────────────────────────────────────────────────────────
// Only a list that changed, on river-details.js's terms: save_station() leaves
// a list the document does not mention exactly as it is.

const Frequencies = (function () {

  const FIELDS = [
    { key: 'rx_mhz',       label: 'RX (MHz)',     kind: 'num',  cls: 'freq-mhz' },
    { key: 'tx_mhz',       label: 'TX (MHz)',     kind: 'num',  cls: 'freq-mhz' },
    { key: 'label',        label: 'Use',          kind: 'text', cls: 'freq-use',
      placeholder: 'Use (e.g. Voice)' },
    { key: 'acma_licence', label: 'ACMA licence', kind: 'text', cls: 'freq-lic',
      placeholder: 'ACMA licence' },
  ];

  const mhz = v => (v == null || v === '' ? '' : String(v));

  // Every pair the station has, the repeater's own first — for the card and
  // for anything that wants "all of this station's channels".
  function pairs(s) {
    const out = [];
    const r = s && s.repeater;
    if (r && (r.rx_mhz != null || r.tx_mhz != null)) {
      out.push({ rx_mhz: r.rx_mhz, tx_mhz: r.tx_mhz, acma_licence: r.acma_licence || undefined, primary: true });
    }
    for (const f of (s && s.frequencies) || []) out.push(f);
    return out;
  }

  function pairText(f) {
    const bits = [];
    if (f.rx_mhz != null) bits.push(`RX ${mhz(f.rx_mhz)}`);
    if (f.tx_mhz != null) bits.push(`TX ${mhz(f.tx_mhz)}`);
    return bits.length ? `${bits.join(' · ')} MHz` : '';
  }

  // The card's block, one pair to a line, the way the AlertID block lists
  // addresses. Empty for a station with no pair at all.
  function cardHtml(s) {
    const list = pairs(s);
    if (!list.length) return '';
    const lines = list.map(f => {
      const what = [f.primary ? 'primary' : '', f.label || '', f.acma_licence ? `licence ${f.acma_licence}` : '']
        .filter(Boolean).join(', ');
      return `<span class="mn-pop-line mn-pop-indent">${esc(pairText(f))}${what
        ? ` <span class="mn-pop-note">${esc(what)}</span>` : ''}</span>`;
    });
    return `<div class="stn-card-ids stn-card-freqs"><span class="small txt-muted">Frequencies</span><br>${lines.join('<br>')}</div>`;
  }

  // ── The editor ────────────────────────────────────────────────────────────

  // Each box keeps its caption over it, the way .form-grid labels do: a row of
  // two bare frequencies cannot say which is RX once both are filled in.
  function control(f, v) {
    const val = v == null ? '' : String(v);
    const input = f.kind === 'num'
      ? `<input type="number" step="any" min="0" inputmode="decimal" data-f="${f.key}" value="${escAttr(val)}">`
      : `<input type="text" data-f="${f.key}" placeholder="${escAttr(f.placeholder || '')}" value="${escAttr(val)}">`;
    return `<label class="freq-f ${f.cls}"><span class="small">${esc(f.label)}</span>${input}</label>`;
  }

  function rowHtml(r) {
    r = r || {};
    return `
      <div class="freq-row">
        ${FIELDS.map(f => control(f, r[f.key])).join('')}
        <button type="button" class="btn-danger freq-del" onclick="Frequencies.removeRow(this)"
                aria-label="Remove this frequency" title="Remove this frequency"><span aria-hidden="true">×</span></button>
      </div>`;
  }

  // The primary row: the repeater's own two boxes, under the ids the rest of
  // the editor has always read them by (ef-rx, ef-tx). No remove button — a
  // repeater's pair is cleared by emptying it, and the licence is the
  // repeater's own box above.
  function primaryHtml(s) {
    const r = (s && s.repeater) || {};
    return `
      <div class="freq-row freq-primary">
        <label class="freq-f freq-mhz"><span class="small">RX (MHz)</span>
          <input type="number" step="any" min="0" inputmode="decimal" id="ef-rx" value="${escAttr(mhz(r.rx_mhz))}"></label>
        <label class="freq-f freq-mhz"><span class="small">TX (MHz)</span>
          <input type="number" step="any" min="0" inputmode="decimal" id="ef-tx" value="${escAttr(mhz(r.tx_mhz))}"></label>
        <span class="freq-tag small">Primary — the repeater’s own pair</span>
      </div>`;
  }

  function countText(n) {
    return n ? ` <span class="small ef-plain">— ${n}</span>` : '';
  }

  // The block, inside the Repeater Configuration grid for a repeater
  // (`primary` true) and in a section of its own for a base station.
  function editorHtml(s, { primary = false } = {}) {
    const rows = (s && s.frequencies) || [];
    const n = rows.length + (primary ? 1 : 0);
    return `
      <div class="full ef-section freq-list" id="ef-freqs">
        <div class="ef-section-head">
          <div class="ef-sub">Frequencies — RX / TX<span class="freq-count">${countText(n)}</span></div>
          <button type="button" onclick="Frequencies.addRow()" aria-label="Add a frequency">+ Add frequency</button>
        </div>
        ${primary ? primaryHtml(s) : ''}
        <div class="freq-rows">${rows.map(r => rowHtml(r)).join('')}</div>
        <div class="small ef-note">
          ${primary
            ? 'The primary pair is what the path profile, fade map, backbone, frequency layer and ACMA tools use. '
              + 'Add a row for every other channel this site listens or transmits on.'
            : 'One row per channel this station listens or transmits on.'}
          Blank means not recorded.
        </div>
      </div>`;
  }

  function recount() {
    const box = document.getElementById('ef-freqs');
    if (!box) return;
    const n = box.querySelectorAll('.freq-row').length;
    const el = box.querySelector('.freq-count');
    if (el) el.innerHTML = countText(n);
  }

  // A new row goes at the foot, after the primary and the pairs already there,
  // with the cursor in its RX box.
  function addRow() {
    const box = document.getElementById('ef-freqs');
    if (!box) return;
    const rows = box.querySelector('.freq-rows');
    rows.insertAdjacentHTML('beforeend', rowHtml({}));
    recount();
    const last = rows.querySelector('.freq-row:last-child input');
    if (last) last.focus();
  }

  // Focus to + Add, not to <body>: the pressed button has just gone.
  function removeRow(btn) {
    const row = btn && btn.closest('.freq-row');
    const box = document.getElementById('ef-freqs');
    if (!row || !box) return;
    row.remove();
    recount();
    const add = box.querySelector('.ef-section-head button');
    if (add) add.focus();
  }

  function readRow(el) {
    const out = {};
    for (const f of FIELDS) {
      const c = el.querySelector(`[data-f="${f.key}"]`);
      const raw = c ? String(c.value).trim() : '';
      if (raw === '') continue;
      out[f.key] = f.kind === 'num' ? Number(raw) : raw;
    }
    return out;
  }

  function normalise(rows) {
    return (rows || []).map(r => {
      const out = {};
      for (const f of FIELDS) {
        const v = r[f.key];
        if (v == null || String(v).trim() === '') continue;
        out[f.key] = f.kind === 'num' ? Number(v) : String(v).trim();
      }
      return out;
    }).filter(r => Object.keys(r).length);
  }

  // { frequencies: [...] } when the rows differ from the record's, else {} —
  // and {} when the form has no frequencies block at all.
  function readForm(record) {
    const box = document.getElementById('ef-freqs');
    if (!box) return {};
    const rows = normalise([...box.querySelectorAll('.freq-rows .freq-row')].map(readRow));
    const before = normalise((record && record.frequencies) || []);
    return JSON.stringify(rows) === JSON.stringify(before) ? {} : { frequencies: rows };
  }

  // A box the browser could not read, or a row with a use and no frequency —
  // either would be dropped by the save without a word, so it is named here.
  function formProblem() {
    const box = document.getElementById('ef-freqs');
    if (!box) return null;
    const rows = [...box.querySelectorAll('.freq-row')];
    for (let i = 0; i < rows.length; i++) {
      for (const c of rows[i].querySelectorAll('input[type="number"]')) {
        if (c.validity && (c.validity.badInput || (c.value !== '' && Number(c.value) <= 0))) {
          c.focus();
          const cap = c.closest('label')?.querySelector('span')?.textContent || 'a box';
          return `Frequencies, row ${i + 1}: “${cap}” is not a frequency in MHz. `
               + 'Nothing was saved — correct it or clear it and save again.';
        }
      }
      if (rows[i].classList.contains('freq-primary')) continue;
      const r = readRow(rows[i]);
      if (Object.keys(r).length && r.rx_mhz == null && r.tx_mhz == null) {
        const c = rows[i].querySelector('[data-f="rx_mhz"]');
        if (c) c.focus();
        return `Frequencies, row ${i + 1} has no RX or TX frequency. Nothing was saved — `
             + 'give it one, or remove the row.';
      }
    }
    return null;
  }

  return {
    FIELDS,
    pairs,
    cardHtml,
    editorHtml,
    addRow,
    removeRow,
    readForm,
    formProblem,
  };
})();
if (typeof window !== 'undefined') window.Frequencies = Frequencies;
