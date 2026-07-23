// MegaNet — app.js

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'map',        label: 'Map'        },
  { id: 'maps',       label: 'Network Maps'},
  { id: 'stations',   label: 'Stations'   },
  { id: 'networks',   label: 'Networks'   },
  { id: 'analysis',   label: 'Analysis'   },
  { id: 'bitflipper', label: 'Bit Flipper'},
  { id: 'packets',    label: 'ALERT Packets'},
  { id: 'serial',     label: 'Serial Monitor'},
  { id: 'export',     label: 'Export'     },
];

const ROLE_COLOR = {
  field:    '#107c10',
  repeater: '#0b5cab',
  base:     '#c7401a',
  satcom:   '#7c35a3',
};

const ROLE_LABEL = {
  field:    'Field Station',
  repeater: 'Repeater',
  base:     'Base Station',
  satcom:   'Satcom',
};

const RM_NET_DEFAULTS = {
  Visible: 1, 'Minimum fx': 151, 'Max Fx': 152,
  Refractivity: 301, Conductivity: 0.005, Permittivity: 15,
  Polarization: 1, Climate: 2, 'Stat. mode': 0,
  '%Time': 50, '%Location': 50, '%Situation': 70,
  Topology: 1, 'Max Rebro': 0, '%Urban or Tree': 0,
};

// ── Diagnostics & error capture ─────────────────────────────────────────────────
// Registered as early as possible so a bug report can carry what actually went
// wrong (recent runtime errors), not just what the user managed to describe.
// MegaNet has no backend, so this is the only record of a failure that exists.

// App build, read from this script's own ?v= cache-buster in index.html so it
// always matches the deployed file without a second constant to keep in sync.
const APP_VERSION = (function () {
  try {
    const m = ((document.currentScript && document.currentScript.src) || '').match(/[?&]v=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : 'dev';
  } catch (_) { return 'dev'; }
})();

const GITHUB_REPO = 'cdomotor-g/MegaNet';   // owner/repo that bug reports open against

// Ring buffer of the most recent uncaught errors, capped so a long session
// can't grow it without bound.
const _errorLog = [];
const ERROR_LOG_MAX = 20;

function recordError(entry) {
  _errorLog.push({ at: new Date().toISOString(), ...entry });
  while (_errorLog.length > ERROR_LOG_MAX) _errorLog.shift();
}

function _errWhere(url, line, col) {
  const file = String(url || '').split('/').pop() || '';
  return file ? `${file}:${line}:${col}` : '';
}

function _errStack(stack, n) {
  return stack ? String(stack).split('\n').slice(0, n).map(l => l.trim()).join('\n') : '';
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', e => {
    recordError({
      kind:    'error',
      message: (e && e.message) || String((e && e.error) || 'unknown error'),
      where:   e && e.filename ? _errWhere(e.filename, e.lineno, e.colno) : '',
      stack:   _errStack(e && e.error && e.error.stack, 4),
    });
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e && e.reason;
    recordError({
      kind:    'unhandledrejection',
      message: (r && r.message) ? r.message : String(r),
      where:   '',
      stack:   _errStack(r && r.stack, 4),
    });
  });
}

// ── State ──────────────────────────────────────────────────────────────────────

const state = {
  data:       null,   // parsed stations.json
  activeTab:  'map',
  filters: {
    search:       '',
    networks:     new Set(),
    catchments:   new Set(),
    roles:        new Set(),
    enabledOnly:  false,
  },
  selectedId:     null,
  map:            null,
  mapMarkers:     [],
  mapLines:       [],
  mapShowLinks:   true,
  exportNets:     null,
  bfInput:        '',
  bfBits:         '1',
  bfOnlyMatches:  false,
  bfArroBase:     'https://contrail-bom.onerain.au/graph/',
  bfSensorFilter: '',
  bfMap:          null,
  bfMapLayer:     null,
  bfMapTimer:     null,
  pkt: {
    decInput:  '',
    lastDecode: null,   // last decoded input string (for replay after re-render)
    lastEncode: false,  // whether an encode result should be replayed
    enc: { format: 'eif', id: 2784, data: 1599, polarity: 'negative', b: 0, hd: 0, bs: 0, vco: 0, de: 0 },
  },
  editorId:       null,
  editorDraft:    {},
  theme: localStorage.getItem('mn-theme') || 'light',
};

// ── Init ───────────────────────────────────────────────────────────────────────

(function init() {
  document.documentElement.setAttribute('data-theme', state.theme);
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = state.theme === 'dark' ? 'Light' : 'Dark';
  renderTabs();
  renderMain();
  autoLoad();
})();

// ── Theme ──────────────────────────────────────────────────────────────────────

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('mn-theme', state.theme);
  document.getElementById('btn-theme').textContent = state.theme === 'dark' ? 'Light' : 'Dark';
  if (state.map) refreshMapLayers();
}

// ── File loading ───────────────────────────────────────────────────────────────

const GITHUB_RAW_URL = 'https://raw.githubusercontent.com/cdomotor-g/MegaNet/main/stations.json';

function onFileLoad(input) {
  const f = input.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      loadJson(e.target.result);
    } catch (err) {
      alert(`Failed to load stations.json: ${err.message}`);
    }
  };
  reader.readAsText(f);
  input.value = '';
}

