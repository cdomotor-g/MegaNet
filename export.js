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
//
// After core.js, before init.js — index.html holds the order and the reasons.
// Reaches back to core.js for state, esc, escAttr, announce, netName, csvEscape,
// dlText, acmaHaversineKm, stationLatLonText and RM_NET_DEFAULTS; across to
// app.js for findStationMatches, findRepeaterMatches, stationAlertIds and
// repeaterPassingCount; to map-backbone.js for backboneLinks; to map-wind.js
// for the region a KML's station sits in; and to datastore.js for
// renderDbStatusHtml, which renders the datastore panel this tab hosts. The
// snapshot button written here calls snapshotStationsJson() over in
// datastore.js for the same reason — see that file's header. Every one of them
// is called from inside a function here, so this file's position among the
// modules stays free.
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
function kmlEsc(s) {
  return String(s == null ? '' : s)
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
    <styleUrl>#${styleId}</styleUrl>
    <description><![CDATA[${rows.map(([k, v]) =>
      `<b>${kmlEsc(k)}:</b> ${kmlEsc(v)}`).join('<br>')}]]></description>
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
