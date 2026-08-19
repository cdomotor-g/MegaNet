// MegaNet — station-inspections.js
//
//   StationInspections   the Inspections section at the foot of the station
//                        editor card on the Stations tab: a door into that
//                        station's Inspection History, and a chart of the
//                        numbers its past visits recorded.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr and cssVar; across to app.js
// for switchTab from an inline handler, so at click time; to datastore.js for
// dbSelect and dbCanWrite; and to history.js for History.pick(), which is the
// Inspection History tab's own station scope rather than a second copy of it.
// One file reaches into this one: station-editor.js, which calls sectionHtml()
// from editorForm() — this section is a part of that card's contents, and by
// #129's division that makes it the editor's business where it appears and this
// file's business what is in it.
//
// The IIFE body declares and calls nothing, so this file's position among the
// modules is free — checked, not reasoned about (`npm run toplevel`). It builds
// no Leaflet map and starts no timer, so it registers neither a live map nor a
// teardown.
//
// ── Why a file rather than four hundred lines in station-editor.js ───────────
//
// Because it is not a form. Everything else in that card is boxes bound to
// columns of one station row, saved by editorSave(); this reads a different
// database, in a different shape, for a different question — "what has this
// site actually been measuring for thirty-five years" — and it draws a picture.
// station-editor.js says in its own header that it is the form and not its
// host; this is the same line drawn one step further out.
//
// ── Where the numbers come from, and why not from the archive table ──────────
//
// #122 loaded ~35 years of paper inspection sheets, and 0014 §7 keeps every one
// of those cells verbatim in meganet.inspection_measurement. It would be the
// obvious source and it is the wrong one, because it holds **only** the imported
// visits: a sheet somebody types into the Inspections tab today writes
// meganet.inspection_power and never lands there at all. A chart built on it
// would show the archive stopping dead at the import and nothing since.
//
// So this reads the **section tables** — the same ones #116's form writes — and
// gets both origins from one query. That works because 0014 §10's
// `project_inspection_measurements()` writes every imported measurement that
// has a home into exactly those columns; the migration calls that projection
// "the reason the historical load is not a parallel schema", and this is the
// first thing to take it at its word.
//
// What decides *which* parameters can be plotted is `meganet.measurement_field`
// — the same table the projection reads. It carries the label, the unit and the
// home column for every field #124's extractor can emit, so the pick-list below
// is the database's own vocabulary rather than a second copy of it, and a field
// added to 0014 appears in the picker without this file being edited.
//
// ── What it does not plot, and why that is said out loud ─────────────────────
//
// Two groups of `measurement_field` rows are deliberately absent from the
// picker, and the section prints a line saying so rather than quietly listing
// 37 of 60 fields:
//
//   calibration grids   `home_table = 'inspection_calibration'` — the tip test,
//                       the shaft-encoder grid, the receiver tests. These are a
//                       grid per visit, not a number per visit: which column
//                       holds the reading depends on the kind, and the river
//                       grid's value means nothing without the `point` it was
//                       taken at. Reducing that to one dot a visit would be an
//                       invented number. They are read in full on the
//                       Inspection History tab, which the pill above goes to.
//   serial numbers      `home_table = 'inspection_serial'` — a canister number
//                       is not a measurement.
//
// Two more are dropped for a smaller reason: `battery_test_raw` and
// `analogue_range_m` map onto text columns (`comments`, `transmitter_range`),
// which is the same exclusion 0014's projection makes in SQL and for the same
// reason — there is no number in there to draw.
//
// ── Two axes, and never a third ──────────────────────────────────────────────
//
// The parameters carry real units — dB, V, mA, W, kPa — and putting volts and
// milliamps on one axis draws a flat line under a mountain and calls them
// comparable. Normalising each series to its own 0–1 band would fit any number
// of units on one picture and is worse, because then the *shape* is the only
// true thing left and every gridline is a lie.
//
// So: one axis per unit, at most two (left and right), and any further unit is
// **named as not drawn** rather than squeezed in. The table under the chart
// carries every ticked parameter's real values either way, so nothing selected
// is ever unreadable — it is the picture that is bounded, not the data.
// docs/design-system.md §3's "a capped table says so", one floor down.

