// MegaNet — river-details.js
//
//   RiverDetails   what the Bureau's Queensland flood warning station lists say
//                  about a station — which of its indexes list it, its AWRC
//                  number, stream and URBS label, its flood classification
//                  levels, the crossing its gauge is read against, the survey of
//                  the gauge itself and what each height on it means — read-only
//                  on the station card for anybody, and as three fields and five
//                  editable lists in the station editor for an editor.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc and escAttr. Two files reach into this one:
// app.js, whose stnCardHtml() places cardHtml(), and station-editor.js, whose
// editorForm() places editorHtml() and whose editorReadForm()/editorSave() call
// readForm() and formProblem(). The IIFE body declares and calls nothing, so
// this file's position among the modules is free (`npm run toplevel`).
//
// ── Where the rows come from ─────────────────────────────────────────────────
// "Queensland Flood Warning River Height Stations", Sections 1–6 and 9 and the
// URBS details, read by tools/ingest/river_height_stations.py out of
// archive/river-height-stations/ and attached by bureau number to the stations
// they describe (db/migrations/0031_river_height_details.sql and
// 0032_bureau_station_lists.sql). They are five lists on the station itself —
// `bureau_listings`, `flood_classes`, `crossings`, `gauge_survey`,
// `flood_effects` — and three fields, `awrc_number`, `stream` and `urbs_label`,
// so the card reads them off the record it already holds, and a station that is
// in none of the Bureau's lists has none of the keys.
//
// ── Which row is "the" answer ────────────────────────────────────────────────
// Every list is a history. The 2014 flood classifications sit beside the 2026
// ones, and a gauge that has been re-levelled has a row per level. The card says
// what holds now and puts the rest under "Earlier", never mixes them: the newest
// flood classification by `as_at`, and the gauge zero still in force (no
// valid_to, newest valid_from) or, failing that, the one that ended last. The
// editor shows every row, in the order they are stored, because that is what a
// save writes back.
//
// ── What a save sends ────────────────────────────────────────────────────────
// Only the lists that changed. save_station() leaves a list the document does
// not mention exactly as it is, and this is what uses that: the browser parses
// 94.50 as 94.5, so resending an untouched list would quietly rewrite every
// figure in it to fewer digits than the Bureau printed. A list whose rows read
// back from the form the same as the record's is left out of the document.

