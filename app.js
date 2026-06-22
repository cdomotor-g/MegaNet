const state = {
  selectedNetworks: new Set(),
  repeaterFilter: '',
  unitFilter: '',
  networkFilter: '',
  dataLoaded: false,
  crudEntity: 'units',
  crudSearch: '',
  crudSelectedIndex: null,
  crudDraft: null,
  DATA: { units: [], repeaters: [], systems: [], radioMobileNetworks: [], meta: {} }
};

const els = {
  networkList: document.getElementById('networkList'),
  networkFilter: document.getElementById('networkFilter'),
  repeaterFilter: document.getElementById('repeaterFilter'),
  unitFilter: document.getElementById('unitFilter'),
  repeaterTable: document.getElementById('repeaterTable'),
  unitsTable: document.getElementById('unitsTable'),
  stats: document.getElementById('stats'),
  exportSummary: document.getElementById('exportSummary'),
  loadStatus: document.getElementById('loadStatus'),
  btnTheme: document.getElementById('btnTheme'),
  btnAutoload: document.getElementById('btnAutoload'),
  btnLoadFiles: document.getElementById('btnLoadFiles'),
  btnSelectAllNetworks: document.getElementById('btnSelectAllNetworks'),
  btnClearNetworks: document.getElementById('btnClearNetworks'),
  btnExportRMSet: document.getElementById('btnExportRMSet'),
  fileUnits: document.getElementById('fileUnits'),
  fileRepeaters: document.getElementById('fileRepeaters'),
  fileNetworks: document.getElementById('fileNetworks'),
  fileSystems: document.getElementById('fileSystems'),
  exportButtons: [...document.querySelectorAll('[data-export]')],
  crudTable: document.getElementById('crudTable'),
  crudForm: document.getElementById('crudForm'),
  crudStatus: document.getElementById('crudStatus'),
  crudTitle: document.getElementById('crudTitle'),
  crudSearch: document.getElementById('crudSearch'),
  btnCrudNew: document.getElementById('btnCrudNew'),
  btnCrudDelete: document.getElementById('btnCrudDelete'),
  btnCrudSave: document.getElementById('btnCrudSave'),
  btnCrudReset: document.getElementById('btnCrudReset'),
  crudTabs: [...document.querySelectorAll('.tab-btn')],
  mapSummary: document.getElementById('mapSummary')
};

const RM_CONFIG = {
  version: '4000',
  separator: ',',
  map: 'c:\\program files (x86)\\radio mobile 11.6.6\\networks\\meganet\\net1.map',
  picture1: 'c:\\program files (x86)\\radio mobile 11.6.6\\networks\\meganet\\net1.jpg',
  picture2: 'c:\\program files (x86)\\radio mobile 11.6.6\\networks\\meganet\\picture1.jpg',
  land: 'C:\\Program Files (x86)\\Radio Mobile 11.6.6\\landheight.dat'
};

const NETWORK_DEFAULTS = {
  Visible: 1,
  'Minimum fx': 151,
  'Max Fx': 152,
  Refractivity: 301,
  Conductivity: 0.005,
  Permittivity: 15,
  Polarization: 1,
  Climate: 2,
  'Stat. mode': 0,
  '%Time': 50,
  '%Location': 50,
  '%Situation': 70,
  Topology: 1,
  'Max Rebro': 0,
  '%Urban or Tree': 0
};

const CRUD_CONFIG = {
  units: {
    title: 'Units editor',
    key: 'unit_id',
    listCols: ['unit_id', 'name', 'alert_id', 'lat', 'lon'],
    fields: [
      ['unit_id', 'number'], ['name', 'text'], ['enabled', 'number'], ['lat', 'number'], ['lon', 'number'], ['elevation', 'number'],
      ['icon', 'number'], ['forecolor', 'text'], ['style', 'number'], ['backcolor', 'text'], ['alert_id', 'number'], ['locked', 'number']
    ],
    blank: () => ({ unit_id: nextId(state.DATA.units, 'unit_id'), name: '', enabled: 1, lat: '', lon: '', elevation: '', icon: 243, forecolor: 'FFFFFF', style: 1, backcolor: 'FFFFFF', alert_id: '', locked: 0 })
  },
  repeaters: {
    title: 'Repeaters editor',
    key: 'repeater_id',
    listCols: ['repeater_id', 'name', 'bom_network', 'rx', 'tx'],
    fields: [
      ['repeater_id', 'number'], ['name', 'text'], ['bom_network', 'text'], ['acma_licence', 'text'], ['rx', 'text'], ['tx', 'text'],
      ['pass_low_1', 'number'], ['pass_high_1', 'number'], ['pass_low_2', 'number'], ['pass_high_2', 'number'], ['pass_low_3', 'number'], ['pass_high_3', 'number'],
      ['pass_low_4', 'number'], ['pass_high_4', 'number'], ['pass_low_5', 'number'], ['pass_high_5', 'number'], ['pass_low_6', 'number'], ['pass_high_6', 'number'],
      ['pass_low_7', 'number'], ['pass_high_7', 'number'], ['pass_low_8', 'number'], ['pass_high_8', 'number']
    ],
    blank: () => ({ repeater_id: nextId(state.DATA.repeaters, 'repeater_id'), name: '', bom_network: '', acma_licence: '', rx: '', tx: '', pass_low_1:'', pass_high_1:'', pass_low_2:'', pass_high_2:'', pass_low_3:'', pass_high_3:'', pass_low_4:'', pass_high_4:'', pass_low_5:'', pass_high_5:'', pass_low_6:'', pass_high_6:'', pass_low_7:'', pass_high_7:'', pass_low_8:'', pass_high_8:'' })
  },
  systems: {
    title: 'Systems editor',
    key: 'System ID',
    listCols: ['System ID', 'System name', 'Tx power(W)', 'Antenna height(m)'],
    fields: [
      ['System ID', 'number'], ['System name', 'text'], ['Tx power(W)', 'number'], ['Line loss(dB)', 'number'], ['Supplemental Line loss(dB/m)', 'number'],
      ['Antenna type', 'text'], ['Antenna gain(dBi)', 'number'], ['Antenna height(m)', 'number'], ['Rx threshold(dBm)', 'number']
    ],
    blank: () => ({ 'System ID': nextId(state.DATA.systems, 'System ID'), 'System name': '', 'Tx power(W)': 1, 'Line loss(dB)': 1, 'Supplemental Line loss(dB/m)': 0, 'Antenna type': 'omni.ant', 'Antenna gain(dBi)': 5.15, 'Antenna height(m)': 4, 'Rx threshold(dBm)': -117.001 })
  }
};

