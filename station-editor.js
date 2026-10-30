// MegaNet — station-editor.js
//
//   editorForm     the station editor card below the stations list on the
//   editorSave     Stations tab: the form, what it derives from what is typed
//   editorDelete   into it, and the save and delete path behind it.
//   and the form
//   helpers
//   editorUnsaved… the gold card, the gilded fields and the bar while an edit
//                  has not been saved (styles.css: "Unsaved edits")
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, slug, pInt, pFloat,
// parseRangeLines, pillText, pillLong, flashPill, stationDirectionsUrl,
// hintToggleHtml, stationMapLinkUrls,
// stationSensors, arroSiteId, arroSiteUrl, arroSensorUrl, buildArroUrl,
// bucketSizeGapNote, ROLE_LABEL and STATION_TYPE_LABEL (a proposed station's
// type, 0039); across to app.js for stationActionGroups — the station card's
// pill groups, which this card draws too — and the Stations tab's rerender
// hooks — rerenderStations, rerenderStationEditorCard, refreshFilterOptions,
// refreshMapLayers, updateHeaderStats, findStationMatches, stationAlertIds,
// passRangeCoversId, repeaterPassingCount and repeaterPassRangeSpan — and for
// the places a new proposal is shown (focusStationOnMap, dockReveal,
// toggleMapFullscreen) and for the station card's owner (stationOwner,
// stationOwnerParse), which the Owner field shows, with sls.js's SLS behind
// it and owner-logos.js's OwnerLogos for the logos — and back
// the other way, stationEditorCardDrawn() calls editorRefreshA2Seen() here
// once the card is on screen, because the heard-slots list reads the readings
// rather than state.data; to auth.js for Auth; and to
// datastore.js for dbCanWrite, dbSaveStation, dbDeleteStation, dbSelect,
// setEditorStatus, editorStatusHtml and editorWritesGoToDatabase; to inspections.js for
// Inspections.configs and Inspections.ensureRefs — the telemetry pick-list
// (#147) reads the same meganet.inspection_config list the Inspections tab
// renders its form from, rather than keeping a second copy; to
// station-inspections.js for StationInspections.sectionHtml, the Inspections
// section under the ARRO block at the foot of the form; to sensor-sparks.js for
// SensorSparks — the slot on each sensor row for its last seven days, and
// fill() when a row is added from the heard-slots list; and to
// river-details.js for RiverDetails — the Bureau's flood warning lists above
// the ARRO block (0031, 0032) and the AEP flood levels with them (0033), which
// editorReadForm() reads back and editorSave() asks formProblem() about first;
// and to station-lpu.js for StationLpu — the station's logger (0090), drawn
// under the telemetry pick-list, asked about first (formProblem), saved after
// the station (save) and put back by Undo (discard);
// and to frequencies.js for Frequencies — the RX/TX rows in the Repeater
// Configuration and a base station's own section (0033), read back and asked
// about the same way; and to health-glance.js for HealthGlance — when the
// station was last heard, in the header (heardHeadHtml, askNet, onHeard), and
// its checks slot by slot at the head of Telemetry (checksHtml); and to
// health-drift.js for HealthDrift.editorHtml — the station's carrier
// fingerprint under its ALERT addresses, as its card on the map has it.
//
// This file is the form, not its host. The card is rendered by the Stations
// tab, which is frozen in app.js for the whole of #129 — so a change to where
// the editor appears is an app.js change, and a change to what it contains is
// one here.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.

// ── STATION EDITOR (card on the Stations tab) ────────────────────────────────────
// The editor lives below the stations list on the Stations tab: selecting a row
// loads it here (see selectStation / renderStationEditorCard, in app.js). "+ New"
// clears the selection and opens a blank form.

function editorNew() {
  state.selectedId  = null;
  state.editorId    = null;
  state.editorDraft = {
    id: '', name: '', station_number: '', lat: null, lon: null, elevation_ahd: null,
    roles: ['field'], radio_network_ids: [], catchment_ids: [],
    alert_ids: {}, satcom: { enabled: false, provider: '', terminal_id: '' },
    rm_system_id: 1, enabled: true, notes: '',
  };
  // A station that does not exist yet has no version to have started from, and
  // save_station() requires the stamp to be absent for an insert.
  state.editorStamp    = null;
  state.editorStampFor = null;
  state.editorMsg      = null;
  rerenderStations();          // drop any row highlight
  rerenderStationEditorCard(); // show the blank form
}

// ── A proposed station (0039) ────────────────────────────────────────────────
// Where a station is meant to go, before it is built or numbered: a name, what
// kind of station it is to be, the year it is proposed for, and a position.
// Anybody who may edit may propose one; adding a station outright, and
// establishing a proposal, are an administrator's — save_station() decides,
// and this only says so first.
//
// "+ Propose" under the station list opens a blank proposal, and What is here
// (map-here.js) opens one at the point it was asked about, which is the way to
// say where without typing coordinates. The year is this year until somebody
// dates it back or forward.
function editorPropose({ lat = null, lon = null } = {}) {
  editorNew();
  Object.assign(state.editorDraft, {
    lat, lon, proposed: true, proposed_year: new Date().getFullYear(),
  });
  rerenderStationEditorCard();
  editorReveal();
}

