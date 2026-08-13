// MegaNet — maintenance.js
//
//   Maintenance   the Site Maintenance tab: the `Council Maintenance Tasks`
//                 sheet in `Inspection_sheets_for_printing.xlsx`, filled in,
//                 drafted locally and saved through
//                 meganet.save_maintenance_activity().
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr and registerTabTeardown;
// across to app.js for switchTab from an inline handler, so at click time; to
// auth.js for Auth; to datastore.js for dbSelect, dbRpc and dbCanWrite; and to
// attachments.js for the two panels on this sheet that are images rather than
// field sets.
// One thing reaches into this file: inspections.js calls startFrom() from the
// prompt at the foot of an inspection whose departure rating asks for one of
// these — which is the printed cross-reference, made into a button.
//
// The IIFE body builds its field tables and calls nothing, so this file's
// position among the modules is free — checked, not reasoned about
// (`npm run toplevel`). It builds no Leaflet map, so it registers none; it does
// register a teardown, because the draft autosave is a timer.
//
// ── Why this is a second form and not a seventh sheet ────────────────────────
//
// #116 renders six sheets from one matrix, because the six are one form family
// with sections added and removed per station configuration. This is not the
// seventh. The workbook itself says so — it is the one sheet with pick-lists
// rather than free text, it is the only one with a filled-in example beside it,
// and 0009 gives it three tables of its own rather than a row in
// `meganet.inspection_config`. It asks a different question: not "is the
// calibration still good" but "who owns this, what condition is it in, and who
// do we ring about it".
//
// So there is no matrix here and no `meganet.maintenance_section` for one to
// live in: there is one Council sheet, its layout does not vary, and SECTIONS
// below is that layout in the order the sheet prints it. Where #116 says *the
// matrix decides which sections print*, this file says *the sheet does* — and
// the sheet is one sheet.
//
// What is shared, and deliberately shared rather than copied: every pick-list.
// Condition, Owner, the rainfall and water-level instrument types, Comms
// method, Comms equipment, Power, Yes/No and the five-value data-quality
// rating are the same rows in the same tables the inspection form reads, which
// is what #117's acceptance asks for — one source of truth, not a parallel
// list. The 22 councils are read the same way and are used only here.
//
// ── The link back to the inspection that triggered it ────────────────────────
//
// Every inspection sheet ends with "sites on departure that are poor or have
// issues please complete Flood Warning Council Maintenance Project form".
// 0009 made that a foreign key (`maintenance_activity.inspection_id`) and a
// view (`meganet.inspection_needs_maintenance`). This tab is where both become
// visible: the picker lists every visit the instruction was printed for and
// nobody followed, and starting a form from one carries the visit's id, its
// station and its date across. A form can also be started from nothing, which
// is the maintenance round nobody was sent on by an inspection.
//
// ── The Comms and Power panel is three panels, since 0011 ────────────────────
//
// It was rendered as one when this file was written, and that was a loss rather
// than a gap. The panel prints a Conditon (the sheet's spelling) and an Owner
// under each of its three sub-columns — Comms (col U), Equipment (col Y), Power
// (col AC) — and `meganet.maintenance_asset` carried one pair for the whole
// panel. The Comms pair was stored as the panel's, and the filled Mt Kanigan
// sheet answers the three Condition boxes differently (Comms poor, Equipment
// good, Power good), so digitising that site recorded "the panel is poor" and
// dropped the fact that only the comms third of it was.
//
// `db/migrations/0011_printed_boxes.sql` added the other four columns, so PANELS
// below renders the comms panel as three titled sub-blocks and `UNCAPTURED` is
// empty. `condition_key` and `owner_key` kept their names and mean the Comms
// sub-column here and the whole panel on the other two, which is what the paper
// says: those two print one Conditon each.
//
// Worth knowing for #118 and #128, which will read these rows back: a row saved
// before 0011 has the Comms pair filled and the other four null, and null here
// means "not recorded" exactly as it does everywhere else in this schema. There
// is no backfill to do, because there is nothing to backfill from.
//
// ── The two boxes that are images, which used to be a third gap ──────────────
//
// The ALERT CANISTER CONFIGURATION panel is a pasted screenshot of a terminal
// dump in the one filled example, and "Bench Mark present" prints "(if yes take
// photo)" beside it. Neither is a field, and until #149 neither could be
// recorded: `meganet.attachment` was an index into a bucket and `authenticated`
// held SELECT on it and nothing else, so the editors-only insert policy under it
// was unreachable. Both panels are real now — `Attachments.sectionHtml()`, from
// attachments.js, which both form tabs share. They appear once the form has been
// saved, because the attachment hangs off the record by foreign key; that is the
// same rule as the Council-form link at the foot of an inspection, for the same
// reason.
//
// ── Saving, drafts and who may read what ─────────────────────────────────────
//
// The document this file holds is exactly the one
// meganet.maintenance_activity_doc() returns, so a save round-trips one shape.
// Same 409 contract as every other write in this app: the form sends back the
// `updated_at` it loaded, and a save that would overwrite somebody else's work
// is refused rather than won.
//
// This family is editors-only *and more so than the inspections one* — 0009
// says the reason out loud: "Assess and WHS" is site-access and safety notes,
// and the contact block is named people's phone numbers and email addresses.
// The anon key this app ships with is published. So the vocabularies render
// signed out and the blank form fills in signed out; the recent list, the
// outstanding list and Save need a session, and say so rather than failing at
// the network.
//
// Drafts are localStorage, for the same reason as #116's: the crew filling this
// in is at a remote site on a tablet with no signal. A draft is this browser's,
// is never uploaded on its own, and is cleared when the activity it holds
// saves. MemMeter already counts localStorage as a holder, so this needs no
// new entry in its three lists.
//
// Issue #117 (I3), sub-issue of #78. Schema: db/migrations/0009_inspections.sql.