const RiverDetails = (function () {

  // meganet.crossing_type and meganet.gauge_datum, as 0031 inserts them. Two
  // copies of a legend the Bureau prints at the foot of every page, held
  // together by `npm run riverdetails` rather than by hoping: the card needs
  // the words when the datastore is not there to ask.
  const CROSSING_TYPES = [
    { code: 'B', label: 'Bridge' },
    { code: 'C', label: 'Causeway' },
    { code: 'A', label: 'Approaches' },
    { code: 'X', label: 'Crossing' },
    { code: 'R', label: 'Road' },
    { code: 'O', label: 'Old Bridge' },
    { code: 'H', label: 'Highway' },
    { code: 'F', label: 'Full Supply' },
    { code: 'W', label: 'Weir' },
    { code: 'S', label: 'Spillway' },
    { code: 'T', label: 'Highest Astronomical Tide' },
  ];
  const DATUMS = [
    { code: 'AHD',     label: 'Australian Height Datum' },
    { code: 'ASSUM',   label: 'Assumed datum' },
    { code: 'STATE',   label: 'State datum' },
    { code: 'UNKNOWN', label: 'Datum unknown' },
  ];
  // meganet.bureau_index, as 0032 inserts it: the Bureau's indexes by the
  // section number its pages print.
  const BUREAU_INDEXES = [
    { code: '1', label: 'FloodWarn rainfall' },
    { code: '2', label: 'Daily rainfall' },
    { code: '3', label: 'River height' },
  ];

  // The station's own three fields (0032), edited as plain boxes above the
  // lists. Blank is absent, the shape station_json emits.
  const FIELDS = [
    { key: 'awrc_number', id: 'ef-awrc',   label: 'AWRC number',
      hint: 'The national gauging station number; its first three digits are the basin.' },
    { key: 'stream',      id: 'ef-stream', label: 'Stream' },
    { key: 'urbs_label',  id: 'ef-urbs',   label: 'URBS label',
      hint: 'The station’s node in the Bureau’s URBS runoff-routing model.' },
  ];

  // The three lists, and the boxes each row is edited in. `kind` decides the
  // control and how its value is read back; `wide` takes a whole line of the
  // row, for the free text. The order is the order a person reads the page in.
  const LISTS = {
    bureau_listings: {
      title: 'Bureau indexes',
      one: 'Bureau index listing',
      hint: 'Which of the Bureau’s Queensland station indexes list this station — Section 1 '
          + '(FloodWarn rainfall), 2 (daily rainfall) or 3 (river height) — one row per index '
          + 'per edition, dated by <em>As at</em>.',
      fields: [
        { key: 'section', label: 'Index',  kind: 'index' },
        { key: 'as_at',   label: 'As at',  kind: 'date' },
        { key: 'note',    label: 'Note',   kind: 'text', wide: true },
      ],
    },
    flood_classes: {
      title: 'Flood classifications',
      one: 'flood classification',
      hint: 'One row per edition of the Bureau’s list, dated by <em>As at</em>. Heights are '
          + 'metres on the gauge. The newest row is what the station card shows; older ones '
          + 'are kept as history.',
      fields: [
        { key: 'as_at',             label: 'As at',                kind: 'date' },
        { key: 'first_report_m',    label: 'First report (m)',     kind: 'num' },
        { key: 'minor_m',           label: 'Minor (m)',            kind: 'num' },
        { key: 'crops_grazing_m',   label: 'Crops & grazing (m)',  kind: 'num' },
        { key: 'moderate_m',        label: 'Moderate (m)',         kind: 'num' },
        { key: 'towns_m',           label: 'Towns (m)',            kind: 'num' },
        { key: 'major_m',           label: 'Major (m)',            kind: 'num' },
        { key: 'crossing_height_m', label: 'Crossing height (m)',  kind: 'num' },
        { key: 'crossing_type',     label: 'Crossing type',        kind: 'crossing' },
        { key: 'note',              label: 'Note',                 kind: 'text', wide: true },
      ],
    },
    crossings: {
      title: 'Crossings',
      one: 'crossing',
      hint: 'The crossing the gauge is read against: the height on the gauge at which it '
          + 'goes under (or the spillway, full supply level or tide the code names).',
      fields: [
        { key: 'name',          label: 'Crossing',   kind: 'text', wide: true },
        { key: 'stream',        label: 'Stream',     kind: 'text' },
        { key: 'height_m',      label: 'Height (m)', kind: 'num' },
        { key: 'crossing_type', label: 'Type',       kind: 'crossing' },
        { key: 'as_at',         label: 'As at',      kind: 'date' },
        { key: 'note',          label: 'Note',       kind: 'text', wide: true },
      ],
    },
    gauge_survey: {
      title: 'Gauge survey',
      one: 'gauge survey',
      hint: 'The height of the gauge zero and the period it held. When a gauge is '
          + 're-levelled, give the old row a <em>To</em> date and add a row <em>From</em> that '
          + 'date. <abbr title="Adopted Middle Thread Distance">AMTD</abbr> is kilometres '
          + 'along the middle of the stream from its mouth up to the gauge; the catchment '
          + 'area is the area draining to it.',
      fields: [
        { key: 'valid_from',         label: 'From',                  kind: 'date' },
        { key: 'valid_to',           label: 'To',                    kind: 'date' },
        { key: 'gauge_zero_m',       label: 'Gauge zero (m)',        kind: 'num' },
        { key: 'datum',              label: 'Datum',                 kind: 'datum' },
        { key: 'amtd_km',            label: 'AMTD (km)',             kind: 'num' },
        { key: 'catchment_area_km2', label: 'Catchment area (km²)',  kind: 'num' },
        { key: 'note',               label: 'Note',                  kind: 'text', wide: true },
      ],
    },
    flood_effects: {
      title: 'Flood effects',
      one: 'flood effect',
      hint: 'What each height on the gauge means on the ground, as the Bureau writes it: the '
          + 'height in metres, the effect, and the detail it prints in brackets under some of '
          + 'them — which bridge, which spillway.',
      fields: [
        { key: 'height_m', label: 'Height (m)', kind: 'num' },
        { key: 'as_at',    label: 'As at',      kind: 'date' },
        { key: 'effect',   label: 'Effect',     kind: 'text', wide: true },
        { key: 'detail',   label: 'Detail',     kind: 'text', wide: true },
        { key: 'note',     label: 'Note',       kind: 'text', wide: true },
      ],
    },
  };
  const LIST_KEYS = Object.keys(LISTS);

  // ── Reading a record ──────────────────────────────────────────────────────

  const crossingLabel = code => (CROSSING_TYPES.find(t => t.code === code) || {}).label || code;
  const datumLabel    = code => (DATUMS.find(d => d.code === code) || {}).label || code;
  const indexLabel    = code => (BUREAU_INDEXES.find(i => i.code === code) || {}).label
                               || (code ? `Section ${code}` : '');

  // Newest first by one date field, undated last, and otherwise the stored
  // order. A copy — the record's own order is what the editor writes back.
  function newestFirst(rows, field) {
    return rows.map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const x = a.r[field] || '', y = b.r[field] || '';
        if (x !== y) return x ? (y ? (x < y ? 1 : -1) : -1) : 1;
        return a.i - b.i;
      })
      .map(o => o.r);
  }

  // The gauge zero that holds now: one still in force (no valid_to), newest
  // first; failing that, the one that ended last.
  function currentSurvey(rows) {
    if (!rows.length) return null;
    const open = newestFirst(rows.filter(r => !r.valid_to), 'valid_from');
    return open[0] || newestFirst(rows, 'valid_to')[0];
  }

  // The first row, newest first, that states a field — AMTD and the catchment
  // area are printed on some of a gauge's rows and not others.
  function firstStated(rows, field) {
    const r = newestFirst(rows, 'valid_from').find(x => x[field] != null);
    return r ? r[field] : null;
  }

  // ── Formatting ────────────────────────────────────────────────────────────

  // A figure padded to the decimals the Bureau prints it with, and never
  // rounded: 94.5 is shown 94.50 because every gauge zero is printed to the
  // centimetre, but a level somebody typed as 3.25 is shown 3.25, not 3.3.
  function fig(v, minDp) {
    if (v == null || v === '') return '';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const dp = (String(n).split('.')[1] || '').length;
    return n.toFixed(Math.max(dp, minDp || 0));
  }

  // dd/mm/yyyy, as the Bureau's lists write a date, straight off the ISO text
  // so no time zone can move it a day.
  function date(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  }

  function height(v, minDp) {
    return v == null ? '' : `${fig(v, minDp)} m`;
  }

  function zeroText(r) {
    if (!r || r.gauge_zero_m == null) return r && r.datum ? esc(datumLabel(r.datum)) : '';
    const h = esc(height(r.gauge_zero_m, 2));
    if (!r.datum) return h;
    return r.datum === 'AHD'
      ? `${h} <abbr title="Australian Height Datum">AHD</abbr>`
      : `${h} <span class="mn-pop-note">${esc(datumLabel(r.datum).toLowerCase())}</span>`;
  }

  // `current` because an open-ended row that is not the one in force — the
  // Bureau prints several for 37 gauges — started then, but does not still hold.
  function periodText(r, current) {
    const from = date(r.valid_from), to = date(r.valid_to);
    if (from && to && r.valid_to < r.valid_from) return `${from} – ${to}, as the list prints it (backwards)`;
    if (from && to) return `${from} – ${to}`;
    if (from) return `${current ? 'since' : 'from'} ${from}`;
    if (to) return `until ${to}`;
    return 'undated';
  }

  // "minor 2.4 · moderate 3.4 · major 4.1 m" — the three that decide a
  // warning, in the order they are reached.
  function classesText(r) {
    const parts = [];
    if (r.minor_m != null)    parts.push(`minor ${fig(r.minor_m, 1)}`);
    if (r.moderate_m != null) parts.push(`moderate ${fig(r.moderate_m, 1)}`);
    if (r.major_m != null)    parts.push(`major ${fig(r.major_m, 1)}`);
    return parts.length ? `${parts.join(' · ')} m` : '';
  }

  function crossingText(c) {
    const where = [c.name, c.stream].filter(Boolean).join(', ');
    const h = c.height_m != null ? height(c.height_m, 1) : '';
    const what = c.crossing_type ? `(${crossingLabel(c.crossing_type)})` : '';
    return [where, [h, what].filter(Boolean).join(' ')].filter(Boolean).join(' — ');
  }

  function row(label, value, title) {
    if (!value) return '';
    const t = title ? ` title="${escAttr(title)}"` : '';
    return `<div class="acma-row"><span${t}>${esc(label)}</span><span>${value}</span></div>`;
  }

  // ── The card ──────────────────────────────────────────────────────────────

  function has(s) {
    return !!s && (LIST_KEYS.some(k => Array.isArray(s[k]) && s[k].length)
                   || FIELDS.some(f => s[f.key]));
  }

  // "Bridge  Pacific Highway Bridge" — the effect, and under it in the page's
  // brackets the detail, which the card sets in the quieter note style.
  function effectHtml(e) {
    const bits = [];
    if (e.effect) bits.push(esc(e.effect));
    if (e.detail) bits.push(`<span class="mn-pop-note">${esc(e.detail)}</span>`);
    if (e.note)   bits.push(`<span class="mn-pop-note">${esc(e.note)}</span>`);
    return bits.join(' ') || '—';
  }

  // The indexes that list the station, the newest edition of each, in the
  // Bureau's section order. One date at the end when they share it.
  function listingsHtml(newest) {
    const dates = new Set(newest.map(l => l.as_at || ''));
    const one = dates.size === 1;
    const parts = newest.map(l => esc(indexLabel(l.section))
      + (!one && l.as_at ? ` <span class="mn-pop-note">${esc(date(l.as_at))}</span>` : '')
      + (l.note ? ` <span class="mn-pop-note">${esc(l.note)}</span>` : ''));
    const asAt = one && newest[0].as_at ? ` <span class="mn-pop-note">as at ${esc(date(newest[0].as_at))}</span>` : '';
    return parts.join(' · ') + asAt;
  }

  // The section on the station card. Empty for a station that is in none of
  // the Bureau's lists.
  function cardHtml(s) {
    if (!has(s)) return '';
    const floods    = newestFirst(s.flood_classes || [], 'as_at');
    const crossings = s.crossings || [];
    const surveys   = s.gauge_survey || [];
    const flood     = floods[0] || null;
    const zero      = currentSurvey(surveys);
    const rows      = [];

    // Which of the Bureau's indexes list it: the newest listing per section.
    const newest = [], older = [];
    for (const l of newestFirst(s.bureau_listings || [], 'as_at')) {
      (newest.some(n => n.section === l.section) ? older : newest).push(l);
    }
    newest.sort((a, b) => String(a.section).localeCompare(String(b.section)));
    if (newest.length) {
      rows.push(row('Bureau lists', listingsHtml(newest),
        'Which of the Bureau’s Queensland flood warning station indexes list this station — Section 1 FloodWarn rainfall, 2 daily rainfall, 3 river height'));
    }
    rows.push(row('AWRC number', esc(s.awrc_number || ''),
      'The national (Australian Water Resources Council) gauging station number — its first three digits are the basin'));
    rows.push(row('Stream', esc(s.stream || '')));
    rows.push(row('URBS label', esc(s.urbs_label || ''),
      'The station’s node in the Bureau’s URBS runoff-routing model'));

    if (flood) {
      const asAt = flood.as_at ? ` <span class="mn-pop-note">as at ${esc(date(flood.as_at))}</span>` : '';
      const cls = classesText(flood);
      rows.push(row('Flood classes', cls ? esc(cls) + asAt : asAt ? `<span class="mn-pop-note">none stated</span>${asAt}` : ''));
      rows.push(row('First report', esc(height(flood.first_report_m, 1)),
        'The height at which the gauge is first reported to the Bureau'));
      rows.push(row('Crops & grazing', esc(height(flood.crops_grazing_m, 1))));
      rows.push(row('Towns', esc(height(flood.towns_m, 1))));
      if (flood.note) rows.push(row('Note', esc(flood.note)));
    }

    // One crossing line, not two: Section 4 prints the crossing's height and
    // type and Section 5 prints them again beside its name, and for 2026 the
    // two agree on every crossing. The flood classification's own figure is
    // shown only when no crossing row says the same thing.
    for (const c of crossings) {
      const text = crossingText(c);
      rows.push(row('Crossing', esc(text) + (c.note ? ` <span class="mn-pop-note">${esc(c.note)}</span>` : '')));
    }
    const sameHeight = (a, b) => (a == null ? b == null : b != null && Number(a) === Number(b));
    if (flood && (flood.crossing_height_m != null || flood.crossing_type)
        && !crossings.some(c => sameHeight(c.height_m, flood.crossing_height_m)
                             && (c.crossing_type || '') === (flood.crossing_type || ''))) {
      rows.push(row('Crossing', esc(crossingText({
        height_m: flood.crossing_height_m, crossing_type: flood.crossing_type }))));
    }

    if (zero) {
      rows.push(row('Gauge zero', `${zeroText(zero) || '—'} <span class="mn-pop-note">${esc(periodText(zero, true))}</span>`));
      const amtd = firstStated(surveys, 'amtd_km');
      const area = firstStated(surveys, 'catchment_area_km2');
      rows.push(row('AMTD', amtd == null ? '' : esc(`${fig(amtd, 1)} km`),
        'Adopted Middle Thread Distance — kilometres along the middle of the stream from its mouth up to the gauge'));
      rows.push(row('Catchment', area == null ? '' : `${esc(Number(area).toLocaleString('en-AU', { maximumFractionDigits: 2 }))} km²`,
        'The catchment area above the gauge'));
      if (zero.note) rows.push(row('Survey note', esc(zero.note)));
    }

    // Everything that no longer holds, newest first, behind one disclosure.
    const earlier = [];
    for (const l of older) {
      earlier.push(row(indexLabel(l.section),
        `listed${l.as_at ? ` <span class="mn-pop-note">as at ${esc(date(l.as_at))}</span>` : ''}`));
    }
    for (const f of floods.slice(1)) {
      const bits = [classesText(f)];
      if (f.first_report_m != null)  bits.push(`first report ${fig(f.first_report_m, 1)} m`);
      if (f.crops_grazing_m != null) bits.push(`crops & grazing ${fig(f.crops_grazing_m, 1)} m`);
      if (f.towns_m != null)         bits.push(`towns ${fig(f.towns_m, 1)} m`);
      if (f.crossing_height_m != null || f.crossing_type) {
        bits.push(`crossing ${crossingText({ height_m: f.crossing_height_m, crossing_type: f.crossing_type })}`);
      }
      earlier.push(row(f.as_at ? date(f.as_at) : 'Undated', esc(bits.filter(Boolean).join('; ') || f.note || '—')));
    }
    for (const z of newestFirst(surveys.filter(r => r !== zero), 'valid_from')) {
      earlier.push(row('Gauge zero', `${zeroText(z) || '—'} <span class="mn-pop-note">${esc(periodText(z))}</span>`));
    }

    // What each height means, behind its own disclosure: up to thirty-odd
    // lines for a big gauge. The newest edition first, each in the page's
    // order, an older edition under its own date.
    const effects = s.flood_effects || [];
    let effectsHtml = '';
    if (effects.length) {
      const editions = new Map();
      for (const e of newestFirst(effects, 'as_at')) {
        const k = e.as_at || '';
        if (!editions.has(k)) editions.set(k, []);
        editions.get(k).push(e);
      }
      const blocks = [...editions.entries()].map(([asAt, list], i) => {
        const head = (editions.size > 1 || asAt)
          ? `<div class="small txt-muted stn-card-rhs-asat">${i ? 'Earlier — ' : ''}${asAt ? `as at ${esc(date(asAt))}` : 'undated'}</div>`
          : '';
        return head + list.map(e => row(e.height_m != null ? height(e.height_m, 2) : '—', effectHtml(e))).join('');
      });
      const n = editions.values().next().value.length;
      effectsHtml = `<details class="stn-card-rhs-effects">
          <summary class="small">Flood effects — ${n} height${n === 1 ? '' : 's'}</summary>
          ${blocks.join('')}
        </details>`;
    }

    return `
      <div class="acma-sect stn-card-rhs">
        <span class="small txt-muted stn-card-rhs-head"
              title="Queensland Flood Warning River Height Stations (Bureau of Meteorology), Sections 1–6 and 9 and the URBS details, as recorded on this station">Bureau flood warning details</span>
        ${rows.join('')}
        ${effectsHtml}
        ${earlier.length ? `<details class="stn-card-rhs-earlier">
          <summary class="small">Earlier — ${earlier.length} record${earlier.length === 1 ? '' : 's'}</summary>
          ${earlier.join('')}
        </details>` : ''}
      </div>`;
  }

  // ── The editor ────────────────────────────────────────────────────────────

  function options(list, current, placeholder) {
    const known = list.some(o => o.code === current);
    return [
      `<option value="">${esc(placeholder)}</option>`,
      // A code the pick-list does not know is still this row's value, and a
      // select that dropped it would erase it on the next save.
      ...(current && !known ? [`<option value="${escAttr(current)}" selected>${esc(current)}</option>`] : []),
      ...list.map(o => `<option value="${escAttr(o.code)}"${o.code === current ? ' selected' : ''}>${esc(o.code)} — ${esc(o.label)}</option>`),
    ].join('');
  }

  function control(f, v) {
    const val = v == null ? '' : String(v);
    if (f.kind === 'crossing') {
      return `<select data-f="${f.key}">${options(CROSSING_TYPES, val, '— none —')}</select>`;
    }
    if (f.kind === 'datum') {
      return `<select data-f="${f.key}">${options(DATUMS, val, '— none —')}</select>`;
    }
    if (f.kind === 'index') {
      return `<select data-f="${f.key}">${options(BUREAU_INDEXES, val, '— pick one —')}</select>`;
    }
    if (f.kind === 'date') {
      return `<input type="date" data-f="${f.key}" value="${escAttr(val)}">`;
    }
    if (f.kind === 'num') {
      return `<input type="number" step="any" inputmode="decimal" data-f="${f.key}" value="${escAttr(val)}">`;
    }
    return `<input type="text" data-f="${f.key}" value="${escAttr(val)}">`;
  }

  // The one line a row reads as while it is shut — what the card would say
  // about it, plain text. Kept in step with the boxes as they are typed into.
  function summaryText(list, r) {
    if (list === 'flood_classes') {
      const bits = [classesText(r)];
      if (r.crossing_height_m != null || r.crossing_type) {
        bits.push(`crossing ${crossingText({ height_m: r.crossing_height_m, crossing_type: r.crossing_type })}`);
      }
      const what = bits.filter(Boolean).join('; ') || r.note || '';
      return `${r.as_at ? date(r.as_at) : 'Undated'} — ${what || 'nothing entered yet'}`;
    }
    if (list === 'crossings') {
      return crossingText(r) || r.note || 'New crossing — nothing entered yet';
    }
    if (list === 'bureau_listings') {
      if (!r.section && !r.as_at && !r.note) return 'New listing — nothing entered yet';
      return `${r.section ? `Section ${r.section}, ${indexLabel(r.section)}` : 'No index picked'}`
           + ` — ${r.as_at ? `as at ${date(r.as_at)}` : 'undated'}`;
    }
    if (list === 'flood_effects') {
      const what = [r.effect, r.detail ? `(${r.detail})` : ''].filter(Boolean).join(' ') || r.note || '';
      if (r.height_m == null && !what) return 'New flood effect — nothing entered yet';
      return `${r.height_m != null ? `${fig(r.height_m, 2)} m` : 'No height'} — ${what || 'no effect written'}`;
    }
    const zero = r.gauge_zero_m != null
      ? `${fig(r.gauge_zero_m, 2)} m${r.datum ? ` ${r.datum === 'AHD' ? 'AHD' : datumLabel(r.datum).toLowerCase()}` : ''}`
      : (r.datum ? datumLabel(r.datum) : '');
    const any = zero || r.amtd_km != null || r.catchment_area_km2 != null || r.note;
    return any ? `${zero || 'Gauge'} — ${periodText(r, !r.valid_to)}` : 'New gauge survey — nothing entered yet';
  }

  // A row is a disclosure: shut, it is one line saying what it holds, so a
  // station with five rows is five lines to read rather than fifty boxes; open,
  // it is the boxes. A new row arrives open, with the cursor in it.
  function rowHtml(list, r, open) {
    const spec = LISTS[list];
    r = r || {};
    const backwards = list === 'gauge_survey' && r.valid_from && r.valid_to && r.valid_to < r.valid_from;
    return `
      <details class="rhs-row" data-list="${list}"${open ? ' open' : ''}
               oninput="RiverDetails.resummarise(this)" onchange="RiverDetails.resummarise(this)">
        <summary class="rhs-sum">${esc(summaryText(list, r))}</summary>
        <div class="rhs-fields">
          ${spec.fields.map(f => `<label${f.wide ? ' class="rhs-wide"' : ''}>${esc(f.label)}${control(f, r[f.key])}</label>`).join('')}
          ${backwards ? '<p class="rhs-wide small txt-warn rhs-flag">The <em>To</em> date is before the <em>From</em> date — the Bureau’s list prints it this way.</p>' : ''}
          <button type="button" class="btn-danger rhs-del" onclick="RiverDetails.removeRow(this)"
                  aria-label="Remove this ${escAttr(spec.one)}" title="Remove this ${escAttr(spec.one)}"><span aria-hidden="true">×</span></button>
        </div>
      </details>`;
  }

  function resummarise(el) {
    const row = el && el.closest('.rhs-row');
    const sum = row && row.querySelector('.rhs-sum');
    if (sum) sum.textContent = summaryText(row.dataset.list, readRow(row, row.dataset.list));
  }

  function countText(n) {
    return n ? ` <span class="small ef-plain">— ${n}</span>` : '';
  }

  // The block at the foot of the editor form, above ARRO: the three fields,
  // then one section per list, each with its rows and an add button, the way
  // the sensors are done.
  function editorHtml(s) {
    return `
      <hr>
      <h4 class="ef-h">Bureau flood warning details</h4>
      <p class="small ef-block">
        What the Bureau’s Queensland flood warning station lists say about this station, and
        anything added since. Blank means not recorded. Saved with the station.
      </p>
      <div class="form-grid rhs-station-fields">
        ${[...FIELDS].sort((a, b) => (a.key === 'stream') - (b.key === 'stream')).map(f =>
          `<label${f.key === 'stream' ? ' class="full"' : ''}${f.hint ? ` title="${escAttr(f.hint)}"` : ''}>${esc(f.label)}<input type="text" id="${f.id}" value="${escAttr((s && s[f.key]) || '')}"></label>`).join('')}
      </div>
      ${LIST_KEYS.map(list => {
        const spec = LISTS[list];
        const rows = (s && s[list]) || [];
        return `
      <div class="ef-section rhs-list" id="ef-rhs-${list}">
        <div class="ef-section-head">
          <div class="ef-sub">${esc(spec.title)}<span class="rhs-count">${countText(rows.length)}</span></div>
          <button type="button" onclick="RiverDetails.addRow('${list}')"
                  aria-label="Add a ${escAttr(spec.one)}">+ Add</button>
        </div>
        <div class="rhs-rows">${rows.map(r => rowHtml(list, r)).join('')}</div>
        <div class="small ef-note">${spec.hint}</div>
      </div>`;
      }).join('')}`;
  }

  function recount(box) {
    const n = box.querySelectorAll('.rhs-row').length;
    const el = box.querySelector('.rhs-count');
    if (el) el.innerHTML = countText(n);
  }

  // A new row goes on top: every list is newest first, and the row being added
  // is almost always the newest — the next edition, the new level.
  function addRow(list) {
    const box = document.getElementById(`ef-rhs-${list}`);
    if (!box || !LISTS[list]) return;
    const rows = box.querySelector('.rhs-rows');
    rows.insertAdjacentHTML('afterbegin', rowHtml(list, {}, true));
    recount(box);
    const first = rows.querySelector('.rhs-row .rhs-fields input, .rhs-row .rhs-fields select');
    if (first) first.focus();
  }

  // Focus goes to the list's add button, not to <body>: the button that was
  // pressed has just been removed from the page.
  function removeRow(btn) {
    const row = btn && btn.closest('.rhs-row');
    const box = row && row.closest('.rhs-list');
    if (!row || !box) return;
    row.remove();
    recount(box);
    const add = box.querySelector('.ef-section-head button');
    if (add) add.focus();
  }

  // One row as the document carries it: a key only for what the row states.
  function readRow(el, list) {
    const out = {};
    for (const f of LISTS[list].fields) {
      const c = el.querySelector(`[data-f="${f.key}"]`);
      const raw = c ? String(c.value).trim() : '';
      if (raw === '') continue;
      out[f.key] = f.kind === 'num' ? Number(raw) : raw;
    }
    return out;
  }

  // What a row says, as the save would send it — so an untouched list compares
  // equal to the record it was drawn from, and a blank row is not a row.
  function normalise(rows, list) {
    return (rows || []).map(r => {
      const out = {};
      for (const f of LISTS[list].fields) {
        const v = r[f.key];
        if (v == null || String(v).trim() === '') continue;
        out[f.key] = f.kind === 'num' ? Number(v) : String(v).trim();
      }
      return out;
    }).filter(r => Object.keys(r).some(k => !['as_at', 'valid_from', 'valid_to'].includes(k)));
  }

  // The lists the form has changed, keyed as the document keys them. A list
  // that reads back the same as `record` is not in the answer, and so is not in
  // the document the save sends — see the head of this file.
  function readForm(record) {
    const out = {};
    for (const list of LIST_KEYS) {
      const box = document.getElementById(`ef-rhs-${list}`);
      if (!box) continue;
      const rows = normalise([...box.querySelectorAll('.rhs-row')].map(el => readRow(el, list)), list);
      const before = normalise((record && record[list]) || [], list);
      if (JSON.stringify(rows) !== JSON.stringify(before)) out[list] = rows;
    }
    return out;
  }

  // The three fields onto the document the save sends: set where the box says
  // something, gone where it is blank — the shape station_json emits, so a save
  // that set nothing round-trips without gaining a key.
  function applyFields(d) {
    for (const f of FIELDS) {
      const el = document.getElementById(f.id);
      if (!el) continue;
      const v = String(el.value).trim();
      if (v) d[f.key] = v; else delete d[f.key];
    }
    return d;
  }

  // A box the browser could not read — "3,5" in a number field, half a date —
  // reads back as empty, and saving would quietly drop the figure. Named here,
  // before the save, rather than lost.
  function formProblem() {
    for (const list of LIST_KEYS) {
      const box = document.getElementById(`ef-rhs-${list}`);
      if (!box) continue;
      const rows = [...box.querySelectorAll('.rhs-row')];
      for (let i = 0; i < rows.length; i++) {
        for (const f of LISTS[list].fields) {
          const c = rows[i].querySelector(`[data-f="${f.key}"]`);
          if (c && c.validity && c.validity.badInput) {
            rows[i].open = true;
            return `${LISTS[list].title}, row ${i + 1}: “${f.label}” is not a ${f.kind === 'date' ? 'whole date' : 'number'}. `
                 + 'Nothing was saved — correct it or clear it and save again.';
          }
        }
      }
    }
    return null;
  }

  return {
    CROSSING_TYPES,
    DATUMS,
    BUREAU_INDEXES,
    FIELD_KEYS: FIELDS.map(f => f.key),
    LIST_KEYS,
    has,
    cardHtml,
    editorHtml,
    addRow,
    removeRow,
    resummarise,
    readForm,
    applyFields,
    formProblem,
    currentSurvey,
    newestFirst,
  };
})();
if (typeof window !== 'undefined') window.RiverDetails = RiverDetails;