// The editor on screen with focus in its first box — beside the map in the
// side panel, under it, or a phone's drawer — for the two ways in that start
// on the map rather than in the list. Out of full screen first, as Station
// details does (editStationFromCard): there is no "beside" inside it.
function editorReveal(focusId = 'ef-name') {
  if (state.mapFullscreen) toggleMapFullscreen(false);
  requestAnimationFrame(() => {
    const card = document.getElementById('stations-editor-card');
    if (!card) return;
    dockReveal(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const box = document.getElementById(focusId);
    if (box) box.focus({ preventScroll: true });
  });
}

// An administrator, as the database said at sign-in (whoami(): an editor whose
// meganet.app_user row says admin) — what meganet.is_admin() will say to the
// save. Signed out, nobody is.
function editorIsAdmin() {
  return typeof Auth !== 'undefined' && Auth.mayWrite() && Auth.role() === 'admin';
}

// The kinds of station, for the Station type box. "Choose one" for a proposal,
// which has to say, and "not recorded" for a station that does not.
// The tower heights the database takes (0040's check), for the editor's box.
const TOWER_HEIGHTS = [3.0, 4.5];
function towerHeightOptions(cur) {
  const n = cur == null || cur === '' ? null : Number(cur);
  return [
    `<option value=""${n == null ? ' selected' : ''}>— not recorded (drawn at 3.0 m) —</option>`,
    ...TOWER_HEIGHTS.map(h => `<option value="${h.toFixed(1)}"${n === h ? ' selected' : ''}>${h.toFixed(1)} m</option>`),
  ].join('');
}

function stationTypeOptions(cur, proposed) {
  return [
    `<option value="">${proposed ? '— choose one —' : '— not recorded —'}</option>`,
    ...Object.entries(STATION_TYPE_LABEL).map(([k, v]) =>
      `<option value="${escAttr(k)}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`),
  ].join('');
}

// ── Who owns it ─────────────────────────────────────────────────────────────
// The Owner field says what the station card's Owner row says (stationOwner,
// app.js), each party's logo before its name (OwnerLogos). Where that is the
// Bureau's Service Level Specification the SLS is the word on it, so the field
// is a read-only box, as the wind region's is, with "per SLS" beside its
// caption — not in the box, which in the side panel's half column has room
// for a logo and a name and little more. Only a station the SLS names nobody
// for — one it does not list, a proposal, a "+ New" — gets a box to type in,
// for the owner recorded on the station (0030), with the logo before it once
// the owner typed is one that has one.
//
// The SLS is fetched on first need, so until it lands a numbered station's
// field says it is checking and offers no box; it is filled in when the file
// arrives, and again when the Station Number box changes, since that is what
// the SLS is looked up by. With no box on screen a save leaves the recorded
// owner as it was (editorReadForm), which is what answers if the SLS ever
// stops naming one.
let editorOwnerSlsFailed = false;

// 'sls' (the SLS names it), 'wait' (it may, once the file is here) or 'box'.
function editorOwnerMode(s) {
  const o = stationOwner(s);
  if (o && o.from === 'sls') return 'sls';
  const waiting = s.station_number && typeof SLS !== 'undefined' && !SLS.loaded() && !editorOwnerSlsFailed;
  return waiting ? 'wait' : 'box';
}

// The logos of an owner typed into the box, for before it.
function editorOwnerLogosHtml(text) {
  const o = String(text || '').trim() ? stationOwnerParse(text, 'station', 'typed in the editor') : null;
  return o ? o.parties.map(p => OwnerLogos.logoHtml(p)).join('') : '';
}

// The caption's "per SLS", and the field's value: the read-only box, or the
// box to type in.
function editorOwnerFromHtml(s, mode) {
  if (mode !== 'sls') return '';
  const o = stationOwner(s);
  return `<span class="mn-pop-note" title="${escAttr(`From ${o.src}. Where the SLS names an owner, that is the owner.`)}">per SLS</span>`;
}
function editorOwnerValueHtml(s, mode) {
  if (mode === 'sls') {
    const o = stationOwner(s);
    return `<output id="ef-owner-sls" class="ef-owner-ro" title="${escAttr(`${o.name} — from ${o.src}`)}">${
      o.parties.map(p => OwnerLogos.partyHtml(p)).join(' / ')}</output>`;
  }
  if (mode === 'wait') {
    return '<output id="ef-owner-sls" class="ef-owner-ro"><span class="txt-muted">checking the SLS…</span></output>';
  }
  const tip = s.station_number && typeof SLS !== 'undefined' && SLS.loaded()
    ? 'not in the SLS — who owns it?' : 'e.g. Toowoomba Regional Council';
  return `<span class="ef-owner-in"><span class="ef-owner-logos" id="ef-owner-logos">${editorOwnerLogosHtml(s.owner)}</span><input
        type="text" id="ef-owner" value="${escAttr(s.owner || '')}" placeholder="${escAttr(tip)}"
        onchange="editorOwnerTyped(this)"></span>`;
}

function editorOwnerFieldHtml(s) {
  const mode = editorOwnerMode(s);
  return `<div class="ef-field ef-owner-field">
        <span class="ef-cap"><label for="${mode === 'box' ? 'ef-owner' : 'ef-owner-sls'}" id="ef-owner-cap">Owner</label>
          <span id="ef-owner-from">${editorOwnerFromHtml(s, mode)}</span>${hintToggleHtml('ef-h-owner', 'the owner')}</span>
        <div id="ef-owner-val" data-mn-owner="${escAttr(String(s.id || ''))}">${editorOwnerValueHtml(s, mode)}</div>
      </div>
      <div class="full small ef-hint hint-fold" id="ef-h-owner" hidden>
        Where the Bureau's Service Level Specification names the owner, that is the owner — shown
        here as on the station card, and not typed. A box is offered only for a station the SLS
        names nobody for (one it does not list, or a proposal), and what is typed there is the
        owner recorded on the station.
      </div>`;
}

// The field again for what the form now says — the number box as typed, the
// owner box's text kept — in place, so nothing else typed is thrown away.
function editorOwnerRefresh() {
  const val = document.getElementById('ef-owner-val');
  if (!val || !state.editorDraft) return;
  const num = document.getElementById('ef-stnno');
  const box = document.getElementById('ef-owner');
  const s = { ...state.editorDraft,
              station_number: num ? num.value.trim() : state.editorDraft.station_number,
              owner: box ? box.value : state.editorDraft.owner };
  const mode = editorOwnerMode(s);
  val.innerHTML = editorOwnerValueHtml(s, mode);
  const from = document.getElementById('ef-owner-from');
  if (from) from.innerHTML = editorOwnerFromHtml(s, mode);
  const cap = document.getElementById('ef-owner-cap');
  if (cap) cap.htmlFor = mode === 'box' ? 'ef-owner' : 'ef-owner-sls';
}

// Filled in once the SLS lands, if the card still shows the station it was
// asked for.
function editorOwnerAsk(s) {
  if (typeof SLS === 'undefined' || SLS.loaded() || !s.station_number) return;
  const want = String(s.id || '');
  const fill = () => {
    const val = document.getElementById('ef-owner-val');
    if (val && val.dataset.mnOwner === want) editorOwnerRefresh();
  };
  SLS.ensureData().then(fill, () => { editorOwnerSlsFailed = true; fill(); });
}

function editorOwnerTyped(box) {
  const logos = document.getElementById('ef-owner-logos');
  if (logos) logos.innerHTML = editorOwnerLogosHtml(box.value);
}

// The band across the top of the form while the station is a proposal: what a
// proposal is, and the year it is proposed for. There for every station and
// hidden unless it is proposed, so ticking the box below shows it without a
// repaint that would throw the typing away.
function editorProposalHtml(s) {
  const on = !!s.proposed;
  const year = s.proposed_year ?? (on ? new Date().getFullYear() : '');
  return `
    <div class="ef-proposal" id="ef-proposal" ${on ? '' : 'hidden'}>
      <p class="ef-proposal-lead"><span class="proposed-tag">Proposed</span>
        <strong>A proposed station</strong> — where one is meant to go, not yet established. It has no
        station number until it is; an administrator establishes it.</p>
      <label class="ef-proposal-year">Proposed for (year)
        <input type="number" id="ef-pyear" min="1900" max="2200" step="1" inputmode="numeric"
               value="${escAttr(String(year))}">
      </label>
      <p class="small ef-hint ef-proposal-hint">
        This year unless it was put forward earlier or is planned for later — date it either way.
        Where it would go is its latitude and longitude below: type them, or pick the point on the map
        with ℹ️ <em>What is here</em> and press <em>Propose a station here</em>.
      </p>
    </div>`;
}

// The Proposed box. Once a station is in the database, whether it is proposed
// is an administrator's to change — establishing a proposal is adding a
// station — so for anybody else it is shown, and not changeable, with why. A
// draft not yet saved is anybody's to tick; the database has the last word
// when it arrives, and the line under the box says what that word will be.
function editorProposedBoxHtml(s) {
  const on = !!s.proposed;
  const saved = !!state.editorId;
  const locked = saved && !editorIsAdmin();
  const why = !locked ? ''
    : on ? 'Only an administrator establishes a proposed station.'
         : 'Only an administrator takes an established station back to proposed.';
  return `
        <label class="check-label ef-proposed"${locked ? ` title="${escAttr(why)}"` : ''}>
          <input type="checkbox" id="ef-proposed" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}
                 onchange="editorProposedChanged(this.checked)"> Proposed — not yet established
        </label>`;
}

// A field whose explanation is folded behind an ⓘ (hintToggleHtml, core.js).
// Its caption is a <label for> of its own, so the button beside it is not part
// of the field's name, as it would be inside the label; the paragraph is a
// row of its own under the field, with the id `hint` names.
function efFieldHtml({ id, caption, hint, control, full = false }) {
  return `<div class="ef-field${full ? ' full' : ''}">
        <span class="ef-cap"><label for="${id}">${caption}</label>${hintToggleHtml(hint, caption)}</span>
        ${control}
      </div>`;
}

// What a signed-in editor who is not an administrator is told under the box on
// a new station — a row of its own under the status row, since the box shares
// that row with Enabled.
function editorProposedHintHtml(s) {
  const outright = !state.editorId && typeof Auth !== 'undefined' && Auth.isSignedIn() && !editorIsAdmin();
  return outright ? `<div class="full small ef-hint ef-proposed-hint" id="ef-proposed-hint" ${s.proposed ? 'hidden' : ''}>
        Only an administrator adds a station outright. Tick <em>Proposed</em> and it goes in as a proposal,
        for an administrator to establish.</div>` : '';
}

// The box ticked or unticked: the band and its year shown or put away, and the
// words beside it brought into line — in place, since a repaint of the card
// would throw away whatever has been typed.
function editorProposedChanged(on) {
  const band = document.getElementById('ef-proposal');
  if (band) band.hidden = !on;
  const year = document.getElementById('ef-pyear');
  if (on && year && !year.value) year.value = String(new Date().getFullYear());
  const hint = document.getElementById('ef-proposed-hint');
  if (hint) hint.hidden = on;
  const num = document.getElementById('ef-stnno');
  if (num) num.placeholder = on ? 'none yet — it is proposed' : '';
  const blank = document.querySelector('#ef-stype option[value=""]');
  if (blank) blank.textContent = on ? '— choose one —' : '— not recorded —';
}

// What a proposal has to say before it is sent: the three things
// save_station() asks of one, in the editor's words, so a missing one is found
// at the keyboard rather than after a round trip. Null when there is nothing
// to say, which includes every station that is not a proposal.
function editorProposalProblem(d) {
  if (!d.proposed) return null;
  const missing = [];
  if (!d.station_type) missing.push('its type');
  if (d.proposed_year == null) missing.push('the year it is proposed for');
  if (d.lat == null || d.lon == null) {
    missing.push('where it would go — its latitude and longitude, or a point picked with ℹ️ What is here');
  }
  if (missing.length) {
    const list = missing.length === 1 ? missing[0]
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
    return `Not saved — a proposed station needs ${list}. Your edits are still here.`;
  }
  if (d.proposed_year < 1900 || d.proposed_year > 2200) {
    return `Not saved — ${d.proposed_year} is not a year a station could be proposed for (1900–2200). Your edits are still here.`;
  }
  return null;
}

// A database that has not had 0039 would take a proposal as an ordinary
// station — and from anybody who may edit — so one that says it is older is
// not sent the proposal at all. whoami() says which schema answered the
// session; the Data source panel's own check says it too, if that has run.
function editorProposalsKnown() {
  const v = typeof Auth !== 'undefined' && Auth.schemaVersion ? Auth.schemaVersion() : null;
  const known = v != null ? v : (state.dbStatus && state.dbStatus.version != null ? state.dbStatus.version : null);
  return known == null || known >= 39 ? null : known;
}

// Spelled-out "Passing N ALERT addresses across M stations, in R ranges
// spanning S addresses (P% used)." above the Pass Ranges textarea (see #83).
// Empty string when the repeater has no ranges recorded — nothing to spell
// out yet, and the blank textarea below already says so.
function repeaterPassingSummaryHtml(s) {
  const ranges = s.repeater?.pass_ranges || [];
  if (!ranges.length) return '';
  const addr = repeaterPassingCount(s) ?? 0;
  const stns = findStationMatches(s).length;
  const span = repeaterPassRangeSpan(s);
  const pct  = span ? Math.round((addr / span) * 100) : 0;
  return `
        <p class="full small ef-lead">
          <strong>Passing ${addr} ALERT address${addr === 1 ? '' : 'es'} across ${stns} station${stns === 1 ? '' : 's'}</strong>,
          in ${ranges.length} range${ranges.length === 1 ? '' : 's'} spanning ${span.toLocaleString()} address${span === 1 ? '' : 'es'}
          (${pct}% used).
        </p>`;
}

// The Pass Ranges textarea below is just numbers — this translates them into
// the station names they actually mean, so the person configuring a repeater
// can tell at a glance who they'd be dropping if a range shrank. Reuses
// findStationMatches/passRangeCoversId, the same carried-station set the
// "Passing N stations" summary above counts from, so the two never disagree.
// Empty string when there are no ranges (nothing to translate) or a listed
// station's ALERT ids happen to all sit outside them despite matching some
// other way (shouldn't happen, but the filter guards against a blank row).
function repeaterCarriedStationsHtml(s) {
  const ranges = s.repeater?.pass_ranges || [];
  if (!ranges.length) return '';
  const rows = findStationMatches(s)
    .map(st => ({ st, ids: stationAlertIds(st).filter(id => passRangeCoversId(s.repeater, id)) }))
    .filter(r => r.ids.length)
    .sort((a, b) => a.ids[0] - b.ids[0]);
  if (!rows.length) {
    return `<p class="full small ef-block">No stations currently fall inside these pass ranges.</p>`;
  }
  return `
        <div class="full small ef-block">
          <div class="ef-sub">ALERT IDs in range → stations</div>
          <!-- Pattern 7a's reasoning for something that is not a table: it caps
               its own height, so it is a named region and a tab stop, or the
               names past the fold are unreachable without a mouse (#136). -->
          <div class="ef-carried" role="region" tabindex="0"
               aria-label="Stations inside these pass ranges — ${rows.length}">
            ${rows.map(({ st, ids }) => `
              <button type="button" class="link-btn ef-carried-row" onclick="goToStation('${escAttr(st.id)}')"
                   title="Open ${escAttr(st.name)} on the Stations tab">
                <strong>${ids.join(', ')}</strong> — ${esc(st.name)}
              </button>`).join('')}
          </div>
        </div>`;
}

// When Flood-Net last heard the station, under its name: the time and how
// long ago, from the one batch the station list's Last heard column reads
// (HealthGlance.heardHeadHtml), so the header says what the row it was
// picked from says. Painted in place when the batch lands or the station's
// map card learns more — a redraw would throw away whatever is being typed.
let editorHeardWatching = false;
function editorHeardHtml(s) {
  if (typeof HealthGlance === 'undefined' || !HealthGlance.heardHeadHtml || !s.id || s.proposed) return '';
  if (!editorHeardWatching) { HealthGlance.onHeard(editorHeardPaint); editorHeardWatching = true; }
  HealthGlance.askNet();
  return `<span id="ef-heard" class="small ef-heard">${HealthGlance.heardHeadHtml(s)}</span>`;
}

function editorHeardPaint(id) {
  const el = document.getElementById('ef-heard');
  if (!el || !state.editorId || !state.data) return;
  if (id != null && String(id) !== String(state.editorId)) return;
  const s = state.data.stations.find(x => x.id === state.editorId);
  if (s) el.innerHTML = HealthGlance.heardHeadHtml(s);
}

// Its checks, slot by slot, at the head of Telemetry — what its checks carry:
// the Station Health tab's strip, from the station card's own request, which
// HealthGlance.checksHtml asks for if the card has not and shares with it.
// Painted in place when the answer lands, as the header's stamp is.
let editorChecksWatching = false;
function editorChecksHtml(s) {
  if (typeof HealthGlance === 'undefined' || !HealthGlance.checksHtml || !s.id || s.proposed) return '';
  if (!editorChecksWatching) { HealthGlance.onHeard(editorChecksPaint); editorChecksWatching = true; }
  return `<div id="ef-checks" class="ef-checks">${HealthGlance.checksHtml(s)}</div>`;
}

function editorChecksPaint(id) {
  const el = document.getElementById('ef-checks');
  if (!el || !state.editorId || !state.data) return;
  if (id == null || String(id) !== String(state.editorId)) return;
  const s = state.data.stations.find(x => x.id === state.editorId);
  if (s) el.innerHTML = HealthGlance.checksHtml(s);
}

function editorForm(s) {
  const hasRep  = s.roles.includes('repeater');
  const hasBase = s.roles.includes('base');
  const sensors = stationSensors(s).slice().sort((a, b) => (a.alert_id ?? 0) - (b.alert_id ?? 0));
  const dbId    = arroSiteId(s);
  // Every action the station card on the map offers, from the same builder,
  // under the same names and in the same order (stationActionGroups, app.js) —
  // the editor's versions of the ones that read the coordinate boxes or are
  // repainted in place, and no Station details, which is this card. The card is
  // where a coordinate is *edited*: a pin dragged in from the map or a figure
  // typed over one has to be what Copy and Directions hand over, and reading
  // the boxes at the press is the only version of that which cannot go stale.
  //
  // What the app does with the station leads the card, under its header, as it
  // leads the station card's list. The other three go under the coordinate
  // boxes: the position's own, then somebody else's picture of the ground (the
  // KML download among them, #176), then the paperwork. A two-column list under
  // each name (.pill-list), as on the card. A group with nothing in it is not
  // drawn: a "+ New" draft has nothing for the app to do with it yet and no pin
  // to move, and a station with no position has only its two searches.
  const groups  = stationActionGroups(s, { editor: true });
  const inApp   = groups.filter(g => g.label === 'In Flood-Net');
  const actions = groups.filter(g => g.label !== 'In Flood-Net')
    .map(g => ({ ...g, cls: g.label === 'Position' ? ' ef-movepin' : '' }));
  const groupHtml = g => `<div class="pill-row pill-list${g.cls || ''}" role="group" aria-label="${escAttr(g.label)}">
          ${g.pills.join('\n          ')}
        </div>`;
  // The wind region the station's coordinate falls in — the same answer the
  // station card on the map gives, so the two cards never disagree. Read now, and
  // filled in when the polygons land if this page has not needed them yet.
  const wind    = MapWind.regionState(s.lat, s.lon);
  MapWind.askRegion('ef-wind', s.lat, s.lon);
  editorOwnerAsk(s);
  return `
    <div class="panel-header ef-head"><div class="ef-head-in">
      <h3>${esc(s.name) || (s.proposed ? 'New Proposed Station' : 'New Station')}</h3>
      ${editorHeardHtml(s)}
      <div class="button-group">
        <!-- Undo, only while something is unsaved (editorUnsavedRefresh shows
             it): every change thrown away at once, the card back to what the
             database holds. The bar at the card's foot carries one too. -->
        <button type="button" id="ef-undo" onclick="editorUndo()" hidden
                title="Throw away the unsaved changes — back to what the database holds">Undo</button>
        <!-- Signed out, the button is not disabled and does not fail at the
             network: it says what is missing and opens the panel that supplies
             it. A greyed-out Save with no explanation is the version of this
             that generates the support email. -->
        ${dbCanWrite()
          ? `<button class="primary" id="ef-save" onclick="editorSave()" ${state.editorBusy ? 'disabled' : ''}>Save</button>`
          : `<button class="primary" id="ef-save" onclick="Auth.open()" title="Saving needs a signed-in session">Sign in to save</button>`}
        ${s.id ? `<button id="ef-delete" class="btn-danger" onclick="editorDelete()" ${state.editorBusy ? 'disabled' : ''}
                          >Delete</button>` : ''}
      </div>
    </div></div>
    <!-- Save writes to the database and waits for it, so this line is where the
         answer arrives: saved and when, refused and why. A failed save leaves
         everything below untouched — the typing is the thing being protected. -->
    <div id="ef-status" class="small ef-status">${editorStatusHtml()}</div>
    <!-- A proposal says so first (0039): the band, and the year it is for. -->
    ${editorProposalHtml(s)}
    <!-- What the app can do with the station, first, as on the station card:
         the list, the map, a link to it, its readings, its twin, its photos. -->
    ${inApp.length ? `<div class="ef-pills ef-pills-top">
        ${inApp.map(groupHtml).join('\n        ')}
      </div>` : ''}
    <!-- The form in the sections a station is thought about in, each under a
         heading of its own: what it is, where it is, what it sends — then the
         repeater's radio, the Bureau's lists, ARRO and the inspections, which
         were sections already. It had been one grid in the order the fields
         were added, so each box was paired with whatever came after it. -->
    <h4 class="ef-h ef-h-top">Station</h4>
    <div class="form-grid ef-grid">
      <label>Name<input type="text" id="ef-name" value="${esc(s.name)}"></label>
      <label>Station Number<input type="text" id="ef-stnno" value="${esc(s.station_number || '')}"
             ${s.proposed ? 'placeholder="none yet — it is proposed"' : ''} onchange="editorOwnerRefresh()"></label>
      <!-- What kind of station it is, or is to be, and whether it is only
           proposed (0039). The type is asked of every proposal and allowed on
           any station; the box is an administrator's once the station is saved. -->
      <label>Station type
        <select id="ef-stype">${stationTypeOptions(s.station_type, s.proposed)}</select>
      </label>
      <!-- Who owns it, beside what it is: the station card's Owner row, logo
           and all — the SLS's word where it names one, and a box only where
           it does not (editorOwnerFieldHtml). -->
      ${editorOwnerFieldHtml(s)}
      <!-- A river-gauge tower's platform height (0040): the standard drawing's
           two, each on a 2100 × 2100 footing. Blank is not recorded, which the
           Digital Twin draws as the 3.0 m default. -->
      <label>Tower platform height
        <select id="ef-tower">${towerHeightOptions(s.tower_height)}</select>
      </label>
      <!-- The way the station faces (0044): the bearing its front — enclosure
           door, or a tower's ladder — looks out. Blank is not recorded, which
           the Digital Twin draws facing south. Its 🧭 Orientation tool sets it
           by eye. Beside the tower's height: both are how it is built. -->
      <label>Faces (° from north)<input type="number" id="ef-facing" min="0" max="359.9" step="0.1" inputmode="decimal"
             value="${s.facing_deg == null ? '' : esc(String(s.facing_deg))}" placeholder="not recorded (south)"
             title="The bearing the station's front — its enclosure door, or a tower's ladder — faces, clockwise from true north"></label>
      <label class="full">Roles
        <div class="ef-roles">
          ${Object.keys(ROLE_LABEL).map(r => `
            <label class="check-label ef-role">
              <input type="checkbox" name="ef-roles" value="${r}" ${s.roles.includes(r) ? 'checked' : ''}> ${r}
            </label>`).join('')}
        </div>
      </label>
      <!-- The station's two states, on one row of their own: whether it is only
           proposed (0039) and whether it is enabled. Both are a box and its
           words, and a row each in the two-column grid would split the pairs
           around them. -->
      <div class="full ef-flags">
        ${editorProposedBoxHtml(s)}
        <label class="check-label ef-enabled">
          <input type="checkbox" id="ef-enabled" ${s.enabled ? 'checked' : ''}> Enabled
        </label>
      </div>
      ${editorProposedHintHtml(s)}
      <label class="full">Notes<textarea id="ef-notes">${esc(s.notes || '')}</textarea></label>
    </div>
    <hr>
    <h4 class="ef-h">Location</h4>
    <div class="form-grid ef-grid">
      <label>Latitude<input type="number" step="any" id="ef-lat" value="${s.lat ?? ''}"></label>
      <label>Longitude<input type="number" step="any" id="ef-lon" value="${s.lon ?? ''}"></label>
      <!-- Typing a coordinate is the exact form of this that nobody can check.
           Move pin arms map-move-pin.js: the pin comes off the map, goes where
           the station is, and writes these two boxes on the way back. Copy and
           Directions are the other direction — the position out of here and
           into whatever is being written somewhere else, or driven to. All of
           them belong to the two boxes above, so the Position group comes
           first, directly under them, and the groups that leave the site
           follow it. -->
      ${actions.length ? `<div class="full ef-pills">
        ${actions.map(groupHtml).join('\n        ')}
      </div>` : ''}
      <label>Elevation AHD (m)<input type="number" step="any" id="ef-elev" value="${s.elevation_ahd ?? ''}"></label>
      <!-- Read-only because it is not a property of the station: it is where the
           station's coordinate falls on AS/NZS 1170.2's map, so moving the pin
           above changes it and typing in it could only ever be wrong. A field
           rather than a note all the same — it holds a value worth copying into
           a mast calculation, which is exactly what input[readonly] is for
           (design-system.md §3). Filled in behind the fetch when the polygons
           are not on hand yet; see MapWind.askRegion(). -->
      <label>Wind region (AS/NZS 1170.2)
        <input type="text" id="ef-wind" readonly value="${escAttr(wind.text)}"
               data-mn-wind="${escAttr(`${s.lat},${s.lon}`)}" title="${escAttr(wind.title)}">
      </label>
      <!-- Beside the wind region for the same reason it is read-only: it is not
           typed, it is worked out — from the AEP flood levels below and the
           assumptions on their row (flood-velocity.js). -->
      <label class="full">Flood velocity (indicative)
        <input type="text" id="ef-flood-vel" readonly value="${escAttr(RiverDetails.velocitySummary(s))}"
               title="Estimated peak flood velocity from the AEP flood levels, by Manning’s equation. The workings are on the station card; the setting, slope and Manning n are on the AEP row below.">
      </label>
    </div>
    <hr>
    <h4 class="ef-h">Telemetry</h4>
    ${editorChecksHtml(s)}
    <div class="form-grid ef-grid">
      ${efFieldHtml({ id: 'ef-insp-config', caption: 'Telemetry / inspection form', hint: 'ef-h-insp', full: true,
        control: `<select id="ef-insp-config">${editorInspConfigOptions(s.inspection_config_key)}</select>` })}
      <div class="full small ef-hint hint-fold" id="ef-h-insp" hidden>
        Which of the six inspection sheets a crew prints at this site — the Inspections tab
        pre-selects its form from this. “Not recorded” means nobody has said yet, and the form
        asks rather than guesses; leave it that way unless you know the site's telemetry.
      </div>
      <!-- The logger at the site — its LPU type, serial number and versions
           (0090, station-lpu.js) — kept in a table of its own, read by
           approved accounts, and saved by editorSave() after the station. -->
      ${typeof StationLpu !== 'undefined' ? StationLpu.editorHtml(s) : ''}
      <label>RM System ID<input type="number" id="ef-rmsys" value="${s.rm_system_id || 1}"></label>
      ${efFieldHtml({ id: 'ef-bucket', caption: 'TBRG bucket size (mm/tip)', hint: 'ef-h-bucket',
        control: `<input type="number" step="0.1" min="0" id="ef-bucket" value="${s.TBRGbucketSize ?? ''}" placeholder="not recorded">` })}
      <div class="full small ef-hint hint-fold" id="ef-h-bucket" hidden>
        Blank means not recorded, not zero — the app falls back to an assumed 0.2 mm/tip wherever it
        converts a rain gauge count and says so. ${bucketSizeGapNote()}
      </div>
      <div class="full ef-section">
        <div class="ef-section-head">
          <div class="ef-sub">ALERT IDs / Sensors${sensors.length ? ` <span class="small ef-plain">— ${sensors.length}</span>` : ''}
            ${hintToggleHtml('ef-h-sensors', 'the ALERT IDs and sensors')}</div>
          <button type="button" onclick="editorAddSensorRow()">+ Add sensor</button>
        </div>
        <!-- Under the heading its ⓘ is beside, rather than under the rows, so
             it opens where it was asked for however many rows there are. -->
        <div class="small ef-note hint-fold" id="ef-h-sensors" hidden>
          One row per ALERT address and what it measures — rainfall, water level, battery, etc.
          The line on each row is the last seven days of what that address has sent, out of the
          Flood-Net datastore: volts for a battery, the rain fallen for a rain gauge (the rain in
          each six hours for an increment), the raw count for a level. Press it for the chart, and
          from there <b>Open in Field Data</b> for the whole tool.
          <b>Flip</b> takes the row's address to the Bit Flipper, which says what else it could
          have been.${
            dbId != null ? ' Rows whose sensor carries an ARRO device id link straight to its admin page.' : ''}
        </div>
        <div id="ef-sensors">
          ${sensors.map(se => sensorRowHtml(se, dbId)).join('')}
        </div>
        ${efFieldHtml({ id: 'ef-a2stn', caption: 'ALERT2 station address', hint: 'ef-h-a2stn',
          control: `<input type="number" id="ef-a2stn" min="1" max="65535" value="${s.alert2_station_id ?? ''}"
                 placeholder="none — this station is not relayed over ALERT2"
                 onchange="editorRefreshA2Seen()">` })}
        <div class="small ef-note hint-fold" id="ef-h-a2stn" hidden>
          Set this only when the station's readings reach Flood-Net relayed over ALERT2 — an
          ELPRO 115E-2 publishes them under this address, and it is what attributes them here.
          The <b>A2 slot</b> on each row above then says which of that station's sensors the row is.
          One address belongs to one station: claiming one another station holds is refused.
        </div>
        <div id="ef-a2-seen" class="small ef-note"></div>
        <!-- Its carrier fingerprint, as its card on the map has it
             (health-drift.js): after the addresses it sends on, because it is
             how those sends arrive. -->
        ${typeof HealthDrift !== 'undefined' ? HealthDrift.editorHtml(s) : ''}
        <datalist id="ef-sensor-types">
          ${['Rainfall', 'Rainfall Increment', 'Water Level', 'Water Level - AHD', 'Battery', 'Air Temperature', 'Relative Humidity', 'Wind Speed', 'Wind Gust', 'Wind Direction', 'pH', 'Conductivity', 'Dissolved Oxygen', 'Water Temperature', 'Turbidity'].map(t => `<option value="${esc(t)}">`).join('')}
        </datalist>
      </div>
    </div>
    ${hasRep ? `
      <hr>
      <h4 class="ef-h">Repeater configuration</h4>
      <!-- Its licence and delay, its radio, then what it passes: the two lists
           of ranges side by side, and under them what they come to — the count
           and the stations — which read the ranges above them. -->
      <div class="form-grid ef-grid">
        <label>ACMA Licence<input type="text" id="ef-acma" value="${esc(s.repeater?.acma_licence || '')}"></label>
        ${efFieldHtml({ id: 'ef-delay', caption: 'Repeater delay (ms)', hint: 'ef-h-delay',
          control: `<input type="number" min="0" max="999" step="1" id="ef-delay"
                 value="${s.repeater?.delay_ms ?? ''}" placeholder="not set">` })}
        <div class="full small ef-hint hint-fold" id="ef-h-delay" hidden>
          How long this repeater waits before re-transmitting a message its pass ranges accept.
          Blank means not set, not zero.
        </div>
        ${(() => {
          // The suggestion is not explanation: it is this repeater's own figure,
          // so it stays on screen when the paragraph above it is folded.
          const sug = typeof RepeaterDelays !== 'undefined' ? RepeaterDelays.suggestion(s) : null;
          if (!sug) return '';
          return sug.status === 'free' || !sug.cluster ? `<div class="full small ef-hint">
          Suggested: <strong>any</strong> — no other repeater relays its readings to a receiver that hears both
          (<button type="button" class="link-btn" onclick="switchTab('repdelays')">⏳ Repeater Delays</button>).
        </div>` : `<div class="full small ef-hint">
          Suggested: <strong>${sug.delay} ms</strong> — group ${sug.cluster} of the
          <button type="button" class="link-btn" onclick="switchTab('repdelays')">⏳ Repeater Delays</button> plan, set so
          the repeaters relaying the same readings never send their copies on top of each other.
        </div>`;
        })()}
        <!-- The repeater's own RX/TX pair first (ef-rx, ef-tx — what every path
             tool reads), then a row per other channel, with + Add (0033). -->
        ${Frequencies.editorHtml(s, { primary: true })}
        <label><span>Pass ranges (one per line: <em>low-high</em>)</span>
          <textarea id="ef-pass" rows="5">${(s.repeater?.pass_ranges || []).map(r => `${r.low}-${r.high}`).join('\n')}</textarea>
        </label>
        <label><span>Exclusions (one per line: <em>low-high</em>)</span>
          <textarea id="ef-excl" rows="5">${(s.repeater?.exclusions || []).map(r => `${r.low}-${r.high}`).join('\n')}</textarea>
        </label>
        ${repeaterPassingSummaryHtml(s)}
        ${repeaterCarriedStationsHtml(s)}
      </div>` : ''}
    ${hasBase && !hasRep ? `
      <hr>
      <h4 class="ef-h">Base station radio</h4>
      <!-- A base station has no repeater row, so every pair it uses is a row
           here (0033). A base that is also a repeater keeps them above. -->
      <div class="form-grid ef-grid">
        ${Frequencies.editorHtml(s)}
      </div>` : ''}
    <!-- The station it takes its flood history from (0041), by id: for a
         station with no gauge of its own, such as a proposal beside one. A
         Bureau question, so it is among the Bureau's fields. -->
    ${RiverDetails.editorHtml(s, { more: `<label>Flood history from<input type="text" id="ef-fpfrom" value="${esc(s.flood_peaks_from || '')}"
             placeholder="a station's id, e.g. gatton" title="The Bureau's floods at that station's gauge are shown for this one while it has no gauge of its own"></label>` })}
    ${editorArroSection(s, sensors)}
    ${StationInspections.sectionHtml(s)}
    <!-- Edits not saved yet: how many, which, and a Save — stuck to the foot of
         the card while any of it is in view, and only there while there is
         something unsaved to say (editorUnsavedRefresh). -->
    <div class="ef-unsaved" id="ef-unsaved" role="status" hidden></div>`;
}