async function loadFromUrl(url) {
  const btn = document.getElementById('btn-load-gh');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadJson(await res.text());
  } catch (err) {
    alert(`Failed to load from URL: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Load from GitHub'; }
  }
}

function loadFromGitHub() {
  loadFromUrl(GITHUB_RAW_URL);
}

async function autoLoad() {
  // When served from a web server (e.g. GitHub Pages), auto-fetch stations.json
  // from the same origin. Skips in file:// context (no server, no CORS headers).
  if (location.protocol === 'file:') return;
  try {
    const res = await fetch('stations.json');
    if (!res.ok) return;
    loadJson(await res.text());
  } catch (_) {}
}

function loadJson(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.stations)) throw new Error('Missing "stations" array');
  state.data       = data;
  state.exportNets = null;
  state.filters.networks   = new Set();
  state.filters.catchments = new Set();
  state.filters.roles      = new Set();
  state.filters.search     = '';
  state.selectedId         = null;
  updateHeaderStats();
  renderTabs();
  renderMain();
}

function updateHeaderStats() {
  const el = document.getElementById('hdr-stats');
  if (!el || !state.data) return;
  const s = state.data.stations;
  el.textContent = `${s.length} stations · ${s.filter(x => x.roles.includes('repeater')).length} repeaters`;
}

// ── Data helpers ───────────────────────────────────────────────────────────────

function filteredStations() {
  if (!state.data) return [];
  const { search, networks, catchments, roles, enabledOnly } = state.filters;
  const q = search.toLowerCase();
  return state.data.stations.filter(s => {
    if (enabledOnly && !s.enabled) return false;
    if (q && !s.name.toLowerCase().includes(q) && !(s.station_number || '').toLowerCase().includes(q)) return false;
    if (networks.size   > 0 && !s.radio_network_ids.some(id => networks.has(id)))   return false;
    if (catchments.size > 0 && !s.catchment_ids.some(id => catchments.has(id)))     return false;
    if (roles.size      > 0 && !s.roles.some(r => roles.has(r)))                    return false;
    return true;
  });
}

// Every distinct ALERT id for a station, sorted ascending. Derived from the
// normalized sensor list (the enriched `sensors[]` when present, otherwise
// synthesized from the legacy `alert_ids` object — see stationSensors) so all
// of a station's addresses are shown, not just the single legacy value.
function stationAlertIds(s) {
  const ids = new Set();
  stationSensors(s).forEach(se => {
    if (se && se.alert_id != null) ids.add(se.alert_id);
  });
  return [...ids].sort((a, b) => a - b);
}

// ALERT ids grouped with their sensor type(s), sorted by id — for displays
// where the reading kind matters (e.g. map popups: "Rainfall — 6128"). Uses the
// normalized sensor list so battery / rainfall / water-level labels come through.
function stationAlertIdTypes(s) {
  const byId = new Map();
  stationSensors(s).forEach(se => {
    if (!se || se.alert_id == null) return;
    if (!byId.has(se.alert_id)) byId.set(se.alert_id, []);
    const types = byId.get(se.alert_id);
    if (se.type && !types.includes(se.type)) types.push(se.type);
  });
  return [...byId.entries()].sort((a, b) => a[0] - b[0]).map(([id, types]) => ({ id, types }));
}

function passRangeCoversId(repeater, alertId) {
  if (!repeater || !Array.isArray(repeater.pass_ranges)) return false;
  const excl = repeater.exclusions || [];
  return repeater.pass_ranges.some(r =>
    alertId >= r.low && alertId <= r.high &&
    !excl.some(e => alertId >= e.low && alertId <= e.high)
  );
}

function primaryRole(s) {
  if (s.roles.includes('base'))     return 'base';
  if (s.roles.includes('repeater')) return 'repeater';
  return 'field';
}

function findRepeaterMatches(station, allStations) {
  const ids = stationAlertIds(station);
  if (!ids.length) return [];
  return allStations.filter(s =>
    s.roles.includes('repeater') &&
    s.id !== station.id &&
    s.repeater &&
    ids.some(id => passRangeCoversId(s.repeater, id))
  );
}

function findStationMatches(repeater, allStations) {
  if (!repeater.repeater) return [];
  return allStations.filter(s =>
    s.roles.includes('field') &&
    s.id !== repeater.id &&
    stationAlertIds(s).some(id => passRangeCoversId(repeater.repeater, id))
  );
}

// ── Tab bar ────────────────────────────────────────────────────────────────────

function renderTabs() {
  const nav = document.getElementById('tab-bar');
  if (!nav) return;
  nav.innerHTML = TABS.map(t => `
    <button class="tab-btn${state.activeTab === t.id ? ' active' : ''}"
            onclick="switchTab('${t.id}')">${t.label}</button>
  `).join('');
}

function switchTab(id) {
  state.activeTab = id;
  renderTabs();
  renderMain();
}

// ── Main content dispatcher ────────────────────────────────────────────────────

function renderMain() {
  const el = document.getElementById('main-content');
  if (!el) return;
  const noDataTabs = ['packets', 'maps', 'serial'];
  if (!state.data && !noDataTabs.includes(state.activeTab)) { el.innerHTML = renderEmpty(); return; }
  switch (state.activeTab) {
    case 'map':        el.innerHTML = renderMapHtml();        initMap();  break;
    case 'maps':       el.innerHTML = Maps.render();          Maps.init();         break;
    case 'stations':   el.innerHTML = renderStationsHtml();               break;
    case 'networks':   el.innerHTML = renderNetworksHtml();               break;
    case 'analysis':   el.innerHTML = renderAnalysisHtml();               break;
    case 'bitflipper': el.innerHTML = renderBitFlipperHtml(); initBitFlipperMap(); break;
    case 'packets':    el.innerHTML = Packets.render();       Packets.init();      break;
    case 'serial':     el.innerHTML = Serial.render();        Serial.init();       break;
    case 'export':     el.innerHTML = renderExportHtml();                 break;
    default:           el.innerHTML = '<p style="padding:1rem">Unknown tab</p>';
  }
}

// ── Empty state ────────────────────────────────────────────────────────────────

function renderEmpty() {
  return `
    <div style="max-width:600px;margin:3rem auto;padding:1rem">
      <div class="panel" style="text-align:center;padding:2.5rem 2rem">
        <h2 style="margin:0 0 .75rem">No data loaded</h2>
        <p style="color:var(--muted)">Load a <strong>stations.json</strong> file to get started.
          If you haven't created one yet, use the
          <a href="migrate.html">Migration Tool</a> to convert your existing CSVs.</p>
        <div style="margin-top:1.25rem">
          <button class="primary" onclick="document.getElementById('file-input').click()">
            Load stations.json
          </button>
        </div>
      </div>
    </div>`;
}

// ── MAP tab ────────────────────────────────────────────────────────────────────

function renderMapHtml() {
  return `
    <div class="layout">
      <aside class="sidebar stack">
        <div class="panel">
          <div class="panel-header"><h3>Filters</h3></div>
          <div class="upload-grid" style="margin-top:.6rem">
            <label style="font-size:.88rem;color:var(--muted)">Search
              <input type="search" placeholder="Station name…" value="${esc(state.filters.search)}"
                     oninput="state.filters.search=this.value;refreshMapLayers()">
            </label>
          </div>
          <div style="margin-top:.75rem">
            <div class="small" style="margin-bottom:.35rem;color:var(--muted)">Roles</div>
            ${Object.entries(ROLE_LABEL).map(([k, v]) => `
              <label style="display:flex;gap:.45rem;align-items:center;font-size:.9rem;margin:.2rem 0">
                <input type="checkbox" ${state.filters.roles.has(k) ? 'checked' : ''}
                       onchange="toggleFilter('roles','${k}',this.checked);refreshMapLayers()">
                <span class="legend-dot" style="background:${ROLE_COLOR[k]}"></span> ${v}
              </label>
            `).join('')}
          </div>
          ${networkFilterHtml('refreshMapLayers()')}
          <label style="display:flex;gap:.45rem;align-items:center;font-size:.9rem;margin-top:.75rem">
            <input type="checkbox" ${state.mapShowLinks ? 'checked' : ''}
                   onchange="state.mapShowLinks=this.checked;refreshMapLayers()">
            Show signal links
          </label>
        </div>
        <div class="panel">
          <div class="map-legend">
            ${Object.entries(ROLE_LABEL).map(([k, v]) => `
              <span class="legend-item">
                <span class="legend-dot" style="background:${ROLE_COLOR[k]}"></span>
                <span class="small">${v}</span>
              </span>`).join('')}
            <span class="legend-item">
              <span class="legend-line"></span>
              <span class="small">Pass-range link</span>
            </span>
          </div>
        </div>
      </aside>
      <div>
        <div class="panel" style="padding:.6rem">
          <div id="leaflet-map" style="height:calc(100vh - 165px);min-height:400px;border-radius:6px"></div>
        </div>
      </div>
    </div>`;
}

// ── Base map layers ─────────────────────────────────────────────────────────
// Fresh tile-layer instances for the shared base-map set. A Leaflet layer can
// only live on one map at a time, so every map gets its own instances. The
// first entry (OSM-Topo) is the default base layer.
function makeBaseLayers() {
  return {
    'OSM-Topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: 'Map data: © OpenStreetMap contributors, SRTM | Style: © OpenTopoMap (CC-BY-SA)',
      maxZoom: 17,
    }),
    'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 19,
    }),
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      maxZoom: 19,
    }),
  };
}

// Add the shared base-layer set to a map, switch it to the default (OSM-Topo)
// and drop a base-map picker in the top-right corner.
function addBaseLayers(map) {
  const layers = makeBaseLayers();
  const [, defaultLayer] = Object.entries(layers)[0];
  defaultLayer.addTo(map);
  L.control.layers(layers, null, { position: 'topright' }).addTo(map);
  return layers;
}

function initMap() {
  if (state.map) { state.map.remove(); state.map = null; state.mapMarkers = []; state.mapLines = []; }
  const el = document.getElementById('leaflet-map');
  if (!el) return;
  state.map = L.map('leaflet-map');
  addBaseLayers(state.map);
  refreshMapLayers();
}

function refreshMapLayers() {
  const map = state.map;
  if (!map || !state.data) return;
  state.mapMarkers.forEach(m => m.remove());
  state.mapLines.forEach(l => l.remove());
  state.mapMarkers = [];
  state.mapLines   = [];

  const stations = filteredStations().filter(s => s.lat != null && s.lon != null);
  if (!stations.length) return;

  const lineColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--map-line').trim() || '#ff6f00';

  if (state.mapShowLinks) {
    const allStations = state.data.stations;
    for (const s of stations) {
      if (!s.roles.includes('field')) continue;
      for (const r of findRepeaterMatches(s, allStations)) {
        if (!r.lat || !r.lon) continue;
        state.mapLines.push(
          L.polyline([[s.lat, s.lon], [r.lat, r.lon]], {
            color: lineColor, weight: 1.5, opacity: 0.5,
          }).addTo(map)
        );
      }
    }
  }

  const bounds = [];
  for (const s of stations) {
    const role   = primaryRole(s);
    const color  = ROLE_COLOR[role] || ROLE_COLOR.field;
    const isRpt  = s.roles.includes('repeater');
    const marker = L.circleMarker([s.lat, s.lon], {
      radius: isRpt ? 8 : 5, color, fillColor: color,
      fillOpacity: 0.8, weight: isRpt ? 2 : 1,
    }).addTo(map);

    const idTypes = stationAlertIdTypes(s);
    marker.bindPopup(`
      <strong>${esc(s.name)}</strong><br>
      ${s.roles.map(r => `<span style="background:${ROLE_COLOR[r]};color:#fff;padding:1px 5px;border-radius:999px;font-size:.78rem;margin-right:2px">${r}</span>`).join('')}<br>
      ${s.station_number ? `<span style="font-size:.83rem">Stn #${esc(s.station_number)}</span><br>` : ''}
      ${idTypes.length ? `<span style="font-size:.83rem">AlertID:</span><br>${idTypes.map(t =>
        `<span style="font-size:.82rem">&nbsp;&nbsp;${t.types.length ? esc(t.types.join(' / ')) + ' — ' : ''}${t.id}</span>`).join('<br>')}<br>` : ''}
      ${s.elevation_ahd != null ? `<span style="font-size:.83rem">Elev: ${s.elevation_ahd} m AHD</span>` : ''}
    `);
    state.mapMarkers.push(marker);
    bounds.push([s.lat, s.lon]);
  }

  if (bounds.length) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 12 });
}

// ── STATIONS tab ───────────────────────────────────────────────────────────────

function renderStationsHtml() {
  const stations = filteredStations();
  return `
    <div class="layout">
      <aside class="sidebar stack">
        <div class="panel">
          <div class="panel-header"><h3>Filters</h3>
            <button onclick="clearFilters()">Clear</button>
          </div>
          <div class="upload-grid" style="margin-top:.6rem">
            <label style="font-size:.88rem;color:var(--muted)">Search
              <input type="search" placeholder="Name or station #…" value="${esc(state.filters.search)}"
                     oninput="state.filters.search=this.value;rerenderStations()">
            </label>
          </div>
          <div style="margin-top:.75rem">
            <div class="small" style="margin-bottom:.35rem;color:var(--muted)">Role</div>
            ${Object.entries(ROLE_LABEL).map(([k, v]) => `
              <label style="display:flex;gap:.45rem;align-items:center;font-size:.9rem;margin:.2rem 0">
                <input type="checkbox" ${state.filters.roles.has(k) ? 'checked' : ''}
                       onchange="toggleFilter('roles','${k}',this.checked);rerenderStations()">
                ${v}
              </label>
            `).join('')}
          </div>
          ${networkFilterHtml('rerenderStations()')}
          <label style="display:flex;gap:.45rem;align-items:center;font-size:.9rem;margin-top:.75rem">
            <input type="checkbox" ${state.filters.enabledOnly ? 'checked' : ''}
                   onchange="state.filters.enabledOnly=this.checked;rerenderStations()">
            Enabled only
          </label>
        </div>
        <div class="panel">
          <div class="small" style="color:var(--muted)">
            Showing <strong id="st-count">${stations.length}</strong> of ${state.data.stations.length}
          </div>
        </div>
      </aside>
      <div class="stack">
        <div class="panel">
          <div class="panel-header">
            <h2>Stations</h2>
            <button onclick="editorNew()">+ New</button>
          </div>
          <div class="table-wrap tall" id="stations-table-wrap">
            ${stationsTable(stations)}
          </div>
        </div>
        <div class="panel" id="stations-editor-card">
          ${renderStationEditorCard()}
        </div>
      </div>
    </div>`;
}

function stationsTable(stations) {
  if (!stations.length) return '<p style="padding:.75rem;color:var(--muted)">No stations match current filters.</p>';
  return `
    <table>
      <colgroup>
        <col style="width:22%"><col style="width:8%"><col style="width:13%"><col style="width:13%">
        <col style="width:12%"><col style="width:9%"><col style="width:9%"><col style="width:8%"><col style="width:6%">
      </colgroup>
      <thead>
        <tr>
          <th>Name</th><th>Stn #</th><th>Roles</th><th>Network</th>
          <th>AlertID</th><th>Lat</th><th>Lon</th><th>Elev (AHD)</th><th>On</th>
        </tr>
      </thead>
      <tbody>
        ${stations.map(s => {
          const aids = stationAlertIds(s);
          return `
            <tr class="${state.selectedId === s.id ? 'selected' : ''}"
                onclick="selectStation('${s.id}')" style="cursor:pointer">
              <td title="${esc(s.id)}"><span class="stn-name role-${primaryRole(s)}">${esc(s.name)}</span></td>
              <td class="small">${esc(s.station_number || '')}</td>
              <td>${s.roles.map(r => `<span class="badge">${r}</span>`).join(' ')}</td>
              <td class="small">${s.radio_network_ids.map(id => netName(id)).join(', ')}</td>
              <td class="small">${aids.join(', ')}</td>
              <td class="small">${s.lat != null ? s.lat.toFixed(4) : ''}</td>
              <td class="small">${s.lon != null ? s.lon.toFixed(4) : ''}</td>
              <td class="small">${s.elevation_ahd != null ? s.elevation_ahd : ''}</td>
              <td>${s.enabled ? '✓' : ''}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function rerenderStations() {
  const stations = filteredStations();
  const wrap = document.getElementById('stations-table-wrap');
  if (wrap) wrap.innerHTML = stationsTable(stations);
  const cnt = document.getElementById('st-count');
  if (cnt) cnt.textContent = stations.length;
}

function selectStation(id) {
  if (state.selectedId === id) {
    // Toggle off: clear the highlight and close the editor card below.
    state.selectedId  = null;
    state.editorId    = null;
    state.editorDraft = {};
  } else {
    // Select the row and load it into the editor card. A deep copy becomes the
    // draft so fields not exposed by the form (catchments, satcom, RM metadata)
    // survive a save.
    state.selectedId  = id;
    state.editorId    = id;
    state.editorDraft = JSON.parse(JSON.stringify(state.data.stations.find(s => s.id === id) || {}));
  }
  rerenderStations();
  rerenderStationEditorCard();
}

// True when the editor card should show a form (an existing station is selected
// or a new one is being created), rather than the placeholder prompt.
function editorActive() {
  return state.editorDraft && Object.keys(state.editorDraft).length > 0;
}

function renderStationEditorCard() {
  if (!editorActive()) {
    return `
      <div class="panel-header"><h2>Station Editor</h2></div>
      <p style="color:var(--muted);padding:.5rem 0">
        Select a station in the list above to view and edit it, or click
        <em>+ New</em> to add one.
      </p>`;
  }
  // Existing station → render from the live record; new station → from the draft.
  const s = state.editorId
    ? (state.data.stations.find(x => x.id === state.editorId) || state.editorDraft)
    : state.editorDraft;
  return editorForm(s);
}

function rerenderStationEditorCard() {
  const el = document.getElementById('stations-editor-card');
  if (el) el.innerHTML = renderStationEditorCard();
}

// ── NETWORKS tab ───────────────────────────────────────────────────────────────

function renderNetworksHtml() {
  const nets = state.data.radio_networks || [];
  const all  = state.data.stations;
  return `
    <div style="max-width:960px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header">
          <h2>Radio Networks</h2>
          <span class="badge">${nets.length}</span>
        </div>
        <div class="table-wrap tall" style="margin-top:.75rem">
          <table>
            <colgroup>
              <col style="width:20%"><col style="width:28%"><col style="width:12%">
              <col style="width:12%"><col style="width:28%">
            </colgroup>
            <thead><tr><th>ID</th><th>Name</th><th>Repeaters</th><th>Field stns</th><th>Description</th></tr></thead>
            <tbody>
              ${nets.map(n => {
                const rpts = all.filter(s => s.roles.includes('repeater') && s.radio_network_ids.includes(n.id));
                const flds = all.filter(s => s.roles.includes('field')    && s.radio_network_ids.includes(n.id));
                return `<tr>
                  <td class="small">${esc(n.id)}</td>
                  <td>${esc(n.name)}</td>
                  <td>${rpts.length}</td>
                  <td>${flds.length}</td>
                  <td class="small">${esc(n.description || '')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2>Catchments</h2>
          <span class="badge">${(state.data.catchments || []).length}</span>
        </div>
        ${!(state.data.catchments || []).length
          ? '<p class="small" style="color:var(--muted);margin:.75rem 0">No catchments defined yet.</p>'
          : `<div class="table-wrap medium" style="margin-top:.75rem">
               <table>
                 <thead><tr><th>ID</th><th>Name</th></tr></thead>
                 <tbody>
                   ${state.data.catchments.map(c =>
                     `<tr><td class="small">${esc(c.id)}</td><td>${esc(c.name)}</td></tr>`
                   ).join('')}
                 </tbody>
               </table>
             </div>`}
      </div>
    </div>`;
}

// ── ANALYSIS tab ───────────────────────────────────────────────────────────────

function renderAnalysisHtml() {
  const all      = state.data.stations;
  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater);
  const fields    = all.filter(s => s.roles.includes('field'));
  const noAid     = fields.filter(s => !stationAlertIds(s).length).length;

  const rptData = repeaters.map(r => ({
    r, matched: findStationMatches(r, all),
  }));

  const orphans = fields.filter(s => {
    const ids = stationAlertIds(s);
    if (!ids.length) return false;
    return !repeaters.some(r => ids.some(id => passRangeCoversId(r.repeater, id)));
  });

  return `
    <div style="max-width:1100px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header"><h2>Pass-Range Analysis</h2></div>
        <div class="stats" style="display:flex;flex-wrap:wrap;gap:1.5rem;margin-top:.75rem">
          <div>Repeaters with pass ranges: <strong>${repeaters.length}</strong></div>
          <div>Field stations with AlertID: <strong>${fields.length - noAid}</strong></div>
          <div>No AlertID (telemetry): <strong>${noAid}</strong></div>
          <div style="${orphans.length ? 'color:#c7401a' : ''}">
            Orphaned (no matching repeater): <strong>${orphans.length}</strong>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header"><h2>By Repeater</h2><span class="badge">${repeaters.length}</span></div>
        <div class="table-wrap tall">
          <table>
            <colgroup>
              <col style="width:20%"><col style="width:16%"><col style="width:8%">
              <col style="width:16%"><col style="width:40%">
            </colgroup>
            <thead><tr><th>Repeater</th><th>Network</th><th>Matched</th><th>Pass ranges</th><th>Stations (first 10)</th></tr></thead>
            <tbody>
              ${rptData.map(({ r, matched }) => `
                <tr>
                  <td>${esc(r.name)}</td>
                  <td class="small">${r.radio_network_ids.map(id => netName(id)).join(', ')}</td>
                  <td><span class="badge">${matched.length}</span></td>
                  <td class="small">${(r.repeater.pass_ranges || []).map(p => `${p.low}–${p.high}`).join(', ')}</td>
                  <td class="small">${matched.slice(0, 10).map(s => esc(s.name)).join(', ')}${matched.length > 10 ? ` +${matched.length - 10} more` : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      ${orphans.length ? `
        <div class="panel">
          <div class="panel-header">
            <h2 style="color:#c7401a">Orphaned Stations</h2>
            <span class="badge">${orphans.length}</span>
          </div>
          <p class="small" style="color:var(--muted);margin:.5rem 0">
            These stations have an AlertID but no repeater's pass ranges cover it.
          </p>
          <div class="table-wrap medium">
            <table>
              <thead><tr><th>Name</th><th>AlertID(s)</th><th>Network</th></tr></thead>
              <tbody>
                ${orphans.map(s => `
                  <tr>
                    <td>${esc(s.name)}</td>
                    <td class="small">${stationAlertIds(s).join(', ')}</td>
                    <td class="small">${s.radio_network_ids.map(id => netName(id)).join(', ')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : ''}
    </div>`;
}

// ── BIT FLIPPER tab ────────────────────────────────────────────────────────────

const BF_TYPE_LABEL     = { battery: 'Battery', rainfall: 'Rainfall', water_level: 'Water Level', primary: 'Primary' };
const BF_MAX_RENDER_ROWS = 2000;   // safety cap for very large N-bit expansions
const ARRO_DEFAULT_BASE  = 'https://contrail-bom.onerain.au/graph/';

// Normalized sensor list for a station. Prefers the enriched `sensors` array
// (from the national sensor database) and falls back to synthesizing minimal
// records from legacy `alert_ids` when a station has not been enriched.
function stationSensors(s) {
  if (Array.isArray(s.sensors) && s.sensors.length) return s.sensors;
  const out = [];
  const a = s.alert_ids || {};
  ['battery', 'rainfall', 'water_level', 'primary'].forEach(k => {
    const v = a[k];
    if (v == null) return;
    (Array.isArray(v) ? v : [v]).forEach(id =>
      out.push({ alert_id: id, type: BF_TYPE_LABEL[k] || k, sensor_id: '', device_id: null }));
  });
  return out;
}

// Build an ALERT-address → [{ station, sensor }] index across all stations.
function buildSensorIndex() {
  const idx = new Map();
  state.data.stations.forEach(s => {
    stationSensors(s).forEach(sensor => {
      const id = sensor.alert_id;
      if (id == null) return;
      if (!idx.has(id)) idx.set(id, []);
      idx.get(id).push({ station: s, sensor });
    });
  });
  return idx;
}

// All combinations of `k` bit positions chosen from 0..width-1 (lexicographic).
function bitCombos(width, k) {
  const res = [];
  (function rec(start, combo) {
    if (combo.length === k) { res.push(combo.slice()); return; }
    for (let i = start; i < width; i++) { combo.push(i); rec(i + 1, combo); combo.pop(); }
  })(0, []);
  return res;
}

function bfBaseId() {
  const id = parseInt(state.bfInput, 10);
  return (!isNaN(id) && id > 0 && id < 65536) ? id : null;
}

function bfBitsToFlip() {
  const n = parseInt(state.bfBits, 10);
  if (isNaN(n) || n < 1) return 1;
  return Math.min(n, 16);
}

// Compute flip variants for the current input:
// [{ bits:[...], value, binary, matches:[{station,sensor}] }] in bit-combo order.
function bfComputeVariants(idx) {
  const base = bfBaseId();
  if (base == null) return [];
  idx = idx || buildSensorIndex();
  const variants = [];
  for (const combo of bitCombos(16, bfBitsToFlip())) {
    let v = base;
    for (const b of combo) v ^= (1 << b);
    if (v <= 0 || v >= 65536 || v === base) continue;
    variants.push({ bits: combo, value: v, binary: v.toString(2).padStart(16, '0'), matches: idx.get(v) || [] });
  }
  return variants;
}

function formatArroLocal(d) {
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Build an ARRO graph URL for the given {station,sensor} pairs. Returns
// { url, count } or null when no pair carries the site/device ids ARRO needs.
function buildArroUrl(pairs) {
  const base = (state.bfArroBase || ARRO_DEFAULT_BASE).trim();
  const now = new Date(), start = new Date(now.getTime() - 7 * 86400e3);
  const p = new URLSearchParams({
    refresh: 'off', markers: 'false', legend: 'true', bin: '86400',
    time_zone: 'Australia/Brisbane', invalid: 'true',
    has_regular_sensors: 'true', has_forecast_sensors: 'false',
    for_forecast: 'false', hidden_devices: 'none',
    data_start: formatArroLocal(start), data_end: formatArroLocal(now),
  });
  const seen = new Set();
  pairs.forEach(({ station, sensor }) => {
    const dbId = station.site && station.site.db_id;
    const dev  = sensor.device_id;
    if (dbId == null || dev == null) return;
    const key = `${dbId}|${dev}`;
    if (!seen.has(key)) { seen.add(key); p.append('devices[]', key); }
  });
  if (!seen.size) return null;
  return { url: base.replace(/\?+$/, '') + '?' + p.toString(), count: seen.size };
}

// Collapse duplicate matches so a sensor isn't repeated once per duplicate
// stations.json entry that shares a name (some sites appear twice in the data).
function dedupeMatches(matches) {
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const k = `${m.station.name}|${m.sensor.type}|${m.sensor.sensor_id}|${m.sensor.device_id}|${m.sensor.alert_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

// Static shell — rendered once when the tab opens. Control inputs live here and
// are NOT re-rendered on keystrokes, so focus is never stolen; only #bf-results
// updates as the user types.
function renderBitFlipperHtml() {
  return `
    <div style="max-width:1000px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header"><h2>Bit Flipper</h2></div>
        <p class="small" style="color:var(--muted);margin:.5rem 0">
          Enter an ALERT decimal address to see its bit-flip variants and cross-reference them
          against the station database. Sensor type, Sensor ID and ARRO graph links are sourced
          from the enriched station data.
        </p>
        <div id="bf-controls" style="display:flex;flex-wrap:wrap;gap:1rem 1.25rem;align-items:flex-end;margin-top:.5rem">
          <label style="font-size:.9rem;color:var(--muted)">
            ALERT decimal address
            <input id="bf-addr" type="number" min="1" max="65535" value="${esc(state.bfInput)}" placeholder="e.g. 6129"
                   style="width:170px;margin-top:.3rem;display:block"
                   oninput="onBfAddrInput(this.value)">
          </label>
          <label style="font-size:.9rem;color:var(--muted)">
            Bits to flip
            <input id="bf-bits" type="number" min="1" max="16" value="${esc(String(bfBitsToFlip()))}"
                   style="width:100px;margin-top:.3rem;display:block"
                   oninput="onBfBitsInput(this.value)">
          </label>
          <label style="font-size:.9rem;color:var(--muted);display:flex;gap:.4rem;align-items:center;padding-bottom:.4rem">
            <input id="bf-only" type="checkbox" ${state.bfOnlyMatches ? 'checked' : ''}
                   onchange="onBfOnlyMatches(this.checked)">
            Show only matched addresses
          </label>
          <label style="font-size:.9rem;color:var(--muted);flex:1;min-width:240px">
            ARRO base URL
            <input id="bf-arro" type="text" value="${esc(state.bfArroBase || ARRO_DEFAULT_BASE)}"
                   style="width:100%;margin-top:.3rem;display:block"
                   oninput="onBfArroInput(this.value)">
          </label>
        </div>
      </div>

      <div id="bf-results">${renderBitFlipperResults()}</div>

      <div class="panel">
        <div class="panel-header"><h3>Map</h3></div>
        <div id="bf-map" style="height:420px;border-radius:6px;margin-top:.5rem"></div>
      </div>
    </div>`;
}

// Dynamic output — recomputed and re-rendered into #bf-results on every input.
function renderBitFlipperResults() {
  const base = bfBaseId();
  if (base == null) {
    return `<div class="panel"><p class="small" style="color:var(--muted)">Enter a valid ALERT address (1–65535) above.</p></div>`;
  }

  const idx      = buildSensorIndex();
  const variants = bfComputeVariants(idx);
  const filter   = state.bfSensorFilter || '';
  const matchPasses = m => !filter || m.sensor.type === filter;
  const rowMatches  = v => v.matches.filter(matchPasses);

  // Station of interest: the exact match on the entered address (no bits
  // flipped). Pinned to the top of the table and always ARRO-linked so the
  // owning station is shown alongside its bit-flip neighbours.
  const baseRow = {
    isBase: true, bits: null, value: base,
    binary: base.toString(2).padStart(16, '0'),
    matches: idx.get(base) || [],
  };

  // sensor types present among matches (for the filter dropdown)
  const types = [...new Set([baseRow, ...variants].flatMap(v => v.matches.map(m => m.sensor.type)))].sort();

  // rows to display
  let rows;
  if (filter)                    rows = variants.filter(v => rowMatches(v).length);
  else if (state.bfOnlyMatches)  rows = variants.filter(v => v.matches.length);
  else                           rows = variants;

  const totalToShow = rows.length;
  const truncated   = rows.length > BF_MAX_RENDER_ROWS;
  if (truncated) rows = rows.slice(0, BF_MAX_RENDER_ROWS);

  // Pin the station-of-interest row at the top, following the same match/filter
  // rules the variant rows do so it isn't shown emptily under an active filter.
  const showBase = filter ? rowMatches(baseRow).length
                 : state.bfOnlyMatches ? baseRow.matches.length
                 : true;
  if (showBase) rows = [baseRow, ...rows];

  const matchedCount = variants.filter(v => v.matches.length).length;

  // ARRO link across the station of interest plus every matched flip-variant
  // sensor that passes the current filter.
  const arroPairs = [baseRow, ...variants].flatMap(v => v.matches.filter(matchPasses));
  const arro = buildArroUrl(arroPairs);

  const rowsHtml = rows.map(v => {
    const ms  = dedupeMatches(rowMatches(v));
    const hit = ms.length > 0;
    const dash = '<span style="color:var(--muted)">—</span>';
    const stationBadges = hit
      ? [...new Set(ms.map(m => m.station.name))].map(n => `<span class="badge">${esc(n)}</span>`).join(' ')
      : dash;
    const sensorTypes = hit ? ms.map(m => esc(m.sensor.type)).join('<br>') : dash;
    const sensorIds   = hit ? ms.map(m => esc(m.sensor.sensor_id || '—')).join('<br>') : dash;
    const reps = hit
      ? [...new Map(ms.flatMap(m => findRepeaterMatches(m.station, state.data.stations)).map(r => [r.id, r])).values()]
      : [];
    const repHtml = reps.length
      ? reps.map(r => `<span class="badge badge--repeater">${esc(r.name)}</span>`).join(' ')
      : dash;
    const bitsCell = v.isBase
      ? `NA <span class="badge bf-badge-base" title="Station of interest — the ALERT address you entered">station of interest</span>`
      : v.bits.join(', ');
    return `
      <tr${v.isBase ? ' class="bf-row-base"' : ''}>
        <td class="small mono">${bitsCell}</td>
        <td>${v.value}</td>
        <td class="small mono">${v.binary}</td>
        <td style="text-align:center">${hit ? '✓' : ''}</td>
        <td>${stationBadges}</td>
        <td class="small">${sensorTypes}</td>
        <td class="small mono">${sensorIds}</td>
        <td>${repHtml}</td>
      </tr>`;
  }).join('');

  return `
    <div class="panel">
      <div class="panel-header" style="flex-wrap:wrap;gap:.5rem">
        <h3>Bit-Flip Variants</h3>
        <span class="small" style="color:var(--muted)">
          ${variants.length} variant${variants.length === 1 ? '' : 's'} · ${matchedCount} matched
        </span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:1rem;align-items:center;margin:.5rem 0">
        ${types.length ? `
          <label class="small" style="color:var(--muted)">Filter by sensor:
            <select onchange="onBfSensorFilter(this.value)" style="margin-left:.3rem">
              <option value=""${!filter ? ' selected' : ''}>All sensors</option>
              ${types.map(t => `<option value="${esc(t)}"${filter === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}
            </select>
          </label>` : ''}
        <span id="bf-arro-link">${arro
          ? `<a href="${esc(arro.url)}" target="_blank" rel="noopener">Open ARRO graph (${arro.count} sensor${arro.count === 1 ? '' : 's'})</a>`
          : `<span class="small" style="color:var(--muted)">No ARRO-linkable sensors in current matches</span>`}</span>
      </div>
      ${truncated ? `<p class="small" style="color:#b8860b">Showing first ${BF_MAX_RENDER_ROWS} of ${totalToShow} rows — reduce the bit count or use the sensor filter to narrow.</p>` : ''}
      ${rows.length ? `
        <div class="table-wrap tall">
          <table class="bf-table">
            <thead><tr>
              <th>Bit(s)</th><th>Decimal</th><th>Binary</th><th>Match</th>
              <th>Station(s)</th><th>Sensor</th><th>Sensor ID</th><th>Repeater(s)</th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`
      : `<p class="small" style="color:var(--muted)">No ${filter ? esc(filter) + ' ' : ''}matches for these variants.</p>`}
    </div>`;
}

// ── Bit Flipper event handlers ──────────────────────────────────────────────
// Each handler updates only #bf-results (never the control it fired from), so
// the focused input keeps focus and the caret while results refresh live.

function refreshBfResults() {
  const el = document.getElementById('bf-results');
  if (el) el.innerHTML = renderBitFlipperResults();
}

function scheduleBfMapRefresh() {
  if (state.bfMapTimer) clearTimeout(state.bfMapTimer);
  state.bfMapTimer = setTimeout(() => { state.bfMapTimer = null; refreshBitFlipperMap(); }, 250);
}

function onBfAddrInput(val) {
  state.bfInput = val;
  state.bfSensorFilter = '';
  refreshBfResults();
  scheduleBfMapRefresh();
}

function onBfBitsInput(val) {
  state.bfBits = val;
  state.bfSensorFilter = '';
  refreshBfResults();
  scheduleBfMapRefresh();
}

function onBfOnlyMatches(checked) {
  state.bfOnlyMatches = checked;
  refreshBfResults();
}

function onBfArroInput(val) {
  state.bfArroBase = val;
  refreshBfResults();
}

function onBfSensorFilter(val) {
  state.bfSensorFilter = val;
  refreshBfResults();
}

// Create the Leaflet map once per tab render, then draw the current variants.
function initBitFlipperMap() {
  if (state.bfMap) { state.bfMap.remove(); state.bfMap = null; }
  state.bfMapLayer = null;
  const el = document.getElementById('bf-map');
  if (!el || !state.data || typeof L === 'undefined') return;

  state.bfMap = L.map('bf-map').setView([-28, 134], 4);
  addBaseLayers(state.bfMap);
  state.bfMapLayer = L.layerGroup().addTo(state.bfMap);
  refreshBitFlipperMap();
}

// Redraw the matched-station markers, repeater markers and links for the
// current address + bit count. Reuses the existing map (no full rebuild).
function refreshBitFlipperMap() {
  if (!state.bfMap || !state.bfMapLayer || !state.data) return;
  const layer = state.bfMapLayer;
  layer.clearLayers();

  const base = bfBaseId();
  if (base == null) return;

  const idx = buildSensorIndex();

  // Collect stations matching any flip variant (across all N-bit combos)
  const stationInfo = new Map(); // station id → { station, addrs:Set, bits:Set, isBase }
  for (const combo of bitCombos(16, bfBitsToFlip())) {
    let v = base;
    for (const b of combo) v ^= (1 << b);
    if (v <= 0 || v >= 65536 || v === base) continue;
    (idx.get(v) || []).forEach(({ station: s }) => {
      if (!stationInfo.has(s.id)) stationInfo.set(s.id, { station: s, addrs: new Set(), bits: new Set() });
      const info = stationInfo.get(s.id);
      info.addrs.add(v);
      info.bits.add(combo.join('+'));
    });
  }

  // Also include the base address's own matching stations (highlighted differently)
  (idx.get(base) || []).forEach(({ station: s }) => {
    if (!stationInfo.has(s.id)) stationInfo.set(s.id, { station: s, addrs: new Set([base]), bits: new Set() });
    stationInfo.get(s.id).isBase = true;
  });

  // Collect repeaters open to the matched field stations
  const repeaterInfo = new Map(); // repeater id → { station: r, fieldStations: [] }
  for (const { station: s } of stationInfo.values()) {
    findRepeaterMatches(s, state.data.stations).forEach(r => {
      if (!repeaterInfo.has(r.id)) repeaterInfo.set(r.id, { station: r, fieldStations: [] });
      repeaterInfo.get(r.id).fieldStations.push(s);
    });
  }

  const bounds = [];
  for (const { station: s, addrs, bits, isBase } of stationInfo.values()) {
    if (s.lat == null || s.lon == null) continue;
    const role  = primaryRole(s);
    const color = isBase && !bits.size ? '#ff8c00' : (ROLE_COLOR[role] || ROLE_COLOR.field);
    const marker = L.circleMarker([s.lat, s.lon], {
      radius: s.roles.includes('repeater') ? 9 : 6,
      color, fillColor: color, fillOpacity: 0.85,
      weight: isBase ? 3 : 1.5,
    }).addTo(layer);

    const bitsLabel = bits.size
      ? `<br><span style="font-size:.82rem">Flipped bits: ${[...bits].join(', ')}</span>`
      : '';
    const baseLabel = isBase
      ? `<span style="background:#ff8c00;color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem;margin-left:4px">exact match</span>`
      : '';
    marker.bindPopup(`
      <strong>${esc(s.name)}</strong>${baseLabel}<br>
      ${s.roles.map(r => `<span style="background:${ROLE_COLOR[r]};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem;margin-right:2px">${r}</span>`).join('')}
      ${bitsLabel}
      <br><span style="font-size:.82rem">AlertID: ${[...addrs].sort((a, b) => a - b).join(', ')}</span>
    `);
    bounds.push([s.lat, s.lon]);
  }

  // Draw repeaters open to matched field stations, plus lines to those stations
  for (const { station: r, fieldStations } of repeaterInfo.values()) {
    if (r.lat == null || r.lon == null) continue;

    // Only add a marker if this repeater isn't already shown as a matched station
    if (!stationInfo.has(r.id)) {
      const rMarker = L.circleMarker([r.lat, r.lon], {
        radius: 9,
        color: ROLE_COLOR.repeater,
        fillColor: ROLE_COLOR.repeater,
        fillOpacity: 0.85,
        weight: 1.5,
      }).addTo(layer);
      const served = fieldStations.map(fs => esc(fs.name)).join(', ');
      rMarker.bindPopup(`
        <strong>${esc(r.name)}</strong><br>
        <span style="background:${ROLE_COLOR.repeater};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem">repeater</span>
        <br><span style="font-size:.82rem;margin-top:4px;display:block">Open to: ${served}</span>
      `);
      bounds.push([r.lat, r.lon]);
    }

    // Draw a dashed line from the repeater to each matched field station it serves
    for (const fs of fieldStations) {
      if (fs.lat == null || fs.lon == null) continue;
      L.polyline([[r.lat, r.lon], [fs.lat, fs.lon]], {
        color: ROLE_COLOR.repeater,
        weight: 1.5,
        opacity: 0.5,
        dashArray: '5 6',
      }).addTo(layer);
    }
  }

  if (bounds.length) state.bfMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
}

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
      <aside class="sidebar stack">
        <div class="panel">
          <div class="panel-header">
            <h3>BoM Networks</h3>
            <span>
              <button onclick="exportSelectAll(true)" style="padding:.25rem .5rem;font-size:.8rem">All</button>
              <button onclick="exportSelectAll(false)" style="padding:.25rem .5rem;font-size:.8rem">None</button>
            </span>
          </div>
          <div class="checklist">
            ${nets.map(n => `
              <label>
                <input type="checkbox" ${state.exportNets.has(n.id) ? 'checked' : ''}
                       onchange="toggleExportNet('${n.id}',this.checked)">
                ${esc(n.name)}
              </label>`).join('')}
          </div>
        </div>
        <div class="panel">
          <div class="small" style="color:var(--muted)">
            <strong>${selRpts.length}</strong> repeater${selRpts.length !== 1 ? 's' : ''} selected<br>
            <strong>${unitCount}</strong> total units in export
          </div>
        </div>
      </aside>

      <div>
        <div class="panel stack" style="gap:.75rem">
          <div class="panel-header">
            <h2>Radio Mobile Export</h2>
            <button class="primary" onclick="runExport()">Generate &amp; Download All</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>File</th><th>Contents</th></tr></thead>
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

        <div class="panel" style="margin-top:1rem">
          <div class="panel-header"><h2>Selected Repeaters</h2></div>
          <div class="table-wrap medium">
            <table>
              <colgroup>
                <col style="width:28%"><col style="width:20%"><col style="width:13%">
                <col style="width:13%"><col style="width:26%">
              </colgroup>
              <thead><tr><th>Repeater</th><th>Network</th><th>Rx (MHz)</th><th>Tx (MHz)</th><th>Pass ranges</th></tr></thead>
              <tbody>
                ${selRpts.map(r => `
                  <tr>
                    <td>${esc(r.name)}</td>
                    <td class="small">${r.radio_network_ids.map(id => netName(id)).join(', ')}</td>
                    <td class="rx-cell small">${r.repeater.rx_mhz || ''}</td>
                    <td class="tx-cell small">${r.repeater.tx_mhz || ''}</td>
                    <td class="small">${(r.repeater.pass_ranges || []).map(p => `${p.low}–${p.high}`).join(', ')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

function toggleExportNet(id, checked) {
  if (checked) state.exportNets.add(id); else state.exportNets.delete(id);
  document.getElementById('main-content').innerHTML = renderExportHtml();
}

function exportSelectAll(v) {
  state.exportNets = v
    ? new Set((state.data.radio_networks || []).map(n => n.id))
    : new Set();
  document.getElementById('main-content').innerHTML = renderExportHtml();
}

function countExportUnits(selectedNets) {
  const rpts = state.data.stations.filter(s =>
    s.roles.includes('repeater') && s.repeater &&
    s.radio_network_ids.some(id => selectedNets.has(id))
  );
  const all = state.data.stations;
  const ids = new Set(rpts.map(s => s.id));
  rpts.forEach(r => findStationMatches(r, all).forEach(s => ids.add(s.id)));
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
    findStationMatches(r, all).forEach(s => unitMap.set(s.id, s));
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
      const matched = new Set(findStationMatches(r, all).map(s => s.id));
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

  [
    ['MegaNet.csv',         megaNetCsv ],
    ['MegaNet_Network.csv', networkCsv ],
    ['MegaNet_Unit.csv',    unitCsv    ],
    ['MegaNet_System.csv',  systemCsv  ],
    ['MegaNet_NetData.csv', netDataCsv ],
  ].forEach(([name, content], i) => {
    setTimeout(() => dlText(name, content), i * 180);
  });
}

// ── STATION EDITOR (card on the Stations tab) ────────────────────────────────────
// The editor lives below the stations list on the Stations tab: selecting a row
// loads it here (see selectStation / renderStationEditorCard above). "+ New"
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
  rerenderStations();          // drop any row highlight
  rerenderStationEditorCard(); // show the blank form
}

function editorForm(s) {
  const hasRep  = s.roles.includes('repeater');
  const sensors = stationSensors(s).slice().sort((a, b) => (a.alert_id ?? 0) - (b.alert_id ?? 0));
  return `
    <div class="panel-header" style="margin-bottom:.75rem">
      <h2>${esc(s.name) || 'New Station'}</h2>
      <div style="display:flex;gap:.5rem">
        <button class="primary" onclick="editorSave()">Save</button>
        ${s.id ? `<button onclick="editorDelete()" style="border-color:#c7401a;color:#c7401a">Delete</button>` : ''}
      </div>
    </div>
    <div class="form-grid">
      <label>Name<input type="text" id="ef-name" value="${esc(s.name)}"></label>
      <label>Station Number<input type="text" id="ef-stnno" value="${esc(s.station_number || '')}"></label>
      <label>Latitude<input type="number" step="any" id="ef-lat" value="${s.lat ?? ''}"></label>
      <label>Longitude<input type="number" step="any" id="ef-lon" value="${s.lon ?? ''}"></label>
      <label>Elevation AHD (m)<input type="number" step="any" id="ef-elev" value="${s.elevation_ahd ?? ''}"></label>
      <label>RM System ID<input type="number" id="ef-rmsys" value="${s.rm_system_id || 1}"></label>
      <label class="full">Roles
        <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:.35rem">
          ${Object.keys(ROLE_LABEL).map(r => `
            <label style="font-weight:normal;display:flex;gap:.35rem;align-items:center">
              <input type="checkbox" name="ef-roles" value="${r}" ${s.roles.includes(r) ? 'checked' : ''}> ${r}
            </label>`).join('')}
        </div>
      </label>
      <div class="full" style="margin-top:.4rem">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.45rem">
          <div style="font-weight:600">ALERT IDs / Sensors${sensors.length ? ` <span class="small" style="font-weight:400">— ${sensors.length}</span>` : ''}</div>
          <button type="button" onclick="editorAddSensorRow()">+ Add sensor</button>
        </div>
        <div id="ef-sensors">
          ${sensors.map(sensorRowHtml).join('')}
        </div>
        <div class="small" style="color:var(--muted);margin-top:.2rem">
          One row per ALERT address and what it measures — rainfall, water level, battery, etc.
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
        <label class="full">Pass Ranges (one per line: <em>low-high</em>)
          <textarea id="ef-pass" rows="5">${(s.repeater?.pass_ranges || []).map(r => `${r.low}-${r.high}`).join('\n')}</textarea>
        </label>
        <label class="full">Exclusions (one per line: <em>low-high</em>)
          <textarea id="ef-excl" rows="3">${(s.repeater?.exclusions || []).map(r => `${r.low}-${r.high}`).join('\n')}</textarea>
        </label>
      </div>` : ''}`;
}

// One editable sensor row: ALERT id + type, with the national-export metadata
// (sensor_id, device_id) preserved on data-attributes so a round-trip keeps it.
function sensorRowHtml(se) {
  se = se || {};
  return `
    <div class="sensor-row" data-sensor-id="${esc(se.sensor_id || '')}" data-device-id="${se.device_id ?? ''}"
         style="display:flex;gap:.4rem;align-items:center;margin-bottom:.35rem">
      <input type="number" class="sensor-aid" value="${se.alert_id ?? ''}" placeholder="ALERT ID"
             style="flex:0 0 7.5rem;width:7.5rem">
      <input type="text" class="sensor-type" list="ef-sensor-types" value="${esc(se.type || '')}"
             placeholder="Sensor type (e.g. Rainfall)" style="flex:1 1 auto;width:auto;min-width:0">
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

function editorSave() {
  const stations = state.data.stations;
  const d = { ...state.editorDraft };

  d.name           = document.getElementById('ef-name')?.value.trim()  || d.name;
  d.station_number = document.getElementById('ef-stnno')?.value.trim() || '';
  d.lat            = pFloat(document.getElementById('ef-lat')?.value);
  d.lon            = pFloat(document.getElementById('ef-lon')?.value);
  d.elevation_ahd  = pFloat(document.getElementById('ef-elev')?.value);
  d.rm_system_id   = parseInt(document.getElementById('ef-rmsys')?.value) || 1;
  d.enabled        = document.getElementById('ef-enabled')?.checked ?? true;
  d.notes          = document.getElementById('ef-notes')?.value || '';
  d.roles          = [...document.querySelectorAll('input[name="ef-roles"]:checked')].map(b => b.value);

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

  if (!d.id) {
    d.id = slug(d.name) || `stn_${Date.now()}`;
    let uid = d.id, n = 2;
    while (stations.some(s => s.id === uid)) uid = `${d.id}_${n++}`;
    d.id = uid;
    stations.push(d);
  } else {
    const i = stations.findIndex(s => s.id === d.id);
    if (i >= 0) stations[i] = d; else stations.push(d);
  }

  state.editorId    = d.id;
  state.editorDraft = d;
  state.selectedId  = d.id;
  updateHeaderStats();
  rerenderStations();
  rerenderStationEditorCard();
}

function editorDelete() {
  if (!state.editorId) return;
  const name = state.data.stations.find(s => s.id === state.editorId)?.name || state.editorId;
  if (!confirm(`Delete "${name}"?`)) return;
  state.data.stations = state.data.stations.filter(s => s.id !== state.editorId);
  state.selectedId    = null;
  state.editorId      = null;
  state.editorDraft   = {};
  updateHeaderStats();
  rerenderStations();
  rerenderStationEditorCard();
}

// ── Filter helpers ─────────────────────────────────────────────────────────────

function networkFilterHtml(onChangeFn) {
  const nets = state.data?.radio_networks || [];
  if (!nets.length) return '';
  return `
    <div style="margin-top:.75rem">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.3rem">
        <span class="small" style="color:var(--muted)">BoM Network</span>
        <span>
          <button style="padding:.2rem .45rem;font-size:.78rem"
                  onclick="state.filters.networks=new Set();${onChangeFn}">All</button>
          <button style="padding:.2rem .45rem;font-size:.78rem"
                  onclick="state.filters.networks=new Set(${JSON.stringify(nets.map(n => n.id))});${onChangeFn}">None</button>
        </span>
      </div>
      <div class="checklist" style="max-height:18vh">
        ${nets.map(n => `
          <label>
            <input type="checkbox"
                   ${state.filters.networks.size === 0 || state.filters.networks.has(n.id) ? 'checked' : ''}
                   onchange="toggleFilter('networks','${n.id}',this.checked);${onChangeFn}">
            ${esc(n.name)}
          </label>`).join('')}
      </div>
    </div>`;
}

function toggleFilter(key, value, checked) {
  if (checked) state.filters[key].add(value);
  else         state.filters[key].delete(value);
}

function clearFilters() {
  state.filters = { search: '', networks: new Set(), catchments: new Set(), roles: new Set(), enabledOnly: false };
  renderMain();
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Escape a value for use inside a single-quoted JS string embedded in a
// double-quoted HTML attribute (e.g. onclick="fn('${escAttr(x)}')"). JS-escapes
// backslash/quote first, then HTML-escapes so map filenames containing spaces,
// commas or "&" survive both parsing layers intact.
function escAttr(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function csvEscape(s) {
  s = String(s ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g,'""')}"` : s;
}

function netName(id) {
  return (state.data?.radio_networks || []).find(n => n.id === id)?.name ?? id;
}

function pFloat(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function pInt(v)   { const n = parseInt(v, 10); return isNaN(n) ? null : n; }

function parseRangeLines(text) {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    return m ? { low: parseInt(m[1]), high: parseInt(m[2]) } : null;
  }).filter(Boolean);
}

function slug(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0, 64);
}

function dlText(name, content) {
  const a = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([content], { type: 'text/csv' })),
    download: name,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── ALERT Packets tab ────────────────────────────────────────────────────────────
// Decoder / encoder for ALERT / ERTS radio telemetry messages, per the Bureau of
// Meteorology "ERTS Data Formats" specification (July 2003). Ported from the
// standalone ALERT_PACKETS tool and integrated as a MegaNet tab. Decoded ALERT
// addresses are cross-referenced against the loaded MegaNet station database first,
// then against the bundled national address file "All 2021 Working 2.txt".

const Packets = (function () {

  // ── core codec ────────────────────────────────────────────────────────────────
  const CRC_POLY = 0x19; // x^6 + x^4 + x^3 + 1

  function bitsMsb(v, n) { const r = []; for (let i = n - 1; i >= 0; i--) r.push((v >> i) & 1); return r; }
  function crc6(bits) {
    let reg = 0;
    for (const b of bits) { const fb = ((reg >> 5) & 1) ^ b; reg = (reg << 1) & 0x3f; if (fb) reg ^= CRC_POLY; }
    return reg;
  }
  function eifCrc(a, d)    { return crc6(bitsMsb(a, 13).concat(bitsMsb(d, 11))); }
  function eafCrc(a, d, b) { return crc6(bitsMsb(a, 12).concat(bitsMsb(d, 11), [b & 1])); }

  function A(i)  { return { f: 'A', i }; }  function D(i) { return { f: 'D', i }; }
  function K(e)  { return { f: 'K', expect: e }; }
  function HD(i) { return { f: 'HD', i }; } function BS(i) { return { f: 'BS', i }; }
  function C(i)  { return { f: 'C', i }; }  function R(i) { return { f: 'R', i }; }
  const B0 = { f: 'B', i: 0 }, VCO = { f: 'VCO', i: 0 }, DE = { f: 'DE', i: 0 };

  const FIELD_META = {
    A:   { label: 'Address (sensor ID)',       cls: 'f-A' },
    D:   { label: 'Data value',                cls: 'f-D' },
    K:   { label: 'Format ID / check bits',    cls: 'f-K' },
    R:   { label: 'FCS (CRC-6)',               cls: 'f-R' },
    C:   { label: 'CRC / wind-gust bits',      cls: 'f-C' },
    B:   { label: 'Battery status bit',        cls: 'f-B' },
    BS:  { label: 'Battery status',            cls: 'f-BS' },
    VCO: { label: 'VCO error flag',            cls: 'f-VCO' },
    DE:  { label: 'Data error flag',           cls: 'f-DE' },
    HD:  { label: 'High data bits (D11–D15)',  cls: 'f-HD' },
    frame: { label: 'Start / stop bits',       cls: 'f-frame' },
  };

  const FORMATS = {
    abf: { key: 'abf', name: 'ALERT Binary Format (ABF)', short: 'ABF',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(0),
            A(6), A(7), A(8), A(9), A(10), A(11), K(1), K(0),
            A(12), D(0), D(1), D(2), D(3), D(4), K(1), K(1),
            D(5), D(6), D(7), D(8), D(9), D(10), K(1), K(1)],
      abits: 13, note: 'The standard format used in Australia. No CRC — validity rests on the fixed check bits alone.' },
    bcc: { key: 'bcc', name: 'BCC Extended Check Format', short: 'BCC',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(0),
            A(6), A(7), A(8), A(9), A(10), A(11), K(1), K(0),
            A(12), HD(0), HD(1), HD(2), HD(3), HD(4), K(0), K(1),
            BS(0), BS(1), BS(2), BS(3), VCO, DE, K(0), K(1)],
      abits: 13, note: 'Health/check message sent after a binary check signal. HD carries bits 11–15 of the full 16-bit stored value; BS is battery status; VCO and DE are error flags.' },
    eaf: { key: 'eaf', name: 'Enhanced ALERT Binary Format (EAF)', short: 'EAF',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(1),
            A(6), A(7), A(8), A(9), A(10), A(11), D(0), D(1),
            D(2), D(3), D(4), D(5), D(6), D(7), D(8), D(9),
            D(10), B0, C(5), C(4), C(3), C(2), C(1), C(0)],
      abits: 12, note: '12-bit address (0–4095), battery bit B, 6 CRC bits. Wind sensors substitute gust data for the CRC. The BoM document does not define the EAF CRC algorithm — the check shown here assumes the same x⁶+x⁴+x³+1 CRC as EIF, computed over address, data and B.' },
    eif: { key: 'eif', name: 'Enhanced IFLOWS Format (EIF)', short: 'EIF',
      map: [A(0), A(1), A(2), A(3), A(4), A(5), K(1), K(1),
            A(6), A(7), A(8), A(9), A(10), A(11), A(12), D(0),
            D(1), D(2), D(3), D(4), D(5), D(6), D(7), D(8),
            D(9), D(10), R(5), R(4), R(3), R(2), R(1), R(0)],
      abits: 13, note: '13-bit address, 11-bit data, 6-bit FCS (CRC, generator polynomial x⁶+x⁴+x³+1 over address then data, MSB first).' },
  };

  function normaliseInput(raw) {
    let s = String(raw || '').trim().replace(/[\s,_.\-]+/g, '');
    if (/^0x[0-9a-f]+$/i.test(s)) {
      const hex = s.slice(2);
      if (hex.length !== 8) return { ok: false, error: 'Hex input must be exactly 8 hex digits (32 bits).' };
      s = [...hex].map(h => parseInt(h, 16).toString(2).padStart(4, '0')).join('');
    }
    if (!/^[01]+$/.test(s)) return { ok: false, error: 'Input must be a binary string of 0s and 1s (spaces allowed), or hex like 0x07D5F8FE.' };
    if (s.length === 32) return { ok: true, bits32: s, framing: { present: false } };
    if (s.length !== 40) return { ok: false, error: 'Expected 40 bits (framed, 4 × 10-bit words) or 32 bits (payload only) — got ' + s.length + ' bits.' };
    const words = [0, 10, 20, 30].map(i => s.slice(i, i + 10));
    const test = (st, sp) => words.every(w => w[0] === st && w[9] === sp);
    let polarity = null, valid = false;
    if (test('1', '0'))      { polarity = 'negative'; valid = true; }
    else if (test('0', '1')) { polarity = 'standard'; valid = true; }
    const bits32 = words.map(w => w.slice(1, 9)).join('');
    return { ok: true, bits32, bits40: s, framing: { present: true, polarity, valid,
      detail: valid ? (polarity === 'negative' ? 'start = 1, stop = 0 (ALERT negative logic)' : 'start = 0, stop = 1 (standard async)')
                    : 'start/stop bits are inconsistent across the four words — framing ignored, middle 8 bits of each word taken as payload.' } };
  }

  function decodeFormat(fmtKey, bits32) {
    const fmt = FORMATS[fmtKey];
    const vals = {}; let identOk = true; const identErrors = [];
    fmt.map.forEach((cell, pos) => {
      const bit = bits32[pos] === '1' ? 1 : 0;
      if (cell.f === 'K') { if (bit !== cell.expect) { identOk = false; identErrors.push(pos); } }
      else (vals[cell.f] = vals[cell.f] || [])[cell.i] = bit;
    });
    const num = {};
    for (const [f, arr] of Object.entries(vals)) num[f] = arr.reduce((a, b, i) => a + (b << i), 0);
    const out = { format: fmtKey, name: fmt.name, identOk, identErrors, values: num };
    if (fmtKey === 'eif') { out.crcExpected = eifCrc(num.A, num.D);         out.crcOk = out.crcExpected === num.R; }
    if (fmtKey === 'eaf') { out.crcExpected = eafCrc(num.A, num.D, num.B);  out.crcOk = out.crcExpected === num.C; out.crcAssumed = true; }
    out.valid = identOk && (out.crcOk !== false);
    return out;
  }
  function decodeAll(bits32) { return Object.keys(FORMATS).map(k => decodeFormat(k, bits32)); }

  // Public decode helper shared with the Serial Monitor tab. Accepts the same
  // inputs as the decode box (40-bit framed / 32-bit payload binary, or 8-digit
  // hex) and returns the normalised framing, every format's decode and the single
  // unambiguous "best" format (null when zero or several formats pass all checks).
  function decodeMessage(raw) {
    const n = normaliseInput(raw);
    if (!n.ok) return { ok: false, error: n.error };
    const results = decodeAll(n.bits32);
    const validOnes = results.filter(r => r.valid);
    const best = validOnes.length === 1 ? validOnes[0].format : null;
    return { ok: true, framing: n.framing, bits32: n.bits32, results, best };
  }

  function encodeFormat(fmtKey, values, polarity) {
    const fmt = FORMATS[fmtKey];
    const v = Object.assign({}, values);
    const lim = (name, val, bits) => {
      if (val == null || isNaN(val)) throw new Error('Missing value for ' + name + '.');
      if (val < 0 || val > (1 << bits) - 1) throw new Error(name + ' must be 0–' + ((1 << bits) - 1) + ' for this format (got ' + val + ').');
    };
    lim('Sensor ID', v.A, fmt.abits);
    if (fmtKey === 'abf') { lim('Data value', v.D, 11); }
    if (fmtKey === 'bcc') { v.HD = v.HD || 0; v.BS = v.BS || 0; v.VCO = v.VCO ? 1 : 0; v.DE = v.DE ? 1 : 0;
      lim('HD (high data bits)', v.HD, 5); lim('BS (battery status)', v.BS, 4); }
    if (fmtKey === 'eaf') { lim('Data value', v.D, 11); v.B = v.B ? 1 : 0; v.C = eafCrc(v.A, v.D, v.B); }
    if (fmtKey === 'eif') { lim('Data value', v.D, 11); v.R = eifCrc(v.A, v.D); }
    let bits32 = '';
    fmt.map.forEach(cell => { bits32 += cell.f === 'K' ? cell.expect : ((v[cell.f] >> cell.i) & 1); });
    const st = polarity === 'standard' ? '0' : '1', sp = polarity === 'standard' ? '1' : '0';
    let bits40 = '';
    for (let w = 0; w < 4; w++) bits40 += st + bits32.slice(w * 8, w * 8 + 8) + sp;
    const hex = '0x' + parseInt(bits32, 2).toString(16).toUpperCase().padStart(8, '0');
    return { format: fmtKey, values: v, bits32, bits40, hex, polarity: polarity === 'standard' ? 'standard' : 'negative' };
  }

  // ── station name lookup ───────────────────────────────────────────────────────
  // Two sources: the loaded MegaNet database (state.data) takes priority, then the
  // bundled national address file. MegaNet index is cached and rebuilt when the
  // underlying data object changes.
  let fileStations = null;      // Map id -> name from the address file (null until loaded)
  let fileLoading  = false;
  const mnIndex = { src: null, map: null };

  function megaNetName(id) {
    if (!state.data || !Array.isArray(state.data.stations)) return null;
    if (mnIndex.src !== state.data) {
      mnIndex.src = state.data;
      mnIndex.map = new Map();
      state.data.stations.forEach(s => stationAlertIds(s).forEach(aid => {
        if (!mnIndex.map.has(aid)) mnIndex.map.set(aid, s.name);
      }));
    }
    return mnIndex.map.get(id) || null;
  }

  function stationName(id) {
    const mn = megaNetName(id);
    if (mn) return { text: mn, none: false, source: 'meganet' };
    if (fileStations) { const n = fileStations.get(id); if (n) return { text: n, none: false, source: 'file' }; }
    if (fileStations === null && fileLoading) return { text: 'loading…', none: true };
    return { text: 'not found in address file', none: true };
  }

  async function loadStationsFile() {
    if (fileStations !== null || fileLoading) return;
    fileLoading = true;
    try {
      const res = await fetch(encodeURI('data/All 2021 Working 2.txt'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const u8 = new Uint8Array(buf);
      let text;
      if (u8[0] === 0xFF && u8[1] === 0xFE)      text = new TextDecoder('utf-16le').decode(buf);
      else if (u8[0] === 0xFE && u8[1] === 0xFF) text = new TextDecoder('utf-16be').decode(buf);
      else                                        text = new TextDecoder('utf-8').decode(buf);
      text = text.replace(/^﻿/, '');
      fileStations = new Map();
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith(' ')) continue;             // address file rule: data lines start with a space
        const m = line.match(/^\s*(\d+)\s+(.*\S)/);
        if (m && !fileStations.has(+m[1])) fileStations.set(+m[1], m[2]);
      }
    } catch (e) {
      fileStations = new Map();
      fileStations.loadError = e.message;
    } finally {
      fileLoading = false;
      updateStnStatus();
      if (state.activeTab === 'packets') replay();       // re-render results now names are available
    }
  }

  function updateStnStatus() {
    const el = document.getElementById('pkt-stnStatus');
    if (!el) return;
    if (fileStations === null) { el.textContent = fileLoading ? ' Loading ALERT address file…' : ''; return; }
    if (fileStations.loadError)
      el.textContent = ' ALERT address file could not be loaded (' + fileStations.loadError + ') — decoding still works; names come from the MegaNet database only.';
    else
      el.textContent = ' Loaded ' + fileStations.size + ' addresses from the ALERT address file.';
  }

  // ── rendering helpers ─────────────────────────────────────────────────────────
  function bitCells(fmtKey, bits, framed) {
    const map = FORMATS[fmtKey].map;
    const cells = [];
    if (framed) {
      for (let w = 0; w < 4; w++) {
        cells.push({ bit: bits[w * 10], f: 'frame', lbl: 'S' });
        for (let i = 0; i < 8; i++) {
          const cell = map[w * 8 + i];
          cells.push({ bit: bits[w * 10 + 1 + i], f: cell.f, lbl: cell.f === 'K' ? 'K' : cell.f + (cell.i !== undefined ? cell.i : ''), cell });
        }
        cells.push({ bit: bits[w * 10 + 9], f: 'frame', lbl: 'E' });
      }
    } else {
      for (let p = 0; p < 32; p++) {
        const cell = map[p];
        cells.push({ bit: bits[p], f: cell.f, lbl: cell.f === 'K' ? 'K' : cell.f + (cell.i !== undefined ? cell.i : ''), cell });
      }
    }
    return cells;
  }

  function renderBitMap(fmtKey, bits, framed, identErrors, uid) {
    const cells = bitCells(fmtKey, bits, framed);
    const per = framed ? 10 : 8;
    let html = '<div class="bitwords" data-uid="' + uid + '">';
    for (let w = 0; w < 4; w++) {
      html += '<div class="bitword"><div class="wlabel">Word ' + (w + 1) + '</div><div class="bitrow">';
      let lbls = '';
      for (let i = 0; i < per; i++) {
        const c = cells[w * per + i];
        const payloadPos = framed ? (w * 8 + i - 1) : (w * 8 + i);
        const bad = c.f === 'K' && identErrors && identErrors.includes(payloadPos);
        html += '<div class="bit ' + FIELD_META[c.f].cls + (bad ? ' kbad' : '') + '" data-f="' + c.f + '" title="' + esc(FIELD_META[c.f].label + (c.cell && c.cell.i !== undefined ? ' — bit ' + c.cell.i : '')) + '">' + c.bit + '</div>';
        lbls += '<span>' + c.lbl + '</span>';
      }
      html += '</div><div class="lblrow">' + lbls + '</div></div>';
    }
    html += '</div>';
    return html;
  }

  const SWATCH = { A: 'addr', D: 'data', K: 'ident', R: 'crc', C: 'crc', B: 'batt', BS: 'batt', VCO: 'batt', DE: 'batt', HD: 'hd', frame: 'frame' };

  function legendHtml(fields) {
    return '<div class="legend">' + fields.map(f => '<span><i style="background:var(--c-' + SWATCH[f] + ')"></i>' + esc(FIELD_META[f].label) + '</span>').join('') + '</div>';
  }

  function fieldRows(fmtKey, dec) {
    const fmt = FORMATS[fmtKey];
    const rows = [];
    const positions = {};
    fmt.map.forEach((c, p) => { if (c.f !== 'K') { (positions[c.f] = positions[c.f] || []).push(p); } });
    const order = ['A', 'D', 'HD', 'BS', 'B', 'VCO', 'DE', 'R', 'C'];
    for (const f of order) {
      if (!(f in dec.values)) continue;
      const nbits = positions[f].length;
      const v = dec.values[f];
      const binMsb = v.toString(2).padStart(nbits, '0');
      let extra = '';
      if (f === 'A') {
        const s = stationName(v);
        extra = '<div>Station name: <span class="stn' + (s.none ? ' none' : '') + '">' + esc(s.text) + '</span>'
              + (s.source === 'meganet' ? ' <span class="badge ok">MegaNet</span>' : '') + '</div>';
      }
      if (f === 'HD') extra = '<div class="spec">Full 16-bit value = HD × 2048 + last transmitted 11-bit data value = ' + (v * 2048) + ' + data.</div>';
      if ((f === 'R' || f === 'C') && dec.crcExpected !== undefined) {
        extra = '<div class="spec">Computed ' + (f === 'R' ? 'FCS' : 'CRC') + ': ' + dec.crcExpected + ' — '
          + (dec.crcOk ? '<span style="color:var(--ok)">matches ✓</span>' : '<span style="color:var(--bad)">mismatch ✗</span>')
          + (dec.crcAssumed ? ' (algorithm assumed, see note below; for wind sensors these bits are gust data instead)' : '') + '</div>';
      }
      rows.push('<tr class="frow" data-f="' + f + '">'
        + '<td><span class="swatch" style="background:var(--c-' + SWATCH[f] + ')"></span>' + esc(FIELD_META[f].label) + '</td>'
        + '<td><code>' + binMsb + '</code><div class="spec">' + nbits + ' bit' + (nbits > 1 ? 's' : '') + ', sent ' + ((f === 'R' || f === 'C') ? 'MSB' : 'LSB') + ' first</div></td>'
        + '<td><span class="val">' + v + '</span>' + extra + '</td></tr>');
    }
    return '<table class="fields"><thead><tr><th>FIELD</th><th>BITS (MSB→LSB)</th><th>VALUE</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }

  function attachHover(container) {
    container.querySelectorAll('tr.frow').forEach(tr => {
      const f = tr.dataset.f;
      const card = tr.closest('.fmtbody, .encout') || container;
      tr.addEventListener('mouseenter', () => card.querySelectorAll('.bit[data-f="' + f + '"]').forEach(b => b.classList.add('hl')));
      tr.addEventListener('mouseleave', () => card.querySelectorAll('.bit[data-f="' + f + '"]').forEach(b => b.classList.remove('hl')));
    });
  }

  // ── decoder ───────────────────────────────────────────────────────────────────
  function doDecode(input, scroll) {
    const errEl = document.getElementById('pkt-decError');
    const frEl  = document.getElementById('pkt-decFraming');
    const resEl = document.getElementById('pkt-decResults');
    if (!resEl) return;
    state.pkt.decInput = input;
    state.pkt.lastDecode = input;
    errEl.hidden = true; frEl.hidden = true; resEl.innerHTML = '';
    const n = normaliseInput(input);
    if (!n.ok) { errEl.textContent = n.error; errEl.hidden = false; return; }
    if (n.framing.present) {
      frEl.innerHTML = 'Framing: ' + (n.framing.valid ? '<b style="color:var(--ok)">valid</b> — ' : '<b style="color:var(--warn)">inconsistent</b> — ') + esc(n.framing.detail)
        + '. Payload (32 bits): <code>' + n.bits32 + '</code>';
    } else {
      frEl.innerHTML = '32-bit payload supplied (no start/stop bits).';
    }
    frEl.hidden = false;
    const results = decodeAll(n.bits32);
    const validOnes = results.filter(r => r.valid);
    const best = validOnes.length === 1 ? validOnes[0].format : null;
    const ordered = [...results].sort((a, b) => (b.valid ? 1 : 0) - (a.valid ? 1 : 0));
    ordered.forEach(r => {
      const fmt = FORMATS[r.format];
      const badges = [];
      badges.push(r.identOk ? '<span class="badge ok">check bits ✓</span>' : '<span class="badge bad">check bits ✗</span>');
      if (r.crcOk !== undefined) badges.push(r.crcOk ? '<span class="badge ok">' + (r.format === 'eif' ? 'FCS' : 'CRC') + ' ✓</span>'
                                                     : '<span class="badge ' + (r.crcAssumed ? 'warn' : 'bad') + '">' + (r.format === 'eif' ? 'FCS' : 'CRC') + ' ✗</span>');
      if (r.format === best) badges.unshift('<span class="badge ok">BEST MATCH</span>');
      const open = r.valid || validOnes.length === 0;
      const s = stationName(r.values.A);
      const summary = r.valid
        ? 'ID ' + r.values.A + (r.values.D !== undefined ? ' · value ' + r.values.D : '') + ' · ' + esc(s.text)
        : 'not a valid ' + fmt.short + ' message';
      let body = '';
      body += renderBitMap(r.format, n.framing.present ? n.bits40 : n.bits32, n.framing.present, r.identErrors, 'dec-' + r.format);
      const legendFields = [...new Set(fmt.map.map(c => c.f))]; if (n.framing.present) legendFields.push('frame');
      body += legendHtml(legendFields);
      body += fieldRows(r.format, r);
      body += '<p class="spec">' + esc(fmt.note) + '</p>';
      if (r.format !== 'bcc' && r.values.A !== undefined && r.values.D !== undefined)
        body += '<button class="ghost" onclick="Packets.prefillEncoder(\'' + r.format + '\',' + r.values.A + ',' + r.values.D + ')">Open in encoder</button>';
      resEl.insertAdjacentHTML('beforeend',
        '<div class="fmtcard' + (r.format === best ? ' best' : '') + (open ? ' open' : '') + '" id="pkt-card-' + r.format + '">'
        + '<div class="fmthead" onclick="this.parentElement.classList.toggle(\'open\')">'
        + '<h3>' + esc(fmt.name) + '</h3>' + badges.join(' ')
        + '<span class="caret">' + esc(summary) + ' ▾</span></div>'
        + '<div class="fmtbody">' + body + '</div></div>');
    });
    attachHover(resEl);
    if (scroll) resEl.scrollIntoView({ behavior: 'smooth' });
  }

  // ── encoder ───────────────────────────────────────────────────────────────────
  const ENC_EXTRAS = {
    abf: [], eif: [],
    eaf: [{ id: 'pkt-encB', key: 'b', label: 'Battery bit B (0 = good)', type: 'select01' }],
    bcc: [{ id: 'pkt-encHD', key: 'hd', label: 'HD — high data bits (0–31)', type: 'num', max: 31 },
          { id: 'pkt-encBS', key: 'bs', label: 'BS — battery status (0–15)', type: 'num', max: 15 },
          { id: 'pkt-encVCO', key: 'vco', label: 'VCO error flag', type: 'select01' },
          { id: 'pkt-encDE',  key: 'de',  label: 'DE data error flag', type: 'select01' }],
  };

  function encExtrasHtml(fmt) {
    const e = state.pkt.enc;
    return ENC_EXTRAS[fmt].map(x => {
      if (x.type === 'num')
        return '<div><label for="' + x.id + '">' + esc(x.label) + '</label>'
          + '<input type="number" id="' + x.id + '" min="0" max="' + x.max + '" value="' + (e[x.key] || 0) + '"'
          + ' oninput="Packets.setEnc(\'' + x.key + '\',this.value)"></div>';
      const v = e[x.key] ? 1 : 0;
      return '<div><label for="' + x.id + '">' + esc(x.label) + '</label>'
        + '<select id="' + x.id + '" onchange="Packets.setEnc(\'' + x.key + '\',this.value)">'
        + '<option value="0"' + (v === 0 ? ' selected' : '') + '>0</option>'
        + '<option value="1"' + (v === 1 ? ' selected' : '') + '>1</option></select></div>';
    }).join('');
  }

  function refreshStation() {
    const el = document.getElementById('pkt-encStation');
    if (!el) return;
    const id = parseInt(state.pkt.enc.id, 10);
    if (isNaN(id)) { el.textContent = ''; return; }
    const s = stationName(id);
    el.innerHTML = 'Station name for ID ' + id + ': <span class="stn' + (s.none ? ' none' : '') + '">' + esc(s.text) + '</span>'
      + (s.source === 'meganet' ? ' <span class="badge ok">MegaNet</span>' : '');
  }

  function onFormatChange(fmt) {
    state.pkt.enc.format = fmt;
    const wrap = document.getElementById('pkt-encExtras');
    if (wrap) wrap.innerHTML = encExtrasHtml(fmt);
    const dataWrap = document.getElementById('pkt-encDataWrap');
    if (dataWrap) dataWrap.style.display = fmt === 'bcc' ? 'none' : '';
    const idInput = document.getElementById('pkt-encId');
    if (idInput) idInput.max = (1 << FORMATS[fmt].abits) - 1;
    refreshStation();
  }

  function setEnc(key, val) {
    const num = ['id', 'data', 'hd', 'bs', 'vco', 'de', 'b'];
    state.pkt.enc[key] = num.includes(key) ? (parseInt(val, 10) || 0) : val;
    if (key === 'id') refreshStation();
  }

  function doEncode() {
    const errEl = document.getElementById('pkt-encError');
    const resEl = document.getElementById('pkt-encResult');
    if (!resEl) return;
    state.pkt.lastEncode = true;
    errEl.hidden = true; resEl.innerHTML = '';
    const e = state.pkt.enc;
    const fmt = e.format, polarity = e.polarity;
    const values = { A: parseInt(e.id, 10) };
    if (fmt !== 'bcc') values.D = parseInt(e.data, 10);
    if (fmt === 'eaf') values.B = e.b || 0;
    if (fmt === 'bcc') { values.HD = e.hd || 0; values.BS = e.bs || 0; values.VCO = e.vco || 0; values.DE = e.de || 0; }
    let enc;
    try { enc = encodeFormat(fmt, values, polarity); }
    catch (err) { errEl.textContent = err.message; errEl.hidden = false; return; }
    const dec = decodeFormat(fmt, enc.bits32);
    let html = '<div class="encout">';
    html += '<div class="outbits">40-bit framed:&nbsp; <b id="pkt-enc40">' + enc.bits40 + '</b>'
      + '<button class="ghost copybtn" onclick="Packets.copyTxt(\'pkt-enc40\',this)">copy</button></div>';
    html += '<div class="outbits">32-bit payload: <b id="pkt-enc32">' + enc.bits32 + '</b> &nbsp;·&nbsp; hex <b>' + enc.hex + '</b>'
      + '<button class="ghost copybtn" onclick="Packets.copyTxt(\'pkt-enc32\',this)">copy</button></div>';
    html += renderBitMap(fmt, enc.bits40, true, [], 'enc');
    const legendFields = [...new Set(FORMATS[fmt].map.map(c => c.f))]; legendFields.push('frame');
    html += legendHtml(legendFields);
    html += fieldRows(fmt, dec);
    html += '<p class="spec">' + esc(FORMATS[fmt].note) + '</p></div>';
    resEl.innerHTML = html;
    attachHover(resEl);
  }

  function copyTxt(id, btn) {
    const el = document.getElementById(id);
    if (!el || !navigator.clipboard) return;
    navigator.clipboard.writeText(el.textContent).then(() => {
      btn.textContent = 'copied ✓'; setTimeout(() => btn.textContent = 'copy', 1200);
    });
  }

  function prefillEncoder(fmt, idv, dv) {
    state.pkt.enc.format = fmt;
    state.pkt.enc.id = idv;
    state.pkt.enc.data = dv;
    const fmtEl = document.getElementById('pkt-encFormat'); if (fmtEl) fmtEl.value = fmt;
    const idEl = document.getElementById('pkt-encId');   if (idEl) idEl.value = idv;
    onFormatChange(fmt);
    const dEl = document.getElementById('pkt-encData');  if (dEl) dEl.value = dv;
    doEncode();
    const sec = document.getElementById('pkt-encodeSection');
    if (sec) sec.scrollIntoView({ behavior: 'smooth' });
  }

  // ── public: read the decode input box and decode / example ────────────────────
  const EXAMPLE = '1000001110111010101011111100001111111100';
  function decode()      { const el = document.getElementById('pkt-decInput'); if (el) doDecode(el.value, false); }
  function loadExample() { const el = document.getElementById('pkt-decInput'); if (el) { el.value = EXAMPLE; doDecode(EXAMPLE, false); } }
  function encode()      { doEncode(); }

  function replay() {
    if (state.pkt.lastDecode != null) doDecode(state.pkt.lastDecode, false);
    if (state.pkt.lastEncode)         doEncode();
  }

  // ── tab render + init ─────────────────────────────────────────────────────────
  function render() {
    const e = state.pkt.enc;
    const fmt = e.format;
    const abits = FORMATS[fmt].abits;
    return `
    <div class="pkt" style="max-width:1000px;margin:auto;padding:1rem;display:grid;gap:1rem">

      <div class="panel">
        <div class="panel-header"><h2>ALERT / ERTS Packet Tool</h2></div>
        <p class="sub">Decode and encode event-reporting radio telemetry (ALERT) messages per the Bureau of
          Meteorology <em>ERTS Data Formats</em> specification (July 2003) — ALERT Binary (ABF), BCC Extended
          Check, Enhanced ALERT Binary (EAF) and Enhanced IFLOWS (EIF). Decoded addresses are matched against
          the loaded MegaNet station database first, then the bundled national address file.</p>
      </div>

      <div class="panel" id="pkt-decodeSection">
        <div class="panel-header"><h3>Decode a message</h3></div>
        <p class="sub">Paste a binary string — 40 bits (four 10-bit words including start/stop bits) or 32 bits
          (payload only). Hex like <code>0x07D5F8FE</code> also works. The message is decoded against every
          known format; the one that passes all checks is highlighted.</p>
        <div class="row">
          <div class="grow2">
            <label for="pkt-decInput">Binary message</label>
            <input type="text" id="pkt-decInput" spellcheck="false" value="${esc(state.pkt.decInput)}"
                   oninput="state.pkt.decInput=this.value"
                   onkeydown="if(event.key==='Enter')Packets.decode()"
                   placeholder="e.g. 1000001110111010101011111100001111111100">
          </div>
          <div class="fit"><button class="primary" onclick="Packets.decode()">Decode</button></div>
          <div class="fit"><button class="ghost" onclick="Packets.loadExample()">Load example</button></div>
        </div>
        <div id="pkt-decError" class="err" hidden></div>
        <div id="pkt-decFraming" class="framing-note" hidden></div>
        <div id="pkt-decResults"></div>
      </div>

      <div class="panel" id="pkt-encodeSection">
        <div class="panel-header"><h3>Encode a message</h3></div>
        <p class="sub">Pick a format, enter the sensor ID and raw value(s), and get the binary message back.
          CRC / FCS bits are computed automatically. The bit map shows exactly where each value lands.</p>
        <div class="row">
          <div>
            <label for="pkt-encFormat">Format</label>
            <select id="pkt-encFormat" onchange="Packets.onFormatChange(this.value)">
              <option value="abf"${fmt === 'abf' ? ' selected' : ''}>ABF — ALERT Binary</option>
              <option value="bcc"${fmt === 'bcc' ? ' selected' : ''}>BCC — Extended Check</option>
              <option value="eaf"${fmt === 'eaf' ? ' selected' : ''}>EAF — Enhanced ALERT Binary</option>
              <option value="eif"${fmt === 'eif' ? ' selected' : ''}>EIF — Enhanced IFLOWS</option>
            </select>
          </div>
          <div>
            <label for="pkt-encId">Sensor ID (address)</label>
            <input type="number" id="pkt-encId" min="0" max="${(1 << abits) - 1}" value="${esc(e.id)}"
                   oninput="Packets.setEnc('id',this.value)">
          </div>
          <div id="pkt-encDataWrap" style="display:${fmt === 'bcc' ? 'none' : ''}">
            <label for="pkt-encData">Data value</label>
            <input type="number" id="pkt-encData" min="0" max="2047" value="${esc(e.data)}"
                   oninput="Packets.setEnc('data',this.value)">
          </div>
          <div>
            <label for="pkt-encPolarity">Framing (start/stop bits)</label>
            <select id="pkt-encPolarity" onchange="Packets.setEnc('polarity',this.value)">
              <option value="negative"${e.polarity !== 'standard' ? ' selected' : ''}>ALERT negative logic — start=1, stop=0</option>
              <option value="standard"${e.polarity === 'standard' ? ' selected' : ''}>Standard async — start=0, stop=1</option>
            </select>
          </div>
        </div>
        <div class="row" id="pkt-encExtras" style="margin-top:10px">${encExtrasHtml(fmt)}</div>
        <div class="note compact" id="pkt-encStation" style="margin-top:.75rem"></div>
        <div class="row" style="margin-top:14px">
          <div class="fit"><button class="primary" onclick="Packets.encode()">Encode</button></div>
        </div>
        <div id="pkt-encError" class="err" hidden></div>
        <div id="pkt-encResult"></div>
      </div>

      <div class="panel">
        <details>
          <summary class="pkt-summary">Format cheat-sheet</summary>
          <ul class="pkt-cheat">
            <li><b>ABF</b> — 13-bit address, 11-bit data. Words 1–2 carry check bits <code>10</code>, words 3–4 carry <code>11</code>.</li>
            <li><b>BCC Extended Check</b> — follow-up health message: 13-bit address, 5 high data bits (HD), 4 battery status bits (BS), VCO and DE error flags. Words 3–4 carry check bits <code>01</code>.</li>
            <li><b>EAF</b> — 12-bit address, 11-bit data, battery bit B, 6 CRC bits (wind sensors substitute gust data for the CRC). Abandoned in practice.</li>
            <li><b>EIF</b> — 13-bit address, 11-bit data, 6-bit FCS. FCS is a CRC with generator polynomial x⁶+x⁴+x³+1 over the 24 address+data bits (address then data, MSB first).</li>
            <li>All fields are transmitted least-significant bit first; each 10-bit word is start bit + 8 payload bits + stop bit.</li>
          </ul>
        </details>
        <p class="spec" style="margin-top:.75rem">
          Bit-field layouts from BoM <em>ERTS Data Formats</em> v1.0 (July 2003) —
          <a href="${encodeURI('docs/BOM spec erts_data_formats_doc.pdf')}" target="_blank" rel="noopener">specification PDF</a>.
          Station names from <a href="${encodeURI('data/All 2021 Working 2.txt')}" target="_blank" rel="noopener">All 2021 Working 2.txt</a>.
          <span id="pkt-stnStatus" class="small"></span>
        </p>
      </div>

    </div>`;
  }

  function init() {
    refreshStation();
    updateStnStatus();
    loadStationsFile();   // no-op if already loaded/loading
    replay();             // restore any previous decode/encode results
  }

  return { render, init, decode, encode, loadExample, onFormatChange, setEnc, copyTxt, prefillEncoder,
           decodeMessage, stationName };
})();

// ── NETWORK MAPS tab (Network Maps Navigator) ───────────────────────────────────
//
// Ports the legacy "ALERT Map Launcher v2.html" into MegaNet: a Queensland
// drainage-basin map with clickable regions, region/subregion/file navigation
// and an embedded PDF/image viewer. Adds station-aware search — type a station
// name, ALERT ID or site number and the tool suggests the relevant map(s).
//
// Data (catalogue, basin SVG, georeference) comes from maps-data.js, exposed as
// window.MegaNetMaps and loaded before this script.

const Maps = (function () {
  const MD = (typeof window !== 'undefined' && window.MegaNetMaps) || null;

  // Region fill palette (applied to basin polygons; readable on both themes).
  const REGION_COLOR = {
    'Far North':             '#2a9d8f',
    'Mackay / Whitsundays':  '#e76f51',
    'Burdekin / Townsville': '#457b9d',
    'Central QLD':           '#e9a92c',
    'Wide Bay / Burnett':    '#6aa84f',
    'SE QLD':                '#9b5de5',
    'West / South West':     '#d98b3a',
    'NSW Border':            '#8d99ae',
  };

  const mstate = {
    region:    localStorage.getItem('mn-maps-region') || 'All files',
    subregion: localStorage.getItem('mn-maps-sub')    || '_all',
    file:      localStorage.getItem('mn-maps-file')   || '',
    query:     '',
    basins:    null,   // [{name, region, pts:[[x,y],...]}]  parsed once
  };

  // ── catalogue helpers ─────────────────────────────────────────────────────────
  function regions()            { return MD ? MD.REGION_ORDER : ['All files']; }
  function subregions(region)   { return region === 'All files' ? [] : Object.keys((MD && MD.MAP_CATALOG[region]) || {}); }
  function regionFiles(region)  {
    if (!MD) return [];
    if (region === 'All files') return allFiles();
    return Object.values(MD.MAP_CATALOG[region] || {}).flat();
  }
  function allFiles() {
    if (!MD) return [];
    const seen = new Set();
    for (const r of MD.REGION_ORDER) {
      if (r === 'All files') continue;
      for (const f of regionFiles(r)) seen.add(f);
    }
    return [...seen];
  }
  function fileRegion(file) {
    if (!MD) return null;
    for (const r of MD.REGION_ORDER) {
      if (r === 'All files') continue;
      if (regionFiles(r).includes(file)) return r;
    }
    return null;
  }
  function fileSubregion(file) {
    if (!MD) return null;
    for (const r of MD.REGION_ORDER) {
      const groups = (MD.MAP_CATALOG[r]) || {};
      for (const [sub, files] of Object.entries(groups)) if (files.includes(file)) return sub;
    }
    return null;
  }
  function basinRegion(basinName) {
    if (!MD) return null;
    const slug = slugBasin(basinName);
    for (const [region, list] of Object.entries(MD.REGION_BASINS)) {
      if (list.some(b => slugBasin(b) === slug)) return region;
    }
    return null;
  }
  function slugBasin(v) {
    return String(v).toLowerCase().replace(/&apos;|&#39;/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // ── files currently in view (region/subregion + text filter) ──────────────────
  function rawFiles() {
    if (mstate.region === 'All files') return allFiles();
    const data = (MD && MD.MAP_CATALOG[mstate.region]) || {};
    return mstate.subregion === '_all' ? Object.values(data).flat() : (data[mstate.subregion] || []);
  }
  function fileMatchesQuery(file, q) {
    if (!q) return true;
    const info = (MD && MD.FILE_INFO[file]) || {};
    const hay = [
      file,
      fileRegion(file) || '',
      fileSubregion(file) || '',
      ...(info.catchments || []),
      ...(info.aliases || []),
      ...(info.networks || []),
    ].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(tok => hay.includes(tok));
  }
  function filteredFiles() { return rawFiles().filter(f => fileMatchesQuery(f, mstate.query)); }

  function ext(file)   { return file.split('.').pop().toUpperCase(); }
  function isImage(f)  { return /\.(png|jpe?g|gif|webp|svg)$/i.test(f); }
  // Resolve a catalogue filename to its on-disk location (files live in
  // per-region sub-folders under maps/, see maps-data.js FILE_PATH) and
  // URL-encode each path segment. Falls back to the bare name if unmapped.
  function encPath(f)  {
    const rel = (MD && MD.FILE_PATH && MD.FILE_PATH[f]) || f;
    return './' + rel.split('/').map(encodeURIComponent).join('/');
  }
  function fileTags(file) {
    const info = (MD && MD.FILE_INFO[file]) || {};
    const out = [ext(file)];
    const n = file.toLowerCase();
    if (n.includes('network to')) out.push('backbone');
    if (n.includes('old') || n.includes('blank')) out.push('legacy');
    if (n.includes('repeaters')) out.push('repeaters');
    if ((info.networks || []).length) out.push('net-linked');
    return out;
  }

  // ── station → map suggestion engine ───────────────────────────────────────────
  // Signals: (1) radio_network_id → map  [authoritative]
  //          (2) georeferenced point-in-basin → map/region  [approx ~34 km]
  //          (3) free-text keyword match against FILE_INFO
  //          (4) nearest region centroid  [coarse fallback]
  function lonLatToSvg(lon, lat) {
    const g = MD.BASIN_GEOREF;
    const det = g.ax * g.by - g.bx * g.ay;
    const x = ( g.by * (lon - g.cx) - g.bx * (lat - g.cy)) / det;
    const y = (-g.ay * (lon - g.cx) + g.ax * (lat - g.cy)) / det;
    return [x, y];
  }
  function parseBasins() {
    if (mstate.basins || !MD) return mstate.basins;
    const doc = new DOMParser().parseFromString(MD.QLD_BASIN_SVG, 'image/svg+xml');
    const out = [];
    doc.querySelectorAll('polygon').forEach(p => {
      const name = (p.querySelector('title')?.textContent || '').replace(/&apos;/g, "'");
      const pts = (p.getAttribute('points') || '').trim().split(/\s+/).map(pair => {
        const [x, y] = pair.split(',').map(Number);
        return [x, y];
      }).filter(pt => pt.length === 2 && !isNaN(pt[0]) && !isNaN(pt[1]));
      if (name && pts.length > 2) out.push({ name, region: basinRegion(name), pts });
    });
    mstate.basins = out;
    return out;
  }
  function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function basinOfStation(s) {
    if (!MD || s.lat == null || s.lon == null) return null;
    const [x, y] = lonLatToSvg(s.lon, s.lat);
    for (const b of parseBasins()) if (pointInPoly(x, y, b.pts)) return b;
    return null;
  }
  function nearestRegion(s) {
    if (!MD || s.lat == null || s.lon == null) return null;
    let best = null, bd = Infinity;
    for (const [region, c] of Object.entries(MD.REGION_CENTROIDS)) {
      const d = (c[0] - s.lat) ** 2 + (c[1] - s.lon) ** 2;
      if (d < bd) { bd = d; best = region; }
    }
    return best;
  }
  function stationTokens(s) {
    return (s.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length > 2);
  }
  function mapsForStation(s) {
    if (!MD) return [];
    const scores = {};   // file -> {score, reasons:Set}
    const add = (file, score, reason) => {
      if (!file) return;
      const e = scores[file] || (scores[file] = { score: 0, reasons: new Set() });
      e.score = Math.max(e.score, score);
      e.reasons.add(reason);
    };
    // (1) radio network
    for (const net of (s.radio_network_ids || [])) {
      for (const f of (MD.NETWORK_FILES[net] || [])) add(f, 100, 'radio network ' + net);
    }
    // (2) basin (point-in-polygon)
    const basin = basinOfStation(s);
    let region = basin ? basin.region : null;
    if (basin) {
      const bslug = slugBasin(basin.name);
      let direct = false;
      for (const [file, info] of Object.entries(MD.FILE_INFO)) {
        if ((info.catchments || []).some(c => slugBasin(c) === bslug)) { add(file, 65, 'in ' + basin.name + ' catchment'); direct = true; }
      }
      if (region && !direct) for (const f of regionFiles(region)) add(f, 42, region + ' region (approx)');
    }
    // (3) keyword match on station name tokens
    const toks = stationTokens(s);
    if (toks.length) {
      for (const [file, info] of Object.entries(MD.FILE_INFO)) {
        const kw = [...(info.aliases || []), ...(info.catchments || [])].map(k => k.toLowerCase());
        const hit = toks.find(t => kw.some(k => k.includes(t) || t.includes(k)));
        if (hit) add(file, 55, "matches “" + hit + '”');
      }
    }
    // (4) region-centroid fallback if nothing yet
    if (!Object.keys(scores).length) {
      region = region || nearestRegion(s);
      if (region) for (const f of regionFiles(region)) add(f, 25, region + ' region (approx)');
    }
    return Object.entries(scores)
      .map(([file, e]) => ({ file, score: e.score, reasons: [...e.reasons] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  // ── station text search (name / ALERT ID / site number / id) ──────────────────
  function stationHaystack(s) {
    const ids = new Set();
    const a = s.alert_ids || {};
    Object.values(a).forEach(v => (Array.isArray(v) ? v : [v]).forEach(x => x != null && ids.add(String(x))));
    (s.sensors || []).forEach(se => se.alert_id != null && ids.add(String(se.alert_id)));
    const site = s.site || {};
    return {
      text: [s.name, s.id, s.station_number, site.number, site.name].filter(Boolean).join(' ').toLowerCase(),
      ids,
    };
  }
  function matchStations(query) {
    if (!state.data || !query) return [];
    const q = query.toLowerCase().trim();
    const scored = [];
    for (const s of state.data.stations) {
      const h = stationHaystack(s);
      let score = 0;
      if (h.ids.has(q)) score = 100;                                   // exact ALERT id / number
      else if (s.name && s.name.toLowerCase() === q) score = 95;       // exact name
      else if (s.name && s.name.toLowerCase().startsWith(q)) score = 80;
      else if (h.text.includes(q)) score = 60;
      else if ([...h.ids].some(id => id.includes(q)) && q.length >= 2) score = 40;
      if (score) scored.push({ s, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name)).slice(0, 8);
  }

  // ── rendering ─────────────────────────────────────────────────────────────────
  function render() {
    if (!MD) {
      return `<div class="layout"><div class="panel"><h2 style="margin-top:0">Network Maps</h2>
        <p class="warn-text">Map data module failed to load (<code>maps-data.js</code>). Check that it is present and loaded before <code>app.js</code>.</p></div></div>`;
    }
    return `
    <div class="maps-layout">
      <aside class="maps-left stack">
        <div class="panel">
          <div class="panel-header"><h3 style="margin:0">Find a map</h3>
            <span class="small" id="maps-total"></span></div>
          <div style="margin-top:.6rem">
            <input type="search" id="maps-search" placeholder="Map, catchment, town — or station name / ALERT ID…"
                   value="${esc(mstate.query)}" oninput="Maps.onSearch(this.value)">
          </div>
          <div class="small" style="margin-top:.4rem;color:var(--muted)">
            Browse by region below, or search a station (name, ALERT ID, site number) to get suggested maps.</div>
          <div id="maps-suggest"></div>
        </div>

        <div class="panel">
          <div class="panel-header"><h3 style="margin:0">Queensland basins</h3>
            <button class="maps-reset" onclick="Maps.setRegion('All files')" title="Show all regions">Reset</button></div>
          <div id="maps-basin" class="maps-basin"></div>
          <div id="maps-region-chips" class="maps-chips" style="margin-top:.6rem"></div>
        </div>

        <div class="panel">
          <div id="maps-subregion-chips" class="maps-chips"></div>
          <div class="panel-header" style="margin-top:.5rem">
            <strong id="maps-list-title"></strong>
            <span class="small" id="maps-list-count"></span></div>
          <ul id="maps-file-list" class="maps-file-list"></ul>
        </div>
      </aside>

      <div class="panel maps-viewer-panel">
        <div class="maps-viewer-toolbar">
          <div style="min-width:0">
            <strong id="maps-current-file" style="display:block">No map open</strong>
            <span class="small" id="maps-current-path" style="word-break:break-all"></span>
          </div>
          <div class="button-row" style="flex-wrap:nowrap">
            <button onclick="Maps.step(-1)" title="Previous map">‹ Prev</button>
            <button onclick="Maps.step(1)" title="Next map">Next ›</button>
            <a id="maps-newtab" class="maps-newtab" target="_blank" rel="noopener">Open in new tab ↗</a>
          </div>
        </div>
        <div id="maps-viewer" class="maps-viewer">
          <div class="maps-empty">Select a map from the list, or search for a station to get a suggestion.</div>
        </div>
      </div>
    </div>`;
  }

  function init() {
    if (!MD) return;
    injectBasinMap();
    renderRegionChips();
    renderSubregionChips();
    renderList();
    renderSuggestions();
    updateTotal();
    if (mstate.file && allFiles().includes(mstate.file)) openFile(mstate.file, false);
  }

  function updateTotal() {
    const el = document.getElementById('maps-total');
    if (el) el.textContent = allFiles().length + ' maps';
  }

  function injectBasinMap() {
    const host = document.getElementById('maps-basin');
    if (!host) return;
    host.innerHTML = MD.QLD_BASIN_SVG;
    const svg = host.querySelector('svg');
    if (!svg) return;
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.classList.add('maps-basin-svg');
    svg.querySelector('rect')?.remove();                     // drop the white backdrop
    svg.querySelectorAll('polygon').forEach(p => {
      const name = (p.querySelector('title')?.textContent || '').replace(/&apos;/g, "'");
      const region = basinRegion(name);
      p.dataset.region = region || '';
      p.dataset.basin = name;
      const col = region ? REGION_COLOR[region] : null;
      p.style.fill = col || 'var(--muted)';
      p.style.fillOpacity = region ? '0.32' : '0.06';
      p.style.stroke = col || 'var(--border)';
      p.style.strokeOpacity = '0.85';
      p.style.cursor = region ? 'pointer' : 'default';
      if (region) {
        p.addEventListener('click', () => setRegion(region));
        p.addEventListener('mouseenter', () => { p.style.fillOpacity = '0.6'; });
        p.addEventListener('mouseleave', () => applyRegionHighlight());
      }
    });
    applyRegionHighlight();
  }

  function applyRegionHighlight() {
    const host = document.getElementById('maps-basin');
    if (!host) return;
    const active = mstate.region;
    host.querySelectorAll('polygon').forEach(p => {
      const region = p.dataset.region;
      if (!region) return;
      const on = active === 'All files' || region === active;
      p.style.fillOpacity = on ? (active !== 'All files' && region === active ? '0.62' : '0.32') : '0.08';
      p.style.strokeOpacity = on ? '0.9' : '0.3';
    });
  }

  function renderRegionChips() {
    const el = document.getElementById('maps-region-chips');
    if (!el) return;
    el.innerHTML = regions().map(r => {
      const count = r === 'All files' ? allFiles().length : regionFiles(r).length;
      const hint = (MD.REGION_HINTS[r]) ? `<span class="maps-chip-hint">${esc(MD.REGION_HINTS[r])}</span>` : '';
      const dot = r !== 'All files' && REGION_COLOR[r]
        ? `<span class="maps-chip-dot" style="background:${REGION_COLOR[r]}"></span>` : '';
      return `<button class="maps-chip${r === mstate.region ? ' active' : ''}" onclick="Maps.setRegion('${escAttr(r)}')">
        ${dot}${esc(r)}<span class="maps-count">${count}</span>${hint}</button>`;
    }).join('');
  }

  function renderSubregionChips() {
    const el = document.getElementById('maps-subregion-chips');
    if (!el) return;
    const subs = subregions(mstate.region);
    if (!subs.length) { el.innerHTML = ''; return; }
    let html = `<button class="maps-chip${mstate.subregion === '_all' ? ' active' : ''}" onclick="Maps.setSubregion('_all')">All in region</button>`;
    html += subs.map(sub =>
      `<button class="maps-chip${mstate.subregion === sub ? ' active' : ''}" onclick="Maps.setSubregion('${escAttr(sub)}')">
        ${esc(sub)}<span class="maps-count">${(MD.MAP_CATALOG[mstate.region][sub] || []).length}</span></button>`
    ).join('');
    el.innerHTML = html;
  }

  function renderList() {
    const el = document.getElementById('maps-file-list');
    const titleEl = document.getElementById('maps-list-title');
    const countEl = document.getElementById('maps-list-count');
    if (!el) return;
    const files = filteredFiles();
    if (titleEl) titleEl.textContent = mstate.region + (mstate.subregion !== '_all' ? ' · ' + mstate.subregion : '');
    if (countEl) countEl.textContent = `${files.length} / ${rawFiles().length}`;
    if (!files.length) {
      el.innerHTML = `<li class="maps-file"><div class="maps-file-name small">No maps match “${esc(mstate.query)}”.</div></li>`;
      return;
    }
    el.innerHTML = files.map(f => {
      const badges = fileTags(f).map(t => `<span class="badge maps-badge">${esc(t)}</span>`).join('');
      return `<li class="maps-file${f === mstate.file ? ' selected' : ''}">
        <div style="min-width:0">
          <div class="maps-file-name">${esc(f)}</div>
          <div class="maps-badges">${badges}</div>
        </div>
        <div class="maps-file-actions">
          <button onclick="Maps.openFile('${escAttr(f)}')">Open</button>
          <a class="maps-newtab" href="${encPath(f)}" target="_blank" rel="noopener">↗</a>
        </div></li>`;
    }).join('');
  }

  function renderSuggestions() {
    const el = document.getElementById('maps-suggest');
    if (!el) return;
    const q = mstate.query.trim();
    if (!q) { el.innerHTML = ''; return; }
    if (!state.data) {
      el.innerHTML = `<div class="maps-suggest-note small">Load <strong>stations.json</strong> to search by station name / ALERT ID.</div>`;
      return;
    }
    const matches = matchStations(q);
    if (!matches.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="maps-suggest-note small">Stations matching “${esc(q)}” → suggested maps:</div>` +
      matches.map(({ s }) => {
        const maps = mapsForStation(s);
        const aid = [...stationHaystack(s).ids].slice(0, 4).join(', ');
        const chips = maps.length
          ? maps.map(m => `<button class="maps-suggest-map" title="${escAttr(m.reasons.join('; '))}" onclick="Maps.openFile('${escAttr(m.file)}')">${esc(m.file)}</button>`).join('')
          : `<span class="small" style="color:var(--muted)">no map match — try browsing the region</span>`;
        return `<div class="maps-suggest-item">
          <div class="maps-suggest-station">${esc(s.name)}
            ${aid ? `<span class="small" style="color:var(--muted)">· ALERT ${esc(aid)}</span>` : ''}</div>
          <div class="maps-suggest-maps">${chips}</div>
        </div>`;
      }).join('');
  }

  // ── actions ───────────────────────────────────────────────────────────────────
  function setRegion(region) {
    mstate.region = region;
    mstate.subregion = '_all';
    localStorage.setItem('mn-maps-region', region);
    localStorage.setItem('mn-maps-sub', '_all');
    renderRegionChips(); renderSubregionChips(); renderList(); applyRegionHighlight();
  }
  function setSubregion(sub) {
    mstate.subregion = sub;
    localStorage.setItem('mn-maps-sub', sub);
    renderSubregionChips(); renderList();
  }
  function onSearch(v) {
    mstate.query = v;
    renderList(); renderSuggestions();
  }
  // A4/A3 (and every ISO A-series) page shares a 1:√2 ratio — used as the
  // viewer's default shape until a file's real page size is known.
  const A4_RATIO = 1 / Math.SQRT2;
  const pdfAspectCache = new Map(); // file -> width/height ratio (or null if undetectable)

  function setViewerAspect(ratio) {
    const host = document.getElementById('maps-viewer');
    if (!host) return;
    if (ratio && isFinite(ratio) && ratio > 0) host.style.setProperty('--maps-aspect', String(ratio));
    else host.style.removeProperty('--maps-aspect');
  }

  // Reads just enough of the PDF to find its first /MediaBox (and any
  // /Rotate) so the viewer can be sized to the map's real page proportions
  // instead of a guessed default.
  async function loadPdfAspect(file, path) {
    if (pdfAspectCache.has(file)) return;
    try {
      const res = await fetch(path);
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('latin1').decode(buf);
      const m = text.match(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/);
      let ratio = null;
      if (m) {
        let w = Math.abs(parseFloat(m[3]) - parseFloat(m[1]));
        let h = Math.abs(parseFloat(m[4]) - parseFloat(m[2]));
        const rot = text.match(/\/Rotate\s+(-?\d+)/);
        if (rot) {
          const deg = ((parseInt(rot[1], 10) % 360) + 360) % 360;
          if (deg === 90 || deg === 270) [w, h] = [h, w];
        }
        if (w > 0 && h > 0) ratio = w / h;
      }
      pdfAspectCache.set(file, ratio);
      if (mstate.file === file) setViewerAspect(ratio || A4_RATIO);
    } catch (e) {
      // Fetch/parse failure: the A4 fallback aspect ratio already applied stands.
    }
  }

  function openFile(file, scroll = true) {
    mstate.file = file;
    localStorage.setItem('mn-maps-file', file);
    const host = document.getElementById('maps-viewer');
    const nameEl = document.getElementById('maps-current-file');
    const pathEl = document.getElementById('maps-current-path');
    const linkEl = document.getElementById('maps-newtab');
    const path = encPath(file);
    if (nameEl) nameEl.textContent = file;
    if (pathEl) pathEl.textContent = path;
    if (linkEl) linkEl.href = path;
    if (host) {
      if (isImage(file)) {
        host.innerHTML = `<img class="maps-view-img" alt="${escAttr(file)}" src="${path}">`;
        setViewerAspect(null);
        const img = host.querySelector('img');
        if (img) img.addEventListener('load', () => {
          if (mstate.file === file && img.naturalWidth && img.naturalHeight) {
            setViewerAspect(img.naturalWidth / img.naturalHeight);
          }
        }, { once: true });
      } else {
        host.innerHTML = `<iframe class="maps-view-frame" src="${path}#view=FitH" title="${escAttr(file)}"></iframe>`;
        setViewerAspect(pdfAspectCache.get(file) || A4_RATIO);
        loadPdfAspect(file, path);
      }
    }
    renderList();
    if (scroll && host) host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function step(delta) {
    const files = filteredFiles();
    if (!files.length) return;
    const i = Math.max(0, files.indexOf(mstate.file));
    openFile(files[(i + delta + files.length) % files.length]);
  }

  return { render, init, setRegion, setSubregion, onSearch, openFile, step };
})();

// ── SERIAL MONITOR tab ──────────────────────────────────────────────────────────
//
// Connect physical serial devices to the browser's COM ports (Web Serial API) and
// stream their output live. Multiple ports can be open at once, each with its own
// settings (baud rate, data/stop bits, parity, flow control) and its own display
// mode:
//   • text  — bytes decoded as UTF-8/ASCII and split into lines on CR/LF
//   • hex   — raw bytes as a hex + ASCII dump, for inspecting binary framing
//   • alert — every 4 bytes decoded as a 32-bit ALERT payload (ABF/BCC/EAF/EIF)
//             via the shared Packets codec and cross-referenced to the station DB
//
// Web Serial needs a Chromium browser (Chrome/Edge/Opera) served from a secure
// context (https or localhost). Live connection objects hold non-serialisable
// streams, so they live in this module's `conns` array — not in global `state` —
// and survive tab switches (reads continue in the background); the DOM is rebuilt
// from each connection's capped entry buffer whenever the tab is shown again.

const Serial = (function () {
  const MAX_ENTRIES = 1000;                    // per-connection scrollback cap
  const BAUD_RATES  = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400];
  const DEFAULTS_KEY = 'mn-serial-defaults';

  const conns = [];          // live connection objects (module-scoped, not serialised)
  let nextId = 1;
  let disconnectHooked = false;
  let knownPorts = [];       // ports the browser has already granted us (getPorts)

  const supported = typeof navigator !== 'undefined' && 'serial' in navigator;

  // Bumped whenever the Serial Monitor changes. Shown in the tab header so it is
  // possible to confirm at a glance which build of app.js the browser actually
  // loaded — a stale, cached app.js is the usual reason a "fixed" bug persists.
  const SERIAL_BUILD = '2026-07-16e';

  function loadDefaults() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || '{}'); } catch (_) {}
    return {
      baudRate:    d.baudRate    || 9600,
      dataBits:    d.dataBits    || 8,
      stopBits:    d.stopBits    || 1,
      parity:      d.parity      || 'none',
      flowControl: d.flowControl || 'none',
      mode:        d.mode        || 'text',
    };
  }
  function saveDefaults(conn) {
    const d = Object.assign({}, conn.settings, { mode: conn.mode });
    try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d)); } catch (_) {}
  }

  function byId(id) { return conns.find(c => c.id === id); }

  // ── connection lifecycle ──────────────────────────────────────────────────────
  function addConnection() {
    const d = loadDefaults();
    const conn = {
      id: 'c' + (nextId++),
      name: 'Connection ' + (conns.length + 1),
      phase: 'setup',                    // setup | open | closed | error
      port: null,
      portLabel: '',
      settings: { baudRate: d.baudRate, dataBits: d.dataBits, stopBits: d.stopBits,
                  parity: d.parity, flowControl: d.flowControl },
      mode: d.mode,
      entries: [],                       // {ts, cls, body(html), raw(text)}
      bytes: 0,
      count: 0,                          // lines (text) / rows (hex) / frames (alert)
      openedAt: null,
      paused: false,
      autoscroll: true,
      timestamps: true,
      err: null,
      // per-mode framing buffers
      decoder: null,
      textBuf: '',
      hexBuf: [],
      hexOffset: 0,
      alertBuf: [],
      reader: null,
      writer: null,
      keepReading: false,
      readLoopPromise: null,
      flushTimer: null,
      statsPending: false,
    };
    conns.push(conn);
    renderList();
    // reveal the freshly added card
    const el = document.getElementById('ser-card-' + conn.id);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Write a short status line beneath the "Choose COM port…" button. Colour is
  // set inline so the message is legible regardless of the stylesheet.
  function setPortStatus(conn, msg, kind) {
    const el = document.getElementById('ser-port-status-' + conn.id);
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'err' ? '#c7401a' : kind === 'warn' ? '#b26a00' : '';
  }

  // requestPort() rejects with the SAME NotFoundError whether the user cancelled
  // the picker or the browser refused to show a picker at all (enterprise policy
  // on a managed computer, kiosk/headless build, chooser UI unavailable). The one
  // observable difference is time: a human needs well over this many milliseconds
  // to see and dismiss a dialog, while a suppressed picker rejects almost
  // instantly after the call.
  const PICKER_INSTANT_MS = 350;

  async function choosePort(id) {
    const conn = byId(id);
    if (!conn) return;
    // The port picker can never look like a dead click: every path below either
    // opens the browser chooser, updates the UI, or leaves a visible message.
    console.log('[Serial] choosePort() invoked for', id, '(build ' + SERIAL_BUILD + ')');
    if (!supported) {
      alert('Web Serial isn’t available in this browser.\n\n'
        + 'Use a Chromium-based browser — Chrome, Edge or Opera — served over https or from localhost.');
      return;
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      alert('Choosing a COM port needs a secure context (https or localhost).\n\n'
        + 'This page is being served insecurely, so the browser blocks access to serial ports.');
      return;
    }
    if (!navigator.serial || typeof navigator.serial.requestPort !== 'function') {
      const m = 'navigator.serial.requestPort is unavailable, so no COM-port picker can be shown.';
      setPortStatus(conn, m, 'err');
      alert(m);
      return;
    }
    // Definite Permissions-Policy block: the picker would be refused before it is
    // even requested — typically because this page is embedded in an <iframe>
    // without allow="serial" (a portal, SharePoint or Teams wrapper page).
    try {
      const fp = document.featurePolicy;
      if (fp && fp.features && fp.features().includes('serial') && !fp.allowsFeature('serial')) {
        setPortStatus(conn, (window.self !== window.top)
          ? 'Serial access is blocked because this page is embedded inside another page. '
            + 'Open the app in its own browser tab and try again.'
          : 'Serial access is disabled for this page by a Permissions-Policy.', 'err');
        return;
      }
    } catch (_) { /* diagnostic only — never blocks the real attempt */ }
    // Proof the handler ran, shown before the (blocking) native chooser opens.
    setPortStatus(conn, 'Opening the browser’s serial-port picker…', '');
    const t0 = Date.now();
    try {
      const port = await navigator.serial.requestPort();
      conn.port = port;
      conn.portLabel = portLabel(port);
      conn.err = null;
      hookDisconnect();
      await refreshKnownPorts();
      renderList();
    } catch (e) {
      const ms = Date.now() - t0;
      console.warn('[Serial] requestPort failed after ' + ms + ' ms:', e && e.name, '-', e && e.message);
      if (e && e.name === 'NotFoundError' && ms < PICKER_INSTANT_MS) {
        // Rejected faster than any human could close a dialog: the browser never
        // showed the picker. On managed (work) computers this is nearly always an
        // enterprise policy blocking Web Serial. Ports pre-approved by IT policy
        // still surface via getPorts(), so refresh the "Previously allowed" list
        // before showing the advice.
        await refreshKnownPorts();
        renderList();
        showBlockedPickerHelp(conn);
        return;
      }
      // Slow NotFoundError = the picker really opened and no port was chosen
      // (dismissed, or the device list was empty).
      if (e && e.name === 'NotFoundError') {
        setPortStatus(conn, 'No port selected. Click “Choose COM port…” again and pick your device. '
          + 'If the list is empty, the browser can’t see a serial device: check the USB cable/driver, and '
          + 'that no other program or browser tab already has the COM port open.', 'warn');
        return;
      }
      if (e && e.name === 'SecurityError') {
        setPortStatus(conn, 'The browser blocked the request: ' + ((e && e.message) || 'SecurityError')
          + ' — if this page is embedded inside another page or portal, open it in its own tab; '
          + 'otherwise check the padlock menu → Site settings → Serial ports.', 'err');
        return;
      }
      setPortStatus(conn, 'Could not select a COM port: ' + ((e && e.message) || e), 'err');
      alert('Could not select a COM port: ' + ((e && e.message) || e) + '\n\n'
        + 'If no port picker appeared, check that serial access is allowed for this site.');
    }
  }

  // Written into the status line when requestPort() rejected instantly, i.e. the
  // chooser was suppressed rather than cancelled. All markup here is our own —
  // the only dynamic value is the count of policy-granted ports.
  function showBlockedPickerHelp(conn) {
    const el = document.getElementById('ser-port-status-' + conn.id);
    if (!el) return;
    // The advice is long: let the port cell span the whole form row so it does
    // not squeeze into (and collide with) the narrow settings columns. The next
    // renderList() rebuilds the DOM and resets this automatically.
    const cell = el.closest ? el.closest('.ser-f-port') : null;
    if (cell) cell.style.gridColumn = '1 / -1';
    const isEdge = /Edg\//.test(navigator.userAgent);
    const policyPage = isEdge ? 'edge://policy' : 'chrome://policy';
    const granted = knownPorts.length
      ? '<p style="margin:.35rem 0 0"><strong>' + knownPorts.length + ' pre-approved port'
        + (knownPorts.length > 1 ? 's are' : ' is') + ' available</strong> under “Previously allowed” '
        + 'above — use that button instead of the picker.</p>'
      : '';
    el.style.color = '#c7401a';
    el.innerHTML =
        '<strong>The browser refused to show the port picker.</strong> It rejected the request instantly, '
      + 'so no dialog was ever displayed — this is a browser or IT-policy block, not an empty device list. '
      + '(If you did see a picker and closed it, ignore this and just click the button again.)'
      + granted
      + '<ol style="margin:.35rem 0 0 1.1rem;padding:0">'
      + '<li>Open <code>' + policyPage + '</code> and search for <code>serial</code>. '
      +   '<code>DefaultSerialGuardSetting = 2</code>, or this site listed under <code>SerialBlockedForUrls</code>, '
      +   'means your organisation blocks Web Serial — IT must add this site to <code>SerialAskForUrls</code>.</li>'
      + '<li>Click the padlock by the address bar → <em>Site settings</em> → <em>Serial ports</em> → set to '
      +   '<em>Ask</em>. If the control is greyed out, it is locked by IT policy.</li>'
      + '<li>IT can instead pre-approve the device itself (<code>SerialAllowUsbDevicesForUrls</code> or '
      +   '<code>SerialAllowAllPortsForUrls</code>) — pre-approved ports appear here under “Previously allowed” '
      +   'and need no picker at all. A ready-to-send request for IT is in '
      +   '<a href="docs/serial-help.html" target="_blank" rel="noopener">the serial access guide</a>.</li>'
      + '<li>Try the other browser — if Chrome is blocked, Edge often isn’t (and vice-versa).</li>'
      + '</ol>';
  }

  // Ports the browser has already granted us in a previous pick (persist across
  // reloads). Surfacing them lets the user reconnect a known device with one
  // click instead of fighting the picker, and is a live check of what the
  // browser can actually see.
  async function refreshKnownPorts() {
    try {
      knownPorts = (navigator.serial && navigator.serial.getPorts)
        ? await navigator.serial.getPorts() : [];
    } catch (_) { knownPorts = []; }
  }

  // Attach a previously-granted port (from the "Previously allowed" list) to a
  // connection without going through the picker.
  function useKnownPort(id, index) {
    const conn = byId(id);
    if (!conn) return;
    const port = knownPorts[index];
    if (!port) return;
    conn.port = port;
    conn.portLabel = portLabel(port);
    conn.err = null;
    hookDisconnect();
    renderList();
  }

  function portLabel(port) {
    try {
      const info = port.getInfo ? port.getInfo() : {};
      if (info && info.usbVendorId != null) {
        const v = info.usbVendorId.toString(16).padStart(4, '0');
        const p = (info.usbProductId != null ? info.usbProductId : 0).toString(16).padStart(4, '0');
        return 'USB serial (VID:PID ' + v + ':' + p + ')';
      }
    } catch (_) {}
    return 'Serial port';
  }

  // Translate a port.open() DOMException into a plain-English cause + remedy.
  // The raw messages ("Failed to open serial port.") tell the user nothing.
  function describeOpenError(e) {
    const name = e && e.name;
    const msg  = (e && e.message) || String(e);
    if (name === 'InvalidStateError')
      return 'The port is already open. Close it in the other browser tab or program that has it, then try again.';
    if (name === 'NotFoundError')
      return 'The device is no longer connected. Re-plug it, click “Change…”, pick it again, then Open.';
    if (name === 'SecurityError')
      return 'Serial access was blocked. Click “Change…” and pick the port again to re-grant permission, then Open.';
    if (name === 'NetworkError' || /failed to open|access is denied|access denied/i.test(msg))
      return 'The operating system refused to open the COM port. It is almost always still held by another '
        + 'program — a terminal (PuTTY/RealTerm), a logger, or this Serial Monitor in another tab. '
        + 'Close whatever else has the port open and try again.';
    return msg;
  }

  async function openConn(id) {
    const conn = byId(id);
    if (!conn) return;
    if (!conn.port) { alert('Choose a COM port first.'); return; }
    const s = conn.settings;
    const baudRate = +s.baudRate || 0;
    if (baudRate < 1) {
      conn.phase = 'setup';
      conn.err = 'Baud rate must be a positive number (e.g. 9600).';
      renderList();
      return;
    }
    // Always start from a clean slate. If a stale handle to this port is still
    // open — from a previous session, or a device that dropped without being
    // closed — a fresh open() would throw "The port is already open". Release it
    // first so re-opening (and re-plug → Reopen) reliably works.
    await teardown(conn);
    try {
      await conn.port.open({
        baudRate:    baudRate,
        dataBits:    +s.dataBits || 8,
        stopBits:    +s.stopBits || 1,
        parity:      s.parity || 'none',
        flowControl: s.flowControl || 'none',
        bufferSize:  4096,
      });
    } catch (e) {
      // keep the setup form up so the user can adjust settings and retry
      console.warn('[Serial] open failed:', e && e.name, '-', e && e.message);
      conn.phase = 'setup';
      conn.err = describeOpenError(e);
      renderList();
      return;
    }
    // reset framing buffers for a clean session
    conn.decoder   = new TextDecoder();
    conn.textBuf   = '';
    conn.hexBuf    = [];
    conn.hexOffset = 0;
    conn.alertBuf  = [];
    conn.phase     = 'open';
    conn.err       = null;
    conn.openedAt  = Date.now();
    conn.keepReading = true;
    saveDefaults(conn);
    emitSys(conn, 'Opened ' + conn.portLabel + ' @ ' + conn.settings.baudRate + ' baud, '
      + conn.settings.dataBits + fmtParity(conn.settings.parity) + conn.settings.stopBits
      + ', flow ' + conn.settings.flowControl + ' — mode: ' + MODE_LABEL[conn.mode], 'sys');
    conn.readLoopPromise = readLoop(conn);
    renderList();
  }

  function fmtParity(p) { return p === 'none' ? 'N' : p === 'even' ? 'E' : 'O'; }

  async function readLoop(conn) {
    while (conn.port && conn.port.readable && conn.keepReading) {
      const reader = conn.port.readable.getReader();
      conn.reader = reader;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) handleChunk(conn, value);
        }
      } catch (e) {
        emitSys(conn, 'Read error: ' + e.message, 'err');
      } finally {
        try { reader.releaseLock(); } catch (_) {}
        conn.reader = null;
      }
    }
    // loop exited: if we didn't ask to stop, the device went away
    if (conn.keepReading) {
      conn.keepReading = false;
      conn.phase = 'error';
      conn.err = 'Device disconnected';
      emitSys(conn, 'Device disconnected', 'err');
      flushPartials(conn);
      renderList();
    }
  }

  // Stop reading and release the OS port handle. Best-effort: every step is
  // guarded so it is safe to call in any state (never opened, open, or already
  // dropped). Used both by Close and as the clean-slate step before (re)opening.
  async function teardown(conn) {
    conn.keepReading = false;
    try { if (conn.reader) await conn.reader.cancel(); } catch (_) {}
    try { if (conn.readLoopPromise) await conn.readLoopPromise; } catch (_) {}
    conn.readLoopPromise = null;
    conn.reader = null;
    try { if (conn.writer) await conn.writer.close().catch(() => {}); } catch (_) {}
    conn.writer = null;
    // Only close if the port is actually open; closing a never-opened port
    // throws, and we want teardown to be a safe no-op in that case.
    try {
      if (conn.port && (conn.port.readable || conn.port.writable)) await conn.port.close();
    } catch (_) {}
  }

  async function closeConn(id, opts) {
    const conn = byId(id);
    if (!conn) return;
    await teardown(conn);
    flushPartials(conn);
    conn.phase = 'closed';
    emitSys(conn, 'Port closed', 'sys');
    if (!(opts && opts.silent)) renderList();
  }

  async function removeConn(id) {
    const conn = byId(id);
    if (!conn) return;
    if (conn.phase === 'open') await closeConn(id, { silent: true });
    const i = conns.indexOf(conn);
    if (i >= 0) conns.splice(i, 1);
    renderList();
  }

  function reopenConn(id) {
    const conn = byId(id);
    if (!conn) return;
    // reset counters for the new session; keep the scrollback
    conn.bytes = 0; conn.count = 0;
    openConn(id);
  }

  // ── incoming data handling ────────────────────────────────────────────────────
  function handleChunk(conn, u8) {
    conn.bytes += u8.length;
    if      (conn.mode === 'text')  handleText(conn, u8);
    else if (conn.mode === 'hex')   handleHex(conn, u8);
    else if (conn.mode === 'alert') handleAlert(conn, u8);
    scheduleStats(conn);
  }

  function handleText(conn, u8) {
    conn.textBuf += conn.decoder.decode(u8, { stream: true });
    let m;
    // split on CRLF, LF or lone CR
    while ((m = conn.textBuf.search(/\r\n|\r|\n/)) >= 0) {
      const line = conn.textBuf.slice(0, m);
      conn.textBuf = conn.textBuf.slice(m + (conn.textBuf.substr(m, 2) === '\r\n' ? 2 : 1));
      conn.count++;
      emit(conn, { ts: Date.now(), cls: 'rx', body: esc(line) || '&nbsp;', raw: line });
    }
    // don't let a newline-less stream buffer forever
    if (conn.textBuf.length > 8192) {
      conn.count++;
      emit(conn, { ts: Date.now(), cls: 'rx', body: esc(conn.textBuf), raw: conn.textBuf });
      conn.textBuf = '';
    }
  }

  function handleHex(conn, u8) {
    for (const b of u8) conn.hexBuf.push(b);
    while (conn.hexBuf.length >= 16) emitHexRow(conn, conn.hexBuf.splice(0, 16));
    scheduleFlush(conn);
  }

  function emitHexRow(conn, bytes) {
    const off = conn.hexOffset; conn.hexOffset += bytes.length;
    conn.count++;
    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = bytes.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    const offStr = off.toString(16).padStart(6, '0');
    const body = '<span class="ser-hex-off">' + offStr + '</span>'
      + '<span class="ser-hex-bytes">' + esc(hex) + '</span>'
      + '<span class="ser-hex-ascii">' + esc(ascii) + '</span>';
    emit(conn, { ts: Date.now(), cls: 'hex', body, raw: offStr + '  ' + hex + '  ' + ascii });
  }

  function handleAlert(conn, u8) {
    for (const b of u8) conn.alertBuf.push(b);
    while (conn.alertBuf.length >= 4) emitAlertFrame(conn, conn.alertBuf.splice(0, 4));
  }

  function emitAlertFrame(conn, bytes) {
    conn.count++;
    const hex = '0x' + bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const dec = Packets.decodeMessage(hex);
    let body, raw;
    if (dec.ok && dec.best) {
      const r = dec.results.find(x => x.format === dec.best);
      const st = Packets.stationName(r.values.A);
      const val = r.values.D !== undefined ? ' <span class="ser-alert-val">val ' + r.values.D + '</span>' : '';
      body = '<span class="ser-alert-hex">' + hex + '</span> '
        + '<span class="ser-badge ok">' + r.format.toUpperCase() + '</span> '
        + '<span class="ser-alert-id">ID ' + r.values.A + '</span>' + val + ' '
        + '<span class="ser-alert-stn' + (st.none ? ' none' : '') + '">' + esc(st.text) + '</span>'
        + ' <a class="ser-link" onclick="Serial.openInPackets(\'' + hex + '\')">details ▸</a>';
      raw = hex + '  ' + r.format.toUpperCase() + '  ID ' + r.values.A
        + (r.values.D !== undefined ? '  val ' + r.values.D : '') + '  ' + st.text;
    } else {
      body = '<span class="ser-alert-hex">' + hex + '</span> '
        + '<span class="ser-badge bad">no ALERT match</span>'
        + ' <a class="ser-link" onclick="Serial.openInPackets(\'' + hex + '\')">inspect ▸</a>';
      raw = hex + '  no ALERT match';
    }
    emit(conn, { ts: Date.now(), cls: 'alert', body, raw });
  }

  function scheduleFlush(conn) {
    if (conn.flushTimer) return;
    conn.flushTimer = setTimeout(() => { conn.flushTimer = null; flushPartials(conn); }, 300);
  }

  // Emit whatever bytes/text are held mid-frame — on idle, close or disconnect —
  // so slow trickle output isn't stuck waiting for a full row/line/frame.
  function flushPartials(conn) {
    if (conn.hexBuf && conn.hexBuf.length) emitHexRow(conn, conn.hexBuf.splice(0, conn.hexBuf.length));
    if (conn.textBuf) {
      conn.count++;
      emit(conn, { ts: Date.now(), cls: 'rx', body: esc(conn.textBuf), raw: conn.textBuf });
      conn.textBuf = '';
    }
    scheduleStats(conn);
  }

  function resync(id) {
    const conn = byId(id);
    if (!conn) return;
    conn.alertBuf.shift();                       // drop one byte to shift frame alignment
    while (conn.alertBuf.length >= 4) emitAlertFrame(conn, conn.alertBuf.splice(0, 4));
    emitSys(conn, 'Resynced — dropped 1 byte to shift ALERT frame alignment', 'sys');
  }

  function emitSys(conn, text, cls) {
    emit(conn, { ts: Date.now(), cls: cls || 'sys', body: esc(text), raw: text, sys: true });
  }

  // ── entry buffer + surgical DOM append ────────────────────────────────────────
  function emit(conn, entry) {
    conn.entries.push(entry);
    if (conn.entries.length > MAX_ENTRIES) conn.entries.splice(0, conn.entries.length - MAX_ENTRIES);
    if (conn.paused) return;
    const log = document.getElementById('ser-log-' + conn.id);
    if (!log) return;
    log.insertAdjacentHTML('beforeend', entryHtml(conn, entry));
    while (log.children.length > MAX_ENTRIES) log.removeChild(log.firstChild);
    if (conn.autoscroll) log.scrollTop = log.scrollHeight;
  }

  function entryHtml(conn, e) {
    const ts = conn.timestamps ? '<span class="ser-ts">' + fmtTime(e.ts) + '</span>' : '';
    return '<div class="ser-line ser-' + e.cls + '">' + ts + '<span class="ser-linebody">' + e.body + '</span></div>';
  }

  function fmtTime(t) {
    const d = new Date(t);
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }

  function repaintLog(conn) {
    const log = document.getElementById('ser-log-' + conn.id);
    if (!log) return;
    log.innerHTML = conn.entries.map(e => entryHtml(conn, e)).join('');
    if (conn.autoscroll) log.scrollTop = log.scrollHeight;
  }

  function scheduleStats(conn) {
    if (conn.statsPending) return;
    conn.statsPending = true;
    requestAnimationFrame(() => { conn.statsPending = false; paintStats(conn); });
  }
  function paintStats(conn) {
    const el = document.getElementById('ser-stats-' + conn.id);
    if (!el) return;
    el.textContent = statsText(conn);
  }
  function statsText(conn) {
    const unit = conn.mode === 'alert' ? 'frames' : conn.mode === 'hex' ? 'rows' : 'lines';
    const secs = conn.openedAt ? Math.max(1, (Date.now() - conn.openedAt) / 1000) : 1;
    const rate = conn.bytes ? ' · ' + Math.round(conn.bytes / secs) + ' B/s' : '';
    return conn.bytes.toLocaleString() + ' bytes · ' + conn.count.toLocaleString() + ' ' + unit + rate;
  }

  // ── toolbar actions ───────────────────────────────────────────────────────────
  function togglePause(id) {
    const conn = byId(id);
    if (!conn) return;
    conn.paused = !conn.paused;
    if (!conn.paused) repaintLog(conn);
    renderList();
  }
  function clearLog(id) {
    const conn = byId(id);
    if (!conn) return;
    conn.entries = [];
    repaintLog(conn);
  }
  function saveLog(id) {
    const conn = byId(id);
    if (!conn) return;
    const header = '# MegaNet Serial Monitor log — ' + conn.name + ' (' + conn.portLabel + ')\n'
      + '# ' + conn.settings.baudRate + ' baud, ' + conn.settings.dataBits + fmtParity(conn.settings.parity)
      + conn.settings.stopBits + ', mode ' + conn.mode + '\n';
    const lines = conn.entries.map(e => (conn.timestamps ? fmtTime(e.ts) + '  ' : '') + e.raw).join('\n');
    dlText('serial-' + slug(conn.name) + '.log', header + lines + '\n');
  }
  function toggleFlag(id, flag, val) {
    const conn = byId(id);
    if (!conn) return;
    conn[flag] = val;
    if (flag === 'timestamps') repaintLog(conn);
    if (flag === 'autoscroll' && val) { const log = document.getElementById('ser-log-' + id); if (log) log.scrollTop = log.scrollHeight; }
  }

  async function sendData(id) {
    const conn = byId(id);
    if (!conn || conn.phase !== 'open') return;
    const inp = document.getElementById('ser-send-' + id);
    const endSel = document.getElementById('ser-send-end-' + id);
    if (!inp) return;
    const text = inp.value;
    const end = endSel ? endSel.value : 'lf';
    const suffix = end === 'lf' ? '\n' : end === 'cr' ? '\r' : end === 'crlf' ? '\r\n' : '';
    try {
      if (!conn.port.writable) throw new Error('port is not writable');
      if (!conn.writer) conn.writer = conn.port.writable.getWriter();
      await conn.writer.write(new TextEncoder().encode(text + suffix));
      emit(conn, { ts: Date.now(), cls: 'tx', body: '<span class="ser-tx-arrow">»</span> ' + esc(text), raw: '» ' + text });
      inp.value = '';
    } catch (e) {
      emitSys(conn, 'Send failed: ' + e.message, 'err');
    }
  }

  function openInPackets(hex) {
    state.pkt.decInput = hex;
    state.pkt.lastDecode = hex;
    switchTab('packets');
  }

  // ── live setting binders (keep conn state current without a re-render) ─────────
  function setName(id, val) { const c = byId(id); if (c) c.name = val; }
  function setSetting(id, key, val) {
    const c = byId(id); if (!c) return;
    c.settings[key] = (key === 'baudRate' || key === 'dataBits' || key === 'stopBits') ? (parseInt(val, 10) || 0) : val;
  }
  function setMode(id, val) {
    const c = byId(id); if (!c) return;
    c.mode = val;
    const note = document.getElementById('ser-mode-note-' + id);
    if (note) note.textContent = MODE_HINT[val];
  }

  // ── disconnect handling ───────────────────────────────────────────────────────
  function hookDisconnect() {
    if (disconnectHooked || !supported) return;
    disconnectHooked = true;
    // A device being plugged in may newly appear in getPorts(): refresh so it
    // shows in the "Previously allowed" list ready to reconnect.
    navigator.serial.addEventListener('connect', () => { refreshKnownPorts().then(renderList); });
    navigator.serial.addEventListener('disconnect', e => {
      const conn = conns.find(c => c.port === e.target);
      if (conn) {
        if (conn.phase === 'open') {
          conn.phase = 'error';
          conn.err = 'Device disconnected';
          emitSys(conn, 'Device disconnected', 'err');
        }
        // Release our handle so a later reopen (after re-plugging) succeeds
        // instead of failing with "The port is already open".
        teardown(conn).then(() => renderList());
      }
      refreshKnownPorts().then(renderList);
    });
  }

  // ── rendering ─────────────────────────────────────────────────────────────────
  const MODE_LABEL = { text: 'ASCII text', hex: 'Hex dump', alert: 'ALERT decode' };
  const MODE_HINT = {
    text:  'Bytes are decoded as UTF-8/ASCII and split into lines on CR/LF.',
    hex:   'Raw bytes shown as a hex + ASCII dump (16 bytes per row) — best for inspecting binary framing.',
    alert: 'Every 4 bytes are decoded as a 32-bit ALERT payload (ABF/BCC/EAF/EIF) and matched to the station database. Use “Resync” to shift byte alignment if frames don’t line up. ALERT2 support is planned.',
  };

  function statusBadge(conn) {
    if (conn.phase === 'open')   return '<span class="ser-badge ok">● live</span>';
    if (conn.phase === 'closed') return '<span class="ser-badge">closed</span>';
    if (conn.phase === 'error')  return '<span class="ser-badge bad">● ' + esc(conn.err || 'error') + '</span>';
    return '<span class="ser-badge warn">not opened</span>';
  }

  function opt(val, label, cur) {
    return '<option value="' + val + '"' + (String(cur) === String(val) ? ' selected' : '') + '>' + label + '</option>';
  }

  function setupBody(conn) {
    const s = conn.settings;
    const portBtn = conn.port
      ? '<span class="ser-port-ok">✓ ' + esc(conn.portLabel) + '</span> '
        + '<button class="ghost" onclick="Serial.choosePort(\'' + conn.id + '\')">Change…</button>'
      : '<button class="ghost" onclick="Serial.choosePort(\'' + conn.id + '\')">Choose COM port…</button>';
    // Ports already granted in a previous pick — one click to reconnect without
    // the picker. Shown only before a port is chosen for this connection.
    const knownHtml = (!conn.port && knownPorts.length)
      ? '<div class="ser-known" style="margin-top:.4rem;font-size:.8rem">'
        + '<span style="opacity:.7">Previously allowed:</span> '
        + knownPorts.map((p, i) => '<button class="ghost" onclick="Serial.useKnownPort(\''
            + conn.id + '\',' + i + ')">' + esc(portLabel(p)) + '</button>').join(' ')
        + '</div>'
      : '';
    return ''
      + '<div class="ser-form">'
      + '  <label class="ser-f-name">Name'
      + '    <input type="text" value="' + esc(conn.name) + '" oninput="Serial.setName(\'' + conn.id + '\',this.value)">'
      + '  </label>'
      + '  <div class="ser-f-port"><label>COM port</label><div class="ser-port-row">' + portBtn + '</div>'
      + knownHtml
      + '    <div class="ser-port-status" id="ser-port-status-' + conn.id + '" style="font-size:.8rem;margin-top:.35rem"></div></div>'
      + '  <label>Baud rate'
      + '    <input type="number" list="ser-bauds" value="' + esc(s.baudRate) + '" min="1"'
      + '           oninput="Serial.setSetting(\'' + conn.id + '\',\'baudRate\',this.value)">'
      + '  </label>'
      + '  <label>Data bits'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'dataBits\',this.value)">'
      +        opt(8, '8', s.dataBits) + opt(7, '7', s.dataBits) + '</select></label>'
      + '  <label>Parity'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'parity\',this.value)">'
      +        opt('none', 'None', s.parity) + opt('even', 'Even', s.parity) + opt('odd', 'Odd', s.parity) + '</select></label>'
      + '  <label>Stop bits'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'stopBits\',this.value)">'
      +        opt(1, '1', s.stopBits) + opt(2, '2', s.stopBits) + '</select></label>'
      + '  <label>Flow control'
      + '    <select onchange="Serial.setSetting(\'' + conn.id + '\',\'flowControl\',this.value)">'
      +        opt('none', 'None', s.flowControl) + opt('hardware', 'Hardware (RTS/CTS)', s.flowControl) + '</select></label>'
      + '  <label>Display mode'
      + '    <select onchange="Serial.setMode(\'' + conn.id + '\',this.value)">'
      +        opt('text', 'ASCII text', conn.mode) + opt('hex', 'Hex dump', conn.mode) + opt('alert', 'ALERT decode', conn.mode) + '</select></label>'
      + '</div>'
      + '<p class="ser-mode-note" id="ser-mode-note-' + conn.id + '">' + MODE_HINT[conn.mode] + '</p>'
      + (conn.err ? '<p class="ser-err">Could not open port: ' + esc(conn.err) + '</p>' : '')
      + '<div class="ser-actions">'
      + '  <button class="primary" onclick="Serial.openConn(\'' + conn.id + '\')"' + (conn.port ? '' : ' disabled') + '>Open / Connect</button>'
      + '  <button class="ghost" onclick="Serial.removeConn(\'' + conn.id + '\')">Remove</button>'
      + '</div>';
  }

  function liveBody(conn) {
    const isOpen = conn.phase === 'open';
    const cfg = conn.settings.baudRate + ' baud · ' + conn.settings.dataBits + fmtParity(conn.settings.parity)
      + conn.settings.stopBits + ' · ' + MODE_LABEL[conn.mode];
    let tb = '<div class="ser-toolbar">';
    if (isOpen) {
      tb += '<button class="ghost" onclick="Serial.togglePause(\'' + conn.id + '\')">' + (conn.paused ? 'Resume' : 'Pause') + '</button>';
      if (conn.mode === 'alert')
        tb += '<button class="ghost" onclick="Serial.resync(\'' + conn.id + '\')">Resync</button>';
    } else {
      tb += '<button class="primary" onclick="Serial.reopenConn(\'' + conn.id + '\')">Reopen</button>';
    }
    tb += '<button class="ghost" onclick="Serial.clearLog(\'' + conn.id + '\')">Clear</button>';
    tb += '<button class="ghost" onclick="Serial.saveLog(\'' + conn.id + '\')">Save log</button>';
    if (isOpen) tb += '<button class="ghost" onclick="Serial.closeConn(\'' + conn.id + '\')">Close</button>';
    tb += '<button class="ghost" onclick="Serial.removeConn(\'' + conn.id + '\')">Remove</button>';
    tb += '<label class="ser-check"><input type="checkbox"' + (conn.timestamps ? ' checked' : '')
        + ' onchange="Serial.toggleFlag(\'' + conn.id + '\',\'timestamps\',this.checked)"> timestamps</label>';
    tb += '<label class="ser-check"><input type="checkbox"' + (conn.autoscroll ? ' checked' : '')
        + ' onchange="Serial.toggleFlag(\'' + conn.id + '\',\'autoscroll\',this.checked)"> autoscroll</label>';
    tb += '</div>';

    const stats = '<div class="ser-substats"><span class="ser-cfg">' + esc(cfg) + '</span>'
      + '<span class="ser-stats" id="ser-stats-' + conn.id + '">' + esc(statsText(conn)) + '</span></div>';

    const log = '<div class="ser-log' + (conn.mode === 'text' ? ' ser-log-text' : '') + '" id="ser-log-' + conn.id + '"></div>';

    let send = '';
    if (isOpen) {
      send = '<div class="ser-send">'
        + '<input type="text" id="ser-send-' + conn.id + '" placeholder="Send to device…"'
        + ' onkeydown="if(event.key===\'Enter\')Serial.sendData(\'' + conn.id + '\')">'
        + '<select id="ser-send-end-' + conn.id + '">'
        +   '<option value="lf">\\n (LF)</option><option value="crlf">\\r\\n (CRLF)</option>'
        +   '<option value="cr">\\r (CR)</option><option value="none">no line ending</option>'
        + '</select>'
        + '<button class="ghost" onclick="Serial.sendData(\'' + conn.id + '\')">Send</button>'
        + '</div>';
    }
    return tb + stats + send + log;
  }

  function connCardHtml(conn) {
    return '<div class="panel ser-conn ser-' + conn.phase + '" id="ser-card-' + conn.id + '">'
      + '<div class="ser-conn-head">'
      + '  <span class="ser-conn-name">' + esc(conn.name) + '</span>'
      + '  ' + statusBadge(conn)
      + '  <span class="ser-conn-port small">' + (conn.portLabel ? esc(conn.portLabel) : '') + '</span>'
      + '</div>'
      + (conn.phase === 'setup' ? setupBody(conn) : liveBody(conn))
      + '</div>';
  }

  function renderList() {
    const host = document.getElementById('serial-conns');
    if (!host) return;
    if (!conns.length) {
      host.innerHTML = '<div class="panel ser-empty"><p>No connections yet. Click '
        + '<strong>+ Add connection</strong> to choose a COM port and open a serial device.</p></div>';
      return;
    }
    host.innerHTML = conns.map(connCardHtml).join('');
    // repopulate live logs from each connection's retained scrollback
    conns.forEach(c => { if (c.phase !== 'setup') repaintLog(c); });
  }

  function render() {
    const bauds = '<datalist id="ser-bauds">' + BAUD_RATES.map(b => '<option value="' + b + '">').join('') + '</datalist>';
    let banner = '';
    if (!supported) {
      banner = '<div class="panel ser-warn"><h3>Web Serial isn’t available in this browser</h3>'
        + '<p>The Serial Monitor uses the <a href="https://developer.mozilla.org/docs/Web/API/Web_Serial_API" target="_blank" rel="noopener">Web Serial API</a>, '
        + 'which needs a Chromium-based browser — <strong>Chrome, Edge or Opera</strong> — served over <strong>https</strong> or from <strong>localhost</strong>. '
        + 'It is not supported in Firefox or Safari, or when this page is opened directly from a <code>file://</code> path.</p></div>';
    } else if (typeof location !== 'undefined' && !window.isSecureContext) {
      banner = '<div class="panel ser-warn"><h3>Not a secure context</h3>'
        + '<p>Web Serial only works over <strong>https</strong> or <strong>localhost</strong>. This page appears to be served insecurely, '
        + 'so opening a COM port will be blocked by the browser.</p></div>';
    }
    return '<div class="serial">' + bauds
      + '<div class="panel">'
      + '  <div class="panel-header"><h2>Serial Monitor '
      + '<span class="small" style="opacity:.55;font-weight:normal">build ' + SERIAL_BUILD + '</span></h2>'
      + '    <button class="primary" onclick="Serial.addConnection()"' + (supported ? '' : ' disabled') + '>+ Add connection</button>'
      + '  </div>'
      + '  <p class="sub">Connect physical serial devices to your computer’s COM ports and watch their output live. '
      + '     Open several devices at once — each connection has its own port, baud rate and framing, and its own display mode: '
      + '     plain <strong>ASCII text</strong>, a raw <strong>hex dump</strong>, or live <strong>ALERT</strong> binary decoding '
      + '     (ABF/BCC/EAF/EIF) cross-referenced to the station database. Click <em>+ Add connection</em>, choose a COM port, '
      + '     set the serial parameters, then <em>Open / Connect</em>.</p>'
      + '</div>'
      + banner
      + '<div id="serial-conns"></div>'
      + '</div>';
  }

  function init() {
    hookDisconnect();
    renderList();
    // Fill in the "Previously allowed" ports once the browser answers; keeps the
    // first paint instant and non-blocking.
    refreshKnownPorts().then(renderList);
  }

  return {
    render, init, addConnection, choosePort, useKnownPort, openConn, closeConn, removeConn, reopenConn,
    togglePause, clearLog, saveLog, toggleFlag, sendData, resync, openInPackets,
    setName, setSetting, setMode,
  };
})();

// Expose the module on `window` for parity with the other tab modules and for
// debugging from the console. NOTE: the built-in Web Serial `Serial` interface
// on `window` does NOT actually break the inline onclick handlers — a top-level
// `const Serial` lives in the global lexical environment, which name resolution
// consults before the global object, so `Serial.choosePort(…)` resolves to this
// module with or without this line. (An earlier fix wrongly blamed that global
// collision; the real "does nothing" reports trace to a silent NotFoundError or
// a stale, cached app.js — hence the visible status line and build stamp above.)
if (typeof window !== 'undefined') window.Serial = Serial;

// ── Bug / issue reporting ────────────────────────────────────────────────────
// MegaNet is a static GitHub Pages app: there's no server to POST an issue to
// and nowhere safe to keep an API token. So the report button gathers context
// and opens GitHub's own prefilled "New issue" page — the user reviews it and
// clicks Submit, and the issue lands on the project repo (GITHUB_REPO). A "Copy
// report" fallback covers anyone without a GitHub account: paste it into an
// email to the maintainer instead. Auto-collected diagnostics (which screen,
// data state, browser, and any captured errors) turn a vague "it broke" into
// something reproducible.
const BugReport = (function () {

  // ghLabel values are GitHub's built-in default labels, so the prefilled
  // ?labels= applies cleanly on a fresh repo.
  const TYPES = [
    { id: 'bug',         label: 'Something is broken', prefix: 'Bug',      ghLabel: 'bug' },
    { id: 'enhancement', label: 'Idea / improvement',  prefix: 'Idea',     ghLabel: 'enhancement' },
    { id: 'question',    label: 'Question',            prefix: 'Question', ghLabel: 'question' },
  ];

  // Snapshot of the user's current context. Ordered for readability in the issue.
  function collect() {
    const d   = state.data;
    const tab = TABS.find(t => t.id === state.activeTab);
    const sel = (d && state.selectedId) ? d.stations.find(s => s.id === state.selectedId) : null;
    return {
      'Screen':           tab ? `${tab.label} (${tab.id})` : state.activeTab,
      'Selected station': sel ? `${sel.name} — ${sel.station_number || sel.id}` : '(none)',
      'Data loaded':      d ? `yes — ${d.stations.length} stations, ${(d.radio_networks || []).length} networks`
                            : 'no',
      'App build':        APP_VERSION,
      'Theme':            state.theme,
      'Page':             location.href,
      'Browser':          navigator.userAgent,
      'Platform':         navigator.platform || '(unknown)',
      'Language':         navigator.language || '(unknown)',
      'Window size':      `${window.innerWidth}×${window.innerHeight} (screen ${screen.width}×${screen.height})`,
      'Online':           navigator.onLine ? 'yes' : 'no',
      'Time':             new Date().toString(),
    };
  }

  // Markdown block of the snapshot plus any captured runtime errors.
  function diagBlock() {
    let out = Object.entries(collect()).map(([k, v]) => `- **${k}:** ${v}`).join('\n');
    if (_errorLog.length) {
      out += '\n\n**Recent errors (newest last):**\n```\n'
        + _errorLog.map(e =>
            `[${e.at}] ${e.kind}: ${e.message}`
            + (e.where ? `\n    at ${e.where}` : '')
            + (e.stack ? `\n    ${e.stack.replace(/\n/g, '\n    ')}` : '')
          ).join('\n')
        + '\n```';
    } else {
      out += '\n\n_No JavaScript errors were captured this session._';
    }
    return out;
  }

  function template() {
    const typeOpts = TYPES.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('');
    return `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="br-title"
           onclick="event.stopPropagation()">
        <div class="modal-head">
          <h2 id="br-title">Report a bug or idea</h2>
          <button class="modal-x" title="Close (Esc)" onclick="BugReport.close()">×</button>
        </div>
        <p class="sub">Tell us what happened. When you submit, MegaNet opens a pre-filled issue on the
           project's GitHub — just review it and click <em>Submit new issue</em>. No GitHub account?
           Use <em>Copy report</em> and email it to the maintainer instead.</p>

        <div class="modal-form">
          <label>What kind of report is this?
            <select id="br-type">${typeOpts}</select>
          </label>
          <label>What went wrong, or what would you like? <span class="req">*</span>
            <textarea id="br-desc" placeholder="e.g. Clicking a repeater on the Map tab does nothing…"></textarea>
          </label>
          <label>What did you expect to happen? <span class="small">(optional)</span>
            <textarea id="br-expected" placeholder="e.g. The station's details should open on the right."></textarea>
          </label>

          <label class="check-inline">
            <input type="checkbox" id="br-include" checked>
            <span>Include diagnostic details <span class="small">(recommended — helps pinpoint the problem)</span></span>
          </label>

          <details class="diag-preview">
            <summary>Preview exactly what will be shared</summary>
            <pre class="diag-pre">${esc(diagBlock())}</pre>
          </details>
        </div>

        <div class="modal-foot">
          <button onclick="BugReport.close()">Cancel</button>
          <button onclick="BugReport.copy(this)">Copy report</button>
          <button class="primary" onclick="BugReport.submit()">Open GitHub issue ↗</button>
        </div>
      </div>`;
  }

  function open() {
    let root = document.getElementById('bugreport-modal');
    if (!root) {
      root = document.createElement('div');
      root.id = 'bugreport-modal';
      root.className = 'modal-overlay';
      root.onclick = close;   // click on the backdrop (outside the card) closes
      document.body.appendChild(root);
    }
    root.innerHTML = template();
    root.style.display = 'flex';
    document.addEventListener('keydown', onKey);
    const ta = document.getElementById('br-desc');
    if (ta) ta.focus();
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    const root = document.getElementById('bugreport-modal');
    if (root) { root.style.display = 'none'; root.innerHTML = ''; }
    document.removeEventListener('keydown', onKey);
  }

  function buildReport() {
    const type     = (document.getElementById('br-type')     || {}).value   || 'bug';
    const desc     = ((document.getElementById('br-desc')     || {}).value   || '').trim();
    const expected = ((document.getElementById('br-expected') || {}).value   || '').trim();
    const include  = (document.getElementById('br-include')   || {}).checked;
    const t        = TYPES.find(x => x.id === type) || TYPES[0];
    const tab      = TABS.find(x => x.id === state.activeTab);
    const screen   = tab ? tab.label : state.activeTab;

    const firstLine = desc.split('\n')[0].slice(0, 80);
    const title = `[${t.prefix}] ${firstLine || screen}`;

    let body = `**What happened / what's wanted**\n${desc || '_(none provided)_'}\n`;
    if (expected) body += `\n**Expected**\n${expected}\n`;
    body += `\n**Where:** ${screen} screen`;
    if (include) body += `\n\n---\n### Diagnostics\n${diagBlock()}`;
    body += `\n\n<sub>Reported from MegaNet ${APP_VERSION} via the in-app bug reporter.</sub>`;

    return { title, body, ghLabel: t.ghLabel, desc };
  }

  function issueUrl(labelOnly) {
    const r = buildReport();
    let url = `https://github.com/${GITHUB_REPO}/issues/new?labels=${encodeURIComponent(r.ghLabel)}`;
    if (!labelOnly) {
      url += `&title=${encodeURIComponent(r.title)}&body=${encodeURIComponent(r.body)}`;
    }
    return { url, report: r };
  }

  function submit() {
    const { url, report } = issueUrl(false);
    if (!report.desc) {
      alert('Please describe what went wrong or what you\'d like before submitting.');
      const ta = document.getElementById('br-desc'); if (ta) ta.focus();
      return;
    }
    // GitHub caps the length of a prefilled issue URL. If we're over a safe
    // budget, copy the report and open a blank issue so nothing typed is lost.
    if (url.length > 7500) {
      copyText(`${report.title}\n\n${report.body}`);
      alert('Your report is long, so it was copied to the clipboard instead of pre-filling GitHub. '
          + 'A blank new-issue page is opening — paste (Ctrl/Cmd+V) into the description.');
      window.open(issueUrl(true).url, '_blank', 'noopener');
    } else {
      window.open(url, '_blank', 'noopener');
    }
    close();
  }

  function copy(btn) {
    const r = buildReport();
    copyText(`${r.title}\n\n${r.body}`).then(ok => {
      if (!btn) return;
      const prev = btn.textContent;
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      setTimeout(() => { btn.textContent = prev; }, 1800);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }

  return { open, close, submit, copy };
})();
if (typeof window !== 'undefined') window.BugReport = BugReport;
