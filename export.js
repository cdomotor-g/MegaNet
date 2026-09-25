// MegaNet — export.js
//
//   renderExportHtml   the Export tab: pick radio networks, get Radio Mobile
//   and the export     and CSV output for what is on them.
//   builders behind it
//   stationKml         …and one station as a Google Earth KML: its pin, the
//                      far end of every link, and a line for each (#176). Not
//                      part of the tab — the pill that calls it lives on the
//                      station card and the editor card — but it is an export
//                      builder, and this is where those live.
//   drawingKml         …and the Draw & measure drawing as a second KML: every
//                      circle, box, path, pin and note on the Stations map,
//                      with the stations they enclose or run between (#183).
//                      Same reason for living here, same button-somewhere-else.
//   sitesKml           …and the repeater site finder's answer as a third, as a
//                      KMZ with its own numbered pins or as plain KML: every
//                      candidate, the path from each to every site, grouped per
//                      candidate so one can be on and the rest off, and the
//                      sites themselves. zipStore is the KMZ's container.
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, announce, netName, csvEscape,
// dlText, acmaHaversineKm, stationLatLonText and RM_NET_DEFAULTS; across to
// app.js for findStationMatches, findRepeaterMatches, stationAlertIds and
// repeaterPassingCount; to map-backbone.js for backboneLinks; to map-wind.js
// for the region a KML's station sits in; to map-draw.js for MapDraw's
// exportShapes(), which is the whole of what the drawing KML reads; to
// map-sites.js for MapSites.exportSites() and status(), which are the whole
// of what the site finder's file reads (plus core.js's destPoint and slug); and to
// datastore.js for renderDbStatusHtml, which renders the datastore panel this
// tab hosts. The snapshot button written here calls snapshotStationsJson()
// over in datastore.js for the same reason — see that file's header. Every one
// of them is called from inside a function here, so this file's position among
// the modules stays free.
//
// Moved out of app.js byte-for-byte by M3 (#134) of #129.
// Restyled against the design system by U6 (#141) of EPIC #107 — the classes
// this file names live in the "Export tab (#141)" section of styles.css.

// ── EXPORT tab ─────────────────────────────────────────────────────────────────

// Signing in is what this tab's two buttons now cost (#191), and the reason is
// the same one the station editor gives: what leaves here is the whole network,
// not a view of it. "Generate & Download All" writes the Radio Mobile
// configuration for every repeater on the ticked networks and every station
// their pass ranges reach — coordinates, heights, frequencies and pass windows
// for a few hundred sites in one press — and Snapshot writes the station
// document itself. Reading a station on the map is a page view; taking the
// list away as a file is not, and the editors list is already the app's answer
// to "who is this".
//
// What is *not* gated is deliberate. The network ticks, the counts, the
// repeater table, the Data source panel and its Re-test button all stay live
// for anyone: they say what this tab would produce and whether the database is
// reachable, which is exactly what somebody needs to see before deciding
// whether signing in is worth it — and none of them is a copy of anything.
//
// The gate is checked twice on purpose. Once in the markup, so a signed-out
// visitor is offered a sign-in button rather than a button that will refuse
// them; and once at the top of each action, because the markup is a render
// that can be older than the session — a token can expire, or be signed out in
// another tab, while this one is still on screen showing yesterday's buttons.
function exportMayDownload() {
  return typeof Auth !== 'undefined' && Auth.isSignedIn && Auth.isSignedIn();
}

// The one line every gated control says when it is standing in for itself.
function exportGateNoteHtml(what) {
  return `<p class="small exp-gate-note">
    <a href="#" onclick="Auth.open();return false">Sign in</a> to ${esc(what)} —
    everything else on this tab reads without one, and your ticks are kept while you do.</p>`;
}