// The telemetry-type pick-list (#147). The six configurations come from
// meganet.inspection_config via the Inspections tab's reference load — one
// list, no second copy — so the options may not be here yet on the first
// render. Rather than repainting the whole card when they arrive (which would
// throw away anything typed since), the callback rebuilds this one select in
// place, keeping whatever it was set to.
function editorInspConfigOptions(currentKey) {
  const cur  = currentKey || '';
  const list = Inspections.configs();
  // While the list is loading, a recorded value still shows — as its key,
  // which the fill below upgrades to its label.
  const opts = list.length ? list : (cur ? [{ key: cur, label: cur }] : []);
  Inspections.ensureRefs(editorFillInspConfigSelect);
  return [
    '<option value="">— not recorded —</option>',
    ...opts.map(c => `<option value="${escAttr(c.key)}"${c.key === cur ? ' selected' : ''}>${esc(c.label)}</option>`),
  ].join('');
}

function editorFillInspConfigSelect() {
  const sel = document.getElementById('ef-insp-config');
  if (!sel || !Inspections.configs().length) return;
  // Marked selected is the record's, and chosen is whatever the box was set
  // to — which differ when somebody picked one before the list arrived, and
  // that pick is an unsaved change still (editorUnsavedChanged).
  const was = [...sel.options].find(o => o.defaultSelected)?.value || '';
  const cur = sel.value;
  sel.innerHTML = editorInspConfigOptions(was);
  sel.value = cur;
}

