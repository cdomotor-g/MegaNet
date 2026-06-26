// MegaNet — app.js

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'map',        label: 'Map'        },
  { id: 'stations',   label: 'Stations'   },
  { id: 'networks',   label: 'Networks'   },
  { id: 'analysis',   label: 'Analysis'   },
  { id: 'bitflipper', label: 'Bit Flipper'},
  { id: 'export',     label: 'Export'     },
  { id: 'editor',     label: 'Editor'     },
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
  bfMap:          null,
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

function stationAlertIds(s) {
  const ids = [];
  const a = s.alert_ids || {};
  ['battery', 'rainfall', 'water_level', 'primary'].forEach(k => {
    if (a[k] == null) return;
    const v = a[k];
    if (Array.isArray(v)) v.forEach(x => ids.push(x));
    else ids.push(v);
  });
  return ids;
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
  if (!state.data) { el.innerHTML = renderEmpty(); return; }
  switch (state.activeTab) {
    case 'map':        el.innerHTML = renderMapHtml();        initMap();  break;
    case 'stations':   el.innerHTML = renderStationsHtml();               break;
    case 'networks':   el.innerHTML = renderNetworksHtml();               break;
    case 'analysis':   el.innerHTML = renderAnalysisHtml();               break;
    case 'bitflipper': el.innerHTML = renderBitFlipperHtml(); initBitFlipperMap(); break;
    case 'export':     el.innerHTML = renderExportHtml();                 break;
    case 'editor':     el.innerHTML = renderEditorHtml();                 break;
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

function initMap() {
  if (state.map) { state.map.remove(); state.map = null; state.mapMarkers = []; state.mapLines = []; }
  const el = document.getElementById('leaflet-map');
  if (!el) return;
  state.map = L.map('leaflet-map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 18,
  }).addTo(state.map);
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

    const aids = stationAlertIds(s);
    marker.bindPopup(`
      <strong>${esc(s.name)}</strong><br>
      ${s.roles.map(r => `<span style="background:${ROLE_COLOR[r]};color:#fff;padding:1px 5px;border-radius:999px;font-size:.78rem;margin-right:2px">${r}</span>`).join('')}<br>
      ${s.station_number ? `<span style="font-size:.83rem">Stn #${esc(s.station_number)}</span><br>` : ''}
      ${aids.length ? `<span style="font-size:.83rem">AlertID: ${aids.join(', ')}</span><br>` : ''}
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
      <div>
        <div class="panel">
          <div class="panel-header"><h2>Stations</h2></div>
          <div class="table-wrap tall" id="stations-table-wrap">
            ${stationsTable(stations)}
          </div>
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
              <td title="${esc(s.id)}">${esc(s.name)}</td>
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
  state.selectedId = state.selectedId === id ? null : id;
  rerenderStations();
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
          ? '<p class="small" style="color:var(--muted);margin:.75rem 0">No catchments defined yet. Add them via the Editor tab.</p>'
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

function renderBitFlipperHtml() {
  const baseId = parseInt(state.bfInput, 10);
  const valid  = !isNaN(baseId) && baseId > 0 && baseId < 65536;

  let flipRows = '';
  if (valid) {
    const aidMap = new Map();
    state.data.stations.forEach(s => {
      stationAlertIds(s).forEach(id => {
        if (!aidMap.has(id)) aidMap.set(id, []);
        aidMap.get(id).push(s);
      });
    });

    flipRows = Array.from({ length: 16 }, (_, bit) => {
      const flipped  = baseId ^ (1 << bit);
      if (flipped <= 0 || flipped >= 65536) return '';
      const matches  = aidMap.get(flipped) || [];
      const binary   = flipped.toString(2).padStart(16, '0');
      const repeaters = matches.length
        ? matches.flatMap(s => findRepeaterMatches(s, state.data.stations))
            .filter((r, i, arr) => arr.findIndex(x => x.id === r.id) === i)
        : [];
      return `
        <tr>
          <td class="small">Bit ${bit}</td>
          <td>${flipped}</td>
          <td class="small" style="font-family:monospace">${binary}</td>
          <td>${matches.length ? '✓' : ''}</td>
          <td>${matches.length
            ? matches.map(s => `<span class="badge">${esc(s.name)}</span>`).join(' ')
            : '<span style="color:var(--muted)">—</span>'}</td>
          <td>${repeaters.length
            ? repeaters.map(r => `<span class="badge badge--repeater">${esc(r.name)}</span>`).join(' ')
            : '<span style="color:var(--muted)">—</span>'}</td>
        </tr>`;
    }).join('');
  }

  return `
    <div style="max-width:860px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header"><h2>Bit Flipper</h2></div>
        <p class="small" style="color:var(--muted);margin:.5rem 0">
          Enter an ALERT decimal address to see all single-bit-flip variants and cross-reference them against the station database.
        </p>
        <label style="font-size:.9rem;color:var(--muted);display:block;margin-top:.75rem">
          ALERT decimal address
          <input type="number" min="1" max="65535" value="${esc(state.bfInput)}" placeholder="e.g. 6129"
                 style="width:220px;margin-top:.3rem"
                 oninput="state.bfInput=this.value;document.getElementById('main-content').innerHTML=renderBitFlipperHtml();initBitFlipperMap()">
        </label>
        ${valid ? `
          <div class="table-wrap tall" style="margin-top:.75rem">
            <table>
              <colgroup>
                <col style="width:8%"><col style="width:9%"><col style="width:20%">
                <col style="width:7%"><col style="width:28%"><col style="width:28%">
              </colgroup>
              <thead><tr><th>Bit</th><th>Decimal</th><th>Binary</th><th>Match</th><th>Station(s)</th><th>Repeater(s)</th></tr></thead>
              <tbody>${flipRows}</tbody>
            </table>
          </div>` : '<p class="small" style="color:var(--muted);margin-top:.75rem">Enter a valid address (1–65535) above.</p>'}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>ARRO Graph Links</h3></div>
        <p class="small" style="color:var(--muted)">
          Full ARRO integration (national sensor CSV cross-reference and pre-built graph URLs) is planned for a future release.
        </p>
      </div>
      ${valid ? `
      <div class="panel">
        <div class="panel-header"><h3>Map</h3></div>
        <div id="bf-map" style="height:420px;border-radius:6px;margin-top:.5rem"></div>
      </div>` : ''}
    </div>`;
}

function initBitFlipperMap() {
  if (state.bfMap) { state.bfMap.remove(); state.bfMap = null; }
  const el = document.getElementById('bf-map');
  if (!el || !state.data) return;

  const baseId = parseInt(state.bfInput, 10);
  if (isNaN(baseId) || baseId <= 0 || baseId >= 65536) return;

  const aidMap = new Map();
  state.data.stations.forEach(s => {
    stationAlertIds(s).forEach(id => {
      if (!aidMap.has(id)) aidMap.set(id, []);
      aidMap.get(id).push(s);
    });
  });

  // Collect stations matching any single-bit-flip variant
  const stationInfo = new Map(); // station id → { station, bits[], alertIds[] }
  for (let bit = 0; bit < 16; bit++) {
    const flipped = baseId ^ (1 << bit);
    if (flipped <= 0 || flipped >= 65536) continue;
    (aidMap.get(flipped) || []).forEach(s => {
      if (!stationInfo.has(s.id)) stationInfo.set(s.id, { station: s, bits: [], alertIds: [] });
      const info = stationInfo.get(s.id);
      info.bits.push(bit);
      info.alertIds.push(flipped);
    });
  }

  // Also include the base address's own matching stations (highlighted differently)
  const baseMatches = aidMap.get(baseId) || [];
  baseMatches.forEach(s => {
    if (!stationInfo.has(s.id)) stationInfo.set(s.id, { station: s, bits: [], alertIds: [baseId] });
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

  const mappable = [...stationInfo.values()].filter(({ station: s }) => s.lat != null && s.lon != null);

  state.bfMap = L.map('bf-map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 18,
  }).addTo(state.bfMap);

  const bounds = [];
  for (const { station: s, bits, alertIds, isBase } of mappable) {
    const role  = primaryRole(s);
    const color = isBase && !bits.length ? '#ff8c00' : (ROLE_COLOR[role] || ROLE_COLOR.field);
    const marker = L.circleMarker([s.lat, s.lon], {
      radius: s.roles.includes('repeater') ? 9 : 6,
      color, fillColor: color, fillOpacity: 0.85,
      weight: isBase ? 3 : 1.5,
    }).addTo(state.bfMap);

    const bitsLabel = bits.length
      ? `<br><span style="font-size:.82rem">Bit flip: ${bits.map(b => `Bit ${b}`).join(', ')}</span>`
      : '';
    const baseLabel = isBase
      ? `<span style="background:#ff8c00;color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem;margin-left:4px">exact match</span>`
      : '';
    marker.bindPopup(`
      <strong>${esc(s.name)}</strong>${baseLabel}<br>
      ${s.roles.map(r => `<span style="background:${ROLE_COLOR[r]};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem;margin-right:2px">${r}</span>`).join('')}
      ${bitsLabel}
      <br><span style="font-size:.82rem">AlertID: ${alertIds.join(', ')}</span>
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
      }).addTo(state.bfMap);
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
      }).addTo(state.bfMap);
    }
  }

  if (bounds.length) {
    state.bfMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
  } else {
    state.bfMap.setView([-28, 134], 4);
  }
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

// ── EDITOR tab ─────────────────────────────────────────────────────────────────

function renderEditorHtml() {
  const stations = state.data.stations;
  const s = state.editorId ? stations.find(x => x.id === state.editorId) : null;
  return `
    <div class="layout">
      <aside class="sidebar stack">
        <div class="panel">
          <div class="panel-header">
            <h3>Stations</h3>
            <button onclick="editorNew()">+ New</button>
          </div>
          <input type="search" id="editor-search" placeholder="Filter…"
                 oninput="rerenderEditorList()" style="margin-top:.6rem;width:100%">
          <div class="checklist" id="editor-list" style="margin-top:.5rem">
            ${editorList(stations, '')}
          </div>
        </div>
      </aside>
      <div>
        <div class="panel">
          ${s ? editorForm(s) : '<p style="color:var(--muted);padding:.5rem 0">Select a station or click <em>+ New</em>.</p>'}
        </div>
      </div>
    </div>`;
}

function editorList(stations, q) {
  const lq = q.toLowerCase();
  return stations
    .filter(s => !lq || s.name.toLowerCase().includes(lq))
    .map(s => `
      <label style="cursor:pointer;display:flex;gap:.4rem;align-items:center;padding:.2rem .1rem">
        <input type="radio" name="ed-sel" ${state.editorId === s.id ? 'checked' : ''}
               onchange="editorSelect('${s.id}')">
        <span style="font-size:.9rem">${esc(s.name)}</span>
        ${s.roles.slice(0,2).map(r => `<span class="badge">${r[0].toUpperCase()}</span>`).join('')}
      </label>`).join('');
}

function rerenderEditorList() {
  const q  = document.getElementById('editor-search')?.value || '';
  const el = document.getElementById('editor-list');
  if (el) el.innerHTML = editorList(state.data.stations, q);
}

function editorSelect(id) {
  state.editorId    = id;
  state.editorDraft = JSON.parse(JSON.stringify(state.data.stations.find(s => s.id === id) || {}));
  document.getElementById('main-content').innerHTML = renderEditorHtml();
}

function editorNew() {
  state.editorId    = null;
  state.editorDraft = {
    id: '', name: '', station_number: '', lat: null, lon: null, elevation_ahd: null,
    roles: ['field'], radio_network_ids: [], catchment_ids: [],
    alert_ids: {}, satcom: { enabled: false, provider: '', terminal_id: '' },
    rm_system_id: 1, enabled: true, notes: '',
  };
  document.getElementById('main-content').innerHTML = renderEditorHtml();
}

function editorForm(s) {
  const aids   = s.alert_ids || {};
  const hasRep = s.roles.includes('repeater');
  const wls    = Array.isArray(aids.water_level) ? aids.water_level : (aids.water_level != null ? [aids.water_level] : []);
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
      <label>AlertID — Rainfall<input type="number" id="ef-aid-rf" value="${aids.rainfall ?? ''}"></label>
      <label>AlertID — Battery<input type="number" id="ef-aid-bat" value="${aids.battery ?? ''}"></label>
      <label>AlertID — Water Level<input type="number" id="ef-aid-wl1" value="${wls[0] ?? ''}"></label>
      <label>AlertID — Water Level 2<input type="number" id="ef-aid-wl2" value="${wls[1] ?? ''}" placeholder="dual-sensor only"></label>
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

  const rf  = pInt(document.getElementById('ef-aid-rf')?.value);
  const bat = pInt(document.getElementById('ef-aid-bat')?.value);
  const wl1 = pInt(document.getElementById('ef-aid-wl1')?.value);
  const wl2 = pInt(document.getElementById('ef-aid-wl2')?.value);
  d.alert_ids = {};
  if (rf  != null) d.alert_ids.rainfall    = rf;
  if (bat != null) d.alert_ids.battery     = bat;
  if (wl1 != null) d.alert_ids.water_level = wl2 != null ? [wl1, wl2] : wl1;

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
  updateHeaderStats();
  document.getElementById('main-content').innerHTML = renderEditorHtml();
}

function editorDelete() {
  if (!state.editorId) return;
  const name = state.data.stations.find(s => s.id === state.editorId)?.name || state.editorId;
  if (!confirm(`Delete "${name}"?`)) return;
  state.data.stations = state.data.stations.filter(s => s.id !== state.editorId);
  state.editorId      = null;
  state.editorDraft   = {};
  updateHeaderStats();
  document.getElementById('main-content').innerHTML = renderEditorHtml();
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