let map = null;
let mapLayers = null;

function setTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  try { localStorage.setItem('theme', mode); } catch {}
  els.btnTheme.textContent = mode === 'dark' ? 'Light mode' : 'Dark mode';
}

function initTheme() {
  let saved = 'light';
  try { saved = localStorage.getItem('theme') || 'light'; } catch {}
  setTheme(saved);
  els.btnTheme.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    setTheme(current === 'dark' ? 'light' : 'dark');
    if (state.dataLoaded) render();
  });
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, s => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[s]));
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/^\uFEFF/, '').trim());
  return Number.isFinite(n) ? n : null;
}

function numberOrBlank(v) {
  const n = toNumber(v);
  return n === null ? '' : n;
}

function nextId(rows, key) {
  return (rows.reduce((m, r) => Math.max(m, Number(r[key] || 0)), 0) || 0) + 1;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const lines = [cols.join(',')];
  for (const row of rows) lines.push(cols.map(c => csvEscape(row[c])).join(','));
  return lines.join('\n');
}

function matrixToCsv(matrix) {
  return matrix.map(row => row.map(csvEscape).join(',')).join('\n');
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(value);
      value = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(value);
      value = '';
      if (row.some(cell => cell !== '')) rows.push(row);
      row = [];
    } else {
      value += ch;
    }
  }

  row.push(value);
  if (row.some(cell => cell !== '')) rows.push(row);
  if (!rows.length) return [];

  rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  const headers = rows[0].map(h => h.trim());

  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = (r[i] ?? '').trim());
    return obj;
  });
}

async function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

async function fetchCsvMaybe(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return parseCsv(await res.text());
}

function normaliseData(unitsRaw, repeatersRaw, networksRaw, systemsRaw) {
  const units = unitsRaw.map(r => ({
    unit_id: toNumber(r['Unit ID']),
    name: r['Unit name'] || '',
    enabled: toNumber(r['Enabled']) || 0,
    lat: toNumber(r['Latitude']),
    lon: toNumber(r['Longitude']),
    elevation: toNumber(r['Elevation']),
    icon: toNumber(r['Icon']),
    forecolor: r['Forecolor'] || '',
    style: toNumber(r['Style']),
    backcolor: r['Backcolor'] || '',
    alert_id: toNumber(r['Text']),
    locked: toNumber(r['Locked']) || 0
  }));

  const repeaters = repeatersRaw.map((r, i) => {
    const windows = [];
    for (let n = 1; n <= 8; n++) {
      const low = toNumber(r[`Pass low ${n}`]);
      const high = toNumber(r[`Pass high ${n}`]);
      if (low !== null && high !== null) windows.push({ window_no: n, low, high });
    }
    return {
      repeater_id: toNumber(r['repeater_id']) || i + 1,
      name: r['Repeater'] || r['name'] || '',
      bom_network: r['BoM Network'] || r['bom_network'] || '',
      acma_licence: r['ACMA Lic.'] || r['acma_licence'] || '',
      rx: r['Rx'] || r['rx'] || '',
      tx: r['Tx'] || r['tx'] || '',
      windows
    };
  });

  const systems = systemsRaw.map((r, i) => ({
    'System ID': toNumber(r['System ID']) || i + 1,
    'System name': r['System name'] || '',
    'Tx power(W)': numberOrBlank(r['Tx power(W)']),
    'Line loss(dB)': numberOrBlank(r['Line loss(dB)']),
    'Supplemental Line loss(dB/m)': numberOrBlank(r['Supplemental Line loss(dB/m)']),
    'Antenna type': r['Antenna type'] || 'omni.ant',
    'Antenna gain(dBi)': numberOrBlank(r['Antenna gain(dBi)']),
    'Antenna height(m)': numberOrBlank(r['Antenna height(m)']),
    'Rx threshold(dBm)': numberOrBlank(r['Rx threshold(dBm)'])
  }));

  state.DATA = {
    units,
    repeaters,
    systems,
    radioMobileNetworks: networksRaw,
    meta: {
      unitCount: units.length,
      repeaterCount: repeaters.length,
      networkCount: [...new Set(repeaters.map(r => r.bom_network).filter(Boolean))].length,
      loadedAt: new Date().toLocaleString()
    }
  };

  state.dataLoaded = true;
  state.selectedNetworks = new Set([...new Set(repeaters.map(r => r.bom_network).filter(Boolean))].slice(0, 3));
  state.crudEntity = 'units';
  state.crudSearch = '';
  state.crudSelectedIndex = 0;
  state.crudDraft = structuredClone(state.DATA.units[0] || CRUD_CONFIG.units.blank());

  setUiEnabled(true);
  render();
}

function setUiEnabled(enabled) {
  [
    els.networkFilter, els.repeaterFilter, els.unitFilter,
    els.btnSelectAllNetworks, els.btnClearNetworks, els.btnExportRMSet,
    els.crudSearch, els.btnCrudNew, els.btnCrudDelete, els.btnCrudSave, els.btnCrudReset,
    ...els.exportButtons
  ].forEach(el => el.disabled = !enabled);
}

function getNetworks() {
  return [...new Set(state.DATA.repeaters.map(r => r.bom_network).filter(Boolean))].sort();
}

function getSelectedRepeaters() {
  const txt = state.repeaterFilter.toLowerCase();
  return state.DATA.repeaters.filter(r =>
    state.selectedNetworks.has(r.bom_network) &&
    (!txt || r.name.toLowerCase().includes(txt) || r.bom_network.toLowerCase().includes(txt))
  );
}