const Maintenance = (function () {

  // ── The vocabularies ───────────────────────────────────────────────────────
  // Fetched once, on first open, and kept for the session. Every one of these
  // is granted to `anon` in 0009 — a printed form's own pick-list says nothing
  // about a site — so this works signed out and signing in adds nothing to it.
  // Eight of the nine are the same tables inspections.js reads; `council` is
  // the one only this form asks for.

  const LOOKUPS = [
    'rain_instrument_type', 'wl_instrument_type', 'condition_rating', 'asset_owner',
    'comms_method', 'comms_equipment', 'power_supply', 'yes_no',
    'data_quality_rating', 'council',
  ];

  // ── The sheet, box by box ──────────────────────────────────────────────────
  //
  // A field is:
  //
  //   t      'text' | 'email' | 'tel' | 'date' | 'bool' | 'select' | 'area'
  //   k      the column in this section's table
  //   label  what the sheet prints beside the box
  //   opts   lookup table name, for t === 'select'
  //   note   the sheet's own printed note beside the box
  //   full   the box spans the row (free text, mostly)
  //
  // `bool` is a three-state pick-list for the same reason it is in #116: the
  // paper prints YES and NO with neither circled far more often than it prints
  // either, a checkbox cannot say "nobody answered this", and null is what the
  // schema stores for that.

  const F = (t, k, label, extra) => Object.assign({ t, k, label }, extra || {});

  // The three parallel mini-panels across the top of the sheet. `only` is not a
  // styling choice: meganet.maintenance_asset's two check constraints refuse a
  // rainfall row carrying a water-level instrument, or any panel but the comms
  // one carrying a comms key, so a box offered on the wrong panel is a save that
  // fails after the typing.
  //
  // Rainfall and Water Level ask three questions — what is it, what condition,
  // who owns it — and print one box each. The Comms and Power panel asks the
  // same three about *three* things, and prints them as three sub-columns:
  // Comms (col U), Equipment (col Y), Power (col AC), each with its own Conditon
  // (the sheet's spelling, row 10) and its own Owner (row 12). Six boxes across
  // the panel, not two.
  //
  // #117 stored the Comms sub-column's pair as the whole panel's and said so on
  // the panel, because 0009 had two columns. 0011 added the other four, so the
  // panel is `blocks` below rather than a flat field list — and that shape is
  // the reason this is not a cosmetic change. The filled Mt Kanigan sheet
  // answers the three Condition boxes differently (Comms poor, Equipment good,
  // Power good); before 0011 that site digitised as "the panel is poor".
  //
  // `condition_key` / `owner_key` keep their names and mean the Comms
  // sub-column here, the whole panel on the other two. Renaming them would have
  // made a column that exists on three panels and is named after one.
  const PANELS = [
    {
      asset: 'rainfall', label: 'Rainfall',
      blocks: [
        { fields: [
          F('select', 'rain_instrument_type_key', 'Instrument type', { opts: 'rain_instrument_type' }),
          F('select', 'condition_key', 'Condition', { opts: 'condition_rating' }),
          F('select', 'owner_key', 'Owner', { opts: 'asset_owner' }),
        ] },
        { fields: [F('area', 'comments', 'Comments', { full: true })] },
      ],
    },
    {
      asset: 'water_level', label: 'Water Level',
      blocks: [
        { fields: [
          F('select', 'wl_instrument_type_key', 'Instrument type', { opts: 'wl_instrument_type' }),
          F('select', 'condition_key', 'Condition', { opts: 'condition_rating' }),
          F('select', 'owner_key', 'Owner', { opts: 'asset_owner' }),
        ] },
        { fields: [F('area', 'comments', 'Comments', { full: true })] },
      ],
    },
    {
      asset: 'comms_power', label: 'Comms and Power',
      blocks: [
        { title: 'Comms', fields: [
          F('select', 'comms_method_key', 'Comms', { opts: 'comms_method' }),
          F('select', 'condition_key', 'Condition', { opts: 'condition_rating' }),
          F('select', 'owner_key', 'Owner', { opts: 'asset_owner' }),
        ] },
        { title: 'Equipment', fields: [
          F('select', 'comms_equipment_key', 'Equipment', { opts: 'comms_equipment' }),
          F('select', 'equipment_condition_key', 'Condition', { opts: 'condition_rating' }),
          F('select', 'equipment_owner_key', 'Owner', { opts: 'asset_owner' }),
        ] },
        { title: 'Power', fields: [
          F('select', 'power_key', 'Power', { opts: 'power_supply' }),
          F('select', 'power_condition_key', 'Condition', { opts: 'condition_rating' }),
          F('select', 'power_owner_key', 'Owner', { opts: 'asset_owner' }),
        ] },
        // One Comments box under the three, because the sheet prints one (U14).
        { fields: [F('area', 'comments', 'Comments', { full: true })] },
      ],
    },
  ];

  // Everything else on the sheet lives on the activity row itself, so these
  // read and write `top.<column>`.
  const BLOCKS = {
    gauge_boards: [
      {
        fields: [
          F('bool', 'gauge_boards_present', 'Gauge Boards present'),
          F('select', 'gauge_boards_condition_key', 'Condition of gauge boards', { opts: 'condition_rating' }),
          F('select', 'gauge_boards_owner_key', 'Owner', { opts: 'asset_owner' }),
          F('bool', 'benchmark_present', 'Bench Mark present', { note: '(if yes take photo)' }),
          F('bool', 'benchmark_surveyed', 'Surveyed'),
          F('area', 'gauge_boards_comments', 'Comments', { full: true }),
        ],
      },
    ],
    contacts: [
      {
        title: 'Council',
        fields: [
          F('select', 'council_key', 'Council name', { opts: 'council' }),
          F('text', 'council_contact_name', 'Council contact name'),
          F('email', 'council_contact_email', 'Email'),
          F('tel', 'council_contact_phone', 'Phone #'),
          F('area', 'council_comments', 'Comments', { full: true }),
        ],
      },
      {
        title: 'Landowner',
        fields: [
          F('text', 'landowner_contact_name', 'Landowner contact name'),
          F('email', 'landowner_contact_email', 'Email'),
          F('tel', 'landowner_contact_phone', 'Phone #'),
          F('area', 'landowner_comments', 'Comments', { full: true }),
        ],
      },
    ],
    access_whs: [
      {
        note: 'Access and safety notes. This is the single most sensitive box on the form — it is '
            + 'why the whole maintenance family is readable by editors only.',
        fields: [F('area', 'access_whs_comments', 'Comments', { full: true })],
      },
    ],
    remarks: [
      { fields: [F('area', 'remarks', 'Remarks', { full: true })] },
    ],
  };

  // The sheet's own print order, top to bottom. `kind` picks the renderer:
  // 'panel' is one of the three asset mini-panels, 'blocks' is a set of boxes
  // on the activity row, 'data_quality' is the two-by-two grid and
  // 'attachments' is the canister panel, which is a file rather than a field.
  const SECTIONS = [
    { key: 'rainfall',      label: 'Rainfall',                    kind: 'panel',  asset: 'rainfall' },
    { key: 'water_level',   label: 'Water Level',                 kind: 'panel',  asset: 'water_level' },
    { key: 'comms_power',   label: 'Comms and Power',             kind: 'panel',  asset: 'comms_power' },
    { key: 'gauge_boards',  label: 'Gauge Boards and Benchmark',  kind: 'blocks' },
    { key: 'contacts',      label: 'Contact details',             kind: 'blocks' },
    { key: 'access_whs',    label: 'Assess and WHS',              kind: 'blocks' },
    { key: 'data_quality',  label: 'Data Quality',                kind: 'data_quality' },
    { key: 'remarks',       label: 'Remarks',                     kind: 'blocks' },
    { key: 'canister',      label: 'ALERT Canister Configuration', kind: 'attachments' },
  ];

  // What the sheet prints and the schema has no column for. Rendered on the
  // section that prints it, in the same words a person reading the paper beside
  // the screen would use to find it.
  //
  // Empty since 0011, and kept for the same reason inspections.js keeps its
  // empty one: the mechanism is the honest answer to the next unhomed box, and
  // reinventing it is a bigger decision than dropping the box quietly. The one
  // entry that was here — the Equipment and Power sub-columns' Condition and
  // Owner — is four columns now (#148).
  const UNCAPTURED = {};

  // The two parameters the Council sheet's own data-quality block names. They
  // are *not* the inspection form's two: this sheet prints "Data Quality
  // Rainfall" and "Data Quality River Level" where the inspection sheets print
  // "Rain" and "Water Level", and meganet.maintenance_data_quality's check
  // constraint spells them 'rainfall' and 'river_level' accordingly.
  const PARAMETERS = [
    ['rainfall',    'Data Quality Rainfall'],
    ['river_level', 'Data Quality River Level'],
  ];

  // ── Local state ────────────────────────────────────────────────────────────

  const S = () => state.maint;

  const DRAFTS_KEY = 'mn-maint-drafts';

  let saveTimer = null;
  let registered = false;

  // ── Reference data ─────────────────────────────────────────────────────────

  // Fetched once per session. Never rejects: every caller wants to render the
  // failure, not catch it.
  function loadRefs() {
    const s = S();
    if (s.refs || s.refsLoading) return;
    s.refsLoading = true;
    s.refsError = null;
    repaint();

    Promise.all(LOOKUPS.map(t =>
      dbSelect(`${t}?select=*&order=ord`).then(rows => [t, rows])))
      .then(pairs => {
        const refs = {};
        pairs.forEach(([name, rows]) => { refs[name] = rows; });
        s.refs = refs;
        s.refsLoading = false;
        repaint();
      })
      .catch(err => {
        s.refsLoading = false;
        // Deliberately not console.error, for the same reason as #116: a
        // blocked or sleeping datastore is a state this tab renders.
        s.refsError = (err && err.message) || String(err);
        repaint();
      });
  }

  function lookup(name) { return (S().refs && S().refs[name]) || []; }

  function labelIn(table, key) {
    const row = lookup(table).find(r => r.key === key);
    return row ? row.label : (key || '');
  }

  // ── The document ───────────────────────────────────────────────────────────
  // Exactly the shape meganet.maintenance_activity_doc() returns, so a save
  // round-trips one shape and a reload needs no translation.

  function blankDoc(station, seed) {
    return Object.assign({
      id: null,
      station_id: station ? station.id : null,
      inspection_id: null,
      station_name: station ? station.name : '',
      cbm_no: station ? (station.station_number || '') : '',
      visited_on: todayIso(),
      recorded_by: '',
      council_key: null,
      council_contact_name: '', council_contact_email: '', council_contact_phone: '',
      council_comments: '',
      landowner_contact_name: '', landowner_contact_email: '', landowner_contact_phone: '',
      landowner_comments: '',
      gauge_boards_present: null,
      gauge_boards_condition_key: null,
      gauge_boards_owner_key: null,
      benchmark_present: null,
      benchmark_surveyed: null,
      gauge_boards_comments: '',
      access_whs_comments: '',
      remarks: '',
      trigger_reason: '',
      origin: 'form',
      assets: [], data_quality: [], attachments: [],
    }, seed || {});
  }

  function todayIso() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Materialise every row the rendered form addresses by index, so that setting
  // a value never has to create one and an index never shifts under a
  // keystroke. Both lists are fixed by the sheet — three panels, two parameters
  // — so there is nothing here to add or remove by hand.
  function ensureRows(doc) {
    const had = Array.isArray(doc.assets) ? doc.assets : [];
    doc.assets = PANELS.map(p =>
      had.find(r => r.asset === p.asset)
      || { asset: p.asset, rain_instrument_type_key: null, wl_instrument_type_key: null,
           condition_key: null, owner_key: null, comms_method_key: null,
           comms_equipment_key: null, power_key: null,
           equipment_condition_key: null, equipment_owner_key: null,
           power_condition_key: null, power_owner_key: null, comments: '' });

    const hadQ = Array.isArray(doc.data_quality) ? doc.data_quality : [];
    doc.data_quality = PARAMETERS.map(([parameter]) =>
      hadQ.find(r => r.parameter === parameter)
      || { parameter, on_arrival_key: null, on_departure_key: null, comments: '' });

    if (!Array.isArray(doc.attachments)) doc.attachments = [];
    return doc;
  }

  function assetIndex(asset) {
    return S().doc.assets.findIndex(r => r.asset === asset);
  }

  // ── Reading and writing one box ────────────────────────────────────────────
  // Every input names its own path into the document, so a keystroke updates
  // one value and repaints nothing. Same reasoning as #116: reading the form
  // out of the DOM at save time loses everything the moment a section
  // re-renders, which on a tablet in the field is the failure that matters.

  function container(path) {
    const doc = S().doc;
    if (!doc) return null;
    const bits = path.split('.');
    let node = doc;
    for (let i = 0; i < bits.length - 1; i++) {
      const key = bits[i];
      if (key === 'top') continue;
      node = node[/^\d+$/.test(key) ? Number(key) : key];
      if (node == null) return null;
    }
    return node;
  }

  function get(path) {
    const node = container(path);
    if (!node) return null;
    const last = path.split('.').pop();
    return node[last];
  }

  function set(path, raw, type) {
    const node = container(path);
    if (!node) return;
    const last = path.split('.').pop();
    let v = raw;
    if (type === 'bool') v = raw === '' ? null : raw === 'true';
    else if (type === 'sel') v = raw === '' ? null : raw;
    node[last] = v;
    afterEdit();
  }

  // Everything a keystroke has to keep true, and nothing else. The document is
  // not re-rendered: the one derived readout is patched in place, so the caret
  // stays where it was.
  function afterEdit() {
    S().dirty = true;
    paintDerived();
    scheduleDraft();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function render() {
    const s = S();
    return `
      <div class="mnt-page">
        ${headerHtml()}
        ${s.refsError ? refsErrorHtml()
          : !s.refs ? `<div class="panel mnt-note">Loading the form…</div>`
          : s.doc ? formHtml()
          : pickerHtml()}
      </div>`;
  }

  function headerHtml() {
    const s = S();
    return `
      <div class="panel mnt-head">
        <div class="panel-header">
          <h2>Site Maintenance</h2>
          <div class="mnt-head-actions">
            ${s.doc ? `<button onclick="Maintenance.close()">← All maintenance forms</button>` : ''}
          </div>
        </div>
        <p class="small mnt-sub">
          The <code>Council Maintenance Tasks</code> sheet, digitised. Not a calibration record —
          this is the stewardship one: who owns what, what condition it is in, and who to ring
          about it. Its pick-lists are the same rows the inspection form reads.
        </p>
        <div id="mnt-status" class="small">${statusHtml()}</div>
      </div>`;
  }

  function refsErrorHtml() {
    return `
      <div class="panel mnt-note mnt-bad">
        <strong>The form's pick-lists could not be loaded.</strong>
        <p class="small">Condition, Owner, the instrument types, Comms, Power and the 22 councils
          are read from the datastore — they are the printed sheet's own words and are readable
          without signing in. This browser could not reach them: ${esc(S().refsError)}</p>
        <p class="small">Nothing on this tab can be filled in until it can.
          Any draft already saved on this device is untouched.</p>
        <button class="primary" onclick="Maintenance.retry()">Try again</button>
      </div>`;
  }

  function statusHtml() {
    const s = S();
    if (s.msg) {
      const colour = s.msg.kind === 'error' ? 'var(--bad)'
                   : s.msg.kind === 'ok' ? 'var(--ok)' : 'var(--muted)';
      return `<span style="color:${colour}">${esc(s.msg.text)}</span>`;
    }
    if (!dbCanWrite()) {
      return `<span style="color:var(--muted)">Not signed in — the form fills in, but the database
        refuses anonymous writes and will not show past forms or the visits waiting for one.
        <a href="#" onclick="Auth.open();return false">Sign in</a> to save;
        everything typed is kept while you do, and drafts save to this device regardless.</span>`;
    }
    if (!Auth.mayWrite()) {
      return `<span style="color:var(--warn)">Signed in as ${esc(Auth.email() || 'you')}, but this
        address is not on the editors list, so a save will be refused. An administrator has to add
        it (see <code>docs/access.md</code>). Drafts still save to this device.</span>`;
    }
    return '';
  }

  // ── The picker ─────────────────────────────────────────────────────────────

  function pickerHtml() {
    const s = S();
    return `
      <div class="mnt-cols">
        <div class="stack">
          <div class="panel">
            <div class="panel-header"><h3>Start a maintenance form</h3></div>
            <label class="mnt-search">Station
              <input type="search" id="mnt-q" value="${escAttr(s.query)}"
                     placeholder="name, station number or ALERT address"
                     oninput="Maintenance.search(this.value)">
            </label>
            <div id="mnt-matches">${matchesHtml()}</div>
            <p class="small mnt-muted">
              A maintenance round can also be recorded for a site that is not in the list —
              <button class="btn-link" onclick="Maintenance.pick(null)">start one without a station</button>.
              The form keeps the name and CBM No either way.
            </p>
          </div>
          ${outstandingHtml()}
        </div>
        <div class="stack">
          ${draftsHtml()}
          ${recentHtml()}
        </div>
      </div>`;
  }

  function matchesHtml() {
    const s = S();
    const q = s.query.trim().toLowerCase();
    if (!q) return `<p class="small mnt-muted">Type to search ${
      state.data ? (state.data.stations || []).length.toLocaleString() : 'the'} stations.</p>`;
    const all = (state.data && state.data.stations) || [];
    const hits = all.filter(st =>
      (st.name || '').toLowerCase().includes(q) ||
      (st.station_number || '').toLowerCase().includes(q) ||
      Object.values(st.alert_ids || {}).some(id => String(id) === q)
    ).slice(0, 25);
    if (!hits.length) return `<p class="small mnt-muted">No station matches “${esc(s.query)}”.</p>`;
    return `
      <div class="mnt-hits">
        ${hits.map(st => `
          <button class="mnt-hit" onclick="Maintenance.pick('${escAttr(st.id)}')">
            <span class="mnt-hit-name">${esc(st.name)}</span>
            <span class="small mnt-muted">${esc(st.station_number || '—')}${
              st.roles && st.roles.length ? ` · ${esc(st.roles.join(', '))}` : ''}</span>
          </button>`).join('')}
      </div>`;
  }

  // Decision 5 of 0009, on screen. Every visit whose departure rating is one
  // the ratings table marks as needing maintenance and which nobody has raised
  // a form for — which is exactly the sentence printed at the foot of every
  // inspection sheet, as a list of the times it was ignored.
  function outstandingHtml() {
    const s = S();
    if (!dbCanWrite()) return '';
    if (s.outstandingError) {
      return `
        <div class="panel">
          <div class="panel-header"><h3>Visits waiting for one of these</h3>
            <button onclick="Maintenance.refresh()">Retry</button></div>
          <p class="small" style="color:var(--bad)">${esc(s.outstandingError)}</p>
        </div>`;
    }
    if (!s.outstanding) {
      return `<div class="panel"><div class="panel-header"><h3>Visits waiting for one of these</h3></div>
        <p class="small mnt-muted">Loading…</p></div>`;
    }
    if (!s.outstanding.length) {
      return `<div class="panel"><div class="panel-header"><h3>Visits waiting for one of these</h3></div>
        <p class="small mnt-muted">None — every inspection that departed poor has a maintenance form
          against it.</p></div>`;
    }
    return `
      <div class="panel">
        <div class="panel-header"><h3>Visits waiting for one of these</h3>
          <button onclick="Maintenance.refresh()">Refresh</button></div>
        <p class="small mnt-muted">“Sites on departure that are poor or have issues please complete
          Flood Warning Council Maintenance Project form” is printed at the foot of every inspection
          sheet. These are the visits it was printed for and nobody followed —
          <code>meganet.inspection_needs_maintenance</code>.</p>
        <div class="mnt-list">
          ${s.outstanding.map(r => `
            <div class="mnt-row">
              <button class="btn-link" onclick="Maintenance.fromInspection('${escAttr(r.inspection_id)}')">
                ${esc(r.station_name || r.station_id || 'Unnamed site')}
              </button>
              <span class="small mnt-muted">${esc(r.inspected_on)} ·
                ${esc(r.parameter === 'rain' ? 'Rain' : 'Water Level')} left at
                <em>${esc(r.on_departure_label)}</em></span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  function draftsHtml() {
    const drafts = readDrafts();
    const keys = Object.keys(drafts);
    if (!keys.length) return '';
    return `
      <div class="panel">
        <div class="panel-header"><h3>Drafts on this device</h3></div>
        <p class="small mnt-muted">Saved in this browser, not in the database. A draft never leaves
          this device on its own — open it and press Save when there is a signal.</p>
        <div class="mnt-list">
          ${keys.map(id => {
            const d = drafts[id];
            return `
              <div class="mnt-row">
                <button class="btn-link" onclick="Maintenance.resume('${escAttr(id)}')">
                  ${esc(d.title || 'Untitled visit')}
                </button>
                <span class="small mnt-muted">${esc(d.visited_on || '')} ·
                  saved ${esc(new Date(d.savedAt).toLocaleString())}</span>
                <button class="mnt-drop" title="Discard this draft"
                        onclick="Maintenance.discard('${escAttr(id)}')">Discard</button>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function recentHtml() {
    const s = S();
    if (!dbCanWrite()) {
      return `
        <div class="panel">
          <div class="panel-header"><h3>Recent maintenance forms</h3></div>
          <p class="small mnt-muted">Past forms are editors-only, and this family more so than the
            inspections one — it carries named contacts' phone numbers and site-access notes, and
            the anon key this app ships with is published.
            <a href="#" onclick="Auth.open();return false">Sign in</a> to see them.</p>
        </div>`;
    }
    if (s.recentError) {
      return `
        <div class="panel">
          <div class="panel-header"><h3>Recent maintenance forms</h3>
            <button onclick="Maintenance.refresh()">Retry</button></div>
          <p class="small" style="color:var(--bad)">${esc(s.recentError)}</p>
        </div>`;
    }
    if (!s.recent) {
      return `<div class="panel"><div class="panel-header"><h3>Recent maintenance forms</h3></div>
        <p class="small mnt-muted">Loading…</p></div>`;
    }
    if (!s.recent.length) {
      return `<div class="panel"><div class="panel-header"><h3>Recent maintenance forms</h3></div>
        <p class="small mnt-muted">No maintenance forms recorded yet.</p></div>`;
    }
    return `
      <div class="panel">
        <div class="panel-header"><h3>Recent maintenance forms</h3>
          <button onclick="Maintenance.refresh()">Refresh</button></div>
        <div class="mnt-list">
          ${s.recent.map(r => `
            <div class="mnt-row">
              <button class="btn-link" onclick="Maintenance.open('${escAttr(r.id)}')">
                ${esc(r.station_name || r.station_id || 'Unnamed site')}
              </button>
              <span class="small mnt-muted">${esc(r.visited_on)}${
                r.council_key ? ` · ${esc(labelIn('council', r.council_key))}` : ''}${
                r.recorded_by ? ` · ${esc(r.recorded_by)}` : ''}${
                r.inspection_id ? ' · from an inspection' : ''}${
                r.origin === 'import' ? ' · imported' : ''}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }

  // ── The form ───────────────────────────────────────────────────────────────

  function formHtml() {
    // Two of the nine sections carry an attachment panel, and both are built as
    // strings inside this one render. Telling attachments.js which record is on
    // screen first is what lets those panels be synchronous — it loads the type
    // vocabulary and this record's index rows, and repaints its own nodes when
    // they arrive. Idempotent, so re-rendering the form does not refetch.
    Attachments.forRecord('maintenance', S().doc.id);
    return `
      ${formHeadHtml()}
      ${SECTIONS.map((sec, i) => sectionHtml(sec, i + 1)).join('')}
      ${formFootHtml()}`;
  }

  function formHeadHtml() {
    const doc = S().doc;
    const s = S();
    return `
      <div class="panel mnt-form-head">
        <div class="panel-header">
          <h3>${esc(doc.station_name || 'New maintenance form')}${
            doc.id ? '' : ' <span class="small mnt-muted">— not saved yet</span>'}</h3>
          <div class="mnt-head-actions">
            <button onclick="Maintenance.saveDraft()">Save draft</button>
            ${dbCanWrite()
              ? `<button class="primary" id="mnt-save" onclick="Maintenance.save()"
                        ${s.busy ? 'disabled' : ''}>Save to the database</button>`
              : `<button class="primary" onclick="Auth.open()"
                        title="Saving needs a signed-in session">Sign in to save</button>`}
          </div>
        </div>
        <div class="mnt-grid">
          ${fieldHtml('top.station_name', F('text', 'station_name', 'Station name'))}
          ${fieldHtml('top.cbm_no', F('text', 'cbm_no', 'CBM No'))}
          ${fieldHtml('top.visited_on', F('date', 'visited_on', 'Date of visit'))}
          ${fieldHtml('top.recorded_by', F('text', 'recorded_by', 'Recorded by'))}
          ${fieldHtml('top.trigger_reason', F('text', 'trigger_reason', 'Why this form was raised',
            { full: true, note: 'free text, or poor_on_departure when it came off an inspection' }))}
        </div>
        ${triggerHtml()}
      </div>`;
  }

  // Where a form came from, when it came from somewhere. The foreign key is
  // 0009's decision 5; this is the only place a person sees it.
  function triggerHtml() {
    const doc = S().doc;
    if (!doc.inspection_id) {
      return `<p class="small mnt-muted">Not linked to an inspection — a maintenance round nobody
        was sent on by one. Starting a form from the “visits waiting for one of these” list, or from
        the prompt at the foot of an inspection, fills the link in.</p>`;
    }
    const from = S().from;
    return `
      <p class="small mnt-linked">Raised against the inspection of
        <strong>${esc((from && from.station_name) || doc.station_name || 'this site')}</strong>${
        from && from.inspected_on ? ` on ${esc(from.inspected_on)}` : ''}${
        from && from.on_departure_label
          ? ` — ${esc(from.parameter === 'rain' ? 'Rain' : 'Water Level')} left at
              <em>${esc(from.on_departure_label)}</em>`
          : ''}.
        <code>meganet.maintenance_activity.inspection_id</code> carries the link.</p>`;
  }

  function sectionHtml(sec, ord) {
    let body = '';
    if (sec.kind === 'panel')             body = panelHtml(sec.asset);
    else if (sec.kind === 'data_quality') body = dataQualityHtml();
    else if (sec.kind === 'attachments')  body = canisterHtml();
    else                                  body = blocksHtml(sec.key) + gaugeBoardPhotoHtml(sec.key);

    const gaps = UNCAPTURED[sec.key] || [];
    return `
      <section class="panel mnt-section" data-section="${escAttr(sec.key)}">
        <div class="mnt-banner">
          <span class="mnt-banner-ord">${ord}</span>
          <span class="mnt-banner-label">${esc(sec.label)}</span>
        </div>
        ${body}
        ${gaps.length ? uncapturedHtml(gaps) : ''}
      </section>`;
  }

  function uncapturedHtml(gaps) {
    return `
      <div class="mnt-gap">
        <strong>Printed on this sheet, with nowhere to record it yet</strong>
        <ul class="small">${gaps.map(g =>
          `<li>${esc(g.text)} <span class="mnt-muted">Issue #${g.issue}.</span></li>`).join('')}</ul>
        <p class="small mnt-muted">Left visible rather than dropped quietly.</p>
      </div>`;
  }

  // Same renderer as blocksHtml() below, addressing the panel's own row rather
  // than the activity row. The sub-headings are the sheet's own column headings
  // on the Comms and Power panel and absent on the other two, which is exactly
  // what the paper does. #148.
  function panelHtml(asset) {
    const i = assetIndex(asset);
    if (i < 0) return '';
    const panel = PANELS.find(p => p.asset === asset);
    return panel.blocks.map(block => `
      ${block.title ? `<h4 class="mnt-block">${esc(block.title)}</h4>` : ''}
      <div class="mnt-grid">
        ${block.fields.map(f => fieldHtml(`assets.${i}.${f.k}`, f)).join('')}
      </div>`).join('');
  }

  // "(if yes take photo)" is printed beside Bench Mark present on the paper, so
  // the panel goes on the section that prints it rather than in a files area of
  // its own. #149; until it landed this was an UNCAPTURED note saying the photo
  // the sheet asks for had nowhere to go.
  function gaugeBoardPhotoHtml(sectionKey) {
    if (sectionKey !== 'gauge_boards') return '';
    return Attachments.sectionHtml({
      kind: 'maintenance', id: S().doc.id, role: 'gauge_board',
      label: 'Gauge board and benchmark photos',
      note: 'The sheet prints “(if yes take photo)” beside Bench Mark present.',
    });
  }

  function blocksHtml(sectionKey) {
    return (BLOCKS[sectionKey] || []).map(block => `
      ${block.title ? `<h4 class="mnt-block">${esc(block.title)}</h4>` : ''}
      ${block.note ? `<p class="small mnt-muted">${esc(block.note)}</p>` : ''}
      <div class="mnt-grid">
        ${block.fields.map(f => fieldHtml(`top.${f.k}`, f)).join('')}
      </div>`).join('');
  }

  function fieldHtml(path, f) {
    const v = get(path);
    const note = f.note ? `<span class="mnt-hint">${esc(f.note)}</span>` : '';
    const cls = f.full || f.t === 'area' ? 'mnt-field full' : 'mnt-field';
    let input;
    if (f.t === 'area') {
      input = `<textarea rows="3" oninput="Maintenance.set('${escAttr(path)}',this.value,'text')"
                >${esc(v || '')}</textarea>`;
    } else if (f.t === 'bool') {
      input = boolHtml(path, v);
    } else if (f.t === 'select') {
      input = selectHtml(path, v, f.opts);
    } else if (f.t === 'date') {
      input = `<input type="date" value="${escAttr(v || '')}"
                      oninput="Maintenance.set('${escAttr(path)}',this.value,'text')">`;
    } else {
      // email and tel are text as far as the schema is concerned; the type is
      // for the keyboard a phone puts up, which is the whole point on a tablet.
      const type = f.t === 'email' ? 'email' : f.t === 'tel' ? 'tel' : 'text';
      input = `<input type="${type}" value="${escAttr(v == null ? '' : v)}"
                      oninput="Maintenance.set('${escAttr(path)}',this.value,'text')">`;
    }
    return `<label class="${cls}"><span class="mnt-label">${esc(f.label)}${note}</span>${input}</label>`;
  }

  function boolHtml(path, v) {
    const yn = lookup('yes_no');
    const cur = v == null ? '' : String(!!v);
    return `
      <select onchange="Maintenance.set('${escAttr(path)}',this.value,'bool')">
        <option value=""${cur === '' ? ' selected' : ''}>—</option>
        ${yn.map(o => `<option value="${o.value ? 'true' : 'false'}"${
          cur === String(!!o.value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>`;
  }

  function selectHtml(path, v, table) {
    return `
      <select onchange="Maintenance.set('${escAttr(path)}',this.value,'sel')">
        <option value="">—</option>
        ${lookup(table).map(o => `<option value="${escAttr(o.key)}"${
          o.key === v ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>`;
  }

  // ── Data quality ───────────────────────────────────────────────────────────

  function dataQualityHtml() {
    const doc = S().doc;
    const opts = lookup('data_quality_rating');
    const LABEL = Object.fromEntries(PARAMETERS);
    return `
      <div class="mnt-scroll">
        <table class="mnt-table">
          <thead><tr><th></th><th>On arrival</th><th>On Departure</th><th>Comments</th></tr></thead>
          <tbody>
            ${doc.data_quality.map((r, i) => `
              <tr>
                <th class="mnt-rowhead">${esc(LABEL[r.parameter] || r.parameter)}</th>
                <td>${ratingHtml(`data_quality.${i}.on_arrival_key`, r.on_arrival_key, opts)}</td>
                <td>${ratingHtml(`data_quality.${i}.on_departure_key`, r.on_departure_key, opts)}</td>
                <td><input type="text" value="${escAttr(r.comments || '')}"
                     oninput="Maintenance.set('data_quality.${i}.comments',this.value,'text')"></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div id="mnt-departed">${departedTextHtml()}</div>`;
  }

  function ratingHtml(path, v, opts) {
    return `
      <select onchange="Maintenance.set('${escAttr(path)}',this.value,'sel')">
        <option value="">—</option>
        ${opts.map(o => `<option value="${escAttr(o.key)}"${
          o.key === v ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>`;
  }

  // The same `needs_maintenance` flag the inspection form reads, asked of this
  // form's own departure ratings: a maintenance round that leaves the site
  // still rated poor is one somebody has to come back to. Read off the
  // database's answer rather than matched on the word "poor".
  function departedTextHtml() {
    const doc = S().doc;
    if (!doc) return '';
    const ratings = lookup('data_quality_rating');
    const LABEL = Object.fromEntries(PARAMETERS);
    const flagged = (doc.data_quality || []).map(r => {
      const rating = ratings.find(x => x.key === r.on_departure_key);
      return rating && rating.needs_maintenance
        ? `${LABEL[r.parameter] || r.parameter} left at ${rating.label}` : null;
    }).filter(Boolean);
    if (!flagged.length) return '';
    return `
      <div class="mnt-prompt">
        <strong>This site is still rated as needing work when the crew left.</strong>
        <p class="small">${flagged.map(t => esc(t)).join(' · ')} — worth saying so in Remarks, and
          worth another visit. Saving records the departure ratings either way.</p>
      </div>`;
  }

  // ── The canister panel ─────────────────────────────────────────────────────

  function canisterHtml() {
    return `
      <p class="small mnt-muted">Top right of the printed sheet. In the blank template this panel is
        empty; in the one filled example it is a pasted screenshot of the canister's raw terminal
        config dump — an image, not a field set, and 0009 says so out loud: it is why
        <code>meganet.attachment_role</code> has a <code>canister_config</code> row.</p>
      ${Attachments.sectionHtml({
        kind: 'maintenance', id: S().doc.id, role: 'canister_config',
        label: 'Canister configuration',
        note: 'The screenshot of the dump, or the dump itself as a text file. A screenshot that '
            + 'exists only on a phone is the failure this panel is here to prevent.',
      })}`;
  }

  // ── The foot of the form ───────────────────────────────────────────────────

  function formFootHtml() {
    const s = S();
    return `
      <div class="panel mnt-foot">
        <div id="mnt-foot-status" class="small">${statusHtml()}</div>
        <div class="button-row">
          <button onclick="Maintenance.saveDraft()">Save draft to this device</button>
          ${dbCanWrite()
            ? `<button class="primary" onclick="Maintenance.save()" ${s.busy ? 'disabled' : ''}>
                 Save to the database</button>`
            : `<button class="primary" onclick="Auth.open()">Sign in to save</button>`}
          <button onclick="Maintenance.close()">Close</button>
        </div>
      </div>`;
  }

  // ── Repainting ─────────────────────────────────────────────────────────────
  // A whole-tab repaint is for a structural change — a record loaded, a form
  // opened or closed. A keystroke never triggers one.

  function repaint() {
    if (state.activeTab !== 'maintenance') return;
    renderMain();
  }

  function paintDerived() {
    const el = document.getElementById('mnt-departed');
    if (el) el.innerHTML = departedTextHtml();
  }

  function say(msg) {
    S().msg = msg;
    ['mnt-status', 'mnt-foot-status'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = statusHtml();
    });
  }

  // ── Drafts ─────────────────────────────────────────────────────────────────

  function readDrafts() {
    try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function writeDrafts(all) {
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); return true; }
    catch (_) { return false; }
  }

  function scheduleDraft() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; writeDraft(false); }, 1200);
  }

  function writeDraft(announce) {
    const s = S();
    if (!s.doc || !s.draftKey) return;
    const all = readDrafts();
    all[s.draftKey] = {
      doc: s.doc,
      stamp: s.stamp || null,
      from: s.from || null,
      visited_on: s.doc.visited_on,
      title: s.doc.station_name || s.doc.cbm_no || 'Untitled visit',
      savedAt: Date.now(),
    };
    const ok = writeDrafts(all);
    if (announce) {
      say(ok ? { kind: 'ok', text: `Draft saved on this device at ${new Date().toLocaleTimeString()}.` }
             : { kind: 'error', text: 'This browser refused to store the draft — private mode, or storage is full.' });
    }
  }

  function dropDraft(key) {
    const all = readDrafts();
    delete all[key];
    writeDrafts(all);
  }

  // The timer is the only thing this tab starts, so it is the only thing it has
  // to stop. Flushed rather than dropped: leaving the tab mid-sentence must not
  // be the thing that loses the sentence.
  function stop() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeDraft(false); }
  }

  // ── Loading and saving ─────────────────────────────────────────────────────

  function loadRecent() {
    const s = S();
    if (!dbCanWrite()) { s.recent = null; s.outstanding = null; return; }
    s.recentBusy = true;
    s.recentError = null;
    dbSelect('maintenance_activity?select=id,station_id,inspection_id,station_name,cbm_no,'
           + 'visited_on,recorded_by,council_key,origin,updated_at'
           + '&deleted_at=is.null&order=visited_on.desc&limit=25')
      .then(rows => { s.recentBusy = false; s.recent = rows; repaint(); })
      .catch(err => {
        s.recentBusy = false;
        s.recent = [];
        s.recentError = `Could not read past maintenance forms — ${(err && err.message) || err}`;
        repaint();
      });
  }

  function loadOutstanding() {
    const s = S();
    if (!dbCanWrite()) { s.outstanding = null; return; }
    s.outstandingBusy = true;
    s.outstandingError = null;
    dbSelect('inspection_needs_maintenance?select=*'
           + '&has_maintenance_activity=is.false&order=inspected_on.desc&limit=25')
      .then(rows => { s.outstandingBusy = false; s.outstanding = rows; repaint(); })
      .catch(err => {
        s.outstandingBusy = false;
        s.outstanding = [];
        s.outstandingError = `Could not read the visits waiting for a form — ${(err && err.message) || err}`;
        repaint();
      });
  }

  function open(id) {
    const s = S();
    say({ kind: 'busy', text: 'Opening…' });
    dbRpc('maintenance_activity_doc', { p_id: id })
      .then(doc => {
        if (!doc) throw new Error('that maintenance form is no longer in the database');
        s.doc = ensureRows(doc);
        s.stamp = doc.updated_at || null;
        s.draftKey = `db:${id}`;
        s.from = null;
        s.dirty = false;
        s.msg = null;
        repaint();
      })
      .catch(err => say({ kind: 'error', text: `Could not open it — ${(err && err.message) || err}` }));
  }

  // What actually goes over the wire. An asset panel or a data-quality row the
  // crew never touched is a panel nobody filled in, and 0009 spells that "no
  // row" rather than "a row of nulls" — same rule as #116's, for the same
  // reason. The cross-panel strip is not belt-and-braces either:
  // meganet.maintenance_asset's two check constraints refuse a rainfall row
  // carrying a water-level instrument key, and a document assembled from an
  // older draft could still be carrying one.
  function prunedDoc(doc) {
    const KEEP = { asset: 1, parameter: 1 };
    const empty = obj => !obj || Object.keys(obj).every(k =>
      KEEP[k] || obj[k] == null || obj[k] === '');

    const out = Object.assign({}, doc);
    delete out.attachments;          // save_maintenance_activity does not write them

    out.assets = (doc.assets || []).map(row => {
      const r = Object.assign({}, row);
      if (r.asset !== 'rainfall')    r.rain_instrument_type_key = null;
      if (r.asset !== 'water_level') r.wl_instrument_type_key = null;
      if (r.asset !== 'comms_power') {
        r.comms_method_key = null; r.comms_equipment_key = null; r.power_key = null;
      }
      return r;
    }).filter(r => !empty(r));

    out.data_quality = (doc.data_quality || []).filter(r => !empty(r));
    return out;
  }

  async function save() {
    const s = S();
    if (s.busy || !s.doc) return;
    if (!s.doc.visited_on) {
      say({ kind: 'error', text: 'A maintenance form needs the date the visit was carried out.' });
      return;
    }

    s.busy = true;
    say({ kind: 'busy', text: 'Saving…' });

    let result;
    try {
      result = await dbRpc('save_maintenance_activity', {
        p_doc: prunedDoc(s.doc),
        p_expected_updated_at: s.doc.id ? s.stamp : null,
      });
    } catch (err) {
      s.busy = false;
      say({ kind: 'error', text: saveErrorText(err) });
      return;                    // the form, and everything typed into it, stands
    }

    s.busy = false;
    s.doc = ensureRows(result);
    s.stamp = result.updated_at || null;
    s.dirty = false;
    // The form is in the database now, so the copy on this device is no longer
    // the only copy — and a stale draft that reappears next week is worse than
    // no draft at all.
    if (s.draftKey) dropDraft(s.draftKey);
    s.draftKey = `db:${s.doc.id}`;
    loadRecent();
    loadOutstanding();           // this visit has a form now; it leaves the list
    repaint();
    say({ kind: 'ok', text: `Saved at ${new Date().toLocaleTimeString()} — in the database, `
                          + `not just this tab. The draft on this device has been cleared.` });
  }

  // One message per way a save can fail, because "Error" is not an instruction.
  function saveErrorText(err) {
    if (err.conflict) {
      return `${err.message} Everything typed is still on screen and still in the draft on this `
           + `device — copy what you need, then reopen the form.`;
    }
    if (err.denied) {
      return Auth.isSignedIn()
        ? `Refused: ${Auth.email() || 'this address'} is not on the editors list, so the database `
          + `will not accept maintenance forms from it. An administrator has to add it `
          + `(docs/access.md). Nothing was changed, and the draft on this device is safe.`
        : `Refused: not signed in, and the database does not accept anonymous writes. Sign in and `
          + `press Save again — the draft on this device is safe either way.`;
    }
    return `Not saved — ${err.message}. The draft on this device is safe; try again when the `
         + `datastore is reachable.`;
  }

  // ── The handlers the form names ────────────────────────────────────────────

  // Repaints the matches alone. Repainting the tab would take the search box —
  // and the caret in it — with them.
  function search(q) {
    S().query = q;
    const el = document.getElementById('mnt-matches');
    if (el) el.innerHTML = matchesHtml();
  }

  function pick(stationId) {
    const station = stationId
      ? ((state.data && state.data.stations) || []).find(x => x.id === stationId) || null
      : null;
    begin(blankDoc(station), `new:${stationId || 'unlisted'}:${Date.now()}`, null);
  }

  // Start a form against a visit in the outstanding list. Everything the visit
  // knows is carried across — the station, its CBM No and the date — because a
  // crew raising this form is answering for that visit and should not have to
  // retype what it already said.
  function fromInspection(inspectionId) {
    const row = (S().outstanding || []).find(r => r.inspection_id === inspectionId);
    if (!row) return;
    startFrom({
      inspection_id: row.inspection_id,
      station_id: row.station_id || null,
      station_name: row.station_name || '',
      cbm_no: row.cbm_no || '',
      inspected_on: row.inspected_on,
      parameter: row.parameter,
      on_departure_label: row.on_departure_label,
    });
  }

  // The printed cross-reference, made into a button. Called from this tab's own
  // outstanding list and from the prompt at the foot of an inspection — the one
  // thing outside this file that reaches into it. The visit's date is *not*
  // copied into `visited_on`: this form records the day somebody went back, and
  // defaulting it to the inspection's date would be a guess that reads as a
  // fact.
  function startFrom(seed) {
    const doc = blankDoc(null, {
      inspection_id: seed.inspection_id || null,
      station_id: seed.station_id || null,
      station_name: seed.station_name || '',
      cbm_no: seed.cbm_no || '',
      trigger_reason: 'poor_on_departure',
    });
    begin(doc, `new:insp:${seed.inspection_id}:${Date.now()}`, seed);
    if (state.activeTab !== 'maintenance') switchTab('maintenance');
  }

  function begin(doc, draftKey, from) {
    const s = S();
    s.doc = ensureRows(doc);
    s.stamp = null;
    s.draftKey = draftKey;
    s.from = from;
    s.dirty = false;
    s.msg = null;
    repaint();
  }

  function close() {
    const s = S();
    if (s.dirty) writeDraft(false);
    s.doc = null;
    s.stamp = null;
    s.draftKey = null;
    s.from = null;
    s.msg = null;
    loadRecent();
    loadOutstanding();
    repaint();
  }

  function resume(key) {
    const all = readDrafts();
    const d = all[key];
    if (!d) return;
    begin(d.doc, key, d.from || null);
    S().stamp = d.stamp || null;
  }

  function discard(key) {
    if (!window.confirm('Discard this draft? It is only on this device, so it cannot be recovered.')) return;
    dropDraft(key);
    repaint();
  }

  function retry() {
    S().refs = null;
    S().refsError = null;
    loadRefs();
  }

  function refresh() { loadRecent(); loadOutstanding(); repaint(); }

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    // Registered from init(), never from the top level: constraint 5 on #113,
    // and checked by `npm run toplevel`. Keyed by name, so re-entering the tab
    // replaces the entry rather than stacking another.
    if (!registered) { registerTabTeardown('Maintenance', stop); registered = true; }
    loadRefs();
    const s = S();
    if (dbCanWrite() && !s.recent && !s.recentBusy) loadRecent();
    if (dbCanWrite() && !s.outstanding && !s.outstandingBusy) loadOutstanding();
  }

  return {
    render, init, set, search, pick, close, save,
    saveDraft: () => writeDraft(true),
    open, resume, discard, retry, refresh,
    fromInspection, startFrom,
  };
})();