// The ARRO block at the foot of the editor. Read-only throughout: these ids come
// from ARRO's own export and editing them here would only desynchronise us from
// it. The site id is spelled out next to the station number precisely because
// the two get confused — the number is BoM's, the site id is ARRO's index, and
// only the latter opens a page.
function editorArroSection(s, sensors) {
  const dbId  = arroSiteId(s);
  const site  = s.site || {};
  const admin = arroSiteUrl(dbId);
  const graph = buildArroUrl(sensors.map(se => ({ station: s, sensor: se })));
  const withDev = sensors.filter(se => se.device_id != null).length;

  if (dbId == null) {
    return `
      <hr>
      <h4 class="ef-h">ARRO</h3>
      <p class="small ef-flush">
        <strong>No ARRO site id recorded</strong> for this station, so there is no admin page to
        link to. 390 of 3,174 stations are in the same position — the site id arrives with the
        ARRO sensor export (<code>tools/import_arro_sensors.py</code>) and a station missing from
        that export has no <code>site.db_id</code> here either.
      </p>`;
  }

  return `
    <hr>
    <h4 class="ef-h">ARRO</h4>
    <div class="form-grid ef-grid">
      <label><span>ARRO site id <span class="small ef-plain">— ARRO's key, not BoM's</span></span>
        <input type="text" readonly value="${esc(dbId)}" title="site.db_id — the id every ARRO URL takes">
      </label>
      <label><span>Station number <span class="small ef-plain">— BoM's</span></span>
        <input type="text" readonly value="${esc(site.number || s.station_number || '—')}">
      </label>
      <label class="full">Site name in ARRO
        <input type="text" readonly value="${esc(site.name || '—')}">
      </label>
    </div>
    <!-- The two ways into ARRO, as the list the Location section's links are
         (.pill-list), without a heading: the section's own says where they go. -->
    <div class="pill-row pill-list ef-actions">
      <a class="pill" href="${esc(admin)}" target="_blank" rel="noopener"
         title="Site administration page in ARRO">${pillText('📊', `${pillLong('Open site in ')}ARRO admin`, '↗')}</a>
      ${graph ? `<a class="pill" href="${esc(graph.url)}" target="_blank" rel="noopener"
         title="Last 7 days for ${graph.count} sensor${graph.count !== 1 ? 's' : ''}">${pillText('📈', 'Graph last 7 days', '↗')}</a>` : ''}
    </div>
    <p class="small st-note">
      ${withDev
        ? `${withDev} of ${sensors.length} sensor${sensors.length !== 1 ? 's' : ''} carry an ARRO device id —
           each of those rows above links to its own sensor admin page.`
        : `None of this station's sensors carry an ARRO device id, so there are no per-sensor
           admin pages to link to.`}
    </p>`;
}

