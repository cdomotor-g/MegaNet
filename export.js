// MegaNet — export.js
//
//   renderExportHtml   the Export tab: pick radio networks, get Radio Mobile
//   and the export     and CSV output for what is on them.
//   builders behind it
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, announce, netName, csvEscape,
// dlText and RM_NET_DEFAULTS; across to app.js for findStationMatches, stationAlertIds and
// repeaterPassingCount; and to datastore.js for renderDbStatusHtml, which
// renders the datastore panel this tab hosts. The snapshot button written here
// calls snapshotStationsJson() over in datastore.js for the same reason — see
// that file's header.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.
// Restyled against the design system by U6 (#141) of EPIC #107 — the classes
// this file names live in the "Export tab (#141)" section of styles.css.

// ── EXPORT tab ─────────────────────────────────────────────────────────────────

function renderExportHtml() {
  const nets = state.data.radio_networks || [];
  if (!state.exportNets) state.exportNets = new Set(nets.map(n => n.id));

  const selRpts = state.data.stations.filter(s =>
    s.roles.includes('repeater') && s.repeater &&
    s.radio_network_ids.some(id => state.exportNets.has(id))
  );
  const unitCount = countExportUnits(state.exportNets);

  return `
    <div class="layout">
      <aside class="sidebar stack" aria-label="Export options">
        <div class="panel">
          <div class="panel-header">
            <h2 id="exp-nets-h">BoM Networks</h2>
            <span class="exp-head-acts" role="group" aria-label="Select networks">
              <button class="exp-btn-sm" data-all="1" onclick="exportSelectAll(true)"
                      aria-label="Select every BoM network">All</button>
              <button class="exp-btn-sm" data-all="0" onclick="exportSelectAll(false)"
                      aria-label="Clear every BoM network">None</button>
            </span>
          </div>
          <div class="checklist" role="group" aria-labelledby="exp-nets-h">
            ${nets.map(n => `
              <label>
                <input type="checkbox" data-net="${escAttr(n.id)}"
                       ${state.exportNets.has(n.id) ? 'checked' : ''}
                       onchange="toggleExportNet('${escAttr(n.id)}',this.checked)">
                ${esc(n.name)}
              </label>`).join('')}
          </div>
        </div>

        <!-- The count of what the ticks above add up to. Not a live region of
             its own: every tick re-renders the whole tab, so this element is a
             *new* node each time and a freshly-inserted live region is not
             reliably announced. The count goes through announce() instead, from
             the two handlers that change it. -->
        <div class="panel">
          <div class="small" id="exp-count">
            <strong>${selRpts.length}</strong> repeater${selRpts.length !== 1 ? 's' : ''} selected<br>
            <strong>${unitCount}</strong> total units in export
          </div>
        </div>

        <!-- The station list itself now comes from the datastore, so this panel
             answers two questions rather than one: what is on screen, and
             whether the database is reachable. They can disagree — a healthy
             connection under a station list that fell back to a file is exactly
             the case worth being able to see. -->
        <div class="panel">
          <div class="panel-header">
            <h2>Data source</h2>
            <button class="exp-btn-sm" onclick="dbCheck()"
                    aria-label="Re-test the datastore connection">Re-test</button>
          </div>
          <div id="db-status" role="status">${renderDbStatusHtml()}</div>
        </div>

        <!-- The JSON escape hatch. Edits land in the database now, so the file
             has to be refreshable from it — see snapshotStationsJson(). -->
        <div class="panel">
          <div class="panel-header">
            <h2>stations.json</h2>
            <button id="btn-snapshot" class="exp-btn-sm" onclick="snapshotStationsJson()"
                    title="Download the database's current station list as stations.json">Snapshot</button>
          </div>
          <div class="small">
            The whole station list as a file — the offline copy, and what this app
            falls back to when the datastore cannot be reached. Taken from the
            database as it is right now, not from what this tab has loaded.
          </div>
          <div id="snapshot-note" class="small exp-note" role="status"></div>
        </div>
      </aside>

      <div>
        <div class="panel stack exp-main-panel">
          <div class="panel-header">
            <h2 id="exp-files-h">Radio Mobile Export</h2>
            <button class="primary" onclick="runExport()">Generate &amp; Download All</button>
          </div>
          <div class="table-wrap">
            <table>
              <caption class="sr-only">The five files "Generate &amp; Download All" produces, and what each holds</caption>
              <thead><tr><th scope="col">File</th><th scope="col">Contents</th></tr></thead>
              <tbody>
                <tr><td><code>MegaNet.csv</code></td>        <td class="small">Master config — version, map/land paths, $Include list</td></tr>
                <tr><td><code>MegaNet_Network.csv</code></td><td class="small">One row per selected repeater, propagation parameters</td></tr>
                <tr><td><code>MegaNet_Unit.csv</code></td>   <td class="small">All units (repeaters + pass-range matched field stations)</td></tr>
                <tr><td><code>MegaNet_System.csv</code></td> <td class="small">Transmitter/receiver system specs</td></tr>
                <tr><td><code>MegaNet_NetData.csv</code></td><td class="small">Network membership matrix (heights, system IDs, roles)</td></tr>
              </tbody>
            </table>
          </div>
          <div class="note compact">
            RM paths from <code>meta.rm_paths</code>:
            <code>${esc((state.data.meta?.rm_paths?.map) || 'not set')}</code>
          </div>
        </div>

        <div class="panel exp-repeaters">
          <div class="panel-header"><h2 id="exp-rpts-h">Selected Repeaters</h2></div>
          ${selRpts.length ? `
            <div class="table-wrap medium" role="region" tabindex="0" aria-labelledby="exp-rpts-h">
              <table>
                <caption class="sr-only">The ${selRpts.length} repeater${selRpts.length !== 1 ? 's' : ''} the ticked networks put in the export</caption>
                <colgroup>
                  <col style="width:28%"><col style="width:20%"><col style="width:13%">
                  <col style="width:13%"><col style="width:26%">
                </colgroup>
                <thead><tr>
                  <th scope="col">Repeater</th>
                  <th scope="col" class="col-optional">Network</th>
                  <th scope="col">Rx (MHz)</th><th scope="col">Tx (MHz)</th>
                  <th scope="col">Pass ranges</th>
                </tr></thead>
                <tbody>
                  ${selRpts.map(r => `
                    <tr>
                      <td>${esc(r.name)}</td>
                      <td class="small col-optional">${r.radio_network_ids.map(id => netName(id)).join(', ')}</td>
                      <td class="rx-cell small">${r.repeater.rx_mhz || ''}</td>
                      <td class="tx-cell small">${r.repeater.tx_mhz || ''}</td>
                      <td class="small">${(r.repeater.pass_ranges || []).map(p => `${p.low}–${p.high}`).join(', ')}${
                        repeaterPassingCount(r) != null
                          ? ` <span class="badge" title="ALERT addresses carried, post-exclusion">passing ${repeaterPassingCount(r)}</span>`
                          : ''}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>`
          : `<p class="small table-empty">No network is ticked, so the export would be empty.
               Tick one on the left, or press <b>All</b>.</p>`}
        </div>
      </div>
    </div>`;
}

// Both selection handlers rebuild the whole tab, because the counts and the
// repeater table are downstream of the ticks. That is fine for a mouse and was
// silently hostile to a keyboard: the checkbox that was just operated no longer
// exists when the render finishes, so focus was dropped on <body> after every
// single tick — the same failure #109 fixed in the nav, in a tab nobody had
// looked at. Re-rendering and then putting focus back on the equivalent control
// is the whole fix; `find` is how each caller says which control that is. It is
// a function rather than a selector string because a network id goes into an
// attribute selector, and quoting one safely is a job for the DOM rather than
// for string concatenation.
function rerenderExport(find) {
  document.getElementById('main-content').innerHTML = renderExportHtml();
  const el = find && find();
  if (el) el.focus();
  announce(exportSelectionSummary());
}

// What the ticks currently add up to. Said out loud rather than left to the
// count panel: that panel is a new node on every render, and a live region that
// has only just been inserted is not reliably announced.
function exportSelectionSummary() {
  const rpts = state.data.stations.filter(s =>
    s.roles.includes('repeater') && s.repeater &&
    s.radio_network_ids.some(id => state.exportNets.has(id))
  ).length;
  const nets = state.exportNets.size;
  return `${nets} network${nets === 1 ? '' : 's'} selected — `
       + `${rpts} repeater${rpts === 1 ? '' : 's'}, `
       + `${countExportUnits(state.exportNets)} units in the export.`;
}

function toggleExportNet(id, checked) {
  if (checked) state.exportNets.add(id); else state.exportNets.delete(id);
  rerenderExport(() => [...document.querySelectorAll('.checklist input[data-net]')]
    .find(el => el.dataset.net === id));
}

function exportSelectAll(v) {
  state.exportNets = v
    ? new Set((state.data.radio_networks || []).map(n => n.id))
    : new Set();
  rerenderExport(() => document.querySelector(`.exp-head-acts button[data-all="${v ? 1 : 0}"]`));
}

function countExportUnits(selectedNets) {
  const rpts = state.data.stations.filter(s =>
    s.roles.includes('repeater') && s.repeater &&
    s.radio_network_ids.some(id => selectedNets.has(id))
  );
  const ids = new Set(rpts.map(s => s.id));
  rpts.forEach(r => findStationMatches(r).forEach(s => ids.add(s.id)));
  return ids.size;
}

function runExport() {
  const { data, exportNets } = state;
  const paths   = data.meta?.rm_paths || {};
  const systems = data.rm_systems || [];
  const all     = data.stations;

  const repeaters = all.filter(s =>
    s.roles.includes('repeater') && s.repeater &&
    s.radio_network_ids.some(id => exportNets.has(id))
  );

  // Collect all units: repeaters + their matched field stations
  const unitMap = new Map();
  repeaters.forEach(r => {
    unitMap.set(r.id, r);
    findStationMatches(r).forEach(s => unitMap.set(s.id, s));
  });
  const units    = [...unitMap.values()];
  const unitRmId = new Map(units.map((u, i) => [u.id, i + 1]));

  // MegaNet.csv
  const megaNetCsv = [
    'Radio Mobile', '$Version', '4000', '","',
    '$Map', paths.map || '', '$Picture', paths.jpg || '', paths.jpg || '',
    '$Land', paths.land || '',
    '$Include', 'MegaNet_Network.csv', 'MegaNet_Unit.csv', 'MegaNet_System.csv', 'MegaNet_NetData.csv',
  ].join('\n');

  // MegaNet_Network.csv
  const d = RM_NET_DEFAULTS;
  const networkCsv = [
    'Radio Mobile', '$Style', 'Prop mode,Color 1,Color 2,Color 3', '0,38,40,81',
    '$Coverage',
    'AntAzt,Area,Color area,Contour,Color contour,D min,D max,Azt min,Azt max,Azt inc,Threshold mode,Visual color,Sensor h,Target h',
    '0,1,FFFF,1,0,0.01,50,0,360,1,1,FFFF,2,2',
    '$Net', `Nbr nets,Nbr units,Nbr systems`, `${repeaters.length},${units.length},${Math.max(systems.length, 2)}`,
    'Net ID,Net name,Visible,Minimum fx,Max Fx,Refractivity,Conductivity,Permittivity,Polarization,Climate,Stat. mode,%Time,%Location,%Situation,Topology,Max Rebro,%Urban or Tree',
    ...repeaters.map((r, i) => [
      i + 1, csvEscape(r.name), d.Visible, d['Minimum fx'], d['Max Fx'], d.Refractivity,
      d.Conductivity, d.Permittivity, d.Polarization, d.Climate, d['Stat. mode'],
      d['%Time'], d['%Location'], d['%Situation'], d.Topology, d['Max Rebro'], d['%Urban or Tree'],
    ].join(',')),
  ].join('\n');

  // MegaNet_Unit.csv
  const unitCsv = [
    'Unit ID,Unit name,Enabled,Latitude,Longitude,Elevation,Icon,Forecolor,Style,Backcolor,Text,Locked',
    ...units.map(u => {
      const isRpt = u.roles.includes('repeater');
      const aids  = stationAlertIds(u);
      return [
        unitRmId.get(u.id), csvEscape(u.name), u.enabled ? 1 : 0,
        u.lat ?? '', u.lon ?? '', u.elevation_ahd ?? 0,
        isRpt ? 307 : 243, 'FFFFFF', isRpt ? 0 : 1, 0,
        aids.length ? aids[0].toFixed(1) : '', 0,
      ].join(',');
    }),
  ].join('\n');

  // MegaNet_System.csv
  const sysDefs = systems.length ? systems : [
    { id: 1, name: 'Field Station 1W', tx_power_w: 1, line_loss_db: 1, supp_loss_db_m: 0, antenna_type: 'omni.ant', antenna_gain_dbi: 5.15, antenna_height_m: 4, rx_threshold_dbm: -117.001 },
    { id: 2, name: 'Field Station 5W', tx_power_w: 5, line_loss_db: 1, supp_loss_db_m: 0, antenna_type: 'omni.ant', antenna_gain_dbi: 5.15, antenna_height_m: 2, rx_threshold_dbm: -117.001 },
  ];
  const systemCsv = [
    'Radio Mobile', '$System',
    'System ID,System name,Tx power(W),Line loss(dB),Supplemental Line loss(dB/m),Antenna type,Antenna gain(dBi),Antenna height(m),Rx threshold(dBm)',
    ...sysDefs.map(s => [
      s.id, csvEscape(s.name), s.tx_power_w ?? '', s.line_loss_db ?? '', s.supp_loss_db_m ?? 0,
      s.antenna_type || 'omni.ant', s.antenna_gain_dbi ?? '', s.antenna_height_m ?? '', s.rx_threshold_dbm ?? '',
    ].join(',')),
  ].join('\n');

  // MegaNet_NetData.csv
  // For each repeater row: which units are in its network (1 = repeater itself, 2 = matched field stations)
  const unitIds = units.map(u => u.id);

  function netSection(tag, cellFn) {
    const header = ['', ...units.map(u => csvEscape(u.name))].join(',');
    const rows   = repeaters.map(r => {
      const matched = new Set(findStationMatches(r).map(s => s.id));
      return [csvEscape(r.name), ...unitIds.map(uid => {
        if (uid === r.id)      return cellFn(true,  false);
        if (matched.has(uid))  return cellFn(false, true);
        return 0;
      })].join(',');
    });
    return [tag, header, ...rows].join('\n');
  }

  const netDataCsv = [
    netSection('$NetAntHeight', (isRpt, isFld) => isRpt ? 2 : 4),
    netSection('$NetAntAzt',    (isRpt, isFld) => 0),
    netSection('$NetAntElv',    (isRpt, isFld) => 0),
    netSection('$NetSystem',    (isRpt, isFld) => 1),
    netSection('$NetRole',      (isRpt, isFld) => isRpt ? 1 : 2),
  ].join('\n');

  const files = [
    ['MegaNet.csv',         megaNetCsv ],
    ['MegaNet_Network.csv', networkCsv ],
    ['MegaNet_Unit.csv',    unitCsv    ],
    ['MegaNet_System.csv',  systemCsv  ],
    ['MegaNet_NetData.csv', netDataCsv ],
  ];
  files.forEach(([name, content], i) => {
    setTimeout(() => dlText(name, content), i * 180);
  });

  // Five downloads, spaced 180 ms apart so the browser does not fold them into
  // one prompt — which means the only sign the button worked is five files
  // appearing somewhere off screen. Said once, after the last one is handed
  // over, and it says what was produced rather than that something happened.
  // Focus stays on the button, which is where the operator left it and where
  // "do that again" is.
  setTimeout(() => announce(
    `Exported ${files.length} Radio Mobile files — `
    + `${repeaters.length} repeater${repeaters.length === 1 ? '' : 's'}, `
    + `${units.length} unit${units.length === 1 ? '' : 's'}. Check your downloads.`
  ), (files.length - 1) * 180 + 60);
}