const StationInspections = (function () {

  const S = () => state.stationInsp;

  // The two the section opens on. Both are named in the enhancement this file
  // answers, and both are near the top of the archive by volume: 13,199 battery
  // under-load readings and 7,322 fade margins across 14,982 imported visits.
  const DEFAULT_PARAMS = ['fade_margin_db', 'battery_under_load_v'];

  // How many visits to chart. A station's whole history is the point and the
  // archive's busiest site has 51, so this is well clear of the data rather
  // than a limit anybody meets — but a chart that would silently draw the most
  // recent N of a larger set is the failure the cap exists to make visible, and
  // capHtml() prints it when it bites.
  const VISIT_CAP = 200;

  // Inspection ids per `in.(…)` request. 200 uuids in one URL is ~7.5 kB, which
  // is past what several proxies will pass on a GET; 50 is ~1.9 kB and means one
  // request for every station in the archive.
  const ID_CHUNK = 50;

  // Lines on one picture. Past this the chart is a plate of spaghetti, so the
  // rest are named as not drawn — the same treatment a third unit gets.
  const MAX_SERIES = 8;

  // The section tables that hold one number per visit, and how to reduce each
  // to that number. Keyed by `measurement_field.home_table`; a field whose home
  // is not here is not offered in the picker.
  //
  //   filter   appended to the PostgREST query, for the tables that hold more
  //            than one row per visit
  //   fold     how to combine two readings of one field on one visit
  //
  // `inspection_data` is the readings block, and the phase is `initial` because
  // that is the one every sheet has and the only one 0014's projection writes:
  // the historical sheets record one set of numbers per visit, the modern form
  // records arrival and departure.
  //
  // `inspection_fade_margin` is the Alert sheet's PATH MARGIN table — a run of
  // passes at increasing attenuation, not one reading. The visit's number is
  // the largest load the link still carried, which is also exactly what 0014's
  // projection writes for an imported visit (`max(m.value)` at ord 1), so a
  // typed sheet and an imported one mean the same thing on this chart. The
  // `original` phase is what the link *was* on some earlier visit and would
  // plot the same historical fact twice, so only `this_visit` is read.
  const HOMES = {
    inspection_power:       { filter: '' },
    inspection_radio:       { filter: '' },
    inspection_gas:         { filter: '' },
    inspection_water_level: { filter: '' },
    inspection_data:        { filter: '&phase=eq.initial' },
    inspection_fade_margin: { filter: '&phase=eq.this_visit', fold: Math.max },
  };

  // The two home columns in those tables that are text rather than numeric.
  // 0014's projection excludes the same pair, and states the same reason: they
  // are written by the loader, not projected, because there is no number in
  // them. Checked there against pg_attribute; named here, because a browser
  // cannot ask the catalogue.
  const TEXT_COLUMNS = new Set(['comments', 'transmitter_range']);

  // Colour, and the two channels that carry the same distinction without it —
  // WCAG 1.4.1, and the everyday case of an incident report printed in mono.
  // The tokens are the ARRO chart's, resolved off the document at draw time
  // rather than written in: an SVG presentation attribute does not take a
  // `var(…)`, which is the whole reason cssVar() exists (#141, #138).
  const SERIES_TOKENS = ['--ad-series-1', '--ad-series-2', '--ad-series-3', '--ad-series-4',
                         '--ad-series-5', '--ad-series-6', '--ad-series-7', '--ad-series-8'];
  const SERIES_FALLBACK = ['#0b5cab', '#c7401a', '#107c10', '#7c35a3',
                           '#b8860b', '#00838f', '#ad1457', '#5d4037'];
  const SERIES_DASH  = ['', '7 3', '2 3', '10 3 2 3', '5 2 1 2', '1 3', '9 2 2 2', '4 4'];
  const SERIES_SHAPE = ['circle', 'square', 'triangle', 'diamond'];

  // ── Reference data: the vocabulary ─────────────────────────────────────────
  //
  // meganet.measurement_field is granted to `anon` as well as to editors — it
  // is the list of things a form has boxes for, which is public in the same way
  // the blank sheet is. So the picker fills in signed out; it is the readings
  // behind it that do not (0009's foot, and the gate in bodyHtml).

  function loadFields() {
    const s = S();
    if (s.fields || s.fieldsBusy) return;
    s.fieldsBusy = true;
    s.fieldsError = null;
    dbSelect('measurement_field?select=key,ord,label,unit,section_key,home_table,home_column'
           + '&order=ord.asc')
      .then(rows => {
        s.fieldsBusy = false;
        s.fields = rows.filter(plottable);
        repaint();
      })
      .catch(err => {
        s.fieldsBusy = false;
        // Not console.error: a blocked or sleeping datastore is a state this
        // section renders, not a fault to shout about (the rule inspections.js
        // set for the same fetch).
        s.fieldsError = (err && err.message) || String(err);
        repaint();
      });
  }

  function plottable(f) {
    return !!HOMES[f.home_table] && !!f.home_column && !TEXT_COLUMNS.has(f.home_column);
  }

  function fields()      { return S().fields || []; }
  function fieldOf(key)  { return fields().find(f => f.key === key) || null; }

  // The ticked parameters, in the order they were ticked, dropped to whatever
  // the vocabulary actually has once it lands. The defaults survive a vocabulary
  // that has not arrived yet, because the list is state and this is only the
  // reading of it.
  function chosen() {
    return S().params.map(fieldOf).filter(Boolean);
  }

  // ── The visits, and the numbers on them ────────────────────────────────────
  //
  // Two steps rather than one embedded select. PostgREST can filter a top-level
  // row by an embedded resource, and doing it here would mean this file
  // depending on a foreign key being discoverable through the API for six
  // tables at once; two plain queries are the shape history.js already uses
  // against the same tables, and the id list is small because a station has
  // tens of visits, not thousands.

  function ensure(stationId) {
    const s = S();
    if (!stationId) return;
    if (s.stationId !== stationId) {
      s.stationId = stationId;
      s.visits    = null;
      s.byHome    = {};
      s.error     = null;
      s.busy      = false;
    }
    if (!s.fields && !s.fieldsBusy && !s.fieldsError) loadFields();
    if (!dbCanWrite()) return;            // the gate says so; nothing to fetch
    if (s.visits || s.busy) { fill(); return; }

    s.busy  = true;
    s.error = null;
    dbSelect('inspection?select=id,inspected_on,date_precision,date_raw,origin,config_key'
           + `&station_id=eq.${encodeURIComponent(stationId)}&deleted_at=is.null`
           + `&order=inspected_on.asc&limit=${VISIT_CAP + 1}`)
      .then(rows => {
        if (S().stationId !== stationId) return;      // the operator moved on
        const s2 = S();
        s2.busy    = false;
        s2.capped  = rows.length > VISIT_CAP;
        s2.visits  = rows.slice(0, VISIT_CAP).filter(r => r.inspected_on);
        repaint();
        fill();
      })
      .catch(err => {
        if (S().stationId !== stationId) return;
        const s2 = S();
        s2.busy  = false;
        s2.visits = [];
        s2.error = `Could not read this station's inspections — ${(err && err.message) || err}`;
        repaint();
      });
  }

  // Fetch whichever home tables the ticked parameters need and this station has
  // not already got. Per table rather than all six up front: the two defaults
  // need two of them, and a station whose operator never ticks a gas parameter
  // never asks about gas.
  function fill() {
    const s = S();
    if (!s.visits || !s.visits.length) return;
    const stationId = s.stationId;
    const ids = s.visits.map(v => v.id);

    const want = {};
    chosen().forEach(f => {
      const got = s.byHome[f.home_table];
      if (got && got.rows) return;                    // already in hand
      if (got && got.busy) return;                    // already in flight
      // A table that failed stays failed until retry() clears it. Without this
      // the next repaint asks again, and a datastore that is down turns one
      // failed read into a request per keystroke in the form above.
      if (got && got.error) return;
      (want[f.home_table] = want[f.home_table] || new Set()).add(f.home_column);
    });

    for (const table of Object.keys(want)) {
      // Every plottable column of this table, not only the ticked one: the
      // columns are numeric and the row is being read anyway, so ticking a
      // second parameter from a table already loaded costs nothing.
      const cols = [...new Set(fields().filter(f => f.home_table === table)
                                       .map(f => f.home_column))];
      s.byHome[table] = { busy: true, rows: null, error: null };
      const chunks = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));

      Promise.all(chunks.map(chunk =>
        dbSelect(`${table}?select=inspection_id,${cols.join(',')}`
               + `${HOMES[table].filter}&inspection_id=in.(${chunk.join(',')})`)))
        .then(parts => {
          if (S().stationId !== stationId) return;
          S().byHome[table] = { busy: false, rows: parts.flat(), error: null };
          repaint();
        })
        .catch(err => {
          if (S().stationId !== stationId) return;
          S().byHome[table] = { busy: false, rows: null,
                                error: (err && err.message) || String(err) };
          repaint();
        });
    }
  }

  // Whether anything the ticked parameters need is still in flight.
  function loading() {
    const s = S();
    if (s.busy || s.fieldsBusy) return true;
    return chosen().some(f => (s.byHome[f.home_table] || {}).busy);
  }

  // ── Turning rows into series ───────────────────────────────────────────────

  // inspection_id → { column → number }, for one home table, folded by the rule
  // that table's shape needs. Built on demand rather than cached, because the
  // rows are tens and the fold is a comparison.
  function valuesFor(table) {
    const store = {};
    const held = (S().byHome[table] || {}).rows || [];
    const fold = HOMES[table].fold;
    for (const row of held) {
      const id = row.inspection_id;
      const into = store[id] = store[id] || {};
      for (const [col, raw] of Object.entries(row)) {
        if (col === 'inspection_id') continue;
        const n = Number(raw);
        // `raw` is null wherever nobody wrote a number, and PostgREST hands
        // numerics back as JSON numbers or as strings depending on their
        // precision — so parse, and keep only what parses.
        if (raw === null || raw === '' || !Number.isFinite(n)) continue;
        into[col] = (into[col] === undefined || !fold) ? n : fold(into[col], n);
      }
    }
    return store;
  }

  // One series per ticked parameter: its points, in date order, and the range
  // they cover. A parameter with no readings at this station still gets a
  // series — with no points — because "nobody has ever measured this here" is
  // an answer, and a legend that silently dropped it would read as a gap in the
  // chart rather than a fact about the site.
  function series() {
    const s = S();
    const visits = s.visits || [];
    const byTable = {};
    return chosen().map((f, i) => {
      const store = byTable[f.home_table] = byTable[f.home_table] || valuesFor(f.home_table);
      const points = [];
      for (const v of visits) {
        const y = (store[v.id] || {})[f.home_column];
        if (y === undefined) continue;
        points.push({ t: Date.parse(v.inspected_on), y, visit: v });
      }
      const ys = points.map(p => p.y);
      return {
        field: f, key: f.key, label: f.label, unit: f.unit || '', i,
        points,
        lo: ys.length ? Math.min(...ys) : null,
        hi: ys.length ? Math.max(...ys) : null,
        error: (s.byHome[f.home_table] || {}).error || null,
      };
    });
  }

  // Which series the picture can honestly hold: the first two units get an
  // axis, everything past that — and everything past MAX_SERIES lines — is
  // handed back as `dropped` so the section can name it.
  function plan() {
    const all = series();
    const withData = all.filter(sr => sr.points.length);
    const units = [];
    for (const sr of withData) if (!units.includes(sr.unit)) units.push(sr.unit);
    const axes = units.slice(0, 2);

    const drawn = [], dropped = [];
    for (const sr of withData) {
      if (!axes.includes(sr.unit))    { dropped.push({ sr, why: 'unit' }); continue; }
      if (drawn.length >= MAX_SERIES) { dropped.push({ sr, why: 'count' }); continue; }
      sr.axis = axes.indexOf(sr.unit);        // 0 = left, 1 = right
      drawn.push(sr);
    }
    // Two ways a ticked parameter can have no line, and they are not the same
    // fact: nobody has ever measured it here, or the read failed. Conflating
    // them would report a broken datastore as a property of the site.
    const failed = all.filter(sr => !sr.points.length && sr.error);
    const empty  = all.filter(sr => !sr.points.length && !sr.error);

    // One scale per axis, over every series on it, padded so a flat line does
    // not sit on the frame and a single reading has somewhere to be.
    const scales = axes.map((unit, ax) => {
      const on = drawn.filter(sr => sr.axis === ax);
      let lo = Math.min(...on.map(sr => sr.lo));
      let hi = Math.max(...on.map(sr => sr.hi));
      // A station whose battery has read 12.4 V at every visit for ten years is
      // the flat case, and it is a real answer rather than a degenerate one —
      // so the band around it is narrow (2%), or the chart turns "nothing has
      // changed" into a line lost in the middle of a volt and a half.
      if (!(hi > lo)) { const m = (Math.abs(hi) || 1) * 0.02; lo = hi - m; hi = hi + m; }
      else            { const m = (hi - lo) * 0.08; lo -= m; hi += m; }
      return { unit, lo, hi };
    });

    const ts = drawn.flatMap(sr => sr.points.map(p => p.t));
    const t0 = ts.length ? Math.min(...ts) : null;
    const t1 = ts.length ? Math.max(...ts) : null;
    return { all, drawn, dropped, empty, failed, axes, scales, t0, t1 };
  }

  // ── The section ────────────────────────────────────────────────────────────

  // Called from editorForm(). Static above, live below: the heading and the
  // pill never change for a given station, and #si-body is the only thing any
  // interaction repaints. That division is the point — this section sits inside
  // a form somebody may be halfway through typing into, and re-rendering the
  // card to draw a chart would throw their edit away.
  function sectionHtml(station) {
    if (!station || !station.id) return '';        // a "+ New" draft has no history
    ensure(station.id);
    return `
    <hr>
    <div class="ef-section-head si-head">
      <h4 class="ef-h si-h">Inspections</h4>
      <button type="button" class="si-pill" onclick="StationInspections.openHistory('${escAttr(station.id)}')"
              title="Open the Inspection History tab scoped to ${esc(station.name || 'this station')}">
        <span aria-hidden="true">🗓</span> Inspection history for this station →
      </button>
    </div>
    <p class="small ef-flush si-lead">
      Every visit this station has had, typed here or imported from the archive workbook, charted by
      the numbers each one recorded. The pill above opens the full records — the sheets as they were
      written, printable and exportable — with this station already in the history's filter box.
    </p>
    <div id="si-body">${bodyHtml()}</div>`;
  }

  // Everything below the lead paragraph. Rebuilt on its own, by repaint().
  function bodyHtml() {
    const s = S();
    if (!dbCanWrite()) {
      return `
        <p class="small si-muted si-gate">
          <strong>Past inspections are editors-only.</strong> An inspection's remarks carry
          site-access notes, so 0009 grants the records to editors and to nobody else — and the anon
          key this app ships with is published.
          <a href="#" onclick="Auth.open();return false">Sign in</a> to chart them.
        </p>`;
    }
    if (s.error) {
      return `
        <p class="small si-bad si-gate">${esc(s.error)}
          <button type="button" class="link-btn" onclick="StationInspections.retry()">Try again</button>
        </p>`;
    }
    if (s.fieldsError) {
      return `
        <p class="small si-bad si-gate">Could not read the measurement vocabulary —
          ${esc(s.fieldsError)}
          <button type="button" class="link-btn" onclick="StationInspections.retry()">Try again</button>
        </p>`;
    }
    if (!s.visits) return `<p class="small si-muted si-gate">Reading this station's inspections…</p>`;
    if (!s.visits.length) {
      return `
        <p class="small si-muted si-gate">
          No inspection has been recorded against this station. A visit typed on the
          <button type="button" class="link-btn" onclick="switchTab('inspections')">Inspections</button>
          tab appears here, and so does one the archive import could attribute to it.
        </p>`;
    }

    const p = plan();
    return `
      ${pickerHtml()}
      ${chartHtml(p)}
      ${legendHtml(p)}
      ${notDrawnHtml(p)}
      ${capHtml()}
      ${tableHtml(p)}`;
  }

  // ── The picker ─────────────────────────────────────────────────────────────

  // Grouped by the section of the sheet each field is printed in, which is the
  // grouping the forms themselves use and the one `measurement_field` already
  // carries. Labels come off the same rows, so a field renamed in 0014 is
  // renamed here.
  const SECTION_LABEL = {
    battery: 'Battery', power_supply: 'Power supply', radio: 'Radio',
    initial_data: 'Readings on arrival', gas: 'Gas', water_level: 'Water level',
  };

  function pickerHtml() {
    const s = S();
    const list = fields();
    if (!list.length) {
      return `<p class="small si-muted si-gate">Reading the measurement vocabulary…</p>`;
    }
    const groups = [];
    for (const f of list) {
      let g = groups.find(x => x.key === f.section_key);
      if (!g) groups.push(g = { key: f.section_key, fields: [] });
      g.fields.push(f);
    }
    const n = s.params.length;
    return `
      <details class="si-picker" ${s.pickerOpen ? 'open' : ''}
               ontoggle="StationInspections.pickerToggle(this)">
        <summary>Parameters
          <span class="small si-muted">— ${n} chosen${
            n ? `: ${esc(chosen().map(f => f.label).join(', '))}` : ''}</span>
        </summary>
        <div class="si-picker-body">
          <div class="si-picker-actions">
            <button type="button" class="link-btn" onclick="StationInspections.resetParams()"
                    title="Back to fade margin and battery under load">Reset to the two defaults</button>
            <button type="button" class="link-btn" onclick="StationInspections.clearParams()"
                    ${n ? '' : 'disabled'}>Clear all</button>
          </div>
          ${groups.map(g => `
            <fieldset class="si-group">
              <legend>${esc(SECTION_LABEL[g.key] || g.key)}</legend>
              ${g.fields.map(f => `
                <label class="si-opt">
                  <input type="checkbox" ${s.params.includes(f.key) ? 'checked' : ''}
                         onchange="StationInspections.toggleParam('${escAttr(f.key)}')">
                  <span>${esc(f.label)}${f.unit ? ` <span class="si-muted">(${esc(f.unit)})</span>` : ''}</span>
                </label>`).join('')}
            </fieldset>`).join('')}
          <p class="small si-muted si-picker-note">
            Calibration grids — the rain-gauge tip test, the shaft-encoder and receiver grids — and
            serial numbers are not offered here: they are a grid per visit rather than one number,
            and reducing one to a single dot would be inventing a reading. They are read in full on
            the Inspection History tab.
          </p>
        </div>
      </details>`;
  }

  // ── The chart ──────────────────────────────────────────────────────────────

  // PAD_T leaves a line above the frame for the two unit labels — see
  // axisNames below for why they are up there rather than down the side.
  const W = 760, H = 250, PAD_L = 52, PAD_R = 52, PAD_T = 28, PAD_B = 38;

  // Part 1 and 2 of docs/design-system.md §3's three: the headline numbers, and
  // one sentence saying what the picture shows and where the operable version
  // is. Rebuilt wherever the picture is, which is what makes it a name and not
  // a caption — it is computed inside chartHtml() from the same plan the lines
  // are drawn from, so the two cannot disagree.
  function chartName(p) {
    if (!p.drawn.length) {
      return S().params.length
        ? 'Chart, empty — nothing ticked has a reading at this station.'
        : 'Chart, empty — no parameter is chosen.';
    }
    const span = `${fmtYear(p.t0)} to ${fmtYear(p.t1)}`;
    const runs = p.drawn.map(sr =>
      `${sr.label} ${fmtNum(sr.lo)} to ${fmtNum(sr.hi)}${sr.unit ? ' ' + sr.unit : ''} `
      + `over ${sr.points.length} visit${sr.points.length === 1 ? '' : 's'}`).join('; ');
    const axes = p.axes.length === 2
      ? `Left axis ${p.axes[0] || 'unitless'}, right axis ${p.axes[1] || 'unitless'}. ` : '';
    return `Line chart of ${p.drawn.length} inspection parameter`
         + `${p.drawn.length === 1 ? '' : 's'} at ${stationName()}, ${span}. `
         + `${runs}. ${axes}`
         + 'Every value is in the table under the chart, and the parameters are chosen in the '
         + 'Parameters list above it.';
  }

  function chartHtml(p) {
    if (!p.drawn.length) {
      const why = loading()          ? 'Reading the values…'
                : !S().params.length ? 'No parameter is chosen — tick one in the Parameters list '
                                     + 'above, or reset it to fade margin and battery under load.'
                : 'Nothing ticked has a reading at this station — tick another parameter above.';
      return `<p class="small si-muted si-gate">${why}</p>`;
    }
    const x = t => PAD_L + (p.t1 === p.t0 ? 0.5 : (t - p.t0) / (p.t1 - p.t0)) * (W - PAD_L - PAD_R);
    const y = (v, ax) => {
      const sc = p.scales[ax];
      return H - PAD_B - (v - sc.lo) / (sc.hi - sc.lo) * (H - PAD_T - PAD_B);
    };
    const grey = cssVar('--muted', '#4f6478');
    const line = cssVar('--border', '#dde5ee');
    // Colour is never the only channel, and a lone dashed line says
    // "provisional" and means nothing of the kind — so the dashes and shapes
    // only start once there is a second series to tell apart (#141's rule).
    const many = p.drawn.length > 1;

    const gridY = p.scales.map((sc, ax) => ticks(sc.lo, sc.hi).map(v => `
      ${ax === 0 ? `<line x1="${PAD_L}" y1="${y(v, 0).toFixed(1)}" x2="${W - PAD_R}"
                          y2="${y(v, 0).toFixed(1)}" stroke="${line}" stroke-width="1"/>` : ''}
      <text x="${ax === 0 ? PAD_L - 6 : W - PAD_R + 6}" y="${(y(v, ax) + 3.5).toFixed(1)}"
            text-anchor="${ax === 0 ? 'end' : 'start'}" font-size="10"
            class="chart-muted">${esc(fmtNum(v))}</text>`).join('')).join('');

    const gridX = dateTicks(p.t0, p.t1).map(t => `
      <line x1="${x(t).toFixed(1)}" y1="${PAD_T}" x2="${x(t).toFixed(1)}" y2="${H - PAD_B}"
            stroke="${line}" stroke-width="1" stroke-dasharray="2 3"/>
      <text x="${x(t).toFixed(1)}" y="${H - PAD_B + 14}" text-anchor="middle" font-size="10"
            class="chart-muted">${fmtYear(t)}</text>`).join('');

    // The unit, once per axis — which is what makes two axes readable rather
    // than two columns of unexplained numbers. Written flat above the axis it
    // belongs to rather than turned down the side of it, which is the usual
    // place and is wrong for these units: every one of them is one to three
    // characters, and a rotated "V" — the commonest of them — is an angle
    // bracket whichever way it is turned.
    const axisNames = p.scales.map((sc, ax) => sc.unit ? `
      <text x="${ax === 0 ? PAD_L - 6 : W - PAD_R + 6}" y="${PAD_T - 8}"
            text-anchor="${ax === 0 ? 'end' : 'start'}" font-size="10" font-weight="600"
            class="chart-muted">${esc(sc.unit)}</text>` : '').join('');

    const lines = p.drawn.map((sr, k) => {
      const c = seriesColor(k);
      const pts = sr.points.map(pt => `${x(pt.t).toFixed(1)},${y(pt.y, sr.axis).toFixed(1)}`);
      const marks = sr.points.map(pt => mark(x(pt.t), y(pt.y, sr.axis), k, c, pt, sr, many)).join('');
      return `
        <g>
          ${pts.length > 1 ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${c}"
             stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"
             ${many && SERIES_DASH[k % SERIES_DASH.length]
               ? `stroke-dasharray="${SERIES_DASH[k % SERIES_DASH.length]}"` : ''}/>` : ''}
          ${marks}
        </g>`;
    }).join('');

    return `
      <svg class="si-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
           role="img" aria-label="${esc(chartName(p))}">
        <rect x="${PAD_L}" y="${PAD_T}" width="${W - PAD_L - PAD_R}" height="${H - PAD_T - PAD_B}"
              fill="none" stroke="${line}" stroke-width="1"/>
        ${gridY}${gridX}${axisNames}${lines}
      </svg>`;
  }

  // One reading. Hollow where the visit's date is not a date: 0014 keeps
  // `date_precision`, and a 1990 row is an event in that year rather than the
  // first of January — so it is drawn, because dropping it would hide a third
  // of the archive, and drawn differently, because pretending to know the day
  // is the other way to be wrong. The <title> is the browser's own tooltip:
  // no script, and it survives being saved out of the page.
  function mark(cx, cy, k, colour, pt, sr, many, quiet) {
    const exact = (pt.visit.date_precision || 'day') === 'day';
    const shape = many ? SERIES_SHAPE[k % SERIES_SHAPE.length] : 'circle';
    const r = 3.2;
    const fill = exact ? colour : 'none';
    const attrs = `fill="${fill}" stroke="${colour}" stroke-width="1.4"`;
    const title = quiet ? '' :
      `<title>${esc(sr.label)} ${esc(fmtNum(pt.y))}${sr.unit ? ' ' + esc(sr.unit) : ''} — `
      + `${esc(visitDate(pt.visit))}</title>`;
    const at = `${cx.toFixed(1)} ${cy.toFixed(1)}`;
    if (shape === 'square')
      return `<rect x="${(cx - r).toFixed(1)}" y="${(cy - r).toFixed(1)}"
                    width="${r * 2}" height="${r * 2}" ${attrs}>${title}</rect>`;
    if (shape === 'triangle')
      return `<polygon points="${cx.toFixed(1)},${(cy - r - .6).toFixed(1)}
                               ${(cx + r + .4).toFixed(1)},${(cy + r).toFixed(1)}
                               ${(cx - r - .4).toFixed(1)},${(cy + r).toFixed(1)}"
                    ${attrs}>${title}</polygon>`;
    if (shape === 'diamond')
      return `<rect x="${(cx - r).toFixed(1)}" y="${(cy - r).toFixed(1)}"
                    width="${r * 2}" height="${r * 2}" transform="rotate(45 ${at})"
                    ${attrs}>${title}</rect>`;
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" ${attrs}>${title}</circle>`;
  }

  function seriesColor(k) {
    return cssVar(SERIES_TOKENS[k % SERIES_TOKENS.length],
                  SERIES_FALLBACK[k % SERIES_FALLBACK.length]);
  }

  // The legend is real DOM rather than text inside the SVG, so it is selectable,
  // wraps on a phone, and reads in order. It carries each line's own range,
  // which is the thing two axes take away: with volts on the left and decibels
  // on the right, "which line is higher" stops meaning anything and the numbers
  // beside the name are what is left.
  function legendHtml(p) {
    if (!p.drawn.length) return '';
    const many = p.drawn.length > 1;
    return `
      <ul class="si-legend">
        ${p.drawn.map((sr, k) => `
          <li>
            <span class="si-key" aria-hidden="true">
              <svg viewBox="0 0 26 10" class="si-key-svg">
                <line x1="1" y1="5" x2="25" y2="5" stroke="${seriesColor(k)}" stroke-width="1.8"
                      ${many && SERIES_DASH[k % SERIES_DASH.length]
                        ? `stroke-dasharray="${SERIES_DASH[k % SERIES_DASH.length]}"` : ''}/>
                ${mark(13, 5, k, seriesColor(k), { visit: { date_precision: 'day' } },
                       { label: '', unit: '' }, many, true)}
              </svg>
            </span>
            <span class="si-legend-name">${esc(sr.label)}</span>
            <span class="small si-muted">${esc(fmtNum(sr.lo))}–${esc(fmtNum(sr.hi))}${
              sr.unit ? ' ' + esc(sr.unit) : ''} · ${sr.points.length} visit${
              sr.points.length === 1 ? '' : 's'}${p.axes.length > 1
                ? (sr.axis === 0 ? ' · left axis' : ' · right axis') : ''}</span>
          </li>`).join('')}
      </ul>
      <p class="small si-muted si-flush">
        A hollow marker is a visit the archive dates to a month or a year rather than to a day
        (0014 keeps that distinction) — it is drawn at the start of the period it names.
      </p>`;
  }

  // What was ticked and is not on the picture, and why — the "no silent caps"
  // half of the chart pattern. Three ways a parameter can be missing, and they
  // are different facts, so they are different sentences.
  function notDrawnHtml(p) {
    const bits = [];
    const byUnit  = p.dropped.filter(d => d.why === 'unit').map(d => d.sr);
    const byCount = p.dropped.filter(d => d.why === 'count').map(d => d.sr);
    if (byUnit.length) {
      bits.push(`<strong>Not drawn — a third unit:</strong> ${
        esc(byUnit.map(sr => `${sr.label} (${sr.unit || 'no unit'})`).join(', '))}. The chart carries
        two axes and will not put a third unit on somebody else's scale. Untick a parameter to make
        room; the values are in the table below either way.`);
    }
    if (byCount.length) {
      bits.push(`<strong>Not drawn — ${MAX_SERIES} lines is the limit:</strong> ${
        esc(byCount.map(sr => sr.label).join(', '))}.`);
    }
    if (p.empty.length) {
      bits.push(`<strong>No reading at this station:</strong> ${
        esc(p.empty.map(sr => sr.label).join(', '))}. Nobody has recorded ${
        p.empty.length === 1 ? 'it' : 'them'} on a visit here.`);
    }
    if (p.failed.length) {
      bits.push(`<strong class="si-bad">Could not be read:</strong> ${
        esc(p.failed.map(sr => sr.label).join(', '))} — ${esc(p.failed[0].error)}.
        <button type="button" class="link-btn" onclick="StationInspections.retry()">Try
        again</button>`);
    }
    if (!bits.length) return '';
    return `<div class="small si-muted si-notdrawn">${bits.map(b => `<p>${b}</p>`).join('')}</div>`;
  }

  function capHtml() {
    const s = S();
    if (!s.capped) return '';
    return `
      <p class="small si-bad si-flush">
        This station has more than ${VISIT_CAP} recorded visits; the chart and the table below hold
        the oldest ${VISIT_CAP}. Open the Inspection History tab for the whole list.
      </p>`;
  }

  // ── Part 3: the same numbers, as a table ───────────────────────────────────
  //
  // A real <table> a keyboard user can reach and read, one activation away —
  // and it lists **every** ticked parameter, including the ones the picture
  // could not draw. That is the point of it: the chart is bounded by what two
  // axes can honestly hold, and this is not.
  function tableHtml(p) {
    const s = S();
    const cols = p.all.filter(sr => sr.points.length || s.params.includes(sr.key));
    if (!cols.length) return '';
    return `
      <details class="si-table" ${s.tableOpen ? 'open' : ''}
               ontoggle="StationInspections.tableToggle(this)">
        <summary>Readings as a table
          <span class="small si-muted">— every ticked parameter, drawn or not</span></summary>
        ${s.tableOpen ? tableBodyHtml(p, cols) : ''}
      </details>`;
  }

  function tableBodyHtml(p, cols) {
    const visits = (S().visits || []).slice().reverse();      // newest first, like the History tab
    const byTable = {};
    const value = (sr, v) => {
      const store = byTable[sr.field.home_table]
                  = byTable[sr.field.home_table] || valuesFor(sr.field.home_table);
      const y = (store[v.id] || {})[sr.field.home_column];
      return y === undefined ? '' : fmtNum(y);
    };
    const rows = visits.filter(v => cols.some(sr => value(sr, v) !== ''));
    return `
      <div class="table-wrap">
        <table class="si-table-grid">
          <caption class="sr-only">Every reading behind the chart at ${esc(stationName())}, newest
            visit first, one column per chosen parameter</caption>
          <thead>
            <tr>
              <th scope="col">Visit</th>
              <th scope="col">Source</th>
              ${cols.map(sr => `<th scope="col">${esc(sr.label)}${
                sr.unit ? ` <span class="si-muted">(${esc(sr.unit)})</span>` : ''}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map(v => `
              <tr>
                <th scope="row">${esc(visitDate(v))}</th>
                <td class="small si-muted">${v.origin === 'import' ? 'archive' : 'typed here'}</td>
                ${cols.map(sr => `<td>${esc(value(sr, v))}</td>`).join('')}
              </tr>`).join('')
              : `<tr><td colspan="${cols.length + 2}" class="small si-muted">No visit recorded a
                   value for any chosen parameter.</td></tr>`}
          </tbody>
        </table>
      </div>`;
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  // The date as the record claims it, not as an ISO string implies it. 0014
  // keeps `date_precision` precisely so that a 1990 row can say "1990" rather
  // than "1 January 1990", and the whole point of keeping it is to print it.
  function visitDate(v) {
    const on = v.inspected_on || '';
    const p  = v.date_precision || 'day';
    if (p === 'year')  return on.slice(0, 4);
    if (p === 'month') return on.slice(0, 7);
    return on;
  }

  function stationName() {
    const s = S();
    const st = ((state.data && state.data.stations) || []).find(x => x.id === s.stationId);
    return (st && st.name) || 'this station';
  }

  function fmtNum(n) {
    if (n == null || !Number.isFinite(n)) return '';
    const a = Math.abs(n);
    if (a >= 1000) return n.toFixed(0);
    if (a >= 10)   return String(Math.round(n * 10) / 10);
    if (a >= 1)    return String(Math.round(n * 100) / 100);
    return String(Math.round(n * 1000) / 1000);
  }

  function fmtYear(t) {
    return t == null ? '' : String(new Date(t).getUTCFullYear());
  }

  // Four or five round numbers across a range. Deliberately simple: this axis
  // is 200 px tall and nothing here needs a nice-number algorithm.
  function ticks(lo, hi) {
    const out = [];
    for (let i = 0; i <= 4; i++) out.push(lo + (hi - lo) * (i / 4));
    return out;
  }

  // Year boundaries across the span, thinned to at most six labels so a
  // thirty-five-year history does not print thirty-five of them.
  function dateTicks(t0, t1) {
    if (t0 == null || t1 == null) return [];
    const y0 = new Date(t0).getUTCFullYear(), y1 = new Date(t1).getUTCFullYear();
    if (y1 <= y0) return [t0];
    const step = Math.max(1, Math.ceil((y1 - y0) / 5));
    const out = [];
    for (let y = y0; y <= y1; y += step) out.push(Date.UTC(y, 0, 1));
    return out.filter(t => t >= t0 && t <= t1);
  }

  // ── Repainting ─────────────────────────────────────────────────────────────

  // Only this section, and only when it is on screen. The editor card is a form
  // somebody may be halfway through, and rebuilding it to redraw a chart would
  // throw away everything typed since it opened — the same reason
  // editorFillInspConfigSelect() rebuilds one <select> rather than the card.
  function repaint() {
    const el = document.getElementById('si-body');
    if (!el) return;
    el.innerHTML = bodyHtml();
  }

  // ── The handlers the section names ─────────────────────────────────────────

  // The pill. History.pick() is the Inspection History tab's own station scope
  // — the same call its search results make — so this lands with the station in
  // the filter box and the list already loading, rather than with a query typed
  // into the box for somebody to press. Scope first, then switch: pick() starts
  // the load and History.init() sees it in flight rather than starting a second.
  function openHistory(stationId) {
    History.pick(stationId);
    switchTab('history');
  }

  function toggleParam(key) {
    const s = S();
    const i = s.params.indexOf(key);
    if (i >= 0) s.params.splice(i, 1); else s.params.push(key);
    repaint();
    fill();
  }

  function resetParams() {
    S().params = DEFAULT_PARAMS.slice();
    repaint();
    fill();
  }

  function clearParams() {
    S().params = [];
    repaint();
  }

  function pickerToggle(el) { S().pickerOpen = !!el.open; }

  function tableToggle(el) {
    S().tableOpen = !!el.open;
    // The body is built only while it is open — a station with 51 visits and
    // eight parameters is 400 cells nobody has asked for until they have.
    repaint();
  }

  function retry() {
    const s = S();
    const id = s.stationId;
    s.stationId = null;      // force ensure() to treat this as a new station
    s.fields = s.fieldsError ? null : s.fields;
    s.fieldsError = null;
    ensure(id);
    repaint();
  }

  return {
    sectionHtml, openHistory, toggleParam, resetParams, clearParams,
    pickerToggle, tableToggle, retry,
  };
})();