function renderExportHtml() {
  const nets = state.data.radio_networks || [];
  if (!state.exportNets) state.exportNets = new Set(nets.map(n => n.id));
  const mayDl = exportMayDownload();

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
            ${mayDl
              ? `<button id="btn-snapshot" class="exp-btn-sm" onclick="snapshotStationsJson()"
                    title="Download the database's current station list as stations.json">Snapshot</button>`
              : `<button class="exp-btn-sm" onclick="Auth.open()"
                    title="Downloading the station document needs a signed-in session">Sign in to snapshot</button>`}
          </div>
          <div class="small">
            The whole station list as a file — the offline copy, and what this app
            falls back to when the datastore cannot be reached. Taken from the
            database as it is right now, not from what this tab has loaded.
          </div>
          ${mayDl ? '' : exportGateNoteHtml('download the station document')}
          <div id="snapshot-note" class="small exp-note" role="status"></div>
        </div>
      </aside>

      <div>
        <div class="panel stack exp-main-panel">
          <div class="panel-header">
            <h2 id="exp-files-h">Radio Mobile Export</h2>
            ${mayDl
              ? `<button class="primary" onclick="runExport()">Generate &amp; Download All</button>`
              : `<button class="primary" onclick="Auth.open()"
                    title="Generating the Radio Mobile set needs a signed-in session">Sign in to generate</button>`}
          </div>
          ${mayDl ? '' : exportGateNoteHtml('generate the five Radio Mobile files')}
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
  // The second check. See exportMayDownload(): the button above may have been
  // drawn before the session went away. The repaint goes first and the refusal
  // second, because rerenderExport() ends by announcing the selection summary —
  // announcing before it would put the refusal in the live region and then
  // immediately overwrite it with a sentence about network ticks.
  if (!exportMayDownload()) {
    rerenderExport(() => document.querySelector('.exp-main-panel .primary'));
    announce('Not exported — the Radio Mobile files need a signed-in session. Sign in and press it again.');
    return;
  }
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
  // The two systems this network is, for a document that arrived without them.
  // Line loss is the half a decibel the real rm_systems rows now carry — these
  // stand in for those rows, so a figure they disagreed on would export a
  // Radio Mobile file that quietly modelled a different network.
  const sysDefs = systems.length ? systems : [
    { id: 1, name: 'Field Station 1W', tx_power_w: 1, line_loss_db: 0.5, supp_loss_db_m: 0, antenna_type: 'omni.ant', antenna_gain_dbi: 5.15, antenna_height_m: 4, rx_threshold_dbm: -117.001 },
    { id: 2, name: 'Field Station 5W', tx_power_w: 5, line_loss_db: 0.5, supp_loss_db_m: 0, antenna_type: 'omni.ant', antenna_gain_dbi: 5.15, antenna_height_m: 2, rx_threshold_dbm: -117.001 },
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


// ── Google Earth: the station, and the lines out of it (#176) ────────────────
//
// The callout, the station card and the editor card have carried a **Google
// Earth ↗** link since long before this — a camera URL that flies to the
// coordinate and shows the ground. What it could never carry is the thing the
// Stations map draws around that pin: the paths to the repeaters that hear it.
// Somebody standing in Google Earth looking at a hilltop wants to know what
// the hop actually crosses, and a coordinate on its own cannot tell them.
//
// So the pill beside it hands over a KML file instead of a URL: the station's
// own pin, the far end of every link, and a line for each one — pass-range
// links in the map's amber and backbone paths in its heavier black, named with
// the distance so the file reads as a list as well as a picture. Google Earth
// (desktop and web), Google My Maps, QGIS, ArcGIS and every handheld that
// takes a track file all open it.
//
// A file rather than a URL because there is no URL form of this: Google's
// Earth URLs carry a camera, not geometry. It is generated in the browser from
// the same passRelationIndex and backboneIndex the map draws from, so a KML and
// the map can never disagree about who carries whom.

// Lines produced before the file stops adding them. A repeater carrying a
// couple of hundred field stations is a legitimate thing to export — that
// fan-out is exactly the picture somebody wants in Earth — but a file is not
// the place to discover that a pass range is open far wider than anyone meant.
const KML_LINK_CAP = 500;

// KML is XML, and a station named "Smith & Sons" is a well-formed way to break
// a file. Everything written into an element goes through here.
//
// The C0 control characters XML 1.0 forbids outright (all of them bar tab,
// newline and carriage return) are dropped rather than escaped, because there
// is no escaping them: `&#1;` is as illegal as the byte. One of them pasted
// into a remarks box from a spreadsheet would otherwise make the whole file
// unreadable in Google Earth, with no message that says which site did it.
function kmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// KML colours are aabbggrr — alpha first, then the RGB channels backwards.
// Written out of the same hex the map uses so the two cannot drift.
function kmlColor(hex, alpha = 'ff') {
  const h = String(hex).replace('#', '');
  return `${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toLowerCase();
}

// One station's <Placemark>. `role` decides the pin colour, which is Google's
// own palette rather than the map's: Earth draws a pushpin from an icon URL,
// and a station in a colour nobody has ever seen on a pushpin reads as a bug.
//
// Description before styleUrl, which is the order the KML 2.2 schema gives a
// Feature's children in. Google Earth reads either; a schema validator only
// accepts this one, and the site finder's file is checked against it.
function kmlPlacemark(s, styleId, extra) {
  const rows = [
    ['Station #', s.station_number],
    ['Roles', (s.roles || []).join(', ')],
    ['Elevation', s.elevation_ahd != null ? `${s.elevation_ahd} m AHD` : ''],
    ['ALERT ids', stationAlertIds(s).join(', ')],
    ['Position', stationLatLonText(s)],
    ...(extra || []),
  ].filter(([, v]) => v != null && v !== '');
  return `  <Placemark>
    <name>${kmlEsc(s.name)}</name>
    <description><![CDATA[${rows.map(([k, v]) =>
      `<b>${kmlEsc(k)}:</b> ${kmlEsc(v)}`).join('<br>')}]]></description>
    <styleUrl>#${styleId}</styleUrl>
    <Point><coordinates>${s.lon},${s.lat},0</coordinates></Point>
  </Placemark>`;
}

// One link. `clampToGround` + `tessellate` so the line follows the terrain in
// Earth rather than tunnelling through a ridge it is drawn over — a straight
// 3-D chord between two hilltops looks like clearance that is not there, which
// on a radio path is the one misreading that matters.
function kmlLine(a, b, styleId, name, km) {
  return `  <Placemark>
    <name>${kmlEsc(name)}</name>
    <styleUrl>#${styleId}</styleUrl>
    <description>${kmlEsc(`${km.toFixed(1)} km, ${a.name} → ${b.name}`)}</description>
    <LineString>
      <tessellate>1</tessellate>
      <altitudeMode>clampToGround</altitudeMode>
      <coordinates>${a.lon},${a.lat},0 ${b.lon},${b.lat},0</coordinates>
    </LineString>
  </Placemark>`;
}

// The links out of one station, as the map resolves them: the pass-range paths
// (whichever direction the relation runs) and the backbone paths this station
// is an end of. Both ends of every returned pair have a position — a link to a
// station nobody has surveyed has nowhere to draw to.
function stationKmlLinks(s) {
  const located = x => x && x.lat != null && x.lon != null;
  const seen = new Set();
  const links = [];
  const add = (kind, other) => {
    if (!located(other) || other.id === s.id || seen.has(kind + '|' + other.id)) return;
    seen.add(kind + '|' + other.id);
    links.push({ kind, other, km: acmaHaversineKm(s.lat, s.lon, other.lat, other.lon) });
  };
  // A repeater is at both ends of the relation: it carries field stations, and
  // where it has ALERT ids of its own it is carried in turn. relatedStations()
  // asks the pair the same way round.
  for (const r of findRepeaterMatches(s)) add('pass', r);
  if (s.roles.includes('repeater')) for (const f of findStationMatches(s)) add('pass', f);
  // Backbone pairs, on the Stations map's own distance rule so the file and
  // the map agree about which of them exist.
  for (const p of backboneLinks(state.mapMaxLinkKm)) {
    if (p.a.id === s.id) add('backbone', p.b);
    else if (p.b.id === s.id) add('backbone', p.a);
  }
  links.sort((x, y) => x.km - y.km);
  return links;
}

// The whole file. Written by hand rather than through a library: it is a few
// hundred lines of one XML shape, and a dependency loaded from a CDN is a
// thing that can be down when somebody is standing in a paddock.
function stationKml(s) {
  const links  = stationKmlLinks(s);
  const capped = links.length > KML_LINK_CAP;
  const kept   = capped ? links.slice(0, KML_LINK_CAP) : links;
  const passes = kept.filter(l => l.kind === 'pass');
  const backs  = kept.filter(l => l.kind === 'backbone');
  const wind   = MapWind.regionState(s.lat, s.lon);
  const nets   = (s.radio_network_ids || []).map(id => netName(id)).filter(Boolean).join(', ');

  // The map's own two link colours, so the file looks like the screen it came
  // from: amber for a pass-range path, black for a backbone one, and the
  // backbone heavier — "more prominent" is the rule refreshMapLayers keeps.
  const styles = `
  <Style id="mnStation">
    <IconStyle><scale>1.2</scale>
      <Icon><href>https://maps.google.com/mapfiles/kml/paddle/grn-stars.png</href></Icon>
    </IconStyle>
  </Style>
  <Style id="mnPeer">
    <IconStyle><scale>1.0</scale>
      <Icon><href>https://maps.google.com/mapfiles/kml/paddle/blu-circle.png</href></Icon>
    </IconStyle>
  </Style>
  <Style id="mnPass">
    <LineStyle><color>${kmlColor('#ff6f00')}</color><width>3</width></LineStyle>
  </Style>
  <Style id="mnBackbone">
    <LineStyle><color>${kmlColor('#101010')}</color><width>4</width></LineStyle>
  </Style>`;

  const folder = (name, open, body) => body
    ? `  <Folder><name>${kmlEsc(name)}</name><open>${open ? 1 : 0}</open>\n${body}\n  </Folder>`
    : '';

  const linkFolder = (name, list, styleId, arrow) => folder(name, false, list.map(l =>
    kmlLine(s, l.other, styleId, `${s.name} ${arrow} ${l.other.name} — ${l.km.toFixed(1)} km`, l.km)
  ).join('\n'));

  const peers = folder('Far ends', false, kept.map(l =>
    kmlPlacemark(l.other, 'mnPeer', [['Link to', `${s.name} — ${l.km.toFixed(1)} km`]])).join('\n'));

  const summary = [
    `${passes.length} pass-range link${passes.length === 1 ? '' : 's'}`,
    `${backs.length} backbone path${backs.length === 1 ? '' : 's'} within ${state.mapMaxLinkKm} km`,
    capped ? `capped at ${KML_LINK_CAP} lines` : '',
  ].filter(Boolean).join(' · ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${kmlEsc(s.name)} — MegaNet</name>
  <description><![CDATA[${kmlEsc(summary)}.<br>Exported from MegaNet on ${
    kmlEsc(new Date().toLocaleString())}. Pass-range links are drawn amber, backbone paths black,
    both clamped to the ground.]]></description>
${styles}
${kmlPlacemark(s, 'mnStation', [
  ['Networks', nets],
  ['Wind region', wind && wind.text !== 'looking up…' ? wind.text : ''],
  ['Links', summary],
])}
${[linkFolder('Pass-range links', passes, 'mnPass', '→'),
   linkFolder('Backbone paths', backs, 'mnBackbone', '↔'),
   peers].filter(Boolean).join('\n')}
</Document>
</kml>
`;
}

// The pill's click. Named for the station and dated, because a downloads folder
// is where these go to be found again a fortnight later.
//
// A station with no position has no pill at all (stationKmlPillHtml returns
// nothing), so the only guard needed here is against an id that no longer
// resolves — a station deleted while its card was open.
function downloadStationKml(id) {
  const s = state.data && state.data.stations.find(x => x.id === id);
  if (!s || s.lat == null || s.lon == null) {
    announce('That station has no position recorded, so there is nothing to place.');
    return;
  }
  const safe = (s.name || 'station').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'station';
  const stamp = new Date().toISOString().slice(0, 10);
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([stationKml(s)],
      { type: 'application/vnd.google-earth.kml+xml' })),
    download: `meganet-${safe}-${stamp}.kml`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  const n = stationKmlLinks(s).length;
  announce(`${s.name} downloaded as KML — the pin and ${n} link${n === 1 ? '' : 's'}. Open it in Google Earth.`);
}

// The pill itself, for the row stationActionPills builds. Next to the Google
// Earth link rather than anywhere else: they are the same errand, and the one
// that carries the network is the one worth reaching for.
function stationKmlPillHtml(s) {
  if (!s || s.lat == null || s.lon == null) return '';
  const n = stationKmlLinks(s).length;
  return `<button type="button" class="pill" onclick="downloadStationKml('${escAttr(s.id)}')"
       title="Download this station and its ${n} link line${n === 1 ? '' : 's'} as a KML file — open it in Google Earth to see the pin and the paths to its repeaters over the terrain"
       >🌏 Google Earth KML ⬇</button>`;
}

// ── Google Earth: the drawing, and what it holds (#183) ──────────────────────
//
// Draw & measure is where a plan gets made: a coverage circle round a proposed
// repeater, a box round the part of a catchment that went quiet, the path a
// new hop would take, a note saying what the picture is about. All of it is
// real geometry — a circle is 25.0 km because somebody typed 25.0 — and none
// of it survived leaving the page. The panel's own answer was "clip the
// screen", which keeps a picture of the drawing and throws away the ground.
//
// So the panel hands the whole drawing over as a KML instead. Every shape in
// the colour it was drawn in, each named by what it measures and by the sites
// it was snapped to, and — the half that makes it worth having — **the
// stations each shape holds**, so the file answers "which sites are inside
// this circle" in Google Earth rather than only on the screen it came from.
//
// The division of labour with map-draw.js is deliberate and is written on both
// sides. MapDraw.exportShapes() hands over ground truth: points, closed rings,
// colours, labels and station ids. Nothing here knows what a Leaflet layer is,
// and nothing there knows what a Placemark is. The one piece of geometry that
// could have gone either way — turning a circle into a polygon, which KML has
// no primitive for — is over there with destPoint and rectBounds, because it
// is a question about the sphere rather than about the file.
//
// Shapes and stations are two folders rather than one folder per shape: a
// station inside two circles is one pin that says it is in both, where nested
// folders would draw it twice at the same coordinate and let the two copies
// disagree the moment either was edited.

// The panel is a sketch pad and a sketch pad can be filled. The cap is on
// *stations*, not on shapes: a box drawn round a whole region can hold a
// couple of thousand pins, and a file that takes a minute to open is one
// nobody opens twice. Shapes are their own limit — they are drawn by hand.
const DRAW_KML_STATION_CAP = 1000;

// And how many of them one shape's balloon lists before it summarises. The
// pins are the list; a description is a caption.
const DRAW_KML_NAMES_SHOWN = 40;

// A hex colour the KML writer can rely on: six digits, no hash. The picker and
// the six swatches all produce exactly that, but colourOf() can also hand back
// the theme's --draw straight out of the stylesheet, and a stylesheet is free
// to say #abc. Anything that is not a hex at all (a named colour, an rgb())
// falls back to the drawing pink rather than writing a malformed <color>.
function kmlHex(c) {
  const h = String(c || '').replace('#', '').trim();
  if (/^[0-9a-f]{3}$/i.test(h)) return h.split('').map(x => x + x).join('').toLowerCase();
  if (/^[0-9a-f]{6,8}$/i.test(h)) return h.slice(0, 6).toLowerCase();
  return 'c2185b';
}

// One <Style> per colour actually used, carrying all four sub-styles at once:
// a Placemark takes only the ones its geometry has, so a pin, a line, a filled
// ring and a note can share a single style id. Two ids per colour rather than
// one, because a note is a label with no pin under it — Google Earth has no
// "hide the icon" flag, and scale 0 is the way that is said.
//
// The fill is a fifth of opaque. A coverage circle is drawn over terrain that
// is the reason for drawing it, and an opaque disc hides the hill.
function drawKmlStyles(hexes) {
  return hexes.map(h => `
  <Style id="mnDraw-${h}">
    <IconStyle>
      <color>${kmlColor('#' + h)}</color><scale>1.1</scale>
      <Icon><href>https://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon>
      <hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/>
    </IconStyle>
    <LineStyle><color>${kmlColor('#' + h)}</color><width>3</width></LineStyle>
    <PolyStyle><color>${kmlColor('#' + h, '33')}</color></PolyStyle>
  </Style>
  <Style id="mnNote-${h}">
    <IconStyle><scale>0</scale></IconStyle>
    <LabelStyle><color>${kmlColor('#' + h)}</color><scale>1.1</scale></LabelStyle>
  </Style>`).join('');
}

// A list of [lat, lon] as KML's own lon,lat,alt — the one axis order in this
// file that is worth writing down, because getting it backwards puts an
// Australian drawing in the Indian Ocean and nothing complains.
function kmlCoords(pts) {
  return pts.map(([lat, lon]) => `${lon},${lat},0`).join(' ');
}

// What one shape is called in the file. The sites it joins lead, because
// "Mt Stuart → Durikai" is the thing the line means and "18.4 km @ 043°" is
// what it measures; a shape snapped to nothing is named by its measurement
// alone. A note is its own words and needs nothing added.
function drawKmlName(sh) {
  if (sh.kind === 'text') return sh.text || 'Note';
  // A pin's measurement *is* its name once it has one — the same special case
  // rowText() makes in the panel's own list, and for the same reason: "Mt
  // Stuart — Mt Stuart" is what happens without it.
  if (sh.kind === 'pin') return sh.measure || DRAW_TOOLS.pin.label;
  const nm = sh.label;
  return nm ? `${nm} — ${sh.measure}` : (sh.measure || DRAW_TOOLS[sh.kind].label);
}

// One shape's <Placemark>. Rings are `clampToGround` + `tessellate` for the
// reason kmlLine() gives about link paths: an area drawn as a flat plate at
// one altitude floats over the valleys it is supposed to cover, and a circle
// that hangs above the ground reads as terrain it does not touch.
function drawKmlPlacemark(sh, stationNames) {
  const h = kmlHex(sh.colour);
  // A box drawn round a region can hold a couple of thousand sites, and a
  // description that long is a wall of text in a balloon nobody can scroll.
  // The pins in the Stations folder are the list; this is the summary.
  const shown = stationNames.slice(0, DRAW_KML_NAMES_SHOWN);
  const more  = stationNames.length - shown.length;
  const rows = [
    ['Shape', DRAW_TOOLS[sh.kind] ? DRAW_TOOLS[sh.kind].label : sh.kind],
    ['Measures', sh.kind === 'text' ? '' : sh.measure],
    // A line has no position of its own, so what its centre is is worth
    // saying rather than filing under the same word as a circle's.
    [sh.path ? 'Midpoint' : 'At',
      sh.centre ? `${sh.centre[0].toFixed(5)}, ${sh.centre[1].toFixed(5)}` : ''],
    [sh.ring ? `Stations inside (${stationNames.length})` : 'Stations',
      shown.join(', ') + (more > 0 ? `, and ${more} more` : '')],
  ].filter(([, v]) => v);
  const desc = `    <description><![CDATA[${rows.map(([k, v]) =>
    `<b>${kmlEsc(k)}:</b> ${kmlEsc(v)}`).join('<br>')}]]></description>`;

  const geom = sh.ring
    ? `    <Polygon>
      <tessellate>1</tessellate>
      <altitudeMode>clampToGround</altitudeMode>
      <outerBoundaryIs><LinearRing>
        <coordinates>${kmlCoords(sh.ring)}</coordinates>
      </LinearRing></outerBoundaryIs>
    </Polygon>`
    : sh.path
      ? `    <LineString>
      <tessellate>1</tessellate>
      <altitudeMode>clampToGround</altitudeMode>
      <coordinates>${kmlCoords(sh.path)}</coordinates>
    </LineString>`
      : `    <Point><coordinates>${kmlCoords([sh.point])}</coordinates></Point>`;

  return `  <Placemark>
    <name>${kmlEsc(drawKmlName(sh))}</name>
    <styleUrl>#${sh.kind === 'text' ? 'mnNote' : 'mnDraw'}-${h}</styleUrl>
${desc}
${geom}
  </Placemark>`;
}

// The whole file. Everything on the map, in draw order, plus one pin per
// station any shape holds — each saying which shapes it is in, because a
// station inside two circles is a fact about both of them.
function drawingKml(shapes) {
  // Resolving a shape's stations walks every marker on the map, so the caller
  // that already has them says so rather than paying for a second pass to
  // count what it just wrote.
  shapes = shapes || MapDraw.exportShapes();
  const byId = new Map((state.data ? state.data.stations : []).map(s => [s.id, s]));

  // Which shapes each station turned up in, in the order the shapes were
  // drawn — built once here rather than asked per placemark.
  const inShapes = new Map();
  for (const sh of shapes) {
    for (const id of sh.stationIds) {
      if (!byId.has(id)) continue;                       // deleted since it was drawn
      if (!inShapes.has(id)) inShapes.set(id, []);
      inShapes.get(id).push(drawKmlName(sh));
    }
  }
  const capped   = inShapes.size > DRAW_KML_STATION_CAP;
  const stations = [...inShapes.keys()].slice(0, DRAW_KML_STATION_CAP).map(id => byId.get(id));

  const names = sh => sh.stationIds.map(id => byId.has(id) ? byId.get(id).name : '').filter(Boolean);
  const hexes = [...new Set(shapes.map(sh => kmlHex(sh.colour)))];

  const folder = (name, open, body) => body
    ? `  <Folder><name>${kmlEsc(name)}</name><open>${open ? 1 : 0}</open>\n${body}\n  </Folder>`
    : '';

  const drawn = folder(`Drawings (${shapes.length})`, true,
    shapes.map(sh => drawKmlPlacemark(sh, names(sh))).join('\n'));

  const held = folder(`Stations (${stations.length})`, false, stations.map(s =>
    kmlPlacemark(s, 'mnStation', [['In', (inShapes.get(s.id) || []).join(' · ')]])).join('\n'));

  const summary = [
    `${shapes.length} shape${shapes.length === 1 ? '' : 's'}`,
    `${inShapes.size} station${inShapes.size === 1 ? '' : 's'}`,
    capped ? `capped at ${DRAW_KML_STATION_CAP} pins` : '',
  ].filter(Boolean).join(' · ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>MegaNet drawing — ${kmlEsc(summary)}</name>
  <description><![CDATA[${kmlEsc(summary)}.<br>Exported from MegaNet's Draw &amp;
    measure panel on ${kmlEsc(new Date().toLocaleString())}. Shapes keep the colour they
    were drawn in and are clamped to the ground; each names the stations it encloses or
    runs between, and each of those stations names the shapes it is in.]]></description>
  <Style id="mnStation">
    <IconStyle><scale>1.2</scale>
      <Icon><href>https://maps.google.com/mapfiles/kml/paddle/grn-stars.png</href></Icon>
    </IconStyle>
  </Style>${drawKmlStyles(hexes)}
${[drawn, held].filter(Boolean).join('\n')}
</Document>
</kml>
`;
}

// The button's click, from the Draw & measure flyout. Dated rather than named,
// because a drawing has no name — what it is called is what is in it, and the
// file says that in its own <name> once it is open.
function downloadDrawingKml() {
  if (!state.draw.shapes.length) {
    announce('Nothing is drawn on the map yet, so there is nothing to export.');
    return;
  }
  const shapes = MapDraw.exportShapes();
  const stamp  = new Date().toISOString().slice(0, 10);
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([drawingKml(shapes)],
      { type: 'application/vnd.google-earth.kml+xml' })),
    download: `meganet-drawing-${stamp}.kml`,
  });
  a.click();
  URL.revokeObjectURL(a.href);

  // Counted the way the file counts: an id that no longer resolves to a
  // station got no pin, so it is not one of the stations that left.
  const known = new Set((state.data ? state.data.stations : []).map(s => s.id));
  const held  = new Set();
  for (const sh of shapes) for (const id of sh.stationIds) if (known.has(id)) held.add(id);
  const n = shapes.length;
  announce(`Drawing downloaded as KML — ${n} shape${n === 1 ? '' : 's'} and `
    + `${held.size} station${held.size === 1 ? '' : 's'}. Open it in Google Earth.`);
}

// ── Google Earth: the repeater site finder's answer (map-sites.js) ───────────
//
// The finder's answer is a short list to take to a map and a landholder, and
// the map most people take it to is Google Earth: the candidates stood on real
// imagery, the paths draped over the real hills, the question "can a truck get
// up there" answered by looking. So the panel writes it as a file Earth opens —
// every candidate, the path from each to every site it has to serve, and those
// sites — laid out so it can be *compared* there, one candidate at a time.
//
// **The layout is the feature.** One folder per candidate, holding its pin and
// a sub-folder of its paths, so ticking a folder in Earth's list puts one
// candidate and its fan of paths on and leaves the rest off. #1's paths start
// on and every other candidate's start off: with five candidates and a dozen
// sites that is sixty lines, and sixty lines on at once is a tangle nobody can
// read — which is exactly why the map itself only draws the chosen one's. The
// pins, the sites and the search area are always on; they are what the file is
// about.
//
// `<visibility>0</visibility>` is written on the paths' folder **and** on each
// path inside it. The KML spec says a folder's visibility is enough (a feature
// is drawn only when every ancestor is), but Earth on the web converts an
// imported file into project features, and a converter that copies each
// placemark's own flag and drops the folder's would turn every candidate's
// paths on at once. Belt and braces costs a line per path.
//
// **KMZ first, KML second.** A KMZ is a zip whose first entry is doc.kml, and
// the one thing it can carry that a KML cannot is pictures: the pins here are
// drawn on a canvas in the map's own style — the same blue disc, white ring and
// white rank numeral as `.mn-site-mark` — so candidate #3 in Earth looks like
// candidate #3 on the map. The plain KML is the same document with Google's own
// numbered paddles instead (fetched by Earth over https), for the tools that
// will not open a zip; nothing but the icon styles differs between the two, and
// the check holds them to that.
//
// **Heights.** Paths are clampToGround and tessellated, for kmlLine()'s reason:
// a straight chord between two hilltops looks like clearance that is not there.
// The one exception is a folder that says what it is in its name — *Sight lines
// at antenna height (3-D)*, off by default for every candidate — holding
// straight chords from the mast top to each site's antenna top, relative to the
// ground, because "is anything solid in the way" is a question Earth's 3-D
// terrain answers well. It is not Fresnel clearance, and every chord says so.
// Absolute altitudes are never written: the finder's heights are ~30 m SRTM
// above the geoid, Earth's terrain is its own, and a mast written at the one's
// height stands in the other's air or under its ground.
//
// **Colour** is the band the finder already decided (bandOf in map-sites.js),
// as BAND's literal hexes — never cssVar, which would make the file depend on
// the theme that happened to be on. KML has no dashes, so the map's dashed
// "the ground cuts this path" becomes a thinner, fainter line in the same band
// colour.

// The pin blue and the search area's outline. A literal, for `.sites-rank`'s
// reason in styles.css: --accent is a pale blue in the dark theme, and a file
// is not themed.
const SITES_KML_ACCENT = '#0b5cab';

// How many vertices the search area's outline gets. MapDraw's circles use the
// same 72 (ringFor), and a coverage circle is no rounder for having more.
const SITES_KML_RING_SIDES = 72;

// A hex the KML colour writer can trust, or the fallback — kmlColor assumes
// six digits and would write garbage for anything else. Not kmlHex(), whose
// fallback is the drawing pink.
function sitesKmlHex(h, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(h || '')) ? h : fallback;
}

function sitesKmlDb(v) {
  return v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
}

function sitesKmlF(v, dp) {
  return v == null || !isFinite(v) ? '' : Number(v).toFixed(dp);
}

// What a figure was computed from, in the panel's own words.
function sitesKmlSource(src, samples) {
  switch (src) {
    case 'cover': return `${samples}-sample profile with the land cover on it — the link budget card's figure`;
    case 'bare':  return `${samples}-sample profile over bare ground — the land cover could not be had, so kinder than the card`;
    case 'grid':  return 'screened off the ~30 m grid only — the tiles for the full profile would not load';
    default:      return 'could not be computed';
  }
}

// The two icon sets. `kmz`: the PNGs this file draws, inside the zip, centred
// on the point as the map's pin is. `web`: Google's own numbered paddles and
// its target, which Earth fetches itself — a paddle's point is its tip, so its
// hot spot is the bottom middle. The web target is white rings, tinted here.
function sitesKmlIcons(kind) {
  if (kind === 'kmz') {
    return {
      site: r => `files/site-${r}.png`, siteScale: 1.0,
      siteHot: '<hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/>',
      target: 'files/target.png', targetTint: '', targetScale: 0.9,
    };
  }
  return {
    site: r => `https://maps.google.com/mapfiles/kml/paddle/${r}.png`, siteScale: 1.1,
    siteHot: '<hotSpot x="32" y="1" xunits="pixels" yunits="pixels"/>',
    target: 'https://maps.google.com/mapfiles/kml/shapes/target.png',
    targetTint: `<color>${kmlColor(SITES_KML_ACCENT)}</color>`, targetScale: 0.9,
  };
}

// One Placemark, its children in the KML 2.2 schema's order — name,
// visibility, description, LookAt, styleUrl, ExtendedData, geometry. The
// description arrives as HTML already escaped; it goes into CDATA, and since
// every piece of user text in it has been through kmlEsc (which turns `>`
// into `&gt;`) nothing in it can close the CDATA early. ExtendedData names are
// the CSV's own column names, which are constants — so the attribute needs no
// escaping, and a spreadsheet and a KML of the same answer name their fields
// alike.
function sitesKmlPlacemark(p) {
  return [
    '    <Placemark>',
    `      <name>${kmlEsc(p.name)}</name>`,
    p.hidden ? '      <visibility>0</visibility>' : '',
    p.description ? `      <description><![CDATA[${p.description}]]></description>` : '',
    p.lookAt || '',
    `      <styleUrl>#${p.style}</styleUrl>`,
    p.data ? `      <ExtendedData>${p.data.map(([k, v]) =>
      `<Data name="${k}"><value>${kmlEsc(v)}</value></Data>`).join('')}</ExtendedData>` : '',
    p.geometry,
    '    </Placemark>',
  ].filter(Boolean).join('\n');
}

function sitesKmlFolder(name, { open = false, hidden = false } = {}, body = '') {
  return [
    '  <Folder>',
    `    <name>${kmlEsc(name)}</name>`,
    hidden ? '    <visibility>0</visibility>' : '',
    `    <open>${open ? 1 : 0}</open>`,
    body,
    '  </Folder>',
  ].filter(Boolean).join('\n');
}

function sitesKmlLookAt(lat, lon, rangeM, tilt, indent) {
  return `${indent}<LookAt><longitude>${lon}</longitude><latitude>${lat}</latitude>`
    + `<altitude>0</altitude><heading>0</heading><tilt>${tilt}</tilt>`
    + `<range>${Math.round(rangeM)}</range><altitudeMode>relativeToGround</altitudeMode></LookAt>`;
}

// Which candidate serves one site best, for that site's balloon: a candidate
// standing on it, else the largest margin to it. The question somebody asks
// of a gauge in Earth is "which of these would carry me".
function sitesKmlBest(data, k) {
  let best = null;
  for (const r of data.results) {
    const l = r.links[k];
    if (!l || l.failed) continue;
    if (l.colo) return `#${r.rank} — the candidate stands on it`;
    if (l.margin == null) continue;
    if (!best || l.margin > best.l.margin) best = { r, l };
  }
  return best ? `#${best.r.rank} at ${sitesKmlDb(best.l.margin)} (${best.l.verdict})`
              : 'no candidate has a margin to it';
}

function sitesKmlStyles(data, icons) {
  const bands = ['good', 'ok', 'bad', 'none'];
  const fall = { good: '#00e676', ok: '#ffab00', bad: '#e53935', none: '#888888' };
  const out = data.results.map(r => `
  <Style id="mnSite-${r.rank}">
    <IconStyle><scale>${icons.siteScale}</scale>
      <Icon><href>${icons.site(r.rank)}</href></Icon>
      ${icons.siteHot}
    </IconStyle>
    <LabelStyle><scale>0.9</scale></LabelStyle>
  </Style>`);
  // A station to serve and a proposed site with no station yet: the same
  // target, the proposed one labelled in amber so the two read apart.
  out.push(`
  <Style id="mnTarget">
    <IconStyle>${icons.targetTint}<scale>${icons.targetScale}</scale>
      <Icon><href>${icons.target}</href></Icon>
    </IconStyle>
    <LabelStyle><scale>0.8</scale></LabelStyle>
  </Style>
  <Style id="mnTargetPt">
    <IconStyle>${icons.targetTint}<scale>${icons.targetScale}</scale>
      <Icon><href>${icons.target}</href></Icon>
    </IconStyle>
    <LabelStyle><color>${kmlColor('#ffb300')}</color><scale>0.8</scale></LabelStyle>
  </Style>`);
  for (const b of bands) {
    const hex = sitesKmlHex(data.bands && data.bands[b], fall[b]);
    out.push(`
  <Style id="mnLink-${b}"><LineStyle><color>${kmlColor(hex)}</color><width>3</width></LineStyle></Style>
  <Style id="mnLinkObs-${b}"><LineStyle><color>${kmlColor(hex, '99')}</color><width>2</width></LineStyle></Style>`);
  }
  out.push(`
  <Style id="mnChord"><LineStyle><color>${kmlColor('#ffffff', 'cc')}</color><width>1.5</width></LineStyle></Style>
  <Style id="mnArea">
    <LineStyle><color>${kmlColor(SITES_KML_ACCENT)}</color><width>2</width></LineStyle>
    <PolyStyle><fill>0</fill><outline>1</outline></PolyStyle>
  </Style>`);
  return out.join('');
}

// The sites to serve: a station through the station KML's own placemark, so it
// carries its number, roles, ALERT ids and position as it does in every other
// file this app writes; a proposed site plainly, because there is nothing on
// file about it but where it is.
function sitesKmlTargets(data) {
  const pms = data.targets.map((t, k) => {
    const best = sitesKmlBest(data, k);
    // The finder's own name and position for it, over whatever the station
    // record says now: a pin moved since the run would otherwise stand away
    // from the ends of the paths that were measured to it.
    if (t.station) {
      return kmlPlacemark({ ...t.station, name: t.name, lat: t.lat, lon: t.lon }, 'mnTarget', [
        ['Best served by', best],
        ['Antenna', `${t.agl} m AGL`],
      ]);
    }
    return sitesKmlPlacemark({
      name: t.name, style: 'mnTargetPt',
      description: [
        '<b>A proposed site</b> — no station on file yet',
        `<b>Position:</b> ${kmlEsc(stationLatLonText(t))}`,
        `<b>Best served by:</b> ${kmlEsc(best)}`,
        `<b>Antenna:</b> ${kmlEsc(t.agl)} m AGL, the network's most common radio`,
      ].join('<br>'),
      geometry: `      <Point><coordinates>${t.lon},${t.lat},0</coordinates></Point>`,
    });
  });
  return sitesKmlFolder(`Sites to serve (${data.targets.length})`, {}, pms.join('\n'));
}

// One candidate: its pin, its paths, and its chords.
function sitesKmlCandidate(data, r) {
  const n = data.targets.length;
  const c = r.counts;
  const first = r.rank === 1;

  // The balloon: the summary the panel prints and the per-site table it
  // opens, as the simplest HTML there is. Earth on the web strips scripts and
  // most styling from balloons, so there is none to strip: no classes, no
  // CSS, a table with a border attribute.
  const rows = r.links.map(l => {
    const t = data.targets[l.k];
    const los = l.failed ? '—' : l.colo ? 'on it' : kmlEsc(l.verdict || '—');
    const m = l.failed ? 'could not be computed' : l.colo ? 'on it' : kmlEsc(sitesKmlDb(l.margin));
    const du = l.failed || l.colo ? '' : `${kmlEsc(sitesKmlDb(l.down))} / ${kmlEsc(sitesKmlDb(l.up))}`;
    return `<tr><td>${kmlEsc(t.name)}</td><td>${sitesKmlF(l.dKm, 1)}</td><td>${los}</td><td>${m}</td><td>${du}</td></tr>`;
  }).join('');
  const bits = [];
  if (c.cover) bits.push(`${c.cover} with the land cover on`);
  if (c.bare)  bits.push(`${c.bare} over bare ground — cover unreachable, so kinder than the card`);
  if (c.grid)  bits.push(`${c.grid} screened only — the full profile's tiles would not load`);
  if (c.failed) bits.push(`${c.failed} could not be computed`);
  const pct = v => Math.round((v || 0) * 100);
  const desc = [
    `<b>#${r.rank} of ${data.results.length}</b> · ground ${Math.round(r.ground)} m · score ${Math.round(r.score)} of 100`,
    `<b>Position:</b> ${kmlEsc(stationLatLonText(r))} — ${kmlEsc(r.where)}`,
    `<b>Line of sight:</b> ${c.clear} clear${c.marginal ? `, ${c.marginal} marginal` : ''}${
      c.obstructed ? `, ${c.obstructed} obstructed` : ''} of ${n}`,
    `<b>Fade margin:</b> worst ${kmlEsc(sitesKmlDb(c.min))}, median ${kmlEsc(sitesKmlDb(c.median))} · ${
      c.served} of ${n} at ${data.okDb} dB or better`,
    `<b>Road reserve:</b> ${kmlEsc(r.roadText)}`,
    `<b>Score parts:</b> elevation ${pct(r.parts.E)} · line of sight ${pct(r.parts.L)} · fade margin ${
      pct(r.parts.F)} · road ${pct(r.parts.R)} — out of 100 each, before the weights`,
    '<table border="1" cellpadding="3" cellspacing="0"><tr><th>Site</th><th>km</th><th>Line of sight</th>'
      + `<th>Margin</th><th>Down / up</th></tr>${rows}</table>`,
    `<i>Figures: ${kmlEsc(bits.join(' · '))}. The margin is the worse of the two directions; down is repeater to site, up is site to repeater.</i>`,
  ].join('<br>');
  const pin = sitesKmlPlacemark({
    name: `#${r.rank} repeater site — ${Math.round(r.ground)} m`,
    description: desc,
    lookAt: sitesKmlLookAt(r.lat, r.lon, 4000, 55, '      '),
    style: `mnSite-${r.rank}`,
    data: [
      ['rank', r.rank], ['site_lat', sitesKmlF(r.lat, 6)], ['site_lon', sitesKmlF(r.lon, 6)],
      ['ground_m', Math.round(r.ground)], ['score', sitesKmlF(r.score, 1)],
      ['where', r.where], ['road_reserve', r.roadCsv],
    ],
    geometry: `      <Point><coordinates>${r.lon},${r.lat},0</coordinates></Point>`,
  });

  // The paths the map would draw for this candidate: a site it stands on has
  // no path, and a path that could not be computed has nothing to say — both
  // are in the balloon's table instead, which is where the map lists them too.
  const drawn = r.links.filter(l => !l.colo && !l.failed);
  const legend = `green ${data.goodDb} dB or better, yellow ${data.okDb} dB or better, red below, grey where there is no figure`;
  const paths = drawn.map(l => {
    const t = data.targets[l.k];
    const obs = l.verdict === 'obstructed';
    return sitesKmlPlacemark({
      name: `#${r.rank} → ${t.name} — ${sitesKmlF(l.dKm, 1)} km · ${sitesKmlDb(l.margin)}`,
      hidden: !first,
      description: [
        `<b>#${r.rank} → ${kmlEsc(t.name)}</b>, ${sitesKmlF(l.dKm, 1)} km`,
        `<b>Line of sight:</b> ${kmlEsc(l.verdict || '—')}${obs ? ' — the ground cuts this path' : ''}`,
        `<b>Fade margin:</b> ${kmlEsc(sitesKmlDb(l.margin))}, the worse direction — ${kmlEsc(sitesKmlDb(l.down))} repeater to site, ${
          kmlEsc(sitesKmlDb(l.up))} site to repeater`,
        `<b>Figure:</b> ${kmlEsc(sitesKmlSource(l.src, data.samples))}`,
        `<i>Coloured by fade margin: ${kmlEsc(legend)}. Drawn on the ground, not as a line of sight.</i>`,
      ].join('<br>'),
      style: `mnLink${obs ? 'Obs' : ''}-${l.band}`,
      data: [
        ['rank', r.rank], ['target', t.name], ['target_number', t.number || ''],
        ['target_lat', sitesKmlF(t.lat, 6)], ['target_lon', sitesKmlF(t.lon, 6)],
        ['distance_km', sitesKmlF(l.dKm, 2)], ['los', l.verdict || ''],
        ['margin_db', sitesKmlF(l.margin, 1)], ['margin_down_db', sitesKmlF(l.down, 1)],
        ['margin_up_db', sitesKmlF(l.up, 1)], ['figure', l.src],
      ],
      geometry: `      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${kmlCoords([[r.lat, r.lon], [t.lat, t.lon]])}</coordinates>
      </LineString>`,
    });
  });
  const chords = drawn.map(l => {
    const t = data.targets[l.k];
    return sitesKmlPlacemark({
      name: `#${r.rank} → ${t.name} — straight chord at antenna height`,
      hidden: true,
      description: kmlEsc(`A straight line from the top of a ${data.rep.agl} m mast at #${r.rank} to the top of `
        + `${t.name}'s ${t.agl} m antenna, over Google Earth's own terrain. It is not the path's clearance: `
        + 'no Fresnel zone, no earth curvature and not the ~30 m ground the figures were computed on. '
        + 'Where it runs into a hill, something solid is in the way; where it does not, open the path in '
        + 'the elevation profile before believing it clears.'),
      style: 'mnChord',
      geometry: `      <LineString>
        <tessellate>0</tessellate>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>${r.lon},${r.lat},${data.rep.agl} ${t.lon},${t.lat},${t.agl}</coordinates>
      </LineString>`,
    });
  });

  const body = [
    pin,
    paths.length ? sitesKmlFolder(`Links from #${r.rank} (${paths.length})`, { hidden: !first }, paths.join('\n')) : '',
    chords.length ? sitesKmlFolder('Sight lines at antenna height (3-D)', { hidden: true }, chords.join('\n')) : '',
  ].filter(Boolean).join('\n');
  return sitesKmlFolder(
    `#${r.rank} — ${Math.round(r.ground)} m · score ${Math.round(r.score)} · ${c.served} of ${n} at ≥${data.okDb} dB`,
    { open: first }, body);
}

// The search area, as an outline: a circle on the sphere (destPoint), closed.
function sitesKmlArea(data) {
  const a = data.area;
  const ring = [];
  for (let i = 0; i < SITES_KML_RING_SIDES; i++) ring.push(destPoint(a.lat, a.lon, 360 * i / SITES_KML_RING_SIDES, a.rKm));
  ring.push(ring[0]);
  return sitesKmlPlacemark({
    name: `Search area — ${a.rKm.toFixed(1)} km round the middle of the sites`,
    description: [
      `<b>Centre:</b> ${kmlEsc(stationLatLonText(a))} — the middle of the ${data.targets.length} site${data.targets.length === 1 ? '' : 's'}`,
      `<b>Radius:</b> ${a.rKm.toFixed(2)} km — out to the furthest site and ${kmlEsc(data.marginKm)} km beyond it`,
      'Every summit inside it was screened against every site.',
    ].join('<br>'),
    style: 'mnArea',
    geometry: `      <Polygon>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <outerBoundaryIs><LinearRing>
          <coordinates>${kmlCoords(ring)}</coordinates>
        </LinearRing></outerBoundaryIs>
      </Polygon>`,
  });
}

// The whole file, from MapSites.exportSites()'s plain data. `icons` is 'kmz'
// for the zipped version (the pins are files inside it) and anything else for
// the plain one.
function sitesKml(data, { icons } = {}) {
  const ic = sitesKmlIcons(icons);
  const n = data.targets.length, m = data.results.length;
  const w = data.weights;
  const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const desc = [
    `<b>Repeater site finder</b> — ${plural(m, 'candidate site')} for a new repeater to serve ${plural(n, 'site')}, best first.`,
    `<b>Search:</b> ${data.area.rKm.toFixed(1)} km round ${kmlEsc(stationLatLonText(data.area))} — the middle of the sites, ${
      kmlEsc(data.marginKm)} km beyond the furthest.`,
    `<b>Repeater radio:</b> ${kmlEsc(data.rep.sysName)} at ${kmlEsc(data.rep.agl)} m AGL, ${Number(data.f).toFixed(3)} MHz.${
      data.assumedRadio ? ` Sites with no complete radio on file are taken to carry ${kmlEsc(data.assumedRadio)}.` : ''}`,
    `<b>What matters:</b> elevation ${w.e} · line of sight ${w.l} · fade margin ${w.f} · road reserve ${w.r} (weights 0 to 5).`,
    `<b>Terrain:</b> screened over a ~${kmlEsc(data.res)} m grid; the finalists checked at ${data.samples} samples with the land cover on them, kept at least ${
      Number(data.spacingKm).toFixed(1)} km apart.`,
    `<b>Colours:</b> each path is coloured by its fade margin, the worse of the two directions — green ${data.goodDb} dB or better, yellow ${
      data.okDb} dB or better, red below, grey where there is no figure. A thinner, fainter line is a path the ground cuts (KML has no dashes).`,
    '<b>What is switched on:</b> every candidate, the sites and the search area, and #1\'s paths. Tick another candidate\'s '
      + '<i>Links from</i> folder to compare its paths. The <i>Sight lines at antenna height (3-D)</i> folders start off: '
      + 'straight chords from mast top to antenna top, not Fresnel clearance.',
    `<b>Caveat:</b> ${kmlEsc(data.caveat)}`,
    `Exported from MegaNet on ${kmlEsc(new Date().toLocaleString())}.`,
  ].join('<br>');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Repeater sites — ${plural(n, 'site')}, ${plural(m, 'candidate')}</name>
  <open>1</open>
  <description><![CDATA[${desc}]]></description>
${sitesKmlLookAt(data.area.lat, data.area.lon, data.area.rKm * 1000 * 2.8, 40, '  ')}${sitesKmlStyles(data, ic)}
${sitesKmlTargets(data)}
${data.results.map(r => sitesKmlCandidate(data, r)).join('\n')}
${sitesKmlArea(data)}
</Document>
</kml>
`;
}

// ── The KMZ's pictures ──────────────────────────────────────────────────────
// Drawn on a canvas, 64 px square, in the map's own pin: `.mn-site-mark`'s
// blue disc inside a white ring with the rank in white — the same proportions
// at three times the size, so a pin in Earth is recognisably the pin on the
// map — and the site mark's ring round a dot. Colours are literals for the
// reason SITES_KML_ACCENT gives. Null where a canvas cannot be had, and the
// caller falls back to the web icons rather than writing a KMZ with holes.
function sitesKmzIcon(paint) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext && c.getContext('2d');
  if (!g) return null;
  paint(g);
  const m = /^data:image\/png;base64,(.+)$/.exec(c.toDataURL('image/png'));
  if (!m) return null;
  const bin = atob(m[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sitesKmzDisc(g, r, fill) {
  g.beginPath();
  g.arc(32, 32, r, 0, 2 * Math.PI);
  g.fillStyle = fill;
  g.fill();
}

function sitesKmzRing(g, r, width, stroke) {
  g.beginPath();
  g.arc(32, 32, r, 0, 2 * Math.PI);
  g.lineWidth = width;
  g.strokeStyle = stroke;
  g.stroke();
}

function sitesKmzFiles(ranks) {
  const files = ranks.map(rank => ({
    name: `files/site-${rank}.png`,
    data: sitesKmzIcon(g => {
      g.shadowColor = 'rgba(0, 0, 0, .45)';
      g.shadowBlur = 4;
      g.shadowOffsetY = 1;
      sitesKmzDisc(g, 28, '#ffffff');                  // the ring
      g.shadowColor = 'transparent';
      sitesKmzDisc(g, 23, SITES_KML_ACCENT);           // the disc
      g.fillStyle = '#ffffff';
      g.font = 'bold 28px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(rank), 32, 33);
    }),
  }));
  files.push({
    name: 'files/target.png',
    data: sitesKmzIcon(g => {
      sitesKmzRing(g, 20, 9, 'rgba(255, 255, 255, .9)'); // a halo, so it reads on imagery
      sitesKmzRing(g, 20, 5, SITES_KML_ACCENT);
      sitesKmzDisc(g, 9, '#ffffff');
      sitesKmzDisc(g, 6.5, SITES_KML_ACCENT);
    }),
  });
  return files.every(f => f.data) ? files : null;
}

// ── A store-only ZIP ─────────────────────────────────────────────────────────
// A KMZ is a zip, and this one holds a few kilobytes of KML and a handful of
// PNGs that are compressed already — so the entries are *stored* (method 0),
// which is the whole format minus the one part that needs a library. No data
// descriptors, no zip64, the UTF-8 name flag only where a name needs it.
// Checked against Python's zipfile.testzip() and `unzip -t`, and `npm run
// sites` unzips the real download with a reader of its own.
//
// The CRC table is built on first use rather than at load: nothing here runs
// at load (#142, `npm run toplevel`), and a KMZ is written a few times a year.
let ZIP_CRC_TABLE = null;

function zipCrc32(u8) {
  if (!ZIP_CRC_TABLE) {
    ZIP_CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      ZIP_CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < u8.length; i++) crc = ZIP_CRC_TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data: string | Uint8Array }] → Uint8Array, in the order
// given — which matters for a KMZ, whose reader takes the first .kml it finds.
// `when` is a parameter so a check can fix it; DOS time has two-second steps.
function zipStore(entries, when = new Date()) {
  const enc = new TextEncoder();
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const dosDate = ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const files = entries.map(e => {
    const name = enc.encode(e.name);
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    return { name, data, crc: zipCrc32(data), flag: /[^\x20-\x7e]/.test(e.name) ? 0x0800 : 0 };
  });
  const size = files.reduce((n, f) => n + 76 + 2 * f.name.length + f.data.length, 22);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  const at = [];
  let p = 0;
  for (const f of files) {                                   // local headers, each followed by its data
    at.push(p);
    v.setUint32(p, 0x04034b50, true); v.setUint16(p + 4, 20, true); v.setUint16(p + 6, f.flag, true);
    v.setUint16(p + 8, 0, true); v.setUint16(p + 10, dosTime, true); v.setUint16(p + 12, dosDate, true);
    v.setUint32(p + 14, f.crc, true); v.setUint32(p + 18, f.data.length, true); v.setUint32(p + 22, f.data.length, true);
    v.setUint16(p + 26, f.name.length, true); v.setUint16(p + 28, 0, true);
    out.set(f.name, p + 30);
    out.set(f.data, p + 30 + f.name.length);
    p += 30 + f.name.length + f.data.length;
  }
  const cen = p;
  files.forEach((f, i) => {                                  // the central directory
    v.setUint32(p, 0x02014b50, true); v.setUint16(p + 4, 20, true); v.setUint16(p + 6, 20, true);
    v.setUint16(p + 8, f.flag, true); v.setUint16(p + 10, 0, true); v.setUint16(p + 12, dosTime, true);
    v.setUint16(p + 14, dosDate, true); v.setUint32(p + 16, f.crc, true); v.setUint32(p + 20, f.data.length, true);
    v.setUint32(p + 24, f.data.length, true); v.setUint16(p + 28, f.name.length, true);
    v.setUint32(p + 42, at[i], true);                        // 30..40: extra, comment, disk, attributes — all 0
    out.set(f.name, p + 46);
    p += 46 + f.name.length;
  });
  v.setUint32(p, 0x06054b50, true);                          // end of central directory
  v.setUint16(p + 8, files.length, true); v.setUint16(p + 10, files.length, true);
  v.setUint32(p + 12, p - cen, true); v.setUint32(p + 16, cen, true);
  return out;
}

// ── The two buttons ──────────────────────────────────────────────────────────

// The answer, or a sentence saying why there is none. The buttons are
// disabled until there are results, so this is for a stale render and the
// console — both of which deserve a reason rather than a silent nothing.
function sitesExportData() {
  const d = typeof MapSites !== 'undefined' && MapSites.exportSites ? MapSites.exportSites() : null;
  if (d) return d;
  const running = typeof MapSites !== 'undefined' && MapSites.status && MapSites.status().kind === 'running';
  announce(running
    ? 'The site finder is still working — export once its answer is in.'
    : 'The site finder has no answer to export yet — add the sites to serve and press Find sites first.');
  return null;
}

// Named the way the CSV is, so the three files of one answer sort together.
function sitesExportName(d, ext) {
  return `repeater-sites-${slug(d.targets[0].name) || 'sites'}-${d.targets.length}.${ext}`;
}

// history.js's download: the anchor attached, clicked, removed, and the URL
// revoked a tick later — the order Safari wants for a binary blob, where the
// station pill's click-and-revoke-at-once has only ever carried text.
function sitesDownloadBlob(name, part, type) {
  const url = URL.createObjectURL(new Blob([part], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function sitesExportTold(d, name) {
  const paths = d.results.reduce((n, r) => n + r.links.filter(l => !l.colo && !l.failed).length, 0);
  announce(`Repeater sites saved as ${name} — ${d.results.length} candidate${d.results.length === 1 ? '' : 's'}, `
    + `${d.targets.length} site${d.targets.length === 1 ? '' : 's'} and ${paths} path${paths === 1 ? '' : 's'}. `
    + 'In earth.google.com: New → Import file to project, or Open local KML file.');
}

function downloadSitesKmz() {
  const d = sitesExportData();
  if (!d) return;
  const files = sitesKmzFiles(d.results.map(r => r.rank));
  // doc.kml first: a KMZ reader takes the first .kml in the archive.
  const bytes = zipStore([{ name: 'doc.kml', data: sitesKml(d, { icons: files ? 'kmz' : 'web' }) },
                          ...(files || [])]);
  const name = sitesExportName(d, 'kmz');
  sitesDownloadBlob(name, bytes, 'application/vnd.google-earth.kmz');
  sitesExportTold(d, name);
}

function downloadSitesKml() {
  const d = sitesExportData();
  if (!d) return;
  const name = sitesExportName(d, 'kml');
  sitesDownloadBlob(name, sitesKml(d), 'application/vnd.google-earth.kml+xml');
  sitesExportTold(d, name);
}
