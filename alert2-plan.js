// MegaNet — alert2-plan.js
//
//   Alert2Plan   the ALERT2 Transition Plan tab, listed to administrators and
//                nobody else: a draft for management of what moving the
//                network from ALERT to ALERT2 takes — the equipment and how
//                much of it, where the work is by region and catchment, the
//                network reviews, the backbone repeaters to acquire and
//                remediate first, the timeline, the effort in FTE and the
//                cost — every figure worked from the station register as it is
//                loaded, under a scenario card whose sliders and switches
//                re-run the whole plan as they move.
//
// After core.js, maps-data.js, map-backbone.js, sls.js, xlsx-write.js and
// auth.js; before init.js. Nothing runs at load: renderMain() calls render()
// and init(), and auth.js calls authChanged() on every sign-in and sign-out.
// Reaches back to core.js for state, esc, escAttr, announce, dlText,
// floodnetName, acmaHaversineKm, csvEscape and tabShown; across to app.js for
// repeaterList, passRelationIndex, stationOwner and switchTab; to
// map-backbone.js for backboneIndex; to sls.js (SLS) for owners and priority;
// to maps-data.js (MegaNetMaps) for the basin drawing; to xlsx-write.js
// (XlsxWrite) and export.js (zipStore, through it) for the workbook.
//
// ── Who it is for ────────────────────────────────────────────────────────────
// The owner asked for this tab to be seen by the highest administrators only,
// so TABS marks it `who: 'admin'` and the nav, the find box, Ctrl+K, the views
// and the Site Map all leave it out for anybody else (tabShown, core.js).
// Opened by its address it says who it is for and shows nothing more. Like
// Network Review, everything it reads is readable without signing in — the
// register, the SLS, the basins — so this is about who the page is for, not
// the security of any datum. The plan's own words are in this file, and this
// repository is public: anything that must stay private (a negotiated price,
// a name) belongs in the database behind meganet.is_admin(), not here.
//
// ── How the plan is worked out ───────────────────────────────────────────────
// Three layers, kept apart so each can be read and checked alone:
//
//   inventory()  what is out there, from the register: field stations (rain
//                only, or a river height), repeaters (and which carry the
//                backbone, by map-backbone.js's own rule), bases — by region
//                and catchment — and, once the SLS is on hand, who owns each
//                repeater and how many High-priority sites each region holds.
//   model()      what converting it takes under a scenario: a month-by-month
//                walk of a handful of lanes (procurement, reviews, backbone
//                acquisition, remediation and fit-out, the pilot, the bases,
//                field crews region by region, close-out), each consuming its
//                own capacity, the field lanes slowed in the wet season. Out
//                of it come the dates, the person-days by role and the costs
//                by month, which the FTE profile and the financial-year cash
//                flow are sums of. Pure: inventory and scenario in, plan out.
//   the page     the plan as a document for management, every number read
//                off the model, with the scenario card above it.
//
// The model is an estimate and says so on every page it draws. Its defaults
// are a proposal to argue with, not measurements; the card is there so the
// argument can be had with the numbers moving.