// One editable sensor row: ALERT id, ALERT2 slot and type, with the
// national-export metadata (sensor_id, device_id) preserved on data-attributes
// so a round-trip keeps it — and, after the type, the slot sensor-sparks.js
// fills with the last seven days of what the row's address has sent, which
// opens a chart of it. Drawn empty here; SensorSparks.fill() reads the boxes
// once the card is on screen, as editorRefreshA2Seen() does.
//
// Two address boxes rather than one, because they are two different things. An
// ALERT address is global and identifies the sensor on its own; an ALERT2 slot
// is a position inside whichever relayed station this row's station is, and only
// means anything alongside the station address above. A sensor may have either,
// or both — an instrument that reports over the radio and is also relayed is one
// instrument, and one row.
//
// `dbId` is the station's ARRO site id, passed in because a sensor record has
// only half of what an ARRO sensor page needs. When both keys are present the
// row carries its own admin link rather than a second list of them below.
function sensorRowHtml(se, dbId) {
  se = se || {};
  const url = arroSensorUrl(dbId, se.device_id);
  return `
    <div class="sensor-row" data-sensor-id="${esc(se.sensor_id || '')}" data-device-id="${se.device_id ?? ''}">
      <input type="number" class="sensor-aid" value="${se.alert_id ?? ''}" placeholder="ALERT ID"
             aria-label="ALERT address" oninput="editorSyncSensorFlip(this)">
      <input type="number" class="sensor-a2id" value="${se.alert2_sensor_id ?? ''}" placeholder="A2 slot"
             min="0" max="254"
             aria-label="ALERT2 sensor slot"
             title="The sensor slot within the relayed ALERT2 station, 0-254. Leave empty unless this station's readings arrive over an ELPRO ALERT2 relay.">
      <input type="text" class="sensor-type" list="ef-sensor-types" value="${esc(se.type || '')}"
             aria-label="Sensor type"
             placeholder="Sensor type (e.g. Rainfall)">
      ${typeof SensorSparks !== 'undefined' ? SensorSparks.slotHtml() : ''}
      <span class="sensor-acts">
        <button type="button" class="link-btn sensor-flip" onclick="editorOpenSensorFlip(this)"
                ${isBfAddress(pInt(se.alert_id)) ? '' : 'disabled'}
                aria-label="Open this row's ALERT address in the Bit Flipper"
                title="Open this row's ALERT address in the Bit Flipper — what else it could be, one or more bit-flips away">Flip</button>
        <span class="sensor-arro small">${url
          ? `<a href="${esc(url)}" target="_blank" rel="noopener"
               title="ARRO admin for device ${esc(se.device_id)} on site ${esc(dbId)}">ARRO ↗</a>`
          : ''}</span>
        <button type="button" class="sensor-del btn-danger" title="Remove this sensor"
                onclick="editorRemoveSensorRow(this)"><span aria-hidden="true">×</span></button>
      </span>
    </div>`;
}

// The Bit Flipper, asked of the row you are looking at. A mis-set dip switch or
// a flipped bit on the wire turns one ALERT address into another that is one bit
// away, so "what else could this address be?" is a question about a specific
// sensor — and until now answering it meant reading the number off this row,
// switching tabs and typing it back in.
//
// The address is read out of the box at click time rather than baked into the
// button, because the box is editable and the record behind it may be minutes
// old: a row retyped from 6129 to 6130 and not yet saved would otherwise send
// you to the address you just stopped believing in, which is the one kind of
// wrong a link like this must not be.
//
// Switching tabs discards anything typed into this form and not saved — the
// editor card is redrawn from the stored record on the way back, the same as it
// is for the "ALERT IDs in range → stations" links above.
function editorOpenSensorFlip(el) {
  const id = pInt(el.closest('.sensor-row')?.querySelector('.sensor-aid')?.value);
  if (!isBfAddress(id)) return;
  openBitFlipper(id);
}

// …and what keeps that button honest while the box is being typed into. Rendering
// alone is not enough: a new row starts with no address at all, and a half-typed
// one is not an address either. Disabled is the truthful state for both — a
// control that is offered and then does nothing when pressed is worse than one
// that says it has nothing to act on.
function editorSyncSensorFlip(input) {
  const btn = input.closest('.sensor-row')?.querySelector('.sensor-flip');
  if (btn) btn.disabled = !isBfAddress(pInt(input.value));
}

function editorAddSensorRow(a2Slot) {
  const box = document.getElementById('ef-sensors');
  if (!box) return;
  const slot = a2Slot == null ? null : pInt(a2Slot);
  box.insertAdjacentHTML('beforeend', sensorRowHtml(slot == null ? {} : { alert2_sensor_id: slot }));
  const row = box.querySelector('.sensor-row:last-child');
  // New since the card was drawn, so whatever it holds is a change — the slot
  // a row from the heard list arrives with included (editorUnsavedChanged).
  row?.setAttribute('data-ef-added', '');
  editorUnsavedRefresh();
  // A row added from the heard-slots list below already knows its address; what
  // it is waiting for is what the thing measures, so that is where the cursor
  // goes. An empty row still starts at the ALERT box.
  row?.querySelector(slot == null ? '.sensor-aid' : '.sensor-type')?.focus();
  if (slot != null) {
    editorRefreshA2Seen();
    if (typeof SensorSparks !== 'undefined') SensorSparks.fill();
  }
}

// What the relayed ALERT2 station has actually sent, whether or not anybody has
// named it.
//
// This is the second half of claiming a station: the address on its own says
// whose the traffic is, and this says which slots it arrived on — 0-254 with no
// list anywhere on the wire, so without it naming a sensor means guessing at a
// number or reading the Message Log with a notepad. meganet.a2_sensor_seen is a
// view over the readings themselves, so it states what happened rather than what
// somebody expected.
//
// Filled in the background the way fetchEditorStamp() is, and for the same
// reason: nothing here should make the operator wait before typing.
async function editorFillA2Seen(a2) {
  const box = document.getElementById('ef-a2-seen');
  if (!box) return;
  state.editorA2For = a2;
  if (a2 == null) { box.innerHTML = ''; return; }

  let rows;
  try {
    rows = await dbSelect(`a2_sensor_seen?a2_station=eq.${encodeURIComponent(a2)}` +
                          '&select=a2_sensor,n,last_ts,last_value,named_as&order=a2_sensor.asc');
  } catch (_) {
    // Silent. This is a convenience over live data, and the form works without
    // it — an offline editor should not grow an error where a hint used to be.
    rows = null;
  }
  // The operator may have moved to another station, or changed the address, in
  // the time the round trip took.
  if (state.editorA2For !== a2) return;
  const el = document.getElementById('ef-a2-seen');
  if (!el) return;
  if (!rows || !rows.length) { el.innerHTML = ''; return; }

  const named = new Set([...document.querySelectorAll('#ef-sensors .sensor-a2id')]
    .map(i => pInt(i.value)).filter(v => v != null));
  const items = rows.map(r => {
    const has = named.has(r.a2_sensor) || r.named_as;
    const last = r.last_value == null ? '' : ` · last ${esc(String(r.last_value))}`;
    return `<li>slot <b>${esc(String(r.a2_sensor))}</b> — ${esc(String(r.n))} reading${r.n === 1 ? '' : 's'}${last}
      ${has ? '· named above'
            : `<button type="button" onclick="editorAddSensorRow(${escAttr(String(r.a2_sensor))})">Name it</button>`}</li>`;
  }).join('');

  el.innerHTML = `Heard from ALERT2 station ${esc(String(a2))}:
    <ul class="ef-a2-list">${items}</ul>`;
}

