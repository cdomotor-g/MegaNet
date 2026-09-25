// MegaNet — river-details.js
//
//   RiverDetails   what the Bureau's Queensland flood warning station lists say
//                  about a station — which of its indexes list it, its AWRC
//                  number, stream and URBS label, its flood classification
//                  levels, the crossing its gauge is read against, the survey of
//                  the gauge itself and what each height on it means — and the
//                  modelled AEP flood levels at it (0033), with the indicative
//                  flood velocity flood-velocity.js works out from them:
//                  read-only on the station card for anybody, and as three
//                  fields and six editable lists in the station editor for an
//                  editor.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for esc, escAttr and acmaHaversineKm, and across to
// flood-velocity.js for FloodVelocity. Two files reach into this one: app.js,
// whose stnCardHtml() places cardHtml(), aepCardHtml() and velocityRowHtml(),
// and station-editor.js, whose
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
// The sixth list, `aep_levels`, is not the Bureau's: two workbooks of modelled
// flood levels at flood warning stations in Queensland and New South Wales,
// read by tools/ingest/aep_levels.py out of archive/aep-levels/ (0033). Its own
// section on the card, flagged indicative, because it is a model talking.
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
    // The AEP flood levels (0033). Setting, slope and Manning n are the
    // velocity's assumptions (flood-velocity.js); `content` is what makes a row a
    // row, the same list 0033's check constraint names — a row with only a
    // source, a position or the sheet's scores is a blank line.
    aep_levels: {
      title: 'AEP flood levels',
      one: 'AEP flood level row',
      hint: 'The modelled water level at the station in four floods, in metres AHD — indicative, '
          + 'not observed. 1% <abbr title="annual exceedance probability">AEP</abbr> is about a '
          + '1-in-100 chance in any year; 0.066% about 1 in 1,500. <em>Setting</em>, <em>Manning n</em> '
          + 'and <em>Slope</em> are what the flood velocity on the station card assumes: blank uses '
          + 'its defaults, and the card says which it used.',
      content: ['ground_m', 'aep_1_m', 'aep_0_5_m', 'aep_0_2_m', 'aep_0_066_m',
                'setting', 'slope', 'manning_n', 'note'],
      fields: [
        { key: 'as_at',            label: 'As at',              kind: 'date' },
        { key: 'source',           label: 'Source',             kind: 'text', wide: true },
        { key: 'aep_1_m',          label: '1% AEP (m AHD)',     kind: 'num' },
        { key: 'aep_0_5_m',        label: '0.5% AEP (m AHD)',   kind: 'num' },
        { key: 'aep_0_2_m',        label: '0.2% AEP (m AHD)',   kind: 'num' },
        { key: 'aep_0_066_m',      label: '0.066% AEP (m AHD)', kind: 'num' },
        { key: 'ground_m',         label: 'Ground (m AHD)',     kind: 'num' },
        { key: 'point_lat',        label: 'Latitude',           kind: 'num' },
        { key: 'point_lon',        label: 'Longitude',          kind: 'num' },
        { key: 'data_quality',     label: 'Data quality',       kind: 'score', max: 3 },
        { key: 'level_difference', label: 'Level difference',   kind: 'score', max: 3 },
        { key: 'confidence',       label: 'Confidence',         kind: 'score', max: 9 },
        { key: 'setting',          label: 'Setting',            kind: 'setting' },
        { key: 'manning_n',        label: 'Manning n',          kind: 'num' },
        { key: 'slope',            label: 'Slope (m/m)',        kind: 'num' },
        { key: 'slope_basis',      label: 'Slope from',         kind: 'text', wide: true },
        { key: 'note',             label: 'Note',               kind: 'text', wide: true },
      ],
    },
  };
  const LIST_KEYS = Object.keys(LISTS);
  // The kinds a row reads back as a number.
  const NUMERIC = new Set(['num', 'score']);
  const SETTING_OPTIONS = [
    { code: 'channel',    label: 'in the channel' },
    { code: 'floodplain', label: 'on the floodplain' },
  ];


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

  // The three levels that decide a warning, in the order they are reached, and
  // the colour each is written in on the card: green, yellow, red. The colours
  // are tokens (--flood-minor/-moderate/-major, styles.css) so the dark theme
  // can lift them, and the light theme's yellow is a dark one — pure yellow on
  // a white card is 1.07:1 and cannot be read.
  const CLASS_LEVELS = [
    { key: 'minor_m',    label: 'Minor',    cls: 'rhs-minor' },
    { key: 'moderate_m', label: 'Moderate', cls: 'rhs-moderate' },
    { key: 'major_m',    label: 'Major',    cls: 'rhs-major' },
  ];

  // When the lists on the card were taken from the Bureau's hydrological
  // database, as the operator dates it — said under the section's heading.
  const SNAPSHOT = 'Hdb snapshot 26/9/26';

  // The newest edition's three levels, one to a line and each in its colour,
  // the way the AlertID block lists addresses — a level is looked for by name,
  // and three on one line had to be read left to right to find the one wanted.
  function classesBlock(r) {
    const asAt = r.as_at ? ` <span class="mn-pop-note">as at ${esc(date(r.as_at))}</span>` : '';
    const lines = CLASS_LEVELS.filter(c => r[c.key] != null).map(c =>
      `<span class="mn-pop-line mn-pop-indent ${c.cls}">${c.label} ${esc(height(r[c.key], 1))}</span>`);
    if (!lines.length && !asAt) return '';
    return `<div class="stn-card-ids stn-card-rhs-classes"><span class="small txt-muted">Flood classes</span>${asAt}<br>${
      lines.length ? lines.join('<br>') : '<span class="mn-pop-line mn-pop-indent mn-pop-note">none stated</span>'}</div>`;
  }

  // The same three inline, for an earlier edition's one line: coloured, but
  // not given a line each — that would make "Earlier" longer than "now".
  function classesInline(r) {
    const parts = CLASS_LEVELS.filter(c => r[c.key] != null).map(c =>
      `<span class="${c.cls}">${c.label.toLowerCase()} ${esc(fig(r[c.key], 1))}</span>`);
    return parts.length ? `${parts.join(' · ')} m` : '';
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

  // The Bureau's lists — everything but the AEP levels, which are a model's
  // and have a section of their own.
  const BUREAU_KEYS = LIST_KEYS.filter(k => k !== 'aep_levels');

  function has(s) {
    return !!s && (BUREAU_KEYS.some(k => Array.isArray(s[k]) && s[k].length)
                   || FIELDS.some(f => s[f.key]));
  }

  function hasAep(s) {
    return !!s && Array.isArray(s.aep_levels) && s.aep_levels.length > 0;
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
      rows.push(classesBlock(flood));
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
      const bits = [];
      if (f.first_report_m != null)  bits.push(`first report ${fig(f.first_report_m, 1)} m`);
      if (f.crops_grazing_m != null) bits.push(`crops & grazing ${fig(f.crops_grazing_m, 1)} m`);
      if (f.towns_m != null)         bits.push(`towns ${fig(f.towns_m, 1)} m`);
      if (f.crossing_height_m != null || f.crossing_type) {
        bits.push(`crossing ${crossingText({ height_m: f.crossing_height_m, crossing_type: f.crossing_type })}`);
      }
      const text = [classesInline(f), ...bits.map(esc)].filter(Boolean).join('; ');
      earlier.push(row(f.as_at ? date(f.as_at) : 'Undated', text || esc(f.note || '—')));
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
        <span class="stn-card-rhs-snap mn-pop-note">${esc(SNAPSHOT)}</span>
        ${rows.join('')}
        ${effectsHtml}
        ${earlier.length ? `<details class="stn-card-rhs-earlier">
          <summary class="small">Earlier — ${earlier.length} record${earlier.length === 1 ? '' : 's'}</summary>
          ${earlier.join('')}
        </details>` : ''}
      </div>`;
  }

  // ── The AEP flood levels and the flood velocity (0033) ────────────────────

  const oneIn = n => `about a 1-in-${n.toLocaleString('en-AU')} chance in any year`;

  // "≈ 2.4 m/s channel · 1.1 floodplain": one figure per setting worked out,
  // each the fastest of its levels.
  function velocityText(est) {
    if (est.settings.every(t => !(t.max.v > 0))) return '';
    if (est.settings.length === 1) return `≈ ${FloodVelocity.speed(est.settings[0].max.v)} m/s`;
    return est.settings.map((t, i) => `${i ? '' : '≈ '}${FloodVelocity.speed(t.max.v)}${i ? '' : ' m/s'} ${t.short}`)
      .join(' · ');
  }

  // The same figure as plain text, for the read-only box beside the wind region
  // in the station editor.
  function velocitySummary(s) {
    const est = FloodVelocity.estimate(s);
    if (!est) return hasAep(s) ? 'not estimated — no level over the ground' : 'not estimated — no AEP levels';
    const text = velocityText(est) || 'none — no depth';
    return `${text}${est.recorded ? ` (${est.recorded})` : ''} — indicative`;
  }

  // The flood velocity line for the top of the station card, beside the wind
  // region: the other environmental load on a site's structures, and flagged
  // the same way. Empty where there is nothing to work from.
  function velocityRowHtml(s) {
    const est = FloodVelocity.estimate(s);
    if (!est) return '';
    const text = velocityText(est);
    const rarest = est.settings[0].max;
    const title = text
      ? `Estimated peak flood velocity at the station in the rarest flood the AEP sheet gives a level for `
        + `(${rarest.label} AEP, ${oneIn(rarest.oneIn)}), by Manning’s equation. `
        + (est.recorded ? `The station is recorded as ${est.recorded === 'channel' ? 'in the channel' : 'on the floodplain'}. `
                        : 'Nobody has said whether the station is in the channel or on the floodplain, so both are given. ')
        + 'The workings are under “Flood levels (AEP)” below.'
      : 'Every AEP level the sheet gives is at or below the ground, so there is no flow to estimate.';
    const note = est.recorded ? `${est.recorded} · indicative` : 'indicative';
    const fast = est.settings.some(t => t.fast)
      ? ` <span class="txt-warn" title="Above ${FloodVelocity.FAST} m/s — faster than most measured floods. Check the slope and the depth under “Flood levels (AEP)”.">⚠</span>` : '';
    return `<div class="acma-row stn-card-vel"><span>Flood velocity</span><span title="${escAttr(title)}">${
      text ? esc(text) : '<span class="mn-pop-note">none — no depth</span>'}${fast} <span class="mn-pop-note">${esc(note)}</span></span></div>`;
  }

  // A line per flood, the ones the sheet gives no level for included: that it
  // gives none is itself something the sheet says.
  function levelRows(a) {
    const ground = a.ground_m != null ? Number(a.ground_m) : null;
    return FloodVelocity.LEVELS.map(l => {
      if (a[l.key] == null) {
        return row(`${l.label} AEP`, '<span class="mn-pop-note">no level given</span>',
          `${oneIn(l.oneIn)}. The sheet gives no level here — the modelled flood may not reach the point in this event, or the point may be outside the model.`);
      }
      const over = ground != null ? Number(a[l.key]) - ground : null;
      return row(`${l.label} AEP`,
        `${esc(`${fig(a[l.key], 2)} m AHD`)}${over != null
          ? ` <span class="mn-pop-note">${esc(over.toFixed(1))} m over the ground</span>` : ''}`,
        oneIn(l.oneIn));
    }).join('');
  }

  // One line per setting worked out, the rarest flood's figure first and the
  // 1% flood's after it when the two differ.
  function velocityBlock(est) {
    const lines = est.settings.map(t => {
      const first = t.levels[0];
      const tail = t.max !== first && first.v > 0
        ? `, ${FloodVelocity.speed(first.v)} at ${first.label}` : '';
      const fast = t.fast ? ' <span class="txt-warn">— above 5 m/s: check the slope and depth</span>' : '';
      const name = t.key === 'channel' ? 'Channel' : 'Floodplain';
      return `<span class="mn-pop-line mn-pop-indent">${name}${est.recorded ? ' (recorded)' : ''}: `
        + `≈ ${esc(FloodVelocity.speed(t.max.v))} m/s at ${esc(t.max.label)} AEP${esc(tail)}${fast}</span>`;
    });
    return `<div class="stn-card-ids stn-card-aep-vel"><span class="small txt-muted">Flood velocity</span>`
      + ` <span class="mn-pop-note">indicative</span><br>${lines.join('<br>')}</div>`;
  }

  // The workings, as sentences rather than label/value rows: they are read,
  // not scanned, and a right-aligned paragraph is hard to read.
  function workings(est) {
    const sl = est.slope;
    const bounded = sl.bounded
      ? ` — read as ${FloodVelocity.slopeRatio(sl.used)}, the ${sl.used === FloodVelocity.SLOPE_MIN ? 'flattest' : 'steepest'} this uses`
      : '';
    const line = (label, html) => `<p class="stn-card-aep-line"><span class="txt-muted">${esc(label)}</span> ${html}</p>`;
    const lines = [
      line('Method', esc('Manning’s equation, V = (1/n)·R^⅔·S^½, with R taken as the depth (a flood wide against its depth), '
        + 'and V held to critical flow.')),
      line('Slope', `${esc(FloodVelocity.slopeRatio(sl.raw))}${sl.source === 'default' ? ' (assumed)' : ''} — ${esc(sl.basis + bounded)}.`),
    ];
    for (const t of est.settings) {
      const ds = t.levels.map(l => Math.max(0, l.depth));
      const lo = Math.min(...ds), hi = Math.max(...ds);
      const depth = lo.toFixed(1) === hi.toFixed(1) ? `${hi.toFixed(1)} m` : `${lo.toFixed(1)}–${hi.toFixed(1)} m`;
      lines.push(line(t.key === 'channel' ? 'Channel' : 'Floodplain',
        esc(`n ${t.n.toFixed(3)}${t.nSource === 'entered' ? ' (entered)' : ''}; bed ${fig(t.bed, 2)} m AHD, `
          + `${t.bedBasis}; ${depth} deep across the levels given.`)
        + (t.levels.some(l => l.capped) ? ' Held to critical flow.' : '')));
    }
    if (est.storage) {
      lines.push(line('Storage', 'A dam or headwater gauge: its gauge zero is not taken as a bed, and water a structure holds has little velocity to speak of.'));
    }
    if (!est.recorded) {
      lines.push(line('Setting', 'Not recorded, so both are given. Set it on the AEP row in the station editor to keep one.'));
    }
    return `<details class="stn-card-rhs-earlier stn-card-aep-how">
          <summary class="small">How the velocity is worked out</summary>
          ${lines.join('')}
        </details>`;
  }

  // The section on the station card: the newest AEP row's levels, the ground
  // they are measured over, the sheet's own confidence, and the velocity with
  // its workings behind a disclosure. Empty for a station neither sheet names.
  function aepCardHtml(s) {
    if (!hasAep(s)) return '';
    const a = FloodVelocity.pickRow(s);
    const est = FloodVelocity.estimate(s);
    const rows = [levelRows(a)];
    rows.push(row('Ground', a.ground_m != null
      ? `${esc(`${fig(a.ground_m, 2)} m AHD`)} <span class="mn-pop-note">the sheet’s, at its point</span>` : '',
      'Elevation (mAHD) as the sheet gives it: the ground the levels are measured over'));
    if (a.confidence != null) {
      const parts = [];
      if (a.data_quality != null) parts.push(`data quality ${a.data_quality} of 3`);
      if (a.level_difference != null) parts.push(`level difference ${a.level_difference} of 3`);
      rows.push(row('Confidence', `${esc(`${a.confidence} of 9`)}${parts.length
        ? ` <span class="mn-pop-note">${esc(parts.join(', '))}</span>` : ''}`,
        'The sheet’s own 1% AEP confidence score: its data source quality times its water level difference score. Higher is better.'));
    }
    if (a.point_lat != null && a.point_lon != null && s.lat != null && s.lon != null) {
      const km = acmaHaversineKm(Number(s.lat), Number(s.lon), Number(a.point_lat), Number(a.point_lon));
      if (km > 0.25) {
        rows.push(row('Position', `<span class="txt-warn">${esc(`The sheet places this station ${km < 10 ? km.toFixed(1) : Math.round(km)} km from its position here`)}</span>`
          + ' <span class="mn-pop-note">— the levels are for the sheet’s point</span>'));
      }
    }
    if (a.note) rows.push(row('Note', esc(a.note)));
    const others = (s.aep_levels || []).filter(r => r !== a);
    const src = [a.source, a.as_at ? `supplied ${date(a.as_at)}` : ''].filter(Boolean).join(', ');
    return `
      <div class="acma-sect stn-card-aep">
        <span class="small txt-muted stn-card-rhs-head"
              title="Modelled water levels at the station in the 1%, 0.5%, 0.2% and 0.066% annual exceedance probability floods, in metres AHD">Flood levels (AEP)</span>
        <span class="stn-card-rhs-snap mn-pop-note">Modelled — indicative${src ? ` · ${esc(src)}` : ''}</span>
        ${rows.join('')}
        ${est ? velocityBlock(est) + workings(est) : ''}
        ${others.length ? `<details class="stn-card-rhs-earlier">
          <summary class="small">Other sheets — ${others.length}</summary>
          ${others.map(r => row(r.as_at ? date(r.as_at) : 'Undated', esc(summaryText('aep_levels', r)))).join('')}
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
    if (f.kind === 'setting') {
      return `<select data-f="${f.key}">${options(SETTING_OPTIONS, val, '— not said: both —')}</select>`;
    }
    if (f.kind === 'score') {
      const scores = Array.from({ length: f.max }, (_, i) => ({ code: String(i + 1), label: `of ${f.max}` }));
      return `<select data-f="${f.key}">${options(scores, val, '— none —')}</select>`;
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
    if (list === 'aep_levels') {
      const lv = FloodVelocity.LEVELS.filter(l => r[l.key] != null);
      const what = lv.length
        ? `${lv.map(l => `${l.label} ${fig(r[l.key], 2)}`).join(' · ')} m AHD`
        : (r.ground_m != null ? 'no level given' : '');
      const bits = [what, r.setting ? `setting: ${r.setting}` : ''].filter(Boolean).join('; ');
      return `${r.as_at ? date(r.as_at) : 'Undated'} — ${bits || r.note || 'nothing entered yet'}`;
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
        What the Bureau’s Queensland flood warning station lists say about this station, the
        modelled AEP flood levels at it, and anything added since. Blank means not recorded.
        Saved with the station.
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
      out[f.key] = NUMERIC.has(f.kind) ? Number(raw) : raw;
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
        out[f.key] = NUMERIC.has(f.kind) ? Number(v) : String(v).trim();
      }
      return out;
    }).filter(r => Object.keys(r).some(k => LISTS[list].content
      ? LISTS[list].content.includes(k)
      : !['as_at', 'valid_from', 'valid_to'].includes(k)));
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
    hasAep,
    cardHtml,
    aepCardHtml,
    velocityRowHtml,
    velocitySummary,
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