function repeaterMatchesAlert(repeater, alertId) {
  return alertId !== null && repeater.windows.some(w => alertId >= w.low && alertId <= w.high);
}

function buildMatches() {
  const repsForNetwork = state.DATA.repeaters.filter(r => state.selectedNetworks.has(r.bom_network));
  const matches = [];
  const units = [];
  const unitTxt = state.unitFilter.toLowerCase();

  for (const unit of state.DATA.units) {
    if (!unit.enabled || unit.alert_id === null || unit.alert_id === undefined) continue;

    const hitRepeaters = repsForNetwork.filter(r => repeaterMatchesAlert(r, unit.alert_id));
    if (!hitRepeaters.length) continue;

    if (unitTxt && !(unit.name.toLowerCase().includes(unitTxt) || String(unit.alert_id).includes(unitTxt))) continue;

    units.push({
      ...unit,
      matched_repeaters: hitRepeaters.length,
      matched_networks: [...new Set(hitRepeaters.map(r => r.bom_network))].join('; '),
      repeater_names: hitRepeaters.map(r => r.name).join('; ')
    });

    for (const rep of hitRepeaters) {
      const windowHits = rep.windows
        .filter(w => unit.alert_id >= w.low && unit.alert_id <= w.high)
        .map(w => `${w.low}-${w.high}`)
        .join('; ');
      matches.push({
        unit_id: unit.unit_id,
        unit_name: unit.name,
        alert_id: unit.alert_id,
        repeater_id: rep.repeater_id,
        repeater_name: rep.name,
        bom_network: rep.bom_network,
        matched_windows: windowHits
      });
    }
  }

  return { units, matches };
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(alert|aler|al|tm|rptr|repeater|br|bridge|rd|road|station|lookout)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findRepeaterUnit(rep) {
  const target = normalizeName(rep.name);
  let best = null;
  let bestScore = -1;

  for (const unit of state.DATA.units) {
    const cand = normalizeName(unit.name);
    if (!cand) continue;

    let score = 0;
    if (cand === target) score += 100;
    if (cand.includes(target) || target.includes(cand)) score += 40;
    const common = target.split(' ').filter(t => t && cand.includes(t)).length;
    score += common * 10;
    if (unit.icon === 307) score += 8;

    if (score > bestScore) {
      bestScore = score;
      best = unit;
    }
  }

  return bestScore >= 20 ? best : null;
}

function buildRadioMobileModel() {
  const reps = state.DATA.repeaters
    .filter(r => state.selectedNetworks.has(r.bom_network))
    .map((r, idx) => ({ ...r, out_index: idx + 1 }));

  const { units: matchedUnits, matches } = buildMatches();
  const matchIndex = new Map();
  for (const m of matches) matchIndex.set(`${m.repeater_id}|${m.unit_id}`, true);

  const repeaterUnitMap = new Map();
  for (const rep of reps) repeaterUnitMap.set(rep.repeater_id, findRepeaterUnit(rep));

  const selectedUnits = [];
  const seen = new Set();

  for (const rep of reps) {
    const u = repeaterUnitMap.get(rep.repeater_id);
    if (u && !seen.has(u.unit_id)) {
      seen.add(u.unit_id);
      selectedUnits.push({ ...u, source: 'repeater' });
    }
  }

  for (const u of matchedUnits) {
    if (!seen.has(u.unit_id)) {
      seen.add(u.unit_id);
      selectedUnits.push({ ...u, source: 'field' });
    }
  }

  selectedUnits.forEach((u, idx) => u.out_index = idx + 1);

  const byOrigId = new Map(selectedUnits.map(u => [u.unit_id, u]));
  const networkMemberMap = new Map();

  for (const rep of reps) {
    const member = new Set();
    const ru = repeaterUnitMap.get(rep.repeater_id);
    if (ru && byOrigId.has(ru.unit_id)) member.add(byOrigId.get(ru.unit_id).out_index);

    for (const u of selectedUnits) {
      if (matchIndex.has(`${rep.repeater_id}|${u.unit_id}`)) member.add(u.out_index);
    }
    networkMemberMap.set(rep.repeater_id, member);
  }

  return { repeaters: reps, selectedUnits, matches, repeaterUnitMap, networkMemberMap };
}

function buildRmFiles() {
  const model = buildRadioMobileModel();
  const reps = model.repeaters;
  const units = model.selectedUnits;

  const baseSystemTemplate = state.DATA.systems[0] || {
    'System ID': 1,
    'System name': 'Field Station 1W',
    'Tx power(W)': 1,
    'Line loss(dB)': 1,
    'Supplemental Line loss(dB/m)': 0,
    'Antenna type': 'omni.ant',
    'Antenna gain(dBi)': 5.15,
    'Antenna height(m)': 4,
    'Rx threshold(dBm)': -117.001
  };

  const systemsRows = [];
  const systemCount = Math.max(10, Number(state.DATA.systems.length || 0));

  for (let i = 1; i <= systemCount; i++) {
    const src = state.DATA.systems[i - 1] || state.DATA.systems[state.DATA.systems.length - 1] || baseSystemTemplate;
    systemsRows.push([
      i,
      src['System name'] || `System ${i}`,
      src['Tx power(W)'] ?? baseSystemTemplate['Tx power(W)'],
      src['Line loss(dB)'] ?? baseSystemTemplate['Line loss(dB)'],
      src['Supplemental Line loss(dB/m)'] ?? 0,
      src['Antenna type'] || 'omni.ant',
      src['Antenna gain(dBi)'] ?? 5.15,
      src['Antenna height(m)'] ?? 4,
      src['Rx threshold(dBm)'] ?? -117.001
    ]);
  }

  const totalUnitCount = units.length;

  const networkMatrix = [
    ['Radio Mobile'],
    ['$Style'],
    ['Prop mode', 'Color 1', 'Color 2', 'Color 3'],
    [0, 38, 40, 81],
    ['$Coverage'],
    ['AntAzt', 'Area', 'Color area', 'Contour', 'Color contour', 'D min', 'D max', 'Azt min', 'Azt max', 'Azt inc', 'Threshold mode', 'Visual color', 'Sensor h', 'Target h'],
    [0, 1, 'FFFF', 1, 0, 0.01, 50, 0, 360, 1, 1, 'FFFF', 2, 2],
    ['$Net'],
    ['Nbr nets', 'Nbr units', 'Nbr systems'],
    [reps.length, totalUnitCount, systemsRows.length],
    ['Net ID', 'Net name', 'Visible', 'Minimum fx', 'Max Fx', 'Refractivity', 'Conductivity', 'Permittivity', 'Polarization', 'Climate', 'Stat. mode', '%Time', '%Location', '%Situation', 'Topology', 'Max Rebro', '%Urban or Tree']
  ];

  for (const rep of reps) {
    networkMatrix.push([
      rep.out_index, rep.name, NETWORK_DEFAULTS.Visible, NETWORK_DEFAULTS['Minimum fx'], NETWORK_DEFAULTS['Max Fx'],
      NETWORK_DEFAULTS.Refractivity, NETWORK_DEFAULTS.Conductivity, NETWORK_DEFAULTS.Permittivity, NETWORK_DEFAULTS.Polarization,
      NETWORK_DEFAULTS.Climate, NETWORK_DEFAULTS['Stat. mode'], NETWORK_DEFAULTS['%Time'], NETWORK_DEFAULTS['%Location'],
      NETWORK_DEFAULTS['%Situation'], NETWORK_DEFAULTS.Topology, NETWORK_DEFAULTS['Max Rebro'], NETWORK_DEFAULTS['%Urban or Tree']
    ]);
  }

  const systemMatrix = [
    ['Radio Mobile'],
    ['$System'],
    ['System ID', 'System name', 'Tx power(W)', 'Line loss(dB)', 'Supplemental Line loss(dB/m)', 'Antenna type', 'Antenna gain(dBi)', 'Antenna height(m)', 'Rx threshold(dBm)'],
    ...systemsRows
  ];

  const unitMatrix = [
    ['Radio Mobile'],
    ['$Unit'],
    ['Unit ID', 'Unit name', 'Enabled', 'Latitude', 'Longitude', 'Elevation', 'Icon', 'Forecolor', 'Style', 'Backcolor', 'Text', 'Locked']
  ];

  for (const u of units) {
    unitMatrix.push([
      u.out_index, u.name, u.enabled, u.lat ?? '', u.lon ?? '', u.elevation ?? '',
      u.source === 'repeater' ? 307 : 243, u.forecolor ?? 'FFFFFF', u.style ?? 1,
      u.backcolor ?? 'FFFFFF', u.alert_id ?? '', u.locked ?? 0
    ]);
  }

  const headers = ['Net/Unit', ...units.map(u => u.out_index)];
  const netData = [['Radio Mobile']];

  function addSection(name, calcVal) {
    netData.push([name]);
    netData.push(headers);
    for (const rep of reps) {
      const memberSet = model.networkMemberMap.get(rep.repeater_id) || new Set();
      const row = [rep.out_index];
      for (const u of units) row.push(calcVal(rep, u, memberSet));
      netData.push(row);
    }
  }

  addSection('$NetAntHeight', (rep, u, memberSet) => memberSet.has(u.out_index) ? (u.source === 'repeater' ? 2 : 4) : '');
  addSection('$NetAntAzt', () => '');
  addSection('$NetAntElv', () => '');
  addSection('$NetSystem', (rep, u, memberSet) => memberSet.has(u.out_index) ? 1 : '');
  addSection('$NetRole', (rep, u, memberSet) => memberSet.has(u.out_index) ? (u.source === 'repeater' ? 1 : 2) : '');

  const megaNetMatrix = [
    ['Radio Mobile'],
    ['$Version'],
    [RM_CONFIG.version],
    [RM_CONFIG.separator],
    ['$Map'],
    [RM_CONFIG.map],
    ['$Picture'],
    [RM_CONFIG.picture1],
    [RM_CONFIG.picture2],
    ['$Land'],
    [RM_CONFIG.land],
    ['$Include'],
    ['MegaNet_Network.csv'],
    ['MegaNet_Unit.csv'],
    ['MegaNet_System.csv'],
    ['MegaNet_NetData.csv']
  ];

  const selectedRepeaterRows = reps.map(r => {
    const flat = {
      repeater_id: r.repeater_id,
      out_index: r.out_index,
      name: r.name,
      bom_network: r.bom_network,
      acma_licence: r.acma_licence,
      rx: r.rx,
      tx: r.tx
    };
    for (let i = 1; i <= 8; i++) {
      const w = r.windows.find(x => x.window_no === i);
      flat[`pass_low_${i}`] = w ? w.low : '';
      flat[`pass_high_${i}`] = w ? w.high : '';
    }
    const mapped = model.repeaterUnitMap.get(r.repeater_id);
    flat.repeater_unit = mapped ? mapped.name : '';
    flat.repeater_unit_id = mapped ? mapped.unit_id : '';
    return flat;
  });

  return {
    'MegaNet.csv': matrixToCsv(megaNetMatrix),
    'MegaNet_Network.csv': matrixToCsv(networkMatrix),
    'MegaNet_System.csv': matrixToCsv(systemMatrix),
    'MegaNet_Unit.csv': matrixToCsv(unitMatrix),
    'MegaNet_NetData.csv': matrixToCsv(netData),
    'Selected_Repeaters.csv': toCsv(selectedRepeaterRows),
    'Unit_Repeater_Matches.csv': toCsv(model.matches),
    'ALL_UNITS.csv': toCsv(state.DATA.units.map(u => ({
      'Unit ID': u.unit_id,
      'Unit name': u.name,
      Enabled: u.enabled,
      Latitude: u.lat,
      Longitude: u.lon,
      Elevation: u.elevation,
      Icon: u.icon,
      Forecolor: u.forecolor,
      Style: u.style,
      Backcolor: u.backcolor,
      Text: u.alert_id,
      Locked: u.locked
    }))),
    'ALL_REPEATERS.csv': toCsv(state.DATA.repeaters.map(r => {
      const row = {
        Repeater: r.name,
        'BoM Network': r.bom_network,
        'ACMA Lic.': r.acma_licence,
        Rx: r.rx,
        Tx: r.tx
      };
      for (let i = 1; i <= 8; i++) {
        const w = r.windows.find(x => x.window_no === i);
        row[`Pass low ${i}`] = w ? w.low : '';
        row[`Pass high ${i}`] = w ? w.high : '';
      }
      return row;
    })),
    'MegaNet_System_base.csv': toCsv(state.DATA.systems),
    _meta: {
      repeaterCount: reps.length,
      unitCount: units.length,
      matchCount: model.matches.length,
      mappedRepeaterUnits: [...model.repeaterUnitMap.values()].filter(Boolean).length,
      netdataSections: 5
    }
  };
}

function colourForFrequency(freq) {
  const key = String(freq || '').trim();
  if (!key) return '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash) + key.charCodeAt(i);
  const hue = Math.abs(hash) % 360;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const bg = dark ? `hsla(${hue}, 40%, 28%, .9)` : `hsla(${hue}, 45%, 92%, 1)`;
  const fg = dark ? `hsl(${hue}, 45%, 82%)` : `hsl(${hue}, 45%, 30%)`;
  return `background:${bg}; color:${fg};`;
}

function renderNetworks() {
  if (!state.dataLoaded) {
    els.networkList.innerHTML = '<div class="small">Load data first.</div>';
    return;
  }

  const txt = state.networkFilter.toLowerCase();
  const html = getNetworks()
    .filter(n => !txt || n.toLowerCase().includes(txt))
    .map(n => `<label><input type="checkbox" ${state.selectedNetworks.has(n) ? 'checked' : ''} data-network="${escapeHtml(n)}" /><span>${escapeHtml(n)}</span></label>`)
    .join('');

  els.networkList.innerHTML = html || '<div class="small">No networks match the filter.</div>';
  els.networkList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.addEventListener('change', e => {
    const n = e.target.dataset.network;
    e.target.checked ? state.selectedNetworks.add(n) : state.selectedNetworks.delete(n);
    render();
  }));
}

