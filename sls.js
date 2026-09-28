// MegaNet — sls.js
//
//   SLS   What the Bureau's Service Level Specifications say about a station:
//         its flood class levels, whether anybody forecasts for it, who owns
//         it, and whether a person reads it or a radio does.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for `esc`/`escAttr`; only from inside its own
// functions, so this file's position among the modules is free.
//
// ── What this is ─────────────────────────────────────────────────────────────
// The Bureau writes one "Service Level Specification for Flood Forecasting and
// Warning Services" per state, and the network reaches two:
//
//   QLD  `archive/QLD_SLS_current.pdf`, version 3.7, December 2025.
//   NSW  `archive/NSW_SLS_Current.pdf` — New South Wales and the Australian
//        Capital Territory — version 3.16, December 2025.
//
// The Bureau's own copy of each is at its `url` in the file's `documents`, and
// the card's heading links to it. Six schedules of each are tables of stations
// keyed on the bureau number — the same number `station_number` carries.
// `tools/ingest/sls.py` reads them into `data/sls-locations.json`, and this
// reads that.
//
// It answers questions the app has never been able to answer about a station:
//
//   * The flood class levels — the minor, moderate and major heights that
//     decide which warning goes out. 1,282 of these locations have them; the
//     NSW document also says which it has not defined yet, and whether the
//     gauge reads in metres AHD or on its own local datum.
//   * Whether it is a **forecast** location (Schedule 2 — somebody predicts a
//     height for it) or an **information** location (Schedule 3, NSW's 3a — it
//     is reported and classified but not predicted).
//   * The prediction type, the target warning lead time and the trigger — two
//     or three of each for the stations the schedule gives more than one
//     target.
//   * Who owns it, and the Bureau's part in it: owned, assisted, or equipment
//     co-located on somebody else's site.
//   * Whether it is read by a person or by a radio.
//   * How much it matters when it stops.
//
// ── The merge is not done here ───────────────────────────────────────────────
// Within a document, 647 bureau numbers appear in more than one schedule
// (591 Queensland, 56 NSW) and the schedules disagree — on priority for 80 of
// them, on the owner for 66. Folding them together is a rule with a reason
// behind it (db/README.md states it once), and it is applied in
// `tools/ingest/sls.py`, whose output this file reads already merged.
// `meganet.sls_location` is the same rule in SQL for anything querying the
// database, and `tools/check_sls_merge.py` holds the two together — all 4,141
// locations, every field, in CI — rather than hoping. **Nothing in this file
// decides anything**; it looks up and it renders.
//
// ── Two documents, one station ───────────────────────────────────────────────
// 47 stations are in both documents — all on the Queensland border, 45 of them
// in the Border Rivers basin — and the documents do not agree about them:
// GOONDIWINDI's moderate and major levels are 7.5 and 9.2 m in Queensland's
// and 6.0 and 8.5 m in the NSW one. Each is the Bureau's statement of a
// different state's service and neither overrules the other, so the card
// shows both, each under its own heading.
// forStation() answers with one of them, for the things that want one answer
// (the SLS catchment column, the twin's gauge): the more specific statement
// of service — a forecast location before a river data location — and between
// equals, Queensland's, the document the network was first read against.
//
// ── The join, and the leading zeros ──────────────────────────────────────────
// The file pads bureau numbers to six digits — `040846`. `station_number`
// does not: 2,877 stations carry six digits, 1,891 carry five and 87 carry
// four. Comparing the strings as they stand finds 1,779 stations; comparing
// them with the leading zeros stripped finds 3,253, and nothing collides
// either way. That is `key()` below, and the 1,474 stations it recovers are
// the whole reason it is not `===`.
//
// ── What is deliberately not here ────────────────────────────────────────────
// 841 of the 4,141 locations are not MegaNet stations: 81 in Queensland's
// document (69 manual gauges an observer reads, 68 of them the Bureau's, and
// 12 automatic ones) and 760 in the NSW one, whose network MegaNet reaches
// only on the North Coast and the border rivers. They are in the file and they
// are **not** stations — nothing here invents a pin, a row or a count for
// them. A station's card shows the SLS's answer for that station and nothing
// else.
const SLS = (function () {
  const DATA_URL = 'data/sls-locations.json';
  // Where the Bureau publishes each document — always its current edition, so
  // the day it issues a newer one the link moves on and data/ does not until
  // tools/ingest/sls.py has read it. The link's title says which edition the
  // card is quoting for that reason. The file carries these too (its
  // `documents`); these are what the card falls back on without them.
  const DOCS = {
    QLD: { place: 'Queensland',
           url: 'https://www.bom.gov.au/qld/flood/brochures/QLD_SLS_current.pdf' },
    NSW: { place: 'New South Wales and the Australian Capital Territory',
           url: 'https://www.bom.gov.au/nsw/NSW_SLS_Current.pdf' },
  };
  // Between two documents' equally specific entries, the earlier here first.
  const DOC_ORDER = ['QLD', 'NSW'];
  // Most specific statement of service first.
  const ROLE_ORDER = ['forecast_location', 'information_location', 'river_data_location',
                      'bureau_owned', 'bureau_assists', 'bureau_colocated'];

  let data = null;      // { meta, documents, locations[] }
  let byKey = null;     // bureau key -> [location, …], the one to quote first
  let loading = null;
  let failed = false;

  // A bureau number with its leading zeros gone. The same rule as
  // meganet.bureau_key() in 0028, and it has to stay the same rule.
  function key(n) {
    const t = String(n == null ? '' : n).trim().replace(/^0+/, '');
    return t || null;
  }

  function rank(loc) {
    const r = ROLE_ORDER.findIndex(f => loc[f]);
    const d = DOC_ORDER.indexOf(loc.jurisdiction);
    return (r < 0 ? ROLE_ORDER.length : r) * 10 + (d < 0 ? DOC_ORDER.length : d);
  }

  function index(doc) {
    const map = new Map();
    for (const loc of doc.locations || []) {
      const k = key(loc.bureau_number);
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(loc);
    }
    for (const list of map.values()) list.sort((a, b) => rank(a) - rank(b));
    return map;
  }

  // Fetched once, when something first asks — never at page load. 1.2 MB of
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

  // Every document's entry for a station, the one to quote first first; empty
  // until the file is loaded, which is what state()/ask() exist to paper over.
  function entriesFor(s) {
    if (!byKey || !s) return [];
    return byKey.get(key(s.station_number)) || [];
  }

  // The one entry to quote for a station, or null.
  function forStation(s) {
    return entriesFor(s)[0] || null;
  }

  // A document's edition and where the Bureau publishes it: the file's word
  // where it has one, the fallback above where it does not.
  function docOf(jurisdiction) {
    const j = jurisdiction || 'QLD';
    const fromFile = (data && data.documents && data.documents[j]) || {};
    return { jurisdiction: j, ...(DOCS[j] || {}), ...fromFile };
  }

  function attribution(jurisdiction) {
    const d = docOf(jurisdiction);
    return `Service Level Specification for Flood Forecasting and Warning Services for ${d.place}`
         + `${d.version ? ` v${d.version}` : ''} (Bureau of Meteorology${d.published ? `, ${String(d.published).slice(-4)}` : ''})`;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  // A phrase that must not break across lines: in a 340 px card "from Peak"
  // over "> 4.5" reads as two facts. Lines break at the " · " between phrases.
  const keep = (t) => String(t).replace(/ /g, '\u00a0');

  // The classes the document states, in metres of the gauge's datum — AHD
  // where the NSW document says the gauge reads AHD — and then the ones it
  // says have not been defined yet, which is not the same as not saying.
  function classesText(loc) {
    const parts = [];
    const unit = loc.gauge_datum === 'AHD' ? '\u00a0m\u00a0AHD' : '\u00a0m';
    if (loc.class_minor != null)    parts.push(keep(`minor ${loc.class_minor}`));
    if (loc.class_moderate != null) parts.push(keep(`moderate ${loc.class_moderate}`));
    if (loc.class_major != null)    parts.push(keep(`major ${loc.class_major}`));
    if (parts.length) parts[parts.length - 1] += unit;
    for (const c of loc.classes_undefined || []) parts.push(keep(`${c} not yet defined`));
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
    if (accuracy && !/^n\/a$/i.test(accuracy) && !tbc(accuracy)) bits.push(accuracy);
    if (!bits.length && [prediction, lead, trigger, accuracy].some(tbc)) return 'To be confirmed';
    return bits.length ? bits.map(keep).join(' · ') : null;
  }

  // One line per target. A forecast location can have more than one — PALMVIEW
  // is warned 6 hours ahead of a peak over 4.5 m to ±0.1 m, and 18 hours ahead
  // of the river passing 4.5 m to ±0.3 m; WAGGA WAGGA 12, 24 and 30 hours ahead
  // of 7.3, 9.0 and 9.6 m — which sls.py keeps apart with " / ". Paired back up
  // here, so a lead time is never read against another target's trigger. A
  // field that states one value states it for every target; fields that cannot
  // be paired are shown as the document has them, on one line.
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
  // from, since the link always opens the latest. It names the state, because
  // a station on the border has a section from each. esc() and not escAttr()
  // for these attributes: they are text, not JavaScript, and escAttr's \'
  // would be read out as a backslash in "Bureau's".
  function headingHtml(loc) {
    const d = docOf(loc.jurisdiction);
    const label = `Flood warning service (${d.jurisdiction} SLS${d.version ? ` v${d.version}` : ''})`;
    const quoted = d.version
      ? ` The figures on this card are from version ${d.version}`
        + `${d.published ? `, ${d.published}` : ''}.`
      : '';
    return `<span class="small txt-muted"><a class="mn-sls-doc" href="${esc(d.url || '')}"
        target="_blank" rel="noopener" data-jurisdiction="${esc(d.jurisdiction)}"
        aria-label="${esc(`${label} — the Bureau's Service Level Specification for ${d.place}, a PDF, in a new tab`)}"
        title="${esc(`The Bureau of Meteorology's Service Level Specification for Flood Forecasting and Warning Services for ${d.place}, as the Bureau publishes it now (PDF).${quoted}`)}"
        >${esc(label)} ↗</a></span>`;
  }

  function row(label, value, extra) {
    if (!value) return '';
    return `<div class="acma-row"><span>${esc(label)}</span><span>${value}`
         + `${extra || ''}</span></div>`;
  }

  // What the gauge's heights are metres of, where the document says (NSW).
  function datumHtml(loc) {
    if (!loc.gauge_datum) return '';
    const ahd = loc.gauge_datum === 'AHD';
    return `<span title="${esc(ahd
      ? 'The gauge reads in metres AHD (the Australian Height Datum), so its flood class levels and triggers are heights above mean sea level.'
      : 'The gauge reads in metres above its own local zero, so its flood class levels and triggers are heights on the gauge, not AHD.')}"
      >${esc(ahd ? 'AHD' : 'Local')}</span>`;
  }

  // The card block for one document's entry. Manual is a pill rather than a
  // word, because it is the one fact on here that changes what a person does:
  // a gauge nobody can interrogate over the radio is not a telemetry fault when
  // it goes quiet, and 902 of the locations in these documents are read by
  // hand.
  function html(loc) {
    if (!loc) return '';
    const manual = (loc.gauge_type || '').toLowerCase() === 'manual';
    const role = roleText(loc);
    const fast = loc.fast_response
      ? `<span class="mn-sls-mark" title="The document marks this location ^: forecasts are provided for small catchments with faster response times."
           >small catchment, fast response</span>` : '';
    const interim = loc.interim_service
      ? `<span class="mn-sls-target mn-sls-mark" title="The document marks this service *: an interim service while the Bureau develops improved forecasting tools. There is no determined lead time; best efforts are made to give one."
           >Interim service — no set lead time</span>` : '';
    return `
      <div class="stn-card-sls" data-jurisdiction="${esc(loc.jurisdiction || '')}">
        ${headingHtml(loc)}
        ${manual ? `<div class="acma-row"><span>Gauge</span><span><span class="mn-sls-manual"
             title="Read by a person, not telemetered. It reports nothing over the radio, so silence from it is not a fault.">Manual — read by hand</span></span></div>`
          : row('Gauge', esc(loc.gauge_type || ''))}
        ${row('Role', role ? `${esc(role)}${fast ? ` · ${fast}` : ''}` : fast)}
        ${row('Flood classes', esc(classesText(loc) || ''))}
        ${row('Gauge datum', datumHtml(loc))}
        ${row('Prediction', serviceLines(loc)
            .map(t => `<span class="mn-sls-target">${esc(t)}</span>`).join('') + interim)}
        ${row('SLS priority', esc(loc.priority || ''))}
        ${row('Station owner', esc(loc.owner || ''))}
        ${row('Bureau role', esc(bureauRole(loc) || ''))}
        ${row('AWRC number', esc(loc.awrc_number || ''))}
        ${row('SLS catchment', loc.catchment_name
            ? `${esc(loc.basin_no || '')} ${esc(loc.catchment_name)}` : '')}
        ${loc.source_note ? `<p class="small txt-muted mn-sls-note">The document is
           irregular here — ${esc(loc.source_note)}.</p>` : ''}
      </div>`;
  }

  // Every document's block for a station: nothing for one no document lists.
  function htmlFor(s) {
    return entriesFor(s).map(html).join('');
  }

  // What the card renders before the file is on hand, and what replaces it.
  // Mirrors MapWind's pair for the same reason: the card is built synchronously
  // and the answer is not available yet on a first open.
  function state(s) {
    if (!s || !s.station_number) return { ready: true, html: '' };
    if (data) return { ready: true, html: htmlFor(s) };
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
      el.innerHTML = htmlFor(s);
    };
    ensureData().then(fill, fill);
  }

  return {
    DOCS,
    key,
    forStation,
    entriesFor,
    docOf,
    attribution,
    html,
    htmlFor,
    state,
    ask,
    ensureData,

    // Everything the file knows, for anything that wants to count. Loaded or
    // not — a caller that needs it loaded awaits ensureData() first.
    all() { return (data && data.locations) || []; },
    meta() { return (data && data.meta) || null; },
    documents() { return (data && data.documents) || null; },
    loaded() { return !!data; },
  };
})();
if (typeof window !== 'undefined') window.SLS = SLS;
