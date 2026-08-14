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
// arroSiteId, arroSiteUrl, arroSensorUrl, buildArroUrl, bucketSizeGapNote and
// ROLE_LABEL; across to app.js for the Stations tab's rerender hooks —
// rerenderStations, rerenderStationEditorCard, refreshFilterOptions,
// updateHeaderStats, findStationMatches, stationAlertIds, passRangeCoversId,
// repeaterPassingCount and repeaterPassRangeSpan; to auth.js for Auth; and to
// datastore.js for dbCanWrite, dbSaveStation, dbDeleteStation, setEditorStatus,
// editorStatusHtml and editorWritesGoToDatabase; and to inspections.js for
// Inspections.configs and Inspections.ensureRefs — the telemetry pick-list
// (#147) reads the same meganet.inspection_config list the Inspections tab
// renders its form from, rather than keeping a second copy.
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
        <p class="full small" style="margin:.1rem 0 .5rem">
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
    return `<p class="full small" style="color:var(--muted);margin:0 0 .6rem">No stations currently fall inside these pass ranges.</p>`;
  }
  return `
        <div class="full small" style="margin:0 0 .6rem">
          <div style="font-weight:600;margin-bottom:.3rem">ALERT IDs in range → stations</div>
          <div style="max-height:11rem;overflow:auto;border:1px solid var(--border);border-radius:4px;padding:.4rem .6rem">
            ${rows.map(({ st, ids }) => `
              <div style="cursor:pointer;padding:.1rem 0" onclick="goToStation('${escAttr(st.id)}')"
                   title="Open ${escAttr(st.name)} on the Stations tab">
                <strong>${ids.join(', ')}</strong> — ${esc(st.name)}
              </div>`).join('')}
          </div>
        </div>`;
}

