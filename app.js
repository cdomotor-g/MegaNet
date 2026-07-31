// MegaNet — app.js

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'stations',   label: 'Stations'   },
  { id: 'maps',       label: 'Network Maps'},
  { id: 'networks',   label: 'Networks'   },
  { id: 'passranges', label: 'Pass Ranges'},
  { id: 'rf',         label: 'RF Environment'},
  { id: 'rfchanges',  label: 'RF Changes' },
  { id: 'workbench',  label: 'Workbench'  },
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

// ── Station filter vocabulary ─────────────────────────────────────────────────
// The grouped filters on the Stations tab (role, sensor type, radio network,
// region…) are built from whatever the loaded stations.json actually contains.
// That database is only partly populated — at the time of writing 3086 of 3174
// stations carry no radio_network_ids and 2171 carry no catchment — so a group
// needs two reserved option values to stay honest about the gaps:
//
//   FILTER_NONE   the "not recorded yet" bucket. Every station whose field is
//                 empty lands here, and it is ticked like any other option, so
//                 the default (nothing ticked = no constraint) shows the whole
//                 network rather than only the fraction that has been mapped.
//   FILTER_EMPTY  the marker for "the operator un-ticked everything". An empty
//                 Set already means "no constraint", so a group that has been
//                 emptied by hand holds this instead — it matches no station,
//                 which is what un-ticking everything should do.
const FILTER_NONE  = '__none__';
const FILTER_EMPTY = '__empty__';
const FILTER_NONE_LABEL = 'Not recorded yet';

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
  activeTab:  'stations',
  filters: {
    search:       '',
    // Grouped filters. An empty Set is the default and means "no constraint":
    // every station passes, including the ones whose field has never been
    // filled in. See FILTER_NONE / FILTER_EMPTY above.
    roles:        new Set(),
    sensors:      new Set(),
    networks:     new Set(),
    regions:      new Set(),
    catchments:   new Set(),
    sensorsAll:   false,   // sensor group: station must carry ALL ticked types, not any
    // Single-value filters. '' = any; FILTER_NONE = only stations missing the field.
    basin:        '',
    lga:          '',
    hasCoords:    '',      // '' | 'yes' | 'no'
    hasAlertId:   '',      // '' | 'yes' | 'no'
    enabledOnly:  false,
    acma: {
      show:        true,                        // on by default; the ~1.4 MB core
                                                // data is fetched the first time
                                                // the map tab opens, not at page load
      mechanisms:  new Set(['co_channel', 'adjacent', 'imd3', 'harmonic', 'cosite_desense']),
      minScore:    20,   // scores carry a ×0.7 unknown-LOS discount, so they cluster low
      losOnly:     false,
      activeOnly:  true,
      hideMeganet: false,
      radiusKm:    60,
      showBeams:   false,
      showLinks:   true,
    },
  },
  // Which filter groups are expanded, and the option lists (with per-option
  // station counts) built from the loaded file — rebuilt on load, not per render.
  filterOpen:     { sensors: false, networks: false, regions: false, area: false, data: false },
  filterOpts:     null,
  selectedId:     null,
  map:            null,
  mapMarkers:     [],
  mapLines:       [],
  mapShowLinks:   true,
  mapHideOthers:  false,   // filter box: highlight matches (default) vs hide the rest
  mapFitKey:      null,    // extent the map was last auto-fitted to (re-fit only on change)
  mapSearchTimer: null,    // debounce for the search box → marker rebuild
  exportNets:     null,
  bfInput:        '',
  bfBits:         '1',
  bfOnlyMatches:  false,
  bfArroBase:     'https://contrail-bom.onerain.au/graph/',
  bfSensorFilter: '',
  bfMap:          null,
  bfMapLayer:     null,
  bfMapTimer:     null,
  prFilter:       '',      // Pass Ranges tab: station number / AlertID / name filter
  pkt: {
    decInput:  '',
    lastDecode: null,   // last decoded input string (for replay after re-render)
    lastEncode: false,  // whether an encode result should be replayed
    enc: { format: 'eif', id: 2784, data: 1599, polarity: 'negative', b: 0, hd: 0, bs: 0, vco: 0, de: 0 },
  },
  editorId:       null,
  editorDraft:    {},
  // ACMA RRL interference layer (all lazy — untouched until the toggle is on
  // or the RF Environment tab is opened)
  acma: {
    loaded: false, loading: false, loadPromise: null, error: null,
    threats: null, dicts: null,
    flat: [], siteById: {}, anchorById: {}, pairsByDevice: {}, mechCounts: {},
    devLoaded: false, devPromise: null,
    deviceById: {}, devicesBySite: {}, licById: {}, clientById: {}, antById: {}, texts: [],
    layer: null, beamLayer: null, linkLayer: null, hiLayer: null,
    selectedAnchorId: null, cardDeviceId: null, cardAnchorId: null,
    uiOpen: false,
  },
  rf: { anchorId: '', sortKey: 'score', sortDir: -1, corrText: '' },
  // RF Changes tab (lazy — nothing fetched until the tab is opened)
  rfc: {
    loaded: false, loading: false, loadPromise: null, error: null,
    timeline: null, changes: null, snapshots: null,
    anchorSel: new Set(),      // empty = all repeaters
    onset: '', windowDays: 90, minScore: 10, radiusKm: 60,
    pairIdx: -1,               // index into changes.pairs; -1 = newest
    sortKey: 'coin', sortDir: -1,
    corrText: '', corrSeries: null, corrSteps: null,
    pickerOpen: false,
  },
  // Interference Workbench (lazy — nothing computed or fetched until the tab is
  // opened; ACMA/RFC data loads only once an investigation names a candidate)
  wb: {
    affected: [],        // ALERT addresses flagged affected
    good: [],            // ALERT addresses explicitly marked known-good
    onset: '', onsetEnd: '',
    symptom: '',         // key into WB_SYMPTOMS ('' = unknown)
    caseName: '',
    pickQuery: '',
    map: null,
    lastAnalysis: null,
    concepts: null, conceptsPromise: null, drawerId: null,
  },
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
  state.filterOpts = null;          // option lists are derived from the file
  resetStationFilters();
  state.selectedId = null;
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

// Does the search box's text match this station? Names and station numbers
// match on any substring; a purely numeric query is also tried against the
// station's ALERT addresses, so an operator holding an id from a packet or an
// alarm can type it straight in instead of having to know the site name. Ids
// match from the start (6128 → 6128, 61 → 6128) — a mid-number substring match
// would pull in unrelated addresses that merely share a digit run.
function stationMatchesQuery(s, q) {
  if (!q) return true;
  if (s.name.toLowerCase().includes(q)) return true;
  if ((s.station_number || '').toLowerCase().includes(q)) return true;
  if (/^\d+$/.test(q) && stationAlertIds(s).some(id => String(id).startsWith(q))) return true;
  return false;
}

// The values a station offers to a grouped filter. A station with nothing
// recorded for the field answers with the FILTER_NONE bucket rather than an
// empty list, so "not recorded yet" is something the operator can tick, see a
// count for and deliberately exclude — instead of a silent disappearance.
function groupKeys(list) {
  return (Array.isArray(list) && list.length) ? list : [FILTER_NONE];
}

function stationRoleKeys(s)    { return groupKeys(s.roles); }
function stationNetworkKeys(s) { return groupKeys(s.radio_network_ids); }

function stationRegionKeys(s) {
  const regions = new Set();
  (s.catchment_ids || []).forEach(id => {
    const region = catchmentById(id)?.region;
    if (region) regions.add(region);
  });
  return regions.size ? [...regions] : [FILTER_NONE];
}

function stationSensorTypeKeys(s) {
  const types = new Set();
  stationSensors(s).forEach(se => { if (se && se.type) types.add(se.type); });
  return types.size ? [...types] : [FILTER_NONE];
}

// Does a station clear one grouped filter? An empty Set is the default and
// constrains nothing. `matchAll` is the sensor group's "must carry all of
// these" mode — otherwise any one ticked value is enough. FILTER_EMPTY is never
// among a station's keys, so a hand-emptied group matches nothing either way.
function groupMatches(set, keys, matchAll) {
  if (!set.size) return true;
  if (matchAll)  return [...set].every(v => keys.includes(v));
  return keys.some(k => set.has(k));
}

// A single-value filter ('' = any) against a field that may be blank; blank
// fields are only matched by the explicit FILTER_NONE option.
function valueMatches(want, value) {
  return !want || (value || FILTER_NONE) === want;
}

function filteredStations() {
  if (!state.data) return [];
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  return state.data.stations.filter(s => {
    if (f.enabledOnly && !s.enabled) return false;
    if (!stationMatchesQuery(s, q)) return false;
    // Each group is skipped outright when it isn't filtering — deriving a
    // station's regions or sensor types is not free across 3000+ stations on
    // every keystroke.
    if (f.roles.size      && !groupMatches(f.roles,      stationRoleKeys(s)))         return false;
    if (f.networks.size   && !groupMatches(f.networks,   stationNetworkKeys(s)))      return false;
    if (f.regions.size    && !groupMatches(f.regions,    stationRegionKeys(s)))       return false;
    if (f.catchments.size && !groupMatches(f.catchments, groupKeys(s.catchment_ids))) return false;
    if (f.sensors.size    && !groupMatches(f.sensors, stationSensorTypeKeys(s), f.sensorsAll)) return false;
    if (!valueMatches(f.basin, s.basin)) return false;
    if (!valueMatches(f.lga,   s.lga))   return false;
    if (f.hasCoords) {
      const located = s.lat != null && s.lon != null;
      if (located !== (f.hasCoords === 'yes')) return false;
    }
    if (f.hasAlertId) {
      const addressed = stationAlertIds(s).length > 0;
      if (addressed !== (f.hasAlertId === 'yes')) return false;
    }
    return true;
  });
}