// Re-read the address box and refill the list under it. Called when the address
// changes and after a slot is named, so the list and the rows above it never
// disagree about what is still waiting.
function editorRefreshA2Seen() {
  editorFillA2Seen(pInt(document.getElementById('ef-a2stn')?.value));
}

// Best-effort legacy `alert_ids` object derived from the sensor rows, so exports
// and any older consumers still get rainfall/battery/water_level values. The
// `sensors` array is the source of truth for display.
function deriveLegacyAlertIds(sensors) {
  const out = {};
  const wl = [];
  sensors.forEach(se => {
    // ALERT addresses only. A relayed sensor has an ALERT2 slot and no address,
    // and this object is the legacy `alert_ids` shape — putting an undefined in
    // it would write `"rainfall": null` into the document for a station whose
    // rain gauge is simply reached another way.
    if (se.alert_id == null) return;
    const t = (se.type || '').toLowerCase();
    if (t.includes('rain'))       { if (out.rainfall == null) out.rainfall = se.alert_id; }
    else if (t.includes('batt'))  { if (out.battery  == null) out.battery  = se.alert_id; }
    else if (t.includes('level')) { if (!wl.includes(se.alert_id)) wl.push(se.alert_id); }
  });
  if (wl.length === 1) out.water_level = wl[0];
  else if (wl.length > 1) out.water_level = wl;
  return out;
}

// The card's Copy lat, lon pill. Reads the two boxes rather than the record the
// card was drawn from, because those are the two things that move: map-move-pin
// writes a dragged position straight into them and deliberately does *not*
// re-render the card (a re-render would put the old coordinates back), and a
// person can type over them at any time. What is on screen is what gets copied.
//
// pFloat() rather than the raw strings, so half-typed input ("-33." or "  ")
// copies as nothing — and copyStationLatLon() says so on the button — instead
// of putting a broken coordinate on the clipboard. Formatted by the same
// stationLatLonText() the map's own Copy pill uses, so the two never disagree about how
// many digits a position has.
function editorCopyLatLon(btn) {
  copyStationLatLon(btn, stationLatLonText(editorBoxesLatLon()));
}

// Directions from the editor card, to the boxes for the same reason
// (directionsPillHtml's `live`): the link's href is put right just before the
// browser follows it. `press` is the click — the one call that can say there is
// nowhere to drive to, and stop the link opening a map of the old position.
function editorDirections(a, press = true) {
  const url = stationDirectionsUrl(editorBoxesLatLon());
  if (url) { a.href = url; return true; }
  if (press) flashPill(a, '✗', 'No position', 'There is no latitude and longitude to give directions to');
  return false;
}

function editorBoxesLatLon() {
  return { lat: pFloat(document.getElementById('ef-lat')?.value),
           lon: pFloat(document.getElementById('ef-lon')?.value) };
}

// Read the form into a station record. Split out of editorSave() because the
// save now happens between reading the form and touching anything else, and a
// function that reads the DOM is worth being able to point at.
function editorReadForm() {
  const stations = state.data.stations;
  const d = { ...state.editorDraft };

  d.name           = document.getElementById('ef-name')?.value.trim()  || d.name;
  d.station_number = document.getElementById('ef-stnno')?.value.trim() || '';
  d.lat            = pFloat(document.getElementById('ef-lat')?.value);
  d.lon            = pFloat(document.getElementById('ef-lon')?.value);
  d.elevation_ahd  = pFloat(document.getElementById('ef-elev')?.value);
  // Empty stays empty. This read `|| 1` until #172: 0022 made rm_system_id
  // nullable for the station that has no radio system, and `parseInt('') || 1`
  // put 1 back on every save — silently, since the box shows 1 either way.
  // save_station() stopped defaulting it in the same change.
  d.rm_system_id   = pInt(document.getElementById('ef-rmsys')?.value);
  const bucket = pFloat(document.getElementById('ef-bucket')?.value);
  if (bucket != null && bucket > 0) d.TBRGbucketSize = bucket; else delete d.TBRGbucketSize;
  d.enabled        = document.getElementById('ef-enabled')?.checked ?? true;
  d.notes          = document.getElementById('ef-notes')?.value || '';
  // Absent rather than empty when the box is blank — the shape station_json
  // emits, so a save that set nothing round-trips without gaining a key. No
  // box on screen — the SLS names the owner, or is still being fetched — is
  // the recorded owner left as it was (editorOwnerFieldHtml).
  const ownerBox = document.getElementById('ef-owner');
  const owner = (ownerBox ? ownerBox.value : String(d.owner || '')).trim();
  if (owner) d.owner = owner; else delete d.owner;
  // The proposal (0039), the same way: `proposed` only where it is, and the
  // type and the year absent where blank — so a station that never was one
  // round-trips without gaining a key. The year stays when a proposal is
  // established, as the record of what was proposed.
  const proposedBox = document.getElementById('ef-proposed');
  const proposed = proposedBox ? proposedBox.checked : !!d.proposed;
  if (proposed) d.proposed = true; else delete d.proposed;
  const stype = document.getElementById('ef-stype')?.value || '';
  if (stype) d.station_type = stype; else delete d.station_type;
  // 0040's, the same way: absent where blank.
  const towerBox = document.getElementById('ef-tower');
  const tower = towerBox ? pFloat(towerBox.value) : (d.tower_height ?? null);
  if (tower != null) d.tower_height = tower; else delete d.tower_height;
  // 0044's, the same way: absent where blank, 360 being north again.
  const facingBox = document.getElementById('ef-facing');
  const facing = facingBox ? pFloat(facingBox.value) : (d.facing_deg ?? null);
  if (facing != null) d.facing_deg = ((facing % 360) + 360) % 360; else delete d.facing_deg;
  const fpBox = document.getElementById('ef-fpfrom');
  const fpFrom = fpBox ? fpBox.value.trim() : (d.flood_peaks_from || '');
  if (fpFrom) d.flood_peaks_from = fpFrom; else delete d.flood_peaks_from;
  const yearBox = document.getElementById('ef-pyear');
  const pyear = yearBox ? pInt(yearBox.value) : (d.proposed_year ?? null);
  if (pyear != null) d.proposed_year = pyear; else delete d.proposed_year;
  d.roles          = [...document.querySelectorAll('input[name="ef-roles"]:checked')].map(b => b.value);
  const inspCfg = document.getElementById('ef-insp-config')?.value || '';
  if (inspCfg) d.inspection_config_key = inspCfg; else delete d.inspection_config_key;
  // Absent rather than null when the box is empty, so a station that is not
  // relayed carries no ALERT2 key at all — the same shape station_json emits.
  const a2stn = pInt(document.getElementById('ef-a2stn')?.value);
  if (a2stn != null) d.alert2_station_id = a2stn; else delete d.alert2_station_id;

  // The Bureau's flood warning lists (0031, 0032): only the lists this form
  // changed go in the document. A list left out is one save_station() leaves as
  // it is — which is what keeps an untouched 94.50 from coming back as 94.5 (see
  // the head of river-details.js). The three fields beside them are ordinary
  // optional keys, absent when blank, like the owner above.
  for (const k of RiverDetails.LIST_KEYS) delete d[k];
  Object.assign(d, RiverDetails.readForm(state.editorDraft));
  RiverDetails.applyFields(d);
  // The frequencies beyond a repeater's own pair (0033), on the same terms.
  delete d.frequencies;
  Object.assign(d, Frequencies.readForm(state.editorDraft));

  // Sensors — read the editable rows, preserving national-export metadata.
  //
  // A row survives if it carries *either* address. It used to need an ALERT id,
  // which would have thrown away every relayed sensor silently: an instrument
  // that only ever arrives over an ALERT2 relay has a slot and no ALERT address
  // at all, and the row would have looked saved and simply not been there on the
  // next render.
  const sensors = [...document.querySelectorAll('#ef-sensors .sensor-row')].map(row => {
    const id = pInt(row.querySelector('.sensor-aid')?.value);
    const a2 = pInt(row.querySelector('.sensor-a2id')?.value);
    if (id == null && a2 == null) return null;
    const rec = { type: row.querySelector('.sensor-type')?.value.trim() || '' };
    if (id != null) rec.alert_id = id;
    if (a2 != null) rec.alert2_sensor_id = a2;
    const sid = row.getAttribute('data-sensor-id');
    const did = row.getAttribute('data-device-id');
    if (sid) rec.sensor_id = sid;
    if (did) rec.device_id = pInt(did);
    return rec;
  }).filter(Boolean);
  if (sensors.length) d.sensors = sensors;
  else delete d.sensors;
  d.alert_ids = deriveLegacyAlertIds(sensors);

  if (d.roles.includes('repeater')) {
    // d.repeater is rebuilt wholesale here — a repeater key not read (or
    // carried, like notes) is silently erased on every save.
    const delay = pInt(document.getElementById('ef-delay')?.value);
    d.repeater = {
      acma_licence: document.getElementById('ef-acma')?.value.trim() || '',
      rx_mhz:       pFloat(document.getElementById('ef-rx')?.value),
      tx_mhz:       pFloat(document.getElementById('ef-tx')?.value),
      pass_ranges:  parseRangeLines(document.getElementById('ef-pass')?.value || ''),
      exclusions:   parseRangeLines(document.getElementById('ef-excl')?.value || ''),
      delay_ms:     delay == null ? null : Math.max(0, Math.min(999, delay)),
      notes:        d.repeater?.notes || '',
    };
  }

  // A new station needs an id before it can be saved: it is the primary key, it
  // is what the URL and state.selectedId carry, and the database will not mint
  // one. Uniqueness is checked against what is on screen and again, properly, by
  // the primary key at the other end — two people creating the same slug at the
  // same time is refused there rather than raced here.
  if (!d.id) {
    d.id = slug(d.name) || `stn_${Date.now()}`;
    let uid = d.id, n = 2;
    while (stations.some(s => s.id === uid)) uid = `${d.id}_${n++}`;
    d.id = uid;
  }
  return d;
}

