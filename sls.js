// MegaNet — sls.js
//
//   SLS   What the Bureau's Service Level Specification says about a station:
//         its flood class levels, whether anybody forecasts for it, who owns
//         it, and whether a person reads it or a radio does.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `esc`/`escAttr`; only from inside its own
// functions, so this file's position among the modules is free.
//
// ── What this is ─────────────────────────────────────────────────────────────
// `archive/QLD_SLS_current.pdf` is the "Service Level Specification for Flood
// Forecasting and Warning Services for Queensland", version 3.7, December
// 2025 — the Bureau's own copy is at DOC_URL below, and the card's heading
// links to it. Six of its ten schedules are tables of stations keyed on the
// bureau number — the same number `station_number` carries.
// `tools/ingest/sls.py` reads them into `data/sls-locations.json`, and this
// reads that.
//
// It answers questions the app has never been able to answer about a station:
//
//   * The flood class levels — the minor, moderate and major heights that
//     decide which warning goes out. 1,069 of these locations have them.
//   * Whether it is a **forecast** location (Schedule 2 — somebody predicts a
//     height for it) or an **information** location (Schedule 3 — it is
//     reported and classified but not predicted).
//   * The prediction type, the target warning lead time and the trigger —
//     two of each for the three stations the schedule gives two targets.
//   * Who owns it, and the Bureau's part in it: owned (7), assisted (8), or
//     equipment co-located on somebody else's site (9).
//   * Whether it is read by a person or by a radio.
//   * How much it matters when it stops.
//
// ── The merge is not done here ───────────────────────────────────────────────
// 591 bureau numbers appear in more than one schedule and the schedules
// disagree — on priority for 55 of them, on the owner for 41, the name for 31.
// Folding them together is a rule with a reason behind it (db/README.md states
// it once), and it is applied in `tools/ingest/sls.py`, whose output this file
// reads already merged. `meganet.sls_location` is the same rule in SQL for
// anything querying the database, and `tools/check_sls_merge.py` holds the two
// together — all 2,766 locations, every field, in CI — rather than hoping.
// **Nothing in this file decides anything**; it looks up and it renders.
//
// ── The join, and the leading zeros ──────────────────────────────────────────
// The document pads bureau numbers to six digits — `040846`. `station_number`
// does not: 2,877 stations carry six digits, 1,891 carry five and 87 carry
// four. Comparing the strings as they stand finds 1,509 stations; comparing
// them with the leading zeros stripped finds 2,685, and nothing collides either
// way. That is `key()` below, and the 1,176 stations it recovers are the whole
// reason it is not `===`.
//
// ── What is deliberately not here ────────────────────────────────────────────
// 81 of the 2,766 locations are not MegaNet stations: 69 manual gauges an
// observer reads, 68 of them the Bureau's, and 12 automatic ones. They are in
// the file and they are **not** stations — nothing here invents a pin, a row or
// a count for them. A station's card shows the SLS's answer for that station
// and nothing else.
const SLS = (function () {
  const DATA_URL = 'data/sls-locations.json';
  // Where the Bureau publishes the document — always its current edition, so
  // the day it issues a newer one this link moves on and data/ does not until
  // tools/ingest/sls.py has read it. The link's title says which edition the
  // card is quoting for that reason.
  const DOC_URL = 'https://www.bom.gov.au/qld/flood/brochures/QLD_SLS_current.pdf';
  const ATTRIBUTION = 'Service Level Specification for Flood Forecasting and Warning '
                    + 'Services for Queensland v3.7 (Bureau of Meteorology, 2025)';

  let data = null;      // { meta, locations[] }
  let byKey = null;     // bureau key -> location
  let loading = null;
  let failed = false;

  // A bureau number with its leading zeros gone. The same rule as
  // meganet.bureau_key() in 0028, and it has to stay the same rule.
  function key(n) {
    const t = String(n == null ? '' : n).trim().replace(/^0+/, '');
    return t || null;
  }

  function index(doc) {
    const map = new Map();
    for (const loc of doc.locations || []) {
      const k = key(loc.bureau_number);
      if (k) map.set(k, loc);
    }
    return map;
  }

  // Fetched once, when something first asks — never at page load. 710 KB of
  // schedule is not part of opening the app, and most sessions never open a
  // station card at all.
  function ensureData() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(j => { data = j; byKey = index(j); failed = false; return j; })
      .catch(e => { failed = true; loading = null; throw e; });
    return loading;
  }

  // The SLS entry for a station, or null. Null until the file is loaded, which
  // is what state()/ask() exist to paper over.
  function forStation(s) {
    if (!byKey || !s) return null;
    return byKey.get(key(s.station_number)) || null;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  // A phrase that must not break across lines: in a 340 px card "from Peak"
  // over "> 4.5" reads as two facts. Lines break at the " · " between phrases.
  const keep = (t) => String(t).replace(/ /g, '\u00a0');

  function classesText(loc) {
    const parts = [];
    if (loc.class_minor != null)    parts.push(keep(`minor ${loc.class_minor}`));
    if (loc.class_moderate != null) parts.push(keep(`moderate ${loc.class_moderate}`));
    if (loc.class_major != null)    parts.push(keep(`major ${loc.class_major} m`));
    else if (parts.length)          parts[parts.length - 1] += '\u00a0m';
    return parts.length ? parts.join(' · ') : null;
  }

  function roleText(loc) {
    // Forecast beats information: a location somebody predicts a height for is
    // described by that, and Schedule 3 membership adds nothing to it.
    if (loc.forecast_location)    return 'Forecast location';
    if (loc.information_location) return 'Information location';
    if (loc.river_data_location)  return 'River data location';
    return null;
  }

  // The Bureau's part in the site, in the document's own terms. A site can be
  // in more than one of these — 7 and 8 are not exclusive in the file — so this
  // says all of them rather than picking.
  function bureauRole(loc) {
    const out = [];
    if (loc.bureau_owned)     out.push('Bureau-owned and maintained');
    if (loc.bureau_assists)   out.push('Bureau assists with maintenance');
    if (loc.bureau_colocated) out.push('Bureau equipment co-located');
    return out.length ? out.join(' · ') : null;
  }

  // "TBC" is the Bureau's "to be confirmed". GLENORE GROVE prints it in every
  // column of its service, and "TBC · TBC lead · from TBC · TBC" says it four
  // times without saying it once.
  function serviceText(prediction, lead, trigger, accuracy) {
    const tbc = (v) => /^tbc$/i.test(String(v || '').trim());
    const bits = [];
    if (prediction && !tbc(prediction)) bits.push(prediction);
    if (lead && !tbc(lead))             bits.push(`${lead} lead`);
    if (trigger && !tbc(trigger))       bits.push(`from ${trigger}`);
    if (accuracy && accuracy !== 'N/A' && !tbc(accuracy)) bits.push(accuracy);
    if (!bits.length && [prediction, lead, trigger, accuracy].some(tbc)) return 'To be confirmed';
    return bits.length ? bits.map(keep).join(' · ') : null;
  }

  // One line per target. A forecast location can have two — PALMVIEW is
  // warned 6 hours ahead of a peak over 4.5 m to ±0.1 m, and 18 hours ahead of
  // the river passing 4.5 m to ±0.3 m — which the schedule prints as two lines
  // of one row and sls.py keeps apart with " / ". Paired back up here, so a
  // lead time is never read against the other target's trigger. A field that
  // states one value states it for every target; fields that cannot be paired
  // are shown as the document has them, on one line.
  function serviceLines(loc) {
    const parts = (v) => (v ? String(v).split(' / ') : []);
    const lead = parts(loc.lead_time), trig = parts(loc.trigger), acc = parts(loc.peak_accuracy);
    const n = Math.max(1, lead.length, trig.length, acc.length);
    if (![lead, trig, acc].every(a => a.length <= 1 || a.length === n)) {
      const one = serviceText(loc.prediction_type, loc.lead_time, loc.trigger, loc.peak_accuracy);
      return one ? [one] : [];
    }
    const at = (a, i) => (a.length === n ? a[i] : a[0]);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = serviceText(loc.prediction_type, at(lead, i), at(trig, i), at(acc, i));
      if (t) out.push(t);
    }
    return out;
  }

  // The section's heading, and the way to the document it quotes: the
  // Bureau's own copy, in a new tab. The name starts with the words on screen
  // and says the rest (#109); the title says which edition the figures are
  // from, since the link always opens the latest. esc() and not escAttr() for
  // these attributes: they are text, not JavaScript, and escAttr's \' would
  // be read out as a backslash in "Bureau's".
  function headingHtml() {
    const meta = (data && data.meta) || {};
    const label = `Flood warning service (SLS${meta.version ? ` v${meta.version}` : ''})`;
    const quoted = meta.version
      ? ` The figures on this card are from version ${meta.version}`
        + `${meta.published ? `, ${meta.published}` : ''}.`
      : '';
    return `<span class="small txt-muted"><a class="mn-sls-doc" href="${esc(DOC_URL)}"
        target="_blank" rel="noopener"
        aria-label="${esc(`${label} — the Bureau's Service Level Specification for Queensland, a PDF, in a new tab`)}"
        title="${esc(`The Bureau of Meteorology's Service Level Specification for Flood Forecasting and Warning Services for Queensland, as the Bureau publishes it now (PDF).${quoted}`)}"
        >${esc(label)} ↗</a></span>`;
  }

  function row(label, value, extra) {
    if (!value) return '';
    return `<div class="acma-row"><span>${esc(label)}</span><span>${value}`
         + `${extra || ''}</span></div>`;
  }

  // The card block. Manual is a pill rather than a word, because it is the one
  // fact on here that changes what a person does: a gauge nobody can interrogate
  // over the radio is not a telemetry fault when it goes quiet, and 865 of the
  // locations in this document are read by hand.
  function html(loc) {
    if (!loc) return '';
    const manual = (loc.gauge_type || '').toLowerCase() === 'manual';
    return `
      <div class="stn-card-sls">
        ${headingHtml()}
        ${manual ? `<div class="acma-row"><span>Gauge</span><span><span class="mn-sls-manual"
             title="Read by a person, not telemetered. It reports nothing over the radio, so silence from it is not a fault.">Manual — read by hand</span></span></div>`
          : row('Gauge', esc(loc.gauge_type || ''))}
        ${row('Role', esc(roleText(loc) || ''))}
        ${row('Flood classes', esc(classesText(loc) || ''))}
        ${row('Prediction', serviceLines(loc)
            .map(t => `<span class="mn-sls-target">${esc(t)}</span>`).join(''))}
        ${row('SLS priority', esc(loc.priority || ''))}
        ${row('Station owner', esc(loc.owner || ''))}
        ${row('Bureau role', esc(bureauRole(loc) || ''))}
        ${row('SLS catchment', loc.catchment_name
            ? `${esc(loc.basin_no || '')} ${esc(loc.catchment_name)}` : '')}
        ${loc.source_note ? `<p class="small txt-muted mn-sls-note">The document is
           irregular here — ${esc(loc.source_note)}.</p>` : ''}
      </div>`;
  }

  // What the card renders before the file is on hand, and what replaces it.
  // Mirrors MapWind's pair for the same reason: the card is built synchronously
  // and the answer is not available yet on a first open.
  function state(s) {
    if (!s || !s.station_number) return { ready: true, html: '' };
    if (data) return { ready: true, html: html(forStation(s)) };
    if (failed) return { ready: true, html: '' };
    return { ready: false, html: '' };
  }

  // Fill an element once the file is on hand. `data-mn-sls` carries the station
  // the placeholder was rendered for and is checked before writing: a card that
  // re-rendered for a different station while the file was in flight keeps its
  // element id, and the answer to the old question must not land in the new one.
  function ask(elId, s) {
    if (data || !s || !s.station_number) return;
    const want = String(s.station_number);
    const fill = () => {
      const el = document.getElementById(elId);
      if (!el || el.dataset.mnSls !== want) return;
      el.innerHTML = html(forStation(s));
    };
    ensureData().then(fill, fill);
  }

  return {
    ATTRIBUTION,
    DOC_URL,
    key,
    forStation,
    html,
    state,
    ask,
    ensureData,

    // Everything the file knows, for anything that wants to count. Loaded or
    // not — a caller that needs it loaded awaits ensureData() first.
    all() { return (data && data.locations) || []; },
    meta() { return (data && data.meta) || null; },
    loaded() { return !!data; },
  };
})();
if (typeof window !== 'undefined') window.SLS = SLS;