function renderRepeaters() {
  if (!state.dataLoaded) {
    els.repeaterTable.innerHTML = '<tbody><tr><td class="small">Load data first.</td></tr></tbody>';
    return;
  }

  const model = buildRadioMobileModel();
  const mappedOutByRepId = new Map(model.repeaters.map(rep => [rep.repeater_id, rep.out_index]));
  const rows = getSelectedRepeaters().map(r => {
    const mapped = model.repeaterUnitMap.get(r.repeater_id);
    const memberCount = (model.networkMemberMap.get(r.repeater_id) || new Set()).size;
    return `<tr>
      <td style="width:64px;">${mappedOutByRepId.get(r.repeater_id) || ''}</td>
      <td style="width:220px;">${escapeHtml(r.name)}</td>
      <td style="width:170px;">${escapeHtml(r.bom_network)}</td>
      <td class="rx-cell" style="width:130px;"><span class="freq-pill" style="${colourForFrequency(r.rx)}">${escapeHtml(r.rx || '')}</span></td>
      <td class="tx-cell" style="width:130px;"><span class="freq-pill" style="${colourForFrequency(r.tx)}">${escapeHtml(r.tx || '')}</span></td>
      <td style="width:160px;">${escapeHtml(mapped ? mapped.name : '')}</td>
      <td style="width:80px;">${memberCount}</td>
      <td>${escapeHtml(r.windows.map(w => `${w.low}-${w.high}`).join(', '))}</td>
    </tr>`;
  }).join('');

  els.repeaterTable.innerHTML = `<thead><tr>
    <th style="width:64px;">Net ID</th>
    <th style="width:220px;">Name</th>
    <th style="width:170px;">BoM network</th>
    <th style="width:130px;">Rx</th>
    <th style="width:130px;">Tx</th>
    <th style="width:160px;">Mapped repeater unit</th>
    <th style="width:80px;">Units</th>
    <th>Pass windows</th>
  </tr></thead><tbody>${rows || '<tr><td colspan="8" class="small">No repeaters selected.</td></tr>'}</tbody>`;
}