function editorForm(s) {
  const hasRep  = s.roles.includes('repeater');
  const sensors = stationSensors(s).slice().sort((a, b) => (a.alert_id ?? 0) - (b.alert_id ?? 0));
  const dbId    = arroSiteId(s);
  return `
    <div class="panel-header" style="margin-bottom:.35rem">
      <h2>${esc(s.name) || 'New Station'}</h2>
      <div style="display:flex;gap:.5rem">
        <!-- Signed out, the button is not disabled and does not fail at the
             network: it says what is missing and opens the panel that supplies
             it. A greyed-out Save with no explanation is the version of this
             that generates the support email. -->
        ${dbCanWrite()
          ? `<button class="primary" id="ef-save" onclick="editorSave()" ${state.editorBusy ? 'disabled' : ''}>Save</button>`
          : `<button class="primary" id="ef-save" onclick="Auth.open()" title="Saving needs a signed-in session">Sign in to save</button>`}
        ${s.id ? `<button id="ef-delete" onclick="editorDelete()" ${state.editorBusy ? 'disabled' : ''}
                          style="border-color:#c7401a;color:#c7401a">Delete</button>` : ''}
      </div>
    </div>
    <!-- Save writes to the database and waits for it, so this line is where the
         answer arrives: saved and when, refused and why. A failed save leaves
         everything below untouched — the typing is the thing being protected. -->
    <div id="ef-status" class="small" style="margin-bottom:.6rem">${editorStatusHtml()}</div>
    <div class="form-grid">
      <label>Name<input type="text" id="ef-name" value="${esc(s.name)}"></label>
      <label>Station Number<input type="text" id="ef-stnno" value="${esc(s.station_number || '')}"></label>
      <label>Latitude<input type="number" step="any" id="ef-lat" value="${s.lat ?? ''}"></label>
      <label>Longitude<input type="number" step="any" id="ef-lon" value="${s.lon ?? ''}"></label>
      ${stationMapLinkUrls(s) ? `<div class="full small" style="display:flex;gap:1rem;margin-top:-.35rem">${mapLinksHtml(s)}</div>` : ''}
      <label>Elevation AHD (m)<input type="number" step="any" id="ef-elev" value="${s.elevation_ahd ?? ''}"></label>
      <label>RM System ID<input type="number" id="ef-rmsys" value="${s.rm_system_id || 1}"></label>
      <label>TBRG bucket size (mm/tip)
        <input type="number" step="0.1" min="0" id="ef-bucket" value="${s.TBRGbucketSize ?? ''}" placeholder="not recorded">
      </label>
      <div class="full small" style="color:var(--muted);margin-top:-.35rem">
        Blank means not recorded, not zero — the app falls back to an assumed 0.2 mm/tip wherever it
        converts a rain gauge count and says so. ${bucketSizeGapNote()}
      </div>
      <label class="full">Roles
        <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:.35rem">
          ${Object.keys(ROLE_LABEL).map(r => `
            <label style="font-weight:normal;display:flex;gap:.35rem;align-items:center">
              <input type="checkbox" name="ef-roles" value="${r}" ${s.roles.includes(r) ? 'checked' : ''}> ${r}
            </label>`).join('')}
        </div>
      </label>
      <label class="full">Telemetry / inspection form
        <select id="ef-insp-config">${editorInspConfigOptions(s.inspection_config_key)}</select>
      </label>
      <div class="full small" style="color:var(--muted);margin-top:-.35rem">
        Which of the six inspection sheets a crew prints at this site — the Inspections tab
        pre-selects its form from this. “Not recorded” means nobody has said yet, and the form
        asks rather than guesses; leave it that way unless you know the site's telemetry.
      </div>
      <div class="full" style="margin-top:.4rem">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.45rem">
          <div style="font-weight:600">ALERT IDs / Sensors${sensors.length ? ` <span class="small" style="font-weight:400">— ${sensors.length}</span>` : ''}</div>
          <button type="button" onclick="editorAddSensorRow()">+ Add sensor</button>
        </div>
        <div id="ef-sensors">
          ${sensors.map(se => sensorRowHtml(se, dbId)).join('')}
        </div>
        <div class="small" style="color:var(--muted);margin-top:.2rem">
          One row per ALERT address and what it measures — rainfall, water level, battery, etc.${
            dbId != null ? ' Rows whose sensor carries an ARRO device id link straight to its admin page.' : ''}
        </div>
        <datalist id="ef-sensor-types">
          ${['Rainfall', 'Rainfall Increment', 'Water Level', 'Water Level - AHD', 'Battery', 'Air Temperature', 'Relative Humidity', 'Wind Speed', 'Wind Gust', 'Wind Direction', 'pH', 'Conductivity', 'Dissolved Oxygen', 'Water Temperature', 'Turbidity'].map(t => `<option value="${esc(t)}">`).join('')}
        </datalist>
      </div>
      <label style="display:flex;gap:.45rem;align-items:center;grid-column:1">
        <input type="checkbox" id="ef-enabled" ${s.enabled ? 'checked' : ''}> Enabled
      </label>
      <label class="full">Notes<textarea id="ef-notes">${esc(s.notes || '')}</textarea></label>
    </div>
    ${hasRep ? `
      <hr>
      <h3 style="margin:.5rem 0 .75rem">Repeater Configuration</h3>
      <div class="form-grid">
        <label>ACMA Licence<input type="text" id="ef-acma" value="${esc(s.repeater?.acma_licence || '')}"></label>
        <label>RX (MHz)<input type="number" step="any" id="ef-rx" value="${s.repeater?.rx_mhz ?? ''}"></label>
        <label>TX (MHz)<input type="number" step="any" id="ef-tx" value="${s.repeater?.tx_mhz ?? ''}"></label>
        ${repeaterPassingSummaryHtml(s)}
        ${repeaterCarriedStationsHtml(s)}
        <label class="full">Pass Ranges (one per line: <em>low-high</em>)
          <textarea id="ef-pass" rows="5">${(s.repeater?.pass_ranges || []).map(r => `${r.low}-${r.high}`).join('\n')}</textarea>
        </label>
        <label class="full">Exclusions (one per line: <em>low-high</em>)
          <textarea id="ef-excl" rows="3">${(s.repeater?.exclusions || []).map(r => `${r.low}-${r.high}`).join('\n')}</textarea>
        </label>
      </div>` : ''}
    ${editorArroSection(s, sensors)}`;
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
      <h3 style="margin:.5rem 0 .75rem">ARRO</h3>
      <p class="small" style="color:var(--muted);margin:0">
        <strong>No ARRO site id recorded</strong> for this station, so there is no admin page to
        link to. 390 of 3,174 stations are in the same position — the site id arrives with the
        ARRO sensor export (<code>tools/import_arro_sensors.py</code>) and a station missing from
        that export has no <code>site.db_id</code> here either.
      </p>`;
  }

  return `
    <hr>
    <h3 style="margin:.5rem 0 .75rem">ARRO</h3>
    <div class="form-grid">
      <label>ARRO site id <span class="small" style="font-weight:400">— ARRO's key, not BoM's</span>
        <input type="text" readonly value="${esc(dbId)}" title="site.db_id — the id every ARRO URL takes">
      </label>
      <label>Station number <span class="small" style="font-weight:400">— BoM's</span>
        <input type="text" readonly value="${esc(site.number || s.station_number || '—')}">
      </label>
      <label class="full">Site name in ARRO
        <input type="text" readonly value="${esc(site.name || '—')}">
      </label>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.6rem">
      <a class="btn-link" href="${esc(admin)}" target="_blank" rel="noopener"
         title="Site administration page in ARRO">Open site in ARRO admin ↗</a>
      ${graph ? `<a class="btn-link" href="${esc(graph.url)}" target="_blank" rel="noopener"
         title="Last 7 days for ${graph.count} sensor${graph.count !== 1 ? 's' : ''}">Graph last 7 days ↗</a>` : ''}
    </div>
    <p class="small" style="color:var(--muted);margin:.5rem 0 0">
      ${withDev
        ? `${withDev} of ${sensors.length} sensor${sensors.length !== 1 ? 's' : ''} carry an ARRO device id —
           each of those rows above links to its own sensor admin page.`
        : `None of this station's sensors carry an ARRO device id, so there are no per-sensor
           admin pages to link to.`}
    </p>`;
}

// One editable sensor row: ALERT id + type, with the national-export metadata
// (sensor_id, device_id) preserved on data-attributes so a round-trip keeps it.
//
// `dbId` is the station's ARRO site id, passed in because a sensor record has
// only half of what an ARRO sensor page needs. When both keys are present the
// row carries its own admin link rather than a second list of them below.
function sensorRowHtml(se, dbId) {
  se = se || {};
  const url = arroSensorUrl(dbId, se.device_id);
  return `
    <div class="sensor-row" data-sensor-id="${esc(se.sensor_id || '')}" data-device-id="${se.device_id ?? ''}"
         style="display:flex;gap:.4rem;align-items:center;margin-bottom:.35rem">
      <input type="number" class="sensor-aid" value="${se.alert_id ?? ''}" placeholder="ALERT ID"
             style="flex:0 0 7.5rem;width:7.5rem">
      <input type="text" class="sensor-type" list="ef-sensor-types" value="${esc(se.type || '')}"
             placeholder="Sensor type (e.g. Rainfall)" style="flex:1 1 auto;width:auto;min-width:0">
      <span class="sensor-arro small" style="flex:0 0 4.2rem;text-align:right">${url
        ? `<a href="${esc(url)}" target="_blank" rel="noopener"
             title="ARRO admin for device ${esc(se.device_id)} on site ${esc(dbId)}">ARRO ↗</a>`
        : ''}</span>
      <button type="button" class="sensor-del" title="Remove this sensor"
              onclick="this.closest('.sensor-row').remove()"
              style="flex:0 0 auto;border-color:#c7401a;color:#c7401a;padding:.2rem .55rem;line-height:1">×</button>
    </div>`;
}

function editorAddSensorRow() {
  const box = document.getElementById('ef-sensors');
  if (!box) return;
  box.insertAdjacentHTML('beforeend', sensorRowHtml({}));
  box.querySelector('.sensor-row:last-child .sensor-aid')?.focus();
}

// Best-effort legacy `alert_ids` object derived from the sensor rows, so exports
// and any older consumers still get rainfall/battery/water_level values. The
// `sensors` array is the source of truth for display.
function deriveLegacyAlertIds(sensors) {
  const out = {};
  const wl = [];
  sensors.forEach(se => {
    const t = (se.type || '').toLowerCase();
    if (t.includes('rain'))       { if (out.rainfall == null) out.rainfall = se.alert_id; }
    else if (t.includes('batt'))  { if (out.battery  == null) out.battery  = se.alert_id; }
    else if (t.includes('level')) { if (!wl.includes(se.alert_id)) wl.push(se.alert_id); }
  });
  if (wl.length === 1) out.water_level = wl[0];
  else if (wl.length > 1) out.water_level = wl;
  return out;
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
  d.rm_system_id   = parseInt(document.getElementById('ef-rmsys')?.value) || 1;
  const bucket = pFloat(document.getElementById('ef-bucket')?.value);
  if (bucket != null && bucket > 0) d.TBRGbucketSize = bucket; else delete d.TBRGbucketSize;
  d.enabled        = document.getElementById('ef-enabled')?.checked ?? true;
  d.notes          = document.getElementById('ef-notes')?.value || '';
  d.roles          = [...document.querySelectorAll('input[name="ef-roles"]:checked')].map(b => b.value);
  const inspCfg = document.getElementById('ef-insp-config')?.value || '';
  if (inspCfg) d.inspection_config_key = inspCfg; else delete d.inspection_config_key;

  // ALERT sensors — read the editable rows, preserving national-export metadata.
  const sensors = [...document.querySelectorAll('#ef-sensors .sensor-row')].map(row => {
    const id = pInt(row.querySelector('.sensor-aid')?.value);
    if (id == null) return null;
    const rec = { alert_id: id, type: row.querySelector('.sensor-type')?.value.trim() || '' };
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
    d.repeater = {
      acma_licence: document.getElementById('ef-acma')?.value.trim() || '',
      rx_mhz:       pFloat(document.getElementById('ef-rx')?.value),
      tx_mhz:       pFloat(document.getElementById('ef-tx')?.value),
      pass_ranges:  parseRangeLines(document.getElementById('ef-pass')?.value || ''),
      exclusions:   parseRangeLines(document.getElementById('ef-excl')?.value || ''),
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

  const d        = editorReadForm();
  const isNew    = !state.editorId;
  const expected = isNew ? null : state.editorStamp;

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
  rerenderStationEditorCard();
  setEditorStatus({
    kind: 'ok',
    text: `${result.created ? 'Created' : 'Saved'} at ${new Date().toLocaleTimeString()}`
        + ` as ${result.updated_by || 'you'} — in the database, not just this tab.`,
  });
}

// One message per way a save can fail, because "Error" is not an instruction.
function editorSaveErrorText(err) {
  if (err.conflict) return `${err.message} Your edits are still on screen — copy anything you need, then reload from the datastore.`;
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
  if (!confirm(`Delete "${name}"?\n\nIt is removed from the station list. The record is kept and can be restored by whoever administers the database.`)) return;

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

