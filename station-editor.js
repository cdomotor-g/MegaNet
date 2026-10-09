// MegaNet — station-editor.js
//
//   editorForm     the station editor card below the stations list on the
//   editorSave     Stations tab: the form, what it derives from what is typed
//   editorDelete   into it, and the save and delete path behind it.
//   and the form
//   helpers
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, slug, pInt, pFloat,
// parseRangeLines, mapLinksHtml, stationMapLinkUrls, stationSensors,
// arroSiteId, arroSiteUrl, arroSensorUrl, buildArroUrl, bucketSizeGapNote,
// ROLE_LABEL and STATION_TYPE_LABEL (a proposed station's type, 0039); across
// to app.js for the Stations tab's rerender hooks —
// rerenderStations, rerenderStationEditorCard, refreshFilterOptions,
// refreshMapLayers, updateHeaderStats, findStationMatches, stationAlertIds,
// passRangeCoversId, repeaterPassingCount and repeaterPassRangeSpan — and for
// the places a new proposal is shown (focusStationOnMap, dockReveal,
// toggleMapFullscreen) — and back
// the other way, rerenderStationEditorCard() calls editorRefreshA2Seen() here
// once the card is on screen, because the heard-slots list reads the readings
// rather than state.data; to
// map-move-pin.js for the button that moves this station's pin on the map above
// the card, which writes back into the two coordinate boxes; to auth.js for
// Auth; and to
// datastore.js for dbCanWrite, dbSaveStation, dbDeleteStation, dbSelect,
// setEditorStatus, editorStatusHtml and editorWritesGoToDatabase; to inspections.js for
// Inspections.configs and Inspections.ensureRefs — the telemetry pick-list
// (#147) reads the same meganet.inspection_config list the Inspections tab
// renders its form from, rather than keeping a second copy; to
// station-inspections.js for StationInspections.sectionHtml, the Inspections
// section under the ARRO block at the foot of the form; and to
// river-details.js for RiverDetails — the Bureau's flood warning lists above
// the ARRO block (0031, 0032) and the AEP flood levels with them (0033), which
// editorReadForm() reads back and editorSave() asks formProblem() about first;
// and to frequencies.js for Frequencies — the RX/TX rows in the Repeater
// Configuration and a base station's own section (0033), read back and asked
// about the same way.
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
  const outright = !saved && typeof Auth !== 'undefined' && Auth.isSignedIn() && !editorIsAdmin();
  return `
      <label class="check-label ef-proposed"${locked ? ` title="${escAttr(why)}"` : ''}>
        <input type="checkbox" id="ef-proposed" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}
               onchange="editorProposedChanged(this.checked)"> Proposed — not yet established
      </label>
      ${outright ? `<div class="full small ef-hint ef-proposed-hint" id="ef-proposed-hint" ${on ? 'hidden' : ''}>
        Only an administrator adds a station outright. Tick <em>Proposed</em> and it goes in as a proposal,
        for an administrator to establish.</div>` : ''}`;
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