function renderUnits() {
  if (!state.dataLoaded) {
    els.unitsTable.innerHTML = '<tbody><tr><td class="small">Load data first.</td></tr></tbody>';
    return;
  }

  const model = buildRadioMobileModel();
  const unitTxt = state.unitFilter.toLowerCase();

  const rows = model.selectedUnits
    .filter(u => !unitTxt || u.name.toLowerCase().includes(unitTxt) || String(u.alert_id ?? '').includes(unitTxt))
    .slice(0, 2500)
    .map(u => `<tr>
      <td style="width:74px;">${u.out_index}</td>
      <td style="width:240px;">${escapeHtml(u.name)}</td>
      <td style="width:90px;">${u.alert_id ?? ''}</td>
      <td style="width:100px;">${u.lat ?? ''}</td>
      <td style="width:100px;">${u.lon ?? ''}</td>
      <td style="width:90px;">${u.source}</td>
      <td>${escapeHtml([...model.repeaters.filter(rep => (model.networkMemberMap.get(rep.repeater_id) || new Set()).has(u.out_index)).map(r => r.name)].join('; '))}</td>
    </tr>`)
    .join('');

  els.unitsTable.innerHTML = `<thead><tr>
    <th style="width:74px;">Out ID</th>
    <th style="width:240px;">Name</th>
    <th style="width:90px;">AlertID</th>
    <th style="width:100px;">Lat</th>
    <th style="width:100px;">Lon</th>
    <th style="width:90px;">Source</th>
    <th>Network member of</th>
  </tr></thead><tbody>${rows || '<tr><td colspan="7" class="small">No unit matches yet.</td></tr>'}</tbody>`;
}