// Catchment lookup, indexed once per loaded file — the region filter asks for
// one on every station on every keystroke, so a linear scan would show.
let _catchmentIdx = null, _catchmentIdxFor = null;
function catchmentById(id) {
  if (_catchmentIdxFor !== state.data) {
    _catchmentIdxFor = state.data;
    _catchmentIdx    = new Map((state.data?.catchments || []).map(c => [c.id, c]));
  }
  return _catchmentIdx.get(id);
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
    case 'stations':   el.innerHTML = renderStationsHtml();  initMap();   break;
    case 'maps':       el.innerHTML = Maps.render();          Maps.init();         break;
    case 'networks':   el.innerHTML = renderNetworksHtml();               break;
    case 'passranges': el.innerHTML = renderPassRangesHtml();             break;
    case 'rf':         el.innerHTML = renderRfHtml();        initRf();    break;
    case 'rfchanges':  el.innerHTML = renderRfcHtml();       initRfc();   break;
    case 'workbench':  el.innerHTML = renderWorkbenchHtml(); initWb();    break;
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

// ── STATIONS tab (map + station list + editor) ─────────────────────────────────
// One page: the filter pane on the left drives both the map at the top and the
// station table underneath it, so a filter narrows what is plotted and what is
// listed in the same action.

function renderStationsHtml() {
  const stations = filteredStations();
  return `
    <div class="layout map-layout">
      <aside class="sidebar stack">
        <div class="panel filter-panel" id="station-filters">
          ${stationFiltersHtml()}
        </div>
        <div class="panel">
          <div class="panel-header"><h3>Map display</h3></div>
          <div class="filter-block">
            <label class="filter-check">
              <input type="checkbox" ${state.mapHideOthers ? 'checked' : ''}
                     onchange="state.mapHideOthers=this.checked;refreshMapLayers()">
              Hide stations that don't match
            </label>
            <label class="filter-check">
              <input type="checkbox" ${state.mapShowLinks ? 'checked' : ''}
                     onchange="state.mapShowLinks=this.checked;refreshMapLayers()">
              Show signal links
            </label>
          </div>
          <div class="filter-block">
            ${acmaFilterBlockHtml()}
          </div>
        </div>
        <div class="panel">
          <div class="map-legend" id="map-legend">${mapLegendHtml()}</div>
        </div>
      </aside>
      <div class="stack">
        <div class="panel" style="padding:.6rem;position:relative">
          <div id="leaflet-map" style="height:min(62vh,720px);min-height:360px;border-radius:6px"></div>
          <div id="map-note" class="map-note" hidden></div>
          <div id="acma-card" class="acma-card" hidden></div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <h2>Stations <span class="badge" id="st-count">${stations.length}</span></h2>
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

function mapLegendHtml() {
  return `
    ${Object.entries(ROLE_LABEL).map(([k, v]) => `
      <span class="legend-item">
        <span class="legend-dot" style="background:${ROLE_COLOR[k]}"></span>
        <span class="small">${v}</span>
      </span>`).join('')}
    <span class="legend-item">
      <span class="legend-dot legend-dot-hit" style="background:${ROLE_COLOR.field}"></span>
      <span class="small">Matches filter</span>
    </span>
    <span class="legend-item">
      <span class="legend-line"></span>
      <span class="small">Pass-range link</span>
    </span>
    ${state.filters.acma.show ? Object.entries(ACMA_MECH).map(([k, m]) => `
      <span class="legend-item">
        <span class="legend-sq" style="background:${m.color}"></span>
        <span class="small">${m.label}</span>
      </span>`).join('') + `
    <span class="legend-item"><span class="small" style="color:var(--muted)">ACMA RRL data (CC BY 4.0)${state.acma.threats ? ' · ' + esc(state.acma.threats.meta.source_date) : ''}</span></span>` : ''}`;
}

function rerenderMapLegend() {
  const el = document.getElementById('map-legend');
  if (el) el.innerHTML = mapLegendHtml();
}

// A short-lived note over the map (location errors, label caps). Empty clears it.
function mapNote(msg, ms) {
  const el = document.getElementById('map-note');
  if (!el) return;
  clearTimeout(mapNote._t);
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = msg;
  el.hidden = false;
  if (ms) mapNote._t = setTimeout(() => { el.hidden = true; el.textContent = ''; }, ms);
}

// A filter change on the Stations tab drives both halves of the page: the map
// re-highlights (or re-hides) its pins and the table below it re-lists. The
// filter panel's own summaries follow, so it always says what it is doing.
function stationsFilterChanged() {
  refreshMapLayers();
  rerenderStations();
  updateFilterChrome();
}

// Typing in the search box rebuilds every marker and every table row, so hold
// off until the user pauses. The sidebar is never re-rendered from here — the
// input keeps focus.
function mapSearchInput(value) {
  state.filters.search = value;
  clearTimeout(state.mapSearchTimer);
  state.mapSearchTimer = setTimeout(stationsFilterChanged, 160);
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
  // The old map (if any) owned these layer groups — they die with it.
  state.acma.layer = state.acma.beamLayer = state.acma.linkLayer = state.acma.hiLayer = null;
  MapLocate.detach();
  const el = document.getElementById('leaflet-map');
  if (!el) return;
  state.map = L.map('leaflet-map');
  state.mapFitKey = null;              // a fresh map always fits its contents once
  addBaseLayers(state.map);
  MapSpider.attach(state.map);
  MapLocate.attach(state.map);
  state.map.on('click', () => acmaClearHighlight());
  refreshMapLayers();
  refreshAcmaLayer();
  // ACMA transmitters are on by default, so the first visit to the map pulls the
  // core data in. Panels that gain content once it lands are refreshed in place
  // rather than by re-rendering the tab, which would throw away the map view.
  if (state.filters.acma.show && !state.acma.loaded && !state.acma.loading) {
    acmaEnsureCore()
      .then(() => { if (state.activeTab === 'stations' && state.map) acmaAfterLoad(); })
      .catch(() => rerenderAcmaFilterBlock());
  }
}

// Panels that depend on loaded ACMA data, refreshed without rebuilding the tab.
function acmaAfterLoad() {
  refreshAcmaLayer();
  rerenderAcmaFilterBlock();
  rerenderMapLegend();
}

// ── Map filter behaviour ─────────────────────────────────────────────────────
// The filter box no longer removes anything: every station stays on the map and
// the ones that match are ringed, labelled and zoomed to. "Hide stations that
// don't match" puts the old subtractive behaviour back.

const MAP_LABEL_CAP = 60;     // permanent name labels beyond this are unreadable
const MAP_PIN_RING  = '#ffffff';
const MAP_PIN_HIT   = '#ffc400';

// Is any station filter narrowing things down? Every grouped filter keeps its
// Set canonical (empty when everything is ticked), so "not empty" already means
// "narrowing" — see toggleGroupFilter.
function mapFilterActive() {
  return anyStationFilterActive();
}

function mapMatchNoteHtml() {
  if (!state.data) return '';
  const total = state.data.stations.length;
  if (!mapFilterActive()) return `Showing all <strong>${total}</strong> stations.`;
  const matched = filteredStations();
  if (!matched.length) return 'No stations match — all pins shown unhighlighted.';
  const located = matched.filter(s => s.lat != null && s.lon != null).length;
  return `<strong>${matched.length}</strong> of ${total} stations match` +
         (located < matched.length ? ` · ${matched.length - located} without a position` : '') +
         (located > MAP_LABEL_CAP ? ` · labels on the closest ${MAP_LABEL_CAP}` : '');
}

function updateMapMatchNote() {
  const el = document.getElementById('map-match-note');
  if (el) el.innerHTML = mapMatchNoteHtml();
}

// Signature of the extent last auto-fitted. Refreshes that don't change what
// the map should be looking at (theme switch, link toggle, ACMA options) leave
// the operator's pan and zoom alone.
function mapFitKey(points) {
  if (!points.length) return 'none';
  let n = Infinity, s = -Infinity, w = Infinity, e = -Infinity;
  for (const [lat, lon] of points) {
    if (lat < n) n = lat; if (lat > s) s = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  return [points.length, n, s, w, e].map(v => Number(v).toFixed(4)).join(',');
}

function refreshMapLayers() {
  const map = state.map;
  if (!map || !state.data) return;
  MapSpider.reset();                       // pins go home before any are replaced
  state.mapMarkers.forEach(m => m.remove());
  state.mapLines.forEach(l => l.remove());
  state.mapMarkers = [];
  state.mapLines   = [];

  const located  = state.data.stations.filter(s => s.lat != null && s.lon != null);
  const active   = mapFilterActive();
  const matchIds = active ? new Set(filteredStations().map(s => s.id)) : null;
  const matched  = active ? located.filter(s => matchIds.has(s.id)) : [];
  // Highlight mode keeps every pin on the map; hide mode drops the rest.
  const stations = (active && state.mapHideOthers) ? matched : located;
  updateMapMatchNote();
  if (!stations.length) { MapSpider.setPins('stations', []); return; }

  // Names are only drawn for filter matches, and only while the set is small
  // enough to read — the nearest ones to the matched extent win.
  const labelled = new Set(
    active && matched.length
      ? (matched.length <= MAP_LABEL_CAP ? matched : mapNearestToCentre(matched, MAP_LABEL_CAP))
          .map(s => s.id)
      : []);

  const lineColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--map-line').trim() || '#ff6f00';

  if (state.mapShowLinks) {
    const allStations = state.data.stations;
    // Links follow the highlight: with a filter running, only matched stations
    // draw theirs, so the lines don't bury the pins they're meant to explain.
    for (const s of (active ? matched : stations)) {
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

  for (const s of stations) {
    const role   = primaryRole(s);
    const color  = ROLE_COLOR[role] || ROLE_COLOR.field;
    const isRpt  = s.roles.includes('repeater');
    const hit    = active && matchIds.has(s.id);
    const dim    = active && !hit;
    const radius = (isRpt ? 8 : 5) + (hit ? 1 : 0);
    // Every pin carries a white ring so it separates from the base map and from
    // its neighbours; matches swap it for amber.
    const marker = L.circleMarker([s.lat, s.lon], {
      radius,
      color:       hit ? MAP_PIN_HIT : MAP_PIN_RING,
      weight:      hit ? 3 : 2,
      opacity:     dim ? 0.6 : 1,
      fillColor:   color,
      fillOpacity: dim ? 0.45 : 1,
      className:   hit ? 'mn-pin mn-pin-hit' : 'mn-pin',
      bubblingMouseEvents: false,          // a pin click is not an empty-map click
    }).addTo(map);
    marker.mnStationId = s.id;             // lets the table below find its pin

    const idTypes = stationAlertIdTypes(s);
    marker.bindPopup(`
      <strong>${esc(s.name)}</strong><br>
      ${s.roles.map(r => `<span style="background:${ROLE_COLOR[r]};color:#fff;padding:1px 5px;border-radius:999px;font-size:.78rem;margin-right:2px">${r}</span>`).join('')}<br>
      ${s.station_number ? `<span style="font-size:.83rem">Stn #${esc(s.station_number)}</span><br>` : ''}
      ${idTypes.length ? `<span style="font-size:.83rem">AlertID:</span><br>${idTypes.map(t =>
        `<span style="font-size:.82rem">&nbsp;&nbsp;${t.types.length ? esc(t.types.join(' / ')) + ' — ' : ''}${t.id}</span>`).join('<br>')}<br>` : ''}
      ${s.elevation_ahd != null ? `<span style="font-size:.83rem">Elev: ${s.elevation_ahd} m AHD</span>` : ''}
      ${acmaRepeaterPopupExtra(s)}
      <div class="mn-popup-actions">
        <a href="#" onclick="focusStation('${escAttr(s.id)}');return false"
           title="Select this station in the list under the map">Show in the list below ↓</a>
      </div>
    `);
    if (labelled.has(s.id)) {
      marker.bindTooltip(esc(s.name), {
        permanent: true, direction: 'bottom', offset: [0, radius], className: 'mn-pin-label',
      });
    }
    state.mapMarkers.push(marker);
  }

  MapSpider.setPins('stations', state.mapMarkers);

  // Zoom to the matches (all of them, not just the first) — or to everything
  // when no filter is running.
  const fitTo = (active && matched.length ? matched : stations).map(s => [s.lat, s.lon]);
  const key   = mapFitKey(fitTo);
  if (fitTo.length && key !== state.mapFitKey) {
    state.mapFitKey = key;
    map.fitBounds(fitTo, { padding: [24, 24], maxZoom: fitTo.length === 1 ? 14 : 12 });
  }
}

// The `n` stations closest to the centre of their own bounding box — used to
// pick which matches get a name label when there are too many to show.
function mapNearestToCentre(stations, n) {
  const lat = stations.map(s => s.lat), lon = stations.map(s => s.lon);
  const cLat = (Math.min(...lat) + Math.max(...lat)) / 2;
  const cLon = (Math.min(...lon) + Math.max(...lon)) / 2;
  return stations
    .map(s => ({ s, d: (s.lat - cLat) ** 2 + (s.lon - cLon) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map(x => x.s);
}

// ── Overlapping pins: fan-out ("spiderfy") ───────────────────────────────────
// Co-sited stations and ACMA sites carrying a dozen licensed devices land on the
// same few pixels, and whatever is underneath is unreachable. Hovering a stack
// (mouse) or tapping it (touch) fans its members out around the stack centre on
// leader lines so each one can be seen and clicked; they snap back when the
// pointer leaves, the map zooms, or the markers are rebuilt.
//
// Works on any marker with getLatLng/setLatLng, so MegaNet station circles and
// ACMA transmitter squares fan out together.
const MapSpider = (function () {
  const NEAR_PX   = 20;  // pins within this screen distance form one stack
  const MAX_FAN   = 16;  // a fan bigger than this stops being readable
  const HOVER_MAX = 10;  // bigger stacks need a deliberate click, so that panning
                         // across a zoomed-out map doesn't fan pins constantly
  const LEAVE_PX  = 70;  // pointer this far outside the fan closes it
  const HOVER_MS  = 70;  // settle time, so sweeping across a stack doesn't fan it

  const buckets = { stations: [], acma: [] };
  let map = null;
  let open = null;       // { members, centre, radius, legs }
  let cache = null;      // { list, pts } projected at the current zoom
  let hoverTimer = null;

  function canHover() {
    return !L.Browser.mobile && window.matchMedia('(hover: hover)').matches;
  }

  function pins() { return buckets.stations.concat(buckets.acma); }

  // Where a pin belongs — its own position unless it is currently fanned out.
  function home(m) { return m._mnHome || m.getLatLng(); }

  function invalidate() { cache = null; }

  function points() {
    if (cache) return cache;
    const zoom = map.getZoom();
    const list = pins();
    cache = { list, pts: list.map(m => map.project(home(m), zoom)) };
    return cache;
  }

  // Every pin sitting within NEAR_PX of the given one, nearest first.
  function stackFor(marker) {
    const { list, pts } = points();
    const i = list.indexOf(marker);
    if (i < 0) return [];
    const c = pts[i];
    return list
      .map((m, j) => ({ m, d: Math.hypot(pts[j].x - c.x, pts[j].y - c.y) }))
      .filter(x => x.d <= NEAR_PX)
      .sort((a, b) => a.d - b.d)
      .map(x => x.m);
  }

  // Pixel offsets for n fanned pins: concentric rings at ~26 px spacing, so a
  // pair sits tight and a 30-device ACMA site still reads.
  function fanOffsets(n) {
    const out = [];
    let placed = 0, ring = 0;
    while (placed < n) {
      const r   = 30 + ring * 26;
      const cap = Math.max(3, Math.floor((2 * Math.PI * r) / 26));
      const k   = Math.min(cap, n - placed);
      for (let i = 0; i < k; i++) {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / k + (ring % 2 ? Math.PI / k : 0);
        out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, r });
      }
      placed += k;
      ring++;
    }
    return out;
  }

  function isOpen(marker) { return !!open && open.members.indexOf(marker) >= 0; }

  function spiderfy(marker) {
    if (!map) return false;
    const stack = stackFor(marker);
    if (stack.length < 2) { unspiderfy(); return false; }
    // Co-located ACMA devices share exact coordinates and never separate by
    // zooming, so an oversized stack still fans — it just says what it left out.
    const members = stack.slice(0, MAX_FAN);
    if (open && open.members.length === members.length &&
        members.every(m => open.members.indexOf(m) >= 0)) return true;
    unspiderfy();
    if (stack.length > MAX_FAN) {
      mapNote(`${members.length} of ${stack.length} pins fanned out — zoom in for the rest`, 4000);
    }

    const zoom = map.getZoom();
    const { list, pts } = points();
    let sx = 0, sy = 0;
    members.forEach(m => { const p = pts[list.indexOf(m)]; sx += p.x; sy += p.y; });
    const centre = map.unproject(L.point(sx / members.length, sy / members.length), zoom);
    const cLp    = map.latLngToLayerPoint(centre);
    const offs   = fanOffsets(members.length);
    const legs   = L.layerGroup().addTo(map);
    let radius   = 0;

    members.forEach((m, i) => {
      const o    = offs[i];
      const from = home(m);
      const to   = map.layerPointToLatLng(cLp.add(L.point(o.x, o.y)));
      radius = Math.max(radius, o.r);
      m._mnHome = from;
      // White casing under a dark line: legible over topo, imagery and dark mode.
      L.polyline([from, to], { pane: 'mnSpiderLegs', color: '#fff',     weight: 4,   opacity: .9,  interactive: false }).addTo(legs);
      L.polyline([from, to], { pane: 'mnSpiderLegs', color: '#4a5560', weight: 1.5, opacity: .95, interactive: false }).addTo(legs);
      m.setLatLng(to);
      if (m.setZIndexOffset) m.setZIndexOffset(1000);
      if (m.bringToFront)    m.bringToFront();
    });
    L.circleMarker(centre, {
      pane: 'mnSpiderLegs', radius: 2.5, color: '#4a5560', weight: 1,
      fillColor: '#fff', fillOpacity: 1, interactive: false,
    }).addTo(legs);

    open = { members, centre, radius, legs };
    map.on('mousemove', onMapMove);
    return true;
  }

  function unspiderfy() {
    clearTimeout(hoverTimer);
    if (!open) return;
    open.members.forEach(m => {
      if (m._mnHome) { m.setLatLng(m._mnHome); delete m._mnHome; }
      if (m.setZIndexOffset) m.setZIndexOffset(0);
    });
    open.legs.remove();
    if (map) map.off('mousemove', onMapMove);
    open = null;
  }

  function onMapMove(e) {
    if (!open) return;
    // A popup open on one of the fanned pins is the user reading it — hold.
    if (open.members.some(m => m.isPopupOpen && m.isPopupOpen())) return;
    if (e.layerPoint.distanceTo(map.latLngToLayerPoint(open.centre)) > open.radius + LEAVE_PX) {
      unspiderfy();
    }
  }

  function onPinOver(e) {
    if (!map || isOpen(e.target)) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      // Hover only opens small stacks; a zoomed-out map where everything
      // overlaps would otherwise fan pins under every pass of the mouse.
      if (stackFor(e.target).length <= HOVER_MAX) spiderfy(e.target);
    }, HOVER_MS);
  }

  function onPinClick(e) {
    if (!map || isOpen(e.target)) return;   // already fanned → let the popup open
    // First tap on a stack fans it instead of opening whichever pin was on top.
    if (spiderfy(e.target)) e.target.closePopup();
  }

  return {
    // Wire a freshly built map. Leader lines get their own pane below the
    // overlay pane so they never draw over the pins they point at.
    attach(m) {
      map = m;
      open = null; cache = null;
      buckets.stations = []; buckets.acma = [];
      clearTimeout(hoverTimer);
      if (!m.getPane('mnSpiderLegs')) {
        const pane = m.createPane('mnSpiderLegs');
        pane.style.zIndex = 350;
        pane.style.pointerEvents = 'none';
      }
      m.on('zoomstart', unspiderfy);
      m.on('zoomend viewreset', invalidate);
      m.on('click', unspiderfy);          // pin clicks don't bubble to the map
    },

    // Hand over a rebuilt set of markers for one layer.
    setPins(kind, markers) {
      unspiderfy();
      buckets[kind] = markers || [];
      invalidate();
      (markers || []).forEach(m => {
        if (m._mnSpiderWired) return;
        m._mnSpiderWired = true;
        m.on('click', onPinClick);
        if (canHover()) m.on('mouseover', onPinOver);
      });
    },

    // Send every fanned pin home — call before markers are removed or replaced.
    reset() { unspiderfy(); invalidate(); },

    detach() { unspiderfy(); map = null; buckets.stations = []; buckets.acma = []; },
  };
})();

// ── Where am I? (mobile) ─────────────────────────────────────────────────────
// Off by default and only offered on touch devices: a button below the zoom
// control puts a dot at the phone's GPS position with an accuracy ring, plus a
// cone pointing the way the phone is facing when a compass is available.
// iOS only hands out orientation events after a permission request made from a
// user gesture, which is why that request lives in the button's click handler.
const MapLocate = (function () {
  let map = null, btn = null;
  let on = false, watchId = null, marker = null, ring = null;
  let heading = null, orientEvent = null, gotCompass = false, followed = false;

  function isMobile() {
    return L.Browser.mobile || window.matchMedia('(pointer: coarse)').matches;
  }

  function icon() {
    return L.divIcon({
      className: 'mn-loc-icon',
      html: '<div class="mn-loc"><i class="mn-loc-cone"></i><i class="mn-loc-dot"></i></div>',
      iconSize: [46, 46], iconAnchor: [23, 23],
    });
  }

  function applyHeading() {
    const el   = marker && marker.getElement();
    const cone = el && el.querySelector('.mn-loc-cone');
    if (!cone) return;
    cone.style.display   = heading == null ? 'none' : '';
    cone.style.transform = `rotate(${heading || 0}deg)`;
  }

  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      h = e.webkitCompassHeading;                                  // iOS: clockwise from north
    } else if (e.alpha != null && (e.absolute || e.type === 'deviceorientationabsolute')) {
      h = 360 - e.alpha;                                           // spec alpha runs anticlockwise
    }
    if (h == null) return;      // relative-only sensor: no compass, leave it to GPS course
    // Compass readings are relative to the device's natural orientation; add the
    // screen rotation so the cone still points the right way in landscape.
    const screenAngle = (window.screen.orientation && window.screen.orientation.angle) ||
                        window.orientation || 0;
    gotCompass = true;
    heading = (h + screenAngle + 360) % 360;
    applyHeading();
  }

  function listenOrientation() {
    orientEvent = ('ondeviceorientationabsolute' in window)
      ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(orientEvent, onOrient, true);
  }

  function startOrientation() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return;
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission()
        .then(res => { if (res === 'granted') listenOrientation(); })
        .catch(() => {});
    } else {
      listenOrientation();
    }
  }

  function onPos(p) {
    if (!on || !map) return;
    const ll  = [p.coords.latitude, p.coords.longitude];
    const acc = p.coords.accuracy || 0;
    // No compass readings arriving? Fall back to GPS course, which is only
    // meaningful on the move.
    if (!gotCompass && p.coords.heading != null && !isNaN(p.coords.heading) &&
        p.coords.speed > 0.5) {
      heading = p.coords.heading;
    }
    if (!marker) {
      ring   = L.circle(ll, { radius: acc, color: '#1e88e5', weight: 1,
                              fillColor: '#1e88e5', fillOpacity: .12, interactive: false }).addTo(map);
      marker = L.marker(ll, { icon: icon(), interactive: false, keyboard: false,
                              zIndexOffset: 2000 }).addTo(map);
    } else {
      marker.setLatLng(ll);
      ring.setLatLng(ll).setRadius(acc);
    }
    applyHeading();
    if (!followed) {                          // centre on the first fix only
      followed = true;
      map.setView(ll, Math.max(map.getZoom(), 14));
      mapNote('', 0);
    }
  }

  function onErr(e) {
    mapNote(`Location unavailable — ${e.message || 'no fix'}`, 6000);
    if (e.code === 1) stop();                 // permission denied: don't keep trying
  }

  function stop() {
    on = false;
    if (btn) btn.classList.remove('on');
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (orientEvent) window.removeEventListener(orientEvent, onOrient, true);
    orientEvent = null;
    heading = null;
    gotCompass = false;
    if (marker) marker.remove();
    if (ring)   ring.remove();
    marker = ring = null;
  }

  function toggle() {
    if (on) { stop(); mapNote('', 0); return; }
    on = true;
    followed = false;
    if (btn) btn.classList.add('on');
    mapNote('Locating…', 8000);
    startOrientation();
    watchId = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 20000,
    });
  }

  return {
    attach(m) {
      map = m;
      if (!('geolocation' in navigator) || !isMobile()) return;
      const ctl = L.control({ position: 'topleft' });
      ctl.onAdd = () => {
        const div = L.DomUtil.create('div', 'leaflet-bar mn-locate');
        const a   = L.DomUtil.create('a', '', div);
        a.href = '#';
        a.title = 'Show my location and heading';
        a.setAttribute('role', 'button');
        a.setAttribute('aria-label', 'Show my location and heading');
        a.innerHTML = '➤';
        L.DomEvent.on(a, 'click', L.DomEvent.stop).on(a, 'click', toggle);
        btn = a;
        return div;
      };
      ctl.addTo(m);
    },

    // The map is being torn down (tab switch or re-render): drop the GPS watch
    // and the compass listener rather than leaving them running unseen.
    detach() { if (on) stop(); map = null; btn = null; },
  };
})();

// ── Station table (lower half of the Stations tab) ─────────────────────────────

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
            <tr class="${state.selectedId === s.id ? 'selected' : ''}" data-sid="${escAttr(s.id)}"
                onclick="selectStation('${escAttr(s.id)}')" style="cursor:pointer">
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
    rerenderStations();
    rerenderStationEditorCard();
    return;
  }
  // Select the row and load it into the editor card. A deep copy becomes the
  // draft so fields not exposed by the form (catchments, satcom, RM metadata)
  // survive a save.
  const s = state.data.stations.find(x => x.id === id);
  state.selectedId  = id;
  state.editorId    = id;
  state.editorDraft = JSON.parse(JSON.stringify(s || {}));
  rerenderStations();
  rerenderStationEditorCard();
  if (s) focusStationOnMap(s);
}

// Pan the map above the table to a station and open its pin. Called whenever a
// row is picked, so the list and the map stay talking about the same site.
function focusStationOnMap(s) {
  if (!state.map || s.lat == null || s.lon == null) return;
  state.map.setView([s.lat, s.lon], Math.max(state.map.getZoom() || 0, 11));
  const marker = state.mapMarkers.find(m => m.mnStationId === s.id);
  if (marker) marker.openPopup();
}

// Scroll a station's row into the middle of the table viewport, so a station
// arrived at from another tab isn't left somewhere in 1300 rows.
function scrollStationRowIntoView(id) {
  const wrap = document.getElementById('stations-table-wrap');
  if (!wrap) return;
  const row = [...wrap.querySelectorAll('tr[data-sid]')].find(tr => tr.dataset.sid === id);
  if (row) row.scrollIntoView({ block: 'center' });
}

// Select a station and load it into the editor card, without touching the DOM.
// The filter driving the table is the same one driving the map, so a station
// the current filter excludes would be selected into a list it isn't in; in
// that case the filters are narrowed to the station's own name instead — the
// table then contains it, and the search box visibly says why the list changed.
// Returns true when the filters moved, so the caller knows the sidebar has to
// be re-rendered and not just the table.
function selectStationState(s) {
  state.selectedId  = s.id;
  state.editorId    = s.id;
  // Same deep copy as selectStation: fields the form doesn't expose survive a save.
  state.editorDraft = JSON.parse(JSON.stringify(s));
  if (filteredStations().some(x => x.id === s.id)) return false;
  resetStationFilters();
  state.filters.search = s.name;
  return true;
}

// "Show in the list below ↓" from a map popup. The map and the list share this
// page, so there is no tab to switch to — the row is selected, scrolled to and
// loaded into the editor beneath the map the operator is already looking at.
function focusStation(id) {
  const s = state.data && state.data.stations.find(x => x.id === id);
  if (!s) return;
  if (selectStationState(s)) {
    renderMain();               // filters moved — the sidebar has to show it
  } else {
    rerenderStations();
    rerenderStationEditorCard();
  }
  scrollStationRowIntoView(id);
}

// Open the Stations tab focused on one station. Used by the Pass Ranges tables,
// where every row names a station the operator will want to look at in full.
function goToStation(id) {
  const s = state.data && state.data.stations.find(x => x.id === id);
  if (!s) return;
  selectStationState(s);
  switchTab('stations');        // renders the page, table and map included
  scrollStationRowIntoView(id);
  focusStationOnMap(s);
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

// ── PASS RANGES tab ────────────────────────────────────────────────────────────

// Does a station answer to the page's filter box? The box takes a station
// number, an ALERT id or part of a station name and does not ask which — an
// operator holding one of the three shouldn't have to say which one it is.
// Shares the Stations search box's matching rules so the same text typed into
// either box picks the same stations.
function passRangeMatch(s, q) {
  return stationMatchesQuery(s, String(q || '').trim().toLowerCase());
}

// A repeater row survives the filter if the repeater itself matches, if one of
// the stations it serves matches, or if the query is an ALERT id its pass
// ranges cover — the last one answers "which repeater carries this address?".
function passRangeRepeaterMatch(r, matched, q) {
  if (!q) return true;
  if (passRangeMatch(r, q)) return true;
  if (matched.some(s => passRangeMatch(s, q))) return true;
  const n = parseInt(q.trim(), 10);
  return !isNaN(n) && passRangeCoversId(r.repeater, n);
}

// Static shell — the filter box lives out here and is never re-rendered on a
// keystroke, so it keeps focus while only #pr-tables refreshes below it.
function renderPassRangesHtml() {
  const all       = state.data.stations;
  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater);
  const fields    = all.filter(s => s.roles.includes('field'));
  const noAid     = fields.filter(s => !stationAlertIds(s).length).length;
  const orphans   = passRangeOrphans();

  return `
    <div style="max-width:1100px;margin:auto;padding:1rem;display:grid;gap:1rem">
      <div class="panel">
        <div class="panel-header"><h2>Pass Ranges</h2></div>
        <div class="stats" style="display:flex;flex-wrap:wrap;gap:1.5rem;margin-top:.75rem">
          <div>Repeaters with pass ranges: <strong>${repeaters.length}</strong></div>
          <div>Field stations with AlertID: <strong>${fields.length - noAid}</strong></div>
          <div>No AlertID (telemetry): <strong>${noAid}</strong></div>
          <div style="${orphans.length ? 'color:#c7401a' : ''}">
            Orphaned (no matching repeater): <strong>${orphans.length}</strong>
          </div>
        </div>
        <label style="display:block;font-size:.88rem;color:var(--muted);margin-top:.9rem;max-width:420px">
          Filter by station number, AlertID or station name
          <input type="search" id="pr-filter" value="${esc(state.prFilter)}"
                 placeholder="e.g. 540123, 6128 or Amiens…"
                 style="width:100%;margin-top:.3rem;display:block"
                 oninput="onPassRangeFilter(this.value)">
        </label>
        <p class="small" style="color:var(--muted);margin:.5rem 0 0">
          Click any row to open that station on the Stations tab.
        </p>
      </div>

      <div id="pr-tables" style="display:grid;gap:1rem">${passRangeTablesHtml()}</div>
    </div>`;
}

// Field stations carrying an AlertID that no repeater's pass ranges cover.
function passRangeOrphans() {
  const all       = state.data.stations;
  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater);
  return all.filter(s => {
    if (!s.roles.includes('field')) return false;
    const ids = stationAlertIds(s);
    if (!ids.length) return false;
    return !repeaters.some(r => ids.some(id => passRangeCoversId(r.repeater, id)));
  });
}

// Dynamic half — recomputed into #pr-tables on every keystroke in the filter box.
function passRangeTablesHtml() {
  const all       = state.data.stations;
  const q         = state.prFilter;
  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater);

  const rptData = repeaters
    .map(r => ({ r, matched: findStationMatches(r, all) }))
    .filter(({ r, matched }) => passRangeRepeaterMatch(r, matched, q));

  const allOrphans = passRangeOrphans();
  const orphans    = allOrphans.filter(s => passRangeMatch(s, q));

  const of = (shown, total) => shown === total ? `${total}` : `${shown} of ${total}`;
  const noMatch = msg => `<p class="small" style="color:var(--muted);padding:.75rem">${msg}</p>`;

  return `
      <div class="panel">
        <div class="panel-header"><h2>By Repeater</h2>
          <span class="badge">${of(rptData.length, repeaters.length)}</span>
        </div>
        <div class="table-wrap tall">
          ${!rptData.length ? noMatch('No repeater matches this filter.') : `
          <table>
            <colgroup>
              <col style="width:20%"><col style="width:16%"><col style="width:8%">
              <col style="width:16%"><col style="width:40%">
            </colgroup>
            <thead><tr><th>Repeater</th><th>Network</th><th>Matched</th><th>Pass ranges</th><th>Stations (first 10)</th></tr></thead>
            <tbody>
              ${rptData.map(({ r, matched }) => `
                <tr onclick="goToStation('${escAttr(r.id)}')" style="cursor:pointer"
                    title="Open ${escAttr(r.name)} on the Stations tab">
                  <td>${esc(r.name)}</td>
                  <td class="small">${r.radio_network_ids.map(id => netName(id)).join(', ')}</td>
                  <td><span class="badge">${matched.length}</span></td>
                  <td class="small">${(r.repeater.pass_ranges || []).map(p => `${p.low}–${p.high}`).join(', ')}</td>
                  <td class="small">${matched.slice(0, 10).map(s => esc(s.name)).join(', ')}${matched.length > 10 ? ` +${matched.length - 10} more` : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>`}
        </div>
      </div>

      ${allOrphans.length ? `
        <div class="panel">
          <div class="panel-header">
            <h2 style="color:#c7401a">Orphaned Stations</h2>
            <span class="badge">${of(orphans.length, allOrphans.length)}</span>
          </div>
          <p class="small" style="color:var(--muted);margin:.5rem 0">
            These stations have an AlertID but no repeater's pass ranges cover it.
          </p>
          <div class="table-wrap medium">
            ${!orphans.length ? noMatch('No orphaned station matches this filter.') : `
            <table>
              <thead><tr><th>Name</th><th>Stn #</th><th>AlertID(s)</th><th>Network</th></tr></thead>
              <tbody>
                ${orphans.map(s => `
                  <tr onclick="goToStation('${escAttr(s.id)}')" style="cursor:pointer"
                      title="Open ${escAttr(s.name)} on the Stations tab">
                    <td>${esc(s.name)}</td>
                    <td class="small">${esc(s.station_number || '')}</td>
                    <td class="small">${stationAlertIds(s).join(', ')}</td>
                    <td class="small">${s.radio_network_ids.map(id => netName(id)).join(', ')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>`}
          </div>
        </div>` : ''}`;
}

function onPassRangeFilter(value) {
  state.prFilter = value;
  const el = document.getElementById('pr-tables');
  if (el) el.innerHTML = passRangeTablesHtml();
}

// ── BIT FLIPPER tab ────────────────────────────────────────────────────────────

const BF_TYPE_LABEL     = { battery: 'Battery', rainfall: 'Rainfall', water_level: 'Water Level', primary: 'Primary' };
const BF_MAX_RENDER_ROWS = 2000;   // safety cap for very large N-bit expansions
const ARRO_DEFAULT_BASE  = 'https://contrail-bom.onerain.au/graph/';
// Station of interest — the entered address. Ties the pinned table row (see
// .bf-row-base in styles.css) to its highlighted pin on the map below.
const BF_BASE_COLOR      = '#ff8c00';

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

  // Pin the station-of-interest row at the top. It is exempt from the sensor
  // filter — that filter narrows the flip variants being compared against the
  // entered address, not the address itself — so it stays listed, and fully
  // populated, alongside the ARRO link that always graphs it. With no station
  // behind the address at all there is nothing to pin but the bits, so the
  // "only matched" rule still applies.
  const showBase = baseRow.matches.length ? true : !state.bfOnlyMatches && !filter;
  if (showBase) rows = [baseRow, ...rows];

  const matchedCount = variants.filter(v => v.matches.length).length;

  // ARRO link across the station of interest plus every matched flip-variant
  // sensor that passes the current filter. The station of interest is never
  // filtered out — the sensor filter narrows what you compare it against, not
  // the address you actually asked about.
  const arroPairs = [...baseRow.matches, ...variants.flatMap(v => v.matches.filter(matchPasses))];
  const arro = buildArroUrl(arroPairs);

  const rowsHtml = rows.map(v => {
    const ms  = dedupeMatches(v.isBase ? v.matches : rowMatches(v));
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
    // The pinned, tinted row is the station of interest — it says so in the
    // tooltip rather than in the cell, which otherwise steals width from the
    // station, sensor and repeater columns that need it.
    const bitsCell = v.isBase
      ? `<span title="Station of interest — the ALERT address you entered">NA</span>`
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
            <colgroup>
              <col style="width:8%"><col style="width:8%"><col style="width:13%"><col style="width:5%">
              <col style="width:24%"><col style="width:10%"><col style="width:15%"><col style="width:17%">
            </colgroup>
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

  // The station of interest — whoever owns the address as entered. Always
  // plotted and always highlighted, including when it also turns up as a
  // flip-variant match (which would otherwise paint it like any other hit).
  (idx.get(base) || []).forEach(({ station: s }) => {
    if (!stationInfo.has(s.id)) stationInfo.set(s.id, { station: s, addrs: new Set(), bits: new Set() });
    const info = stationInfo.get(s.id);
    info.addrs.add(base);
    info.isBase = true;
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
  const baseMarkers = [];
  for (const { station: s, addrs, bits, isBase } of stationInfo.values()) {
    if (s.lat == null || s.lon == null) continue;
    const role  = primaryRole(s);
    const color = isBase ? BF_BASE_COLOR : (ROLE_COLOR[role] || ROLE_COLOR.field);

    // The station of interest gets a halo behind its pin and its name on the
    // map, so it can be picked out of a scatter of flip matches at a glance.
    if (isBase) {
      L.circleMarker([s.lat, s.lon], {
        radius: 17, color: BF_BASE_COLOR, weight: 2, opacity: 0.9,
        fillColor: BF_BASE_COLOR, fillOpacity: 0.18, interactive: false,
      }).addTo(layer);
    }

    const marker = L.circleMarker([s.lat, s.lon], {
      radius: isBase ? 10 : (s.roles.includes('repeater') ? 9 : 6),
      color: isBase ? '#ffffff' : color,
      fillColor: color, fillOpacity: 0.9,
      weight: isBase ? 3 : 1.5,
    }).addTo(layer);

    const bitsLabel = bits.size
      ? `<br><span style="font-size:.82rem">Flipped bits: ${[...bits].join(', ')}</span>`
      : '';
    const baseLabel = isBase
      ? `<span style="background:${BF_BASE_COLOR};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem;margin-left:4px">station of interest</span>`
      : '';
    marker.bindPopup(`
      <strong>${esc(s.name)}</strong>${baseLabel}<br>
      ${s.roles.map(r => `<span style="background:${ROLE_COLOR[r]};color:#fff;padding:1px 5px;border-radius:999px;font-size:.76rem;margin-right:2px">${r}</span>`).join('')}
      ${bitsLabel}
      <br><span style="font-size:.82rem">AlertID: ${[...addrs].sort((a, b) => a - b).join(', ')}</span>
    `);
    if (isBase) {
      marker.bindTooltip(esc(s.name), {
        permanent: true, direction: 'top', offset: [0, -12], className: 'mn-pin-label',
      });
      baseMarkers.push(marker);
    }
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

  // Repeater pins and link lines were added after the station pins, so lift the
  // station of interest back above them.
  baseMarkers.forEach(m => m.bringToFront());

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
  refreshFilterOptions();      // an edited role / network changes the option counts
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
  refreshFilterOptions();
  rerenderStations();
  rerenderStationEditorCard();
}

// ── Filter helpers ─────────────────────────────────────────────────────────────

// The grouped filters, in panel order. `alwaysOpen` groups are short enough to
// leave expanded; the rest collapse to a one-line "All / None / 3 of 15" summary
// so the panel stays readable with a dozen networks and twenty sensor types in it.
const FILTER_GROUPS = {
  roles: {
    title: 'Station type',
    alwaysOpen: true,
    dots: true,
  },
  sensors: {
    title: 'Sensor type',
    hint: 'Not every site measures everything — tick the readings you care about.',
    extra: () => `
      <label class="filter-check">
        <input type="checkbox" ${state.filters.sensorsAll ? 'checked' : ''}
               onchange="setSensorsAll(this.checked)">
        Must have <em>all</em> ticked types (not just one)
      </label>`,
  },
  networks: {
    title: 'Radio network',
    hint: `Networks are still being mapped, so most stations sit in "${FILTER_NONE_LABEL}" — ` +
          'they stay visible unless you untick that bucket.',
  },
  regions: {
    title: 'Region',
    hint: 'From the station\'s catchment. Regions are still being assigned.',
  },
};

// Contents of the Filters panel. Search on top, then one block per question the
// operator is actually asking (what kind of site, what does it measure, whose
// network, where), then the data-completeness block for finding gaps.
function stationFiltersHtml() {
  return `
    <div class="panel-header">
      <h3>Filters</h3>
      <button class="filter-reset" onclick="clearStationFilters()"
              ${anyStationFilterActive() ? '' : 'disabled'}>Reset</button>
    </div>
    <div class="filter-block">
      <label class="filter-field">
        <span>Search</span>
        <input type="search" placeholder="Name, station # or ALERT id…" value="${esc(state.filters.search)}"
               oninput="mapSearchInput(this.value)">
      </label>
      <p class="filter-note" id="map-match-note">${mapMatchNoteHtml()}</p>
    </div>
    ${Object.keys(FILTER_GROUPS).map(filterGroupHtml).join('')}
    ${filterAreaHtml()}
    ${filterDataHtml()}`;
}

function renderStationFilters() {
  const el = document.getElementById('station-filters');
  if (el) el.innerHTML = stationFiltersHtml();
}

// Editing or deleting a station moves the per-option counts (and can retire an
// option outright), so the cached lists are dropped and the panel redrawn.
function refreshFilterOptions() {
  state.filterOpts = null;
  if (state.activeTab === 'stations') renderStationFilters();
}

function filterGroupHtml(key) {
  const cfg  = FILTER_GROUPS[key];
  const opts = filterOptions()[key];
  if (!opts.length) return '';
  const head = `
    <span class="filter-title">${esc(cfg.title)}</span>
    <span class="filter-state" id="filter-state-${key}">${filterGroupState(key)}</span>`;
  const body = `
    ${cfg.hint ? `<p class="filter-hint">${cfg.hint}</p>` : ''}
    <div class="filter-actions">
      <button onclick="setGroupFilter('${key}','all')">All</button>
      <button onclick="setGroupFilter('${key}','none')">None</button>
    </div>
    ${cfg.extra ? cfg.extra() : ''}
    <div class="filter-list">${opts.map(o => filterRowHtml(key, o, cfg)).join('')}</div>`;
  return cfg.alwaysOpen
    ? `<div class="filter-block filter-group" id="filter-group-${key}">
         <div class="filter-head">${head}</div>${body}
       </div>`
    : `<details class="filter-block filter-group" id="filter-group-${key}"
                ${state.filterOpen[key] ? 'open' : ''} ontoggle="state.filterOpen['${key}']=this.open">
         <summary class="filter-head">${head}</summary>${body}
       </details>`;
}

// One option row: tick box + label + how many stations it covers, plus "only"
// — one click to narrow to that value alone, which beats un-ticking fourteen.
function filterRowHtml(key, o, cfg) {
  const set  = state.filters[key];
  const on   = !set.size || set.has(o.value);
  const dot  = cfg.dots && ROLE_COLOR[o.value]
    ? `<span class="legend-dot" style="background:${ROLE_COLOR[o.value]}"></span>` : '';
  const none = o.value === FILTER_NONE ? ' filter-row-none' : '';
  return `
    <div class="filter-row">
      <label class="filter-row-label${none}">
        <input type="checkbox" ${on ? 'checked' : ''}
               onchange="toggleGroupFilter('${key}','${escAttr(o.value)}',this.checked)">
        ${dot}<span>${esc(o.label)}</span>
      </label>
      <span class="filter-row-side">
        <span class="filter-count">${o.count}</span>
        <button class="filter-only" title="Show only ${esc(o.label)}"
                onclick="setGroupFilter('${key}','only','${escAttr(o.value)}')">only</button>
      </span>
    </div>`;
}

// Basin and council are long lists (65 basins, 100+ LGAs) and a station has at
// most one of each — a dropdown reads better than a hundred tick boxes.
function filterAreaHtml() {
  const opts = filterOptions();
  if (!opts.basins.length && !opts.lgas.length) return '';
  return `
    <details class="filter-block" id="filter-group-area" ${state.filterOpen.area ? 'open' : ''}
             ontoggle="state.filterOpen.area=this.open">
      <summary class="filter-head">
        <span class="filter-title">Basin &amp; council</span>
        <span class="filter-state" id="filter-state-area">${valueGroupState(['basin', 'lga'])}</span>
      </summary>
      ${filterSelectHtml('basin', 'Drainage basin', opts.basins)}
      ${filterSelectHtml('lga',   'Local government area', opts.lgas)}
    </details>`;
}

// Gap-hunting rather than day-to-day filtering: which sites have no position,
// no ALERT address, or are switched off.
function filterDataHtml() {
  return `
    <details class="filter-block" id="filter-group-data" ${state.filterOpen.data ? 'open' : ''}
             ontoggle="state.filterOpen.data=this.open">
      <summary class="filter-head">
        <span class="filter-title">Data completeness</span>
        <span class="filter-state" id="filter-state-data">${valueGroupState(['hasCoords', 'hasAlertId', 'enabledOnly'])}</span>
      </summary>
      <p class="filter-hint">For finding what still needs filling in.</p>
      ${filterChoiceHtml('hasCoords', 'Position', [
        ['',    'Any'],
        ['yes', 'Has lat/lon'],
        ['no',  'Missing lat/lon'],
      ])}
      ${filterChoiceHtml('hasAlertId', 'ALERT address', [
        ['',    'Any'],
        ['yes', 'Has an address'],
        ['no',  'No address on file'],
      ])}
      <label class="filter-check">
        <input type="checkbox" ${state.filters.enabledOnly ? 'checked' : ''}
               onchange="setValueFilter('enabledOnly',this.checked)">
        Enabled stations only
      </label>
    </details>`;
}

function filterSelectHtml(key, label, opts) {
  if (!opts.length) return '';
  const cur = state.filters[key];
  return `
    <label class="filter-field">
      <span>${esc(label)}</span>
      <select onchange="setValueFilter('${key}',this.value)">
        <option value="">Any</option>
        ${opts.map(o => `
          <option value="${escAttr(o.value)}" ${cur === o.value ? 'selected' : ''}>
            ${esc(o.label)} (${o.count})
          </option>`).join('')}
      </select>
    </label>`;
}

function filterChoiceHtml(key, label, choices) {
  return `
    <label class="filter-field">
      <span>${esc(label)}</span>
      <select onchange="setValueFilter('${key}',this.value)">
        ${choices.map(([v, l]) => `
          <option value="${escAttr(v)}" ${state.filters[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
    </label>`;
}

// Summary for the blocks made of single-value controls: how many are set.
function valueGroupState(keys) {
  const set = keys.filter(k => state.filters[k]).length;
  return set ? `${set} set` : 'Any';
}

// Keep the panel's live bits — group summaries, the match note and the Reset
// button — in step with the filters without rebuilding the whole panel (which
// would take the focus out of whatever the operator is clicking).
function updateFilterChrome() {
  Object.keys(FILTER_GROUPS).forEach(updateFilterGroupState);
  const area = document.getElementById('filter-state-area');
  if (area) area.textContent = valueGroupState(['basin', 'lga']);
  const data = document.getElementById('filter-state-data');
  if (data) data.textContent = valueGroupState(['hasCoords', 'hasAlertId', 'enabledOnly']);
  const reset = document.querySelector('#station-filters .filter-reset');
  if (reset) reset.disabled = !anyStationFilterActive();
  updateMapMatchNote();
}

// Option lists for the grouped filters, each entry { value, label, count }.
// Built from the loaded file (so a station.json with different networks, sensor
// types or regions filters itself correctly) and cached until the next load —
// counting sensor types across 3000+ stations on every keystroke would not be.
// Every group ends with the FILTER_NONE bucket when the file has stations that
// leave the field blank, and options nobody uses are dropped.
function filterOptions() {
  if (state.filterOpts) return state.filterOpts;
  const stations = state.data?.stations || [];

  // key → number of stations offering that key
  const tally = keyFn => {
    const counts = new Map();
    stations.forEach(s => keyFn(s).forEach(k => counts.set(k, (counts.get(k) || 0) + 1)));
    return counts;
  };
  // Named options first (in the order the file lists them), then whatever the
  // stations mention that the file never declared, then the "not recorded" bucket.
  const build = (counts, named, { sort } = {}) => {
    const out  = [];
    const seen = new Set();
    named.forEach(({ value, label }) => {
      seen.add(value);
      out.push({ value, label, count: counts.get(value) || 0 });
    });
    const extra = [...counts.keys()].filter(k => !seen.has(k) && k !== FILTER_NONE)
      .map(value => ({ value, label: value, count: counts.get(value) }));
    if (sort === 'count') extra.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    else                  extra.sort((a, b) => a.label.localeCompare(b.label));
    out.push(...extra);
    if (counts.get(FILTER_NONE)) {
      out.push({ value: FILTER_NONE, label: FILTER_NONE_LABEL, count: counts.get(FILTER_NONE) });
    }
    return out.filter(o => o.count > 0);
  };

  const regionNames = [...new Set((state.data?.catchments || []).map(c => c.region).filter(Boolean))].sort();

  state.filterOpts = {
    roles:    build(tally(stationRoleKeys),
                    Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }))),
    sensors:  build(tally(stationSensorTypeKeys), [], { sort: 'count' }),
    networks: build(tally(stationNetworkKeys),
                    (state.data?.radio_networks || []).map(n => ({ value: n.id, label: n.name }))),
    regions:  build(tally(stationRegionKeys), regionNames.map(r => ({ value: r, label: r }))),
    basins:   build(tally(s => groupKeys(s.basin ? [s.basin] : [])), []),
    lgas:     build(tally(s => groupKeys(s.lga   ? [s.lga]   : [])), []),
  };
  return state.filterOpts;
}

function filterGroupValues(key) {
  return filterOptions()[key].map(o => o.value);
}

// One checkbox in a grouped filter. The Set is kept canonical: empty when
// everything is ticked (the default, "no constraint") and holding FILTER_EMPTY
// when nothing is — so what the boxes show and what the filter does can never
// drift apart, which is what made un-ticking a network a no-op before.
function toggleGroupFilter(key, value, checked) {
  const set    = state.filters[key];
  const values = filterGroupValues(key);
  if (!set.size && !checked) values.forEach(v => set.add(v));   // "all" → the real list, minus one
  set.delete(FILTER_EMPTY);
  if (checked) set.add(value);
  else         set.delete(value);
  if (!set.size)                    set.add(FILTER_EMPTY);      // hand-emptied ≠ show everything
  else if (set.size === values.length) set.clear();             // back to the full list → "all"
  stationsFilterChanged();
}

// "All" / "None" / a row's "only" — the whole group re-renders, since these
// move every checkbox at once.
function setGroupFilter(key, mode, value) {
  state.filters[key] = mode === 'all'  ? new Set()
                     : mode === 'none' ? new Set([FILTER_EMPTY])
                     :                   new Set([value]);
  rerenderFilterGroup(key);
  stationsFilterChanged();
}

function setValueFilter(key, value) {
  state.filters[key] = value;
  stationsFilterChanged();
}

function setSensorsAll(checked) {
  state.filters.sensorsAll = checked;
  stationsFilterChanged();
}

// "All" / "None" / "3 of 15" — the at-a-glance state of a collapsed group.
function filterGroupState(key) {
  const set = state.filters[key];
  if (!set.size)              return 'All';
  if (set.has(FILTER_EMPTY))  return 'None';
  return `${set.size} of ${filterGroupValues(key).length}`;
}

function updateFilterGroupState(key) {
  const el = document.getElementById(`filter-state-${key}`);
  if (el) el.textContent = filterGroupState(key);
}

function rerenderFilterGroup(key) {
  const el = document.getElementById(`filter-group-${key}`);
  if (el) el.outerHTML = filterGroupHtml(key, el.dataset.title, el.dataset.hint);
}

// Anything narrowing the station list? Every group is canonical, so a non-empty
// Set is by definition a real constraint.
function anyStationFilterActive() {
  const f = state.filters;
  return !!(f.search.trim() || f.roles.size || f.sensors.size || f.networks.size ||
            f.regions.size || f.catchments.size || f.basin || f.lga ||
            f.hasCoords || f.hasAlertId || f.enabledOnly);
}

function resetStationFilters() {
  // The ACMA block keeps its own state — clearing station filters should not
  // silently drop an RF layer the operator has configured.
  state.filters = {
    search: '', roles: new Set(), sensors: new Set(), networks: new Set(),
    regions: new Set(), catchments: new Set(), sensorsAll: false,
    basin: '', lga: '', hasCoords: '', hasAlertId: '', enabledOnly: false,
    acma: state.filters.acma,
  };
}

// Reset button on the Stations tab: clear everything and redraw the panel with
// it (the boxes, the selects and the summaries all move at once).
function clearStationFilters() {
  resetStationFilters();
  renderStationFilters();
  stationsFilterChanged();
}

function toggleFilter(key, value, checked) {
  // The ACMA block's mechanism list is a plain Set with no "empty means all"
  // convention — the station groups go through toggleGroupFilter instead.
  const set = key === 'acmaMechanisms' ? state.filters.acma.mechanisms : state.filters[key];
  if (checked) set.add(value);
  else         set.delete(value);
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

// ── ACMA RRL interference layer ─────────────────────────────────────────────────
// Renders licensed transmitters from the ACMA Register of Radiocommunications
// Licences that could plausibly interfere with MegaNet repeater RX channels.
// All data is precomputed offline by tools/acma_fetch.py into data/acma-*.json;
// nothing here fetches until the master toggle is switched on (or the RF
// Environment tab is opened), so page load is unaffected while the layer is off.
// Contains ACMA RRL data, CC BY 4.0.

const ACMA_MECH = {
  co_channel:     { label: 'Co-channel',          color: '#d32f2f' },
  adjacent:       { label: 'Adjacent channel',    color: '#f57c00' },
  imd3:           { label: 'Intermod IMD3',       color: '#7b1fa2' },
  imd5:           { label: 'Intermod IMD5',       color: '#ce93d8' },
  imd3_triple:    { label: 'Intermod 3-signal',   color: '#9575cd' },
  harmonic:       { label: 'Harmonic',            color: '#0288d1' },
  cosite_desense: { label: 'Co-site desense',     color: '#6d4c41' },
};

// ACMA VHF High Band Frequency Band Plan segments (148–174 MHz). MegaNet's
// 151.5 MHz sits in Segment F "Miscellaneous Service".
const VHF_SEGMENTS = [
  { seg: 'A', lo: 148.00000, hi: 149.25000, alloc: 'Paging Service' },
  { seg: 'B', lo: 149.25000, hi: 149.75625, alloc: 'Land Mobile (two frequency, base transmit)' },
  { seg: 'C', lo: 149.75625, hi: 149.90000, alloc: 'Land Mobile (single frequency)' },
  { seg: 'D', lo: 149.90000, hi: 150.05000, alloc: 'Radionavigation Satellite' },
  { seg: 'E', lo: 150.05000, hi: 151.39375, alloc: 'Land Mobile (two frequency, base transmit); Fixed (rural)' },
  { seg: 'F', lo: 151.39375, hi: 152.49375, alloc: 'Miscellaneous Service' },
  { seg: 'G', lo: 152.49375, hi: 153.85000, alloc: 'Land Mobile (single frequency)' },
  { seg: 'H', lo: 153.85000, hi: 154.35625, alloc: 'Land Mobile (two frequency, base receive)' },
  { seg: 'I', lo: 154.35625, hi: 154.65625, alloc: 'Land Mobile (single frequency)' },
  { seg: 'J', lo: 154.65625, hi: 156.00000, alloc: 'Land Mobile (two frequency, base receive); Fixed (rural)' },
  { seg: 'K', lo: 156.00000, hi: 157.45000, alloc: 'Maritime Mobile' },
  { seg: 'L', lo: 157.45000, hi: 158.29375, alloc: 'Land Mobile (two frequency, base receive) or single frequency' },
  { seg: 'M', lo: 158.29375, hi: 160.60000, alloc: 'Land Mobile (two frequency, base receive)' },
  { seg: 'N', lo: 160.60000, hi: 160.97500, alloc: 'Maritime Mobile' },
  { seg: 'O', lo: 160.97500, hi: 161.47500, alloc: 'Land Mobile (single frequency)' },
  { seg: 'P', lo: 161.47500, hi: 162.05000, alloc: 'Maritime Mobile' },
  { seg: 'Q', lo: 162.05000, hi: 162.89375, alloc: 'Land Mobile (two frequency, base transmit) or single frequency' },
  { seg: 'R', lo: 162.89375, hi: 165.19375, alloc: 'Land Mobile (two frequency, base transmit)' },
  { seg: 'S', lo: 165.19375, hi: 168.19375, alloc: 'Land Mobile (trunked, base transmit)' },
  { seg: 'T', lo: 168.19375, hi: 169.79375, alloc: 'Land Mobile (single frequency)' },
  { seg: 'U', lo: 169.79375, hi: 172.79375, alloc: 'Land Mobile (trunked, base receive)' },
  { seg: 'V', lo: 172.79375, hi: 173.29375, alloc: 'Land Mobile (single frequency)' },
  { seg: 'W', lo: 173.29375, hi: 174.00000, alloc: 'Miscellaneous Service' },
];

const ACMA_MARKER_CAP = 500;
const ACMA_LINK_CAP   = 300;

function vhfSegment(mhz) {
  return VHF_SEGMENTS.find(s => mhz >= s.lo && mhz < s.hi) || null;
}

function acmaHaversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── lazy loading ──

function acmaFetchJson(name) {
  return fetch(`data/${name}`).then(r => {
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
  });
}

function acmaEnsureCore() {
  const A = state.acma;
  if (A.loaded) return Promise.resolve();
  if (A.loadPromise) return A.loadPromise;
  A.loading = true;
  A.loadPromise = Promise.all([
    acmaFetchJson('acma-threats.json'),
    acmaFetchJson('acma-sites.json'),
    acmaFetchJson('acma-dictionaries.json').catch(() => null),   // optional
  ]).then(([threats, sites, dicts]) => {
    A.threats = threats;
    A.dicts   = dicts;
    A.siteById = {};
    sites.sites.forEach(s => { A.siteById[s.id] = s; });
    A.anchorById = {};
    A.flat = [];
    A.pairsByDevice = {};
    threats.anchors.forEach(a => {
      A.anchorById[a.station_id] = a;
      a.threats.forEach(t =>
        A.flat.push({ anchor_id: a.station_id, anchor_name: a.name, rx_mhz: a.rx_mhz, ...t }));
      (a.imd_pairs || []).forEach(p => {
        (A.pairsByDevice[p.a] = A.pairsByDevice[p.a] || []).push(p);
        (A.pairsByDevice[p.b] = A.pairsByDevice[p.b] || []).push(p);
      });
    });
    A.mechCounts = {};
    A.flat.forEach(t => { A.mechCounts[t.mechanism] = (A.mechCounts[t.mechanism] || 0) + 1; });
    A.loaded = true;
    A.loading = false;
    A.error = null;
  }).catch(err => {
    A.loading = false;
    A.loadPromise = null;
    A.error = `ACMA data unavailable (${err.message}). Generate data/acma-*.json with ` +
              `tools/acma_fetch.py; note these optional files cannot be fetched over file://.`;
    state.filters.acma.show = false;
    throw err;
  });
  return A.loadPromise;
}

// Full device/licence/client detail — several MB, loaded on first card open,
// beam-wedge draw or RF strip plot, never at page load.
function acmaEnsureDevices() {
  const A = state.acma;
  if (A.devLoaded) return Promise.resolve();
  if (A.devPromise) return A.devPromise;
  A.devPromise = acmaFetchJson('acma-devices.json').then(d => {
    A.deviceById = {}; A.devicesBySite = {};
    d.devices.forEach(x => {
      A.deviceById[x.id] = x;
      (A.devicesBySite[x.site_id] = A.devicesBySite[x.site_id] || []).push(x);
    });
    A.licById    = d.licences || {};
    A.clientById = d.clients  || {};
    A.antById    = d.antennas || {};
    A.texts      = d.texts    || [];
    A.devLoaded  = true;
  }).catch(err => {
    A.devPromise = null;
    throw err;
  });
  return A.devPromise;
}

// ── filtering ──

function acmaVisibleThreats(ignoreAnchorSel) {
  const A = state.acma, f = state.filters.acma;
  if (!A.loaded) return [];
  return A.flat.filter(t =>
    f.mechanisms.has(t.mechanism) &&
    t.score >= f.minScore &&
    t.distance_km <= f.radiusKm &&
    (!f.losOnly || t.los === true) &&
    (!f.activeOnly || !t.inactive) &&
    (!f.hideMeganet || !t.meganet) &&
    (ignoreAnchorSel || !A.selectedAnchorId || t.anchor_id === A.selectedAnchorId));
}

// ── filters panel block ──

// The master toggle sits outside the collapsible block: ACMA transmitters are
// drawn by default, so the way to turn them off has to be visible without
// hunting through a closed twisty.
function acmaFilterBlockHtml() {
  return `<div id="acma-filter-block">${acmaFilterHeadHtml()}</div>`;
}

function acmaFilterHeadHtml() {
  const A = state.acma, f = state.filters.acma;
  return `
    <label class="filter-check">
      <input type="checkbox" ${f.show ? 'checked' : ''} onchange="toggleAcmaShow(this.checked)">
      Show ACMA licensed transmitters
    </label>
    ${A.error ? `<div class="small" style="color:var(--muted)">${esc(A.error)}</div>` : ''}
    ${A.loading ? `<div class="small" style="color:var(--muted)">Loading ACMA data…</div>` : ''}
    ${f.show && A.loaded ? `
      <details ${A.uiOpen ? 'open' : ''} ontoggle="state.acma.uiOpen=this.open">
        <summary class="small" style="cursor:pointer;color:var(--muted)">ACMA / RF Environment options</summary>
        <div id="acma-filter-body">${acmaFilterBodyHtml()}</div>
      </details>` : ''}`;
}

function acmaFilterBodyHtml() {
  const A = state.acma, f = state.filters.acma;
  if (!f.show || !A.loaded) return '';

  const meta = A.threats.meta;
  const anchorChip = A.selectedAnchorId ? `
    <div class="small" style="margin:.25rem 0">
      Filtering to <strong>${esc((A.anchorById[A.selectedAnchorId] || {}).name || A.selectedAnchorId)}</strong>
      <a href="#" onclick="acmaSelectAnchor('');return false">×&nbsp;clear</a>
    </div>` : '';

  return `
    <div class="small" style="color:var(--muted);margin:.2rem 0">
      ACMA data: ${esc(meta.source_date)} · <span id="acma-shown"></span>
    </div>
    ${anchorChip}
    <div style="margin:.4rem 0">
      ${Object.entries(ACMA_MECH).filter(([k]) => A.mechCounts[k]).map(([k, m]) => `
        <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.15rem 0">
          <input type="checkbox" ${f.mechanisms.has(k) ? 'checked' : ''}
                 onchange="toggleFilter('acmaMechanisms','${k}',this.checked);refreshAcmaLayer()">
          <span class="legend-sq" style="background:${m.color}"></span>
          ${m.label} (${A.mechCounts[k]})
        </label>`).join('')}
    </div>
    <label class="small" style="display:block;margin:.4rem 0">
      Minimum score <strong id="acma-minscore-val">${f.minScore}</strong>
      <input type="range" min="0" max="100" step="5" value="${f.minScore}" style="width:100%"
             oninput="state.filters.acma.minScore=+this.value;document.getElementById('acma-minscore-val').textContent=this.value"
             onchange="refreshAcmaLayer()">
    </label>
    <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.2rem 0">
      <input type="checkbox" ${f.losOnly ? 'checked' : ''}
             onchange="state.filters.acma.losOnly=this.checked;refreshAcmaLayer()">
      Line-of-sight only <span class="small" style="color:var(--muted)">(not yet assessed — hides all)</span>
    </label>
    <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.2rem 0">
      <input type="checkbox" ${f.activeOnly ? 'checked' : ''}
             onchange="state.filters.acma.activeOnly=this.checked;refreshAcmaLayer()">
      Current licences only
    </label>
    <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.2rem 0">
      <input type="checkbox" ${f.hideMeganet ? 'checked' : ''}
             onchange="state.filters.acma.hideMeganet=this.checked;refreshAcmaLayer()">
      Hide MegaNet's own licences
    </label>
    <label class="small" style="display:block;margin:.35rem 0">
      Search radius
      <select onchange="state.filters.acma.radiusKm=+this.value;refreshAcmaLayer()">
        ${[10, 25, 50, 100].map(r => `
          <option value="${r}" ${f.radiusKm === r ? 'selected' : ''}>${r} km</option>`).join('')}
      </select>
      <span style="color:var(--muted)">(data extends to ${meta.radius_km} km)</span>
    </label>
    <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.2rem 0">
      <input type="checkbox" ${f.showBeams ? 'checked' : ''}
             onchange="state.filters.acma.showBeams=this.checked;refreshAcmaLayer()">
      Show antenna beam wedges
    </label>
    <label style="display:flex;gap:.45rem;align-items:center;font-size:.88rem;margin:.2rem 0">
      <input type="checkbox" ${f.showLinks ? 'checked' : ''}
             onchange="state.filters.acma.showLinks=this.checked;refreshAcmaLayer()">
      Show threat links
    </label>
    <details style="margin:.4rem 0">
      <summary class="small" style="cursor:pointer">? What the mechanisms mean</summary>
      <div class="small" style="color:var(--muted);margin-top:.3rem">
        <p><strong>Co-channel</strong>: transmits on the repeater's RX frequency — direct
        collisions and capture. <strong>Adjacent</strong>: within 50 kHz — splatter raises the
        noise floor until marginal packets flip bits. <strong>Harmonic</strong>: a transmitter at
        1/2…1/5 of the RX frequency whose harmonics land on it. <strong>IMD3/IMD5</strong>:
        two transmitters at the same ACMA site whose intermod products (2f1−f2, 3f1−2f2)
        land on the RX channel — the "rusty bolt" effect; the prime suspect when corruption
        clusters behind one repeater. <strong>Co-site desense</strong>: any strong transmitter
        physically at the repeater site overloading the receiver front-end, regardless of
        frequency — the only mechanism where cellular towers matter.</p>
        <p><strong>Not threats</strong>: mobile phone towers (700 MHz+, no spectral path to
        151.5 MHz — co-siting only), LoRa/LoRaWAN (915–928 MHz), UHF CB (477 MHz).</p>
        <p><strong>Blind spots</strong>: amateur radio isn't in the RRL by location (the
        50.5 MHz × 3 harmonic path needs a spectrum sweep, not this database); unlicensed
        or faulty emitters (solar controllers, VMS signs, electric fences, powerline arcing)
        have no licence record; the RRL records what's <em>licensed</em>, not what's
        <em>radiating</em>; IMD detection only sees devices ACMA records at the same site;
        line-of-sight is not yet assessed and would be terrain-only — it cannot model the
        tropospheric ducting that worsens during flood events.</p>
      </div>
    </details>`;
}

function rerenderAcmaFilterBlock() {
  const el = document.getElementById('acma-filter-block');
  if (el) el.innerHTML = acmaFilterHeadHtml();
}

function toggleAcmaShow(checked) {
  state.filters.acma.show = checked;
  if (!checked) {
    closeAcmaCard();
    refreshAcmaLayer();
    rerenderAcmaFilterBlock();
    rerenderMapLegend();
    return;
  }
  // Legend and filter body gain the ACMA entries once the data lands; both are
  // patched in place so the operator keeps their pan and zoom.
  acmaEnsureCore().then(() => {
    if (state.activeTab === 'stations' && state.map) acmaAfterLoad();
  }).catch(() => rerenderAcmaFilterBlock());
  rerenderAcmaFilterBlock();
}

function acmaSelectAnchor(id) {
  state.acma.selectedAnchorId = id || null;
  refreshAcmaLayer();
  rerenderAcmaFilterBlock();
}

// Link appended to MegaNet repeater popups on the map: "N RF threats".
function acmaRepeaterPopupExtra(s) {
  const A = state.acma;
  if (!state.filters.acma.show || !A.loaded) return '';
  const a = A.anchorById[s.id];
  if (!a || !a.threats.length) return '';
  return `<br><a href="#" style="font-size:.83rem"
    onclick="acmaSelectAnchor('${escAttr(s.id)}');return false">⚠ ${a.threats.length} RF threat candidates — filter map</a>`;
}

// ── map layer ──

// Trim to a marker/line budget without letting one mechanism eat the lot.
//
// A flat "top N by score" cut looks fair and isn't: co-site desense outnumbers
// every other mechanism roughly 8:1 in the RRL extract and its scores sit at the
// top of the range (same site ⇒ no distance discount), so the first ~1300 devices
// by score are all co-site. With a 500-pin cap that meant the map only ever drew
// brown squares — co-channel, IMD and harmonic pins were filtered in, ranked, and
// then cut, so ticking their boxes did nothing until co-site desense was ticked
// off. Deal one item per mechanism per round instead, highest score first within
// each: a crowded mechanism loses its tail rather than erasing the rare ones, and
// mechanisms with fewer devices than the budget always draw in full.
//
// `items` must already be sorted best-first; the returned subset keeps that order.
function acmaCapByMechanism(items, cap, mechOf) {
  if (items.length <= cap) return items;
  const queues = new Map();
  items.forEach((it, i) => {
    const k = mechOf(it);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(i);
  });
  const lists = [...queues.values()];
  const picked = [];
  for (let round = 0; picked.length < cap; round++) {
    let drew = false;
    for (const l of lists) {
      if (round >= l.length) continue;
      picked.push(l[round]);
      drew = true;
      if (picked.length >= cap) break;
    }
    if (!drew) break;             // every queue exhausted
  }
  return picked.sort((a, b) => a - b).map(i => items[i]);
}

function refreshAcmaLayer() {
  const A = state.acma, map = state.map;
  if (!map) return;
  MapSpider.reset();                 // fanned pins go home before any are removed
  ['layer', 'beamLayer', 'linkLayer', 'hiLayer'].forEach(k => {
    if (A[k]) { A[k].remove(); A[k] = null; }
  });
  const f = state.filters.acma;
  if (!f.show || !A.loaded) { MapSpider.setPins('acma', []); acmaUpdateShownNote(0, 0); return; }

  const visible = acmaVisibleThreats();

  // one marker per device, driven by its top-scoring visible threat
  const byDevice = new Map();
  for (const t of visible) {
    const cur = byDevice.get(t.device_id);
    if (!cur || t.score > cur.top.score) {
      byDevice.set(t.device_id, { top: t, all: cur ? cur.all : [] });
    }
    byDevice.get(t.device_id).all.push(t);
  }
  const devices = [...byDevice.values()].sort((a, b) => b.top.score - a.top.score);
  const shown = acmaCapByMechanism(devices, ACMA_MARKER_CAP, d => d.top.mechanism);
  acmaUpdateShownNote(shown.length, devices.length);

  A.layer = L.layerGroup().addTo(map);
  const acmaPins = [];
  for (const d of shown) {
    const t = d.top;
    const site = A.siteById[t.site_id];
    if (!site) continue;
    const mech = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
    const size = Math.round(9 + t.score / 8);
    const icon = L.divIcon({
      className: 'acma-div',
      html: `<div class="acma-sq${t.meganet ? ' mn' : ''}" style="width:${size}px;height:${size}px;background:${mech.color}"></div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    });
    const m = L.marker([site.lat, site.lon], { icon }).addTo(A.layer);
    m.bindPopup(acmaPopupHtml(d, site), { maxWidth: 300 });
    m.on('click', () => acmaHighlightDevice(t.device_id));
    m.bindTooltip(`${esc(t.client || 'Unknown licensee')} · ${mech.label} · ${t.score}`);
    acmaPins.push(m);
  }
  // Several licensed devices commonly share one site, so these are the pins that
  // most need fanning out.
  MapSpider.setPins('acma', acmaPins);

  if (f.showLinks) {
    A.linkLayer = L.layerGroup().addTo(map);
    const links = acmaCapByMechanism(
      visible.slice().sort((a, b) => b.score - a.score), ACMA_LINK_CAP, t => t.mechanism);
    for (const t of links) {
      const site = A.siteById[t.site_id], a = A.anchorById[t.anchor_id];
      if (!site || !a) continue;
      L.polyline([[site.lat, site.lon], [a.lat, a.lon]], {
        color: (ACMA_MECH[t.mechanism] || {}).color || '#666',
        weight: 1.2, dashArray: '4 4',
        opacity: 0.15 + 0.55 * Math.min(1, t.score / 70),
      }).addTo(A.linkLayer);
    }
  }

  if (f.showBeams) {
    if (!A.devLoaded) {
      acmaEnsureDevices().then(() => refreshAcmaLayer()).catch(() => {});
    } else {
      A.beamLayer = L.layerGroup().addTo(map);
      for (const d of shown) {
        const dev = A.deviceById[d.top.device_id];
        const site = A.siteById[d.top.site_id];
        const ant = dev && dev.ant ? A.antById[dev.ant] : null;
        if (!dev || !site || dev.az == null || !ant || !ant.h_bw || ant.h_bw <= 0 || ant.h_bw >= 360) continue;
        const poly = acmaBeamPolygon(site.lat, site.lon, dev.az, Math.min(ant.h_bw, 120),
                                     acmaBeamRangeKm(dev.eirp_w));
        L.polygon(poly, {
          color: (ACMA_MECH[d.top.mechanism] || {}).color || '#666',
          weight: 1, fillOpacity: 0.08, opacity: 0.5,
        }).addTo(A.beamLayer);
      }
    }
  }
}

function acmaUpdateShownNote(shown, total) {
  const el = document.getElementById('acma-shown');
  if (el) el.textContent = total > shown
    ? `showing ${shown} of ${total} transmitters (top by score, shared across mechanisms)`
    : `${total} transmitters shown`;
}

function acmaBeamRangeKm(eirpW) {
  if (!eirpW || eirpW <= 1) return 1.5;
  return Math.max(1.5, Math.min(12, 2 + 2.5 * Math.log10(eirpW)));
}

function acmaBeamPolygon(lat, lon, azDeg, widthDeg, rangeKm) {
  const pts = [[lat, lon]];
  const degLat = rangeKm / 110.574;
  const degLon = rangeKm / (111.320 * Math.cos(lat * Math.PI / 180));
  for (let a = azDeg - widthDeg / 2; a <= azDeg + widthDeg / 2 + 0.01; a += Math.max(2, widthDeg / 12)) {
    const rad = a * Math.PI / 180;
    pts.push([lat + Math.cos(rad) * degLat, lon + Math.sin(rad) * degLon]);
  }
  pts.push([lat, lon]);
  return pts;
}

// Emphasised links from one device to every repeater it threatens.
function acmaHighlightDevice(deviceId) {
  const A = state.acma, map = state.map;
  if (!map || !A.loaded) return;
  acmaClearHighlight();
  A.hiLayer = L.layerGroup().addTo(map);
  for (const t of acmaVisibleThreats()) {
    if (t.device_id !== deviceId) continue;
    const site = A.siteById[t.site_id], a = A.anchorById[t.anchor_id];
    if (!site || !a) continue;
    L.polyline([[site.lat, site.lon], [a.lat, a.lon]], {
      color: (ACMA_MECH[t.mechanism] || {}).color || '#666',
      weight: 3, opacity: 0.9,
    }).addTo(A.hiLayer);
  }
}

function acmaClearHighlight() {
  if (state.acma.hiLayer) { state.acma.hiLayer.remove(); state.acma.hiLayer = null; }
}

// ── popup + transmitter card ──

function acmaPopupHtml(d, site) {
  const t = d.top;
  const mech = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
  const others = d.all.length - 1;
  return `
    <strong>${esc((site && site.name) || 'Unknown site')}</strong><br>
    <span style="font-size:.83rem">${esc(t.client || 'Unknown licensee')} · score ${t.score}</span><br>
    <span style="background:${mech.color};color:#fff;padding:1px 6px;border-radius:999px;font-size:.78rem">${mech.label}</span>
    ${t.meganet ? '<span class="badge">MegaNet licence</span>' : ''}<br>
    <span style="font-size:.83rem">${esc(t.detail)}</span><br>
    <span style="font-size:.83rem">${t.f_mhz != null ? t.f_mhz.toFixed(4) + ' MHz · ' : ''}${t.distance_km} km @ ${t.bearing_deg}° from ${esc(t.anchor_name)}</span><br>
    <span style="font-size:.83rem">Licence ${esc(t.lic || '?')}${t.expiry ? ' · expires ' + esc(t.expiry) : ''}${t.inactive ? ' · <strong>not current</strong>' : ''}</span>
    ${others > 0 ? `<br><span style="font-size:.8rem;color:#888">+${others} more mechanism/repeater match${others > 1 ? 'es' : ''}</span>` : ''}<br>
    <a href="#" onclick="showAcmaCard('${escAttr(t.device_id)}','${escAttr(t.anchor_id)}');return false">Full details →</a>`;
}

function showAcmaCard(deviceId, anchorId) {
  state.acma.cardDeviceId = deviceId;
  state.acma.cardAnchorId = anchorId || null;
  const el = document.getElementById('acma-card');
  if (el) {
    el.hidden = false;
    el.innerHTML = '<div class="small" style="padding:1rem;color:var(--muted)">Loading transmitter details…</div>';
  }
  acmaEnsureDevices().then(() => renderAcmaCard()).catch(err => {
    if (el) el.innerHTML = `<div class="small" style="padding:1rem;color:var(--muted)">
      Device detail unavailable (${esc(err.message)}).</div>`;
  });
  acmaHighlightDevice(deviceId);
}

function closeAcmaCard() {
  state.acma.cardDeviceId = null;
  const el = document.getElementById('acma-card');
  if (el) { el.hidden = true; el.innerHTML = ''; }
  acmaClearHighlight();
}

function acmaCardRow(label, value) {
  return value == null || value === '' ? '' :
    `<div class="acma-row"><span>${label}</span><span>${value}</span></div>`;
}

function renderAcmaCard() {
  const A = state.acma;
  const el = document.getElementById('acma-card');
  const dev = A.deviceById[A.cardDeviceId];
  if (!el || !dev) return;
  const site   = A.siteById[dev.site_id] || {};
  const lic    = A.licById[dev.lic] || {};
  const client = A.clientById[lic.client_no] || {};
  const ant    = dev.ant ? (A.antById[dev.ant] || {}) : {};
  const myThreats = A.flat.filter(t => t.device_id === dev.id);
  const top = myThreats.slice().sort((a, b) => b.score - a.score)[0];
  const seg = dev.f_mhz != null ? vhfSegment(dev.f_mhz) : null;
  const noteIdxs = [...new Set([...(dev.notes || []), ...(lic.notes || [])])];
  const notes = noteIdxs.map(i => A.texts[i]).filter(Boolean);
  const cosited = (A.devicesBySite[dev.site_id] || []).filter(d => d.id !== dev.id);
  const partnerIds = new Set();
  (A.pairsByDevice[dev.id] || []).forEach(p => { partnerIds.add(p.a === dev.id ? p.b : p.a); });
  const anchor = A.cardAnchorId ? A.anchorById[A.cardAnchorId] : null;
  const distLine = anchor && top
    ? `${top.distance_km} km @ ${String(top.bearing_deg).padStart(3, '0')}° from ${esc(anchor.name)}` : null;

  el.hidden = false;
  el.innerHTML = `
    <div class="acma-card-head">
      <span>
        <strong>${esc(site.name || 'Unknown site')}</strong><br>
        <span class="small" style="color:var(--muted)">${esc(client.trading || client.name || 'Unknown licensee')}</span>
      </span>
      <span>${top ? `score ${top.score}` : ''}
        <button onclick="closeAcmaCard()" title="Close">×</button></span>
    </div>
    ${myThreats.length ? `
      <div class="acma-sect">
        ${myThreats.sort((a, b) => b.score - a.score).map(t => {
          const m = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
          return `<div class="small" style="margin:.15rem 0">
            <span class="legend-sq" style="background:${m.color}"></span>
            <strong>${m.label}</strong> ${t.score} vs ${esc(t.anchor_name)}<br>
            <span style="color:var(--muted)">${esc(t.detail)} —
              w ${t.components.mechanism_weight} × dist ${t.components.distance_factor}
              × pwr ${t.components.power_factor} × LOS ${t.components.los_factor}</span>
          </div>`;
        }).join('')}
      </div>` : ''}
    <div class="acma-sect"><h4>RF</h4>
      ${acmaCardRow('Frequency', dev.f_mhz != null ? dev.f_mhz.toFixed(4) + ' MHz' : null)}
      ${acmaCardRow('Bandwidth', dev.bw_khz != null ? dev.bw_khz + ' kHz' : null)}
      ${acmaCardRow('Emission', esc(dev.emission))}
      ${acmaCardRow('TX power', dev.tx_w != null ? dev.tx_w + ' W' : null)}
      ${acmaCardRow('EIRP', dev.eirp_w != null ? dev.eirp_w + ' W' : null)}
      ${acmaCardRow('Segment', seg ? `${seg.seg} — ${esc(seg.alloc)}` : null)}
      ${acmaCardRow('Mode', esc(dev.mode))}
      ${acmaCardRow('Operation hours', esc(dev.hours === '00:00-23:59' ? 'Continuous' : dev.hours))}
      ${acmaCardRow('Station class', esc(dev.station_class))}
      ${acmaCardRow('Authorised', esc(dev.authorised))}
    </div>
    ${Object.keys(ant).length ? `
    <div class="acma-sect"><h4>Antenna</h4>
      ${acmaCardRow('Type / model', esc([ant.type, ant.manufacturer, ant.model].filter(Boolean).join(' · ')))}
      ${acmaCardRow('Height', dev.height_m != null ? dev.height_m + ' m' : null)}
      ${acmaCardRow('Gain', ant.gain_dbi != null ? ant.gain_dbi + ' dBi' : null)}
      ${acmaCardRow('Azimuth / tilt', dev.az != null ? `${dev.az}° / ${dev.tilt != null ? dev.tilt + '°' : '—'}` : null)}
      ${acmaCardRow('H-beamwidth', ant.h_bw ? ant.h_bw + '°' : null)}
      ${acmaCardRow('Polarisation', esc(dev.pol))}
      ${acmaCardRow('Feeder loss', dev.feeder_db != null ? dev.feeder_db + ' dB' : null)}
    </div>` : ''}
    <div class="acma-sect"><h4>Site</h4>
      ${acmaCardRow('Elevation', site.elevation_m != null ? site.elevation_m + ' m' : null)}
      ${acmaCardRow('Coordinate precision', esc(site.precision))}
      ${acmaCardRow('Devices at site', site.device_count)}
      ${acmaCardRow('Distance', distLine)}
      ${acmaCardRow('Line of sight', top ? 'not assessed' : null)}
    </div>
    <div class="acma-sect"><h4>Licence</h4>
      ${acmaCardRow('Licence no.', esc(dev.lic))}
      ${acmaCardRow('Status', esc(lic.status))}
      ${acmaCardRow('Type', esc(lic.type))}
      ${acmaCardRow('Category', esc(lic.category))}
      ${acmaCardRow('Service', esc(dev.service || lic.service))}
      ${acmaCardRow('Subservice', esc(dev.subservice || lic.subservice))}
      ${acmaCardRow('Issued', esc(lic.issued))}
      ${acmaCardRow('Expires', esc(lic.expiry))}
      ${acmaCardRow('Callsign', esc(dev.callsign))}
    </div>
    <div class="acma-sect"><h4>Licensee</h4>
      ${acmaCardRow('Client', esc(client.name))}
      ${acmaCardRow('Trading as', esc(client.trading))}
      ${acmaCardRow('ABN / ACN', esc([client.abn, client.acn].filter(Boolean).join(' / ')))}
      ${acmaCardRow('Industry', esc(client.industry))}
      ${acmaCardRow('Client type', esc(client.type))}
      ${acmaCardRow('Postal', esc(client.postal))}
    </div>
    ${notes.length ? `
    <div class="acma-sect"><h4>Conditions &amp; advisory notes (${notes.length})</h4>
      ${notes.map(n => `
        <details class="small" style="margin:.2rem 0">
          <summary style="cursor:pointer">${esc(n.title || n.cat || 'Note')}</summary>
          <div style="white-space:pre-wrap;color:var(--muted)">${esc(n.text || '')}</div>
        </details>`).join('')}
    </div>` : ''}
    ${cosited.length ? `
    <div class="acma-sect">
      <details>
        <summary style="cursor:pointer"><h4 style="display:inline">Co-sited devices (${cosited.length})</h4></summary>
        ${cosited.sort((a, b) => (a.f_mhz || 0) - (b.f_mhz || 0)).map(d => `
          <div class="small" style="margin:.15rem 0">
            <a href="#" onclick="showAcmaCard('${escAttr(d.id)}','${escAttr(A.cardAnchorId || '')}');return false">
              ${d.f_mhz != null ? d.f_mhz.toFixed(4) + ' MHz' : '?'}</a>
            ${esc(d.emission || '')} ${d.eirp_w != null ? '· ' + d.eirp_w + ' W EIRP' : ''}
            ${partnerIds.has(d.id) ? '<span class="badge">IMD partner</span>' : ''}
          </div>`).join('')}
      </details>
    </div>` : ''}
    <div class="small" style="color:var(--muted);padding:.4rem .6rem">
      ACMA RRL data (CC BY 4.0), extract ${esc((A.threats.meta || {}).source_date || '')}.
      Not to be used for unsolicited contact (Spam Act 2003 / DNCR Act 2006).
    </div>`;
}

// ── RF Environment tab ──

function renderRfHtml() {
  const A = state.acma;
  if (!A.loaded) {
    return `
      <div style="max-width:640px;margin:2.5rem auto;padding:1rem">
        <div class="panel" style="text-align:center;padding:2rem">
          <h2 style="margin:0 0 .6rem">RF Environment</h2>
          <p class="small" style="color:var(--muted)">
            ${A.error ? esc(A.error) : 'Loading ACMA interference data…'}</p>
        </div>
      </div>`;
  }
  const anchors = A.threats.anchors.slice().sort((a, b) => b.threats.length - a.threats.length);
  const sel = state.rf.anchorId;
  return `
    <div class="stack" style="padding:0 .25rem">
      <div class="panel">
        <div class="panel-header"><h2>RF Environment — licensed interference candidates</h2>
          <span class="small" style="color:var(--muted)">ACMA data: ${esc(A.threats.meta.source_date)} · CC BY 4.0</span>
        </div>
        <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center;margin:.5rem 0">
          <label class="small">Repeater
            <select onchange="state.rf.anchorId=this.value;renderMain()">
              <option value="">All (${A.flat.length} threat candidates)</option>
              ${anchors.map(a => `
                <option value="${escAttr(a.station_id)}" ${sel === a.station_id ? 'selected' : ''}>
                  ${esc(a.name)} (${a.threats.length})</option>`).join('')}
            </select>
          </label>
          <label class="small">Min score
            <input type="number" min="0" max="100" step="5" value="${state.filters.acma.minScore}"
                   style="width:4.5rem"
                   onchange="state.filters.acma.minScore=+this.value;renderMain()">
          </label>
          <button onclick="rfExportCsv()">Export CSV</button>
        </div>
        ${sel ? rfStripPlotHtml(sel) : rfSummaryHtml(anchors)}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Threat candidates${sel ? ` — ${esc((A.anchorById[sel] || {}).name || sel)}` : ''}</h3></div>
        <div class="table-wrap tall" id="rf-table-wrap">${rfTableHtml()}</div>
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Corruption-time correlation helper</h3></div>
        <p class="small" style="color:var(--muted)">Paste corruption timestamps (one per line,
          any parseable format). Checks whether they cluster in business hours — licensed
          operators with non-continuous operation tend to transmit 07:00–18:00 weekdays.</p>
        <textarea id="rf-corr" rows="4" style="width:100%"
                  placeholder="2026-07-12 09:41&#10;2026-07-12 10:05&#10;…">${esc(state.rf.corrText)}</textarea>
        <div style="margin:.4rem 0"><button onclick="rfCorrelate()">Analyse</button></div>
        <div id="rf-corr-out" class="small"></div>
      </div>
    </div>`;
}

function initRf() {
  const A = state.acma;
  if (!A.loaded && !A.error) {
    acmaEnsureCore().then(() => { if (state.activeTab === 'rf') renderMain(); })
                    .catch(() => { if (state.activeTab === 'rf') renderMain(); });
  }
  // strip plot carrier ticks want full device detail; refresh once it lands
  if (A.loaded && !A.devLoaded) {
    acmaEnsureDevices().then(() => { if (state.activeTab === 'rf') renderMain(); }).catch(() => {});
  }
}

function rfVisibleRows() {
  const sel = state.rf.anchorId;
  let rows = acmaVisibleThreats(true).filter(t => !sel || t.anchor_id === sel);
  const k = state.rf.sortKey, dir = state.rf.sortDir;
  const val = t => {
    switch (k) {
      case 'anchor':    return t.anchor_name || '';
      case 'mechanism': return t.mechanism;
      case 'f_mhz':     return t.f_mhz || 0;
      case 'delta':     return rfDeltaKhz(t) ?? 1e12;
      case 'distance':  return t.distance_km;
      case 'client':    return t.client || '';
      case 'lic':       return t.lic || '';
      case 'expiry':    return t.expiry || '';
      default:          return t.score;
    }
  };
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
  return rows;
}

function rfDeltaKhz(t) {
  if (t.rx_mhz == null) return null;
  const f = t.product_mhz != null ? t.product_mhz : t.f_mhz;
  if (f == null) return null;
  return (f - t.rx_mhz) * 1000;
}

function rfSort(key) {
  if (state.rf.sortKey === key) state.rf.sortDir *= -1;
  else { state.rf.sortKey = key; state.rf.sortDir = key === 'score' ? -1 : 1; }
  const wrap = document.getElementById('rf-table-wrap');
  if (wrap) wrap.innerHTML = rfTableHtml();
}

function rfTableHtml() {
  const rows = rfVisibleRows();
  if (!rows.length) {
    return `<p style="padding:.75rem;color:var(--muted)">No threat candidates match the current
      filters${state.acma.mechCounts.imd3 ? '' : ' — note: no same-site IMD candidates were found in this extract'}.</p>`;
  }
  const arrow = k => state.rf.sortKey === k ? (state.rf.sortDir > 0 ? ' ▲' : ' ▼') : '';
  const th = (k, label) => `<th style="cursor:pointer" onclick="rfSort('${k}')">${label}${arrow(k)}</th>`;
  return `
    <table class="bf-table">
      <thead><tr>
        ${th('anchor', 'Repeater')}${th('mechanism', 'Mechanism')}${th('score', 'Score')}
        ${th('f_mhz', 'Freq (MHz)')}${th('delta', 'Δ (kHz)')}${th('distance', 'Dist (km)')}
        <th>LOS</th>${th('client', 'Licensee')}${th('lic', 'Licence')}${th('expiry', 'Expiry')}<th></th>
      </tr></thead>
      <tbody>
        ${rows.slice(0, 1000).map(t => {
          const m = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
          const dk = rfDeltaKhz(t);
          return `<tr>
            <td class="small">${esc(t.anchor_name)}</td>
            <td class="small"><span class="legend-sq" style="background:${m.color}"></span> ${m.label}</td>
            <td>${t.score}</td>
            <td class="small">${t.f_mhz != null ? t.f_mhz.toFixed(4) : ''}</td>
            <td class="small" title="${esc(t.detail)}">${dk != null ? dk.toFixed(1) : ''}</td>
            <td class="small">${t.distance_km}</td>
            <td class="small">${t.los === true ? '✓' : t.los === false ? '✗' : '—'}</td>
            <td class="small">${esc(t.client || '')}${t.meganet ? ' <span class="badge">MegaNet</span>' : ''}</td>
            <td class="small">${esc(t.lic || '')}</td>
            <td class="small">${esc(t.expiry || '')}${t.inactive ? ' ⚠' : ''}</td>
            <td><a href="#" onclick="rfShowOnMap('${escAttr(t.device_id)}','${escAttr(t.anchor_id)}');return false">map</a></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${rows.length > 1000 ? `<p class="small" style="color:var(--muted);padding:.4rem">Showing 1000 of ${rows.length} — tighten the filters or export the CSV.</p>` : ''}`;
}

function rfSummaryHtml(anchors) {
  const withThreats = anchors.filter(a => a.threats.length);
  return `
    <div class="table-wrap medium">
      <table class="bf-table">
        <thead><tr><th>Repeater</th><th>RX (MHz)</th><th>Total</th>
          ${Object.entries(ACMA_MECH).filter(([k]) => state.acma.mechCounts[k]).map(([, m]) => `<th class="small">${m.label}</th>`).join('')}
          <th>Top score</th></tr></thead>
        <tbody>
          ${withThreats.map(a => {
            const by = {};
            a.threats.forEach(t => { by[t.mechanism] = (by[t.mechanism] || 0) + 1; });
            const top = a.threats.length ? Math.max(...a.threats.map(t => t.score)) : '';
            return `<tr style="cursor:pointer" onclick="state.rf.anchorId='${escAttr(a.station_id)}';renderMain()">
              <td>${esc(a.name)}</td><td class="small">${a.rx_mhz ?? ''}</td>
              <td><strong>${a.threats.length}</strong></td>
              ${Object.keys(ACMA_MECH).filter(k => state.acma.mechCounts[k]).map(k => `<td class="small">${by[k] || ''}</td>`).join('')}
              <td class="small">${top}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

// Frequency-axis strip plot: RX channel centre line, nearby licensed carriers
// as ticks coloured by band-plan segment (threat mechanisms override).
function rfStripPlotHtml(anchorId) {
  const A = state.acma;
  const a = A.anchorById[anchorId];
  if (!a || a.rx_mhz == null) return '';
  const rx = a.rx_mhz, span = 0.6;                     // ±0.6 MHz window
  const lo = rx - span, hi = rx + span;
  const W = 900, H = 90, pad = 30;
  const x = f => pad + (f - lo) / (hi - lo) * (W - 2 * pad);

  const threatsByDev = {};
  a.threats.forEach(t => { threatsByDev[t.device_id] = t; });

  let carriers = [];
  if (A.devLoaded) {
    const seen = new Set();
    for (const d of Object.values(A.deviceById)) {
      if (d.f_mhz == null || d.f_mhz < lo || d.f_mhz > hi) continue;
      const site = A.siteById[d.site_id];
      if (!site) continue;
      const dk = acmaHaversineKm(site.lat, site.lon, a.lat, a.lon);
      if (dk > state.filters.acma.radiusKm) continue;
      const key = d.f_mhz.toFixed(4) + '|' + d.site_id;
      if (seen.has(key)) continue;
      seen.add(key);
      carriers.push({ f: d.f_mhz, id: d.id, dk, client: d.id in threatsByDev ? threatsByDev[d.id].client : null });
    }
  } else {
    carriers = a.threats.filter(t => t.f_mhz != null && t.f_mhz >= lo && t.f_mhz <= hi)
      .map(t => ({ f: t.f_mhz, id: t.device_id, dk: t.distance_km, client: t.client }));
  }

  const segBands = VHF_SEGMENTS.filter(s => s.hi > lo && s.lo < hi).map(s => `
    <rect x="${x(Math.max(s.lo, lo))}" y="20" width="${x(Math.min(s.hi, hi)) - x(Math.max(s.lo, lo))}"
          height="${H - 40}" fill="${s.seg === 'F' ? 'rgba(2,136,209,.08)' : 'rgba(128,128,128,.05)'}">
      <title>Segment ${s.seg}: ${esc(s.alloc)}</title></rect>
    <text x="${x(Math.max(s.lo, lo)) + 3}" y="16" font-size="9" style="fill:var(--muted)">${s.seg}</text>`).join('');

  const ticks = carriers.map(c => {
    const t = threatsByDev[c.id];
    const color = t ? (ACMA_MECH[t.mechanism] || {}).color || '#888' : '#9aa7b3';
    const hgt = t ? 34 : 22;
    return `<line x1="${x(c.f)}" y1="${H - 20}" x2="${x(c.f)}" y2="${H - 20 - hgt}"
      stroke="${color}" stroke-width="${t ? 2.5 : 1.2}">
      <title>${c.f.toFixed(4)} MHz · ${c.dk.toFixed(1)} km${c.client ? ' · ' + esc(c.client) : ''}${t ? ' · ' + (ACMA_MECH[t.mechanism] || {}).label + ' ' + t.score : ''}</title></line>`;
  }).join('');

  return `
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:640px;height:auto" role="img"
           aria-label="Licensed carriers near ${esc(a.name)} RX channel">
        ${segBands}
        <line x1="${pad}" y1="${H - 20}" x2="${W - pad}" y2="${H - 20}" style="stroke:var(--muted)" stroke-width="1"/>
        ${[lo, rx - 0.3, rx, rx + 0.3, hi].map(f => `
          <text x="${x(f)}" y="${H - 6}" font-size="10" text-anchor="middle" style="fill:var(--muted)">${f.toFixed(3)}</text>`).join('')}
        ${ticks}
        <line x1="${x(rx)}" y1="10" x2="${x(rx)}" y2="${H - 20}" stroke="#d32f2f" stroke-width="1.5" stroke-dasharray="5 3"/>
        <text x="${x(rx)}" y="9" font-size="10" text-anchor="middle" fill="#d32f2f">RX ${rx}</text>
      </svg>
      <div class="small" style="color:var(--muted)">${carriers.length} licensed carriers within
        ±${span} MHz and ${state.filters.acma.radiusKm} km${A.devLoaded ? '' : ' (threat candidates only — full carrier set loads with device detail)'}.
        Tall coloured ticks are classified threats; grey ticks are other licensed users.</div>
    </div>`;
}

function rfShowOnMap(deviceId, anchorId) {
  state.filters.acma.show = true;
  acmaEnsureCore().then(() => {
    switchTab('stations');
    showAcmaCard(deviceId, anchorId);
  }).catch(() => {});
}

function rfExportCsv() {
  const rows = rfVisibleRows();
  const head = ['repeater', 'rx_mhz', 'mechanism', 'score', 'freq_mhz', 'product_mhz', 'delta_khz',
                'distance_km', 'bearing_deg', 'los', 'licensee', 'licence', 'expiry', 'current',
                'meganet_own_licence', 'device_id', 'site_id', 'detail'];
  const lines = [head.join(',')];
  for (const t of rows) {
    const dk = rfDeltaKhz(t);
    lines.push([
      csvEscape(t.anchor_name), t.rx_mhz ?? '', t.mechanism, t.score,
      t.f_mhz ?? '', t.product_mhz ?? '', dk != null ? dk.toFixed(2) : '',
      t.distance_km, t.bearing_deg, t.los == null ? 'not_assessed' : t.los,
      csvEscape(t.client || ''), csvEscape(t.lic || ''), t.expiry || '',
      t.inactive ? 'no' : 'yes', t.meganet ? 'yes' : '',
      t.device_id, t.site_id, csvEscape(t.detail),
    ].join(','));
  }
  dlText(`acma-threats-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
}

function rfCorrelate() {
  const el = document.getElementById('rf-corr-out');
  const txt = (document.getElementById('rf-corr') || {}).value || '';
  state.rf.corrText = txt;
  const stamps = txt.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => new Date(l)).filter(d => !isNaN(d));
  if (!el) return;
  if (!stamps.length) {
    el.innerHTML = '<span style="color:var(--muted)">No parseable timestamps.</span>';
    return;
  }
  const isBiz = d => d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= 7 && d.getHours() < 18;
  const biz = stamps.filter(isBiz).length;
  const pct = Math.round(100 * biz / stamps.length);
  // Expected share of a uniform 24×7 distribution that falls in Mon–Fri 07–18: ~33%
  const verdict = pct >= 55
    ? 'Strongly business-hours weighted — consistent with a licensed commercial operator (check non-continuous-hours candidates below).'
    : pct >= 40
      ? 'Mildly business-hours weighted — inconclusive.'
      : 'Not business-hours weighted — points away from office-hours licensees (consider continuous carriers, faulty equipment, or environmental sources).';
  const hourly = new Array(24).fill(0);
  stamps.forEach(d => hourly[d.getHours()]++);
  const maxH = Math.max(...hourly, 1);
  const bars = hourly.map((n, h) => `
    <div title="${String(h).padStart(2, '0')}:00 — ${n}" style="flex:1;display:flex;flex-direction:column;justify-content:end">
      <div style="height:${Math.round(40 * n / maxH)}px;background:var(--map-line, #ff6f00);opacity:.75"></div>
    </div>`).join('');
  const nonCont = acmaVisibleThreats(true).filter(t => {
    const d = state.acma.deviceById[t.device_id];
    return d && d.hours && d.hours !== '00:00-23:59';
  });
  el.innerHTML = `
    <p>${stamps.length} timestamps · <strong>${pct}%</strong> in business hours (Mon–Fri 07:00–18:00;
    a uniform 24×7 source would sit near 33%).<br>${verdict}</p>
    <div style="display:flex;gap:1px;height:44px;align-items:end;max-width:480px">${bars}</div>
    <div style="display:flex;justify-content:space-between;max-width:480px" class="small">
      <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    ${state.acma.devLoaded
      ? (nonCont.length
          ? `<p>Visible threats with recorded non-continuous hours: ${nonCont.map(t =>
              `${esc(t.client || t.lic)} (${esc((state.acma.deviceById[t.device_id] || {}).hours)})`).join('; ')}</p>`
          : '<p style="color:var(--muted)">No visible threat has recorded non-continuous operating hours (most ACMA records leave hours blank).</p>')
      : '<p style="color:var(--muted)">Open a transmitter card once to load device detail, then re-run for per-licensee operating hours.</p>'}`;
}

// ── RF Changes tab ──────────────────────────────────────────────────────────────
// "Did something change on the air near this repeater around the date our data
// went bad?" Two views: a retrospective timeline of AUTHORISATION_DATEs (works
// from a single extract) and diffs between archived monthly snapshots (works
// from the second archive onward — removals and parameter changes are invisible
// in a single snapshot, which is why every month is retained under
// data/acma-raw/<YYYY-MM>/). All inputs precomputed by tools/acma_fetch.py and
// tools/acma_diff.py; nothing fetched until this tab is opened.
//
// Register dates are administrative: an upper bound on when interference could
// have begun, never proof that it did. Every string in this tab is worded as
// "lead", not conclusion — keep it that way.

const RFC_CLASS = {
  cotenant: { label: 'New co-tenant at a repeater site', color: '#d32f2f',
              blurb: 'A transmitter added at a site co-located with a repeater — the highest-severity change: front-end desense plus a new intermod pair with every existing carrier on the mast.' },
  added:    { label: 'Added',                  color: '#c62828',
              blurb: 'Assignment present now, absent in the earlier snapshot — a newly commissioned transmitter.' },
  removed:  { label: 'Removed',                color: '#607d8b',
              blurb: 'Assignment gone from the register — the only way a decommissioning is ever visible.' },
  freq:     { label: 'Frequency changed',      color: '#f57c00',
              blurb: 'May have moved onto or off a MegaNet channel.' },
  power:    { label: 'Power changed',          color: '#7b1fa2',
              blurb: 'TX power or EIRP differs — direct noise-floor impact.' },
  antenna:  { label: 'Antenna changed',        color: '#0288d1',
              blurb: 'Height, azimuth, tilt or antenna model differs — a re-point toward a repeater or extended reach.' },
  site:     { label: 'Site moved',             color: '#6d4c41',
              blurb: 'Assignment relocated to a different site, possibly a repeater mast.' },
  status:   { label: 'Licence status changed', color: '#455a64',
              blurb: 'Lapsed, surrendered or reinstated.' },
};

const RFC_FIELD_LABEL = {
  f_mhz: 'Frequency (MHz)', tx_w: 'TX power (W)', eirp_w: 'EIRP (W)',
  height_m: 'Antenna height (m)', az: 'Azimuth (°)', tilt: 'Tilt (°)',
  ant_id: 'Antenna', site_id: 'Site', status: 'Licence status',
};

const RFC_SERIES_COLORS = ['#0b5cab', '#c7401a', '#107c10', '#7c35a3',
                           '#b8860b', '#00838f', '#ad1457', '#5d4037'];
const RFC_MARK_CAP = 800;
const RFC_DAY = 86400000;

function initRfc() {
  const A = state.acma, R = state.rfc;
  const rerender = () => { if (state.activeTab === 'rfchanges') renderMain(); };
  if (!A.loaded && !A.error) acmaEnsureCore().then(rerender).catch(rerender);
  if (!R.loaded && !R.error) rfcEnsureData().then(rerender).catch(rerender);
}

function rfcEnsureData() {
  const R = state.rfc;
  if (R.loaded) return Promise.resolve();
  if (R.loadPromise) return R.loadPromise;
  R.loading = true;
  R.loadPromise = Promise.all([
    acmaFetchJson('acma-timeline.json'),
    acmaFetchJson('acma-changes.json').catch(() => null),    // optional
    acmaFetchJson('acma-snapshots.json').catch(() => null),  // optional
  ]).then(([tl, ch, sn]) => {
    R.timeline = tl; R.changes = ch; R.snapshots = sn;
    R.loaded = true; R.loading = false; R.error = null;
  }).catch(err => {
    R.loading = false; R.loadPromise = null;
    R.error = `RF change data unavailable (${err.message}). Generate ` +
              `data/acma-timeline.json with tools/acma_fetch.py; these files ` +
              `cannot be fetched over file://.`;
    throw err;
  });
  return R.loadPromise;
}

function rfcAnchorName(id) {
  const a = state.acma.anchorById[id];
  if (a) return a.name;
  const s = (state.data?.stations || []).find(x => x.id === id);
  return s ? s.name : id;
}

// ── event filtering / ranking ──

// Events whose best anchor match passes the current selection, radius and
// minimum-score filters. Returns { e (timeline event), a (best anchor match) }.
function rfcVisibleEvents() {
  const R = state.rfc, out = [];
  if (!R.timeline) return out;
  for (const e of R.timeline.events) {
    let best = null;
    for (const a of e.anchors || []) {
      if (R.anchorSel.size && !R.anchorSel.has(a.id)) continue;
      if (a.km > R.radiusKm || a.score < R.minScore) continue;
      if (!best || a.score > best.score) best = a;
    }
    if (best && e.date) out.push({ e, a: best });
  }
  return out;
}

// Signed days from the onset date (null when no onset is set).
function rfcDaysFromOnset(e) {
  const R = state.rfc;
  if (!R.onset) return null;
  return Math.round((Date.parse(e.date) - Date.parse(R.onset)) / RFC_DAY);
}

// coincidence = interference score × temporal proximity × co-site bonus.
// Proximity decays linearly from 1 at the onset date to 0 at the window edge
// (stated in the UI tooltip — keep the formula and the tooltip in sync).
function rfcCoincidence(row) {
  const R = state.rfc;
  const days = rfcDaysFromOnset(row.e);
  if (days === null || Math.abs(days) > R.windowDays) return null;
  const prox = Math.max(0, 1 - Math.abs(days) / R.windowDays);
  const bonus = row.a.km <= 0.25 ? 1.5 : 1;
  return { days, prox, bonus, value: row.a.score * prox * bonus };
}

// Rows for the coincidence table: windowed to onset ± window when an onset is
// set, otherwise the full visible set sorted by date (newest first).
function rfcTableRows() {
  const R = state.rfc;
  let rows = rfcVisibleEvents().map(r => ({ ...r, coin: rfcCoincidence(r) }));
  if (R.onset) rows = rows.filter(r => r.coin);
  const val = r => {
    switch (R.sortKey) {
      case 'date':   return r.e.date;
      case 'days':   return r.coin ? r.coin.days : 0;
      case 'client': return r.e.client || '';
      case 'f':      return r.e.f_mhz || 0;
      case 'delta':  return rfcDeltaKhz(r) ?? 1e12;
      case 'mech':   return r.a.mech;
      case 'eirp':   return r.e.eirp_w ?? r.e.tx_w ?? 0;
      case 'km':     return r.a.km;
      case 'score':  return r.a.score;
      default:       return r.coin ? r.coin.value : Date.parse(r.e.date);
    }
  };
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * R.sortDir;
  });
  return rows;
}

function rfcDeltaKhz(row) {
  if (row.a.mech === 'cosite_desense') return null;   // proximity, not spectrum
  const rx = (state.acma.anchorById[row.a.id] || {}).rx_mhz;
  const f = row.a.product_mhz != null ? row.a.product_mhz : row.e.f_mhz;
  if (rx == null || f == null) return null;
  return (f - rx) * 1000;
}

function rfcSort(key) {
  const R = state.rfc;
  if (R.sortKey === key) R.sortDir *= -1;
  else { R.sortKey = key; R.sortDir = (key === 'coin' || key === 'score' || key === 'date') ? -1 : 1; }
  const wrap = document.getElementById('rfc-table-wrap');
  if (wrap) wrap.innerHTML = rfcTableInnerHtml();
}

// ── selector handlers ──

function rfcSelectAllAnchors() {
  state.rfc.anchorSel = new Set();
  renderMain();
}

function rfcToggleAnchor(id, on) {
  const sel = state.rfc.anchorSel;
  if (on) sel.add(id); else sel.delete(id);
  renderMain();
}

function rfcFocusAnchor(id) {
  state.rfc.anchorSel = new Set([id]);
  renderMain();
}

function rfcUseOnset(date) {
  state.rfc.onset = date;
  renderMain();
}

function rfcCardFor(deviceId, anchorId) {
  showAcmaCard(deviceId, anchorId);
}

// ── page ──

function renderRfcHtml() {
  const A = state.acma, R = state.rfc;
  if (!A.loaded || !R.loaded) {
    const msg = A.error || R.error ||
      'Loading ACMA change-detection data…';
    return `
      <div style="max-width:640px;margin:2.5rem auto;padding:1rem">
        <div class="panel" style="text-align:center;padding:2rem">
          <h2 style="margin:0 0 .6rem">RF Changes</h2>
          <p class="small" style="color:var(--muted)">${esc(msg)}</p>
        </div>
      </div>`;
  }
  return `
    <div class="stack rfc-page" style="padding:0 .25rem;position:relative">
      <div class="panel">
        <div class="panel-header"><h2>RF Changes — what changed on the air, and when</h2>
          <span class="small" style="color:var(--muted)">ACMA data: ${esc(R.timeline.meta.source_date)} · CC BY 4.0</span>
        </div>
        <p class="small" style="color:var(--muted);margin:.3rem 0 .5rem">
          Register dates are <strong>administrative</strong>: an authorisation date is an upper
          bound on when a transmitter could have come on air — licences are often authorised
          before installation (or never installed), and equipment can radiate with no register
          entry at all. A date that lines up with a data-quality step is a
          <strong>lead to investigate</strong>, never a conclusion.</p>
        ${rfcSelectorHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Timeline — authorisations vs data quality</h3></div>
        ${rfcChartHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>${R.onset ? 'Coincidence ranking' : 'Authorisation events'}</h3>
          <span style="display:flex;gap:.5rem;align-items:center">
            <span class="small" style="color:var(--muted)"
                  title="coincidence = interference score × temporal proximity × co-site bonus. Proximity decays linearly from 1 at the onset date to 0 at the window edge; ×1.5 bonus when the transmitter shares the repeater's site (≤250 m).">
              ${R.onset ? 'ranking formula ⓘ' : ''}</span>
            <button onclick="rfcExportCsv()">Export CSV</button>
          </span>
        </div>
        ${R.onset ? '' : `<p class="small" style="color:var(--muted);margin:.2rem 0">
          Set an onset date above (or detect one below) to rank these by coincidence with the
          data-quality step. This table is the evidence you would attach to an ACMA
          interference complaint.</p>`}
        <div class="table-wrap tall" id="rfc-table-wrap">${rfcTableInnerHtml()}</div>
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Snapshot diff — observed register changes</h3></div>
        ${rfcDiffHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>New intermod products</h3></div>
        ${rfcImdHtml()}
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Onset detection helper</h3></div>
        ${rfcOnsetHelperHtml()}
      </div>
      <div class="panel">${rfcHelpHtml()}</div>
      <div id="acma-card" class="acma-card" hidden></div>
    </div>`;
}

function rfcSelectorHtml() {
  const A = state.acma, R = state.rfc;
  const anchors = A.threats.anchors.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return `
    <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-start">
      <details class="rfc-picker" ${R.pickerOpen ? 'open' : ''} ontoggle="state.rfc.pickerOpen=this.open">
        <summary class="small" style="cursor:pointer">Repeaters:
          <strong>${R.anchorSel.size ? `${R.anchorSel.size} selected` : 'all'}</strong></summary>
        <div class="rfc-picker-list">
          <label style="display:flex;gap:.4rem;align-items:center">
            <input type="checkbox" ${R.anchorSel.size ? '' : 'checked'}
                   onchange="rfcSelectAllAnchors()"> <em>All repeaters</em></label>
          ${anchors.map(a => `
            <label style="display:flex;gap:.4rem;align-items:center">
              <input type="checkbox" ${R.anchorSel.has(a.station_id) ? 'checked' : ''}
                     onchange="rfcToggleAnchor('${escAttr(a.station_id)}',this.checked)">
              ${esc(a.name)}${a.rx_mhz ? ` <span class="small" style="color:var(--muted)">${a.rx_mhz}</span>` : ''}
            </label>`).join('')}
        </div>
      </details>
      <label class="small">Onset date
        <input type="date" value="${esc(R.onset)}"
               onchange="state.rfc.onset=this.value;renderMain()">
      </label>
      <label class="small">Window
        <select onchange="state.rfc.windowDays=+this.value;renderMain()">
          ${[30, 60, 90, 180].map(w => `
            <option value="${w}" ${R.windowDays === w ? 'selected' : ''}>±${w} days</option>`).join('')}
        </select>
      </label>
      <label class="small">Radius
        <select onchange="state.rfc.radiusKm=+this.value;renderMain()">
          ${[10, 25, 50, 60].map(r => `
            <option value="${r}" ${R.radiusKm === r ? 'selected' : ''}>${r} km</option>`).join('')}
        </select>
      </label>
      <label class="small">Min score
        <input type="number" min="0" max="100" step="5" value="${R.minScore}" style="width:4.5rem"
               onchange="state.rfc.minScore=+this.value;renderMain()">
      </label>
      ${R.onset ? `<button class="small" onclick="state.rfc.onset='';renderMain()">× clear onset</button>` : ''}
    </div>`;
}

// ── timeline chart ──
// Upper band: one mark per device authorisation, one lane per interference
// mechanism, sized by score. Thin lane: licence effect/expiry as lighter marks.
// Lower band: the pasted per-station corruption series, so a coincidence
// between paperwork and data quality is visible at a glance.

function rfcChartHtml() {
  const R = state.rfc;
  const rows = rfcVisibleEvents();
  const onsetMs = R.onset ? Date.parse(R.onset) : null;
  let lo, hi;
  if (onsetMs) {
    lo = onsetMs - R.windowDays * 1.5 * RFC_DAY;
    hi = onsetMs + R.windowDays * 1.5 * RFC_DAY;
  } else {
    hi = Date.now() + 7 * RFC_DAY;
    lo = hi - 730 * RFC_DAY;
  }
  const inSpan = rows.filter(r => {
    const t = Date.parse(r.e.date);
    return t >= lo && t <= hi;
  });

  const mechs = Object.keys(ACMA_MECH).filter(m => inSpan.some(r => r.a.mech === m));
  const lanes = mechs.length ? mechs : ['co_channel'];
  const W = 1000, PADL = 118, PADR = 16, laneH = 24;
  const upperTop = 10;
  const licY = upperTop + lanes.length * laneH;
  const lowerTop = licY + 18 + 14, lowerH = 78;
  const axisY = lowerTop + lowerH + 4;
  const H = axisY + 26;
  const x = t => PADL + (t - lo) / (hi - lo) * (W - PADL - PADR);

  // month gridlines, thinned to roughly a dozen labels
  const ticks = [];
  const d0 = new Date(lo);
  let ty = d0.getUTCFullYear(), tm = d0.getUTCMonth() + 1;
  const totalMonths = Math.max(1, Math.round((hi - lo) / (30.44 * RFC_DAY)));
  const stepM = Math.max(1, Math.ceil(totalMonths / 12));
  for (let i = 0; ; i++) {
    const t = Date.UTC(ty, tm, 1);
    if (t > hi) break;
    if (i % stepM === 0) ticks.push(t);
    tm++; if (tm > 11) { tm = 0; ty++; }
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const tickLabel = t => {
    const d = new Date(t);
    return `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  };

  const laneY = m => upperTop + lanes.indexOf(m) * laneH;

  const shade = onsetMs ? `
    <rect x="${x(onsetMs - R.windowDays * RFC_DAY)}" y="0"
          width="${x(onsetMs + R.windowDays * RFC_DAY) - x(onsetMs - R.windowDays * RFC_DAY)}"
          height="${axisY}" fill="rgba(211,47,47,.07)"/>
    <line x1="${x(onsetMs)}" y1="0" x2="${x(onsetMs)}" y2="${axisY}"
          stroke="#d32f2f" stroke-width="1.5" stroke-dasharray="5 3"/>
    <text x="${x(onsetMs)}" y="${axisY + 22}" font-size="10" text-anchor="middle"
          fill="#d32f2f">onset</text>` : '';

  const shown = inSpan.slice(0, RFC_MARK_CAP);
  const marks = shown.map(r => {
    const t = Date.parse(r.e.date);
    const rad = 3 + Math.min(6, r.a.score / 15);
    const c = (ACMA_MECH[r.a.mech] || {}).color || '#666';
    return `<circle cx="${x(t).toFixed(1)}" cy="${laneY(r.a.mech) + laneH / 2}" r="${rad.toFixed(1)}"
      fill="${c}" opacity=".75" style="cursor:pointer"
      onclick="rfcCardFor('${escAttr(r.e.device_id)}','${escAttr(r.a.id)}')">
      <title>${esc(r.e.date)} · ${esc(r.e.client || r.e.lic || '?')} · ${r.e.f_mhz != null ? r.e.f_mhz.toFixed(4) + ' MHz · ' : ''}${esc((ACMA_MECH[r.a.mech] || {}).label || r.a.mech)} ${r.a.score} vs ${esc(rfcAnchorName(r.a.id))} · ${r.a.km} km${r.e.variation ? ' · variation to existing licence' : ''}</title>
    </circle>`;
  }).join('');

  let licMarks = '';
  let nLic = 0;
  for (const r of shown) {
    for (const d of [r.e.lic_effect, r.e.lic_expiry]) {
      const t = d ? Date.parse(d) : NaN;
      if (isNaN(t) || t < lo || t > hi || nLic >= RFC_MARK_CAP) continue;
      nLic++;
      licMarks += `<line x1="${x(t).toFixed(1)}" y1="${licY + 3}" x2="${x(t).toFixed(1)}" y2="${licY + 13}"
        stroke="var(--muted)" stroke-width="1" opacity=".45">
        <title>${esc(d)} · licence ${d === r.e.lic_effect ? 'effect' : 'expiry'} · ${esc(r.e.client || r.e.lic || '')}</title></line>`;
    }
  }

  // lower band — corruption series
  let lower = '';
  const series = Object.entries(R.corrSeries || {}).filter(([, pts]) => pts.length);
  if (series.length) {
    let vmax = 0;
    for (const [, pts] of series) for (const p of pts) vmax = Math.max(vmax, p.v);
    vmax = vmax || 1;
    lower = series.slice(0, RFC_SERIES_COLORS.length).map(([name, pts], i) => {
      const col = RFC_SERIES_COLORS[i];
      const vis = pts.filter(p => p.t >= lo && p.t <= hi);
      const path = vis.map(p =>
        `${x(p.t).toFixed(1)},${(lowerTop + lowerH - 4 - p.v / vmax * (lowerH - 10)).toFixed(1)}`).join(' ');
      return `<polyline points="${path}" fill="none" stroke="${col}" stroke-width="1.6" opacity=".85">
        <title>${esc(name)}</title></polyline>`;
    }).join('');
  } else {
    lower = `<text x="${PADL + 8}" y="${lowerTop + lowerH / 2}" font-size="11"
      style="fill:var(--muted)">No data-quality series loaded — paste per-station corruption
      counts in the onset helper below to see coincidence at a glance.</text>`;
  }

  const legend = series.length ? `
    <div class="small" style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:.2rem">
      ${series.slice(0, RFC_SERIES_COLORS.length).map(([name], i) => `
        <span class="legend-item"><span class="rfc-series-line" style="background:${RFC_SERIES_COLORS[i]}"></span>
        ${esc(name)}</span>`).join('')}
    </div>` : '';

  return `
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:720px;height:auto" role="img"
           aria-label="ACMA authorisation events and data quality over time">
        ${shade}
        ${ticks.map(t => `
          <line x1="${x(t).toFixed(1)}" y1="0" x2="${x(t).toFixed(1)}" y2="${axisY}"
                stroke="var(--border)" stroke-width="1" opacity=".6"/>
          <text x="${x(t).toFixed(1)}" y="${axisY + 12}" font-size="10" text-anchor="middle"
                style="fill:var(--muted)">${tickLabel(t)}</text>`).join('')}
        ${lanes.map(m => `
          <text x="4" y="${laneY(m) + laneH / 2 + 3}" font-size="10"
                style="fill:${(ACMA_MECH[m] || {}).color || 'var(--muted)'}">${esc((ACMA_MECH[m] || {}).label || m)}</text>
          <line x1="${PADL}" y1="${laneY(m) + laneH}" x2="${W - PADR}" y2="${laneY(m) + laneH}"
                stroke="var(--border)" stroke-width=".5" opacity=".5"/>`).join('')}
        <text x="4" y="${licY + 12}" font-size="10" style="fill:var(--muted)">licence dates</text>
        ${licMarks}
        <text x="4" y="${lowerTop + 10}" font-size="10" style="fill:var(--muted)">data quality</text>
        <line x1="${PADL}" y1="${lowerTop + lowerH}" x2="${W - PADR}" y2="${lowerTop + lowerH}"
              style="stroke:var(--muted)" stroke-width="1"/>
        ${lower}
        ${marks}
      </svg>
      ${legend}
      <div class="small" style="color:var(--muted)">
        ${shown.length}${inSpan.length > shown.length ? ` of ${inSpan.length}` : ''} authorisation
        events in view · mark size = interference score · click a mark for the transmitter card.
        ${onsetMs ? 'Shaded band = the selected onset window.' : 'Showing the last 24 months — set an onset date to zoom.'}</div>
    </div>`;
}

// ── coincidence table ──

function rfcTableInnerHtml() {
  const R = state.rfc;
  const rows = rfcTableRows();
  if (!rows.length) {
    return R.onset ? `
      <div style="padding:.75rem">
        <p><strong>No register events near this onset.</strong></p>
        <p class="small" style="color:var(--muted)">A noise-floor step with no ACMA event nearby
        is itself a finding: it points away from licensed transmitters and toward your own
        infrastructure (corroding mast joints becoming an intermod mixer, a failing PA, water
        in a feeder) or an unlicensed emitter (solar charge controllers, LED signage, electric
        fences, powerline arcing). Widen the window or lower the minimum score to double-check
        before concluding.</p>
      </div>` :
      `<p style="padding:.75rem;color:var(--muted)">No authorisation events match the current
        filters — widen the radius or lower the minimum score.</p>`;
  }
  const arrow = k => R.sortKey === k ? (R.sortDir > 0 ? ' ▲' : ' ▼') : '';
  const th = (k, label, tip) => `<th style="cursor:pointer" ${tip ? `title="${escAttr(tip)}"` : ''}
    onclick="rfcSort('${k}')">${label}${arrow(k)}</th>`;
  return `
    <table class="bf-table">
      <thead><tr>
        ${th('date', 'Authorised', 'DEVICE_DETAILS.AUTHORISATION_DATE — when the frequency assignment was approved (administrative)')}
        ${R.onset ? th('days', 'Δdays') : ''}
        ${th('client', 'Licensee')}${th('f', 'Freq (MHz)')}${th('delta', 'Δf (kHz)')}
        ${th('mech', 'Mechanism')}${th('eirp', 'EIRP (W)')}${th('km', 'Dist (km)')}
        ${th('score', 'Score')}
        ${R.onset ? th('coin', 'Coincidence', 'score × temporal proximity (linear decay to 0 at window edge) × 1.5 co-site bonus') : ''}
      </tr></thead>
      <tbody>
        ${rows.slice(0, 1000).map(r => {
          const m = ACMA_MECH[r.a.mech] || { label: r.a.mech, color: '#666' };
          const dk = rfcDeltaKhz(r);
          return `<tr style="cursor:pointer"
                      onclick="rfcCardFor('${escAttr(r.e.device_id)}','${escAttr(r.a.id)}')">
            <td class="small">${esc(r.e.date)}${r.e.variation ? ' <span class="badge" title="Authorised >30 days after the licence was issued — a variation to an existing licence (added channel, power change, re-point), not a new licence">var</span>' : ''}</td>
            ${R.onset ? `<td class="small">${r.coin.days > 0 ? '+' : ''}${r.coin.days}</td>` : ''}
            <td class="small">${esc(r.e.client || '')}</td>
            <td class="small">${r.e.f_mhz != null ? r.e.f_mhz.toFixed(4) : ''}</td>
            <td class="small">${dk != null ? dk.toFixed(1) : '—'}</td>
            <td class="small"><span class="legend-sq" style="background:${m.color}"></span> ${m.label}</td>
            <td class="small">${r.e.eirp_w ?? r.e.tx_w ?? ''}</td>
            <td class="small">${r.a.km}${r.a.km <= 0.25 ? ' <span class="badge">co-site</span>' : ''}</td>
            <td>${r.a.score}</td>
            ${R.onset ? `<td><strong>${r.coin.value.toFixed(1)}</strong></td>` : ''}
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${rows.length > 1000 ? `<p class="small" style="color:var(--muted);padding:.4rem">Showing 1000 of ${rows.length} — tighten the filters or export the CSV.</p>` : ''}`;
}

function rfcExportCsv() {
  const R = state.rfc;
  const rows = rfcTableRows();
  const head = ['authorisation_date', 'days_from_onset', 'repeater', 'rx_mhz', 'licensee',
                'licence', 'licence_type', 'freq_mhz', 'product_mhz', 'delta_khz', 'mechanism',
                'eirp_w', 'tx_w', 'distance_km', 'co_site', 'score', 'temporal_proximity',
                'cosite_bonus', 'coincidence', 'variation_to_existing_licence',
                'licence_issued', 'licence_effect', 'licence_expiry', 'status',
                'device_id', 'site_id', 'stable_key'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const dk = rfcDeltaKhz(r);
    const rx = (state.acma.anchorById[r.a.id] || {}).rx_mhz;
    lines.push([
      r.e.date, r.coin ? r.coin.days : '', csvEscape(rfcAnchorName(r.a.id)), rx ?? '',
      csvEscape(r.e.client || ''), csvEscape(r.e.lic || ''), csvEscape(r.e.lic_type || ''),
      r.e.f_mhz ?? '', r.a.product_mhz ?? '', dk != null ? dk.toFixed(2) : '',
      r.a.mech, r.e.eirp_w ?? '', r.e.tx_w ?? '', r.a.km,
      r.a.km <= 0.25 ? 'yes' : '', r.a.score,
      r.coin ? r.coin.prox.toFixed(3) : '', r.coin ? r.coin.bonus : '',
      r.coin ? r.coin.value.toFixed(2) : '',
      r.e.variation ? 'yes' : '', r.e.lic_issued || '', r.e.lic_effect || '',
      r.e.lic_expiry || '', csvEscape(r.e.status || ''),
      r.e.device_id, r.e.site_id || '', r.e.key || '',
    ].join(','));
  }
  const onset = R.onset ? `-onset-${R.onset}` : '';
  dlText(`acma-rf-changes${onset}-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'));
}

// ── snapshot diff panel ──

function rfcPairs() {
  return (state.rfc.changes || {}).pairs || [];
}

function rfcSelectedPair() {
  const pairs = rfcPairs();
  if (!pairs.length) return null;
  const i = state.rfc.pairIdx;
  return pairs[i >= 0 && i < pairs.length ? i : pairs.length - 1];
}

function rfcChangeVisible(c) {
  const R = state.rfc;
  if (R.anchorSel.size && (!c.anchor || !R.anchorSel.has(c.anchor))) return false;
  if (c.anchor_km != null && c.anchor_km > R.radiusKm) return false;
  return true;
}

function rfcDiffEmptyHtml() {
  const months = ((state.rfc.snapshots || {}).snapshots || []).map(s => s.month);
  const one = months.length === 1;
  return `
    <p class="small" style="color:var(--muted)">
      Change detection compares two archived monthly subsets, and
      ${one ? `only one exists so far (<strong>${esc(months[0])}</strong>)`
            : months.length ? `the archived months (${months.map(esc).join(', ')}) have not been diffed — run tools/acma_diff.py`
            : 'none are archived yet — run tools/acma_diff.py --archive'}.
      The monthly ACMA refresh (2nd of each month, ~06:15 AEST) archives the next snapshot,
      and diffs appear here from then on — improving every month the archive grows.
      Removals and prior parameter values before the first archived month are unrecoverable:
      ACMA publishes a daily snapshot, not a back-catalogue, which is why the archive under
      <code>data/acma-raw/&lt;YYYY-MM&gt;/</code> must never be pruned.
      Until then, the authorisation timeline above is the available change axis.</p>`;
}

function rfcDiffHtml() {
  const R = state.rfc;
  const pairs = rfcPairs();
  if (!pairs.length) return rfcDiffEmptyHtml();
  const p = rfcSelectedPair();
  const latestMonth = (((R.snapshots || {}).snapshots || []).slice(-1)[0] || {}).month;
  const linkable = p.to === latestMonth;   // SDD_IDs only resolve against the current extract
  const vis = (p.changes || []).filter(rfcChangeVisible);

  const groups = [];
  const used = new Set();
  const take = (cls, pred) => {
    const g = vis.filter(c => !used.has(c) && pred(c));
    g.forEach(c => used.add(c));
    if (g.length) groups.push([cls, g]);
  };
  take('cotenant', c => c.cotenant);
  for (const cls of ['added', 'removed', 'freq', 'power', 'antenna', 'site', 'status'])
    take(cls, c => (c.classes || [c.class]).includes(cls));

  const pairSel = `
    <label class="small">Compare
      <select onchange="state.rfc.pairIdx=+this.value;renderMain()">
        ${pairs.map((q, i) => `
          <option value="${i}" ${q === p ? 'selected' : ''}>${esc(q.from)} → ${esc(q.to)}</option>`).join('')}
      </select>
    </label>
    <span class="small" style="color:var(--muted)">extracts ${esc(p.from_date || p.from)} →
      ${esc(p.to_date || p.to)} · grouped by nearest repeater · diff key: EFL_ID /
      device registration id (never SDD_ID)</span>`;

  if (!vis.length) {
    return `<div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center">${pairSel}</div>
      <p class="small" style="color:var(--muted);margin-top:.5rem">No register changes near the
      selected repeaters in this pair — the RF licensing picture was stable. If the data-quality
      step falls in this period, that points away from licensed transmitters (see the help
      notes below).</p>`;
  }

  return `
    <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center">${pairSel}</div>
    ${groups.map(([cls, g]) => {
      const meta = RFC_CLASS[cls];
      return `
        <div style="margin-top:.7rem">
          <h4 style="margin:0 0 .1rem"><span class="legend-sq" style="background:${meta.color}"></span>
            ${meta.label} (${g.length})</h4>
          <p class="small" style="color:var(--muted);margin:.1rem 0 .3rem">${meta.blurb}</p>
          ${g.slice(0, 200).map(c => rfcChangeRowHtml(c, cls, linkable)).join('')}
          ${g.length > 200 ? `<p class="small" style="color:var(--muted)">…and ${g.length - 200} more.</p>` : ''}
        </div>`;
    }).join('')}`;
}

function rfcChangeRowHtml(c, cls, linkable) {
  const fields = c.fields ? Object.entries(c.fields)
    .filter(([k]) => cls === 'status' ? k === 'status' :
                     cls === 'freq' ? k === 'f_mhz' :
                     cls === 'power' ? (k === 'tx_w' || k === 'eirp_w') :
                     cls === 'antenna' ? ['height_m', 'az', 'tilt', 'ant_id'].includes(k) :
                     cls === 'site' ? k === 'site_id' : true)
    .map(([k, [a, b]]) => `<span style="white-space:nowrap">${RFC_FIELD_LABEL[k] || k}:
      <s style="color:var(--muted)">${esc(a ?? '—')}</s> → <strong>${esc(b ?? '—')}</strong></span>`)
    .join(' · ') : '';
  const link = linkable && c.device_id
    ? ` <a href="#" onclick="rfcCardFor('${escAttr(c.device_id)}','${escAttr(c.anchor || '')}');return false">details →</a>`
    : '';
  return `
    <div class="small" style="margin:.25rem 0;padding-left:.9rem">
      <strong>${esc(c.client || 'Unknown licensee')}</strong>
      · ${c.f_mhz != null ? c.f_mhz.toFixed(4) + ' MHz' : 'freq ?'}
      ${c.eirp_w != null ? `· ${c.eirp_w} W EIRP` : ''}
      · lic ${esc(c.lic || '?')}
      ${c.confidence === 'low' ? ' <span class="badge" title="Matched on a composite fingerprint (licence + site + frequency) because both stable identifiers were missing — treat with caution">low-confidence match</span>' : ''}
      ${c.cotenant ? ' <span class="badge" style="color:#d32f2f">co-tenant</span>' : ''}
      ${link}<br>
      <span style="color:var(--muted)">${esc(c.site_name || c.site_id || '')}
        ${c.anchor ? `· ${c.anchor_km != null ? c.anchor_km + ' km from ' : 'near '}${esc(rfcAnchorName(c.anchor))}` : ''}
        ${c.auth ? `· authorised ${esc(c.auth)}` : ''}</span>
      ${fields ? `<br>${fields}` : ''}
    </div>`;
}

// ── new IMD products panel ──

function rfcImdHtml() {
  const p = rfcSelectedPair();
  const intro = `
    <p class="small" style="color:var(--muted);margin:.2rem 0 .5rem">
      Adding one transmitter to a mast creates a third-order product with <em>every</em>
      carrier already there — the offender is often nowhere near the RX frequency itself.
      Listed below are only the products that are <strong>new in this snapshot pair</strong>
      (created by an added or re-tuned device) and land within tolerance of a repeater RX
      channel.</p>`;
  if (!p) {
    return `${intro}<p class="small" style="color:var(--muted)">Needs two archived snapshots —
      see the snapshot diff panel above.</p>`;
  }
  const latestMonth = (((state.rfc.snapshots || {}).snapshots || []).slice(-1)[0] || {}).month;
  const linkable = p.to === latestMonth;
  const R = state.rfc;
  const vis = (p.new_imd || []).filter(i =>
    (!R.anchorSel.size || R.anchorSel.has(i.anchor)) &&
    (i.anchor_km == null || i.anchor_km <= R.radiusKm));
  if (!vis.length) {
    return `${intro}<p class="small" style="color:var(--muted)">No new intermod products land
      on an RX channel in ${esc(p.from)} → ${esc(p.to)} for the selected repeaters.</p>`;
  }
  return `${intro}
    <div class="table-wrap medium">
      <table class="bf-table">
        <thead><tr><th>Product</th><th>Δ (kHz)</th><th>Order</th><th>Repeater</th>
          <th>Site</th><th>New device</th><th>Existing partner</th></tr></thead>
        <tbody>
          ${vis.slice(0, 300).map(i => `
            <tr>
              <td class="small" style="white-space:nowrap">${esc(i.formula)}</td>
              <td class="small">${i.delta_khz}</td>
              <td class="small">IMD${i.order}</td>
              <td class="small">${esc(rfcAnchorName(i.anchor))} (RX ${i.rx_mhz})</td>
              <td class="small">${esc(i.site_name || i.site_id)}</td>
              <td class="small">${linkable && i.device_id
                ? `<a href="#" onclick="rfcCardFor('${escAttr(i.device_id)}','${escAttr(i.anchor)}');return false">${esc(i.client || i.trigger_key)}</a>`
                : esc(i.client || i.trigger_key)}
                <span class="badge">${i.trigger_class === 'added' ? 'added' : 're-tuned'}</span></td>
              <td class="small">${linkable && i.partner_device_id
                ? `<a href="#" onclick="rfcCardFor('${escAttr(i.partner_device_id)}','${escAttr(i.anchor)}');return false">${esc(i.partner_client || i.partner_key)}</a>`
                : esc(i.partner_client || i.partner_key)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── onset detection helper ──

function rfcParseDate(s) {
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(+m[1], m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);          // dd/mm/yyyy (AU)
  if (m) return Date.UTC(m[3].length === 2 ? 2000 + +m[3] : +m[3], m[2] - 1, +m[1]);
  const d = Date.parse(s);
  return isNaN(d) ? null : d;
}

// Accepts "date,value" (single series) or "station,date,value" per line.
function rfcParseCorr(text) {
  const series = {};
  let bad = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || /^#/.test(t) || /^station\b/i.test(t) || /^date\b/i.test(t)) continue;
    const parts = t.split(/[,;\t]+/).map(s => s.trim()).filter(Boolean);
    let name = '', ds, vs;
    if (parts.length >= 3) [name, ds, vs] = parts;
    else if (parts.length === 2) [ds, vs] = parts;
    else { bad++; continue; }
    const when = rfcParseDate(ds), v = parseFloat(vs);
    if (when == null || isNaN(v)) { bad++; continue; }
    const key = name || 'pasted series';
    (series[key] = series[key] || []).push({ t: when, v });
  }
  for (const k in series) series[k].sort((a, b) => a.t - b.t);
  return { series, bad };
}

// Rolling-median step detector — deliberately simple. A step is a shift in the
// k-point median exceeding 4× the series' robust noise estimate.
function rfcDetectSteps(series) {
  const med = arr => {
    const s = arr.slice().sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const steps = [];
  for (const [name, pts] of Object.entries(series)) {
    const v = pts.map(p => p.v), n = v.length;
    const k = Math.max(3, Math.min(7, Math.floor(n / 4)));
    if (n < 2 * k) continue;
    const diffs = [];
    for (let i = 1; i < n; i++) diffs.push(Math.abs(v[i] - v[i - 1]));
    const noise = Math.max(1.4826 * med(diffs), 1e-9);
    const cand = [];
    for (let i = k; i <= n - k; i++) {
      cand.push({ i, jump: med(v.slice(i, i + k)) - med(v.slice(i - k, i)) });
    }
    cand.sort((a, b) => Math.abs(b.jump) - Math.abs(a.jump));
    const picked = [];
    for (const c of cand) {
      if (Math.abs(c.jump) < 4 * noise) break;
      if (picked.some(p => Math.abs(p.i - c.i) < k)) continue;
      picked.push(c);
      if (picked.length >= 3) break;
    }
    for (const c of picked) {
      steps.push({ station: name, date: new Date(pts[c.i].t).toISOString().slice(0, 10),
                   jump: c.jump });
    }
  }
  steps.sort((a, b) => Math.abs(b.jump) - Math.abs(a.jump));
  return steps;
}

function rfcAnalyseCorr() {
  const R = state.rfc;
  const txt = (document.getElementById('rfc-corr') || {}).value || '';
  R.corrText = txt;
  const { series, bad } = rfcParseCorr(txt);
  R.corrSeries = series;
  R.corrBad = bad;
  R.corrSteps = rfcDetectSteps(series);
  renderMain();
}

function rfcMatchStation(name) {
  const stations = state.data?.stations || [];
  const q = name.toLowerCase();
  return stations.find(s => s.id === name || (s.name || '').toLowerCase() === q) ||
         stations.find(s => (s.name || '').toLowerCase().includes(q)) || null;
}

function rfcOnsetHelperHtml() {
  const R = state.rfc;
  return `
    <p class="small" style="color:var(--muted)">Paste a per-station corruption time series —
      one line per day: <code>date, count</code> or <code>station, date, count</code>
      (ISO or dd/mm/yyyy dates). A rolling-median step detector finds sudden onsets; detected
      dates pre-fill the onset selector, and the series plots in the timeline's data-quality
      band above.</p>
    <textarea id="rfc-corr" rows="5" style="width:100%"
      placeholder="Bluff Ck, 2026-04-01, 0&#10;Bluff Ck, 2026-04-02, 1&#10;Bluff Ck, 2026-04-03, 14&#10;…">${esc(R.corrText)}</textarea>
    <div style="margin:.4rem 0"><button onclick="rfcAnalyseCorr()">Detect steps</button></div>
    ${R.corrSteps === null ? '' : rfcStepsHtml()}`;
}

function rfcStepsHtml() {
  const R = state.rfc;
  const nSeries = Object.keys(R.corrSeries || {}).length;
  if (!nSeries) {
    return `<p class="small" style="color:var(--muted)">No parseable lines${R.corrBad ? ` (${R.corrBad} rejected)` : ''}.</p>`;
  }
  const stepsHtml = R.corrSteps.length ? `
    <div class="small" style="margin:.3rem 0">Detected steps (largest first — click to set as onset):</div>
    <div style="display:flex;gap:.4rem;flex-wrap:wrap">
      ${R.corrSteps.map(s => `
        <button class="small" onclick="rfcUseOnset('${escAttr(s.date)}')"
                title="Rolling-median shift of ${s.jump > 0 ? '+' : ''}${s.jump.toFixed(1)} at ${escAttr(s.station)}">
          ${esc(s.date)} · ${esc(s.station)} ${s.jump > 0 ? '▲' : '▼'}${Math.abs(s.jump).toFixed(1)}</button>`).join('')}
    </div>` : `
    <p class="small" style="color:var(--muted)">No step larger than 4× the noise floor found in
      ${nSeries} series${R.corrBad ? ` (${R.corrBad} lines rejected)` : ''} — the change may be
      gradual rather than a step, which points away from a switched-on transmitter.</p>`;
  return stepsHtml + rfcGroupingHtml();
}

// If every affected station reports through the same repeater, the search
// narrows to one site — corruption confined to one repeater's children is
// strong evidence for a specific site rather than a network-wide problem.
function rfcGroupingHtml() {
  const R = state.rfc;
  const names = Object.keys(R.corrSeries || {}).filter(n => n !== 'pasted series');
  if (!names.length || !state.data) return '';
  const rows = names.map(n => {
    const st = rfcMatchStation(n);
    const reps = st ? findRepeaterMatches(st, state.data.stations) : [];
    return { n, st, reps };
  });
  const matched = rows.filter(r => r.st && r.reps.length);
  let commonHtml = '';
  if (matched.length > 1) {
    const common = matched[0].reps.filter(r =>
      matched.every(m => m.reps.some(x => x.id === r.id)));
    if (common.length) {
      const c = common[0];
      const isAnchor = !!state.acma.anchorById[c.id];
      commonHtml = `
        <p class="small" style="margin:.4rem 0">
          ⚑ <strong>All ${matched.length} matched stations report through
          ${esc(c.name)}</strong> — corruption confined to one repeater's stations is strong
          evidence for something at or near that specific site.
          ${isAnchor ? `<button class="small" onclick="rfcFocusAnchor('${escAttr(c.id)}')">Focus ${esc(c.name)}</button>`
                     : `<span style="color:var(--muted)">(${esc(c.name)} has no RX frequency recorded, so it is not in the ACMA threat layer — record repeater.rx_mhz to include it.)</span>`}
        </p>`;
    } else {
      commonHtml = `
        <p class="small" style="color:var(--muted);margin:.4rem 0">
          The affected stations do not share a single repeater — that spreads the search across
          sites, or points to something common to the receive side (base station, decoder) rather
          than one repeater's RF environment.</p>`;
    }
  }
  return `
    <div style="margin-top:.5rem">
      <div class="small" style="color:var(--muted)">Which repeater serves each affected station:</div>
      <table class="bf-table" style="margin-top:.2rem">
        <thead><tr><th>Series</th><th>Matched station</th><th>Serving repeater(s)</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="small">${esc(r.n)}</td>
              <td class="small">${r.st ? esc(r.st.name) : '<span style="color:var(--muted)">no match in stations.json</span>'}</td>
              <td class="small">${r.reps.length ? r.reps.map(x => esc(x.name)).join(', ')
                : '<span style="color:var(--muted)">—</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${commonHtml}
    </div>`;
}

// ── help ──

function rfcHelpHtml() {
  return `
    <details>
      <summary style="cursor:pointer"><strong>What this page will not catch</strong>
        <span class="small" style="color:var(--muted)">— read before trusting an empty result</span></summary>
      <div class="small" style="color:var(--muted);margin-top:.4rem">
        <p><strong>Anything unlicensed or faulty.</strong> Solar charge controllers, VMS/LED sign
        drivers, electric fence energisers, powerline arcing, out-of-spec or failing equipment —
        the most common sources of a raised noise floor at a remote gauging site — never appear
        in the register.</p>
        <p><strong>Removals and prior values before archiving began.</strong> ACMA publishes a
        daily snapshot with no back-catalogue; history exists only from the first archived month
        onward (see the snapshot index in the diff panel). Nothing recovers earlier months.</p>
        <p><strong>Physical installation dates.</strong> An authorisation date is when the
        paperwork was approved. Transmitters go live months later, or never.</p>
        <p><strong>Amateur transmissions.</strong> Not recorded by location — the
        50.5 MHz × 3 = 151.5 MHz harmonic path needs a spectrum sweep, not this register.</p>
        <p><strong>Degradation with no register event at all.</strong> Corroding mast joints
        maturing into an intermod mixer, a failing PA growing spurious emissions, water in a
        feeder. <strong>A step change in noise floor with no ACMA event nearby is itself a
        finding</strong> — it points at your own infrastructure, and this page says so rather
        than returning a bare empty table.</p>
        <p>Data: ACMA Register of Radiocommunications Licences (CC BY 4.0). Licensee details must
        not be used for unsolicited contact (Spam Act 2003 / DNCR Act 2006).</p>
      </div>
    </details>`;
}

// ── INTERFERENCE WORKBENCH tab ───────────────────────────────────────────────────
// A single investigation surface: select the stations you believe are affected and
// the Workbench assembles the evidence, scores five competing explanations and
// names what to check next. It argues a case rather than showing numbers — every
// score expands to its inputs, confidence is always stated, and a weak or empty
// result is reported as a finding with a next step, never a blank panel.
// Wording discipline: never "cause" — always "most consistent with" / "leading
// hypothesis" / "worth checking first".
// Reuses the Bit Flipper sensor index (H5 misattribution check), the pass-range
// helpers (H1), the ACMA threat data (suspect list, strip plot, map squares) and
// the RF Changes timeline. Nothing is fetched until the tab is opened, and the
// ACMA/RFC files only load once an investigation has a leading candidate.

const WB_HYP = {
  h1: { short: 'H1', label: 'Repeater common-mode' },
  h2: { short: 'H2', label: 'Geographic / regional' },
  h3: { short: 'H3', label: 'Channel-wide' },
  h4: { short: 'H4', label: 'Site-local, independent' },
  h5: { short: 'H5', label: 'Misattribution artefact' },
};

const WB_SYMPTOMS = {
  bitflips:       'Bit flips',
  values:         'Value corruption',
  dropouts:       'Dropouts / missing reports',
  misattribution: 'Cross-station misattribution',
  noise:          'Raised noise floor',
};

// Symptom → hypothesis score multiplier. Deliberately mild (≤1.35): the symptom
// tilts the ranking, the data decides it. Applied multiplicatively, capped at
// 0.99, and shown in every score's expandable arithmetic.
const WB_SYMPTOM_WEIGHT = {
  bitflips:       { h1: 1.10, h3: 1.10 },
  values:         { h1: 1.10, h5: 1.10 },
  dropouts:       { h2: 1.10, h3: 1.10, h4: 1.10 },
  misattribution: { h5: 1.35, h1: 0.85 },
  noise:          { h2: 1.15, h3: 1.15 },
};

const WB_CASES_KEY     = 'mn-wb-cases';
const WB_MATRIX_COLS   = 10;   // routing-matrix column cap (ranked candidates)
const WB_MATRIX_GOOD   = 15;   // known-good rows shown in the matrix
const WB_AFFECTED_COLOR = '#c7401a';
const WB_GOOD_COLOR     = '#107c10';
const WB_DISC_COLOR     = '#ff8c00';

// ── selection ──

function wbParseIds(text) {
  return [...new Set(String(text || '').split(/[\s,;]+/)
    .map(t => parseInt(t, 10))
    .filter(n => !isNaN(n) && n > 0 && n < 65536))];
}

function wbAddFromPaste(list) {
  const el = document.getElementById('wb-paste');
  const ids = wbParseIds(el ? el.value : '');
  if (!ids.length) return;
  wbAddIds(ids, list);
  if (el) el.value = '';
  renderMain();
}

function wbAddIds(ids, list) {
  const other = list === 'affected' ? 'good' : 'affected';
  state.wb[other] = state.wb[other].filter(id => !ids.includes(id));
  state.wb[list]  = [...new Set([...state.wb[list], ...ids])];
}

function wbAddStation(stationId, list) {
  const s = (state.data?.stations || []).find(x => x.id === stationId);
  if (!s) return;
  wbAddIds(stationAlertIds(s), list);
  state.wb.pickQuery = '';
  renderMain();
}

function wbRemoveId(list, id) {
  state.wb[list] = state.wb[list].filter(x => x !== id);
  renderMain();
}

function wbSwapId(list, id) {
  const other = list === 'affected' ? 'good' : 'affected';
  state.wb[list] = state.wb[list].filter(x => x !== id);
  if (!state.wb[other].includes(id)) state.wb[other].push(id);
  renderMain();
}

function wbClearCase() {
  Object.assign(state.wb, { affected: [], good: [], onset: '', onsetEnd: '',
                            symptom: '', caseName: '', lastAnalysis: null });
  renderMain();
}

// Worked example for the intro screen: flag a handful of stations behind the
// busiest documented repeater as affected plus two of its neighbours as
// known-good — a clean H1 pattern that also demonstrates the specificity
// penalty of a heavily-shared repeater.
function wbLoadExample() {
  const all = state.data.stations;
  const reps = all.filter(s => s.roles.includes('repeater') && s.repeater &&
                               (s.repeater.pass_ranges || []).length);
  let best = null, bestServed = [];
  for (const r of reps) {
    const served = all.filter(s => s.id !== r.id && s.roles.includes('field') &&
      stationAlertIds(s).some(id => passRangeCoversId(r.repeater, id)));
    if (served.length > bestServed.length) { best = r; bestServed = served; }
  }
  if (!best || bestServed.length < 7) return;
  state.wb.affected = bestServed.slice(0, 5).map(s => stationAlertIds(s)[0]);
  state.wb.good     = bestServed.slice(5, 7).map(s => stationAlertIds(s)[0]);
  state.wb.symptom  = 'bitflips';
  state.wb.caseName = 'Worked example';
  renderMain();
}

// ── bit arithmetic (shared with the Bit Flipper's mental model) ──

function wbPopcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }

function wbBitsDiff(a, b) {
  const out = []; const x = a ^ b;
  for (let i = 0; i < 16; i++) if (x & (1 << i)) out.push(i);
  return out;
}

// Deep-link into the existing Bit Flipper rather than reimplementing it.
function wbOpenBf(addr) {
  state.bfInput = String(addr);
  state.bfBits = '2';
  state.bfOnlyMatches = true;
  switchTab('bitflipper');
}

// ── analysis core ──

// Resolve ALERT addresses against the sensor index → unique station records
// plus the addresses that matched nothing in the database.
function wbResolve(addrs, idx) {
  const byStation = new Map(), unmatched = [];
  for (const id of addrs) {
    const hits = idx.get(id) || [];
    if (!hits.length) { unmatched.push(id); continue; }
    for (const { station } of hits) {
      if (!byStation.has(station.id)) byStation.set(station.id, { station, addrs: [] });
      const rec = byStation.get(station.id);
      if (!rec.addrs.includes(id)) rec.addrs.push(id);
    }
  }
  return { byStation, stations: [...byStation.values()].map(x => x.station), unmatched };
}

function wbMeanPairKm(stations) {
  const pts = stations.filter(s => s.lat != null && s.lon != null);
  if (pts.length < 2) return null;
  let sum = 0, n = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      sum += acmaHaversineKm(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon); n++;
    }
  return sum / n;
}

// Evaluate all five hypotheses against the current selection. Pure computation
// — no DOM, no fetches — so the same result feeds the verdict card, ranking,
// evidence panels, map and exports within one render.
function wbAnalyse() {
  const wbs = state.wb;
  const idx  = buildSensorIndex();
  const aff  = wbResolve(wbs.affected, idx);
  const goodR = wbResolve(wbs.good, idx);
  const A      = aff.stations;
  const affSet = new Set(A.map(s => s.id));
  const G      = goodR.stations.filter(s => !affSet.has(s.id));
  const goodSet = new Set(G.map(s => s.id));

  const all     = state.data.stations;
  const idsCache = new Map();
  const idsOf = s => {
    if (!idsCache.has(s.id)) idsCache.set(s.id, stationAlertIds(s));
    return idsCache.get(s.id);
  };
  const withIds = all.filter(s => idsOf(s).length);

  // Comparison universe: explicit known-good stations when given, otherwise
  // every station not flagged affected is assumed good (stated in the UI).
  const explicitGood = G.length > 0;
  const U = explicitGood ? G : withIds.filter(s => !affSet.has(s.id));

  const repeaters = all.filter(s => s.roles.includes('repeater') && s.repeater &&
    Array.isArray(s.repeater.pass_ranges) && s.repeater.pass_ranges.length);
  const repeaterRoleCount = all.filter(s => s.roles.includes('repeater')).length;
  const passes = (s, r) => s.id !== r.id && idsOf(s).some(id => passRangeCoversId(r.repeater, id));

  // station.id → repeaters whose pass ranges carry it (A ∪ U only)
  const throughMap = new Map();
  for (const s of [...A, ...U]) {
    const rs = repeaters.filter(r => passes(s, r));
    if (rs.length) throughMap.set(s.id, rs);
  }
  const A_routed = A.filter(s => throughMap.has(s.id));
  const U_routed = U.filter(s => throughMap.has(s.id));
  const A_unrouted = A.filter(s => !throughMap.has(s.id));

  // ── H1: per-repeater explanatory power ──
  const byRep = new Map();
  for (const s of A_routed) for (const r of throughMap.get(s.id)) {
    if (!byRep.has(r.id)) byRep.set(r.id, { r, passA: [], passUn: 0 });
    byRep.get(r.id).passA.push(s);
  }
  for (const s of U_routed) for (const r of throughMap.get(s.id)) {
    if (byRep.has(r.id)) byRep.get(r.id).passUn++;
  }
  const candidates = [...byRep.values()].map(c => {
    const through     = c.passA.length + c.passUn;
    const coverage    = A_routed.length ? c.passA.length / A_routed.length : 0;
    const specificity = through ? 1 - c.passUn / through : 0;
    const power = (coverage + specificity) > 0
      ? 2 * coverage * specificity / (coverage + specificity) : 0;
    return { ...c, through, coverage, specificity, power, chain: [] };
  }).sort((a, b) => b.power - a.power || b.coverage - a.coverage);

  // Two repeaters in series both score highly — flag them as a chain rather
  // than presenting them as competing suspects. R1 feeds R2 when R2's pass
  // ranges carry R1's own ALERT ids.
  const topSlice = candidates.slice(0, 6)
    .filter(c => candidates.length && c.power >= 0.75 * candidates[0].power);
  for (const c1 of topSlice) for (const c2 of topSlice) {
    if (c1 === c2) continue;
    if (idsOf(c1.r).some(id => passRangeCoversId(c2.r.repeater, id))) {
      if (!c1.chain.includes(c2.r.name)) c1.chain.push(c2.r.name);
      if (!c2.chain.includes(c1.r.name)) c2.chain.push(c1.r.name);
    }
  }
  const top = candidates[0] || null;
  const h1base = top ? top.power : 0;

  // ── affected-cluster geometry (shared by H2 and the discriminators) ──
  const affPts = A.filter(s => s.lat != null && s.lon != null);
  let cluster = null;
  if (affPts.length >= 2) {
    const cLat = affPts.reduce((t, s) => t + s.lat, 0) / affPts.length;
    const cLon = affPts.reduce((t, s) => t + s.lon, 0) / affPts.length;
    const dists = affPts.map(s => acmaHaversineKm(cLat, cLon, s.lat, s.lon));
    cluster = { lat: cLat, lon: cLon, radiusKm: Math.max(5, Math.max(...dists)) };
  }

  // ── H2: spatial clustering vs network baseline ──
  // Two terms, mirroring H1's grammar: tightness (are the affected stations
  // closer together than the network at large?) and cluster specificity (how
  // much of the affected area is actually affected? — a tight cluster where 25
  // of 30 neighbours are fine points at shared infrastructure, not geography).
  const dAff = wbMeanPairKm(A);
  const netPts = withIds.filter(s => s.lat != null && s.lon != null);
  const stride = Math.max(1, Math.ceil(netPts.length / 160));   // deterministic sample
  const sample = netPts.filter((_, i) => i % stride === 0);
  const dNet = wbMeanPairKm(sample);
  const h2ratio = (dAff != null && dNet) ? dNet / Math.max(dAff, 0.5) : null;
  const h2tight = (h2ratio == null || affPts.length < 3)
    ? 0 : Math.max(0, Math.min(1, (h2ratio - 1) / 4));
  let h2inCluster = 0, h2spec = 0;
  if (cluster && affPts.length >= 3) {
    const uIn = U.filter(s => s.lat != null && s.lon != null &&
      acmaHaversineKm(cluster.lat, cluster.lon, s.lat, s.lon) <= cluster.radiusKm).length;
    h2inCluster = uIn + affPts.length;
    h2spec = h2inCluster ? affPts.length / h2inCluster : 0;
  }
  const h2base = (h2tight + h2spec) > 0 ? 2 * h2tight * h2spec / (h2tight + h2spec) : 0;

  // ── H3: shared RX channel vs base rate ──
  const freqCount = list => {
    const m = new Map();
    for (const s of list) {
      const fs = new Set((throughMap.get(s.id) || [])
        .map(r => r.repeater.rx_mhz).filter(f => f != null));
      for (const f of fs) m.set(f, (m.get(f) || 0) + 1);
    }
    return m;
  };
  const fA = freqCount(A_routed), fU = freqCount(U_routed);
  const h3rows = [...fA.entries()].map(([f, n]) => {
    const share = A_routed.length ? n / A_routed.length : 0;
    const base  = U_routed.length ? (fU.get(f) || 0) / U_routed.length : 0;
    const lift  = base > 0 ? share / base : (share > 0 ? null : 1);  // null = no base rate
    const liftEff = lift == null ? 3 : Math.min(lift, 4);
    const score = Math.max(0, Math.min(0.9, (liftEff - 1) / 1.5)) * share;
    return { f, n, share, base, lift, score };
  }).sort((a, b) => b.score - a.score);
  const h3best = h3rows[0] || null;
  const h3base = h3best ? h3best.score : 0;

  // ── H5: near-address pairs among the selected ALERT ids ──
  const addrs = [...new Set([...wbs.affected])];
  const h5pairs = [];
  for (let i = 0; i < addrs.length; i++)
    for (let j = i + 1; j < addrs.length; j++) {
      const d = wbPopcount(addrs[i] ^ addrs[j]);
      if (d >= 1 && d <= 2)
        h5pairs.push({ a: addrs[i], b: addrs[j], d, bits: wbBitsDiff(addrs[i], addrs[j]) });
    }
  h5pairs.sort((x, y) => x.d - y.d || x.a - y.a);
  const h5d1 = h5pairs.filter(p => p.d === 1).length;
  const h5base = h5d1 ? Math.min(0.95, 0.8 + 0.05 * h5d1)
               : h5pairs.length ? 0.45 : 0.05;

  // ── H4: the residual — strong only when every shared-cause hypothesis is weak ──
  const h4base = Math.max(0.05, Math.min(0.7, 0.7 * (1 - Math.max(h1base, h2base, h3base))));

  // ── ranking, symptom weights, confidence ──
  const w = WB_SYMPTOM_WEIGHT[wbs.symptom] || {};
  const mk = (key, base) => ({
    key, ...WB_HYP[key], base,
    weight: w[key] || 1,
    score: Math.min(0.99, base * (w[key] || 1)),
  });
  const hyps = [mk('h1', h1base), mk('h2', h2base), mk('h3', h3base),
                mk('h4', h4base), mk('h5', h5base)];
  hyps.sort((a, b) => b.score - a.score);
  const lead = hyps[0], second = hyps[1];
  const gap = lead.score - second.score;

  const hOf = k => hyps.find(h => h.key === k);
  let confidence = lead.score >= 0.6 && gap >= 0.2 ? 'high'
                 : lead.score >= 0.35 && gap >= 0.08 ? 'moderate' : 'low';
  const notes = [];
  if (hOf('h1').score >= 0.45 && hOf('h2').score >= 0.45 &&
      Math.abs(hOf('h1').score - hOf('h2').score) < 0.15) {
    if (confidence === 'high') confidence = 'moderate';
    notes.push('Your affected stations share both a repeater and a location, so H1 and H2 ' +
      'cannot be separated with the current selection — repeaters serve geographic areas. ' +
      'The discriminating stations below are how to break the tie.');
  }
  if (A.length < 3) {
    confidence = 'low';
    notes.push(`Only ${A.length} affected station${A.length === 1 ? '' : 's'} resolved — ` +
      'most patterns need at least three to mean much.');
  }
  if (!explicitGood) {
    notes.push('No known-good stations marked: specificity assumes every unselected station ' +
      'is fine, which overstates it if the event is wider than your selection.');
  }
  if (A_unrouted.length) {
    notes.push(`${A_unrouted.length} affected station${A_unrouted.length === 1 ? ' has' : 's have'} ` +
      'no recorded routing — they can neither support nor refute H1 and are excluded from its arithmetic.');
  }
  if (aff.unmatched.length) {
    notes.push(`Address${aff.unmatched.length === 1 ? '' : 'es'} ${aff.unmatched.join(', ')} ` +
      'matched no station in the database — still included in the misattribution check (H5), invisible everywhere else.');
  }

  // ── discriminating stations: the highest-value observation in the analysis ──
  // Inside the affected cluster, routed via something other than the leading
  // repeater — clean strengthens H1, affected strengthens H2. Also the affected
  // stations the leading repeater does NOT explain.
  let disc = [], unexplained = [];
  if (top && cluster) {
    disc = all
      .filter(s => !affSet.has(s.id) && s.lat != null && s.lon != null && idsOf(s).length &&
                   !s.roles.includes('repeater'))
      .map(s => ({ s, km: acmaHaversineKm(cluster.lat, cluster.lon, s.lat, s.lon) }))
      .filter(x => x.km <= cluster.radiusKm)
      .filter(x => !passes(x.s, top.r))
      .map(x => ({ ...x,
        via: repeaters.filter(r => passes(x.s, r)).map(r => r.name),
        status: goodSet.has(x.s.id) ? 'known-good' : 'unchecked' }))
      .filter(x => x.via.length)
      .sort((a, b) =>
        (a.status === 'unchecked' ? 0 : 1) - (b.status === 'unchecked' ? 0 : 1) || a.km - b.km)
      .slice(0, 5);
    const inTop = new Set(top.passA.map(s => s.id));
    unexplained = A_routed.filter(s => !inTop.has(s.id));
  }

  // ── plain-language statements (kept as text; escaped at render) ──
  const stmt = {};
  stmt.h1 = top
    ? `${top.passA.length} of ${A_routed.length} routed affected stations pass through ` +
      `${top.r.name}; ${top.passUn} of the ${top.through} stations through it are unaffected.` +
      (top.chain.length ? ` In series with ${top.chain.join(', ')} — a chain, not competing suspects.` : '')
    : (A_routed.length
        ? 'No documented repeater carries any of the affected stations — H1 cannot fire.'
        : 'None of the affected stations have recorded pass-range routing, so the repeater ' +
          'hypothesis cannot be evaluated — backfilling pass ranges is the fix.');
  stmt.h2 = (h2ratio != null && affPts.length >= 3)
    ? `Affected stations are ${h2ratio.toFixed(1)}× more tightly clustered than the network ` +
      `baseline (mean spacing ${dAff.toFixed(0)} km vs ${dNet.toFixed(0)} km)` +
      (h2inCluster ? `, but ${affPts.length} of the ${h2inCluster} comparison stations inside ` +
        `that area are affected (${Math.round(h2spec * 100)}%).` : '.') +
      (h2ratio < 1.5 ? ' Not meaningfully tighter — this looks routing- or site-related, not regional.'
        : h2spec < 0.4 ? ' A tight cluster where most neighbours are fine points at shared ' +
          'infrastructure, not a blanket regional source.'
        : ' This looks regional — but repeaters serve regions too; see the confound note.')
    : 'Fewer than three affected stations have coordinates — spatial clustering cannot be assessed.';
  stmt.h3 = h3best
    ? `${Math.round(h3best.share * 100)}% of routed affected stations sit behind ` +
      `${h3best.f} MHz RX, against a ${Math.round(h3best.base * 100)}% base rate` +
      (h3best.lift == null ? ' (no unaffected comparison stations on that channel).'
        : ` — lift ${h3best.lift.toFixed(1)}×.`) +
      (h3best.lift != null && h3best.lift < 1.3
        ? ' Nearly everything shares this channel, so the overlap is uninformative.' : '')
    : 'No shared RX channel among the routed affected stations.';
  stmt.h4 = 'The residual explanation: it strengthens only as the shared-cause hypotheses ' +
    `weaken (currently max ${Math.max(h1base, h2base, h3base).toFixed(2)}). Staggered onsets ` +
    'and no shared pattern point at separate local sources — solar controllers, fences, powerline arcing.';
  stmt.h5 = h5pairs.length
    ? `${h5pairs.length} pair${h5pairs.length === 1 ? '' : 's'} of selected addresses within ` +
      `2 bit flips of each other${h5d1 ? ` (${h5d1} at distance 1)` : ''} — some "affected" ` +
      'stations may be one victim and one ghost of the same corrupted packets.'
    : 'No selected addresses within 2 bit flips of each other — the selection looks independently addressed.';

  return { aff, A, G, U, explicitGood, A_routed, U_routed, A_unrouted,
           unmatched: aff.unmatched, goodUnmatched: goodR.unmatched,
           repeaters, repeaterRoleCount, passes, throughMap,
           candidates, top,
           h2: { dAff, dNet, ratio: h2ratio, nPts: affPts.length, sampleN: sample.length,
                 tight: h2tight, spec: h2spec, inCluster: h2inCluster, base: h2base },
           h3: { rows: h3rows, best: h3best, base: h3base },
           h5: { pairs: h5pairs, d1: h5d1, base: h5base },
           h4: { base: h4base },
           h1: { base: h1base },
           hyps, lead, second, gap, confidence, notes,
           disc, unexplained, cluster,
           stmt, nextCheck: null };  // nextCheck filled below (needs stmt/disc)
}

// The one observation most likely to change the answer, phrased as an action.
function wbNextCheck(an) {
  const lead = an.lead;
  if (lead.key === 'h5' && an.h5.pairs.length) {
    const p = an.h5.pairs[0];
    return `Open addresses ${p.a} and ${p.b} in the Bit Flipper and compare their data ` +
      'series — misattributed readings appear in one series as ghosts of the other. ' +
      'Deselect the victim and re-run before trusting anything else here.';
  }
  const un = an.disc.find(d => d.status === 'unchecked');
  if ((lead.key === 'h1' || lead.key === 'h2') && un) {
    return `Station ${un.s.name} is inside the affected area but routes via ${un.via[0]}. ` +
      'If its data is clean, the repeater explanation strengthens considerably; if it is ' +
      'also affected, the pattern is more likely geographic. Check it, mark it here, re-run.';
  }
  if (lead.key === 'h1') {
    return 'Mark known-good stations — especially any inside the affected area on a ' +
      'different repeater. Specificity is currently assumed, not confirmed.';
  }
  if (lead.key === 'h2') {
    return 'Check the ACMA candidates near the cluster centre and the weather record at ' +
      'onset — a regional pattern with sudden onset suggests ducting or a new local emitter.';
  }
  if (lead.key === 'h3') {
    return 'Check a station behind the same RX channel in a different region: a channel-wide ' +
      'source crosses regions, a repeater fault does not.';
  }
  return 'Run a battery-only power-down test at each affected site (kill mains/solar, watch ' +
    'the noise floor) — the classic separator for independent site-local sources.';
}

// ── saved investigations & shareable URL state ──

function wbCases() {
  try { return JSON.parse(localStorage.getItem(WB_CASES_KEY) || '{}'); }
  catch (_) { return {}; }
}

function wbSaveCase() {
  const el = document.getElementById('wb-case-name');
  const name = ((el && el.value) || state.wb.caseName || '').trim();
  if (!name) { alert('Name the investigation first.'); return; }
  const cases = wbCases();
  cases[name] = { a: state.wb.affected, g: state.wb.good, o: state.wb.onset,
                  e: state.wb.onsetEnd, s: state.wb.symptom, saved: new Date().toISOString() };
  localStorage.setItem(WB_CASES_KEY, JSON.stringify(cases));
  state.wb.caseName = name;
  renderMain();
}

function wbLoadCase(name) {
  const c = wbCases()[name];
  if (!c) return;
  Object.assign(state.wb, { affected: c.a || [], good: c.g || [], onset: c.o || '',
                            onsetEnd: c.e || '', symptom: c.s || '', caseName: name });
  renderMain();
}

function wbDeleteCase() {
  const sel = document.getElementById('wb-case-sel');
  const name = sel && sel.value;
  if (!name) return;
  const cases = wbCases();
  delete cases[name];
  localStorage.setItem(WB_CASES_KEY, JSON.stringify(cases));
  renderMain();
}

function wbHashState() {
  const wbs = state.wb;
  if (!wbs.affected.length && !wbs.good.length) return null;
  const p = new URLSearchParams();
  p.set('a', wbs.affected.join('.'));
  if (wbs.good.length) p.set('g', wbs.good.join('.'));
  if (wbs.onset)       p.set('o', wbs.onset);
  if (wbs.onsetEnd)    p.set('e', wbs.onsetEnd);
  if (wbs.symptom)     p.set('s', wbs.symptom);
  if (wbs.caseName)    p.set('n', wbs.caseName);
  return 'wb&' + p.toString();
}

function wbSyncUrl() {
  try {
    const h = wbHashState();
    const cur = location.hash.replace(/^#/, '');
    if (h) { if (cur !== h) history.replaceState(null, '', '#' + h); }
    else if (cur.startsWith('wb')) history.replaceState(null, '', location.pathname + location.search);
  } catch (_) {}   // history API unavailable over some file:// contexts
}

function wbShareLink(btn) {
  const h = wbHashState();
  if (!h) return;
  const url = location.href.split('#')[0] + '#' + h;
  const done = ok => {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = ok ? 'Copied ✓' : url;
    setTimeout(() => { btn.textContent = prev; }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => done(true), () => done(false));
  } else done(false);
}

function wbRestoreFromUrl() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw.startsWith('wb')) return;
  const p = new URLSearchParams(raw.slice(3));
  const nums = v => (v || '').split(/[.,]/).map(x => parseInt(x, 10))
    .filter(n => !isNaN(n) && n > 0 && n < 65536);
  state.wb.affected = nums(p.get('a'));
  state.wb.good     = nums(p.get('g'));
  state.wb.onset    = (p.get('o') || '').slice(0, 10);
  state.wb.onsetEnd = (p.get('e') || '').slice(0, 10);
  state.wb.symptom  = WB_SYMPTOMS[p.get('s')] ? p.get('s') : '';
  state.wb.caseName = (p.get('n') || '').slice(0, 80);
  if (state.wb.affected.length || state.wb.good.length) {
    state.activeTab = 'workbench';
    renderTabs();
    renderMain();
  }
}

// ── education layer ──

// Tier 1: dotted-underline tooltip; clicking through opens the concept drawer
// (tier 3) when a concept id is given.
function wbT(text, tip, conceptId) {
  const click = conceptId ? ` onclick="wbOpenConcept('${escAttr(conceptId)}')"` : '';
  return `<span class="wb-term${conceptId ? ' wb-term-link' : ''}" tabindex="0"` +
         ` data-tip="${esc(tip)}"${click}>${esc(text)}</span>`;
}

// Tier 2: per-panel "Why this matters" expander.
function wbWhy(html) {
  return `<details class="wb-why"><summary>Why this matters</summary>
    <div class="small" style="color:var(--muted);margin-top:.35rem">${html}</div></details>`;
}

function wbEnsureConcepts() {
  const wbs = state.wb;
  if (wbs.concepts) return Promise.resolve();
  if (wbs.conceptsPromise) return wbs.conceptsPromise;
  wbs.conceptsPromise = acmaFetchJson('rf-concepts.json')
    .then(d => { wbs.concepts = d; })
    .catch(err => { wbs.conceptsPromise = null; throw err; });
  return wbs.conceptsPromise;
}

function wbOpenConcept(id) {
  state.wb.drawerId = id || null;
  const el = document.getElementById('wb-drawer');
  if (!el) return;
  el.hidden = false;
  el.innerHTML = '<div class="small" style="padding:1rem;color:var(--muted)">Loading concept notes…</div>';
  wbEnsureConcepts().then(() => wbRenderDrawer()).catch(err => {
    el.innerHTML = `<div style="padding:1rem">
      <button onclick="wbCloseDrawer()" style="float:right">×</button>
      <p class="small" style="color:var(--muted)">Concept notes unavailable (${esc(err.message)}) —
      data/rf-concepts.json cannot be fetched over file://.</p></div>`;
  });
}

function wbCloseDrawer() {
  const el = document.getElementById('wb-drawer');
  if (el) { el.hidden = true; el.innerHTML = ''; }
  state.wb.drawerId = null;
}

function wbRenderDrawer() {
  const el = document.getElementById('wb-drawer');
  const data = state.wb.concepts;
  if (!el || !data) return;
  const list = data.concepts || [];
  const cur = list.find(c => c.id === state.wb.drawerId) || null;
  const head = `
    <div class="wb-drawer-head">
      <strong>${cur ? esc(cur.title) : 'RF concepts'}</strong>
      <span>
        ${cur ? `<button onclick="wbOpenConcept('')" title="All concepts">≡</button>` : ''}
        <button onclick="wbCloseDrawer()" title="Close">×</button>
      </span>
    </div>`;
  if (!cur) {
    el.innerHTML = `${head}
      <div class="wb-drawer-body">
        <p class="small" style="color:var(--muted)">Short, field-oriented explainers. Every entry
        says what the phenomenon looks like <em>in your data</em>, not just what it is.</p>
        ${list.map(c => `<a href="#" class="wb-drawer-item"
            onclick="wbOpenConcept('${escAttr(c.id)}');return false">${esc(c.title)}</a>`).join('')}
      </div>`;
    return;
  }
  const also = (cur.see_also || []).map(id => {
    const t = list.find(c => c.id === id);
    return t ? `<a href="#" onclick="wbOpenConcept('${escAttr(id)}');return false">${esc(t.title)}</a>` : '';
  }).filter(Boolean).join(' · ');
  el.innerHTML = `${head}
    <div class="wb-drawer-body">
      <p>${esc(cur.what)}</p>
      <p><strong>In your data:</strong> ${esc(cur.in_your_data)}</p>
      <p><strong>What to do:</strong> ${esc(cur.next)}</p>
      ${also ? `<p class="small" style="color:var(--muted)">See also: ${also}</p>` : ''}
    </div>`;
}

// ── page shell ──

function renderWorkbenchHtml() {
  const wbs = state.wb;
  const hasCase = wbs.affected.length > 0;
  const an = hasCase ? wbAnalyse() : null;
  if (an) an.nextCheck = wbNextCheck(an);
  state.wb.lastAnalysis = an;
  return `
    <div class="wb-page">
      <div class="wb-layout">
        <aside class="stack wb-rail">${wbSetupHtml(an)}</aside>
        <div class="stack">${an ? wbCentreHtml(an) : wbIntroHtml()}</div>
        <aside class="stack wb-rail">${wbRightHtml(an)}</aside>
      </div>
      <div id="acma-card" class="acma-card" hidden></div>
      <div id="wb-drawer" class="wb-drawer" hidden></div>
    </div>`;
}

function initWb() {
  wbSyncUrl();
  const A = state.acma, R = state.rfc;
  const rerender = () => { if (state.activeTab === 'workbench') renderMain(); };
  // Suspects / strip plot / timeline need ACMA + RFC data — fetch only once an
  // investigation exists, and only what hasn't already been loaded elsewhere.
  if (state.wb.affected.length) {
    if (!A.loaded && !A.loadPromise && !A.error) acmaEnsureCore().then(rerender).catch(rerender);
    if (A.loaded && !A.devLoaded && !A.devPromise) acmaEnsureDevices().then(rerender).catch(() => {});
    if (!R.loaded && !R.loadPromise && !R.error) rfcEnsureData().then(rerender).catch(rerender);
  }
  initWbMap();
}

// ── left rail: investigation setup ──

function wbSetupHtml(an) {
  const wbs = state.wb;
  const cases = wbCases();
  const caseNames = Object.keys(cases).sort();
  const passRangeReps = state.data.stations.filter(s =>
    s.roles.includes('repeater') && s.repeater && (s.repeater.pass_ranges || []).length).length;
  const roleReps = state.data.stations.filter(s => s.roles.includes('repeater')).length;
  return `
    <div class="panel">
      <div class="panel-header"><h3>Investigation</h3>
        ${(wbs.affected.length || wbs.good.length) ? '<button onclick="wbClearCase()">Clear</button>' : ''}
      </div>
      <label class="small" style="display:block;margin-top:.5rem">Paste ALERT IDs
        <textarea id="wb-paste" rows="2" style="margin-top:.3rem"
          placeholder="6129, 6130 2316&#10;2320 — space, comma or newline separated"></textarea>
      </label>
      <div class="button-row" style="justify-content:flex-start;margin:.4rem 0">
        <button class="primary" onclick="wbAddFromPaste('affected')">Add as affected</button>
        <button onclick="wbAddFromPaste('good')">Add as known-good</button>
      </div>
      <label class="small" style="display:block;margin-top:.4rem">Or search stations
        <input type="search" id="wb-pick" placeholder="Station name or number…"
               value="${esc(wbs.pickQuery)}" style="margin-top:.3rem"
               oninput="state.wb.pickQuery=this.value;wbRefreshPick()">
      </label>
      <div id="wb-pick-out">${wbPickResultsHtml()}</div>
      ${wbChipsHtml('affected', 'Affected stations')}
      ${wbChipsHtml('good', 'Known-good stations')}
      <p class="small" style="color:var(--muted);margin:.5rem 0 0">
        ${wbT('Known-good', 'Stations you have checked and found fine. Marking them sharpens specificity far more than adding affected stations does.', 'coverage_specificity')}
        stations sharpen the analysis; unselected stations are otherwise assumed good.</p>
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Context</h3></div>
      <div class="upload-grid" style="margin-top:.5rem">
        <label>Onset date <span class="small" style="color:var(--muted)">(blank = unknown)</span>
          <input type="date" value="${esc(wbs.onset)}"
                 onchange="state.wb.onset=this.value;renderMain()">
        </label>
        <label>Onset range end <span class="small" style="color:var(--muted)">(optional)</span>
          <input type="date" value="${esc(wbs.onsetEnd)}"
                 onchange="state.wb.onsetEnd=this.value;renderMain()">
        </label>
        <label>Symptom type
          <select onchange="state.wb.symptom=this.value;renderMain()">
            <option value="">Unknown / mixed</option>
            ${Object.entries(WB_SYMPTOMS).map(([k, v]) => `
              <option value="${k}" ${wbs.symptom === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>
      </div>
      <p class="small" style="color:var(--muted);margin:.5rem 0 0">The symptom mildly weights the
        hypothesis ranking (shown in each score's arithmetic); it never decides it.</p>
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Save / share</h3></div>
      <div class="upload-grid" style="margin-top:.5rem">
        <label>Case name
          <input type="text" id="wb-case-name" value="${esc(wbs.caseName)}" placeholder="e.g. Mt Stuart June event"
                 oninput="state.wb.caseName=this.value">
        </label>
      </div>
      <div class="button-row" style="justify-content:flex-start;margin-top:.5rem">
        <button onclick="wbSaveCase()">Save</button>
        <button onclick="wbShareLink(this)" ${wbs.affected.length ? '' : 'disabled'}>Copy share link</button>
      </div>
      ${caseNames.length ? `
        <div style="display:flex;gap:.4rem;align-items:center;margin-top:.6rem">
          <select id="wb-case-sel" onchange="wbLoadCase(this.value)">
            <option value="">Load saved case…</option>
            ${caseNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
          </select>
          <button onclick="wbDeleteCase()" title="Delete the case selected above">🗑</button>
        </div>` : ''}
      <p class="small" style="color:var(--muted);margin:.5rem 0 0">Cases save to this browser;
        the share link carries the whole investigation in the URL.</p>
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Routing data quality</h3></div>
      <p class="small" style="color:var(--muted);margin:.4rem 0 0">
        ${passRangeReps} of ${roleReps} repeaters have recorded pass ranges — H1 can only see
        those.${an && an.A_unrouted.length ? ` <strong>${an.A_unrouted.length}</strong> of your affected
        stations have no routing data.` : ''} If a suspect repeater is missing here, backfilling its
        pass ranges in stations.json is the highest-value fix.</p>
    </div>`;
}

function wbChipsHtml(list, label) {
  const ids = state.wb[list];
  if (!ids.length) return '';
  // Resolve names cheaply for chip labels (re-uses the analysis index pattern).
  const idx = buildSensorIndex();
  const cls = list === 'affected' ? 'wb-chip-aff' : 'wb-chip-good';
  const swapTitle = list === 'affected' ? 'Move to known-good' : 'Move to affected';
  return `
    <div style="margin-top:.6rem">
      <div class="small" style="color:var(--muted);margin-bottom:.25rem">${label} (${ids.length})</div>
      <div class="wb-chips">
        ${ids.map(id => {
          const hits = idx.get(id) || [];
          const name = hits.length ? hits[0].station.name : 'not in database';
          return `<span class="wb-chip ${cls}${hits.length ? '' : ' wb-chip-miss'}" title="${esc(name)}">
            <strong>${id}</strong> <span class="wb-chip-name">${esc(name)}</span>
            <a href="#" title="${swapTitle}" onclick="wbSwapId('${list}',${id});return false">⇄</a>
            <a href="#" title="Remove" onclick="wbRemoveId('${list}',${id});return false">×</a>
          </span>`;
        }).join('')}
      </div>
    </div>`;
}

function wbRefreshPick() {
  const el = document.getElementById('wb-pick-out');
  if (el) el.innerHTML = wbPickResultsHtml();
}

function wbPickResultsHtml() {
  const q = (state.wb.pickQuery || '').trim().toLowerCase();
  if (q.length < 2) return '';
  const hits = state.data.stations.filter(s => stationAlertIds(s).length &&
    (s.name.toLowerCase().includes(q) || (s.station_number || '').includes(q))).slice(0, 8);
  if (!hits.length) return '<p class="small" style="color:var(--muted);margin:.4rem 0 0">No stations with ALERT ids match.</p>';
  return `
    <div class="wb-pick-list">
      ${hits.map(s => `
        <div class="wb-pick-row">
          <span>${esc(s.name)} <span class="small" style="color:var(--muted)">${stationAlertIds(s).join(', ')}</span></span>
          <span>
            <button onclick="wbAddStation('${escAttr(s.id)}','affected')" title="Add as affected">+ aff</button>
            <button onclick="wbAddStation('${escAttr(s.id)}','good')" title="Add as known-good">+ good</button>
          </span>
        </div>`).join('')}
    </div>`;
}

// ── intro (empty state) ──

function wbIntroHtml() {
  return `
    <div class="panel">
      <div class="panel-header"><h2>Interference Workbench</h2></div>
      <p style="max-width:75ch">Select the stations you believe are affected (left) and the
        Workbench assembles the evidence spread across Map, Networks, Bit Flipper, RF Environment
        and RF Changes into one argued case: five competing explanations, scored, with the
        arithmetic open to inspection and the most informative next check named.</p>
      <div class="table-wrap" style="margin-top:.5rem">
        <table>
          <thead><tr><th style="width:16%">Hypothesis</th><th>Signature in the selected stations</th></tr></thead>
          <tbody>
            <tr><td><strong>H1</strong> Repeater common-mode</td><td class="small">Affected stations share a repeater path; unaffected ones mostly don't.</td></tr>
            <tr><td><strong>H2</strong> Geographic / regional</td><td class="small">Affected stations cluster spatially regardless of routing.</td></tr>
            <tr><td><strong>H3</strong> Channel-wide</td><td class="small">Affected stations share an RX frequency across different repeaters.</td></tr>
            <tr><td><strong>H4</strong> Site-local, independent</td><td class="small">No shared path, cluster or channel — staggered onsets, separate local sources.</td></tr>
            <tr><td><strong>H5</strong> Misattribution artefact</td><td class="small">"Affected" stations 1 address bit apart — data bleeding across IDs via bit flips. Checked first, because it invalidates the selection itself.</td></tr>
          </tbody>
        </table>
      </div>
      <div class="button-row" style="justify-content:flex-start;margin-top:.75rem">
        <button class="primary" onclick="wbLoadExample()">Load a worked example</button>
        <button onclick="wbOpenConcept('')">Open the RF concept notes</button>
      </div>
      <p class="small" style="color:var(--muted);margin-top:.6rem">The Workbench never claims a
        cause. It ranks explanations by how well they fit, states its confidence, and tells you
        what would most change the answer.</p>
    </div>`;
}

// ── centre column ──

function wbCentreHtml(an) {
  return `
    ${an.h5.pairs.length ? wbH5BannerHtml(an) : ''}
    ${wbVerdictHtml(an)}
    ${wbRankingHtml(an)}
    ${wbH5PanelHtml(an)}
    ${wbMatrixHtml(an)}
    ${wbMapPanelHtml(an)}
    ${wbTimelineHtml(an)}
    ${wbStripHtml(an)}
    ${wbBlindSpotsHtml()}`;
}

// H5 warning shown before ANY other analysis — a bit-flip pair means the
// selection itself may be wrong, which invalidates everything below it.
function wbH5BannerHtml(an) {
  const p = an.h5.pairs[0];
  return `
    <div class="wb-banner">
      <strong>⚠ Check misattribution first.</strong>
      Addresses ${an.h5.pairs.map(x => `${x.a} / ${x.b} (${x.d} bit${x.d > 1 ? 's' : ''})`).join(', ')}
      are within 2 bit flips of each other. With no
      ${wbT('payload protection', 'The plain ALERT Binary Format has no checksum over address or data — any flipped bit is accepted as truth.', 'no_crc')}
      in ALERT Binary Format, one may be the victim of the other's corrupted packets rather than
      independently affected — which would change this entire selection.
      <button style="margin-left:.5rem" onclick="wbOpenBf(${p.a})">Open ${p.a} in Bit Flipper</button>
    </div>`;
}

function wbVerdictHtml(an) {
  const lead = an.lead;
  const top = an.top;
  const conf = { high: 'High', moderate: 'Moderate', low: 'Low' }[an.confidence];
  let confWhy = `${lead.short} scores ${lead.score.toFixed(2)} against ${an.second.short} at ${an.second.score.toFixed(2)}.`;
  if (lead.key === 'h1' && top && top.specificity < 0.5 && top.coverage >= 0.8) {
    confWhy += ` Specificity is weak because ${esc(top.r.name)} carries most of this sub-network.`;
  }
  const title = lead.key === 'h1' && top
    ? `${lead.label} — ${esc(top.r.name)}` : lead.label;
  return `
    <div class="panel wb-verdict">
      <div class="small" style="color:var(--muted)">Leading hypothesis — most consistent with the evidence, not a proven cause</div>
      <h2 style="margin:.25rem 0">${title}</h2>
      <p style="margin:.3rem 0">${esc(an.stmt[lead.key])}</p>
      ${lead.key === 'h1' && top ? `
        <p class="small" style="margin:.3rem 0">
          ${wbT('Coverage', 'What fraction of the affected stations pass through this repeater — does it explain all of them?', 'coverage_specificity')} ${top.coverage.toFixed(2)}
          · ${wbT('Specificity', 'How well the repeater avoids explaining stations that are fine. Low specificity: it is on almost everyone’s path, so its involvement is less informative.', 'coverage_specificity')} ${top.specificity.toFixed(2)}
          · ${wbT('Explanatory power', 'Harmonic mean (F1) of coverage and specificity — punishes a candidate weak on either.', 'coverage_specificity')} ${top.power.toFixed(2)}</p>` : ''}
      <p style="margin:.35rem 0"><strong>Confidence: ${conf}.</strong> <span class="small">${confWhy}</span></p>
      <p style="margin:.35rem 0"><strong>Most informative next check:</strong> ${esc(an.nextCheck)}</p>
      ${an.notes.length ? `<div class="wb-notes">${an.notes.map(n => `<p class="small">▸ ${esc(n)}</p>`).join('')}</div>` : ''}
    </div>`;
}

function wbRankingHtml(an) {
  const arith = { h1: wbArithH1, h2: wbArithH2, h3: wbArithH3, h4: wbArithH4, h5: wbArithH5 };
  return `
    <div class="panel">
      <div class="panel-header"><h3>Hypothesis ranking</h3>
        <span class="small" style="color:var(--muted)">all five scored — losing hypotheses stay visible</span></div>
      ${an.hyps.map((h, i) => `
        <details class="wb-hyp">
          <summary>
            <span class="wb-hyp-rank">#${i + 1}</span>
            <span class="wb-hyp-name"><strong>${h.short}</strong> ${h.label}</span>
            <span class="wb-hyp-bar"><span style="width:${Math.round(h.score * 100)}%"></span></span>
            <span class="wb-hyp-score">${h.score.toFixed(2)}</span>
          </summary>
          <div class="wb-hyp-body">
            <p class="small" style="margin:.3rem 0">${esc(an.stmt[h.key])}</p>
            ${arith[h.key](an, h)}
          </div>
        </details>`).join('')}
      ${wbWhy(`A dashboard would show you one number; an investigation needs the competition.
        Seeing that H2 scored nearly as high as H1 tells you the case is not settled — and the
        arithmetic under each score shows exactly which stations drive it, so a number you cannot
        interrogate never has to be taken on faith.`)}
    </div>`;
}

function wbWeightRow(h) {
  return h.weight !== 1
    ? `<div class="acma-row"><span>× symptom weight (${esc(WB_SYMPTOMS[state.wb.symptom] || '')})</span><span>${h.weight.toFixed(2)} → ${h.score.toFixed(2)}</span></div>`
    : `<div class="acma-row"><span>symptom weight</span><span>1.00 (none)</span></div>`;
}

function wbArithH1(an, h) {
  if (!an.top) {
    return `<div class="wb-arith small">
      ${an.A_routed.length
        ? `Routed affected stations: ${an.A_routed.length}, but no documented repeater carries any of them.`
        : `Affected stations with routing data: 0 of ${an.A.length}. Pass ranges are recorded for
           ${an.repeaters.length} of ${an.repeaterRoleCount} repeaters — the gap is data, not analysis.`}
      ${wbWeightRow(h)}</div>`;
  }
  const t = an.top;
  const universe = an.explicitGood
    ? `the ${an.U.length} stations you marked known-good`
    : `all ${an.U.length} stations not flagged affected (assumed good)`;
  return `<div class="wb-arith small">
    <div class="acma-row"><span>unaffected universe</span><span>${universe}</span></div>
    <div class="acma-row"><span>coverage = |A ∩ through| / |A routed|</span><span>${t.passA.length} / ${an.A_routed.length} = ${t.coverage.toFixed(2)}</span></div>
    <div class="acma-row"><span>specificity = 1 − |U ∩ through| / |through|</span><span>1 − ${t.passUn}/${t.through} = ${t.specificity.toFixed(2)}</span></div>
    <div class="acma-row"><span>explanatory power = 2cs/(c+s)</span><span>${t.power.toFixed(2)}</span></div>
    ${wbWeightRow(h)}
    ${t.chain.length ? `<div class="acma-row"><span>chain</span><span>in series with ${esc(t.chain.join(', '))}</span></div>` : ''}
    ${an.A_unrouted.length ? `<div class="acma-row"><span>excluded (no routing)</span><span>${an.A_unrouted.map(s => esc(s.name)).join(', ')}</span></div>` : ''}
  </div>`;
}

function wbArithH2(an, h) {
  const H = an.h2;
  if (H.ratio == null || H.nPts < 3) {
    return `<div class="wb-arith small">Needs ≥3 affected stations with coordinates (have ${H.nPts}). ${wbWeightRow(h)}</div>`;
  }
  return `<div class="wb-arith small">
    <div class="acma-row"><span>mean pairwise distance, affected (${H.nPts} stations)</span><span>${H.dAff.toFixed(1)} km</span></div>
    <div class="acma-row"><span>network baseline (${H.sampleN}-station sample)</span><span>${H.dNet.toFixed(1)} km</span></div>
    <div class="acma-row"><span>tightness = clamp((baseline/affected − 1) / 4, 0–1)</span><span>${H.ratio.toFixed(2)}× → ${H.tight.toFixed(2)}</span></div>
    <div class="acma-row"><span>cluster specificity = affected in area / stations in area</span><span>${H.nPts}/${H.inCluster} = ${H.spec.toFixed(2)}</span></div>
    <div class="acma-row"><span>score = 2ts/(t+s) — same F1 grammar as H1</span><span>${H.base.toFixed(2)}</span></div>
    ${wbWeightRow(h)}
    <div class="acma-row"><span>confound</span><span>repeaters serve areas — see discriminating stations</span></div>
  </div>`;
}

function wbArithH3(an, h) {
  const H = an.h3;
  if (!H.rows.length) return `<div class="wb-arith small">No routed affected stations, so no channel statistics. ${wbWeightRow(h)}</div>`;
  return `<div class="wb-arith small">
    ${H.rows.slice(0, 4).map(r => `
      <div class="acma-row"><span>${r.f} MHz — affected ${Math.round(r.share * 100)}% vs base ${Math.round(r.base * 100)}%</span>
        <span>lift ${r.lift == null ? '∞ (capped 3)' : r.lift.toFixed(2) + '×'} → ${r.score.toFixed(2)}</span></div>`).join('')}
    <div class="acma-row"><span>score = clamp((lift − 1)/1.5, 0–0.9) × affected share</span><span>${H.base.toFixed(2)}</span></div>
    ${wbWeightRow(h)}
    <div class="acma-row"><span>why relative to base rate</span><span>68 of 88 documented repeaters share 151.5 MHz — raw sharing always fires</span></div>
  </div>`;
}

function wbArithH4(an, h) {
  return `<div class="wb-arith small">
    <div class="acma-row"><span>residual = 0.7 × (1 − max(H1, H2, H3 base))</span>
      <span>0.7 × (1 − ${Math.max(an.h1.base, an.h2.base, an.h3.base).toFixed(2)}) = ${an.h4.base.toFixed(2)}</span></div>
    ${wbWeightRow(h)}
    <div class="acma-row"><span>capped at 0.7</span><span>a residual can lead, never dominate</span></div>
  </div>`;
}

function wbArithH5(an, h) {
  const H = an.h5;
  return `<div class="wb-arith small">
    <div class="acma-row"><span>selected address pairs at Hamming distance 1 / 2</span><span>${H.d1} / ${H.pairs.length - H.d1}</span></div>
    <div class="acma-row"><span>score</span><span>${H.d1 ? 'distance-1 pair(s): 0.8 + 0.05 each, cap 0.95' : H.pairs.length ? 'distance-2 only: 0.45' : 'none: 0.05 baseline'} = ${H.base.toFixed(2)}</span></div>
    ${wbWeightRow(h)}
  </div>`;
}

// ── evidence panels ──

function wbH5PanelHtml(an) {
  const H = an.h5;
  return `
    <div class="panel">
      <div class="panel-header"><h3>1 · Address bit-flip check (H5)</h3>
        <span class="small" style="${H.pairs.length ? 'color:var(--warn)' : 'color:var(--ok)'}">
          ${H.pairs.length ? `${H.pairs.length} suspect pair${H.pairs.length > 1 ? 's' : ''}` : 'clear'}</span></div>
      <p class="small" style="color:var(--muted);margin:.4rem 0">Runs first because it can invalidate
        the selection: with 13 unprotected address bits, a single flip re-attributes a reading to a
        station whose ID differs by a power of two. Pairwise XOR over the selected addresses,
        flagging ${wbT('Hamming distance', 'How many bits differ between two addresses. Distance 1 = reachable by a single bit error.', 'hamming')} ≤ 2.</p>
      ${H.pairs.length ? `
        <div class="table-wrap">
          <table class="bf-table" style="min-width:560px">
            <thead><tr><th>Address A</th><th>Address B</th><th>Distance</th><th>Differing bit(s)</th><th></th></tr></thead>
            <tbody>${H.pairs.map(p => {
              const nameOf = a => { const rec = an.aff.byStation; for (const { station, addrs } of rec.values()) if (addrs.includes(a)) return station.name; return '—'; };
              return `<tr>
                <td>${p.a} <span class="small" style="color:var(--muted)">${esc(nameOf(p.a))}</span></td>
                <td>${p.b} <span class="small" style="color:var(--muted)">${esc(nameOf(p.b))}</span></td>
                <td>${p.d}</td>
                <td class="small mono">bit ${p.bits.join(', bit ')}</td>
                <td><button onclick="wbOpenBf(${p.a})">Bit Flipper →</button></td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>
        <p class="small" style="color:var(--warn);margin:.4rem 0 0">These stations may not be
          independently affected — compare their data series before treating them as separate evidence.</p>`
      : `<p class="small" style="color:var(--ok);margin:.4rem 0 0">✓ No selected addresses within 2 bit
          flips of each other — the selection looks independently addressed, and the rest of the
          analysis can be read at face value.</p>`}
      ${wbWhy(`An operator seeing bad data at stations 2316 and 2320 may believe both are affected
        when one is the victim of the other's corrupted packets (they differ by a single bit).
        Because this corrupts the input to every other hypothesis, it is checked before anything
        else is presented. The check reuses the Bit Flipper's address index — open any pair there
        for the full variant table and ARRO graph links.`)}
    </div>`;
}

function wbMatrixHtml(an) {
  const cols = an.candidates.slice(0, WB_MATRIX_COLS);
  if (!cols.length) {
    return `
    <div class="panel">
      <div class="panel-header"><h3>2 · Routing / pass-range matrix</h3></div>
      <p class="small" style="color:var(--muted);margin:.4rem 0 0">No documented repeater carries any
        selected station, so there is no matrix to draw. That is a finding: either these stations'
        routing is undocumented (see routing data quality, left) or their paths genuinely don't
        share infrastructure — which points at H2/H4, not H1.</p>
    </div>`;
  }
  const rows = [
    ...an.A.map(s => ({ s, cls: 'wb-row-aff', tag: 'affected' })),
    ...an.G.slice(0, WB_MATRIX_GOOD).map(s => ({ s, cls: 'wb-row-good', tag: 'known-good' })),
  ];
  return `
    <div class="panel">
      <div class="panel-header"><h3>2 · Routing / pass-range matrix</h3>
        <span class="small" style="color:var(--muted)">● = station's ALERT id inside repeater's pass ranges</span></div>
      <div class="table-wrap" style="margin-top:.5rem">
        <table class="wb-matrix">
          <thead><tr>
            <th style="min-width:140px">Station</th>
            ${cols.map(c => `<th class="wb-m-h" title="${esc(c.r.name)} — power ${c.power.toFixed(2)}"><span>${esc(c.r.name)}</span></th>`).join('')}
          </tr></thead>
          <tbody>
            ${rows.map(row => `
              <tr class="${row.cls}">
                <td title="${row.tag}">${esc(row.s.name)}
                  <span class="small" style="color:var(--muted)">${(stationAlertIds(row.s) || []).join(', ')}</span></td>
                ${cols.map(c => {
                  const hit = an.passes(row.s, c.r);
                  return `<td class="wb-m${hit ? ' hit' : ''}">${hit ? '●' : ''}</td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr><td class="small">coverage</td>${cols.map(c => `<td class="small">${c.coverage.toFixed(2)}</td>`).join('')}</tr>
            <tr><td class="small">specificity</td>${cols.map(c => `<td class="small">${c.specificity.toFixed(2)}</td>`).join('')}</tr>
            <tr><td class="small"><strong>power</strong></td>${cols.map(c => `<td class="small"><strong>${c.power.toFixed(2)}</strong></td>`).join('')}</tr>
          </tfoot>
        </table>
      </div>
      ${an.candidates.length > cols.length ? `<p class="small" style="color:var(--muted);margin:.4rem 0 0">Top ${cols.length} of ${an.candidates.length} candidate repeaters shown, ranked by explanatory power.</p>` : ''}
      ${wbWhy(`The visual pattern usually makes the answer obvious before any score is read: a solid
        column of dots on the affected (red) rows that is sparse on the known-good (green) rows IS
        the repeater hypothesis. A column solid on both is a repeater that carries everything —
        high coverage, low specificity, uninformative. Red rows with no dots at all are the
        stations the leading repeater cannot explain.`)}
    </div>`;
}

function wbMapPanelHtml(an) {
  return `
    <div class="panel">
      <div class="panel-header"><h3>3 · Map</h3></div>
      <div class="map-legend" style="margin:.4rem 0">
        <span class="legend-item"><span class="legend-dot" style="background:${WB_AFFECTED_COLOR}"></span><span class="small">Affected</span></span>
        <span class="legend-item"><span class="legend-dot" style="background:${WB_GOOD_COLOR}"></span><span class="small">Known-good</span></span>
        <span class="legend-item"><span class="legend-dot" style="background:#0b5cab"></span><span class="small">Candidate repeater (sized by power)</span></span>
        <span class="legend-item"><span class="legend-dot" style="background:${WB_DISC_COLOR}"></span><span class="small">Discriminating station</span></span>
        ${state.acma.loaded && an.top ? `<span class="legend-item"><span class="legend-sq" style="background:#7b1fa2"></span><span class="small">ACMA threat (top candidate)</span></span>` : ''}
      </div>
      <div id="wb-map" style="height:430px;border-radius:6px"></div>
      ${an.disc.length ? `
        <div style="margin-top:.6rem">
          <div class="small"><strong>Discriminating stations</strong> — inside the affected area, routed differently; the highest-value observation available:</div>
          <div class="table-wrap" style="margin-top:.35rem">
            <table style="table-layout:auto"><thead><tr><th>Station</th><th>Routes via</th><th>km from cluster centre</th><th>Status</th></tr></thead>
            <tbody>${an.disc.map(d => `
              <tr><td>${esc(d.s.name)}</td><td class="small">${esc(d.via.join(', '))}</td>
                <td class="small">${d.km.toFixed(0)}</td>
                <td class="small">${d.status === 'known-good'
                  ? '<span style="color:var(--ok)">known-good — already supports H1</span>'
                  : '<span style="color:var(--warn)">unchecked — go look at its data</span>'}</td></tr>`).join('')}
            </tbody></table>
          </div>
        </div>`
      : an.top ? `<p class="small" style="color:var(--muted);margin:.5rem 0 0">No discriminating
          stations found: every routed station inside the affected area passes through
          ${esc(an.top.r.name)} too, so geography and routing cannot be separated from this
          selection alone. Widening the known-good set is the way forward.</p>` : ''}
      ${wbWhy(`H1 and H2 are confounded — repeaters serve geographic areas, so stations sharing a
        repeater are usually also near each other. The discriminator is a station inside the
        affected cluster on a different repeater: if it is clean, the repeater explanation gains;
        if it is affected, the geographic one does. Checking one named station is worth more than
        any amount of re-scoring.`)}
    </div>`;
}

function wbTimelineHtml(an) {
  const R = state.rfc;
  const wbs = state.wb;
  const topIds = new Set(an.candidates.slice(0, 3).map(c => c.r.id));
  let body;
  if (!topIds.size) {
    body = `<p class="small" style="color:var(--muted)">No candidate repeaters — register activity
      cannot be anchored to a suspect. If routing data is the blocker, that comes first.</p>`;
  } else if (R.error) {
    body = `<p class="small" style="color:var(--muted)">${esc(R.error)}</p>`;
  } else if (!R.loaded) {
    body = `<p class="small" style="color:var(--muted)">Loading register timeline…</p>`;
  } else {
    const onsetMid = wbs.onset
      ? (Date.parse(wbs.onset) + (wbs.onsetEnd ? Date.parse(wbs.onsetEnd) : Date.parse(wbs.onset))) / 2
      : null;
    const rows = [];
    for (const e of R.timeline.events) {
      let best = null;
      for (const a of e.anchors || []) {
        if (!topIds.has(a.id)) continue;
        if (!best || a.score > best.score) best = a;
      }
      if (!best || !e.date) continue;
      const days = onsetMid != null ? Math.round((Date.parse(e.date) - onsetMid) / 86400000) : null;
      if (onsetMid != null && Math.abs(days) > 120) continue;
      rows.push({ e, a: best, days });
    }
    rows.sort((x, y) => onsetMid != null
      ? Math.abs(x.days) - Math.abs(y.days)
      : (y.e.date || '').localeCompare(x.e.date || ''));
    const shown = rows.slice(0, 8);
    body = shown.length ? `
      <div class="table-wrap">
        <table style="table-layout:auto"><thead><tr>
          <th>Date</th>${onsetMid != null ? '<th>Δ onset</th>' : ''}<th>Licensee</th><th>Mechanism</th><th>Score</th><th>km</th><th>Near</th></tr></thead>
        <tbody>${shown.map(r => `
          <tr>
            <td class="small">${esc(r.e.date)}</td>
            ${onsetMid != null ? `<td class="small">${r.days > 0 ? '+' : ''}${r.days} d</td>` : ''}
            <td class="small">${esc(r.e.client || '?')}</td>
            <td class="small"><span class="legend-sq" style="background:${(ACMA_MECH[r.a.mech] || {}).color || '#666'}"></span> ${(ACMA_MECH[r.a.mech] || {}).label || esc(r.a.mech)}</td>
            <td class="small">${r.a.score}</td>
            <td class="small">${r.a.km}</td>
            <td class="small">${esc(rfcAnchorName(r.a.id))}</td>
          </tr>`).join('')}</tbody></table>
      </div>
      <p class="small" style="color:var(--muted);margin:.4rem 0 0">${onsetMid != null
        ? `Register events within ±120 days of onset, nearest first. An authorisation date is when paperwork was approved — an upper bound on when interference could have begun, never proof that it did.`
        : 'No onset date set — showing the most recent register events near the top candidates. Set an onset date (left) to rank by temporal proximity.'}</p>`
    : `<p class="small" style="color:var(--muted)"><strong>No register events near the leading
        candidates${onsetMid != null ? ' within ±120 days of onset' : ''}.</strong> That is a
        finding, not a failure: it points away from newly licensed transmitters and toward
        register-invisible sources — your own infrastructure (corrosion, equipment fault) or
        unlicensed emitters. The site-visit checklist covers those.</p>`;
    body += `<div class="button-row" style="justify-content:flex-start;margin-top:.5rem">
      <button onclick="wbOpenRfc()">Open in RF Changes →</button></div>`;
  }
  return `
    <div class="panel">
      <div class="panel-header"><h3>4 · Register activity vs onset</h3></div>
      <p class="small" style="color:var(--muted);margin:.4rem 0">Simultaneous onset across stations
        argues an external event; staggered onsets argue progressive degradation such as corrosion.
        ${wbT('ACMA register', 'The Register of Radiocommunications Licences records authorisations, not what is actually radiating.', 'acma_register')}
        events near the candidates are leads to correlate, not conclusions.</p>
      ${body}
    </div>`;
}

function wbOpenRfc() {
  const an = state.wb.lastAnalysis;
  if (an) state.rfc.anchorSel = new Set(an.candidates.slice(0, 3).map(c => c.r.id));
  if (state.wb.onset) state.rfc.onset = state.wb.onset;
  switchTab('rfchanges');
}

function wbStripHtml(an) {
  if (!an.top) return '';
  const A = state.acma;
  let body;
  if (A.error)        body = `<p class="small" style="color:var(--muted)">${esc(A.error)}</p>`;
  else if (!A.loaded) body = `<p class="small" style="color:var(--muted)">Loading ACMA carrier data…</p>`;
  else if (!A.anchorById[an.top.r.id]) {
    body = `<p class="small" style="color:var(--muted)">${esc(an.top.r.name)} is not an anchor in the
      ACMA extract${an.top.r.repeater.rx_mhz == null ? ' — it has no recorded RX frequency, which is the same backfill gap flagged under routing data quality' : ''}.
      Re-run tools/acma_fetch.py after fixing stations.json to include it.</p>`;
  } else {
    body = rfStripPlotHtml(an.top.r.id);
  }
  return `
    <div class="panel">
      <div class="panel-header"><h3>5 · Frequency neighbourhood — ${esc(an.top.r.name)}</h3></div>
      ${body}
      ${wbWhy(`The strip plot shows every licensed carrier around the leading candidate's RX
        channel. A tall coloured tick on or beside the red RX line is a classified threat; a wall
        of grey ticks nearby means a crowded segment where
        <em>adjacent-channel splatter</em> erodes margin without ever being "on" your frequency.
        An empty neighbourhood shifts suspicion to unlicensed sources and your own hardware.`)}
    </div>`;
}

function wbBlindSpotsHtml() {
  return `
    <div class="panel">
      ${rfcHelpHtml()}
    </div>`;
}

// ── right rail: suspects & actions ──

function wbRightHtml(an) {
  if (!an) {
    return `
      <div class="panel">
        <div class="panel-header"><h3>Suspects</h3></div>
        <p class="small" style="color:var(--muted);margin:.4rem 0 0">Ranked repeaters and licensed
          interference candidates appear here once affected stations are selected.</p>
      </div>`;
  }
  return `
    ${wbRepListHtml(an)}
    ${wbAcmaSuspectsHtml(an)}
    ${wbActionsHtml(an)}`;
}

function wbRepListHtml(an) {
  const cands = an.candidates.slice(0, 8);
  return `
    <div class="panel">
      <div class="panel-header"><h3>Ranked repeaters</h3></div>
      ${cands.length ? cands.map((c, i) => `
        <details class="wb-sus">
          <summary>
            <span class="wb-hyp-rank">#${i + 1}</span>
            <span class="wb-sus-name">${esc(c.r.name)}${c.chain.length ? ' <span class="badge">chain</span>' : ''}</span>
            <span class="wb-hyp-bar"><span style="width:${Math.round(c.power * 100)}%"></span></span>
            <span class="wb-hyp-score">${c.power.toFixed(2)}</span>
          </summary>
          <div class="small" style="padding:.35rem 0 .2rem">
            coverage ${c.coverage.toFixed(2)} · specificity ${c.specificity.toFixed(2)}
            ${c.chain.length ? `<br>In series with ${esc(c.chain.join(', '))} — inspect the chain as one path.` : ''}
            <br>Carries affected: ${c.passA.map(s => esc(s.name)).join(', ')}
            <br>Also carries ${c.passUn} unaffected station${c.passUn === 1 ? '' : 's'}.
          </div>
        </details>`).join('')
      : `<p class="small" style="color:var(--muted);margin:.4rem 0 0">No repeater carries any selected
          station — see the routing data quality note.</p>`}
    </div>`;
}

function wbAcmaSuspectsHtml(an) {
  const A = state.acma;
  let body;
  if (!an.top) {
    body = `<p class="small" style="color:var(--muted)">Needs a leading repeater candidate.</p>`;
  } else if (A.error) {
    body = `<p class="small" style="color:var(--muted)">${esc(A.error)}</p>`;
  } else if (!A.loaded) {
    body = `<p class="small" style="color:var(--muted)">Loading ACMA threat data…</p>`;
  } else {
    const anchor = A.anchorById[an.top.r.id];
    const threats = anchor ? anchor.threats.slice().sort((a, b) => b.score - a.score).slice(0, 8) : [];
    body = threats.length ? `
      ${threats.map(t => {
        const m = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
        return `<a href="#" class="wb-threat" onclick="showAcmaCard('${escAttr(t.device_id)}','${escAttr(anchor.station_id)}');return false">
          <span class="legend-sq" style="background:${m.color}"></span>
          <span class="wb-threat-name">${esc(t.client || 'Unknown licensee')}
            <span class="small" style="color:var(--muted)">${m.label} · ${t.f_mhz != null ? t.f_mhz.toFixed(4) + ' MHz · ' : ''}${t.distance_km} km${t.inactive ? ' · not current' : ''}</span></span>
          <span class="wb-hyp-score">${t.score}</span>
        </a>`;
      }).join('')}
      <p class="small" style="color:var(--muted);margin:.4rem 0 0">Licensed candidates near
        ${esc(an.top.r.name)}, using the existing ACMA scoring — click for the full transmitter card.</p>`
    : `<p class="small" style="color:var(--muted)">No licensed interference candidates recorded near
        ${esc(an.top.r.name)}. A finding in itself: it shifts weight toward unlicensed emitters and
        the repeater's own hardware — both invisible to the register.</p>`;
  }
  return `
    <div class="panel">
      <div class="panel-header"><h3>Interference sources</h3></div>
      <div style="margin-top:.4rem">${body}</div>
    </div>`;
}

function wbActionsHtml(an) {
  return `
    <div class="panel">
      <div class="panel-header"><h3>Actions</h3></div>
      <div class="button-column">
        <button onclick="wbExportCsv()">Export case (CSV)</button>
        <button onclick="wbExportChecklist()">Site-visit checklist</button>
        <button onclick="wbExportComplaint()">Draft ACMA complaint</button>
      </div>
      <p class="small" style="color:var(--muted);margin:.5rem 0 0">The checklist is tailored to the
        leading mechanism; the complaint draft pre-fills the evidence and marks every inference as
        an inference.</p>
    </div>`;
}

// ── map ──

function initWbMap() {
  // remove() can be mid-animation when a lazy data load re-renders the tab and
  // detaches the old container — Leaflet throws harmlessly there; swallow it.
  if (state.wb.map) { try { state.wb.map.remove(); } catch (_) {} state.wb.map = null; }
  const el = document.getElementById('wb-map');
  const an = state.wb.lastAnalysis;
  if (!el || !an || !state.data || typeof L === 'undefined') return;

  const map = state.wb.map = L.map('wb-map').setView([-23, 146], 5);
  addBaseLayers(map);
  const layer = L.layerGroup().addTo(map);
  const bounds = [];

  if (an.cluster) {
    L.circle([an.cluster.lat, an.cluster.lon], {
      radius: an.cluster.radiusKm * 1000, color: '#888',
      weight: 1, dashArray: '6 6', fill: false, opacity: 0.6,
    }).addTo(layer);
  }

  const dot = (s, color, opts, popup) => {
    if (s.lat == null || s.lon == null) return;
    const m = L.circleMarker([s.lat, s.lon], {
      radius: 6, color, fillColor: color, fillOpacity: 0.85, weight: 1.5, ...opts,
    }).addTo(layer);
    m.bindPopup(popup);
    bounds.push([s.lat, s.lon]);
  };

  const topR = an.top ? an.top.r : null;
  for (const s of an.A) {
    dot(s, WB_AFFECTED_COLOR, {}, `<strong>${esc(s.name)}</strong><br>
      <span style="font-size:.83rem">Affected · AlertID ${stationAlertIds(s).join(', ')}</span>`);
    if (topR && topR.lat != null && s.lat != null && an.passes(s, topR)) {
      L.polyline([[s.lat, s.lon], [topR.lat, topR.lon]],
        { color: '#0b5cab', weight: 1.2, opacity: 0.45, dashArray: '5 6' }).addTo(layer);
    }
  }
  for (const s of an.G) {
    dot(s, WB_GOOD_COLOR, {}, `<strong>${esc(s.name)}</strong><br>
      <span style="font-size:.83rem">Known-good · AlertID ${stationAlertIds(s).join(', ')}</span>`);
  }
  for (const c of an.candidates.slice(0, 8)) {
    dot(c.r, '#0b5cab', { radius: 6 + Math.round(8 * c.power), weight: c === an.top ? 3 : 1.5 },
      `<strong>${esc(c.r.name)}</strong><br>
       <span style="font-size:.83rem">Candidate repeater · coverage ${c.coverage.toFixed(2)}
       · specificity ${c.specificity.toFixed(2)} · power ${c.power.toFixed(2)}</span>`);
  }
  for (const d of an.disc) {
    dot(d.s, WB_DISC_COLOR, { fillOpacity: 0.25, weight: 3 },
      `<strong>${esc(d.s.name)}</strong><br>
       <span style="font-size:.83rem">Discriminating station (${d.status}) — routes via
       ${esc(d.via.join(', '))}. Clean strengthens H1; affected strengthens H2.</span>`);
  }

  // ACMA threat squares around the leading candidate — same visual language as
  // the main map's RF layer (squares, mechanism colours).
  const A = state.acma;
  if (A.loaded && topR && A.anchorById[topR.id]) {
    const anchor = A.anchorById[topR.id];
    for (const t of anchor.threats.slice().sort((a, b) => b.score - a.score).slice(0, 10)) {
      const site = A.siteById[t.site_id];
      if (!site) continue;
      const mech = ACMA_MECH[t.mechanism] || { label: t.mechanism, color: '#666' };
      const size = Math.round(9 + t.score / 8);
      const icon = L.divIcon({
        className: 'acma-div',
        html: `<div class="acma-sq" style="width:${size}px;height:${size}px;background:${mech.color}"></div>`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      });
      const m = L.marker([site.lat, site.lon], { icon }).addTo(layer);
      m.bindPopup(`<strong>${esc(t.client || 'Unknown licensee')}</strong> · score ${t.score}<br>
        <span style="font-size:.83rem">${mech.label} · ${esc(t.detail)}</span><br>
        <a href="#" onclick="showAcmaCard('${escAttr(t.device_id)}','${escAttr(anchor.station_id)}');return false">Full details →</a>`);
    }
  }

  // animate:false — an in-flight animation throws if a re-render (lazy ACMA/RFC
  // data arriving) replaces the container before it settles
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 11, animate: false });
}

// ── exports ──

function wbCaseStamp() {
  return (state.wb.caseName ? slug(state.wb.caseName) + '-' : 'workbench-case-') +
         new Date().toISOString().slice(0, 10);
}

function wbExportCsv() {
  const an = state.wb.lastAnalysis;
  if (!an) return;
  const wbs = state.wb;
  const L1 = [];
  L1.push('MegaNet Interference Workbench — case export');
  L1.push(`generated,${new Date().toISOString()}`);
  L1.push(`case,${csvEscape(wbs.caseName || '(unnamed)')}`);
  L1.push(`affected_ids,${csvEscape(wbs.affected.join(' '))}`);
  L1.push(`known_good_ids,${csvEscape(wbs.good.join(' '))}`);
  L1.push(`onset,${wbs.onset || 'unknown'}${wbs.onsetEnd ? ' to ' + wbs.onsetEnd : ''}`);
  L1.push(`symptom,${WB_SYMPTOMS[wbs.symptom] || 'unknown'}`);
  L1.push(`confidence,${an.confidence}`);
  L1.push('');
  L1.push('section,hypothesis_ranking');
  L1.push('rank,hypothesis,label,score,base_score,symptom_weight,statement');
  an.hyps.forEach((h, i) => L1.push([i + 1, h.short, csvEscape(h.label), h.score.toFixed(2),
    h.base.toFixed(2), h.weight.toFixed(2), csvEscape(an.stmt[h.key])].join(',')));
  L1.push('');
  L1.push('section,repeater_candidates');
  L1.push('repeater,coverage,specificity,explanatory_power,affected_through,unaffected_through,chain_with');
  an.candidates.forEach(c => L1.push([csvEscape(c.r.name), c.coverage.toFixed(2),
    c.specificity.toFixed(2), c.power.toFixed(2), c.passA.length, c.passUn,
    csvEscape(c.chain.join('; '))].join(',')));
  if (an.h5.pairs.length) {
    L1.push('');
    L1.push('section,h5_address_pairs');
    L1.push('addr_a,addr_b,hamming_distance,differing_bits');
    an.h5.pairs.forEach(p => L1.push([p.a, p.b, p.d, csvEscape(p.bits.join(' '))].join(',')));
  }
  if (an.disc.length) {
    L1.push('');
    L1.push('section,discriminating_stations');
    L1.push('station,routes_via,km_from_cluster_centre,status');
    an.disc.forEach(d => L1.push([csvEscape(d.s.name), csvEscape(d.via.join('; ')),
      d.km.toFixed(1), d.status].join(',')));
  }
  L1.push('');
  L1.push('note,"Scores rank explanations by fit; none is a proven cause. See the Workbench for the arithmetic behind every number."');
  dlText(`${wbCaseStamp()}.csv`, L1.join('\n'));
}

// Mechanism-tailored fieldwork list — converts the analysis into a site visit.
function wbExportChecklist() {
  const an = state.wb.lastAnalysis;
  if (!an) return;
  const lead = an.lead;
  const topMech = (() => {
    const A = state.acma;
    if (!A.loaded || !an.top) return null;
    const anchor = A.anchorById[an.top.r.id];
    if (!anchor || !anchor.threats.length) return null;
    return anchor.threats.slice().sort((a, b) => b.score - a.score)[0].mechanism;
  })();
  const out = [];
  out.push(`# Site-visit checklist — ${state.wb.caseName || 'unnamed investigation'}`);
  out.push(`Generated ${new Date().toISOString().slice(0, 10)} · leading hypothesis: ${lead.short} ${lead.label} (score ${lead.score.toFixed(2)}, confidence ${an.confidence})`);
  out.push('');
  out.push('## Before leaving');
  out.push('- [ ] Export this case (CSV) and the RF Environment threat CSV for the target repeater');
  out.push('- [ ] Pull the last 30 days of data for every affected station and the discriminating stations named in the case');
  if (an.nextCheck) out.push(`- [ ] Most informative check first: ${an.nextCheck}`);
  out.push('');
  if (lead.key === 'h1' || lead.key === 'h3') {
    out.push(`## At the repeater (${an.top ? an.top.r.name : 'leading candidate'})`);
    if (topMech === 'imd3' || topMech === 'imd5' || topMech === 'imd3_triple' || !topMech) {
      out.push('- [ ] Inspect and torque mast joints, guy attachments and antenna mounts (rusty-bolt IMD)');
      out.push('- [ ] Check every RF connector for corrosion / water ingress; reseat and re-weatherproof');
      out.push('- [ ] Log co-tenant transmitter TX times against your corruption timestamps');
    }
    if (topMech === 'cosite_desense' || !topMech) {
      out.push('- [ ] Get the co-sited transmitter TX log from the site operator if they will share it');
      out.push('- [ ] Consider a band-pass cavity filter on the repeater RX');
    }
    if (topMech === 'co_channel' || topMech === 'adjacent' || lead.key === 'h3') {
      out.push('- [ ] Monitor the RX channel with a handheld/SDR for the co-channel carrier; note times and signal strength');
    }
    out.push('- [ ] Measure repeater RX noise floor (record dBm and time); compare against any previous reading');
    out.push('- [ ] Check squelch setting and RX sensitivity against commissioning values');
    out.push('- [ ] Photograph antenna, feedline and connector condition for the record');
  }
  if (lead.key === 'h2') {
    out.push('## In the affected area');
    out.push('- [ ] Drive-test the area with a handheld/SDR on the RX channel; log where the interferer is audible');
    out.push('- [ ] Note any new infrastructure since onset (towers, solar farms, VMS signs, industrial sites)');
    out.push('- [ ] Check the ACMA suspects list against what is physically present');
  }
  if (lead.key === 'h4' || lead.key === 'h2') {
    out.push('## At each affected site');
    out.push('- [ ] Battery-only power-down test: kill mains/solar, watch whether the noise floor drops (self-interference)');
    out.push('- [ ] Check solar regulator make/model — switch-mode controllers are notorious VHF noise sources');
    out.push('- [ ] Inspect nearby electric fences, powerlines (arcing insulators), pumps and VSDs');
    out.push('- [ ] Verify antenna connections, feedline condition and earth bonding');
  }
  if (lead.key === 'h5') {
    out.push('## Desk work first — no site visit indicated yet');
    out.push('- [ ] Compare the flagged address pairs\' data series; identify victim vs ghost');
    out.push('- [ ] Correct the affected list and re-run the Workbench before committing to fieldwork');
  }
  out.push('');
  out.push('## Log while on site');
  out.push('- [ ] Times of any observed interference (with your corruption timestamps to hand)');
  out.push('- [ ] Weather at time of visit (IMD and corrosion effects are weather-sensitive)');
  out.push('- [ ] Anything keying nearby: voice traffic, pagers, telemetry bursts');
  dlText(`${wbCaseStamp()}-site-visit.md`, out.join('\n'));
}

// Draft interference complaint with the evidence pre-filled. Every inference is
// marked as an inference — the draft argues "worth investigating", not "guilty".
function wbExportComplaint() {
  const an = state.wb.lastAnalysis;
  if (!an) return;
  const wbs = state.wb;
  const A = state.acma;
  const top = an.top;
  const lic = top && top.r.repeater.acma_licence ? top.r.repeater.acma_licence : '(licence number)';
  const rx = top && top.r.repeater.rx_mhz != null ? top.r.repeater.rx_mhz + ' MHz' : '(RX frequency)';
  const suspects = (A.loaded && top && A.anchorById[top.r.id])
    ? A.anchorById[top.r.id].threats.slice().sort((a, b) => b.score - a.score).slice(0, 5) : [];
  const out = [];
  out.push('# Draft — interference report to ACMA');
  out.push('(Review every field before sending. This draft was assembled by the MegaNet');
  out.push('Interference Workbench; all conclusions are stated as leads, not findings.)');
  out.push('');
  out.push('## Reporting party');
  out.push('Name / organisation: (fill in)');
  out.push('Contact: (fill in)');
  out.push('');
  out.push('## Service experiencing interference');
  out.push(`Service: ALERT flood-warning telemetry network (VHF, ${rx})`);
  out.push(`Licence: ${lic}`);
  if (top) out.push(`Receiver site: ${top.r.name}${top.r.lat != null ? ` (${top.r.lat.toFixed(4)}, ${top.r.lon.toFixed(4)})` : ''}`);
  out.push('');
  out.push('## Nature and extent of the interference');
  out.push(`Symptom: ${WB_SYMPTOMS[wbs.symptom] || 'data corruption (mixed symptoms)'} on the ALERT telemetry channel.`);
  out.push(`First observed: ${wbs.onset || '(date unknown)'}${wbs.onsetEnd ? ' – ' + wbs.onsetEnd : ''}.`);
  out.push(`Affected field stations: ${an.A.length} (${an.A.slice(0, 10).map(s => s.name).join('; ')}${an.A.length > 10 ? '; …' : ''}).`);
  if (top) {
    out.push(`Pattern: ${top.passA.length} of ${an.A_routed.length} routed affected stations share the ` +
      `${top.r.name} repeater path (coverage ${top.coverage.toFixed(2)}, specificity ${top.specificity.toFixed(2)}), ` +
      'which is most consistent with interference at or near that receiver. This is an inference from ' +
      'routing analysis, not a direct observation of an emitter.');
  }
  out.push('');
  out.push('## Impact');
  out.push('The affected service provides real-time flood warning data (rainfall and river level)');
  out.push('used for public-safety decisions. Corrupted or lost readings during a flood event delay');
  out.push('warnings. (Adjust to your circumstances.)');
  out.push('');
  if (suspects.length) {
    out.push('## Licensed services identified as worth investigating (from the ACMA RRL)');
    suspects.forEach(t => {
      const m = (ACMA_MECH[t.mechanism] || { label: t.mechanism }).label;
      out.push(`- ${t.client || 'Unknown licensee'} — licence ${t.lic || '?'}, ` +
        `${t.f_mhz != null ? t.f_mhz.toFixed(4) + ' MHz, ' : ''}${t.distance_km} km from the receiver. ` +
        `Candidate mechanism: ${m}${t.inactive ? ' (licence not current)' : ''}.`);
    });
    out.push('');
    out.push('These are candidates identified by automated screening of the public register; no');
    out.push('transmission by any of them has been directly observed causing the interference.');
    out.push('');
  }
  out.push('## Evidence available on request');
  out.push('- Corruption timestamps per affected station');
  out.push('- Routing analysis (which repeater paths the affected stations share) with arithmetic');
  out.push('- Register-change timeline near the receiver around the onset date');
  out.push('- Site-visit observations (once completed)');
  dlText(`${wbCaseStamp()}-acma-draft.md`, out.join('\n'));
}

// Restore a shared investigation from the URL hash. Runs at script load (after
// init's first render); station data arrives later via autoLoad → loadJson,
// which re-renders the restored tab.
if (typeof window !== 'undefined') wbRestoreFromUrl();

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
    <div class="pkt" style="max-width:1280px;margin:auto;padding:1rem;display:grid;gap:1rem">

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
            <textarea id="br-desc" placeholder="e.g. Clicking a repeater on the Stations tab does nothing…"></textarea>
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