// Save. The order matters and is the whole point of #B3: read the form, write to
// the database, wait, and only then touch what is on screen — updating memory
// from what came back rather than from what was sent, because the server owns
// updated_at and the round trip is what proves the write happened.
//
// Nothing here clears the form on a failure. Somebody has just typed for ten
// minutes; a save that fails and takes the work with it is worse than no save at
// all.
async function editorSave() {
  if (state.editorBusy) return;

  if (!editorWritesGoToDatabase()) {
    setEditorStatus({
      kind: 'error',
      text: 'The station list on screen did not come from the datastore, so saving it would'
          + ' overwrite the database with a copy that may be older. Load from the datastore first.',
    });
    return;
  }

  // A figure the browser could not read reads back as empty, and would be
  // dropped from the save without a word; say which one instead.
  const unreadable = RiverDetails.formProblem() || Frequencies.formProblem()
    || (typeof StationLpu !== 'undefined' ? StationLpu.formProblem() : '');
  if (unreadable) {
    setEditorStatus({ kind: 'error', text: unreadable });
    return;
  }

  const d        = editorReadForm();
  const isNew    = !state.editorId;
  const expected = isNew ? null : state.editorStamp;

  // A proposal that does not say what, when or where; and one headed for a
  // database that would take it for an ordinary station (0039).
  const unproposed = editorProposalProblem(d);
  if (unproposed) {
    setEditorStatus({ kind: 'error', text: unproposed });
    return;
  }
  const older = d.proposed || (!isNew && !!state.editorDraft.proposed) ? editorProposalsKnown() : null;
  if (older != null) {
    setEditorStatus({
      kind: 'error',
      text: `Not saved — the database is at schema ${older} and does not know proposed stations yet: it would`
          + ' take this one for a station on the ground. They need db/migrations/0039_proposed_stations.sql'
          + ' applied first. Your edits are still here.',
    });
    return;
  }

  state.editorBusy = true;
  setEditorStatus({ kind: 'busy', text: 'Saving…' });
  rerenderEditorButtons();

  let result;
  try {
    result = await dbSaveStation(d, expected);
  } catch (err) {
    state.editorBusy = false;
    rerenderEditorButtons();
    setEditorStatus({ kind: 'error', text: editorSaveErrorText(err) });
    return;                      // the form, and everything typed into it, stands
  }

  // The logger's details (0090, station-lpu.js) go after the station — a
  // station that is new has its id only now — and before the card is drawn
  // again, while its boxes still hold what was typed. A refusal of theirs
  // leaves the station saved and their edits in the boxes the redraw makes.
  let lpuSaved = '', lpuError = null;
  if (typeof StationLpu !== 'undefined') {
    try { lpuSaved = await StationLpu.save(result.station.id); } catch (err) { lpuError = err; }
  }

  state.editorBusy = false;

  // Memory from what came back. The saved record carries whatever the database
  // made of the write — a minted sensor_id, a normalised range list, a
  // repeater dropped because the role went away.
  const saved    = result.station;
  const stations = state.data.stations;
  const i = stations.findIndex(s => s.id === saved.id);
  if (i >= 0) stations[i] = saved; else stations.push(saved);

  state.editorId       = saved.id;
  state.editorDraft    = saved;
  state.selectedId     = saved.id;
  state.editorStamp    = result.updated_at;
  state.editorStampFor = saved.id;

  updateHeaderStats();
  refreshFilterOptions();      // an edited role / network changes the option counts
  rerenderStations();
  // And the map, which draws from the same state.data this just replaced. A
  // moved pin, a renamed station and a role that changed colour all sat at
  // their old values until something else happened to refresh the layers;
  // `skipFit` because the operator is looking at a place they chose, and a save
  // that re-fits the view to the whole network moves the ground under them.
  if (state.map) refreshMapLayers({ skipFit: true });
  rerenderStationEditorCard();
  // A new proposal is shown where it was proposed, with its card up: the
  // first sight of it is the hollow pin and the band saying it is proposed.
  if (result.created && saved.proposed && state.map) focusStationOnMap(saved);
  if (lpuError) {
    setEditorStatus({ kind: 'error', text: StationLpu.saveErrorText(lpuError) });
    return;
  }
  setEditorStatus({
    kind: 'ok',
    text: `${result.created ? (saved.proposed ? 'Proposed' : 'Created') : 'Saved'}${lpuSaved ? `, with ${lpuSaved},` : ''}`
        + ` at ${new Date().toLocaleTimeString()} as ${result.updated_by || 'you'} — in the database, not just this tab.`,
  });
}

// A station's position, saved without the form — the move-pin mode's Save
// from the Digital Twin's tab, which has no editor card (map-move-pin.js).
// It is the form's own write path rather than a second one — save_station()
// and its stale-write stamp — with one difference that makes it safer than
// the form for this one job: the document is the database's *current* copy
// of the station (station_json, read the moment Save is pressed, with the
// stamp that goes with it), not the copy this tab loaded an hour ago. So a
// name or a sensor somebody else has changed since is kept rather than
// written back over, and the only thing this save changes is the position.
// Its lists are left out so that save_station() leaves them as they are
// (river-details.js says why a list round-tripped through the browser is not
// the list that was stored).
//
// Memory is brought up to date from what came back, as editorSave() does,
// and the map's layers with it where there is a map. Throws what dbSelect and
// dbSaveStation throw; editorSaveErrorText() has the words for each.
async function stationSavePosition(id, lat, lon) {
  return stationSaveFields(id, { lat, lon });
}

// The same save for any of the station's own keys — the Digital Twin's tower
// height (0040) is the other. A value of null takes the key out, which is how
// the document says "not recorded".
async function stationSaveFields(id, fields) {
  const stations = (state.data && state.data.stations) || [];
  if (!editorWritesGoToDatabase()) {
    throw new Error('the station list on screen did not come from the datastore — load from the datastore first');
  }
  const rows = await dbSelect(`station_json?id=eq.${encodeURIComponent(id)}&select=doc,updated_at`);
  const row = rows && rows[0];
  if (!row || !row.doc) {
    throw Object.assign(new Error(`station "${id}" is no longer in the database`), { conflict: true });
  }
  const d = { ...row.doc };
  for (const [k, v] of Object.entries(fields)) { if (v == null) delete d[k]; else d[k] = v; }
  for (const k of RiverDetails.LIST_KEYS) delete d[k];
  delete d.frequencies;
  const result = await dbSaveStation(d, row.updated_at);
  const saved = result.station;
  const i = stations.findIndex(x => x.id === saved.id);
  if (i >= 0) stations[i] = saved; else stations.push(saved);
  if (state.editorId === saved.id) {
    state.editorDraft    = saved;
    state.editorStamp    = result.updated_at;
    state.editorStampFor = saved.id;
  }
  if (state.map) refreshMapLayers({ skipFit: true });
  return result;
}

// One message per way a save can fail, because "Error" is not an instruction.
function editorSaveErrorText(err) {
  if (err.conflict) return `${err.message} Your edits are still on screen — copy anything you need, then reload from the datastore.`;
  // The editors-list refusal's status for another reason (0039): this person
  // may edit, and adding a station outright or establishing a proposal is an
  // administrator's. The detail line is what tells the two apart, and the
  // instruction is different — nothing an administrator has to do to the list.
  if (err.details === 'administrator' && /gauge zero/i.test(err.message || '')) {
    return 'Not saved — only an administrator changes a station\'s gauge zero, its datum or the dates it applies'
      + ' between. Put those back as they were — the AMTD, the catchment area and the notes are yours to'
      + ' change — or record the survey on the Level Survey tab for an administrator to apply. Your edits are still here.';
  }
  if (err.details === 'administrator') {
    return state.editorId
      ? 'Not saved — only an administrator establishes a proposed station, or takes an established one back to'
        + ' proposed. Anything else about it is yours to change: leave Proposed as it was and save again.'
        + ' Your edits are still here.'
      : 'Not saved — only an administrator adds a station outright. Tick Proposed, give it a type and a year,'
        + ' and save it as a proposal for an administrator to establish. Your edits are still here.';
  }
  // Two different situations arrive as the same refusal, and the instruction is
  // different for each: one is fixed at the keyboard, the other needs somebody
  // with SQL access. Telling them apart from what this browser knows is the
  // whole reason Auth tracks may_write.
  if (err.denied) {
    return Auth.isSignedIn()
      ? `Refused: ${Auth.email() || 'this address'} is not on the editors list, so the database will not accept`
        + ` edits from it. An administrator has to add it (docs/access.md). Nothing was changed, and your edits are still here.`
      : `Refused: not signed in, and the database does not accept anonymous edits. Sign in and press Save again —`
        + ` nothing was changed, and your edits are still here.`;
  }
  return `Not saved — ${err.message}. Your edits are still here; try again when the datastore is reachable.`;
}

// Repaint just the two buttons, so their disabled state follows a save in flight
// without redrawing the form they sit above.
function rerenderEditorButtons() {
  const save = document.getElementById('ef-save');
  const del  = document.getElementById('ef-delete');
  if (save) save.disabled = state.editorBusy;
  if (del)  del.disabled  = state.editorBusy;
  editorUnsavedRefresh();
}

// ── Unsaved edits: the gold card, the gilded fields and the bar ─────────────
// The card is teal while it shows what the database holds, and gold-orange
// from the first edit until a save lands — each field that differs gilded,
// and a bar stuck to the foot of the card saying how many and carrying a Save
// (styles.css, "Unsaved edits in the station editor").
//
// What counts as changed is read off the controls themselves rather than off
// a copy taken when the card was drawn: the form is markup written from the
// record, so every control's defaultValue / defaultChecked / defaultSelected
// already *is* the saved value, and a field typed back to what it was is
// unchanged again without anything having to remember it. Two things the
// markup cannot say are told here by the code that does them — a row added
// since (data-ef-added: every figure in it is new, a prefilled one included)
// and a row from the record taken away (editorUnsavedRemoved).
//
// Called on every input and change inside the card (its oninput/onchange, in
// app.js), after a redraw, by setEditorStatus, and by anything that writes a
// box itself — Move pin's coordinates. A paint, never a redraw: nothing typed
// is touched.

// The rows from the record taken away since the card was drawn, by name. The
// heading element they were counted under says which drawing that was — a
// redraw is a fresh card and starts the list again.
const editorUnsavedGone = { head: null, names: [] };