function renderStats() {
  if (!state.dataLoaded) {
    els.stats.innerHTML = '<div class="small">Load data to see stats.</div>';
    els.exportSummary.textContent = 'Load data first.';
    return;
  }

  const rm = buildRmFiles();
  const meta = rm._meta;

  els.stats.innerHTML = `
    <div><span class="badge">${state.DATA.meta.unitCount}</span> base units loaded</div>
    <div><span class="badge">${state.DATA.meta.repeaterCount}</span> repeaters loaded</div>
    <div><span class="badge">${state.DATA.meta.networkCount}</span> BoM networks available</div>
    <div><span class="badge">${state.selectedNetworks.size}</span> BoM networks selected</div>
    <div><span class="badge">${meta.repeaterCount}</span> Radio Mobile networks generated</div>
    <div><span class="badge">${meta.unitCount}</span> Radio Mobile units generated</div>
    <div><span class="badge">${meta.matchCount}</span> unit ↔ repeater matches</div>
  `;

  els.exportSummary.innerHTML = `
    <div><strong>Radio Mobile export set</strong></div>
    <div class="small">MegaNet_Network Nbr units now uses total _Unit count.</div>
    <div class="small">MegaNet_Unit icons forced to 307 for repeater units, 243 for field units.</div>
    <div class="small">$NetRole now uses 1 for repeaters and 2 for field stations within each net.</div>
    <div class="small">Mapped repeater units: ${meta.mappedRepeaterUnits} of ${meta.repeaterCount}</div>
    <div class="small" style="margin-top:.4rem;">Loaded: ${escapeHtml(state.DATA.meta.loadedAt || '')}. Data stays in browser memory only unless exported.</div>
  `;
}

function initMap() {
  if (typeof L === 'undefined') return;
  const mapEl = document.getElementById('map');
  if (!mapEl) return;

  map = L.map(mapEl, {
    preferCanvas: true,
    zoomControl: true
  }).setView([-25, 133], 4);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  mapLayers = L.layerGroup().addTo(map);
  setTimeout(() => map.invalidateSize(), 0);
}

function getVisibleMapData() {
  const model = buildRadioMobileModel();
  const visibleRepeaters = getSelectedRepeaters();
  const visibleRepeaterIds = new Set(visibleRepeaters.map(r => r.repeater_id));
  const matchData = buildMatches();

  const visibleFieldUnits = matchData.units;
  const visibleMatches = matchData.matches.filter(m => visibleRepeaterIds.has(m.repeater_id));

  return { model, visibleRepeaters, visibleFieldUnits, visibleMatches };
}

function renderMap() {
  if (!map || !mapLayers) return;

  mapLayers.clearLayers();

  if (!state.dataLoaded) {
    if (els.mapSummary) els.mapSummary.textContent = 'Load data to view the network map.';
    map.setView([-25, 133], 4);
    return;
  }

  const { model, visibleRepeaters, visibleFieldUnits, visibleMatches } = getVisibleMapData();
  const bounds = [];
  const repeaterCoords = new Map();

  for (const rep of visibleRepeaters) {
    const mappedUnit = model.repeaterUnitMap.get(rep.repeater_id);
    if (!mappedUnit || mappedUnit.lat == null || mappedUnit.lon == null) continue;

    const coords = [mappedUnit.lat, mappedUnit.lon];
    repeaterCoords.set(rep.repeater_id, coords);

    L.circleMarker(coords, {
      radius: 7,
      color: '#0b5cab',
      weight: 2,
      fillColor: '#0b5cab',
      fillOpacity: 0.9
    })
      .bindPopup(
        `<strong>Repeater</strong><br>` +
        `${escapeHtml(rep.name)}<br>` +
        `Network: ${escapeHtml(rep.bom_network)}<br>` +
        `Mapped unit: ${escapeHtml(mappedUnit.name || '')}`
      )
      .addTo(mapLayers);

    bounds.push(coords);
  }

  const unitIndex = new Map();

  for (const unit of visibleFieldUnits) {
    if (unit.lat == null || unit.lon == null) continue;
    unitIndex.set(unit.unit_id, unit);

    const coords = [unit.lat, unit.lon];

    L.circleMarker(coords, {
      radius: 5,
      color: '#107c10',
      weight: 2,
      fillColor: '#107c10',
      fillOpacity: 0.85
    })
      .bindPopup(
        `<strong>Field station</strong><br>` +
        `${escapeHtml(unit.name)}<br>` +
        `AlertID: ${escapeHtml(unit.alert_id ?? '')}<br>` +
        `Matched repeaters: ${escapeHtml(unit.matched_repeaters ?? '')}`
      )
      .addTo(mapLayers);

    bounds.push(coords);
  }

  for (const match of visibleMatches) {
    const unit = unitIndex.get(match.unit_id);
    const repCoords = repeaterCoords.get(match.repeater_id);
    if (!unit || !repCoords || unit.lat == null || unit.lon == null) continue;

    const path = [
      [unit.lat, unit.lon],
      repCoords
    ];

    L.polyline(path, {
      color: '#ff6f00',
      weight: 2,
      opacity: 0.8
    })
      .bindPopup(
        `<strong>Open pass path</strong><br>` +
        `Field station: ${escapeHtml(match.unit_name)}<br>` +
        `Repeater: ${escapeHtml(match.repeater_name)}<br>` +
        `Network: ${escapeHtml(match.bom_network)}<br>` +
        `Pass window(s): ${escapeHtml(match.matched_windows)}`
      )
      .addTo(mapLayers);

    bounds.push(...path);
  }

  if (els.mapSummary) {
    els.mapSummary.innerHTML = `
      Showing <strong>${visibleRepeaters.length}</strong> repeaters,
      <strong>${visibleFieldUnits.length}</strong> field stations,
      and <strong>${visibleMatches.length}</strong> valid station → repeater paths.
    `;
  }

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [20, 20] });
  } else {
    map.setView([-25, 133], 4);
  }

  setTimeout(() => map.invalidateSize(), 0);
}