const Alert2Plan = (function () {
  const LS_KEY = 'meganet.a2plan.scenario';
  const WORK_DAYS_YEAR = 220;            // a full-time year, after leave and public holidays
  const WORK_DAYS_MONTH = WORK_DAYS_YEAR / 12;
  const DESK_DAYS_MONTH = 15;            // engineer-days a desk team gets through in a month
  const HORIZON = 240;                   // months the walk will go before it gives up

  // ── The proposal ──
  // Every figure the card can move, at the value the draft proposes. Money is
  // Australian dollars excluding GST, at 2026 prices.
  const DEFAULTS = {
    scope: 'qld',
    start: '2027-07',
    procureMonths: 6,
    pilot: true, pilotMonths: 4, pilotSites: 20,
    backboneFirst: true, backboneKm: 100, allBackbone: false,
    acquireOther: true, unknownAcqPct: 50, acqLeadMonths: 9, acqParallel: 6,
    remediatePct: 60, remediateDays: 4, remedCrews: 2, fitDays: 1.5, backboneCrews: 1,
    reviews: true, reviewTeams: 1, addRepPct: 10, removeRepPct: 5,
    basesN: 0, dupBases: true, baseDays: 4,
    fieldCrews: 4, staffPerCrew: 2, crewDays: 14,
    rainDays: 1.0, levelDays: 1.5, remoteMult: 1.5,
    wet: true, wetFactor: 50, fwinPct: 20, fwinDays: 0.25,
    closeMonths: 3, pmFte: 1, benchHours: 2,
    spares: 5, contingency: 25, powerPct: 25,
    cErtA2: 6500, cErtRep: 7500, cErtBase: 6500, c115e: 3500, cKit: 1500, cPower: 3000, cTestKit: 25000,
    cAcq: 30000, cRemed: 45000, cNewRep: 180000, cRemove: 5000, cLicence: 1500,
    rateField: 150000, rateEng: 185000, ratePm: 200000, rateSupport: 140000, travelDay: 700,
  };

  // Ways to ask "what if" with one press. Each is the proposal with a few
  // things changed, so the comparison against the proposal stays meaningful.
  const PRESETS = [
    { id: 'proposed', label: 'The proposal', set: {} },
    { id: 'faster', label: 'Faster — more crews', set: { fieldCrews: 6, backboneCrews: 2, remedCrews: 3, reviewTeams: 2, acqParallel: 10 } },
    { id: 'lean', label: 'Leaner — fewer crews', set: { fieldCrews: 2, backboneCrews: 1, remedCrews: 1 } },
    { id: 'together', label: 'Backbone with each region', set: { backboneFirst: false } },
    { id: 'minimal', label: 'Like for like — no reviews', set: { reviews: false, addRepPct: 0, removeRepPct: 0, pilot: false } },
    { id: 'allyear', label: 'Work through the wet season', set: { wet: false } },
  ];

  // The card's controls, by group. `k` is the scenario key; a slider has
  // min/max/step and a unit, a switch has none, a select has options.
  const CONTROLS = [
    { group: 'Scope and quantities', items: [
      { k: 'scope', kind: 'select', label: 'Stations in the plan', options: [
        ['qld', 'Queensland — the 77 basins'],
        ['hubs', 'Queensland and the rest of the Brisbane and Cairns hubs'],
        ['all', 'Everything in the register'],
      ] },
      { k: 'basesN', kind: 'range', label: 'Base stations to equip', min: 0, max: 40, step: 1, unit: '', zero: 'from the register' },
      { k: 'dupBases', kind: 'switch', label: 'Two receive chains at every base (a hot spare)' },
      { k: 'backboneKm', kind: 'range', label: 'Backbone hop — longest repeater-to-repeater link counted', min: 30, max: 150, step: 5, unit: ' km' },
      { k: 'allBackbone', kind: 'switch', label: 'Treat every repeater as backbone' },
      { k: 'spares', kind: 'range', label: 'Spare units bought', min: 0, max: 20, step: 1, unit: '%' },
    ] },
    { group: 'How the work is done', items: [
      { k: 'backboneFirst', kind: 'switch', label: 'Backbone first — acquire, remediate and fit repeaters ahead of the field work' },
      { k: 'reviews', kind: 'switch', label: 'Review each network before converting it' },
      { k: 'pilot', kind: 'switch', label: 'Pilot one network first' },
      { k: 'wet', kind: 'switch', label: 'Slow field work in the wet season (December to March)' },
      { k: 'wetFactor', kind: 'range', label: 'Field capacity left in the wet season', min: 0, max: 100, step: 5, unit: '%' },
      { k: 'fwinPct', kind: 'range', label: 'Field stations converted on an FWIN upgrade visit', min: 0, max: 80, step: 5, unit: '%' },
      { k: 'start', kind: 'month', label: 'Approval to start' },
    ] },
    { group: 'People and pace', items: [
      { k: 'fieldCrews', kind: 'range', label: 'Field crews converting stations', min: 1, max: 10, step: 1, unit: '' },
      { k: 'staffPerCrew', kind: 'range', label: 'People in a crew', min: 1, max: 3, step: 1, unit: '' },
      { k: 'crewDays', kind: 'range', label: 'Field days a crew works in a month', min: 6, max: 20, step: 1, unit: ' d' },
      { k: 'rainDays', kind: 'range', label: 'Crew-days per rainfall station, travel included', min: 0.25, max: 3, step: 0.25, unit: ' d' },
      { k: 'levelDays', kind: 'range', label: 'Crew-days per river station, travel included', min: 0.5, max: 4, step: 0.25, unit: ' d' },
      { k: 'remoteMult', kind: 'range', label: 'Remote regions take longer by', min: 1, max: 3, step: 0.1, unit: '×' },
      { k: 'backboneCrews', kind: 'range', label: 'Crews fitting ALERT2 to repeaters', min: 1, max: 5, step: 1, unit: '' },
      { k: 'remedCrews', kind: 'range', label: 'Contract crews remediating backbone sites', min: 1, max: 6, step: 1, unit: '' },
      { k: 'reviewTeams', kind: 'range', label: 'Network review teams', min: 1, max: 4, step: 1, unit: '' },
    ] },
    { group: 'Backbone and network changes', items: [
      { k: 'acquireOther', kind: 'switch', label: 'Acquire backbone sites owned by councils and others' },
      { k: 'unknownAcqPct', kind: 'range', label: 'Of sites with no owner on record, share that turn out to need acquiring', min: 0, max: 100, step: 5, unit: '%' },
      { k: 'acqLeadMonths', kind: 'range', label: 'Months to settle one owner\'s sites', min: 2, max: 24, step: 1, unit: ' mo' },
      { k: 'acqParallel', kind: 'range', label: 'Owners negotiated with at once', min: 1, max: 15, step: 1, unit: '' },
      { k: 'remediatePct', kind: 'range', label: 'Backbone sites needing remediation', min: 0, max: 100, step: 5, unit: '%' },
      { k: 'addRepPct', kind: 'range', label: 'Repeaters the reviews add', min: 0, max: 40, step: 1, unit: '%' },
      { k: 'removeRepPct', kind: 'range', label: 'Repeaters the reviews retire', min: 0, max: 40, step: 1, unit: '%' },
    ] },
    { group: 'Money', items: [
      { k: 'contingency', kind: 'range', label: 'Contingency', min: 0, max: 50, step: 5, unit: '%' },
      { k: 'powerPct', kind: 'range', label: 'Field stations needing a solar and battery upgrade', min: 0, max: 100, step: 5, unit: '%' },
    ] },
  ];

  // The unit costs and rates, in the card's folded panel: typed, not slid —
  // a price is a number somebody was quoted.
  const RATES = [
    { k: 'cErtA2', label: 'ERT-A2 field transmitter, each' },
    { k: 'cErtRep', label: 'ERT-A2 configured as a repeater, each' },
    { k: 'cErtBase', label: 'ERT-A2 receiver at a base, each' },
    { k: 'c115e', label: '115E-2 gateway with its ALERT2 licence key, each' },
    { k: 'cKit', label: 'Antenna, coax, surge and GPS kit, per site' },
    { k: 'cPower', label: 'Solar and battery upgrade, per station' },
    { k: 'cTestKit', label: 'Test and bench equipment, per crew' },
    { k: 'cAcq', label: 'Acquiring one backbone site (legal, valuation, transfer)' },
    { k: 'cRemed', label: 'Remediating one backbone site (materials and contract works)' },
    { k: 'cNewRep', label: 'Building one new repeater site' },
    { k: 'cRemove', label: 'Retiring one repeater site' },
    { k: 'cLicence', label: 'Licensing and frequency coordination, per repeater or base' },
    { k: 'rateField', label: 'Field technician, a year fully loaded' },
    { k: 'rateEng', label: 'RF / telemetry engineer, a year fully loaded' },
    { k: 'ratePm', label: 'Project manager, a year fully loaded' },
    { k: 'rateSupport', label: 'Procurement, property and records support, a year fully loaded' },
    { k: 'travelDay', label: 'Vehicle, accommodation and allowances, per crew field day' },
  ];

  // The regions the register's catchments are filed under, in Radio Path
  // Maps' colours (--maps-region-*), and which count as remote.
  const REGION_VAR = {
    'Far North': 'far-north', 'Mackay / Whitsundays': 'mackay', 'Burdekin / Townsville': 'burdekin',
    'Central QLD': 'central', 'Wide Bay / Burnett': 'widebay', 'SE QLD': 'seqld',
    'West / South West': 'west', 'NSW Border': 'nsw',
  };
  const REMOTE = new Set(['Far North', 'West / South West', 'Gulf and Cape York']);

  // ── state ──
  let sc = loadScenario();
  let inv = null, invKey = null;
  let slsWanted = false, slsReady = false;
  let basins = null;               // parsed basin polygons, once

  function isAdmin() {
    return typeof Auth !== 'undefined' && Auth.isSignedIn()
      && ((Auth.isAdmin && Auth.isAdmin()) || Auth.role() === 'admin');
  }

  // ── the scenario, kept on this device ──
  function loadScenario() {
    let got = null;
    try { got = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { got = null; }
    return sanitize(got);
  }
  function sanitize(raw) {
    const out = { ...DEFAULTS };
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(DEFAULTS)) {
        const d = DEFAULTS[k], v = raw[k];
        if (v == null) continue;
        if (typeof d === 'boolean') out[k] = !!v;
        else if (typeof d === 'number') { const n = Number(v); if (isFinite(n) && n >= 0) out[k] = n; }
        else if (k === 'start') { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v))) out[k] = String(v); }
        else if (k === 'scope') { if (['qld', 'hubs', 'all'].includes(v)) out[k] = v; }
      }
      if (Array.isArray(raw.order)) out.order = raw.order.filter(x => typeof x === 'string').slice(0, 40);
    }
    return out;
  }
  function saveScenario() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(sc)); } catch (_) { /* a private window: it still works, unremembered */ }
  }
  function differs(a, b) {
    return Object.keys(DEFAULTS).some(k => a[k] !== b[k]) || JSON.stringify(a.order || []) !== JSON.stringify(b.order || []);
  }

  // ── formatting ──
  const nf = n => Math.round(n).toLocaleString('en-AU');
  const nf1 = n => (Math.round(n * 10) / 10).toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function money(v, exact) {
    const a = Math.abs(v), sign = v < 0 ? '−' : '';
    if (exact) return `${sign}$${nf(a)}`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)}m`;
    if (a >= 1e3) return `${sign}$${nf(a / 1e3)}k`;
    return `${sign}$${nf(a)}`;
  }
  const pct = n => `${Math.round(n)}%`;
  function startParts(s) {
    const m = /^(\d{4})-(\d{2})$/.exec(s.start || DEFAULTS.start);
    return { y: Number(m[1]), m: Number(m[2]) - 1 };
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function calOf(s, i) {
    const p = startParts(s), t = p.m + Math.floor(i);
    return { y: p.y + Math.floor(t / 12), m: ((t % 12) + 12) % 12 };
  }
  function monthLabel(s, i) { const c = calOf(s, i); return `${MONTHS[c.m]} ${c.y}`; }
  // The month a span that ends at `end` (fractional, exclusive) finishes in.
  function endLabel(s, end) { return monthLabel(s, Math.max(0, Math.ceil(end - 1e-9) - 1)); }
  function fyOf(s, i) {
    const c = calOf(s, i), y0 = c.m >= 6 ? c.y : c.y - 1;
    return `${y0}–${String((y0 + 1) % 100).padStart(2, '0')}`;
  }
  const mo = n => `${nf1(n)} month${Math.abs(n - 1) < 0.05 ? '' : 's'}`;

  // ── 1. the inventory ──────────────────────────────────────────────────────

  function isTestRig(s) {
    return /\btest\s+(unit|rig)\b/i.test(s.name || '') || s.station_number === '999999';
  }
  function hasAlert(s) { return s.alert_ids && Object.keys(s.alert_ids).length > 0; }

  // Who owns a repeater, by the station's own record or the SLS: the Bureau,
  // the Bureau with somebody, somebody else, or nobody on record.
  function ownerOf(s) {
    const o = typeof stationOwner === 'function' ? stationOwner(s) : null;
    const loc = typeof SLS !== 'undefined' && SLS.loaded && SLS.loaded() ? SLS.forStation(s) : null;
    if (!o) return { cls: loc && loc.bureau_owned ? 'bureau' : 'unknown', name: loc && loc.bureau_owned ? 'Bureau' : '' };
    const parties = o.parties || [o.name];
    const bur = parties.filter(p => /^bureau(\s+of\s+meteorology)?$/i.test(p.trim()));
    if (bur.length === parties.length) return { cls: 'bureau', name: o.name };
    if (bur.length) return { cls: 'joint', name: o.name };
    return { cls: 'other', name: o.name };
  }
  function priorityOf(s) {
    const loc = typeof SLS !== 'undefined' && SLS.loaded && SLS.loaded() ? SLS.forStation(s) : null;
    return loc && loc.priority ? String(loc.priority) : '';
  }

  function inventory() {
    if (!state.data) return null;
    const key = [sc.scope, sc.backboneKm, sc.allBackbone, slsReady].join('|');
    if (inv && invKey === key && inv.data === state.data) return inv;
    const stations = state.data.stations.filter(s => !s.deleted_at && s.lat != null && s.lon != null && !isTestRig(s));
    const cats = new Map((state.data.catchments || []).map(c => [c.id, c]));
    const regionName = c => c.region || (c.division === 'Gulf' ? 'Gulf and Cape York' : 'North East Coast (other)');

    // A station with a Queensland catchment is in Queensland. One without is
    // either over the border or on an island, a headland or a wharf the basin
    // polygons stop short of — those take the region of the nearest station
    // that has one, if it is within 25 km and north of the border.
    const qld = stations.filter(s => (s.catchment_ids || []).some(id => cats.has(id)));
    const nearestQld = s => {
      let best = null, bd = 25;
      for (const q of qld) {
        if (Math.abs(q.lat - s.lat) > 0.3) continue;
        const d = acmaHaversineKm(s.lat, s.lon, q.lat, q.lon);
        if (d < bd) { bd = d; best = q; }
      }
      return best;
    };
    const placeOf = new Map();
    for (const s of stations) {
      const c = (s.catchment_ids || []).map(id => cats.get(id)).find(Boolean);
      if (c) { placeOf.set(s.id, { region: regionName(c), catchment: c.name, cid: c.id, qld: true }); continue; }
      const inHub = s.hub_id === 'brisbane' || s.hub_id === 'cairns';
      const near = inHub && s.lat > -28.17 ? nearestQld(s) : null;
      if (near) {
        const nc = cats.get(near.catchment_ids.find(id => cats.has(id)));
        placeOf.set(s.id, { region: regionName(nc), catchment: nc.name, cid: nc.id, qld: true });
      } else if (inHub) {
        placeOf.set(s.id, { region: s.lat <= -28.17 ? 'NSW Border' : 'Outside the basins', catchment: s.lga || 'Not in a Queensland basin', cid: null, qld: false, hub: true });
      } else {
        const hub = (state.data.hubs || []).find(h => h.id === s.hub_id);
        placeOf.set(s.id, { region: hub ? hub.name : 'No hub', catchment: s.lga || s.basin || '—', cid: null, qld: false });
      }
    }
    const inScope = s => {
      const p = placeOf.get(s.id);
      if (!p) return false;
      if (sc.scope === 'qld') return p.qld;
      if (sc.scope === 'hubs') return p.qld || !!p.hub;
      return true;
    };

    // The backbone, by map-backbone.js's rule at the card's hop distance: a
    // repeater sharing an open pass-range window with another within it, or
    // within it of a base.
    const backbone = new Set();
    const links = [];
    if (typeof backboneIndex === 'function') {
      for (const p of backboneIndex().pairs) {
        if (p.km > sc.backboneKm) continue;
        if (p.a.roles.includes('repeater')) backbone.add(p.a.id);
        if (p.b.roles.includes('repeater')) backbone.add(p.b.id);
        links.push(p);
      }
    }
    const carried = typeof passRelationIndex === 'function' ? passRelationIndex().byRepeater : new Map();

    const regions = new Map();
    const region = name => {
      if (!regions.has(name)) {
        regions.set(name, { name, cats: new Map(), rain: 0, level: 0, field: 0, repeaters: 0, backbone: 0, bases: 0, high: 0,
                            remote: REMOTE.has(name), owners: { bureau: 0, joint: 0, other: 0, unknown: 0 } });
      }
      return regions.get(name);
    };
    const catOf = (r, p) => {
      const k = p.cid || p.catchment;
      if (!r.cats.has(k)) r.cats.set(k, { name: p.catchment, rain: 0, level: 0, repeaters: 0, backbone: 0, bases: 0, high: 0 });
      return r.cats.get(k);
    };
    const field = [], reps = [], bases = [];
    for (const s of stations) {
      if (!inScope(s)) continue;
      const roles = s.roles || [];
      const p = placeOf.get(s.id), r = region(p.region), c = catOf(r, p);
      const hi = priorityOf(s) === 'High';
      if (roles.includes('base')) { bases.push({ s, p }); r.bases++; c.bases++; }
      if (roles.includes('repeater')) {
        const bb = sc.allBackbone || backbone.has(s.id);
        const own = ownerOf(s);
        reps.push({ s, p, backbone: bb, owner: own, carries: (carried.get(s.id) || []).length });
        r.repeaters++; c.repeaters++;
        if (bb) { r.backbone++; c.backbone++; r.owners[own.cls]++; }
      } else if (!roles.includes('base') && roles.includes('field') && hasAlert(s)) {
        const lvl = !!(s.alert_ids && s.alert_ids.water_level != null);
        field.push({ s, p, level: lvl, high: hi });
        r.field++; if (lvl) { r.level++; c.level++; } else { r.rain++; c.rain++; }
        if (hi) { r.high++; c.high++; }
      }
    }
    const nets = (state.data.radio_networks || []).length;
    inv = {
      data: state.data, field, reps, bases, links: links.filter(p => inScope(p.a) && inScope(p.b)),
      regions: [...regions.values()].filter(r => r.field || r.repeaters || r.bases),
      catchmentCount: new Set(field.concat(reps).map(x => x.p.cid || x.p.catchment)).size,
      radioNetworks: nets,
      registerBases: bases.length,
      asAt: (state.data.meta && state.data.meta.updated) || '',
    };
    invKey = key;
    return inv;
  }

  // The order the regions are converted in: the card's, then any region it
  // does not mention by most High-priority sites, then most stations.
  function regionOrder(I, s) {
    const names = I.regions.map(r => r.name);
    const byWeight = I.regions.slice().sort((a, b) => (b.high - a.high) || (b.field - a.field) || a.name.localeCompare(b.name)).map(r => r.name);
    const given = (s.order || []).filter(n => names.includes(n));
    return given.concat(byWeight.filter(n => !given.includes(n)));
  }

  // ── 2. the model ──────────────────────────────────────────────────────────

  // One lane of work: `work` units at `perMonth` a month from month `from`,
  // slowed where `factor(m)` says. Returns where it ends (a fractional month)
  // and how much was done in each month.
  function lane(work, perMonth, from, factor) {
    const by = [];
    if (!(work > 0)) return { start: from, end: from, by };
    let t = from, left = work, guard = 0;
    while (left > 1e-9 && guard++ < HORIZON * 2) {
      const m = Math.floor(t + 1e-9);
      const cap = perMonth * (factor ? factor(m) : 1);
      const room = m + 1 - t;
      if (cap <= 0) { t = m + 1; continue; }
      const can = cap * room;
      const use = Math.min(left, can);
      by[m] = (by[m] || 0) + use;
      left -= use;
      t = left > 1e-9 ? m + 1 : t + use / cap;
    }
    return { start: from, end: t, by };
  }
  function addInto(arr, m, v) { if (v) arr[m] = (arr[m] || 0) + v; }
  // Spread `v` evenly over [a, b) into a monthly array.
  function spread(arr, a, b, v) {
    if (!v) return;
    if (!(b > a)) { addInto(arr, Math.floor(a), v); return; }
    for (let m = Math.floor(a); m < Math.ceil(b - 1e-9); m++) {
      const lo = Math.max(a, m), hi = Math.min(b, m + 1);
      if (hi > lo) addInto(arr, m, v * (hi - lo) / (b - a));
    }
  }

  function model(I, s) {
    const wetOf = m => {
      if (!s.wet) return 1;
      const c = calOf(s, m).m;
      return c === 11 || c <= 2 ? s.wetFactor / 100 : 1;
    };
    const order = regionOrder(I, s);
    const R = new Map(I.regions.map(r => [r.name, r]));
    const spare = 1 + s.spares / 100;
    const dayRate = { field: s.rateField / WORK_DAYS_YEAR, eng: s.rateEng / WORK_DAYS_YEAR, pm: s.ratePm / WORK_DAYS_YEAR, support: s.rateSupport / WORK_DAYS_YEAR };

    // Quantities.
    const nField = I.field.length;
    const nLevel = I.field.filter(f => f.level).length;
    const nRep0 = I.reps.length;
    // What the reviews change, region by region; the totals are their sum.
    const addOf = r => (s.reviews ? Math.round(r.repeaters * s.addRepPct / 100) : 0);
    const remOf = r => (s.reviews ? Math.round(r.repeaters * s.removeRepPct / 100) : 0);
    const added = I.regions.reduce((a, r) => a + addOf(r), 0);
    const removed = I.regions.reduce((a, r) => a + remOf(r), 0);
    const nRep = Math.max(0, nRep0 + added - removed);
    const nBases = s.basesN > 0 ? s.basesN : Math.max(I.radioNetworks, I.registerBases);
    const chains = s.dupBases ? 2 : 1;
    const bb = I.reps.filter(r => r.backbone);
    const own = { bureau: 0, joint: 0, other: 0, unknown: 0 };
    for (const r of bb) own[r.owner.cls]++;
    // Acquisition is negotiated owner by owner — one council's agreement
    // covers all of its sites — so what takes the time is the number of
    // owners. A site with no owner on record is assumed to belong to an owner
    // with as many sites as the known ones average.
    const owners = new Map();
    for (const r of bb) if (r.owner.cls === 'other' || r.owner.cls === 'joint') owners.set(r.owner.name, (owners.get(r.owner.name) || 0) + 1);
    const knownSites = own.other + own.joint;
    const perOwner = owners.size ? knownSites / owners.size : 2;
    const unknownAcq = Math.round(own.unknown * s.unknownAcqPct / 100);
    const nAcq = s.acquireOther ? knownSites + unknownAcq : 0;
    const nOwners = s.acquireOther ? owners.size + Math.ceil(unknownAcq / perOwner) : 0;
    const nRemed = Math.round(bb.length * s.remediatePct / 100);

    // What is bought, in whole units — the equipment table and the spend are
    // both read off these, so they cannot disagree.
    const qField = Math.ceil(nField * spare);
    const qRep = Math.ceil(nRep * spare);
    const baseRx = nBases * chains;
    const qPower = Math.round(nField * s.powerPct / 100);
    const qTest = Math.max(1, s.fieldCrews) + Math.max(1, s.backboneCrews);
    const fieldKit = qField * (s.cErtA2 + s.cKit) + qPower * s.cPower;

    // Monthly ledgers.
    const fte = { field: [], eng: [], pm: [], support: [] };           // person-days
    const cost = { equip: [], labour: [], travel: [], backbone: [], network: [] };
    const acts = [];
    const ms = [];
    const pd = (role, arr) => arr.forEach((v, m) => { if (v) { addInto(fte[role], m, v); addInto(cost.labour, m, v * dayRate[role]); } });

    // Procurement: approval to the first delivery.
    const P = s.procureMonths;
    acts.push({ row: 'procure', label: 'Procurement and supply', start: 0, end: P });
    spread(fte.support, 0, P, 0.5 * WORK_DAYS_MONTH * P);
    spread(cost.labour, 0, P, 0.5 * WORK_DAYS_MONTH * P * dayRate.support);
    ms.push({ at: 0, label: 'Approval' }, { at: P, label: 'First equipment delivered' });

    // Network reviews, region by region in conversion order, on the desk
    // teams; each fixes its network before its field work may start.
    const review = new Map();
    const reviewDays = r => 5 + 0.05 * r.field + 1.0 * r.repeaters + 2 * Math.max(1, r.bases);
    if (s.reviews) {
      const free = Array.from({ length: Math.max(1, s.reviewTeams) }, () => 0);
      for (const name of order) {
        const r = R.get(name);
        const k = free.indexOf(Math.min(...free));
        const L = lane(reviewDays(r), DESK_DAYS_MONTH, free[k]);
        free[k] = L.end;
        review.set(name, L);
        pd('eng', L.by);
        acts.push({ row: 'review', region: name, label: `Review — ${name}`, start: L.start, end: L.end });
      }
    }

    // The backbone: acquisition (a property and legal lane, many at once),
    // then remediation and ALERT2 fit-out on the tower crews.
    const bbStart = s.backboneFirst ? 0 : P;
    const acqEnd = nOwners ? bbStart + s.acqLeadMonths * Math.max(1, nOwners / Math.max(1, s.acqParallel)) : bbStart;
    if (nAcq) {
      acts.push({ row: 'acquire', label: 'Backbone sites acquired', start: bbStart, end: acqEnd });
      spread(cost.backbone, bbStart, acqEnd, nAcq * s.cAcq);
      spread(fte.support, bbStart, acqEnd, 0.5 * WORK_DAYS_MONTH * (acqEnd - bbStart));
      spread(cost.labour, bbStart, acqEnd, 0.5 * WORK_DAYS_MONTH * (acqEnd - bbStart) * dayRate.support);
    }
    // Remediation is contract work — power, masts, enclosures, earthing,
    // access — paid by the site (cRemed), region by region from day one. The
    // ALERT2 fit-out is the Bureau's own tower-qualified crews, region by
    // region once the equipment is in and the pilot has proved it, and once
    // that region's remediation is done.
    const remPerMonth = Math.max(1, s.remedCrews) * s.crewDays;
    const towerPerMonth = Math.max(1, s.backboneCrews) * s.crewDays;
    const remEnd = new Map(), fitEnd = new Map();
    let bbReady = bbStart;
    const towerLabour = (L) => {
      const arr = [];
      L.by.forEach((v, m) => { if (v) arr[m] = v * s.staffPerCrew; });
      pd('field', arr);
      L.by.forEach((v, m) => { if (v) addInto(cost.travel, m, v * s.travelDay); });
    };
    if (s.backboneFirst) {
      let tr = bbStart, tf = P + (s.pilot ? s.pilotMonths : 0);
      for (const name of order) {
        const r = R.get(name);
        const nr = Math.round(r.backbone * s.remediatePct / 100);
        const Lr = lane(nr * s.remediateDays * (r.remote ? s.remoteMult : 1), remPerMonth, tr, wetOf);
        if (nr) {
          acts.push({ row: 'remediate', region: name, label: `Backbone remediation — ${name}`, start: Lr.start, end: Lr.end });
          spread(cost.backbone, Lr.start, Math.max(Lr.end, Lr.start + 0.5), nr * s.cRemed);
        }
        remEnd.set(name, Lr.end);
        tr = Lr.end;
        const n = Math.max(0, r.repeaters + addOf(r) - remOf(r));
        const L = lane(n * s.fitDays * (r.remote ? s.remoteMult : 1), towerPerMonth, Math.max(tf, Lr.end), wetOf);
        if (n) {
          acts.push({ row: 'fit', region: name, label: `Repeaters to ALERT2 — ${name}`, start: L.start, end: L.end });
          towerLabour(L);
        }
        fitEnd.set(name, L.end);
        tf = L.end;
      }
      bbReady = tf;
      ms.push({ at: bbReady, label: 'Backbone on ALERT2' });
      // A contract manager looks after the remediation contracts while they run.
      spread(fte.support, bbStart, tr, 0.3 * WORK_DAYS_MONTH * (tr - bbStart));
      spread(cost.labour, bbStart, tr, 0.3 * WORK_DAYS_MONTH * (tr - bbStart) * dayRate.support);
    }

    // The pilot: one network end to end, in the first region.
    const pilotEnd = s.pilot ? P + s.pilotMonths : P;
    if (s.pilot) {
      acts.push({ row: 'pilot', label: 'Pilot network', start: P, end: pilotEnd });
      spread(fte.eng, P, pilotEnd, WORK_DAYS_MONTH * s.pilotMonths);
      spread(cost.labour, P, pilotEnd, WORK_DAYS_MONTH * s.pilotMonths * dayRate.eng);
      // Its stations are converted by one crew, at the network's average pace.
      const avg = nField ? ((nField - nLevel) * s.rainDays + nLevel * s.levelDays) / nField : s.rainDays;
      const crewDays = Math.min(s.pilotSites, nField) * avg;
      spread(fte.field, P, pilotEnd, crewDays * s.staffPerCrew);
      spread(cost.labour, P, pilotEnd, crewDays * s.staffPerCrew * dayRate.field);
      spread(cost.travel, P, pilotEnd, crewDays * s.travelDay);
      ms.push({ at: pilotEnd, label: 'Pilot accepted' });
    }

    // Bases: an ALERT2 receive chain beside the legacy one, so both run while
    // the field moves over.
    const Lb = lane(nBases * chains * s.baseDays, DESK_DAYS_MONTH, P);
    acts.push({ row: 'bases', label: 'Base stations receive ALERT2', start: Lb.start, end: Lb.end });
    pd('eng', Lb.by);
    Lb.by.forEach((v, m) => addInto(cost.travel, m, v * s.travelDay * 0.5));

    // Field conversion, region by region, on every field crew. Without the
    // backbone first, a region's repeaters are remediated and fitted by the
    // same crews, and none starts before the acquisitions are done.
    const fieldPerMonth = Math.max(1, s.fieldCrews) * s.crewDays;
    const regionRows = [];
    let prev = pilotEnd;
    let pilotLeft = s.pilot ? Math.min(s.pilotSites, nField) : 0;
    const why = [];
    for (const name of order) {
      const r = R.get(name);
      const mult = r.remote ? s.remoteMult : 1;
      const pilotHere = Math.min(pilotLeft, r.field);
      pilotLeft -= pilotHere;
      const share = r.field ? (r.field - pilotHere) / r.field : 0;
      // A station the FWIN program is already visiting to upgrade gets its
      // ERT-A2 on that visit: the crew-days of fitting it, not of getting there.
      const f = s.fwinPct / 100;
      let work = ((r.rain * s.rainDays + r.level * s.levelDays) * mult * (1 - f) + r.field * f * s.fwinDays) * share;
      const nRepHere = Math.max(0, r.repeaters + addOf(r) - remOf(r));
      // Without the backbone first, the field crews fit the region's repeaters
      // themselves, and its remediation is contracted as the region starts.
      const remHere = s.backboneFirst ? 0 : Math.round(r.backbone * s.remediatePct / 100);
      if (!s.backboneFirst) work += nRepHere * s.fitDays * mult;
      const gates = [[regionRows.length ? 'the region before' : (s.pilot ? 'the pilot' : 'the equipment'), prev]];
      if (s.reviews && review.has(name)) gates.push(['its network review', review.get(name).end]);
      if (s.backboneFirst && fitEnd.has(name)) gates.push(['its repeaters on ALERT2', fitEnd.get(name)]);
      if (!s.backboneFirst && nAcq) gates.push(['the backbone acquisitions', acqEnd]);
      const gate = gates.reduce((a, b) => (b[1] > a[1] + 1e-9 ? b : a));
      const st = gate[1];
      if (remHere) addInto(cost.backbone, Math.floor(st), remHere * s.cRemed);
      const L = lane(work, fieldPerMonth, st, wetOf);
      // Field units are bought as the crews use them — in tranches over the
      // region's work, so the spend follows the field; new repeaters are built
      // ahead of the region's conversion.
      const fieldUnits = r.field * spare;
      const kit = nField ? fieldKit * r.field / nField : 0;
      const arr = [];
      L.by.forEach((v, m) => {
        if (!v) return;
        arr[m] = v * s.staffPerCrew;
        addInto(cost.travel, m, v * s.travelDay);
        addInto(cost.equip, Math.max(0, m - 1), work ? kit * v / work : 0);
      });
      if (!work) addInto(cost.equip, Math.floor(st), kit);
      pd('field', arr);
      const addHere = addOf(r), remHere2 = remOf(r);
      addInto(cost.network, Math.floor(Math.max(0, st - 1)), addHere * s.cNewRep + remHere2 * s.cRemove + nRepHere * s.cLicence);
      if (L.end > L.start || work > 0) {
        acts.push({ row: 'field', region: name, label: `Field stations — ${name}`, start: L.start, end: L.end });
      }
      if (gate !== gates[0] && st > prev + 0.05) why.push({ region: name, gate: gate[0], wait: st - prev });
      regionRows.push({
        name, r, review: review.get(name) || null, fit: s.backboneFirst ? { end: fitEnd.get(name) } : null,
        start: L.start, end: L.end, work, gate: gate[0], units: Math.ceil(fieldUnits), nRep: nRepHere, added: addHere, removed: remHere2,
      });
      prev = Math.max(prev, L.end);
    }
    const fieldEnd = prev;
    ms.push({ at: fieldEnd, label: 'Last field station on ALERT2' });

    // Repeater and base equipment, bought on delivery.
    addInto(cost.equip, P, qRep * (s.cErtRep + s.cKit) + baseRx * (s.cErtBase + s.c115e) + nBases * s.cKit + qTest * s.cTestKit);
    addInto(cost.network, P, nBases * s.cLicence);

    // Bench configuration of every unit, ahead of the crews that fit them.
    const units = qField + qRep + baseRx * 2;
    spread(fte.eng, P, Math.max(P + 1, fieldEnd), units * s.benchHours / 7.5);
    spread(cost.labour, P, Math.max(P + 1, fieldEnd), units * s.benchHours / 7.5 * dayRate.eng);

    // Close-out: legacy receivers, encoders and repeaters recovered, the
    // register and licences put right, the lessons written up.
    const lastWork = Math.max(fieldEnd, bbReady, Lb.end, acqEnd);
    // What sets the end date: whichever stream finishes last.
    const critical = [['the field crews reaching the last station', fieldEnd], ['the backbone acquisitions', acqEnd],
                      ['the repeaters going to ALERT2', bbReady], ['the base stations', Lb.end]]
      .reduce((a, b) => (b[1] > a[1] + 1e-9 ? b : a))[0];
    const end = lastWork + s.closeMonths;
    acts.push({ row: 'close', label: 'Legacy ALERT retired, close-out', start: lastWork, end });
    spread(fte.field, lastWork, end, s.closeMonths * s.crewDays * 0.5 * s.staffPerCrew);
    spread(cost.labour, lastWork, end, s.closeMonths * s.crewDays * 0.5 * s.staffPerCrew * dayRate.field);
    ms.push({ at: end, label: 'Program closed' });

    // The project manager and the records officer, the whole way through.
    spread(fte.pm, 0, end, s.pmFte * WORK_DAYS_MONTH * end);
    spread(cost.labour, 0, end, s.pmFte * WORK_DAYS_MONTH * end * dayRate.pm);
    spread(fte.support, P, end, 0.2 * WORK_DAYS_MONTH * (end - P));
    spread(cost.labour, P, end, 0.2 * WORK_DAYS_MONTH * (end - P) * dayRate.support);

    // Totals, contingency on the lot, and the monthly and yearly views.
    const N = Math.ceil(end);
    const sum = arr => arr.reduce((a, v) => a + (v || 0), 0);
    const cats = Object.keys(cost);
    const base = cats.reduce((a, k) => a + sum(cost[k]), 0);
    const contingency = base * s.contingency / 100;
    cost.contingency = [];
    for (let m = 0; m < N; m++) {
      const here = cats.reduce((a, k) => a + (cost[k][m] || 0), 0);
      if (here) cost.contingency[m] = here * s.contingency / 100;
    }
    const fteMonth = [];
    for (let m = 0; m < N; m++) {
      fteMonth.push({ field: (fte.field[m] || 0) / WORK_DAYS_MONTH, eng: (fte.eng[m] || 0) / WORK_DAYS_MONTH,
                      pm: (fte.pm[m] || 0) / WORK_DAYS_MONTH, support: (fte.support[m] || 0) / WORK_DAYS_MONTH });
    }
    const fteYears = {}; for (const k of Object.keys(fte)) fteYears[k] = sum(fte[k]) / WORK_DAYS_YEAR;
    const peak = fteMonth.reduce((a, f) => Math.max(a, f.field + f.eng + f.pm + f.support), 0);
    const fy = new Map();
    for (let m = 0; m < N; m++) { const y = fyOf(s, m); if (!fy.has(y)) fy.set(y, { fy: y, equip: 0, labour: 0, travel: 0, backbone: 0, network: 0, contingency: 0, total: 0 }); }
    for (const k of Object.keys(cost)) {
      cost[k].forEach((v, m) => {
        if (!v) return;
        const y = fyOf(s, m);
        if (!fy.has(y)) fy.set(y, { fy: y, equip: 0, labour: 0, travel: 0, backbone: 0, network: 0, contingency: 0, total: 0 });
        const row = fy.get(y);
        row[k] += v; row.total += v;
      });
    }
    const equipment = [
      { item: 'ELPRO ERT-A2 — field station transmitter', qty: qField, unit: s.cErtA2, note: `${nf(nField)} stations${s.spares ? ` and ${pct(s.spares)} spares` : ''}` },
      { item: 'ELPRO ERT-A2 — repeater (ALERT2 repeat, legacy concentration)', qty: qRep, unit: s.cErtRep, note: `${nf(nRep0)} repeaters${added || removed ? ` ${added ? `+ ${added} added` : ''}${removed ? ` − ${removed} retired` : ''} by the reviews` : ''}${s.spares ? `, ${pct(s.spares)} spares` : ''}` },
      { item: 'ELPRO ERT-A2 — base station receiver', qty: baseRx, unit: s.cErtBase, note: `${nBases} bases × ${chains}` },
      { item: 'ELPRO 115E-2 gateway with ALERT2 licence key', qty: baseRx, unit: s.c115e, note: `${nBases} bases × ${chains}` },
      { item: 'Antenna, coax, surge protection and GPS kit', qty: qField + qRep + nBases, unit: s.cKit, note: 'every site, and the spares' },
      { item: 'Solar panel, regulator and battery upgrade', qty: qPower, unit: s.cPower, note: `${pct(s.powerPct)} of field stations` },
      { item: 'Test set and bench equipment', qty: qTest, unit: s.cTestKit, note: 'one per field and fit-out crew' },
    ];
    equipment.forEach(e => { e.total = e.qty * e.unit; });
    const units2 = { ertA2: equipment.slice(0, 3).reduce((a, e) => a + e.qty, 0), e115: baseRx };
    const breakdown = [
      { k: 'equip', label: 'Equipment', v: sum(cost.equip) },
      { k: 'labour', label: 'Staff time', v: sum(cost.labour) },
      { k: 'travel', label: 'Travel and vehicles', v: sum(cost.travel) },
      { k: 'backbone', label: 'Backbone acquisition and remediation', v: sum(cost.backbone) },
      { k: 'network', label: 'Network changes and licensing', v: sum(cost.network) },
      { k: 'contingency', label: `Contingency (${pct(s.contingency)})`, v: contingency },
    ];

    // What set the pace: the lane whose end is the field's end, said plainly.
    const fieldMonths = regionRows.reduce((a, r) => a + (r.end - r.start), 0);
    const waits = why.reduce((a, w) => a + w.wait, 0);
    return {
      s, order, nField, nLevel, nRain: nField - nLevel, nRep0, nRep, added, removed, nBases, chains, baseRx,
      bbCount: bb.length, own, nAcq, nOwners, nRemed, acqEnd, bbStart, bbReady, pilotEnd, P, fieldEnd, end, months: N,
      acts, ms, regionRows, review, why, waits, fieldMonths, critical,
      fte: fteMonth, fteYears, fteTotal: Object.values(fteYears).reduce((a, v) => a + v, 0), peak,
      cost, base, contingency, total: base + contingency, breakdown, fy: [...fy.values()], equipment, units: units2,
      reviewDays: s.reviews ? [...review.values()].reduce((a, L) => a + L.by.reduce((x, v) => x + (v || 0), 0), 0) : 0,
    };
  }

  // ── 3. the page ───────────────────────────────────────────────────────────

  function outsideHtml() {
    return `<div class="panel">
      <div class="panel-header"><h2>ALERT2 Transition Plan</h2></div>
      <p class="small">A draft plan for management, worked from the station register: the equipment, where the work is,
        the network reviews, the backbone repeaters, the timeline, the effort and the cost of moving the network to ALERT2.</p>
      ${typeof Auth !== 'undefined' && Auth.isSignedIn() ? '<p class="small">This is for administrators only.</p>'
        : '<div class="button-group"><button class="primary" onclick="Auth.open()">🔑 Sign in</button></div>'}
    </div>`;
  }

  function render() {
    let body;
    if (!isAdmin()) body = outsideHtml();
    else if (!state.data) body = '<div class="panel"><p class="small">The station register is still loading — the plan is worked from it.</p></div>';
    else body = headHtml() + `<div id="a2p-kpis">${kpisHtml()}</div>` + controlsHtml() + `<div id="a2p-out" class="stack">${outHtml()}</div>`;
    return `<div class="page a2p-page" style="--page-max:1200px"><h2 class="sr-only">ALERT2 Transition Plan</h2><div class="stack" id="a2p-page">${body}</div></div>`;
  }

  function current() {
    const I = inventory();
    if (!I) return null;
    const M = model(I, sc);
    const D = differs(sc, DEFAULTS) ? model(I, sanitize({ ...DEFAULTS })) : null;
    return { I, M, D };
  }
  // Worked once per scenario: a repaint reads the plan a dozen times.
  let memo = null, memoKey = '';
  function cur() {
    const k = JSON.stringify(sc) + '|' + slsReady;
    if (!memo || memoKey !== k || !inv || inv.data !== state.data) { memo = current(); memoKey = k; }
    return memo;
  }

  function headHtml() {
    const C = cur();
    const asAt = C && C.I.asAt ? ` · register as at ${esc(C.I.asAt)}` : '';
    return `<div class="panel a2p-head">
      <div class="panel-header">
        <h2>🧭 ALERT2 Transition Plan <span class="badge a2p-draft">Draft</span></h2>
        <div class="button-group">
          <button type="button" onclick="Alert2Plan.print()">🖨️ Print or save as PDF</button>
          <button type="button" onclick="Alert2Plan.exportXlsx()">⤓ Workbook</button>
        </div>
      </div>
      <p class="small">A draft for management of moving Flood-Net's ALERT networks to ALERT2 — the equipment, where the work
        is, the network reviews, the backbone repeaters to acquire and remediate first, the timeline, the effort and the
        cost. <strong>Every figure is an estimate</strong>, worked from the station register${asAt} and the scenario
        below; move a slider and the whole plan is worked again.</p>
      <p class="small txt-muted">Listed to administrators only. ${slsReady ? '' : 'Owners and SLS priorities are still loading — the backbone ownership figures fill in when they arrive.'}</p>
    </div>`;
  }

  function delta(now, was, kind) {
    if (was == null) return '';
    const d = now - was;
    const tiny = kind === 'money' ? Math.abs(d) < 5000 : Math.abs(d) < 0.05;
    if (tiny) return '<span class="a2p-delta">same as the proposal</span>';
    const up = d > 0;
    const txt = kind === 'money' ? money(Math.abs(d)) : kind === 'months' ? mo(Math.abs(d)) : nf1(Math.abs(d));
    return `<span class="a2p-delta ${up ? 'a2p-up' : 'a2p-down'}">${up ? '▲' : '▼'} ${txt} ${up ? 'more' : 'less'} than the proposal</span>`;
  }

  function kpisHtml() {
    const C = cur();
    if (!C) return '';
    const { M, D } = C;
    const s = sc;
    const tile = (label, value, sub, d, cls = '') => `<div class="adm-kpi a2p-kpi ${cls}">
        <div class="adm-kpi-label">${label}</div><div class="adm-kpi-value">${value}</div>
        <div class="adm-kpi-sub">${sub}</div>${d ? `<div class="adm-kpi-sub">${d}</div>` : ''}</div>`;
    return `<div class="adm-kpis a2p-kpis" role="group" aria-label="The plan in five figures">
      ${tile('Estimated cost', money(M.total), `including ${pct(s.contingency)} contingency`, D && delta(M.total, D.total, 'money'))}
      ${tile('Duration', mo(M.end), `${monthLabel(s, 0)} to ${endLabel(s, M.end)}`, D && delta(M.end, D.end, 'months'))}
      ${tile('Effort', `${nf1(M.fteTotal)} <small>FTE-years</small>`, `peak ${nf1(M.peak)} FTE`, D && delta(M.fteTotal, D.fteTotal, 'n'))}
      ${tile('Equipment', `${nf(M.units.ertA2)} <small>ERT-A2</small>`, `${nf(M.units.e115)} ELPRO 115E-2 gateways`, D && delta(M.units.ertA2, D.units.ertA2, 'n'))}
      ${tile('Sites', nf(M.nField + M.nRep0 + M.nBases), `${nf(M.nField)} field · ${nf(M.nRep0)} repeaters · ${nf(M.nBases)} bases`, '')}
    </div>`;
  }

  // ── the scenario card ──
  function ctlHtml(c) {
    const id = `a2p-c-${c.k}`;
    const v = sc[c.k];
    if (c.kind === 'switch') {
      return `<label class="check-label a2p-switch"><input type="checkbox" id="${id}" data-k="${c.k}" ${v ? 'checked' : ''}
        onchange="Alert2Plan.set('${c.k}', this.checked)"><span>${esc(c.label)}</span></label>`;
    }
    if (c.kind === 'select') {
      return `<label class="a2p-ctl" for="${id}"><span>${esc(c.label)}</span>
        <select id="${id}" data-k="${c.k}" onchange="Alert2Plan.set('${c.k}', this.value)">
          ${c.options.map(([val, txt]) => `<option value="${val}"${v === val ? ' selected' : ''}>${esc(txt)}</option>`).join('')}
        </select></label>`;
    }
    if (c.kind === 'month') {
      return `<label class="a2p-ctl" for="${id}"><span>${esc(c.label)}</span>
        <input type="month" id="${id}" data-k="${c.k}" value="${escAttr(v)}" onchange="Alert2Plan.set('${c.k}', this.value)"></label>`;
    }
    return `<label class="a2p-ctl" for="${id}"><span>${esc(c.label)} <output id="${id}-o" class="a2p-out-v">${esc(ctlValue(c, v))}</output></span>
      <input type="range" id="${id}" data-k="${c.k}" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}"
             oninput="Alert2Plan.set('${c.k}', this.value)" aria-valuetext="${escAttr(ctlValue(c, v))}"></label>`;
  }
  function ctlValue(c, v) {
    if (c.zero && Number(v) === 0) {
      const I = inventory();
      return I ? `${Math.max(I.radioNetworks, I.registerBases)}, ${c.zero}` : c.zero;
    }
    return `${Number.isInteger(c.step) ? nf(v) : nf1(v)}${c.unit || ''}`;
  }

  function controlsHtml() {
    const changed = differs(sc, DEFAULTS);
    return `<section class="panel a2p-controls" aria-labelledby="a2p-ctl-h">
      <div class="panel-header"><h3 id="a2p-ctl-h">🎛️ Try it another way</h3>
        <div class="button-group">
          ${PRESETS.map(p => `<button type="button" class="exp-btn-sm" onclick="Alert2Plan.preset('${p.id}')">${esc(p.label)}</button>`).join('')}
        </div></div>
      <p class="small">Every slider and switch works the plan again at once — the figures above and the document below.
        ${changed ? '<strong>This is not the proposal</strong>: the five figures say how far it moved.' : 'This is the proposal as drafted.'}
        Your scenario is kept on this device only.</p>
      <div class="a2p-ctl-grid">
        ${CONTROLS.map(g => `<fieldset class="a2p-fs"><legend>${esc(g.group)}</legend>${g.items.map(ctlHtml).join('')}</fieldset>`).join('')}
      </div>
      <details class="a2p-rates">
        <summary>Unit costs and rates (AUD, excluding GST)</summary>
        <div class="a2p-rate-grid">
          ${RATES.map(r => `<label class="a2p-ctl" for="a2p-r-${r.k}"><span>${esc(r.label)}</span>
            <input type="number" id="a2p-r-${r.k}" data-k="${r.k}" min="0" step="50" value="${sc[r.k]}" inputmode="numeric"
                   onchange="Alert2Plan.set('${r.k}', this.value)"></label>`).join('')}
        </div>
        <p class="small txt-muted">Indicative figures for planning, not quotes — see Sources. A supplier's quote replaces them.</p>
      </details>
    </section>`;
  }

  // ── the document ──
  function outHtml() {
    const C = cur();
    if (!C) return '';
    return [summaryHtml(C), whyHtml(), whereHtml(C), equipmentHtml(C), backboneHtml(C), reviewsHtml(C),
            timelineHtml(C), effortHtml(C), costHtml(C), risksHtml(C), decisionsHtml(C), sourcesHtml()].join('');
  }

  function sec(id, title, body) {
    return `<section class="panel a2p-sec" aria-labelledby="a2p-${id}-h"><h3 id="a2p-${id}-h">${title}</h3>${body}</section>`;
  }

  function summaryHtml({ I, M }) {
    const s = sc;
    const regions = I.regions.length;
    const slow = M.why.slice().sort((a, b) => b.wait - a.wait)[0];
    const ends = `What sets the end date is <strong>${M.critical}</strong>${M.critical.includes('acquisitions')
      ? ` — ${nf(M.nOwners)} owners, ${s.acqParallel} at a time; more negotiated at once would bring it in` : ''}. `;
    const pace = slow && M.waits > 1
      ? `The field crews wait about ${mo(M.waits)} in all for other work to be ready — longest in ${esc(slow.region)}, for ${esc(slow.gate)} — so ${
          slow.gate.includes('review') ? 'another review team' : slow.gate.includes('repeaters') ? 'another tower crew' : 'faster acquisition'} would shorten it.`
      : `The field crews set the pace: ${s.fieldCrews} crew${s.fieldCrews === 1 ? '' : 's'} take about ${mo(M.fieldMonths)} to reach every station, and nothing else holds them up.`;
    return sec('sum', '1. Summary', `
      <p>The register lists <strong>${nf(M.nField)} ALERT field stations</strong> (${nf(M.nRain)} rainfall, ${nf(M.nLevel)} river height),
        <strong>${nf(M.nRep0)} repeaters</strong> — ${nf(M.bbCount)} of them carrying the backbone — and the network is received at
        <strong>${nf(M.nBases)} base stations</strong>, across ${regions} region${regions === 1 ? '' : 's'} and ${nf(I.catchmentCount)} catchments.
        This draft moves all of them from legacy ALERT to ALERT2.</p>
      <ul class="a2p-points">
        <li><strong>Cost:</strong> about <strong>${money(M.total)}</strong>, including ${pct(s.contingency)} contingency — ${money(M.breakdown[0].v)} of it equipment.</li>
        <li><strong>Time:</strong> about <strong>${mo(M.end)}</strong>, from approval in ${monthLabel(s, 0)} to close-out in ${endLabel(s, M.end)}.</li>
        <li><strong>Effort:</strong> <strong>${nf1(M.fteTotal)} FTE-years</strong>, peaking at ${nf1(M.peak)} FTE — ${nf1(M.fteYears.field)} of them in the field.</li>
        <li><strong>Equipment:</strong> ${nf(M.units.ertA2)} ELPRO ERT-A2 units (field, repeater and base) and ${nf(M.units.e115)} ELPRO 115E-2 gateways.</li>
        <li><strong>Backbone first:</strong> ${M.nAcq ? `acquire about ${nf(M.nAcq)} backbone repeater site${M.nAcq === 1 ? '' : 's'} the Bureau does not own, from about ${nf(M.nOwners)} owner${M.nOwners === 1 ? '' : 's'}, and ` : ''}remediate about
          ${nf(M.nRemed)}, starting ${s.backboneFirst ? 'now — none of it needs ALERT2 equipment' : `with the equipment in ${monthLabel(s, M.P)}`}.</li>
        ${s.reviews ? `<li><strong>Network reviews:</strong> each region's network is reviewed before it is converted — expected to add about ${M.added} repeater${M.added === 1 ? '' : 's'} and retire about ${M.removed}.</li>` : ''}
        ${s.fwinPct ? `<li><strong>With FWIN:</strong> about ${nf(M.nField * s.fwinPct / 100)} field stations (${pct(s.fwinPct)}) take their ERT-A2 on a visit the Bureau's FWIN upgrade program is already making, rather than one of their own.</li>` : ''}
      </ul>
      <p>${ends}${pace}</p>
      <p class="small txt-muted">An estimate for planning (in the order of −30% to +50%), not a quote. The quantities are counted from the register,
        so they are as good as it is; the rates and durations are the draft's proposals and can be changed above.</p>`);
  }

  function whyHtml() {
    return sec('why', '2. Why ALERT2, and why now', `
      <p>Legacy ALERT sends each reading as a short burst at 300 baud, whenever a station has something to say. Nothing stops
        two stations transmitting at once, so as a network grows — and above all in a storm, when every gauge is reporting —
        bursts collide and are lost, or arrive corrupted on the wrong address; Flood-Net's Ghosting Graph and Bit Flipper exist
        because of it. A burst carries one value from 0 to 2,047 for one of 8,192 addresses, with no error correction and no time
        of observation. The Bureau's own <em>Flood Warning Infrastructure Standard</em> (2019) gives ALERT1 messages as its example
        of data that does not meet its requirement for time-stamped, self-describing observations.<sup><a href="#a2p-ref-std">[6]</a></sup></p>
      <p><strong>ALERT2</strong> is the open successor maintained by the US National Hydrologic Warning Council's ALERT2 Technical
        Working Group, on which the Bureau is represented. It runs at 4,800 bit/s with forward error correction; stations and
        repeaters transmit in their own GPS-timed slots (TDMA), so they do not collide; each message is time-stamped at the source,
        carries up to five sensor reports, and addresses 65,535 sites of up to 255 sensors each.<sup><a href="#a2p-ref-or">[1]</a></sup>
        After Harris County (Texas) converted 150 stations, the share of reports received in critical events went from about 65% to
        99.8%;<sup><a href="#a2p-ref-hc">[2]</a></sup> a 2018 trial in South East Queensland raised reception by up to 15% at some
        stations.<sup><a href="#a2p-ref-wp">[4]</a></sup></p>
      <p>Crucially for a staged change, an ALERT2 repeater also hears legacy ALERT and <em>concentrates</em> it into ALERT2, so the
        backbone can move first and the field stations follow as budget and visits allow — the order the NHWC has recommended since
        2010 and US agencies have followed: bases, then repeaters, then gauges.<sup><a href="#a2p-ref-or">[1]</a><a href="#a2p-ref-nhwc">[3]</a></sup></p>
      <p>The equipment is made in Brisbane. ELPRO Technologies' <strong>ERT-A2</strong> is one unit that is the field transmitter,
        the repeater and the base receiver, on a connector wired like the ALERT1 canister it replaces; the <strong>115E-2</strong>
        gateway takes ALERT1 and ALERT2 from a base receiver onto the data network.<sup><a href="#a2p-ref-ert">[5]</a></sup> Flood-Net
        already decodes ALERT2, has taken readings from a 115E-2 trial and the workshop's ERT-A2, and stores them — the data side is
        proven before the radio side starts.</p>
      <h4>How it fits with FWIN</h4>
      <p>The Bureau's Flood Warning Infrastructure Network program — up to $236 million over ten years from 2023 — is taking
        ownership of priority gauges from their owners and upgrading them. In Queensland that is about 1,100 sites from 62 council
        owners across 47 catchments, about 1,000 of them upgraded by June 2029; as at October 2026, 343 sites had been acquired and
        125 were in remediation.<sup><a href="#a2p-ref-fwin">[7]</a></sup> The Bureau's 2024 tender for rainfall station upgrades
        already specifies ALERT2-compatible equipment and a GPS antenna.<sup><a href="#a2p-ref-rft">[8]</a></sup> So the transition is
        not a second program across the same sites: every FWIN visit is a chance to fit an ERT-A2 (the card's FWIN slider), and the
        backbone acquisitions are with the same councils, under the same kind of agreement.</p>`);
  }

  // ── where the work is ──
  function regionVar(name) { return REGION_VAR[name] ? `var(--maps-region-${REGION_VAR[name]})` : 'var(--muted)'; }

  function whereHtml({ I, M }) {
    const s = sc;
    const rows = M.regionRows;
    const tbl = `<div class="table-wrap"><table class="a2p-table">
      <caption class="sr-only">Stations, repeaters and bases by region, in the order they are converted</caption>
      <colgroup><col style="--w:3.5rem"><col style="--w:14rem"><col span="6"><col style="--w:6rem"></colgroup>
      <thead><tr><th scope="col">Order</th><th scope="col">Region</th><th scope="col" class="a2p-num">Rainfall</th>
        <th scope="col" class="a2p-num">River</th><th scope="col" class="a2p-num">Repeaters</th><th scope="col" class="a2p-num">Backbone</th>
        <th scope="col" class="a2p-num">Bases</th><th scope="col" class="a2p-num col-optional">SLS High</th><th scope="col">Move</th></tr></thead>
      <tbody>${rows.map((x, i) => `<tr>
        <td>${i + 1}</td>
        <th scope="row"><span class="a2p-swatch" style="--c:${regionVar(x.name)}" aria-hidden="true"></span>${esc(x.name)}${x.r.remote ? ' <span class="small txt-muted">remote</span>' : ''}</th>
        <td class="a2p-num">${nf(x.r.rain)}</td><td class="a2p-num">${nf(x.r.level)}</td><td class="a2p-num">${nf(x.r.repeaters)}</td>
        <td class="a2p-num">${nf(x.r.backbone)}</td><td class="a2p-num">${nf(x.r.bases)}</td><td class="a2p-num col-optional">${slsReady ? nf(x.r.high) : '…'}</td>
        <td><span class="button-group a2p-move">
          <button type="button" class="exp-btn-sm" data-k="up:${escAttr(x.name)}" onclick="Alert2Plan.move(${i}, -1)" ${i === 0 ? 'disabled' : ''} aria-label="Convert ${escAttr(x.name)} earlier">▲</button>
          <button type="button" class="exp-btn-sm" data-k="down:${escAttr(x.name)}" onclick="Alert2Plan.move(${i}, 1)" ${i === rows.length - 1 ? 'disabled' : ''} aria-label="Convert ${escAttr(x.name)} later">▼</button>
        </span></td></tr>`).join('')}
        <tr class="a2p-total"><td></td><th scope="row">All</th><td class="a2p-num">${nf(M.nRain)}</td><td class="a2p-num">${nf(M.nLevel)}</td>
          <td class="a2p-num">${nf(M.nRep0)}</td><td class="a2p-num">${nf(M.bbCount)}</td><td class="a2p-num">${nf(I.registerBases)}</td>
          <td class="a2p-num col-optional">${slsReady ? nf(I.regions.reduce((a, r) => a + r.high, 0)) : '…'}</td><td></td></tr>
      </tbody></table></div>`;
    const catRows = rows.flatMap(x => [...x.r.cats.values()].sort((a, b) => (b.rain + b.level + b.repeaters) - (a.rain + a.level + a.repeaters))
      .map(c => `<tr><td>${esc(x.name)}</td><th scope="row">${esc(c.name)}</th><td class="a2p-num">${nf(c.rain)}</td><td class="a2p-num">${nf(c.level)}</td>
        <td class="a2p-num">${nf(c.repeaters)}</td><td class="a2p-num">${nf(c.backbone)}</td><td class="a2p-num">${nf(c.bases)}</td></tr>`));
    return sec('where', '3. Where the work is', `
      <p>${nf(M.nField)} field stations and ${nf(M.nRep0)} repeaters in ${I.regions.length} regions and ${nf(I.catchmentCount)} catchments, converted one region at a time in the order below
        (▲ ▼ change it — the timeline follows). The order proposed puts the regions with the most High-priority SLS sites first;
        ${s.pilot ? `the pilot network is the first ${nf(Math.min(s.pilotSites, M.nField))} stations of the first region.` : 'there is no pilot in this scenario.'}
        Base stations are counted from the register's ${I.radioNetworks} radio networks${sc.basesN ? ` — overridden on the card to ${sc.basesN}` : ''};
        the register marks ${I.registerBases} site${I.registerBases === 1 ? '' : 's'} with the base role.</p>
      <div class="a2p-two">
        ${mapSvg(I, M)}
        ${regionBarsSvg(M)}
      </div>
      ${tbl}
      <details class="a2p-more"><summary>Every catchment (${catRows.length})</summary>
        <div class="table-wrap medium" role="region" tabindex="0" aria-label="Stations by catchment"><table class="a2p-table">
          <caption class="sr-only">Stations, repeaters and bases by catchment</caption>
          <thead><tr><th scope="col">Region</th><th scope="col">Catchment</th><th scope="col" class="a2p-num">Rainfall</th><th scope="col" class="a2p-num">River</th>
            <th scope="col" class="a2p-num">Repeaters</th><th scope="col" class="a2p-num">Backbone</th><th scope="col" class="a2p-num">Bases</th></tr></thead>
          <tbody>${catRows.join('')}</tbody></table></div></details>`);
  }

  // The basins, parsed once out of Radio Path Maps' georeferenced drawing.
  function basinShapes() {
    if (basins) return basins;
    const svg = typeof MegaNetMaps !== 'undefined' ? MegaNetMaps.QLD_BASIN_SVG : '';
    const out = [];
    const re = /<polygon points="([^"]+)"><title>([^<]+)<\/title>/g;
    let m, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    while ((m = re.exec(svg))) {
      const pts = m[1].trim().split(/\s+/).map(p => p.split(',').map(Number));
      for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      out.push({ name: m[2], points: m[1] });
    }
    basins = { list: out, box: out.length ? [x0, y0, x1, y1] : null };
    return basins;
  }
  function project(lat, lon) {
    const g = typeof MegaNetMaps !== 'undefined' ? MegaNetMaps.BASIN_GEOREF : null;
    if (!g) return null;
    const det = g.ax * g.by - g.bx * g.ay;
    const u = lon - g.cx, v = lat - g.cy;
    return [(u * g.by - g.bx * v) / det, (g.ax * v - g.ay * u) / det];
  }

  function mapSvg(I, M) {
    const B = basinShapes();
    if (!B.box) return '';
    const [x0, y0, x1, y1] = B.box;
    const pad = 12, w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
    const regionOfBasin = new Map((state.data.catchments || []).map(c => [c.name.toLowerCase(), c.region]));
    const active = new Set(I.regions.map(r => r.name));
    const polys = B.list.map(b => {
      const reg = regionOfBasin.get(b.name.toLowerCase());
      const on = reg && active.has(reg);
      return `<polygon class="a2p-basin${on ? '' : ' a2p-basin-off'}" points="${b.points}"${on ? ` style="--c:${regionVar(reg)}"` : ''}/>`;
    }).join('');
    const pt = (s) => project(s.lat, s.lon);
    const inBox = p => p && p[0] >= x0 - pad && p[0] <= x1 + pad && p[1] >= y0 - pad && p[1] <= y1 + pad;
    const lines = I.links.map(l => {
      const a = pt(l.a), b = pt(l.b);
      return inBox(a) && inBox(b) ? `<line class="a2p-link" x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}"/>` : '';
    }).join('');
    const dots = I.field.map(f => { const p = pt(f.s); return inBox(p) ? `<circle class="a2p-dot${f.level ? ' a2p-dot-lvl' : ''}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${f.level ? 2.6 : 2}"/>` : ''; }).join('');
    const tri = I.reps.map(r => {
      const p = pt(r.s); if (!inBox(p)) return '';
      const [x, y] = p, k = r.backbone ? 7 : 5;
      return `<polygon class="a2p-rep${r.backbone ? ' a2p-rep-bb' : ''}" points="${x.toFixed(1)},${(y - k).toFixed(1)} ${(x - k * 0.87).toFixed(1)},${(y + k * 0.5).toFixed(1)} ${(x + k * 0.87).toFixed(1)},${(y + k * 0.5).toFixed(1)}"/>`;
    }).join('');
    const sq = I.bases.map(b => { const p = pt(b.s); return inBox(p) ? `<rect class="a2p-base" x="${(p[0] - 6).toFixed(1)}" y="${(p[1] - 6).toFixed(1)}" width="12" height="12"/>` : ''; }).join('');
    const name = `Where the work is: ${nf(M.nField)} field stations, ${nf(M.nRep0)} repeaters (${nf(M.bbCount)} backbone) and ${nf(I.registerBases)} bases in the register, across ${I.regions.length} regions`;
    return `<figure class="a2p-fig">
      <svg class="a2p-map" viewBox="${(x0 - pad).toFixed(0)} ${(y0 - pad).toFixed(0)} ${w.toFixed(0)} ${h.toFixed(0)}" role="img" aria-labelledby="a2p-map-t a2p-map-d">
        <title id="a2p-map-t">${esc(name)}</title>
        <desc id="a2p-map-d">Queensland's drainage basins coloured by region; dots are field stations (larger for river heights), triangles repeaters (bold for backbone), squares bases, and lines the backbone hops. The table below lists the same by region.</desc>
        <g>${polys}</g><g>${lines}</g><g>${dots}</g><g>${tri}</g><g>${sq}</g>
      </svg>
      <figcaption class="small txt-muted">Basins coloured by region, as on Radio Path Maps. ● field station (larger: river height) · ▲ repeater (bold: backbone) · ■ base · lines: backbone hops within ${sc.backboneKm} km.</figcaption>
    </figure>`;
  }

  function regionBarsSvg(M) {
    const rows = M.regionRows;
    if (!rows.length) return '';
    const max = Math.max(...rows.map(x => x.r.rain + x.r.level + x.r.repeaters + x.r.bases), 1);
    const W = 420, L = 150, rowH = 26, H = rows.length * rowH + 40;
    const sc2 = v => v / max * (W - L - 40);
    const segs = [['rain', 'Rainfall stations', 'a2p-s1'], ['level', 'River stations', 'a2p-s2'], ['repeaters', 'Repeaters', 'a2p-s3'], ['bases', 'Bases', 'a2p-s4']];
    const bars = rows.map((x, i) => {
      let at = L;
      const y = 10 + i * rowH;
      const parts = segs.map(([k, , cls]) => {
        const w = sc2(x.r[k]);
        const r = w > 0 ? `<rect class="${cls}" x="${at.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${rowH - 8}"/>` : '';
        at += w;
        return r;
      }).join('');
      const tot = x.r.rain + x.r.level + x.r.repeaters + x.r.bases;
      return `<text class="a2p-axis" x="${L - 6}" y="${y + rowH / 2}" text-anchor="end">${esc(x.name)}</text>${parts}<text class="a2p-axis" x="${(at + 4).toFixed(1)}" y="${y + rowH / 2}">${nf(tot)}</text>`;
    }).join('');
    const legY = 10 + rows.length * rowH + 8;
    const legend = segs.map(([, label, cls], i) => `<rect class="${cls}" x="${L + i * 70}" y="${legY}" width="10" height="10"/><text class="a2p-axis" x="${L + i * 70 + 14}" y="${legY + 9}">${label.split(' ')[0]}</text>`).join('');
    const biggest = rows.slice().sort((a, b) => (b.r.rain + b.r.level) - (a.r.rain + a.r.level))[0];
    return `<figure class="a2p-fig">
      <svg class="a2p-bars" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="a2p-bars-t">
        <title id="a2p-bars-t">Sites by region — ${esc(biggest.name)} has the most field stations, ${nf(biggest.r.rain + biggest.r.level)}</title>
        ${bars}${legend}
      </svg>
      <figcaption class="small txt-muted">Sites by region, in conversion order: rainfall, river, repeaters and bases. The table beside lists the figures.</figcaption>
    </figure>`;
  }

  function equipmentHtml({ M }) {
    const tot = M.equipment.reduce((a, e) => a + e.total, 0);
    return sec('equip', '4. Equipment', `
      <p>One ELPRO ERT-A2 goes to every field station, every repeater and every base receive chain; one ELPRO 115E-2 sits
        behind each base receiver as its gateway to the data network (its ALERT2 gateway needs a licence key and firmware 2.33 or later).
        River stations keep their level sensors, which the ERT-A2 reads. The quantities follow the card.</p>
      <div class="table-wrap"><table class="a2p-table">
        <caption class="sr-only">Equipment to buy</caption>
        <thead><tr><th scope="col">Item</th><th scope="col" class="a2p-num">Quantity</th><th scope="col" class="a2p-num">Each</th>
          <th scope="col" class="a2p-num">Total</th><th scope="col" class="col-optional">Basis</th></tr></thead>
        <tbody>${M.equipment.map(e => `<tr><th scope="row">${esc(e.item)}</th><td class="a2p-num">${nf(e.qty)}</td>
          <td class="a2p-num">${money(e.unit, true)}</td><td class="a2p-num">${money(e.total, true)}</td><td class="col-optional small">${esc(e.note)}</td></tr>`).join('')}
          <tr class="a2p-total"><th scope="row">Equipment</th><td></td><td></td><td class="a2p-num">${money(tot, true)}</td><td class="col-optional"></td></tr>
        </tbody></table></div>
      <p class="small txt-muted">Before contingency. Prices are indicative planning figures, not quotes — they are the card's to change.</p>`);
  }

  // ── backbone ──
  const OWN = { bureau: 'The Bureau', joint: 'The Bureau with another owner', other: 'A council or another owner', unknown: 'No owner on record' };
  function backboneHtml({ I, M }) {
    const s = sc;
    const bb = I.reps.filter(r => r.backbone).sort((a, b) => (b.carries - a.carries) || a.s.name.localeCompare(b.s.name));
    const total = bb.length || 1;
    const segs = ['bureau', 'joint', 'other', 'unknown'];
    let at = 0;
    const W = 600;
    const bar = segs.map((k, i) => {
      const w = M.own[k] / total * W;
      const r = w > 0 ? `<rect class="a2p-own-${k}" x="${at.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="28"/>` : '';
      const t = w > 34 ? `<text class="a2p-own-t" x="${(at + w / 2).toFixed(1)}" y="19" text-anchor="middle">${M.own[k]}</text>` : '';
      at += w;
      return r + t;
    }).join('');
    const legend = segs.map(k => `<li><span class="a2p-swatch a2p-own-${k}" aria-hidden="true"></span>${esc(OWN[k])}: <strong>${M.own[k]}</strong></li>`).join('');
    const top = bb.slice(0, 25);
    const row = r => `<tr><th scope="row">${esc(r.s.name)}</th><td>${esc(r.p.region)}</td><td class="a2p-num">${nf(r.carries)}</td>
      <td>${esc(r.owner.name || OWN[r.owner.cls])}</td><td class="col-optional">${r.s.repeater && r.s.repeater.acma_licence ? esc(r.s.repeater.acma_licence) : '<span class="txt-warn">none on file</span>'}</td></tr>`;
    const head = `<thead><tr><th scope="col">Repeater</th><th scope="col">Region</th><th scope="col" class="a2p-num">Stations carried</th>
      <th scope="col">Owner</th><th scope="col" class="col-optional">ACMA licence</th></tr></thead>`;
    const noLicence = bb.filter(r => !(r.s.repeater && r.s.repeater.acma_licence)).length;
    return sec('bb', '5. Backbone repeaters — acquire and remediate them first', `
      <p>The backbone is the chain of hilltop repeaters every reading travels along to reach a base — by the register,
        <strong>${nf(M.bbCount)} of the ${nf(M.nRep0)} repeaters</strong> share a pass-range window with another repeater or a base
        within ${s.backboneKm} km. Whatever happens in the field, these sites carry it, legacy and ALERT2 alike. The plan treats them as a
        stream of work of their own that can, and should, start ahead of everything else:</p>
      <ol class="a2p-points">
        <li><strong>It needs no ALERT2 equipment.</strong> Acquisition is property and legal work; remediation is power, masts,
          enclosures, earthing and access. Both can start on approval — or before it, from existing budgets.</li>
        <li><strong>The Bureau cannot upgrade, licence or maintain a site it does not control.</strong> ${slsReady
          ? `By the SLS and the register, ${M.own.bureau} backbone site${M.own.bureau === 1 ? ' is' : 's are'} the Bureau's, ${M.own.joint} shared,
             ${M.own.other} another owner's — mostly councils — and ${M.own.unknown} ha${M.own.unknown === 1 ? 's' : 've'} no owner on record.`
          : 'Ownership is still loading from the SLS.'}
          Acquisition has the longest lead time of anything in the plan — an owner's agreement is assumed to take ${s.acqLeadMonths} months — so it has to start first,
          and FWIN is already negotiating with most of the same councils for their gauges.</li>
        <li><strong>An ALERT2 repeater concentrates legacy ALERT.</strong> Once a repeater is an ERT-A2, the legacy stations it hears
          reach the base over ALERT2 — the backbone can move before a single field station does, and the field work can go at its own pace.</li>
        <li><strong>It is where the network is weakest.</strong> The 2015 review of Queensland's flood warning gauge network found
          relay failure — masts, birds, water — to be the network's largest vulnerability, repeaters rarely visited, and little on
          record of where they are or how they were designed.<sup><a href="#a2p-ref-kbr">[9]</a></sup></li>
        <li><strong>It de-risks the rest.</strong> A sound, owned, licensed backbone is what the network reviews plan around, and what
          a field crew needs working before it converts the stations behind it.</li>
      </ol>
      <figure class="a2p-fig">
        <svg class="a2p-own" viewBox="0 0 ${W} 28" preserveAspectRatio="none" role="img" aria-labelledby="a2p-own-t">
          <title id="a2p-own-t">Who owns the ${nf(M.bbCount)} backbone repeaters: the Bureau ${M.own.bureau}, shared ${M.own.joint}, another owner ${M.own.other}, none on record ${M.own.unknown}</title>
          ${bar}
        </svg>
        <figcaption><ul class="a2p-legend">${legend}</ul></figcaption>
      </figure>
      <p>Under this scenario: <strong>${nf(M.nAcq)} site${M.nAcq === 1 ? '' : 's'} acquired</strong>
        ${M.nAcq ? `from about ${nf(M.nOwners)} owner${M.nOwners === 1 ? '' : 's'} — one agreement an owner, ${s.acqParallel} negotiated at once, ${s.acqLeadMonths} months each — finishing ${endLabel(s, M.acqEnd)}` : ''}; <strong>${nf(M.nRemed)} remediated</strong>
        (${pct(s.remediatePct)} of the backbone)${s.backboneFirst ? `, and every repeater on ALERT2 by ${endLabel(s, M.bbReady)}` : ''}.
        ${noLicence ? `${noLicence} backbone repeater${noLicence === 1 ? ' has' : 's have'} no ACMA licence on file in the register — each needs one confirmed, or applied for, before it transmits ALERT2.` : ''}</p>
      <div class="table-wrap"><table class="a2p-table">
        <caption>The backbone repeaters carrying the most stations${bb.length > top.length ? ` — ${top.length} of ${bb.length}` : ''}</caption>
        ${head}<tbody>${top.map(row).join('')}</tbody></table></div>
      ${bb.length > top.length ? `<details class="a2p-more"><summary>All ${bb.length} backbone repeaters</summary>
        <div class="table-wrap medium" role="region" tabindex="0" aria-label="All backbone repeaters"><table class="a2p-table">
          <caption class="sr-only">Every backbone repeater</caption>${head}<tbody>${bb.map(row).join('')}</tbody></table></div></details>` : ''}`);
  }

  // ── reviews ──
  function reviewsHtml({ M }) {
    const s = sc;
    const rows = M.regionRows.filter(x => x.review);
    return sec('rev', '6. Network reviews', `
      <p>Before a network is converted it is reviewed: is every station heard by two repeaters with margin to spare, are there
        repeaters doing nothing, hills that would do better, a base that needs a partner? ALERT2 changes the answers — every repeat
        takes a TDMA slot, so long repeater chains cost airtime they did not cost before — and the conversion visit is the cheapest
        moment to act on them. Flood-Net's <button type="button" class="link-btn" onclick="switchTab('review')">Network Review</button> tab
        does the desk half: the fade margin from every station to every repeater, base or proposed site, beside what the
        attenuator measured on site. The reviews check each network against its design principles:</p>
      <ul class="a2p-cols">
        <li>two gateways to the data network, one of them hardened</li>
        <li>two good paths from every station</li>
        <li>fade margin 15 dB or more; 6 dB the floor</li>
        <li>short repeater chains — every hop is a slot</li>
        <li>one frequency to a network</li>
        <li>networks drawn for radio, not for rivers</li>
        <li>standard builds, one good repeater per mast</li>
        <li>licensed before it transmits, backbone hops included</li>
        <li>the right channel for each site — radio, satellite or mobile</li>
      </ul>
      <p>Each review ends in decisions: repeaters to add, move or retire; bases to add; the frequency and slot plan; the licences
        to apply for. ${s.reviews
          ? `This scenario expects the reviews to <strong>add about ${M.added}</strong> repeater${M.added === 1 ? '' : 's'} and <strong>retire about ${M.removed}</strong>,
             takes ${nf(M.reviewDays)} engineer-days on ${s.reviewTeams} team${s.reviewTeams === 1 ? '' : 's'}, and runs each region's review ahead of its field work:`
          : '<strong>This scenario skips the reviews</strong>: the network is converted as it stands, which is quicker and cheaper and carries today\'s weaknesses into ALERT2.'}</p>
      ${rows.length ? `<div class="table-wrap"><table class="a2p-table">
        <caption class="sr-only">Network review schedule by region</caption>
        <thead><tr><th scope="col">Region</th><th scope="col">Review</th><th scope="col" class="a2p-num">Engineer-days</th>
          <th scope="col" class="a2p-num">Repeaters added</th><th scope="col" class="a2p-num">Retired</th><th scope="col">Field work may start</th></tr></thead>
        <tbody>${rows.map(x => `<tr><th scope="row">${esc(x.name)}</th><td>${monthLabel(s, x.review.start)} – ${endLabel(s, x.review.end)}</td>
          <td class="a2p-num">${nf(x.review.by.reduce((a, v) => a + (v || 0), 0))}</td><td class="a2p-num">${x.added}</td><td class="a2p-num">${x.removed}</td>
          <td>${monthLabel(s, x.start)}</td></tr>`).join('')}</tbody></table></div>` : ''}`);
  }

  // ── timeline ──
  const ROWS = [
    ['procure', 'Procurement and supply'], ['review', 'Network reviews'], ['acquire', 'Backbone sites acquired'],
    ['remediate', 'Backbone remediation'], ['fit', 'Repeaters to ALERT2'], ['pilot', 'Pilot network'],
    ['bases', 'Bases receive ALERT2'], ['field', 'Field stations to ALERT2'], ['close', 'Legacy retired, close-out'],
  ];
  function ganttSvg(M) {
    const s = sc;
    const rows = ROWS.filter(([k]) => M.acts.some(a => a.row === k));
    const N = Math.max(12, Math.ceil(M.end));
    const L = 170, W = 980, top = 34, rowH = 30, H = top + rows.length * rowH + 18;
    const x = m => L + (m / N) * (W - L - 10);
    let grid = '';
    // The wet season, where it slows the field, shaded behind everything.
    if (s.wet) {
      for (let m = 0; m < N; m++) {
        const c = calOf(s, m).m;
        if (c === 11 || c <= 2) grid += `<rect class="a2p-wet" x="${x(m).toFixed(1)}" y="${top - 4}" width="${(x(m + 1) - x(m)).toFixed(1)}" height="${rows.length * rowH + 4}"/>`;
      }
    }
    for (let m = 0; m <= N; m++) {
      const c = calOf(s, m);
      if (c.m === 0 || m === 0) {
        grid += `<line class="a2p-grid" x1="${x(m).toFixed(1)}" y1="${top - 14}" x2="${x(m).toFixed(1)}" y2="${top + rows.length * rowH}"/>`;
        if (m < N) grid += `<text class="a2p-axis" x="${(x(m) + 3).toFixed(1)}" y="${top - 18}">${c.y}</text>`;
      } else if (c.m === 6) {
        grid += `<line class="a2p-grid a2p-grid-fy" x1="${x(m).toFixed(1)}" y1="${top - 6}" x2="${x(m).toFixed(1)}" y2="${top + rows.length * rowH}"/>`;
      }
    }
    const bars = rows.map(([k, label], i) => {
      const y = top + i * rowH;
      const acts = M.acts.filter(a => a.row === k);
      const b = acts.map(a => {
        const w = Math.max(2, x(a.end) - x(a.start));
        const style = a.region ? ` style="--c:${regionVar(a.region)}"` : '';
        return `<rect class="a2p-bar a2p-bar-${k}${a.region ? ' a2p-bar-reg' : ''}"${style} x="${x(a.start).toFixed(1)}" y="${y + 6}" width="${w.toFixed(1)}" height="${rowH - 12}" rx="3"><title>${esc(a.label)}: ${monthLabel(s, a.start)} – ${endLabel(s, a.end)}</title></rect>`;
      }).join('');
      return `<text class="a2p-axis a2p-rowlab" x="${L - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${label}</text>${b}`;
    }).join('');
    const marks = M.ms.map(m => {
      const cx = x(m.at), cy = top + rows.length * rowH + 8;
      return `<path class="a2p-ms" d="M${cx.toFixed(1)} ${cy - 6} l6 6 l-6 6 l-6 -6 z"><title>${esc(m.label)}: ${endLabel(s, m.at + 1e-6)}</title></path>`;
    }).join('');
    return `<svg class="a2p-gantt" viewBox="0 0 ${W} ${H + 12}" role="img" aria-labelledby="a2p-gantt-t a2p-gantt-d">
      <title id="a2p-gantt-t">Program timeline: ${mo(M.end)}, ${monthLabel(s, 0)} to ${endLabel(s, M.end)}</title>
      <desc id="a2p-gantt-d">One row per stream of work; regional work coloured by region; ${s.wet ? 'the wet season shaded; ' : ''}diamonds are the milestones listed below the chart.</desc>
      ${grid}${bars}${marks}</svg>`;
  }

  function timelineHtml({ M }) {
    const s = sc;
    const ms = M.ms.slice().sort((a, b) => a.at - b.at);
    return sec('time', '7. Timeline', `
      <p>About <strong>${mo(M.end)}</strong> from approval to close-out. ${s.backboneFirst
        ? `The backbone stream starts on day one beside procurement and the reviews; the pilot proves the equipment and the method on one network${s.pilot ? '' : ' (not in this scenario)'}; then the field crews work region by region, each region starting once its review is done and its repeaters are on ALERT2.`
        : `In this scenario the backbone waits for the equipment and is done region by region by the field crews, and no region starts before the acquisitions are complete — compare it with “The proposal” to see what starting the backbone first is worth.`}
        ${s.wet ? `Field work slows to ${pct(s.wetFactor)} from December to March (shaded): crews are pulled to flood response and roads close.` : ''}</p>
      <figure class="a2p-fig a2p-wide">${ganttSvg(M)}
        <figcaption class="small txt-muted">Thin lines mark each 1 July (the financial year). Hover a bar for its dates.</figcaption></figure>
      <div class="a2p-two">
        <div><h4>Milestones</h4><ul class="a2p-ms-list">${ms.map(m => `<li><strong>${endLabel(s, m.at + 1e-6)}</strong> — ${esc(m.label)}</li>`).join('')}</ul></div>
        <div><h4>Each network's own timeline</h4>
          <div class="table-wrap"><table class="a2p-table">
            <caption class="sr-only">Timeline by region</caption>
            <thead><tr><th scope="col">Region</th><th scope="col">Field stations</th><th scope="col" class="a2p-num">Months</th><th scope="col" class="col-optional">Waits for</th></tr></thead>
            <tbody>${M.regionRows.map(x => `<tr><th scope="row"><span class="a2p-swatch" style="--c:${regionVar(x.name)}" aria-hidden="true"></span>${esc(x.name)}</th>
              <td>${monthLabel(s, x.start)} – ${endLabel(s, x.end)}</td><td class="a2p-num">${nf1(x.end - x.start)}</td>
              <td class="col-optional small">${esc(x.gate)}</td></tr>`).join('')}</tbody></table></div></div>
      </div>`);
  }

  // ── effort ──
  const ROLES = [['field', 'Field technicians', 'a2p-s1'], ['eng', 'RF and telemetry engineers', 'a2p-s3'], ['pm', 'Project management', 'a2p-s4'], ['support', 'Procurement, property and records', 'a2p-s2']];
  function fteSvg(M) {
    const s = sc;
    const N = M.fte.length;
    if (!N) return '';
    const W = 980, H = 220, L = 40, B = 24, T = 10;
    const max = Math.max(1, Math.ceil(M.peak));
    const x = m => L + m / N * (W - L - 10);
    const y = v => T + (1 - v / max) * (H - T - B);
    const stack = [];
    let low = Array(N).fill(0);
    const areas = ROLES.map(([k, , cls]) => {
      const hi = low.map((v, m) => v + M.fte[m][k]);
      let d = '';
      for (let m = 0; m < N; m++) d += `${m ? 'L' : 'M'}${x(m).toFixed(1)} ${y(hi[m]).toFixed(1)} L${x(m + 1).toFixed(1)} ${y(hi[m]).toFixed(1)} `;
      for (let m = N - 1; m >= 0; m--) d += `L${x(m + 1).toFixed(1)} ${y(low[m]).toFixed(1)} L${x(m).toFixed(1)} ${y(low[m]).toFixed(1)} `;
      low = hi;
      stack.push(k);
      return `<path class="${cls}" d="${d}Z"/>`;
    }).join('');
    let axis = '';
    for (let v = 0; v <= max; v += Math.max(1, Math.round(max / 5))) {
      axis += `<line class="a2p-grid" x1="${L}" y1="${y(v).toFixed(1)}" x2="${W - 10}" y2="${y(v).toFixed(1)}"/><text class="a2p-axis" x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`;
    }
    for (let m = 0; m < N; m++) if (calOf(s, m).m === 0) axis += `<text class="a2p-axis" x="${x(m).toFixed(1)}" y="${H - 6}">${calOf(s, m).y}</text>`;
    return `<svg class="a2p-fte" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="a2p-fte-t">
      <title id="a2p-fte-t">Effort over time: ${nf1(M.fteTotal)} FTE-years in all, peaking at ${nf1(M.peak)} FTE</title>${axis}${areas}</svg>`;
  }
  function effortHtml({ M }) {
    const s = sc;
    const peakOf = k => M.fte.reduce((a, f) => Math.max(a, f[k]), 0);
    return sec('fte', '8. Effort', `
      <p><strong>${nf1(M.fteTotal)} FTE-years</strong> over the program, peaking at <strong>${nf1(M.peak)} FTE</strong>. Field crews are
        ${s.fieldCrews} of ${s.staffPerCrew} for the stations and ${s.backboneCrews} of ${s.staffPerCrew} for the backbone; each works
        ${s.crewDays} field days a month, the rest going to leave, training, bench preparation and travel days. A rainfall station takes
        ${nf1(s.rainDays)} crew-days and a river station ${nf1(s.levelDays)}, travel included, ${nf1(s.remoteMult)}× that in the remote regions.
        Every unit is configured and bench-tested (${nf1(s.benchHours)} hours each) before it goes out.</p>
      <figure class="a2p-fig a2p-wide">${fteSvg(M)}
        <figcaption><ul class="a2p-legend">${ROLES.map(([, l, cls]) => `<li><span class="a2p-swatch ${cls}" aria-hidden="true"></span>${l}</li>`).join('')}</ul></figcaption></figure>
      <div class="table-wrap"><table class="a2p-table">
        <caption class="sr-only">Effort by role</caption>
        <thead><tr><th scope="col">Role</th><th scope="col" class="a2p-num">FTE-years</th><th scope="col" class="a2p-num">Peak FTE</th><th scope="col" class="a2p-num">Cost</th></tr></thead>
        <tbody>${ROLES.map(([k, l]) => `<tr><th scope="row">${l}</th><td class="a2p-num">${nf1(M.fteYears[k])}</td><td class="a2p-num">${nf1(peakOf(k))}</td>
          <td class="a2p-num">${money(M.fteYears[k] * ({ field: s.rateField, eng: s.rateEng, pm: s.ratePm, support: s.rateSupport }[k]), true)}</td></tr>`).join('')}
          <tr class="a2p-total"><th scope="row">All</th><td class="a2p-num">${nf1(M.fteTotal)}</td><td class="a2p-num">${nf1(M.peak)}</td><td class="a2p-num">${money(M.breakdown[1].v, true)}</td></tr>
        </tbody></table></div>
      <p class="small txt-muted">FTE-years at ${WORK_DAYS_YEAR} working days. Whether these are existing staff, new positions or contractors is a decision for management (section 11).</p>`);
  }

  // ── cost ──
  const CAT_CLS = { equip: 'a2p-s1', labour: 'a2p-s3', travel: 'a2p-s2', backbone: 'a2p-s5', network: 'a2p-s4', contingency: 'a2p-s6' };
  function fySvg(M) {
    const rows = M.fy;
    if (!rows.length) return '';
    const W = 980, H = 240, L = 60, B = 26, T = 12;
    const max = Math.max(...rows.map(r => r.total), 1);
    const step = (W - L - 10) / rows.length;
    const bw = Math.min(70, step * 0.6);
    const y = v => T + (1 - v / max) * (H - T - B);
    const cats = ['equip', 'labour', 'travel', 'backbone', 'network', 'contingency'];
    const bars = rows.map((r, i) => {
      let base = 0;
      const cx = L + step * i + step / 2;
      const parts = cats.map(k => {
        const v = r[k];
        if (!v) return '';
        const y1 = y(base + v), y0 = y(base);
        base += v;
        return `<rect class="${CAT_CLS[k]}" x="${(cx - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, y0 - y1).toFixed(1)}"/>`;
      }).join('');
      return `${parts}<text class="a2p-axis" x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${r.fy}</text>
        <text class="a2p-axis" x="${cx.toFixed(1)}" y="${(y(r.total) - 4).toFixed(1)}" text-anchor="middle">${money(r.total)}</text>`;
    }).join('');
    const big = rows.slice().sort((a, b) => b.total - a.total)[0];
    return `<svg class="a2p-fy" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="a2p-fy-t">
      <title id="a2p-fy-t">Spend by financial year — the largest is ${big.fy} at ${money(big.total)}</title>${bars}</svg>`;
  }
  function costHtml({ M }) {
    const s = sc;
    const W = 980;
    let at = 0;
    const strip = M.breakdown.map(b => {
      const w = b.v / Math.max(1, M.total) * W;
      const r = w > 0 ? `<rect class="${CAT_CLS[b.k]}" x="${at.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="26"><title>${esc(b.label)}: ${money(b.v)}</title></rect>` : '';
      at += w;
      return r;
    }).join('');
    const cats = ['equip', 'labour', 'travel', 'backbone', 'network', 'contingency'];
    return sec('cost', '9. Cost', `
      <p>About <strong>${money(M.total)}</strong> in all: ${money(M.base)} of estimated cost and ${money(M.contingency)} contingency
        (${pct(s.contingency)}). Equipment is bought on delivery for the repeaters and bases and as each region starts for the field
        stations, so the spend follows the work across the financial years.</p>
      <figure class="a2p-fig a2p-wide">
        <svg class="a2p-strip" viewBox="0 0 ${W} 26" preserveAspectRatio="none" role="img" aria-labelledby="a2p-strip-t">
          <title id="a2p-strip-t">Cost by category: ${M.breakdown.map(b => `${b.label} ${money(b.v)}`).join(', ')}</title>${strip}</svg>
        <figcaption><ul class="a2p-legend">${M.breakdown.map(b => `<li><span class="a2p-swatch ${CAT_CLS[b.k]}" aria-hidden="true"></span>${esc(b.label)}: <strong>${money(b.v)}</strong> (${pct(b.v / Math.max(1, M.total) * 100)})</li>`).join('')}</ul></figcaption>
      </figure>
      <figure class="a2p-fig a2p-wide">${fySvg(M)}<figcaption class="small txt-muted">Spend by Australian financial year (July to June), coloured as above.</figcaption></figure>
      <div class="table-wrap"><table class="a2p-table">
        <caption class="sr-only">Cost by financial year and category</caption>
        <thead><tr><th scope="col">Financial year</th>${['Equipment', 'Staff', 'Travel', 'Backbone', 'Network', 'Contingency'].map(h => `<th scope="col" class="a2p-num">${h}</th>`).join('')}<th scope="col" class="a2p-num">Total</th></tr></thead>
        <tbody>${M.fy.map(r => `<tr><th scope="row">${r.fy}</th>${cats.map(k => `<td class="a2p-num">${money(r[k])}</td>`).join('')}<td class="a2p-num"><strong>${money(r.total)}</strong></td></tr>`).join('')}
          <tr class="a2p-total"><th scope="row">All</th>${M.breakdown.map(b => `<td class="a2p-num">${money(b.v)}</td>`).join('')}<td class="a2p-num"><strong>${money(M.total)}</strong></td></tr>
        </tbody></table></div>`);
  }

  function risksHtml({ I, M }) {
    const s = sc;
    const unknown = M.own.unknown;
    return sec('risk', '10. Assumptions, risks and open questions', `
      <h4>Risks</h4>
      <ul class="a2p-points">
        <li><strong>One supplier.</strong> The ERT-A2 and 115E-2 come from one Brisbane manufacturer, and the 2015 review noted a single
          Bureau-approved ALERT supplier then too. Lead times, firmware maturity and support for ${nf(M.units.ertA2)} units need confirming
          before the field work is scheduled — the ${s.procureMonths}-month procurement window and the pilot are where that shows. A second
          source exists: Campbell Scientific Australia makes an ALERT2 canister wired to the same pinouts.<sup><a href="#a2p-ref-csa">[10]</a></sup></li>
        <li><strong>Repeater power.</strong> An ERT-A2 repeating draws about 50 mA idle against a field station's 200 µA, so the
          remediation must size each repeater's solar and battery for it.<sup><a href="#a2p-ref-ert">[5]</a></sup></li>
        <li><strong>Acquisitions that do not settle.</strong> ${unknown ? `${unknown} backbone site${unknown === 1 ? ' has' : 's have'} no owner on record, and ` : ''}a council
          may not agree to transfer a site. The fallback for each is a lease, co-location, or a new site found by the review.</li>
        <li><strong>The wet season and floods.</strong> The same people who convert the network respond to floods; a big season stops the field work.
          ${s.wet ? 'The plan slows the field to ' + pct(s.wetFactor) + ' from December to March; a bad year could stop it.' : 'This scenario assumes it does not, which is optimistic.'}</li>
        <li><strong>The register.</strong> The quantities are only as good as the register: repeater and base positions are known to be off
          in places, ownership is unrecorded for many sites, and the register does not yet say which stations already run ALERT2.</li>
        <li><strong>Two systems at once.</strong> Legacy ALERT and ALERT2 run side by side for the life of the program: two receive chains at each base,
          two decoders, two sets of addresses in the data — and the forecasters must see one network.</li>
        <li><strong>Licensing.</strong> ALERT2's slots and any new repeaters need ACMA licences confirmed or applied for before transmitting.</li>
        <li><strong>People.</strong> ${nf1(M.peak)} FTE at the peak is more than the network's maintenance teams can spare and still maintain the network.</li>
      </ul>
      <h4>Assumptions</h4>
      <div class="table-wrap"><table class="a2p-table">
        <caption class="sr-only">The scenario's assumptions</caption>
        <thead><tr><th scope="col">Assumption</th><th scope="col">Value</th></tr></thead>
        <tbody>${CONTROLS.flatMap(g => g.items).map(c => `<tr><th scope="row">${esc(c.label)}</th><td>${esc(c.kind === 'switch' ? (sc[c.k] ? 'yes' : 'no')
          : c.kind === 'select' ? (c.options.find(o => o[0] === sc[c.k]) || ['', sc[c.k]])[1] : c.kind === 'month' ? monthLabel(sc, 0) : ctlValue(c, sc[c.k]))}</td></tr>`).join('')}
          ${RATES.map(r => `<tr><th scope="row">${esc(r.label)}</th><td>${money(sc[r.k], true)}</td></tr>`).join('')}
          <tr><th scope="row">Procurement and supply</th><td>${s.procureMonths} months</td></tr>
          <tr><th scope="row">Pilot</th><td>${s.pilot ? `${s.pilotMonths} months, ${s.pilotSites} stations` : 'none'}</td></tr>
          <tr><th scope="row">Remediation, per backbone site</th><td>${s.remediateDays} crew-days</td></tr>
          <tr><th scope="row">Fitting an ERT-A2 at a repeater</th><td>${s.fitDays} crew-days</td></tr>
          <tr><th scope="row">Equipping a base, per receive chain</th><td>${s.baseDays} engineer-days</td></tr>
          <tr><th scope="row">Close-out</th><td>${s.closeMonths} months</td></tr>
        </tbody></table></div>
      <h4>Open questions</h4>
      <ul class="a2p-points">
        <li>Which base stations receive which networks today, and which will receive ALERT2 — the register counts ${I.radioNetworks} radio networks and marks ${I.registerBases} bases.</li>
        <li>Who owns each backbone site with no owner on record, and on what terms the Bureau could take it.</li>
        <li>Whether the stations the Bureau does not own convert at the owner's cost, the Bureau's, or shared.</li>
        <li>Supplier pricing at volume, lead time, and the support and warranty terms.</li>
        <li>Whether the conversion is done by Bureau crews, contractors, or both.</li>
      </ul>`);
  }

  function decisionsHtml({ M }) {
    const s = sc;
    return sec('dec', '11. Decisions sought', `
      <ol class="a2p-points">
        <li><strong>Start the backbone now</strong> — approve the acquisition of about ${nf(M.nAcq)} backbone site${M.nAcq === 1 ? '' : 's'} and the remediation of about ${nf(M.nRemed)},
          ahead of and independent of the rest of the program.</li>
        <li><strong>Approve the network reviews</strong>, region by region, as the first step of each region's conversion.</li>
        <li><strong>Endorse the approach</strong>: ${s.pilot ? 'a pilot network, then ' : ''}regions converted in the order in section 3, legacy ALERT kept running until each region is done.</li>
        <li><strong>Agree the funding envelope</strong> of about ${money(M.total)} over ${mo(M.end)}, phased by financial year as in section 9.</li>
        <li><strong>Agree how the people are found</strong> — ${nf1(M.peak)} FTE at the peak — and the procurement route for the ERT-A2 and 115E-2.</li>
      </ol>`);
  }

  // The open-web sources the prose cites, numbered as it cites them. Read in
  // October 2026; each is a public page or document.
  const REFS = [
    ['or', 'Logan, Gayl and Thompson (Bureau of Meteorology), ALERT2 transmission protocol overview, HWRS 2015', 'https://onerain.com/wp-content/uploads/2020/10/alert2-transmission-protocol-overview-logan-gayl-thompson-v2.0.pdf'],
    ['hc', 'Campbell Scientific, Harris County Flood Control District: the transition to ALERT2', 'https://s.campbellsci.com/documents/us/case-studies/texas-transition-alert2.pdf'],
    ['nhwc', 'National Hydrologic Warning Council, ALERT2 release and recommended upgrade path (2010)', 'https://www.hydrologicwarning.org/content.aspx?page_id=22&club_id=617218&module_id=83215'],
    ['wp', 'ELPRO Technologies, Is our current flood warning system still effective? (2021)', 'https://elprotech.com/wp-content/uploads/2021/03/Is-our-current-Flood-Warning-System-Still-Effective.pdf'],
    ['ert', 'ELPRO Technologies, ERT-A2 datasheet (2020), and the 115E-2 flood warning gateway', 'https://elprotech.com/wp-content/uploads/2020/08/DS_EL-ERT-A2_August_2020_V2.pdf'],
    ['std', 'Bureau of Meteorology, Flood Warning Infrastructure Standard (2019)', 'https://www.bom.gov.au/sites/default/files/2023-01/flood-warning-infrastructure-standard.pdf'],
    ['fwin', 'Bureau of Meteorology, Flood warning network upgrades (progress as at October 2026)', 'https://www.bom.gov.au/resources/observation-network/flood-warning-network-upgrades'],
    ['rft', 'Bureau of Meteorology, RFT 4468-2024-25: rainfall monitoring station modifications and field upgrade services', 'https://www.australiantenders.com.au/tenders/573204/rainfall-monitoring-station-modifications-and-field-upgrade-services'],
    ['kbr', 'KBR for the Queensland Government, Performance Review of the Flood Warning Gauge Network in Queensland (2015)', 'https://www.disaster.qld.gov.au/__data/assets/pdf_file/0029/338195/Performance-Review-of-the-Flood-Warning-Gauge-Network-in-Queensland.pdf'],
    ['csa', 'Campbell Scientific Australia, flood warning statement (2018): the ALERT2 drop-in canister', 'https://s.campbellsci.com/documents/au/press-releases/Flood%20Warning%20Statement_26-6-18.pdf'],
    ['riv', 'Riverside County Flood Control District, ALERT2 upgrade phases (2022): about US$4,000 a site in hardware', 'https://media.rivcocob.org/proceeds/2022/p2022_05_17_files/11.01001.pdf'],
    ['aps', 'APS pay scales from March 2026 (APS5, APS6, EL1), and the PSSap employer contribution of 15.4%', 'https://www.finance.gov.au/government/superannuation/arrangements-australian-government-employees-statutory-office-holders/public-sector-superannuation-accumulation-plan-pssap'],
  ];

  function sourcesHtml() {
    return sec('src', 'Sources', `
      <ol class="a2p-refs small">${REFS.map(([id, what, url]) => `<li id="a2p-ref-${id}">${esc(what)} —
        <a href="${escAttr(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))}</a></li>`).join('')}</ol>
      <h4>How the figures are worked out</h4>
      <ul class="a2p-points small">
        <li><strong>Quantities</strong> are counted from Flood-Net's station register as loaded — roles, ALERT addresses, catchments
          and pass ranges — and owners and priorities from the Bureau's Service Level Specifications for Queensland and NSW.</li>
        <li><strong>The backbone</strong> is the Stations map's own rule: repeaters sharing an open pass-range window with another
          repeater, or with a base, within the hop distance on the card.</li>
        <li><strong>Unit prices</strong> are planning figures, not quotes: ELPRO lists the ERT-A2 and 115E-2 as "enquire"; the
          ERT-A2 figure is set beside published US ALERT2 upgrades of about US$4,000 a site in hardware (about A$5,800 at
          0.69)<sup><a href="#a2p-ref-riv">[11]</a></sup> and the 2015 review's ALERT1 canister replacement of up to $5,000.<sup><a href="#a2p-ref-kbr">[9]</a></sup></li>
        <li><strong>Staff rates</strong> are fully loaded: an APS5–6 technician at about $100,000 base, an EL1 engineer at about
          $135,000, with super at 15.4% and leave, overheads and accommodation on top.<sup><a href="#a2p-ref-aps">[12]</a></sup></li>
        <li><strong>The design principles</strong> are the Network Review tab's (<code>docs/network-review.md</code>); the ERT-A2's
          and 115E-2's roles at a base are <code>docs/elpro115e_mqtt.md</code>.</li>
      </ul>`);
  }

  // ── painting ──
  function repaint() {
    if (state.activeTab !== 'a2plan') return;
    const el = document.getElementById('main-content');
    if (el) el.innerHTML = render();
  }
  // Only what the scenario moves is rewritten: the five figures and the
  // document. The card stays as it is, so the slider being dragged keeps
  // its focus and its place.
  function repaintLive(focusKey) {
    if (state.activeTab !== 'a2plan') return;
    const k = document.getElementById('a2p-kpis'), o = document.getElementById('a2p-out');
    if (!k || !o) { repaint(); return; }
    k.innerHTML = kpisHtml();
    o.innerHTML = outHtml();
    const note = document.querySelector('.a2p-controls > p.small');
    if (note) {
      const fresh = document.createElement('div');
      fresh.innerHTML = controlsHtml();
      const p = fresh.querySelector('.a2p-controls > p.small');
      if (p) note.innerHTML = p.innerHTML;
    }
    if (focusKey) {
      const find = key => document.querySelector(`#a2p-out [data-k="${CSS.escape(key)}"]`);
      const other = focusKey.replace(/^(up|down):/, (m, d) => (d === 'up' ? 'down:' : 'up:'));
      const el = [find(focusKey), find(other)].find(e => e && !e.disabled);
      if (el) el.focus();
    }
  }

  function set(k, v) {
    if (!(k in DEFAULTS)) return;
    const d = DEFAULTS[k];
    if (typeof d === 'boolean') sc[k] = !!v;
    else if (typeof d === 'number') { const n = Number(v); if (!isFinite(n) || n < 0) return; sc[k] = n; }
    else sc[k] = String(v);
    sc = sanitize(sc);
    saveScenario();
    const c = CONTROLS.flatMap(g => g.items).find(x => x.k === k);
    if (c && c.kind === 'range') {
      const out = document.getElementById(`a2p-c-${k}-o`);
      const txt = ctlValue(c, sc[k]);
      if (out) out.textContent = txt;
      const inp = document.getElementById(`a2p-c-${k}`);
      if (inp) inp.setAttribute('aria-valuetext', txt);
    }
    repaintLive();
  }

  function init() {
    if (!isAdmin()) return;
    // The owners and priorities come from the SLS, fetched once on first ask.
    if (!slsReady && !slsWanted && typeof SLS !== 'undefined' && SLS.ensureData) {
      slsWanted = true;
      SLS.ensureData().then(() => { slsReady = true; inv = null; memo = null; repaint(); }, () => { slsWanted = false; });
    } else if (typeof SLS !== 'undefined' && SLS.loaded && SLS.loaded() && !slsReady) {
      slsReady = true; inv = null; memo = null; repaint();
    }
  }

  // ── exports ──
  function csvRows(M) {
    const head = ['Order', 'Region', 'Catchment', 'Rainfall stations', 'River stations', 'Repeaters', 'Backbone repeaters', 'Bases'];
    const rows = [head];
    M.regionRows.forEach((x, i) => {
      for (const c of x.r.cats.values()) rows.push([i + 1, x.name, c.name, c.rain, c.level, c.repeaters, c.backbone, c.bases]);
    });
    return rows;
  }
  function exportCsv() {
    const C = cur();
    if (!C) { announce('Load the station register first.'); return; }
    dlText('alert2-plan-quantities.csv', csvRows(C.M).map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n');
    announce('Saved the quantities by catchment as CSV.');
  }
  function exportXlsx() {
    const C = cur();
    if (!C || typeof XlsxWrite === 'undefined') { announce('The workbook cannot be made yet.'); return; }
    const { M } = C, s = sc;
    const t = (v, st) => ({ v, s: st });
    const sheets = [
      { name: 'Summary', cols: [46, 22], rows: [
        [t('Flood-Net — ALERT2 Transition Plan (draft)', 'title')],
        [t(`Worked from the station register; an estimate for planning, not a quote.`, 'sub')], [],
        [t('Estimated cost, with contingency', 'label'), Math.round(M.total)],
        [t('Contingency', 'label'), `${s.contingency}%`],
        [t('Duration (months)', 'label'), Math.round(M.end * 10) / 10],
        [t('From', 'label'), monthLabel(s, 0)], [t('To', 'label'), endLabel(s, M.end)],
        [t('Effort (FTE-years)', 'label'), Math.round(M.fteTotal * 10) / 10], [t('Peak FTE', 'label'), Math.round(M.peak * 10) / 10],
        [t('Field stations', 'label'), M.nField], [t('Repeaters (after reviews)', 'label'), M.nRep], [t('Base stations', 'label'), M.nBases],
        [t('ERT-A2 units', 'label'), M.units.ertA2], [t('115E-2 gateways', 'label'), M.units.e115],
        [t('Backbone sites to acquire', 'label'), M.nAcq], [t('Backbone sites to remediate', 'label'), M.nRemed],
      ] },
      { name: 'Equipment', cols: [52, 10, 12, 14, 40], freeze: 1, rows: [
        ['Item', 'Quantity', 'Each', 'Total', 'Basis'].map(h => t(h, 'head')),
        ...M.equipment.map(e => [e.item, e.qty, e.unit, e.total, e.note]),
      ] },
      { name: 'Regions', cols: [8, 26, 30, 10, 10, 10, 10, 10], freeze: 1, rows: csvRows(M).map((r, i) => i ? r : r.map(h => t(h, 'head'))) },
      { name: 'Timeline', cols: [44, 14, 14], freeze: 1, rows: [
        ['Work', 'Start', 'Finish'].map(h => t(h, 'head')),
        ...M.acts.slice().sort((a, b) => a.start - b.start).map(a => [a.label, monthLabel(s, a.start), endLabel(s, a.end)]),
      ] },
      { name: 'Cost by year', cols: [14, 14, 14, 14, 14, 14, 14, 14], freeze: 1, rows: [
        ['Financial year', 'Equipment', 'Staff', 'Travel', 'Backbone', 'Network', 'Contingency', 'Total'].map(h => t(h, 'head')),
        ...M.fy.map(r => [r.fy, ...['equip', 'labour', 'travel', 'backbone', 'network', 'contingency', 'total'].map(k => Math.round(r[k]))]),
      ] },
      { name: 'Assumptions', cols: [70, 18], rows: [
        ['Assumption', 'Value'].map(h => t(h, 'head')),
        ...Object.keys(DEFAULTS).map(k => [k, String(s[k])]),
      ] },
    ];
    const data = XlsxWrite.build(sheets, { title: 'ALERT2 Transition Plan' });
    const url = URL.createObjectURL(new Blob([data], { type: XlsxWrite.MIME }));
    const a = document.createElement('a');
    a.href = url;
    a.download = floodnetName('alert2-transition-plan.xlsx');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('Saved the plan as a workbook.');
  }

  return {
    render,
    init,
    authChanged() { inv = null; memo = null; if (isAdmin()) init(); repaint(); },
    set,
    preset(id) {
      const p = PRESETS.find(x => x.id === id);
      if (!p) return;
      sc = sanitize({ ...DEFAULTS, ...p.set, order: sc.order });
      saveScenario();
      repaint();
      announce(`${p.label}: the plan is worked again.`);
    },
    move(i, dir) {
      const C = cur();
      if (!C) return;
      const order = C.M.order.slice();
      const j = i + dir;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      sc.order = order;
      saveScenario();
      const name = order[j];
      repaintLive(`${dir < 0 ? 'up' : 'down'}:${name}`);
      announce(`${name} is now number ${j + 1} in the order.`);
    },
    // The folded tables go on paper too: opened for the print and folded
    // again after, so the screen is left as it was.
    print() {
      if (typeof window === 'undefined' || !window.print) return;
      const shut = [...document.querySelectorAll('#a2p-out details.a2p-more:not([open])')];
      shut.forEach(d => { d.open = true; });
      try { window.print(); } finally { shut.forEach(d => { d.open = false; }); }
    },
    exportCsv,
    exportXlsx,
    // For the tests: the scenario, the inventory and the plan as they stand.
    scenario: () => ({ ...sc }),
    defaults: () => ({ ...DEFAULTS }),
    inventory,
    plan: () => { const C = cur(); return C ? C.M : null; },
    model: (scenario) => { const I = inventory(); return I ? model(I, sanitize(scenario || {})) : null; },
    reset() { sc = sanitize({}); saveScenario(); repaint(); },
  };
})();
if (typeof window !== 'undefined') window.Alert2Plan = Alert2Plan;