function editorUnsavedFresh(card) {
  const head = card.querySelector('.ef-head');
  if (head === editorUnsavedGone.head) return;
  editorUnsavedGone.head  = head;
  editorUnsavedGone.names = [];
}

// The station's own fields — not the Inspections chart's picker (data-ef-ignore),
// and not the figures worked out from the others (read-only), nor a box this
// account may not change (disabled).
function editorUnsavedControls(card) {
  return [...card.querySelectorAll('input, select, textarea')].filter(el =>
    !el.readOnly && !el.disabled && !['hidden', 'button', 'submit', 'reset', 'file'].includes(el.type)
    && !el.closest('[data-ef-ignore]'));
}

function editorUnsavedChanged(el) {
  const added = !!el.closest('[data-ef-added]');
  if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== (added ? false : el.defaultChecked);
  if (el.tagName === 'SELECT') {
    const opts = [...el.options];
    if (!opts.length) return false;
    if (added) return el.value !== '';
    if (el.multiple) return opts.some(o => o.selected !== o.defaultSelected);
    const def = opts.filter(o => o.defaultSelected).pop() || opts[0];
    return el.value !== def.value;
  }
  return added ? el.value.trim() !== '' : el.value !== el.defaultValue;
}

// What a changed control is called in the bar: its caption, as the form
// shows it.
function editorUnsavedName(el) {
  if (el.name === 'ef-roles') return 'Roles';
  const sensor = el.closest('.sensor-row');
  if (sensor) {
    const was = sensor.querySelector('.sensor-aid')?.defaultValue || sensor.querySelector('.sensor-a2id')?.defaultValue;
    return sensor.hasAttribute('data-ef-added') || !was ? 'New sensor' : `Sensor ${was}`;
  }
  const section = el.closest('.freq-list, .rhs-list');
  if (section) return editorUnsavedText(section.querySelector('.ef-sub'), '.rhs-count, .freq-count') || 'Frequencies';
  const label = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
  return editorUnsavedText(label) || el.getAttribute('aria-label') || el.title || el.id || 'A field';
}

// An element's own words: the text left once the controls, the ⓘ buttons
// and anything named in `drop` are taken out of a copy of it.
function editorUnsavedText(el, drop = '') {
  if (!el) return '';
  const copy = el.cloneNode(true);
  copy.querySelectorAll(`input, select, textarea, button, datalist, .small, details${drop ? ', ' + drop : ''}`)
    .forEach(x => x.remove());
  return copy.textContent.replace(/\s+/g, ' ').trim();
}

// Where a change is painted: the control, or the label round a checkbox,
// whose box takes no paint.
function editorUnsavedMarkEl(el) {
  return (el.type === 'checkbox' || el.type === 'radio') ? (el.closest('label') || el) : el;
}

// A row about to be taken out of the form. Only one from the record is a
// change — a row added since and removed again never was.
function editorUnsavedRemoved(row, name) {
  const card = document.getElementById('stations-editor-card');
  if (!card || !row || row.hasAttribute('data-ef-added')) return;
  editorUnsavedFresh(card);
  const fromRecord = [...row.querySelectorAll('input, select, textarea')].some(el =>
    el.type === 'checkbox' ? el.defaultChecked
      : el.tagName === 'SELECT' ? [...el.options].some(o => o.defaultSelected && o.value)
      : el.defaultValue.trim() !== '');
  if (fromRecord) editorUnsavedGone.names.push(`${name} removed`);
}

function editorRemoveSensorRow(btn) {
  const row = btn.closest('.sensor-row');
  if (!row) return;
  const was = row.querySelector('.sensor-aid')?.defaultValue || row.querySelector('.sensor-a2id')?.defaultValue;
  editorUnsavedRemoved(row, was ? `Sensor ${was}` : 'A sensor');
  row.remove();
  editorUnsavedRefresh();
}

// The changed controls behind the names in the bar, so a name can be pressed
// to go to its field.
let editorUnsavedTargets = [];

function editorUnsavedRefresh() {
  const card = document.getElementById('stations-editor-card');
  if (!card) return;
  const bar = document.getElementById('ef-unsaved');
  const undo = document.getElementById('ef-undo');
  card.querySelectorAll('.ef-changed').forEach(el => el.classList.remove('ef-changed'));
  if (!bar) { card.classList.remove('is-unsaved'); return; }
  editorUnsavedFresh(card);

  const changed = editorUnsavedControls(card).filter(editorUnsavedChanged);
  changed.forEach(el => editorUnsavedMarkEl(el).classList.add('ef-changed'));

  // One name per field — the four role boxes are one change, Roles.
  const byName = new Map();
  for (const el of changed) {
    const name = editorUnsavedName(el);
    if (!byName.has(name)) byName.set(name, el);
  }
  for (const name of editorUnsavedGone.names) if (!byName.has(name)) byName.set(name, null);
  const n = byName.size;
  card.classList.toggle('is-unsaved', n > 0);
  bar.hidden = n === 0;
  if (undo) { undo.hidden = n === 0; undo.disabled = state.editorBusy; }
  if (!n) { bar.innerHTML = ''; editorUnsavedTargets = []; return; }

  editorUnsavedTargets = [...byName.values()];
  const SHOWN = 3;
  const names = [...byName.keys()];
  const list = names.slice(0, SHOWN).map((name, i) => editorUnsavedTargets[i]
    ? `<button type="button" class="link-btn" onclick="editorUnsavedGo(${i})"
              title="Go to ${escAttr(name)}">${esc(name)}</button>`
    : esc(name)).join(', ')
    + (n > SHOWN ? ` and ${n - SHOWN} more` : '');
  const m = state.editorMsg;
  const where = state.editorBusy ? 'saving…'
    : m && m.kind === 'error' ? `<strong>⚠ not saved</strong> (<button type="button" class="link-btn"
        onclick="editorUnsavedWhy()">why ↑</button>)`
    : 'not in the database yet';
  const html = `
    <span class="ef-unsaved-text"><strong>${n} unsaved change${n === 1 ? '' : 's'}</strong>, ${where} — ${list}.</span>
    <button type="button" id="ef-undo-bar" onclick="editorUndo()" ${state.editorBusy ? 'disabled' : ''}
            title="Throw away the unsaved changes — back to what the database holds">Undo</button>
    ${dbCanWrite()
      ? `<button type="button" class="primary" id="ef-save-bar" onclick="editorSave()"
                 ${state.editorBusy ? 'disabled' : ''}>Save</button>`
      : `<button type="button" class="primary" id="ef-save-bar" onclick="Auth.open()"
                 title="Saving needs a signed-in session">Sign in to save</button>`}`;
  // Only when it says something new: the bar is a status region, and a
  // keystroke that changes nothing it says should not be read out again.
  if (bar.dataset.said !== html) {
    bar.dataset.said = html;
    bar.innerHTML = html;
  }
}

function editorUnsavedGo(i) {
  const el = editorUnsavedTargets[i];
  if (!el || !el.isConnected) return;
  const fold = el.closest('details:not([open])');
  if (fold) fold.open = true;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus({ preventScroll: true });
}

// The answer to a refused save is the status line under the card's heading,
// which a Save pressed in the bar may be a long way below.
function editorUnsavedWhy() {
  const el = document.getElementById('ef-status');
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// Undo, in the header and in the bar: every unsaved change thrown away at
// once. The form is markup written from the record, so drawing the card again
// is the undo — each field its saved value, a row taken away back, a row added
// gone. The draft is taken from the record again first: the card is drawn from
// the record, but a save starts from the draft (editorReadForm), and a pin
// moved into the boxes wrote itself into the draft too (map-move-pin.js). A
// "+ New" or "+ Propose" form has no record, and goes back to what it opened
// with. Focus to the first field put back, not to <body>: the pressed button
// has just gone.
function editorUndo() {
  const card = document.getElementById('stations-editor-card');
  if (!card || !card.classList.contains('is-unsaved') || state.editorBusy) return;
  const n = editorUnsavedTargets.length;
  const first = editorUnsavedTargets.find(el => el && el.id)?.id;
  const s = state.editorId && state.data ? state.data.stations.find(x => x.id === state.editorId) : null;
  if (s) state.editorDraft = JSON.parse(JSON.stringify(s));
  const back = state.editorId ? 'back to what the database holds' : 'the form as it opened';
  state.editorMsg = { kind: 'info', text: `Undid ${n} unsaved change${n === 1 ? '' : 's'} — ${back}.` };
  if (typeof StationLpu !== 'undefined') StationLpu.discard();
  rerenderStationEditorCard();
  document.getElementById(first || 'ef-name')?.focus({ preventScroll: true });
  announce(state.editorMsg.text);
}

// Delete, which is a soft delete at the other end: the row, its sensors, its
// repeater and its ranges all stay, and only the document stops carrying it. The
// confirm still says "delete" because that is what it means to the operator —
// the recoverability is the database's business, and is spelled out in
// db/migrations/0004_station_writes.sql for whoever needs to undo one.
async function editorDelete() {
  if (!state.editorId || state.editorBusy) return;

  const id   = state.editorId;
  const name = state.data.stations.find(s => s.id === id)?.name || id;

  if (!editorWritesGoToDatabase()) {
    setEditorStatus({
      kind: 'error',
      text: 'The station list on screen did not come from the datastore. Load from the datastore before deleting.',
    });
    return;
  }
  if (!(await confirmDialog({ title: `Delete “${name}”?`,
    message: 'It is removed from the station list. The record is kept and can be restored by whoever administers the database.',
    confirm: 'Delete the station', danger: true }))) return;

  state.editorBusy = true;
  setEditorStatus({ kind: 'busy', text: 'Deleting…' });
  rerenderEditorButtons();

  try {
    await dbDeleteStation(id, state.editorStamp);
  } catch (err) {
    state.editorBusy = false;
    rerenderEditorButtons();
    setEditorStatus({ kind: 'error', text: editorSaveErrorText(err) });
    return;
  }

  state.editorBusy     = false;
  state.data.stations  = state.data.stations.filter(s => s.id !== id);
  state.selectedId     = null;
  state.editorId       = null;
  state.editorDraft    = {};
  state.editorStamp    = null;
  state.editorStampFor = null;
  state.editorMsg      = null;
  updateHeaderStats();
  refreshFilterOptions();
  rerenderStations();
  rerenderStationEditorCard();
}