function renderCrud() {
  if (!state.dataLoaded) {
    els.crudTitle.textContent = 'Editor';
    els.crudTable.innerHTML = '<tbody><tr><td class="small">Load data first.</td></tr></tbody>';
    els.crudForm.innerHTML = '';
    els.crudStatus.textContent = 'Load data first.';
    return;
  }

  const config = CRUD_CONFIG[state.crudEntity];
  els.crudTitle.textContent = config.title;
  els.crudTabs.forEach(btn => btn.classList.toggle('active', btn.dataset.entity === state.crudEntity));

  const rows = getCrudRows();
  const filtered = rows.filter(row => {
    const q = state.crudSearch.toLowerCase();
    if (!q) return true;
    return Object.values(row).some(v => String(v ?? '').toLowerCase().includes(q));
    });

  const listHtml = filtered.slice(0, 1000).map(row => {
    const actualIndex = rows.indexOf(row);
    return `<tr data-index="${actualIndex}" class="${state.crudSelectedIndex === actualIndex ? 'selected' : ''}">
      ${config.listCols.map(c => `<td>${escapeHtml(row[c] ?? '')}</td>`).join('')}
    </tr>`;
  }).join('');

  els.crudTable.innerHTML = `<thead><tr>${config.listCols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${listHtml || '<tr><td class="small">No rows.</td></tr>'}</tbody>`;
  els.crudTable.querySelectorAll('tbody tr[data-index]').forEach(tr => tr.addEventListener('click', () => selectCrudRow(Number(tr.dataset.index))));

  if (state.crudDraft == null) state.crudDraft = structuredClone(rows[state.crudSelectedIndex] || config.blank());

  els.crudForm.innerHTML = config.fields.map(([name, type]) =>
    `<label>${escapeHtml(name)}<input data-field="${escapeHtml(name)}" type="${type === 'number' ? 'number' : 'text'}" value="${escapeHtml(state.crudDraft[name] ?? '')}" /></label>`
  ).join('');

  els.crudForm.querySelectorAll('input[data-field]').forEach(inp => inp.addEventListener('input', () => {
    state.crudDraft[inp.dataset.field] = inp.value;
  }));

  els.crudStatus.textContent = `Editing ${state.crudEntity} row ${state.crudSelectedIndex != null ? state.crudSelectedIndex + 1 : 'new'}.`;
}

function getCrudRows() {
  if (state.crudEntity === 'units') return state.DATA.units;

  if (state.crudEntity === 'repeaters') {
    return state.DATA.repeaters.map(r => {
      const row = {
        repeater_id: r.repeater_id,
        name: r.name,
        bom_network: r.bom_network,
        acma_licence: r.acma_licence,
        rx: r.rx,
        tx: r.tx
      };
      for (let i = 1; i <= 8; i++) {
        const w = r.windows.find(x => x.window_no === i);
        row[`pass_low_${i}`] = w ? w.low : '';
        row[`pass_high_${i}`] = w ? w.high : '';
      }
      return row;
    });
  }

  return state.DATA.systems;
}

function writeCrudRows(rows) {
  if (state.crudEntity === 'units') {
    state.DATA.units = rows.map(r => ({
      ...r,
      unit_id: toNumber(r.unit_id),
      enabled: toNumber(r.enabled) || 0,
      lat: toNumber(r.lat),
      lon: toNumber(r.lon),
      elevation: toNumber(r.elevation),
      icon: toNumber(r.icon),
      style: toNumber(r.style),
      alert_id: toNumber(r.alert_id),
      locked: toNumber(r.locked) || 0
    }));
  } else if (state.crudEntity === 'repeaters') {
    state.DATA.repeaters = rows.map((r, idx) => {
      const windows = [];
      for (let i = 1; i <= 8; i++) {
        const low = toNumber(r[`pass_low_${i}`]);
        const high = toNumber(r[`pass_high_${i}`]);
        if (low !== null && high !== null) windows.push({ window_no: i, low, high });
      }
      return {
        repeater_id: toNumber(r.repeater_id) || idx + 1,
        name: r.name || '',
        bom_network: r.bom_network || '',
        acma_licence: r.acma_licence || '',
        rx: r.rx || '',
        tx: r.tx || '',
        windows
      };
    });
  } else {
    state.DATA.systems = rows.map(r => ({
      'System ID': toNumber(r['System ID']) || 0,
      'System name': r['System name'] || '',
      'Tx power(W)': numberOrBlank(r['Tx power(W)']),
      'Line loss(dB)': numberOrBlank(r['Line loss(dB)']),
      'Supplemental Line loss(dB/m)': numberOrBlank(r['Supplemental Line loss(dB/m)']),
      'Antenna type': r['Antenna type'] || 'omni.ant',
      'Antenna gain(dBi)': numberOrBlank(r['Antenna gain(dBi)']),
      'Antenna height(m)': numberOrBlank(r['Antenna height(m)']),
      'Rx threshold(dBm)': numberOrBlank(r['Rx threshold(dBm)'])
    }));
  }

  state.DATA.meta.unitCount = state.DATA.units.length;
  state.DATA.meta.repeaterCount = state.DATA.repeaters.length;
  state.DATA.meta.networkCount = [...new Set(state.DATA.repeaters.map(r => r.bom_network).filter(Boolean))].length;
}

function selectCrudRow(index) {
  const rows = getCrudRows();
  state.crudSelectedIndex = index;
  state.crudDraft = structuredClone(rows[index]);
  renderCrud();
}

function newCrudRow() {
  const cfg = CRUD_CONFIG[state.crudEntity];
  state.crudSelectedIndex = null;
  state.crudDraft = cfg.blank();
  renderCrud();
}

function saveCrudRow() {
  const rows = getCrudRows();
  const draft = structuredClone(state.crudDraft || CRUD_CONFIG[state.crudEntity].blank());

  if (state.crudSelectedIndex == null) rows.push(draft);
  else rows[state.crudSelectedIndex] = draft;

  writeCrudRows(rows);
  state.crudSelectedIndex = state.crudSelectedIndex == null ? rows.length - 1 : state.crudSelectedIndex;
  state.crudDraft = structuredClone(getCrudRows()[state.crudSelectedIndex]);
  render();
  els.crudStatus.textContent = 'Saved.';
}