function editorForm(s) {
  const hasRep  = s.roles.includes('repeater');
  const hasBase = s.roles.includes('base');
  const sensors = stationSensors(s).slice().sort((a, b) => (a.alert_id ?? 0) - (b.alert_id ?? 0));
  const dbId    = arroSiteId(s);
  // The row of pills under the coordinate boxes. Read once rather than twice —
  // a station with no position still has the two document searches, so what
  // decides whether the row is drawn is whether it came back with anything.
  // The KML download joins it here rather than inside mapLinksHtml() because it
  // is the one pill in the row that does not leave the site for somewhere else:
  // it builds a file out of this station and the links the map draws around it
  // (#176, export.js), and it is the same pill the map's own card carries.
  const links   = [mapLinksHtml(s), stationKmlPillHtml(s)].filter(Boolean).join('\n    ');
  const movePin = MapMovePin.editorButtonHtml(s);
  // Same pill the station card on the map carries (and a phone's callout),
  // from the same builder — but pointed at
  // editorCopyLatLon(), which reads the two boxes rather than the record. The
  // card is where a coordinate is *edited*: a pin dragged in from the map or a
  // figure typed over one has to be what the clipboard gets, and reading the
  // boxes at the click is the only version of that which cannot go stale.
  const copyLL  = copyLatLonPillHtml(s, { live: true });
  // The wind region the station's coordinate falls in — the same answer the
  // station card on the map gives, so the two cards never disagree. Read now, and
  // filled in when the polygons land if this page has not needed them yet.
  const wind    = MapWind.regionState(s.lat, s.lon);
  MapWind.askRegion('ef-wind', s.lat, s.lon);
  return `
    <div class="panel-header ef-head">
      <h3>${esc(s.name) || (s.proposed ? 'New Proposed Station' : 'New Station')}</h3>
      <div class="button-group">
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
    </div>
    <!-- Save writes to the database and waits for it, so this line is where the
         answer arrives: saved and when, refused and why. A failed save leaves
         everything below untouched — the typing is the thing being protected. -->
    <div id="ef-status" class="small ef-status">${editorStatusHtml()}</div>
    <!-- A proposal says so first (0039): the band, and the year it is for. -->
    ${editorProposalHtml(s)}
    <div class="form-grid">
      <label>Name<input type="text" id="ef-name" value="${esc(s.name)}"></label>
      <label>Station Number<input type="text" id="ef-stnno" value="${esc(s.station_number || '')}"
             ${s.proposed ? 'placeholder="none yet — it is proposed"' : ''}></label>
      <!-- What kind of station it is, or is to be, and whether it is only
           proposed (0039). The type is asked of every proposal and allowed on
           any station; the box is an administrator's once the station is saved. -->
      <label>Station type
        <select id="ef-stype">${stationTypeOptions(s.station_type, s.proposed)}</select>
      </label>
      <!-- A river-gauge tower's platform height (0040): the standard drawing's
           two, each on a 2100 × 2100 footing. Blank is not recorded, which the
           Digital Twin draws as the 3.0 m default. -->
      <label>Tower platform height
        <select id="ef-tower">${towerHeightOptions(s.tower_height)}</select>
      </label>
      <!-- The way the station faces (0044): the bearing its front — enclosure
           door, or a tower's ladder — looks out. Blank is not recorded, which
           the Digital Twin draws facing south. Its 🧭 Orientation tool sets it
           by eye. -->
      <label>Faces (° from north)<input type="number" id="ef-facing" min="0" max="359.9" step="0.1" inputmode="decimal"
             value="${s.facing_deg == null ? '' : esc(String(s.facing_deg))}" placeholder="not recorded (south)"
             title="The bearing the station's front — its enclosure door, or a tower's ladder — faces, clockwise from true north"></label>
      <!-- The station it takes its flood history from (0041), by id: for a
           station with no gauge of its own, such as a proposal beside one. -->
      <label>Flood history from<input type="text" id="ef-fpfrom" value="${esc(s.flood_peaks_from || '')}"
             placeholder="a station's id, e.g. gatton" title="The Bureau's floods at that station's gauge are shown for this one while it has no gauge of its own"></label>
      ${editorProposedBoxHtml(s)}
      <label>Latitude<input type="number" step="any" id="ef-lat" value="${s.lat ?? ''}"></label>
      <label>Longitude<input type="number" step="any" id="ef-lon" value="${s.lon ?? ''}"></label>
      <!-- Typing a coordinate is the exact form of this that nobody can check.
           Move pin arms map-move-pin.js: the pin comes off the map, goes where
           the station is, and writes these two boxes on the way back. Copy is
           the other direction — the position out of here and into whatever is
           being written somewhere else. Both belong to the two boxes above, so
           they sit on one row directly under them rather than in the links row
           below, which is five things that all leave the site. -->
      ${movePin || copyLL ? `<div class="full ef-movepin pill-row">${movePin}${copyLL}</div>` : ''}
      ${links ? `<div class="full small ef-links">${links}</div>` : ''}
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
      <label>RM System ID<input type="number" id="ef-rmsys" value="${s.rm_system_id || 1}"></label>
      <label>TBRG bucket size (mm/tip)
        <input type="number" step="0.1" min="0" id="ef-bucket" value="${s.TBRGbucketSize ?? ''}" placeholder="not recorded">
      </label>
      <div class="full small ef-hint">
        Blank means not recorded, not zero — the app falls back to an assumed 0.2 mm/tip wherever it
        converts a rain gauge count and says so. ${bucketSizeGapNote()}
      </div>
      <label class="full">Roles
        <div class="ef-roles">
          ${Object.keys(ROLE_LABEL).map(r => `
            <label class="check-label ef-role">
              <input type="checkbox" name="ef-roles" value="${r}" ${s.roles.includes(r) ? 'checked' : ''}> ${r}
            </label>`).join('')}
        </div>
      </label>
      <label class="full">Telemetry / inspection form
        <select id="ef-insp-config">${editorInspConfigOptions(s.inspection_config_key)}</select>
      </label>
      <div class="full small ef-hint">
        Which of the six inspection sheets a crew prints at this site — the Inspections tab
        pre-selects its form from this. “Not recorded” means nobody has said yet, and the form
        asks rather than guesses; leave it that way unless you know the site's telemetry.
      </div>
      <div class="full ef-section">
        <div class="ef-section-head">
          <div class="ef-sub">ALERT IDs / Sensors${sensors.length ? ` <span class="small ef-plain">— ${sensors.length}</span>` : ''}</div>
          <button type="button" onclick="editorAddSensorRow()">+ Add sensor</button>
        </div>
        <div id="ef-sensors">
          ${sensors.map(se => sensorRowHtml(se, dbId)).join('')}
        </div>
        <div class="small ef-note">
          One row per ALERT address and what it measures — rainfall, water level, battery, etc.
          <b>Flip</b> takes the row's address to the Bit Flipper, which says what else it could
          have been.${
            dbId != null ? ' Rows whose sensor carries an ARRO device id link straight to its admin page.' : ''}
        </div>
        <label class="full">ALERT2 station address
          <input type="number" id="ef-a2stn" min="1" max="65535" value="${s.alert2_station_id ?? ''}"
                 placeholder="none — this station is not relayed over ALERT2"
                 onchange="editorRefreshA2Seen()">
        </label>
        <div class="small ef-note">
          Set this only when the station's readings reach Flood-Net relayed over ALERT2 — an
          ELPRO 115E-2 publishes them under this address, and it is what attributes them here.
          The <b>A2 slot</b> on each row above then says which of that station's sensors the row is.
          One address belongs to one station: claiming one another station holds is refused.
        </div>
        <div id="ef-a2-seen" class="small ef-note"></div>
        <datalist id="ef-sensor-types">
          ${['Rainfall', 'Rainfall Increment', 'Water Level', 'Water Level - AHD', 'Battery', 'Air Temperature', 'Relative Humidity', 'Wind Speed', 'Wind Gust', 'Wind Direction', 'pH', 'Conductivity', 'Dissolved Oxygen', 'Water Temperature', 'Turbidity'].map(t => `<option value="${esc(t)}">`).join('')}
        </datalist>
      </div>
      <label class="check-label ef-enabled">
        <input type="checkbox" id="ef-enabled" ${s.enabled ? 'checked' : ''}> Enabled
      </label>
      <!-- Who owns the station, recorded on it (0030). Blank means not recorded,
           and the card then shows only what the SLS says, if anything. -->
      <label class="full">Owner<input type="text" id="ef-owner" value="${escAttr(s.owner || '')}"
             placeholder="e.g. Toowoomba Regional Council"></label>
      <label class="full">Notes<textarea id="ef-notes">${esc(s.notes || '')}</textarea></label>
    </div>
    ${hasRep ? `
      <hr>
      <h4 class="ef-h">Repeater Configuration</h3>
      <div class="form-grid">
        <label>ACMA Licence<input type="text" id="ef-acma" value="${esc(s.repeater?.acma_licence || '')}"></label>
        <label>Repeater delay (ms)
          <input type="number" min="0" max="999" step="1" id="ef-delay"
                 value="${s.repeater?.delay_ms ?? ''}" placeholder="not set">
        </label>
        <div class="full small ef-hint">
          How long this repeater waits before re-transmitting a message its pass ranges accept.
          Blank means not set, not zero. ${(() => {
            const sug = suggestedRepeaterDelayMs(s);
            return sug == null ? '' :
              `Suggested: <strong>${sug} ms</strong> — staggered so repeaters within the backbone
               distance whose windows share an address never hold the same delay.`;
          })()}
        </div>
        <!-- The repeater's own RX/TX pair first (ef-rx, ef-tx — what every path
             tool reads), then a row per other channel, with + Add (0033). -->
        ${Frequencies.editorHtml(s, { primary: true })}
        ${repeaterPassingSummaryHtml(s)}
        ${repeaterCarriedStationsHtml(s)}
        <label class="full">Pass Ranges (one per line: <em>low-high</em>)
          <textarea id="ef-pass" rows="5">${(s.repeater?.pass_ranges || []).map(r => `${r.low}-${r.high}`).join('\n')}</textarea>
        </label>
        <label class="full">Exclusions (one per line: <em>low-high</em>)
          <textarea id="ef-excl" rows="3">${(s.repeater?.exclusions || []).map(r => `${r.low}-${r.high}`).join('\n')}</textarea>
        </label>
      </div>` : ''}
    ${hasBase && !hasRep ? `
      <hr>
      <h4 class="ef-h">Base Station Radio</h4>
      <!-- A base station has no repeater row, so every pair it uses is a row
           here (0033). A base that is also a repeater keeps them above. -->
      <div class="form-grid">
        ${Frequencies.editorHtml(s)}
      </div>` : ''}
    ${RiverDetails.editorHtml(s)}
    ${editorArroSection(s, sensors)}
    ${StationInspections.sectionHtml(s)}`;
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
  const cur = sel.value;
  sel.innerHTML = editorInspConfigOptions(cur);
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
    <div class="form-grid">
      <label>ARRO site id <span class="small ef-plain">— ARRO's key, not BoM's</span>
        <input type="text" readonly value="${esc(dbId)}" title="site.db_id — the id every ARRO URL takes">
      </label>
      <label>Station number <span class="small ef-plain">— BoM's</span>
        <input type="text" readonly value="${esc(site.number || s.station_number || '—')}">
      </label>
      <label class="full">Site name in ARRO
        <input type="text" readonly value="${esc(site.name || '—')}">
      </label>
    </div>
    <div class="button-group ef-actions">
      <a class="btn-link" href="${esc(admin)}" target="_blank" rel="noopener"
         title="Site administration page in ARRO">Open site in ARRO admin ↗</a>
      ${graph ? `<a class="btn-link" href="${esc(graph.url)}" target="_blank" rel="noopener"
         title="Last 7 days for ${graph.count} sensor${graph.count !== 1 ? 's' : ''}">Graph last 7 days ↗</a>` : ''}
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
// so a round-trip keeps it.
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
      <button type="button" class="link-btn sensor-flip" onclick="editorOpenSensorFlip(this)"
              ${isBfAddress(pInt(se.alert_id)) ? '' : 'disabled'}
              aria-label="Open this row's ALERT address in the Bit Flipper"
              title="Open this row's ALERT address in the Bit Flipper — what else it could be, one or more bit-flips away">Flip</button>
      <span class="sensor-arro small">${url
        ? `<a href="${esc(url)}" target="_blank" rel="noopener"
             title="ARRO admin for device ${esc(se.device_id)} on site ${esc(dbId)}">ARRO ↗</a>`
        : ''}</span>
      <button type="button" class="sensor-del btn-danger" title="Remove this sensor"
              onclick="this.closest('.sensor-row').remove()"><span aria-hidden="true">×</span></button>
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
  // A row added from the heard-slots list below already knows its address; what
  // it is waiting for is what the thing measures, so that is where the cursor
  // goes. An empty row still starts at the ALERT box.
  row?.querySelector(slot == null ? '.sensor-aid' : '.sensor-type')?.focus();
  if (slot != null) editorRefreshA2Seen();
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
  const lat = pFloat(document.getElementById('ef-lat')?.value);
  const lon = pFloat(document.getElementById('ef-lon')?.value);
  copyStationLatLon(btn, stationLatLonText({ lat, lon }));
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
  // emits, so a save that set nothing round-trips without gaining a key.
  const owner = document.getElementById('ef-owner')?.value.trim() || '';
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
  const unreadable = RiverDetails.formProblem() || Frequencies.formProblem();
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
  setEditorStatus({
    kind: 'ok',
    text: `${result.created ? (saved.proposed ? 'Proposed' : 'Created') : 'Saved'} at ${new Date().toLocaleTimeString()}`
        + ` as ${result.updated_by || 'you'} — in the database, not just this tab.`,
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