function deleteCrudRow() {
  if (state.crudSelectedIndex == null) return;

  const rows = getCrudRows();
  rows.splice(state.crudSelectedIndex, 1);
  writeCrudRows(rows);

  if (rows.length) {
    state.crudSelectedIndex = Math.max(0, state.crudSelectedIndex - 1);
    state.crudDraft = structuredClone(getCrudRows()[state.crudSelectedIndex]);
  } else {
    state.crudSelectedIndex = null;
    state.crudDraft = CRUD_CONFIG[state.crudEntity].blank();
  }

  render();
  els.crudStatus.textContent = 'Deleted selected row.';
}

function resetCrudDraft() {
  const rows = getCrudRows();
  const cfg = CRUD_CONFIG[state.crudEntity];
  state.crudDraft = structuredClone(state.crudSelectedIndex == null ? cfg.blank() : rows[state.crudSelectedIndex]);
  renderCrud();
}

function render() {
  renderNetworks();
  renderRepeaters();
  renderUnits();
  renderStats();
  renderCrud();
  renderMap();
}

async function loadFromInputs() {
  const files = {
    units: els.fileUnits.files[0],
    repeaters: els.fileRepeaters.files[0],
    networks: els.fileNetworks.files[0],
    systems: els.fileSystems.files[0]
  };

  if (!files.units || !files.repeaters || !files.networks || !files.systems) {
    els.loadStatus.textContent = 'Pick all 4 CSV files first.';
    return;
  }

  try {
    els.loadStatus.textContent = 'Loading selected CSV files...';
    const [unitsRaw, repeatersRaw, networksRaw, systemsRaw] = await Promise.all([
      readFileText(files.units).then(parseCsv),
      readFileText(files.repeaters).then(parseCsv),
      readFileText(files.networks).then(parseCsv),
      readFileText(files.systems).then(parseCsv)
    ]);
    normaliseData(unitsRaw, repeatersRaw, networksRaw, systemsRaw);
    els.loadStatus.textContent = `Loaded from selected files: ${files.units.name}, ${files.repeaters.name}, ${files.networks.name}, ${files.systems.name}`;
  } catch (err) {
    console.error(err);
    els.loadStatus.textContent = `Load failed: ${err.message}`;
  }
}

async function autoloadSameFolder() {
  try {
    els.loadStatus.textContent = 'Trying auto-load from same folder...';
    const [unitsRaw, repeatersRaw, networksRaw, systemsRaw] = await Promise.all([
      fetchCsvMaybe('ALL_UNITS.csv'),
      fetchCsvMaybe('ALL_REPEATERS.csv'),
      fetchCsvMaybe('MegaNet_Network.csv'),
      fetchCsvMaybe('MegaNet_System.csv')
    ]);
    normaliseData(unitsRaw, repeatersRaw, networksRaw, systemsRaw);
    els.loadStatus.textContent = 'Auto-load succeeded from same folder CSVs.';
  } catch (err) {
    console.warn(err);
    els.loadStatus.textContent = 'Auto-load failed. Use the file pickers instead.';
  }
}

els.networkFilter.addEventListener('input', e => {
  state.networkFilter = e.target.value;
  renderNetworks();
});

els.repeaterFilter.addEventListener('input', e => {
  state.repeaterFilter = e.target.value;
  renderRepeaters();
  renderMap();
});

els.unitFilter.addEventListener('input', e => {
  state.unitFilter = e.target.value;
  renderUnits();
  renderMap();
});

els.crudSearch.addEventListener('input', e => {
  state.crudSearch = e.target.value;
  renderCrud();
});

els.btnSelectAllNetworks.addEventListener('click', () => {
  getNetworks().forEach(n => state.selectedNetworks.add(n));
  render();
});

els.btnClearNetworks.addEventListener('click', () => {
  state.selectedNetworks.clear();
  render();
});

els.btnExportRMSet.addEventListener('click', () => {
  const files = buildRmFiles();
  ['MegaNet.csv', 'MegaNet_Network.csv', 'MegaNet_System.csv', 'MegaNet_Unit.csv', 'MegaNet_NetData.csv']
    .forEach((name, idx) => setTimeout(() => downloadText(name, files[name]), idx * 180));
});

els.btnAutoload.addEventListener('click', autoloadSameFolder);
els.btnLoadFiles.addEventListener('click', loadFromInputs);

els.exportButtons.forEach(btn => btn.addEventListener('click', e => {
  const files = buildRmFiles();
  const key = `${e.target.dataset.export}${e.target.dataset.export.endsWith('_BASE') ? '' : '.csv'}`;

  if (e.target.dataset.export === 'ALL_UNITS_BASE') return downloadText('ALL_UNITS.csv', files['ALL_UNITS.csv']);
  if (e.target.dataset.export === 'ALL_REPEATERS_BASE') return downloadText('ALL_REPEATERS.csv', files['ALL_REPEATERS.csv']);
  if (e.target.dataset.export === 'MegaNet_System_BASE') return downloadText('MegaNet_System.csv', files['MegaNet_System_base.csv']);

  return downloadText(key, files[key]);
}));

els.crudTabs.forEach(btn => btn.addEventListener('click', () => {
  state.crudEntity = btn.dataset.entity;
  state.crudSearch = '';
  const rows = getCrudRows();
  state.crudSelectedIndex = rows.length ? 0 : null;
  state.crudDraft = structuredClone(rows[0] || CRUD_CONFIG[state.crudEntity].blank());
  renderCrud();
}));

els.btnCrudNew.addEventListener('click', newCrudRow);
els.btnCrudSave.addEventListener('click', saveCrudRow);
els.btnCrudDelete.addEventListener('click', deleteCrudRow);
els.btnCrudReset.addEventListener('click', resetCrudDraft);

initTheme();
initMap();
setUiEnabled(false);
render();